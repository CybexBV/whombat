# The Whombat runtime (server + runner) as systemd units running from the runtime *profile*
# (MA-11 update class 1, NX-20). The update helper switches /nix/var/nix/profiles/whombat-runtime to a
# verified bundle and restarts whombat-runtime.target; no host generation change, no reboot.
#
# Runtime bundle contract (what the runtime packaging must provide):
#   <bundle>/bin/whombat-server   long-running server: session endpoint, commit pipeline, admin socket
#   <bundle>/bin/whombat-runner   long-running runner: provider turns inside the sandbox
#   <bundle>/bin/whombat          the CLI: schema-check / migrate --json --env (the helper's, MD-10; NX-46)
# The real bundle is nix/packages/runtime (pkgs.whombat-runtime, NX-41); VM tests and dev default to the stand-in.
# Environment and credentials are described in docs/decisions/nixos.md (NX-20).
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.whombat.runtime;
  p = config.whombat.persistDir;
  community = config.whombat.edition == "community";
  # Whether a box of this image can have Whombat Link (environment.nix, LNK-01): the hosted app and the Feedback drop
  # follow it, not the edition.
  linkPossible = config.whombat.link.possible;
  inherit (lib) mkOption types;

  env = {
    WHOMBAT_MODE = "managed";
    WHOMBAT_ENV = config.whombat.environment;
    WHOMBAT_HOME = "${p}/whombat/home";
    WHOMBAT_WORKSPACES = "${p}/whombat/workspaces";
    WHOMBAT_MANAGER_SOCKET = "/run/whombat-manager/api.sock";
    WHOMBAT_DEVICE_FILE = "${p}/identity/device.json";
    WHOMBAT_CONTENT_PEER_ID_FILE = "${p}/identity/content.peerid";
    WHOMBAT_ADMIN_SOCKET = "/run/whombat/admin.sock";
    WHOMBAT_PROVIDER_PROFILES = "/nix/var/nix/profiles";
    DATABASE_URL = "postgresql://whombat@/whombat?host=/run/postgresql";
    # The server serves the runner's sign-in relay only on this socket (runtime MR-34): it creates it
    # 0666 in /run/whombat, which only its own user can write; the runner checks exactly that.
    WHOMBAT_SIGNIN_SOCKET = "/run/whombat/signin.sock";
    # The replacement flow's quarantine marker (BK-13, M-1): while it exists (also while a restore is in
    # progress) the runtime refuses writes, schedules, automations and outbound effects.
    WHOMBAT_QUARANTINE_FILE = "${p}/backup/quarantine.json";
    NODE_ENV = "production";
    # Loopback only (runner internals, agents' MCP); clients arrive through the session endpoint.
    HOST = "127.0.0.1";
    # The server's loopback port is the one the runner's nftables wall lets it reach (sandbox.nix, MA-14; NX-69):
    # the bundle's default 4400 is rejected there. The runner's own default origin `http://localhost:$PORT` would
    # also resolve to ::1 first while the server listens on 127.0.0.1 only. Either way every runner call failed and
    # agents answered “the agent runner isn't running”.
    PORT = toString config.whombat.sandbox.serverPort;
    WHOMBAT_SERVER_URL = "http://127.0.0.1:${toString config.whombat.sandbox.serverPort}";
  }
  # The community edition (Whombat HE-58, HE-S162; NX-445): no licence, control, relay or remote help in the runtime
  # either. Unset on a commercial box (the runtime's default).
  // lib.optionalAttrs (config.whombat.edition == "community") { WHOMBAT_EDITION = "community"; }
  # Links the server writes point at the hosted UI at this appliance (runtime MR-45, NX-30); required on a commercial
  # box. A community box has no hosted UI: its own page stands for it (Whombat HE-S202), so it's unset there.
  // lib.optionalAttrs (cfg.appUrl != null) { WHOMBAT_APP_URL = cfg.appUrl; }
  # The Feedback widget's own origin (Whombat FD-31, IN-53): the snippet base and the only Origin a sealed report is
  # accepted from. Unset: the runtime falls back to the origin of WHOMBAT_APP_URL.
  // lib.optionalAttrs (cfg.embedUrl != null) { WHOMBAT_EMBED_URL = cfg.embedUrl; }
  // cfg.environment;

  # The hosted UI's origin (NX-30, NX-31) and the Feedback widget's (FD-31, NX-127, HZ-03): production's, the only
  # hosted ones, whatever the image's environment.
  appUrlDefault = "https://app.whombat.com";
  embedUrlDefault = "https://embed.whombat.com";

  hardening = {
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
    ProtectProc = "invisible";
    ProcSubset = "pid";
    LockPersonality = true;
    RestrictRealtime = true;
    RestrictSUIDSGID = true;
    RemoveIPC = true;
    UMask = "0077";
    CapabilityBoundingSet = "";
    AmbientCapabilities = "";
    SystemCallArchitectures = "native";
  };

  # WHOMBAT_RELEASE_ID: the release the helper activated for the runtime profile now in use
  # ("factory" before the first activation). Written as root before each start from the helper's state.
  releaseEnv = pkgs.writeShellScript "whombat-release-env" ''
    set -eu
    id=factory
    state=${config.whombat.helper.stateDir}/state.json
    profile=$(${pkgs.coreutils}/bin/readlink -f ${cfg.profile} || true)
    if [ -r "$state" ]; then
      rid=$(${pkgs.jq}/bin/jq -r --arg p "$profile" \
        'if .runtime.current.runtime.runtime == $p then .runtime.current.releaseId else empty end' "$state" || true)
      [ -n "$rid" ] && id=$rid
    fi
    ${pkgs.coreutils}/bin/install -d -m 0755 /run/whombat-release
    printf 'WHOMBAT_RELEASE_ID=%s\n' "$id" > /run/whombat-release/env.tmp
    ${pkgs.coreutils}/bin/mv /run/whombat-release/env.tmp /run/whombat-release/env
  '';

  common = {
    Restart = "always";
    ExecStartPre = [ "+${releaseEnv}" ];
    # The box's environment (environment.nix, LNK-01a) comes last: its WHOMBAT_APP_URL and the rest override the image's
    # defaults in Environment= (systemd lets an EnvironmentFile override those).
    EnvironmentFile = [
      "-/run/whombat-release/env"
    ]
    ++ lib.optional (config.whombat.environments != { }) "-/run/whombat/environment/runtime.env";
    RestartSec = "2s";
    TimeoutStopSec = "90s";
    KillMode = "mixed";
    Environment = lib.mapAttrsToList (k: v: "${k}=${v}") env;
  }
  // lib.optionalAttrs (cfg.watchdogSec != null) {
    WatchdogSec = "${toString cfg.watchdogSec}s";
    Type = "notify";
    # Node sends READY/WATCHDOG through a systemd-notify child (runtime MR-37): its own PID.
    NotifyAccess = "all";
  };
