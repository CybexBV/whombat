#!/usr/bin/env bash
# A commit for Nix to evaluate: this checkout as it is now, uncommitted changes and new files included, without the
# folders no build reads. Prints its id; evaluate it as git+file://<repository>?rev=<id>&dir=appliance.
#
# Nix copies a whole commit into its store before it reads the flake: 340 MB for this repository, and again for every
# state of the working tree it is asked about. Half of that is the design references (docs/design-handoff), which no
# build reads. Every build reads a narrow copy of its own files (nix/lib/sources.nix), so what is evaluated from this
# commit is exactly what the checkout evaluates to. The commit is in the object store only: no file, index or branch
# of the checkout changes. Not for a release: a release's manager is named after the commit it is built from.
#
#   scripts/ci/eval-commit.sh [<commit>]   this checkout as it is, or that commit
set -euo pipefail
top=$(git rev-parse --show-toplevel)
# What no build reads and is worth leaving out.
skip=(docs/design-handoff)
work=$(mktemp -d "${TMPDIR:-/tmp}/eval-commit.XXXXXX")
trap 'rm -rf "$work"' EXIT
export GIT_INDEX_FILE="$work/index"
base=$(git -C "$top" rev-parse --verify "${1:-HEAD}^{commit}")
git -C "$top" read-tree "$base"
# The working tree's own state, when no commit was named: what is tracked or new and not ignored.
[ $# -gt 0 ] || git -C "$top" add -A
git -C "$top" rm -r -q --cached --ignore-unmatch -- "${skip[@]}"
tree=$(git -C "$top" write-tree)
unset GIT_INDEX_FILE
git -C "$top" -c user.name=eval-commit -c user.email=eval-commit@example.com \
  commit-tree "$tree" -p "$base" -m "for Nix to evaluate: ${base:0:9} without ${skip[*]}" </dev/null
