# Stack optimization — 2026-10-29

John requested a whole-codebase optimization review and implementation by subagents. The review covered server
reads and background work, web/mobile data handling, shared contracts and algorithms, runner and command I/O,
the network proxy, Python integration, supporting apps, and build/release tooling. The changes remove measured
repeated work while keeping the existing product, wire contracts, permissions and visual design.

## Decisions

| # | Decision | Reason |
|---|---|---|
| OPT-01 | **Thread pages use the existing reply index.** With `limit`, read a `(created_at, ord)` range backwards through `messages_thread_idx`, fetching at most `limit + 1` replies and returning the page oldest first. Resolve a valid cursor within its thread; read its timestamp as PostgreSQL text to retain microseconds. A missing, root or foreign cursor starts at the newest page. Without `limit`, return every reply. Core's `pageThreadReplies` remains the pure fixture reference. | Loading every reply id makes page cost grow with the whole thread, even when only 50 replies are requested. |
| OPT-02 | **Resolve connection approval details once per page.** Approval lists and inboxes pass all selected approval rows to the existing batched detail resolver. Visibility and decider checks still apply per approval. | The resolver already supports batches; invoking it for each row repeats three queries per connection approval. |
| OPT-03 | **Index client queries by endpoint.** One lazily initialized index per TanStack `QueryCache`, held through a `WeakMap`, follows query additions and removals, including clear and garbage collection. Lookups return snapshot arrays and use TanStack's partial matching for parameters. | Realtime events patch several endpoints; repeatedly scanning unrelated queries makes event handling grow with every screen visited. The index adds one cache listener and releases removed query references. |
| OPT-04 | **Encode and decode command/git frames in linear time.** Encoders allocate the final output once. Both decoders accumulate the fixed header, check the 256 KiB limit, allocate one payload, and fill it as fragments arrive. Output owns its bytes. | Concatenating the complete buffered prefix for each fragment repeatedly copies the same payload and creates allocation pressure. |
| OPT-05 | **Consume buffered runtime events by position.** The async queue clears consumed references, advances its head and occasionally compacts, preserving FIFO, close and failure behavior. A buffered `undefined` is an item. | Removing the first array element on each read repeatedly shifts a large burst. Consumption is amortized constant time. |
| OPT-06 | **Reuse cron work within one catch-up call.** Parse the expression once, retain at most three days' computed instants in the call, and binary-search the first instant strictly after the cursor. Daylight-saving policies, the five-year search horizon and the 10,000-fire guard remain. | Recomputing a day's complete schedule for every missed fire multiplies timezone conversions. The bounded cache expires with the call and cannot reuse another schedule's settings. |
| OPT-07 | **Group a read's ordered children once by parent.** Message reactions, run steps/files and pull-request checks/reviewers/files/commits use request-local maps; plan references index their work numbers. Database ordering, repeated input parents, empty children and viewer-relative reaction state remain. | Filtering the entire child list for every parent multiplies hydration work. No state survives the read, so updates need no cache invalidation. |
| OPT-08 | **Read desk pairing and discovery identities in one statement.** Choose each burrow's person with the domain's claimer/fallback rules, then require their account, agent and default Chat. Preserve the preferred/oldest burrow and optional account filter. | Hydrating the same person and place repeatedly cost seven queries for discovery and eight for account-filtered pairing on one ordinary burrow. A different historical person's Chat cannot substitute for the selected person's missing Chat. |
| OPT-09 | **Retain untouched thread-list pages and response wrappers.** Edits copy the affected pages; new threads and newer replies change the front page and, when needed, the page the thread left. Preserve page parameters, duplicates, settled/subject filters and reply ordering. | Cloning every page makes the query cache compare and allocate unchanged history for each event. |
| OPT-10 | **Mirror terminal CSS only when its styles change.** Observe inert style additions, edits and removals; adopt simultaneous additions in DOM order, skip unchanged text and release detached styles on removal/disposal. | Ordinary terminal output changed DOM cells but caused a full terminal scan and every stylesheet to be reparsed. The document proxy and constructable stylesheets keep the hosted CSP intact. |
| OPT-11 | **Accumulate incomplete browser/CDP frames with geometric growth.** Read complete chunks directly, copy incomplete bytes into owned storage, compact only after consuming half the storage, and release it when drained. Retained raw frames and payloads own their bytes. | Repeatedly concatenating the entire prefix makes fragmented network input quadratic. Existing frame decoders, limits, command decisions and output ordering still apply. |
| OPT-12 | **Cache parsed CIDRs, never network verdicts.** A bounded 1,024-entry cache holds immutable string-to-range results, including invalid entries; each destination is parsed once per decision and checked against the current lists and openings. | Parsing unchanged ranges dominates checks against larger production lists. Policies, host addresses, denials and approved openings must take effect immediately, including in-place list changes. |
| OPT-13 | **Join console output once per report item.** Collect contiguous chunks of the same console and their byte count, then concatenate once at the report boundary. Keep offset gaps, control events and the existing per-item/report limits. | Repeated concatenation recopied an item's entire prefix for each small PTY output fragment. A batch retains its bytes only until it is built. |
| OPT-14 | **Reuse Markdown lookahead within one parse.** Match link/image label brackets once per inline input, compile a closing fence once, skip a blank run in a list in one pass, and count excess URL parentheses once. Keep newline boundaries, nesting, escaping, safe-target checks and the rendered tree. | Bracket-heavy text, large blank runs and trailing URL punctuation repeatedly rescanned their suffixes; code fences rebuilt the same expression for each line. This changes parsing cost, not Markdown syntax. |
| OPT-15 | **Hydrate automation runs as a page.** Single-run and page reads share `toRuns`: request-local grouped steps, names, coding-run links, approvals and billed-token totals. Preserve input order and duplicates, per-run rounding, unknown versus zero usage and step associations. Read a published automation version once for its definition and publisher. | The ordinary 30-run fixture took 150 hydration queries; batching takes five. Existing read grouping and billing helpers supply the mechanics. |
| OPT-16 | **A resource transfer releases its cancellation state when it ends.** Downloads remove abort listeners on completion, refusal, reset, loss and cancellation; cancelling before metadata rejects the opening promise. Cancelled bulk-slot waiters leave promptly, and a caller can stop waiting without cancelling the session's shared dial. | Thirty completed downloads retained thirty listeners. An aborted metadata wait never settled and could leave a cached picture load pending. |
| OPT-17 | **Share the activity credential policy in pure core.** `redactActivitySecrets` serves runner provider activity and server MCP activity; their original export names remain aliases. Keep caller-specific path handling, whitespace and bounds, and keep the skill-scan redactor's different policy separate. | Both twelve-rule implementations were identical. One implementation and shared policy tests prevent security rules from drifting. |
| OPT-18 | **Bound live arrivals while a session replays.** Apply the existing 1,000-event cap before buffering, release the buffer and stop replay on overflow, and recheck closure after asynchronous enrichment. | A stalled replay accepted 1,001 live events without overflow. A closed replay must also stop fetching full pages and must not send the result of an enrichment that was already waiting. |
| OPT-19 | **The built page preloads its own root.** `apps/web/boot-preload.ts` adds `modulepreload` for the chunks `src/main.tsx` imports for the target (BoxRoot and boxEnv on the box, ManagedRoot and connect hosted) and their static imports, and `preload as=style` for their CSS; Vite still inserts the stylesheets, so the cascade is unchanged. Fixture builds get none, and the build stops when those chunks are missing. | The root was fetched only after the page's 2.16 MB of scripts had run: one more round of downloads before the page could talk to its box. |
| OPT-20 | **Components read the bootstrap part they need.** `useBootstrapSelect(burrow, select)` (TanStack's structural sharing keeps an equal part the same object) serves `useTheAgent`, message cards and pull-request links; Chat keeps one subject chip per message, the room's name lookup follows the principals, the sidebar's model is memoized by value, and typing is checked against the clock while rendering. | Every unread, presence or typing frame redrew every Chat row and the sidebar: 470 renders per typing frame and 1,452 per unread event with 200 messages. |
| OPT-21 | **Open and resync ask each read once, in order.** A resync invalidates each query once; warming a room connects realtime before subscribing, so the room's topic is on the wire before its history; the shell's warm reads don't retry, as the shell's own reads don't; `useHostsStatus` has a module of its own (`@whombat/client/hosts/status`) so the shell doesn't pull every server page into the first chunk. | A resync fetched the open conversation twice; history could be read before the live topic, missing a message posted between; the hook's module brought 125 kB raw into the page's first scripts. |
| OPT-22 | **Production builds carry no fixtures.** `/use-as-screen` loads through fixture mode's door and draws nothing in production; a production build stops when any chunk holds a `packages/fixtures/` module. `@whombat/brand` is free of side effects. | The fixture screen page shipped `@whombat/fixtures` (23.6 kB br) though only fixture worlds use it; the admin panel bundled every brand mark (−49 kB br once marked). |
| OPT-23 | **Home and the desk read once per request.** The glance and Settings → Screen read each widget's newest point (`homeWidgetsNow`, one lateral read); Home's widgets read their points in one statement. `homeOverview` and the glance pass one request-scoped read set to every section and registry source (`homeReads`, `SourceCtx.reads`: the person, quiet rows, fleet, device skills, live researches); nothing is kept between requests. | A paired desk rebuilt its glance every 10 s with 52 statements, reading every widget's full day of points to show one value; the overview took 53, re-reading the same quiet rows five times. |
| OPT-24 | **Home's unanswered questions use the thread index.** One statement with two branches: a threaded room checks the question's thread by its root, a task chat keeps the conversation-wide check over its own messages. | The combined condition defeated `messages_thread_idx` and scanned the person's messages on every overview, Needs you and glance. |
| OPT-25 | **The health pass reads shared rows once and tells Home only of real changes.** Quiet rows and states are read at the start of a pass (an Ignore that lands mid-pass applies from the next one, as on servers) and the person once per burrow; each connection still checks, commits and fails on its own. A glance's shown parts are compared with every object's keys in order. | 12 statements per connection per pass; and the stored glance comes back from jsonb in jsonb's key order, so every connection published `home.changed` on every five-minute pass and every open app refetched Home. |
| OPT-26 | **A tool call checks its one tool.** `servesTool` is the per-tool form of the served-list rules (`servedToolNames` is built from it); a call runs it lazily, loading only the selection parts that tool's rule reads. Each request reads its dispatch, agent and person once and the connections once. Per request only, so the served set stays current. | Every `tools/call` rebuilt the whole served list (29 statements, the dispatch read 5×) to check one name: 46 statements for a cheap call, 10–50 calls per turn. |
| OPT-27 | **The GitHub poller repeats nothing within a cycle.** The connected burrows and an issue watch's automations are read once per cycle; a poll saves its cursor only when its ETags, error, issue watch or refresh changed, and `polledAt` at most once a minute. | The same burrow-wide reads ran per repository and per tick, and an unchanged cursor was written on every poll. |
| OPT-28 | **A message's commit reuses the rows it read.** A reply reuses its thread root, and the dispatch queue gets the room it was posted in, inside the same burrow-locked transaction. Notification and search reads after the commit stay fresh. | A reply loaded its root up to 6× and its room 3–5×. |
| OPT-29 | **The direct listener closes a page file when the browser leaves** (`stream.pipeline`). | Each abandoned download kept a file descriptor until restart. |
| OPT-30 | **Command launchers start without Node's proxy stack.** The Hermes terminal's launcher environment and the helper wrappers (`gh`, `git-remote-whombat`, `whombat`, `whombat-connect`) drop `NODE_USE_ENV_PROXY`; the agent's own commands keep it. | With proxy variables set, Node loads http, tls, http2 and undici at start: about 16 ms on every command, which these unix-socket scripts never use. |
| OPT-31 | **A turn waits at most a second for its production servers' names.** Names are looked up together (at most two lookups at once runner-wide, on libuv's shared pool); the wall starts with the server's addresses and what answered, and a later answer only adds addresses (`AgentNet.closeProduction`). An address known only from a slow fresh lookup is outside the wall until that lookup returns; the guard still matches servers by name, and the server resolves the same names for the dispatch. | One unresolvable `.local` name delayed every turn's start by 5 s, two bare names by 8–10 s. |
| OPT-32 | **Git's error output is redacted as a stream, and memory writes create a fresh temporary file.** The relay holds back only a chunk's tail that could start the token or its Basic form and flushes it at the end; the memory writer's temporary file has a random name and is created exclusively. | A token split across two stderr reads passed unredacted; a predictable temporary name in a folder the agent writes could be planted as a symlink. |
| OPT-33 | **Logic with one meaning has one implementation.** Web and phone share the automation asker, notification words, the Vault form's rules, schedules' and the tracker reports' words and the managed app's session hooks through `@whombat/client`; the phone's Settled list uses `useChatThreads`. The server has one Vault-use signer (`signVaultUse`), one per-burrow signer helper (`burrowSystemPrincipal`), one quiet-exceptions helper (`addQuietExceptions`) and one `connector_app:<provider>` label, backups included. Core has one strict UTF-8 decoder (`@whombat/core/text/utf8`, protocol's throwing form and the skill files' rules as wrappers, one malformed-input corpus for all), protocol one compact EdDSA token verifier and signer (`jws.ts`), and the command helpers one frame codec and line request (`frames.mjs`, `line-client.mjs`, shipped beside them). Copies that differ on purpose stay apart (signs-in wording, run-step words, chart ticks). | Identical copies drift: the web and phone wording had already, the app-secret label lived in four places, and security checks (UTF-8, token verification, frames) were maintained twice. |
| OPT-34 | **Local test runs keep their transforms and start the slowest files first; CI does neither.** Every Vitest config wraps itself in `withModuleCache` (`scripts/vitest-project.ts`): `fsModuleCache` when `CI !== 'true'`, with one cache-key generator per run that adds every workspace package's resolution fields (`exports`, `imports`, `main`, `module`, `browser`, `type`, not versions), each tsconfig and the files a config loads itself (`apps/mobile/svg-markup.cjs`). The root config's sequencer (`scripts/vitest-sequencer.ts`, local only) starts files without a time first, then last run's failures, then the slowest. The cache is not pruned; a changed installed lockfile or `vitest --clearCache` empties it. | Transforms were 71% of a run and redone every time; Vitest ran the web project's slow files last. Vitest's own key missed where an import resolves and files a config reads, both reproduced as stale passes. CI's guests start empty, so a cache there is pure cost and a gate must not depend on an earlier run. |
| OPT-35 | **Tests wait on what they test, not on fixed intervals.** The install/repoint and Bluetooth polls are settable for tests (20 ms in the web setup); the key-store race starts once every worker says it is ready; the commands sandbox test's background job no longer holds the command's output open; the sandbox probe's network wait is injectable (500 ms in tests); sandbox tests stop their slices and probe scopes after every describe. Flakes fixed: the fake package and unRAID tasks are held until checked, the admin toast's timer is cleared on unmount, the Home Assistant test reads at midday. The box build's precompression gets 16 libuv threads (`UV_THREADPOOL_SIZE`), its output byte-identical. | One case waited out 30 s, others 2 s polls and 1.5 s sleeps; leaked test units piled up in the user manager (hundreds of slices, two scopes running for days); precompression ran four files at a time. |

