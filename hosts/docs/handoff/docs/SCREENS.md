# Screens

Screen-by-screen specification. Screenshot names refer to `design/screenshots/`; the same names exist as static HTML in `design/static/` (desktop views only; the four `mobile-*` views are PNG only). Field paths such as `fleet.json › kpis.cpu_avg_pct` refer to `sample-data/`. Requirement IDs (F1, S4, C2, ...) refer to `PRODUCT-SPEC.md`.

## 0. Routes and URL state

| Route | Page | Query / state |
|---|---|---|
| `/` | Fleet overview | `?range=24h&group=All` |
| `/servers/:id` | Server detail. Renders the **Proxmox host** variant when `server.detail_view == "proxmox"`. | `?range=24h&platform=docker\|incus\|libvirt\|vm\|ct&view=list\|screens` |
| `/servers/:id/guests/:guestId/console` | Same page with the console open | `?protocol=spice` |

Defaults: `range=24h`, `group=All`, platform = first platform with guests (the mockup defaults to Docker on a standard host and QEMU on Proxmox), `view=list`. Changing platform or view closes any open console.

## 1. Shared layout

- Page = flex row: **sidebar** (240 px, 1px right border `--line`) + **main** (fluid, min 560 px basis; padding `36px 48px 80px`; sections separated by 40 px).
- Below about 800 px the sidebar wraps above the main column (full width), then main uses the whole width. Cards keep their internal layout and wrap.
- **Sidebar**: brand mark + "Fleet" (17 px, 600), nav items 44 px high, radius 10, icon 18 px + label; active item has `--raised` background. "Settings" is pinned to the bottom. Alerts shows a red count badge (`--critical`, white text, 20 px pill).
- **Controls**: segmented control = pill group on `--panel` with 1 px `--line` border, radius 11, 3 px padding; options 36 px high, selected option `--seg-active` bg with `--ink` text, others `--ink-2`. Primary button = `--ink` background, `--bg` text, weight 500, radius 11, padding 0 18 px, 44 px high. Ghost button = 1 px `--line-strong` border.
- **Cards** = `--panel`, 1 px `--line`, radius 14, padding 24 to 28.

## 2. Fleet overview (`fleet-overview.png`, `fleet-overview-lab-7d.png`, `mobile-fleet-overview.png`)

Section order: header, KPI row, heatmap + attention row, Servers grid, Workloads, Hypervisors.

### 2.1 Header (F1)
Left: H1 "Overview" (30 px, 600), sub-line "{servers in the selected group} servers · {online} agents connected · Updated 8 s ago" (13 px, `--ink-2`; the timestamp part `--ink-3`; with the fixture, group All reads "8 servers · 7 agents connected"). Right: group segmented control (each option shows its count in `--ink-3`), range segmented control, **Add server** primary button with a plus icon. Controls wrap under the title on narrow screens.

### 2.2 KPI tiles (F2)
Grid `repeat(auto-fit, minmax(min(200px,100%), 1fr))`, gap 20. Tile = card, padding 24, column flex, gap 14: label (12 px `--ink-3`), value, then sub-line (13 px `--ink-2`).
Value: 34 px / 600 / -0.025em / line-height 1. In the Servers tile the "/ 8" is 18 px `--ink-3` on the same baseline (gap 8). Sparklines are 100% wide x 36 px, 1.5 px line, area at 12% opacity. **Values must not wrap** (`white-space: nowrap`); put the unit or the "of X" text on its own sub-line instead.

| Tile | Value | Sub-line | Extra |
|---|---|---|---|
| Servers online | `7 / 8` (`kpis.servers_online`, `servers_total`) | "1 offline · 2 with warnings" or "All reachable" | none |
| CPU, fleet average | `33%` (`cpu_avg_pct`) | sparkline | sparkline = mean of online servers per time bucket, blue |
| Memory, fleet | `64%` (`memory_pct`) | "506 of 784 GB" | sparkline, violet |
| Storage used | `62.2 TB` (`storage_used_tb`) | "of 100 TB", then a meter (`storage_pct`) and "1 disk over 75% wear" | meter color blue; text never wraps the value |
| Open alerts | `3` | "1 critical · 2 warning" or "All clear" | none |

The CPU tile has no text sub-line (the sparkline is its second row). In the Memory and Storage tiles the sub-line sits 8 px under the value; the Storage meter is 6 px high with 6 px extra top margin.

