# The agent's commands on the appliance itself (Whombat one-person.md OP-04, OP-07, OP-13; the brief's I-1, I-3, I-4;
# NX-455…NX-466): Hermes runs them through its own terminal, each in a thin wrapper of the runner's inside Hermes's
# sandbox. The computers are gone (NX-455); what the commands need from the image is here:
#
# - Tools (I-1, NX-464): `WHOMBAT_AGENT_TOOLS`, the store path of the agent's tools (nix/packages/agent-tools), whose
#   bin/ comes first on a command's PATH; `WHOMBAT_AGENT_NIX_LD` and `WHOMBAT_AGENT_NIX_LD_LIBRARY_PATH` (a command's
#   NIX_LD and NIX_LD_LIBRARY_PATH: glibc's loader and the libraries wheels and downloaded programs link against);
#   /lib64's loader is nix-ld's (providers.nix).
# - The agent's home (I-3, NX-465): /persist/whombat/agent/home, a subvolume of its own, backed up (the backup's
#   `agent` source), the runner's and writable for the container engine's group, so `docker run -v ./src:/app` in it
#   works both ways (default ACLs keep what either side makes writable for the other). `WHOMBAT_AGENT_HOME`.
# - The commands' network (I-4, NX-456, NX-460): the runner's commands share a network namespace of their own whose
#   127.0.0.1:3128 leads to a proxy in `whombat-agent-net` (the runtime bundle's bin/whombat-agent-net, its own uid,
#   computerd's 962), on /run/whombat-agent-net/proxy.sock (the runner is in its group). That uid's connections get the
#   computers' wall (`agent_wall`, NX-131's computers_out): the Vault's home networks, the local network, every public
#   address but port 25, and of this host only the resolver stub and the agent's own published services
#   (containers.nix). The containers' traffic gets the same wall.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.whombat.agent;
  inherit (lib) mkOption types;
  p = config.whombat.persistDir;
  ids = config.whombat.ids;
  netUser = "whombat-agent-net";
  netDir = "/run/whombat-agent-net";
  netSocket = "${netDir}/proxy.sock";
  netEntry = "${config.whombat.runtime.profile}/bin/whombat-agent-net";
  home = "${p}/whombat/agent/home";
  containers = config.whombat.containers;
  publish = "${toString containers.publishPorts.from}-${toString containers.publishPorts.to}";
  vaultMark = config.whombat.network.vaultMark;
  # The agent's commands' connections to its own published services on this host ("SERV"): the published ports'
  # chain admits only these from loopback (containers.nix).
  servicesMark = "0x53455256";
  isV4Cidr = c: builtins.match "([0-9]{1,3}\\.){3}[0-9]{1,3}(/[0-9]{1,2})?" c != null;
  set = pkgs.callPackage ../packages/agent-tools {
    agentBrowser = cfg.agentBrowser;
    containersSocket = containers.socket;
  };
