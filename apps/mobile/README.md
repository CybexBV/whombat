# @whombat/mobile

Whombat for phones: Expo SDK 57 / React Native 0.86 (new architecture, Hermes), Android first, iOS kept
buildable (DECISIONS D-08). A Whombat is one person's, with one agent (Whombat one-person.md OP-01, one-agent.md
OA-01): the tabs are **Chat** (your Chat and Feedback room with the agent, software work included), **Inbox**,
**Overview**, **Automations** and **Settings**,
which opens, as on the web, on **Often used** (Notifications on a Whombat, and the theme) and then six groups —
**You**, **the assistant by its name** (its name and face, AI sign-in, Memory, what it may do and the council it asks),
**Connections**, **This Whombat**, **Screens** (where the Whombat has a screen) and **Advanced** (model and effort, AI on
this Whombat, usage, what it runs, skills, the audit log and diagnostics) — beside the approval, run, branch room and
thread screens. Push notifications and live activities (a run in
progress, an approval that needs you) come from `modules/whombat-live`.

## Layout

```
index.ts                 polyfills (crypto.getRandomValues) → registerRootComponent(App)
app.config.cjs, eas.json Expo config (package com.whombat.mobile, scheme whombat://), EAS profiles
metro.config.cjs         pnpm workspace: watch the repo, package exports, singleton React / Query / svg, inline
                         requires for the app's own modules, zod with English only (docs/decisions/android-slim.md)
scripts/                 build-android.mjs (local Gradle build), publish-apk.mjs (a release APK where control hands
                         it out), publish-ios.mjs (the iPhone app to TestFlight, built on a Mac), push.mjs (dev push),
                         device-harness/ (the secure session on a device against a stand-in relay); icons come from
                         packages/brand
plugins/                 Android config plugins: the dark window background, plain sockets to the Whombat's direct
                         routes (network security config), English resources only, no contrast film over the
                         navigation bar
modules/whombat-live/    live activities and home-screen status widget: Android Live Update notifications + FCM + RemoteViews widget, iOS ActivityKit + WidgetKit
modules/whombat-crypto/  ChaCha20-Poly1305 and SHA-256 from the phone (javax.crypto, CryptoKit) for the session, sealed files, downloads
modules/whombat-updater/ Android only: the app downloads, checks and installs its own updates
modules/whombat-passkeys/ passkeys through Credential Manager (Android) and AuthenticationServices (iOS)
modules/whombat-voice/   the microphone for voice typing: a 16 kHz WAV (AudioRecord, AVAudioEngine) and its loudness
modules/whombat-fold/    folding phones: the system's vertical bar, the fold, the clock and the hinge (iOS 27.1, WindowManager)
modules/whombat-menu/    iOS only: a message's long-press menu as iOS's own context menu (UIContextMenuInteraction)
modules/whombat-sheet/   iOS only: the app's sheets as iOS's own form sheets, with the system's grabber
modules/whombat-system-bars/ Android only: the area under the tab bar drawn for the app's theme
modules/whombat-diagnostics/ iOS only: the crash and hang reports and exit counts iOS hands the app (MetricKit), kept for its error notes
modules/whombat-transfer/ big files to and from the phone: Android's “Save as”, and the screen kept on while one moves
src/
  App.tsx                safe area → theme → fonts → the managed app (or, in a demo build, the demo world)
  managed/               cloud sign-in, the Whombats, claim and pairing, a Whombat over its end-to-end session
  demo/                  the demo world on an in-memory box (`createFakeSession` over the fixture world)
  fixtures/              the in-app fixture world (createFixtureFetch + inbox + mobile moment + fake realtime)
  data/                  pure view models (inbox, approval, chat, lists), BurrowProvider (bootstrap, clock, zone)
  theme/                 @whombat/tokens nativeThemes, light/dark preference, Bricolage Grotesque + DM Mono
  avatars/               react-native-svg renderer for @whombat/avatars' node tree, HumanAvatar
  ui/                    primitives (buttons, chips, grouped lists), chat pieces, headers, icons (Lucide)
  navigation/            native stack + bottom tabs, deep links (whombat://approvals/12, …), tapped pushes, the
                         saved place restored after a killed process (persist.ts); the stack as one page or two
                         and the tabs down the side on a wide or folding screen (SplitStack.tsx, splitRouter.ts)
  push/                  iOS taps (expo-notifications), the permission card (prompt.ts), read notifications
                         leaving the shade (shade.ts); the push handle itself is `managed/push.ts`'s
  live/                  in-app live activities from run.updated / approval.updated, reconciled on pushes; home-screen status widget sync (`StatusWidgetBridge`)
  screens/               Chat, Thread, Approval, Run, a branch room (Conversation), the assistant's page and the
                         parts it and Advanced share (agent/), Connections and things
  settings/              the Settings tab in the web's groups (list.ts, groups.ts): You (profile, notifications,
                         Chat, devices), the assistant, Connections, This Whombat, Screens (the box's screen and the
                         preview of its glance, or the screens of widgets), Advanced (its list and own pages), the
                         theme, the version, sign out
```

