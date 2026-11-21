# Workstream: server-core (`apps/server`)

TODO 3.1 (schema), 3.3 (auth + membership), 3.4 (signing), 3.5 (keys engine), 3.6 (realtime) and the
server side of 13.1–13.3 (audit log). ARCHITECTURE.md, DECISIONS.md and `core-contracts.md` still apply;
this file records what they left open.

## Layout

```
apps/server/src/
  app.ts, index.ts, services.ts   Fastify app; service container (db, custody, bus, typing, mail, pipeline, approvals)
  db/schema/*                     Drizzle schema (tenancy, principals, conversations, work, events, code, content)
  db/migrations/                  0000_init (generated), 0001_events_append_only (trigger), 0002_principal_position
  keys/custody.ts                 Ed25519 keypairs, secret keys AES-256-GCM under WHOMBAT_MASTER_KEY
  audit/                          appendSignedEvent (+ burrow lock), rowToSignedEvent, verifyBurrowChain
  commit/                         the pipeline: types, Pipeline.commit / transact / transactAccount, outbox
  commands/                       one CommandDef per action ({name, schema, requiredKey, apply})
  domain/                         helpers used inside commits: messages, members, dispatch, notify, search-index
  approvals/                      createApproval / ask approvals, ApprovalEngine (conditions, execution)
  auth/                           magic link + code, sessions, API tokens, agent tokens, request auth
  read/                           read models (views, work-views, audit, search, messages, principals)
  routes/                         REST adapter over ALL_ENDPOINTS (+ 501 stubs for later phases)
  realtime/                       bus (outbox fan-out), hub (subscriptions, seq, typing, presence), /ws route
  seed/                           SeedWorld schema, loader, built-in test world, fixtures seam
  scripts/                        migrate, reset, seed, audit-verify
```

## Database

- Every entity from ARCHITECTURE's domain model has a table. Plans keep `steps` as jsonb; runs have
  `run_steps`, `run_log`, `run_files`; PRs have `pr_checks`, `pr_reviewers`, `pr_files`, `pr_commits`;
  messages store the `StoredCard` as jsonb; canvases carry `markdown` plus `ydoc` (bytea) and
  `ydoc_updated_at` for the collaboration phase.
- `events` is append-only: a row trigger raises on UPDATE/DELETE and a statement trigger on TRUNCATE
  (`insufficient_privilege`). Optional envelope fields are NULL columns and are omitted when the envelope is
  rebuilt for verification. `created_at` is normalised to `toISOString()` before signing so the
  timestamptz round trip reproduces the signed string.
- `messages.ord` (identity) is insertion order: the tie-break for equal timestamps, the read-marker position
  and the paging cursor.
