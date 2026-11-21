#!/bin/sh
# Prepares fast-test's container on the build server (the Node image; .fast-test.json, `beast.prepare`).
#
#   scripts/ci/fast-test-prepare.sh              what every run needs: pnpm and the workspace's packages
#   scripts/ci/fast-test-prepare.sh go           Go, for a step that runs Go
#   scripts/ci/fast-test-prepare.sh appliance    Go, jq, dbus-daemon and the packages of the harness and the console page
#   scripts/ci/fast-test-prepare.sh hosts        Go and the packages of the hosts service's web UI
#
# Only the first runs before every command. A step that needs more asks for it itself (scripts/ci/full.sh, the
# hosts-hub step), so a run that touches neither folder pays nothing for them. Everything here can run twice.
set -eu
cd "$(dirname "$0")/../.."
# One Go for the three modules (contracts/go, appliance, hosts): the newest any of them asks for (hosts/mise.toml).
GO_VERSION=1.27.2
GO_SHA256=ecbadb99091a3f46e31f5f934b068b1864eafa7995211b39eaddf76996045fe5

workspace() {
  corepack enable
  pnpm install --frozen-lockfile --store-dir /cache/pnpm
}

go_toolchain() {
  if command -v go >/dev/null 2>&1 && [ "$(go env GOVERSION 2>/dev/null)" = "go$GO_VERSION" ]; then return; fi
  # Kept between runs where the build server gives the repository a folder for that.
  keep=${FAST_TEST_CACHE_DIR:-/opt}/go-toolchain
  if [ ! -x "$keep/go$GO_VERSION/bin/go" ]; then
    mkdir -p "$keep"
    tmp=$(mktemp -d "$keep/.fetch.XXXXXX")
    curl -fsSL -o "$tmp/go.tgz" "https://go.dev/dl/go$GO_VERSION.linux-amd64.tar.gz"
    echo "$GO_SHA256  $tmp/go.tgz" | sha256sum -c - >/dev/null
    tar -xzf "$tmp/go.tgz" -C "$tmp"
    # Two runs may fetch at once: the first to finish wins, the other's copy is dropped.
    mv "$tmp/go" "$keep/go$GO_VERSION" 2>/dev/null || true
    rm -rf "$tmp"
  fi
  ln -sf "$keep/go$GO_VERSION/bin/go" "$keep/go$GO_VERSION/bin/gofmt" /usr/local/bin/
}

packages() {
  missing=
  for tool in "$@"; do command -v "$tool" >/dev/null 2>&1 || missing="$missing $tool"; done
  # shellcheck disable=SC2086 # one package name per word
  [ -z "$missing" ] || { apt-get update -qq && apt-get install -y -qq $missing >/dev/null; }
}

case ${1:-} in
  "") workspace ;;
  go) go_toolchain ;;
  appliance)
    go_toolchain
    # dbus-daemon: the DNS fallback's tests talk to a private bus. jq: release/schema-numbers, which a Go test calls.
    packages jq dbus-daemon
    pnpm --dir appliance/harness install --frozen-lockfile --store-dir /cache/pnpm
    pnpm --dir appliance/console/ui install --frozen-lockfile --store-dir /cache/pnpm
    ;;
  hosts)
    go_toolchain
    packages make
    pnpm --dir hosts/web install --frozen-lockfile --store-dir /cache/pnpm
    ;;
  *) echo "fast-test-prepare: unknown part $1 (go, appliance or hosts)" >&2; exit 2 ;;
esac
