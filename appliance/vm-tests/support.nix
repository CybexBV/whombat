# Remote help's support service (NX-411…NX-424) on a small VM with the accounts and the support module only (no runtime,
# no manager, no relay: the unit depends on none of them), as a prod image with a test CA:
#   - the socket is systemd's, 0660 root:whombat-support; the service runs as root and starts at boot
#   - the runtime server's user gets everything, the manager's the state without the help code, root everything; a member
#     of the socket's group that is neither is refused (403), and users outside the group can't open the socket
#   - over the socket as the runtime: Forever refused on prod, a grant with a help code, the grant kept across a restart,
#     a stop, and an expiry when the clock passes its end; every change is an event
#   - when the grant ends, a process left in the unit's cgroup is ended (NX-418)
#   - Look's user reads the journal and nothing of the service's state or of /persist's data; no port listens, and the
#     journal never holds the help code
{ pkgs, ... }:
let
  socket = "/run/whombat-support/api.sock";
  # A throwaway CA public key (its private key was never kept): the service only has to find a key to be available.
  testCa = pkgs.writeText "support-ca.pub" ''
    # the VM test's CA
    ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHtXhqx1Kd/NyPCfPc4otRhK/D6z+gmQkP+Is0/q/Wpu whombat-support-ca-test
  '';
