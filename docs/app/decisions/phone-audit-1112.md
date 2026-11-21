# The phone after the second whole-repository audit (AP-9250…AP-9259)

John, 2026-11-12: fix the second whole-repository audit's findings. The phone's Repositories screens follow the web
(Whombat `docs/decisions/archive/check-server.md` CKS-145…CKS-147); the approval's live button is `docs/decisions/mobile-live.md`
ML-18. What the phone itself decided:

## Decisions

| # | Decision | Why |
|---|---|---|
| AP-9250 | **A failure on the phone is an alert, never a toast.** `showNotice` (Android's short toast, the app's own on iPhone) is only for a success the screen doesn't show. Something that didn't go through calls `showFailure` (“That didn’t go through” and why, an alert to tap away), a change held back calls `showHeldBack` (the outcome's title and why), and a look's step uses `showLookFix` (a refusal or a failure in an alert, one no longer needed as a note). Applied to Repositories (Remove, remove a computer, Go ahead, Ask in chat), copying, disconnecting an account or IMAP, delegation and council cards, handing a look over, Needs you, a server's task that failed, and a service page's failed press. | A failure in a short toast can flash by unseen, and the person thinks it went through. |
| AP-9251 | **A download of an update has no Stop.** The updater module offers no `cancel` (JavaScript and Kotlin), and a download ends only by finishing or failing; a failure says why and offers Try again. | The mocks show no Stop for the download and nothing called it, so the stopped download's path couldn't be reached. |
| AP-9252 | **The app doesn't list `@react-native/metro-config`.** `metro.config.cjs` builds on `expo/metro-config`, and neither Expo nor its Metro config loads React Native's; React Native's own CLI plugin still brings it. The JavaScript bundle (`expo export --platform android --no-bytecode`) is byte for byte the same with and without it. | A dependency nothing imports is one more thing to keep in step on every React Native update. |
