# Only the clock when nobody's there, the camera to see who is, and Lock again — build brief (2026-10-20)

Decisions: `docs/decisions/desk-display.md` **DK-70…DK-77** (section “Only the clock when nobody's there, the camera to
see who is, and staying unlocked”), on top of DK-01…DK-53 and `desk-display-server.md` DK-S01…DK-S55. **Read them
first**, then §1, §2 and your stream's part of §3. There is no mockup for the clock: §3 P gives its sizes; everything
else matches the surrounding screen, Settings rows and the console exactly (sizes, spacing, tokens). The earlier briefs
beside this file (`assignment.md`, `auto-pair.md`, `presence.md`) show how the desk was built; `presence.md` is the
closest relative (the camera, the lock's rules, the Settings switch).

| Stream | Repo | Worktree | Branch | Ids |
|---|---|---|---|---|
| S server | Whombat | `~/Code/.wt/whombat-idle` | `desk-idle` | DK-S70… (`desk-display-server.md`), migration 0126 |
| P console | the appliance | `~/Code/.wt/appliance-idle` | `desk-idle` | CG-170…CG-189 (`console-gui.md`) |
| A app | whombat-app | `~/Code/.wt/app-idle` | `desk-idle` | AP-3600…AP-3624 web, AP-3625…AP-3649 Android |

**Contracts 0.107.0 are released** (`~/Code/whombat-contracts/dist-release/0.107.0/`, tag `contracts-v0.107.0`,
CT-640…CT-649). Vendor them first in your branch, as the last vendoring did (Whombat `3461317b`; app
`git log --grep 'contracts 0.105.0'`; appliance `ecc8db4` and the commits before it for contracts-go, the Go
`vendorHash` and `console/ui/vendor/whombat-contracts/`): commit `deps: @whombat contracts 0.107.0 (…)` with the
lockfile. Need a contract change? Don't edit vendored files: message the lead with the exact additive change.

Peers on the same files (the lead merges; don't wait for them): the *sign in at the box* build (contracts 0.106.0, already
in 0.107.0; its console stream adds a sign-in panel over every desk scene and holds off dimming while it shows) and the
*desk asks popup* build (contracts 0.108.0 later; Sheet.tsx, Talk.tsx, a popup over the glance). Keep your changes
where this brief puts them so the merges stay small.

## 1. Rules for every stream

- Work only in your worktree on your branch; commit small and often (`server: …`, `console: …`, `web: …`, `mobile: …`,
  `client: …`, `docs: …`), every message ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never
  push, never merge into `main`, never touch the main checkouts (`~/Code/Whombat`, `~/Code/whombat-app`,
  `~/Code/whombat-contracts`, `~/Code/whombat-appliance`): other sessions work there.
- **DEV fast** (John's rule): one quick check at the end — `pnpm format` then `TMPDIR=~/.cache/wb-tmp pnpm check`
  (appliance Go: `go vet ./... && go test ./...` in the modules you touched; `console/ui`: `pnpm check` there), plus
  `pnpm test:server` once (S). Run single test files while you work. No VM gates, no CI waits. Own ports (S 4570, A
  4574/5274) and throwaway databases; the shared `docker compose` (Postgres :55432, Mailpit) is never stopped or reset.
  `/tmp` runs out of inodes: `TMPDIR=~/.cache/wb-tmp`. Nix needs `--extra-experimental-features 'nix-command flakes'`.
  Temporary containers or VMs only through `/usr/local/bin/agent-resource` (read
  `/home/me/Code/dashboard/docs/agent-resources.md` first), and release what you lease.
- **Android emulator** (A): the AVD `whombat-mobile` is shared; run your own read-only instance on port 5626
  (`emulator -avd whombat-mobile -port 5626 -read-only -no-window -no-audio -no-boot-anim -gpu swiftshader_indirect`) and
  `adb -s emulator-5626 emu kill` when done. See `apps/mobile/README.md`.
- **Never touch John's real servers, services or DEV box** from tests or scripts; never run an installer or a candidate.
  This machine has no camera: the fake presence service (`WHOMBAT_PRESENCE=fake`, DK-S38) and fixtures stand in.
- **Tests** (`docs/decisions/test-speed.md`): unit-test logic (the lock with `stays`, the camera loop's wanting and its
  two readers, `here`, the boot id, the console's scene rules); fakes in process, clocks injected (`FakeTime`), never
  sleep. A new `*.int.test.ts` needs a reason to need Postgres (`desk.int.test.ts` can grow). Check facts (ids, codes, a
  key phrase), never long literal text.
- **Copy**: the contracts' `DESK_WORDS` are the words (curly quotes ’ “ ”, `·`). The assistant's name from the runtime,
  never “Dusty” hard-coded.
- **Tokens only** for UI colours/fonts/radii; match the surrounding code's style and comment density.
- Record your own decisions in your stream's file: Whombat `docs/decisions/desk-display-server.md` (S, DK-S70…);
  appliance `docs/decisions/console-gui.md` (P, CG-170…); app `docs/decisions/desk-display-web.md` and
  `desk-display-android.md` (A).
- When done: the quick check green, everything committed, a short report (what you built, what you decided, what is
  left, what the lead must check live). Don't wait for anything after that.

## 2. The wire (contracts 0.107.0, all additive; read the sources for the doc comments)

`@whombat/core` (`domain/desk.ts`):

```ts
DeskSettings.stayUnlocked: boolean = false      // Lock again: When you press Lock (DK-74); wins over presence
DeskSettings.cameraWake: boolean = false        // Use the camera to see when you're here (DK-72)
DeskSettingsPatch.stayUnlocked?, cameraWake?    // strict: send them only where the runtime offers them (below)
DESK_LOCK_AGAIN = ['idle', 'away', 'never']; DeskLockAgain
deskLockAgainOf({presence, stayUnlocked}) → DeskLockAgain        // stayUnlocked → never, presence → away, else idle
deskLockAgainPatch(choice) → {presence, stayUnlocked}             // both members, always
DESK_IDLE_S = 600   // idle after the last touch without the camera; a new ask keeps the glance up as long
DESK_AWAY_S = 60    // with the camera watching: idle this long after the last face and touch
DeskScreen.lockAgain?: DeskLockAgain[]      // the choices offered: idle and never always, away where presenceAvailable
DeskScreen.cameraWakeAvailable?: boolean    // the runtime knows cameraWake and the camera works
DESK_WORDS.unlockedStays     'Unlocked as {name}'
DESK_WORDS.cameraLooking     'The camera is on to see when you’re here'
DESK_WORDS.settings.lockAgain, lockAgainChoices{idle,away,never}, lockAgainHints{idle,away,never ({assistant})},
                    cameraWake, cameraWakeHint
```

`@whombat/control-contracts/local` (`local/desk.ts`, Go `local` the same):

```ts
DeskLock.stays?: boolean              // unlocked until Lock (DK-74); only with unlocked; until = state's now + 2 min
DeskPresence { camera, watching, here }   // camera: on now; watching: can tell now; here: a face within DESK_AWAY_S
DeskState.presence?: DeskPresence     // absent when the camera doesn't look for DK-72; only while paired
```

`desk.update` takes the new patch members (the session op is unchanged); `SESSION_API_LEVEL` stays 41.

## 3. The streams

### S — the runtime (`apps/server/src/desk/*`)

1. **Migration 0126** (expand only; `apps/server/src/db/migrations/0126_desk_idle.sql`, schema `db/schema/desk.ts`):
   `desk_screens.stay_unlocked boolean not null default false`, `camera_wake boolean not null default false`,
   `unlocked_boot text` (null; the boot id an unlock that stays was made on, DK-75). Number 0126 is reserved for you;
   another branch may land a migration first — then take the next free number and say so in your report.
2. **Settings.** `desk.update` takes `stayUnlocked` and `cameraWake` (the paired person's, through the pipeline as the
   others, one `desk.changed`); `DeskScreen.settings` carries both; `DeskScreen.lockAgain` is `['idle', 'never']` plus
   `away` (in order) where `presenceAvailable`; `cameraWakeAvailable` = `presenceAvailable`. A new pairing starts with
   both off (as `presence`, DK-S34). `presence: true` with `stayUnlocked: true` (an older app's switch) → `stayUnlocked`
   wins everywhere (DK-76).
3. **The lock stays** (`lock.ts`, DK-74). An unlock (PIN or phone) while `stayUnlocked` is on never locks by time: no
   2 minutes, no 30 s, no 4 hours, no camera for the lock. The view says `unlocked`, `stays: true`, `until` = now + 2 min
   (every state; CT-646) and no `camera`/`present`. Locks: the Lock button, the choice changed (below), the screen
   turned off, unpaired, paired again, the person leaving, a runtime closing (memory only — DK-75 restores it).
   Turning `stayUnlocked` on while unlocked makes the unlock going on stay (the camera's loop for the lock stops, DK-S39
   style); turning it off while unlocked: DK-04's rule with the change counted as a touch (2 minutes from then); to
   `away` (presence on): DK-28's rules with the change as a touch, and the camera starts at once (DK-S39). Keep the
   epoch rules (every unlock and lock a new epoch).
4. **An update keeps it** (DK-75). Read the boot id once (`/proc/sys/kernel/random/boot_id`, trimmed; unreadable →
   null, which never restores). An unlock that stays writes `unlocked_boot` (a command through the pipeline, as the PIN's
   tries are, `#commitAs`; no Chat message, no push); every lock of it, the choice turned off, unpairing and pairing
   again clear it (same transaction where one exists). On start, when the row is paired, `stay_unlocked` is true and
   `unlocked_boot` equals this boot's id: the screen is unlocked again (stays), and the log says so once. Tests inject
   the boot id.
5. **The camera for the clock** (`presence.ts`, DK-72, DK-73). The one `PresenceLoop` (one camera, one service) now
   runs while it is *wanted*: (a) DK-28's case, unlocked with `presence` on and `stayUnlocked` off, as today, or (b)
   `cameraWake` on, `presenceAvailable`, paired, the screen on, not quiet now (`deskQuietNow`), not on battery
   (`power.source !== 'battery'`), and the console asked for the state within the last 10 s (the console polls every
   second; no console, no camera). Re-check *wanted* at every check (every 2 s) and when the state is asked (that is how
   the morning or the console's return starts it); stop with `stop` the moment nothing wants it. Each answer goes to
   both readers: the lock (only in case (a), only for the epoch the watch began in, as DK-S35 says), and a small
   *seen* record for the clock: `camera` (the answer says the camera is open: starting, watching, dark), `watching`
   (`watching` on a fresh frame, DK-S35's 5 s), the last face (from `seenAt`, else the frame's time when `face`, never
   later than now). `DeskState.presence` = `{camera, watching, here: lastFace within DESK_AWAY_S}` while case (b) wants
   the camera, else absent. An unlock or a lock must not stop and restart the camera when (b) still wants it (no
   flicker of the camera's light at every unlock). A face never touches the lock in case (b) alone (DK-29).
6. **Fake presence** (DK-S38): with `WHOMBAT_PRESENCE=fake` someone is always there, so in development the glance
   always shows with the camera on; tests drive `someone` false/true and `picture` dark/failed.
7. Tests: the lock with `stays` (no time locks it, the 2 min `until` moves on, Lock locks, the choice off counts as a
   touch, on while unlocked holds it, a lock is never undone); the boot id (same boot restores, another boot or null
   doesn't, every lock clears); the loop's *wanted* (quiet hours, battery, no console for 10 s, the switch, unpaired,
   both cases at once, no restart at unlock), `here` within 60 s, the lock reading only case (a); `desk.update` and
   `DeskScreen` (`lockAgain` with and without a camera, `cameraWakeAvailable`). `desk.int.test.ts` for the migration
   and the boot-id write.

### P — the console page and its server (`console/ui`, `console/internal/desk`)

1. **Vendor** contracts-go 0.107.0 for the console server (`third_party/whombat-contracts-go`, `go.mod`, the Nix
   `vendorHash`) so it passes `lock.stays` and `presence` through (an older contracts-go would drop them), and
   `console/ui/vendor/whombat-contracts/` for the page's copies (`lib/deskCopy.ts` words, checked by `deskCopy.test.ts`;
   `lib/desk.ts` types: `DeskLock.stays`, `DeskPresence`, `DeskState.presence`).
2. **The idle scene** (`lib/deskScene.ts`, DK-70, DK-71): a new `DeskScene` `idle`. Rules, pure and tested
   (`deskScene.test.ts`): only for a paired screen by day (quiet hours keep `night`/`black`); never while the pairing
   letters show, the lock is `phone`, or Talk is listening, transcribing, thinking or speaking; else idle when **all**
   of: no touch/key for `DESK_IDLE_S` (10 min) — or, when `presence?.watching`, for `DESK_AWAY_S` (60 s); not
   `presence?.here`; no new ask within `DESK_IDLE_S` (`alertAt`, DK-08). Idle replaces DK-08's dimming: `attention()`
   no longer dims (the `glow` stays). Locked or unlocked alike (a screen that stays unlocked goes idle too). When the
   screen goes idle, an open PIN pad, ask sheet or finished Talk closes; the first touch on the clock only wakes (as
   `wakeOnly` does for night today), and the glance it wakes to is the one the lock allows.
3. **The clock** (`desk/Night.tsx` beside `Night`, or its own file; `desk.module.css`, new classes in their own block
   at the end), on the 1280×800 stage, the glance's own background (not `--night`), centred:
   - the time, `clockText`: `700 300px / 0.9 var(--font-sans)`, `letter-spacing: -0.05em`,
     `font-variant-numeric: tabular-nums`, `color: var(--ink)`;
   - the date under it, `dateText`: `500 30px var(--font-sans)`, `color: var(--mut)`, 18px below the time;
   - while `nightLine(glance) === 'needsYou'`: a 14px `var(--warn)` dot 28px under the date, with
     `DESK_WORDS.status.somethingNeedsYou` as its visually hidden text;
   - while `presence?.camera`: the camera mark (the lock chip's `cameraIcon`, 20px, `var(--mut)`) 28px from the bottom
     and 32px from the right, labelled `DESK_WORDS.cameraLooking`;
   - on battery: `PowerBanner compact` at the bottom, as `ClockOnly` has it;
   - burn-in: the whole clock moves along `DRIFT_PATH` every minute from when it went idle (`burnin.ts`), never dimmed.
   Nothing else: no top bar, chips, line, servers or tiles. Check it at 1440×900 in both themes beside the glance; make
   the time read as a desk clock from across the room without touching the edges.
4. **The glance with the camera** (DK-73): while `presence?.camera`, the top bar shows the camera mark (as the chip's
   `cameraMark` today) labelled `DESK_WORDS.cameraLooking`; the chip's own camera mark (DK-30, `lock.camera`) stays as it
   is, and only one mark shows when both are on.
5. **The chip** (DK-74): `lock.stays` → `DESK_WORDS.unlockedStays` (“Unlocked as {name}”, no minutes); the Lock button
   as always.
6. **Fixtures and shots** (`src/demo/deskFixtures.ts`, the demo): `idle` (the clock), `idle-needs` (with the dot),
   `idle-camera` (the camera mark), `idle-battery`, `stays` (the glance unlocked with “Unlocked as John”),
   `glance-camera` (the top bar's mark). Shots of each in both themes for the lead.
7. Tests: the scene rules above (each condition on its own, the camera's 60 s vs the 10 min, a dark camera falls back to
   10 min, a new ask keeps the glance 10 min, Talk in progress holds, quiet hours win), the chip words, the Go
   console server passing `stays` and `presence` through and refusing a `presence` on an unpaired state (vectors).

### A — the app (`packages/client/src/desk/*`, `apps/web`, `apps/mobile`)

1. **Vendor** contracts 0.107.0.
2. **The model** (`packages/client/src/desk/model.ts`, tested): where the runtime sends `lockAgain`, the section has a
   *Lock again* choice instead of the presence switch: the choices it lists, in order, with
   `DESK_WORDS.settings.lockAgainChoices` and the chosen one's hint (`lockAgainHints`, `{assistant}` filled from the
   screen's assistant name as the voice hint does); the value is `deskLockAgainOf(settings)`; choosing sends
   `desk.update` with `deskLockAgainPatch(choice)`. Where it doesn't (older runtimes), the presence switch as before.
   *Use the camera to see when you’re here* (`cameraWake`, `cameraWakeHint`) where `cameraWakeAvailable` is true, a
   switch sending `{cameraWake}`. Both the paired person's; other owners see them read-only (as AP-3304). The fake
   (`fake.ts`) and fixtures gain both.
3. **Web** (Settings → This Whombat → Screen): *Lock again* in the shape of *While locked it shows* (the same
   segmented control, its hint under it), placed where the presence switch was; the camera switch right after it in
   the presence switch's shape. **Android**: the same, in the same places and shapes as the presence part (AP-3326),
   44px touch targets.
4. Tests: the model (choices with and without `away`, older runtimes, the patch, read-only for other owners), a web
   component test, an Android test as the presence part has. Screenshots of web (both themes) and Android for the
   lead.
