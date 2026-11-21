# Whombat hosts service

Server monitoring and control for [Whombat](https://whombat.com). A small agent on every server (`whombat-agent`)
dials out to the hosts service (`whombat-hosts`) inside the Whombat box, and Whombat shows and changes everything:
fleet health, per-server history (CPU, memory, network, temperatures, disks with SSD wear and SMART, volumes with a
“full in N days” forecast), system health (updates, failed services, time sync, RAID, ZFS scrubs, UPS, GPUs, fans),
virtualization capacity and every workload (Docker, Incus, libvirt/QEMU and Proxmox VE), with VM screens and container
shells in the browser. Proxmox VE and Incus guests can also be changed, created, cloned, backed up, restored, migrated
and deleted. Remote control and changes are off until they are switched on both in Whombat and on the server itself.

```
browser ─HTTPS─▶ Whombat server ─unix socket + service token─▶ whombat-hosts ◀─WSS + mTLS (agent dials out)── whombat-agent (one per server)
                 (accounts, approvals, UI)                        SQLite: inventory, metrics, alerts, audit       collectors · console broker
```

- The contract with the Whombat server: [docs/WHOMBAT.md](docs/WHOMBAT.md) · every HTTP route:
  [docs/REST-API.md](docs/REST-API.md) · the agent protocol: [docs/AGENT-PROTOCOL.md](docs/AGENT-PROTOCOL.md) ·
  changing guests: [docs/MANAGE.md](docs/MANAGE.md)
- Reporting a security problem: [SECURITY.md](../SECURITY.md)

## What this folder is

This is the source of Whombat's hosts service and its server agent, where its maintainers work in the open. It was
first built as a standalone product, Rackoon, whose own web UI and sign-in still build and work without `--headless`;
the Go module is still called `rackoon`. You can read it, build it, run its tests, run the agent on your servers and
run a hosts service with its own UI from it (below). It is the folder `hosts/` of the Whombat repository; paths below
start at this folder.

The Whombat appliance, which runs this service headless, is the folder beside it (`../appliance`), and Whombat's
server and apps are `../apps` and `../packages`. The decisions behind this code are in
`docs/decisions/hosts.md` and `NOTES.md`, the design hand-off its UI was built from in `docs/handoff/`, the guide for
coding agents in `AGENTS.md`. The maintainers' own test environment (nested Proxmox and libvirt on their servers,
which some live tests name) isn't part of this repository. Older notes were written when this was a repository of
its own: where they say “this repository”, read this folder.

**Issues and pull requests are welcome**, under the contributor agreement (`../CONTRIBUTING.md`,
`../docs/legal/contributor-agreement.md`). Security problems go to `../SECURITY.md`, privately. The name “Whombat” and
its logos aren't covered by the licence: see `../TRADEMARKS.md`.

## Build

