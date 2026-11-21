# Quiet notices: catalogue of the storage and business kinds

Paths are relative to `apps/server/src/things/kinds/`. Research only: no code was changed. Read at `main` 06e42934
(2026-10-22).

**How to read the tables**

- **Shape**: `static` = one fixed id per connection; `per item` = one line per pool/disk/task…; `groups N` = one line
  that stands for several items.
- **Now**: tone · link/button · whether it colours the dot today. Every kind here gets its dot from
  `seenFromView` (`registry.ts:82`): the worst **bad/warn** notice sets the status and its title becomes the
  `reason`; **info** never colours. So "dot" = yes for bad/warn and no for info, unless noted.
- **Subject · stable id**: what the key's subject part would be, and the field in the reader's snapshot.
  ⚠ = no stable id, or only a weak one.
- **Lifts when · episode**: when "Ignore" (until it changes) ends. The **episode** is the fact-version that, when it
  changes, should end an ignore even if Whombat never saw the condition clear (Whombat was off, a 5-minute pass was
  missed, or the condition never clears between two occurrences). "—" = none needed; the subject alone is enough.
- **Stop watching**: `item` = per subject (one pool, one guest, one site); `check` = only the whole check (a
  service-level line); `n/a` = doesn't make sense.

Proposed key format used below: `<check>:<subject>[@<episode>]`, e.g. `pbs.late:store1/ns/vm/105@1729468800`.

---

## Synology DSM (`storage/synology.ts`)

