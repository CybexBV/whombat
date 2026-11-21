# Tailscale chosen in the installer (Expert, the owner's own login server) and the box restarted before the first
# sign-in (Whombat LNK-12; manager.md MG-180). tailscaled keeps "on" and the login server only once a profile has signed
# in, so the box came back off on Tailscale's own server, with no sign-in link on its screen, for good. Here, with a real
# Headscale behind HTTPS the box trusts:
#   - the installer's choice (reach.json: Tailscale with https://headscale) is acted on at the manager's first start: a
#     sign-in link from Headscale, and the manager keeps the wish in /persist/manager/tailscale.json
#   - after a restart before signing in, the manager turns Tailscale on again on the same server: a fresh link
#   - signing in with that link puts the box on the tailnet; from then on tailscaled keeps it (another restart comes
#     back on by itself) and the manager's wish is done
#   - turned off by the owner, a start of the manager leaves it off
{
  applianceModules,
  pkgs,
  lib,
  ...
}:
let
  tls = pkgs.runCommand "headscale-tls" { nativeBuildInputs = [ pkgs.openssl ]; } ''
    openssl req -x509 -newkey rsa:2048 -sha256 -days 365 -nodes -out cert.pem -keyout key.pem \
      -subj '/CN=headscale' -addext "subjectAltName=DNS:headscale"
    mkdir -p $out
    cp key.pem cert.pem $out
  '';
  reach = pkgs.writeText "reach.json" (builtins.toJSON {
    v = 1;
    seq = 1;
    link = false;
    tailscale = true;
    loginServer = "https://headscale";
    by = "installer";
    at = "2026-11-20T12:00:00Z";
  });
