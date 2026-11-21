#!/usr/bin/env bash
# Runs the server integration suite under CPU pressure to shake out timing-dependent failures:
# COPIES parallel copies of `vitest run --config vitest.int.config.ts` (each file uses its own throwaway
# database, each app listens on port 0) while BURN busy loops compete for the CPU.
#
#   apps/server/scripts/stress-int.sh [COPIES=4] [BURN=nproc] [TAG=run] [-- extra vitest args]
#
# Logs go to tmp/stress/<TAG>/copy<N>.log (gitignored); the summary lists every failing test.
set -u
here=$(cd "$(dirname "$0")/.." && pwd)
root=$(cd "$here/../.." && pwd)
COPIES=${1:-4}
BURN=${2:-$(nproc)}
TAG=${3:-run}
shift $(($# < 3 ? $# : 3))
[ "${1:-}" = "--" ] && shift
out="$root/tmp/stress/$TAG"
rm -rf "$out"
mkdir -p "$out"

burners=()
for _ in $(seq 1 "$BURN"); do
  (while :; do :; done) &
  burners+=($!)
done
trap 'kill "${burners[@]}" 2>/dev/null' EXIT

copies=()
for c in $(seq 1 "$COPIES"); do
  (
    cd "$here" || exit 1
    npx vitest run --config vitest.int.config.ts "$@" >"$out/copy$c.log" 2>&1
    echo $? >"$out/copy$c.rc"
  ) &
  copies+=($!)
done
wait "${copies[@]}"

status=0
for c in $(seq 1 "$COPIES"); do
  rc=$(cat "$out/copy$c.rc")
  [ "$rc" = 0 ] || status=1
  echo "copy$c rc=$rc $(grep -E '^ +Tests ' "$out/copy$c.log")"
  grep -E '^ *(FAIL|×) ' "$out/copy$c.log" | sort -u
done
exit $status
