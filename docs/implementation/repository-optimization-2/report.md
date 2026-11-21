# Repository optimization, second pass — 1 November 2026

This pass looked at what the 29 and 31 October passes left unmeasured: the web page's first load and Chat's renders,
an idle and a busy box's database work, the agent's per-command and per-turn cost, logic held twice, and how long the
checks take. It changed the web app's boot and render paths, the server's Home, desk, MCP, poller and commit reads,
the runner's command launch and production-server lookups, and the test workflow, and consolidated the copies that
mattered. Wire contracts, permissions, signed audit content, visual output and copy are unchanged; there is no
migration and no new dependency. No contracts release is needed: every exported name of core and protocol stays.

Baseline: `64647809d` (main). Work: branch `perf/optimization-20261031b`, not merged, pushed or shipped (the task
excluded deployment and publication). Decisions OPT-19…OPT-35 are in
[stack-optimization.md](../../decisions/stack-optimization.md); raw samples in [measurements.json](measurements.json).

## How the work was done

Five read-only investigations ran in parallel — test/build workflow, web bundle and rendering, duplication, server
runtime and data access, runner and sandbox — each in the shared baseline worktree, each with its own scratch folder.
Their findings were consolidated and checked before implementation (the coordinator re-read the git relay's redaction,
the duplicated app-secret label, the automation asker, the MCP call path, the leaking asset stream, the helpers' use
of HTTP, the Nix build's copy of `app/`). Seven implementation agents then worked in separate worktrees with disjoint
file ownership; the coordinator reviewed each branch, merged them, fixed what the reviews turned up (backup labels,
the health pass's spurious refreshes), re-ran the measurements on the combined tree against a baseline worktree, and
wrote the documentation.

| Area | Investigated | Coverage gaps |
| --- | --- | --- |
| Web | Box and hosted production builds, every chunk's raw/gzip/Brotli size and module attribution, initial and first-screen sets, headless Chromium cold loads on emulated remote and LAN links, a main-thread profile, render counts per realtime event in Chat, open-time requests | No physical device or real HTTP/2; render counts are jsdom development builds; thing pages, Needs you, Settings and the thread pane not render-profiled; the phone app's render paths not examined |
| Server | Every boot-time timer and poller, a 16-minute idle run with every statement attributed to its call site, request/job/commit statement counts on a larger world, EXPLAIN of flagged queries, file-descriptor and listener lifetimes, boot cost | Multi-device realtime fan-out, real APNs/FCM/IMAP/GitHub/hosts services, heap snapshots, production-mode boot |
| Runtime | A trivial command end to end through the real bubblewrap pod (launcher, runner decision, cgroup join, nsenter, bwrap), turn setup, workspace preparation, agent-net throughput and DNS, resource cleanup, the Python plugin (static) | Hermes's own Python side of a command, the appliance's delegated cgroups, the Z13's timings, the cgroup `favordynmods` remount (needs root) |
| Duplication | Token-window clone scan of 4,888 files (exact and renamed), function-level groups, web↔phone same-name declarations, then line-by-line comparison of every candidate | Python, Go, Swift/Kotlin and CSS not scanned; admin and widget partly; web↔phone matched by name and sampling |
| Workflow | Full unit suite under cache/sequencer/pool/isolation variants with Vitest's main process profiled, slowest files' causes, `test:server` hooks, web build phases, CI's wrapper | No CI-guest run; coverage runs with the cache; `vmForks` memory |

Contracts generation (2 s, no diff) and the encrypted session's codecs (already linear, list-backed buffers) were
checked and left alone.

## Measured performance

Environment: The Titan (Linux x64, AMD Ryzen Threadripper 9970X, 64 threads), Node 24.18.0, PostgreSQL 17 on the
shared server with throwaway databases. Other agents worked on the same host throughout; every timing records the
1-minute load average, A/B runs alternate, and timings taken under load are indicative unless their ranges separate.
Statement counts are deterministic.

### Web: first load and renders

Box target, `pnpm build:web` on each tree, measured with `scripts/benchmarks/web-initial-size.ts`:

| What the page fetches itself | Base | Final |
| --- | ---: | ---: |
| Initial JS, 7 files: raw / gzip / Brotli kB | 2,157.9 / 711.7 / 597.4 | 2,020.9 / 665.1 / 559.2 (−6.4% Brotli) |
| Initial CSS, 1 file, Brotli kB | 6.8 | 6.8 |
| Preloaded boot chunks | none | 28 JS (193.8 kB Brotli) + 19 CSS (41.9 kB) |

The preloaded chunks were fetched before too, only a round later. Time until the page asks its box who it is
(`GET /v1/direct`), cold loads in headless Chromium 153, base and final alternating, load 48–54:

| Profile | Runs | Base median (range) | Final median (range) |
| --- | ---: | ---: | ---: |
| Remote: 50 ms per request, 20 Mbps, CPU ×4 | 7 each | 1,523 ms (1,504–2,050) | 930 ms (872–1,047): −593 ms, −39% |
| LAN: 2 ms, 200 Mbps, CPU ×4 | 9 each | 712 ms (684–792) | 704 ms (607–819): no difference claimed |

The web agent measured 1,385 → 826 ms remote at load 5.8. The static server is HTTP/1.1; over HTTP/2 the gain should
be smaller. The admin panel's script fell from 242.3 to 193.1 kB Brotli (`@whombat/brand` side-effect free); the
fixture screen chunk (23.6 kB Brotli of `@whombat/fixtures`) is gone from production builds.

Renders on `/chat` with 200 extra messages (jsdom, React development build, mean of 15 repeats, load 5–6):

| Realtime event | Renders before | after | Handling time before → after |
| --- | ---: | ---: | --- |
| Typing frame | 470 | 80 | 9.6 → 4.5 ms |
| `activity.updated` | 234 | 79 | 8.2 → 4.5 ms |
| `conversation.unread` | 1,452 | 220 | 24.0 → 11.5 ms |
| `message.created` (single run) | 1,706 | 298 | — |

A resync with burrow and conversation topics made 5 fetches (each of two reads twice); it makes 3.

### Server: statements per operation

`run-final.sh` (below), base tree against the final tree, two alternating rounds; counts identical in both rounds:

| Operation | Base | Final |
| --- | ---: | ---: |
| MCP `tools/call` of a cheap tool (`plan_read`) | 46 | 21 |
| MCP `tools/call` `read_conversation` / `set_status` | 56 / 59 | 30 / 33 |
| MCP `tools/list` | 33 | 19 |
| Desk glance (`buildFullGlance`), every 10 s with a paired screen | 52 | 19 |
| Desk console, one minute (60 states, a glance every 10 s) | 393–424.5 | 243 |
| `home.overview` | 53 | 25 |
| `listWidgets` (12 widgets × 288 points) | 13 | 2 |
| Connection health pass, 20 due connections, every 5 min | 241 | 125 |
| Look pass | 21 | 18 |
| GitHub poller, scheduled ticks: statements / cursor writes per minute | 99.5 / 7 | 74 / 2.83 |
| GitHub full cycle over 4 repositories | 40 | 26.2 |
| Agent reply / person reply that queues a turn | 35 / 34 | 34 / 32 |

Isolated timings measured by the implementing agents at load 5–16, paired: MCP cheap call 28.0 → 14.6 ms; desk glance
~15 → ~7 ms; Home's unanswered-questions query 12.6–20 → 1.9–2.5 ms on ~19k messages (89–95 → 3.1 ms with a
2,000-message task chat; EXPLAIN shows `messages_thread_idx`); the glance's widget read 42.9 → 0.15 ms at 2,880
points; 20 abandoned asset downloads +20 → +0 file descriptors. The final-tree timings above were taken at load 34–43
and only confirm the direction.

The health pass also stopped telling Home of changes that weren't: the stored glance comes back from jsonb in jsonb's
key order, so the text comparison always differed and every connection published `home.changed` on every pass (20
outbox rows per pass in the benchmark), each making every open app refetch Home. The regression test fails on the old
code.

### Runtime: per command and per turn

Real bubblewrap pod path, 30 paired runs after 5 warm-ups, medians (p90):

| Load | End to end, trivial command | Launcher start | One helper call |
| --- | --- | --- | --- |
| 6 | 50.2 (87.7) → 34.9 (44.3) ms | 30.2 → 18.3 ms | 33.9 → 16.6 ms |
| 46 | 57.5 (115.5) → 40.8 (48.0) ms | 35.7 → 20.1 ms | 44.5 → 22.1 ms |

Production-server lookups before Hermes starts, real resolver, alternating: one unresolvable `.local` name 5.0–8.0 s
→ 1.0 s; two bare names 7.9–10.0 s → 1.0 s; three resolvable names 23 ms → 1 ms.

### Workflow

Full unit suite (`pnpm exec vitest run`), base tree against the final tree, alternating in three rounds, load
28–56 (`final/unit-timing.sh`):

| Variant | Wall, s (three runs) | Median |
| --- | --- | ---: |
| Base: Vitest's defaults | 69.7, 70.3, 81.7 | 70.3 |
| Final, warm module cache (a local rerun) | 38.8, 38.3, 41.9 | 38.8 (−45%) |
| Final, empty module cache (first run in a worktree or after an install) | 65.3, 67.8, 75.8 | 67.8 (−4%, within noise) |
| Final as CI runs it (`CI=true`: no cache, Vitest's own order) | 68.3, 73.2, 69.5 | 69.5 (no change claimed) |

The workflow agent's paired series (load 11–68) separates the parts: Vitest's order with a warm cache 51.5 s (six
runs, 49.9–52.5) against no cache 72.5–88.5 s, and the longest-first order warm 41.8 s (fourteen runs, 39.1–47.1). A
warm cache leaves worker CPU about the same; it removes the main process's transform work, which profiling showed
was the bottleneck (busy 95% of a cold run, 63% of transforms duplicates across projects). Four small integration
files: 7.1–10.9 s cold, 4.0–4.3 s warm. The cache held 11,868 entries (373 MB) after a full unit run, 428 MB with
the integration files; it is cleared when the installed lockfile changes, not pruned otherwise.

Slow files, warm cache, three runs each: `commands-sandbox.test.ts` 34.6 → 7.0 s (a background job held the
command's output open for 30 s); `connections.test.tsx` 11.7 → 1.8 s, `bluetooth.test.tsx` 6.4 → 1.5 s,
`repointServers.test.tsx` 2.6 → 0.7 s (2 s polls); the key-store race 9.4 → 2.0 s (fixed sleeps); `sandbox.test.ts`
with `pod-sandbox.test.ts` 11.7 → 6.6 s (probe timeouts). Box web build, four runs each: 6.70 → 5.54 s median with
16 libuv threads for precompression; all eight outputs byte-identical, `.br` and `.gz` included.

Cold runs exposed a flake that predates this pass: the first test of `lookResearch.test.tsx` reached the thing page
through the router's lazy import inside `findBy`'s five seconds, and failed in one of three base runs and five of six
cold final runs at that load. With the page's screens loaded in a `beforeAll` (also in `connections.test.tsx` and
`connectionSignIn.test.tsx`, which the workflow agent saw time out once each), six more cold runs all passed, load
12–40: empty cache 66.1, 65.7, 65.0 s (median 65.7); CI's way 68.1, 68.0, 68.2 s (median 68.1). The cold variants'
time is unchanged from the base within noise; the gain is on every run after the first.

## Shared logic

| Consolidation | Callers now | Copies removed |
| --- | --- | --- |
| `@whombat/client` `automationAsker.ts` | 7 web, 4 phone modules | web and phone copies (phone's was a strict superset) |
| `@whombat/client` `notifications.ts` (weekday labels, ends/set/days/quiet-hours text, `toggleDay`) | web Settings, phone notify | 6 identical functions ×2; DND state text and custom end-time inputs stay per platform |
| `@whombat/client` `vaultForm.ts` (auth labels, `vaultAuthOf`, field problems, refusal words) | 6 web Vault files, phone form | identical copies; the web's table is a superset the phone never reaches |
| `@whombat/client/managed/react` (`useLeaveWhenGone`, `useOpenWhenLetIn`, `useDirectoryEntry`) | web ManagedRoot, phone ManagedApp | 3 identical hooks ×2 |
| `@whombat/client` `schedules.ts`, `trackerItem.ts` | web and phone schedules, the tracker runs | identical words; each app keeps its colours and run-step wording |
| Phone Settled list → `useChatThreads` | `SettledScreen` | `apps/mobile/src/data/useThreadLists.ts` |
| Server `signVaultUse` (`vault/commands.ts`) | 4 Vault paths | four signing-and-recording copies; frames, signed lines and rows compared identical before and after |
| Server `burrowSystemPrincipal` (`domain/system-principals.ts`) | Feedback, the tracker, Servers, GitHub signers | four copies; GitHub's hand-written topic now `topics.burrow` |
| Server `addQuietExceptions` (`domain/quiet-watch.ts`) | servers' and things' What Whombat watches | one loop; each keeps its missing-check fallback |
| One `connector_app:<provider>` label (`connectors/crypto.ts`) | connector apps, catalog apps, backup collect and restore | four places; a unit test pins the label |
| Core `@whombat/core/text/utf8` | backup bytes, feedback drop, skill files, protocol bytes, `utf8ByteLength` | four decoders and two byte counters; one malformed-input corpus runs against every caller |
| Protocol `jws.ts` (`verifyCompactEdDsa`, `signCompactEdDsa`) | admission and licence tokens | one verifier/signer; error order pinned by test |
| Commands `frames.mjs`, `line-client.mjs` (shipped in `app/`) | `whombat-git`, `whombat-gh`, `whombat-helper` | git's byte-identical frame codec, two socket-path helpers, three line requests; the package test fails if a shipped file's sibling import isn't shipped |

Clone scan, exact mode (≥100 tokens and 15 lines): web↔phone 1,007 → 714 duplicated lines; server production 457 →
349; core/protocol/commands production pairs 8 (291 lines) → 2 (81 lines, both unrelated). Lines: client sharing
+584/−949 production, server sharing +327/−388, contracts and commands +381/−544. Intentional differences stay
apart and are listed under deferred findings.

## Validation

Final tree (`perf/optimization-20261031b` with the docs commit), The Titan, load 23–43 unless noted:

| Check | Result |
| --- | --- |
| `pnpm format`, `pnpm check` | Passed: Biome 5,395 files, typecheck, 1,176 test files / 11,363 tests (2 skipped); 50.4 s wall with a warm cache (base: 1.2 + 11.2 + 77.8 s for its three parts) |
| `pnpm test:server` | Passed: 263 files / 2,018 tests (3 skipped), 144.2 s at load 43 (135.9 s at load 22 before the workflow merge) |
| `pnpm contracts:gen:check`, `pnpm contracts:test:go` | Passed: no generated diff; Go `local`, `protocol`, `release` ok |
| `pnpm hermes:test` (pinned Hermes 0.22.5) | Passed: 115 tests, including the launcher-environment cases |
| `pnpm build:web`, `build:web:hosted`, `build:admin` | Passed; the box page carries 28 module and 19 style preloads and no fixture module (the build now refuses one) |
| `pnpm e2e:box` | Passed: 6 (2 skipped) |
| `pnpm e2e:managed` | 122 passed, 39 skipped, 1 failed: `content.spec.ts:24` (attachments shown from blob URLs) fails identically on the base tree `64647809d`, before and on retry, so it predates this pass |
| Unit suite, cold, after the screen preloads | Six runs, all passed (above) |
| Sandbox tests' systemd units | `commands-sandbox`, `sandbox` and `pod-sandbox` tests leave no `wb*` unit behind |

Each change has a test that fails on the old code, checked by its agent or the coordinator: render counts, resync
fetch count, subscription order, retry count, the fixture-chunk guard, boot preloads, MCP and Home statement counts,
the poller's reads and writes, the message commit's reads, the health pass's reads and its silence on an unchanged
glance, the page-file close, the lookup bound, split-token redaction, the exclusive temporary file, the UTF-8 corpus
(mutation-checked), the token error order, the shipped sibling imports, the cache's stale cases (by the invalidation
script). Outputs compared identical before and after: Home's overview, Needs you, things, watch list, working task
and glance on one world; every Vault use's frames, signed lines and rows; each system signer's creation; the box web
build with and without 16 precompression threads.

Housekeeping on the host: 677 leftover `wb*` systemd user units from earlier test runs (398 `wbtest*` and 276
`wbcmdtest*` slices, one `wbhermes*` slice, and the `wbcmdtest2404643-gcmdprobe` and `wbhermes3361930-ghermes`
scopes still running `sleep infinity` for test processes that ended days ago), each named after a process that no
longer existed, were stopped. Throwaway databases made by the benchmarks were dropped and checked absent. No container,
VM or service was created, restarted or redeployed. The implementation worktrees and branches were removed after
merging; the base worktree too.

## Reproduction

From the repository root, Node 24 on PATH, `TMPDIR=/home/me/.cache/wb-tmp`:

```sh
# A baseline checkout beside this one
git worktree add --detach ../perfb-base 64647809d && (cd ../perfb-base && pnpm install --frozen-lockfile)

# Web: initial and preloaded bytes of each build
(cd ../perfb-base && pnpm build:web) && pnpm build:web
node --import tsx scripts/benchmarks/web-initial-size.ts ../perfb-base/apps/web/dist
node --import tsx scripts/benchmarks/web-initial-size.ts apps/web/dist

# Unit suite: the base's defaults, then this tree cold, warm and as CI runs it (alternate them; note the load)
(cd ../perfb-base && time pnpm exec vitest run)
pnpm exec vitest --clearCache && time pnpm exec vitest run   # empty module cache
time pnpm exec vitest run                                     # warm
CI=true time pnpm exec vitest run                             # no cache, Vitest's own order
```

The statement counts are pinned by regression tests that fail on the old code: `mcp/mcp.int.test.ts` (tools/list,
tools/call), `home/overview-reads.int.test.ts` (overview, glance, widgets), `github/poller.int.test.ts`,
`things/quiet/quiet.int.test.ts` (health pass), `home/home.int.test.ts` (no change, no `home.changed`),
`domain/message-dispatch.int.test.ts`. The measuring harnesses — a loader hook that attributes every postgres.js
statement to its call site, the server, MCP, poller and browser benchmarks, the command-latency bench — rewrite
library internals at load time and point at worktrees, so they stay outside the repository, in
`/home/me/.cache/wb-tmp/perfb/` (`final/run-final.sh` re-runs the server counts on both trees;
`perfb-web/browser/measure.mjs remote 7 base=<port> final=<port>` with `server.mjs <dist> <port>` the browser timing;
`runtime-impl/launcher-env-bench.mts` the command latency).

## Deferred findings

| Finding | Why deferred, and the next useful evidence |
| --- | --- |
| Joining a command's cgroup waits for an RCU grace period, ~40 ms after any idle | Fix is the appliance's cgroup2 `favordynmods` mount (a host change with a system-wide fork/exit trade-off) or a warm spare launcher per Hermes environment (a larger design that must keep one fresh cgroup per command and nothing before the runner's decision). Measure on the Z13. |
| Zod schemas built at page start (283 ms of a 725 ms 4× CPU profile) | Every endpoint schema loads with `API_OPERATIONS`; lazy contracts per area or zod/mini is a large refactor of shared contracts. |
| Connections catalog data in the first chunk (−49 kB Brotli upper bound) and ThingScreen's server pages (−93 kB Brotli on a thing page) | Reorganises core modules shared with server and phone, and changes loading behaviour that needs a visual check. |
| A waiting automation run is polled every 10 s with a lease write | Touches lease and fence handling; skip runs with a known wake once the engine's fencing is covered for it. |
| `widget.updated` makes every open app reload all of Home | A client/contract change: patch Home from the event or reload only `widgets.list`. |
| Unread notification count scans all of a person's notifications | Needs a partial index migration. |
| `decideUse`, `withholdUse` and the relays behind them have no callers | Vault decisions VT-D22/D32/D46 still describe them; removing them is a Vault documentation decision. |
| Copy drift between web and phone: Vault "signs in with" wording, automation run-step outcomes, chart tick spacing, `lastIndex` | Each needs a product decision on the right words or values before one implementation can serve both. |
| Local JSON clients over unix sockets (eight copies with different error-code policies), the runner long-poll bridge, things-kind connection reads, atomic writes (12 copies) | Real reuse, but their policies differ (one is a privacy rule); consolidating means choosing each policy deliberately. |
| `vmForks` for the web tests (−26% worker time), a pre-seeded test database template (3–4 s of `test:server` wall) | Memory growth and cross-realm `instanceof` risk; custody-key and timestamp equivalence of a template. |
| Vendored Claude provider: quadratic stream concatenation, repeated body parsing, a TLS context per call | Hash-pinned vendor code: patches belong upstream. |
