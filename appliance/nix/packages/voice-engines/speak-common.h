// SPDX-License-Identifier: GPL-3.0-only
//
// What kokoro-speak and supertonic-speak share (NX-291, NX-476): the text from stdin, the canonical WAV, and the one
// gain per answer that puts its loudest moment at -3 dBFS (every answer equally loud, with room for small speakers, no
// sentence louder than the next). Licensed like the programs (voice/NOTICES.md).
#pragma once

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <iostream>
#include <string>
#include <vector>

namespace speak {

const std::size_t kMaxText = 64 * 1024;
// -3 dBFS.
const float kPeak = 0.708f;

inline void put16(std::vector<unsigned char> &b, uint16_t v) {
    b.push_back(v & 0xff);
    b.push_back(v >> 8);
}

inline void put32(std::vector<unsigned char> &b, uint32_t v) {
    for (int i = 0; i < 4; i++) {
        b.push_back((v >> (8 * i)) & 0xff);
    }
}

// wav is the canonical 44-byte header and the samples.
inline std::vector<unsigned char> wav(const std::vector<int16_t> &samples, int rate) {
    std::vector<unsigned char> b;
    const uint32_t data = samples.size() * 2;
    b.reserve(44 + data);
    for (char c : std::string("RIFF")) b.push_back(c);
    put32(b, 36 + data);
    for (char c : std::string("WAVEfmt ")) b.push_back(c);
    put32(b, 16);
    put16(b, 1);  // PCM
    put16(b, 1);  // mono
    put32(b, rate);
    put32(b, rate * 2);
    put16(b, 2);
    put16(b, 16);
    for (char c : std::string("data")) b.push_back(c);
    put32(b, data);
    for (int16_t s : samples) put16(b, static_cast<uint16_t>(s));
    return b;
}

// replaceAll replaces every from in s with to.
inline void replaceAll(std::string &s, const std::string &from, const std::string &to) {
    for (std::size_t at = s.find(from); at != std::string::npos; at = s.find(from, at + to.size())) {
        s.replace(at, from.size(), to);
    }
}

// number reads 0…1024.
inline bool number(const std::string &s, int &n) {
    char *end = nullptr;
    long v = std::strtol(s.c_str(), &end, 10);
    if (s.empty() || *end != '\0' || v < 0 || v > 1024) return false;
    n = static_cast<int>(v);
    return true;
}

// readText reads stdin (UTF-8, at most 64 KiB) as one line, curly apostrophes made straight; false (with a line on
// stderr) when it is too long or holds nothing to say.
inline bool readText(const char *prog, std::string &text) {
    char buf[4096];
    std::size_t n;
    while ((n = std::fread(buf, 1, sizeof buf, stdin)) > 0) {
        text.append(buf, n);
        if (text.size() > kMaxText) {
            std::cerr << prog << ": the text is longer than 64 KiB\n";
            return false;
        }
    }
    std::replace(text.begin(), text.end(), '\n', ' ');
    // Kokoro's lexicon spells “I’d” and “it’s” with a straight apostrophe; Whombat writes curly ones.
    replaceAll(text, "’", "'");
    replaceAll(text, "‘", "'");
    if (text.find_first_not_of(" \t\r") == std::string::npos) {
        std::cerr << prog << ": no text\n";
        return false;
    }
    return true;
}

// writeAnswer writes the samples as a 16-bit mono WAV at rate, with one gain to -3 dBFS.
inline bool writeAnswer(const char *prog, const float *in, int32_t n, int rate, const std::string &out) {
    float peak = 0;
    for (int32_t i = 0; i < n; i++) {
        peak = std::max(peak, std::fabs(in[i]));
    }
    const float scale = peak < 1e-8f ? 1.0f : kPeak / peak;
    std::vector<int16_t> samples;
    samples.reserve(n);
    for (int32_t i = 0; i < n; i++) {
        float v = std::clamp(in[i] * scale, -1.0f, 1.0f) * 32767.0f;
        samples.push_back(static_cast<int16_t>(std::lrint(v)));
    }
    std::vector<unsigned char> b = wav(samples, rate);
    std::FILE *f = std::fopen(out.c_str(), "wb");
    if (!f) {
        std::cerr << prog << ": can't write " << out << "\n";
        return false;
    }
    const bool ok = std::fwrite(b.data(), 1, b.size(), f) == b.size();
    if (std::fclose(f) != 0 || !ok) {
        std::cerr << prog << ": can't write " << out << "\n";
        return false;
    }
    return true;
}

}  // namespace speak
