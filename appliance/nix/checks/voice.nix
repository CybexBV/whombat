# The voice service with its real programs and models, in the build sandbox (NX-183, NX-295, NX-475): Kokoro says “Is
# pve two okay?”, the answer is a valid WAV (16-bit mono at the model's 24 kHz), and Parakeet, given it as the desk would
# send it (16 kHz mono), hears the words; Whisper (tiny.en standing in for large-v3-turbo, the same program) hears a
# recording of 40 s cut into two pieces. The models are where the fetcher would have put them (the box downloads them,
# the check has them from the build). Silence is heard as nothing, nothing is left in the jobs' directory, and the health
# answer reads the PCM list. No network, no VM: `nix build .#checks.x86_64-linux.voice`.
{
  lib,
  runCommand,
  writeText,
  curl,
  jq,
  sox,
  whombat-voice,
  voice-whisper,
  voice-kokoro,
  voice-test-parakeet,
  voice-test-whisper,
  voice-kokoro-model,
  voice-supertonic-model,
}:
let
  manifest = writeText "voice-check-models.json" (
    builtins.toJSON {
      models = [
        {
          id = "parakeet";
          file = "parakeet.bin";
          url = "https://huggingface.co/unused";
          size = 668757119;
          sha256 = "4d64e9e96c2792186d072fde0034df0ad670cf680a2f53069052ead827fd600e";
        }
        {
          id = "whisper";
          file = "whisper.bin";
          url = "https://huggingface.co/unused";
          size = 32166155;
          sha256 = "c77c5766f1cef09b6b7d47f21b546cbddd4157886b3b5d6d4f709e91e66c7c2b";
        }
      ];
    }
  );
