#!/bin/sh
# HQ-01 Watchdog. `hq-watchdog.sh arm` hangs the kernel without an automatic panic reboot; only the
# hardware watchdog (petted by PID 1, RuntimeWatchdogSec) can reset the unit. After the reset, run
# `hq-watchdog.sh verify <armed-at-epoch>`.
. "$(dirname "$0")/lib.sh"
case "${1:-}" in
  arm)
    baseline
    wdctl > "$HQ_OUT/wdctl-before.txt" 2>&1 || { result FAIL "no watchdog device"; exit 1; }
    date +%s > /persist/hq/watchdog-armed-at
    say "hanging the kernel now; expect a reset within ~2x RuntimeWatchdogSec (60 s). Start a stopwatch."
    sync
    sysctl -q kernel.panic=0 kernel.sysrq=1
    echo c > /proc/sysrq-trigger ;;
  verify)
    armed=$(cat /persist/hq/watchdog-armed-at)
    baseline
    capture previous-boot journalctl -b -1 -n 50 --no-pager
    say "armed at $armed; now $(date +%s); boots:"; cat "$HQ_OUT/boots.txt" >> "$HQ_OUT/log.txt"
    result INCONCLUSIVE "operator records reset delay (stopwatch) and that no manual power cycle was needed" ;;
  *) echo "usage: $0 arm | verify" >&2; exit 2 ;;
esac
