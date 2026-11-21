# Connection pages — build brief (2026-10-18)

Decisions: `docs/decisions/connection-pages.md` (CP-01…CP-20). Read it first, then §1, §2 and your stream's part of §3.
Mockups John saw (open them): `~/.cache/wb-tmp/mockups/connection-pages/ha2.png` (Home Assistant, **the target**),
`unifi.png` and `generic.png` (Hetzner; read them with CP-02 in mind: the UniFi “Busiest clients” table is **not**
built, CP-09), source `index.html` there. The server page they copy: whombat-app
`apps/web/src/features/things/ServerPage.tsx`, `tabs/SummaryTab.tsx`, `Things.module.css`, `parts.tsx`.

Contracts 0.88.0 is done and vendored on both `cp` branches (`~/Code/.wt/contracts-cp`, read
`packages/core/src/domain/thing-page.ts` — **the wire shape is the source of truth** — plus `contracts/home.ts`
`thingEndpoints`, `contracts/connections.ts` `setRunsOn`, `domain/home.ts` `ThingSummary.partOf` / `Widget.thingId`,
`contracts/mcp-one.ts` `pin_widget.thingId`, feature `things.pages`). The app's `cp` already has the client hooks
`useThingPage`, `useThingAction`, `useSetRunsOn` (`packages/client/src/react/home.ts`) and the pure helpers
`thingTabs`, `parseThingTab`, `serverTab`, `panelRows`, `askAboutWords`, `keepHereQuestion`
(`packages/client/src/home/thingPage.ts`).

## 1. Rules for every stream

- Work only in your worktree on your branch; commit small and often (`server: …`, `web: …`, `mobile: …`), every message
  ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never push, never merge into `main` or `cp`,
  never touch the main checkouts (`~/Code/Whombat`, `~/Code/whombat-app`, `~/Code/whombat-contracts`) or anyone's
  `*-lf*` worktrees: another session works there. The lead merges.
- **DEV fast** (John's rule): one quick check at the end — `TMPDIR=~/.cache/wb-tmp pnpm check` in your repo, plus
  `pnpm test:server` once (server stream). No VM tests, no repeated full suites, no CI waits. Run single test files
  while you work. Own ports (server S: 4460/5190, web W: 4470/5191) and throwaway databases; never stop or reset shared
  containers (`docker compose` is shared — never `down -v`). `/tmp` runs out of inodes: `TMPDIR=~/.cache/wb-tmp`.
- **Never call John's real services** (his Home Assistant, UniFi, Hetzner, Proxmox) or his DEV box from tests or
  scripts. Test against fakes (a `ws` server playing Home Assistant, recorded JSON). The lead checks the real ones after
  the merge.
- **Copy**: plain, short English a non-developer understands, curly quotes (’ “ ”), `·`, `−`, `…`; figures with a
  space before units (“5 %”, “30 GB”, “21.4 °C”). No ids, paths or stack traces in visible words.
- **Tokens only** (CSS variables) for UI; match the surrounding code's style and comment density.
- Contract change needed? Don't edit the vendored tarballs: message the lead (SendMessage `main`) with the exact
  additive change; the lead releases it. Prefer solving it on your side.
- Record your own decisions in your stream's decision file (S: Whombat `docs/decisions/connection-pages-server.md`,
  CP-S01…; W: whombat-app `docs/decisions/connection-pages-web.md`, AP-1900…AP-1949; M: whombat-app
  `docs/decisions/connection-pages-mobile.md`, AP-1950…AP-1999).
- When done: the quick check green, everything committed, a short report (what you built, what you decided, what is
  left, anything the lead must check live).

## 2. The page, end to end

`GET /burrows/:burrow/things/:thing` (`thing` = the URL-encoded thingId) answers a `ThingPage` for `connection:` and
`device:` things the caller may see (same visibility as `connections.list`: personal → its person, shared → members;
a learning device → members). Servers are not served here (404 `not_found`; the web uses `hosts.getServer`).

