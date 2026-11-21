# Screens of widgets — build brief (2026-10-27)

Decisions: `docs/decisions/desk-display.md` **DK-126…DK-149** (section “Screens of widgets”), on top of DK-01…DK-125.
**Read them first**, then §1, §2 and your stream's part of §3. The mockups are the visual target:
`~/.cache/wb-tmp/mockups/desk-widgets/` — `dist/screens.html` (every screen frame), `dist/editor.html` (the editor,
working: drag, resize, add, pages, Size, undo), `shots/*.jpg` (the frames as pictures), `src/kit.js` + `src/kit.css`
(the mockups' widget drawing, forms per size, the grid; a good starting point for `@whombat/screen/react`). Open the
HTML with Playwright (`node ~/.cache/wb-tmp/mockups/desk-widgets/shoot.cjs` and `shoot-editor.cjs` show how). The real
tokens, fonts, marks and components of each app win over the mockups' approximations; their layout, copy and behaviour
are the target.

The contracts are done on the integration branch **`screens`** (commit after `bfba7e9af`). Read these before anything:

- `packages/core/src/domain/desk-screens.ts` — screens, pages, layouts (`DeskLayout`, `DeskPage`, `DeskWidget`,
  `deskLayoutProblem`, `deskDefaultLayout`, `deskLayoutWidgets`), the widget views (`DeskWidgetView`: `figures`,
  `list`, `posters`, `chart`, `camera`, `server`, `text`), `DeskImage`, what needs the person (`DeskAttention`), the
  screen's grid (`DeskGrid`), Settings' shapes (`DeskScreenSummary`, `DeskScreenDetail`, `DeskCatalog`), the six
  letters, limits and `DESK_SCREEN_WORDS`.
- `packages/core/src/domain/desk-calm.ts` `deskAttention` / `desk.ts` `deskAttentionFor` — the modal's and the pill's
  items from the calm planner's input (pure; the runtime never re-decides).
- `packages/protocol/src/session/desk-screens.ts` + `operations.ts` — the ops: `desk.screens`, `desk.screen.get`,
  `desk.screen.update`, `desk.screen.views`, `desk.screen.try`, `desk.screen.add`, `desk.screen.remove`,
  `desk.widgets` (app channel); `enroll.display.request`, `enroll.display.status` (enroll channel); `screen.state`,
  `screen.unlock`, `screen.lock`, `screen.image` (the new **`screen` channel**: only a screen's endpoint, and it sees
  nothing else — `OperationAllowlist.resolve(op, {enrolled, screen})`). Errors `unknown_screen`, `screens_full`,
  `bad_layout`. `ENDPOINT_ENROLLED_VIA` has `display`.
- `packages/control-contracts/src/local/desk.ts` — the desk socket: `DeskGlance.grid` (a `DeskGrid`, opaque on the
  wire: `DeskGridWire`), `DeskGlance.outputs` (monitors on the box), `DESK_PATHS.image` (`DeskImageRequest` → bytes),
  `DESK_PATHS.size` (`DeskSizeRequest`), `DESK_STATE_MAX_BYTES` 512 KiB.
- `packages/screen/` — **`@whombat/screen`**: `grid.ts` (`screenGrid`, `shapeKey`, `cellRect`, `cellAt`, `fits`,
  `firstFree`, `rearrange`, `pageOn`), `specs.ts` (each widget's min/max/first size, `sizeOf`). Pure TS, no zod, no
  other package at runtime: the box's console takes its source as it is (like `@whombat/brand`). `react.tsx` is the
  drawing (stream K).
- `apps/server/src/db/schema/desk.ts` `screens` + migration `0013_screens` — every screen's row.
- `apps/server/src/desk/widgets/types.ts` — the runtime's seams: `WidgetCtx`, `Resolved`, `ThingWidgets` (R2),
  `ScreenRecord`, `ScreensApi` (R1; R3 uses it).

| Stream | Where | Ids |
|---|---|---|
| R1 runtime: screens, layouts, Whombat's own and the servers' widgets, the box's grid | Whombat, your worktree | DK-S160…DK-S179 (`desk-display-server.md`) |
| R2 runtime: every connection's and device's widgets | Whombat, your worktree | DK-S180…DK-S199 |
| R3 runtime: screens elsewhere (enrolment, the screen channel) | Whombat, your worktree | DK-S200…DK-S219 |
| K `@whombat/screen/react`: the drawing | Whombat, your worktree | DK-S220…DK-S229 (`desk-display-server.md`, a section “The drawing”) |
| W web: Settings → Screens, the editor, the screen page | Whombat, your worktree | AP-5940…AP-5999 (`docs/app/decisions/desk-display-web.md`) |
| M phone: Settings → Screens and the editor | Whombat, your worktree | AP-6000…AP-6039 (`docs/app/decisions/desk-display-android.md`) |
| P the box's console (appliance) | appliance, `~/Code/.wt/appliance-screens` | CG-380…CG-419 (`docs/decisions/console-gui.md`) |

## 1. Rules for every stream

- Start: your worktree is a checkout of `main`; first `git merge --ff-only screens` (a local branch with the
  contracts). Work only in your worktree; commit small and often (`server: …`, `web: …`, `mobile: …`, `screen: …`,
  `docs: …`), each message ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. **Never push, never
  merge into `main` or `screens`, never touch `~/Code/Whombat` or `~/Code/whombat-appliance` themselves** (other
  sessions work there), never run `dev/candidate`, `pnpm contracts:release` or any release. The lead merges.
- When the lead tells you another stream's branch is ready (“merge t3/…”), `git merge` it into yours.
- **Don't change the contracts** (`packages/core`, `protocol`, `control-contracts`) unless your stream says so. If you
  need a change, make it as small as possible in its own commit (`contracts: …`) and say exactly what and why in your
  report; the lead decides. Small additions to word tables for words you need are fine.
- Search only inside your worktree (and the mockup folder above); never `find`/`grep` over `/` or `$HOME`.
- Node 24: `export PATH=/home/me/.local/share/mise/installs/node/24.18.0/bin:$PATH`; `export
  TMPDIR=/home/me/.cache/wb-tmp`. `pnpm install --frozen-lockfile` once (after merging a branch that changed the
  lockfile, `pnpm install` again).
- **DEV fast**: run single test files while you work; at the end `pnpm format`, then `pnpm check` once (R1, R2, R3 also
  `pnpm test:server` once). No VM, no CI, no candidate. Shared Postgres :55432 only through the tests' throwaway
  databases; never stop or reset shared containers. Use a free port for anything you start; never `pkill` by a pattern
  that could match another session's processes.
- **Tests** (`docs/decisions/test-speed.md`): unit-test logic; fakes in process, clocks injected, never sleep. Check
  facts (keys, ids, a short phrase), never long literal text. A new `*.int.test.ts` needs a reason to need Postgres.
- **Words**: plain English (`CLAUDE.md` “Agents and automations talk like people”), curly quotes (’ “ ”), the middle dot
  `·`. Code comments say why, without decision codes.
- Record decisions you take in your stream's decision file under your ids (one short paragraph each, “*Why:*”).
- Finish with a report: your branch name and head SHA, what you built, what you couldn't verify, any contract change,
  and anything another stream must know.

## 2. How it fits

```
Settings → Screens + editor (web W, phone M) ──desk.screens / desk.screen.* / desk.widgets──▶ runtime (R1, R2)
runtime: each screen's layout → its widgets → views (R1: Whombat's own, servers, Home widgets; R2: things' figures and
         panels) + the calm glance (deskCalmFor) + what needs the person (deskAttentionFor, the screen's pop-ups and lock)
runtime ──DeskState.glance.grid / outputs──▶ console server (Go, passes) ──▶ the box's page (P, drawn by K)
runtime ──screen.state──▶ a tablet's or computer's screen page in the web app (W, drawn by K)   [R3: who may]
pictures: views name {thing, ref}; the box's page asks the desk socket's `image`, a screen elsewhere `screen.image`,
          the apps their existing `thing-image` download
```

A screen's size is the screen's to know: the box's page tells the runtime (`size`), a screen elsewhere with every
`screen.state`, so Settings draws the editor at the screen's real shape. The grid is computed with `@whombat/screen`
everywhere (`screenGrid(width, height, layout.size)`). The views carry no size: the drawing picks the form.

The default layout is the calm glance (`deskDefaultLayout`); *How things are*, *What’s going on* and *Servers* read the
calm glance (`DeskCalm`: `headline`, `moments`, `strip`) — they have no views. *Clock* has none either.

## 3. Streams

### R1 — runtime: screens, layouts, Whombat's own and the servers' widgets, the box's grid (`apps/server/src/desk/`)

1. **The store** (`desk/screens.ts`, implementing `ScreensApi`): the `screens` table (migration `0013_screens` is there;
   adjust it only if you must, then regenerate with drizzle-kit and keep `compat.json`'s entry). The box's own row is
   written the first time it's changed; until then the box's screen reads as `deskDefaultLayout()` with pop-ups `all`.
   Read `layout` through `DeskLayout.safeParse` + `deskLayoutProblem` (bad → default), `show` through `DeskShow` (the
   box's own: `desk_screens.show`). Writes through the commit pipeline; `desk.changed` after each.
2. **The ops** (register with the other `desk.*` ops: feature, channel, handler): `desk.screens` (box first, then
   outputs, then devices; `online` = seen in the last 2 minutes or the box's own while on; `canAdd` below
   `DESK_SCREENS_MAX`), `desk.screen.get`, `desk.screen.update` (layout: `deskLayoutProblem` and every widget within
   `@whombat/screen`'s `sizeOf` limits — a panel's by its view when known — else `bad_layout`; the box's name can't
   change), `desk.screen.views` (resolve the given specs as that screen would: the calm glance with
   `deskPreviewInput` for `scenario`, `deskAttentionFor` with the screen's pop-ups, view `everything`), `desk.screen.try`
   (that screen shows the layout given for `DESK_TRY_S`; memory only; `DeskGrid.trying`), `desk.screen.remove` for an
   output (forget it) — a device's removal is R3's (revoke) but the op is one: call R3's revoke when the screen is a
   device (agree the function with R3: `revokeScreenDevice(services, record)`), `desk.widgets` (groups: Whombat's own
   (`DESK_SCREEN_WORDS.own`, the assistant's name filled in), *Servers* (every server of the fleet, `server` items with
   `ref` `server:<id>`, `line` like “Proxmox · 16 cores”), the things (`ThingWidgets.groups`, R2), *Made by
   {assistant}* (Home widgets, `widget:<id>`); with `thing`, R2's groups for it).
3. **Resolving** (`desk/widgets/`): per screen, the distinct widgets of its layout (`deskLayoutWidgets`, at most
   `DESK_SCREEN_VIEWS_MAX`), each resolved and cached until its `refreshS`: Whombat's own `work` (a `list`: the
   assistant's work, its steps with their state, `progress`), `coming` (a `list` of the next automations/backups,
   `time` the hour or the day), `done` (a `list`: what the assistant finished today, `done_tasks`, newest first);
   `server` (a `server` view from the hosts service: state and `say` as the strip's, cpu/memory/disk, `spark` over
   `opts.range` (default `24h`) downsampled to ≤ 48 points, `stats` “Avg 14 % · Peak 63 % Sun 03:10”, uptime; refresh
   15 s; reuse `desk/server-page.ts` and `calm-sources.ts` reads); `widget` (a Home widget as `figures` with its series as
   `spark`, refresh its `refreshSec`); `figures`/`panel` through `ThingWidgets.resolve` (R2; until R2 lands, a stub that
   answers a `text` view “Coming soon”). A widget that can't be resolved (a server gone) is a `text` view with a
   `problem`. Never slow the glance: resolve in the background loop, serve from the cache, time out reads (what you
   have wins).
4. **The lock** (DK-138): what a view may show for the screen's lock view — `everything` all; `summary` drops `private`
   resolutions' words and pictures unless the widget's `opts.lock` is `show` (keep the view's `title`, `name`, `mark`,
   set `locked: true`, empty its rows/items/image); `time`: no grid at all. Ask titles in the attention come out right
   from `deskAttentionFor` with the view.
5. **The box's grid**: `DeskState.glance.grid` for the box's own screen (`screen` `box`, its layout — or the draft while
   `trying` — the views, `deskAttentionFor(input, show, view, popups)`, `popups`), validated with `DeskGrid.parse` before
   it goes (drop it, with a log line, rather than send a bad one). Keep every older member (`calm` and the rest) as it
   is. `DESK_PATHS.size`: keep the outputs the page reports; every output besides the main one is a screen
   `out_<key>` (made on first sight with the default layout, pop-ups `problems`, name the monitor's name or
   `DESK_SCREEN_WORDS.output`) and its grid goes in `glance.outputs` while reported. `DESK_PATHS.image`: a picture one
   of the box's (or an output's) widgets names, through `things/images.ts` (`pictureFor` / the `thingPicture` checks:
   the paired person may see the thing, the ref is signed for it), and only if the lock lets that widget show it; every
   refusal the same `not_found`.
6. **`ScreensApi.draw` and `picture`** for R3 (a screen elsewhere): the same as the box's, for that screen's record.
7. Tests: unit tests for the store's reads (bad JSON → default), the ops' checks, resolving (fake hosts, fake
   `ThingWidgets`), the lock's trimming, outputs; `desk.int.test.ts` only where Postgres is the point (the migration,
   a layout round trip, an output appearing).

### R2 — runtime: every connection's and device's widgets (`apps/server/src/desk/widgets/things.ts`, `things/`)

Implement `ThingWidgets` (`desk/widgets/types.ts`). The widgets come from the things' pages (DK-139): every service
already builds its page from panels with stable ids (`ThingPagePanel`, `things/kinds/*`, the generic page
`things/page.ts`), so every panel can be a widget.

1. **Groups** (`groups`): for every connection and device the viewer sees (Home's things, as `things.page` finds
   them), a group: `label` the thing's name, `mark` its catalog id where it's a brand mark, `thing` its ref, items:
   `figures` (its head figures, “Figures” · “Its main figures”) and one `panel` item per panel worth a screen — `kpis`,
   `chart`, `list`, `table`, `bars`, `gallery`, `controls`, `facts`, `notices`, `text` (not `access`, `changes`,
   `widgets`) — `name` the panel's title, `line` a few words about what it shows, `view` the view it becomes, `opts`
   `{panel: <panel id>}`. Read each page once and keep its panel list (ids, titles, kinds) for 10 minutes; a thing whose
   page couldn't be read in 3 s gets its figures item and `partial: true` (asked alone with `thing`, read it now).
   Order: things with designed pages first (the kinds), then the rest, each by name.
2. **Resolving** (`resolve`): group the specs by thing; read each thing's page once (the same read as `things.page`, its
   caches; its live part at the kind's `liveS`), then map: `kpis` → `figures` (≤ 4 items, value/unit/label/tone), the
   head figures for `figures`; `chart` → `chart` (series ≤ 120 points, downsampled; figure, stats, limit, foot);
   `list`/`table` → `list` (title, detail, meta, time, progress, the item's picture as `DeskImage`); `bars` → `list` with
   `progress` per row; `gallery` → `posters` (shape from the gallery), or `camera` for a `wide` gallery of snapshots
   (the first item, or `opts.item`); `controls` → `list` with `state` on/off (view only); `facts` → `list`; `notices` →
   `list` with tones; `text` → `text`. A panel the page no longer has → a `text` view with a `problem`. A thing that's
   down → the widget's `problem` (“Plex isn’t answering”, and when what it runs on is down, “It runs on pve-02, which is
   down.”), tone `bad`. `refreshS` the page's `refreshS` (never under 10), 60 for `figures`. `private`: what's playing
   and what's waiting for approval (media), cameras, calendars and mail, documents and photos — decide per kind (a small
   table in `widgets/things.ts`) and record it.
3. **Pictures**: views name `{thing, ref, shape, alt}` with the page's signed `ref` (`things/images.ts`), so the box's
   page, a screen elsewhere and the apps load them through the existing checks (R1 and R3 serve them).
4. **Quality**: look at what the main kinds give on a screen with their fixtures — Plex (now playing as `posters` with
   who and progress; recently added), SABnzbd (the queue: `head` “3 left · about 20 min”, rows with progress),
   Seerr (requests), Sonarr/Radarr (coming), Home Assistant (a sensor's figures and chart, favourites/lights as on/off
   rows, a camera), UniFi (internet speed, clients), Pi-hole/AdGuard (blocked today), Synology/TrueNAS/QNAP (storage
   bars with the forecast), Proxmox Backup Server (backups), a calendar if one exists. Where a kind's panel maps badly,
   add a small per-kind hint (which panel is its best widget, a better title, a `head` line) rather than special-casing
   the drawing. Unit tests per mapping with the kinds' fixtures; no network.

### R3 — runtime: screens elsewhere (`apps/server/src/managed/`, `desk/`)

1. **Becoming a screen** (DK-146): `enroll.display.request {endpoint}` (ephemeral, memory only, like
   `enroll.pair.request`; six letters `DESK_SCREEN_CODE_RE` from the claim's alphabet, 10 minutes, the same unenrolled
   budget and backoff as the pairing), `enroll.display.status {requestId}` (`waiting`, `added` with `enrolled` and
   `screen`, `expired`). `desk.screen.add {code, name, popups, start}` (the person's): finds the waiting request,
   enrols that session's endpoint to the person's account with `enrolledVia: 'display'` (a signed appliance event, as
   other enrolments) and writes the screen (`ScreensApi.addDevice`) in one commit; `wrong_code` / `pairing_expired` as
   `desk.pair`'s; `screens_full` at `DESK_SCREENS_MAX`. `device` from the endpoint's label and platform (“iPad ·
   Safari”).
2. **Only the screen channel** (the security heart; test it hard): a session whose endpoint is `display` resolves only
   `screen.*` (`resolve(op, {enrolled, screen: true})`), and every other way in refuses it too — realtime topics,
   streams (downloads, uploads, exports, consoles), `api` handlers, push registration, `endpoints.*`, enrolment ops.
   A person's endpoint can't call `screen.*`. Revoking the endpoint (Remove, or `endpoints.revoke`) ends its open
   sessions at once and deletes its screen row (the FK cascades; make sure the order is right). A `display` endpoint
   never counts as the person's device for “never leave the person without a device”, never gets push, never shows as a
   sign-in device in the person's list (show it under Screens instead) — check `endpoints.list` and friends.
3. **The screen ops**: `screen.state {size, known?}` → `ScreenState` from `ScreensApi.draw(record, view)` with the lock
   (`ScreenLock`: locked unless unlocked with the PIN, view `desk_screens`' `lockedView`; `hasPin` the box screen's PIN
   exists), `etag` a hash of the answer, `{same, etag}` when `known` matches; `ScreensApi.seen` with the size (throttled).
   `screen.unlock {pin}`: the box screen's PIN (the same scrypt check as the desk's), per-screen wrong tries and backoff
   (`deskTriesLeft`, `deskPinBackoffS`), memory only; unlocked until `DESK_SCREEN_UNLOCK_IDLE_S` after the last
   `screen.state` that said it was touched — add nothing to the contract for that: treat any `screen.state` within the
   window as use while unlocked, so the page asks often while touched). `screen.lock`. `screen.image {thing, ref}` →
   `ScreensApi.picture` (base64; the same `not_found` for every refusal).
4. **Realtime**: the screen page polls `screen.state` (every 10 s, sooner after a touch) — no topics for screens.
5. Tests: the allowlist and dispatcher refusals (every non-screen op, streams, topics) for a `display` session;
   enrolment (code, expiry, backoff, wrong code, full); revoke ends sessions; screen ops with a fake `ScreensApi`;
   integration only where Postgres is the point (the enrolment commit, the cascade).

### K — `@whombat/screen/react`: the drawing (`packages/screen`)

The one drawing of a screen (DK-141), used by the box's console (P), the web app's screen page and editor (W). React DOM,
CSS (a `.module.css` next to the components — both Vite builds take it), colours and fonts only from the tokens' CSS
variables (draw inside `data-theme="dark"`: the screen is always dark), marks from `@whombat/brand/react`
(`BrandMark` for brand slugs and OS marks). No zod, no `@whombat/core` at runtime (types only in tests).

1. `src/types.ts`: plain TypeScript types mirroring the contract's (`DeskLayout`, `DeskPage`, `DeskWidget`,
   `DeskWidgetView` and its parts, `DeskImage`, `DeskAttention`, `DeskGrid`, and the members of `DeskCalm` the widgets
   read), with a test that the core zod types and these are assignable both ways. `src/words.ts`: every word the
   drawing shows (kept equal to `DESK_SCREEN_WORDS` where they overlap, by a test).
