# A live agent turn through the real runtime bundle (NX-73…NX-76; NX-69's open item): the real server and runner units
# as the image configures them, the runner's managed sandbox (bubblewrap in both stages, its delegated task cgroups,
# the nftables wall) and an agent CLI inside it. No real provider: the manager's install root gets a stand-in for
# Claude Code (common/live-turn/fake-claude.js) that replies with what it saw of its sandbox.
#   - the runner's unit: a fresh procfs is allowed (no locked mounts under its /proc), its cgroup subtree is its own
#     and writable; the server keeps its hardening
#   - the runner probes the sandbox at start: “sandbox · bubblewrap … (nested)”, never “unavailable”
#   - the runner has a WHOMBAT_HOME of its own (0700): no EACCES on the server's home, at start or in a turn (NX-76)
#   - Hermes is the runtime bundle's (NX-483) and passed its activation check (NX-484)
#   - a client installed as the manager installs one (whombat-manager, read-only) and announced over the admin socket
#     (`POST /clients`, as the manager does) becomes the runner's `claude`
#   - one message to an agent (the server's own seed world and commit pipeline, common/live-turn/world.ts) is claimed by
#     the runner and run on Hermes in the sandbox, with the CLI as Hermes's model client on the requester's planted
#     sign-in, and answered: the reply is the CLI's report, posted as the agent's message; the dispatch is done (NX-486)
#   - the CLI ran inside bubblewrap: pid 1 of its pid namespace is bwrap, its pid namespace isn't the runner's, it sees
#     only the pod's processes, uid 1000, hostname whombat-task, seccomp and no_new_privs on, none of the appliance's
#     state, and no network (control's port, which the host itself reaches, is unreachable)
{
  applianceModules,
  pkgs,
  lib,
  ...
}:
let
  real = import ./common/real-runtime.nix { inherit pkgs lib; };
  lt = import ./common/live-turn.nix { inherit pkgs lib; };
  clientVersion = "0.0.0-fake";
  # Hermes in a jail shaped like the runner's task sandbox (NX-434): the store, the system, the certificates and the
  # time zone of /etc, fresh /proc, /dev, /tmp and home, one writable profile, no network but loopback, no inherited
  # environment. The runner's real sandbox adds its generated /etc files, the proxy and the computer.
  hermesProfile = "/persist/whombat/hermes/profiles/vmtest";
  hermesJail = pkgs.writeShellScript "hermes-jail" ''
    exec ${pkgs.bubblewrap}/bin/bwrap --unshare-all --die-with-parent --new-session \
      --ro-bind /nix/store /nix/store --ro-bind /run/current-system /run/current-system \
      --dir /etc --ro-bind-try /etc/static /etc/static --ro-bind-try /etc/ssl /etc/ssl --ro-bind-try /etc/localtime /etc/localtime \
      --proc /proc --dev /dev --tmpfs /tmp --tmpfs /home/whombat-task \
      --bind ${hermesProfile} ${hermesProfile} \
      --clearenv --setenv PATH /run/current-system/sw/bin --setenv HOME /home/whombat-task \
      --setenv HERMES_HOME ${hermesProfile} --setenv TMPDIR /tmp --setenv LANG C.UTF-8 \
      "$@"
  '';
  # The least a runner's config.yaml says (NX-434): a model, Hermes's Codex mode, no update checks.
  hermesConfig = pkgs.writeText "hermes-config.yaml" ''
    model:
      default: gpt-5.5
      provider: openai-codex
      openai_runtime: codex_app_server
    updates:
      check: false
  '';
  # ACP over stdio as the runner speaks it: initialize, then session/new (which starts Hermes's gateway in the jail).
  hermesProbe = pkgs.writeText "hermes-acp-probe.py" ''
    import json, select, subprocess, sys, time

    p = subprocess.Popen(sys.argv[1:], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1)
    t0 = time.time()

    def call(i, method, params, timeout=180):
        p.stdin.write(json.dumps({"jsonrpc": "2.0", "id": i, "method": method, "params": params}) + "\n")
        p.stdin.flush()
        end = time.time() + timeout
        while time.time() < end:
            if select.select([p.stdout], [], [], 1)[0]:
                line = p.stdout.readline()
                if not line:
                    break
                msg = json.loads(line)
                if msg.get("id") == i:
                    print(f"{method} after {time.time() - t0:.1f} s", flush=True)
                    if "result" not in msg:
                        sys.exit(f"{method}: {msg}")
                    return msg["result"]
        sys.exit(f"{method}: no answer")

    init = call(1, "initialize", {"protocolVersion": 1, "clientCapabilities": {}})
    print("agent", json.dumps(init["agentInfo"]), flush=True)
    # Its first session/new starts the gateway; in a small VM the gateway may not take the viewer's WebSocket within
    # Hermes's 10 s open timeout (“Gateway connection failed”). A second one dials the running gateway again.
    try:
        session = call(2, "session/new", {"cwd": "/tmp", "mcpServers": []})
    except SystemExit as e:
        if "Gateway connection" not in str(e):
            raise
        print("session/new again:", e, flush=True)
        session = call(3, "session/new", {"cwd": "/tmp", "mcpServers": []})
    print("session", session["sessionId"], flush=True)
    p.stdin.close()
    p.wait(60)
  '';
