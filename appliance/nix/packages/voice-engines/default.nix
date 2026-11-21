# The voice service's programs (NX-176, NX-291, NX-470), cut down to what a box runs:
#
# - whisper: whisper.cpp 1.9.5 (MIT; nixpkgs' whisper-cpp recipe at that version) with `bin/whisper-cli` (Whisper),
#   `bin/parakeet-cli` (Parakeet, new in 1.9) and `bin/voice-gpu-probe` (ours, voice-gpu-probe.cpp: ggml's devices as
#   JSON), and the libraries only. Without SDL (only the examples that record from a microphone need it). ggml's
#   backends are separate libraries loaded at run time (GGML_BACKEND_DL): the CPU's in every x86-64 variant
#   (GGML_CPU_ALL_VARIANTS, the best one for the machine picked when it starts) and Vulkan's (NX-472), which runs on the
#   box's graphics chip through the drivers of `vulkan` below, and does nothing on a machine without one.
# - vulkan: mesa's Vulkan drivers for AMD (RADV) and Intel (ANV) and nothing else of mesa (no OpenGL, no gallium, no
#   LLVM: NX-169's follow-up), for whisper.cpp only; the voice service names them with VK_DRIVER_FILES.
# - kokoro: `kokoro-speak` and `supertonic-speak`, two small programs of ours (kokoro-speak.cpp, supertonic-speak.cpp,
#   speak-common.h) on sherpa-onnx's C library (1.13.8, Apache-2.0, with eSpeak NG (GPL-3.0-or-later) built into it
#   for the words Kokoro's lexicon doesn't know), on nixpkgs' onnxruntime: no Python. kokoro-speak speaks English with
#   Kokoro, supertonic-speak Dutch with Supertonic 3 (NX-476), which reads letters itself and needs no eSpeak data.
#   sherpa-onnx is nixpkgs' recipe at 1.13.8 (nixpkgs has 1.12.38; Supertonic 3 came in 1.13.2 and its accents stopped
#   being dropped in 1.13.5), built without its Python module and websocket server; only its C library is kept (5 MiB;
#   its programs bring ALSA and its closure is 164 MiB). The programs carry eSpeak NG's English data only (1.5 MB of
#   its 14).
#
# None is in the binary cache in this form; they build from source in a few minutes (mesa's Vulkan drivers longer).
{
  lib,
  stdenv,
  fetchFromGitHub,
  fetchurl,
  whisper-cpp,
  sherpa-onnx,
  espeak-ng,
  mesa,
  removeReferencesTo,
}:
let
  # The dependencies sherpa-onnx 1.13.8's CMake looks for in its source tree (cmake/*.cmake, the file names it
  # expects), so nothing is downloaded while it builds; nixpkgs' list is 1.12.38's. eigen, json and googletest come
  # from nixpkgs (FETCHCONTENT_SOURCE_DIR_*), as in its recipe.
  sherpaDeps = [
    {
      name = "espeak-ng-ed530aa113046142eb5115cf2fc9157854d0ffe1.zip";
      url = "https://github.com/csukuangfj/espeak-ng/archive/ed530aa113046142eb5115cf2fc9157854d0ffe1.zip";
      hash = "sha256-5OJiy+NPf+IfkfG6M5fyco4fMOr7rnhT8rdTqe0T8N0=";
    }
    {
      name = "kaldi-native-fbank-1.22.3.tar.gz";
      url = "https://github.com/csukuangfj/kaldi-native-fbank/archive/refs/tags/v1.22.3.tar.gz";
      hash = "sha256-kXbMZvx84e34XPNVsG4yDFfbYpffdCd/V1GDRoiTz2E=";
    }
    {
      name = "simple-sentencepiece-0.7.tar.gz";
      url = "https://github.com/pkufool/simple-sentencepiece/archive/refs/tags/v0.7.tar.gz";
      hash = "sha256-F0ioIgYKNbqp9mCfhO/I61TcDnS57OPYI2e3EZ/cda8=";
    }
    # kaldi-decoder's own CMake asks for kaldifst.
    {
      name = "kaldifst-1.8.0.tar.gz";
      url = "https://github.com/k2-fsa/kaldifst/archive/refs/tags/v1.8.0.tar.gz";
      hash = "sha256-PyR7flokCQcSAvXivGIABg9mcowKNEPAOSOtJyPgQLM=";
    }
    {
      name = "kaldi-decoder-0.3.0.tar.gz";
      url = "https://github.com/k2-fsa/kaldi-decoder/archive/refs/tags/v0.3.0.tar.gz";
      hash = "sha256-ufNM+0/TsTRBAO6tee9NN6oVliJ0ueMFbeNFAh92obA=";
    }
    {
      name = "cargs-1.0.3.tar.gz";
      url = "https://github.com/likle/cargs/archive/refs/tags/v1.0.3.tar.gz";
      hash = "sha256-3bolvTXpxsdbxwbBJgAbjOjghNQO83BQ5qppY+g264s=";
    }
    {
      name = "piper-phonemize-f3ff95afc03640bc1399e113e83361192a2fafb4.zip";
      url = "https://github.com/csukuangfj/piper-phonemize/archive/f3ff95afc03640bc1399e113e83361192a2fafb4.zip";
      hash = "sha256-2cyk4r3H1t2N/7lqRmgoPb0/d6nBlKPlMMHo66lAal0=";
    }
    {
      name = "openfst-1.8.5-2026-07-09.tar.gz";
      url = "https://github.com/csukuangfj/openfst/archive/refs/tags/v1.8.5-2026-07-09.tar.gz";
      hash = "sha256-L/cSoylS/LAdNREhpryMz0/cayqgbOjfKzCV3t1RjA4=";
    }
    {
      name = "hclust-cpp-2026-02-25.tar.gz";
      url = "https://github.com/csukuangfj/hclust-cpp/archive/refs/tags/2026-02-25.tar.gz";
      hash = "sha256-jxTgJMcJ1zr7QK5pyyLeS3Pbpny85A8uUYgT2oE5q1Y=";
    }
  ];
  sherpa =
    (sherpa-onnx.override {
      websocketSupport = false;
      pythonSupport = false;
    }).overrideAttrs
      (_: {
        version = "1.13.8";
        src = fetchFromGitHub {
          owner = "k2-fsa";
          repo = "sherpa-onnx";
          tag = "v1.13.8";
          hash = "sha256-yAkjeRJXSiGW7Pr6cmHKUeYiWZyd88raEMdaJvYhQLM=";
        };
        preConfigure = lib.concatMapStringsSep "\n" (
          d: "cp ${fetchurl { inherit (d) url hash; }} ./${d.name}"
        ) sherpaDeps;
      });
  espeakData = "${espeak-ng}/share/espeak-ng-data";
