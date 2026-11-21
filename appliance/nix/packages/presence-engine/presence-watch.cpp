// presence-watch: is someone in front of the screen? The camera side of whombat-presence (Whombat DK-28…DK-33;
// docs/decisions/nixos.md NX-280…).
//
//   presence-watch --model YUNET.onnx --device /dev/videoN [--threshold 0.7] [--min-height 24] [--interval-ms 500]
//   presence-watch --model YUNET.onnx --frames DIR|FILE [--repeat] [--threshold 0.7] [--min-height 24] [--interval-ms 500]
//   presence-watch --model YUNET.onnx --self-test
//   presence-watch --probe [--sys /sys/class/video4linux] [--dev /dev]
//
// Watching reads the camera (V4L2, mmap) at the smallest size at least 320 wide it offers in YUYV, MJPEG or GREY,
// checks about two frames a second (the ones between are handed back unread) and prints one JSON line per check:
//
//   {"t":"2026-10-20T14:46:05.123Z","face":true,"score":0.91,"luma":87}
//
// `score` is the best face's score (OpenCV FaceDetectorYN's sqrt(cls × obj)) among faces at least --min-height pixels
// tall in the 320-wide frame (smaller ones are people across the room), `face` whether it reaches the threshold, `luma`
// the frame's mean brightness (0–255). Before the first check it prints the camera it opened
// ({"t":…,"camera":"/dev/video0","format":"YUYV","width":320,"height":240}). It exits 0 when stdin closes or on
// SIGTERM (closing the camera, so its light goes out), 1 on an error (one line on stderr), 2 for a wrong command line
// and 3 when the camera stops giving pictures. Frames live in memory only: nothing but those numbers leaves the program,
// nothing is written anywhere.
//
// The detector is YuNet (opencv_zoo face_detection_yunet_2023mar, MIT) through ONNX Runtime: each frame is scaled to
// 320 wide and placed at the top left of the model's 640×640 input, the rest black, as FaceDetectorYN pads.
//
// --frames reads PGM/PPM (8-bit, binary) or JPEG pictures instead of a camera (a directory: its .pgm, .ppm, .pnm, .jpg
// and .jpeg files in name order), one line each with its "file" and the check's "ms"; with --repeat it goes round them
// at the interval until stdin closes, as a camera would. --self-test loads the model and checks a black frame.
// --probe prints a line per capture device: its path, name, driver, formats, a colour/infrared and rear guess, and the
// format and size watching would use.
#include <onnxruntime_cxx_api.h>
#include <turbojpeg.h>

#include <dirent.h>
#include <fcntl.h>
#include <linux/videodev2.h>
#include <poll.h>
#include <signal.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

#include <algorithm>
#include <cctype>
#include <cerrno>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <exception>
#include <fstream>
#include <iterator>
#include <memory>
#include <string>
#include <vector>

