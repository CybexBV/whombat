# The phone finds a new app without being closed (AP-2970…AP-2979)

John, 2026-10-20: “In the Android app I sometimes have to force close the app to find a new update of the app … Perhaps
add an extra settings option where I can see the current version and refresh to check for new updates?” The cause: the
app asked control for the published APK (`downloads.android`) and kept the answer an hour, in memory for the life of
the process (AP-701). Coming back to the app, opening Settings, a new screen: the same answer. Control was fine
(`no-cache`, `latest.json` read on every request); only a fresh process forgot. I proposed the four points below, John:
“yes”. Phone only.

| ID | Decision | Why |
|---|---|---|
| AP-2970 | **One update check for the whole app** (`createUpdateCheck` in `managed/appUpdate.ts`, one per control client as before), now a small store: the last APK control named, whether it has answered, a request out, the last ask failed. Every screen reads it (`useUpdateCheck`, `useAppUpdate`, `useNewerApp`), so an answer moves the Settings card, the banner, the gate screens and the tab dot together. A failed ask keeps the APK known before it. | A check from Settings has to show everywhere at once; each hook kept its own copy before. A dropped connection shouldn't hide an update already found. |
| AP-2971 | **An answer counts five minutes** (`UPDATE_CHECK_FRESH_MS`; a failure the same): the app asks again when a screen showing it opens, when the app comes back to the front (`AppState` → `active`), when the Settings tab or a VERSION card is shown again, and every five minutes while it stays in front — each time only once the last ask is five minutes old. Was an hour, a failure ten minutes. | A new APK on DEV shows the next time the phone opens the app. The request is a few hundred bytes of JSON, so asking this often costs nothing. |
| AP-2972 | **VERSION at the bottom of the Settings tab, with “Check for updates”** (`VersionCard`, also on This Whombat's About and a server's This Whombat as before). “This app” reads “0.101.0 · build 101000” with “Up to date”, “Checking…” or “Couldn’t check just now” on a line under it when there is something to say; its button, “Check” (TalkBack: “Check for updates”; the long words squeezed the version onto three lines beside it on a phone), asks control now (`get(true)`), dimmed while it does. When a newer build is out the button gives way to the “Update available” row under it (`UpdateRow`, the card on top's row), with the same one download (AP-815). Then the Whombat's version. Placed after the list, before Sign out. The tab keeps what is on screen where it is when the card on top appears (`maintainVisibleContentPosition`): it pushed the VERSION card, just tapped, off the screen. | John asked to see the version and check by hand. The Settings tab is taller than a phone, so the answer has to show where the button is, not only in the card at the top. |
| AP-2973 | **Pulling the Settings tab down** reads its parts again and asks for a newer app the same way. | The phone's usual way to refresh a page. |
| AP-2974 | **No check where there is no APK**: the iPhone, a self-hosted server and the demo world show the versions only, without the button (no control client to ask). | Nothing to look for there. |
| AP-2975 | **whombat-app 0.101.0.** No contract change (contracts stay 0.98.0), no web change: the Whombat vendor pin stays, DEV gets the APK (`publish:apk --env dev`). A phone on 0.100.x finds 0.101.0 the old way (within the hour, or after closing the app); from 0.101.0 on, coming back to the app or “Check for updates” is enough. | The check has to be installed before it can help. |

AP-2970…AP-2975 used; AP-2976…AP-2979 kept for this work's follow-ups.

## whombat-app 0.101.0

AP-2970…AP-2974. Checks: `pnpm check`; the demo world's release APK on the Pixel 7 AVD in light and dark, with a
throwaway stand-in for control (the demo world has none, so no button there in the real build): “Up to date” after the
first answer, “Checking…” with the button dimmed, then 0.101.1 found — the “Update available” row under “This app”, the
card on top and the tab's dot together, the VERSION card staying on screen, pull to refresh at the top. Not seen on a
device: John's phone, a real control, the About page of a managed Whombat.
