# Shared by the installed appliance and installer ISO. FallbackDNS handles a
# missing resolver; the timer also covers an advertised resolver that times out.
#
# `whombat.network.ownDomains` lives here, not in network.nix: the cable's network (network.nix) and Wi-Fi's (wifi.nix,
# which the installer imports without network.nix) both ask for them, and the fallback must know them on either (NX-509).
{
  config,
  lib,
  pkgs,
  ...
}:
{
  options.whombat.network.ownDomains = lib.mkOption {
    type = lib.types.listOf lib.types.str;
    default = [ "whombat.com" ];
    description = ''
      The domains of the services the box lives by (control, the relay, its updates), asked of the local network's
      resolvers on the cable and Wi-Fi even when another link takes every other lookup, as Tailscale does on a tailnet
      that overrides local DNS (NX-488): the box can still be reached and updated if the tailnet's resolver fails.
    '';
  };

  config.services.resolved = {
    enable = true;
    settings.Resolve = {
      LLMNR = false;
      MulticastDNS = false;
      FallbackDNS = "8.8.8.8 8.8.4.4 2001:4860:4860::8888 2001:4860:4860::8844";
    };
  };
  # The backup resolvers still go on a link whose only domains are the box's own (NX-488).
  config.systemd.services.whombat-dns-fallback = {
    description = "Keep backup DNS behind the network's resolvers";
    environment.WHOMBAT_OWN_DNS_DOMAINS = lib.concatStringsSep " " config.whombat.network.ownDomains;
    after = [
      "systemd-resolved.service"
      "systemd-networkd.service"
    ];
    wants = [ "systemd-resolved.service" ];
    serviceConfig = {
      Type = "oneshot";
      RuntimeDirectory = "whombat-dns-fallback";
      RuntimeDirectoryMode = "0700";
      RuntimeDirectoryPreserve = "yes";
      ExecStart = "${pkgs.whombat-dns-fallback}/bin/whombat-dns-fallback";
      TimeoutStartSec = 15;
      NoNewPrivileges = true;
      ProtectSystem = "strict";
      ProtectHome = true;
      PrivateTmp = true;
      PrivateDevices = true;
      ProtectKernelTunables = true;
      ProtectKernelModules = true;
      ProtectControlGroups = true;
      RestrictAddressFamilies = [
        "AF_UNIX"
        "AF_NETLINK"
      ];
      CapabilityBoundingSet = [ "CAP_NET_ADMIN" ]; # networkd's DNS authorization
    };
  };
  config.systemd.timers.whombat-dns-fallback = {
    wantedBy = [ "timers.target" ];
    timerConfig = {
      OnBootSec = "5s";
      OnUnitInactiveSec = "15s";
      AccuracySec = "1s";
    };
  };
}
