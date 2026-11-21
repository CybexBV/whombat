# The containers' test's network (made for the browser's tests, NX-99, NX-100, then the computers', NX-131; NX-467): a
# control node that is also the "web" — the fake control and TUF fixtures of ./control.nix, plus a web server on every
# one of its addresses — and the appliance side of that network.
#
#   pub4 1.2.3.4, pub6 2a00:1:2:3::1   "public" addresses (the test network has no Internet)
#   priv4 192.168.1.1                   the control node's test-network address (a home network when the Vault lists it)
#   meta4 169.254.169.254, ula6 fd42::1 link-local/metadata and ULA
#   public.test                         a name for pub4 in the appliance's /etc/hosts (the host resolves it itself)
#
# Web server (ports 80, 443 plain HTTP, 8123): every path a small page ("public page").
{ pkgs, lib }:
rec {
  pub4 = "1.2.3.4";
  pub6 = "2a00:1:2:3::1";
  priv4 = "192.168.1.1";
  ula6 = "fd42::1";
  meta4 = "169.254.169.254";

  web = pkgs.writeText "web.py" ''
    import socket, sys, threading
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    PAGE = b"<html><head><title>Whombat test</title></head><body><p id=marker>public page</p></body></html>"
    class H(BaseHTTPRequestHandler):
        def page(self, body, status=200):
            self.send_response(status)
            self.send_header("Content-Type", "text/html")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            self.page(PAGE)

    class S(ThreadingHTTPServer):
        address_family = socket.AF_INET6
        daemon_threads = True
        def server_bind(self):
            self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
            super().server_bind()

    for port in map(int, sys.argv[1:]):
        threading.Thread(target=S(("::", port), H).serve_forever, daemon=True).start()
    threading.Event().wait()
  '';

  # UDP echo on 53 and 443 (DNS and QUIC destinations), dual-stack.
  udpEcho = pkgs.writeText "udp-echo.py" ''
    import socket, sys, threading
    def serve(port):
        s = socket.socket(socket.AF_INET6, socket.SOCK_DGRAM)
        s.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
        s.bind(("::", port))
        while True:
            data, addr = s.recvfrom(512)
            s.sendto(data, addr)
    for port in map(int, sys.argv[1:]):
        threading.Thread(target=serve, args=(port,), daemon=True).start()
    threading.Event().wait()
  '';

  # tcp HOST PORT [TIMEOUT]: "connected" (exit 0), or "timeout" / the errno name (exit 1).
  tcp = pkgs.writeText "tcp.py" ''
    import errno, socket, sys
    t = float(sys.argv[3]) if len(sys.argv) > 3 else 3
    try:
        socket.create_connection((sys.argv[1], int(sys.argv[2])), timeout=t).close()
        print("connected")
    except socket.timeout:
        print("timeout"); sys.exit(1)
    except OSError as e:
        print(errno.errorcode.get(e.errno, str(e))); sys.exit(1)
  '';

  # udp HOST PORT: "echo" when the datagram comes back within 3 s (exit 0).
  udp = pkgs.writeText "udp.py" ''
    import errno, socket, sys
    s = socket.socket(socket.AF_INET6 if ":" in sys.argv[1] else socket.AF_INET, socket.SOCK_DGRAM)
    s.settimeout(3)
    try:
        s.connect((sys.argv[1], int(sys.argv[2])))
        s.send(b"ping")
        assert s.recv(16) == b"ping"
        print("echo")
    except socket.timeout:
        print("timeout"); sys.exit(1)
    except OSError as e:
        print(errno.errorcode.get(e.errno, str(e))); sys.exit(1)
  '';

  # dns SERVER: any answer to an A query for localhost. within 3 s (exit 0).
  dns = pkgs.writeText "dns.py" ''
    import socket, struct, sys
    q = struct.pack(">HHHHHH", 0x5742, 0x0100, 1, 0, 0, 0) + b"\x09localhost\x00" + struct.pack(">HH", 1, 1)
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.settimeout(3)
    s.sendto(q, (sys.argv[1], 53))
    data = s.recv(512)
    assert data[:2] == b"\x57\x42", data
    print("answer rcode", data[3] & 15)
  '';

  control =
    { pkgs, lib, ... }:
    {
      imports = [ ./control.nix ];
      networking.interfaces.eth1.ipv4.addresses = lib.mkAfter [
        {
          address = pub4;
          prefixLength = 24;
        }
        {
          address = meta4;
          prefixLength = 16;
        }
      ];
      networking.interfaces.eth1.ipv6.addresses = lib.mkAfter [
        {
          address = pub6;
          prefixLength = 64;
        }
        {
          address = ula6;
          prefixLength = 64;
        }
      ];
      networking.firewall.allowedTCPPorts = [
        80
        443
        8123
      ];
      networking.firewall.allowedUDPPorts = [
        53
        443
      ];
      systemd.services.web = {
        wantedBy = [ "multi-user.target" ];
        serviceConfig.ExecStart = "${pkgs.python3}/bin/python3 ${web} 80 443 8123";
      };
      systemd.services.udp-echo = {
        wantedBy = [ "multi-user.target" ];
        serviceConfig.ExecStart = "${pkgs.python3}/bin/python3 ${udpEcho} 53 443";
      };
    };

  # The appliance node's side: addresses on the same links, provisioning's ports and a name for pub4.
  machine =
    { lib, ... }:
    {
      whombat.network.outboundTcpPorts = lib.mkForce [
        443
        4600
        8080
      ];
      networking.hosts.${pub4} = [ "public.test" ];
      networking.interfaces.eth1.ipv4.addresses = lib.mkAfter [
        {
          address = "1.2.3.5";
          prefixLength = 24;
        }
        {
          address = "169.254.0.2";
          prefixLength = 16;
        }
      ];
      networking.interfaces.eth1.ipv6.addresses = lib.mkAfter [
        {
          address = "2a00:1:2:3::2";
          prefixLength = 64;
        }
        {
          address = "fd42::2";
          prefixLength = 64;
        }
      ];
    };

  # Python for the test scripts: boot both nodes, wait for the web on every address, provision the appliance from a
  # factory medium against the fake control (as sandbox-backup), and a few helpers.
  prelude = ''
    import json, shlex

    PY = "${pkgs.python3}/bin/python3"

    def sh(cmd):
        return machine.succeed(cmd).strip()

    def as_user(user, cmd):
        return f"runuser -u {user} -- {cmd}"

    def tcp(user, host, port, timeout=3):
        rc, out = machine.execute(as_user(user, f"{PY} ${tcp} {host} {port} {timeout}"))
        return rc == 0, out.strip()

    def reaches(user, host, port):
        return tcp(user, host, port)[0]

    def udp(user, host, port):
        rc, _ = machine.execute(as_user(user, f"{PY} ${udp} {host} {port}"))
        return rc == 0

    def put_networks(content):
        tmp = "/run/whombat-vault/.networks.json.tmp"
        inner = f"printf %s {shlex.quote(content)} > {tmp} && chmod 0644 {tmp} && mv -f {tmp} /run/whombat-vault/networks.json"
        machine.succeed(as_user("whombat", f"sh -c {shlex.quote(inner)}"))

    start_all()
    control.wait_for_unit("fake-control.service")
    control.wait_for_open_port(4600)
    control.wait_for_open_port(8080)
    control.wait_for_unit("web.service")
    for port in [80, 443, 8123]:
        control.wait_for_open_port(port)
    machine.wait_for_unit("multi-user.target")
    # Addresses settled (IPv6 duplicate address detection) and the pages answer on every one of them.
    for host in ["${pub4}", "${priv4}", "${meta4}", "[${pub6}]", "[${ula6}]"]:
        control.wait_until_succeeds(f"curl -sf -g --max-time 3 http://{host}:8123/ | grep -q 'public page'", timeout=60)
    for host in ["${pub4}", "${pub6}", "${ula6}", "${meta4}"]:
        machine.wait_until_succeeds(f"ping -c1 -W1 {host}", timeout=60)

    station = json.dumps({"v": 1, "environment": "dev", "controlUrl": "http://control:4600", "tokenFile": "token",
                          "model": "whombat-one", "requireSecureBoot": False,
                          "factoryRelease": "rt-fixture-1", "seedHelper": False})
    machine.succeed(
        "mkfs.vfat /dev/disk/by-id/virtio-factory",
        f"echo '{station}' > /tmp/station.json && mcopy -i /dev/disk/by-id/virtio-factory /tmp/station.json ::/station.json",
        "echo dev-station-token-for-vm-tests-only > /tmp/token && mcopy -i /dev/disk/by-id/virtio-factory /tmp/token ::/token",
        "fatlabel /dev/disk/by-id/virtio-factory WBFACTORY",
    )
    machine.wait_until_succeeds("test -e /persist/identity/device.json", timeout=120)
    machine.wait_for_unit("whombat-server.service")
  '';
}
