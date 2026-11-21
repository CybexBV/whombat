#!/usr/bin/env bash
# fast-test's full run on the build server (.fast-test.json, `full`): the whole suite of each part of the repository.
#
#   whombat     pnpm check: everything outside appliance/ and hosts/
#   appliance   appliance/scripts/ci/fast-test-full.sh: its Go tests, the harness and the console page
#   hosts       the hosts service's Go lint and tests (with the race detector) and its web UI's types and tests
#
# For a wide change fast-test names the commit the change started from (FAST_TEST_BASE): only the parts whose files
# changed run. Without one (the nightly run, `fast-test --full`) all three run. FULL_PARTS="appliance hosts" picks
# them by hand. Every part runs even when an earlier one failed, and the last line names what failed. The NixOS builds
# and VM tests are not here: the maintainers' CI runs them (ci/platform/).
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 2
all=(whombat appliance hosts)
parts=("${all[@]}")
if [ -n "${FULL_PARTS:-}" ]; then
  read -r -a parts <<<"$FULL_PARTS"
elif [ -n "${FAST_TEST_BASE:-}" ] && changed=$(git diff --name-only "$FAST_TEST_BASE" HEAD 2>/dev/null) && [ -n "$changed" ]; then
  # What the parts share runs them all: the recipe, these scripts, public CI.
  if ! grep -qE '^(\.fast-test\.json$|scripts/ci/|\.github/)' <<<"$changed"; then
    parts=()
    ! grep -qvE '^(appliance|hosts)/' <<<"$changed" || parts+=(whombat)
    # The appliance's Go module builds against contracts/go (its go.mod's replace).
    ! grep -qE '^(appliance|contracts/go)/' <<<"$changed" || parts+=(appliance)
    ! grep -q '^hosts/' <<<"$changed" || parts+=(hosts)
  fi
fi
# The build server's container starts with the workspace's packages only; a folder's tools come when its part runs.
prepare() { [ "${WHOMBAT_CHECK:-}" != 1 ] || scripts/ci/fast-test-prepare.sh "$1"; }

whombat() { pnpm check; }
appliance() { prepare appliance && (cd appliance && scripts/ci/fast-test-full.sh); }
hosts() {
  prepare hosts && (cd hosts && make lint-go test-go GO=go && cd web && pnpm typecheck && pnpm test)
}

failed=()
for part in "${parts[@]}"; do
  case $part in
    whombat | appliance | hosts) ;;
    *) echo "full: unknown part $part (whombat, appliance or hosts)" >&2; exit 2 ;;
  esac
  echo "full: $part"
  started=$SECONDS
  if "$part"; then
    echo "full: $part passed in $((SECONDS - started)) s"
  # The Whombat part runs a failing test once more by itself (scripts/vitest-project.ts); a folder's part runs again.
  elif [ "$part" != whombat ] && echo "full: $part failed, once more" && "$part"; then
    echo "full: $part passed the second time in $((SECONDS - started)) s"
  else
    echo "full: $part failed after $((SECONDS - started)) s"
    failed+=("$part")
  fi
done
[ ${#failed[@]} -eq 0 ] || { echo "full: failed: ${failed[*]}"; exit 1; }
echo "full: passed: ${parts[*]:-nothing to run}"
