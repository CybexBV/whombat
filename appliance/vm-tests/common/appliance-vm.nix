# A direct-boot appliance VM for service-level tests: the real appliance modules with plain storage on
# a second virtual disk (serial "persist") and an empty third disk (serial "factory") that the test turns
# into a factory provisioning medium. Boot counting, LUKS and Secure Boot are covered by
# install-boot-luks, which boots from a real disk through UEFI.
{ serial }:
{ lib, pkgs, ... }:
{
  imports = [ ./manager-dev.nix ];
  whombat.environment = "dev";
  whombat.storage.mode = "plain";
  whombat.storage.persistReserveMiB = 256;
  whombat.boot.settleSec = 5;
  whombat.runtime.watchdogSec = 10;
  whombat.journal = {
    systemMaxUse = "32M";
    systemKeepFree = "64M";
    rateLimitBurst = 0;
  };
  whombat.slices.critical.memoryMin = "256M";
  # Service-level suites run with the text console: nothing in them reads tty1, and Chromium would take a fifth of a
  # 2 GiB VM. console-self and install-vm run the graphical console (NX-84).
  whombat.console.gui = lib.mkDefault false;
  whombat.postgres.sharedBuffers = "64MB";
  # A box has its boot partition at /boot before any service starts, and the update helper's sandbox needs it there.
  # The direct boot has none, and Lanzaboote's setup makes the folder only once the Secure Boot keys exist, which can be
  # after the first start asks the helper: the helper then fails, systemd gives up on its socket and the box can't start.
  systemd.tmpfiles.rules = [ "d /boot 0755 root root -" ];

  virtualisation.emptyDiskImages = [
    {
      size = 2048;
      driveConfig.deviceExtraOpts.serial = "persist";
    }
    {
      size = 64;
      driveConfig.deviceExtraOpts.serial = "factory";
    }
  ];
  virtualisation.fileSystems."/persist" = {
    device = "/dev/disk/by-id/virtio-persist";
    fsType = "btrfs";
    autoFormat = true;
    options = [ "user_subvol_rm_allowed" ];
  };
  virtualisation.qemu.options = [ "-smbios type=1,serial=${serial}" ];
  environment.systemPackages = with pkgs; [
    dosfstools
    mtools
    btrfs-progs
    curl
    jq
    iproute2
  ];
}
