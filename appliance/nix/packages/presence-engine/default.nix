# presence-watch, the camera side of the presence service (Whombat DK-31, DK-33; NX-280…): V4L2 capture, YuNet face
# detection through ONNX Runtime and libjpeg-turbo for MJPEG cameras, one small C++ file of ours. Both libraries are
# the nixpkgs builds the image already has (onnxruntime for kokoro-speak, libjpeg-turbo for Chromium and others), so the
# program adds about 0.1 MiB.
{
  lib,
  stdenv,
  onnxruntime,
  libjpeg_turbo,
}:
stdenv.mkDerivation {
  pname = "presence-watch";
  version = "1";
  src = ./presence-watch.cpp;
  dontUnpack = true;
  buildInputs = [
    onnxruntime
    libjpeg_turbo
  ];
  buildPhase = ''
    runHook preBuild
    $CXX -std=c++17 -O2 -Wall -Wextra -Werror $src -lonnxruntime -lturbojpeg -o presence-watch
    runHook postBuild
  '';
  installPhase = ''
    runHook preInstall
    install -Dm755 presence-watch $out/bin/presence-watch
    runHook postInstall
  '';
  doInstallCheck = true;
  # A wrong command line is refused with the usage (2): the program and its libraries load. With no cameras (the build
  # sandbox has none) the probe prints nothing and succeeds.
  installCheckPhase = ''
    rc=0
    $out/bin/presence-watch --help 2> usage.txt || rc=$?
    [ "$rc" = 2 ] && grep -q 'usage: presence-watch' usage.txt
    mkdir empty
    [ -z "$($out/bin/presence-watch --probe --sys "$PWD/empty")" ]
  '';
  meta = {
    description = "Finds whether a face is in front of the camera, for whombat-presence (no pictures kept)";
    mainProgram = "presence-watch";
    platforms = lib.platforms.linux;
  };
}
