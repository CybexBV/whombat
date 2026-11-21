# The hosts service (Whombat ONE-11…ONE-15; NX-152…NX-155): the headless hub built from `hosts/` (formerly
# Rackoon) that every monitored server's `whombat-agent` dials, and that the Whombat server talks to for servers, guests,
# alerts, checks and consoles. Whombat owns every screen, account and permission (ONE-12); the hub has none of its own.
#
# - The unit: `whombat-hosts serve --headless`, its own user (uid/gid 965), its data on /persist/hosts (a subvolume of
#   its own; the database and the agents' CA), the API on the Unix socket /run/whombat-hosts/api.sock (0660, group
#   whombat-hosts), the agents' TLS listener on `agentPort` (8443). Sandboxed tightly; of /persist it sees only
#   its own directory. Outside the boot assessment and the runtime target: servers going quiet never roll back an update.
# - The Whombat server: WHOMBAT_HOSTS_SOCKET and WHOMBAT_HOSTS_TOKEN_FILE, and the group whombat-hosts, which reaches the
#   socket and the one file it may read in /persist/hosts (0710): the service token (0640) the hub writes at its first
#   start and keeps only the hash of.
# - The network (NX-154): agents reach `agentPort` from private networks only (as the ports agents publish, NX-138); the
#   hub reaches the local network for its checks (as the server, NX-144), never this host's own services.
# - On every box (NX-523: the Whombat image, prod-instance.nix). Production takes only the hub whose agents are signed
#   with the Whombat agent-signing key: their manifest verified against its public half at build time
#   (nix/packages/hosts/agent-update-key.pub), so a box serves only agents that take updates signed by that key.
# - Signed agents (NX-157…NX-160): the package's agents trust the Whombat agent-signing key and their manifest is in the
#   agent directory, so the hub offers agent self-update (Whombat AU-01…AU-03).
# - In the box's backups (NX-407…NX-409, BK-31…BK-34): a connection to /run/whombat-backup/hosts.sock (the backup's
#   group) makes the hub's own backup as its user into /persist/hosts-backup, the checkpoint's `hosts` source; the
#   console restore stages it at /persist/hosts/restore-staged.tar (.tar.gz when gzipped), which the hub applies at its
#   next start. The hub
#   doesn't start while the box is in quarantine.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.whombat.hosts;
  inherit (lib) mkOption types;
  p = config.whombat.persistDir;
  ids = config.whombat.ids;

  dataDir = "${p}/hosts";
  # The hub's own backup for the box's checkpoints (NX-407, BK-31): a subvolume of its own in root's /persist.
  backupDir = "${p}/hosts-backup";
  backupSocket = "/run/whombat-backup/hosts.sock";
  backupOn = config.whombat.backup.enable;
  runDir = "/run/whombat-hosts";
  socket = "${runDir}/api.sock";
  tokenFile = "${dataDir}/service-token";
  agentDist = "${cfg.package}/${cfg.package.passthru.agentDist or "share/whombat-hosts/agent"}";
  # The public half of the Whombat agent-signing key (NX-157): the only one a production hub's agents may trust.
  agentKey = lib.fileContents ../packages/hosts/agent-update-key.pub;
  signedHub = (cfg.package.passthru.updateKey or null) == agentKey && cfg.package.passthru ? manifestCheck;
  port = toString cfg.agentPort;
  # Where agents may connect from (NX-138's sources): RFC 1918, CGNAT and link-local; ULA and IPv6 link-local.
  private4 = "10.0.0.0/8, 100.64.0.0/10, 169.254.0.0/16, 172.16.0.0/12, 192.168.0.0/16";
  private6 = "fc00::/7, fe80::/10";

  # The hub's sandbox (NX-153), also its backup's (NX-407): of /persist only its own directories, no other service's
  # sockets or credentials, no capabilities.
  sandbox = {
    TemporaryFileSystem = [ "${p}:ro" ];
    InaccessiblePaths = [
      "-/run/postgresql"
      "-/run/whombat"
      "-/run/whombat-manager"
      "-/run/whombat-backup"
      "-/run/whombat-update-helper"
      "-/run/whombat-vault"
      "-/run/whombat-clients"
      "-/run/whombat-agent-net"
      "-/run/whombat-containers"
      "-/run/credentials"
      "-/var/lib"
      "-/boot"
    ];
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
    MemoryDenyWriteExecute = true;
    RestrictRealtime = true;
    RestrictSUIDSGID = true;
    RestrictNamespaces = true;
    RemoveIPC = true;
    SystemCallArchitectures = "native";
    SystemCallFilter = [
      "@system-service"
      "~@privileged @resources"
    ];
    CapabilityBoundingSet = "";
    AmbientCapabilities = "";
    UMask = "0077";
    LimitCORE = 0;
  };

  # One checkpoint's backup of the hub (NX-407, BK-32): `whombat-hosts backup` (a consistent copy of the database by
  # VACUUM INTO, the CA; it works whether the hub runs or not) to a temporary name, synced and renamed to
  # hub.tar.gz; the answer on the socket is `ok` or `failed: <why>` (its first 300 characters; all of it in the
  # journal).
  backupScript = pkgs.writeShellScript "whombat-hosts-backup" ''
    set -u
    dir=${backupDir}
    rm -f -- "$dir"/.hub-*
    if ! tmp=$(mktemp -p "$dir" .hub-XXXXXXXX); then
      echo "failed: no temporary file in $dir"
      exit 1
    fi
    trap 'rm -f -- "$tmp"' EXIT
    if ! errs=$(${cfg.package}/bin/whombat-hosts backup --data ${dataDir} --out - 2>&1 >"$tmp"); then
      printf '%s\n' "$errs" >&2
      printf 'failed: %s\n' "$(printf '%s' "$errs" | tr '\n' ' ' | cut -c1-300)"
      exit 1
    fi
    if ! sync -- "$tmp" || ! mv -f -- "$tmp" "$dir/hub.tar.gz"; then
      echo "failed: the backup couldn't be kept in $dir"
      exit 1
    fi
    echo ok
  '';
