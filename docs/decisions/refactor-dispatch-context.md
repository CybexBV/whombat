# Select dispatch messages before loading their detail

Runtime refactor opportunity 3, 2026-10-20. BP-B12's whole-thread candidate set and RF-03's public paging
semantics are settled. This changes when a dispatch resolves its message detail, not which messages it selects.

| # | Decision | Reason |
| --- | --- | --- |
| RDC-01 | **Keep every candidate; hydrate only the selection.** `runtime/context-selection.ts` reads the same recent top-level window and the entire current thread in `(createdAt, ord)` order. `read/messages.ts` supplies server-only candidates with text, time, thread id and resolved-card presence. The trigger and root are always kept and remain fully loaded for ranking and the fixed budget. After `assembleMemory`, `hydrateMessageCandidates` resolves only selected window/reply messages through the existing `loadMessages` reader. | Warm sessions and budgeted long threads previously loaded cards, reactions, attachment metadata, run steps/files and viewer-specific details for messages immediately discarded. No history cap or public paging API change is needed. |
| RDC-02 | **Retain the original stored message rows until hydration.** A candidate references its stored row; hydration does not fetch it again. Text still uses JavaScript's UTF-16 `length`, including astral characters. | An edit or deletion during memory selection must not silently change the text budget or erase a selected message. Keeping raw rows also preserves inline cards, tombstones and all message fields without inventing a second message renderer. Reading and retaining candidate rows remains linear in thread length; this optimization targets their expensive detail graphs. |
| RDC-03 | **Card cost follows resolved presence.** Small id/boolean queries check plan, run and approval existence; reports require their integration; assessments require `done`, an assessment and a conclusion (SQL and JSON null both absent). Inline cards and skill/schedule wrappers remain present even when their referenced detail is missing or hidden from the viewer. | Charging 120 characters for every stored reference would change selection for dangling references and incomplete assessments. These checks deliberately mirror `loadMessages` and `feedback/cards.ts`; the regression suite compares their real outputs. |
| RDC-04 | **Leave the memory algorithm and bookkeeping intact.** `assembleMemory` accepts either complete messages or candidates, with the same cost. Trigger/root accounting (including both when they coincide), strict `createdAt > since`, reflection forks, knowledge ranking and reauthorization, summary coverage/status/job boundary, and `seenThroughAt` over *all* input messages stay unchanged. `afterBuild` still runs after successful message hydration and uses the commit pipeline. | These values control later provider sessions and durable summary jobs, not just the current prompt. No leases, fencing, cancellation, signing or worker behavior changes. |
| RDC-05 | **Preserve the opening-turn tail and memory fallback.** The last 12 replies of CH-03's earlier thread are selected before tombstones are removed. The combined window keeps its existing stable timestamp sort. A memory read failure still hydrates the last 20 combined candidates and the complete current thread, reports unavailable, and records null memory bookkeeping. Detail-load failures remain errors, outside the memory-unavailable catch. | Applying a budget or seen cursor to the fallback, or filtering tombstones before taking the tail, would change what a turn sees. |
| RDC-06 | **Use the existing authorization and rendering paths.** Membership is checked where it was, knowledge sources/audiences are reauthorized in the same assembler, and the retained messages use the same attachment ownership/readiness, reactions, skill/schedule audience, Vault and connection-detail readers. Feedback assessments continue through their separate restricted context path; search turns retain their existing context and file restrictions. `read/views.ts` is untouched. | Internal candidates never cross a process boundary. No contracts, vendored core, manifests, visible words, automations or Home code change. Live related objects are still read at hydration time; this does not introduce a transaction-wide snapshot or a cache. |
| RDC-07 | **Preserve absent cards through hydration.** When a selected candidate's resolved card was absent, pass a shallow copy of its retained row with `card: null` to `loadMessages`. Do not mutate the stored row or the candidate's retained row. Present references still go through the ordinary live reader and all viewer/owner checks. | An incomplete assessment can complete, or a dangling plan/run/approval/report reference can become resolvable, during memory assembly. Materializing that card afterward adds 120 unbudgeted characters and differs from the eager input. Suppressing only previously absent cards preserves selection and bookkeeping without eager detail reads, extra queries/transactions or snapshots of sensitive detail. |

## Card transitions during assembly (review P2 correction)

The absence rule applies to every nullable live kind: plans, runs and approvals require their object; reports also
require their integration; assessments require a completed result and conclusion. A reference absent at candidate
selection stays absent for that dispatch, including memory-unavailable fallback. Public reads and later dispatches
still resolve it normally from the unchanged stored reference.

