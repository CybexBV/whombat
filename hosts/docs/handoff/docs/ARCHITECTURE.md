# Architecture

Proposed architecture for the product behind the mockup. It is a recommendation, not something the mockup proves. **Verify every external interface named here (file paths, Unix sockets, REST endpoints, tool flags) against the version you target before relying on it**: it was written from general knowledge of Linux, Docker, Incus, libvirt and Proxmox VE and none of it was run for this package.

## 1. Overview

```
                      ┌───────────────────────────── browser ─────────────────────────────┐
                      │  Web UI (React)   REST + SSE/WS for live data   console WebSocket │
                      └───────────────┬───────────────────────────────────────┬───────────┘
                                      │ HTTPS                                 │ WSS (single-use token)
                           ┌──────────▼───────────────────────────────────────▼───────────┐
                           │                            HUB                               │
                           │  API · auth · inventory DB · metrics store · alert engine    │
                           │  console gateway (WebSocket relay) · audit log               │
                           └──────────▲───────────────────────────────────────▲───────────┘
                    outbound mTLS WebSocket (agent dials the hub)             │
              ┌─────────────────────┴─────────────┐          ┌───────────────┴─────────────┐
              │ AGENT on host A (basalt)          │          │ AGENT on host B (shale, PVE) │
              │ collectors: host, disks, sensors, │          │ + Proxmox collector          │
              │ docker, incus, libvirt            │          │   (read-only API token)      │
              │ console broker (local sockets)    │          │ console broker               │
              └───────────────────────────────────┘          └──────────────────────────────┘
```

Why the agent dials the hub: it works behind NAT and firewalls, needs no inbound port on the hosts, and the same connection carries the console streams.

## 2. Components

| Component | Responsibility |
|---|---|
| **Agent** | Runs on every monitored host. Collects metrics and inventory, sends them over one persistent connection, buffers when offline, brokers console and power requests to local hypervisor APIs. Never exposes a listening port. |
| **Hub** | Terminates agent connections, stores inventory and metrics, evaluates alerts, serves the REST API and the web UI, relays console streams, keeps the audit log. |
| **Web UI** | Static single-page app served by the hub. Talks to the REST API; uses a WebSocket for live updates and for each console session. |
| **Database** | Inventory, users, alerts, audit log (relational). Metrics (time series). One engine can do both at small scale; see section 5. |

## 3. Agent

### 3.1 Process model

- One static binary, one systemd unit (`fleet-agent.service`), config in `/etc/fleet-agent/config.toml` (hub URL, enrollment token on first start, collector toggles). NixOS module and a Debian/Ubuntu package are in scope; a container image is optional.
- Runs as a dedicated user with only the capabilities it needs. Default is **read-only**: membership in the `docker` group is effectively root, so make the Docker, Incus and libvirt collectors **opt-in per host** and document the privilege each one needs. Console and power actions are a separate opt-in (section 7).
- Collection interval 10 s for host metrics; slower collectors listed below. All timestamps are taken on the agent as UTC and corrected for clock skew by the hub on connect.
- Budget: under 1% of one core and under 50 MB RSS at 10 s intervals (NFR). Measure it in CI on a host with 50 guests.
- Local ring buffer on disk for up to 1 hour of samples; on reconnect, backfill oldest first, rate-limited.
- Self-reports: version, uptime, last successful send, collector errors.

### 3.2 Collectors

