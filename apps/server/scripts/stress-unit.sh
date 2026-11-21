#!/usr/bin/env bash
# Runs the workspace unit tests (`pnpm test`, root vitest projects) under CPU pressure: COPIES parallel
# copies while BURN busy loops compete for the CPU. Companion of stress-int.sh.
#
#   apps/server/scripts/stress-unit.sh [COPIES=4] [BURN=nproc] [TAG=unit] [-- extra vitest args]
#
# Logs go to tmp/stress/<TAG>/copy<N>.log (gitignored); the summary lists every failing test.
set -u
root=$(cd "$(dirname "$0")/../../.." && pwd)
COPIES=${1:-4}
BURN=${2:-$(nproc)}
TAG=${3:-unit}
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
    cd "$root" || exit 1
    npx vitest run "$@" >"$out/copy$c.log" 2>&1
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
