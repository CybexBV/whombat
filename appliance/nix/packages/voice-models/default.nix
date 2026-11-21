# The voice service's models (Whombat DK-12, DT-05; NX-176, NX-292, NX-473, NX-477). Kokoro (English) and Supertonic 3
# (Dutch), the desk's voices, are in the image:
# a fixed-output download from a pinned Hugging Face revision (the URL names the commit, the hash the bytes), built on a
# machine with network and never fetched by a box. The speech-to-text models are not: the box downloads them after it
# is installed (whombat-voice-models), from the sources `manifest` names with the size and sha256 their bytes must
# have. No `whombat-` in the names: checks.image-no-secrets scans every `*-whombat*` store path's bytes for key
# material, and weights there would be slow for nothing. Licences and attribution: voice/NOTICES.md.
{
  lib,
  fetchurl,
  runCommand,
  writeText,
}:
let
  # ggerganov/whisper.cpp on Hugging Face, its revision of 2024-10-29 (still the newest on 2026-10-20).
  whisperRev = "5359861c739e955e79d9a303bcbc70fb988958b1";
  # csukuangfj/kokoro-multi-lang-v1_0 (sherpa-onnx's packing of Kokoro v1.0), its revision of 2026-09-08 (the newest on
  # 2026-10-20).
  kokoroRev = "f7b96bb6bef5c5da4d3aa4f4e0498fbbf62dc78b";
  # csukuangfj2/sherpa-onnx-supertonic-3-tts-int8-2026-05-11, sherpa-onnx's int8 packing of Supertonic 3 (the same
  # bytes as its GitHub release `tts-models`), its revision of 2026-05-13 (the newest on 2026-10-27); and
  # Supertone/supertonic-3 of 2026-05-18 for the model's own licence (the packing's LICENSE is the sample code's MIT).
  supertonicRev = "cca5a0e6c96e1d2c720986bf7e75fcc81dee3ae4";
  supertoneRev = "3cadd1ee6394adea1bd021217a0e650ede09a323";
  supertonicFile =
    name: hash:
    fetchurl {
      url = "https://huggingface.co/csukuangfj2/sherpa-onnx-supertonic-3-tts-int8-2026-05-11/resolve/${supertonicRev}/${name}";
      inherit hash;
    };
  kokoroFile =
    name: hash:
    fetchurl {
      url = "https://huggingface.co/csukuangfj/kokoro-multi-lang-v1_0/resolve/${kokoroRev}/${name}";
      inherit hash;
    };
  sttModels = [
    {
      id = "parakeet";
      file = "ggml-parakeet-tdt-0.6b-v3-q8_0.bin";
      url = "https://huggingface.co/ggml-org/parakeet-GGUF/resolve/35156454d1a39de06863303dd209fd2bed6ee079/ggml-parakeet-tdt-0.6b-v3-q8_0.bin";
      size = 668757119;
      sha256 = "4d64e9e96c2792186d072fde0034df0ad670cf680a2f53069052ead827fd600e";
    }
    {
      id = "whisper";
      file = "ggml-large-v3-turbo-q5_0.bin";
      url = "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-large-v3-turbo-q5_0.bin";
      size = 574041195;
      sha256 = "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2";
    }
  ];
