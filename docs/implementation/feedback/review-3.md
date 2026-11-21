# Whombat Feedback: review 3 (final, integrated branch)

Independent final review of the integrated branch at `79d990c` (merge of `fb/f1-fixes` and `fb/f2-fixes`; `main` is
`c4702a5`). It covers three things: whether every finding of review 1 (R1-1 … R1-9) and review 2 (F1 … F9) is
really resolved, whether the parallel fixes interact badly, and a last pass over the trust boundary. The review
found problems and fixed no product code.

The findings of this review's parallel passes (NEW-1 … NEW-6, the F6 race, N2 … N7) have been fixed on
`feedback-widget` in `bfac5ce`. The table, commits and tests are in `review-3-fixes.md`, and this review does not
re-review those fixes. One new finding (N-S1, slow bodies hold the in-flight slots) is **not** fixed on
`feedback-widget` at `bfac5ce`.

Commands run at `79d990c` (`TMPDIR=~/.cache/wb-tmp`; host `/tmp` was out of inodes):

- `cd apps/server && npx vitest run --config vitest.int.config.ts src/feedback/review1.int.test.ts src/feedback/review2.int.test.ts`
  → 2 files, 34 tests passed.
- A probe int test for N-S1 (below): passed, which confirms the bug. It is not committed; its source is quoted
  in N-S1.
- A script run of `looksLikeId` over the tokens listed under R1-9.

## Review 1 findings

| Finding | Status | Evidence |
|---|---|---|
| R1-1 Zod issue explosion | **Resolved** | `public.ts:236` `scanJsonShape` runs on the raw bytes before `JSON.parse`: depth ≤ 6 and ≤ 2000 `[` `{` `,` tokens outside strings. The string skip uses `indexOf`, and the backslash back-scan is linear because each run is scanned once. `public.ts:243` `checkStructure` checks the parsed value: known array caps, 40 keys, 2000 nodes, 10k-character strings. `public.ts:128-132` maps only the first 20 issues. A leading `]` pushes depth negative, but `JSON.parse` refuses such input and the token cap still holds. review1 “R1-1” asserts a 400 in < 1 s with < 64 MB heap growth for 100k references, and a 400 before parsing for a 6M-value, 12 MB body. The old code would have failed both. |
| R1-2 retries not idempotent | **Resolved** | `intake.ts:135-140` `payloadHashOf` leaves out `context.sentAt`. `apps/widget/src/frame/submit.ts:153-165` resends the same built body while the `draftKey` (text, type, contact, file keys; `draft.ts:145`) and the `submissionId` stay the same. `app.ts:781-799` only passes the builder. The hand merge kept F1's `Submitter` and E2's `a63a698` left no second code path. Residual (info): the hash is taken after server normalization, so if an owner changes `redactPaths` or `contextKeys` between a send and its retry, the retry gets a 409. |
| R1-3 image work on the main thread; unbounded in-flight memory | **Resolved**, with N-S1 as a new weakness of the fix | `image-pool.ts` runs one long-lived worker with `resourceLimits` and a 10 s timeout. A worker that dies or times out is replaced, its job gets 422, and a worker that fails to load gives `internal`. `public.ts:199-203` takes an in-flight slot (4 per process, 2 per integration) before the body is read, and releases it on response or close. The release is idempotent (`slots.ts:30-38`). `public.ts:267` counts the daily cap before image work when there are screenshots. review1 “R1-3” passes. Not done, as the Resolution says: per-source buckets are still keyed on the full IPv6 /128. |
| R1-4 module off stops retention | **Resolved** | `service.ts:70-86` starts the sweep unconditionally. `index.ts:94` calls `start()` whatever the module setting. `feedback/index.ts:15` only skips `/embed`. review1 “R1-4” passes. |
| R1-5 13–16 MP JPEGs refused | **Resolved** | `image-worker.ts:46,112` sets `JPEG_MAX_MEMORY_MB = 512`. review1 “R1-5”: a 5120×2880 JPEG is accepted, and a 17 MP header is refused before the worker. Note: that memory is outside the worker's V8 heap, so each process can hold up to about 0.5 GB of extra RSS, one job at a time (FB-F04, accepted). |
| R1-6 toggles change the configuring owner | **Resolved** | `integrations.ts:222,249`: `set_intake` and `set_assessment` bump only `revision`. `updatedById` is set only by create and update after `validateSettings` (`integrations.ts:160,195`). `intake.ts:308` snapshots it. The start (`assessment.ts:206`) and F5's claim/submit check revalidate it. review1 “R1-6” passes. |
| R1-7 `retryAfter` leaks limits | **Resolved** | `errors.ts:26-30` fixes the values: 60 for any bucket, 3600 for the daily cap. The slots use 5. `public.ts:207,268` and `intake.ts:223` use them. `takeReportTokens` still computes an exact value (`service.ts:169`), but `public.ts:207` discards it. |
| R1-8 `projectContext` to members | **Resolved** | `routes.ts:57-64` `reportView` blanks it for non-owners. It is the only caller of `toFeedbackReport` (`read.ts:59`), used by getReport, setReportStatus and redactReport. The card and realtime frames don't carry the intake snapshot. The assessor still gets it (`dispatch.ts:140`) by design. |
| R1-9 short URL tokens | **Resolved** as far as a heuristic can be | Script checks of `looksLikeId`: `Xk9fQ2mZpL7tR4wB`, `magic-9f8e7d6c5b4a`, `K7x-Q9m-Z2p-L7t-R4w` and `sk_live_…` are redacted. `Xk9fQ2mZpL` (10 characters), all-letter mixed case `AbCdEfGhIjKlMnOp`, `inv_2Hx9kQp` and `john.smith` pass through. FB-F09 documents that `redactPaths` covers these. |
| Notes | Resolved and documented | FB-F10 (corrected by N3 in `bfac5ce`) and FB-F11. The loader's `findScript` fallback is unchanged (unexploitable with the documented snippet). |

