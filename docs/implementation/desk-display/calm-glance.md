# The calm glance and Settings → Screen — build brief (2026-10-27)

Decisions: `docs/decisions/desk-display.md` **DK-101…DK-125** (section “The calm glance and Settings → Screen”), on top
of DK-01…DK-100 and `desk-display-server.md`. **Read them first**, then §1, §2 and your stream's part of §3. Visual
reference: the mockups `~/.cache/wb-tmp/mockups/desk-calm-glance/` — `index.html` (the four states), `topbar.html` (the
top bar in every state) and `settings.html` (Settings → Screen; `settings-wide.png` is the wide window). Open them with
Playwright (`node ~/.cache/wb-tmp/mockups/shootcheck/wide.mjs <html> <png> <width>`) — they are the target for layout
and copy; the real tokens, fonts and components of each app win over the mockups' approximations.

The contracts are done (branch `desk-glance`, commits `4f3bf3a90` and after): read these files before anything else —

- `packages/core/src/domain/desk-glance.ts` — the choices (`DeskShow`, `DeskShowPatch`, `applyDeskShowPatch`,
  `deskShowLevel`, defaults), Settings' list item (`DeskShowOption`), the calm glance's shapes (`DeskCalm`, `DeskHero`,
  `DeskAlso`, `DeskMoment`, `DeskStripServer`, `DeskDigest`, `DeskHeadline`), `DeskPreview`, the limits and constants.
- `packages/core/src/domain/desk-calm.ts` — **the planner**: `deskCalm(input, show, view, words)` decides everything
  the calm glance shows from a `DeskCalmInput`; `deskCalmFor` with the desk's words; `deskPreviewInput` for Settings'
  scenarios. The runtime gathers the input; it never re-decides what the planner decides. Tests: `desk-calm.test.ts`.
- `packages/core/src/domain/desk.ts` — `DeskSettings.show`, `DeskSettingsPatch.show`, `applyDeskSettingsPatch`,
  `DeskScreen.showOptions` / `whombatName`, `DESK_WORDS.calm` (the screen's words) and `DESK_WORDS.settings.tab`… (the
  Screen tab's words; every visible word comes from there).
- `packages/protocol/src/session/desk.ts` + `operations.ts` — the session ops `desk.preview`, `desk.tryOnScreen`,
  `desk.setName`.
- `packages/control-contracts/src/local/desk.ts` — the desk socket: `DeskGlance.calm`, `DeskState.name`.
- `packages/client/src/desk/` — `DeskApi.preview/tryOnScreen/setName`, `useDeskPreview`, the fake world
  (`fakeWorld.ts`, used by `createFakeDesk`).
- `apps/server/src/desk/calm-sources.ts` — the runtime's data sources behind an interface (a stub that returns
  nothing; stream S2 fills it).

| Stream | Where | Ids |
|---|---|---|
| S1 runtime: settings, glance, ops, Welcome back | Whombat, your worktree | DK-S120…DK-S139 (`desk-display-server.md`), migration `0010` |
| S2 runtime: the data sources | Whombat, your worktree | DK-S140…DK-S159 (`desk-display-server.md`) |
| W web: Settings → Screen | Whombat, your worktree | AP-5830…AP-5859 (`docs/app/decisions/desk-display-web.md`) |
| M phone: Settings → Screen | Whombat, your worktree | AP-5860…AP-5879 (`docs/app/decisions/desk-display-android.md`) |
| P console (the lead) | appliance | CG-350…CG-399 |

## 1. Rules for every stream

- Start: your worktree is a checkout of `main`; first `git merge --ff-only desk-glance` (a local branch with the
  contracts). Work only in your worktree; commit small and often (`server: …`, `web: …`, `mobile: …`, `docs: …`), each
  message ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. **Never push, never merge into `main`,
  never touch `~/Code/Whombat` or `~/Code/whombat-appliance`** (other sessions work there), never run `dev/candidate`,
  `pnpm contracts:release` or any release.
- **Don't change the contracts** (`packages/core`, `protocol`, `control-contracts`) or `packages/client/src/desk`
  unless your stream says so. If you need a contract change, stop and say exactly what and why in your final report;
  small additions to `DESK_WORDS` for words you need are fine (keep the style: plain, curly quotes, no ids).
