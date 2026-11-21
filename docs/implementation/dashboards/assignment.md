# Dashboards — build brief (2026-10-18)

Decisions: `docs/decisions/dashboards.md` (DS-01…DS-19) — read it first, then §1, §2 and your stream's part of §3.
Mockups John approved (open them, they are the layout reference): whombat-app
`docs/design-handoff/dashboards/server.png` (a Proxmox server), `ha.png` (Home Assistant), `hetzner.png`, `unraid.png`,
`anatomy.png` (the slots), source `index.html` there (render: `node ~/.cache/wb-tmp/mockups/shoot-dash.cjs <dir> <ids>`).
Figures in the mocks are made up; names and Home Assistant's facts are John's. The app's tokens, fonts and existing
component sizes win on details; the mock wins on layout, order and words.

Contracts 0.89.0 is done and vendored on both `dash` branches (source `~/Code/.wt/contracts-dash`). Read
`packages/core/src/domain/thing-page.ts` — **the wire shape is the source of truth**: `place`/`span`
(`thingPanelPlace`, `thingPanelSpan`), `ThingSeriesColor`, `ThingPageKpi.spark/meter/color`, the chart panel's
`figure/stats/foot/style/axis/forecast`, series `color/fill`, panel `bars` (`ThingPageBar`), cells
`meter/spark/button`, `ThingPage.range/ranges/refreshS`, `ThingPageQuery` on `things.page`, feature
`things.dashboards`. Also `docs/decisions/contracts.md` CT-394…CT-398 there.

## 1. Rules for every stream

- Work only in your worktree on your branch; commit small and often (`server: …`, `client: …`, `web: …`, `mobile: …`),
  every message ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never push, never merge into
  `main` or `dash`, never touch the main checkouts (`~/Code/Whombat`, `~/Code/whombat-app`, `~/Code/whombat-contracts`)
  or other sessions' worktrees (`~/Code/.wt/test-speed*` belong to another session). The lead merges.
- **DEV fast** (John's rule): one quick check at the end — `TMPDIR=~/.cache/wb-tmp pnpm check` in your repo, plus
  `pnpm test:server` once (stream S). No VM tests, no repeated full suites, no CI waits. Run single test files while you
  work. Own ports (S: `PORT=4481`, W: `PORT=4482 WEB_PORT=5197`) and throwaway databases; never stop or reset shared
  containers (`docker compose` is shared — never `down -v`). `/tmp` runs out of inodes: `TMPDIR=~/.cache/wb-tmp`.
- **Never call John's real services** (Home Assistant, UniFi, Hetzner, Proxmox, his servers) or his DEV box from tests
  or scripts. Fakes and recorded JSON only. The lead checks the real ones after the merge.
- **Copy**: plain, short English a non-developer understands, curly quotes (’ “ ”), `·`, `−`, `…`; a space before units
  (“5 %”, “30 GB”, “21.4 °C”, “84 Mb/s”); DS-15 for averages, peaks, times and forecasts. No ids, paths or stack traces
  in visible words.
- **Tokens only** (CSS variables / native theme) for UI colours; match the surrounding code's style and comment density.
- Contract change needed? Don't edit vendored tarballs: message the lead (SendMessage `main`) with the exact additive
  change; prefer solving it on your side.
- Record your own decisions in your stream's file (S: Whombat `docs/decisions/dashboards-server.md`, DS-S01…; K:
  whombat-app `docs/decisions/dashboards-client.md`, AP-2000…AP-2049; W: `dashboards-web.md`, AP-2050…AP-2119; M:
  `dashboards-mobile.md`, AP-2120…AP-2199).
- When done: the quick check green, everything committed, a short report (what you built, what you decided, what is left,
  anything the lead must check live).

## 2. The Summary, end to end

