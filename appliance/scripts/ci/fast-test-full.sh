#!/usr/bin/env bash
# fast-test's full run on the build server: check.sh without the host tools a container lacks (Postgres, restic, sshd,
# MinIO, nft), whose tests skip themselves. The Nix checks and the VM tests run on ci-platform (nix-checks.sh,
# virtual-machines.sh). GO_PACKAGES limits the Go tests to some packages.
set -euo pipefail
modules=(nix/packages/standins nix/packages/hosts/manifest-check)
# Several tests refuse to run as root (remote help's commands, the manager's peer checks), and the container's user
# is root: the Go tests run as nobody, in a copy of the commit that nobody can read, with their own build cache. The
# copy holds this folder and, beside it, the contracts' Go module that go.mod uses (replace … => ../contracts/go).
top=$PWD
repo=$(git rev-parse --show-toplevel)
folder=${top#"$repo"}
as_user() {
  if [ "$(id -u)" != 0 ]; then "$@"; return; fi
  if [ ! -d /tmp/ft-user/src ]; then
    mkdir -p /tmp/ft-user/src
    git -C "$repo" archive HEAD -- "${folder#/}" contracts/go | tar -x -C /tmp/ft-user/src
    chown -R 65534:65534 /tmp/ft-user
  fi
  (cd "/tmp/ft-user/src$folder${PWD#"$top"}" && setpriv --reuid=65534 --regid=65534 --clear-groups \
    env HOME=/tmp/ft-user TMPDIR=/tmp/ft-user GOCACHE=/tmp/ft-user/go-build GOMODCACHE="$(go env GOMODCACHE)" \
    GOTOOLCHAIN=local "$@")
}
go mod download
for m in "${modules[@]}"; do (cd "$m" && go mod download); done
if [ -n "${GO_PACKAGES:-}" ]; then
  # shellcheck disable=SC2086
  as_user go test -race -count=1 $GO_PACKAGES
  exit
fi
test -z "$(git ls-files '*.go' ':!:nix/packages/standins/**' | xargs gofmt -l)"
go vet ./...
as_user go test -race -count=1 ./...
for m in "${modules[@]}"; do
  (cd "$m" && go vet ./... && as_user go test -count=1 ./...)
done
# The hashes of what the Nix build downloads were taken for this commit's lockfiles and Go modules (no Nix needed).
scripts/ci/fixed-hashes.sh --check
python3 -I -m unittest discover -s scripts/ci -p 'test_fixed_hashes.py'
# The harness tests make their temporary folders in ~/.cache/wb-tmp.
mkdir -p "$HOME/.cache/wb-tmp"
pnpm --dir harness contracts:verify
pnpm --dir harness check
pnpm --dir console/ui check
pnpm --dir console/ui build