Reproduction, raw paired samples, validation and deferred findings for OPT-15…OPT-18 are in
[`docs/implementation/repository-optimization/report.md`](../implementation/repository-optimization/report.md).
Those for OPT-19 onwards are in
[`docs/implementation/repository-optimization-2/report.md`](../implementation/repository-optimization-2/report.md).

## Measurements

Baseline: `1994d34ec`; Node 24.18.0 on The Titan. Timings below are isolated SQL or algorithm microbenchmarks,
not end-to-end page, turn or application latency. Operation counts describe the tested workloads.

| Workload | Baseline | Optimized |
|---|---|---|
| Paging SQL: newest 50 replies from 100,000 replies, 1,000-character bodies, 15 warm runs (mean) | 43.19 ms; 100,050 rows transferred | 0.216 ms; 51 rows transferred |
| Approval list, four connection approvals | 13 queries | 4 queries |
| Inbox, four connection approvals | 14 queries | 5 queries |
| 10,000 endpoint lookups, 2,000 cached entries across 100 endpoints | 454.46 ms; 10,000 whole-cache scans | 0.96 ms; zero scans after initialization |
| Decode 100 maximum-sized frames in 1 KiB fragments, median of five runs | 186.3 ms | 1.84 ms |
| Decode one maximum-sized fragmented frame | 256 concatenations recopying 33,946,629 bytes | One 262,144-byte payload allocation |
| Drain 100,000 buffered runtime events, median of five runs | 220.7 ms | 5.61 ms |
| Three hours of every-minute cron catch-up, median of three runs | 4,626.31 ms; 2,085,301 timezone conversions | 27.92 ms; 11,701 timezone conversions |

