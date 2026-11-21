# The Dashboard becomes Connections (AP-2501…AP-2599)

Whombat `docs/decisions/connections-page.md` CN-01…CN-10 (John, 2026-10-19: “I agree fully, implement this”).
Contracts 0.94.0 (CT-449 `ThingPageKpi.charts`/`link`, CT-450 `CONNECTIONS_HREF`, CT-451 words). The mockup is
`docs/design-handoff/connections/index.html` (frames `#conn-web`, `#conn-phone`, `#server-web`, `#server-open`,
`#guests-web`; PNGs beside it); its figures and guest names are illustrative. Ranges: AP-2501…AP-2519 this file's
shared decisions, AP-2520…AP-2549 the web, AP-2550…AP-2579 the phone.

## AP-2501 Connections, at `/connections`

The Dashboard's page is **Connections** (`CONNECTIONS_HREF`): the web sidebar's entry (a plug icon), its title, the
phone's tab. `/dashboard` (`DASHBOARD_HREF`) goes to `/connections`, keeping the query. The Chat shell's place is
still `dashboard` in code; only the words and the path change. The status sentence (`homeStatusLine`) stays under the
title; the greeting (`homeGreeting`) is gone from the page.

## AP-2502 Servers and Services

The group AP-2500 called Connections is **Services** (“2 working · 2 need a look · 1 learning”), the web sidebar's
section SERVICES with “Add a connection” on its `+`. Servers keep their name. Code names (`things`, `HomeThingsCard`)
may stay.

## AP-2503 One card for servers and services

Both groups draw the same card (mock `.ccard`): logo or mark, name (servers mono), one grey line, the status word
right only when not fine (Needs a look, Learning, Offline, “1 to look at”), else a green dot with a label for screen
readers; two or three figures (label in the label face, value, small unit; a small line or a bar under it); a foot line
split left and right. The card is one link to the page (a real `<a>`), with a visible focus ring. Three columns on a
wide page, two under ~900 px, one on a phone-width web page.

## AP-2510 A figure opens its charts (shared)

`figureCharts(panels)` (`@whombat/client`, beside `placePanels`) gives each figure that names charts (CT-449) those of
the page's chart panels, once each, and the panels left to lay out. The server Summary's builder
(`serverDashboard`) names them: CPU → `cpu`, Memory → `memory`, Hottest → `temperatures`, Network → `network` and
`disk_io`, Unraid's Array → `disk_temperatures`; a figure without one leads to its tab (Guests, Storage, Array; Cache
→ Array). Every fixture's charts all sit behind a figure.

## Web

- **AP-2520 Sidebar.** Connections (a plug) at `/connections`, `/` before the Chat shell; it stays selected on every
  guest of every server. SERVERS is a plain heading now (no list page); its `+` opens Add a server on Connections.
  The section after it is SERVICES, its `+` still “Add a connection”.