in
{
  options.whombat.runtime = {
    package = mkOption {
      type = types.package;
      default =
        if config.whombat.environment == "prod" then pkgs.whombat-runtime else pkgs.whombat-standin-runtime;
      defaultText = lib.literalExpression ''
        if config.whombat.environment == "prod" then pkgs.whombat-runtime else pkgs.whombat-standin-runtime'';
      description = ''
        The factory runtime bundle. It seeds the runtime profile on first boot only; afterwards the
        update helper owns the profile. prod gets the real bundle (pkgs.whombat-runtime, built from the pinned
        Whombat, NX-41) and refuses the stand-in; dev images and VM tests keep the stand-in (health + admin
        socket + watchdog, no product) unless they opt in (NX-47).
      '';
    };
    profile = mkOption {
      type = types.str;
      default = "/nix/var/nix/profiles/whombat-runtime";
      readOnly = true;
    };
    appUrl = mkOption {
      type = types.nullOr types.str;
      default = if linkPossible then appUrlDefault else null;
      defaultText = lib.literalExpression ''null on an image without Whombat Link (whombat.link.possible), else "https://app.whombat.com"'';
      example = "https://app.whombat.com";
      description = ''
        Origin of the hosted Whombat UI for this environment (WHOMBAT_APP_URL, runtime MR-45): links the
        server writes (run notices, burrow addresses, invites) are <appUrl>/appliances/<device id>/…. An
        https origin only (no path, query or fragment): the runtime refuses to boot in managed mode without it
        (NODE_ENV=production on the appliance, so http is never accepted there).
      '';
    };
    embedUrl = mkOption {
      type = types.nullOr types.str;
      # The Feedback drop is relayed by control: none on an image without Whombat Link.
      default = if linkPossible then embedUrlDefault else null;
      defaultText = lib.literalExpression ''null on an image without Whombat Link (whombat.link.possible), else "https://embed.whombat.com"'';
      example = "https://embed.whombat.com";
      description = ''
        Origin that serves the Whombat Feedback widget (WHOMBAT_EMBED_URL, Whombat FD-31): website snippets load
        `<embedUrl>/embed/v1/widget.js`, and the runtime files a report from the encrypted drop only when control
        received it from this origin. An https origin only. null: the runtime uses the origin of `appUrl`.
      '';
    };
    environment = mkOption {
      type = types.attrsOf types.str;
      default = { };
      description = "Extra environment for server and runner (non-secret values only).";
    };
    watchdogSec = mkOption {
      type = types.nullOr types.int;
      default = 30;
      description = ''
        systemd watchdog for server and runner (Type=notify, WATCHDOG=1 at least every half period).
        The real runtime says READY=1 once serving and pings every half of WATCHDOG_USEC while its event
        loop turns, through a systemd-notify child (runtime MR-37; hence NotifyAccess=all, NX-45).
        null = Type=simple without watchdog, for a runtime that doesn't speak sd_notify.
      '';
    };
    runnerHome = mkOption {
      type = types.str;
      default = "${p}/whombat/runner/home";
      readOnly = true;
      description = ''
        The runner's WHOMBAT_HOME (NX-76): its own directory (0700 whombat-runner, in its state directory), where it
        keeps what it derives from its home — the empty `gh` config of guarded agents, workspace locks, host
        configuration such as ACP runtimes. The server's home (`${p}/whombat/home`, 0700 whombat) is the server's
        alone; the runner never reads it.
      '';
    };
    credentials = mkOption {
      type = types.attrsOf types.str;
      default = {
        master-key = "${p}/secrets/master.key";
        runner-token = "${p}/secrets/runner-token";
        content-identity = "${p}/identity/content.key";
      }
      # The claim card's secret hash (control's claim): none on the community edition, claimed on its own page with
      # the code on its screen (Whombat HE-59, NX-445).
      // lib.optionalAttrs (!community) { claim = "${p}/identity/claim.json"; };
      description = ''
        Server credentials (name -> root-only file), passed with LoadCredential (readable by the
        service in $CREDENTIALS_DIRECTORY/<name>, never in the environment or the Nix store).
      '';
    };
  };

  config = {
    assertions = [
      {
        assertion =
          config.whombat.environment != "prod" || !(cfg.package.passthru.whombatStandIn or false);
        message = "prod needs the real Whombat runtime bundle, not the stand-in";
      }
      {
        # The runtime refuses anything but an origin (MR-45); fail at build time, not at the device's start.
        # The appliance runs NODE_ENV=production, where the runtime accepts only an https origin.
        assertion =
          if cfg.appUrl == null then !linkPossible else builtins.match "https://[^/?#[:space:]]+/?" cfg.appUrl != null;
        message = "whombat.runtime.appUrl must be an https origin only, e.g. https://app.whombat.com (got ${toString cfg.appUrl}); only an image without Whombat Link has none";
      }
      {
        assertion = cfg.embedUrl == null || builtins.match "https://[^/?#[:space:]]+/?" cfg.embedUrl != null;
        message = "whombat.runtime.embedUrl must be an https origin only, e.g. https://embed.whombat.com (got ${toString cfg.embedUrl})";
      }
    ];

    # 2751: the runner (another user) traverses to the sign-in socket; admin.sock stays 0660
    # whombat-admin. Only the server's user writes here (the runner checks it, MR-34).
    systemd.tmpfiles.settings."20-whombat-runtime"."/run/whombat".d = {
      mode = "2751";
      user = "whombat";
      group = "whombat-admin";
    };

    # The factory runtime's first schema (NX-46). The server never migrates in managed mode (it exits 10,
    # migration_required); migrations are the manager's, through the helper's migrate-runtime (MD-10), which
    # needs an assigned release. A new appliance's database is empty and the factory runtime has none, so this
    # runs the bundle's own `whombat migrate --json --env` exactly as the helper does (the runtime user, the
    # helper's environment and env file) and only when the database has no Whombat schema at all. Any other
    # state is left to the manager. Bundles without bin/whombat (the stand-in) skip it.
    systemd.services.whombat-runtime-schema-init = {
      description = "Create the Whombat runtime's schema on an empty database";
      wantedBy = [ "whombat-runtime.target" ];
      before = [
        "whombat-server.service"
        "whombat-runner.service"
      ];
      after = [
        "whombat-persist.target"
        "postgresql.service"
        "whombat-runtime-profile-init.service"
      ];
      requires = [
        "whombat-persist.target"
        "postgresql.service"
      ];
      unitConfig.ConditionPathExists = [
        "${p}/identity/device.json"
        "${cfg.profile}/bin/whombat"
      ];
      # The helper's environment for the runtime CLI (helper/internal/activator/nix.go cli()).
      environment = {
        LANG = "C.UTF-8";
        NODE_ENV = "production";
        WHOMBAT_MODE = "managed";
        WHOMBAT_ENV_FILE = "/etc/whombat/runtime.env";
      };
      path = [
        pkgs.coreutils
        pkgs.jq
      ];
      serviceConfig = hardening // {
        Type = "oneshot";
        RemainAfterExit = true;
        User = "whombat";
        Group = "whombat";
        Slice = "whombat-critical.slice";
        RestrictAddressFamilies = [ "AF_UNIX" ];
        IPAddressDeny = "any";
        MemoryDenyWriteExecute = false;
        SystemCallFilter = [
          "@system-service"
          "~@privileged @resources"
        ];
        RestrictNamespaces = true;
        LimitCORE = 0;
      };
      script = ''
        set -u
        cli=${cfg.profile}/bin/whombat
        rc=0
        check=$($cli schema-check --json --env) || rc=$?
        version=$(printf '%s' "$check" | jq -r '.database.version // empty' 2>/dev/null || true)
        if [ "$rc" = 10 ] && [ "$version" = 0 ]; then
          echo "empty database: creating the schema of $(readlink -f ${cfg.profile})"
          out=$($cli migrate --json --env) || { echo "migrate failed: $out" >&2; exit 1; }
          printf '%s' "$out" | jq -c '{ok, applied: (.applied | length), verdict: .check.verdict, access: .check.access}'
        elif [ -n "$version" ]; then
          echo "schema: $(printf '%s' "$check" | jq -r .verdict) at database version $version; migrations are the manager's"
        else
          echo "schema-check failed (exit $rc): $check" >&2
          exit 1
        fi
      '';
    };

    # The runner token (MR-37) is made by provisioning; devices provisioned before it get one here, once.
    systemd.services.whombat-runner-token = {
      description = "Create the Whombat runner token if provisioning did not";
      wantedBy = [ "whombat-runtime.target" ];
      before = [
        "whombat-server.service"
        "whombat-runner.service"
      ];
      after = [ "whombat-persist.target" ];
      requires = [ "whombat-persist.target" ];
      unitConfig.ConditionPathExists = [
        "${p}/identity/device.json"
        "!${p}/secrets/runner-token"
      ];
      serviceConfig.Type = "oneshot";
      path = [ pkgs.coreutils ];
      script = ''
        set -eu
        umask 077
        head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > ${p}/secrets/runner-token.tmp
        echo >> ${p}/secrets/runner-token.tmp
        sync ${p}/secrets/runner-token.tmp
        mv ${p}/secrets/runner-token.tmp ${p}/secrets/runner-token
      '';
    };

    systemd.targets.whombat-runtime = {
      description = "Whombat runtime (server and runner)";
      wants = [
        "whombat-server.service"
        "whombat-runner.service"
      ];
      wantedBy = [ "multi-user.target" ];
    };

    # First boot only: point the runtime profile at the factory bundle.
    systemd.services.whombat-runtime-profile-init = {
      description = "Seed the Whombat runtime profile";
      unitConfig.ConditionPathExists = "!${cfg.profile}";
      before = [
        "whombat-server.service"
        "whombat-runner.service"
      ];
      wantedBy = [ "whombat-runtime.target" ];
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
        ExecStart = "${config.nix.package}/bin/nix-env --profile ${cfg.profile} --set ${cfg.package}";
      };
    };

    # MemoryMin (MP-02, NX-142): the server's usual resident memory (about 310 MB idle on the dev stack, 0.48.1).
    whombat.slices.critical.units.whombat-server = lib.mkDefault 384;
    systemd.services.whombat-server = {
      description = "Whombat server (managed mode)";
      partOf = [ "whombat-runtime.target" ];
      wants = [
        "postgresql.service"
        "whombat-runtime-schema-init.service"
      ];
      requires = [ "whombat-persist.target" ];
      after = [
        "whombat-persist.target"
        "postgresql.service"
        "whombat-runtime-profile-init.service"
        "whombat-runtime-schema-init.service"
      ];
      unitConfig = {
        StartLimitIntervalSec = 300;
        StartLimitBurst = 10;
      };
      serviceConfig = hardening // common // {
        ExecStart = "${cfg.profile}/bin/whombat-server";
        User = "whombat";
        Group = "whombat";
        Slice = "whombat-critical.slice";
        # Whombat comes first when memory runs out (Whombat MP-02, NX-142): as PostgreSQL. Its MemoryMin is below.
        OOMScoreAdjust = -900;
        # /run/whombat (tmpfiles, setgid whombat-admin): admin.sock 0660 for the manager (MG-12).
        ReadWritePaths = [
          "${p}/whombat/home"
          "${p}/whombat/workspaces"
          "/run/whombat"
          # WHOMBAT_CLIENTS_FILE (NX-37): the manager's client status for the runner.
          "/run/whombat-clients"
          # WHOMBAT_VAULT_NETWORKS_FILE (VT-59, NX-40): the home-network list for the Vault's firewall sets.
          "/run/whombat-vault"
        ];
        LoadCredential = lib.mapAttrsToList (n: f: "${n}:${f}") cfg.credentials;
        # A stopped or restarting server leaves no stale claim code on the console: without the file the
        # console shows "Starting Whombat…" (NX-32).
        ExecStopPost = [ "-${pkgs.coreutils}/bin/rm -f ${config.whombat.console.file}" ];
        # Secret files are read from the credentials directory (%d), never from /persist directly.
        Environment = common.Environment ++ [
          "WHOMBAT_MASTER_KEY_FILE=%d/master-key"
          "RUNNER_TOKEN_FILE=%d/runner-token"
          "WHOMBAT_CONTENT_KEY_FILE=%d/content-identity"
          # The tty1 console's state (CC-08, NX-32): written atomically, mode 0640 (explicit: UMask is 0077);
          # the directory's setgid bit makes its group whombat-console.
          "WHOMBAT_CONSOLE_FILE=${config.whombat.console.file}"
          # The admins' home-network list for the Vault (VT-59, NX-40): written at boot and after every change,
          # temp file + rename, mode 0644 (explicit: UMask is 0077); whombat-vault-wall turns it into firewall sets.
          "WHOMBAT_VAULT_NETWORKS_FILE=${config.whombat.vaultWall.file}"
          # The ports a public SSH server may use (VT-S06, VT-S14; IN-150, NX-128): the same list the egress rule opens
          # to this uid, so the runtime never accepts a server the wall would refuse.
          "WHOMBAT_VAULT_SSH_PORTS=${lib.concatMapStringsSep "," toString (lib.sort lib.lessThan config.whombat.vault.sshPorts)}"
          # The direct listener (Whombat HE-50, HE-51; direct-connection.md DC-02, DC-03; NX-440): the port the firewall
          # opens inbound, and where the runtime takes connections on it — `lan` (the box's own network cards) and
          # `tailscale0`; the firewall's own gate is network.nix's.
          "WHOMBAT_DIRECT_PORT=${toString config.whombat.network.directPort}"
          "WHOMBAT_DIRECT_INTERFACES=${
            lib.concatStringsSep "," (
              [ "lan" ] ++ lib.optional config.whombat.tailscale.enable config.whombat.tailscale.interface
            )
          }"
          # The web app it serves to direct browsers is the bundle's own `web/` ($WHOMBAT_APP_DIR/web, NX-442), so it
          # moves with every runtime update.
        ]
        ++ lib.optional (cfg.credentials ? claim) "WHOMBAT_CLAIM_FILE=%d/claim"
        # Tailscale itself (state, sign-in, the certificate for the box's name) is the manager's, through its socket
        # (contracts CT-1255, NX-441): the server gets no tailscaled socket.
        # Owner backup ops (runtime MR-19) on the backup service's local API; the server's user is in
        # whombat-backup-clients, the socket's group (NX-28, NX-30). The runner doesn't get it.
        ++ lib.optional config.whombat.backup.enable "WHOMBAT_BACKUP_SOCKET=/run/whombat-backup/api.sock"
        # The licence key set pinned in the image (LC-03, runtime MR-55, NX-38); the runner doesn't verify licences.
        ++ lib.optional (config.whombat.licence.keys != null) "WHOMBAT_LICENCE_KEYS_FILE=${config.whombat.licence.file}"
        # The desk display (Whombat DK-12, NX-160): the server opens this socket in the console's directory (0660, the
        # directory's setgid group whombat-console), and only the graphical console's server dials it. Only where
        # there is a graphical console to show it.
        ++ lib.optionals (config.whombat.console.enable && config.whombat.console.gui) [
          "WHOMBAT_DESK_SOCKET=${config.whombat.console.deskSocket}"
          # This boot's id (systemd's %b): an unlock that stays until Lock survives a runtime restart on the same boot
          # and never a reboot (Whombat DK-75, NX-320). ProcSubset=pid hides /proc/sys/kernel/random/boot_id.
          "WHOMBAT_BOOT_ID=%b"
        ]
        # Speech on the box (DK-06, voice.nix NX-184): whombat-voice's socket, 0660 whombat-voice:whombat (the server's
        # primary group), socket-activated, so no ordering or writable path. The runner doesn't get it: talk is the server's.
        ++ lib.optional config.whombat.voice.enable "WHOMBAT_VOICE_SOCKET=${config.whombat.voice.socket}"
        # Voice typing's models (Whombat DT-05, voice.nix NX-473): the fetcher's socket, 0660 whombat-voice-models:whombat.
        ++ lib.optional config.whombat.voice.enable "WHOMBAT_VOICE_MODELS_SOCKET=${config.whombat.voice.models.socket}"
        # Stay unlocked while you're here (DK-28, presence.nix NX-285): whombat-presence's socket, 0660
        # whombat-presence:whombat, socket-activated like voice's. The runner doesn't get it: the desk is the server's.
        ++ lib.optional config.whombat.presence.enable "WHOMBAT_PRESENCE_SOCKET=${config.whombat.presence.socket}"
        # Bluetooth (BT-02, bluetooth.nix NX-354): whombat-bluetooth's socket, 0660 whombat-bluetooth:whombat,
        # socket-activated like voice's. The runner doesn't get it: pairing is an owner's, through the server.
        ++ lib.optional config.whombat.bluetooth.enable "WHOMBAT_BLUETOOTH_SOCKET=${config.whombat.bluetooth.socket}"
        # Remote help (Whombat RH-01, support.nix NX-414): whombat-support's socket, 0660 root:whombat-support (the
        # server is a member), socket-activated. The runner doesn't get it: remote help is an owner's, through the server.
        ++ lib.optional config.whombat.support.enable "WHOMBAT_SUPPORT_SOCKET=${config.whombat.support.socket}";
        SupplementaryGroups = [
          "whombat-workspaces"
          "whombat-api"
        ];
        # AF_NETLINK (NX-145): networkInterfaces() reads this machine's addresses over netlink, for “Found on your
        # network” (Whombat CS-14) and the Tailscale listener's own addresses; without it the call fails (errno 97).
        RestrictAddressFamilies = [
          "AF_UNIX"
          "AF_INET"
          "AF_INET6"
          "AF_NETLINK"
        ];
        # Node's JIT needs writable+executable memory.
        MemoryDenyWriteExecute = false;
        SystemCallFilter = [
          "@system-service"
          "~@privileged @resources"
        ];
        RestrictNamespaces = true;
        LimitCORE = 0;
      };
    };

    systemd.services.whombat-runner = {
      description = "Whombat runner (sandboxed provider turns)";
      partOf = [ "whombat-runtime.target" ];
      requires = [ "whombat-persist.target" ];
      after = [
        "whombat-persist.target"
        "whombat-server.service"
        "whombat-runtime-profile-init.service"
        "whombat-sandbox-prereqs.service"
      ];
      wants = [ "whombat-sandbox-prereqs.service" ];
      unitConfig = {
        StartLimitIntervalSec = 300;
        StartLimitBurst = 10;
      };
      serviceConfig =
        hardening
        // common
        // {
          ExecStart = "${cfg.profile}/bin/whombat-runner";
          User = "whombat-runner";
          Group = "whombat-runner";
          SupplementaryGroups = [ "whombat-workspaces" ];
          Slice = "whombat-tasks.slice";
          # Core, as the server (MP-02, Whombat MP-D04, NX-142). The runner raises what it starts itself: the provider
          # CLIs (their tools and MCP servers) to -500, after every process of the containers (500), before Whombat's
          # core. Raising needs no privilege; nothing it starts can go below -900.
          OOMScoreAdjust = -900;
          RuntimeDirectory = "whombat-runner";
          RuntimeDirectoryMode = "0700";
          LoadCredential = [ "runner-token:${cfg.credentials.runner-token}" ];
          # Its own WHOMBAT_HOME (NX-76): with the server's it failed at every guarded turn (`mkdir …/home/guarded/gh`:
          # EACCES) and at start (`acp-runtimes.json`: EACCES).
          Environment = lib.filter (e: !lib.hasPrefix "WHOMBAT_HOME=" e) common.Environment ++ [
            "WHOMBAT_HOME=${cfg.runnerHome}"
            "RUNNER_TOKEN_FILE=%d/runner-token"
          ];
          RestrictAddressFamilies = [
            "AF_UNIX"
            "AF_INET"
            "AF_INET6"
            "AF_NETLINK"
          ];
          MemoryDenyWriteExecute = false;
          LimitCORE = 0;
        }
        // config.whombat.sandbox.runnerServiceOverrides;
    };
  };
}