**Head**: `name` (the connection's name as the sidebar shows it, without the address), `icon`, `status` + `badge`
(ok “Running fine”, warn “Needs a look”, bad “Needs to be connected again” / “Problem”, offline “Couldn’t reach it”,
unknown “Not checked yet”, learning “Learning”; a kind may say something more precise: “1 access point offline”),
`facts` (version line first, then “Restarted 23 h ago”, “Connected by John on 8 Oct”, “Whombat may do things · locks
and alarms ask first” / “Look only”), `address` (host:port, else the account), `open` (the service's own page: Home
Assistant's base URL, UniFi's, `https://console.hetzner.cloud/`), `runsOn` (CP-08; the web draws it in the fact line as
“Runs on <name>” linking to `href`), `actions`, `canManage`, `settings` (true for connectable catalog connections and
switched-on devices).

**Overview panels** (in this order unless the kind says otherwise; widths in brackets):
1. `kpis` (full) — 4 or 5 figures.
2. `chart` (wide) + `notices` “Worth a look” (narrow, `empty: “Nothing needs a look.”`).
3. the kind's table or facts (wide) + a list or facts (narrow) — e.g. Home Assistant: “Integrations not loading” or
   “The machine” facts (wide) + “Backups” (narrow).
4. `changes` “Whombat did here” (wide, limit 5) + `access` “What Whombat may do” (narrow).
5. `widgets` “Show more here” (full; suggestions per kind, CP-14).
A panel with nothing to say is left out (less is more), except `notices` (it shows its `empty`).

**Notice links**: “Look into it” = `{kind:'ask', question}` with a plain question about this thing (“Why are two
integrations not loading in Home Assistant?”); “Show them” = `{kind:'tab', tab:'logs'}`; “Connect again” = `{kind:'tab',
tab:'settings'}`.

**Activity and Settings** are drawn by the clients (`THING_PAGE_CLIENT_TABS`); the server never sends tabs with those
keys.

## 3. Streams

### S — server (Whombat, branch `cp-server` from `cp`, worktree `~/Code/.wt/whombat-cp-server`)

Read first: `apps/server/src/home/health.ts` (5-minute pass, glances, `homeAssistantGlance` reads `/api/states` and
silently fails past `CONNECTION_OUTPUT_MAX` 64 KB on John's ~6,000 entities — CP-16 replaces it),
`home/overview.ts` (`connectionThing`, things, `partOf`), `home/registry.ts` (`recordChange`), `devices/home.ts` (the
device reader), `connections/http.ts` (`signedConnectionFetch`, `resolveCredential`, `connectionPolicy`, `pinOf`),
`lib/outbound.ts` (`outboundConnectOptions` gives a checked URL, a pinned lookup and agent — use it for the WebSocket;
the `ws` package is a dependency), `connections/call.ts` (`runConnectionRead`), `hosts/service.ts` + `hosts/routes.ts`
(fleet, guests, `…/guests/:id/config`, guest metrics), `managed/runtime-features.ts` (move `things.pages` from
`NOT_IMPLEMENTED` to `IMPLEMENTED_FEATURES` when the route works), the widgets code (`pin_widget`, `widgets.list`).

Build:
1. **Migration 0110** (0108/0109 are reserved by the other session): `connection_points` (connection id → cascade,
   `at`, `key`, `value` double nullable; primary key `(connection_id, key, at)`), `catalog_connections.runs_on` jsonb
   null (`{mode:'none'}` | `{mode:'chosen', serverId, guestId}`; null = automatic), `widgets.thing_id` text null (+
   index). Prune points older than 24 h hourly (the jobs file).
2. **Points (CP-15)**: the health pass times its check and stores `rtt_ms` (null when it failed); UniFi stores
   `wan_rx_mbps`/`wan_tx_mbps`; the device reader stores up to three numeric readings (`r_<key>`).
3. **Runs on (CP-08)**: `things/runs-on.ts` — an address index from the hosts service (server `address`, guest
   `addresses`, Proxmox guests' config `net\d+` `ip=` and `ipconfig\d+` `ip=` read through the hosts socket, running
   guests only, cached 10 min; reads that fail are skipped), the connection's host (IP, or DNS through the outbound
   lookup), the stored choice first. `connections.setRunsOn` (manage permission, commit pipeline, signed event like
   other connection updates) answers `ThingRunsOn | null`. `href`: the server page, or `?guest=<id>` on it.
4. **Kind readers** (`things/kinds/…`), each with a 30 s cache per connection, a 15 s total timeout, and plain-English
   problems:
   - `homeassistant` (CP-07): WebSocket `<base>/api/websocket` (`ws(s)`), `auth` with the connection's credential
     (`resolveCredential`; refresh on `auth_invalid` once, like `signedConnectionFetch` does on 401), then
     `get_config`, `system_health/info` (subscription: collect until `finish` or 5 s), `config_entries/get`,
     `repairs/list_issues` (titles from `frontend/get_translations` `{language:'en', category:'issues', integration:[…]}`,
     fallback to the domain's name), `system_log/list`, `backup/info` (absent on old versions: skip), one
     `render_template` for counts (`updates` = `update.*` on, `unavailable` entities, `entities` total), and on
     Home Assistant OS (`hassio` in system health) `supervisor/api` for `/core/stats`, `/host/info`, `/os/info`, `/addons`
     (+ `/addons/<slug>/stats` for started ones). An `unauthorized` answer means the account isn't an administrator:
     `problem` “Whombat’s Home Assistant account isn’t an administrator, so it can’t read the integrations and the
     log.” Machine figures from `runsOn` (guest: `cpuPct`, memory, `diskUsedGb` of the config's disk size; server:
     fleet card) and its 24 h `guestMetrics`/`serverMetrics` for the chart. Action **restart**: `POST
     /api/services/homeassistant/restart` through `signedConnectionFetch` (a person's change, CP-12), toast
     “Restarting Home Assistant. It’s back in about a minute.”
   - `unifi_network` (CP-09): `/v1/info`, sites, devices (+ details for firmware when the list lacks it, cached 10
     min), the gateway's `statistics/latest`, clients `totalCount`; chart from points.
   - `hetzner` (CP-11): `/v1/servers` (server types carry `prices` per location: monthly gross), `/v1/volumes`.
   - Everything else: the generic Overview (CP-06) only. `proxmox` / `unraid` with `partOf` get the CP-10 text panel.
5. **Generic panels (CP-06)**: from the row (`status`, `checks`, `checked_at`, `last_used_at`, `access` Look only,
   `connection_tools` tiers grouped read / change / sensitive), points, `changes` and `widgets` panels.
6. **Devices (CP-13)**: `device:con_…` → the device connection + its `device_skills` row (profile, `last_read`,
   choices); `device:dvp_…` → the proposal (`tested`, its chat for “Open the chat”, `href` to the chat).
7. **Glances (CP-16)**: Home Assistant's from the new reader (technical facts, line “Home Assistant <version>”, warn
   rules), UniFi's from the same reader as its page. `home.overview`: `partOf` for `proxmox`/`unraid` connections whose
   address is a watched server's (CP-10).
8. **Routes**: `things.page`, `things.action` (manage permission, Look only refused with a plain message, commit +
   `recordChange` “Restarted Home Assistant”, no undo), `connections.setRunsOn`; session ops through the same handlers
   as the other `home.*` ops; `widgets.list?thing=`, widgets' `thing_id` stored by `pin_widget` (validate the thingId
   exists and the person may see it), Home's widgets exclude page widgets, `widgets.remove/move` answer the list of the
   same place. A chat whose subject is a connection or device gives Whombat the thing's name and thingId in its context
   so `pin_widget` can use it.
9. Tests: unit tests for each reader against fakes (a `ws` server answering Home Assistant's messages; recorded UniFi
   and Hetzner JSON), the runs-on matcher, the panel builders' words, glance rules; one int test for `things.page`,
   `things.action` (Look only refused) and `setRunsOn`. Then `pnpm check` and `pnpm test:server` once.

### W — web (whombat-app, branch `cp-web` from `cp`, worktree `~/Code/.wt/app-cp-web`; owns `packages/client`)

Read first: `apps/web/src/features/things/ThingScreen.tsx` (`ConnectionThing` redirects to Settings — replace it when
the runtime has `things.pages`, keep the redirect otherwise, CP-18), `ServerPage.tsx`, `tabs/SummaryTab.tsx`,
`AskPane.tsx`, `search.ts`, `parts.tsx`, `Things.module.css`, `components/charts`, `features/connectors/ConnectionPage.tsx`
(becomes the Settings tab body without its head), `features/settings/ConnectionsTab.tsx` + `ConnectionsOverview.tsx`,
`features/home/ThingTiles.tsx` + `HomeScreen.tsx` + `WidgetCard.tsx` + `DoneRecently.tsx`,
`app/shell/assistantSidebarModel.ts`, `packages/client/src/home/things.ts`, the fixtures (`app/*Fixtures.ts`,
`fixtureFetch.ts`).

Build:
1. `features/things/page/` — `ThingPageScreen` (head, fact line with the runs-on link and “Change” for managers, tabs via
   `thingTabs`/`parseThingTab` in the address `?tab=`, `panelRows` grid 1.6fr/1fr like the mock, the Ask pane closed
   until asked with `?ask=1`, a notice's ask link opening it with the question ready to send), one component per panel
   kind (`kpis` = the server page's KPI row, `chart` = `TimeChart` with a right axis when a series asks for it,
   `notices`, `table`, `list`, `facts`, `text`, `access` with “Change” → Settings, `changes` = Done recently's rows for
   `changes.list?thing=`, `widgets` = the person's widgets for the thing + suggestion chips), the actions with a
   confirm (`ConfirmDialog`), “Open <service>” in a new tab, `readAt`/`problem` line, loading skeleton and errors like
   the server page. Refetch every 60 s while open.
2. Activity tab (paged `changes.list?thing=`, Undo) and Settings tab (`ConnectionPage` with an `embedded` prop that
   drops its head; for a device the tools/tiers part; keep every write it has).
3. Runs-on picker dialog: “Let Whombat find it” · servers and their guests (fleet + `hosts.listGuests`, searchable) ·
   “Not on a server Whombat watches”; `useSetRunsOn`.
4. Navigation: sidebar and Home tiles leave out things with `partOf`; Home tile title for Home Assistant is its name
   (drop it from `TILE_TITLES`); the server page's head lists “Also connected: <name>” for things whose `partOf` is
   that server; Settings → Connections rows open the thing page, and `/settings?tab=connections&connection=…&id=…`
   redirects to `/things/connection:<id>?tab=settings` (when the runtime has the feature); after connecting a new
   connection, land on its page.
5. Client (`packages/client`, yours): `applyWidgets` must patch only the `widgets.list` cache of the same place (Home or
   that thing) and Home only for Home's widgets; anything else shared the phone needs goes here with tests.
6. Fixtures: realistic `things.page` answers for John's world — Home Assistant (as `ha2.png`: 2026.10.2 Container,
   10.100.0.5:8123, runs on pve-02 · CT 131, CPU 5 %, memory 3.0 / 8 GB, disk 30 / 40 GB 76 %, MariaDB 2.8 GB, 169 of
   171 integrations, the three notices, backups), UniFi (21 of 22 access points, 174 clients, 45 devices), Hetzner
   (1 of 1 server running), a generic one (the tracker), a switched-on device, a learning device. Visual check against the
   mockups at 1440×900 in both themes (`pnpm visual` harness or Playwright), fix differences; the mock is the
   reference for layout, sizes and words, CP-02 wins over it.
7. Tests for the pure parts; `pnpm check` once at the end.

### M — phone (whombat-app, branch `cp-mobile` from `cp`, worktree `~/Code/.wt/app-cp-mobile`; `apps/mobile` only)

Read first: `apps/mobile/src/screens/ThingScreen.tsx` (replaces itself with `Connection` for non-servers — keep that
for runtimes without `things.pages`), `ServerScreen.tsx` (the server dashboard: `Tiles`, `OneCard`, `OneRow`,
`ToneBadge`, `Facts`, `Sparkline`/`Meter` in `managed/HostCharts`, `Segmented`, `NewChatSheet`, `BackBar`, `Screen`),
`ConnectionScreen.tsx`, `ThingsScreen.tsx`, `HomeScreen.tsx`, `apps/mobile/src/ui/*`.

Build: `ThingPageScreen` for `connection:`/`device:` things from `useThingPage` — head (name, badge, fact lines, runs-on
row opening the server/guest screen), tabs as a segmented control (`thingTabs`; Settings navigates to the existing
`Connection` screen instead of a tab), panels stacked (kpis as tiles two by two, chart as a sparkline-style line with
its latest figures, notices with their buttons, table as rows with the first column as the title and the numeric
columns on the right, list, facts, text, access, changes with Undo, widgets), actions behind a confirm sheet,
“Ask about …” opening `NewChatSheet` with the thing as subject (a notice's question prefilled), Open in the browser,
pull to refresh and a 60 s refresh while visible, 44 px touch targets, labels for dots. Things list and Home tiles leave
out `partOf` things. Unit tests for the screen's pure mapping; `pnpm check` once at the end (no emulator runs needed;
if you have time, one screenshot on the emulator is welcome but not required).
