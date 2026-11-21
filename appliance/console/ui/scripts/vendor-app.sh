#!/usr/bin/env bash
# Refresh console/ui/vendor/whombat-app/ from an app tag of Whombat (CG-02): the avatars' source, the brand's logo
# and mark geometry, the screen of widgets' source (@whombat/screen), tokens.css and the web fonts, byte for byte from the tag (never the working tree), plus the licence
# texts and a PIN file. Nothing is fetched at runtime; the build only reads these files.
#
# The PIN names what was copied by its content, not by a commit: the app's version, then a line `<git object id>
# <path>` for each source folder or file, as `git ls-tree` prints them. `git rev-parse <commit>:<path>` prints the same
# id for any commit that holds the same files, so the copy can be checked in any history of this repository.
#
#   console/ui/scripts/vendor-app.sh [tag or commit] [Whombat checkout]
#
# Defaults: the newest app-v* tag of ~/Code/Whombat, which holds the app (and its tags) since whombat-app moved into it;
# the paths are the same. Review the diff, run `pnpm check` and `pnpm shots`, commit.
set -euo pipefail

repo=${2:-${WHOMBAT_APP:-$HOME/Code/Whombat}}
tag=${1:-$(git -C "$repo" tag --list 'app-v*' --sort=-v:refname | head -n1)}
commit=$(git -C "$repo" rev-parse "$tag^{commit}")
here=$(cd "$(dirname "$0")/.." && pwd)
out="$here/vendor/whombat-app"

show() { git -C "$repo" show "$commit:$1"; }

rm -rf "$out"
mkdir -p "$out/avatars/src" "$out/avatars/svg" "$out/brand/src" "$out/tokens" "$out/fonts"

# @whombat/avatars (FA-06, FA-DA01): the pure module, the file URLs, the React DOM renderer and the fifteen static
# SVG files, unchanged, without tests. `svg/` sits next to `src/`: urls.ts asks for `new URL('../svg/…', import.meta.url)`.
for f in index.ts human.ts elders.ts urls.ts react.tsx; do
  show "packages/avatars/src/$f" >"$out/avatars/src/$f"
done
while IFS= read -r f; do
  show "packages/avatars/svg/$f" >"$out/avatars/svg/$f"
done < <(git -C "$repo" ls-tree --name-only "$commit" packages/avatars/svg/ | xargs -n1 basename)
show packages/avatars/README.md >"$out/avatars/README.md"

# @whombat/brand: the logo geometry, <WhombatLogo> and <BrandMark>. index.ts re-exports the marks: the guide cards'
# (marks.ts), the connections' (connectionMarks.ts), the guest platforms' (platformMarks.ts) and the operating systems'
# (osMarks.ts). The desk's server cards draw the mark the runtime names (proxmox, unraid, debian, linux…; CG-41), so
# every mark is in the bundle; SOURCES.md says where each comes from and under which licence (THIRD_PARTY_NOTICES.md
# has the notices).
for f in index.ts marks.ts connectionMarks.ts osMarks.ts platformMarks.ts react.tsx; do
  show "packages/brand/src/$f" >"$out/brand/src/$f"
done
show packages/brand/assets/marks/SOURCES.md >"$out/brand/MARKS.md"

# @whombat/screen: the screen of widgets (the grid, the widgets' sizes and their drawing), its source as it is: every
# .ts, .tsx and .css under src/ but the tests. Its fixtures come along for the demo and the shots; `vite build` leaves
# them out (only the demo imports them).
while IFS= read -r f; do
  case "$f" in *.test.ts | *.test.tsx) continue ;; esac
  mkdir -p "$out/screen/$(dirname "$f")"
  show "packages/screen/$f" >"$out/screen/$f"
done < <(git -C "$repo" ls-tree -r --name-only "$commit" packages/screen/src/ | sed 's|^packages/screen/||' | grep -E '\.(ts|tsx|css)$')

# @whombat/tokens: the generated CSS variables.
show packages/tokens/tokens.css >"$out/tokens/tokens.css"

# The web fonts as the web app serves them (same files, same unicode ranges) and their licences.
while IFS= read -r f; do
  show "apps/web/src/app/fonts/$f" >"$out/fonts/$f"
done < <(git -C "$repo" ls-tree --name-only "$commit" apps/web/src/app/fonts/ | xargs -n1 basename)

# The licence: LICENSE (AGPL-3.0-only) from the releases after Whombat HE-63, LICENSE.md (PolyForm Strict) before.
if git -C "$repo" cat-file -e "$commit:LICENSE" 2>/dev/null; then licence=LICENSE; else licence=LICENSE.md; fi
show "$licence" >"$out/$licence"
show THIRD_PARTY_NOTICES.md >"$out/THIRD_PARTY_NOTICES.md"

version=$(show apps/web/package.json | sed -n 's/^  "version": "\(.*\)",$/\1/p')
[ -n "$version" ] || { echo "apps/web/package.json has no version at $tag" >&2; exit 1; }
{
  echo 'repository: github.com/CybexBV/whombat'
  echo "app: $version"
  for p in packages/avatars packages/brand packages/screen packages/tokens/tokens.css apps/web/src/app/fonts \
    "$licence" THIRD_PARTY_NOTICES.md; do
    echo "$(git -C "$repo" rev-parse "$commit:$p") $p"
  done
} >"$out/PIN"
echo "vendored the app $version of Whombat ($tag) into ${out#"$here"/}"
