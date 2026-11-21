# Sign in at the box — build brief (2026-10-20)

Decisions: `docs/decisions/signin-at-box.md` **BX-01…BX-08** (read them first, with the threats). In short: claiming no
longer ends with the recovery kit; a device that isn't let in asks the box for a code, the box shows six letters on its
own screen, the person types them on the device, and a CPace exchange bound to both Noise keys (the claim's, CC-06/CC-07)
lets the device in to the account it named. Then read §1, §2 and your stream's part of §3.

| Stream | Repo | Worktree | Branch | Ids |
|---|---|---|---|---|
| C contracts | whombat-contracts | `~/Code/.wt/contracts-box` | `box-signin` | CT-620…CT-639, 0.106.0 |
| S server | Whombat | `~/Code/.wt/whombat-box` | `box-signin` | BX-S01… (`docs/decisions/signin-at-box.md` §Server) |
| P console | the appliance | `~/Code/.wt/appliance-box` | `box-signin` | CG-150…CG-169 (`docs/decisions/console-gui.md`) |
| W app | whombat-app | `~/Code/.wt/app-box` | `box-signin` | AP-3500…AP-3524 web, AP-3525…AP-3549 Android |

All branches start from `main`. Contracts main has 0.105.0 (the voice-choice session's; Whombat and app main are still on
0.104.0 and a peer session is merging voice-choice into them). The lead merges main into your branch when that lands,
releases contracts and the app, vendors where you can't, merges and ships.

## 1. Rules for every stream

- Work only in your worktree on your branch; commit small and often (`contracts: …`, `server: …`, `console: …`,
  `client: …`, `web: …`, `mobile: …`, `docs: …`), every message ending with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never push, never merge into `main`, never touch the main
  checkouts (`~/Code/Whombat`, `~/Code/whombat-app`, `~/Code/whombat-contracts`, `~/Code/whombat-appliance`): other
  sessions work there.
- **Contracts 0.106.0.** C builds them first. S, P and W start at once against §2's shapes (a local stand-in type is
  fine; replace it once vendored). When the lead says 0.106.0 is released (`~/Code/whombat-contracts/dist-release/0.106.0/`),
  vendor it in your branch as the last vendoring did (Whombat `git log --grep 'deps: @whombat contracts'`, app the same,
  appliance `git log --grep 'contracts-go'` for `third_party/whombat-contracts-go` and the console's
  `console/ui/vendor/whombat-contracts/`): `vendor/whombat-contracts/<v>/`, `package.json`, `pnpm-workspace.yaml`,
  `pnpm install`, commit `deps: @whombat contracts 0.106.0 (…)` with the lockfile; Go from the release's
  `whombat-contracts-go-0.106.0.tar.gz`, `go.mod`, and any Nix `vendorHash` that moves. Need a contract change? Don't
  edit vendored files: tell the lead the exact additive change.
- **DEV fast** (John's rule): one quick check at the end — `pnpm format` then `TMPDIR=~/.cache/wb-tmp pnpm check`
  (appliance Go: `go vet ./... && go test ./...` in the modules you touched; `console/ui`: `pnpm check` there; Nix: the
  `nix build` attributes named in your §3), plus `pnpm test:server` once (S). Run single test files while you work. No VM
  gates, no CI waits. Own ports (S 4570, W 4574/5274) and throwaway databases; the shared `docker compose` (Postgres
  :55432, Mailpit) is never stopped or reset. `/tmp` runs out of inodes: `TMPDIR=~/.cache/wb-tmp`. Nix needs
  `--extra-experimental-features 'nix-command flakes'`. Temporary containers or VMs only through
  `/usr/local/bin/agent-resource` (read `/home/me/Code/dashboard/docs/agent-resources.md` first), released after.
- **Android emulator** (W): the AVD `whombat-mobile` is shared; run your own read-only instance on port 5624
  (`emulator -avd whombat-mobile -port 5624 -read-only -no-window -no-audio -no-boot-anim -gpu swiftshader_indirect`) and
  `adb -s emulator-5624 emu kill` when done. See `apps/mobile/README.md`.
- **Never touch John's real servers, services or DEV box** from tests or scripts; never run an installer or a candidate.
- **Tests** (`docs/decisions/test-speed.md`): unit-test logic (letters, normalization, the PAKE both ways and with a
  wrong password or swapped keys, the limits and backoff, the console file's validity rule, the screen's panel state,
  the app's step machine). A new `*.int.test.ts` needs a reason to need Postgres (`trust.int.test.ts` or
  `claim-code.int.test.ts` can grow). Check facts (ids, codes, a key phrase), never long literal text. Inject clocks
  and short timeouts, never sleep.
- **Copy**: §2's words are the words (curly quotes ’ “ ”, `·`). Tokens only for UI colours/fonts/radii; match the
  surrounding code's style and comment density.
- Record your own decisions in your stream's file (S: §Server of `signin-at-box.md`, replacing the placeholder row;
  P: `console-gui.md` CG-150…; W: app `docs/decisions/signin-at-box-web.md` and `signin-at-box-android.md`; C: the
  contracts notes as CT-620…).
