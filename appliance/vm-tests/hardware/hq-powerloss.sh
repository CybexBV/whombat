#!/bin/sh
# HQ-04 Power loss at each update transition. `watch` follows the manager's journal and prints each
# state change so the operator (or a switched PDU driven by $HQ_PDU_OFF) cuts power at the target
# state. After power returns, `verify` records the manager's recovered state, boot and runtime health.
. "$(dirname "$0")/lib.sh"
case "${1:-}" in
  watch)
    target=${2:?target state, e.g. Activating}
    say "waiting for manager state $target"
    journalctl -f -o cat -u whombat-manager.service | while read -r line; do
      echo "$line" >> "$HQ_OUT/manager.log"
      case "$line" in *"$target"*)
        say "REACHED $target — cut power now"
        [ -n "${HQ_PDU_OFF:-}" ] && sh -c "$HQ_PDU_OFF"
        ;; esac
    done ;;
  verify)
    baseline
    capture manager journalctl -b -u whombat-manager.service --no-pager
    capture health sh -c 'curl -s --unix-socket /run/whombat/admin.sock http://runtime/health'
    capture fsck-journal journalctl -b -k --no-pager -g 'EXT4-fs|recovery|orphan'
    result INCONCLUSIVE "operator compares recovered manager state with the journal state at power cut" ;;
  *) echo "usage: $0 watch <State> | verify" >&2; exit 2 ;;
esac