The thread benchmark also verified an indexed middle-page range: backward scan of `messages_thread_idx`,
51 rows and 0.070 ms database execution. Its migrated throwaway database was dropped. Ordinary full-frame git
decoding stayed comparable (500 frames: 7.97 ms versus 7.82 ms); the large gain is on fragmented input.

## Verification

Regression coverage lives beside the affected code:

- Thread paging covers unknown/foreign cursors, equal timestamps and submillisecond timestamps across pages.
- Approval reads assert query counts, retained previews and exclusion of viewers who cannot decide.
- Client cache tests cover one initial scan, zero repeated scans, partial parameters, additions, removals, clear,
  reentrant subscriber removal, shared caches, malformed/unpopulated keys and mutation during snapshot iteration.
- Command frame tests cover split/coalesced headers and bodies, limits, empty frames, binary/text data and ownership.
  Runtime queue tests cover bursts, compaction, refill, `undefined`, close and failure.
- Cron tests cover dense catch-up, cache eviction, repeated hours and the safety guard. A separate comparison with
  the baseline returned identical results in 240 cases across Europe/Amsterdam, Australia/Lord_Howe, Pacific/Apia
  and UTC, including spring/fall transitions, the date-line skip, weekdays, leap-day expressions and all DST policies.

Repository validation is `pnpm format`, `pnpm check` and `pnpm test:server`. Shared client changes are published in
the web app and both phone apps from the same commit.

