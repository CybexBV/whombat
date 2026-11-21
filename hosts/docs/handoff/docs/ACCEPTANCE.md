# Acceptance checklist

Run the relevant parts after every milestone (`AGENTS.md` section 5). Each item is checkable. "Fixture" means the numbers come from `sample-data/`; with those fixtures served as API responses the UI must show exactly these values. Reference images are in `design/screenshots/`.

## 0. Method

1. **Visual regression.** Render each page with the fixtures at 1440 px and 390 px wide (the screenshot file names say which state). Compare against the PNGs. Anti-aliasing differences are fine; layout shifts, wrapping, clipped text, different spacing and different colors are not. Use `design/static/*.html` to read exact values when a difference is unclear.
2. **Fixture contract.** The fixtures validate against your types, and the UI renders from them without code changes.
3. **Unit tests** for section 7 (thresholds, bins, formats).
4. **Keyboard and screen reader pass** (section 9).
5. Record deviations and open questions in `NOTES.md`.

## 1. Global

- [ ] Range control (1h, 6h, 24h, 7d, 30d) changes every chart, sparkline and the heatmap on the page; default is 24h; the selected range is in the URL (`?range=7d`) and survives reload (G1, G5).
- [ ] Group control on the overview shows `All 8`, `Production 4`, `Lab 2`, `Edge 2` and recomputes every number on the page (G2).
- [ ] Data refreshes every 10 s without visible flicker; focus, scroll position and an open tooltip survive a refresh (G3).
- [ ] Sidebar: Overview and Servers work; Workloads, Storage, Alerts, Agents, Settings are inert placeholders (G4). The Alerts badge shows the open alert count.
- [ ] Times display in the viewer's time zone (change the browser zone and confirm the axis labels, "Last boot", and alert times shift); the API and storage stay in UTC.
- [ ] Number formats follow `SCREENS.md` section 7 (see tests in section 7 of this file).

## 2. Fleet overview (`fleet-overview.png`, `mobile-fleet-overview.png`)

Fixture `fleet.json`, group All, range 24h.

