#!/usr/bin/env bash
# Runs a command with the tools the appliance's CI scripts use besides Nix, git and coreutils (sed, awk, jq, diff),
# from the nixpkgs flake.lock pins: for fast-test's Nix container on the build server (.fast-test.json), whose image
# has little more than Nix itself. What it fetches stays in that container's Nix store.
#
#   scripts/ci/nix-tools.sh <command>...
set -euo pipefail
lock=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/flake.lock
nix=(nix --extra-experimental-features 'nix-command flakes')
rev=$("${nix[@]}" eval --raw --impure --expr "(builtins.fromJSON (builtins.readFile $lock)).nodes.nixpkgs.locked.rev")
p=github:NixOS/nixpkgs/$rev
exec "${nix[@]}" shell "$p#gnused" "$p#gawk" "$p#jq" "$p#diffutils" --command "$@"
