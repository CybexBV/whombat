#!/usr/bin/env bash
# The fixed hashes of what the Nix build downloads (nix/fixed-hashes.json): --check (no Nix), --refresh [name …],
# --digests. What they are and when to refresh them: scripts/ci/fixed_hashes.py.
exec python3 -I "$(dirname "$(readlink -f "$0")")/fixed_hashes.py" "$@"
