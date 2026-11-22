# The voice service's and the model fetcher's units (NX-175…NX-184, NX-470…NX-475) on a small VM with just the accounts
# and the voice module (no runtime, no appliance storage: the units depend on neither):
#   - the sockets are systemd's, 0660 <service>:whombat; the voice service starts only when asked, the fetcher at boot
#   - the server's user (whombat) and root get in; the runner can't open the sockets, and a member of the group that
#     isn't the server is refused by the peer checks (403)
#   - no speech model in the image: the health says no speech to text until the fetcher has downloaded one (from a
#     source on the machine itself: Whisper tiny.en standing in for large-v3-turbo), which it checks and puts where the
#     voice service reads it (2750/0640, the voice service's group) and can't write
#   - in its full sandbox (no network, AF_UNIX only, MemoryDenyWriteExecute, the syscall filter, a private /tmp, of
#     /persist only the models) Kokoro says “Is pve two okay?” as a valid WAV and Whisper hears the words in it, for the
#     desk and as voice typing; no graphics chip in the VM, so the processor
#   - a download that can't reach its source waits, survives a restart of the fetcher and finishes once it can; Remove
#     deletes the model
#   - nothing of a job is left in its /tmp, the voice service has no network interface but lo, and the journal has no
#     words heard
#   - with a sound card the sound server holds (an emulated HD-Audio card, system-wide PipeWire: HD-04, NX-255), the
#     health still says there is a microphone and a speaker (/proc/asound/pcm, NX-179)
{ pkgs, ... }:
let
  socket = "/run/whombat-voice/voice.sock";
  modelsSocket = "/run/whombat-voice-models/models.sock";
  model = pkgs.voice-test-whisper;
  file = "ggml-tiny.en-q5_1.bin";
  supertonicStub = pkgs.writeText "supertonic-stub" "model";
  supertonicNames = [
    "duration_predictor.int8.onnx"
    "text_encoder.int8.onnx"
    "vector_estimator.int8.onnx"
    "vocoder.int8.onnx"
    "tts.json"
    "unicode_indexer.bin"
    "voice.bin"
    "LICENSE"
  ];
  source = pkgs.linkFarm "voice-model-source" (
    [
      {
        name = file;
        path = model;
      }
    ]
    ++ map (name: {
      name = "supertonic/${name}";
      path = supertonicStub;
    }) supertonicNames
  );
  manifest = pkgs.writeText "voice-test-models.json" (
    builtins.toJSON {
      models = [
        {
          id = "whisper";
          inherit file;
          url = "http://127.0.0.1:8099/${file}";
          size = 32166155;
          sha256 = "c77c5766f1cef09b6b7d47f21b546cbddd4157886b3b5d6d4f709e91e66c7c2b";
        }
        {
          id = "supertonic";
          dir = "supertonic-3-int8";
          files = map (name: {
            inherit name;
            url = "http://127.0.0.1:8099/supertonic/${name}";
            size = 5;
            sha256 = "9372c470eeadd5ecd9c3c74c2b3cb633f8e2f2fad799250a0f70d652b6b825e4";
          }) supertonicNames;
        }
      ];
    }
  );
  tools = with pkgs; [
    coreutils
    curl
    jq
    sox
  ];
  roundTrip = pkgs.writeShellScript "voice-round-trip" ''
    set -euo pipefail
    export PATH=${pkgs.lib.makeBinPath tools}
    cd "$1"
    call() { curl -sS --fail-with-body --unix-socket ${socket} -H 'Content-Type: application/json' "$@"; }
    call -d '{"v":1,"text":"Is pve two okay?"}' http://voice/v1/voice/tts | jq -r .audioWav | base64 -d > answer.wav
    [ "$(sox --i -r answer.wav)" = 24000 ] && [ "$(sox --i -c answer.wav)" = 1 ] && [ "$(sox --i -b answer.wav)" = 16 ]
    sox answer.wav -r 16000 -c 1 -b 16 speech.wav
    printf '{"v":1,"prompt":"pve-02","model":"whisper","language":"en","audioWav":"%s"}' "$(base64 -w0 speech.wav)" > stt.json
    call -d @stt.json http://voice/v1/voice/stt | jq -r .text
    sox -n -r 16000 -c 1 -b 16 pause.wav trim 0 0.5
    sox speech.wav pause.wav speech.wav pause.wav speech.wav typing.wav
    printf '{"v":1,"model":"auto","language":"en","prompt":"pve-02","audioWav":"%s"}' "$(base64 -w0 typing.wav)" > typing.json
    call -d @typing.json http://voice/v1/voice/transcribe | jq -r '"\(.model) \(.gpu) \(.parts | join(" "))"'
  '';