in
{
  name = "whombat-support";

  nodes.machine =
    { ... }:
    {
      imports = [
        ../nix/modules/options.nix
        ../nix/modules/users.nix
        ../nix/modules/support.nix
      ];
      whombat.environment = "prod";
      whombat.support.enable = true;
      whombat.support.caKeys = testCa;
      # A member of the socket's group that isn't the runtime or the manager: the peer check's case.
      users.users.intruder = {
        isNormalUser = true;
        extraGroups = [ "whombat-support" ];
      };
      environment.systemPackages = [
        pkgs.curl
        pkgs.jq
        pkgs.iproute2
      ];
    };

  testScript = ''
    import json

    sock = "${socket}"
    owner = '{"accountId":"acc_owner1","name":"Anna de Vries"}'

    def call(user, method, path, body=None):
        """(status, body) of a request as user ("root" without runuser)."""
        data = f"-H 'Content-Type: application/json' -d '{body}'" if body is not None else ""
        run = "" if user == "root" else f"runuser -u {user} -- "
        out = machine.succeed(f"{run}curl -sS -X {method} --unix-socket {sock} {data} -w '\\n%{{http_code}}' http://support{path}")
        text, code = out.rsplit("\n", 1)
        return int(code), text

    def ok(user, method, path, body=None):
        code, text = call(user, method, path, body)
        assert code == 200, (code, text)
        return json.loads(text)

    def refused(user, method, path, body, status, error):
        code, text = call(user, method, path, body)
        assert code == status and json.loads(text)["error"]["code"] == error, (code, text)

    def kinds(after=0):
        return [e["kind"] for e in ok("whombat", "GET", f"/v1/events?after={after}")["events"]]

    machine.wait_for_unit("whombat-support.service")
    t.assertEqual(machine.succeed(f"stat -c '%a %U %G' {sock}").strip(), "660 root whombat-support")
    t.assertEqual(machine.succeed("stat -c '%a %U' /var/lib/whombat-support").strip(), "700 root")
    pid = machine.succeed("systemctl show -P MainPID whombat-support").strip()
    t.assertEqual(machine.succeed(f"ps -o user= -p {pid}").strip(), "root")

    with subtest("the runtime and root get in, the manager reads the state only, nobody else"):
        st = ok("whombat", "GET", "/v1/state")
        assert st["v"] == 1 and st["available"] and st["environment"] == "prod", st
        assert st["helpCodeRequired"] and not st["foreverAllowed"] and st["grant"] is None and st["connected"] == [], st
        ok("root", "GET", "/v1/state")
        ok("whombat-manager", "GET", "/v1/state")
        refused("whombat-manager", "POST", "/v1/stop", '{"v":1,"reason":"desk"}', 403, "forbidden")
        refused("whombat-manager", "GET", "/v1/events", None, 403, "forbidden")
        refused("intruder", "GET", "/v1/state", None, 403, "forbidden")
        refused("intruder", "POST", "/v1/grant", f'{{"v":1,"level":"fix","duration":"day","grantedBy":{owner}}}', 403, "forbidden")
        # Outside the socket's group the socket doesn't open at all.
        machine.fail(f"runuser -u whombat-runner -- curl -sS --unix-socket {sock} http://support/v1/state")
        machine.fail(f"runuser -u whombat-support-look -- curl -sS --unix-socket {sock} http://support/v1/state")

    with subtest("a grant: no Forever on prod, a help code the manager doesn't see"):
        refused("whombat", "POST", "/v1/grant", f'{{"v":1,"level":"fix","duration":"forever","grantedBy":{owner}}}', 403, "forever_not_allowed")
        refused("whombat", "POST", "/v1/grant", f'{{"v":1,"level":"fix","durationS":86400,"grantedBy":{owner}}}', 400, "bad_request")
        st = ok("whombat", "POST", "/v1/grant", f'{{"v":1,"level":"fix","duration":"day","grantedBy":{owner}}}')
        g = st["grant"]
        code = g["helpCode"]
        assert g["level"] == "fix" and g["until"] and len(code) == 6 and g["wrongCodes"] == 0, st
        m = ok("whombat-manager", "GET", "/v1/state")
        assert m["grant"]["level"] == "fix" and m["grant"]["helpCode"] is None, m
        t.assertEqual(machine.succeed("stat -c '%a %U' /var/lib/whombat-support/grant.json").strip(), "600 root")
        t.assertEqual(kinds(), ["grant"])

    with subtest("when the grant ends, what a visit left in the unit's cgroup ends too"):
        left = machine.succeed("setsid sleep 1000 </dev/null >/dev/null 2>&1 & echo $!").strip()
        machine.succeed(f"echo {left} > /sys/fs/cgroup/system.slice/whombat-support.service/cgroup.procs")
        machine.succeed(f"grep -q whombat-support.service /proc/{left}/cgroup")
        st = ok("whombat", "POST", "/v1/stop", f'{{"v":1,"reason":"owner","by":{owner}}}')
        assert st["grant"] is None, st
        machine.wait_until_fails(f"kill -0 {left}", timeout=30)
        machine.wait_until_succeeds("journalctl -u whombat-support -o cat | grep -q 'ended 1 process'", timeout=30)
        machine.succeed("systemctl is-active whombat-support")
        t.assertEqual(kinds(), ["grant", "stop"])
        # Stopping what is off: the state, nobody told.
        ok("root", "POST", "/v1/stop", '{"v":1,"reason":"desk"}')
        t.assertEqual(kinds(), ["grant", "stop"])

    with subtest("a grant survives a restart"):
        g = ok("whombat", "POST", "/v1/grant", f'{{"v":1,"level":"look","duration":"hour","grantedBy":{owner}}}')["grant"]
        machine.succeed("systemctl restart whombat-support")
        machine.wait_for_unit("whombat-support.service")
        again = ok("whombat", "GET", "/v1/state")["grant"]
        assert again == g, (again, g)
        t.assertEqual(kinds(), ["grant", "stop", "grant"])

    with subtest("it ends when the clock passes its end"):
        machine.succeed("date -s @$(( $(date +%s) + 3700 ))")
        st = ok("whombat", "GET", "/v1/state")
        assert st["grant"] is None, st
        t.assertEqual(kinds(), ["grant", "stop", "grant", "expired"])
        ev = ok("whombat", "GET", "/v1/events?after=3&waitS=0")
        assert ev["next"] == 4 and len(ev["events"]) == 1, ev

    with subtest("Look's user: the journal, nothing of the service's state or /persist's data"):
        t.assertEqual(machine.succeed("id -Gn whombat-support-look").split(), ["whombat-support-look", "systemd-journal"])
        machine.succeed("runuser -u whombat-support-look -- journalctl -q -n 5 -u whombat-support")
        machine.fail("runuser -u whombat-support-look -- ls /var/lib/whombat-support")
        machine.fail("runuser -u whombat-support-look -- cat /var/lib/whombat-support/grant.json")
        machine.succeed("install -d -m 0755 /persist && install -d -m 0700 -o whombat -g whombat /persist/whombat")
        machine.succeed("echo secret > /persist/whombat/chat && chown whombat: /persist/whombat/chat && chmod 0600 /persist/whombat/chat")
        machine.succeed("install -d -m 0711 /persist/identity")
        machine.fail("runuser -u whombat-support-look -- ls /persist/whombat")
        machine.fail("runuser -u whombat-support-look -- cat /persist/whombat/chat")
        machine.fail("runuser -u whombat-support-look -- ls /persist/identity")

    with subtest("no port, and no help code in the journal"):
        machine.fail("ss -Hltnup | grep -q whombat-support")
        journal = machine.succeed("journalctl -u whombat-support -o cat")
        print(journal)
        assert code not in journal and "available" in journal, journal
  '';
}
