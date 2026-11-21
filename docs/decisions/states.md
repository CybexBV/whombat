# Workstream: quiet states (TODO 16.4)

Every list/data view on web and mobile gets quiet empty, loading and error states in the mocks' visual
language, per B-05 (screens not mocked follow the nearest mocked pattern, quietly). This is a read-heavy
workstream: no new contracts (see ST-04 below for the one thing that was *not* added), mostly UI wiring
plus a small addition to `@whombat/fixtures`' fetch so the new states are testable.

## Loading: skeleton rows, not spinners

`apps/web/src/components/ListState` (web) and `apps/mobile/src/ui/primitives.tsx` (mobile) both export:

- `Skeleton` — one pulsing block (web: CSS animation, respects `prefers-reduced-motion`; mobile: a
  static `View` — RN has no reduced-motion media query to key off here, so it just doesn't animate).
- `SkeletonRows({ count, avatarSize?, lines, ... })` — `count` repeated rows, each an optional leading
  avatar circle plus `lines` text bars at varying widths (`62% / 40% / 78% / 52%`, cycling), sized to
  match the row geometry it stands in for (e.g. `avatarSize={44}` for a roster row, `avatarSize={32}`
  for a members row, no avatar for a plain two-line row).
- `ErrorNote` (web) / `ErrorState` (mobile, pre-existing) — one line + optional Retry.
- `EmptyNote` (web) / `QuietText` (mobile, pre-existing) — quiet centered text.

Both use only `@whombat/tokens` CSS variables / theme colors — no hex literals.

## ST-01 — Copy written for this workstream

All new copy follows the mocks' voice: short, plain, no exclamation marks, curly quotes.

| Screen | State | Copy |
|---|---|---|
| Canvases index | error | "Couldn't load canvases. Try again in a moment." |
| Canvases index | empty | "No canvases yet." |
| Canvas | error | "Couldn't load this canvas. Try again in a moment." |
| Search | no results | "No results for "{q}"." |
| Search | error | "Couldn't search the burrow. Try again in a moment." |
| Search (mobile) answer failed | — | "Couldn't find an answer." (mirrors web's `AnswerCard` `status === 'failed'` meta "couldn't find an answer") |
| Run | not found | "This run doesn't exist, or it's in a room you're not in." |
| Run | other error | "Couldn't load this run. Try again in a moment." |
| Files table | empty | "No files changed." |
| Branch pane CHECKS | empty | "No checks on this branch." |
| Branch pane REVIEWERS | empty | "No reviewers yet." |
| Approval modal | not found | (existing "This request isn't here any more, or it's in a room you're not in." copy, now shown from a skeleton instead of "Loading the request…" text) |
| Approval screen (mobile) | not found | "This request isn't here any more, or it's in a room you're not in." (matches the web modal's copy) |
| Onboarding slug check | network error | "Couldn't check that name." + inline Retry |
| Settings REPOS | error | "Couldn't load repos. Try again in a moment." |
| Settings MEMBERS | error | "Couldn't load members. Try again in a moment." |
| Shell (burrow load) | error | (existing) "Couldn't load this burrow. Try again in a moment." |
| Shell | realtime reconnecting/closed | "Reconnecting…" (small indicator, bottom-left of the frame) |

Audit log's existing empty copy ("Nothing in the log matches these filters.") was left as-is per the
task — it already reads correctly once the loading/empty distinction below was fixed.

## ST-02 — Audit log's loading/empty bug, and why the test changed

`AuditLogScreen` (and, independently, `SettingsScreen`'s REPOS/MEMBERS sections) had the same latent
bug: the list defaulted to `[]` while the underlying query was still `undefined` (loading), so the
"nothing here" empty copy rendered *during loading*, not only when a filter combination was genuinely
empty. Fixed by branching on `error` / `!data` / actual-empty separately, with a skeleton for the
loading branch.

This changed one existing test's premise: `actor=people&kind=keys` is **not** actually empty in the
fixture world — Mara Okafor (a person) has a `Keys`-kind audit event ("Gave Banjo a new key: Run
tests"), so that filter combination now correctly shows a result instead of "silently" showing empty
copy during a load that finishes synchronously in tests. The test was switched to
`actor=people&kind=code`: no person actor (`mara`, `joris`, `priya`, see `packages/fixtures/src/audit.ts`)
has a `Code`-kind event, so that combination is genuinely empty.

## ST-03 — Fixture fetch failure/latency switches

`createFixtureFetch(options?: FixtureFetchOptions)` in `packages/fixtures/src/fetch.ts` (exported via
the `@whombat/fixtures/fetch` subpath) gained:

```ts
export interface FixtureFetchOptions {
  /** Delay before every response, in ms — enough for a loading skeleton to be observed in a test. */
  latencyMs?: number;
  /** Endpoint ids that 500 instead of serving fixture data. A fixed set, not one-shot: retrying an
   *  endpoint still in `failing` fails again. */
  failing?: ReadonlySet<string> | readonly string[];
}
```

`failing` matches on `AnyEndpoint['id']` (e.g. `'agents.list'`, `'canvases.list'`) and returns
`{ error: { code: 'server_error', message } }` with a 500. This is the one mechanism web and mobile
tests use to force a screen's error-with-retry branch, and `latencyMs` is the one mechanism used to
force its loading branch — no separate mock needed per screen.

Mobile's `createFixtureServer({ inner: createFixtureFetch({...}) })` forwards most endpoints straight
to `inner` (so `failing`/`latencyMs` apply), but a few — `notifications.inbox`, `notifications.markRead`,
and the approval mutations pinned to the fixtured approval number — are answered directly by the
fixture *server* for its own stateful mocking (typing, approve/decline/undo) and never reach `inner`.
Tests exercising `failing`/`latencyMs` on mobile should pick a forwarded endpoint (`agents.list`,
`runs.get`, `canvases.list`, …), not `notifications.inbox`; see
`apps/mobile/src/fixtures/fixture-server.test.ts`'s "fixture fetch failure/latency switches" block.

## ST-04 — No `'timeout'` value added to `AnswerStatus`

`AnswerStatus` stays `'pending' | 'ready' | 'failed' | 'none'` (`packages/core`). The task's "answer
failed/timeout" is handled as: the fixture only ever produces `'failed'` (a real timeout looks
identical to any other failure to the UI — no distinct signal crosses the wire for it), so timeout is
UI-level framing of the existing `'failed'` status, not a new contract value. Both `AnswerCard` (web)
and `SearchScreen`'s inline answer block (mobile) already render `status === 'failed'` with "couldn't
find an answer" — mobile's block was previously `ready`-only and now also renders for `'failed'`.

## ST-05 — Run/approval "not found" vs. generic load error

`useRun` / `useApproval` (web) and their mobile equivalents throw `ApiError` with `.status` on non-2xx.
Both `RunScreen` (web + mobile) and `ApprovalScreen`/`ApprovalModal` now check `'status' in error &&
error.status === 404` to show the quiet not-found copy without a Retry button (retrying a 404 does
nothing useful), falling back to the generic "didn't load" + Retry copy for any other error (network
failure, 500, etc).

## ST-06 — Realtime "Reconnecting…" indicator

`useRealtimeStatus()` (`packages/client/src/react/realtime.ts`, pre-existing) exposes
`'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed'`. `ShellLayout` (web) renders a small,
absolutely-positioned `role="status"` pill reading "Reconnecting…" while the status is `'reconnecting'`
or `'closed'`, tokens-only styling, no layout shift. Mobile has no always-on socket indicator in scope
here — mobile screens already show a per-request `ErrorState` with Retry when a fetch fails, and the
mock has no persistent connection chrome on mobile to extend.

## ST-07 — Scope limitation: no new mobile screen-render test infrastructure

Mobile has no screen-render test harness (no React Native Testing Library setup in this repo as of this
workstream) — existing mobile tests are all logic/data-level (`vitest`, `environment: 'node'`, view
models and the fixture server, not rendered components). Building that harness is a larger, separate
investment than this task's scope. Mobile's quiet-state UI changes (`Skeleton`/`SkeletonRows` swapped in
for `Loading`, not-found branches, the search answer-failed branch) are applied directly to the screens
and covered indirectly by:

- The mobile typecheck (`tsc --noEmit`) catching wiring/type errors.
- `apps/mobile/src/fixtures/fixture-server.test.ts`'s new `failing`/`latencyMs` tests, which exercise
  the same `.error`/`.isPending` conditions the screens branch on, at the data layer.
- Existing view-model tests (`data.test.ts`, `run.test.ts`, …) which are unaffected by this workstream.

Web is not under this limitation: it already has a Testing Library setup, so web gets both fixture-level
tests and (per the task) stories for each new state.

## ST-08 — Search "no results" state exists but is untestable through the fixture world as-is

`SearchScreen` already renders `EmptyNote` "No results for "{q}"." when a query's result set is empty
(`apps/web/src/features/search/SearchScreen.tsx`). But `handleSearchQuery` in
`packages/fixtures/src/fetch.ts` filters `SEARCH_RESULTS` only by `type`, not by `q` — so no query text
can currently drive the fixture endpoint to zero results (`SEARCH_RESULTS` is non-empty and every type
has at least one result). Making the fixture actually filter by query text is a bigger, riskier change
than this workstream's scope justifies (it would touch `SearchScreen`'s existing "shows results as you
type" tests, and the seeded corpus wasn't written with match/no-match cases in mind). Left as-is: the
empty-copy branch is implemented and correct, just not exercised by a fixture-driven test here. A
future search-fixture workstream that seeds deliberate match/no-match queries should add the coverage.

## ST-09 — `ShellError`'s "Couldn't load this burrow" copy is reachable only for a bootstrap re-fetch, not the first load

`BurrowShell` reads its bootstrap via `useBootstrap()` (a query) and renders `ShellError` when that
query has an `error` and no cached `data` (`apps/web/src/app/shell/BurrowShell.tsx`). But the `$burrow`
route's `loader` (`apps/web/src/app/router.tsx`) calls `ensureQueryData` for the same query *before*
`BurrowShell` mounts, and a loader throw is caught by the **root** route's `errorComponent` (`ErrorPage`,
an `AuthLayout` page with its own "Can't reach the burrow" / "Whombat didn't answer…" copy) — not by
`BurrowShell`'s own branch. So on a first-load bootstrap failure, `ErrorPage` renders, not `ShellError`.
`ShellError` is only reachable if the initial load succeeds (the loader resolves, `BurrowShell` mounts)
and a *later* `useBootstrap()` fetch then fails with nothing cached to fall back to — a narrower
condition than "the burrow failed to load." This is a pre-existing routing structure, out of scope to
change here (touching the root error boundary or giving `$burrow` its own would affect every route under
it); `ShellError` stays as component-level defense in depth, and `ShellLayout.test.tsx` exercises it and
the "Reconnecting…" pill as units (`render`ed directly under `WhombatClientProvider`) rather than through
the router, so the test asserts what the component does without depending on which failure path the
router takes to get there.