in
{
  name = "whombat-tailscale-first-sign-in";

  nodes = {
    control = {
      imports = [ ./common/control.nix ];
    };
    headscale = {
      services.headscale = {
        enable = true;
        port = 8080;
        settings = {
          server_url = "https://headscale";
          derp = {
            server = {
              enabled = true;
              region_id = 999;
              stun_listen_addr = "0.0.0.0:3478";
            };
            urls = [ ];
          };
          dns = {
            base_domain = "tailnet";
            override_local_dns = false;
          };
        };
      };
      services.nginx = {
        enable = true;
        virtualHosts.headscale = {
          addSSL = true;
          sslCertificate = "${tls}/cert.pem";
          sslCertificateKey = "${tls}/key.pem";
          locations."/" = {
            proxyPass = "http://127.0.0.1:8080";
            proxyWebsockets = true;
          };
        };
      };
      networking.firewall = {
        allowedTCPPorts = [
          80
          443
        ];
        allowedUDPPorts = [ 3478 ];
      };
      environment.systemPackages = [ pkgs.headscale ];
    };
    machine = {
      imports = applianceModules ++ [ (import ./common/appliance-vm.nix { serial = "SN-TS-FIRST-0001"; }) ];
      security.pki.certificateFiles = [ "${tls}/cert.pem" ];
      environment.systemPackages = [ pkgs.mtools ];
    };
  };

  testScript =
    { nodes, ... }:
    ''
      import json, re

      mgr = "${nodes.machine.whombat.manager.package}/bin/whombat-manager --config /etc/whombat/manager.json tailscale"

      def ts(cmd):
          return json.loads(machine.succeed(f"runuser -u whombat-manager -- {mgr} {cmd}"))

      def prefs():
          return json.loads(machine.succeed("tailscale debug prefs"))

      def want():
          return json.loads(machine.succeed("cat /persist/manager/tailscale.json"))

      def sign_in_link(previous=None):
          """Waits for Headscale's sign-in link in the manager's state (another than previous) and answers it."""
          found = {}
          def check(_):
              st = ts("state")
              url = st.get("loginUrl") or ""
              if st["state"] == "needs_sign_in" and url.startswith("https://headscale/register/") and url != previous:
                  found["url"] = url
                  return True
              print("tailscale:", st)
              return False
          retry(check, timeout_seconds=180)
          return found["url"]

      def manager_started():
          machine.wait_for_unit("whombat-manager.service")
          machine.wait_for_unit("tailscaled.service")
          machine.wait_until_succeeds("tailscale status --json --peers=false", timeout=60)

      start_all()
      control.wait_for_unit("fake-control.service")
      control.wait_for_open_port(4600)
      control.wait_for_open_port(8080)
      headscale.wait_for_unit("headscale.service")
      headscale.wait_for_open_port(443)
      headscale.succeed("headscale users create owner")
      machine.wait_for_unit("multi-user.target")

      with subtest("the installer's choice: Tailscale with the owner's own login server, a sign-in link"):
          # What whombat-install writes on the disk (installer-base.nix), then the factory medium provisions the box and
          # its manager starts.
          machine.succeed("install -d -m 0755 /persist/whombat && install -m 0644 ${reach} /persist/whombat/reach.json")
          station = json.dumps({
              "v": 1, "environment": "dev", "controlUrl": "http://control:4600", "tokenFile": "token",
              "model": "whombat-one", "requireSecureBoot": False,
              "factoryRelease": "rt-fixture-1", "seedHelper": False,
          })
          machine.succeed(
              "mkfs.vfat /dev/disk/by-id/virtio-factory",
              f"echo '{station}' > /tmp/station.json && mcopy -i /dev/disk/by-id/virtio-factory /tmp/station.json ::/station.json",
              "echo dev-station-token-for-vm-tests-only > /tmp/token && mcopy -i /dev/disk/by-id/virtio-factory /tmp/token ::/token",
              "fatlabel /dev/disk/by-id/virtio-factory WBFACTORY",
          )
          machine.wait_until_succeeds("test -e /persist/identity/device.json", timeout=180)
          manager_started()
          machine.wait_until_succeeds("journalctl -u whombat-manager --no-pager | grep -q 'reach: acting on the owner'", timeout=60)
          first = sign_in_link()
          assert prefs()["WantRunning"] and prefs()["ControlURL"] == "https://headscale", prefs()
          w = want()
          assert w["on"] and w["loginServer"] == "https://headscale", w

      with subtest("restarted before the sign-in: on again on the same server, a fresh link"):
          machine.shutdown()
          machine.start()
          manager_started()
          link = sign_in_link(previous=first)
          p = prefs()
          assert p["WantRunning"] and p["ControlURL"] == "https://headscale", p
          assert want()["on"], want()
          machine.succeed("journalctl -b -u whombat-manager --no-pager | grep -q 'tailscale: on again'")

      with subtest("signed in with that link: on the tailnet, tailscaled keeps it from now on"):
          key = re.sub(r".*/register/", "", link)
          headscale.succeed(f"headscale nodes register --user owner --key {key}")
          # On, and the manager's wish done: tailscaled has saved the profile (a moment after it is on).
          retry(lambda _: ts("state")["state"] == "on" and not want()["on"], timeout_seconds=120)
          st = ts("state")
          assert st["name"].endswith(".tailnet"), st
          assert st["loginServer"] == "https://headscale", st
          # tailscaled and the manager start again (as at a restart): back on by itself, the manager adds nothing.
          machine.succeed("systemctl restart tailscaled")
          machine.succeed("systemctl restart whombat-manager")
          manager_started()
          retry(lambda _: ts("state")["state"] == "on", timeout_seconds=120)

      with subtest("turned off by the owner: a start of the manager leaves it off"):
          assert ts("off")["state"] == "off"
          machine.succeed("systemctl restart tailscaled")
          machine.succeed("systemctl restart whombat-manager")
          manager_started()
          machine.sleep(10)
          st = ts("state")
          assert st["state"] == "off", st
          assert not prefs()["WantRunning"], prefs()
    '';
}
