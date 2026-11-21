# The desk display — build brief (2026-10-20)

Decisions: `docs/decisions/desk-display.md` (DK-01…DK-15). **Read it first**, then §1, §2 and your stream's part of §3.
The visual reference is the mockup: `appliance/docs/design/desk-display/` on branch `desk`
(`~/Code/.wt/appliance-desk/docs/design/desk-display/index.html`, `frame1…4.png`: glance, ask + PIN, talk, night with a
power cut). The mockups win on layout, sizes and copy, except where DK-* or this brief says otherwise.

| Stream | Repo | Worktree | Branch (from) | Ids |
|---|---|---|---|---|
| C contracts | whombat-contracts | `~/Code/.wt/contracts-desk` | `desk` (main) | CT-517…CT-539, 0.100.0 |
| S server core | Whombat | `~/Code/.wt/whombat-desk-core` | `desk-core` (`desk`) | DK-S01… |
| T server talk | Whombat | `~/Code/.wt/whombat-desk-talk` | `desk-talk` (`desk`) | DK-T01… |
| K kiosk + host | the appliance | `~/Code/.wt/appliance-desk-host` | `desk-host` (`desk`) | NX-160…NX-174, MG-69… |
| V voice | the appliance | `~/Code/.wt/appliance-desk-voice` | `desk-voice` (`desk`) | NX-175…NX-184 |
| P console page | the appliance | `~/Code/.wt/appliance-desk-page` | `desk-page` (`desk`) | CG-37…CG-69 |
| W web | whombat-app | `~/Code/.wt/app-desk-web` | `desk-web` (`desk`) | AP-3000…AP-3049 |
| M Android | whombat-app | `~/Code/.wt/app-desk-mobile` | `desk-mobile` (`desk`) | AP-3050…AP-3099 |

Integration branches `desk` in Whombat (`~/Code/.wt/whombat-desk`), whombat-app (`~/Code/.wt/app-desk`) and
the appliance (`~/Code/.wt/appliance-desk`) are the lead's. C commits straight to its `desk`.

## 1. Rules for every stream

- Work only in your worktree on your branch; commit small and often (`contracts: …`, `server: …`, `runner: …`,
  `console: …`, `nix: …`, `manager: …`, `voice: …`, `web: …`, `mobile: …`, `client: …`), every message ending with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never push, never merge into `main` or another stream's
  branch, never touch the main checkouts (`~/Code/Whombat`, `~/Code/whombat-app`, `~/Code/whombat-contracts`,
  `~/Code/whombat-appliance`): other sessions work there. The lead merges, vendors and ships.
- **Contracts 0.100.0 arrive on `desk`** (Whombat and app; the appliance gets the Go module). Start with what doesn't
  need the new types, against §2's shapes; when the lead says they are vendored, `git merge desk`. Need a contract
  change? Don't edit vendored files: message the lead with the exact additive change.
- **DEV fast** (John's rule): one quick check at the end — `pnpm format` then `TMPDIR=~/.cache/wb-tmp pnpm check`
  (appliance Go: `go vet ./... && go test ./...` in the module you touched; console/ui: `pnpm check` there; Nix: the
  `nix build`s / `nix flake check` attributes named in your §3), plus `pnpm test:server` once (S, T). Run single test
  files while you work. No VM gates unless your §3 names one, no CI waits. Own ports (S 4510, T 4512, W 4514/5214) and
  throwaway databases; the shared `docker compose` (Postgres :55432, Mailpit) is never stopped or reset. `/tmp` runs out
  of inodes: `TMPDIR=~/.cache/wb-tmp`. Nix needs `--extra-experimental-features 'nix-command flakes'`. Temporary
  containers or VMs only through `/usr/local/bin/agent-resource` (read `/home/me/Code/dashboard/docs/agent-resources.md`
  first; `agent-resource run --task … --ttl 2h -- …`), and release what you lease.
- **Android emulator** (M): the AVD `whombat-mobile` is shared; run your own read-only instance on port 5618
  (`emulator -avd whombat-mobile -port 5618 -read-only -no-window -no-audio -no-boot-anim -gpu swiftshader_indirect`) and
  `adb -s emulator-5618 emu kill` when done. See `apps/mobile/README.md`.
- **Never touch John's real servers, services or DEV box** from tests or scripts, never run an installer or a candidate.
  The lead does the real ones after the merge.
- **Tests** (`docs/decisions/test-speed.md`): unit-test logic (what may show per lock state, deskMayDecide, PIN backoff,
  quiet hours, the status line, glance trimming, WAV parsing/encoding, power reading, talk state machine); fakes in
  process. A new `*.int.test.ts` needs a reason to need Postgres. Check facts (ids, codes, a key phrase), never long
  literal text. Inject clocks and short timeouts, never sleep.
- **Copy**: plain, short English a non-developer understands (`docs/decisions/concise-replies.md`), curly quotes
  (’ “ ”), `·`, `…`, `−`. The mockups' words are the words; new ones in the same voice. The assistant's real name (from
  the runtime), never “Dusty” hard-coded.
- **Tokens only** for UI colours/fonts/radii; match the surrounding code's style and comment density.
- Record your own decisions in your stream's file (see the table's ids: Whombat `docs/decisions/desk-display-server.md`
  (S), `desk-display-talk.md` (T); appliance `console-gui.md` (P), `nixos.md` (K, V), `manager.md` (K); app
  `desk-display-web.md` (W), `desk-display-android.md` (M); C in the contracts notes).
