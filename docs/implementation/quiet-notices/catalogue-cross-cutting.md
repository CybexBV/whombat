# Quiet notices: the cross-cutting catalogue

Read-only research, 2026-10-22. Repositories as checked out:
- Whombat runtime (`apps/server/src`, paths below are relative to it unless marked)
- whombat-app `4d27775f`
- the hosts service `30c4985`
- the appliance's console
- whombat-contracts 0.121

Per-service kinds (`things/kinds/**`) are out of scope; they are covered by the other catalogues in this folder.

---

## 0. What matters most

1. **Ignored server alerts still colour the dot today.** The hosts hub keeps an acknowledged alert in `server.status = warning`, and its `status_note` comes from it too (`hosts/internal/rules/thresholds.go:189`, `internal/rules/engine.go:381`). Whombat's `serverStatus` starts from that hub status (`hosts/map.ts:163`). Only *critical* alerts check `attention`. So acknowledging a warning alert today does not clear the sidebar dot, the reason, the desk card or the desk look.
2. **The server page ignores ack, mute and suppression.** The page's notices are built in the client (`whombat-app packages/client/src/hosts/dashboard.ts:1323 lookPanel`), and the "N to look at" badge comes from `:326 lookCount`. Both list or count every open alert, acknowledged or not. The client gets the alerts and hints from `hosts/map.ts:740-748`.
3. **The hub has no per-rule, per-entity or threshold settings at all.**
   - The only real "stop" that exists is per user-defined check: `PATCH /api/v1/checks/{id} {enabled:false}`.
   - Maintenance covers a whole server, a group, or everything. It does not touch status.
   - The alert JSON carries no `entity` or `key`, so Whombat cannot tell `fs:/` from `fs:/mnt/data`.
4. **The generic connection notices don't decide the dot.**
   - The health pass stores a glance whose status comes from the check outcome (`home/health.ts:152-160,187-189`) or from the kind's `seenFromView` of the kind's own notices (`things/kinds/registry.ts:81-98`).
   - Generic `check-*`, `new-tools`, `unread` and the machine `disk` notice are page-only.
   - The Home Assistant, UniFi, Hetzner and Fusebox kinds (`things/kinds/first.ts:63,80,104,115`) compute their glance without notices at all.
   - So "Ignore" cannot be one filter on the stored glance. The glance must carry the notice keys behind its status, and the filter must run when it is read.
5. **No stable notice key exists today, and no "since".**
   - Notice ids are page-local: `reconnect`, `offline`, `disk`, `alert-<id>`, `hint-<kind>-<entity>`.
   - A connection's Watch and Needs you ref is `connection:<id>` for every kind of breakdown. `home/snoozes.ts:47-52` says exactly that, which is why acknowledging is capped at a week.
   - The glance keeps no transition time, so an "episode" can't be told apart yet.
6. **"Ignore" already means something else.**
   - Needs you's Ignore (`home/snoozes.ts:93-128`, `needsYou.ignore`) is *per person, forever*.
   - Needs you's alert "Remind me tomorrow" is a per-person snooze (`hosts/sources.ts:98`). The phone's and web's Watch snooze, and `WatchNotices`' "Remind me tomorrow", are the hub's *shared* ack with minutes.
   - The new shared "Ignore until it changes" must replace or rename the old one.

---

## 1. Proposed key and nature scheme

**Notice key:** `<check>:<subject>[#<episode>]`, at most 200 characters, so it fits `HomeRef.id`.

| Part | What it is | Examples |
|---|---|---|
| `check` | a stable check id; it is also the switch in "What Whombat watches" | `conn.answers`, `conn.signin`, `machine.disk`, `device.answers`, `host.disk.space_high`, `host.hint.system.updates` |
| `subject` | the thing, plus its part when there is one | `connection:<id>`, `device:<connId>`, `server:<id>`, `server:<id>/fs:/mnt/data`, `server:<id>/pve:101`, `check:<id>`, `machine:<server or guest id>` |
| `episode` | only where the subject id alone can't tell a recurrence apart | the hub alert id, the transition time from the health pass, a band (`90`), a hash of a list |

**Nature:** add `nature: 'problem' | 'you' | 'fyi'` beside `tone` on `ThingPageNotice`, `NeedsYouItem`, `WatchItem` and `DeskLook`.

**"Until it changes":** the quiet lifts when either of these happens:
- (a) the notice is absent on a pass where its subject was evaluated and online;
- (b) its episode or tone gets worse.

**Where ignores are kept:** one shared table per Whombat:
- `quiet_notices(burrow_id, key, check, subject, mode: until_change | until | off, until, episode, tone, by, at)`
- a "What Whombat watches" table: `watch_settings(burrow_id, subject, check, off, exceptions[])`

Hub alerts map onto the hub's own ack where it fits (see C.6).

---

## A. Generic notices for every connection

### A.1 How status, reason and glance are made today

- **The health pass** (`home/health.ts:220-249`, every 5 min, 50 per pass, 4 at a time) runs `checkConnectionHealth` (`:131-217`):
  - The check is refused: `confirmRefusedCredential` makes it `needs_reauth`, and the glance becomes `bad` "Needs to be connected again" (`:152-154`).
  - No HTTP status: glance `offline` "Couldn’t reach it" (`:157-158`). A thrown error is also `offline`, or `bad` for a `ConnectionAuthError` (`:187-189`).
  - An HTTP error: glance `warn` "It answered with an error" (`:159`).
  - OK: the kind's `seen()` (`:164-184`). The status and reason come from `seen.glance`. For 18 kinds that is `seenFromView` (`things/kinds/registry.ts:81-98`): the worst notice's tone gives the status, its title the reason. If the reader throws, the status stays `ok` with the old line (`:165-172`).
  - The glance is stored with `glanceAt` and `checkedAt` (`:192-196`). `home.changed {things, watch}` is published only when the glance changed (`:191,198-214`).
  - `glance` is `{status, line, facts, logTop, reason, hostname}` (`home/types.ts:44-54`). It has **no notice keys and no "since"**.
