#!/usr/bin/env bash
# Prints the path of the maintainers' private guard list, or nothing. The list names private values that must never
# be published here (addresses, device ids, domains, an old product name); it lives outside this repository, in the
# maintainers' private whombat-ops. Contributors don't have it and don't need it: the checks that read it skip
# without it. Looked for in $WHOMBAT_GUARDS, then $(git config whombat.ops)/guards/forbid.txt, then
# ~/Code/whombat-ops/guards/forbid.txt. Portable to macOS's bash 3.2.
set -eu
ops=$(git config --get whombat.ops 2>/dev/null || true)
for f in "${WHOMBAT_GUARDS:-}" "${ops:+$ops/guards/forbid.txt}" "${HOME:-}/Code/whombat-ops/guards/forbid.txt"; do
  if [ -n "$f" ] && [ -f "$f" ]; then
    printf '%s\n' "$f"
    exit 0
  fi
done
