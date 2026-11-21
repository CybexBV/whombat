# whombat-install: lays out the internal disk and installs the appliance system (NX-07). Used by the
# installer ISO (installer.nix) and by the VM tests (the same script on a test VM).
#
# Factory sequence: boot the installer → whombat-install → reboot into the appliance (firmware in
# Secure Boot setup mode) → first boot generates per-device Secure Boot keys and prepares enrolment →
# reboot, systemd-boot enrols the keys → Secure Boot enforced, whombat-tpm-seal binds the TPM slots to
# PCR 7 → factory medium → whombat-provision (identities, cards, disk recovery key).
#
# self-installed (PI-02, NX-51; a dedicated machine or a VM, PI-18, PI-21): the image's system says so
# (/etc/whombat/platform); whombat-install then lays out the same three partitions without LUKS and without a TPM
# (host-encrypted). First boot generates the Secure Boot keys (not enrolled), self-provisions and shows the claim
# code on the console (docs/runbooks/install.md).
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.whombat.installer;
  # The system's closure and its size (total-nar-size): the copy step's 100 % (CG-12, NX-81).
  closure = pkgs.closureInfo { rootPaths = [ cfg.system ]; };
  install = pkgs.writeShellApplication {
    name = "whombat-install";
    runtimeInputs = with pkgs; [
      coreutils
      util-linux
      dosfstools
      e2fsprogs
      btrfs-progs
      cryptsetup
      systemd
      gnugrep
      gawk
      findutils
      whombat-installer-ui
      whombat-appliance-tools
      config.system.build.nixos-install
      config.nix.package
    ];
    text = ''
      # whombat-install --disk /dev/nvme0n1 --yes-erase-disk [--root-size 40G] [--tpm2-pcrs ""]
      #                 [--platform factory|self-installed]   (default and only allowed value: the image's own)
      #                 [--wifi-profile /…/Home.psk]           (the Wi-Fi network the installer joined, HD-08, CG-122)
      #                 [--reach link|tailscale|both] [--login-server https://…]
      #                                                        (how the owner will reach the box, LNK-12: reach.json)
      #
      # Besides its log it prints `@@progress <step> <percent>` lines (CG-12, NX-81): steps partition, filesystems,
      # copy, boot, finish, each 0…100; the copy's percentage is the bytes in the target's store against the system
      # closure's size. whombat-installer-ui turns them into the progress bar.
      disk="" yes=0 root_size=${cfg.rootSize} pcrs="" platform="" wifi_profile="" reach="" login_server=""
      # What it creates (/mnt/whombat-target, the target's directories) must be readable: nixos-install refuses a
      # 0700 /mnt, which a caller's umask 0077 (whombat-installer-ui's unit) would give it.
      umask 0022
      progress() { echo "@@progress $1 $2"; }
      # Once the disk is being changed, a failure leaves nothing mounted or open, so the install can run again.
      started=0 monitor=""
      cleanup() {
        rc=$?
        if [ -n "$monitor" ]; then kill "$monitor" 2>/dev/null || true; fi
        if [ "$rc" != 0 ] && [ "$started" = 1 ]; then
          umount -R /mnt/whombat-target 2>/dev/null || true
          cryptsetup close whombat-persist 2>/dev/null || true
          cryptsetup close whombat-root 2>/dev/null || true
        fi
      }
      trap cleanup EXIT
      while [ $# -gt 0 ]; do
        case "$1" in
          --disk) disk=$2; shift 2 ;;
          --yes-erase-disk) yes=1; shift ;;
          --root-size) root_size=$2; shift 2 ;;
          --tpm2-pcrs) pcrs=$2; shift 2 ;;
          --platform) platform=$2; shift 2 ;;
          --wifi-profile) wifi_profile=$2; shift 2 ;;
          --reach) reach=$2; shift 2 ;;
          --login-server) login_server=$2; shift 2 ;;
          # The developer option is gone (ONE-02): every box starts in the image's environment, production.
          --environment) echo "--environment: the installer has no developer option any more" >&2; exit 2 ;;
          *) echo "unknown argument $1" >&2; exit 2 ;;
        esac
      done
      system=${cfg.system}
      # One installer owns the mountpoint, mapper names and partition labels.
      # Hold this across validation and cleanup, including a shell/UI overlap.
      exec 9>/run/whombat-install.lock
      flock -n 9 || { echo "another installation is running" >&2; exit 1; }
      # The system decides its layout (storage.nix writes "<platform> <storage mode>"): a disk laid out for
      # another platform would not boot.
      read -r image_platform mode < "$system/etc/whombat/platform" || { echo "$system names no platform" >&2; exit 1; }
      [ -n "$platform" ] || platform=$image_platform
      if [ "$platform" != "$image_platform" ]; then
        echo "this installer's system is for $image_platform, not $platform" >&2; exit 2
      fi
      case "$mode" in
        luks-tpm2|host-encrypted) ;;
        *) echo "storage mode $mode is not installed on a disk (development images are prebuilt)" >&2; exit 2 ;;
      esac
      [ -b "$disk" ] || { echo "--disk must be a block device" >&2; exit 2; }
      [ "$yes" = 1 ] || { echo "refusing without --yes-erase-disk (everything on $disk is destroyed)" >&2; exit 2; }
      disk=$(readlink -f "$disk")
      # Validate every size before wipefs: malformed/oversized layouts must not
      # erase a working disk only to fail in sfdisk or while copying the system.
      root_bytes=$(numfmt --from=iec "$root_size")
      esp_bytes=$(numfmt --from=iec ${lib.escapeShellArg cfg.espSize})
      total=$(cat ${closure}/total-nar-size)
      [ "$root_bytes" -ge "$((total + 1073741824))" ] || { echo "system partition is too small for this image" >&2; exit 2; }
      [ "$esp_bytes" -ge 1073741824 ] || { echo "boot partition must be at least 1 GiB" >&2; exit 2; }
      minimum=$((root_bytes + esp_bytes + 1075838976)) # at least 1 GiB of data, plus GPT/alignment
      if [ "$mode" = host-encrypted ] && [ "$minimum" -lt 118111600640 ]; then minimum=118111600640; fi
      whombat-installer-ui --check-disk "$disk" --medium-label ${lib.escapeShellArg cfg.mediumLabel} --minimum-disk-bytes "$minimum"
      # The partitions are found by their labels, here and at every boot: a second disk that already holds a
      # Whombat's partitions would make them ambiguous (and mkfs could hit it), so it is refused (NX-92).
      target=$(readlink -f "$disk")
      others=$(lsblk -nrpo PARTLABEL,PKNAME | awk -v d="$target" '$1 ~ /^whombat-(esp|root|persist)$/ && $2 != d { print $2 }' | sort -u | tr '\n' ' ')
      if [ -n "$others" ]; then
        echo "another disk already holds a Whombat installation ($others): erase or remove it first" >&2; exit 1
      fi
      if [ "$mode" = luks-tpm2 ]; then
        [ -e /dev/tpmrm0 ] || { echo "no TPM 2.0: this hardware cannot run the appliance" >&2; exit 1; }
      fi
      # An iwd profile (iwd.network(5)): its name is the network's, or `=` and its bytes in hex; .psk or .open.
      if [ -n "$wifi_profile" ]; then
        [ -f "$wifi_profile" ] || { echo "--wifi-profile must be a file" >&2; exit 2; }
        case "$(basename "$wifi_profile")" in
          *[!A-Za-z0-9\ _=.-]* | .*) echo "--wifi-profile is not an iwd profile" >&2; exit 2 ;;
          *.psk | *.open) ;;
          *) echo "--wifi-profile is not an iwd profile" >&2; exit 2 ;;
        esac
      fi
      # How the owner will reach the box (internal/reach: the same rules as the manager's), checked before the disk is
      # touched. The login server's pattern is reach.ValidLoginServer's: no quotes, backslashes or spaces, so it goes
      # into the JSON below as it is.
      reach_link=false reach_tailscale=false
      case "$reach" in
        "") ;;
        link) reach_link=true ;;
        tailscale) reach_tailscale=true ;;
        both) reach_link=true reach_tailscale=true ;;
        *) echo "--reach must be link, tailscale or both" >&2; exit 2 ;;
      esac
      if [ -n "$login_server" ]; then
        [ "$reach_tailscale" = true ] || { echo "--login-server needs --reach tailscale or both" >&2; exit 2; }
        # One line only (grep matches line by line), and byte ranges whatever the locale.
        case "$login_server" in *$'\n'*) echo "--login-server must be an https address" >&2; exit 2 ;; esac
        printf '%s\n' "$login_server" |
          LC_ALL=C grep -qE '^https://[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?(:[0-9]{1,5})?(/[A-Za-z0-9._~/-]{0,200})?$' ||
          { echo "--login-server must be an https address" >&2; exit 2; }
      fi
      # Shown in the graphical installer's log: no platform or storage names (CG-30).
      echo "== installing Whombat on $disk"

      started=1
      progress partition 0
      echo "== partitioning $disk"
      wipefs -a -q "$disk"
      sfdisk -q --label gpt "$disk" <<EOF
      size=${cfg.espSize}, type=uefi, name=whombat-esp
      size=$root_size, type=linux, name=whombat-root
      type=linux, name=whombat-persist
      EOF
      udevadm settle
      # Resolve partitions on this disk only. Global by-partlabel links may be
      # stale during udev changes and must never direct mkfs to another disk.
      part() {
        local path
        path=$(lsblk -nrpo PATH,PARTLABEL "$disk" | awk -v label="$1" '$2 == label { print $1 }')
        [ -b "$path" ] || return 1
        echo "$path"
      }
      for p in whombat-esp whombat-root whombat-persist; do
        for _ in $(seq 50); do part "$p" >/dev/null && break; sleep 0.2; done
        part "$p" >/dev/null || { echo "partition $p did not appear on $disk" >&2; exit 1; }
      done

      progress partition 100
      progress filesystems 0
      echo "== file systems"
      mkfs.vfat -F 32 -n WHOMBAT-ESP "$(part whombat-esp)" >/dev/null
      if [ "$mode" = luks-tpm2 ]; then
        whombat-storage-init --device "$(part whombat-root)" --name whombat-root --label whombat-root --tpm2-pcrs "$pcrs" --leave-open
        whombat-storage-init --device "$(part whombat-persist)" --name whombat-persist --label whombat-persist --fs btrfs --tpm2-pcrs "$pcrs" --leave-open
        rootdev=/dev/mapper/whombat-root persistdev=/dev/mapper/whombat-persist
      else
        # host-encrypted: no LUKS, no TPM (PI-02, PI-20).
        whombat-storage-init --host-encrypted --device "$(part whombat-root)" --label whombat-root
        whombat-storage-init --host-encrypted --device "$(part whombat-persist)" --label whombat-persist --fs btrfs
        rootdev=$(part whombat-root) persistdev=$(part whombat-persist)
      fi

      mnt=/mnt/whombat-target
      linux=$mnt/boot/EFI/Linux
      mkdir -p $mnt
      mount "$rootdev" $mnt
      mkdir -p $mnt/boot $mnt/persist
      mount -o umask=0077 "$(part whombat-esp)" $mnt/boot
      mount "$persistdev" $mnt/persist

      progress filesystems 100
      progress copy 0
      echo "== installing $system"
      total=$(cat ${closure}/total-nar-size)
      (
        while sleep 2; do
          used=$(du -s --apparent-size -B1 $mnt/nix/store 2>/dev/null | cut -f1) || used=0
          pct=$(( ''${used:-0} * 100 / (total > 0 ? total : 1) ))
          progress copy $(( pct > 99 ? 99 : pct ))
        done
      ) &
      monitor=$!
      nixos-install --system "$system" --root $mnt --no-root-passwd --no-channel-copy
      kill "$monitor" 2>/dev/null || true
      wait "$monitor" 2>/dev/null || true
      monitor=""
      progress copy 100
      progress boot 0

      echo "== blessing the factory generation"
      # The factory generation passed factory tests; it is the device's first known-good entry.
      for f in "$linux"/nixos-*+*.efi; do
        [ -e "$f" ] || continue
        mv "$f" "''${f%%+*}.efi"
      done
      ${lib.optionalString (cfg.recoveryUki != null) ''
        install -m 0600 ${cfg.recoveryUki} "$linux"/whombat-recovery.efi
      ''}
      # No randomness or identity is carried over from the installer.
      rm -f $mnt/boot/loader/random-seed $mnt/var/lib/systemd/random-seed
      : > $mnt/etc/machine-id 2>/dev/null || true
      ls -la "$linux"
      # The Wi-Fi network the installer joined (HD-08): into iwd's own state, root only, so the box is online at its
      # first start (HD-05: saved networks live there, not in backups).
      if [ -n "$wifi_profile" ]; then
        echo "== adding the Wi-Fi network"
        install -d -m 0700 -o root -g root $mnt/var/lib/iwd
        install -m 0600 -o root -g root "$wifi_profile" "$mnt/var/lib/iwd/$(basename "$wifi_profile")"
      fi
      # The owner's choice, root's in a root-owned folder on /persist (internal/reach): the manager acts on reach.json
      # at the first start. No environment.json: the box is in the image's default environment (ONE-02).
      if [ -n "$reach" ]; then
        install -d -m 0755 -o root -g root $mnt/persist/whombat
      fi
      if [ -n "$reach" ]; then
        echo "== how this Whombat is reached: $reach''${login_server:+ (login server $login_server)}"
        login_json=""
        if [ -n "$login_server" ]; then login_json=",\"loginServer\":\"$login_server\""; fi
        printf '{"v":1,"seq":1,"link":%s,"tailscale":%s%s,"by":"installer","at":"%s"}\n' \
          "$reach_link" "$reach_tailscale" "$login_json" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > $mnt/persist/whombat/reach.json.tmp
        chown root:root $mnt/persist/whombat/reach.json.tmp
        chmod 0644 $mnt/persist/whombat/reach.json.tmp
        mv $mnt/persist/whombat/reach.json.tmp $mnt/persist/whombat/reach.json
      fi
      progress boot 100

      progress finish 0
      sync
      umount $mnt/persist $mnt/boot $mnt
      if [ "$mode" = luks-tpm2 ]; then
        cryptsetup close whombat-persist
        cryptsetup close whombat-root
      fi
      progress finish 100
      echo "== done: remove the installer medium and restart"
    '';
  };
  tokenDir = "/run/whombat-installer-ui";
