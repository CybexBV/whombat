# Repository optimization — 31 October 2026

The review produced four changes: batched automation-run reads, completed download cancellation and cleanup,
one shared activity redactor, and bounded live buffering during session replay. Public operations, wire formats,
permissions, billing rules and visual output retain their existing contracts. No dependencies or migrations changed.

Baseline: `b37fe2cc3`. Three sub-agents investigated backend/data access, frontend/client behavior and duplication
before receiving disjoint implementation ownership. The coordinating agent inspected their changes, covered runtime
and tooling, reproduced the replay defect, and reviewed the combined diff. Work stays on `perf/repository-20261031`;
deployment and publication were excluded by the task.

## Architecture and coverage

The repository is a Node 24/pnpm TypeScript workspace. The Fastify server owns Postgres through the signed commit
pipeline; runner and agent-net execute sandboxed Hermes turns and network policy. Devices use the encrypted
session, with pure contracts in core/protocol and shared client mechanics for React web and Expo phones. The CLI,
Python Hermes plugin, screen/canvas packages, supporting apps and runtime bundle complete the runtime.

| Area examined | Investigation and evidence | Coverage limits |
| --- | --- | --- |
| Server and database | Boot/shutdown, commit hooks, read hydration, paging/search, Chat, Home/desk, automations, GitHub polling, indexes and test database lifecycle; real SQL measurements below | No live traffic or exhaustive connector/IMAP/device-driver profile |
| Realtime and session | Replay/delivery, retention, authorization, enrichment, stream cancellation, slot/dial ownership; event-gated failure reproduction | No multi-device production trace or heap snapshot |
| Web and phone | Route splitting, precompression, memoized message rendering, rich-text loading, paging/reducers, endpoint cache index, subscriptions, mobile lists/timezone probes and task tracking | No new browser render/bundle benchmark or physical-device profile |
| Shared logic | Exact-block scans and semantic comparison across first-party apps/packages; activity redaction, notification formatting, requester identity and UTF-8 helpers | Similarity alone does not establish equivalence of complex forms or enrolment hooks |
| Runtime and I/O | Runner/workspaces/Hermes homes, command/network framing, queues, secure byte streams, Node HTTP/tar helpers and bundle construction | Static investigation; no new sandbox throughput or filesystem workload benchmark |
| Contracts and other packages | Core domain/text/scheduling, protocol/secure-channel, cross-language generation, screen/canvas interfaces and shared assets | Existing unit coverage; no new Go, native crypto, canvas interaction or device benchmark |
| Supporting apps and Python | Admin/widget entry points and transport boundaries; Hermes plugin isolation, test/build entry points and pinned vendor boundary | Layout/source review, not exhaustive screen or real-provider execution |
| Developer workflow and CI | Workspace scripts, Vitest temp cleanup, database admission/templates, CI phase wrapper, app/package jobs and controller-owned resource rules | Host checks only; no disposable CI resource/profile experiment or release reproducibility run |

Existing optimization decisions already cover indexed thread paging, grouped child reads, query-cache indexing,
incremental framing, event queues, CIDR parsing, cron and Markdown. Those implementations were preserved.

## Priorities and implementation

| Finding and location | Evidence and expected benefit | Selected change and validation |
| --- | --- | --- |
| Automation run page, [store.ts](../../../apps/server/src/automations/store.ts) and [routes.ts](../../../apps/server/src/automations/routes.ts) | Executed queries grow five per run in the linked-run fixture; remove repeated relational reads | `toRuns` batches steps, names, tokens, coding-run numbers and approvals. `toRun` remains the single-run wrapper. Existing `groupRows` supplies request-local grouping. SQL tests and complete reference-output comparison preserve order, duplicates, links and billing. |
| Published automation detail, same store | The same live version was loaded twice | One version row supplies both definition and publisher; query-count regression verifies one read. |
| Download lifecycle, [secure.ts](../../../packages/client/src/session/secure.ts) | Thirty completed transfers retained thirty abort listeners; cancellation before metadata never settled | Shared terminal cleanup removes the listener and stream, releases the slot and settles metadata. Cancelled waiters leave promptly. Per-caller cancellation preserves the shared dial. Regression cases cover completion, refusal, loss, explicit/pre-open cancellation and wake races. |
| Activity redaction, runner and server MCP activity | Two identical twelve-rule policies; security rules could drift | Pure [activity-redaction.ts](../../../packages/core/src/text/activity-redaction.ts) supplies both. Runner `redact` and server `redactSecrets` exports remain aliases. Family/threshold tests moved into core; caller tests retain normalization, redaction-before-truncation and evidence bounds. |
| Replay buffer, [events.ts](../../../apps/server/src/managed/events.ts) | A stalled replay accepted 1,001 live events without invoking the documented overflow policy | Apply the existing 1,000-event bound during replay, clear the buffer on closure, stop replay pages and recheck closure after enrichment. Real session-log tests cover the boundary, a 501-row replay and an unaffected consuming neighbor. |