- When done: the quick check green, everything committed, a short report (what you built, what you decided, what is
  left, what the lead must check live). Don't wait for anything after that.

## 2. Wire shapes

Names are binding; field details may be refined by C if a rule of the contracts repo requires it (C tells the lead).
All timestamps RFC 3339 UTC. Display strings are validated the way `ConsoleDisplayText` is (printable, no control or
format characters) with the max lengths below.

### 2.1 Core (`@whombat/core`) — C

- `domain/desk.ts`:
  - `DeskLockedView = 'time' | 'summary' | 'everything'`; `DeskNight = 'dim' | 'black'`.
  - `DeskSettings { lockedView: DeskLockedView, quietHours: { enabled: boolean, start: ClockTime, end: ClockTime },
    night: DeskNight, voice: boolean }`; defaults `summary`, `{enabled: true, start: '23:00', end: '07:00'}`, `dim`,
    `true`. Reuse `ClockTime` and the quiet-hours logic of `domain/notify.ts` (`inQuietHours`), extended or wrapped so a
    plain `{start, end}` window works every day.
  - `DESK_PIN_RE = /^\d{6}$/`; `DeskPin` schema.
  - `DeskScreen` (what Settings sees): `{ paired: null | { personId, name, pairedAt }, settings: DeskSettings,
    pairing: null | { expiresAt }, unlockRequest: null | { id, expiresAt }, hasDisplay: boolean, hasMicrophone:
    boolean, hasSpeaker: boolean, hasBattery: boolean, voiceAvailable: boolean }`.
  - `deskMayDecide(approval: Pick<Approval,'action'|'keyId'>): { ok: true } | { ok: false, reason: 'vault' | 'money' |
    'release' | 'delete' | 'keys' | 'outside' }` — false for `vault_use`; `refund`; `deploy`, `merge_pr`,
    `push_shared_branch` to main, `run_command` with category `deploy`, `deploy_production`, `merge`, `push_main`;
    `files_trash` and `run_command` `destructive` and any `connection_call` the connection marks as deleting or
    destroying (find how Servers/connection tools mark that, e.g. guest delete); `grant_key`; `message_external`,
    `mail_send`, `calendar_invite`, `files_share`; and any approval whose `keyId` maps to a risk row (`keyRiskRow`).
    Everything else (an ordinary `connection_call` such as `server_command`, `create_channel`, `custom` without a risky
    key, an ordinary `run_command`) is true. Unit-tested per kind.
  - `DESK_WORDS`: the shared words both the console page (copies them, it can't import) and the apps use — the lock
    chip, statuses, Needs you, Working on, Done today, Answer this on your phone, Unlock as {name}, Confirm on your
    phone, Check your phone, Wrong PIN. {n} tries left., Too many wrong PINs. Try again in {m} min., Pair this screen,
    Hold to talk, or hold the space bar, Listening…, Thinking…, You asked, Heard and spoken on this Whombat, I didn’t
    catch that. Try again?, {assistant} is still working on it. The answer will be in Chat., power lines (§2.4), the
    Settings words (Screen, Pair the screen, While locked it shows: Only the time · A summary · Everything, Quiet hours,
    At night: Dim clock · Black, Talk to {assistant}, Unpair, Change PIN, Your desk screen wants to unlock, Unlock, No).
  - `deskStatusLine(input)`: the glance's status sentence from counts and the worst server/thing, for `summary` and
    `time` (“Everything’s fine.” · “1 thing needs you.” · “3 things need you.” · “pve-02 needs a look.” · “pve-02 is
    down.”), and for `everything` the assistant's own line (“Everything’s fine. I’m {doing}.” plus the first ask's
    “{title} needs a decision.” as a second, muted part). Unit-tested on facts.
  - Power words: `hostPowerText` helpers for the Chat messages of DK-10 (“The power is out. Whombat is running on its
    battery, about {time} left.” · “The power is back.” · “The battery is at {n} %. I’ll shut Whombat down at 10 % to
    keep your data safe.”) and the short lines (“Plugged in · battery kept at {n} %”, “Plugged in · charging · {n} %”,
    “On battery · {n} % · about {time} left”).
