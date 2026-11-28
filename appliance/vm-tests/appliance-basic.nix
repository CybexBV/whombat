# Service-level appliance test (direct boot):
#   - unprovisioned appliance: nothing identity-bound runs, nothing listens outside loopback
#   - persistent layout, owners and modes (MA-12)
#   - factory provisioning from a WBFACTORY medium on two VMs of the same system: unique
#     identities, registered with a (fake) control that verifies both key proofs; a duplicate serial is
#     refused and leaves no identity behind
#   - runtime + manager + PostgreSQL healthy, boot assessment passes after a reboot, state survives
#   - no inbound listening sockets reachable from another host but the runtime's direct port (NX-440); egress allowlist;
#     sandbox uids blocked
#   - service watchdog restarts a hung runtime
#   - journald stays under its cap under a log flood
#   - disk full on /persist: PostgreSQL keeps writing (reserved blocks), the reserve can be released
#   - network: the committed configuration is restored before networkd on boot; a dead-man revert
#     restores connectivity after a bad candidate (module-level; the helper op is W1-MG's)
{
  applianceModules,
  pkgs,
  lib,
  ...
}:
let
  token = "dev-station-token-for-vm-tests-only";
  applianceNode = serial: {
    imports = applianceModules ++ [ (import ./common/appliance-vm.nix { inherit serial; }) ];
  };
