# Security fixes

Design choices made while fixing the September 2026 security/correctness review. One section per
workstream; keep to your section.

## runtime-security (packages/agent-runtime, apps/runner, apps/server/src/runtime, apps/server/src/github)

Area: the runner, the providers, the runner protocol and the GitHub webhook receiver.

### Provider environment is an allowlist, not a strip list

`support/env.ts` `providerEnv()` replaces `scrubEnv()`. A provider subprocess (and every shell command an
agent runs inside it) inherits only:

- system variables a CLI needs (`PATH`, `HOME`, `USER`, `SHELL`, locale, `TERM`, temp dirs, `XDG_*`,
  proxies, CA certs);
- the provider's own login variables (Claude: `ANTHROPIC_*`, `CLAUDE_CODE_*`, and Bedrock/Vertex creds only
  when Claude is configured for that cloud; Codex: `OPENAI_*`, `CODEX_*`, and the `env_key` of the model
  provider its `config.toml` selects); and
- the per-dispatch MCP token we set (`WHOMBAT_MCP_TOKEN`), plus anything the operator lists in
  `WHOMBAT_PROVIDER_ENV`.

`FORBIDDEN_ENV` (`RUNNER_*`, `WHOMBAT_*` except the MCP token, `GITHUB_*`, `GIT_*`, `SMTP_*`, `DATABASE_URL`,
`PG*`, `SSH_*`, `VAPID_/FCM_/APNS_`, `NODE_OPTIONS`) is never passed, even when a caller lists it. Chosen
over a longer strip list because a new secret named tomorrow is denied by default rather than leaked until
someone remembers to add it.

The runner (`apps/runner/src/config.ts`) loads only its own keys (`RUNNER_ENV_KEYS`) from the shared repo
`.env`, and `apps/runner/src/index.ts` deletes `RUNNER_TOKEN` from `process.env` once the API client holds
it, so even the runner's own children never see it.

Claude's `Read/Glob/Grep/LS` are confined to the workspace (`claudeToolPolicy`, `toolPaths`), so the agent
cannot read the runner host's `<repo>/.env` directly; `~`, absolute paths, `..` in glob patterns and
`.git` writes are all denied.

### The runner never trusts the worktree when it runs git

The worktree is the agent's cwd, so its `.git` file and any config/hook in it are attacker-controlled.
`WorkspaceManager` (`packages/agent-runtime/src/workspace/index.ts`):

- resolves each worktree's real admin dir from the mirror (`<mirror>/worktrees/<id>/gitdir`) and runs git
  with `GIT_DIR`/`GIT_WORK_TREE` set explicitly — never via the worktree's `.git` (which it also restores
  if the agent changed it);
- passes `-c core.hooksPath=/dev/null -c core.fsmonitor=false -c submodule.recurse=false
  -c credential.helper= -c protocol.ext.allow=never` on every call, and runs git with an allowlisted env,
  `GIT_CONFIG_NOSYSTEM=1` and `GIT_CONFIG_GLOBAL=/dev/null`;
- pushes (the only git call that carries the write token) from a fresh runner-owned bare repo under
  `<root>/.push/` whose objects are the mirror's (alternates), to an explicit URL — so the push token never
  meets any config, hook or remote the agent could have touched.

### Injective workspace path segments

`safeSegment` is one-to-one. Plain lowercase names keep a readable form (`feat/x` → `feat--x`); any name
that could collide with another (`--`, capitals, non-`[a-z0-9._-]`, or over 120 chars) becomes
`<readable>~<sha256 prefix>`. A reused worktree that is not on its target branch is switched back when
clean and refused when it has local changes. This prevents two branches (e.g. `feat/x` and `feat--x`, or
PR head refs differing only in case) from sharing a checkout and pushing under the wrong key.

### Runner protocol: leases are checked

`core` gains `Dispatch.attempts` and an optional `RunnerLease` (`runnerId`, `attempt`) on the progress,
complete and git-credentials bodies (additive; older runners omit it and keep working). The server treats a
runner that no longer holds the lease as stale: progress answers `{cancel:true}` and renews nothing;
complete and git-credentials answer 409 and change nothing. The lease sweep only finalizes a lease that is
still expired when it takes the row lock, so a heartbeat that renewed it in the meantime is not clobbered.
The runner sends its lease with every call and lets go quietly on 409.

