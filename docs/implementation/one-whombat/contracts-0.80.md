# Contracts 0.80.0 as released (one Whombat)

Released 2026-10-17 from `whombat-contracts` main `2f9d0a7` (tag `contracts-v0.80.0`, decisions CT-336…CT-343 in the
contracts repo's `docs/decisions/contracts.md`). Vendored on `one` in Whombat and whombat-app. Everything is additive;
`SESSION_API_LEVEL` is **39**. Import from `@whombat/core` (or `/domain`, `/contracts`) and `@whombat/protocol/session`.

All REST paths below are relative to `/api/v1` and burrow-scoped (`/burrows/:burrow/…`). An endpoint's id is its session
op name and its key in `api` (`api.hosts.getServer` ↔ `hosts.getServer`).

## Deviations from assignment §3 (and why)

| §3 said | Released | Why |
|---|---|---|
| `hosts.servers.get`, `hosts.guests.list`, … (three-part ids) | one area `hosts` with verb-noun keys (`hosts.getServer`, `hosts.listGuests`, …; table below) | Session op names are `api.<area>.<action>` and must equal the endpoint ids. |
| paths `/home`, `/hosts/…` | `/burrows/:burrow/home`, `/burrows/:burrow/hosts/…` | Every REST route is burrow-scoped (membership and roles). |
| `hosts.manage` for every manage op | `hosts.manage` (POST) only changes; reads are `hosts.manageRead` (GET `?op=`) | Reads stay GET (safe to repeat), writes POST. |
| `WidgetSource {connectionId, tool, args, values}` or `{kind: server_metric, …}` | both carry `kind`: `connection_tool` or `server_metric` | A discriminated union. |
| `HostRange` | `HostSeriesRange` | `HostRange` already exists in `@whombat/core/text` (the box's own metrics). |
| — | extra: `hosts.serverSettings`, `hosts.serverAction`, `hosts.updateCheck`, `hosts.closeConsole`, `deviceSkills.decline` | The screens need them. |
| `ChangeEntry.link?` (a link) | `link?: href` + `thingId?` | Links on Home are app paths (`href`), not new `LinkRef` members. |

## Feature, level, ids

- Features: **`shell.assistant`** (Home, Watch, changes, widgets, chats, Approve later, device skills, servers; the server
  advertises it while `WHOMBAT_SHELL=assistant`) and **`connections.tool_limits`**. Both are in the server's
  `NOT_IMPLEMENTED` (`apps/server/src/managed/runtime-features.ts`) until a stream moves them to `IMPLEMENTED_FEATURES`.
- Ids: `ChangeId` `chg_…`, `WidgetId` `wdg_…`, `DeviceSkillProposalId` `dvp_…` (`newId('change' | 'widget' |
  'deviceSkillProposal')`).
- Realtime: topic kind **`hosts`** → `topics.hosts(burrowId)` = `hosts:<burrowId>` (Whombat authorizes it like `burrow`,
  `realtime/hub.ts`). New events (in `RealtimeEvent`, `REALTIME_EVENT_TOPICS`):

| Event | Topic | Payload |
|---|---|---|
| `home.changed` | `me` | `{parts: HomePart[]}` — `needsYou`, `working`, `things`, `automationsToday`, `widgets`, `doneRecently`, `watch` |
| `widget.updated` | `me` | `{widgetId}` |
| `hosts.server` | `hosts` | `{serverId, server: HostServer \| null}` (null: removed) |
| `hosts.guest` | `hosts` | `{serverId, guestId, state: HostGuestState}` |
| `hosts.alert` | `hosts` | `{alert: HostAlert}` |
| `hosts.task` | `hosts` | `{serverId, guestId: string \| null, actionId?, taskId?, op, result: ok \| warning \| error, message?}` |
| `hosts.enrollment` | `hosts` | `{enrollmentId, hostname: string \| null}` |
| `hosts.resync` | `hosts` | `{}` — refetch every `hosts.*` read |

## Home, Watch, changes, widgets (`domain/home.ts`, `contracts/home.ts`)

| Op | Method · path | Body / query | Response |
|---|---|---|---|
| `home.overview` | GET `/burrows/:burrow/home` | | `HomeOverview` |
| `watch.list` | GET `…/watch` | `?state=open\|all` | `{items: WatchItem[]}` |
| `needsYou.snooze` | POST `…/needs-you/snooze` | `{ref: HomeRef, until}` | `{ref, snoozedUntil}` |
| `changes.list` | GET `…/changes` | `?before&limit(20, ≤100)&thing` | `{changes: ChangeEntry[], before: cursor \| null}` |
| `changes.undo` | POST `…/changes/:changeId/undo` | | `{change, state: undone \| asked, approvalNumber?}` |
| `widgets.list` | GET `…/widgets` | | `{widgets: Widget[]}` |
| `widgets.remove` | DELETE `…/widgets/:widgetId` | | `{widgets}` |
| `widgets.move` | POST `…/widgets/:widgetId/move` | `{position}` (0 = first) | `{widgets}` |

- `HomeOverview {summary {needsYou, working, problems}, needsYou: NeedsYouItem[], working: WorkingTask | null, things:
  ThingSummary[], automationsToday: AutomationToday[], widgets: Widget[], doneRecently: ChangeEntry[], generatedAt?}`.
- `HomeRef {kind: string slug (known: HOME_REF_KINDS = approval, question, alert, hint, enrollment, connection,
  device_skill, automation_run, check), id}`; `HomeSeverity` `bad | warn | info`; `HomeHref` = an app path starting
  with `/`.
- `NeedsYouItem {id, ref, kind: approval | alert | question | connection | device_skill | enrollment, severity, title,
  body, at, actions: NeedsYouAction[] (≤ 4), subject? {kind: server | connection | device, id, name}, approvalNumber?}`;
  `NeedsYouAction {id, label, style: primary | secondary, kind: approve | approve_later | decline | snooze | open |
  investigate, at?, href?}`.
- `WorkingTask {conversationId, title, startedAt, progress {done, total}, steps: [{title, detail?, state: done | active
  | waiting | todo}]}`.
- `ThingSummary {id (= thingId), kind: server | connection | device, catalogId?, name, icon, status: ok | warn | bad |
  learning | offline | unknown, line?, facts: [{label, value, unit?, note?}] (≤ 8), href}`. Helpers: `thingId(kind,
  id)` → `server:pve-02`, `parseThingId`, `thingHref(kind, id)` → `/things/server%3Apve-02`, `chatHref(id)` →
  `/chats/<id>`.
- `AutomationToday {id: AutomationId, name, state: ran | failed | scheduled, at}`.
- `ChangeEntry {id, title, detail?, at, actor {kind: whombat | person, id, name}, undo {state: available | undone |
  none, until?}, link?: href, thingId?}`; `CHANGE_UNDO_WINDOW_S` = 24 h; `DONE_RECENTLY_MAX` = 8.
- `Widget {id, title, subtitle?, kind: 'line', series: [{key, label, unit?, color: 1 | 2 | 3}] (1–3), latest: [{key,
  value: number | null, unit?}], points: [{t, values: Record<key, number | null>}] (oldest first), refreshSec,
  updatedAt | null, fromConversationId?, problem?}`.
- `WidgetSource` = `{kind: 'connection_tool', connectionId, tool, args, values: [{key, label, unit?, path (JSON
  pointer)}] (1–3)}` | `{kind: 'server_metric', serverId, series: string[] (1–3)}`. Constants
  `WIDGET_REFRESH_MIN_S` 60, `WIDGET_REFRESH_DEFAULT_S` 300, `WIDGET_REFRESH_MAX_S` 86 400, `WIDGET_HISTORY_S` 24 h,
  `WIDGETS_MAX` 12. `JsonPointer`, `jsonPointerGet(doc, pointer)`.
- `WatchItem {id, ref, source: server | connection | automation | device, severity, title, body, at, serverId?, state:
  open | acknowledged | snoozed, snoozedUntil?, href?}`.

## Approve later

- `approvals.decide` body gains `executeAt?` (ISO time; approve only, future, ≤ 7 days, else `validation_failed`).
- `Approval.executeAt?: Timestamp | null`.

## Task chats (`domain/conversation.ts`, `contracts/home.ts`)

| Op | Method · path | Body / query | Response |
|---|---|---|---|
| `chats.list` | GET `…/chats` | `?archived&subjectKind&subjectId` | `{chats: ChatSummary[]}` |
| `chats.start` | POST `…/chats` (201) | `{text, subject?: ChatSubject}` | `{conversation: Conversation, message: Message}` |
| `chats.rename` | PATCH `…/chats/:conversationId` | `{title}` (≤ 60) | `{conversation}` |
| `chats.archive` | POST `…/chats/:conversationId/archive` | | `{conversation}` |

- `Conversation.chat?: ConversationChat | null` = `{title (≤ CHAT_TITLE_MAX 60), subject?: ChatSubject | null,
  archivedAt?: Timestamp | null}`; null/absent on the default chat.
- `ChatSubject {kind: server | connection | device, id, name}`.
- `ChatSummary {id, title, subject?, lastAt: Timestamp | null, lastText?, unread, default: boolean, archivedAt?}`.
- `chatTitleFrom(text)` (first non-empty line, Markdown marks dropped, ≤ 60 with “…”, “New chat” when empty);
  `chatSubjectLine(subject)` → “This chat is about the server pve-02.”

## Servers (`domain/hosts.ts`, `contracts/hosts.ts`, all under `/burrows/:burrow/hosts`)

| Op | Method · path | Body / query | Response |
|---|---|---|---|
| `hosts.status` | GET `/status` | | `HostsStatus {present, healthy, version?, reason?, agentUrl?, servers?, canManage?}` |
| `hosts.fleet` | GET `/fleet` | `?group` | `HostFleet` |
| `hosts.getServer` | GET `/servers/:serverId` | `?range` | `HostServerDetail` |
| `hosts.serverMetrics` | GET `/servers/:serverId/metrics` | `?range&series(comma list)&from&to` | `HostSeries` |
| `hosts.serverSettings` | GET `/servers/:serverId/settings` | | `HostServerSettings` |
| `hosts.updateServer` | PATCH `/servers/:serverId` | `HostServerSettingsPatch {group?, location?, parent?, remoteControl?}` | `HostServerSettings` |
| `hosts.removeServer` | DELETE `/servers/:serverId` | | `{ok: true}` |
| `hosts.serverAction` | POST `/servers/:serverId/actions` (202) | `{action: host_reboot \| host_shutdown, confirm: true}` | `HostActionAccepted` |
| `hosts.listGuests` | GET `/guests` | `?server&q&state&platform&kind&tag&sort&limit&cursor` | `HostGuestPage` |
| `hosts.getGuest` | GET `/servers/:serverId/guests/:guestId` | | `HostGuestDetail` |
| `hosts.guestMetrics` | GET `/servers/:serverId/guests/:guestId/metrics` | as serverMetrics | `HostSeries` |
| `hosts.guestAction` | POST `/servers/:serverId/guests/:guestId/actions` (202) | `HostGuestActionBody {action, confirm?, snapshot?, description?, memory?}` | `HostActionAccepted {actionId, auditId?, noop?}` |
| `hosts.manage` | POST `/servers/:serverId/manage` | `HostManageRequest {op, guestId?, platform?, params, digest?, confirm?, confirmName?}` | `HostManageResult {ok, task? {id}, newId?, changes?, auditId?}` |
| `hosts.manageRead` | GET `/servers/:serverId/manage` | `?op(HostManageReadOp)&guestId&platform&storage&content` | `HostManageReadResult` (by `op`) |
| `hosts.getTask` | GET `/servers/:serverId/tasks/:taskId` | `?platform&logStart` | `HostTask` |
| `hosts.listAlerts` | GET `/alerts` | `?state&server&severity&limit&before` | `{alerts: HostAlert[]}` |
| `hosts.ackAlert` | POST `/alerts/:alertId/ack` | `{note?, minutes?}` (0 = until resolved, ≤ 43 200) | `HostAlert` |
| `hosts.unackAlert` | DELETE `/alerts/:alertId/ack` | | `HostAlert` |
| `hosts.listMaintenance` | GET `/maintenance` | | `{items: HostMaintenance[]}` |
| `hosts.createMaintenance` | POST `/maintenance` (201) | `HostMaintenanceCreate` | `HostMaintenance` |
| `hosts.removeMaintenance` | DELETE `/maintenance/:maintenanceId` | | `{ok: true}` |
| `hosts.listChecks` | GET `/checks` | | `{checks: HostCheck[]}` |
| `hosts.createCheck` | POST `/checks` (201) | `HostCheckInput` | `HostCheck` |
| `hosts.updateCheck` | PATCH `/checks/:checkId` | `HostCheckInput` | `HostCheck` |
| `hosts.removeCheck` | DELETE `/checks/:checkId` | | `{ok: true}` |
| `hosts.createEnrollment` | POST `/enrollments` (201) | | `HostEnrollment {id, expiresAt, installCommand}` |
| `hosts.listEnrollments` | GET `/enrollments` | `?state=pending\|issued\|approved\|rejected\|expired\|all` | `{items: HostPendingEnrollment[]}` |
| `hosts.approveEnrollment` | POST `/enrollments/:enrollmentId/approve` | `{group?, name?}` | `{serverId}` |
| `hosts.rejectEnrollment` | POST `/enrollments/:enrollmentId/reject` | | `{ok: true}` |
| `hosts.createConsole` | POST `/servers/:serverId/consoles` (201) | `HostConsoleCreateBody {guestId?, protocol?, switchFrom?}` | `HostConsoleSession` |
| `hosts.closeConsole` | DELETE `/consoles/:sessionId` | | `{ok: true}` |
| `hosts.inspect` | GET `/servers/:serverId/inspect/:kind` | kind `processes \| ports \| services \| updates` | `HostInspectResult` (by `kind`) |

Shapes (camelCase translations of the hosts service's JSON; see `domain/hosts.ts` for every field):

- `HostServerStatus` `ok | warn | bad | offline | pending`; `HostServerPlatform` `proxmox | standard`; `HostPlatform`
  `docker | incus | libvirt | pve`; `HostGuestKind` `vm | container`; `HostGuestState` `running | stopped | unhealthy |
  paused`; `HostSeverity` `critical | warning`; `HostConsoleProtocol` `vnc | spice | serial | shell | tty | logs`;
  `HostSeriesRange` `1h | 6h | 24h | 7d | 30d | 90d`.
- `HostServer {id, name, group, status, statusNote?, platform, os, cpu {model, cores, threads} | null, uptimeS?, cpuPct,
  memory {usedPct, usedGb?, totalGb}, storage {usedPct, usedTb?, capacityTb}, temperature {maxC, limitC} | null,
  diskWearMaxPct?, guests: [{platform, running, total, unhealthy?}], agent {version, connected}, lastSeen, cpu24h:
  (number | null)[] ≤ 48 (HOST_CPU24H_POINTS), remoteControl: HostRemoteControl, alerts? {critical, warning},
  maintenance?, parent?}`.
- `HostRemoteControl {console, power, agentConsole?, agentPower?, consoleReason?, powerReason?, hostShell?, hostPower?,
  …Reason?, manage?, agentManage?, manageReason?, diagnose?, agentDiagnose?, diagnoseReason?}`; `HostRemoteToggles
  {console, power, hostShell?, hostPower?, manage?, diagnose?}`.
- `HostFleet {asOf, groups [{name, count}], kpis: HostFleetKpis, servers: HostServer[], alerts: HostAlert[], hints:
  HostHint[], agentsConnected, pendingEnrollments}`.
- `HostServerDetail {asOf, server: HostServerInfo, live: HostLive | null, banner | null, sensors: HostSensor[] ({id,
  label, group?, source, nowC, maxC, limitC}), disks: HostDisk[], virtualization: HostVirtualization | null, hints,
  alerts?, health?: HostHealth {system?, network?, volumes?, arrays?, ups?, gpus?, fans?, tasks?, pveReplication?,
  ceph?}, workloads?: Record<docker | incus | libvirt, HostPlatformWorkload>, proxmox? {cluster: HostCluster | null,
  storages: HostStorage[], backups: HostBackups | null, guests {vm?, container?}}}`. Updates and reboot-required are in
  `health.system` (`HostSystem.updates`, `securityUpdates`, `rebootRequired`, `failedUnits`, …).
- `HostGuest {id (pve:101), serverId, serverOnline?, name, platform, kind, image, state, vcpu?, cpuPct, memoryUsedMb,
  memoryLimitMb, …, uptimeS, console {available, protocols?, defaultProtocol?, resolution?, unavailable?}, vmid?, node?,
  lastBackup?, addresses?, tags?, pendingChanges?, guestAgent?, haState?, …}`; `HostGuestDetail` = `HostGuest` +
  `{remoteControl, manageable}`; `HostGuestPage {guests, total, nextCursor, counts?, platforms?, tags?}`.
- `HostSeries {serverId, guestId?, range (| 'custom'), stepSeconds, asOf, timestamps, series: Record<name, (number |
  null)[]>, summary?: Record<name, {avg, max, maxAt} | null>}`.
- `HostAlert {id, serverId: string | null, severity, title, detail, openedAt, rule, state: open | resolved, resolvedAt?,
  section?, acknowledged? {at, by, note, until}, muted?, suppressedBy?, attention}`; `HostHint {serverId, kind,
  severity: warning | info, entity, title, detail, section}` (sections without `#`).
- `HostMaintenance`, `HostMaintenanceCreate {scope: server | group | all, target?, startsAt?, endsAt?, durationMin?,
  weekdays?, startTime?, tz?, note?}`; `HostCheck`, `HostCheckInput`; `HostPendingEnrollment {id, state, hostname, os,
  address, agentVersion, requestedAt, createdAt?, expiresAt?, serverId?}`; `HostTask {id, type, platform?, guestId?,
  node?, user?, started, ended?, status: running | ok | warning | error, message?, log?, logNext?}`.
- Manage: `HOST_MANAGE_OPS` (`config.set`, `disk.resize`, `disk.move`, `guest.create`, `guest.clone`, `guest.template`,
  `guest.delete`, **`guest.migrate`**, `backup.create`, `backup.restore`, `backup.update`, `backup.delete`,
  `content.download`, `content.delete`, `appliance.download`, `task.stop`, `firewall.options`, `firewall.rule_add`,
  `firewall.rule_update`, `firewall.rule_delete`, `ha.set`, `ha.remove`, `replication.add`, `replication.delete`);
  `params` carry the route's body fields in camelCase (`set`, `delete`, `revert`, `size`, `storage`, `newId`, `name`,
  `target`, `online`, …). `HOST_MANAGE_DESTRUCTIVE_OPS`. `HOST_MANAGE_READ_OPS` (`config.get`, `choices`,
  `backup.list`, `content.list`, `appliance.list`, `task.list`, `firewall.get`, `snapshot.list`) →
  `HostManageReadResult` = `{op: 'config.get', config: HostGuestConfig} | {op: 'choices', choices: HostChoices} | {op:
  'backup.list', items: HostBackupVolume[]} | {op: 'content.list' | 'appliance.list', items: JsonObject[]} | {op:
  'task.list', items: HostTask[]} | {op: 'firewall.get', firewall: HostFirewall} | {op: 'snapshot.list', items:
  HostSnapshot[]}`. `HostGuestConfig.digest` goes back as `HostManageRequest.digest`.
- Actions: `HostGuestAction` = `HOST_POWER_ACTIONS` (`start`, `shutdown`, `reboot`, `force_stop`, `restart`, `stop`,
  `pause`, `resume`, `ctrl_alt_del`) + `HOST_SNAPSHOT_ACTIONS` (`snapshot_create`, `snapshot_restore`,
  `snapshot_delete`); `HOST_DESTRUCTIVE_ACTIONS` need `confirm: true`.
- Consoles: `HostConsoleSession {sessionId, path, token, protocol, expiresAt, idleTimeoutS, requiresConfirmation?}`.
  The browser opens `path` (Whombat's, `HOSTS_CONSOLE_WS_PATH` = `/burrows/:burrow/hosts/consoles/:sessionId/ws` under
  `/api/v1`) with subprotocols `HOSTS_CONSOLE_SUBPROTOCOL` (`whombat.console.v1`) and `HOSTS_CONSOLE_TOKEN_PREFIX +
  token` (`whombat.token.<token>`); frames are the hosts service's (`kind | channel (u16 BE) | payload`). Whombat
  proxies to the service with its own subprotocol.
- `HostInspectResult` = `{kind: processes | ports | services | updates, asOf, truncated, items}` with `HostProcess {pid,
  ppid?, user, name, command, cpuPct, rssBytes, state, threads?, container?, started?}`, `HostPort {proto, address,
  port, pid?, process?}`, `HostService {name, description?, load?, active, sub?, enabled?, since?}`,
  `HostPackageUpdate {name, current?, new, security?, source?}`.
- `HOST_STATUS_LABELS` (Running fine · Needs a look · Problem · Offline · Waiting for its first report).
- Session safety: reads `safe`; every write `never` resent (it acts in the service outside the receipt); removals,
  power, manage, enrollment decisions and DELETEs destructive. `hosts.createEnrollment` and `hosts.createConsole` are
  secret ops (tokens).

## The Servers connection (`domain/connections-catalog.ts`)

Builtin catalog entry **`whombat_servers`** (name “Servers”, handle `servers`, shared, category `infrastructure`, not
in `CATALOG_CONNECTABLE`; the server provisions it when the hosts service is present). Tools `SERVERS_TOOLS` (input
JSON schema in the entry; `server` = a server id, `guest` = a guest id):

| Tool | Access | Input | Asks |
|---|---|---|---|
| `servers_overview` | read | `{}` | |
| `server_detail` | read | `{server}` | |
| `server_metrics` | read | `{server, range?, series?: string[]}` | |
| `guests_list` | read | `{server?, q?, state?}` | |
| `guest_detail` | read | `{server, guest}` | |
| `guest_config` | read | `{server, guest}` | |
| `guest_power` | write | `{server, guest, action: start \| stop \| shutdown \| reboot}` | stop, shutdown, reboot (rule) |
| `guest_config_set` | write | `{server, guest, digest, set?: Record<string,string>, delete?: string[]}` | |
| `guest_snapshot` | write | `{server, guest, action: create \| restore \| delete, name?, description?}` | restore, delete (rule) |
| `guest_migrate` | write | `{server, guest, target, online?}` | always (`sensitive`) |
| `alerts_list` | read | `{server?}` | |
| `alert_snooze` | write | `{alert, minutes?, note?}` | |
| `server_diagnose` | read | `{server, check?}` | |
| `server_command` | write | `{server, command, reason}` | always (`sensitive`) |

The argument rules are `SERVERS_SENSITIVE` (in the entry's `sensitive`), so `sensitiveReason` / `isSensitiveCall`
already answer them. Clients never offer `whombat_servers` or `device` in Add a connection (web lists only
`CATALOG_CONNECTABLE`; the phone's list skips both since app `one` 71a3e8fa).

## Devices (`domain/devices.ts`, `domain/tool-limits.ts`)

- `DeviceProfile {name, vendor?, model?, driver: modbus_tcp | http_json, defaults {port?, unitId?, basePath?} (default
  {}), readings: DeviceReading[] (1–64), actions: DeviceAction[] (default []), source {url?, title?, note?} (default
  {})}`; `MODBUS_DEFAULT_PORT` 502, `MODBUS_DEFAULT_UNIT_ID` 1.
- `DeviceReading {key, label, unit?, modbus?: ModbusAddress, http?: {method: 'GET', path, pointer}}`;
  `ModbusAddress {table: holding | input | coil | discrete, address 0–65535, type: u16 | s16 | u32 | s32 | f32 | bool,
  scale?, wordOrder?: big | little}`.
- `DeviceAction {key, label, description, modbus?: ModbusAddress with table holding | coil, http?: {method: POST | PUT
  | PATCH, path, body?: JsonObject, valuePointer?}, valueType: number | boolean | choice, min?, max?, step?, choices?:
  [{value, label}], sensitive?}`.
- `ToolArgLimit {min?, max?, step?, choices?}` (= `DeviceActionLimits`); `DeviceActionChoice {tier: off | ask | can,
  limits?}`; `DEVICE_TIER_LABELS` Off · Ask me · Allowed; `DEVICE_SKILL_COPY`; `moreReadingsText`.
- Card kind **`device_skill`** (`DeviceSkillCard`, in `MessageCard`, `StoredCard` and `CARD_KINDS`; not postable):
  `{kind, proposalId, name, model?, readings: [{key, label, value (formatted string), unit?}] (≤ 12), moreReadings,
  actions: [{key, label, description, proposed: DeviceActionChoice, valueType?, min?, max?, unit?, sensitive?}],
  testedAt, status: proposed | on | declined, decided?: Record<key, DeviceActionChoice>, connectionId?}`.
- `deviceSkills.decide` POST `…/device-skills/:proposalId/decide` `{actions: Record<key, {tier, limits?}>, switchOn}` →
  `{card: DeviceSkillCard, connectionId: con_… | null}`; `deviceSkills.decline` POST `…/device-skills/:proposalId/decline`
  → the same.
- Catalog entry **`device`** (builtin, shared, category `home`, handle `device`, no tools of its own: each device
  connection gets `<device>_read` and one tool per action from the server).

## Tool limits

- `ConnectionToolLimits {args: Record<JSON pointer into the tool's args, ToolArgLimit>}`; `TOOL_LIMITS_ARGS_MAX` 16.
- `ConnectionToolView.limits?: ConnectionToolLimits | null`.
- `connections.setToolLimits` POST `/burrows/:burrow/connections/:connectionId/tools/:tool/limits` `{limits:
  ConnectionToolLimits | null}` → `ConnectionToolsResponse`.
- `checkToolLimits(limits, args)` → `{ok: true} | {ok: false, pointer, reason}` (a missing argument passes; a range
  needs a number; steps count from `min`); `reason` is the plain refusal, e.g. “The owner allows only between 16 and 24
  here.”; `limitText(limit, unit?, labels?)`.

## MCP tools (`contracts/mcp-one.ts`, `ONE_MCP_TOOLS`; personal agents only, no key)

| Tool | Input | Output (`commitOutcome`) |
|---|---|---|
| `set_chat_title` | `{title}` (≤ 60) | `{}` |
| `pin_widget` | `{title, subtitle?, source: WidgetSource, refreshSec? (60–86 400)}` | `{widgetId}` |
| `device_probe` (readOnly) | `{driver, host, port?, unitId?, readings: DeviceReading[] (≤ 64)}` | `{readings: DeviceProbeValue[] ({key, label, value: number \| boolean \| string \| null, unit?, raw?, error?}), at}` |
| `propose_device_skill` | `{profile: DeviceProfile, host, port?, unitId?}` | `{proposalId}` |

`propose_device_skill` is in `MCP_POSTING_TOOLS`. On `one` the four have refusing handlers and are kept out of
`tools/list` by `NOT_YET_SERVED_TOOL_NAMES` (`apps/server/src/mcp/served.ts`); the stream that implements a tool
replaces its handler in `mcp/tools.ts` and takes its name out of that list.

## Session safety of the other new ops

`home.overview`, `watch.list`, `changes.list`, `widgets.list`, `chats.list` read; `needsYou.snooze`, `widgets.move`,
`chats.start`, `chats.rename`, `connections.setToolLimits` receipt; `widgets.remove`, `chats.archive`,
`deviceSkills.decide`, `deviceSkills.decline` destructive (receipt); `changes.undo` destructive, never resent.

## Left for 0.80.1

Chat unarchive; typed Proxmox ISO, template and Incus image lists in `HostChoices` (JSON objects now); the guest
thumbnail and screenshot routes; anything a stream finds missing (report it to the lead with the exact shape).
