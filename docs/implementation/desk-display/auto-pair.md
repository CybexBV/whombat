# A screen that works at once — build brief (2026-10-20)

Decisions: `docs/decisions/desk-display.md` **DK-16…DK-25** (section “A screen that works at once”), on top of DK-01…DK-15
and `desk-display-server.md` DK-S01…DK-S26. **Read them first**, then §1, §2 and your stream's part of §3. The visual
reference is the mockup `~/.cache/wb-tmp/mockups/desk-box/index.html` (`frame1.png` dark, `frame2.png` light; it uses
`../desk-display/` for fonts, tokens and images; render with `node ~/.cache/wb-tmp/mockups/shoot-desk.cjs <dir>`). The
earlier desk mockups are appliance `docs/design/desk-display/` (`frame1…4.png`). The mockups win on layout, sizes and
copy, except where DK-* or this brief says otherwise. The earlier brief `assignment.md` beside this file shows how the
desk was built (shapes, socket, page).

| Stream | Repo | Worktree | Branch | Ids |
|---|---|---|---|---|
| C contracts | whombat-contracts | `~/Code/.wt/contracts-desk-auto` | `desk-auto` | CT-538…CT-549, 0.101.0 |
| S server | Whombat | `~/Code/.wt/whombat-desk-auto` | `desk-auto` | DK-S27… (`desk-display-server.md`) |
| A appliance | the appliance | `~/Code/.wt/appliance-desk-auto` | `desk-auto` | MG-72…, CG-57…, NX-200…NX-209 |
| W app | whombat-app | `~/Code/.wt/app-desk-auto` | `desk-auto` | AP-3100…AP-3114 web, AP-3115…AP-3129 Android |

All four branches start from `main`. The lead merges, releases contracts and the app, vendors and ships.

## 1. Rules for every stream

- Work only in your worktree on your branch; commit small and often (`contracts: …`, `server: …`, `manager: …`,
  `console: …`, `nix: …`, `web: …`, `mobile: …`, `client: …`, `docs: …`), every message ending with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never push, never merge into `main`, never touch the main
  checkouts (`~/Code/Whombat`, `~/Code/whombat-app`, `~/Code/whombat-contracts`, `~/Code/whombat-appliance`): other
  sessions work there.
- **Contracts 0.101.0.** C builds them first. S, A and W start at once with what doesn't need the new types, against §2's
  shapes. When the lead says 0.101.0 is released (`~/Code/whombat-contracts/dist-release/0.101.0/`), vendor it in your
  branch yourself, as the last vendoring did: Whombat `d4bacf89`, app `be35d510` (`vendor/whombat-contracts/<v>/`,
  `package.json`, `pnpm-workspace.yaml`, `pnpm install`, commit `deps: @whombat contracts 0.101.0 (…)` with the
  lockfile); appliance `614059f` (`third_party/whombat-contracts-go` from the release's `whombat-contracts-go-0.101.0.tar.gz`,
  `go.mod`, and any Nix `vendorHash` that moves). Need a contract change? Don't edit vendored files: message the lead with
  the exact additive change.
