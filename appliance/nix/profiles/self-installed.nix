# The `self-installed` platform (PI-02, PI-09, PI-18, PI-21, PI-22; NX-50…NX-52, NX-92): a Whombat installed from the
# ISO on a dedicated x86_64 UEFI machine (bare metal, the main target) or in a VM on any KVM hypervisor (Proxmox VE,
# Incus, libvirt, …), from the same image. Imported on top of appliance.nix, which has the machines' disk controllers,
# firmware and watchdogs. Storage is host-encrypted (no LUKS), the Secure Boot keys are generated but not enrolled,
# and self-provisioning needs no Secure Boot. On a machine the VM's devices are simply absent: the guest agent starts
# only when its virtio port appears (udev). Runbook: docs/runbooks/install.md.
{ config, lib, ... }:
let
  # The guest agent may only do what a hypervisor needs for a clean shutdown, consistent backups and showing the
  # VM's addresses (PI-09). Allow-list, not a block-list: guest-exec, file access, user and password RPCs
  # and anything a newer QEMU adds stay closed (NX-52).
  allowedRpcs = [
    "guest-sync-delimited"
    "guest-sync"
    "guest-ping"
    "guest-info"
    "guest-shutdown"
    "guest-fsfreeze-status"
    "guest-fsfreeze-freeze"
    "guest-fsfreeze-freeze-list"
    "guest-fsfreeze-thaw"
    "guest-fstrim"
    "guest-get-fsinfo"
    "guest-get-osinfo"
    "guest-get-host-name"
    "guest-get-time"
    "guest-get-timezone"
    "guest-network-get-interfaces"
  ];
in
{
  whombat.platform = "self-installed";

  boot.initrd.availableKernelModules = [
    "virtio_pci"
    "virtio_scsi"
    "virtio_blk"
    "sd_mod"
    "sr_mod"
  ];

  # The QEMU guest agent on its virtio-serial port, for the host's shutdown and fs-freeze only.
  services.qemuGuest.enable = true;
  systemd.services.qemu-guest-agent.serviceConfig.ExecStart = lib.mkForce "${config.services.qemuGuest.package}/bin/qemu-ga --statedir /run/qemu-ga --allow-rpcs=${lib.concatStringsSep "," allowedRpcs}";
}
