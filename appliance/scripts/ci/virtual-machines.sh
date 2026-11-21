#!/usr/bin/env bash
set -euo pipefail
test -r /dev/kvm && test -w /dev/kvm
mkdir -p "$RUNNER_TEMP/vm-results"
# Run one driver at a time: each driver may start several guest machines.
checks=(manager-units runtime-real sandbox-backup-real-runtime vault-wall-real-runtime tailscale-direct backup-destinations restore-drill console-self voice install-machine)
# The update from an earlier release needs one to start from. The repository names none
# (vm-tests/common/migration-baseline.nix); the maintainers' CI names a file with theirs, which only an evaluation that
# may read its surroundings sees.
impure=()
if [ -n "${WHOMBAT_MIGRATION_BASELINE:-}" ]; then
  test -r "$WHOMBAT_MIGRATION_BASELINE"
  checks+=(update-migration)
  impure=(--impure)
else
  echo "No migration baseline (WHOMBAT_MIGRATION_BASELINE): update-migration is left out"
fi
failed=0
work=
trap 'if [ -n "$work" ]; then rm -rf "$work"; fi' EXIT
for check in "${checks[@]}"; do
  echo "Running NixOS VM check: $check"
  if ! driver=$(nix --extra-experimental-features 'nix-command flakes' build "${impure[@]}" --no-update-lock-file --no-link --print-out-paths --max-jobs 2 --cores 2 ".#checks.x86_64-linux.$check.driver"); then
    failed=1
    continue
  fi
  # Short paths keep the QEMU control sockets below the Unix socket length limit.
  work=$(mktemp -d "$TMPDIR/vm.XXXXXX")
  mkdir -p "$work/runtime" "$work/output"
  chmod 700 "$work/runtime"
  if ! TMPDIR="$work" XDG_RUNTIME_DIR="$work/runtime" \
    timeout --signal=TERM --kill-after=60s 45m "$driver/bin/nixos-test-driver" -o "$work/output" \
      --junit-xml "$RUNNER_TEMP/vm-results/$check.xml" \
      > "$RUNNER_TEMP/vm-results/$check.log" 2>&1; then
    failed=1
    tail -n 100 "$RUNNER_TEMP/vm-results/$check.log"
  fi
  # JUnit reports are already outside the multi-gigabyte temporary guest disks.
  rm -rf "$work"
  work=
done
exit "$failed"
