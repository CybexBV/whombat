# whombat-live

Live activities for Whombat mobile (DECISIONS D-08, A-12): a run in progress and an approval that needs a
person stay visible outside the app.

Every path renders `@whombat/core`'s `LiveActivityDisplay` as is — the server's data pushes carry it
(`LiveActivityPush.display`), and the app builds the same one from realtime events with
`runLiveActivity` / `approvalLiveActivity`. Native code builds no copy.

## Layout

```
expo-module.config.json   autolinking: com.whombat.live.WhombatLiveModule (Android), WhombatLiveModule (iOS)
index.ts                  WhombatLive: show / end / endAll / active / recent / shade / cancel / configure /
                          pushToStartToken / launchPushTap / lastGenericPushAt, events
src/content.ts            pure: who sees which activity, reconcile, token colors (tested)
app.plugin.cjs            iOS config plugin: Live Activities on, widget extension target
android/
  WhombatLiveModule.kt    the Expo module (upsert, end, endAll, setStatusWidget, clearStatusWidget, active,
                          recent, shade, cancel, configure, launchPushTap, lastGenericPushAt)
  LiveDisplay.kt          `LiveActivityDisplay` read from its JSON, and the screen it opens
  LiveColors.kt           tone colors from the tokens, kept for pushes while the app is closed
  LiveNotifications.kt    rendering: Android 16 ProgressStyle / NotificationCompat, channels, actions
  StatusWidgetStore.kt    saved calm status for the home-screen widget (SharedPreferences, day rollover)
  WhombatStatusWidgetProvider.kt  RemoteViews home-screen widget (opens the app on tap)
  WhombatPush.kt          a Whombat data push → live activity or inbox notification
  WhombatMessagingService FCM data messages (app open, backgrounded or killed)
  WhombatLivePackage.kt   keeps a deep link that arrives while the activity is recreated
  src/debug/…             DebugPushReceiver: inject a payload with adb (debug builds only)
ios/
  WhombatLiveAttributes.swift  ActivityKit attributes (ContentState = the display); app + widget
  WhombatLiveModule.swift      the Expo module; activity / push-to-start token events; App Group status widget sync
  widget/                      the Live Activity UI (Lock Screen, Dynamic Island), the gated home-screen status
                               widget (`WhombatStatusWidget.swift`), `PrivacyInfo.xcprivacy` and Info.plist
```

## Android

- One notification per activity, tagged `whombat.live:<key>` (`run:<id>`, `approval:<id>`), so a push and
  a realtime update replace the same one.
- Android 16: `Notification.ProgressStyle` (one segment for a run, one per condition for an approval), a
  tracker icon, the status-bar chip text (`62%`, `2/3`) and `android.requestPromotedOngoing` for Live
  Updates. Older versions: an ongoing `NotificationCompat` with a progress bar.
- Actions: `Open run`; `Review` (the `approve` action: opens the approval, needs unlocking; the person approves
  there) and `Details`.
- An ongoing one goes 10 minutes after its last update (each update starts the 10 minutes again), so one that
  nothing updates any more doesn't stay (MN-02); `recent()` lists what was shown in the last 24 hours, so the app
  refreshes what is on screen and shows what is new without bringing back one that timed out or was swiped away.
- An ended display stays as a dismissible last state for 30 minutes.
- Inbox pushes (needs you, mentions, agent updates) become normal notifications that open
  `whombat://open?path=…&burrow=…&notification=…`.
- A managed Whombat's push (control's data-only FCM message: `kind`, `ref`, `title`, `body`, `tag`, `clear`) shows
  its preview, else “Whombat” and the kind's line, one notification per `tag` (`whombat.push:<tag>`, updated without
  sounding again); `clear` removes it. The lock screen's public version says only the kind (AP-807).
- `shade()` lists the inbox and managed notifications showing (tag, kind, and an inbox push's burrow, row and path or a
  managed push's ref) and `cancel(tags)` removes them: the app cancels what was read in the app (MN-04,
  `src/push/ShadeBridge.tsx`).
- Opened again from Recents after the process was killed, the activity's replayed launch intent loses its link and
  push data (`LatestIntentListener`), so the app restores where the person was instead of the old link (MN-01).

## iOS

- `Activity<WhombatLiveAttributes>` started or updated by `upsert`, ended by `end`; updated by APNs
  `liveactivity` pushes to its push token, or started by a push-to-start push (iOS 17.2+).
- Tokens arrive as events (`onActivityPushToken`, `onPushToStartToken`), but the app doesn't send them anywhere yet:
  an activity updates from `upsert` while the app runs.
- Built on macOS: `apps/mobile/README.md` "iOS".
