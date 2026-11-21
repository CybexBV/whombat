# Development disk image (raw, converted to qcow2 by the flake): ESP + root + persist, all plain
# (unencrypted: whombat.storage.mode = "plain", refused for prod). Boots with UEFI firmware; the first
# boot generates per-device Secure Boot keys and prepares enrolment exactly like a factory device.
# For trying the host in QEMU:  qemu-system-x86_64 -enable-kvm -m 4G -bios OVMF.fd -drive file=…qcow2
{
  config,
  lib,
  pkgs,
  modulesPath,
  ...
}:
let
  cfg = config.boot.lanzaboote;
  closure = pkgs.closureInfo { rootPaths = [ config.system.build.toplevel ]; };
  nixState = pkgs.runCommand "whombat-dev-nix-state" { nativeBuildInputs = [ pkgs.buildPackages.nix ]; } ''
    mkdir -p $out/profiles
    ln -s ${config.system.build.toplevel} $out/profiles/system-1-link
    ln -s system-1-link $out/profiles/system
    export NIX_STATE_DIR=$out
    nix-store --load-db < ${closure}/registration
  '';
  # lzbt without keys (allowUnsigned): the device signs everything once it generated its keys.
  espFiles = pkgs.runCommand "whombat-dev-esp" { } ''
    mkdir -p $out
    ln -s ${config.system.build.toplevel} system-1-link
    ${cfg.installCommand} \
      --public-key /nonexistent/db.pem --private-key /nonexistent/db.key \
      $out system-1-link
    # Factory generation: blessed (no boot counter).
    for f in $out/EFI/Linux/nixos-*+*.efi; do [ -e "$f" ] && mv "$f" "''${f%%+*}.efi"; done
    rm -f $out/loader/random-seed
  '';
in
{
  imports = [ "${modulesPath}/image/repart.nix" ];

  whombat.storage.mode = "plain";
  boot.lanzaboote.allowUnsigned = true;

  fileSystems = {
    "/" = {
      device = "/dev/disk/by-partlabel/whombat-root";
      fsType = "ext4";
    };
    "/persist" = {
      device = "/dev/disk/by-partlabel/whombat-persist";
      fsType = "btrfs";
      options = [
        "nosuid"
        "nodev"
      ];
      neededForBoot = true;
    };
    "/boot" = {
      device = "/dev/disk/by-partlabel/whombat-esp";
      fsType = "vfat";
      options = [ "umask=0077" ];
    };
  };
  boot.growPartition = false;

  image.repart = {
    name = "whombat-dev";
    partitions = {
      "10-esp" = {
        contents."/".source = espFiles;
        repartConfig = {
          Type = "esp";
          Format = "vfat";
          Label = "whombat-esp";
          SizeMinBytes = "512M";
        };
      };
      "20-root" = {
        storePaths = [ config.system.build.toplevel ];
        contents."/nix/var/nix".source = nixState;
        repartConfig = {
          Type = "root";
          Format = "ext4";
          Label = "whombat-root";
          Minimize = "guess";
          SizeMinBytes = "4G";
        };
      };
      "30-persist" = {
        repartConfig = {
          Type = "linux-generic";
          Format = "btrfs";
          Label = "whombat-persist";
          SizeMinBytes = "2G";
          SizeMaxBytes = "2G";
        };
      };
    };
  };
}
