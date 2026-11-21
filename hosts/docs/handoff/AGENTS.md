# AGENTS.md: instructions for the implementing agent

You are building a **multi-server monitoring dashboard with an agent per host and a remote console for VMs and containers**. This package is your brief. Read `README.md` first, then this file, then the docs in the order listed there.

## 1. Source of truth

When sources disagree, use this order:

1. **Behavior and rules**: `docs/PRODUCT-SPEC.md` (requirements, thresholds), `docs/SCREENS.md`, `docs/REMOTE-CONSOLE.md`.
2. **Visuals**: `design/screenshots/` and `design/static/*.html` (pixel reference), `design/tokens.css` (values).
3. **Data shapes**: `sample-data/*.json` and `docs/API.md`.
4. **Design source** (`design/source/`): only to look up an exact value or formula.

The mockup contains known flaws (README, "Known issues"). The spec wins over the mockup where they differ.

## 2. Goal and scope

Build the three pages (Fleet overview, Server detail, Proxmox host) and the console, backed by a real agent, hub and API. Everything in `docs/PRODUCT-SPEC.md` section 4 is in scope. Section 3 lists what is out of scope. **Do not add features that are not in the spec** without asking.

## 3. Hard rules

- **Dark theme only.** Use the tokens in `design/tokens.css` by name. No new colors.
- **Never convey state by color alone.** Status dots always sit next to text (Online, Warning, Offline, Running, Stopped) or inside a labeled row. Keep that.
- **Charts:** one y-axis per chart (no dual axes), thin 2 px lines, solid hairline grid, crosshair + tooltip on hover, direct end labels where the mockup has them. Series colors are fixed per entity (CPU blue, memory violet, ...). Status colors are never used as series colors.
- **Every chart has a text equivalent** (a table view or the visible numbers beside it). Do not ship a chart whose values exist only in the SVG.
- **Responsive:** the layout must work from 390 px to 1440 px and above with no horizontal page scroll. Tables may scroll horizontally inside their card.
- **Accessibility:** WCAG 2.2 AA. Keyboard reachable controls, visible focus (`--focus`, 2 px, 2 px offset), `aria-pressed` on segmented controls, labels on icon buttons, no text below 12 px, touch targets at least 36 px.
- **Time:** store UTC, display in the viewer's time zone. Range labels follow `docs/SCREENS.md` (axis tick format per range).
- **Security (console):** follow `docs/REMOTE-CONSOLE.md` exactly. Console and power actions are separate permissions, **off by default**, audited, and use short-lived single-use session tokens. Never expose hypervisor credentials, VNC passwords or Proxmox tickets to the browser beyond what the protocol needs, and never log them.
- **No real data in fixtures or tests.** The hostnames, IPs and logs in this package are fake. Keep it that way.

## 4. Suggested stack (adjustable, not mandated)

These are defaults that fit the design. Change them if the project already has conventions; record the change in your own notes.

| Part | Default | Reason |
|---|---|---|
| Agent | Rust, single static binary, systemd unit; NixOS module and a Debian/Ubuntu package | Low overhead, one file to deploy on every host, good fit for `/proc`, `/sys` and Unix-socket APIs |
| Hub | Rust (axum) or TypeScript (Node); PostgreSQL or SQLite for inventory; a time-series store or rollup tables for metrics | Needs WebSocket proxying for the console and a streaming ingest |
| Web UI | React + TypeScript, plain CSS variables from `tokens.css` (or any system that maps to them) | The mockup is component-shaped and token-driven |
| Console clients | noVNC (VNC), spice-html5 (SPICE), xterm.js (shells and serial) | Standard browser clients for these protocols |
| Charts | Hand-rolled SVG or a small library that can match the mockup (thin lines, crosshair, direct labels) | Heavy chart libraries tend to fight the look |

## 5. Build order and milestones

Build in vertical slices. After each milestone, run the checks in `docs/ACCEPTANCE.md` for what exists so far.

