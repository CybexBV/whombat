#!/usr/bin/env bash
# Checkpoint + drill against the real Whombat runtime schema, with the runtime's own audit-chain verifier
# (optional qualification, docs/runbooks/restore.md). Reads a Whombat checkout without modifying it:
#   RUNTIME_DIR=~/Code/Whombat/.claude/worktrees/managed-runtime backup/scripts/real-runtime.sh
# It migrates and seeds a throwaway database (whombat_bk_test_rt_*) with the runtime's `db:seed` (the mock
# world through the commit pipeline, every event signed and chained), takes a checkpoint through a fake admin
# socket, then drills with `audit:verify` against the quarantine database. Drops only what it creates.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
export TMPDIR="${TMPDIR:-$HOME/.cache/wb-tmp}"
: "${RUNTIME_DIR:?set RUNTIME_DIR to a Whombat checkout with node_modules installed}"
: "${WB_PG_BIN:=$HOME/.cache/wb-tmp/bk-pg17/bin}"
: "${WB_REST_SERVER:=$HOME/.cache/wb-tmp/bk-bin/rest-server}"
PGHOSTPORT="${WB_PG_HOSTPORT:-127.0.0.1:55432}"
PGUP="${WB_PG_USERPASS:-whombat:whombat}"
ROOT="$(mktemp -d "$TMPDIR/bk-rt.XXXXXX")"
DB="whombat_bk_test_rt_$(openssl rand -hex 4)"
ADMIN="postgres://$PGUP@$PGHOSTPORT/postgres"
PIDS=()
cleanup() {
  for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null || true; done
  for d in $("$WB_PG_BIN/psql" "$ADMIN" -Atc "select datname from pg_database where datname like '${DB}%'"); do
    "$WB_PG_BIN/psql" "$ADMIN" -qc "drop database if exists $d with (force)" >/dev/null || true
  done
  [ -n "${KEEP:-}" ] || rm -rf "$ROOT"
}
trap cleanup EXIT
TSX="$RUNTIME_DIR/node_modules/.bin/tsx"
MASTER="$(openssl rand -base64 32)"
echo "runtime: $(git -C "$RUNTIME_DIR" rev-parse --short HEAD) ($(git -C "$RUNTIME_DIR" status --short | wc -l) locally modified files)"

"$WB_PG_BIN/psql" "$ADMIN" -qc "create database $DB"
cat > "$ROOT/seed.env" <<EOF
DATABASE_URL=postgres://$PGUP@$PGHOSTPORT/$DB
NODE_ENV=development
WHOMBAT_HOME=$ROOT/persist/whombat/home
WHOMBAT_FILES_DIR=$ROOT/persist/whombat/home/files
WHOMBAT_MASTER_KEY=$MASTER
EOF
mkdir -p "$ROOT/persist/whombat/home/files" "$ROOT/persist/secrets"
printf '%s\n' "$MASTER" > "$ROOT/persist/secrets/master.key"
(cd "$RUNTIME_DIR/apps/server" && WHOMBAT_ENV_FILE="$ROOT/seed.env" "$TSX" src/scripts/seed.ts)

# The audit verifier as the drill runs it: DATABASE_URL points at the quarantine database.
cat > "$ROOT/audit-verify.sh" <<EOF
#!/usr/bin/env bash
set -euo pipefail
f=\$(mktemp)
printf 'DATABASE_URL=%s\nNODE_ENV=development\nWHOMBAT_MASTER_KEY=%s\nWHOMBAT_HOME=$ROOT/q\n' "\$DATABASE_URL" "$MASTER" > "\$f"
cd "$RUNTIME_DIR/apps/server" && WHOMBAT_ENV_FILE="\$f" "$TSX" src/scripts/audit-verify.ts; rc=\$?; rm -f "\$f"; exit \$rc
EOF
chmod +x "$ROOT/audit-verify.sh"

mkdir -p "$ROOT/bin" "$ROOT/rest"
(cd "$HERE" && go build -o "$ROOT/bin/" ./cmd/whombat-backup ./itest/cmd/fakeruntime)
PORT=$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])')
RPW=$(openssl rand -hex 12)
printf 'appl:{SHA}%s\n' "$(printf %s "$RPW" | openssl dgst -sha1 -binary | base64)" > "$ROOT/htpasswd"
"$WB_REST_SERVER" --path "$ROOT/rest" --listen "127.0.0.1:$PORT" --append-only --htpasswd-file "$ROOT/htpasswd" >/dev/null 2>&1 &
PIDS+=($!)
"$ROOT/bin/fakeruntime" -socket "$ROOT/admin.sock" 2>/dev/null &
PIDS+=($!)
sleep 0.5
printf %s "$RPW" > "$ROOT/rest-pw"
H=${PGHOSTPORT%:*}; P=${PGHOSTPORT#*:}; U=${PGUP%:*}; W=${PGUP#*:}
cat > "$ROOT/config.json" <<EOF
{"applianceId":"apl-rt","persist":"$ROOT/persist","runtimeSocket":"$ROOT/admin.sock","driver":"copy",
 "pgDsn":"host=$H port=$P user=$U password=$W dbname=$DB sslmode=disable","pgBin":"$WB_PG_BIN",
 "reserveBytes":1048576,"runtimeUid":$(id -u),"backupUid":$(id -u)}
EOF
B="$ROOT/bin/whombat-backup -config $ROOT/config.json"
$B destination set -repository "rest:http://127.0.0.1:$PORT/appl/" -user appl -password-file "$ROOT/rest-pw" -init
$B run
$B drill -server-admin-dsn "host=$H port=$P user=$U password=$W dbname=postgres sslmode=disable" -db-prefix "${DB}_q" \
  -check-data all -audit-verify "$ROOT/audit-verify.sh"
$B status