**Layout (DS-01, DS-04).** Panels in order; on a wide screen: every `top` panel (whole width), then `chart` panels in a
grid of three columns (`span` 1–3; a panel that doesn't fit the row starts the next), then a two-column grid
`minmax(0,1.85fr) minmax(0,1fr)` with `align-items: start` where the `main` panels stack on the left and the `side`
panels on the right (each column's own order), then `bottom` panels. Under ~1000 px content width the two columns
become one (main, then side); chart rows become two then one column. Phones: everything stacked in the given order.
Panels without `place` use `thingPanelPlace(panel, afterChart)` from `@whombat/core`. Gap 18 px between cards.

**Figures** (`kpis`): one card, 3–6 cells divided by lines, each: label (label face), value (+ `rest` small), `sub`,
then a 30 px small line (`spark`, wash under it) or a 5 px meter (`meter`); `tone` warn/bad colours the value and the
line. **Chart card** (`chart`): title; `figure` big (26 px) with `rest`; `stats` right-aligned small lines; the plot
(~150 px tall in a third, ~140 px in span 2/3; grid lines at 3 ticks with the `axis.unit`; x labels from the
timestamps, fewer when narrow — reuse `fitTimeTicks`); `line` dashed in the warning colour with its label;
`forecast` a dashed line from the last value to (`at`, `value`) with its label, extending the x domain to `at`;
`style: 'bars'` stacks series per timestamp; hover crosshair with a tooltip of every series' value; legend under the
title when there are 2+ series (colour, label, `latest`); `foot` as a 2–4 column grid of small label + value under a
line. **Notices**: first five, “Show N more” toggles the rest. **Bars**: label (mono when asked) + note, value right, a
6 px bar (tone colours it), `sub` under it; `columns` side by side on wide screens. **Table**: as today plus `meter`
(54 px bar + text), `spark` (a 24 px small line, ~150 px wide), `button` (small outline button).

**Colours** (`ThingSeriesColor` → tokens): blue `chart1`, orange `chart2`, green `chart3`, violet `chart4` (new, DS-18),
amber the warning colour, red the serious colour, grey the muted ink. Series without `color`: blue, orange, green,
violet in order.

**Range (DS-03, DS-16).** `?range=` in the address (default `24h`); the picker is a segmented control at the right end
of the tab row, Summary tab only, options from `ThingPage.ranges` (connections) or `SERVER_DASHBOARD_RANGES` (servers),
with “Live · every 10 s” before it for servers. Changing it reads the page again; the previous page stays visible while
the new one loads.

**Head.** One `PageHead` for servers and connections: crumb, icon box (servers too), name (servers in the mono face),
the status badge, chips (kind/version, control level), actions on the right (Ask, then the kind's: Console/Shell + Power
for servers, Restart/Open for connections), the fact line under it (`Runs in CT 131 on pve-02`, address pill, “Agent
synced 6 s ago” / “Checked 2 min ago”).

## 3. Streams

### S — server (Whombat, branch `dash-server` from `dash`, worktree `~/Code/.wt/whombat-dash-server`)

Read first: `apps/server/src/things/page.ts` (`connectionPage`, `MACHINE_KINDS`, order of panels), `panels.ts`
(`genericKpis`, `pairWidths`, response chart), `points.ts` (24 h, the time grid), `runs-on.ts` (`readMachine`: guest or
server metrics through the hosts service), `kinds/homeassistant.ts` (`haKpis`, `haChart`, the WebSocket reads,
`ha-socket.ts`), `kinds/unifi.ts`, `kinds/hetzner.ts`, `devices.ts`, `words.ts`, `routes.ts`,
`apps/server/src/home/health.ts` (the 5-minute pass, glances, where points are written), the jobs file that prunes
points, `managed/runtime-features.ts`, and the tests beside them (`panels.test.ts`, `homeassistant.test.ts`,
`unifi-hetzner.test.ts`, `things.int.test.ts`).

Build:
1. **Range** (DS-03): `things.page` reads `ThingPageQuery`; every chart and `spark` covers the range; the 30 s cache is
   per connection **and range**. `ranges`: `['1h','6h','24h','7d','30d']`; `range` echoed; `refreshS` 60. Machine
   series come from the hosts service for the same range (it has 1 h…90 d; keep ≤ 120 points). Points (DS-11) are put
   on a grid of the range's step (1 h: 5 min, 6 h: 5 min, 24 h: 15 min, 7 d: 2 h, 30 d: 6 h — same as the hosts
   service where it can) with null gaps.
2. **Points 30 days** (DS-11): keep 5-minute points 48 h, roll older ones into hourly averages (one row per key per hour,
   `at` on the hour), delete after 30 days; hourly job. Migration **0111** only if you need one (an index, a column);
   tell the lead the number if you take it. New series written by the health pass: Home Assistant `log_err`,
   `log_err_top` (+ the source's name on the glance), `db_mb`, `disk_pct`, `disk_gb` (from the machine, CP-08); UniFi
   `gw_cpu`, `gw_mem`, `clients`. Counters that reset (a restart) are handled when turning them into per-hour bars
   (negative deltas start again from the new count).
3. **Helpers** (`things/series.ts`, unit-tested): average and peak with time over a series (DS-15 words: “Avg
   **14.2 %**”, “Peak **63 %** Sun 03:10” in the caller's time zone — the person's zone is how `words.ts` formats
   today), the forecast (least squares over up to 30 days of points, ≥ 2 days of history, only when growing and the
   limit is reached within a year; `forecast.at`, “full ~18 Dec”; `sub`/stats words “Full in about 2 months”), the
   step grid, spark downsampling to ≤ 60 points.
4. **Panels with places** (DS-04): every panel the server builds gets `place` (and `span` for charts), and keeps a
   sensible `width` for 0.88 clients. Replace `pairWidths`. Tabs: the first tab's label is **“Summary”** (key stays
   `overview`).
5. **Machine for every connection** (DS-10): `MACHINE_KINDS` goes; any connection with a `runsOn` gets machine
   figures (CPU with spark, Memory with spark, Disk with meter + forecast words) and chart cards CPU (blue, fill,
   foot: the guest's own processes if known, else nothing) and Memory (violet, fill) before its kind's own charts.
6. **Home Assistant** (DS-10, `ha.png`): figures CPU · Memory · Disk · Database (`db_mb` spark, “+ 110 MB a day” from
   the trend) · Integrations (meter, “2 not loading”); charts row 1: CPU, Memory, Disk space (amber when ≥ 75 %, axis
   from 50 % or lower, forecast, foot: old backups size when known, database, “Full about …”); row 2: Errors in the log
   (`style: 'bars'`, per hour for ranges ≥ 24 h, per step below; the noisiest source orange, everything else grey;
   span 2; stats “Since the restart on Thu 07:12”, “**12,286** errors · about **510** an hour”), Database (green,
   fill); main: Integrations not loading (a list or table; “Reload” is not built — link `ask` instead), Backups; side:
   Worth a look; bottom: Show more here (widgets) and Whombat did here/What Whombat may do as today but placed `main`
   below the kind's (less is more: leave out empty ones).
7. **Hetzner** (DS-12, `hetzner.png`): read **`GET /v1/servers/{id}/metrics?type=cpu,disk,network&start=…&end=…&step=…`**
   (Hetzner Cloud API; check its documented units — CPU is a percentage that can pass 100 with several vCPUs: show it as
   a share of all vCPUs; network bandwidth bytes/s → Mb/s; disk bandwidth bytes/s → MB/s) through the connection's
   existing signed fetch, cached 60 s per server and range, at most 6 servers (running ones first); traffic from the
   server object (`outgoing_traffic`, `included_traffic`); cost as today. Servers table columns: Server (dot + name
   mono, note OS · location), Type (`CX32` + note cores · memory · disk), CPU (meter + text), 24 h (spark), Address
   (mono), and a button column: “Open” to the Whombat server when one has the server's public IPv4/IPv6 as its address
   (hosts fleet), else none. A `text` note (side or under the table, `main`) when any server has no Whombat agent:
   “Hetzner can’t see memory or disk space. Add <name> as a server to see them here.” with an `href` link “Add as a
   server” to `/things/servers?add=1`. Worth a look adds “Traffic is at 83 % of what’s included” (≥ 80 %).
8. **UniFi** (DS-13) and **generic/devices** (DS-14) on the same pattern; device readings: up to three numeric ones as
   chart cards (span 1 each), a table of all readings (main).
9. **Feature**: add `things.dashboards` to the implemented runtime features when the route answers ranges.
10. Tests: unit tests for the helpers and every builder's places/words (fakes for Hetzner metrics JSON, Home Assistant
    socket messages, points), the points roll-up job, one int test for `things.page?range=7d`. Then `pnpm check` and
    `pnpm test:server` once.

### K — client model (whombat-app, branch `dash-client` from `dash`, worktree `~/Code/.wt/app-dash-client`; owns `packages/client` and `packages/tokens`)

Read first: `packages/client/src/hosts/model.ts` (`serverKpis`, `temperatureChart`, `serverHeader`, the busiest guests),
`unraid.ts` + `unraid-mobile.ts`, `libvirt.ts` + `libvirt-mobile.ts`, `incus.ts` + `incus-mobile.ts`,
`guest-mobile.ts`, `format.ts`, `react.ts` (`useHostServer`, `useHostServerMetrics`), the fixtures (`fixtures*.ts`),
and the web summaries you replace: `apps/web/src/features/things/tabs/SummaryTab.tsx`, `HintsCard.tsx`,
`unraid/UnraidSummary.tsx`, `libvirt/LibvirtSummary.tsx`, `incus/IncusServerTabs.tsx` (its summary), and the phone's
`apps/mobile/src/screens/ServerScreen.tsx` — **everything they show must be in your panels or reachable by a link**
(DS-09).

Build (`packages/client/src/hosts/dashboard.ts` + tests, exported from `@whombat/client/hosts`):
1. `SERVER_DASHBOARD_RANGES` (all six), `serverDashboardSeries(detail): string[]` (the series to ask
   `hosts.serverMetrics` for: `cpu_pct`, `mem_pct`, `load1`, `swap_pct`, `net_rx_mbps`, `net_tx_mbps`,
   `disk_read_mbs`, `disk_write_mbs`, the shown sensors' `temp_*_c`, up to 8 `vol_pct:*` for storages/pools).
2. `serverDashboard({ detail, series, guests?, range, timeZone, now? }): ThingPagePanel[]` — DS-09 for every server
   kind (plain Linux, Proxmox, Unraid, Incus, QEMU/KVM, Docker-only), with `place`/`span`, words per DS-15, tones as the
   old Summary had them (limits from the sensors, alerts and hints). Links: `{kind:'tab'}` to the server's tabs
   (`guests`, `storage`, `sensors`, `backups`, Unraid's `array`, `docker`, `vms`…), `{kind:'ask'}` for “Look into it”,
   `href` for a guest (`?guest=`) and its console (`?console=guest:<id>` — check what the web uses today). Also a
   `serverDashboardHead(detail)` if the head needs more than `serverHeader` gives (chips: platform/version, control
   level).
3. Pure helpers shared with the screens: `seriesStats(values, timestamps, tz)` (avg, peak, peak time words),
   `volumeForecast` (from `vol_pct:*`, DS-08 words), `rangeTicks` if `fitTimeTicks` doesn't fit, `placePanels(panels)`
   → `{ top, chart: rows[], main, side, bottom }` using `thingPanelPlace`/`thingPanelSpan` (both clients use it).
4. React: `useServerDashboard({ burrow, serverId, range })` combining `useHostServer`, `useHostServerMetrics` (the
   range and series; refetch 60 s) and the guests it needs; live events already invalidate the hosts queries.
5. Tokens: `chart4` (violet) in `chartColors` light and dark (CSS variable and native theme), checked against both
   themes' backgrounds; mind the feedback widget's gzip budget (chartColors stays out of `ThemeColors`).
6. Fixtures: `dashboardFixtures` for John's world (pve-02 Proxmox with guests incl. home-assistant CT 131, blackbox
   Unraid with array/pools/containers/pbs VM, the-titan Incus, a QEMU/KVM host, a plain Linux host without sensors) with
   series for 24 h and 7 d, usable by the web and phone fixture servers.
7. Tests for every kind's panels (places, words, tones, links), the helpers and `placePanels`. `pnpm check` once.
   **Merge-early:** commit the API skeleton (types, function signatures, `placePanels`, `chart4`) first and report it to
   the lead (SendMessage `main`) so W and M can merge it while you fill the builders in.

### W — web (whombat-app, branch `dash-web` from `dash`, worktree `~/Code/.wt/app-dash-web`; `apps/web` only)

Read first: `apps/web/src/features/things/page/*` (`ThingPageScreen`, `Panels`, `PanelChart`, `ThingPage.module.css`),
`ServerPage.tsx`, `ThingScreen.tsx`, `tabs/SummaryTab.tsx`, `tabs/HintsCard.tsx`, `unraid/*`, `libvirt/*`, `incus/*`,
`Things.module.css`, `parts.tsx`, `AskPane.tsx`, `components/charts/*` (`TimeChart`, `AreaSparkline`, `charts.tsx`,
`fitTimeTicks`), `app/runtime` (`useFeature`), the fixtures (`app/*Fixtures.ts`, `fixtureFetch.ts`) and the visual
harness (`pnpm visual`, `tools/visual/README.md`).

Build:
1. `features/things/dashboard/` — the renderer: `Dashboard` (layout §2 via K's `placePanels`, container-query
   responsive), one component per panel kind (reuse and upgrade the existing ones: `kpis` with spark/meter, the chart
   card on **one chart engine** — `TimeChart` grown to area/lines/bars/limit/forecast/axis/hover — retire
   `PanelChart`'s `LineChart` use), `bars`, table cells with meter/spark/button, notices folding at five), `RangePicker`,
   `PageHead`. Link handling as today (ask → Ask pane with the question, tab, href, url).
2. **Connections**: `ThingPageScreen` on the renderer and `PageHead`; `?range=` → `things.page` query; old runtimes
   (no `things.dashboards`): no picker, layout from `width`.
3. **Servers**: the Summary tab of every server kind renders `serverDashboard` (K) with `PageHead` and the range
   picker; delete `SummaryTab`, `HintsCard` (if unused), `UnraidSummary`, `LibvirtSummary`, the Incus summary and
   anything only they used (DS-17); keep the other tabs as they are. Until K's builders land, render K's fixtures.
4. Visual check against the mockups at 1440×900 (and 1200 px, 900 px widths) in both themes for: pve-02, blackbox,
   Home Assistant, Hetzner, a generic connection, a device — fixtures from K (servers) and your `things.page` fixtures
   (connections: update the existing ones to the 0.89 shape with places, sparks, chart cards, forecast, bars).
   Fix differences; screenshots in your report's folder `~/.cache/wb-tmp/dash-web/`.
5. Tests for the renderer's pure parts and the screens' wiring; `pnpm check` once.

### M — phone (whombat-app, branch `dash-mobile` from `dash`, worktree `~/Code/.wt/app-dash-mobile`; `apps/mobile` only)

Read first: `apps/mobile/src/screens/ThingPageScreen.tsx`, `ServerScreen.tsx`, `ThingScreen.tsx`,
`apps/mobile/src/managed/HostCharts.tsx` (`Sparkline`, `Meter`, `LineChart`, `ColumnChart`), `apps/mobile/src/ui/*`.

Build: one stacked renderer for `ThingPagePanel`s (figures two per row with spark/meter; chart cards full width with
figure, stats, the chart on `LineChart`/`ColumnChart` grown to fill/limit/forecast/bars, foot as a 2×2 grid; bars;
tables as rows with meter/spark; notices folding at five; text, list, facts, access, changes, widgets as today), a range
segmented control at the top of the Summary (connections: `ranges`; servers: 1 h…30 d, 90 d left out on phones),
`ThingPageScreen` and the server Summary (K's `serverDashboard` + `useServerDashboard`) on it; delete the phone's own
server dashboard parts that this replaces (keep the server's other sections/tabs). 44 px touch targets, labels for dots
and small lines, pull to refresh. Unit tests for the mapping; `pnpm check` once (no emulator required; one emulator
screenshot welcome).
