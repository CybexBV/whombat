# Backup service (W3-BK: docs/decisions/backup.md, docs/runbooks/backup.md; NX-28). The single Nix source for
# the backup units (folded from the backup workstream's former backup/nix/whombat-backup.nix, with the fixes
# found in the VM tests applied). The backup workstream changes it through the cross-owner procedure.
#
#   whombat-backup             user/group 954 — reads staged snapshots only
#   whombat-backup-snapd       root, socket-activated, typed take/release of the checkpoint's source snapshots
#   whombat-backup-api         socket-activated local API (/run/whombat-backup/api.sock) for runtime + manager
#   whombat-backup-seal        root oneshot: seals the destination's secrets with systemd-creds into the root-only
#                              <persist>/backup-root, reading them as the backup user (BK-15, BK-18, BK-26)
#   whombat-backup.timer       every 15 minutes asks `run -if-due`: the person's policy decides (every night, 6 hours or
#                              hour; a failure retries after 15 minutes; BK-37, Whombat backup-options.md)
#   whombat-backup-drill.timer hourly `drill -if-due`: the weekly restore check when it is on, in the person's early
#                              morning in their time zone (policy.json), and a check the person asked for
#                              (drill-request.json, also started by its path unit)
#   whombat-backup-restore@ID  root oneshot behind the manager: brings this box back from checkpoint ID (BK-39)
#   whombat-backup-restore-recover  root oneshot before the runtime starts and after a release: undoes a restore a
#                              crash or a power cut stopped, removes what a released one set aside
#   <persist>/backup/disk      the backup disk, mounted (nosymfollow) only once pinned by UUID (BK-20, BK-27)
#   whombat-backup-disk-init   root oneshot behind a path unit: pins and mounts the owner's disk (formats the one
#                              empty disk when allowed); whombat-backup-disk-attach mounts the pinned one
#   PostgreSQL role whombat_backup (pg_read_all_data, BYPASSRLS, CREATEDB for a peek's database; peer auth over the
#                              unix socket)
#   peeks                      a backup opened for reading (POST /v1/peeks): its database whombat_peek_* the runtime's
#                              role may read, its files in <persist>/backup/peek (group whombat-peek, the server is a
#                              member); closed after 2 hours, and at boot by whombat-backup-peek-sweep (NX-505)
#   hosts                      where the hosts service runs: its own backup, made as its user before each checkpoint
#                              (hosts.nix' socket), is the source `hosts`; the hub's live data stays hidden (BK-31,
#                              NX-408)
#
# /persist is btrfs with home, workspaces, credentials, hermes and secrets as subvolumes (NX-07, NX-431), so the driver is
# "btrfs": writes pause for milliseconds. "copy" remains for other layouts (writes and new turns stay paused
# for the whole copy). The runtime accepts drain/resume/health on /run/whombat/admin.sock from this uid
# (group whombat-admin, socket 0660; BK-05, CT-23).
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.whombat.backup;
  p = config.whombat.persistDir;
  hosts = config.whombat.hosts;
  pg = config.services.postgresql.package;
  secrets = "${p}/backup/secrets"; # the backup user's: values it wrote since the last seal
  # Root only (BK-26): the sealed credentials and the pinned disk. Not under /persist/backup, where the backup
  # user could rename it away and plant its own.
  sealedDir = "${p}/backup-root";
  setpriv = "${pkgs.util-linux}/bin/setpriv --reuid=${toString cfg.uid} --regid=${toString config.users.groups.whombat-backup.gid} --clear-groups --no-new-privs --";
  # The destination's secrets (BK-15, BK-18): file under secrets/ → credential name in the units.
  sealed = {
    repository-password = "restic-password";
    rest-password = "rest-password";
    s3-secret-access-key = "s3-secret";
    ssh-key = "ssh-key";
  };
  credentials = lib.mapAttrsToList (file: name: "${name}:${sealedDir}/${file}.cred") sealed;
  diskMount = "${p}/backup/disk";
  # The root disk helpers (BK-20, BK-27): only what they need — /dev, the pin, the mount point and the
  # request directory; systemd-mount talks to PID 1 over its socket.
  diskHelper = description: command: {
    inherit description;
    requires = [ "whombat-persist.target" ];
    after = [
      "whombat-persist.target"
      "systemd-udevd.service"
    ];
    unitConfig.ConditionPathExists = "${p}/identity/device.json";
    serviceConfig = {
      Type = "oneshot";
      ExecStart = "${cfg.package}/bin/whombat-backup -config ${configFile} ${command}";
      NoNewPrivileges = true;
      ProtectSystem = "strict";
      ProtectHome = true;
      PrivateTmp = true;
      PrivateNetwork = true;
      # /persist/backup, not the mount point itself: a writable path is bind-mounted onto itself in the
      # unit's namespace, and a bind at the mount point would look like a mounted disk.
      ReadWritePaths = [
        "${p}/backup"
        sealedDir
      ];
      # Only device.json of the identity (the configuration names the appliance by it).
      TemporaryFileSystem = [ "${p}/identity:ro" ];
      BindReadOnlyPaths = [ "-${p}/identity/device.json" ];
      InaccessiblePaths = [
        "-${p}/whombat"
        "-${p}/secrets"
        "-${secrets}"
      ];
    };
  };
  configFile = pkgs.writeText "whombat-backup.json" (
    builtins.toJSON (
      {
        applianceIdFile = cfg.applianceIdFile; # provisioning's device.json {deviceId}
        persist = p;
        stateDir = "${p}/backup";
        runtimeSocket = "/run/whombat/admin.sock";
        snapSocket = "/run/whombat-backup/snapd.sock";
        driver = cfg.driver;
        apiSocket = "/run/whombat-backup/api.sock";
        pgDsn = "host=/run/postgresql dbname=whombat user=whombat_backup";
        pgBin = "${pg}/bin";
        restic = "${pkgs.restic}/bin/restic";
        git = "${pkgs.git}/bin/git";
        ssh = "${pkgs.openssh}/bin/ssh"; # SFTP destinations; ssh-keyscan next to it (BK-19)
        inherit diskMount sealedDir;
        diskRequireMount = true;
        diskHelper = true;
        systemdMount = "${config.systemd.package}/bin/systemd-mount";
        blkid = "${pkgs.util-linux}/bin/blkid";
        mkfsExt4 = "${pkgs.e2fsprogs}/bin/mkfs.ext4";
        udevadm = "${config.systemd.package}/bin/udevadm";
        systemdCreds = "${config.systemd.package}/bin/systemd-creds";
        quiesceTimeoutMs = cfg.quiesceTimeoutSec * 1000;
        leaseMs = 30000;
        reserveBytes = 2147483648;
        # /persist is solid state: four files read at once instead of restic's two (NX-504).
        readConcurrency = 4;
        staleAfterMs = cfg.staleAfterHours * 3600 * 1000;
        runtimeUid = config.whombat.ids.whombat;
        managerUid = config.whombat.ids.whombat-manager;
        backupUid = cfg.uid;
        snapDatasets = cfg.zfsDatasets;
        # A backup opened for reading (NX-505): the runtime's role reads its database, its group its files.
        peek = {
          runtimeRole = "whombat";
          gid = config.users.groups.whombat-peek.gid;
        };
      }
      # The hosts service's backup as the source `hosts` (BK-31, BK-32, NX-408); its user owns what a restore stages.
      // lib.optionalAttrs hosts.enable {
        hosts = {
          backupSocket = hosts.backupSocket;
          uid = config.users.users.whombat-hosts.uid;
          gid = config.users.groups.whombat-hosts.gid;
        };
      }
    )
  );
  common = {
    NoNewPrivileges = true;
    ProtectSystem = "strict";
    ProtectHome = true;
    PrivateTmp = true;
    PrivateDevices = true;
    ProtectKernelTunables = true;
    ProtectKernelModules = true;
    ProtectControlGroups = true;
    RestrictSUIDSGID = true;
    LockPersonality = true;
    SystemCallArchitectures = "native";
    UMask = "0077";
  };
  confined = [
    "${p}/whombat"
    "${p}/secrets"
    "${p}/manager"
    "${p}/postgres"
  ]
  # The hub's live data and its backup: the checkpoint reads the staged snapshot only (NX-408).
  ++ lib.optionals hosts.enable [
    "-${hosts.dataDir}"
    "-${hosts.backupDir}"
  ];
  # The checkpoint asks the hosts service for its backup before each snapshot (BK-32).
  hostsSocket = lib.optionals hosts.enable [ "whombat-hosts-backup.socket" ];
  # Least privilege for every backup unit (MA-21f, W4-SEC part 2 M-5). CAP_DAC_READ_SEARCH (checkpoint job,
  # API, snapd) reads across owners, so what it may not read is hidden from the namespace:
  #   - /persist/identity: only the public files the manifest references (device.json, management.pub,
  #     content.peerid) are bound in; the management and content keys and the claim secret are not there.
  #   - /var/lib: the per-device Secure Boot keys (sbctl), the disk-policy key (whombat-storage), the update
  #     helper's state and systemd's credential host key. No backup unit uses /var/lib.
  #   - other units' credentials (the runtime's master key, runner token, content key, claim secret).
  leastPrivilege = {
    TemporaryFileSystem = [
      "${p}/identity:ro"
      "/var/lib:ro"
    ];
    BindReadOnlyPaths = [
      "-${p}/identity/device.json"
      "-${p}/identity/management.pub"
      "-${p}/identity/content.peerid"
    ];
    InaccessiblePaths = [
      "-/run/credentials/whombat-server.service"
      "-/run/credentials/whombat-runner.service"
      "-/boot"
      "-${sealedDir}"
    ];
  };