- When done: the quick check green, everything committed, a short report (what you built, what you decided, what is
  left, what the lead must check live). Don't wait for anything after that.

## 2. Wire shapes (0.106.0, all additive)

### `@whombat/protocol/claim` — the screen sign-in's letters and PAKE (new `claim/screen.ts`, exported from the index)

```ts
export const SCREEN_SIGNIN_LETTERS_LENGTH = 6;
/** Six letters from CLAIM_CODE_ALPHABET (BX-04), in order: the PAKE password. */
export const ScreenSignInLetters = z.string().regex(/^[ABCDEFGHJKMNPQRTVWXY]{6}$/);
/** CT-58's byte rule for six letters (bytes < 240, b % 20; skip the rest; ask for as many as are missing). */
export function generateScreenSignInLetters(randomBytes: (n: number) => Uint8Array): string;
/** Typed input → letters: ASCII upper-case, drop the claim code's whitespace set and `-`; six alphabet letters or null. */
export function normalizeScreenSignInLetters(input: string): string | null;
/** `KXQMTR` → `KXQ MTR` (display only). */
export function formatScreenSignInLetters(letters: string): string;

export const SCREEN_SIGNIN_CI_TAG = 'whombat-screen-signin/1';
export const SCREEN_SIGNIN_CONFIRM_INFO = 'whombat-screen-signin-confirm/1';
export interface ScreenSignInPakeContext {
  password: string;          // the six letters
  deviceId: string;          // the box's device id (appliance_state.claim_device_id; the app's `/appliances/<device>`)
  appliancePeerId: string;   // as this side sees it in Noise
  clientPeerId: string;      // as this side sees it in Noise
  signinId: string;          // sid
}
// CI = lv_cat(SCREEN_SIGNIN_CI_TAG, deviceId, appliancePeerId, clientPeerId); sid = UTF-8(signinId); ADa = ADb = empty;
// tags as claimConfirmTags but with SCREEN_SIGNIN_CONFIRM_INFO. Same share/tag shapes (ClaimPakeShare, ClaimConfirmTag).
export function screenSignInPakeInitiator(ctx, randomBytes): { share: string; state: … };
export function screenSignInPakeInitiatorFinish(state, applianceShare: string): ClaimConfirmTags;
export function screenSignInPakeResponder(ctx, clientShare: string, randomBytes): { share: string; tags: ClaimConfirmTags };
// claimConfirmEqual compares the tags (constant time).
```

Reuse `cpace.ts` and the claim's helpers (factor the shared parts out of `pake.ts` rather than copying them). Own
vectors: one fixed run in a test (and in `vectors/` if the claim's vectors live there; the Go side doesn't need the PAKE).

### `@whombat/protocol/session` — ops (`enrollment.ts`, `operations.ts`, `errors.ts`, `operation-safety.ts`)

```ts
export const ScreenSignInId = z.string().min(8).max(64).regex(/^[A-Za-z0-9_-]+$/);
export const SCREEN_SIGNIN_TTL_S = 300;            // the code shows this long (BX-02)
export const SCREEN_SIGNIN_REQUESTS_PER_KEY = 5;   // per device key per hour (BX-05)
export const SCREEN_SIGNIN_REQUESTS_TOTAL = 30;    // per box per hour
// The begin's TTL is ENROLL_CLAIM_BEGIN_TTL_S (120 s); backoff is claimBackoffSeconds (BX-05).

/** Ask the box to show a code for this device (channel `enroll`, ephemeral like enroll.claim.begin). */
export const EnrollScreenRequestInput = z.strictObject({ email: Email, endpoint: NewEndpoint });
export const EnrollScreenRequestOutput = z.object({ signinId: ScreenSignInId, expiresAt: Timestamp });

/** CPace step 1 with the letters (ephemeral, like enroll.claim.begin). */
export const EnrollScreenBeginInput = z.strictObject({ signinId: ScreenSignInId, share: ClaimPakeShare });
export const EnrollScreenBeginOutput = z.object({ share: ClaimPakeShare });

/** CPace step 2: lets the device in (like enroll.claim; never retried automatically). */
export const EnrollScreenInput = z.strictObject({ signinId: ScreenSignInId, confirm: ClaimConfirmTag });
export const EnrollScreenOutput = EnrolledOutput.extend({ confirm: ClaimConfirmTag });
```