Compute: CPU avg = mean of `current.cpu_pct` over online servers; memory % = sum(used GB) / sum(total GB); storage = sum over online servers of `capacity × used%`.

### 2.3 CPU load by server (F3)
Card left, flex `2 1 560px`, padding 28, gap 24. Title, sub-line ("Last 24 hours · one cell per 30 min · blank means no data"), legend top right: "0%", 7 swatches (18 x 10 px, radius 2, gap 2), "100%". Rows: gap 6 between rows. Each row = hostname label (72 px wide, mono 12 px, `--ink-2`), 12 px gap, then 48 equal cells (height **24 px**, gap 2, radius **3**). Below: five x-axis labels (12 px `--ink-3`, `space-between`) with a left margin of 84 px so they align with the cell grid, using the range tick format (section 7.3). Cell colors by bin (`--heat-0..6`, bounds in `tokens.css`). No-data cells: transparent with `inset 0 0 0 1px rgba(255,255,255,.08)`. Each cell has a native tooltip text; a custom tooltip is welcome but must show the same text. Rows are the servers in the selected group, in card order.

### 2.4 Needs attention (F4)
Card right, flex `1 1 340px`, padding 28, gap 20. Header "Needs attention" + "All alerts" link (13 px `--ink-2`). Each alert row: padding 18 px 0, 1 px top border `--line`, 14 px gap. Severity icon 20 px with accessible name (critical = circle with an X in `--critical-text`, warning = triangle in `--warning`). Title (500) with the relative time (12 px `--ink-3`, no wrap) on the same line, right aligned; below it "host · detail" (13 px `--ink-2`, host in mono `--ink`). Empty: "No open alerts for this selection." Source: `fleet.json › alerts`.

### 2.5 Server cards (F5)
Section title "Servers" with the right-aligned caption "{n} of {total} shown · sparklines show the selected range". Grid `repeat(auto-fit, minmax(min(340px,100%), 1fr))`, gap 24.

Card anatomy (padding 28, column flex, gap 24, radius 14; hover = `--raised` bg and `--line-strong` border, 150 ms; the whole card is a link):

1. **Top row**: left = status dot + status word (12 px `--ink-2`) + dim reason (`--ink-3`, e.g. "Warning · CPU temperature"); right = chips (**KVM** if hypervisor, then group). Below the status line: hostname (mono 20 px / 500, -0.01em, 10 px top margin), OS (13 px `--ink-2`), hardware (13 px `--ink-3`). The status text must not wrap (see README, known issues).
2. **CPU and MEM rows** (gap 16): grid `36px 52px 1fr`, gap 12: label (12 px `--ink-3`), value (18 px / 600 / -0.02em), sparkline (36 px high, 1.5 px line, area 12%; CPU blue, MEM violet).
3. **Stats**: 20 px top padding, top border `--line`, three equal columns (gap 12): Temp, Disk, Disk wear. Each = label (12 px) and below it dot + value (15 px / 500, 4 px top margin).
4. **Workload row** (online only): gap 20, 13 px `--ink-2`; Docker (running), Incus (containers + VMs running), QEMU (VMs running), each with a 15 px icon and a bold `--ink` count.

Offline: card opacity .7, values "—", status dot `--critical`, stat dots gray (`--muted`), sparklines stop at the last sample, and the line "Agent unreachable. Last seen 02:14 (11 h 47 m ago)." (13 px `--ink-2`) replaces the workload row.

The last grid cell is the **Enroll** card, same card style, `min-height: 200px`, content centered vertically and left aligned: a 40 px circle (1 px `--line-strong` border) with a plus icon, "Enroll a server" (16 px / 500) and "Install the agent on a new host, then approve it here." (13 px `--ink-3`, max 30ch).

