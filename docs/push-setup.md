# Push setup

Whombat reaches people's phones and browsers in one of two ways (`docs/decisions/hermes-engine.md` HE-56):

- **Through Whombat's cloud** (the commercial appliance): each notification becomes a content-free push request through
  the manager to control (`apps/server/src/managed/push.ts`: a generic kind, opaque refs and collapse keys, at most a
  short preview the person can turn off; `docs/decisions/notifications.md` NT-14…NT-16), and control delivers it.
  Nothing in this file is needed for that.
- **From the box itself**, only where it was given the keys below (the community edition, which has no control to push
  through): desktop/browser web push (VAPID), Android push (FCM HTTP v1) and iOS push (APNs) — the last two also
  carry live activities (a run in progress, a pending approval) as data pushes. Every sender checks its own config at
  the top and returns `'skipped'` (logged once, no throw, no retry) when unconfigured, so the commercial box, `pnpm dev`
  and `pnpm test:server` work with nothing set up. Configure whichever you're testing.

## Web push (VAPID)

A box sends web push itself only with a VAPID pair (`Bootstrap.capabilities.webPush`); an empty `VAPID_PUBLIC_KEY=`
line keeps it off (docs/decisions/essentials-people.md EP-17). To set one up:

1. Generate a keypair:

   ```
   pnpm --filter @whombat/server push:vapid
   ```

   This prints `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` lines ready to paste into the box's environment (`.env` in
   development).

2. Set `VAPID_SUBJECT` too (defaults to `mailto:push@whombat.com`) — the `mailto:`/URL a push service can
   use to contact you about the sender, per the Web Push protocol.

3. The public key is `devices.vapidKey` (`apps/server/src/routes/content.ts`), so the web app never needs it baked in
   at build time. The session doesn't offer that op yet (`SESSION_EXCLUDED_API_OPS`).

4. Subscription endpoints are URLs the server POSTs to, so they go through the SSRF-safe outbound helper
   (`apps/server/src/lib/outbound.ts`): `https` only, hosts of the browsers' push services only
   (`fcm.googleapis.com`, `*.push.services.mozilla.com`, `*.push.apple.com`, `*.notify.windows.com`), never a
   private address, no redirects. Other endpoints are refused at registration (400) and pruned at send time.
   A local mock push service on `http://127.0.0.1` needs `WHOMBAT_OUTBOUND_ALLOW_PRIVATE=1` (refused in
   production).

**Web app follow-up (not part of this workstream — apps/web is owned by the desktop-screens workstreams):**
the shell needs to register `apps/web/public/sw.js` and subscribe:

```js
const reg = await navigator.serviceWorker.register('/sw.js');
const { publicKey } = await api.devices.vapidKey();
const sub = await reg.pushManager.subscribe({
  userVisibleOnly: true,
  applicationServerKey: publicKey, // base64url -> Uint8Array first
});
await api.devices.register({ provider: 'webpush', token: sub.endpoint, webPush: { p256dh, auth } });
```

`sw.js` already handles the `push` (show the notification, title/body/tag from the payload) and
`notificationclick` (focus an existing window and navigate it, or open one at `data.path`) events — see
the file itself for the exact `PushPayload` shape it expects.

## Android push (FCM HTTP v1)

1. In the Firebase console, create (or reuse) a Firebase project for Whombat, then Project settings →
   Service accounts → Generate new private key. This downloads a service account JSON key.
2. Set `FCM_SERVICE_ACCOUNT_JSON` to the JSON's contents (as a single-line string; the server only reads
   `client_email`, `private_key` and `project_id` out of it — see `parseServiceAccount()` in
   `apps/server/src/push/fcm.ts`).
3. The server signs its own short-lived OAuth2 access token (JWT-bearer grant, `node:crypto` RSA-SHA256 —
   no external JWT library) and calls
   `https://fcm.googleapis.com/v1/projects/<project_id>/messages:send` directly; there's no Firebase Admin
   SDK dependency.
4. Messages are **data-only** (no `notification` block) so the Android app always gets to decide how to
   render — including turning a live-activity update into an ongoing notification. Live-activity messages
   set `android.collapseKey` to the payload kind so rapid updates coalesce into one notification slot
   instead of stacking.