- [ ] Header: "Overview"; sub-line "8 servers · 7 agents connected · Updated 8 s ago" (servers in the group, online agents, age of data).
- [ ] KPI tiles show **7 / 8** servers online with "1 offline · 2 with warnings"; **33%** CPU; **64%** memory with "506 of 784 GB"; **62.2 TB** storage "of 100 TB" with a meter and "1 disk over 75% wear"; **3** open alerts "1 critical · 2 warning". Values never wrap at any width.
- [ ] Heatmap: 8 rows (card order), 48 cells each, 7-bin legend, `marble` shows no-data cells as blank with a faint ring after its last sample, hover shows "server · time · NN%".
- [ ] Needs attention lists 3 alerts: marble "Agent unreachable" (critical), basalt "nvme1n1 wear at 78%", shale "CPU package at 83 °C" (warning); each with host, detail and relative time.
- [ ] 8 server cards plus the Enroll card. `basalt` and `shale` show Warning with a reason; `marble` is dimmed, shows "—", gray stat dots and "Agent unreachable. Last seen 02:14 (11 h 47 m ago)." (time rendered in the viewer's zone).
- [ ] The status line of a server card never wraps (the `shale` card must not repeat the mockup's wrapping bug); chips wrap instead.
- [ ] Workloads: Docker **67** running of 78 (9 stopped, 2 unhealthy; unhealthy is its own state, not part of running); Incus **22** running of 26 (15 containers, 7 VMs; 4 stopped); QEMU / KVM **24** running of 30 (18 Proxmox VE, 6 libvirt; 6 stopped). Top by CPU shows 3 guests per card.
- [ ] Sub-titles pluralize correctly ("libvirt on 3 servers · Proxmox VE on 1 server").
- [ ] Hypervisors table has one row per online KVM host (basalt, obsidian, quartz, shale, onyx); basalt shows 22 / 48 vCPU "0.46 : 1" and 52 / 256 GB memory "20%"; shale shows 52 / 32 vCPU "1.63 : 1" with a **warning** dot and 158 / 192 GB "82%" with a warning dot; rows link to the hosts.
- [ ] **Lab + 7d** matches `fleet-overview-lab-7d.png`: "2 servers · 2 agents connected", 2 / 2 online "All reachable", CPU 21%, memory 47% "60 of 128 GB", storage 14.6 TB "of 20 TB" "No disks near end of life", 0 alerts "All clear", heatmap rows quartz and onyx labeled "Last 7 days", "Oct 4 ... Now" ticks, "No open alerts for this selection.", "2 of 8 shown".
- [ ] Heatmap sub-line states the real cell size ("one cell per 3.5 h" for 7d); the mockup says "4 h".
- [ ] Empty, loading and stale states exist (`SCREENS.md` 2.8).

## 3. Server detail, standard host (`server-detail.png`, `mobile-server-detail.png`)

Fixture `server-basalt.json`, range 24h, default platform Docker.

- [ ] Header: breadcrumb, `basalt`, chip "Warning · 1 alert", "Production", "KVM host", Switch server, "Live · refreshes every 10 s".
- [ ] Banner "nvme1n1 wear is at 78%" with detail and a **View disk** link that jumps to Storage. No banner when there is no open alert for the host.
- [ ] Meta strip: NixOS 26.05 / Kernel 6.18.44; EPYC 7443P / 24 cores · 48 threads; 256 GB / DDR4 ECC; Uptime 41 d 7 h / Last boot Aug 31; Address 10.20.0.11 / Rack A · unit 4; Agent v0.14.2 / Synced 8 s ago.
- [ ] CPU card: current **34%**, "24 cores · 48 threads", average and **peak with time** over the range, fact row User 22.4, System 9.2, I/O wait 2.4, Load. Memory card: **61%**, "156 of 256 GB", Used / Cache 71 / Free 29 / Swap.
- [ ] Charts: plot 220 px high, y labels 100% to 0%, 2 px line, 10% area, crosshair resting at about 72% until hover, tooltip flips left after 58% of the width, both charts share the hover position, five x labels in the right format for each range.
- [ ] Peak is the stored **maximum** for the range, not the maximum of the plotted average points (test with a spike shorter than one bucket).
- [ ] Temperatures: "Highest right now 64 °C (CPU package)", five lines in the fixed series colors, a solid 85 °C limit line labeled "85 °C warning", end labels CPU / VRM / NVMe / DIMM / HDD, tooltip lists all five, table has Sensor, Now (status dot), Max, Limit.
- [ ] Storage: "4 disks · 22.3 TB used of 35 TB". nvme1n1 shows **Wear high** (warning dot), "1.42 TB of 2 TB · 71%", wear 78% with a yellow bar and "936 of 1,200 TBW written", 49 °C, 14,210 h. HDDs show "Not applicable (spinning disk)" and the SMART counters.
- [ ] Virtualization: "KVM enabled", six capabilities as in the fixture, four allocation cards; the vCPU meter has the 1 : 1 tick; vCPU "22 on 48 threads" "Overcommit 0.46 : 1".
- [ ] Workloads: three platform cards act as tabs (`aria-pressed`); Docker 14 / 16, Incus 6 / 7 (4 containers, 2 VMs), QEMU 3 / 4. Switching a tab changes the table and closes any console.

## 4. Proxmox host (`proxmox-host.png`, `proxmox-vm-screens.png`, `proxmox-lxc-list.png`, `mobile-proxmox-host.png`)

Fixture `server-shale-proxmox.json`.

- [ ] Same checks as section 3 where the sections are shared, plus the chip "Proxmox VE 9", banner "CPU package is at 83 °C" with **View temperatures**, meta "EPYC 9124 / 16 cores · 32 threads".
- [ ] Cluster "prod-pve": chips "Quorate · 3 of 3 votes" and "HA · 6 resources started"; three nodes; `shale` has the "This node" chip; `schist` and `slate` (not enrolled) show an **Enroll agent** button instead of "Connected".
- [ ] Memory facts show ZFS ARC instead of Cache. Virtualization shows Ballooning "Active on 14 of 18 VMs"; vCPU **1.63 : 1** and memory assigned **82%** both use the warning color.
- [ ] Guests: two tabs (QEMU / KVM, LXC containers); VM table includes ID, vCPU, Disk R/W, Net, **Backup**; footer "Showing 8 of 22 VMs, sorted by CPU".
- [ ] Storage: Proxmox storages (bars turn yellow at 80%) and Disks and wear table; Backups card with the six fields and "Last run succeeded".

## 5. Guests and console

Check against `server-incus-list.png`, `server-qemu-list.png`, `server-incus-screens.png`, `server-incus-console-vm.png`, `server-incus-console-container.png`, `server-incus-console-stopped.png`, `server-qemu-console-windows.png`, `proxmox-vm-console.png`, `proxmox-lxc-console.png`, `mobile-server-console-vm.png`.

- [ ] Incus table: 7 instances, columns per S9, CPU bar + value, stopped rows show "—" and an empty dimmed bar, VMs have a **Console** button and containers a **Shell** button; stopped guests keep the button.
- [ ] **List / Screens** toggle exists for Incus, libvirt, Proxmox QEMU and LXC; not for Docker. Screens tiles are 16:10 with status dot, mono name and "VM" or "Container"; stopped = power icon and "<name> is powered off". Tiles update about every 5 s **only while visible**.
- [ ] Opening a console replaces the table inside the guests card; **← Guests** returns; platform tabs stay.
- [ ] Console header: guest name, state, type chip, uptime chip, Fullscreen, connection-type control showing the protocols from the guest's `console.protocols` (e.g. libvirt: VNC, SPICE, Serial; Incus VM: VGA (SPICE), Serial; Incus container: Shell, Console).
- [ ] Toolbar contents per guest kind (VM vs container); destructive actions open a confirmation dialog; Force stop and Stop use the `--serious` color; all disabled for stopped guests.
- [ ] Status line shows protocol, "encrypted", resolution and a **measured** latency.
- [ ] Side list shows all guests of the host; selecting one switches the console without leaving the card.
- [ ] Stopped guest: "Not connected · the guest is powered off" and a Start button (visible only with the `power` permission).
- [ ] At 390 px the header, toolbar and side list wrap and the screen is full width at 16:10.
- [ ] Real transports work end to end against at least one guest of each stack you support (VNC, serial, shell) and the SPICE status (working or clearly marked unavailable); see `REMOTE-CONSOLE.md` section 10 for the security checklist.

## 6. Data integrity

- [ ] Heatmap, sparklines and charts render `null` as a gap, not a zero or interpolated value.
- [ ] An offline server is excluded from KPIs, averages and the Hypervisors table, but stays in the heatmap with a trailing gap and on the cards as Offline.
- [ ] Rollups keep average and maximum; 30d "Peak" matches the true maximum.
- [ ] Switching the range never mixes resolutions (1h = 60 points at 1 min ... 30d = 120 points at 6 h).
- [ ] Agent buffering: stop the hub for 5 minutes; after reconnect the charts show the backfilled samples with no duplicates.
- [ ] The offline state starts at 60 s without a heartbeat.

## 7. Unit-test vectors

**Sensor temperature status** (limit 85): 72.0 good; 72.25 warning; 84.9 warning; 85.0 serious. Same with limit 90 (VRM): 76.4 good; 76.5 warning; 90 serious.

**Disk used %**: 79 good (blue); 80 warning (yellow); 89 warning; 90 serious (orange).

**SSD wear %**: 74 good; 75 warning and label "Wear high" and alert `disk.wear_high`; 89 warning; 90 serious and `disk.wear_critical`; 100 displays as 100.

**Memory assigned / host RAM**: 79 good; 80 warning; 90 serious.

**vCPU overcommit**: 1.50 good; 1.51 warning; meter width = min(ratio / 2, 1) x 100%, tick at 50%.

**Heatmap bins** (CPU %): 7.9 → bin 0; 8 → 1; 19.9 → 1; 20 → 2; 34.9 → 2; 35 → 3; 49.9 → 3; 50 → 4; 64.9 → 4; 65 → 5; 79.9 → 5; 80 → 6; 100 → 6; null → blank cell.

**Server status**: heartbeat age 59 s → online (or warning if it has an open warning alert); 60 s → offline.

**Formats**: 62.2 TB; 100 TB; 440 GB; 1.42 TB; 10.2 TB; 128 MB (below 1 GB); disk "42 MB/s", network "412 Mb/s" and "1.2 Gb/s" above 1000; "64 °C" in text and "64°" in dense tables; relative time "8 s ago", "14 min ago", "2 d ago".

**Axis ticks**: 1h/6h `13:15`; 24h `Sat 20:11`; 7d/30d `Oct 6`; tooltip 7d/30d `Oct 6, 14:00`.

**KPIs** from the fixture: CPU average = mean of the 7 online servers' `cpu_pct`; memory % = sum used / sum total; storage = sum over online servers of capacity x used %.

**Overcommit from guests**: vCPU allocated for basalt = sum of running VM vCPUs = 22.

## 8. Responsive

- [ ] At 1440, 1280, 1024, 768, 390 and 320 px: no horizontal page scroll; no overlapping or clipped text; KPI values and status lines never wrap; tables scroll inside their card.
- [ ] Below about 800 px the sidebar sits above the content; cards keep their internal layout.
- [ ] 200% browser zoom works at 1280 px wide.

## 9. Accessibility (WCAG 2.2 AA)

- [ ] Every control is reachable by Tab in visual order; focus ring is 2 px `--focus` with a 2 px offset and is never hidden.
- [ ] Segmented controls have a group label and `aria-pressed`; platform cards have `aria-pressed`; icon-only buttons have names; status dots are hidden from assistive technology and the adjacent text states the status.
- [ ] Every chart has a text equivalent: visible current, average and peak, **plus** a "View as table" control that lists the values; keyboard users can move through the plot with arrow keys and hear/see the tooltip values.
- [ ] No information by color alone: dots always have a word or a labeled row; blue and violet series are always labeled CPU and MEM (`DESIGN-SYSTEM.md` 7.2).
- [ ] Text contrast at least 4.5 : 1, graphics at least 3 : 1, except the documented `--muted` and `--line-selected` cases which are backed by text.
- [ ] Minimum text 12 px; touch targets at least 36 px (row action buttons sit in 44 px rows).
- [ ] Status changes (server goes offline, new alert) are announced politely; the 10 s refresh is not.
- [ ] `prefers-reduced-motion` stops the cursor blink and any thumbnail animation.
- [ ] The console screen captures keys only after a click; Ctrl+Alt releases them; Esc exits fullscreen.

## 10. Performance

- [ ] With 50 servers the overview and a detail page render from cached responses in under 1 s; chart hover stays smooth (no dropped frames visible in a performance trace).
- [ ] Agent on a host with 50 guests uses under 1% of one core and under 50 MB RSS at 10 s intervals.
- [ ] Thumbnail polling stops for off-screen tiles and hidden tabs.

## 11. Delivery

- [ ] `NOTES.md` lists deviations, decisions taken (against the table in `AGENTS.md` section 7), questions for the human, and everything that could not be verified (especially the items in `ARCHITECTURE.md` section 9 and `REMOTE-CONSOLE.md` section 11).
- [ ] The README of the implementation tells how to run the hub, the UI against the fixtures, and the agent.
