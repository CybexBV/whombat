# whombat-manager (own user), its known-good recovery unit and the root update helper (socket-activated,
# typed operations only), following W1-MG's unit layout (docs/decisions/manager.md MG-16/MG-17,
# "systemd units"). The manager's and helper's behaviour is W1-MG's; this module owns how they run.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.whombat.manager;
  hcfg = config.whombat.helper;
  p = config.whombat.persistDir;
  m = "${p}/manager";
  inherit (lib) mkOption types;
  json = pkgs.formats.json { };
  systemd = config.systemd.package;
  pinnedRoot = "/etc/whombat/tuf/root.json";
  # A box on the GitHub repository (Whombat LNK-24, LNK-26) verifies it in folders of its own: the continued root gives
  # timestamp and snapshot new keys, so a bridge that rolls back must leave the old repository's verified chain where
  # the earlier manager and helper keep it (tuf/cache, tuf/mirror, the helper's tuf), or they refuse DEV control's next
  # assignment. The GitHub folders keep the continued chain and its versions for the next move forward.
  github = cfg.tuf.targetsLayout == "github";
  tufDir = if github then "${m}/tuf/github" else "${m}/tuf";

  # Key ids of the committed development TUF roots (their private keys are in the repository,
  # release-tools/fixtures/dev-keys). A prod image must not pin a root that trusts any of them (L-4).
  devRoots = [
    ../../release-tools/fixtures/dev/pinned-root.json
    ../../release-tools/fixtures/dev/rotated-root/metadata/2.root.json
    # The community edition's test root (UP-X27): test keys, committed (NX-445).
    ../../release-tools/fixtures/community-test/metadata/1.root.json
  ];
  community = config.whombat.edition == "community";
  devKeyIds = lib.concatMap (f: lib.attrNames (builtins.fromJSON (builtins.readFile f)).signed.keys) devRoots;
  pinnedKeyIds =
    if hcfg.tufRoot == null then
      [ ]
    else
      lib.attrNames (builtins.fromJSON (builtins.readFile hcfg.tufRoot)).signed.keys;
  # ONE-05 (LNK-25): how many root keys sign the pinned root's successor. A production image pins a root that needs
  # two.
  rootRole = f: (builtins.fromJSON (builtins.readFile f)).signed.roles.root;
  pinnedRootOk =
    hcfg.tufRoot == null
    || (
      let
        r = rootRole hcfg.tufRoot;
      in
      r.threshold >= 2 && lib.length r.keyids >= r.threshold
    );

  managerConfig = json.generate "manager.json" (
    lib.recursiveUpdate ({
      deviceFile = "${p}/identity/device.json";
      managementKey = "${p}/identity/management.key";
      managerVersion = cfg.package.version or "0.0.0-dev";
      control.url = if community then "" else cfg.controlUrl;
      tuf = {
        inherit pinnedRoot;
        metadataUrl = cfg.tuf.metadataUrl;
        targetsUrl = cfg.tuf.targetsUrl;
        cacheDir = "${tufDir}/cache";
        mirrorDir = "${tufDir}/mirror";
      };
      # No tuf.targetsLayout here: it goes in the units' environment (layoutEnv), because the recovery unit may run an
      # earlier release's known-good manager with this file, and that one refuses keys it doesn't know (LNK-24).
      stagingDir = "${m}/staging";
      journalDir = "${m}/journal";
      assignmentPath = "${m}/assignment/current.json";
      knownGoodDir = "${m}/known-good";
      helperSocket = "/run/whombat-update-helper/helper.sock";
      apiSocket = "/run/whombat-manager/api.sock";
      # Pre-migration checkpoints and backup status for status.report (MG-18, MG-23, BK-17; NX-30).
      backupSocket = lib.optionalString config.whombat.backup.enable "/run/whombat-backup/api.sock";
      network = {
        candidatesDir = "${m}/network/candidates";
        stateDir = "${m}/network/state";
      };
      runtime = {
        adminSocket = "/run/whombat/admin.sock";
        healthUrl = "";
        sessionAddr = "";
        # Healthy only when these are active (MG-13); with Hermes, also its activation check (NX-484).
        units = [
          "whombat-server.service"
          "whombat-runner.service"
        ]
        ++ lib.optional config.whombat.hermes.enable "whombat-hermes-check.service";
        user = "whombat";
      };
      lockUsers = [ ];
      systemctl = "${systemd}/bin/systemctl";
      reserveBytes = cfg.reserveBytes;
      claimWindowRequired = false;
      # MG-30: where to ask root for new keys when control retired a never-claimed self-installed appliance.
      reregisterRequest = lib.optionalString (config.whombat.provisioning.selfRegister && !community) "${m}/reregister.json";
      # AI clients (MG-33, NX-37): only with a pinned channel key document.
      clients = lib.optionalAttrs (config.whombat.clients.channelKeys != null) {
        root = config.whombat.clients.root;
        stateDir = "${m}/clients";
        channelKeys = "/etc/whombat/tuf/client-channel-keys.json";
      };
      # The licence (MG-34, NX-38): only with a pinned key set.
      licence = lib.optionalAttrs (config.whombat.licence.keys != null) {
        keysFile = config.whombat.licence.file;
        stateFile = "${m}/licence.json";
      };
    }
    // lib.optionalAttrs community {
      # The community edition (MG-136, NX-445): no control; updates are the newest release of its own TUF repository.
      # Only there: the configuration of a commercial box stays readable by an older known-good manager (strict keys).
      edition = "community";
    }) cfg.settings
  );

  helperConfig = json.generate "update-helper.json" (
    lib.recursiveUpdate ({
      managerUser = "whombat-manager";
      deviceFile = "${p}/identity/device.json";
      inherit pinnedRoot;
      mirrorDir = "${tufDir}/mirror";
      stagingDir = "${m}/staging";
      assignmentPath = "${m}/assignment/current.json";
      networkCandidatesDir = "${m}/network/candidates";
      stateDir = hcfg.stateDir;
      idleTimeoutSec = 60;
      activator = hcfg.activator;
      runtimeUser = "whombat";
      fakeRoot = if hcfg.activator == "fake" then "${hcfg.stateDir}/fake" else "";
      fakeDbDir = "";
      nix = {
        NixStore = "${config.nix.package}/bin/nix-store";
        NixEnv = "${config.nix.package}/bin/nix-env";
        Systemctl = "${systemd}/bin/systemctl";
        SystemdRun = "${systemd}/bin/systemd-run";
        Networkctl = "${systemd}/bin/networkctl";
        HelperBinary = "${hcfg.package}/bin/whombat-update-helper";
        ProfilesDir = "/nix/var/nix/profiles";
        RuntimeUnits = [ "whombat-runtime.target" ];
        BlessBootCommand = [
          "${systemd}/lib/systemd/systemd-bless-boot"
          "good"
        ];
        CurrentSystemLink = "/run/current-system";
        NetworkRuntimeFile = "/run/systemd/network/10-whombat.network";
        NetworkStateDir = hcfg.networkStateDir;
        NetworkInterface = "";
        RebootDelaySeconds = 10;
        NetworkRevertUnit = "whombat-network-revert";
        RuntimeProfileName = "whombat-runtime";
        ProviderProfilePref = "whombat-provider-";
        RuntimeCLI = "bin/whombat";
        RuntimeEnvFile = "/etc/whombat/runtime.env";
        # The Wi-Fi dead-man (NX-245): systemd-run's timer that undoes an unconfirmed join or forget.
        WifiRevertUnit = "whombat-wifi-revert";
        # Wi-Fi only: the live file that switches the wired interfaces off (network.nix restores the kept copy before
        # networkd starts), its dead-man and the interfaces it matches.
        CableOffFile = config.whombat.network.cableOffFile;
        CableRevertUnit = "whombat-cable-revert";
        WiredMatch = lib.splitString " " config.whombat.network.defaultInterfaceMatch;
      };
      # iwd for the Wi-Fi operations (NX-244); empty without Wi-Fi: every one answers no_wifi.
      wifi = lib.optionalAttrs config.whombat.wifi.enable {
        dir = "/var/lib/iwd";
        bus = "unix:path=/run/dbus/system_bus_socket";
      };
    }
    // lib.optionalAttrs community {
      # Community (MG-136): activations need no assignment, only the newest release the pinned root approves.
      edition = "community";
    }
    // lib.optionalAttrs (hcfg.defaultChannel != null) {
      # Channels (LNK-20): the newest release of the box's channel, no assignment.
      inherit (hcfg) defaultChannel;
    }
    // lib.optionalAttrs github {
      # The helper's verified cache of the GitHub repository (see tufDir); the earlier helper keeps <stateDir>/tuf.
      metadataDir = "${hcfg.stateDir}/tuf-github";
    }) hcfg.extraSettings
  );

  # The GitHub layout (Whombat LNK-24) for both manager units (manager/internal/config EnvTargetsLayout).
  layoutEnv = lib.optionalAttrs (cfg.tuf.targetsLayout != null) {
    WHOMBAT_TUF_TARGETS_LAYOUT = cfg.tuf.targetsLayout;
  };

  managerHardening = {
    User = "whombat-manager";
    Group = "whombat-manager";
    SupplementaryGroups = [ "whombat-admin" ];
    Slice = "whombat-critical.slice";
    # Whombat comes first when memory runs out (Whombat MP-02, NX-142).
    OOMScoreAdjust = -900;
    ReadWritePaths = [
      m
      "/run/whombat-manager"
      # AI client installs (MG-33): the manager unpacks and never runs them (NoExecPaths below covers them).
      config.whombat.clients.root
    ];
    # Nothing the manager can write is ever executed (M-3): the known-good manager runs from the store.
    NoExecPaths = [ p ];
    ExecPaths = [ "/nix/store" ];
    NoNewPrivileges = true;
    ProtectSystem = "strict";
    ProtectHome = true;
    PrivateTmp = true;
    PrivateDevices = true;
    ProtectKernelTunables = true;
    ProtectKernelModules = true;
    ProtectKernelLogs = true;
    ProtectControlGroups = true;
    ProtectClock = true;
    ProtectHostname = true;
    LockPersonality = true;
    MemoryDenyWriteExecute = true;
    RestrictRealtime = true;
    RestrictSUIDSGID = true;
    RestrictNamespaces = true;
    CapabilityBoundingSet = "";
    SystemCallArchitectures = "native";
    SystemCallFilter = [
      "@system-service"
      "~@privileged @resources"
    ];
    # AF_NETLINK: the interfaces' addresses for the network state (MG-101); route queries only, no capabilities.
    RestrictAddressFamilies = [
      "AF_UNIX"
      "AF_INET"
      "AF_INET6"
      "AF_NETLINK"
    ];
    UMask = "0077";
    LimitCORE = 0;
  };
