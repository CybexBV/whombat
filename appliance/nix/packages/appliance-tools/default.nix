# Root-only storage tools used by the installer, the recovery environment and (later) typed helper
# operations (NX-07, NX-25). None of them is reachable remotely; the appliance has no login.
#
# Two layouts, told apart on the disk itself (the recovery environment serves both): whombat-persist is a LUKS2
# volume (luks-tpm2, the factory platform) or a plain btrfs file system (host-encrypted, the self-installed platform,
# PI-02).
# On host-encrypted storage erasing means deleting and discarding, not destroying a key (NX-55: not cryptographic
# erasure). A box installed from an image before PI-19 may hold a disk recovery key's Argon2id hash on /persist
# (PI-04, `whombat-provision recovery-key check`); since PI-19 none has one, and a typed ERASE authorises (NX-91).
{
  lib,
  writeShellApplication,
  symlinkJoin,
  coreutils,
  util-linux,
  cryptsetup,
  e2fsprogs,
  btrfs-progs,
  systemd,
  gnugrep,
  gnused,
  findutils,
  whombat-update-helper,
  whombat-provision,
}:
let
  common = [
    coreutils
    util-linux
    cryptsetup
    e2fsprogs
    btrfs-progs
    systemd
    gnugrep
    gnused
    findutils
  ];

  # Stops every unit that still has a block device mounted in its own mount namespace. A sandboxed unit's
  # namespace (ProtectSystem, TemporaryFileSystem, BindReadOnlyPaths under /persist) keeps its own copy of
  # /persist after the host unmounted it, so the volume stays busy and can't be closed or wiped (NX-64).
  releaseDevice = writeShellApplication {
    name = "whombat-release-device";
    runtimeInputs = common;
    text = ''
      #   whombat-release-device DEVICE
      dev=$(readlink -f "$1")
      [ -b "$dev" ] || exit 0
      self=$(grep -o '[^/]*\.service' /proc/self/cgroup | tail -n1 || true)
      for _ in 1 2 3; do
        # By source, not by device number: btrfs reports an anonymous device in mountinfo.
        units=$(for m in /proc/[0-9]*/mountinfo; do
          pid=''${m#/proc/}; pid=''${pid%/mountinfo}
          [ "$pid" = 1 ] && continue
          findmnt --task "$pid" --source "$dev" -n >/dev/null 2>&1 || continue
          grep -o '[^/]*\.service' "/proc/$pid/cgroup" 2>/dev/null | tail -n1 || true
        done | sort -u | grep -vx "''${self:-none}" || true)
        [ -n "$units" ] || exit 0
        echo "stopping units that still hold $dev in their mount namespace:" "$units"
        mapfile -t list <<<"$units"
        systemctl stop "''${list[@]}" || true
        sleep 1
      done
    '';
  };

  # The systemd-cryptenroll arguments of a new TPM2 keyslot under this device's policy (NX-12, MA-21b),
  # one per line. `unbound`: no PCRs (factory, firmware still in setup mode). Otherwise PCR 7 plus the
  # device-signed PCR 11 policy, and for /persist PCR 15 after the root volume was measured — when this
  # runs in the normal system. From the recovery environment (--sysroot) /persist gets PCR 7 + signed
  # PCR 11 only; whombat-tpm-seal adds the PCR 15 binding on the next normal boot. Before the device has a
  # policy key (never sealed) or without Secure Boot, the slot is PCR 7 or unbound until whombat-tpm-seal
  # runs.
  enrollArgs = writeShellApplication {
    name = "whombat-tpm-enroll-args";
    runtimeInputs = common ++ [ whombat-update-helper ];
    text = ''
      #   whombat-tpm-enroll-args root|persist|unbound [--sysroot DIR]
      vol=''${1:-}; shift || true
      sysroot=""
      while [ $# -gt 0 ]; do
        case "$1" in
          --sysroot) sysroot=$2; shift 2 ;;
          *) echo "unknown argument $1" >&2; exit 2 ;;
        esac
      done
      case "$vol" in root|persist|unbound) ;; *) echo "usage: whombat-tpm-enroll-args root|persist|unbound [--sysroot DIR]" >&2; exit 2 ;; esac
      sb=$(od -An -t u1 -j4 -N1 /sys/firmware/efi/efivars/SecureBoot-8be4df61-93ca-11d2-aa0d-00e098032b8c 2>/dev/null | tr -d ' ' || true)
      if [ "$vol" = unbound ] || [ "$sb" != 1 ]; then echo "--tpm2-pcrs="; exit 0; fi
      pub=$sysroot/var/lib/whombat-storage/pcr-policy.pub.pem
      if [ ! -e "$pub" ]; then echo "--tpm2-pcrs=7"; exit 0; fi
      echo "--tpm2-public-key=$pub"
      echo "--tpm2-public-key-pcrs=11"
      if [ "$vol" = persist ] && [ -z "$sysroot" ] && pcr15=$(whombat-tpm-policy pcr15 --volume whombat-root 2>/dev/null); then
        echo "--tpm2-pcrs=7+15:sha256=$pcr15"
      else
        echo "--tpm2-pcrs=7"
      fi
    '';
  };

  storageInit = writeShellApplication {
    name = "whombat-storage-init";
    runtimeInputs = common ++ [ enrollArgs ];
    text = ''
      # Create a LUKS2 volume whose only keyslot is a TPM2 token, with a filesystem inside.
      #   whombat-storage-init --device DEV --name MAPPER --label FSLABEL [--fs ext4|btrfs]
      #                        [--tpm2-policy root|persist|unbound] [--sysroot DIR] [--leave-open]
      #                        [--maint-key-file FILE]
      #   whombat-storage-init --host-encrypted --device DEV --label FSLABEL [--fs ext4|btrfs]
      #                        (self-installed, PI-02: the file system directly on the partition, no LUKS, no TPM)
      # --maint-key-file adds a maintenance keyslot and writes its key (root-only) to FILE: the running system
      # re-enrols TPM slots with it (the TPM only unseals in the initrd; NX-12).
      # A random bootstrap key unlocks it during creation and is wiped afterwards. The TPM2 slot follows
      # whombat-tpm-enroll-args (default: the policy of the volume named by --name).
      dev="" name="" label="" policy="" sysroot="" leave_open=0 fs=ext4 maint="" host=0
      while [ $# -gt 0 ]; do
        case "$1" in
          --host-encrypted) host=1; shift ;;
          --device) dev=$2; shift 2 ;;
          --name) name=$2; shift 2 ;;
          --label) label=$2; shift 2 ;;
          --tpm2-policy) policy=$2; shift 2 ;;
          --tpm2-pcrs) [ -z "$2" ] && policy=unbound; shift 2 ;; # compatibility: "" = unbound
          --sysroot) sysroot=$2; shift 2 ;;
          --maint-key-file) maint=$2; shift 2 ;;
          --fs) fs=$2; shift 2 ;;
          --leave-open) leave_open=1; shift ;;
          *) echo "unknown argument $1" >&2; exit 2 ;;
        esac
      done
      if [ "$host" = 1 ]; then
        [ -n "$dev" ] && [ -n "$label" ] || { echo "usage: --host-encrypted --device --label" >&2; exit 2; }
        wipefs -a -q "$dev"
        case "$fs" in
          ext4) mkfs.ext4 -q -F -L "$label" -E lazy_itable_init=1,lazy_journal_init=1 "$dev" ;;
          btrfs) mkfs.btrfs -q -f -L "$label" "$dev" ;;
          *) echo "unsupported --fs $fs" >&2; exit 2 ;;
        esac
        echo "$dev: $fs '$label' (no LUKS)"
        exit 0
      fi
      if [ -z "$policy" ]; then
        case "$name" in whombat-persist) policy=persist ;; *) policy=root ;; esac
      fi
      [ -n "$dev" ] && [ -n "$name" ] && [ -n "$label" ] || { echo "usage: --device --name --label" >&2; exit 2; }
      [ -e /dev/tpmrm0 ] || { echo "no TPM2 device: refusing to create a volume without TPM unlock" >&2; exit 1; }
      umask 077
      tmp=$(mktemp -d /run/whombat-storage-init.XXXXXX)
      trap 'shred -u "$tmp/key" 2>/dev/null || rm -f "$tmp/key"; rmdir "$tmp"' EXIT
      head -c 64 /dev/urandom > "$tmp/key"
      cryptsetup luksFormat --type luks2 --batch-mode --pbkdf argon2id --label "$label" \
        --key-file "$tmp/key" "$dev"
      cryptsetup open --key-file "$tmp/key" --allow-discards "$dev" "$name"
      case "$fs" in
        ext4) mkfs.ext4 -q -L "$label" -E lazy_itable_init=1,lazy_journal_init=1 "/dev/mapper/$name" ;;
        btrfs) mkfs.btrfs -q -L "$label" "/dev/mapper/$name" ;;
        *) echo "unsupported --fs $fs" >&2; exit 2 ;;
      esac
      if [ -n "$maint" ]; then
        mkdir -p "$(dirname "$maint")"
        head -c 48 /dev/urandom | base64 -w0 > "$maint.new"
        cryptsetup luksAddKey --batch-mode --pbkdf pbkdf2 --iter-time 200 --key-file "$tmp/key" "$dev" "$maint.new"
      fi
      if [ -n "$sysroot" ]; then set -- --sysroot "$sysroot"; else set --; fi
      mapfile -t tpm < <(whombat-tpm-enroll-args "$policy" "$@")
      # Enrol the TPM2 slot and remove the bootstrap key's slot (0) in one step: from now on only the
      # TPM2 slot (and later the recovery key) opens it.
      systemd-cryptenroll --unlock-key-file="$tmp/key" --tpm2-device=auto "''${tpm[@]}" --wipe-slot=0 "$dev"
      if [ -n "$maint" ]; then mv "$maint.new" "$maint"; sync "$maint"; fi
      if [ "$leave_open" = 0 ]; then cryptsetup close "$name"; fi
      echo "$dev: LUKS2 + TPM2 (''${tpm[*]}), $fs '$label'"
    '';
  };

  # host-encrypted (self-installed, PI-02, NX-55): there is no key to destroy. The disk recovery key is checked
  # against its Argon2id hash on /persist when there is one (an image before PI-19), else a typed ERASE authorises
  # (NX-91); then every subvolume and file on /persist is deleted, the file system is wiped and the partition
  # discarded (an SSD, or a hypervisor's thin storage when the VM disk has discard on, frees the blocks), else zeroed. This is not
  # cryptographic erasure: copies in VM snapshots, backups, replicas or a host's free space are the host's to
  # destroy (docs/runbooks/install.md).
  hostErase = writeShellApplication {
    name = "whombat-host-erase";
    runtimeInputs = common ++ [
      whombat-provision
      releaseDevice
    ];
    text = ''
      #   whombat-host-erase [--all] [--factory]    (called by whombat-secure-erase on host-encrypted storage)
      all=0 factory=0
      for a in "$@"; do
        case "$a" in
          --all) all=1 ;;
          --factory) factory=1 ;;
          *) echo "unknown argument $a" >&2; exit 2 ;;
        esac
      done
      persist=/dev/disk/by-partlabel/whombat-persist
      root=/dev/disk/by-partlabel/whombat-root
      if [ "$all" = 1 ] && [ "$(findmnt -n -o SOURCE /)" = "$(readlink -f "$root")" ]; then
        echo "--all must run from the recovery environment (the system volume is in use)" >&2; exit 1
      fi
      # /persist as it is (mounted by the running system), or read-only for the check (recovery environment).
      mnt=$(findmnt -n -o TARGET --source "$(readlink -f "$persist")" 2>/dev/null | head -n1 || true)
      tmp=""
      if [ -z "$mnt" ]; then
        tmp=$(mktemp -d /run/whombat-erase.XXXXXX)
        mount -o ro,nosuid,nodev,noexec "$persist" "$tmp" 2>/dev/null || { rmdir "$tmp"; tmp=""; }
        mnt=$tmp
      fi
      cleanup() { if [ -n "$tmp" ]; then umount "$tmp" 2>/dev/null || true; rmdir "$tmp" 2>/dev/null || true; fi; }
      trap cleanup EXIT
      if [ "$factory" = 0 ]; then
        if [ -n "$mnt" ] && [ -e "$mnt/secrets/recovery-key.argon2id" ]; then
          echo "Type the disk recovery key to authorise erasing all appliance data:"
          IFS= read -r key
          if ! printf '%s\n' "$key" | whombat-provision recovery-key check --hash-file "$mnt/secrets/recovery-key.argon2id"; then
            echo "that is not this appliance's disk recovery key; nothing erased" >&2; exit 1
          fi
        elif [ -n "$mnt" ] && [ ! -e "$mnt/identity/device.json" ]; then
          # Never provisioned: no customer data and no key to ask for.
          echo "this appliance was never provisioned: nothing to protect"
        else
          # No disk recovery key (PI-19): the disk is not encrypted in this machine, so whoever runs this can read
          # it anyway; an explicit ERASE is the authority (NX-91).
          echo "This appliance has no disk recovery key. Type ERASE to erase all appliance data:"
          IFS= read -r c || c=""
          [ "$c" = ERASE ] || { echo "not confirmed; nothing erased" >&2; exit 1; }
        fi
      fi
      cleanup
      trap - EXIT
      systemctl stop whombat-runtime.target whombat-manager.service whombat-backup.service postgresql.service 2>/dev/null || true
      if mnt=$(findmnt -n -o TARGET --source "$(readlink -f "$persist")" 2>/dev/null | head -n1) && [ -n "$mnt" ]; then
        # Every subvolume, deepest first (paths are relative to the file system's top, which /persist is), then
        # whatever is left. The partition is discarded or zeroed below anyway; this makes the data unreachable
        # at once even if that pass is interrupted.
        btrfs subvolume list --sort=-path "$mnt" 2>/dev/null | awk '{print $NF}' | while read -r sv; do
          btrfs subvolume delete -c "$mnt/$sv" >/dev/null 2>&1 || true
        done || true
        find "$mnt" -xdev -mindepth 1 -delete 2>/dev/null || true
        sync
        umount -R "$mnt" || umount -l "$mnt"
      fi
      whombat-release-device "$persist"
      wipe() { # partition: discard it, or zero it where the disk can't discard
        wipefs -a -q "$1" || true
        if blkdiscard -f "$1" 2>/dev/null; then
          echo "$1: discarded"
        else
          echo "$1: the disk does not discard; writing zeros (this takes a while)"
          blkdiscard -z -f "$1" 2>/dev/null || dd if=/dev/zero of="$1" bs=4M oflag=direct status=none 2>/dev/null || true
        fi
      }
      wipe "$persist"
      echo "whombat-persist: all data deleted (not cryptographic erasure: on a VM, destroy its snapshots and backups on the host too)"
      if [ "$all" = 1 ]; then
        umount -R /mnt/whombat-root 2>/dev/null || true
        wipe "$root"
        echo "whombat-root: erased (reinstall with the installer image)"
      fi
    '';
  };

  secureErase = writeShellApplication {
    name = "whombat-secure-erase";
    runtimeInputs = common ++ [
      hostErase
      releaseDevice
    ];
    text = ''
      # Cryptographic erase: destroy every LUKS keyslot and token (luksErase). Without a keyslot the
      # volume key is gone and the ciphertext is unrecoverable, independent of SSD wear levelling.
      #   whombat-secure-erase [--all] [--factory]
      # Default: /persist only, after the disk recovery key is typed and verified (customer authority).
      # --all also erases the system volume (decommission; the device must be reinstalled).
      # --factory skips the recovery-key check (factory/RMA station with physical custody only).
      all=0 factory=0
      for a in "$@"; do
        case "$a" in
          --all) all=1 ;;
          --factory) factory=1 ;;
          *) echo "unknown argument $a" >&2; exit 2 ;;
        esac
      done
      persist=/dev/disk/by-partlabel/whombat-persist
      root=/dev/disk/by-partlabel/whombat-root
      [ -e "$persist" ] || { echo "no whombat-persist partition" >&2; exit 1; }
      if ! cryptsetup isLuks "$persist"; then
        exec whombat-host-erase "$@"
      fi
      if [ "$factory" = 0 ]; then
        echo "Type the disk recovery key to authorise erasing all appliance data:"
        IFS= read -r key
        printf '%s' "$key" | cryptsetup open --test-passphrase --key-file=- "$persist" \
          || { echo "that recovery key does not open this appliance's data volume; nothing erased" >&2; exit 1; }
      fi
      if [ "$all" = 1 ] && [ "$(findmnt -n -o SOURCE /)" = /dev/mapper/whombat-root ]; then
        echo "--all must run from the recovery environment (the system volume is in use)" >&2; exit 1
      fi
      systemctl stop whombat-runtime.target whombat-manager.service postgresql.service 2>/dev/null || true
      if findmnt -n /persist >/dev/null; then umount /persist; fi
      if [ -e /dev/mapper/whombat-persist ]; then
        whombat-release-device /dev/mapper/whombat-persist
        cryptsetup close whombat-persist
      fi
      cryptsetup luksErase --batch-mode "$persist"
      blkdiscard -f "$persist" 2>/dev/null || true
      echo "whombat-persist: all keyslots destroyed (customer data unrecoverable)"
      if [ "$all" = 1 ]; then
        if [ -e /dev/mapper/whombat-root ]; then umount -R /mnt/whombat-root 2>/dev/null || true; cryptsetup close whombat-root || true; fi
        cryptsetup luksErase --batch-mode "$root"
        blkdiscard -f "$root" 2>/dev/null || true
        echo "whombat-root: all keyslots destroyed (reinstall with the installer image)"
      fi
    '';
  };

  factoryReset = writeShellApplication {
    name = "whombat-factory-reset";
    runtimeInputs = common ++ [
      secureErase
      storageInit
      whombat-provision
    ];
    text = ''
      # Factory reset (NX-25): cryptographically erase /persist, create a fresh empty /persist sealed
      # to the TPM, forget the committed network configuration and the journal. The appliance comes
      # back unprovisioned: it needs the factory provisioning medium (new identity, claim card and
      # disk recovery key) before it can be claimed again.
      # host-encrypted (self-installed, NX-55): erase /persist as whombat-secure-erase does there (recovery key
      # checked against its hash, or a typed ERASE without one), a fresh empty btrfs, the same clean-up of the system
      # volume; the appliance comes back unprovisioned and provisions itself again (new identity, no recovery key).
      #   whombat-factory-reset [--factory]
      whombat-secure-erase "$@"
      sysroot=""
      if [ -d /mnt/whombat-root/var ]; then sysroot=/mnt/whombat-root; fi
      host=0
      if ! cryptsetup isLuks /dev/disk/by-partlabel/whombat-persist 2>/dev/null; then host=1; fi
      if [ -n "$sysroot" ]; then set -- --sysroot "$sysroot"; else set --; fi
      if [ "$host" = 1 ]; then
        whombat-storage-init --host-encrypted --device /dev/disk/by-partlabel/whombat-persist --label whombat-persist --fs btrfs
      else
        whombat-storage-init --device /dev/disk/by-partlabel/whombat-persist --name whombat-persist \
          --label whombat-persist --fs btrfs --tpm2-policy persist \
          --maint-key-file "$sysroot/var/lib/whombat-storage/maint-whombat-persist.key" "$@"
        # The system volume survives the reset: remove every key of the previous owner from it (their disk
        # recovery key would otherwise open root, which holds the new /persist's maintenance key; N-7) and
        # replace root's maintenance key. Keeps the TPM2 slot; crash-safe and resumable.
        rootmaint="$sysroot/var/lib/whombat-storage/maint-whombat-root.key"
        if [ -s "$rootmaint" ] || [ -s "$rootmaint.new" ]; then
          whombat-provision reset-keyslots --device /dev/disk/by-partlabel/whombat-root --maint-key "$rootmaint" --rotate
        else
          echo "WARNING: the system volume has no maintenance key (never sealed): the previous disk recovery key still opens it" >&2
        fi
        if [ -n "$sysroot" ]; then
          # From the recovery environment the new /persist lacks the PCR 15 root binding: the next normal
          # boot's whombat-tpm-seal adds it.
          rm -f "$sysroot/var/lib/whombat-storage/tpm-seal"
        fi
      fi
      # Forget everything the old identity left on the system volume: the committed network, Wi-Fi only (the
      # switched-off cable, else the box would start with neither its cable nor a saved Wi-Fi network), the saved Wi-Fi
      # networks and their passwords (iwd's; NX-247), the paired Bluetooth devices and their keys (BlueZ's; NX-359),
      # the journal and the update helper's records (assignment sequence, time floor, activations, a pending Wi-Fi
      # change; L-5), so the next provisioning seeds the helper for the new identity.
      rm -f "$sysroot/var/lib/whombat-update-helper/network/committed.network" \
            "$sysroot/var/lib/whombat-update-helper/network/previous.network" \
            "$sysroot/var/lib/whombat-update-helper/network/cable-off.network"
      rm -rf "$sysroot/var/lib/iwd/"*
      rm -rf "$sysroot/var/lib/bluetooth/"*
      rm -rf "$sysroot/var/lib/whombat-update-helper/state.json" \
             "$sysroot/var/lib/whombat-update-helper/tuf" \
             "$sysroot/var/lib/whombat-update-helper/tuf-github" \
             "$sysroot/var/lib/whombat-update-helper/work" \
             "$sysroot/var/lib/whombat-update-helper/fake"
      rm -rf "$sysroot/var/log/journal/"*
      sync
      echo "factory reset complete: the appliance is unprovisioned"
    '';
  };

  status = writeShellApplication {
    name = "whombat-storage-status";
    runtimeInputs = common;
    text = ''
      for part in whombat-root whombat-persist; do
        dev=/dev/disk/by-partlabel/$part
        [ -e "$dev" ] || continue
        echo "== $part"
        if cryptsetup isLuks "$dev"; then
          systemd-cryptenroll "$dev" || true
        else
          echo "$(blkid -o value -s TYPE "$dev" 2>/dev/null || echo unknown), not encrypted in this machine"
        fi
      done
      if [ -e /persist/secrets/recovery-key.argon2id ]; then
        echo "== disk recovery key: stored as a hash (installed from an image before PI-19)"
      fi
      echo "== secure boot"
      bootctl status 2>/dev/null | grep -i 'secure boot' || true
      echo "== tpm seal: $(cat /var/lib/whombat-storage/tpm-seal 2>/dev/null || echo 'not sealed to PCRs')"
      echo "== /persist"
      df -h /persist 2>/dev/null || true
      btrfs qgroup show -reF /persist 2>/dev/null | head -20 || true
    '';
  };
in
symlinkJoin {
  name = "whombat-appliance-tools";
  paths = [
    releaseDevice
    enrollArgs
    storageInit
    hostErase
    secureErase
    factoryReset
    status
  ];
  passthru = {
    inherit
      enrollArgs
      storageInit
      hostErase
      secureErase
      factoryReset
      status
      ;
  };
  meta.description = "Whombat appliance storage, erase and reset tools";
  meta.platforms = lib.platforms.linux;
}