in
{
  options.whombat.agent = {
    enable = mkOption {
      type = types.bool;
      default = false;
      description = ''
        The agent's commands on the appliance (Whombat OP-04, OP-07): its tools, its home, the commands' network daemon
        and its wall, and the runner's WHOMBAT_AGENT_* settings. On in every appliance profile
        (nix/profiles/appliance.nix); VM tests opt in.
      '';
    };
    tools = mkOption {
      type = types.package;
      default = set.tools;
      defaultText = lib.literalExpression "(nix/packages/agent-tools).tools";
      description = "WHOMBAT_AGENT_TOOLS: the agent's tools (OP-13); its bin/ is first on every command's PATH.";
    };
    libraries = mkOption {
      type = types.package;
      default = set.libraries;
      defaultText = lib.literalExpression "(nix/packages/agent-tools).libraries";
      description = "WHOMBAT_AGENT_NIX_LD_LIBRARY_PATH (its lib/): what programs not built for Nix link against.";
    };
    agentBrowser = mkOption {
      type = types.package;
      default = config.whombat.hermes.package.passthru.agentBrowser;
      defaultText = lib.literalExpression "config.whombat.hermes.package.passthru.agentBrowser";
      description = "agent-browser for the tools: the release Whombat pins beside its Hermes plugin.";
    };
    home = mkOption {
      type = types.str;
      default = home;
      readOnly = true;
      description = "WHOMBAT_AGENT_HOME: the agent's home, the commands' $HOME (I-3).";
    };
    deny = mkOption {
      type = types.listOf types.str;
      default = [ ];
      example = [ "203.0.113.0/24" ];
      description = ''
        More public IPv4 addresses or networks the agent's commands and containers may never reach
        (WHOMBAT_AGENT_NET_DENY of the commands' proxy; the egress table refuses them too).
      '';
    };
    approvalWaitMinutes = mkOption {
      type = types.ints.between 1 120;
      default = 15;
      description = ''
        WHOMBAT_COMMANDS_APPROVAL_WAIT_MINUTES of the runner and the server: how long a command that asks first waits
        for the person's yes (the runtime's default).
      '';
    };
    netSocket = mkOption {
      type = types.str;
      default = netSocket;
      readOnly = true;
      description = "The commands' proxy's socket (WHOMBAT_AGENT_NET_SOCKET of the daemon and the runner).";
    };
    servicesMark = mkOption {
      type = types.str;
      default = servicesMark;
      readOnly = true;
      internal = true;
      description = "The conntrack mark of the commands' connections to the agent's own published services.";
    };
    netEnvironment = mkOption {
      type = types.attrsOf types.str;
      readOnly = true;
      internal = true;
      description = "The commands' network daemon's environment (the flake checks read it).";
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = lib.all isV4Cidr cfg.deny;
        message = "whombat.agent.deny: IPv4 addresses or networks only (a.b.c.d or a.b.c.d/n).";
      }
    ];

    # ---- The agent's home (I-3, NX-465) ----------------------------------------------------------------------------
    # A subvolume in Whombat's qgroup (1/100), snapshotted by the backup with the others (the `agent` source).
    whombat.storage.extraSubvolumes = [ "whombat/agent/home" ];
    systemd.tmpfiles.settings."20-whombat-agent" = {
      "${p}/whombat/agent".d = {
        mode = "0755";
        user = "root";
        group = "root";
      };
      # The runner's, writable for the engine's group (its containers' bind mounts); new files keep the group.
      ${home} = {
        d = {
          mode = "2770";
          user = "whombat-runner";
          group = if containers.enable then "whombat-containers" else "whombat-runner";
        };
      }
      // lib.optionalAttrs containers.enable {
        # What a container makes (as the engine's ids) stays writable for the runner, and what a command makes for the
        # containers: default ACLs, inherited by everything made in the home.
        "a+".argument = lib.concatStringsSep "," [
          "user:whombat-runner:rwx"
          "group:whombat-containers:rwx"
          "default:user:whombat-runner:rwx"
          "default:group:whombat-containers:rwx"
          "default:mask::rwx"
        ];
      };
      # The commands' proxy's socket (I-4): the runner traverses it (group).
      ${netDir}.d = {
        mode = "0750";
        user = netUser;
        group = netUser;
      };
    };

    # ---- The runner (I-1, I-3, I-4) --------------------------------------------------------------------------------
    systemd.services.whombat-runner = {
      environment = {
        WHOMBAT_AGENT_TOOLS = "${cfg.tools}";
        WHOMBAT_AGENT_NIX_LD = set.loader;
        WHOMBAT_AGENT_NIX_LD_LIBRARY_PATH = "${cfg.libraries}/lib";
        WHOMBAT_AGENT_HOME = home;
        WHOMBAT_AGENT_NET_SOCKET = netSocket;
        WHOMBAT_COMMANDS_APPROVAL_WAIT_MINUTES = toString cfg.approvalWaitMinutes;
        # The commands join their network namespace with nsenter (I-4).
        WHOMBAT_SANDBOX_NSENTER = "${pkgs.util-linux}/bin/nsenter";
      };
      serviceConfig = {
        SupplementaryGroups = [ netUser ];
        ReadWritePaths = [ home ];
      };
    };

    systemd.services.whombat-server.environment.WHOMBAT_COMMANDS_APPROVAL_WAIT_MINUTES = toString cfg.approvalWaitMinutes;

    # ---- The commands' network daemon (I-4, NX-456) ----------------------------------------------------------------
    users.users.${netUser} = {
      isSystemUser = true;
      uid = ids.whombat-agent-net;
      group = netUser;
      home = "/var/empty";
      createHome = false;
      shell = "/run/current-system/sw/bin/nologin";
    };
    users.groups.${netUser}.gid = ids.whombat-agent-net;
    users.users.whombat-runner.extraGroups = [ netUser ];

    whombat.agent.netEnvironment = {
      WHOMBAT_AGENT_NET_SOCKET = netSocket;
      # More public networks the proxy refuses (the egress table refuses them too).
      WHOMBAT_AGENT_NET_DENY = lib.concatStringsSep "," cfg.deny;
      # The agent's own services on this host, which the proxy may open on 127.0.0.1 (containers.nix).
      WHOMBAT_AGENT_NET_SERVICE_PORTS = publish;
      HOME = "/var/empty";
      NODE_ENV = "production";
      LANG = "C.UTF-8";
    };

    # MemoryMin (MP-02, NX-142): a small Node service, as computerd was.
    whombat.slices.critical.units.whombat-agent-net = lib.mkDefault 64;
    systemd.services.whombat-agent-net = {
      description = "The network of the agent's commands (Whombat OP-07)";
      wantedBy = [ "whombat-runtime.target" ];
      partOf = [ "whombat-runtime.target" ];
      before = [ "whombat-runner.service" ];
      after = [
        "nftables.service"
        "whombat-persist.target"
        "whombat-runtime-profile-init.service"
      ];
      unitConfig = {
        # Nothing of the runtime's before provisioning; a runtime bundle without the daemon leaves the unit skipped.
        ConditionPathExists = [
          "${p}/identity/device.json"
          netEntry
        ];
        StartLimitIntervalSec = 0;
      };
      environment = cfg.netEnvironment;
      serviceConfig = {
        Type = "exec";
        ExecStart = netEntry;
        User = netUser;
        Group = netUser;
        # Core (MP-02, NX-142), as the runner whose commands it carries.
        Slice = "whombat-critical.slice";
        OOMScoreAdjust = -900;
        Restart = "always";
        RestartSec = "1s";
        RestartSteps = 6;
        RestartMaxDelaySec = "30s";
        TimeoutStopSec = "15s";
        KillMode = "mixed";
        ReadWritePaths = [ netDir ];
        UMask = "0007";
        # It reads nothing: of /persist nothing at all, none of Whombat's sockets.
        InaccessiblePaths = [
          "-${p}"
          "-/run/postgresql"
          "-/run/whombat"
          "-/run/whombat-manager"
          "-/run/whombat-backup"
          "-/run/whombat-update-helper"
          "-/run/whombat-vault"
          "-/run/whombat-clients"
          "-/run/whombat-containers"
          "-/run/whombat-runner"
          "-/var/lib/whombat-runner"
        ];
        CapabilityBoundingSet = "";
        AmbientCapabilities = "";
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
        RestrictNamespaces = true;
        SystemCallArchitectures = "native";
        SystemCallFilter = [
          "@system-service"
          "~@privileged @resources"
        ];
        # Node's JIT.
        MemoryDenyWriteExecute = false;
        LimitCORE = 0;
        # Its wall is the egress table's (agent_wall). Netlink only to read this box's own addresses
        # (getifaddrs, Node's os.networkInterfaces), which the proxy refuses as destinations; without it the daemon
        # exits at start and the agent's commands have no network.
        RestrictAddressFamilies = [
          "AF_UNIX"
          "AF_INET"
          "AF_INET6"
          "AF_NETLINK"
        ];
      };
    };

    # ---- The wall (NX-460): the computers' computers_out, for the commands' proxy and the containers ----------------
    networking.nftables.tables.whombat-egress.content = lib.mkAfter ''
      # ---- The agent's commands (Whombat OP-07; NX-460): their proxy's connections. ---------------------------------
      set agent_deny4 { type ipv4_addr; flags interval; ${
        lib.optionalString (cfg.deny != [ ]) "elements = { ${lib.concatStringsSep ", " cfg.deny} }"
      } }

      chain agent_net_out {
        ct mark ${vaultMark} jump vault_established
        ct state established,related accept
        oifname "lo" ip daddr { 127.0.0.53, 127.0.0.54 } meta l4proto { tcp, udp } th dport 53 accept comment "commands: the resolver stub"
        oifname "lo" ip daddr 127.0.0.1 tcp dport ${publish} ct state new ct mark set ${servicesMark} accept comment "commands: the agent's own services"
        oifname "lo" counter reject with icmpx admin-prohibited comment "commands: nothing else on this host"
        goto agent_wall
      }

      # What the agent's commands (through their proxy) and its containers reach: the computers' wall (NX-131,
      # NX-137, NX-144) in the host's output path. Answers and this host are their own chains'.
      chain agent_wall {
        ip daddr . tcp dport @vault4 ct mark set ${vaultMark} accept comment "Vault home networks (agent)"
        ip6 daddr . tcp dport @vault6 ct mark set ${vaultMark} accept comment "Vault home networks (agent)"
        ip daddr @agent_deny4 counter reject with icmpx admin-prohibited comment "agent: whombat.agent.deny"
        tcp dport 25 counter reject with tcp reset comment "agent: no SMTP"
        ip daddr @local4 ip daddr != 100.100.100.200 meta l4proto { tcp, udp, icmp } counter accept comment "agent: the local network (Whombat LN-05, LN-06)"
        ip6 daddr @local6 ip6 daddr != fd00:ec2::254 meta l4proto { tcp, udp, ipv6-icmp } counter accept comment "agent: the local network (Whombat LN-05, LN-06)"
        ip daddr @nonpublic4 counter reject with icmpx admin-prohibited comment "agent: not a public address"
        ip6 daddr != 2000::/3 counter reject with icmpx admin-prohibited comment "agent: not a public address"
        ip6 daddr @nonpublic6 counter reject with icmpx admin-prohibited comment "agent: not a public address"
        meta l4proto { tcp, udp, icmp, ipv6-icmp } accept comment "agent: the public internet"
        counter reject with icmpx admin-prohibited comment "agent: not TCP, UDP or ICMP"
      }
    '';
    whombat.network.uidChains = [
      {
        uid = ids.whombat-agent-net;
        chain = "agent_net_out";
      }
    ];
  };
}