The full check exposed a pre-existing clock dependency in the web settlement suite: before 09:20 local time, a new
settlement sorts behind the fixture's 09:20 settlement. The same test fails with the baseline cache implementation.
The suite freezes only `Date` at an afternoon instant, leaving event timers real.

## Further profiling candidates

The review also identified places to profile before changing their design: repeated Home dependencies within a
desk glance, protected frame enrichment across multiple devices, session ordering-map retention, mobile
message-model rebuilding and small-record encrypted-session queues. Release bundling and document/grid work need
real workload profiles before adding concurrency or caches; existing lazy loading, bounded streaming and signature
verification remain. These candidates have no claimed performance benefit. Existing permission,
connection-ownership, compression, streaming and cancellation mechanisms remain authoritative.

## Additional measurements and coverage

Baseline: `50708f20f3c0d675b3d3cba205b166dd94c7c26c`; Node 24.18.0 on The Titan. These are isolated query/algorithm
measurements and DOM operation counts, not end-to-end app latency. Shared client/parser changes ship in app 3.18.1
on web, Android and iPhone; there is no wire/schema change or migration.

| Workload | Baseline | Optimized |
|---|---|---|
| Desk person discovery, one valid burrow; 50 warm reads (mean) | 7 queries; 1.470 ms | 1 query; 0.262 ms |
| Account-filtered desk target, same setup | 8 queries; 1.195 ms | 1 query; 0.306 ms |
| Ordered child hydration, 1,000 parents / 20,000 children; median of 11 | 20,000,000 key visits; 104.09 ms | 20,000 visits; 0.443 ms |
| 2,000 root edits in 100 thread pages of 50 rows; median of five batches | 100 page copies per edit; 131.32 ms | 1 page copy per edit; 35.27 ms |
| 2,000 newer replies to a thread on a later page, same setup | 100 page copies per reply; 136.87 ms | 2 page copies per reply; 33.22 ms |
| 1,000 simulated terminal output mutations, 5,000 cells / 4 styles | 1,000 whole-terminal scans; 4,000 stylesheet reparses | Zero whole-terminal scans or reparses after setup |
| 100 masked 256 KiB CDP frames in 1 KiB fragments; median of five | 250.48 ms | 36.28 ms |
| 10,000 network decisions with 256 production ranges; median of five | 517.22 ms | 15.31 ms |
| Ten 256 KiB console reports in 16-byte fragments; median of five | 121.64 ms; 16,368 concatenations per report | 14.13 ms; 16 concatenations per report |
| Markdown: 16,000 unmatched brackets and a valid link; median of seven | 127.80 ms | 0.415 ms |
| Markdown: 6,000 excess closing URL parentheses, same method | 17.75 ms | 0.113 ms |
| Markdown: 12,000 blank lines between list items, same method | 222.85 ms | 0.199 ms |
| Markdown: 10 parses of 3,000 fenced code lines, same method | 4.086 ms | 1.013 ms |

