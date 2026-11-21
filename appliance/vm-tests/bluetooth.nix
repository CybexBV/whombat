# Bluetooth (NX-350…NX-363; Whombat BT-01…BT-10) on a small VM with the accounts, the sound server and the Bluetooth
# module (no runtime, no appliance storage: neither unit depends on them):
#   - the socket is systemd's, 0660 whombat-bluetooth:whombat; the service starts only when asked; the server's user and
#     root get in, the runner can't open it and a member of its group that isn't the server is refused (403)
#   - without a controller: no adapter (`missing: no_adapter`)
#   - two virtual controllers (bluez's btvirt, hci_vhci): hci0 is the box's, powered at start; hci1 is a mouse that
#     isn't the box's (bt-peer holds it through the HCI user channel: NoInputNoOutput, Just Works, no services)
#   - only root, whombat-bluetooth and pipewire reach org.bluez: the server's user and another user are refused by
#     D-Bus; PipeWire registers its A2DP endpoints with BlueZ
#   - through the socket as the server's uid: looking finds the mouse (named, a mouse, 4 bars), pairing it runs to
#     `done` (trusted, in the paired list, BlueZ says paired and bonded), connect and disconnect answer it, forgetting
#     removes it; every answer is the contract's; the journal names the mouse and never an address
{ pkgs, ... }:
let
  socket = "/run/whombat-bluetooth/bluetooth.sock";
  # BlueZ's emulator (emulator/btvirt): virtual controllers on /dev/vhci that see each other. nixpkgs' bluez doesn't
  # build it (--enable-testing); only the one program is kept.
  btvirt = pkgs.bluez.overrideAttrs (o: {
    pname = "bluez-btvirt";
    configureFlags = o.configureFlags ++ [ "--enable-testing" ];
    outputs = [ "out" ];
    buildFlags = [ "emulator/btvirt" ];
    doCheck = false;
    doInstallCheck = false;
    installPhase = ''
      runHook preInstall
      install -Dm755 emulator/btvirt $out/bin/btvirt
      runHook postInstall
    '';
    postInstall = "";
    postFixup = "";
  });
  peer = pkgs.buildGoModule {
    pname = "bt-peer";
    version = "0";
    src = ./common/bt-peer;
    vendorHash = null;
    env.CGO_ENABLED = "0";
  };
  mouse = "Whombat Test Mouse";
