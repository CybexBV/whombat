# Workstream: canvas + onboarding (`apps/web/src/features/canvas`, `apps/web/src/features/onboarding`)

TODO 11.4 (canvases index) and 14.1–14.2 (onboarding). Builds on `web-shell.md`, `tokens-primitives.md`,
`avatars.md`, `client.md`, `core-contracts.md` and `fixtures.md`.

## Canvas screen scope

- `CanvasScreen.tsx` renders the detail view (header, provenance, plan-synced steps, rules, comments)
  for every seeded canvas, but the Goal/Rules/Out-of-scope body prose is the reference mock's copy for
  exactly one canvas (`invoice-pdf-export-plan`, `MOCKED_CANVAS_SLUG`). `CanvasDetail` has no body field
  in the contract yet, so the other three seeded canvases (kept only so the sidebar's "Canvases · 4"
  count is real, see `fixtures.md` FX-15/`seed-wiring.md` SW-03) show a placeholder line instead of
  invented copy. A later Yjs/Tiptap editor replaces this without touching the layout.
- Creating a new anchored comment thread (selecting body text to start a thread) is out of scope here —
  the mock's anchors are fixture-only opaque `relativePosition` data, and the real anchoring UI depends
  on the collaborative doc (TODO 11.1, not yet built). Replying to an existing thread and
  resolving/reopening it are implemented against the real `addComment`/`resolveComment` contract
  endpoints.
- The comments column's per-thread "Resolve"/"Reopen" button and "Reply…" input are not literally drawn
  in the reference mock's canvas screen (its static aside only lists comment text — reply/resolve only
  appear in the separate conversation "Thread" panel elsewhere in the mock). We keep them: the contract
  already defines `addComment`/`resolveComment` for this screen, the interaction pattern (a reply box
  under a thread) already exists elsewhere in the reference, and a live app reasonably exposes the
  affordances a static demo has no backend to show. This is a visual mismatch against the static
  screenshot at ~0.6–0.8% (measured, see below) that we accept rather than "fix" by removing working
  functionality.

## Fixture fixes (shared file, minimal/additive)

Found via close visual diffing against the reference (not just aggregate mismatch %, which can hide
distinct bugs cancelling out in magnitude). All are plain reads or existing-pattern fixes, not new
product behavior:

- **`members.list` added to `createFixtureFetch()`'s `IMPLEMENTED` set** (`packages/fixtures/src/fetch.ts`).
  This is a pure read of the existing `PEOPLE` fixture (no state machine), unlike the write endpoints
  FX-12 deliberately defers — so FX-12 doesn't apply. Without it, `usePrincipals()`'s `useMembers()`
  query silently failed, leaving every human principal unresolved: comment/provenance text showed the
  literal `'…'` fallback for "edited by …, Pippa" etc., and presence avatars for humans were invisible.
- **`handleCanvasGet`'s `presentIds` fixed to `[mara.id, sketchAgent.id]`** (was `[mara.id]` only). The
  reference shows "2 here" and a live "Sketch is writing" pill on the plan canvas (Sketch is the plan's
  `provenance.createdById`); the component's existing `writer` logic
  (`presentSet.has(canvas.provenance.createdById)`) already handled this correctly, it just never had
  Sketch in the present set to trigger on.
