# One Whombat build (2026-10-17)

Read first: `docs/decisions/one-whombat.md` (ONE-01…ONE-22, the product and architecture decisions; do not reopen
them) and the visual reference `~/Code/.wt/app-one/docs/design-handoff/one-whombat/` (`index.html` renders all four
screens; `home.png`, `home-light.png`, `server.png`, `convo.png`, `phones.png`). The mocks win on layout, copy and
behaviour; tokens win on colours, fonts and radii. Where a mock shows something this assignment leaves out, the
assignment wins (see §9).

John wants choices made by us (feedback-decide-yourself): decide open details yourself, record them in your stream's
decision file with the reason, and move on. Ship target is **DEV**. Production is not part of this task.

## 0. Rules for every stream

- Work only in your worktree and branch. Commit there in small focused commits (imperative, `area: what`), each ending
  with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. **Never push, never merge into `main` or the
  integration branch, never tag** (the lead does), except stream C, which releases contracts as described in §3.
- **Quick checks only** (John, DEV fast): your repo's check (`TMPDIR=~/.cache/wb-tmp pnpm check`; Go: `go vet ./...`
  and `go test ./...`, `-race` once at the end) and, for Whombat server changes, `TMPDIR=~/.cache/wb-tmp pnpm
  test:server` **once** at the end (run single int-test files while working). No `harness/validate`, no
  `release/ship`, no VM tests, no Android emulator, no waiting on GitHub Actions, no repeated full suites.