in
{
  options.whombat.backup = {
    enable = lib.mkEnableOption "the appliance backup service" // {
      default = true;
    };
    package = lib.mkOption {
      type = lib.types.package;
      default = pkgs.whombat-backup;
      defaultText = lib.literalExpression "pkgs.whombat-backup";
      description = "whombat-backup + whombat-backup-snapd (root Go module, backup/cmd).";
    };
    uid = lib.mkOption {
      type = lib.types.int;
      default = config.whombat.ids.whombat-backup;
      defaultText = lib.literalExpression "config.whombat.ids.whombat-backup";
    };
    driver = lib.mkOption {
      type = lib.types.enum [
        "btrfs"
        "zfs"
        "copy"
      ];
      default = "btrfs";
    };
    zfsDatasets = lib.mkOption {
      type = lib.types.attrsOf lib.types.str;
      default = { };
    };
    # How often the timers ask; the person's policy (policy.json) decides when a backup or check is due.
    schedule = lib.mkOption {
      type = lib.types.str;
      default = "*:0/15";
    };
    # Hourly: the policy says when, in the person's time zone (their early morning, NX-503).
    drillSchedule = lib.mkOption {
      type = lib.types.str;
      default = "*-*-* *:20:00";
    };
    drillCheckData = lib.mkOption {
      type = lib.types.str;
      default = "5%";
    };
    quiesceTimeoutSec = lib.mkOption {
      type = lib.types.int;
      default = 120;
    };
    staleAfterHours = lib.mkOption {
      type = lib.types.int;
      default = 36;
    };
    applianceIdFile = lib.mkOption {
      type = lib.types.str;
      default = "${p}/identity/device.json";
    };
  };

  config = lib.mkIf cfg.enable {
    users.users.whombat-backup = {
      isSystemUser = true;
      inherit (cfg) uid;
      group = "whombat-backup";
      extraGroups = [
        "whombat-admin"
        "whombat-peek"
      ];
      home = "/var/empty";
      shell = "/run/current-system/sw/bin/nologin";
    };
    users.groups.whombat-backup.gid = cfg.uid;
    # A backup opened for reading is this group's to read (NX-505): the backup service makes its files the group's,
    # the server (the runtime's user) is a member; the runner isn't.
    users.groups.whombat-peek.gid = config.whombat.ids.whombat-peek;
    users.users.whombat.extraGroups = [ "whombat-peek" ];
    # Runtime and manager may call the backup API.
    users.groups.whombat-backup-clients = {
      gid = config.whombat.ids.whombat-backup + 4; # 958
      members = [
        "whombat"
        "whombat-manager"
      ];
    };

    # The CLI (status, destination set/adopt, kit-material, drills) for the recovery path and operators.
    environment.systemPackages = [ cfg.package ];

    # /persist/backup is root:whombat-backup 0771: the backup group writes (status.json, secrets/, keys/, …),
    # others only traverse to the 0644 status.json. Root must own it: systemd-tmpfiles refuses a root-owned
    # staging/ under a user-owned parent ("unsafe path transition", NX-28).
    systemd.tmpfiles.settings."20-whombat-backup" =
      let
        d = mode: user: group: {
          d = {
            inherit mode user group;
          };
        };
        own = d "0700" "whombat-backup" "whombat-backup";
      in
      {
        "${p}/backup" = d "0771" "root" "whombat-backup";
        "${p}/backup/secrets" = own;
        "${p}/backup/keys" = own;
        "${p}/backup/cache" = own;
        "${p}/backup/drill" = own;
        # A backup opened for reading (NX-505): setgid, so what is restored in it is the group's from the start.
        "${p}/backup/peek" = d "2750" "whombat-backup" "whombat-peek";
        "${p}/backup/staging" = d "0750" "root" "whombat-backup";
        "${p}/backup/staging/current" = d "0770" "root" "whombat-backup";
        # The mount point of the backup disk: root's, so nothing is written to /persist when no disk is
        # mounted; the folder on the disk is the backup user's (made by the root helper, BK-27).
        "${diskMount}" = d "0755" "root" "root";
        "${p}/backup/disk-init" = own;
        "${sealedDir}" = d "0700" "root" "root";
      };

    # Backup destinations are the owner's servers on any port (REST 8000, SFTP 22, S3 9000, …), on the
    # internet or the home network: sockets of the backup group may open TCP connections to any port (BK-22).
    # That is the backup user's processes (its primary group) and a root restore at the console, which takes
    # the group (whombat-backup as root, BK-24); nothing else runs with it. It holds a copy of all data
    # anyway; the other uids keep the allowlist.
    whombat.network.extraOutputRules = ''
      meta skgid ${toString config.users.groups.whombat-backup.gid} meta l4proto tcp accept comment "backup destinations (BK-22)"
    '';

    # The backup disk (BK-20, BK-27): an ext4 or btrfs filesystem labelled WHOMBAT-BACKUP. A disk is mounted
    # only after the owner configured it (whombat-backup-disk-init pins its filesystem UUID in the root-only
    # directory), and afterwards only that one: whenever a labelled filesystem appears (at boot or later)
    # whombat-backup-disk-attach mounts the pinned disk, if it is attached, by UUID, with systemd-mount (a
    # transient mount unit bound to the device: unmounted when it goes), nodev,nosuid,noexec,noatime and
    # nosymfollow (nothing on it is executed, a device, or followed as a symlink), and makes its folder for
    # the backup user without following a symlink. A stick someone labelled WHOMBAT-BACKUP is never mounted.
    services.udev.extraRules = ''
      SUBSYSTEM=="block", ACTION=="add|change", ENV{ID_FS_LABEL}=="WHOMBAT-BACKUP", ENV{ID_FS_TYPE}=="ext4|btrfs", ENV{SYSTEMD_WANTS}+="whombat-backup-disk-attach.service"
    '';
    systemd.services.whombat-backup-disk-attach =
      diskHelper "Mount the pinned Whombat backup disk" "disk-attach"
      // {
        wantedBy = [ "multi-user.target" ];
      };
    # The owner's disk destination: the backup service (unprivileged) writes a request; this root helper pins
    # and mounts the backup disk — the mounted one, the one labelled disk attached, or (allowInit) the one
    # empty and unused disk formatted — or answers why not. It takes no device name from anyone.
    systemd.paths.whombat-backup-disk-init = {
      wantedBy = [ "multi-user.target" ];
      after = [ "whombat-persist.target" ];
      pathConfig.PathExists = "${p}/backup/disk-init/request.json";
    };
    systemd.services.whombat-backup-disk-init = diskHelper "Set up the Whombat backup disk (owner's request)" "disk-init";

    # PostgreSQL: a read-only role for pg_dump (pg_export_snapshot needs no privilege). The pg_hba line is in
    # postgres.nix (it forces the whole file).
    services.postgresql.ensureUsers = [ { name = "whombat_backup"; } ];
    # whombat-superuser (postgres.nix): root may connect as postgres over the socket, so a restore at the
    # console (whombat-backup quarantine prepare/apply as root) reaches the database (BK-24).
    services.postgresql.identMap = ''
      whombat-backup whombat-backup whombat_backup
      whombat-superuser postgres postgres
      whombat-superuser root postgres
    '';
    systemd.services.whombat-backup-pgrole = {
      description = "Grant the backup role read access";
      # ensureUsers creates the role in postgresql-setup, not in postgresql.service.
      after = [ "postgresql-setup.service" ];
      requires = [ "postgresql-setup.service" ];
      wantedBy = [ "multi-user.target" ];
      serviceConfig = {
        Type = "oneshot";
        User = "postgres";
        RemainAfterExit = true;
      };
      script = ''
        ${pg}/bin/psql -v ON_ERROR_STOP=1 -c 'GRANT pg_read_all_data TO whombat_backup' -c 'ALTER ROLE whombat_backup BYPASSRLS' \
          -c 'ALTER ROLE whombat_backup CREATEDB'
      '';
    };

    # A backup opened for reading closes at boot (NX-505): its database is dropped and its files removed, whether or not
    # the API is asked anything before.
    systemd.services.whombat-backup-peek-sweep = {
      description = "Close a Whombat backup opened for reading";
      wantedBy = [ "multi-user.target" ];
      requires = [ "whombat-persist.target" ];
      after = [
        "whombat-persist.target"
        "postgresql.service"
        "whombat-backup-pgrole.service"
      ];
      serviceConfig = common // leastPrivilege // {
        Type = "oneshot";
        User = "whombat-backup";
        Group = "whombat-backup";
        ExecStart = "${cfg.package}/bin/whombat-backup -config ${configFile} peek-sweep";
        ReadWritePaths = [ "${p}/backup" ];
        InaccessiblePaths = leastPrivilege.InaccessiblePaths ++ confined;
        PrivateNetwork = true;
      };
    };

    # Credentials are resolved before any ExecStartPre runs, so the services can't seal their own. This unit
    # always leaves every credential: the sealed secret (TPM2 + host key), or an empty placeholder for one
    # never set or cleared (the service treats an empty credential as absent). A plain file the service wrote
    # since the last run is sealed and removed, and the API restarted to pick it up; until then the service
    # reads the plain file (0600 on the encrypted /persist, BK-18).
    # Root never acts on a path in the backup user's directory (BK-26): the plain value is read and removed
    # *as the backup user* (setpriv), so a symlink there can only hand over what that user reads anyway, a
    # FIFO times out; the credentials are written to the root-only ${sealedDir}.
    systemd.services.whombat-backup-seal = {
      description = "Seal the backup destination's secrets with systemd-creds";
      requires = [ "whombat-persist.target" ];
      after = [
        "whombat-persist.target"
        "systemd-tmpfiles-setup.service"
      ];
      before = [
        "whombat-backup.service"
        "whombat-backup-drill.service"
        "whombat-backup-api.service"
      ];
      requiredBy = [
        "whombat-backup.service"
        "whombat-backup-drill.service"
        "whombat-backup-api.service"
      ];
      path = [
        pkgs.coreutils
        config.systemd.package
      ];
      serviceConfig.Type = "oneshot";
      script = ''
        set -eu -o pipefail
        d=${secrets}
        s=${sealedDir}
        if [ -L "$s" ] || [ ! -d "$s" ]; then echo "$s is not root's directory" >&2; exit 1; fi
        chown root:root "$s" && chmod 0700 "$s"
        as_backup() { ${setpriv} "$@"; }
        changed=0
        seal() { # seal <file> <credential name>
          if as_backup test -L "$d/$1"; then
            echo "$d/$1 is a symlink: removed, not sealed" >&2
            as_backup rm -f -- "$d/$1" || true
          elif as_backup test -f "$d/$1"; then
            if as_backup timeout 10 cat -- "$d/$1" | systemd-creds encrypt --with-key=auto --name="$2" - "$s/$1.cred.tmp"; then
              mv -f "$s/$1.cred.tmp" "$s/$1.cred"
              changed=1
            else
              rm -f "$s/$1.cred.tmp"
              echo "$d/$1 couldn't be read as the backup user: not sealed" >&2
            fi
            as_backup shred -u -- "$d/$1" 2>/dev/null || as_backup rm -f -- "$d/$1" || true
          elif [ ! -e "$s/$1.cred" ] && as_backup test -f "$d/$1.cred" && ! as_backup test -L "$d/$1.cred"; then
            # Sealed before the credentials moved to $s: carried over by content, read as the backup user.
            if as_backup timeout 10 cat -- "$d/$1.cred" > "$s/$1.cred.tmp"; then
              mv -f "$s/$1.cred.tmp" "$s/$1.cred"
              changed=1
            else
              rm -f "$s/$1.cred.tmp"
            fi
          fi
          as_backup rm -f -- "$d/$1.cred" || true
          if [ ! -s "$s/$1.cred" ]; then
            printf "" | systemd-creds encrypt --with-key=auto --name="$2" - "$s/$1.cred"
          fi
          chmod 0600 "$s/$1.cred"
        }
        ${lib.concatStringsSep "\n" (lib.mapAttrsToList (file: name: "seal ${file} ${name}") sealed)}
        if [ "$changed" = 1 ]; then
          systemctl --no-block try-restart whombat-backup-api.service || true
        fi
      '';
    };

    # Snapshot helper: root, typed ops, one peer.
    systemd.sockets.whombat-backup-snapd = {
      wantedBy = [ "sockets.target" ];
      socketConfig = {
        ListenStream = "/run/whombat-backup/snapd.sock";
        SocketUser = "root";
        SocketGroup = "whombat-backup";
        SocketMode = "0660";
        RuntimeDirectory = "whombat-backup";
        RuntimeDirectoryPreserve = true;
      };
    };
    systemd.services.whombat-backup-snapd = {
      description = "Whombat backup snapshot helper";
      requires = [ "whombat-persist.target" ];
      after = [
        "whombat-persist.target"
        "whombat-persist-layout.service"
      ];
      path = [ pkgs.btrfs-progs ];
      serviceConfig = common // leastPrivilege // {
        ExecStart = "${cfg.package}/bin/whombat-backup-snapd -config ${configFile}";
        ReadWritePaths = [ "${p}/backup/staging" ];
        ReadOnlyPaths = [
          "${p}/whombat"
          "${p}/secrets"
        ];
        # It snapshots the hub's backup (the source `hosts`), never its live data (NX-408).
        InaccessiblePaths = leastPrivilege.InaccessiblePaths ++ lib.optional hosts.enable "-${hosts.dataDir}";
        # btrfs snapshot/delete and zfs+bind mounts need CAP_SYS_ADMIN; the copy driver needs
        # CAP_DAC_READ_SEARCH + CAP_CHOWN/FOWNER to preserve ownership.
        CapabilityBoundingSet = [
          "CAP_SYS_ADMIN"
          "CAP_DAC_READ_SEARCH"
          "CAP_DAC_OVERRIDE"
          "CAP_CHOWN"
          "CAP_FOWNER"
        ];
        PrivateNetwork = true;
        Slice = "whombat-critical.slice"; # inside the quiesce: must not be starved
      };
    };

    # The checkpoint job. It never sees live data: snapshots are staged under /persist/backup/staging;
    # CAP_DAC_READ_SEARCH lets it read trees owned by other service users there.
    systemd.services.whombat-backup = {
      description = "Whombat backup checkpoint";
      requires = [
        "whombat-persist.target"
        "whombat-backup-snapd.socket"
      ];
      after = [
        "whombat-persist.target"
        "postgresql.service"
        "whombat-backup-snapd.socket"
        "network-online.target"
      ]
      ++ hostsSocket;
      wants = [ "network-online.target" ] ++ hostsSocket;
      # The timer asks every 15 minutes and `-if-due` answers; retries are the policy's, not systemd's.
      startLimitIntervalSec = 0;
      path = [ pkgs.btrfs-progs ];
      serviceConfig = common // leastPrivilege // {
        Type = "oneshot";
        User = "whombat-backup";
        Group = "whombat-backup";
        SupplementaryGroups = [ "whombat-admin" ];
        ExecStart = "${cfg.package}/bin/whombat-backup -config ${configFile} run -reason scheduled -if-due";
        SuccessExitStatus = [ 2 ]; # unprotected (no destination) is a state, not a failure
        AmbientCapabilities = [ "CAP_DAC_READ_SEARCH" ];
        CapabilityBoundingSet = [ "CAP_DAC_READ_SEARCH" ];
        ReadWritePaths = [ "${p}/backup" ];
        InaccessiblePaths = leastPrivilege.InaccessiblePaths ++ confined;
        LoadCredentialEncrypted = credentials;
        Slice = "system.slice";
        CPUWeight = 20;
        IOWeight = 20;
        Nice = 10;
      };
    };
    systemd.timers.whombat-backup = {
      wantedBy = [ "timers.target" ];
      timerConfig = {
        OnCalendar = cfg.schedule;
        RandomizedDelaySec = "3min";
        Persistent = true;
      };
    };

    systemd.services.whombat-backup-drill = {
      description = "Whombat backup restore drill (quarantine, read-only, private cluster)";
      after = [
        "whombat-persist.target"
        "network-online.target"
      ];
      wants = [ "network-online.target" ];
      serviceConfig = common // leastPrivilege // {
        Type = "oneshot";
        User = "whombat-backup";
        Group = "whombat-backup";
        ExecStart = "${cfg.package}/bin/whombat-backup -config ${configFile} drill -if-due -check-data ${cfg.drillCheckData}";
        # A weekly check that found a backup running (exit 3) waits for the next hour; a person's request waits for the
        # running backup instead (it is taken only with the run lock held, NX-503).
        SuccessExitStatus = [ 3 ];
        ReadWritePaths = [ "${p}/backup" ];
        InaccessiblePaths = leastPrivilege.InaccessiblePaths ++ confined;
        LoadCredentialEncrypted = credentials;
        CPUWeight = 10;
        IOWeight = 10;
        Nice = 15;
      };
    };
    systemd.timers.whombat-backup-drill = {
      wantedBy = [ "timers.target" ];
      timerConfig = {
        OnCalendar = cfg.drillSchedule;
        RandomizedDelaySec = "10min";
        Persistent = true;
      };
    };

    # “Check this backup now” (BKO-07): the API writes the request, this starts the drill, which takes it.
    systemd.paths.whombat-backup-drill-request = {
      wantedBy = [ "paths.target" ];
      pathConfig = {
        PathExists = "${p}/backup/drill-request.json";
        Unit = "whombat-backup-drill.service";
      };
    };

    # Bringing this box back from a checkpoint (BK-39, Whombat backup-options.md BKO-11), started by the update
    # helper for the manager when the person chose a backup in the app. Root, like the console restore it replaces
    # (restore.md). Everything that can refuse the restore is checked while the box still runs (the place, the backup
    # and its key, a backup from a newer Whombat against this release's schema, the room); then the runtime stops, the
    # fresh install is set aside, the checkpoint is checked and put in place and the database made writable. The
    # schema is then brought to the release's with the checkpoint as its reference (MD-10). Whatever fails is undone
    # (the fresh install back) and the runtime starts again; restore-result.json says why. The script holds the
    # restore lock across its steps, so the recovery unit, which the runtime's start pulls in, leaves it alone.
    systemd.services."whombat-backup-restore@" = {
      description = "Bring this Whombat back from backup %i";
      after = [
        "whombat-persist.target"
        "postgresql.service"
        "network-online.target"
      ];
      requires = [
        "whombat-persist.target"
        "postgresql.service"
      ];
      wants = [ "network-online.target" ];
      path = [
        pkgs.btrfs-progs
        pkgs.util-linux
        pkgs.systemd
        pkgs.coreutils
        pkgs.jq
      ];
      environment = {
        LANG = "C.UTF-8";
        NODE_ENV = "production";
        WHOMBAT_MODE = "managed";
        WHOMBAT_ENV_FILE = "/etc/whombat/runtime.env";
      };
      serviceConfig = {
        Type = "oneshot";
        TimeoutStartSec = "6h";
        # Not part of the runtime it stops; never killed with it.
        KillMode = "mixed";
      };
      scriptArgs = "%i";
      script = ''
        set -u
        ck="$1"
        backup="${cfg.package}/bin/whombat-backup -config ${configFile}"
        exec 9>>${p}/.whombat-restore.lock
        if ! flock -n 9; then
          echo "another restore is running" >&2
          exit 1
        fi
        cli=${lib.attrByPath [ "whombat" "runtime" "profile" ] "/nonexistent" config}/bin/whombat
        as_runtime() {
          runuser -u whombat -g whombat -- env LANG=C.UTF-8 NODE_ENV=production WHOMBAT_MODE=managed \
            WHOMBAT_ENV_FILE=/etc/whombat/runtime.env "$cli" "$@"
        }
        # This release's schema, from the fresh install's own check: a backup with a newer one is refused before
        # anything moves.
        schema=0
        if [ -x "$cli" ]; then
          schema=$(as_runtime schema-check --json --env 2>/dev/null | jq -r '.binary.version // 0' 2>/dev/null || echo 0)
          case "$schema" in ""|*[!0-9]*) schema=0 ;; esac
        fi
        rc=0
        $backup restore -lock-held -snapshot "$ck" -release-schema "$schema" || rc=$?
        if [ "$rc" != 0 ]; then
          exit "$rc" # refused or undone: the restore started the runtime again itself
        fi
        failed=""
        detail=""
        if [ -x "$cli" ]; then
          src=0
          as_runtime schema-check --json --env >/dev/null || src=$?
          case "$src" in
            0) ;;
            10 | 13)
              echo "the backup's schema is older than this release's: migrating with $ck as the checkpoint"
              mrc=0
              as_runtime migrate --json --env --checkpoint "$ck" || mrc=$?
              if [ "$mrc" != 0 ]; then
                failed=migration
                detail="migrate exit $mrc"
              fi
              ;;
            11 | 12)
              failed=newer
              detail="schema-check exit $src"
              ;;
            *)
              failed=check
              detail="schema-check exit $src"
              ;;
          esac
        fi
        if [ -n "$failed" ]; then
          echo "the restored backup can't run on this release ($failed, $detail): putting this Whombat back as it was" >&2
          $backup restore-end -lock-held -snapshot "$ck" -failed "$failed" -detail "$detail" || true
          systemctl start whombat-runtime.target || true
          exit 1
        fi
        $backup restore-end -lock-held -snapshot "$ck" || rc=$?
        systemctl start whombat-runtime.target || rc=$?
        exit "$rc"
      '';
    };

    # A restore that a crash or a power cut stopped never leaves the box to a factory reset: before the runtime starts
    # (its schema creation included, which would otherwise fill the emptied database), what the restore changed is put
    # back and the status says to try again. After a release (its request file), what the restore set aside is
    # removed. A running restore holds the restore lock and is left alone.
    systemd.services.whombat-backup-restore-recover = {
      description = "Put back what an unfinished Whombat restore changed, remove what a finished one set aside";
      wantedBy = [ "whombat-runtime.target" ];
      before = [
        "whombat-runtime-schema-init.service"
        "whombat-server.service"
        "whombat-runner.service"
      ]
      ++ lib.optional hosts.enable "whombat-hosts.service";
      after = [
        "whombat-persist.target"
        "postgresql.service"
      ];
      requires = [
        "whombat-persist.target"
        "postgresql.service"
      ];
      unitConfig.ConditionPathExists = "${p}/identity/device.json";
      path = [ pkgs.coreutils ];
      serviceConfig = {
        Type = "oneshot";
        ExecStart = "${cfg.package}/bin/whombat-backup -config ${configFile} restore-recover";
        TimeoutStartSec = "1h";
      };
    };
    systemd.paths.whombat-backup-restore-cleanup = {
      wantedBy = [ "paths.target" ];
      pathConfig = {
        PathExists = "${p}/backup/restore-cleanup.json";
        Unit = "whombat-backup-restore-recover.service";
      };
    };

    # Local API for the runtime (status, owner-authorized destination and kit material) and the manager
    # (status for /facts, pre-migration checkpoints inside its drain).
    systemd.sockets.whombat-backup-api = {
      wantedBy = [ "sockets.target" ];
      socketConfig = {
        ListenStream = "/run/whombat-backup/api.sock";
        SocketUser = "whombat-backup";
        SocketGroup = "whombat-backup-clients";
        SocketMode = "0660";
      };
    };
    systemd.services.whombat-backup-api = {
      description = "Whombat backup local API";
      requires = [ "whombat-persist.target" ];
      after = [ "whombat-persist.target" ] ++ hostsSocket;
      wants = hostsSocket;
      serviceConfig = common // leastPrivilege // {
        User = "whombat-backup";
        Group = "whombat-backup";
        SupplementaryGroups = [ "whombat-admin" ];
        ExecStart = "${cfg.package}/bin/whombat-backup -config ${configFile} serve";
        # Pre-migration checkpoints run in the API (inside the manager's drain) and read the staged
        # snapshots of other owners; everything else is hidden (leastPrivilege).
        AmbientCapabilities = [ "CAP_DAC_READ_SEARCH" ];
        CapabilityBoundingSet = [ "CAP_DAC_READ_SEARCH" ];
        ReadWritePaths = [ "${p}/backup" ];
        InaccessiblePaths = leastPrivilege.InaccessiblePaths ++ confined;
        LoadCredentialEncrypted = credentials;
      };
    };

    # The replacement flow's quarantine marker (BK-13): runner units don't start while it exists (and only
    # once provisioned); the runtime reads it and runs no schedules, automations or outbound effects.
    systemd.services.whombat-runner.unitConfig.ConditionPathExists = lib.mkForce [
      "${p}/identity/device.json"
      "!${p}/backup/quarantine.json"
    ];
  };
}