## Develop

Prerequisites: `pnpm install`, Android SDK at `~/Android/Sdk` (emulator, platform-tools, Java 21).

```sh
export ANDROID_HOME=$HOME/Android/Sdk

# 1. A debug APK whose JavaScript comes from Metro on port 8195 (any free port)
pnpm --filter @whombat/mobile android:apk --metro-port 8195
#    → apps/mobile/build/whombat-debug.apk   (android/ is generated by `expo prebuild` and gitignored)

# 2. Metro on that port: the app (see “A Whombat” below for its control), or the demo world
pnpm --filter @whombat/mobile start --port 8195
EXPO_PUBLIC_WHOMBAT_MODE=fixtures pnpm --filter @whombat/mobile start --port 8195   # the demo world, no Whombat

# 3. Install and launch on an emulator (serial emulator-5610 below)
$ANDROID_HOME/platform-tools/adb -s emulator-5610 install -r apps/mobile/build/whombat-debug.apk
$ANDROID_HOME/platform-tools/adb -s emulator-5610 shell am start -n com.whombat.mobile/.MainActivity
```

The debug app loads its bundle from the emulator's host (`10.0.2.2:<metro port>`), with Fast Refresh.
Without Metro it falls back to nothing, so use a release build for a standalone APK:

```sh
pnpm --filter @whombat/mobile android:apk --variant release    # JS bundled, signed with the debug key
pnpm --filter @whombat/mobile android:apk --arch all            # x86_64 + arm64-v8a (real phones)
pnpm --filter @whombat/mobile android:apk --clean               # regenerate android/ from app.config.cjs
```

Release builds only allow plain HTTP when built with `EXPO_PUBLIC_ALLOW_INSECURE_HTTP=1`; debug builds do.

### Emulator

A 368 × 822 dp screen at 3× matches the mock's phone screen (the 390 × 844 frame minus its 11 px bezel),
so screenshots compare 1:1 after a 3× downscale:

```sh
avdmanager create avd -n whombat-mobile -k "system-images;android-36;google_apis;x86_64" -d pixel_7
# ~/.android/avd/whombat-mobile.avd/config.ini: hw.lcd.width=1104, hw.lcd.height=2466, hw.lcd.density=480,
#   hw.keyboard=yes, hw.ramSize=4096
emulator -avd whombat-mobile -port 5610 -no-window -no-audio -no-boot-anim -gpu swiftshader_indirect &
adb -s emulator-5610 wait-for-device
adb -s emulator-5610 shell cmd uimode night yes|no      # system dark / light
adb -s emulator-5610 emu kill                           # shut it down
```

### The demo world

A demo build (`EXPO_PUBLIC_WHOMBAT_MODE=fixtures`) runs the mock world in the app, on an in-memory box: a real secure
session (`createFakeSession`) whose operations `@whombat/fixtures`' `createFixtureFetch()` answers, plus the mobile
inbox, the mobile mock's approval moment (Approve → APPROVED · DEPLOYING with Undo), and the agent's replies (Neo, in
this world) that "think" for 1.6 s and arrive as realtime events. Nothing leaves the phone, and there is nothing to
sign out of.

## A Whombat (cloud sign-in, end-to-end sessions)

The app (AP-27…AP-32): sign-in by magic link (the link opens the app), the appliance list, claim (scan or type the card), the recovery kit,
pairing, and the regular screens over the session. Against your own control, relay and appliance environment
(the ports below are examples):

```sh
export EXPO_PUBLIC_WHOMBAT_CONTROL_URL=http://127.0.0.1:4800 \
  EXPO_PUBLIC_WHOMBAT_UI_URL=http://localhost:4830 EXPO_PUBLIC_ALLOW_INSECURE_HTTP=1 EXPO_PUBLIC_WHOMBAT_PUSH_RELAY=1
pnpm --filter @whombat/mobile android:apk --variant release --clean
adb reverse tcp:4800 tcp:4800 && adb reverse tcp:4810 tcp:4810     # control and relay at 127.0.0.1 on the phone
adb install -r apps/mobile/build/whombat-release.apk
# the magic link from Mailpit opens the app:
adb shell am start -a android.intent.action.VIEW -d '"http://localhost:4830/auth/verify#token=…"'
```

