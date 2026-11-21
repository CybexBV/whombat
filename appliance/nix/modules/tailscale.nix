# Tailscale on the box (Whombat HE-51; NX-440, NX-441): tailscaled runs on every image, signed out, until an owner signs
# the box in from Settings → This Whombat with Tailscale's own login link. Nothing is baked in: no auth key, no login at
# boot, no tailnet.
#
# - State on /persist (`/persist/tailscale`, root 0700, bound on tailscaled's own /var/lib/tailscale): the box's node key,
#   its prefs and its certificates for the Tailscale name. Not in backups: a replacement box signs in as itself.
# - Its local API (`/run/tailscale/tailscaled.sock`) is reachable by root and by `operator` only (the socket's directory
#   is 0750 root:<operator's group>, the group set after tailscaled started). The operator, the manager, is tailscaled's
#   only non-root user with write access (`tailscale set --operator`, applied at every start) and its only caller: it
#   drives Tailscale for the runtime (contracts 1.0.0 `MANAGER_PATHS.tailscale*`, CT-1255: state, on, off, sign-in) and
#   hands the runtime the certificate for the box's Tailscale name for the direct listener's HTTPS. The runtime never
#   reaches tailscaled.
# - Off in tailscaled itself, whatever the operator asks: Tailscale SSH (`TS_DISABLE_SSH_SERVER`: no way into the box
#   through the tailnet), Taildrop, and log uploads to Tailscale (`TS_NO_LOGS_NO_SUPPORT`).
# - Network (network.nix): its WireGuard and STUN traffic leaves from `port` (UDP, root), its control and DERP over TCP
#   443 like everything else; nothing of it inbound (NAT traversal answers come back as established traffic). On
#   `tailscale0` the firewall opens only the direct port (NX-440).
# - Routes (NX-487): the box's own networks come before the tailnet's. Tailscale keeps its routes in table 52, which
#   Linux asks before the main table; a device advertising the box's own LAN (a subnet router at home) would otherwise
#   take its local traffic, and the answers to the LAN's devices, into the tailnet.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.whombat.tailscale;
  inherit (lib) mkOption types;
  p = config.whombat.persistDir;
  stateDir = "${p}/tailscale";
  operatorGroup = config.users.users.${cfg.operator}.group;
  tailscale = config.services.tailscale.package;
  # `tailscale set --operator` once the local API answers (tailscaled is Type=notify; a few tries for a slow start).
  setOperator = pkgs.writeShellScript "whombat-tailscale-operator" ''
    set -u
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      if ${tailscale}/bin/tailscale --socket=${cfg.socket} set --operator=${cfg.operator}; then exit 0; fi
      ${pkgs.coreutils}/bin/sleep 1
    done
    echo "tailscale: couldn't make ${cfg.operator} the operator" >&2
    exit 1
  '';
  # The main table first, without its default routes (NX-487): a route of a network the box is on (its LAN, the
  # agents' bridges) wins over Tailscale's table 52 (rule 5270); anything else goes on to the tailnet's routes and then
  # to the default route. The same rule for IPv4 and IPv6, set again whole each time.
  ownNetworksFirst = pkgs.writeShellScript "whombat-own-networks-first" ''
    set -eu
    for family in -4 -6; do
      while ${pkgs.iproute2}/bin/ip "$family" rule del priority ${toString ownNetworksPriority} 2>/dev/null; do :; done
      ${pkgs.iproute2}/bin/ip "$family" rule add priority ${toString ownNetworksPriority} lookup main suppress_prefixlength 0
    done
  '';
  # Before Tailscale's own rules (5210…5270).
  ownNetworksPriority = 5200;
