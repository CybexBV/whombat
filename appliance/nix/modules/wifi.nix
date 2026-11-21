# Wi-Fi (NX-240…NX-243; Whombat hardware-support.md HD-05): iwd joins networks and networkd configures every `wl*`
# interface the way it does a cable (DHCP and IPv6 router advertisements), with a higher route metric (600; the cable's
# is 100, network.nix), so a cable is used when both work. iwd's own network configuration stays off: networkd does the
# addresses, as it does for the cable and for the helper's candidates. Saved networks are iwd's own state
# (/var/lib/iwd, root only, not in backups); on the appliance only the update helper joins and forgets them, for the
# manager (MG-100…). The installer ISO imports this module too (installer.nix, HD-08), so a network joined there is
# the same file in the installed system.
#
# `networking.wireless.enable` stays false everywhere: it is NixOS's wpa_supplicant, which the iwd module refuses next
# to iwd (one daemon per card), and which would need NetworkManager or its own configuration file to be told networks.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.whombat.wifi;
in
{
  # whombat.network.ownDomains, which the Wi-Fi network asks for (below): the installer imports this module without
  # network.nix (NX-509).
  imports = [ ./dns.nix ];

  options.whombat.wifi = {
    enable = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = ''
        Wi-Fi with iwd: `wl*` interfaces get DHCP and IPv6 like a cable, at route metric `routeMetric`. Off: no iwd,
        and the helper answers every Wi-Fi operation with `no_wifi` (the box's screen and the app then show no Wi-Fi).
      '';
    };
    routeMetric = lib.mkOption {
      type = lib.types.ints.between 1 4294967295;
      default = 600;
      description = "Route metric of Wi-Fi's routes (the cable's is 100: a cable wins when both work).";
    };
  };

  config = lib.mkIf cfg.enable {
    networking.wireless.iwd = {
      enable = true;
      settings = {
        # networkd does the addresses (the `wl*` network below); iwd only joins.
        General.EnableNetworkConfiguration = false;
        Settings.AutoConnect = true;
        # No Wi-Fi power saving on any card (NX-342): a box is always on and mostly on mains power, and power saving
        # is behind most of the drops and slow answers some drivers have (Realtek, MediaTek).
        DriverQuirks.PowerSaveDisable = "*";
      };
    };

    # USB Wi-Fi sticks that first show up as a driver CD are switched to their Wi-Fi mode (NX-342).
    hardware.usb-modeswitch.enable = true;

    # A Whombat has no airplane mode (NX-342): Wi-Fi switched off by a laptop's wireless key, and the state
    # systemd-rfkill kept of it, is switched on again at every start. A hardware switch stays as it is.
    systemd.services.whombat-wifi-on = {
      description = "Switch Wi-Fi on";
      wantedBy = [ "multi-user.target" ];
      after = [ "systemd-rfkill.service" ];
      serviceConfig = {
        Type = "oneshot";
        ExecStart = "${pkgs.util-linux}/bin/rfkill unblock wlan";
        NoNewPrivileges = true;
        ProtectSystem = "strict";
        ProtectHome = true;
        PrivateTmp = true;
        DevicePolicy = "closed";
        DeviceAllow = [ "/dev/rfkill rw" ];
      };
    };

    systemd.network.networks."91-whombat-wifi" = {
      matchConfig.Name = "wl*";
      networkConfig = {
        DHCP = "yes";
        IPv6AcceptRA = true;
        LLMNR = false;
        MulticastDNS = false;
        # A roam between access points of one network drops the carrier for a moment: keep the addresses (iwd's
        # advice for networkd).
        IgnoreCarrierLoss = "3s";
        DNSDefaultRoute = true;
      };
      # The box's own services by this network's resolvers, as on the cable (network.nix, NX-488).
      domains = map (d: "~${d}") config.whombat.network.ownDomains;
      dhcpV4Config = {
        UseDomains = false;
        RouteMetric = cfg.routeMetric;
      };
      ipv6AcceptRAConfig.RouteMetric = cfg.routeMetric;
    };
  };
}
