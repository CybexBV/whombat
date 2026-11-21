# The Vault's home networks (Whombat VT-12, VT-59; IN-58…IN-61, NX-40): the egress table lets the runtime
# server's uid reach exactly the networks and ports the admins listed, updated without a reboot.
#
# The runtime writes the list to WHOMBAT_VAULT_NETWORKS_FILE (/run/whombat-vault/networks.json) at boot and after
# every change: temp file in the same directory + rename, mode 0644. /run/whombat-vault is 0755 whombat:whombat in
# root's /run: only the runtime writes there, and it can't swap the directory itself. whombat-vault-wall (a
# dynamic user with CAP_NET_ADMIN and nothing else) watches the directory, reads the file without following any
# link, validates it again and replaces the elements of the sets `vault4` and `vault6` in `inet whombat-egress` in
# one nft transaction (the sets and the rules that use them are in network.nix). A missing or invalid file, a
# stopped daemon and a fresh boot all mean empty sets.
#
# SSH from the Vault (Whombat VT-S06, VT-S14; IN-150, NX-128): whombat.vault.sshPorts is the one list of ports the
# runtime server's uid may open to public addresses (the `vault_ssh` chain in network.nix) and the runtime accepts for a
# public SSH server (WHOMBAT_VAULT_SSH_PORTS, runtime.nix). Private SSH servers go through the home-network sets.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.whombat.vaultWall;
  inherit (lib) mkOption types;
  dir = "/run/whombat-vault";
  table = "inet whombat-egress";
  wallArgs = [
    "--nft"
    "${pkgs.nftables}/bin/nft"
    "--table"
    table
    "--set4"
    "vault4"
    "--set6"
    "vault6"
  ];
in
{
  options.whombat.vaultWall = {
    package = mkOption {
      type = types.package;
      default = pkgs.whombat-vault-wall;
      defaultText = lib.literalExpression "pkgs.whombat-vault-wall";
    };
    file = mkOption {
      type = types.str;
      default = "${dir}/networks.json";
      readOnly = true;
      description = "The runtime's home-network list (WHOMBAT_VAULT_NETWORKS_FILE of the server, VT-59).";
    };
    resyncSec = mkOption {
      type = types.ints.between 1 3600;
      default = 60;
      description = ''
        Re-apply the list this often even without a change (the file is watched with inotify; this only repairs
        sets emptied by something else).
      '';
    };
  };

  options.whombat.vault.sshPorts = mkOption {
    type = types.listOf (types.ints.between 1 65535);
    default = [ 22 ];
    description = ''
      TCP ports the Vault's SSH keys may reach on public addresses (VT-S06, VT-S14): the egress rule for the runtime
      server's uid and WHOMBAT_VAULT_SSH_PORTS of the runtime are both made from this list. 1 to 16 distinct ports.
      Non-public SSH servers are reached only through the admins' home networks (VT-12), whatever this says.
    '';
  };

  config = {
    assertions =
      let
        ports = config.whombat.vault.sshPorts;
      in
      [
        {
          assertion = ports != [ ] && lib.length ports <= 16;
          message = "whombat.vault.sshPorts: list 1 to 16 ports (VT-S14).";
        }
        {
          assertion = lib.unique ports == ports;
          message = "whombat.vault.sshPorts: a port is listed twice.";
        }
      ];

    systemd.tmpfiles.settings."20-whombat-vault".${dir}.d = {
      mode = "0755";
      user = "whombat";
      group = "whombat";
    };

    systemd.services.whombat-vault-wall = {
      description = "Whombat Vault home networks in the egress firewall";
      wantedBy = [ "multi-user.target" ];
      # The sets live in nftables.service's table: start after it, restart with it (partOf) and re-apply when it
      # reloads (a reload replaces the table and empties the sets).
      requires = [ "nftables.service" ];
      after = [
        "nftables.service"
        "systemd-tmpfiles-setup.service"
      ];
      partOf = [ "nftables.service" ];
      unitConfig.ReloadPropagatedFrom = [ "nftables.service" ];
      serviceConfig = {
        Type = "notify";
        ExecStart = lib.escapeShellArgs (
          [
            "${cfg.package}/bin/whombat-vault-wall"
            "--file"
            cfg.file
            "--owner-uid"
            (toString config.whombat.ids.whombat)
            "--resync"
            "${toString cfg.resyncSec}s"
          ]
          ++ wallArgs
        );
        ExecReload = "${pkgs.coreutils}/bin/kill -HUP $MAINPID";
        # Nothing stays open without the daemon that keeps the sets equal to the list (fail closed).
        ExecStopPost =
          "-"
          + lib.escapeShellArgs (
            [
              "${cfg.package}/bin/whombat-vault-wall"
              "--flush"
            ]
            ++ wallArgs
          );
        Restart = "always";
        RestartSec = "2s";

        DynamicUser = true;
        AmbientCapabilities = [ "CAP_NET_ADMIN" ];
        CapabilityBoundingSet = [ "CAP_NET_ADMIN" ];
        NoNewPrivileges = true;
        # The host's network namespace is the point: no PrivateNetwork, no PrivateUsers.
        RestrictAddressFamilies = [
          "AF_NETLINK"
          "AF_UNIX"
        ];
        IPAddressDeny = "any";
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
        InaccessiblePaths = [ "-${config.whombat.persistDir}" ];
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
        UMask = "0077";
      };
    };
  };
}
