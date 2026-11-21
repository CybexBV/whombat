# Product spec

Working name: **Fleet** (placeholder). All data shown in the mockup is sample data.

## 1. Summary

A monitoring dashboard for people who run a handful to a few hundred of their own servers. A small **agent** on each host reports metrics and inventory to a **hub**. The web UI answers four questions:

1. Does anything need my attention right now?
2. How is this one server doing: CPU and memory over time, temperatures, disk space and SSD wear?
3. How loaded are my hypervisors (vCPU and memory overcommit) and what runs on them (Docker, Incus, libvirt/QEMU, Proxmox VE)?
4. Can I open a VM's screen or a container's shell right here?

Supported host types: Linux servers (NixOS, Debian, Ubuntu in the mockup), Docker Engine, Incus, libvirt/QEMU (full KVM), Proxmox VE.

## 2. Users and jobs

- **Operator** (primary): glances at the overview daily, drills into a server when a warning shows, opens consoles to fix things, enrolls new hosts.
- **Viewer**: read-only access to dashboards.
- **Admin**: manages enrollment, roles, and whether remote control is enabled per server.

Scale to design for: 1 to 50 servers comfortably, up to about 200 without redesign (the server cards and heatmap rows must still be usable; add search and pagination beyond that, not designed yet).

## 3. Scope

**In scope:** everything in section 4.

**Out of scope (not designed; do not build unless asked):** notification channels (email, chat, webhooks), user and role management screens, settings pages, light theme, per-guest historical charts, log viewing, Docker exec shell, VM creation, migration, snapshots management, billing. The sidebar items **Workloads, Storage, Alerts, Agents, Settings** exist in the mockup as navigation placeholders only.

## 4. Functional requirements

IDs are stable; reference them in tests.

### 4.1 Global

| ID | Requirement |
|---|---|
| G1 | A **time range** control with 1h, 6h, 24h, 7d, 30d. It applies to every chart, sparkline and the heatmap on the page. Default 24h. |
| G2 | On the Fleet overview, a **group filter** with All, Production, Lab, Edge, each showing its server count. Every number on the page (KPIs, heatmap, alerts, cards, workloads, hypervisors) is recomputed for the selected group. Groups are user-defined labels on servers. |
| G3 | Data refreshes every **10 s** ("Live · refreshes every 10 s" on detail pages; "Updated 8 s ago" on the overview). Charts for 1h and 6h include the newest samples; longer ranges refresh at their bucket size. |
| G4 | Left navigation: Overview, Servers (with count), Workloads, Storage, Alerts (with open-alert badge), Agents, Settings. Only Overview and Servers have designed pages. |
| G5 | URL state: range, group, selected platform tab, List/Screens view and the open console are in the URL so a view can be shared and reloaded. |

### 4.2 Fleet overview