- **The page** (`things/page.ts:258-269`): Worth a look = `view.notices` (the kind's) + the machine's `diskNotice` + `genericNotices`, at most 30.
  - The page status comes from `view.status`, else `connectionStatus(row)` (`:219-225`; `things/panels.ts:70-78`).
- **Things on Home and the sidebar** come from `connectionThing` (`home/overview.ts:336-377`):
  - `needs_reauth` makes the thing `bad` with reason "Needs to be connected again".
  - Otherwise its status is `glance.status` and its reason is `glance.reason`.
  - The sidebar dot is drawn from `ThingSummary.status` and `.reason` (`whombat-app packages/client/src/home/things.ts:122-137`).
- **Watch** (`home/overview.ts:712-748`) lists a connection when it is `needs_reauth`, `bad` or `offline`, always as `bad` and with ref `connection:<id>`.
- **Needs you** (`home/overview.ts:288-316`) shows `needs_reauth` only, to owners for a shared connection or to its own person.
- **Desk looks** come from the same things: `offline` makes `down`, `bad` makes `bad`, `warn` makes `look` (`desk/glance.ts:563-567,596-603`).

### A.2 Catalogue: generic connection notices

The **Dot now** column uses these abbreviations: **S** sidebar dot and reason · **W** Watch · **N** Needs you · **D** desk look · **P** page only.

| # | id (`file:line`) | Condition | Tone | Link now | Dot now | Subject → stable key | Nature (why) | "Until it changes" means | Ignore wording | Watches check | Stop-watching granularity |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `reconnect` `things/panels.ts:210-218` | `row.status = needs_reauth` (a refused check, `connections/refused.ts:16`; a refused token or tool call) | bad | tab Settings "Connect again" | S bad "Needs to be connected again" · W bad · N bad "Reconnect" (owners, or its person) · D bad · **plus a DM** from the assistant (`connections/notify.ts:68-115`, at most 1 per 24 h, posted on the transition, `connections/commands.ts:627`) | connection → `conn.signin:connection:<id>#<reauth time>` (needs a `reauthAt` column; `reauthReason` is too coarse) | **you**: only a person can sign in again; the assistant is refused too | it is connected again (status `active`); breaking again later is a new episode | “Ignore until it’s connected again” | Sign-in | per connection. Stopping should also silence the DM. Agents are still told it is signed out (`runtime/context.ts:528-530` passes the `status` fact) |
| 2 | `offline` `things/panels.ts:219-230` | `glance.status = offline` (no answer or a thrown error at the last check) | bad | ask "Look into it" · “Why can’t Whombat reach X?” | S offline · W bad "X isn’t answering" · D down | connection → `conn.answers:connection:<id>#<offline since>` | **problem**: the assistant can trace DNS, the host or the server it runs on | a check answers again; the next outage is new. Debounce: one failed pass shouldn't make a new episode right after | “Ignore until it answers again” | Whether it answers | per connection |
| 3 | `error` `things/panels.ts:231-242` | `glance.status = warn` and `line = “It answered with an error”` (an HTTP error status, `home/health.ts:159`) | warn | ask "Look into it" · “Why does X answer with an error?” | S warn, reason "It answered with an error" · D look · not in Watch | connection → `conn.answers:connection:<id>#error@<since>` | **problem** | a check answers OK, or goes offline (tone worse, so it shows again) | “Ignore until it answers properly again” | Whether it answers (one switch with #2) | per connection |
| 4 | `check-credential` `things/panels.ts:243-252` | `row.checks[id=credential].state = error`. **Written only at connect or "Check again"** (`connections/connect.ts:547-561`), never by the 5-min pass | warn | tab Settings | P | connection → `conn.check:connection:<id>/credential` | **you**: the person fixes the key or password in Settings | the next stored check of that id is not `error` | “Ignore until the next check” | Sign-in (with #1) | per connection |
| 5 | `check-mcp` same lines | `checks[id=mcp].state = error` ("Its tools server didn’t answer at the last check") | warn | tab Settings | P | `conn.check:connection:<id>/mcp` | **problem**: the assistant can see why the tools server is down | same as #4 | “Ignore until the next check” | Whether it answers | per connection |
| 6 | `check-destination` same lines | `checks[id=destination].state = error` ("Its address isn’t allowed any more") | warn | tab Settings | P | `conn.check:connection:<id>/destination` | **you**: allowed addresses are a person's setting | same as #4 | “Ignore until the next check” | Its address | per connection |
| 7 | `check-tools` same lines | `checks[id=tools].state = error` ("Its tools couldn’t be read at the last check"; a `warning` check is never shown) | warn | tab Settings | P | `conn.check:connection:<id>/tools` | **problem** | same as #4 | “Ignore until the next check” | Its tools | per connection |
| 8 | `new-tools` `things/panels.ts:253-261` | tool rows with `isNew` > 0 | info | tab Settings "Decide" | P | connection → `conn.new_tools:connection:<id>#<hash of new tool names>` | **you**: a person decides what Whombat may use | more new tools arrive (the hash changes), or none are left | “Ignore these new tools” | New tools | per connection |
| 9 | `unread` `things/panels.ts:262-269` | the kind's page read failed (`view.problem`) and the connection is not `needs_reauth` | warn | none | P only. The health pass keeps `ok` when `seen` throws (`home/health.ts:165-172`) | connection → `conn.read:connection:<id>` | **fyi**: transient. When it lasts, #2 or #3 say it with a dot | the next page read works | “Ignore until Whombat can read it again” | Reading its details | per connection |
| 10 | `disk` (≥ 75 % or ≥ 90 %) `things/machine.ts:169-191`, used at `things/page.ts:250-257` | the disk of the machine the connection runs on (`runsOn`) is ≥ 75 % (warn) or ≥ 90 % (bad) | warn / bad | ask "Look into it" · “The disk of M is filling up. What takes the space, and what can go?” | P only: never in the glance. Repeats the server page's `disk.space` / `disk.space_high` for the same disk | **the machine, not the connection** → `machine.disk:machine:<server or guest id>#<band 75 or 90>` | **problem**: the assistant can find what takes the space | the band changes (75 → 90 shows again; below 75 lifts it) | “Ignore until it gets fuller” | Disk space | per machine, **shared** by every connection on it and the server's own page (see Q4) |
| 11 | `disk` (forecast) same lines | below 75 % but full within 60 days at this pace (`forecastFull` of 30-day `disk_pct` points) | warn | ask, same question | P | `machine.disk_forecast:machine:<id>#<weeks band>` | **fyi**: a forecast | the forecast moves into a nearer band (60 → 30 → 7 days) or goes away | “Ignore this forecast” | Disk space (forecasts) | per machine |

Not notices, but they colour things:
- The Status figure (`things/panels.ts:102-123`) and the page badge (`BADGE`, `:60-67`) state facts. Propose they stay truthful while a notice is ignored, perhaps with "· ignored".
- The Disk figure's amber or red tone (`things/machine.ts:72-81`) is also a fact.

### A.3 Google, Microsoft, Email (IMAP)

These are builtin catalog entries with no page. `findThing` refuses builtins (`things/page.ts:104`), so they have no Worth a look.

| # | Where | Condition | Shows as now | Subject → key | Nature | Until it changes | Ignore wording | Watches check |
|---|---|---|---|---|---|---|---|---|
| 12 | Mail thing `home/mail-glance.ts:103-109` | a Google or IMAP connection with mail that is not `active` (`needs_reauth`) | thing `bad`, line "Needs to be connected again" or "Needs a new password", **no `reason`** (so the desk look says "I don’t know why yet.") · S · D bad. **Not** in Watch or Needs you (those read only `catalog_connections`, `home/overview.ts:266-291`). DM repair message: Google `guides/service.ts:368-400` (`repairText`, `guides/copy.ts:310`), IMAP `IMAP_REPAIR_TEXT`, at most 1 per 24 h | connector connection → `conn.signin:connection:<connectorId>#<reauth time>` | **you** | it is reconnected | “Ignore until it’s connected again” | Sign-in |
| 13 | Mail thing `home/mail-glance.ts:113-114` | the unread count failed (`problem: true`, kept in memory) | thing `warn`, no reason · S · D look | `mail.count:connection:<id>` | **fyi**: transient, nothing to fix | a count works | “Ignore until it can count again” | Counting unread mail |
| 14 | Settings → Connections checks `connectors/checks.ts:62-71` (Google; Microsoft has its own) | service state `api_disabled` (comes with `enableUrl`) | Settings row only | `conn.service:connection:<id>/<service>` | **you**: turn the API on in Google | the next check isn't `api_disabled` | “Ignore until the next check” | That service (Mail, Calendar …) |
| 15 | same | `no_scope` | Settings row only | same | **you**: grant access | same | same | same |
| 16 | same | `error` (message) | Settings row only | same | **problem** | same | same | same |

Microsoft has no Home thing (it is not counted; `home/mail-glance.ts:6-7`).

The agent side is never filtered: `connectors/access.ts:115-116,170-208` refuses the agent in words while `needs_reauth`.

### A.4 Generic counts

| Section | problem | you | fyi |
|---|---|---|---|
| Generic connection notices (A.2) | 5 | 4 | 2 |
| Connectors (A.3) | 1 | 3 | 1 |

---

## B. Devices

- **The reader:** every 5 min (`devices/home.ts:223-257`), not the connection health pass, since `device` is a builtin catalog entry.
- **Status** (`devices/home.ts:85-88`, `things/devices.ts:172-174`): `lastReadError` makes it `offline`; a reading within 15 min makes it `ok`; otherwise `unknown`. Learning makes it `learning`.

| # | id (`file:line`) | Condition | Tone | Link now | Dot now | Subject → key | Nature | Until it changes | Ignore wording | Watches check | Stop granularity |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 17 | `not-answering` `things/devices.ts:183-191` | `skill.lastReadError` | **warn** (yet the thing is `offline`) | ask "Look into it" · “Why isn’t X answering?” | S offline, **no `reason`** (only `line: Not answering`, `devices/home.ts:90-91`) · W **warn** "X isn’t answering" (`devices/home.ts:184-205`, ref `device:<connId>`) · D **down**. Badge "Not answering" | device → `device.answers:device:<connId>#<since>` (needs a `lastReadErrorAt`; `updatedAt` is used now) | **problem** | a reading works again | “Ignore until it answers again” | Whether it answers | per device |
| 18 | `unread` `things/devices.ts:192-200` | some readings came back `null` | info | none | P | device → `device.readings:device:<connId>#<sorted failed keys>` | **fyi** | the set of failed readings grows, or all read again | “Ignore until another reading fails” | Readings it can’t read | per device, or per reading as the exception |
| 19 | Learning: Needs you `device_skill` `devices/home.ts:140-178`; learning page `things/devices.ts:283-336` | a proposed skill waiting for a choice | info | "Choose", opening the proposal's thread | N (managers only) · thing `learning`, no dot, never a desk look | `device_skill:<skillId>` (existing HomeRef) | **you**: a decision, not watching | (not a watch; the per-person Not now and Ignore stay) | (not a quiet notice) | none | none |

**Device counts:** problem 1 · you 1 · fyi 1.

**Inconsistencies to settle:** for a device that doesn't answer, the notice is `warn`, Watch is `warn`, and the thing and desk say `offline`/`down`. The thing also has no `reason`, so the desk's look reads "I don’t know why yet." Propose: tone `bad` and reason "Not answering".

---

## C. Servers

### C.1 How server pages get their notices

- **The runtime** maps the hub's detail in `toHostServerDetail` (`hosts/map.ts:698-760`):
  - `banner` (`:730-737`, the hub's banner for attention alerts only)
  - `hints` (`:740-746`, plus Whombat's own agent-update hints from `hosts/agent-updates.ts:196-240`)
  - `alerts` (`:747`, every open alert of the server)
  - It is served at `hosts/routes.ts:1021`.
  - **It drops** the banner's `rule` and `alert_id` and the hint's `guests`.
- **The client builds the page** (`whombat-app packages/client/src/hosts/dashboard.ts`):
  - **`bannerPanel`** (`:560-580`), "Right now":
    - id `banner`; tone `bad` for critical, else `warn`
    - link `askLink` (`:544`): "Look into it" · “<title>. Can you look into it?”
    - It finds its alert by title, else by severity and section. That match is fragile because the contract has no `alert_id`.
  - **`lookPanel`** (`:1323-1380`), "Worth a look":
    - Open alerts other than the banner's: id `alert-<alertId>`, tone `bad`/`warn`, ask link.
    - Hints: id `hint-<kind>-<entity>`, tone `warn`/`info`, link from `hintLink` (`:1287`).
    - Unraid notes: `unraid-notes`, info, a link to System.
    - **No ack, mute or suppression filter.**
  - **`lookCount`** (`:326`) counts every open alert plus every warning hint, giving the head's "N to look at" (`:333-344`).
  - **`noticeIcon`** (`:1231-1250`) uses regexes over the rule or kind.
- **Elsewhere in the runtime:**
  - Watch (`hosts/sources.ts:343-387`) lists every open alert with its ack/snooze state, Whombat's agent-update items (`hosts/agent-updates.ts:242`), and every hint (ref `hint:<server>:<kind>:<entity>`, `:243-264`).
  - Needs you (`:294-334`) shows critical attention alerts, the address change (`hosts/address.ts:96-119`) and pending enrollments.
  - Things (`:56-83`): status from `serverStatus` (`hosts/map.ts:156-174`), reason from the hub's `status_note`.
- **Server-level hint wording:** `GUEST_HINTS` and `HOST_HINTS` (`hosts/sources.ts:140-188`).

### C.2 Behaviour shared by every alert rule

- **Evaluation** (`hosts/internal/rules/engine.go`):
  - A condition must hold for `For` before the alert opens (`:147-153`).
  - It resolves after `ClearAfter` without the condition (`:208-227`); the default is 10 min (`alerts.go:41`).
  - There is one open alert per `server_id` + `key = rule + ":" + entity` (`hub/store/schema.go:114`).
  - The instance id is `al_` + 12 random hex characters, new on every opening (`:82`).
- **Critical vs warning:**
  - A critical alert hides the warning with the same `ruleprefix|entity` (`:154-177`).
  - Escalating to a different rule (temp_high → temp_critical, wear_high → wear_critical, smart_errors → smart_failing) opens a **new** alert with no ack.
- **Severity changes within one rule** (`ups.on_battery`, `ceph.health`) **keep the ack** and publish no event (`:187-193`, `hub/ingest.go:254-258`).
- **Dot now, for every rule:**
  - The hub status is `warning` while *any* alert is open, acknowledged or not.
  - `serverStatus` returns `bad` only for a critical **attention** alert. Otherwise it is `warn` (`hosts/map.ts:163-173`).
  - Needs you shows only critical attention alerts. Watch shows every open alert. The desk look comes from the card's state and the hub's note.
- **Link now, for every rule:** "Look into it" (ask).

### C.3 Catalogue: hub alert rules (29)

- **Key** = `host.<rule>:server:<id>/<entity>#<alertId>`. Today the alert JSON has no entity; see C.6.
- **"Until it changes"** = this alert id resolves, *or* its severity rises (proposed; today the hub keeps the ack).

| # | Rule (where) | Subject / entity | Condition (default, all constants) | Sev → tone | Nature (why) | Ignore wording | Watches check | Stop granularity (exception) |
|---|---|---|---|---|---|---|---|---|
| 20 | `agent.heartbeat_missing` (`rules/alerts.go:13,263-287`; `hub/jobs.go:176-190`) | server `host` | no frame for ≥ 60 s | critical → bad | **problem**: the assistant can check power through the parent or the network | “Ignore until it’s back online” | Whether it’s online | per server |
| 21 | `sensor.temp_high` (`alerts.go:108`) | sensor id | ≥ 85 % of the sensor's limit for 10 min | warning → warn | **problem**: the assistant can see what runs hot | “Ignore until it cools down” | Temperature | per server, with a sensor exception |
| 22 | `sensor.temp_critical` (`alerts.go:118`) | sensor id | ≥ limit for 5 min | critical → bad | **problem** | “Ignore until it cools down” | Temperature | per server, with a sensor exception |
| 23 | `disk.wear_high` (`alerts.go:144,152`) | device | SSD wear 75–89 % | warning → warn | **you**: replacing a disk is a person's job | “Ignore until it wears further” | Disk health | per server, with a disk exception |
| 24 | `disk.wear_critical` (`alerts.go:146,152`) | device | wear ≥ 90 % | critical → bad | **you** | “Ignore until it wears further” | Disk health | per server, with a disk exception |
| 25 | `disk.space_high` (`alerts.go:170`) | `fs:<mount>`, `pool:<n>`, `storage:<id>` | ≥ 90 % for 1 min | warning → warn | **problem**: the assistant can make room | “Ignore until there’s room again” | Disk space | per server, with a mount/pool exception |
| 26 | `hypervisor.overcommit` (`alerts.go:187`) | `host` | running vCPUs ÷ threads > 1.5 for 30 min | warning → warn | **fyi**: a sizing heads-up, often deliberate | “Ignore until it changes” | CPU and memory sizing | per server |
| 27 | `hypervisor.memory_assigned` (`alerts.go:203`) | `host` | VM memory assigned ≥ 90 % of RAM | warning → warn | **fyi** | “Ignore until it changes” | CPU and memory sizing | per server |
| 28 | `disk.smart_failing` (`rules/health.go:152`) | device | SMART failed, NVMe critical_warning, or spare below threshold | critical → bad | **you**: back up and replace | “Ignore until it changes” | Disk health | per server, with a disk exception |
| 29 | `disk.smart_errors` (`health.go:155`) | device | pending, uncorrectable or media errors, or a failed self-test | warning → warn | **problem**: the assistant can run a test and read the counters | “Ignore until it gets worse” | Disk health | per server, with a disk exception |
| 30 | `pool.degraded` (`health.go:170`) | `pool:<n>` | ZFS health ≠ ONLINE | critical → bad | **you**: a disk must be swapped | “Ignore until it changes” | Pools and RAID | per server, with a pool exception |
| 31 | `pool.errors` (`health.go:180`) | `pool:<n>` | read, write, checksum or scrub errors | warning → warn | **problem**: scrub, clear, read the log | “Ignore until it gets worse” | Pools and RAID | per server, with a pool exception |
| 32 | `raid.degraded` (`health.go:207`) | `raid:<n>` | degraded, failed or inactive | critical → bad | **you** | “Ignore until it changes” | Pools and RAID | per server, with an array exception |
| 33 | `fs.read_only` (`health.go:215`) | `fs:<mount>` | remounted read-only | critical → bad | **problem** | “Ignore until it’s writable again” | Disk health | per server, with a mount exception |
| 34 | `fs.inodes_high` (`health.go:222`) | `fs:<mount>` | inodes ≥ 90 % | warning → warn | **problem** | “Ignore until there’s room again” | Disk space | per server, with a mount exception |
| 35 | `pve.quorum_lost` (`health.go:233`) | `cluster:<n>` | not quorate | critical → bad | **problem** | “Ignore until the cluster is whole again” | Cluster | per server |
| 36 | `backup.failed` (`health.go:240`) | `vzdump` | the last vzdump job errored | warning → warn | **problem**: read the log, run it again | “Ignore until the next backup” | Backups | per server |
| 37 | `pve.replication_failed` (`health.go:255`) | `repl:<id>` | error or fail count > 0 | warning → warn | **problem** | “Ignore until it works again” | Backups and replication | per server, with a job exception |
| 38 | `ceph.health` (`health.go:267`) | `ceph` | HEALTH_WARN gives warn, HEALTH_ERR gives bad, for 5 min | warn/bad | **problem** | “Ignore until it gets worse” (needs the severity episode) | Cluster | per server |
| 39 | `time.unsynced` (`health.go:278`) | `host` | clock not synced for 30 min | warning → warn | **problem**: the assistant can fix NTP | “Ignore until it’s in sync again” | Clock | per server |
| 40 | `ups.on_battery` (`health.go:294-300`) | `ups:<n>` | on battery 30 s gives warn; low battery gives bad | warn/bad | **you**: the power is out, a person acts | “Ignore until the power is back” | Power (UPS) | per server, with a UPS exception |
| 41 | `net.link_down` (`health.go:310,322`) | `net:<iface>` | a wired interface with an address and no carrier, or a bond member down, for 2 min | warning → warn | **problem** (often an unused NIC, so exceptions matter) | “Ignore until the link is back” | Network links | per server, **with an interface exception** |
| 42 | `sensor.fan_failed` (`health.go:331`) | `fan:<src>` | rpm below the minimum for 2 min | warning → warn | **you**: hardware | “Ignore until it spins again” | Fans | per server, with a fan exception |
| 43 | `host.oom` (`health.go:461`) | `host` | ≥ 1 OOM kill in the last hour | warning → warn | **problem** | “Ignore until it happens again” | Out of memory | per server |
| 44 | `guest.restart_loop` (`health.go:480`) | `<platform>/<guestId>` (slash; the hub's guest ids use `:`) | ≥ 3 restarts in 15 min | warning → warn | **problem** | “Ignore until it happens again” | Guests | per server, with a guest exception |
| 45 | `disk.full_soon` (`health.go:672-683`) | volume | linear forecast says full in < 7 days | warning → warn | **problem** (urgent despite being a forecast; see Q5) | “Ignore until it gets fuller” | Disk space | per server, with a volume exception |
| 46 | `check.down` (`hub/checks.go:29,276`) | `check:<id>` (server "") | the probe failed twice, a heartbeat is overdue, `/fail`, or a non-zero exit | critical → bad | **problem** | “Ignore until it’s up again” | that check (Settings → Checks) | per check: **`PATCH /checks/{id} {enabled:false}` exists** |
| 47 | `check.cert_expiring` (`checks.go:30,291`) | `check:<id>` | certificate expires within `cert_warn_days` (default 14, settable per check) | warning → warn | **problem**: why didn't renewal run? | “Ignore until it’s renewed” | that check | per check (enabled, or `cert_warn_days`) |
| 48 | `security.denied_requests` (`hub/api_alerts.go:211,224`) | `user:<n>` (server "") | ≥ 20 refused console or power requests in 10 min | warning → warn | **you**: a person judges whether it was them | “Ignore until it happens again” | Refused requests | per Whombat, with a user exception |

**Alert counts:** problem 19 · you 8 · fyi 2.

### C.4 Catalogue: hub hints (40) and Whombat's own (2)

**Shared facts about hints:**
- They have **no id and no time**. They are recomputed on every `GET /fleet` and `/servers/{id}` (`hub/model/fleet.go:278-294`).
- They disappear when:
  - the condition clears;
  - an open alert covers the same entity (`rules/hints.go:223`, `model/hints.go:110`);
  - **the server is offline** (`fleet.go:280`). So "until it changes" must only count absence while the server is online.
- **Key:** `host.hint.<kind>:server:<id>/<entity>[#<tone>|#<hash of guests>]`.
- **Dot now:**
  - Hints never colour the sidebar dot or a desk look. Only alerts drive status.
  - They do appear in **Watch**, which feeds Home's `summary.problems` and `worst` (`home/overview.ts:798-803`).
  - Warning hints count in "N to look at".
- **Link now:** `hintLink`, which opens the place where it is fixed.

| # | Kind (`file:line`) | Entity | Tone | Nature | Ignore wording | Watches check |
|---|---|---|---|---|---|---|
| 49 | `sensor.near_limit` (`rules/hints.go:112`) | sensor | info; warn ≥ 85 % | fyi | “Ignore until it gets hotter” | Temperature |
| 50 | `swap.high` (`:130`) | host | info; warn ≥ 90 % | fyi | “Ignore until it gets worse” | CPU and memory sizing |
| 51 | `memory.low` (`:140`) | host | info; warn < 5 % | problem | “Ignore until it gets worse” | Memory |
| 52 | `disk.space` (`:151`) | volume | info (80–89 %) | fyi | “Ignore until it gets fuller” | Disk space |
| 53 | `disk.wear` (`:161`) | device | info (60–74 %) | fyi | “Ignore until it wears further” | Disk health |
| 54 | `collector.error` (`:174`) | collector | warn | problem | “Ignore until it works again” | What the agent reads |
| 55 | `guests.unhealthy` (`:200`) | `docker` (lists the names) | warn | problem | “Ignore until another one fails” (hash of the names) | Guests |
| 56 | `agent.outdated` (`:213`) | host | info | fyi | “Ignore until a newer version” | Updates |
| 57 | `system.failed_units` (`health.go:708`) | host | warn | problem | “Ignore until another one fails” | System services |
| 58 | `system.updates` (`:718`) | host | info | fyi | “Ignore until there are more” | Updates |
| 59 | `system.reboot` (`:722`) | host | info | you | “Ignore until the next restart” | Updates |
| 60 | `cpu.steal` (`:727`) | host | info | fyi | “Ignore until it changes” | CPU and memory sizing |
| 61 | `disk.counters` (`:742`) | device | info | fyi | “Ignore until it gets worse” | Disk health |
| 62 | `pool.scrub` (`:752,755`) | `pool:<n>` | info | fyi | “Ignore until the next scrub” | Pools and RAID |
| 63 | `raid.sync` (`:766`) | `raid:<n>` | info | fyi | “Ignore until it’s done” | Pools and RAID |
| 64 | `backup.warning` (`:772`) | `vzdump` | info | fyi | “Ignore until the next backup” | Backups |
| 65 | `platform.warnings` (`:787`) | `docker` / `libvirt` | info | fyi | “Ignore until it changes” | System services |
| 66 | `docker.image_updates` (`:802`) | `docker` | info | fyi | “Ignore until there are more” | Updates |
| 67 | `disk.forecast` (`:821`) | volume | info (< 30 days) | fyi | “Ignore this forecast” | Disk space |
| 68 | `memory.limit` (`:544,552`) | guest `pf:id` / host | info | fyi | “Ignore until it happens again” | Memory |
| 69 | `incus.no_snapshots` (`rules/incus.go:72`) | `incus` (+ guests) | info | you | “Ignore until another guest has none” | Backups |
| 70 | `incus.pool_full` (`incus.go:88`) | `incus-pool:<n>` | info; warn ≥ 95 % | fyi (problem at warn) | “Ignore until it gets fuller” | Disk space |
| 71 | `incus.warning` (`incus.go:102`) | `incus` | info | fyi | “Ignore until it changes” | System services |
| 72 | `libvirt.pool_full` (`rules/libvirt.go:54`) | `libvirt-pool:<n>` | info; warn ≥ 95 % | fyi (problem at warn) | “Ignore until it gets fuller” | Disk space |
| 73 | `libvirt.no_backup` (`libvirt.go:80`) | `libvirt` or `libvirt:<id>` (**the entity changes with the count**) | info | you | “Ignore until another guest has none” | Backups |
| 74 | `unraid.array_stopped` (`rules/unraid.go:53,56`) | `raid:unraid` | warn | you | “Ignore until it’s started” | Pools and RAID |
| 75 | `unraid.parity_errors` (`:61`) | `raid:unraid` | warn | you | “Ignore until the next parity check” | Pools and RAID |
| 76 | `unraid.parity_old` (`:78,81`) | `raid:unraid` | info | fyi | “Ignore until the next parity check” | Pools and RAID |
| 77 | `unraid.disk_errors` (`:102`) | `raid:unraid` | warn | problem | “Ignore until it gets worse” | Disk health |
| 78 | `unraid.pool_full` (`:113`) | `pool:<n>` | warn | problem | “Ignore until it gets fuller” | Disk space |
| 79 | `unraid.plugin_updates` (`:124`) | `unraid` | info | fyi | “Ignore until there are more” | Updates |
| 80 | `unraid.notification` (`:142`) | notification id | info; warn for "alert" | fyi (you at warn) | “Ignore this note” | Unraid notes |
| 81 | `docker.update_available` (`:158`) | `docker` | info | fyi | “Ignore until there are more” | Updates |
| 82 | `unraid.os_update` (`:163`) | `unraid` | info | fyi | “Ignore until a newer version” | Updates |
| 83 | `guest.backup_old` (`hub/model/hints.go:83`) | `pve` (lists guests) | warn | problem | “Ignore until the next backup” | Backups |
| 84 | `guest.no_backup_job` (`:84`) | `pve` | info | you | “Ignore until another guest has none” | Backups |
| 85 | `guest.agent_down` (`:85`) | `pve` | info | fyi | “Ignore until it changes” | Guests |
| 86 | `guest.pending_changes` (`:87,89`) | `pve` | info | you | “Ignore until it changes” | Guests |
| 87 | `guest.snapshot_old` (`:91`) | `pve` | info | fyi | “Ignore until it changes” | Backups |
| 88 | `storage.overcommit` (`:100`) | `storage:<id>` | info | fyi | “Ignore until it changes” | Disk space |
| 89 | Whombat `agent.update_failed` (`hosts/agent-updates.ts:196-205`; Watch `:242-260`) | host (`…:agent`) | warn | you ("Try again on the System tab") | “Ignore until the next update” | Updates |
| 90 | Whombat `agent.needs_install` (`hosts/agent-updates.ts:207-222`) | host | warn | you | “Ignore until it’s installed” | Updates |

**Stop granularity for hints:** per server and check. The exception is the hint's entity: the guest for the folded guest hints, which would need the hub's `guests[]` that `toHostHint` drops (`hosts/map.ts:401-412`).

**Hint counts:**

| Group | problem | you | fyi |
|---|---|---|---|
| Hub hints (40) | 7 | 7 | 26 |
| Whombat's own (2) | 0 | 2 | 0 |

### C.5 Other server items

| # | Item (where) | Shows as now | Key | Nature |
|---|---|---|---|---|
| 91 | Unraid notes line `unraid-notes` (`dashboard.ts:1356-1370`) | info, page only | `host.unraid_notes:server:<id>#<newest id>` | fyi |
| 92 | "Right now" banner (`dashboard.ts:560-580`) | a duplicate of the top attention alert | **must share its alert's key** (needs the banner's `alert_id`, which `hosts/map.ts:730-737` drops) | as its alert |
| 93 | Desk heat override (`desk/glance.ts:142-151`) | a fine server card turns warn/bad when its sensor is warm or hot, with no alert. A desk-only notice | should follow `sensor.near_limit` / `temp_*` quiet | fyi |
| 94 | Address change (`hosts/address.ts:96-119`), Needs you (owners) | warn, "Point it here" | `hosts.address:<changedAt>` | you |
| 95 | Pending enrollment (`hosts/sources.ts:309-331`), Needs you (owners) | info, "Review" | `hosts.enrollment:<id>` | you (a decision, not a watch) |

**Counts for C.5** (the banner is not counted): you 2 · fyi 2.

### C.6 Ack, snooze, maintenance and parent suppression today, and how they map

**What exists in the hub:**
- **Ack and snooze** are per alert instance and shared:
  - `POST /api/v1/alerts/{id}/ack {note?, minutes 0..43200}` (`hub/api_alerts.go:136-159`). `minutes: 0` means until resolved. It needs operator; Whombat signs as operator (`hosts/routes.ts:185-230`).
  - `DELETE` removes it.
  - Stored in `alerts.ack_*` (`hub/store/schema.go:235-241`).
  - Effect: `attention:false`, so no notification and no banner. The alert **stays open and listed, and the server status stays `warning`**.
  - When it lapses: a snooze lapses after 30 s checks. Resolving ends it, and a recurrence gets a new id. A same-rule severity change keeps the ack.
- **Maintenance:**
  - `POST /api/v1/maintenance {scope: server|group|all, target, …}`, one-off up to 366 days or weekly windows (`api_alerts.go:206-231`; `hub/maintenance.go`).
  - Effect: `muted:true` and `attention:false`. **No guest or rule scope.** Hub-level alerts (checks, security) are never muted, and the status stays `warning`.
  - Whombat has routes for it (`hosts/routes.ts:1446-1501`) but no UI.
- **Parent suppression:** while the parent server is offline, the child's alerts get `suppressed_by` and `attention:false` (`whombat-hosts hub.go:516-547`, `fleet.go:262-264`). It is server-to-server only.
- **Checks:** `PATCH /checks/{id} {enabled:false}` pauses a check. `check.down` resolves within about 5 s; `cert_expiring` stays up to 1 h.
- **Host side:** `agent.toml [collectors]` can turn off whole collectors.

**Mapping:**

| Whombat action | Alerts | Hints | Checks |
|---|---|---|---|
| **Ignore** (until it changes) | hub ack `minutes: 0`, an exact match (a recurrence is a new id). Gap: a same-rule severity rise keeps the ack. Propose the hub clears the ack and publishes `alert.updated` | Whombat's `quiet_notices`, lifted when absent while the server is online, or when tone or guest-hash changes | ack `minutes: 0` on the check's alert |
| **Remind me tomorrow** | hub ack `minutes` until tomorrow 09:00 in the Whombat's zone (`SNOOZE_HOUR`, `home/overview.ts:69`). This already exists in `WatchNotices` and the Watch screen; Needs you uses the personal snooze instead (`hosts/sources.ts:98`), so make it shared | `quiet_notices` with `until` | the same as alerts |
| **Stop watching** | **missing.** Maintenance with server scope is the only stand-in, and it is too coarse and keeps the status | **missing.** Whombat-side `watch_settings` filtering works (hints are read live) | `enabled:false` exists |

**What the hosts service lacks** for this design:
1. `entity` and `key` in the alert JSON (`model.Alert`, `hub/model/types.go:205-221`).
2. Per-(server, rule, entity | `*`) overrides: `off` (filter conditions before `alerts.Evaluate`, `hub/ingest.go:78-132`) and `quiet` (another non-attention reason in `BuildAlertFor`, `hub/model/fleet.go:248-267`), with an event on change.
3. Server status and `status_note` computed from **attention** alerts only. Otherwise every ignored warning keeps the dot amber. An interim fix in Whombat: `hosts/map.ts:163` stops seeding `warn` from the hub status when every open alert of the server is non-attention, and picks the reason from the worst attention alert's title.
4. The banner's `alert_id` and `rule` kept by Whombat (`hosts/map.ts:730-737`).
5. Hint filtering in `BuildHints` (`fleet.go:278`), or Whombat filters them itself.
6. Optional: per-server thresholds. `rules.HostConditions(r)` would need a settings argument; every threshold is a Go constant today (`rules/thresholds.go:37-51`, `alerts.go:30-41`, `health.go:44-56`, `hints.go:53-60`).

---

## D. Desk

**Today:**
- The look is built from things (servers from the cards) by `deskLooks` (`desk/glance.ts:581-609`):
  - `{key: thing id, kind: server | connection | device, name, state: down | bad | look, reason?, server?}`
  - It is defined at `whombat-contracts packages/control-contracts/src/local/desk.ts:637-645`, at most `DESK_LOOKS_MAX = 5`.
  - Its inputs are `things()` and the fleet cards (`buildFullGlance`, `:665-722`), so it inherits every filter applied to things and server status.
- **Console side:**
  - `LookCard` (`appliance/console/ui/src/desk/Sheet.tsx:297-355`): "{assistant} noticed", the kind, the title, the reason (or "I don’t know why yet."), then *Ask {assistant} to fix it*, *Open {name}* (servers only) and *Close*.
  - Wording: `lib/deskCopy.ts:96-110`.
  - Rows and questions: `lib/needsYou.ts:10-62`; the question is “Please take a look at {name}: {reason}.”
  - "Gone" detection by `key` (`desk/Desk.tsx:263-267`) shows "It looks fine again."
  - `fixLook` (`Desk.tsx:562-576`).
- The desk socket has no request for looks. The nearest model is *Not now*: `decide` with `decline` runs `#notNow` and `snoozeNeedsYou` as the paired person (`desk/service.ts:979-986`, `desk/socket.ts:12-17`).

**What a look must carry:**

| Field | Why |
|---|---|
| `notice` (text 200) | the stable key of the notice behind `state` and `reason` (the worst unquieted bad/warn, non-fyi notice of that thing). Ignore targets it; after an Ignore the next notice of the same thing can take its place |
| `nature: problem \| you` | `problem` gives **“Ask {assistant} to look into it”** (`fix` renamed); `you` drops the agent button and shows *Open {name}* or “Open it on your phone” instead. `fyi` notices never make a look |
| `ignore` (optional) | the specific wording (“Ignore until it answers again”), or a fixed **Ignore** button with the long wording as the sheet note |
| `reason` always set | a device that doesn't answer and the mail things carry none today |

**Also needed:**
- A new socket request: `POST /v1/desk/look/ignore {v, notice}` gives `{v}`, with errors 409 locked and 404 gone.
  - The runtime re-checks that the notice is one of this person's current looks, then commits the shared quiet command as the paired person (like `#notNow`).
  - Decide whether locked screens may Ignore. Proposal: unlocked only, like *Ask*.
- A "gone because ignored" state, so the card says “Ignored until it changes.” rather than “It looks fine again.”
- `DeskNeedsYou.looks` should be filtered *before* the cap of 5, so ignored looks don't take the slots.
- `worstOf` (`desk/glance.ts:543-555`) and the server cards' `state` and `note` (`deskServer`, `:114-160`, including the heat override) must use the same quiet filter, or the glance's colour disagrees with the looks.

---

## E. Where one shared filter must hook in

**Principle:** keep the raw truth in storage (the glance and the hub's alerts). Have the health pass add `glance.notices: [{key, check, tone, nature, title, since}]`. Apply `quiet(burrowId)` (one cached read of `quiet_notices` and `watch_settings`) when reading, so un-ignoring takes effect at once and the 5-min pass only has to lift "until it changes" rows whose notice is absent.

| # | Surface | Hook (`file:line`) | What changes |
|---|---|---|---|
| 1 | Page Worth a look, connections | `things/page.ts:258-269` | mark or fold quieted notices (show "Ignored · Undo"), add `key` and `nature` |
| 2 | Page Worth a look, devices | `things/devices.ts:182-200,214-220` | the same |
| 3 | Page Worth a look, servers | runtime `hosts/map.ts:740-748` (mark alerts and hints with `quiet`) **and** client `whombat-app …/hosts/dashboard.ts:1323-1380` (`lookPanel`), `:560-580` (banner), `:326` (`lookCount`) | the client must stop listing and counting quieted (and acked/muted) ones |
| 4 | Dot and reason from the kind's notices | `things/kinds/registry.ts:81-98` `seenFromView`, called in the health pass `home/health.ts:164-184` | the glance status from non-quieted, non-fyi notices only, or store `notices` and recompute when reading |
| 5 | Dot and reason from generic health | `home/health.ts:152-160,187-189` (store raw); **read in** `home/overview.ts:336-377` `connectionThing` | a quieted `conn.answers` or `conn.signin` turns the thing `ok` (with a quiet marker) |
| 6 | Kinds with their own glance | `things/kinds/first.ts:63,80,104,115` (HA, UniFi, Hetzner, Fusebox) | must name the notice key behind their status |
| 7 | Mail things | `home/mail-glance.ts:83-118` | the same filter; add a `reason` |
| 8 | Device things and Watch | `devices/home.ts:65-106` (`thingOf`), `:184-205` (`deviceWatch`) | the same |
| 9 | Server things (sidebar, Home) | `hosts/sources.ts:56-83` `serverThing`; `hosts/map.ts:156-174` `serverStatus` and `:297-298,543-544` `statusNote` | status and reason from attention, non-quieted alerts only |
| 10 | Needs you | `home/overview.ts:288-316` (reconnect), `:597-605` (filter beside the personal marks); `hosts/sources.ts:294-302` (critical alerts) | drop quieted items; keep the personal marks for approvals and questions |
| 11 | Watch, and Home's problems badge | `home/overview.ts:712-748` (connections), `:762-773` (marks), `:798-803` (summary); `hosts/sources.ts:343-387` (alerts, hints, agent items) | quieted items become `state: acknowledged` (or a new `ignored`), out of the badge |
| 12 | Desk | `desk/glance.ts:114-160` (`deskServer` and its heat), `:543-555` (`worstOf`), `:581-609` (`deskLooks`), `:665-722` (`buildFullGlance`) | it mostly inherits through things and status; add `notice` and `nature` |
| 13 | Sidebar | `whombat-app packages/client/src/home/things.ts:122-137` | inherits from `ThingSummary`; nothing to do once the server filters |
| 14 | What the assistant reads | `hosts/tools.ts:703-735` (`alerts_list`), `:228-240` (`servers_overview` counts `openAlerts`), `:241-320` (`server_detail` via `toHostServerDetail`) | **mark, don't hide**: `ignoredBy`, `until`, `watching:false`, so it doesn't reopen what a person ignored but can still answer |
| 15 | Facts that stay | `runtime/context.ts:528-530` (connection `status` given to agents) and `connectors/access.ts:115-208` (refusals) | facts, not alerts: never filtered |
| 16 | Messages | `connections/notify.ts:68-115` (catalog reauth DM), `guides/service.ts:368-400` (Google/IMAP repair) | skip when sign-in is "Stop watching" or ignored |
| 17 | Existing quiet commands | `home/snoozes.ts:18-128` (per person); `home/routes.ts:22-35` (`watch.acknowledge` sends alerts to the hub ack) | Add one shared `quiet_notice` command next to them, which also routes hub alerts to the hub ack. Then retire or rename the per-person Ignore |

**Contracts (whombat-contracts) to change first:**
- `ThingPageNotice` (`packages/core/src/domain/thing-page.ts:255-268`): add `key`, `nature`, `quiet?`.
- `NeedsYouItem` and `WatchItem`: add `nature` and `notice`.
- `ThingSummary`: add `notice` (the key behind `reason`) and `quieted?`.
- `DeskLook`: add `notice`, `nature`, `ignore?`.
- A new request: `DeskLookIgnoreRequest`.
- `HostAlert`: add `entity`, `key`.
- `HostServerDetail.banner`: add `alertId`.
- New: a `things.quiet` command and a "What Whombat watches" read and write.

---

## Counts by nature (this catalogue)

| Group | problem | you | fyi | total |
|---|---|---|---|---|
| A.2 generic connection notices | 5 | 4 | 2 | 11 |
| A.3 Google/Microsoft/IMAP | 1 | 3 | 1 | 5 |
| B devices | 1 | 1 | 1 | 3 |
| C.3 hub alert rules | 19 | 8 | 2 | 29 |
| C.4 hub hints | 7 | 7 | 26 | 40 |
| C.4 Whombat agent-update hints | 0 | 2 | 0 | 2 |
| C.5 other server items (banner not counted) | 0 | 2 | 2 | 4 |
| **Total** | **33** | **27** | **34** | **94** |

Some hints move to **problem** at warning tone: `swap.high`, `incus.pool_full`, `libvirt.pool_full`, and `unraid.notification` (which moves to **you**). Either nature depends on tone, or tone decides what is ignorable at all.

---

## Open design questions

1. **Shared or personal?** Needs you's Ignore is per person and forever today, and some snoozes are per person. Should the shared Ignore replace it for watch items while approvals and questions keep the personal one? Do we need a new name to avoid two different "Ignore"s?
2. **Does Ignore change the page's badge and Status figure?** Proposal: no. Facts stay ("Couldn’t reach it · ignored"); only the dot, Watch, Needs you and the desk go quiet.
3. **What is an episode** for connection outages? It needs a transition time that the health pass stores. How long must something be fine before a recurrence counts as new (a debounce of 1–2 passes)?
4. **One disk, several places.** The same disk shows on every connection running on that machine (`machine.disk`) and on the server page (`disk.space`, `disk.space_high`). One key per physical volume would let one Ignore quiet them all, but needs a mapping from the machine (server or guest) to the hub entity `fs:<mount>`.
5. **Forecasts.** `disk.full_soon` (< 7 days) is urgent and assistant-fixable, while `disk.forecast` (< 30 days) and the machine forecast (< 60 days) are heads-ups. Does the nature follow urgency or the "forecast" label?
6. **Hints and server offline.** The hub drops every hint while a server is offline. Should "until it changes" ignore that gap, or lift?
7. **Where does Stop watching live for servers?** In the hub (true off: no alerts, no ntfy, correct status) or in Whombat (a filter only; the hub's own notifications and status stay)? The status problem argues for the hub.
8. **Thresholds.** "With exceptions" in What Whombat watches covers subjects. Do people also need thresholds (disk at 95 % instead of 90 %)? The hub has none.
9. **Who may quiet?** The hub ack needs operator. Should shared quieting be owners and managers only, or every member? And on the desk, only when unlocked?
10. **Does the assistant hear about ignores?** Proposal: tools mark ignored items so the assistant doesn't bring them up again, and a "Look into it" on an ignored item still works.
11. **Device and mail inconsistencies.** A device that doesn't answer is warn in one place and down in another, and has no reason. Mail things have no reason and no page to "Open". Fix these as part of this work?
12. **The banner's alert match.** It is fragile today (by title) and needs `alert_id` before its Ignore can be trusted.