namespace {

// Frames are checked at this width: a face 40 px tall is someone at the screen; YuNet finds faces of 10 to 300 px.
const int kCheckWidth = 320;
// A face: a score of at least 0.7 (faces at a desk score 0.86–0.94, a coffee cup 0.55, a cat 0.42) and at least 24 px
// tall at 320 wide, someone within about two metres of a laptop's camera (NX-282).
const float kThreshold = 0.7f;
const int kMinHeight = 24;
// A frame larger than this is refused (a picture in --frames; no camera gives one).
const long kMaxPixels = 8192L * 8192L;
// No picture this long (the first one may take longer while the camera wakes) and the camera has stopped.
const int64_t kFirstFrameMs = 10000;
const int64_t kStallMs = 5000;

volatile sig_atomic_t g_stop = 0;
void on_signal(int) { g_stop = 1; }

int64_t mono_ms() {
    timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return int64_t(ts.tv_sec) * 1000 + ts.tv_nsec / 1000000;
}

std::string now_rfc3339() {
    timespec ts;
    clock_gettime(CLOCK_REALTIME, &ts);
    tm t;
    gmtime_r(&ts.tv_sec, &t);
    char buf[40];
    std::snprintf(buf, sizeof buf, "%04d-%02d-%02dT%02d:%02d:%02d.%03ldZ", t.tm_year + 1900, t.tm_mon + 1, t.tm_mday,
                  t.tm_hour, t.tm_min, t.tm_sec, ts.tv_nsec / 1000000);
    return buf;
}

std::string json_str(const std::string &s) {
    std::string out = "\"";
    for (unsigned char c : s) {
        if (c == '"' || c == '\\') {
            out += '\\';
            out += char(c);
        } else if (c < 0x20 || c == 0x7f) {
            char buf[8];
            std::snprintf(buf, sizeof buf, "\\u%04x", c);
            out += buf;
        } else {
            out += char(c);
        }
    }
    return out + "\"";
}

// line prints one JSON line and flushes it; false when stdout is gone (the service went away).
bool line(const std::string &s) {
    return std::fputs((s + "\n").c_str(), stdout) >= 0 && std::fflush(stdout) == 0;
}

std::string fourcc(uint32_t f) {
    std::string s;
    for (int i = 0; i < 4; i++) {
        char c = char((f >> (8 * i)) & 0xff);
        if (c != ' ') s += (c >= 0x20 && c < 0x7f) ? c : '?';
    }
    return s;
}

// ---- Pictures -------------------------------------------------------------------------------------------------

// Image is 8-bit RGB, rows packed.
struct Image {
    int w = 0, h = 0;
    std::vector<uint8_t> rgb;
};

// resize averages the source pixels each output pixel covers (a box filter; nearest when it grows).
Image resize(const Image &in, int w, int h) {
    if (in.w == w && in.h == h) return in;
    Image out{w, h, std::vector<uint8_t>(size_t(w) * h * 3)};
    for (int y = 0; y < h; y++) {
        int y0 = int(int64_t(y) * in.h / h);
        int y1 = std::max(y0 + 1, int(int64_t(y + 1) * in.h / h));
        for (int x = 0; x < w; x++) {
            int x0 = int(int64_t(x) * in.w / w);
            int x1 = std::max(x0 + 1, int(int64_t(x + 1) * in.w / w));
            uint32_t s[3] = {0, 0, 0};
            for (int yy = y0; yy < y1; yy++) {
                const uint8_t *p = &in.rgb[(size_t(yy) * in.w + x0) * 3];
                for (int xx = x0; xx < x1; xx++, p += 3) {
                    s[0] += p[0];
                    s[1] += p[1];
                    s[2] += p[2];
                }
            }
            uint32_t n = uint32_t(y1 - y0) * uint32_t(x1 - x0);
            uint8_t *o = &out.rgb[(size_t(y) * w + x) * 3];
            for (int c = 0; c < 3; c++) o[c] = uint8_t((s[c] + n / 2) / n);
        }
    }
    return out;
}

// fit scales a frame to the check's width (320), smaller when it would be taller than maxH.
Image fit(const Image &in, int maxW, int maxH) {
    int w = std::min(kCheckWidth, maxW);
    int h = std::max(1, int(std::lround(double(in.h) * w / in.w)));
    if (h > maxH) {
        h = maxH;
        w = std::max(1, int(std::lround(double(in.w) * h / in.h)));
    }
    return resize(in, w, h);
}

// luma is the mean brightness, 0–255 (BT.601 weights).
int luma(const Image &im) {
    uint64_t s = 0;
    for (size_t i = 0; i + 2 < im.rgb.size(); i += 3) s += (77u * im.rgb[i] + 150u * im.rgb[i + 1] + 29u * im.rgb[i + 2]) >> 8;
    size_t n = size_t(im.w) * im.h;
    return n ? int(s / n) : 0;
}

uint8_t clamp8(int v) { return uint8_t(v < 0 ? 0 : v > 255 ? 255 : v); }

// yuyv converts packed YUYV 4:2:2 (BT.601, limited range: what UVC cameras send).
Image yuyv(const uint8_t *p, size_t n, int w, int h, int stride) {
    if (stride < w * 2 || n < size_t(stride) * (h - 1) + size_t(w) * 2) return Image{};
    Image out{w, h, std::vector<uint8_t>(size_t(w) * h * 3)};
    for (int y = 0; y < h; y++) {
        const uint8_t *row = p + size_t(y) * stride;
        uint8_t *o = &out.rgb[size_t(y) * w * 3];
        for (int x = 0; x + 1 < w; x += 2) {
            int u = row[x * 2 + 1] - 128, v = row[x * 2 + 3] - 128;
            for (int k = 0; k < 2; k++) {
                int c = 298 * (row[x * 2 + 2 * k] - 16);
                *o++ = clamp8((c + 409 * v + 128) >> 8);
                *o++ = clamp8((c - 100 * u - 208 * v + 128) >> 8);
                *o++ = clamp8((c + 516 * u + 128) >> 8);
            }
        }
    }
    return out;
}

// grey turns an 8-bit grey picture (an infrared camera's) into RGB.
Image grey(const uint8_t *p, size_t n, int w, int h, int stride) {
    if (stride < w || n < size_t(stride) * (h - 1) + size_t(w)) return Image{};
    Image out{w, h, std::vector<uint8_t>(size_t(w) * h * 3)};
    for (int y = 0; y < h; y++) {
        const uint8_t *row = p + size_t(y) * stride;
        uint8_t *o = &out.rgb[size_t(y) * w * 3];
        for (int x = 0; x < w; x++, o += 3) o[0] = o[1] = o[2] = row[x];
    }
    return out;
}

// Jpeg decodes MJPEG frames and JPEG pictures with libjpeg-turbo, at the smallest of its scales that stays at least
// minW wide. Camera frames without Huffman tables get the standard ones (libjpeg-turbo does that by itself); warnings
// (a frame cut short) still give a picture.
class Jpeg {
  public:
    Jpeg() : h_(tj3Init(TJINIT_DECOMPRESS)) {}
    ~Jpeg() {
        if (h_) tj3Destroy(h_);
    }
    Jpeg(const Jpeg &) = delete;
    Jpeg &operator=(const Jpeg &) = delete;

    bool decode(const uint8_t *p, size_t n, int minW, Image &out, std::string &err) {
        if (!h_) {
            err = "can't start the JPEG decoder";
            return false;
        }
        if (tj3DecompressHeader(h_, p, n) != 0) {
            err = std::string("not a JPEG picture: ") + tj3GetErrorStr(h_);
            return false;
        }
        int w = tj3Get(h_, TJPARAM_JPEGWIDTH), h = tj3Get(h_, TJPARAM_JPEGHEIGHT);
        if (w <= 0 || h <= 0 || long(w) * h > kMaxPixels) {
            err = "the JPEG picture's size is out of range";
            return false;
        }
        int count = 0;
        tjscalingfactor *sf = tj3GetScalingFactors(&count);
        tjscalingfactor best = {1, 1};
        for (int i = 0; sf && i < count; i++) {
            if (sf[i].num > sf[i].denom) continue;
            int sw = TJSCALED(w, sf[i]);
            if (sw >= minW && sw < TJSCALED(w, best)) best = sf[i];
        }
        if (tj3SetScalingFactor(h_, best) != 0) {
            err = tj3GetErrorStr(h_);
            return false;
        }
        out.w = TJSCALED(w, best);
        out.h = TJSCALED(h, best);
        out.rgb.assign(size_t(out.w) * out.h * 3, 0);
        if (tj3Decompress8(h_, p, n, out.rgb.data(), 0, TJPF_RGB) != 0 && tj3GetErrorCode(h_) != TJERR_WARNING) {
            err = std::string("can't decode the JPEG picture: ") + tj3GetErrorStr(h_);
            return false;
        }
        return true;
    }