in
{
  name = "whombat-appliance-basic";

  nodes = {
    control =
      { pkgs, ... }:
      {
        imports = [ ./common/control.nix ];
        networking.firewall.allowedTCPPorts = [
          443
          8443
        ];
        # Plain listeners to test the appliance's egress allowlist.
        systemd.services.listeners = {
          wantedBy = [ "multi-user.target" ];
          path = [ pkgs.python3 ];
          script = ''
            cd /tmp
            python3 -m http.server 443 &
            python3 -m http.server 8443 &
            wait
          '';
        };
        environment.systemPackages = [
          pkgs.nmap
          pkgs.curl
        ];
      };
    machine1 = applianceNode "SN-VM-0001";
    machine2 = applianceNode "SN-VM-0002";
  };

  # Runs with the stand-in and with the real runtime bundle (`appliance-basic-real-runtime`, NX-49): the runtime is
  # asked as the manager's user (the real one checks the peer), and "hung" is a stopped process.
  testScript = ''
    import json

    def sh(m, cmd):
        return m.succeed(cmd).strip()

    start_all()
    control.wait_for_unit("fake-control.service")
    control.wait_for_open_port(4600)

    with subtest("unprovisioned: identity-bound services do not run"):
        for m in [machine1, machine2]:
            m.wait_for_unit("multi-user.target")
            m.wait_for_unit("postgresql.service")
            m.succeed("test ! -e /persist/identity/device.json")
            for u in ["whombat-server", "whombat-runner", "whombat-manager"]:
                m.fail(f"systemctl is-active {u}.service")

    with subtest("persistent layout, owners and modes"):
        expected = {
            "/persist": "root:root 755",
            "/persist/identity": "root:root 711",
            "/persist/postgres/17": "postgres:postgres 700",
            "/persist/whombat/home": "whombat:whombat 700",
            "/persist/whombat/workspaces": "whombat-runner:whombat-workspaces 2770",
            "/persist/whombat/credentials": "whombat-runner:whombat-runner 700",
            "/persist/manager": "whombat-manager:whombat-manager 700",
            "/persist/backup": "root:whombat-backup 771",
            "/persist/secrets": "root:root 700",
        }
        for path, want in expected.items():
            got = sh(machine1, f"stat -c '%U:%G %a' {path}")
            assert got == want, f"{path}: {got} != {want}"
        assert sh(machine1, "id -u whombat-manager") == "950"
        assert sh(machine1, "id -u whombat") == "951"
        assert sh(machine1, "id -u whombat-runner") == "952"
        machine1.succeed("grep -qx 'whombat-runner:2000000:65536' /etc/subuid")
        machine1.succeed("systemctl is-active whombat-sandbox-prereqs.service")
        # PostgreSQL: its data directory is on /persist and it listens on loopback only.
        machine1.succeed("test -e /persist/postgres/17/PG_VERSION")

    def make_medium(m):
        station = json.dumps({
            "v": 1, "environment": "dev", "controlUrl": "http://control:4600",
            "tokenFile": "token", "model": "whombat-one", "requireSecureBoot": False,
            "factoryRelease": "rt-fixture-1", "seedHelper": False,
        })
        m.succeed(
            "mkfs.vfat /dev/disk/by-id/virtio-factory",
            "mkdir -p /mnt/medium && mount /dev/disk/by-id/virtio-factory /mnt/medium",
            f"echo '{station}' > /mnt/medium/station.json",
            "echo '${token}' > /mnt/medium/token",
            "umount /mnt/medium",
            # Setting the label makes udev announce the medium, which starts provisioning.
            "fatlabel /dev/disk/by-id/virtio-factory WBFACTORY",
        )

    with subtest("factory provisioning on two VMs of the same system"):
        for m in [machine1, machine2]:
            make_medium(m)
        records = {}
        for m in [machine1, machine2]:
            m.wait_until_succeeds("test -e /persist/identity/device.json", timeout=120)
            m.wait_until_succeeds("systemctl show -P ActiveState whombat-factory-provision | grep -qE 'inactive|active'")
            print(m.succeed("journalctl -u whombat-factory-provision --no-pager"))
            records[m.name] = json.loads(sh(m, "whombat-provision verify"))
            # Keys and secrets: owners/modes checked by verify; nothing secret in public files.
            m.succeed("test \"$(stat -c '%U %a' /persist/identity/management.key)\" = 'whombat-manager 600'")
            m.succeed("test \"$(stat -c '%U %a' /persist/identity/content.key)\" = 'root 600'")
            m.succeed("test \"$(stat -c '%U %a' /persist/secrets/master.key)\" = 'root 600'")
            # Cards on the medium; the token was never copied to the disk.
            m.succeed("mount /dev/disk/by-label/WBFACTORY /mnt/medium")
            dev = records[m.name]["deviceId"]
            m.succeed(f"test -s /mnt/medium/cards/claim-{dev}.svg && test -s /mnt/medium/cards/record-{dev}.json")
            # CC-02/NX-34: the card names the appliance and prints no fingerprint to compare.
            m.succeed(f"grep -q '>{dev}<' /mnt/medium/cards/claim-{dev}.svg")
            m.fail(f"grep -q '{records[m.name]['fingerprint']}' /mnt/medium/cards/claim-{dev}.svg")
            m.fail("grep -rq '${token}' /persist /var/lib 2>/dev/null")
            m.succeed("umount /mnt/medium")
        a, b = records["machine1"], records["machine2"]
        assert a["serial"] == "SN-VM-0001" and b["serial"] == "SN-VM-0002", (a, b)
        for k in ["deviceId", "contentPeerId", "managementPublicKey", "contentPublicKey", "fingerprint"]:
            assert a[k] != b[k], f"{k} is not unique: {a[k]}"
        machine1.fail("cmp -s /persist/secrets/master.key /dev/null")
        registered = json.loads(sh(control, "curl -s http://127.0.0.1:4600/test/devices"))
        assert sorted(d["device"] for d in registered) == sorted([a["deviceId"], b["deviceId"]]), registered

    with subtest("a repeated serial is refused by control and leaves no identity"):
        machine2.succeed("echo '${token}' > /tmp/token")
        out = machine2.fail(
            "whombat-provision provision --env dev --serial SN-VM-0001 --control-url http://control:4600"
            " --token-file /tmp/token --card-dir /tmp/cards --persist /tmp/p --allow-unmounted"
            " --require-secure-boot=false 2>&1"
        )
        assert "conflicting registration" in out, out
        machine2.succeed("test -z \"$(ls -A /tmp/p/identity)\"", "test ! -e /tmp/p/secrets/master.key")
        machine2.succeed("test -z \"$(ls -A /tmp/cards 2>/dev/null)\"")

    with subtest("runtime, manager and database are healthy"):
        for m in [machine1, machine2]:
            for u in ["whombat-server", "whombat-runner", "whombat-manager"]:
                m.wait_for_unit(f"{u}.service")
            m.wait_until_succeeds(
                "runuser -u whombat-manager -- curl -sf --unix-socket /run/whombat/admin.sock http://runtime/health"
                " | jq -e '.status == \"ok\"'",
                timeout=180,
            )
        # The runtime profile was seeded from the factory bundle (whombat.runtime.package).
        seeded = sh(machine1, "systemctl show -P ExecStart whombat-runtime-profile-init | grep -o -- '--set [^ ;]*' | cut -d' ' -f2")
        assert seeded.startswith("/nix/store/") and sh(machine1, "readlink -f /nix/var/nix/profiles/whombat-runtime") == seeded, seeded
        # Server credentials arrive via LoadCredential, not the environment.
        machine1.fail("systemctl show -P Environment whombat-server | grep -qF \"$(cat /persist/secrets/master.key)\"")
        machine1.succeed("systemctl show -P Environment whombat-server | grep -q 'WHOMBAT_MASTER_KEY_FILE=/run/credentials/whombat-server.service/master-key'")
        # NX-30: the hosted UI's origin (MR-45) on both units; the backup API for the server only
        # (MR-19), reachable by the server's and the manager's users.
        for u in ["whombat-server", "whombat-runner"]:
            machine1.succeed(f"systemctl show -P Environment {u} | tr ' ' '\\n' | grep -qx 'WHOMBAT_APP_URL=https://app.whombat.com'")
            # NX-39: the Feedback widget's origin (FD-31).
            machine1.succeed(f"systemctl show -P Environment {u} | tr ' ' '\\n' | grep -qx 'WHOMBAT_EMBED_URL=https://embed.whombat.com'")
        machine1.succeed("systemctl show -P Environment whombat-server | tr ' ' '\\n' | grep -qx 'WHOMBAT_BACKUP_SOCKET=/run/whombat-backup/api.sock'")
        machine1.fail("systemctl show -P Environment whombat-runner | grep -q WHOMBAT_BACKUP_SOCKET")
        machine1.succeed("jq -e '.backupSocket == \"/run/whombat-backup/api.sock\"' /etc/whombat/manager.json")
        for user in ["whombat", "whombat-manager"]:
            machine1.succeed(
                f"setpriv --reuid={user} --regid={user} --init-groups "
                "curl -sf --unix-socket /run/whombat-backup/api.sock http://backup/v1/status | jq -e ."
            )
        # NX-38: the pinned licence key set (the TEST set here), 0444, for the server (not the runner) and the manager.
        machine1.succeed("test \"$(stat -L -c '%U %a' /etc/whombat/licence-keys.json)\" = 'root 444'")
        machine1.succeed("jq -e '.env == \"test\" and .keys[0].kid == \"lic-test-1\"' /etc/whombat/licence-keys.json")
        machine1.succeed("systemctl show -P Environment whombat-server | tr ' ' '\\n' | grep -qx 'WHOMBAT_LICENCE_KEYS_FILE=/etc/whombat/licence-keys.json'")
        machine1.fail("systemctl show -P Environment whombat-runner | grep -q WHOMBAT_LICENCE")
        machine1.succeed("jq -e '.licence.keysFile == \"/etc/whombat/licence-keys.json\" and .licence.stateFile == \"/persist/manager/licence.json\"' /etc/whombat/manager.json")
        for user in ["whombat", "whombat-manager"]:
            machine1.succeed(f"setpriv --reuid={user} --regid={user} --init-groups cat /etc/whombat/licence-keys.json >/dev/null")
        machine1.succeed("systemctl show -P Slice whombat-server | grep -qx whombat-critical.slice")
        machine1.succeed("systemctl show -P Slice postgresql | grep -qx whombat-critical.slice")
        machine1.succeed("systemctl show -P Slice whombat-manager | grep -qx whombat-critical.slice")
        machine1.succeed("systemctl show -P Slice whombat-runner | grep -qx whombat-tasks.slice")
        machine1.succeed("test \"$(systemctl show -P MemoryMin whombat-critical.slice)\" = 268435456")

    with subtest("after a reboot: state persists and the boot assessment passes"):
        before = sh(machine1, "cat /persist/identity/content.peerid")
        machine1.shutdown()
        machine1.start()
        machine1.wait_for_unit("whombat-boot-assessment.service", timeout=300)
        machine1.succeed("systemctl is-active boot-complete.target")
        assert sh(machine1, "cat /persist/identity/content.peerid") == before
        print(machine1.succeed("journalctl -u whombat-boot-assessment --no-pager"))

    with subtest("no inbound but the direct port: nothing else reachable from another host"):
        # The runtime's direct listener (Whombat HE-50, NX-440) is the one socket outside loopback, on 4480 only.
        listeners = sh(machine1, "ss -Htln | awk '{print $4}'")
        for addr in listeners.split():
            assert (
                addr.startswith("127.") or addr.startswith("[::1]") or addr.rsplit(":", 1)[-1] == "4480"
            ), f"listening on {addr}"
        scan = control.succeed("nmap -Pn -sT -p- --min-rate 5000 --max-retries 1 machine1 -oG - | grep -v '^#'", timeout=900)
        print(scan)
        opened = [p.split("/")[0] for p in scan.split() if "/open/" in p]
        assert set(opened) <= {"4480"}, scan

    with subtest("egress allowlist and sandbox uids"):
        machine1.succeed("curl -sf --max-time 10 http://control:443/ >/dev/null")
        machine1.fail("curl -sf --max-time 5 http://control:8443/ >/dev/null")
        machine1.fail("setpriv --reuid=2000001 --regid=2000001 --clear-groups curl -sf --max-time 5 http://control:443/")
        counters = sh(machine1, "nft list chain inet whombat-egress sandbox")
        assert "fail closed" in counters, counters

    with subtest("service watchdog restarts a hung runtime"):
        before = int(sh(machine1, "systemctl show -P NRestarts whombat-server"))
        pid = sh(machine1, "systemctl show -P MainPID whombat-server")
        machine1.succeed(f"kill -STOP {pid}")
        machine1.wait_until_succeeds(f"test $(systemctl show -P NRestarts whombat-server) -gt {before}", timeout=90)
        machine1.wait_for_unit("whombat-server.service", timeout=180)
        machine1.succeed("journalctl -u whombat-server --no-pager | grep -q 'Watchdog timeout'")

    with subtest("journald stays within its cap"):
        # The test instrumentation forwards the journal to the serial console; not for the flood.
        machine1.succeed(
            "mkdir -p /run/systemd/journald.conf.d",
            "printf '[Journal]\\nForwardToConsole=no\\n' > /run/systemd/journald.conf.d/99-flood.conf",
            "systemctl restart systemd-journald",
        )
        machine1.succeed(
            "for i in $(seq 8); do head -c 16M /dev/urandom | base64 -w 200 | systemd-cat -t flood; done"
        )
        machine1.succeed("journalctl --flush --rotate")
        usage = sh(machine1, "du -sm /var/log/journal | cut -f1")
        assert int(usage) <= 40, f"journal uses {usage} MiB"
        machine1.succeed("rm /run/systemd/journald.conf.d/99-flood.conf && systemctl restart systemd-journald")

    with subtest("disk full on /persist: PostgreSQL keeps its headroom (btrfs qgroup)"):
        for sv in ["whombat/home", "whombat/workspaces", "whombat/credentials", "secrets", "manager", "backup", "postgres"]:
            machine1.succeed(f"btrfs subvolume show /persist/{sv} >/dev/null")
        machine1.succeed("lsattr -d /persist/postgres | grep -q C")
        print(machine1.succeed("btrfs qgroup show -reFp /persist"))
        out = machine1.succeed("runuser -u whombat-manager -- sh -c 'dd if=/dev/zero of=/persist/manager/fill bs=4M conv=fsync status=none 2>&1; echo rc=$?'")
        print(out)
        assert "rc=0" not in out and "quota exceeded" in out.lower(), out
        machine1.succeed(
            "runuser -u whombat -- psql -X -d whombat -c "
            "\"create table fill(x text); insert into fill select repeat(md5(g::text), 64) from generate_series(1, 20000) g\"",
            "runuser -u postgres -- psql -X -c checkpoint",
        )
        machine1.succeed("systemctl is-active postgresql whombat-server whombat-manager")
        machine1.succeed("rm -f /persist/manager/fill && sync && btrfs quota rescan -w /persist")
        machine1.succeed("runuser -u whombat-manager -- dd if=/dev/zero of=/persist/manager/fill3 bs=1M count=16 status=none")
        machine1.succeed("rm -f /persist/manager/fill3")

    with subtest("network: dead-man revert after a bad candidate"):
        machine1.succeed("curl -sf --max-time 5 http://control:443/ >/dev/null")
        good = sh(machine1, "networkctl status eth1 --no-pager | grep -m1 'Network File' | awk '{print $3}'")
        machine1.succeed(
            "systemd-run --unit=whombat-network-revert --collect --on-active=20 "
            "/bin/sh -c 'PATH=/run/current-system/sw/bin; rm -f /run/systemd/network/10-whombat.network; networkctl reload; networkctl reconfigure eth1'"
        )
        machine1.succeed(
            "mkdir -p /run/systemd/network",
            "printf '[Match]\\nName=eth1\\n[Network]\\nAddress=10.99.0.2/24\\n' > /run/systemd/network/10-whombat.network",
            "networkctl reload && networkctl reconfigure eth1",
        )
        machine1.wait_until_fails("curl -sf --max-time 3 http://control:443/ >/dev/null", timeout=30)
        machine1.wait_until_succeeds("curl -sf --max-time 3 http://control:443/ >/dev/null", timeout=90)
        print("reverted to", good)

    with subtest("network: the committed configuration is restored before networkd at boot"):
        addr = sh(machine1, "ip -4 -o addr show eth1 | awk '{print $4}' | head -1")
        machine1.succeed(
            "mkdir -p /var/lib/whombat-update-helper/network",
            f"printf '[Match]\\nName=eth1\\n[Network]\\nAddress={addr}\\nAddress=10.98.0.2/24\\n' "
            "> /var/lib/whombat-update-helper/network/committed.network",
        )
        machine1.shutdown()
        machine1.start()
        machine1.wait_for_unit("systemd-networkd.service")
        machine1.succeed("systemctl is-active whombat-network-restore.service")
        machine1.wait_until_succeeds("ip -4 -o addr show eth1 | grep -q 10.98.0.2", timeout=60)
        machine1.succeed("curl -sf --max-time 10 http://control:443/ >/dev/null")
  '';
}