### GitHub webhook deliveries recover from an interrupted handler

A `github_deliveries` row left `processing` for longer than `PROCESSING_TIMEOUT_MS` (5 min) is claimed
again by a redelivery (the process handling it died); a redelivery of one still in flight answers 409
`in_progress` (not 200 `duplicate`), so GitHub does not record it as delivered and will retry. A handler
that finishes after its claim was superseded no longer overwrites the newer claim's outcome
(`finish` is scoped to `receivedAt`).

### resume_run and start_run

`resume_run` refuses an agent unless the pause was the agent's own, so a person's Pause holds until a person
resumes. `start_run` no longer accepts `askedById` from the agent (removed from the MCP input; unknown keys
are stripped, so old agents are ignored, not errored) — the asker is taken from the dispatch (its trigger
message author, the controlled run's asker, or the search asker), and the command refuses a dispatch that is
not the acting agent's own.

### End-to-end test

`apps/server/src/runtime/secrets.int.test.ts` runs a real runner + server with a live `CodexProvider` on the
fake `codex app-server` (and a `ClaudeProvider` on the fake SDK), the runner's process env polluted with the
review's secrets. It asserts the provider's inherited env has none of them (nor the git push-token header,
nor the exact `ghs_` token the runner can mint), and that the agent's per-dispatch token gets 401 from
`git-credentials` while the runner token gets the token.
## approvals-integrity

| # | Decision | Reason |
|---|---|---|
| AI-01 | **Approval copy is written from the action.** `actionCopy(action, names?)` (core, `approvals/copy.ts`) gives the title (`cap(describeAction)`, "Create #ops and add Mara and Joris" for channels with members), question (`title?`), target (`staging · billing-api`, `account 3310 · €24,00`, `whombat/billing · PR #479`, …) and a "what actually runs" line with every fact the executor uses ("Build the latest commit on main in whombat/billing, then roll billing-api to production"; a named commit reads "Build 7be20f from v2.1.0 …"). `createApproval` stores that title / question / target for every non-`custom` action and makes the runs line WHAT HAPPENS 01; the requester's lines follow (an identical line is dropped), its summary follows the runs sentence, and its explainer is kept as written. `custom` actions keep the server-written copy of the command that asked; one an agent asks for with `request_approval` is titled from its name and gets WHAT HAPPENS 01 “{Name}, using “{key label}””. | The card, modal, mobile screen, inbox and decline reply all read the stored copy; it must not be the agent's own wording. For the mock's deploy the derived copy is the mock copy, so seed and visuals are unchanged. |
| AI-02 | `request_approval`'s `title`, `question` and `target` are now optional and not shown (contract descriptions say so); `whatHappens` are steps after 01, `summary` follows what runs on mobile. `perform_action`'s ask no longer passes its own title / WHAT HAPPENS. | Additive for callers: agents that still send them keep working. |
| AI-03 | Surfaces render the copy from the stored action too: `approvalView` returns `title`, `question`, `target` (from the action) and `actionNote` — "What actually runs: …." — only when the stored title / question / target disagree with the action (rows stored before AI-01). The web card shows the note in bad under the title, the modal as a `role="note"` sf2 box with a 3px bad rule above WHAT HAPPENS, mobile puts it before the message. The mock's request never shows it. | Defence in depth without changing the mocked layout. |
| AI-04 | A deploy's checks / review conditions must be about what it deploys: every PR they name (and `params.prNumber`) must be a PR of `params.repo` whose branch is `params.ref` (400 otherwise); a `checks_pass` condition on a deploy needs a PR. | Green checks on feat/x must not let `main` go to production. |
| AI-05 | Executions start from live state under the burrow lock: `StartExecution` re-reads checks and reviews in its transaction; if they no longer hold, it stores the fresh conditions and does not start. `RefreshConditions` is compare-and-set on the snapshot it was computed from (`previous`), so a stale hook loses to a newer one. | Re-evaluation hooks run after commit, outside the lock. |
| AI-06 | The commit that runs is pinned when execution starts: a deploy of the latest commit (`sha: null`) with a checks condition runs the head its checks passed on — the executor gets the approval with `params.sha` set, and the signed `approval.executing` event carries `payload.sha`; the stored action stays as approved. A deploy naming a commit other than the one the checks passed on fails ("Checks passed on cccc33, not on dddd44, the commit that was approved."). | The branch may move between green checks and the workflow dispatch. |
| AI-07 | The requester's key is decided again at start (`decide(requester, grants, approval.keyId, actionScope(action))`) for executor-run requests; `deny` fails the execution and signs a Blocked event as the requester ("Tried to deploy … Blocked."). Deferred commands already re-enter the pipeline's keys check. | Keys changed after "approve in advance" must still bind. |
| AI-08 | A failed execution is never re-run by re-evaluation (`readyToExecute` needs `idle`). A person retries with Undo then Approve, both signed. | Any later activity in the burrow re-evaluates every open approval. |
| AI-09 | Named approvers must be people of the burrow and involved ids principals of it (400). | Cross-burrow notifications and phishing. |
| AI-10 | An ask's card goes only into a conversation of the burrow the requester is a member of (403); `perform_action` checks membership on its direct path too. Without a named conversation it still goes to the first channel. | Agents could post cards and notify people in rooms they are not in. |
| AI-11 | `create_channel` with an agent among `memberIds` needs `agents.manage` (people only), like `add_members`; the `create_channel` action carries `memberIds` (additive) and its copy names the people added. | Agents never add agents. |
| AI-12 | An agent adding anyone or removing anyone but itself needs `agents.manage`, so it is blocked (and logged); agents can still leave. People keep their rules. | Agent tokens reach the REST membership routes. |
## auth-tokens

Auth, mail, realtime (`/ws`), collab connection lifecycle, push transports, search answers, read models and
mobile sign-out. Where a line here contradicts `server-core.md` ("Auth", "Realtime"), this section wins.

- **Mail logging.** Only `NODE_ENV=development` logs the whole email (the e2e suite and local sign-in read
  the code from the server log). Everywhere else the `email` log line has the recipient only: sign-in codes,
  magic links and invite tokens are credentials. The code stays in the subject (mail UX); it is the log that
  must not carry it.
- **Request log.** The Fastify `req` serializer redacts credential query values (`token`, `code`, `state`,
  `secret`, `key`, …) before a URL is logged (`lib/redact.ts`), so `/ws?token=ws_…` and the GitHub setup
  callback's OAuth `code`/`state` never reach the logs. A short-lived WS ticket instead of the bearer in the
  URL remains a possible follow-up; redaction fixes the leak at its root (the log).
- **API token management needs an interactive session.** `auth.listTokens`, `createToken` and `revokeToken`
  answer 403 to an API token (`wt_…`): a leaked short-lived token cannot mint a token that outlives it, nor
  see or revoke the account's other tokens. Web cookie and mobile `ws_…` sessions work as before.
- **Agent tokens work only at `/mcp`.** REST and `/ws` treat `wat_…` as no credential (401). This replaces
  "Burrow REST routes accept them too" (server-core.md) and follows A-07 (agents act only through MCP): MCP is
  where switched-off repos are hidden (`beforeTool`) and tool calls are rate-limited, and re-implementing both
  on every REST route would be a second, weaker enforcement point. Nothing in the product used agent tokens on
  REST. The 403 `BlockedBody` REST reply is tested with a person; the 202 reply shape through the reply
  mapper, since only agents meet an `ask`.
- **Credentials end their connections.** `/ws` and `/collab` connections remember the session, API token and
  dispatch they were opened with (`auth/credentials.ts`). Revoking an API token (DELETE or logout with it)
  sends the bus control `api_token.revoked` and closes them at once (4401 on `/ws`, 4403 on `/collab`, like
  logout). In addition, the hub's heartbeat (25 s) and a collab timer (`revalidateMs`, 25 s) re-check every
  live connection in one query per kind and close those whose session expired or was revoked, whose token was
  revoked or expired, or whose dispatch is no longer queued/claimed/running — that also covers revocations
  made by another process and every path that ends a dispatch, without hooking each one. Collab tokens carry
  the API token id (`t`, optional so tokens issued before the change still verify).
- **PR detail `staging`.** Returned only when `approvalVisible()` allows it (conversation members, approvers,
  requester, owners), else `null` — the same rule as `GET /approvals/:number`. The PR itself stays
  burrow-wide.
- **Search answers are scoped to the asker.** During an answer-mode dispatch the researcher's `search` tool
  intersects its visible conversations with the asker's memberships (`search(…, { within })`), and
  `read_conversation` / `canvas_read` refuse what the asker could not open. Enforced in the MCP adapter, not
  the prompt, so the agent never sees hits the asker could not open; receipts are still checked on delivery.
- **Outbound requests.** `lib/outbound.ts` is the single helper for user-supplied URLs: `https:` only, no
  URL credentials, private/loopback/link-local/CGNAT/multicast/reserved and NAT64/6to4 addresses refused
  (IP literals before connecting, host names in the socket's `lookup`, so the checked address is the dialled
  one), no redirects, 1 MiB / 10 s caps (web push: 64 KiB). `WHOMBAT_OUTBOUND_ALLOW_PRIVATE` lifts the address
  and scheme rules for tests and local mocks; config refuses it in production.
- **Web push endpoints** must be on a browser push service (`fcm.googleapis.com`, `android.googleapis.com`,
  `*.push.services.mozilla.com`, `*.push.apple.com`, `*.notify.windows.com`), checked at registration and on
  token rotation (400 `validation_failed` on `token`) and again at send time (a refused endpoint prunes the
  device). The contract is unchanged: the rule needs DNS and server config, so it lives on the server.
- **Mobile sign-out** runs the sign-out tasks (push unregistration), then `auth.logout` with the bearer token
  (revokes it server-side and closes its sockets), then forgets the token; each step is capped at 3 s so a
  dead server never blocks signing out (`endSession` in `apps/mobile/src/session/session.ts`).
## clients

Covers apps/mobile (deep links + approval screen), apps/web canvas collab presence, and packages/client
(mutations, query apply). Five findings, all confirmed real on inspection; none were dismissed.

### [high] Mobile: a crafted `whombat://` link could approve a request with no confirmation

`LINKING_SCREENS.Approval` mapped `approvals/:number`, and React Navigation's `getStateFromPath` merges
every query-string key into route params, so `whombat://approvals/12?decide=approve` arrived at
`ApprovalScreen` with `params.decide === 'approve'`. An effect there called
`decide.mutate({ number, decision: 'approve' })` as soon as the approval loaded, with no confirmation,
whenever the viewer still could. `whombat://` is a public, unauthenticated scheme (any web page, chat
message, QR code or other app can open it), and approval numbers are small sequential integers, so this
was a real one-tap-elsewhere approve of a stranger's "Deploy to staging" (or refund, etc.).

**Decision:** a link may only ever *open* the approval screen; approving always needs an explicit tap on
the screen's own Approve button, however the link arrived (external link, or a live notification's
Approve action). Two changes, deliberately redundant:

- `RootStackParamList['Approval']` no longer has a `decide` field at all — nothing in the app can read an
  auto-approve instruction from route params any more, because the field doesn't exist. This is the root
  fix; `ApprovalScreen.tsx`'s auto-decide `useEffect` was deleted outright rather than gated more tightly.
- `RootNavigator.tsx`'s `useLinking` wraps React Navigation's `getStateFromPath` with a new
  `stripLinkedActionParams` (`apps/mobile/src/navigation/routes.ts`, pure, unit-tested in
  `data.test.ts`) that deletes `decide` from every route's params (recursively, across nested
  navigator state) before the parsed link ever reaches a screen. This is defense in depth for whatever
  next screen or param shape shows up — it isn't keyed to `Approval` specifically — and matches the
  finding's "at minimum" suggestion ("strip it in `getStateFromPath`").

Rejected: routing the live notification's Approve action through a separate, unguessable channel (a
native module event, a one-time nonce) as the *primary* fix. That's the finding's first suggestion and
is a legitimate design for a true one-tap-approve-from-notification feature, but nothing in this codebase
currently wires such a feature up end to end (no native code sets `decide=approve`, no category/action
identifier handling exists in `push/taps.ts`) — building it would be scope well beyond closing this
finding, and `docs/decisions/mobile-live.md`'s ML-08 already describes the *screen-opens-then-approves*
design as settled for the notification path specifically. Since ML-08 as written ("the approval screen
approves once if the viewer still may") is no longer true post-fix, treat it as corrected by this entry:
the notification's Approve action (and the iOS widget's) still opens `whombat://approvals/N`, but the
person now always confirms with a tap on the screen, same as any other way of opening it. This section is
canonical for that behavior going forward.

