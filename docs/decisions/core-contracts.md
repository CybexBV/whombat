# Workstream: core-contracts (`@whombat/core`)

Decisions made while building the shared contract package. ARCHITECTURE.md and DECISIONS.md still
apply; this file records what they left open.

## Layout

```
packages/core/src/
  ids.ts          id prefixes, id schemas, newId(), event refs (evt_9f31 ⇄ e-9f31)
  domain/         Zod schema + inferred type for every entity (same name for both)
  keys/           KEY_CATALOG, decide(), clamping, role defaults, hire keys, key rows, grant diffs
  approvals/      condition evaluation, transitions, approvalView() display state machine
  audit/          RFC 8785 canonical JSON, sha256, Ed25519, hash chain, log filters/fields/CSV, event drafts
  text/           mention segments, slugs, time/date, stat formatting, shared screen copy
  contracts/      endpoint helper, `api` (REST), realtime frames/events, runner protocol, MCP tools
```

- Subpath exports: `@whombat/core/{domain,contracts,keys,approvals,audit,text,ids}`; the root re-exports
  everything (a test checks this). Everything is pure: `@noble/*` for crypto, `Intl` only for time zones.
- A schema and its type share a name (`export const Run = z.object(…); export type Run = z.infer<…>`).

## REST contract conventions

- `api.<area>.<action>` is plain data: `{id, method, path, base, auth, params, query, body, response,
  status, contentType}`. Paths use `:param` and are relative to `base` (`/api/v1`, or `/internal/runner`
  for `runnerApi`). `ALL_ENDPOINTS` is what the server registers; `endpointUrl()` builds client URLs.
  Tests assert unique ids/routes, that path params match the params schema, and that every screen's
  endpoints exist (`SCREENS` in `contracts.test.ts` is the screen → endpoint map).
- Burrow data lives under `/burrows/:burrow/…` (`:burrow` = slug). Account data (`/auth`, `/me`,
  `/devices`, `/push`) does not. Static segments win over params (`/burrows/slug-check`,
  `/audit/export`, `/audit/verify`); those words are reserved slugs.
- Responses are the resource itself (no `{data}` envelope). Response fields are `nullable` (always
  present); request fields are `optional`. Timestamps are ISO 8601 strings (`z.iso.datetime({offset:true})`),
  calendar dates `YYYY-MM-DD`. Lists page backwards with an opaque `before` cursor + `hasMore`.
- Errors: `ApiErrorBody {error:{code,message,fields?,details?}}`. The keys engine adds two outcomes to
  any mutation: **403 `BlockedBody`** (`cannot`, a signed Blocked event exists) and **202
  `ApprovalRequiredBody`** (`ask`, an Approval was created). MCP tools return the same three outcomes as
  `commitOutcome()` unions (`ok` / `pending_approval` / `blocked`).
- Conversation resolution: channels by name (`GET /channels/:channel`), DMs per viewer via
  `POST /dms {agent}` (get or create), branch rooms via `GET /prs/:number` (its `pr.conversationId`),
  everything else by id. `?repo=` disambiguates PR numbers when several repos are on.
- The shell loads with one `GET /burrows/:burrow/bootstrap`: burrow, me, all principals, sidebar
  (channels with unread + mention counts, branch rooms with PR status and dot tone, DMs, nav counts),
  preferences, server time and the realtime topics to subscribe to.

## Domain modelling choices

- **Ids**: `<prefix>_<body>`; generated bodies are nanoid(12), except audit events which use 12 lowercase
  hex chars. The log shows `e-<body>` (`formatEventRef`), so the seed's `evt_9f31` renders `e-9f31`.
- **Cards**: on the wire a message carries a resolved `MessageCard` (plan, run and approval cards embed
  the live object so realtime events can patch them); storage uses `StoredCard` (references). Agents
  post cards with `PostableCard` (run/approval cards only come from `start_run` / `request_approval`).
- **Receipts**: ARCHITECTURE lists `Message.receipts`; they live on the `answer` card
  (`{kind:'answer', receipts, query}`; `query` adds "Open in search"). Receipts carry a `LinkRef`.
- **Deep links**: one `LinkRef` union (channel, dm, pr, message, run, approval, agent, canvas, log,
  search, external) used by receipts, conversation actions, audit refs, notifications and search results;
  `linkPath(burrowSlug, link)` maps it to the web routes in ARCHITECTURE (approval = `?approval=N` over a
  conversation).
- **Reactions** are free text values (`finally`, `+1`) with `count`, `mine` and `principalIds`.
- **Runs** have `progress` (0–100), `activity` (latest line → "Now: …") and `summary` (shown when done);
  the log is separate (`run.log` events, `GET …/runs/:n/log?after=`).
