# Signed recovery environment (NX-13): a self-contained UKI (kernel + initrd holding the whole system
# as squashfs) installed as EFI/Linux/whombat-recovery.efi next to the normal generations and signed with
# the device's Secure Boot key. Chosen at the local console only (hold Space at power-on). No network
# unless the operator at the console enables it; every data-touching action needs the disk recovery key.
# One environment for both layouts (NX-56): with LUKS volumes (factory) the key is checked against the data
# volume; on host-encrypted storage (self-installed, PI-02) against its Argon2id hash on /persist (PI-04), and
# nothing needs to be opened. A self-installed box from an image since PI-19 has no key and no hash: its disk is
# not encrypted in the machine, so whoever is at the console can read it anyway; each action asks for a typed word
# instead (EXPORT, VERIFY, NETWORK, UPDATES; ERASE and ERASE EVERYTHING as before) (NX-91, NX-514).
{
  config,
  lib,
  pkgs,
  modulesPath,
  ...
}:
let
  pgRecovery = pkgs.postgresql_17;

  # Prints its argument without control characters (C0, DEL), at most 120 bytes (N-3).
  cleanName = pkgs.writeShellApplication {
    name = "whombat-recovery-clean";
    runtimeInputs = [ pkgs.coreutils ];
    text = ''
      printf '%s' "''${1:-}" | LC_ALL=C tr -d '\000-\037\177' | head -c 120
    '';
  };

  # The only user interface of the recovery environment (MA-21a, NX-13): a restricted menu on tty1, run by
  # systemd (no login, no shell on any console). Everything that touches a volume or writes data asks for
  # the customer's disk recovery key first and checks it against the data volume; the TPM is never used
  # here (and could not unseal: the recovery UKI is not in the device's signed PCR 11 policy).
  menu = pkgs.writeShellApplication {
    name = "whombat-recovery-menu";
    runtimeInputs = with pkgs; [
      cleanName
      coreutils
      util-linux
      cryptsetup
      systemd
      e2fsprogs
      btrfs-progs
      gawk
      gnugrep
      findutils
      whombat-appliance-tools
      whombat-manager
      whombat-provision
      whombat-recovery
      restic
      git
      iproute2
    ];
    text = ''
      trap "" INT QUIT TSTP
      persist=/dev/disk/by-partlabel/whombat-persist
      root=/dev/disk/by-partlabel/whombat-root
      key=""
      # The menu can start before the disk is probed (a slow SCSI scan took 18 s in a VM): wait up to a minute for the
      # data volume, since the storage mode below is decided once and a missing volume refused every key (NX-89).
      if [ ! -e "$persist" ]; then
        echo "Looking for this appliance's disk…"
        for _ in $(seq 120); do
          [ -e "$persist" ] && break
          sleep 0.5
        done
      fi
      # host-encrypted (self-installed): no LUKS on the disk; the data volume is the partition itself.
      host=0
      if [ -e "$persist" ] && ! cryptsetup isLuks "$persist" 2>/dev/null; then host=1; fi
      pdev=/dev/mapper/whombat-persist
      [ "$host" = 0 ] || pdev=$persist
      log() { printf '<5>whombat-recovery: %s\n' "$*" > /dev/kmsg 2>/dev/null || true; }
      pause() { printf '\nPress Enter to return to the menu. '; IFS= read -r _ || true; }
      # Anything read from an attached disk (labels, file names) is shown without control characters, so
      # a crafted name cannot rewrite the console (N-3).
      clean() { whombat-recovery-clean "$1"; }

      # host-encrypted: is the key the one whose hash is on /persist? (read-only look, nothing changes)
      host_key_ok() {
        local m=/run/whombat-recovery-check ok=1
        mkdir -p "$m"
        mount -o ro,nosuid,nodev,noexec "$persist" "$m" 2>/dev/null || return 1
        printf '%s\n' "$1" | whombat-provision recovery-key check --hash-file "$m/secrets/recovery-key.argon2id" >/dev/null 2>&1 || ok=0
        umount "$m" || umount -l "$m"
        [ "$ok" = 1 ]
      }

      # host-encrypted: does /persist hold a disk recovery key's hash (an image before PI-19)? No hash, or a data
      # volume that doesn't mount: no key to ask for (PI-19, NX-91).
      host_has_key() {
        local m=/run/whombat-recovery-check found=1
        mkdir -p "$m"
        mount -o ro,nosuid,nodev,noexec "$persist" "$m" 2>/dev/null || return 1
        [ -e "$m/secrets/recovery-key.argon2id" ] || found=0
        umount "$m" || umount -l "$m"
        [ "$found" = 1 ]
      }
      nokey=0
      if [ "$host" = 1 ] && ! host_has_key; then nokey=1; fi

      # Reads the disk recovery key without echo and checks it against the data volume (or its hash).
      ask_key() {
        key=""
        printf 'Disk recovery key: '
        IFS= read -rs k || k=""
        echo
        k=''${k%$'\r'}
        if [ -n "$k" ] && [ -e "$persist" ]; then
          if { [ "$host" = 0 ] && printf '%s' "$k" | cryptsetup open --test-passphrase --key-file=- "$persist" 2>/dev/null; } \
             || { [ "$host" = 1 ] && host_key_ok "$k"; }; then
            key=$k
            log "recovery key accepted"
            return 0
          fi
        fi
        log "recovery key refused: no volume was touched"
        echo "That key does not open this appliance's data. Nothing was changed."
        return 1
      }

      # The action's authority: the disk recovery key, or on a box without one the typed word (PI-19, NX-91).
      authorize() { # WORD
        if [ "$nokey" = 0 ]; then ask_key; return; fi
        printf 'Type %s to continue: ' "$1"
        IFS= read -r c || c=""
        if [ "$c" = "$1" ]; then log "confirmed with $1 (no disk recovery key on this appliance)"; return 0; fi
        echo "Cancelled. Nothing was changed."
        return 1
      }

      open_ro() { # device mapper-name
        [ "$host" = 0 ] || return 0 # nothing to open
        [ -e "/dev/mapper/$2" ] && return 0
        printf '%s' "$key" | cryptsetup open --readonly --key-file=- "$1" "$2"
      }

      close_all() {
        for m in /mnt/export /mnt/whombat-root /persist; do
          if mountpoint -q "$m"; then umount "$m" || umount -l "$m" || true; fi
        done
        for n in whombat-persist whombat-root; do
          if [ -e "/dev/mapper/$n" ]; then cryptsetup close "$n" || true; fi
        done
      }

      # Lets the operator pick an attached disk (never the appliance's own) and mounts it at /mnt/export.
      pick_disk() {
        appliance=$(lsblk -npo PKNAME "$persist" 2>/dev/null | head -n1)
        mapfile -t cands < <(lsblk -rnpo NAME,TYPE,FSTYPE,PKNAME | awk -v a="$appliance" \
          '($2 == "part" || $2 == "disk") && $3 ~ /^(ext4|vfat|exfat|btrfs|xfs)$/ && $1 != a && $4 != a { print $1 }')
        if [ "''${#cands[@]}" -eq 0 ]; then
          echo "No attached disk with a file system (ext4, exFAT, FAT, btrfs, XFS) was found. Attach one and try again."
          return 1
        fi
        echo "Attached disks:"
        i=1
        for d in "''${cands[@]}"; do
          printf '  %d  %s  %s  %s\n' "$i" "$(clean "$d")" "$(clean "$(lsblk -dno SIZE "$d")")" "$(clean "$(lsblk -dno LABEL "$d")")"
          i=$((i + 1))
        done
        printf 'Disk number: '
        IFS= read -r n || n=""
        case "$n" in ""|*[!0-9]*) echo "No disk chosen."; return 1 ;; esac
        if [ "$n" -lt 1 ] || [ "$n" -gt "''${#cands[@]}" ]; then echo "No disk chosen."; return 1; fi
        disk=''${cands[$((n - 1))]}
        mkdir -p /mnt/export
        mount -o nosuid,nodev,noexec "$disk" /mnt/export || { echo "Could not mount $disk."; return 1; }
        log "attached disk $(clean "$disk") mounted for the export"
      }

      do_export() {
        authorize EXPORT || return 0
        pick_disk || return 0
        printf 'Include provider logins and the master key (keep the disk private)? [y/N] '
        IFS= read -r yn || yn=""
        set --
        case "$yn" in y|Y|yes) set -- -include-secrets ;; esac
        if ! open_ro "$persist" whombat-persist; then echo "Could not open the data volume."; close_all; return 0; fi
        mkdir -p /persist
        mount -o ro,nosuid,nodev,noexec "$pdev" /persist
        stamp=$(date -u +%Y%m%dT%H%M%SZ)
        out=/mnt/export/whombat-export-$stamp
        work=/mnt/export/.whombat-export-work-$stamp
        mkdir -p "$work"
        log "export started to $disk:/whombat-export-$stamp"
        if whombat-recovery export-disk -persist /persist -out "$out" -work "$work" \
             -pg-bin ${pgRecovery}/bin -pg-user whombat-export "$@"; then
          log "export finished: $disk:/whombat-export-$stamp"
          echo "Export written to whombat-export-$stamp on $disk (see README.txt there)."
        else
          log "export failed"
          echo "The export failed; see the messages above."
        fi
        rm -rf "$work"
        sync
        close_all
      }

      do_verify() {
        authorize VERIFY || return 0
        pick_disk || return 0
        mapfile -t kits < <(find /mnt/export -maxdepth 2 -type f -name '*.json' | sort)
        if [ "''${#kits[@]}" -eq 0 ]; then echo "No recovery kit (.json) on that disk."; close_all; return 0; fi
        i=1
        for k in "''${kits[@]}"; do printf '  %d  %s\n' "$i" "$(clean "''${k#/mnt/export/}")"; i=$((i + 1)); done
        printf 'Kit number: '
        IFS= read -r n || n=""
        case "$n" in ""|*[!0-9]*) close_all; return 0 ;; esac
        if [ "$n" -lt 1 ] || [ "$n" -gt "''${#kits[@]}" ]; then close_all; return 0; fi
        log "backup verification started"
        whombat-recovery verify -kit "''${kits[$((n - 1))]}" -check-data 10% -pg-bin ${pgRecovery}/bin || true
        close_all
      }

      do_reseal() {
        if [ "$host" = 1 ]; then
          echo "This Whombat's disk is not encrypted in this machine, so nothing is sealed to a security chip. Nothing to do."
          return 0
        fi
        ask_key || return 0
        # Root first: the device's policy public key lives on the system volume.
        printf '%s' "$key" | cryptsetup open --key-file=- "$root" whombat-root || { echo "Could not open the system volume."; return 0; }
        mkdir -p /mnt/whombat-root
        mount -o ro /dev/mapper/whombat-root /mnt/whombat-root
        ok=1
        for part in root persist; do
          mapfile -t args < <(whombat-tpm-enroll-args "$part" --sysroot /mnt/whombat-root)
          printf '%s' "$key" | systemd-cryptenroll --unlock-key-file=/dev/stdin --wipe-slot=tpm2 \
            --tpm2-device=auto "''${args[@]}" "/dev/disk/by-partlabel/whombat-$part" || ok=0
        done
        umount /mnt/whombat-root
        mount /dev/mapper/whombat-root /mnt/whombat-root
        rm -f /mnt/whombat-root/var/lib/whombat-storage/tpm-seal   # the next normal boot completes the seal
        close_all
        if [ "$ok" = 1 ]; then log "TPM slots re-sealed"; echo "Re-sealed. The next boot unlocks without the recovery key."
        else echo "Re-sealing failed; the recovery key still opens both volumes."; fi
      }

      do_factory_reset() {
        if [ "$nokey" = 0 ]; then ask_key || return 0; fi
        printf 'Type ERASE to erase all appliance data: '
        IFS= read -r c || c=""
        [ "$c" = ERASE ] || { echo "Cancelled."; return 0; }
        # Without a key the erase tool takes the typed ERASE as its confirmation (whombat-host-erase).
        [ "$nokey" = 0 ] || key=ERASE
        mkdir -p /mnt/whombat-root
        if [ "$host" = 1 ]; then
          mount "$root" /mnt/whombat-root || { echo "Could not mount the system volume."; return 0; }
        else
          printf '%s' "$key" | cryptsetup open --key-file=- "$root" whombat-root || { echo "Could not open the system volume."; return 0; }
          mount /dev/mapper/whombat-root /mnt/whombat-root
        fi
        log "factory reset started"
        if printf '%s\n' "$key" | whombat-factory-reset; then
          log "factory reset finished"
        else
          log "factory reset failed"
          echo "Factory reset failed."
        fi
        close_all
      }

      do_secure_erase() {
        if [ "$nokey" = 0 ]; then ask_key || return 0; fi
        printf 'Type ERASE EVERYTHING to destroy all data and the system (reinstall needed): '
        IFS= read -r c || c=""
        [ "$c" = "ERASE EVERYTHING" ] || { echo "Cancelled."; return 0; }
        [ "$nokey" = 0 ] || key=ERASE
        log "secure erase started"
        printf '%s\n' "$key" | whombat-secure-erase --all || echo "Secure erase failed."
      }

      # Opens the data volume read-write on /persist for a change, after authorize; on failure it says so and nothing
      # was changed.
      mount_rw() {
        close_all
        if [ "$host" = 0 ] && ! printf '%s' "$key" | cryptsetup open --key-file=- "$persist" whombat-persist; then
          echo "Could not open the data volume. Nothing was changed."
          return 1
        fi
        mkdir -p /persist
        if ! mount -o nosuid,nodev,noexec "$pdev" /persist; then
          echo "Could not mount the data volume. Nothing was changed."
          close_all
          return 1
        fi
      }

      # "Ask before updating" off (the owner's switch, Whombat ask-before-updating.md, MG-160): the way out at the box
      # when the apps can't take the owner's yes, for example after a release that broke them while its fix waits. No
      # manager runs here, so the journal on the data volume is changed directly; the update that waited goes ahead
      # by itself once the box runs again.
      do_ask_off() {
        authorize UPDATES || return 0
        mount_rw || return 0
        if whombat-manager ask-off --journal /persist/manager/journal; then
          log "ask before updating turned off"
          echo "Choose 9 to restart."
        else
          log "ask before updating: turning it off failed"
          echo "Turning it off failed; see the message above."
        fi
        sync
        close_all
      }

      # How this Whombat is reached (Whombat LNK-12, LNK-15): the way back in at the box when Link has ended or
      # Tailscale is off and the apps can't reach it. The choice goes into a root-owned file on the data volume that the
      # manager acts on at its next start, so unlike ask-off nothing here needs to know whether a manager runs.
      reach_change() { # link|tailscale|tailscale-on WORD
        authorize "$2" || return 0
        mount_rw || return 0
        # A box installed before the choice existed may not have the folder yet.
        [ -d /persist/whombat ] || install -d -m 0755 /persist/whombat
        if whombat-manager reach "$1" --file /persist/whombat/reach.json; then
          log "reach: $1 chosen"
          echo "Choose 9 to restart."
        else
          log "reach: $1 failed"
          echo "The change failed; see the message above."
        fi
        sync
        close_all
      }

      do_reach() {
        cat <<'EOF'

          1  Whombat Link
          2  Tailscale
          Enter  Back to the menu
      EOF
        printf 'Choice: '
        IFS= read -r c || c=""
        case "$c" in
          1) reach_change link LINK ;;
          2) reach_change tailscale TAILSCALE ;;
          *) echo "Nothing was changed." ;;
        esac
      }

      log "menu started"
      while :; do
        key=""
        printf '\033c'
        printf '\n        Whombat Recovery\n\n'
        if [ "$nokey" = 1 ]; then
          printf '        This Whombat has no disk recovery key: actions 1-7, 11 and 12 ask you to type a word to confirm.\n'
        else
          printf "        Every action except 8-10 asks for this Whombat's disk recovery key.\n"
        fi
        cat <<'EOF'

          1  Export this appliance's data to an attached disk
          2  Verify a backup (recovery kit on an attached disk)
          3  Re-seal the disks to this machine's security chip (after a firmware or chip change)
          4  Factory reset (erase all data, keep the system)
          5  Secure erase everything (decommission; reinstall needed)
          6  Enable wired network (DHCP) for backup verification
          7  Turn "Ask before updating" off (when the apps can't install an update that waits)
          8  Show disk and Secure Boot status
          9  Restart
         10  Power off
         11  Change how you reach this Whombat (Whombat Link or Tailscale)
         12  Turn on Tailscale
      EOF
        printf 'Choice: '
        IFS= read -r c || { sleep 1; continue; }
        case "$c" in
          1) do_export ;;
          2) do_verify ;;
          3) do_reseal ;;
          4) do_factory_reset ;;
          5) do_secure_erase ;;
          6) authorize NETWORK && { for i in /sys/class/net/e*; do ip link set "$(basename "$i")" up; done; systemctl start systemd-networkd; log "network enabled"; } ;;
          7) do_ask_off ;;
          8) whombat-storage-status ;;
          9) log "restart"; systemctl reboot ;;
          10) log "power off"; systemctl poweroff ;;
          11) do_reach ;;
          12) reach_change tailscale-on TAILSCALE ;;
          *) continue ;;
        esac
        pause
      done
    '';
  };

  osRelease = pkgs.writeText "os-release" ''
    NAME="Whombat Recovery"
    ID=whombat-recovery
    PRETTY_NAME="Whombat Recovery"
    VERSION_ID="${config.system.nixos.release}"
    SORT_KEY=zz-whombat-recovery
  '';
