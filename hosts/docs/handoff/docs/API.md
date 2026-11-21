# API (proposed)

The hub's REST API as the UI needs it. The three fixtures in `sample-data/` are the **response bodies** of the read endpoints, so a typed client can be generated from them and contract tests can serve them as mocks. Fixture-only keys (`_note`) are not part of the API. Everything here is a proposal: change it if you must, but update the fixtures and this file together.

## 1. Conventions

- Base path `/api/v1`. JSON, UTF-8. Authentication by session cookie (browser) or `Authorization: Bearer <api token>` (scripts). Mutating calls from a browser need a CSRF token header.
- **Time**: ISO 8601 UTC with `Z` (`2026-10-11T14:00:00Z`). Durations in seconds. The UI converts to the viewer's zone.
- **Units are in the key suffix**: `_pct` (0 to 100, one decimal at most), `_gb`, `_mb`, `_tb`, `_c` (Celsius), `_mbs` (megabytes per second), `_mbps` (megabits per second), `_s` (seconds), `_h` (hours). No unit conversion in the UI beyond display formatting.
- **Missing data is `null`**, never `0` and never omitted when the field is part of the shape. An offline server has `current: null` and `last_known: {...}`.
- **Enums** (lower case): `status` = `online | warning | offline`; `severity` = `critical | warning`; guest `state` = `running | stopped | unhealthy`; `platform` = `docker | incus | libvirt | pve`; hypervisor `stacks[]` entries = `incus | libvirt | proxmox`; `kind` = `vm | container`; disk `type` = `nvme | hdd | ssd`; disk `health` = `healthy | wear_high | failing`; console `protocol` = `vnc | spice | serial | shell | tty`; `range` = `1h | 6h | 24h | 7d | 30d`.
- **Errors**: `application/problem+json` (RFC 9457) with `type`, `title`, `status`, `detail`; add `code` for machine use (`console_disabled`, `guest_not_running`, `rate_limited`, `token_expired`).
- **Caching**: `ETag` on GETs, `Cache-Control: private, max-age=5`. Honor `If-None-Match`.
- **Ids**: servers by hostname slug (`basalt`). Guests by `platform:name` (`incus:nixbuild`, `docker:prometheus`, `pve:100`, `libvirt:opnsense`). URL-encode the colon.

## 2. Read endpoints

| Method and path | Returns | Fixture |
|---|---|---|
| `GET /fleet?group=All&range=24h` | Everything the overview needs for the group | `fleet.json` |
| `GET /fleet/series?group=All&range=24h` | Sparklines and heatmap (section 2.2) | not in a fixture |
| `GET /servers` | Light list for the switcher and the sidebar count | derived from `fleet.json › servers[]` |
| `GET /servers/{id}` | Detail page body; `server.detail_view` selects the shape | `server-basalt.json`, `server-shale-proxmox.json` |
| `GET /servers/{id}/metrics?range=24h&series=cpu_pct,mem_pct,...` | Time series | `timeseries-basalt-24h.json` |
| `GET /servers/{id}/guests?platform=incus&q=&sort=cpu&limit=50&cursor=` | Full, filterable guest list | slice of the detail body |
| `GET /servers/{id}/guests/{guestId}` | One guest | element of `guests[]` |
| `GET /servers/{id}/guests/{guestId}/thumbnail` | `image/jpeg` ≤ 320 px wide, for the Screens wall | none |
| `GET /alerts?state=open&group=All` | Alert list | `fleet.json › alerts[]` |
| `GET /events` | Server-Sent Events stream (section 5) | none |
| `GET /audit?limit=100&cursor=` | Audit records (admin) | none |

### 2.1 `GET /fleet`

Fixture: `sample-data/fleet.json`. Top-level keys:

| Key | Meaning |
|---|---|
| `as_of` | Server time of the snapshot |
| `groups[]` | `{name, count}`; first entry is `All` |
| `kpis` | `servers_online`, `servers_total`, `cpu_avg_pct`, `memory_pct`, `memory_used_gb`, `memory_total_gb`, `storage_used_tb`, `storage_total_tb`, `storage_pct`, `disks_over_75_wear`, `open_alerts`, `open_alerts_critical`, `open_alerts_warning`. Online servers only, except the first two. |
| `servers[]` | One object per server **in the selected group** (see below) |
| `alerts[]` | Open alerts in the group |
| `top_guests_by_cpu` | `{docker, incus, qemu}`, each an array of `{name, server, cpu_pct}`, top 5 (UI shows 3) |
| `platform_summary` | Counts for the three workload cards |

