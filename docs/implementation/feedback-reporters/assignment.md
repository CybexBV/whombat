# Feedback: navigation trail and reporter sign-in (2026-09-30)

John asked on 2026-09-30 (proposal reviewed, then “Implement this fully”) for two changes to Whombat Feedback:

- **A. Navigation trail.** The widget sends the last 10 page views on the site with a report, so the assessing agent
  sees how the visitor got there. “Steps to reproduce” leaves the form.
- **B. Reporter sign-in.** A visitor can sign in with their email address and a 6-digit code sent by email. Signed
  in, the form knows their name and email, their reports are marked “Email verified”, and a “Your reports” tab lists
  their reports on that site with progress. Reporting without signing in stays.

These are settled. They supersede, for these features only, the non-goals of `docs/decisions/feedback.md` (no customer
login, “My reports”, status endpoint, customer emails or verification), FB-07's “never storage / history”, FB-B06's
“closed, nothing is watched”, and FD-28 (7)'s storage ban in the frame. Decide open details yourself, record them in
your repository's decision file (§6) and move on. Shipping: dev only (dev.whombat.com and the DEV box). Production
(hosted control/web/embed and the box release) waits for John's yes.

Repositories (all on `main`, private, the maintainer account’s remote; never change the global gh account):

| Repo | What | Version today |
|---|---|---|
| `~/Code/whombat-contracts` | `@whombat/core`, `@whombat/control-contracts` (+ Go), `@whombat/protocol` | 0.24.0 (CT-159) |
| `~/Code/Whombat` | the runtime on each box (`apps/server`, `packages/agent-runtime`) | FB-27, FD-57 |
| `~/Code/whombat-api` | control (`src/feedback/*`), hosted deploy | CL-97, HZ-47; vendors contracts 0.22.4 |
| `~/Code/whombat-app` | `apps/widget`, `apps/web`, legal pages | app 0.14.0, widget 1.1.0, AP-426 |
| `~/Code/whombat-appliance` | manager (Go), harness, candidates, `release/ship` | MG-57, IN-126; vendors contracts 0.22.4 |

Another session is shipping candidate 0.21.0 (shared sign-in) at the same time: take the next versions after it
(contracts 0.25.0, app 0.15.0, widget 1.2.0, candidate 0.22.0) and rebase on whatever lands on `main` meanwhile.

## 1. Contracts (0.25.0) — the shared shapes

All new strings follow the cross-language rules where the Go side sees them (`docs/cross-language.md`).

