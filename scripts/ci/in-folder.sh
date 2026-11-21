#!/usr/bin/env bash
# Runs a command inside appliance/ or hosts/ on paths named from the repository's root.
#
#   scripts/ci/in-folder.sh <folder> <command> [arguments…] -- [paths…]
#
# fast-test fills a step's {files} and {dirs} with paths from the root (appliance/manager/x.go, ./appliance/manager).
# The two folders' own tools expect paths from their folder, where their go.mod is. This takes the folder off the
# front of each path (./appliance/manager becomes ./manager, the folder itself becomes .), changes into the folder and
# runs the command with the paths after its arguments. A path outside the folder is an error.
set -euo pipefail
[ $# -ge 2 ] || { echo "usage: in-folder.sh <folder> <command> [arguments…] -- [paths…]" >&2; exit 2; }
folder=${1%/}
shift
command=()
while [ $# -gt 0 ] && [ "$1" != -- ]; do
  command+=("$1")
  shift
done
[ ${#command[@]} -gt 0 ] || { echo "in-folder: no command" >&2; exit 2; }
[ $# -eq 0 ] || shift
paths=()
for path in "$@"; do
  # A path that came with ./ keeps it: Go reads ./manager as a folder and manager as a package to look up.
  dot=""
  case $path in ./*) dot=./ path=${path#./} ;; esac
  case $path in
    "$folder") path=. dot="" ;;
    "$folder"/*) path=$dot${path#"$folder"/} ;;
    *) echo "in-folder: $path is not in $folder/" >&2; exit 2 ;;
  esac
  paths+=("$path")
done
cd "$(dirname "$0")/../../$folder"
exec "${command[@]}" ${paths[@]+"${paths[@]}"}