Server object:

```json
{
  "id": "basalt", "group": "Production", "status": "warning", "status_note": "disk wear",
  "os": "NixOS 26.05",
  "cpu": {"model": "EPYC 7443P", "cores": 24, "threads": 48},
  "memory_total_gb": 256, "storage_capacity_tb": 35,
  "last_seen": "2026-10-11T14:00:00Z",
  "current": {"cpu_pct": 34, "mem_pct": 61, "temp_max_c": 64, "disk_used_pct": 64, "disk_wear_max_pct": 78},
  "last_known": null,
  "workloads": {"docker": {"running": 14, "stopped": 2, "unhealthy": 0},
                "incus": {"containers_running": 4, "vms_running": 2, "stopped": 1},
                "qemu": {"running": 3, "stopped": 1}},
  "hypervisor": {"stacks": ["incus", "libvirt"], "kvm_enabled": true, "host_threads": 48,
                 "vcpu_allocated": 22, "vcpu_overcommit_ratio": 0.46,
                 "guest_memory_assigned_gb": 52, "guest_memory_assigned_pct": 20,
                 "vms": 5, "containers": 4},
  "detail_view": "standard"
}
```

Rules the hub applies (the UI does not recompute them):

- Offline server (`marble`): `status: "offline"`, `current: null`, `last_known` holds the last values, `hypervisor: null`, workload counts zero.
- `hypervisor` is `null` for hosts without a hypervisor.
- `detail_view` is `"proxmox"` for Proxmox VE nodes (the UI opens the Proxmox page).
- The fixture marks the per-server fleet fields as a summary; the card's Temp dot needs the hottest sensor's own limit, so add `temp_limit_c` next to `temp_max_c` in the real API (not in the fixture).

### 2.2 `GET /fleet/series` (proposed, no fixture)

Everything drawn as a small chart on the overview, for the selected group and range:

```json
{
  "range": "24h", "as_of": "2026-10-11T14:00:00Z",
  "kpi": {"step_s": 1440, "cpu_pct": [33.1, "..."], "mem_pct": [63.8, "..."]},
  "servers": {
    "basalt": {"step_s": 1440, "cpu_pct": [38.2, "..."], "mem_pct": [60.9, "..."]},
    "marble": {"step_s": 1440, "cpu_pct": [9.0, 8.7, null, null], "mem_pct": [41.0, null, null]}
  },
  "heatmap": {"buckets": 48, "bucket_s": 1800, "cpu_pct": {"basalt": [38.2, "...", null], "marble": [9.0, "...", null]}}
}
```

