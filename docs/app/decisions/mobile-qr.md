# Mobile app by QR code (2026-09-30): decisions

John, 2026-09-30: “When clicking on ‘Mobile app’ in the side menu, show a download link for the APK (temporary, until
the app is in the stores). We should also get a way to quickly log in to the mobile app via a QR code. Make this the
main default route to log in to the mobile app.” Control's side is CT-190 (phone handoffs) and CT-191 (the Android
download) in whombat-contracts. AP-520 and AP-529 are the shared client and the release script; AP-521…AP-528 are
the web's.

### AP-520 The link, its key and the report's MAC (`@whombat/client/managed/phone-handoff.ts`)

The browser shows `<hosted UI>/auth/phone#t=<token>&k=<key>&d=<device>&p=<PeerId>` as a QR code (`phoneSignInLink`;
`d`/`p` only with a Whombat open). `t` is control's one-time token (5 minutes), `k` 32 random bytes the browser made
for this code (`newPhoneHandoffKey`), `d`/`p` the Whombat to ask and its identity as the browser pinned it (the phone
pins it from the code, like an add-a-device link, AP-66). Everything is in the fragment, so no server log sees it.
The phone redeems the token, asks the Whombat to pair and reports `{code, fingerprint, mac}` through control, the MAC
an HMAC-SHA256 under `k` over `whombat-phone-handoff/1\n<handoffId>\n<code>\n<fingerprint>` (`phoneHandoffMac`):
control relays the report but can't forge or swap it. `verifyPhoneHandoffReport` checks it in constant time;
`parsePhoneSignInLink` accepts the hosted UI's origins and `whombat://auth/phone#…`. Polling interval
`PHONE_HANDOFF_POLL_MS` = 1.5 s.

### AP-521 `/mobile` stays in the sign-in frame; what it shows where

