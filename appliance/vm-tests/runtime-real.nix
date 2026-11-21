# The real runtime bundle on the appliance (PI-07, PI-08 runtime half; NX-41…NX-48). Direct boot, the real
# manager and helper, the fake control, the development fixture repository republished with `rt-real-1` (whose
# runtime is the bundle, vm-tests/common/real-runtime.nix):
#   - the image seeds the runtime profile with the real bundle (not the stand-in)
#   - factory provisioning with factory release rt-real-1; on the empty database whombat-runtime-schema-init
#     creates the schema with the bundle's own `whombat migrate --json --env` as the runtime user (NX-46)
#   - whombat-server and whombat-runner: Type=notify (READY=1 from Node through systemd-notify, NotifyAccess=all),
#     the main PID is Node, watchdog pings keep them up for several periods without a restart; a stopped
#     (SIGSTOP) server misses its pings and is killed and restarted (NX-45)
#   - the admin socket: 0660 whombat:whombat-admin, /health answers the manager user with a working database,
#     the runner and nobody can't connect; the boot assessment's own check passes
#   - the console file: written by the real server, whombat:whombat-console 0640, a valid state
#   - the helper's migrate-runtime (as the manager, over its socket, TUF-verified and assigned) migrates an
#     emptied PostgreSQL database with the bundle's bin/whombat as the runtime user (MD-10, MR-73), and the
#     runtime comes back healthy on it
#   - the runner's syscall filter allows memory protection keys and kills ptrace; the agent's tools' Chromium starts
#     headless under it, it answers DevTools' /json/version, and no seccomp kill of it is logged (NX-512)
{
  applianceModules,
  pkgs,
  lib,
  ...
}:
let
  real = import ./common/real-runtime.nix { inherit pkgs lib; };
  # The agent's tools' Chromium as the runner's relay starts it (Whombat browser.ts chromiumCommand): headless, a fresh
  # profile, a DevTools port of its own; it answers /json/version once it says where it listens (NX-512).
  chromiumCdp = pkgs.writeShellScript "whombat-vmtest-chromium-cdp" ''
    set -u
    export PATH=$1/bin:${pkgs.coreutils}/bin:${pkgs.gnused}/bin:${pkgs.curl}/bin
    dir=$(mktemp -d /tmp/whombat-browser.XXXXXXXX)
    export HOME=$dir
    chromium --headless=new --remote-debugging-port=0 --user-data-dir="$dir" --no-first-run --no-default-browser-check \
      --disable-dev-shm-usage --disable-background-networking --disable-component-update --disable-sync \
      --disable-default-apps --mute-audio --password-store=basic --log-level=3 about:blank >"$dir/log" 2>&1 &
    pid=$!
    port=
    for _ in $(seq 1 900); do
      port=$(sed -n 's#.*DevTools listening on ws://127.0.0.1:\([0-9]*\)/devtools/browser/.*#\1#p' "$dir/log")
      [ -n "$port" ] && break
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.1
    done
    rc=1
    if [ -n "$port" ]; then
      curl -sf --max-time 10 "http://127.0.0.1:$port/json/version" && rc=0
    else
      tail -n 20 "$dir/log" >&2
    fi
    kill "$pid" 2>/dev/null
    wait "$pid" 2>/dev/null
    rm -rf "$dir"
    exit $rc
  '';