| Signal | Source | Interval | Notes |
|---|---|---|---|
| CPU usage, user / system / iowait | `/proc/stat` deltas per interval | 10 s | Percent of total threads. Load average from `/proc/loadavg`. |
| CPU model, cores, threads | `/proc/cpuinfo` or `lscpu -J` | on start | Cores vs threads from topology, not from line counts. |
| Memory, cache, free, swap | `/proc/meminfo` (`MemTotal`, `MemAvailable`, `Cached`, `SwapTotal`, `SwapFree`) | 10 s | "Used" = total minus available. |
| ZFS ARC (Proxmox, ZFS hosts) | `/proc/spl/kstat/zfs/arcstats` (`size`) | 10 s | Shown in place of "Cache" when ZFS is present. |
| Temperatures | `/sys/class/hwmon/hwmon*/temp*_input` (millidegrees), `temp*_label`, `temp*_max`, `temp*_crit` | 10 s | Driver names identify the source: `k10temp` (AMD, `Tctl`), `coretemp` (Intel, `Package id 0`), `nvme` (`Composite`), `drivetemp` (SATA and HDD, needs the kernel module), DIMM sensors (`jc42` or similar), board and VRM via IPMI (`ipmitool sdr`) or a Super I/O driver. Group sensors as in `server-basalt.json › sensors` and report the hottest member of each group. |
| Sensor limits | The hwmon `temp*_max` / `temp*_crit` files where present, else a per-class default table | on start | Mockup limits: CPU 85, VRM 90, NVMe 75, DIMM 85, HDD 55, SATA SSD 70 (°C). Allow overrides per server in the hub. |
| Filesystem usage | `statvfs` on mount points from `/proc/self/mountinfo`; ZFS via `zpool list` / `zfs list -p` | 60 s | Skip pseudo filesystems. Map mounts to physical disks for the disk cards (`lsblk -J -b -o NAME,TYPE,SIZE,MODEL,PKNAME,MOUNTPOINTS`). |
| SMART, wear, power-on hours | `smartctl --json -a /dev/X` (smartmontools) | 10 min | Use `-n standby` so spinning disks are not woken. NVMe: `percentage_used` and `data_units_written` (units of 512,000 bytes) in the health log. SATA SSD wear attribute varies by vendor (for example Wear_Leveling_Count, Media_Wearout_Indicator); keep a mapping table. |
| Rated TBW | Model lookup table shipped with the agent or hub, manual override per disk | n/a | SMART does not report rated endurance. If unknown, show wear percent only (see AGENTS.md decisions). |
| KVM capabilities | `/dev/kvm`; `svm` or `vmx` in `/proc/cpuinfo` flags; `/sys/module/kvm_amd/parameters/nested` (or `kvm_intel`); `/sys/kernel/iommu_groups/*` count; devices bound to `vfio-pci`; `/proc/meminfo` `HugePages_Total` and `Hugepagesize`; `/sys/kernel/mm/ksm/pages_sharing` times the page size | 5 min | Feeds the Virtualization capability grid. |
| Docker | Docker Engine API on `/var/run/docker.sock`: `GET /containers/json?all=1`, `GET /containers/{id}/stats?stream=false`; health from `State.Health.Status` | 10 s (stats), events stream for state | CPU percent = (container CPU delta / system CPU delta) x online CPUs x 100. "Unhealthy" = health status `unhealthy`. |
| Incus | REST API on the Unix socket (commonly `/var/lib/incus/unix.socket`): `GET /1.0/instances?recursion=2` (includes state), `GET /1.0/events` for changes | 10 s plus events | Distinguish `type: container` from `type: virtual-machine`. Network and disk I/O counters come from the instance state. |
| libvirt | libvirt API (`qemu:///system`) via bindings or `virsh domstats --raw` | 10 s plus events | CPU time deltas per domain; memory from balloon stats; graphics config from the domain XML. |
| Proxmox VE | REST API `https://127.0.0.1:8006/api2/json` with a **read-only API token** (role `PVEAuditor`): `cluster/status`, `cluster/resources`, `nodes/{n}/status`, `nodes/{n}/qemu`, `nodes/{n}/lxc`, `nodes/{n}/storage`, `nodes/{n}/disks/list`, `nodes/{n}/disks/smart`, `cluster/ha/status/current`, `cluster/backup` and recent `vzdump` tasks | 10 s (resources), 5 min (disks, backups) | One agent per node. Nodes without an agent are shown from `cluster/resources` only. |

Docker has no console in scope. Incus, libvirt and Proxmox consoles are brokered by the agent (`REMOTE-CONSOLE.md`).

### 3.3 Derived values (compute in the hub, not in the UI)

| Value | Definition | Check against fixture |
|---|---|---|
| vCPU allocated | Sum of configured vCPUs of **running VMs** (containers excluded) | basalt: 8 + 4 + 4 + 4 + 2 = 22 ✓ |
| vCPU overcommit | vCPU allocated / host hardware threads | 22 / 48 = 0.46 ✓ |
| Memory assigned | Sum of configured memory of running VMs / host RAM | See "Fixture caveat" below |
| Memory in use by guests | Sum of guest-reported used memory | See "Fixture caveat" |
| Disk wear (card) | Maximum wear over SSDs on the host | basalt: 78 ✓ |
| Disk used (card) | Used / capacity over all monitored filesystems | |
| Server status | `offline` if no heartbeat for 60 s; else `warning` if any open warning alert on the host; else `online` | |
| Fleet KPIs | Formulas in `SCREENS.md` 2.2, **online servers only** | |