in
{
  name = "whombat-voice";

  nodes.machine =
    { lib, ... }:
    {
      imports = [
        ../nix/modules/options.nix
        ../nix/modules/users.nix
        ../nix/modules/voice.nix
        ../nix/modules/sound.nix
      ];
      whombat.voice.enable = true;
      whombat.voice.models.manifest = manifest;
      whombat.sound.enable = true;
      virtualisation.qemu.options = [
        "-audiodev none,id=snd0"
        "-device intel-hda"
        "-device hda-duplex,audiodev=snd0"
      ];
      # The build sandbox has no /dev/kvm on the build machine (nixbld isn't in the kvm group): under TCG a job takes minutes.
      whombat.voice.timeouts = {
        stt = 900;
        tts = 600;
      };
      # The models' source: on the machine itself (it serves whole files only; the fetcher starts over then).
      systemd.services.model-source = {
        wantedBy = [ "multi-user.target" ];
        serviceConfig.ExecStart = "${pkgs.python3}/bin/python3 -m http.server 8099 --bind 127.0.0.1 --directory ${source}";
      };
      # A member of the sockets' group that isn't the server: the peer checks' case.
      users.users.intruder = {
        isNormalUser = true;
        extraGroups = [ "whombat" ];
      };
      environment.systemPackages = [
        pkgs.curl
        pkgs.jq
        pkgs.psmisc
      ];
      virtualisation.memorySize = 3072;
      virtualisation.cores = 4;
    };

  testScript = ''
    import json

    sock = "${socket}"
    msock = "${modelsSocket}"
    health = f"curl -sS --unix-socket {sock} http://voice/v1/voice/health"
    state = f"curl -sS --unix-socket {msock} http://models/v1/voice-models"
    state_all = f"curl -sS --unix-socket {msock} 'http://models/v1/voice-models?include=supertonic'"
    def ask(path, model="whisper"):
        return f"curl -sS --fail-with-body --unix-socket {msock} -d '{{\"v\":1,\"model\":\"{model}\"}}' http://models/v1/voice-models/{path}"
    def model_state(model="whisper"):
        cmd = state_all if model == "supertonic" else state
        ms = json.loads(machine.succeed(f"runuser -u whombat -- {cmd}"))["models"]
        return next(m for m in ms if m["id"] == model)

    machine.wait_for_unit("sockets.target")
    machine.wait_for_unit("whombat-voice.socket")
    machine.wait_for_unit("whombat-voice-models.service")
    t.assertEqual(machine.succeed(f"stat -c '%a %U %G' {sock}").strip(), "660 whombat-voice whombat")
    t.assertEqual(machine.succeed(f"stat -c '%a %U %G' {msock}").strip(), "660 whombat-voice-models whombat")
    t.assertEqual(machine.succeed("stat -c '%a %U %G' /persist/voice-models").strip(), "2750 whombat-voice-models whombat-voice")
    machine.fail("systemctl is-active whombat-voice.service")

    with subtest("the server's user and root get in, nobody else"):
        # The card is the sound server's (it runs as pipewire, in the audio group); the kernel's list still has it.
        machine.wait_for_unit("wireplumber.service")
        machine.wait_until_succeeds("fuser -s /dev/snd/controlC0", timeout=60)
        h = json.loads(machine.succeed(f"runuser -u whombat -- {health}"))
        # No speech model in the image: no speech to text until one is downloaded; English only until Dutch is downloaded.
        t.assertEqual([h["v"], h["stt"], h["tts"], h["microphone"], h["speaker"], h["languages"]], [1, False, True, True, True, ["en"]])
        assert "models" not in h and "gpu" not in h, h
        machine.succeed("systemctl is-active whombat-voice.service")
        for s in (health, state):
            machine.fail(f"runuser -u whombat-runner -- {s}")
            out = machine.succeed(f"runuser -u intruder -- {s} -w ' %{{http_code}}'")
            assert out.endswith(" 403") and "forbidden" in out, out

    with subtest("the fetcher downloads the model, checks it, and the voice service reads it"):
        t.assertEqual(model_state()["state"], "absent")
        machine.succeed(f"runuser -u whombat -- {ask('fetch')}")
        machine.wait_until_succeeds(f"runuser -u whombat -- {state} | jq -e '.models[0].state == \"ready\"'", timeout=300)
        t.assertEqual(machine.succeed("stat -c '%a %U %G %s' /persist/voice-models/${file}").strip(), "640 whombat-voice-models whombat-voice 32166155")
        h = json.loads(machine.succeed(f"runuser -u whombat -- {health}"))
        assert h["stt"] and h["models"] == ["whisper"] and "gpu" not in h, h

    with subtest("speech round trip in the unit's sandbox, for the desk and as voice typing"):
        machine.succeed("install -d -o whombat -g whombat -m 0700 /tmp/rt")
        heard, typed = machine.succeed("runuser -u whombat -- ${roundTrip} /tmp/rt", timeout=3600).strip().splitlines()
        print(f"heard: {heard!r}, typed: {typed!r}")
        words = "".join(c for c in heard.lower() if c.isalnum())
        assert "pve" in words and ("2" in words or "two" in words) and "ok" in words, heard
        model, gpu, text = typed.split(" ", 2)
        assert model == "whisper" and gpu == "false" and text.lower().count("ok") >= 3, typed

    with subtest("each service has only what it needs"):
        pid = machine.succeed("systemctl show -P MainPID whombat-voice").strip()
        t.assertEqual(machine.succeed(f"nsenter -t {pid} -m ls -A /tmp").strip(), "")
        links = machine.succeed(f"nsenter -t {pid} -n ip -o link").strip().splitlines()
        assert len(links) == 1 and ": lo:" in links[0], links
        t.assertEqual(machine.succeed(f"ps -o user= -p {pid}").strip(), "whombat-voice")
        t.assertEqual(machine.succeed("systemctl show -P MemoryMax whombat-voice").strip(), "2147483648")
        # Of /persist the models only, read only.
        machine.succeed("install -d -m 0755 /persist/elsewhere && touch /persist/elsewhere/secret")
        machine.fail(f"nsenter -t {pid} -m test -e /persist/elsewhere/secret")
        machine.succeed(f"nsenter -t {pid} -m test -r /persist/voice-models/${file}")
        machine.fail(f"nsenter -t {pid} -m -S 966 -G 966 touch /persist/voice-models/x")
        fpid = machine.succeed("systemctl show -P MainPID whombat-voice-models").strip()
        t.assertEqual(machine.succeed(f"ps -o user= -p {fpid}").strip(), "whombat-voice-models")
        machine.fail(f"nsenter -t {fpid} -m test -e /persist/elsewhere/secret")
        machine.fail(f"nsenter -t {fpid} -m test -e {sock}")
        journal = machine.succeed("journalctl -u whombat-voice -o cat")
        print(journal)
        assert "stt:" in journal and "transcribe:" in journal and "tts:" in journal, journal
        assert "pve" not in journal.lower() and "okay" not in journal.lower(), journal

    with subtest("multi-file Dutch model downloads into its directory, activates Dutch dynamically, and removes cleanly"):
        # Plain v1 state keeps speech-recognition models only so a rolled-back runtime still parses it.
        plain_ids = [m["id"] for m in json.loads(machine.succeed(f"runuser -u whombat -- {state}"))["models"]]
        t.assertEqual(plain_ids, ["whisper"])
        t.assertEqual(model_state("supertonic")["state"], "absent")
        machine.succeed(f"runuser -u whombat -- {ask('fetch', 'supertonic')}")
        machine.wait_until_succeeds(
            f"runuser -u whombat -- {state_all} | jq -e '.models[] | select(.id == \"supertonic\") | .state == \"ready\"'",
            timeout=120,
        )
        t.assertEqual(
            machine.succeed("stat -c '%a %U %G %s' /persist/voice-models/supertonic-3-int8/LICENSE").strip(),
            "640 whombat-voice-models whombat-voice 5",
        )
        pid = machine.succeed("systemctl show -P MainPID whombat-voice").strip()
        machine.succeed(f"nsenter -t {pid} -m -S 966 -G 966 test -r /persist/voice-models/supertonic-3-int8/LICENSE")
        h = json.loads(machine.succeed(f"runuser -u whombat -- {health}"))
        t.assertEqual(h["languages"], ["en", "nl"])
        t.assertEqual(h["models"], ["whisper"])
        machine.succeed(f"runuser -u whombat -- {ask('remove', 'supertonic')}")
        machine.fail("test -e /persist/voice-models/supertonic-3-int8")
        h = json.loads(machine.succeed(f"runuser -u whombat -- {health}"))
        t.assertEqual(h["languages"], ["en"])

    with subtest("Remove deletes it; a download that can't reach its source waits, and carries on after a restart"):
        machine.succeed(f"runuser -u whombat -- {ask('remove')}")
        machine.fail("test -e /persist/voice-models/${file}")
        assert not json.loads(machine.succeed(f"runuser -u whombat -- {health}"))["stt"]
        machine.succeed("systemctl stop model-source")
        machine.succeed(f"runuser -u whombat -- {ask('fetch')}")
        machine.wait_until_succeeds(f"runuser -u whombat -- {state} | jq -e '.models[0].state == \"waiting\" and .models[0].problem == \"no_network\"'", timeout=60)
        machine.succeed("systemctl restart whombat-voice-models")
        machine.wait_for_unit("whombat-voice-models.service")
        t.assertEqual(model_state()["state"], "waiting")
        machine.succeed("systemctl start model-source")
        machine.wait_until_succeeds(f"runuser -u whombat -- {state} | jq -e '.models[0].state == \"ready\"'", timeout=300)
        machine.succeed("test -s /persist/voice-models/${file}")
  '';
}