in
runCommand "voice-check"
  {
    nativeBuildInputs = [
      curl
      jq
      sox
    ];
  }
  ''
    set -euo pipefail
    fail() { echo "FAIL: $*" >&2; exit 1; }
    mkdir jobs models
    ln -s ${voice-test-parakeet} models/parakeet.bin
    ln -s ${voice-test-whisper} models/whisper.bin
    printf '00-00: ALC294 Analog : ALC294 Analog : playback 1 : capture 1\n' > pcm
    ${lib.getExe' whombat-voice "whombat-voice"} --socket "$PWD/v.sock" --tmp "$PWD/jobs" --pcm "$PWD/pcm" \
      --whisper ${voice-whisper}/bin/whisper-cli --parakeet ${voice-whisper}/bin/parakeet-cli \
      --models "$PWD/models" --manifest ${manifest} \
      --kokoro ${voice-kokoro}/bin/kokoro-speak --kokoro-model ${voice-kokoro-model} \
      --kokoro-voices ${
        lib.concatMapStringsSep "," (
          v: "${v.name}=${toString v.speaker}:${v.accent}:${if v.man or false then "man" else "woman"}"
        ) voice-kokoro-model.deskVoices
      } \
      --supertonic ${voice-kokoro}/bin/supertonic-speak --supertonic-model ${voice-supertonic-model} \
      --supertonic-speakers 1,8 &
    voice=$!
    trap 'kill $voice 2>/dev/null || true' EXIT
    for _ in $(seq 100); do [ -S v.sock ] && break; sleep 0.1; done
    call() { curl -sS --fail-with-body --unix-socket v.sock -H 'Content-Type: application/json' "$@"; }

    call http://voice/v1/voice/health \
      | jq -e '. == {v: 1, stt: true, tts: true, microphone: true, speaker: true, voices: ["heart", "bella", "michael", "fenrir", "emma", "george"], languages: ["en", "nl"], models: ["parakeet", "whisper"]}'

    # Text to speech: a valid WAV at the model's rate, its loudest moment at -3 dBFS (kokoro-speak's one gain).
    call -d '{"v":1,"text":"Is pve two okay?"}' http://voice/v1/voice/tts | jq -r .audioWav | base64 -d > answer.wav
    [ "$(head -c 4 answer.wav)" = RIFF ] || fail "the answer is not RIFF"
    [ "$(sox --i -t answer.wav)" = wav ] && [ "$(sox --i -r answer.wav)" = 24000 ] \
      && [ "$(sox --i -c answer.wav)" = 1 ] && [ "$(sox --i -b answer.wav)" = 16 ] || fail "the answer is not 16-bit mono 24 kHz"
    peak=$(sox answer.wav -n stat 2>&1 | awk '/Maximum amplitude/ { print $3 }')
    echo "answer peak: $peak"
    awk -v p="$peak" 'BEGIN { exit !(p > 0.69 && p < 0.72) }' || fail "the answer's peak is $peak, not -3 dBFS"
    secs=$(sox --i -D answer.wav)
    echo "answer: $secs s"
    awk -v s="$secs" 'BEGIN { exit !(s > 0.5 && s < 5) }' || fail "the answer lasts $secs s"

    # Speech to text, as the desk sends it: Automatic is Parakeet on a box without a graphics chip.
    sox answer.wav -r 16000 -c 1 -b 16 speech.wav
    printf '{"v":1,"prompt":"pve-02","audioWav":"%s"}' "$(base64 -w0 speech.wav)" > stt.json
    call -d @stt.json http://voice/v1/voice/stt > heard.json
    echo "heard: $(jq -c . heard.json)"
    # Parakeet takes no prompt, so a server's name comes out as it sounds (“P V”, DT-09); the rest is heard.
    words=$(jq -r .text heard.json | tr 'A-Z' 'a-z' | tr -cd 'a-z0-9 ')
    case "$words" in *p*v*) ;; *) fail "pve not heard: $words" ;; esac
    case "$words" in *ok*) ;; *) fail "okay not heard: $words" ;; esac
    jq -e '.seconds >= 1' heard.json > /dev/null

    # Silence is nothing heard (whisper.cpp never sees it).
    sox -n -r 16000 -c 1 -b 16 silence.wav trim 0 1.5
    printf '{"v":1,"audioWav":"%s"}' "$(base64 -w0 silence.wav)" > quiet.json
    call -d @quiet.json http://voice/v1/voice/stt | jq -e '.text == "" and .seconds == 2'

    # A British voice with the British lexicon (NX-301): a WAV whisper.cpp hears; a voice it hasn't is 400.
    call -d '{"v":1,"text":"The backup finished.","voice":"emma"}' http://voice/v1/voice/tts | jq -r .audioWav | base64 -d > emma.wav
    [ "$(sox --i -r emma.wav)" = 24000 ] || fail "emma's answer is not 24 kHz"
    sox emma.wav -r 16000 -c 1 -b 16 emma16.wav
    printf '{"v":1,"audioWav":"%s"}' "$(base64 -w0 emma16.wav)" > emma.json
    emma=$(call -d @emma.json http://voice/v1/voice/stt | jq -r .text | tr 'A-Z' 'a-z')
    echo "emma heard: $emma"
    case "$emma" in *backup*finished*) ;; *) fail "emma's words not heard: $emma" ;; esac
    code=$(curl -sS -o nova.out -w '%{http_code}' --unix-socket v.sock -d '{"v":1,"text":"Hi.","voice":"nova"}' http://voice/v1/voice/tts)
    [ "$code" = 400 ] && jq -e '.error.code == "bad_request"' nova.out > /dev/null || fail "an unknown voice: $code"

    # Dutch with Supertonic (NX-476…NX-478): a WAV at its 44.1 kHz, at -3 dBFS, that Parakeet hears in Dutch, from a man's
    # voice too; a language the service doesn't speak is 400.
    call -d '{"v":1,"text":"Ja, P V E nul twee draait prima. De back-up was om drie uur klaar.","voice":"heart","language":"nl"}' \
      http://voice/v1/voice/tts | jq -r .audioWav | base64 -d > dutch.wav
    [ "$(sox --i -r dutch.wav)" = 44100 ] && [ "$(sox --i -c dutch.wav)" = 1 ] || fail "the Dutch answer is not 44.1 kHz mono"
    # The loudest sample either way (it may be a trough): sox's maximum and minimum.
    dpeak=$(sox dutch.wav -n stat 2>&1 | awk '/(Maximum|Minimum) amplitude/ { v = $3 < 0 ? -$3 : $3; if (v > p) p = v } END { print p }')
    awk -v p="$dpeak" 'BEGIN { exit !(p > 0.69 && p < 0.72) }' || fail "the Dutch answer's peak is $dpeak, not -3 dBFS"
    sox dutch.wav -r 16000 -c 1 -b 16 dutch16.wav
    printf '{"v":1,"audioWav":"%s"}' "$(base64 -w0 dutch16.wav)" > dutch.json
    dutch=$(call -d @dutch.json http://voice/v1/voice/stt | jq -r .text | tr 'A-Z' 'a-z')
    echo "dutch heard: $dutch"
    case "$dutch" in *draait*prima*) ;; *) fail "the Dutch words not heard: $dutch" ;; esac
    call -d '{"v":1,"text":"Het is klaar.","voice":"george","language":"nl"}' http://voice/v1/voice/tts | jq -e '.audioWav | length > 1000' > /dev/null \
      || fail "a man's voice in Dutch"
    code=$(curl -sS -o de.out -w '%{http_code}' --unix-socket v.sock -d '{"v":1,"text":"Hallo.","language":"de"}' http://voice/v1/voice/tts)
    [ "$code" = 400 ] && jq -e '.error.code == "bad_request"' de.out > /dev/null || fail "an unknown language: $code"

    # Voice typing: 40 s of speech (the two sentences, again and again) cut at its pauses into two pieces, heard by Whisper.
    sox -n -r 16000 -c 1 -b 16 pause.wav trim 0 0.6
    args=""; for _ in 1 2 3 4 5 6 7 8 9 10; do args="$args speech.wav pause.wav emma16.wav pause.wav"; done
    sox $args long.wav
    long=$(sox --i -D long.wav); echo "long: $long s"
    printf '{"v":1,"model":"whisper","language":"en","audioWav":"%s"}' "$(base64 -w0 long.wav)" > typing.json
    call -d @typing.json http://voice/v1/voice/transcribe > typed.json
    echo "typed: $(jq -c '{model, seconds, gpu, parts: (.parts | length)}' typed.json)"
    jq -e '.model == "whisper" and .gpu == false and .seconds >= 30 and (.parts | length) >= 1' typed.json > /dev/null || fail "voice typing's answer"
    typed=$(jq -r '.parts | join(" ")' typed.json | tr 'A-Z' 'a-z')
    [ "$(grep -o finished <<< "$typed" | wc -l)" -ge 8 ] || fail "not every sentence heard: $typed"
    printf '{"v":1,"model":"auto","language":"auto","audioWav":"%s"}' "$(base64 -w0 silence.wav)" > quiet2.json
    call -d @quiet2.json http://voice/v1/voice/transcribe | jq -e '.parts == []' > /dev/null || fail "silence typed"

    # Refused: not 16 kHz (the 24 kHz answer).
    printf '{"v":1,"audioWav":"%s"}' "$(base64 -w0 answer.wav)" > wrong.json
    code=$(curl -sS -o wrong.out -w '%{http_code}' --unix-socket v.sock -d @wrong.json http://voice/v1/voice/stt)
    [ "$code" = 400 ] && jq -e '.error.code == "bad_audio"' wrong.out > /dev/null || fail "24 kHz speech: $code"

    [ -z "$(ls -A jobs)" ] || fail "job files left: $(ls -A jobs)"
    touch $out
  ''
