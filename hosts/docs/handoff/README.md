# Fleet monitor: UI hand-off package

A hand-off package for an AI coding agent (or a human developer) that will build a **multi-server monitoring dashboard**. It contains the finished UI mockup (screenshots, static HTML, design source, tokens), sample data, and written specs for behavior, architecture and API.

> **Status: design mockup, not production code.** Every number, hostname and log line in the UI is **sample data**. "Fleet" is a placeholder product name. Nothing here has been implemented against real agents, hypervisors or databases.

## What the product is

A lightweight **agent** runs on each server and reports to a central **hub**. The web UI shows:

- a **fleet overview**: health KPIs, a CPU heatmap, alerts, a card per server, workload totals and a hypervisor capacity table;
- a **server detail** page: CPU and memory history (1h / 6h / 24h / 7d / 30d), temperatures, disk space per disk **including SSD wear**, KVM/virtualization capabilities, and the workloads on the host (Docker, Incus, libvirt/QEMU);
- a **Proxmox VE host** page: the same plus cluster, Proxmox storages, disks and backups;
- a **remote console** for every VM (screen) and container (shell), plus a "Screens" wall of live thumbnails.

## Read in this order

| # | File | Why |
|---|---|---|
| 1 | `AGENTS.md` | Instructions for the implementing agent: rules, build order, definition of done, open decisions. |
| 2 | `docs/PRODUCT-SPEC.md` | What to build: requirements, thresholds and status rules, scope. |
| 3 | `docs/SCREENS.md` | Screen by screen: layout, components, data bindings, states, interactions. |
| 4 | `docs/DESIGN-SYSTEM.md` | Tokens, type, components, chart rules, accessibility. |
| 5 | `docs/ARCHITECTURE.md` | Agent, hub, collectors (what to read from Linux, Docker, Incus, libvirt, Proxmox), retention. |
| 6 | `docs/API.md` | Proposed data model and endpoints, with examples that match `sample-data/`. |
| 7 | `docs/REMOTE-CONSOLE.md` | Console gateway design and security requirements. |
| 8 | `docs/ACCEPTANCE.md` | Checklist to verify the implementation against the design. |

## What is in the box

```
README.md                 this file
AGENTS.md                 instructions for the implementing agent
docs/                     specs (see the table above)
design/
  screenshots/            full-page PNGs of every view and state (1440 px wide; 390 px for mobile-*)
    sections/             the three main pages cut into ~1150 px slices, easier to inspect
  static/                 JS-free HTML snapshots of the same views (open in any browser)
  fonts/                  Geist and Geist Mono (SIL OFL 1.1) used by the static snapshots
  tokens.css, tokens.json design tokens (colors, type, radii, layout)
  source/                 original design files (Main, Server, Proxmox + canvas.json), see "Design source"
sample-data/              fake fixtures that match the mockup exactly
  fleet.json
  server-basalt.json      standard KVM host (Incus + libvirt + Docker)
  server-shale-proxmox.json  Proxmox VE node
  timeseries-basalt-24h.json deterministic 24 h series (CPU, memory, five temperatures)
```

### Screenshots index (`design/screenshots/`)

| File | Shows |
|---|---|
| `fleet-overview.png` | Fleet overview, all servers, 24h. |
| `fleet-overview-lab-7d.png` | Same page with group = Lab and range = 7d (filters re-compute everything). |
| `server-detail.png` | Server detail for `basalt`, Docker tab (default). |
| `server-incus-list.png`, `server-qemu-list.png` | Incus and libvirt guest tables with the Console / Shell button. |
| `server-incus-screens.png` | "Screens" view: a thumbnail wall of the guests. |
| `server-incus-console-vm.png` | Console of an Incus VM (text screen). |
| `server-incus-console-container.png` | Shell of an Incus container. |
| `server-incus-console-stopped.png` | Console of a stopped guest (Start button). |
| `server-qemu-console-windows.png` | Console of a libvirt Windows VM (graphical desktop). |
| `proxmox-host.png` | Proxmox VE node `shale`, QEMU list (default). |
| `proxmox-vm-screens.png`, `proxmox-vm-console.png` | Screens wall and console for a Proxmox VM. |
| `proxmox-lxc-list.png`, `proxmox-lxc-console.png` | LXC containers list and shell. |
| `mobile-*.png` | 390 px wide layouts. |

The 15 desktop views also exist as `.html` in `design/static/` under the same names (the four `mobile-*` views are PNG only: resize a desktop snapshot or your implementation to 390 px to compare). Each static snapshot is the fully rendered DOM (no JavaScript), so it can be opened directly, inspected for exact CSS values, and diffed against your implementation.

## Design source

`design/source/*.dc.html` are the original files from the design tool (a template format with `{{holes}}`, `<sc-for>` and `<sc-if>`, plus a small `DCLogic` class). They cannot be opened without that tool's runtime. Use them to read **exact values and logic** (thresholds, color rules, the sample-data generators), not as code to copy. The static HTML and screenshots are the visual reference.

## What the mockup does not do

The mockup is interactive in places, but only to demonstrate design:

- Range, group, platform tabs, List/Screens, console open/close and the connection-type switch work. Chart hover shows a crosshair and tooltip.
- **Not functional (visual only):** "Add server", "Enroll agent", "Switch server", the filter-by-name inputs, the toolbar actions in the console (they only show a confirmation chip), the Start button, and the connection-type switch (it changes only the status text).
- The console "screens" are drawn scenes (terminal text, a generic desktop), not real framebuffers.
- Light theme and the sidebar pages **Workloads, Storage, Alerts, Agents, Settings** are not designed.

## Known issues in the mockup (do not copy these)

1. Fleet overview, server card for `shale`: the status line "Warning · CPU temperature" wraps onto two lines and pushes the chips down. Implement the header so the status text never wraps and the chips wrap instead.
2. Plural bug: "libvirt on 3 · Proxmox VE on 1 servers". Pluralize each count properly.
3. The fleet server card colors temperature with fixed thresholds (80 / 90 °C) while the sensor table on the detail page uses per-sensor limits. The intended rule is per-sensor limits everywhere; see `docs/PRODUCT-SPEC.md` section 5.
4. Dates and times in the mockup are fixed to 2026-10-11 14:00 UTC and rendered in UTC. Real implementation: render in the viewer's time zone.
5. The hypervisor allocation numbers (vCPU, memory assigned, memory in use) are hard-coded display values, not derived from the guest lists. For `basalt` the running VMs' memory limits add up to 44 GB while the fixture says 52 GB assigned. Use the formulas in `docs/ARCHITECTURE.md` section 3.3, and do not use those fields as a test oracle.
6. The mockup colors the CPU and memory series blue and violet, which are hard to tell apart for some color-blind users. It stays acceptable because they are never drawn on the same axes and always carry a text label; see `docs/DESIGN-SYSTEM.md` section 7.2.

## Decisions that are not made yet

See `AGENTS.md` section 7. The most important: tech stack, authentication model, whether the console is enabled by default (this package recommends **off**, opt-in per server), and the product name.
