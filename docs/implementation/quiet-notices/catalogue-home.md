# Quiet notices: catalogue for the home and first kinds

Scope: `apps/server/src/things/kinds/` — `unifi.ts`, `home/access.ts`, `home/dns.ts` (Pi-hole and AdGuard Home), `home/esphome.ts`,
`home/protect.ts` (+ `protect-events.ts`), `home/ha-controls.ts`, `homeassistant.ts` (+ `ha-socket.ts`, `homeassistant-restart.ts`),
`hetzner.ts`, `fusebox.ts` + `fusebox-pool.ts`. Read at `main` 06e42934 (2026-10-22).

Columns:
- **Id now**: the notice `id` and where it is built. *static* = one fixed id for the check; *per item* = the id carries an item id.
  *groups* = one line stands for several items.
- **Dot now**: whether it colours the sidebar dot / card reason (the 5-minute glance) and the page's status badge today.
- **Subject**: what the notice is about and the stable id the snapshot already has for it.
- **Lifts when / episode**: what “Ignore (until it changes)” waits for, and the episode part of the key, if any.
- Key proposal everywhere: `<check>:<subject id>[:<episode>]`. Never the title: most titles carry ages, counts, clock times or
  percentages that change on every pass (“since 14:02”, “last updated 9 days ago”, “Traffic is at 83 %”).

Notice that the 5-minute health pass (`home/health.ts` `checkConnectionHealth` → registry `seen`) stores only a glance (status,
reason, facts); the desk's looks (`desk/glance.ts` `deskLooks`) come from that glance, one per connection.

---

## UniFi Network (`unifi.ts`, catalog `unifi_network`)

| Id now | Condition | Tone now | Link now | Dot now | Subject (stable id) | Nature + why | Lifts when / episode | Ignore wording | Check; Stop watching | Noise notes |
|---|---|---|---|---|---|---|---|---|---|---|
| `gateway-offline` `unifi.ts:297` — static | A device with the gateway feature (or a gateway model) is `OFFLINE` or `CONNECTION_INTERRUPTED` | bad | ask “Look into it” | Yes: glance `bad`, reason “The gateway is offline”; page badge | The gateway — `UnifiDevice.id` (UniFi device UUID) | **problem** — the network is down; the assistant can look | Gateway back `ONLINE`; no episode | “Ignore until it’s back online” | “The gateway going offline”; per check only (there is one gateway) | Only reachable when the controller is not on the gateway itself (a UDM that is down fails the whole check as “Couldn’t reach it”). |
| `offline` `unifi.ts:307` — static, **groups** (“2 access points offline”, names in detail) | Non-gateway devices `OFFLINE` / `CONNECTION_INTERRUPTED` | warn | ask “Look into it” | Yes: glance `warn`, reason from `unifiBadge` (“1 access point offline”); page badge | Each device — `UnifiDevice.id` | **problem** — equipment dropped off; the assistant can look | That device back `ONLINE` (per item); no episode | “Ignore until it’s back online” (grouped: “Ignore until they’re back online”) | “Devices going offline”; **per device** (a switch at a holiday home, an AP taken down) | `CONNECTION_INTERRUPTED` and the reboot after a firmware update are counted offline: one 5-minute sample can catch a reboot. Require two passes in a row. |
| `gateway-busy` `unifi.ts:323` — static | Gateway CPU ≥ 80 % in **one** sample | warn | ask “Look into it” | No (glance ignores it); page figure tone only | The gateway — `UnifiGateway.id` | **fyi** (→ problem only when sustained) — a single spike is normal (IDS/IPS, speed tests) | CPU below 80 %; no episode | “Ignore until it calms down” | “A busy gateway”; per check only | Single sample, too eager. Use the stored `gw_cpu` points: average ≥ 80 % over 30 min before it counts. Today the page says warn while the dot stays green: inconsistent. |
| `firmware` `unifi.ts:332` — static, **groups** (names in detail) | Devices with `firmwareUpdatable` | info | none | No | Each device — `UnifiDevice.id` | **fyi** — UniFi updates on its own schedule; nothing is wrong | That device no longer updatable; episode = the device's current `firmware` (a later release re-shows) | “Ignore until the next firmware” | “Firmware updates”; per device or per check | Already info. |