- **DEV fast** (John's rule): one quick check at the end — `pnpm format` then `TMPDIR=~/.cache/wb-tmp pnpm check`
  (appliance Go: `go vet ./... && go test ./...` in the module you touched; console/ui: `pnpm check` there; Nix: the
  `nix build`/`nix flake check` attributes named in your §3), plus `pnpm test:server` once (S). Run single test files
  while you work. No VM gates, no CI waits, no waiting for future data. Own ports (S 4530, W 4534/5234) and throwaway
  databases; the shared `docker compose` (Postgres :55432, Mailpit) is never stopped or reset. `/tmp` runs out of inodes:
  `TMPDIR=~/.cache/wb-tmp`. Nix needs `--extra-experimental-features 'nix-command flakes'`. Temporary containers or VMs
  only through `/usr/local/bin/agent-resource` (read `/home/me/Code/dashboard/docs/agent-resources.md` first), and
  release what you lease.
- **Android emulator** (W): the AVD `whombat-mobile` is shared; run your own read-only instance on port 5620
  (`emulator -avd whombat-mobile -port 5620 -read-only -no-window -no-audio -no-boot-anim -gpu swiftshader_indirect`) and
  `adb -s emulator-5620 emu kill` when done. See `apps/mobile/README.md`.
- **Never touch John's real servers, services or DEV box** from tests or scripts, never run an installer or a candidate.
  Reading is fine where your §3 says so. The lead does the real ones after the merge.
- **Tests** (`docs/decisions/test-speed.md`): unit-test logic (the EDID reading, what counts as a real screen, when the
  screen pairs itself, the switch, the box's figures and words, the status line); fakes in process. A new
  `*.int.test.ts` needs a reason to need Postgres (an existing desk one can grow). Check facts (ids, codes, a key phrase),
  never long literal text. Inject clocks and short timeouts, never sleep.
- **Copy**: §2's words are the words (curly quotes ’ “ ”, `·`, `…`, `−`, a no-break space before `%` and units as core
  does). The assistant's real name from the runtime, never “Dusty” hard-coded.
- **Tokens only** for UI colours/fonts/radii; match the surrounding code's style and comment density.
- Record your own decisions in your stream's file: Whombat `docs/decisions/desk-display-server.md` (S, DK-S27…);
  appliance `docs/decisions/console-gui.md` (CG-57…), `manager.md` (MG-72…), `nixos.md` (NX-200…); app
  `docs/decisions/desk-display-web.md`, `desk-display-android.md`; C in the contracts notes (CT-538…).
- When done: the quick check green, everything committed, a short report (what you built, what you decided, what is
  left, what the lead must check live). Don't wait for anything after that.

## 2. Wire shapes (0.101.0, all additive)

### `@whombat/core` (`domain/desk.ts`)

```ts
/** The screen as the runtime sees it (DK-16). `connected` is today's `hasDisplay`. */
export const DeskDisplay = z.object({
  connected: z.boolean(),
  /** A real monitor or a built-in panel: connected, not a virtual driver, an EDID not from a virtual maker. */
  real: z.boolean(),
  /** A laptop's own panel (eDP, LVDS, DSI). */
  builtIn: z.boolean(),
  /** The EDID's monitor name (“DELL U2720Q”); null when it names none. Plain text, ≤ 60. */
  name: z.string().min(1).max(60).nullable(),
});

DeskScreen gains (all optional: older runtimes send none):
  display: DeskDisplay.optional(),
  /** The switch now (DK-20): what an owner chose, else `display.real`. */
  on: z.boolean().optional(),
  /** Whether an owner chose (false: the default, DK-20's virtual-screen hint applies when `!display.real`). */
  onChosen: z.boolean().optional(),
  paired.hasPin: z.boolean().optional(),   // false: only the phone unlocks (DK-18); absent: true
  paired.self: z.boolean().optional(),     // it paired itself (DK-17) — or was turned on — rather than by its letters
```

`deskStatusLine` input gains `fresh?: boolean` (no servers, no tiles, nothing needs the person, nothing worked on): in
*A summary* and *Everything* the line is `status.ready` with `status.connectHint` as `more`; *Only the time* unchanged.

A pure builder for the panel, `deskBox(input) → DeskBox` (the control-contracts shape below; C places the type so that
core stays the base package, with a test that `DeskBox.parse(deskBox(sample))` holds), from a structural input that the
manager's `HostMetrics` satisfies: `now` (cpuPermille, cores, memory, `cpuTempC?`, `uptimeS?`), `disks.data` (with
`parts`), the series' points (the last hour, downsampled to one a minute, at most 60, null gaps kept) and the latest
point's in/out bytes over its step. Formatting as Settings → “How it’s doing” does (find its byte formatting; one
decimal under 100, none from 100: “11.2 GB”, “812 GB”, “1.6 TB”; rates “2.4 MB/s”, “310 kB/s”); uptime as the server
cards' notes (“up 2 h 14 min”, “up 41 d”). Tones: processor and memory as the server cards' meters; storage warn ≥ 85 %,
bad ≥ 95 %; temperature warn ≥ 80 °C, bad ≥ 90 °C (DK-24).

`DESK_WORDS` additions (keys and words exact):