Only read paths and lifecycle mechanics changed. Writes still use the commit pipeline. There is no cross-read
cache to invalidate. The activity policy is intentionally separate from the skill-scan entropy/placeholder policy.
Benchmark scripts are included in root TypeScript checking through `tsconfig.json`.

## Measured performance

Environment: The Titan, Linux x64, AMD Ryzen Threadripper 9970X, Node 24.18.0, PostgreSQL 17.11. The SQL fixture uses
three connections, four automations, 200 runs, four steps and two dispatches per run, two coding-run links and one
approval. It includes missing/zero/cache-split usage. The database is a migrated throwaway database on the existing
Postgres. The benchmark analyzes its tables and drops the database in `finally`.

The initial pre-edit default-page baseline was 13.460 ms and 150 hydration queries. The final paired experiment
loads the original store directly from `git show b37fe2cc3`, checks complete output parity, warms each variant five
times and measures eleven pairs in alternating order. All outputs match in every sample. Use the paired results
below for comparison; raw samples and output hashes are retained in [measurements.json](measurements.json).

| Runs hydrated | Original median (range), ms | Batched median (range), ms | Hydration queries | Median reduction |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 1.597 (1.467–6.938) | 1.048 (0.856–1.585) | 5 → 5 | 34.4% |
| 30, default page | 14.175 (13.021–16.859) | 1.712 (1.382–2.024) | 150 → 5 | 87.9% |
| 200, maximum page | 91.544 (82.472–116.810) | 6.398 (5.430–9.385) | 1,000 → 5 | 93.0% |

These are warm, isolated hydration measurements. They exclude the initial page-selection query, authorization,
transport, serialization and rendering. The default list uses 151 → 6 statements when its unchanged page-selection
query is included. Small single-run timings are less useful than the deterministic query reduction on full pages.
No end-to-end latency, whole-app CPU, memory-byte or bundle-size improvement is claimed.

## Resource and structural results

The client benchmark runs five independent in-memory appliance sessions, each with one warmup followed by thirty
64 KiB downloads sharing a retained abort signal. Every repetition delivers exactly 1,966,080 bytes.

| Metric | Original | Changed |
| --- | --- | --- |
| Abort listeners retained after 30 completed downloads, every repetition | 30 | 0 |
| Cancellation before metadata, after the server handler has entered | Still pending at a 50 ms diagnostic bound | Rejects with `AbortError` |
| Stalled replay with 1,000 live arrivals | No overflow | No overflow; all events delivered after release |
| Stalled replay with 1,001 live arrivals | No overflow while stalled | Exactly one overflow; no late delivery; other subscriber receives every event |
| Independent activity-redaction policies | 2 | 1, with original exports retained |

Listener counts are deterministic resource evidence, not a heap-size or timing benchmark. The cancellation bound
diagnoses a pending promise; it does not measure network latency. Replay tests inject a blocked enrichment and wait
on events rather than sleeping. The overflow regression fails on the original `events.ts`; both boundary cases and
the full existing event suite pass with the fix. Redactor consolidation is a maintainability improvement, with no
runtime speedup asserted.

A separate read-only lifecycle review found one more failure path: encoding an invalid download request rejected
the opening promise but retained the stream, abort listener and bulk slot. A focused test reproduced the retained
listener before the fix. Metadata opening now cleans up and rethrows the same `SessionEncodeError`; the regression
also verifies a valid request can immediately use a single-slot connection afterwards. The final client resource
benchmark was repeated after that fix. No further blocker was found. Replay overflow's wire-registration response
suppression was inspected in `managed/session/connection.ts`; the new burst regressions exercise the session log
directly, rather than adding a separate wire-level burst test.

## Reproduction

From the repository root with dependencies installed:

```sh
export PATH=/home/me/.local/share/mise/installs/node/24.18.0/bin:$PATH
export TMPDIR=/home/me/.cache/wb-tmp
mkdir -p "$TMPDIR"
benchmark_out=$(mktemp -d "$TMPDIR/whombat-optimization-repro-XXXXXX")
node --import tsx scripts/benchmarks/automation-runs.ts \
  --baseline-ref b37fe2cc3 --output-dir "$benchmark_out"
node --import tsx scripts/benchmarks/session-resource-lifecycle.ts \
  > "$benchmark_out/session-resource-after.json"
pnpm --filter @whombat/server exec vitest run --config vitest.int.config.ts \
  src/automations/run-reads.int.test.ts src/managed/events.int.test.ts
```

The SQL script captures the original module automatically and uses unchanged dependencies from this checkout.
Its initial `batched: false` baseline was also captured before store edits. Both runs' reports are retained.
To reproduce the original client result, make a separate checkout at `b37fe2cc3`, copy the retained
`scripts/benchmarks/session-resource-lifecycle.ts` into that same relative path there, install its frozen lockfile,
and run the same Node command there. This leaves the changed checkout intact. The client harness needs no database,
credentials, server, browser or containers.

## Validation

| Check | Result |
| --- | --- |
| Baseline `pnpm check` | Passed: 11,288 tests, two skipped; 82.93 seconds wall time |
| Final `pnpm format` and `pnpm check` | Passed: 11,331 tests, two skipped; 82.17 seconds wall time for check |
| `pnpm test:server` | Passed: 2,002 tests, three skipped across 263 passing files; 109.79 seconds wall time |
| `pnpm build:web` | Passed: production box-target web build, 6.57 seconds wall time |
| Focused SQL and replay suites | Five hydration regressions and all thirteen session-log tests passed |
| Focused client verification | Six suites passed before final review; all 68 secure-session tests passed after the encoding regression fix, followed by the complete repository check |
| Final diff/format review | `git diff --check` and repository formatting/lint passed |

The replay overflow and invalid-encode regressions each failed before their corresponding fix, as expected; their
logs are retained. There are no failing required checks. Existing opt-in skips remain. Biome's CSS specificity
information and Vitest's loader/cache guidance remain informational. The web build reports its large-chunk warning;
no bundle reduction is claimed. Check duration is contextual validation evidence, not an overall workflow speedup.
The raw check records' `max_rss_kib` values describe the largest child's peak RSS, not summed process-tree memory.

The committed measurements file retains raw SQL samples and client counts. Complete logs, the captured baseline
module and full expected output snapshots remain at
`/home/me/.cache/wb-tmp/whombat-optimization-20261031-c2zDNu/`. Temporary benchmark databases were dropped; the final
SQL benchmark's database absence was checked independently. No temporary containers, VMs or service leases were
created. Existing development/production services were not restarted or redeployed.

## Deferred findings and limits

| Finding | Reason to defer and next useful evidence |
| --- | --- |
| `home/widgets.ts` reads points per widget | At most twelve widgets; batching must preserve the oldest-2,880-points cap separately for each widget. Profile actual Home workloads before adding lateral/window SQL. |
| Protected-frame enrichment repeated per device | Shared enrichment needs viewer authorization and freshness proofs; measure actual multi-device fan-out first. |
| Secure-channel small-record FIFO shifts | Bounded byte queues and normal record sizes may make the cost insignificant. A realistic fragmented/burst profile is needed before introducing another queue implementation. |
| Notification text and automation requester models repeated across web/phone | Real reuse exists, but platform-specific DND wording, custom-time inputs and nullable requester behavior differ. Lower priority than the identical security policy and observed leaks; consolidate with platform behavior coverage. |
| Strict UTF-8 decoders repeated in core/protocol | Protocol throws an offset-bearing error while core returns null. Security-sensitive malformed-byte behavior needs a dedicated compatibility corpus before extraction. |
| Early iterator exit without explicit stream cancellation | Current callers have a `cancel()` API. Automatic iterator-return cancellation needs a deliberate lifecycle contract and consumer coverage; terminal and signal-driven cleanup is complete in this change. |
| Vitest filesystem transform caching | The baseline reports substantial transform work, but a stable-source repeated cache experiment and cache-growth/invalidation review were not performed. No cache or CI worker defaults were changed. |
| Web build precompression | The successful build reports 4.9 seconds in precompression. Files and Brotli/gzip already run concurrently; quality and deterministic bytes are intentional. No evidence supports adding a cross-build cache or changing compression quality in this pass. |

No new physical-device, browser rendering, real-provider, release/VM gate or hosted deployment result is claimed.
The changed frontend code is shared transport logic; no screen markup, copy, styling or layout changed, so visual
reference comparisons were not needed. Broader performance conclusions remain limited by these coverage gaps.