  private:
    tjhandle h_;
};

bool read_file(const std::string &path, std::vector<uint8_t> &b, std::string &err) {
    std::ifstream f(path, std::ios::binary);
    if (!f) {
        err = "can't open " + path;
        return false;
    }
    b.assign(std::istreambuf_iterator<char>(f), std::istreambuf_iterator<char>());
    if (b.size() > size_t(64) << 20) {
        err = path + " is larger than 64 MiB";
        return false;
    }
    return true;
}

// pnm reads a binary PGM (P5) or PPM (P6) with 8-bit samples.
bool pnm(const std::vector<uint8_t> &b, Image &out, std::string &err) {
    size_t i = 2;
    auto skip = [&]() {
        while (i < b.size()) {
            if (b[i] == '#') {
                while (i < b.size() && b[i] != '\n') i++;
            } else if (std::isspace(b[i])) {
                i++;
            } else {
                break;
            }
        }
    };
    auto num = [&](long &v) {
        skip();
        v = 0;
        size_t start = i;
        while (i < b.size() && b[i] >= '0' && b[i] <= '9' && i - start < 9) v = v * 10 + (b[i++] - '0');
        return i > start;
    };
    long w, h, maxval;
    if (!num(w) || !num(h) || !num(maxval) || i >= b.size() || !std::isspace(b[i])) {
        err = "not a binary PGM or PPM";
        return false;
    }
    i++;
    bool colour = b[1] == '6';
    if (w <= 0 || h <= 0 || w * h > kMaxPixels || maxval <= 0 || maxval > 255) {
        err = "a PGM or PPM out of range (8-bit samples only)";
        return false;
    }
    size_t need = size_t(w) * h * (colour ? 3 : 1);
    if (b.size() - i < need) {
        err = "a PGM or PPM cut short";
        return false;
    }
    const uint8_t *p = b.data() + i;
    out = colour ? Image{int(w), int(h), std::vector<uint8_t>(p, p + need)} : grey(p, need, int(w), int(h), int(w));
    if (maxval != 255) {
        for (auto &v : out.rgb) v = uint8_t(std::min<long>(255, (v * 255 + maxval / 2) / maxval));
    }
    return true;
}

bool load_picture(const std::string &path, Jpeg &jpeg, Image &out, std::string &err) {
    std::vector<uint8_t> b;
    if (!read_file(path, b, err)) return false;
    if (b.size() >= 2 && b[0] == 'P' && (b[1] == '5' || b[1] == '6')) return pnm(b, out, err);
    if (b.size() >= 3 && b[0] == 0xff && b[1] == 0xd8 && b[2] == 0xff) return jpeg.decode(b.data(), b.size(), kCheckWidth, out, err);
    err = path + " is not a PGM, PPM or JPEG picture";
    return false;
}

// ---- The detector -------------------------------------------------------------------------------------------------

// Detector is YuNet through ONNX Runtime on one thread: about 3.5 ms a frame on a recent desktop's core (NX-282).
class Detector {
  public:
    struct Result {
        float score = 0;   // the best face's score
        float height = 0;  // its height in the checked frame's pixels
    };

    bool load(const std::string &path, std::string &err) {
        try {
            std::vector<uint8_t> model;
            if (!read_file(path, model, err)) return false;
            Ort::SessionOptions so;
            so.SetIntraOpNumThreads(1);
            so.SetInterOpNumThreads(1);
            so.SetExecutionMode(ORT_SEQUENTIAL);
            so.SetGraphOptimizationLevel(GraphOptimizationLevel::ORT_ENABLE_ALL);
            session_ = std::make_unique<Ort::Session>(env_, model.data(), model.size(), so);
            if (session_->GetInputCount() != 1) {
                err = "the model has more than one input";
                return false;
            }
            Ort::AllocatorWithDefaultOptions alloc;
            input_ = session_->GetInputNameAllocated(0, alloc).get();
            auto shape = session_->GetInputTypeInfo(0).GetTensorTypeAndShapeInfo().GetShape();
            if (shape.size() != 4 || shape[1] != 3) {
                err = "the model's input is not 1×3×H×W";
                return false;
            }
            // A fixed input (YuNet 2023mar's is 640×640) is filled from the top left; a free one is the frame's size.
            fixedH_ = shape[2] > 0 ? int(shape[2]) : 0;
            fixedW_ = shape[3] > 0 ? int(shape[3]) : 0;
            std::vector<std::string> have;
            for (size_t i = 0; i < session_->GetOutputCount(); i++) have.push_back(session_->GetOutputNameAllocated(i, alloc).get());
            for (const char *kind : {"cls", "obj", "bbox"}) {
                for (int s : kStrides) {
                    std::string name = std::string(kind) + "_" + std::to_string(s);
                    if (std::find(have.begin(), have.end(), name) == have.end()) {
                        err = "the model has no output " + name + " (not YuNet 2023mar?)";
                        return false;
                    }
                    outputs_.push_back(name);
                }
            }
            return true;
        } catch (const std::exception &e) {
            err = std::string("can't load the model: ") + e.what();
            return false;
        }
    }

    int maxW() const { return fixedW_ ? fixedW_ : 1 << 13; }
    int maxH() const { return fixedH_ ? fixedH_ : 1 << 13; }

