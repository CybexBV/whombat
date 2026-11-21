# Whombat Feedback: security review 1

Reviewer: independent (did not write the code). Scope: `git diff c4702a5..b9e4d15`, which covers public intake, persistence,
`/embed` serving, the widget loader and frame, the internal settings UI, and the report card on web and Android. The
assessment worker, restricted runtime and handoff are not in this commit and were not reviewed.

The proof-of-concept tests were in `apps/server/src/feedback/review1.int.test.ts`, opt-in and asserting the faulty
behaviour. All findings are fixed (see **Resolution** at the end); that file now holds ordinary regression tests
asserting the fixed behaviour:

```
cd apps/server && TMPDIR=~/.cache/wb-tmp npx vitest run --config vitest.int.config.ts src/feedback/review1.int.test.ts
```

## Findings (ranked)

### R1-1 — HIGH — One unauthenticated request can stall or OOM-crash the whole server (Zod issue explosion)

- **Where:** `apps/server/src/feedback/public.ts:215-223` (`JSON.parse` → `wellFormed` → `FeedbackSubmission.safeParse`
  → `zodFieldPaths(parsed.error.issues)`), plus `errors.ts:284` (`new Set(fields)` before `.slice(0, 20)`).
  `wellFormed` (`intake.ts:55`) copies arrays and objects of any length.
- **What:** the only bound on body structure is the byte cap. That cap is about 12.6 MB with the default limits
  (`bodyCapOf`, 3 × 3 MB) and at most 32 MiB. Arrays such as `context.references` (max 5) and `attachments` (max 3)
  can hold millions of elements. Zod validates every element and records one issue per bad element. Only after that
  does it apply `.max()`. The handler then maps every issue to a path string and puts all of them into a `Set`, and
  only then keeps the first 20.
- **Exploit:** the attacker needs only a site id, which is public in the customer's HTML. They send
  `POST /embed/v1/sites/<site>/reports` with no `Origin` header, a correct `Content-Length`, and a body like
  `{"submissionId":"…","parentOrigin":"x","type":"bug","description":"x","context":{"references":[0,0,0,…]}}`.
  - All checks before parsing pass: site, Origin (none sent), `Content-Length` ≤ cap, and the token buckets (5 per IP
    per hour by default).
  - All of this work is synchronous on the main thread, so chat, WebSockets and MCP all stall with it.
- **Verified:**
  - PoC `R1-1`: a 3.8 MB body with 2M elements got a 400 after 2.2 s. A 10 ms interval timer fired once during that
    time, so the event loop was blocked the whole time. Heap grew by about 1.08 GB.
  - Direct measurement: a 12.0 MB body with 6M elements, which fits under the default cap, took about 11 s and about
    2.4 GB of heap.
  - With `--max-old-space-size=2048`, that 6M case aborted the process with *“FATAL ERROR: … JavaScript heap out of
    memory”*. Node's default heap on a 4–8 GB VPS is in that range.
  - So one request kills the server. Five requests per hour per IP are enough to keep it down.
  - IPv6 makes it worse: the per-source bucket is keyed on the full /128 address (`service.ts:120`).
- **Fix:**
  - Bound the structure before Zod. In `wellFormed`, or a pre-pass, reject arrays longer than a small cap (for
    example 32), objects with more than about 64 keys, and depth over 8, with a `400 invalid` naming `body`.
  - Or parse the non-attachment part under a small byte cap, such as 64 KB.
  - Cap the issues handled: take only the first N issues before mapping.
  - Treat the same class of problem on the authenticated `/api` JSON parser (1 MiB) as a follow-up.

### R1-2 — MEDIUM — Retries are not idempotent: the same draft gets a 409 and the widget offers to send it again

- **Where:** `apps/widget/src/frame/app.ts:780-787` rebuilds the body on every attempt with
  `sentAt: new Date().toISOString()`. The server hashes `context.sentAt` into `payload_hash` (`intake.ts:115` →
  `payloadHashOf`). The frame also rebuilds `context` from the latest loader push, and the loader re-sends it on every
  URL change while the panel is open.
