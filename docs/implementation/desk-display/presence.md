# A four-digit PIN, and staying unlocked while you're there — build brief (2026-10-20)

Decisions: `docs/decisions/desk-display.md` **DK-26…DK-35** (section “A four-digit PIN, and staying unlocked while
you're there”), on top of DK-01…DK-25 and `desk-display-server.md` DK-S01…DK-S33. **Read them first**, then §1, §2 and
your stream's part of §3. There is no new mockup: the changes are small, so match the surrounding screen, Settings rows
and the console's lock chip and pad exactly (sizes, spacing, tokens). The desk mockups are appliance
`docs/design/desk-display/` (`frame1…4.png`, `new-box.html`). The earlier briefs beside this file (`assignment.md`,
`auto-pair.md`) show how the desk was built (shapes, socket, page, the voice service).

| Stream | Repo | Worktree | Branch | Ids |
|---|---|---|---|---|
| C contracts | whombat-contracts | `~/Code/.wt/contracts-presence` | `presence` | CT-590…CT-609, 0.103.0 |
| S server | Whombat | `~/Code/.wt/whombat-presence` | `presence` | DK-S34… (`desk-display-server.md`) |
| K camera service | the appliance | `~/Code/.wt/appliance-presence` | `presence` | NX-280…NX-299 (`nixos.md`) |
| P console | the appliance | `~/Code/.wt/appliance-desk-pad` | `desk-pad` | CG-130…CG-149 (`console-gui.md`) |
| W app | whombat-app | `~/Code/.wt/app-presence` | `presence` | AP-3300…AP-3324 web, AP-3325…AP-3349 Android |

All branches start from `main` (contracts main has 0.102.0, app main 0.106.0). A peer session (whombat-b0, hardware
support: Wi-Fi, PipeWire, the hardware report) is still merging its Whombat and appliance branches `hw`; the lead merges
their main into yours when it lands, so don't worry about it, but expect `console/ui` (`desk/Glance.tsx`'s network chip,
`src/wifi/`), `console/internal/desk/network.go` and Whombat `desk/socket.ts`'s network hook to appear. The lead merges,
releases contracts and the app, vendors and ships.

## 1. Rules for every stream

- Work only in your worktree on your branch; commit small and often (`contracts: …`, `server: …`, `presence: …`,
  `console: …`, `nix: …`, `web: …`, `mobile: …`, `client: …`, `docs: …`), every message ending with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never push, never merge into `main`, never touch the main
  checkouts (`~/Code/Whombat`, `~/Code/whombat-app`, `~/Code/whombat-contracts`, `~/Code/whombat-appliance`): other
  sessions work there.
- **Contracts 0.103.0.** C builds them first. S, K, P and W start at once with what doesn't need the new types, against
  §2's shapes (a local stand-in type is fine; replace it once vendored). When the lead says 0.103.0 is released
  (`~/Code/whombat-contracts/dist-release/0.103.0/`), vendor it in your branch yourself as the last vendoring did (app
  `e490f32d`; Whombat `git log --grep 'deps: @whombat contracts'`; appliance `d584f5f` for Go and the console's
  `console/ui/vendor/whombat-contracts/`): `vendor/whombat-contracts/<v>/`, `package.json`, `pnpm-workspace.yaml`,
  `pnpm install`, commit `deps: @whombat contracts 0.103.0 (…)` with the lockfile; appliance
  `third_party/whombat-contracts-go` from the release's `whombat-contracts-go-0.103.0.tar.gz`, `go.mod`, and any Nix
  `vendorHash` that moves. Need a contract change? Don't edit vendored files: message the lead with the exact additive
  change.