    // run checks a frame already fitted (fit) to the model's input; faces less than minH tall don't count.
    bool run(const Image &f, int minH, Result &r, std::string &err) {
        try {
            const int W = fixedW_ ? fixedW_ : round32(f.w), H = fixedH_ ? fixedH_ : round32(f.h);
            if (f.w > W || f.h > H) {
                err = "the frame is larger than the model's input";
                return false;
            }
            // NCHW, BGR (OpenCV's channel order), 0–255, black beyond the frame.
            buf_.assign(size_t(3) * W * H, 0.0f);
            const size_t plane = size_t(W) * H;
            for (int y = 0; y < f.h; y++) {
                const uint8_t *p = &f.rgb[size_t(y) * f.w * 3];
                for (int x = 0; x < f.w; x++, p += 3) {
                    size_t o = size_t(y) * W + x;
                    buf_[o] = p[2];
                    buf_[plane + o] = p[1];
                    buf_[2 * plane + o] = p[0];
                }
            }
            const int64_t dims[4] = {1, 3, H, W};
            auto mem = Ort::MemoryInfo::CreateCpu(OrtArenaAllocator, OrtMemTypeDefault);
            Ort::Value in = Ort::Value::CreateTensor<float>(mem, buf_.data(), buf_.size(), dims, 4);
            const char *in_names[] = {input_.c_str()};
            std::vector<const char *> out_names;
            for (auto &n : outputs_) out_names.push_back(n.c_str());
            auto out = session_->Run(Ort::RunOptions{nullptr}, in_names, &in, 1, out_names.data(), out_names.size());
            r = Result{};
            for (int i = 0; i < 3; i++) {
                const int s = kStrides[i], cols = W / s, rows = H / s;
                const size_t n = size_t(cols) * rows;
                auto count = [&](int k) { return out[k].GetTensorTypeAndShapeInfo().GetElementCount(); };
                if (count(i) != n || count(3 + i) != n || count(6 + i) != 4 * n) {
                    err = "the model's outputs don't match its input";
                    return false;
                }
                const float *cls = out[i].GetTensorData<float>();
                const float *obj = out[3 + i].GetTensorData<float>();
                const float *box = out[6 + i].GetTensorData<float>();
                for (size_t k = 0; k < n; k++) {
                    float score = std::sqrt(std::clamp(cls[k], 0.0f, 1.0f) * std::clamp(obj[k], 0.0f, 1.0f));
                    if (score <= r.score) continue;
                    // The box (FaceDetectorYN's decoding): its centre must be in the frame, not in the black beyond it.
                    const int c = int(k % cols), row = int(k / cols);
                    const float cx = (c + box[4 * k]) * s, cy = (row + box[4 * k + 1]) * s;
                    const float h = std::exp(box[4 * k + 3]) * s;
                    if (cx < 0 || cy < 0 || cx >= f.w || cy >= f.h || h < minH) continue;
                    r.score = score;
                    r.height = h;
                }
            }
            return true;
        } catch (const std::exception &e) {
            err = std::string("the model failed: ") + e.what();
            return false;
        }
    }

  private:
    static constexpr int kStrides[3] = {8, 16, 32};
    static int round32(int v) { return (v + 31) / 32 * 32; }

