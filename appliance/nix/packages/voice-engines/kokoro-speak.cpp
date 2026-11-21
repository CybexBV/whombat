// SPDX-License-Identifier: GPL-3.0-only
//
// kokoro-speak: text to speech with Kokoro through sherpa-onnx's C API, for whombat-voice (NX-291). sherpa-onnx
// (Apache-2.0) carries eSpeak NG (GPL-3.0-or-later) inside its library for the words its lexicon doesn't know, so this
// file, unlike the rest of this repository, is licensed under the GNU General Public License version 3
// (voice/NOTICES.md).
//
//   kokoro-speak --model DIR --speaker ID --output-file OUT.wav [--accent us|gb] [--threads N] [--espeak-data DIR] < text
//
// DIR holds the model as sherpa-onnx packs it: model.onnx, voices.bin, tokens.txt and the accent's lexicon
// (lexicon-us-en.txt, lexicon-gb-en.txt: Kokoro's own pronunciations, eSpeak NG only for words they lack). The text
// comes on stdin (UTF-8, at most 64 KiB), never as an argument; the answer is a 16-bit mono WAV at the model's rate
// (24 kHz), with one gain to -3 dBFS (speak-common.h). Errors: a line on stderr, exit 1 (2 for a wrong command line).
#include "sherpa-onnx/c-api/c-api.h"
#include "speak-common.h"

#include <cstring>
#include <iostream>
#include <string>

#ifndef KOKORO_SPEAK_ESPEAK_DATA
#define KOKORO_SPEAK_ESPEAK_DATA ""
#endif

namespace {

int usage() {
    std::cerr << "usage: kokoro-speak --model DIR --speaker ID --output-file OUT.wav [--accent us|gb] [--threads N] "
                 "[--espeak-data DIR] < text\n";
    return 2;
}

}  // namespace

int main(int argc, char **argv) {
    std::string model, out, accent = "us", espeak = KOKORO_SPEAK_ESPEAK_DATA;
    int speaker = -1, threads = 4;
    for (int i = 1; i < argc; i++) {
        std::string a = argv[i];
        if (i + 1 >= argc) return usage();
        std::string v = argv[++i];
        if (a == "--model") {
            model = v;
        } else if (a == "--output-file") {
            out = v;
        } else if (a == "--espeak-data") {
            espeak = v;
        } else if (a == "--accent") {
            if (v != "us" && v != "gb") return usage();
            accent = v;
        } else if (a == "--speaker") {
            if (!speak::number(v, speaker)) return usage();
        } else if (a == "--threads") {
            if (!speak::number(v, threads) || threads == 0) return usage();
        } else {
            return usage();
        }
    }
    if (model.empty() || out.empty() || espeak.empty() || speaker < 0) return usage();

    std::string text;
    if (!speak::readText("kokoro-speak", text)) return 1;

    const std::string onnx = model + "/model.onnx", voices = model + "/voices.bin", tokens = model + "/tokens.txt",
                      lexicon = model + "/lexicon-" + accent + "-en.txt";
    SherpaOnnxOfflineTtsConfig config;
    std::memset(&config, 0, sizeof config);
    config.model.kokoro.model = onnx.c_str();
    config.model.kokoro.voices = voices.c_str();
    config.model.kokoro.tokens = tokens.c_str();
    config.model.kokoro.lexicon = lexicon.c_str();
    config.model.kokoro.data_dir = espeak.c_str();
    // No `lang`: with one, sherpa-onnx hands every word to eSpeak NG and the lexicon goes unused (NX-300).
    config.model.kokoro.length_scale = 1.0f;
    config.model.num_threads = threads;
    config.model.provider = "cpu";
    config.max_num_sentences = 1;
    config.silence_scale = 0.2f;

    const SherpaOnnxOfflineTts *tts = SherpaOnnxCreateOfflineTts(&config);
    if (!tts) {
        std::cerr << "kokoro-speak: can't load the model or eSpeak NG's data\n";
        return 1;
    }
    if (speaker >= SherpaOnnxOfflineTtsNumSpeakers(tts)) {
        std::cerr << "kokoro-speak: the model has no speaker " << speaker << "\n";
        SherpaOnnxDestroyOfflineTts(tts);
        return 1;
    }
    SherpaOnnxGenerationConfig gen;
    std::memset(&gen, 0, sizeof gen);
    gen.sid = speaker;
    gen.speed = 1.0f;
    gen.silence_scale = 0.2f;
    const SherpaOnnxGeneratedAudio *audio = SherpaOnnxOfflineTtsGenerateWithConfig(tts, text.c_str(), &gen, nullptr, nullptr);
    if (!audio || audio->n <= 0 || audio->sample_rate <= 0) {
        std::cerr << "kokoro-speak: synthesis failed\n";
        if (audio) SherpaOnnxDestroyOfflineTtsGeneratedAudio(audio);
        SherpaOnnxDestroyOfflineTts(tts);
        return 1;
    }

    const bool ok = speak::writeAnswer("kokoro-speak", audio->samples, audio->n, audio->sample_rate, out);
    SherpaOnnxDestroyOfflineTtsGeneratedAudio(audio);
    SherpaOnnxDestroyOfflineTts(tts);
    return ok ? 0 : 1;
}
