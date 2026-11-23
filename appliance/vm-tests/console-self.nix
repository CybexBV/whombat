# The console on tty1 and self-provisioning (CC-08, CC-10, CG-01…CG-09; NX-32, NX-33, NX-78, NX-82), two appliance VMs:
#   - machine (a display, std VGA): tty1 is the graphical console (the kiosk: cage + Chromium as whombat-kiosk), not a
#     getty and not the text console; its server runs as whombat-console in a network namespace only the kiosk joins
#     (no other process reaches it, the kiosk reaches no network); the API needs the per-start token, which only the
#     kiosk's group reads; the claim screens and the claimed screen with the burrow's name are read from the screen
#     with OCR (no recovery key screen, CG-31), and `whombat-console --once --json` says what the API says; the API
#     only reads; a restarted server restarts the kiosk with its new token; a keyboard and a mouse plugged in later work
#     in the running kiosk (whombat-kiosk-udev passes their udev events into its namespace: no restart, the page reads
#     a PIN typed on that keyboard); three kiosk crashes in a row give tty1 to the text console
#   - an unprovisioned appliance with whombat.provisioning.selfRegister provisions itself at boot with its own identity
#     (Whombat LNK-01: control hears of a box only when its owner turns Whombat Link on, so the fake control records
#     nothing): model self-installed, claim.json without a card secret, no cards and no disk recovery key (PI-19,
#     NX-90); the factory tuple is recorded like a factory medium's (MG-20); a request for new keys is dropped and the
#     identity stays (there is nothing at control to register again)
#   - the runtime's state file: its directory gives it the group whombat-console; the console reads it, the runner and
#     the manager can't; a crafted file shows the starting screen; a stopped server removes the file
#   - headless (no display: -vga none): the kiosk finds no DRM device and gives up within 15 s, and the text console
#     draws tty1 as before (CG-05): the starting screen and the banner, claimable/backoff/claimed, a crafted file; N on
#     the claim screen asks the runtime's desk socket for new letters and no other key does; tty2
#     keeps the getty banner
#   - the desk display (NX-160…NX-167) with a fake runtime desk socket: only the runtime's uid is believed and only the
#     console's server can connect; the API's `desk` and `--once --json` agree; the page's requests reach the socket as
#     the contract's; at night with “Black” the kiosk sleeps a minute after the last input and a key wakes it, the end of
#     the quiet hours wakes it, the day and “Dim” never sleep; a VM's kiosk draws in software; logind and UPower as
#     power.nix sets them (no suspend, the lid ignored, a VM's power button still powers off); the kiosk's session gets the
#     sound card (an emulated HDA)
#   - the hardware report (HD-03, MG-110…MG-114): the manager reads this VM's devices (the HDA card with its capture and
#     playback devices, bochs and its connector, virtio network and disk) and gets the kernel's lines from the helper,
#     for the runtime's uid only, without a MAC address
#   - the sound server (HD-04, NX-255): system-wide PipeWire has the HDA card's microphone (a source that isn't a
#     monitor) and speaker as its defaults, the kiosk's user reaches them through the PulseAudio socket from the kiosk's
#     own namespaces and records through it, nobody outside the group does, and the page's chime for a new ask plays
#     through it
{
  applianceModules,
  lib,
  pkgs,
  ...
}:
let
  # The runtime's side of the desk socket (Whombat DK-12), as a fake: the state the test writes to /run/desk-fake/state.json,
  # `{v: 1}` for a lock, a wrong PIN for an unlock; every request is logged to /run/desk-fake/requests.
  deskFake = pkgs.writeText "desk-fake.py" ''
    import http.server, os, socketserver, sys
    SOCK = sys.argv[1]
    class H(http.server.BaseHTTPRequestHandler):
        def answer(self, body, status=200):
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        def do_GET(self):
            if self.path == "/v1/desk/state":
                with open("/run/desk-fake/state.json", "rb") as f:
                    self.answer(f.read())
            else:
                self.answer(b'{"error":{"code":"not_found","message":"no"}}', 404)
        def do_POST(self):
            req = self.rfile.read(int(self.headers.get("Content-Length", "0")))
            with open("/run/desk-fake/requests", "ab") as f:
                f.write(self.path.encode() + b" " + req + b"\n")
            if self.path in ("/v1/desk/lock", "/v1/desk/claim/letters"):
                self.answer(b'{"v":1}')
            elif self.path == "/v1/desk/unlock":
                self.answer(b'{"v":1,"result":"wrong","triesLeft":4}')
            else:
                self.answer(b'{"error":{"code":"locked","message":"locked"}}', 409)
        def address_string(self):
            return "desk"
        def log_message(self, *args):
            pass
    class S(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
        daemon_threads = True
    try:
        os.unlink(SOCK)
    except FileNotFoundError:
        pass
    os.umask(0o117)
    S(SOCK, H).serve_forever()
  '';
in
{
  name = "whombat-console-self";
  enableOCR = true;

  nodes = {
    control =
      { pkgs, ... }:
      {
        imports = [ ./common/control.nix ];
        systemd.services.fake-control.serviceConfig.ExecStart =
          lib.mkForce "${pkgs.whombat-provision}/bin/whombat-fake-control --listen 0.0.0.0:4600 --token-file /etc/whombat-fake-control/token --env dev --self-registration";
      };
    machine =
      { pkgs, ... }:
      {
        imports = applianceModules ++ [ (import ./common/appliance-vm.nix { serial = "SN-SELF-0001"; }) ];
        whombat.console.gui = true;
        virtualisation.memorySize = 3072;
        # A sound card (NX-163): the kiosk's session must get it from logind.
        virtualisation.qemu.options = [
          "-audiodev none,id=snd0"
          "-device intel-hda"
          "-device hda-duplex,audiodev=snd0"
        ];
        environment.systemPackages = [ pkgs.procps ];
        whombat.provisioning = {
          factoryMedium = false;
          selfRegister = true;
          selfRequireSecureBoot = false;
          selfFactoryRelease = "rt-fixture-1";
          selfSeedHelper = false;
        };
      };
    headless = {
      imports = applianceModules ++ [ (import ./common/appliance-vm.nix { serial = "SN-SELF-0002"; }) ];
      whombat.console.gui = true;
      # No graphics card at all: no DRM device, so the kiosk gives tty1 to the text console.
      virtualisation.qemu.options = [ "-vga none" ];
    };
  };

  testScript =
    { nodes, ... }:
    let
      console = "${nodes.machine.whombat.console.package}/bin/whombat-console";
      footer = pkgs.writeText "whombat-console-footer" nodes.machine.whombat.console.footer;
      runtimeUid = toString nodes.machine.whombat.ids.whombat;
      pulse = nodes.machine.whombat.sound.pulseServer;
    in
    ''
      import json
      import shlex
      import time

      ${builtins.readFile ./common/pointer.py}

      def sh(m, cmd):
          return m.succeed(cmd).strip()

      def write_state(m, doc):
          # As the runtime does it: a temporary file in the same directory, 0640 (its UMask is 0077), rename.
          m.succeed(
              "runuser -u whombat -- sh -c 'umask 077; cat > /run/whombat/console/.console.json.tmp"
              " && chmod 0640 /run/whombat/console/.console.json.tmp"
              " && mv /run/whombat/console/.console.json.tmp /run/whombat/console/console.json' <<'EOF'\n"
              + doc + "\nEOF"
          )

      def in_server_ns(cmd):
          pid = sh(machine, "systemctl show -P MainPID whombat-console-server")
          return f"nsenter -t {pid} -n {cmd}"

      def api(path="/api/state", token=True):
          auth = "-H \"Authorization: Bearer $(cat /run/whombat-console-ui/token)\"" if token else ""
          return machine.succeed(in_server_ns(f"curl -s -w '\\n%{{http_code}}' {auth} http://127.0.0.1:8411{path}")).strip()

      def api_state():
          body, code = api().rsplit("\n", 1)
          assert code == "200", (code, body)
          return json.loads(body)

      def once_json():
          # Match the services' storage-specific footer, not the CLI's built-in LUKS default (NX-90), and the server's
          # desk socket (NX-160).
          return json.loads(machine.succeed(
              "runuser -u whombat-console -- ${console} --once --json --file /run/whombat/console/console.json"
              " --footer-file ${footer} --desk-socket /run/whombat/console/desk.sock --desk-peer-uid ${runtimeUid}"
          ))

      def api_post(path, body):
          out = machine.succeed(in_server_ns(
              "curl -s -w '\\n%{http_code}' -X POST -H 'Content-Type: application/json' -d " + shlex.quote(body)
              + " -H \"Authorization: Bearer $(cat /run/whombat-console-ui/token)\" http://127.0.0.1:8411" + path
          )).strip()
          b, code = out.rsplit("\n", 1)
          return int(code), json.loads(b) if b else None

      def desk_state(quiet=False, night="dim", asks=0):
          return json.dumps({
              "v": 1, "now": "2026-10-20T09:41:00Z",
              "paired": {"person": {"name": "John", "initial": "J", "tone": 2},
                         "assistant": {"name": "Neo", "face": "neo"}, "timeZone": "Europe/Amsterdam",
                         "lockedView": "summary", "night": night, "quiet": quiet, "voice": False, "hasPin": True},
              "pairing": None, "lock": {"state": "locked"},
              "glance": {"status": {"text": "1 thing needs you." if asks else "Everything’s fine."},
                         "needsYou": {"count": asks, "items": []}, "working": None,
                         "done": [], "servers": [{"name": "pve-02", "mark": "proxmox", "state": "ok", "note": "up 41 d"}],
                         "moreServers": 0, "tiles": []},
              "power": None, "talk": None,
          })

      def set_desk(doc):
          # The fake runs as the runtime's user and logs the requests here; the state is the test's (root's).
          machine.succeed("install -d -m 0755 -o whombat -g whombat /run/desk-fake && cat > /run/desk-fake/state.json.tmp <<'EOF'\n" + doc
                          + "\nEOF\nchmod 0644 /run/desk-fake/state.json.tmp && mv /run/desk-fake/state.json.tmp /run/desk-fake/state.json")

      def kiosk_pa(tool):
          # A PulseAudio tool as the kiosk's user inside the kiosk's mount and network namespaces.
          cage = sh(machine, "pgrep -u whombat-kiosk -x .cage-wrapped")
          return f"nsenter -t {cage} -m -n -- runuser -u whombat-kiosk -- env PULSE_SERVER=${pulse} ${pkgs.pulseaudio}/bin/{tool}"

      def chromium_up():
          return machine.execute("pgrep -u whombat-kiosk -f 'type=renderer'")[0] == 0

      def agree():
          # The text console's view and the API are the same validated state (the server's clock aside).
          a, b = api_state(), once_json()
          a.pop("now"); b.pop("now")
          assert a == b, (a, b)
          return a

      def kiosk_cpu(label, secs=20):
          q = "awk '/^usage_usec/{print $2}' /sys/fs/cgroup/user.slice/user-$(id -u whombat-kiosk).slice/cpu.stat"
          a = int(sh(machine, q)); time.sleep(secs); b = int(sh(machine, q))
          print(f"kiosk CPU on the {label} screen: {(b - a) / 1e6 / secs * 100:.1f} % of one core")

      start_all()
      control.wait_for_unit("fake-control.service")
      control.wait_for_open_port(4600)

      with subtest("headless: no DRM device, the text console takes tty1 (CG-05)"):
          headless.wait_for_unit("multi-user.target")
          headless.wait_until_succeeds("systemctl is-active whombat-console.service", timeout=120)
          assert sh(headless, "systemctl show -P Result whombat-kiosk") == "exit-code", sh(headless, "systemctl status whombat-kiosk || true")
          assert sh(headless, "systemctl show -P NRestarts whombat-kiosk") == "0"
          # The kiosk's own lines carry its identifier (logind moved its processes into the session's scope).
          headless.succeed("journalctl -t whombat-kiosk --no-pager | grep -q 'no display (no DRM device after 15 s)'")
          headless.fail("ls /dev/dri/card*")
          headless.fail("systemctl is-active getty@tty1.service autovt@tty1.service")
          headless.wait_until_tty_matches("1", "Starting Whombat")
          headless.wait_until_tty_matches("1", "hold Space")

      with subtest("headless: the text console's screens, as before"):
          write_state(headless, '{"v":1,"state":"claimable","code":"KXQM","url":"https://dev.whombat.com/claim"}')
          headless.wait_until_tty_matches("1", "Claim this Whombat")
          headless.wait_until_tty_matches("1", "open dev.whombat.com/claim and")
          headless.wait_until_tty_matches("1", "KXQM")
          # The claim link at the box's own address comes with a second way in, last on the screen.
          write_state(headless, '{"v":1,"state":"claimable","code":"KXQM","url":"https://quiet-river-otter.box.whombat.app/c/kxqmtv","fallbackUrl":"http://192.0.2.10:4480/"}')
          headless.wait_until_tty_matches("1", "open quiet-river-otter.box.whombat.app/c/kxqmtv")
          headless.wait_until_tty_matches("1", r"open: in the Whombat app on this network, type\s+192\.0\.2\.10\.")
          headless.wait_until_tty_matches("1", "KXQM")
          retry = sh(headless, "date -u -d '+5 min' +%Y-%m-%dT%H:%M:%SZ")
          write_state(headless, '{"v":1,"state":"backoff","url":"https://dev.whombat.com/claim","retryAt":"' + retry + '"}')
          headless.wait_until_tty_matches("1", "Too many wrong codes. Try again in [45] min.")
          write_state(headless, '{"v":1,"state":"claimed","url":"https://dev.whombat.com/claim","burrows":{"first":"Banjo’s Burrow","more":2}}')
          headless.wait_until_tty_matches("1", "This Whombat is set up.")
          write_state(headless, '{"v":1,"state":"claimable","code":"KXQM\\u001b[2J","url":"https://dev.whombat.com/claim"}')
          headless.wait_until_tty_matches("1", "Starting Whombat")
          headless.send_key("alt-f2")
          headless.wait_until_tty_matches("2", "There is no login on this console")
          headless.send_key("alt-f1")
          headless.wait_until_tty_matches("1", "Starting Whombat")

      with subtest("headless: N on the claim screen asks the runtime for new letters, no other key does"):
          # The text console's one address family is AF_UNIX, for the desk socket; it still has no network.
          assert sh(headless, "systemctl show -P RestrictAddressFamilies whombat-console") == "AF_UNIX"
          assert sh(headless, "systemctl show -P PrivateNetwork whombat-console") == "yes"
          headless.succeed("install -d -m 0755 -o whombat -g whombat /run/desk-fake")
          headless.succeed("systemd-run --unit=desk-fake-letters --uid=whombat --gid=whombat ${pkgs.python3}/bin/python3 ${deskFake} /run/whombat/console/desk.sock")
          headless.wait_until_succeeds("test -S /run/whombat/console/desk.sock")
          lan = '{"v":1,"state":"claimable","code":"KXQM","url":"http://192.0.2.10:4480/"'
          write_state(headless, lan + ',"newLetters":true}')
          headless.wait_until_tty_matches("1", "type 192.0.2.10 and enter")
          headless.wait_until_tty_matches("1", "Press N for new letters")
          headless.send_key("x")
          headless.send_key("n")
          headless.wait_until_succeeds("grep -qxF '/v1/desk/claim/letters {\"v\":1}' /run/desk-fake/requests", timeout=20)
          assert sh(headless, "wc -l < /run/desk-fake/requests") == "1", sh(headless, "cat /run/desk-fake/requests")
          # The runtime's answer is new letters that stay: the screen says for how long.
          until = sh(headless, "date -u -d '+10 min' +%Y-%m-%dT%H:%M:%SZ")
          write_state(headless, lan.replace("KXQM", "PRTV") + ',"newLetters":true,"lettersUntil":"' + until + '"}')
          headless.wait_until_tty_matches("1", "These letters stay for (9|10) min")
          headless.wait_until_tty_matches("1", "PRTV")
          # The wait offers it too.
          retry = sh(headless, "date -u -d '+5 min' +%Y-%m-%dT%H:%M:%SZ")
          write_state(headless, '{"v":1,"state":"backoff","url":"http://192.0.2.10:4480/","retryAt":"' + retry + '","newLetters":true}')
          headless.wait_until_tty_matches("1", "Or press N for new letters now")
          headless.send_key("n")
          headless.wait_until_succeeds("test \"$(wc -l < /run/desk-fake/requests)\" = 2", timeout=20)
          # Not offered (a box claimed elsewhere, a runtime from before): N is dropped like every key.
          write_state(headless, '{"v":1,"state":"claimable","code":"KXQM","url":"https://dev.whombat.com/claim"}')
          headless.wait_until_tty_matches("1", "open dev.whombat.com/claim and")
          headless.send_key("n")
          time.sleep(3)
          assert sh(headless, "wc -l < /run/desk-fake/requests") == "2", sh(headless, "cat /run/desk-fake/requests")
          # Both requests were answered: the console logged no failure.
          headless.fail("journalctl -u whombat-console --no-pager | grep -i 'new letters:'")
          headless.succeed("systemctl stop desk-fake-letters && rm -f /run/whombat/console/desk.sock")
          headless.shutdown()

      machine.wait_for_unit("multi-user.target")

      with subtest("tty1 is the graphical console: the kiosk, not a getty or the text console"):
          machine.wait_for_unit("whombat-console-server.service")
          machine.wait_for_unit("whombat-kiosk.service")
          assert sh(machine, "systemctl show -P User whombat-console-server") == "whombat-console"
          assert sh(machine, "systemctl show -P User whombat-kiosk") == "whombat-kiosk"
          for unit in ["getty@tty1.service", "autovt@tty1.service", "whombat-console.service"]:
              machine.fail(f"systemctl is-active {unit}")
          # A logind session of whombat-kiosk on seat0, VT 1, holding the display; cage and Chromium in it.
          sessions = sh(machine, "loginctl list-sessions --no-legend")
          print(sessions)
          assert "whombat-kiosk seat0" in sessions and "tty1" in sessions, sessions
          machine.wait_until_succeeds("pgrep -u whombat-kiosk -x .cage-wrapped")
          machine.wait_until_succeeds("pgrep -u whombat-kiosk -f 'chromium.*--app=http://127.0.0.1:8411/'")
          machine.wait_for_text("Starting Whombat", timeout=180)
          machine.screenshot("gui-first")
          # A VM's display (bochs) is no real graphics chip: cage with pixman, Chromium without the GPU (NX-161).
          cage = sh(machine, "pgrep -u whombat-kiosk -x .cage-wrapped")
          env = machine.succeed(f"tr '\\0' '\\n' < /proc/{cage}/environ")
          assert "WLR_RENDERER=pixman" in env and "WHOMBAT_KIOSK_RENDER=software" in env, env
          # A cage that started before udevd had finished the input devices didn't fail for it (NX-405).
          assert "WLR_LIBINPUT_NO_DEVICES=1" in env, env
          # cage and Chromium draw no pointer of their own (CG-410; this VM's tablet is a mouse, so both would show one):
          # their theme's every cursor is one transparent pixel (a 68-byte Xcursor file). The page draws its own.
          themes = sh(machine, f"tr '\\0' '\\n' < /proc/{cage}/environ | sed -n 's/^XCURSOR_PATH=//p'")
          assert "whombat-no-pointer" in themes, env
          assert "XCURSOR_THEME=default" in env, env
          for name in ["left_ptr", "default", "pointer", "text", "progress", "hand2", "xterm"]:
              assert sh(machine, f"stat -L -c %s {themes}/default/cursors/{name}") == "68", name
          assert sh(machine, f"tail -c 4 {themes}/default/cursors/left_ptr | od -An -tx1").split() == ["00"] * 4
          browser = sh(machine, "pgrep -o -u whombat-kiosk -f 'chromium.*--app=http://127.0.0.1:8411/'")
          assert f"XCURSOR_PATH={themes}" in machine.succeed(f"tr '\\0' '\\n' < /proc/{browser}/environ")
          machine.fail("journalctl -t whombat-kiosk --no-pager | grep -q 'libinput initialization failed'")
          print(f"kiosk restarts since boot: {sh(machine, 'systemctl show -P NRestarts whombat-kiosk')}")
          machine.succeed("pgrep -u whombat-kiosk -f 'chromium.*--disable-gpu --force-prefers-reduced-motion'")
          machine.fail("journalctl -t whombat-kiosk --no-pager | grep -q 'drawing with the graphics chip'")
          # cage turns its display through wlr-output-management, as `transform` does for a portrait panel (NX-164); a
          # landscape display is left as it is.
          wl = sh(machine, "cd /run/whombat-kiosk && ls -1 wayland-* | grep -v '\\.lock$' | head -1")
          randr = f"runuser -u whombat-kiosk -- env XDG_RUNTIME_DIR=/run/whombat-kiosk WAYLAND_DISPLAY={wl} ${pkgs.wlr-randr}/bin/wlr-randr"
          outputs = json.loads(machine.succeed(f"{randr} --json"))
          screen = [o for o in outputs if o["enabled"]][0]
          assert screen["transform"] == "normal", outputs
          machine.succeed(f"{randr} --output {screen['name']} --transform 90")
          assert [o for o in json.loads(machine.succeed(f"{randr} --json")) if o["enabled"]][0]["transform"] == "90"
          machine.succeed(f"{randr} --output {screen['name']} --transform normal")
          machine.fail("journalctl -t whombat-kiosk --no-pager | grep -q 'is turned'")

      with subtest("sound: logind gives the kiosk's session the sound card (NX-163)"):
          machine.wait_until_succeeds("test -e /dev/snd/pcmC0D0p && test -e /dev/snd/pcmC0D0c", timeout=60)
          acl = machine.succeed("${pkgs.acl}/bin/getfacl -p /dev/snd/pcmC0D0p /dev/snd/pcmC0D0c /dev/snd/controlC0")
          print(acl)
          assert acl.count("user:whombat-kiosk:rw-") == 3, acl
          # Nobody else but the audio group.
          machine.fail("runuser -u whombat-runner -- sh -c ': < /dev/snd/controlC0'")

      with subtest("sound: PipeWire's microphone and speaker for the kiosk, through its PulseAudio socket (HD-04, NX-255)"):
          for unit in ["pipewire.service", "wireplumber.service", "pipewire-pulse.socket"]:
              machine.wait_for_unit(unit)
          assert sh(machine, "stat -c '%U:%G %a' /run/pulse/native") == "pipewire:pipewire 660"
          assert "pipewire" in sh(machine, "id -nG whombat-kiosk").split()
          # Chromium has the socket's address.
          browser = sh(machine, "pgrep -u whombat-kiosk -f 'chromium.*--app=' | head -1")
          assert "PULSE_SERVER=${pulse}" in machine.succeed(f"tr '\\0' '\\n' < /proc/{browser}/environ")
          # As the kiosk's user, in the kiosk's own namespaces (the server's private network, the read-only /run).
          machine.wait_until_succeeds(f"{kiosk_pa('pactl')} list short sinks | grep -q alsa_output", timeout=90)
          sources = sh(machine, f"{kiosk_pa('pactl')} list short sources")
          print(sources)
          mics = [l.split()[1] for l in sources.splitlines() if l.split()[1].startswith("alsa_input.")]
          assert mics, sources
          assert sh(machine, f"{kiosk_pa('pactl')} get-default-source") in mics
          assert sh(machine, f"{kiosk_pa('pactl')} get-default-sink").startswith("alsa_output.")
          # A speaker starts at 70 % (whombat.sound.defaultSinkVolume), not WirePlumber's 40 %.
          vol = sh(machine, f"{kiosk_pa('pactl')} get-sink-volume @DEFAULT_SINK@")
          print(vol)
          assert "70%" in vol, vol
          # A second of the microphone through the server (QEMU's card records silence), and the speaker plays. (parec
          # ends on the closed pipe: the driver's pipefail mustn't count that.)
          got = sh(machine, f"(timeout 60 {kiosk_pa('parec')} --raw --format=s16le --rate=16000 --channels=1 || true) | head -c 32000 | wc -c")
          assert got == "32000", got
          machine.succeed(f"head -c 32000 /dev/zero | timeout 60 {kiosk_pa('pacat')} --raw --format=s16le --rate=16000 --channels=1")
          # Nobody outside the group gets in.
          machine.fail("runuser -u whombat-runner -- env PULSE_SERVER=${pulse} ${pkgs.pulseaudio}/bin/pactl info")
          # WirePlumber keeps nothing (nothing to restore at the next boot).
          machine.fail("find /var/lib/pipewire -type f | grep -q .")

      with subtest("isolation: the server's loopback is the kiosk's alone, the token is the kiosk's group's"):
          server = sh(machine, "systemctl show -P MainPID whombat-console-server")
          cage = sh(machine, "pgrep -u whombat-kiosk -x .cage-wrapped")
          ns = sh(machine, f"readlink /proc/{server}/ns/net")
          assert sh(machine, f"readlink /proc/{cage}/ns/net") == ns, "the kiosk is not in the server's namespace"
          assert sh(machine, "readlink /proc/1/ns/net") != ns
          # Only a loopback in there, and nothing on the host's reaches the server.
          links = sh(machine, in_server_ns("ip -o link"))
          assert links.count("\n") == 0 and ": lo:" in links, links
          machine.fail("curl -s -m 3 http://127.0.0.1:8411/")
          machine.fail(in_server_ns("curl -s -m 3 http://10.0.2.2/ -o /dev/null"))
          assert sh(machine, "stat -c '%U:%G %a' /run/whombat-console-ui") == "whombat-console:whombat-kiosk 2750"
          assert sh(machine, "stat -c '%U:%G %a' /run/whombat-console-ui/token") == "whombat-console:whombat-kiosk 640"
          machine.succeed("runuser -u whombat-kiosk -- cat /run/whombat-console-ui/token >/dev/null")
          for user in ["whombat", "whombat-runner", "whombat-manager", "whombat-backup"]:
              machine.fail(f"runuser -u {user} -- cat /run/whombat-console-ui/token")
          # The kiosk can't read the console file.
          machine.fail("runuser -u whombat-kiosk -- cat /run/whombat/console/console.json")
          # The API: 403 without the token, 403 with another Host, the page itself without one.
          assert api(token=False).endswith("\n403"), api(token=False)
          assert machine.succeed(in_server_ns("curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8411/")).strip() == "200"
          assert machine.succeed(in_server_ns(
              "curl -s -o /dev/null -w '%{http_code}' -H 'Host: evil.example' -H \"Authorization: Bearer $(cat /run/whombat-console-ui/token)\" http://127.0.0.1:8411/api/state"
          )).strip() == "403"
          # Chromium's own sandbox holds (the kernel allows user namespaces here): its renderers run under seccomp in
          # namespaces of their own.
          renderer = sh(machine, "pgrep -u whombat-kiosk -f 'type=renderer' | head -1")
          assert sh(machine, f"awk '/^Seccomp:/{{print $2}}' /proc/{renderer}/status") == "2"
          assert sh(machine, f"readlink /proc/{renderer}/ns/pid") != sh(machine, f"readlink /proc/{cage}/ns/pid")

      with subtest("self-provisioning makes the box's own identity; control hears nothing"):
          machine.wait_until_succeeds("test -e /persist/identity/device.json", timeout=180)
          machine.wait_until_succeeds("systemctl show -P ActiveState whombat-self-provision | grep -qx inactive", timeout=120)
          print(machine.succeed("journalctl -u whombat-self-provision --no-pager"))
          assert sh(machine, "systemctl show -P Result whombat-self-provision") == "success"
          rec = json.loads(sh(machine, "whombat-provision verify"))
          assert rec["model"] == "self-installed" and rec["serial"] == "SN-SELF-0001", rec
          assert not rec["recoveryKeyEnrolled"], rec
          # No disk recovery key (PI-19): no hash, nothing for the console, and nothing for the drop unit to do.
          machine.fail("test -e /persist/secrets/recovery-key.argon2id || test -e /persist/console")
          assert sh(machine, "systemctl show -P ConditionResult whombat-recovery-key-drop") == "no"
          claim = json.loads(sh(machine, "cat /persist/identity/claim.json"))
          assert claim["deviceId"] == rec["deviceId"] and claim["secretHash"] is None, claim
          machine.succeed("test \"$(stat -c '%U %a' /persist/identity/claim.json)\" = 'root 600'")
          # Control first hears of a box at link.begin, which carries the registration provisioning kept (LNK-03).
          registered = json.loads(sh(control, "curl -s http://127.0.0.1:4600/test/devices"))
          assert not registered, registered
          assert rec["deviceId"].startswith("wb-"), rec
          kept = json.loads(sh(machine, "cat /persist/identity/registration.json"))
          assert kept["contentPeerId"] == rec["contentPeerId"] and kept["hardwareSerial"] == rec["serial"], kept
          # The factory tuple is recorded (MG-20) and the identity-bound services start.
          machine.succeed("test -n \"$(ls -A /persist/manager/journal)\"")
          machine.wait_for_unit("whombat-server.service")
          # A second boot doesn't provision again.
          machine.succeed("systemctl start whombat-self-provision")
          assert sh(machine, "systemctl show -P ConditionResult whombat-self-provision") == "no"

      with subtest("the hardware report from this VM's sysfs, with the helper's kernel lines (HD-03, MG-110…MG-114)"):
          machine.wait_for_unit("whombat-manager.service")
          hw_call = ("curl -s -w '\\n%{http_code}' --unix-socket /run/whombat-manager/api.sock -X POST"
                     " -H 'Content-Type: application/json' -d '{\"v\":1}' http://manager/v1/host/hardware")
          out = machine.succeed(f"runuser -u whombat -- {hw_call}").strip()
          body, code = out.rsplit("\n", 1)
          assert code == "200", (code, body)
          hw = json.loads(body)["hardware"]
          print(json.dumps(hw, indent=1))
          assert hw["kernel"] == sh(machine, "uname -r") and hw["machine"]["virtual"], hw["machine"]
          assert hw["machine"].get("hypervisor") in ("kvm", "qemu"), hw["machine"]
          devs = hw["devices"]
          card = [d for d in devs if d["kind"] == "sound"]
          assert card and card[0]["capture"] >= 1 and card[0]["playback"] >= 1 and card[0]["driver"] == "snd_hda_intel", card
          assert any(d["kind"] == "graphics" and "bochs" in (d["driver"] or "") for d in devs), devs
          assert any(d["kind"] == "display" and d.get("connected") for d in devs), devs
          assert any(d["kind"] == "wired" and d["driver"] == "virtio_net" and d.get("interface") for d in devs), devs
          assert any(d["kind"] == "storage" and d["driver"] == "virtio_blk" and d["sizeBytes"] > 0 for d in devs), devs
          assert isinstance(hw["log"], list)
          # The helper answered (its read-only op, outside its lock); no MAC address anywhere.
          # The helper's line reaches the journal a moment after its answer.
          machine.wait_until_succeeds("journalctl -u whombat-update-helper --no-pager | grep -q 'op=hardware-log'", timeout=30)
          machine.fail("journalctl -u whombat-manager --no-pager | grep -q \"the kernel's lines are left out\"")
          for mac in sh(machine, "cat /sys/class/net/*/address").split():
              assert mac == "00:00:00:00:00:00" or mac not in body, mac
          # Nor the machine's serial number (QEMU's SMBIOS has it, appliance-vm.nix).
          assert "SN-SELF-0001" not in body
          # The runtime's uid, and root for remote help's Look commands (MG-118); nobody else.
          assert machine.succeed(hw_call).strip().endswith("200")
          machine.fail(f"runuser -u whombat-runner -- {hw_call} | grep -q 200")

      with subtest("no recovery key screen: the API has claim states only and takes no posts (CG-31)"):
          st = agree()
          assert "key" not in st and "screen" not in st and st["claim"]["state"] in ("starting", "waiting", "claimable"), st
          assert "recovery key" not in st["footer"], st
          body, code = api("/api/confirm").rsplit("\n", 1)
          assert code == "405" or code == "404", (code, body)
          assert machine.succeed(in_server_ns(
              "curl -s -o /dev/null -w '%{http_code}' -X POST -d '{\"group\":\"cbdefghi\"}'"
              " -H \"Authorization: Bearer $(cat /run/whombat-console-ui/token)\" http://127.0.0.1:8411/api/confirm"
          )).strip() == "404"
          assert "recovery key" not in machine.get_screen_text().lower()

      with subtest("a never-claimed box asked for new keys keeps its own identity (MG-30, NX-35, LNK-01)"):
          # The manager asks root for new keys when control says the device was retired. A box that made its identity
          # itself has nothing registered at control to replace: the request is dropped, and the manager and the runtime
          # come back, once.
          old = rec["deviceId"]
          request = json.dumps({"v": 1, "deviceId": old, "reason": "device_retired", "at": "2026-09-26T00:00:00Z"})
          # The manager writes this on device_revoked (manager unit tests); here as its user, the same file.
          machine.succeed(f"echo {shlex.quote(request)} | runuser -u whombat-manager -- tee /persist/manager/reregister.json >/dev/null")
          machine.wait_until_succeeds("test ! -e /persist/manager/reregister.json", timeout=120)
          print(machine.succeed("journalctl -u whombat-self-provision --no-pager | tail -20"))
          assert sh(machine, "systemctl show -P Result whombat-self-provision") == "success"
          same = json.loads(sh(machine, "whombat-provision verify"))
          assert same["deviceId"] == old and same["contentPeerId"] == rec["contentPeerId"], (rec, same)
          assert sh(machine, "cat /persist/identity/claim.json | jq -r .deviceId") == old
          machine.wait_for_unit("whombat-server.service")
          machine.wait_for_unit("whombat-manager.service")
          assert not json.loads(sh(control, "curl -s http://127.0.0.1:4600/test/devices"))

      with subtest("the state file: group whombat-console, readable by the console only; the claim screens"):
          assert sh(machine, "stat -c '%U:%G %a' /run/whombat/console") == "whombat:whombat-console 2750"
          assert sh(machine, "stat -c '%U:%G %a' /run/whombat") == "whombat:whombat-admin 2751"
          write_state(machine, '{"v":1,"state":"claimable","code":"KXQM","url":"https://dev.whombat.com/claim"}')
          assert sh(machine, "stat -c '%U:%G %a' /run/whombat/console/console.json") == "whombat:whombat-console 640"
          machine.wait_for_text("Claim this Whombat", timeout=60)
          machine.wait_for_text("KXQM", timeout=30)
          st = agree()
          assert st["claim"] == {"state": "claimable", "code": "KXQM", "claimUrl": "dev.whombat.com/claim", "appUrl": "dev.whombat.com"}, st
          machine.screenshot("gui-claimable")
          kiosk_cpu("claim")
          machine.succeed("runuser -u whombat-console -- cat /run/whombat/console/console.json")
          machine.fail("runuser -u whombat-console -- ls /run/whombat")
          for user in ["whombat-runner", "whombat-manager"]:
              machine.fail(f"runuser -u {user} -- cat /run/whombat/console/console.json")
          # The code never reaches the journal.
          machine.fail("journalctl --no-pager | grep -q KXQM")

      with subtest("no pointer over the code at rest; a moving mouse shows the page's arrow, which goes again (CG-410)"):
          # A fresh cage puts its pointer in the middle of the screen, on the code, as at every start of a box.
          machine.succeed("systemctl restart whombat-kiosk.service")
          machine.wait_for_text("KXQM", timeout=120)
          machine.sleep(5)
          pointer_check(machine, "gui-claimable")

      with subtest("backoff, claimed with the burrow's name, and a crafted file"):
          retry = sh(machine, "date -u -d '+5 min' +%Y-%m-%dT%H:%M:%SZ")
          write_state(machine, '{"v":1,"state":"backoff","url":"https://dev.whombat.com/claim","retryAt":"' + retry + '"}')
          machine.wait_for_text("Too many wrong codes", timeout=60)
          assert agree()["claim"]["retryAt"] == retry
          write_state(machine, '{"v":1,"state":"claimed","url":"https://dev.whombat.com/claim","burrows":{"first":"Banjo’s Burrow","more":2}}')
          machine.wait_for_text("Banjo", timeout=60)
          machine.wait_for_text("dev.whombat.com to use it", timeout=30)
          assert agree()["claim"]["burrows"] == {"first": "Banjo’s Burrow", "more": 2}
          machine.screenshot("gui-claimed")
          kiosk_cpu("claimed")
          # A name with a bidi override: the claim stands, the burrows go (CT-116); nothing of it reaches the page.
          write_state(machine, '{"v":1,"state":"claimed","url":"https://dev.whombat.com/claim","burrows":{"first":"Evil\\u202eworrub","more":1}}')
          machine.sleep(2)
          st = agree()
          assert st["claim"]["state"] == "claimed" and "burrows" not in st["claim"], st
          write_state(machine, '{"v":1,"state":"claimable","code":"KXQM\\u001b[2J","url":"https://dev.whombat.com/claim"}')
          machine.wait_for_text("Starting Whombat", timeout=60)
          assert agree()["claim"]["state"] == "starting"

      with subtest("the runtime's sandbox sees whether a display is connected (hasDisplay, NX-160)"):
          pid = sh(machine, "systemctl show -P MainPID whombat-server")
          status = machine.succeed(f"nsenter -t {pid} -m sh -c 'cat /sys/class/drm/card*-*/status'")
          assert "connected" in status.split(), status
          machine.succeed("pgrep -u whombat-kiosk -f 'chromium.*--autoplay-policy=no-user-gesture-required'")

      with subtest("a stopped server leaves no code on the console"):
          write_state(machine, '{"v":1,"state":"claimable","code":"KXQM","url":"https://dev.whombat.com/claim"}')
          machine.wait_for_text("KXQM", timeout=60)
          machine.succeed("systemctl stop whombat-server.service")
          machine.succeed("test ! -e /run/whombat/console/console.json")
          machine.wait_for_text("Starting Whombat", timeout=60)

      with subtest("power: never suspend, the lid ignored, a VM's power button still powers off (NX-165…NX-167)"):
          login = "busctl get-property org.freedesktop.login1 /org/freedesktop/login1 org.freedesktop.login1.Manager "
          assert sh(machine, login + "HandleLidSwitch") == 's "ignore"'
          assert sh(machine, login + "HandlePowerKeyLongPress") == 's "poweroff"'
          # No battery and no lid in QEMU: the short press is logind's as before (Proxmox's ACPI “Shutdown”).
          assert sh(machine, login + "HandlePowerKey") == 's "poweroff"'
          assert sh(machine, "systemctl show -P Result whombat-power-key") == "success"
          machine.fail("test -e /run/systemd/logind.conf.d/50-whombat-power-key.conf")
          # Suspend can't be asked for (sleep.conf: AllowSuspend=no).
          can = sh(machine, "busctl call org.freedesktop.login1 /org/freedesktop/login1 org.freedesktop.login1.Manager CanSuspend")
          print(f"CanSuspend: {can}")
          assert can in ('s "na"', 's "no"'), can
          machine.succeed("systemd-analyze cat-config systemd/sleep.conf | grep -qx 'AllowSuspend=no'")
          assert sh(machine, "systemctl show -P Result whombat-charge-limit") == "success"
          # UPower answers (D-Bus activated) and sees no battery.
          machine.succeed("upower -e | grep -q DisplayDevice")
          machine.succeed("grep -qx 'PercentageAction=10' /etc/UPower/UPower.conf")
          machine.succeed("grep -qx 'CriticalPowerAction=PowerOff' /etc/UPower/UPower.conf")

      with subtest("the desk socket: only the runtime's uid is believed, only the console's server connects (NX-160)"):
          assert api_state()["desk"] is None
          # Root serving the socket is not the runtime: no desk.
          set_desk(desk_state())
          machine.succeed("systemd-run --unit=desk-fake-root ${pkgs.python3}/bin/python3 ${deskFake} /run/whombat/console/desk.sock")
          machine.wait_until_succeeds("test -S /run/whombat/console/desk.sock")
          machine.sleep(2)
          assert api_state()["desk"] is None
          machine.succeed("journalctl -u whombat-console-server --no-pager | grep -q \"the desk socket isn't the runtime's\"")
          machine.succeed("systemctl stop desk-fake-root && rm -f /run/whombat/console/desk.sock")
          # The runtime's uid: its socket is 0660 in the console's directory, so it has the group whombat-console.
          machine.succeed("systemd-run --unit=desk-fake --uid=whombat --gid=whombat ${pkgs.python3}/bin/python3 ${deskFake} /run/whombat/console/desk.sock")
          machine.wait_until_succeeds("test -S /run/whombat/console/desk.sock")
          assert sh(machine, "stat -c '%U:%G %a' /run/whombat/console/desk.sock") == "whombat:whombat-console 660"
          machine.wait_until_succeeds("curl -sf --unix-socket /run/whombat/console/desk.sock http://desk/v1/desk/state >/dev/null")
          machine.succeed("runuser -u whombat-console -- curl -sf --unix-socket /run/whombat/console/desk.sock http://desk/v1/desk/state >/dev/null")
          for user in ["whombat-kiosk", "whombat-runner", "whombat-manager", "whombat-backup"]:
              machine.fail(f"runuser -u {user} -- curl -sf --unix-socket /run/whombat/console/desk.sock http://desk/v1/desk/state")
          deadline = time.monotonic() + 30
          while api_state()["desk"] is None and time.monotonic() < deadline:
              time.sleep(1)
          st = agree()
          d = st["desk"]
          assert d["paired"]["person"]["name"] == "John" and d["lock"] == {"state": "locked"} and d["power"] is None, d
          assert d["glance"]["servers"][0] == {"name": "pve-02", "mark": "proxmox", "state": "ok", "note": "up 41 d"}, d
          # The page's requests reach the socket as the contract's, and its answers come back.
          code, out = api_post("/api/desk/unlock", '{"pin":"123456","extra":"dropped"}')
          assert code == 200 and out == {"v": 1, "result": "wrong", "triesLeft": 4}, (code, out)
          code, out = api_post("/api/desk/lock", "")
          assert code == 200 and out == {"v": 1}, (code, out)
          code, out = api_post("/api/desk/decide", '{"number":3,"decision":"approve"}')
          assert code == 409 and out == {"message": "locked"}, (code, out)
          code, out = api_post("/api/desk/unlock", '{"pin":"12"}')
          assert code == 400, (code, out)
          reqs = machine.succeed("cat /run/desk-fake/requests").splitlines()
          # The console also tells the runtime the screen's size (its outputs) by itself, once it has a paired desk.
          sizes = [r for r in reqs if r.startswith("/v1/desk/size ")]
          assert sizes and '"main":true' in sizes[0], reqs
          reqs = [r for r in reqs if not r.startswith("/v1/desk/size ")]
          assert reqs == ['/v1/desk/unlock {"v":1,"pin":"123456"}', '/v1/desk/lock {"v":1}',
                          '/v1/desk/decide {"v":1,"number":3,"decision":"approve"}'], reqs

      with subtest("the desk's nights: Black sleeps after a minute and wakes on input or in the morning, Dim and the day don't"):
          # Nobody has touched this VM's console for minutes: at night with Black it goes dark at the next poll.
          set_desk(desk_state(quiet=True, night="black"))
          machine.wait_until_fails("pgrep -u whombat-kiosk -f 'type=renderer'", timeout=60)
          # (The line comes once Chromium's browser process has gone too.)
          machine.wait_until_succeeds("journalctl -t whombat-kiosk --no-pager | grep -q 'quiet hours; the screen is black until it is touched'", timeout=30)
          machine.sleep(5)
          assert not chromium_up(), "Chromium came back by itself"
          machine.succeed("pgrep -u whombat-kiosk -x .cage-wrapped")
          # A key shows it again, and a minute later it is dark again.
          machine.send_key("shift")
          machine.wait_until_succeeds("pgrep -u whombat-kiosk -f 'type=renderer'", timeout=60)
          machine.wait_until_succeeds("journalctl -t whombat-kiosk --no-pager | grep -q 'the console was used; it shows again'", timeout=30)
          start = time.monotonic()
          machine.wait_until_fails("pgrep -u whombat-kiosk -f 'type=renderer'", timeout=120)
          slept = time.monotonic() - start
          assert slept >= 45, f"dark after {slept:.0f} s, before a minute without input"
          # The quiet hours end: it shows again by itself.
          set_desk(desk_state(quiet=False))
          machine.wait_until_succeeds("pgrep -u whombat-kiosk -f 'type=renderer'", timeout=60)
          machine.wait_until_succeeds("journalctl -t whombat-kiosk --no-pager | grep -q 'the desk screen shows again'", timeout=30)
          # In the day it stays on although nobody uses it (Black would have slept by now), and at night with Dim too.
          machine.sleep(75)
          assert chromium_up(), "a paired screen slept in the day"
          set_desk(desk_state(quiet=True, night="dim"))
          machine.sleep(25)
          assert chromium_up(), "a paired screen slept at night with Dim"

      with subtest("the page's chime for a new ask plays through the sound server, and the night still goes dark (DK-08, NX-255)"):
          machine.fail(f"{kiosk_pa('pactl')} list clients | grep -qi chromium")
          set_desk(desk_state(asks=1))
          machine.wait_until_succeeds(f"{kiosk_pa('pactl')} list clients | grep -qi chromium", timeout=60)
          clients = machine.succeed(f"{kiosk_pa('pactl')} list clients")
          chromium = [c for c in clients.split("\n\n") if "chromium" in c.lower()]
          print(chromium)
          # Through the PulseAudio socket, not ALSA's PipeWire plugin; and nothing records (DK-07).
          assert any('client.api = "pipewire-pulse"' in c for c in chromium), chromium
          assert sh(machine, f"{kiosk_pa('pactl')} list short source-outputs") == ""
          # A chime doesn't keep a Black night's screen on: it goes dark once nobody has touched it for a minute.
          start = time.monotonic()
          set_desk(desk_state(quiet=True, night="black", asks=1))
          machine.wait_until_fails("pgrep -u whombat-kiosk -f 'type=renderer'", timeout=240)
          print(f"dark {time.monotonic() - start:.0f} s after the chime's night began")
          set_desk(desk_state())
          machine.wait_until_succeeds("pgrep -u whombat-kiosk -f 'type=renderer'", timeout=60)
          # The fake goes: no desk, the console as before.
          machine.succeed("systemctl stop desk-fake && rm -f /run/whombat/console/desk.sock")
          machine.wait_until_succeeds(in_server_ns(
              "curl -s -H \"Authorization: Bearer $(cat /run/whombat-console-ui/token)\" http://127.0.0.1:8411/api/state | jq -e '.desk == null'"
          ), timeout=30)
          agree()

      with subtest("a restarted console server restarts the kiosk with its new token"):
          token = sh(machine, "cat /run/whombat-console-ui/token")
          cage = sh(machine, "pgrep -u whombat-kiosk -x .cage-wrapped")
          machine.succeed("systemctl kill -s KILL whombat-console-server.service")
          machine.wait_until_succeeds(f"test \"$(cat /run/whombat-console-ui/token)\" != '{token}'", timeout=30)
          machine.wait_until_succeeds(f"pgrep -u whombat-kiosk -x .cage-wrapped | grep -vqx {cage}", timeout=60)
          machine.wait_until_succeeds("pgrep -u whombat-kiosk -f 'chromium.*--app=http://127.0.0.1:8411/#t='\"$(cat /run/whombat-console-ui/token)\"", timeout=60)
          machine.wait_for_text("Starting Whombat", timeout=90)

      with subtest("a kiosk whose Chromium doesn't stop is killed after 5 s and starts again (NX-87)"):
          machine.wait_until_succeeds("pgrep -u whombat-kiosk -f 'type=renderer'", timeout=90)
          cage = sh(machine, "pgrep -u whombat-kiosk -x .cage-wrapped")
          machine.succeed("pkill -STOP -u whombat-kiosk -f 'chromium'")
          start = time.monotonic()
          machine.succeed("systemctl --no-block restart whombat-kiosk.service")
          machine.wait_until_succeeds(f"pgrep -u whombat-kiosk -x .cage-wrapped | grep -vqx {cage}", timeout=30)
          assert time.monotonic() - start < 20, "the kiosk took longer than its stop timeout to come back"
          machine.wait_until_succeeds("pgrep -u whombat-kiosk -f 'type=renderer'", timeout=90)
          # Nothing of the stopped kiosk is left behind.
          machine.fail("ps -u whombat-kiosk -o stat= | grep -q '^T'")
          machine.wait_for_text("Starting Whombat", timeout=90)

      with subtest("a keyboard and a mouse plugged in later work in the running kiosk, without a restart (NX-400…NX-403)"):
          machine.wait_until_succeeds("pgrep -u whombat-kiosk -f 'type=renderer'", timeout=90)
          machine.fail("systemctl cat whombat-kiosk-replug.service")
          # The relay: root with CAP_NET_ADMIN alone, in an empty network namespace of its own (both of its sockets are
          # systemd's); the kiosk still shares the server's, after every restart above.
          machine.wait_for_unit("whombat-kiosk-udev.service")
          relay = sh(machine, "systemctl show -P MainPID whombat-kiosk-udev")
          status = machine.succeed(f"cat /proc/{relay}/status")
          assert "\nUid:\t0\t0\t0\t0\n" in status, status
          capeff = next(l.split()[1] for l in status.splitlines() if l.startswith("CapEff:"))
          assert int(capeff, 16) == 1 << 12, capeff
          kiosk = sh(machine, "systemctl show -P MainPID whombat-kiosk")
          cage = sh(machine, "pgrep -u whombat-kiosk -x .cage-wrapped")
          netns = lambda pid: sh(machine, f"readlink /proc/{pid}/ns/net")
          server = sh(machine, "systemctl show -P MainPID whombat-console-server")
          assert netns(cage) == netns(server), "the kiosk left the server's namespace"
          assert netns(relay) not in (netns(server), netns("1")), "the relay shares a network namespace"
          links = sh(machine, f"nsenter -t {relay} -n ip -o link")
          assert links.count("\n") == 0 and ": lo:" in links, links

          def node(name):
              machine.wait_until_succeeds(f"grep -l '{name}' /sys/class/input/event*/device/name", timeout=60)
              return sh(machine, f"grep -l '{name}' /sys/class/input/event*/device/name | cut -d/ -f5")
          held = lambda ev: f"ls -l /proc/{cage}/fd | grep -q '/dev/input/{ev}$'"
          passed = lambda what: f"journalctl -u whombat-kiosk-udev --no-pager | grep -q 'passed {what}$'"
          start = time.monotonic()
          machine.send_monitor_command("device_add usb-kbd,id=latekbd")
          machine.send_monitor_command("device_add usb-mouse,id=latemouse")
          kbd, mouse = node("USB Keyboard"), node("USB Mouse")
          for ev in (kbd, mouse):
              machine.wait_until_succeeds(held(ev), timeout=60)
              machine.wait_until_succeeds(passed(f"add {ev}"), timeout=30)
          print(f"cage holds the new keyboard ({kbd}) and mouse ({mouse}) {time.monotonic() - start:.1f} s after they were plugged in")
          # Unplugged and back, as a Bluetooth keyboard that sleeps and wakes: cage lets go of it and takes the new one.
          machine.send_monitor_command("device_del latekbd")
          machine.wait_until_fails(held(kbd), timeout=60)
          machine.wait_until_succeeds(passed(f"remove {kbd}"), timeout=30)
          machine.send_monitor_command("device_add usb-kbd,id=latekbd2")
          kbd = node("USB Keyboard")
          machine.wait_until_succeeds(held(kbd), timeout=60)

          # Its keys reach the page: on a paired, locked desk six digits typed on the glance are a PIN the page sends.
          # (QEMU types on the keyboard added last; its node has the keys too.)
          machine.succeed("rm -f /run/desk-fake/requests")
          doc = json.loads(desk_state())
          doc["paired"]["hasPin"] = True
          set_desk(json.dumps(doc))
          machine.succeed("systemd-run --unit=desk-fake-keys --uid=whombat --gid=whombat ${pkgs.python3}/bin/python3 ${deskFake} /run/whombat/console/desk.sock")
          machine.wait_until_succeeds(in_server_ns(
              "curl -s -H \"Authorization: Bearer $(cat /run/whombat-console-ui/token)\" http://127.0.0.1:8411/api/state | jq -e '.desk.paired != null'"
          ), timeout=30)
          for unit, ev in [("kbd", kbd), ("mouse", mouse)]:
              machine.succeed(f"systemd-run --unit={unit}-read -p StandardOutput=file:/tmp/{unit}.ev -p RuntimeMaxSec=600 cat /dev/input/{ev}")
          sent = False
          for attempt in range(3):
              machine.sleep(5)
              # The first digit opens the PIN pad; the other five go to it.
              machine.send_key("2")
              machine.sleep(3)
              for k in "46813":
                  machine.send_key(k)
              try:
                  machine.wait_until_succeeds("grep -qF '/v1/desk/unlock {\"v\":1,\"pin\":\"246813\"}' /run/desk-fake/requests", timeout=20)
                  sent = True
                  break
              except Exception:
                  print(f"no PIN from the page after attempt {attempt + 1}; Escape, and again")
                  machine.send_key("esc")
          assert sent, machine.succeed("cat /run/desk-fake/requests 2>/dev/null || true")
          # The mouse moves cage's pointer the same way.
          for _ in range(3):
              machine.send_monitor_command("mouse_move 40 25")
          machine.succeed("systemctl stop kbd-read mouse-read || true")
          sizes = {ev: int(sh(machine, f"stat -c %s /tmp/{ev}.ev")) for ev in ["kbd", "mouse"]}
          print(f"bytes from the new devices' nodes meanwhile: {sizes}")
          assert sizes["kbd"] > 0, "the PIN didn't come from the new keyboard"
          # No restart: the same kiosk, the same cage.
          assert sh(machine, "systemctl show -P MainPID whombat-kiosk") == kiosk
          assert sh(machine, "pgrep -u whombat-kiosk -x .cage-wrapped") == cage
          machine.succeed("systemctl stop desk-fake-keys && rm -f /run/whombat/console/desk.sock")

      with subtest("three kiosk crashes in a row: the text console takes tty1 (CG-05)"):
          machine.fail("systemctl is-active whombat-console.service")
          # From a restart from outside, as the server's ExecStartPost= does it (its start count reset): nothing above
          # restarts the kiosk any more (the late keyboard did, NX-400), and NX-87's plain restart still counts.
          machine.succeed("systemctl reset-failed whombat-kiosk.service && systemctl restart whombat-kiosk.service")
          for i in range(3):
              machine.wait_until_succeeds("pgrep -u whombat-kiosk -f 'type=renderer'", timeout=90)
              machine.succeed("pkill -SEGV -u whombat-kiosk -f 'chromium.*--app='")
              time.sleep(5)
              if i < 2:
                  machine.fail("systemctl is-active whombat-console.service")
          machine.wait_until_succeeds("systemctl is-active whombat-console.service", timeout=60)
          assert sh(machine, "systemctl show -P Result whombat-kiosk") == "start-limit-hit"
          machine.wait_until_tty_matches("1", "Starting Whombat")
          machine.wait_until_tty_matches("1", "hold Space")
    '';
}
