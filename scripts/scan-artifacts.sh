#!/usr/bin/env bash
# Scans built artifacts for a text the repository must never hold again: the “repository-wide” rules of the
# maintainers' private guard list (scripts/guards.sh finds it): each file or folder given, with archives unpacked first
# (.tar, .tar.gz, .tgz; .zip, .apk, .aab, .ipa, .jar) and every file read as bytes, binaries too. Release and publish
# steps run it on what they made before it leaves the machine. Without the list it skips, unless the caller sets
# WHOMBAT_GUARDS_REQUIRED=1 (the maintainers' release tools do): then it refuses. SCAN_FORBID_FILE names the list
# directly (the iOS publish copies it to its Mac). Portable to macOS (its bash 3.2, BSD find and grep).
#
#   scripts/scan-artifacts.sh <file or folder>...
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
forbid=${SCAN_FORBID_FILE:-$(cd "$root" && bash scripts/guards.sh)}
if [ -z "$forbid" ] || [ ! -f "$forbid" ]; then
  if [ "${WHOMBAT_GUARDS_REQUIRED:-}" = 1 ]; then
    echo 'scan-artifacts: no guard list (scripts/guards.sh), and this release needs it: refused' >&2
    exit 2
  fi
  echo 'scan-artifacts: no guard list, nothing to check' >&2
  exit 0
fi
[ $# -gt 0 ] || { echo 'usage: scan-artifacts.sh <file or folder>...' >&2; exit 2; }
rules=()
while IFS= read -r r; do rules+=("$r"); done < <(awk '/^# repository-wide/{on=1; next} on && /^$/{on=0} on && /^regex:/{print substr($0, 7)}' "$forbid")
[ "${#rules[@]}" -gt 0 ] || { echo "scan-artifacts: the guard list has no repository-wide rules" >&2; exit 2; }
work=$(mktemp -d "${TMPDIR:-/tmp}/scan-artifacts.XXXXXX")
trap 'rm -rf "$work"' EXIT

# Unpacks archives (nested ones too, a few levels deep) into $work; prints the folders to scan.
unpack() {
  local src=$1 depth=$2 dest
  dest=$(mktemp -d "$work/u.XXXXXX")
  case "$src" in
    *.tar.gz | *.tgz) tar -xzf "$src" -C "$dest" ;;
    *.tar) tar -xf "$src" -C "$dest" ;;
    *.zip | *.apk | *.aab | *.ipa | *.jar)
      python3 -I -c 'import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])' "$src" "$dest" ;;
    *) rmdir "$dest"; return 0 ;;
  esac
  echo "$dest"
  if [ "$depth" -lt 3 ]; then
    while IFS= read -r -d '' inner; do unpack "$inner" $((depth + 1)); done < <(
      find "$dest" -type f \( -name '*.tar.gz' -o -name '*.tgz' -o -name '*.tar' -o -name '*.zip' -o -name '*.apk' \
        -o -name '*.aab' -o -name '*.jar' \) -print0)
  fi
}

targets=()
for a in "$@"; do
  [ -e "$a" ] || { echo "scan-artifacts: $a doesn't exist" >&2; exit 2; }
  targets+=("$a")
  if [ -f "$a" ]; then while IFS= read -r d; do targets+=("$d"); done < <(unpack "$a" 0); fi
  if [ -d "$a" ]; then
    while IFS= read -r -d '' inner; do while IFS= read -r d; do targets+=("$d"); done < <(unpack "$inner" 1); done < <(
      find "$a" -type f \( -name '*.tar.gz' -o -name '*.tgz' -o -name '*.zip' -o -name '*.apk' -o -name '*.aab' \
        -o -name '*.ipa' \) -print0)
  fi
done

found=0
for rule in "${rules[@]}"; do
  flags=(-E)
  if [[ $rule == '(?i)'* ]]; then flags+=(-i); rule=${rule#'(?i)'}; fi
  # Every file as bytes (-a), and its name.
  if grep -r -l -a "${flags[@]}" -e "$rule" -- "${targets[@]}" 2>/dev/null | sed "s|$work/u\.[^/]*/|(unpacked) |" | sed 's/^/  holds it: /' | grep .; then found=1; fi
  # Names inside what was given, and a given file's own name (not the folders it sits in).
  if for t in "${targets[@]}"; do
    if [ -d "$t" ]; then (cd "$t" && find . -mindepth 1 | sed 's|^\./||'); else basename "$t"; fi
  done | grep "${flags[@]}" -e "$rule" | sed 's/^/  its name holds it: /' | grep .; then found=1; fi
done
if [ "$found" -ne 0 ]; then
  echo 'scan-artifacts: a repository-wide forbidden text (the guard list) is in the artifacts above' >&2
  exit 1
fi
echo "scan-artifacts: ${#rules[@]} rules, clean: $*"
