# App, managed appliance: decisions (AP-nn)

Workstream: hosted UI, native clients and the client session (managed-appliance rebuild). The system-wide
decisions are `MA-nn` in `appliance/docs/implementation/architecture.md`; this file records the
finer decisions of `whombat-app`. Earlier decisions of the extracted packages stay in the Whombat repository's
`DECISIONS.md` and `docs/decisions/` (design system B-nn, web, mobile, attachments BP-A…); they still apply
unless an entry here supersedes them.

## AP-01 Standalone repository, two transports

`whombat-app` was extracted from Whombat `c39f1f2` with history (`apps/web`, `apps/mobile`, `apps/widget`,
`packages/{tokens,avatars,brand,client}`, `tools/visual`, `docs/design-handoff`). It builds and tests on its
own: pnpm 12.3.4, Node 24, Biome, Vitest, TypeScript 7, same configs as Whombat.

The web app has two transports, chosen at build time by `VITE_WHOMBAT_TRANSPORT`:

- `http` (default during migration): the legacy self-hosted mode. The app talks to a Whombat server on its
  own origin; `pnpm dev` proxies `/api`, `/ws`, `/collab`, `/mcp`, `/embed` to `WHOMBAT_SERVER_URL`
  (default `http://localhost:$PORT`, 4400). Nothing about the existing self-hosted product changes.
- `session`: the managed mode — cloud sign-in against control, then an end-to-end encrypted appliance
  session through the relay (MA-05…MA-09). No proxy.

`VITE_FIXTURES=1` (visual tests, Storybook) keeps working in either mode.

## AP-02 Contracts from vendored tarballs

`@whombat/core`, `@whombat/canvas-schema`, `@whombat/fixtures`, `@whombat/protocol`, `@whombat/control-contracts` (and
`@whombat/release`, transitively) come from
`vendor/whombat-contracts/<version>/*.tgz`, declared once in the root `package.json` with exactly the paths of the
root `overrides` in `pnpm-workspace.yaml` (which pin the transitive references to the same tarballs). Workspace
packages resolve them from the root `node_modules` (Node, Vite, TypeScript and Metro all look upward). Declaring
them per package as `file:../../vendor/…` made pnpm write importer-relative specifiers that its frozen check
compares against the root-relative override, so `pnpm install --frozen-lockfile` failed in a clean clone
(orchestrator finding R-01); one form fixes it. Every change to dependencies is checked with
`git clone --no-local … && pnpm install --frozen-lockfile`. `pnpm contracts:verify` checks
`SHA256SUMS`. The lockfile was seeded from Whombat's so every third-party version stayed exactly what the
monolith tested; `pnpm install` then pruned what only the server, runner and CLI used.

## AP-03 What moved with the apps