```ts
status.ready: 'All fine. I’m ready when you are.'
status.connectHint: 'Connect a server or your home, and I’ll keep an eye on it here.'
nothingNeedsYou: 'Nothing needs you.'
nothingNeedsYouHint: 'When I need a decision, it shows here.'
noPinYet: 'Choose a PIN in Settings to unlock here.'
box: {
  title: 'This Whombat',
  lastHour: 'Last hour',
  processor: 'Processor · {n} cores',
  memory: 'Memory · of {total}',
  storage: 'Storage',
  free: '{unit} free',            // “812” big, “GB free” small
  used: '{n} % used',             // no-break space before %
  ofTotal: 'of {total}',
  temperature: 'Temperature',
  tempNote: 'Processor · {tone}',
  tones: { ok: 'cool', warn: 'warm', bad: 'hot' },
  network: 'Network ↓ {down} · ↑ {up}',
  hourAgo: '1 h ago',
  now: 'now',
  scale: '{n} %',
  hint: 'Your servers and home show here once you connect them.',
  parts: { whombat: 'Whombat', agents: 'Agents' },
}
settings.showOnScreen: 'Show Whombat on this screen'
settings.screenNamed: '{name} · connected'
settings.builtIn: 'Built-in screen'
settings.connectedUnnamed: 'A screen is connected'
settings.noScreenNow: 'No screen is connected right now.'
settings.virtualHint: 'This looks like a virtual machine’s screen, so it stays off unless you turn it on.'
settings.offHint: 'When it’s off, the screen shows only the Whombat’s name and goes dark after 10 minutes.'
settings.noPin: 'No PIN yet. Choose one to unlock the screen by touch.'
settings.choosePinButton: 'Choose a PIN'
settings.pairToMe: 'Pair to me instead'
settings.selfPaired: 'I’m on this Whombat’s screen now. To unlock it by touch, choose a PIN in Settings → This Whombat → Screen. You can turn the screen off there too.'
settings.pairedItself: 'The screen paired itself with {name}.'   // the log's words (DK-17)
errors.no_screen: 'No screen is connected to this Whombat.'
errors.no_pin: 'This screen has no PIN yet.'
```

### `@whombat/protocol/session` (`session/desk.ts`)

- `desk.setScreen {on: boolean}` (owners) → `DeskScreen`; mutating, retry by receipt, `destructive: true` (off ends the
  pairing and its PIN), as `desk.unpair`. *On* pairs to the caller (no letters, no PIN) when a screen is connected, else
  `no_screen`; *off* unpairs and keeps it off (DK-20). `desk.unpair` keeps its shape and now means *off* (doc comment).
- `DESK_ERROR_CODES` gain `no_screen` (`conflict`) and `no_pin` (`conflict`, for the console's unlock with a PIN on a
  screen without one; the socket's code, listed here so the words live in one place).
- `HostNow` gains `cpuTempC: z.number().int().min(-50).max(150).optional()` and `uptimeS: z.number().int().min(0).max(10 ** 10).optional()`
  (DK-24). Regenerate the schema, vectors and Go bindings (`pnpm gen`, `gen:check` clean).

### `@whombat/control-contracts/local` (`local/desk.ts`)

```ts
DeskPaired gains  hasPin: z.boolean().optional()   // false: the pad shows only Confirm on your phone (DK-18)

const Pct = z.number().int().min(0).max(100);
/** A figure drawn big with a small unit (“11.2” “GB”). */
export const DeskFigure = z.object({ value: text(8), unit: text(8) });

/** This Whombat while the glance has no servers and no tiles (DK-22). */
export const DeskBox = z.object({
  /** “up 2 h 14 min”; empty when the manager doesn't say. */
  up: text(40, 0),
  cpu: z.object({ percent: Pct, cores: z.number().int().min(1).max(4096), tone: DeskTone }),
  memory: z.object({ percent: Pct, used: DeskFigure, total: text(16), tone: DeskTone }),
  /** The last hour, oldest first, one point per `stepS`, ending now; both the same length; null where nothing was measured. */
  history: z.object({
    stepS: z.number().int().min(1).max(3600),
    cpu: z.array(Pct.nullable()).max(60),
    memory: z.array(Pct.nullable()).max(60),
  }),
  /** The data disk: `percent` used, `free` and `total`; parts in the order whombat, agents, only those measured. */
  storage: z.object({
    percent: Pct,
    free: DeskFigure,
    total: text(16),
    tone: DeskTone,
    parts: z.array(z.object({ key: z.enum(['whombat', 'agents']), value: text(16), percent: Pct })).max(2),
  }),
  /** The processor's, °C; absent without a sensor. */
  temp: DeskMeter.optional(),
  /** Per second over the last step; null when not known. */
  network: z.object({ down: text(16), up: text(16) }).nullable(),
});

DeskGlance gains  box: DeskBox.optional()   // present exactly when shown (DK-22)
```

`deskStateValid` adds: `box` only when the glance has no servers and no tiles, and not while locked with *Only the time*;
`history.cpu.length === history.memory.length`. The page and the Go console treat an absent `box` / `hasPin` as before.

### The desk socket

- `GET /v1/desk/state`: as before, with `paired.hasPin` and `glance.box`.
- `POST /v1/desk/unlock {pin}` on a screen without a PIN → 409 `no_pin`. `unlock/phone` works as before.

## 3. Streams

### C — contracts (`~/Code/.wt/contracts-desk-auto`, branch `desk-auto`)

Everything in §2: core (`DeskDisplay`, the `DeskScreen` additions, `deskStatusLine`'s `fresh`, `deskBox` and its
formatters, `DESK_WORDS`), protocol (`desk.setScreen`, the two error codes, `HostNow`), control-contracts (`DeskFigure`,
`DeskBox`, `DeskGlance.box`, `DeskPaired.hasPin`, `deskStateValid`), generated schema/vectors/Go, tests, the notes for
0.101.0 (CT-538…), version 0.101.0 in every package. `pnpm check`, `pnpm gen:check`, `pnpm test:go`. Don't release or
tag: report, and the lead merges and runs `pnpm release`. Go fast: the other streams wait for this.

### S — server (`~/Code/.wt/whombat-desk-auto`, branch `desk-auto`)

- **The screen** (`desk/hardware.ts`, DK-16): `DisplayProbe` reads every `card*-*` connector: `status`, the card's
  driver (`card<N>/device/driver` and, for virtio, the virtio device under it: on John's DEV box
  `card1/device/driver` → `virtio-pci`), the connector type from the name, `edid` (parse the base block: header,
  checksum, the PNP maker id from bytes 8–9, descriptor 0xFC for the name, else none). Returns `DeskDisplay`. The EDID
  parser is a pure function with unit tests on real bytes: the DEV box's QEMU EDID (base64 on the first line of
  `~/.cache/wb-tmp/devbox-edid.txt`: maker `RHT`, name “QEMU Monitor”), a monitor's and a laptop panel's (build valid
  ones in the test: a `DEL` “DELL U2720Q”, a panel with no 0xFC name on eDP), an empty `edid`, a broken checksum. A test
  directory tree stands in for `/sys/class/drm` (`drmDir` exists already). `hasDisplay` stays (= `connected`).