Ops: `enroll.screen.request`, `enroll.screen.begin` (both `session(…, 'enroll', true, true)` like `enroll.claim.begin`),
`enroll.screen` (like `enroll.claim`; `NEVER` in operation-safety). Add them to the unenrolled list in the module comment
and wherever the enroll channel's allowed ops are listed. `EnrollClaimOutput.recoveryKitRequired` stays (the runtime
answers `false` now; say so in its comment). Bump `SESSION_API_LEVEL` to 41 and note what level 41 adds.

Application codes (`error.details.code`, add to the codes list in `errors.ts` with their `ErrorCode`):

| code | ErrorCode | when |
|---|---|---|
| `screen_unavailable` | `unavailable` | not claimed, or this box writes no console file (no screen to show on) |
| `screen_no_account` | `not_found` | no account with that email on the box |
| `screen_signin_missing` | `conflict` | no live sign-in with this id for this device key (expired, replaced, used) |
| `screen_begin_missing` | `conflict` | `enroll.screen` without a live begin on this session for the same id, or one made before a wrong guess |
| `screen_code_invalid` | `forbidden` | the client's tag didn't match: one wrong guess; the screen shows new letters |
| `screen_backoff` | `rate_limited` | too many wrong guesses; `details.retryAt` (a `ScreenBackoffDetails` like `ClaimBackoffDetails`) |
| `screen_share_invalid` | `validation_failed` | the share isn't a valid element (not a guess) |
| `screen_rate_limited` | `rate_limited` | over BX-05's request limits |

plus the existing `endpoint_enrolled`.

### `@whombat/control-contracts/local` — the console file (`ConsoleState`, `consoleStateValid`)

```ts
/** A device waiting to sign in at the box's screen (BX-06): only in `claimed`. */
export const ConsoleSignIn = z.object({
  code: ScreenSignInLetters,     // the six letters; the console shows them grouped 3 + 3
  name: ConsoleDisplayText,      // the account's name (else its email)
  device: ConsoleDisplayText,    // the new device's label, as it asked
  expiresAt: Rfc3339,
});
ConsoleState gains   signIn: ConsoleSignIn.optional()
consoleStateValid: signIn only when state === 'claimed'.
```

Regenerate the cross-language output (`pnpm gen`, `gen:check` clean) so Go gets `ConsoleSignIn` and the field. If the
Go side has a handwritten `ConsoleStateValid`, update it too.

### `@whombat/core` / audit

`endpoint.enrolled`'s `via` gains `'screen'` wherever the contracts list the enrollment ways (audit detail schemas,
`APPLIANCE_EVENT_TYPES` stays). No new event types.

### Copy

**App** (`packages/client/src/managed/copy.ts`, new block `screen`):

```ts
screen: {
  way: 'At your Whombat? Its screen can show a code for this device.',
  use: 'Use its screen',
  kicker: 'ADD THIS DEVICE',
  title: 'Use your Whombat’s screen',
  sub: 'Your Whombat shows a code on its own screen. If it runs in a virtual machine, that’s the machine’s console.',
  tip: 'Only someone who can see your Whombat’s screen can let a device in this way.',
  email: 'Your email on this Whombat',
  show: 'Show a code',
  typeTitle: 'Type the code from its screen',
  typeSub: 'Your Whombat’s screen now shows six letters for this device. Type them here.',
  letters: 'Letters on the screen',
  go: 'Let this device in',
  newCode: 'Show a new code',
  errors: {
    screen_code_invalid: 'That isn’t it. Your Whombat now shows new letters.',
    screen_signin_missing: 'That code ran out. Show a new one.',
    screen_no_account: 'Nobody on this Whombat has that email.',
    screen_unavailable: 'This Whombat has no screen to show a code on.',
    screen_backoff: 'Too many wrong codes. Try again in {min} min.',
    screen_rate_limited: 'Too many codes asked for. Wait a little and try again.',
    letters: 'Type the six letters from the screen.',
    old: 'Your Whombat needs an update before its screen can let devices in.',
    notThisOne: 'This isn’t the Whombat whose screen you’re looking at.',
  },
},
```

