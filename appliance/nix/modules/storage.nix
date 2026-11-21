# Disk layout, encryption and capacity reservation (NX-06, NX-07, NX-12).
#
# Device disk (GPT, created by `whombat-install` from the installer image):
#   whombat-esp      vfat  1 GiB   systemd-boot + lanzaboote-signed generations + recovery UKI
#   whombat-root     LUKS2 → ext4  Nix store, profiles, /var (logs, caches). No customer data.
#   whombat-persist  LUKS2 → btrfs /persist (MA-12). All customer and device state; subvolumes for the
#                                  backup sources so checkpoints are millisecond snapshots (BK-04, NX-07).
# Both LUKS2 volumes have two keyslots: a TPM2 token for unattended boot and the customer's disk
# recovery key (printed on the recovery card, typed at the console when the TPM refuses). Cryptographic
# erase = destroying every keyslot (see `whombat-secure-erase`).
#
# host-encrypted (whombat.platform = "self-installed" only, PI-02, NX-51; the ISO on a dedicated machine or a VM,
# PI-18, PI-21): the same three partitions without LUKS: whombat-root is ext4 and whombat-persist
# btrfs directly on the disk, with the same subvolumes and quotas. No TPM, no seal, no PCR policy. Nothing
# requires encryption underneath (PI-20 supersedes PI-03's host rules; encrypting the machine's disk or the VM's
# storage is recommended in docs/runbooks/install.md). No disk recovery key since PI-19; a hash an earlier
# image stored on /persist (PI-04) still gates the recovery menu and factory reset.
#
# TPM2 policy (MA-21b, NX-12), once Secure Boot is enforced:
#   root     PCR 7 (Secure Boot state + db authority) AND a PCR 11 value signed by the device's own policy
#            key. PCR 11 holds the measurement of the booted generation (kernel, initrd, command line,
#            os-release) plus the boot phase; the device signs the expected values of exactly the
#            generations lanzaboote installed (`whombat-tpm-policy sign`, run after every boot-loader
#            install and on every boot). The recovery UKI and any other image carrying a valid Secure Boot
#            signature produce other PCR 11 values and cannot unseal.
#   persist  the same, AND PCR 15 as it is right after the root volume was opened: systemd-cryptsetup
#            extends PCR 15 with an HMAC of the root volume key (tpm2-measure-pcr=yes), so /persist does
#            not open after a swapped-in root volume.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.whombat.storage;
  # The subvolumes in Whombat's own qgroup 1/100 (NX-12): the backup sources and the rest, then the extra ones.
  limited = cfg.subvolumes ++ cfg.extraSubvolumes;
  p = config.whombat.persistDir;
  # The qgroups (NX-12, NX-150, NX-458): 2/100 holds everything but PostgreSQL and has the reserve's limit; in it 1/100
  # (Whombat's own subvolumes) and 1/101 (the agent's containers', with a limit of their own; the computers' before).
  qg = cfg.qgroups;
  comp = cfg.containers;
  # Where the containers' subvolumes are, relative to /persist: each of these and everything nested in it is in 1/101
  # only.
  compTrees = comp.subvolumes;

  # Shell helpers of whombat-persist-layout and whombat-qgroups (btrfs-progs and jq in PATH).
  qgroupLib = ''
    qgshow() { btrfs --format json qgroup show -p ${p} 2>/dev/null; }
    qgexists() { qgshow | jq -e --arg q "$1" 'any(."qgroup-show"[]; .qgroupid == $q)' >/dev/null; }
    qgparents() { qgshow | jq -r --arg q "$1" '."qgroup-show"[] | select(.qgroupid == $q) | .parents[]'; }
    qgin() { qgparents "$1" | grep -qxF "$2"; }
    subvolid() { btrfs subvolume show "$1" 2>/dev/null | awk '/Subvolume ID:/ {print $3}'; }
    # qgonly QGROUP PARENT: PARENT becomes QGROUP's only parent qgroup. It joins PARENT first and leaves the others after,
    # so it is never outside a limit it was inside; it stays where it is when it can't join.
    qgonly() {
      qgin "$1" "$2" || btrfs qgroup assign --no-rescan "$1" "$2" ${p} >/dev/null || return 1
      for g in $(qgparents "$1"); do
        [ "$g" = "$2" ] || btrfs qgroup remove --no-rescan "$1" "$g" ${p} >/dev/null || return 1
      done
    }
    # Whether btrfs says the counts are off: then it counts no writes at all until a rescan (NX-150).
    qginconsistent() {
      local f
      f=/sys/fs/btrfs/$(btrfs filesystem show ${p} 2>/dev/null | awk '/uuid:/ {print $NF; exit}')/qgroups/inconsistent
      if [ -r "$f" ]; then [ "$(cat "$f")" = 1 ]; else btrfs qgroup show ${p} 2>&1 >/dev/null | grep -qi inconsistent; fi
    }
    # Usable data capacity, not the device size: metadata (DUP) and the global reserve come first.
    persistsize() {
      local usage used free
      usage=$(btrfs filesystem usage -b ${p})
      used=$(echo "$usage" | awk '/^ *Used:/ {print $2; exit}')
      free=$(echo "$usage" | awk '/Free \(estimated\):/ {print $3; exit}')
      echo $(( used + free ))
    }
  '';

  # whombat-qgroups (NX-150, NX-458), every minute: every subvolume under the containers' trees is in 1/101 only (one
  # made inside a container, `btrfs subvolume create` in it, isn't by itself), and counts btrfs calls inconsistent are
  # rescanned at once, because until then btrfs counts no writes against any limit.
  qgroupsScript = pkgs.writeShellScript "whombat-qgroups" ''
    set -u
    PATH=${
      lib.makeBinPath [
        pkgs.btrfs-progs
        pkgs.util-linux
        pkgs.coreutils
        pkgs.gawk
        pkgs.gnugrep
        pkgs.jq
      ]
    }
    [ "$(findmnt -n -o FSTYPE --target ${p})" = btrfs ] && [ "$(findmnt -n -o TARGET --target ${p})" = ${p} ] || exit 0
    btrfs qgroup show ${p} >/dev/null 2>&1 || exit 0
    ${qgroupLib}
    # <5>: notice, above the unit's LogLevelMax (the rest of a run is silent).
    qgshow | jq -r --argjson trees '${builtins.toJSON compTrees}' --arg g ${qg.containers} '
      ."qgroup-show"[]
      | select((.qgroupid | startswith("0/")) and ((.path // "") as $p | any($trees[]; . as $t | $p == $t or ($p | startswith($t + "/")))))
      | select(.parents != [$g])
      | "\(.qgroupid) \(.path) \(.parents | join(",") | if . == "" then "-" else . end)"' |
      while read -r q path was; do
        if qgonly "$q" ${qg.containers}; then
          echo "<5>${p}/$path ($q, in $was) is now in ${qg.containers} only, the containers' qgroup"
        else
          echo "<4>${p}/$path ($q, in $was) couldn't be moved into ${qg.containers}"
        fi
      done
    mark=/run/whombat-qgroups.rescan
    if qginconsistent; then
      if btrfs quota rescan -s ${p} 2>/dev/null | grep -q "no rescan"; then
        btrfs quota rescan ${p} >/dev/null 2>&1 \
          && echo "<5>btrfs lost track of the qgroup counts on ${p}: rescanning (the limits count writes again when it ends)" \
          || echo "<4>btrfs lost track of the qgroup counts on ${p} and the rescan didn't start"
        touch $mark
      fi
    elif [ -e $mark ]; then
      rm -f $mark
      echo "<5>the qgroup counts on ${p} are known again"
    fi
    exit 0
  '';
  luks = cfg.mode == "luks-tpm2";
  hostEncrypted = cfg.mode == "host-encrypted";
  platform = config.whombat.platform;
  pcrList = lib.concatMapStringsSep "+" toString cfg.tpm2Pcrs;
  cryptenroll = "${config.systemd.package}/bin/systemd-cryptenroll";
  sd = config.systemd.package;
  stateDir = "/var/lib/whombat-storage";
  policyKey = "${stateDir}/pcr-policy.key";
  policyPub = "${stateDir}/pcr-policy.pub.pem";
  espSignature = "EFI/whombat/tpm2-pcr-signature.json";

  nextKey = "${stateDir}/pcr-policy.next.key";
  nextPub = "${stateDir}/pcr-policy.next.pub.pem";
  record = "${stateDir}/signed.json";

  # Signs the expected PCR 11 value (phase enter-initrd only) of every generation of the root-owned
  # system profile whose stub is on the ESP, with the device's policy key (and the next key during a
  # rotation). Stubs of anything else on the ESP are refused (N-1). Records what each key signed. Run by
  # the boot-loader install (after lzbt wrote the generations) and by whombat-tpm-seal (every boot and
  # whenever the profile changes). Without a key (before the first sealed boot) there is nothing to sign.
  tpmSign = pkgs.writeShellApplication {
    name = "whombat-tpm-sign";
    runtimeInputs = [
      pkgs.coreutils
      pkgs.util-linux
      pkgs.whombat-update-helper
    ];
    text = ''
      esp=''${1:-/boot}
      if [ ! -e ${policyKey} ]; then
        echo "whombat-tpm-sign: no PCR policy key yet (created by whombat-tpm-seal once Secure Boot is enforced)"
        exit 0
      fi
      set -- --key ${policyKey}:${policyPub}
      if [ -e ${nextKey} ] && [ -e ${nextPub} ]; then set -- "$@" --key ${nextKey}:${nextPub}; fi
      # One signer at a time (boot-loader install, seal, re-seal): the record is read-modify-write.
      exec 9>/run/whombat-tpm-sign.lock
      flock 9
      whombat-tpm-policy sign --esp "$esp" --profiles /nix/var/nix/profiles --record ${record} \
        --measure ${sd}/lib/systemd/systemd-measure --out "$esp/${espSignature}" "$@"
    '';
  };

  # Seal / re-seal (whombat-tpm-seal at boot, whombat-tpm-reseal when the profile changes). The running
  # system never unseals with the TPM (only enter-initrd is signed, N-2), so every re-enrolment unlocks
  # with a per-volume maintenance key kept root-only on the encrypted root (maint-<volume>.key; it only
  # gives what root of the running system already has: both volumes are open).
  sealScript = pkgs.writeShellApplication {
    name = "whombat-tpm-seal";
    runtimeInputs = [
      pkgs.coreutils
      pkgs.util-linux
      pkgs.gnugrep
      pkgs.openssl
      pkgs.cryptsetup
      sd
      pkgs.whombat-update-helper
    ];
    text = ''
      umask 077
      exec 8>/run/whombat-tpm-seal.lock
      flock 8
      st=${stateDir}
      marker=$st/tpm-seal
      mkdir -p $st
      # Refuse to bind to PCRs the firmware or stub never extended (all zeros): that seal would protect nothing.
      for pcr in ${lib.concatMapStringsSep " " toString cfg.tpm2Pcrs} 11; do
        if systemd-analyze pcrs "$pcr" --json=short | grep -q '"0000000000000000000000000000000000000000000000000000000000000000"'; then
          echo "PCR $pcr is not measured on this boot; not sealing (hardware does not qualify)" >&2
          exit 1
        fi
      done
      pcr15=$(whombat-tpm-policy pcr15 --volume whombat-root) || {
        echo "the root volume was not measured into PCR 15 on this boot; not sealing" >&2
        exit 1
      }

      maint() { # volume: make sure its maintenance keyslot and key file exist (crash-safe)
        local k=$st/maint-$1.key dev=/dev/disk/by-partlabel/$1
        if [ -s "$k" ] && cryptsetup open --test-passphrase --key-file "$k" "$dev" 2>/dev/null; then return 0; fi
        if [ -s "$k.new" ] && cryptsetup open --test-passphrase --key-file "$k.new" "$dev" 2>/dev/null; then
          mv "$k.new" "$k"; sync "$k"; return 0
        fi
        head -c 48 /dev/urandom | base64 -w0 > "$k.new"
        sync "$k.new"
        if ! NEWPASSWORD=$(cat "$k.new") systemd-cryptenroll --unlock-tpm2-device=auto --password "$dev"; then
          rm -f "$k.new"
          echo "$1 has no maintenance keyslot and the TPM does not unlock it in the running system: re-seal once from the recovery environment (recovery key)" >&2
          return 1
        fi
        mv "$k.new" "$k"
        sync "$k"
      }
      genkey() { # private key file, atomically
        [ -e "$1" ] && return 0
        openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$1.tmp"
        sync "$1.tmp"
        mv "$1.tmp" "$1"
      }
      pubof() { # key pub
        openssl pkey -in "$1" -pubout -out "$2.tmp"
        mv "$2.tmp" "$2"
      }
      enroll() { # public key: re-enrol both TPM slots under it (adds the new slot, then wipes the old)
        ${cryptenroll} --unlock-key-file=$st/maint-whombat-root.key --tpm2-device=auto \
          --tpm2-public-key="$1" --tpm2-public-key-pcrs=11 --tpm2-pcrs=${pcrList} --wipe-slot=tpm2 \
          /dev/disk/by-partlabel/whombat-root
        ${cryptenroll} --unlock-key-file=$st/maint-whombat-persist.key --tpm2-device=auto \
          --tpm2-public-key="$1" --tpm2-public-key-pcrs=11 --tpm2-pcrs=${pcrList}+15:sha256="$pcr15" --wipe-slot=tpm2 \
          /dev/disk/by-partlabel/whombat-persist
      }

      maint whombat-root
      maint whombat-persist
      genkey ${policyKey}
      pubof ${policyKey} ${policyPub}
      enrolled=""
      # Revocation (N-1): a generation that was signed with the current key and has left the system
      # profile could still unseal. Rotate the key: sign the kept generations with both keys, move both
      # TPM slots to the new key, then drop the old key. Every step is resumable after a crash.
      if [ ! -e ${nextKey} ]; then
        gone=$(whombat-tpm-policy revoked --record ${record} --profiles /nix/var/nix/profiles --public-key ${policyPub})
        if [ -n "$gone" ]; then
          echo "generations left the system profile; rotating the PCR policy key:" "$gone"
          genkey ${nextKey}
        fi
      fi
      if [ -e ${nextKey} ]; then
        pubof ${nextKey} ${nextPub}
        ${lib.getExe tpmSign} /boot
        enroll ${nextPub}
        mv ${nextKey} ${policyKey}
        sync ${policyKey}
        pubof ${policyKey} ${policyPub}
        rm -f ${nextPub}
        enrolled=yes
        echo "PCR policy key rotated"
      fi
      ${lib.getExe tpmSign} /boot
      fp=$(sha256sum ${policyPub} | cut -c1-16)
      want="v3 pcrs=${pcrList} signed-pcr11=$fp phase=enter-initrd persist-pcr15=$pcr15"
      if [ "$(cat $marker 2>/dev/null || true)" = "$want" ]; then exit 0; fi
      [ -n "$enrolled" ] || enroll ${policyPub}
      echo "$want" > $marker.tmp && sync $marker.tmp && mv $marker.tmp $marker
      echo "TPM2 keyslots sealed: PCR ${pcrList} + signed PCR 11 (enter-initrd; root, /persist) + PCR 15 root binding (/persist)"
    '';
  };

  # lzbt with the policy signature added to every install.
  lzbt =
    let
      real = config.whombat.boot.lzbtPackage;
    in
    pkgs.writeShellApplication {
      name = "lzbt";
      text = ''
        ${lib.getExe real} "$@"
        for a in "$@"; do
          if [ "$a" = install ]; then
            ${lib.getExe tpmSign} ${config.boot.loader.efi.efiSysMountPoint}
            break
          fi
        done
      '';
    };
in
{
  options.whombat.storage = {
    mode = lib.mkOption {
      type = lib.types.enum [
        "luks-tpm2"
        "host-encrypted"
        "plain"
      ];
      default = if platform == "self-installed" then "host-encrypted" else "luks-tpm2";
      defaultText = lib.literalExpression ''if platform == "self-installed" then "host-encrypted" else "luks-tpm2"'';
      description = ''
        `luks-tpm2`: the device layout above. `host-encrypted` (self-installed only): the same partitions and
        /persist layout without LUKS (PI-02, PI-20; the name is historical, nothing requires encryption under
        it). `plain`: the profile provides
        unencrypted filesystems (development images and VM tests only; refused for prod).
      '';
    };
    tpm2Pcrs = lib.mkOption {
      type = lib.types.listOf lib.types.int;
      default = [ 7 ];
      description = ''
        PCRs whose current values the TPM2 keyslots are bound to once the device runs with Secure Boot
        enforced (NX-12), in addition to the signed PCR 11 policy (and PCR 15 for /persist). PCR 7 (Secure
        Boot policy and the db certificate that verified the boot) is the same for every signed
        generation; a changed key database, disabled Secure Boot or a foreign boot chain does not unlock.
      '';
    };
    requireSecureBootForSeal = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = ''
        Only seal the TPM slots to PCRs once Secure Boot is enforced (the factory installs with an
        unbound TPM slot while the firmware is still in setup mode). Disable only in VM tests whose
        firmware has no Secure Boot.
      '';
    };
    persistReserveMiB = lib.mkOption {
      type = lib.types.int;
      default = 4096;
      description = ''
        Space on /persist that only PostgreSQL (and recovery) can use: every other writable subvolume is in
        one btrfs qgroup limited to the filesystem size minus this (at least 5 %), so staging, workspaces,
        home or backup filling up cannot stop database writes (NX-12).
      '';
    };
    extraSubvolumes = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      internal = true;
      description = ''
        More subvolumes in Whombat's own qgroup (1/100), created after `subvolumes` and in this order (a nested one after
        its parent). hermes.nix adds Hermes's root, agent.nix the agent's home (NX-465), hosts.nix the hub's data and
        `hosts-backup`, where the hub makes its own backup, the backup's `hosts` source (NX-407).
      '';
    };
    qgroups = lib.mkOption {
      type = lib.types.attrsOf lib.types.str;
      readOnly = true;
      default = {
        whombat = "1/100";
        containers = "1/101";
        all = "2/100";
      };
      description = ''
        The qgroups (NX-12, NX-150, NX-458): `all` holds every subvolume but PostgreSQL's and is limited to /persist's
        usable size minus the reserve; in it `whombat` (Whombat's own subvolumes) and `containers` (the agent's
        containers', with a limit of their own; the agents' computers' before NX-455).
      '';
    };
    qgroupsCheck = lib.mkOption {
      type = lib.types.package;
      readOnly = true;
      internal = true;
      default = qgroupsScript;
      description = "whombat-qgroups' script.";
    };
    containers = {
      subvolumes = lib.mkOption {
        type = lib.types.listOf lib.types.str;
        default = [ ];
        internal = true;
        description = ''
          Subvolumes in the containers' qgroup (1/101) only, created like the others; every subvolume nested in one is
          put there too (whombat-qgroups). containers.nix adds the containers' storage (NX-458).
        '';
      };
      percent = lib.mkOption {
        type = lib.types.nullOr (lib.types.ints.between 1 100);
        default = null;
        internal = true;
        description = "1/101's limit, a share of /persist's usable size (`whombat.containers.storagePercent`); null: none.";
      };
    };
    subvolumes = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [
        "whombat/home"
        "whombat/workspaces"
        "whombat/credentials"
        "secrets"
        "manager"
        "backup"
      ];
      description = ''
        Subvolumes under /persist in the limited qgroup (1/100). home, workspaces, credentials and secrets
        are backup snapshot sources (BK-04), as is hermes.nix's whombat/hermes (an extra subvolume, BK-36); postgres
        is a separate, unlimited nodatacow subvolume.
      '';
    };
  };

  config = lib.mkMerge [
    {
      assertions = [
        {
          assertion = cfg.mode != "plain" || config.whombat.environment != "prod";
          message = "whombat.storage.mode = \"plain\" is for development and tests only, never prod";
        }
        {
          # PI-02, PI-18: the layout without LUKS is the self-install platform's.
          assertion = cfg.mode != "host-encrypted" || platform == "self-installed";
          message = "whombat.storage.mode = \"host-encrypted\" needs whombat.platform = \"self-installed\" (PI-02, PI-18)";
        }
        {
          # The self-installed platform uses no TPM, so it can't unlock LUKS volumes sealed to one.
          assertion = cfg.mode != "luks-tpm2" || platform == "factory";
          message = "whombat.platform = \"self-installed\" has no TPM: its storage is host-encrypted (or plain in tests), never luks-tpm2";
        }
      ];

      # What the installer and the storage tools read to tell the layouts apart.
      environment.etc."whombat/platform".text = "${platform} ${cfg.mode}\n";

      boot.initrd.systemd.enable = true;
      boot.initrd.supportedFilesystems = [
        "ext4"
        "btrfs"
        "vfat"
      ];

      boot.supportedFilesystems = [ "btrfs" ];
      environment.systemPackages = [ pkgs.btrfs-progs ];

      # Subvolumes and quota before tmpfiles lays out owners/modes (idempotent, every boot).
      systemd.services.whombat-persist-layout = {
        description = "Whombat /persist subvolumes and capacity limits";
        wantedBy = [ "whombat-persist.target" ];
        before = [
          "systemd-tmpfiles-setup.service"
          "whombat-persist.target"
          "postgresql.service"
        ];
        after = [ "local-fs.target" ];
        unitConfig = {
          DefaultDependencies = false;
          RequiresMountsFor = [ p ];
        };
        path = [
          pkgs.btrfs-progs
          pkgs.util-linux
          pkgs.coreutils
          pkgs.e2fsprogs
          pkgs.findutils
          pkgs.gawk
          pkgs.gnugrep
          pkgs.jq
        ];
        serviceConfig = {
          Type = "oneshot";
          RemainAfterExit = true;
        };
        script = ''
          set -eu
          if [ "$(findmnt -n -o FSTYPE --target ${p})" != btrfs ] || [ "$(findmnt -n -o TARGET --target ${p})" != ${p} ]; then
            echo "${p} is not its own btrfs filesystem: no subvolumes, no capacity limits (backups fall back to copies)" >&2
            exit 0
          fi
          subvol() { # create $1 as a subvolume unless it exists; never convert data in place
            if [ -e "$1" ]; then
              btrfs subvolume show "$1" >/dev/null 2>&1 && return 0
              # Installation (nixos-install's activation) leaves these as plain, empty directories before the first
              # boot (NX-63): a tree of nothing but empty directories holds no data and becomes a subvolume;
              # tmpfiles restores owners and modes after this unit.
              if [ -d "$1" ] && [ ! -L "$1" ] && [ -z "$(find "$1" -xdev -mindepth 1 \( ! -type d -o -inum 256 \) -print -quit)" ]; then
                rm -r "$1"
                btrfs subvolume create "$1" >/dev/null
                echo "$1: empty directory made a subvolume"
              else
                echo "$1 exists but is not a subvolume (left as is)" >&2
              fi
            else
              mkdir -p "$(dirname "$1")"
              btrfs subvolume create "$1" >/dev/null
            fi
          }
          subvol ${p}/postgres
          chattr +C ${p}/postgres 2>/dev/null || true   # no copy-on-write for database files
          mkdir -p ${p}/postgres/17 && chattr +C ${p}/postgres/17 2>/dev/null || true
          ${lib.concatMapStringsSep "\n" (v: "subvol ${p}/${v}") (limited ++ comp.subvolumes)}

          btrfs quota enable ${p}
          ${qgroupLib}
          size=$(persistsize)
          reserve=$(( ${toString cfg.persistReserveMiB} * 1024 * 1024 ))
          min=$(( size / 20 ))
          [ "$reserve" -ge "$min" ] || reserve=$min
          limit=$(( size - reserve ))
          ${
            if comp.percent == null then
              "climit=none"
            else
              "climit=$(( size / 100 * ${toString comp.percent} ))"
          }
          # The layout (NX-150, NX-458; amends NX-12), in an order that never leaves the data outside a limit it was in:
          # 2/100 gets the reserve's limit before anything joins it, 1/100 (which had that limit) joins it before its
          # own limit goes, and the containers' qgroup 1/101 has its limit before a subvolume joins it.
          for q in ${qg.whombat} ${qg.containers} ${qg.all}; do qgexists $q || btrfs qgroup create $q ${p}; done
          btrfs qgroup limit $limit ${qg.all} ${p}
          for q in ${qg.whombat} ${qg.containers}; do
            qgin $q ${qg.all} || btrfs qgroup assign --no-rescan $q ${qg.all} ${p} >/dev/null || echo "$q didn't join ${qg.all}" >&2
          done
          climited=0
          btrfs qgroup limit $climit ${qg.containers} ${p} && climited=1 || echo "${qg.containers} didn't get its limit" >&2
          for v in ${lib.concatMapStringsSep " " (v: "${p}/${v}") limited}; do
            id=$(subvolid "$v")
            [ -n "$id" ] || continue
            qgin "0/$id" ${qg.whombat} || btrfs qgroup assign --no-rescan "0/$id" ${qg.whombat} ${p} >/dev/null || true
          done
          # The containers' subvolumes: in 1/101 only.
          for v in ${lib.concatMapStringsSep " " (v: "${p}/${v}") comp.subvolumes}; do
            id=$(subvolid "$v")
            [ -n "$id" ] || continue
            [ "$(qgparents "0/$id" | tr '\n' ' ')" = "${qg.containers} " ] && continue
            if [ "$climited" = 1 ] && qgin ${qg.containers} ${qg.all} && qgonly "0/$id" ${qg.containers}; then
              btrfs qgroup limit none "0/$id" ${p} || true
              echo "$v: now in ${qg.containers} only, the containers' qgroup"
            else
              echo "$v couldn't be moved into ${qg.containers}; it stays where it was" >&2
            fi
          done
          # The reserve's limit is 2/100's once 1/100 is in it.
          if qgin ${qg.whombat} ${qg.all}; then btrfs qgroup limit none ${qg.whombat} ${p} || true; fi
          # A rescan walks every extent of /persist (the containers' layers make many) and holds up everything behind
          # whombat-persist.target: only when btrfs says the counts are off (a qgroup that joined another without
          # counts btrfs could carry over, NX-150), and then before anything that writes starts.
          if qginconsistent; then
            echo "the qgroup counts are off: rescanning"
            btrfs quota rescan -w ${p} >/dev/null 2>&1 || true
          fi
          echo "subvolumes ready; everything but PostgreSQL limited to $(( limit / 1048576 )) MiB${
            lib.optionalString (comp.percent != null) ", the containers to $(( climit / 1048576 )) MiB"
          }"
        '';
      };

      # NX-150, NX-458: the containers' subvolumes stay in 1/101, and counts btrfs lost track of are rescanned at once (a
      # snapshot of a subvolume in a qgroup that shares data outside it, a backup's snapshot, a big subvolume deleted:
      # until the rescan btrfs counts no writes against any limit, the reserve's included). Every minute. Quiet unless it
      # acts.
      systemd.services.whombat-qgroups = {
        description = "Whombat qgroups: the containers' subvolumes in their qgroup, lost counts rescanned";
        after = [ "whombat-persist-layout.service" ];
        unitConfig.RequiresMountsFor = [ p ];
        serviceConfig = {
          Type = "oneshot";
          ExecStart = qgroupsScript;
          LogLevelMax = "notice";
        };
      };
      systemd.timers.whombat-qgroups = {
        wantedBy = [ "timers.target" ];
        timerConfig = {
          OnBootSec = "1min";
          OnUnitInactiveSec = "1min";
          AccuracySec = "5s";
        };
      };
    }

    (lib.mkIf hostEncrypted {
      # The layout of luks-tpm2 without the mapper devices (whombat-install --platform self-installed).
      fileSystems = {
        "/" = {
          device = "/dev/disk/by-partlabel/whombat-root";
          fsType = "ext4";
          options = [ "noatime" ];
        };
        "${p}" = {
          device = "/dev/disk/by-partlabel/whombat-persist";
          fsType = "btrfs";
          options = [
            "noatime"
            "nosuid"
            "nodev"
            "user_subvol_rm_allowed"
          ];
          neededForBoot = true;
        };
        "/boot" = {
          device = "/dev/disk/by-partlabel/whombat-esp";
          fsType = "vfat";
          options = [
            "umask=0077"
            "nosuid"
            "nodev"
            "noexec"
          ];
        };
      };
      # lanzaboote still installs every generation (boot counting and fallback, NX-04/NX-05); nothing to sign
      # a PCR policy for. Its keys are generated on the device and never enrolled (boot.nix).
      boot.lanzaboote.package = lib.mkIf (config.whombat.boot.lzbtPackage != null) config.whombat.boot.lzbtPackage;
    })

    (lib.mkIf luks {
      fileSystems = {
        "/" = {
          device = "/dev/mapper/whombat-root";
          fsType = "ext4";
          options = [ "noatime" ];
        };
        "${p}" = {
          device = "/dev/mapper/whombat-persist";
          fsType = "btrfs";
          options = [
            "noatime"
            "nosuid"
            "nodev"
            "user_subvol_rm_allowed" # the runner may delete per-task subvolumes it created (W3-SBX)
          ];
          neededForBoot = true;
        };
        "/boot" = {
          device = "/dev/disk/by-partlabel/whombat-esp";
          fsType = "vfat";
          options = [
            "umask=0077"
            "nosuid"
            "nodev"
            "noexec"
          ];
        };
      };
      boot.initrd.luks.devices = {
        whombat-root = {
          device = "/dev/disk/by-partlabel/whombat-root";
          allowDiscards = true;
          crypttabExtraOpts = [
            "tpm2-device=auto"
            "token-timeout=30"
            # Extends PCR 15 with an HMAC of the root volume key: /persist is sealed to the result.
            "tpm2-measure-pcr=yes"
          ];
        };
        whombat-persist = {
          device = "/dev/disk/by-partlabel/whombat-persist";
          allowDiscards = true;
          crypttabExtraOpts = [
            "tpm2-device=auto"
            "token-timeout=30"
          ];
        };
      };
      boot.initrd.availableKernelModules = [
        "dm_crypt"
        "tpm_crb"
        "tpm_tis"
      ];

      assertions = [
        {
          assertion = config.whombat.boot.lzbtPackage != null;
          message = "luks-tpm2 storage needs whombat.boot.lzbtPackage (the PCR policy is signed after every lzbt install)";
        }
      ];
      boot.lanzaboote.package = lib.mkIf (config.whombat.boot.lzbtPackage != null) lzbt;
      environment.systemPackages = [
        tpmSign
        sealScript
        pkgs.whombat-update-helper
      ];

      # Boot phases in PCR 11 (enter-initrd, leave-initrd, sysinit, ready, …): only enter-initrd is signed,
      # so the TPM releases the disk keys in the initrd and never after it (N-2).
      boot.initrd.systemd.tpm2.pcrphases.enable = true;
      systemd.tpm2.pcrphases.enable = true;

      # The PCR signature lives on the ESP (the initrd cannot carry it: it is part of what is measured).
      # Copy it to /run/systemd, where systemd-cryptsetup looks, after the enter-initrd phase was measured
      # and before any volume is opened. A missing or stale signature only means the console asks for
      # the recovery key.
      boot.initrd.systemd.services.whombat-pcr-signature = {
        description = "Load the device's signed TPM2 PCR policy from the ESP";
        wantedBy = [ "cryptsetup-pre.target" ];
        before = [ "cryptsetup-pre.target" ];
        wants = [
          "systemd-pcrphase-initrd.service"
          "dev-disk-by\\x2dpartlabel-whombat\\x2desp.device"
        ];
        after = [
          "systemd-pcrphase-initrd.service"
          "dev-disk-by\\x2dpartlabel-whombat\\x2desp.device"
        ];
        unitConfig.DefaultDependencies = false;
        serviceConfig = {
          Type = "oneshot";
          RemainAfterExit = true;
          TimeoutStartSec = 60;
        };
        script = ''
          m=/run/whombat-esp
          mkdir -p $m /run/systemd
          if mount -t vfat -o ro,nosuid,nodev,noexec /dev/disk/by-partlabel/whombat-esp $m; then
            # The ESP is FAT (not journaled): the document is written twice; use the first valid copy.
            found=""
            for f in $m/${espSignature} $m/${lib.removeSuffix ".json" espSignature}.copy.json; do
              if [ -f "$f" ] && whombat-tpm-policy check "$f"; then
                cp "$f" /run/systemd/tpm2-pcr-signature.json.tmp
                mv /run/systemd/tpm2-pcr-signature.json.tmp /run/systemd/tpm2-pcr-signature.json
                found=$f
                break
              fi
            done
            [ -n "$found" ] || echo "no valid signed PCR policy on the ESP (not sealed yet, or damaged)"
            umount $m
          else
            echo "ESP not mountable: no signed PCR policy" >&2
          fi
          rmdir $m || true
        '';
      };
      boot.initrd.systemd.extraBin.whombat-tpm-policy = "${pkgs.whombat-update-helper}/bin/whombat-tpm-policy";
      # Root first (it extends PCR 15), then /persist; both after the signature is in place.
      boot.initrd.systemd.services."systemd-cryptsetup@whombat\\x2droot" = {
        overrideStrategy = "asDropin";
        wants = [ "whombat-pcr-signature.service" ];
        after = [ "whombat-pcr-signature.service" ];
      };
      boot.initrd.systemd.services."systemd-cryptsetup@whombat\\x2dpersist" = {
        overrideStrategy = "asDropin";
        wants = [ "whombat-pcr-signature.service" ];
        after = [
          "whombat-pcr-signature.service"
          "systemd-cryptsetup@whombat\\x2droot.service"
        ];
      };

      # Seal the TPM2 keyslots once Secure Boot is enforced (factory: first boot after key enrolment;
      # existing devices: first boot with this policy). Re-signs on every boot; re-seals (and rotates the
      # policy key when generations were removed) whenever the system profile changes.
      systemd.services.whombat-tpm-seal = {
        description = "Seal the disk TPM2 keyslots to this device's boot policy";
        wantedBy = [ "multi-user.target" ];
        after = [
          "whombat-persist.target"
          "systemd-pcrphase.service"
          "boot.mount"
        ];
        unitConfig = lib.mkMerge [
          {
            ConditionPathExists = "/dev/tpmrm0";
            RequiresMountsFor = [ "/boot" ];
          }
          (lib.mkIf cfg.requireSecureBootForSeal { ConditionSecurity = "uefi-secureboot"; })
        ];
        serviceConfig = {
          Type = "oneshot";
          RemainAfterExit = true;
          ExecStart = lib.getExe sealScript;
          StateDirectory = "whombat-storage";
          StateDirectoryMode = "0700";
        };
      };
      systemd.services.whombat-tpm-reseal = {
        description = "Re-seal the disk TPM2 keyslots after the system profile changed";
        after = [ "whombat-tpm-seal.service" ];
        unitConfig = lib.mkMerge [
          {
            ConditionPathExists = [
              "/dev/tpmrm0"
              "${stateDir}/tpm-seal"
            ];
            RequiresMountsFor = [ "/boot" ];
          }
          (lib.mkIf cfg.requireSecureBootForSeal { ConditionSecurity = "uefi-secureboot"; })
        ];
        serviceConfig = {
          Type = "oneshot";
          ExecStart = lib.getExe sealScript;
        };
      };
      systemd.paths.whombat-tpm-reseal = {
        wantedBy = [ "multi-user.target" ];
        pathConfig.PathChanged = "/nix/var/nix/profiles";
      };
      systemd.timers.whombat-tpm-reseal = {
        wantedBy = [ "timers.target" ];
        timerConfig = {
          OnBootSec = "15min";
          OnUnitActiveSec = "6h";
        };
      };
    })
  ];
}
