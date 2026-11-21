// SPDX-License-Identifier: GPL-3.0-only
//
// supertonic-speak: text to speech with Supertonic 3 through sherpa-onnx's C API, for whombat-voice's Dutch (NX-476).
// It links the same sherpa-onnx library as kokoro-speak, which carries eSpeak NG (GPL-3.0-or-later), so this file is
// licensed under the GNU General Public License version 3 too (voice/NOTICES.md). Supertonic reads the letters itself:
// no eSpeak data, no lexicon.
//
//   supertonic-speak --model DIR --speaker ID --lang LL --output-file OUT.wav [--threads N] [--seed N] < text
//
// DIR holds the model as sherpa-onnx packs it (int8): duration_predictor.int8.onnx, text_encoder.int8.onnx,
// vector_estimator.int8.onnx, vocoder.int8.onnx, tts.json, unicode_indexer.bin and voice.bin (the ten voices, F1…F5
// then M1…M5). LL is one of the model's languages (nl, en, de…). The text comes on stdin (UTF-8, at most 64 KiB), never
// as an argument, written out as it is said (the runtime spells numbers and names); the answer is a 16-bit mono WAV at
// the model's rate (44.1 kHz), with one gain to -3 dBFS (speak-common.h). Without --seed every answer is drawn afresh.
// Errors: a line on stderr, exit 1 (2 for a wrong command line).
#include "sherpa-onnx/c-api/c-api.h"
#include "speak-common.h"

#include <cstring>
#include <iostream>
#include <string>

namespace {

// A touch quicker than the model's own pace (1.0), as Supertonic's examples speak.
const float kSpeed = 1.05f;
// The flow's steps: 8 sounded as clean as 16 in our checks, at half the time.
const int kSteps = 8;

int usage() {
    std::cerr << "usage: supertonic-speak --model DIR --speaker ID --lang LL --output-file OUT.wav [--threads N] "
                 "[--seed N] < text\n";
    return 2;
}

bool language(const std::string &s) {
    return s.size() == 2 && s[0] >= 'a' && s[0] <= 'z' && s[1] >= 'a' && s[1] <= 'z';
}

}  // namespace

int main(int argc, char **argv) {
    std::string model, out, lang;
    int speaker = -1, threads = 4, seed = -1;
    for (int i = 1; i < argc; i++) {
        std::string a = argv[i];
        if (i + 1 >= argc) return usage();
        std::string v = argv[++i];
        if (a == "--model") {
            model = v;
        } else if (a == "--output-file") {
            out = v;
        } else if (a == "--lang") {
            if (!language(v)) return usage();
            lang = v;
        } else if (a == "--speaker") {
            if (!speak::number(v, speaker)) return usage();
        } else if (a == "--threads") {
            if (!speak::number(v, threads) || threads == 0) return usage();
        } else if (a == "--seed") {
            if (!speak::number(v, seed)) return usage();
        } else {
            return usage();
        }
    }
    if (model.empty() || out.empty() || lang.empty() || speaker < 0) return usage();

    std::string text;
    if (!speak::readText("supertonic-speak", text)) return 1;

    const std::string dp = model + "/duration_predictor.int8.onnx", te = model + "/text_encoder.int8.onnx",
                      ve = model + "/vector_estimator.int8.onnx", vo = model + "/vocoder.int8.onnx",
                      json = model + "/tts.json", indexer = model + "/unicode_indexer.bin",
                      voices = model + "/voice.bin";
    SherpaOnnxOfflineTtsConfig config;
    std::memset(&config, 0, sizeof config);
    config.model.supertonic.duration_predictor = dp.c_str();
    config.model.supertonic.text_encoder = te.c_str();
    config.model.supertonic.vector_estimator = ve.c_str();
    config.model.supertonic.vocoder = vo.c_str();
    config.model.supertonic.tts_json = json.c_str();
    config.model.supertonic.unicode_indexer = indexer.c_str();
    config.model.supertonic.voice_style = voices.c_str();
    config.model.num_threads = threads;
    config.model.provider = "cpu";
    config.max_num_sentences = 1;
    config.silence_scale = 0.2f;

    const SherpaOnnxOfflineTts *tts = SherpaOnnxCreateOfflineTts(&config);
    if (!tts) {
        std::cerr << "supertonic-speak: can't load the model\n";
        return 1;
    }
    if (speaker >= SherpaOnnxOfflineTtsNumSpeakers(tts)) {
        std::cerr << "supertonic-speak: the model has no speaker " << speaker << "\n";
        SherpaOnnxDestroyOfflineTts(tts);
        return 1;
    }
    // The language and the seed go in `extra` (sherpa-onnx's Supertonic options); both are checked above, so the JSON
    // needs no escaping.
    const std::string extra =
        "{\"lang\":\"" + lang + "\"" + (seed >= 0 ? ",\"seed\":" + std::to_string(seed) : std::string()) + "}";
    SherpaOnnxGenerationConfig gen;
    std::memset(&gen, 0, sizeof gen);
    gen.sid = speaker;
    gen.speed = kSpeed;
    gen.num_steps = kSteps;
    gen.silence_scale = 0.2f;
    gen.extra = extra.c_str();
    const SherpaOnnxGeneratedAudio *audio = SherpaOnnxOfflineTtsGenerateWithConfig(tts, text.c_str(), &gen, nullptr, nullptr);
    if (!audio || audio->n <= 0 || audio->sample_rate <= 0) {
        std::cerr << "supertonic-speak: synthesis failed\n";
        if (audio) SherpaOnnxDestroyOfflineTtsGeneratedAudio(audio);
        SherpaOnnxDestroyOfflineTts(tts);
        return 1;
    }
    const bool ok = speak::writeAnswer("supertonic-speak", audio->samples, audio->n, audio->sample_rate, out);
    SherpaOnnxDestroyOfflineTtsGeneratedAudio(audio);
    SherpaOnnxDestroyOfflineTts(tts);
    return ok ? 0 : 1;
}