- Search only inside your worktree (and the mockup folder above); never `find`/`grep` over `/` or `$HOME`.
- Node 24: `export PATH=/home/me/.local/share/mise/installs/node/24.18.0/bin:$PATH`; `export
  TMPDIR=/home/me/.cache/wb-tmp`. `pnpm install --frozen-lockfile` once.
- **DEV fast**: run single test files while you work; at the end `pnpm format`, then `pnpm check` once (S1, S2 also
  `pnpm test:server` once). No VM, no CI, no candidate. Shared Postgres :55432 only through the tests' throwaway
  databases; never stop or reset shared containers.
- **Tests** (`docs/decisions/test-speed.md`): unit-test logic; fakes in process, clocks injected, never sleep. Check
  facts (keys, ids, a short phrase), never long literal text. A new `*.int.test.ts` needs a reason to need Postgres.
- **Words**: everything a person reads comes from `DESK_WORDS` (core). Copy is plain English (see `CLAUDE.md`
  “Agents and automations talk like people”). Code comments say why, without decision codes.
- Record decisions you take in your stream's decision file under your ids (one short paragraph each, “*Why:*”).
- Finish with a report: your branch name and head SHA, what you built, what you couldn't verify, any contract change
  you'd want, and anything another stream must know.

## 2. How it fits

```
Settings → Screen (web W, phone M) ──desk.update {show} / desk.preview / desk.tryOnScreen / desk.setName──▶ runtime (S1)
runtime: DeskCalmInput (Home's asks, looks, work, servers + sources S2) ──deskCalmFor(input, show, view)──▶ DeskCalm
runtime ──DeskState.glance.calm, DeskState.name──▶ console server (Go, passes) ──▶ the screen's page (P)
```

The planner in core decides; the runtime only gathers and trims by the lock (`view`): `everything` unlocked, else the
person's *While locked it shows*. The old glance members keep being filled for an older console (DK-125).

## 3. Streams

### S1 — runtime: settings, the calm glance, the ops, Welcome back (`apps/server/src/desk/`)