## Review 2 findings

For every F-item, the fix code is where the Resolution says, and `review2.int.test.ts` passes at `79d990c` (34
tests together with review1). The parallel passes re-derived the exploits in depth. Where they found an item
incomplete, it became a finding below and has been fixed in `bfac5ce`.

| Finding | Status | Evidence at 79d990c | Follow-up |
|---|---|---|---|
| F1 assessor output laundered | **Resolved** at 79d990c, with gaps found later | `messages.provenance`. Automations ignore Feedback-provenance messages and reactions to them (`automations/engine.ts:452-460`) and agents in report threads (`:462`). The handoff message is fixed text. `DispatchContext.feedbackHandoff` wraps the assessment as untrusted data. | Search showed assessor text without the wrapper (NEW-3). The report root's screenshots reached unrestricted agents (N2). The handoff note was truncated on the card, so the approver didn't see what the developer got (NEW-5). The unverified revision text sat outside the block (NEW-6). All fixed in `bfac5ce`. |
| F2 Markdown and links in replies | **Resolved** | `assessment.ts:777` `inertReply`, `render.ts:41` | — |
| F3 workdir for assessments | **Resolved** for Claude and cwd | The runner has `workspace.ts:213` (`isAssessment`). The server sends `workdir: null`. | The Codex profile still let the assessor read the owner's files outside the cwd (NEW-1). Fixed in `bfac5ce` with an allowlist profile that extends nothing, verified in Codex's real sandbox. |
| F4 `canExecute` / sandbox | **Resolved** | `assessment.ts:139-155` (`commands === 'sandboxed'`). `canExecuteFor` is planned again at the claim (`dispatch.ts`). | — |
| F5 revalidation after start | **Resolved** | `runningAssessmentProblem` (`assessment.ts:232`) runs at the claim (`dispatch.ts:76`) and in `record_assessment` (`assessment.ts:669`). | — |
| F6 timeout counts queue time | **Resolved**, with a race | `assessor.ts:143-146` counts from `claimedAt`. There is also a 12 h queue deadline. | Race: the queue-deadline settle could cancel a turn claimed in the meantime. Fixed in `bfac5ce` (`onlyIfQueued` compare-and-set, FB-F3-07). Flaky claim test N7: fixed. |
| F7 narrow defusing | **Partially** at 79d990c | NFKC and look-alike normalization plus per-tag defusing. | Some spellings still got through (NEW-4). Fixed in `bfac5ce`: every `[[`-like run is broken whatever tag follows. |
| F8 module off leaves no deadline | **Resolved** | `service.ts:74-77` starts the worker regardless. `assessor.ts:60-65`. | — |
| F9 revision is the assessor's word | **Resolved** at 79d990c, with a gap | `runtime/service.ts:480-485` stores the runner's `workspaceCommit` only for trigger `feedback`. It is cleared at the claim (`dispatch.ts:116`) and bound in `dispatch.ts:231-236`. | The commit reported could differ from the exported tree: a local commit in Whombat's worktree (NEW-2). Fixed in `bfac5ce` (the value `exportTree` returns). Owner self-approval: unchanged by decision (FB-F2-09). |

