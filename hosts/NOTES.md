# Notes

Decisions, deviations from the design hand-off (`docs/handoff/`), and what is
and is not verified. Required by `docs/handoff/AGENTS.md` §8 and
`ACCEPTANCE.md` §11.

## Decisions (against `docs/handoff/AGENTS.md` §7)

| Decision | Taken |
|---|---|
| Product name | **Rackoon** (`web/src/lib/product.ts`) |
| Tech stack | **Go** for agent and hub (hand-off suggested Rust for the agent): official/mature Go clients for Incus, Docker and libvirt, one language end to end; the agent meets the budget (0.35 % of a core, 31 MB RSS with 57 guests). Hub: SQLite via `modernc.org/sqlite`. UI: React 19 + TypeScript + Vite, plain CSS on `tokens.css`, hand-rolled SVG charts. |
| Authentication | Local accounts (argon2id password + passkeys) managed under Settings › Users, optional OpenID Connect single sign-on; roles viewer/operator/admin enforced in the backend; API tokens and kiosk links (see "Accounts" below). `rackoon-hub user add` still works offline. |
| Agent ↔ hub | Outbound WebSocket over TLS 1.3 with per-agent client certificates from the hub's own CA (pinned by SHA-256 at enrollment), yamux streams, CBOR messages (`docs/AGENT-PROTOCOL.md`). |
| Console and power | Off on new servers. Needs the hub toggle per server **and** `[remote_control]` in the host's `agent.toml`. Console and power are separate. |
| Multi-tenancy | Single tenant. |
| Retention | Raw 10 s for 24 h, 1 min for 7 d, 15 min for 90 d; average, maximum and count kept. |
| Heartbeat loss | 60 s → offline + `agent.heartbeat_missing`. |
| Rated TBW | Embedded table of ~230 models (exact model match); unknown → wear percent only. No manual override yet. |
| Languages | English and Dutch (2026-10-14): English source texts are the keys of `web/src/locales/nl.ts` (`t()`, `tn()` for counts, `tx()` for sentences with links); the browser's language or the account menu picks one (per browser). Texts the hub writes (alerts, hints, errors) stay English; numbers keep the English separators. |

## Deviations from the hand-off

