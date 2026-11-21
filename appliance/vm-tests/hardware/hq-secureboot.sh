#!/bin/sh
# HQ-03 Secure Boot enforcement: an unsigned or foreign-signed UKI must not boot. `plant` copies an
# unsigned copy of the current generation to the ESP as the default entry; after reboot the firmware must
# refuse it (systemd-boot shows a security violation and falls back). `verify` records the outcome and
# removes the planted file.
. "$(dirname "$0")/lib.sh"
case "${1:-}" in
  plant)
    baseline
    cur=$(ls /boot/EFI/Linux/nixos-generation-*.efi | sort -V | tail -1)
    cp "$cur" /boot/EFI/Linux/nixos-generation-9999-unsigned.efi
    sbattach --remove /boot/EFI/Linux/nixos-generation-9999-unsigned.efi 2>/dev/null || true
    say "planted unsigned entry; reboot and watch the console" ;;
  verify)
    baseline
    if grep -q 9999 "$HQ_OUT/current.txt"; then result FAIL "unsigned entry booted"; else result PASS "unsigned entry refused"; fi
    rm -f /boot/EFI/Linux/nixos-generation-9999-unsigned.efi ;;
  *) echo "usage: $0 plant | verify" >&2; exit 2 ;;
esac
