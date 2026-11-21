# Wi-Fi end to end (NX-240…NX-247, MG-100…MG-104; Whombat HD-05, HD-06, HD-10): mac80211_hwsim gives the VM four radios.
# Three are moved into a network namespace `ap` (the access points' side): hostapd runs "Office" (WPA2), "Home" (WPA2)
# and "Cafe" (open) on them, dnsmasq hands out addresses, and the fake control and the TUF fixtures listen there, so the
# box reaches control only over Wi-Fi. The café has no way to control (its access point refuses those ports). The
# fourth radio is the appliance's own, with its real iwd, networkd, helper and manager.
#
#   - a profile in /var/lib/iwd (as the installer writes it, HD-08) brings the box online on Office; Wi-Fi's default
#     route has metric 600; the box provisions over Wi-Fi
#   - through the manager's socket as the runtime's uid: the network state, a scan that finds the networks, a wrong
#     password that fails and keeps nothing, the right one that joins, gets an address and commits, a join without
#     internet that goes back (its profile gone), forgetting a saved network, refusing to forget the only connection
#   - the passphrases are in no log and in no state file but iwd's
#
# Then a cable on Home's own network (Whombat network-move.md): a second card on the test VLAN, inside `ap`, is bridged
# with Home's access point, so the box's cable and its Wi-Fi get addresses on one subnet, as on John's Home.
#   - with the cable carrying the default route, the Wi-Fi address answers a TCP connection from that network
#   - Use Wi-Fi only with Wi-Fi that can't reach control goes back, and the cable gets its address back
#   - Use Wi-Fi only is kept: the cable keeps its carrier but has no address at all, Wi-Fi carries the default route,
#     and it stays so after a restart; Use the cable again gives the cable its address and the default route back
{
  applianceModules,
  pkgs,
  lib,
  ...
}:
let
  officePass = "office-pass-1";
  homePass = "home-pass-22";
  wrongPass = "not-the-password";
  token = "dev-station-token-for-vm-tests-only";
  ap =
    {
      ssid,
      iface,
      channel,
      pass ? null,
      bridge ? null,
    }:
    pkgs.writeText "hostapd-${ssid}.conf" (
      ''
        interface=${iface}
        driver=nl80211
        ssid=${ssid}
        hw_mode=g
        channel=${toString channel}
      ''
      + lib.optionalString (bridge != null) ''
        bridge=${bridge}
      ''
      + lib.optionalString (pass != null) ''
        wpa=2
        wpa_key_mgmt=WPA-PSK
        rsn_pairwise=CCMP
        wpa_passphrase=${pass}
      ''
    );
  aps = [
    (ap {
      ssid = "Office";
      iface = "wlan0";
      channel = 1;
      pass = officePass;
    })
    (ap {
      ssid = "Home";
      iface = "wlan1";
      channel = 6;
      pass = homePass;
      bridge = "br-home";
    })
    (ap {
      ssid = "Cafe";
      iface = "wlan2";
      channel = 11;
    })
  ];
  # The manager's local API as the runtime's uid: wb-api <path> <json> prints the body, then the status on its own line.
  api = pkgs.writeShellScriptBin "wb-api" ''
    exec ${pkgs.util-linux}/bin/runuser -u whombat -- ${pkgs.curl}/bin/curl -s -X POST -H 'content-type: application/json' \
      --data-binary "$2" -w '\n%{http_code}' --unix-socket /run/whombat-manager/api.sock "http://manager$1"
  '';
  # The card on the network's side of the cable (moved into `ap` as lan0).
  lanMac = "52:54:00:77:00:02";
  inAp = {
    NetworkNamespacePath = "/run/netns/ap";
  };
  apUnit = extra: {
    wantedBy = [ "multi-user.target" ];
    requires = [ "wifi-ap-netns.service" ];
    after = [ "wifi-ap-netns.service" ];
  } // extra;