in
{
  imports = [ ../modules/kiosk.nix ];

  options.whombat.installer = {
    system = lib.mkOption {
      type = lib.types.package;
      description = "The appliance system (toplevel) the installer puts on the disk.";
    };
    recoveryUki = lib.mkOption {
      type = lib.types.nullOr lib.types.package;
      default = null;
      description = "Recovery UKI copied to the ESP (signed on the device's first boot).";
    };
    rootSize = lib.mkOption {
      type = lib.types.str;
      default = "40G";
      description = "System volume size (Nix store with several host and runtime generations).";
    };
    espSize = lib.mkOption {
      type = lib.types.str;
      default = "2G";
    };
    gui = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = ''
        The graphical installer (CG-11…CG-14): whombat-installer-ui (root, 127.0.0.1:8412) and the kiosk on tty1; the
        shell stays on the other VTs and `whombat-install` works from it as before.
      '';
    };
    guiPort = lib.mkOption {
      type = lib.types.port;
      default = 8412;
    };
    mediumLabel = lib.mkOption {
      type = lib.types.str;
      default = config.isoImage.volumeID or "WHOMBAT-INSTALLER";
      defaultText = lib.literalExpression "config.isoImage.volumeID";
      description = "Label of the installer medium: never offered as a target disk.";
    };
  };

  config = lib.mkMerge [
    {
      environment.systemPackages = [
        install
        pkgs.whombat-appliance-tools
      ];
      boot.initrd.availableKernelModules = [
        "tpm_crb"
        "tpm_tis"
      ];
    }

    (lib.mkIf cfg.gui {
      # The graphical installer's server (NX-79): root (it erases and installs the disk), the host's network (the
      # pre-flight checks the image's hosts), loopback only, a token for the kiosk.
      systemd.services.whombat-installer-ui = {
        description = "Whombat installer (the graphical installer's page and API)";
        wantedBy = [ "multi-user.target" ];
        after = [ "systemd-tmpfiles-setup.service" ];
        path = [
          install
          pkgs.util-linux
          pkgs.systemd
        ];
        serviceConfig = {
          Type = "notify";
          NotifyAccess = "main";
          ExecStart = lib.concatStringsSep " " [
            "${pkgs.whombat-installer-ui}/bin/whombat-installer-ui --serve 127.0.0.1:${toString cfg.guiPort}"
            "--ui ${pkgs.whombat-console-ui}/share/whombat-console-ui --token-file ${tokenDir}/token"
            "--system ${cfg.system} --medium-label ${lib.escapeShellArg cfg.mediumLabel}"
            "--install-cmd ${install}/bin/whombat-install --lsblk ${pkgs.util-linux}/bin/lsblk"
          ];
          Restart = "on-failure";
          RestartSec = 1;
        };
      };

      whombat.kiosk = {
        enable = true;
        port = cfg.guiPort;
        inherit tokenDir;
        tokenOwner = "root";
        serverUnit = "whombat-installer-ui.service";
        joinServerNetwork = false;
        # No display, or a kiosk that keeps failing: the shell on tty1 as before.
        fallbackUnit = "getty@tty1.service";
      };
      # tty1 is the kiosk's; the shell (autologin on the ISO) is on tty2 and the other VTs.
      systemd.targets.getty.wants = lib.mkForce [ ];
      systemd.services."autovt@tty1".enable = false;
      boot.initrd.availableKernelModules = [
        "bochs"
        "virtio_gpu"
        "qxl"
      ];
    })
  ];
}
