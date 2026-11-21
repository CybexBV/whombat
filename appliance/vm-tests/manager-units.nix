# The real whombat-manager and whombat-update-helper (W1-MG) under the appliance's systemd units — the
# items W1-MG lists as VM-only (docs/decisions/manager.md "Open items"):
#   - factory provisioning records the factory tuple in the manager journal (MG-20) against the
#     development TUF fixtures, and the manager comes up Type=notify (READY) as its own user
#   - helper socket activation and SO_PEERCRED across real users: the manager is answered, root is
#     refused by the helper, the runtime user cannot even connect (socket 0660 root:whombat-manager)
#   - the manager API socket is reachable by the runtime user and not by the runner
#   - WatchdogSec: a stopped (hung) manager is killed and restarted by systemd
#   - OnFailure: after the restart budget, whombat-manager-recovery takes over (MG-16)
# Not covered here: an actual update through the nix activator (needs release closures of this very
# image signed into a dev TUF repo; tracked as an open item), power loss (hardware).
{
  applianceModules,
  pkgs,
  lib,
  ...
}:
{
  name = "whombat-manager-units";

  nodes = {
    control = {
      imports = [ ./common/control.nix ];
    };
    machine = {
      imports = applianceModules ++ [ (import ./common/appliance-vm.nix { serial = "SN-MGR-0001"; }) ];
      whombat.manager.watchdogSec = 20;
      environment.systemPackages = [ pkgs.socat ];
    };
  };

  testScript = ''
    import json

    start_all()
    control.wait_for_unit("fake-control.service")
    control.wait_for_open_port(4600)
    control.wait_for_open_port(8080)
    machine.wait_for_unit("multi-user.target")

    with subtest("factory provisioning also provisions the manager journal"):
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
        machine.wait_until_succeeds("test -e /persist/identity/device.json", timeout=120)
        machine.wait_until_succeeds("systemctl show -P ActiveState whombat-factory-provision | grep -qE '^(inactive|active)$'", timeout=120)
        print(machine.succeed("journalctl -u whombat-factory-provision --no-pager | tail -20"))
        machine.succeed("test -n \"$(ls -A /persist/manager/journal)\"")

    with subtest("manager: Type=notify as its own user, key and state owned by it"):
        machine.wait_for_unit("whombat-manager.service")
        pid = machine.succeed("systemctl show -P MainPID whombat-manager").strip()
        assert machine.succeed(f"stat -c %U /proc/{pid}").strip() == "whombat-manager"
        machine.succeed("systemctl show -P Type whombat-manager | grep -qx notify")
        machine.succeed("systemctl show -P StatusText whombat-manager | grep -q 'whombat-manager'")
        print(machine.succeed("runuser -u whombat-manager -- whombat-manager --config /etc/whombat/manager.json status 2>&1 || true"))

    with subtest("helper: socket activation and peer uid across real users"):
        req = '{"v":1,"op":"bless-boot"}'
        machine.succeed("systemctl is-active whombat-update-helper.socket")
        out = machine.succeed(f"echo '{req}' | runuser -u whombat-manager -- socat -t 30 - UNIX-CONNECT:/run/whombat-update-helper/helper.sock")
        print("manager:", out)
        assert '"v":1' in out.replace(" ", "") and "forbidden" not in out, out
        machine.succeed("systemctl is-active whombat-update-helper.service")
        # root may connect (socket 0660 root:…) but the helper refuses any peer uid except the manager's.
        machine.execute(f"echo '{req}' | socat -t 30 - UNIX-CONNECT:/run/whombat-update-helper/helper.sock")
        machine.wait_until_succeeds("journalctl -u whombat-update-helper --no-pager | grep -q 'rejected helper client.*uid=0'", timeout=30)
        machine.fail(f"echo '{req}' | runuser -u whombat -- socat -t 5 - UNIX-CONNECT:/run/whombat-update-helper/helper.sock")
        machine.succeed("test \"$(stat -c '%U:%G %a' /run/whombat-update-helper/helper.sock)\" = 'root:whombat-manager 660'")

    with subtest("manager API socket: runtime user yes, runner no"):
        machine.wait_until_succeeds("test -S /run/whombat-manager/api.sock", timeout=60)
        code = machine.succeed(
            "runuser -u whombat -- curl -s -o /dev/null -w '%{http_code}' --unix-socket /run/whombat-manager/api.sock http://manager/v1/update/status"
        ).strip()
        assert code not in ("000", ""), code
        machine.fail("runuser -u whombat-runner -- curl -s --max-time 5 --unix-socket /run/whombat-manager/api.sock http://manager/v1/update/status")

    with subtest("watchdog: a hung manager is killed and restarted"):
        before = int(machine.succeed("systemctl show -P NRestarts whombat-manager").strip())
        pid = machine.succeed("systemctl show -P MainPID whombat-manager").strip()
        machine.succeed(f"kill -STOP {pid}")
        machine.wait_until_succeeds(f"test $(systemctl show -P NRestarts whombat-manager) -gt {before}", timeout=120)
        machine.wait_for_unit("whombat-manager.service")
        machine.succeed("journalctl -u whombat-manager --no-pager | grep -q 'Watchdog timeout'")

    with subtest("OnFailure: after the restart budget the recovery unit takes over"):
        for _ in range(8):
            if "failed" in machine.succeed("systemctl is-failed whombat-manager || true"):
                break
            machine.wait_until_succeeds("systemctl is-active whombat-manager || systemctl is-failed whombat-manager", timeout=60)
            machine.succeed("systemctl kill -s KILL whombat-manager || true")
            machine.sleep(1)
        machine.wait_until_succeeds("systemctl is-active whombat-manager-recovery.service", timeout=120)
        print(machine.succeed("journalctl -u whombat-manager-recovery --no-pager | tail -20"))
        machine.fail("systemctl is-active whombat-manager.service")
  '';
}
