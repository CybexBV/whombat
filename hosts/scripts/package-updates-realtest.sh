#!/bin/bash
# Real test of packages.check / packages.install (docs/MANAGE.md 2.9,
# decisions HS-119…HS-136): a disposable Debian 12 VM, real apt and dpkg,
# the real agent binary driving its broker through console-test. On
# a test host, through agent-resource (it removes the VM when the script ends):
#
#   CGO_ENABLED=0 go build -o "$HOME/.cache/wb-tmp/whombat-agent" ./cmd/whombat-agent
#   agent-resource run --task "whombat-hosts apt install test" --ttl 1h -- \
#     bash scripts/package-updates-realtest.sh "$HOME/.cache/wb-tmp/whombat-agent"
#
# The VMs have no internet, so the packages come from a local repository of
# real bookworm packages the host downloads (old: the release pocket, new:
# bookworm-security), and two small HTTP servers in the VM play a Proxmox
# enterprise repository answering 401 and a repository answering 404.
set -uo pipefail
AGENT=$1
lease=$AGENT_RESOURCE_LEASE; ws=$AGENT_RESOURCE_WORKSPACE
echo "lease $lease"
fails=0
ok()  { echo "PASS $1"; }
bad() { echo "FAIL $1"; fails=$((fails+1)); }
has() { grep -qF -- "$2" <<<"$1"; }
vm=$(agent-resource vm-launch --lease "$lease" images:debian/12) || { echo "FAIL vm-launch"; exit 1; }
echo "vm $vm"
X() { incus --project agent-tasks exec "$vm" -- "$@"; }
for i in $(seq 1 90); do X true 2>/dev/null && break; sleep 2; done
X sh -c 'cat /etc/debian_version; systemctl is-system-running --wait' || true

# Real Debian packages: bookworm's release pocket (old) and bookworm-security (new).
mkdir -p "$ws/old" "$ws/new"
for f in main/e/expat/libexpat1_2.5.0-1+deb12u2_amd64.deb main/t/tzdata/tzdata_2026b-0+deb12u1_all.deb \
         main/libs/libssh2/libssh2-1_1.10.0-3+b1_amd64.deb main/libp/libpng1.6/libpng16-16_1.6.39-2+deb12u5_amd64.deb; do
  curl -fsS -m 120 -o "$ws/old/$(basename "$f")" "http://deb.debian.org/debian/pool/$f" || bad "download $f"
done
for f in updates/main/e/expat/libexpat1_2.5.0-1+deb12u4_amd64.deb updates/main/t/tzdata/tzdata_2026c-0+deb12u1_all.deb \
         updates/main/libs/libssh2/libssh2-1_1.10.0-3+deb12u1_amd64.deb updates/main/libp/libpng1.6/libpng16-16_1.6.39-2+deb12u6_amd64.deb; do
  curl -fsS -m 120 -o "$ws/new/$(basename "$f")" "http://deb.debian.org/debian-security/pool/$f" || bad "download $f"
done
(cd "$ws/new" && apt-ftparchive packages . > Packages && gzip -kf Packages &&
 apt-ftparchive -o APT::FTPArchive::Release::Origin=Debian -o APT::FTPArchive::Release::Label=Debian-Security \
   -o APT::FTPArchive::Release::Suite=bookworm-security -o APT::FTPArchive::Release::Version=12 release . > Release)
incus --project agent-tasks file push -r -p "$ws/new" "$vm/srv/" >/dev/null
incus --project agent-tasks file push -r -p "$ws/old" "$vm/root/" >/dev/null
incus --project agent-tasks file push -p "$AGENT" "$vm/usr/local/bin/whombat-agent" >/dev/null
X bash -c '
set -e
mv /srv/new /srv/repo; chmod -R a+rX /srv/repo; chmod 755 /usr/local/bin/whombat-agent
DEBIAN_FRONTEND=noninteractive dpkg -i /root/old/*.deb >/dev/null 2>&1
apt-mark hold libpng16-16 >/dev/null
echo "deb [trusted=yes] file:/srv/repo ./" > /etc/apt/sources.list
echo "DPkg::Pre-Invoke {\"sleep 12\";};" > /etc/apt/apt.conf.d/99slow-test
whombat-agent version
dpkg-query -W libexpat1 tzdata libssh2-1 libpng16-16'
A="whombat-agent console-test --platform host"
taskid() { sed -n 's/.*"id": "\(pkg:[0-9a-f]*\)".*/\1/p' <<<"$1" | head -1; }

echo "== 1. check (refreshes the lists)"
out=$(X $A --manage packages.check --follow 2>&1)
has "$out" '"status": "ok"' && has "$out" "3 updates waiting, 3 for security." && ok "check: 3 waiting, held one not counted" || { bad "check"; echo "$out"; }
has "$out" '| $ apt-get -q -o DPkg::Lock::Timeout=120 update' && ok "check: the log pages" || bad "check log"