### 2.6 Workloads (F6)
Title "Workloads", caption "Across 7 online servers". Three equal cards (grid `repeat(auto-fit, minmax(min(340px,100%),1fr))`, gap 24; card padding 28, gap 24). Each: icon in a **40 px** square (radius 10, `--raised`; 20 px icon) with a 14 px gap to the name (16 px / 600) and sub-title (12 px `--ink-3`); big count (44 px / 600) + "running" (`--ink-2`) + "of N" (12 px `--ink-3`, right aligned); state bar (6 px, radius 3, segments sized by count with 2 px gaps: Running `--good`, Stopped `--muted`, Unhealthy `--serious`); legend row (13 px, dot + label + bold count, 12 px top margin); stack split row (Incus: "Containers 15 · KVM VMs 7"; QEMU / KVM: "Proxmox VE 18 · libvirt 6"; Docker has none); divider; "Top by CPU" list: rows with 12 px vertical padding in a grid `1fr 84px 40px`, gap 14: guest name (mono) with host below (12 px `--ink-3`), 84 px bar (blue on `--track`), percent right aligned. Source: `fleet.json › platform_summary`, `top_guests_by_cpu` (top 3, only guests on servers in the current group and online).

### 2.7 Hypervisors (F7)
Title "Hypervisors", caption "KVM hosts running Incus, libvirt / QEMU or Proxmox VE · allocation against physical capacity". One card containing a table (columns: Host, Stack, KVM, Guest VMs, Containers, vCPU allocated, Memory assigned; grid `0.9fr 1.5fr 110px 90px 100px 1.3fr 1.3fr`, gap 20, row padding 20 x 24). Stack chips are outlined pills. KVM = dot + "Enabled". The two allocation columns show a status dot, bold `allocated / total`, then the ratio or percent in `--ink-3`, with a 6 px meter under it (vCPU meter blue, memory meter violet; the vCPU meter has a 1 px tick at 50% width = 1 : 1). Footnote: "The vCPU bar spans 0 to 2 : 1 overcommit; the tick marks 1 : 1. Proxmox VE hosts also run LXC containers." Rows link to the host page. Source: `servers[].hypervisor`.

### 2.8 States to implement beyond the mockup
Loading skeletons for cards and charts; "No servers yet" empty state that leads to enrollment; per-card error state when a server's data is stale for more than 60 s (treated as offline); partial data (a host without a hypervisor has no row in Hypervisors and no KVM chip).

## 3. Server detail, standard host (`server-detail.png`, `mobile-server-detail.png`)

Section order: header, banner (conditional), meta strip, CPU + Memory, Temperatures, Storage, Virtualization, Workloads.

### 3.1 Header and banner (S1, S2)
Breadcrumb 13 px; H1 hostname mono 30 px / 500; chips: status chip (dot + "Warning · 1 alert"), group, "KVM host"; **Switch server** pill button with chevron (opens a host picker). Right: "Live · refreshes every 10 s" with a green dot, range control. Banner: card with 1 px border `rgba(250,178,25,.35)`, padding 18 x 24, warning triangle icon, bold title, `--ink-2` detail, right-aligned underlined link ("View disk" jumps to `#storage`). Banner color follows the alert severity; critical uses `--critical`.

### 3.2 Meta strip (S3)
Card with `repeat(auto-fit, minmax(min(140px,100%), 1fr))`, six fields: label 12 px, value 15 px / 500, sub-line 13 px `--ink-3`. Fields: Operating system (name + version, "Kernel x.y.z"), Processor (model, "24 cores · 48 threads"), Memory ("256 GB", "DDR4 ECC"), Uptime ("41 d 7 h", "Last boot Aug 31"), Address (mono IP, "Rack A · unit 4"), Agent ("v0.14.2", "Synced 8 s ago").

### 3.3 CPU and Memory charts (S4)
Two cards side by side (flex `1 1 480px`, stack on narrow). Card anatomy:

1. Title (16 px 600). Under it: current value (40 px / 600) + sub-label (12 px). Right: "Average **34%**" and "Peak **58%** at Sat 16:30" (13 px; numbers `--ink` 500).
2. Plot: y-axis gutter 44 px with labels 100%, 75%, 50%, 25%, 0%; plot height **220 px**; solid hairline grid `rgba(255,255,255,.07)` (4 intervals); area fill = series color at **10%** opacity; line **2 px**, round joins (sparklines on cards use 1.5 px); the y range is fixed 0 to 100.
3. Hover layer: vertical crosshair (1 px, `rgba(255,255,255,.22)`), a 10 px dot in the series color with a 2 px ring in the card color, tooltip (`--tooltip-bg` `#1c1e23`, 1 px `--line-strong`, radius 10, padding 10 x 14, shadow `0 8px 24px rgba(0,0,0,.4)`) with time (12 px `--ink-3`), a 12 x 2 px color key + value (17 px / 600), and the absolute amount ("of 48 threads", "156 of 256 GB"). The tooltip flips to the left of the crosshair when the crosshair is past 58% of the width. The crosshair rests at about 72% of the range when the pointer is outside the plot.
4. x-axis: five labels (section 7.3).
5. Divider and **facts row** (4 columns): CPU = User, System, I/O wait, Load 1 / 5 / 15 min; Memory = Used, Cache (ZFS ARC on Proxmox), Free, Swap.
Data: `timeseries-basalt-24h.json` (`cpu_pct`, `mem_pct`), `server-basalt.json › live`.