1. **Keep the choices.** Migration `0010` (check `apps/server/src/db/migrations/` and `meta/` for the numbering and
   journal; `compat.json` if the repo wants it): `desk_screens.show jsonb not null default '{}'` and
   `desk_display.whombat_name text` (the box's, so it outlives an unpairing). `settingsOf` reads `show` through
   `DeskShow.parse` (bad or old JSON → defaults); `updateDesk` uses `applyDeskSettingsPatch`. A server id in
   `show.order` or a key in `items` for something gone stays harmless (the planner ignores it).
2. **`desk.setName`**: one commit storing the name (trimmed, `DeskWhombatName`); `DeskScreen.whombatName`; the desk
   state's `name` (`DeskState.name`) whenever one is stored; emits `desk.changed`.
3. **`DeskScreen.showOptions`** (only while paired, DK-106): `work`, `coming`; each connection and device the person
   sees (Home's things, `connection:<id>` / `device:<id>`, `name`, `mark` = its catalog id where it's a brand slug,
   `line` = `sources.activityLine(catalogId)` or the thing's line, `activity` = a line exists); each Home widget
   (`widget:<id>`, its title, its latest value as `line`); each server of the fleet (`server:<id>`, its name, OS mark,
   a short line like “Proxmox · 16 cores” from the hosts row) in the strip's order (`show.order` first, then worst
   first, then by name); `box`. Keep it cheap: read once per `desk.get`, things and fleet in parallel.
4. **The calm glance** (`calm.ts`, new): `deskCalmInput(full, sources, …)` builds `DeskCalmInput` from `FullGlance`
   (extend `buildFullGlance` as needed): asks (`full.asks` number + title, `askCount`), looks (`full.looks` +
   `runsOn` for a down server and `disk {pct, days}` for a server whose disk is ≥ 85 % — from `sources`), work (the
   working task's title/steps + `doing`), servers from the fleet's cards (id, name, mark, state, note, cpu, memory,
   disk, `spark` from `sources.sparks`, `updating` when the note says so), activities (`sources.activities`), figures
   from Home widgets (`widget:<id>`, value, `active: false`), coming (`sources.coming` within 24 h), services (count of
   connections and devices), doneCount (today's done, all of them), digest (5), update (`sources.update()`). Then
   `deskCalmFor(input, settings.show, view)` → `glance.calm` in `trimGlance`'s answer. Cache the sources' slow reads
   (sparks 60 s, disk days 10 min, runsOn per down server 60 s) so a glance build stays as cheap as today's.
5. **Welcome back** (DK-120…DK-122): track when someone was last at the screen (a touch request, `presence.here`). When
   someone comes back after ≥ `DESK_WELCOME_AWAY_S` and the person keeps *Welcome back* on, build a `DeskDigest` (new
   id): asks waiting (first; `ask` number, the title; in *A summary* `asksCount`-style counts), done items since they
   left (`doneRecently` after the time), looks that began or ended while away when you can tell (server state changes
   you saw in your own last glances are enough). Nothing to say: no digest. Keep it in the glance for
   `DESK_WELCOME_SHOW_S` or until the next touch after it showed, then drop it.
6. **`desk.preview`** (read): the calm glance for `input.show ?? settings.show`, `deskPreviewInput(…, scenario)`,
   view `everything`, `name` = stored whombat name ?? burrow name. Not paired: `not_paired`. **`desk.tryOnScreen`**:
   hold that preview's calm with `sample: {scenario, until}` for `DESK_TRY_S` (memory only; a restart ends it); the
   desk state's `glance.calm` is the sample while it lasts; a touch on the screen ends it.
7. Register the three ops where the other `desk.*` ops are (feature, channel, handler), realtime `desk.changed` after a
   `show` change and `setName`. Keep every old glance member as it is.
8. Tests: unit tests for `calm.ts` gathering (fake sources), digest timing (injected clock), preview/try; extend
   `desk.int.test.ts` only where Postgres is the point (the migration, `show` round trip, `setName`).

### S2 — runtime: the data sources (`apps/server/src/desk/calm-sources.ts`, connection kinds)

Fill `createDeskCalmSources(services)` (keep the interface as it is; if it must change, say so in your report):

1. **Activity** — add `activity?: {active: boolean; value: string; detail?: string; progress?: number}` to
   `ConnectionGlance` (`apps/server/src/home/types.ts`) and to the kinds' seen glance (`things/kinds/registry.ts`,
   `seenFromView`), written by the health pass. Fill it for **Plex** (viewers: “2 watching”/“Nobody watching”, detail
   the titles playing when known, active when anyone watches), **SABnzbd** (the queue: “3 left · 20 min”, progress done
   of the queue, active when the queue isn't empty and not paused; paused says so), **Seerr/Overseerr** (pending
   requests: “2 new requests”, active when > 0) and the ***arr** kinds where they know their queue (“1 downloading”).
   Words short and plain, numbers with plain spaces. `activities()` returns the person's visible connections (and
   devices) that have an activity, keyed as Home's things, `mark` the catalog id; `activityLine()` the kind's
   Settings line (“Who’s watching”, “The queue and time left”, “New requests”, “What’s downloading”).
2. **Coming** — the automations' next runs (`automations/store.ts` `nextRunAt`) within the window, soonest first, named
   by the automation's title; enabled ones the person sees only.
3. **Sparks** — each server's processor over the last hour from the hosts service's series (see how
   `desk/server-page.ts` reads `hosts.series`), downsampled to ≤ 30 whole-percent points; one read per server per
   minute at most (cache), never slowing the glance: on a timeout return what you have.
4. **Disk days** — at the server's disk use rate over the last 7 days (the hosts series), days until full; null when
   not growing or too little data. There may be a forecast helper already (`things/` uses one for a connection's
   machine); reuse it.
5. **runsOn** — a server's running guests' names from the hosts service's server read.
6. **update** — the manager's update journal (find how the runtime reads `UpdateFacts` / `appliance.status`):
   `installing` while it activates a release, `restarting` while it restarts into it, `downloading` while it fetches
   one; else null. If the runtime can't know, return null and say so.
7. Tests per source with fixtures (the kinds have fixture folders); no network.

### W — web: Settings → Screen (`apps/web`)

1. **The tab** (DK-123): `screen` in `SettingsTab` (routing), between Connections and This Whombat, shown only where the
   desk section would show (`deskSectionShown`). Top: the switch *Show Whombat on this screen* with the screen line;
   then the sub-tabs (the Agent tab's segmented style) *What it shows* · *Lock and PIN* · *Night* · *Talk*. Move the
   existing rows of `features/desk/DeskSection.tsx` into the last three (PIN, While locked it shows, Lock again, camera
   → Lock and PIN; quiet hours, At night, Use the camera to see when you’re here → Night; Talk, Voice → Talk). This
   Whombat → Overview keeps one row “Screen settings ›” that opens the tab (and the unlock request row stays where it
   is). Deep links that pointed at the old section go to the tab.
2. **What it shows** (only where `showOptions` is present; else just the other parts): the preview card (sticky beside
   the choices on wide windows ≥ 1100 px, on top when narrow), *Top bar*, *The middle*, *Servers*, *Around it*, as
   `settings.html`. One segmented control *Always · When it matters · Off* everywhere; remote help and camera shown as
   fixed *Always* with a lock. Servers: drag to reorder (pointer), plus *Move up* / *Move down* buttons for keyboard and
   touch (accessible names from `DESK_WORDS.settings.moveUp`); order saved as `show.order`. A choice saves at once
   (`desk.update {show: …}`, shown before the answer, put back when refused).
3. **The preview** (DK-123): `useDeskPreview(api, {scenario, show})` with the page's current `show`; scenario chips
   *Now* · *Something’s wrong* · *{assistant} at work*; draw `DeskPreview` with a `DeskPreviewScreen` component — the
   calm glance at 1280×800 design size, scaled to the card: top bar (name, quiet chips), clock, the sentence, hero or
   moments, strip with sparklines — in the desk's dark look (render it inside the dark theme, `data-theme="dark"`, so
   tokens resolve dark; fixed colours only for the status dots). *Try “…” on the screen* → `tryOnScreen`, then “On the
   screen for a minute.” for a minute.
4. **The name** (DK-119): wherever the app knows the current Whombat's directory name (the managed switcher's list in
   `packages/client/src/managed`), when Settings → Screen or This Whombat opens and `DeskScreen.whombatName` differs,
   call `setName`; after *Rename* of the current Whombat too. Only on the managed app (a box session).
