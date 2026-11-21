# The presence service's face detector, in the image (Whombat DK-31; NX-281): YuNet, opencv_zoo's
# face_detection_yunet_2023mar.onnx (MIT, Shiqi Yu and the libfacedetection.train authors), 232 589 bytes, with its
# LICENSE. A fixed-output download from the opencv/face_detection_yunet repository on Hugging Face at a pinned revision
# (the URL names the commit, the hash the bytes; the model's sha256 is the LFS object id there and in
# github.com/opencv/opencv_zoo); built on a machine with network, never fetched by a box. Attribution:
# presence/NOTICES.md.
{
  lib,
  fetchurl,
  runCommand,
}:
let
  # opencv/face_detection_yunet, its revision of 2025-06-20 (the newest on 2026-10-20).
  rev = "3cc26e7f1014a5ee5d74a42acee58bafc9d0a310";
  file =
    name: hash:
    fetchurl {
      url = "https://huggingface.co/opencv/face_detection_yunet/resolve/${rev}/${name}";
      inherit hash;
    };
  onnx = "face_detection_yunet_2023mar.onnx";
in
runCommand "presence-model-yunet-2023mar"
  {
    model = file onnx "sha256-jyOD5N08+7RVPqhxgQf8BCMhDclk+fQoBgSATtJVL6Q=";
    license = file "LICENSE" "sha256-yDuBIMUMy9TE+W7fUxQb3VZuu4+OkifkFTJqobGrqVg=";
    passthru.onnx = onnx;
    meta = {
      description = "YuNet face detection model (opencv_zoo, 2023mar)";
      homepage = "https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet";
      license = lib.licenses.mit;
    };
  }
  ''
    mkdir $out
    cp $model $out/${onnx}
    cp $license $out/LICENSE
  ''
