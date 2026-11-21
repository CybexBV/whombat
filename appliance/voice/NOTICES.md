# Third-party notices of the voice service

`whombat-voice` (this directory, installed with `share/whombat-voice/NOTICES.md`) runs programs that are in the
appliance image (`nix/packages/voice-engines`, docs/decisions/nixos.md NX-291, NX-470, NX-472, NX-476) over Kokoro and
Supertonic 3, which are in the image, and two speech-to-text models, which are not: `whombat-voice-models` downloads them on the box after it is
installed, from the sources `nix/packages/voice-models` names (NX-473). It starts the programs as separate programs; it
doesn't link them.

| Component | Version | Licence | Source |
|---|---|---|---|
| whisper.cpp (`whisper-cli`, `parakeet-cli`, libwhisper, libparakeet, ggml with its CPU and Vulkan backends) | 1.9.5 | MIT | github.com/ggml-org/whisper.cpp, through nixpkgs' `whisper-cpp` recipe |
| `voice-gpu-probe` (`nix/packages/voice-engines/voice-gpu-probe.cpp`, ours) | | AGPL-3.0-only | this repository |
| mesa's Vulkan drivers RADV (`libvulkan_radeon.so`) and ANV (`libvulkan_intel.so`) | 26.1.8 | MIT | mesa3d.org, through nixpkgs `mesa` |
| Vulkan loader (`libvulkan.so.1`) | as pinned by nixpkgs | Apache-2.0 | github.com/KhronosGroup/Vulkan-Loader, through nixpkgs `vulkan-loader` |
| Parakeet TDT 0.6B v3, ggml q8_0 (`ggml-parakeet-tdt-0.6b-v3-q8_0.bin`), **downloaded by the box** | huggingface.co/ggml-org/parakeet-GGUF at `35156454` | CC-BY-4.0 | below |
| Whisper large-v3-turbo, ggml q5_0 (`ggml-large-v3-turbo-q5_0.bin`), **downloaded by the box** | huggingface.co/ggerganov/whisper.cpp at `5359861c` | MIT | OpenAI Whisper weights (github.com/openai/whisper, MIT), converted and quantized by the whisper.cpp project |
| `kokoro-speak` and `supertonic-speak` (`nix/packages/voice-engines/kokoro-speak.cpp`, `supertonic-speak.cpp`, `speak-common.h`, ours) | | GPL-3.0-only | this repository |
| sherpa-onnx's C library (`libsherpa-onnx-c-api.so`, linked into both) | 1.13.8 | Apache-2.0 | github.com/k2-fsa/sherpa-onnx, through nixpkgs' `sherpa-onnx` recipe at that version |
| eSpeak NG (built into sherpa-onnx's library; its English data beside `kokoro-speak`) | sherpa-onnx's pinned copy; data 1.52.0.1-unstable-2025-09-09 | GPL-3.0-or-later | github.com/csukuangfj/espeak-ng (a copy of github.com/espeak-ng/espeak-ng), the data through nixpkgs `espeak-ng` |
| What sherpa-onnx's library also carries: piper-phonemize, kaldi-native-fbank, kaldifst and OpenFst, kaldi-decoder, simple-sentencepiece, cargs, hclust-cpp, kissfft, Eigen, nlohmann/json | as sherpa-onnx 1.13.8 pins them (`nix/packages/voice-engines/default.nix`) | MIT, Apache-2.0, BSD-3-Clause, MPL-2.0 (Eigen) | their sources as that file lists them |
| ONNX Runtime (and the protobuf and Abseil libraries it uses) | 1.24.4 | MIT (protobuf BSD-3-Clause, Abseil Apache-2.0) | github.com/microsoft/onnxruntime, through nixpkgs |
| Kokoro v1.0 (`model.onnx`, `voices.bin`, `tokens.txt`), with the US English lexicon (`lexicon-us-en.txt`) | huggingface.co/csukuangfj/kokoro-multi-lang-v1_0 at `f7b96bb6` | Apache-2.0 | below |
| Supertonic 3, int8 (the four `*.int8.onnx`, `tts.json`, `unicode_indexer.bin`, `voice.bin`) | huggingface.co/csukuangfj2/sherpa-onnx-supertonic-3-tts-int8-2026-05-11 at `cca5a0e6`, from huggingface.co/Supertone/supertonic-3 at `3cadd1ee` | BigScience Open RAIL-M | below |

`kokoro-speak` and `supertonic-speak` are small programs that drive sherpa-onnx's C library; because that library
carries eSpeak NG, they are under the GNU General Public License version 3, unlike the rest of this repository. Their
complete corresponding source is `kokoro-speak.cpp`, `supertonic-speak.cpp`, `speak-common.h`,
`nix/packages/voice-engines/default.nix` (how they are built, with sherpa-onnx's own source and dependencies pinned
there) and the pinned eSpeak NG and ONNX Runtime sources of the pinned nixpkgs revision in `flake.lock`. The other programs are unmodified nixpkgs
builds with optional parts left out.

## Speech to text: Parakeet TDT 0.6B v3

**parakeet-tdt-0.6b-v3** by **NVIDIA** (huggingface.co/nvidia/parakeet-tdt-0.6b-v3), licensed under the Creative
Commons Attribution 4.0 International licence (CC-BY-4.0, creativecommons.org/licenses/by/4.0/). The form a box downloads
was converted to ggml and quantized to q8_0 by the ggml project (huggingface.co/ggml-org/parakeet-GGUF); it is not
otherwise changed. Whombat uses it to turn what a person says into text, on the box itself.

## The voice: Kokoro v1.0, af_heart

**Kokoro-82M** v1.0 by **hexgrad** (huggingface.co/hexgrad/Kokoro-82M), released under the Apache License 2.0 (its
weights and its voices). Its model card says it was trained only on permissive or non-copyrighted audio: public-domain
audio, audio under licences such as Apache and MIT, and synthetic audio; among them Koniwa `tnc` (CC BY 3.0) and SIWIS
(CC BY 4.0), credited on that card. The US English lexicon is built from **misaki** (github.com/hexgrad/misaki,
Apache-2.0), Kokoro's own pronunciation dictionaries. The packing for sherpa-onnx (the model with sherpa-onnx's
metadata, the voices in one table, the token list and the lexicon) is by the sherpa-onnx project (Fangjun Kuang),
Apache-2.0; its licence is installed beside the model (`LICENSE`).