5. Fixtures: the web's fixture mode and the managed fake world already get the fake desk (`createFakeDesk`, now with the
   mockups' world); make sure the Screen tab shows there. Visual check: `pnpm visual` style shots of the tab (both
   themes, 1440×900 and a narrow width); compare with `settings.html`/`settings-wide.png`. Unit tests for the pure parts
   (the order moves, which parts show, the name sync decision).

### M — phone: Settings → Screen (`apps/mobile`)

The same as W on the phone, the phone's way: a *Screen* page in Settings (`src/settings/SettingsPages.tsx`; today the
screen's rows are `src/managed/DeskSection.tsx`) only where the screen shows, with the four parts as sections or
sub-pages the phone's settings already use, the preview on top (a React Native drawing of `DeskPreview`, scaled to the
width; the dark look), the same choices (a segmented control with three options; 44 px targets), servers ordered with
*Move up* / *Move down* (drag optional), *Try it on the screen*. The name sync (DK-119) where the phone knows the
current Whombat's name. Use `@whombat/client/desk/react`'s hooks. Check it in the phone's demo world (the fake desk)
with the repo's mobile screenshot tooling if there is one (`apps/mobile/README.md`); unit tests for pure parts.
Bump nothing (the lead bumps the app's version when shipping).

### P — the screen's page (appliance `console/ui`, the lead)

The calm glance on the screen: top bar, sentence, hero/also, moments, strip, Welcome back, Try-it banner, status sheet;
vendoring contracts 3.2.0; the console server passes `calm` and `name`.
