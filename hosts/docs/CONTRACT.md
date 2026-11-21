# Rackoon API contract (hub ↔ web UI)

The base contract is `docs/handoff/docs/API.md`; the fixtures in
`docs/handoff/sample-data/` are response bodies of the read endpoints and
must keep working unchanged as UI test data. This file lists **what Rackoon
adds or decides on top of it**. When this file and API.md disagree, this file
wins. Product name: **Rackoon** (replaces the placeholder "Fleet").

Base path `/api/v1`. JSON. GET responses carry an `ETag` and `Cache-Control: private, no-cache` (revalidate every time — API.md's `max-age=5` let guest state go stale after an action). Errors are `application/problem+json`
(`{type, title, status, detail, code}`).

## 1. Additions to read responses

All additions are optional for the UI: a fixture without them must still
render (treat missing as `null` / defaults below).

### `GET /fleet`
- `servers[].current.temp_limit_c` — limit of the hottest sensor (for the card's Temp dot). Missing → use 85.
- `servers[].current.temp_max_c` may be `null` (host without sensors) → card shows "—".
- `agents_connected` (number) top-level, for the "N agents connected" summary. Missing → count servers with `status != offline`.
- `pending_enrollments` (number) top-level. Missing → 0.
- `hints` (array) top-level: conditions worth watching on the selected group's online servers (see "Hints" below). Missing → `[]`.

### `GET /servers/{id}`
- `server.remote_control`:
  ```json
  {"console": false, "power": false, "agent_console": true, "agent_power": false,
   "console_reason": "Remote control is turned off for this server", "power_reason": "..."}
  ```
  `console`/`power` are the **effective** permissions for the current user on this server (hub toggle AND agent's local flag AND role). When false, `*_reason` says why (shown as the disabled button tooltip). Missing in fixtures → treat as `{console: true, power: true}` so the mockup states render.
  Since 2026-10-17 also `manage`, `agent_manage`, `manage_reason` (guest management, `docs/MANAGE.md`; operator, the hub's Manage switch and `[remote_control] manage` in agent.toml; reasons "Managing guests is turned off for this server" / "This host's agent does not allow managing guests yet: …"). Missing → `manage: false`.
- `server.collectors`: `[{"name": "docker", "ok": false, "error": "permission denied"}]`. A platform/section whose collector is not ok shows "Not reporting" with the error.
- `server.agent.connected` (bool), `server.agent.clock_skew_s` (number|null).
- Standard host `workloads`: contains **only the platforms present on the host** (keys `docker`, `incus`, `libvirt`). No key → no platform card. No platforms at all → the Workloads section is hidden.
- `virtualization` is `null` for hosts without KVM.
- `disks[]` (standard): add `smart: {"passed": true, "reallocated": 0, "pending": 0, "uncorrectable": 0}` (any field may be null), `written_tb` and `rated_tbw` may be `null` (then show wear percent only, no "of N TBW").
- `sensors[]`: unchanged keys (`max_24h_c` is the max over the **requested range**, query `?range=`; default 24h). Only groups present on the host are listed (0 to 6 entries; the 6th possible id is `ssd_hottest`, label "SATA SSD, hottest").
- Guest `console`: add `unavailable: {"spice": "SPICE is not available for this VM"}` — protocols the platform has but Rackoon cannot serve; show them **disabled** in the connection-type switch with the reason as tooltip.
- `GET /servers/{id}?range=24h` honors `range` for `sensors[].max_24h_c`.
- `hints` (array) top-level: this host's hints (see "Hints" below), `[]` while it is offline. Missing → `[]`.

- **Host health (2026-10-13)**, both views, from agents that report it (older agents: `system` null, lists empty):
  - `system`: `{package_manager, updates, security_updates, updates_checked_at, updates_error, reboot_required, reboot_reason, init_system, failed_count, failed_units[], time_synced, time_offset_ms, time_source, oom_kills, processes, steal_pct, pressure: {cpu, memory, memory_full, io, io_full}, package_task, package_last}` (`updates` null = unknown; PSI avg10 in %).
  - Since 2026-10-19 (operating-system updates, `docs/MANAGE.md` 2.9): `package_task` `{id: "pkg:<16 hex>", op: "check"|"install", started_at}` while a package task runs, else null; `package_last` `{op: "check"|"install", status: "ok"|"failed", finished_at, installed: int|null, message, code: "busy"|"timeout"|null}` for the last one that ended (kept across agent restarts), else null (also from agents that can't install updates). `installed` is null for a check. `updates_checked_at` is when the agent's updates check started: at or after `package_last.finished_at`, the counts were read after the task.
  - `network[]`: `{name, kind, up, carrier, speed_mbps, mtu, addresses[], master, members[], rx_mbps, tx_mbps, errors, drops}` (interfaces with an address and bonds first).
  - `volumes[]`: every filesystem (ZFS datasets excluded), pool and active Proxmox storage: `{entity, kind: fs|pool|storage, label, used_gb, total_gb, used_pct, full_in_days}` plus for filesystems `fs_type, device, inodes_pct, read_only, remote, error` and for pools `health, layout, scrub: {state, end, errors}, errors: {read, write, checksum}, frag_pct, faulted[], status`. `full_in_days` is the linear forecast from the last 7 days of `vol_pct:<entity>` (null: not filling up, under 24 h of history or more than a year away).
  - `arrays[]` (md, Unraid), `ups[]`, `gpus[]`, `fans[]`; `tasks[]` (`platform` `pve`: Proxmox tasks that failed in the last 48 h or still run; `incus`: Incus operations that failed in the last 48 h), Proxmox: `pve_replication[]`, `ceph`.
  - `disks[]` (both views): `health_reason` (why `failing`), `io: {read_mbs, write_mbs, util_pct, await_ms}`, and `smart` adds `self_test: {type, result, power_on_hours}, error_log, crc_errors, critical_warning, spare_pct, spare_threshold, media_errors, unsafe_shutdowns, standby`. `health` is `failing` for a failed SMART check, an NVMe critical warning, spare below its threshold, pending / uncorrectable sectors, media errors or a failed self-test.
  - Platform blocks: `paused` (count, omitted when 0) and `warnings[]` (`{type, message, count, last_seen, project}`: Incus warnings, Docker daemon warnings).
  - Guest objects may add (only when known): `addresses[]`, `lock`, `restarts`, `exit_code`, `oom_killed`, `project`, `update_available`, `disk_used_gb`, `processes`. Guest `state` may be `paused`.
  - Proxmox guests may add (2026-10-17, only when known): `tags[]`, `pending_changes` (configuration changes waiting for a restart, omitted when 0), `guest_agent` (`running` | `not_running`), `oldest_snapshot` (timestamp), `backup_job` (bool: an enabled backup job covers the guest), `ha_state`.
  - Docker guests on unRAID add `autostart` (bool: in dockerMan's autostart list), `template` (bool: a dockerMan template exists, so `container.update` works) and `web_ui` (the template's web page, `[IP]` and `[PORT:n]` filled in; omitted when unknown); their `update_available` is dockerMan's own check when it knows. libvirt guests add `autostart` on every host (2026-10-17, `docs/MANAGE.md` 2.6).
- **Unraid** (2026-10-17): `server.detail_view` is `unraid` for an unRAID server (Proxmox VE wins); the detail has the standard view's keys plus `unraid` (Whombat's `HostUnraidDetail`, snake_case; sizes in bytes; `null` where unRAID does not say):
  ```jsonc
  {"version": "7.3.1", "name": "BlackBox", "license": "Pro", "os_update": {"version": "7.3.3"},   // os_update null: up to date
   "array": {"state": "started",            // started | stopped | starting | stopping | invalid
             "state_raw": "STARTED", "start_on_boot": false, "size_bytes": 1999421128704, "used_bytes": 13974106112, "free_bytes": 1985447022592,
             "disabled": 0, "invalid": 0, "missing": 0, "mover_running": false,
             "parity": {"state": "idle",      // idle | running | paused
                        "action": null,       // running: check | correct | rebuild | clear
                        "pct": null, "speed_mbs": null, "eta_s": null, "errors": 0,
                        "last": {"at": "2024-07-10T18:32:54Z", "duration_s": 52, "speed_mbs": null, "errors": 0,
                                 "result": "cancelled",   // ok | errors | cancelled | failed
                                 "action": "check"},      // check | read_check | sync | rebuild | clear
                        "history": [/* runs, newest first, at most 10 */],
                        "schedule": null},    // "Monthly, day 1 at 00:30, no corrections"
             "disks": [{"name": "disk1", "slot": "data", "device": "sdi", "model": "WDC WDS200T1R0A-68A4W0", "serial": "…",
                        "status": "ok",       // ok | disabled | emulated | missing | new | invalid | wrong | empty
                        "status_raw": "DISK_OK", "size_bytes": 2000397885440, "used_bytes": 13974106112, "free_bytes": 1985447022592,
                        "fs_type": "xfs", "temp_c": 31, "spun_down": false, "errors": 0, "rotational": false}]},
   "pools": [{"name": "apps", "fs_type": "luks:btrfs", "profile": "raid10", "size_bytes": …, "used_bytes": …, "free_bytes": …, "disks": [/* slot "pool"; used/free on the first only */]}],
   "flash": {/* a disk, slot "flash" */},
   "shares": [{"name": "Media", "comment": "", "used_bytes": …, "free_bytes": …, "primary": "data", "secondary": null,
               "mover_action": null,  // to_array | to_pool
               "smb": "private",      // public | secure | private | null (not exported)
               "nfs": false, "encrypted": true}],
   "plugins": [{"name": "tailscale", "file": "tailscale.plg", "version": "2026.10.08.2310", "update": null, "author": "…", "support_url": null}],
   "notifications": [{"id": "Docker_high_image_disk_utilization_1792197901", "at": "…", "importance": "warning",   // alert | warning | normal
                      "event": "Docker high image disk utilization", "subject": "Warning [BLACKBOX] - …", "description": "…"}],  // unread, newest first, ≤ 50
   "docker": {"enabled": true, "image_used_pct": 78}, "vms": {"enabled": true}}
  ```
  The array's disks leave out empty slots and parity slots without a disk; `disabled` / `invalid` / `missing` count installed slots. The Unraid array is also in `arrays[]` (`level` `unraid`); an array without parity is `clean`.
- **libvirt / QEMU/KVM** (2026-10-17, IU-13): `server.detail_view` is `libvirt` for a host whose VMs libvirt runs and that is not Proxmox VE, unRAID or Incus (precedence `proxmox` > `unraid` > `incus` > `libvirt` > `standard`; the UI says “QEMU/KVM”). On **every** host with libvirt (an unRAID server too) the detail has `libvirt` (Whombat's `HostLibvirtDetail`, snake_case; `null` where libvirt does not say):
  ```jsonc
  {"version": "11.3.0", "qemu": "10.0.13",
   "pools": [{"name": "default", "type": "dir", "active": true, "autostart": true, "path": "/var/lib/libvirt/images",
              "used_bytes": 610000000000, "total_bytes": 1900000000000, "avail_bytes": 1290000000000, "volumes": 5}],
   "networks": [{"name": "default", "active": true, "autostart": true, "bridge": "virbr0", "forward": "nat", "ipv4": "192.168.122.1/24", "dhcp": true, "used_by": 3}],
   "folders": null,                      // unRAID: {"domains": "/mnt/user/domains", "isos": "/mnt/user/isos"} (pools [] there)
   "firmware": {"uefi": true, "secure_boot": true, "tpm": true},
   "backups_dir": "/var/lib/libvirt/images/.whombat-backups"}
  ```
  libvirt guests add (when known) `last_backup` (`{result, at}`, the newest Whombat backup) and `last_snapshot` (time of the newest snapshot); older agents send neither and no `libvirt` block.
- Cluster nodes: `agent` is `connected`, `offline` (enrolled, not connected) or `not_enrolled`; `server_id` names the enrolled server.
- **Incus and the self guest (2026-10-17, IU-02 / IU-03 / IU-04)**:
  - `server.detail_view` may be `incus` (a host running Incus that is neither Proxmox VE nor Unraid) or `unraid`; precedence `macos` > `proxmox` > `unraid` > `incus` > `libvirt` > `standard`. Unknown values → treat as `standard`. The same in `GET /servers` and the fleet cards.
  - `server.hosts_this_whombat: true` (only when true; also in `GET /servers` items and fleet cards): one of the host's guests is the machine the hosts service runs in.
  - Guest objects add `self: true` (only when true) for that guest: its MAC (agents report every Incus, Proxmox VE and libvirt guest's MACs) is one of the hub machine's own. Changing it outside the allow list answers 409 `self_guest` (`docs/MANAGE.md` 1).
  - `incus` (any view, when the agent reports it): `{version, clustered, projects[{name, description, instances, running}], pools[{name, driver, status, description, used_bytes, total_bytes, volumes}], networks[{name, type, managed, description, ipv4, ipv6, nat, used_by}], profiles[{name, project, description, used_by}], images[{fingerprint, aliases[], description, type: container|virtual-machine, architecture, size_bytes, uploaded_at, last_used_at, auto_update, cached, project}], volumes[{pool, name, project, type: "custom", content_type: filesystem|block|iso, size_bytes, used_bytes, used_by[] (hub guest ids), description}]}`; bytes, addresses and times are `null` when unknown, `used_by` of networks and profiles is a count. Missing → no Incus view.

### `GET /servers/{id}/metrics`
- Adds `summary`: `{"cpu_pct": {"avg": 34.1, "max": 58.0, "max_at": "..."}, ...}` per returned series (avg/max over the range from stored avg/max). `null` when no data.
- Series names: `cpu_pct`, `mem_pct`, `temp_<sensor id>_c` (e.g. `temp_cpu_package_c`), `guest_disk_io_mbs`, `guest_net_mbps`; since 2026-10-13 also `load1`, `swap_pct`, `net_rx_mbps`, `net_tx_mbps` (host interfaces, Mb/s), `disk_read_mbs`, `disk_write_mbs` (physical disks, MB/s), `temp_max_c` and `vol_pct:<volume entity>`.
- Steps per range exactly as API.md 2.4 (1h 60×60 s, 6h 72×300 s, 24h 96×900 s, 7d 84×7200 s, 30d 120×21600 s), plus `90d` (120×64800 s, 15 min tier). `timestamps[i]` is the **end** of bucket i; the last one is ≤ `as_of`.
- **Custom window**: `?from=<RFC 3339>[&to=<RFC 3339>]` instead of `range` (at least 10 minutes, within the last 90 days; `to` defaults to now): about 120 buckets from the finest tier that covers it; `range` is `"custom"` and `as_of` the window's end. 400 `invalid_range` otherwise.

### `GET /servers/{id}/guests/{guestId}/metrics?range=|from=&to=` (new)
A guest's history, as the host metrics: series `cpu_pct`, `mem_mb`, `net_rx_mbps`, `net_tx_mbps`, `disk_read_mbs`, `disk_write_mbs`, sampled once a minute while the guest runs (up to 300 running guests per host, busiest first), plus `guest`.

### `GET /servers/{id}/annotations?range=|from=&to=` (new)
Chart markers in the window, oldest first, at most 200: `[{"at": "...", "kind": "alert|reboot|action|agent", "severity": "warning", "text": "nvme1n1 wear at 78%"}]` — alerts opened, the host's boot, finished power / snapshot / host actions and agent updates (from the audit log).

### `GET /guests?q=&state=&platform=&kind=&server=&tag=&sort=&limit=&cursor=` (new)
The fleet-wide guest list (the Guests page and the server menu's search). Viewer access.
```json
{"guests": [{"server": "basalt", "server_online": true, "id": "incus:nixbuild", "name": "nixbuild", "platform": "incus", "kind": "vm", "image": "nixos/26.05", "state": "running", "vcpu": 8, "cpu_pct": 21.5, "memory_used_mb": 10035, "memory_limit_mb": 16384, "disk_read_mbs": 42, "disk_write_mbs": 118, "net_rx_mbps": 12, "net_tx_mbps": 4, "snapshots": 3, "uptime_s": 518400, "console": {"available": true, "protocols": ["spice", "serial"], "default_protocol": "spice", "resolution": "1280x800"}}],
 "total": 1, "next_cursor": null,
 "counts": {"all": 1, "running": 1, "stopped": 0, "unhealthy": 0},
 "platforms": {"incus": 1}}
```
- `guests[]` are guest objects (API.md 2.3, the keys of `GET /servers/{id}/guests`) with `server` (id) and `server_online` first. Offline servers are listed from their last report with `server_online: false`.
- Filters: `q` case-insensitive substring of name, id or image (optional); `state` = `running|stopped|unhealthy`; `platform` = `docker|incus|libvirt|pve`; `kind` = `vm|container`; `server` = server id. Other values → 400 `invalid_state` / `invalid_platform` / `invalid_kind`.
- `counts` and `platforms` cover the guests matching `q` and `server` **before** the `state` / `platform` / `kind` filters (for the filter chips); `platforms` only lists platforms with guests. `total` is the count after every filter; `guests` is the page.
- `tag` (2026-10-17) keeps guests with that tag (case-insensitive, exact); `tags` (tag in lower case → guests) covers the same guests as `counts`. Missing → `{}`.
- Order: with a `q`, exact name matches first, then name prefixes, other name matches, then id/image-only matches, each group in `sort` order; without one, `sort` alone. `sort` = `cpu` (default) `|memory|name|state|server` with an optional `-` / `+` prefix (cpu and memory descend by default). The default order is running (and unhealthy) guests by CPU, then stopped, ties by name, then server; `server` groups by server id with that order inside.
- `limit` defaults to 100, at most 500; `cursor` is the previous page's `next_cursor` (`null` on the last page).

- **Macs (2026-11-17, Whombat MAC-01…MAC-11)**: `server.detail_view` is `macos` for a Mac's agent; `os_family` (`linux` | `macos`, absent before the first report) is on the fleet cards, `GET /servers` items and `server`; a Mac's `os` is `macOS 27.2.1`. The detail has the standard view's keys plus `macos` `{version, build, model, model_name, chip, sip, filevault, auto_login, console_user, screen: {sharing, account, sign_in, sign_in_at, locked, w, h}, helper: {installed, version, running, ax, user}}` (REST-API "Fleet and servers"; `null` where the Mac doesn't say). A Mac's disks fail the existing SMART rule when `diskutil`'s verdict is one other than `Verified` (“Not Supported” is unknown).

### Hints: `hints[]` of `GET /fleet` and `GET /servers/{id}` (new)
Conditions worth watching that are not (yet) alerts, computed by the hub from each host's **latest report** (no history, no state: a hint appears and disappears with the report). `GET /fleet` carries the hints of the selected group's online servers, warnings first, then by server id and title; `GET /servers/{id}` carries that host's (empty while it is offline or has not reported). Missing in fixtures → `[]`.
```json
{"server": "obsidian", "id": "guests.unhealthy:docker", "kind": "guests.unhealthy", "severity": "warning", "entity": "docker",
 "title": "1 container unhealthy", "detail": "pihole", "link": "#guests"}
```
`id` (since 2026-10-22, HS-192) is `<kind>:<entity>`, stable while the hint stays and unique within its server (`GET /fleet` lists several servers: `server` + `id` is unique there); a hint about something else gets another id (`libvirt.no_backup`'s entity is the guest's id while it names one VM and `libvirt` for several, so its id changes with that).
`severity` is `warning` or `info`. `link` is the detail-page section (`#temps`, `#storage`, `#virtualization`, `#guests`, `#agent`) or `""`. `entity` is the sensor id, disk device, volume (`fs:<mount>`, `pool:<name>`, `storage:<id>`, as in alerts), collector name, `docker` or `host`. A hint is skipped while an open alert covers the same entity (a sensor whose `sensor.temp_high` fired, a disk with a wear alert).

| `kind` | Condition | Severity | Title / detail |
|---|---|---|---|
| `sensor.near_limit` | sensor at ≥ 70% of its limit, no open temperature alert for it | `warning` at ≥ 85% (the alert needs 10 min), else `info` | `CPU package at 80 °C` / `94% of the 85 °C limit` |
| `swap.high` | swap ≥ 1 GiB and ≥ 80% used, while RAM is ≥ 80% used (a full swap beside free memory is idle pages, no problem) | `warning` at ≥ 90%, else `info` | `Swap almost full` / `7 GB of 8 GB used · RAM 91% used` |
| `memory.low` | available memory < 10% of total | `warning` below 5%, else `info` | `Memory almost full` / `6 GB available of 64 GB` |
| `disk.space` | filesystem, pool or active Proxmox storage 80–89% full (≥ 90% is the alert) | `info` | `/srv 85% full` / `850 GB of 1 TB used` |
| `disk.wear` | SSD wear 60–74% (≥ 75% is the alert) | `info` | `Disk nvme0n1 is 62% worn` / `372 of the 600 TB it’s built to write` |
| `collector.error` | a collector reports `ok: false` | `warning` | `Whombat can’t read this server’s apps` / its error, or `It didn’t say why.` |
| `guests.unhealthy` | Docker containers in state `unhealthy` (one hint per host) | `warning` | `3 apps aren’t working properly` (one: `1 app isn’t working properly`) / up to five names, then `…` |
| `agent.outdated` | the agent's version differs from the hub's | `info` | `Whombat’s helper on this server is out of date` / `It runs 0.14.2, Whombat 0.15.0.` |
| `system.failed_units` | failed systemd units / services | `warning` | `2 services failed` / up to five names, `.service` left off (`cleanup, backup.mount`) |
| `system.updates` | pending package updates | `info` (also with security updates: routine on most hosts) | `17 updates waiting` / `6 security updates` (empty without security updates) |
| `system.reboot` | a reboot is required (newer kernel, `/run/reboot-required`) | `info` | `Restart needed` / `To finish installing updates` |
| `disk.counters` | reallocated sectors or CRC errors, no SMART alert open | `info` | `Disk sda has had a few errors` / `8 worn spots replaced · 1 cable error` (was `8 reallocated sectors · 1 CRC error (cable or connector)` |
| `pool.scrub` | a pool never scrubbed, or not for 45 days | `info` | `Storage “tank” hasn’t been checked for damage lately` / `Last checked 2 Aug 2026` |
| `raid.sync` | an array resyncs, recovers or checks | `info` | `md0’s disks are syncing (42%)` / `It’s slower until it’s done` |
| `backup.warning` | the last vzdump job ended with warnings | `info` | `The last backup had a problem` |
| `platform.warnings` | Incus / Docker / libvirt warnings | `info` | `Incus 1 warning` / the first message |
| `docker.image_updates` | containers whose registry has a newer image | `info` | `3 apps have updates` / two names and how many more (`web, db and 1 more`) |
| `cpu.steal` | CPU steal ≥ 10% (the host is a VM) | `info` | `This server is slowed down by its host` |
| `disk.forecast` | a volume forecast full within 30 days (7 days is the alert `disk.full_soon`) | `info` | `/srv full in about 20 days` |
| `guest.backup_old` | Proxmox guests in a backup job whose last good backup is older than 8 days, whose last backup failed, or without one although they ran before the node's last job (none while `backup.failed` is open); one hint per host, entity `pve` | `warning` | `2 machines need a backup` / `web (12 days), dns (failed)` |
| `guest.no_backup_job` | Proxmox guests (not templates) no enabled backup job covers; one hint per host | `info` | `3 machines aren’t in a backup plan` / names |
| `guest.agent_down` | running VMs whose enabled QEMU guest agent does not answer; one hint per host | `info` | `1 machine doesn’t report what’s inside` / names |
| `guest.pending_changes` | guests with configuration changes waiting for a restart; one hint per host | `info` | `2 machines need a restart to apply changes` / `web (2 changes), ct (1 change)` |
| `guest.snapshot_old` | guests whose oldest snapshot is older than 30 days; one hint per host | `info` | `1 machine has snapshots older than 30 days` / `db (45 days)` |
| `storage.overcommit` | a thin Proxmox storage whose guest disks add up to more than its size (none while `disk.space_high` is open for it), entity `storage:<id>` | `info` | `Storage “local-zfs” has promised more space than it has` / `Its machines may grow to 520 GB; it holds 400 GB (130%)` |
| `incus.no_snapshots` | running Incus instances of the `default` project (another project's are a tool's: CI jobs, agents' sandboxes) without a snapshot schedule (own or a profile's) and without a backup in the last 30 days, created more than a day ago (agents that report schedules); one hint per host, entity `incus`, link `#guests`, `guests` = their hub ids | `info` | `2 machines aren’t backed up` / `web, db · no scheduled snapshots, no backup in 30 days` |
| `incus.pool_full` | an Incus storage pool at 85 % or more, entity `incus-pool:<name>`, link `#storage` | `warning` from 95 %, else `info` | `Storage “default” 87% full` / `… used` |
| `incus.warning` | Incus' own warnings (instead of `platform.warnings` for Incus), entity `incus`, link `#system` | `info` | `Incus has 1 warning` / the first message (`(+2 more)`) |
| `macos.screen_sharing_off` | a Mac whose Screen Sharing doesn't answer, entity `screen`, link `#screen` | `info` | `Screen Sharing is off` / `Turn it on in System Settings → General → Sharing so Whombat can see the screen` |
| `macos.screen_sign_in` | the Mac's screen account was refused at its last check, entity `screen`, link `#screen` | `warning` | `Whombat can’t sign in to the Mac’s screen` / `The Mac’s password was refused; set it again` |
| `macos.helper_no_access` | Whombat Helper runs without Accessibility, entity `helper`, link `#screen` | `info` | `Whombat Helper needs Accessibility` / `Switch it on in Privacy & Security → Accessibility` |
| `macos.agent_folder` | the Mac's agent runs from a folder someone other than root can change (Homebrew's `/usr/local/bin` on an Intel Mac; the report's `macos.agent_folder`), entity `agent`, link `#agent` | `info` | `Whombat’s agent is in a folder others can change` / `Run the Mac’s install command again to move it out of /usr/local/bin` |
| `macos.helper_off` | Whombat Helper is installed but hasn't answered in the session of the person at the screen for 5 minutes (the one hint with history: the hub remembers since when), entity `helper`, link `#screen` | `info` | `Whombat Helper isn’t running` / `It isn’t running for alice` |
| `memory.limit` | processes the kernel killed in the last hour because a guest or another cgroup reached its own memory limit, not the machine (agents that report `oom_limited`, LM-04; the machine running out is the alert `host.oom`): one hint per guest (entity and `guests` its hub guest id, link `#guests`) and one for other cgroups (entity `host`, link `#system`) | `info` | one per machine: `web ran out of its memory 2 times` / `node and java were stopped, the last 2 min ago. The server itself has memory to spare.`; kills outside machines (a service’s or a session’s own limit) give none |

Hints may carry `guests` (hub guest ids, only on per-host guest hints that name guests, so far `incus.no_snapshots` and a guest's `memory.limit`): the way out can open the guest.

| `unraid.array_stopped` | the unRAID array is stopped (or `invalid`), entity `raid:unraid`, link `#array` | `warning` | `Array stopped` / `Its shares, containers and VMs are not available until it starts` |
| `unraid.parity_errors` | the last finished parity check found errors | `warning` | `Last parity check found 12 errors` / `Checked Sep 7, 2026 · check again with corrections` |
| `unraid.parity_old` | the array has a parity disk, is started and idle, and no check finished in 35 days (or ever) | `info` | `Parity not checked recently` / `Last check Sep 7, 2026`; `Parity never checked` |
| `unraid.disk_errors` | array or pool disks with read/write errors (`numErrors`), one hint | `warning` | `disk1 has read or write errors` / `disk1 (3 errors)` |
| `unraid.pool_full` | a pool 90 % full (none while `disk.space_high` is open for `fs:/mnt/<pool>`), entity `pool:<name>` | `warning` | `Storage “cache” 95% full` |
| `unraid.plugin_updates` | plugins with an update, link `#plugins` | `info` | `2 plugin updates` / names |
| `unraid.notification` | an unread unRAID notification of importance alert (`warning`) or warning (`info`), at most 5 (alerts first); **entity = the notification id** (what `notification.archive` takes) | `warning` / `info` | its subject (or event) / its description |
| `unraid.os_update` | a newer unRAID (unRAID's own check) | `info` | `Unraid 7.3.3 is available` / `Update it in Unraid’s own page (it needs a reboot)` |
| `docker.update_available` | on unRAID instead of `docker.image_updates`: containers whose image has an update; entity `docker`, link `#guests`, **every name in `detail`, comma separated** (up to 50) | `info` | `2 apps have an update` / `plex, radarr` |

| `libvirt.pool_full` | a libvirt storage pool 85 % full (none while `disk.space_high` is open for `fs:<pool path>`), entity `libvirt-pool:<name>`, link `#storage` | `info`, `warning` from 95 % | `Storage “vms” 91% full` / `… free` |
| `libvirt.no_backup` | running libvirt VMs with neither a Whombat backup nor a snapshot in 30 days (counted from the report's time; agents that report the `libvirt` block with a backups folder); one hint per host, entity `libvirt`, or the guest id (`libvirt:web`) when it is one VM; link `#guests` | `info` | `2 machines have no recent backup` / `web, db`; one: `web has no recent backup` / `No backup or snapshot in the last 30 days` |

On an unRAID server `raid.degraded` (the alert) links to `#array`.

The guest kinds above are routine like the ones below (one row per kind and host, the guests in `detail`).

The overview folds routine kinds (`system.updates`, `system.reboot`, `docker.image_updates`, `agent.outdated`, `disk.counters`, `pool.scrub`) into one row per kind when several hosts have them.

### `GET /fleet/series?group=&range=`
As API.md 2.2. Sparklines: 60 points per range; heatmap: 48 buckets; `null` for gaps.

### Managing guests (2026-10-17)
Guest configuration and lifecycle on Proxmox VE, Incus and libvirt (QEMU/KVM, `docs/MANAGE.md` 2.8, REST-API "libvirt"), and unRAID's array, parity, disks, mover, plugins, notifications, container updates and autostart (`docs/MANAGE.md`): the routes, bodies and answers are in `docs/REST-API.md` "Manage" (and its "Unraid" part) and `web/src/api/manage.ts`. Problems of these routes may carry `field_errors` (`{field: message}`). Since the Incus build: the `/incus/…` routes (profiles, volumes, images, leases), guest rename, move, publish and log, the Incus fields of create, clone, backups, restore and choices, 409 `in_use` and `self_guest`, and `new_id` in `task.finished` when a task made an image. Since 2026-10-19: `POST /servers/{id}/packages/check` and `/packages/install` (REST-API "Operating-system updates"), `pkg:` tasks (`GET`/`DELETE /servers/{id}/tasks/pkg:…?platform=host`) whose status adds `packages: {installed, kept_back[], warning}` and `code` once ended, and `code` in `task.finished` when the task ended with one.

## 2. Authentication (single admin account, roles kept in the backend)

| Method and path | Body / result |
|---|---|
| `GET /auth/state` | `{"setup_required": bool, "authenticated": bool, "user": {"name": "john", "role": "admin"} \| null, "passkeys": 0, "csrf_token": "..."}` |
| `POST /auth/setup` | `{"setup_token", "username", "password"}` → 204 + session cookie. Only while `setup_required`; the setup token is printed in the hub log on first start. |
| `POST /auth/login` | `{"username", "password"}` → 204 + session cookie; 401 `invalid_credentials` |
| `POST /auth/passkey/login/begin` | → WebAuthn `PublicKeyCredentialRequestOptions` (JSON, base64url) |
| `POST /auth/passkey/login/finish` | assertion JSON → 204 + session cookie |
| `POST /auth/passkey/register/begin` / `finish` | (authenticated) add a passkey |
| `GET /auth/passkeys` / `DELETE /auth/passkeys/{id}` | list / remove passkeys |
| `POST /auth/password` | `{"current", "new"}` change password |
| `POST /auth/logout` | 204 |

- Session cookie `rackoon_session`: `HttpOnly; Secure (when the public URL is https); SameSite=Lax`, 30-day sliding lifetime.
- **CSRF**: every non-GET request must send header `X-CSRF-Token` equal to `csrf_token` from `/auth/state` (bound to the session). Missing/invalid → 403 `csrf`.
- Unauthenticated API calls → 401 `unauthenticated`; the UI shows the login page (or the setup page when `setup_required`).
- Roles `viewer | operator | admin` exist in the backend and are enforced on every endpoint (console/power need operator; enrollment, server settings and audit need admin). Users are managed under Settings › Users; `docs/REST-API.md` documents every route, including users, single sign-on, tokens and `/metrics`.

## 3. Servers, enrollment, agents (admin)

| Method and path | Body / result |
|---|---|
| `POST /enrollments` | `{}` → 201 `{"id", "token", "expires_at", "install_command"}` (token single use, 1 h) |
| `GET /enrollments?state=pending` | `[{"id", "hostname", "os", "address", "agent_version", "requested_at"}]` |
| `POST /enrollments/{id}/approve` | `{"group": "Lab", "name": "thetitan"}` → 200 `{"server_id"}` |
| `POST /enrollments/{id}/reject` | 204 |
| `PATCH /servers/{id}` | `{"group"?, "location"?, "remote_control"?: {"console": bool, "power": bool}}` → 200 server settings (the hub also takes `host_shell`, `host_power` and `manage`, see `docs/REST-API.md`) |
| `GET /servers/{id}/settings` | `{"id", "group", "location", "remote_control": {"console", "power"}, "agent_policy": {"console", "power"}}` (plus `host_shell`, `host_power`, `manage` in both) |
| `DELETE /servers/{id}` | 204; revokes the certificate, closes live sessions |
| `GET /agents` | `[{"server_id", "hostname", "version", "connected", "last_seen", "address", "clock_skew_s", "collectors": [...], "remote_control": {...}, "agent_policy": {...}}]` |
| `GET /groups` | `["Production", "Lab", "Edge"]` (distinct labels in use) |
| `GET /audit?limit=100&cursor=` | `{"items": [audit record], "next_cursor": null}` (fields per REMOTE-CONSOLE.md 8) |
| `GET /audit/export` | `text/csv` |

Remote control (console and power) is **off** on a newly approved server.

## 4. Console

`POST /servers/{id}/guests/{guestId}/console-sessions` exactly as API.md 3, response:

```json
{"session_id": "cs_…", "url": "/api/v1/console/cs_…", "token": "…", "protocol": "vnc",
 "expires_at": "…", "idle_timeout_s": 900}
```

`url` is relative to the UI origin; the browser converts it to `wss://` (or `ws://` on plain-HTTP dev).

**WebSocket upgrade:** `new WebSocket(url, ["rackoon.console.v1", "rackoon.token." + token])`. The hub validates `Origin`, the token (30 s, single use, bound to user/server/guest/protocol), and answers with subprotocol `rackoon.console.v1`. `binaryType = "arraybuffer"`.

**Frames** (see `internal/wire/wire.go`): every binary WebSocket message is one frame `kind (1 byte) | channel (uint16 BE) | payload`.

- kind 0 = data for `channel` (PTY bytes, RFB bytes, SPICE bytes). Channel 0 is open from the start.
- kind 1 = control; payload is JSON `ConsoleControl`:
  - browser → agent: `{"type":"resize","cols","rows"}`, `{"type":"open","channel":N}` / `{"type":"close","channel":N}` (SPICE sub-channels), `{"type":"ping","id":N}`, `{"type":"activity"}` (user typed / moved the mouse; send at most every 30 s — drives the 15 min idle timeout)
  - agent → browser: `{"type":"status","state":"connected","protocol":"vnc","resolution":"1024x768"}`, `{"type":"opened","channel":N}`, `{"type":"closed","channel":N}`, `{"type":"pong","id":N}`, `{"type":"error","code","message"}`
  - hub → browser: `{"type":"closed","reason":"idle_timeout|max_age|revoked|remote_control_disabled|agent_disconnected|guest_stopped"}` then the socket closes.
- Latency shown in the status line = round trip of `ping`/`pong` (send every 5 s).

**Clients:**
- `shell` / `tty` / `serial`: xterm.js. Data = terminal bytes (UTF-8). Send `resize` after open and on every fit.
- `vnc`: noVNC `RFB` with a WebSocket-like adapter for channel 0 (the hub/agent already authenticated to the guest; the browser sees RFB security type None). Ctrl+Alt+Del = `rfb.sendCtrlAltDel()`. Paste = type the text as key events (cap 64 KB, strip control characters other than newline/tab).
- `spice`: spice-html5 (vendored) with a WebSocket factory: each SPICE channel connection becomes one rackoon channel (`open` → wait for `opened`).

**Actions:** `POST /servers/{id}/guests/{guestId}/actions` `{"action", "confirm": true}` → 202 `{"action_id", "audit_id"}`; result as SSE `action.finished` `{"action_id", "server", "guest", "action", "result": "ok"|"error", "message", "state"}`. `ctrl_alt_del` is sent through the console instead; `screenshot` returns `GET /servers/{id}/guests/{guestId}/screenshot` (`image/png`, needs console permission).

**Thumbnails:** `GET /servers/{id}/guests/{guestId}/thumbnail` → `image/jpeg` ≤ 320 px wide, `Cache-Control: no-store`; 409 `guest_not_running`, 404 `no_screen` (containers: the tile shows a terminal placeholder), 403 when console permission is missing.

## 5. Event stream

`GET /events` (SSE) per API.md 5, plus `enrollment.pending` `{id, hostname}`, `server.settings_changed` `{id}`, `console.closed` `{session_id, reason}`. Event `retry: 5000`. The UI refetches the affected queries on events.

## 6. Units and formats

As API.md 1. Guest `cpu_pct`: VMs and Incus/LXC containers = percent of configured vCPUs (0–100); Docker = docker-stats convention (100 = one core; bars are capped at 100%).

## 7. Hub implementation notes (additive; the hub as built)

Everything here is an addition or a precision; nothing above changes. A UI
built against the fixtures keeps working; the notes say what the real hub
sends on top.

### 7.1 Read responses

- **Never-reported server** (approved, agent not connected yet): `status: "offline"`, `status_note: "never connected"`; `os`, `cpu`, `memory_total_gb`, `storage_capacity_tb`, `last_seen`, `current`, `last_known` are `null`.
- `GET /fleet`: `servers[]` add `hostname` (the id is the slug), `agent_connected`, `open_alerts`; `hypervisor.host_memory_gb`. `platform_summary` adds server counts: `docker.servers`, `incus.servers`, `qemu.libvirt_servers`, `qemu.proxmox_servers` (for "Engine on N servers", "libvirt on N · Proxmox VE on M"). Alerts add `state`, `resolved_at`, `link`. Alerts are ordered critical first, then oldest. Open alerts of offline servers count in `kpis.open_alerts`. A host with an open **critical** alert (other than the heartbeat) is `warning` too (status has no third value). Since 2026-10-22 (HS-190) only alerts that ask for attention (`attention: true`: not acknowledged, muted or suppressed) make a host `warning` and give its `status_note`; an acknowledged warning leaves it `online`.
- `GET /fleet/series`: `kpi.timestamps` and `heatmap.timestamps` are the bucket ends (`servers.*` share `kpi`'s grid). `kpi.mem_pct` is weighted by host RAM (sum used / sum total, like the tile). Bucket boundaries are aligned to the step; when `as_of` is not on a boundary **the last bucket is the current, partial one and its timestamp is `as_of`** (so 1h/6h include the newest samples). Same for `GET /servers/{id}/metrics`: all `timestamps` are step-aligned except the last, which equals `as_of` (identical to API.md when `as_of` is aligned, e.g. the fixture).
- `GET /servers`: a bare array of `{id, hostname, group, status, status_note, os, detail_view, os_family, last_seen, agent_connected, open_alerts}` in card order.
- `GET /servers/{id}`: adds `range`; `server.hostname`, `server.open_alerts` (for "Warning · 1 alert"), `server.pve_version`, and `server.detail_view` always. `banner` adds `rule`, `alert_id`. `server.last_boot` is a full timestamp (`2026-08-31T07:12:00Z`; format the date in the viewer's zone). While the server is offline every section shows the **last report** (stale): `live.as_of` (added) is when that report was received, `server.uptime_s` is `null`; `live` is `null` only for a server that never reported. `live.mem_cache_gb` and `live.zfs_arc_gb` are both always present (`null` when unknown); the Proxmox page shows ZFS ARC, the standard page Cache. `sensors[].group` is always present. Standard `disks[]` add `pool`; `written_tb`/`rated_tbw` are present (null on HDDs and when unknown). Proxmox `disks[]` add `type`, `health`.
- Workload blocks (`workloads.*`, `guests.vm|container`) add `stopped`, `unhealthy`, `version`, `error` (non-null: "Not reporting" with that error). `cpu_pct` = share of the **host** CPU used by the platform's running guests; `memory_gb` = their used memory. `guests_shown` is always present; `guests[]` is the first page: up to 50, running first by CPU. Incus `containers`/`vms` count running instances.
- `virtualization`: `capabilities.ksm.running`; `ballooning` has `state`, `vms_active`, `vms_total` in both views (`active` when any running VM has an active balloon); `allocation.guest_memory_assigned_pct`. All allocation values are derived from the guest lists (running VMs).
- `cluster` is `null` for a standalone Proxmox node. `cluster.ha.resources_total`; `nodes[].server_id`; `nodes[].agent` may also be `"offline"` (enrolled, agent not connected). `note` is `null` when every node has an agent.
- `storages[]` add `content_types` (raw Proxmox content list), `used_pct`, `shared`, `active`. `content` is built from the content list plus the storage's pool/path ("VM and container disks · rpool mirror").
- Guest objects: `vcpu` is `null` when unknown; Docker `last_exit` is an ISO timestamp (the fixture's `"6 h ago"` is display text).
- `GET /servers/{id}/guests?platform=&kind=&q=&sort=&limit=&cursor=` → `{"guests": [...], "total": N, "next_cursor": "..."|null}`. `platform` = `docker|incus|libvirt|pve` (or the Proxmox tab names `vm`/`ct`), `kind` = `vm|container`, `q` matches name/id/image, `sort` = `cpu` (default) `|memory|name|state` with optional `+`/`-` prefix, `limit` ≤ 500.
- `GET /servers/{id}/metrics`: `summary.max_at` is exact for 1h/6h (raw samples) and the start of the 1 min / 15 min rollup bucket for longer ranges. Unknown series names come back as all-`null` arrays with a `null` summary. Without `series=` every stored series of the server is returned.
- `GET /alerts?state=open|resolved|all&group=&server=&limit=` → array (default `open`).
- `GET /groups` is readable by every role.

### 7.2 Auth details

- `GET /auth/state` adds `passkeys_available` (false unless `--public-url` is https with a host name, or `http://localhost`). Before sign-in it returns a pre-session `csrf_token` (double-submit cookie `rackoon_csrf`, path `/api/v1/auth`) that `setup`, `login` and `passkey/login/*` require in `X-CSRF-Token`; after sign-in fetch `/auth/state` again for the session-bound token.
- Passkeys: `register/begin` (optional body `{"name"}`) and `login/begin` return go-webauthn's `{"publicKey": {...}}` (binary fields base64url): pass `.publicKey` to `PublicKeyCredential.parseCreationOptionsFromJSON` / `parseRequestOptionsFromJSON`. The `finish` bodies are the browser's `credential.toJSON()`. `register/finish` → 201 `{id, name}`; `login/finish` → 204 + session cookie. Begin and finish are tied by a 5-minute HttpOnly cookie. Sign-in uses discoverable credentials (no user name).
- Login, setup and password change are rate-limited per client IP (10 failures / 5 min → 429 `rate_limited` with `Retry-After`). Changing the password signs out every other session.
- Non-GET requests with an `Origin` header from another origin are refused (403 `bad_origin`) even with a valid CSRF token.

### 7.3 Admin

- `GET /enrollments?state=pending|issued|approved|rejected|expired|all` (default `pending`); items add `state`, `created_at`, `expires_at`, `server_id`. A claimed (pending) enrollment waits 1 h for approval.
- `POST /enrollments/{id}/approve`: the server id is the slug of `name` (default: the reported hostname), e.g. "The Titan" → `the-titan`; `group` defaults to "Ungrouped" ("All" is reserved). 409 `server_exists`, 409 `not_pending`.
- `DELETE /servers/{id}` also deletes the server's metrics and alerts (the audit log is kept) and publishes `server.deleted {id}`.
- `GET /agents` items add `status`, `group`, `location`, `cert_expires_at`.
- `GET /audit` filters: `server=`, `event=` (exact, or a prefix ending in `.` like `console.`); `next_cursor` is a string. Events: `console.requested|denied|opened|closed|switched|screenshot`, `action.requested` (outcome `denied` for refused requests) `|finished`, `remote_control.enabled|disabled` (`details.capability` = `console|power|host_shell|host_power|manage`), `manage.requested|finished|viewed|denied` (guest management, `docs/REST-API.md` "Manage"), `screens.viewed`, `enrollment.created|requested|approved|rejected`, `server.updated|deleted`, `auth.setup|login|logout|password_changed|passkey_added|passkey_removed`, `audit.exported`. Extra context is in `details` (`session_id`, `action`, `action_id`, `noop`, `state`, `from_guest`, ...).

### 7.4 Console, actions, screens

- `POST .../console-sessions` accepts `{"protocol"?, "switch_from"?: "cs_…"}`. With `switch_from` (side-list switch) the hub writes `console.switched` and closes the old session with reason `switched`. Error codes: 403 `insufficient_role`, 403 `console_disabled` (detail says whether the hub toggle or the agent's flag), 404 `server_not_found`/`guest_not_found`, 409 `agent_offline`, 409 `console_unavailable` (Docker), 409 `protocol_unavailable` (detail = the `unavailable` reason when known), 409 `guest_not_running`, 429 `session_limit` ("Too many open consoles…"; 5 per user, 10 per server, 20 per agent), 429 `rate_limited` (too many denied requests), 503 `audit_unavailable`. Every refusal is audited (`console.denied`).
- WebSocket: refusals before the upgrade are problem+json: 403 `bad_origin`, 400 `subprotocol`, 403 `invalid_token` (wrong token, other user, other session), 403 `token_used`, 403 `token_expired`. After the upgrade the hub sends `{"type":"status","state":"connected","protocol","resolution"}` itself (the agent may send more); if the agent cannot open the guest: `{"type":"error","code","message"}` then close (codes from the agent, e.g. `unsupported`, `guest_not_running`, `remote_control_disabled`). Additional close reasons: `switched`, `ended` (the agent ended the stream, e.g. the shell exited). Per-session bandwidth caps: 4 MiB/s browser→agent, 32 MiB/s agent→browser. Frames > 1 MiB close the socket.
- Re-authorization runs every 2 s: disabling remote control (hub or agent flag), deleting the server, signing out / changing the password, or a role below operator closes live sessions; a guest that stops closes its sessions (`guest_stopped`).
- `DELETE /console-sessions/{id}`: the session's owner or an admin. `GET /console-sessions?server=` (admin): `[{session_id, server, guest, protocol, user, client_ip, opened_at, bytes_in, bytes_out}]`.
- Actions: VMs `start|shutdown|reboot|force_stop|ctrl_alt_del`, containers `start|restart|stop`; `confirm: true` required for `shutdown|reboot|force_stop|stop` (400 `confirm_required`). Other codes: 400 `invalid_action`, 400 `use_screenshot_endpoint`, 403 `power_disabled`, 409 `action_in_progress` (one per guest), 503 `audit_unavailable`. `ctrl_alt_del` via actions needs the console permission. SSE `action.finished` adds `noop` and `code`.
- `screens.viewed` is recorded on the **first thumbnail per user and server within 10 minutes** (no extra endpoint). Refused thumbnail requests are audited at most once per 10 minutes per user/server/code. Thumbnails are cached 2 s and captured once per guest at a time; 240 requests/min per user. The screenshot is audited as `console.screenshot`; it is served with `Content-Disposition: attachment`. Agent capture errors map to: `no_screen`/`unsupported` → 404 `no_screen`, `guest_not_running` → 409, `unknown_guest` → 404 `guest_not_found`, `busy` → 503 `busy` (a SPICE client holds the screen), anything else → 502 `agent_error`.

### 7.5 Events

Adds `task.finished {server, guest, task, op, result: ok|warning|error, message}` when a platform task the hub started ends (guest management), `server.deleted {id}` and `resync {}`: sent instead of a backlog when `Last-Event-ID` is older than the hub's buffer or from a previous hub run — refetch everything. `server.updated` adds `last_seen`, `agent_connected`. `console.closed` goes only to the session's user. Keep-alive comments every 20 s; the stream ends when the session is signed out.