in
{
  options.whombat.hosts = {
    enable = mkOption {
      type = types.bool;
      default = false;
      description = ''
        The hosts service (Whombat ONE-11, NX-152): the headless hub for the servers people add in Whombat, its agents'
        listener and the Whombat server's way to it. On in the Whombat image (NX-523); in production only with the
        agents signed by the Whombat agent-signing key.
      '';
    };
    package = mkOption {
      type = types.package;
      default = pkgs.whombat-hosts;
      defaultText = lib.literalExpression "pkgs.whombat-hosts";
      description = "The hub (bin/whombat-hosts) and the signed agents it serves (share/whombat-hosts/agent).";
    };
    agentPort = mkOption {
      type = types.port;
      default = 8443;
      description = ''
        The agents' TLS listener (`--agent-listen :<port>`), the port in every install command (`--agent-url auto`: the
        LAN address of the default route's interface). New connections only from private networks (NX-154).
      '';
    };
    socket = mkOption {
      type = types.str;
      default = socket;
      readOnly = true;
      description = "The hub's API socket (WHOMBAT_HOSTS_SOCKET of the server), 0660, group whombat-hosts.";
    };
    tokenFile = mkOption {
      type = types.str;
      default = tokenFile;
      readOnly = true;
      description = ''
        The service token (WHOMBAT_HOSTS_TOKEN_FILE of the server): written by the hub at its first start (0640, group
        whombat-hosts), which keeps only its hash; the server sends it as `Authorization: Bearer`.
      '';
    };
    dataDir = mkOption {
      type = types.str;
      default = dataDir;
      readOnly = true;
      description = "The hub's database and the agents' CA (`--data`), a /persist subvolume of its own.";
    };
    backupDir = mkOption {
      type = types.str;
      default = backupDir;
      readOnly = true;
      description = ''
        Where the hub's own backup (hub.tar.gz) is made for the box's checkpoints, the backup's `hosts` source (NX-407,
        BK-31): a /persist subvolume of its own, the hub user's (0700).
      '';
    };
    backupSocket = mkOption {
      type = types.str;
      default = backupSocket;
      readOnly = true;
      description = ''
        A connection makes the hub's backup in `backupDir` as the hub's user and answers `ok` (NX-407, BK-32): the
        backup service's (root:whombat-backup 0660).
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        # One agent-signing key for the one environment (NX-523, ONE-01; was DEV's, NX-157): a production hub hands out
        # only agents built with its public half and signed by it (the package's manifest check), never unsigned ones
        # or another key's.
        assertion = config.whombat.environment != "prod" || signedHub;
        message = "whombat.hosts in prod needs the hosts package whose agents are signed with the Whombat agent-signing key (nix/packages/hosts/agent-update-key.pub; dev/sign-agents, NX-157, NX-523)";
      }
      {
        # No CAP_NET_BIND_SERVICE; and never one of the ports the agent's services publish (NX-138, NX-461).
        assertion =
          let
            pp = config.whombat.containers.publishPorts;
          in
          cfg.agentPort >= 1024
          && !(config.whombat.containers.enable && cfg.agentPort >= pp.from && cfg.agentPort <= pp.to);
        message = "whombat.hosts.agentPort: 1024 or above, outside whombat.containers.publishPorts";
      }
    ];

    # ---- The account (NX-08: fixed ids, /persist is owned by them) ------------------------------------------------
    users.users.whombat-hosts = {
      isSystemUser = true;
      uid = ids.whombat-hosts;
      group = "whombat-hosts";
      home = "/var/empty";
      createHome = false;
      shell = "/run/current-system/sw/bin/nologin";
    };
    users.groups.whombat-hosts.gid = ids.whombat-hosts;
    # The server reaches the API socket and reads the service token through the group.
    users.users.whombat.extraGroups = [ "whombat-hosts" ];

    # ---- Storage: a subvolume in Whombat's qgroup (NX-12), traversable by the group for the token only -------------
    # Its backup for the box's checkpoints in a subvolume of its own (NX-407): the btrfs snapshot driver takes it like
    # the other sources, and in root's /persist the hub's user can't remove or replace the directory.
    whombat.storage.extraSubvolumes = [
      "hosts"
      "hosts-backup"
    ];
    systemd.tmpfiles.settings."20-whombat-hosts" = {
      ${dataDir}.d = {
        mode = "0710";
        user = "whombat-hosts";
        group = "whombat-hosts";
      };
      ${backupDir}.d = {
        mode = "0700";
        user = "whombat-hosts";
        group = "whombat-hosts";
      };
    };

    # ---- The agents' listener: private networks only (NX-154, as NX-138) ------------------------------------------
    networking.firewall.extraInputRules = ''
      ip saddr { ${private4} } tcp dport ${port} accept comment "the hosts service's agents (Whombat ONE-15)"
      ip6 saddr { ${private6} } tcp dport ${port} accept comment "the hosts service's agents (Whombat ONE-15)"
    '';
    networking.nftables.tables.whombat-egress.content = lib.mkAfter ''
      # ---- The hosts service's agents (Whombat ONE-15, NX-154): new connections to ${port} from private networks only,
      # before the NixOS firewall, whatever another rule opens. Nothing on this host connects to it.
      chain hosts_input {
        type filter hook input priority filter - 1; policy accept;
        tcp dport ${port} ct state new jump hosts_agents
      }
      chain hosts_agents {
        iifname "lo" counter reject with icmpx admin-prohibited comment "hosts agents: not from this host"
        ip saddr { ${private4} } return
        ip6 saddr { ${private6} } return
        counter drop comment "hosts agents: private networks only"
      }
    '';

    # ---- The hub ---------------------------------------------------------------------------------------------------
    systemd.services.whombat-hosts = {
      description = "Whombat hosts service (the servers' agents and their data)";
      # Not the runtime target, not the boot assessment (boot.nix): the box is healthy whatever its servers do.
      wantedBy = [ "multi-user.target" ];
      # Its egress rules before its first check; the LAN address (`--agent-url auto`, the agents' certificate) once
      # there is a network.
      requires = [
        "whombat-persist.target"
        "nftables.service"
      ];
      wants = [ "network-online.target" ];
      after = [
        "whombat-persist.target"
        "whombat-persist-layout.service"
        "nftables.service"
        "network-online.target"
      ];
      unitConfig = {
        # Nothing that serves people starts before provisioning (as the runtime's units); nor while the box is in
        # quarantine after a console restore (NX-409, BK-34, as the runner, BK-13): the servers it restored are applied
        # at its first start after the release.
        ConditionPathExists = [
          "${p}/identity/device.json"
        ]
        ++ lib.optional backupOn "!${p}/backup/quarantine.json";
        RequiresMountsFor = [ p ];
        StartLimitIntervalSec = 0;
      };
      serviceConfig = sandbox // {
        Type = "exec";
        ExecStart = lib.escapeShellArgs [
          "${cfg.package}/bin/whombat-hosts"
          "serve"
          "--headless"
          "--data"
          dataDir
          "--listen"
          "unix:${socket}"
          "--agent-listen"
          ":${port}"
          "--agent-url"
          "auto"
          "--agent-dist"
          agentDist
          "--service-token-file"
          tokenFile
        ];
        User = "whombat-hosts";
        Group = "whombat-hosts";
        Restart = "always";
        RestartSec = "2s";
        RestartSteps = 6;
        RestartMaxDelaySec = "60s";
        TimeoutStopSec = "20s";
        # The socket's directory: the server traverses it (group), the hub makes the socket 0660 (`--socket-mode`).
        RuntimeDirectory = "whombat-hosts";
        RuntimeDirectoryMode = "0750";
        MemoryMax = "512M";
        # One connection per agent and per console.
        LimitNOFILE = 65536;
        # Of /persist only its own directory (writable): not the database, keys, identity, Whombat's home or the
        # containers, nor its backup (NX-407). Not DynamicUser: /persist/hosts keeps its owner across host generations
        # (NX-08). The rest of the sandbox above; no capabilities: ping checks use unprivileged ICMP sockets
        # (net.ipv4.ping_group_range, NX-153).
        BindPaths = [ dataDir ];
        ReadWritePaths = [ dataDir ];
        # Its socket, the agents, its checks; netlink for the default route's interface (`--agent-url auto`).
        RestrictAddressFamilies = [
          "AF_UNIX"
          "AF_INET"
          "AF_INET6"
          "AF_NETLINK"
        ];
        # Nothing on this host but the resolver stub (the egress table refuses its LAN address too, NX-154).
        IPAddressDeny = [ "localhost" ];
        IPAddressAllow = [
          "127.0.0.53"
          "127.0.0.54"
        ];
      };
    };

    # ---- Its backup for the box's checkpoints (NX-407, BK-31…BK-33) ------------------------------------------------
    # The backup service connects before each checkpoint; the instance makes the backup as the hub's user, with the
    # hub's sandbox and no network, in its two directories only, and answers on the connection. Root does nothing in
    # them; the backup user never gets the service token (BK-32).
    systemd.sockets.whombat-hosts-backup = lib.mkIf backupOn {
      description = "The hosts service's backup for the box's checkpoints";
      wantedBy = [ "sockets.target" ];
      socketConfig = {
        ListenStream = backupSocket;
        SocketUser = "root";
        SocketGroup = "whombat-backup";
        SocketMode = "0660";
        Accept = true;
        MaxConnections = 1;
      };
    };
    systemd.services."whombat-hosts-backup@" = lib.mkIf backupOn {
      description = "Make the hosts service's backup for a checkpoint";
      path = [ pkgs.coreutils ];
      unitConfig.RequiresMountsFor = [ p ];
      serviceConfig = sandbox // {
        ExecStart = backupScript;
        User = "whombat-hosts";
        Group = "whombat-hosts";
        StandardInput = "socket";
        StandardOutput = "socket";
        StandardError = "journal";
        BindPaths = [
          dataDir
          backupDir
        ];
        ReadWritePaths = [
          dataDir
          backupDir
        ];
        PrivateNetwork = true;
        RestrictAddressFamilies = [ "AF_UNIX" ];
        RuntimeMaxSec = "30min";
        MemoryMax = "512M";
        Nice = 10;
        CPUWeight = 20;
        IOWeight = 20;
      };
    };

    # ---- The Whombat server (Whombat ONE-DH: the hosts client) ----------------------------------------------------
    systemd.services.whombat-server = {
      environment = {
        WHOMBAT_HOSTS_SOCKET = socket;
        WHOMBAT_HOSTS_TOKEN_FILE = tokenFile;
      };
      serviceConfig.SupplementaryGroups = [ "whombat-hosts" ];
    };
  };
}