- `DispatchContext.desk?: { spoken: boolean }` (core `contracts/runner`): the turn came from the desk screen (spoken or
  typed there); the runner adds one line for it (T).
- Realtime event `desk.changed {}` on topic `me` (to the paired person and to owners): refetch `desk.get`.

### 2.2 Session ops (`@whombat/protocol/session`) — C

Session-native, channel `app`, in `SESSION_SPECS` and the safety table; feature **`desk`** (`SINCE_0_100`).

| Op | In → Out | Who | Safety |
|---|---|---|---|
| `desk.get` | `{}` → `DeskScreen` | owners and the paired person | READ |
| `desk.startPairing` | `{}` → `{ expiresAt }` | owners | NEVER |
| `desk.pair` | `{ code: ClaimLetters, pin: DeskPin }` → `DeskScreen` (secret) | owners | NEVER |
| `desk.setPin` | `{ pin: DeskPin }` → `DeskScreen` (secret) | the paired person | NEVER |
| `desk.update` | `Partial<DeskSettings>` → `DeskScreen` | the paired person | NEVER |
| `desk.unpair` | `{}` → `DeskScreen` | owners | DESTRUCTIVE |
| `desk.answerUnlock` | `{ id, unlock: boolean }` → `{ ok: true }` | the paired person | NEVER |

Errors (existing codes where they fit, words in `DESK_WORDS`): `wrong_code` (with `triesLeft`), `pairing_expired`,
`not_paired`, `forbidden`/`not_owner`, `request_expired`. Bump `SESSION_API_LEVEL` only if `docs/publishing.md` says so.

`HostNow.power?` (protocol `session/host.ts`, Go generated): `{ source: 'ac' | 'battery', percent: 0..100,
charging: boolean, minutesLeft: int | null, chargeLimit: 0..100 | null, since: Timestamp | null }` (`since` = on
battery since). Absent on machines without a battery.

### 2.3 Desk socket (`@whombat/control-contracts/local`, TS + generated Go + vectors) — C

Runtime ⇄ console server, HTTP/1.1 JSON over the unix socket `DESK_SOCKET_DEFAULT = /run/whombat/console/desk.sock`
(env `WHOMBAT_DESK_SOCKET`; unset → no desk). Created by the runtime 0660 in the setgid console directory (group
`whombat-console`): only the runtime and the console server can connect (as the admin socket, MR-15; Node can't read
SO_PEERCRED). `DESK_PATHS`:

| Path | Request | Answer |
|---|---|---|
| `GET /v1/desk/state` | — | `DeskState` |
| `POST /v1/desk/unlock` | `{ v:1, pin }` | `DeskUnlockAnswer { v:1, result: 'unlocked' \| 'wrong' \| 'backoff', triesLeft?, retryAt? }` |
| `POST /v1/desk/unlock/phone` | `{ v:1 }` | `{ v:1, expiresAt }` |
| `POST /v1/desk/lock` | `{ v:1 }` | `{ v:1 }` |
| `POST /v1/desk/touch` | `{ v:1 }` | `{ v:1, until }` (keeps an unlocked screen unlocked; 409 when locked) |
| `POST /v1/desk/decide` | `{ v:1, number, decision: 'approve' \| 'decline' }` | `{ v:1 }` · 409 `locked` · 403 `on_phone` · 404 · 409 `decided` |
| `POST /v1/desk/talk` | `{ v:1, text? (≤ 500), audioWav? (base64, 16 kHz mono s16le, ≤ 30 s), continue: boolean }` | `{ v:1, id }` · 409 `locked` · 503 `voice_unavailable` · 409 `busy` |
| `POST /v1/desk/talk/get` | `{ v:1, id }` | `DeskTalk` |
| `POST /v1/desk/talk/audio` | `{ v:1, id }` | `audio/wav` bytes · 404 |

