#!/usr/bin/env bash
# Does a change reach only what is built from it? Every build reads a narrow copy of the repository
# (nix/lib/sources.nix), so a commit that changes a document, a test or the phone app must leave every derivation as it
# was, and a commit that changes the server must change the runtime and nothing of the hub. This makes one test commit
# per row on top of HEAD (in the object store only: no file of the checkout is touched, no branch moves) and compares
# what each evaluates to with HEAD, under one runtime stamp, one release id and one manager version. Every commit it
# evaluates, HEAD's too, is without the folders no build reads (eval-commit.sh), which halves what Nix copies. Evaluation only,
# nothing is built. What counts is the output path: the same path is the same bytes on a box, and nothing is built or
# downloaded for it. A derivation's own id may still differ where a download was fetched for more files than a build
# compiles (the hosts service's vendored Go modules are chosen by every Go file, tests too); that is said, not counted.
# About a minute a row.
#
#   scripts/ci/source-matrix.sh               every row
#   scripts/ci/source-matrix.sh --nothing     only the rows that must change nothing (after a change to a filter)
#   scripts/ci/source-matrix.sh --row <name>  one row
#   … --out <dir>                             keep each row's answer there (<row>.json)
#
# The rows, and what each must change (everything else must stay):
#   docs      a document of each of the three parts                              nothing
#   tests     a server test, a package's test, a contracts Go test and vector,   nothing
#             a hosts test, a test of the manager (which doesn't run its tests here)
#   mobile    the phone app                                                      nothing
#   release   what an earlier release tool wrote: a manifest, a decision row     nothing
#   web       the web app and the client package         the web app, the runtime (it links it), the image, the installer
#   server    the server and the agent runtime           the runtime, the image, the installer
#   hermes    Whombat's Hermes plugin                    Hermes, the runtime, the image, the installer
#   hub       the hosts service's hub                    the hub, the image, the installer
#   agent     the hosts service's agent                  the agents, the hub (it carries them), the image, the installer
#   manager   the manager                                the manager, the image, the installer
#   nixpkgs   another nixpkgs in flake.lock              every fixed hash refuses to evaluate until it is refreshed
#
# Exit 0: every row as expected. Exit 1: a row changed too much or too little; `nix derivation show <drv>` of both
# says which input (--out keeps each row's derivations).
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
root=$(cd "$here/../.." && pwd)
top=$(git -C "$root" rev-parse --show-toplevel)
export NIX_CONFIG="${NIX_CONFIG:-}"$'\n'"experimental-features = nix-command flakes"
export TMPDIR="${TMPDIR:-$HOME/.cache/wb-tmp}"
mkdir -p "$TMPDIR"

things=(runtime web hermes hub agents manager helper consoleUi image installer)
nothing=(docs tests mobile release)
rows=("${nothing[@]}" web server hermes hub agent manager nixpkgs)
out=
while [ $# -gt 0 ]; do
  case $1 in
    --nothing) rows=("${nothing[@]}"); shift ;;
    --row) rows=("${2:?--row needs a name}"); shift 2 ;;
    --out) out=${2:?--out needs a folder}; shift 2 ;;
    -h | --help) sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d; s/^# \{0,1\}//'; exit 0 ;;
    *) echo "source-matrix: unknown option $1" >&2; exit 2 ;;
  esac
done

# What a row must change.
expected() {
  case $1 in
    docs | tests | mobile | release) echo "" ;;
    web) echo "web runtime image installer" ;;
    server) echo "runtime image installer" ;;
    hermes) echo "hermes runtime image installer" ;;
    hub) echo "hub image installer" ;;
    agent) echo "agents hub image installer" ;;
    manager) echo "manager image installer" ;;
    nixpkgs) echo "refused" ;;
    *) echo "source-matrix: no row $1 (${rows[*]})" >&2; return 2 ;;
  esac
}

base=$(git -C "$top" rev-parse HEAD)
# A shallow copy (fast-test's on the build server) is fine: the flake reads its commits' dates, never how many came before.
shallow=; [ "$(git -C "$top" rev-parse --is-shallow-repository)" = false ] || shallow='&shallow=1'
[ -z "$(git -C "$top" status --porcelain --untracked-files=no)" ] ||
  echo "source-matrix: uncommitted changes are not part of this: it compares commits on top of ${base:0:9}" >&2
work=$(mktemp -d "$TMPDIR/source-matrix.XXXXXX")
# The test commits get a name of this run's own, so nothing collects them while Nix reads them; the names go at the end.
refs=refs/source-matrix/$$
cleanup() {
  git -C "$top" for-each-ref --format='%(refname)' "$refs/" | while IFS= read -r ref; do
    git -C "$top" update-ref -d "$ref" || true
  done
  rm -rf "$work"
}
trap cleanup EXIT