in
{
  imports = [
    (modulesPath + "/installer/netboot/netboot.nix")
    # The appliance's kernel (NX-340): the recovery environment boots on every machine the appliance does.
    ../modules/kernel.nix
  ];

  system.stateVersion = "26.05";
  networking.hostName = "whombat-recovery";
  nixpkgs.config.allowUnfree = false;

  # No network services; networkd is present but only started from the menu (option 5).
  networking.useNetworkd = true;
  networking.useDHCP = false;
  systemd.network.enable = true;
  systemd.services.systemd-networkd.wantedBy = lib.mkForce [ ];
  systemd.sockets.systemd-networkd.wantedBy = lib.mkForce [ ];
  systemd.network.networks."90-wired" = {
    matchConfig.Name = "en* eth*";
    networkConfig.DHCP = "yes";
  };
  networking.firewall.enable = true;
  services.openssh.enable = false;
  nix.enable = false;
  documentation.enable = false;
  environment.defaultPackages = lib.mkForce [ ];
  environment.systemPackages = [
    pkgs.whombat-appliance-tools
    pkgs.whombat-recovery
  ];
  # The export's private PostgreSQL runs on the copy of the data directory as this user (never as root).
  users.users.whombat-export = {
    isSystemUser = true;
    group = "whombat-export";
  };
  users.groups.whombat-export = { };

  boot.initrd.systemd.enable = true;
  boot.initrd.availableKernelModules = [
    "nvme"
    "ahci"
    "xhci_pci"
    "usb_storage"
    "sd_mod"
    "virtio_pci"
    "virtio_blk"
    "virtio_scsi" # virtio-scsi(-single), PI-09
    "tpm_crb"
    "tpm_tis"
  ];
  # quiet: the menu's audit lines (kernel log, level 5) stay off the screen.
  boot.kernelParams = [
    "console=tty0"
    "quiet"
  ];

  # No console login anywhere (MA-21a): no getty on any VT or serial line, no autologin, no emergency
  # or rescue shell, root locked. logind spawns no VTs on switch (NAutoVTs=0, ReserveVT=0).
  users.users.root.hashedPassword = "!";
  systemd.services."getty@".enable = false;
  systemd.services."serial-getty@".enable = false;
  systemd.services."container-getty@".enable = false;
  services.logind.settings.Login = {
    NAutoVTs = 0;
    ReserveVT = 0;
  };
  systemd.enableEmergencyMode = false;
  boot.initrd.systemd.emergencyAccess = false;
  boot.kernel.sysctl."kernel.sysrq" = 0;

  systemd.services.whombat-recovery-menu = {
    description = "Whombat recovery menu (tty1)";
    wantedBy = [ "multi-user.target" ];
    after = [
      "systemd-user-sessions.service"
      "plymouth-quit-wait.service"
    ];
    unitConfig.IgnoreOnIsolate = true;
    # No pager or anything interactive a tool could open (N-3).
    environment = {
      SYSTEMD_PAGER = "cat";
      PAGER = "cat";
      SYSTEMD_PAGERSECURE = "1";
      SYSTEMD_LESS = "";
      LESSSECURE = "1";
    };
    serviceConfig = {
      ExecStart = lib.getExe menu;
      StandardInput = "tty-force";
      StandardOutput = "tty";
      StandardError = "tty";
      TTYPath = "/dev/tty1";
      TTYReset = true;
      TTYVHangup = true;
      TTYVTDisallocate = true;
      Restart = "always";
      RestartSec = 1;
      UtmpIdentifier = "tty1";
    };
  };

  netboot.squashfsCompression = "zstd -Xcompression-level 15";

  system.build.whombatRecoveryClean = cleanName;

  system.build.whombatRecoveryUki =
    pkgs.runCommand "whombat-recovery.efi"
      {
        nativeBuildInputs = [ pkgs.systemdUkify ];
      }
      ''
        ukify build \
          --linux=${config.boot.kernelPackages.kernel}/${pkgs.stdenv.hostPlatform.linux-kernel.target} \
          --initrd=${config.system.build.netbootRamdisk}/initrd \
          --cmdline="init=${config.system.build.toplevel}/init ${toString config.boot.kernelParams}" \
          --os-release=@${osRelease} \
          --uname=${config.boot.kernelPackages.kernel.modDirVersion} \
          --output=$out
      '';
}