in
{
  name = "whombat-runtime-live-turn";

  nodes = {
    control = real.control;
    machine =
      { config, ... }:
      {
        imports = applianceModules ++ [
          (import ./common/appliance-vm.nix { serial = "SN-LT-0001"; })
          real.machine
        ];
        environment.systemPackages = [ pkgs.socat ];
        # The agent's commands' network daemon (whombat-agent-net, NX-456): every turn's pod binds its proxy socket.
        whombat.agent.enable = true;
        # The world script with the server's environment and credentials, as its user (never part of an image).
        systemd.services.whombat-vmtest-world = {
          description = "VM test: seed the server's test world and send one message to an agent";
          inherit (config.systemd.services.whombat-server) environment;
          serviceConfig = {
            Type = "oneshot";
            User = "whombat";
            Group = "whombat";
            inherit (config.systemd.services.whombat-server.serviceConfig)
              Environment
              EnvironmentFile
              LoadCredential
              ;
            ExecStart = "${lt.world}/bin/whombat-vmtest-world 'what do you see?'";
          };
        };
      };
  };

  testScript =
    { nodes, ... }:
    ''
      import json

      CLIENTS = "/persist/whombat/clients"
      CREDS = "/persist/whombat/credentials"
      version = "${clientVersion}"

      def sh(cmd):
          return machine.succeed(cmd).strip()

      def psql(q):
          return sh(f"runuser -u whombat -- psql -X -A -t -d whombat -c {json.dumps(q)}")

      def runner_log():
          return sh("journalctl -u whombat-runner --no-pager -o cat")

      start_all()
      control.wait_for_unit("tuf-real.service")
      control.wait_for_open_port(4600)
      machine.wait_for_unit("multi-user.target")

      with subtest("factory provisioning; the real server and runner start"):
          station = json.dumps({
              "v": 1, "environment": "dev", "controlUrl": "http://control:4600", "tokenFile": "token",
              "model": "whombat-one", "requireSecureBoot": False,
              "factoryRelease": "${real.releaseId}", "seedHelper": False,
          })
          machine.succeed(
              "mkfs.vfat /dev/disk/by-id/virtio-factory",
              f"echo '{station}' > /tmp/station.json && mcopy -i /dev/disk/by-id/virtio-factory /tmp/station.json ::/station.json",
              "echo dev-station-token-for-vm-tests-only > /tmp/token && mcopy -i /dev/disk/by-id/virtio-factory /tmp/token ::/token",
              "fatlabel /dev/disk/by-id/virtio-factory WBFACTORY",
          )
          machine.wait_until_succeeds("test -e /persist/identity/device.json", timeout=120)
          machine.wait_until_succeeds("systemctl show -P ActiveState whombat-runtime-schema-init | grep -qx active", timeout=240)
          machine.wait_for_unit("whombat-server.service", timeout=180)
          machine.wait_for_unit("whombat-runner.service", timeout=180)
          assert sh("readlink -f /nix/var/nix/profiles/whombat-runtime") == "${real.runtime}"

      with subtest("the runner's unit allows a fresh procfs and its own cgroups; the server keeps its hardening"):
          pid = sh("systemctl show -P MainPID whombat-runner")
          mounts = sh(f"awk '{{print $5}}' /proc/{pid}/mountinfo")
          under_proc = [m for m in mounts.splitlines() if m.startswith("/proc/")]
          assert under_proc == [], under_proc
          # Its cgroup namespace: it sees its own subtree as the root (/supervisor, where it moved itself); from here the
          # same cgroup has its full path. It made supervisor/ and tasks/ in its unit's cgroup.
          assert sh(f"nsenter -t {pid} -C cat /proc/{pid}/cgroup") == "0::/supervisor", sh(f"nsenter -t {pid} -C cat /proc/{pid}/cgroup")
          assert sh(f"cat /proc/{pid}/cgroup").endswith("/whombat-runner.service/supervisor"), sh(f"cat /proc/{pid}/cgroup")
          unit_cg = "/sys/fs/cgroup/whombat.slice/whombat-tasks.slice/whombat-runner.service"
          machine.wait_until_succeeds(f"test -d {unit_cg}/supervisor && test -d {unit_cg}/tasks", timeout=60)
          for prop, want in [("ProtectKernelTunables", "no"), ("ProtectKernelLogs", "no"), ("ProtectHostname", "no"),
                             ("ProtectControlGroupsEx", "private"), ("ProtectProc", "invisible"), ("ProcSubset", "all")]:
              got = sh(f"systemctl show -P {prop} whombat-runner")
              assert got == want, f"runner {prop}={got}"
          for prop, want in [("ProtectKernelTunables", "yes"), ("ProtectKernelLogs", "yes"), ("ProtectHostname", "yes"),
                             ("ProtectControlGroupsEx", "yes"), ("ProtectProc", "invisible"), ("ProcSubset", "pid")]:
              got = sh(f"systemctl show -P {prop} whombat-server")
              assert got == want, f"server {prop}={got}"
          # The wall is loaded for the runner's cgroup.
          machine.succeed("nft list table inet whombat_runner | grep -q 'whombat-runner.service'")

      with subtest("the runner's sandbox probe passes; no EACCES on the server's home"):
          machine.wait_until_succeeds("journalctl -u whombat-runner -o cat --no-pager | grep -q 'sandbox · bubblewrap'", timeout=120)
          log = runner_log()
          print(log)
          assert "sandbox unavailable" not in log, log
          assert "Can't mount proc" not in log, log
          assert "EACCES" not in log, log
          assert "acp-runtimes.json" not in log, log
          assert sh("stat -c '%U %a' /persist/whombat/runner/home") == "whombat-runner 700"
          assert sh("stat -c '%U %a' /persist/whombat/home") == "whombat 700"
          assert "WHOMBAT_HOME=/persist/whombat/runner/home" in sh(f"tr '\\0' '\\n' < /proc/{sh('systemctl show -P MainPID whombat-runner')}/environ")

      with subtest("Hermes: the runtime's own (NX-483), the runner's paths; `hermes acp` answers in a jail with only the store (NX-431, NX-434)"):
          hermes = "${nodes.machine.whombat.hermes.package}"
          assert hermes == "${nodes.machine.whombat.runtime.package.passthru.hermes}"
          env = sh(f"tr '\\0' '\\n' < /proc/{sh('systemctl show -P MainPID whombat-runner')}/environ").splitlines()
          # The bundle's runner wrapper names it; the unit doesn't.
          assert f"WHOMBAT_HERMES_BIN={hermes}/bin/hermes" in env, env
          assert "WHOMBAT_HERMES_BIN" not in sh("systemctl show -P Environment whombat-runner")
          assert "WHOMBAT_HERMES_ROOT=/persist/whombat/hermes" in env, env
          assert sh("stat -c '%U %a' /persist/whombat/hermes") == "whombat-runner 700"
          machine.succeed(
              "install -d -o whombat-runner -g whombat-runner -m 0700 /persist/whombat/hermes/profiles ${hermesProfile}",
              "install -o whombat-runner -g whombat-runner -m 0600 ${hermesConfig} ${hermesProfile}/config.yaml",
          )
          out = sh(f"runuser -u whombat-runner -- ${pkgs.python3}/bin/python3 -I ${hermesProbe} ${hermesJail} {hermes}/bin/hermes acp")
          print(out)
          assert '"version": "${nodes.machine.whombat.hermes.package.passthru.hermesVersion}"' in out, out
          assert "session local-" in out, out
          # Everything it wrote is in the profile, owned by the runner; its gateway ended with the jail.
          assert sh("find ${hermesProfile} ! -user whombat-runner | wc -l") == "0"
          machine.succeed("test -s ${hermesProfile}/state.db")
          machine.fail("pgrep -f 'hermes_cli.main.*gateway'")

      with subtest("the runtime's Hermes passed its activation check, as a user of its own, and the manager counts it (NX-484)"):
          machine.wait_until_succeeds("systemctl show -P ActiveState whombat-hermes-check | grep -qx active", timeout=300)
          log = sh("journalctl -u whombat-hermes-check -o cat --no-pager")
          print(log)
          assert "hermes-check: ok" in log, log
          assert "acp session/new" in log, log
          assert sh("systemctl show -P DynamicUser whombat-hermes-check") == "yes"
          machine.succeed("grep -qF '\"whombat-hermes-check.service\"' /etc/whombat/manager.json")
          # Its gateway ended with it; nothing of it is in the person's Hermes home.
          machine.fail("pgrep -f 'hermes_cli.main.*gateway'")
          machine.fail("ls /persist/whombat/hermes | grep -q '^config.yaml$'")

      with subtest("a client installed as the manager does it becomes the runner's claude"):
          # The manager would replace the status with its own (no client channel here): it stays out of the way.
          machine.succeed("systemctl stop whombat-manager.service")
          d = f"{CLIENTS}/claude/{version}"
          machine.succeed(
              f"install -d -o whombat-manager -g whombat-manager -m 0755 {CLIENTS}/claude {d}",
              f"install -o whombat-manager -g whombat-manager -m 0555 ${lt.fakeClaude}/claude {d}/claude",
          )
          machine.fail(f"runuser -u whombat-runner -- touch {d}/claude")
          digest = sh(f"sha256sum {d}/claude | cut -d' ' -f1")
          body = json.dumps({"v": 1, "channel": None, "clients": [{
              "provider": "claude", "state": "installed", "latest": None, "progress": None, "error": None,
              "installed": {"version": version, "installedAt": "2026-09-27T00:00:00Z",
                            "fixturesDigest": "sha256:" + "0" * 64,
                            "executable": {"path": f"{d}/claude", "sha256": digest}}}]})
          machine.succeed(f"echo '{body}' > /tmp/clients.json")
          out = sh("runuser -u whombat-manager -- curl -sf --unix-socket /run/whombat/admin.sock"
                   " -H 'content-type: application/json' --data @/tmp/clients.json http://runtime/clients")
          assert json.loads(out).get("ok") is True, out
          st = sh("stat -c '%U:%G %a' /run/whombat-clients/clients.json")
          print("clients.json:", st)
          # Only the server writes it; its setgid directory (2750 whombat:whombat-runner) lets the runner alone read it.
          assert st.startswith("whombat:whombat-runner ") and st[-1] in "04", st
          machine.wait_until_succeeds(f"journalctl -u whombat-runner -o cat --no-pager | grep -qF 'provider claude: {version} (Claude Code)'", timeout=120)

      with subtest("one message to an agent: the world through the server's own commit pipeline"):
          machine.succeed("systemctl stop whombat-runner.service whombat-server.service")
          machine.succeed("systemctl start whombat-vmtest-world.service")
          line = [l for l in sh("journalctl -u whombat-vmtest-world -o cat --no-pager").splitlines() if l.startswith('{"accountId"')][-1]
          world = json.loads(line)
          print("world:", world)
          account = world["accountId"]
          assert world["agentRuntime"]["provider"] == "claude", world
          dispatch = psql(f"select id from dispatches where agent_id = '{world['agentId']}' and state = 'queued'")
          assert dispatch.startswith("dsp_"), dispatch
          # The requester's own Claude sign-in home, as the runner keeps them (a subscription login, planted: no account).
          home = f"{CREDS}/{account}/claude"
          record = json.dumps({"v": 1, "provider": "claude", "authMode": "subscription_cli", "owner": "person",
                               "accountId": account, "createdAt": "2026-09-27T00:00:00Z", "expiresAt": None,
                               "verified": "valid", "verifiedAt": "2026-09-27T00:00:00Z", "creatorAttested": False,
                               "login": None, "signal": None})
          machine.succeed(
              f"install -d -o whombat-runner -g whombat-runner -m 0700 {CREDS}/{account} {home} {home}/config",
              f"echo '{record}' > {home}/whombat-credential.json",
              f"chown whombat-runner:whombat-runner {home}/whombat-credential.json && chmod 0600 {home}/whombat-credential.json",
          )

      with subtest("the runner claims it, runs the CLI in its sandbox and the agent answers"):
          machine.succeed("systemctl start whombat-server.service whombat-runner.service")
          machine.wait_for_unit("whombat-runner.service", timeout=180)
          try:
              machine.wait_until_succeeds(
                  f"test \"$(runuser -u whombat -- psql -X -A -t -d whombat -c \"select state from dispatches where id = '{dispatch}'\")\" = done",
                  timeout=240,
              )
          finally:
              print(machine.execute("journalctl -u whombat-runner -u whombat-server -b --no-pager -o short-monotonic | tail -150")[1])
              print(machine.execute(f"runuser -u whombat -- psql -X -d whombat -c \"select * from dispatches where id = '{dispatch}'\" -x")[1])
          log = runner_log()
          print(log)
          assert f"provider claude: {version} (Claude Code)" in log, log
          # The requester's sign-in, moved to the one person's place (Whombat OP-17), is the turn's.
          assert "sign-in claude · subscription" in log, "the turn ran without the claude sign-in"
          reply = psql(f"select text from messages where author_id = '{world['agentId']}' order by created_at desc limit 1")
          print("reply:", reply)
          assert reply.startswith("FAKE-CLAUDE-OK "), reply
          seen = json.loads(reply[len("FAKE-CLAUDE-OK "):])
          print("the CLI saw:", seen)
          # Inside bubblewrap: its own pid namespace with bwrap as pid 1, a fresh procfs with the pod's processes only
          # (Hermes, its gateway and the CLI with their helpers: 11 here).
          assert "bwrap" in seen["pid1"], seen
          rpid = sh("systemctl show -P MainPID whombat-runner")
          assert seen["pidns"] != sh(f"readlink /proc/{rpid}/ns/pid"), seen
          assert seen["procs"] < 25, seen
          assert seen["uid"] == 1000 and seen["host"] == "whombat-task", seen
          assert seen["seccomp"] == "2" and seen["nnp"] == "1", seen
          assert seen["whombatHome"] == "ENOENT" and seen["secrets"] == "ENOENT" and seen["runWhombat"] == "ENOENT", seen
          # No network: control's port is reachable from the host, not from the task.
          machine.succeed("curl -s -o /dev/null --max-time 5 http://192.168.1.1:4600/")
          assert seen["net"] != "connected", seen
          assert "sandbox unavailable" not in log and "sandbox_unavailable" not in log, log
          assert "EACCES" not in sh("journalctl -u whombat-runner -u whombat-server -b --no-pager -o cat"), "EACCES"
    '';
}
