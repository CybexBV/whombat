#!/usr/bin/env bash
# Installs the community ISO in the test VM through its graphical installer, as a person at the screen would (IN-430):
# Start, the checks (Continue once they are done, past any warnings), the disk's name to confirm, Erase and install,
# Restart; then waits for the installed box's claim screen and prints the four letters it shows. The screen is read with tesseract; every
# screen it waited for is kept as a PNG in <shots dir>.
#
#   vm-tests/community-install/install.sh <workspace> <shots dir> [disk name, default vda]
#
# WB_REACH picks the answer to "How will you reach this Whombat?" (Whombat LNK-12), where the installer asks:
# tailscale (the default here: the test's Headscale) or link (Whombat Link, chosen at the start).
#
# Needs WB_TESSERACT (nixpkgs tesseract store path).
set -euo pipefail

ws=${1:?usage: install.sh <workspace> <shots dir> [disk]}
shots=${2:?}
disk=${3:-vda}
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ocr=${WB_TESSERACT:?WB_TESSERACT: a tesseract store path}/bin/tesseract
mkdir -p "$shots"
t0=$(date +%s)

q() { python3 "$here/qmp.py" "$ws/qmp.sock" "$@"; }
say() { echo "install: +$(($(date +%s) - t0))s $*" >&2; }
# wait_text <name> <timeout s> <extended regex> [regex it must not show]: until the screen shows it (and not the other);
# the screen is <shots>/<name>.png.
wait_text() {
  local name=$1 timeout=$2 re=$3 not=${4:-} end text
  end=$(($(date +%s) + timeout))
  while :; do
    q screendump "$shots/$name.png"
    text=$("$ocr" "$shots/$name.png" - 2>/dev/null || true)
    if grep -qiE "$re" <<<"$text" && { [ -z "$not" ] || ! grep -qiE "$not" <<<"$text"; }; then
      say "$name: $(grep -iEo "$re" <<<"$text" | head -n1)"
      printf '%s\n' "$text" >"$shots/$name.txt"
      return 0
    fi
    [ "$(date +%s)" -lt "$end" ] || { say "$name: not seen in ${timeout}s"; printf '%s\n' "$text" >"$shots/$name.txt"; return 1; }
    sleep 5
  done
}

wait_text 1-welcome 300 "set up your Whombat"
q keys tab
q keys ret
# How the box will be reached: Whombat Link has the focus; the arrow key moves to Tailscale, Enter continues. The
# community edition's installer doesn't ask (it has no Whombat Link) and goes straight to the checks.
wait_text 1b-reach 180 "How will you reach|All ?good|Read the ?warnings"
if grep -qi "How will you reach" "$shots/1b-reach.txt"; then
  if [ "${WB_REACH:-tailscale}" = tailscale ]; then q keys down; fi
  q keys ret
fi
# The checks are done when the summary says so: “All good.” or “Read the warnings, then continue.” (Continue then has the
# focus; tesseract may read the first as “Allgood.”). The focused Continue itself is light on dark and tesseract doesn't
# read it; Check again shows while the checks still run.
wait_text 2-checks 180 "All ?good|Read the ?warnings"
q keys ret
wait_text 3-erase 60 "to confirm"
q type "$disk\n"
wait_text 4-installed 1800 "Whombat is installed|went wrong|failed"
grep -qi "Whombat is installed" "$shots/4-installed.txt"
q keys ret
say "restarting into the installed system"
# The installed screen says “…a code to claim your Whombat” too: the claim screen is the one without it.
wait_text 5-claim 1800 "Claim this Whombat|Claim your Whombat|went wrong" "Whombat is installed"
# The four letters on the sign: tesseract's sparse-text mode reads the big letters (the default page mode misses them;
# it sometimes puts a space in a double letter). A box without a secure address shows them too, for the Whombat app on
# its network (console-gui.md CG-411).
code=$("$ocr" "$shots/5-claim.png" - --psm 11 2>/dev/null | grep -oE '\b[A-Z] ?[A-Z] ?[A-Z] ?[A-Z]\b' | tr -d ' ' | head -n1 || true)
say "claim code read: ${code:-none}"
echo "$code"