    Ort::Env env_{ORT_LOGGING_LEVEL_ERROR, "presence-watch"};
    std::unique_ptr<Ort::Session> session_;
    std::string input_;
    std::vector<std::string> outputs_;
    int fixedW_ = 0, fixedH_ = 0;
    std::vector<float> buf_;
};

struct Check {
    bool face = false;
    float score = 0, height = 0;
    int luma = 0;
};

struct Options {
    float threshold = kThreshold;
    int minHeight = kMinHeight;
    int interval = 500;
};

bool check(Detector &d, const Image &frame, const Options &o, Check &c, std::string &err) {
    Image f = fit(frame, d.maxW(), d.maxH());
    Detector::Result r;
    if (!d.run(f, o.minHeight, r, err)) return false;
    c.score = r.score;
    c.height = r.height;
    c.face = r.score >= o.threshold;
    c.luma = luma(f);
    return true;
}

std::string check_line(const Check &c, const std::string &extra = "") {
    char buf[160];
    std::snprintf(buf, sizeof buf, "{\"t\":\"%s\",\"face\":%s,\"score\":%.2f,\"luma\":%d", now_rfc3339().c_str(),
                  c.face ? "true" : "false", c.score, c.luma);
    return std::string(buf) + extra + "}";
}

// ---- The camera (V4L2) --------------------------------------------------------------------------------------------

int xioctl(int fd, unsigned long req, void *arg) {
    int r;
    do r = ioctl(fd, req, arg);
    while (r < 0 && errno == EINTR);
    return r;
}

bool readable_format(uint32_t f) {
    return f == V4L2_PIX_FMT_YUYV || f == V4L2_PIX_FMT_MJPEG || f == V4L2_PIX_FMT_JPEG || f == V4L2_PIX_FMT_GREY;
}

// Grey formats are what infrared cameras send (Windows Hello's give GREY, sometimes Y10/Y12/Y16 too).
bool grey_format(uint32_t f) {
    return f == V4L2_PIX_FMT_GREY || f == V4L2_PIX_FMT_Y10 || f == V4L2_PIX_FMT_Y12 || f == V4L2_PIX_FMT_Y16 ||
           f == V4L2_PIX_FMT_Y10BPACK || f == V4L2_PIX_FMT_Y8I || f == V4L2_PIX_FMT_Y12I || f == V4L2_PIX_FMT_Z16;
}

// Cheaper to read first when two give the same size: YUYV needs no decoding.
int format_rank(uint32_t f) { return f == V4L2_PIX_FMT_YUYV ? 0 : f == V4L2_PIX_FMT_GREY ? 2 : 1; }

struct Mode {
    uint32_t format = 0;
    int w = 0, h = 0;
};

struct Device {
    std::string path, name, driver, bus;
    std::vector<uint32_t> formats;
    bool usable = false, infrared = false, rear = false;
    Mode mode;
};

std::vector<Mode> sizes(int fd, uint32_t format) {
    std::vector<Mode> out;
    for (uint32_t i = 0; i < 256; i++) {
        v4l2_frmsizeenum fs{};
        fs.index = i;
        fs.pixel_format = format;
        if (xioctl(fd, VIDIOC_ENUM_FRAMESIZES, &fs) < 0) break;
        if (fs.type == V4L2_FRMSIZE_TYPE_DISCRETE) {
            out.push_back({format, int(fs.discrete.width), int(fs.discrete.height)});
            continue;
        }
        // Stepwise or continuous: the width nearest 320 it allows, at 4:3.
        auto &sw = fs.stepwise;
        auto pick = [](uint32_t want, uint32_t lo, uint32_t hi, uint32_t step) {
            uint32_t v = std::clamp(want, lo, hi);
            if (step > 1) v = lo + (v - lo + step - 1) / step * step;
            return int(std::min(v, hi));
        };
        int w = pick(kCheckWidth, sw.min_width, sw.max_width, sw.step_width);
        out.push_back({format, w, pick(uint32_t(w) * 3 / 4, sw.min_height, sw.max_height, sw.step_height)});
        break;
    }
    return out;
}

// choose is the smallest size at least 320 wide in a format this program reads (the cheaper format first); the
// largest when none is that wide.
bool choose(int fd, const std::vector<uint32_t> &formats, Mode &m) {
    bool found = false, wide = false;
    for (uint32_t f : formats) {
        if (!readable_format(f)) continue;
        for (const Mode &c : sizes(fd, f)) {
            if (c.w <= 0 || c.h <= 0) continue;
            bool cwide = c.w >= kCheckWidth;
            long area = long(c.w) * c.h, marea = long(m.w) * m.h;
            bool better = !found || (cwide && !wide) ||
                          (cwide == wide && (cwide ? (area < marea || (area == marea && format_rank(f) < format_rank(m.format)))
                                                   : area > marea));
            if (better) {
                m = c;
                found = true;
                wide = cwide;
            }
        }
    }
    return found;
}

std::vector<std::string> words(const std::string &s) {
    std::vector<std::string> out;
    std::string w;
    for (char c : s + " ") {
        if (std::isalnum(static_cast<unsigned char>(c))) {
            w += char(std::tolower(static_cast<unsigned char>(c)));
        } else if (!w.empty()) {
            out.push_back(w);
            w.clear();
        }
    }
    return out;
}

// describe reads what a device node is: a capture device it can stream from, its formats, a guess at infrared (only
// grey formats, or “IR”/“infrared” in its name) and at a rear camera (“rear”/“back”/“world” in its name, or the
// sensor's orientation control saying so).
bool describe(int fd, const std::string &path, Device &d) {
    v4l2_capability cap{};
    if (xioctl(fd, VIDIOC_QUERYCAP, &cap) < 0) return false;
    uint32_t caps = (cap.capabilities & V4L2_CAP_DEVICE_CAPS) ? cap.device_caps : cap.capabilities;
    if (!(caps & V4L2_CAP_VIDEO_CAPTURE) || !(caps & V4L2_CAP_STREAMING) ||
        (caps & (V4L2_CAP_VIDEO_M2M | V4L2_CAP_VIDEO_M2M_MPLANE | V4L2_CAP_VIDEO_OUTPUT)))
        return false;
    d.path = path;
    d.name = reinterpret_cast<const char *>(cap.card);
    d.driver = reinterpret_cast<const char *>(cap.driver);
    d.bus = reinterpret_cast<const char *>(cap.bus_info);
    for (uint32_t i = 0; i < 64; i++) {
        v4l2_fmtdesc fd_{};
        fd_.index = i;
        fd_.type = V4L2_BUF_TYPE_VIDEO_CAPTURE;
        if (xioctl(fd, VIDIOC_ENUM_FMT, &fd_) < 0) break;
        d.formats.push_back(fd_.pixelformat);
    }
    const bool onlyGrey = !d.formats.empty() && std::all_of(d.formats.begin(), d.formats.end(), grey_format);
    auto w = words(d.name);
    auto has = [&](const char *x) { return std::find(w.begin(), w.end(), x) != w.end(); };
    d.infrared = onlyGrey || has("ir") || has("infrared");
    d.rear = has("rear") || has("back") || has("world");
    v4l2_control ctl{};
    ctl.id = V4L2_CID_CAMERA_ORIENTATION;
    if (xioctl(fd, VIDIOC_G_CTRL, &ctl) == 0 && ctl.value == V4L2_CAMERA_ORIENTATION_BACK) d.rear = true;
    d.usable = choose(fd, d.formats, d.mode);
    return true;
}

std::string device_line(const Device &d) {
    std::string f = "[";
    for (size_t i = 0; i < d.formats.size(); i++) f += (i ? "," : "") + json_str(fourcc(d.formats[i]));
    f += "]";
    std::string s = "{\"path\":" + json_str(d.path) + ",\"name\":" + json_str(d.name) + ",\"driver\":" + json_str(d.driver) +
                    ",\"bus\":" + json_str(d.bus) + ",\"formats\":" + f + ",\"kind\":" +
                    (d.infrared ? "\"infrared\"" : "\"colour\"") + ",\"rear\":" + (d.rear ? "true" : "false") +
                    ",\"usable\":" + (d.usable ? "true" : "false");
    if (d.usable) {
        s += ",\"format\":" + json_str(fourcc(d.mode.format)) + ",\"width\":" + std::to_string(d.mode.w) +
             ",\"height\":" + std::to_string(d.mode.h);
    }
    return s + "}";
}

// Camera streams from one device with four mmap buffers.
class Camera {
  public:
    ~Camera() { close(); }

