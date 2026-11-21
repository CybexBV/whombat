#!/bin/sh
# HQ-02 TPM unlock across firmware/TPM changes. Run `record` before and after each change listed in
# the runbook (firmware update, Secure Boot db/dbx change, TPM clear, setup-mode toggle, board swap).
. "$(dirname "$0")/lib.sh"
case "${1:-}" in
  record)
    baseline
    capture pcr7 sh -c 'systemd-analyze pcrs 7'
    capture unlocked-by journalctl -b -u systemd-cryptsetup@whombat\\x2droot.service -u systemd-cryptsetup@whombat\\x2dpersist.service --no-pager
    if grep -qi 'passphrase\|recovery' "$HQ_OUT/unlocked-by.txt"; then
      result INCONCLUSIVE "this boot asked for the recovery key (expected after a PCR 7 change)"
    else
      result PASS "unattended TPM unlock on this boot"
    fi ;;
  *) echo "usage: $0 record" >&2; exit 2 ;;
esac
