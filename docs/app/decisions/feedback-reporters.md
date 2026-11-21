# Feedback: navigation trail and reporter sign-in in the apps (AP-427…)

Workstream `feedback-reporters` (2026-09-30), stream W of Whombat `docs/implementation/feedback-reporters/assignment.md`
§5: the widget (loader and frame), the web app and the legal pages. The spec there is settled, as are the contracts
`CT-160…CT-165` (`whombat-contracts/docs/decisions/contracts.md`, contracts 0.25.0) and the runtime's `FR-*`
(`Whombat/docs/decisions/feedback-reporters.md`). For these two features they supersede, in this repository, FB-B06's
“closed, nothing is watched” (the loader now watches the address while the trail is on) and FD-28 (7)'s storage ban
in the frame (lifted for exactly one key, AP-429). Numbers continue `subscriptions.md` (AP-426 is the last there).

## AP-427 The loader records the trail

- Unless the script says `data-trail="off"` (exactly that value, as core's `WIDGET_ATTRIBUTES.trail` documents), the
  loader records a step on install, on `popstate`/`hashchange` and on a 1 s comparison of the sanitized address that
  runs **always**, open or closed (a pushState navigation fires no event). Opening the panel and every context push
  record first, so the last step is always the page the report is sent from.
- A step is `{url: sanitizePageUrl(location.href), title: cleanText(document.title, 160) || null, at: ISO time}`. The
  same address as the last step only refreshes its title, and only to a non-empty one (an SPA that blanks the title
  while it loads doesn't wipe it). The last 10 are kept.
- Stored as JSON in the host tab's `sessionStorage` under `whombat-feedback:trail` (per origin and tab, gone when the
  tab closes). A stored value is read with the frame's own strict `parseTrail`; anything else starts a fresh trail. A
  storage error keeps the trail in memory for the page. `data-trail="off"` removes the key and sends no `trail` at all.
- `destroy()` stops watching but leaves the stored trail (the page may load the widget again).
- `WidgetContext.trail` is parsed strictly by the frame (`parseTrail`: ≤ 10, exactly `url`/`title`/`at`, lengths as
  core's, `at` in core's `Timestamp` form). One malformed step refuses the whole message, like any other context field,
  which is why the loader validates what it reads back from storage.
- Budget: the loader is 7,924 bytes gzipped (7.4 KB → 7.8 KB of the 8 KB budget); `parseTrail` and the timestamp
  pattern are the bulk of the growth, and the loader shares them with the frame rather than trusting stored data.

## AP-428 The frame sends the trail; “Steps to reproduce” leaves the form

- `steps` is gone from the draft, the form, validation and the draft key; the submission always sends `steps: ''`
  (the field stays in the contract for older widgets and old reports).
- With `config.trail` (absent = false: an older runtime), `submissionContext` applies the integration's
  `redactPaths` to every step's address (a step that no longer sanitizes is left out) and adds `trail`; without it no
  trail is sent or shown, whatever the loader sent.
- “What will be sent” lists the steps under “Pages you visited on this site before reporting (up to 10):”, address and
  title per step, in an ordered list labelled by that line. The privacy line is always “Nothing else from the page is
  sent: no cookies, stored data or form contents.” (it no longer claims “browsing history”).

## AP-429 One storage key in the frame, checked at build time

- `src/frame/reporter-store.ts` is the only frame module that names `localStorage`: key `whombat-feedback:<site>`
  holding `{token, email, name, expiresAt, sent}`; `sent` keeps the last 50 reports sent while signed in as
  `{reference, type, summary, at}`. **`type` is added to the spec's shape** so a report the server doesn't list yet
  (drop mode, AP-431) can still show “Problem”/“Idea”.
- The frame touches storage only when the config says `reporters: true`; otherwise FD-28 (7) holds exactly as before
  (its unit and e2e tests are unchanged for that case).
- A stored session that is malformed or expired is removed on load. Storage that is missing or throws (blocked
  third-party storage, a getter that throws) is not an error: the session lives in memory while the frame is open.
- The build bans cookies, `sessionStorage`, IndexedDB, the Cache API, service workers, Web SQL, HTML parsing and eval in
  the whole frame bundle as before, and additionally reads every source file esbuild bundled into the frame (its own
  modules and every dependency, from the metafile) and fails when any but the store module names `localStorage`.
  `embed-build.test.ts` tests both checks; `drop.test.ts` runs a signed-in drop-mode session with every other storage
  trapped and asserts `localStorage` is reached only from the store module and only for that one key; the drop e2e
  does the same in Chromium.

## AP-430 Sign-in in the frame: views, copy, focus

- Tabs “New report” / “Your reports” are toggle buttons (`aria-pressed`) in a row under the header, shown only while
  sign-in is offered. “Your reports” is pressed for the sign-in view and the list. “New report” returns to the draft as
  it was, or to a fresh form after a receipt. A site trigger asking for a type (`open({type})`) leaves sign-in or the
  list for the form.
- The dialog's title stays “Send feedback”; the sign-in view has its own heading “Follow your reports” (h2), the list a
  visually hidden “Your reports” heading that takes focus.
- Signed out, the contact group ends with the link-button “Sign in to follow your reports” (the contact group now shows
  whenever sign-in is offered, even with both contact fields off). Signed in, it shows “Signed in as {email} · Sign
  out”, the email field is gone and the session's address is the reporter's email **even when the integration's email
  field is off** (the visitor chose to identify themselves; the runtime and control's attestation need it). The name
  is prefilled from the session, remembered on each send and on a new draft.
- Sign-in view: the email step (“We’ll email you a 6-digit code. …”, Email, **Send code**, **Back**), then the code step
  (“Enter the code we sent to {email}.”, one input `inputmode="numeric"`, `autocomplete="one-time-code"`, maxlength 6;
  **Sign in**; link-buttons “Use a different email” and “Send a new code”, the latter enabled 30 s
  (`FEEDBACK_REPORTER_RESEND_S`) after the last code). After a resend it says “We sent a new code. Earlier codes no
  longer work.” (the lead's note: only the newest code works). Spaces in a typed code are ignored.
- Local checks: “Enter an email address like name@example.com.”, “Enter the 6-digit code from the email.”. Server
  answers: `code_refused` and `signed_out` use core's public messages (repeated in `reporters.ts`, a test keeps them
  equal); 429 says “Too many sign-in attempts from here. Try again in N minutes.” (the public `rate_limited` message
  talks about reports); 404 on the code or session route says “Signing in isn’t available on this site right now.”;
  5xx and no answer have the form's wording.
- Focus: the link moves focus to the email field, Send code to the code field, Sign in to the “Signed in as” line
  (form) or the list heading, Back to the sign-in link, sign-out to the sign-in link or the email field; the tabs keep
  focus when clicked. Status changes (“We sent a code to …”, “Signed in as …”, “Signed out.”, “Your reports are up to
  date.”) go to the frame's polite live region; errors to the footer's `role="alert"` box or under their field.
- Receipt, signed in: “You can follow it under Your reports.” under the existing hint.

## AP-431 The reporter routes from the frame

- Direct mode: `sites/:site/reporter/{code,session,reports}` resolved against the frame's own URL (the runtime's
  `/embed/v1/…`, same-origin, `mode: 'same-origin'`). Drop mode: control's `/v1/feedback/sites/:site/reporter/…`
  (`reporterCodePath` etc. in `drop.ts`, a test keeps them equal to `feedbackDropApi` and core's
  `FEEDBACK_PUBLIC_PATHS`), `mode: 'cors'`. Always `credentials: 'omit'`, `cache: 'no-store'`, `redirect: 'error'`,
  `referrerPolicy: 'no-referrer'`.
- `Authorization: Bearer fbrs_…` only when signed in: on the report POST, the drop POST, `GET …/reports` and the
  sign-out DELETE, never on the code or session requests. The draft key includes the signed-in address, so signing in
  or out between attempts rebuilds the body (in drop mode a new envelope and id, FD-28 (5)).
- A 404 on the code or session route means sign-in isn't offered here (sign-in off, no mail, parent not allowed, older
  server): the tabs and the link go away for the rest of the frame's life and a stored session is forgotten. A 404 on
  the list keeps the session and says “Your reports can’t be shown right now. Try again later.” with Try again (the
  lead's note: control answers 404 while a site's drop or sign-in is switched off). 401 on the list forgets the session
  and returns to sign-in with the public message.
