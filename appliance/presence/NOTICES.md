# Third-party notices of the presence service

`whombat-presence` (this directory, installed with `share/whombat-presence/NOTICES.md`) runs one program of ours,
`presence-watch` (`nix/packages/presence-engine`), with a face detection model that is in the appliance image
(`nix/packages/presence-model`; docs/decisions/nixos.md NX-280…). `presence-watch` links ONNX Runtime and
libjpeg-turbo; the service starts it as a separate program and doesn't link it.

| Component | Version | Licence | Source |
|---|---|---|---|
| `presence-watch` (`nix/packages/presence-engine/presence-watch.cpp`, ours) | | this repository's | this repository |
| YuNet face detection model (`face_detection_yunet_2023mar.onnx`) | 2023mar; huggingface.co/opencv/face_detection_yunet at `3cc26e7f` | MIT | github.com/opencv/opencv_zoo (`models/face_detection_yunet`), trained with github.com/ShiqiYu/libfacedetection.train |
| ONNX Runtime (and the protobuf and Abseil libraries it uses) | 1.24.4 | MIT (protobuf BSD-3-Clause, Abseil Apache-2.0) | github.com/microsoft/onnxruntime, through nixpkgs (the same build `piper-speak` uses, voice/NOTICES.md) |
| libjpeg-turbo (the TurboJPEG API, for cameras that send MJPEG) | 3.1.4 | IJG License, Modified (3-clause) BSD License, zlib License | github.com/libjpeg-turbo/libjpeg-turbo, through nixpkgs |

This software is based in part on the work of the Independent JPEG Group.

The model only finds faces (a box and a score); nothing in the service recognizes whose face it is, and no picture is
kept or sent (Whombat DK-31).

## The pictures in the check

`checks.presence-detect` (`nix/checks/presence.nix`) runs the detector on these pictures in the build sandbox; they
are not in the image.

| Picture | Licence | Source |
|---|---|---|
| Eileen Collins, NASA portrait (`astronaut.png`) | Public domain (a work of NASA, a US government agency) | scikit-image at `b700edc8`, `src/_skimage2/data/astronaut.png` |
| The STS-61 crew on Endeavour's flight deck (`sts061-05-031`) | Public domain (NASA) | images.nasa.gov, `sts061-05-031~small.jpg` |
| Chelsea the cat (`chelsea.png`) | CC0 1.0 (Stéfan van der Walt) | scikit-image at `b700edc8`, `src/_skimage2/data/chelsea.png` |
| A coffee cup (`coffee.png`) | CC0 1.0 (Rachel Michetti) | scikit-image at `b700edc8`, `src/_skimage2/data/coffee.png` |

## Licences

YuNet (opencv_zoo `models/face_detection_yunet/LICENSE`, installed beside the model):

    MIT License

    Copyright (c) 2020 Shiqi Yu <shiqi.yu@gmail.com>

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

ONNX Runtime, under the same MIT terms:

    Copyright (c) Microsoft Corporation

libjpeg-turbo's TurboJPEG API, under the Modified (3-clause) BSD License:

    Copyright (C) 2009-2026 D. R. Commander.  All Rights Reserved.
    Copyright (C) 2015 Viktor Szathmáry.  All Rights Reserved.

    Redistribution and use in source and binary forms, with or without
    modification, are permitted provided that the following conditions are met:

    - Redistributions of source code must retain the above copyright notice,
      this list of conditions and the following disclaimer.
    - Redistributions in binary form must reproduce the above copyright notice,
      this list of conditions and the following disclaimer in the documentation
      and/or other materials provided with the distribution.
    - Neither the name of the libjpeg-turbo Project nor the names of its
      contributors may be used to endorse or promote products derived from this
      software without specific prior written permission.

    THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS",
    AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
    IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
    ARE DISCLAIMED.  IN NO EVENT SHALL THE COPYRIGHT HOLDERS OR CONTRIBUTORS BE
    LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
    CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
    SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
    INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
    CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
    ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
    POSSIBILITY OF SUCH DAMAGE.

libjpeg-turbo's libjpeg API comes under the IJG License (its `README.ijg`, part of the pinned nixpkgs source), whose
condition for binaries is the sentence above; its SIMD code under the zlib License, subsumed there.
