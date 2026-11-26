#!/bin/sh
# Runs a command with a throwaway Postgres 17 of its own, inside fast-test's container on the build server
# (.fast-test.json, the server-int-all step). That container has no Docker, so the Postgres runs beside the command,
# in a folder that goes with the container; nothing is worth keeping, so it never waits for the disk.
#
#   scripts/ci/fast-test-postgres.sh <command>...    the command, with DATABASE_URL pointing at it
#
# Only for that container (root, Debian, the network): on a development machine use `fast-test with-postgres`.
set -eu
[ "${WHOMBAT_CHECK:-}" = 1 ] || { echo "fast-test-postgres: only for fast-test's container on the build server" >&2; exit 2; }
[ $# -gt 0 ] || { echo "usage: scripts/ci/fast-test-postgres.sh <command>..." >&2; exit 2; }
bin=/usr/lib/postgresql/17/bin
if [ ! -x "$bin/postgres" ]; then
  # The packages are kept between runs where the build server gives the repository a folder for that.
  archives=${FAST_TEST_CACHE_DIR:-/var/cache/apt}/apt-archives
  mkdir -p "$archives/partial"
  apt-get update -qq
  apt-get install -y -qq --no-install-recommends -o Dir::Cache::archives="$archives" postgresql-17 >/dev/null
fi
data=$(mktemp -d)
chown postgres "$data"
runuser -u postgres -- "$bin/initdb" -D "$data/db" -U whombat --auth=trust -E UTF8 --locale=C.UTF-8 >/dev/null
runuser -u postgres -- "$bin/pg_ctl" -D "$data/db" -l "$data/log" -w -t 60 \
  -o "-h 127.0.0.1 -p 5432 -k $data -c fsync=off -c synchronous_commit=off -c full_page_writes=off -c max_connections=300" \
  start >/dev/null || { cat "$data/log" >&2; exit 2; }
stop() { runuser -u postgres -- "$bin/pg_ctl" -D "$data/db" -m immediate stop >/dev/null 2>&1 || true; }
trap stop EXIT
trap 'exit 130' INT TERM
runuser -u postgres -- "$bin/createdb" -h 127.0.0.1 -U whombat whombat
export DATABASE_URL=postgres://whombat:whombat@127.0.0.1:5432/whombat
"$@"