| # | Milestone | Done when |
|---|---|---|
| M0 | **Skeleton**: repo layout, tokens, app shell (sidebar, header, range and group controls), fixtures served from `sample-data/` | The shell matches `fleet-overview.png` at 1440 and 390 px with fixture data |
| M1 | **Fleet overview on fixtures**: KPIs, heatmap, alerts, server cards, workloads, hypervisors, all filter/range logic | Matches the screenshots; the KPI formulas (`docs/SCREENS.md` 2.2) and status thresholds (`docs/PRODUCT-SPEC.md` section 5) hold; Lab + 7d state matches `fleet-overview-lab-7d.png` |
| M2 | **Agent v1 + hub ingest**: enroll, heartbeat every 10 s, CPU/memory/load/temps/disks/SMART, inventory, offline detection | A real Linux host shows live CPU, memory, temperature and per-disk wear in the Server detail |
| M3 | **Time series + retention**: rollups, `GET .../metrics`, range switching with correct resolution, peak preserved | 1h to 30d charts render from real data; "Peak" equals the true max of the range |
| M4 | **Server detail complete** (standard host) | Matches `server-detail.png` including the storage and virtualization sections |
| M5 | **Guests: Docker, Incus, libvirt** collectors and tables | Tables match `server-incus-list.png` and `server-qemu-list.png`; counts roll up to the fleet page |
| M6 | **Proxmox VE** collector (cluster, storages, backups, guests) and page | Matches `proxmox-host.png`; works against a real PVE API with a read-only token |
| M7 | **Remote console** (VNC, SPICE, serial, shell), Screens wall, power actions, audit log | All console states in the screenshots work end to end against real guests; security checklist in `docs/REMOTE-CONSOLE.md` passes |
| M8 | **Alerts** with the default rules in the spec; notification delivery is out of scope unless asked | "Needs attention" is driven by real rules |

## 6. How to work

- **Use the fixtures as contract tests.** The API responses should be able to produce exactly the numbers in `sample-data/`. If you must change a shape, update the fixture and `docs/API.md` together.
- **Visual regression:** render each page with fixture data at 1440 px and 390 px and compare against `design/screenshots/`. Small anti-aliasing differences are fine; layout shifts are not.
- **Compare against the static snapshots** (`design/static/`) when you need an exact padding, font size or color: they are the resolved DOM and CSS.
- **Verify, do not assume.** The collector sections in `docs/ARCHITECTURE.md` name the APIs and files to read, written from general knowledge of Linux, Docker, Incus, libvirt and Proxmox VE. Check each against the version you target (especially the Incus console and exec endpoints and Proxmox's console authentication) before relying on it.
- Keep agent privileges minimal and read-only by default; the console and power actions are a separate, explicit capability.
- When something is ambiguous, prefer the simpler behavior and write down the question for the human instead of inventing a feature.

## 7. Decisions needed from the human

Make the stated default if you cannot ask, and flag it in your summary.

| Decision | Default if unanswered |
|---|---|
| Product name (placeholder "Fleet") | Keep "Fleet", one constant to change |
| Tech stack | Section 4 |
| Authentication for the web UI | Local accounts with passkeys or OIDC; roles: viewer, operator, admin (console + power need operator) |
| Agent to hub transport | Agent opens an outbound mTLS WebSocket (works behind NAT); see `docs/ARCHITECTURE.md` |
| Console and power actions | Disabled until an admin enables "Remote control" on a server |
| Multi-tenancy | Single tenant |
| Retention | 10 s raw for 24 h, 1 min for 7 d, 15 min for 90 d (average and maximum kept) |
| Heartbeat loss before "Agent unreachable" | 60 s (6 missed heartbeats) |
| Rated TBW source for "936 of 1,200 TBW written" | Model lookup table with manual override; if unknown, show wear percent only |
| Languages | English strings in a catalog so Dutch can be added |

## 8. Definition of done (per milestone and overall)

- Matches the screenshots at 1440 and 390 px.
- Fixtures validate against the API types; no `any` or untyped JSON at the boundaries.
- Thresholds in `docs/PRODUCT-SPEC.md` section 5 are covered by unit tests.
- Accessibility checks in `docs/ACCEPTANCE.md` pass (keyboard, focus, labels, contrast).
- For M2 and later: runs against a real host; for M7: the security checklist passes and an audit record exists for every console session and power action.
- Short `NOTES.md` listing deviations from this package, open questions and anything you could not verify.
