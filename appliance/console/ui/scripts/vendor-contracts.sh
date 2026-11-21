#!/usr/bin/env bash
# Refresh console/ui/vendor/whombat-contracts/ from a contracts tag of Whombat (CG-40): the desk's words (`@whombat/core`
# domain/desk.ts, domain/task-card.ts for a task row's, 0.116, domain/remote-help.ts for remote help's line, 0.120, and
# domain/quiet.ts for a look's kinds and checks, 0.122, domain/look-research.ts for what the assistant found out, 3.5, and
# domain/desk-screens.ts for the screen of widgets, 3.6),
# the desk socket's shapes (`@whombat/control-contracts` local/desk.ts), the console file's (local/index.ts: the sign-in's ConsoleSignIn,
# CG-151), the sign-in's letters (`@whombat/protocol` claim/screen.ts) and the box's Bluetooth (`@whombat/protocol`
# session/bluetooth.ts, CG-200), byte for byte from the tag (never the working tree), with the licence and a PIN file. The page can't import the contracts: it copies the words
# and shapes it needs, and the unit tests compare those copies with these files. Nothing here is built into the page.
#
# The PIN names what was copied by its content, not by a commit: the contracts' version, then a line `<git object id>
# <path>` for each source file, as `git ls-tree` prints them. `git rev-parse <commit>:<path>` prints the same id for
# any commit that holds the same file, so the copy can be checked in any history of this repository.
#
#   console/ui/scripts/vendor-contracts.sh [tag or commit] [Whombat checkout]
#
# Defaults: the newest contracts-v* tag of ~/Code/Whombat, which holds the contracts (and their tags) since
# whombat-contracts moved into it; the paths are the same. Review the diff, run `pnpm check`, commit.
set -euo pipefail

repo=${2:-${WHOMBAT_CONTRACTS:-$HOME/Code/Whombat}}
tag=${1:-$(git -C "$repo" tag --list 'contracts-v*' --sort=-v:refname | head -n1)}
commit=$(git -C "$repo" rev-parse "$tag^{commit}")
here=$(cd "$(dirname "$0")/.." && pwd)
out="$here/vendor/whombat-contracts"

show() { git -C "$repo" show "$commit:$1"; }
sources=()
# take <path in Whombat> <file here>: the file as it is at the tag, noted for the PIN.
take() {
  show "$1" >"$out/$2"
  sources+=("$1")
}

rm -rf "$out"
mkdir -p "$out"
take packages/core/src/domain/desk.ts desk.ts
# The calm glance (3.2, CG-350): its shapes and the planner the runtime decides with.
take packages/core/src/domain/desk-glance.ts desk-glance.ts
take packages/core/src/domain/desk-calm.ts desk-calm.ts
take packages/core/src/domain/task-card.ts task-card.ts
take packages/core/src/domain/remote-help.ts remote-help.ts
take packages/core/src/domain/quiet.ts quiet.ts
take packages/core/src/domain/look-research.ts look-research.ts
# The screen of widgets (3.6): its layout, views, what needs the person and the grid the runtime sends.
take packages/core/src/domain/desk-screens.ts desk-screens.ts
take packages/control-contracts/src/local/desk.ts desk-socket.ts
take packages/control-contracts/src/local/index.ts console-file.ts
take packages/protocol/src/claim/screen.ts screen-signin.ts
take packages/protocol/src/session/bluetooth.ts bluetooth.ts
# The reach step's price (`@whombat/protocol` link.ts): only the price and offer sentences, the lines as they are. The
# rest of that file is the Link protocol, which the page never speaks.
{
  printf '/**\n * From packages/protocol/src/link.ts (`@whombat/protocol`): only the price and offer constants, verbatim.\n */\n\n'
  show packages/protocol/src/link.ts | awk '
    /^\/\*\*$/ { held = $0; next }
    held != "" { if ($0 ~ /The price as people see it/) on = 1; if (on) print held; held = "" }
    on && !/^export const LINK_PRICE(_YEAR)?_CENTS|^export const LINK_PRICE_CURRENCY/ { print }
    /^export const LINK_OFFER_TEXT/ { exit }
  '
} >"$out/link-price.ts"
sources+=(packages/protocol/src/link.ts)
grep -q '^export const LINK_OFFER_TEXT' "$out/link-price.ts" || { echo "link.ts has no LINK_OFFER_TEXT at $tag" >&2; exit 1; }
# The licence: LICENSE (AGPL-3.0-only) from the releases after Whombat HE-63, LICENSE.md (PolyForm Strict) before.
if git -C "$repo" cat-file -e "$commit:LICENSE" 2>/dev/null; then take LICENSE LICENSE; else take LICENSE.md LICENSE.md; fi

version=$(show packages/core/package.json | sed -n 's/^  "version": "\(.*\)",$/\1/p')
[ -n "$version" ] || { echo "packages/core/package.json has no version at $tag" >&2; exit 1; }
{
  echo 'repository: github.com/CybexBV/whombat'
  echo "contracts: $version"
  for p in "${sources[@]}"; do echo "$(git -C "$repo" rev-parse "$commit:$p") $p"; done
} >"$out/PIN"
echo "vendored the contracts $version of Whombat ($tag) into ${out#"$here"/}"
