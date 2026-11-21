#!/usr/bin/env bash
# Scripted end-to-end run of the real binaries (docs/runbooks/backup.md "Verification"):
#   whombat-backup (destination set, run, status, kit-material, snapshots, drill) against a fake runtime admin
#   socket, a real append-only rest-server and a throwaway PostgreSQL database; then whombat-recovery
#   (verify, export) with only the kit and a local copy of the repository.
# Needs: go, git, restic, curl, openssl, python3, rest-server (WB_REST_SERVER), PostgreSQL 17 binaries (WB_PG_BIN),
# a PostgreSQL server (WB_TEST_PG admin DSN). Creates and drops only whombat_bk_test_e2e_* databases.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
export TMPDIR="${TMPDIR:-$HOME/.cache/wb-tmp}"
: "${WB_REST_SERVER:=$HOME/.cache/wb-tmp/bk-bin/rest-server}"
: "${WB_PG_BIN:=$HOME/.cache/wb-tmp/bk-pg17/bin}"
: "${WB_TEST_PG:=postgres://whombat:whombat@127.0.0.1:55432/postgres?sslmode=disable}"
ROOT="$(mktemp -d "$TMPDIR/bk-e2e.XXXXXX")"
DB="whombat_bk_test_e2e_$(openssl rand -hex 4)"
PIDS=()
cleanup() {
  for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null || true; done
  "$WB_PG_BIN/psql" "$WB_TEST_PG" -qc "drop database if exists $DB with (force)" >/dev/null 2>&1 || true
  for q in $("$WB_PG_BIN/psql" "$WB_TEST_PG" -Atc "select datname from pg_database where datname like '${DB}_q%'" 2>/dev/null); do
    "$WB_PG_BIN/psql" "$WB_TEST_PG" -qc "drop database if exists $q with (force)" >/dev/null 2>&1 || true
  done
  [ -n "${KEEP:-}" ] || rm -rf "$ROOT"
}
trap cleanup EXIT
step() { printf '\n== %s\n' "$*"; }
freeport() { python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])'; }
g() { git -c user.name=t -c user.email=t@example.com "$@"; }

step "build"
mkdir -p "$ROOT/bin"
(cd "$HERE" && go build -o "$ROOT/bin/" ./cmd/whombat-backup ./cmd/whombat-backup-snapd ./itest/cmd/fakeruntime)
(cd "$HERE/../recovery" && go build -o "$ROOT/bin/" ./cmd/whombat-recovery)
B="$ROOT/bin/whombat-backup -config $ROOT/config.json"
R="$ROOT/bin/whombat-recovery"

step "appliance world"
P="$ROOT/persist"
# A skill version in the runtime's skill store, under its folder's content hash (Whombat skill-store.md SST-04).
SKILL_MD=$'---\nname: demo\ndescription: A skill the backup test carries.\n---\n\nDo the demo.\n'
SKILL_DIR="$P/whombat/home/skills/$(printf 'SKILL.md\0%s\n' "$(printf '%s' "$SKILL_MD" | sha256sum | cut -d' ' -f1)" | sha256sum | cut -d' ' -f1)"
mkdir -p "$P/whombat/home/files/sha256/ab/cd" "$SKILL_DIR" "$P/whombat/credentials/acct/codex" "$P/secrets"
printf '%s' "$SKILL_MD" > "$SKILL_DIR/SKILL.md"
echo 'dev-only' > "$P/whombat/credentials/acct/codex/auth.json"
echo 'dev-master-key' > "$P/secrets/master.key"
git init -q --bare -b main "$ROOT/upstream.git"
W="$P/whombat/workspaces/b1/proj"; mkdir -p "$W"
( cd "$W" && git init -q -b main && echo hello > README.md && printf 'node_modules/\n' > .gitignore && g add . && g commit -qm initial \
  && git remote add origin "$ROOT/upstream.git" && git push -q origin main \
  && echo feature > feature.txt && g add . && g commit -qm 'unpushed feature' \
  && echo edit >> README.md && echo untracked > untracked.txt && mkdir -p node_modules/x && echo 1 > node_modules/x/i.js )
"$WB_PG_BIN/psql" "$WB_TEST_PG" -qc "create database $DB"
DSN="$(python3 - "$WB_TEST_PG" "$DB" <<'PY'
import sys, urllib.parse as u
p = u.urlparse(sys.argv[1]); print(f"host={p.hostname} port={p.port} user={p.username} password={p.password} dbname={sys.argv[2]} sslmode=disable")
PY
)"
"$WB_PG_BIN/psql" "$DSN" -q <<'SQL'
create table messages (id serial primary key, body text);
insert into messages(body) select 'message ' || g from generate_series(1, 100) g;
SQL

