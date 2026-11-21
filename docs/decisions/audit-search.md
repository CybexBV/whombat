# Workstream: audit-search (`apps/web/src/features/{audit,search}`)

TODO 13.1, 13.2, 13.3 (UI), 12.2 (UI), 12.3. Builds on `web-shell.md`, `tokens-primitives.md`,
`avatars.md`, `client.md`, `core-contracts.md` and `fixtures.md`. Most of the read-side logic (filters,
grouping, pills, expanded-row fields, CSV, citation segmentation, copy strings) already lives in
`@whombat/core` (`audit/log.ts`, `domain/search.ts`, `text/copy.ts`, `text/segments.ts`); this workstream
is mostly wiring plus presentation.

## Fixtures gap (FX-12): `audit.export`, `search.ask`/`getAnswer`/`postAnswer`

FX-12 (`docs/decisions/fixtures.md`) left these three endpoints out of `createFixtureFetch()`'s
`IMPLEMENTED` set on purpose, inviting whichever workstream needs one to add a case. The audit log's
"Export CSV" button and the search screen's answer flow both need them, so `packages/fixtures/src/fetch.ts`
gained:

- `audit.export` — reuses `filterAuditEvents()` (same filter parsing as `audit.list`) and `auditCsv()`
  from `@whombat/core/audit`, plus a small `auditPrincipalInfo()` adapter over the fixtures'
  `principal()`/`ROLE_LABELS`/`shortNameOf()` to build the `AuditDisplayContext`. Returns `text/csv`.
- `search.ask` — the scripted provider only answers the seeded VAT-rounding query
  (`SEARCH_QUERY` in `packages/fixtures/src/search.ts`) deterministically, per ARCHITECTURE's "Search"
  section. Any other query gets a synthesized `status: 'none'` answer (no card, no citations) — fixtures
  don't run a live researcher, so there's nothing else honest to return.
- `search.getAnswer` — looks the fixed `searchAnswer` up by id; anything else 404s.
- `search.postAnswer` — posts the answer's text to the given conversation via the existing
  `world.sendMessage()`, signed by Pippa (`searchAnswer.agentId`) rather than Mara.

Adding `audit.export` alongside `audit.get` exposed a latent bug in `findMatch()`: both endpoints match
`/burrows/:burrow/audit/export` (same segment count), and `matchPath()` has no way to prefer the literal
`export` segment over `:eventId`. Registration order in `auditEndpoints` (`list, get, export, verify`) made
`audit.get` win first, so `GET .../audit/export` would 404 as "No event export" instead of running the
export handler. Fixed `findMatch()` to prefer the match with fewer `:param` segments (a general fix, not
audit-specific — the same shape would bite any future literal route added after a param route of the same
length).

## Search answer actions: "Open PR #482"

The mock's search screen (`Whombat Desktop.dc.html`, `isSearch`) always renders a second button under the
answer, "Open PR #482" (`toBranch`), regardless of the query — it isn't derived from a citation or from
`SearchAnswer.actions` in the mock's own state at all, just a second hardcoded button next to
"Post to #incidents". The real contract renders actions from `SearchAnswer.actions: AnswerAction[]`
(`kind: 'post' | 'open'`), and the fixture's answer only had the one `post` action. Added a second
`{ kind: 'open', label: 'Open PR #482', link: { type: 'pr', number: 482 } }` entry so the screen (which
renders whatever `actions` contains, not a hardcoded pair) reproduces the mock's copy — `cnv_pr482` /
PR #482 already exists in the fixture world (`packages/fixtures/src/work.ts`, `conversations.ts`), it just
wasn't wired to this particular answer.