2. `<Screen>`: the whole screen at its logical size (`screenGrid` of its width/height and `layout.size`), scaled to the
   box it's given: the top bar (the Whombat's name, the pill, the pages' names — dots when narrow — and the chips the
   host passes in as children), the current page's widgets (`pageOn`), the edge, the modal, *Try on the screen*'s
   banner. Pages: swipe or touch a name; `turn` every 30 s / minute (waits while touched); back to the first page after
   `DESK_FIRST_PAGE_AFTER_S` untouched when `touch`. Props: the grid, the calm glance, the name, the lock view, `now`,
   callbacks for the host (open a server, open the modal's step, answer, *Not now*, unlock), an image loader
   (`loadImage(image) => Promise<string>` returning an object URL; the console and the web app each bring theirs), and
   an `editing` mode for the editor (cells drawn, widgets not interactive, selection drawn by the editor over it, or
   expose the pieces the editor needs: `<Cells>`, `<WidgetView>` positioned by `cellRect`).
3. `<WidgetView>`: every widget type and view kind in its designed forms by size (the mockups' `kit.js` has them: clock,
   how things are, what's going on, servers, the assistant's work, coming up, done today, server, figures, list,
   posters (now playing with who and progress, recently added as a row), chart, camera, text; a `problem` replaces the
   content with its words in red; `locked` says “Unlock to see it”); `tone` colours the card. Tapping a widget opens it
   big (DK-140): its largest form over the dashboard with *Back* (a server's screen is the host's: callback).
4. `<AttentionModal>` (DK-135, DK-136): the modal over the dashboard for the items that `pops` and haven't been put
   away; *Not now* puts the shown ones away (the host keeps which keys); “1 of 3” with arrows; opens again only for a
   new key; closes when its items are gone; the pill opens it with everything. Buttons by item: an ask → its answers are
   the host's (a callback with the ask's number; the box's console shows its ask card, a screen elsewhere says to answer
   on the phone or at the box), a look → *Ask {assistant} to fix it* / its `fix` / *Open {name}* (callbacks), *Not now*.