**Fixture caveat.** The hypervisor allocation numbers in `sample-data/` are hard-coded display values of the mockup, not derived from the guest lists: for basalt the running VMs' configured memory adds up to 44 GB while the fixture says 52 GB assigned and 41 GB in use (the VM list sums to about 29 GB). The Proxmox node lists 8 of 22 VMs, so its totals cannot be re-derived either. Use the definitions above; treat the fixture numbers as examples of what the UI shows, not as a test oracle for these two fields.

## 4. Agent to hub protocol

- **Transport**: WebSocket over TLS 1.3, agent-initiated, **mutual TLS** with a per-agent client certificate. Reconnect with jittered exponential backoff (1 s to 60 s).
- **Framing**: JSON messages are fine for the first milestones; switch to a binary format (CBOR or protobuf) if profiling shows the need. Version the protocol in the first message.
- **Message types** (agent to hub): `hello` (agent version, host id, capabilities, clock), `inventory` (full snapshot, then deltas), `metrics` (batch of timestamped samples), `event` (state changes, log of collector errors), `console.opened`, `console.data` (binary), `console.closed`, `action.result`. Hub to agent: `ack`, `config`, `console.open`, `console.close`, `console.resize`, `action`.
- **Heartbeat**: a `metrics` batch or a ping every 10 s. "Agent unreachable" after 60 s without any frame (default; configurable).
- **Multiplexing**: console sessions are separate logical channels on the same connection with their own flow control, so a slow console cannot stall metrics. Cap concurrent sessions per agent.
- **Idempotency**: samples carry the agent's timestamps; the hub ignores duplicates for the same series and timestamp (needed for backfill).

### Enrollment (the "Add server" / "Enroll a server" flow)

1. An admin clicks **Add server**. The hub creates a single-use enrollment token (expires in 1 hour) and shows an install command containing the hub URL and the token.
2. The agent starts, generates a keypair locally, and sends a certificate signing request with the token.
3. The host appears as **pending** (name, OS, address, agent version). The admin **approves** it and picks a group.
4. The hub returns a signed client certificate (short lifetime, renewed automatically) and the agent begins sending data.
5. Revocation: removing a server in the hub revokes its certificate; the agent is disconnected.

## 5. Hub

### 5.1 Services

- **API** (`API.md`): read endpoints for the three pages, metrics queries, console session creation, power actions, enrollment. Responses are cacheable for a few seconds; the UI polls every 10 s or subscribes over SSE/WebSocket.
- **Inventory**: servers, groups, disks, sensors, guests, cluster, storages. Updated from `inventory` messages.
- **Metrics store**: see 5.2.
- **Alert engine**: evaluates the default rules (`PRODUCT-SPEC.md` section 5) on ingest. Each alert has a stable key (`rule` + entity), a state machine (pending, firing, resolved), an `opened_at`, a severity and the evidence text used in the UI. Hosts offline for 60 s raise `agent.heartbeat_missing`.
- **Console gateway**: `REMOTE-CONSOLE.md`.
- **Audit log**: append-only records of console sessions, power actions, enrollments, role and setting changes.
- **Auth**: local accounts with passkeys or OIDC; roles viewer, operator, admin. Session cookie `Secure; HttpOnly; SameSite=Lax` with CSRF protection on state-changing calls.

### 5.2 Metrics storage and retention

Default retention (AGENTS.md decision table): raw 10 s samples for 24 hours, 1 minute rollups for 7 days, 15 minute rollups for 90 days. Every rollup stores **average and maximum** (and count). Charts draw the average; "Peak" uses the maximum.

Query resolution (all derivable from the tiers above):

| Range | Detail-chart points | Source tier |
|---|---|---|
| 1h | 60 at 1 min | raw |
| 6h | 72 at 5 min | raw |
| 24h | 96 at 15 min | raw |
| 7d | 84 at 2 h | 1 min rollup |
| 30d | 120 at 6 h | 15 min rollup |

