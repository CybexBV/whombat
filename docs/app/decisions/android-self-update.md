# The Android app updates itself (AP-813…AP-818)

John, 2026-10-06: “Can we improve the Android update procedure so an update gets downloaded by Whombat app itself
instead of using an external browser? Take a look at how Morphe app does this.” Until now “Update” (the settings
card, SS-71; the banner and gate screens, AP-261/AP-701) opened the APK URL or the Mobile app page in the browser,
which downloaded the file to Downloads and left the rest (open it, allow the browser to install, install) to the person.

Morphe Manager (github.com/MorpheApp/morphe-manager, `UpdateViewModel`, `SessionInstaller`) downloads its own update
into app storage with a progress bar, refuses a file that isn't an APK, checks `canRequestPackageInstalls()` and opens
`ACTION_MANAGE_UNKNOWN_APP_SOURCES` when needed, and hands its own update to the system installer with
`ACTION_INSTALL_PACKAGE` through its own FileProvider (a session install would kill the process before reporting
back). Its Shizuku/root silent paths are for patched apps, not for itself.

| ID | Decision | Why |
|---|---|---|
| AP-813 | **A native module, `modules/whombat-updater` (Kotlin), downloads, checks and installs.** Download on a background thread into `cache/updates/` with progress events; then size + SHA-256 from `latest.json` (contracts already carry both), then Android reads the archive: package, announced `versionCode`, newer than the running build, signed with the installed app's key. Install as Morphe does for itself: `ACTION_INSTALL_PACKAGE`, `content://` from the module's own `WhombatUpdateFileProvider` (`cache/updates/` only), `EXTRA_INSTALLER_PACKAGE_NAME` = the app. `REQUEST_INSTALL_PACKAGES` is declared by the module. | Android shows “Do you want to update this app?” and, after, “App installed · Open”, which a session install can't (this process is gone). Checking first turns a truncated or wrong file into a clear message instead of Android's “There was a problem parsing the package”. A JS-only version (expo-file-system + an intent launcher) can't ask `canRequestPackageInstalls` or read the archive. |
| AP-814 | **First time: the app opens Android's “Install unknown apps” page for Whombat itself, and continues when the person comes back allowed.** Back without allowing: “Allow installs” with “Allow Whombat to install apps in Android’s settings, then come back here.” | One page instead of Android's “not allowed from this source” dialog plus its Settings detour; nobody has to find the setting. |
| AP-815 | **One update for the whole app** (`src/managed/appInstall.ts`, pure and unit-tested; `useAppInstall` binds it to the module and AppState). Steps: Update → “Downloading 34%” (card: “0.44.0 · 34 of 96 MB”) → [Allow installs] → Android's installer. Cancelled installer → “Install” (no second download: an intact staged file is reused). A download that finishes in the background waits until the app is in front (Android doesn't start the installer from the background). Failures say why: connection, didn't check out, not signed like this app, installer didn't open — with “Try again”. | The card, the banner and the gate screens show the same download; tapping any of them twice never starts two. |
| AP-816 | **Every “Update the app” uses it** (`UpdateAppButton`: the gate screens and NeedsNewerApp with a note under the button, the banner's quiet button) when an APK newer than this build is published and the module is in the build; otherwise the Mobile app page as before (the iPhone, nothing newer published, builds before 0.44). | One way to update on Android. |
| AP-817 | **No resume and no metered-network prompt.** Control's APK route has no `Range`; a broken download starts again. The size is on the card before the tap. Staged files not newer than the running build are deleted at start. | Small enough for now; Range on control is the follow-up if phones on poor connections need it. |
| AP-818 | **Release 0.44.0.** Mobile only: no contract or web change, so the Whombat vendor pin stays at 0.43.1 and DEV gets the APK (`publish:apk --env dev`). Phones on 0.43.x update once more through the browser; from 0.44.0 on, updates happen in the app. | The updater has to be installed before it can update. |

### Checks

`pnpm check`; on the API 36 emulator a release build 0.44.0 (release key) against a local stand-in for
`downloads.android` serving 0.44.1: progress on the card and the button, Android's “Install unknown apps” opened,
back without allowing → “Allow installs”, allowed → the installer opened by itself, Cancel → “Install” without a
second download, Update → “App installed”, Open → 0.44.1 runs with the card gone; `dumpsys package` shows
`installerPackageName=com.whombat.mobile`. A wrong SHA-256 → “The download didn’t check out, so nothing was installed.”
The test screen (the card on the signed-out screen) was a local change, not committed.