Whombat speaks with the voice **af_heart** (US English, female). Kokoro was chosen over Piper's public-domain voice,
which Whombat used before, because it sounds far more natural while its weights stay free of conditions (NX-291).

## Dutch: Supertonic 3

**Supertonic 3** by **Supertone Inc.** (huggingface.co/Supertone/supertonic-3), Copyright (c) 2026 Supertone Inc.,
licensed under the **BigScience Open RAIL-M License** (dated August 18, 2022). Its full text is installed beside the
model (`LICENSE` in the model's directory, `pkgs.voice-supertonic-model`). Whombat uses it to speak the desk's answers
in Dutch, on the box itself.

The model's four ONNX files were **changed**: quantized to int8 by the sherpa-onnx project (Fangjun Kuang;
github.com/k2-fsa/sherpa-onnx `scripts/supertonic`, its release `sherpa-onnx-supertonic-3-tts-int8-2026-05-11`), which
also packed the ten voice styles into `voice.bin` and the text indexer into `unicode_indexer.bin`. Whombat ships these
files as sherpa-onnx published them, unchanged.

The model is subject to the licence's use-based restrictions (its paragraph 5 and Attachment A), which apply to
everyone who uses it, including through a Whombat:

    You agree not to use the Model or Derivatives of the Model:
    (a) In any way that violates any applicable national, federal, state, local or international law or regulation;
    (b) For the purpose of exploiting, harming or attempting to exploit or harm minors in any way;
    (c) To generate or disseminate verifiably false information and/or content with the purpose of harming others;
    (d) To generate or disseminate personal identifiable information that can be used to harm an individual;
    (e) To generate or disseminate information and/or content (e.g. images, code, posts, articles), and place the
        information and/or content in any context (e.g. bot generating tweets) without expressly and intelligibly
        disclaiming that the information and/or content is machine generated;
    (f) To defame, disparage or otherwise harass others;
    (g) To impersonate or attempt to impersonate (e.g. deepfakes) others without their consent;
    (h) For fully automated decision making that adversely impacts an individual's legal rights or otherwise creates
        or modifies a binding, enforceable obligation;
    (i) For any use intended to or which has the effect of discriminating against or harming individuals or groups
        based on online or offline social behavior or known or predicted personal or personality characteristics;
    (j) To exploit any of the vulnerabilities of a specific group of persons based on their age, social, physical or
        mental characteristics, in order to materially distort the behavior of a person pertaining to that group in a
        manner that causes or is likely to cause that person or another person physical or psychological harm;
    (k) For any use intended to or which has the effect of discriminating against individuals or groups based on
        legally protected characteristics or categories;
    (l) To provide medical advice and medical results interpretation;
    (m) To generate or disseminate information for the purpose to be used for administration of justice, law
        enforcement, immigration or asylum processes, such as predicting an individual will commit fraud/crime
        commitment (e.g. by text profiling, drawing causal relationships between assertions made in documents,
        indiscriminate and arbitrarily-targeted use).

Supertonic's sample code is under the MIT licence (Copyright (c) 2025 Supertone Inc.); Whombat uses none of it.

## MIT licences

whisper.cpp:

    MIT License

    Copyright (c) 2023-2026 The ggml authors

    Permission is hereby granted, free of charge, to any person obtaining a copy
    of this software and associated documentation files (the "Software"), to deal
    in the Software without restriction, including without limitation the rights
    to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
    copies of the Software, and to permit persons to whom the Software is
    furnished to do so, subject to the following conditions:

    The above copyright notice and this permission notice shall be included in all
    copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
    IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
    FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
    AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
    LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
    OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
    SOFTWARE.

The Whisper model weights (OpenAI), under the same terms:

    Copyright (c) 2022 OpenAI

ONNX Runtime, under the same terms:

    Copyright (c) Microsoft Corporation