    bool open(const std::string &path, std::string &err) {
        fd_ = ::open(path.c_str(), O_RDWR | O_NONBLOCK | O_CLOEXEC);
        if (fd_ < 0) {
            err = "can't open " + path + ": " + std::strerror(errno);
            return false;
        }
        Device d;
        if (!describe(fd_, path, d)) {
            err = path + " is not a camera this program can stream from";
            return false;
        }
        if (!d.usable) {
            err = path + " offers no YUYV, MJPEG or GREY pictures";
            return false;
        }
        v4l2_format fmt{};
        fmt.type = V4L2_BUF_TYPE_VIDEO_CAPTURE;
        fmt.fmt.pix.width = uint32_t(d.mode.w);
        fmt.fmt.pix.height = uint32_t(d.mode.h);
        fmt.fmt.pix.pixelformat = d.mode.format;
        fmt.fmt.pix.field = V4L2_FIELD_ANY;
        if (xioctl(fd_, VIDIOC_S_FMT, &fmt) < 0) {
            err = std::string("can't set the picture format: ") + std::strerror(errno);
            return false;
        }
        format_ = fmt.fmt.pix.pixelformat;
        w_ = int(fmt.fmt.pix.width);
        h_ = int(fmt.fmt.pix.height);
        stride_ = int(fmt.fmt.pix.bytesperline);
        if (!readable_format(format_) || w_ <= 0 || h_ <= 0 || long(w_) * h_ > kMaxPixels) {
            err = "the camera gives " + fourcc(format_) + " pictures this program can't read";
            return false;
        }
        if (stride_ <= 0) stride_ = format_ == V4L2_PIX_FMT_YUYV ? w_ * 2 : w_;
        // Five pictures a second is plenty for two checks, and lets the exposure be longer in a dim room; a camera
        // that can't go that slow keeps its nearest rate.
        v4l2_streamparm parm{};
        parm.type = V4L2_BUF_TYPE_VIDEO_CAPTURE;
        parm.parm.capture.timeperframe = {1, 5};
        (void)xioctl(fd_, VIDIOC_S_PARM, &parm);

        v4l2_requestbuffers req{};
        req.count = 4;
        req.type = V4L2_BUF_TYPE_VIDEO_CAPTURE;
        req.memory = V4L2_MEMORY_MMAP;
        if (xioctl(fd_, VIDIOC_REQBUFS, &req) < 0 || req.count < 2) {
            err = std::string("can't get the camera's buffers: ") + std::strerror(errno);
            return false;
        }
        for (uint32_t i = 0; i < req.count; i++) {
            v4l2_buffer b{};
            b.type = V4L2_BUF_TYPE_VIDEO_CAPTURE;
            b.memory = V4L2_MEMORY_MMAP;
            b.index = i;
            if (xioctl(fd_, VIDIOC_QUERYBUF, &b) < 0) {
                err = std::string("can't query a buffer: ") + std::strerror(errno);
                return false;
            }
            void *p = mmap(nullptr, b.length, PROT_READ, MAP_SHARED, fd_, b.m.offset);
            if (p == MAP_FAILED) {
                err = std::string("can't map a buffer: ") + std::strerror(errno);
                return false;
            }
            bufs_.push_back({p, b.length});
            if (xioctl(fd_, VIDIOC_QBUF, &b) < 0) {
                err = std::string("can't queue a buffer: ") + std::strerror(errno);
                return false;
            }
        }
        v4l2_buf_type type = V4L2_BUF_TYPE_VIDEO_CAPTURE;
        if (xioctl(fd_, VIDIOC_STREAMON, &type) < 0) {
            err = std::string("can't start the camera: ") + std::strerror(errno);
            return false;
        }
        streaming_ = true;
        return true;
    }

    int fd() const { return fd_; }
    uint32_t format() const { return format_; }
    int width() const { return w_; }
    int height() const { return h_; }

    // next takes the next filled buffer: 1 a picture (decoded into out when want), 0 none ready, -1 an error.
    int next(bool want, Jpeg &jpeg, Image &out, std::string &err) {
        v4l2_buffer b{};
        b.type = V4L2_BUF_TYPE_VIDEO_CAPTURE;
        b.memory = V4L2_MEMORY_MMAP;
        if (xioctl(fd_, VIDIOC_DQBUF, &b) < 0) {
            if (errno == EAGAIN) return 0;
            err = std::string("the camera stopped: ") + std::strerror(errno);
            return -1;
        }
        int got = 1;
        if (b.index >= bufs_.size() || (b.flags & V4L2_BUF_FLAG_ERROR) || b.bytesused == 0) {
            got = 0;
        } else if (want) {
            const uint8_t *p = static_cast<const uint8_t *>(bufs_[b.index].p);
            const size_t n = std::min<size_t>(b.bytesused, bufs_[b.index].n);
            std::string derr;
            if (format_ == V4L2_PIX_FMT_YUYV) {
                out = yuyv(p, n, w_, h_, stride_);
            } else if (format_ == V4L2_PIX_FMT_GREY) {
                out = grey(p, n, w_, h_, stride_);
            } else if (!jpeg.decode(p, n, kCheckWidth, out, derr)) {
                out = Image{};
            }
            if (out.w == 0) got = 0;  // a broken frame: skipped, the next one is checked
        }
        if (xioctl(fd_, VIDIOC_QBUF, &b) < 0) {
            err = std::string("can't hand a buffer back: ") + std::strerror(errno);
            return -1;
        }
        return got;
    }