Test: `apps/mobile/src/data/data.test.ts` — `stripLinkedActionParams` unit tests covering a top-level
`decide`, a nested one, siblings, a paramless route, and `undefined`. `apps/mobile` has no React Native
component test harness, so — consistent with the rest of the mobile test suite — this is tested at the
pure-function level; the type-level removal of `decide` from `RootStackParamList['Approval']` (checked by
`tsc`) is what actually prevents the deleted `useEffect` from coming back with the same bug.

### [medium] Canvas presence: a client could forge another peer's identity/color via unstamped `collabUser`

`apps/server/src/collab/awareness.ts`'s `stampState` only overwrote `state.user` and coerced
`state.writing`; every other field a client sent, including an unstamped `collabUser`, passed through to
every peer. `apps/web/.../canvas/collab/users.ts`'s `collaborators()` reads `state.collabUser ?? state.user`
and prefers the forged field, so any member (even on a read-only connection) could impersonate another
principal in the "N here" presence list and the "X is writing" tag, and inject CSS through `color`
(interpolated raw into `style: --writer: ${color}`).

**Decision:** fix at the root, server-side, since Hocuspocus's `beforeHandleAwareness` hook mutates the
state object in place before broadcasting — one allowlist there closes the hole for every peer and every
future awareness field, without needing a client-side redesign. `stampState` now deletes every key except
`user` (always stamped from the connection) and the two fields a client legitimately owns, `writing` and
`cursor`. Added defense in depth independent of the server fix: `@whombat/core`'s `CollabUser.color`
contract is tightened from `z.string().max(80)` to the two shapes the server and web client ever actually
produce (`#rrggbb` or `var(--…)`), so `collaborators()`'s `CollabUser.safeParse` rejects a forged color
even if some future path ever re-introduces an unstamped field.