5. A `404` or an `UNREGISTERED` error code prunes the device row; any other failure retries (see "Retries
   and pruning" below) and eventually just logs a warning.
6. The app: build with `GOOGLE_SERVICES_JSON=/path/to/google-services.json` (the Firebase Android app for
   `com.whombat.mobile`) so `expo-notifications` can fetch the FCM token it registers with
   `devices.register`. The `whombat-live` module's FCM service renders every Whombat data message itself —
   the live activity (ongoing notification) or the inbox notification — whether the app is open, in the
   background or killed (`docs/decisions/mobile-live.md`).

**Development without Firebase:** `FCM_RELAY_URL=http://127.0.0.1:4498/fcm` (refused in production) makes
the server post each FCM message to a local relay instead of Google; `node apps/mobile/scripts/push.mjs relay`
delivers them to an emulator running a debug build (built with `EXPO_PUBLIC_WHOMBAT_PUSH_RELAY=1`, which
registers a `dev-relay:` token when FCM is unavailable). Steps: `apps/mobile/README.md`, "Testing push on an
emulator without Firebase".

Android comes first per the project's native-Android-first decision (see the kickoff memory); APNs is
"later" and is safe to leave unconfigured.

## iOS push (APNs)

1. In the Apple Developer portal, create an APNs authentication key (.p8) — this gives you a 10-character
   Key ID and lets you download the private key once.
2. Set:
   - `APNS_KEY_ID` — the 10-character key id.
   - `APNS_TEAM_ID` — your Apple Developer Team ID.
   - `APNS_PRIVATE_KEY` — the .p8 file's contents, PEM-encoded. If you store it as a single-line env value,
     literal `\n` sequences are unescaped back into real newlines before use.
   - `APNS_BUNDLE_ID` — the iOS app's bundle id (`com.whombat.mobile`), the APNs `topic` of alerts;
     every live-activity push — to an activity's token or to the push-to-start token — uses
     `<bundle-id>.push-type.liveactivity` per Apple's ActivityKit spec.
   - `APNS_ENV` — `sandbox` (default, matches a debug-signed build) or `production`.
3. The server signs its own ES256 provider token (token-based auth, one token shared across requests,
   cached for 55 minutes) and posts over HTTP/2 (`node:http2`) to `api.sandbox.push.apple.com` or
   `api.push.apple.com` — no APNs library dependency.
4. Live activities: a registered per-activity update token (from the device registering interest in that
   run/approval) is preferred; otherwise the account's push-to-start token is used so the activity can be
   started remotely. A device with neither is skipped for that activity — it hasn't opted in yet. See
   `devicesForActivity()` in `apps/server/src/push/devices.ts`. The payload's `attributes-type` is
   `WhombatLiveAttributes` (one type for runs and approvals, so one push-to-start token), `attributes` is
   `{ key, kind, number, burrow }` and `content-state` is the `LiveActivityDisplay` the widget renders; a
   start carries an `alert`, an end a `dismissal-date` 30 minutes out. Alerts carry `path`, `burrow` and
   `notificationId`, so a tap opens the screen and marks the inbox row read.
5. A `410`/`BadDeviceToken` response prunes the device; other failures retry then give up, same as FCM.

## Retries and pruning

`PushSender` (`apps/server/src/push/sender.ts`) is the single place every notification and live-activity
push goes through. It dispatches by `device.provider`, retries a `'failed'` outcome twice with a
250ms/1000ms backoff (both injectable for fast tests), and deletes the device row outright on a `'prune'`
outcome (the push service told us the token is dead). `'skipped'` (transport unconfigured) never retries.

## Where this plugs in

- `NotificationService`'s inbox fan-out (`apps/server/src/domain/notify.ts`) sends a push alongside every
  realtime `notification.created` row, for "needs you", mentions and agent DM updates.
- `LiveActivityBroadcaster` (`apps/server/src/domain/live-activity.ts`) turns `run.updated` /
  `approval.updated` into `start`/`update`/`end` data pushes, throttled to one `update` per 2s per
  activity (the latest one inside a window goes out when it closes); `start`/`end` always go through
  immediately. Each push carries `liveActivity.display`, built by `@whombat/core`'s `runLiveActivity` /
  `approvalLiveActivity` — the same the app uses for its own realtime updates. See
  `docs/decisions/notifications.md` and `docs/decisions/mobile-live.md` for the lifecycle and recipient rules.
