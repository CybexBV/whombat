#!/usr/bin/env bash
# Fetch the pinned external tools the integration tests use into ~/.cache/wb-tmp (no root needed):
#   rest-server v0.14.0 (go install), PostgreSQL 17 client/server binaries (nixpkgs#postgresql_17),
#   OpenSSH (sshd for the SFTP destination tests) and MinIO (the S3 destination tests; nixpkgs marks it
#   insecure because upstream stopped maintaining it: it runs only on loopback in tests).
# restic 0.18 and git come from the host (or nixpkgs#restic). Prints the env to export.
set -euo pipefail
CACHE="${WB_TOOLS:-$HOME/.cache/wb-tmp}"
mkdir -p "$CACHE/bk-bin"
export TMPDIR="${TMPDIR:-$CACHE}"
if [ ! -x "$CACHE/bk-bin/rest-server" ]; then
  GOBIN="$CACHE/bk-bin" go install github.com/restic/rest-server/cmd/rest-server@v0.14.0
fi
if [ ! -x "$CACHE/bk-pg17/bin/pg_dump" ]; then
  nix --extra-experimental-features 'nix-command flakes' build nixpkgs#postgresql_17 --out-link "$CACHE/bk-pg17"
fi
if [ ! -x "$CACHE/bk-openssh/bin/sshd" ]; then
  nix --extra-experimental-features 'nix-command flakes' build nixpkgs#openssh --out-link "$CACHE/bk-openssh"
fi
if [ ! -x "$CACHE/bk-minio/bin/minio" ]; then
  NIXPKGS_ALLOW_INSECURE=1 nix --extra-experimental-features 'nix-command flakes' build --impure nixpkgs#minio --out-link "$CACHE/bk-minio"
fi
command -v restic >/dev/null || { echo "restic 0.18 not on PATH (nix shell nixpkgs#restic)"; exit 1; }
echo "export WB_REST_SERVER=$CACHE/bk-bin/rest-server"
echo "export WB_PG_BIN=$CACHE/bk-pg17/bin"
echo "export WB_SSHD=$CACHE/bk-openssh/bin/sshd"
echo "export WB_MINIO=$CACHE/bk-minio/bin/minio"
echo "export WB_TEST_PG=${WB_TEST_PG:-postgres://whombat:whombat@127.0.0.1:55432/postgres?sslmode=disable}"
