# Shared helpers for hardware qualification scripts (sourced). Evidence goes to $HQ_OUT (default
# /persist/hq/<unit-serial>/<test>/<timestamp>) and is copied to a WBFACTORY medium by hq-export.sh.
set -eu
HQ_SERIAL=$(cat /sys/class/dmi/id/product_serial 2>/dev/null || echo unknown)
HQ_TEST=${HQ_TEST:-$(basename "$0" .sh)}
HQ_OUT=${HQ_OUT:-/persist/hq/$HQ_SERIAL/$HQ_TEST/$(date -u +%Y%m%dT%H%M%SZ)}
mkdir -p "$HQ_OUT"
say() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" | tee -a "$HQ_OUT/log.txt"; }
capture() { # capture NAME CMD...
  local name=$1; shift
  { echo "\$ $*"; "$@" 2>&1 || echo "(exit $?)"; } > "$HQ_OUT/$name.txt"
}
baseline() {
  capture dmi sh -c 'for f in sys_vendor product_name product_serial bios_vendor bios_version bios_date board_name; do printf "%s: %s\n" $f "$(cat /sys/class/dmi/id/$f 2>/dev/null)"; done'
  capture bootctl bootctl status
  capture entries ls -la /boot/EFI/Linux
  capture boots journalctl --list-boots --no-pager
  capture current readlink -f /run/current-system
  capture luks-root systemd-cryptenroll /dev/disk/by-partlabel/whombat-root
  capture luks-persist systemd-cryptenroll /dev/disk/by-partlabel/whombat-persist
  capture tpm-seal cat /var/lib/whombat-storage/tpm-seal
  capture pcrs systemd-analyze pcrs
  capture watchdog wdctl
  capture units systemctl --no-pager --failed
}
result() { # result PASS|FAIL|INCONCLUSIVE "observation"
  printf '%s\t%s\t%s\t%s\n' "$HQ_TEST" "$HQ_SERIAL" "$1" "$2" | tee -a "$HQ_OUT/result.tsv"
}