5. `src/fixtures.ts`: the mockups' world as data (a layout with the three pages, views for every kind, a calm glance, an
   attention with an outage and a question) — for tests, the web app's fixture mode, the console's shots.
6. A harness to see it: a Vite-free page is fine — e.g. a test that renders to static markup, plus a small Playwright
   script (`packages/screen/scripts/shots.ts`) that renders the fixtures at 1280×800, 1920×1080 and 820×1180 into PNGs
   under `~/.cache/wb-tmp/screen-shots/` for the lead to compare with the mockups' `shots/`. Unit tests for the forms'
   choices (which form at which size), page turning (injected clock), the modal's state.
7. Performance: the box draws in software (no GPU): SVG charts, no animation beyond a single fade, no shadows on every
   card, redraw only what changed (memo per view).

### W — web: Settings → Screens, the editor, the screen page (`apps/web`, `packages/client`)

1. **Client** (`packages/client/src/desk/`): `DeskApi` gets `screens`, `screen(id)`, `updateScreen`, `screenViews`,
   `tryScreen`, `addScreen`, `removeScreen`, `widgets`; hooks in `react.ts`; the fake world (`fakeWorld.ts`) gets
   screens (the box's with the mockups' three pages, a kitchen tablet, an office monitor) and views from `@whombat/screen`'s
   fixtures. A screen client for the screen page: `enrollDisplay`, `screenState`, `screenUnlock`, `screenLock`,
   `screenImage` (read through an export stream when large, as `desk.voiceSample`). **Commit the client first** and
   tell the lead (stream M builds on it).
