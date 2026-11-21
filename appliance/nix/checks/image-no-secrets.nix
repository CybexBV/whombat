# The image and the system closure carry no per-device state (NX-24, R-17): no identity or key files,
# no random seed, no machine-id, no SSH host keys, no Secure Boot keys, no private key in any of our
# own store paths.
{
  runCommand,
  closureInfo,
  util-linux,
  e2fsprogs,
  btrfs-progs,
  mtools,
  jq,
  gnugrep,
  toplevel,
  image,
}:
let
  closure = closureInfo { rootPaths = [ toplevel ]; };
in
runCommand "whombat-image-no-secrets"
  {
    nativeBuildInputs = [
      util-linux
      e2fsprogs
      btrfs-progs
      mtools
      jq
      gnugrep
    ];
  }
  ''
    set -euo pipefail
    fail() { echo "FAIL: $*" >&2; exit 1; }

    # --- system closure -------------------------------------------------------------------------
    etc=${toplevel}/etc
    for f in machine-id ssh/ssh_host_ed25519_key ssh/ssh_host_rsa_key; do
      [ ! -e "$etc/$f" ] || fail "closure contains /etc/$f"
    done
    ours=$(grep -E '^/nix/store/[a-z0-9]+-whombat' ${closure}/store-paths || true)
    for p in $ours; do
      # A PEM header followed by a key body. (Header strings alone occur in crypto libraries, e.g. the
      # Claude Code binary's bundled JS; vendor bundles are additionally pinned by hash.)
      if grep -rlaPz 'BEGIN (OPENSSH |EC |RSA )?PRIVATE KEY-----\r?\n[A-Za-z0-9+/=]{40}' "$p" 2>/dev/null; then
        fail "private key material in $p"
      fi
      if find "$p" \( -name management.key -o -name content.key -o -name master.key -o -name claim.json \
           -o -name random-seed -o -name 'db.key' -o -name 'PK.key' -o -name 'KEK.key' \) | grep -q .; then
        fail "identity/key file in $p"
      fi
    done
    echo "closure: $(wc -l < ${closure}/store-paths) paths, $(echo "$ours" | wc -w) of ours, clean"

    # --- disk image -----------------------------------------------------------------------------
    raw=$(echo ${image}/*.raw)
    sfdisk --json "$raw" > parts.json
    extract() { # $1 partition name → file
      local start size
      start=$(jq -r --arg n "$1" '.partitiontable.partitions[] | select(.name==$n) | .start' parts.json)
      size=$(jq -r --arg n "$1" '.partitiontable.partitions[] | select(.name==$n) | .size' parts.json)
      [ -n "$start" ] || fail "no partition $1"
      dd if="$raw" of="$2" bs=512 skip="$start" count="$size" status=none
    }
    extract whombat-esp esp.img
    extract whombat-root root.img
    extract whombat-persist persist.img

    if mdir -i esp.img ::/loader 2>/dev/null | grep -qi 'random-seed\|random-s~'; then fail "ESP has loader/random-seed"; fi
    if mdir -i esp.img ::/loader/keys 2>/dev/null | grep -qi auth; then fail "ESP carries Secure Boot keys"; fi
    mdir -i esp.img ::/EFI/Linux | grep -i nixos >/dev/null || fail "ESP has no NixOS entry"
    if mdir -i esp.img ::/EFI/Linux | grep -q '+'; then fail "factory entry is not blessed"; fi

    for f in /etc/machine-id /var/lib/systemd/random-seed /var/lib/sbctl /etc/ssh; do
      if debugfs -R "stat $f" root.img 2>&1 | grep -q 'Inode:'; then fail "root image contains $f"; fi
    done
    # The persist partition is an empty btrfs: its top-level tree has no directory entries.
    if btrfs inspect-internal dump-tree -t 5 persist.img | grep -q 'DIR_ITEM\|DIR_INDEX'; then
      btrfs inspect-internal dump-tree -t 5 persist.img | grep 'name' | head >&2
      fail "persist image is not empty"
    fi
    echo "image: ESP, root and persist carry no per-device state"
    touch $out
  ''
