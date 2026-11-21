#!/usr/bin/env bash
# Fails when a tracked or new file, or a file's name, holds a text the maintainers' private guard list forbids
# (scripts/guards.sh finds the list). Without the list (contributors, public CI) there is nothing to check: it exits 0
# quietly. The lint step of `fast-test` and `pnpm lint` run it. It prints where (file and line) and which rule of the
# list, never the text itself. GUARD_SECTIONS (space-separated section names, such as `repository-wide`) limits it to
# some of the list's sections.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
guards=$(bash scripts/guards.sh)
[ -n "$guards" ] || exit 0

# The list's rules as `<line>\t<section>\t<kind>\t<text>`: `literal:` or `regex:` (PCRE) lines, each block's first
# comment `# <section>: …` naming its section.
rules=$(awk -v want=" ${GUARD_SECTIONS:-} " '
  /^#/ { if (!c) { s = $0; sub(/^# */, "", s); sub(/:.*/, "", s) } c = 1; next }
  { c = 0 }
  want != "  " && index(want, " " s " ") == 0 { next }
  /^literal:/ { printf "%d\t%s\tliteral\t%s\n", NR, s, substr($0, 9) }
  /^regex:/ { printf "%d\t%s\tregex\t%s\n", NR, s, substr($0, 7) }
' "$guards")
if [ -z "$rules" ]; then
  echo "check-forbidden: the guard list has no rules${GUARD_SECTIONS:+ in $GUARD_SECTIONS}" >&2
  exit 2
fi
names=$(git ls-files --cached --others --exclude-standard)
found=0
while IFS=$'\t' read -r line section kind text; do
  if [ "$kind" = literal ]; then
    # Literal texts in every file, binaries too.
    hits=$(git grep --untracked -n -F -e "$text" | cut -d: -f1,2 || true)
    named=$(printf '%s\n' "$names" | grep -F -e "$text" || true)
  else
    # Patterns in text files only (a binary's bytes match patterns by chance).
    hits=$(git grep --untracked -n -I -P -e "$text" | cut -d: -f1,2 || true)
    named=$(printf '%s\n' "$names" | grep -P -e "$text" || true)
  fi
  if [ -n "$hits" ] || [ -n "$named" ]; then
    found=1
    [ -z "$hits" ] || printf '%s\n' "$hits" | sed "s/^/  guard rule $line ($section) at /"
    [ -z "$named" ] || printf '%s\n' "$named" | sed "s/^/  guard rule $line ($section) in the name of /"
  fi
done <<<"$rules"
if [ "$found" -ne 0 ]; then
  echo 'check-forbidden: a private value from the maintainers’ guard list is in the files above; take it out (stand-ins: whombat-ops guards/stand-ins.md)' >&2
  exit 1
fi