| ID | Requirement |
|---|---|
| F1 | Header: title "Overview", summary "N servers · M agents connected · Updated Xs ago", group control, range control, primary button **Add server** (starts enrollment). |
| F2 | Five **KPI tiles**: Servers online (`online / total`, sub-line "N offline · M with warnings" or "All reachable"); CPU, fleet average (value + sparkline); Memory, fleet (percent, "used of total GB", sparkline); Storage used (TB used, "of X TB", a meter, sub-line "N disk(s) over 75% wear" or "No disks near end of life"); Open alerts (count, "N critical · M warning" or "All clear"). KPIs consider **online servers only**, except the Servers-online tile. |
| F3 | **CPU load by server** heatmap: one row per server in the group, 48 cells per row, one cell per `range / 48` (1h = 75 s, 24h = 30 min, 7d = 3.5 h, 30d = 15 h; the mockup labels it as "one cell per N min / N h / 1 day"). 7 sequential bins of one hue, legend 0% to 100%, a cell with no data is **blank with a faint ring**, tooltip "server · time · NN%" or "server · time · no data". |
| F4 | **Needs attention**: open alerts for the selected group, severity icon + title + host + detail + relative time ("since 02:14", "2 d ago"); link "All alerts"; empty state "No open alerts for this selection." |
| F5 | **Server cards** (grid, min 340 px per card): status dot + label (Online, Warning, Offline) + short reason ("disk wear", "CPU temperature", "no heartbeat"), group chip, **KVM** chip when the host runs a hypervisor, hostname (mono), OS, hardware line; CPU and MEM current value + sparkline over the selected range; Temp, Disk (used %), Disk wear (max across SSDs) each with a status dot; workload counts Docker, Incus (containers + VMs), QEMU (running VMs). Clicking a card opens the server (Proxmox hosts open the Proxmox page). Offline card: dimmed, values replaced by an em dash, sparklines end where data stops, message "Agent unreachable. Last seen 02:14 (11 h 47 m ago)." A trailing **Enroll a server** card. |
| F6 | **Workloads**: three platform cards (Docker, Incus, QEMU / KVM). Each: sub-title ("Engine on N servers", "Containers and VMs on N servers", "libvirt on N · Proxmox VE on M servers"), running count, "of total", a state bar and legend (Running, Stopped, Unhealthy where applicable), a stack split (Incus: Containers / KVM VMs; QEMU: Proxmox VE / libvirt), and **Top by CPU** with the 3 busiest guests (name, host, bar, percent). |
| F7 | **Hypervisors** table, one row per online KVM host: host, stack chips (Incus, libvirt, Proxmox VE), KVM state, guest VM count, container count, **vCPU allocated** (`allocated / host threads`, ratio like "0.46 : 1", meter), **Memory assigned** (`assigned / host RAM GB`, percent, meter). The vCPU meter spans 0 to 2 : 1 with a tick at 1 : 1. Footnote explains this. Row click opens the host. |

### 4.3 Server detail (standard host) and Proxmox host

Both pages share the header, banner, meta strip, charts, temperatures, virtualization and guests sections. The Proxmox page adds Cluster, Proxmox storages, a different disks table and Backups.

| ID | Requirement |
|---|---|
| S1 | Header: breadcrumb "Servers / hostname", hostname (mono, large), status chip with alert count, group chip, "KVM host" chip (and "Proxmox VE 9" on Proxmox), **Switch server** menu, live indicator, range control. |
| S2 | **Banner** (only when there is an open alert for this host): severity icon, bold title, detail, link to the relevant section ("View disk", "View temperatures"). |
| S3 | **Meta strip**: Operating system (+ kernel or kernel flavor), Processor (model, cores · threads), Memory (size, type), Uptime (+ last boot date), Address (IP + rack/location), Agent (version + "Synced N s ago"). |
| S4 | **CPU usage** and **Memory usage** cards, each: current value, sub-label ("24 cores · 48 threads", "156 of 256 GB"), average and **peak with timestamp** over the range, line + area chart 0 to 100%, crosshair with tooltip (time, value, absolute amount), and a facts row (CPU: User, System, I/O wait, Load 1/5/15; Memory: Used, Cache or ZFS ARC, Free, Swap). The default crosshair rests at about 72% of the range until the pointer moves. |
| S5 | **Temperatures**: five sensor groups in one chart (CPU package, Board/VRM, NVMe hottest, Memory modules, HDD or SATA SSD hottest), y axis 20 to 100 °C, a solid line at the CPU warning limit (85 °C), direct end labels, crosshair tooltip listing all five. Beside it, a sensor table: name, source (driver · sensor), Now, Max (over the range), Limit, status dot. |
| S6 | **Storage** (standard host): one card per physical disk: device, type (NVMe/HDD), model, role/mount, used / capacity with a bar, **wear** (SSDs only: percent, bar, "written of rated TBW"), temperature, power-on hours, health label ("Healthy", "Wear high"). HDDs show "no wear indicator". Section summary "4 disks · 22.3 TB used of 35 TB". |
| S6p | **Storage** (Proxmox): *Proxmox storages* list (id, type chip, content, used of capacity, percent, bar) and a *Disks and wear* table (device, model, pool, wear bar + percent, temperature). |
| S7 | **Virtualization** (KVM hosts): capability grid: KVM (module, /dev/kvm), CPU virtualization (AMD-V or Intel VT-x, nested paging), IOMMU (groups, devices on vfio-pci), Nested virtualization, Hugepages (reserved GB) or Ballooning (Proxmox), Memory sharing (KSM saved GB). Four allocation cards: **vCPU allocated** (value, "on N threads", meter with 1 : 1 tick, overcommit text), **Guest memory assigned** (value, "of N GB", meter, "N GB in use by guests"), **Guest disk I/O** (MB/s, sparkline, read/write split), **Guest network** (Mb/s or Gb/s, sparkline, rx/tx split). A "KVM enabled" chip in the section header. |
| S8 | **Workloads / Guests**: platform cards act as tabs. Standard host: Docker, Incus, QEMU / KVM (libvirt). Proxmox: QEMU / KVM and LXC containers. Each shows running of total, state bar, CPU and memory totals. The selected card drives the table below. |
| S9 | **Guest tables**: Docker (name, image, state, CPU, memory, uptime); Incus and libvirt (name, type·image, state, vCPU, CPU, memory, disk R/W MB/s, net rx/tx Mb/s, snapshots, **Console**); Proxmox (ID, name, state, vCPU, CPU, memory, disk R/W, net rx/tx, last backup, **Console**). State = dot + word (Running, Stopped, Unhealthy). Stopped guests show dashes. Footer states sort order ("sorted by CPU") and units. Filter-by-name input. |
| S10 | **Cluster** (Proxmox only): cluster name, "Quorate · 3 of 3 votes", "HA · N resources started"; node table (name, This node chip, status, CPU bar, memory bar, guests "18 VMs · 4 CTs", agent: Connected or an **Enroll agent** button). Note that non-enrolled nodes report only what the cluster API provides. |
| S11 | **Backups** (Proxmox): last job (time, schedule, mode), result ("22 of 22 guests OK"), data written (+ dedup ratio), duration (+ weekly average), next run (+ "In 12 h"), target (+ fullness). |