```
DeskState {
  v: 1, now,
  paired: null | {
    person: { name (≤ 40), initial (1–2), tone: 1..5 },
    assistant: { name (≤ 40), look: AgentRole },          // the face to draw (@whombat/avatars role)
    timeZone: IANA, lockedView, night, quiet: boolean,     // quiet = inside quiet hours now
    voice: boolean,                                         // Talk on and possible
  },
  pairing: null | { code: ClaimLetters, expiresAt },        // shown big on the screen while Settings pairs
  lock: { state: 'locked' | 'unlocked' | 'phone' | 'backoff', until?, retryAt?, expiresAt? },
  glance: null | DeskGlance,                                // null when not paired
  power: null | DeskPower,
  talk: null | DeskTalk,                                    // the latest, so a reloaded page picks it up
}
DeskGlance {
  status: { text (≤ 200), more?: (≤ 200) },                 // more = the muted second part
  needsYou: { count, items: DeskAsk[] (≤ 5) },             // items empty unless shown (DK-03) or unlocked
  working: null | { title (≤ 120), steps: { label (≤ 40), state: 'done' | 'now' | 'next' }[] (≤ 6) },
  done: { text (≤ 120), at }[] (≤ 3),
  servers: DeskServer[] (≤ 4), moreServers: int,
  tiles: DeskTile[] (≤ 4),
}
DeskAsk { number, kind: 'approval' | 'question', title (≤ 120), at, where? (≤ 40),
          detail? (≤ 400), facts?: string(≤ 80)[] (≤ 3), approveLabel? (≤ 40),
          onDesk: boolean, phoneReason?: 'vault'|'money'|'release'|'delete'|'keys'|'outside' }
          // detail/facts/approveLabel only when unlocked
DeskServer { name (≤ 40), mark (≤ 32, a @whombat/brand mark key: proxmox, unraid, linux, …),
             state: 'ok' | 'warn' | 'bad' | 'off', note (≤ 40, “up 41 d”, “updating”),
             cpu?: DeskMeter, memory?: DeskMeter, temp?: DeskMeter }
DeskMeter { value: number, tone: 'ok' | 'warn' | 'bad' }   // cpu/memory %, temp °C
DeskTile  { icon: 'temperature' | 'heat' | 'sun' | 'power' | 'lock' | 'light' | 'water' | 'network' | 'generic',
            mark? (≤ 32), value (≤ 24), label (≤ 48), tone?: 'ok' | 'warn' | 'bad' }
DeskPower { source: 'ac' | 'battery', percent, charging, minutesLeft: int | null, chargeLimit: int | null,
            since: Timestamp | null }
DeskTalk  { id, state: 'transcribing' | 'thinking' | 'answered' | 'failed',
            question? (≤ 500), answer? (≤ 600), thing: null | DeskServer, audio: boolean,
            reason?: 'not_heard' | 'slow' | 'voice_unavailable' | 'failed' }
```

### 2.4 Voice socket (`@whombat/control-contracts/local`) — C

Runtime → `whombat-voice`, HTTP/1.1 JSON over `VOICE_SOCKET_DEFAULT = /run/whombat-voice/voice.sock` (env
`WHOMBAT_VOICE_SOCKET`; unset → no voice). `VOICE_PATHS`:

| Path | Request | Answer |
|---|---|---|
| `GET /v1/voice/health` | — | `{ v:1, stt: boolean, tts: boolean, microphone: boolean, speaker: boolean }` |
| `POST /v1/voice/stt` | `{ v:1, audioWav (base64, 16 kHz mono s16le, ≤ 30 s), prompt? (≤ 400) }` | `{ v:1, text (≤ 500), seconds }` |
| `POST /v1/voice/tts` | `{ v:1, text (≤ 600) }` | `{ v:1, audioWav (base64) }` |

`microphone`/`speaker`: a capture/playback PCM device exists (`/proc/asound/pcm`). Errors 400 `bad_audio`, 413, 503
`busy` (one job at a time, a queue of 2).

### 2.5 Console server API (appliance, Go) — K; the page uses it — P