# The first tracked file that matches the patterns (`*` stays inside one folder, `**` crosses folders).
first() {
  local f
  f=$(git -C "$top" ls-files -- "${@/#/:(glob)}" | sed -n 1p)
  [ -n "$f" ] || { echo "source-matrix: no tracked file matches $*" >&2; return 1; }
  echo "$f"
}

# The first tracked file below the patterns that a build compiles: no test, story or browser suite.
code() {
  local f
  f=$(git -C "$top" ls-files -- "${@/#/:(glob)}" | grep -v -E '(\.(test|spec|stories)\.tsx?|_test\.go)$|(^|/)(test|__tests__|testdata)/' | sed -n 1p)
  [ -n "$f" ] || { echo "source-matrix: no tracked source file matches $*" >&2; return 1; }
  echo "$f"
}

# A commit on top of HEAD whose only change is one more line at the end of the files named (or, for a path that
# doesn't exist, a new file): `<path>` or `<path>=<a whole new content>`.
commit_of() {
  local name=$1 path blob mode line
  shift
  export GIT_INDEX_FILE="$work/index.$name"
  git -C "$top" read-tree "$slim"
  for path in "$@"; do
    if [[ $path == *=* ]]; then
      blob=$(printf '%s\n' "${path#*=}" | git -C "$top" hash-object -w --stdin)
      path=${path%%=*}
      mode=$(git -C "$top" ls-tree "$slim" -- "$path" | cut -d' ' -f1)
    else
      case $path in
        *.py | *.sh | *.yaml | *.toml) line="# source-matrix" ;;
        *.md) line="source-matrix" ;;
        *.json) echo "source-matrix: can't add a line to $path" >&2; return 1 ;;
        *) line="// source-matrix" ;;
      esac
      blob=$({ git -C "$top" cat-file blob "$slim:$path"; printf '%s\n' "$line"; } | git -C "$top" hash-object -w --stdin)
      mode=$(git -C "$top" ls-tree "$slim" -- "$path" | cut -d' ' -f1)
    fi
    git -C "$top" update-index --add --cacheinfo "${mode:-100644},$blob,$path"
  done
  local tree commit
  tree=$(git -C "$top" write-tree)
  unset GIT_INDEX_FILE
  commit=$(git -C "$top" -c user.name=source-matrix -c user.email=source-matrix@example.com \
    commit-tree "$tree" -p "$slim" -m "source-matrix: $name")
  git -C "$top" update-ref "$refs/$name" "$commit"
  echo "$commit"
}

row_commit() {
  case $1 in
    docs) commit_of docs "$(first 'docs/decisions/*.md')" "$(first 'appliance/docs/**/*.md')" "$(first 'hosts/docs/**/*.md')" ;;
    tests)
      commit_of tests "$(first 'apps/server/src/**/*.test.ts')" "$(first 'packages/*/src/**/*.test.ts')" \
        "$(first 'contracts/go/**/*_test.go')" "contracts/go/testdata/vectors/source-matrix.json={}" \
        "$(first 'hosts/internal/**/*_test.go')" "$(first 'appliance/manager/**/*_test.go')"
      ;;
    mobile) commit_of mobile "$(first 'apps/mobile/src/**/*.tsx')" "$(first 'apps/mobile/*.md')" ;;
    release)
      commit_of release "appliance/manifest/candidates/9.999.0.json={}" "$(first 'appliance/docs/decisions/integration.md')"
      ;;
    web) commit_of web "$(code 'apps/web/src/*.tsx')" "$(code 'packages/client/src/*.ts')" ;;
    server) commit_of server "$(code 'apps/server/src/*.ts')" "$(code 'packages/agent-runtime/src/*.ts')" ;;
    hermes) commit_of hermes "$(first 'packages/hermes-whombat/whombat_hermes/*.py')" ;;
    hub) commit_of hub "$(code 'hosts/internal/hub/*.go')" ;;
    agent) commit_of agent "$(code 'hosts/internal/agent/*.go')" ;;
    manager) commit_of manager "$(code 'appliance/manager/internal/**/*.go')" ;;
    nixpkgs)
      # Another revision under the same content hash: Nix reads the nixpkgs it has, and the build sees another one.
      local lock rev
      rev=$(git -C "$top" cat-file blob "$slim:appliance/flake.lock" | jq -r '.nodes[.nodes[.root].inputs.nixpkgs].locked.rev')
      lock=$(git -C "$top" cat-file blob "$slim:appliance/flake.lock" |
        jq --arg rev "$(tr '0-9a-f' '1-9a-f0' <<<"$rev")" '.nodes[.nodes[.root].inputs.nixpkgs].locked.rev = $rev')
      commit_of nixpkgs "appliance/flake.lock=$lock"
      ;;
  esac
}

