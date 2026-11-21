# The Vault's home networks in the egress firewall (Whombat VT-59; IN-58…IN-61, NX-40), on an unprovisioned
# appliance (the wall does not depend on the runtime; the test writes the file as the runtime's user):
#   - /run/whombat-vault is the runtime's (0755 whombat:whombat); the server gets WHOMBAT_VAULT_NETWORKS_FILE
#   - whombat-vault-wall runs as a dynamic user with CAP_NET_ADMIN only
#   - no file: empty sets, nothing on the LAN reachable
#   - a listed address and port (IPv4 and IPv6 ULA) is reachable from the whombat uid; the same port on an
#     unlisted address and another port on the listed address are not; other uids (runner, nobody, the manager)
#     gain nothing; root reaches private addresses on any TCP port, listed or not (tailscaled's own login server on
#     the local network, on every box with Tailscale)
#   - covered and duplicate networks are merged (an interval set refuses overlaps)
#   - removing the entry closes it again, including a connection that was already open; a change that keeps it
#     leaves that connection alone
#   - every malformed or never-listable file empties the sets (and says why); so do a symlink, a file owned by
#     another user and a file others can write
#   - a reload or restart of nftables.service refills the sets; stopping the wall empties them
#   - SSH from the Vault (VT-S14; IN-150, NX-128): the server gets WHOMBAT_VAULT_SSH_PORTS from whombat.vault.sshPorts
#     (here 22 and 2200), and its uid alone reaches a public address (IPv4 and IPv6) on those ports; another port, a
#     private address (192.168.1.1, ULA) on 22 and every other uid (runner, root, nobody, a sandbox) are
#     refused; a private address on 22 opens only once the admins list it as a home network
{
  applianceModules,
  pkgs,
  lib,
  ...
}:
let
  lanV4 = "192.168.1.1"; # the lan node's test-network address (node 1)
  otherV4 = "192.168.1.50"; # a second address on the same host, never listed
  lanV6 = "fd42:0:0:1::1";
  otherV6 = "fd42:0:0:1::50";
  # Public-looking addresses on the same link for the SSH ports (VT-S14): neither in a non-public range nor listed.
  pubV4 = "81.10.0.1";
  pubV6 = "2a01:4f8:0:1::1";

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

  # probe HOST PORT: exit 0 when a line comes back within 3 s.
  probe = pkgs.writeText "probe.py" ''
    import socket, sys
    s = socket.create_connection((sys.argv[1], int(sys.argv[2])), timeout=3)
    s.sendall(b"ping\n")
    assert s.recv(16) == b"ping\n"
  '';

  # hold HOST PORT STATE: open a connection, echo once, write STATE.up, wait for STATE.go, echo again and write
  # the outcome to STATE.result (open, reset, closed, timeout or the error).
  hold = pkgs.writeText "hold.py" ''
    import os, socket, sys, time
    host, port, state = sys.argv[1], int(sys.argv[2]), sys.argv[3]
    s = socket.create_connection((host, port), timeout=5)
    s.sendall(b"one\n")
    assert s.recv(16) == b"one\n"
    open(state + ".up", "w").close()
    while not os.path.exists(state + ".go"):
        time.sleep(0.1)
    try:
        s.sendall(b"two\n")
        s.settimeout(5)
        data = s.recv(16)
        result = "open" if data == b"two\n" else ("closed" if data == b"" else "other")
    except ConnectionResetError:
        result = "reset"
    except socket.timeout:
        result = "timeout"
    except OSError as e:
        result = "error " + str(e)
    with open(state + ".result", "w") as f:
        f.write(result)
  '';