in
{
  name = "whombat-wifi";

  nodes.machine =
    { pkgs, ... }:
    {
      imports = applianceModules ++ [ (import ./common/appliance-vm.nix { serial = "SN-WIFI-0001"; }) ];
      # Control and the update fixtures are behind the access points.
      whombat.manager.controlUrl = lib.mkForce "http://10.77.0.1:4600";
      whombat.manager.tuf = {
        metadataUrl = lib.mkForce "http://10.77.0.1:8080/valid/metadata/";
        targetsUrl = lib.mkForce "http://10.77.0.1:8080/valid/targets/";
      };
      # No QEMU user network: its DHCP would make a cable with a default route (metric 100) that every check would take.
      # The test VLAN's card (52:54:00:12:01:01: the test finds it by that, its name can be eth0 or eth1) is the box's
      # cable, configured as any cable (none of the test framework's addresses, so the appliance's own DHCP network
      # takes it). Until the test brings the network's side up (`lan0` in `ap`) it gets no address: a cable that isn't
      # connected.
      virtualisation.qemu.networkingOptions = lib.mkForce [ ];
      networking.interfaces = lib.mkForce { };
      # The network's side of the cable: a second card on the same VLAN, moved into `ap` and bridged with Home.
      virtualisation.qemu.options = [
        "-device virtio-net-pci,netdev=lanside,mac=${lanMac}"
        ''-netdev vde,id=lanside,sock="$QEMU_VDE_SOCKET_1"''
      ];
      boot.kernelModules = [ "mac80211_hwsim" ];
      boot.extraModprobeConfig = "options mac80211_hwsim radios=4";
      environment.systemPackages = [
        api
        pkgs.iw
      ];
      environment.etc."whombat-fake-control/token".text = token;

      # The access points' side: the first three radios (hwsim's radio n has the address 02:00:00:00:0n:00) go into
      # the namespace `ap` before iwd starts, so iwd only ever sees the fourth.
      systemd.services.wifi-ap-netns = {
        wantedBy = [ "multi-user.target" ];
        requiredBy = [ "iwd.service" ];
        before = [ "iwd.service" ];
        after = [ "systemd-modules-load.service" ];
        path = [
          pkgs.iproute2
          pkgs.iw
          pkgs.coreutils
          pkgs.nftables
        ];
        serviceConfig = {
          Type = "oneshot";
          RemainAfterExit = true;
        };
        script = ''
          for _ in $(seq 100); do [ "$(ls /sys/class/ieee80211 | wc -l)" -ge 4 ] && break; sleep 0.1; done
          ip netns add ap
          for p in /sys/class/ieee80211/*; do
            [ "$(cat "$p/macaddress")" = 02:00:00:00:03:00 ] && continue
            iw phy "$(basename "$p")" set netns name ap
          done
          ip -n ap link set lo up
          # Home's network: its access point (hostapd adds wlan1) and the cable's other end, lan0, which stays down
          # (no cable) until the test plugs it in.
          ip -n ap link add br-home type bridge forward_delay 0 stp_state 0
          ip -n ap link set br-home up
          for _ in $(seq 100); do grep -qx ${lanMac} /sys/class/net/*/address && break; sleep 0.1; done
          for i in /sys/class/net/*; do
            if [ "$(cat "$i/address")" = ${lanMac} ]; then
              ip link set dev "$(basename "$i")" netns ap
              ip -n ap link set dev "$(basename "$i")" name lan0
            fi
          done
          ip -n ap link set lan0 master br-home
          ip -n ap addr add 10.77.0.1/24 dev wlan0
          ip -n ap addr add 10.78.0.1/24 dev br-home
          ip -n ap addr add 10.79.0.1/24 dev wlan2
          # The café has no way to control.
          ip netns exec ap nft -f - <<'EOF'
          table inet cafe {
            chain input {
              type filter hook input priority 0;
              iifname "wlan2" tcp dport { 4600, 8080 } reject with tcp reset
            }
          }
          EOF
        '';
      };
      systemd.services.wifi-ap-hostapd = apUnit {
        serviceConfig = inAp // {
          ExecStart = "${pkgs.hostapd}/bin/hostapd ${lib.concatStringsSep " " aps}";
        };
      };
      systemd.services.wifi-ap-dhcp = apUnit {
        after = [
          "wifi-ap-netns.service"
          "wifi-ap-hostapd.service"
        ];
        serviceConfig = inAp // {
          ExecStart = lib.concatStringsSep " " [
            "${pkgs.dnsmasq}/bin/dnsmasq --no-daemon --conf-file=/dev/null --port=0 --user=root --log-dhcp"
            "--interface=wlan0 --interface=br-home --interface=wlan2 --dhcp-leasefile=/run/wifi-ap-dhcp.leases"
            "--dhcp-range=10.77.0.10,10.77.0.99,1h --dhcp-range=10.78.0.10,10.78.0.99,1h --dhcp-range=10.79.0.10,10.79.0.99,1h"
          ];
          Restart = "on-failure";
          RestartSec = 1;
        };
      };
      systemd.services.wifi-ap-control = apUnit {
        serviceConfig = inAp // {
          ExecStart = "${pkgs.whombat-provision}/bin/whombat-fake-control --listen 0.0.0.0:4600 --token-file /etc/whombat-fake-control/token --env dev";
        };
      };
      systemd.services.wifi-ap-tuf = apUnit {
        serviceConfig = inAp // {
          ExecStart = "${pkgs.python3}/bin/python3 -m http.server 8080 --bind 0.0.0.0 --directory ${../release-tools/fixtures/dev}";
        };
      };
    };

  testScript = ''
    import json, re, shlex

    def api(path, body):
        out = machine.succeed(f"wb-api {path} {shlex.quote(json.dumps(body))}").rstrip("\n")
        text, _, code = out.rpartition("\n")
        return int(code), (json.loads(text) if text else {})

    def state():
        code, b = api("/v1/network/state", {"v": 1})
        assert code == 200, (code, b)
        return b["network"]

    def until(pred, what, timeout=240):
        for _ in range(timeout):
            n = state()
            if pred(n):
                return n
            machine.sleep(1)
        raise Exception(f"timed out waiting for {what}: {json.dumps(state())}")

    def cab():
        # The box's cable, by its address: the test framework's name for it can lose to the second card's.
        return machine.succeed("basename $(dirname $(grep -lx 52:54:00:12:01:01 /sys/class/net/*/address))").strip()

    def ended(n, change_id):
        c = n["change"]
        return c is not None and c["id"] == change_id and c["phase"] in ("committed", "reverted", "failed")

    def on(n, ssid):
        w = n["wifi"]
        return w is not None and w["state"] == "connected" and w.get("ssid") == ssid and "address" in w

    machine.start()
    machine.wait_for_unit("wifi-ap-netns.service")
    machine.wait_for_unit("wifi-ap-hostapd.service")
    machine.wait_for_unit("wifi-ap-dhcp.service")
    machine.wait_for_unit("wifi-ap-control.service")
    machine.wait_for_unit("iwd.service")
    machine.succeed("test $(ip netns exec ap iw dev | grep -c Interface) = 3")

    with subtest("a profile from the installer brings the box online over Wi-Fi, at route metric 600"):
        machine.succeed(
            "install -d -m 0700 /var/lib/iwd",
            "printf '[Security]\\nPassphrase=${officePass}\\n' > /var/lib/iwd/Office.psk",
            "chmod 0600 /var/lib/iwd/Office.psk",
        )
        machine.wait_until_succeeds("ip -4 -o addr show | grep -q 'inet 10.77.0.'", timeout=120)
        route = machine.succeed("ip route show default")
        print(route)
        assert "metric 600" in route and "10.77.0.1" in route, route

    with subtest("the box provisions over Wi-Fi"):
        station = json.dumps({
            "v": 1, "environment": "dev", "controlUrl": "http://10.77.0.1:4600", "tokenFile": "token",
            "model": "whombat-one", "requireSecureBoot": False,
            "factoryRelease": "rt-fixture-1", "seedHelper": False,
        })
        machine.succeed(
            "mkfs.vfat /dev/disk/by-id/virtio-factory",
            f"echo '{station}' > /tmp/station.json && mcopy -i /dev/disk/by-id/virtio-factory /tmp/station.json ::/station.json",
            "echo ${token} > /tmp/token && mcopy -i /dev/disk/by-id/virtio-factory /tmp/token ::/token",
            "fatlabel /dev/disk/by-id/virtio-factory WBFACTORY",
        )
        machine.wait_until_succeeds("test -e /persist/identity/device.json", timeout=180)
        machine.wait_for_unit("whombat-manager.service")
        machine.wait_until_succeeds("test -S /run/whombat-manager/api.sock", timeout=60)

    with subtest("the network state"):
        n = until(lambda n: n["online"] and on(n, "Office"), "online on Office")
        print(json.dumps(n))
        w = n["wifi"]
        assert w["address"].startswith("10.77.0."), w
        assert 0 <= w["signal"] <= 4, w
        assert w["saved"] == [{"ssid": "Office", "security": "psk"}], w
        assert n["checkedAt"] is not None and n["change"] is None, n
        assert len(n["wired"]) == 1 and n["wired"][0]["mac"] == "52:54:00:12:01:01" and not n["wired"][0]["connected"], n["wired"]
        assert n["wired"][0]["interface"] == cab() and n["wired"][0]["plugged"], n["wired"]
        iface = w["interface"]

    with subtest("a scan finds the networks"):
        code, b = api("/v1/network/wifi/scan", {"v": 1})
        assert code == 200, (code, b)
        nets = {x["ssid"]: x for x in b["scan"]["networks"]}
        print(json.dumps(nets))
        assert nets["Home"]["security"] == "psk" and not nets["Home"]["saved"], nets
        assert nets["Cafe"]["security"] == "open", nets
        assert nets["Office"]["connected"] and nets["Office"]["saved"], nets

    with subtest("a wrong password fails at once and keeps nothing"):
        code, b = api("/v1/network/wifi/join", {"v": 1, "ssid": "Home", "passphrase": "${wrongPass}", "confirmTimeoutSec": 120})
        assert code == 202 and b["change"]["phase"] == "applying" and b["change"]["previous"] == "Office", (code, b)
        cid = b["change"]["id"]
        n = until(lambda n: ended(n, cid), "the wrong password's end")
        assert n["change"]["phase"] == "failed" and n["change"]["failure"] == "wrong_password", n["change"]
        machine.succeed("test ! -e /var/lib/iwd/Home.psk")
        until(lambda n: on(n, "Office"), "back on Office")

    with subtest("the right password joins, gets an address and commits"):
        code, b = api("/v1/network/wifi/join", {"v": 1, "ssid": "Home", "passphrase": "${homePass}", "confirmTimeoutSec": 120})
        assert code == 202, (code, b)
        cid = b["change"]["id"]
        code, busy = api("/v1/network/wifi/join", {"v": 1, "ssid": "Cafe", "confirmTimeoutSec": 120})
        assert code == 409 and busy["error"]["code"] == "busy", (code, busy)
        n = until(lambda n: ended(n, cid), "the join's end")
        assert n["change"]["phase"] == "committed" and "failure" not in n["change"], n["change"]
        n = until(lambda n: on(n, "Home") and n["online"], "online on Home")
        assert n["wifi"]["address"].startswith("10.78.0."), n["wifi"]
        assert machine.succeed("stat -c '%U %a' /var/lib/iwd/Home.psk").strip() == "root 600"
        machine.fail("systemctl is-active whombat-wifi-revert.timer")

    with subtest("a network without internet: the join goes back and its profile goes"):
        code, b = api("/v1/network/wifi/join", {"v": 1, "ssid": "Cafe", "confirmTimeoutSec": 30})
        assert code == 202, (code, b)
        cid = b["change"]["id"]
        until(lambda n: n["change"] is not None and n["change"]["phase"] == "confirming" and on(n, "Cafe"), "confirming on Cafe")
        machine.succeed("systemctl is-active whombat-wifi-revert.timer")
        n = until(lambda n: ended(n, cid), "the café's end")
        assert n["change"]["phase"] == "reverted" and n["change"]["failure"] == "no_internet", n["change"]
        machine.succeed("test ! -e /var/lib/iwd/Cafe.open")
        until(lambda n: on(n, "Home") and n["online"], "back online on Home")
        machine.fail("systemctl is-active whombat-wifi-revert.timer")

    with subtest("forgetting: a saved network goes, the only connection stays"):
        code, b = api("/v1/network/wifi/forget", {"v": 1, "ssid": "Office"})
        assert code == 202 and b["change"]["kind"] == "forget", (code, b)
        cid = b["change"]["id"]
        n = until(lambda n: ended(n, cid), "the forget's end")
        assert n["change"]["phase"] == "committed", n["change"]
        machine.succeed("test ! -e /var/lib/iwd/Office.psk")
        assert [s["ssid"] for s in n["wifi"]["saved"]] == ["Home"], n["wifi"]
        code, b = api("/v1/network/wifi/forget", {"v": 1, "ssid": "Home"})
        assert code == 409 and b["error"]["code"] == "in_use", (code, b)
        code, b = api("/v1/network/wifi/forget", {"v": 1, "ssid": "Office"})
        assert code == 404 and b["error"]["code"] == "not_saved", (code, b)

    with subtest("the passphrases are in no log and no state but iwd's"):
        for p in ["${officePass}", "${homePass}", "${wrongPass}"]:
            machine.fail(f"journalctl --no-pager | grep -F -- {p}")
            machine.fail(f"grep -rF -- {p} /persist/manager /var/lib/whombat-update-helper")
        machine.succeed("grep -q PreSharedKey= /var/lib/iwd/Home.psk || grep -q Passphrase= /var/lib/iwd/Home.psk")
        print(machine.succeed(f"iw dev {iface} link"))

    def cable(body):
        return api("/v1/network/cable", {"v": 1, **body})

    def cable_ended(n, change_id):
        c = n.get("cableChange")
        return c is not None and c["id"] == change_id and c["phase"] in ("committed", "reverted", "failed")

    def default_route():
        r = machine.succeed("ip -4 route show default").strip().splitlines()
        print(r)
        return r[0] if r else ""

    def answers(addr):
        # A TCP connection from Home's network to the box's direct port (open from the local network on its cable
        # and Wi-Fi): connected, or refused when nothing listens there. Both mean the address answered.
        machine.succeed(
            f"ip netns exec ap ${pkgs.curl}/bin/curl -s -o /dev/null --connect-timeout 5 http://{addr}:4480/; "
            + "rc=$?; [ $rc = 0 ] || [ $rc = 7 ] || [ $rc = 52 ] || [ $rc = 56 ] || { echo curl $rc; exit 1; }"
        )

    def cable_up():
        machine.succeed("ip -n ap link set lan0 up", f"networkctl reconfigure {cab()}")
        machine.wait_until_succeeds(f"ip -4 -o addr show dev {cab()} | grep -q 'inet 10.78.0.'", timeout=120)
        machine.wait_until_succeeds(f"ip -4 route show default | head -1 | grep -q 'dev {cab()}'", timeout=60)

    with subtest("a cable on the Wi-Fi's network: the Wi-Fi address answers while the cable carries the default route"):
        cable_up()
        r = default_route()
        assert f"dev {cab()}" in r and "metric 100" in r, r
        n = until(lambda n: on(n, "Home") and n["online"] and n["wired"][0]["connected"], "the cable and Wi-Fi on Home")
        print(json.dumps(n))
        w, e = n["wifi"], n["wired"][0]
        assert n["wifiOnly"] is False and n.get("cableChange") is None, n
        assert e["interface"] == cab() and e["plugged"] and e["address"].startswith("10.78.0.") and e["prefixLength"] == 24, e
        assert e["mac"] == "52:54:00:12:01:01", e
        assert w["address"].startswith("10.78.0.") and w["prefixLength"] == 24 and re.fullmatch(r"[0-9a-f]{2}(:[0-9a-f]{2}){5}", w["mac"]), w
        machine.succeed("sysctl -n net.ipv4.conf.all.rp_filter | grep -qx 2")
        if machine.execute("ss -ltn | grep -q ':4480 '")[0] != 0:
            machine.succeed("systemd-run --unit=wb-probe ${pkgs.python3}/bin/python3 -m http.server 4480 --bind 0.0.0.0")
            machine.wait_until_succeeds("ss -ltn | grep -q ':4480 '")
        answers(w["address"])
        answers(e["address"])
        code, b = cable({"use": "cable", "confirmTimeoutSec": 60})
        assert code == 409 and b["error"]["code"] == "unchanged", (code, b)

    with subtest("Use Wi-Fi only, with Wi-Fi that can't reach control: it goes back and the cable gets its address back"):
        wifi_addr = state()["wifi"]["address"]
        machine.succeed(
            "ip netns exec ap nft add table inet nocontrol",
            "ip netns exec ap nft add chain inet nocontrol input '{ type filter hook input priority 0; }'",
            f"ip netns exec ap nft add rule inet nocontrol input ip saddr {wifi_addr} tcp dport 4600 reject with tcp reset",
        )
        code, b = cable({"use": "wifi", "confirmTimeoutSec": 30})
        assert code == 202 and b["change"]["use"] == "wifi" and b["change"]["by"] == "person", (code, b)
        cid = b["change"]["id"]
        until(lambda n: n["cableChange"] is not None and n["cableChange"]["phase"] == "confirming", "confirming on Wi-Fi only")
        machine.succeed("systemctl is-active whombat-cable-revert.timer")
        machine.wait_until_succeeds(f"test -z \"$(ip -4 -o addr show dev {cab()})\"", timeout=30)
        n = until(lambda n: cable_ended(n, cid), "Wi-Fi only's end")
        assert n["cableChange"]["phase"] == "reverted" and n["cableChange"]["failure"] == "no_internet", n["cableChange"]
        assert n["wifiOnly"] is False, n
        machine.wait_until_succeeds(f"ip -4 -o addr show dev {cab()} | grep -q 'inet 10.78.0.'", timeout=120)
        machine.fail("systemctl is-active whombat-cable-revert.timer")
        machine.succeed("test ! -e /var/lib/whombat-update-helper/network/cable-off.network")
        machine.succeed("ip netns exec ap nft delete table inet nocontrol")
        until(lambda n: n["online"], "online again")

    with subtest("Use Wi-Fi only is kept: the cable keeps its carrier but no address, Wi-Fi carries the default route"):
        code, b = cable({"use": "wifi", "confirmTimeoutSec": 60})
        assert code == 202, (code, b)
        cid = b["change"]["id"]
        code, busy = cable({"use": "wifi", "confirmTimeoutSec": 60})
        assert code == 409 and busy["error"]["code"] == "busy", (code, busy)
        n = until(lambda n: cable_ended(n, cid), "Wi-Fi only's end")
        print(json.dumps(n))
        assert n["cableChange"]["phase"] == "committed" and "failure" not in n["cableChange"], n["cableChange"]
        e = n["wired"][0]
        assert n["wifiOnly"] is True and e["plugged"] and not e["connected"] and "address" not in e, n
        # No address at all, not even a link-local one; the link is up and sees its carrier.
        machine.wait_until_succeeds(f"test -z \"$(ip -o addr show dev {cab()})\"", timeout=30)
        machine.succeed(f"ip link show dev {cab()} | grep -q LOWER_UP")
        r = default_route()
        assert f"dev {cab()}" not in r and f"dev {iface}" in r, r
        machine.succeed("test -e /var/lib/whombat-update-helper/network/cable-off.network")
        machine.fail("systemctl is-active whombat-cable-revert.timer")
        code, b = cable({"use": "wifi", "confirmTimeoutSec": 60})
        assert code == 409 and b["error"]["code"] == "unchanged", (code, b)

    with subtest("Wi-Fi only lasts across a restart"):
        machine.shutdown()
        machine.start()
        machine.wait_for_unit("whombat-manager.service")
        machine.wait_until_succeeds("test -S /run/whombat-manager/api.sock", timeout=60)
        machine.succeed("systemctl is-active whombat-cable-restore.service")
        machine.succeed("ip -n ap link set lan0 up", f"networkctl reconfigure {cab()}")
        n = until(lambda n: on(n, "Home") and n["online"], "online on Home after the restart")
        assert n["wifiOnly"] is True and n["wired"][0]["plugged"] and not n["wired"][0]["connected"], n
        machine.succeed(f"test -z \"$(ip -o addr show dev {cab()})\"")

    with subtest("Use the cable again: the cable gets its address and the default route back"):
        code, b = cable({"use": "cable", "confirmTimeoutSec": 60})
        assert code == 202 and b["change"]["use"] == "cable", (code, b)
        cid = b["change"]["id"]
        n = until(lambda n: cable_ended(n, cid), "the cable's end")
        assert n["cableChange"]["phase"] == "committed", n["cableChange"]
        assert n["wifiOnly"] is False, n
        machine.wait_until_succeeds(f"ip -4 -o addr show dev {cab()} | grep -q 'inet 10.78.0.'", timeout=120)
        machine.wait_until_succeeds(f"ip -4 route show default | head -1 | grep -q 'dev {cab()}'", timeout=60)
        r = default_route()
        assert "metric 100" in r, r
        machine.succeed("test ! -e /var/lib/whombat-update-helper/network/cable-off.network")
  '';
}