- **Scenario:**
  1. The server commits the report, but the response is lost. This can be the frame's 30 s timeout while the server
     waits on the image semaphore, a flaky mobile connection, or a crash after commit.
  2. The visitor presses **Try again**. The request carries the same `submissionId` but a new `sentAt`, so the server
     computes a different hash and answers 409.
  3. The widget says *“This report was already sent. If you changed it since…”* and offers **Send as a new report**,
     which creates a duplicate thread, and in the meantime shows no receipt.
- This breaks FB-10 and the failure-behaviour row *“Crash after commit, before response → the retry gets the same
  receipt”*.
- **Verified:** PoC `R1-2`: the same submission with a different `sentAt` gets 409. From code reading, the frame sets
  a new `sentAt` on every `Submitter.submit` call.
- **Fix:**
  - Leave `sentAt` out of the hash, or freeze the whole body, including `sentAt` and context, the first time a draft
    is sent.
  - Also consider leaving `context` out of the hash entirely, since it is informational.

### R1-3 — MEDIUM — Image work blocks the event loop and in-flight bodies are unbounded in memory; the daily cap is checked last

- **Where:**
  - `images.ts:146-169`: `PNG.sync.read/write` and `jpeg.decode/encode` run on the main thread.
  - `images.ts:172-194`: the semaphore limits concurrency, not blocking.
  - `service.ts:111-126`: token buckets limit rate, not the number of concurrent requests.
  - `intake.ts:216-225`: the durable `reportsPerDay` count runs inside the transaction, after decoding.
- **What and measured cost:**
  - A 16 MP PNG costs about 0.26 s to decode plus 0.48 s to re-encode, which is about 0.75 s of main-thread block per
    image and about 2.2 s per 3-screenshot report. A 16 MP solid PNG is 67 KB.
  - Trailing garbage after IEND is accepted (it is stripped later), so a padded body also costs memory.
  - Each request waiting on the semaphore holds its raw buffer, the UTF-8 string, the parsed JSON and the decoded
    base64: about 40–50 MB for a 12.6 MB body.
  - Burst sizes are 30 for an integration by default and 120 globally, so a burst can queue gigabytes of buffers.
    Replenishing costs the attacker only as many source IPs as the per-source bucket requires, and IPv6 makes those
    addresses cheap.
  - Once `reportsPerDay` is exhausted, every request still pays the full decode before it gets a 429.
- **Verified:** benchmark with the repo's `pngjs` and `jpeg-js` on this host, plus code reading. No end-to-end OOM
  test was run for this path.
- **Fix:**
  - Move decoding into a `worker_threads` pool with a `resourceLimits` heap cap.
  - Add a concurrency cap on in-flight intake requests, checked in `onRequest`, answering 429 or 503 when full.
  - Check a cached count of reports in the last 24 hours before any image work.
  - Key per-source buckets on the IPv6 /64.

### R1-4 — LOW — `WHOMBAT_FEEDBACK=off` also stops the retention sweep

- **Where:** `service.ts:49-50`: `start()` returns early when the module is off. `routes.ts` registers
  `api.feedback.*`, including reading reports, even when the module is off.
- **Scenario:** an operator turns the module off, perhaps to stop intake during an incident. Reports already stored
  with `retentionDays` are then never cleared, even though FB-25 promises automatic removal. Visitor PII (email, text,
  screenshots) outlives the promised retention with no warning. The `module_off` health message does not say this.
- **Verified:** code reading.
- **Fix:** always run the retention sweep. "Off" should only unregister the public surface and the worker.

### R1-5 — LOW — JPEG screenshots between about 13 and 16 MP pass the header check but are refused as “unsupported”

- **Where:** `images.ts:97-98, 158-164`. The header check allows 16,000,000 px, but `maxMemoryUsageInMB: 256` makes
  `jpeg-js` throw above about 13 MP. The throw is caught and reported as `unsupported_attachment`.
- **Scenario:** a 5K screenshot saved as JPEG (5120×2880) or a 16 MP photo is refused with *“Screenshots must be PNG or
  JPEG”*, which is wrong and confuses the visitor.