The page keeps polling `GET /api/state` (1 s). It gains `desk: DeskState | null` (null when the socket is missing or
doesn't answer within 1 s; the server caches the runtime's answer for 1 s). New, all behind the page token, JSON, each
a thin checked pass-through to §2.3: `POST /api/desk/unlock {pin}`, `/api/desk/unlock/phone`, `/api/desk/lock`,
`/api/desk/touch`, `/api/desk/decide {number, decision}`, `/api/desk/talk {text? | audioWav?, continue}` (body ≤ 1.5
MiB; everything else ≤ 1 KiB), `/api/desk/talk/get {id}`, `GET /api/desk/talk/audio?id=` (`audio/wav`). Errors keep
the runtime's status and code. CSP: `media-src 'self' blob:` (header in `web.go` and the meta in `index.html`).

## 3. Streams

**C — contracts.** §2.1–2.4 with tests and vectors as the repo does them (`pnpm gen`, `pnpm gen:check`, conformance
registry, `docs/local-ipc.md`, `docs/cross-language.md`, `docs/session-protocol.md`, CT rows in
`docs/decisions/contracts.md`). Then bump to 0.100.0, tag `contracts-v0.100.0` on `desk` and `pnpm release` →
`dist-release/0.100.0/`. Report the dist path and stop. (If the lead asks for an additive change later, it is 0.100.1.)

**S — server core** (`apps/server/src/desk/`, own files; T owns `talk.ts`, `voice.ts` and `testing/fake-voice.ts`).
- Table `desk_screens` (migration 0122 + `compat.json`): one row per box (`id = 1`), `burrow_id`, `person_id`,
  `pin_hash` (scrypt, salted), settings columns, `paired_at`, `wrong_pins`, `retry_at`; commands through the pipeline
  (`pair_desk`, `set_desk_pin`, `update_desk`, `unpair_desk`, `desk_wrong_pin`); pairing letters, their expiry and the
  unlock state in memory (one screen per box; a runtime restart locks it and ends a pairing).
- The desk socket (`WHOMBAT_DESK_SOCKET`, started in `managed/boot.ts` beside the admin socket; 0660, chown to the
  console group as `writeConsoleFile` does) with §2.3's routes; the talk routes call T's exported handlers
  (`createDeskTalk(services, desk)` returning `{ start, get, audio, latest }`; stub them until T lands).