- `grants.key_id` is text, not an enum, so a key from a newer build never breaks reads. Unknown ids are
  skipped by `loadGrants` (the contract's `Grant.keyId` is an enum, so they cannot be sent to clients).
- Agents keep the channels they "work in" (`principals.channel_ids`, AG0 `chans`) separately from
  conversation membership: in the mock they differ (Sketch works in #general without being a member).
  Hiring and Configure keep both in step from then on.
- `principals.position` keeps roster order (seed order, then hire order).
- `search_documents.tsv` is a generated `to_tsvector('english', where || ' ' || text)` column with a GIN index.
- `outbox` (bigserial) holds every realtime frame a commit produces.

## Key custody

- One Ed25519 keypair per principal, created with the principal. Secret keys are stored as
  `v1:base64(iv[12] | tag[16] | ciphertext)`, AES-256-GCM under `WHOMBAT_MASTER_KEY`, with the principal id
  as additional authenticated data (a ciphertext copied to another row does not decrypt).
- Without `WHOMBAT_MASTER_KEY` outside production the server uses a public development key
  (sha256 of `whombat/dev-master-key/v1`) and logs a warning; production refuses to start without one
  (config). Documented in `.env.example`.
- Seeded principals use `deriveSeedKeypair(id, keySeed)`, so fingerprints are stable (Banjo `3bc7 859b`).

## Commit pipeline

- `Pipeline.commit(command, input, {burrowId, actorId})` validates the input, then runs one transaction that
  takes `pg_advisory_xact_lock(0x57484d42, hashtext(burrowId))` first. Keys decision, domain change, event
  appends (seq + prevHash + insert) and outbox rows are all serialized per burrow; Postgres releases the lock
  on commit, rollback or disconnect. Different burrows never wait on each other.
- Keys outcomes: `deny` commits only the signed Blocked event (403 `BlockedBody`); `ask` commits an
  Approval, the requester's approval card message and the signed Asks event (202 `ApprovalRequiredBody`);
  `allow` runs `apply`. People act under role rules (only `burrow.manage` needs owner).
- Generic asks (any command whose key is `ask`): the approval action comes from the command
  (`create_channel`, `merge_pr`, …) or is `custom {name, keyId, data}`; the command and its input are stored
  on the approval (`approvals.command`) and the approvals engine re-runs them as the requester once approved
  and every condition is met. The `approvalId` that lets that run skip the ask is verified (same burrow,
  approved, executing, same requester and command). Default approvers: the people in the approval's
  conversation, else the owners. The card goes to the command's conversation, else #general.
- An agent's events record the key its decision used as KEY USED unless the command sets one. Keys events
  (grant changes) carry no KEY USED.
- Post-commit hooks run in order after the commit, before the HTTP response; a failing hook is logged and
  does not fail the request: dispatch creation, unread badges, search index, notifications, approval
  re-evaluation.
- Signed: every action in a burrow. Not signed: per-viewer private state (read markers), account state
  (preferences, sessions, login codes, API tokens, devices, live activities) and derived projections
  (`search_documents`, notifications, approval condition refreshes, outbox). Account writes go through
  `pipeline.transactAccount` (transaction + outbox + hooks, no burrow, no events).
- Hidden internal events (`text: null`): `message.posted`, `message.reacted`, `dispatch.created`,
  `dm.opened`, `approval.executing`, `canvas.commented`, `canvas.resolved`, `plan.updated`, `search.asked`,
  `onboarding.completed`. Plain chat messages therefore never appear in the log; the mock's Messages rows
  are semantic summaries ("Answered Priya with 3 receipts") written by the actions that produce them.

## Event texts (new copy, following the mock's voice)

| type | text |
|---|---|
| `approval.approved` / `declined` | "Approved Dusty’s staging deploy of feat/invoice-pdf" (mock e-9f40); other actions "Approved Clover’s request to refund €24,00 on account 3310"; custom "…’s request: {title}" |
| `approval.undone` | "Undid approving Dusty’s staging deploy of feat/invoice-pdf" |
| `approval.executed` / `failed` | signed by the requester: "Deployed feat/invoice-pdf to staging"; "Couldn’t deploy feat/invoice-pdf to production: {error}" |
| `agent.hired` | `describeHire` ("Hired Sketch, an architect, with 3 keys") |
| `agent.updated` | "Renamed Nugget to Pebble", "Changed Banjo’s job", "Moved Banjo to codex (gpt-5)" |
| `agent.channel_added` / `removed` | "Added Moth to #incidents" / "Took Moth out of #general" |
| `keys.*` | `describeGrantChange`; a removed scoped key keeps its label ("Took Moth’s “Read #general” key away") |
| `channel.created`, `conversation.updated` | "Created #design", "Changed the topic of #billing-v2" |
| `member.added` / `removed` / `joined` / `invited` | "Added Tom to #general", "Left #incidents", "Mara Okafor joined Burrow HQ", "Invited joris@burrowhq.example" |
| `burrow.created` / `renamed` / `updated`, `repo.*` | "Created Burrow HQ", "Renamed the burrow to X", "Switched on whombat/web" |
| `pr.merged`, `pr.approved`, `pr.changes_requested` | "Merged PR #482 into main", "Approved PR #482", "Requested 2 changes on PR #482" |
| `checks.completed` | "Checks passed on 7be20f. 41 of 41 passed." (hidden while checks still run) |
| `run.paused` / `resumed` / `taken_over` | "Paused Banjo’s run #1907", "Took over Banjo’s run #1907 on feat/invoice-pdf" |
| `canvas.created` | "Wrote the canvas “Invoice PDF export · plan”" (mock e-9e51) |

Declining posts a thread reply under the approval card from the person who declined:
"@Dusty, I declined “Deploy feat/invoice-pdf to production”. {note} Heads up, @Banjo and @Hazel." Its
mentions wake the requester and the involved agents with trigger `approval_declined`.

## Conversations and messages

- Channels are membership-gated for reading, posting and subscribing (people join through
  `addMembers`; adding an agent needs `agents.manage`, so agents never add agents). Branch rooms and DMs
  are too. The new `conversations.removeMember` is "leave" (self) or "take out".
- Unread = top-level messages by others after the viewer's read marker (`ord`); thread replies do not count.
  New members start with everything read. `markRead` only moves forward. No marker = everything unread.
- Mentions resolve with core's `resolveMentions` against the burrow's principals, excluding the author.
  `clientId` makes sends idempotent per (conversation, author).
- Thread roots keep `replyCount`, `lastReplyAt` and the last three distinct repliers (most recent last).
- DMs: slug `{agent}--{person}`, topic `dmTopic(agent channels)`; created on first `openDm`.

## Dispatch queue

- Queued in a post-commit hook (its own commit; `dispatch.created` signed by whoever caused it, hidden):
  agents mentioned by anyone other than themselves, every message the person writes in an agent DM,
  declined approvals, search questions (mode `answer`, reported in the asker's DM with the researcher) and
  run resumes (`run_control`, mode `run`).
- At most one queued dispatch per (agent, conversation, mode): later mentions coalesce into it (the runner
  reads the latest window on claim). A mention during a running turn queues one follow-up.
- Each new dispatch starts a 6 s "{name} is thinking" indicator; the runner's progress heartbeat will keep
  it alive (runner phase); the agent's reply clears it.

## Approvals engine

- Conditions are evaluated from the PR the approval is about: checks aggregated over `pr_checks` (tests
  summed when checks report them, else checks counted), the reviewer's state from `pr_reviewers`, and
  `fixing` = a live run on the branch. Re-evaluated after decisions, reviews, checks and merges.
- Approved + every condition met → executed automatically (approve in advance). Transitions are signed by
  the requester. Every action type has a simulated executor (succeeds at once, no result URL) until the
  GitHub / deploy phase registers real ones (`ApprovalEngine.setExecutor`).
- Plan steps that reference an approval follow it: "Needs a person" while pending (clients show "Needs
  you" through `approvalView`), "Approved", "Deployed" / "Declined" / "Failed".

## Auth (TODO 3.3)

- One email carries the magic link (`{PUBLIC_URL}/login/verify?token=`) and a 6-digit code. Both are stored
  hashed; the code is bound to its login-code row, lives 15 minutes, locks after 5 wrong tries, and only the
  latest unused code per email counts. At most 5 emails per address per hour (429), which bounds guessing
  at 25 codes an hour. `redirectTo` keeps only same-app paths (`//host` and `/\host` are dropped).
- Accounts are created on the first successful verify (no enumeration: requesting always succeeds).
- Web: `whombat_session` cookie, httpOnly, SameSite=Lax, Secure in production, 30 days. Mobile
  (`client: 'mobile'`): the session secret is returned as the bearer token (`ws_…`, 180 days). API tokens
  are `wt_…`. Logout revokes the session (or the API token used) and closes that session's sockets.
- Agent tokens (`wat_…`) are per dispatch, 30 minutes, valid only while the dispatch is queued, claimed or
  running (`issueDispatchToken` / `verifyAgentToken` for the runner and MCP phase). Burrow REST routes accept
  them too (same keys engine and signing); account routes do not.
- Burrow routes resolve `:burrow` to the caller's principal: 401 without auth, 404 for an unknown burrow,
  403 for non-members. Invites email `{PUBLIC_URL}/login?invite={token}&email=…`; the invite is accepted
  during verify when the account email matches (joins #general, signs `member.joined`).
- Email: always logged (dev transport); also sent to `SMTP_URL` (Mailpit) when reachable, never blocking.

## REST

- Routes are generated from `ALL_ENDPOINTS`; every endpoint has a definition. Later phases answer
  501 `not_implemented` (new error code) with the reason: `uploads.create`, `canvases.collabToken`,
  `devices.vapidKey` and the five `runner.*` endpoints.
- Outside production each response is validated against the contract (500 on drift); the endpoint smoke
  test calls every implemented endpoint.
- Errors: validation 400 (`fields`), not allowed to decide 403 `not_allowed`, state conflicts 409,
  "Merge into main" disabled 409 with `details.mergeBlock`. Empty JSON bodies count as no body.
- Cursors: messages `base64url("{iso}|{ord}")`, audit log `seq`, approvals `number`.
- Visibility: conversation-gated — messages, threads, runs (and the agent's own), plans, canvases with a
  conversation, approvals (conversation members, approvers, requester). Burrow-wide — the audit log ("Every
  action in {burrow}", so a "where" can name a channel the viewer is not in), PR metadata, agents, principals.
- Bootstrap: sidebar = the viewer's conversations (open PRs first), `needsYou` = pending approvals the
  viewer may decide, realtime path `/ws?burrow={slug}` with `burrow:` and `me:` topics.
- Hire: channels default to #general, runtime `scripted`, "Just hired. Reading the burrow to get up to
  speed." Onboarding: `burrows.create` is step 1 (owner person + #general); `complete` creates the picked
  roles with `ROLE_DEFAULT_KEYS` in #general and sends invites. Repos arrive with the GitHub phase (the seed
  provides them). `audit.verify` is for owners.
- Search: a natural question matches any of its terms, ranked by `ts_rank` (the mock's "have we seen this
  invoice rounding error before?" must find "Invoicing rules v3"); quoted, negated or `or` queries keep
  `websearch_to_tsquery` semantics. THREAD/MESSAGE "where" reads "#incidents · 3 Mar 2026" /
  "#billing-v2 · today 11:20". Agents holding "Search messages, canvases and runs" also see channels and
  branch rooms they are not in, never another person's DM. `answer` is the viewer's latest answer for the
  query (null until the researcher runtime writes it); cited results sort first.

## Realtime (TODO 3.6)

- `/ws?burrow={slug}`; the web session cookie (Origin must be the request host or `PUBLIC_URL`), mobile
  `?token={bearer}`, or an agent token. The upgrade is refused before a socket exists (401 / 403 / 404).
- `seq` is per connection (1, 2, 3… after `hello`; the core comment is updated): a gap means lost frames,
  refetch. Clients reset on `hello` (realtime-align: `@whombat/client`'s `createRealtime` tracks one
  counter for the whole connection, not one per topic — see `docs/decisions/client.md` — matching this
  server-side counter one for one; `rt.lastSeq()` returns it). `eventId` is the signed event behind the
  frame.
- Each connection's frames are handled one at a time, so a `sub` is authorized before a later `unsub` runs.
  Frames fan out in publish order. Every `sub` and `unsub` frame that carries an `id` gets an `ack`
  (`{op:'ack', id, ok, error?}`); `ok` is `false` when a `sub`'s topics include a denied one (the
  `forbidden_topic` error frame still lists which). Frames with no `id` (most `unsub`s) are not acked.
- Burrow-topic frames about one conversation (`conversation.updated`, `approval.updated`, `plan.updated`,
  `run.updated`, `pr.updated`) reach only its members. Leaving drops the conversation's subscriptions
  (`conv:`, its runs and canvases) immediately. `reactions[].mine` is recomputed per recipient.
- Typing: `{op:'typing'}` → `typing` with `mode: typing` (people) or `thinking` (agents), 6 s TTL,
  `active: false` when it lapses or stops. Presence: `{op:'presence'}` → `presence` on `burrow:`; offline
  when the principal's last socket closes. Server pings every 25 s; a socket silent for 3 × 25 s is dropped.
- Outbox rows are written in the commit's transaction, published after commit, then marked published. On
  startup leftover rows are marked published (no socket outlives the process) and day-old rows deleted.

## Seed

- `pnpm db:seed [--relative]` loads a `SeedWorld` (Zod schema in `apps/server/src/seed/world.ts`) in one
  pipeline transaction and verifies the chain. It uses `@whombat/fixtures`' `seedWorld()` (or `SEED_WORLD`)
  when exported, else the built-in test world (`seed/test-world.ts`). It refuses to overwrite a burrow.
- Shape (all core schemas; `burrowId` optional everywhere): `now`, `keySeed` (default `whombat-demo`),
  `burrow` (+ `onboardingCompletedAt`), `people` (Person; `publicKey`/`fingerprint`/`accountId` optional —
  when given they must match the derived key; one account per email), `agents` (Agent + `grants:
  GrantInput[]`), `conversations` (Conversation with ordered `memberIds`, optional `position`),
  `readMarkers` (`{conversationId, principalId, lastReadMessageId | null}`; members without one start fully
  read, `null` = nothing read), `repos`, `pullRequests` (PullRequest, `repoFullName` optional), `plans`,
  `runs` (Run + `log: {at, text}[]`, `logCount` optional), `approvals`, `messages` (`{id, conversationId,
  authorId, createdAt, text, card?: StoredCard, threadRootId?, mentions?, reactions?: {value,
  principalIds}[]}` — reply counts and participants are computed), `canvases` (Canvas + `markdown` +
  `comments`), `notifications`, `searchDocuments` (`{id, type, conversationId | null, where, authorId,
  text, link, createdAt}` — search-only history such as the March thread, PR #311, Run #1882,
  "Invoicing rules v3"), `searchAnswers` (+ `askedById`), `invites`, `events` (the mock LOG: EventEnvelope
  minus `v`/`seq`/`prevHash`/`burrowId`, signed by `actorId` at `createdAt`).
- The loader adds hidden `burrow.created` and one `message.posted` per message, then appends all events in
  time order, so seq follows the clock. Events keep the fixture ids (`evt_9f31` → `e-9f31`); internal
  ones get deterministic ids.
- Mapping notes for the fixtures: the approval's `eventId` must be the Asks event's id (`evt_9f18`);
  `decided` goes on imported history only (e-9d77); an agent's profile RECENT is its last three events with
  text, so AG0 `recent` rows need matching events (they then show in the log too).
- `--relative` shifts every ISO instant by (now − `now`) and calendar dates (plan `due`) by whole days.

## Contract changes in `@whombat/core` (additive)

1. `EVENT_TYPES`: `burrow.updated`, `onboarding.completed`, `member.added`, `member.removed`,
   `member.invite_revoked`, `channel.created`, `conversation.updated`, `dm.opened`, `search.asked` (System);
   `agent.channel_added`, `agent.channel_removed` (Keys); `approval.executing` (Asks); `canvas.resolved`
   (Messages).
2. `ErrorCode` `not_implemented` → 501.
3. `api.conversations.removeMember` (`DELETE /burrows/:burrow/conversations/:conversationId/members/:principalId`).
4. `ServerMessage` event `seq` documented as per connection.
5. `describeHire` uses "an" before vowels ("an architect", "an operator").

## Follow-ups

- Runner endpoints, the MCP server (the commands `request_approval`, `review_pr`, `record_checks` are
  already there), `/collab` tokens, uploads, VAPID / push delivery.
- GitHub adapter (FakeGitHub) to populate repos and PRs and feed `record_checks` / reviews; a real deploy
  executor through `ApprovalEngine.setExecutor`.
- Browsing channels one is not in (the list endpoint returns member conversations only).
- Presence snapshot in bootstrap; session `last_used_at` tracking; MCP rate limits (REFERENCE_NOTES §5).