### 1.1 `@whombat/core` `domain/feedback.ts`
- `FeedbackTrailStep = z.strictObject({ url, title, at })`: `url` a sanitized page URL (origin + path, ≤
  `FEEDBACK_CONTEXT_LIMITS.url`), `title` string ≤ `LIMITS.title` or null, `at` ISO timestamp (the visitor's clock).
  `FEEDBACK_TRAIL_MAX = 10`.
- `FeedbackContext` gains `trail: z.array(FeedbackTrailStep).max(10).optional()` — oldest first, the page the report was
  sent from last. It lives in `context`, so redaction, payload hashing and storage need no new column.
- `FeedbackIntegrationSettings` gains `trail: 'on' | 'off'` (default `'on'`) and `reporterSignIn: 'on' | 'off'`
  (default `'on'`), both `.default(...)` so stored settings without them parse.
- `FeedbackPublicConfig` gains optional `trail: z.boolean().optional()` (the widget may send `context.trail`) and
  `reporters: z.boolean().optional()` (the widget may offer sign-in). Absent means false: that is how a new widget
  recognises an older runtime.
- `FeedbackPublicErrorCode` gains `code_refused` (400, “That code didn’t work. Check it or ask for a new one.”) and
  `signed_out` (401, “Your sign-in has ended. Sign in again.”); add both to `FEEDBACK_PUBLIC_ERROR_STATUS` and
  `FEEDBACK_PUBLIC_MESSAGES`.
- Reporter shapes (both modes use them verbatim):
  - `FeedbackReporterCodeRequest = strictObject({ email, parent })` (email ≤ 254, lower-cased and trimmed by the
    receiver; `parent` the embedding origin, must be one of the site's allowed origins).
  - `FeedbackReporterSessionRequest = strictObject({ email, code: /^\d{6}$/, parent })`.
  - `FeedbackReporterSession = strictObject({ token: /^fbrs_[A-Za-z0-9_-]{43}$/, email, expiresAt })`.
  - `FeedbackReporterStatus = z.enum(['received','reviewing','needs_info','confirmed','in_progress','fixed','closed'])`.
  - `FeedbackReporterReport = strictObject({ reference, type, status, receivedAt, updatedAt, summary: string ≤ 140 | null })`.
  - `FeedbackReporterReports = strictObject({ email, reports: array max 200 })`, newest first.
  - Constants: `FEEDBACK_REPORTER_CODE_TTL_S = 600`, `FEEDBACK_REPORTER_CODE_ATTEMPTS = 5`,
    `FEEDBACK_REPORTER_CODES_PER_HOUR = 5` (per site + email), `FEEDBACK_REPORTER_SESSION_TTL_S = 30 d`.
- Pure helpers (new module `feedback/reporters.ts`, Zod-free, loader/frame-safe where noted):
  - `reporterStatusOf({ status, assessmentState, assessmentOutcome })` → `FeedbackReporterStatus`:
    `resolved` → fixed; `closed` → closed; `in_progress` → in_progress; `triaged` → confirmed; `new` with assessment
    `running` → reviewing; `new` with a recorded assessment → `needs_information` / `insufficient_evidence` →
    needs_info, `confirmed_bug` / `likely_bug` / `duplicate` / `feature_request` → confirmed, otherwise reviewing;
    anything else → received.
  - `normalizeReporterEmail(s)` (trim, lower-case) and `reporterEmailDigest(site, email)` = hex sha256 of
    `"whombat-feedback-reporter/1\n" + site + "\n" + normalized email` (noble sha256; pure).
  - `REPORTER_STATUS_COPY` for the widget: `{ bug: {...}, feature: {...} }`: received “Received”, reviewing “Being
    looked at”, needs_info “Needs more information”, confirmed “Confirmed” / feature “Noted”, in_progress “In
    progress”, fixed “Fixed” / feature “Done”, closed “Closed”.
- `domain/feedback.ts` `FeedbackReport.submitted.reporter` gains `verified: boolean` (default false on read of old
  rows) so the web can show “Email verified”.
- `contracts/feedback.ts` `FEEDBACK_PUBLIC_PATHS` gains the self-hosted reporter routes (§1.3).
- `contracts/runner.ts` `FeedbackDispatchContext.submitted.context` already carries `FeedbackContext` → the trail
  arrives with it.

### 1.2 `@whombat/control-contracts`
- `feedback.ts`: `feedbackDropApi` gains `feedback.reporter.code` (POST `/feedback/sites/:site/reporter/code`),
  `feedback.reporter.session` (POST and DELETE `/feedback/sites/:site/reporter/session`),
  `feedback.reporter.reports` (GET `/feedback/sites/:site/reporter/reports`). `FEEDBACK_DROP_CORS`: methods add GET and
  DELETE, `allowHeaders: 'content-type, authorization'`, still no credentials.
- `device/feedback.ts`:
  - `FeedbackDrop` gains optional `reporter: { id: /^fbr_[A-Za-z0-9_-]{22}$/, emailDigest: /^[0-9a-f]{64}$/ }` — control's
    attestation that the drop was posted with a valid reporter session for that email.
  - New op `feedback.reporters.publish` body `strictObject({ updates: array ≤ 100 of { site, reporterId, reference,
    type, status, receivedAt, updatedAt }, removals: array ≤ 100 of { site, reference } })` → `{ ok: true }`.
    Control applies an update only for the device's own sites and only when `updatedAt` is not older than what it
    holds; a removal deletes the entry.
- `local/index.ts`: manager path `feedbackReporters` (runtime → manager → op), `RuntimeFeedbackReporters*` aliases.
- Conformance registry + `pnpm gen` (Go types), `gen:check`, `test:go`.

### 1.3 Public reporter endpoints (same shapes in both modes)
Self-hosted: under `/embed/v1/sites/:site/reporter/…` on the runtime (same-origin, like reports). Managed: under
control `/v1/feedback/sites/:site/reporter/…` (CORS for the embed origins).

| Method + path | Body / header | Answer |
|---|---|---|
| POST `…/reporter/code` | `FeedbackReporterCodeRequest` | 202 `{ ok: true }` always (no hint whether anything was sent); 404 unavailable (site unknown, sign-in off, parent not allowed, no mail); 429 rate_limited |
| POST `…/reporter/session` | `FeedbackReporterSessionRequest` | 200 `FeedbackReporterSession`; 400 `code_refused` (one answer for every failure); 429 |
| DELETE `…/reporter/session` | `authorization: Bearer fbrs_…` | 204 (also for unknown tokens) |
| GET `…/reporter/reports` | Bearer | 200 `FeedbackReporterReports`; 401 `signed_out` |
| POST reports / drops (existing) | optional Bearer | unchanged answers; a valid session marks the report verified (§2, §3); an invalid one is ignored, never refuses the report |

Codes: 6 digits, 10 minutes, single use, 5 wrong tries end the code, 5 codes an hour per site + email, 30 an hour
per network; stored keyed (never the plain code); sessions stored as sha256 of a 256-bit token, 30 days.
The code email (plain text, `MAIL_FROM`):
- Subject: `{code} is your code for {productLabel} feedback`
- Body: `Enter this code in the feedback window on {parent host} to follow your reports:\n\n{code}\n\nIt works once,
  for 10 minutes. If you didn’t ask for it, you can ignore this email — nobody can sign in without the code.`

## 2. Runtime (Whombat)

- **Migration `0051_feedback_reporters`** (additive `expand`, floors stay `0047_delegation`, UI-R17; compat.json +
  compat test):
  - `feedback_reports` + `reporter_id text null`, `reporter_verified boolean not null default false`,
    `reporter_published_at timestamptz null`, `reporter_dirty boolean not null default false` (outbox flag, managed).
  - Self-hosted only tables: `feedback_reporters (id 'fbr_'+22, integration_id, email, created_at, unique
    (integration_id, email))`, `feedback_reporter_codes (id, integration_id, email, code_hash, attempts, created_at,
    expires_at, consumed_at)`, `feedback_reporter_sessions (token_hash pk, reporter_id, created_at, expires_at)`.
- **Trail:** `structure.ts` `ARRAY_CAPS` gets `context.trail` (10); `normalizeSubmission` re-sanitizes each step
  (`sanitizePageUrl` with the integration's `redactPaths`, `cleanText` titles) and drops the trail when the
  integration's `trail` is `off`. `publicConfigOf` sets `trail: settings.trail === 'on'` and `reporters:` (self-hosted:
  `reporterSignIn === 'on' && mailConfigured()`; managed card: `reporterSignIn === 'on'`). The assessor prompt
  (`packages/agent-runtime/src/persona/feedback.ts` `reportBlock`) lists “Pages visited before reporting (oldest
  first)” with url, title and “N min before sending”, marked unverified like the rest of the context.
- **Self-hosted reporter routes** in `feedback/public.ts` (same guards as reports: module on, site known + intake
  enabled, `Origin` = own public origin, parent allowed, token buckets): code (mailer; refuse 404 when
  `!mailConfigured()`), session, sign-out, reports (own reports of that integration where `reporter_id` matches,
  status via `reporterStatusOf`, `summary` = first 140 chars of the description, content-removed reports left out).
  Reports POST with a valid Bearer: `reporter_id` set, `reporter_verified = true`, reporter email forced to the
  session's.
- **Managed:** `receiveDrop` reads `drop.reporter`; when `reporterEmailDigest(site, submission.reporter.email)` equals
  its `emailDigest`, the report gets `reporter_id = reporter.id`, `reporter_verified = true`. Publishing: every report
  change (the `republishRootMessages` call sites, via one `reportChanged` helper with `ctx.after`) marks
  `reporter_dirty` for reports with a `reporter_id`; a publisher loop in `FeedbackDropService` sends batches through a
  new `ManagerPort.feedbackReporters` (501/404 → unsupported, back off like cards) and clears the flag. Redaction and
  retention publish a removal.
- `FeedbackReport.submitted.reporter.verified` in `read.ts`.
- Decisions: `docs/decisions/feedback-reporters.md` (new, `FR-01`…), which states what it supersedes; update
  `docs/feedback.md` (operator guide: what is sent, sign-in, `data-trail`, mail requirement self-hosted).

## 3. Control

- Vendor contracts 0.25.0 (from 0.22.4; fix what the jump breaks).
- Migration `0013_feedback_reporters`: `feedback_reporters (id 'fbr_'+22, site_id, email_hmac, created_at, unique
  (site_id, email_hmac))` — no plain address stored; `feedback_reporter_codes (id, site_id, email_hmac, code_hmac,
  attempts, created_at, expires_at, consumed_at)`; `feedback_reporter_sessions (token_hash pk, reporter_id, site_id,
  created_at, expires_at)`; `feedback_reporter_reports (site_id, reference pk-part, reporter_id, device_id, type,
  status, received_at, updated_at)`; `feedback_drops` + `reporter_id null`, `reporter_email_digest null`.
  HMAC keys derive from the discovery key like signup codes (CL-76, `billing/marks.ts`).
- Routes in `src/feedback/routes.ts` (the `on()` drop switch applies; site must have a live card with `reporters:
  true`; `parent` in the card's `allowedOrigins`; Origin in `feedbackOrigins`): code (mail from the card's
  `productLabel` and the parent host; send without awaiting so timing says nothing), session, sign-out, reports.
  Rate limits in `LIMITS` (`fbrep:*`). CORS from the new `FEEDBACK_DROP_CORS`.
- Drops POST: a valid Bearer for the same site stores `reporter_id` + `reporterEmailDigest(site, email)`; pull returns
  them as `drop.reporter`.
- Device op `feedback.reporters.publish` (handler in `devices/device-api.ts`, `requireDropOn`, `requireClaimed`,
  ownership of each site). Retiring a device or withdrawing a site deletes its reporter entries; reporters, codes and
  sessions of a site go when the site does. Retention: expired codes/sessions swept with the drop sweep.
- Decisions CL-98…; `docs/device-api.md` feedback section.

## 4. Manager + harness + candidate (the appliance)

- Vendor contracts 0.25.0 (Go third_party + harness TS); new broker route `feedbackReporters` in
  `manager/internal/broker/feedback.go` (op `feedback.reporters.publish`, small caps, same unsupported mapping);
  fakecontrol case; tests. Decision MG-58….
- Harness `o-feedback`: trail arrives in the filed report; reporter sign-in through Mailpit (code), a drop posted
  signed in is verified, a status change reaches control and `GET reporter/reports` shows it; old-control/unsupported
  path still files reports.
- Candidate 0.22.0 after 0.21.0 lands: pins for contracts 0.25.0, app 0.15.0, runtime, control; `release/ship`
  validate + publish-dev; dev instance on the candidate. Deploy order everywhere: **control before the embed widget
  before boxes** (control parses cards strictly: a card with `trail`/`reporters` is refused by an older control).

## 5. Widget, web, legal (whombat-app)

### 5.1 Loader (`apps/widget/src/loader`)
- Records the trail unless the script has `data-trail="off"` (then it also removes the key): on install, on
  `popstate`/`hashchange`, and a 1 s comparison of the sanitized URL (always, cheap). Each step `{url:
  sanitizePageUrl(location.href), title, at}`; same URL as the last step only refreshes its title; keeps 10; stored as
  JSON in the host tab's `sessionStorage` key `whombat-feedback:trail` (storage errors → keep in memory). Sent to the
  frame as `WidgetContext.trail` (`parseContext` learns it, strict, capped). Stay within the 8 KiB gzip budget.
- `data-trail` joins `ATTRS` and core's `WIDGET_ATTRIBUTES`.

### 5.2 Frame (`apps/widget/src/frame`)
- Form: “Steps to reproduce” removed (the submission sends `steps: ''`). When `config.trail`, `submissionContext`
  applies `redactPaths` to every step and adds `trail`; “What will be sent” lists “Pages you visited on this site
  before reporting (up to 10)” with the steps; privacy line becomes “Nothing else from the page is sent: no cookies,
  stored data or form contents.” Without `config.trail`, no trail is sent or shown.
- Sign-in (only when `config.reporters`): storage lifted from FD-28 (7) for exactly one key: `localStorage`
  `whombat-feedback:<site>` holding `{ token, email, name, expiresAt, sent: [{ reference, summary, at }] ≤ 50 }` (the
  browser partitions it per embedding site; unavailable storage → the session lasts while the frame is open). Keep the
  build-time and unit-test bans for everything else (cookies, sessionStorage, IndexedDB) and allow only this module.
  - Header tabs **New report** / **Your reports** (buttons, `aria-pressed`), shown only with `config.reporters`.
  - Signed out, the contact group ends with a link-button “Sign in to follow your reports”. Signed in, it shows “Signed
    in as {email} · Sign out”; the email field is gone (the session's address is sent), name prefilled and remembered.
  - Sign-in view: heading “Follow your reports”; text “We’ll email you a 6-digit code. Signed in, you can see the
    reports you send on this site and how they’re going.”; Email + “Send code”; then “Enter the code we sent to
    {email}.” one 6-digit input (`inputmode="numeric"`, `autocomplete="one-time-code"`), “Sign in”, “Use a different
    email”, “Send a new code” (enabled after 30 s). Errors use the public messages.
  - Your reports: rows with type (“Problem” / “Idea”), `FB-…` reference, summary (the server's, else the local one),
    date (“29 Sep”), status text from `REPORTER_STATUS_COPY`; “Refresh”; empty state “No reports yet. Reports you send
    while signed in appear here.”; `signed_out` → back to sign-in with the message.
  - Receipt, signed in: extra line “You can follow it under Your reports.”
- Direct mode uses `/embed/v1/sites/:site/reporter/*`; drop mode uses control's paths (`drop.ts` constants, test kept
  equal to `feedbackDropApi`). Send Bearer only when signed in.
- `WIDGET_VERSION` 1.2.0; e2e (stub + drop) and screenshots for sign-in, code, list, trail preview, desktop + mobile,
  light + dark.

### 5.3 Web (`apps/web`)
- Report details: in CONTEXT, “Pages before reporting” — each step's path, title, “N min before” (from `at` vs
  `sentAt`); reporter line gets an “Email verified” mark (icon + text, success tone, `aria-label`) when `verified`.
  Old reports keep showing Steps when present.
- Integration Widget step (`IntegrationForm` `WidgetFields`, `settingsForm.ts`, `steps.ts`): “PAGES VISITED” Choice
  (“Send the last 10 pages” / “Don’t send”) and “REPORTER SIGN-IN” Choice (“Let visitors sign in to follow their
  reports” / “Off”); self-hosted hint when mail isn't configured is the server's (config says `reporters: false`).
  The install snippet adds `data-trail="off"` when pages visited is off.
- Visual baselines updated.

### 5.4 Legal
- `privacy-policy.md`: Feedback widget paragraph — pages visited (up to 10, stored in the visitor's tab until it
  closes), reporter sign-in (email for a one-time code; Whombat's hosted service keeps a keyed hash of the address, the
  report references and their status, never report text; sessions 30 days; stored in the browser under the site),
  section 7 storage lists both keys. New version `2026-09-30-draft`, decision AP-….
- `terms-of-service.md` only if it describes the widget's data; otherwise unchanged.

## 6. Decision files and numbering
Whombat `docs/decisions/feedback-reporters.md` (FR-01…); contracts `docs/decisions/contracts.md` (CT-160…);
control `docs/decisions/control.md` (CL-98…); appliance `docs/decisions/manager.md` (MG-58…),
`integration.md` (IN-127…); app `docs/decisions/feedback-reporters.md` (AP-427…).

## 7. Done means
Each repo: its checks green (`TMPDIR=~/.cache/wb-tmp pnpm check`; Whombat also `pnpm test:server`; appliance
`scripts/ci/check.sh` / harness tests; Go `test:go`), commits on the stream branch, decisions recorded. Then the lead
merges, releases contracts 0.25.0 and app 0.15.0, builds candidate 0.22.0, validates and puts it on dev.

## 8. As built in contracts 0.25.0 (read before §2–§5)
Released: tag `contracts-v0.25.0` (main `ca35f25`), tarballs in `~/Code/whombat-contracts/dist-release/0.25.0/`
(`SHA256SUMS`; vendoring per `~/Code/whombat-contracts/docs/publishing.md`). Decisions CT-160…CT-165.
- **Report answers carry the trail as `FeedbackReport.submitted.trail`** (≤ 10, `[]` from older runtimes), not in
  `submitted.context` (strict `FeedbackContext` would make 0.24 webs reject the whole report). Storage, submissions, the
  sealed drop and the dispatch context keep it in `context.trail`; the runtime's `read.ts` moves it.
- `SESSION_API_LEVEL` stays 23; runtime feature **`feedback.reporters`** (`SINCE_0_25`) gates the web's new settings,
  trail display and “Email verified”.
- `@whombat/core/feedback/reporters` (Zod-free, widget-safe): `reporterStatusOf`, `normalizeReporterEmail`,
  `reporterEmailDigest`, `REPORTER_STATUS_COPY`, `REPORTER_TYPE_COPY`, `reporterSummaryOf`, `reporterCodeMac(key, site,
  email, code)`, `reporterDigestEqual`, `newReporterCode`, `newReporterToken`, `reporterTokenHash`, `newReporterId`,
  `reporterTokenFrom(authorization)`, `reporterCodeEmail({code, productLabel, parent})` (subject + text verbatim),
  constants incl. `FEEDBACK_REPORTER_SESSIONS_PER_NETWORK_PER_HOUR = 60`, `FEEDBACK_REPORTER_RESEND_S = 30`. Use these
  instead of re-implementing.
- `FEEDBACK_PUBLIC_PATHS.reporterCode|reporterSession|reporterReports`; `WIDGET_ATTRIBUTES.trail`.
- control-contracts: `feedbackDropApi.reporterCode|reporterSession|reporterSignOut|reporterReports` (control's reports
  always `summary: null`); `FEEDBACK_DROP_CORS` GET/POST/DELETE + `authorization`; `FeedbackDrop.reporter?`
  (`{id, emailDigest}`); op `feedback.reporters.publish` (updates/removals ≤ `FEEDBACK_REPORTERS_PUBLISH_MAX` = 100,
  times epoch seconds); `MANAGER_PATHS.feedbackReporters = '/v1/runtime/feedback/reporters'`; Go types regenerated
  (`DeviceOpNameFeedbackReportersPublish`, `ManagerPathFeedbackReporters`, …).
- Fixtures: the integration has both switches on; the first report is verified with a three-step trail.