step "rest-server --append-only + fake runtime"
PORT=$(freeport); RPW=$(openssl rand -hex 12)
mkdir -p "$ROOT/rest-data"
printf 'appl:{SHA}%s\n' "$(printf %s "$RPW" | openssl dgst -sha1 -binary | base64)" > "$ROOT/htpasswd"
"$WB_REST_SERVER" --path "$ROOT/rest-data" --listen "127.0.0.1:$PORT" --append-only --htpasswd-file "$ROOT/htpasswd" >"$ROOT/rest.log" 2>&1 &
PIDS+=($!)
"$ROOT/bin/fakeruntime" -socket "$ROOT/admin.sock" 2>"$ROOT/fakeruntime.log" &
PIDS+=($!)
for _ in $(seq 50); do curl -s -o /dev/null "http://127.0.0.1:$PORT/" && [ -S "$ROOT/admin.sock" ] && break; sleep 0.1; done
printf %s "$RPW" > "$ROOT/rest-pw"
cat > "$ROOT/config.json" <<EOF
{"applianceId":"apl-e2e","persist":"$P","runtimeSocket":"$ROOT/admin.sock","driver":"copy","pgDsn":"$DSN",
 "pgBin":"$WB_PG_BIN","quiesceTimeoutMs":20000,"leaseMs":5000,"reserveBytes":1048576,"runtimeUid":$(id -u),"backupUid":$(id -u)}
EOF

step "status before a destination"
$B status | tee "$ROOT/status0.txt"
grep -q 'state: unprotected' "$ROOT/status0.txt"
set +e; $B run; rc=$?; set -e
[ "$rc" = 2 ] || { echo "run without destination: exit $rc, want 2"; exit 1; }

step "destination set (append-only probe)"
$B destination set -repository "rest:http://127.0.0.1:$PORT/appl/" -user appl -password-file "$ROOT/rest-pw" -init
step "checkpoint"
$B run
$B run -json > "$ROOT/run2.json"; cat "$ROOT/run2.json"
$B status -json > "$ROOT/status.json"
python3 - "$ROOT/status.json" <<'PY'
import json, sys
s = json.load(open(sys.argv[1]))
assert s["state"] == "protected" and s["protected"] and s["destination"]["appendOnly"] == "verified", s
print("status:", s["state"], "last success", s["lastSuccess"]["id"], "held", s["lastSuccess"]["quiesceHeldMs"], "ms")
PY
$B snapshots

step "deletion with the appliance credential"
SNAP=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["snapshotId"])' "$ROOT/run2.json")
code=$(curl -s -o /dev/null -w '%{http_code}' -u "appl:$RPW" -X DELETE "http://127.0.0.1:$PORT/appl/snapshots/$SNAP")
echo "DELETE snapshots/$SNAP -> HTTP $code"; [ "$code" = 403 ]

step "drill (quarantine database on the server, read-data all)"
$B drill -server-admin-dsn "$DSN" -db-prefix "${DB}_q" -check-data all
$B status

step "recovery tool with only the kit"
$B kit-material > "$ROOT/kit.json"
$R list -kit "$ROOT/kit.json"
$R verify -kit "$ROOT/kit.json" -check-data 10% -pg-bin "$WB_PG_BIN"
cp -a "$ROOT/rest-data/appl" "$ROOT/repo-copy"
kill "${PIDS[0]}"   # the destination is gone; the copy is all that's left
$R export -kit "$ROOT/kit.json" -repo-dir "$ROOT/repo-copy" -out "$ROOT/export" -pg-bin "$WB_PG_BIN"
git clone -q "$ROOT/export/git-bundles/workspaces/b1/proj.bundle" "$ROOT/clone"
[ "$(git -C "$ROOT/clone" log -1 --format=%s)" = "unpushed feature" ]
grep -q edit "$ROOT/export/workspaces/b1/proj/README.md"
[ -f "$ROOT/export/workspaces/b1/proj/untracked.txt" ]
[ ! -e "$ROOT/export/workspaces/b1/proj/node_modules" ]
grep -q 'message 100' "$ROOT/export/database/whombat.sql"
head -12 "$ROOT/export/README.txt"
kill "${PIDS[1]}"; sleep 0.2; cat "$ROOT/fakeruntime.log"
step "e2e OK"