- **Verified:**
  - PoC `R1-5`: 5120×2880 → 422.
  - Benchmark: 4032×3024 decodes; 5120×2880 and 4000×4000 fail with *“maxMemoryUsageInMB limit exceeded”*.
- **Fix:** make the memory cap consistent with 16 MP (RGBA output 64 MB plus component buffers; about 384 MB works),
  or lower `FEEDBACK_IMAGE_MAX_PIXELS` for JPEG. Either change interacts with R1-3, so do it in a worker.

### R1-6 — LOW — Toggling intake or assessment changes whose authority the intake snapshot records, without re-validating

- **Where:**
  - `integrations.ts:220-223` and `246-253`: `setFeedbackIntake` and `setFeedbackAssessment` set
    `updatedById = actor` after only `requireOwner`.
  - `intake.ts:310`: the snapshot's `configuredById = integration.updatedById`.
  - `read.ts:232`: the health check `owner_not_member` reads `updatedById`.
- **Scenario:** owner A configured the agent and repo, then left the channel or was demoted, so FB-20 revalidation
  would block. Owner B presses pause and then resume without opening the settings. B becomes the “configuring owner”:
  the warning disappears and assessment runs on authority B never reviewed. The reverse also happens: an owner who is
  not a channel member toggles intake, and later reports start as `blocked`.
- **Verified:** code reading. The worker is not in this commit, so the impact is prospective.
- **Fix:** keep a separate `configuredById` that only `create` and `update` set, after `validateSettings`, and snapshot
  that. Or run `validateSettings` for the actor on toggles as well.

### R1-7 — LOW — Public 429 `retryAfter` reveals private limits and report timing

- **Where:** `service.ts:123` (bucket `retryAfter` = `3600/n` exactly) and `intake.ts:178-181, 222-225` (daily cap:
  seconds until the oldest report of the last 24 hours ages out).
- **What:** a visitor can read `perSourcePerHour` and `reportsPerHour` from the exact `retryAfter`. Once the daily cap
  is reached, they can also see when the integration's oldest report in the window arrived. The checklist says public
  responses should not reveal limits.
- **Verified:** code reading.
- **Fix:** round or jitter `retryAfter`, for example to whole minutes with a floor, and use a fixed value for the
  daily cap.

### R1-8 — LOW / informational — Channel members get owner-only configuration through `getReport`

- **Where:** `read.ts:104` (`intake: row.intake`) and `packages/core/src/domain/feedback.ts:474`.
- **What:** the intake snapshot includes `projectContext`, `repoId`, `agentId`, `configuredById` and `configHash`. It
  goes to every member of the report channel. The integration settings themselves are owner-only (FB-17), and
  `projectContext` is operator-written guidance that may be sensitive.
- **Verified:** code reading.
- **Fix:** send members a reduced view, such as revision and agent, and keep `projectContext` owner-only.

### R1-9 — LOW / informational — Page-URL redaction misses short tokens

- **Where:** `packages/core/src/feedback/sanitize.ts:83-97`.
- **What:** mixed letter-and-digit tokens are redacted only at 20 characters or more.
  `https://a.com/magic-login/Xk9fQ2mZpL7tR4wB` (16 characters) and `/users/john.smith/…` pass through unchanged
  (checked with a script).
- **Mitigations already present:**
  - Query strings and fragments are always dropped.
  - `redactPaths` exists.
  - The visitor sees the URL in “What will be sent”.
- **Suggestion:** lower the threshold to about 12 characters with at least one digit and one letter, or document the
  limit next to `redactPaths` in the settings form.

### Unconfirmed / notes (no finding)

- **Loader `findScript` fallback** (`loader.ts:81-89`): when `document.currentScript` is null, the loader takes the
  first `script[src*="/embed/v1/widget.js"][data-site]`. That could be attacker-injected markup whose script never runs
  under the host's CSP, which would point the loader at an attacker's origin. This is unexploitable for the
  documented snippet, which is a classic IIFE script where `currentScript` is always set. Hardening: use only
  `currentScript`.
