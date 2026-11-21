# A smaller, faster, lighter Android app (AP-888…AP-939)

John, 2026-10-08: “Can we optimize the Android app and see if we can make it smaller, more efficient, and faster?”

Where the 0.55.0 APK (arm64, 59.5 MB) went: 36 MB of dex (no R8), 37 MB of native libraries stored uncompressed —
9.4 MB of them OpenSSL from react-native-quick-crypto, used for one cipher, plus 1 MB of Nitro for it — a 7.9 MB
Hermes bundle (zod's 45 locales, every screen), and a 1.5 MB `resources.arsc` with library strings in ~100 languages.
At start the bundle evaluated every module before the first frame (~300 ms on the emulator), the app waited on control
before showing anything, and a running app kept its connection, refetched everything on return and serialized its
cache every 2 s. A code review (render, startup, network, background) found the rest below.

Measured on the x86_64 emulator (API 36, swiftshader; release builds, same machine, medians of 8 cold starts):
first frame 410 → 336 ms, signed-out sign-in screen 596 → 470 ms after process start, memory (PSS) 150 → 136 MB.
The APK for phones (arm64) is 59.5 → 23.6 MB. The on-device secure-session harness (AP-25) passes as before: native
AEAD 2.82 / 1.82 MiB/s down / up (0.55.0 with quick-crypto: 2.63–2.88 / 1.69–1.77).

## Size and build

| ID | Decision | Why |
|---|---|---|
| AP-888 | **Inline requires for the app's own modules, not for `node_modules`** (`metro.config.cjs`: a proxy block list answers Metro's `file in blockList` for every package file). | Screens and app modules run when first used (first frame ~85 ms sooner on the emulator). Inlined requires in the transport libraries halved the harness's upload and download speed, also with Metro's memoized variant; with package files eager the speed is back and the startup gain stays. Expo ships with inline requires off; React Native's template has them on. |
| AP-889 | **zod's `locales` namespace is English only** (a Metro shim for `zod/v4/locales/index.js`). | zod re-exports all ~45 locales from its entry and Metro doesn't tree-shake: 270 kB of messages nobody sees (zod imports its English default itself). |
| AP-890 | **ChaCha20-Poly1305 from Android's own `javax.crypto`** (Conscrypt on BoringSSL, Android 9+) through `modules/whombat-crypto` (Kotlin, synchronous `Function`s, bytes copied once each way). react-native-quick-crypto, react-native-nitro-modules and react-native-quick-base64 are gone. Android 8 and older (and the iPhone) keep the pure-JS cipher. | The app used quick-crypto for exactly this cipher (AP-26): 10.3 MB of native code and 300 kB of JS. Same speed in the harness, interop and tamper checks pass. (quick-crypto also set `process.nextTick` on import; Expo's `registerRootComponent` installs it too.) |
| AP-891 | **The native cipher's self-test runs once per process** (`checkedNativeCrypto()`, shared by the transport and the sealed files) **on 4 KiB instead of 65 kB.** | Each ran its own before; the pure-JS half on 65 kB cost ~40 ms of the first connection on the emulator. Both ciphers stream the same way at any size. |
| AP-892 | **R8 shrinks code and resources in release builds** (`expo-build-properties` `enableMinifyInReleaseBuilds`, `enableShrinkResourcesInReleaseBuilds`). | Dex 36 → 13 MB. The libraries' consumer rules cover reflection (Expo modules, React Native, Firebase, ML Kit, Credential Manager); checked on the emulator: start, QR decode through ML Kit, the native cipher, the harness. |
| AP-893 | **Native libraries are compressed in the APK** (`useLegacyPackaging`). | The APK is downloaded, not installed from Play (which compresses on its own), and the app downloads every update itself: −17 MB per download. Android extracts the libraries at install (~9 MB more on the phone than storing them). |
| AP-894 | **ML Kit's barcode model stays bundled.** | The unbundled Play-services variant would save ~3 MB but downloads its model on first use; the first scan is the sign-in, offline-capable and without Play services today. |
| AP-895 | **The release APK is signed with v2/v3 only** (`apksigner --v1-signing-enabled false`). | minSdk 24 never reads the JAR signature; its two files listed every entry again (~260 kB). |
| AP-896 | **Only English resources go into the APK** (`plugins/with-english-resources.cjs`, `resourceConfigurations += ["en"]`). | `resources.arsc` (stored uncompressed) 1.3 → 0.6 MB; the app's copy is English, and library strings no longer show in the phone's language next to it. |

