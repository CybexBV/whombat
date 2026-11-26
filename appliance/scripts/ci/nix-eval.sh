#!/usr/bin/env bash
# Evaluates nix-checks.sh's checks without building them (about 2 minutes): catches Nix mistakes before a candidate.
# eval-aarch64 only evaluates inside its build, so it is left to the build.
# It evaluates the checkout as it is, from a commit without the folders no build reads (eval-commit.sh): Nix copies
# what it evaluates into its store, every time the tree differs.
set -euo pipefail
checks=()
eval "$(grep '^checks=' scripts/ci/nix-checks.sh)"
# A shallow copy (fast-test's on the build server) is fine: the flake reads its commit's date, never how many came before.
shallow=; [ "$(git rev-parse --is-shallow-repository)" = false ] || shallow='&shallow=1'
flake="git+file://$(git rev-parse --show-toplevel)?rev=$(scripts/ci/eval-commit.sh)&dir=$(git rev-parse --show-prefix | sed 's|/$||')$shallow"
set --
for check in "${checks[@]}"; do
  [ "$check" = eval-aarch64 ] || set -- "$@" "$flake#checks.x86_64-linux.$check"
done
nix --extra-experimental-features 'nix-command flakes' build --dry-run --no-update-lock-file --no-link "$@"
