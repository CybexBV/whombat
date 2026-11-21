# Tailscale in the image and the direct port (Whombat HE-50, HE-51; NX-440…NX-443), on an unprovisioned appliance next
# to a LAN host (the direct listener is the runtime's; a stand-in listens on the port here, as the runtime's user):
#   - tailscaled runs signed out (no login link, no addresses, not wanting to run), no auth key anywhere, its state on
#     /persist/tailscale (0700 root) and nothing in /var/lib/tailscale; tailscale0 exists; Tailscale SSH, Taildrop and log
#     uploads are off; a restart stays signed out and sets the operator again
#   - its local API: root and the operator (the manager, contracts CT-1255) only — the socket's directory is 0750
#     root:whombat-manager, the manager changes a pref, the runtime server, the runner and nobody can't connect; Tailscale
#     SSH can't be turned on
#   - the manager's code (`whombat-manager tailscale`, MG-130) reads the state, turns it on (starting: no tailnet in a
#     VM) and off, refuses a certificate while it isn't on; as the runtime's user it reaches nothing
#   - the runtime server gets the direct port and where it takes connections (`lan,tailscale0`), no tailscaled socket;
#     the runner none of them
#   - the direct port answers the LAN host from private addresses (IPv4, ULA); not from a public address or CGNAT's
#     100.64.0.0/10 on the LAN, and no other port is open; the firewall opens it on tailscale0 too
#   - egress: UDP from tailscaled's port leaves for root only (WireGuard, STUN); root from another port doesn't
#   - the box's own networks come before Tailscale's routes (NX-487): a table-52 route for the LAN leaves the LAN on its
#     link, and networkd starting again keeps the rule; Whombat's own names go to the LAN's resolvers (NX-488); on
#     clears what the box doesn't keep and accepts the tailnet's routes (MG-138, MG-140)
{
  applianceModules,
  pkgs,
  lib,
  ...
}:
let
  lanV4 = "192.168.1.1"; # the lan node's test-network address (node 1); the machine is 192.168.1.2
  lanV6 = "fd42:0:0:1::1";
  machineV6 = "fd42:0:0:1::2";
  # Public and CGNAT addresses on the same link: a box on such a network keeps the direct port closed to them.
  pubV4 = "81.10.0.1";
  machinePubV4 = "81.10.0.2";
  pubV6 = "2a01:4f8:0:1::1";
  machinePubV6 = "2a01:4f8:0:1::2";
  cgnatV4 = "100.64.7.1";
  machineCgnatV4 = "100.64.7.2";

  # An echo server on a port, dual-stack.
  echo = pkgs.writeText "echo.py" ''
    import socket, socketserver, sys

    class Echo(socketserver.StreamRequestHandler):
        def handle(self):
            for line in self.rfile:
                self.wfile.write(line)
                self.wfile.flush()

    class Server(socketserver.ThreadingTCPServer):
        address_family = socket.AF_INET6
        allow_reuse_address = True
        daemon_threads = True

        def server_bind(self):
            self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
            super().server_bind()

    Server(("::", int(sys.argv[1])), Echo).serve_forever()
  '';

  # probe SOURCE HOST PORT: exit 0 when a line comes back within 3 s, from SOURCE.
  probe = pkgs.writeText "probe.py" ''
    import socket, sys
    s = socket.create_connection((sys.argv[2], int(sys.argv[3])), timeout=3, source_address=(sys.argv[1], 0))
    s.sendall(b"ping\n")
    assert s.recv(16) == b"ping\n"
  '';

  # UDP echo on a port, dual-stack.
  udpEcho = pkgs.writeText "udp-echo.py" ''
    import socket, sys
    s = socket.socket(socket.AF_INET6, socket.SOCK_DGRAM)
    s.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
    s.bind(("::", int(sys.argv[1])))
    while True:
        data, addr = s.recvfrom(512)
        s.sendto(data, addr)
  '';

  # udp SPORT HOST PORT: exit 0 when the datagram comes back within 3 s.
  udp = pkgs.writeText "udp.py" ''
    import socket, sys
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.bind(("0.0.0.0", int(sys.argv[1])))
    s.settimeout(3)
    s.sendto(b"stun?", (sys.argv[2], int(sys.argv[3])))
    data, _ = s.recvfrom(64)
    assert data == b"stun?"
  '';