## Merge interactions (F1 intake × F2 assessment)

- **`service.ts` start/close ordering.** `start()` arms the assessor once (guarded by `onNudge`) and then the
  retention timer once, with or without the module.
  - `close()` clears the timer, drops `onNudge` so later nudges are no-ops, awaits the assessor's current pass
    (`assessor.ts:91-95`: `#closed` first, so no new pass starts), then terminates the image worker, then awaits a
    running sweep.
  - Jobs still waiting on images fail with `internal`. That only happens after Fastify stopped taking requests,
    because this runs in `onClose` (`app.ts:142-151`).
  - A `start()` after `close()` would re-arm only the sweep (the assessor stays closed). That is harmless, since
    the server never does it.
- **Constructor.** The image pool is lazy (no worker until the first job) and `unref`s an idle worker. The handoff
  guard and reconciler are registered once per service.
- **Decisions file.** FB-01, FB-F05 and FB-F2-08 now agree that `off` closes only `/embed`, with the worker and
  retention running. FB-F03 matches the code: the slot is taken before the buckets, and a refused request costs
  no tokens.
- **Widget retry.** One `Submitter` path (see R1-2), so the retry resends the same body.
- **Other merge findings.** Out-of-date fixture texts and `.env.example` were found and fixed in `bfac5ce`.
  Upgrading an older runner without the server (N6) is now documented (`d7a4dec`).

## New findings

### N-S1 — Low-Medium — Slow request bodies hold the intake's in-flight slots with no time limit (open)

- **Where:** `apps/server/src/feedback/public.ts:199-203` (the slot is taken in `onRequest`, before the body is
  read) and `slots.ts:9` (`INTAKE_IN_FLIGHT = { global: 4, perIntegration: 2 }`). The app sets no
  `requestTimeout` or `connectionTimeout` (`app.ts:63-68`), and Fastify 5.12 defaults both to 0, so there is no
  limit. The slot is released only on response or when the socket closes.
- **Scenario:** anyone who knows a public site id opens 2 connections.
  - Each sends valid headers and `Content-Length: 100000` (under the cap), then a few bytes of body, then nothing.
  - Each takes one token (the per-source bucket allows 5 per hour by default), and together they hold both of the
    integration's slots for as long as the sockets stay open, which can be hours.
  - Every real visitor of that website gets 429 “try again in 5 s” until the attacker disconnects.
  - With a second site id, even the attacker's own integration on the same server, 4 sockets fill the global cap,
    and every integration in the process stops taking reports.
  - The cost to the attacker is 2–4 idle TCP connections and 2–4 tokens per hour. Review 1's fix added the slots,
    so this weakness is new with it.
  - Proxies such as Caddy and nginx pass a slow body through within their own timeouts (nginx
    `client_body_timeout` defaults to 60 s between reads, so a byte a minute keeps it open). Exposing the server
    directly gives no bound at all.
- **Verified:** probe int test at `79d990c`.
  - It opens two raw sockets, sends headers and `{"submissionId":`, waits until `inFlight === 2`, and waits 8 s.
  - An ordinary `submit()` to the same site then gets **429**, with both slots still held.
  - The existing review1 test “a client that disconnects in the middle of its body gives its slot back” shows that
    only a disconnect frees a slot. At `bfac5ce`, `public.ts`, `slots.ts` and `app.ts` are unchanged.
- **Suggested fix:** bound how long the body may take.
  - Set a per-request body deadline in the public scope: for example, from `onRequest`, `req.raw.setTimeout(…)`,
    or a timer that destroys the socket when the whole body hasn't arrived within about 15–30 s. Optionally also
    require a minimum rate for large bodies.
  - Optionally set a server-wide `requestTimeout` (for example 60 s; also good for `/api`).
  - Consider taking the slot only after the body has arrived, and bounding raw-body memory with a separate count
    that has a short timeout.
  - A regression test like the probe should show the slot freed and a legitimate submission accepted after the
    deadline.