    void close() {
        if (fd_ < 0) return;
        if (streaming_) {
            v4l2_buf_type type = V4L2_BUF_TYPE_VIDEO_CAPTURE;
            (void)xioctl(fd_, VIDIOC_STREAMOFF, &type);
        }
        for (auto &b : bufs_) munmap(b.p, b.n);
        bufs_.clear();
        ::close(fd_);
        fd_ = -1;
    }

  private:
    struct Buf {
        void *p;
        size_t n;
    };
    int fd_ = -1;
    bool streaming_ = false;
    uint32_t format_ = 0;
    int w_ = 0, h_ = 0, stride_ = 0;
    std::vector<Buf> bufs_;
};

// ---- Modes ----------------------------------------------------------------------------------------------------------

// stdin_closed reads what stdin has (nothing is expected) and says whether it is closed.
bool stdin_closed() {
    char b[256];
    ssize_t r = read(0, b, sizeof b);
    return r == 0 || (r < 0 && errno != EAGAIN && errno != EINTR);
}

// wait_ms waits up to ms for stdin to close or a signal; false when the program should end.
bool wait_ms(int64_t ms) {
    const int64_t end = mono_ms() + ms;
    sigset_t none;
    sigemptyset(&none);
    while (!g_stop) {
        int64_t left = end - mono_ms();
        if (left <= 0) return true;
        pollfd p{0, POLLIN, 0};
        timespec to{time_t(left / 1000), long(left % 1000) * 1000000};
        int n = ppoll(&p, 1, &to, &none);
        if (n > 0 && stdin_closed()) return false;
    }
    return false;
}

int watch(Detector &det, const std::string &path, const Options &o) {
    Camera cam;
    Jpeg jpeg;
    std::string err;
    if (!cam.open(path, err)) {
        std::fprintf(stderr, "presence-watch: %s\n", err.c_str());
        return 1;
    }
    if (!line("{\"t\":\"" + now_rfc3339() + "\",\"camera\":" + json_str(path) + ",\"format\":" +
              json_str(fourcc(cam.format())) + ",\"width\":" + std::to_string(cam.width()) +
              ",\"height\":" + std::to_string(cam.height()) + "}"))
        return 0;
    sigset_t none;
    sigemptyset(&none);
    const int64_t start = mono_ms();
    int64_t last_frame = 0, last_check = 0;
    while (!g_stop) {
        pollfd fds[2] = {{cam.fd(), POLLIN, 0}, {0, POLLIN, 0}};
        timespec to{0, 250 * 1000000L};
        int n = ppoll(fds, 2, &to, &none);
        if (n < 0 && errno != EINTR) {
            std::fprintf(stderr, "presence-watch: poll: %s\n", std::strerror(errno));
            return 1;
        }
        if (n > 0 && (fds[1].revents & (POLLIN | POLLHUP | POLLERR)) && stdin_closed()) return 0;
        if (n > 0 && (fds[0].revents & POLLERR)) {
            std::fprintf(stderr, "presence-watch: the camera went away\n");
            return 1;
        }
        const int64_t now = mono_ms();
        if (n > 0 && (fds[0].revents & POLLIN)) {
            const bool want = last_check == 0 || now - last_check >= o.interval;
            Image frame;
            int got = cam.next(want, jpeg, frame, err);
            if (got < 0) {
                std::fprintf(stderr, "presence-watch: %s\n", err.c_str());
                return 1;
            }
            if (got > 0) {
                last_frame = now;
                if (want) {
                    Check c;
                    if (!check(det, frame, o, c, err)) {
                        std::fprintf(stderr, "presence-watch: %s\n", err.c_str());
                        return 1;
                    }
                    last_check = now;
                    if (!line(check_line(c))) return 0;
                }
            }
        }
        if (now - (last_frame ? last_frame : start) > (last_frame ? kStallMs : kFirstFrameMs)) {
            std::fprintf(stderr, "presence-watch: the camera gave no picture for %lld s\n",
                         (long long)((last_frame ? kStallMs : kFirstFrameMs) / 1000));
            return 3;
        }
    }
    return 0;
}

bool picture_name(const std::string &n) {
    auto dot = n.rfind('.');
    if (dot == std::string::npos || n[0] == '.') return false;
    std::string ext = n.substr(dot + 1);
    std::transform(ext.begin(), ext.end(), ext.begin(), [](unsigned char c) { return char(std::tolower(c)); });
    return ext == "pgm" || ext == "ppm" || ext == "pnm" || ext == "jpg" || ext == "jpeg";
}

int frames(Detector &det, const std::string &path, bool repeat, const Options &o) {
    std::vector<std::string> files;
    struct stat st{};
    if (stat(path.c_str(), &st) == 0 && S_ISDIR(st.st_mode)) {
        if (DIR *d = opendir(path.c_str())) {
            while (dirent *e = readdir(d)) {
                if (picture_name(e->d_name)) files.push_back(e->d_name);
            }
            closedir(d);
        }
        std::sort(files.begin(), files.end());
        for (auto &f : files) f = path + "/" + f;
    } else {
        files.push_back(path);
    }
    if (files.empty()) {
        std::fprintf(stderr, "presence-watch: no pictures in %s\n", path.c_str());
        return 1;
    }
    Jpeg jpeg;
    do {
        for (const auto &f : files) {
            Image im;
            std::string err;
            if (!load_picture(f, jpeg, im, err)) {
                std::fprintf(stderr, "presence-watch: %s\n", err.c_str());
                return 1;
            }
            Check c;
            const int64_t t0 = mono_ms();
            if (!check(det, im, o, c, err)) {
                std::fprintf(stderr, "presence-watch: %s\n", err.c_str());
                return 1;
            }
            char extra[96];
            std::snprintf(extra, sizeof extra, ",\"height\":%.0f,\"ms\":%lld", c.height, (long long)(mono_ms() - t0));
            std::string name = f.substr(f.rfind('/') == std::string::npos ? 0 : f.rfind('/') + 1);
            if (!line(check_line(c, ",\"file\":" + json_str(name) + extra))) return 0;
            if (repeat && !wait_ms(o.interval)) return 0;
        }
    } while (repeat && !g_stop);
    return 0;
}

int self_test(Detector &det, const Options &o) {
    Image blank{kCheckWidth, 240, std::vector<uint8_t>(size_t(kCheckWidth) * 240 * 3, 0)};
    Check c;
    std::string err;
    const int64_t t0 = mono_ms();
    if (!check(det, blank, o, c, err)) {
        std::fprintf(stderr, "presence-watch: %s\n", err.c_str());
        return 1;
    }
    if (c.face) {
        std::fprintf(stderr, "presence-watch: the model saw a face in a black frame\n");
        return 1;
    }
    line("{\"selfTest\":\"ok\",\"input\":[" + std::to_string(det.maxW()) + "," + std::to_string(det.maxH()) +
         "],\"ms\":" + std::to_string(mono_ms() - t0) + "}");
    return 0;
}

int probe(const std::string &sys, const std::string &dev) {
    std::vector<std::string> names;
    if (DIR *d = opendir(sys.c_str())) {
        while (dirent *e = readdir(d)) {
            if (std::strncmp(e->d_name, "video", 5) == 0) names.push_back(e->d_name);
        }
        closedir(d);
    }
    // video2 before video10.
    std::sort(names.begin(), names.end(), [](const std::string &a, const std::string &b) {
        return a.size() != b.size() ? a.size() < b.size() : a < b;
    });
    for (const auto &n : names) {
        const std::string path = dev + "/" + n;
        int fd = ::open(path.c_str(), O_RDWR | O_NONBLOCK | O_CLOEXEC);
        if (fd < 0) continue;
        Device d;
        bool ok = describe(fd, path, d);
        ::close(fd);
        if (ok && !line(device_line(d))) return 0;
    }
    return 0;
}

int usage() {
    std::fprintf(stderr,
                 "usage: presence-watch --model YUNET.onnx (--device /dev/videoN | --frames DIR|FILE [--repeat] | "
                 "--self-test) [--threshold T] [--min-height PX] [--interval-ms N]\n"
                 "       presence-watch --probe [--sys /sys/class/video4linux] [--dev /dev]\n");
    return 2;
}

}  // namespace

