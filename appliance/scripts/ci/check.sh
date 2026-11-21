#!/usr/bin/env bash
set -euo pipefail
: "${WB_TEST_PG:?Use an isolated CI PostgreSQL instance}"
: "${WB_PG_BIN:?Set the PostgreSQL 17 binary directory}"
for tool in restic rest-server ssh-keygen nft ip unshare "${WB_SSHD:-/usr/sbin/sshd}" "${WB_MINIO:-minio}"; do
  if ! command -v "$tool" >/dev/null; then
    printf 'Missing required CI test tool: %s\n' "$tool" >&2
    exit 1
  fi
done
for tool in pg_dump pg_restore initdb pg_ctl; do test -x "$WB_PG_BIN/$tool"; done
"$WB_PG_BIN/pg_isready" -d "$WB_TEST_PG"
unshare --user --map-root-user --mount --net true
unshare --user --map-root-user --net nft list ruleset >/dev/null
test -z "$(git ls-files '*.go' ':!:nix/packages/standins/**' | xargs gofmt -l)"
go vet ./...
go test -race -count=1 ./...
scripts/ci/fixed-hashes.sh --check
python3 -I -m unittest discover -s scripts/ci -p 'test_fixed_hashes.py'
(cd nix/packages/standins && go vet ./... && go test -count=1 ./...)
(cd nix/packages/hosts/manifest-check && go vet ./... && go test -count=1 ./...)
mkdir -p "$RUNNER_TEMP/appliance-bin"
go build -trimpath -o "$RUNNER_TEMP/appliance-bin/" ./...
pnpm --dir harness install --frozen-lockfile --store-dir /srv/whombat-ci/cache/pnpm
pnpm --dir harness contracts:verify
pnpm --dir harness lint
pnpm --dir harness typecheck
pnpm --dir harness test:unit --maxWorkers=4
pnpm --dir console/ui install --frozen-lockfile --store-dir /srv/whombat-ci/cache/pnpm
pnpm --dir console/ui lint
pnpm --dir console/ui typecheck
pnpm --dir console/ui test --maxWorkers=4
pnpm --dir console/ui build
