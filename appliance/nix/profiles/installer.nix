# Installer / factory image (ISO, boots into RAM). The factory runs `whombat-install --disk ...`.
# It contains the appliance system closure and the recovery UKI; no key, identity or claim material.
{ modulesPath, lib, ... }:
{
  imports = [
    (modulesPath + "/installer/cd-dvd/installation-cd-minimal.nix")
    ./installer-base.nix
    # Wi-Fi with iwd, as on the appliance (HD-08, NX-242): the installer's Wi-Fi step joins through it, and the profile
    # iwd wrote is copied into the installed system.
    ../modules/wifi.nix
    ../modules/dns.nix
    # The appliance's kernel (NX-340): the installer finds the same disks and cards the installed box will.
    ../modules/kernel.nix
  ];
  isoImage.edition = lib.mkForce "whombat-installer";
  # The default volume id (nixos-whombat-installer-26.05-x86_64) is longer than ISO 9660's 32 characters,
  # and 26.05 asserts it: no installer ISO built before this (NX-62).
  isoImage.volumeID = lib.mkForce "WHOMBAT-INSTALLER";
  image.baseName = lib.mkOverride 60 "whombat-installer"; # the flake names each ISO (installerWith)
  services.openssh.enable = lib.mkForce false;

  # The network as on the appliance (NX-242): networkd gives a cable (route metric 100) and Wi-Fi (600, wifi.nix) their
  # addresses, iwd joins Wi-Fi. NetworkManager (the minimal ISO's default) goes: its Wi-Fi is wpa_supplicant, which the
  # installer can't share a card with, and its profiles are not the files the installed system reads. wpa_supplicant
  # itself (`networking.wireless.enable`) stays off for the same reason (the iwd module refuses both).
  networking.networkmanager.enable = lib.mkForce false;
  networking.wireless.enable = lib.mkForce false;
  networking.useNetworkd = true;
  networking.useDHCP = false;
  systemd.network.enable = true;
  # The installer doesn't wait for a network at boot; its checks wait for an address themselves (CG-13).
  systemd.network.wait-online.enable = false;
  systemd.network.networks."90-whombat-wired" = {
    matchConfig.Name = "en* eth*";
    networkConfig = {
      DHCP = "yes";
      IPv6AcceptRA = true;
      LLMNR = false;
      MulticastDNS = false;
    };
    dhcpV4Config = {
      UseDomains = false;
      RouteMetric = 100;
    };
    ipv6AcceptRAConfig.RouteMetric = 100;
  };
}