### 4.4 Remote console

| ID | Requirement |
|---|---|
| C1 | Every VM row has a **Console** button, every container row a **Shell** button (Incus, libvirt, Proxmox QEMU/LXC). Docker has none. |
| C2 | The console opens **in place** inside the guests card (the table is replaced; a **Guests** back button returns). Header: back, guest name (mono), state, type chip (e.g. "Incus VM · nixos/26.05"), uptime chip, **Fullscreen**, and a **connection type** switch. |
| C3 | Connection types per platform: libvirt VM: VNC, SPICE, Serial. Incus VM: VGA (SPICE), Serial. Incus container: Shell, Console. Proxmox QEMU: noVNC, SPICE, Serial. Proxmox LXC: xterm.js (shell), Console. |
| C4 | **Toolbar**. VM: Ctrl+Alt+Del, Paste, Screenshot, then Shutdown, Reboot, Force stop (destructive, styled with the serious color). Container: Paste, Copy output, Restart, Stop. The mockup shows only a confirmation chip; the real product must confirm destructive actions (see `REMOTE-CONSOLE.md`). |
| C5 | **Screen** area, 16:10, with a status line (connected + protocol + "encrypted", resolution, latency) and a hint ("Click the screen to capture keyboard and mouse · press Ctrl+Alt to release" for VMs, "Type in the terminal · Ctrl+D to log out" for containers). |
| C6 | A **side list** of all guests on the same host with status dots; selecting one switches the console without leaving the view. |
| C7 | **Stopped guest**: the screen shows a power icon, "<name> is powered off" and a **Start VM / Start container** button; toolbar buttons are disabled; status "Not connected". |
| C8 | **Screens view** (List / Screens toggle in the guests card header): a grid of 16:10 live thumbnails with name, status dot and type; clicking a tile opens its console. Stopped guests show a "powered off" tile. |
| C9 | Opening a console, switching guest, power actions and closing are all **audited** (who, guest, protocol, time). |

## 5. Thresholds and status rules

These are the intended rules. Centralize them in one module with unit tests.

