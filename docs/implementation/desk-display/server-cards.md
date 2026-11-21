# Server cards three to a row, and a server's own screen — build brief (2026-10-21)

Decisions: `docs/decisions/desk-display.md` **DK-80…DK-89** (section “Server cards three to a row, and a server's own
screen”), on top of DK-01…DK-79 and `desk-display-server.md` DK-S01…DK-S75. **Read them first**, then §1, §2 and your
stream's part of §3. The mockups are the visual reference: appliance `docs/design/desk-servers/frame1.png` (the glance)
and `frame2.png` (a server's screen), source `index.html` beside them. Sizes, spacing, type and colours come from there
and from the surrounding console CSS (`console/ui/src/desk/desk.module.css`); the mockup's CSS block is written in the
console's own values. The closest relatives: `desk-fit` (the planner, CG-135…CG-142) and This Whombat's panel
(`console/ui/src/desk/Box.tsx`, CG-57…), whose chart, figures and block bars the server's screen reuses.

| Stream | Repo | Worktree | Branch | Ids |
|---|---|---|---|---|
| C contracts | whombat-contracts | `~/Code/.wt/contracts-desk-servers` | `desk-servers` | 0.115.0, CT-860…CT-879 |
| S server | Whombat | `~/Code/.wt/whombat-desk-servers` | `desk-servers` | DK-S80…DK-S99 (`desk-display-server.md`); no migration |
| P console | the appliance | `~/Code/.wt/appliance-desk-servers` | `desk-servers` | CG-250…CG-279 (`console-gui.md`) |

No whombat-app change. Contracts 0.114.0 (the crew rename, peer *whombat-e9*) is on contracts main; 0.115.0 is built on
it. The peer's runtime change (names: the assistant crew is now Neo, Dusty, Banjo, Hazel, Skipper; migration 0131) lands
on Whombat main within hours; S merges main before the lead lands it. Fixtures and examples use the runtime's assistant
name, never a hard-coded “Dusty” (the mockups say Dusty; read it as `{assistant}`).

## 1. Rules for every stream

- Work only in your worktree on your branch; commit small and often (`contracts: …`, `server: …`, `console: …`,
  `docs: …`), every message ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never push, never
  merge into `main`, never touch the main checkouts (`~/Code/Whombat`, `~/Code/whombat-contracts`,
  `~/Code/whombat-appliance`, `~/Code/whombat-app`): other sessions work there.
- Node 24: `export PATH=/home/me/.local/share/mise/installs/node/24.18.0/bin:$PATH`; `export
  TMPDIR=/home/me/.cache/wb-tmp` (host `/tmp` runs out of inodes). Nix needs `--extra-experimental-features
  'nix-command flakes'`.
- **DEV fast** (John's rule): one quick check at the end — `pnpm format` then `pnpm check` (contracts: also `pnpm
  gen:check` and `pnpm test:go`; appliance Go: `go vet ./... && go test ./...` in the modules you touched; `console/ui`:
  `pnpm check` there), plus `pnpm test:server` once (S). Run single test files while you work. No VM gates, no CI
  waits, no candidate. Own ports (S 4582) and throwaway databases; the shared Postgres :55432 and Mailpit are never
  stopped or reset. Temporary containers or VMs only through `/usr/local/bin/agent-resource` (read
  `/home/me/Code/dashboard/docs/agent-resources.md` first), and release what you lease.
- **Never touch John's real servers, services or DEV box** from tests or scripts. Fixtures stand in for the hosts
  service.
- **Tests** (`docs/decisions/test-speed.md`): unit-test logic; fakes in process, clocks injected, never sleep. A new
  `*.int.test.ts` needs a reason to need Postgres. Check facts (ids, codes, a key phrase), never long literal text.
- **Copy**: the contracts' `DESK_WORDS` are the words (curly quotes ’ “ ”, `·`, `−`). Short, plain, a colleague's words
  (`docs/decisions/concise-replies.md`). The assistant's name always from the runtime.
- **Tokens only** for UI colours/fonts/radii (brand marks keep their own colours as the glance draws them today); match
  the surrounding code's style, naming and comment density.
- Record your own decisions in your stream's file: contracts `docs/decisions/contracts.md` (CT-860…); Whombat
  `docs/decisions/desk-display-server.md` (S, DK-S80…); appliance `docs/decisions/console-gui.md` (P, CG-250…).
- **Contracts flow**: C builds a provisional `dist-release/0.115.0` in its worktree and tells the lead; the lead tells S
  and P to vendor it. Until then S and P build what doesn't need the new types (read the code, the layout, the planner,
  the Go handlers' shape, the page's scenes) against §2 below. A contract change you need: message the lead with the
  exact additive change; never edit vendored files.
- When done: the quick check green, everything committed, a short report (what you built, what you decided, what is
  left, what the lead must check live). Don't wait for anything after that.

## 2. The wire (contracts 0.115.0, all additive)

`@whombat/control-contracts/local` (`packages/control-contracts/src/local/desk.ts`; Go `local` generated the same):

```ts
DESK_PATHS.servers = '/v1/desk/servers'   // POST DeskRequest → DeskServersAnswer (DK-86)
DESK_PATHS.server  = '/v1/desk/server'    // POST DeskServerRequest → DeskServerPage (DK-83)

DeskServer += {
  id: Id.optional(),            // the hosts service's server id: the card opens (DK-83); absent from older runtimes
  disk: DeskMeter.optional(),   // % of its storage in use, DESK_BOX_TONES.storage colours (DK-80)
}

DESK_SERVERS = 24
DeskServersAnswer = { v: 1, servers: DeskServer[] (≤ DESK_SERVERS, worst first, the glance's order), more: Count }

DESK_SERVER_RANGES = ['1h', '24h', '7d'] as const; DeskServerRange
DeskServerRequest = strict { v: 1, id: Id, range: DeskServerRange }

DESK_SERVER_POINTS = 96; DESK_SERVER_VOLUMES = 6; DESK_SERVER_GUESTS = 6; DESK_SERVER_ALERTS = 3
DESK_SERVER_MAX_BYTES = 32_768          // the console server reads no more
DESK_GUEST_STATES = ['running', 'stopped', 'unhealthy', 'paused']; DeskGuestState

DeskServerPage = {
  v: 1,
  now: Rfc3339,
  server: DeskServer,                // the card's own shape, with the id asked for
  os: text(60, 0),                   // “Proxmox VE 9.0.10”; empty when not known
  up: text(40, 0),                   // “up 41 d”; empty when off or not known
  cpu: { percent: Pct, cores: int 1…4096 | null, load: text(8, 0) /* “2.9”, empty unknown */, tone } | null,
  memory: { percent: Pct, used: DeskFigure /* “69” “GB” */, total: text(16) /* “128 GB” */, tone } | null,
  disk: { percent: Pct, used: text(16) /* “1.2 TB” */, total: text(16), tone } | null,
  temp: { value: int °C, limit: int °C, tone } | null,
  history: {
    range: DeskServerRange,
    stepS: int 1…86400,              // one point per stepS, ending now, oldest first
    cpu: (Pct | null)[] ≤ DESK_SERVER_POINTS,
    memory: (Pct | null)[] ≤ DESK_SERVER_POINTS,   // the same length as cpu
    cpuPeak: { percent: Pct, at: Rfc3339 } | null,
    memoryAvg: Pct | null,
  },
  volumes: { name: text(40), note: text(40, 0) /* “nvme mirror”, “on nas” */, percent: Pct, used: text(16),
             total: text(16), tone }[] ≤ DESK_SERVER_VOLUMES,
  guests: { running: Count, off: Count,
            items: { name: text(60), kind: 'vm' | 'container', state: DeskGuestState, cpu: Pct | null,
                     memory: text(16, 0) /* “6.1 GB”, empty when off */ }[] ≤ DESK_SERVER_GUESTS } | null,  // null: no guests
  network: { down: text(16), up: text(16) } | null,     // per second, “24 MB/s”, as DeskBox.network
  alerts: { count: Count, items: { tone: 'warn' | 'bad', title: text(120) }[] ≤ DESK_SERVER_ALERTS },
}
deskServerPageValid(p): history's two series the same length; alerts.items ≤ count; guests.items ≤ running + off;
                        the page's server.id equal to the id asked (checked by the console server, which knows it)

DeskTalkRequest += { server: Id.optional() }   // Ask {assistant} about {server} (DK-85)
```

Errors on the new paths are the socket's existing codes: `not_paired`, `not_found` (no such server in the fleet),
`locked` (*Only the time* while locked: no server screen, DK-84), `unavailable` (the hosts service didn't answer),
`bad_request`. `SESSION_API_LEVEL` doesn't change (no session op changes).

`@whombat/core` (`packages/core/src/domain/desk.ts`) `DESK_WORDS`, new keys (C words them finally; these are the
mockups' words):

```ts
card: { cpu: 'CPU', memory: 'MEM', disk: 'DISK', none: '–', open: 'Open {name}' },  // DK-80; `open` the button's label
hot: 'hot · {n}°',                                   // the runtime's note for a hot server (DK-81)
servers: { title: 'Servers', more: '{n} more in Whombat' },   // DK-86; “+N more” stays `moreServers`
server: {
  back: 'Back', allFine: 'All fine', cores: '{n} cores',
  cpu: 'CPU', load: 'load {n}', memory: 'Memory', memoryOf: 'of {total}', disk: 'Disk', diskOf: '{used} of {total}',
  temperature: 'Temperature', tempNote: '{tone} · limit {n}°',  // tones: box.tones (cool, warm, hot)
  ranges: { '1h': 'Last hour', '24h': 'Last 24 hours', '7d': 'Last 7 days' },
  rangeChips: { '1h': '1 h', '24h': '24 h', '7d': '7 d' },
  cpuPeak: 'CPU · peak {n} % at {time}', memoryAvg: 'Memory · avg {n} %',
  storage: 'Storage', guests: 'Guests', guestsCount: '{running} running · {off} off',
  alertsOne: '1 thing to look at', alertsMany: '{n} things to look at',
  ask: 'Ask {assistant} about {server}',
  off: '{server} is off.', unavailable: 'I can’t reach your servers right now.', noFigures: 'No figures yet.',
}
// the network line and the chart's scale reuse box.network and box.scale
```

## 3. The streams

### C — contracts (`packages/control-contracts`, `packages/core`, `go`, `schema`, `vectors`)

1. Version 0.115.0 for the packages that change (follow how 0.114.0 / 0.110.0 bumped; `git log --grep 0.110.0`).
2. §2 exactly, with doc comments in the file's voice (“(0.115, CT-86x; DK-8x)”), the old members' comments untouched.
   `deskServerPageValid` in TS and its Go twin beside `DeskStateValid`'s (`go/local/desk.go`), both tested.
3. `pnpm gen` (Go types and parsers, JSON schema), vectors for `DeskServer` with and without the new members,
   `DeskServerPage` (a full one, a minimal off one), `DeskServersAnswer`, `DeskTalkRequest` with `server`, and refused
   ones (a series longer than 96, unequal series, an unknown range, more alert items than the count).
4. Decisions CT-860… in `docs/decisions/contracts.md`; the changelog/README where earlier releases noted theirs.
5. `pnpm check`, `pnpm gen:check`, `pnpm test:go`; build `dist-release/0.115.0` the way 0.114.0 was built (its
   `SHA256SUMS`, the tarballs, contracts-go). Report the dist path. Don't tag or push; the lead does.

### S — the runtime (`apps/server/src/desk/*`)

1. **Vendor** contracts 0.115.0 when the lead says (`~/.cache/wb-tmp/vendor-contracts.sh <worktree> 0.114.0 0.115.0
   <dist>` if main already vendors 0.114.0, else from the version main has; then `pnpm install`; commit `deps: @whombat
   contracts 0.115.0 (…)` with the lockfile). Main moves to 0.114.0 with the crew change: merge main into your branch
   when it lands and keep 0.115.0.
2. **The card** (`glance.ts` `deskServer`, DK-80, DK-81): `id` = the server's id; `disk` from `storage.usedPct` with
   `DESK_BOX_TONES.storage`; keep `temp` (older consoles draw it; the page uses it). Hot: the temperature's tone (the
   one `temp` gets today) warn or bad → when the state is `ok`, the state becomes that tone and the note
   `DESK_WORDS.hot` (“hot · 84°”); a `warn` server with a `bad` temperature becomes `bad` and keeps its note; `off` and
   `bad` are left alone. `sortServers` and `worstOf` then see it (DK-S08).
3. **`/v1/desk/servers`** (`socket.ts`, the service): paired only (`not_paired`); locked in *Only the time* → `locked`;
   else every server of the fleet as cards, sorted, the first `DESK_SERVERS`, `more` the rest. The fleet call fails →
   `unavailable` (503).
4. **`/v1/desk/server`** (a new `desk/server-page.ts`, pure builder + a thin fetch in the service): the same lock rules;
   the id must be a fleet server (`not_found`). Fetch in parallel what `hosts/routes.ts` `getServer` and
   `serverMetrics` fetch (the detail with `range`, `metrics` with `range` and the series `cpu_pct,mem_pct` plus the
   network's), the server's guests (the way the hosts routes list a server's guests) and its open alerts
   (`openAlertsRaw`, by `serverId`), through the mappers in `hosts/map.ts` (`toHostServerDetail`, `toHostSeries`, …), so
   the shapes are the contract's. Build: the card (`deskServer` of the fleet row), `os` (name + version), `up`
   (`uptimeNote`), `cpu` (cores from the detail, load the first `loadAvg` with one decimal), `memory` and `disk` (the
   figures and units as `deskBox` writes them, `DESK_BOX_TONES`), `temp` (hottest sensor and its limit, the card's
   tones), `history` (downsample to at most 96 points by averaging buckets; `stepS` the bucket; `cpuPeak` the highest
   point with its time, `memoryAvg` the mean, both null without points), `volumes` (Proxmox storages, else the disks
   with used/capacity, else unRAID's; fullest first, ≤ 6), `guests` (null when the server has no guests; `running` and
   `off` counts; items running first, busiest CPU first, ≤ 6), `network` (the latest point of the net series, as
   `deskBox` formats it), `alerts` (count; items worst first, ≤ 3, **only when unlocked or the locked view is
   *Everything***, DK-84). Every string through `screenText`/`deskText` to its contract length. An off server: the
   card, `os`, empty `up`, null figures, the history it has. Outside production check the answer with
   `deskServerPageValid` as `talkSession` does.
5. **Ask about a server** (`talk.ts`, DK-85): `DeskTalkRequest.server` naming a fleet server → the talk's `thing` is
   that server's card, and the assistant's turn gets one instruction line saying the person asked from the desk screen
   while looking at that server (its name and id), so “it” means that server. Never in the chat, never in the person's
   words. An unknown id: the talk goes on without it.
6. Tests (unit, fixtures of the hosts service's raw answers): `deskServer`'s disk and hot rules; the builder (a Proxmox
   server with storages and guests, a plain Linux server with disks and no guests, an off server, the downsample and its
   peak/average, alert titles trimmed when locked in *A summary* and kept with *Everything* or unlocked); the socket's
   two paths (paired, locked *Only the time*, unknown id, hosts down); the talk with `server`. `pnpm test:server` once
   at the end.
7. Decisions DK-S80… in `desk-display-server.md` (what you chose where this brief leaves room: the volume source per
   platform, the guest list's call, the downsample).

### P — the console page and its server (`console/internal`, `console/ui`)

1. **Vendor** contracts 0.115.0 when the lead says: contracts-go (`third_party/whombat-contracts-go`, `go.mod`, the
   Nix `vendorHash` in `nix/packages/go.nix`) and `console/ui/vendor/whombat-contracts/` (the page's copies; follow
   the last vendoring, `git log --grep 'contracts-go 0.110.0'` and the commits around it).
2. **The console server** (`console/internal/desk`, `consoleapi`): `Servers(ctx)` and `Server(ctx, id, range)` on the
   desk client (`ValidID`, the range enum, `DESK_SERVER_MAX_BYTES`, the generated parsers, `DeskServerPageValid` and
   the page's `server.id` equal to the id asked, else no page); `Talk` passes `server` (valid id or absent). Routes
   `POST /api/desk/servers` and `POST /api/desk/server` (`{id, range}`) in `consoleapi.go` beside `talk/get`; the talk
   route takes `server`. Tests as the other desk routes have.
3. **The card** (`desk/parts.tsx` `ServerCard`, `Segments`; CSS per mockup frame 1): the head as today; three lines
   `CPU`/`MEM`/`DISK` (`DESK_WORDS.card`): the label (mono 11.5px, muted, letter-spaced), `Segments` with **20** blocks
   (7px tall, 2px gaps, the tones as today), the value right-aligned (600 15px, tabular figures); no disk → the line
   with an empty bar and `card.none`. The card is a real `<button>` (focus ring, `aria-label` with the name and the
   three figures, `card.open`) when the server has an `id`, else the same card as a `div`. This Whombat's card
   (`Box.tsx`, DK-87) gets the same three lines from `DeskBox` (cpu, memory, storage percents and tones).
4. **The planner** (`lib/deskFit.ts`, its test reading the stylesheet; DK-82): servers three to a row and up to three
   rows (This Whombat's card counts as a server card), tiles four to a row and up to two rows as before; the new card
   height from the CSS; every server card a third of the width, rows filled from the left (DK-82 replaces DK-40's
   sharing for servers only). Every other rule of DK-38/CG-135… unchanged (fewest left out, the panel preferred, fewer
   rows, Found's strip). Check the shots: 1, 2, 3, 5, 8 servers; with and without tiles; with Working on showing; on
   battery.
5. **Scenes** (`desk/Desk.tsx`, `lib/deskScene.ts` or beside it, pure and tested):
   - `server` (a new `desk/Server.tsx`, mockup frame 2): opened by a card, with the list it was opened from (the
     glance's servers in their order, or the Servers list) and the index. Fetches `/api/desk/server` with `24h` at open,
     then every 10 s, and at once on a range chip. Layout as frame 2: header (back button 44px, mark tile 40px, name
     mono 24px, `os · {cores} · up` muted; on the right the state, “All fine” with a green dot or the card's note in its
     tone, and the lock chip), four figure cards (This Whombat's `.fig` look: key, note, big value, a **24**-block bar
     10px tall), the chart card (This Whombat's chart component, CPU green + memory brand, the scale lines, the range
     control's three chips as 36px buttons inside a 44px-high hit area, the foot's times), the side column (Storage:
     name, note · %, a 30-block bar per volume; Guests: count line, rows with a state dot, name, CPU %, memory), the
     footer (the network line, the dots, the Ask button). Alerts: when `count > 0` the header's state says
     `alertsOne`/`alertsMany` in amber or red and, when items came, they show as a line each between the figures and the
     chart (at most 3; the chart gives up the room). Off: the figures show “–” and `server.off` replaces the chart.
     Unavailable: keep the last page and say `server.unavailable` under the header (no blank screen). Loading: the card's
     figures in the four figure cards while the first answer comes (no spinner).
   - Swipe (pointer down/up with a horizontal move over 60px, no motion when the kiosk has reduced motion) and the dots
     go through the list; the dots are buttons too (44px hit areas).
   - `servers` (`desk/Servers.tsx`, DK-86): `servers.title`, the cards three to a row from `/api/desk/servers`, the rest
     counted (`servers.more`), back; scrolls when it doesn't fit (touch scroll, no scrollbar). Opened by “+N more” (a
     button when the cards have ids).
   - `self` (DK-87): This Whombat's panel at full size (`Box.tsx`'s panel in a page with the header's back), opened by
     its card or its panel.
   - Rules: a card or “+N more” on a **locked** glance opens these scenes, not the PIN pad (DK-84; every other touch on a
     locked glance opens the pad as today). Back, or 2 minutes without a touch, returns to the glance; the idle clock
     and quiet hours work as they do from the glance; a lock into *Only the time* closes them (the runtime answers
     `locked`); an ask that pops up (DK-60) pops over them as over the glance. Unlocked, being on these screens and
     touching them is using the screen (touch as today).
   - Ask (DK-85): `server.ask` with the assistant's name; it opens Talk with the server (unlocked; locked: the PIN pad
     with `next: 'talk'`, as today, keeping the server for the talk). The talk request carries `server`.
6. **Fixtures and shots** (`src/demo/deskFixtures.ts`, the demo): the glance with 1, 2, 5 and 8 servers (+ This
   Whombat's card), with tiles, the Servers list with 12, a Proxmox server's screen (frame 2's figures), a Linux server
   without guests, an off server, alerts locked and unlocked, This Whombat's screen, and an older runtime (no ids, no
   disk). Shots at 1280×800 (the stage) and compare frame 1 and frame 2 side by side; fix differences. Dark is the
   console's only theme (CG-02).
7. Tests: the planner (rows of three, three rows, the new height read from the CSS), the scene rules (open locked,
   back, 2 minutes, *Only the time*, an ask over the page, swipe bounds), the parse of the new shapes (bad page → no
   page, a page for another id refused), the Go client and routes. Decisions CG-250… in `console-gui.md`.

## 4. The lead

C's dist → S and P vendor → reviews → contracts: tag `contracts-v0.115.0`, merge `desk-servers` into contracts main,
push → S merges Whombat main (crew, 0131) and P merges appliance main → Whombat main (no-ff) and appliance main (no-ff),
pushed → `~/Code/whombat-appliance/dev/candidate --minor --hosts <hosts main rev> --what "…" --why "…"` (the
console is in the host image: `--hosts` with the hosts service's current main forces the host release that carries it) → `whombat-dev` updated → John told where to try it (his box's screen; the dev stack has no
screen of its own).