- **AP-2521 Addresses.** `/connections` is the Chat shell's (without it: `/`, the query kept). `/dashboard` →
  `/connections`, query and anchor kept. `/things/servers` without `?view=guests` → `/connections` with its query (the
  router's `beforeLoad`, and `ThingScreen` the same way); in the crew shell that ends at its first channel.
- **AP-2522 Needs you, one line.** The title (an inline `h3`) in bold, “ · ” and the detail in grey, ellipsised; the
  buttons on the right: the item's first choice solid, the others framed, Ignore quiet. Under 760 px of card the detail
  wraps and the buttons go under it. When it came is the row's tooltip, not drawn (the mock has none).
- **AP-2523 Add a server on Connections.** `?add=1|server` with its sign-in fields opens the dialog there; closing
  removes them. `addServerHref` builds `/connections?add=1…`, the parser reads that and the old address. Servers waiting
  to be added are a dashed card at the end of Servers with Review (owners). The old list's alert notices are left to
  Needs you and each card's status word. Every guest (`?view=guests`) is a page titled “All guests” with the crumb
  Connections; removing a server lands on Connections.
- **AP-2524 A server's card** from the hosts fleet, problems first: CPU with its 24-hour line, Memory `used / total GB`
  with a bar (violet, amber from 90 %), Hottest; the foot “19 of 22 guests running” (“containers” on a server that only
  runs Docker, “No guests”) and “Up 55 d”. Its accessible name says the name, the status and the figures.
- **AP-2525 Hottest as a bar.** The fleet has no temperature history, so Hottest draws the hottest sensor toward its
  limit (100 °C when unknown) in its tone instead of the mock's small line.
- **AP-2526 A service's card.** A figure's first word is the value, the rest and its note are small (“169 of 171”,
  “84 / 12 Mbit/s”); without figures “Connected”; a device being learned says “Dusty is learning what it can do. You’ll
  get a page for it soon.” The foot says when it was last used (“Used today”), only once it was; its left stays empty
  (the summary doesn't say who looks after it).
- **AP-2527 Words.** `CHAT_WORDS.dashboard` is Connections (the phone's too), “Connections couldn’t load. Try again.”,
  “Unpin from Connections”, and the runtime feature words say “the Connections page”.
- **AP-2528 Add a connection** is a router link on the title's right, for people: the catalog's Add page where it is,
  else Settings → Connections. The status sentence's strong part is amber, as the mock's.
- **AP-2530 A figure opens its charts** in the figures' card: `?chart=<figure key>` (replace) keeps which, one at a
  time; an unknown key opens nothing; Close and Escape remove it and give focus back to the figure.
- **AP-2531 One chart engine.** `ChartCard` is split into `ChartLegend`, `ChartPlot` and `ChartFoot`, which the open
  charts reuse.
- **AP-2532 The range picker** stays in the tab row while any chart card is left or no figure opens a chart; else it is
  beside the open chart. “Live · every 10 s” stays at the tab row's end on its own.
- **AP-2533 Figures as the new mock:** the value mono 25 px, a short unit after a number small (“10 %”, “75 °C”); each
  figure is named “CPU 10 %” with its line as the description.
- **AP-2534** The open figure has the `sf2` background and a 2 px line in its own colour.
- **AP-2535** One chart: the picker and × in its head row. Two or three (Network + Disk I/O): in a row above them, so
  each keeps its span's width; a narrow card stacks them.
- **AP-2536** A figure with a link opens its tab, an in-app page or an outside one, with a right chevron.
- **AP-2540 Guests' order:** running first by name A–Z (case ignored), stopped last by name; paused and unhealthy sort
  with the running.
- **AP-2541** A column head sorts by it, again reverses. Guest starts A–Z, CPU, Memory and Up biggest first; a guest
  without the figure goes after those with it. The sort is the tab's own state, not the address.
- **AP-2542** Memory sorts by what is used, not by the share of the limit.
- **AP-2543 The line under the name:** “VM 5911” / “CT 129” on Proxmox, “VM” / “CT” on Incus and libvirt (with an Incus
  project that isn't default), “Docker”; “ · Stopped” or “ · Paused” after it. A waiting change replaces it in amber,
  first letter capitalised.
- **AP-2544** The kind's icon: a screen for a VM, a box for a container, Docker's mark; the kind's words are its label.
- **AP-2545 Memory** reads “8.1 of 8 GB”, “195 MB of 1 GB”, “41 of 512 MB”, amber from 90 % of the limit; without a
  limit only the amount, no bar.
- **AP-2546** The CPU bar is the real share with a 3 % least, so an idle guest's stays visible.
- **AP-2547 Tick boxes** show on a row's hover or focus, or once any is ticked; the head's box always shows (the mock's).
- **AP-2548** A stopped guest that may be powered has Start where the console was; it starts straight away, as the ⋯
  menu's Start does.
- **AP-2549** As the card narrows: Up goes under 760 px, Memory and the “Sorted by” words under 560 px, the bars under
  420 px. The name never truncates; it wraps.

## Phone

CN-07 on Android (mock `#conn-phone`; `server-open.png` stacked for an opened figure). Code names stay (AP-2501): the
tab is the `Dashboard` route, the screen `HomeScreen`; `Connections` is already Settings' list of connections (CX-74).

| | Decision | Why |
|---|---|---|
| AP-2550 | **Superseded in part by needs-you-list.md NYL-04, NYL-05**: Needs you is a tab of its own with the count. **Chat · Connections · Watch.** With `chat.channel` the bar is Chat, Connections, Watch; without it Connections, Chats, Watch (`shellTabs`, `TAB_WORDS`). Connections has a plug and the Needs-you count (the app icon follows it). The `Things` tab is gone; the bar is the mock's `.ptabs`: on `bg`, 24dp icons over 12/500 labels, 600 on the open tab. | CN-07: the Dashboard and Things listed the same servers and connections. |
| AP-2551 | **Its addresses.** `whombat://connections`, with `dashboard`, `home` and `things` as old names (and `inbox`, `agents` in the assistant shell). `/connections`, `/dashboard`, `/home`, `/things`, `/things/servers` (also `?view=guests`) open it; `/things/servers?add=1` is still Add a server; `openHref`'s fallback is Connections. A saved Things tab opens Connections (`TAB_MIGRATION`). `burrowOfPath('/connections')` reads a burrow until the shared `BURROW_ROUTES` lists `/connections` (the web's route); the link still lands on Connections. | CN-01, CN-09: old links in messages keep working. |
| AP-2552 | **Words.** Every visible “Dashboard” and “Things” is Connections (`CONNECTIONS_TITLE`): “‹ Connections” on a server, a connection, Everything I did, a chat started from Needs you; “Connections didn’t load.”; “That isn’t one of your connections.” | CN-01. |
| AP-2553 | **The screen.** The title (32/700) with the viewer's avatar on the right — Settings has no other door in this shell, so it stays though the mock leaves it out — and the shared `homeStatusLine` under it, what needs the person in `warn` 600 (the mock's `<b>`); no greeting, no burrow row. Then `homeSections` in order, each a mono label over its card (`.plabel`): **Needs you · 3**, **Servers**, **Services**, **Pinned**. Pull to refresh reads the page and the servers' status again; live as before. Nothing at all: “Nothing here yet. Ask Dusty to add…”. | CN-03, AP-2501. |
| AP-2554 | **Superseded by docs/decisions/overview-one-page.md OVP-09, OVP-11 (a connection is a compact tile on Overview).** **Services rows** (`phoneServiceRows`): every connection and device (the mock's heat pump is among them, as on the web), its logo, the name (16/600), one grey line — what isn't fine in its tone, then two figures as phrases (“169 of 171 integrations · 38 errors today”) or its own line, then when it was used —, its dot and a chevron. Learning is amber, as the mock. `+` on the label adds a connection; with none, the card's one row. | CN-02, CN-04 at phone width. |
| AP-2555 | **Servers rows** (`phoneServerRows`): its logo, the name in mono, the status word in its tone only when it isn't fine, “19 of 22 running” (or “No guests”), and 42 × 4dp CPU (`chart1`, at least a sliver) and MEM (`chart4`) bars; its dot and a chevron. One TalkBack label says the status (or “running fine”), guests, CPU and memory. Owners add a server from the label's `+` (the web sidebar's); with none yet it is the card's one row. “All” is gone: the page lists them all. | CN-04, CN-09. |
| AP-2556 | **Superseded by needs-you-list.md NYL-01**: the rows are the Needs you tab's. **Needs you rows**: the web's glyph (alert, power, star, question, plug, server) on a 28dp tile tinted in its tone (a question in `chart1`), the title up to two lines, the grey detail up to two, a chevron; the row opens its sheet, or goes where its only button goes. | CN-03; the sheet keeps the buttons. |
| AP-2557 | **Pinned** at the bottom under its label, one card per panel as before. | CN-03. |
| AP-2558 | **A figure opens its charts** (`SummaryPanels`, `summaryLayout`, `figurePress`): the figures sit in one card, two by two between hairlines (they were separate tiles), so the charts open inside it. A figure that names charts is a button (`expanded`, a chevron by its label); open, it is on `sf2` with a 2dp bar in its colour, and right under its row of two come the chart's title (17/700) with a 30dp close button, the range control and its charts without their cards (a heading the chart repeats is left out). One at a time; it stays open across a range change. The phone keeps which figure in the screen, not in an address. | CN-05, AP-2510. Under its own row, not under all five: on a phone the last row (Storage) would push the charts out of sight. |
| AP-2559 | **A figure without charts leads to its tab** where the phone has it (Guests, Array, Cache → Array); one whose tab the phone lacks (Storage) stays a plain figure. In an opened figure the first chart drops its figure now (the tile says it); a second chart (Network's Disk I/O) shows its title and figure. | CN-05. |
| AP-2560 | **Superseded in part by phone-refresh-status.md AP-7465 (the range by its chart, not at the top).** **Where the range control is.** At the top while a chart card is still there or no figure opens anything; when every chart sits behind a figure (every fixture) it is only in the opened figure, and a server's “Live · every 10 s” stays at the top on its own. | CN-05: the tab row has no range picker. |
| AP-2561 | **Both pages.** A server's Summary (`ServerScreen`, every kind) and a connection's or device's first tab (`ThingPageScreen`) draw `SummaryPanels`; their other tabs stack as before. | CN-05, CN-06. |
| AP-2562 | **Guests on the phone**: a guest's name takes a second line rather than being cut; no tags in the rows (they stay on the guest's page); running first by name as before. | CN-08, small. |
| AP-2563 | **Checks**: tab words and sets, links to Connections and old names, a saved Things tab, the Servers and Services rows, the sentence, Needs you glyphs, a Summary's layout from the demo world (charts behind figures, the range moving, Network opening two, a tab link, one at a time), no tags; `pnpm check` once. Visual: the fixtures release APK on the `whombat-mobile` emulator under `agent-resource run`, light and dark: `~/.cache/wb-tmp/conn-shots/phone/`. | DEV fast. |

## Tabs and the new server card (AP-2564…AP-2599)

Whombat `docs/decisions/connections-page.md` CN-11…CN-14 (John, 2026-10-19: the server cards after his reference
screenshot, then “consider tabs for servers and services”, then “Implement this fully”). Mockups:
`docs/design-handoff/connections/tabs.html` (Servers tab, Services tab, phone; `tabs-*.png`) and `server-cards.html`
(the cards alone, light and offline: `server-cards-light.png`). Shared logic: `@whombat/client/hosts` `tiles.ts`
(`cpuLine`, `serverOsLine`, `serverTiles`, `litSegments`) and `@whombat/client` `home/tabs.ts` (`connectionsTabs`,
`openConnectionsTab`). No contract change: `HostServer.cpu`, `.storage` and `.temperature` carry every figure.

| | Decision | Why |
|---|---|---|
| AP-2564 | **Superseded by docs/decisions/overview-one-page.md OVP-01** (one page: Servers, Connections and Pinned are sections with jump links). **Tabs.** Under Needs you: **Servers**, **Services**, **Pinned**, each with its count and a dot in the worst tone of what it holds (a server offline is red; a device being learned is no trouble). Pinned only when something is pinned. With one tab alone there is no tab row, only that group's heading. Needs you stays above the tabs. | Trouble behind a closed tab still shows; Needs you is what to act on, whichever tab. |
| AP-2565 | **Superseded by docs/decisions/overview-one-page.md OVP-25, OVP-37** (an old `?tab=` scrolls to its section). **The open tab** is the asked one when it is there, else the first (Servers where the hosts service runs). The web keeps it in the address, `?tab=servers\|services\|pinned`, replacing (switching tabs isn't a place to go back to), so a link or coming back from a server lands on it. | CN-11. |
| AP-2566 | **Superseded by docs/decisions/overview-one-page.md OVP-01, OVP-22** (each section has its own summary line under its heading). **The tab row's right** says the open tab's summary: Servers “5 online · 84 of 155 guests running” with **All guests**, Services “2 working · 2 need a look · 1 learning”, Pinned “From your chats”. | The groups' heads are gone into the tabs. |
| AP-2567 | **Superseded by docs/decisions/overview-one-page.md OVP-02…OVP-07, OVP-11** (servers are one list with the same columns, a card only on a narrow page). **A server's card**: its logo or mark on a 48 px tile (`sf2`, 13 px corners), the name (mono 19/500), under it the system and uptime in mono (“Proxmox VE 9.2 · up 55 d”); right a status pill, green “Running” when fine, the problem's word in its tone otherwise (“1 to look at”, “Array failed”), grey “Offline” without a dot. Then what's inside it: a chip icon, the CPU in full (14.5/500, wraps, never cut; trademark marks left out) and “16 cores · 32 threads” under it. Then the four tiles, then the foot: “19 of 22 guests running” (containers, No guests) left, “Last seen …” right when offline. Two across from ~1060 px of page (each needs ~530 px, or the tiles' small lines are cut), else one; on a phone-width page the system line wraps. | CN-12: John's reference; “the CPU written full, so we can see what's inside the server”. |
| AP-2568 | **Superseded in part by overview-server-connection-final.md OSC-02…OSC-04: Processor, Memory, Storage, Temperature in words with their figures; amber at most.** **Superseded in part by docs/decisions/overview-one-page.md OVP-02…OVP-04** (the figures are a row's columns, the figure first with its word; the processor is its 24 h line, not a meter). **The tiles**: CPU, Memory, Storage, Temp (Hottest before). Each: the label (mono 11, caps), the number (mono 23/400) with its unit small, a meter of 20 segments (7 px, 2 px apart; lit `chart1`, unlit `line2`), a small mono line: “24 h avg 7 %”, “76 of 118 GB”, “1.6 of 3.6 TB”, “limit 85 °C”. Memory and CPU amber from 90 %; Storage amber from 80 % and red from 90 % (the server page's rule); Temp by the sensor's level. A small figure lights one segment. Offline: “—” and an unlit meter. | CN-13; the reference's meters. The CPU's 24-hour line becomes its average. |
| AP-2569 | **Superseded in part by docs/decisions/overview-one-page.md OVP-02** (the row opens the server, a figure its charts; the hover look is the row's). **A tile is a link to its figure**: CPU `?chart=cpu`, Memory `?chart=memory`, Temp `?chart=hottest` on the server's Summary, Storage its Storage tab. Hovered or focused it gets a `line2` border, its label in `chart1` and a ↗. The card is no longer one `<a>`: its name is the card's link, stretched over the card, the tiles sit above it. | CN-05 already opens charts from a figure; the card shows the same figures. |
| AP-2570 | **Superseded by docs/decisions/overview-one-page.md OVP-09** (a connection is a small tile with one line). **A service's card** matches: its logo on the same tile, the name (sans 17/600), its grey line, the pill (green “Connected”, “Needs a look”, “Learning” amber), its figures as tiles without meters (value, small rest), or the learning sentence (no “Connected” line under a pill that says it); the foot as before. Two across, as the servers (three cut the names and labels); still one link. | CN-14: one look on both tabs. |

### Phone

| | Decision | Why |
|---|---|---|
| AP-2580 | **Superseded by docs/decisions/overview-one-page.md OVP-11** (the phone shows the sections one under the other, with jump chips under the title). **A switch** under the title and Needs you: Servers · Services · Pinned with their counts and the dot, the same rule as the web's tabs (`connectionsTabs`); the open one is kept in the screen. | CN-11 at phone width; a segmented control fits a phone better than tabs. |
| AP-2581 | **Superseded by docs/decisions/overview-one-page.md OVP-11, OVP-50** (each server a card of the mock's: figures two by two, the 24 h line, running dots, the quiet pill; the card is one button). **Servers as cards** in one card list: the logo on a 38dp tile, the name in mono 16, the system and uptime under it; a green dot when fine (labelled), else the pill. The CPU in full (wraps), cores and threads. The four tiles in one row, 10 segments, no small line. Foot: guests running and a chevron. The whole card opens the server. | CN-12/13; the small lines don't fit a quarter of a phone. |
| AP-2582 | **Superseded by docs/decisions/overview-one-page.md OVP-09, OVP-11** (a connection is a compact tile; Pinned stays its cards). **Services** keep their rows (AP-2554) under the Services switch; Pinned its cards. | Rows read well on a phone. |
| AP-2583 | **Superseded by docs/decisions/overview-one-page.md OVP-10, OVP-51** (Add a server and Add a connection sit in their sections' headings). **Adding under the switch.** The group's label (and its `+`) is gone under the switch, so owners add a server from the Servers list's last row and people who may add a connection from the Services list's last row (the same row the empty card shows). With one group alone the label keeps its `+`. | The mock leaves the `+` out; adding must not need another screen. |
| AP-2584 | **Superseded by docs/decisions/overview-one-page.md OVP-01, OVP-53** (no switch on Overview). **The switch's look** (`.psegc`): a `sel` track, the open tab on `sf2` in the dark theme as the mock, on `sf` in the light one (`sf2` is all but the track's colour there); 38dp tall, padded to 44dp. Every tab shows its count, Pinned too (the mock leaves Pinned's out). TalkBack reads tabs (`tablist`, `tab`, selected) by the shared `spoken` words. | A segmented control that reads in both themes; the count rule is the web's. |
| AP-2585 | **Superseded by docs/decisions/overview-one-page.md OVP-07, OVP-13, OVP-50** (the shared `overviewServerRows` say the card; no pill when fine; one button named by every figure). **The card's words.** A fine server says “Running” (its dot's word, as the web's pill); offline is the grey pill without a dot though it ranks with the problems. The tiles and the CPU line are decorative: the card's one TalkBack label says the name and status, the system, the CPU with cores and threads, each tile's `spoken` (left out offline) and the guests. `phoneServerCards` replaces `phoneServerRows` and `memoryPair`. | One button per server; the figures as words. |
| AP-2586 | **Superseded by docs/decisions/overview-one-page.md OVP-07, OVP-11 (the pill beside the name, only when the server isn't fine).** **The card's head at phone width.** The pill sits on the name's row (the name ellipsises before it, the pill at most 70 % of the row), and the system and uptime line runs under both, one line. | With the mock's layout a real status (“Disk array failed”) cut “Unraid 7.3 · up 3 d” to “Unraid 7.3 · …”. |