Ordinary whole-frame CDP decoding stayed comparable (about 29.4–29.7 ms for the same 100 frames), as did ordinary
mixed Markdown (1,000 messages: 7.51 ms versus 7.74 ms). Terminal measurements count operations in jsdom, whose
stylesheet stub cannot measure actual browser CSS parsing. The child-hydration benchmark isolates grouping rather
than the full database read. Its parent count is a scaling workload. The desk benchmark's migrated throwaway
database was dropped.

Reproduction scripts and raw output are in `/home/me/.cache/wb-tmp/stack-opt-20261029/`: `server-bench.mts`,
`clients-bench.mts`, `runtime-benchmark.ts`, `runtime-console-benchmark.ts` and `core-bench.ts`, with the captured baseline modules and logs/JSON.
Run with Node 24 from the repository root using `node --import tsx <script>`; the server script uses the existing
Postgres and creates/drops its own database. The Markdown comparison uses deterministic seed `0x129ac` and checks
both inline and block output in 20,064 cases; thread updates match in 432 edge cases, network decisions in
16,896 cases and console batches in 100 mixed-console/exit/gap cases. Focused regression tests cover real SQL child ordering and identity selection, immutable page
references, terminal style mutation/cascade/cleanup, fragmented binary framing, current policy checks and parser
boundaries. The new server test files need PostgreSQL for the ordered relational reads and joins; neither opens an HTTP listener.

The review covered every workspace area: server reads/background jobs/commit and event paths; web/mobile/shared
client rendering and data flow; widget/admin queries; core text/keys/approvals/scheduling; protocol/secure-channel,
cross-language generation and release signing; runner/network/command I/O and Hermes integration; canvas/screen
logic; assets/tokens/fixtures; and CLI, build and release tooling. Changes are confined to paths with demonstrated
repeated work. The hosted CSP journey verifies the real terminal. Messaging visuals compare both themes at
1440×900 (plus the 1200px narrow variant); the card harness compares crops at its documented viewport with the
HTML references.

Validation on the combined implementation passed: `pnpm format`, `pnpm check` (10,863 tests),
`pnpm test:server` (1,937 tests), the 16 messaging/card visual cases and all four hosted CSP journeys. Card
comparisons reported 0.000% pixel difference within the harness's documented crops/masks. A separate subagent
review found no correctness issues. Test servers stopped and temporary databases were removed by their harnesses.
