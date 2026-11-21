# whombat-updater

The Android app updates itself (`docs/app/decisions/android-self-update.md`, AP-813), the way Morphe Manager updates
itself: “Update” downloads the APK control hands out (`downloads.android`, CT-191) into the app's cache, checks it and
opens Android's installer on it. No browser and no Downloads folder.

- `download(url, sha256, size, versionCode)` — streams to `cache/updates/whombat-<versionCode>.apk.partial`, emits
  `onProgress` `{received, total}` every 250 ms, checks size and SHA-256, renames, then lets Android read the file:
  package `com.whombat.mobile`, the announced `versionCode`, newer than the running build, signed with this app's
  key. A file already staged and intact isn't fetched again (a cancelled installer costs no second download).
- `canInstall()` / `openInstallSettings()` — Android 8+ asks once per app (“Install unknown apps”).
- `install(path)` — `ACTION_INSTALL_PACKAGE` with a `content://` URI from `WhombatUpdateFileProvider`
  (`cache/updates/` only). Android asks “Do you want to update this app?” and ends with “App installed · Done / Open”;
  the update replaces this process, so success never reports back.
- Staged files not newer than the running build are deleted when the module loads.

Rejection codes: `busy`, `network`, `verify`, `signature`, `failed`. The app side is
`src/managed/appInstall.ts` (steps, unit-tested), `useAppInstall.ts`, `UpdateAppButton.tsx` and
`src/settings/UpdateCard.tsx`. `REQUEST_INSTALL_PACKAGES` comes from this module's manifest; a Play Store build would
drop the module.