- **The switch and pairing itself** (DK-17, DK-20, DK-21): a migration (next free number on main — check
  `apps/server/src/db/migrations/meta/_journal.json` on main just before you commit, other sessions add some; tell the
  lead the number) with the owners' choice (a one-row table beside `desk_screens`, e.g. `desk_display (id = 1, on
  boolean null, updated_at)`), `desk_screens.pin_hash` nullable, and the DK-21 back-fill (a box whose last desk event is
  `desk.unpaired` and that has no pairing reads as off). Commands through the pipeline only: `set_desk_screen` (an
  owner; off unpairs in the same transaction; on pairs to the caller without a PIN), a command for pairing itself (no
  PIN; the event's words `DESK_WORDS.settings.pairedItself`, not signed as if the person did it — see how DK-S02 signs
  `desk.paired` and choose what the log should show), `desk.unpair` = off. `pair_desk` (the letters) keeps its PIN.
  The check that pairs itself runs in `DeskService` when the console asks for the state (at most every 10 s) and on the
  minute tick: a desk socket, the switch on (chosen, or not chosen and `display.real`; chosen on: any connected screen),
  nobody paired, a target (the claimer, `appliance_state.claimed_by_account_id`, their person in their oldest burrow with
  an assistant — `#ownerPerson` — else the oldest owner with an assistant; none: try again later), in the service's
  queue (DK-S22). After it pairs itself the person's assistant posts `settings.selfPaired` once in their DM (`tell.ts`).
- **No PIN** (DK-18): `paired.hasPin`; `unlock {pin}` on a screen without a PIN → 409 `no_pin` (no counter moves);
  `desk.setPin` sets the first PIN as it changes one.
- **`desk.setScreen`**, `DeskScreen.display`, `on`, `onChosen`, `paired.hasPin`, `paired.self`.
- **The box** (DK-22): `DeskGlance.box` while the full glance has no servers and no tiles, trimmed away in *Only the
  time*. Read the manager's metrics with the power reading (`power.ts` reads `POST /v1/host/metrics` already: one call,
  every 10 s while the screen is shown, never on the 1 s path; the hour's points once, then `since`), build with core's
  `deskBox`. `deskStatusLine` with `fresh` (DK-23).
