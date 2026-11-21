#!/bin/bash
# Real test of the agent updates (decisions HS-140…HS-161, docs/REST-API.md
# "Agent updates"): a disposable Debian 12 VM with a headless hub inside it
# (agents on 127.0.0.1:8443), a signed build made with a throwaway key in the
# lease's workspace, and three phases:
#   1. an older agent with the key: the automatic round updates it;
#   2. an agent built at 5394c53 without a key: Update now does the last
#      install through exec, and it comes back on the build with the key;
#   3. a signed build that can't connect (protocol 99): the agent rolls back
#      after 5 minutes, the hub marks it failed and halts the round.
# On a test host, through agent-resource (it removes the VM when the script ends):
#
#   agent-resource run --task "whombat-hosts agent updates test" --ttl 1h -- \
#     bash scripts/agent-updates-realtest.sh
set -uo pipefail
cd "$(dirname "$0")/.."
lease=$AGENT_RESOURCE_LEASE; ws=$AGENT_RESOURCE_WORKSPACE
export TMPDIR=${TMPDIR:-$HOME/.cache/wb-tmp} CGO_ENABLED=0 RACKOON_SIGNING_KEY=$ws/signing.key
mkdir -p "$TMPDIR"
echo "lease $lease"
V0=0.0.0-20261018094703.5394c53 V1=0.0.0-20261019120000.1111111 V2=0.0.0-20261020120000.2222222 V3=0.0.0-20261020130000.3333333
mkdir -p "$ws"/{v0,v1,dist,dist3,src0,src3}
PUB=$(go run ./cmd/rackoon-sign pubkey) || { echo "FAIL signing key"; exit 1; }
agent() { (cd "$1" && go build -trimpath -ldflags "-s -w -X main.version=$2 ${3:+-X rackoon/internal/agent.UpdatePublicKey=$3}" -o "$4" ./cmd/whombat-agent); }
agent . $V1 "$PUB" "$ws/v1/whombat-agent-linux-amd64" &&
  agent . $V2 "$PUB" "$ws/dist/whombat-agent-linux-amd64" &&
  git archive 5394c53 | tar -x -C "$ws/src0" && agent "$ws/src0" $V0 "" "$ws/v0/whombat-agent-linux-amd64" &&
  git archive HEAD | tar -x -C "$ws/src3" && sed -i 's/^const Version = 1$/const Version = 99/' "$ws/src3/internal/proto/proto.go" &&
  agent "$ws/src3" $V3 "$PUB" "$ws/dist3/whombat-agent-linux-amd64" &&
  go run ./cmd/rackoon-sign manifest --version $V2 --dir "$ws/dist" whombat-agent-linux-amd64 &&
  go run ./cmd/rackoon-sign manifest --version $V3 --dir "$ws/dist3" whombat-agent-linux-amd64 &&
  go build -trimpath -ldflags "-s -w -X main.version=$V2" -o "$ws/whombat-hosts" ./cmd/whombat-hosts || { echo "FAIL build"; exit 1; }
rm -rf "$ws/src0" "$ws/src3" "$RACKOON_SIGNING_KEY"

vm=$(agent-resource vm-launch --lease "$lease" images:debian/12) || { echo "FAIL vm-launch"; exit 1; }
echo "vm $vm"
X() { incus --project agent-tasks exec "$vm" -- "$@"; }
for i in $(seq 1 90); do X true 2>/dev/null && break; sleep 2; done
X sh -c 'cat /etc/debian_version; systemctl is-system-running --wait' || true
X mkdir -p /opt/rt/v0 /opt/rt/v1 /opt/rt/dist /opt/rt/dist3
for f in whombat-hosts v0/whombat-agent-linux-amd64 v1/whombat-agent-linux-amd64 dist/whombat-agent-linux-amd64 dist/manifest.json \
         dist3/whombat-agent-linux-amd64 dist3/manifest.json; do
  incus --project agent-tasks file push -q --mode 0755 "$ws/$f" "$vm/opt/rt/$f" || echo "FAIL push $f"
done

cat > "$ws/vm.sh" <<'VM'
set -u
V0=0.0.0-20261018094703.5394c53 V1=0.0.0-20261019120000.1111111 V2=0.0.0-20261020120000.2222222 V3=0.0.0-20261020130000.3333333
D=/opt/rt
log() { echo "[$(date +%T)] $*"; }
ok() { echo "PASS $1"; }
bad() { echo "FAIL $1"; }
check() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }
mkdir -p /var/lib/hub
systemd-run --quiet --unit=rt-hub --collect $D/whombat-hosts serve --headless --data /var/lib/hub --listen unix:/run/hub.sock \
  --service-token-file /var/lib/hub/token --agent-listen 127.0.0.1:8443 --agent-url wss://127.0.0.1:8443 --agent-dist $D/dist \
  --agent-update-grace 10s --agent-update-interval 1m --agent-update-after-connect 5s