**Status computed outside notices:** yes. The glance is `unifiGlanceOf` (`unifi.ts:191`): `bad` when a gateway is offline, `warn` when
any device is offline, reason `unifiBadge` (`unifi.ts:225`); the page badge is `unifiBadge` again (`unifi.ts:582`). Notices are **not**
computed in the health pass (`first.ts:80`); the filter must be applied to `unifiGlanceOf`/`unifiBadge` (filter the offline device list
by quieted keys) or the glance must be rebuilt from filtered notices.

---

## UniFi Access (`home/access.ts`, catalog `unifi_access`)

| Id now | Condition | Tone now | Link now | Dot now | Subject (stable id) | Nature + why | Lifts when / episode | Ignore wording | Check; Stop watching | Noise notes |
|---|---|---|---|---|---|---|---|---|---|---|
| `open-<doorId>` `home/access.ts:401` — per item | Door sensor `open` for > 5 min (`OPEN_TOO_LONG_MS`, `:38`), since kept in memory (`openSinceOf`, `:288`) | warn | none (the door row has Unlock / Back to schedule) | Yes: glance `warn` via `seenFromView`; page badge “Needs a look” | The door — `AccessDoor.id` | **you** — only a person can close a door | Door sensor reads closed; no episode needed (each opening is a new run because the key lifts on close) | “Ignore until it’s closed” | “Doors left open”; **per door** (a door propped open in office hours, a gate) | 5 min equals the pass interval: the second pass after opening already alerts. Suggest 10–15 min. “Open since” lives in process memory: resets on restart (persist first-seen with the quiet state). |
| `readers-offline` `home/access.ts:411` — static, **groups** (one name in title, or “3 readers offline” + names) | Any device with `online === false` | warn | ask “Look into it” | Yes: glance `warn`; page badge | Each device — `AccessDevice.id` | **problem** — hardware dropped off; the assistant can look | That device online again; no episode | “Ignore until it’s back online” | “Readers going offline”; **per reader** | The online flag is undocumented in `/devices` (read “if present”, `:108`): may be missing or wrong across versions. Hubs (`UAH*`) are counted too although the words say readers. |
| `held-<doorId>` `home/access.ts:427` — per item | Lock rule `keep_unlock` | warn | none (row has **Back to schedule**, confirmed) | Yes: glance `warn`; page badge | The door — `AccessDoor.id` | **you** — someone chose to keep it unlocked; going back is a person's decision | Rule no longer `keep_unlock`; no episode | “Ignore until it’s back on schedule” | “Doors kept unlocked”; **per door** | Often deliberate (an event, opening hours). `custom` (“unlocked until a time”) is not a notice: consistent, it ends by itself. The “place” for this *you* notice is the row button, not a URL. |

**Status computed outside notices:** no. Glance = `seenFromView` of `accessNotices` (`:597`); page badge “Needs a look” whenever there
is any notice (`:561`). Filtering notices before both is enough.

---

## Pi-hole and AdGuard Home (`home/dns.ts`, catalogs `pihole`, `adguard`)