| Signal | Good | Warning (`--warning`) | Serious (`--serious`) | Notes |
|---|---|---|---|---|
| Sensor temperature (sensor table, any sensor with a limit) | below 85% of limit | at or above 85% of limit | at or above limit | Limits per sensor (CPU 85, VRM 90, NVMe 75, DIMM 85, HDD 55, SATA SSD 70 in the mockup). Use the same rule on the fleet card's Temp dot, with the hottest sensor's own limit. |
| Disk used % (card dot, disk card bar, Proxmox storage bar) | below 80 | 80 to 89 | 90 and above | Bar color is blue when good, then yellow, then orange. |
| SSD wear % (card dot, disk card, banner, alert) | below 75 | 75 to 89 | 90 and above | "Wear high" label at 75 and above. Alert fires at 75. Wear is capped at 100 for display. |
| Memory assigned to guests / host RAM (hypervisor table) | below 80 | 80 to 89 | 90 and above | |
| vCPU overcommit (allocated / host threads) | up to 1.5 : 1 | above 1.5 : 1 | n/a | Meter spans 0 to 2 : 1, tick at 1 : 1. |
| Server status | Online | Warning: at least one open warning alert on the host | n/a | **Offline** (critical): no heartbeat for 60 s. Offline hosts are excluded from KPIs. |

Alert severities are only **critical** and **warning**. The serious color is used for data dots, bars and the destructive button, not as a third alert level.

### Default alert rules (M8)

| Rule | Condition | Severity |
|---|---|---|
| `agent.heartbeat_missing` | no heartbeat for 60 s | critical |
| `sensor.temp_high` | any sensor at or above 85% of its limit for 10 min | warning |
| `sensor.temp_critical` | any sensor at or above its limit for 5 min | critical |
| `disk.wear_high` | SSD wear at or above 75% | warning |
| `disk.wear_critical` | SSD wear at or above 90% | critical |
| `disk.space_high` | filesystem or storage at or above 90% | warning |
| `hypervisor.overcommit` | vCPU overcommit above 1.5 : 1 for 30 min | warning |
| `hypervisor.memory_assigned` | assigned memory at or above 90% of host RAM | warning |

Alert text format: title states the signal and value ("nvme1n1 wear at 78%"), detail gives the evidence ("936 of 1,200 TBW written", "Above 80 °C for 14 min").

## 6. Non-functional requirements

| Area | Requirement |
|---|---|
| Performance | Overview and detail pages render from cached API responses in under 1 s on a normal connection with 50 servers. Chart interaction (hover) stays at 60 fps. |
| Freshness | Live values no older than 15 s while the agent is connected. |
| Data integrity | Rollups keep both **average and maximum**; the chart draws the average, "Peak" uses the maximum. Gaps are explicit `null`s and render as gaps (heatmap: blank cell). |
| Agent overhead | Under 1% of one core and under 50 MB RSS on a typical host at 10 s intervals. |
| Resilience | Agent buffers up to 1 hour of samples if the hub is unreachable and backfills on reconnect. |
| Security | See `REMOTE-CONSOLE.md` and `ARCHITECTURE.md` section 7. |
| Accessibility | WCAG 2.2 AA; keyboard operable; all charts have a text equivalent. |
| Responsive | 390 px to 1440 px and wider; the sidebar collapses above the content on narrow screens (the mockup stacks it). |
| i18n | English strings in a catalog; time and number formats follow the viewer's locale. |
| Browsers | Current Chrome, Firefox, Safari, Edge. Container query units are used in the console screen scenes. |

## 7. Glossary

- **Agent**: the per-host process that collects and reports data.
- **Hub**: the central service the agents connect to; serves the API and the UI.
- **Guest**: a VM or container managed by Docker, Incus, libvirt or Proxmox VE.
- **Stack**: the virtualization manager on a host (Incus, libvirt, Proxmox VE).
- **Overcommit**: allocated vCPUs divided by host hardware threads.
- **Wear**: percentage of an SSD's rated endurance used.

## 8. Assumptions to confirm

1. Hosts are Linux. Windows and macOS hosts are not covered.
2. One hub, one tenant.
3. The agent can run as root or with specific capabilities to read SMART data and talk to Docker/Incus/libvirt.
4. Proxmox nodes without an agent are shown from the cluster API only (see S10).