for i in $(seq 1 50); do [ -S /run/hub.sock ] && [ -s /var/lib/hub/token ] && break; sleep 0.2; done
TOK=$(cat /var/lib/hub/token)
api() { curl -sS --unix-socket /run/hub.sock -H "Authorization: Bearer $TOK" -H "X-Whombat-Actor: pe_1|John" -H 'Content-Type: application/json' "$@"; }
update_of() { api http://hub/api/v1/agents | sed -n 's/.*"update":\({[^}]*}\).*/\1/p'; } # one server at a time here
version() { /usr/local/bin/whombat-agent version | cut -d' ' -f2; }
wait_update() { # seconds pattern: the pattern, and no rollout state
  for i in $(seq 1 "$1"); do u=$(update_of); case "$u" in *'"state"'*) ;; *$2*) return 0;; esac; sleep 1; done; return 1
}
install_agent() { # name binary-dir
  en=$(api -X POST http://hub/api/v1/enrollments -d "{\"approve\":true,\"control\":\"full\",\"name\":\"$1\"}")
  cmd=$(printf '%s' "$en" | sed -n 's/.*"install_command":"\([^"]*\)".*/\1/p' | sed 's/| sudo sh -s --/| sh -s --/')
  sh -c "$cmd --download-base file://$2 --sha256 $(sha256sum $2/whombat-agent-linux-amd64 | cut -d' ' -f1)" 2>&1 | tail -1
}

log "phase 1: an older agent with the key"
install_agent rt-a $D/v1
check "rt-a runs $V1" '[ "$(version)" = $V1 ]'
check "the round takes rt-a" 'for i in $(seq 1 10); do update_of | grep -q "\"auto\":true" && break; sleep 0.5; done; update_of | grep -q "\"auto\":true\|\"state\":\"updating\""'
check "the round updated rt-a" 'wait_update 120 "\"reason_code\":\"up_to_date\""'
check "rt-a runs $V2" '[ "$(version)" = $V2 ]'
check "audited by auto" 'api "http://hub/api/v1/audit?event=agent.updated" | grep -q "\"by\":\"auto\""'
check "updated_at" 'update_of | grep -q "\"updated_at\":"'

log "phase 2: the agent of 5394c53 without a key"
curl -fsSL --insecure https://127.0.0.1:8443/install.sh | sh -s -- --uninstall --purge >/dev/null
api -X DELETE http://hub/api/v1/servers/rt-a
install_agent rt-b $D/v0
check "rt-b runs $V0" '[ "$(version)" = $V0 ]'
check "rt-b needs its last install, and Whombat may" 'wait_update 30 "\"reason_code\":\"no_key\"" && update_of | grep -q "\"can_install\":true"'
r=$(api -X POST http://hub/api/v1/agents/update -d '{"servers":["rt-b"]}'); log "$r"
check "Update now does the last install" 'printf "%s" "$r" | grep -q "\"installing\":\[\"rt-b\"\]"'
check "rt-b came back keyed on the build" 'wait_update 600 "\"reason_code\":\"up_to_date\""'
check "rt-b runs $V2" '[ "$(version)" = $V2 ]'
check "the installer kept its identity" 'grep -q "whombat-agent: kept rt-b" /var/lib/whombat-agent/last-install.log'
check "in its own unit" 'journalctl --no-pager -o cat -u "whombat-agent-reinstall-*" | grep -q "Deactivated successfully"'
check "without systemd warnings" '! journalctl --no-pager -o cat -u "whombat-agent-reinstall-*" | grep -q "Ignoring unknown escape"'
check "exec audited as the install" 'api "http://hub/api/v1/audit?event=exec.requested" | grep -q "\"purpose\":\"agent_install\""'
check "audited by the person" 'api "http://hub/api/v1/audit?event=agent.updated" | grep -q "\"by\":\"John (pe_1)\""'
tail -4 /var/lib/whombat-agent/last-install.log

log "phase 3: a build that can't connect"
cp $D/dist3/whombat-agent-linux-amd64 $D/dist/whombat-agent-linux-amd64.new && mv $D/dist/whombat-agent-linux-amd64.new $D/dist/whombat-agent-linux-amd64
cp $D/dist3/manifest.json $D/dist/manifest.json
check "the round fails it once the agent went back" 'for i in $(seq 1 540); do update_of | grep -q "\"state\":\"failed\"" && break; sleep 1; done; update_of | grep -q "\"failed_version\":\"$V3\""'
check "rt-b runs $V2 again" '[ "$(version)" = $V2 ]'
check "halted" 'api http://hub/api/v1/agents/settings | grep -q "\"halted_version\":\"$V3\""'
n0=$(journalctl -u whombat-agent --no-pager -o cat | grep -c "update request")
sleep 75
check "the next round doesn't try again" '[ "$(journalctl -u whombat-agent --no-pager -o cat | grep -c "update request")" = "$n0" ]'
update_of; echo
VM
incus --project agent-tasks file push -q "$ws/vm.sh" "$vm/opt/rt/vm.sh"
out=$(X sh /opt/rt/vm.sh 2>&1); echo "$out"
fails=$(grep -c '^FAIL' <<<"$out"); passes=$(grep -c '^PASS' <<<"$out")
echo "$passes passed, $fails failed"
[ "$fails" = 0 ] && [ "$passes" -gt 0 ]