Push end to end without Firebase: run control with `PUSH_MODE=live`, `FCM_ENDPOINT=http://127.0.0.1:4807` and the
service account from `node scripts/push.mjs service-account --port 4807`, and the stand-in
`node scripts/push.mjs fcm --port 4807 --serial <emulator> --log messages.jsonl`. A tapped notification is resolved
through the session; `adb shell am start -n com.whombat.mobile/.MainActivity --es google.message_id 0:1 --es kind
message --es ref <22 chars>` imitates a tap on a notification FCM itself showed.

## Screenshots and visual checks

`pnpm ref:shot` renders the design references in `docs/design-handoff/`.

```sh
adb -s emulator-5610 exec-out screencap -p > .visual/mobile/inbox.png                  # 1104 × 2466
ffmpeg -i .visual/mobile/inbox.png -vf scale=368:822:flags=area .visual/mobile/inbox@1x.png
pnpm ref:shot --file mobile --theme light --out .visual/ref/inbox-light.png            # 390 × 844 frame
pnpm ref:shot --file mobile --theme dark --click "Details" --out .visual/ref/approval-dark.png
pnpm ref:shot --file mobile --theme light --click "Details" --click "Approve" --out .visual/ref/approved.png
pnpm ref:shot --file mobile --theme light --click "Direct" --out .visual/ref/dm-light.png
ffmpeg -i .visual/ref/inbox-light.png -vf crop=368:822:11:11 .visual/ref/inbox-light@screen.png
pnpm visual:diff .visual/ref/inbox-light@screen.png .visual/mobile/inbox@1x.png --out .visual/diff/inbox.png
```

Deep links jump straight to a screen: `adb shell am start -a android.intent.action.VIEW -d
whombat://approvals/12 com.whombat.mobile` (also `whombat://runs/1907`, `whombat://chat`, `whombat://feedback`,
`whombat://threads/msg_chat-heat`, `whombat://pr/482`, `whombat://settings/agent?part=keys`,
`whombat://settings/screens/box/layout` (a screen's layout editor); in the demo world
`whombat://settings/whombat?voice=downloading` starts voice typing over as another world, and
`whombat://settings/screen?desk=older` makes the box a runtime before screens of widgets).

## Push and live activities

On a Whombat, the app registers its push handle with control (content-free, MA-18) once notifications are allowed; until the system has asked, the inbox shows a card with the reason, “Turn on” and “Not
now” (MN-05, docs/decisions/mobile-reach.md). The viewer's live activities — a run they asked for (or that an agent
asked for in one of their conversations), an approval they can decide — show as ongoing notifications:

- while the app runs, straight from `run.updated` / `approval.updated` on the socket (`src/live/`);
- otherwise, on Android, from data pushes, rendered natively by the module's FCM service with the app in the
  background or killed. On iOS ActivityKit hands the app an activity's push token and a push-to-start token, but the
  app doesn't send them anywhere yet, so an iPhone's activity updates only while the app runs.

An ongoing notification goes 10 minutes after its last update; the app reconciles on every push and on coming to the
foreground (MN-02). Inbox pushes open their screen — with the tabs beneath it (MN-01) — (needs-you rows open the
approval) and mark the row read; a row read in the app or on another device takes its notification out of the shade
(MN-03, MN-04). An approval's Review action
opens the approval (after unlocking), where the person approves. Android 16 shows `ProgressStyle` notifications and asks for Live
Update promotion (promotion needs Android 16 QPR1+; the API 36 emulator image has the style, not the
promotion).

### Testing push on an emulator without Firebase

One payload (a `PushPayload` JSON, e.g. a needs-you row) can be delivered directly:
`node apps/mobile/scripts/push.mjs inject payload.json --serial emulator-5610`. It goes through the debug build's
`DebugPushReceiver`, which calls the same handler as the FCM service; end to end through control, see “A Whombat”
above.

### Publishing for production

There is one app for everyone (Whombat `docs/decisions/one-environment.md`): both publish scripts build for production
unless told otherwise (`--env prod`: `api.whombat.com` and `app.whombat.com`). The APK and its `latest.json` go into
production control's downloads folder; the iPhone app goes to TestFlight (below).

```sh
pnpm --filter @whombat/mobile publish:apk --dir <production control's DOWNLOADS_DIR> --arch all
pnpm --filter @whombat/mobile publish:ios
```