- **No sub-agents** (don't use the Agent/Task tool). Never `pkill`/`killall` broadly; stop only processes you started,
  by PID. Never write outside your worktree (scratch goes to `~/.cache/wb-tmp/one/<stream>/`). Never touch Docker
  containers, the dev stack (`whombat-stack-dev`), `whombat-dev`, the DEV box, `~/Services/*`, The Falcon, John's
  servers or production. `TMPDIR=~/.cache/wb-tmp` for everything (host `/tmp` runs out of inodes).
- Server tests use the shared Postgres on `:55432` with throwaway databases (`useTestDb()`); a dev server of your own
  uses the ports in the stream table and its own database `whombat_one_<stream>`.
- **Contracts first**: anything crossing a process boundary is a Zod schema in the contracts. Only stream C changes
  contracts. Until 0.80.0 is vendored, code against the shapes in §3 (local types with the same names), then switch to
  the vendored types. A contract gap you find later: write it in your report and work around it; never edit vendored
  tarballs.
- **Copy** (CLAUDE.md): curly quotes ’ “ ”, `·`, `−`, verbatim mock copy; colours, fonts, radii only through tokens;
  44 px touch targets on mobile; real buttons and links, visible focus, labels. **Whombat talks like a person**
  (`docs/decisions/concise-replies.md`): every message, card, notice or prompt line people read is short plain English;
  ids, hashes, paths and logs stay out of chat.
- **UI work is verified visually**: web screens in Playwright at 1440×900, light and dark, against the mock PNGs,
  screenshots to `~/.cache/wb-tmp/one/<stream>/shots/`; fix differences before you finish. Mobile: logic tests and the
  fixture world; the lead does one emulator pass after integration.
- Decision ids: your prefix from the stream table, one decision file per stream, table `| # | Decision | Why |`.
- Finish with: every item done (or explicitly not, with why), checks green, a short report: commits, decisions, what
  the lead must do at merge (migrations, contract gaps, follow-ups), and how you verified it.

## 1. Repositories, versions, branches

| Repo | Today | Target |
|---|---|---|
| `~/Code/whombat-contracts` | 0.79.0, `SESSION_API_LEVEL` 38, CT-335 | **0.80.0**, level **39**, CT-336… |
| `~/Code/Whombat` | main 201cf2bb, migrations to `0103_backup_files` | `0104` (SW), `0105` (SH), `0106` (SD) |
| `~/Code/whombat-app` | 0.74.0, AP-1255 | **0.75.0** |
| `~/Code/whombat-hosts` | main beaea67 (Rackoon) | headless hosts service, HS-01… |
| `~/Code/whombat-appliance` | candidate 0.85.0, IN-272, NX-151 | candidate **0.86.0** (IN-273), NX-152… |

Integration branches: **`one`** in Whombat (`~/Code/.wt/whombat-one`) and whombat-app (`~/Code/.wt/app-one`), both
from main. Every Whombat and app stream branches from its `one`. The lead merges announcements into `one`; when told
(or when `git log one` shows it), `git merge one` into your branch.

## 2. Streams

| Stream | Repo · worktree · branch | Prefix · decision file | Ports | Section |
|---|---|---|---|---|
| C | contracts · `~/Code/.wt/contracts-one` · `one-contracts` | CT-336… · `docs/decisions/contracts.md` | — | §3 |
| H | hosts · `~/Code/.wt/hosts-one` · `one-headless` | HS-01… · `docs/decisions/hosts.md` | 24431 / 24432 | §4 |
| N | appliance · `~/Code/.wt/appliance-one` · `one-hosts` | NX-152… · `docs/decisions` per repo habit | — | §5 |
| SW | Whombat · `~/Code/.wt/whombat-one-assistant` · `one-assistant` | ONE-DW01… · `docs/decisions/one-whombat-assistant.md` | 24421 | §6.1 |
| SH | Whombat · `~/Code/.wt/whombat-one-servers` · `one-servers` | ONE-DH01… · `docs/decisions/one-whombat-servers.md` | 24422 | §6.2 |
| SD | Whombat · `~/Code/.wt/whombat-one-devices` · `one-devices` | ONE-DD01… · `docs/decisions/one-whombat-devices.md` | 24423 | §6.3 |
| WS | app · `~/Code/.wt/app-one-shell` · `one-shell` | AP-1256…1299 · `docs/decisions/one-whombat-shell.md` | 24426 / 25196 | §7.1 |
| WT | app · `~/Code/.wt/app-one-things` · `one-things` | AP-1300…1349 · `docs/decisions/one-whombat-things.md` | 24427 / 25197 | §7.2 |
| MA | app · `~/Code/.wt/app-one-mobile` · `one-mobile` | AP-1350…1399 · `docs/decisions/one-whombat-mobile.md` | — | §7.3 |

Lead (orchestrator): merges streams, runs the checks once per repo, releases app 0.75.0 (+ APK on DEV), vendors the app
into Whombat, deploys the hosted web (dev.whombat.com) and `whombat-dev`, cuts candidate 0.86.0, restarts the dev stack,
ships to John's box, enrolls servers, verifies (§8).

## 3. Stream C — contracts 0.80.0

All additive; old clients and old runtimes keep working (skew tests). Write `docs/implementation/one-whombat/
contracts-0.80.md` on Whombat `one` with the exact shapes and names as released. Then: merge `one-contracts` into
contracts main (`--no-ff`), tag `contracts-v0.80.0` on the merge, `pnpm release`, push main and the tag, vendor 0.80.0
into **both** `one` branches (Whombat and app; the usual `vendor/whombat-contracts/0.80.0/` + overrides + lockfile;
fix compile errors the bump causes, e.g. new required fields in fixtures) and commit there. Tell the lead.
**Speed matters: every other stream waits for this. Aim to release within about two hours**; prefer optional fields
over perfect modelling, and keep later refinements for a 0.80.1.

1. **Feature** `shell.assistant` in `RUNTIME_FEATURES` (ONE-03).
2. **Home** (`core/src/domain/home.ts`): `HomeOverview {summary {needsYou, working, problems}, needsYou: NeedsYouItem[],
   working: WorkingTask | null, things: ThingSummary[], automationsToday: AutomationToday[], widgets: Widget[],
   doneRecently: ChangeEntry[]}`.
   - `NeedsYouItem {id, ref {kind, id}, kind: approval|alert|question|connection|device_skill|enrollment, severity:
     bad|warn|info, title, body, at, actions: NeedsYouAction[]}`; `NeedsYouAction {id, label, style: primary|secondary,
     kind: approve|approve_later|decline|snooze|open|investigate, at? (approve_later), href?}`.
   - `WorkingTask {conversationId, title, startedAt, progress {done, total}, steps: [{title, detail?, state:
     done|active|waiting|todo}]}`.
   - `ThingSummary {id, kind: server|connection|device, catalogId?, name, icon, status: ok|warn|bad|learning|offline|
     unknown, line?, facts: [{label, value, unit?, note?}], href}`.
   - `AutomationToday {id, name, state: ran|failed|scheduled, at}`.
   - `ChangeEntry {id, title, detail?, at, actor {kind: whombat|person, id, name}, undo: {state: available|undone|none,
     until?}, link?}`.
   - `Widget {id, title, subtitle?, kind: line, series: [{key, label, unit?, color: 1|2|3}], latest: [{key, value,
     unit?}], points: [{t, values: Record<key, number|null>}], refreshSec, updatedAt, fromConversationId?}`;
     `WidgetSource` (stored, owner-visible): `{connectionId, tool, args, values: [{key, label, unit?, path}]}` (path is a
     JSON pointer into the tool result) or `{kind: server_metric, serverId, series[]}`.
   - `WatchItem {id, ref, source: server|connection|automation, severity, title, body, at, serverId?, state:
     open|acknowledged|snoozed, snoozedUntil?}`.
   - REST: `home.overview` GET `/home`; `watch.list` GET `/watch`; `needsYou.snooze` POST `/needs-you/snooze {ref,
     until}`; `changes.list` GET `/changes`; `changes.undo` POST `/changes/:id/undo`; `widgets.list` GET `/widgets`;
     `widgets.remove` DELETE `/widgets/:id`; `widgets.move` POST `/widgets/:id/move {position}`; approval decide gains
     optional `executeAt` (ISO time) — Approve later.
3. **Task chats** (ONE-06): `Conversation` gains optional `chat {title, subject? {kind: server|connection|device, id,
   name}, archivedAt?}` for DMs that are task chats. `ChatSummary {id, title, subject?, lastAt, lastText?, unread,
   default: boolean}`. REST: `chats.list` GET `/chats`; `chats.start` POST `/chats {text, subject?}` → `{conversation,
   message}`; `chats.rename` PATCH `/chats/:id {title}`; `chats.archive` POST `/chats/:id/archive`. MCP tool
   `set_chat_title {title}` (Whombat, once per chat).
4. **Hosts** (`core/src/domain/hosts.ts`, from Rackoon's `web/src/api/types.ts`, `docs/CONTRACT.md`,
   `docs/REST-API.md`, `docs/MANAGE.md` in `~/Code/whombat-hosts`; camelCase on Whombat's side, names prefixed
   `Host*`): `HostServer` (status ok|warn|bad|offline|pending, platform, cpu, uptime, cpu %, memory, storage, hottest
   sensor vs its limit, guests running/total per platform, agent version, last seen, `cpu24h: number[]` ≤ 48 points,
   remote-control switches), `HostServerDetail` (+ facts, storages, disks/SMART, sensors, health, updates, Proxmox
   cluster/storage/backups, virtualization capacity, hints), `HostGuest`, `HostGuestDetail`, `HostSeries`,
   `HostAlert`, `HostHint`, `HostMaintenance`, `HostCheck`, `HostEnrollment`, `HostTask`, manage request/result and
   `HostChoices`, console session `{path, token, protocol}`. Pass rarely used nested structures as typed but optional.
   REST under `/hosts`: `hosts.status` (is the service present and healthy), `hosts.fleet`, `hosts.servers.get/
   metrics/update/remove`, `hosts.guests.list/get/metrics/action`, `hosts.manage` POST `/hosts/servers/:id/manage {op,
   guestId?, params, digest?, confirm?, confirmName?}`, `hosts.tasks.get`, `hosts.alerts.list/ack/unack`,
   `hosts.maintenance.list/create/remove`, `hosts.checks.list/create/remove`, `hosts.enrollments.create/list/approve/
   reject`, `hosts.consoles.create` (guest console and host shell), `hosts.inspect` (processes, ports, services,
   updates). Realtime topic `hosts` with `hosts.server`, `hosts.guest`, `hosts.alert`, `hosts.task`.
5. **Servers tools** (ONE-12): a built-in catalog entry `whombat_servers` (“Servers”, not user-addable, provisioned by
   the server when the hosts service is present) with neutral tools: `servers_overview`, `server_detail`,
   `server_metrics`, `guests_list`, `guest_detail`, `guest_config` (read), `guest_power` (start, stop, shutdown,
   reboot; sensitive except start), `guest_config_set` (write), `guest_snapshot` (write), `guest_migrate` (write,
   sensitive), `alerts_list`, `alert_snooze` (write), `server_diagnose` (read), `server_command` (write, always asks).
6. **Devices** (`core/src/domain/devices.ts`, ONE-16…19): `DeviceProfile {name, vendor?, model?, driver: modbus_tcp|
   http_json, defaults {port?, unitId?, basePath?}, readings: DeviceReading[], actions: DeviceAction[], source {url?,
   title?, note?}}`; `DeviceReading {key, label, unit?, modbus? {table: holding|input|coil|discrete, address, type:
   u16|s16|u32|s32|f32|bool, scale?, wordOrder?}, http? {method: GET, path, pointer}}`; `DeviceAction {key, label,
   description, modbus?|http? (write), valueType: number|boolean|choice, min?, max?, step?, choices? [{value, label}],
   sensitive?}`. Card kind **`device_skill`** `{proposalId, name, model?, readings [{key, label, value, unit?}],
   moreReadings, actions [{key, label, description, proposed {tier: off|ask|can, limits?}}], testedAt, status:
   proposed|on|declined}`. Owner decision `deviceSkills.decide` POST `/device-skills/:id/decide {actions: Record<key,
   {tier, limits?}>, switchOn: boolean}`. MCP tools `device_probe {driver, host, port?, unitId?, readings[]}` (read
   only) and `propose_device_skill {profile, host, port?, unitId?}`. Catalog entry `device` (generic, profile-based).
7. **Tool limits**: `ConnectionToolView.limits? {args: Record<jsonPointer, {min?, max?, choices?}>}`; REST
   `connections.setToolLimits` POST `/connections/:id/tools/:tool/limits`.
8. **Widgets tool**: MCP `pin_widget {title, subtitle?, source: WidgetSource, refreshSec?}`.
9. Session ops and `OPERATION_SAFETY` entries for every new endpoint; `SESSION_API_LEVEL` 39; changelog CT rows.

## 4. Stream H — hosts service (Go, `~/Code/whombat-hosts`)

Read README.md, NOTES.md, docs/*.md first. Keep Rackoon's tests passing.

1. **Headless mode** `serve --headless`: register only the data routes; no UI/static handler, no `auth/*`, users,
   sessions, passkeys, OIDC, kiosk, tokens API, setup URL printout; the assistant is off (no routes, no job, no child
   process). Keep the code for non-headless mode working.
2. **Unix socket**: `--listen unix:/path` (mode from `--socket-mode`, default 0660).
3. **Service token**: `--service-token-file PATH`; on start, create a random token there (0640) if missing, store only
   its hash, and treat it as an admin service principal (no user row). Requests carry `Authorization: Bearer`,
   `X-Whombat-Actor: <id>|<display name>` (cleaned; becomes the audit actor and the key for per-person limits),
   optional `X-Whombat-Role: viewer|operator|admin` (capped at admin) and `X-Whombat-Client-IP`.
4. **Consoles with the service token**: allowed; re-authorisation checks the token still matches; per-person limits key
   on the actor. Document how Whombat proxies the console WebSocket (Origin, Host, subprotocols).
5. **Installer on the agent listener**: `/install.sh` and `/download/*` served on the TLS agent port; the install command
   pins the hub CA (`curl --pinnedpubkey` or equivalent) and uses the agent URL. `--agent-url auto` derives
   `wss://<LAN IP of the default-route interface>:<agent port>`; enrollment responses return the ready command.
6. **AI routes**: REST routes for the assistant's diagnose (read-only checks catalog) and exec (one command, output
   capped), so Whombat's tools can use them; a PVE `guest.migrate` manage op (online for VMs, restart for containers;
   only within a cluster; needs `VM.Migrate` on the manage token) with the usual digest/confirm rules.
7. **Names** (ONE-14): hub binary `whombat-hosts` (`cmd/whombat-hosts`), agent `whombat-agent` installed to
   `/usr/local/bin`, config `/etc/whombat-agent`, state `/var/lib/whombat-agent`, unit `whombat-agent`, Unraid and
   OpenRC/SysV paths likewise, Proxmox users `whombat@pve` / `whombat-manage@pve`, roles `WhombatManage` /
   `WhombatNetwork`. Keep accepting the old subprotocol and URI prefix; the updater accepts `whombat-agent` and
   `rackoon-agent` version output. A host may run both agents side by side (no shared paths, users or ports).
8. **Go version** compatible with nixpkgs' `buildGo127Module` (Go 1.27.1): lower the `go` directive accordingly.
9. **Docs**: `docs/WHOMBAT.md` — the contract Whombat uses: flags, socket, headers, every route Whombat calls with
   request/response shapes (point to REST-API.md where unchanged), SSE events, console proxying, install flow.
   Decisions in `docs/decisions/hosts.md`.
10. Checks: `go vet ./...`, `go test ./...` (and `-race` once at the end), `make lint` for gofmt. The web UI is not built
    or changed (stream WT ports parts of it into whombat-app).

## 5. Stream N — appliance (`~/Code/whombat-appliance`)

Follow the explorer's plan below and the repo's habits; no `release/ship`, no candidate, no VM tests.

1. Flake input `whombat-hosts` (the hosts service’s repository on GitHub, `git+https://…?rev=…`, `flake=false`, private
   like `whombat`); pin it to the head of `one-headless` for now (the lead re-pins after merge). `checks.hosts-pin`,
   a `whombat-hosts` component in the candidate schema and `harness/src/manifest/pins.ts`.
2. Package `nix/packages/hosts/default.nix` (`buildGoModule`/`buildGo127Module`, `CGO_ENABLED=0`): `whombat-hosts` and
   `whombat-agent` cross-built for linux amd64 and arm64 into `share/whombat-hosts/agent` (unsigned on DEV: agent
   self-update off; record the follow-up).
3. Module `nix/modules/hosts.nix`: `whombat.hosts.enable` (on in the DEV image only; asserted off in prod images),
   fixed uid/gid **965** `whombat-hosts`, `/persist/hosts` (0700, own subvolume), unit `whombat-hosts.service` (after
   `whombat-persist.target`, `ConditionPathExists` on the device identity), ExecStart `whombat-hosts serve --headless
   --data /persist/hosts --listen unix:/run/whombat-hosts/api.sock --agent-listen :8443 --agent-url auto --agent-dist
   <pkg>/share/whombat-hosts/agent --service-token-file /persist/hosts/service-token`; sandboxing like computerd
   (RuntimeDirectory 0750, socket 0660, ReadWritePaths, InaccessiblePaths over secrets/identity, AF_UNIX/INET/INET6,
   MemoryMax 512M, not DynamicUser); ping checks need `CAP_NET_RAW` or `ping_group_range`; LAN egress for checks (like
   the server's `local4` rule) for uid 965. Firewall: 8443/tcp from private ranges only (copy NX-138). Server env
   `WHOMBAT_HOSTS_SOCKET=/run/whombat-hosts/api.sock`, `WHOMBAT_HOSTS_TOKEN_FILE=/persist/hosts/service-token` and the
   supplementary group. Outside boot assessment.
4. Dev stack (`harness/src/dev/`): a `hosts` service built from the pinned clone (`goBuild`), agent port **4743**, its
   socket and token under the stack's state dir, `WHOMBAT_HOSTS_*` in `runtimeEnv()`.
5. Checks: `nix build` of the package and the DEV image's toplevel (no ISO), `nix flake check` for the pin checks, the
   harness unit tests for what you changed.

## 6. Whombat server streams

### 6.1 SW — one Whombat, chats, Home, changes, widgets

**First commit, within about an hour, then tell the lead** (SH and SD build on it): migration `0104_one_whombat`
(tables `changes` (id, burrow, actor, agent, person, kind, title, detail, subject ref, sealed undo recipe, link,
undone_at/by, created_at), `widgets` + `widget_points`, `needs_you_snoozes`; `conversations.chat_title`,
`chat_subject_kind/id`, `chat_archived_at`, `task_key` with the DM unique and slug indexes made partial; `approvals.
execute_at`), and `apps/server/src/home/registry.ts` with:

```ts
registerNeedsYouSource(name, (ctx: SourceCtx) => Promise<NeedsYouItem[]>)
registerThingsSource(name, (ctx: SourceCtx) => Promise<ThingSummary[]>)
registerWatchSource(name, (ctx: SourceCtx) => Promise<WatchItem[]>)
registerUndoer(kind, (tx, change, actor) => Promise<{ ok: true } | { ok: false; reason: string }>)
recordChange(tx, { burrowId, actorId, kind, title, detail?, subject?, undo?: { kind; payload }, link? }) // seals payload
// SourceCtx = { db, burrowId, personId, now }
```

Then:
1. `WHOMBAT_SHELL` (default `assistant`) → feature `shell.assistant`; in assistant mode onboarding creates no crew,
   `hire_agent` is refused with a plain reason, the #general welcome posts nothing.
2. Whombat naming (ONE-01): default assistant name “Whombat”; a migration renames assistants still named with the old
   default; several people's assistants may all be called Whombat (relax `assertAgentNameFree` for assistants).
3. Close the gaps for the assistant: automation steps may wake the automation owner's Whombat; Whombat may draft
   automations; Whombat gets a working directory and its computer (to build and test); it may look after shared
   connections.
4. Task chats (§3.3): commands and reads, `personalDmId` keeps the default DM, the turn context gets the chat's subject
   (“This chat is about the server pve-02.”), `set_chat_title`.
5. Changes and Undo: record changes in `call_connection_tool` writes; undo recipes for Home Assistant on/off (MCP) and
   any adapter that can read the old state; `changes.undo` runs the inverse as a new call through the pipeline.
6. Home read model `home.overview` (registry sources + approvals/questions + Whombat's active plan as Working on +
   automations today + widgets + Done recently); `watch.list`; snoozes; Approve later (`execute_at` + a ticker that
   executes due approvals).
7. Widgets: `pin_widget`, a refresher (no model; read-tier tools only; person-side read path), 24 h of points.
8. Connection health: a poller (every 5 min, cheap status check) keeps `catalog_connections.status` current; a Things
   source for connections with a `glance` per adapter where cheap: Home Assistant (a climate temperature, alarm state,
   locks, lights on, entity count), UniFi (clients, access points online, WAN rate), Hetzner (servers), Google mail
   (unread). Others show status and “last checked”.
9. Prompt: Whombat's persona and work style — plain, short; for multi-step work create a plan and keep its steps
   current (feeds Working on); offer a widget when someone wants to keep an eye on something.

### 6.2 SH — servers (after C; merge SW's first commit when announced)

1. Hosts client over the Unix socket (`WHOMBAT_HOSTS_SOCKET`, `WHOMBAT_HOSTS_TOKEN_FILE`, config in `config.ts` like
   `WHOMBAT_COMPUTERD_SOCKET`), actor headers per request, health; SSE subscription → realtime topic `hosts` + a small
   cache; absent service → `hosts.status` says so and nothing else breaks.
2. REST routes per §3.4: reads map Rackoon JSON to contracts; writes are commands in the commit pipeline (owners
   change servers, members view; record your exact rule), with confirmations passed through; console WebSocket proxy;
   Add a server (enrollment create returns the ready command; approve/reject).
3. The `whombat_servers` connection, provisioned automatically, with the §3.5 tools through `connection_call` (keys,
   tiers, approvals, signed events); sensitive actions always ask; changes recorded with undo for config changes
   (previous values) and power (inverse action).
4. Registry sources: Needs you (critical alerts, pending enrollments), Things (servers), Watch (alerts and hints).
5. A fake hosts service (TS, Unix socket, recorded JSON from `~/Code/whombat-hosts/docs/handoff/sample-data` or the
   web fixtures) for tests and the web fixtures; int tests for the client, routes, tools and console proxy. If the real
   binary is built from stream H's branch, one smoke test against it (skipped when absent).

### 6.3 SD — devices and the skill builder (after C; merge SW's first commit when announced)

1. Drivers in `apps/server/src/devices/`: **Modbus TCP** (own small client, no dependency: FC1–4 reads, FC5/6/15/16
   writes, timeouts, word order) and **HTTP/JSON** (through the outbound helper and its LAN rules).
2. `device_probe` (read-only; refuses writes) and `propose_device_skill` → `device_skill` card in the chat;
   `deviceSkills.decide` creates the `device` connection with tools (`<device>_read`, one tool per action) whose tiers
   and limits are the owner's choices; “Switch on” makes them live. Rewriting the profile resets choices (hash).
3. **Limits for every connection tool**: `connection_tools.limits` (migration `0106`), enforced in `call.ts` before the
   keys decision (numbers min/max/step, choices), with a plain refusal Whombat can relay.
4. Undo for device actions (read the old value first). Things source: devices (learning while proposed, then status
   from the last read; facts = latest readings). Widgets can use device readings.
5. Prompt section “A device Whombat doesn't support yet” (ONE-17/19). Discovery: Modbus (502) in “found on your
   network”. A fake Modbus server in tests (heat-pump-like registers) and an end-to-end test from probe to an allowed
   write within limits and a refused one outside.

## 7. App streams (`whombat-app`)

### 7.1 WS — shell, Home, Watch, chats, cards (after C)

1. `useShellMode()` from the `shell.assistant` feature (fixture option too). `AssistantSidebar` + pure model selected in
   `BurrowShell`; routes: `/` = Home in assistant mode, `/watch`, `/chats/$id`, `/skills` (reuse the packs UI),
   `things/$thing` (stub until WT lands; WT owns the screen). Chat routes stay registered.
2. Home (`features/home/`): every section of mock 1 against `home.overview`; the Servers card renders
   `<HomeServersCard/>` from `features/things/HomeServersCard.tsx` (**WT owns that file**; create a minimal stub with
   that export and the lead takes WT's version at merge).
3. Chats: the full-width conversation (mock 3) on the task chat, start a chat from Home's Ask box or the sidebar
   button, rename/archive; Watch page; Approve later and snooze buttons; Done recently with Undo; widgets (move
   `features/host/charts.tsx` to `components/charts/`).
4. Cards: `device_skill` card with `TierRow` (Off · Ask me · Allowed) and limits, **Switch on**; Storybook stories.
5. Fixtures for every new endpoint; visual check of Home (both themes) and the conversation against the PNGs.

### 7.2 WT — things and server pages (after C)

1. `packages/client/src/hosts/` (queries, realtime apply, view models shared with Android).
2. `features/things/`: server page (mock 2) with tabs Summary · Guests · Storage · Sensors · Backups · System ported from
   Rackoon (`~/Code/whombat-hosts/web/src/features/{server,fleet,guests,guest,manage,console}`), the guest page with
   editing (Hardware, Options, Cloud-Init, Snapshots, Backups, Firewall, Tasks; review step old → new; digest conflicts
   “Changed meanwhile — review again.”), consoles (xterm.js shell, noVNC screens; no SPICE), Add a server (install
   command, pending approvals), **Ask about <server>** pane (a task chat with that subject in `SidePane`), and
   `HomeServersCard` for Home. Restyle everything to Whombat tokens and type; copy in English only.
3. Charts: `TimeChart` and `Sparkline` ported into `components/charts/` next to WS's move (coordinate by file names:
   WS moves `charts.tsx`, you add new files).
4. Fixtures from Rackoon's sample data; visual check of the server page (both themes) against `server.png`.

### 7.3 MA — Android (after C)

1. Tabs **Home, Things, Chats, Watch** in assistant mode (`TabBar`, `RootNavigator`, `routes.ts`, `persist.ts`
   migration of saved tabs, link tests).
2. Screens: Home (mock 4 left), Things list and a server detail (summary, guests with power actions that ask), Chats
   list and the chat view on task chats, Watch with snooze/acknowledge; the approval sheet (mock 4 right: Restart
   now / Tonight at 03:00 / Not now) from `ui/sheet.tsx`; the device skill card with tiers; push taps for alerts open
   Watch. 44 px targets, TalkBack labels.
3. Logic tests and fixtures; no emulator (the lead does one pass).

## 8. Lead integration sequence

1. C releases and vendors 0.80.0 → announce; SW's foundation commit → merge into `one` → announce.
2. H done → N re-pins; SH smoke-tests against the real binary.
3. Merge streams into `one` per repo, `one` into `main`; checks once; app 0.75.0 release + APK; vendor into Whombat;
   hosted web deploy (dev.whombat.com); `whombat-dev`; candidate 0.86.0 with the hosts pin; dev stack; John's box
   (host release, one reboot); “Add a server” on John's LAN servers; live run-through: Home, a server, a chat about it,
   a widget, Undo, Watch, the phone.

## 9. Out of scope now (follow-ups)

UniFi “new device joined / Name it”; kiosk wall display; importing a Rackoon hub's data and moving existing agents;
signed agent self-updates on the box; deleting the hidden chat code; production.
