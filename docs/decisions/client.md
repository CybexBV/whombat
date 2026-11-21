# Workstream: client (`@whombat/client`)

Decisions made while building the shared client. ARCHITECTURE.md, DECISIONS.md and
`docs/decisions/core-contracts.md` still apply. Usage is documented in `packages/client/README.md`.

## Package shape

- Five entry points: `@whombat/client` (HTTP + realtime, needs only `fetch` / `WebSocket`),
  `/query` (TanStack Query, `@tanstack/query-core` only), `/react` (React DOM and React Native),
  `/web` (the only DOM code: socket URL from `window.location`, online / visibility reconnects),
  `/realtime` (just `createRealtime`, no `fetch`/DOM lib types at all — for consumers, such as
  `apps/server`'s realtime-align integration test, that want the reconnecting socket client without
  pulling in the HTTP client's `RequestCredentials`/DOM types). TanStack Query and React are optional
  peer dependencies.
- The client is generated from `api` at runtime: `client.<area>.<action>(input)` exists for every
  endpoint and its types come from the Zod schemas. Adding an endpoint in core needs no client change.
- `@whombat/client/react` has a read hook only for an endpoint an app reads (`useRun`, `useSpendOverview`, …);
  `queryHook(api.<area>.<action>)` makes one for any other. There is no registry of every endpoint's hook: one kept
  23 hooks no app used alive, and nothing checked it was complete (2026-11-12).

## HTTP

- Call shape is `{ params, query, body, signal, headers }` rather than a flat object, so path params,
  query and body can never collide. Parts are optional exactly when the schema accepts `{}`.
- **GET resolves to data; every other method resolves to a `CommitResult`** (`ok` with `data` and
  `httpStatus`, `pending_approval`, `blocked`), mirroring the MCP `commitOutcome()` union. The keys
  engine can answer any mutation that way (core-contracts), so all mutations return the union, even
  ones that in practice never ask (sign-in, mark read). `unwrap()` converts to throwing
  (`ApprovalRequiredError`, `BlockedError`) for callers that prefer exceptions.
- A 202 is only an approval when the body has `approvalRequired: true` (`search.ask` succeeds with 202);
  a 403 is only "blocked" with `blocked: true` (other 403s are `ApiError`s with their code).
- Inputs are always validated (cheap, and catches bugs before a round trip). Responses are validated
  when `validateResponses` is on: default on unless `NODE_ENV=production` or RN `__DEV__ === false`;
  the web app passes `import.meta.env.DEV`. Drift throws `ContractError` instead of rendering garbage.
- Auth: `credentials: 'include'` by default (web cookie, works through the Vite proxy and cross-origin
  dev); `getToken()` adds `Authorization: Bearer` (mobile). `onUnauthorized` fires on every 401.

## Realtime

- **`seq` is per connection (C-09), one counter across every topic** (documented on the frame in
  core: 1, 2, 3… after `hello`). The client keeps a single counter, not one per topic: a frame at or
  below the last value seen is a duplicate or replay and is dropped outright; a frame that jumps ahead
  means something was lost somewhere in the stream, so the resync signal names every topic the client
  currently holds (the counter spans all of them — there is no way to tell from the gap alone which
  topic's frames went missing). `realtime.lastSeq()` takes no topic argument any more; it is the
  connection's last seen value.
- Sequence tracking restarts on `hello`, not just on socket-open (the server's own counter starts
  counting from there): a reconnect always reports `resync` with every held topic, sent after the
  server acks the resubscription (`sub` with an `id`), or after 3 s without an ack.
- Gap resyncs are reported after the gapped event is delivered, so the invalidation is the last word.
- Frames for topics the client no longer holds (an `unsub` in flight) still advance the connection's
  counter — they occupy a slot in the stream — but are not handed to listeners.
- A `sub` or `unsub` frame that carries an `id` is acked by the server (contract `ack`); the client
  attaches one to every `subscribe()` call and to the resubscribe it sends on reconnect (gating the
  resync signal), and reports acks that come back `ok: false` through `onError({kind:'ack'})`. Plain
  `unsub` on release and the very first catch-up `sub` sent right after `hello` (topics queued before
  `connect()`) go out without an `id` — nothing is waiting on their ack.
- Backoff: `min(30 s, 0.5 s · 2^attempt)` with "equal jitter" (half fixed, half random), reset on
  `hello`. Heartbeat: ping every `hello.heartbeatMs` (25 s before hello); two silent intervals drop the
  socket. An `unauthorized` error frame calls `onUnauthorized`, closes with 4401 and reconnects with
  a freshly read token.
- Typing sends are throttled to one per 3 s per conversation/thread (half the 6 s TTL).
- Events for topics the client no longer holds (unsub in flight) are ignored.

## Query cache

- Keys: `['whombat', endpointId, params, query]`, params/query normalised through the endpoint schemas.
  Infinite variants append `'infinite'` and omit the cursor. Local state: `['whombat', 'typing',
  {conversationId}]` (entries with a local `expiresAt`), `['whombat', 'presence']` (never GC'd).
- Reducers patch every cached response an event touches, matching on entity ids inside the data
  rather than on keys (numbers such as run #1907 are burrow-scoped; ids are global). Inserts into
  lists check the list's burrow (slug → id via cached bootstrap / burrow / memberships; unknown counts
  as a match because the socket is per burrow) and the list's filters.
- **Ordering**: entity events are versioned by the frame's `at` per entity (`message:<id>`,
  `run:<id>`, `unread:<conversationId>`, …); an older frame than the last applied one is ignored.
  Append events (audit, inbox, principals) apply once by id; run log lines merge by `seq`. Deleted
  messages are tombstoned. Result: applying events in order, twice, or reversed ends in the same
  cache (the reducer tests assert exactly that for every event type).
- A message is inserted into a paged list only inside the loaded window (not older than the oldest
  loaded message while more history exists); older messages arrive with the page that holds them.
- Thread reply counts on the root are not incremented locally: the server's `message.updated` for the
  root is the authority (incrementing would double count under reordering).
- `message.created` from a principal clears their typing indicator and versions it, so a late typing
  frame cannot bring "is thinking" back after the reply landed.
- `principal.created` for an agent appends a roster row with an empty keys summary and invalidates
  `agents.list` (only the server computes the summary). New branch rooms trigger a bootstrap refetch
  (their PR status comes from the server); new channels / DMs are added to the sidebar directly.
- `pr.updated` recomputes `status` with `prStatus()` and `mergeBlock()` for a person viewer (web and
  mobile clients are always people).
- Resync invalidation per topic kind: `conv:` → that conversation's messages and header, threads,
  typing; `run:` → run page and log; `canvas:` → canvases; `me:` → inbox, bootstrap (badges), search;
  `burrow:` → every endpoint query.

## Optimistic mutations

- Sending: the optimistic message has id `msg_local-<clientId>` and the `clientId` it is sent with;
  the server copy (from the response or the realtime echo, whichever is first) replaces it by
  `clientId`. Failures, `blocked` and `pending_approval` remove it.
- Reactions and approval decisions snapshot the affected queries and restore them on failure or a
  non-ok outcome, then invalidate. A decided approval flips `state`, `decidedById/At` and the
  `person_approves` condition's `met`; undo returns to pending.
- `useMarkRead` clears the badge at once and applies the server's counts.

## Changes to other packages

- `packages/core/src/contracts/realtime.ts`: doc comment on the event frame's `seq` (per-topic,
  contiguous). No schema change.
- `apps/web/src/features/home/HomePage.tsx`: uses `client.health.get()` and `queryKeys.health.get()`
  from `@whombat/client/query` (the old hand-written `health()` caller is replaced by the generated ones).