### 3.4 Temperatures (S5)
One card. Title "Temperatures", sub "Five sensors · hottest component per group · solid line marks the warning limit", right "Highest right now **64 °C** (CPU package)". Left: chart, plot height **300 px**, y axis 20 to 100 °C with ticks 100/80/60/40/20 + "°", five 2 px lines in the series order CPU blue, VRM orange, NVMe aqua, DIMM yellow, HDD magenta; a **solid** 1 px line at the CPU limit (85 °C) with the label "85 °C warning"; **direct end labels** at the right edge (CPU, VRM, NVMe, DIMM, HDD) placed at the last value; hover crosshair + one dot per series + tooltip listing all five with their color keys. Right: sensor table with columns Sensor (color key + name + mono source), Now (status dot + value), Max, Limit. Dot rule = section 5 of the spec. Source: `server-basalt.json › sensors`.

### 3.5 Storage (S6)
Title "Storage", right caption "4 disks · 22.3 TB used of 35 TB" (13 px `--ink-2`). Grid of disk cards, `repeat(auto-fit, minmax(min(480px,100%),1fr))`, gap 24 (two per row on desktop). Card: padding 28, column flex, gap 26.

1. **Header row**: 44 px rounded square icon (radius 11, `--raised`), then device (mono 17 px / 500) + type chip (NVMe / HDD), model (`--ink-2`), role and mount (12 px `--ink-3`). Right: health chip (dot + "Healthy" or "Wear high"; "Wear high" = `--warning` dot when SSD wear >= 75%).
2. **Space used**: label "Space used" (12 px) left; right "**440 GB** of 1 TB · 44%" (13 px, bold value, rest `--ink-3`). 6 px bar under it: blue below 80%, `--warning` at 80 to 89, `--serious` at 90+.
3. **Wear**: SSD = label "Wear (endurance used)", right "**78%** · 936 of 1,200 TBW" and a 6 px bar (blue below 75, `--warning` 75 to 89, `--serious` 90+). HDD = label "Wear" with "Not applicable (spinning disk)" on the right, and below it three counters: Reallocated sectors, Pending, Uncorrectable (value bold `--ink`, 13 px, gap 24).
4. **Footer**: 22 px top padding, top border `--line`, three equal columns: Temperature ("49 °C"), Power-on ("14,210 h"), SMART ("Passed"); label 12 px, value 500.

Anchor `#storage`. Source: `server-basalt.json › disks`.

### 3.6 Virtualization (S7)
Section header: "Virtualization", sub "KVM host · Incus and libvirt / QEMU guests · reported by the agent", chip "KVM enabled" (dot + text). Capabilities card: 3 x 2 grid (`minmax(min(300px,100%),1fr)`), each = label, dot + value (500), mono sub-line. Allocation row: four cards (`minmax(min(240px,100%),1fr)`): big value (34 px) + unit (13 px), then a meter or a sparkline (200 x 36, 2 px line, area 10%), then a sub-line. vCPU meter fill color: blue when overcommit <= 1.5 : 1, `--warning` above. Memory meter violet, `--warning` at 80%+. Source: `server-basalt.json › virtualization`.

### 3.7 Workloads and guests (S8, S9)
Title "Workloads", caption "Reported by the agent · select a platform to list its instances · open a console from any row". Three platform cards (**tabs**, `aria-pressed`): selected card has `--raised` bg and `--line-selected` border. Below, the **guests card**:

- Header row: table title ("Incus instances · 2 KVM VMs and 4 containers"), **List / Screens** segmented control (only for platforms with consoles), filter input (40 px high, 240 px wide, search icon).
- **List**: columns per S9. Header row 12 px `--ink-3`; body rows 13 px with 14 px vertical padding, 1 px dividers. CPU cell = 48 px bar (blue on `--track`) + value; stopped rows show an empty bar at 40% opacity and "—". The last column holds the **Console** (VM) or **Shell** (container) ghost button, 32 px high, with a monitor or terminal icon; for stopped guests the label is dimmed but the button still opens the console. Footer line: "Showing all 7 instances, sorted by CPU · disk in MB/s (read / write), network in Mb/s (receive / transmit)".
- **Screens**: grid `repeat(auto-fill, minmax(min(260px,100%), 1fr))`, gap 16. Tile = 12 px radius, `--bg` fill, 10 px padding; 16:10 screen (radius 8, 1 px `--line`), below it a row with status dot, name (mono 13 px), and "VM" or "Container" on the right. Hover: `--raised`. Running guests show a scaled-down real frame (VNC/SPICE framebuffer or last terminal lines), refreshed about every 5 s and **only while the tile is visible**; stopped guests show a power icon and "<name> is powered off".
- **Console**: see section 5.

Docker table columns: Name (mono), Image, State, CPU, Memory, Uptime ("41 d", or "Exited 6 h ago" for stopped). No View toggle and no console. Docker has no guest console in scope.

## 4. Proxmox VE host (`proxmox-host.png`, `proxmox-vm-screens.png`, `proxmox-lxc-list.png`, `mobile-proxmox-host.png`)

Same as section 3 with these differences, in page order:

1. **Header** adds the chip "Proxmox VE 9"; banner is driven by the host's alert (CPU temperature in the sample). "View temperatures" jumps to `#temps`.
2. **Meta strip**: OS "Proxmox VE 9" + "Debian 13 · pve kernel"; processor "EPYC 9124 · 16 cores · 32 threads".
3. **Cluster** (S10) comes right after the meta strip. Title "Cluster: prod-pve", sub "Reported by the Proxmox API on this node"; chips "Quorate · 3 of 3 votes", "HA · 6 resources started". Table: Node (mono; "This node" chip on the current host), Status (dot + "Online"), CPU (bar + %), Memory (bar + %), Guests ("18 VMs · 4 CTs"), Agent (dot + "Connected" or an **Enroll agent** button). Note under the table. Source: `server-shale-proxmox.json › cluster`.
4. **CPU / Memory / Temperatures** as in 3.3 and 3.4. Memory facts: Used, ZFS ARC, Free, Swap. Sensors: CPU package, Board / VRM (ipmi), NVMe, Memory modules, SATA SSD.
5. **Virtualization** (S7) uses Ballooning ("Active on 14 of 18 VMs") instead of Hugepages. In the sample the vCPU overcommit is 1.63 : 1 and memory assigned is 82%, so both meters use `--warning`.
6. **Guests** (S8, S9): two tabs, **QEMU / KVM** (VMs) and **LXC containers**. Table: ID (mono), Name, State, vCPU, CPU, Memory, Disk R/W, Net rx/tx, **Backup** (dot + "OK 02:06" or "OK 3 d ago"), Console/Shell. Footer: "Showing 8 of 22 VMs, sorted by CPU".
7. **Storage** (S6p): left card "Proxmox storages" (id mono + type chip, "41 GB of 94 GB · 44%", content line, bar; yellow at 80%+), right card "Disks and wear" (Disk, Model, Pool, Wear bar + %, Temp; footnote "Wear is the endurance used reported by SMART. All six disks pass SMART.").
8. **Backups** (S11): card with a 3 x 2 grid of label / value / sub-line; chip "Last run succeeded" in the section header.

## 5. Remote console (`server-incus-console-vm.png`, `server-incus-console-container.png`, `server-incus-console-stopped.png`, `server-qemu-console-windows.png`, `proxmox-vm-console.png`, `proxmox-lxc-console.png`, `mobile-server-console-vm.png`)

The console replaces the table **inside the guests card** (platform tabs stay above it). Behavior requirements are C1 to C9; see `REMOTE-CONSOLE.md` for transport and security.

Layout inside the card:

1. **Header row** (padding 20 x 24, bottom border): `← Guests` ghost button, guest name (mono 16 px / 500), state (dot + "Running"/"Stopped"), type chip ("Incus VM · nixos/26.05", "libvirt VM · q35 · OVMF", "QEMU VM 105 · FreeBSD · OVMF", "LXC 202 · debian 13"), uptime chip ("Up 6 d" or "Not running"), then right-aligned **Fullscreen** ghost button and the **connection type** segmented control.
2. **Body** (padding 24, two columns that wrap): main column `flex: 1 1 520px` + side list `flex: 0 1 232px`.
3. **Toolbar** (ghost buttons 36 px high, 16 px icons): left group (VM: Ctrl+Alt+Del, Paste, Screenshot; container: Paste, Copy output), right-aligned group (VM: Shutdown, Reboot, Force stop in `--serious`; container: Restart, Stop). Disabled (40% opacity, no-op) when the guest is stopped.
4. **Screen**: `aspect-ratio: 16/10`, background `--terminal-bg`, 1 px `--line-strong`, radius 10. Content by guest: text console or shell = monospace on dark (font size 1.7% of the screen width so it scales with the container; colors `--term-*`; blinking block cursor, disabled when the user prefers reduced motion); graphical VM = the live framebuffer scaled to fit; stopped = centered power icon, "<name> is powered off", primary **Start VM / Start container** button.
5. **Status line** below the screen: dot + "Connected · VGA (SPICE) · encrypted" (or "Not connected · the guest is powered off"), a transient confirmation chip after toolbar actions, and on the right mono 12 px "1280×800 · 9 ms latency".
6. **Hint line** (12 px `--ink-3`).
7. **Side list**: caption (the platform's name, e.g. "Incus instances", "libvirt VMs", "QEMU / KVM VMs", "LXC containers"), then one 44 px row per guest on this host: status dot, name (mono 13 px), kind on the right ("VM", "Container"). The current guest has the `--raised` background.

Mobile (390 px): header items wrap onto several lines, toolbar buttons wrap, the screen is full width at 16:10, and the side list moves below.

Real-implementation notes: the screen element receives keyboard focus on click (VM consoles capture keys; Esc or Ctrl+Alt releases); Fullscreen uses the Fullscreen API on the screen element; when the connection drops show an inline "Connection lost · Reconnect" state in place of the status line.

## 6. Interaction summary

| Control | Effect |
|---|---|
| Range (1h, 6h, 24h, 7d, 30d) | Re-queries all series; crosshair resets; axis ticks follow section 7.3 |
| Group (overview) | Re-computes every number on the page |
| Platform card (tab) | Switches the guests table; closes any console |
| List / Screens | Switches the guests card view; closes any console |
| Console / Shell button, Screens tile | Opens the console for that guest |
| Side list row | Switches console to that guest |
| Connection type | Reconnects with the selected protocol |
| Fullscreen | Fullscreen the screen element |
| Toolbar power actions | Confirm dialog, then call the power API; audit entry |
| Chart hover | Crosshair, marker, tooltip; shared across both charts in a row on the detail page |
| Server card, hypervisor row | Navigate to the host (Proxmox hosts open the Proxmox page) |

## 7. Formats

### 7.1 Numbers
Percentages: integers on cards and KPIs, one decimal in tooltips and tables ("44.0%"). Memory: "9.8 / 16 GB"; below 1 GB use MB ("128 MB"). Storage sizes: GB below 1000 ("440 GB"); from 1000 GB, TB with two decimals below 10 TB ("1.42 TB") and one decimal from 10 TB ("10.2 TB", "22.3 TB"), trailing zeros trimmed ("1 TB", "35 TB", "100 TB"). Rates: disk in MB/s, network in Mb/s, switching to Gb/s above 1000. Temperatures: "64 °C" in text, "64°" in dense tables.

### 7.2 Relative time
"8 s ago", "14 min ago", "2 d ago", and "since 02:14" for an offline start time today.

### 7.3 Axis tick labels (5 labels, evenly spaced from the oldest to "Now")
| Range | Format | Example |
|---|---|---|
| 1h, 6h | `HH:MM` | `13:15` |
| 24h | `Ddd HH:MM` | `Sat 20:11` |
| 7d, 30d | `Mmm D` | `Oct 6` |
Tooltip time for 7d and 30d is `Mmm D, HH:MM`; for 24h `Ddd HH:MM`; otherwise `HH:MM`.

### 7.4 Series resolution per range
| Range | Points (detail charts) | Step |
|---|---|---|
| 1h | 60 | 1 min |
| 6h | 72 | 5 min |
| 24h | 96 | 15 min |
| 7d | 84 | 2 h |
| 30d | 120 | 6 h |
Overview sparklines use 60 points, the heatmap 48 buckets, across the selected range.