# What a commit evaluates to: {<thing>: {drv, out}}. The runtime under one stamp, the image as one release with the
# manager's and the helper's version fixed (a release's name the commit being built, on purpose).
answer() {
  nix eval --impure --json --no-write-lock-file --expr "
    let
      f = builtins.getFlake \"git+file://$top?rev=$1&dir=${root#"$top"/}$shallow\";
      p = f.packages.x86_64-linux;
      both = d: { drv = d.drvPath; out = d.outPath; };
      rel = f.lib.applianceRelease {
        env = \"prod\";
        releaseId = \"whombat-20990101.1\";
        runtimeStamp = { rev = \"0123456789abcdef0123456789abcdef01234567\"; time = 4070908800; date = \"20990101000000\"; };
      };
      ver = q: q.overrideAttrs (o: { version = \"0.3.0-20990101000000.0000000\"; __intentionallyOverridingVersion = true; inherit (o) goModules; });
      sys = rel.appliance.extendModules { modules = [ ({ pkgs, lib, ... }: {
        whombat.manager.package = lib.mkOverride 80 (ver pkgs.whombat-manager);
        whombat.helper.package = lib.mkOverride 80 (ver pkgs.whombat-update-helper);
      }) ]; };
    in {
      runtime = both rel.runtime;
      web = both rel.runtime.passthru.web;
      hermes = both p.whombat-hermes;
      hub = both p.whombat-hosts;
      agents = both p.whombat-hosts-agents;
      manager = both p.whombat-manager;
      helper = both p.whombat-update-helper;
      consoleUi = both p.whombat-console-ui;
      image = both sys.config.system.build.toplevel;
      installer = both p.installer-iso-prod;
    }"
}

# HEAD without the folders no build reads: what every row starts from and is compared with.
slim=$("$here/eval-commit.sh" "$base")
git -C "$top" update-ref "$refs/HEAD" "$slim"
echo "source-matrix: HEAD ${base:0:9}" >&2
answer "$slim" >"$work/base.json" 2>"$work/base.err" || { cat "$work/base.err" >&2; echo "source-matrix: HEAD doesn't evaluate" >&2; exit 1; }
[ -z "$out" ] || { mkdir -p "$out" && cp "$work/base.json" "$out/HEAD.json"; }
echo "  runtime $(jq -r .runtime.out "$work/base.json")" >&2
echo "  agents  $(jq -r .agents.out "$work/base.json")" >&2

failed=0
for row in "${rows[@]}"; do
  want=$(expected "$row")
  commit=$(row_commit "$row")
  files=$(git -C "$top" diff --name-only "$slim" "$commit" | tr '\n' ' ')
  if answer "$commit" >"$work/$row.json" 2>"$work/$row.err"; then
    [ -z "$out" ] || cp "$work/$row.json" "$out/$row.json"
    if [ "$want" = refused ]; then
      echo "  WRONG    $row: it evaluates, though every fixed hash was taken for another nixpkgs  ($files)"
      failed=1
      continue
    fi
    changed=$(jq -rn --slurpfile a "$work/base.json" --slurpfile b "$work/$row.json" \
      '[$a[0] | keys_unsorted[] | select($a[0][.].out != $b[0][.].out)] | join(" ")')
    # The same output from another derivation: a download's own inputs changed, not what it fetched.
    same=$(jq -rn --slurpfile a "$work/base.json" --slurpfile b "$work/$row.json" \
      '[$a[0] | keys_unsorted[] | select($a[0][.].out == $b[0][.].out and $a[0][.].drv != $b[0][.].drv)] | join(" ")')
    note=${same:+; the same output from another derivation: $same}
    # In the order of `things`, as the expectation is written.
    got=
    for thing in "${things[@]}"; do
      case " $changed " in *" $thing "*) got="${got:+$got }$thing" ;; esac
    done
    wanted=
    for thing in "${things[@]}"; do
      case " $want " in *" $thing "*) wanted="${wanted:+$wanted }$thing" ;; esac
    done
    if [ "$got" = "$wanted" ]; then
      echo "  as it should  $row: changes ${got:-nothing}$note  ($files)"
    else
      echo "  WRONG    $row: changes ${got:-nothing}, should change ${wanted:-nothing}$note  ($files)"
      for thing in $got; do echo "             $thing  $(jq -r ".$thing.drv" "$work/base.json")  ->  $(jq -r ".$thing.drv" "$work/$row.json")"; done
      failed=1
    fi
  elif [ "$want" = refused ] && grep -q 'fixed-hashes.json' "$work/$row.err"; then
    echo "  as it should  $row: the fixed hashes refuse it until they are refreshed  ($files)"
  else
    grep -v -e 'forceImportRoot' -e 'Nix search path' "$work/$row.err" | tail -n 20 >&2
    echo "  WRONG    $row: it doesn't evaluate  ($files)"
    failed=1
  fi
done
[ "$failed" = 0 ] || { echo "source-matrix: a change reaches more or less than it should"; exit 1; }
echo "source-matrix: ${#rows[@]} rows, every change reaches exactly what is built from it"