```ts
// probe (not committed), apps/server/src/feedback/*.int.test.ts, useTestServer({ seed: true, app: true, listen: true })
const { siteId } = await createIntegration(t, { limits: { reportsPerHour: 1000, reportsPerDay: 10_000, perSourcePerHour: 100 } });
for (let i = 0; i < 2; i++) {
  const s = connect(port, host); await once(s, 'connect');
  s.write(`POST ${reportsPath(siteId)} HTTP/1.1\r\nHost: …\r\nContent-Type: application/json\r\nContent-Length: 100000\r\n\r\n{"submissionId":`);
}
await vi.waitFor(() => expect(t.services.feedback.intakeSlots.inFlight).toBe(2));
await sleep(8000);
expect((await submit(t, siteId, submission())).statusCode).toBe(429); // passes: still locked out
```

### Findings of the parallel passes (fixed in `bfac5ce`, see `review-3-fixes.md`)

| Id | Severity | Summary | Resolution |
|---|---|---|---|
| NEW-1 | Medium-Low | The Codex assessor's `:read-only` profile could read the owner's files: `~/Code`, `~/.bashrc`, other repos. | `0a5133a`, FB-F3-01 |
| N2 | Low-Medium | A report root's screenshots reached unrestricted agents mentioned in the channel or thread. | `22f11ad`, FB-F3-12 |
| N3 | Low-Medium | Content removal left the assessor's words: the assessment's free text and its thread replies. | `6f96b67`, FB-F3-11 |
| NEW-2 | Low | The commit marked verified could differ from the exported tree. | `f378390`, FB-F3-02 |
| NEW-3 | Low | Search returned assessor text without the untrusted wrapper. | `c694898`, FB-F3-03 |
| NEW-4 | Low | `defuseFeedback` missed some spellings. | `58056b3`, FB-F3-04 |
| NEW-5 | Low | The handoff note was truncated on the approval card, so the approver didn't see what the developer got. | `67d4b6f`, FB-F3-05 |
| N4 | Low | System principals (Feedback) could be edited, DMed, added and mentioned through agent and member commands. | `e61bfa4`, FB-F3-10 |
| F6 race | Info | The queue-deadline settle could cancel a turn that had just been claimed. | `55a3fcd`, FB-F3-07 |
| NEW-6 | Info | The unverified revision text was shown outside the assessment block. | `af8db20`, FB-F3-06 |
| N6 | Info | Running an older runner against the new server was undocumented. | `d7a4dec`, FB-F3-09 |
| N7 | Test flake | A claim test failed under load (the runtime's unrunnable sweep). | `45238f6`, FB-F3-08 |
| — | Info | Fixture texts and `.env.example` were out of date. | `bfac5ce` |

## Boundary checks confirmed (79d990c)

- **No visitor identity.**
  - Public routes never read cookies or authenticate (`public.ts:1-18`, own scope, no CORS, ACAO stripped at
    `:149`).
  - The only actor is the burrow's Feedback principal (`feedbackPrincipal`, `public.ts:276`). It can no longer be
    edited, DMed or mentioned after N4.
- **No public read route.** The scope registers only `GET …/config` (public settings only: `publicConfigOf`,
    `public.ts:57-80`) and `POST …/reports`, plus the embed assets.
- **Receipt is minimal.** A receipt is `{reference, receivedAt}` only, on 201, on replay (`receiptFor`,
  `public.ts:324-343`) and on a concurrent duplicate (`:302-305`). A different payload gets the fixed 409 body.
- **Routing is not the visitor's.** The integration comes from the site id row. The strict `FeedbackSubmission`
  has no channel, agent or repo field. `parentOrigin` must be allowlisted (`public.ts:249`).
- **Inert text.**
  - Message text is fixed, with `mentions: []` and `dispatch: false`.
  - Replies are `inertReply`. Assessor posts carry `provenance`.
  - Automations skip the Feedback principal, provenance messages and reactions to them, and agents in report
    threads (`engine.ts:444-462`).
  - The search index has no assessor text after NEW-3. Screenshots stay out of unrestricted agents after N2.
- **Assessor can't escalate.**
  - It gets four MCP tools, a read-only runner, no workdir (F3), and a Codex allowlist profile (after NEW-1).
  - The server refuses trusted and ACP runtimes (F5). `reproduced` requires sandboxed commands (F4).
- **Revoked authority fails closed.** Owner demoted, agent removed, trusted or ACP, repo off, or integration
  paused: the report is blocked or paused at the start, the claim and the submit (F5, review2 “F5” cases).
- **Module off.** `/embed` is not registered. The worker and retention keep running (F8, R1-4). No `/api`
  behaviour changes.

## Resolution of N-S1 (orchestrator)

Fixed in `1c2ea83` on `feedback-widget` (FB-R3-01): one in-flight slot per client address and integration, and a
body deadline of 15 s + 64 KB/s of the declared length (at most 120 s) that drops a stalled upload and frees its slot.
Proven by `review1.int.test.ts` (“a stalled body loses its connection and its slot at the deadline”, “one address holds
at most one slot per integration”) and the `IntakeSlots` unit test in `feedback.test.ts`.