- **`CANVAS_COMMENTS` timestamps fixed** (`packages/fixtures/src/canvas.ts`): `cmt_pdf_plan_1`/`_2`
  (Pippa/Mara) now use `at('14:05', -1)`/`at('14:07', -1)` (a day before Hazel's same-day `at('11:21')`),
  matching the day-offset pattern already used and unit-tested for this exact scenario in
  `packages/core/src/domain/domain.test.ts`. `groupCommentThreads()` sorts all comments chronologically
  by `createdAt` before grouping into threads, so same-day-but-later-clock timestamps put the Hazel
  thread first — wrong order vs. the mock (Pippa/Mara first, Hazel second). Verified against
  `domain.test.ts` (13/13 passing, no regressions) and `@whombat/fixtures`'s own suite (49/49 passing).

## Component fixes

- **`CanvasScreen.tsx` comment timestamps use `formatClock` (24-hour, no AM/PM)**, the project's
  established time-display convention (`packages/core/src/text/time.ts`), instead of
  `toLocaleTimeString(undefined, {...})`, which is browser-locale-dependent and was rendering "02:05 PM"
  against the mock's "14:05".
- **`CanvasesScreen`/`CanvasScreen` expose `data-screen="canvases"`/`data-screen="canvas"`** on their
  root element, matching the `ScreenPlaceholder`/`PanePlaceholder` convention (`data-screen={screen}`)
  that `apps/web/src/app/router.test.tsx`'s smoke test relies on. `CanvasesScreen` had a stray
  `data-screen-label="Canvases"` left over from before the real screen replaced its placeholder (unused
  anywhere else); `CanvasScreen` had no `data-screen` at all. Also updated that same test's expected
  canvas-detail heading from the placeholder-era literal slug (`'invoice-pdf-export-plan'`) to the real
  rendered title (`'Invoice PDF export'`, via `canvasHeading()`) — both were stale from when these routes
  rendered `ScreenPlaceholder`, not asserting real product behavior. `router.test.tsx` itself is outside
  this workstream's folders but the fix is narrowly scoped to the two screens we own.
- **Plan step owner label uses `PrincipalLite.name` (full name), not `.shortName`.** The reference mock's
  step rows bind `{{ st.a.name }}` — for agents that's already a single word ("Pippa", "Banjo", "Hazel"),
  but for people it's the full name ("Mara Okafor"), not the short form ("Mara") used everywhere else
  (header presence, comment authors, provenance). Confirmed via the reference `.dc.html`'s `PP`/`who()`
  definitions before fixing.

## Fixture-repo-count gap (accepted, out of scope)

`@whombat/fixtures`' `REPOS` has 2 entries; the reference mock's static onboarding step 2 shows 4
(billing, web, infra, docs). This is a fixture data-richness gap, not a canvas/onboarding component bug
— the components correctly render whatever repos they're given, pixel-accurate for the rows that exist.
Flagged as a possible follow-up for whoever owns `@whombat/fixtures`' repo seed data; not fixed here
since expanding `REPOS` is outside this workstream's ownership and risks colliding with other agents'
seed-data assumptions.

## Onboarding scope

- **`ONBOARDING_STEPS` copy lives in `apps/web/src/features/onboarding/onboardingCopy.ts`**, local to the
  web feature rather than `@whombat/core`, per `core-contracts.md`'s rule that `@whombat/core` holds
  cross-platform contracts/domain logic, not screen copy — this screen doesn't exist on mobile yet.
- **Onboarding mutation endpoints are not added to fixtures' `IMPLEMENTED` set.** `burrows.create`,
  `PATCH .../onboarding`, `PATCH .../repos/:id`, `.../onboarding/complete` are writes with real
  server-side state-machine implications (burrow creation, membership, agent hiring), matching FX-12's
  existing rationale for deferring write endpoints from `createFixtureFetch()`. `OnboardingScreen.test.tsx`
  uses a hand-rolled mocked-server, the pattern FX-12 already establishes for this class of flow.
- **`router.tsx`'s onboarding route gained an additive `onSkip` prop** (`apps/web/src/app/router.tsx`),
  wired to navigate to `/`. This is the only shared-file touch beyond the fixtures fixes above; the diff
  is a 5-line addition, no existing behavior changed.
- **The onboarding screen starts blank (no pre-filled burrow name, no pre-filled invites).** The
  reference mock's `S.burrow`/`S.invites` defaults are demo-state for a "returning to edit" narrative in
  the static prototype; a real first-time onboarding flow correctly starts empty. This is an accepted,
  intentional divergence, not a bug — it's the largest remaining contributor to the step-4 screenshot
  diff (~2.3%, see below), entirely explained by the two pre-filled invite rows the mock shows and we
  don't.
- **Standalone-route full-height CSS.** The onboarding route isn't nested inside `ShellLayout`'s flex
  `.main` (unlike e.g. `CanvasesScreen`), so its root `.screen` needs `height: 100vh` (mirroring
  `ShellLayout.module.css`'s `.frame` pattern) rather than `flex: 1`, which has no effect without a flex
  ancestor. Fixed; dropped step-1 mismatch from ~2.1% to ~0.58% in both themes.

## Relative-time copy divergence (accepted, not a bug)

The reference `.dc.html`'s relative-time strings ("12 min ago", "updated 2 hours ago") are literal,
hardcoded copy in the static demo markup (confirmed by grep — not derived from the harness's frozen
clock). A live app correctly computing real relative time from real fixture timestamps will necessarily
diverge from this frozen prose during ad hoc screenshotting. No fix applied.

## Visual verification results (1440×900 unless noted, `pnpm ref:shot` + `pnpm visual:diff`)

| Screen / state | Theme | Mismatch | Remaining difference |
| --- | --- | --- | --- |
| Canvas (plan), 1440px | light | 0.81% | relative-time text + accepted Resolve/Reply affordance |
| Canvas (plan), 1440px | dark | 0.80% | same |
| Canvas (plan), 1100px | light | 0.63% | same |
| Canvas (plan), 1100px | dark | 0.62% | same |
| Onboarding step 1 | light | 0.58% | sub-pixel text rendering only |
| Onboarding step 1 | dark | 0.58% | same |
| Onboarding step 2 | light | 0.29% | sub-pixel text rendering only |
| Onboarding step 2 | dark | 0.28% | same |
| Onboarding step 3 | light | 0.09% | sub-pixel text rendering only |
| Onboarding step 3 | dark | 0.09% | same |
| Onboarding step 4 | light | 2.31% | mock's 2 pre-filled demo invites (accepted divergence above) |
| Onboarding step 4 | dark | 2.29% | same |