Fleet heatmap: 48 buckets of `range / 48` by timestamp (not by sample count: 1h gives 75 s buckets, which is 7.5 samples). 30d heatmap and sparklines read the 15 min tier.

The 30d chart (6 h points) is served from the 15 minute tier, so 90 days of 15 minute rollups covers every range in the UI. Add a 1 hour tier only if you want history beyond 90 days.

Sizing guide (back of envelope, **measure before committing**): 50 hosts x about 150 series (host, per-disk, per-sensor, per-guest CPU and memory) x 8,640 samples per day is roughly 65 million raw samples per day, about 190 million at 150 hosts. A general-purpose relational table will struggle with that; use a time-series engine (TimescaleDB with compression, VictoriaMetrics, or ClickHouse) or store per-guest series at 30 s. For a handful of hosts SQLite or Postgres with plain rollup tables is enough. Pick at M3 and record why.

Gaps are stored as absent samples and returned as `null`; never interpolate.

### 5.3 Live updates

REST returns the current snapshot. For the 10 s refresh use Server-Sent Events or a WebSocket that pushes `server.updated`, `alert.opened`, `alert.resolved`, and `server.offline` events; the client re-queries charts at the bucket interval. Fall back to polling.

## 6. Failure modes

| Situation | Expected behavior |
|---|---|
| Agent loses the hub | Buffers up to 1 h, retries with backoff, backfills on reconnect. |
| Hub loses an agent | After 60 s: server `offline`, `agent.heartbeat_missing` critical, charts show a gap, card shows "Agent unreachable. Last seen ...". Metrics already stored remain queryable. |
| A collector fails (Docker socket missing, libvirt down) | The section shows "Not reporting" with the last error; the rest of the host is unaffected; a non-fatal `event` is sent. |
| Clock skew on a host | Hub measures skew at `hello`; samples are corrected or rejected beyond a threshold (default 30 s) with a visible warning on the Agent field. |
| Hub restart | Agents reconnect; UI shows stale "Updated N s ago" until data resumes. |
| Console target powered off | See `REMOTE-CONSOLE.md`; UI shows the stopped state with a Start action (if power actions are allowed). |

## 7. Security model (summary)

- All traffic is TLS 1.3. Agents authenticate with per-host client certificates (mTLS); users with sessions or OIDC. No default passwords.
- The agent has **no inbound listener**. Its local interfaces are Unix sockets and loopback only.
- Least privilege per collector; console and power actions are a separate capability, off by default, enabled per server by an admin, and require the operator role in the UI.
- Console sessions use single-use, short-lived tokens bound to user, server, guest and protocol, and are audited. Details and the checklist are in `REMOTE-CONSOLE.md`.
- Secrets (Proxmox API token, hypervisor credentials) live only on the host in a root-readable file or systemd credential, never reach the hub's database in plaintext, and are never logged.
- Inputs from agents are untrusted: validate every message against a schema, bound sizes, rate-limit per agent, and escape all strings in the UI (hostnames, guest names, image names and log lines are attacker-controlled).
- Keep the audit log append-only; show it to admins.

## 8. Deployment

- Hub: single binary or container with a Postgres/SQLite file and a data directory, behind a TLS-terminating reverse proxy or its own ACME. Document backup of the DB.
- Agent: packages for Debian/Ubuntu, a NixOS module, and a static tarball. Auto-update is optional; at minimum the hub shows the agent version and flags outdated ones.
- Observability of the product itself: agent and hub expose their own health (queue depth, last ingest time) in the UI under Agents.

## 9. What to verify before building (known unknowns)

1. **Incus console**: the REST endpoints for `console` (text and VGA) and `exec` use WebSocket operations with one-time secrets. Check the current API for how a browser-side client can attach, and whether VGA is SPICE-only.
2. **libvirt graphics**: whether the guest's graphics device is VNC or SPICE, on a Unix socket or a TCP port, and what bridge is needed to expose it as a WebSocket.
3. **Proxmox console authentication**: whether the console proxy endpoints accept API tokens in the target version or require a user ticket, and how the ticket's lifetime and single-use rules work.
4. **Proxmox without an agent**: which fields `cluster/resources` provides for non-enrolled nodes.
5. **SMART wear mapping** across SATA SSD vendors; NVMe is standardized.
6. **TBW lookup data** and its licensing.
7. **Metrics engine choice** at the expected scale.
