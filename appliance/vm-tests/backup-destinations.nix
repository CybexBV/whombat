# Backup destinations through the real units (BK-18…BK-24), and the restore drill of UP-F2 on real boxes:
#   - SFTP: the box's key from the API (made on first use), the destination set through the API as the
#     runtime would (trust on first use: the fingerprint answered is the server's), a scheduled checkpoint
#     over port 22 (the backup user's egress rule), every secret sealed with systemd-creds afterwards
#   - the recovery kit from the API carries the SFTP user, key and host key
#   - the restore drill: a second, fresh appliance (its install made its own files, master key and
#     database) takes the first box's checkpoint with the documented commands run as root: destination
#     adopt with the kit, quarantine prepare, apply (sealed secrets unsealed for root; the btrfs subvolumes
#     filled in place; the database restored as the runtime's role through the root→postgres peer map),
#     resolve, release
#   - the agent's Hermes home (BK-36, NX-466): the person's (Hermes's default profile at the root) and the outsiders'
#     profile beside it (profiles/_feedback), each with what the agent remembers, a closed session and one a running
#     turn's Hermes still holds only in its write-ahead log, and the skills, written by the image's Hermes itself; the
#     checkpoint's atomic snapshot carries them, the fresh box's own home is set aside, and after the restore Hermes
#     lists both sessions of each (the second only because its log came along); the agent's home comes back too
#   - the backup disk: an empty virtual disk prepared on the owner's request (path unit, root helper),
#     mounted and seen by the already running API; the status says when it is gone and when it is back
{
  applianceModules,
  pkgs,
  lib,
  ...
}:
let
  # A person's session in their Hermes home, through Hermes's own storage interface: a closed one (`closed`), or one
  # whose store stays open (`hold`, the seconds), as a running turn's Hermes would, so its rows are only in the
  # write-ahead log while the backup runs. Hermes checkpoints the log itself only when a store closes and every 50
  # writes (SQLite at 1000 pages); this writes four. The test checks the rows are in the log alone before the backup.
  sessionWriter = pkgs.writeText "hermes-session.py" ''
    import sys, time
    from persistence_assembly import open_persistence, profile_scope
    from persistence.conversation.messages import NewMessage
    from persistence.conversation.sessions import NewSession
    sid, title, text, mode, ready = sys.argv[1:6]
    with open_persistence(profile_scope(), eager=True) as store:
        store.sessions.create(NewSession(session_id=sid, source="acp", model="claude"))
        store.sessions.set_title(sid, title)
        store.messages.append(sid, NewMessage.from_live({"role": "user", "content": text}))
        store.messages.append(sid, NewMessage.from_live({"role": "assistant", "content": "Done."}))
        open(ready, "w").write("written\n")
        if mode == "hold":
            time.sleep(float(sys.argv[6]))
  '';
  appliance =
    serial: extraDisks:
    { lib, ... }:
    {
      imports = applianceModules ++ [ (import ./common/appliance-vm.nix { inherit serial; }) ];
      # The image's Hermes and its home's subvolume, as on a box with the real runtime (the stand-in runs no turns); the
      # agent's home (NX-465), a backup source.
      whombat.hermes.enable = true;
      whombat.agent.enable = true;
      virtualisation.memorySize = 3072;
      virtualisation.emptyDiskImages = lib.mkForce (
        [
          {
            size = 8192;
            driveConfig.deviceExtraOpts.serial = "persist";
          }
          {
            size = 64;
            driveConfig.deviceExtraOpts.serial = "factory";
          }
        ]
        ++ extraDisks
      );
      environment.systemPackages = [ pkgs.restic ];
    };