Tools come from [mise](https://mise.jdx.dev) (`mise.toml`: Go, Node, pnpm).

```sh
make headless         # dist/whombat-hosts without the UI (what the Whombat appliance runs)
make agents-unsigned  # dist/agent/whombat-agent-linux-{amd64,arm64}, self-update off
make hub              # web/dist, signed static agents and dist/whombat-hosts with the UI embedded
make test             # go vet + go test -race + web unit tests
make lint-go          # gofmt
make ci               # lint (gofmt, type check), tests and a full build
make deb              # Debian packages of the agent (needs nfpm)
```

Agent builds are signed with an Ed25519 key that stays on the build machine
(`~/.config/rackoon/update-signing.key` or `$RACKOON_SIGNING_KEY`, created on
first use by `cmd/rackoon-sign`); agents carry its public key and accept
updates from the hub only when they verify. Unsigned builds never update
themselves.

## Run it headless (inside Whombat)

```sh
whombat-hosts serve --headless \
  --data /persist/hosts --listen unix:/run/whombat-hosts/api.sock \
  --agent-listen :8443 --agent-url auto \
  --agent-dist /path/to/agent-builds --service-token-file /persist/hosts/service-token
```

The Whombat appliance runs exactly this (`../appliance/nix/modules/hosts.nix`). Flags, headers, routes, events, the console proxy
and the install flow: `docs/WHOMBAT.md`.

## Run it with its own UI (not headless)

```sh
sudo install -m 0755 dist/whombat-hosts /usr/local/bin/
sudo mkdir -p /var/lib/whombat-hosts/agent-dist && sudo cp dist/agent/* /var/lib/whombat-hosts/agent-dist/
whombat-hosts serve \
  --data /var/lib/whombat-hosts \
  --listen :8080 --agent-listen :8443 \
  --public-url https://hosts.example.ts.net \
  --agent-url wss://hosts.example.ts.net:8443 \
  --agent-dist /var/lib/whombat-hosts/agent-dist
```

Every flag has an environment variable (`whombat-hosts serve -h`;
`WHOMBAT_HOSTS_*`, Rackoon's `RACKOON_*` still work);
`packaging/hub/whombat-hosts.service` is a systemd unit for it.

- **HTTPS on a tailnet**: either put the UI behind `tailscale serve --bg 8080`
  (keep `--listen 127.0.0.1:8080`, set `--public-url https://<host>.<tailnet>.ts.net`),
  or use `tailscale cert <host>.<tailnet>.ts.net` and pass `--tls-cert/--tls-key`.
  Passkeys need HTTPS with a host name.
- **Firewall**: agents must reach the agent listener (default 8443/tcp); browsers the UI port.
- **First start**: the hub logs a one-time setup URL. Open it to create the admin account, then add a passkey under Settings.
- **More users**: Settings › Users. A new password account gets a temporary password to hand over; the user picks their own at the first sign-in.
- **Backups**: `whombat-hosts backup --data /var/lib/whombat-hosts --out hub.tar` writes a consistent snapshot of the database and the CA while the hub runs, as a plain tar (`--out -` too; gzipped only for a `.tar.gz` name), so the box's restic dedups it (admins can also download one: `GET /api/v1/hub/backup`); `whombat-hosts restore --from <file>` puts one back while the hub is stopped, and `POST /api/v1/hub/restore` stages one that the hub applies when it starts again (it stops on its own; `docs/REST-API.md` "Hub"). Schema upgrades keep a copy of the previous database next to it.
- **Behind a proxy**: `X-Forwarded-*` is trusted from `--trusted-proxies` (default loopback). Consoles need HTTPS (`--insecure-consoles` allows plain HTTP).
- **Assistant** (optional): install `packaging/hub/rackoon-assist.socket` and `rackoon-assist@.service` next to the hub's unit, `systemctl enable --now rackoon-assist.socket`, and set `RACKOON_ASSIST_SOCKET=/run/rackoon-assist.sock` for the hub. The AI tools then run under their own user and sandbox (state in `/var/lib/rackoon-assist`), away from the hub's database and CA. Without it the hub runs them itself, unsandboxed (development). The CLIs need outbound HTTPS to Anthropic / OpenAI and their download sites.

### Single sign-on (optional)

Any OpenID Connect provider (Authentik, Keycloak, Entra ID, …). Register
the redirect URL `<public URL>/api/v1/auth/oidc/callback`, put the client
secret in a file readable by the hub only (with the systemd unit:
`LoadCredential=oidc-secret:/etc/whombat-hosts/oidc-secret` and
`WHOMBAT_HOSTS_OIDC_CLIENT_SECRET_FILE=${CREDENTIALS_DIRECTORY}/oidc-secret`; the
hub expands variables in that path), and add:

```sh
  --oidc-issuer https://auth.example.com/application/o/rackoon/ \
  --oidc-client-id rackoon --oidc-client-secret-file /etc/whombat-hosts/oidc-secret \
  --oidc-name Authentik
```

The login page then offers "Sign in with Authentik". Add users for it under
Settings › Users (sign-in: Authentik; the name must match the provider's
`preferred_username`, see `--oidc-username-claim`), or let unknown users in
with `--oidc-auto-create`. `--oidc-role-claim groups --oidc-role-map
'rackoon-admins=admin,rackoon-ops=operator,*=viewer'` takes roles from the
provider. Every flag has a `WHOMBAT_HOSTS_OIDC_*` variable (`whombat-hosts serve -h`).

### Scripts, Prometheus and wall displays

Settings › Notifications sends alerts to ntfy, webhooks (also in the
Alertmanager format) and any Shoutrrr URL (Discord, Slack, Telegram, email,
Gotify, Pushover, Matrix, …), and can ping a Healthchecks-style URL so an
outside monitor notices when the hub stops. Settings › Checks adds HTTP,
TCP, ping and DNS checks (from the hub or from an agent's network) and
heartbeat checks that a cron job pings: `curl -fsS <hub>/ping/<token>`
(`/start`, `/fail`, or `/<exit code>`).

Account › API tokens creates a bearer token (`Authorization: Bearer rk_…`)
for the API (`docs/REST-API.md`). Prometheus scrapes `GET /metrics` with a
read-only token (`authorization: {credentials_file: …}` in the scrape
config). Account › Kiosk links makes a link that opens a read-only
overview on a wall display without signing in.

## Add a server

In Whombat: **Add a server** shows a one-line install command (single-use
token, valid 1 h) that fetches the installer from the box's agent port with
its key pinned:

```sh
curl -fsSL --insecure --pinnedpubkey 'sha256//…' https://<box LAN address>:8443/install.sh | sudo sh -s -- --token <token>
```

It installs the agent and its service and enrolls the server; approve it in
Whombat. (Not headless, the command fetches from the UI origin instead.)
To allow consoles / power actions on that server, set on the server

```toml
# /etc/whombat-agent/agent.toml
[remote_control]
console = true
power = true
```

run `sudo systemctl reload whombat-agent`, and switch them on for the
server in Whombat. On Proxmox VE the agent creates its own read-only API
user (`whombat@pve`, role PVEAuditor) on first start; install it on every
node you want full data from (nodes without an agent are shown from the
cluster API). With `manage = true` it also creates a second token with a
limited role (`whombat-manage@pve`, role `WhombatManage`, no root-only
settings) and removes it again when the switch goes off.

The installer detects the running init system. Systemd uses the hardened
unit `whombat-agent`; OpenRC uses `supervise-daemon`; SysV uses the agent's
`supervise` command with a locked PID file, crash restart, reload and
graceful shutdown. On other Linux init systems, run `whombat-agent run`
under your own service manager, or use `whombat-agent supervise
--config-dir /etc/whombat-agent`. Logs from `supervise` go to syslog
(stderr when syslog is unavailable).

On **Unraid**, the installer stores the binary and identity in
`/boot/config/plugins/whombat-agent/`, adds one startup command to
`/boot/config/go` and saves its original contents as
`go.before-whombat-agent`. The startup script copies the binary to
`/usr/local/bin` and starts the supervised agent through
`/etc/rc.d/rc.whombat-agent`. Configure remote control in
`/boot/config/plugins/whombat-agent/agent.toml`; manage it with
`/etc/rc.d/rc.whombat-agent start|stop|restart|reload|status`. The sample
buffer stays in RAM (`/var/lib/whombat-agent`) to avoid frequent flash
writes; it survives connection loss but not a server reboot. Re-running the
installer upgrades the binary while preserving the existing identity,
configuration and boot commands.

`--hub wss://<address>:8443` overrides the agent endpoint. If the server
cannot download from the box, copy the installer and agent binary over SSH
and use `--download-base file:///path/to/staged/binaries`; the installer
still verifies the published binary checksum. Passing `--token -` reads
the enrollment token from stdin. A Rackoon agent on the same server keeps
running: the two share no paths, users or ports.

## Develop

```sh
# A headless hub on a socket, and the simulated fleet through it:
go run ./cmd/whombat-hosts serve --headless --data ./tmp/hub --listen unix:$PWD/tmp/api.sock \
  --agent-listen 127.0.0.1:24432 --agent-url wss://127.0.0.1:24432 --service-token-file ./tmp/token
go run ./cmd/rackoon-sim --ui unix:$PWD/tmp/api.sock --service-token-file ./tmp/token \
  --allow-manage --enable-remote-control      # 8 simulated hosts through real enrollment
curl --unix-socket tmp/api.sock -H "Authorization: Bearer $(cat tmp/token)" \
  -H 'X-Whombat-Actor: pe_1|You' http://hosts/api/v1/fleet
# Agent updates in the simulator: give the hub a build (--agent-dist with a
# manifest.json; the simulator verifies nothing) and the agents its key. The
# round updates the older agents; onyx has no key and needs the last install
# (turn the hub's host_shell on for it, then POST /api/v1/agents/update
# {"servers":["onyx"]}). Short rounds: --agent-update-grace 5s
# --agent-update-after-connect 3s --agent-update-interval 1m on the hub.
go run ./cmd/rackoon-sim … --update-key <manifest key> --allow-host-shell \
  --agent-version 0.0.0-20261018094703.5394c53

# With the Rackoon UI instead:
make dev-fixtures                 # UI against docs/handoff/sample-data, no hub needed (Playwright suite: web/README.md)
go run ./cmd/whombat-hosts serve --data ./tmp/hub --listen 127.0.0.1:8080 \
  --agent-listen 127.0.0.1:8443 --public-url http://localhost:8080 --web-dir web/dist
go run ./cmd/rackoon-sim --ui http://127.0.0.1:8080 --admin-user admin --admin-pass '…'
make dev-web                      # Vite dev server proxying /api to the hub (RACKOON_HUB to override)
go run ./cmd/whombat-agent collect --once --json   # one report from this host (as root)
```

## Layout

| Path | What |
|---|---|
| `cmd/whombat-hosts`, `internal/hub/...` | hosts service (hub): store, CA, agent listener, API, alerts, console gateway, headless mode and the service token |
| `cmd/whombat-agent`, `internal/agent/...` | agent runtime, `collect/` collectors, `broker/` consoles and actions, `diagnose/` read-only checks |
| `internal/proto`, `internal/wire` | agent ↔ hub messages and framing |
| `internal/rules` | thresholds, status rules, derived values, alert rules and hints, forecast |
| `internal/checks` | HTTP / TCP / ping / DNS checks and their scheduler (hub and agents) |
| `cmd/rackoon-sign` | signing key and manifest for agent self-updates |
| `cmd/rackoon-sim` | simulated fleet for development |
| `web/` | the UI (`web/README.md`) |
| `packaging/` | systemd units, .deb config |
| `docs/` | `WHOMBAT.md` (the contract with the Whombat server), `REST-API.md` (every HTTP route), `CONTRACT.md` (UI contract), `AGENT-PROTOCOL.md`, `MANAGE.md`, `ASSIST.md`, `decisions/hosts.md`, `TESTENV.md`, `handoff/` (design + spec) |

`NOTES.md` lists decisions, deviations from the hand-off and what is not verified.

## Licence

Copyright 2026 Cybex BV. The hosts service and the agent are free software under the GNU Affero General Public
License, version 3 only (`LICENSE`, `AGPL-3.0-only`): you may use, study, change and share them, and if you let people
use a changed version over a network, you must offer them its source code too. The Go module is still named `rackoon`
(and the web UI `rackoon-web`), names kept from Rackoon; the licence covers them all the same. Third-party code keeps
its own licence (`THIRD_PARTY_NOTICES.md`). The licence gives no rights in the name “Whombat” or its logos: a fork needs
its own (`../TRADEMARKS.md`). Issues and pull requests are welcome, under the contributor agreement
(`../CONTRIBUTING.md`); security reports: `../SECURITY.md`.