- Sign-out forgets the session locally first, then sends the DELETE and ignores its answer.
- The list shows the server's rows (unknown types or statuses from a newer server are left out, AP-262) with the
  server's summary, else the frame's own (control's is always null). Reports sent from here that the server doesn't
  list yet (a drop not collected yet) show as “Received” for 7 days (the drop's lifetime), newest first.

## AP-432 Words and dates in “Your reports”

Type from core's `REPORTER_TYPE_COPY` (“Problem”/“Idea”), status from `REPORTER_STATUS_COPY` per type, the reference in
mono, the received date as “29 Sep” in the visitor's time zone (“3 Dec 2025” in another year), the summary clamped to
two lines. A status dot (tokens: idle for received/closed, brand for reviewing/confirmed/in progress, waiting for needs
more information, ok for fixed) is decorative; the words carry the status. Empty: “No reports yet. Reports you send
while signed in appear here.” Footer: Refresh and Close.

## AP-433 Widget 1.2.0

`WIDGET_VERSION` and the package are 1.2.0. The e2e stub and drop mode's fake control answer the reporter routes
(`StubReporters`, fixed code `123456`); new scenarios cover the trail, `data-trail="off"`, an older runtime's config,
sign-in with a refused and a good code, a verified report, the list with five statuses, an ended session, sign-out and
a server without the routes. `e2e/run.ts --shots` adds `{desktop,mobile}-{light,dark}-{trail,signin-email,signin-code,
reports,reports-empty,signed-in-form,receipt-signed-in}.png`. The real-server e2e no longer fills Steps.

## AP-434 The web: report details and the Widget step

- Report details, CONTEXT: “Pages before reporting”, an ordered list of each step's path (mono), title and “N min
  before” (from the step's `at` against `sentAt`, both the visitor's clock: “under a minute before”, “8 min before”,
  “1 h 5 min before”, “2 h before”; nothing without `sentAt`). The reporter line gets “Email verified” (MailCheck icon
  and text in `--ok`, `role="img"` with the label “Email verified: the visitor signed in with this address”) when
  `submitted.reporter.verified` and there is an address. Old reports keep showing Steps when present. Neither needs an
  explicit feature check: older runtimes' answers carry `trail: []` and `verified: false` by default.
- The Widget step, after ASK FOR AN EMAIL: “PAGES VISITED” (“Send the last 10 pages” / “Don’t send”) and “REPORTER
  SIGN-IN” (“Let visitors sign in to follow their reports” / “Off”), wide segmented choices, only when the runtime has
  `feedback.reporters`. The form model always carries both switches; an older runtime's settings parser strips them
  (CT-161's accepted skew). No hint of our own about mail: a self-hosted runtime without mail answers
  `reporters: false` and says so in its own health.
- Visual baselines: the report details (light, dark) updated; `feedback-integration-widget-{light,dark}` added.

## AP-435 The snippet says `data-trail="off"`

The runtime builds its snippets with core's `basicSnippet`/`customLauncherSnippet`, which don't know the attribute. The
integration page therefore adds `data-trail="off"` before `defer` in both snippets when the integration's trail is off,
unless the snippet already carries a `data-trail` (so a runtime that adds it later isn't doubled).

## AP-436 Privacy Policy `2026-09-30-draft`

Section 4's Feedback widget paragraph says what the trail sends (at most 10 pages, no query or fragment, kept in the
tab until it closes, travelling inside the encrypted report, switchable by the website) and what sign-in keeps, as
control built it (the lead's note): the address received to send the code and not kept readable, a keyed hash to
recognise the visitor and the address encrypted under the visitor's own session; a one-way hash on a signed-in drop
while it waits (≤ 7 days); each report's reference, type, status and dates, never its text; codes 10 minutes, sessions
30 days, kept in the visitor's browser for that website; list entries deleted when the site leaves the hosted drop;
on a self-hosted Whombat all of it on the organization's own server. Section 7
names both browser keys; section 10 adds the sign-in retention. The Terms of Service don't describe the widget's data
and are unchanged. The app release version is not bumped here (the lead releases 0.15.0).
