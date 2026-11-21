# The kernel (NX-340; Whombat hardware-support.md HD-12; supersedes NX-256): nixpkgs' newest stable kernel
# (`linuxPackages_latest`, 7.2 at c508844), not its LTS, on every image that boots a machine: the appliance (every
# platform), the installer and the recovery environment. Each nixpkgs bump moves it to the newest stable release, as
# it moved the LTS's point releases before. New machines need the newest drivers (Wi-Fi, Bluetooth, graphics, sound,
# network cards); a box updates every few weeks anyway, and boot counting brings back the previous generation when a
# new kernel doesn't boot.
{ pkgs, ... }:
{
  boot.kernelPackages = pkgs.linuxPackages_latest;
}