Changed: `pair.recover` → `'Have a recovery kit? Use it instead'`; `setup.ways[2]` → `'A recovery kit, if you made one.'`;
`kit.kicker` → `'RECOVERY KIT'`; `kit.sub` → `'If you lose every signed-in device and can’t get to your Whombat’s screen, the kit lets a device back in.'`;
the kit-missing row (`MANAGED_TEXT.kitMissing` / `kitMissingMeta`) → title `'No recovery kit'`, meta
`'Not needed: you can sign in at your Whombat’s screen. A kit helps if it has no screen.'`, action `'Make a kit'`.
Every claim step kicker that counted the kit (`… OF 3`) counts without it.

**Box screen** (console UI and the text console):

- kicker `NEW DEVICE`
- title `{name} wants to sign in`
- the device line `{device}`
- the letters, large, grouped `KXQ MTR`
- `Type these letters on that device.`
- `Didn’t ask for this? Ignore it: the code goes away in {m} min.` (whole minutes, rounded up; `in 1 min` under a
  minute). The text console may use the straight apostrophe if its font lacks ’ (follow what it does today).

## 3. Streams

### C — contracts (`~/Code/.wt/contracts-box`)

§2 exactly; tests for letters (byte rule, rejection of 240+), normalization, display grouping, the PAKE (both sides agree;
wrong letters, swapped PeerIds, other signinId or deviceId → tags differ; a fixed vector), the ops' schemas, the console
file rule (signIn only in claimed; an older parser strips it). Version 0.106.0 in every package, `pnpm check`,
`pnpm gen:check`, `pnpm test:go`. Commit; **don't run `pnpm release`** — tell the lead when the branch is ready (the
lead merges and releases).

### S — server (`~/Code/.wt/whombat-box`)

- `managed/trust.ts` (or a new `managed/screen-signin.ts` the trust service uses, like `reenroll.ts`): the three ops,
  dispatched where `enroll.claim.begin`/`enroll.claim` are. One live sign-in per box in memory: `{signinId, peerId (the
  requesting key), accountId, name, device label/platform, letters, expiresAt, generation}`; a new request replaces it.
  `begin` only from the requesting key, kept per session like `claimBegin` (`SessionScope`), password and generation
  taken together; `enroll.screen` checks the tag in constant time first; a mismatch counts one failure, rotates the
  letters (the sign-in stays until it expires), ends live begins. A match inserts the endpoint (`insertEndpoint`,
  `via: 'screen'`, `by: null`) in one transaction, clears the failure counter, ends the sign-in, sends the `security`
  push to every owner and the account (as `reenroll.ts`/`passkeys.ts` do), and answers `enrolledOutput + {confirm:
  tags.appliance}`. The account: by email, trimmed and lower-cased, as accounts are stored; refuse accounts that can't
  sign in any more if the runtime has such a state.