| Id now | Condition | Tone now | Link now | Dot now | Subject (stable id) | Nature + why | Lifts when / episode | Ignore wording | Check; Stop watching | Noise notes |
|---|---|---|---|---|---|---|---|---|---|---|
| `not-running` `home/dns.ts:514` — static | AdGuard `status.running === false` | bad | ask “Look into it” | Yes: glance `bad`; page badge “Not running” | Whole service | **problem** — name lookups fail; the assistant can look | Running again | “Ignore until it’s running again” | “DNS stopping”; per check only | AdGuard only (Pi-hole never sets it). |
| `blocking-off` `home/dns.ts:524` — static | Blocking (Pi-hole) / protection (AdGuard) off; timed pause → warn, off for good → bad | warn / bad | none (head has **Resume**) | Yes: glance warn/bad; page badge “Paused” / “Blocking off” | Whole service | **you** when off for good (turning it back on is a person's decision) · **fyi** for a timed pause (someone pressed Pause; it ends by itself) | Blocking on again; episode for a pause = its `until` | “Ignore until blocking is back on” | “Blocking switched off”; per check only | A 5- or 30-minute pause pressed on Whombat's own page turns the dot yellow and reaches the desk today: should be fyi. |
| `filtering-off` `home/dns.ts:533` — static | AdGuard filtering disabled as a whole | warn | none | Yes: glance `warn`; page badge no | Whole service | **you** — someone switched it off in AdGuard | Filtering enabled | “Ignore until the lists are back on” | “Block lists switched off”; per check only | — |
| `lists-failed` `home/dns.ts:542` — static, **groups** (names in detail) | Enabled lists whose last download failed (Pi-hole status 3 kept old copy, 4 nothing kept) | warn | none (head has **Update lists**) | Yes: glance `warn`; page badge no | Each list — `DnsList.id` (Pi-hole adlist id, AdGuard filter id; falls back to index) | **problem** — a list address went bad; the assistant can find a replacement | That list downloads again; no episode | “Ignore until it downloads again” | “Block lists failing to download”; **per list** | Pi-hole status 3 (old copy kept, still blocks) is minor: fyi; status 4 is the problem. AdGuard never sets `failed`. Index fallback id is not stable if lists are reordered. |
| `lists-old` `home/dns.ts:551` — static | Gravity (Pi-hole) or the oldest enabled list (AdGuard) older than 7 days (`LISTS_OLD_MS`, `:53`) | warn | none (head has **Update lists**) | Yes: glance `warn`; page badge no; figure tone | Whole service (AdGuard: really the oldest list) | **problem** — the scheduled update stopped; the assistant can look | Lists updated; no episode | “Ignore until the lists update” | “Block lists getting old”; per check only | Pi-hole's own gravity runs **weekly** (Sunday early morning, random minute): 7 days flaps every week when a run is a little late. Use 9 days. One dead AdGuard list makes the whole check fire. Title carries the age. |
| `message-<id>` `home/dns.ts:559` — per item (max 5) | Each Pi-hole diagnosis message (`/api/info/messages`) | warn | ask “Look into it” | Yes: glance `warn`; page badge no | The message — Pi-hole's message id (row id) | **problem** by default — Pi-hole's own warning; several types are fyi (rate-limited client, high load, hostname warnings) | Pi-hole removes the message; a recurrence gets a new id, so the id is already the episode | “Ignore this message” | “Pi-hole’s own warnings”; per check, or per message *type* if the read keeps `type` | **Pi-hole's own dismiss:** messages can be deleted in Pi-hole (diagnosis page, `DELETE /api/info/messages/{id}`). Respect it (already: gone = gone) and consider offering “Clear it in Pi-hole” as the native ignore (a write: asks-first rules). Keep `type` in the snapshot to tell problem types from fyi types. |
| `update` `home/dns.ts:572` — static | A newer Pi-hole (core/web/FTL/docker) or AdGuard version | info | none | No | Whole service | **fyi** — a new version is out; nothing is wrong | That version installed; episode = `s.update` (the new version) | “Ignore this version” | “New versions”; per check only | AdGuard's own “update check disabled” is already respected (`:270`). |

**Status computed outside notices:** partly. Glance = `seenFromView` of `dnsNotices` (`:773`), so every warn/bad notice colours the
dot. The page badge is separate (`:722`): only `not-running` and `blocking-off` (paused / off) set it. Filter notices before
`seenFromView` and derive the badge from the same filtered list (or from the quieted state of those two keys).

---

## ESPHome (`home/esphome.ts`, catalog `esphome`)

| Id now | Condition | Tone now | Link now | Dot now | Subject (stable id) | Nature + why | Lifts when / episode | Ignore wording | Check; Stop watching | Noise notes |
|---|---|---|---|---|---|---|---|---|---|---|
| `offline` `home/esphome.ts:297` — static, **groups** (“3 devices offline” + names; one device: “Kitchen is offline since 14:02”) | Devices with runtime state `offline`; bad when any is offline > 1 day | warn / bad | ask “Look into it” | Yes: glance warn/bad; page badge “Device offline” / “Needs a look” | Each device — `EspDevice.config` (its YAML file, `kitchen.yaml`) | **problem** — the assistant can look (Wi-Fi, power, logs) | That device online again; no episode | “Ignore until it’s back online” | “Devices going offline”; **per device** | Deep-sleep / battery devices are offline most of the time; seasonal devices are unplugged for months. “Bad after a day” is inverted: a device gone for days is usually unplugged on purpose. Suggest: after ~7 days offline, fall back to fyi and suggest “Stop watching it?”. |
| `failed-<config>` `home/esphome.ts:321` — per item (max 5) | The device's last install job `failed` within the last 24 h | warn | ask “Look into it” | Yes: glance `warn`; page badge “Needs a look” | The device — `config`; the job — `EspJob.id` | **problem** — a build or upload failed; the assistant can read why | Next install of that device succeeds, or 24 h pass; **episode = job id** | “Ignore this failed install” | “Installs that fail”; per check (per device makes little sense) | Clears by itself after a day. |
| `older` `home/esphome.ts:340` — static, **groups** (count only; head has **Update all**) | Devices built with an older ESPHome than the Builder's | info | none | No | Each device — `config` | **fyi** — nothing is wrong; updating is optional | Device rebuilt; **episode = Builder version** (`s.version`) | “Ignore until the next ESPHome” | “Devices on an older ESPHome”; **per device** (devices you never reflash) | Already info. `pending` (YAML changed, not installed) is only a figure, not a notice. |

**Status computed outside notices:** no. Glance = `seenFromView` (`:500`); page badge from notice tones (`:466`). Filter before both.

---

## UniFi Protect (`home/protect.ts`, `home/protect-events.ts`, catalog `unifi_protect`)

`protect-events.ts` yields no notice itself; its follower's `FollowState.failingSince` (`:166`, in memory) feeds the `events` notice.

| Id now | Condition | Tone now | Link now | Dot now | Subject (stable id) | Nature + why | Lifts when / episode | Ignore wording | Check; Stop watching | Noise notes |
|---|---|---|---|---|---|---|---|---|---|---|
| `breach` `home/protect.ts:244` — static | NVR `armMode.status === 'breach'` | bad | none (head has **Disarm**, confirmed) | Yes: glance `bad`; page badge “Alarm going off” | The alarm (NVR) — whole service | **you** — a person must check the house and disarm; never “Ask … to fix it” | Status no longer `breach`; **episode = `breachAt`** | “Ignore until the alarm stops” | “The alarm going off”; **no Stop watching** (or per check only behind a confirm) | Time-critical: a 5-minute pass is slow for an alarm (a push from the event stream would be better). |
| `camera-offline` `home/protect.ts:255`, `:268` — static, **groups** (same id for one or many) | Cameras whose state isn't `CONNECTED` | warn | ask “Look into it” | Yes: glance `warn`; page badge “Camera offline” | Each camera — `ProtectCamera.id` | **problem** — the assistant can look (power, PoE, network) | That camera `CONNECTED`; no episode | “Ignore until it’s back online” | “Cameras going offline”; **per camera** | `CONNECTING` counts as offline: firmware updates and reboots flap. Count only `DISCONNECTED`, or `CONNECTING` for > 10 min. “Since” is in process memory (`offlineSinceOf`, `:129`). |
| `events` `home/protect.ts:282` — static | Whombat's event follower failing for > 5 min | info | none | No | Whombat's own follower — whole service | **fyi** — Whombat's own plumbing; Recent detections may miss some | Follower connected again | “Ignore until Whombat follows again” | “Following detections”; per check only | In-memory state, resets on restart. |

**Status computed outside notices:** no. Glance = `seenFromView` (`:487`); page badge: breach → bad, any warn notice → “Camera offline”
(`:428`; the word is wrong if a future warn notice isn't a camera). Filter before both.

---

## Home Assistant Controls (`home/ha-controls.ts`)

No notices. Controls carry their own tones on the tiles only: an entity `unavailable` → “Not answering” (warn, `:351`), a lock
`jammed` → bad (`:501`), an alarm `triggered` → bad (`:507`). None reaches Worth a look, the glance or the desk. Candidates for later
**you** notices (“The front door lock is jammed”, “The alarm is going off”) with the same quiet keys (`entity_id`).

---

## Home Assistant (`homeassistant.ts`, catalog `homeassistant`)

`ha-socket.ts` and `homeassistant-restart.ts` yield no notices. A restart (Whombat's own button) briefly leaves integrations in
`setup_in_progress`/`setup_retry`: see noise notes.

| Id now | Condition | Tone now | Link now | Dot now | Subject (stable id) | Nature + why | Lifts when / episode | Ignore wording | Check; Stop watching | Noise notes |
|---|---|---|---|---|---|---|---|---|---|---|
| `recovery` `homeassistant.ts:965` — static | `recovery_mode` / `safe_mode` | bad | ask “Look into it” | Yes: glance `warn` (never bad), reason “Started in recovery mode”; page badge “Needs a look” | Whole service | **problem** — the configuration is broken; the assistant can find why | Next normal start; episode = `startedAt` (optional) | “Ignore until it restarts normally” | “Starting in recovery mode”; per check only | — |
| `integrations` `homeassistant.ts:980` — static, **groups** (count; first 3 in detail) | Config entries in `setup_error`, `setup_retry`, `migration_error`, `not_loaded`, `failed_unload`; bad if any failed | warn / bad | ask “Look into it” | Yes: glance `warn`, reason “N integrations not loading”; page badge | Each integration — `HaEntry.id` (`entry_id`; fallback `domain:title`) | **problem** — the assistant can read the error | That entry `loaded`; no episode | “Ignore until it loads” | “Integrations not loading”; **per integration** | `setup_retry` is constant for devices that are off (a TV, a Chromecast, a phone): flaps. Count retry only after 30 min. **HA's own:** disabled entries and ignored discoveries are already left out (`:238`) — the native “stop watching” is “Disable it in Home Assistant”. |
| `repair-<issueId>` `homeassistant.ts:1006` — per item (max 5) | Each Repairs issue not ignored/dismissed; critical/error → bad, warning → warn | warn / bad | ask “Look into it” | Only critical/error: glance `warn` “N repairs waiting”; page badge. Warning repairs don't colour | The issue — `issue_id` (**collision risk**: HA issues are unique per `domain` + `issue_id`; key on both) | **problem** — the assistant can explain and fix (mostly config) | HA removes the issue; no episode | “Ignore this repair” | “Repairs”; per repair (or per integration) | **HA's own ignore is respected** (`:369`: `ignored`, `dismissed_version`). Whombat's Ignore should ideally ignore it in HA too (`repairs/ignore_issue`, a write under asks-first rules) so both agree, or offer “Ignore it in Home Assistant”. |
| `disk` `things/machine.ts:181` via `homeassistant.ts:1019` — static | Disk ≥ 75 % (warn), ≥ 90 % (bad), or full within 60 days at this pace (warn) | warn / bad | ask “Look into it” | No glance; page badge only when bad | The machine's disk (Supervisor's or the watched machine's) | **problem** at ≥ 75 % (the assistant can clean old backups) · **fyi** when only the forecast trips | Below the band; **episode = band** (75 / 90) so crossing 90 % re-alerts | “Ignore until it passes 90 %” (at 75 %) / “Ignore until it’s below 90 %” | “Disk space”; per check only | The forecast from 30 days of points is a heads-up: fyi. Not in the glance today although it can be bad. |
| `log` (flood) `homeassistant.ts:1036` — static | One integration ≥ 50 % of ≥ 100 errors since restart, still coming in today | warn | tab “Show them” | No glance; no badge | The integration — its domain (`loggerDomain`) | **problem** — one integration floods the log; the assistant can look | Errors from it stop coming in today, or HA restarts; **episode = `startedAt`** (counts reset on restart) | “Ignore until Home Assistant restarts” | “An integration filling the log”; **per integration** | Same id as the row below: split into two checks. |
| `log` (count) `homeassistant.ts:1044` — static | Any errors today; warn at ≥ 10, else info | warn / info | tab “Show them” | No glance; no badge | **No stable id** (log entries are keyed by logger + message only) | **fyi** — every Home Assistant has errors in its log | No errors today; episode = `startedAt` | “Ignore until Home Assistant restarts” | “Errors in the log”; per check only | 10 errors since restart is far too eager. **HA's own:** clearing the log (`system_log/clear`) and logger filters reset it. |
| `backup` `homeassistant.ts:1057` — static | Backups readable (HA's or the machine's) and none in the last 7 days | warn | ask “Look into it” | No glance; no badge | Whole service | **problem** — automatic backups stopped or were never set up; the assistant can set them up | A backup newer than 7 days; no episode | “Ignore until the next backup” | “Backups”; per check only | People who back up HA another way (outside what Whombat sees) need Stop watching. |
| `updates` `homeassistant.ts:1072` — static | `update.*` entities `on` (count from a template) | info | url “Open” → `/config/updates` | No | **No stable id** — only a count | **fyi** — updates are optional | Count back to 0; no episode possible with a count | “Ignore these updates” | “Updates”; per check only (per update needs ids) | **HA's own skip is respected**: skipped updates are `off`. To ignore one update, the template must return entity ids + `latest_version` (episode). |
| `unavailable` `homeassistant.ts:1083` — static | Entities `unavailable` (count from a template) | info | ask “Look into it” | No | **No stable id** — only a count | **fyi** — big installs always have some | Count 0 (rarely on big installs) | “Ignore until they answer” | “Devices and sensors not answering”; per check (per entity needs ids) | On John's ~6,000 entities this is never 0: permanent line. **HA's own:** disabled entities aren't in `states`. |

**Status computed outside notices:** yes, entirely. The health pass never builds `haNotices` (it needs `HaCtx.points` for the disk
forecast); the glance is `homeAssistantGlance` (`:544`): `warn` for recovery mode, integrations not loading, critical/error repairs —
never `bad`. The page badge is separate again (`:1394`): “Needs a look” for those three or any bad notice. Disk, backups, the log and
warning repairs never colour the dot today. Filtering needs: the health pass to evaluate notices (with the 30-day disk points), and
the glance/badge to be derived from the filtered list (or `notLoading`/`seriousRepairs` filtered by quieted keys).

---

## Hetzner Cloud (`hetzner.ts`, catalog `hetzner`)

| Id now | Condition | Tone now | Link now | Dot now | Subject (stable id) | Nature + why | Lifts when / episode | Ignore wording | Check; Stop watching | Noise notes |
|---|---|---|---|---|---|---|---|---|---|---|
| `not-running` `hetzner.ts:584` — static, **groups** (one name, or “2 servers aren’t running” + names) | Server `status !== 'running'` | warn | ask “Look into it” | **No glance status at all**; page badge “N servers not running” | Each server — `HetznerServer.id` (Hetzner numeric id) | **problem** — the assistant can look and start it | That server `running`; no episode | “Ignore until it’s running” | “Servers not running”; **per server** (a server kept off on purpose) | Counts `starting`, `initializing`, `rebuilding`, `migrating`, `stopping` as not running: flaps. Count `off`/`unknown` only, over two passes. |
| `traffic` `hetzner.ts:603` — static | Outgoing traffic ≥ 80 % (warn) / ≥ 100 % (bad) of what's included, **summed over servers** | warn / bad | ask “Look into it” | No glance; page figure tone | Whole project (summed); per-server bytes exist in the snapshot | **fyi** at 80 % (a forecast) · **problem** at ≥ 100 % (it costs money; the assistant can find what uses it) | Next billing month; **episode = billing month** (`YYYY-MM`) + band (80 / 100) | “Ignore this month” | “Traffic”; per check (or per server once it is per server) | Hetzner counts traffic per server; a sum can hide one server going over. |
| `no-backups` `hetzner.ts:619` — static, **groups** | Server without a backup window | warn | ask “Turn on…” | No glance; no badge | Each server — `HetznerServer.id` | **you** — backups cost 20 % more: a person decides (“Turn on…” stays as the decision button) | Backups on for that server — in practice a standing choice | “Ignore until backups are on” (≈ “Don’t ask about backups for <server>”) | “Backups”; **per server** | Never changes by itself: “until it changes” equals Stop watching. Many back up another way (inside the server, Whombat's own backups). |
| `delete-protection` `hetzner.ts:644` — static, **groups** | Server without delete protection | info | ask “Turn on” | No | Each server — `HetznerServer.id` | **fyi** — advice, not a fault | Protection on | “Ignore until it’s on” | “Delete protection”; **per server** | Already info. |

**Status computed outside notices:** yes. `hetznerGlanceOf` (`:353`) returns no status (health pass stores `ok`), so Hetzner never
colours the dot or reaches the desk today. Page badge is separate (`:916`). Notices are not built in the health pass (`first.ts:104`).

---

## Fusebox (`fusebox.ts`, `fusebox-pool.ts`, catalog `fusebox`)

Account keys are `gatewayAccountKey` (`gwa_` + hash of connection and Fusebox id: stable). Fusebox faults carry their own stable `key`
(`signin:<id>`, `quota:<id>`, `rate:<id>`, `provider:<p>`, …; `db/schema/gateway.ts:17`) and `until`.

| Id now | Condition | Tone now | Link now | Dot now | Subject (stable id) | Nature + why | Lifts when / episode | Ignore wording | Check; Stop watching | Noise notes |
|---|---|---|---|---|---|---|---|---|---|---|
| `used-up-<tool>` `fusebox.ts:691` — per tool, **groups** (every subscription of the tool) | Every enabled subscription of Claude/Codex `used_up` | bad | none | Yes: glance `bad` “Claude used up until …”; page badge | The tool (`claude`/`codex`) | **you** — only a person can add room (another subscription) or wait; “Ask Dusty to fix it” may not even run, Dusty uses this gateway | Room back; **episode = `until`** (to the minute, like AIG-14's `provider:<p>\|<minute>`) | “Ignore until it resets” | “Running out of room”; per check (per tool) | **Already a DM** to owners/admins (AIG-14, `gateway/logic.ts:103`): DM + red dot + desk look triple up. |
| `signin-<accountKey>` `fusebox.ts:701` — per item | Account `signin_expired` | bad | url “Sign in again” (Fusebox) | Yes: glance `warn` (page notice says bad), reason “N sign-ins expired” | The subscription — account key | **you** — someone must sign in | Sign-in works again; no episode | “Ignore until someone signs in” | “Expired sign-ins”; per subscription | **Already a DM** once while it lasts (AIG-14, key `signin:<id>\|`) — the existing precedent for “until it changes”. **Fusebox's own:** turning the account off in Fusebox stops it (`accountStatus` returns `off` first). |
| `runs-out-<tool>` `fusebox.ts:714` — per tool | The week pool runs out before its first reset at this pace (≥ 25 % of window gone, ≥ 20 % used) | warn | ask “Look into it” | Yes: glance `warn` “Claude’s week runs out early”; page badge | The tool's week pool | **fyi** — a forecast | No longer forecast to run out; **episode = the week** (the pool's first reset / `runsOut.before`) | “Ignore this week” | “Week running out early”; per tool | The pace moves with each session: comes and goes within a day. |
| `failing` `fusebox.ts:736` — static | ≥ 10 failed requests and ≥ 2 % in **the page's range** | warn | url “Show them” | No | Whole service — **no stable window**: depends on the range the reader picked | **problem** — the assistant can look | Below the threshold; needs a fixed window (e.g. the last hour) in the health pass | “Ignore until they stop failing” | “Failing requests”; per check only | Not computable in the health pass as written. |
| `storage` `fusebox.ts:749` — static | Fusebox fault `storage` | warn | url “Open Fusebox” | No | Whole service (fault key) | **problem** — Fusebox can't save its history (disk, database) | Fault gone | “Ignore until Fusebox saves again” | “Saving usage history”; per check only | — |
| `fault-<faultKey>` `fusebox.ts:758` — per item | Fusebox fault `failures` or `error` | warn | url “Show them” | No | The fault — Fusebox's `key` (account or provider) | **problem** — a provider or account keeps failing | Fault gone (it has an `until`) | “Ignore until it clears” | “Fusebox’s own warnings”; per check | Clears by itself at `until`. |
| `used-<accountKey>` `fusebox.ts:770` — per item | One subscription `used_up` while others still have room | info | none | No | The subscription — account key | **fyi** — new sessions go to the others | Room back; episode = `until` | “Ignore until it resets” | “One subscription used up”; per check | Already info. |
| `off-<accountKey>` `fusebox.ts:781` — per item | Subscription switched off in Fusebox | info | none | No | The subscription — account key | **fyi** — someone switched it off | Switched on | “Ignore while it’s off” | “Subscriptions switched off”; per subscription | Deliberate by definition; could be dropped from Worth a look. |

**Status computed outside notices:** yes. Glance and page badge both come from `fuseboxStatus` (`fusebox-pool.ts:277`) over accounts
and pools only: `bad` when a tool is used up, `warn` for expired sign-ins or a week running out early. Faults, failing requests and
storage never colour. The health pass (`first.ts:115`) reads the poller's stored accounts and never builds notices. Separately the
gateway poller DMs owners/admins (AIG-14, `gateway/logic.ts:103`) with its own sent-keys: quieting should cover that path or at least
use the same keys.

---

## Across these kinds

- **Notices not evaluated in the health pass today:** UniFi, Home Assistant, Hetzner, Fusebox (their `seen` builds a glance from
  separate code). Access, DNS, ESPHome and Protect already run their notice builders in `seen` via `seenFromView`.
- **In-memory “since” state:** Access `openSinceOf`, Protect `offlineSinceOf`, Protect follower `failingSince`. They reset on restart;
  the quiet store's per-key first-seen could replace them.
- **Debounce candidates (two passes in a row):** UniFi offline, Protect `CONNECTING`, Hetzner transitional states, HA `setup_retry`,
  Access door open (threshold = pass interval), UniFi gateway CPU (use stored points instead).
- **Tone escalation inside one check:** ESPHome offline > 1 day, DNS pause → off for good, HA integration retry → failed, disk 75 → 90 %,
  Hetzner traffic 80 → 100 %. Put the band in the episode so an ignore at the lower band doesn't hide the higher one.
- **Service-side ignores to respect or reuse:** HA repairs `ignored`/`dismissed_version`, disabled and ignored config entries, skipped
  updates, disabled entities (all already respected); Pi-hole diagnosis messages can be deleted in Pi-hole; AdGuard's disabled update
  check (respected); Fusebox accounts switched off (respected).