A reference present at selection is resolved live. If its object disappears or its assessment stops resolving,
hydration returns `card: null`; the original 120-character reservation stays in the reported/persisted selection
budget. This is conservative: actual cost can decrease, never increase from a newly appearing card. Selection is
not rerun to fill released space, and no earlier live object is retained or resurrected. Skill/schedule wrappers
remain present and charged even when their detail is missing or hidden; their audience checks, attachment
readiness/ownership, and Vault/connection owner checks all still run during ordinary hydration.

The focused Postgres regressions force transitions after the real assembler completes and before hydration:
an existing incomplete assessment completes in a thread reply, a missing plan appears for a top-level candidate,
and an existing plan disappears. Before the correction, both appearance cases returned **341 actual characters
against a 300-character limit**, while budgeting only 221 in isolation. After the correction, complete selected
output equals the eager baseline (including `card: null`), actual cost stays within budget and equals `usedChars`,
and durable `dispatchMemory` cost, token estimate, status, reason, seen cursor and knowledge ids match. Public
reads then resolve the new card, proving the stored reference remains intact. The disappearance case verifies live
null resolution with the original budget reservation rather than reusing an eager card snapshot.

Correction validation: **16 context-selection Postgres tests passed**, including the three new transition cases;
the **server typecheck passed**. Both ran with Node 24.18.0 and the shared test/typecheck `flock` below. Biome checked
and formatted only the two owned TypeScript files. Parent retains full verification and integration/shipping.

## Cost evidence

Measured by `runtime/context-selection.int.test.ts` on the harness's throwaway Postgres database, Node 24.18.0.
The fixture has 20 top-level candidates and 400 replies. Every reply references a distinct run with six steps
and six files. A 2,400-character budget selects five messages; trigger and root are also read as fixed context.
Both paths produce identical complete selected messages, memory, summary job, flags and seen timestamp.

| Measurement | Eager reference | Deferred hydration |
| --- | ---: | ---: |
| Window/reply candidates examined | 420 | 420 |
| Message ids passed to reaction detail queries, including fixed context | 422 | 7 |
| Run ids passed to file detail queries, including fixed context | 401 | 6 |
| Run ids passed to step detail queries, including fixed context | 401 | 6 |
| JSON size: eager complete candidate messages vs retained stored rows **plus** complete selected messages | 4,477,121 bytes | 512,405 bytes |

The detail-id totals come from the actual SQL requests, not mocked readers. The JSON sizes measure a reproducible
payload proxy, not heap usage, database wire bytes or elapsed latency. The deferred figure includes every retained
stored row; shared string/object references are not claimed as another saving. Card presence adds up to four small
queries per candidate batch. Short threads selecting everything may gain little; memory-unavailable fallback must
still hydrate the whole thread. No latency threshold or arbitrary history limit is introduced.

## Regression coverage and validation

The new integration file needs Postgres to compare the real joins and viewer filtering with eager `messagePage`,
`threadView` and `loadMessages` plus the unchanged memory planner. Its 13 tests cover:

- A 1,203-reply thread whose entire history fits, ordinal timestamp ties, and a root outside the top-level window.
- Fixed trigger/root accounting, instructions/checkpoint constraints, tiny budgets, warm sessions including timestamp
  ties and an omitted newest message, and reflection forks.
- Exact summary coverage, failed summaries, membership invalidation, top-level candidate-limit rebuilds, and durable
  summary targets/dispatch bookkeeping.
- Memory failure with the full thread, source/audience permission changes and a removed agent.
- Every nullable live-card kind, incomplete/removed assessments, hidden skill/schedule detail, UTF-16 text at budget
  boundaries, file readiness/ownership, reaction order/viewer state, and stored message snapshots across an edit.
- Earlier-thread tails with tombstones, root normalization from a reply, search file restrictions, and the cost
  fixture above.

Targeted validation passed: **76 tests in eight integration files**, plus the server typecheck. The other files are
`memory/memory`, `memory/continuity`, `memory/reflect-fork`, `files/context-window`, `domain/channel-threads`,
`read/thread-paging` and `feedback/assessment` (all `*.int.test.ts`). Every test/typecheck ran under
`flock /home/me/.cache/wb-tmp/whombat-refactor-tests.lock` with Node 24 and `TMPDIR=/home/me/.cache/wb-tmp`.
Only owned files are formatted. The parent runs the full repository checks and handles integration/shipping.