60 points per sparkline, 48 per heatmap row, bucketed by timestamp. `kpi.cpu_pct` is the mean over online servers per bucket (a server that is offline in a bucket is excluded from that bucket's mean). Cells with no data are `null`.

### 2.3 `GET /servers/{id}`

Two shapes, chosen by `server.detail_view`. Common keys in both fixtures: `as_of`, `server`, `live`, `banner`, `sensors[]`, `virtualization`.

| Key | Standard (`server-basalt.json`) | Proxmox (`server-shale-proxmox.json`) |
|---|---|---|
| `server` | id, group, status, status_note, roles[], os{name, version, kernel}, cpu{model, cores, threads}, memory{total_gb, type}, uptime_s, last_boot, address, location, agent{version, last_sync_s_ago}, detail_view | same; `roles` includes `proxmox-node` |
| `live` | refresh_interval_s, cpu_pct, cpu_user_pct, cpu_system_pct, cpu_iowait_pct, load_avg[3], mem_pct, mem_used_gb, `mem_cache_gb`, mem_free_gb, swap_used_gb, swap_total_gb | same but `zfs_arc_gb` instead of `mem_cache_gb` |
| `banner` | `{severity, title, detail, link}` or `null` when no open alert | same |
| `sensors[]` | id, label, group, source, now_c, max_24h_c (max over the requested range, despite the name), limit_c | same, without `group` |
| `disks[]` | device, type, model, role, capacity_gb, used_gb, wear_pct, written_tb, rated_tbw, temp_c, power_on_hours, health | `disks[]` is the lighter Proxmox form: device, model, pool, wear_pct, temp_c |
| `virtualization` | stacks[], capabilities{kvm, cpu_virtualization, iommu, nested, hugepages, ksm, ballooning}, allocation{...} | same keys; `hugepages` absent, `ballooning` active |
| `workloads` | `{docker, incus, libvirt}`; each `{running, total, ..., guests_shown, guests[]}` | absent |
| `guests` | absent | `{vm: {...}, container: {...}}` |
| `cluster`, `storages[]`, `backups` | absent | present |

Notes:

- `max_24h_c` should be renamed `max_c` in a real API: the window follows `range`. Keep the fixture key if you want the contract tests to pass untouched, and rename both together.
- HDDs have `wear_pct: null` and no `written_tb` / `rated_tbw` in the fixture; the UI shows "Not applicable (spinning disk)" from `type`. Send `null` for wear on non-SSDs. The fixture does not carry the HDD reallocated / pending / uncorrectable sector counters that the disk card shows; add them to the disk object (`smart: {reallocated, pending, uncorrectable}`) in the real API.
- `guests[]` in the detail body is the first page (top by CPU, `guests_shown` of `total`). Use the `/guests` endpoint for filtering and the full list.
- Guest object (all platforms): `id, name, platform, kind, image, state, vcpu, cpu_pct, memory_used_mb, memory_limit_mb, disk_read_mbs, disk_write_mbs, net_rx_mbps, net_tx_mbps, snapshots, uptime_s, console`. Docker adds `last_exit` and has no `vcpu` or I/O fields; Proxmox adds `vmid`, `node`, `last_backup{result, at}`. Stopped guests have `null` for the live numbers.
- `console`: `{available, protocols[], default_protocol, resolution}` (`resolution` `null` when stopped; `{available:false}` for Docker). Protocols per platform are in `PRODUCT-SPEC.md` C3.
- `cluster`: `{name, quorate, votes{have, expected}, ha{resources_started}, nodes[{name, this_node, status, cpu_pct, mem_pct, vms, containers, agent}], note}` where `agent` is `connected | not_enrolled`.
- `backups`: `{last_job{at, schedule, mode, result, guests_ok, guests_total, warnings, written_gb, dedup_ratio, duration_min, avg_duration_min_week}, next_run, target}`.

### 2.4 `GET /servers/{id}/metrics`

Fixture: `timeseries-basalt-24h.json`.

```json
{
  "server": "basalt", "range": "24h", "step_seconds": 900, "points": 96,
  "as_of": "2026-10-11T14:00:00Z",
  "timestamps": ["2026-10-10T14:15:00Z", "..."],
  "series": {
    "cpu_pct": [38.2, 35.6, "..."],
    "mem_pct": [..],
    "temp_cpu_package_c": [..], "temp_board_vrm_c": [..], "temp_nvme_hottest_c": [..],
    "temp_dimm_c": [..], "temp_hdd_hottest_c": [..]
  }
}
```

- `series=` selects which to return (default: all). All arrays have `points` entries aligned with `timestamps`; gaps are `null`.
- `step_seconds` and `points` per range: 1h 60 at 60 s; 6h 72 at 300 s; 24h 96 at 900 s; 7d 84 at 7,200 s; 30d 120 at 21,600 s.
- **Add a `summary` object** (not in the fixture) so the UI never infers peaks from the plotted averages: `"summary": {"cpu_pct": {"avg": 34.1, "max": 58.0, "max_at": "2026-10-11T00:30:00Z"}, "...": {}}`. `max` comes from the stored maxima.
- Guest and disk series (for the guest I/O and network sparklines): `GET /servers/{id}/metrics?series=guest_disk_io_mbs,guest_net_mbps`, same shape.

## 3. Console and actions

Details, threat model and the checklist are in `REMOTE-CONSOLE.md`. Shapes:

```
POST /servers/{id}/guests/{guestId}/console-sessions
{ "protocol": "spice" }                       // optional; default = console.default_protocol
→ 201 { "session_id": "cs_8f2c...", "url": "wss://hub.example/console/cs_8f2c...", "token": "<single use>",
        "protocol": "spice", "expires_at": "2026-10-11T14:00:30Z", "idle_timeout_s": 900,
        "requires_confirmation": false }
```

- Needs the **operator** role and "Remote control" enabled on the server. Otherwise `403 console_disabled`.
- The token is valid for one WebSocket upgrade within 30 s. The browser sends it as a subprotocol or first message, not as a query string (query strings land in logs).
- `DELETE /console-sessions/{id}` closes a session. `GET /console-sessions?server=` lists active sessions (admin).

```
POST /servers/{id}/guests/{guestId}/actions
{ "action": "shutdown", "confirm": true }
→ 202 { "action_id": "act_41d...", "audit_id": "au_77e..." }
```

`action` = `start | shutdown | reboot | stop | force_stop | restart | ctrl_alt_del | screenshot`. VMs: `start, shutdown, reboot, force_stop, ctrl_alt_del, screenshot`. Containers: `start, restart, stop`. Destructive actions (`force_stop`, `stop`, `reboot`, `shutdown`) require `confirm: true`, which the UI sets only after its confirm dialog. Result arrives on the event stream (`action.finished`) and in the audit log.

## 4. Enrollment

```
POST /enrollments                       → 201 { "id": "en_1", "token": "<single use>", "expires_at": "...", "install_command": "curl -fsSL ... | sh -s -- --token ..." }
GET  /enrollments?state=pending         → [ { "id": "en_1", "hostname": "newhost", "os": "...", "address": "...", "agent_version": "0.14.2", "requested_at": "..." } ]
POST /enrollments/{id}/approve          { "group": "Lab", "name": "newhost" } → 200 { "server_id": "newhost" }
POST /enrollments/{id}/reject
DELETE /servers/{id}                    removes a server and revokes its certificate
```

## 5. Event stream

`GET /events` (SSE; `Last-Event-ID` supported). Event names and payloads:

| Event | Payload |
|---|---|
| `server.updated` | `{id, status, status_note, current}` (same fields as the fleet card) |
| `server.offline` / `server.online` | `{id, at}` |
| `alert.opened` / `alert.resolved` | alert object |
| `guest.state_changed` | `{server, id, state}` |
| `action.finished` | `{action_id, result: "ok" | "error", message}` |

Detail-page values refresh by re-fetching `GET /servers/{id}` every 10 s (or on `server.updated`).

## 6. Alert object

```json
{ "id": "al_02", "server": "basalt", "severity": "warning", "title": "nvme1n1 wear at 78%",
  "detail": "936 of 1,200 TBW written", "opened_at": "2026-10-09T13:00:00Z", "rule": "disk.wear_high" }
```

Add `resolved_at` (null while open) and `state` (`open | resolved`) in the real API. Acknowledge and silence are not designed.

## 7. Agent ingest (internal)

Not a public API; see `ARCHITECTURE.md` section 4. The hub's ingest schema should be able to produce every field of the fixtures above. A suggested metric naming scheme (dot-separated, unit in the name):

```
host.cpu.usage_pct, host.cpu.user_pct, host.cpu.system_pct, host.cpu.iowait_pct, host.load.1m|5m|15m
host.mem.used_gb, host.mem.cache_gb, host.mem.free_gb, host.swap.used_gb, host.zfs_arc_gb
sensor.temp_c{sensor="cpu_package"}
disk.used_gb{device,mount}, disk.wear_pct{device}, disk.temp_c{device}, disk.power_on_h{device}
guest.cpu_pct{platform,id}, guest.mem_used_mb{platform,id}, guest.disk_read_mbs, guest.disk_write_mbs, guest.net_rx_mbps, guest.net_tx_mbps
hypervisor.vcpu_allocated, hypervisor.mem_assigned_gb, hypervisor.mem_in_use_gb
```

Rollups keep `avg`, `max`, `count` per bucket.

## 8. Contract tests

1. Serve the fixtures as mock responses; the UI must render the screenshots from them.
2. Validate each fixture against your schema (generate JSON Schema or TypeScript types from the shapes above).
3. For the real hub, seed a database from the fixtures and assert the API returns the same JSON, except for the documented fields that are display-only in the fixtures (`virtualization.allocation` memory fields, see `ARCHITECTURE.md` 3.3).
4. Threshold unit tests per `PRODUCT-SPEC.md` section 5.