in
{
  options.whombat.manager = {
    package = mkOption {
      type = types.package;
      default = pkgs.whombat-manager;
      defaultText = lib.literalExpression "pkgs.whombat-manager";
      description = "W1-MG's manager: bin/whombat-manager and bin/whombat-manager-recovery.";
    };
    controlUrl = mkOption {
      type = types.str;
      default = "https://api.dev.whombat.com";
      description = "Control service base URL for this environment (MA-14). Unused by the community edition (no control).";
    };
    tuf = {
      metadataUrl = mkOption {
        type = types.str;
        default = "https://updates.dev.whombat.com/metadata/";
      };
      targetsUrl = mkOption {
        type = types.str;
        default = "https://updates.dev.whombat.com/targets/";
      };
      targetsLayout = mkOption {
        type = types.nullOr (types.enum [ "github" ]);
        default = null;
        description = ''
          Where the targets live under targetsUrl (Whombat LNK-24): null, the consistent-snapshot paths of one server;
          "github", release assets of the GitHub repository (targetsUrl https://github.com/<owner>/<repo>/releases/download/).
          Set in both manager units' environment (WHOMBAT_TUF_TARGETS_LAYOUT), not manager.json; only with a channel.
        '';
      };
    };
    reserveBytes = mkOption {
      type = types.int;
      default = 2 * 1024 * 1024 * 1024;
      description = "Free space the manager keeps on /persist when staging (MG-19).";
    };
    watchdogSec = mkOption {
      type = types.int;
      default = 120;
      description = "systemd watchdog for the manager (its engine loop is the heartbeat, MG-16).";
    };
    settings = mkOption {
      type = json.type;
      default = { };
      description = "Overrides merged into /etc/whombat/manager.json (format: manager/internal/config).";
    };
  };

  options.whombat.helper = {
    package = mkOption {
      type = types.nullOr types.package;
      default = pkgs.whombat-update-helper;
      defaultText = lib.literalExpression "pkgs.whombat-update-helper";
      description = "W1-MG's update helper (bin/whombat-update-helper).";
    };
    activator = mkOption {
      type = types.enum [
        "nix"
        "fake"
      ];
      default = "nix";
    };
    stateDir = mkOption {
      type = types.str;
      default = "/var/lib/whombat-update-helper";
      readOnly = true;
    };
    networkStateDir = mkOption {
      type = types.str;
      default = "/var/lib/whombat-update-helper/network";
      readOnly = true;
    };
    tufRoot = mkOption {
      type = types.nullOr types.path;
      default = null;
      description = ''
        Pinned TUF root.json of this environment (public; part of the host generation, installed at
        /etc/whombat/tuf/root.json). A rotated root reaches devices through TUF itself.
      '';
    };
    extraSettings = mkOption {
      type = json.type;
      default = { };
      description = "Overrides merged into /etc/whombat/update-helper.json (tests).";
    };
    defaultChannel = mkOption {
      type = types.nullOr (
        types.enum [
          "production"
          "development"
        ]
      );
      default = null;
      description = ''
        Update channels (Whombat LNK-20, LNK-21): the channel a box takes the newest release of until its owner
        changes it (the helper keeps the choice, root-owned). null: no channels (the edition decides, as before).
      '';
    };
  };

  config = lib.mkMerge [
    {
      assertions = [
        {
          assertion = config.whombat.environment != "prod" || (hcfg.package != null && hcfg.activator == "nix");
          message = "prod needs the update helper with the nix activator";
        }
        {
          assertion = config.whombat.environment != "prod" || hcfg.tufRoot != null;
          message = "prod needs a pinned TUF root (whombat.helper.tufRoot)";
        }
        {
          assertion =
            config.whombat.environment != "prod" || lib.intersectLists devKeyIds pinnedKeyIds == [ ];
          message = "whombat.helper.tufRoot trusts a development key (release-tools/fixtures/dev-keys): never in prod";
        }
        {
          assertion = config.whombat.environment != "prod" || pinnedRootOk;
          message = "whombat.helper.tufRoot: a production image pins a root whose successor needs two root keys (ONE-05, LNK-25); this one needs ${
            toString (rootRole hcfg.tufRoot).threshold
          }";
        }
        {
          # Channels exist only in the GitHub repository, and its top-level targets list no release (LNK-20, LNK-24):
          # a channel without the GitHub layout finds no channel role, the GitHub layout without a channel finds
          # nothing to install.
          assertion = (hcfg.defaultChannel != null) == (cfg.tuf.targetsLayout == "github");
          message = "whombat.helper.defaultChannel and whombat.manager.tuf.targetsLayout = \"github\" go together";
        }
        {
          assertion =
            cfg.tuf.targetsLayout != "github"
            || (
              builtins.match "https://github\\.com/[^/]+/[^/]+/releases/download/" cfg.tuf.targetsUrl != null
              && lib.hasPrefix "https://" cfg.tuf.metadataUrl
              && !(lib.hasInfix "github.com/" cfg.tuf.metadataUrl)
            );
          message = "the GitHub layout needs tuf.targetsUrl https://github.com/<owner>/<repo>/releases/download/ and tuf.metadataUrl on the repository's Pages site";
        }
        {
          # A community box takes its updates from its own repository alone (MG-136): it must pin that root.
          assertion = !community || (hcfg.tufRoot != null && hcfg.package != null);
          message = "the community edition needs its own pinned TUF root (whombat.helper.tufRoot) and the update helper";
        }
      ];

      environment.etc."whombat/manager.json".source = managerConfig;
      environment.etc."whombat/tuf/root.json" = lib.mkIf (hcfg.tufRoot != null) {
        source = hcfg.tufRoot;
        mode = "0444";
      };
      # Non-secret runtime environment for the helper's schema-check/migrate as the runtime user (MD-10). The
      # runtime reads it under NODE_ENV=production, where an env file must not be readable by group or others
      # (Whombat MR-73): a copy owned by the runtime user, 0400, not a store symlink (NX-45).
      environment.etc."whombat/runtime.env" = {
        text = ''
          WHOMBAT_MODE=managed
          DATABASE_URL=postgresql://whombat@/whombat?host=/run/postgresql
        ''
        # The runtime CLI reads the edition like the server (NX-445).
        + lib.optionalString community "WHOMBAT_EDITION=community\n";
        mode = "0400";
        user = "whombat";
        group = "whombat";
      };
      environment.systemPackages = [ cfg.package ];

      # /run/whombat-manager: setgid whombat-api so api.sock and acme.sock (0660) are reachable by the runtime (and the
      # backup user later) and nobody else (MG-11, MG-163). Persist directories of MG-17; own-address holds the own
      # address's keys (MG-161), the manager's alone.
      systemd.tmpfiles.settings."20-whombat-manager" =
        let
          d = mode: user: group: {
            d = {
              inherit mode user group;
            };
          };
          mgr = d "0700" "whombat-manager" "whombat-manager";
        in
        {
          "/run/whombat-manager" = d "2750" "whombat-manager" "whombat-api";
          "${m}/journal" = mgr;
          "${m}/tuf" = d "0755" "whombat-manager" "whombat-manager";
          "${m}/tuf/cache" = mgr;
          "${m}/tuf/mirror" = d "0755" "whombat-manager" "whombat-manager"; # read by the helper (root)
        }
        // lib.optionalAttrs github {
          "${tufDir}" = d "0755" "whombat-manager" "whombat-manager";
          "${tufDir}/cache" = mgr;
          "${tufDir}/mirror" = d "0755" "whombat-manager" "whombat-manager";
        }
        // {
          "${m}/staging" = mgr;
          "${m}/assignment" = mgr;
          "${m}/network" = mgr;
          "${m}/network/candidates" = mgr;
          "${m}/network/state" = mgr;
          "${m}/known-good" = mgr;
          "${m}/own-address" = mgr;
        };

      # MemoryMin (MP-02, NX-142): the manager's resident memory (about 38 MB on the dev stack).
      whombat.slices.critical.units.whombat-manager = lib.mkDefault 48;
      systemd.services.whombat-manager = {
        description = "Whombat device manager";
        wantedBy = [ "multi-user.target" ];
        wants = [ "network-online.target" ];
        requires = [ "whombat-persist.target" ];
        after = [
          "whombat-persist.target"
          "network-online.target"
          "systemd-tmpfiles-setup.service"
          # With conflicts= alone, starting the manager doesn't wait for the recovery manager to stop: the manager
          # would find its socket still served, exit 1 and count a restart (SR-02). Any ordering between the two makes
          # systemd stop the one before starting the other, either way round; the recovery unit orders on nothing else.
          "whombat-manager-recovery.service"
        ];
        # Independent of the runtime: no Requires/BindsTo either way.
        unitConfig = {
          StartLimitIntervalSec = 600;
          StartLimitBurst = 5;
          OnFailure = [ "whombat-manager-recovery.service" ];
        };
        environment = layoutEnv;
        serviceConfig = managerHardening // {
          Type = "notify";
          NotifyAccess = "main";
          ExecStart = "${cfg.package}/bin/whombat-manager --config /etc/whombat/manager.json";
          Restart = "on-failure";
          RestartSec = "5s";
          WatchdogSec = "${toString cfg.watchdogSec}s";
        };
      };

      # MG-16: runs the verified known-good manager copy (or its own linked-in recovery daemon).
      systemd.services.whombat-manager-recovery = {
        description = "Whombat manager known-good recovery";
        conflicts = [ "whombat-manager.service" ];
        after = [ "whombat-persist.target" ];
        requires = [ "whombat-persist.target" ];
        environment = layoutEnv;
        serviceConfig = managerHardening // {
          Type = "simple";
          ExecStart = "${cfg.package}/bin/whombat-manager-recovery --config /etc/whombat/manager.json";
          Restart = "always";
          RestartSec = "30s";
        };
      };
    }

    (lib.mkIf (hcfg.package != null) {
      environment.etc."whombat/update-helper.json".source = helperConfig;

      systemd.sockets.whombat-update-helper = {
        description = "Whombat update helper socket (manager only)";
        wantedBy = [ "sockets.target" ];
        socketConfig = {
          ListenStream = "/run/whombat-update-helper/helper.sock";
          SocketUser = "root";
          SocketGroup = "whombat-manager";
          SocketMode = "0660";
          # 0755, not MG's 0750: the directory is root-owned, so 0750 would lock the manager out.
          # Access is still limited by the socket's 0660 root:whombat-manager and the helper's peer check.
          DirectoryMode = "0755";
          Accept = false;
          RemoveOnStop = true;
        };
      };

      systemd.services.whombat-update-helper = {
        description = "Whombat update helper (typed operations only)";
        requires = [ "whombat-update-helper.socket" ];
        after = [ "whombat-update-helper.socket" ];
        # No Restart=: socket activation starts it; it exits after idleTimeoutSec.
        serviceConfig = {
          Type = "simple";
          ExecStart = "${hcfg.package}/bin/whombat-update-helper --config /etc/whombat/update-helper.json";
          # Root without `User=`: an explicit `User=root` together with NoNewPrivileges= and any seccomp setting makes
          # systemd leave CAP_SETUID out of the permitted set (it installs the filters after its user change), and
          # then the helper can't run the runtime's CLI as the runtime user (setuid → EPERM; NX-45).
          StateDirectory = "whombat-update-helper";
          StateDirectoryMode = "0700";
          RuntimeMaxSec = "6h";
          # An update is not cut short by the OOM killer (MP-02, NX-142); the migrations it runs inherit it.
          OOMScoreAdjust = -900;
          NoNewPrivileges = true;
          PrivateTmp = true;
          ProtectHome = true;
          ProtectSystem = "strict";
          ReadWritePaths = [
            "/nix"
            "/boot"
            "/run"
            hcfg.stateDir
            # The boot-loader install records which generations the PCR policy key signed (NX-12).
            "-/var/lib/whombat-storage"
            # iwd's saved networks: a join's profile, put back or removed when it is undone (NX-244).
            "-/var/lib/iwd"
          ];
          ReadOnlyPaths = [ m ];
          ProtectKernelModules = true;
          ProtectKernelLogs = true;
          ProtectControlGroups = true;
          ProtectClock = true;
          ProtectHostname = true;
          LockPersonality = true;
          RestrictRealtime = true;
          RestrictSUIDSGID = true;
          SystemCallArchitectures = "native";
          SystemCallFilter = [
            "@system-service @mount @file-system @privileged"
            "~@reboot @swap @module @raw-io @cpu-emulation @obsolete @clock @debug"
          ];
          # No network: it reads the manager's mirror and staging directories only. AF_UNIX also reaches iwd on the
          # system bus (Wi-Fi, NX-244), AF_NETLINK the interfaces' addresses.
          RestrictAddressFamilies = [
            "AF_UNIX"
            "AF_NETLINK"
          ];
          IPAddressDeny = "any";
          # nix-store --import remounts the read-only store privately (CAP_SYS_ADMIN); ownership on /nix,
          # /boot and profiles; setuid/setgid to run schema-check/migrate as the runtime user (MD-10).
          CapabilityBoundingSet = [
            "CAP_SYS_ADMIN"
            "CAP_CHOWN"
            "CAP_FOWNER"
            "CAP_DAC_OVERRIDE"
            "CAP_DAC_READ_SEARCH"
            "CAP_SETUID"
            "CAP_SETGID"
            "CAP_KILL"
          ];
          UMask = "0022";
          LimitCORE = 0;
        };
      };
    })
  ];
}
