#!/usr/bin/env bash
set -euo pipefail
# The flake and its lock are never updated by CI.
checks=(release-versions hermes self-installed-config eval-aarch64 eval-installers console vault-wall-config containers-config hosts-config hosts-agent-manifest hosts-unsigned-build voice-config voice-speech presence-config presence-detect bluetooth-config)
installables=()
for check in "${checks[@]}"; do installables+=(".#checks.x86_64-linux.$check"); done
nix --extra-experimental-features 'nix-command flakes' build --no-update-lock-file --no-link --json --max-jobs 2 --cores 2 "${installables[@]}" > "$RUNNER_TEMP/nix-checks.json"