echo "== 2. a check from inside the agent unit's sandbox"
out=$(X systemd-run --quiet --wait --pipe --collect -p ProtectSystem=strict -p ProtectHome=yes -p PrivateTmp=yes -p NoNewPrivileges=yes \
  -p StateDirectory=whombat-agent -p StateDirectoryMode=0700 -p ProtectKernelTunables=yes -p ProtectKernelModules=yes -p ProtectKernelLogs=yes \
  -p ProtectControlGroups=yes -p RestrictNamespaces=yes -p RestrictSUIDSGID=yes -p LockPersonality=yes -p MemoryDenyWriteExecute=yes \
  -p "RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK" -p "CapabilityBoundingSet=~CAP_SYS_TIME CAP_WAKE_ALARM" \
  /usr/local/bin/whombat-agent console-test --platform host --manage packages.check --follow 2>&1)
has "$out" '"status": "ok"' && ok "sandboxed agent: the unit runs outside the sandbox" || { bad "sandboxed check"; echo "$out"; }

echo "== 3. install; stop refused; the report; a follower killed mid-task; a new one finds the result"
out=$(X $A --manage packages.install 2>&1); id=$(taskid "$out"); unit=whombat-pkg-${id#pkg:}.service
echo "task $id"
sleep 2
out=$(X $A --manage task.stop --task "$id" 2>&1); has "$out" '"code": "not_allowed"' && ok "an install can't be stopped" || { bad "stop install"; echo "$out"; }
out=$(X systemctl show -p ActiveState -p ControlGroup -p RuntimeMaxUSec "$unit"); echo "$out"
has "$out" "ActiveState=active" && has "$out" "ControlGroup=/system.slice/$unit" && ok "own transient unit, own cgroup" || bad "unit"
out=$(X $A --package-report 2>&1); has "$out" "\"ID\": \"$id\"" && ok "report: package_task while it runs" || { bad "package_task"; echo "$out"; }
out=$(X $A --manage task.status --task "$id" --log-start 0 2>&1); has "$out" '"status": "running"' && ok "status: running, log from 0" || bad "status running"
X bash -c "whombat-agent console-test --platform host --manage task.status --task $id --log-start 0 --follow >/root/follow1.log 2>&1 & p=\$!; sleep 3; kill -9 \$p; wait \$p; echo killed \$?; grep -c '^| ' /root/follow1.log"
out=$(X systemctl is-active "$unit" 2>&1); [ "$out" = active ] && ok "the unit kept running after the follower was killed" || bad "unit after kill: $out"
out=$(X $A --manage task.status --task "$id" --log-start 4 --follow 2>&1)
has "$out" '"status": "ok"' && has "$out" "Installed 3 updates." && has "$out" '"installed": 3' && has "$out" '"libpng16-16"' \
  && ok "a new process followed it to the end: 3 installed, the held one kept back" || { bad "install result"; echo "$out" | tail -25; }
has "$out" "| Unpacking libexpat1:amd64 (2.5.0-1+deb12u4)" && ok "log paged from line 4 on" || bad "log paging"
out=$(X $A --package-report 2>&1)
has "$out" '"package_task": null' && has "$out" '"Op": "install"' && has "$out" '"Installed": 3' && ok "package_last: install ok 3" || { bad "package_last"; echo "$out"; }
out=$(X $A --inspect updates 2>&1); [ "$(grep -c '"Name"' <<<"$out")" = 0 ] && ok "counts dropped to 0" || { bad "counts"; echo "$out"; }
X dpkg-query -W libexpat1 tzdata libssh2-1 libpng16-16
out=$(X systemctl list-units --all 'whombat-pkg-*' --no-legend 2>&1); [ -z "$out" ] && ok "units collected" || { bad "units left"; echo "$out"; }

echo "== 4. a held package by name, then unheld"
out=$(X $A --manage packages.install --packages libpng16-16 --follow 2>&1)
has "$out" '"status": "error"' && has "$out" "E: Held packages were changed" && ok "held stays held, apt's line" || { bad "held"; echo "$out" | tail -15; }
X apt-mark unhold libpng16-16 >/dev/null
out=$(X $A --manage packages.install --packages libpng16-16 --follow 2>&1)
has "$out" "Installed 1 update." && ok "named install" || { bad "named"; echo "$out" | tail -15; }

echo "== 5. Proxmox enterprise repository refusing (401), then another repository failing"
X bash -c '
cat > /root/http.pl <<"EOF"
use IO::Socket::INET;
my ($addr, $status) = @ARGV;
my $s = IO::Socket::INET->new(LocalAddr => $addr, LocalPort => 80, Listen => 10, ReuseAddr => 1) or die "listen: $!";
while (my $c = $s->accept) { while (my $l = <$c>) { last if $l =~ /^\r?\n$/; } print $c "HTTP/1.1 $status\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"; close $c; }
EOF
nohup perl /root/http.pl 127.0.0.1 "401 Unauthorized" >/dev/null 2>&1 &
nohup perl /root/http.pl 127.0.0.2 "404 Not Found" >/dev/null 2>&1 &
printf "127.0.0.1 enterprise.proxmox.com\n127.0.0.2 deb.example.org\n" >> /etc/hosts
echo "deb http://enterprise.proxmox.com/debian/pve bookworm pve-enterprise" > /etc/apt/sources.list.d/pve-enterprise.list
DEBIAN_FRONTEND=noninteractive dpkg -i /root/old/tzdata_2026b-0+deb12u1_all.deb >/dev/null 2>&1; sleep 1'
out=$(X $A --manage packages.install --follow 2>&1)
has "$out" "Installed 1 update." && has "$out" "The Proxmox enterprise repository refused (it needs a subscription); the other repositories were used." \
  && ok "401: carried on, SWU-06 warning" || { bad "401"; echo "$out" | tail -15; }
X bash -c 'echo "deb http://deb.example.org/debian bookworm main" > /etc/apt/sources.list.d/example.list; DEBIAN_FRONTEND=noninteractive dpkg -i /root/old/tzdata_2026b-0+deb12u1_all.deb >/dev/null 2>&1'
out=$(X $A --manage packages.install --follow 2>&1)
has "$out" '"status": "error"' && has "$out" "\"message\": \"E: The repository 'http://deb.example.org/debian bookworm Release' does not have a Release file.\"" && has "$out" '"warning": ""' \
  && ok "another repository failing stops it with apt's line" || { bad "404"; echo "$out" | tail -15; }
X rm /etc/apt/sources.list.d/example.list

echo "== 6. stopping a check"
X bash -c 'echo "APT::Update::Pre-Invoke {\"sleep 20\";};" > /etc/apt/apt.conf.d/99slow-update'
out=$(X $A --manage packages.check 2>&1); id=$(taskid "$out"); sleep 2
out=$(X $A --manage task.status --task "$id" --log-start -1 2>&1); has "$out" '"cancellable": true' && ok "a running check is cancellable" || bad "cancellable"
X $A --manage task.stop --task "$id" >/dev/null 2>&1
out=$(X $A --manage task.status --task "$id" --log-start -1 2>&1); has "$out" "Checking for updates was stopped." && ok "check stopped" || { bad "check stop"; echo "$out"; }
X rm /etc/apt/apt.conf.d/99slow-update

echo "== 7. the runner killed mid-install (as if the server went down)"
out=$(X $A --manage packages.install 2>&1); id=$(taskid "$out"); unit=whombat-pkg-${id#pkg:}.service; sleep 3
X systemctl kill -s KILL "$unit"; sleep 1
out=$(X $A --manage task.status --task "$id" --log-start -1 2>&1)
has "$out" '"status": "error"' && has "$out" "The server may have restarted while it ran." && ok "a lost runner is reported" || { bad "lost runner"; echo "$out"; }
out=$(X $A --manage packages.install --follow 2>&1); has "$out" "Installed 1 update." && ok "the next install works" || { bad "after lost runner"; echo "$out" | tail -10; }

echo "== 8. another program holds the dpkg lock for over two minutes"
X bash -c '
cat > /root/holdlock.pl <<"EOF"
use Fcntl;
$| = 1;
open(my $f, ">>", "/var/lib/dpkg/lock-frontend") or die "open: $!";
my $lk = pack("s s x4 q q i x4", F_WRLCK, 0, 0, 0, 0);
fcntl($f, F_SETLK, $lk) or die "lock: $!";
print "holding\n";
sleep($ARGV[0]);
EOF'
t0=$(date +%s)
# The holder and the check in one exec, so the holder lives as long as the check.
out=$(X bash -c 'perl /root/holdlock.pl 150 > /root/holdlock.out 2>&1 & sleep 1; cat /root/holdlock.out; whombat-agent console-test --platform host --manage packages.check --follow 2>&1; kill %1' 2>&1); t1=$(date +%s)
has "$out" "holding" && ok "the lock holder holds lock-frontend" || bad "lock holder"
has "$out" '"code": "busy"' && has "$out" "Another program is installing packages on" && ok "busy after $((t1-t0)) s" || { bad "busy"; echo "$out" | tail -12; }

echo "== 9. nothing left running in the VM"
out=$(X systemctl list-units --all 'whombat-pkg-*' --no-legend 2>&1); [ -z "$out" ] && ok "no package units left" || { bad "units left"; echo "$out"; }
X ls /var/lib/whombat-agent/packages/
echo "RESULT failures=$fails"
exit $fails
