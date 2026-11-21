# Defaults for every test node.
{ lib, ... }:
{
  virtualisation.memorySize = lib.mkDefault 2048;
  virtualisation.cores = lib.mkDefault 2;
  # Don't read the host's /etc/qemu/qemu.conf when the driver runs outside the Nix sandbox.
  virtualisation.qemu.options = [ "-no-user-config" ];
  # VM tests never depend on or reach the Internet: no time servers (chrony runs without sources).
  services.chrony.servers = lib.mkForce [ ];
  services.timesyncd.enable = lib.mkForce false;
}