*Amended by AP-6500, AP-6505* (ios-crypto-speed.md): the iPhone has the native cipher too (CryptoKit), and the saved cache
keeps at most six conversations within 400 000 characters and skips a save when nothing kept changed.

## Startup, network and background

| ID | Decision | Why |
|---|---|---|
| AP-920 | **What start needs is asked for while the fonts load:** control's session, the phone's key, the kept cloud session, and the cached data and saved place of the Whombat that will open. A value read ahead from the secure box is dropped after 30 s, or as soon as it is saved, removed or wiped. | Start waited on fonts, then on control, then on two local restores in a row. |
| AP-921 | **The app opens signed in from the last cloud session while control is asked.** The secure store keeps only the account (id, email, name) and organizations (id, name, role) — never a token — up to 2048 characters. Control's answer replaces it; a definite signed-out (no token, a 401) signs out and forgets it; no answer keeps it and asks again on coming back to the app. Sign-out forgets it first; QR, passkey and magic-link sign-ins outrank an older answer. | Start showed a spinner until control answered, and offline it ended at “Couldn’t reach Whombat” although the inbox was cached. Privacy: it sits in the keystore next to the more sensitive token, shows what is already on screen, and unlocks nothing by itself (a Whombat needs the phone's key and enrollment, the relay needs control's ticket). |
| AP-922 | **The start-up session check gives up after 10 s** without a kept session (“Couldn’t reach Whombat”); a later answer still applies. | It had no timeout. |
| AP-923 | **The saved place loads alongside the cached data**, and its own lookups in parallel. | Up to 1 s plus 1.5 s in a row before. |
| AP-924 | **`ApplianceSession.suspend?()`** (packages/client, optional; the web never calls it): closes the connections and returns to `idle`; subscriptions stay and resume from their cursors; the next call or `connect()` reconnects. It refuses while a request, status question, stream, upload slot or connection attempt is under way. | What the background policy needs without losing state. |
| AP-925 | **The connection closes after 2 minutes in the background** unless the session is busy, messages wait in the outbox, or a live activity is on screen (its updates arrive only over this connection, NT-13; Android ends it ~10 min after its last update). Blocked cases are retried every 30 s; a push that reopens it closes again after the grace period; coming back reconnects at once. | Realtime events, cache updates, renders and saves ran in the background until Android dozed or killed the app; pushes already cover that time. A push in the background now costs a reconnect. |
| AP-926 | Superseded by live-data-calm.md AP-6560. **Focus and reconnect refetches only for reads that may have missed a change** (the connection was down, or came back after the read) or that failed; reconnect refetches wait for the foreground. | Coming back refetched every mounted query, every loaded message page included. |
| AP-927 | **Coming back with realtime up only reconciles live activities from the cache**; otherwise their reload joins the focus refetch. | LiveActivityBridge cancelled and repeated requests already in flight. |
| AP-928 | **The cache is saved at most once a minute**, and when the app goes to the background. | Every realtime update scheduled a save within 2 s (deep copy, stringify, encrypt, write on the JS thread). |
| AP-929 | **Each save serializes once** (the size check and the box share it). | Up to three `JSON.stringify` per save. |
| AP-930 | **Sealed files are written next to their place and moved into it.** The write itself stays synchronous: the installed expo-file-system only writes synchronously without base64, which would cost the JS thread more. | An interrupted save no longer leaves a broken file. |
| AP-931 | **The strip's requests run once for the app** (status, licence and its timer, the update check, the passkey list in `Shell`); every screen shows the same plain view. | Each of the 83 screens ran its own copy: 2–3 requests per screen opened. |
| AP-932 | **Stack screens and the Channels, Agents and Search tabs load the first time they show** (`getComponent` with a typed require); the Inbox stays eager. | The navigator imported ~45 screens on its first render. |

## Rendering

Counted on the emulator in a 64-message chat (fixture world): sending a message, the agent thinking and its reply
re-rendered chat rows 342–480 times before, 3–40 after. Screens compared before/after are pixel-identical (inbox,
agents, a DM at 24 and 36 dp avatars, channels, an agent page, the emoji sheet).