- Limits (BX-05): requests per key/box per hour (an advisory-locked count like `recordClaimAttempt`, or memory if you
  can argue a restart doesn't matter for request counts — failures must persist); failures in their own table (migration
  **0126**, `expand`, floors as the migration rules say; 0125 is the voice-choice session's) or a `kind` on
  `appliance_claim_failures` — your choice, write why. When the backoff starts: one `security` push to owners.
- The console file (`managed/claim.ts`): `ConsoleState.signIn` while a sign-in is live (and claimed); rewritten on
  request, rotation, use, replacement, expiry (schedule the expiry like the backoff) and at `close()` (gone).
  `screen_unavailable` when `WHOMBAT_CONSOLE_FILE` isn't set or the box isn't claimed. Name: the account's name, else
  its email, made a valid `ConsoleDisplayText` (trim, cut to 64 code points, drop what the regex refuses); same for the
  device label. Never log the letters.
- `enroll.claim` answers `recoveryKitRequired: false` (BX-01). `EnrolledVia` gains `'screen'` (DB type, any check
  constraint — a migration if there is one).
- Tests: the happy path both ways with the contracts' initiator; wrong letters → rotate + count + new file; another key
  can't begin; replaced/expired → `screen_signin_missing`; begin before a wrong guess can't confirm; backoff + push;
  request limits; no console file → `screen_unavailable`; the file's `signIn` appears and goes. Prefer unit tests with
  fakes; extend an existing `*.int.test.ts` for what needs Postgres.
- Docs: BX-S rows in `signin-at-box.md`; a line in `DECISIONS.md` (new section “Sign in at the box”); a note on MR-11/MR-25
  in `managed-runtime.md` that BX-01/BX-02 amend them; `ARCHITECTURE.md`'s trust paragraph names the screen sign-in.

### P — console (`~/Code/.wt/appliance-box`)

- `console/internal/screen` (`state.go`): parse and validate `signIn` (only in claimed; letters six alphabet letters;
  `name`/`device` through the same display-text rules and stripping as `burrows.first`; `expiresAt` RFC 3339; a bad
  `signIn` drops the panel, never the claim state — like `withoutBurrows`). Hide it once `expiresAt` passed even if the
  file wasn't rewritten.
- `/api/state` carries it to the page; the page (`console/ui`) shows BX-06's panel over **every** claimed scene: the
  plain claimed screen and the desk (glance locked and unlocked, quiet hours, dimmed, turned off, the PIN pad). It wakes
  the screen (counts as activity for the dim and for whatever blanks the display — CG-24/CG-36 and the kiosk's
  blanking, NX-170), with the countdown from §2. Look at how the desk page and the claimed screen are composed and put
  the panel where both get it. Tokens and the console's existing type scale; a demo fixture (`?demo=`) for the panel on
  the claimed screen and on the glance, and the shots at 1024×768 and 1920×1080.
- The text console (CG-05) shows the same words while a sign-in is live.
- Go tests for parsing/expiry; UI tests for the panel's state and countdown. `go vet`/`go test` in the console module,
  `pnpm check` in `console/ui`, and the console's Nix build attribute.
- Record CG-150… in `console-gui.md`. This needs a host release (the lead ships it).

### W — app (`~/Code/.wt/app-box`): client + web first, then Android

- **Client** (`packages/client/src/managed/`): a `screen-signin.ts` step machine shared by web and phone: request →
  type letters → begin → finish → check the box's tag (`claimConfirmEqual`) → pin (`pinSource: 'screen'`, a new
  `PinSource`; replace nothing: a pinned identity that differs from the directory is still the hard stop) → enrolled.
  Error codes → §2's words (`screen_backoff` with minutes from `retryAt`; an unknown op / older runtime → `old`; a tag
  mismatch → `notThisOne`, nothing pinned). The session ops in `session/managed-ops.ts`. The fake world
  (`apps/web/src/managed/fake/world.ts`) learns the three ops (its own letters, shown somewhere the e2e can read them).
- **No kit step** (BX-01): claim → protect → open, on web (`ManagedRoot.tsx`) and Android (`ManagedApp.tsx`);
  `kitPending` false for new claims and ignored for old records; the claim's step kickers renumbered; This Whombat's kit
  row as §2 (quiet, not in Needs you), owners keep “Make a kit” (the existing `RecoveryKitScreen` flow).
- **“Use its screen”** on the pair screen (“Let this device in”, a row like the passkey row, above the email form) and the
  setup screen (“Set up this device”, a way with its button); it opens the screen flow (email prefilled with the
  signed-in email, then the six-letter field: one input, `autocomplete="one-time-code"`, upper-case, accepts spaces,
  shows `KXQ MTR` grouping as typed if simple). Success opens the Whombat like a pairing approval does. On the setup
  screen the device connects with the directory's PeerId for this flow only (BX-03) and pins after the tag checks.
- Android: the same flow in `apps/mobile/src/managed/` (44 px targets, the keyboard's caps, `textContentType`
  `oneTimeCode`), same copy from the client package.
- Tests: the step machine (every error code, the tag mismatch, pin rules), the kit-row change, the claim flow without
  the kit (update `claim-ceremony.test.ts`, `recovery-ceremony.test.ts`, the e2e specs that walked through the kit:
  they now don't, and one e2e walks the screen sign-in against the fake). Visual check of the new screens against the
  surrounding auth screens (same `AuthLayout`, sizes, spacing) in both themes, web 1440×900 and the phone.
- Record AP-3500… (web) and AP-3525… (Android).
