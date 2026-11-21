# Runner sandbox prerequisites under the real unit (W3-SBX "Unrun qualifications" 1–2) and a backup
# checkpoint through the real backup services (W3-BK) on the btrfs /persist:
#   - whombat-runner has Delegate=cpu memory pids; a process left in a task sub-cgroup is killed when the
#     runner's main process crashes, and the runner comes back
#   - the nftables wall on the runner's cgroup rejects private/metadata/ULA destinations from a task
#     cgroup (IPv4 and IPv6), lets a granted CIDR through, and does not affect other units
#   - the pinned toolchain is on the runner's environment (WHOMBAT_SANDBOX_RO_PATHS); its Python's document libraries
#     import inside bubblewrap (SL-11, NX-98)
#   - AI clients are not in the image (NX-37): no provider pins or paths, WHOMBAT_CLIENTS_FILE for server and
#     runner, the install root owned by the manager, readable and executable but not writable by the runner
#   - a checkpoint with the btrfs snapshot driver against a restic rest-server --append-only; the
#     repository password is sealed with systemd-creds; the append-only destination refuses deletion
# The stand-in runtime answers the drain; real provider turns in the sandbox are W3-SBX/W3-PV's.
{
  applianceModules,
  pkgs,
  lib,
  ...
}:
{
  name = "whombat-sandbox-backup";

  nodes = {
    control =
      { pkgs, ... }:
      {
        imports = [ ./common/control.nix ];
        services.restic.server = {
          enable = true;
          listenAddress = "8000";
          appendOnly = true;
          extraFlags = [ "--no-auth" ];
        };
        networking.firewall.allowedTCPPorts = [
          8000
          443
        ];
        systemd.services.listener443 = {
          wantedBy = [ "multi-user.target" ];
          serviceConfig.ExecStart = "${pkgs.python3}/bin/python3 -m http.server 443 --directory /tmp";
        };
        environment.systemPackages = [ pkgs.restic ];
      };
    machine =
      { lib, ... }:
      {
        imports = applianceModules ++ [ (import ./common/appliance-vm.nix { serial = "SN-SBX-0001"; }) ];
        whombat.network.outboundTcpPorts = lib.mkForce [
          443
          4600
          8080
          8000
        ];
        # The rest-server is on the private test network: the backup service reaches it (egress 8000),
        # tasks only through an explicit grant.
        whombat.sandbox.grants = [
          {
            cidr = "192.168.1.0/24";
            ports = [ 8000 ];
          }
        ];
        virtualisation.memorySize = 3072;
        # The backup preflight keeps 2 GiB free for staging (W3-BK reserveBytes).
        virtualisation.emptyDiskImages = lib.mkForce [
          {
            size = 8192;
            driveConfig.deviceExtraOpts.serial = "persist";
          }
          {
            size = 64;
            driveConfig.deviceExtraOpts.serial = "factory";
          }
        ];
        environment.systemPackages = [ pkgs.restic ];
      };
  };

  testScript =
    { nodes, ... }:
    ''
    import json, re

    start_all()
    control.wait_for_unit("fake-control.service")
    control.wait_for_open_port(4600)
    control.wait_for_open_port(8080)
    control.wait_for_unit("restic-rest-server.socket")
    machine.wait_for_unit("multi-user.target")

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
    machine.wait_for_unit("whombat-runner.service")
    machine.wait_for_unit("whombat-server.service")
    cg = "/sys/fs/cgroup" + machine.succeed("systemctl show -P ControlGroup whombat-runner").strip()
    assert cg.endswith("/whombat.slice/whombat-tasks.slice/whombat-runner.service"), cg

    with subtest("runner: delegated cgroup, sandbox environment, toolchain"):
        assert machine.succeed("systemctl show -P Delegate whombat-runner").strip() == "yes"
        ctrl = machine.succeed("systemctl show -P DelegateControllers whombat-runner")
        for c in ["cpu", "memory", "pids"]:
            assert c in ctrl, ctrl
        env = machine.succeed("systemctl show -P Environment whombat-runner")
        assert "WHOMBAT_SANDBOX_CGROUP=delegated" in env, env
        ro = [e for e in env.split() if e.startswith("WHOMBAT_SANDBOX_RO_PATHS=")][0].split("=", 1)[1].split(":")
        assert ro[1:] == ["/persist/whombat/clients"], ro
        for tool in ["git", "node", "pnpm", "python3", "bash"]:
            machine.succeed(f"test -x {ro[0]}/bin/{tool}")
        # The skills' document libraries import inside a bubblewrap sandbox as the runner builds one (SL-11, NX-98).
        machine.succeed(
            "runuser -u whombat-runner -- ${pkgs.bubblewrap}/bin/bwrap --unshare-all --die-with-parent --ro-bind /nix/store /nix/store"
            f" --proc /proc --dev /dev --tmpfs /tmp {ro[0]}/bin/python3 -c 'import docx, openpyxl, pptx, pypdf, PIL.Image'"
        )
        allow = [e for e in env.split() if e.startswith("WHOMBAT_SANDBOX_EGRESS_ALLOW=")][0].split("=", 1)[1].split(",")
        for host in ["claude.ai", "console.anthropic.com", "platform.claude.com", "api.anthropic.com"]:
            assert host in allow, allow
        machine.succeed(f"stat -c %U {cg} | grep -qx whombat-runner")
        machine.succeed("systemctl is-active whombat-sandbox-prereqs.service")

    with subtest("AI clients: none in the image; installed by the manager, run by the runner (NX-37)"):
        env = machine.succeed("systemctl show -P Environment whombat-runner").split()
        envd = dict(e.split("=", 1) for e in env if "=" in e)
        for gone in ["WHOMBAT_PROVIDER_PINS", "WHOMBAT_CLAUDE_PATH", "WHOMBAT_CODEX_PATH"]:
            assert gone not in envd, gone
        assert envd["WHOMBAT_CLIENTS_FILE"] == "/run/whombat-clients/clients.json", envd
        assert envd["WHOMBAT_CLIENTS_ROOT"] == "/persist/whombat/clients", envd
        server = machine.succeed("systemctl show -P Environment whombat-server")
        assert "WHOMBAT_CLIENTS_FILE=/run/whombat-clients/clients.json" in server, server
        assert "WHOMBAT_CLIENTS_ROOT=/persist/whombat/clients" in server, server
        assert "WHOMBAT_CREDENTIALS_ROOT" not in server
        machine.fail("systemctl cat whombat-provider-profiles-init.service")
        # The status file's directory: the server writes, the runner reads, nobody else.
        machine.succeed("stat -c '%a %U %G' /run/whombat-clients | grep -qx '2750 whombat whombat-runner'")
        machine.succeed("runuser -u whombat -- sh -c 'umask 077; echo {} > /run/whombat-clients/t && chmod 0640 /run/whombat-clients/t'")
        machine.succeed("runuser -u whombat-runner -- cat /run/whombat-clients/t")
        machine.fail("runuser -u whombat-runner -- touch /run/whombat-clients/x")
        machine.fail("runuser -u whombat-manager -- cat /run/whombat-clients/t")
        machine.succeed("rm /run/whombat-clients/t")
        # The install root: the manager's (0755), a version installed the way the manager does it (read-only).
        machine.succeed("stat -c '%a %U' /persist/whombat/clients | grep -qx '755 whombat-manager'")
        machine.succeed("stat -c '%a %U' /persist/manager/clients | grep -qx '700 whombat-manager'")
        machine.succeed(
            "runuser -u whombat-manager -- sh -c 'umask 077; d=/persist/whombat/clients/codex/0.0.1; mkdir -p $d/bin"
            " && printf \"#!/bin/sh\\necho codex-cli 0.0.1\\n\" > $d/bin/codex && chmod 0555 $d/bin/codex $d/bin $d"
            " && chmod 0755 /persist/whombat/clients/codex && ln -sfn 0.0.1 /persist/whombat/clients/codex/current'"
        )
        out = machine.succeed("runuser -u whombat-runner -- /persist/whombat/clients/codex/current/bin/codex").strip()
        assert out == "codex-cli 0.0.1", out
        machine.fail("runuser -u whombat-runner -- touch /persist/whombat/clients/codex/0.0.1/bin/codex")
        machine.fail("runuser -u whombat-runner -- rm -rf /persist/whombat/clients/codex")
        machine.fail("runuser -u whombat -- touch /persist/whombat/clients/x")
        machine.succeed("rm -rf /persist/whombat/clients/codex")
        # Claude Code is glibc-linked and runs unmodified through nix-ld.
        machine.succeed("test -e /lib64/ld-linux-x86-64.so.2")
        machine.succeed(f"test -e {envd['NIX_LD']}")
        machine.fail("runuser -u whombat -- ls /persist/whombat/credentials")

    with subtest("orphan task processes die with a crashed runner"):
        machine.succeed(f"mkdir -p {cg}/tasks/orphan")
        machine.succeed(f"setsid sh -c 'echo $$ > {cg}/tasks/orphan/cgroup.procs; exec sleep 100000' >/dev/null 2>&1 &")
        machine.wait_until_succeeds(f"grep -q . {cg}/tasks/orphan/cgroup.procs")
        orphan = machine.succeed(f"head -1 {cg}/tasks/orphan/cgroup.procs").strip()
        before = int(machine.succeed("systemctl show -P NRestarts whombat-runner").strip())
        machine.succeed("systemctl kill --kill-whom=main -s KILL whombat-runner")
        machine.wait_until_succeeds(f"test $(systemctl show -P NRestarts whombat-runner) -gt {before}", timeout=90)
        machine.wait_for_unit("whombat-runner.service")
        machine.fail(f"kill -0 {orphan}")

    with subtest("nftables wall on the runner's cgroup"):
        machine.succeed("nft list table inet whombat_runner >/dev/null")
        # Other units are unaffected (before and after the task probes).
        machine.succeed("curl -4 -sf --max-time 20 http://control:443/ >/dev/null")
        machine.succeed(f"mkdir -p {cg}/tasks/probe")
        def in_task(cmd):
            return f"sh -c 'echo $$ > {cg}/tasks/probe/cgroup.procs; exec {cmd}'"
        machine.fail(in_task("curl -sf --max-time 5 http://control:443/"))          # private address
        machine.fail(in_task("curl -sf --max-time 5 http://169.254.169.254/"))      # metadata
        machine.fail(in_task("curl -sf --max-time 5 -g http://[fd00::1]/"))         # ULA (IPv6)
        machine.succeed(in_task("curl -s --max-time 10 -o /dev/null http://control:8000/"))  # granted CIDR:port
        rc, out = machine.execute("curl -4 -v --max-time 20 http://control:443/ -o /dev/null 2>&1")
        if rc != 0:
            print(out)
            print(machine.succeed("nft list ruleset; cat /proc/self/cgroup; ss -tnp | head -20"))
        assert rc == 0, "other units must be unaffected by the runner wall"
        counters = machine.succeed("nft list table inet whombat_runner")
        print(counters)
        hits = [int(n) for n in re.findall(r"@denied[46] counter packets (\d+)", counters)]
        assert len(hits) == 2 and all(h > 0 for h in hits), counters

    with subtest("backup checkpoint: btrfs snapshots to an append-only rest-server"):
        machine.succeed("systemctl is-active whombat-backup-pgrole.service || systemctl start whombat-backup-pgrole.service")
        machine.succeed("echo 'hello from home' > /persist/whombat/home/note.txt && chown whombat:whombat /persist/whombat/home/note.txt")
        out = machine.succeed(
            "cd / && runuser -u whombat-backup -- whombat-backup -config $(systemctl cat whombat-backup | grep -o '/nix/store/[^ ]*whombat-backup.json' | head -1)"
            # Plain http only to a numeric address on the box's own network (BK-29).
            " destination set -repository rest:http://${nodes.control.networking.primaryIPAddress}:8000/whombat -init 2>&1"
        )
        print(out)
        machine.succeed("systemctl start whombat-backup.service")
        print(machine.succeed("journalctl -u whombat-backup --no-pager | tail -40"))
        machine.succeed("test ! -e /persist/backup/secrets/repository-password")
        machine.succeed("test -e /persist/backup-root/repository-password.cred")  # root-only (BK-26)
        status = json.loads(machine.succeed("cat /persist/backup/status.json"))
        print(json.dumps(status, indent=1)[:1500])
        assert status.get("state") == "protected", status
        assert status.get("lastSuccess"), status
        machine.fail("btrfs subvolume list /persist | grep -q staging/current/files")
        # The repository received a checkpoint; the append-only server refuses deletion.
        snaps = control.succeed("ls /var/lib/restic/whombat/snapshots | wc -l").strip()
        assert int(snaps) >= 1, snaps
        victim = control.succeed("ls /var/lib/restic/whombat/snapshots | head -1").strip()
        code = machine.succeed(f"curl -s -o /dev/null -w '%{{http_code}}' -X DELETE http://control:8000/whombat/snapshots/{victim}").strip()
        assert code == "403", code

    with subtest("backup units see no identity keys, Secure Boot keys or other units' credentials (M-5)"):
        # Stand-ins for the secrets a compromised backup process must not reach (created if this VM has none).
        machine.succeed(
            "test -e /persist/identity/management.key || (echo MGMT-KEY-MARKER > /persist/identity/management.key && chmod 600 /persist/identity/management.key)",
            "test -e /persist/identity/content.key || (echo CONTENT-KEY-MARKER > /persist/identity/content.key && chmod 600 /persist/identity/content.key)",
            "mkdir -p /var/lib/sbctl/keys/db && echo DB-KEY-MARKER > /var/lib/sbctl/keys/db/db.key && chmod 600 /var/lib/sbctl/keys/db/db.key",
        )
        machine.succeed("systemctl start whombat-backup-api.service")
        pid = machine.succeed("systemctl show -P MainPID whombat-backup-api.service").strip()
        assert pid != "0", pid
        ns = f"nsenter -t {pid} -m --"
        for secret in ["/persist/identity/management.key", "/persist/identity/content.key", "/persist/identity/claim.json",
                       "/var/lib/sbctl/keys/db/db.key", "/var/lib/whombat-update-helper/state.json",
                       "/var/lib/whombat-storage/pcr-policy.key", "/persist/secrets/master.key"]:
            machine.fail(f"{ns} cat {secret}")
        machine.succeed(f"test -z \"$({ns} ls -A /var/lib)\"")
        if machine.execute("test -e /persist/identity/content.peerid")[0] == 0:
            machine.succeed(f"{ns} cat /persist/identity/content.peerid")
        # The API process itself (its capability) cannot read them either.
        caps = machine.succeed(f"grep CapEff /proc/{pid}/status")
        print("backup-api", caps)
        for u in ["whombat-backup", "whombat-backup-drill", "whombat-backup-snapd"]:
            props = machine.succeed(f"systemctl show -p TemporaryFileSystem -p InaccessiblePaths {u}")
            assert "/var/lib:ro" in props and "/persist/identity:ro" in props, (u, props)
  '';
}
