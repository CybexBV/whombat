#!/usr/bin/env bash
# Development override for consumers of @whombat/* contracts (MA-02). Copy this file into your repository
# as scripts/link-contracts.sh. It changes only untracked state (node_modules), never package.json, the
# lockfile or pnpm-workspace.yaml, so a released build can never depend on a sibling checkout.
#
#   WHOMBAT_CONTRACTS_DEV=../Whombat scripts/link-contracts.sh                   # link
#   scripts/link-contracts.sh --unlink                                           # back to the vendored tarballs
#
# Linking replaces each installed @whombat/<pkg> from the vendored tarball (inside node_modules/.pnpm) with a
# symlink to $WHOMBAT_CONTRACTS_DEV/packages/<pkg>. The linked packages export their TypeScript sources
# (Vite, Vitest and tsx compile them; Metro needs the contracts checkout in `watchFolders`), and resolve their
# own dependencies from the contracts checkout, so run `pnpm install` there first. Any `pnpm install` in this
# repository restores the tarballs; re-run this script afterwards.
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
marker="$root/node_modules/.whombat-contracts-dev"

if [[ "${1:-}" == "--unlink" ]]; then
  if [[ -f "$marker" ]]; then
    dev="$(cat "$marker")"
    # pnpm's own links are relative; ours point into the contracts checkout.
    find "$root/node_modules/.pnpm" -maxdepth 4 -path '*/node_modules/@whombat/*' -type l -lname "$dev/*" -delete
    rm -f "$marker"
  fi
  (cd "$root" && pnpm install --frozen-lockfile)
  echo "link-contracts: restored the vendored tarballs"
  exit 0
fi

dev="${WHOMBAT_CONTRACTS_DEV:?set WHOMBAT_CONTRACTS_DEV to a Whombat checkout}"
dev="$(cd "$dev" && pwd)"
[[ -d "$dev/packages" && -d "$dev/node_modules" ]] || {
  echo "link-contracts: $dev is not an installed whombat-contracts checkout (run pnpm install there)" >&2
  exit 1
}
[[ -d "$root/node_modules/.pnpm" ]] || {
  echo "link-contracts: run pnpm install in $root first" >&2
  exit 1
}

linked=0
for pkgdir in "$dev"/packages/*/; do
  [[ -f "$pkgdir/package.json" ]] || continue
  name="$(node -p "require('$pkgdir/package.json').name")"
  [[ "$name" == @whombat/* ]] || continue
  short="${name#@whombat/}"
  shopt -s nullglob
  for installed in "$root"/node_modules/.pnpm/@whombat+"$short"@*/node_modules/@whombat/"$short"; do
    if [[ ! -L "$installed" ]]; then
      rm -rf "$installed"
      ln -s "${pkgdir%/}" "$installed"
    fi
    linked=$((linked + 1))
  done
  shopt -u nullglob
done

if [[ "$linked" -eq 0 ]]; then
  echo "link-contracts: no installed @whombat/* contracts packages found under $root/node_modules/.pnpm" >&2
  exit 1
fi
echo "$dev" >"$marker"
echo "link-contracts: $linked package installs now point at $dev (undo: scripts/link-contracts.sh --unlink)"