in
{
  name = "whombat-vault-wall";

  nodes = {
    lan =
      { pkgs, lib, ... }:
      {
        networking.interfaces.eth1.ipv4.addresses = lib.mkAfter [
          {
            address = otherV4;
            prefixLength = 24;
          }
          {
            address = pubV4;
            prefixLength = 24;
          }
        ];
        networking.interfaces.eth1.ipv6.addresses = lib.mkAfter [
          {
            address = lanV6;
            prefixLength = 64;
          }
          {
            address = otherV6;
            prefixLength = 64;
          }
          {
            address = pubV6;
            prefixLength = 64;
          }
        ];
        networking.firewall.allowedTCPPorts = [
          8123
          8124
          22
          2200
          2201
        ];
        systemd.services = lib.genAttrs [ "echo8123" "echo8124" "echo22" "echo2200" "echo2201" ] (name: {
          wantedBy = [ "multi-user.target" ];
          serviceConfig.ExecStart = "${pkgs.python3}/bin/python3 ${echo} ${lib.removePrefix "echo" name}";
        });
      };
    machine =
      { lib, ... }:
      {
        imports = applianceModules ++ [ (import ./common/appliance-vm.nix { serial = "SN-VAULT-0001"; }) ];
        # The closed wall this test checks: only the Vault's list opens private addresses (NX-144 opens the rest).
        whombat.network.localNetwork = false;
        networking.interfaces.eth1.ipv4.addresses = lib.mkAfter [
          {
            address = "81.10.0.2";
            prefixLength = 24;
          }
        ];
        networking.interfaces.eth1.ipv6.addresses = lib.mkAfter [
          {
            address = "fd42:0:0:1::2";
            prefixLength = 64;
          }
          {
            address = "2a01:4f8:0:1::2";
            prefixLength = 64;
          }
        ];
        # Two SSH ports, so the test sees the option reach both the wall and the server's environment (VT-S14).
        whombat.vault.sshPorts = [
          2200
          22
        ];
        # No periodic re-apply during the test: reload and restart must refill the sets on their own.
        whombat.vaultWall.resyncSec = 3600;
      };
  };

  testScript = ''
    import json, shlex

    PY = "${pkgs.python3}/bin/python3"

    VAULT = "/run/whombat-vault"
    FILE = VAULT + "/networks.json"

    def elements(fam):
        out = json.loads(machine.succeed(f"nft -j list set inet whombat-egress vault{fam}"))
        for item in out["nftables"]:
            if "set" in item:
                return item["set"].get("elem", [])
        raise Exception(out)

    def count():
        return len(elements(4)) + len(elements(6))

    def put(content, user="whombat", mode="0644"):
        # As the runtime does it: a temp file in the same directory, then rename (VT-59).
        tmp = VAULT + "/.networks.json.tmp"
        inner = f"printf %s {shlex.quote(content)} > {tmp} && chmod {mode} {tmp} && mv -f {tmp} {FILE}"
        machine.succeed(f"runuser -u {user} -- sh -c {shlex.quote(inner)}")

    def lst(*nets):
        return json.dumps({"version": 1, "networks": [{"cidr": c, "ports": p} for c, p in nets]})

    def reaches(user, host, port):
        rc, _ = machine.execute(f"runuser -u {user} -- {PY} ${probe} {host} {port}")
        return rc == 0

    def wait_count(n):
        q = "[.nftables[].set.elem // empty | length] | add // 0"
        n4 = f"$(nft -j list set inet whombat-egress vault4 | jq '{q}')"
        n6 = f"$(nft -j list set inet whombat-egress vault6 | jq '{q}')"
        machine.wait_until_succeeds(f"test $(( {n4} + {n6} )) -eq {n}", timeout=30)

    def wait_log(text, last_refusal=False):
        pick = "grep refused | tail -1 | " if last_refusal else ""
        machine.wait_until_succeeds(
            f"journalctl -u whombat-vault-wall --no-pager -o cat | {pick}grep -qF -- {shlex.quote(text)}", timeout=30
        )

    GOOD = lst(("${lanV4}/32", [8123]), ("${lanV6}/128", [8123]))

    start_all()
    lan.wait_for_unit("echo8123.service")
    lan.wait_for_unit("echo8124.service")
    lan.wait_for_open_port(8123)
    lan.wait_for_open_port(8124)
    for port in [22, 2200, 2201]:
        lan.wait_for_open_port(port)
    # The echo servers answer on every address (checked on the lan node itself), and the machine reaches all
    # of them at the network level (ICMP is allowed for every uid; IPv6 duplicate address detection is done).
    for host in ["${lanV4}", "${otherV4}", "${lanV6}", "${otherV6}"]:
        lan.wait_until_succeeds(f"{PY} ${probe} {host} 8123 && {PY} ${probe} {host} 8124", timeout=60)
        machine.wait_until_succeeds(f"ping -c1 -W1 {host}", timeout=60)
    for host in ["${pubV4}", "${pubV6}"]:
        lan.wait_until_succeeds(f"{PY} ${probe} {host} 22 && {PY} ${probe} {host} 2201", timeout=60)
        machine.wait_until_succeeds(f"ping -c1 -W1 {host}", timeout=60)
    machine.wait_for_unit("multi-user.target")
    machine.wait_for_unit("whombat-vault-wall.service")

    with subtest("layout: the runtime's directory and environment, the wall's credentials"):
        assert machine.succeed(f"stat -c '%a %U %G' {VAULT}").strip() == "755 whombat whombat"
        env = machine.succeed("systemctl show -P Environment whombat-server")
        assert f"WHOMBAT_VAULT_NETWORKS_FILE={FILE}" in env, env
        assert VAULT in machine.succeed("systemctl show -P ReadWritePaths whombat-server")
        assert "WHOMBAT_VAULT" not in machine.succeed("systemctl show -P Environment whombat-runner")
        machine.fail(f"runuser -u whombat-runner -- touch {VAULT}/x")
        machine.fail(f"runuser -u nobody -- touch {VAULT}/x")
        pid = machine.succeed("systemctl show -P MainPID whombat-vault-wall").strip()
        status = machine.succeed(f"cat /proc/{pid}/status")
        uid = [l for l in status.splitlines() if l.startswith("Uid:")][0].split()[1]
        assert uid not in ("0", "951"), status
        capeff = [l for l in status.splitlines() if l.startswith("CapEff:")][0].split()[1]
        assert int(capeff, 16) == 1 << 12, f"CapEff {capeff}: CAP_NET_ADMIN only"
        assert machine.succeed("systemctl show -P NoNewPrivileges whombat-vault-wall").strip() == "yes"

    with subtest("no file: empty sets, nothing on the LAN for anyone"):
        machine.succeed(f"test ! -e {FILE}")
        assert count() == 0
        assert not reaches("whombat", "${lanV4}", 8123)
        wait_log("no Vault networks")

    with subtest("SSH from the Vault: the server's uid on the SSH ports, public addresses only (VT-S14)"):
        env = machine.succeed("systemctl show -P Environment whombat-server")
        assert "WHOMBAT_VAULT_SSH_PORTS=22,2200 " in env + " ", env
        assert count() == 0
        for host in ["${pubV4}", "${pubV6}"]:
            for port in [22, 2200]:
                assert reaches("whombat", host, port), (host, port)
            # A port that isn't listed (and isn't otherwise open).
            assert not reaches("whombat", host, 2201), host
            # Other uids gain nothing: not the runner, root, nobody or the manager.
            for user in ["whombat-runner", "root", "nobody", "whombat-manager"]:
                assert not reaches(user, host, 22), (user, host)
            rc, _ = machine.execute(f"setpriv --reuid=2000001 --regid=2000001 --clear-groups {PY} ${probe} {host} 22")
            assert rc != 0, "a sandbox uid reached a public SSH port"
        # A private address on 22 that isn't a listed home network: refused, IPv4 and IPv6 (ULA).
        for host in ["${lanV4}", "${otherV4}", "${lanV6}"]:
            assert not reaches("whombat", host, 22), host
        # Listed by the admins (VT-12), it opens for the server only, through the home-network sets.
        put(lst(("${lanV4}/32", [22])))
        wait_count(1)
        assert reaches("whombat", "${lanV4}", 22)
        assert not reaches("whombat", "${otherV4}", 22)
        assert not reaches("whombat-runner", "${lanV4}", 22)
        put(lst())
        wait_count(0)
        assert not reaches("whombat", "${lanV4}", 22)

    with subtest("a listed address and port is reachable from the runtime server's uid only"):
        put(GOOD)
        wait_count(2)
        assert reaches("whombat", "${lanV4}", 8123)
        assert reaches("whombat", "${lanV6}", 8123)
        # The same port on an unlisted address, another port on the listed one.
        assert not reaches("whombat", "${otherV4}", 8123)
        assert not reaches("whombat", "${otherV6}", 8123)
        assert not reaches("whombat", "${lanV4}", 8124)
        assert not reaches("whombat", "${lanV6}", 8124)
        # Other uids gain nothing.
        for user in ["whombat-runner", "nobody", "whombat-manager"]:
            assert not reaches(user, "${lanV4}", 8123), user
            assert not reaches(user, "${lanV6}", 8123), user
        # Root isn't the Vault's to open or close: the wall lets it reach any private address on any TCP port, for
        # tailscaled's own login server on the local network (every box with Tailscale).
        for host in ["${otherV4}", "${otherV6}"]:
            assert reaches("root", host, 8124), host
        rc, _ = machine.execute(f"setpriv --reuid=2000001 --regid=2000001 --clear-groups {PY} ${probe} ${lanV4} 8123")
        assert rc != 0, "a sandbox uid reached a Vault network"
        wait_log("2 Vault networks")

    with subtest("a network with several ports; covered and duplicate networks are merged"):
        put(lst(("192.168.1.0/24", [8123, 8124]), ("${lanV4}/32", [8123]), ("192.168.1.0/24", [8124]),
                ("fd42:0:0:1::/64", [8124]), ("fd42:0:0:1::/64", [8124])))
        wait_count(3)
        for host in ["${lanV4}", "${otherV4}"]:
            for port in [8123, 8124]:
                assert reaches("whombat", host, port), (host, port)
        assert reaches("whombat", "${otherV6}", 8124)
        assert not reaches("whombat", "${otherV6}", 8123)
        assert not reaches("whombat-runner", "${otherV4}", 8124)

    with subtest("removing the entry closes it again, an open connection included"):
        put(GOOD)
        wait_count(2)
        # A change that keeps the destination leaves an open connection alone.
        machine.succeed(f"rm -f /tmp/keep.*; systemd-run --uid=whombat --unit=hold-keep {PY} ${hold} ${lanV4} 8123 /tmp/keep")
        machine.wait_until_succeeds("test -e /tmp/keep.up", timeout=20)
        put(lst(("${lanV4}/32", [8123]), ("${lanV6}/128", [8123]), ("10.9.0.0/16", [80])))
        wait_count(3)
        machine.succeed("touch /tmp/keep.go")
        machine.wait_until_succeeds("test -e /tmp/keep.result", timeout=20)
        assert machine.succeed("cat /tmp/keep.result").strip() == "open"
        # Removing it ends the open connection and refuses new ones.
        machine.succeed(f"rm -f /tmp/cut.*; systemd-run --uid=whombat --unit=hold-cut {PY} ${hold} ${lanV4} 8123 /tmp/cut")
        machine.wait_until_succeeds("test -e /tmp/cut.up", timeout=20)
        put(lst(("${lanV6}/128", [8123])))
        wait_count(1)
        machine.succeed("touch /tmp/cut.go")
        machine.wait_until_succeeds("test -e /tmp/cut.result", timeout=20)
        cut = machine.succeed("cat /tmp/cut.result").strip()
        machine.log(f"an open connection after its network was removed: {cut}")
        assert cut in ("reset", "error [Errno 104] Connection reset by peer"), cut
        assert not reaches("whombat", "${lanV4}", 8123)
        assert reaches("whombat", "${lanV6}", 8123)
        put(lst())
        wait_count(0)
        assert not reaches("whombat", "${lanV6}", 8123)

    with subtest("an invalid file empties the sets and says why"):
        cases = [
            ("not JSON", '{"version":1,"networks":[', "not the expected JSON"),
            ("another version", json.dumps({"version": 2, "networks": []}), "version 2"),
            ("an unknown field", json.dumps({"version": 1, "networks": [{"cidr": "${lanV4}/32", "ports": [8123], "note": "HA"}]}), "unknown field"),
            ("loopback", lst(("127.0.0.1/32", [8123])), "127.0.0.0/8, which is loopback"),
            ("link-local metadata", lst(("169.254.169.254/32", [80])), "169.254.0.0/16, which is link-local"),
            ("IPv6 link-local", lst(("fe80::/64", [8123])), "fe80::/10, which is link-local"),
            ("IPv6 metadata", lst(("fd00:ec2::254/128", [80])), "fd00:ec2::254/128, which is a metadata address"),
            ("multicast", lst(("224.0.0.0/24", [8123])), "224.0.0.0/4, which is multicast"),
            ("documentation", lst(("192.0.2.0/24", [8123])), "192.0.2.0/24, which is documentation"),
            ("a public address", lst(("1.1.1.1/32", [443])), "not a private network"),
            ("wider than /16", lst(("10.0.0.0/8", [8123])), "wider than /16"),
            ("wider than /48", lst(("fd42::/32", [8123])), "wider than /48"),
            ("33 networks", lst(*[(f"10.{i}.0.0/16", [80]) for i in range(33)]), "at most 32"),
            ("17 ports", lst(("${lanV4}/32", list(range(8100, 8117)))), "at most 16"),
            ("port 0", lst(("${lanV4}/32", [0])), "port 0"),
        ]
        for name, content, why in cases:
            put(GOOD)
            wait_count(2)
            put(content)
            wait_count(0)
            wait_log(why, last_refusal=True)
        assert not reaches("whombat", "${lanV4}", 8123)

    with subtest("a symlink, another owner or a file others can write empties the sets"):
        machine.succeed("runuser -u whombat -- sh -c " + shlex.quote(f"printf %s {shlex.quote(GOOD)} > /tmp/elsewhere.json"))
        put(GOOD)
        wait_count(2)
        machine.succeed(f"runuser -u whombat -- ln -sfn /tmp/elsewhere.json {FILE}")
        wait_count(0)
        wait_log("symbolic link", last_refusal=True)
        put(GOOD)
        wait_count(2)
        machine.succeed(f"install -o nobody -g nogroup -m 0644 /tmp/elsewhere.json {VAULT}/.x && mv -f {VAULT}/.x {FILE}")
        wait_count(0)
        wait_log("owned by uid", last_refusal=True)
        put(GOOD)
        wait_count(2)
        put(GOOD, mode="0666")
        wait_count(0)
        wait_log("writable by others", last_refusal=True)
        put(GOOD)
        wait_count(2)
        machine.succeed(f"rm {FILE}")
        wait_count(0)

    with subtest("nftables reload and restart refill the sets; a stopped wall leaves nothing open"):
        put(GOOD)
        wait_count(2)
        machine.succeed("systemctl reload nftables")
        wait_count(2)
        assert reaches("whombat", "${lanV4}", 8123)
        machine.succeed("systemctl restart nftables")
        machine.wait_for_unit("whombat-vault-wall.service")
        wait_count(2)
        assert reaches("whombat", "${lanV4}", 8123)
        machine.succeed("systemctl stop whombat-vault-wall")
        assert count() == 0
        assert not reaches("whombat", "${lanV4}", 8123)
        machine.succeed("systemctl start whombat-vault-wall")
        wait_count(2)
        assert reaches("whombat", "${lanV4}", 8123)
        # A crashed wall comes back and applies the list again.
        machine.succeed("systemctl kill -s KILL whombat-vault-wall")
        machine.wait_until_succeeds("test $(systemctl show -P NRestarts whombat-vault-wall) -ge 1", timeout=30)
        machine.wait_for_unit("whombat-vault-wall.service")
        wait_count(2)
        print(machine.succeed("nft list table inet whombat-egress"))
  '';
}