in
{
  vulkan = import ./vulkan.nix {
    inherit
      lib
      stdenv
      mesa
      removeReferencesTo
      ;
  };

  whisper =
    (whisper-cpp.override {
      withSDL = false;
      vulkanSupport = true;
    }).overrideAttrs
      (old: {
        version = "1.9.5";
        src = fetchFromGitHub {
          owner = "ggml-org";
          repo = "whisper.cpp";
          tag = "v1.9.5";
          hash = "sha256-Qqqpt+pvCQwSbyaBr1bdb7q+3LbELTcloHdiSikGPc4=";
        };
        # nixpkgs' patch is for its model downloader, which a box doesn't get.
        patches = [ ];
        cmakeFlags = old.cmakeFlags ++ [ (lib.cmakeBool "WHISPER_BUILD_TESTS" false) ];
        postInstall = ''
          $CXX -std=c++17 -O2 -Wall -I$out/include ${./voice-gpu-probe.cpp} \
            -L$out/lib -lggml -lggml-base -Wl,-rpath,$out/lib -o $out/bin/voice-gpu-probe
          rm -r $out/lib/cmake $out/lib/pkgconfig $out/include
          find $out/bin -type f ! -name whisper-cli ! -name parakeet-cli ! -name voice-gpu-probe -delete
        '';
        # The programs and their libraries load, and the probe finds the build machine's processor (no chip there).
        installCheckPhase = ''
          runHook preInstallCheck
          $out/bin/whisper-cli --help > /dev/null
          $out/bin/parakeet-cli --help > /dev/null 2>&1
          $out/bin/voice-gpu-probe | grep -q '"backend":"CPU"'
          runHook postInstallCheck
        '';
        meta = old.meta // {
          mainProgram = "whisper-cli";
        };
      });

  kokoro = stdenv.mkDerivation {
    pname = "kokoro-speak";
    inherit (sherpa) version;
    dontUnpack = true;
    buildPhase = ''
      runHook preBuild
      mkdir -p $out/lib
      # sherpa-onnx's C library alone, its own store path (and so its programs) left behind; it finds onnxruntime by
      # its own RUNPATH.
      install -m755 ${sherpa}/lib/libsherpa-onnx-c-api.so $out/lib/
      cp ${./speak-common.h} speak-common.h
      cp ${./kokoro-speak.cpp} kokoro-speak.cpp
      cp ${./supertonic-speak.cpp} supertonic-speak.cpp
      $CXX -std=c++17 -O2 -Wall -I${sherpa}/include -I. \
        -DKOKORO_SPEAK_ESPEAK_DATA="\"$out/share/espeak-ng-data\"" \
        kokoro-speak.cpp -L$out/lib -lsherpa-onnx-c-api -Wl,-rpath,$out/lib -o kokoro-speak
      $CXX -std=c++17 -O2 -Wall -I${sherpa}/include -I. \
        supertonic-speak.cpp -L$out/lib -lsherpa-onnx-c-api -Wl,-rpath,$out/lib -o supertonic-speak
      runHook postBuild
    '';
    # English only: the phoneme tables, the English dictionary, the language and voice definitions (small). sherpa-onnx
    # reads eSpeak NG's data of nixpkgs' version (1.52) as its own.
    installPhase = ''
      runHook preInstall
      install -Dm755 kokoro-speak $out/bin/kokoro-speak
      install -Dm755 supertonic-speak $out/bin/supertonic-speak
      d=$out/share/espeak-ng-data
      mkdir -p $d
      cp -r ${espeakData}/{phontab,phonindex,phondata,intonations,en_dict,lang,voices} $d/
      chmod -R u+w $d
      runHook postInstall
    '';
    disallowedReferences = [
      sherpa
      espeak-ng
    ];
    doInstallCheck = true;
    # A wrong command line is refused with the usage (2): the programs and their libraries load.
    installCheckPhase = ''
      rc=0
      $out/bin/kokoro-speak --help 2> usage.txt || rc=$?
      [ "$rc" = 2 ] && grep -q 'usage: kokoro-speak' usage.txt
      rc=0
      $out/bin/supertonic-speak --help 2> usage.txt || rc=$?
      [ "$rc" = 2 ] && grep -q 'usage: supertonic-speak' usage.txt
    '';
    meta = {
      description = "Kokoro and Supertonic text to speech through sherpa-onnx's C library, without Python (whombat-voice)";
      homepage = "https://github.com/k2-fsa/sherpa-onnx";
      license = lib.licenses.gpl3Only;
      mainProgram = "kokoro-speak";
      platforms = lib.platforms.linux;
    };
  };
}