- Tests: unit for the probe, the target choice, the box's inclusion/trim; the existing desk int test grows for the
  migration's commands (pair itself, switch off/on, unpair = off, no PIN refused, back-fill). `pnpm test:server` once.
- Decisions DK-S27… in `desk-display-server.md`. Don't vendor the app.

### A — appliance (`~/Code/.wt/appliance-desk-auto`, branch `desk-auto`)

- **Manager** (DK-24, MG-72…): `cpuTempC` from hwmon (`/sys/class/hwmon/hwmon*/name`: `k10temp` its Tctl/Tdie input,
  `coretemp` its “Package id 0”, `zenpower`, else `/sys/class/thermal/thermal_zone*` of type `x86_pkg_temp`,
  `cpu-thermal` or `acpitz`), whole °C, absent when none; `uptimeS` from `/proc/uptime`; both in `HostNow` (the generated
  types once 0.101.0 is vendored). Tests with a fake sysfs tree. Check the manager's unit can read `/sys/class/hwmon`
  and `/sys/class/thermal` (its sandbox in `nix/modules/`); a change there is NX-200….
- **Console server** (Go, `console/internal/desk`): the new fields through (`hasPin`, `glance.box`), every new display
  string cleaned as the others (`clean.go`), `no_pin` passed on as the other refusal codes (CG-56). Tests.
- **Page** (`console/ui`, CG-57…): the *This Whombat* panel exactly as the mockup (the last-hour chart of processor and
  memory with its scale lines and labels — the scale's top is 25, 50 or 100 %, the smallest that holds the hour —,
  storage with its parts bar, temperature with its segments, the network line and the hint, the uptime in the header),
  filling the space under the hero; when *Working on* or *Done today* also show, the panel takes what is left and drops
  the chart below a height where it can't be read (decide the number and record it). The calm *Nothing needs you* card
  when the box shows and nothing needs the person (DK-23). The PIN pad without a PIN: “Unlock as {name}”, only *Confirm
  on your phone*, `noPinYet` (DK-18). Words copied into the page's `DESK_WORDS` with the copy test (CG-40). Fixtures
  (`desk-box-*`: new box locked summary, everything, unlocked, with Working on, no temperature (VM), no network, no-PIN
  pad) and `pnpm shots` at 1280×800 and 2560×1600 (and 1024×768 for the smallest), compared with the mockup.
- **Mockup into the repo**: `docs/design/desk-display/new-box.html` (standalone: fonts, tokens and images inlined, as
  `index.html` there) and `new-box-1.png`, `new-box-2.png` from the mockup directory.
- Checks: `go vet ./... && go test ./...` in `manager` and `console`; `pnpm check` in `console/ui`; the Nix builds of the
  manager and the console (`nix build .#…` as `flake.nix` names them, `vendorHash` / `pnpmDeps` hashes updated if they
  move). No VM tests. You may read John's DEV box (`dev/devbox shell -- …`, read-only commands) to see its hwmon/thermal
  tree; change nothing there.

### W — app (`~/Code/.wt/app-desk-auto`, branch `desk-auto`)

- `packages/client` desk model: `display`, `on`, `onChosen`, `paired.hasPin`, `paired.self`, `setScreen(on)`, the new
  error codes; older runtimes (no `display`) keep today's model and UI.
- **Web** Settings → This Whombat → Screen (AP-3100…): first the switch row *Show Whombat on this screen* (owners; the
  paired person who isn't an owner sees it read-only), under it the screen line (`screenNamed` with the name, else
  `builtIn` or `connectedUnnamed`, else `noScreenNow`), the virtual hint when `!display.real && !onChosen`, the off hint
  when off. On and paired with you: `noPin` + *Choose a PIN* (the existing PIN dialog through `desk.setPin`) when
  `hasPin` is false, else the rows as today (PIN · Change PIN, while locked, quiet hours, at night, talk). Paired with
  someone else: “Paired with {name} · since {date}” and *Pair to me instead* (the existing letters flow). *Unpair* goes
  (the switch replaces it). Section shown when `display.connected` or paired, as now. Visual check in both themes at
  1440×900 against the existing Settings page's look (there is no new mock for Settings: match the section's current
  rows and spacing).
- **Android** the same in the phone's Settings → This Whombat → Screen (AP-3115…), 44 px targets, checked on your
  emulator against a fake.
- Decisions in `desk-display-web.md` / `desk-display-android.md`. Don't release: the lead cuts the app release.
