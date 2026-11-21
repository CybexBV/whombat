// voice-gpu-probe: the devices ggml can run on, as one line of JSON (NX-472), for whombat-voice to pick a graphics chip
// for speech to text. It loads ggml's backends the way whisper-cli and parakeet-cli do (the CPU's and Vulkan's, from
// the directory whisper.cpp was built with) and lists each device's backend, name, description, type and memory:
//
//   {"devices":[{"backend":"Vulkan","name":"Vulkan0","description":"AMD Radeon Graphics (RADV GFX1151)",
//                "type":"igpu","memoryTotal":68719476736,"memoryFree":68000000000}, …]}
//
// No model is loaded and nothing is computed: a box without a graphics chip (or without its driver) lists the CPU only.
#include <ggml-backend.h>

#include <cstdio>
#include <string>

static std::string quoted(const char *s) {
  std::string out = "\"";
  for (const unsigned char *p = reinterpret_cast<const unsigned char *>(s ? s : ""); *p; ++p) {
    switch (*p) {
    case '"':
      out += "\\\"";
      break;
    case '\\':
      out += "\\\\";
      break;
    default:
      if (*p < 0x20) {
        char buf[8];
        std::snprintf(buf, sizeof buf, "\\u%04x", *p);
        out += buf;
      } else {
        out += static_cast<char>(*p);
      }
    }
  }
  return out + "\"";
}

static const char *type_name(enum ggml_backend_dev_type t) {
  switch (t) {
  case GGML_BACKEND_DEVICE_TYPE_CPU:
    return "cpu";
  case GGML_BACKEND_DEVICE_TYPE_GPU:
    return "gpu";
  case GGML_BACKEND_DEVICE_TYPE_IGPU:
    return "igpu";
  case GGML_BACKEND_DEVICE_TYPE_ACCEL:
    return "accel";
  default:
    return "other";
  }
}

int main() {
  ggml_backend_load_all();
  std::string out = "{\"devices\":[";
  for (size_t i = 0; i < ggml_backend_dev_count(); i++) {
    ggml_backend_dev_t dev = ggml_backend_dev_get(i);
    size_t free = 0, total = 0;
    ggml_backend_dev_memory(dev, &free, &total);
    if (i > 0)
      out += ",";
    out += "{\"backend\":" + quoted(ggml_backend_reg_name(ggml_backend_dev_backend_reg(dev)));
    out += ",\"name\":" + quoted(ggml_backend_dev_name(dev));
    out += ",\"description\":" + quoted(ggml_backend_dev_description(dev));
    out += std::string(",\"type\":\"") + type_name(ggml_backend_dev_type(dev)) + "\"";
    out += ",\"memoryTotal\":" + std::to_string(total) + ",\"memoryFree\":" + std::to_string(free) + "}";
  }
  out += "]}\n";
  std::fputs(out.c_str(), stdout);
  return 0;
}