in
{
  # What the box downloads (NX-473), each from a pinned Hugging Face revision, with the LFS object's own size and sha256:
  # - parakeet: NVIDIA Parakeet TDT 0.6B v3 (CC-BY-4.0; English, Dutch and 23 more European languages), converted to
  #   ggml and quantized to q8_0 by the ggml project for whisper.cpp's parakeet-cli (ggml-org/parakeet-GGUF of
  #   2026-06-16). q8_0 makes the fewest Dutch mistakes of the forms measured (NX-470), f16 none fewer.
  # - whisper: OpenAI Whisper large-v3-turbo (MIT), converted to ggml and quantized to q5_0 by the whisper.cpp project
  #   (ggerganov/whisper.cpp of 2024-10-29, the newest on 2026-10-26).
  stt = sttModels;
  manifest = writeText "voice-models.json" (builtins.toJSON { models = sttModels; });

  # The build check's Parakeet (nix/checks/voice.nix): the manifest's file, fetched at build time for the check only.
  testParakeet = fetchurl {
    name = "ggml-parakeet-tdt-0.6b-v3-q8_0.bin";
    url = (lib.head sttModels).url;
    hash = "sha256-TWTp6WwnkhhtBy/eADTfCtZwz2gKL1MGkFLq2Cf9YA4=";
    meta.license = lib.licenses.cc-by-40;
  };

  # The VM test's stand-in for Whisper (32 MB, English only, the same program): served from the test machine itself as
  # the `whisper` of a test manifest, so the whole path from download to text runs without the internet.
  testWhisper = fetchurl {
    name = "ggml-tiny.en-q5_1.bin";
    url = "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-tiny.en-q5_1.bin";
    hash = "sha256-x3xXZvHO8JtrfUfyG1Rsvd1BV4hrO11tT3CekeZsfCs=";
    meta.license = lib.licenses.mit;
  };

  # Kokoro v1.0 (hexgrad/Kokoro-82M, Apache-2.0: weights trained on public-domain and permissively licensed audio), as
  # sherpa-onnx packs it: the fp32 model with sherpa-onnx's metadata (325 560 556 bytes; the int8 one, 114 MB, took
  # twice as long, NX-292), the 54 voices' style table (28 MiB; the model reads it whole), the token list and the US
  # and British English lexicons (misaki's dictionaries as sherpa-onnx converts them; the British one for the British
  # voices, NX-301). The Chinese lexicon, the number rules and eSpeak NG's data of the repository are left out
  # (kokoro-speak carries its own English data).
  kokoro =
    runCommand "kokoro-v1_0-en"
      {
        model = kokoroFile "model.onnx" "sha256-tA9isWasgWSwYn70igs1jtoJheJy+wPvUlLnIGMF2hE=";
        styles = kokoroFile "voices.bin" "sha256-HFpbmD09UNhYbUN6UfP6otp5Gc52oBPAgeZWcaNEfCk=";
        tokens = kokoroFile "tokens.txt" "sha256-brtrsojyDzro0ATTwsonaX2ifAN9degaYOKmpmP5VCU=";
        lexicon = kokoroFile "lexicon-us-en.txt" "sha256-faqrU6GBvpiFuFOoWCvxg4GGMX5dray875xCbW+g2hQ=";
        lexiconGb = kokoroFile "lexicon-gb-en.txt" "sha256-xMuzcxb2IhDf9ScYp6/KriT1DAMsx1q0euZ7gx0QSec=";
        licence = kokoroFile "LICENSE" "sha256-z8d0m5b2O9McPEK1xHG/dWgUBT6EfBDz6wA0F7xSPTA=";
        # The desk's voices (contracts DESK_VOICES, NX-301): the desk's name, the voice's number in the model (its
        # speaker2id), its accent (which lexicon) and whether it is a man's (Dutch is said in Supertonic's voice of the
        # same kind, NX-478). Kokoro's best-rated of each kind.
        passthru.deskVoices = [
          {
            name = "heart";
            speaker = 3;
            accent = "us";
          } # af_heart
          {
            name = "bella";
            speaker = 2;
            accent = "us";
          } # af_bella
          {
            name = "michael";
            speaker = 16;
            accent = "us";
            man = true;
          } # am_michael
          {
            name = "fenrir";
            speaker = 14;
            accent = "us";
            man = true;
          } # am_fenrir
          {
            name = "emma";
            speaker = 21;
            accent = "gb";
          } # bf_emma
          {
            name = "george";
            speaker = 26;
            accent = "gb";
            man = true;
          } # bm_george
        ];
        meta = {
          description = "Kokoro v1.0 text to speech, US English (sherpa-onnx packing)";
          homepage = "https://huggingface.co/hexgrad/Kokoro-82M";
          license = lib.licenses.asl20;
        };
      }
      ''
        mkdir $out
        ln -s $model $out/model.onnx
        ln -s $styles $out/voices.bin
        ln -s $tokens $out/tokens.txt
        ln -s $lexicon $out/lexicon-us-en.txt
        ln -s $lexiconGb $out/lexicon-gb-en.txt
        cp $licence $out/LICENSE
      '';

  # Supertonic 3 (Supertone Inc., BigScience Open RAIL-M; NX-476, NX-477), Dutch for the desk: one model for 31
  # languages, ten voices (F1…F5, M1…M5, in that order), 44.1 kHz. sherpa-onnx's int8 packing (the four ONNX files
  # quantized by sherpa-onnx, 145 MB; the full-precision ones, 398 MB, spoke no better in our checks), the voices' style
  # table, the text indexer and the model's settings, with the Open RAIL-M licence, whose use restrictions (its
  # Attachment A) travel with it (voice/NOTICES.md).
  supertonic =
    runCommand "supertonic-3-int8"
      {
        durationPredictor = supertonicFile "duration_predictor.int8.onnx" "sha256-w+uRQU1f+KeiObf+njTn4r+KgUDYN1/7FHGLHGOTJds=";
        textEncoder = supertonicFile "text_encoder.int8.onnx" "sha256-x779XqjDEZdp6KbBSGxO3Go7yDZcZ2IciBu7d0uZAv8=";
        vectorEstimator = supertonicFile "vector_estimator.int8.onnx" "sha256-IM2G+lxu/+39oOfP/lsFacpAHEQKDDodcr85KGwNs/0=";
        vocoder = supertonicFile "vocoder.int8.onnx" "sha256-6SPWD1P5XrHOI18dwz7FbZwFeCPJb6b4rPmPMrDaYVI=";
        settings = supertonicFile "tts.json" "sha256-QgeNOu8c1Dq0MCHzxU9H0tdc60519ifxGIkBKLBqDQk=";
        indexer = supertonicFile "unicode_indexer.bin" "sha256-hALKSOUYmolQE4WAsP/2TbbwcvJKwHzVS6iy+7mIOzA=";
        styles = supertonicFile "voice.bin" "sha256-Z9Ugmw7ozmx0EF/74S/mp2KK6jtLovyzCKSmeTipPOg=";
        licence = fetchurl {
          name = "supertonic-3-LICENSE";
          url = "https://huggingface.co/Supertone/supertonic-3/resolve/${supertoneRev}/LICENSE";
          hash = "sha256-DZRKkRD+2algLWDgQjonKQPnvSGrBgSQd078d8InXp8=";
        };
        # Open RAIL-M isn't a free licence in nixpkgs' sense (it restricts uses) and nixpkgs has no entry for it, so it
        # is named here rather than in meta.license, where allowUnfree (off, for everything else) would refuse it. The
        # image's check names this model as its one exception (flake.nix, NX-477).
        passthru.licence = {
          fullName = "BigScience Open RAIL-M";
          url = "https://huggingface.co/Supertone/supertonic-3/blob/${supertoneRev}/LICENSE";
          redistributable = true;
          useRestrictions = true;
        };
        meta = {
          description = "Supertonic 3 text to speech, int8 (sherpa-onnx packing)";
          homepage = "https://huggingface.co/Supertone/supertonic-3";
        };
      }
      ''
        mkdir $out
        ln -s $durationPredictor $out/duration_predictor.int8.onnx
        ln -s $textEncoder $out/text_encoder.int8.onnx
        ln -s $vectorEstimator $out/vector_estimator.int8.onnx
        ln -s $vocoder $out/vocoder.int8.onnx
        ln -s $settings $out/tts.json
        ln -s $indexer $out/unicode_indexer.bin
        ln -s $styles $out/voice.bin
        cp $licence $out/LICENSE
      '';
}