in
{
  name = "whombat-backup-destinations";

  nodes = {
    control =
      { pkgs, ... }:
      {
        imports = [ ./common/control.nix ];
        # The owner's NAS: OpenSSH with a user for the backups.
        services.openssh = {
          enable = true;
          settings.PasswordAuthentication = false;
        };
        users.users.nas = {
          isNormalUser = true;
          createHome = true;
        };
        networking.firewall.allowedTCPPorts = [ 22 ];
      };
    machine = appliance "SN-BKD-0001" [
      {
        size = 2048;
        driveConfig.deviceExtraOpts.serial = "bkdisk";
      }
      {
        # A stick someone prepared elsewhere and labelled WHOMBAT-BACKUP (security review 2, finding 3).
        size = 64;
        driveConfig.deviceExtraOpts.serial = "evil";
      }
    ];
    fresh = appliance "SN-BKD-0002" [ ];
  };

  testScript =
    { nodes, ... }:
    let
      hermes = nodes.machine.whombat.hermes.package;
    in
    ''
    import json, re

    start_all()
    control.wait_for_unit("fake-control.service")
    control.wait_for_open_port(4600)
    control.wait_for_unit("sshd.service")

    def provision(m):
        station = json.dumps({"v": 1, "environment": "dev", "controlUrl": "http://control:4600", "tokenFile": "token",
                              "model": "whombat-one", "requireSecureBoot": False,
                              "factoryRelease": "rt-fixture-1", "seedHelper": False})
        m.wait_for_unit("multi-user.target")
        m.succeed(
            "mkfs.vfat /dev/disk/by-id/virtio-factory",
            f"echo '{station}' > /tmp/station.json && mcopy -i /dev/disk/by-id/virtio-factory /tmp/station.json ::/station.json",
            "echo dev-station-token-for-vm-tests-only > /tmp/token && mcopy -i /dev/disk/by-id/virtio-factory /tmp/token ::/token",
            "fatlabel /dev/disk/by-id/virtio-factory WBFACTORY",
        )
        m.wait_until_succeeds("test -e /persist/identity/device.json", timeout=120)
        m.wait_for_unit("whombat-server.service")
        m.succeed("systemctl is-active whombat-backup-pgrole.service || systemctl start whombat-backup-pgrole.service")

    def api(m, method, path, body=None):
        # As the runtime's user, the only caller of these endpoints besides the manager.
        data = f"-X {method} -H 'Content-Type: application/json' --data-binary @/tmp/body.json" if body is not None else ""
        if body is not None:
            m.succeed(f"cat > /tmp/body.json <<'EOF'\n{json.dumps(body)}\nEOF\nchmod 0644 /tmp/body.json")
        out = m.succeed(f"runuser -u whombat -- curl -s --max-time 180 --unix-socket /run/whombat-backup/api.sock {data} http://backup{path}")
        return json.loads(out)

    def cli(m, args):
        cfg = m.succeed("systemctl cat whombat-backup | grep -o '/nix/store/[^ ]*whombat-backup.json' | head -1").strip()
        return m.succeed(f"cd / && whombat-backup -config {cfg} {args} 2>&1")

    provision(machine)
    provision(fresh)

    # The Hermes home (BK-36, NX-466): written as the runner, with the image's Hermes and its session store. The
    # person's is Hermes's default profile, the root itself; the outsiders' is the named profile `_feedback`.
    hermes_root = "/persist/whombat/hermes"
    homes = {"mara": ("Mara deploys on Fridays", "Mara"), "_feedback": ("Reports come from the website", "")}
    hermes_python = "${hermes.passthru.venv}/bin/python3"
    agent_home = "/persist/whombat/agent/home"

    def home_of(acct):
        return hermes_root if acct == "mara" else f"{hermes_root}/profiles/{acct}"

    def as_runner(acct, cmd):
        return (f"runuser -u whombat-runner -- env HOME=/tmp/hermes-test-home HERMES_HOME={home_of(acct)} "
                f"HERMES_PYTHON={hermes_python} {cmd}")

    def sessions_in_db_alone(m, acct):
        # The main database file alone, without its write-ahead log: what a copy that left the log behind would hold.
        m.succeed(f"cp {home_of(acct)}/state.db /tmp/{acct}-alone.db")
        out = m.succeed(f"{hermes_python} -c \"import sqlite3; c = sqlite3.connect('file:/tmp/{acct}-alone.db?immutable=1', uri=True); "
                        "print(' '.join(r[0] for r in c.execute('select id from sessions order by id')))\"")
        return out.split()

    with subtest("the Hermes home: the person's and the outsiders' memory and sessions, one only in a write-ahead log"):
        machine.succeed(f"btrfs subvolume show {hermes_root} >/dev/null")
        machine.succeed(f"stat -c '%a %U' {hermes_root} | grep -qx '700 whombat-runner'")
        machine.succeed("install -d -o whombat-runner -g whombat-runner -m 0700 /tmp/hermes-test-home")
        for acct, (mem, user) in homes.items():
            home = home_of(acct)
            machine.succeed(f"install -d -o whombat-runner -g whombat-runner -m 0700 {hermes_root}/profiles {home} {home}/memories",
                            f"runuser -u whombat-runner -- sh -c 'printf \"%s\" \"{mem}\" > {home}/memories/MEMORY.md && printf \"%s\" \"{user}\" > {home}/memories/USER.md'")
            machine.succeed(as_runner(acct, f"{hermes_python} ${sessionWriter} s-{acct}-1 'Deploy the site' 'Deploy the site' closed /tmp/{acct}-1"))
            # A running turn's Hermes: its second session is still only in the write-ahead log while the backup runs.
            machine.succeed("setsid " + as_runner(acct, f"{hermes_python} ${sessionWriter} s-{acct}-2 'Check the lights' 'Is the light on?' hold /tmp/{acct}-2 900")
                            + " >/dev/null 2>&1 &")
            machine.wait_until_succeeds(f"test -s /tmp/{acct}-2", timeout=60)
            machine.succeed(f"test -s {home}/state.db-wal")
            assert sessions_in_db_alone(machine, acct) == [f"s-{acct}-1"], acct
            # Hermes's own logs (left out) and a gateway's socket a turn left behind.
            machine.succeed(f"runuser -u whombat-runner -- sh -c 'mkdir -p {home}/logs && echo turn > {home}/logs/agent.log'",
                            f"runuser -u whombat-runner -- {hermes_python} -c \"import socket; socket.socket(socket.AF_UNIX).bind('{home}/gateway.sock')\"")
        # A skill the agent learned and a built-in one, both in the home's skills/; the runner's lock holders.
        machine.succeed(f"runuser -u whombat-runner -- sh -c 'mkdir -p {hermes_root}/skills/mine/lights {hermes_root}/skills/ops/deploy {hermes_root}/locks"
                        f" && echo learned > {hermes_root}/skills/mine/lights/SKILL.md && echo builtin > {hermes_root}/skills/ops/deploy/SKILL.md"
                        f" && echo held > {hermes_root}/locks/hermes-profile.lock'")
        # The agent's home (NX-465): a project of its own and its cache (left out).
        machine.succeed(f"btrfs subvolume show {agent_home} >/dev/null",
                        f"runuser -u whombat-runner -- sh -c 'mkdir -p {agent_home}/site {agent_home}/.cache/pip && echo page > {agent_home}/site/index.html"
                        f" && echo cached > {agent_home}/.cache/pip/x'")

    with subtest("security review 2: what the backup user plants never makes root act on other files"):
        found = []
        machine.succeed("echo ROOT-ONLY-MARKER > /root/marker && chmod 0600 /root/marker",
                        "echo ROOT-OWNED > /root/victim && chmod 0640 /root/victim")
        # 1. the seal unit: a plain secret that is a symlink to a root-only file, a .cred that is a symlink
        as_backup = "runuser -u whombat-backup -- "
        machine.succeed(as_backup + "ln -sfn /root/marker /persist/backup/secrets/rest-password")
        machine.succeed(as_backup + "sh -c 'rm -f /persist/backup/secrets/s3-secret-access-key.cred; ln -s /root/victim /persist/backup/secrets/s3-secret-access-key.cred'")
        machine.execute("systemctl start whombat-backup-seal.service")
        machine.execute("systemctl restart whombat-backup-api.service")
        if machine.succeed("cat /root/marker").strip() != "ROOT-ONLY-MARKER":
            found.append("seal destroyed the target of a planted symlink (shred)")
        code, leaked = machine.execute("cat /run/credentials/whombat-backup-api.service/rest-password")
        if "ROOT-ONLY-MARKER" in leaked:
            found.append("seal sealed a root-only file into a credential the backup user reads")
        if machine.succeed("stat -c '%U %a' /root/victim").strip() != "root 640":
            found.append("seal chowned/chmodded the target of a planted .cred symlink: " + machine.succeed("stat -c '%U %a' /root/victim"))
        machine.succeed("rm -f /persist/backup/secrets/rest-password /persist/backup/secrets/s3-secret-access-key.cred")
        # 2. root CLI runs: a planted run.lock symlink, a symlinked secrets/ directory
        machine.succeed(as_backup + "ln -sfn /root/planted-lock /persist/backup/run.lock")
        cfg = machine.succeed("systemctl cat whombat-backup | grep -o '/nix/store/[^ ]*whombat-backup.json' | head -1").strip()
        machine.execute(f"cd / && whombat-backup -config {cfg} run -reason manual")
        machine.execute(f"cd / && whombat-backup -config {cfg} quarantine prepare -admin-dsn 'host=/run/postgresql dbname=postgres user=postgres'")
        if machine.execute("test -e /root/planted-lock")[0] == 0:
            found.append("a root CLI run created a file through a planted run.lock symlink")
        machine.succeed("rm -f /persist/backup/run.lock /root/planted-lock")
        machine.succeed("mkdir -p /root/planted-dir && chmod 0700 /root/planted-dir",
                        as_backup + "sh -c 'mv /persist/backup/secrets /persist/backup/secrets.real; ln -s /root/planted-dir /persist/backup/secrets'")
        machine.execute(f"cd / && whombat-backup -config {cfg} ssh-public-key")  # makes the box's key on first use
        if machine.succeed("ls -A /root/planted-dir").strip():
            found.append("a root CLI run wrote through a symlinked secrets directory")
        machine.succeed("rm /persist/backup/secrets && mv /persist/backup/secrets.real /persist/backup/secrets")
        # 3. a disk labelled WHOMBAT-BACKUP whose whombat folder is a symlink to /persist/identity
        before = machine.succeed("stat -c '%U %a' /persist/identity").strip()
        machine.succeed(
            "mkfs.ext4 -q -L WHOMBAT-BACKUP /dev/disk/by-id/virtio-evil",
            "mkdir -p /mnt/evil && mount /dev/disk/by-id/virtio-evil /mnt/evil && ln -s /persist/identity /mnt/evil/whombat && umount /mnt/evil",
            "udevadm trigger --action=change /dev/disk/by-id/virtio-evil && udevadm settle",
        )
        machine.sleep(5)
        if machine.succeed("stat -c '%U %a' /persist/identity").strip() != before:
            found.append("a stick labelled WHOMBAT-BACKUP handed /persist/identity to the backup user: " + machine.succeed("stat -c '%U %a' /persist/identity"))
        if machine.execute("findmnt /persist/backup/disk")[0] == 0:
            found.append("a disk labelled WHOMBAT-BACKUP was mounted before any backup disk was configured")
            machine.execute("umount /persist/backup/disk")
        machine.succeed("chown root:root /persist/identity && chmod 0711 /persist/identity")
        print("\n".join(found) or "no finding reproduced")
        assert not found, found

    with subtest("SFTP: the box's key, the destination set through the API, a checkpoint over port 22"):
        key = api(machine, "GET", "/v1/ssh-public-key")
        assert key["publicKey"].startswith("ssh-ed25519 ") and key["fingerprint"].startswith("SHA256:"), key
        assert api(machine, "GET", "/v1/ssh-public-key") == key
        control.succeed(
            "install -d -m 0700 -o nas -g users /home/nas/.ssh /home/nas/backups",
            f"echo '{key['publicKey']}' > /home/nas/.ssh/authorized_keys",
            "chown nas:users /home/nas/.ssh/authorized_keys && chmod 0600 /home/nas/.ssh/authorized_keys",
        )
        server_fp = control.succeed("ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub | cut -d' ' -f2").strip()
        res = api(machine, "PUT", "/v1/destination", {"repository": "sftp:control:/home/nas/backups/box", "sftpUser": "nas", "allowInit": True})
        print(res)
        assert res["kind"] == "sftp" and res["hostKeyFingerprint"] == server_fp and res["appendOnly"] == "not-enforced", res
        # Nothing but the pinned key: known_hosts holds the one line.
        machine.succeed("grep -c . /persist/backup/known_hosts | grep -qx 1")
        machine.succeed("runuser -u whombat -- psql -d whombat -c \"create table drill_marker (x text); insert into drill_marker values ('before the migration')\"")
        machine.succeed("systemctl start whombat-backup.service")
        print(machine.succeed("journalctl -u whombat-backup --no-pager | tail -20"))
        status = api(machine, "GET", "/v1/status")
        assert status["state"] == "protected" and status["destination"]["kind"] == "sftp", status
        assert status["destination"]["display"] == "nas@control:/home/nas/backups/box", status
        control.succeed("test -e /home/nas/backups/box/config")
        # The running turns end after the checkpoint.
        machine.succeed("pkill -f hermes-session.py")

    with subtest("every destination secret is sealed into the root-only directory; no plain copy is left"):
        machine.succeed("stat -c '%a %U' /persist/backup-root | grep -qx '700 root'")
        for f in ["repository-password", "ssh-key", "rest-password", "s3-secret-access-key"]:
            machine.succeed(f"test ! -e /persist/backup/secrets/{f} && test ! -e /persist/backup/secrets/{f}.cred")
            machine.succeed(f"test -s /persist/backup-root/{f}.cred")
            machine.succeed(f"stat -c '%a %U' /persist/backup-root/{f}.cred | grep -qx '600 root'")
        # The sealed key still works: the API (restarted with the credentials) answers the same key.
        machine.wait_until_succeeds("runuser -u whombat -- curl -sf --unix-socket /run/whombat-backup/api.sock http://backup/v1/status")
        assert api(machine, "GET", "/v1/ssh-public-key") == key

    with subtest("the recovery kit carries what reaching the NAS takes"):
        material = api(machine, "GET", "/v1/recovery-material")
        assert material["sftpUser"] == "nas" and "OPENSSH PRIVATE KEY" in material["sftpPrivateKey"], material.keys()
        assert material["sftpHostKey"].startswith("ssh-ed25519 "), material["sftpHostKey"]
        kit = json.dumps(material)

    with subtest("restore drill (UP-F2): the checkpoint onto a fresh box with the documented commands"):
        machine.succeed("runuser -u whombat -- psql -d whombat -c 'alter table drill_marker rename to broken_by_migration'")
        fresh.succeed(f"cat > /root/kit.json <<'EOF'\n{kit}\nEOF\nchmod 0600 /root/kit.json")
        fresh.succeed("systemctl stop whombat-runtime.target whombat-server.service whombat-runner.service")
        print(cli(fresh, "destination adopt -kit /root/kit.json"))
        # The kit's secrets are sealed before the restore: root unseals them for the run.
        fresh.succeed("systemctl start whombat-backup-seal.service")
        fresh.succeed("test ! -e /persist/backup/secrets/repository-password && test ! -e /persist/backup/secrets/ssh-key")
        # The fresh box's own Hermes root, as its runner left it at its first start: set aside by prepare.
        fresh.succeed(f"runuser -u whombat-runner -- sh -c 'mkdir -p {hermes_root}/profiles/_unused {hermes_root}/skills/ops/release"
                      f" && echo release > {hermes_root}/skills/ops/release/SKILL.md'")
        print(cli(fresh, "quarantine prepare -admin-dsn 'host=/run/postgresql dbname=postgres user=postgres'"))
        fresh.succeed("ls -d /persist/whombat-set-aside-*/hermes/skills/ops/release")
        out = cli(fresh, "quarantine apply -dsn 'host=/run/postgresql dbname=whombat user=postgres'"
                         " -admin-dsn 'host=/run/postgresql dbname=postgres user=postgres' -check-data 10%")
        print(out)
        marker = json.loads(fresh.succeed("cat /persist/backup/quarantine.json"))
        assert marker["phase"] == "quarantined", marker
        assert fresh.succeed("runuser -u postgres -- psql -d whombat -tAc 'select x from drill_marker'").strip() == "before the migration"
        assert fresh.succeed("runuser -u postgres -- psql -d whombat -tAc \"select tableowner from pg_tables where tablename = 'drill_marker'\"").strip() == "whombat"
        # The sources are still their own subvolumes, filled in place; the fresh install is kept aside.
        for s in ["whombat/home", "whombat/workspaces", "whombat/credentials", "whombat/hermes", "whombat/agent/home", "secrets"]:
            fresh.succeed(f"btrfs subvolume show /persist/{s} >/dev/null")
        fresh.succeed("ls -d /persist/whombat-set-aside-*/secrets")
        fresh.fail("ls -d /persist/.whombat-restore-*")
        assert machine.succeed("cat /persist/secrets/master.key") == fresh.succeed("cat /persist/secrets/master.key")
        fresh.succeed("runuser -u whombat -- test -r /persist/whombat/home")
        # The Hermes home is back: memory, both sessions of the person and of the outsiders' profile (the second came
        # in its write-ahead log), the skills; the runner's lock holders and Hermes's logs stayed behind (BK-36, NX-466).
        assert marker["hermes"] == "restored", marker
        assert re.search(r" hermes +ok +the Hermes home with \d+ SQLite stores as recorded, 2 skills", out), out
        fresh.succeed(f"stat -c '%a %U' {hermes_root} | grep -qx '700 whombat-runner'")
        fresh.fail(f"ls -d {hermes_root}/skills/ops/release {hermes_root}/profiles/_unused {hermes_root}/locks")
        fresh.succeed(f"grep -qx builtin {hermes_root}/skills/ops/deploy/SKILL.md",
                      f"grep -qx learned {hermes_root}/skills/mine/lights/SKILL.md")
        # The agent's home is back without its cache.
        fresh.succeed(f"grep -qx page {agent_home}/site/index.html")
        fresh.fail(f"test -e {agent_home}/.cache/pip/x")
        fresh.succeed("install -d -o whombat-runner -g whombat-runner -m 0700 /tmp/hermes-test-home")
        for acct, (mem, user) in homes.items():
            home = home_of(acct)
            assert fresh.succeed(f"cat {home}/memories/MEMORY.md") == mem, acct
            assert fresh.succeed(f"cat {home}/memories/USER.md") == user, acct
            fresh.succeed(f"test -z \"$(find {home} ! -user whombat-runner)\"")
            fresh.fail(f"test -e {home}/logs/agent.log")
            fresh.succeed(f"test -s {home}/state.db-wal")
            assert sessions_in_db_alone(fresh, acct) == [f"s-{acct}-1"], acct
            listed = fresh.succeed(as_runner(acct, "${hermes}/bin/hermes sessions list"))
            print(listed)
            for sid in [f"s-{acct}-1", f"s-{acct}-2"]:
                assert sid in listed, (acct, sid, listed)
        # State files the root run wrote stay the backup user's.
        fresh.succeed("stat -c %U /persist/backup/destination.json | grep -qx whombat-backup")
        for f in ["destination.json", "status.json", "run.lock", "keys/adopted-manifest.pub", "quarantine.json"]:
            fresh.succeed(f"stat -c %U /persist/backup/{f} | grep -qx whombat-backup")
        for item, res in [("old-appliance", "decommissioned"), ("revocations", "none-after-checkpoint"), ("endpoints", "reviewed"),
                          ("provider-logins", "verified"), ("external-outcomes", "none"), ("identity-repin", "repinned")]:
            cli(fresh, f"quarantine resolve {item} {res}")
        print(cli(fresh, "quarantine release -admin-dsn 'host=/run/postgresql dbname=postgres user=postgres'"))
        fresh.succeed("systemctl start whombat-runtime.target")
        fresh.wait_for_unit("whombat-server.service")
        fresh.succeed("runuser -u whombat -- psql -d whombat -c \"insert into drill_marker values ('after the restore')\"")

    with subtest("the backup disk: an empty disk prepared on request, seen by the running API"):
        api_pid = machine.succeed("systemctl show -P MainPID whombat-backup-api.service").strip()
        assert api_pid != "0"
        res = api(machine, "PUT", "/v1/destination", {"repository": "disk:", "allowInit": True})
        print(res, machine.succeed("journalctl -u whombat-backup-disk-init --no-pager | tail -20"))
        assert res["kind"] == "disk", res
        machine.succeed("findmnt -n -o FSTYPE,LABEL /persist/backup/disk | grep -qx 'ext4 *WHOMBAT-BACKUP'")
        machine.succeed("findmnt -n -o OPTIONS /persist/backup/disk | tr , '\\n' | grep -qx nosymfollow")
        pinned = machine.succeed("cat /persist/backup-root/disk-uuid").strip()
        assert machine.succeed("findmnt -n -o UUID /persist/backup/disk").strip() == pinned, pinned
        # The stick labelled WHOMBAT-BACKUP stays unmounted: only the pinned disk is ever mounted.
        machine.succeed("udevadm trigger --action=change /dev/disk/by-id/virtio-evil && udevadm settle")
        machine.succeed("systemctl start whombat-backup-disk-attach.service")
        assert machine.succeed("findmnt -n -o UUID /persist/backup/disk").strip() == pinned
        assert machine.succeed("systemctl show -P MainPID whombat-backup-api.service").strip() == api_pid
        machine.succeed(f"nsenter -t {api_pid} -m -- findmnt /persist/backup/disk")
        machine.succeed("stat -c %U /persist/backup/disk/whombat | grep -qx whombat-backup")
        machine.succeed("systemctl start whombat-backup.service")
        status = api(machine, "GET", "/v1/status")
        assert status["state"] == "protected" and status["destination"]["display"] == "Local disk WHOMBAT-BACKUP", status
        machine.succeed("systemctl stop persist-backup-disk.mount")
        status = api(machine, "GET", "/v1/status")
        assert status["state"] == "failing" and "isn't attached" in status["lastFailure"]["reason"], status
        machine.succeed("systemctl start whombat-backup-disk-attach.service")
        status = api(machine, "GET", "/v1/status")
        assert status["state"] == "protected", status

    with subtest("security review 2: the backup disk's folder swapped for a symlink is never followed"):
        machine.succeed("runuser -u whombat-backup -- sh -c 'mv /persist/backup/disk/whombat /persist/backup/disk/w2 && ln -s /persist/identity /persist/backup/disk/whombat'")
        machine.fail("stat -L /persist/backup/disk/whombat")  # nosymfollow
        machine.succeed("systemctl stop persist-backup-disk.mount")
        machine.execute("systemctl start whombat-backup-disk-attach.service")
        print(machine.succeed("journalctl -u whombat-backup-disk-attach --no-pager | tail -5"))
        machine.succeed("stat -c '%U %a' /persist/identity | grep -qx 'root 711'")
  '';
}