- **DEV fast** (John's rule): one quick check at the end — `pnpm format` then `TMPDIR=~/.cache/wb-tmp pnpm check`
  (appliance Go: `go vet ./... && go test ./...` in the modules you touched; `console/ui`: `pnpm check` there; Nix: the
  `nix build` attributes named in your §3), plus `pnpm test:server` once (S). Run single test files while you work. No VM
  gates, no CI waits, no waiting for future data. Own ports (S 4560, W 4564/5264) and throwaway databases; the shared
  `docker compose` (Postgres :55432, Mailpit) is never stopped or reset. `/tmp` runs out of inodes:
  `TMPDIR=~/.cache/wb-tmp`. Nix needs `--extra-experimental-features 'nix-command flakes'`. Temporary containers or VMs
  only through `/usr/local/bin/agent-resource` (read `/home/me/Code/dashboard/docs/agent-resources.md` first), and
  release what you lease.
- **Android emulator** (W): the AVD `whombat-mobile` is shared; run your own read-only instance on port 5622
  (`emulator -avd whombat-mobile -port 5622 -read-only -no-window -no-audio -no-boot-anim -gpu swiftshader_indirect`) and
  `adb -s emulator-5622 emu kill` when done. See `apps/mobile/README.md`.
- **Never touch John's real servers, services or DEV box** from tests or scripts; never run an installer or a candidate.
  This machine has no camera: K tests with recorded frames and fakes (§3 K), nobody opens a real camera here.
- **Tests** (`docs/decisions/test-speed.md`): unit-test logic (the PIN rules, `deskPinTooEasy`, the lock's timing with
  presence, the watch loop, the service's lifecycle, the frame parsing, the detector's decoding); fakes in process. A new
  `*.int.test.ts` needs a reason to need Postgres (`desk.int.test.ts` can grow). Check facts (ids, codes, a key phrase),
  never long literal text. Inject clocks and short timeouts, never sleep.
- **Copy**: §2's words are the words (curly quotes ’ “ ”, `·`). The assistant's real name from the runtime, never
  “Dusty” hard-coded.
- **Tokens only** for UI colours/fonts/radii; match the surrounding code's style and comment density.
- Record your own decisions in your stream's file: Whombat `docs/decisions/desk-display-server.md` (S, DK-S34…);
  appliance `docs/decisions/nixos.md` (K, NX-280…), `console-gui.md` (P, CG-130…); app `docs/decisions/desk-display-web.md`
  and `desk-display-android.md` (W); C in the contracts notes (CT-590…).
- When done: the quick check green, everything committed, a short report (what you built, what you decided, what is
  left, what the lead must check live). Don't wait for anything after that.

## 2. Wire shapes (0.103.0, all additive)

### `@whombat/core` (`domain/desk.ts`)

```ts
/** 4 to 6 digits (DK-26). ASCII digits written out: the same pattern crosses to Go (CT-529). */
export const DESK_PIN_MIN = 4;
export const DESK_PIN_MAX = 6;
export const DESK_PIN_RE = /^[0-9]{4,6}$/;            // was /^[0-9]{6}$/
export const DeskPin = z.string().regex(DESK_PIN_RE);
export const DeskPinDigits = z.number().int().min(4).max(6);

/**
 * Too easy to guess (DK-27): one digit repeated; a run where each digit is one more, or each one less, than the one
 * before, 9 and 0 next to each other (1234, 7890, 4321, 0987); a pair or three digits repeated (1212, 123123).
 */
export function deskPinTooEasy(pin: string): boolean;

/** Stay unlocked while you're here (DK-28). */
export const DESK_PRESENCE_GONE_S = 30;      // locks this long after the last face or touch, once a face was seen
export const DESK_PRESENCE_MAX_S = 14_400;   // at most 4 hours unlocked in a row this way
export const DESK_PRESENCE_CHECK_S = 2;      // the runtime asks the presence service this often while unlocked

DeskSettings gains   presence: z.boolean().default(false)
DEFAULT_DESK_SETTINGS.presence = false
DeskSettingsPatch gains   presence: z.boolean().optional()

DeskScreen gains (optional: older runtimes send none; a client then shows no presence row)
  /** The presence service answers and has a camera it can read (DK-28, DK-31): the switch can be shown. */
  presenceAvailable: z.boolean().optional(),
```

`DESK_WORDS` additions and changes (keys and words exact):

```ts
unlockedHere: 'Unlocked as {name} · stays unlocked while you’re here'
cameraOn: 'The camera is on while the screen is unlocked'         // the camera mark's label
settings.choosePin: 'Choose a PIN of 4 to 6 digits'                // was 'Choose a 6-digit PIN'
settings.presence: 'Stay unlocked while you’re here'
settings.presenceHint: 'While the screen is unlocked, the camera checks that someone is in front of it, and the screen locks 30 seconds after you leave. It doesn’t recognize faces and keeps no pictures.'
errors.easy_pin: 'That PIN is too easy to guess. Choose another.'
```

### `@whombat/protocol/session` (`session/desk.ts`)

- `DeskPairInput.pin` and `DeskSetPinInput.pin` take 4–6 digits (`DeskPin`). The schema doesn't refuse easy PINs; the
  runtime does, with the new `DESK_ERROR_CODES` member `easy_pin` (`DESK_ERROR_STATUS`: the generic code for an input
  that is well-formed but refused — C picks the closest existing `ErrorCode`, e.g. `invalid`/`bad_request`, and says
  which).
- `desk.update` takes `presence` through `DeskSettingsPatch`.
- Bump `SESSION_API_LEVEL` if the contracts' rules say a new error code or member needs it.

### `@whombat/control-contracts/local` — the desk socket (`local/desk.ts`)

```ts
DeskPaired gains
  /** The PIN's length (DK-26): the pad shows this many dots and unlocks at the last; absent: 6. */
  pinDigits: z.number().int().min(4).max(6).optional(),

DeskLock gains
  /** The camera is on now (DK-30): the chip shows the camera mark. Only with `unlocked`. */
  camera: z.boolean().optional(),
  /** The camera sees someone (DK-28): the chip reads `unlockedHere`, and `until` is at most 30 s ahead. Only with `unlocked`. */
  present: z.boolean().optional(),

DeskUnlockRequest.pin: DESK_PIN_RE (4–6)
```

`deskStateValid` (or its equivalent) refuses `camera`/`present` on a lock that isn't `unlocked`, and `present` without
`camera`.

### `@whombat/control-contracts/local` — the presence socket (new `local/presence.ts`, Go generated)

```ts
/**
 * The presence socket (0.103, CT-…; Whombat DK-28…DK-33): the runtime → the appliance's camera service
 * `whombat-presence`, HTTP/1.1 JSON over a unix socket at `WHOMBAT_PRESENCE_SOCKET` (unset: no presence).
 *
 * | GET  /v1/presence/health | —                          | PresenceHealth |
 * | POST /v1/presence/watch  | PresenceWatchRequest {v}   | PresenceWatch  |
 * | POST /v1/presence/stop   | PresenceStopRequest {v}    | PresenceAck {v} |
 */
export const PRESENCE_SOCKET_ENV = 'WHOMBAT_PRESENCE_SOCKET';
export const PRESENCE_SOCKET_DEFAULT = '/run/whombat-presence/presence.sock';
export const PRESENCE_PATHS = { health: '/v1/presence/health', watch: '/v1/presence/watch', stop: '/v1/presence/stop' } as const;
/** The camera closes this long after the last watch by itself (DK-30). */
export const PRESENCE_KEEP_S = 6;
export const PRESENCE_ERRORS = ['bad_request', 'too_large', 'unavailable'] as const;

/** `camera`: a capture camera exists; `detector`: the model loads and runs. */
export const PresenceHealth = z.object({ v: V, camera: z.boolean(), detector: z.boolean() });

/**
 * A watch starts the camera when it isn't on and keeps it on `PRESENCE_KEEP_S` more.
 * - `starting`: the camera is opening (no frame yet); `watching`: frames arrive and are checked;
 * - `dark`: frames arrive but are too dark to find a face (the runtime treats it as no camera, DK-28);
 * - `failed`: the camera or the detector stopped working; `no_camera`: there is none.
 * `face`: a face in the latest checked frame. `seenAt`: the last frame with a face since the camera came on.
 * `frameAt`: the last frame checked.
 */
export const PRESENCE_STATES = ['starting', 'watching', 'dark', 'failed', 'no_camera'] as const;
export const PresenceWatch = z.object({
  v: V,
  state: z.enum(PRESENCE_STATES),
  face: z.boolean(),
  seenAt: Rfc3339.optional(),
  frameAt: Rfc3339.optional(),
});
export const PresenceWatchRequest = z.strictObject({ v: V });
export const PresenceStopRequest = z.strictObject({ v: V });
export const PresenceAck = z.object({ v: V });
```

Requests strict and at most 1 KiB, answers tolerant; errors `LocalError` with `PRESENCE_ERRORS`. Regenerate the schema,
vectors and Go bindings (`pnpm gen`, `gen:check` clean); notes in the contracts' changelog as earlier releases did.

## 3. Streams

### C — contracts (`~/Code/.wt/contracts-presence`, branch `presence`)

§2 exactly, with tests: `deskPinTooEasy` (0000, 1234, 7890, 0987, 4321, 1212, 6969, 123123, 123456, 654321 refused;
2580, 1397, 5203, 860417 accepted), `DESK_PIN_RE` (4, 5 and 6 digits, not 3 or 7, ASCII only), the new DeskState
members' validity rules, `PresenceWatch`/`PresenceHealth` parsing, the Go bindings' cross-language vectors for the new
shapes. Version 0.103.0 (`pnpm release` as the last release did, but **don't tag or push**: the lead does). Tell the lead
the moment the release directory exists.

### S — server (`~/Code/.wt/whombat-presence`, branch `presence`; the lead's docs commit is on it)

- **Migration 0124_desk_presence** (expand): `desk_screens.pin_digits smallint` null (null = 6, a PIN from before),
  check 4–6; `desk_screens.presence boolean not null default false`. Drizzle schema to match.
- **The PIN** (`pin.ts`, `store.ts`, `ops.ts`): 4–6 digits; `deskPinTooEasy` refuses before hashing with `easy_pin` (in
  `desk.pair` before the letters are used up, and in `desk.setPin`); `pin_digits` written with the hash in the same
  transaction; `DeskPaired.pinDigits` in the socket's state (absent while there is no PIN).
- **Presence client** `desk/presence.ts` beside `voice.ts`: `WHOMBAT_PRESENCE_SOCKET`, health (cached as voice's is), watch,
  stop, short timeouts; `WHOMBAT_PRESENCE=fake` puts a controllable fake in its place (`testing/fake-presence.ts`) for
  development and tests. `DeskScreen.presenceAvailable` = health answers with `camera && detector`.
- **The lock** (`lock.ts`, `service.ts`; DK-28…DK-30): while unlocked, paired, `presence` on and available, a watch loop
  asks every `DESK_PRESENCE_CHECK_S` (one loop, in the service's queue rules where it touches the lock; injected clock and
  timers). Rules: before the first face since this unlock, and whenever the state isn't `watching`, the lock is DK-04's
  (2 minutes after the later of the last touch and the last face). After a face, `until` = the later of the last face and
  the last touch + `DESK_PRESENCE_GONE_S`. Never past the unlock + `DESK_PRESENCE_MAX_S` while presence kept it (then it
  locks; a touch alone keeps DK-04's rule as before). `lock.camera` while the loop runs and the service answered
  `starting`/`watching`/`dark`; `lock.present` while the last face is within `DESK_PRESENCE_GONE_S`. Every lock (all of
  DK-30's list) stops the loop and sends `stop` at once (errors ignored: the service closes by itself after 6 s).
  Turning the switch off while unlocked stops it too. A failing or slow service never keeps the screen unlocked longer
  than DK-04 would. Record what you decide (e.g. `seenAt` older than the unlock doesn't count; a face only counts from
  frames after this unlock).
- `desk.update {presence}` is the paired person's, as the other settings; `desk.updated` as now.
- Tests: the timing rules with a fake clock and the fake service (seen → stays; gone 30 s → locks; never seen → 2 min;
  `dark`/`failed` mid-way → back to 2 min; 4 h cap; lock → stop sent; switch off → stop), the PIN rules, the migration in
  `desk.int.test.ts`. `pnpm test:server` once.
- Decisions in `desk-display-server.md` (DK-S34…).

### K — the camera service (`~/Code/.wt/appliance-presence`, branch `presence`)

Built like the voice service (`voice/`, `nix/modules/voice.nix`, `nix/packages/voice-engines/`; read them first).

- **`presence/` Go module** (`presence/cmd/whombat-presence`, `presence/internal/…`; match voice's layout and flags):
  the socket API of §2 (socket activation, peer uid check `--allow-uid 0,<whombat>`, strict 1 KiB requests), health (a
  capture camera exists: `/sys/class/video4linux` + `VIDIOC_QUERYCAP` with capture capability, or `presence-watch
  --probe`; the detector loads: `presence-watch --self-test` once at start), and the camera's lifetime: a watch starts
  `presence-watch` when it isn't running and keeps it `PRESENCE_KEEP_S` after the last watch; `stop`, the keep running out,
  or the child's exit end it (SIGTERM, then SIGKILL after 1 s). It reads the child's JSON lines and answers watches from
  the latest. Camera choice per DK-32 (colour before infrared, rear last; switch to an infrared one when the colour
  picture stays `dark` for 10 s and an infrared one gives frames). The child is restarted at most once per 30 s after a
  failure (then `failed` until the next watch after that).
- **`presence-watch`** (C++17, `nix/packages/presence-engine/presence-watch.cpp`, linked with the same nixpkgs
  `onnxruntime` as `piper-speak` — so it adds almost nothing to the image — and libjpeg-turbo for MJPEG): V4L2 mmap
  capture at the smallest size at least 320 wide (YUYV, GREY or MJPEG); about 2 checks a second (drop the frames between);
  YuNet (`face_detection_yunet_2023mar.onnx`, opencv_zoo, MIT; fetched by hash in a `presence-model` package with its
  LICENSE) on the frame scaled/padded to the model's input, decoding its outputs (score = sqrt(cls × obj) as OpenCV's
  `FaceDetectorYN` does), a face when the best score ≥ a threshold you choose and record (start near 0.6, faces down to
  about 40 px tall at 320 wide); the frame's mean brightness for `dark`. One JSON line per check on stdout
  (`{"t":"…","face":true,"score":0.91,"luma":87}`), exits when stdin closes or on SIGTERM. Frames live in memory only,
  are never written or logged; nothing but those numbers leaves the program. Modes for tests: `--probe` (cameras as
  JSON lines: path, name, formats, colour/infrared guess), `--self-test` (loads the model, runs a blank frame), `--frames
  DIR|FILE` (reads PGM/PPM/JPEG pictures instead of a camera).
- **Tests without a camera**: Go unit tests with a fake child (a test binary or a script printing lines) for the
  lifecycle, the keep, stop, restarts, camera choice, the API's errors; a Nix check that runs `presence-watch
  --self-test` and `--frames` on a few pictures: faces found in pictures with a clear licence (CC0/public domain,
  fetched by hash, credited in NOTICES), none in a blank or dark frame. If no such pictures can be had, say so and test
  the decoding with a synthetic model output instead.
- **`nix/modules/presence.nix`** (`whombat.presence.enable`, off by default, on in the appliance profile as voice is):
  user/group `whombat-presence` (fixed ids beside `whombat-voice`), socket 0660 whombat-presence:whombat, the service
  sandboxed as voice (no network, `IPAddressDeny=any`, `RestrictAddressFamilies=AF_UNIX`, no capabilities, nothing of
  /persist, `ProtectSystem=strict`, `MemoryDenyWriteExecute`, low CPU/IO weights, a memory cap you measure and record)
  but with the camera: `PrivateDevices=false`, `DevicePolicy=closed`, `DeviceAllow=char-video4linux rw`, the `video`
  group, `/sys/class/video4linux` readable. The runtime gets `WHOMBAT_PRESENCE_SOCKET` (`runtime.nix`, as
  `whombat.voice.socket`). The kiosk's `VideoCaptureAllowed = false` stays. Check that `uvcvideo` is in the kernel and
  not blacklisted.
- Licences: YuNet MIT and libjpeg-turbo in `NOTICES.md` and wherever voice's are listed (the licence screen, if the
  appliance has one).
- Image size: measure what the closure grows by and record it.
- Checks: `go vet ./... && go test ./...` in `presence`; `nix build` of `presence-watch`, the model, `whombat-presence`
  and the Nix check; the appliance system's evaluation (as `flake.nix` names it). No VM tests.
- Decisions in `docs/decisions/nixos.md` (NX-280…).

### P — the console (`~/Code/.wt/appliance-desk-pad`, branch `desk-pad`)

- **Console server (Go)**: passes `DeskPaired.pinDigits`, `DeskLock.camera` and `DeskLock.present` through `/api/state`,
  checked as the rest; `POST /api/desk/unlock` takes 4–6 digits. Stand-in types until contracts-go 0.103.0, then the
  generated ones.
- **Page** (`console/ui`): the pad (`lib/unlock.ts`, `desk/Sheet.tsx`) uses `paired.pinDigits ?? 6`: that many dots,
  digits up to that many, unlock at the last; keys work as now. The lock chip (`desk/parts.tsx`): while `lock.camera`, a
  small camera mark before the text (an outline camera glyph at the chip's text size, the chip's muted colour, with
  `DESK_WORDS.cameraOn` as its accessible label and title); while `lock.present` the text is `unlockedHere` instead of
  “locks in {n} min”. The page's own relock (CG-50) follows `until` as Whombat moves it. Words copied into the page's
  `DESK_WORDS` with the copy test (CG-40). Fixtures for a 4-digit pad, unlocked with the camera on and present, camera
  on not yet seen, and `pnpm shots` at 1280×800 and 2560×1600; compare with the current pad and chip (nothing else may
  move).
- Checks: `go vet ./... && go test ./...` in `console`; `pnpm check` in `console/ui`; the console's Nix build (hashes
  updated if they move).
- Decisions in `docs/decisions/console-gui.md` (CG-130…).

### W — app (`~/Code/.wt/app-presence`, branch `presence`)

- **Client** (`packages/client/src/desk/`): PIN forms accept 4–6 digits and refuse `deskPinTooEasy` with
  `errors.easy_pin` before sending; `pinMeta` becomes “4 to 6 digits that unlock the screen.”; the `easy_pin` error code's
  words; `presenceAvailable` and `settings.presence` in the model; `update({presence})`; the fake (`fake.ts`) gains
  both.
- **Web** Settings → This Whombat → Screen (AP-3300…): the PIN dialogs (pairing, change, first PIN) take 4–6 digits
  (inputs up to 6, the button enabled from 4 when both match; no auto-advance at 6 any more if it did); a switch row
  *Stay unlocked while you’re here* with `presenceHint` under it, right after *Talk to {assistant}*, the paired person's
  (others see it read-only, as Talk), only when `presenceAvailable`. Visual check in both themes at 1440×900 against the
  section's current rows.
- **Android** the same in the phone's Settings → This Whombat → Screen (AP-3325…), 44 px targets, checked on your
  emulator against the fake.
- Decisions in `desk-display-web.md` / `desk-display-android.md`. Don't release: the lead cuts the app release (0.107.0).