*Superseded in part by docs/decisions/settings-phone-link.md SPL-05 (on a phone's own screen, Open in the Whombat app comes before the code), SPL-07 (Back returns to where the person came from) and SPL-23 (with a Whombat open the page is Settings → Phone app inside the app; the sign-in frame stays only where none is open).*

- **Frame.** The page keeps the frame of the page it replaces (AuthLayout: Clover's aside, a 720px column with the
  kicker, the 44px title and the sub), not the burrow shell. It is one focused task (scan, compare, confirm) that
  reads best without the sidebar's noise; it works where there is no burrow yet; and the route stays where it was
  (outside the burrow routes: no change to the router or to the shared `BURROW_ROUTES`, which the phone app reads
  too). “← Back to your burrow” at the end, like before.
- **Managed, a Whombat open:** “Sign in on your phone” first (the QR code naming that Whombat), then “Get the app”.
- **Managed, signed in without a Whombat open** (only by typing `/mobile`; ManagedRoot renders it instead of sending
  the person to the list): the code names no Whombat, so it only signs the phone in (`AccountMobilePage`), and “Back
  to your Whombats”.
- **Self-hosted server:** no QR code (its app signs in with email); “On this server, the app signs in with your
  email, like this browser did.” and the download.
- **Narrow viewports (≤ 720px, a phone's own screen):** “Get the app” comes first (a phone can't scan itself), and
  under the code “On this phone already?” with “Open in the Whombat app” (the same link in the app's scheme, AP-526):
  the app on this phone opens it as if scanned; coming back to the tab shows the confirmation.

### AP-522 The browser's side is a pure state machine (`features/mobile/phoneSignIn.ts`)

States `starting → waiting (QR) → scanned → lookingUp → confirm → success`, plus `error`; `usePhoneSignIn` does the
calls. Rules:

- A code is made, polled and counted down **only while the tab is visible** (`visibilitychange`), and nothing runs
  after unmount. When the token runs out unused (its `expiresAt`, or control says `expired`) a new code appears by
  itself; a scanned code no longer needs its token and is followed until its handoff ends (`not_found` /
  `handoff_expired` → a new code with “That took too long.”).
- A `pairing` report counts only if its MAC checks out under this code's key **and** the code named a Whombat. Then
  the Whombat is asked which device shows that code (`enroll.pair.lookup`); its fingerprint must equal the reported
  one. Either check failing lets nothing in and shows a fresh code with “That answer didn’t come from the phone that
  scanned the code, so nothing was let in.” A `signed_in` report (or state `done`) is success without a question.
- Only “Let it in” approves (`enroll.pair.approve` with the looked-up fingerprint, CT-46). “Not my phone” declines the
  request and shows a fresh code (“Not let in.”). An approval that fails as `failed`/`rateLimited` keeps the question
  with a note; any other pairing error (gone, expired, taken over) ends in the error with “Scan a new code”.
- Four failed polls in a row (6 s) before “Couldn’t reach Whombat’s service…”; `signed_out` at once.
- Every async answer names its code (generation or handoff id), so a late one for an older code changes nothing, and
  each call is made once per state object (React StrictMode runs effects twice).

### AP-523 QR codes: `uqr`, level M, a fixed light plate

- `uqr` 0.1.3 (MIT, no dependencies; UnJS's port of Nayuki's generator) encodes; `components/QrCode` renders one SVG
  path of horizontal runs, `shape-rendering: crispEdges`, error correction **M**, a **4-module quiet zone**, and
  modules of a whole number of CSS pixels (at most 272px overall: a ~210-character link is version 10–11, 260–276px).
  Narrower containers scale the SVG down.
- Dark modules on a light plate in **both themes** (`--avatar-ink` on `--knob`, tokens that are the same in light and
  dark): phone cameras and scanner libraries expect dark-on-light, and inverted codes fail on many of them.
- No Whombat mark in the centre: it needs level H, which makes this link's code denser (version 13+) and harder to
  scan from a laptop screen. “Add a device” (AP-66) keeps its link without a QR code: it is opened on the new device,
  and phones now use this page.

### AP-524 How the states look

*Superseded in part by docs/decisions/settings-phone-link.md SPL-03 and SPL-04 (a fresh code's reason heads the card; no code takes the whole card; the fingerprint card's words).*

- **Waiting:** the code on its plate on the left; “Scan to sign in” and three numbered steps on the right (the
  onboarding's 26px dots): “Install Whombat on your phone” (“No app yet? Point your phone’s camera at this code: it
  opens the download.”), “Open the app and tap “Scan the QR code””, “Point your phone at this code”; under a divider
  “It signs your phone in as you and asks {Whombat} to let it in.” A quiet mono “New code in 4:32” under the code.
  A fresh code's reason takes the divider line's place (bad tone when refused), so the card keeps its height.
- **Scanned / checking:** the code's place shows a check, “Your phone scanned the code” and “Waiting for it to ask
  {Whombat}…” (“Checking your phone with your Whombat…” during the look-up); the three steps turn into ok checks.
- **Confirm:** the card becomes the approval card (1.5px warn border, `YOUR PHONE IS ASKING TO COME IN`): “Let Pixel 9
  in?”, “Android phone · It gets the same access to {Whombat} as this browser.”, a FINGERPRINT panel “Your phone shows
  the same: AB12-CD34-EF56” (24px mono), “Check that the two match before you let it in.”, **Let it in** / **Not my
  phone** (xl).
- **Success:** centred ok circle, “Pixel 9 is in”, “Your phone is signed in to {Whombat}. Pick it up and carry on
  there.”, “Sign in another phone”. Nothing to confirm: “Your phone is signed in”.
- **Errors:** in the code's place: an alert icon, one sentence and “Try again”.
- The card keeps one height through its states at desktop widths (342px), so the page doesn't jump. Focus moves to
  the confirmation's and the success's heading; one polite live region says each change; reduced motion stops the
  spinners (the inline one goes).

### AP-525 Get the app

*Superseded in part by docs/decisions/settings-phone-link.md SPL-06 (a row for the iPhone app with Ask for an invite; Try again after a failed check).*

`control.androidDownload()` (CT-191): “Whombat for Android”, “Version 0.16.0 · 41 MB · APK” (decimal units, like
Android: `41 MB`, `8.4 MB`, `950 kB`), **Download for Android** as a plain `<a href download>` to control's file
(served as an attachment), and “The first time, Android asks to allow installs from your browser. Allow it, then open
the file. iPhone: coming later.” None published: “The Android app isn’t published here yet. Check back soon.” No
second QR code for the APK: the sign-in code opened by a phone's camera lands on `/auth/phone`, which offers it
(AP-526). The self-hosted build has no control session and asks control's public endpoint
(`VITE_WHOMBAT_CONTROL_URL`, else api.whombat.com) only when the page is opened; fixture mode uses a fixed record.

### AP-526 `/auth/phone` in a browser

ManagedRoot serves it before anything else, signed in or not (never a sign-in's `next`). The page reads the fragment
once into memory and takes it out of the address bar and history; it never redeems the token and sends nothing.
“Open this with the Whombat app” / “This code signs a phone in to Whombat. It works in the app, not in a browser.”,
**Open in the Whombat app** (the same link as `whombat://auth/phone#…`), “No app yet? Install it, then scan the code
again.”, the download, and “On a computer? This code is for your phone: scan it with the Whombat app.” A missing or
malformed link: “This link is incomplete or already used. Show a new code on your computer.”

`/mobile` signed out is public too (`PublicMobilePage`, added at merge): the phone app's “Update the app” opens
`<ui>/mobile` in the phone's browser (AP-537), which usually isn't signed in to the web, so the page shows the download
and “Sign in on this device” instead of asking for a sign-in first. Signed in, `/mobile` is the QR page.

### AP-527 The fake world simulates the phone

The fake control keeps handoffs like control (token 5 minutes, handoff 15; `invalid_link` for a used token,
`not_found` after) and hands out a plausible APK. Hooks on `window.__WHOMBAT_FAKE__`: `phoneScan(link?)`,
`phoneReport(link?, {label, kind, tamper: 'mac' | 'fingerprint'})` (a real pending pairing on the Whombat the code
names, `Pixel 9`, Android, with the MAC under the code's key), `expirePhoneHandoff()`, `phoneHandoffs()`,
`phoneLetIn()`, `androidDownload(value | null)`. Without a link they take the one on screen: fake builds only
(`VITE_WHOMBAT_FAKE=1`) put it on the code's element as `data-phone-link`; production builds never do. Demo: open
`/mobile` in `pnpm dev` with the fake world, then `__WHOMBAT_FAKE__.phoneScan()` and `__WHOMBAT_FAKE__.phoneReport()`
in the console.

### AP-528 Tests

Unit: the state machine (expiry → refresh, MAC failure and fingerprint mismatch never approve, decline, blips,
unreachable), the page against a fake control and Whombat (hidden tab makes no code, refresh on expiry, approve only
after “Let it in” with the looked-up fingerprint), `/auth/phone` (fragment leaves the address bar, nothing is sent,
the app link round-trips), `/mobile` through the router and the sidebar. e2e (`e2e-managed/phone.spec.ts`): QR →
scan → pairing → confirm → let in, forged reports, “Not my phone”, `/auth/phone`, no APK; `PHONE_SHOTS=<dir>` writes
review screenshots (desktop and 390×844, light and dark).

### AP-529 Publishing the APK (`apps/mobile/scripts/publish-apk.mjs`)

`pnpm --filter @whombat/mobile publish:apk --env dev|prod --dir <dir>` copies a built, signed APK into control's
`DOWNLOADS_DIR`, where `downloads.android` (CT-191) finds and serves it.

## The phone app's half (AP-530…AP-539)

### AP-530 QR first on the sign-in screen

Signed out, the managed app opens on “Sign in with your computer”: a picture of the computer showing the code and this
phone scanning it (drawn with react-native-svg from theme tokens and the brand's small symbol, a slow scan line that
stops under Reduce motion), one line of how (“On your computer, open Whombat and choose Mobile app in the sidebar. Then
scan the code it shows.”), the primary “Scan the QR code” (52dp, with the scan icon), and “Sign in with email instead”
as a quiet button. Email is the same form as before under “Sign in with email”, with “Scan the QR code instead” back.
Clover's tip says what one scan does. `Frame` got a `hero` slot so the screen stays in the managed screens' language.

### AP-531 The code arrives by the app's camera or by a link

`appUrl` (incoming.ts) sorts everything that opens the app: a magic link, the phone sign-in link
(`<ui>/auth/phone#…` or `whombat://auth/phone#…`, parsed by `parsePhoneSignInLink`), a link for the signed-in tree, a
notification tap. `ManagedApp.onUrl` handles the sign-in link signed out and signed in. Android gets an App Link filter
for `/auth/phone` on the UI origins, so the phone's own camera app opens Whombat too. The camera permission text now
names both codes it reads. (The AP-367 test's list of the app's own paths gained `/auth/phone`.)

### AP-532 One scanner, worded per use

`QrScanner` takes its title, close label and way out as props (defaults: the claim card's), and draws a viewfinder
over the camera (white, red while it says a code isn't the right one). `PhoneScanner` reads sign-in codes only; anything
else says “That isn’t a Whombat sign-in code. …” and keeps looking.

### AP-533 The Whombat in the code is pinned like an add-a-device link

The code is made by a browser that is enrolled on that Whombat and names its identity, exactly the trust basis of an
add-a-device link (AP-66), so a new pin is stored with `pinSource: 'add-link'`. No new `PinSource` value: it would
change a shared type in `@whombat/client` for a label nothing reads. `planHandoff` compares the code, the pin and the
directory with `trustDecision` before anything is sent: a pin that differs from the directory is the `changed` stop; a
code naming another identity is a new `code` stop (“This code doesn’t match your Whombat”, worded for a code instead of
a link). A Whombat that isn't in this account's first organization (the only one the phone app opens) is a plain
message; the phone is signed in either way.

### AP-534 The progress screen and the pairing screen

After a scan: “Signing you in” → “Asking your Whombat to let this phone in” → “Confirm on your computer”, as a
three-step card (done ✓, in progress, to do, failed ×; each step labelled for TalkBack). Confirming shows this phone's
name and its pairing fingerprint large in mono with “Check that your computer shows the same.”, and polls
`enroll.pair.status` like `PairScreen`. Approved → the record is marked enrolled (with the account id) and the Whombat
opens; declined, expired or too long → “Scan again”. The signed-in pairing screen (“This phone isn’t trusted by this
Whombat yet”) leads with “Scan the QR code from your computer”, then “OR SHOW A CODE” and the code-based pairing; a scan
there goes through the same flow (a fresh token; the same account keeps its tree).

### AP-535 Where the state lives, and what's retried

The flow's decisions are pure and unit-tested in `phoneSignIn.ts`: error mapping (`redeemErrorOf`, `reportErrorOf`),
the actions each error offers, `planHandoff`, the pairing report (the MAC over exactly the code and fingerprint
reported) and `runPhoneHandoff`, which runs the rest against injected dependencies and reports views. The token is
exchanged in `ManagedApp` (`redeemPhoneToken`, once per token; a failure is forgotten so “Try again” asks again), and
the exchanged handoff is held in `ManagedApp`'s state until the signed-in tree takes it, so it survives that tree's
remount when the code signs in another account (the new account replaces the old one here, as a magic link does).
Control calls that didn't get through (`unavailable`, `rate_limited`) are repeated after 1, 2 and 4 seconds, then the
screen says so with Try again. The `signed_in` report is a courtesy (the computer stops waiting): if it doesn't get
through, the phone goes on anyway. Polling stops when the handoff's 15 minutes are over.

### AP-536 Error copy

The title carries the first sentence and the text says what to do, without repeating it: “This code has expired” /
“Show a new one on your computer and scan again.”; “Couldn’t reach Whombat” / “Check your connection and try again.”;
“This phone wasn’t let in”, “Nobody confirmed in time”, “Couldn’t reach your Whombat”, “This Whombat isn’t in your
organization”, “Too many tries”. Signed out, every error also offers “Sign in with email instead”.

### AP-537 “Update the app” opens the web's Mobile app page until there is a store listing

The Play Store listing `STORE_URL` points to doesn't exist yet. The `client_too_old` and below-floor gates, the skew
notice and “This needs a newer version of the app” now open `UPDATE_URL` = `<first UI origin>/mobile` (the hosted UI's
page with the Android download, CT-191), labelled “Update the app”, and their text says “Update the app” instead of
naming the app store. `STORE_URL` stays for when the listing exists; switching back is changing `UPDATE_URL`.

### AP-538 Left as it was

The legacy (self-hosted) app is unchanged. Scanning a code from another account while signed in replaces the session
here without signing the old one out at control, as a magic link opened while signed in already does.

### AP-539 Verified

Unit tests (`phoneSignIn.test.ts`, `incoming.test.ts`), `pnpm check`, and screenshots on an Android 16 emulator
(368 × 822 dp at 3×) of the sign-in screen (light, dark), email, the scanner (light, dark), the progress, confirm and
error screens and the pairing screen, from a managed debug build; the real app for sign-in, scanner and a `whombat://
auth/phone#…` link reaching the redeem and its error, a throwaway preview for the states that need a live Whombat.