`packages/agent-runtime/src/scripted/storyline.ts`'s `STORYLINE.answerActions` is `searchAnswer.actions`
directly, so the scripted provider's `post_answer` call picks up the new action automatically; its test
(`packages/agent-runtime/src/scripted/scripted.test.ts`, "answers a search with the mock answer and its
three receipts") hardcoded the old single-action list and needed the same second entry added to keep
`pnpm check` green. Outside this workstream's two folders, but a direct, minimal, one-assertion fix for a
break this workstream's fixture change caused.

## Search answer text: inline citations

`packages/fixtures/src/search.ts`'s `searchAnswer.text` originally trailed all three citation markers at
the end (`"...still format first. [1][2][3]"`). The mock's own answer text interleaves them inline, one
per sentence they support, and adds two sentences (Dusty's reconciliation run, Hazel's PR #482 mention)
that the citation-trailing version dropped. Rewrote the fixture's `text` to match the mock's copy verbatim
(mocks win on copy) while keeping the same three `citations` entries — `segmentCitations()` in
`@whombat/core/text` already splits inline `[n]` markers out of running text, so no contract or component
change was needed, just the fixture data.

## Screens

- `AuditLogScreen` and `SearchScreen` keep the plain-props contract `router.tsx` already calls with
  (WS-01); both fetch their own data with `@whombat/client/react` hooks (`useBootstrap`, `useAuditLog`,
  `useAuditLogInfinite`, `useSearch`) rather than receiving it from `BurrowShell`, same as every other
  screen.
- Principal → avatar/display-name resolution reuses `Bootstrap.principals` (already fetched by
  `BurrowShell`'s own `useBootstrap` call; React Query dedupes the second call from the screen) to build
  an `AuditDisplayContext.principal()` and to pick `<WhombatAvatar role crop="head">` vs
  `<HumanAvatar initials tone>` per row.
- Both screens keep the shared `data-screen` convention their placeholders had (`ScreenPlaceholder`'s
  `screen` prop, asserted by `apps/web/src/app/router.test.tsx`'s `screenId()` helper): `AuditLogScreen`'s
  and `SearchScreen`'s root elements carry `data-screen="log"` / `data-screen="search"` directly, since
  they no longer render through `ScreenPlaceholder`. `SearchScreen` also gained a screen-reader-only
  `<h1>Search</h1>` (`.srOnly`, same clip-path recipe as `Modal`'s) purely so it has the same landmark
  structure as every other screen — the mock has no visible title here, the 19px query field carries
  that weight, so nothing visible changed.

## Audit log: `evt_9f18` default-open

The mock's seed state opens `e-9f18` by default (`logOpen: 'e-9f18'`) and its `toLog()` navigation resets
`logOpen` to `null` whenever it navigates to the log filtered by a specific agent. `router.tsx` stays a
thin pass-through (`open={search.open}`, per WS-01 — only it reads params/search, but it doesn't invent
values the URL doesn't have); the default itself lives in `AuditLogScreen` as local UI state:
`effectiveOpen = open ?? (!who && !defaultDismissed ? 'evt_9f18' : undefined)`. The first cut applied the
default in `router.tsx` instead (`open={search.open ?? (who === undefined ? 'evt_9f18' : undefined)}`),
which looked right but made the row impossible to close: closing it clears `open` from the URL, and with
`who` still unset the router's own fallback immediately reasserted `evt_9f18` on the next render — closing
and reopening are indistinguishable once the default lives in the URL layer, since both end up with no
`open` param. Moving the "has the user dismissed the implicit default" bit into a local
`defaultDismissed` boolean (set only when the currently-*implicit* default row is closed, never touching
the URL for that specific transition) fixes it, at the cost of one edge case that was left open here:
opening a different row and then closing it also drops back to no explicit `open`, which re-defaulted to
`evt_9f18` rather than staying closed, since `defaultDismissed` was never set on that path.

**Fixed in the `polish-ci` workstream** (see `docs/decisions/polish-ci.md`): `onToggle` now sets
`defaultDismissed` whenever *any* row is closed (the implicit default or one the user explicitly opened),
not only the exact-default-row-close case, so a close always sticks regardless of which row it was.

## CSV export toast: `"Exported N signed events as CSV."`

`N` is counted from the CSV response itself (`countCsvRows()`: header + one row per event, `\r\n`-joined,
same as `auditCsv()` writes) rather than from the currently-loaded page of events, so the toast is correct
even though the log view itself is paginated (`useAuditLogInfinite`) and the CSV always exports the whole
filtered set in one shot.

## Search answer: pending state and cache merge

Fixtures answer `search.ask` synchronously over HTTP (no simulated `search.answer` realtime push, FX-12
above); `SearchScreen` still renders a "thinking…" pending card (`AnswerCard` with `status: 'pending'`)
while the mutation is in flight, using `askMutation.isPending`, so the same code works against a real
server where the researcher genuinely takes time. On success the answer is merged straight into the
`search.query` cache entry for the exact `{q, type}` it was asked for
(`queryClient.setQueryData(queryKey, (prev) => prev ? {...prev, answer: result.data.answer} : prev)`)
rather than re-fetching, since a real server's `search.query` might not yet reflect an answer that was
`post_answer`-dispatched moments ago. The pending card's avatar/name use the burrow's `researcher`-role
agent (Pippa in the fixtures), found generically via `principals.find(p => p.kind === 'agent' && p.role
=== 'researcher')` rather than hardcoding Pippa's id, so a burrow with a different researcher still shows
a sensible pending state.

## Esc target and full-route stories

- Esc in the search field blurs it and navigates to `/${burrow}`, which the router already redirects to
  the burrow's first channel (`burrowIndexRoute`) — matching README's "Esc closes search" without the
  search screen needing to know or remember where the user came from itself (WS-05 already covers the
  route-modal → pane → search ordering; this is the last step, "back to the page search was opened from,
  else the burrow home").
- Full-route Storybook stories (`AuditLog`, `AuditLogFilteredByAgent`, `AuditLogBlocked`, `Search`,
  `SearchThreads`) were added to the existing `apps/web/src/stories/Shell.stories.tsx` (reusing its
  `ShellDemo({url})` harness) rather than new per-feature story files, matching the established "App/Shell"
  convention for whole-screen stories (`ThreadPane`, `AgentProfile`, `ApprovalModal`, `SignIn` already live
  there). Presentational sub-components (`AuditRow`, `AnswerCard`, `SearchResultRow`) still get their own
  feature-folder stories per the task's contract-driven-component requirement.

## Known, deliberate visual differences

- **Row count / vertical offset**: the fixture world's audit log has more events (~24, across the whole
  seeded history) than the mock's frozen `LOG` array (~14); both open the same `evt_9f18`/`e-9f18` row
  with matching fields, but the page is taller. Not fixed — the fixture world is shared across
  workstreams and out of scope here; `visual/audit.spec.ts` documents it and keeps the mismatch threshold
  loose enough to still catch real regressions.
- **Search author name**: `SearchResultRow` shows the author's full `name` ("Tom Beck"), not
  `shortNameOf()` ("Tom") — confirmed against the mock's own `r.a.name` binding, which is the full name
  for search results (unlike the audit log, which uses short names throughout). This was a real
  visual-parity bug in an earlier draft, fixed by reading the reference screenshot pixel-for-pixel rather
  than just the mock's script logic.
- **Mock query text vs. the fixture's matching string**: the mock's seed state (`query:
  'have we seen this invoice rounding error before?'`) is cosmetic flavor text with no behavioral meaning
  in the reference; the fixture world's `search.ask`/`search.query` only answer deterministically for the
  exact string `SEARCH_QUERY = 'rounding order VAT invoices'` (`packages/fixtures/src/search.ts`). The
  visual spec and stories use the fixture's matching string, not the mock's cosmetic one, so the answer
  card actually renders; this is a pre-existing, documented (FX-12) gap between the mock's seed and the
  fixture world's scripted-answer trigger, not something this workstream introduced or can close.
- Avatar anti-aliasing (`AV-02`) and Lucide icons vs. the mock's glyph placeholders (`C-07`) apply here
  as everywhere else in the app.

## Real-server verification

Ran against a real server (throwaway Postgres DB, `pnpm db:reset && pnpm db:seed`, `WHOMBAT_AGENTS=scripted`),
authenticated as the seeded owner (`mara@burrowhq.example`) via the magic-link flow, and exercised the endpoints
directly:

- `GET /audit` and `GET /audit?actor=agents&kind=blocked` return the same shape as fixture mode, correctly
  filtered against real Postgres-backed data.
- `GET /audit/export` returns a real `text/csv` attachment (`Content-Disposition: attachment;
  filename="burrow-hq-audit-<date>.csv"`) with a header row plus one row per matching event — confirms
  `countCsvRows()`'s "header + one row per event" assumption for the export toast count against real data,
  not just the fixture's `auditCsv()`.
- `GET /search?q=rounding order VAT invoices` returns the same cited `THREAD`/`PATCH`/... results shape as
  fixtures.
- `POST /search/answers` (the real path — `search.ask`'s contract path is `/search/answers`, not literally
  `/search/ask`; the fixture's internal case name doesn't match the URL) returns a synchronous `status:
  'pending'` answer immediately, confirming the design in "Search answer: pending state and cache merge"
  above: fixtures answer synchronously (a stub with no real researcher), but the real server always starts
  pending and fills in the answer asynchronously via a `search.answer` realtime event once the agent
  runner (separate `apps/runner` infrastructure, outside this workstream) processes it. `SearchScreen`'s
  pending `AnswerCard` while `askMutation.isPending` is exactly the state a real burrow sits in immediately
  after asking, not just a fixture artifact.
