# The app's restore on the real layout (BK-39, BK-40…): /persist is btrfs, every source a subvolume of its own.
#   - a restore that fails after the fresh install was set aside (a damaged pack in the backup) is undone: the box's
#     files, master key and database are back in their subvolumes, nothing is left set aside, the runtime runs again and
#     the status says the restore failed, with its reason and the person's words, never the technical detail
#   - the same restore with the pack intact: the checkpoint in place, the box in quarantine, nothing of root's in the
#     backup user's caches; after the person's answers the release keeps the restore's since, and what was set aside
#     (the folder and the database) is removed
#   - a power cut after the fresh install was set aside: at the next boot it is put back before the runtime starts
{
  applianceModules,
  pkgs,
  ...
}:
{
  name = "whombat-backup-app-restore";

  nodes = {
    control =
      { ... }:
      {
        imports = [ ./common/control.nix ];
      };
    machine =
      { lib, ... }:
      {
        imports = applianceModules ++ [ (import ./common/appliance-vm.nix { serial = "SN-BKR-0001"; }) ];
        virtualisation.memorySize = 2048;
        virtualisation.emptyDiskImages = lib.mkForce [
          {
            size = 4096;
            driveConfig.deviceExtraOpts.serial = "persist";
          }
          {
            size = 64;
            driveConfig.deviceExtraOpts.serial = "factory";
          }
          {
            size = 1024;
            driveConfig.deviceExtraOpts.serial = "bkdisk";
          }
        ];
        environment.systemPackages = [ pkgs.restic ];
      };
  };

  testScript = ''
    import json

    start_all()
    control.wait_for_unit("fake-control.service")
    control.wait_for_open_port(4600)

    station = json.dumps({"v": 1, "environment": "dev", "controlUrl": "http://control:4600", "tokenFile": "token",
                          "model": "whombat-one", "requireSecureBoot": False,
                          "factoryRelease": "rt-fixture-1", "seedHelper": False})
    machine.wait_for_unit("multi-user.target")
    machine.succeed(
        "mkfs.vfat /dev/disk/by-id/virtio-factory",
        f"echo '{station}' > /tmp/station.json && mcopy -i /dev/disk/by-id/virtio-factory /tmp/station.json ::/station.json",
        "echo dev-station-token-for-vm-tests-only > /tmp/token && mcopy -i /dev/disk/by-id/virtio-factory /tmp/token ::/token",
        "fatlabel /dev/disk/by-id/virtio-factory WBFACTORY",
    )
    machine.wait_until_succeeds("test -e /persist/identity/device.json", timeout=120)
    machine.wait_for_unit("whombat-server.service")
    machine.succeed("systemctl is-active whombat-backup-pgrole.service || systemctl start whombat-backup-pgrole.service")

    def api(method, path, body=None):
        data = f"-X {method} -H 'Content-Type: application/json' --data-binary @/tmp/body.json" if body is not None else ""
        if body is not None:
            machine.succeed(f"cat > /tmp/body.json <<'EOF'\n{json.dumps(body)}\nEOF\nchmod 0644 /tmp/body.json")
        out = machine.succeed(f"runuser -u whombat -- curl -s --max-time 180 --unix-socket /run/whombat-backup/api.sock {data} http://backup{path}")
        return json.loads(out)

    def psql(sql):
        return machine.succeed(f"runuser -u postgres -- psql -d whombat -tAc \"{sql}\"").strip()

    home = "/persist/whombat/home"
    sources = ["whombat/home", "whombat/workspaces", "whombat/credentials", "secrets"]
    repo = "/persist/backup/disk/whombat/repository"

    def as_before(marker):
        machine.succeed(f"grep -qx '{marker}' {home}/{marker}.txt")
        assert psql(f"select count(*) from {marker}") == "0"
        assert machine.succeed("cat /persist/secrets/master.key") == master_key
        for s in sources:
            machine.succeed(f"btrfs subvolume show /persist/{s} >/dev/null")
        machine.fail("ls -d /persist/whombat-set-aside-*")
        machine.fail("test -e /persist/backup/quarantine.json")

    with subtest("a backup on the backup disk"):
        res = api("PUT", "/v1/destination", {"repository": "disk:", "allowInit": True})
        assert res["kind"] == "disk", res
        machine.succeed("runuser -u whombat -- psql -d whombat -c \"create table in_backup (x text); insert into in_backup values ('kept')\"")
        machine.succeed("systemctl start whombat-backup.service")
        cps = api("GET", "/v1/checkpoints")["checkpoints"]
        assert len(cps) == 1, cps
        ck = cps[0]["id"]
        master_key = machine.succeed("cat /persist/secrets/master.key")
        # What the box has after its backup: a restore takes it away, an undo brings it back.
        machine.succeed(f"runuser -u whombat -- sh -c 'echo after_backup > {home}/after_backup.txt'",
                        "runuser -u whombat -- psql -d whombat -c 'create table after_backup (x text)'")

    with subtest("a restore that fails after the fresh install was set aside is undone"):
        machine.succeed(f"f=$(find {repo}/data -type f -printf '%s %p\\n' | sort -n | tail -1 | cut -d' ' -f2) && cp $f /root/pack && echo $f > /root/pack.path"
                        " && printf 'damaged' | dd of=$f bs=1 seek=64 conv=notrunc status=none")
        code, out = machine.execute(f"systemctl start whombat-backup-restore@{ck}.service")
        print(machine.succeed(f"journalctl -u whombat-backup-restore@{ck} --no-pager | tail -40"))
        assert code != 0, out
        machine.wait_for_unit("whombat-server.service")
        as_before("after_backup")
        st = api("GET", "/v1/quarantine")
        assert st["phase"] == "failed" and st["reason"] == "failed" and st["error"] and "detail" not in st, st
        result = json.loads(machine.succeed("cat /persist/backup/restore-result.json"))
        assert not result["ok"] and result["reason"] == "failed", result
        assert api("GET", "/v1/status")["running"] is None
        machine.succeed("cp /root/pack $(cat /root/pack.path)")

    with subtest("the same restore with the backup intact; what was set aside goes after the release"):
        machine.succeed(f"systemctl start whombat-backup-restore@{ck}.service")
        machine.wait_for_unit("whombat-server.service")
        marker = json.loads(machine.succeed("cat /persist/backup/quarantine.json"))
        assert marker["phase"] == "quarantined" and marker["restored"]["checkpointId"] == ck, marker
        assert psql("select x from in_backup") == "kept"
        machine.fail(f"test -e {home}/after_backup.txt")
        assert machine.succeed("cat /persist/secrets/master.key") == master_key
        for s in sources:
            machine.succeed(f"btrfs subvolume show /persist/{s} >/dev/null")
        machine.succeed("ls -d /persist/whombat-set-aside-*")
        assert psql("select count(*) from pg_database where datname like 'whombat_set_aside_%'") == "1"
        # The restore (root) left nothing of root's in the backup user's caches.
        machine.succeed("test -z \"$(find /persist/backup/cache /persist/backup/manifests -user root 2>/dev/null)\"")
        checking = api("GET", "/v1/quarantine")
        assert checking["phase"] == "checking" and checking["since"], checking
        for item, res in [("old-appliance", "decommissioned"), ("revocations", "none-after-checkpoint"), ("endpoints", "reviewed"),
                          ("provider-logins", "verified"), ("external-outcomes", "none"), ("identity-repin", "repinned")]:
            api("POST", "/v1/quarantine/resolve", {"item": item, "resolution": res})
        released = api("POST", "/v1/quarantine/release", {"oldWhombat": "gone", "checkpointId": ck})
        assert released["phase"] == "released" and released["since"] == checking["since"], (checking, released)
        machine.wait_until_fails("ls -d /persist/whombat-set-aside-*", timeout=60)
        assert psql("select count(*) from pg_database where datname like 'whombat_set_aside_%'") == "0"
        machine.fail("test -e /persist/backup/restore-cleanup.json")

    with subtest("a power cut after the fresh install was set aside: put back at the next boot"):
        machine.succeed(f"runuser -u whombat -- sh -c 'echo power_cut > {home}/power_cut.txt'",
                        "runuser -u whombat -- psql -d whombat -c 'create table power_cut (x text)'")
        master_key = machine.succeed("cat /persist/secrets/master.key")
        machine.succeed("systemctl stop whombat-runtime.target whombat-server.service whombat-runner.service")
        cfg = machine.succeed("systemctl cat whombat-backup | grep -o '/nix/store/[^ ]*whombat-backup.json' | head -1").strip()
        machine.succeed(f"cd / && whombat-backup -config {cfg} quarantine prepare -admin-dsn 'host=/run/postgresql dbname=postgres user=postgres'")
        machine.fail(f"test -e {home}/power_cut.txt")
        machine.crash()
        machine.start()
        machine.wait_for_unit("whombat-server.service")
        print(machine.succeed("journalctl -b -u whombat-backup-restore-recover --no-pager"))
        as_before("power_cut")
  '';
}