`--env dev` is still accepted until the move to production is done; it goes with DEV.

### iOS (macOS)

Built on a Mac with Xcode 27.1 (docs/app/decisions/ios-build.md: Node 24, CocoaPods, the scene lifecycle that the
iOS 27 SDK requires). Every time the Android app is published (AP-5800), the iPhone app goes to TestFlight from the
same commit (AP-5802), from the Linux machine that publishes the Android app. Tell it which Mac builds it, as an ssh
target: `WHOMBAT_IOS_MAC=user@host`, or that line in `~/.config/whombat/ios/mac`; the script stops when neither is set.

```sh
pnpm --filter @whombat/mobile publish:ios                  # production; HEAD; --rev <commit> for another
```

It copies the commit to the Mac's own checkout (`~/Code/Whombat-publish`), prebuilds, archives and uploads it, and waits
until App Store Connect has processed the build: about 6 minutes, 25 when the Mac builds from scratch, so run it in the
background. The internal TestFlight group “Whombat” gets every build, and an iPhone with TestFlight's Automatic Updates
on installs it by itself. A production build also joins the external group “Public” (the public link), and waits
there until someone submits it for Apple’s review in App Store Connect. A version uploads once (its build number is the
APK's `versionCode`): bump `apps/web/package.json` first. Nobody needs to be at the Mac: an App Store Connect API key (Admin)
is in its `~/.config/whombat/ios/` (`asc.json` and `AuthKey_<keyId>.p8`), and the script signs from a keychain of its own with an
Apple Development certificate it makes and renews through that key (`--setup` does only that, the group and its
testers).

To develop on the Mac, its checkout `~/Code/Whombat` is a copy of a Whombat checkout on the Linux machine, so the Mac
needs no GitHub credentials; from the repository root there (the excludes keep the Mac's generated `ios/` and
`node_modules`):

```sh
rsync -az --delete --filter=':- .gitignore' --exclude node_modules --exclude /apps/mobile/ios/ \
  --exclude /apps/mobile/android/ --exclude /tmp/ --exclude /dist-release/ ./ "$WHOMBAT_IOS_MAC":Code/Whombat/
```

Then, on the Mac, `pnpm install` at `~/Code/Whombat` and:

```sh
cd apps/mobile
npx expo prebuild --platform ios --clean      # adds the WhombatLiveWidget extension target (app.plugin.cjs)
cd ios && pod install && open Whombat.xcworkspace

# or a Release build for a simulator, against DEV, without Xcode's window (signed: unsigned, the Keychain refuses
# the device key and the app stops at “Sign in again”):
EXPO_PUBLIC_WHOMBAT_CONTROL_URL=https://api-dev.whombat.com EXPO_PUBLIC_WHOMBAT_UI_URL=https://dev.whombat.com \
  xcodebuild -workspace Whombat.xcworkspace -scheme Whombat -configuration Release \
  -destination 'id=<simulator udid>' -derivedDataPath build/dd DEVELOPMENT_TEAM=4R8P9MTF9T build
xcrun simctl install <simulator udid> build/dd/Build/Products/Release-iphonesimulator/Whombat.app
```

1. Signing & Capabilities: pick the team for **Whombat** and **WhombatLiveWidget**; the app target needs
   Push Notifications (its entitlement is generated) — the widget extension needs no capability.
2. Build and run on an iPhone (iOS 16.4+; push-to-start needs 17.2+). Live Activities must be allowed in
   Settings → Whombat.
3. Server: set `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_PRIVATE_KEY`, `APNS_BUNDLE_ID=com.whombat.mobile`.
   Live-activity pushes use the `com.whombat.mobile.push-type.liveactivity` topic and
   the `WhombatLiveAttributes` attributes type. The app doesn't send its live-activity tokens to the server yet, so
   none of these pushes reaches the phone.
4. Check: sign in, play the storyline; the run and the approval appear on the Lock Screen and in the Dynamic
   Island, and keep updating while the app runs.

## Tests

`pnpm --filter @whombat/mobile test` (Vitest, Node — no React Native imports in tested modules) and
`pnpm --filter @whombat/mobile typecheck`; both run in the root `pnpm check`. Covered: the avatar tree →
react-native-svg mapping and filter fallback, inbox grouping and approval rows, the approval screen state
machine (pending / approved / declined / undo), chat items and receipts, the managed app's sign-in, claim and
pairing, the fixture world over the session fake (inbox, approval moment, the agent's live replies), routes, config,
the run screen model, notification URLs, and live-activity content
(audiences, pushes, reconcile, native colors against the tokens).