| ID | Decision | Why |
|---|---|---|
| AP-900 | **People and viewer change only when their part of the bootstrap does**; Inbox and Channels view models are memoised. | Every new message or mark-read gave all ~85 `useBurrow()` callers new values. |
| AP-913 | **`useBurrowBase()`**: the burrow context without the bootstrap; 38 screens that never read it use it (`useBurrow()` is unchanged). | Those screens re-rendered on every bootstrap change for nothing. |
| AP-900 | **One shared “now” per burrow in 15 s steps, rounded up** (`src/lib/now.ts`); its timer runs only while something reads it. “Just now” lasts 45–60 s (was 60–90 s). | Each caller ran its own 30 s timer and read the clock during render rounded to the second, so any re-render rebuilt every view model. Rounding up keeps a message just sent at “just now”. |
| AP-901 | **Chat rows are a memoised `MessageRow`** with stable handlers (through a ref); items are kept when nothing changed. | A new `renderItem` each render re-rendered every mounted row on each typing, activity, presence or mutation change. |
| AP-914 | **Time labels are cached** by message time, time zone and the current day; “just now” is never cached. | 3–5 time-zone formatting calls per message per rebuild. |
| AP-903 | **Superseded by chat-speed.md AP-6524 for faces up to 32 dp, which are one image view; larger faces still:** **Avatars without their metadata, parsed once**: Metro (`svg-markup.cjs`) strips the C2PA block and the unused namespace and self-closes empty elements — shapes and numbers untouched; each variant is parsed once and drawn with `SvgAst`. | Each avatar re-parsed ~20 KB of SVG; the bundle's avatars go from 317 to 193 kB. |
| AP-904 | **Screens out of view are frozen** (`freezeOnBlur` on both navigators). The push, shade, share and live-activity bridges and the settings sheet sit outside the screens. A covered conversation marks messages read when you come back to it. | Visited tabs and the screens under the stack re-rendered on every change. |
| AP-905 | **The emoji sheet is a virtualised grid.** | ~388 buttons mounted at once. |
| AP-906 | **Search results don't re-render on each keystroke**; the inbox and link opening no longer follow every bootstrap change. | |
| AP-908 | **Photos go up at most 2048 px on the long side**: JPEG, HEIC and HEIF larger than that are scaled and saved as JPEG at 0.8, used only when smaller; PNG, GIF, WebP and smaller images go as picked, as does anything that fails to scale. The camera hands over its file at quality 1 so a photo is compressed once. Re-encoding drops EXIF data, location included; Glide applies the EXIF rotation when it decodes. | A 7.7 MB photo went up whole over the relay; now ~520 KB. |
| AP-909 | **Superseded by chat-speed.md AP-6528 (let go after 20 s out of view) in its “then stays”; the start holds:** **An HTML preview's WebView starts when its row is on screen or within two rows**, then stays. Full screen and previews outside a chat are unchanged. | Every HTML block in the render window ran a full browser renderer. |
| AP-912 | **`useFeature`'s runtime view is built once per welcome** (packages/client; the web behaves the same). | 45 callers rebuilt and compared the feature set on every read. |

## Release

| ID | Decision | Why |
|---|---|---|
| AP-897 | **Release 0.56.0, mobile only.** No contract change; `packages/client` gains an optional `suspend()` and a cached runtime view that the web doesn't use differently, so the Whombat vendor pin stays at 0.55.0 and DEV gets the APK (`publish:apk --env dev`). Phones on 0.55 update in the app. | The web has nothing new to ship. |

## Not done

- `@whombat/core` evaluates its schemas at load: ~105 ms of the emulator's start, 35 ms of it `CATALOG =
  ENTRIES.map((e) => CatalogEntry.parse(e))` in `connections-catalog.js`. A lazy catalog is a contracts change
  (follow-up for whombat-contracts).
- `libzstd-kmp.so` (Expo's own dependency) and ML Kit's 1D models stay.
- The chat list isn't inverted: with memoised rows a 64-message chat opens in about 1 s, and an inverted list on Android
  flips the empty state, keeps its scroll position poorly and reverses TalkBack's reading order. `initialScrollIndex`
  made it worse, `windowSize` changed nothing.
- Inbox, Channels and the audit log stay rounded grouped cards in a ScrollView (short or rarely opened; splitting
  the cards per row risks the pixels).
- `usePresenceOf` and a few settings hooks still follow every bootstrap change.