- **Visitor text beyond the report row, by design (FB-15/16):**
  - The resolved card `summary` (280 characters of the visitor's description) is in `message.created` and
    `message.updated` realtime frames.
  - It is also in `read_conversation` output for any agent in the channel.
  - Screenshots are readable by agents dispatched in that channel.
  - The persona prompt renders only `[report card]`.
  - Keep this in mind for the restricted assessor (FB-21): non-assessor agents in `#bugreport` see untrusted visitor
    text.
- **Redaction does not touch thread replies:** future assessor replies and the summary message in the thread may quote
  the visitor.

## Checklist items verified as sound

1. **Public/API separation.**
   - Public routes never touch auth or cookies. The global CSRF hook applies only to `/api`.
   - There are no CORS headers, and `onSend` strips ACAO.
   - Unknown, disabled and disallowed sites all return the same `unavailable` 404 body.
   - Error bodies are fixed text, and DB errors are logged by name and code only.
   - `normalizeOrigin` and `originAllowed` require exact canonical forms. Checked with a script: uppercase, trailing
     dot, `:443`, a trailing `/`, userinfo, backslashes, IDN/punycode, `null`, `%2e`, and numeric IPv4 are all
     refused for an allowlisted `https://app.example.com`.
   - The frame route requires `normalizeOrigin(parent) === parent` and emits only canonical characters into the CSP,
     so header injection isn't possible.
   - POST can be told apart from 404 only after the body parses, which reveals nothing because site ids are public.
2. **Abuse-control ordering and bodies.**
   - The order is site → Origin → `Content-Length` (required, digits only) → buckets, and all run before the body is
     read.
   - The body limit is route-scoped. Chunked requests without a `Content-Length` are refused.
   - `content-encoding` is not decoded.
   - `TRUST_PROXY` is honoured: `X-Forwarded-For` and `CF-Connecting-IP` are used only from trusted peers.
   - The daily cap runs under the burrow lock, so there is no race.
   - Bucket maps prune. Growth is bounded because the integration and global buckets are checked first.
   - The exceptions are R1-1 and R1-3.
3. **Uploads.**
   - Base64 is canonical-only, and the length is bounded before decoding.
   - Sniffing plus the declared type must agree.
   - Dimensions are checked before decoding.
   - The interlaced-PNG inflate cap works, and `pngjs` caps inflation for non-interlaced images.
   - Data is truncated at IEND, and re-encoding strips metadata and polyglot tails.
   - Names are generated, and the content type is sniffed.
   - Files are stored as ordinary attachments and served by the membership-checked route with
     `nosniff`, `CSP: default-src 'none'; sandbox` and a content disposition.
   - There is no public read path.
   - Staged files are discarded on failure. Committed-but-rolled-back blobs are caught by the attachment sweep.
   - The quota is enforced under the lock.
4. **Intake integrity.**
   - The strict schema drops unknown or forged routing fields.
   - The unique `(integration_id, submission_id)` index plus re-checks under the lock handle concurrent duplicates:
     the loser discards its staged files.
   - A replay returns only the receipt.
   - `feedback.report_received` carries only ids, sizes and hashes.
   - The message text is fixed, with `mentions: []` and `dispatch: false`, so there are no notifications.
   - The search index gets `''` for report cards.
   - Automations ignore the Feedback principal (`engine.ts:445`).
   - `receive_report` refuses any other actor.
   - The exception is R1-2.
5. **Internal authorization.**
   - Integrations: non-owners get 404. Commands re-check `requireOwner` and the burrow.
   - Reports: channel membership is required, with 404 otherwise, and every lookup is burrow-scoped.
   - An agent is never auto-added. Guarded, provider and eligibility rules hold, the repo must be enabled, and the
     revision is optimistic.
   - Forged report cards: `PostableCard` excludes `report`, and the only writers of `messages.card` with
     `kind: 'report'` are the intake command and the seed. So no API or MCP path can put a report card into another
     conversation.
6. **Widget and DOM.**
   - One non-writable global, a closed shadow root and `all: initial` on the host. Double install is a no-op, and
     destroy removes listeners.
   - The bridge checks exact origin, `event.source`, the instance nonce (in the fragment, never sent to the server) and
     a closed schema, in both directions, with exact `targetOrigin`s.
   - The frame refuses to run unframed, with a bad `parent`, or when `ancestorOrigins[0]` doesn't match.
   - A different site cannot frame it because `frame-ancestors` is exactly the parent; a popup is refused.
   - A child iframe of the host cannot spoof either side.
   - The frame is cross-origin to the host, so `allow-same-origin` + `allow-scripts` gives the host no escape.
   - `frame.html` is `no-store`, with a strict CSP and `referrer-policy no-referrer`.
   - The frame DOM builder never uses `innerHTML`.
   - `privacyUrl` is https-only on both server and frame, with `rel="noopener noreferrer"`.
   - Fetches use `credentials: 'omit'`, `mode: same-origin` and `redirect: 'error'`.
7. **Web UI.**
   - The report card, details, page URL, custom context and snippets render as React text only: no
     `dangerouslySetInnerHTML`, no Markdown, and the page URL is not a link.
   - Snippet attributes are escaped.
   - Android renders `Text` only.
8. **Anti-framing and routing.**
   - The app shell still sends `X-Frame-Options: DENY` and `frame-ancestors 'none'`.
   - `/embed` is in `SERVER_PREFIXES`, matched exactly or by prefix.
   - The dev Vite proxy forwards `/embed`.
   - The loader is `CORP: cross-origin` and assets are `same-origin`. Assets are served from a manifest allowlist,
     so there is no traversal.
9. **Privacy.**
   - The loader, frame and server all sanitize: query and fragment are dropped, ids redacted, and custom keys
     allowlisted twice.
   - No bodies or contact details are logged.
   - Redaction clears the row, deletes attachment rows, updates the root message, republishes realtime and unlinks
     unused blobs.
   - The exceptions are R1-4 and R1-9.
10. **Optional module and migration.**
    - With the module off, `/embed` is not registered and answers the JSON 404.
    - Without an integration, every public request gets `unavailable`.
    - Migration `0027` only creates tables and indexes, so it is safe on existing data.
    - The exception is R1-4.

## Resolution

Worker F1, branch `fb/f1-fixes`. Every finding is fixed; the decisions are rows FB-F01 … FB-F11 of
`docs/decisions/feedback.md`. `review1.int.test.ts` (“review1” below) is no longer opt-in. Its PoC scenarios assert
the fixed behaviour and run in about 5 s with little memory.

| Finding | Fix | Commit | Proven by |
|---|---|---|---|
| R1-1 | Two structural passes before Zod (FB-F01). `scanJsonShape` checks the raw bytes before `JSON.parse`: depth ≤ 6 and ≤ 2000 structural tokens outside strings. `checkStructure` checks the parsed value: arrays per known field (`attachments` ≤ 3, `context.references` ≤ 5, others ≤ 20), ≤ 40 keys, ≤ 2000 values, and strings ≤ 10 000 characters except screenshot data. Either refuses with 400 `invalid`. Only the first 20 Zod issues are mapped, and `publicErrorBody` slices before it dedupes. | `1061df7` | review1 “R1-1”: 100k references → 400 in ~15 ms with < 64 MB heap growth; a 12 MB body of 6M values → 400 in ~10 ms, never parsed; unit tests “submission structure bounds (R1-1)” in `feedback.test.ts` |
| R1-2 | `context.sentAt` is left out of the payload hash (FB-A09). The frame's `Submitter` builds a draft's body once and resends the same body, `sentAt` and context included, on every retry of the unchanged draft (keyed by `draftKey`). An edit builds a new body (FB-B09). | `5197854` | review1 “R1-2”: same `submissionId` with a later `sentAt` → 200 and the same receipt, while different content → 409. Widget: `submit.test.ts` “a retry of the same draft resends the body built for it…”, `app.test.ts` “a retry sends the very same body, sentAt and context included…”. Unit: the `payloadHashOf` test |
| R1-3 (a) | Screenshots are decoded in one long-lived `worker_threads` worker with `resourceLimits` (old generation 256 MB, young 32 MB), one job at a time, 10 s per job. A failed, stuck or dead worker → 422, and the worker is replaced. A worker that can't load → 500 `internal` (FB-F02). Releases ship `app/image-worker.mjs` as its own esbuild entry. | `546a7c4` | `feedback.test.ts` “the image worker (R1-3)” covers: out of heap → 422 with the server unharmed, a timeout replaces the worker, a crash → 422, a failed load → internal, and close. `scripts/package` “the release’s feedback image worker” bundles the pool with the release's esbuild options and runs it from the two bundles only. review1: a 16 MP PNG is processed while a 10 ms timer keeps firing |
| R1-3 (b, c) | In-flight slots, taken before the body is read: 4 per process and 2 per integration, else 429 with `retryAfter: 5`. A slot is released on response or connection close. With screenshots, reports of the last 24 h are counted before any image work (FB-F03). | `d813a82`, `a13b7d0` (the concurrent-duplicates test runs above the caps) | review1 “R1-3”: the in-flight caps, every ending releases its slot, a mid-body disconnect releases its slot, and the daily cap → 429 without calling the worker |
| R1-4 | `FeedbackService.start()` always starts the retention sweep. `WHOMBAT_FEEDBACK=off` only leaves `/embed` unregistered. The `module_off` warning says reports are still removed (FB-F05, FB-A12). | `220074f` | review1 “R1-4”: `start()` with the module off removes content past `retentionDays` |
| R1-5 | The `jpeg-js` memory cap was raised to 512 MB, which fits 16 MP with 3 or 4 components. This happened in the worker (`546a7c4`) and is documented in FB-F04. The decoder's typed arrays are outside V8's heap (checked: `resourceLimits` doesn't count them), so this cap is their bound. | `546a7c4`, `1dc1ed9` | review1 “R1-5”: a 5120×2880 JPEG → 201, stored at 5120×2880. A 17 MP header → 422 before the worker is called |
| R1-6 | `set_intake` and `set_assessment` bump `revision` but leave `updatedById` / `updatedAt` alone. The snapshot's `configuredById` and `owner_not_member` follow whoever saved the settings (FB-A01, FB-F06). | `c20f2ab` | review1 “R1-6”: a second owner's 4 toggles bump the revision and are signed by that owner, while `updatedById` and a new report's `configuredById` stay the creator's. Saving the settings changes it |
| R1-7 | Fixed public `retryAfter`: 60 for any token bucket, 3600 for the daily cap (both checks), 5 when the slots are full (FB-F07). | `9b95c78` | review1 “R1-7”: several bucket sizes all answer 60 (body and header), and the daily cap answers 3600 even when the window frees up in a minute. The expectations in `intake.int.test.ts` limits are updated |
| R1-8 | `reportView` (getReport, setReportStatus, redactReport) empties the intake snapshot's `projectContext` for non-owners. The contract is unchanged (FB-F08). | `0d0ff3b` | review1 “R1-8”: the owner reads it, and a channel member gets `''` from both getReport and setReportStatus |
| R1-9 | `looksLikeId` redacts segments of 12+ characters that mix letters with 2+ digits, and base64url segments of 16+ characters with a digit or capital, unless the segment is a slug of words (FB-F09). | `1752d34` | `packages/core/src/feedback/feedback.test.ts`: the reviewer's `/magic-login/Xk9fQ2mZpL7tR4wB` is redacted, as are nanoids and JWT parts. Kept: `settings`, `billing-v2`, `invoices-2026`, `page-3`, `v1`, `api`, `2fa` and longer slugs |
| Notes | Content removal leaves the thread's human and agent replies alone, and people remove those like any message (FB-F10). The card summary reaches channel members' realtime frames by design (FB-F11). The loader's `findScript` fallback is unchanged. | `96b5082` | — |

Not done here:

- The authenticated `/api` JSON parser (1 MiB) has no structural bound yet; that is the follow-up R1-1 names.
- Per-source buckets are still keyed on the full IPv6 /128. The in-flight caps (FB-F03) now bound what many
  addresses can hold at once, but not how many tokens they get.

Unrelated fixes needed for `pnpm check` on this branch's base: `3051f93` (biome formatting of
`apps/web/src/features/feedback/feedback.test.tsx`) and `608d864` (the fixtures test still expected the fixture
integration's old health warning).
