# Where a release's source is. Sourced by the release tools (release/build, release/upgrade-gates, release/sbom); the
# harness has the same in harness/src/lib/source.ts, and both pass the same cases (release/source_test.go,
# harness/src/lib/source.test.ts).
#
# The appliance has lived in two places: at the root of its own repository (the appliance), and in the folder
# appliance/ of the Whombat repository. A release names the commit it was built from, and that commit may be in the
# checkout these tools run from or only in an older repository kept as an archive. Every tool asks here:
#
#   source_top <dir>             the git checkout <dir> is in (its top folder)
#   source_dir <repository> <commit>
#                                where the appliance is in that commit: "appliance" (a folder of Whombat) or ""
#                                (the commit is an appliance repository's own)
#   source_find <commit>         the repository that has the commit: this checkout, else each of WB_ARCHIVE_GIT
#   source_flake <commit>        its flake: git+file://<repository>?rev=<commit>, with &dir=appliance for a folder
#   source_show <commit> <path>  a file of the appliance at that commit (the path as seen from the appliance)
#   source_tree_flake            this checkout's flake as it is now, uncommitted changes included
#   source_record <commit> <dirty>
#                                what a build records as its source (build.json `source`)
#
# The caller sets `root` to the appliance's folder (its own repository's top, or <Whombat>/appliance).
# WB_ARCHIVE_GIT lists the archive repositories, separated by `:`, searched in order. Unset, the maintainers' two
# old checkouts are searched when they exist.
# shellcheck shell=bash
: "${root:?release/lib/source.sh: set root to the folder of the appliance first}"

source_top() { git -C "$1" rev-parse --show-toplevel; }

source_dir() {
  local repo=$1 rev=$2
  if git -C "$repo" cat-file -e "$rev:appliance/flake.nix" 2>/dev/null; then
    echo appliance
  elif git -C "$repo" cat-file -e "$rev:flake.nix" 2>/dev/null && git -C "$repo" cat-file -e "$rev:nix/profiles" 2>/dev/null; then
    echo ""
  else
    echo "source: $rev in $repo holds no appliance (neither appliance/flake.nix nor flake.nix beside nix/profiles)" >&2
    return 1
  fi
}

# The archive repositories, one a line.
source_archives() {
  local list=${WB_ARCHIVE_GIT-} d
  if [ -z "${WB_ARCHIVE_GIT+set}" ]; then
    for d in "$HOME/Code/whombat-appliance" "$HOME/Code/whombat-hosts"; do
      [ ! -d "$d" ] || list="${list:+$list:}$d"
    done
  fi
  [ -z "$list" ] || tr ':' '\n' <<<"$list" | grep -v '^$' || true
}

source_find() {
  local rev=$1 top here repo
  top=$(source_top "$root")
  if git -C "$top" cat-file -e "$rev^{commit}" 2>/dev/null; then
    # At a repository's top, the folder as the caller names it.
    here=$(cd "$root" && pwd -P)
    if [ "$top" = "$here" ]; then echo "$root"; else echo "$top"; fi
    return 0
  fi
  while IFS= read -r repo; do
    if [ -d "$repo" ] && git -C "$repo" cat-file -e "$rev^{commit}" 2>/dev/null; then
      source_top "$repo" 2>/dev/null || (cd "$repo" && pwd)
      return 0
    fi
  done < <(source_archives)
  echo "source: the commit $rev is not in $top nor in an archive (WB_ARCHIVE_GIT: $(source_archives | tr '\n' ' '))" >&2
  return 1
}

source_flake() {
  local rev=$1 repo dir
  repo=$(source_find "$rev") || return 1
  dir=$(source_dir "$repo" "$rev") || return 1
  echo "git+file://$repo?rev=$rev${dir:+&dir=$dir}"
}

source_show() {
  local rev=$1 path=$2 repo dir
  repo=$(source_find "$rev") || return 1
  dir=$(source_dir "$repo" "$rev") || return 1
  git -C "$repo" show "$rev:${dir:+$dir/}$path"
}

# This checkout as it is. At a repository's top Nix can read the folder itself; inside a larger repository it must
# read the repository (a `path:` flake can't reach the folders beside it), which takes every tracked file as it is.
source_tree_flake() {
  local top here
  top=$(source_top "$root")
  here=$(cd "$root" && pwd -P)
  if [ "$top" = "$here" ]; then
    echo "path:$root"
  else
    echo "git+file://$top?dir=${here#"$top"/}"
  fi
}

source_record() {
  local rev=$1 dirty=$2 repo dir
  repo=$(source_find "$rev") || return 1
  dir=$(source_dir "$repo" "$rev") || return 1
  if [ -z "$dir" ]; then
    jq -cn --arg rev "$rev" --argjson dirty "$dirty" '{repository: "whombat-appliance", rev: $rev, dirty: $dirty}'
  else
    jq -cn --arg rev "$rev" --argjson dirty "$dirty" --arg dir "$dir" \
      '{repository: "whombat", rev: $rev, dir: $dir, dirty: $dirty}'
  fi
}
