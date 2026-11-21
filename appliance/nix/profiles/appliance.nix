# Every appliance: the host for x86_64 (aarch64 evaluated only) UEFI machines. On its own it is the `factory` platform
# (a TPM 2.0, encrypted storage, enrolled Secure Boot; the sold hardware is still to be selected, X-04), as the factory
# installer image installs it; self-installed.nix on top makes the `self-installed` platform (PI-02, PI-22). Boot
# counting on both. Environment defaults to dev: no production key exists in this work (X-05).
{
  lib,
  pkgs,
  ...
}:
{
  networking.hostName = "whombat";
  whombat.environment = lib.mkDefault "dev";
  # The agent's commands on the box and its containers (Whombat OP-04, OP-16, OP-19; NX-455): on every appliance; the
  # commands' network daemon runs where the runtime bundle has it.
  whombat.agent.enable = lib.mkDefault true;
  whombat.containers.enable = lib.mkDefault true;
  # Speech for the desk display's Talk (Whombat DK-06, NX-175): on every appliance; Talk shows only where there is a
  # microphone, and the service starts only when the runtime first asks.
  whombat.voice.enable = lib.mkDefault true;
  # Stay unlocked while you're here (Whombat DK-28, NX-280): on every appliance; the switch shows only where there is a
  # camera, and the camera is on only while the screen is unlocked with the switch on.
  whombat.presence.enable = lib.mkDefault true;
  # Remote help (Whombat RH-01, NX-411): on every appliance; nobody gets in until an owner turns it on, and only with a
  # certificate from the support CA the image pins (none: “isn't available on this Whombat yet”).
  whombat.support.enable = lib.mkDefault true;

  boot.initrd.availableKernelModules = [
    "nvme"
    # NVMe behind Intel VMD (Intel RST on by default on many recent desktops and NUCs): without it in the initrd
    # the installer sees the disk (udev loads vmd later) but the installed system can't find its root (NX-92).
    "vmd"
    "ahci"
    "xhci_pci"
    "usb_storage"
    "uas"
    "sd_mod"
    # eMMC on small boards (the installer's disk list shows mmcblk0).
    "sdhci_pci"
    "sdhci_acpi"
    "mmc_block"
    "virtio_pci"
    "virtio_blk"
    "virtio_scsi"
    # Servers' disk controllers (NX-341): the installer finds disks behind them (its udev loads any module), so the
    # installed system's initrd must have them too. LSI/Broadcom SAS HBAs and tri-mode HBAs, MegaRAID (Dell PERC),
    # HPE Smart Array, Adaptec; UFS on some small x86 machines; the virtual disks of VMware, Hyper-V and Xen.
    "mpt3sas"
    "mpi3mr"
    "megaraid_sas"
    "smartpqi"
    "aacraid"
    "ufshcd-pci"
    "vmw_pvscsi"
    "hv_storvsc"
    "xen-blkfront"
  ];
  # And everything in nixpkgs' list for “most hardware”, the one the installer's ISO boots with (older SATA and PATA
  # controllers, hpsa, mptspi, …; NX-341).
  hardware.enableAllHardware = true;
  hardware.cpu.intel.updateMicrocode = pkgs.stdenv.hostPlatform.isx86_64;
  hardware.cpu.amd.updateMicrocode = pkgs.stdenv.hostPlatform.isx86_64;
  # Redistributable firmware (NICs, microcode) is the only non-free software allowed.
  hardware.enableRedistributableFirmware = true;
  nixpkgs.config.allowUnfree = false;
  nixpkgs.config.allowUnfreePredicate =
    pkg:
    builtins.elem (lib.getName pkg) [
      "linux-firmware"
      "microcode-intel"
      "intel-ucode"
      "amd-ucode"
      "microcode-amd"
    ];
}