int main(int argc, char **argv) {
    std::string model, device, framesPath, sys = "/sys/class/video4linux", dev = "/dev";
    bool doProbe = false, doSelfTest = false, repeat = false;
    Options o;
    for (int i = 1; i < argc; i++) {
        std::string a = argv[i];
        auto value = [&](std::string &v) {
            if (i + 1 >= argc) return false;
            v = argv[++i];
            return true;
        };
        std::string v;
        if (a == "--probe") {
            doProbe = true;
        } else if (a == "--self-test") {
            doSelfTest = true;
        } else if (a == "--repeat") {
            repeat = true;
        } else if (a == "--model") {
            if (!value(model)) return usage();
        } else if (a == "--device") {
            if (!value(device)) return usage();
        } else if (a == "--frames") {
            if (!value(framesPath)) return usage();
        } else if (a == "--sys") {
            if (!value(sys)) return usage();
        } else if (a == "--dev") {
            if (!value(dev)) return usage();
        } else if (a == "--threshold") {
            if (!value(v)) return usage();
            char *end = nullptr;
            o.threshold = std::strtof(v.c_str(), &end);
            if (*end || !(o.threshold > 0 && o.threshold <= 1)) return usage();
        } else if (a == "--min-height") {
            if (!value(v)) return usage();
            char *end = nullptr;
            o.minHeight = int(std::strtol(v.c_str(), &end, 10));
            if (*end || o.minHeight < 1 || o.minHeight > 640) return usage();
        } else if (a == "--interval-ms") {
            if (!value(v)) return usage();
            char *end = nullptr;
            o.interval = int(std::strtol(v.c_str(), &end, 10));
            if (*end || o.interval < 50 || o.interval > 10000) return usage();
        } else {
            return usage();
        }
    }
    signal(SIGPIPE, SIG_IGN);
    if (doProbe) return (model.empty() && device.empty() && framesPath.empty() && !doSelfTest) ? probe(sys, dev) : usage();
    if (model.empty() || int(!device.empty()) + int(!framesPath.empty()) + int(doSelfTest) != 1) return usage();

    // SIGTERM and SIGINT end the program; they are let in only while it waits (ppoll), so a check runs to its end.
    struct sigaction sa{};
    sa.sa_handler = on_signal;
    sigaction(SIGTERM, &sa, nullptr);
    sigaction(SIGINT, &sa, nullptr);
    sigset_t block;
    sigemptyset(&block);
    sigaddset(&block, SIGTERM);
    sigaddset(&block, SIGINT);
    sigprocmask(SIG_BLOCK, &block, nullptr);
    fcntl(0, F_SETFL, fcntl(0, F_GETFL) | O_NONBLOCK);

    Detector det;
    std::string err;
    if (!det.load(model, err)) {
        std::fprintf(stderr, "presence-watch: %s\n", err.c_str());
        return 1;
    }
    if (doSelfTest) return self_test(det, o);
    if (!framesPath.empty()) return frames(det, framesPath, repeat, o);
    return watch(det, device, o);
}