in
{
  name = "whombat-tailscale-direct";

  nodes = {
    lan =
      { pkgs, lib, ... }:
      {
        networking.interfaces.eth1.ipv4.addresses = lib.mkAfter [
          {
            address = pubV4;
            prefixLength = 24;
          }
          {
            address = cgnatV4;
            prefixLength = 24;
          }
        ];
        networking.interfaces.eth1.ipv6.addresses = lib.mkAfter [
          {
            address = lanV6;
            prefixLength = 64;
          }
          {
            address = pubV6;
            prefixLength = 64;
          }
        ];
        networking.firewall.allowedUDPPorts = [ 3478 ];
        systemd.services.udp-echo = {
          wantedBy = [ "multi-user.target" ];
          serviceConfig.ExecStart = "${pkgs.python3}/bin/python3 ${udpEcho} 3478";
        };
      };
    machine =
      { lib, ... }:
      {
        imports = applianceModules ++ [ (import ./common/appliance-vm.nix { serial = "SN-TAILSCALE-0001"; }) ];
        networking.interfaces.eth1.ipv4.addresses = lib.mkAfter [
          {
            address = machinePubV4;
            prefixLength = 24;
          }
          {
            address = machineCgnatV4;
            prefixLength = 24;
          }
        ];
        networking.interfaces.eth1.ipv6.addresses = lib.mkAfter [
          {
            address = machineV6;
            prefixLength = 64;
          }
          {
            address = machinePubV6;
            prefixLength = 64;
          }
        ];
      };
  };

  testScript =
    { nodes, ... }:
    ''
    import json

    PY = "${pkgs.python3}/bin/python3"

    def status():
        return json.loads(machine.succeed("tailscale status --json --peers=false"))

    def prefs():
        return json.loads(machine.succeed("tailscale debug prefs"))

    def stat(path):
        return machine.succeed(f"stat -c '%a %U %G' {path}").strip()

    def reaches(source, host, port):
        rc, _ = lan.execute(f"{PY} ${probe} {source} {host} {port}")
        return rc == 0

    def udp_back(user, sport):
        rc, _ = machine.execute(f"runuser -u {user} -- {PY} ${udp} {sport} ${pubV4} 3478")
        return rc == 0

    start_all()
    lan.wait_for_unit("udp-echo.service")
    machine.wait_for_unit("multi-user.target")
    machine.wait_for_unit("tailscaled.service")
    # Every address answers before anything is probed (IPv6 duplicate address detection is done; the appliance answers
    # no IPv4 ping, so it pings the lan node's IPv4 addresses itself).
    for host in ["${machineV6}", "${machinePubV6}"]:
        lan.wait_until_succeeds(f"ping -c1 -W1 {host}", timeout=60)
    for host in ["${lanV4}", "${pubV4}", "${cgnatV4}", "${lanV6}", "${pubV6}"]:
        machine.wait_until_succeeds(f"ping -c1 -W1 {host}", timeout=60)

    with subtest("tailscaled: running, signed out, its state on /persist"):
        machine.wait_until_succeeds("tailscale status --json --peers=false", timeout=30)
        st = status()
        assert st["BackendState"] in ("NoState", "NeedsLogin", "Stopped"), st["BackendState"]
        assert st.get("AuthURL", "") == "", st.get("AuthURL")
        assert not st.get("TailscaleIPs"), st.get("TailscaleIPs")
        p = prefs()
        assert not p["WantRunning"], p
        assert not p.get("RunSSH"), p
        machine.wait_until_succeeds("test -s /persist/tailscale/tailscaled.state", timeout=30)
        assert stat("/persist/tailscale") == "700 root root", stat("/persist/tailscale")
        # The upstream unit's /var/lib/tailscale is only a mount point inside the unit.
        assert machine.succeed("ls -A /var/lib/tailscale").strip() == ""
        machine.succeed("ip link show tailscale0")
        env = machine.succeed("systemctl show -P Environment tailscaled")
        for knob in ["TS_DISABLE_SSH_SERVER=1", "TS_DISABLE_TAILDROP=true", "TS_NO_LOGS_NO_SUPPORT=true"]:
            assert knob in env, env
        # No auth key and nothing that signs in at boot.
        assert "auth" not in env.lower(), env
        machine.fail("systemctl cat tailscaled-autoconnect.service")
        machine.fail("systemctl cat tailscaled-set.service")

    with subtest("the local API: root and the operator, nobody else"):
        assert stat("/run/tailscale") == "750 root whombat-manager", stat("/run/tailscale")
        machine.wait_until_succeeds("tailscale debug prefs | jq -e '.OperatorUser == \"whombat-manager\"'", timeout=30)
        sock = "--socket=/run/tailscale/tailscaled.sock"
        machine.succeed(f"runuser -u whombat-manager -- tailscale {sock} status --json --peers=false")
        machine.succeed(f"runuser -u whombat-manager -- tailscale {sock} set --hostname=whombat-test")
        assert prefs()["Hostname"] == "whombat-test"
        # Tailscale SSH can't be turned on, not even by root: no way into the box through the tailnet.
        machine.fail(f"runuser -u whombat-manager -- tailscale {sock} set --ssh")
        machine.fail("tailscale set --ssh")
        assert not prefs().get("RunSSH")
        for user in ["whombat", "whombat-runner", "nobody"]:
            machine.fail(f"runuser -u {user} -- tailscale {sock} status --json --peers=false")

    with subtest("the manager drives it for the runtime (MG-130): state, on, off, no certificate while off"):
        mgr = "${nodes.machine.whombat.manager.package}/bin/whombat-manager --config /etc/whombat/manager.json tailscale"
        def ts(cmd, user="whombat-manager"):
            return json.loads(machine.succeed(f"runuser -u {user} -- {mgr} {cmd}"))
        assert ts("state")["state"] == "off", ts("state")
        # What root set that the box doesn't keep (MG-138): on puts it back, in the real tailscaled's own prefs.
        machine.succeed("tailscale set --advertise-routes=10.9.0.0/24 --webclient --shields-up")
        # No tailnet reachable from a VM: on asks for a login link that doesn't come, and says it is starting. A VM with a
        # way out (the driver run outside a build sandbox) gets Tailscale's link instead, which nobody opens.
        st = ts("on")
        offline = st["state"] == "starting" and st["loginUrl"] is None
        linked = st["state"] == "needs_sign_in" and (st["loginUrl"] or "").startswith("https://login.tailscale.com/")
        assert offline or linked, st
        p = prefs()
        assert p["WantRunning"]
        assert not p.get("AdvertiseRoutes") and not p.get("RunWebClient") and not p.get("ShieldsUp"), p
        assert p.get("ExitNodeID", "") == "" and p.get("ExitNodeIP", "") == "", p
        # The tailnet's routes accepted (MG-140; the box's own networks still first, NX-487); no devices while not on.
        assert p["RouteAll"], p
        assert ts("peers") == [], ts("peers")
        machine.fail(f"runuser -u whombat-manager -- {mgr} cert")
        st = ts("off")
        assert st["state"] == "off", st
        assert not prefs()["WantRunning"]
        # The runtime's user doesn't reach tailscaled, even with the manager's code.
        st = ts("state", user="whombat")
        assert st["state"] == "error" and st["problem"] == "failed", st

    with subtest("the runtime server's environment"):
        env = machine.succeed("systemctl show -P Environment whombat-server")
        for item in [
            "WHOMBAT_DIRECT_PORT=4480",
            "WHOMBAT_DIRECT_INTERFACES=lan,tailscale0",
        ]:
            assert item in env.split(), (item, env)
        runner = machine.succeed("systemctl show -P Environment whombat-runner")
        assert "TAILSCALE" not in env, env
        for name in ["WHOMBAT_DIRECT_"]:
            assert name not in runner, runner

    with subtest("the direct port: the local network and tailscale0, nothing else"):
        machine.succeed("systemd-run --unit=direct-4480 -p User=whombat ${pkgs.python3}/bin/python3 ${echo} 4480")
        machine.succeed("systemd-run --unit=other-4481 -p User=whombat ${pkgs.python3}/bin/python3 ${echo} 4481")
        machine.wait_for_open_port(4480)
        machine.wait_for_open_port(4481)
        assert reaches("${lanV4}", "192.168.1.2", 4480)
        assert reaches("${lanV6}", "${machineV6}", 4480)
        assert not reaches("${lanV4}", "192.168.1.2", 4481)
        assert not reaches("${lanV6}", "${machineV6}", 4481)
        # A public address and CGNAT on the LAN: closed, as before (NX-22).
        assert not reaches("${pubV4}", "${machinePubV4}", 4480)
        assert not reaches("${pubV6}", "${machinePubV6}", 4480)
        assert not reaches("${cgnatV4}", "${machineCgnatV4}", 4480)
        rules = machine.succeed("nft list ruleset")
        assert 'iifname "tailscale0" tcp dport 4480 accept' in rules, rules

    with subtest("the box's own networks before the tailnet's routes (NX-487)"):
        for family in ["-4", "-6"]:
            rule = machine.succeed(f"ip {family} rule show priority 5200")
            assert "lookup main suppress_prefixlength 0" in rule, rule
        machine.succeed("grep -qx 'ManageForeignRoutingPolicyRules=false' /etc/systemd/networkd.conf")
        # Tailscale's table 52 with a route for this LAN (a subnet router at home) and one for another network, on a
        # stand-in link: the LAN stays on eth1, the other network goes to the tailnet, the direct port still answers.
        machine.succeed(
            "ip link add tsfake type dummy && ip link set tsfake up",
            "ip route add 192.168.1.0/24 dev tsfake table 52 && ip route add 10.2.2.0/24 dev tsfake table 52",
            "ip -6 route add fd42:0:0:1::/64 dev tsfake table 52",
            "ip rule add priority 5271 lookup 52 && ip -6 rule add priority 5271 lookup 52",
        )
        assert "dev eth1" in machine.succeed("ip route get ${lanV4}")
        assert "dev eth1" in machine.succeed("ip -6 route get ${lanV6}")
        assert "dev tsfake" in machine.succeed("ip route get 10.2.2.1")
        assert reaches("${lanV4}", "192.168.1.2", 4480)
        assert reaches("${lanV6}", "${machineV6}", 4480)
        # networkd starting again leaves the rule (and Tailscale's) where it was.
        machine.succeed("systemctl restart systemd-networkd")
        machine.wait_for_unit("systemd-networkd.service")
        assert "suppress_prefixlength 0" in machine.succeed("ip -4 rule show priority 5200")
        assert "lookup 52" in machine.succeed("ip -4 rule show priority 5271")
        machine.succeed("ip rule del priority 5271 && ip -6 rule del priority 5271 && ip link del tsfake")
        machine.succeed("systemctl stop direct-4480 other-4481")

    with subtest("Whombat's own names by the local network's resolvers (NX-488)"):
        net = machine.succeed("cat /etc/systemd/network/90-whombat-default.network")
        assert "Domains=~whombat.com" in net and "DNSDefaultRoute=true" in net, net
        env = machine.succeed("systemctl show -P Environment whombat-dns-fallback")
        assert "WHOMBAT_OWN_DNS_DOMAINS=whombat.com" in env, env

    with subtest("tailscaled's egress: UDP from its port, root only"):
        machine.succeed("systemctl stop tailscaled")
        # Root's datagram from 41641 last: its answer would make the same addresses and ports an established flow.
        assert not udp_back("whombat", 41641)
        assert not udp_back("whombat-manager", 41641)
        assert not udp_back("root", 41642)
        assert udp_back("root", 41641)

    with subtest("a restart stays signed out, the operator set again"):
        # A box that never signed in has no profile, so its prefs aren't kept: the unit sets the operator at every start.
        machine.succeed("systemctl start tailscaled")
        machine.wait_until_succeeds("tailscale status --json --peers=false", timeout=30)
        machine.wait_until_succeeds("tailscale debug prefs | jq -e '.OperatorUser == \"whombat-manager\"'", timeout=30)
        machine.succeed("test -s /persist/tailscale/tailscaled.state")
        st = status()
        assert st["BackendState"] in ("NoState", "NeedsLogin", "Stopped"), st["BackendState"]
        assert not st.get("TailscaleIPs")
        assert stat("/run/tailscale") == "750 root whombat-manager", stat("/run/tailscale")
  '';
}