Not done: a client-side WeakMap redesign of the legitimate `collabUser` swap in `editor/presence.ts` (kept
for y-prosemirror's hex-only cursor colors) — the finding's other "at minimum" option. Once the server
never relays a forged `collabUser`, the client-side value is always genuine (it's either the server-stamped
`user` or a locally-computed hex placeholder for the same identity), so the WeakMap redesign would be
extra churn on a mechanism that's no longer reachable by an attacker.

**Scope note:** fixing this required touching `apps/server/src/collab/awareness.ts` and
`apps/server/src/collab/*.test.ts`, outside this workstream's usual area, because the root cause is
server-side and no other workstream covers `apps/server/src/collab`. Called out here per the task's
"stay inside your area, with a documented exception" instruction.

Tests: `apps/server/src/collab/collab.test.ts` (unit, `stampState` strips a forged `collabUser` and an
arbitrary extra field), `apps/server/src/collab/collab.int.test.ts` (integration, two real clients over a
real Hocuspocus server — a forged `collabUser` never reaches the peer), `packages/core/src/contracts/collab.test.ts`
(the tightened `CollabUser.color` regex).

### [low] Optimistic rollback restores whole-cache snapshots, erasing realtime updates that arrived meanwhile

`useApprovalMutation` and `useReaction` snapshot several endpoints in `onMutate` and, on failure,
`restore()` writes every old value straight back with `setQueryData` — clobbering any realtime event
(`approval.updated`, `audit.appended`, `message.created`, …) that was applied to the cache while the
request was in flight. `rollback` then invalidated only `approvals.get`, so the stale values from the
other restored endpoints stuck around until a manual reload.

**Decision:** the minimal, uniform fix — invalidate every endpoint the snapshot touched, not just one —
rather than the heavier option (re-apply the previous entity through the version-guarded appliers in
`apply.ts`). A new `invalidateSnapshot(qc, snap)` in `packages/client/src/query/optimistic.ts` walks the
same snapshot `restore()` used and calls `qc.invalidateQueries` on each key; both `useReaction`'s
`onSuccess`/`onError` and `useApprovalMutation`'s `rollback` call it right after `restore()`. This is
simpler than threading the version-guard machinery through every restored endpoint, and it covers all
eight `APPROVAL_ENDPOINTS` (and the reaction snapshot's endpoints) uniformly without a special case per
endpoint. A subsequent refetch picks up whatever changed during the failed mutation.

Test: `packages/client/src/react/react.test.tsx` — a failed approval decide rolls back, then invalidates
every snapshotted endpoint (approvals, notifications inbox, audit), not just `approvals.get`.

### [low] Reacting cancels every in-flight `messages.list` fetch, including the reconnect-recovery refetch

`useReaction.onMutate` cancelled `messages.list` queries unscoped (`queryKeys.scope('messages.list')`),
so reacting in any conversation cancelled every conversation's in-flight list fetch, including the one
recovering messages missed during a socket outage. `cancelQueries` defaults to `{revert: true}`, which
leaves a cancelled query `fetchStatus: 'idle'` forever with no automatic retry (`refetchOnWindowFocus` is
off on web), so the missed messages never reappeared until the user navigated away and back.
`useSendMessage` had the same unscoped-cancel shape for its own conversation.

**Decision:** two changes together, matching both halves of the finding. `findMessageConversationId`
(new, `optimistic.ts`) resolves the reacted message's conversation from the cache so `useReaction`'s
cancel can be scoped to that conversation's `messages.list` (falling back to the unscoped key only when
the conversation truly isn't known yet — the pre-fix behavior, not a regression). Both `useSendMessage`
and `useReaction` gained an `onSettled` that invalidates the scoped list, so a cancelled fetch is always
recovered instead of relying on cancellation never mattering.

Test: `packages/client/src/react/react.test.tsx` — a reaction cancels only its own conversation's
`messages.list` (asserted via a `cancelQueries` spy on the exact `queryKey`) and that conversation ends up
invalidated afterward, while an unrelated conversation's list is left alone throughout.

### [low] `search.answer` events overwrite cached searches from another burrow with the same query text

The `search.answer` realtime handler in `packages/client/src/query/apply.ts` patched every cached
`search.query` entry matching the query text, with no `sameBurrow` check — unlike every other burrow-scoped
patch in the same file. The web query cache is shared across burrows, so asking the same question in two
burrows could write burrow B's answer (text and result-id citations) into burrow A's cached search.

**Decision:** add the missing `if (!sameBurrow(qc, key, answer.burrowId)) return d;` guard, matching the
existing pattern used by the other eleven burrow-scoped patches in the file. No design choice beyond that
— this was a straightforwardly missing guard, not a mechanism that needed rethinking.

Test: `packages/client/src/query/apply.test.ts` — a `search.answer` from another burrow does not overwrite
a cached search with the same query text.
## test-hardening

The server integration suite passed on CI but failed on a loaded machine, a different test each run.
Reproduced with `apps/server/scripts/stress-int.sh COPIES BURN` (parallel copies of the int suite, each
with its own throwaway databases and port-0 servers, while `BURN` busy loops load the CPU) and
`apps/server/scripts/stress-unit.sh` (the same for `pnpm test`). Logs land in `tmp/stress/<tag>/`.

| # | Decision |
|---|---|
| TH-01 | **Server errors are printed in test output.** The harness (`src/test/log.ts`) gives the services a logger that prints errors and warnings with their `cause` chain (Drizzle wraps the Postgres error as the cause of "Failed query"), and an `onError` hook prints every 5xx request. Before, `logger: false` hid them and a failure was a bare `500` or a missing event. |
| TH-02 | **Root cause of the reported failures (auth 500, realtime missing `conversation.updated`, runner claim `null`, search hit missing): the tests exhausted Postgres connections.** Each test file lazily opened up to 5 + 1 connections and vitest started all 23 files at once on a 64-core machine; under load queries piled up, pools grew, and Postgres (`max_connections` 100, shared with every other suite on the machine) answered `53300 too many clients` mid-test — in a route (500), in realtime fan-out (event dropped), in `buildDispatchContext` (claim failed, returned null), in a post-commit hook (search index not updated). Not a race in the server code. |
| TH-03 | **Test files are admitted, not failed, when connections are scarce** (`src/test/db.ts`): a file opens its whole pool (5 connections) up front — all or none, so waiting files cannot deadlock each other — retrying with jittered backoff on `53300`/`57P03` for up to 170 s (`hookTimeout` 180 s). After that the pool never connects again, so no query of the file can hit the limit. Admin work (create/drop database) uses short-lived connections. The pool is opened with one plain query per connection, not `sql.reserve()`: postgres.js 3.4 can hand a connection to an already-rejected reservation after a failed connect and leave the live one waiting forever. |
| TH-04 | **The int suite runs at most 8 files at once** (`maxWorkers: 8` in `vitest.int.config.ts`), so one run uses at most ~40 connections regardless of core count (idle duration 8 s → 13 s). |
| TH-05 | **Waits on explicit state, not wall-clock sleeps:** realtime `settle()` is a ping/pong round trip on each socket after `hub.flushed()` (the pong follows the flushed frames on the same connection) instead of a 30 ms sleep; the realtime-client test waits for the server's `sub` ack before publishing (it only waited for the socket to be open, so the first message could be published before the subscription existed); the runner tests assert `notBefore` against the time the turn failed and sweep until the dispatch reaches the expected state (the background sweeper can win the race against the test's own sweep); the runner unit tests wait for turns in flight / the provider running instead of sleeping 10–40 ms. Negative assertions ("no more log lines for 400 ms", "Banjo’s read-only edit never arrives") keep their short sleeps: under load they can only pass vacuously, never flake. |
| TH-06 | **Real bug fixed in the runner** (`apps/runner/src/turn.ts`): take over / pause end the dispatch on the server at once, which revokes the agent token; a tool call made before the next progress beat fails ("A live agent token is required.") and broke the turn, which the runner then reported as `failed` with an error (e2e "take over stops the agent" under load). A broken turn now asks the server with one progress beat before calling it a crash; a stopped dispatch reports `cancelled` with its reason. The server side already ignored the late `failed` (the dispatch was cancelled). Unit-tested in `turn.test.ts`. |
| TH-07 | **Web tests:** "sends with Enter; the mentioned agent thinks…" typed 30 characters one keystroke at a time (~2 s idle, over the 15 s timeout when loaded) and raced a 250 ms "thinking" window. The message is now pasted, and the simulated reply is held until the test has seen "Pippa is thinking" (`__holdFixtureRepliesForTests()` in `useRoom.ts`, test-only, reset by `__setFixtureReplyDelayForTests(null)`). The search skeleton test watches for the 60 ms loading state from the first render instead of after the search field appeared. |
| TH-08 | "Loaded run" for the finishing criterion: the suite under test with 64 busy loops on the 64-core machine plus 2 more copies of the int suite competing for Postgres. With 6 int-suite copies + 64 busy loops everything passes too; at 6 copies of the unit suites (~7× CPU oversubscription) single web tests can still exceed the 5 s `asyncUtilTimeout`, which is a budget, not a race. |
| TH-09 | **A test database is dropped even when `beforeAll` timed out** while it was still being created (`useTestDb`, collab and fixtures files wait for the pending creation in `afterAll`). The early stress runs had leaked 51 idle `whombat_test_*` databases; they were dropped (only ones with no connections, checked twice). |

Server and non-test files changed: `apps/runner/src/turn.ts` (TH-06), `apps/web/src/features/messaging/useRoom.ts`
(TH-07, test hook only), `apps/server/vitest.int.config.ts` (TH-03/04). No change to server runtime code: every
server-side failure traced back to TH-02.

Follow-ups (not fixed here, owned by other areas):

- `RunnerRuntime.sweep()` selects expired dispatches, then finalizes them one by one without re-checking the
  lease: two sweeps at once (two server processes, or the background sweeper and a manual sweep) can requeue a
  dispatch that a runner claimed in between.
- A realtime fan-out whose membership query fails drops the frame for every subscriber without a trace on the
  client (no seq is consumed, so no gap/resync). A transient DB error therefore loses live updates until the next
  refetch.
