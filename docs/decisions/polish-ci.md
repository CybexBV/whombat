# polish-ci workstream decisions

## CI flakiness in `apps/web/src/features/messaging/screens.test.tsx`

Three tests sat close enough to vitest's 5 s default `testTimeout` that a busy CI runner (shared cores,
many workers) tipped them over the edge:

- `sends with Enter; the mentioned agent thinks, then replies in place` and `opens the thread pane from
  the replies link and posts replies there` cross `FIXTURE_REPLY_DELAY_MS` (1.6 s), the real `setTimeout`
  fixture mode uses to simulate an agent's reply when there is no realtime socket (see `useRoom.ts` and
  `docs/decisions/messaging.md`, MS-11). On an idle machine 1.6 s comfortably fits under 5 s; under CI
  load it sometimes didn't.
- `the empty Hazel DM offers three suggestions…` doesn't cross that delay, but its `findByRole`/`findByText`
  calls used `@testing-library/dom`'s default 1000 ms `asyncUtilTimeout`, which is tuned for an idle
  machine. Reproduced locally by saturating all cores with busy-loop processes before running the test: the
  failure mode was `TestingLibraryElementError: Unable to find role="heading"…` — a timeout-budget problem,
  not an application bug (no code path was found that could lose the composer's draft or the heading).

Fixes:

1. `apps/web/src/test/setup.ts` raises `configure({ asyncUtilTimeout: 5000 })` globally for the web
   package, and `apps/web/vitest.config.ts` raises `testTimeout: 15000` to give a slow CI runner headroom
   above that raised `asyncUtilTimeout` without masking a truly hung test (it's still finite).
2. `useRoom.ts` gets a test-only seam, `__setFixtureReplyDelayForTests(ms)`, that overrides
   `FIXTURE_REPLY_DELAY_MS` for `simulateAgentReplies`'s internal `setTimeout`. Production, Storybook and
   every other test keep the real 1.6 s (the product behavior documented in MS-11 is unchanged). The one
   test that crosses the delay sets it to 250 ms — long enough that `waitFor`'s ~50 ms poll interval
   reliably observes the intermediate "Pippa is thinking" state before it clears, short enough to stay far
   under the timeout budget — and then waits on the resulting state changes (`findByText`) rather than a
   fixed wall-clock sleep.
   - Fake timers (`vi.useFakeTimers()` / `vi.advanceTimersByTimeAsync`) were tried first per the task's
     suggestion but don't mix safely with this screen's render path: the `setTimeout` inside
     `simulateAgentReplies` is scheduled by a real timer during the `user.keyboard(...)` step (before any
     `vi.useFakeTimers()` call in the test), and vitest's fake timers do not intercept timers that were
     already scheduled on the real clock — advancing the fake clock afterwards does nothing for that
     pending real timer. Switching to fake timers *before* the send avoids that, but then hangs: the
     fixture bootstrap fetch and `@tanstack/react-query`'s scheduling both rely on `setTimeout` internally,
     and once every `setTimeout` in the process is faked, `findBy*`/`waitFor` calls that depend on those
     lower-level timers firing never resolve without also manually driving those internals, which is
     fragile and not worth it for this one delay. Shrinking the delay itself sidesteps both problems.
3. Scanned the rest of the suite (`grep` for `setTimeout(r, …)` wall-clock sleeps and long `waitFor`
   timeouts) — the remaining ones are all small (5–400 ms) real-time round trips in `apps/server` and
   `apps/runner` integration/unit tests (websocket delivery, debounce windows), well under the 5 s default
   `testTimeout` even under load; none showed up in the CI failures and none were changed.

Verified: `apps/web`'s full test suite (26 files, 217 tests) passes; `screens.test.tsx` alone passes
repeatedly, including once with all 64 cores saturated by busy-loop processes (ran in ~12.7 s, still well
inside the 15 s `testTimeout`). `gh run list`/`gh run view --log-failed` on the two red `main` runs
(35887791388, 35880641724) confirmed these three tests were the only failures; no other CI failures in
recent runs are unaddressed.

## Seed fidelity: run steps and files at 11:22

The mock's `RSTEPS` (5 steps) and `FILES` (6 files) constants were already fully present in
`packages/fixtures/src/live.ts` (`RUN_STEPS_TIMELINE`) and `packages/fixtures/src/work.ts` (`pr.files`),
but the *seeded run itself* — `work.ts`'s `run`/`runFinished` exports — still had the old 2-step/2-file
placeholder arrays, so the server seed (and the parity test comparing it against the fixtures) only ever
showed two steps/files until `demo:play`'s `PrepareRun`/`layOutSteps` filled the rest in at runtime.

Fix: expanded `run.steps` (1 active + 4 queued, matching `RUN_STEPS_TIMELINE`) and `run.files`/
`runFinished.files` (6 entries, matching `pr.files`) in `packages/fixtures/src/work.ts`, and the same
stale 2-item arrays in two other seed sources that don't derive from `@whombat/fixtures`:
`apps/server/src/seed/test-world.ts` (server integration test seed) and
`packages/core/src/__fixtures__/world.ts` (documented in `work.ts` as the "authoritative minimal slice"
other fixtures should mirror).

`apps/server/src/demo/director.ts`'s `PrepareRun` command already compares the seeded steps' titles
against `RUN_STEPS_TIMELINE` and returns early when they already match, so no code change was needed
there — once the seed data itself has all five steps, `PrepareRun` becomes a no-op, satisfying the task's
requirement purely through data fixes.

Verified: `packages/core`, `apps/server` and `packages/fixtures` unit tests; `apps/web`'s
`RunScreen.test.tsx` (extended to assert all five step labels/states and all six file paths at 11:22);
and the full `pnpm test:server` integration suite (156 tests), including `fixtures.int.test.ts` (the
parity test) and `demo.int.test.ts` (asserts all-`done` after play, back to 1-`active`/4-`queued` after
rewind).

## Onboarding repos: four repos, billing and web switched on

`packages/fixtures/src/burrow.ts`'s `REPOS` already listed all four repos (billing, web, infra, docs)
with descriptions — the gap was in `packages/fixtures/src/onboarding.ts`'s `onboarding.repos`, which
reused `REPOS[].enabled` verbatim. That field is the *already-onboarded demo burrow's* current
connected-repo state (billing/web/infra on, docs off — consumed by `apps/server/src/github/visibility.ts`
and friends for GitHub visibility scoping), not a *fresh* onboarding flow's toggle defaults. The mock's
step 2 seeds `S.repos` with only `{'whombat/billing': true, 'whombat/web': true}`; any repo not in that
map (infra, docs) reads as off.

Fix: `onboarding.repos` now sets `enabled` explicitly to `r.id === rep_billing.id || r.id === rep_web.id`,
independent of `REPOS[].enabled`, so a fresh onboarding always starts with only billing and web switched
on regardless of the demo burrow's own connected state.

Also updated `OnboardingScreen.test.tsx`'s mocked-server walkthrough test, which builds its own repo list
for the `POST /burrows` / `PATCH .../onboarding` responses: it now seeds that list's `enabled` flags from
`onboarding.repos` (keeping the full `Repo` shape from `REPOS`, since the write endpoints' contract needs
fields — `burrowId`, `defaultBranch` — that `OnboardingRepo` doesn't carry) instead of `REPOS[].enabled`
directly, and asserts all four toggles' initial state (`true, true, false, false`).

Verified: `packages/fixtures` (63 tests, including two new ones asserting `REPOS`' four repos/descriptions
and `onboarding.repos`' enabled states) and `apps/web`'s full suite (217 tests) pass.

## Mobile inbox: MENTIONS orders oldest first

The mock's `mentions` array (`Whombat Mobile.dc.html`) lists Priya's `#incidents` mention (10:40) before
Pippa's DM reply (14:04) — the opposite of both other sections, which put the newest item first (`needs`:
11:25 before 11:02; `agents`: 11:36 before 09:00). `apps/mobile/src/fixtures/fixture-server.ts` already
serves the inbox straight from `@whombat/fixtures`' `NOTIFICATIONS` array in the mock's declared order, so
the mobile app against fixtures was already right — `fixture-server.test.ts` covers it. The real server's
`apps/server/src/read/work-views.ts#inbox()`, though, built every section from one query ordered
`desc(createdAt)`, so MENTIONS on a live (or fully-seeded) burrow would show Pippa before Priya.

Decided rule: NEEDS YOU and FROM AGENTS are status feeds — the newest item supersedes the old one, so
newest-first is right. MENTIONS is a queue of things waiting on a reply — oldest-first means an
early-morning ask doesn't get buried under an afternoon one, matching the mock and the more natural
"work through it in order" reading of an inbox. Implemented as `sectionOrder()` in `work-views.ts`: it
reverses the (already `desc(createdAt)`-sorted) `mention` items to ascending; `needs_you`/`agent_update`
are untouched.

Verified: two new tests in `apps/server/src/read/work-views.int.test.ts` (mentions oldest-first,
needs-you unchanged, both against a real Postgres, inserted in the "wrong" row order to rule out an
insertion-order accident) and a new assertion in `apps/server/src/seed/fixtures.int.test.ts` (the parity
suite) that the real seeded server's `notifications.inbox` MENTIONS section is Priya then Pippa, matching
the mock — `notifications.inbox` isn't in `createFixtureFetch()`'s implemented set, so this checks the
real server directly rather than through `expectSameShape`. Full `pnpm test:server` (159 tests) and the
mobile suite (unaffected, already correct) pass.

## Audit log: closing a non-default row no longer reopens `evt_9f18`

`docs/decisions/audit-search.md` (the `audit-search` workstream) already root-caused and documented this
exact bug when it built `AuditLogScreen`'s default-open behavior: the implicit default (`evt_9f18`, per the
mock's `logOpen: 'e-9f18'` seed state) is tracked with a local `defaultDismissed` boolean rather than in the
URL, because putting the default in the URL layer made the row impossible to close (see that file for the
full history). `onToggle`'s original condition only set `defaultDismissed` when the row being closed was
the implicit default with no `open` param set:

```tsx
if (isOpen && open === undefined) {
  setDefaultDismissed(true);
} else {
  onChange({ open: isOpen ? undefined : event.id });
}
```

Opening a *different* row sets `open` to that row's id; closing it again then hits the `else` branch
(`open` is defined, so the guard fails), which clears `open` back to `undefined` but never touches
`defaultDismissed` — so `effectiveOpen` immediately falls back to re-showing `evt_9f18`, even though the
user just closed something and expects the log to stay fully closed.

Fix: closing *any* row (the implicit default or one the user explicitly opened) sets `defaultDismissed`,
and the URL is only touched when `open` was actually set:

```tsx
if (isOpen) {
  setDefaultDismissed(true);
  if (open !== undefined) onChange({ open: undefined });
} else {
  onChange({ open: event.id });
}
```

This doesn't reopen the old "default lives in the URL" bug that `audit-search.md` describes: the URL is
still never asked to represent "no explicit selection, but also not the default" — that distinction stays
in local state (`defaultDismissed`), the URL only ever holds a real, explicit `open` id or nothing.

Verified: added `'closing a different, explicitly-opened row does not reopen the default evt_9f18 row'` to
`apps/web/src/features/audit/AuditLogScreen.test.tsx` (opens a non-default row, confirms the default closes
since only one row is open at a time, closes the non-default row, confirms the log stays fully closed) —
fails against the old code, passes against the fix. Full `apps/web` suite (26 files, 218 tests) passes,
including the other audit-log behaviors `audit-search.md` calls out as verified (default open, filter by
agent, each kind filter).

## TODO 12.1: search indexing audit — one gap found, `record_push`

Audited every command that writes content the product's search claims to cover (messages/thread replies,
runs, patches/PRs, canvases) for two things: (1) does it call the matching `domain/search-index.ts` indexer
via `ctx.after(...)`, and (2) does `commit()` actually wait for that hook before resolving. On (2): yes,
architecturally — `commit/pipeline.ts`'s `Pipeline.commit()` doesn't resolve until `afterCommit()` finishes,
and `afterCommit()` sequentially `await`s every registered post-commit hook, so any command that registers
a search-index hook gets "immediately searchable" for free. That ruled out a whole class of possible bugs
(no debouncing/polling/queueing to fix) and narrowed the audit to (1), purely "did every write path that
should call an indexer actually call one."

Findings, by content type:
- **Messages/thread replies** — `commands/messages.ts`'s `sendMessage` already calls `indexMessage` for the
  new message and, when it's a reply, re-`indexMessage`s the thread root too (so the root's search doc
  flips from `MESSAGE` to `THREAD`). Correct.
- **Runs** — `commands/agent-runs.ts`'s `startRun` and `finishRun` (via a shared `finish()` helper) both
  call `indexRun`, so a run is searchable on start and its `finish_run` summary is searchable immediately.
  Correct.
- **Canvases** — `commands/content.ts`'s `createCanvas` calls `indexCanvas`. Correct. (Live Yjs edits to an
  existing canvas go through `collab/service.ts`'s debounced `scheduleIndex`/`index()`, a deliberately
  separate realtime-collab path outside the signed-event commit pipeline — out of scope for "immediately
  through the commit pipeline.")
- **Patches/PRs** — `commands/agent-tools.ts`'s `openPr` and `commands/prs.ts`'s `mergePr` both call
  `indexPullRequest`. **Gap**: `commands/agent-tools.ts`'s `recordPush` — the command an agent calls to
  report a git push (mirrors a GitHub push, appends to `prCommits`, updates `headSha`) — updated the PR's
  commit list but never re-indexed it. `indexPullRequest`'s text is
  `[pr.title, pr.branch, ...commits.map(c => c.message)].join('. ')`, so a freshly pushed commit's message
  was invisible to search until some unrelated PR action (a later merge or review-triggered path) happened
  to call `indexPullRequest` again. `reviewPr` was checked too and is fine as-is: it doesn't add to the
  indexed text itself (review state isn't part of `indexPullRequest`'s text), it only posts a message, which
  self-indexes via `indexMessage`.

Fix, in `commands/agent-tools.ts`'s `recordPush`:

```tsx
if (pr) await publishPr(ctx, pr.id, event.id);
const services = ctx.services;
const tz = ctx.burrow.timeZone;
ctx.after(() => services.approvals.reevaluate(ctx.burrow.id));
// A push adds a commit to `prCommits`, part of the patch's indexed text (`indexPullRequest`'s
// `cardText`/commit-message join) — re-index so the new commit message is searchable immediately,
// same as `open_pr` (agent-tools.ts) and `merge_pr`/`review_pr` (prs.ts) already do on their own writes.
if (pr) ctx.after(() => indexPullRequest(services.db, pr.id, tz));
return { prNumber: pr?.number ?? null, eventId: event.id };
```

New test file `apps/server/src/domain/search-index.int.test.ts`: five integration tests, one per content
type, each calling a real command through `t.commit()` and then a real authenticated
`GET /search` (via `app.inject`, no wait/poll in between) to prove the write is visible through the actual
read path, not just present in the table. Two test-only gotchas worth recording since they looked like app
bugs at first:
- `tsQuery()` (`read/search.ts`) OR's an unquoted multi-word query and phrase-ANDs a quoted one
  (`/["]|(^|\s)-\S|\sor\s/i` decides which); an unquoted two-word assertion can pass on a false-positive
  match against unrelated seeded content, so every multi-word query in the new tests is quoted
  (`'"gronkulate export"'`, `'"kumquat migration"'`, `'"deploy timing"'`) to force the precise phrase match.
- `visibleConversations()` gates search results by conversation membership; the PATCH test passes
  `conversationId: IDS.general` to `openPr` so the viewer (Mara) is actually a member of the new branch
  room, otherwise the PR's search doc exists but is invisible to her regardless of indexing.

Verified: all 5 new tests pass. Confirmed the PATCH test is a genuine regression guard, not vacuous — used
`git stash push -u -m "polish-ci-issue6-verify" apps/server/src/commands/agent-tools.ts` to temporarily
revert only the fix, re-ran the suite (the "pull request and its pushed commits" test failed exactly as
expected, all others still passed), then restored the fix with `git stash apply <sha>` and dropped the
stash entry. Full `pnpm test:server` and `pnpm check` pass with the fix in place (see below).