- `examples/feedback/` (the Feedback widget's integration examples) is copied here: the widget's
  `examples.test.ts` and its real-server e2e read them. Whombat keeps its copy until its widget docs move.
- End-to-end suites that need a real legacy server (`apps/web/e2e`, `apps/widget/e2e/real`) start it from
  a Whombat checkout: `WHOMBAT_SERVER_REPO` (default the sibling `../Whombat`). They are not part of
  `pnpm check`.
- The widget's watch mode no longer watches `packages/core/src/feedback` (core is a vendored build now).

## AP-10 One `ApplianceSession` interface in `@whombat/client`

Every client talks to a Whombat through `ApplianceSession` (`@whombat/client/session`): typed calls
(`call(endpoint, {params, query, body}, {requestId, deadlineMs, signal, onProgress})`, answered in HTTP terms
`{status, body}` so both transports decode through the same contract code), `status(requestId)` for ambiguous
outcomes, `subscribe(topics)` with cursors and `snapshot_required`, `openResource(ref)` streams, `upload(target,
chunkSource)`, `openCollab(document)`, ephemeral `signal('typing'|'presence')`, capability negotiation
(`supports`), connection state (`idle | connecting | open | reconnecting | closed` with a `DisconnectReason`) and
notices (`revoked`, `authz_changed`, `maintenance`). `createClient({ session })` builds the typed client on it;
without `session` it builds the legacy HTTP one from the old options, so existing callers are unchanged.

- `createHttpSession` — legacy self-hosted: `fetch`, XHR PUT uploads, same-origin resource fetches; realtime
  stays on `/ws` (`createRealtime`) and collaboration on Hocuspocus `/collab`.
- `createSecureSession` — managed: an injected `SessionConnector` yields authenticated connections; the session
  does hello/welcome, requests, subscriptions, streams, reconnect (jittered exponential backoff, a fresh
  handshake every time; `busy` honours the relay's `retryAfterMs`), rekey as a planned reconnect before the
  byte/time limit, heartbeat, and separate interactive and bulk connections (downloads and uploads never share
  a connection with interactive traffic).

Terminal reasons (`ticket_denied`, `identity_mismatch`, `client_too_old`, `appliance_too_old`, `revoked`,
`not_enrolled`, `closed`) never reconnect by themselves; everything else does.

## AP-11 Realtime over session subscriptions keeps the `Realtime` interface

`createSessionRealtime(session)` implements the existing `Realtime` interface, so hooks, reducers and
`connectRealtimeToQueryClient` are unchanged. A reconnect the appliance resumed from our cursor is not a resync
(no refetch storm); `snapshot_required` and a subscription that could not resume become
`onResync({ reason: 'snapshot' | 'reconnect' })`. `session()` (burrow and principal for reducers) comes from the
held `burrow:` / `me:` topics.

*Amended by AP-1097*: the appliance drops a subscription it answers with `snapshot_required`; the session subscribes it
again after the given cursor by itself, so live events continue after the resync.

## AP-12 The wire is `@whombat/protocol`; Noise behind a port

Since contracts 0.2.0 the session speaks `@whombat/protocol` directly: messages are encoded and decoded with its
codec (validated both ways), frames are its length-prefixed `[u32 len][u8 type][u32 stream][payload]` (CT-05)
re-framed by its `FrameDecoder`, relay dial messages and close codes are its `relay` schemas. Answers are mapped to
HTTP terms for the typed client: `result{kind:'ok'}` → 200, `result{kind:'approval_required'}` → 202, `error` →
the matching status with core's `ApiErrorBody` (`blocked` → 403 `BlockedBody` from `details`); an application code
the protocol enum lacks rides in `details.code`. Session-native operations (`enroll.*`, `recovery.*`,
`endpoints.*`) go through `session.invoke(op, input)` and the typed `sessionOps` wrappers. The secure channel is
a port (`byteStream`, `openInitiator`, `secureByteStream` — the qualified `@whombat/secure-channel` API, contracts
0.3); no cryptography is implemented here. Only `appliance.status` is still provisional (announced for 0.3).

Bulk streams are bounded to 6 per connection (each may have the 256 KiB initial credit outstanding): browsers and
React Native can't pause a WebSocket and fail above 8 MiB buffered.

## AP-13 Uploads: chunked, resumable, bounded memory

`uploadFile` sends through `session.upload`. Managed: one pass hashes the file (sha256, 256 KiB at a time),
then an upload stream on the bulk connection sends 256 KiB chunks within the appliance's credit; each chunk is announced with `chunk{index, offset, size, sha256}` and acknowledged with `chunk_ack` once stored;
`opened.meta.received` gives the resume offset after a dropped connection (up to 6 attempts); `stream_done.output`
carries the `UploadCompleteResponse`. Downloads are checked against `stream_done{size, sha256}`. A file that changes between the passes
fails the whole-file check. Sources are `ChunkSource` (`read(offset, length)`): web `blobChunkSource(file)`
(`Blob.slice`), mobile expo-file-system file handles. Nothing ever reads a whole file into memory or base64.

## AP-14 Durable command states

Mutations carry a request id (idempotency key, MA-09). The command tracker follows
`pending_delivery → accepted → executing → completed | rejected | unknown`, plus `not_delivered` (never
reached the appliance). After a lost connection the session resolves an ambiguous mutation with `status`:
committed → its result; not committed → resent with the same id, except destructive operations (DELETE,
merge, deploy, decide, revoke, remove…, `defaultIsDestructive`), which surface as `unknown` and wait for a
person ("Check again"; "Send again" only after the appliance confirms it never arrived). Since contracts 0.29 the
contract's per-op classification decides, not op names (AP-570…AP-573, `retry-safety.md`). Reads are simply
asked again. A delivery deadline applies until `accepted`; accepted work is waited for (disconnects never cancel
it). Status words are quiet: “Sending…”, “Received · working on it”, “Not confirmed yet”, “Not sent”.

## AP-15 A fake world that speaks the real protocol

`@whombat/client/fake` is an in-memory appliance that encodes and decodes every message with `@whombat/protocol`'s
codec and schemas and every frame with its length-prefixed encoder and `FrameDecoder`, so tests exercise the
real wire. It implements the appliance semantics the client depends on (receipts bound to `requestDigest`,
`accepted` before `result`, `outcome`, cursor resume with retention and `snapshot_required`, credit, downloads with
`stream_done`, `chunk`/`chunk_ack` uploads, collaboration, `revoked`, `authz_changed`, `goaway`) and faults
(offline, lost results after commit, swallowed requests, slow accepts, dropped uploads, version mismatch, revocation).
`fake.serve(byteStream)` puts it behind a real Noise responder (Node test `noise.test.ts`, device harness).
The web's `VITE_WHOMBAT_FAKE=1` world (`src/managed/fake/`) adds a fake control and fake appliances serving the
fixture world, persists its state in localStorage and exposes `window.__WHOMBAT_FAKE__` to the e2e suites. Production
builds refuse `VITE_WHOMBAT_FAKE`. It is a reference for the client, not the appliance (Whombat managed runtime).

*Amended by AP-1097*: like the runtime, the fake drops a subscription it answers with `snapshot_required`; it also
restarts (`faults.restart`, a new cursor epoch), falls behind (`faults.overflow`), answers an event too large for a
CONTROL message with `snapshot_required{overflow}` at its cursor, and can keep refusing (`faults.repeatSnapshot`).

## AP-16 Uploaded content is never a same-origin document

Managed attachments are streamed through the session (`openResource`) into `blob:` object URLs held in a scoped,
byte-bounded LRU (`createObjectUrlCache`). Only raster images (png, jpeg, gif, webp, avif, bmp — never SVG) get an
object URL with their real type, shown in `<img>`; text (plain, markdown, csv, json, logs) is read as text (4 KiB
range) and rendered as text; everything else is only a download (`saveResource`: `<a download>` on a blob with a
neutral type — a download, never a navigation). No iframe, object or embed of uploaded bytes exists. Mobile writes
resources to scoped cache files for `<Image>` and the share sheet.

## AP-17 Cache scope

Everything cached from an appliance belongs to (org, appliance, account, `authzGeneration`) — account-based since
contracts 0.3 (CT-16). `createScopeGuard` clears query data, object URLs, command states, drafts and upload chips
when the scope changes, on `authz_changed`, on `revoked` (and on the refusal at the next connection when the
revocation happened while offline), on sign-out and when leaving the appliance. Persisted keys are
`whombat:<scope>:…`, read only for the current scope, all removed on clear. Copy never promises remote erasure:
what someone saved to disk and offline or modified clients are out of reach (the revoked screen says what was cleared
here).

## AP-18 Session-native operations are typed wrappers, not new REST

Claim, pairing, recovery, endpoints, admins and `appliance.status` go through `session.invoke(op, input)` and the
typed `sessionOps` (inputs and outputs parsed with `@whombat/protocol/session` schemas). `auth.*` never crosses the
session (`SESSION_EXCLUDED_API_OPS`): `withManagedAuth` answers `auth.session` locally from `me.get` and turns
`auth.logout` into a cloud sign-out; `devices.vapidKey` is not available.

## AP-19 Contract requests and gaps (raised with the orchestrator)

Resolved in contracts 0.3/0.4: account-based session identity; `appliance.status` with providers (nine states),
backup summary and versions; ephemeral `presence.typing` / `presence.set`; collaboration messages framed
`[u32 len][bytes]` across frames (16 MiB); application codes in `error.details.code` (`appErrorCode`);
`unsupported_version` details (`whoMustUpdate`). Open: (1) `@whombat/secure-channel`'s WebSocket adapter depends on
`bufferedAmount`, which React Native never sets (worked around in the client port, AP-25); (2) Hermes needs
`AbortSignal.prototype.throwIfAborted` (app polyfill; the ADR checklist should list it); (3) there is no managed
design for browser push or for OAuth connectors whose redirect must reach the appliance (AP-24).

## AP-20 The hosted UI in managed mode

`VITE_WHOMBAT_TRANSPORT=session` boots `ManagedRoot`: cloud sign-in by magic link (`@whombat/control-contracts`,
bearer token from `auth.verify` in localStorage — it admits relay connections only), the org's appliances from the
directory, then per appliance a secure session pinned to the directory's content PeerId (checked against the claim
card's fingerprint at claim). *Superseded for the pin by AP-63/AP-64: the directory is only compared with the pin.* The endpoint key is a non-extractable WebCrypto Ed25519 key generated by
`@whombat/secure-channel` and kept in IndexedDB (qualified in Chromium, Firefox and WebKit per the secure-channel
ADR); script can sign with it but never read it. An enrollment-channel session carries claim, pairing and recovery;
an app-channel session runs the unchanged burrow app with services built on it (client, realtime over
subscriptions, resources, collaboration, command tracker).

## AP-21 Claim and recovery kit

*The claim half is superseded by AP-47 (MA-22): no fingerprint on the card is compared any more, and the claim
PAKE replaces the fingerprint check. The recovery kit below is unchanged.*

Claim: the card (typed, or the QR text `WHOMBAT1:<device>:<fingerprint>:<secret>`) → control reserves the claim
(competing and already-claimed claims are refused there) → the directory's PeerId must have the card's fingerprint
(else “This isn’t the Whombat on your card”, nothing sent) → an enrollment session whose handshake proves the box
holds that identity → the person compares both fingerprints group by group → only then `enroll.claim` with the
secret. Recovery kit: the key is generated in the browser (contracts' keypair helper), its public half registered
(`recovery.kit.register`), the kit downloaded as a text file, and confirmed with “I’ve saved the kit” (AP-51; it used to ask for two groups of
it typed back) by signing the appliance's challenge (`RecoveryKitConfirmation`, `recovery.kit.confirm`). Until confirmed the app keeps
a quiet “Recovery kit not saved” strip.

## AP-22 Managed screens follow the nearest mocked pattern

Not in the mocks (B-05): sign-in, appliance list, claim, fingerprint check, recovery kit and pairing use the sign-in
frame (onboarding's language); This Whombat and Devices are two more Settings tabs in settings' own cards and section
labels; connection trouble is a one-line strip (hidden for blips under 1.5 s and for rekeys); terminal states are a
plain full page. Words avoid “relay”, “Noise”, “PeerId”, “ticket”, “endpoint”: “your Whombat”, “this device”,
“fingerprint” (groups of five). Provider sign-in states, backup states (“Unprotected” without a destination),
update states and pending vs applied device removals are each worded differently.

## AP-23 The hosted build's CSP

`hosted.ts` (session builds): no inline script (`/theme-init.js`, which also puts zod in jitless mode before any
module runs), Google Fonts replaced by the same OFL files from the app's origin, Tiptap's base CSS shipped as a file
(`injectCSS: false`), and the policy as `<meta>` plus `_headers` (`default-src 'none'`; script, style, font `'self'`;
img `'self' blob: data:`; `connect-src` control and relay origins only; no frames, objects or form posts;
`frame-ancestors 'none'`; nosniff, no-referrer, COOP, Permissions-Policy, HSTS). No analytics or session replay
exist in the app. The `hosted` Playwright project runs claim → image in chat → canvas on that build and asserts no
CSP violation and no third-party request.

## AP-24 Bypasses that stay off in managed mode

Web Push (VAPID keys from the appliance, a service worker) and Google's OAuth connect (its redirect lands on the
server's public address) have no managed design yet: in managed mode the service worker isn't registered, the
desktop-notification opt-in isn't offered, and Connect Google explains instead of navigating. Legacy mode is
unchanged. **Google connect: superseded by AP-80** (it works on a managed Whombat since 0.4.0). Deep links are app routes (`/burrow/…`, `whombat://…`) and carry no credentials; the magic link carries
a one-time cloud token only.

## AP-25 On-device qualification of the client stack

`apps/mobile/scripts/device-harness` runs the real client on Android (see its README) against a relay stand-in with a
real Noise responder serving the fake appliance. Result 2026-09-25, x86_64 emulator, release build: all checks pass
(handshake p95 175 ms; 1.67 MiB/s down, 1.30 MiB/s up, sha256-verified; wrong PeerId refused). Unverified: an ARM
phone, suspend/resume on a device, iOS (not built here). Pure-JS Noise on Hermes is the throughput ceiling; native
crypto injection (`crypto` option) was not needed to pass the bar and is not evaluated yet.

## AP-26 Native AEAD for mobile transfers

Measured on the x86_64 emulator, release build, same run (`RESULT-2026-09-25-emulator-release-native-aead.txt`):
pure-JS Noise 1.86 MiB/s down / 1.37 MiB/s up; with ChaCha20-Poly1305 from react-native-quick-crypto (the
secure-channel `crypto` option, handshake primitives kept pure JS) 2.71 / 1.73 MiB/s. The adapter
(`apps/mobile/src/managed/nativeCrypto.ts`) runs a self-test against the pure-JS AEAD (interop both ways, tamper
rejected) and falls back to pure JS on any difference. Package: react-native-quick-crypto 1.1.7 (Margelo, MIT,
maintained — last release September 2026) on react-native-nitro-modules 0.37.1 (MIT); one published advisory,
GHSA-wrf3-fwx3-8jrv (high, secret keys truncated at a NUL byte), fixed since 1.0.0. Decision: the managed mobile
connector uses it when the self-test passes; the web keeps pure JS (browsers are fast enough).

*Amended by AP-890* (android-slim.md): the native AEAD is Android's own `javax.crypto` (Conscrypt/BoringSSL) through
`modules/whombat-crypto`; react-native-quick-crypto and Nitro are gone. Same harness, same emulator: 2.65 / 1.77 MiB/s.

The remaining ceiling is outside the cipher: React Native's WebSocket base64-encodes every binary message across
the native bridge, and chunk hashes run in JS. User-visible impact at these rates: a 25 MB attachment (the default
upload limit) takes about 15–20 s to upload and 10 s to download on a phone of this class; the composer shows
progress and uploads resume after drops, so it is slow but not broken. Next step if phones measure lower: a
native WebSocket binary path (or a native stream module).

Named unrun qualifications (procedure: `apps/mobile/scripts/device-harness/README.md`):
- **ARM phone**: build the release harness APK with `--arch all`, install on a mid-range Android phone over USB,
  `adb reverse tcp:4799 tcp:4799`, run; pass = all ok, handshake p95 < 1 s, ≥ 1 MiB/s both ways; record the model,
  Android version and the result file.
- **Suspend/resume**: with the normal app on a device, open a managed session, background the app for 5 min,
  foreground: the session reconnects (fresh handshake), subscriptions resume or ask for a snapshot, nothing is sent
  twice.
- **iOS**: needs macOS/Xcode (not on this host): `expo prebuild --platform ios`, build the harness scheme with the
  same two environment variables, run against the host server over the simulator's localhost; same pass bar.

## AP-27 The managed phone app

`EXPO_PUBLIC_WHOMBAT_TRANSPORT=session` builds the managed Android/iOS app (`apps/mobile/src/managed/`); without it
the app is the legacy self-hosted one, unchanged. It mirrors the web's managed journeys on the same code: the web's
control client, magic-link parsing, claim card and fingerprint helpers, recovery kit, appliance registry, push-handle
logic and all managed words moved to `@whombat/client/managed` (the web imports them from there). Control's bearer
token and the push registration live in expo-secure-store; the registry (metadata only) is a JSON file in the app's
documents, read once (`preloadedStorage`) so the registry's synchronous interface is unchanged.

- Sign-in: the magic link `<ui>/auth/verify#token=…` opens the app through an Android intent filter on the hosted
  UI's origin(s) (`EXPO_PUBLIC_WHOMBAT_UI_URL`; `autoVerify` App Links for https, served by the UI's
  `assetlinks.json`), or `whombat://auth/verify#token=…`; the token is exchanged exactly once (`verifyOnce`).
  Control not answering at start is a retry page, never a sign-out.
- A just-claimed Whombat has no burrow: the owner names one on the phone (onboarding's step 1, its words); the other
  onboarding steps stay on the web.
- The burrow app runs over the session with the unchanged screens: `createClient({session})`,
  `createSessionRealtime`, `withManagedAuth`, a per-appliance `QueryClient` and scope guard (queries, decrypted
  files, shared copies, live notifications). No legacy HTTP in managed mode: attachments stream through the session
  into scoped cache files (`<cache>/whombat-resources/<org_appliance_account_generation>/…`) and uploads go as
  chunks read by offset from an expo-file-system handle.
- This Whombat and Devices are pushed screens reached from the settings sheet (settings' grouped cards), mirroring
  the web's tabs. The connection and “Recovery kit not saved” strips render inside `Screen` under the status bar
  (`ScreenStripContext`), so they push the screen down instead of covering its header.

## AP-28 A native client's Origin

React Native's Android WebSocket always sends an `Origin` (the socket URL's own origin) unless one is set. A native
app has no web origin; the relay treats a missing Origin as native (MA-05), and reads an empty one as missing, so
the phone sends `origin: ''` (verified against relay b1b5d1c). Orchestrator MA-20: kept; the relay will also treat
an Origin equal to its own public origin as native.

## AP-29 Push through control, apart from the session

Phones register their FCM/APNs token with control (`push.register {platform, token, appId: 'com.whombat.mobile'}`),
browsers their Web Push subscription (control's VAPID key from `push.vapid`, MA-18); the opaque handle goes to the
open appliance with `push.handles.set` (`@whombat/client/managed` `ensurePushHandle` / `tellAppliance` /
`clearPush`). Sign-out clears the handle on the appliance (when a session is at hand) and at control; a revoked
device only drops that appliance from its local list (the appliance no longer wakes revoked endpoints).

- Push state is its own row (On · last one N minutes ago / Not allowed → Open settings / Not available / Couldn’t
  set up), never folded into “connected”. The permission is asked when the first appliance session opens; after a
  denial nothing is asked again and the row points at the system settings.
- Notifications are content-free: one line per `PushKind` (`PUSH_TEXT`), the same words in the Android module and
  the web service worker (tests compare them). Android shows data messages itself (`WhombatPush`) and turns FCM's
  own tray taps (launch-intent extras) into the same `whombat://push?kind=…&ref=…`; the browser opens
  `/?push=…&ref=…`.
- A tap is resolved through the session: the inbox is fetched and the newest unread row of the push's kind opens
  (an approval push opens the approval; update/backup/security pushes open This Whombat). The ref is opaque (CT-32)
  and not interpreted; `push.resolve {ref}` is planned for contracts 0.5.2 (MA-20). Superseded by AP-38.
- Test builds without Firebase (`EXPO_PUBLIC_WHOMBAT_PUSH_RELAY=1`) register a `dev-relay:` token and include the
  debug push receiver in the release APK; `scripts/push.mjs fcm` is an FCM HTTP v1 stand-in (OAuth token + send)
  for control's live sender, delivering to the emulator with adb and logging every message control sent.

## AP-30 Contracts 0.5.1

- Claim: `claims.start` carries `claimProof = claimVerifier(device, normalized secret)` computed from the card
  (`claimProofOf`); control's `claim_proof_invalid` reads as “That claim code isn’t right.”
- Secure channel `whombat-secure-session/2`; the React Native `bufferedAmount` workaround is gone (the library reads
  a missing value as 0).
- Secret ops (CT-44): a lost answer to a secret op is never resent by itself (not even after `not_found`); an
  `outcome{redacted}` or a retry's `unknown_outcome` rejects with `OutcomeRedactedError` (command phase `completed`
  when the appliance said so, else `unknown`); the screens start over with a new request id.
- Team agents (MA-17, CT-39): the source is the agent's `runtime.credentialSource` (`credentialSourceOf`), set with
  the REST op `agents.setCredentialSource`; organization keys are `providers.org.list|login.start|remove` with the
  key submitted through `providers.login.submit`. The provisional ops are gone.
- Recovery (CT-45): when a confirmed kit exists (or `register` answers `recovery_key_exists`) the kit screen asks for
  the recovery key of the current kit, signs the `RecoveryRotation` with it and calls `recovery.kit.rotate`; the new
  kit is saved and confirmed as usual. This Whombat shows `rotationPending`. New words for `recovery_not_kit_owner`,
  `recovery_kit_unverified`, `recovery_rotation_invalid` and `invite_account_exists`.

## AP-31 Scanning the claim card

Only managed builds carry the camera (expo-camera, QR only, `recordAudioAndroid: false`); the permission is asked
when someone taps “Scan the QR code”, a refusal falls back to typing. Legacy builds keep no camera permission
(expo-image-picker's `cameraPermission: false` still removes it there). Emulator note: the headless emulator's
virtual scene renders in the scanner, but its console can't turn the virtual camera towards the card poster, so QR
decoding is a named unrun qualification (procedure in `reports/2026-09-25-managed-0.5.1/RESULTS.md`).

## AP-32 The recovery kit on a phone

The kit is written to a temporary cache file and handed to the share sheet (Files, a drive, print); the file is
deleted when the kit is confirmed or the screen closes. Right after the claim the kit comes first (no way back);
reached from the app (a new kit) it has a back button.

## AP-33 The realtime client against a real legacy `/ws`

`pnpm test:legacy-realtime` (`packages/client/legacy/`, not in `pnpm check`: it needs Postgres and a Whombat
checkout) clones Whombat at a pinned commit (`WHOMBAT_LEGACY_PIN`, default c39f1f2, the extraction point) into a
scratch directory, installs it once, seeds a throwaway database, runs the legacy server and checks `createRealtime`
over Node's WebSocket with a phone-style bearer token: hello, events for a subscribed conversation, typing, reconnect
after a server restart (resubscribe + resync signal), and revocation. It found that the server ends a live socket
with close code 4401 when the session is revoked elsewhere, which the client treated as a dropped connection; a
4401 close is now `unauthorized` (`onUnauthorized`). A 401 on the upgrade itself is invisible to the WebSocket API
(the client keeps retrying until the host signs out).

## AP-34 Findings of the 0.5.1 device run

- Control puts the precise reason of a refusal in `error.details.code` (`forbidden` + `claim_proof_invalid`); the
  control client reads it there first. A refusal is never worded as “couldn’t reach”.
- Sign-out always forgets this install's push handle at control, also from the appliance list (the clean-up used to
  live with the open appliance).
- A revoked key stays revoked: the phone's revoked screen only goes back to the list, like the web's. Asking to be
  let in again would need a new endpoint key (all appliances would then see a new device) — built in AP-39.
- `build-android.mjs` stamps the `EXPO_PUBLIC_*` values `android/` was generated for and prebuilds from scratch when
  they change, and drops the generated bundle and Metro's cache every build: both caches ignored those values.

## AP-35 A connection that ends right after its welcome is never installed

The 0.5.1 hostile-relay scenario (a relay delivering the welcome record twice) wedged the session: the channel
failed the connection with `DECRYPT_FAILED` at once, but the close arrived after `open()` had accepted the welcome
and before `attemptConnect` made the connection current, so `connectionEnded` ignored it (not the current
connection) and the closed connection was then installed — `open`, with every request ending in
`NotDeliveredError` after 30 s. `attemptConnect` now schedules a `lost` retry when the connection it just opened is
already closed, and the bulk path dials once more (then fails the caller with `lost`) instead of handing out a
closed bulk connection. Tests: the exact race through real Noise (`noise.test.ts`, a splice that replays
appliance→client message #3 — the welcome under secure-session/2), and a connector that ends a connection right
after its welcome for the interactive and the bulk class (`secure.test.ts`); all three failed before the change.

## AP-36 Contracts 0.5.2

Vendored from `contracts-v0.5.2` (25e23ea; `SHA256SUMS` checked, 0.5.1 removed) in one commit with the root
dependencies, overrides and lockfile. The clients adopt pairing look-up and fingerprints (AP-37), `push.resolve`
(AP-38), `hello.cachedAccountId` and `isSafeNext` (AP-40); CT-50's `CredentialMeta` fields are not read by the app.

## AP-37 Letting a device in: look up, compare, approve with the fingerprint

The new device shows `pairingFingerprint(own PeerId)` (`XXXX-XXXX-XXXX`) under its code, with “The device that lets
this one in shows the same fingerprint. Check that they match.” The approving device (web Settings · Devices, phone
Devices) no longer approves a typed code blind: “Continue” calls `enroll.pair.lookup`, then shows THE DEVICE ASKING
— its label, what kind of device it is in words (`platformName`: Browser, Android phone, iPhone or iPad…) and
“Fingerprint …” — and “Check this matches the fingerprint on the other device. If it doesn’t, decline.”; “Let it
in” / “Decline” send `enroll.pair.approve` with the looked-up fingerprint (declining needs it too, the schema
requires it); “Use another code” goes back. The words say “fingerprint”, not “code” (the assignment's example
said “the code”), because “code” already names the pairing code on the same screen. Refusals read differently
(`pairingErrorKey`): unknown code, expired, rate limited, and `pairing_fingerprint_mismatch` — “Another device now
shows that code. Nothing was let in. Type the code again.” — which, like unknown and expired, drops the looked-up
device so the next approval needs a fresh look-up. The shared helpers and words live in `@whombat/client/managed`.

## AP-38 Notification taps resolve their ref

A tap (web: the service worker opens `/?push=<kind>&ref=<ref>`, unchanged; phone: FCM tray, `WhombatPush`, iOS)
calls `push.resolve {ref}` through the open appliance's session (`resolvePushRef`):

- `{burrow, link}` → the link opens (web `linkPath`; phone `routeForLink`, only for the burrow the phone shows —
  another burrow's link opens the inbox without a note);
- `not_found` → the inbox with a quiet note, “Couldn’t find what that notification was about. Here’s your inbox.”
  (web: a passing strip over Needs you, `/<burrow>/log?kind=asks`, the web's inbox; phone: the Inbox tab and the
  strip under the status bar, `ManagedContext.showNote`); any other failure → the inbox without a note;
- `unknown_op` → the previous resolution by kind over the inbox (`pushTarget`). The welcome's capabilities are
  coarse (`enroll`, `stream.*`…) and name no operations, so an appliance that predates 0.5.2 is recognised by its
  answer, not by a capability.

Resolved taps no longer mark an inbox row read (the ref names the item, not the row). A Web Push payload names no
appliance, so a browser resolves the tap against the Whombat it opens (the last used); a ref of another one reads
as `not_found`.

## AP-39 Setting up a removed device again

A revoked key stays revoked (MA-04 §6, AP-34), so “This device was removed” no longer says “ask to be let in again”:
it says the device can be set up again, gets a new key and is let in by a device that’s still trusted; with other
Whombats in the list it adds “Your other Whombats will ask to let it in again too.” “Set up this device again”
(web and phone) deletes the endpoint key (IndexedDB / keystore) and makes a new one, marks every known Whombat
not enrolled (`forgetEnrollments`) and drops them from the saved push handle's list (none holds the new endpoint's
handle; it is set again when each opens), and starts pairing for this Whombat. The signed-in tree is keyed by the
key's PeerId, so nothing keeps the old key (React's dev build also compared old and new props and tripped over the
WebCrypto identity's non-exportable `raw` getter). The old, revoked endpoints stay listed on other appliances until
someone removes them there. Recovery-kit enrollment (`recovery.enroll`) has no screen yet, so a removed last owner
device can't use this path: not built, named here.

## AP-40 `cachedAccountId` and safe `next`

- `hello` carries `cachedAccountId` and `cachedAuthzGeneration` together, never one alone. By default they are the
  previous welcome's account and generation (a reconnect says what the session's caches hold; a first connection
  says nothing, its caches are empty); `SecureSessionOptions.cached` overrides that. The fake appliance clears the
  cache of another account, as CT-47 requires.
- Magic links: `requestSignInLink(email, next)` sends `next` only when `isSafeNext` accepts it (else control's
  default applies); the web asks to come back to the path it was on. `readVerifyFragment` checks `next` with
  `isSafeNext` too, so an encoded or backslashed path is replaced by `/appliances`.

## AP-41 Recovery with the recovery kit

A device of the kit owner that can't get in any other way — removed, new, or with every signed-in device lost — lets
itself in with the kit (MA-04 §4, CT-45): “Use your recovery kit” opens the saved kit file (web: a file input;
phone: the system document picker, whose cache copy is deleted at once) or takes the typed recovery key. The client
builds the contract's `RecoveryStatement` — this appliance's PeerId, this device's own PeerId (the enrollment
session's identity), the owner account, now, a fresh 128-bit nonce — signs its canonical JSON with the kit's key
(`recoveryEnrollRequest`, validated with the contract's `RecoveryEnrollInput`) and calls `recovery.enroll` over the
enrollment channel; the answer (`EnrolledOutput`) makes the Whombat enrolled for that account and the app opens.
The key never leaves the device; only the signature does.

- **Which account.** The statement names the owner account, and nothing on the enrollment channel says which it is.
  Kits saved from now on carry an `Owner account: acc_…` line (the account of the session that saves the kit —
  the kit owner, CT-45), so a brand-new device can use the file. Every device also remembers its account per
  Whombat (claim, pairing, every session), so a removed device can use the typed key. A typed key on a device that
  never knew the Whombat, with a kit from before this line existed, can't work: the screen says to open the file.
- **Entry points.** The removed-device page (“Use your recovery kit”: a new key first, AP-39, then the kit), the
  appliance list for any Whombat this device isn't let in to (“Lost access? Use your recovery kit”, also for ones it
  never knew), and the pairing page (“Lost every signed-in device? Use your recovery kit”).
- **Refusals** are worded apart (`recoveryErrorKey`): `recovery_not_kit_owner`, `recovery_kit_unverified`, a key that
  isn't this Whombat's (`recovery_signature_invalid`), a wrong clock (`recovery_statement_expired`), no kit, an owner
  who isn't one any more; a file that isn't a kit or belongs to another Whombat is caught before anything is sent.
- **Tests.** The ceremony is unit-tested against the contract's schema and strict verifier and the vendored release's
  canonical-JSON and Ed25519 vectors (the contracts ship no `recovery.enroll` vectors); in `apps/web` because it
  reads the release tarball with Node. The fake world checks like the runtime (confirmed kit, signature, bound to
  appliance and session key, ±5 min, kit owner). Fixed on the way: `sessionOps.recoveryEnroll` parsed the answer
  with the claim's output schema, so a successful recovery read as a failure.

## AP-42 Findings of the 0.5.2 release-candidate device run

Recorded in `apps/mobile/scripts/device-harness/reports/2026-09-25-rc-0.5.2/RESULTS.md` (pairing both ways with
fingerprints, a refused mismatch, `push.resolve` taps, re-setup, recovery with the kit file and the typed key — all
pass against runtime 52c3ff2).

- The web keeps one key object per key, mounts a new `App` for every new appliance setup and keeps
  `EndpointKey.identity` non-enumerable: a second load of the same key (StrictMode) had restarted the session under
  an `App` whose router held the first, cleared services, and React's development logging crashed on the
  non-exportable WebCrypto identity.
- A refused sign-in link (malformed address, control's link limit) is worded as such (`signInErrorText`), never as
  “Couldn’t reach Whombat”.
- On the emulator the share sheet has no “save to Files” target for text (its “Save” refuses text); the kit was
  read for the check through `adb root` (userdebug image), standing in for the owner reading the saved file.

## AP-43 Contracts 0.5.3: client floor, re-enrollment, diagnostics

- **Build numbers (CT-53).** Every session's `hello.client` carries `buildNumber`, on both channels: the web's
  `WEB_CLIENT` (the build counter `VITE_WHOMBAT_BUILD_NUMBER`, else the checkout's commit count from
  `vite.config.ts`), the phone's `phoneClient` (Android `versionCode`, iOS build number). An appliance refusing
  the build (`unsupported_version`, `details.code = client_below_security_floor`) ends the session as the terminal
  reason `client_below_floor`: “Update the app” (web: Reload; phone: update from the store). This Whombat lists
  the floors (“Oldest app builds let in”).
- **Getting back in (CT-51).** Owners start it from a person (web Members; phone Devices → share sheet): the
  link is `<hosted UI>/appliances/<device>/get-back-in#s=<secret>`, shown once. The web takes the secret out of
  the address bar at once and keeps it in local storage until it is used or a day passes (it must survive the
  sign-in, which may open another tab); the phone opens it as an app link (the intent filter now includes that
  path) or from a pasted link on the pairing page. The new device's Whombat comes from the organization's
  directory (“This Whombat isn't in your organization” otherwise); Continue accepts, the device shows the account
  name and its pairing fingerprint to read to the owner, and polls until confirmed. Owners confirm in Devices
  (GETTING BACK IN: label, kind, fingerprint, let in / decline; open links can be cancelled). Every refusal has
  its own words. The pairing page says what to do without another device.
- **Diagnostics (CT-52).** Owners, This Whombat: pick scopes (the contract's descriptions), make a file, read it
  — shown only when `sha256(diagnosticBundleBytes(bundle))` equals the recorded sha256 (else “didn't match …
  isn't shown or saved”), structured when this client knows the format, raw otherwise — download it through the
  export stream (checked again against the summary, bounded by its size; the web saves a neutral blob, the phone
  shares a temporary file it deletes afterwards) and delete it. The copy says nothing is sent anywhere by itself.
- The fake appliance gained the client floor and export streams; the fake world re-enrollments and diagnostic
  bundles with the runtime's checks.

## AP-44 Contracts 0.5.4 and the parity gaps G-01, G-02, G-03, G-06, G-08; MR-45 links

- **Packs over the session (CT-55, CT-56; G-04, G-05).** `importPackArchive`: sha256 → `packs.stage` → the upload
  stream to `{type: 'pack-archive', burrow, stagedArchiveId}` (resumable, checked) → `packs.import`, decoded like a
  typed mutation (`pending_approval` is shown as waiting for approval); `importBundledPack` installs a shipped pack
  at the version the list showed. `unknown_op` from `packs.stage` is `PackStagingUnsupportedError` and the upload
  target is never opened (an older runtime closes the session on it). The web's Packs tab uses these in managed
  mode; the legacy server keeps `packs.upload`. The phone has no pack import screen (only per-agent packs), so none
  was added.
- **G-02.** The session sends an API operation under its key path (`apiOpName`), not `ep.id`; the only difference
  today was `packs.agentPacks` (id `packs.agent`), so an agent's packs now load. The fake appliance allowlists API
  operations by key path and answers `unknown_op` otherwise (handlers still receive ids); a unit test checks every
  endpoint against the protocol's `API_OPERATIONS`.
- **G-03.** `transfer: 'export'` operations (the audit CSV) are only read through an export stream, and an exportable
  answer refused as `too_large` with `details.code: use_export_stream` is read again through one, inside the session:
  every caller (audit export, pack and automation exports, any large read) is unchanged. The fake appliance refuses
  file outputs as requests and results above a message's size, like the runtime, so the e2e suite exercises this.
- **G-01.** Inviting (owners): control's organization invitation (relay tickets need membership), the burrow's
  pending invite (`members.invite`; the runtime accepts it when the account is made) and `enroll.invite.create`,
  whose one-time link `<hosted UI>/appliances/<device>/join#s=…` is shown once (web: copy, cancel; phone: share
  sheet). There is no `enroll.invite.list`, so a link can only be cancelled right after it was made; control's
  open invitations are listed and cancellable. The invitee opens control's `/invitations/accept#token=…` (web: also
  as a new account without an organization) and then the owner's link, which shows the device's pairing
  fingerprint and a name field and creates the account over the enrollment channel. The runtime's own invite link
  (`http://localhost:5180/login?invite=…`) is never shown in managed mode.
- **G-06.** Owners: This Whombat → OWNERS (list; remove, with `last_owner` in plain words) and “Make owner” on a
  person (web Members, phone This Whombat).
- **G-08.** Organization keys have a remove action in RUNS ON (`providers.org.remove`).
- **MR-45.** `/appliances/<device>/<path>` selects that Whombat (the registry, else the organization's directory),
  pairs first when this device isn't let in there, then opens the path (web: the router; phone: the navigator's
  link map through `appUrlForPath`). Canvas links are built the same way (`applianceLink`). The phone's Android app
  links now cover `/appliances/…` and `/invitations/accept`.

## AP-45 Pack exports are files, not JSON rebuilt around bytes

- **Defect (integration harness against the runtime, managed/hardening afb5efd).** A `packs.export` answer above one
  session message (64 KiB) came back corrupted: the runtime answers the request with `too_large`/`use_export_stream`
  and serves the export stream as the archive's raw bytes (`meta {contentType: application/gzip, name, size}`,
  `stream_done.sha256`), while the transparent export path (G-03) decoded every stream as text or JSON (the endpoint's
  content type says JSON), so the web's PackModal ran `atob` on nothing.
- **Decision.** An export stream of an export op (`exportOp`, today only `packs.export`) carries the file's raw bytes.
  The session reads it as an `ExportFile {kind: 'file', name, contentType, bytes, sha256}` (`readExportFile`): the
  bytes must match `meta.size` and the appliance's `stream_done` (size and sha256; a stream without `stream_done` is
  refused), bounded like every export read. It never rebuilds the contract's JSON body (`{fileName, data, sha256}`)
  around them. The same rule holds for any export stream that is neither JSON nor text; JSON streams (automation
  export, large reads) are still parsed and text streams (the audit CSV) still read as text.
- **One path.** On a managed session `packs.export` always goes through the export stream (no request first, whatever
  its size); the runtime's mutating export already respects the drain gate and has no receipt. `exportPackArchive`
  (and the `usePackExport` hook) gives the web one typed result: managed, the stream's file; legacy HTTP, the JSON
  answer decoded from base64 and checked against its sha256. `packs.export` left `usePackWrite`; the typed client hands
  an `ExportFile` body through unvalidated rather than checking it against the JSON schema.
- **Web.** PackModal saves the bytes as they arrived (a neutral `application/octet-stream` blob and a download, never a
  navigation, AP-16), named by the appliance (fallback `<name>-<version>.tar.gz`); a failed export shows “Couldn’t
  export the pack. Try again in a moment.” The phone has no pack export.
- **Fake world.** The fake appliance streams `packs.export` like the runtime (base64 answer → raw `application/gzip`
  bytes, named) and still refuses it as a request above a message; the fake world keeps uploaded archives so an export
  gives the same bytes back. The managed e2e exports a 300 KiB gzip and compares it byte for byte.

## AP-46 Contracts 0.6.0: the control service is control
Contracts 0.6.0 (CT-57) renames the control service's repository to `whombat-api`. The app sends no device audience,
so the only changes here are the vendored version and the service name in comments. `ControlApi` and
`createHttpControl` keep their names, because the component is still called "control".

## AP-47 Claiming with the code on the Whombat's screen (MA-22)
Contracts 0.7.1 (CT-58…CT-66) and appliance CC-01…CC-12. Supersedes AP-21's claim half: the fingerprint
comparison screen is gone, and nothing is compared with a card any more.

- **Flow** (web `/claim` and `/appliances/claim`, Android's claim route): `claims.nearby` on load. One box: “We found a
  Whombat on your network”, its model and id, and “Enter the 4 letters from its screen”. Several: pick one first. None
  (or the call fails, or “Not this one?” / “None of these?”): “Enter the code on your Whombat’s screen”, the whole
  code. “Claim with a card instead” opens the card (typed, the pasted QR text, or on Android the scanner); “Claim
  with the code on its screen instead” goes back to where the nearby answer put the person.
- **Ceremony** (`claimAppliance` / `runClaimCeremony`, `@whombat/client/managed`, shared by web and Android):
  `claims.start` (`{method:'code', device}`, `{method:'code', lookup}` or `{method:'card', device, claimProof}`; the
  letters and the card secret never go to control) → an enrollment session pinned to the PeerId control returned (its
  handshake proves the box holds that key) → `claimPakeInitiator` with `appliancePeerId` = that pinned remote static
  key, `clientPeerId` = this endpoint's key, `claimId` = control's claim → `enroll.claim.begin` →
  `claimPakeInitiatorFinish` → `enroll.claim {confirm: tags.client}` → `claimConfirmEqual(tags.appliance,
  output.confirm)`. A mismatch (or an appliance share that doesn't decode) throws `ClaimMismatchError` before the
  PeerId is pinned or a recovery kit is made. Password: the four letters, or `claimCardPassword(device,
  normalizeClaimSecret(secret))` for a card. The session is closed either way; the pin and the kit follow only a
  resolved claim, exactly as before.
- **`enroll.claim.begin` is ephemeral** (`SESSION_OPERATIONS[…].ephemeral`): `invoke` sends it without receipt
  handling, and a connection lost before its answer rejects it (`OutcomeUnknownError`) instead of resending — its state
  lived on that connection, so the person starts again. Typing and presence keep lapsing silently.
- **Input** (CC-01): fields take any case, spaces and dashes and show the code as the console does (`KX-4821-QM`,
  `formatClaimCodeInput`); `normalizeClaimCode` decides. The letters field also takes the whole code (then the lookup
  form is used). Nothing that isn't a code is sent (“That isn’t a claim code. Check what’s on the screen.”).
- **Refusals** (CC-09): `claim_invalid` → “That code isn’t right. Your Whombat now shows a new one.” (code) / “That
  claim code isn’t right.” (card, also control's `claim_proof_invalid`); `claim_backoff` → “Too many wrong codes. Try
  again in {n} min.” with `n = ceil((retryAt − now) / 60 s)`, at least 1; `lookup_not_found` → “No Whombat is
  showing that code. Check the digits.”; `device_not_nearby` → the whole-code field with the note “That Whombat
  isn’t on your network. Enter the whole code from its screen.”; the PAKE mismatch → “This isn’t the Whombat on your
  screen.” (card: “… on your card.”); `claim_used` → “This Whombat already has an owner. If you didn’t claim it,
  contact support.”; `claim_not_ready` → “Your Whombat isn’t showing a code yet. Wait until it does, then try again.”
  (card: “This Whombat can’t be claimed with a card. Claim it with the code on its screen.”); control's
  `already_claimed`, rate limits, offline and unreachable keep their words.

## AP-48 Claim screen language and paths
- The claim screens use the sign-in frame (AP-22): kicker `CLAIM · STEP 1 OF 2`, the recovery kit becomes `CLAIM ·
  STEP 2 OF 2`. The found box is one row of the settings card (status dot, model, mono id); several are rows with a
  “This one” button (`aria-label`/hint “Claim {model} · {id}”). The code field is the `display` input in mono.
  `self-installed` reads “Self-installed Whombat”; other models show as control names them (`wb-mini-1`).
- The empty appliance list says “No Whombats yet. Plug yours in, then claim it with the code on its screen.”
- The appliance account's name is the cloud account's; a “Your name” field appears only when that has none. The email
  is the cloud account's (the old check screen asked for both).
- `/claim` is a hosted-UI path (the console shows `{app}/claim`, CC-08). Signed out, the magic link returns there
  (`next=/claim`); a new account names its organization and lands back on it. The card's QR code encodes
  `/claim#v=1&d=<device>&p=<PeerId>&s=<secret>` (the appliance's provisioning); the web takes the fragment out of the
  address bar at once and holds the card (not the PeerId, which is ignored) for at most an hour in local storage so it
  survives signing in, then drops it when the claim succeeds or the person switches to the code. Android opens its
  claim route for the same link (card filled in); its app-link intent filter now includes `/claim`. `parseClaimQr` reads that link and the older `WHOMBAT1:` text, with
  or without a fingerprint, and ignores the fingerprint (AP-31's scanner stays, for the card only).

## AP-49 The fake world claims like the runtime
The fake control answers `claims.nearby` from a per-world list (`faults.nearby(['fresh', …])`, default the fresh box)
and the three `claims.start` forms with control's refusals (`device_not_nearby`, `lookup_not_found`, competing,
already claimed, the card proof). Every unclaimed fake box has console letters and a lookup number
(`faults.consoles()`); the fake appliance runs the real `claimPakeResponder`, rotates the letters after a wrong
confirmation, counts failures into `claimBackoffSeconds` (and `faults.claimBackoff(device, s)` forces one), and the
`mismatched` box answers `enroll.claim` with a confirmation it can't have made, standing in for something that isn't
the box. The session fake answers ephemeral session ops without a receipt, and passes an error's `details` (e.g.
`retryAt`) through. Managed e2e: found + letters (any case), wrong letters and the rotation, backoff, none → the whole
code, an unknown lookup, a malformed code, several → pick, “Not this one?”, a box that left the network, the mismatch,
competing, card fallback, wrong card, a claimed box's card, the QR text, the card link on `/claim`, and `/claim`
after sign-in.


## AP-50 Claiming by code only from the Whombat's network (CC-13, contracts 0.8.0)
Contracts 0.8.0 (CT-67) and appliance CC-13 (John, 2026-09-26): a code claim works only from the box's own
network, and the console shows only the four letters (`KXQM`). Amends AP-47 and AP-49.

- **No whole code any more.** The full-code screen, `codeRequestOf`, `formatClaimCodeInput`, the
  `{method:'code', lookup}` request and `lookup_not_found` are gone (web, Android, `@whombat/client`, the fake world,
  the e2e). `ClaimRequest`/`ClaimStart` are the nearby device with its letters, or the card.
- **Letters only.** The letters field takes any case, spaces and dashes (`formatClaimLettersInput`: upper-case,
  without spaces or dashes) and sends only `normalizeClaimCode(…).kind === 'letters'`; anything else, a longer code
  included, stays on the screen with “Enter the 4 letters from its screen.” The hint reads “The 4 letters on its
  screen, like KXQM.”
- **None found** (no box, the `claims.nearby` call failed, “Not this one?”, “None of these?”, or `claims.start`
  answered `device_not_nearby`): “We couldn’t find your Whombat” / “Your phone or computer has to be on the same
  network as your Whombat, and the Whombat has to be online: its screen shows 4 letters.”, the primary button “Look
  again” (back to “Looking for your Whombat…” and `claims.nearby` once more) and the link “Claim with a card
  instead”. No field on it. The card's “Claim with the code on its screen instead” returns to what the last nearby
  answer showed. `device_not_nearby` keeps a fallback sentence (“We couldn’t find your Whombat.”) for callers that
  show `claimErrorText`; both apps show the none screen instead.
- **Fake world.** `claims.start` has the card and the nearby forms only; a console (`faults.consoles()`) is
  `{code, letters}` with `code` = the letters. The boxes still hold a lookup lease internally, which `claims.nearby`
  requires, as control does. Managed e2e: none found → “Look again” → found → letters; anything but four letters is
  refused without a guess; “Not this one?” and “None of these?”; a box that left the network → none → back → claimed;
  the mismatched and contested boxes are found and claimed by their letters.

## AP-51 No typed-back check for the recovery kit

The maintainer removed the “Check your saved kit” step (2026-09-26): after “Download the kit” (web) or saving it
through the share sheet (mobile) the screen stays “Save your recovery kit” and offers “I’ve saved the kit” (which
signs the appliance's challenge, `recovery.kit.confirm`, as before) and “Download again”. The two random groups
(`challengeGroups`, `groupsMatch`) are gone. The appliance's side is unchanged: the kit still counts as verified only
after the signature, which proves this device holds the kit's key — not that the owner kept the file. The “Recovery kit
not saved” strip still shows until then.

## Provider subscriptions (AP-52…AP-60)

In `docs/decisions/subscriptions.md` (contracts 0.9.0, SUB-01…SUB-11): four-step onboarding with “Set up your AI”,
Settings → AI accounts, the Claude sign-in console, Codex's device code, “Whoever asks” and the phone's link to the web.

## AP-63 The identity pin: only from a party that already trusts the appliance (MA-24)

Before publishing the client repositories: a lying directory (control) could name another identity for a Whombat, and
the clients copied the directory's `contentPeerId` into their pin when opening from the list, following a link or
joining (web `ManagedRoot`, phone `ManagedApp`). Pairing and re-enrollment fingerprints cover only the new device's key,
so they never authenticated the appliance to the new device. The rule now: **a pin is written only from a party that
already trusts the appliance; the directory never writes or changes a pin.**

- `KnownAppliance.pinSource`: `claim` (the CPace-confirmed claim, the only claim path that pins), `kit` (a recovery kit
  that names the identity, AP-65), `invite` / `reenroll` (links made by an enrolled device, AP-67), `add-link`
  (AP-66), `legacy` (every record from before this change: read as `legacy`, keeps its pin, never re-classified).
- `registry.put` refuses a different `peerId` for a known Whombat (`PinConflictError`, nothing stored) and keeps the
  record's `pinSource`; `put(…, { replacePin: true })` is used only after a claim (AP-68). `forgetEnrollments` (AP-39)
  keeps the pins. Forgetting a Whombat on a device (`remove`) is the only other way a pin goes.
- The decisions are pure and shared (`@whombat/client/managed` `pin.ts`): `openDecision(known, directory)` →
  proceed / changed / unpinned; `trustDecision({pinned, named, directory})` for links and kits → `changed` (this
  device's pin ≠ directory), `mismatch` (the link or kit ≠ directory), `missing` (names nothing and nothing pinned),
  or `pin` (`isNew`: store it with the link's source). Every session is opened with the pinned PeerId, never the
  directory's; the directory comparison only decides what the person sees before anything connects.

## AP-64 Opening a Whombat: go on, hard stop, or set it up

- **Pinned and equal to the directory** (list, links that name an appliance): as before; the directory's name may
  update the record's name (metadata, not the pin).
- **Pinned and different: the hard stop.** Nothing is sent to the appliance, no session is opened. Web
  `/appliances/<device>/identity-changed`, phone route `identityChanged`, plain full page (`ConnectionGate` /
  `GateScreen`): “This Whombat’s identity has changed” / “This device knows your Whombat by a different identity than
  the one Whombat’s servers gave. Someone could be trying to intercept your connection. If you replaced or reset your
  Whombat, claim it again, then add this device from the device you claimed it with.” The primary action goes back to
  the list; the secondary, explicit “Forget this Whombat on this device” asks to confirm (web `confirm`, phone
  `Alert`) and removes the record, held links and the push handle, so it can be set up again through a trusted path.
  A running session that ends in `identity_mismatch` (the pinned identity isn't what answered) shows the same stop
  instead of the old “This isn’t the Whombat you claimed”.
- **Not pinned: “Set up this device”** (web `/appliances/<device>/setup`, phone route `setup`, the sign-in frame):
  the three ways in — a link from a device that's already set up (Settings · Devices · “Add a device”), an invite link,
  the recovery kit — a “Paste a link” field (`parseSetupLink`: add, invite or get-back-in links; on the web the link is
  opened like any link to the page, so its fragment is held and dropped as usual), “Use your recovery kit”, and back.
  It never connects with the directory's PeerId. `/appliances/<device>/pair` without a pin goes here too.
- **A link whose `p` differs from the directory**: “This link doesn’t match your Whombat” (“…so nothing was sent to
  it. Someone could be trying to intercept your connection. Ask for a new link from a device that’s already set
  up.”), before any secret is sent; no Forget (nothing was stored). A kit: “This recovery kit doesn’t match your
  Whombat”.
- **Control unreachable** while following a link that names a pinned Whombat: it opens (its session checks the pin);
  an unpinned one goes to the list. Opening the last-used Whombat at start doesn't ask the directory at all.
- `setup`, `add` and `identity-changed` are journeys, not burrow paths (`parseApplianceLinkPath`).

## AP-65 Recovery kit version 2: the kit names the identity

- `kitText` writes `Kit version: 2` and `Appliance identity: <PeerId>` (the pin of the device that saves the kit) and
  ends with `Checksum: <16 hex>` = the first 16 hex characters of sha256 over the lines above it, each trimmed, without
  trailing empty lines, joined with `\n` (Windows line ends and trailing spaces still read). The checksum catches a
  damaged or edited file, not a forged one: whoever can write the file can recompute it — and whoever has the file
  has the recovery key anyway.
- `readKitFile` → `{ok, kit: {secretKeyHex, device, accountId, appliancePeerId, version}}` or `{ok: false, reason:
  'not_a_kit' | 'damaged'}`. A file with any version 2 line counts only whole (checksum right, identity a valid PeerId);
  otherwise “That kit file is damaged or was changed. …”.
- The recovery screen no longer opens a session on mount. The kit (or the typed key) is checked first
  (`trustDecision` with the kit's identity): pin ≠ directory → the hard stop; kit ≠ directory → the kit stop; a kit
  that names an identity on an unpinned device pins it (`kit`, only once `recovery.enroll` succeeded); a version 1 kit
  or a typed key works only on a device that already has a pin for that Whombat, and otherwise is refused: “This kit is
  from an older version and doesn’t say which Whombat it’s for, so this device can’t check that it’s talking to yours.
  Make a new kit from a device that’s still set up (Settings · This Whombat · Recovery kit), then use that one here.”
  Only then does an enrollment session open, pinned to that identity, and closes after `recovery.enroll`.
- The kit must name the device it is used for (`Appliance:`), as before.

## AP-66 The add-a-device link

Replaces directory trust for pairing. An enrolled device's Settings · Devices → ADD A DEVICE → “Add a device”
shows `<hosted UI>/appliances/<device>/add#p=<PeerId>` (the web: read-only field and “Copy the link”; the phone: the
link as selectable text and “Share the link” through the share sheet, which also copies), with “The link only tells the
new device which Whombat is yours. It lets nothing in by itself.” The phone's own form is
`whombat://appliances/<device>/add#p=…` (`addDeviceAppLink`); both are parsed (`parseAddDeviceLink`). Opening it on a
device signed in to an account of the same organization: the directory entry must exist (“This Whombat isn’t in your
organization. …”), `trustDecision` with the link's identity, then the pin (`add-link`, not enrolled) and the existing
pairing (code + fingerprint, AP-37). The link is not a credential: approving the pairing still is. The web holds the
fragment like the other links (`whombat:add-device-link`, dropped from the address bar at once). No QR code: the web
app has no QR generator dependency, and one isn't worth adding for this.

## AP-67 Invite and get-back-in links name the identity

`inviteLink(ui, device, secret, peerId)` → `…/appliances/<device>/join#s=<secret>&p=<PeerId>`, `reenrollLink` →
`…/get-back-in#s=<secret>&p=<PeerId>`; `p` is the inviting device's pin (web `managed.appliancePeerId`, phone
`ManagedContext.appliancePeerId`). Parsing takes the fragment in any order. A link without `p` still parses with
`peerId: null` and is refused on screen (“This invite link is from an older version. Ask for a new one.” / “This link
is from an older version. Ask the owner for a new one.”); a `p` that isn't a PeerId is no link. Opening one: the
directory entry, `trustDecision`, then pin (`invite` / `reenroll`) and the existing join / get-back-in screens; a
mismatch stops before the enrollment session opens, so the secret is never sent. Claim-card links keep ignoring their
`p` (AP-48): the claim's CPace authenticates the box.

## AP-68 When a Whombat's identity changes

The runtime never rotates its content identity. A replaced or reset appliance is a new device with a new identity
(appliance BK-07, BK-13). The path is therefore:

1. **Claim it again.** CPace proves the new identity to the claimer; the claim is the one source that may replace an
   existing pin (`replacePin`).
2. **Other devices:** they hit the hard stop, “Forget this Whombat on this device”, then set up through an add-a-device
   link from the claimer's device or an invite (with the new `p`).
3. **A new recovery kit.** Kits naming the old identity stop at the kit mismatch; version 1 kits work only where a pin
   exists (the new pin, then).

**Designed, not built — a rotation statement for a planned hardware move.** Shape: `IdentityRotation {purpose:
'whombat/identity-rotation/v1', device, oldPeerId, newPeerId, issuedAt, nonce}`, canonical JSON, signed with the old
content identity's Ed25519 key while the old box still runs, carried by the new box (e.g. in the enrollment welcome)
and by the directory as a hint only. A client with a pin equal to `oldPeerId` verifies the signature under that pin,
checks `newPeerId` equals what answered the handshake and `device` matches, and re-pins with a new source `rotation`.
Needs a contracts schema and cross-language vectors, a runtime operation to export the statement before the move
(BK-07 never backs the identity key up, so it must be signed on the old hardware), and a decision on how long a
statement is accepted. Until then, an identity change always goes through a new claim.

## AP-69 Tests: a directory that lies

- **Fake world:** `lieAbout(device, true | peerId | false)` makes control's list report an impostor's identity (the box
  keeps its own; persisted with the world); `peerOf(device)`, `impostorPeer()`; `connects()` lists every connection
  the page attempted (device, pinned identity, channel) since it loaded.
- **Unit** (`packages/client` `pin.test.ts`): the registry never changes a pin except by a claim, keeps the source,
  reads old records as `legacy`; `openDecision` / `trustDecision` for every case; invite, re-enrollment and
  add-a-device links with, without and with a foreign `p`, in any order; kit version 2 round trip, a changed identity
  or line (checksum), a recomputed checksum over a malformed identity, a version 1 kit; `parseSetupLink`. Phone
  (`apps/mobile` `incoming.test.ts`): the links that open the app are sorted into set-up links (with their identity),
  claim links and appliance links.
- **e2e** (`apps/web/e2e-managed/identity.spec.ts`): open from the list with a pin and a lying directory → hard stop,
  no connection, pin unchanged, the deep link stops too, Forget → set up this device; a pinned browser keeps connecting
  to its pin whatever the directory says; an unpinned browser → set up this device, a wrong paste refused, `/pair`
  redirected, no connection; an invite with `p` and a lying directory → the link stop, no connection, the invite still
  open, then with the truth the link pins (`invite`) and joins; an invite without `p` → refused; add-a-device link →
  stop when lying, else pin (`add-link`) and pairing to the app; the link pasted on the set-up page; kit version 2 →
  the kit stop when lying, else pins (`kit`) and opens; a version 1 kit on an unpinned browser → refused, a damaged
  kit caught. Existing journeys now expect `&p=` in links and the set-up page for a new browser's deep link.
- **Residual risks** (in `docs/privacy-and-security.md` §3.6): `legacy` pins may have come from the directory before
  this change and are kept; a version 1 kit or a typed key rests on whatever pin the device has; the first claim still
  pins control's `contentPeerId` only after CPace confirms it; a link or kit is only as trustworthy as the channel it
  was sent over and the device that made it.

## AP-70 Contracts 0.10.0 (CT-76…CT-79)

Vendored as AP-02 says (`vendor/whombat-contracts/0.10.0/`, root `package.json` and the `pnpm-workspace.yaml`
overrides, `pnpm contracts:verify`, lockfile in the same commit). What the app uses: `licence.status` and
`licence.refresh` (`sessionOps.licenceStatus` / `licenceRefresh`, `LicenceView`), `ApplianceStatusOutput.licence`,
the app codes `licence.lapsed`, `licence.limit` (`LicenceLimitDetails`) and `licence.renew_failed`,
`APPLIANCE_TERMS_VERSION` with `claims.start`'s required `terms`, `accounts.delete`, and the new `CONTROL_REASONS`.
`ClaimStart` now carries `terms`; `claimStartOf(request, terms)` and `claimAppliance({…, terms})`. `ControlError`
gains the codes `terms_required`, `self_install_not_allowed`, `devices_allowed_reached`, `last_owner`,
`org_has_devices`, `email_mismatch` (control's `details.code`). The app and control ship together: a 0.10 control
refuses a claim from an older app (`terms_required`), and this app's claim is refused by an older control.

## AP-71 Subscription, strips and refusals (LC-13, LC-14)

- **Settings → This Whombat → SUBSCRIPTION** (web `ApplianceTab`, Android `WhombatScreen`), right after CONNECTION, only
  when `appliance.status` has a `licence` (hidden on older runtimes and unclaimed boxes, CT-79). One row: the state
  (“Active”, “Trial”, “Payment problem” for `past_due` and grace `payment`, “Not confirmed since {date}” for grace
  `not_renewed`, “Not confirmed yet” for grace `no_licence`, “Ended” for lapsed) with a status dot (ok, warn, bad), and
  the meta line: the plan (“Team plan”), “Valid until {date}”, or “Agents keep working until {date}” in grace, or
  “Agents and automations are paused. …” when ended; `past_due` adds that the last payment didn't go through. Then a row
  per limited count (“Members 3 of 5”, a warn dot at the limit). Owners and admins get “Check again”
  (`licence.refresh`): “Checked just now.” with the new state; `licence.renew_failed` → “Couldn’t reach Whombat’s
  servers, so nothing changed. …”; `rate_limited` → “You just checked. …”. Dates are “9 October 2026” (`licenceDay`).
- **Strips** (`licenceBanner`): grace for owners and admins only (“Your Whombat couldn’t confirm its subscription.
  Agents keep working until {date}.” / “There’s a problem with your Whombat’s subscription. …”), lapsed for everyone
  (“Your Whombat’s subscription has ended. You can still read and export everything.”), from `licence.status` asked on
  session open and every 10 minutes. Web: the connection, kit and push strips now stack in one fixed column
  (`.strips`); the licence strip has a warn or bad border. Android: one strip at a time as before, in the order
  connection trouble, a note, the licence, the kit; its border follows the tone.
- **Refusals** (`licenceRefusalText`, both transports): `licence.lapsed` → LC-14's line; `licence.limit` → “Your plan
  allows {n} {members|agents|connectors}. …” (singular for 1). Web: the composer's notice (messages, commands), run
  actions' toast, hiring an agent (toast), AI search (toast), Google connections; invites through `inviteErrorText`
  (create and accept, web and Android). Android: the shared `errorText` behind every mutation alert, so sending,
  runs, automations and packs say it too.
- **Fake world:** `faults.licence(device, kind | {kind, refreshTo?, renewFails?, limits?})` with the runtime's
  states (`none` = a runtime without licences, `unknown_op`); default active, Team plan, members 5, connectors 3. A
  lapsed box refuses a message with an `@` (an agent turn) and `enroll.invite.create`; the member limit refuses
  invites. The shared logic is unit-tested (`licence.test.ts`); e2e `licence.spec.ts`.

## AP-72 The appliance terms at claim (LC-17, LC-18)

- `apps/web/src/legal/appliance-terms.md` is an exact copy of `appliance/docs/legal/appliance-terms.md` (DRAFT
  banner included; the harness gate compares them). The hosted UI renders it at `/legal/appliance-terms` without
  signing in (`LegalPage`): a small renderer for the file's Markdown (headings, paragraphs whose wrapped lines are
  joined, lists, the quoted banner as a note) whose inline text goes through core's `parseInline`, so no HTML is
  ever interpreted. It uses the design system's type and colors; there is no mock for it.
- Claim screens (web `ClaimFoundScreen`, `ClaimCardScreen`; Android the same): an unticked checkbox “I agree to the
  Whombat Appliance Terms” before the claim button, which stays disabled until it's ticked. Web: a real
  `<input type="checkbox">` with its label, the link opening the page in a new tab. Android: a `Pressable` with
  `accessibilityRole="checkbox"` and its checked state, 44px high, and a separate 44px link that opens
  `<hosted UI>/legal/appliance-terms` in the browser. `claims.start` carries `terms: {version:
  APPLIANCE_TERMS_VERSION}`.
- Refusals: `terms_required` → “The Whombat Appliance Terms have changed. Update the app, then try again.”;
  `self_install_not_allowed` → “This Whombat was installed by hand, and your plan doesn’t include self-installed
  Whombats.”; `devices_allowed_reached` → “Your plan covers {n} Whombats.” when control's message names n (control
  puts the number only in its message, so `devicesAllowedOf` reads it there), else “Your plan doesn’t cover another
  Whombat.”
- Fake world: control refuses a claim without the current version and records each claim's version
  (`faults.claimTerms()`); `faults.claimRefusal(…)` for the two plan refusals.

## AP-73 Deleting the cloud account (MA-25, CT-78)

- Entry: “Delete account” under the email on Your Whombats (web and Android). The screen (sign-in frame) says what is
  deleted (sign-in, passkeys and sessions everywhere; memberships and invitations to the email; notification
  registrations; organizations where you're the only person) and what stays (everything on the organization's
  Whombats — ask an owner to remove you there; the audit log without the email for up to 400 days and backups for up
  to 35 days), and to export first. Typing the account's email (any case) enables “Delete my account”;
  `accounts.delete {email}`. Refusals: `email_mismatch`, `last_owner` (“…Make someone else an owner first.”),
  `org_has_devices` (“…Invite someone to take it over first, or contact support.”).
- **Local state afterwards.** The app forgets that account's registry (every pinned Whombat, last used), its held
  links and claim card, and its push handle entries, then signs out (which also removes the cloud token). **The
  endpoint key stays**: it belongs to the browser or phone (AP-20, AP-27), other cloud accounts on the same device use
  the same key, and it remains enrolled on appliances until an owner removes the device there; “Set up this device
  again” (AP-39) is the way to drop it. Recorded as a residual risk in the privacy document §4.1.
- Fixed on the way: the web kept the magic link's `verify` after using it, so signing out (or deleting the account)
  in the page that had just signed in showed “Signing you in…” forever. It is cleared once the sign-in succeeded.
- Fake world: `control.deleteAccount` with the three refusals (`faults.deleteRefusal('last_owner')`; a claimed
  Whombat makes `org_has_devices`), and on success signs out and drops the organization.

## AP-74 whombat-app 0.3.0

Identity pinning (AP-63…AP-69) and contracts 0.10.0 (AP-70…AP-73) are released as 0.3.0: the root `package.json`
version, tagged `app-v0.3.0`, `pnpm release:dist` for the legacy artifact (docs/publishing.md). The hosted build and the
Android app carry the same code. Link formats the runtime and the harness should know: `…/appliances/<device>/join#s=
<secret>&p=<PeerId>`, `…/get-back-in#s=<secret>&p=<PeerId>`, `…/appliances/<device>/add#p=<PeerId>` (and
`whombat://appliances/<device>/add#p=…`), `/legal/appliance-terms`; kit files are version 2 (AP-65).

## AP-75 First run: the burrow starts with the organization's name; no Whombats yet → straight to the claim

Decided with John on 2026-09-26. A new customer used to type their company's name twice (“Name your organization”,
then “Name your burrow”) and, with no Whombat yet, had to press “Claim a Whombat” on an empty list to reach the box
the claim page was about to find anyway.

- **The burrow name starts with the organization's name.** The organization lives at control, the burrow only on the
  appliance, so both stay (control never learns the burrow name). The first burrow's name field is filled in with the
  organization's name, and most people just continue. Web: `ManagedContext.orgName` (set by `ManagedRoot` from the
  session's organization), read by `OnboardingScreen` as the initial name (and so the slug check starts at once); a
  resumed onboarding keeps its own name. Android: `ApplianceRoot`'s `orgName` → `FirstBurrow`. Nothing new crosses a
  process boundary: the app already had the name from control and sends it only as the burrow name the owner
  confirms.
- **Organization tip.** “You can change it later” promised a rename control doesn't have; the tip now reads “Most teams
  use their company’s name. Your burrow starts with it too.”
- **No Whombats yet: straight to the claim.** On the list, an organization with no Whombats asks `claims.nearby` once
  per visit (`looksNearbyFirst`: owners and admins only, the roles with control's `claim` right) before it shows the
  empty state. Found one or several: straight to the claim (“We found a Whombat on your network” / “We found {n}
  Whombats…”), and what was found goes with it (`nearbyClaimStep`), so the claim page doesn't ask again until “Look
  again”. Found none, or control unreachable: the list with “No Whombats yet…”, as before. While it looks the list
  shows no empty state, so it doesn't flash “No Whombats yet” before moving on. Going back to the list in the same
  visit stays there (the “once” is per mounted signed-in tree: a reload looks again). An organization that already
  has a Whombat is never redirected; “Claim a Whombat” stays for a second box. `nearbyClaims` is rate-limited at
  control (60 per account and 120 per network per 10 min), so one extra call per visit is well within it.
- **Why not a notice instead:** for someone with no Whombat, the claim is the only thing to do; the letters remain the
  proof, so a box that isn't theirs (shared public address: offices, CGNAT) still can't be claimed by being shown.
- Tests: `claim-first-run.test.ts` (the two helpers), the onboarding test with a managed context, and the managed e2e
  first runs (one box, several boxes, back to the list, nothing found). The e2e `signIn` helper keeps landing on the
  list by having nothing nearby while the list looks.

## AP-76 whombat-app 0.3.1

AP-75 released as 0.3.1 (root `package.json`, tag `app-v0.3.1`). No contract change; the hosted build and the Android
app carry it.

## AP-77 Contracts 0.11.0 (CT-80…CT-83)

Guided setup in the personal assistant's DM (Whombat `docs/decisions/assistant-guides.md` AG-01…AG-18) needs contracts
0.11.0, vendored like 0.10.0 (`vendor/whombat-contracts/0.11.0`, `sha256sum -c`, both `pnpm-workspace.yaml` overrides
and the root dependencies). A `guide` card breaks readers before 0.11.0 (`MessageCard` is closed), so the web and the
Android app ship with the server that posts them. The recovery-ceremony vectors are read from the 0.11.0 schema
archive.

## AP-78 Provider marks (AG-16)

`@whombat/brand` draws other companies' marks as the same renderer-agnostic node trees as the logo (`src/marks.ts`,
`BRAND_MARKS`): the Google “G” (Sign-In branding), Microsoft's four squares, Claude, OpenAI and GitHub (Simple Icons,
CC0; the trademarks stay their owners') and a generic envelope (Lucide `mail`) for “Other email”. Web
`<BrandMark mark size>` (`@whombat/brand/react`), Android `apps/mobile/src/ui/BrandMark.tsx`. **The fixed-colour
exception:** Google, Microsoft and Claude keep their published colours, the one place outside status dots, avatar
tones and code blocks where the apps draw literal colours; OpenAI and GitHub, published in flat black or white, and
the envelope use `currentColor` so they follow the text (ink on light, paper on dark), as their guidelines ask. Marks
are always decorative (`aria-hidden`): the option's title names the provider.

## AP-79 The guide card on the web (AG-02, AG-03, AG-17)

`apps/web/src/features/cards/GuideCard.tsx` (+ `GuideForm`, `GuideConnect`, `GuideCardContainer`), wired into
`MessageCard`. There is no mock; decisions beyond AG-17:

- **Shell:** the approval card's (1.5px `--line`, 18×20px, 14px rhythm), label row from core `guideCardLabel`
  (`SET UP · GOOGLE · STEP 4 OF 6`), 19px title, body paragraphs split on blank lines in the approval message's
  14.5px `--ink2`. The card is a size container: tiles go two to a row from 520px, the service checkboxes two to a
  row below 460px, so the same card works in a phone-width column.
- **Tiles:** 1.5px `--line` border, 12px radius, 24px icon, 15px/600 title, 13.5px `--mut` description, the badge as a
  mono pill in its tone; hover `--line2`; selected = `--role-developer` border + an 18px check; unavailable = 55%
  and `disabled` (the badge is the button's description). Single choice acts on tap; multi choice uses
  `aria-pressed` toggles and the primary submit (`submitLabel`, “Continue” when absent), sent in option order.
- **Buttons:** `primary`/`secondary`/`quiet` = the app's primary / secondary / ghost button at `lg`; an action with
  `href` is a link (in-app paths route in the app, https opens a new tab) and stays on a locked card.
- **Copy rows** use the approval conditions' row rhythm (label, mono value, “Copy” named “Copy {label}”, toast
  “{label} copied.”). **Status rows:** 8px dot named Working / Needs attention / Not working / Not checked, the
  label, and the detail beside it when it fits; a row's `href` makes its own words the link (the detail, else the
  label), so “Turn it on” stays server copy.
- **Locked cards:** acting blocks (buttons, the form, connect) go; choices stay, the unchosen at 55%, the chosen
  marked (with “(your choice)” for screen readers); a quiet answer row: “You chose {label}” when the answer has
  `optionIds`, else the server's label as it is (“Client ID 1234567890ab… saved”); expired without an answer: “This
  expired. Ask me any time.” with a clock.
- **Acting** (`useGuideAct`, `@whombat/client/react`): the card locks at once in every cached message list
  (`applyOptimisticGuideAnswer`; the label is the chosen titles or the button's label, “Sending…” for a form), and
  the snapshot is refetched when the server says ok so its own answer replaces the optimistic one. Any refusal
  restores and refetches: `guide_closed` shows nothing (the card appears as the server has it), `invalid_values`
  puts the server's words under the fields (keys `values.<id>` or `<id>`), everything else is the server's message in
  a toast; a request that never arrived says “Couldn’t reach Whombat. Nothing changed, try again.” One act at a time per card
  (a second press before the re-render sends nothing). The focus follows the card: acting moves it from the button
  that went away to the answer row, and a refusal that reopens the card moves it to the card.
- **The form:** text and secret inputs (`type=password`, no autocomplete, no spellcheck), required fields say “Fill
  this in.” (“Choose the file.” for a file) and nothing is sent. A `json_file` field takes a picked or dropped file,
  read in the browser with `parseClientSecretFile` (the Desktop-client refusal of CN-03, the redirect mismatch
  warning when the Connections status is readable, files over `GUIDE_VALUE_MAX` refused); a web client fills the
  form's first text and first secret field, and the file's text is sent as the field's value too. Values go only to
  `guides.act`, trimmed except the file, and are cleared once the server took them. While the optimistic lock waits,
  the form stays mounted (hidden), so a refusal brings back what was typed.
- **Connect:** the `ServicePicker` ticked as the block says and “Connect Google” / “Reconnect Google”;
  `useConnectGoogle` gained `{returnTo}`, and the card's `returnTo` goes to `connections.startGoogle` unchanged.
- States for the harness and tests are in `cardStates.ts` (`guide-*`); `visual/cards.html?width=358` renders a phone
  column. Screenshots: `tmp/visual/guides/` (not committed).

## AP-80 Google connect on a managed Whombat (AG-14; supersedes AP-24 for Google)

- `useConnectGoogle` no longer refuses on a managed Whombat. Before leaving for Google it holds `{device, returnTo,
  at}` in this tab's `sessionStorage` (`whombat:google-connect`, 30 minutes; `holdGoogleConnect`, `@whombat/client/
  managed`): nothing secret.
- `/connect/google` (the managed redirect URI, `managedGoogleRedirectUri`) is a `ManagedRoot` route: its first render
  reads `code`, `state` and `error` and replaces the address with the bare path at once (never in history). Signed in,
  `GoogleReturnFlow` reopens the held Whombat (else the last used), opens an app-channel session, sends them once with
  `connections.finishGoogle` (`finishGoogleConnection`), forgets the hold and replaces the location with the answered
  `returnPath`. A transport failure goes to the return path with `connect_error=exchange_failed`; the route without
  Google's answer (a reload) goes to the held return path (with `connect_error=invalid_state`) or `/`; a Whombat
  this browser can't open goes to the list. The screen meanwhile: “Connecting Google…”.
- Settings → Connections is unchanged: it shows whatever `googleSetupFacts.redirectUri` the appliance returns (the
  managed URI on a managed one). Self-hosted keeps the HTTP callback.
- The hosted UI's host receives that one request with the code in its query string: the hosting must not log query
  strings (privacy §7). The dev server (Vite) doesn't log requests.
- Fake world: `connectors.status` with a set-up app, `connections.startGoogle` answers the hosted route directly (as if
  Google had consented), `connections.finishGoogle` checks the state and records what it got
  (`faults.googleFinishes(device)`). Managed e2e: `e2e-managed/google.spec.ts`.

## AP-81 The DM after Google, and the assistant's suggestions (AG-04, AG-08, AG-12)

- The DM's empty state (and its Connect Google callout) is only the moment before the assistant's welcome: it shows
  while the conversation has no messages, as before.
- Google comes back to the DM with the server's guide marker and `connected=google` / `connect_error=…`. The server
  posts the result in the conversation, so the web only cleans the address: a DM keeps only its own search params
  (`thread`, `approval`) and replaces the rest, whatever the marker is called.
- Settings → General, in the PROFILE card under “Assistant · {name}”: a switch “Suggestions from your assistant”
  (“Now and then {name} offers to set something up for you in your DM.”) and, when `dontAsk` isn't empty, a link
  button “Reset ‘Don’t ask again’” (toast “Reset. Your assistant may suggest those again.”). Both send the whole
  `assistant` preference (the PATCH replaces it) and patch the cached bootstrap at once, restoring it on failure.
  “Don’t ask again” is answered in the DM and changes the preference on the server with no event, so the row reads
  `GET /me/preferences` fresh and each save applies its change to what the server has just then, never to the
  bootstrap's copy (which would wipe a topic added since the page loaded).

## AP-82 Guide cards on Android (AG-15)

`apps/mobile/src/ui/guide.tsx` (`GuideCardView`), the pure view model and form rules in `data/guides.ts`, rendered
whole in the chat like the digest (92% wide), acting through the same `useGuideAct`. Every target is at least 44px and
action buttons stack full width. Beyond the web's rules:

- **Connect** has no OAuth on the phone (SUB-11): the note “Google sign-in opens in your browser.” and “Connect
  Google on the web” (“Reconnect Google on the web”), which opens the block's `returnTo` path without its query on
  the web (`applianceLink` on a managed Whombat, the server's URL on a self-hosted one). In-app `href`s open on the
  web the same way (query kept). Where there is no web (the demo world) those buttons and links are hidden.
- **Copy** uses React Native's `Clipboard` (no new native dependency), falling back to the share sheet; the value is
  also selectable, and the button reads “Copied” for 2 s.
- **The JSON file** is picked with the document picker, read, and its cache copy deleted at once; the same parser and
  fill rules as the web.
- Refusals show in an alert titled “That didn’t go through” (nothing for `guide_closed`); `invalid_values` with field
  errors shows them under the fields only. The form stays mounted (hidden) once the card locks, as on the web, so a
  refusal brings back what was typed with those errors.

## AP-83 whombat-app 0.4.0

AP-77…AP-82 as 0.4.0 (root `package.json`; tag and release by the orchestrator). The runtime must be on contracts
0.11.0 and provide `guides.act`, `connections.finishGoogle` (both allowlisted session ops) and the managed redirect
URI in `googleSetupFacts`; the hosting of the hosted UI must not log query strings.

## AP-84 Contracts 0.12.0 (CT-84…CT-88, Whombat work-supervision)

0.12.0 vendored like 0.11.0 (`vendor/whombat-contracts/0.12.0`, `sha256sum -c`, both `pnpm-workspace.yaml` overrides
and the root dependencies; 0.11.0 removed). It widens closed unions (`PlanStepState`, `LinkRef`, `SearchResultType`,
`RealtimeEvent`): the web and the Android app ship with a runtime on 0.12.0. `@whombat/client` gains `usePlans`,
`useActivity`, `useWorkOverview` and `usePlanWrite` (every plan change; the answer's plan goes everywhere it shows
through `applyPlan`, which never replaces a newer `updatedAt`). Realtime: `plan.updated` also patches `plans.list`;
`activity.updated` upserts rows by id into the `activity.list` caches it belongs to (by conversation, turn, or run — a
run list whose run id the cache can't tell refetches) ordered oldest first, and ignores a report that isn't newer by
`(seq, updatedAt)`; it also becomes a Work item's latest row when important. `work.overview` is never patched: the
approval, plan, run, automation-run and `dispatch.updated` events invalidate it, and a reconnect on `conv`, `run` or
`me` refetches plans, activity and Work. `@whombat/client/work-fixtures` serves plans, activity and the Work view in the
web's and Android's fixture worlds, following the server's plan rules (409 `step_started`, handoffs, start asks the
agent).

## AP-85 Plan steps on the card and in the pane (WS-02, WS-09)

- Markers: blocked = bad outlined circle, state label bad; cancelled = line2 outline (the queued marker) with the title
  muted and struck through, label mut. `PLAN · N STEPS` and progress count steps that aren't cancelled.
- The card's line under a step: a blocked step always shows its note and links (“Run #1907”, “Approval #12”,
  “Automation run #41”, from `step.refs`); a gate step only when it has a note and isn't waiting on an approval. The
  mock's gate step (“Deploy to staging · Needs you”, its approval card right below) keeps its single row even though
  the runtime gives it a note; the pane shows every note. Approval links open the modal over the current page.
- “Open plan” is a second card button after “Open plan canvas” (the mock's button keeps its place); it opens the pane
  with `?plan=<id>` on the current page (thread closed).
- The plan pane is the thread pane's frame (400px `SidePane`, 76px header “Plan” + “#room · Due 14 Oct”, overlays
  below 1240px). Per step: marker, title, owner, state, note, links; up to two next actions from `planStepActions` as
  buttons (Reassign and Cancel never among them) and a “More for step n” menu (the sidebar's context menu: arrow keys,
  Esc) with Reassign…, Cancel step, Edit title, Move up / down and Remove step (only `planStepRemovable`). Reassign
  opens an inline owner select (“Hand over”). Title rename and due date inline; add a step with an owner at the
  bottom; CANVAS: “Create plan canvas” / “Open plan canvas”; “Made by Sketch at 09:13 from this message.”
  `&step=` scrolls to the step, focuses it and gives it the `sel` background. Refusals are one toast (409
  `step_started` → “This step has started, so it can’t be removed. Cancel it instead.”).
- Owner pickers list the conversation's members (people first, then agents with their role), else the burrow's.

## AP-86 Making plans, and the conversation's plans (WS-01, WS-09)

- “Plans” in the conversation header (channel, DM, branch room) sits before the mock's actions and opens `?plans=1`:
  the right pane lists the conversation's plans (open first; progress, due, the step that needs someone) with “Make a
  plan”; empty: “No plans here yet. Make one to share who does what, or use “Make a plan” on a message.”
- “Make a plan” (560px modal, kicker NEW PLAN): title (a message's first line without markup, ≤ 160), steps with owner
  selects (+ Add a step, up to `PLAN_MAX_STEPS`), optional due date, “Also create a plan canvas”; “Make plan”. On
  success the pane opens on the new plan (toast “Plan made. Its card is in the thread.” from a message).
- One pane at a time in the URL: `plan` wins over `plans`, both over `thread`; opening a thread clears them. Ids must
  carry their prefix (`pln_`, `stp_`).

## AP-87 The message menu

Messages get a menu (right-click, or a 28px “More actions” button at the row's top right, shown on hover and focus
only, so rows look as in the mock) with “Make a plan”. Links and text fields keep the browser's menu. Not in the thread
pane yet.

## AP-88 Observed activity and the Work view (WS-13…WS-19)

- One activity feed (web `features/activity`): a 20px status mark (done ok ✓, failed bad ✗, waiting warn hourglass,
  interrupted mut dashed circle, running the working dot with its halo), title, outcome detail (mono, toned only when
  it's bad or waiting), object (mono, one line), time. Routine reads fold into `collapseActivity` groups that open
  (`<details>`); a row with evidence opens to it in the live log's code colours (`$ ` before commands) with “Shortened:
  this is the end of the output.” when truncated. No rows: `ACTIVITY_NO_TELEMETRY` when `reported` is false, “No steps
  reported yet.” otherwise. The run page shows it as ACTIVITY under the two columns, before the keys; an older server
  (404) shows nothing.
- `/:burrow/work` (the sidebar's “Work” row, AP-92, and its “Needs you” row while something needs you):
  audit-log page (1040px, 36px title, subtitle “What agents are doing for you, what’s stuck and what needs you. Every
  item opens where it lives.”, Refresh). NEEDS YOU always shows (“Nothing needs you right now.”), the other sections
  only with items; nothing at all: “Nothing needs you, and no agent is working for you right now. Work shows up here
  when agents start, get stuck or ask.” Rows: 28px avatar (agent, else owner), the title as the item's link, `where ·
  since · who`, detail (hidden when it repeats the health text), health with its dot (quiet is idle-grey, stalled
  bad, never “failed”), the latest activity row, then the item's actions as buttons (approve / decline with
  `useDecideApproval`, pause / resume, take over after `TakeOverDialog`, start / retry / mark done through the plan
  endpoints, reassign opens the step in the plan pane) and “Show activity” for a turn that isn't queued; the status
  pill (outline tag, neutral = mut) on the right. `?section=` scrolls to a section.

## AP-89 Search over plans, decisions and automations (WS-21, WS-25)

TYPE tags from `SEARCH_TYPE_LABELS`; plan, decision and automation results add their status pill after the receipt
marker. The mock's five chips always show; Plans, Decisions and Automations show when they have results or are the
chosen filter, so the mock's search is unchanged. Citations in the answer card link to their result's own link; a
chat receipt of a plan, approval or automation run opens that item even when the answer came from a search (other
receipts still open the search, as in the mock).

## AP-90 Work supervision on Android

- A Plan screen (from the card's “Open plan ›”, `plan` links and `whombat://plans/:planId?stepId=`): progress, steps
  with the web's markers and tones, notes, link rows (“Run #1907 ›”), and the step's actions as 44px buttons (the
  first filled; Reassign, AP-93; Cancel asks “Cancel this step?”). Adding, editing and reordering stay on the web.
- The Inbox gets a WORK section under the chips (All and Needs you only): non-zero counts in their tones, “All work ›”,
  and two rows (needs you, blocked, failed, running, queued; approvals are counted but not repeated, the inbox lists
  them). Always there once loaded (AP-94).
- A Work screen in the inbox's grouped-list language, up to three action buttons per row (Decline and Take over ask
  first), empty: “Nothing needs you. Work shows up here when agents start, get stuck or ask.”
- The run screen lists activity (collapsed groups, evidence behind “Show details”); search shows the new chips, TYPE
  tags and status pills; `work` and `automation_run` links open their screens.

## AP-91 Visual comparison with the additions

The mocks don't have “Plans”, “Open plan”, the run page's ACTIVITY or the sidebar's “Work” row: `hideAdditions` (in `neutraliseWorld` and the
cards harness) hides them so every mocked screen is still compared as drawn; the message menu's icon is masked with
the other Lucide icons.

## AP-92 A Work row in the sidebar

“Work” (lucide `Activity`, not a mock slot) after “Audit log”, always there, opens `/:burrow/work` and is the selected
row there; its mono count is needs you + running from `work.overview` (none while unknown or on a Whombat without
it). The “Needs you” row stays as it was: shown while something needs you, opening the Work view.

## AP-93 Reassigning on Android (WS-06)

Reassign is one of the Plan screen's step buttons (secondary). It opens a bottom sheet (“REASSIGN”, “Hand “{step}”
to…”, “They start it from here. The work so far stays linked.”) with the plan conversation's people, then its agents
(56dp rows with avatar, name and role or “Person”, never the current owner or a system agent; everyone the burrow
knows when the members can't be read) and Cancel. Picking one sends `updateStep {ownerId}`: a started step becomes
“Handed off” with “Next: {name} starts it.”, as the server decides.

## AP-94 The Inbox's WORK section is always there

Once `work.overview` has answered, the section shows on All and Needs you even with nothing open (“Nothing running”
in its header row, which still opens the Work screen). It hides only while loading and on a Whombat without the Work
view (the request fails).

## AP-95 Long activity feeds

A feed with more than 13 entries (rows and groups) shows its latest 10 and “Show n earlier” above them (web). Run
bookkeeping (`run_step`, `run_log`, `run_files`) counts as important in core's `describeActivity`, so a scripted
storyline turn alone is 29 rows; folding the oldest keeps the run page readable without hiding a failure among the
latest.

## AP-96 whombat-app 0.5.0

AP-84…AP-95 as 0.5.0, on contracts 0.12.1 (CT-89: routine bookkeeping folds in the activity feed, connector tools in
plain words). The runtime must be on contracts ≥ 0.12.0 and provide `plans.*`, `activity.list`, `work.overview`
(allowlisted session ops) and the `activity.updated` / `dispatch.updated` frames; an older runtime answers 404 /
`unknown_op` and the app shows the plan card as before, no Work view data and no activity.

## AP-97 Unread DMs look like unread channels

The mock never draws an unread DM (Pippa and Hazel are read), so DIRECT rows take the CHANNELS rule: 600 while
selected or unread, and the channel's `.badge` pill with the count (“ unread” for screen readers) while unread
and not selected. The personal assistant's DM is a DM like any other here, so a reply from the assistant shows.
Android already showed the count badge on every DM row, the assistant's included. The visual comparisons read the
fixture world's unread Pippa DM as read (`neutraliseWorld`), as the mock draws it.

## AP-98 Unread outside the page: tab title, favicon, app badge

- The tab title is `(n) Whombat` (`99+` above 99), plain `Whombat` at zero. `n` is what waits for *you*: unread
  messages in DMs plus mentions in channels and branch rooms. Plain channel traffic doesn't count: a busy
  channel would otherwise keep a number in the tab all day. There was no title scheme (the title is static), so
  it doesn't name the burrow or the conversation.
- The favicon gets a dot while *anything* is unread (channel traffic included): `/favicon.svg` drawn on a 64px
  canvas with a `--bad` dot ringed in `--bg` (read from the theme's CSS variables), swapped into every
  `link[rel=icon]` and restored when all is read.
- An installed app (PWA) calls `navigator.setAppBadge(n)`, `setAppBadge()` (a dot) when only channel traffic is
  unread, and `clearAppBadge()` at zero, so the count shows on the dock/taskbar icon.
- Counts come from the bootstrap's sidebar summaries, kept live by `conversation.unread`; an open conversation
  is marked read as before, so it doesn't linger in the count.

## AP-99 The #general welcome

The first time someone opens #general they find a message from “Whombat” at the bottom of the channel (under the
newest message, so also in an empty #general): bold “Welcome to #general, {first name}”, what the channel is for,
how Whombat works, and “Got it”. It is drawn by the client, never sent: no server or contract change, nobody else
sees it, agents never read it.

- #general is the channel whose slug is `general` (the contracts have no flag for it). The words, the first name
  (first word of the name, “there” without one) and the storage key live in `@whombat/client` (`welcome.ts`), so
  web and Android say the same thing.
- The dismissal is kept on the device, per person and burrow: the contracts' preferences have no generic
  “dismissed tips” list (only `assistant.dontAsk`, which means something else), so `localStorage` on the web and
  the secure store on Android (keys `whombat.welcome-general.{userId}.{burrowId}`). A new browser or phone greets
  once more; a cleared store too. Sign-out doesn't clear it (it isn't personal data).
- Web: the message row's layout (40px avatar column, 14px gap, name 15.5/600, the mono time slot carries “Only
  visible to you”, 16/1.55 body) with the Whombat symbol on an `sf2` disc as the avatar, and a primary `md` “Got
  it” button. Android: the channel's author line (24dp disc) and an incoming bubble with the 44dp primary button.
- The visual comparisons hide it (`[data-welcome]` in `hideAdditions`): the mock's #general has no welcome.

## AP-100 SVG attachments show as pictures

The server keeps sniffing SVG as text (BP-A03, a download served as `text/plain`); the clients now show an attachment
whose type is `image/svg+xml` or whose name ends in `.svg` as a picture, up to 1 MB (larger stays the text
preview and download, as before). Only through channels where nothing in it runs or fetches:

- Web: the bytes (fetched with the cookie, or streamed through the session) become a `data:image/svg+xml` URL for an
  `<img>` — the thumbnail (its own shape from the loaded image, `object-fit: contain`, never cropped) and the
  lightbox with its Download. Not a `blob:` URL, although the brief suggested one: a blob has the app's origin, so
  “Open image in new tab” would render the SVG as a document there and run its scripts; browsers refuse to open
  `data:` URLs as top-level documents. Both are allowed by the hosted CSP's `img-src`. A picture that fails
  falls back to the text preview.
- Android: the text, through react-native-svg's `SvgXml` (the app already draws the logo and avatars with it),
  after `svgForNative` removes `<script>`, `<foreignObject>` and every `<image>` that isn't a `data:` URL (SvgXml
  would fetch those). Sized by the root's `width`/`height` or `viewBox`; opens in the image viewer with Share; a
  parse failure falls back to the file row.
- The reads are cached by URL (web: the newest 32, cleared with the appliance scope, AP-17; Android: 16).

## AP-101 Images and SVG drawings in a message's text (contracts 0.12.2, CT-90)

- `![alt](src)` (core already refuses anything but `http(s)` and `data:` PNG, JPEG, GIF, WebP, SVG): web, an `<img>`
  with its alt in the attachment thumbnail's frame (1px `line`, `--radius-card`, `sf2`), at most the column wide
  and 360px tall, `object-fit: contain`; a button opening the attachments' lightbox (`ImageLightbox`, shared now),
  or the link's content when it is inside one (`[![alt](img)](url)`). Android: a row of its own in the bubble,
  260dp / 62% wide at most (images inside a link or bold read as their description), no viewer.
- Remote (`http(s)`) images load on a self-hosted Whombat only. On a managed one they are a link chip — the
  description, the host in mono, opening the image in a new tab (`nofollow`, no referrer) — on both platforms:
  the hosted build's CSP (`img-src 'self' blob: data:`) would show a broken image, and a message on a managed
  Whombat shouldn't make every reader's browser call a third party. A remote image that fails to load becomes the
  same chip. `data:` images always show.
- A code block in `svg` that `svgImageSrc` (web) / `svgImageDocument` (Android) accepts is a drawing: the picture
  (web: `<img src="data:image/svg+xml,…">`, never DOM; Android: `SvgXml` after `svgForNative`), then a mono
  “View code” / “Hide code” toggle (`aria-expanded`; 44dp on Android) that shows the code block as before. Any
  other `svg` block (too large, not a document) stays a code block.
- SVG attachments keep AP-100's own reader (base64 `data:` URL up to 1 MB): core's `svgImageSrc` stops at
  `SVG_IMAGE_MAX` (256 K characters), which is right for drawings in text but would turn back SVG files
  people upload.

## AP-102 Website feedback on a managed Whombat: a notice, no snippets

A managed appliance's runtime doesn't serve `/embed` and refuses intake by design (Whombat
`docs/decisions/managed-providers.md`), yet the integration's detail showed snippets pointing at the runtime's
loopback `PUBLIC_URL` (`http://127.0.0.1:4721/embed/v1/widget.js`). When the app runs over an appliance session
(`useManaged()` isn't null), the detail's INSTALL section is one notice (the Feedback notice style): “Website
feedback isn’t available on a managed Whombat yet. Reports from your website need a public address that only a
self-hosted Whombat has today.” No snippets, no CSP line, no copy buttons; HEALTH drops the “Public address” row
and the `public_url_missing`, `public_url_not_https` and `widget_not_built` warnings. The switches, the other
health facts and the settings stay, so existing integrations can still be read and edited. Temporary, until
managed Whombats get a public intake.

## AP-103 whombat-app 0.5.1

AP-97…AP-102 as 0.5.1, on contracts 0.12.2 (CT-90: image nodes in Markdown, SVG documents as `svg` code blocks,
`svgImageSrc` / `svgImageDocument`). No new runtime operation: the welcome, the unread title and badges and the
feedback notice are the client's own; SVG attachments use the existing attachment reads. A runtime on an older
contracts version sends no image nodes, and SVG documents in text stay code blocks there.

## AP-104 Contracts 0.13.0 (CT-91…CT-96, Whombat feedback-drop)

Vendored like AP-02: `@whombat/core/feedback/drop` (HPKE sealing, site cards, the derived reference),
`FeedbackIntegrationHealth.delivery` and the `drop_*` warnings with their texts, `SnippetInput.embedUrl`/`siteKey`,
`WIDGET_ATTRIBUTES.key`; `feedbackDropApi` and `FEEDBACK_DROP_LIMITS` in `@whombat/control-contracts`. Additive:
nothing the app did before changes.

## AP-105 Website feedback on a managed Whombat: snippets and delivery (supersedes AP-102 where the drop works)

A managed Whombat takes website reports through the encrypted drop (Whombat `docs/decisions/feedback-drop.md`). The
integration's detail on a managed Whombat shows the runtime's snippets again (they load `widget.js` from the embed
origin and carry `data-key`, FD-26/FD-37), the CSP line and copy buttons, and in HEALTH the delivery: **Delivery**
(the runtime's policy sentence, `FEEDBACK_DROP_TEXT.policy`), **Site published** and **Last collected** (relative
times, “Not yet” / “Nothing yet”), **Widget address** (`health.publicUrl`, the embed base). `notFiled7d` and
`expired7d` reach the owner as the server's `drop_not_filed` / `drop_expired` warnings; the app composes no drop
text of its own. Owners switch intake on and off as on a self-hosted Whombat.

**When the drop is available** (`dropAvailable`, `features/feedback/copy.ts`): `health.delivery` is not null **and**
no `drop_unsupported` warning. Otherwise AP-102 stays exactly as it was (the notice instead of snippets, no public
address row), and the intake switch can be turned off but not on (the runtime would refuse it with
`managed.feedback_intake`). *Assumption about the runtime's shape, for the orchestrator:* a managed runtime with
contracts ≥ 0.13 always sends a non-null `delivery` and reports an unsupported manager or control (FD-25, FD-38) as
the `drop_unsupported` warning; a runtime before 0.13 sends no `delivery` (null by the contract's default). The app
does not read `appliance.status.policy.feedbackIntake` for this, so a single integration's health is enough. The
runtime in progress on Whombat branch `feedback-drop` (`feedback/read.ts`) matches this.

The fake world answers as a managed runtime: `feedback.*` details get snippets from `https://embed.whombat.com` with a
fixed site key and `feedbackManagedHealth`; `faults.feedbackDrop(device, 'available' | 'unsupported' | 'none')`
switches it, with the `appliance.status` policy item and the `setIntake` refusal to match.
`e2e-managed/feedback.spec.ts` covers both states and writes review screenshots to `tmp/visual/feedback-drop/`.

## AP-106 The widget's drop mode (FD-27, FD-28)

- **Loader:** reads `data-key` (`^fbk_[A-Za-z0-9_-]{22}$`, anything else ignored) and appends `&key=` to the frame's
  URL. Without a key the frame URL, the requests and their bodies are exactly the direct widget's (the self-hosted
  Whombat's widget is unchanged; its e2e passes as before). Loader 7.4 KB gzipped (8 KB budget).
- **Frame:** a `key` makes drop mode (`frame/drop.ts`). Control's origin comes from `<meta name="whombat-control">` of
  the static `frame.html`; a frame without it can't drop (unavailable). The card is fetched with
  `credentials: 'omit'`, `mode: 'cors'`, `redirect: 'error'`, `referrerPolicy: 'no-referrer'` and checked with
  `verifySiteCard(json, key, {site})` (no time check), then version, suite, `parent ∈ allowedOrigins`,
  `ancestorOrigins[0] = parent` where the browser has it, and the frame's own `parseConfig`. Any failure is the
  existing unavailable view before any form renders.
- **Send** is disabled until the first valid loader message (the bridge's origin, source and instance checks); its
  `event.origin` is sealed as `frame.bridgeOrigin`. `ancestorOrigins` is sealed as an array of at most 8, or null.
- **Seal once per draft:** the `Submitter` is generic over its body; in drop mode the body is the envelope (with its
  derived reference), built once per draft and resent byte for byte on every retry. An edit after an attempt takes a
  new `submissionId` (a drop can't answer 409). Widget version 1.1.0 (`frame.widget` in the plaintext).
- **Statuses:** 202/200 with `receivedAt` → the receipt with `feedbackReferenceFor(site, submissionId)`; 404 →
  unavailable; 413 → “too large to send together”; 429 → rate limited (`retryAfter` from the body, `Retry-After`
  as fallback); **400 and anything else → the server message** (a 400 from control means the widget built a bad
  envelope; the visitor can't fix it); no answer → the network message. `too_large` from sealing is the 413 message
  without a request.
- **Screenshots** (`frame/images.ts`): bytes sniffed as PNG or JPEG and equal to the declared type, not empty or over
  the limit, IHDR / SOF dimensions ≥ 1, ≤ 8192 a side and ≤ 16 MP (the runtime's `inspectScreenshot`). Checked when
  sealing; a refused file gets the existing per-screenshot error, nothing is sent.
- **No storage:** the build refuses a frame bundle that mentions cookies, `cookieStore`, Web Storage, IndexedDB, the
  Cache API, service workers, Web SQL, `innerHTML`-style parsing or eval (`FRAME_BANNED`); a unit test runs a whole
  drop with trapped storage getters and fails on any use; `e2e:drop` traps them in the real frame too.
- The frame bundle grows from 12.4 to 33.5 KB gzipped (noble, R-9); it is the same bundle for both modes.

## AP-107 The embed tree (FD-29, FD-31)

`pnpm build:embed` (root; `pnpm --filter @whombat/widget build:embed`, i.e. `tsx scripts/build.ts --embed`, alias
`--hosted`) builds the widget as a static site of its own for the embed origin, default `apps/widget/dist-embed/`:

```
_headers                      every response: CSP default-src 'none'; script-src 'self'; style-src 'self';
                              img-src 'self' blob: data:; connect-src {control}; form-action 'none'; base-uri 'none';
                              frame-ancestors *  ·  CORP cross-origin · Referrer-Policy no-referrer · nosniff ·
                              Permissions-Policy · HSTS; Cache-Control 300 s for widget.js and frame.html,
                              immutable for assets/*  (no X-Frame-Options)
embed/v1/widget.js            the same bytes as dist/v1
embed/v1/assets/frame.<h>.js  the same bytes as dist/v1
embed/v1/assets/frame.<h>.css
embed/v1/frame.html           static: meta CSP (the header's minus frame-ancestors) first, <meta name="whombat-control">
embed/v1/manifest.json
```

Control's URL is required: `--control-url <url>`, else `WHOMBAT_CONTROL_URL`, else `VITE_WHOMBAT_CONTROL_URL` (the
variable the hosted web build already takes); https, or http on loopback; only its origin is used. `--out <dir>`
writes elsewhere. The tree depends on the deployment's control, like `dist-hosted`, so it is built per deployment
from the pinned checkout and is **not part of `release:dist`** (that artifact is the self-hosted Whombat's, which
serves the widget itself and needs no embed tree). `_headers` has several blocks: a host applies every block whose
path matches (`/*`, then the path's own), and serves 404 for anything that isn't a file (there is no index).
`src/embed-build.test.ts` checks the layout, the identical bytes, `frame.html` and `_headers`; `e2e:drop` serves the
built tree with its headers against a fake control and a strict-CSP website.

## AP-108 whombat-app 0.6.0

AP-104…AP-107 as 0.6.0, on contracts 0.13.0 (CT-91…CT-96): the widget's drop mode (widget 1.1.0), the embed tree
(`pnpm build:embed`, not in `release:dist`), and the managed feedback integration with snippets and delivery. No new
runtime operation: the app reads the existing `feedback.*` answers, whose health and snippets a runtime with the drop
fills (FD-26, FD-37); a runtime without it keeps AP-102's notice. The self-hosted artifact (`release:dist`) changes
only by the widget's new mode, which a self-hosted snippet (no `data-key`) never enters.

## AP-109 Contracts 0.14.0 (CT-97…CT-105, the Vault)

Vendored like AP-02: `@whombat/core/vault` (entries, templates, keys and tiers, checks, uses, the home network rules,
the neutral audit text and the owner's copy helpers), `api.vault.*` and the account-level `api.vaultNetworks.*`,
`packs.bindSecret` and the 0.14 `PackSecretView` (`setByName`, `mine`, `entryId`, `entryName`), the `vault.updated`
realtime event on topic `me`, `VaultUseAction`, `Approval.vault` and `ApprovalView.declineCta`, the audit kind
`Vault` with `AuditEvent.vault` and `AuditCounts.vault`. `vault.create` and `vault.setSecret` are secret session ops
(`SECRET_API_OPS`, VT-58); the client marks them from the protocol list, nothing app-side. The recovery ceremony test
reads its vectors from the vendored `0.14.0` schema tarball (the 0.13.0 directory is gone).

## AP-110 The client's Vault (VT-01, VT-44, VT-52)

`@whombat/client/react` gains `useVault` (`vault.list`), `useVaultEntry` (`vault.get`: the entry and
`eligibleAgentIds`), `useVaultAgentKeys`, `useVaultUses`, `useVaultNetworks`, and two write hooks:

- `useVaultWrite(ep, burrow)` for `vault.create/update/setSecret/remove/check/setTool/giveKey/takeKey`. Vault writes
  answer the owner's view (`{entry, eventId}`, `check`: `{entry, result}`), not a commit outcome: the entry goes into
  its `vault.get` at once, then `invalidateVault(qc, entryId)` refetches the list, the profile pane's keys, and the
  entry's detail and uses (the agents a key may still go to come only from `vault.get`). `remove` drops the entry's
  queries and refetches the packs whose slots it may have filled.
- `useVaultNetworkWrite(ep)` stores the answered list (`vaultNetworks.add/remove` answer the whole list).

`vault.updated {entryId|null}` invalidates the same (`null`: every entry and the home network list); the frame carries
no entry data. Pack secret writes (`packs.setSecret`, `packs.bindSecret`, `packs.clearSecret`) also refetch the Vault
(`setSecret` saves the value as an entry, a binding changes USED BY PACKS). `AuditCounts.vault` counts `Vault`
events in the realtime audit reducer. Fixed on the way: Settings → Packs invalidated `packs.agentPacks` after a
session import, but the endpoint id is `packs.agent`.

## AP-111 Settings → Vault (VT-70, VT-71)

`?tab=vault` (“Vault”, after AI accounts), reachable by everyone: the account menu has **Vault** under “Connected
accounts” and “AI accounts”. `&entry=vlt_…` opens an entry (validated with the id prefix, only with the Vault tab);
opening and closing one replaces the URL. Not mocked (B-05): the page is Settings' (intro in ink2, `SectionLabel`
headings), the entries are the Connections card's language, the disclosure is the audit row's.

- **YOUR ENTRIES**: a card per entry, a whole-row button (`aria-expanded`): status dot (reached `ok`, failing `bad`,
  not checked `mut`, labelled for screen readers; a secret for a pack can't be checked, so its dot says Set / Not set),
  name, `vaultEntryMeta`, “Used 10:48” (`vaultLastUsedText`) in mono, a chevron. **Add to Vault** sits on the section's
  head, disabled with the limit's message when `canAdd` is false. Loading: skeleton rows; a failed load: the error
  with Retry; none: “Nothing in your Vault yet.” The host note (VT-05) shows under the intro when `showHostNote`.
- **An open entry**, blocks under a top line, each a mono label: **WHAT SHOULD AGENTS KNOW?** (the note, with Edit:
  name, the note and the address through `vault.update`; changing how an entry signs in isn't offered — add it
  again), **SECRET** (`vaultSecretLine`; Replace opens a write-only password input, a login's username beside it;
  none for an MCP server that signs in with nothing), **CONNECTION** (the URL in mono, how it signs in, `vaultCheckLine`
  in `bad` when failing, Check again; the query warning for `query`), **TOOLS** for `mcp` (a switch per tool labelled
  with its name, the tool's description, “New” as a brand tag, a note for a name agents can't call and for ignored
  tools), **AGENTS WITH A KEY** (head avatar, name, `SegmentedControl` Asks / Allowed, Take back without a confirm —
  giving it again is one click; “Give a key to…” lists the agents `vault.get` offers, checked again with core's
  `vaultKeyHolderProblem`, and gives the key at **Asks**, the safer tier; the note `keysNote`), **USED BY PACKS** for a
  secret for a pack (with `packBindingNote`), **RECENT USE** (`vaultUseRow`: agent · what in mono · for whom ·
  outcome in its tone, the time right-aligned in mono; the entry's last 20, no paging), and **Remove from Vault**
  with an inline confirmation that says keys and pack slots go with it.
- Refusals show where they belong: field problems under their field, `address_not_allowed` under Address, anything
  else as the server's message; toasts confirm writes (“Gave Banjo a key.”, “Took back Dusty’s key.”).

## AP-112 Add to Vault (VT-02, VT-03, VT-70)

A modal in the pack and memory modals' language (mono kicker VAULT, 23px title). Step one: the four templates
(`VAULT_TEMPLATE_DEFS`) as the new automation modal's choice tiles; step two: the chosen template on a quiet line with
Change, then the form: **Name**, **Address** (`mcp`, `http`), **What should agents know?**, **How it signs in** (MCP
server: bearer, header, query parameter or nothing; API token: bearer, header, query parameter; Login: username and
password), the header or parameter name, a login's **Username**, and the secret as a write-only password input
labelled Token / Password / Secret (hidden when an MCP server signs in with nothing). The address hint names the home
network list (“Public addresses need https. On your network: 192.168.1.0/24 · ports 80, 8123.”), a plain `http://`
address shows `httpWarning` instead, a query parameter shows `queryWarning`. The form is checked with the contract's
own `CreateVaultEntryBody` before anything is sent, with Zod's size words replaced by ours (“Give it a name.”).
**Save creates the entry, then runs `vault.check`** (`vault.create` doesn't check); the toast says the result (“Added
“Grafana” to your Vault. Reached · answered 200”) and the new entry opens. A failed check leaves “Not checked yet”
and Check again.

## AP-113 HOME NETWORK (VT-12, VT-70)

Everyone reads the list (`vaultNetworks.list`), under `homeNetworkIntro`: a row per network, the CIDR in mono,
“ports 80, 8123”, and the note, “added by Mara Okafor” and when. When `canManage`, an admin removes a network after
an inline confirmation and adds one with Network, Ports (commas or spaces) and Note; the network is checked with
core's `vaultNetworkProblem` first (private ranges only, at most a /16 or /48, none of the never-listable ranges, 1–16
ports), the server's refusal otherwise. Without `canManage` a hint says only an admin of this Whombat changes it.

## AP-114 The agent profile's VAULT (VT-72)

After PACKS, only when `vault.agentKeys` answers at least one key (so the mocked pane is unchanged) and under the
PACKS section's rule (not on someone else's personal agent). Each row is a link to the entry
(`?tab=vault&entry=`), its name and the tier in mono; “Manage in your Vault →” is a router link with the link
button's look (`createLink(ButtonLink)`), not a button inside a link.

## AP-115 A pack's secret from your Vault (VT-55, VT-72)

The pack modal's SECRETS rows: the slot's state (“From your Vault · Weather API key” for the viewer's own binding,
“Set by Mara” for someone else's, “Set”, “Not set”), Clear (unbinds, whoever may configure the attachment) and, on a
set slot, Change, which opens the chooser (an empty slot shows it at once). Someone who may configure it chooses one
of their `secret` entries (a select “Choose from your Vault” and Use,
`packs.bindSecret`) or pastes a value (“Paste a value instead”, `packs.setSecret`, which the toast says is saved to
their Vault as “{pack} · {NAME}”); without any secret entry the paste field shows at once. The hint says secrets come
from the Vault, and `packBindingNote` (“Every agent this pack is on uses it, whoever asks them.”) ends the block.

## AP-116 A `vault_use` approval on Android (VT-31, VT-32, VT-72)

All copy is core's `approvalView`. The approval screen's footer says `declineCta` (“Don’t allow”) and “Allow for one
turn” with the wide approve layout; once decided a Vault use has **no footer** (no Undo exists, VT-32) instead of a
dead Undo; WHAT HAPPENS shows for a Vault use (“Pippa may use “Home Assistant” until this turn ends”, “Joris asked for
it in #general”), because who asked decides the answer (VT-22). The inbox row's inline button says **“Allow”**:
“Allow for one turn” doesn't fit the half-row button next to Details, and the row text and the screen say the rest.
The chat card needs nothing new (title and message from the view).

## AP-117 The audit log's Vault (VT-50, VT-52)

An owner's row reads the detail line instead of the neutral text (core `vaultAuditDetailText`: “Used “Home Assistant”
· HassTurnOn · done”, “Took back Dusty’s key to “Grafana””); the expanded detail keeps core's fields (SIGNED BY, the
VAULT field with the same line, EVENT), so the signed text is still what the signature covers. **Deviation from VT-50:
the Vault chip (after Keys) shows once the log holds a Vault event in the current actor/person filter, or while it is
chosen** — a burrow that never used the Vault keeps exactly the mocked chips, which the audit visual spec compares
pixel for pixel. The URL's `kind=vault` works either way.

## AP-118 A `vault_use` approval on the web (VT-72)

The card and the modal render core's view: the card's primary is “Allow for one turn”, its target “Vault · Home
Assistant” for the owner (“Vault” for anyone else); the modal's decline button says `view.declineCta` (“Don’t
allow”; “Decline” for every other action); no Undo after a Vault use. The Work view's item buttons stay the generic
Approve / Decline: a `WorkItem` carries no action type.

## AP-119 The Vault on Android (VT-73)

The Settings sheet has a VAULT section with a “Vault” button for everyone (after BURROW). **Vault** (the Packs
screen's language: mono kicker, 25/700 title, the intro, the host note): YOUR ENTRIES rows (name, “Used …”, a status
dot with its label, the meta in mono; they open the entry), `secretsOnWeb`, and HOME NETWORK read-only. **An entry**:
CONNECTION (address, dot, check line, Check again, the result announced to TalkBack), SECRET (the line and
`secretsOnWeb`), TOOLS of an MCP server (the app's 44dp `Switch`, a “New” pill), AGENTS WITH A KEY (44dp avatar, name,
Asks / Allowed chips, Take back after a confirm: “Pippa can’t use “Home Assistant” from now on, not even in a turn
you already allowed.”), “Give a key to…” (the eligible agents, each “starts at Asks”, one tap gives the key), USED BY
PACKS for a pack's secret when used, RECENT USE. Creating, editing and removing entries and setting secrets happen on
the web (the packs rule, BP-D19). A 404 reads “This entry isn’t in your Vault.” (it never says whether someone else's
exists). The agent screen's VAULT (after PACKS, only with a key) opens the entry with “‹ {agent}”. Pack secrets on an
agent's Packs screen say who set them (“LINT_TOKEN set by Mara”).

## AP-120 Tests, and what the runtime must provide

Unit: the client's `vault.updated` and Vault audit counts; the web's Vault tab against the fixture world (entries,
tools, keys, Add to Vault then check, a refused address, Replace, Remove, HOME NETWORK, the profile's VAULT, the
owner's audit line and the chip), the form model, pack binding, a `vault_use` card and modal; Android's models, the
approval footer and inbox button, and the touch-target and TalkBack audits for the new screens. `e2e-managed/vault.spec.ts`
walks the Vault over the session on the fake world (review shots in `tmp/visual/vault/`); visual baselines: the tab,
an open entry (top and keys) and Add to Vault's form, light and dark.

The fixtures (`createFixtureFetch`, contracts 0.14.0) don't cover, and the runtime must provide: `vault.updated`
frames (the app refreshes after its own writes; other devices need the frame); `showHostNote` for a self-hosted
install's admins; `canManage: false` and `admins_only` for everyone else on `vaultNetworks.*`; `eligibleAgentIds`
without the feedback assessor; the 0.14 `PackSecretView` fields and `VaultPackUse` rows (the fixture world has no
packs); `AuditEvent.vault` on `audit.appended` frames for the owner; `Approval.vault` for the owner on reads and
frames, and the `vault_use` card in the owner's DM with their personal agent; `address_not_allowed` with the
suggestion from real DNS; `vault.create` / `vault.setSecret` accepted as secret session ops and `vaultNetworks.*` as
account-level ops on a managed Whombat.

## AP-121 whombat-app 0.7.0

AP-109…AP-120 as 0.7.0, on contracts 0.14.0 (CT-97…CT-105): the Vault on the web (Settings → Vault, Add to Vault, the
home network list, the profile's VAULT, pack secrets from the Vault, the audit log's owner line and chip, the
`vault_use` approval) and on Android (the Vault screens, the agent screen's VAULT, the approval). No new app-side
session operation: every Vault call is a contract op (secret ops from the protocol's list). The Android app's own
version stays 0.1.0, as in every release so far (only the root `package.json` carries the release). The
self-hosted artifact (`release:dist`) gains the Vault UI, which a server before 0.14 answers with 404s (the tab shows
its load error).

## AP-122 Contracts 0.15.0 and the control client's signups and billing (CT-106…CT-110)

Vendored in `ffb05e1` like AP-02. `ControlApi` gains, typed from the contracts: `signupInfo()` (`signup.info`,
public; **null on 404**, so an older control hides Billing, CT-110), `joinWaitlist({email, company?, note?})` (empty
optional fields are left out, the email trimmed), `createOrg({name, terms, code?})` (was `createOrg(name)`; the code
goes as `formatSignupCode`'s `XXXX-XXXX`, and as typed only when it isn't one, so control answers
`signup_code_invalid`), `billing`, `billingCheckout`, `billingPortal`, `billingWhombats` and `billingStartNow`. The
HTTP client checks the billing answers with the contract's `BillingView` and `BillingRedirect` (an http(s) URL only;
anything else is `unavailable` and the browser goes nowhere). `SUBSCRIPTION_TERMS_VERSION`, `SignupInfo`,
`BillingView` and `SignupPlan` are re-exported from `@whombat/client/managed`. The pure parts (plan cards, the state
line, which Billing page, where a new org goes, the checkout poll, refusal words, invite codes) are
`packages/client/src/managed/billing.ts`.

## AP-123 Billing and signup refusals

`ControlError` gains `details` (`canStartNow`, `allowed`, CT-108; anything else in `details` is dropped, and a
malformed member is left out). `ControlErrorCode` names the new reasons: `billing_setup_required`,
`trial_used_device`, `signup_code_required`, `signup_code_invalid`, `terms_outdated`, `waitlist_closed`,
`subscription_exists`, `manual_billing`, `no_subscription`, `not_trialing`, `plan_unavailable`,
`whombats_below_claimed`, `billing_provider_error`; any other reason keeps falling back to the status (`forbidden`,
`not_found`, …) as before. `devicesAllowedOf` reads `details.allowed` first and the message only from an older
control. `claimErrorText` has words for `billing_setup_required` and `trial_used_device` that say Billing is on the
web: the phone shows them as they are (AP-130); the web acts instead (AP-132).

## AP-124 The create-org screen (BL-21)

Reads `signup.info` (waits for it; null = the plain form). Kept: kicker WELCOME, “Name your organization” and its
sub. The field is **“Company name”** (`autocomplete=organization`). Then the invite code when the mode needs one, then
the unticked **“I agree to the Whombat Subscription Terms”** (the claim's checkbox, its link opening
`/legal/subscription-terms` in a new tab), then Continue, disabled until the terms are ticked, the name is filled in
and, where required, a code is typed. Continue says “Setting up…” while it waits.

- `open`: no code field, unless a `/signup#code=` link brought one (open mode still accepts a code; it may carry a
  plan, BL-22).
- `invite`: the sub becomes “Whombat is invite-only for now. Enter your invite code.”, the code is required.
- `waitlist` without a code: the screen is the waitlist (AP-127) with **“I have an invite code”**, which shows the
  code form; from there **“No invite code? Join the waitlist”** goes back (not offered when a link brought the code).
- **Invite code** field: mono, `XXXX-XXXX` placeholder, upper-cased as typed, hint “The 8 characters from your invite,
  like 7KQ2-M4XD.”. Something that isn't a code at all (`normaliseSignupCode` null) is refused here with the same
  words as control's `signup_code_invalid` (“That invite code doesn’t work. Check it, or ask for a new one.”), so
  nobody learns more from typing than from control.
- The terms version sent is this app's `SUBSCRIPTION_TERMS_VERSION`, the text the page shows, not `signup.info`'s:
  an app older than control then gets `terms_outdated` (“The Whombat Subscription Terms have changed. Reload this page,
  then try again.”) instead of accepting terms it never showed.

## AP-125 `/signup` and the held invite code (BL-22)

`/signup#code=…` is read once from the fragment (`readSignupFragment`: `/signup` only, at most 64 characters, kept
as typed), held in local storage under `whombat:signup-code` for 7 days like the other held links, and taken out of
the address bar at once. Signed out, `/signup` is the sign-in page (the magic link's `next` brings the person back to
`/signup`) with “Your invite code 7KQ2-M4XD is kept for after you sign in.”. Signed in without an org it is the
create-org screen with the code filled in; every other path without an org shows the same screen. The code is
dropped when the org is created, and when someone already in an org opens `/signup` (which goes to the list).

## AP-126 Where a new organization goes (BL-13)

After `orgs.create`, with `signup.info.billing === 'stripe'`, the app reads `billing.view` for the new org; if it
waits for a plan and the caller may manage billing, it goes to **`/billing`** — also when the Whombat's screen sent
the person to `/claim` (the claim would only be refused). Otherwise it goes on as before (`/claim` or the list). A code
with a plan (active at once) and the manual trial go straight on. After Checkout, the Billing page offers **Claim a
Whombat** (AP-129), which is the claim.

## AP-127 The waitlist (BL-23)

The waitlist form is the create-org screen in `waitlist` mode and `/waitlist`, which is public (signed in or not;
it waits for `signup.info`). Kicker WAITLIST, “Join the waitlist”, sub “Whombat is opening up step by step. Leave
your details and we’ll email you an invite code when there’s room.” Fields: **Work email** (signed in: the account's,
read-only), **Company** and **Anything we should know?** (a textarea, ≤ 500 characters), both marked Optional. Done:
“You’re on the waitlist” / “We’ll email {email} when there’s room. Your invite code comes with that email.” — the same
for a repeat (control never says). On `/waitlist` outside waitlist mode: “Whombat is open” / “Whombat is invite-only
for now” with **Get started** (to `/signup`); `waitlist_closed` from control says “The waitlist is closed right now.”

## AP-128 `/legal/subscription-terms`

`apps/web/src/legal/subscription-terms.md`, rendered by the legal page (public, like the appliance terms), with the
DRAFT banner (D-06) and version `2026-09-27-draft`. Six short sections, exactly BL-24's points: for businesses only;
the free trial (14 days, or the length shown when it starts, since the trial length is a live setting; a card when it
starts, not charged until it ends, continues unless cancelled); price per Whombat per month excluding VAT (reverse
charge per BL-06, prorated additions per BL-18), continuing monthly; cancelling at the end of the period; a lapse (LC-10:
agents and automations pause, everyone can still sign in, read and export everything, the recovery kit and security
updates keep working, nothing is deleted); your data stays on your Whombat and Whombat's cloud can't read it. The
Appliance Terms are named, not linked (the legal renderer only links absolute URLs). A unit test checks the file names
`SUBSCRIPTION_TERMS_VERSION`, so the version the app sends always names this text.

## AP-129 The Billing page (BL-15…BL-18)

`/billing`, from the list's **Billing** entry. The sign-in frame (`AuthLayout`, kicker BILLING) with the managed
screens' bordered-row cards; tip “You pay per Whombat. Whatever happens to the subscription, your data stays on your
Whombat.” Every page ends with “Back to your Whombats”. Which page (`billingPageOf`):

- **Not an owner or billing member** (`canManage` false): “Billing”, sub “Ask an owner to manage billing.”, and the
  plan card when there is a plan. No buttons.
- **Waiting for a plan, or a Stripe subscription that ended**: “Choose your plan” (ended: “Your subscription ended” /
  “Choose a plan to start again. Everything on your Whombats is still there.”), sub “Pay per Whombat, monthly. Try it
  free for {trialDays} days.” (without a trial: “Pay per Whombat, monthly.”). The plans from `signup.info.plans` as
  onboarding's choice cards (1.5px border, selected = ink border, a native radio in the button colour, in a fieldset
  with a hidden legend “Plans”): the name (17/700), then BL's “€49 per Whombat a month · Up to 5 people” split over two
  lines (the price 15/600 in ink, “Up to 5 people” in ink2; at 1440 the joined line wrapped mid-phrase), then
  “Unlimited agents and connectors” (a plan with limits lists them). The first plan is chosen. **Whombats** (a fieldset
  with a mono legend): − and + (square secondary buttons, 40px, 44px on narrow screens; “One Whombat fewer/more”,
  1…50, starting at the claimed count or 1) around the number in mono, then **“Total €98 a month”** (added: people see what the stepper does before Stripe tells them). The button: “Start 14-day free trial”
  (`trialAvailable`) or “Subscribe”, “Opening checkout…” while it waits; the fine print “Prices exclude VAT. You won’t
  be charged until your trial ends. Cancel anytime.” (without a trial: “Prices exclude VAT. Cancel anytime.” — the
  middle sentence would be untrue). Checkout's URL is followed with `location.assign`.
- **A plan Whombat manages**: sub “Your plan is managed by Whombat.”, the plan card, no buttons.
- **Subscribed** (Stripe: trial, active, payment problem): a card with the plan (the name; under it the state line
  after a status dot, `ok`/`warn`/`bad`, labelled with the state) and **Whombats** “{claimed} of {paid}” with **Add a Whombat**,
  which confirms inline in the card (“Pay for 3 Whombats from now on? The difference is prorated.” Add it / Cancel)
  before `billing.whombats`, since it charges. Then **Claim a Whombat** (primary) while paid > claimed, and **Manage
  billing** (the portal; primary when there's no room to claim).
- State line (`billingStateLine`, dates as “11 October 2026” like the licence): “Trial · ends {date}”, “Active ·
  renews {date}”, **“Active · ends {date}”** once cancelled at the period end (added: “renews” would be wrong),
  “Payment problem” (`past_due`, `grace`), “Ended”; “Active” / “Trial” without a period.
- Refusals in words (`billingErrorText`), e.g. `subscription_exists` “You already have a subscription. Change it with
  Manage billing.”, `billing_provider_error` “Our payment provider didn’t answer. Try again in a moment.”. A failed
  load: “Couldn’t load billing. Check your connection and try again.” with Try again.

## AP-130 Android: organizations are set up on the web

The phone no longer creates orgs: a new account sees “Set up your organization on the web” / “Open
app.whombat.com/signup in a browser to name your organization, accept the terms and choose a plan. Then come back
here.” with **Open in the browser** (`{UI origin}/signup`) and **I’ve done that** (asks control again). The terms,
codes, waitlist and plans live on the web (BL-25 “Billing lives on the web”), and an org created on the phone with
Stripe billing couldn't claim anything until someone went to the web anyway. Claim refusals need nothing else: the
new reasons are named (AP-123) and `claimErrorText` says where Billing is (“Your organization needs a plan first. An
owner chooses one under Billing, on the web.”, “This Whombat already had a free trial. Start your subscription under
Billing, on the web, to add it.”); `devices_allowed_reached` reads `details.allowed`. Ticket refusals are unchanged
(`forbidden` still signs the session out; control doesn't refuse tickets for billing).

## AP-131 Back from Checkout (BL-16)

`/billing?checkout=done` shows “Setting up your subscription…” (a status line) and asks `billing.view` every 2 s,
for at most 60 s (`pollCheckout`: at 0, 2, … 60 s; a failed ask counts as not yet), until the subscription shows (not
waiting for a plan and not ended). Then the address becomes `/billing` (a reload doesn't wait again) and the
subscribed page shows. After a minute: “This is taking longer than usual. Your subscription shows here as soon as it’s
ready.” with **Check again**, which polls another minute. Leaving the page stops it.

## AP-132 Claim refusals with a way out (BL-13, BL-17, BL-18)

In `ClaimFlow` (every claim screen), a refusal with an action replaces the error line with a notice (`role=alert`,
the text, a note, the action, the action's own error):

- `billing_setup_required`: straight to `/billing` (whoever can't choose a plan reads “Ask an owner to manage
  billing.” there).
- `trial_used_device`: “This Whombat already had a free trial. Start your subscription today to add it.” with **Start
  subscription now** (`billing.startNow`, then the same claim again); without `canStartNow`, **Go to Billing**. Whether
  the person may act comes from `billing.view`, read when the refusal comes: not a manager → “Ask an owner to manage
  billing.”; a managed plan → “Your plan is managed by Whombat.”, no button.
- `devices_allowed_reached` (the coarse `entitlement_withheld`): “Your plan covers {n} Whombats.” with **Add a
  Whombat** and the note “You’ll pay for {n+1} Whombats from now on. The difference is prorated.” (`billing.whombats`
  with paid + 1, then the claim again). Non-managers: “Ask an owner to add a Whombat to your plan.”; a managed plan:
  “Your plan is managed by Whombat.”; no view (an older control): the words only.

The retry reruns the whole claim with what was typed; the letters are still valid, since control refused before the
ceremony.

## AP-133 The Whombats list: Billing, and a plan first

The list's actions gain **Billing** (a link button after Claim, for every member, only when `signup.info` answered).
With Stripe billing, the list reads `billing.view` on each visit; while the org waits for a plan and the person is an
owner or billing member, it says “Choose a plan to claim your first Whombat.” and the primary button is **Choose a
plan** instead of Claim a Whombat, and it doesn't look for a Whombat nearby (AP-75) until that's known and done —
it would only end in `billing_setup_required`.

## AP-134 The fake world's signups and billing

The fake control (`apps/web/src/managed/fake/world.ts`) implements the new endpoints like control: `signup.info`
(`open` and `manual` by default, like control without Stripe keys, so every existing journey is unchanged; the
plans Small €49 / 5 people and Team €149 / 25 people), `orgs.create` with the terms (`terms_outdated`), codes (two
valid ones, `7KQ2-M4XD` and `TEAM-2026` with a manual Team plan; single use; `signup_code_required`,
`signup_code_invalid`) and BL-13's starting entitlement, the waitlist (`waitlist_closed`, no enumeration), and the
billing endpoints with their refusals. **Checkout “completes” at once**: it answers `/billing?checkout=done`, and its
“webhook” applies 3 s later (`checkoutLag`), trialing when a trial is available. The portal answers `/billing`. With
Stripe billing, claims are refused as control would (`billing_setup_required`, `trial_used_device` with
`canStartNow`, `devices_allowed_reached` with `allowed`). Faults: `signup`, `billing`, `checkoutLag`, `role`,
`trialUsed`, `waitlist`, `created`.

## AP-135 Tests

Fixed on the way: `recovery-ceremony.test.ts` still read the vectors from the 0.14.0 schema tarball, which the 0.15.0
vendoring removed; it reads 0.15.0's.

Unit (`packages/client/src/managed/billing.test.ts`): prices and plan cards, the stepper range, which page, the state
lines, the poll step and `pollCheckout` (fake clock: every 2 s, gives up after 60 s, stops when left), where a new org
goes, the signup forms per mode, the `/signup` fragment, refusal words and claim refusals, and the HTTP client's new
calls (paths, bodies, code normalisation, 404 → no signups, refusal details, a non-http redirect refused). Web: the
terms file names the contract's version; component tests (`apps/web/src/managed/billing.test.tsx`) for the Billing
page's pages, the create-org screen per mode and the refusal notice. E2E (`e2e-managed/billing.spec.ts`, against the fake world): signup → plan →
Checkout → the poll → claim; the list waiting for a plan and a claim sent to Billing; Start subscription now; Add a
Whombat from a claim; the subscribed page (Add a Whombat, Manage billing); a managed plan and a non-owner; invite-only
with a held `/signup#code=`, required and bad codes, a code with a plan; the waitlist (create-org and `/waitlist`
signed out, closed); the terms page. The helper `nameOrganization` fills “Company name” and ticks the terms for the
existing journeys. Review shots: `BILLING_SHOTS=<dir> pnpm e2e:managed billing-shots` (desktop and phone, light and
dark).

## AP-140…AP-159 The operator panel

Moved to control with the operator panel (`docs/decisions/admin.md`, same ids; Whombat `docs/decisions/public-copy.md` PUB-13).

## AP-160 Checkout and the portal send the browser only to Stripe

Before the Billing page follows the URL `billing.checkout` or `billing.portal` answered, `billingRedirectUrl`
(`@whombat/client/managed`) checks it: an absolute `https:` URL whose host is `checkout.stripe.com` or
`billing.stripe.com` (default port, no user or password in it). Anything else (another host, `http:`, a relative or
`javascript:` URL) is treated like a failed request: the page shows “That didn’t work. Try again.” and stays. The
fake world's Checkout comes back to `/billing?checkout=done` on the page's own origin, so `ManagedEnvironment` has
`billingRedirectOrigins`, the extra origins allowed: `loadEnvironment` sets `[window.location.origin]` only when it
builds the fake world (`VITE_WHOMBAT_FAKE=1`, a build-time switch a production build doesn't have);
`realEnvironment` sets none. The hosts live in the client, not in control's answer, so a compromised or confused
control can't send an owner to a look-alike payment page.

## AP-161 The held invite code: localStorage for an hour, gone on sign-out

The `/signup#code=` code must survive the sign-in round trip, and the magic link opens from the mail client in a new
tab, whose `sessionStorage` is empty (the e2e opens the link in a second page to show it). So it stays in
`localStorage`, but for at most an hour instead of the seven days the other held links get; an older (or unreadable,
or future-dated) one is removed when read. Sign-out and account deletion remove it, as account deletion already did
for the other held links; creating the organization and arriving at `/signup` with one already remove it (AP-125).

## AP-162 whombat-app 0.8.0

AP-122…AP-161 as 0.8.0, on contracts 0.15.0 (CT-106…CT-110): signups and billing in the hosted UI (create-org with
“Company name”, the Subscription Terms and invite codes; the waitlist; `/signup`; the Billing page with Stripe
Checkout and the customer portal; claim refusals for plans and trials; Android sets the organization up on the web)
and the operator panel `apps/admin`, shipped in the release artifact as `admin/` and served by control's panel
listener (Whombat control BL-27…BL-30). Hosted UI and control move together: from control 0.15 `orgs.create` needs the
terms, and an older control answers the new billing and signup routes with 404 (the UI then hides Billing). The
Android app's own version stays 0.1.0.

## AP-163 Deleting an organization or an account from the panel: typed confirmation

Moved to control with the operator panel (`docs/decisions/admin.md`, same ids; Whombat `docs/decisions/public-copy.md` PUB-13).

## AP-164 whombat-app 0.8.1

AP-163 as 0.8.1, on contracts 0.15.1 (CT-111): the operator panel deletes organizations and accounts. It needs a
control that has the two endpoints; an older control answers them with 404, and the dialog shows control's message.

## AP-165 The Whombat Privacy Policy at `/legal/privacy`

**Superseded in part by hermes-engine.md HE-68**: no draft marker; the version is a plain date (`2026-11-15`).

John, 2026-09-27: “Write a privacy policy for Whombat (for the website)”. There is no separate marketing site yet
(`whombat.com` doesn't resolve), so the policy is the hosted app's third public legal page, `/legal/privacy`, rendered
from `apps/web/src/legal/privacy-policy.md` like the two sets of terms (LC-17, BL-24), marked draft with version
`2026-09-27-draft`. Both terms already refer to “the Privacy Policy”.

- **Source of the facts:** `docs/privacy-and-security.md` (what control, relay and the clients store and for how
  long), control `billing.md` (Stripe, trial marks, waitlist, terms acceptance) and `hosting.md` (Hetzner, and
  Cloudflare terminating TLS, which HZ-02 says the notice must name). When one of those changes what the cloud
  keeps, change the policy and its version with it.
- **Controller:** Cybex B.V. (the Stripe account's company) for what the cloud processes; the organization for
  what's on its Whombat, which we can't reach; the site's organization for Feedback reports, which control only
  carries sealed.
- **Backups:** stated as up to 35 days, matching the delete-account screen, although production's dumps are kept 14
  days (HZ-09): the longer figure is never wrong.
- **No acceptance is recorded.** A privacy notice informs, it isn't agreed to, so it has no contract version constant.
- **Open (legal review):** the registered address and KvK number, the `privacy@whombat.com` mailbox, Mailgun's
  region and data processing agreements with each provider, and whether the sign-in and signup screens should link
  to the page.

## AP-166 The Whombat Terms of Service at `/legal/terms`

**Superseded in part by hermes-engine.md HE-68**: no draft marker; the version is a plain date (`2026-11-15`), and the
terms limit only the use of the service, never the open-source software.

John, 2026-09-27: “generate Appliance Terms and a separate normal Terms”. The Terms of Service are the general
agreement (who may use Whombat, accounts, content, acceptable use, agents and AI providers, suspension, warranty,
liability, changes, Dutch law); the Subscription Terms keep payment and the Appliance Terms the software on the box.
A fourth public legal page, rendered like the others and marked draft, version `2026-09-27-draft`.

- **Nobody ticks it yet.** The Appliance Terms (`2026-09-27-draft`) incorporate it. The Subscription Terms don't
  mention it, and the create-organization checkbox links only to them; making the Terms of Service part of what an
  org accepts means a new `SUBSCRIPTION_TERMS_VERSION` (a contracts release) and a second link in the checkbox label.
  Left for the legal review, with the liability cap, the court, and `legal@whombat.com`.

## AP-167 whombat-app 0.8.2

Contracts 0.15.2 (CT-112): the Appliance Terms `2026-09-27-draft` (appliance LC-20), copied word for word to
`apps/web/src/legal/appliance-terms.md` (the harness gate compares them), plus the Privacy Policy (AP-165) and the
Terms of Service (AP-166). Claims send the new version, which only a control with contracts 0.15.2 accepts (control
CL-81), so the hosted web app and control ship together.

## AP-168 Handoff rows on the plan card

Delegation DG-17 (runtime `docs/decisions/delegation.md`), contracts 0.16.0 (CT-113…CT-115). No mock draws a handoff,
so the card follows its own rows (B-05). A step with `handoff` keeps the row's grid, marker, avatar and state; the
owner reads “Banjo, from Sketch” (the owner's name, then the delegator's short name), and the step's title is a real
button (`aria-expanded`, a 14px chevron that turns, as in the activity feed) that opens the handoff under the row in the
blocked-step detail's column and type: the brief, “Done looks like: …”, what came back (“Reported back: …”, “Blocked:
…” or “Declined: …” with the decline reason; the lead in ink, or bad for blocked and declined), then the facts line in
the state's mono (budget, time limit, due) and “Open lane” (the thread pane on `laneRootId`, DG-02). Folded, a
declined or blocked handoff still says why like any blocked step; opened, the outcome replaces that note (the server
derives both from the same report), so it's never said twice. Plain steps render exactly as before: the mock's plan
and plan-deployed comparisons still pass.

## AP-169 Handoff steps in the plan pane

A handoff step in the pane shows the same owner line, brief, “Done looks like”, outcome and facts line, and the note
only while nothing came back (“Waiting for Banjo’s report.”, a stop's note). Its actions are core `planStepActions`
for this viewer: “Report back” only for the person who owns it, “Ask for a report” only for someone else
(`handoffViewerActions`). As for plain steps, the first two that aren't Reassign or Cancel are buttons (Open lane is a
link button, like Open work; Report back and Retry are primary) and the rest go in the step's menu. Open lane replaces
the plan pane with the thread pane on the lane root. Ask for a report calls `plans.askReport` (“Asked Banjo for a
report in the lane.”); Retry is `plans.startStep` (“Asked Hazel to try “…” again.”); Cancel is `plans.updateStep
{state: 'cancelled'}` as for any step.

## AP-170 Refusals in the server's words, next to the form

A refused handoff answers 409 with `details {code, reason}` (DG-13); the pane shows `reason` verbatim, since the
server already says it in the product's words (core `handoffRefusalText`). Reassign on a handoff step (the server
hands it over again and re-runs the readiness check) and “Add step” with a brief put the refusal under their form
(`role="alert"`, bad, 13.5px) instead of a toast, and clear it when the owner changes; a report whose data didn't
match (400 `details {problems}`) says “The report doesn’t match what was asked for: …”. Everywhere else (a toast,
the Work view), `planErrorText` gives the same reason first.

## AP-171 Reporting back from the pane

The person who owns an unfinished handoff (`report_back` offered, DG-24, DG-25) gets “Report back”, which opens a small
form in the step: a segmented Done / Blocked / Declined (the audit log's control, native radios), a summary (up to
2 000 characters, placeholder per outcome: “What came of it, in a line or two”, “What’s in the way, and what would
unblock it”, “Why you can’t take it, and who could”), “Send report” (off until there's a summary) and Cancel; Esc
closes it. It calls `plans.reportBack` without data (people don't send typed data from the pane) and says “Reported
back on “…”.” or, declined, “Handed “…” back to Sketch.”. `progress` isn't offered: a person updates the note
instead.

## AP-172 Handing a step over from “Add step”

The pane's “Add step” gains a brief (a textarea under the title, “Brief (optional): hand it over now”). Without a brief
it is the plain add-step (queued, `plans.addStep`); with one, “Done looks like (optional)” and a due time (a
`datetime-local` in the browser's zone, sent as ISO) appear, the button reads “Hand over”, a hint says “Banjo is asked
now and reports back in a lane of its own.”, and it calls `plans.delegate` with `planId` (the step is added active and
its lane posted in one commit). No budget or output schema field: the server's defaults apply (DG-11), and typed data
is for agents. The owner picker is the same list as before (members of the conversation), so refusals such as
“You can’t hand work to yourself.” come from the server.

## AP-173 Handoffs in the Work view

A Work item with `handoff` (DG-16) keeps the row; its meta line ends “· Banjo, from Sketch” instead of the agent's
name, and a line in the meta's mono under it gives budget and due. `ask_for_report` is a button (“Ask for a report”,
offered only with a plan step) that calls `plans.askReport`; Retry and Reassign stay the existing step actions (Reassign
opens the plan pane on the step, where the refusal shows inline).

## AP-174 Budget and due words

Budget: “86k of 2M tokens” (core `formatTokens`, the used part without the unit), or “2M tokens · usage not reported”
when the owner's provider reports none, since 0 would read as unused. A handoff without `budget.tokens` shows the
default (`HANDOFF_TOKENS_DEFAULT`, 2M; the server writes it in, DG-11, but older steps may lack it). A time limit reads
“2 h limit”, “45 min limit”, “1 h 30 min limit”, “2 days limit”. Due: “Due Wed 23 Sep, 16:00” (core
`formatHandoffDue`) in the viewer's zone, else the burrow's. Parts join with “ · ”.

## AP-175 The delegation fixture world

`createWorkFixtures({ handoffs: true })` (`@whombat/client/work-fixtures`, shared with Android) adds the fixtures'
“October release notes” plan (`handoffPlan`: Pippa done with a report, Hazel declined) plus two open handoffs from
Sketch: Banjo drafting the notes (“Working”, 340k of 2M, due 16:00) and Mara signing them off (a person's handoff, so
the viewer sees Report back). Its lanes are threads the fake serves (`messages.thread`, only for lane roots), and
`plans.delegate`, `reportBack`, `askReport`, Retry and Reassign of a handoff step follow core's rules
(`decideHandoff`, `handoffAcceptsReport`, `handoffResultStep`, the lane texts), the caller always Mara. It's opt-in so
the mock's screens stay as drawn: web tests pass `fixtureServices({ handoffs: true })`, and `VITE_FIXTURE_HANDOFFS=1`
turns it on in fixture mode. The card gallery has a `plan-handoff` state. `usePlanWrite` takes `plans.delegate`,
`plans.reportBack` and `plans.askReport`, so their answers update every place the plan shows, as other plan writes do.

## AP-176 Handoff actions on contracts 0.18 (CT-117)

Core's handoff actions now include `mark_done` and put Reassign first for a declined step (the work is back with the
delegator, so someone else should take it). For the viewer (`handoffViewerActions`): Report back only for the owner;
Mark done and Ask for a report only for someone else (the server records a person's Mark done on a handoff as a done
report, “Marked done.” in the lane, DG-24). The pane's buttons for a handoff are the first two actions but Cancel in
core's order (`handoffPrimaryActions`), so a declined step shows Open lane and Reassign (primary) and Retry moves to the
step's menu; plain steps keep Reassign in the menu as before. The Work view orders a declined handoff's buttons
Reassign, Retry. A person's own unfinished handoff in the Work view gets a primary “Report back” link to the plan pane
on that step. The reassign picker takes the rest of its row, so “Hand over” and Cancel stay beside it; the card's
toggle sets `aria-controls` only while its region exists. AP-169 and AP-173 stand otherwise.

## AP-177 Budget line: no tokens for people, `reported` trusted

A person spends no tokens, so a person's handoff has no budget part: the facts line is the time limit and due only,
and nothing when neither is set (card, pane and Work view). For an agent the server's `used.reported` is trusted as it
is: it now means a finished turn reported no usage, so “2M tokens · usage not reported” shows only then, and a
handoff nobody has worked on yet reads “0 of 2M tokens”. This replaces the “usage not reported” rule of AP-174.

## AP-178 Work item details and “Add step” owner on contracts 0.18

The server sends a handoff item's step note, else its brief, as `detail`; the row shows it unless it repeats a line it
already has (health, the owner line, the facts line; `detailAdds`). “Add step” with a brief defaults the owner to the
first candidate who isn't the viewer (people first, then agents, as the picker lists them) until the viewer picks one,
since handing work to yourself is refused; without a brief it stays the viewer. Copy: placeholder “Brief: what to do
and what done looks like (hands it over now)”, hint “{Name} is asked now and reports back in this step’s lane.”. A
report the server answers with 400 `problems` shows them under the form (AP-170); people send no data, so it
shouldn't happen. The fixture world follows: a person owner's lane ends “When it’s done, use Report back on the
plan.”, and Mark done on someone else's handoff is a report.

## AP-180 Handoff steps on the Android plan screen (delegation DG-18)

A plan step with a `handoff` (contracts 0.16.0, DG-01) keeps the plan screen's row (marker, title, state label, note,
links, buttons) and changes or adds:

- **Owner line:** “Banjo, from Sketch” (the step's owner, then `handoff.delegatedById`) in place of the owner's name;
  the avatar stays the owner's.
- **Under it:** the brief (14/ink2), `DONE LOOKS LIKE` and the deliverable when there is one, then one mono line
  `Due Wed 23 Sep, 16:00 · 86k of 400k tokens` (`formatHandoffDue`, and `formatTokens` for both numbers with the
  first one's “tokens” dropped). Budget used says `usage not reported` when `used.reported` is false. A handoff without
  `budget.tokens` shows the default (`HANDOFF_TOKENS_DEFAULT`, 2M): the server writes the default in when it makes
  one (DG-11), so only an older record can lack it, and the default is what applied to it.
- **The result:** a `sf2` box, mono label in the tone (`REPORT` ok, `BLOCKED` / `DECLINED` bad) and the summary, or
  the decline reason for a declined one; “The report didn’t match the requested shape.” under it when the data was
  dropped. The step's note is hidden when it only repeats the result (it equals `handoffResultStep(…).note`, which is
  what a report leaves); a note that says anything else stays.
- **TalkBack:** the row's one stop reads title, owner line, state, note, brief, “Done looks like”, due, budget and the
  result, each as its own sentence. Nothing else in the plan screen changed; `budget.minutes`, the output schema and
  the report's data are not shown on mobile.

## AP-181 Handoff actions on Android: “Open lane”, “Ask for a report”, no report form

The buttons are still `planStepActions` (core), as 44 dp `Button`s, with three rules for handoffs:

- **`report_back` is left out.** A report needs a form (status, summary, data) and DG-18 says no new editors on mobile;
  a person who owns a handoff reports from the web's plan pane. `MobilePlanAction` is `PlanStepAction` without it.
- **“Open lane” is always secondary** (it only navigates) and opens the lane's thread (AP-182). The primary button is
  the first action after it, unless that is Reassign (as before), so a working handoff leads with “Ask for a report”
  and a declined one with Retry; a finished one has only “Open lane”.
- **“Ask for a report”** calls `plans.askReport` (the nudge in the lane, DG-17) and says “Asked for a report” with
  “Banjo was asked in the lane where this stands.” when it went through, because the nudge lands in a thread the
  screen doesn't show. Both new buttons carry an accessibility hint (“Opens the handoff’s thread”, “Asks the owner in
  the lane where this stands”). Retry, Reassign and Cancel work as they did (DG-24's rules are the server's).

## AP-182 A thread screen on Android

Mobile had no thread view: conversations showed top-level messages only, and `?thread=` links opened the conversation.
A lane is a thread (DG-02), so “Open lane” needs one:

- **`Thread` route** (`{messageId, back?}`, deep link `whombat://threads/:messageId`): `messages.thread` for the header
  (“Thread”, subtitle `#billing-v2 · Collect the merged PRs` from `where` and `topic`), then `ChatView` in thread mode —
  the root and its replies in the conversation's bubbles, the composer (“Reply in thread”, the web's words) replying
  with `threadRootId`, typing lines for that thread only, attachments as in the conversation. Opening a thread doesn't
  move the conversation's read marker.
- **Ways in:** “Open lane”; “N replies ›” (brand, 44 dp tall) under a root with replies in a channel or branch room;
  a `message` link with `threadRootId` (inbox rows, receipts); a pushed web path with `?thread=` (the test that said
  it opens the conversation now says the thread). No mocked screen changes: in the fixture world only #billing-v2 has
  threads.

## AP-183 Handoffs in the Work view on Android (DG-16)

A Work item with `handoff` gets one more line under the status pill: `Banjo, from Sketch · 86k of 2M tokens · Due Wed
23 Sep, 17:00` (owner = the item's agent, else the person responsible; mono 12/ink2; one line in the Inbox's compact
rows, two on the Work screen), also read by TalkBack as “Handoff: …”. `ask_for_report` maps to `plans.askReport` for
items that are handoffs with a plan and step ref; it is a secondary button. Its label doesn't fit a third of the row,
so a row with a label over ten characters lets its buttons size to their labels and wrap; other rows keep equal thirds.

## AP-184 `plans.askReport` outside `usePlanWrite`, and the shared fixtures on contracts 0.16.0

`usePlanWrite` (`packages/client`) only accepts the endpoints listed in its `PlanWrite` type, and `plans.askReport` is
not one of them yet. Mobile calls it with `useApiMutation` and then refetches the plan (plan screen) or the Work view
(Work rows); the plan also arrives over `plan.updated`. When `PlanWrite` gains it (the web's branch), the plan
screen can switch to it. Contracts 0.16.0 made `PlanStep.handoff` and `WorkItem.handoff` required in the output
types, so the shared work fixtures and the client's test fixtures now say `handoff: null` (needed for the app's
typecheck; the web's own models still need their new action labels on the web branch).

## AP-185 Handoffs in the app's fixture world

“Explore the demo burrow” gets `@whombat/fixtures`' “October release notes” plan (Pippa's finished handoff, Hazel's
declined one) plus a third, open one — “Draft the release notes”, Banjo from Sketch, working, due 17:00, 2M budget,
usage not reported — so every handoff state the plan screen draws is reachable. Its lanes answer as threads, a reply
and “Ask for a report” land in the lane (and arrive live), and the Work view lists the open handoff under Running
with “Ask for a report”. Pure, next to the fixture server (`src/fixtures/handoffs.ts`), and unit-tested.

## AP-186 Android asks for a report through `usePlanWrite`

Follow-up to AP-184: the shared `PlanWrite` now lists `plans.askReport`, `plans.reportBack` and `plans.delegate`, so
the plan screen and the Work rows call the nudge (and the owner's report, AP-187) through `usePlanWrite`: the answer's
plan goes everywhere at once and the Work view refetches, instead of refetching by hand.

## AP-187 Handoff actions per viewer on Android; the owner's Mark done and Blocked

Supersedes AP-181's “no `report_back`” for one case. Contracts 0.18.0 (CT-117) lists `mark_done` for everyone and
`report_back` for the owner on an unfinished handoff; clients filter by viewer, as the web's `handoffViewerActions`
does (`viewerPlanActions` on mobile):

- **The person who owns it** gets “Mark done” and “Blocked” (44 dp buttons, `report_done` / `report_blocked`) in
  `report_back`'s place, and neither `mark_done` (it would say the same) nor “Ask for a report” (a nudge to oneself).
  They call `plans.reportBack` with status done / blocked and the summary “Marked done.” / “Marked blocked.”; the
  server posts it in the lane as them and tells the delegator (DG-04, DG-24). “Blocked” isn't offered on a step that
  is already blocked. This isn't an editor (no summary, no data), so it fits DG-18; a written report stays on the web.
- **Everyone else** gets “Ask for a report” and core's “Mark done” (a person's done on a handoff is a report, DG-24),
  never `report_back`.
- Plain steps are unchanged.

## AP-188 Handoff buttons in core's order; the primary is the first after “Open lane”

The buttons keep core's order (0.18.0): a declined handoff offers Reassign before Retry (someone else takes it), and a
gate step with linked work has no Retry (it would unlink the work). The primary button is simply the first one after
“Open lane” (cancelling stays quiet), so a declined handoff leads with Reassign. AP-181 kept Reassign from being
primary; no plain step starts with it, so dropping that rule changes nothing for them.

## AP-189 Budget words: none for a person, the server's “not reported”

A handoff a person owns shows no token part (plan screen, Work row and TalkBack): a person's work isn't counted in
tokens. For an agent, the budget reads “86k of 2M tokens”, or “2M tokens · usage not reported” exactly when the server
says so (`used.reported` / `usageReported` false, which it now sets only when a finished turn reported no usage) — the
web's words (AP-174), replacing AP-180's bare “usage not reported”. What came back leads with “Reported back”,
“Blocked” or “Declined” (the web's leads, 12.5/600 in the tone) instead of the mono `REPORT` labels.

## AP-190 A toast after asking for a report or reporting back

The nudge and the owner's report land in the lane, which the plan screen and the Work view don't show, so they say
they went through: “Asked Banjo for a report in the lane.” / “Reported back in the lane.” as Android's toast
(`showNotice`, non-modal, short), replacing AP-181's dialog. The app has no in-app snackbar; iOS, which has no toast,
gets an alert. Failures and keys-engine outcomes stay dialogs, as everywhere else.

## AP-191 whombat-app 0.9.0

Contracts 0.18.0 (CT-113…CT-117: handoffs, and the console's burrows from 0.17.0). Handoffs on the web (AP-168…AP-178)
and Android (AP-180…AP-190): plan card rows and the brief, the plan pane's lane actions (Open lane, Ask for a report,
Retry, Reassign, Cancel, Mark done, the owner's Report back), “Add step” that hands work over with a brief, handoffs in
the Work view, and an Android thread screen. The step actions widen a closed union (`PlanStepAction`, `WorkAction`), so
the hosted web app ships with a runtime on contracts 0.18.0 (Whombat delegation, candidate 0.16.0); an older Android
build shows handoff steps as plain steps.

## AP-192 A narrow plan card stacks a step's owner under its title

Seen live on dev after 0.9.0: in the thread pane (~340px) a handoff row's owner column (“Moss, from Pike” and the state)
squeezed the step title to one word per line. The card's step list is a size container; below 420px a row puts the
owner and state on a second line under the title. Cards at the channel's width keep the mock's single row (the visual
comparison is unchanged). whombat-app 0.9.1.

## AP-193 Sign-in says when Whombat is invite-only; operators invite by email (control BL-33…BL-35)

John, 2026-09-28: with signups on “Invite only”, any address still got a sign-in link at app.whombat.com. Control now
mails a link outside `open` mode only to accounts, invited addresses and code holders, and answers the same either way
(BL-33, option (a): no enumeration). The hosted sign-in page reads the mode it already loads (`GET /v1/signup`):

- `invite`: the sub line is “Whombat is invite-only for now. Sign in with the email address your invitation was sent
  to.”; `waitlist`: “Whombat has a waitlist for now. Sign in with the email address your invitation was sent to, or
  join the waitlist.” with a “Join the waitlist” link button. A held invite code (`/signup#code=`) keeps the usual line
  and is sent with the request (`MagicLinkRequest.code`), so a code without an address still gets its holder in.
- After sending, outside `open` mode: “If you’re invited or already have an account, we sent a sign-in link to
  {email}. Open it on this device.” It never claims a link went out.

The operator panel's Signups screen (BL-34, BL-35): the tab is “Invitations and codes”; “Invite by email” (primary,
next to “Create code”) asks for the email, a note, an optional plan and the days it works, and sends a single-use code
bound to that address. Rows show the address under the hint and “Sent {time}” or “Not sent” under the status; an unused
invitation (active or expired) has Resend, which confirms that the old code stops working. Contracts 0.19.0;
whombat-app 0.10.0. Android's sign-in is unchanged (it still says “We sent a sign-in link”): a follow-up.

## AP-194 Choosing an AI client installs it, with the runtime's progress; a failed install says why (Whombat SUB-55)

John, 2026-09-28, on a production box: in onboarding's “Set up your AI”, Install did nothing. The box's manager had no
tested client to install (the production client channel was empty) and answered `unavailable`; the runtime returned
`failed` with `client.unavailable` once and listed `not_installed` again, and the app dropped the answer — the
onboarding's install-on-choose ignored both answer and error (`.then(refresh, refresh)`), the row's Install button
kept only thrown errors. Now:

- **Superseded in part by AP-5615 (chatgpt-no-client.md)**: only Claude Code has a client row to install; choosing
  ChatGPT installs nothing. **Choosing is installing.** `ClientRow` with `autoInstall` (onboarding, once the list is loaded) starts the install
  once per mount when the list says the client isn't installed; the row mounts when its card is chosen, so the other
  client installs only when chosen, and choosing a client again after un-choosing it tries again. The row shows no
  Install button then — only “Try again” after a failure. Settings keeps its Install button.
- **The answer counts.** An install's answer is shown until a list read after it arrives (`shownClient`,
  `dataUpdatedAt`), and a `failed` answer for as long as the list says `not_installed` (runtimes before Whombat SUB-55
  don't keep it): “Install failed”, the reason (“No tested Codex version is published for this appliance yet.”) and
  Try again. A thrown error shows its message with Try again, as before.
- **Real progress.** While the request is on its way, or while the runtime reports no percentage, the bar is an
  indeterminate sweep (static under reduced motion) with no `aria-valuenow`; the old fixed 8 % fill is gone. Otherwise
  it is the list's `progress` (the manager's 0–80 download, 80–100 unpack, pushed at most once a second; the list
  polls every second while a client installs). No contract change: `ClientStatus.progress` already carried it.

Tests: `ClientRow.test.ts` (`shownClient`), onboarding (installs on choose with the bar and no Install click, only the
chosen client; a refused install shows its reason and Try again installs again). The fake gains `unpublished`.

## Agent capabilities: avatars (AR-03)

### AP-195 Six more roles after the reference twelve

`@whombat/avatars` (`AVATAR_ROLES`) and `@whombat/tokens` (`AGENT_ROLES`, `--role-<role>` / `--role-<role>-deep`)
add lead, tester, product, security, analyst and writer, in that order after marketing: labels Lead, Tester, Product,
Security, Analyst, Writer; characters Compass, Pepper, Maple, Bolt, Tally, Quill (the default names come with
contracts 0.20.0; `@whombat/core` is not touched here). `WhombatAvatar.dc.html` does not draw them, so
`REFERENCE_ROLES` (the first twelve) is what the reference comparisons cover: `apps/web/visual/avatars.spec.ts` and
the `gallery` script. The six are checked on the family sheet, `pnpm --filter @whombat/avatars sheet` (every role in A,
B and C, bust and head crops, light and dark surfaces, close-ups of the six). As for the whole family, direction C (the
robot) wears no accessory. `svg/<role>.svg` and `svg/<role>-head.svg` are exported for the six.

### AP-196 One accessory each, in a slot no other role uses that way

The drawings keep the Avatar System's rules: cream, satin ink or brass, separate from the sweater by lightness, and the
role colour only as a detail. The existing CSS-box numbers and drop shadows are reused.

- **Compass (lead)**: a brass pocket compass on a short ink cord, hanging at the centre of the chest. It is the only
  hanging prop. Its needle points north in the role colour.
- **Bug net (tester)**: a wooden handle with an ink grip runs from the chest up behind the head. Above the right ear
  an ink hoop, seen from the side, holds a cream mesh bag. The net is drawn in the body layer, so the head hides the
  handle. It changes the silhouette and reads in the head crop. A first version with the hoop seen from the front
  read as a racket. No role colour (like the clipboard).
- **Sticky notes (product)**: two notes stuck high on the left chest, above the calculator/rosette zone: a
  butter-cream note with ink lines over a pale note in the role colour. Plain cream read as paper or a letter.
- **Shield (security)**: a brass shield badge high on the right chest, which is the pin slot the Avatar System tried
  for Echo's speech bubble. It has an ink field and a keyhole in the light role colour.
- **Bar chart (analyst)**: a satin-ink tablet held at the centre of the chest, with four cream bars. The tallest bar is
  in the role colour. It is the only dark chest prop, so it doesn't read as the clipboard or the calculator.
- **Quill (writer)**: a cream flight feather tucked behind the left ear. It is drawn first in the head layer, so the
  ear and face hide its root and it moves with the head. Its tip is in the role colour.

Direction A has larger ears, so the net sits 4 higher and the quill 6 higher and 1 further left.

### AP-197 Palettes: the free hue gaps, then darker or greyer

Twelve hues about 30° apart leave no 40° gaps. The three widest gaps take three roles at the family's lightness and
chroma: product amber (OKLCH h 58, between ochre and clay), tester pine (h 171, between moss and teal) and analyst
cerulean (h 221, between teal and blueprint). Tester and analyst sit a little darker (L .58–.60) to stay clear of
their neighbours. Lead cobalt (h 264) and writer violet (h 305) share hue ranges with existing roles, so they are
darker (L .56–.57 against the family's .61–.72). Security slate is the one low-chroma accent (C .04, h 249). Deep is
the accent about 0.12–0.14 darker in L, like the reference's.

| role | accent | deep |
|---|---|---|
| lead | #4a71c7 | #2a4ea0 |
| tester | #328c72 | #00664f |
| product | #d68541 | #a75b0c |
| security | #73899f | #4e6378 |
| analyst | #248ca9 | #006681 |
| writer | #8a60b6 | #673c91 |

Each new accent is at least ΔE_OK 0.056 from every other accent. The nearest pair is product and operator. The
reference twelve are 0.051–0.075 apart. There was no contrast check for role colours, so `packages/tokens/src/roles.test.ts`
adds one for all eighteen roles, with floors taken from the reference family:

- the dot (accent) reaches 3:1 on every dark surface and 2:1 on every light surface (citron is 2.06:1 on light
  `sf2`; the role name always sits next to the dot);
- deep reaches 3:1 on every light surface;
- every two accents are at least 0.05 apart in OKLab.

Measured: lead dots are 3.07:1 on dark `sf2` and writer dots 3.03:1, the lowest of the six. The darker hues gain on
light surfaces (≥ 3.99:1).

### AP-198 Fur and expression: no repeated face

Each fur tone goes to two new roles, chosen for contrast with the sweater:

- sandy: lead and writer
- cocoa: tester and security (slate on cocoa)
- ash: product and analyst (amber on ash)

The expressions reuse the family's twelve, and each new role has a different one: lead assured, tester eager, product
warm, security focused, analyst composed, writer thoughtful. No fur × expression pair repeats an existing role's.
Faces were compared this way when Penny read like Harper (Avatar System finding 03). The avatars tests enforce unique
faces and unique accessories.

### AP-199 One palette, two copies, kept in step by a test

`@whombat/tokens` keeps its own copy of the role palettes (CSS variables, native themes). `@whombat/avatars` now
dev-depends on `@whombat/tokens`, and `src/tokens.test.ts` checks that both list the same roles in the same order with
the same label, colours, fur, accessory and expression. The web app is not wired to the six yet: core 0.19 doesn't know
them. The Storybook baselines that list every role (Foundations/Avatars, Foundations/Tokens) change when the stories
suite is next updated (`pnpm visual stories.spec.ts --update-snapshots`).

## Agent capabilities: skills (SL)

Web and `@whombat/client` for the skills library on contracts 0.20.0 (Whombat `skills-library.md` SL-01…SL-09,
SL-D01…SL-D04; `agent-roles.md` AR-D01; contracts CT-119…CT-124). Nothing here is in the mocks (B-05): the screens take
the hire modal's key rows, Settings' cards and rows, the pack and memory modals and the approval card; tokens only, the
contracts' own words where they have them (`packSkippedReason`, `rolePackSuggestionText`, `skillUsesText`,
`SKILL_REQUIREMENT_LABELS`, `SCAN_*_LABELS`, `skillCardLabel`).

### AP-200 The hire modal: keys by role, and the packs it sends

KEYS are `hireKeyOptions(role)` (AR-D01). The modal keeps only the rows the person switched (`keyEdits`); every other row
shows the role's default, so picking another role re-applies the defaults of the rows nobody touched, and a capability
role's extra keys (a Writer's “Write canvases”) follow as rows, on. The role grid is `HIREABLE_ROLES`: the six new roles
come after the mock's eleven with their avatars, without a change here. The hire sends `packs` (the SKILLS group's
ticked packs) only when there is one, so the mock world's hire is unchanged. After a hire that attached packs the pack
reads refetch. Skipped packs replace “Say hi in a DM.” in the toast, which stays up 6 s: “Pepper joined the burrow. An
owner can add Tester craft in Settings → Skills & packs.” (the server's `reason` for one, `packSkippedReason` of the
titles joined with “and” for several).

### AP-201 The SKILLS group under KEYS

`RolePackRows`, shared by the hire modal, onboarding and Configure: `SKILLS` in the KEYS label's type, then one
`ToggleRow` per shipped pack for the role (`rolePacks(role, bundled)`, in bundled order) — the pack's title over its
skills' names (13px, mut), and in warn under them what the chosen keys leave its skills without (`skillReadiness` with
the modal's switches: “needs a scratch workspace · needs the web key”). Writing feature branches counts as a workspace
there (a writable checkout, SL-02), so a Developer isn't told it needs one. The note before the switch is the skill
count. A shipped pack that isn't installed is locked with “an owner adds it” for someone who can't import (`can.import`
false), so the hire doesn't ask for what the server would skip. The group isn't shown while `packs.list` loads or when
nothing is shipped (older servers, the mock world): the mocked screens stay as drawn.

### AP-202 Onboarding step 3: “Skills for {Agent}”

Under the agent cards, a SKILLS group per picked agent whose role ships packs, labelled “Skills for Sketch”, pre-ticked;
readiness uses the role's default keys (the first agents get `ROLE_DEFAULT_KEYS`). “Open {burrow}” sends
`CompleteOnboardingBody.packs` for the roles with a pack left on. The choice isn't part of the saved progress
(`OnboardingState` has no field): after a reload the packs are ticked again.

### AP-203 Configure: the role's keys and its packs, on Save

KEYS are `hireKeyOptions(agent.role)` with `configureKeyState` / `configureGrants(…, options)`, so a Lead's extra rows
show and save. SKILLS lists the role's shipped packs, on when attached to this agent. Like the keys they are a draft:
Save attaches what was switched on and detaches what was switched off, last (after keys, channels and the workspace, so
a scratch key a pack needs is saved first); a refusal stops the save and shows the notice. Attaching a shipped pack
that isn't installed imports it first (`useShippedWrites`: `packs.importLocal`, or `packs.importBundled` over the session
on a managed Whombat, CT-56), then attaches its newest version. A role pack already on the whole burrow shows “on the
whole burrow” where the switch would be. The readiness line uses the agent's held `can` grants with the modal's
switches applied.

### AP-204 Settings → Skills & packs

The Packs tab is renamed “Skills & packs”; `?tab=packs` stays. Sections, in the order of what needs a person first:
PROPOSED (always shown: a waiting proposal is the only thing here that can block an agent), INSTALLED, SHIPPED WITH
WHOMBAT, IMPORT (unchanged). SL-04 lists SHIPPED first; eleven catalog cards above everything installed would bury the
switches people come for. The intro says what a skill is and that a pack grants nothing; “Learn this” sits beside it.

### AP-205 SHIPPED: one card per pack, under its roles

Each shipped pack is listed once, in role order (`AGENT_ROLES` of its first role), headed by the heads and labels of every
role it suits (“ANALYST · FINANCE”) — grouped by role without repeating Documents under three roles. A card: title,
`name version · n skills`, the scan as an outline tag when it isn't safe, Import (owners) or “Installed”, the
description, its skills (name in mono, the description on one line with the full text as its tooltip, the `requires`
labels), and “Attach to” with the agents the viewer may configure and, for owners, the whole burrow. Attaching imports
first when needed (AP-203); someone who isn't an owner can attach only an installed pack.

### AP-206 INSTALLED: skill switches, role-pack suggestions, own packs

First the one-time suggestions (SL-D04), one row per agent that has one (`packs.agent` for every agent the viewer may
configure): its head, `rolePackSuggestionText` (“Sketch is an architect. Attach Developer craft?”), Attach (imports as
needed) and Not now (`packs.dismissRolePacks`). Then each installed pack as a Settings row — “Written by Pippa · 1 skill
· On Pippa” for an agent's own pack (`createdBy: agent`, `ownerAgentId`), the scan tag, Inspect — followed by its
attachments' skills. An agent's attachment has one switch per skill (`packs.setSkill`), with what the skill lacks
(`labels`, warn) and its uses (`skillUsesText` from `skills.uses`). A burrow-wide attachment says who a skill is off for
(“Off for Banjo”) until an agent is chosen in “Switch for”; then its switches are that agent's (there is no “off for
everyone” but detaching, SL-01). Toasts use the Keys event's words: “Turned off the skill pptx for Banjo.” The pack
modal (Inspect) shows SCAN (verdict and findings) when the version isn't safe, each skill's `requires`, and “Written by”
for an own pack.

### AP-207 PROPOSED

`skills.proposals?status=proposed`, newest first, each proposal a block: the agent's head, the skill's name in mono,
“Proposed by Pippa · 11:18”, the scan tag, what it does, WHY (the agent's reason, quoted), FILES (path · size), Details
(reads `skills.proposal`: what the scan found, the SKILL.md and each file's text, or “Only the people who decide and the
agent’s conversation can read the skill itself.” when the body is withheld), then Approve / Reject with “Add a note”
for whoever `canDecide`. A decided proposal leaves the list (its card keeps the outcome). A 409 shows the server's
reason under the buttons.

### AP-208 The skill proposal card

The approval card's frame: 1.5px border, warn while waiting; `skillCardLabel` in the status's tone (waiting warn,
approved ok, rejected mut) with the agent on the right; the skill's name in mono at the card title's size with the
scan tag; what it does; WHY; FILES; once decided, under a line, “Approved by Mara Okafor · version 1.2.0” and the
note on its own line. It never shows the body (the card doesn't carry it, SL-D01): Details reads `skills.proposal`.
While the proposal waits, the card re-reads `skills.proposal` and shows Approve / Reject only when that answer says the
viewer `canDecide`. Deciding puts the new state everywhere at once (`applySkillProposal`: the view, the lists, the
card) and the pack reads refetch on approval; `message.updated` brings it to everyone else. A viewer outside the
audience sees “SKILL PROPOSAL” and “A skill proposal”. Unlike the phone (AP-233) the web decides after a `caution`
scan too: the findings are one click away on the same card. Stories: waiting (caution), approved with a note,
rejected, outside the audience.

### AP-209 “Learn this”

A dialog in the pack and memory modals' language (kicker LEARN A SKILL, “Teach Pippa a skill”), from the profile's
PACKS, from the Skills tab (with an agent picker) and from a message's menu (“Learn this as a skill”). “Learn from”: A
web page (the address, `http(s)` only), A file, or — from a message — This thread. It posts as the person with
`skillHint: {kind: 'learn'}`: in the agent's DM (`conversations.openDm`) “Learn this as a skill: https://…”, a file
uploaded to the DM first and attached (“Learn this as a skill: invoices.xlsx”); from a message, a reply in its thread
mentioning the agent (“@Pippa Learn this thread as a skill.”). After a DM post the app opens the DM. Without “Propose
skills” (SL-06) the agent couldn't answer, so “Ask to learn it” stays disabled and the dialog says “Pippa can’t propose
skills yet.” with the “Let Pippa propose skills” switch for whoever may configure it (an owner; a personal agent's
owner) — `agents.setKeys` as the memory modal does — or “An owner can let it propose skills in its memory settings.”

### AP-210 “Let {Agent} propose skills”

The memory modal's Instructions tab has the “Propose skills” switch right under “Let {Agent} propose instructions and
knowledge”, for the same viewers, with the same “people approve” note; it replaces the agent's grants with
`skills.propose` at `can` added or removed. Toasts: “Pippa can propose skills now.” / “Pippa no longer proposes
skills.”

### AP-211 The profile's PACKS

The section shows when a pack applies, a role pack is suggested or the agent holds “Propose skills” — none of which the
mock world has, so the mocked pane is unchanged. Its head has “Learn this” as a link button (RECENT's layout). The
suggestion, when there is one, comes first, compact. Each pack: its title with `version · the whole burrow · off` in
mono, then its skills for this agent from `packs.agent`'s `agentSkills` — the name (the description as its tooltip: the
pane is 380px), the switch (when `canManage`), its uses and what it lacks. “Manage packs →” ends it.

### AP-212 `/` offers skills; the chip

After `/` the composer lists the commands, then the skills (labelled SKILLS when there is no command): in a DM the DM
agent's enabled skills (`/name `); in a room those of the agents in it — not someone else's personal agent, not system
principals — an agent's own skill with its head and name (`/name @Agent `, so the mention wakes the agent that has it)
and a skill several agents here have (a burrow-wide pack) once, as `/name ` with “5 agents”. Descriptions are cut to one
line. The skills are read (`packs.agent` per agent, `useAgentsSkills`) once a draft starts with `/`. `activeCommand`
reads digits and dashes (`/3-statement-model`). Sending: a draft `/name …` whose DM agent, or an agent it mentions, has
that skill switched on is a message, not a command (`skillSend`): the rest of the text (the text as typed when nothing
follows) with `skillHint: {kind: 'use', name}`; `/topic` and `/invite` stay commands. A resend keeps the hint. The
thread pane's composer has no skills list. A message with a hint shows a chip after its time — `/grounded-citations` or
“Learn a skill”, mono, the soft tag's frame without uppercase.

### AP-213 The skills fixture world

`app/skillsFixtures.ts`, on with `VITE_FIXTURE_SKILLS=1` (or `createWebFixtureFetch({ skills: true })`), so fixture mode
and the visual suite keep the mock's screens: the eleven shipped packs with their real titles, roles, skills and
`requires`; Documents on the whole burrow with `pptx` off for Banjo, Developer craft on Banjo, Researcher craft and
Pippa's own pack on Pippa; Pippa's `receipt-check` waiting (scan `caution`) with its card in her DM, an approved and a
rejected proposal; uses; Sketch's suggestion; a hire that attaches what it asks for (importing as an owner would). It
answers `packs.*` (list, agent, inspect, import, attach, detach, update, setSkill, dismissRolePacks) and `skills.*`, to the
contracts' schemas (`skillsFixtures.test.ts`). Tests use it through `test/skillsServer.ts`, which records every write.

### AP-214 Client hooks, and the visual check

`@whombat/client`: `useSkillProposals`, `useSkillProposal`, `useSkillUses`; `useDecideSkillProposal` (the answer through
`applySkillProposal`, and a `skill` card patcher); `usePackWrite` takes `packs.setSkill` and `packs.dismissRolePacks`;
`useAgentsSkills(burrow, handles)` (enabled skills and each agent's `packs.agent` answer, lazily) with the pure
`enabledSkillsOf`; `skills.proposal` / `skills.proposals` refetch on a conversation's resync. `useSendMessage`'s
`skillHint` is the one Android added (AP-234). Visual: every mocked screen is unchanged (the skills world is opt-in); the
“Hire an agent, name and keys” baseline is retaken for AR-D01's two new rows (a Designer holds the scratch key); the
skill card has four story baselines. Every touched screen was shot at 1440×900 in both themes with the skills world
(`~/.cache/wb-tmp/cap-shots/web-skills/`) and checked against the hire modal, Settings, the pack and memory modals and
the approval card.

## Agent capabilities: roles, Vault login, browser, spend

Web and `@whombat/client` for the capability workstream on contracts 0.20.0 (Whombat `agent-roles.md` AR-02, AR-03,
AR-07; `browser.md` BT-10; `vault.md` VT-D28…VT-D33; `spend.md` SP-01, SP-02, SP-D01). Unmocked screens follow the
nearest mocked pattern (B-05): tokens only, copy verbatim with the product's quotes and middle dots.

### AP-215 The six roles wherever a role shows

Every role→something map on the web and in the client is core's (`ROLE_LABELS`, `ROLE_JOBS`, `ROLE_DUTIES`,
`ROLE_DM_SUGGESTIONS`, `HIREABLE_ROLES`) or the tokens' (`--role-<role>`, `rolePalettes`), typed `Record<AgentRole, …>`,
so contracts 0.20.0 brought the six to the roster, the profile's role line, the hire modal's cards and duties, the DM
empty state, the plan owner picker and the audit log without a change here. Two gaps closed:

- **Canvas highlights** tinted only architect, developer, operator and support (hand-listed `--tint-<role>`); any other
  role fell back to the selection colour. Now every role but researcher and reviewer (the mock's `--mark` / `--mark2`)
  is its accent at the editor's `--tint-share` (16 % light, 24 % dark, the old values), so a role added later is
  tinted too.
- **An agent without a job of its own** (the fixture world's hires; the server sets `ROLE_JOBS[role]` at hire) reads
  its role's job on the profile and in the DM's intro, instead of an empty line.

The profile pane shows the agent's job, not its duties: the mock's pane has no duties, and they stay the hire modal's
(the role picked). The onboarding picker renders whatever `onboarding.agents` lists, after the mock's three
pre-picked roles (`ONBOARDING_DEFAULT_ROLES`); its Skills group is the skills workstream's.

### AP-216 Client hooks: spend and Test sign-in

- `useSpendOverview` and `useAgentSpend` (`api.spend.overview`, `api.spend.agent`) are read hooks with
  `refetchOnMount: 'always'`: no realtime frame carries spend (SP-02), so a screen showing it reads again whenever it
  opens, however fresh the cache. Both are in `READ_HOOKS`; Android's agent screen (AP-236) reads its week through
  the same `useAgentSpend`, one hook per endpoint.
- `useVaultTestSignIn(burrow)` posts `api.vault.testSignIn` and, like every Vault write, puts the answer's entry (with
  the check the outcome recorded) into `vault.get` and refetches the Vault's reads. The result and its screenshot are
  the mutation's data only: never in a query, and dropped when the component unmounts (`gcTime: 0`, VT-D31: never
  stored). Over a managed session `vault.testSignIn` is an export op (`EXPORT_OPS`, larger than one message): a JSON
  export is decoded by the session already; an answer handed over as a file is decoded here (`decodeTestSignIn`) and
  parsed with `VaultTestSignInResponse`.

### AP-217 Add to Vault: Basic auth and Login

The templates are core's five in its order (`VAULT_TEMPLATES`), two tiles a row as before. **Basic auth** is the old
basic-auth form (address, username, password). **Login** asks for the name, “What should agents know?”, the **Sign-in
page** (the address field's label for a login; the same destination hint), the username, the password (write-only,
“Sealed when you save.”) and, under **Advanced**, the three selectors: “Username field”, “Password field”, “Sign-in
button”, mono inputs with `#email`, `input[name="password"]`, `button[type="submit"]` placeholders and core's
“Leave these empty and the browser finds the fields itself.” Advanced is a quiet text disclosure with the cards'
chevron; it opens by itself when a selector is set or refused. Empty selectors are left out of `auth`; the contract's
own schema refuses the rest before sending (“Keep a selector to 200 characters.”).

Saving a login does **not** sign in: every other entry is checked right after `vault.create`, but a Test sign-in opens a
real website and submits the password, which the owner should choose to do. The card opens with “Not checked yet”,
the hint “Opens the sign-in page in the browser Whombat runs and signs in once.” and Test sign-in.

An entry's Edit changes a login's selectors too (`vault.update` with `auth`, the username kept); Replace changes the
password and, as for Basic auth, the username with it (`vault.setSecret`). Creating entries and secrets stays on the
web (VT-73); nothing changed on Android.

### AP-218 A website login's entry: Test sign-in instead of Check connection

CONNECTION shows the sign-in page (mono), “Signs in as {user} in the browser”, each selector that is set (“Password
field · `#password`”) and the check line with **Test sign-in** (owner only: the Vault only ever shows the viewer's own
entries). There is no “Check again” (`vault.check` answers `wrong_kind` for a login) and no TOOLS; AGENTS WITH A KEY and
RECENT USE are as for every entry. While it runs the line reads “Signing in…”. The answer's entry updates the line
(“Checked just now · Signed in”, “… · The page still asked for the password.”) and the card's dot everywhere at once.
`unavailable` records no check (the browser was down), so its words (“The browser isn’t available on this Whombat right
now.”) show under the line instead. The screenshot shows under the line in a 16:10 frame (the browser's 1280×800
viewport, BT-D04; anything else letterboxed, never stretched), a `data:` image with the alt “The page after signing in
to “{name}””, and core's “Only you see this screenshot. Whombat doesn’t keep it.” It stays while the entry is open.

### AP-219 Settings → General: Web browser

A **Web browser** row in the AI provider card, after the runner and the providers, in their style: a status dot (ok
available, muted off, bad unavailable) with core's state label, the name “Web browser” and the meta “Available” or
“Off · This Whombat has less than 8 GB of memory.” — core's `browserStatusLine` split at its colon, as the providers'
rows split name and state. The value is `AgentSetupStatus.browser` (the status General already polls), else
`HostInfo.browser`; neither (an older server) shows no row. When the runner's status can't be read but the host says,
the row is a card of its own under AI PROVIDER. The AI provider panel takes extra rows as children; onboarding passes
none, so its step 2 is unchanged.

### AP-220 Settings → Spend, for everyone

A **Spend** tab after Feedback (`?tab=spend`), shown to every member: owners see the burrow (`scope: burrow`), a member
their own turns and their assistant's (`scope: own`), as the server decides (C-10). The tab reads again whenever it
opens (AP-216) and nothing on it is live.

### AP-221 What the Spend tab shows

- The intro, owners: “What agents’ turns used in {burrow}, as their AI providers reported it.”; members: “Your spend:
  turns agents did for you, and every turn of your own assistant.” Under it, muted: “These are estimates from what the
  AI providers report. Whombat doesn’t bill for them or limit them.”
- **TOTALS** (members: **YOUR SPEND**): three tiles, Today, 7 days, 30 days, in the Settings card's border and radius:
  the tokens large (DM Mono 500 28px, core's `formatTokenCount`: 113k, 1.4M) with “tokens”, then “52 turns · about
  $5.47” in mono meta (core's `formatCost`; turns only when no turn reported a cost).
- **BY AGENT · 30 DAYS**: the roster's identity (26px head avatar, the name linking to the profile, the mono role line
  with its dot; a personal agent reads “Mara’s assistant”) and right-aligned mono columns TURNS, TOKENS, COST under a
  mono header row. **BY PERSON · 30 DAYS** (owners only; a member's would be just them) likewise with the person's
  avatar; “Nobody” has an empty avatar slot and “Work nobody asked for: schedules and automations.”
- **HANDOFF BUDGETS**: “2 open handoffs · 84k of 400k tokens used” (“… tokens used, no budget set” without budgets),
  or “No open handoffs.” **TOP PLANS**: the title and “84k of 200k tokens” or “4.1M tokens · no cap”, or “No plan used
  tokens in the last 30 days.”

The tables show 30 days, in the server's order (30-day tokens, most first, “Nobody” last) with idle rows dropped: the
tiles already give all three windows, and one window for both tables keeps them comparable without a picker.

### AP-222 Honest numbers

A row whose turns reported no cost shows “—” in COST (“not reported” to a screen reader), never $0.00. Under the tiles,
when the 30 days are partial: “Costs are for the 135 of 201 turns whose provider reported one.” and “2 turns reported
no usage.” (SP-D01). Every number is core's formatting; the web computes no cost.

### AP-223 The Spend tab's states

Loading shows skeleton rows in a card; a failed read “Couldn’t load what agents used. Try again in a moment.” with
Retry; an empty table “No turns in this window.”

### AP-224 The profile's week

Under the profile's buttons (or “Works only for …”), one mono meta line: core's `spendLine` — “This week: 703k tokens ·
about $2.95”, “This week: 1.2M tokens” without a reported cost, “This week: no turns”. It shows nothing while loading
or when the read fails (a member on someone else's agent; `retry: false`). A member's line counts only their turns
(`scope: yours`), in the same words. The mock's profile has no such line: the mock comparisons hide it like the other
additions (`[data-agent-spend]` in `hideAdditions`), so `agents.spec.ts` compares the rest as drawn.

### AP-225 The browser's activity rows

Rows are what the server stores from core's `describeActivity`: “Opened example.com” with the URL (no query or
fragment) as the object, “Used the browser on example.com”, “Used the browser”, “Couldn’t open …”, and a sign-in as
“Used a private Vault entry” with no object. The feed has no per-kind icons (the status mark leads every row), so
`web` rows need nothing new; they are never folded with routine reads, and show compact as a Work item's latest row.
Tests pin this in `features/activity/browser.test.tsx`.

### AP-226 Feedback: a Product agent assesses by default

A **new** integration pre-selects the channel's first eligible Product agent (by name; `assessorProblem` null: guarded,
Claude Code, Codex or scripted, not personal or system) as its assessment agent, until the owner picks another or
“None”; changing the channel suggests again for the new one. Editing an integration never changes its assessor.
`defaultAssessor` in `settingsForm.ts`.

### AP-227 The new keys' rows

“Use a web browser” (`browser.use`), “Run tools in a scratch workspace” (`workspace.scratch`) and “Propose skills”
(`skills.propose`) are core's catalogue labels: the profile's KEYS reads them through `keyRows`, a blocked answer
carries its `keyNeeded.label` from the server, so they show without web copy (tested on a hired Lead's profile). The
hire modal's and Configure's rows are the skills workstream's.

### AP-228 Visual checks

`pnpm visual`: every mock comparison passes unchanged (the week line is hidden, AP-224). The Settings baselines stay
within their tolerance with the tab row's **Spend** and General's Web browser card (fixture mode serves `host.info`
with the browser available but not `host.agents`, so General shows the browser's own card), so they were not retaken.
New baselines: Add to Vault with Login and Advanced open, and Settings → Spend. The stories that list every role
(Foundations/Tokens' roles, Primitives/Modal's hire grid) were retaken with the six (AP-199 left them for this). “Hire an
agent, name and keys” differs by core 0.20's two new key rows (`hireKeyOptions`, AR-D01): the hire modal is the skills
workstream's, which retakes it. Screens were also checked by hand at 1440×900 in both themes against the Settings,
roster and Vault patterns.

### AP-229 The fixture world's gaps

Fixture mode (`@whombat/fixtures` 0.20.0) serves spend, `host.info` with the browser, Test sign-in and the login
kind, but: `vaultShopLogin` is exported and not served (the web's fixture fetch doesn't seed it; tests and screenshots
add a login through Add to Vault), a hire's `job` and `doing` are empty (AP-215 covers the job), hires don't join
channels' `memberIds`, and `host.agents` isn't served. None needed a web workaround beyond test wrappers.

## Agent capabilities: Android

Whombat's agent-capabilities workstream on the phone (`skills-library.md` SL-04, SL-06, SL-09; `agent-roles.md` AR-07;
`browser.md` BT-10; `spend.md` SP-02; `vault.md` VT-D28…VT-D33), on contracts 0.20.0. Nothing from the web's Skills
tab, Spend tab, hire modal or Vault forms comes to the phone beyond what these entries say.

### AP-230 The six new roles wherever a role shows

Labels come from core (`ROLE_LABELS`), avatars from `@whombat/avatars` through the app's react-native-svg renderer,
and the role's colour from the native tokens (`theme.roles[role].accent`), as a 7dp `RoleDot` next to the role's name
(decorative: the name is always beside it, AP-197). It sits before the roster row's meta (`ListRow` `metaLeading`),
in the agent screen's role line, which now follows the web's profile pane (the role's dot, `DEVELOPER`, `·`, the status
in its status colour, read by TalkBack as one “DEVELOPER · WORKING”), and before an agent's role in the reassign sheet
(`OwnerChoice.role`). The DM header keeps the mock's “Researcher · remembers this chat” without a dot: the mobile mock
draws that header, and the mock wins.

### AP-231 The start of a DM: the role's suggestions

An agent DM with no messages shows the desktop's `dmEmpty` in the phone's language instead of the one quiet line: the
96dp bust, “This is the start of your DM with Tally” (“Meet Tulip, your assistant.” in the owner's own DM, PA-04), core's
`dmIntro` and the role's three `ROLE_DM_SUGGESTIONS` as the quick-reply pills (36dp, grown to 44). As on the web a tap
fills the composer and focuses it; it doesn't send (`Composer.fill`, `ChatView.renderEmpty`). Every role has its three,
the six new ones included (AR-02).

### AP-232 Skill switches on the Packs screen (SL-04)

Each skill of an attachment that applies to the agent (`packs.agent` → `agentSkills`) is a row under the pack's toggle:
the name (mono), the description, one mono line with what stops it from running (`labels`, “needs a scratch
workspace”) and how often it ran (core's `skillUsesText`), and a 44dp `Switch` (`packs.setSkill` with the agent's
handle, then the agent's packs refetch; the switch shows the new state until they answer). A burrow-wide pack's switch
changes this agent only, and its TalkBack hint says so (“Turns it off for Pippa only”). When the viewer can't manage
the attachment (`canManage`) the switches stay visible, disabled, with who can under them: “Owners switch the skills of
a pack the whole burrow uses.” or “Only Joris de Vries switches Tulip’s skills.” Expanding a pack no longer repeats its
skills when they are listed with switches (an older server without `agentSkills` still shows them there). The screen
sends people to the web tab's new name, “Settings → Skills & packs”; the agent screen's row reads “skills · tools”.
Uses, readiness and switches are all; attaching, role-pack suggestions, proposals and imports stay on the web.

### AP-233 The skill proposal card (SL-06, SL-D01)

A `skill` card is a compact card like the others: `skillCardLabel` (“SKILL PROPOSAL · WAITING FOR APPROVAL”), the
skill's name, its description and a mono line “Scan: Caution · 2 findings · 1 file · Approved by Mara Okafor”, in the
outcome's tone (approved ok, rejected bad, a cautious scan warn). A viewer outside the audience sees “A skill proposal”,
muted. Deciding is cheap, so the phone decides, with one rule of its own: Approve and Reject (44dp, side by side, each
asking first) appear when the proposal is `proposed`, the card says the viewer `canDecide` (the same per-viewer field
`skills.proposal` answers; the card is resolved per viewer and re-published on every decision) **and the scan was
`safe`**. After a `caution` scan the card says “The scan found something to read first. Decide on the web.”: the
findings and the skill's text are on the web, and approving what one hasn't read would be the wrong default. The
Approve dialog quotes the agent's reason, attributed (“Hazel’s reason: “…””), and says “Hazel can use it from its next
turn.”; Reject says “Hazel won’t get this skill.” (destructive). The card updates from `message.updated`; the app also
refetches its message lists after a decision. The inbox needs nothing new: its row is the server's text and opens the
conversation, where the card is.

### AP-234 Skill hints: the chip and `/skill` (SL-07, SL-09)

A message with `skillHint` shows a small mono pill above its bubble (sf2, on the bubble's side): “/xlsx” for `use`,
“Learn a skill” for `learn`, read by TalkBack as “Asked to use the skill xlsx” / “Asked to learn a skill”. The composer
sends a hint for a message that starts with `/name` (core's `parseSkillCommand`) when the DM's agent, or an agent the
message mentions (`resolveMentions`, in order), has that skill switched on in a pack that is on: the app reads that
agent's `packs.agent` only for such a message (TanStack's cache, a minute fresh), then sends the rest of the text (the
text as typed when nothing follows the command) with `skillHint: {kind: 'use', name}`. Anything else — no command, a
skill the agent doesn't have, an older server, a refused read — goes as typed without a hint. There is no autocomplete
on the phone. `useSendMessage` (`packages/client`) gained `skillHint`, passed in the body and on the optimistic copy, so
the chip doesn't flicker in; the web branch needs the same field, so the two additions meet in one place when merged.

### AP-235 The capability keys on the agent screen (BT-10)

`workspace.scratch`, `browser.use` and `skills.propose` need nothing of the phone: the KEYS section is core's
`keyRows`, so they show with core's labels (“Run tools in a scratch workspace”, “Use a web browser”, “Propose skills”),
marks and order. Whether the host's browser is available (`HostInfo.browser`) is not repeated on the phone: Settings →
General on the web says it.

### AP-236 This week's spend on the agent screen (SP-02)

One mono line under the job in the agent screen's hero, core's `spendLine` over `spend.agent` (“This week: 202k tokens
· about $0.85”, tokens alone when no turn reported a cost, “This week: no turns”). For a member it counts their own
turns (`scope: yours`) without saying so, like the web's line. It is fetched on open without retries and hidden while
loading, on a refusal and on a Whombat without it. The hook is the app's own `queryHook(api.spend.agent)`, so
`packages/client` stays untouched.

### AP-237 Website logins in the Vault (VT-D28…VT-D33)

A `login` entry lists and opens like every entry: “Login · shop.example.com · 1 agent” (core's `vaultEntryMeta`), and
the HTTP basic-auth template reads “Basic auth”. CONNECTION now says how every entry signs in, in the web's words
(`signsInText`: “Signs in as mara@burrowhq.example in the browser”, “Signs in with a bearer token”, …), then the last check,
which for a login is its last Test sign-in (“Checked 2 days ago · Signed in”). A login has no Check again (`vault.check`
answers `wrong_kind` for it) and no Test sign-in on the phone (VT-D31, web only): the section says “Test the sign-in on
the web, in Settings → Vault.” Keys (Asks / Allowed, Take back, Give a key to…) and the agent screen's VAULT row work as
for every entry; creating a login and setting its password stay on the web (`secretsOnWeb`).

### AP-238 Capabilities in the demo world

`src/fixtures/capabilities.ts`, next to the handoffs (AP-185), gives “Explore the demo burrow” what the shared fixtures
leave out (they hire nobody new and have no packs, CT-124): the “Documents” pack (docx, xlsx, pdf) attached to the whole
burrow with per-agent switches that hold and readiness from core's `skillReadiness` over the seeded keys; Hazel's DM
with a `/xlsx` request, a “Learn a skill” request and Hazel's `migration-review` proposal (safe scan, Mara may decide),
whose decision re-publishes the card as `message.updated` and, when approved, adds the skill to Hazel's own pack so
`/migration-review` then sends a hint; `skills.proposal` with the body; and the fixtures' opt-in “Shop admin” login in
Mara's Vault, with keys that can be given and taken. Pippa's DM, the mocked one, is untouched; the demo world still hires
nobody with a new role.

### AP-239 Tests, the emulator run, and what the runtime must provide

Unit (`apps/mobile/src/data/*.test.ts`, `src/fixtures/capabilities.test.ts`): roles (labels and both themes' colours
for every core role, the role line, the reassign sheet's role, the DM start for the new roles and the owner's
assistant), the three keys' rows, skill rows, lock reasons and enabled skills, the `/skill` rules, the chip, the card in
each state and its dialogs, the spend line, login and basic-auth entries, and the demo world end to end through the
real client (which checks every answer against the 0.20 contract). The touch-target audit counts the Packs screen's
switch. `packages/client`: the hint in the body and on the optimistic copy.

Rendered on the emulator (`whombat-mobile` AVD, 1104 × 2466, light and dark) against the demo world through Metro: the
roster and agent screens, the Packs switches (switching one off holds), Hazel's DM (both chips, the card, Approve's
dialog, the approved card arriving live, a `/migration-review` message sent with its chip), an empty DM's suggestions
filling the composer, the Vault list and the login entry. The six new roles and the three keys were seen with a local,
uncommitted override that gave the world's agents the new roles; the locked switches and the “Decide on the web” card
are covered by unit tests only.

The runtime must provide: `agentSkills` on `packs.agent` and `packs.setSkill` for a person who may manage the
attachment; `skill` cards resolved per viewer with `canDecide`, re-published as `message.updated` on a decision;
`skillHint` stored and returned on messages; `spend.agent` for owners and members; `login` entries in `vault.list`,
`vault.get` and `vault.agentKeys`, with a login's check being its last Test sign-in.

## Agent capabilities: review fixes

The product review of the capabilities work (2026-09-28) on the web, `@whombat/client` and Android, on contracts 0.20.0
and the runtime's security fixes (Whombat `skills-library.md` SL-D40…SL-D48). Nothing here is in the mocks (B-05): the
nearest mocked pattern, tokens only, the product's quotes and middle dots. Every touched screen was shot at 1440×900 in
both themes in fixture mode with the skills world (`~/.cache/wb-tmp/cap-shots/fix/`).

### AP-240 What the review changed, and where

Must-fix M1 (composer), M2 (attaching); should-fix S3, S5–S7, S9–S17, S19 on the web, S18 on the phone; nice-to-haves 1–7,
9, 10, 13–15; “Learn this” for a team agent after SL-D40; skill proposals in Needs you. M3 (role nouns), S1 (the fixed row
a role's narrower key replaces) and S2 (“Browse the web” included with the browser) come with contracts 0.20.1's core
helpers (AP-253). S4 (Needs you) and S8 (two `docx`) are the runtime's; the web follows S4 in AP-247.

### AP-241 Attaching and importing say what happened

A role-pack suggestion whose pack isn't installed shows, to someone who can't import (`can.import` false), the hire
modal's locked note “an owner adds it” where Attach would be; “Not now” stays. When only some of its packs are locked the
note names them (“an owner adds Tester craft”) and Attach attaches the rest. Every attach and import — the suggestion,
SHIPPED's “Attach to” and Import, Configure's save — catches a refusal and shows the server's words (“Only owners import
packs.”): as a toast by the card, and as Configure's notice (the save stops there). SHIPPED's Import no longer reports
into IMPORT's problem list at the bottom of the tab.

### AP-242 SHIPPED: nothing chosen, the whole burrow last

“Attach to” starts on a disabled “Choose…” with Attach disabled until a target is picked; the agents of the pack's roles
come first, then the others, and “The whole burrow” (owners) last. A pack for the `assistant` role never offers the whole
burrow (burrow-wide packs never reach personal agents, SL-D14); under it: “Each person adds it to their own assistant,
from the assistant’s “Add the skills” card.” Packs without `roles` (a repository's own review packs) list last under their
own OTHER PACKS heading. The skills fixture world ships UI review for no role, so that heading shows.

### AP-243 Deciding a proposal

- A proposal whose scan isn't `safe` is read before it is approved: until Details was opened, Approve opens an inline
  confirm (the Vault's confirm with the warn edge) — “Approve receipt-check? The scan found this:” and each finding as
  “Sends data out · scripts/fetch_receipts.sh line 4: {message}” — with Approve and Cancel; the confirm takes the focus.
  Opening Details once counts as reading. Android keeps “Decide on the web” (AP-233).
- The toast says when the skill applies, as the phone and the docs do: “Approved receipt-check. Pippa can use it from its
  next turn.”
- “Add a note” moves the focus to the Note field it opens.
- Details is the same everywhere: a secondary button after Reject (before “Add a note”), its region above the buttons;
  PROPOSED used a link before the decision. The card's story baselines are unchanged.

### AP-244 INSTALLED at a glance

Each installed pack is one summary row — title, `name version`, “Written by Pippa · 4 skills · On the whole burrow ·
pptx off for Banjo” (who a skill is off for, “5 switches off” past three agents), the scan tag, Inspect and a ghost
**Skills** disclosure with a chevron. Open, it is a skills × agents table: a column per agent the pack is on (the head
and the name, for a burrow-wide pack every team agent: personal assistants never get it), a row per skill, a switch
per cell (`packs.setSkill`, “pptx for Banjo”). What a skill lacks and its uses show in the row when the pack is on one
agent; per agent they are on the profile. This replaces “Switch for”.

Under the intro, **Proposed · Installed · Shipped · Import** jump to their sections (a button each: it scrolls and moves
the focus to the heading; no URL hash). A skill's name is a button that opens its whole description wherever skills are
listed (the grid, SHIPPED, the profile's compact rows), so the text isn't only a hover tooltip. Uses show only once a
skill was used (“Not used yet” is gone); what a skill lacks is muted, as on the phone.

### AP-245 “Propose skills” where keys are given

Configure lists **Propose skills** after the role's rows and before the locked ones (`withProposeSkills`), for team and
personal agents (whose skills their person approves, `personalAgentMayHold`), saved with the other keys; a personal
agent's save adds it to `personalConfigureGrants`' answer. The hire modal doesn't show it: a new agent proposes nothing.
The Skills tab has a PROPOSE SKILLS section after PROPOSED: a line on what the key does and “Let {Agent} propose skills”
(the memory modal's switch, with the head) in two columns, for every agent the viewer may configure (owners: the team
agents; everyone: their own assistant); nobody else sees it. The runtime's `docs/skills.md` still says “switch it on in
the Skills tab or next to ‘Propose memory’”: the lead has the wording (“in Configure's KEYS or the Skills tab's PROPOSE
SKILLS”).

### AP-246 “Learn this” posts where the agent may propose (SL-D40)

A team agent's skill goes into every conversation it works in, so the server takes its proposal only from a
conversation every person of the burrow is in, with the agent in it. The dialog (`learnPlace`, pure):

- a personal agent keeps its DM (and a team agent in a one-person burrow, whose DM everyone is in);
- “This thread” is offered only when the message's room passes the rule for the chosen agent; otherwise a hint says why
  (“Not from this thread: not everyone in the burrow is in this room, and a skill goes wherever Sketch works.” / “…Sketch
  isn’t in this room.”);
- a web page or a file goes to the room it was opened from when it passes, else #general, else the first channel in the
  sidebar's order that does, mentioning the agent (“@Pippa Learn this as a skill: https://…”), and the app opens that
  channel;
- the dialog says where, over its buttons: “Posts in #general, mentioning Pippa: a team agent learns skills only where
  everyone in the burrow can read along.”, “Posts in this thread, mentioning Pippa.”, “Posts in your DM with Tulip.”;
  with nowhere to post Ask stays disabled and it says “Banjo learns skills only where everyone in the burrow can read
  along, and isn’t in a channel everyone is in. Add it to one in Configure.”

Membership is read from `conversations.get` (the channels' `memberIds`) against the bootstrap's people. From a room's
message the picker lists the room's agents (all agents when none is in it) and starts on the first that holds “Propose
skills” (their profiles are read for it). An agent that can't read the web (neither “Browse the web” nor “Use a web
browser”) starts on **A file**; choosing a web page shows “Banjo can’t read web pages: it needs ‘Browse the web’.” with
“Let Banjo browse the web” for whoever may configure it (a personal assistant holds no web key: “A personal assistant
doesn’t browse the web. Choose a file instead.”), and Ask stays disabled until it can. “An owner can let it propose
skills in Configure.” replaces “…in its memory settings.”

### AP-247 Skill proposals in Needs you

The runtime lists a waiting proposal in Needs you (a `question` Work item, “Pippa proposed the skill receipt-check”) and
notifies its deciders. `@whombat/client`: a `skill` card's `message.created` or `message.updated` marks the Work view
stale (`invalidateWork`), and a decision — from a frame or from this viewer (`useDecideSkillProposal`) — reads the
bootstrap again so the sidebar's Needs you count drops (`invalidateNeedsYouCount`). The count's increment stays the
notification's, as for approvals; no decrement path is added.

### AP-248 `/` in a room: one row per agent

Every skill is offered once per agent here that has it — `/docx` with the agent's head and `@Tally` (what choosing it
inserts) — including the skills of a burrow-wide pack, which were one unsendable `/docx · 5 agents` row. A `/skill` draft
that mentions nobody who has the skill isn't called an unknown command: “Mention who should use /docx: @Tally or @Quill.”
(three names at most, then “or another agent here that has it”), and nothing is sent. After the commands the skills get
their own SKILLS label; a skill row has two lines (`/name @Agent`, then its “Use when …” line at full width) and the list
widens to 640px while it holds skills.

### AP-249 The browser where its key is given

With `HostInfo.browser` not available, “Use a web browser” carries a muted line — “Off on this Whombat · see Settings →
General” (“Not running on this Whombat right now · …” when unavailable) — in the hire modal and Configure (`ToggleRow`'s
new `hint`, which describes the switch without joining its name) and under the key on the profile's KEYS (held at can or
ask). A login's **Test sign-in** is disabled up front with core's `browserStatusLine` and the reason, then “See Settings →
General.”; an `unavailable` answer reads the host again. A command in backticks in the host's reason renders as inline
code (`CodeText`) in Settings → General and the Vault. A login's “Give a key to…” marks agents without “Use a web browser”
(“Banjo · no browser key”, and beside a key holder's name), and after giving one it says “Banjo needs ‘Use a web browser’
to sign in here. Give it in Configure.” Fixture mode serves the browser off with `VITE_FIXTURE_BROWSER=off`.

### AP-250 What a role pack lacks is something to do

Under a pack's row (outside its label, so the switch's name stays the pack's), muted: in the hire modal and Configure
“Turn on “Run tools in a scratch workspace” and “Browse the web” to use all its skills.”, each key a link that scrolls to
its row, focuses its switch and highlights it (`useKeyLinks`, `ToggleRow` `id` and `highlighted`); in onboarding, which
has no keys, “Needs “Run tools in a scratch workspace”. Give Sketch this key later in Configure.” Whether Security should
default to `workspace.scratch` (AR-05) is John's to decide; it is flagged, not changed. Onboarding shows the first six
role cards (the mock's) and every picked one, the rest behind **More roles · 11**, so each picked agent's SKILLS stays near
the cards; the fixture world lists six, so the mocked step is unchanged.

### AP-251 Words after saving and hiring

- Configure's toast names the packs its save attached and took off: “Updated Bolt’s keys and attached Security craft.”,
  “Updated Pippa’s keys, attached Documents and took off Researcher craft.”
- A member's hire toast names the role packs only an owner adds (locked, so never sent): “Bolt joined the burrow. An owner
  can add Security craft in Settings → Skills & packs.” (`packSkippedReason`, with the server's `packsSkipped`).
- The empty working directory no longer says “scratch” (the scratch-workspace key's word): Configure “Empty: the
  burrow’s default working directory.”; Software Dev, the burrow's default itself, “Empty: a temporary folder for each
  turn, removed afterwards.”
- Configure's “Read #billing-v2 and #general” follows the key's own order, then the agent's channels, as the hire modal
  and the profile say it.
- Spend's tables read **COST (ESTIMATE)** over plain values (“$11.66”); the tiles keep core's “about”. A member without a
  personal assistant reads “Your spend: turns agents did for you.”
- The profile's section is headed SKILLS.

### AP-252 Android

A burrow-wide pack's skill switches get a visible caption, “Switches change Hazel only.” (`skillSwitchCaption`), and its
“Turn off for every agent” moves into the pack's detail (shown once the pack is opened); an agent's own pack keeps its
Turn on/off in view. A rejected proposal is muted (`neutral`), as on the web; readiness was already muted mono, and the web
now matches it. The approve dialog already said “from its next turn”.

### AP-253 On contracts 0.20.1: role nouns, rows by role, included keys

- **M3**: core's `dmIntro` and `rolePackSuggestionText` use `ROLE_NOUNS` (“Bolt is a security agent.”), on the web and the
  phone without a change here; the hire modal's duties list is labelled `roleDutiesLabel` (“What Bolt does”).
- **S1**, nice-to-have 8: `hireKeyOptions(role)` shows a Tester's and a Security agent's “Run tests” in place of “Run tests
  and CI”, puts a role's extra rows before the locked Merge and Deploy rows and locks Deploy “not for this role” where
  the role's defaults deny it. Configure's Propose skills row goes before the first capped row (a lock with a tier), not
  before an included one. Step 2 fits 900px for the Tester (835px); a Security hire whose pack lacks two keys is 918px
  with its two-line “Turn on …” line, so its Hire button sits just below the fold. The step now opens at its top (it kept the role grid's
  scroll, which is why it opened “slightly scrolled”) and the modal scrolls, as for any tall step.
- **S2**: a row a bundle key brings in follows the switches as they stand (`liveKeyRows`): `hireKeyOptions` marks it from
  the role's defaults, but the person may switch the bundle off, so the web computes `impliedBy` from the switches.
  While “Use a web browser” is on, “Browse the web” shows on and locked, “included with the browser” (`ToggleRow`
  `included`: the switch on and disabled, the label in ink), and is never sent — it grants nothing of its own; once the
  browser is off it is an ordinary row, off by default (`ownKeyOptions`). Configure seeds and saves every row by what the
  agent holds itself. The profile lists `impliedKeyRows` after its last ✓ row: “Browse the web” with the mono note “with
  the browser”.

### AP-254 Visual checks

`pnpm visual` passes on contracts 0.20.1 (229 tests): every mock comparison is unchanged; the hire modal's baselines use
the Designer, whose rows 0.20.1 doesn't change. Retaken, as intended: Settings → Software Dev (both GitHub states, both
themes) for the working directory's reworded hint (AP-251), and Settings → Spend for COST (ESTIMATE) with plain values;
both were older than the Spend tab and the “Skills & packs” tab name, and passed only within their tolerance. The skills
world and the browser-off host are opt-in (`VITE_FIXTURE_SKILLS=1`, `VITE_FIXTURE_BROWSER=off`), so the review's screens
were checked by hand at 1440×900 in both themes (`~/.cache/wb-tmp/cap-shots/fix/`, the harness `shoot.mjs` with
`scenes.mjs`): the Skills tab (top, PROPOSED's confirm, PROPOSE SKILLS, INSTALLED closed and open, SHIPPED, OTHER PACKS),
the skill card (waiting, the approve confirm, the note), the composer in a room (`/`, `/doc`, the unaddressed notice), the
hire modal (Security with its links, Tester with “included with the browser”, the browser off), Configure (Pippa, the
saved toast), onboarding step 3, “Learn this” (#general, nowhere to post, a room not everyone is in, a thread in
#general), the profile (SKILLS, a Tester's implied and browser-off rows), Settings → General with the browser off, a
login in the Vault with the browser off and a key given, Spend and Software Dev. Android was not rendered on the emulator
this time: its changes (a caption, a button that moves into the open pack, a card tone) are covered by unit tests.

## Robust updates: clients tolerate skew, owners are told (UP-B3, UP-E4, UP-F1)

The clients' part of the robust-updates workstream (`appliance/docs/decisions/updates.md` UP-B3, UP-E4, UP-F1;
contracts 0.22.0 CT-135…CT-142), after the incident of 2026-09-28, when the hosted web had to be rolled back by hand
because older clients refused newer runtimes' answers (control HZ-28). Unmocked screens follow the nearest mocked
pattern (B-05): tokens only, copy plain and calm, with the product's quotes and middle dots.

### AP-255 Tolerant decoding at every parse point

Every answer and event a client reads goes through contracts' `decodeTolerant` (`packages/client/src/tolerant.ts`,
`decodeForUi`). A runtime one or two releases newer can send a card kind, Work item kind, role, update state or event
type this app doesn't know; only what carries it is left out, never the whole screen:

- **The typed HTTP client** (every `api` call on both transports) decoded responses only in dev; production used the
  raw JSON. Now it decodes tolerantly everywhere, so production strips unknown members and fills defaults exactly as
  dev does. An answer that still doesn't match (a wrong type, a missing member) throws `ContractError` in dev
  (`validateResponses`) and is used as it came in production, as before, with `onContractDrift` told. Parsing every
  answer in the jitless hosted build costs a few milliseconds on the largest lists; we accept that.
- **Session-native ops** (`sessionOps`, pack imports, Test sign-in) parsed strictly, so a new `UpdateJournalState` made
  This Whombat “Couldn’t load this”. They decode tolerantly and throw only what tolerance can't repair.
- **Realtime**, over the session and the legacy socket: an event type only a newer runtime sends is skipped quietly (no
  `bad_frame`); on the legacy socket its `seq` still counts, so it isn't taken for a gap. A frame op the socket doesn't
  know is ignored. A known event carrying an unknown member is decoded like an answer.
- **Placeholders.** A message's card of an unknown kind becomes `UNSUPPORTED_CARD`, a neutral pill “This needs a newer
  version of the app.”. It is a valid card, so every renderer on the web and on the phone shows it without knowing
  about skew. Items left out of an `items` list (Work sections) are counted on the object holding the list
  (`unsupportedItems`, an own enumerable member so spreads and the query cache's structural sharing keep it). The Work
  view shows one placeholder row per item, counts it in the section label and keeps the rest. Everything else left out
  (an agent with an unknown role, an activity row of an unknown kind) is simply not shown: lists keep the rest.

Tests feed 0.22-era schemas answers from a newer runtime and an older one (`tolerant.test.ts`, `skew.test.ts`, the
legacy socket in `realtime.test.ts`, the web's card and Work view tests, Android's `workSections`).

*Amended by AP-266*: security views are decoded strictly, and nothing is left out silently any more — a list that
left items out is counted in the app's notice.

### AP-256 The runtime's level and features; the skew banner; features explained

`SessionInfo.runtime` carries `welcome.runtime` (`{version, apiLevel, features}`, CT-136). `runtimeView` and
`sessionRuntime` turn it into what screens ask (`@whombat/client/session`; `useSessionRuntime` in
`@whombat/client/react`):

- a managed runtime that says nothing (contracts ≤ 0.21: every box in the field) is level 21 with `LEGACY_FEATURES`;
- the legacy self-hosted server (HTTP transport), fixtures and tests have every feature (`FULL_RUNTIME`): the server
  ships with the app it serves;
- while a session reconnects, the last welcome still counts; the objects are stable for `useSyncExternalStore`.

**The window** is `apiLevelWindow(SESSION_API_LEVEL)`, from −2 to +1 (UP-B3a). Below it the web shows the strip
“This Whombat needs an update to work with this version of the app.”. Above it the web shows “Reload to get the newest
version of the app.” with Reload, and the phone “Update Whombat from the app store.” with the store (AP-261). Within
the window nothing is shown. This is the connection strip's quiet banner in its warn tone, not a gate: the app keeps
working with tolerant decoding.

**Features.** `FeatureGate` and `useFeature` on the web (`app/runtime.tsx`) explain a missing feature where a whole
screen depends on it (“Update your Whombat to use Spend.”, `featureNeedsUpdate`), and hide an entry point that is only
a part of a screen. None of these call an op the runtime lacks:

| Feature | Where |
|---|---|
| `spend` | Settings → Spend explains; the agent profile's week line is hidden |
| `vault`, `packs`, `feedback` | their Settings tabs explain |
| `skills` | Skills & packs: PROPOSED, PROPOSE SKILLS and “Learn this” explain or are hidden; the hire modal's “Propose skills” and scratch-workspace keys are hidden |
| `roles` | the hire modal offers the roles before the six (`CAPABILITY_ROLES` left out) and says “Update your Whombat to use every role.” |
| `browser` | the hire modal's “Use a web browser” key is hidden |
| `vault.login` | Add to Vault offers no website login |
| `delegation` | a plan's “Add a step” has no Brief (no handoff) |
| `work` | the Work view explains |
| `backup.destinations` | backup setup offers the REST server only (AP-260) |

Every box in the field has the legacy features, so today only `backup.destinations` hides anything. The mechanism is
for the next minor's features.

### AP-257 CONTROL messages from a newer runtime

`decodeControl` (`session/control-decode.ts`) runs where the session read `decodeApplianceMessage`. A known message
that fails its schema gets a second, tolerant try with safe meanings for required enums:

- an `error` (or a rejected `outcome`) with a `SessionErrorCode` this client doesn't know becomes `internal`, with its
  message, and the code it came with is kept as `details.code` when the details name none. The request fails
  generically (`OperationError.code` is the new code, the typed client's `ApiError` is `unknown`); the connection stays
  up;
- a `goaway` for an unknown reason is a planned reconnect (`overload`); a `snapshot_required` for an unknown reason is
  a refetch (`overflow`); a `revoked` of an unknown scope is the whole account (the broadest);
- anything else goes through `decodeTolerant`.

What still doesn't decode is malformed and ends the connection, as before, and the 64 KiB limit is checked first.
The fake appliance's `sendsNewer` option and `protocolCode` answers exercise this through a real session.

### AP-258 Owners are told about updates

This Whombat's UPDATES (web `ManagedTabs`, Android `WhombatScreen`) is built by `updateView`
(`@whombat/client/managed`) from `appliance.status`:

- **Waiting** (`update.waiting`, CT-138): the state's row, then why the update waits, with what holds it and since
  when:
  - “It waits for work in progress to finish.” with “2 runs in progress · Waiting since 11:02”;
  - “It needs a backup destination first: it changes the database in a way that can’t be undone. Set one up and it
    goes ahead.”, with **Set up backups** for owners, which opens the destination form under BACKUPS;
  - the maintenance window, a hold (“Whombat is holding it back for now. Nothing to do on your side.”), the lock, the
    signed metadata.
  Blocker kinds this app doesn't know read as their name.
- **Failed, rolled back, quarantined**: contracts' `describeUpdateFailure` (the 2026-09-28 failure reads “pve-20260928.5
  couldn’t start on this Whombat’s database: it reads schema 49 only and the database is at 48. Nothing was
  changed.”), then “Your Whombat is still on …”. When the text doesn't already say what happened, “Nothing changed.” is
  added. Runtimes without `failureDetail` get the last two sentences only.
- **ForwardRepairRequired**: “Updated · can’t go back to the previous version”, with the detail or a plain sentence that
  the fixed version installs as soon as there is one. It is warn, not bad.
- **After an update**: “Updated to <release> on 28 September 2026”, with control's summary of the release notes under
  it (`control.releaseSummary`, `GET /v1/releases/:release/summary`, session auth). A 404 or an empty summary shows
  nothing.
- **Refresh**: while an update moves (Assigned … Verifying) the status is asked again every 5 s; while one waits,
  every 15 s. A failed ask keeps what is shown.

Until a destination exists, BACKUPS also says “Updates that change the database in a breaking way wait until a backup
exists.” (UP-F1). The fake world has `update`, `releaseSummary` and `runtime` faults; the managed specs
(`updates.spec.ts`) cover waiting → moving → updated without a reload, failure, forward repair and the backup wait.

### AP-259 Build numbers from the version; `version.json`

The hosted web's build number was the commit count at the tag (743 at 0.11.1), and Android's `versionCode` was a
fixed 1, so any Android client floor above 1 would have locked out every build. Both now come from the release
version (the root `package.json`, which `app-vX.Y.Z` tags): `major × 1 000 000 + minor × 1 000 + patch`
(`buildNumberOfVersion`), so 0.12.0 is 12000.

- It only grows with the version and is above every commit-count number the hosted web used before, so a floor set
  on either scheme stays met.
- Building a tag always gives the same number. The deploy needs nothing: `apps/web/vite.config.ts` computes it.
  `VITE_WHOMBAT_BUILD_NUMBER` still overrides it (digits only), but control's `deploy.sh web` doesn't set it
  (orchestrator, with agent A).
- It needs no git history, so the public mirror and a source tarball build the same number. A commit count there
  would be 0, which a floor refuses.
- `VITE_WHOMBAT_BUILD` defaults to `<version>+<short commit>`. Android's `hello.client.build` reads
  “android 0.12.0 (12000)”.
- Android: `app.config.cjs` takes `version` and `versionCode` (and iOS `buildNumber`) from the root version, and
  `app-config.test.ts` checks them against `buildNumberOfVersion`. EAS `autoIncrement` is off for production (it
  can't write a computed config and would fight the derivation).
- `release/ship` must not set an Android floor above the Android builds that exist. Until a store build numbered this
  way is out, that means none.

Every web build writes **`version.json`** at the web root:
`{version, build, buildNumber, apiLevel, contracts}`. For example
`{"version":"0.12.0","build":"0.12.0+1a2b3c4","buildNumber":12000,"apiLevel":22,"contracts":"0.22.0"}`.

- `buildNumber` is the same value the build's `hello` carries.
- `apiLevel` is `SESSION_API_LEVEL` of the vendored `@whombat/protocol` (21 for contracts before 0.22).
- `contracts` is the vendored version.
- `vite dev` answers it too. The static host serves it with `no-cache`.
- `promote-prod` reads it for the web floor (UP-B3d) and `deploy.sh` for the fleet window (UP-B4). Everything in it
  is fixed at build time.

### AP-260 Protect your Whombat: backup destinations after the claim and in Settings

The claim now goes claim → **Protect your Whombat** → recovery kit (web `/appliances/<device>/protect`, Android the
`protect` route). The kicker is “CLAIM · STEP 1/2/3 OF 3”. The destination comes before the kit so the kit carries its
recovery material. The step is skippable (“Skip for now”). A Whombat that has a destination already, or whose status
can't be read, goes straight to the kit, and only owners see it. The same form is Settings → This Whombat → BACKUPS'
“Set up backups” (web `BackupDestinationForm`, Android `BackupDestination.tsx`). The model and the words are
`@whombat/client/managed`'s `backup-setup.ts`.

- **A storage bucket** (S3-compatible): endpoint (a bare host gets `https://`; credentials in it are refused), bucket,
  optional folder → `s3:<endpoint>/<bucket>[/<folder>]`, with `s3AccessKeyId`, `s3SecretAccessKey` and an optional
  `s3Region`. The hint recommends a bucket-only key and versioning or object lock.
- **A NAS or server (SFTP)**: server, optional port, folder, user → `sftp:<host>:<path>`, or restic's URL form with a
  port (`sftp://host:2222//path`), and `sftpUser`. This Whombat's key (`backup.sshPublicKey`, made on first ask) is
  shown to add to `authorized_keys`, with its fingerprint. The web copies it; the phone shares it. The server's host
  key is optional: pasted (a known_hosts line's host name is dropped), or trusted on first use. The fingerprint that
  comes back is shown to compare (“Compare this with your server’s host key fingerprint: SHA256:…”).
- **A restic REST server**: as before (`rest:https://…`, optional user and password).
- **A disk on this Whombat**: `disk:` (a disk labelled WHOMBAT-BACKUP).
- Joining a replaced Whombat's backups (`adoptPassword`) stays available for every kind; otherwise `allowInit`.

Runtimes without `backup.destinations` get the REST server only, with “Update your Whombat to back up to a bucket, a
NAS or a disk.”. After saving, the owner sees whether old backups are safe from this box and the host key to compare,
then “Your recovery kit now needs the backup password: save a new kit.” in Settings, or “Continue to the recovery
kit” in the claim. Secrets travel only in the `secret` op and the form clears after sending. The claim's step runs
outside the app's providers, so the key is copied without a toast. Not in the mocks: onboarding's choice cards (the
Billing page's) and the settings' fields.

### AP-261 Android: the store, the skew notice, `versionCode`

- The `client_too_old` and below-floor gates offer **Open the app store** (the Play Store listing, `STORE_URL`) above
  “Back to your Whombats”. Before, only “Back” was offered.
- The screen strip shows the skew (AP-256): “This Whombat needs an update to work with this version of the app.”, or
  “Update Whombat from the app store.” with the store as its action. Connection trouble and passing notes come first,
  the licence and kit strips after it.
- `versionCode` comes from the version (AP-259). It was 1.

### AP-262 The Feedback widget reads a newer server tolerantly

The frame's hand-written config check refused the whole widget for a report type, theme, position, launcher or
attachment type a newer server sends. Now:

- report and attachment types it doesn't know are left out (no known report type left: not available);
- an unknown theme is `auto`, position `bottom-right`, launcher `custom` (the widget adds no button the site didn't
  ask for) and contact field `optional`.

A drop-mode card is still verified first; only its presentation fields are read this way. The embed has no session
API level: it talks to control's drop or a self-hosted server's embed API.

### AP-263 On contracts 0.22.0

Contracts 0.20.2 → 0.22.0 (the AP-02 procedure; a clean clone passes `pnpm install --frozen-lockfile` and
`contracts:verify`). The recovery-vector test reads the 0.22.0 schema tarball. Nothing else needed a change: 0.20.3's
and 0.21.0's changes are server-side or additive for the clients.

## Robust updates: the operator panel (AP-280…)

Moved to control with the operator panel (`docs/decisions/admin.md`, same ids; Whombat `docs/decisions/public-copy.md` PUB-13).

## Robust updates: review fixes

The first security review of the robust-updates work (orchestrator, 2026-09-28) and contracts 0.22.1.

### AP-264 Contracts 0.22.1: custody rollbacks on the release page

Contracts 0.22.0 → 0.22.1 (the AP-02 procedure) brings `ReleaseRecord.allowDowngradeFrom`: the releases a custody
rollback may replace. Control offers the older release to devices on those ids, and the box still checks the
TUF-signed permission. The panel's release page lists it under Versions when present: “Custody rollback: may replace
pve-20260929.2, pve-20260929.3 (the box checks the signed permission).”

### AP-265 The recovery kit carries every destination's credentials (kit version 3)

The kit's backup section wrote only the REST server's user and password. An S3 or SFTP destination's kit could not
reach its repository from another machine, which the appliance's own kit rule requires
(`backup/pkg/kit` `Material.Validate`).

- **Kit version 3** adds whatever the destination kind needs:
  - `S3 access key`, `S3 secret key`, `S3 region`;
  - `SFTP user`, `SFTP host key`, and `SFTP private key:` followed by the key's own PEM/OpenSSH block.
  - The whole section also goes in as one line of JSON after “Backup section for whombat-backup (save the next line
    as kit.json):”, which is what `whombat-backup destination adopt -kit` and `quarantine apply -kit` read
    (restore.md). The checksum covers all of it.
  - Readers take kits of every version; version 3 reads like 2 (the identity, the checksum).
- **Read strictly.** `backup.recoveryMaterial` is decoded with `KitMaterial`: the contract's material (with `head`,
  the newest checkpoint, since contracts 0.22.3; the app's own extension until then), and nothing else. `head` goes
  into the kit's JSON section, which `-kit` uses to spot a withheld newer checkpoint.
  - A member this app doesn't know (a newer appliance's credential) would be missing from the kit. So the section
    isn't written at all: the kit says “Backups: not in this kit. This version of the app can’t write all of your
    Whombat’s backup details into the kit, so the kit leaves them out. Update the app, then save a new kit.”, and so
    does the kit screen on the web and on the phone.
  - A section without what its kind needs is left out the same way (“incomplete”), and so is one that couldn't be
    fetched (“unreachable”). Before, the kit then silently said none was set up.
- The kit screen waits for the section before offering the download. The recovery key is never held back: a kit
  without its backup section still lets the owner back in.
- Tests: one per destination kind (REST, S3, SFTP, disk) with the JSON read back, the gaps, and the managed spec
  (`updates.spec.ts`).

### AP-266 Security views decode strictly; nothing is left out silently (amends AP-255, updates.md UP-B3b)

Tolerant decoding can hide what matters. `endpoints.list` would drop a device whose platform or revocation state this
app doesn't know, so a device that still has access vanished from the owner's Devices list. A pack tool approved at an
unknown tier had its `approval` nulled, which the panel reads as “not approved” and shows as off.

- **Strict** (`packages/client/src/strict.ts`; no contracts change): a mismatch is a `NeedsNewerAppError` (a
  `ContractError`), thrown in production too, never repaired and never passed as it came.
  - Session ops: endpoints, admins (owners), enrollment (claim, pairing, invites, re-enrollment), recovery and the
    kit's backup material.
  - API endpoints: approvals, every `packs.*` answer (attachments carry their tools' approvals and permissions),
    members and their roles, API tokens, an agent's and an automation's keys, Vault keys. Push registrations
    (`devices.*`) grant no access and stay tolerant.
- **The update path on screen.** Devices and Owners (web and phone), Skills & packs, a pack, Members, an agent's
  profile, an automation and an approval say “This needs a newer version of the app. Reload to get the newest
  version.” with Reload. On the phone they say “… Update Whombat from the app store.” with the store. None of these
  screens is ever shown with part of its content left out.
- **Everywhere else**, every answer that left list items out counts them in `leftOut`: per source (an endpoint with
  its parameters, a session op), latest answer only.
  - The app's strip says “1 item needs a newer version of the app.” (“3 items need …”) with Reload, and the phone's
    strip says it with the store. When a strict answer didn't match, it says “Part of this page needs a newer version
    of the app.”
  - The strip goes when the answers read whole again, and switching Whombat resets it.
  - The Work view's placeholder rows and the placeholder card stay as they were; they are shown in place and not
    counted twice.
- Tests: (a) and (b) in `strict.test.ts`, the web's Skills & packs with an unknown tier, the managed spec with a
  device only a newer app knows.

### AP-267 Retiring a reinstalled Whombat's old record: what to check first

The panel's “Reinstalled — retire the old record” confirm now shows:

- the old record's last seen time next to the first refused attempt;
- a warning when it was seen within a day before that attempt: “The old record was seen 20 minutes before the first
  refused attempt. A Whombat that was only offline looks the same: make sure it isn’t still running before you
  retire it.”;
- for a claimed record, whose it is: “This Whombat belongs to Northwind Studio; retiring it stops it until it’s
  reinstalled. We’ll tell Northwind Studio’s owners by email.” Control mails them and writes their audit log (CL-91).

Control sends `existingLastSeenAt` and `existingOrg` beyond the tolerant `PendingRegistration`. The panel reads them
with a local extension (`RegistrationView`, `registrationsEndpoint`); `existingOrg` may be an id, or `{org, name}`.
The organization's name is looked up when only the id comes.

### AP-268 Backup setup as the backup service answers it (BK-21, BK-25; contracts 0.22.3)

Checked with agent B once the backup service was done:

- **The host key fingerprint** the service pinned for an SFTP destination (`hostKeyFingerprint`) is shown to compare
  after saving, as before (AP-260).
- **The box's SSH key now comes first** among the SFTP fields: it is fetched as soon as SFTP is chosen, so the owner
  can add it to `authorized_keys` before Save makes the service sign in.
- **A disk is prepared** when empty: `disk:` goes with `allowInit`, unless the owner joins a replaced Whombat's
  backups with its password.
- **SFTP forms** (CT-142 as documented in 0.22.3): the user always goes in `sftpUser`. The repository is
  `sftp://host:port//path` for a port other than 22, and `sftp:host:/path` otherwise, port 22 included.
- **Refusals in the service's words.** The service answers a destination that fails with `502 destination_failed`
  and one sentence for the owner, secrets redacted (BK-21): the bucket refused the key, the host key doesn't match,
  the disk isn't attached, and so on. Bad input is `400 bad_request`. The runtime passes both on as
  `backup_destination_failed` with that sentence (Whombat MD-17). The app now shows the sentence (`backupErrorText`)
  for those codes, and its own words only for other codes or an empty message.

Contracts 0.22.1 → 0.22.3 in their own commit (the AP-02 procedure).

### AP-269 The operator panel after the operations review (contracts 0.22.4)

The operations review asked whether a person on call can read and stop a bad rollout from the panel alone
(assignment §7). Contracts 0.22.4 (CT-147) are vendored in their own commit. `@whombat/release` is now declared at the
root (AP-02): the panel reads `isRetryableUpdateFailure` from it.

- **Quarantine** also says: “Whombats that already run it keep running it, and get the next release you roll out.”
  Control lets them take a fix-forward.
- **Failures the box retries by itself** (`RETRYABLE_UPDATE_FAILURES`: no space, not assigned or staged yet, the
  boundary lost, a stale or missing checkpoint, a deferred activation) are no verdict on the release.
  - The rollout's Whombats table and the fleet list show “Can’t install yet” (warn) and “Can’t install yet: not
    enough free space — retries by itself”. The journal state stays in the badge's title.
  - They don't count in the Failed group.
- **Retry this Whombat** (`operator.retryDevice`, `fleet.write`, a typed reason code) is offered on a Whombat control
  holds `failed_before`. The dialog says what it does and when to do it: after the cause was fixed on the box.
  `nothing_to_retry` is worded.
  - A Whombat whose own journal state is Quarantined refused the release for good, and control's Retry wouldn't
    change that. It gets no button and the sentence “It refused this release for good and won’t retry it: roll out a
    fixed release.”
- **Waiting** (`RolloutDevice.waiting`, the status's `update.waiting`):
  - “Waiting: needs a backup destination” (checkpoint), “Waiting: work is running” (boundary), then the maintenance
    window, held back, another update step, the signed update details. Since when is in the title, or relative in
    the fleet.
  - The fleet's Health column counts `backup: unconfigured` as a problem: “No backup destination”. The Whombats tile
    adds “N without a backup destination” (`devices.backupUnconfigured`).
- **Alerts**: `rollout_stalled` reads “Rollout not moving” and links its rollout. When control has nowhere to mail
  alerts (`alerts.mail === false`), the Alerts page says “Alert mail: off.” and the fleet's alert tile adds
  “mail off”.
- **Holds**: `not_older` reads “Runs something newer. To take it back, the rollback release must name <the release it
  runs> in --allow-downgrade-from.” The release comes from the fleet list.
- **The manager's `Quarantined` journal state** reads “Refused (won’t retry)”, with `Quarantined` underneath in mono,
  so it isn't confused with a quarantined release.
- **Resume** adds: “Whombats that failed stay held: use ‘Retry this Whombat’ on each once its cause is fixed. A
  Whombat whose health got worse pauses it again after two more down reports.”
- **A stopped rollout** says how to continue: “To continue, roll out a fixed release with `release/ship promote-prod
  <id>`.”
- **Without `rollouts.emergency_stop`** the emergency-stop button is hidden and the banner says: “Ask an operator with
  rollouts.emergency_stop, or run `deploy.sh emergency-stop on`” (`off` while it's on).

The fake operator API has a stalled-rollout alert, the mail flag, backup counts, a waiting and a no-space Whombat in
the staged rollout, and `retryDevice`. Screens checked in both themes (`visual/shots.ts`: the paused, stopped and
staged rollouts, the resume and quarantine confirms, the fleet).

### AP-290 An application code keeps the server's words

John, 2026-09-29: creating a feedback integration on production said only “Request failed with status 403”. The
runtime refused it with a reason (the drop is unavailable: control's feedback drop is switched off), but the secure
session puts the application's own code in `error.code` (AP-19, here `managed.feedback_intake`), core's
`ApiErrorBody` only accepts its closed `ErrorCode` list, and `toApiError` then dropped the whole body.

- `toApiError` falls back to a loose read of the same shape (`error.code` any string, a non-empty `message`, the
  optional `fields` and `details`): the `ApiError` carries the server's message, fields and details, with `code:
  'unknown'` as before (the application code stays readable in the body and `details.code`, `appErrorOf`).
- A body without an `error.message` still reads “Request failed with status N”.
- The fake appliance refuses `feedback.createIntegration` without the drop like the runtime does (FD-25), with the
  runtime's `FEEDBACK_DROP_TEXT.unsupported` when the drop is unsupported.

### AP-291 Sign-in links open the Android app by themselves

John, 2026-09-29: a sign-in link opened the browser, not the app, until Android's Open by default had the UI's domain
added by hand. The app's intent filters ask Android to verify the hosted UI's links (`autoVerify`), but the UI served
no `/.well-known/assetlinks.json`, and the APKs were signed with React Native's debug key.

- **A release key.** RSA 4096, PKCS12, alias `whombat`, valid to 2054, SHA-256
  `85:C4:44:97:C5:F5:0E:D1:DF:5E:A9:35:C9:E5:45:4C:06:7B:9E:1B:18:79:21:AB:F2:EA:25:CB:8F:60:66:D3`. It lives off the
  repo on the build workstation (`~/.config/whombat/android/whombat-release.p12`, its password in
  `whombat-release.pass`, both 0600). Losing it means every installed app is reinstalled once (Android refuses an
  update signed with another key) and the fingerprint here changes. It needs an offline copy like the prod secrets.
- **Signing.** `android:apk --variant release` signs the APK with it (`apksigner`, after Gradle) when
  `WHOMBAT_ANDROID_KEYSTORE` and `WHOMBAT_ANDROID_KEYSTORE_PASS_FILE` are set; otherwise it stays on the debug key and
  says so. Gradle's own signing config is untouched, so `expo prebuild --clean` keeps working.
- **`apps/web/public/.well-known/assetlinks.json`** names `com.whombat.mobile` with the release key only. The debug
  key is public: vouching for it would let any app signed with it take a magic link, and the link is the sign-in.
  The same file serves app.whombat.com and dev.whombat.com (one web build), so a prod and a dev APK verify on their
  own UI. A Play Store release later adds Play App Signing's fingerprint next to this one.
- A test checks the file names the app's package, well-formed fingerprints and never the debug key.
- Android verifies at install: an app installed before the file was served needs a reinstall (or
  `adb shell pm verify-app-links --re-verify com.whombat.mobile`). Moving from a debug-signed APK needs an uninstall
  first anyway.
- Found on the way: `android:apk` regenerated `android/` when the `EXPO_PUBLIC_*` values or `app.config.cjs`
  changed, not when the release version did, so a 0.12.2 build kept 0.12.1's versionName and versionCode. The
  version is part of the stamp now.

## Vault SSH keys (AP-598…AP-606)

John, 2026-10-01: SSH private keys in the Vault, one key for several servers, “implement your suggestion fully”. The
spec is Whombat `docs/decisions/vault.md` § “SSH keys” (VT-S01…VT-S15; VT-S13 is the UI); the shapes are contracts
0.32.0 (CT-199…CT-206, vendored in `4ed5500`). Not mocked (B-05): every screen below is the existing Vault's language.

### AP-598 Add to Vault: the SSH key

- `useVaultWrite` takes the eight SSH writes (`generateSshKey`, `replaceSshKey`, `addSshServer`, `updateSshServer`,
  `removeSshServer`, `checkSshServer`, `trustSshHostKey`, `setKeyServers`): each answers the entry, which goes into its
  `vault.get` at once as for every Vault write (AP-110). No app-side session op: `vault.replaceSshKey` is a secret op
  from the protocol's list.
- The **SSH key** tile (core's `VAULT_TEMPLATE_DEFS.ssh`, in core's order before “Secret for a pack”) shows only when
  the Whombat advertises `vault.ssh` (as Login with `vault.login`, AP-256); fixtures and tests have every feature.
- The form: **Name**, “What should agents know?”, **Key** — a segmented control “Generate a new key” (the default,
  with core's `generateHint`) / “Use my own key” (a mono **Private key** textarea, write-only like a secret, and
  **Passphrase (if it has one)** as a password input with `passphraseHint`). No address, sign-in or secret: the body is
  `{name, description, kind: 'ssh', sshKey}`, checked with the contract's own `CreateVaultEntryBody` before sending, so
  core's `inspectVaultSshPrivateKey` sentences (“That’s the public key. …”) show under Private key without a round trip;
  the server's parser problems (`sshKey.privateKey`, `sshKey.passphrase`, or `privateKey`/`passphrase` on Replace)
  land under the same fields.
- Saving does **not** check (`vault.check` is `wrong_kind` on an `ssh` entry; its servers are checked one by one): the
  toast is “Added “Deploy key” to your Vault.” and the entry opens on its PUBLIC KEY, with “No servers yet. Add the
  servers this key signs in to.” under SERVERS.

### AP-599 PUBLIC KEY, and a new key

- An `ssh` entry has no SECRET and no CONNECTION. Its blocks: WHAT SHOULD AGENTS KNOW? (Edit changes name and note
  only), **PUBLIC KEY**, **SERVERS**, AGENTS WITH A KEY, RECENT USE, Remove from Vault.
- PUBLIC KEY: core's `authorizedKeysHint` with a **Copy** pill (the Feedback snippets' pill; toast “Line copied. Add it
  to ~/.ssh/authorized_keys on every server.”), the line from core's `vaultSshAuthorizedKeysLine` (`restrict <key>
  whombat-<entry key>`) as a code block in the Feedback snippets' `--code` colors, then the fingerprint in mono and
  “ED25519 · made by Whombat · added 5 days ago” (“your own key”, “replaced …” after a new key).
- **Generate a new key** opens the take-over dialog (`ConfirmDialog`, AP-472): kicker SSH KEY, “Generate a new key for
  “Deploy key”?”, core's `replaceWarning` (“The old key stops working on every server at once. The servers and their
  host keys stay.”), primary “Generate a new key”. **Replace with my own key** opens the same dialog's language with
  the import fields in it (“Replace the key of “Deploy key”?”, the warning on sf2, Private key, Passphrase, “Replace
  the key”). The key and passphrase live in the dialog's own state and go with it. Both toasts say to add the new line
  to every server.

### AP-600 SERVERS and the trust card

- A row per server (`.server`): status dot (core's check status: signed in `ok`, waiting for its first trust `mut`,
  everything else `bad`, labelled), the name in mono semibold (what agents call it), `user@host:port` (core's
  `vaultSshServerTarget`) and core's `vaultSshServerCheckLine` (bad when failing, `aria-live`); **Check**, **Edit**,
  **Remove** on the row, each labelled with the server (“Check web-1”). Remove asks inline (core's `removeServer`), as
  the home network list does.
- **Add server** / **Edit server**: a 560px modal in Add to Vault's language, kicker the key's name. Name (mono,
  core's `serverNameHint`) and Username side by side, then Host and a narrow Port (22 by default; empty means 22).
  Host's hint: “Servers on the internet: port 22. On your network: 192.168.1.0/24 · ports 80, 8123.” — the runtime may
  allow more SSH ports (`WHOMBAT_VAULT_SSH_PORTS`), and a refusal then says exactly why, under Host. The form checks
  with the contract's `AddVaultSshServerBody` first (core's field sentences); `server_name_taken` shows under Name,
  `address_not_allowed` under Host. Edit sends only what changed and shows core's `hostChangeNote` while the host or
  port differs.
- **Adding checks at once** (like Add to Vault, AP-112): `addSshServer`, then `checkSshServer`, so the host key is
  there to trust when the modal closes; the toast says the result (“Added web-2. Host key not confirmed yet”).
- **The trust card** under a row whose `seenHostKey` is set: core's `vaultSshTrustCopy` in parts — **Is this your
  server?**, the fingerprint and type in mono, “Compare it with” and the `ssh-keygen -lf …` command as code, “on the
  server.” — and the primary **Trust this server**, which sends the fingerprint shown on the card. On the notice's warn
  edge for a first trust; on the bad edge for a changed key (`hostKey` set too), with “Trusted until now: SHA256:…
  (ED25519)” under it, while the row's check line says core's changed-key sentence in bad. A `host_key_mismatch`
  answer shows the server's message and refetches the entry, so the card shows the key to compare now. The toast says
  the sign-in that follows (“Trusted staging. Signed in as deploy”).

### AP-601 Keys cover servers

- Each key row of an `ssh` entry shows what it covers in mono under the agent's name (core's `vaultKeyServersText`:
  “All servers”, “web-1, staging”) and a quiet **Servers** button (labelled “Servers: Pippa”) that opens the chooser
  under the row: a fieldset “Servers Pippa’s key covers” with an **All servers** checkbox (servers added later
  included) and a checkbox per server, Save / Cancel. Save sends `vault.setKeyServers` (`null` for All servers). None
  chosen is refused in place with the contract's sentence (“Choose at least one server, or All servers.”).
- “Give a key to…” gets the same chooser behind “Servers · All servers”; Done keeps the choice for the key about to be
  given, sent as `giveKey.servers` only when it isn't All servers (absent = All, CT-200). Without servers there is no
  chooser: a key then covers the servers added later.

### AP-602 The agent profile's VAULT

A key to an SSH key reads its tier and servers: “Asks · staging”, “Allowed · All servers” (`VaultAgentKey.serverNames`).
The tier's mono text may wrap now that it can be long.

### AP-603 The `vault_use` approval and the audit log for an SSH key

- A pass covers the servers the asking agent's key covers (VT-S07), and the approval itself names no server. So the
  approval **modal** reads the owner's entry (`vault.get`, only when `approval.vault` is there, i.e. for the owner) and
  adds one WHAT HAPPENS line for an `ssh` entry: “Pippa’s key covers staging”, “Dusty’s key covers all servers”. The
  chat card stays core's view (a read per card in a busy room isn't worth one line); nobody but the owner sees it.
- The audit log needs nothing new: the owner's line is core's `vaultAuditDetailText`, and an agent's command reads as
  recorded (“Used “Deploy key” · ssh web-1 · systemctl status nginx · done”). `AuditVaultDetail` carries no exit code;
  RECENT USE shows it (“Dusty · web-1 · systemctl status nginx · for you · exit 0”, core's `vaultUseRow`).

### AP-604 The fixture world and the visual check

`createWebFixtureFetch({vaultSsh})` / `VITE_FIXTURE_VAULT_SSH=1` puts the shared fixtures' “Deploy key”
(`vaultSshDeployKey`) in Mara's Vault, opt-in so the Vault's visual baselines stay as they are. No new baseline: the
SSH screens were reviewed in light and dark at 1440×900 with that world (the list, the entry's PUBLIC KEY and SERVERS,
a changed host key, the Servers chooser, Add to Vault's tiles and both key modes, the server modal, both key dialogs,
the profile pane). Tests: `apps/web/src/features/vault/ssh.test.tsx` against the fixture world (every SSH write's body,
the trust card, the changed key, the refusals, the chooser, the approval line, the audit line, the model).

### AP-605 SSH keys on Android

The list shows an SSH key like every entry (“SSH key · ED25519 · 2 servers · 2 agents”). Its screen: **PUBLIC KEY**
(the fingerprint in mono, “ED25519 · made by Whombat · added 5 days ago”), **SERVERS** read-only (name in mono, `user@
host:port`, the status dot, the check line — bad when failing —, and a mono “Host key to confirm: SHA256:… (ED25519)”
or “New host key: …” when one waits), then core's `sshOnWeb` (“SSH keys and servers are set up on the web, in Settings
→ Vault.”). There is no Check, Edit, trust or new key on the phone (VT-S13). AGENTS WITH A KEY shows each key's servers
as its meta; Asks / Allowed and Take back work as for every entry, and “Give a key to…” gives All servers (“starts at
Asks · All servers”): choosing servers is on the web. The agent screen's VAULT row reads “Asks · staging”. The demo
world (“Explore the demo burrow”) holds the Deploy key. Unit tests in `src/data/vault.test.ts`; the touch-target and
TalkBack audits cover the screen unchanged (no new pressable).

### AP-606 whombat-app 0.21.0

AP-598…AP-605 as 0.21.0, on contracts 0.32.0 (CT-199…CT-206, `SESSION_API_LEVEL` 25, so the build serves runtimes of
levels 23…26): SSH keys in the Vault on the web and Android. Released like 0.20.0 (version bump on the branch, merged
into `main` with `--no-ff`, tag `app-v0.21.0` on the merge, `pnpm release:dist` from the tag). A runtime without
`vault.ssh` doesn't offer the SSH key tile.

## Mentions in any letter case (AP-607, AP-608)

John typed `@banjo …` in a thread; only `@Banjo` was a mention, so Banjo never woke and nothing showed it. Core 0.33
resolves and canonicalises any letter case (Whombat `docs/decisions/messaging.md` MS-C01…MS-C03, contracts CT-207);
the runtime stores the canonical text. The clients correct it as it is typed.

### AP-607 The composer corrects `@banjo` to `@Banjo` (web and Android)

- **One model, in `@whombat/client`** (`composer.ts`): `autocorrectComposerMention(edit, targets)` applies core's
  `autocorrectMentionAt` after a change, but only for an **insertion** (the web's `inputType` starting with `insert`;
  without one, the change adds characters) and never while an IME composition is open. Where the field doesn't report
  the caret with the change (Android's `onChangeText`) it is where the inserted text ends; a character typed beside the
  same character reads two ways (`@pepper␣x` + `␣`), so both ends are tried. `composerText` (= `canonicalizeMentions`)
  is what is sent and saved. `composerMentionTargets(principals, viewerId)` = core's `mentionTargetsFor`: the same
  rule the send uses, so someone else's personal agent is nobody's `@Name` (PA-05).
- **Targets.** The channel / DM composer corrects to the people and agents its `@` list offers (`mentionables`: a
  direct conversation's people only); the thread's reply box, every edit box and Android's composer and edit sheet to
  the burrow's principals for the viewer. The send and an edit's save canonicalise against the burrow's principals
  (`useSend`, `saveEdit`, Android's `ChatView`), whatever the box corrected.
- **Web, every box where a message is typed**: the channel / DM composer, the thread's reply box and the inline edit
  box (conversation and thread), through `useMentionAutocorrect`. The correction is applied after React has committed
  the typed text (a microtask: an edit inside the commit is reverted when React restores the controlled value), as
  `execCommand('insertText')` over the word, so it is one step in the browser's undo history: Ctrl+Z / ⌘Z gives back
  `@banjo ` like any auto-correct, and isn't corrected again (`historyUndo` isn't an insertion). Where `execCommand`
  isn't there (jsdom) the text is set through state and the caret put back. The caret stays where it was, also in the
  middle of the text.
- **Android**: the composer and the edit sheet correct in `onChangeText` and put the caret back with `setSelection`
  on the next frame (the text has the same length). No undo there (TextInput has none).
- **Optimistic message**: `useSend` canonicalises before resolving mentions, skills and commands, so the optimistic
  row shows `@Banjo` in brand/600 and the right agent thinks; a draft restored after a failed send keeps what was typed.
  An edit whose only change is a mention's case closes like an unchanged one.
- **The `@` list** already matched in any case (`mentionQueryAt` takes `[A-Za-z]*`, `mentionOptions` compares
  lowercased; MS-07): `@ban` offers Banjo. Now tested.
- Not corrected: a paste (only the character just typed ends a word; the send canonicalises it anyway), `@banjo.`
  until the next character (core waits after `.` / `-`), emails, `x/@banjo`, code, unknown words, `@channel` /
  `@here`.
- Tests: `packages/client/src/composer.test.ts` (typing, caret, the middle of the text, emails, code, unknown names,
  deletions, IME, idempotence, targets), `apps/web/src/features/messaging/components.test.tsx` and
  `mentionCase.test.tsx` (the composer, a paste sent canonical with the optimistic row, the reply box, the edit box),
  `apps/mobile/src/data/mentionCase.test.ts` (Android's change sequences, a word committed at once). Checked in
  Chrome against a local server on a throwaway database (Whombat `agent-guidance`): `@banjo hi` reads `@Banjo hi` in
  the channel composer and the reply box before sending and `@Banjo` in brand/600 after, Banjo thinking, light and
  dark at 1440×900; Ctrl+Z after a correction gives `@pippa ` back. No new visual baseline (the composer looks the
  same). Android: unit tests only.

### AP-608 whombat-app 0.22.0

AP-607 as 0.22.0, on contracts 0.33.0 (CT-207…CT-210, `SESSION_API_LEVEL` 25 unchanged, so the build serves runtimes
of levels 23…26): mentions in any letter case corrected in the composers on the web and Android. Released like 0.21.0
(version bump on the branch, merged into `main` with `--no-ff`, tag `app-v0.22.0` on the merge, `pnpm release:dist`
from the tag). An older runtime stores what it is sent: the canonical text, so it resolves the mention too.

## Merge and Deploy in three states (AP-609…AP-613)

John (2026-10-01) wants to give agents Merge and Deploy, each **Off · Ask · On** (Ask: every merge or deploy is an
approval card he authorises; On: no card). This supersedes the mock's locked “Merge into main · people only” and
“Deploy · always asks a person” rows (Whombat `docs/decisions/runs-approvals.md` MDS-01…MDS-07, contracts CT-211…CT-215).

### AP-609 The rows: a small segmented control where the switch was (web)

- Configure → Access and the hire modal's name and keys step show **Merge** and **Deploy** (`keyLabel('merge')` /
  `keyLabel('deploy')`) as the last two KEYS rows, after “Propose skills”, with an **Off · Ask · On** control
  (`KEY_TIER_CHOICES`, `KEY_TIER_LABELS`) instead of a switch: `TierRow` (`components/Toggle/TierRow.tsx`), the
  `ToggleRow`'s line, label and hint with the product's `SegmentedControl` (the Vault's tier control) where the switch
  sits. `SegmentedControl` gains `size="sm"` (2px padding, `--radius-small` container, 6px items, 12.5px) so a row
  keeps the switch rows' height (the row's padding is 6px instead of 10px), `role="radiogroup"` (named by the row's
  label through the legend; native radios, so arrow keys move the choice; the existing brand focus ring) and
  `describedBy` (the hint). The selected segment is in the button colours, like every segmented control.
- **Hire**: a row opens at `option.defaultTier` (`hireKeyOptions(role)`: Off for every role, Deploy Ask for an
  Operator) and follows the role while untouched, like the switches (AP-200). The hire sends `keyTiers: {merge,
  deploy}` (both rows, as they stand) and never `merge` / `deploy` in `keys` (`liveKeyRows` leaves the three-state rows
  out, so `selectedKeys` can't pick them).
- **Configure** opens with `configureKeyTiers(grants, options)` and saves with `configureGrants(held, {…, baseTiers,
  tiers}, options)`: a row set back to where it opened is no change, a changed row writes the umbrella and aligns the
  narrower grants (`withKeyRowTier`), so Banjo's stale `merge.main: cannot` reads Off and becomes Ask with `merge: ask`
  when Merge is set to Ask (tested). A personal agent has no such rows.
- **No role lock**: a Lead or a Tester can be given them too (MDS-02).
- **Deploy's hint** (MDS-05): `DEPLOY_NO_WORKFLOW_HINT` under the label only when `useHostInfo` answers
  `deployWorkflow === false`; `true` or absent (an older server) shows none. The row stays settable either way.

### AP-610 A Whombat without `keys.merge_deploy`

Such a runtime still enforces the old caps, so the client keeps today's rows: `withTierRows(options, false)` swaps the
two three-state rows for the locked “Merge into main · people only” and “Deploy · always asks a person”
(`LEGACY_CAPPED_ROWS`), last; the hire sends no `keyTiers` (the older server grants them at its caps), Configure saves
no tiers. The capability roles' old “not for this role” on Deploy isn't redrawn there (cosmetic; the older server's hire
decides what is granted).

### AP-611 The note under Merge into main

The branch room can't see the agents' keys (`agents.list` carries no grants), so it can't tell whether “Agents in this
burrow don’t hold a merge key” is true. On a Whombat with `keys.merge_deploy` the note reads **“Agents merge only with
the Merge key. On Ask, a person approves each merge first.”** (`MERGE_NOTE_WITH_KEYS`, `features/branch/model.ts`);
on an older one core's `MERGE_NOTE` stays. The branch-room visual comparisons mask the note (`[data-merge-note]`) as a
documented deviation from the mock. The button's own hint for an agent principal (“Merging is for people.”, the
server's 409) is unchanged: the button is for people, agents merge through `merge_pr`. The profile pane's and run
page's key rows (core's `keyRows`: “asks a person”, “no key”) and the approval cards' texts (from the server) stay
true and are unchanged.

### AP-612 Android: read-only, set on the web

Android edits no agent keys today (the agent screen's KEYS list is read-only), so it shows the two rows read-only: on a
Whombat with `keys.merge_deploy`, for a team agent, the grants Merge and Deploy write (`merge`, `merge.main`,
`deploy`, `deploy.staging`, `deploy.production`) leave the KEYS list and **Merge** and **Deploy** follow it as rows with
the list's mark (✓ / ? / × in the tier's colour) and the state in mono (“Off”, “Ask”, “On”; `keyRowTier`, the tier that
decides a merge into main or the strictest deploy), then “Merge and Deploy are set in Configure → Access on the web.”
(`KEY_TIERS_ON_WEB`). TalkBack reads “Merge, Ask”. An older Whombat shows the grants as before. No new pressable, so
the touch-target audit is unchanged. Tests: `apps/mobile/src/data/keyTiers.test.ts`.

### AP-613 whombat-app 0.23.0

AP-609…AP-612 as 0.23.0, on contracts 0.34.1 (CT-211…CT-215, `SESSION_API_LEVEL` 25 unchanged, so the build serves
runtimes of levels 23…26). Tests: `apps/web/src/features/agents/keyTiers.test.tsx` (hire defaults per role, the
`keyTiers` sent, the stale `merge.main: cannot` round trip through Configure, the hint only for `deployWorkflow:
false`, the old rows on a runtime without the feature), `liveKeys.test.ts`, the moved hire / Configure tests in
`agents.test.tsx` and `skills.test.tsx`. Visual: checked in fixture mode at 1440×900, light and dark (Configure for
Banjo with Merge Ask and Deploy Off, with and without the hint; the hire modal for a Developer and an Operator; the
keyboard focus ring); baselines `hire-details-{light,dark}` and the Toggle story `hire-modal-keys-with-tiers` updated /
added. Released like 0.22.0 (version bump on the branch, merged into `main` with `--no-ff`, tag `app-v0.23.0` on the
merge, `pnpm release:dist` from the tag). Open: setting up a deploy workflow from the UI (MDS-05).

## Subscribing again after `snapshot_required` (AP-1097)

### AP-1097 The session subscribes again after the cursor `snapshot_required` gives

**Finding.** `snapshot_required{sub, reason, cursor}` means “refetch authorized snapshots, then subscribe again with
`after: cursor`” (`@whombat/protocol` `SnapshotRequired`). The runtime does not keep a subscription it answers that
way: nothing is subscribed meanwhile (Whombat `apps/server/src/managed/events.ts` `subscribe()` and the overflow path,
`managed/session/connection.ts` `onSubscribe`). `createSecureSession` only took the cursor and called
`onSnapshotRequired`, so after any `snapshot_required` that subscription got no live events until its topics changed or
the connection reconnected. It happens after every runtime restart (a reconnect resumes `after` a cursor of the old
epoch: `restart`), after `cursor_expired`, after a permission change (`authz_changed`, also on the reconnect the
runtime forces with it), after falling behind (`overflow`), and for an event too large for a session message (the
runtime answers `snapshot_required{overflow}` at that event's cursor). The fake appliance kept the subscription, so the
tests never saw it. Web and Android both go through this path (`createSecureSession` + `createSessionRealtime`, behind
`withManagedAuth`); neither has a session of its own.

**Decision.** On `snapshot_required` for a subscription the session holds, on the current connection:

1. take the cursor, call `onSnapshotRequired` (the realtime adapter's `onResync({ reason: 'snapshot' })`, which
   invalidates what those topics feed), then send `subscribe{sub, topics, after: cursor}` with the subscription's
   current topics. Its `subscribed` comes back `resumed: true`, so the adapter signals no second resync: one
   `snapshot_required`, one resync.
2. **Closed meanwhile** (the app closed it before the answer arrived, or the handler closes it): ignored; the appliance
   dropped it too. **From a connection that is no longer current**: ignored; the current connection subscribed it from
   our cursor in `onOpen` and gets its own answer. **On a draining connection** (`goaway`): only the cursor and the
   resync; the next connection's `onOpen` subscribes it from that cursor.
3. **Racing a topic change**: the subscribe uses the topics at the time it is sent, so the newest win; a handler that
   already subscribed it again itself (through `setTopics`) is not doubled. Answers to two outstanding subscribes for
   one sub can't be told apart (the protocol names no request), so a race may send one subscribe more; the runtime
   replaces a subscription of the same `sub`, so it is harmless.
4. **No tight loop.** A well-behaved runtime never answers a subscribe after its own cursor with `snapshot_required`
   again. If it does within 10 s (`SNAPSHOT_REPEAT_MS`) of our subscribing again, the next attempt waits
   `snapshotBackoff` (1 s doubling to 30 s, jittered like reconnects) and calls `onSnapshotRequired` again only when
   that answer comes; a `setTopics` meanwhile sends at once with the newest topics, closing the subscription or the
   session cancels the wait. The first `snapshot_required` (after a restart, an expiry, a permission change) is
   followed at once.

**Fake.** Matching the runtime, `createFakeAppliance` now drops a subscription whenever it answers `snapshot_required`
(an expired or unreadable cursor, `bumpAuthz`, and the new paths), and a `subscribe` replaces the sub until it is
answered. Its cursors are `<epoch>.<n>`, the epoch new per instance; new faults: `restart()` (a new epoch, every
connection drops: old cursors get `restart`), `overflow()` (every subscription gets `overflow` at the newest cursor),
`repeatSnapshot(n)` (the next `n` subscribes are refused whatever their cursor); an event too large for a CONTROL
message is answered with `snapshot_required{overflow}` at its own cursor, also during a resume. `stats().subscribes`
lists every subscribe with its topics, `after` and time.

**Tests** (`packages/client/src/session/secure.test.ts` “secure session: subscriptions”, `session.test.ts`): after a
restart, an expired cursor, a permission change, falling behind and an event too large to send, events published
afterwards reach the subscriber and `onSnapshotRequired` / the resync came once each; a `snapshot_required` for a
subscription closed meanwhile (or in the handler) sends nothing; one racing `setTopics` subscribes again with the newest
topics; a runtime that keeps refusing is asked again after 40, 80, 80 ms (test backoff), not in a loop. Without the
client change these fail, and so does the existing expired-cursor test (its later `authz_changed` never arrives once
the fake drops the subscription).

**Open (Whombat, not this repository).** `connection.ts` handles `subscribe` messages concurrently (`void
this.onSubscribe(msg)`): two outstanding subscribes for one `sub` (a resubscribe and a `setTopics`) can both register in
the event log while only the later `close` is kept, and an `unsubscribe` arriving while a subscribe is still being
answered doesn't close it. The client ignores events for a sub it no longer holds and skips a cursor it just had, so
the effect is events of a sub it holds possibly delivered twice until the connection ends; raised with the orchestrator.

## AP-9346 An emailed invitation's link signs in with one tap (control BL-45)

John, 2026-11-15: after opening an invitation, the person still had to ask for a sign-in email, though the invitation
already went to that address. Control's invitation mails now carry a one-time sign-in token next to the code
(`/signup#code=…&token=…&email=…`, all in the fragment). The page reads the token and address once
(`readInvitationSignIn`), keeps them only in memory (never stored, unlike the code, AP-161) and takes the fragment out of
the address bar with the code.

- Signed out on `/signup`: “You’re invited to Whombat”, “Continue to set up your organization.” and one button,
  “Continue as {email}”, which sends the token to `auth.verify` and lands on the create-org screen with the code filled
  in. A tap rather than on opening, so a mail scanner that opens links doesn't use the one-time link up.
- Control refuses the token (used, revoked, ended): the email sign-in with “That invitation link doesn’t work any more.
  Sign in with the email address it was sent to.” and the code still held. Control unreachable: the button stays, with
  the usual “Couldn’t reach Whombat” line.
- Signed in as the invited address, or a link without one: nothing to ask, the usual `/signup`.
- Signed in as someone else: “This invitation is for someone else” with “Continue as {invited}” (signs out, forgets
  the previous person's held links, keeps the code, signs the invited address in) and “Stay as {current}” (drops the
  token and the code, which is bound to the other address).

Codes without an address and the operator's copy of a link (the code alone) keep the email sign-in. Phones are
unchanged: `/signup` isn't one of the Android app's links, so the invitation opens in the browser.

## AP-9347 Operators delete invitations and codes

Moved to control with the operator panel (`docs/decisions/admin.md`, same ids; Whombat `docs/decisions/public-copy.md` PUB-13).