in
{
  name = "whombat-runtime-real";

  nodes = {
    control = real.control;
    machine =
      { config, ... }:
      {
        imports = applianceModules ++ [
          (import ./common/appliance-vm.nix { serial = "SN-RT-0001"; })
          real.machine
        ];
        environment.systemPackages = [ pkgs.socat ];
        # The agent's tools, for their Chromium under the runner's syscall filter (NX-512).
        virtualisation.additionalPaths = [ config.whombat.agent.tools ];
      };
  };

  testScript =
    { nodes, ... }:
    ''
      import json

      bundle = "${real.runtime}"

      def sh(cmd):
          return machine.succeed(cmd).strip()

      def health(user="whombat-manager"):
          return json.loads(sh(f"runuser -u {user} -- curl -sf --max-time 10 --unix-socket /run/whombat/admin.sock http://runtime/health"))

      def helper(req):
          out = sh(f"echo '{json.dumps(req)}' | runuser -u whombat-manager -- socat -t 300 - UNIX-CONNECT:/run/whombat-update-helper/helper.sock")
          print("helper:", out)
          return json.loads(out)

      start_all()
      control.wait_for_unit("tuf-real.service")
      control.wait_for_open_port(4600)
      control.wait_for_open_port(8080)
      control.succeed("curl -sf http://localhost:8080/metadata/timestamp.json >/dev/null")
      machine.wait_for_unit("multi-user.target")

      with subtest("the image seeds the runtime profile with the real bundle"):
          machine.wait_until_succeeds("test -e /nix/var/nix/profiles/whombat-runtime", timeout=60)
          assert sh("readlink -f /nix/var/nix/profiles/whombat-runtime") == bundle
          for b in ["whombat", "whombat-server", "whombat-runner"]:
              machine.succeed(f"test -x {bundle}/bin/{b}")
          machine.succeed(f"jq -e '.standIn == false' {bundle}/share/whombat/bundle.json")
          # Unprovisioned: nothing identity-bound runs, the schema is not touched.
          for u in ["whombat-server", "whombat-runner", "whombat-runtime-schema-init"]:
              machine.fail(f"systemctl is-active {u}.service")
          # The helper's env file is the runtime user's, 0400 (the runtime refuses a group-readable one, MR-73).
          assert sh("stat -L -c '%U:%G %a' /etc/whombat/runtime.env") == "whombat:whombat 400"

      with subtest("factory provisioning with the real release"):
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
          machine.wait_until_succeeds("systemctl show -P ActiveState whombat-factory-provision | grep -qE '^(inactive|active)$'", timeout=120)
          print(machine.succeed("journalctl -u whombat-factory-provision --no-pager | tail -20"))
          device = sh("jq -r .deviceId /persist/identity/device.json")

      with subtest("first boot: the schema is created on the empty database (NX-46)"):
          machine.wait_until_succeeds("systemctl show -P ActiveState whombat-runtime-schema-init | grep -qx active", timeout=180)
          log = sh("journalctl -u whombat-runtime-schema-init --no-pager")
          print(log)
          assert "empty database: creating the schema of " + bundle in log, log
          assert '"ok":true' in log and '"verdict":"current"' in log, log
          n = int(sh("runuser -u whombat -- psql -X -A -t -d whombat -c 'select count(*) from whombat_meta.schema_versions'"))
          assert n > 0, n

      with subtest("server and runner: Type=notify, READY from Node, watchdog"):
          for u in ["whombat-server", "whombat-runner"]:
              machine.wait_for_unit(f"{u}.service", timeout=180)
              assert sh(f"systemctl show -P Type {u}") == "notify"
              assert sh(f"systemctl show -P NotifyAccess {u}") == "all"
              assert sh(f"systemctl show -P WatchdogUSec {u}") == "10s"
              pid = sh(f"systemctl show -P MainPID {u}")
              exe = sh(f"readlink /proc/{pid}/exe")
              assert "nodejs-slim-24" in exe and exe.endswith("/bin/node"), exe
              assert bundle in sh(f"tr '\\0' ' ' < /proc/{pid}/cmdline")
          print(sh("systemctl show -P StatusText whombat-server whombat-runner"))
          # Several watchdog periods (10 s) without a restart: the pings arrive.
          machine.sleep(35)
          for u in ["whombat-server", "whombat-runner"]:
              assert sh(f"systemctl show -P NRestarts {u}") == "0", u
              machine.succeed(f"systemctl is-active {u}.service")
          machine.fail("journalctl -u whombat-server -u whombat-runner --no-pager | grep -q 'systemd notification failed'")

      with subtest("the runner's syscall filter: memory protection keys and mincore allowed, ptrace not; the agent's Chromium starts under it (NX-512)"):
          allowed = sh("systemctl show -P SystemCallFilter whombat-runner").split()
          assert not allowed[0].startswith("~"), allowed[:3]
          for name in ["pkey_alloc", "pkey_free", "pkey_mprotect", "mincore"]:
              assert name in allowed, name
          assert "ptrace" not in allowed
          # The runner's own filter on a transient unit as its user (a filter is inherited, never entered): what it
          # starts, the commands' wrapper and Chromium in it, runs under the same one.
          run = ("systemd-run --quiet --wait --pipe --collect -p User=whombat-runner -p Group=whombat-runner"
                 f" -p SystemCallArchitectures=native -p SystemCallFilter='{' '.join(allowed)}' --")
          probe = "${pkgs.python3}/bin/python3 -I -c 'import ctypes, sys; ctypes.CDLL(None).syscall(int(sys.argv[1]), 0, 0)'"
          # pkey_alloc (330) answers, with a key or an error when the CPU has none; ptrace (101) is killed with SIGSYS.
          machine.succeed(f"{run} {probe} 330")
          # mincore (27, NX-513) answers too: Chromium's memory accounting asks it (EINVAL for these arguments, not SIGSYS).
          machine.succeed(f"{run} {probe} 27")
          status, out = machine.execute(f"{run} {probe} 101")
          assert status != 0, out
          # The agent's tools' Chromium, as the runner's relay starts it: it listens and answers DevTools' /json/version.
          tools = "${nodes.machine.whombat.agent.tools}"
          out = sh(f"{run} ${chromiumCdp} {tools}")
          assert '"Browser"' in out and "webSocketDebuggerUrl" in out, out
          machine.fail("journalctl -k --no-pager -o cat | grep -E 'type=1326|SECCOMP' | grep -q 'comm=\"chromium\"'")

      with subtest("admin socket and health"):
          assert sh("stat -c '%U:%G %a' /run/whombat/admin.sock") == "whombat:whombat-admin 660"
          machine.wait_until_succeeds(
              "runuser -u whombat-manager -- curl -sf --unix-socket /run/whombat/admin.sock http://runtime/health"
              " | jq -e '.status == \"ok\" and .checks.db.ok == true'",
              timeout=120,
          )
          h = health()
          print("health:", json.dumps(h))
          assert h["status"] == "ok" and h["checks"]["db"]["ok"] is True, h
          for user in ["whombat-runner", "nobody"]:
              machine.fail(f"runuser -u {user} -- curl -sf --max-time 5 --unix-socket /run/whombat/admin.sock http://runtime/health")
          # The boot assessment's own check (manager user, settle 5 s).
          machine.succeed("systemctl restart whombat-boot-assessment.service")
          machine.wait_until_succeeds("journalctl -u whombat-boot-assessment --no-pager | grep -q 'boot assessment: passed'", timeout=120)

      with subtest("the console file is written by the real server"):
          machine.wait_until_succeeds("test -s /run/whombat/console/console.json", timeout=120)
          assert sh("stat -c '%U:%G %a' /run/whombat/console/console.json") == "whombat:whombat-console 640"
          state = json.loads(sh("runuser -u whombat-console -- cat /run/whombat/console/console.json"))
          print("console:", state)
          # One of the contract's states (local.ConsoleClaimState); with the fake control there is no claim-code lease.
          assert state["v"] == 1 and state["state"] in ("starting", "waiting", "claimable", "backoff", "claimed"), state
          # The tty1 console reads it as the runtime wrote it.
          print(machine.succeed("runuser -u whombat-console -- ${nodes.machine.whombat.console.package}/bin/whombat-console --once --file /run/whombat/console/console.json --width 100"))
          for user in ["whombat-runner", "whombat-manager"]:
              machine.fail(f"runuser -u {user} -- cat /run/whombat/console/console.json")

      with subtest("watchdog: a stopped server misses its pings and is restarted"):
          pid = sh("systemctl show -P MainPID whombat-server")
          machine.succeed(f"kill -STOP {pid}")
          machine.wait_until_succeeds("test $(systemctl show -P NRestarts whombat-server) -ge 1", timeout=90)
          machine.succeed("journalctl -u whombat-server --no-pager | grep -q 'Watchdog timeout'")
          machine.wait_for_unit("whombat-server.service", timeout=180)
          machine.wait_until_succeeds(
              "runuser -u whombat-manager -- curl -sf --unix-socket /run/whombat/admin.sock http://runtime/health | jq -e '.status == \"ok\"'",
              timeout=120,
          )

      with subtest("the helper's migrate-runtime migrates PostgreSQL with the bundle's bin/whombat"):
          # An empty database again, with the runtime stopped.
          machine.succeed("systemctl stop whombat-runtime.target whombat-server whombat-runner")
          machine.succeed(
              "runuser -u postgres -- dropdb whombat",
              "runuser -u postgres -- createdb -O whombat whombat",
          )
          machine.fail("runuser -u whombat -- psql -X -A -t -d whombat -c 'select 1 from whombat_meta.schema_versions'")
          # The manager has published the republished metadata (with rt-real-1) for the helper.
          machine.wait_until_succeeds("grep -l '\"${real.releaseId}\"' /persist/manager/tuf/mirror/*.targets.json", timeout=300)
          # control's assignment for this device (development assignment key), as the manager stores it.
          control.succeed(f"tufrepo assign --dir ${real.repoDir} --device {device} --release ${real.releaseId} --seq 1 --out /tmp/assignment.json")
          assignment = control.succeed("cat /tmp/assignment.json").strip()
          machine.succeed(
              "install -d -o whombat-manager -g whombat-manager -m 0700 /persist/manager/assignment",
              f"echo '{assignment}' > /persist/manager/assignment/current.json",
              "chown whombat-manager:whombat-manager /persist/manager/assignment/current.json",
          )
          check = helper({"v": 1, "op": "check-schema", "releaseId": "${real.releaseId}"})
          c = check["result"]["schema"]
          assert check["ok"] and c["exit"] == 10 and c["verdict"] == "migration_required" and c["databaseVersion"] == 0, check
          res = helper({"v": 1, "op": "migrate-runtime", "releaseId": "${real.releaseId}"})
          s = res["result"]["schema"]
          assert res["ok"] and s["exit"] == 0 and s["access"] == "read-write" and s["verdict"] == "current", res
          # The empty database took the binary's whole chain, each migration recorded once. A chain's versions go on
          # from the chain before it (its baseline stands for the migrations it replaced), so they end at the binary's
          # version rather than start at 1.
          rows = [r.split("|") for r in sh("runuser -u whombat -- psql -X -A -t -d whombat -c 'select version, tag from whombat_meta.schema_versions order by version'").splitlines()]
          assert rows and [tag for _, tag in rows] == s.get("applied"), (rows, res)
          last = c["binaryVersion"]
          assert [int(v) for v, _ in rows] == list(range(last - len(rows) + 1, last + 1)), (rows, res)
          # It ran the bundle's CLI as the runtime user (the helper's journal names the store path).
          print(machine.succeed("journalctl -u whombat-update-helper --no-pager | tail -20"))
          machine.succeed("systemctl reset-failed whombat-server whombat-runner || true")
          machine.succeed("systemctl start whombat-runtime.target")
          machine.wait_for_unit("whombat-server.service", timeout=180)
          machine.wait_for_unit("whombat-runner.service", timeout=180)
          machine.wait_until_succeeds(
              "runuser -u whombat-manager -- curl -sf --unix-socket /run/whombat/admin.sock http://runtime/health | jq -e '.status == \"ok\" and .checks.db.ok == true'",
              timeout=120,
          )
    '';
}