| Notice id · where | Shape | Condition | Now | Subject · stable id | Nature — why | Lifts when · episode | Ignore wording | Watch check · Stop watching | Noise |
|---|---|---|---|---|---|---|---|---|---|
| `storage-refused` · synology.ts:539 | static | DSM refuses `load_info` (code 105: the user isn't an administrator) | info · no link · dot no | the service | **fyi** — a setup hint; the reader can't do anything about it, only the owner can | DSM shows storage · — | “Don’t show this again” | “Storage needs an administrator” · n/a (switching the check off is the same) | Better as a Settings hint than a Worth a look line |
| `pool-<id>` · :550 | per item | Pool state is degraded/crashed (bad) or an unknown word (warn); busy states (repair, scrub, expand) left out | bad/warn · url “Open Storage Manager” · dot yes | one pool · `SynoPool.id` (`id` ?? `pool_path`, e.g. `reuse_1`) | **problem** — the assistant can find which disk and how to repair | Pool is healthy again · episode = state word (degraded → crashed must alert again) | “Ignore until it’s healthy” | “Storage pools and volumes” (health) · item (rarely wise) | `healthOf` maps every unknown word to warn — log unknown words before trusting them |
| `volume-<id>` · :561 | per item | Volume state not normal | bad/warn · url “Open Storage Manager” · dot yes | one volume · `SynoVolume.id` (`id` ?? `vol_path`) | **problem** — same as the pool | Healthy · episode = state word | “Ignore until it’s healthy” | same check as the pool · item | Often duplicates the pool line for a one-volume pool: merge them, or let the volume line give way |
| `full-<volumeId>` · :572 | per item | Volume ≥ 85 % (warn), ≥ 95 % (bad) | warn/bad · no link · dot yes | one volume · `SynoVolume.id` | **problem** — the assistant can find what takes the space | Under 85 % · episode = band (85/95) so getting fuller alerts again | “Ignore unless it gets fuller” | “Volumes filling up” · item | 85 % on a 20 TB volume leaves 3 TB; use a free-space floor or a fill-rate forecast as well as % |
| `disk-<id>` · :584 | per item | Disk's own state or SMART verdict is bad/warn | bad/warn · no link · dot yes | one disk · `SynoDisk.id` = **slot** (`sata1`) ⚠ not a serial | **you** — a disk has to be replaced by hand | Disk healthy · episode = state word **and the serial** (read `serial` in `load_info`), so a new disk in the same slot is a new subject | “Ignore until it’s replaced” | “Disk health” · item | Slot ids: an ignore on the old disk must not cover the new one. No link today; add “Open Storage Manager” |
| `hot-<id>` · :593 | per item | HDD ≥ 55 °C (warn), ≥ 60 (bad); SSD 70/80 | warn/bad · no link · dot yes | one disk · slot ⚠ | **you** at bad (airflow, fans); **fyi** at warn | Below threshold for 2 passes · episode = band | “Ignore until it cools down” | “Disk temperatures” · item | Flaps around 55 °C in summer, during scrubs and backups. Add hysteresis (lift 3 °C lower) and 2 readings in a row. Warn should be fyi |
| `backup-<taskId>` · :603 | per item | Hyper Backup task's last result failed | bad · url “Open Hyper Backup” · dot yes | one task · `SynoBackup.id` (`task_id`, stable) | **problem** — the assistant can read why and retry | Next result is OK · episode = `last` (last_bkp_time) | “Ignore until the next backup” | “Backups failing” · item | — |
| `late-<taskId>` · :612 | per item | Task not running and last backup > 2 days ago (`BACKUP_LATE_DAYS`) | warn · no link · dot yes | one task · `task_id` | **problem** | A new backup · episode = `last` | “Ignore until the next backup” | “Backups running late” · item | **Too eager**: a weekly task is “late” on day 3 while its own detail says “Next run in 4 days”. Late should mean `next_bkp_time` has passed (or no schedule and > interval) |
| `partial-<taskId>` · :623 | per item | Last result partial/cancelled/suspended/skipped | warn · no link · dot yes | one task · `task_id` | **problem** (fyi when it was cancelled by a person) | Next result OK · episode = `last` | “Ignore until the next backup” | “Backups only partly done” · item | `backupResult` lumps “cancel” in with partial; someone cancelling a run isn't a problem |
| `security` · :631 | static, groups N findings (counts only) | Security Advisor has risks (warn) or only warnings (info) | warn/info · url “Open Security Advisor” · dot yes for risks | the service ⚠ no per-finding id (`items` keys exist in the answer but aren't kept) | **you** for risks (a person decides: SSH port, admin account…); **fyi** for suggestions | Risks drop to 0 · episode = risk count (more risks = new episode), or `lastScanTime` | “Ignore until it finds more” | “Security Advisor findings” · check (or per finding if item keys are read) | DSM's advisor flags taste choices; many owners keep the same 1–2 risks for ever. Ignore must survive the daily rescan |
| `update` · :642 | static | DSM update available (kept an hour) | info · url “Open DSM” · dot no | the service | **fyi** | Installed · episode = offered version | “Ignore until the next version” | “DSM updates” · check | — |

**Status computed outside notices.** Page status/badge = `statusOf(notices)` (`shared.ts:94`, worst non-info); card
= `cardOf(view, ['volumes','backup'])` → `seenFromView`, so the dot follows the notices. Separately computed and
**not** silenced by an ignore: the KPI tones (`Volumes`, `Disks`, `Last backup`, synology.ts:489–520), the storage
bars' tones and the disks/backups table dots. Card facts carry no tone, so only the page keeps these colours.

---

## TrueNAS (`storage/truenas.ts`, `storage/truenas-socket.ts` has no notices)

| Notice id · where | Shape | Condition | Now | Subject · stable id | Nature — why | Lifts when · episode | Ignore wording | Watch check · Stop watching | Noise |
|---|---|---|---|---|---|---|---|---|---|
| `pool-<name>` · truenas.ts:508 | per item | `pool.healthy` false | bad · url “Open TrueNAS” (storage) · dot yes | one pool · `TnPool.name` | **problem** | Pool healthy · episode = `status` (DEGRADED → FAULTED alerts again) | “Ignore until it’s healthy” | “Pool health” · item | TrueNAS raises its own `VolumeStatus` alert for the same thing → two lines, see `alert-*` |
| `scrub-errors-<name>` · :520 | per item | Last finished scrub found errors | bad · no link · dot yes | one pool · name | **problem** | A later scrub has 0 errors · episode = `scan.end` | “Ignore until the next scrub” | “Scrub errors” · item | — |
| `scrub-<name>` · :528 | per item | Not scrubbing and last scrub > 35 days (`SCRUB_DAYS`) or never | warn · button **Scrub** (confirmed) · dot yes | one pool · name | **you** — starting hours of disk reading is a person's choice; the button is right there | A scrub finishes · episode = last scrub end | “Ignore until the next scrub” | “Scrubs overdue” · item | **Bug-like noise**: `lastScrub` is null when the last scan was a RESILVER, so after every resilver the pool “has never been scrubbed”. A brand-new pool also says “never” on day 1. Use any finished scan, and give new pools 35 days |
| `full-<name>` · :545 | per item | Allocated ≥ 85 % / ≥ 95 % | warn/bad · no link · dot yes | one pool · name | **problem** | Under 85 % · episode = band | “Ignore unless it gets fuller” | “Pools filling up” · item | Duplicates TrueNAS's own `ZpoolCapacityWarning/Critical` alerts (80/90 %) |
| `alert-<uuid>` · :557 | per item | Every undismissed TrueNAS alert; ERROR+ bad, WARNING warn, INFO/NOTICE info | bad/warn/info · button **Dismiss** unless CRITICAL/ALERT/EMERGENCY · dot yes for WARNING+ | one alert occurrence · `uuid` ⚠ per occurrence; no check id (`klass`/`key` not selected) | **problem** for WARNING+ by default, **fyi** for INFO/NOTICE; by `klass` ideally (SMART, DiskTemp → you; Update → fyi) | TrueNAS clears it (uuid gone) · episode = uuid | “Dismiss in TrueNAS” when allowed (reuse `alert.dismiss`; TrueNAS brings it back when it happens again = exactly “until it changes”), else “Ignore until it clears” | One check per alert class (“TrueNAS: <klass>”) once `klass` is read · item = class | Read `klass` + `key` to (a) suppress classes Whombat already shows (`VolumeStatus`, `ZpoolCapacity*`, `ScrubPaused`) and (b) allow Stop watching per class. Critical alerts can't be dismissed in TrueNAS → Whombat-side ignore only |
| `task-<kind>-<id>` · :571 | per item | Snapshot/replication/cloud sync/cloud backup task failed | warn · url “Open TrueNAS” (data protection) · dot yes | one task · `TnTask.id` (`snapshot-3`, stable) | **problem** | Next run OK · episode = `at` (state datetime / job finish) | “Ignore until the next run” | “Data protection tasks failing” · item | ABORTED counts as failed; a person stopping a replication isn't a failure |
| `hot-<diskName>` · :592 | per item | Disk temp ≥ 55/60 (HDD) or 70/80 (SSD) | warn/bad · no link · dot yes | one disk · `TnDisk.name` (`sda`) ⚠ **kernel name changes across reboots** | **you** at bad, **fyi** at warn | Below threshold for 2 passes · episode = band | “Ignore until it cools down” | “Disk temperatures” · item | Select `serial` (or `identifier`) in `disk.query` and key on it. Same hysteresis advice as Synology |
| `crashed-<app>` · :602 | per item | App state CRASHED | warn · button **Start** · dot yes | one app · `TnApp.name` | **problem** — the assistant can read why it crashed | App running · episode = — | “Ignore until it’s running” | “Apps crashed” · item | Crash-looping apps flip CRASHED ↔ DEPLOYING between passes → require 2 passes |
| `update` · :611 | static | `update.status` has a new version (or 25.04's check) | info · url “Open updates” · dot no | the service | **fyi** | Installed · episode = version | “Ignore until the next version” | “TrueNAS updates” · check | — |
| `app-updates` · :621 | static, groups N apps | Apps with an update | info · url “Open apps” · dot no | the set of apps · app names | **fyi** | No updates · episode = sorted app names (a new app joining re-shows) | “Ignore until another app has one” | “App updates” · check (item = an app, optional) | Image-only updates (`image_updates_available`) are frequent; consider leaving them out |

**Status computed outside notices.** `statusOf(notices)` for the page; `cardOf(view, ['pools','alerts'])` for the card,
dot from notices. KPI tones are separate: `Pools` (bad when any unhealthy), `Alerts` (bad/warn by level, counts
**every** undismissed alert, so a Whombat-only ignore still counts there), `Apps` (warn on crashed). Pool/disk/app
table dots too. TrueNAS-dismissed alerts are already filtered at parse (`truenas.ts:157`).

---

## Proxmox Backup Server (`storage/pbs.ts`)

| Notice id · where | Shape | Condition | Now | Subject · stable id | Nature — why | Lifts when · episode | Ignore wording | Watch check · Stop watching | Noise |
|---|---|---|---|---|---|---|---|---|---|
| `store-<name>` · pbs.ts:585 | per item | Datastore has an error or is not mounted | bad · no link · dot yes | one datastore · `PbsStore.name` | **problem**; **fyi** when the error is maintenance mode or a removable datastore that is simply unplugged | Error gone · episode = error text | “Ignore until it’s back” | “Datastores unavailable” · item | Removable datastores (PBS 3.3) are “not mounted” most of the time; maintenance mode is set on purpose. Use `backend-type` / the maintenance words |
| `full-<name>` · :600 | per item | ≥ 85/95 % **or** PBS/forecast says full within 30 days | warn/bad · ask “Look into it” · dot yes | one datastore · name | **problem** at ≥ 85 %; **fyi** when it is only the forecast | Under 85 % and forecast > 30 days · episode = band, or the forecast's month | “Ignore unless it gets fuller” | split: “Datastores filling up” and “Datastores full soon (forecast)” · item | A forecast alone shouldn't colour the dot (that's the fyi rule). The forecast moves every pass; key on band, not date |
| `late-<store>-<ns>-<type>-<id>` · :627 | per item, at most 5 | Guest's last backup > 2 days ago (`LATE_DAYS`) and ≤ 30 days (`RETIRED_DAYS`) | bad · ask “Look into it” · dot yes | one guest group · `store` + `ns` + `type/id` (e.g. `vm/105`); id is `clip`ped at 120 with “…” ⚠ long namespaces can collide | **problem** | A new backup · episode = `last` | “Ignore until the next backup” | “Backups running late” · item (per guest: “Stop watching web”) | **Too eager and then too quiet**: weekly schedules are red from day 3; after 30 days a missing guest silently becomes “retired”. Use each guest's own rhythm (median gap × 1.5, at least 2 days). The cap of 5 is applied before any filter: apply ignores first. A guest moved to another datastore/namespace leaves its old group late for 28 days: dedupe by `type/id`, newest wins. Health pass passes `names: new Map()` (pbs.ts:1005), so the desk reason says “VM 105” while the page says “web” |
| `damaged` · :645 | static, groups N groups × M snapshots | Snapshots whose verification failed | bad · url “Open it” · dot yes | per guest group (store/ns/type/id) ⚠ but the line has one static id | **problem** — the assistant can re-verify and explain | No damaged snapshots · episode = per-group damaged count (more damage = new) | “Ignore until more backups fail verification” | “Backups failing verification” · item | Damaged snapshots stay until pruned, so this is red for weeks. Split per guest |
| `job-<kind>-<id>` · :660 | per item | GC/verify/prune/sync job's last run isn't OK (warnings excluded) | verify bad, others warn · no link (the job row has Run verify / Run cleanup) · dot yes | one job · `kind` + `PbsJob.id` (gc: the store) | **problem** | Next run OK · episode = `lastEnd` | “Ignore until it runs fine” | “Jobs failing” · item | Overlaps the `task-*` line for the same failure |
| `task-<words>` · :677 | groups N tasks of one kind, at most 4 lines | Failed tasks (not WARNINGS) in the last 7 days, one line per `taskWords` | warn · url “Show tasks” · dot yes | ⚠ id is built from words (`task-backup-of-vm-105`, fallback `task-a-backup`); per-task `upid` is per occurrence | **problem**; **fyi** for restores (`reader`) and other things a person started | No failure of that kind in 7 days · episode = newest `upid` | “Ignore until it fails again” | “Failed tasks” · check (item = worker type + worker id) | Stays warn for 7 days after one blip even when the next run worked; duplicates `job-*` and `late-*`. Better: only tasks whose latest run of the same worker failed |
| `retired` · :688 | static, groups N | Groups whose last backup is > 30 days old | info · no link · dot no | the set · group ids | **fyi** | Pruned · episode = count | “Don’t show this again” | “Old guests still in backups” · check | — |

**Status computed outside notices.** `statusOf(notices, …)` with calm words from `late` (pbs.ts:944) — counts late
guests itself, so an ignored late guest makes the calm badge say “Backups running” instead of “All N guests backed
up” (fine, but the count must skip ignored guests too). Card = `cardOf(view, ['oldest','failed'])`, dot from notices.
KPI tones are separate: `Oldest backup` bad when the oldest is late, `Failed` warn when any task failed, `Verified`
bad on damage; guest table dots too.

---

## QNAP (`storage/qnap.ts`)

| Notice id · where | Shape | Condition | Now | Subject · stable id | Nature — why | Lifts when · episode | Ignore wording | Watch check · Stop watching | Noise |
|---|---|---|---|---|---|---|---|---|---|
| `health` · qnap.ts:292 | static | `sysHealth` status isn't “good” | warn · url “Open QTS” · dot yes | the service | **problem** | Health says good · episode = QTS's word | “Ignore until it’s good again” | “QNAP system health” · check | Usually repeats a disk or fan line; give way when a disk/warm line exists |
| `full-<volumeValue>` · :303 | per item | Volume ≥ 85/95 % | warn/bad · no link · dot yes | one volume · `volumeValue` (QTS index; stable-ish) | **problem** | Under 85 % · episode = band | “Ignore unless it gets fuller” | “Volumes filling up” · item | — |
| `disk-<HDNo>` · :314 | per item | Disk health not OK/Good: “Warning”, “Unknown”, “--” → warn; anything else bad | warn/bad · url “Open QTS” · dot yes | one disk · `HDNo` = **bay** ⚠ not a serial | **you** (replace it); **fyi** for Unknown/“--” | Healthy · episode = health word + serial (read it) | “Ignore until it’s replaced” | “Disk health” · item | “Unknown”/“--” is permanent on USB enclosures and some NVMe: yellow for ever. Treat as fyi |
| `hot-<HDNo>` · :326 | per item | Disk temperature thresholds as Synology | warn/bad · no link · dot yes | one disk · bay ⚠ | **you** at bad, **fyi** at warn | Below threshold 2 passes · episode = band | “Ignore until it cools down” | “Disk temperatures” · item | Hysteresis |
| `warm` · :337 | static | Board ≥ 60/70 °C or CPU ≥ 85/95 °C | warn/bad · no link · dot yes | the box | **you** at bad (fans, where it stands), **fyi** at warn | Below thresholds 2 passes · episode = band | “Ignore until it cools down” | “QNAP temperature” · check | CPU spikes to 85 °C under load flap; require 2–3 readings |

**Status computed outside notices.** `statusOf(notices)`; card `cardOf(view, ['volumes','disks'])`, dot from notices.
KPI tones separate (`Volumes` fullest, `Disks`, `Temperature`).

---

## Nextcloud (`storage/nextcloud.ts`)

| Notice id · where | Shape | Condition | Now | Subject · stable id | Nature — why | Lifts when · episode | Ignore wording | Watch check · Stop watching | Noise |
|---|---|---|---|---|---|---|---|---|---|
| `not-admin` · nextcloud.ts:270 | static | The account isn't an admin (no Monitoring answer) | info · no link · dot no | the service | **fyi** — a setup hint | Reconnected as admin · — | “Don’t show this again” | “Needs an admin account” · n/a | Better in Settings |
| `free` · :280 | static | Free space < 10 GB (warn), < 2 GB (bad) | warn/bad · no link · dot yes | the service's data disk | **problem** | ≥ 10 GB · episode = band | “Ignore unless it gets fuller” | “Free space” · check | Absolute floors are right here (Nextcloud gives no total) |
| `update` · :288 | static | Nextcloud update available | info · url “Open updates” · dot no | the service | **fyi** | Installed · episode = version | “Ignore until the next version” | “Nextcloud updates” · check | — |
| `app-updates` · :297 | static, groups N apps | Apps with updates | info · url “Open apps” · dot no | the set · app ids | **fyi** | None · episode = sorted `id@version` | “Ignore until another app has one” | “App updates” · check | Changes almost weekly |

**Status computed outside notices.** `statusOf(notices, calm)`; card `cardOf(view, ['active','free'] or ['yours'])`.
`Free space` KPI tone separate.

---

## Paperless-ngx (`storage/paperless.ts`)

| Notice id · where | Shape | Condition | Now | Subject · stable id | Nature — why | Lifts when · episode | Ignore wording | Watch check · Stop watching | Noise |
|---|---|---|---|---|---|---|---|---|---|
| `failed` · paperless.ts:428 | static, groups up to 25 imports | Unacknowledged failed imports (`acknowledged=false`) | warn · url “Show them” · dot yes; each row has **Mark seen** | per import · task `id` (stable integer) — but the line is static | **you** — a person decides what to do with the file; **fyi** for duplicates (“It’s already in Paperless”) | All acknowledged · episode = newest task id | Reuse Paperless's **Mark seen**: “Mark them seen in Paperless” (acknowledges the listed ids; Paperless keeps the task). Look-only: “Ignore until another import fails” | “Imports failing” · check | Duplicates are Paperless working as intended and are most of them |
| `check-database` · :344 (case :346) | static | `/api/status/` database ERROR | bad · no link · dot yes | the service | **problem** | Status OK · — | “Ignore until it’s fixed” | “Paperless's own checks” · item per check | — |
| `check-redis` · :344 (case :348) | static | Redis ERROR | bad · no link · dot yes | the service | **problem** | OK · — | “Ignore until it’s running” | same check | Same title as `check-celery` (“worker isn’t running”): two identical lines. Merge into one subject “worker” |
| `check-celery` · :344 (case :349) | static | Celery ERROR | bad · no link · dot yes | the service | **problem** | OK · — | “Ignore until it’s running” | same check | see above |
| `check-index` · :344 (case :356) | static | Search index ERROR | warn · url “Open Paperless-ngx” · dot yes | the service | **problem** | OK · episode = `index_last_modified` | “Ignore until it’s fixed” | same check | — |
| `check-classifier` · :344 (case :363) | static | Classifier ERROR | warn · no link · dot yes | the service | **fyi** — auto-matching only; small libraries fail to train | OK · episode = `classifier_last_trained` | “Ignore until it trains again” | same check | Frequent on new installs with no auto-matching tags |
| `check-sanity` · :344 (case :365) | static | Sanity check ERROR | warn · button **Run sanity check** · dot yes | the service | **problem** | Next check passes · episode = `sanity_check_last_run` | “Ignore until the next check” | same check | Stays red after a fix until the weekly check runs again |
| `storage` · :446 | static | Paperless's disk ≥ 85/95 % | warn/bad · no link · dot yes | the data disk | **problem** | Under 85 % · episode = band | “Ignore unless it gets fuller” | “Free space” · check | — |
| `update` · :455 | static | Remote version newer | info · url “What’s new” · dot no | the service | **fyi** | Installed · episode = version | “Ignore until the next version” | “Paperless-ngx updates” · check | — |

**Status computed outside notices.** `statusOf(notices, inbox words)`; card `cardOf(view, ['inbox','failed'])`.
`Failed imports` KPI tone (warn) and `Free space` tone are separate.

---

## Immich (`storage/immich.ts`)

| Notice id · where | Shape | Condition | Now | Subject · stable id | Nature — why | Lifts when · episode | Ignore wording | Watch check · Stop watching | Noise |
|---|---|---|---|---|---|---|---|---|---|
| `disk` · immich.ts:402 | static | Disk ≥ 85/95 % | warn/bad · no link · dot yes | the library disk | **problem** | Under 85 % · episode = band | “Ignore unless it gets fuller” | “Disk filling up” · check | — |
| `paused-<queue>` · :411 | per item | A queue is paused (warn with jobs waiting, info without) | warn/info · button **Resume** · dot yes when warn | one queue · queue `name` (stable) | **you** — someone paused it on purpose; **fyi** with nothing waiting | Resumed · — | “Ignore while it’s paused” | “Paused queues” · item | Paused on purpose during imports; jobs pile up and it turns warn by itself |
| `failed` · :421 | static, groups N queues | Any queue has failed jobs | warn · url “Open jobs” · dot yes | per queue · name ⚠ no job ids, counts only | **problem** (consider fyi) | All counts 0 · episode = total failed count (alert again only when it grows) | “Ignore until more fail” | “Jobs failing” · check (item = queue) | Failed counts are sticky (kept until cleared), mostly corrupt or odd files. Immich can clear failed jobs on a queue (check its API); otherwise this stays for ever |
| `integrity` · :432 | static, counts | Missing files (warn) or checksum mismatches (bad), 3.0 only | warn/bad · url “Open Immich” (repair) · dot yes | the library ⚠ counts only | **problem** | Both 0 · episode = counts (missing, mismatched) | “Ignore until more files go missing” | “Missing or changed files” · check | — |
| `update` · :453 | static | `latest` newer than running | info · url “What’s new” · dot no | the service | **fyi** | Installed · episode = version | “Ignore until the next version” | “Immich updates” · check | Immich releases weekly |

**Status computed outside notices.** `statusOf(notices, photos)`; card `cardOf(view, ['photos','disk'])`. `Jobs
waiting` KPI tone separate.

---

## HubSpot and Pipedrive (`business/crm.ts`, one code path)

| Notice id · where | Shape | Condition | Now | Subject · stable id | Nature — why | Lifts when · episode | Ignore wording | Watch check · Stop watching | Noise |
|---|---|---|---|---|---|---|---|---|---|
| `overdue` · crm.ts:729 | static, groups N tasks | Tasks/activities more than 7 days overdue (`OVERDUE_WARN_DAYS`), among those read (Pipedrive: 20) | warn · url “Open HubSpot/Pipedrive” · dot yes | per task · `CrmTask.id` (HubSpot task id, Pipedrive activity id) | **fyi** — a to-do list is its owner's business (Todoist's own rule); nothing for the assistant to fix | None over a week · episode = set of task ids (a task newly crossing the week line re-shows it) | “Ignore until another task is a week late” | “Tasks over a week overdue” · check | Counts the **whole account's** tasks, every owner, not just the connection's user. Teams with a backlog are yellow for ever. Done buttons stay on the Overdue table |

**Status computed outside notices.** `statusFrom(notices, '<n> overdue' | 'Nothing overdue')`; card `seenOfView(view,
['open','overdue'])`. `Overdue` KPI tone (warn when any is a week old) separate.

---

## GitLab and Forgejo/Gitea (`business/git.ts`, one code path)

| Notice id · where | Shape | Condition | Now | Subject · stable id | Nature — why | Lifts when · episode | Ignore wording | Watch check · Stop watching | Noise |
|---|---|---|---|---|---|---|---|---|---|
| `failing-<project>/<run>` · git.ts:630 | per item, at most 5 | Latest pipeline/run on the default branch failed (projects active in 7 days, 8 at most) | warn · url “Show it” (Retry is on the Failing table) · dot yes | one project's default branch · GitLab `project.id`, Forgejo `full_name` (renames change it). The id today **embeds the run id**, so subject and episode are mixed | **problem** — the assistant can read the log and fix it | Branch's latest run passes · episode = — (keep ignoring while it stays red; the run id is a fact-version only if you want each new red run to alert again) | “Ignore until it passes” | “Default branch failing” · item (per project) | A nightly scheduled pipeline that fails every night; a project going quiet for 7 days silently drops off |
| `runners-offline` · :644 (all), :655 (some) | static, groups N runners; one id for both tones | All unpaused runners offline (bad) or some (warn) | bad/warn · no link · dot yes | per runner · `GitRunner.id` ⚠ the line has one static id | **problem** | All online · episode = set of offline runner ids + tone (all-offline is worse, alerts again) | “Ignore until they’re back” | “Runners offline” · item (per runner) | GitLab's `stale` / `never_contacted` runners count as offline; autoscaled/ephemeral runners are offline between jobs; an admin's `/runners/all` includes everyone's project runners |

**Status computed outside notices.** `statusFrom(notices, …)`; card `seenOfView(view, ['reviews','failing'])`.
`Failing` (warn) and `Runners` (bad/warn) KPI tones separate; the `Failing` figure counts ignored branches too.

---

## Mollie (`business/mollie.ts`)

| Notice id · where | Shape | Condition | Now | Subject · stable id | Nature — why | Lifts when · episode | Ignore wording | Watch check · Stop watching | Noise |
|---|---|---|---|---|---|---|---|---|---|
| `chargebacks` · mollie.ts:515 | static, groups N chargebacks | Unreversed chargebacks of the last 30 days | bad · url “Open in Mollie” (first one's payment) · dot yes | per chargeback · `MollieChargeback.id` (`chb_…`, stable); payment `paymentId` | **you** — accept or contest it; money decisions are a person's | Reversed, or 30 days pass · episode = chargeback id (an event: once ignored, that one is done) | “Ignore this chargeback” | “Chargebacks” · check | Red for 30 days for one chargeback. Split per chargeback so a new one alerts while the old one stays quiet |
| `failing` · :531 | static, counts over today's payments | ≥ 3 failed today and > 25 % of today's paid+failed | warn · url “Open Mollie” · dot yes | the account (payment ids exist but are aggregated) | **problem** — the assistant can see which method fails and whether checkout broke | Ratio drops, or midnight · episode = local day | “Ignore for today” | “Many payments failing” · check | 3 of 9 on a quiet day trips it; raise to ≥ 5 failed and ≥ 10 tried |
| `test-mode` · :543 | static | Every payment read is test mode | info · no link · dot no | the account | **fyi** | A live payment appears · — | “Don’t show this again” | n/a (setup hint) · n/a | — |

**Status computed outside notices.** `statusFrom(notices, 'Taking payments' …)`; card `seenOfView(view, 2)`
(Paid today, This month). `Failed today` KPI tone separate. MCP sign-in: page `cannotRead`, glance `{facts: []}`
(no notices at all).

---

## Moneybird (`business/moneybird.ts`)

| Notice id · where | Shape | Condition | Now | Subject · stable id | Nature — why | Lifts when · episode | Ignore wording | Watch check · Stop watching | Noise |
|---|---|---|---|---|---|---|---|---|---|
| `very-late` · moneybird.ts:384 | static, groups N invoices | Invoices more than 30 days late (`LATE_BAD_DAYS`), unpaid > 0 | bad · url “Open in Moneybird” (sales invoices) · dot yes | per invoice · `MoneybirdInvoice.id` (stable); `number` for words | **you** — chasing a customer, or agreeing a payment plan, is a person's call (and Whombat may not send) | Paid · episode = — per invoice (or the set of ids while grouped) | “Ignore until it’s paid” | “Invoices over 30 days late” · item (per invoice; per customer would also help) | Red for an invoice on a payment plan is harsh; warn is enough. Split per invoice |
| `bank` · :405 | static, count | More than 50 unmatched bank lines (`BANK_WARN`, read up to 200) | warn · url “Open Moneybird” · dot yes | the administration ⚠ count only (line ids exist) | **fyi** — bookkeeping chore, nothing broken | Under 50 · episode = count band (each further 50) | “Ignore until it’s under 50” | “Bank lines to match” · check | Owners who book quarterly are yellow for ever; a heads-up, not a dot |

**Status computed outside notices.** `statusFrom(notices, '<n> invoices overdue' | 'Nothing overdue')`; card
`seenOfView(view, 2)` (Outstanding, Overdue). `Overdue` KPI tone (warn on any late, bad over 30 days) and `Bank to
match` tone separate. No administration chosen: `cannotRead`, glance `{facts: []}`.

---

## Plausible (`business/plausible.ts`)

| Notice id · where | Shape | Condition | Now | Subject · stable id | Nature — why | Lifts when · episode | Ignore wording | Watch check · Stop watching | Noise |
|---|---|---|---|---|---|---|---|---|---|
| `no-visitors` · plausible.ts:383 | static (main site only) | Past noon, yesterday ≥ 50 visitors, today 0, nobody right now | warn · ask “Look into it” · dot yes | one site · `main.site` (domain) | **problem** — the assistant can check the site and its script | A visitor comes, or the day ends · episode = local day | “Ignore for today” | “Sites with no visitors” · item (per site) | Weekend drop on B2B sites (Friday 60, Saturday 0); compare with the same weekday last week. Uses the burrow's zone, not the site's `timeZone`. Only the main site is checked |

**Status computed outside notices — own rule.** `plausibleView` sets status itself (plausible.ts:474): **any**
notice → warn, badge = first title; no `statusFrom`. If an fyi line is ever added it would colour the badge, so the
filter must run before this. Card `seenOfView(view, 2)`.

---

## Todoist (`business/todoist.ts`) and Unraid (`unraid.ts`)

- **Todoist**: no notices (by design, todoist.ts:6: “a to-do list's overdue tasks are its owner's business, not a
  dot”). Status is always `ok` (todoist.ts:309); the `Overdue` KPI is warn-toned but never reaches the dot.
  “What Whombat watches” would be empty.
- **Unraid**: no page and no notices; its `seen` (health.ts:106) keeps only the hostname to find the server. Its
  notices come from the server page (out of scope here).

---

## Notes that cut across the kinds

1. **The health pass keeps no notices.** `KindSeen` (`registry.ts:15`) carries only the glance (status, facts,
   reason); `home/health.ts:164–183` stores the worst title as `reason`. To filter ignored notices out of the dot and
   to see a condition clear (which lifts “until it changes”), `seen` must return the notices (key, tone, nature) and
   the filter must run **before** `seenFromView`/`statusOf`/`statusFrom`.
2. **The desk keys looks by thing, not notice** (`desk/glance.ts:596–602`: key = thing id, reason = worst title).
   The desk's **Ignore** needs the reason's notice key on the glance (e.g. `reasonKey`), and the next-worst
   unignored notice then becomes the reason.
3. **The page status is the kind's own.** Every kind computes `view.status` from unfiltered notices; `page.ts:259`
   then appends the machine-disk notice and `genericNotices`. Either filter inside each kind or recompute the status
   in `page.ts` after filtering.
4. **Ids mix check and subject.** `full-volume_1`, `late-store1-…`: the key needs them apart (`check` +
   `subject`). Several ids go through `clip()`, which adds “…” past 120 characters, so long names can collide.
5. **KPI tones, bars and table dots** are computed from the raw read in every kind, not from notices. An ignored
   notice leaves them coloured on the page (not on the card, whose facts carry no tone). Decide whether ignoring
   also mutes them.
6. **Service-side dismissals to reuse**: TrueNAS **Dismiss** (`alert.dismiss`, non-critical, comes back when
   TrueNAS raises it again), Paperless **Mark seen** (`/api/tasks/acknowledge/`), Immich clearing failed jobs (to
   confirm). Each is a write that needs “manages it” and not Look only; Look-only readers need a Whombat-side
   ignore.

## Counts

60 notice ids (HubSpot/Pipedrive and GitLab/Forgejo counted once): **problem 34 · you 12 · fyi 14**. About a dozen
change nature with tone (temperatures, QNAP warm, Security Advisor suggestions, TrueNAS INFO alerts, PBS
forecast-only, PBS maintenance/removable, PBS restores, QNAP Unknown disks, Paperless duplicates, Immich paused with
nothing waiting), so nature should be set per occurrence, not per id.