2. **Settings → Screens** (replaces the *Screen* tab where the runtime answers `desk.screens`; else the old tab):
   the list (each screen: a live thumbnail drawn with `<Screen>` from `desk.screen.get` + `desk.screen.views`, its
   name, what it is, its grid and pages, its pop-ups, *Edit layout*), *+ Add a screen* (the dialog of the mockups'
   `f-add`: six letter boxes, name, pop-ups, start with a copy or empty), and a screen's own page: name (not the
   box's), *Edit layout*, *What pops up* (the three), for the box's own the parts that were the *Screen* tab's (*Lock
   and PIN*, *Night*, *Talk*, the top bar's choices, *Welcome back*, *Done today*), for a device *Remove*.
3. **The editor** (DK-143; the mockups' `editor.html` is the working reference): a page of its own
   (`/settings/screens/:id/layout`), the screen at its real shape (`screen.size`, else 1280×800) drawn with `<Screen>`
   in editing mode and live views (`desk.screen.views` for the draft's widgets, refreshed every 30 s), pages with
   *+ Page* (rename and delete on the page's menu), *Size*, *Pages turn*; *Add a widget* (`desk.widgets`: search,
   groups, a thing's group asks `desk.widgets {thing}` when opened; drag in, or *+* to the first free spot, smaller if it
   must); moving and resizing with the pointer (snapping, red when taken, the widget redraws as it's resized),
   keyboard (arrows, Shift+arrows, Delete, Escape, ⌘Z/Ctrl Z); a chosen widget's settings (the mockups' edit panel:
   preview, its own settings — *What’s going on*'s choices are the old *The middle* rows, *Servers*' order the old
   strip order list, a server's server and range, a panel's thing and panel, *On a locked screen* where it's private —
   size steppers, *Remove from this page*); *Didn’t fit* after a shape change; draft, *Undo*, *Try on the screen*
   (`desk.screen.try`), *Save* (`desk.screen.update {layout}`; show `bad_layout` plainly). Pure parts (moves, resizes,
   keyboard, undo stack) in a module with unit tests; use `@whombat/screen`'s grid. Drag with pointer events (the
   mockups' way) or `@dnd-kit` — your call, record it.
4. **The screen page** (DK-146): a route that runs without a person's sign-in — wherever the app offers what to do with
   this device for a Whombat (the pair/sign-in choices, and the box's own page on the local network), add *Use as a
   screen*: `enroll.display.request` with a separate endpoint identity kept for screen mode (so a person's browser can
   also be a screen in another profile), the six letters big (the mockups' tablet in `f-add`), polling
   `enroll.display.status`; then the screen: `screen.state` every 10 s (sooner after a touch), drawn full-window with
   `<Screen>` (top bar chips: *Online*, the lock), pictures through `screen.image`, the modal saying to answer on the
   phone or at the box, *Unlock* with the PIN (a PIN pad), a fullscreen button, the Screen Wake Lock API where it
   exists. A removed screen goes back to *Use as a screen*.
5. Visual check against the mockups (1440×900 and a narrow window, both themes for Settings; the screen is always dark)
   with the repo's visual tooling; unit tests for the pure parts. Fixture mode shows all of it.

### M — phone: Settings → Screens and the editor (`apps/mobile`)

Starts when W's client commit is in (`merge` it). The same as W on the phone, the phone's way (DK-145): *Screens* in
Settings (where the runtime answers `desk.screens`; else the old *Screen* page), the list, *Add a screen* (six letters,
name, pop-ups, start), a screen's page (the box's own keeps today's *Lock and PIN*, *Night*, *Talk*), and the editor:
the grid drawn as labelled tiles (the widget's name and mark, its size; no live widget drawing on the phone), tap a
widget → a sheet with *Move* (arrows) and *Size* (−/+ wide and high) buttons, its settings and *Remove*; *Add a widget*
as a sheet (search, groups, *Add* to the first free spot); pages, Size, Pages turn; draft, *Undo*, *Try on the screen*,
*Save*. 44 px targets, TalkBack order, the phone's tokens. Use `@whombat/screen`'s grid (pure). Check it in the demo
world with the repo's mobile tooling; unit tests for the pure parts. Bump nothing (the lead bumps the app's version).

### P — the box's console (appliance `console/ui`, Go console server, kiosk)

Your own worktree of the appliance: `git -C ~/Code/whombat-appliance worktree add -b screens ~/Code/.wt/appliance-screens
main`. Vendor from the Whombat commit the lead names (the vendor scripts take a commit): add `@whombat/screen`'s
source (`src/*.ts`, `src/*.tsx`, `src/*.css`, without tests) to `scripts/vendor-app.sh` and its vite/tsconfig aliases, and
`desk-screens.ts` to `vendor-contracts.sh`.

1. **The page**: when `glance.grid` is there, draw it with `<Screen>` under the console's own top bar chips (network,
   internet, battery, lock, remote help, updating — the calm glance's top bar, passed in as the chips), the calm glance
   for Whombat's own widgets; else the calm glance as now. Pictures through `/v1/desk/image` (the console server proxies
   it to the desk socket's `image`); the modal's ask goes to the ask card the console has (PIN first while locked), a
   look's step to `look/fix`, *Open* a server to the server screen; a widget opens big. *Only the time* and night as
   today. Report the outputs and their sizes to `size` at start and on change.
2. **The console server** (Go): pass `grid` and `outputs` through as they come (opaque JSON within the state's 512 KiB),
   add the `image` and `size` routes with the contracts' limits; contracts-go from the vendored contracts.
3. **A monitor on the box** (DK-147): today the kiosk shows one Chromium window over all outputs (cage). Make each extra
   output show its own screen: find the simplest robust way (e.g. cage extending over every output with the page drawing
   one screen per output's rectangle, learned from `wlr-randr` at start and on hotplug; or one window per output) and
   record it (NX-… in `nixos.md` for the kiosk, CG-… for the page). If it can't be done safely in this build, say so in
   your report with what it would take, and keep everything else working with one output.
4. Shots (`pnpm shots`) of the grid states at 2560×1600 against the mockups; `pnpm check`; the Go tests.

## 4. Notes from the streams

**R2 is in `screens`** (merge 631b237da). Wiring for R1: create `createThingWidgets(services)` once per server process
(it keeps what it read in memory); `desk.widgets` adds `await tw.groups(ctx)` after the Servers group, and with
`thing` returns `tw.groups(ctx, thing)`; pass the `figures` and `panel` specs to `tw.resolve(ctx, specs)` from the
background loop only (a page read can take up to 12 s, plus 3 s for the fleet when a thing is down), never inline in
the glance; `ctx.viewer` is the person's `{accountId, burrowId, principal}`; a panel widget's size limits come from the
catalog item's `view`, lock trimming from `Resolved.private`; serve pictures with `thingPicture(services, viewer,
thing, ref)` (`things/image-route.ts`); devices have no pictures. R2 also fixed `pnpm check` on `screens` itself (the
conformance vectors' `SECRET_OPS` for `desk.screen.add` and `screen.unlock`, the client fake's new refusals,
`compat.json`'s formatting): merge `screens` to get them.

**R1 is in `screens`** (merge ab423f0e7; R2 wired in after it). For R3: `DeskService.screens` is the `ScreensApi`; call
`screens.addDevice(tx, …)` inside your enrolment commit (it refuses `screens_full` past 8 other screens); fill the body
of `revokeScreenDevice(services, record, by?)` in `desk/screens.ts` (revoke the endpoint, end its sessions; today it only
deletes the row); `draw` returns a grid without views or modal items for *Only the time* — `ScreenState` wants `calm` and
`grid` null there, so answer that yourself; `desk.screen.add`, `screen.*` and `enroll.display.*` aren't registered yet
(they answer `not_implemented`) — registering them is yours. For P: post every output to `/v1/desk/size` at start and on
change, the box's own display first with `main: true`; read `glance.grid` and `glance.outputs` (the monitors' grids are
dropped first if the state would pass 512 KiB). For W and M: `desk.screen.update` ignores a new name for the box's own
screen; its *What’s going on* and *Servers* choices live with the box's screen settings, so changing them refuses
`not_paired` while the screen isn't paired.
