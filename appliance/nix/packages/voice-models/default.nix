# The voice service's models: Kokoro (English), the desk's default voice, is in the image as a fixed-output download
# from a pinned Hugging Face revision (the URL names the commit, the hash the bytes), built on a machine with network
# and never fetched by a box. The speech-to-text models and Supertonic 3 (the optional Dutch voice) are not in the
# image: `whombat-voice-models` downloads them after the box is installed from the sources `manifest` names, verifying
# each file's size and sha256. Supertonic 3 is downloaded only after the person agrees to its Open RAIL-M licence in
# Settings. No `whombat-` in the names: checks.image-no-secrets scans every `*-whombat*` store path's bytes for key
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
  supertonicBase = "https://huggingface.co/csukuangfj2/sherpa-onnx-supertonic-3-tts-int8-2026-05-11/resolve/${supertonicRev}";
  # Every file of Supertonic 3 int8 plus the model's Open RAIL-M licence, pinned by revision, byte size and sha256.
  supertonicFiles = [
    {
      name = "duration_predictor.int8.onnx";
      url = "${supertonicBase}/duration_predictor.int8.onnx";
      size = 3700147;
      sha256 = "c3eb91414d5ff8a7a239b7fe9e34e7e2bf8a8140d8375ffb14718b1c639325db";
      hash = "sha256-w+uRQU1f+KeiObf+njTn4r+KgUDYN1/7FHGLHGOTJds=";
    }
    {
      name = "text_encoder.int8.onnx";
      url = "${supertonicBase}/text_encoder.int8.onnx";
      size = 36416150;
      sha256 = "c7befd5ea8c3119769e8a6c1486c4edc6a3bc8365c67621c881bbb774b9902ff";
      hash = "sha256-x779XqjDEZdp6KbBSGxO3Go7yDZcZ2IciBu7d0uZAv8=";
    }
    {
      name = "vector_estimator.int8.onnx";
      url = "${supertonicBase}/vector_estimator.int8.onnx";
      size = 78400833;
      sha256 = "20cd86fa5c6effedfda0e7cffe5b0569ca401c440a0c3a1d72bf39286c0db3fd";
      hash = "sha256-IM2G+lxu/+39oOfP/lsFacpAHEQKDDodcr85KGwNs/0=";
    }
    {
      name = "vocoder.int8.onnx";
      url = "${supertonicBase}/vocoder.int8.onnx";
      size = 25991073;
      sha256 = "e923d60f53f95eb1ce235f1dc33ec56d9c057823c96fa6f8acf98f32b0da6152";
      hash = "sha256-6SPWD1P5XrHOI18dwz7FbZwFeCPJb6b4rPmPMrDaYVI=";
    }
    {
      name = "tts.json";
      url = "${supertonicBase}/tts.json";
      size = 8253;
      sha256 = "42078d3aef1cd43ab43021f3c54f47d2d75ceb4e75f627f118890128b06a0d09";
      hash = "sha256-QgeNOu8c1Dq0MCHzxU9H0tdc60519ifxGIkBKLBqDQk=";
    }
    {
      name = "unicode_indexer.bin";
      url = "${supertonicBase}/unicode_indexer.bin";
      size = 262144;
      sha256 = "8402ca48e5189a8950138580b0fff64db6f072f24ac07cd54ba8b2fbb9883b30";
      hash = "sha256-hALKSOUYmolQE4WAsP/2TbbwcvJKwHzVS6iy+7mIOzA=";
    }
    {
      name = "voice.bin";
      url = "${supertonicBase}/voice.bin";
      size = 517168;
      sha256 = "67d5209b0ee8ce6c74105ffbe12fe6a7628aea3b4ba2fcb308a4a67938a93ce8";
      hash = "sha256-Z9Ugmw7ozmx0EF/74S/mp2KK6jtLovyzCKSmeTipPOg=";
    }
    {
      name = "LICENSE";
      fetchName = "supertonic-3-LICENSE";
      url = "https://huggingface.co/Supertone/supertonic-3/resolve/${supertoneRev}/LICENSE";
      size = 15007;
      sha256 = "0d944a9110fed9a9602d60e0423a272903e7bd21ab060490774efc77c2275e9f";
      hash = "sha256-DZRKkRD+2algLWDgQjonKQPnvSGrBgSQd078d8InXp8=";
    }
  ];
  supertonicManifestEntry = {
    id = "supertonic";
    dir = "supertonic-3-int8";
    files = map (
      f: {
        inherit (f)
          name
          url
          size
          sha256
          ;
      }
    ) supertonicFiles;
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
  manifestModels = sttModels ++ [ supertonicManifestEntry ];
in
{
  # What the box downloads, each from a pinned Hugging Face revision, with every file's own size and sha256:
  # - parakeet: NVIDIA Parakeet TDT 0.6B v3 (CC-BY-4.0; English, Dutch and 23 more European languages), converted to
  #   ggml and quantized to q8_0 by the ggml project for whisper.cpp's parakeet-cli (ggml-org/parakeet-GGUF of
  #   2026-06-16). q8_0 makes the fewest Dutch mistakes of the forms measured, f16 none fewer.
  # - whisper: OpenAI Whisper large-v3-turbo (MIT), converted to ggml and quantized to q5_0 by the whisper.cpp project
  #   (ggerganov/whisper.cpp of 2024-10-29, the newest on 2026-10-26).
  # - supertonic: Supertonic 3 int8 (BigScience Open RAIL-M), downloaded into a directory with its LICENSE file only
  #   after the person turns Dutch voice on and agrees to its use restrictions in Settings.
  stt = sttModels;
  manifest = writeText "voice-models.json" (builtins.toJSON { models = manifestModels; });

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

  # Supertonic 3 (Supertone Inc., BigScience Open RAIL-M), Dutch for the desk: one model for 31 languages, ten voices
  # (F1…F5, M1…M5, in that order), 44.1 kHz. Built for the speech build check only and never part of the appliance
  # image; boxes download the same files from `manifest` into /persist/voice-models once the person agrees to Open
  # RAIL-M in Settings.
  supertonic =
    let
      fetched = map (
        f:
        f
        // {
          drv = fetchurl (
            {
              inherit (f) url hash;
            }
            // lib.optionalAttrs (f ? fetchName) { name = f.fetchName; }
          );
        }
      ) supertonicFiles;
    in
    runCommand "supertonic-3-int8"
      {
        # Open RAIL-M isn't a free licence in nixpkgs' sense (it restricts uses) and nixpkgs has no entry for it, so it
        # is named here rather than in meta.license, where allowUnfree (off, for everything else) would refuse it.
        passthru = {
          manifestEntry = supertonicManifestEntry;
          licence = {
            fullName = "BigScience Open RAIL-M";
            url = "https://huggingface.co/Supertone/supertonic-3/blob/${supertoneRev}/LICENSE";
            redistributable = true;
            useRestrictions = true;
          };
        };
        meta = {
          description = "Supertonic 3 text to speech, int8 (sherpa-onnx packing)";
          homepage = "https://huggingface.co/Supertone/supertonic-3";
        };
      }
      ''
        mkdir $out
        ${lib.concatMapStringsSep "\n" (
          f:
          if f.name == "LICENSE" then
            "cp ${f.drv} $out/${f.name}"
          else
            "ln -s ${f.drv} $out/${f.name}"
        ) fetched}
      '';
}
