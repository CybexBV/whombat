# Android as the primary device: the 0.35.0 release (AP-720)

John, 2026-10-04, on the Android app after installing it from the dev `/mobile` page: a “new version” banner with no
new version, an inbox with filters and already-handled “Needs you” cards, mentions and replies that stay after reading,
no run progress, narrow chats and “This agent didn't load”. “This will be our primary device to work with soon.” The
fixes and the improvements are in four streams: `android-inbox.md` (AP-701…AP-704, AP-708), `android-chat.md` (AP-705,
AP-706, AP-710, AP-714), `android-work.md` (AP-707, AP-711…AP-713, AP-719), `android-reach.md` (AP-709, AP-715…AP-718).

| ID | Decision | Why |
|---|---|---|
| AP-720 | **Every app release publishes the dev APK.** The dev `/mobile` page (control's `WB_MGD_DOWNLOADS_DIR`, `~/.whombat-stack-dev/downloads/android/latest.json`) still served 0.17.1 from 2026-09-30 while the app was at 0.34.0, so a fresh install met a box seventeen minors ahead: the skew banner, no run line (mobile has it since 0.33), a strict `agents.get` the old build couldn't read. From 0.35.0 a release is: version + tag, `pnpm release:dist`, then `pnpm --filter @whombat/mobile publish:apk --env dev --dir ~/.whombat-stack-dev/downloads`; prod only on John's word. No contract change: contracts stay 0.45.1. | The phone was the one client nobody updated, and what John saw was mostly that. The banner now also only offers an update that exists (AP-701). |
| AP-754 | **A published APK always has Firebase.** `publish:apk` builds with `GOOGLE_SERVICES_JSON` (default `~/.config/whombat/firebase/google-services.json`, Firebase project `whombat`, package `com.whombat.mobile`) and refuses to publish without it, as it does without the release key. `build-android` regenerates `android/` when the file's contents change, not only its path (a replaced file kept the old project in the APK). The file is not in the repo (one config per publisher; it ends up in every APK, so it isn't a secret, but it names our project). Control sends with its own key (control CL-116, appliance IN-201). | John, 2026-10-05, set up Firebase for Android notifications; the APKs published before had no Firebase, so push showed “Not available”. |

### whombat-app 0.35.0

AP-701…AP-720. Checks: `pnpm check` once on the merged tree (DEV fast); the release APK on the emulator against the
fixture world. Not run on John's phone before publishing.