in
{
  name = "whombat-bluetooth";

  nodes.machine =
    { ... }:
    {
      imports = [
        ../nix/modules/options.nix
        ../nix/modules/users.nix
        ../nix/modules/sound.nix
        ../nix/modules/bluetooth.nix
      ];
      whombat.bluetooth.enable = true;
      whombat.sound.enable = true;
      boot.kernelModules = [ "hci_vhci" ];
      # WirePlumber's info lines in the journal, for the endpoint subtest's diagnosis.
      systemd.services.wireplumber.environment.WIREPLUMBER_DEBUG = "3";
      # A member of the socket's group that isn't the server: the peer check's case.
      users.users.intruder = {
        isNormalUser = true;
        extraGroups = [ "whombat" ];
      };
      environment.systemPackages = [
        btvirt
        peer
        pkgs.curl
        pkgs.jq
      ];
    };

  testScript = ''
    import json, re

    sock = "${socket}"
    mouse = "${mouse}"

    def call(path, body=None, user="whombat", status="200"):
        data = f"-d '{body}' -H 'Content-Type: application/json'" if body is not None else ""
        out = machine.succeed(
            f"runuser -u {user} -- curl -sS --unix-socket {sock} {data} -o /tmp/answer.{user} -w '%{{http_code}}' http://bt{path}; cat /tmp/answer.{user}"
        )
        t.assertEqual(out[:3], status, out)
        return json.loads(out[3:])

    def state():
        st = call("/v1/bluetooth/state")["bluetooth"]
        # The contract's rules (BluetoothStateValid): missing exactly when unusable, no paired device in a scan, no
        # scan while a pairing runs, a code exactly while one is shown, a failure exactly when failed.
        usable = st["adapter"] is not None and st["adapter"]["powered"]
        t.assertEqual(usable, "missing" not in st, st)
        paired = {d["address"] for d in st["devices"]}
        if st["scan"]:
            t.assertFalse(paired & {d["address"] for d in st["scan"]["devices"]}, st)
        p = st["pairing"]
        if p:
            t.assertEqual(p["phase"] in ("code", "confirm"), "code" in p, p)
            t.assertEqual(p["phase"] == "failed", "failure" in p, p)
            if st["scan"]:
                t.assertIn(p["phase"], ("done", "failed"), st)
        return st

    machine.wait_for_unit("sockets.target")
    machine.wait_for_unit("whombat-bluetooth.socket")
    t.assertEqual(machine.succeed(f"stat -c '%a %U %G' {sock}").strip(), "660 whombat-bluetooth whombat")
    machine.fail("systemctl is-active whombat-bluetooth.service")

    with subtest("the server's user and root get in, nobody else; no controller, no adapter"):
        st = state()
        t.assertEqual(st, {"adapter": None, "missing": "no_adapter", "devices": [], "scan": None, "pairing": None})
        machine.succeed("systemctl is-active whombat-bluetooth.service")
        call("/v1/bluetooth/state", user="root")
        machine.fail(f"runuser -u whombat-runner -- curl -sS --fail --unix-socket {sock} http://bt/v1/bluetooth/state")
        t.assertEqual(call("/v1/bluetooth/state", user="intruder", status="403")["error"]["code"], "forbidden")
        t.assertEqual(call("/v1/bluetooth/scan", '{"v":1}', status="409")["error"]["code"], "no_bluetooth")
        t.assertEqual(call("/v1/bluetooth/scan", '{"v":1,"x":1}', status="400")["error"]["code"], "bad_request")
        print("bluetoothd without a controller:", machine.execute("systemctl is-active bluetooth.service")[1].strip())

    with subtest("two virtual controllers: the box's hci0, and a mouse on hci1 that isn't the box's"):
        machine.succeed("systemd-run --unit btvirt btvirt -l2")
        machine.wait_until_succeeds("test -e /sys/class/bluetooth/hci0 && test -e /sys/class/bluetooth/hci1", timeout=60)
        machine.wait_for_unit("bluetooth.service")
        machine.succeed("systemctl is-active whombat-bluetooth-on.service || systemctl start whombat-bluetooth-on.service")
        # bluetoothd powered both (AutoEnable): hci1 goes down, then bt-peer takes it.
        machine.wait_until_succeeds("btmgmt --index 1 info | grep -q 'current settings: .*powered'", timeout=60)
        machine.succeed("btmgmt --index 1 power off")
        machine.succeed("systemd-run --unit bt-peer bt-peer --index 1 --name '${mouse}'")
        machine.wait_until_succeeds("journalctl -u bt-peer | grep -q 'bt-peer: ready'", timeout=30)
        machine.wait_until_succeeds(
            f"runuser -u whombat -- curl -sS --unix-socket {sock} http://bt/v1/bluetooth/state | jq -e '.bluetooth.adapter.powered'",
            timeout=60,
        )
        st = state()
        t.assertNotIn("missing", st)
        t.assertEqual(st["devices"], [])

    with subtest("only root, whombat-bluetooth and the sound server reach BlueZ"):
        ask = "dbus-send --system --print-reply --dest=org.bluez / org.freedesktop.DBus.ObjectManager.GetManagedObjects"
        for user in ["root", "whombat-bluetooth", "pipewire"]:
            machine.succeed(f"runuser -u {user} -- {ask} | grep -q org.bluez.Adapter1")
        for user in ["whombat", "intruder", "whombat-runner"]:
            out = machine.fail(f"runuser -u {user} -- {ask} 2>&1")
            t.assertIn("AccessDenied", out)
        machine.succeed("systemctl is-active wireplumber.service")
        try:
            machine.wait_until_succeeds("journalctl -u bluetooth | grep -q 'Endpoint registered.*A2DPSource'", timeout=60)
            endpoints = True
        except Exception:
            endpoints = False
            print(machine.execute("journalctl -b -u wireplumber -o cat --no-pager | grep -i -E 'bluez|bluetooth|monitor|error|warn|fail' | grep -v 'Registered hook'")[1])
            print(machine.execute("for f in $(systemctl show wireplumber -p Environment --value | tr ' ' '\\n' | sed -n 's/^XDG_DATA_DIRS=//p' | tr ':' ' ') /etc/wireplumber; do ls -la $f/wireplumber/wireplumber.conf.d $f/wireplumber.conf.d 2>/dev/null; done; cat /etc/wireplumber/wireplumber.conf.d/90-whombat.conf 2>/dev/null")[1])
            print(machine.execute("systemctl show wireplumber -p Environment --value")[1])
            print(machine.execute("journalctl -b -u bluetooth -o cat --no-pager")[1])
            print(machine.execute("busctl --system --no-pager list --no-legend | grep -v ' - '")[1])

    with subtest("looking finds the mouse; pairing it runs to done"):
        sc = call("/v1/bluetooth/scan", '{"v":1}')["scan"]
        t.assertTrue(sc["until"].endswith("Z"))
        machine.wait_until_succeeds(
            f"runuser -u whombat -- curl -sS --unix-socket {sock} http://bt/v1/bluetooth/state"
            f" | jq -e '.bluetooth.scan.devices[] | select(.name == \"{mouse}\")'",
            timeout=90,
        )
        found = [d for d in state()["scan"]["devices"] if d["name"] == mouse][0]
        t.assertEqual((found["kind"], found["signal"], found["connected"]), ("mouse", 4, False))
        addr = found["address"]
        t.assertTrue(re.fullmatch(r"[0-9A-F]{2}(:[0-9A-F]{2}){5}", addr))
        p = call("/v1/bluetooth/pair", json.dumps({"v": 1, "address": addr}), status="202")["pairing"]
        t.assertEqual((p["phase"], p["name"], p["kind"]), ("pairing", mouse, "mouse"))
        t.assertIsNone(state()["scan"])
        machine.wait_until_succeeds(
            f"runuser -u whombat -- curl -sS --unix-socket {sock} http://bt/v1/bluetooth/state"
            " | jq -e '.bluetooth.pairing.phase == \"done\" or .bluetooth.pairing.phase == \"failed\"'",
            timeout=120,
        )
        st = state()
        t.assertEqual(st["pairing"]["phase"], "done", st["pairing"])
        t.assertEqual([(d["address"], d["name"], d["kind"]) for d in st["devices"]], [(addr, mouse, "mouse")])
        info = machine.succeed(f"bluetoothctl info {addr}")
        for line in ["Paired: yes", "Bonded: yes", "Trusted: yes"]:
            t.assertIn(line, info)
        machine.succeed("journalctl -u bt-peer | grep -q 'bt-peer: paired'")

    with subtest("connect, disconnect, forget"):
        d = call("/v1/bluetooth/connect", json.dumps({"v": 1, "address": addr}))["device"]
        t.assertEqual(d["address"], addr)
        d = call("/v1/bluetooth/disconnect", json.dumps({"v": 1, "address": addr}))["device"]
        t.assertFalse(d["connected"])
        t.assertEqual(call("/v1/bluetooth/forget", json.dumps({"v": 1, "address": addr})), {"v": 1})
        t.assertEqual(state()["devices"], [])
        t.assertNotIn("Paired: yes", machine.succeed(f"bluetoothctl info {addr} 2>&1 || true"))
        t.assertEqual(call("/v1/bluetooth/forget", json.dumps({"v": 1, "address": addr}), status="404")["error"]["code"], "not_found")

    with subtest("PipeWire registered its A2DP endpoints with BlueZ"):
        t.assertTrue(endpoints, "no A2DP endpoint registered (journals above)")
        # The box's-microphone-first hook loaded (WirePlumber's info lines, WIREPLUMBER_DEBUG=3 above).
        t.assertIn("Registered hook default-nodes/whombat-box-microphone-first successfully", machine.succeed("journalctl -u wireplumber"))

    with subtest("the journal names devices, never addresses"):
        journal = machine.succeed("journalctl -u whombat-bluetooth")
        t.assertIn(mouse, journal)
        for form in [addr, addr.replace(":", "_"), addr.replace(":", "-"), addr.lower()]:
            t.assertNotIn(form, journal)
  '';
}