- **Metrics storage**: one row per (series, timestamp) per tier in `WITHOUT ROWID` SQLite tables, not compressed chunks. Fast enough at this scale (50 simulated hosts: fleet series < 90 ms, hub ≈ 0.4 % of a core). 24 h and 7 d are served from the 1 min tier, 30 d from the 15 min tier — identical results because rollups keep sum/count/max.
- **Agent privileges**: runs as root instead of a dedicated user — Docker/Incus/libvirt socket access and Proxmox `qm`/`pct` are root-equivalent anyway. Systemd applies the packaged sandbox; OpenRC, SysV and Unraid use their native startup mechanisms without that systemd sandbox. Collectors **auto-detect** their platform instead of being opt-in per host; `[collectors]` in `agent.toml` can force them off.
- **Installation without systemd (2026-10-12)**: OpenRC uses its native `supervise-daemon`; SysV and Unraid use `rackoon-agent supervise` (locked PID file, crash restart, reload forwarding and process-group shutdown). Unraid persists the executable and agent identity on boot flash and restores the executable to RAM from a single appended `/boot/config/go` hook. Its sample buffer stays in RAM to avoid writing flash every collection cycle and is lost on reboot. Existing identities/configuration are preserved on reinstall. This follows [Unraid's boot-device guidance](https://docs.unraid.net/unraid-os/system-administration/secure-your-server/secure-your-boot-drive/) and the [OpenRC service manual](https://github.com/OpenRC/openrc/blob/master/man/openrc-run.8).
- **Caching**: GETs send `Cache-Control: private, no-cache` + ETag instead of `max-age=5`, so guest state is never stale after an action.
- **CPU usage excludes I/O wait** (100 − idle − iowait); I/O wait is shown separately in the facts row.
- **Fleet card temperature** shows the sensor closest to its own limit (not the absolute hottest), so a 54 °C HDD with a 55 °C limit is not hidden behind a 64 °C CPU.
- **Container `restart` needs `confirm: true`**, like the other disruptive actions.
- **Guest CPU bars** use the absolute percent (the mockup scaled them to the busiest row).
- **UI v2 (2026-10-13, at the owner's request: a full UI/UX redesign).** The hand-off's page compositions were built for a fictional 8-host fleet; the live fleet (5 hosts, one group, no open alerts, long and mostly stopped guest lists) left the overview's KPI tiles, heatmap and "Needs attention" card empty of information while pages ran to 3,400 to 4,500 px (8,600 px on a phone). The redesign keeps the hand-off's tokens, color semantics (status vs. series colors), fonts, chart rules, thresholds, formats and every API, and changes the information architecture, density and navigation:
  - **Tokens**: same names, tighter values (13 px body, 8/16/24 spacing, 10 px cards, 48 px top bar); `--good` brightened to `#1fb31f`; new `--info`. `web/src/styles/tokens.css` documents them.
  - **Shell**: the top bar carries *Overview*, **one pill per host** with its status dot (past 8 hosts, or below 1100 px, a *Hosts* menu), *Guests*, *Alerts* (badge), a search button and *Settings* / account. **⌘K / Ctrl+K opens a command palette** (pages, hosts, guests on any host via `GET /guests?q=`, actions; Enter on a running guest with a console opens it, Shift+Enter shows it in its host's list). Below 760 px: brand, search and account in the bar; a **bottom tab bar** (Overview, Hosts sheet, Guests, Alerts, Menu sheet with Settings and Sign out). The server menu of 2026-10-11 is gone.
  - **Overview** = one screen: a strip of fleet totals (chips, no tiles), a **hosts table** (status rail, 24 h CPU sparkline, memory, hottest sensor against its own limit, storage, running guests per platform; sorted by status then name; a row opens the host), a **Watch panel** (open alerts, then **hints**: conditions near a limit that are not alerts yet, computed by the hub, CONTRACT 1), a Workloads strip (one card per platform present, counts from the fleet-wide guest list, busiest guests link to their console) and the Capacity table (was Hypervisors). The **CPU heatmap, KPI tiles, server cards and the Enroll card are gone**; *Add server* is a header button for admins; the group control shows only with two or more groups.
  - **Host page** (`/servers/:id`) has **tabs** in `?tab=`: *Summary* (three compact charts with facts; the compact CPU chart scales its y axis to a round ceiling above the peak instead of 0 to 100, the Sensors tab keeps 20 to 100 °C; busiest guests (name, CPU, memory, Console / Shell in aligned columns; kind and image only in the name's tooltip); Watch for this host; Storage, Virtualization and Proxmox mini cards), *Guests* (platform control, filter in `?q=`, List / Screens, the table; **the console opens as a side panel beside the table**, full width below 1100 px; the side list of guests is gone, the table is the list), *Storage* (disk cards; Proxmox storages, disks and Backups), *Sensors* (the full temperature chart and table), *Virtualization* (capabilities, allocation; Proxmox Cluster), *Agent* (admins: the former `/settings/agents/:id` content). The header is one line of facts (meta strip dropped). Old addresses keep working: `?platform=` / `?view=` imply the Guests tab, `#storage`-style links map to tabs (`#system` scrolls to the Summary's System card and rings it briefly), `/settings/agents/:id` stays for hosts whose agent never reported.
  - **Guests** (`/guests`, new): every VM and container on every host with search, state, platform and host filters, sort, paging (`GET /guests`, extended in CONTRACT 1 with counts and platforms), consoles in the same side panel. No Screens wall here (it stays per host).
  - **Settings** keeps Account, Agents (list, approvals; a row opens `/settings/agents/:id`) and Audit log with the denser styles.
  - **Hub additions** (additive, CONTRACT 1): `hints[]` on `GET /fleet` and `GET /servers/{id}` (sensor from 70 % of its limit, swap and memory pressure, disk space 80 to 89 %, SSD wear 60 to 74 %, failing collectors, unhealthy containers, agent version differing from the hub; suppressed while an alert covers the entity); `GET /guests` lists, filters, sorts and pages every guest with `server` and `server_online`.
  - Decisions taken without the owner (asked to decide): table rows instead of cards (no card option), heatmap dropped, "Hosts" as the word in the UI (routes keep `/servers`), hints from 70 % of a limit with the informational kinds above, no cookie switch between old and new UI (the dev hub is the place to try it; the `pre-deploy` snapshot is the fallback).
- **Accounts (2026-10-13)**: Settings › Users (admins) adds, re-roles, resets, signs out and deletes accounts; every change needs a recent sign-in, is refused for API tokens and kiosk sessions, and is audited. The last admin can be neither demoted nor deleted (checked inside the store transaction), and admins change their own account on the Account page only. Decisions taken without the owner:
  - **Password reset** = a generated temporary password shown once to the admin (`xxxxxx-xxxxxx-xxxxxx-xxxxxx`, 96 bits); the user is signed out everywhere and must choose a new password at the next sign-in, before anything else (the hub answers 403 `password_change_required` outside `/auth/*`; right after signing in the temporary password is not asked again). New password accounts start the same way. Passkeys and API tokens survive a reset; deleting the user removes them. Temporary passwords do not expire.
  - **Single sign-on** (OIDC, off unless `--oidc-issuer`): authorization code flow with PKCE, state bound by a cookie, nonce. Accounts are matched by issuer + subject; an account an admin added for single sign-on is linked by name at its first sign-in; password accounts are never linked (no takeover by a same-named provider user). `--oidc-auto-create` and a claim → role map (`--oidc-role-claim groups --oidc-role-map 'admins=admin,*=viewer'`) are optional; a mapped role is re-applied at every sign-in and cannot be changed in Rackoon. **Re-authentication** for these accounts is a passkey, or a fresh round trip with `prompt=login`, `max_age=0` and `auth_time` at most 5 minutes old; the browser returns to the page and the change is made again (the pending request is not replayed).
  - **Kiosk links** are tokens of kind `kiosk` (viewer, refused as bearer tokens) opened as `/kiosk#<token>`; kiosk sessions are read-only on the hub too (403 `kiosk_read_only` for any change, e.g. acknowledging an alert) and the UI shows only the overview without navigation. They last like other sessions (90 days at most), then the link must be opened again.
  - **Prometheus**: `GET /metrics` (root, the Prometheus default path) with an API token only; hand-written text format, values of offline servers left out. `docs/REST-API.md` documents every route.
- **Docker `last_exit`** is a timestamp; the UI formats "Exited 6 h ago".
- **Screens wall**: container tiles show a terminal placeholder (no live text); VM thumbnails are real screenshots.
- **Status line** says "not encrypted (plain HTTP)" instead of "encrypted" when the UI is served over plain HTTP.
- **Proxmox**: each node's agent creates its own read-only token `rackoon@pve!agent-<node>` (PVEAuditor); tokens are cluster-wide, so a shared name would let nodes revoke each other's. Per-guest "last backup" comes from vzdump task logs (backup volumes are hidden from PVEAuditor). VMs without a guest agent show the OS type ("Linux") as image.
- **Platform differences in actions**: Reboot power-cycles QEMU on Incus and Proxmox and is a guest reboot on libvirt. Container Stop is graceful for 30 s, then forced. Incus has no send-key API, so Ctrl+Alt+Del for Incus VMs works through the SPICE console only.
- **Mockup known issues** (hand-off README) are fixed: status text never wraps, plurals, per-sensor temperature limits everywhere, viewer time zone.

## Roadmap of 2026-10-13 ("implement the improvements and new features; less is more")

The owner asked for every improvement and new feature of the 2026-10-13
review (`tmp/roadmap/` holds the working plan). UI rule taken from "less is
more": no new top-level navigation; new configuration lives under Settings,
new host data in the existing tabs (a System card, Network chart, volumes,
arrays, fans, Proxmox tasks) and shows only when the agent reports it.

- **Host shell is off by default, everywhere.** On 2026-10-11 the owner
  answered "consoles for guests only (no host root shell)". The roadmap
  asked for a host terminal behind the remote-control policy, so it exists
  but needs, on top of the guest console rules: `[remote_control]
  host_shell = true` in the host's `agent.toml` (console does not imply
  it), the separate hub switch, an admin, TLS and a re-authentication less
  than 10 minutes old. Host reboot / shutdown likewise (`host_power`).
  The owner turned all four on for PVE-02 on 2026-10-14 (both sides); the
  other hosts have them off.
- **Security**: consoles only over HTTPS (or localhost) unless
  `--insecure-consoles`; sessions slide for 30 days but end after 90
  (`--session-max-lifetime`); sensitive changes (remote-control switches,
  tokens, host access, channels) need a password or passkey check within
  10 minutes ("sudo mode", `ReauthDialog`); login throttling per address
  (10 / 5 min) and per account (20 / 15 min); anonymous passkey starts 30 /
  5 min per address; 16 event streams per user; `X-Forwarded-*` only from
  `--trusted-proxies` (default loopback); PROXY protocol v1/v2 from loopback
  peers on the agent listener (`--agent-proxy-protocol`, default on).
  `rk_` API tokens (Bearer, per user, role-capped) and kiosk links
  (viewer-capped sessions).
- **Alert lifecycle**: every rule has a clear-after hysteresis (10 min, 1
  min for temperatures); acknowledge with a note, or snooze until a time;
  maintenance windows per server, group or everything (one-off or weekly)
  mute notifications and the badge, not the alert itself; a host whose
  parent (detected by guest name or address, or set by hand) is offline has
  its alerts marked "suppressed". The badge, title count, favicon dot and
  notifications count only alerts that need attention. Hub-level alerts
  (`server: ""`): repeated denied requests, checks.
- **Notifications**: channels are ntfy (native: priority, click and an
  "Acknowledge" action with a signed link), webhooks (JSON, or the
  Alertmanager format) and any Shoutrrr URL (Discord, Slack, Telegram,
  email, Gotify, Pushover, Matrix, ...; `github.com/nicholas-fedor/shoutrrr`,
  the maintained fork). A 30 s group wait batches bursts and drops blips,
  reminders per channel, resolved notices, two retries (10 s, 1 min), a
  delivery log, and an outbound hub heartbeat URL (Healthchecks style).
- **Checks**: HTTP / TCP (TLS) / ping / DNS from the hub or from any agent
  (sent as `checks` on the control stream); down after 2 failures in a row,
  certificate warning 14 days before expiry (per check); heartbeat checks
  get a ping URL (`/ping/<token>[/start|/fail|/<exit code>]`, the token is
  the credential) and are down when a period plus grace passes without a
  ping. Results: `up` and `latency_ms` series per check.
- **Host health rules**: SMART failing (critical), pending / uncorrectable
  sectors / media errors / failed self-test (warning), pool degraded
  (critical) or with errors (warning), md array degraded, read-only
  remount (critical), inodes 90%, PVE quorum lost, failed vzdump job and
  replication, Ceph health, clock unsynchronized 30 min, UPS on battery (30
  s; critical when low), links with an address but no carrier and bond
  members down (2 min), fans below their minimum; from history: OOM kills
  in the last hour (counted from the second report, so old kills never
  alert) and containers restarted 3 times in 15 minutes; `disk.full_soon`
  when a linear fit of the last 7 days of a volume's used % reaches 100%
  within 7 days (hint from 30 days). Pending updates are hints, also
  security ones (routine on most hosts); the overview folds routine hints
  into one row per kind.
- **Charts**: 90-day range (15 min tier), drag-to-zoom windows (`from`/`to`
  in the URL), markers for alerts, boots, actions and agent updates; guest
  history once a minute for up to 300 running guests per host (own series
  owner, deleted with the host); the overview compares hosts by CPU,
  memory, network or temperature.
- **Agent updates** are signed (Ed25519; the key stays on the build
  machine, `~/.config/rackoon/update-signing.key`, fingerprint in the
  binary) and staged by the hub one agent at a time; an agent built without
  a key, or with `[update] allow = false`, is never updated remotely. The
  LAN agents installed on 2026-10-12 (PVE-01, PVE-02, BlackBox) predate
  update keys and need one manual upgrade; The Falcon was upgraded by hand
  on 2026-10-13.
- **Light theme** (System / Light / Dark from the account menu, per
  browser) and an installable web app (manifest, icons).

## Managing guests (2026-10-17, "full Proxmox support")

The owner asked to edit LXCs and VMs and "full support for Proxmox if
possible", approved the proposal and asked to implement it fully and apply
it on production. Design and contract: `docs/MANAGE.md`; routes:
`docs/REST-API.md` "Manage".

- **Manage** is a fifth remote-control capability (`[remote_control]
  manage` + the hub switch `rc_manage`), off by default; it implies neither
  console nor power. Operators edit configuration, disks, firewall,
  backups and replication; create, clone, convert to template, delete,
  restore, downloads, content deletion and HA need an admin and a sign-in
  less than 10 minutes old. Deleting a guest needs its name typed;
  deleting an unused disk, converting to a template and restoring over a
  guest need `confirm: true`.
- **Proxmox VE writes** go through a second API token the agent creates
  when Manage is on (`rackoon-manage@pve!agent-<node>`, role
  `RackoonManage` = PVEVMAdmin's privileges without VM.Console,
  VM.Monitor and the guest-agent file / exec privileges, plus datastore
  space and templates, SDN use, audit; `Sys.AccessNetwork` on the node for
  downloads where PVE has it) and removes when it goes off. PVE itself then
  refuses root-only settings (raw args, hookscripts, unmapped passthrough,
  host paths, bind mounts, raw LXC keys); the agent's allowlist refuses
  them first and shows them read-only ("Restricted"). Two exceptions run as
  root after validation, because PVE's API wants root-equivalent rights for
  them: HA (`ha-manager`, needs Sys.Console) and deleting ISO images,
  templates and import files (`pvesm free`, needs Datastore.Allocate,
  which would also allow changing storage definitions).
- **Concurrency**: every change carries the configuration digest (Incus:
  the ETag), so a change made meanwhile in Proxmox's own UI is refused, not
  overwritten. One change per guest at a time, shared with power actions.
- **Guest configs are read from `/pending`** (collector and editor): the
  report shows the values in effect, `pending_changes` counts what waits
  for a restart (the old `/config` read returned pending values already
  applied).
- **Tasks**: long operations answer 202 with the PVE UPID (or an Incus
  operation id); the hub follows each task (every 2 s, 24 h at most, not
  across hub restarts) and audits / announces its end (`task.finished`).
  The agent keeps Incus operations' results for an hour (Incus forgets
  them 5 s after they end).
- **Incus**: configuration, root disk resize, create from an image
  (`images:` = images.linuxcontainers.org; other remotes refused), copy and
  delete; no backups. Raw keys, privileged mode, idmaps and host devices
  stay read-only.
- **UI**: a guest page per guest (`/servers/:id/guests/:guestId`) with
  tabs; edits go through a review step (old → new) and show what waits for
  a restart. Create / clone / templates on the host's Guests tab, storage
  contents on the Storage tab, bulk power actions and a tag filter on the
  guest lists. New hints: guests in no backup job, old backups, snapshots
  older than 30 days, pending changes, guest agent not running, thin
  storage overcommitted.
- Not done: migration (both PVE nodes are standalone), uploads from the
  browser (download from a URL instead), PVE users / SDN / node network /
  Ceph, libvirt editing, Incus backups.

## Assistant (2026-10-17, "investigate and fix with Codex / Claude")

The owner asked for optional Claude Code / Codex support that installs and
updates itself and investigates problems interactively (their example: an
Unraid array that failed), then answered: subscriptions; full access,
configurable, so nothing needs approving; the diagnostics on by default
when the AI is on; automatic investigation as a setting. `docs/ASSIST.md`
is the design; decisions taken without the owner:

- **Where the AI runs**: next to the hub, in its own systemd unit
  (`rackoon-assist.socket` → one `rackoon-assist@.service` per hub
  connection; dynamic user, `/var/lib/rackoon-assist`, no access to the
  hub's database, CA or `/etc/rackoon`, no `MemoryDenyWriteExecute`
  because Claude Code's runtime compiles code). Not on the hosts: one
  install and sign-in, nothing new on Unraid or the PVE nodes. The socket
  is 0666 (the hub's dynamic user has no fixed name); the runner holds no
  hub secrets and a client that connects only gets tool calls back to
  itself.
- **The CLIs get no shell of their own.** Claude Code: `--tools
  WebSearch,WebFetch`, Rackoon's MCP server only; Codex: shell, apps,
  plugins, browser and image tools off, read-only sandbox. Everything they
  do on hosts goes through Rackoon's tools (hub data, `diagnose`,
  `run_command`, `guest_action`, `finish`), checked against the access
  level and each host's own switches. `run_command` needs the host shell
  switch on both sides (as for people); the assistant never manages guests'
  configuration. The system prompt asks the AI to confirm data-losing or
  long-outage steps with the admin even with full access, and to treat
  host output as data, not instructions.
- **Access levels** read / ask / full, default **full** (the owner's
  choice). Approvals (ask) wait 30 minutes.
- **Diagnostics switch**: a sixth remote-control switch, `diagnose`, **on
  by default** in the hub (schema 11, also for existing servers) and in the
  agent (absent in agent.toml = on), only used by the assistant.
- **Sign-in**: Claude Code takes the token of `claude setup-token` (an
  `sk-ant-api` key also works), checked by a one-word request; Codex uses
  its device login (code and link shown in Settings). A Codex
  `config.toml` with a custom model provider counts as signed in.
- **Updates**: Claude Code's `stable` channel (`latest` optional), its
  GPG-signed manifest checked against the pinned Anthropic key, then the
  binary's SHA-256; Codex from the GitHub release's package with its
  published SHA-256 (`codex` and `codex-code-mode-host`, which Codex needs
  to run tool calls). Checked every 6 hours, installed when auto-update is
  on (default), two versions kept. The CLIs' own updaters are off.
- **Sessions**: the CLI ends after every turn and resumes on the next
  message; at most 3 investigations run at once; automatic ones (setting:
  off / critical / all) one at a time, 6 per hour, once per alert, after
  the alert needed attention for a minute. Investigations are kept 180
  days. Admins only, every command and action audited.
- **Dev hub**: the `rackoon` container's memory limit went from 1 GiB to
  3 GiB (Claude Code alone takes a few hundred MB); Claude Code 2.1.292 and
  Codex 0.163.0 are installed in its runner; nothing is signed in yet.

## One Whombat: the headless hosts service (2026-10-17)

John folded Rackoon into Whombat ("I don't want to use both Whombat and
Rackoon"): the hub becomes Whombat's hosts service, headless inside the
Whombat box, and Whombat owns accounts, permissions and every screen
(ONE-11…ONE-15). Contract: `docs/WHOMBAT.md`; decisions HS-01…HS-22:
`docs/decisions/hosts.md`. In short: `serve --headless` (data routes
only, no UI, users, sign-in, tokens, channels or assistant), `--listen
unix:/path` with `--socket-mode`, `--service-token-file` (a bearer token
with `X-Whombat-Actor` / `-Role` / `-Client-IP`), consoles for the service
token, install.sh / downloads / pings on the agent listener with a pinned
install command, `--agent-url auto`, REST routes for diagnose and exec,
`guest.migrate`, and the names `whombat-hosts` / `whombat-agent` (the wire
names stay compatible; a Rackoon agent can run next to a Whombat one). The
Rackoon dev hub is frozen on the last Rackoon build (AGENTS.md).

## Verified

- **Moving to Wi-Fi (2026-11-03, stream H, HS-220…HS-227)**: Go tests for the reconnecting hold with injected times, a mass drop holding three servers' heartbeat alerts until the hold's end, an address that went away, `POST /hub/agents/move` and `via`, the agent's move and its failures against the fake hub, and a real agent runtime against the real hub served on 127.0.0.1 and 127.0.0.2 (the box's 10.100.1.81 and 10.100.1.97 through `Runtime.DialContext`): it moved, its `agent.toml` hub line changed, the hold ended. Not run on a real box or with a real network change.

- **Agent updates (2026-10-20, stream H, HS-140…HS-161)**: Go tests for the version order, the agent's `older_version` / `same_version` refusals (also through the update stream), the reason codes, the round with fake agents (an update by `auto`, busy for packages, a console and a libvirt task, a refused update marked failed and not tried again, a build that doesn't come back halting the round before the next server, Update now clearing both, one rollout at a time, the setting, the schedule: grace, an older agent connecting, the interval), the last install (refused without the hub's host shell, `installing`, the agent back with the key, audit, a failed one with its log's line, never by the round), the command line per install kind (no `sudo`, `--token`, `--control`, `--force`; `sh -n`), the non-systemd command run through the agent's own `Exec` (identical to 5394c53's) outliving the process-group kill, and the simulator. **Real test** (`scripts/agent-updates-realtest.sh`, 20 checks passing on `069a70d`, `agent-resource`, a disposable Debian 12 VM `images:debian/12` with the headless hub inside it and a throwaway key): an agent one version older with the key was updated by the round 10 s after it connected (`by: auto`, `.prev` kept); an agent built at 5394c53 without a key reported `no_key`, `can_install: true` and came back on the build with the key 3 s after Update now (the installer said `kept rt-b`, the install ran in `whombat-agent-reinstall-<n>.service`, its exec through the old agent's `systemd-run --pipe --wait`); a signed build speaking protocol 99 was installed, never connected, rolled itself back after 5 minutes, and the hub marked it failed (“it is running … again”), halted the round (`halted_version`, `agent.update_halted`) and did not try again at the next round. The first run found systemd's “Ignoring unknown escape sequences” for a script passed with `sh -c` (HS-145's script file). The leases were released and `agent-resource check` showed nothing left. Not run live: OpenRC, SysV and Unraid last installs (the setsid path is covered by the Exec test), Try again after a halt (unit-tested), an arm64 agent.

- **Operating-system updates (2026-10-19, stream H, HS-119…HS-136)**: Go tests for every manager's command lines, the refresh outcome (Proxmox enterprise 401 in apt 2 and 3 words, other failures), lock probes against a helper process holding real fcntl and flock locks, the runner with fakes (counts, kept back, busy, timeout, a stopped check, an install asked to stop), the agent's task registry (systemd and setsid paths, restarts, a lost runner, expiry, refusals), the report glue, the inspect gate on agent and hub, the hub routes, task follower and audit, and the simulator. **Real test** (`agent-resource run`, a disposable Debian 12 VM `images:debian/12`, the real agent binary driving its broker with `console-test --manage`; the VM network has no internet, so a local `file:` repository of real bookworm packages: libexpat1, tzdata, libssh2-1, libpng16-16 downgraded to bookworm's release-pocket versions with `dpkg -i`, bookworm-security's as the updates, libpng16-16 held): a check refreshed the lists and found 3 updates, 3 for security (the held one not counted); a check from a console-test inside the agent unit's sandbox (`ProtectSystem=strict` and the rest) worked through its transient unit; an install ran in `whombat-pkg-<hex>.service` (own cgroup, `RuntimeMaxUSec=2h 5min`), refused `task.stop`, showed in the report's package task, its log paged from line 0 and from line 4, survived a follower killed with SIGKILL mid-task, and a new process found the result: 3 installed, libpng16-16 kept back, `package_last` install ok 3, 0 waiting, the units collected; the held package by name failed with apt's “Held packages were changed” line, unheld it installed; a local `enterprise.proxmox.com` answering 401 gave SWU-06's warning and the install carried on, a second repository answering 404 stopped it with apt's line; a check stopped mid-refresh; a runner killed with SIGKILL (as if the server went down) was reported “The server may have restarted while it ran.” and the next install worked; with another process holding `/var/lib/dpkg/lock-frontend` a check gave up after 122 s with code `busy`. `scripts/package-updates-realtest.sh` runs it all (24 checks, all passing on `d98a717`); the leases were released and `agent-resource check` showed nothing left.

- **Full Incus and the self guest (2026-10-17, stream HI, HS-33…HS-52)**: Go tests with the fake Incus server for every Incus operation (create in a project with pool / network / cloud-init, clone into a project, devices and profiles in config.set, rename, move, publish, the log, backups with restore as a new instance, tasks, leases, profiles, volumes, images), the collector's host view against a fake API, MAC parsing for Incus, Proxmox VE and libvirt, hub tests for the self guest (marking, `hosts_this_whombat`, refused and allowed actions and manage changes, audit), the Incus routes, the 501s elsewhere and `task.finished.new_id`, and the simulator's basalt. `TestIncusReal` ran on The Titan inside the throwaway project `whombat-test` (created and deleted by the test; nothing else touched): create from `images:alpine/3.22`, configuration with digest and refusals, start, log, snapshot, backup, restore as new, rename, copy, publish, image download, refresh and delete, profiles, a volume, tasks, deletions. A read-only lease listing of `cishared0` confirmed the per-project merge. Not verified: the hub reading its own MACs inside the DEV box (unit-tested with a fake `/sys/class/net`), Incus clusters.

- **Headless hosts service (2026-10-17)**: Go tests for the headless route set, the service token (creation, rotation, a deleted file), actor and role headers, the audit actor, enrollment with the pinned install command, install.sh and downloads on the agent listener (the pin equals the key the listener presents), the whole enrollment flow and heartbeat pings with the service token, consoles over a real WebSocket with the service token (another actor refused, per-person limits, rotation ends a live console), diagnose / exec / migrate with a fake agent, a Rackoon agent's subprotocol, a real Unix socket (stale socket replaced, mode 0660, SSE over it), and `guest.migrate` against the fake Proxmox API. By hand: a local headless hub on a socket with `rackoon-sim` (8 hosts enrolled and approved through the socket), `curl --unix-socket` for fleet, diagnose, exec, a migrate task and its `task.finished` event, a console through the socket with a WebSocket client as Whombat would proxy it, and real `curl --insecure --pinnedpubkey` fetching install.sh and the agent (a wrong pin refused). Not verified: an install on a real host from a headless hub, migration on a real cluster (PVE-01 and PVE-02 are standalone), HA-managed guests' migration.

- **Assistant (2026-10-17)**: hub tests with a fake runner (investigation with an approval, access levels, switches, automatic investigation, resume), the runner's live test driving both real CLIs (Rackoon's tools over MCP, a second turn, a resumed session), and a local hub with a real agent and Codex end to end (diagnose on the host, an approved command, a follow-up message, the summary). On the dev hub: the units through `deploy-dev`, the sandboxed runner over its socket (installs of both CLIs with their verification and `--version`, a Codex device-code start), the hub reaching it from its own sandbox (a temporary admin, deleted afterwards). All five agents run the new build (LAN agents upgraded over SSH); the Unraid check ran read-only on BlackBox.
- **Managing guests (2026-10-17)**: `make test` (Go with `-race`, 257 web unit tests), the fixture Playwright suite (252 passed; the Guests page baselines were updated for the selection column and tags) and a local hub with `rackoon-sim --allow-manage` driven through the API and a browser. Live on PVE-02 (PVE 9.2.11) through the dev hub, with a temporary admin account (deleted afterwards) and throwaway guests `rackoon-test-ct` / `rackoon-test-vm` (deleted with their volumes and backups): the manage token and its roles, choices, reading a production guest's configuration (read only), create from a CT template and an empty VM, edits on running guests (live and pending values, revert, hot-plugged NIC and mount point, detach, destroying an unused disk), grow-only resize, stale digest / foreign bridge / bind mount / privileged / root-only key refusals, firewall options and rules, back up to `local`, protect / notes, restore as a new guest, full clone, convert to template and linked clone, download from a URL (`Sys.AccessNetwork`) and delete through `pvesm free` outside the sandbox, task logs and stopping a task, HA and replication refused on a standalone node, re-authentication for deletes, the audit trail and the new hints. Two of the test backups sent PVE's usual notification mail to root. Incus editing, HA and replication on a cluster, and restores over an existing guest are tested against fakes only.

- **Roadmap of 2026-10-13**: `make test` (Go with `-race`, 218 web unit tests), the fixture Playwright suite (138 tests incl. axe scans) and `make visual` (14 baselines, dark and light) pass. Every change was deployed to the dev hub. On thetitan the new collectors were checked against the host: apt updates (17, 6 security), reboot required, 25 failed units, timesyncd, 697 OOM kills since boot (none alert: only new kills count), NIC rates and drops, md127 raid1, ZFS scrubs and fragmentation, NVMe spare and unsafe shutdowns, HDD self-tests, Docker image updates (HEAD requests only; Docker Hub's rate limit untouched), Incus warnings; agent cost about 0.5% of a core and 29–33 MB. No new alert fired on the real fleet. LAN agents show their real addresses through the PROXY header. The Falcon's agent was upgraded by hand to a signed build.

- **LAN and non-systemd agents (2026-10-12)**: `make test` passes, including generated-installer execution for systemd, OpenRC, SysV, Unraid and unsupported init systems; Unraid tests cover preserved boot commands, reinstall without reenrollment and restoration after loss of RAM files. Supervisor tests cover exclusive startup, crash restart, reload forwarding and forced shutdown. Live agents on The Titan, The Falcon (`10.100.0.6`, this development machine), PVE-01, PVE-02 and BlackBox (Unraid) report through the container's LAN proxy at `10.100.0.7:8443`, with Proxmox and Unraid Docker/libvirt collectors working. The Falcon's LAN connection works independently of its offline Tailscale peer. OpenRC and SysV were tested with mocked init commands, not live hosts. The actual Unraid host was not rebooted.
- **Unit/integration tests**: `make test` — Go (agent runtime with an in-process fake hub, broker incl. fake RFB/SPICE servers, collectors with sanitized captures, hub incl. end-to-end console through a real WebSocket, store, rules with every ACCEPTANCE §7 vector) and 167 web unit tests.
- **UI against fixtures** (UI v2): Playwright tests (full-page screenshots of every page and tab at 1440 and 390 px into `web/.screenshots/` for review, no horizontal overflow; interactions incl. host pills, command palette, host tabs, guests tab with the console side panel, the Guests page, phone bottom bar and sheets, chart keyboard navigation; consoles on a mock WebSocket; admin flows; axe-core WCAG 2.2 AA scans): `web/scripts/playwright.config.ts`. The hand-off screenshots no longer match by design.
- **Live end to end** (`web/scripts/live.config.ts`, 20 tests) against a hub on thetitan with three real agents (thetitan: Incus + Docker + ZFS; nested Proxmox VE 9.2 two-node cluster; nested libvirt 11.3), in the maintainers' test environment (removed after the run):
  - enrollment through `install.sh` + approval, remote control toggles on both sides;
  - overview, server detail, Proxmox page (cluster with a non-enrolled node, storages, backups) with real data;
  - consoles through the browser: Incus container shell and tty, Incus VM SPICE and serial, libvirt VNC (password handled by the agent), libvirt SPICE and serial, Proxmox noVNC, SPICE (TLS + ticket injected by the agent) and serial, LXC shell and tty;
  - Screens wall thumbnails, a confirmed power action with audit (`action.requested` / `action.finished`).
- **Agent**: every power action per platform, screenshots, policy denial, 20-console limit, backfill after an ~80 s hub outage without gaps, hub restart (agents reconnect), certificate renewal, no listening sockets, no secrets in logs; overhead 0.35 % of one core / 31 MB RSS on a 64-thread host with 57 guests.
- **Collectors** cross-checked against `free`, `uptime`, `sensors`, `zpool list`, `smartctl`, `incus list`, `docker stats`, `virsh`, `pvecm`, `pvesm`.

## Not done or not verified

- **Assistant**: no real subscription sign-in yet (no `claude setup-token` token or ChatGPT account here: the owner signs in on the dev hub), so no investigation has run on the dev hub; commands through `systemd-run` as root on a real host (`run_command`) are tested by their argv only; the UI against the real hub.

- **Passkeys** are implemented but never exercised with a real authenticator. They need `--public-url` to be HTTPS with a host name (e.g. `tailscale serve`).
- **i18n**: hub-written texts (alert titles and details, hints, API errors, status notes) are English in both languages, and numbers are not localised (1,234.5). Times follow the viewer's time zone.
- **Hardware not present on the test hosts** (unit-tested only): board/VRM, DIMM and drivetemp sensors, IPMI (not implemented), SATA SSD wear attributes, HDD standby handling, Docker `unhealthy`, OVMF/TPM libvirt domains.
- **Proxmox features absent in the test cluster**: HA resources, ZFS storages, PBS; the dedup ratio is always empty (PVE does not expose it).
- **Consoles**: libvirt VNC/serial on Unix sockets and TLS-only SPICE (reported as unavailable) only tested from sample XML; Incus non-default projects; non-US keyboard layouts for Paste over VNC/SPICE; 1080p over a WAN. The Incus SPICE screenshot fallback decodes raw/LZ images only (text consoles); photo-like desktops return `capture_failed`, and thumbnails are skipped while someone is connected (a new SPICE client would disconnect them).
- **Not exercised live** (unit and integration tests only): notification delivery to real ntfy / Shoutrrr services and webhooks; a hub-driven agent update on John's servers (their agents predate update keys: the last install comes first; the VM test above covers the update, the last install and the rollback); host shell and host power (off everywhere); checks run by real agents; UPS, GPU and Unraid array collectors, Proxmox tasks, replication and Ceph (fixtures only: no permission to run test builds on PVE-01/02); OOM and restart-loop alerts.
- **Out of memory, the machine or a limit (LM-04, 2026-10-18)**: parsing (the kernel's line formats, The Titan's 10:39 kill among them), cgroup-to-guest mapping, the agent's reads (a non-blocking pipe for `/dev/kmsg`, a fake `journalctl`) and the hub rule and hints are unit- and hub-tested; no agent has read a real host's kernel log with it yet (this account may not read The Titan's kernel log). The first live check is The Titan after its agent is updated.
- **Numbers** keep the English format (1,234.5) in the Dutch interface; texts the hub writes (alert titles, hints, errors) stay English.
- **Single sign-on** is tested against a fake provider (Go tests: PKCE, state, nonce, expiry, linking, roles, re-authentication) and a throwaway local provider in the browser, not against a real Authentik, Keycloak or Entra ID.
- **Not implemented**: per-server overrides for sensor limits and rated TBW; clock-skew correction is implemented but untested.
- **Agents that follow their Whombat, restore through the API (2026-10-21, HS-170…HS-181)**: Go tests only. The hub's address list, `hub_addrs`, the previous agents' address across restarts and while running, `POST /hub/restore` (every refusal, the staged file, the stop, the next start with the backup's CA and servers, the same service token, a new listener certificate, `.pre-restore-*.bak`), a staged backup that fails, undo of an install, and the 14-day adoption run against in-process hubs; the agent's search runs against a fake hub on 127.0.0.1 and 127.0.0.2 (remembered addresses) and through a dialer that maps a 10.0.0.0/24 to it (the network search), with injected interfaces: no test touches a real network. Not yet run: an agent searching a real LAN, a restore through Whombat into a box, the appliance restarting the service after it stopped, and an Unraid agent rewriting its flash `agent.toml`.