- **Devices belong to accounts**, not principals: one phone gets pushes from every burrow.
- **Plan steps** link to the run / approval they follow (`runId`, `approvalId`); gate labels come from
  `approvalView().planStep`.
- **PR status label** is derived, not stored: `prStatus(pr)` → `PR_STATUS_LABELS` ("Open · changes
  requested" → "Open · ready" → "Merged") and `PR_STATUS_TONES` (sidebar dot); `mergeBlock()` says why
  Merge into main is disabled.
- **Burrow host** is `{slug}.whombat.com` (D-07); `slugify` keeps the mock's rule and also folds accents
  and caps at 63 chars. `Burrow.timeZone` is the fallback zone for day grouping.

## Keys

- **One catalog entry per mock wording**, each with a stable id and the verbatim label (a test lists every
  key string in AG0, HIRE_KEYS, LOG and the run page). Different wordings of one permission are linked:
  `sameAs` ("Read all connected repos" = "Read connected repos", "Change code" = "Write code",
  "Write to feat/* branches" = "Read and write feat/* branches"), `parent` for umbrellas ("Deploy" →
  staging/production, "Merge" → "Merge into main", "Write code" → branch keys), `implies` for bundles
  ("Run tests and CI" → "Run tests" + "Run CI"). `KEY_IDS` order is the display order.
- **decide()**: people-only keys (`agentMaxTier: 'never'`: Merge into main, Approve requests, Hire agents,
  Invite people, Change burrow settings) deny agents outright. Otherwise walk the key's umbrella chain; the
  first level with an in-scope grant decides (explicit beats bundle-derived; strictest wins within a level);
  no grant → deny `no_key`. `can` is clamped to `ask` for deploy keys (`always_asks`).
- **Scopes fail closed**: a grant restricted to channels/branches/repos/environments only matches requests
  that name a value inside it. "Read and write feat/* branches" carries an inherent `feat/*` scope;
  `branchWriteKey()` picks main → Merge into main, `feat/*` → feature key, anything else → shared branches.
- `channels.read` scoped to channels renders "Read #billing-v2 and #general" (the hire modal's first key).
- **People** act under role rules: every key allowed, except `burrow.manage` which needs `owner`.
- **Approvers**: people on the person condition's `approverIds` plus burrow owners; agents never decide.
- Hiring: toggled keys at `can`; locked rows are added at their cap (Deploy → ask, Merge into main →
  cannot), matching the mock's hired agent. Role defaults (`ROLE_DEFAULT_KEYS`) are AG0.
- Keys events text: "Gave Banjo a new key: Run tests", "Moved Dusty’s “Deploy to production” key to ask
  first", "Let Banjo use “…” without asking", "Took Banjo’s “…” key away", "Hired Nugget, a developer,
  with 3 keys". `audit/drafts.ts` builds Blocked / Asks / Keys event fields from a decision.
- **Pluralisation deviation**: the roster footer says "1 channel" / "1 key"; the mock template printed
  "1 channels" for Hazel. Same for hire/export texts.

## Approvals

- Conditions carry structured live data (`checks_pass`: head sha, state, passed/total, fixing;
  `review_approved`: reviewer + review state/time; `person_approves`: approver ids) plus a stored desktop
  `label` and `met`. Notes ("38 of 41 · fixing", "approved 11:38", "you or Joris", "Mara · just now") are
  computed by `approvalView()` because they depend on the viewer and the clock.
- Execution is a sub-object (`idle | running | succeeded | failed`, duration, result URL, error);
  `executedAt` is set on success. **Undo** is allowed while decided and not executed/executing, by the
  decider or an owner (B-02). A failed execution shows DEPLOY FAILED and can be retried or undone.
- Display phases for every surface (card, modal, branch pane, plan step, log pill/DECIDED, mobile inbox and
  approval screen): NEEDS A PERSON → APPROVED · WAITING FOR CHECKS (or … FOR REVIEW when only the review
  is left) → APPROVED · DEPLOYING → DEPLOYED, or DECLINED. The desktop mock jumps straight to DEPLOYED; we
  show APPROVED · DEPLOYING on desktop too while the executor runs. Deploy copy is verbatim; other action
  types follow the same sentences with their own verbs.
- Approval text that only the requester knows (title, question, target, WHAT HAPPENS, explainer and the
  mobile `summary`) is stored on the approval (written by `request_approval`).

## Audit and signing

- Envelope v1: `{v, id, burrowId, seq, prevHash, actorId, type, kind, text, where, keyUsed?, keyNote?,
  onBehalfOf?, onBehalfOfId?, aboutId?, decided?, approvalId?, ref?, payload, createdAt}`. Optional fields
  are omitted when absent. `keyUsed` freezes `{id, label}` so the log shows what was signed.
- `hash = sha256(RFC 8785 canonical JSON of exactly the envelope keys)`, lowercase hex;
  `sig = Ed25519(hash bytes)`, hex; the signer's public key is stored with the event. Chain starts at
  `seq 1` with `prevHash = 64 zeros`. `verifyChain()` reports hash, signature, signer, seq-gap, link and
  burrow failures; it verifies windows from a trusted head.
- Decisions on Asks events are joined at read time (`AuditEvent.approval` for `approval.requested`);
  `decided` in the envelope is only for history imported with its decision (the seed's refund e-9d77).
- Seed keys: `sk = sha256("whombat/seed-key/v1\0" + seed + "\0" + principalId)`, default seed
  `whombat-demo`; the seeded fingerprints are pinned in tests (Banjo `3bc7 859b`, Mara `3e47 96d7`, …).
- Fingerprints: first 8 hex of sha256(public key bytes), shown `xxxx xxxx`.
- Log filters use lowercase URL values (`actor=everyone|people|agents`, `kind=all|code|asks|keys|messages|
  blocked`, `who=<handle>`); counts are over the actor/who base, as in the mock. CSV columns are
  `AUDIT_CSV_COLUMNS`, formula-guarded.

## Realtime

- Frames are discriminated by `op`. Server event frames are `{op:'event', topic, event, seq, eventId, at}`
  (ARCHITECTURE's `{topic, event}` plus a per-connection sequence for gap detection — see
  `server-core.md` — and the signed event id).
- Topics: `burrow:`, `conv:`, `run:`, `me:` and `canvas:`. `REALTIME_EVENT_TOPICS` says which topics
  carry each event. Added to the ARCHITECTURE list: `message.deleted`, `plan.updated`, `grants.updated`,
  `principal.created`, `conversation.unread` (viewer badge, `me:`), `search.answer` (`me:`),
  `canvas.updated`, `canvas.comment`, `burrow.updated`.
- Typing carries `mode: thinking | typing` ("{name} is thinking" for agents) and expires after
  `TYPING_TTL_MS` (6 s) unless refreshed. Mobile authenticates the socket with `?token=<bearer>`.

## Runner and MCP

- Runner: `claim` (long poll, returns `DispatchContext`), `progress` (heartbeat that answers
  `cancel` + reason `paused | taken_over | cancelled`), `complete`, runner `heartbeat`, and
  `git-credentials` (push requires the branch key; 403 Blocked otherwise).
- The per-dispatch agent token (ARCHITECTURE's `Dispatch.sessionToken`) is not part of the `Dispatch`
  schema; it only travels in `DispatchContext.agentToken`. Answer-mode dispatches carry
  `search: {query, answerId, results}`.
- MCP tools: the ARCHITECTURE list plus `open_pull_request`, `review_pull_request`,
  `merge_pull_request` (always Blocked for agents), `perform_action` (keyed actions that allow, ask or
  block) and `post_answer` (delivers the search-screen answer with `[n]` citations).
  `requiredKey` is fixed, `null` (membership/ownership checks) or computed by `mcpRequiredKey()`.
  `inputJsonSchema()` / `outputJsonSchema()` give the advertised JSON Schemas; outputs are unions, so an
  MCP server that needs an object `outputSchema` should advertise none and return `structuredContent`.

## Text

- All time formatting takes an explicit IANA zone and uses built-in English names:
  `formatClock` 11:22, `formatDayDivider` "Today · Wednesday 23 September", `formatLogDay`
  "TODAY · 23 SEP" / "YESTERDAY · 22 SEP" / "MON · 21 SEP", `formatRecent` "just now" / 09:13 /
  "Yesterday" / "Mon" (within 6 days) / "3 Mar", `formatDuration` "2m 14s" / "14m 08s".
- Diff stats use U+2212 (`formatDeletions`), euros are Dutch (`€24,00`, `€ 1.234,56` with `space`).
- Answers mark citations inline as `[n]` (`segmentCitations`); review comments mark code with backticks
  (`segmentInlineCode`). Mention segmentation is byte-for-byte the mock's `segs`.
- `text/copy.ts` holds every interpolated screen string web and mobile share (card labels, run kicker,
  DM topic/intro, composer placeholders, roster/log subtitles, toasts, onboarding labels, canvas
  provenance). Static copy stays in components; seed copy (OB steps, Clover tips) belongs to fixtures.