in
{
  options.whombat.tailscale = {
    enable = mkOption {
      type = types.bool;
      default = true;
      description = ''
        tailscaled on the box (Whombat HE-51, NX-440): running and signed out until an owner signs it in from Settings →
        This Whombat. The firewall opens the direct port on `tailscale0` (whombat.network.directPort).
      '';
    };
    operator = mkOption {
      type = types.str;
      default = "whombat-manager";
      description = ''
        The one non-root user that operates tailscaled (its local API with write access: state, on, off, sign-in,
        sign-out, and the certificate for the box's Tailscale name): the manager (contracts CT-1255, NX-441), which the
        runtime asks through its socket. Nobody else on the box reaches tailscaled's socket.
      '';
    };
    port = mkOption {
      type = types.port;
      default = 41641;
      description = "tailscaled's UDP port (WireGuard and STUN); egress from it is allowed for root (network.nix).";
    };
    socket = mkOption {
      type = types.str;
      default = "/run/tailscale/tailscaled.sock";
      readOnly = true;
      description = "tailscaled's local API (the upstream unit's path).";
    };
    interface = mkOption {
      type = types.str;
      default = "tailscale0";
      readOnly = true;
      description = "Tailscale's network interface; the firewall opens the direct port on it (NX-440).";
    };
  };

  config = lib.mkIf cfg.enable {
    services.tailscale = {
      enable = true;
      inherit (cfg) port;
      interfaceName = cfg.interface;
      disableTaildrop = true;
      disableUpstreamLogging = true;
      # No authKeyFile, no extraUpFlags/extraSetFlags: the image never signs in (HE-51).
    };

    # The box's own networks before the tailnet's routes (NX-487), from before tailscaled starts and for as long as the
    # box runs: networkd leaves routing rules it didn't make alone (by default it removes them when it starts again, this
    # one and Tailscale's own).
    systemd.network.config.networkConfig.ManageForeignRoutingPolicyRules = false;
    systemd.services.whombat-own-networks-first = {
      description = "The box's own networks before the tailnet's routes";
      wantedBy = [ "multi-user.target" ];
      wants = [ "network-pre.target" ];
      after = [ "network-pre.target" ];
      before = [
        "network.target"
        "tailscaled.service"
      ];
      unitConfig.DefaultDependencies = false;
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
        ExecStart = "${ownNetworksFirst}";
      };
    };

    systemd.tmpfiles.settings."10-whombat-tailscale"."${stateDir}".d = {
      mode = "0700";
      user = "root";
      group = "root";
    };

    # The operator after a sign-out (NX-444): tailscaled's logout deletes the profile, and the empty one it starts has no
    # operator, so the manager could change nothing more (every write 403) until tailscaled restarted. Every write of the
    # state file (a sign-out among them; prefs changes and key renewals otherwise, rare) sets it again, as root.
    systemd.paths.whombat-tailscale-operator = {
      description = "Watch tailscaled's state for a lost operator";
      wantedBy = [ "multi-user.target" ];
      after = [ "whombat-persist.target" ];
      pathConfig = {
        PathChanged = "${stateDir}/tailscaled.state";
        Unit = "whombat-tailscale-operator.service";
      };
    };
    systemd.services.whombat-tailscale-operator = {
      description = "Make the manager tailscaled's operator again";
      after = [ "tailscaled.service" ];
      requisite = [ "tailscaled.service" ];
      serviceConfig = {
        Type = "oneshot";
        ExecStart = "${setOperator}";
      };
    };

    systemd.services.tailscaled = {
      requires = [ "whombat-persist.target" ];
      after = [ "whombat-persist.target" ];
      unitConfig.RequiresMountsFor = [ stateDir ];
      serviceConfig = {
        Environment = [
          "TS_DISABLE_SSH_SERVER=1"
          # UPnP, NAT-PMP and PCP towards the router: the egress wall refuses them anyway (NAT traversal and DERP suffice).
          "TS_DISABLE_PORTMAPPER=1"
          # The appliance's firewall is nftables only (network.nix); its rules decide what reaches the box either way.
          "TS_DEBUG_FIREWALL_MODE=nftables"
        ];
        # The upstream unit's --state=/var/lib/tailscale/tailscaled.state, on /persist.
        BindPaths = [ "${stateDir}:/var/lib/tailscale" ];
        RuntimeDirectoryMode = lib.mkForce "0750";
        # The operator's group gets into the socket's directory last: systemd sets a RuntimeDirectory's owner (root:root,
        # the unit has no User=) again before every command it starts, so a chgrp before ExecStart, or before another
        # ExecStartPost, is undone. Until it runs only root gets in.
        ExecStartPost = [
          "-${setOperator}"
          "${pkgs.coreutils}/bin/chgrp ${operatorGroup} /run/tailscale"
        ];
      };
    };
  };
}