- The glance (§2.3) for the paired person: `homeOverview` pieces (export what's module-private: `workingOn`, …),
  `needsYou` + the approval rows (`deskMayDecide`, approve label from `approvalView`), servers from the hosts things
  (worst first, then name; marks from the server's OS/platform), tiles from pinned things first then things with a
  “now” figure, Done today in the person's time zone, the assistant's `doing` line, `deskStatusLine`; trimmed by
  lock state and `lockedView` (DK-03) — the runtime is the authority. Cached; rebuilt on `home.changed` for the
  person, every 10 s for figures, at once on lock changes.
- Unlock (DK-04): PIN check, sliding 2 minutes (`touch`), backoff 1 min doubling to 1 h after 5 wrong, one Chat
  message to the person at the fifth; phone unlock: a request `{id, expiresAt 2 min}`, push `forAccounts(kind
  'security', preview “Your desk screen wants to unlock”, collapse per request, clear when answered or expired)`, event
  `desk.changed`; `desk.answerUnlock` unlocks.
- Decide (DK-05): `decide_approval` committed with the paired person as actor, only when unlocked and `deskMayDecide`;
  a question opens nothing here (the page sends the person to Talk with `continue`=false; T posts it in Chat).
- Session ops §2.2 with their checks; feature `desk` advertised when the desk socket runs; `hasDisplay` from
  `/sys/class/drm/*/status` = connected, `hasBattery` from the manager's power, microphone/speaker/voice from T's
  `voiceHealth()`.
- Power (DK-10): the manager's `power` via host metrics; housekeeping every minute: on battery ≥ 1 min → one message
  to owners (as host disk alerts do, through their assistant), back on AC → one, ≤ 15 % → one; DeskPower in the state.
- Tests: unit for trimming, backoff, pairing, power edges; an int test only for the commands/table.

**T — server talk** (`apps/server/src/desk/talk.ts`, `voice.ts`, `testing/fake-voice.ts`; `packages/agent-runtime`
and `apps/runner` for the prompt line).
- `voice.ts`: the §2.4 client (`WHOMBAT_VOICE_SOCKET`), `voiceHealth()` cached 60 s.
- Talk (DK-06): audio → STT with a prompt of the assistant's name, the burrow's server and thing names; empty text →
  `failed/not_heard`. The question goes to the person's Chat: a new thread through `startChat` (actor = the person),
  or, with `continue` within 2 minutes of the last desk talk, a reply in that thread; the turn gets
  `DispatchContext.desk = {spoken}` and the runner adds one line (“This came from the screen on the person's desk
  {by voice}: answer in one or two short sentences that read well aloud — no lists, links, tables or code.”). Wait on
  the bus for the assistant's reply in that thread (≤ 90 s, injectable) → `answered` with the reply's text made plain
  for speech (no markdown), TTS when voice is on (audio kept in memory, ≤ 5 talks, 10 min), the `thing` = the first
  server named in the answer, else in the question (`DeskServer` from S's glance builder). Too slow → `failed/slow`
  (the answer still lands in Chat). One talk at a time (409 `busy`).
- A fake voice service for dev and tests (fixed transcripts, a short generated WAV); the managed dev world uses it.
- Tests: the talk state machine with fakes and a fake clock; the runner line present when `desk` is set.

**K — kiosk + host** (appliance; owns `console/cmd`, `console/internal`, `nix/modules/{kiosk,console,runtime,manager}.nix`,
new `nix/modules/power.nix`, `manager/`, `third_party/whombat-contracts-go`, `vm-tests/console-self.nix`, flake checks).
- Re-vendor contracts-go 0.100.0 when C has released it (the manager compiles against it; fix what the jump from 0.78
  needs; ask the lead if it is more than mechanical). Until then build against §2's shapes in a local branch of types.
- Console server: §2.5 (dial flag `--desk-socket`, peer pattern from `manager/internal/runtimeapi`, parse + validate
  with the generated `local` types and `Clean` every display string, 1 s cache, `/api/state` `desk`, the POSTs with
  their body limits, `--once --json` keeps agreeing with `/api/state`), tests in `consoleapi`.
- Runtime env: `WHOMBAT_DESK_SOCKET`, `WHOMBAT_VOICE_SOCKET` (V's socket; the runtime user may connect).
- Kiosk (DK-08, DK-09, DK-11): real GPU driver (amdgpu, i915, xe, nouveau, radeon) → `WLR_RENDERER` auto/gles2,
  Chromium with GPU and without forced reduced motion; otherwise as today (`hardware.graphics.enable` for the drivers);
  audio capture allowed for the console origin only (`AudioCaptureAllowedUrls`), playback via ALSA (logind gives the
  seat's session `/dev/snd`; check Chromium falls back to ALSA without PulseAudio); the browser loop reads
  `desk` from `/api/state`: paired → no idle sleep; quiet + `black` → Chromium stopped and backlight 0 (a touch shows
  it for a minute); quiet + `dim` → backlight low; otherwise the normal level (logind `SetBrightness` from the kiosk's own
  session, no root); a portrait panel → `wlr-randr --transform` to landscape (option `whombat.kiosk.transform`, default
  `auto`). Keep everything `console-self` and `checks.console` check, update them for the new behaviour, and add a
  check for a paired desk (fake runtime socket) in `console-self`.
- Host (DK-10, DK-11): `power.nix` — logind ignores lid/cover switches, power key short = ignore (wakes the screen),
  long press = poweroff; UPower with `percentageAction = 10`, `criticalPowerAction = "PowerOff"`, percentage policy;
  a udev rule setting `charge_control_end_threshold` = 80 where it exists (option `whombat.power.chargeLimit`).
- Manager (MG-69…): `power` in host metrics from `/sys/class/power_supply` (Mains online, Battery capacity/status,
  energy/charge now and power/current now for minutes left, the threshold), `since` kept across samples; unit tests with
  fixture sysfs trees.
- Verify: `go test` for console and manager, `nix build` of the appliance system and `checks.console`, `console-self`
  once at the end (it is a VM test; lease nothing, run it as the flake runs VM tests).

**V — voice** (appliance; owns `voice/` (Go module or a package in the root module, as the repo does it),
`nix/packages/voice-*`, `nix/modules/voice.nix`).
- `whombat-voice` (§2.4): user `whombat-voice`, no network (`PrivateNetwork`, `IPAddressDeny=any`), socket 0660 group
  of the runtime user (`whombat`), one job at a time; STT = `whisper-cli` from nixpkgs `whisper-cpp` 1.8.4 with
  `ggml-small.en-q5_1.bin` (fetchurl, fixed hash; MIT); TTS = nixpkgs `piper-tts` 1.4.2 with one English voice whose
  licence allows redistribution (check the model card; record it; prefer CC0/CC-BY/MIT). Name the model derivations
  without a `whombat-` prefix (the image secret scan). WAV in/out checks; temp files on a private tmpfs, removed after
  each job. Health reads `/proc/asound/pcm`. Memory cap and low CPU weight.
- Tests: Go unit tests (WAV parsing, request limits, the queue), a Nix check that transcribes a short committed WAV
  fixture (spoken “is pve two okay”; generate it with piper itself in the check) and that TTS returns valid WAV.
- Report the closure size added.

**P — console page** (appliance `console/ui`; owns it all, plus `scripts/vendor-app.sh`).
- The desk scenes (mockups 1–4) on a 1280×800 stage (`Stage` scales by `min(w/1280, h/800)` for desk scenes; the claim
  scenes keep 1024×768): Glance per lock state and `lockedView`; the pairing letters screen; Unlock (PIN pad, Confirm on
  your phone → Check your phone with the countdown, wrong/backoff); the ask sheet (Approve with `approveLabel` · Not
  now · Ask; `onDesk` false → Answer this on your phone); Talk (hold the button or the space bar; capture with
  `getUserMedia`, 16 kHz mono 16-bit WAV encoded in the page, ≤ 30 s, live level bars; Listening…/Thinking…; the answer,
  the thing card, playback of `/api/desk/talk/audio`; typing when a keyboard is used); quiet hours' dim clock; power chip
  and the on-battery banner; new-ask wake (undim, amber edge, one soft WebAudio tone in the day); lock chip “Unlocked as
  {name} · locks in {n} min” and the lock button; sends `/api/desk/touch` at most every 20 s while touched.
- Refresh the vendored app assets to the newest app tag (avatars by role for `assistant.look`, tokens, fonts) and vendor
  the brand marks the servers use (`@whombat/brand` marks: proxmox, unraid, linux and the OS/platform marks
  `serverMark` can return).
- Fixtures for every scene and sub-state (`?demo=`), `pnpm shots` at 1280×800, 2560×1600 and 1024×768; compare with
  the mockups and fix differences. Copy from `DESK_WORDS` (copied; a test checks they match the contracts' words once
  the lead vendors 0.100.0 — until then against §2.1's list).

**W — web** (whombat-app; owns `packages/client` desk model + `apps/web`).
- Client: ops (`desk.*` in `session/managed-ops.ts`), `useDesk` model refetched on `desk.changed`, `FEATURE_NAMES`
  entry `desk`, the power line words in the host model.
- Settings → This Whombat → Overview: a **SCREEN** section (feature `desk`, owners and the paired person; shown when
  `hasDisplay` or paired): unpaired — one line and **Pair the screen** → a dialog: “Type the 4 letters on the screen”
  (`LettersInput`) and a 6-digit PIN twice → `desk.pair`; paired — “Paired with {name} · since {date}” [Unpair],
  PIN [Change PIN], While locked it shows (segmented Only the time · A summary · Everything), Quiet hours (switch, from,
  to, At night: Dim clock · Black), Talk to {assistant} (switch; disabled with a reason when there's no microphone or
  voice).
- The unlock request: a shell notice (as `PasskeyNotices`) “Your desk screen wants to unlock.” [Unlock] [No] and a row
  in This Whombat's NEEDS YOU, while `unlockRequest` is set.
- “How it’s doing” shows the power line when `power` is present.
- Fake world + fixtures; visual check 1440×900 light and dark against the surrounding Settings style.

**M — Android** (whombat-app `apps/mobile`; uses W's client model — `git merge desk-web` is not allowed, so build
against the shapes and merge `desk` when the lead says W's client landed).
- The SCREEN card on the This Whombat screen with the same rows (pairing sheet with `LettersField` + PIN, segmented
  choice, quiet hours with time pickers, switches), the unlock request card at the top of the This Whombat screen and
  the push (kind `security`; tap opens This Whombat), the power line in How it’s doing. 44 px targets. Emulator check
  light and dark.
