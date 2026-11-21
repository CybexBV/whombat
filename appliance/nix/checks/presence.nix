# The presence service with its real program and model, in the build sandbox (NX-287): no camera, so pictures stand in
# for one. presence-watch finds the faces in public-domain photographs (NASA's, fetched by hash; presence/NOTICES.md),
# in JPEG as an MJPEG camera sends them and in grey as an infrared one does, down to a face about 40 px tall at 320
# wide; it finds none in a cat, a coffee cup, a black frame, a frame too dark to see or a face across the room. Then the
# whole service, with a folder of pictures as its camera: health, a watch that starts the camera and sees the face,
# a stop that ends the camera program, a dark folder that answers `dark`, and a box without a camera.
# No network, no VM: `nix build .#checks.x86_64-linux.presence-detect`.
{
  lib,
  runCommand,
  fetchurl,
  curl,
  jq,
  netpbm,
  whombat-presence,
  presence-watch,
  presence-model,
}:
let
  # scikit-image's sample pictures at a pinned commit (2026-10-09): Eileen Collins' NASA portrait (public domain),
  # Chelsea the cat and a coffee cup (both CC0).
  skimage =
    name: hash:
    fetchurl {
      url = "https://raw.githubusercontent.com/scikit-image/scikit-image/b700edc8005e4ee9e74fc83259f09e8df3213f15/src/_skimage2/data/${name}";
      inherit hash;
    };
  astronaut = skimage "astronaut.png" "sha256-iEMc2WU8zVOXQbVV+wpGthVYswHUEQQStbwotePqbLU=";
  chelsea = skimage "chelsea.png" "sha256-WWqh58uHXrefQ34xA4HSazOKgcLaI0OXBKc8RlHoxLs=";
  coffee = skimage "coffee.png" "sha256-zAL4yhiLFnx3WnEBtddn0ecXks92LDPW+hWkWZtajec=";
  # The STS-61 crew on Endeavour's flight deck, seven faces (NASA, public domain), as images.nasa.gov serves it.
  crew = fetchurl {
    url = "https://images-assets.nasa.gov/image/sts061-05-031/sts061-05-031~small.jpg";
    hash = "sha256-o3ZLGTLPOg8Jq6k+2tkyKUaledF+v443fJZgrlwiqPQ=";
  };
  model = "${presence-model}/${presence-model.onnx}";
in
runCommand "presence-check"
  {
    nativeBuildInputs = [
      curl
      jq
      netpbm
    ];
  }
  ''
    set -euo pipefail
    fail() { echo "FAIL: $*" >&2; exit 1; }
    watch=${lib.getExe' presence-watch "presence-watch"}

    # ---- presence-watch on pictures ----
    $watch --model ${model} --self-test | jq -e '.selfTest == "ok"' > /dev/null

    mkdir faces none dark
    pngtopnm ${astronaut} > faces/astronaut.ppm
    cp ${crew} faces/crew.jpg
    jpegtopnm ${crew} | ppmtopgm > faces/crew-grey.pgm
    # About 40 px tall at 320 wide: someone at a desk, a step back.
    pamscale -width 183 faces/astronaut.ppm | pnmpad -width 320 -height 240 -halign 0.5 -valign 0.3 > faces/small.ppm
    pngtopnm ${chelsea} > none/chelsea.ppm
    pngtopnm ${coffee} > none/coffee.ppm
    ppmmake rgb:00/00/00 320 240 > none/black.ppm
    # A face about 17 px tall: someone across the room.
    pamscale -width 80 faces/astronaut.ppm | pnmpad -width 320 -height 240 > none/far.ppm
    pamscale -width 320 faces/astronaut.ppm | pamfunc -multiplier 0.01 > dark/astronaut-dark.ppm
    cp dark/astronaut-dark.ppm none/

    $watch --model ${model} --frames faces > faces.jsonl
    $watch --model ${model} --frames none > none.jsonl
    cat faces.jsonl none.jsonl
    [ "$(wc -l < faces.jsonl)" = 4 ] && [ "$(wc -l < none.jsonl)" = 5 ] || fail "a line per picture"
    jq -se 'all(.face and .score >= 0.85)' faces.jsonl > /dev/null || fail "a face was missed"
    jq -se 'all(.face | not)' none.jsonl > /dev/null || fail "a face where there is none"
    jq -se 'map(select(.file == "black.ppm" or .file == "astronaut-dark.ppm")) | length == 2 and all(.luma < 5)' none.jsonl > /dev/null \
      || fail "the black and dark frames' brightness"
    jq -se 'all(has("t") and has("score") and has("luma"))' faces.jsonl > /dev/null

    # ---- The service, a folder of pictures as its camera ----
    run() {
      rm -f p.sock
      ${lib.getExe' whombat-presence "whombat-presence"} --socket "$PWD/p.sock" --watch $watch --model ${model} \
        --sys "$PWD/no-sys" "$@" 2>> service.log &
      service=$!
      for _ in $(seq 100); do [ -S p.sock ] && break; sleep 0.1; done
    }
    call() { curl -sS --unix-socket p.sock -H 'Content-Type: application/json' "$@"; }
    watching() { call -d '{"v":1}' http://p/v1/presence/watch; }
    children() { n=0; for p in /proc/[0-9]*; do [ "$(cat $p/comm 2>/dev/null)" = presence-watch ] && n=$((n + 1)); done; echo $n; }
    until_state() {
      for _ in $(seq 100); do
        watching > w.json
        jq -e --arg s "$1" '.state == $s' w.json > /dev/null && return 0
        sleep 0.1
      done
      fail "never $1: $(cat w.json)"
    }
    trap 'kill $service 2>/dev/null || true' EXIT

    run --frames "$PWD/faces"
    call http://p/v1/presence/health | jq -e '. == {v: 1, camera: true, detector: true}' > /dev/null
    watching | jq -e '.state == "starting" and .face == false' > /dev/null
    [ "$(children)" = 1 ] || fail "the camera program isn't running"
    until_state watching
    jq -e '.face and (.seenAt | type == "string") and (.frameAt | type == "string")' w.json > /dev/null || fail "no face: $(cat w.json)"
    call -d '{"v":1}' http://p/v1/presence/stop | jq -e '. == {v: 1}' > /dev/null
    for _ in $(seq 50); do [ "$(children)" = 0 ] && break; sleep 0.1; done
    [ "$(children)" = 0 ] || fail "the camera program outlived the stop"
    code=$(curl -sS -o bad.json -w '%{http_code}' --unix-socket p.sock -d '{"v":1,"camera":"/dev/video0"}' http://p/v1/presence/watch)
    [ "$code" = 400 ] && jq -e '.error.code == "bad_request"' bad.json > /dev/null || fail "a strict request: $code"
    kill $service; wait $service || true

    run --frames "$PWD/dark"
    until_state dark
    kill $service; wait $service || true

    # No camera at all (no /sys/class/video4linux): the switch isn't offered, and a watch says so.
    run
    call http://p/v1/presence/health | jq -e '. == {v: 1, camera: false, detector: true}' > /dev/null
    watching | jq -e '.state == "no_camera"' > /dev/null
    kill $service; wait $service || true
    [ "$(children)" = 0 ] || fail "a camera program was left"

    # Nothing of a picture in the journal: lines name the camera and the times, never a score.
    cat service.log
    ! grep -q score service.log || fail "the service logged a score"
    touch $out
  ''
