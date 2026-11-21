# Disposable runtime CI performance — 2026-10-18

| # | Decision | Reason |
|---|---|---|
| CIP-01 | **Extended by CIP-08 for eight-worker benchmark jobs; ordinary jobs stay unchanged.** Keep the ordinary CI default at four Vitest workers until paired disposable-guest measurements validate eight. `pnpm ci:check` accepts `VITEST_MAX_WORKERS=1..8`, defaults to four, and applies the same value to unit and integration tests. | Local integration allows sixteen workers against a shared development database; that is not evidence for faster execution in a four-vCPU CI guest. Eight standard harness files hold at most forty persistent pool connections (eight `BUSY_POOL_SIZE=5` files), shared with their servers. Specialized database tests open additional pools, so forty is not a global bound: validate connection pressure in the real guest trial. The PostgreSQL 17 service is isolated; no shared host database is used. |
| CIP-02 | **Superseded in part by US-01 for PR unit-test scope.** The repository owns one runtime-check command and writes phase timings, Vitest JSON reports and ordered per-file assertion-window summaries under `ci-reports/`. Full runs include every unit test; eligible PRs select affected unit tests as defined in `ci-selection.md`. | The command preserves contract checks, frozen installation, lint, types, every integration test, the full two-minute memory soak and artifact-storage tests, and adds small execution-contract tests. The owner requested affected unit tests for small PR changes. The wrapper stops on failure and retains completed-phase evidence. A retry removes stale Vitest reports. |
| CIP-03 | Compare exact-source four-worker/four-vCPU and eight-worker/eight-vCPU runs, in separate controller-owned benchmark caches, before changing the normal job. Repeat cold, warm and alongside a heavy job. | More workers can worsen memory pressure or total queue time. `check.py compare` rejects missing gates, failures, different source/commands and changed test identities or outcomes. Its result is guest execution time only: use controller manifests for queue, preparation, teardown and resource-pressure evidence. Do not accept a faster result that omits tests or shortens the soak. |
| CIP-04 | First-time Servers connection provisioning takes the existing transaction-scoped burrow write lock before rechecking existence and allocating its handle. | Validation build 2121 exposed a real startup race: the asynchronous hosts start and an explicit readiness check both saw no connection, then inserted the same shared handle. The account-level pipeline intentionally supplies no burrow lock. Reuse the ordinary per-burrow lock, before any provisioning row locks, and sync tools after committing; concurrent starts return the same connection without serializing unrelated burrows. An integration regression races eight real first-provision calls. |
| CIP-05 | The first progress beat publishes `running` from dispatch state read under its transaction's row lock, using the existing live-state and runner/attempt fence. | Warm validation build 2131 exposed two concurrent first beats both reading `claimed` before either transaction and both publishing `running`. WS-46 requires the first beat's transition, not repeated liveness updates. Reuse the row lock already taken by dispatch updates and finalization before deciding transition ownership; every accepted beat still renews its lease and retains its activity. Only the transition owner follows plan work, which remains idempotent. A regression races eight real beats, requires all eight activity rows and exactly one running transition, and retains the strict end-to-end lifecycle assertion. |
| CIP-06 | Give only the four real durable-file tests explicit deadlines: 30 seconds for 120 overlapping-push rounds, 15 seconds for stage/commit/dedupe, and 10 seconds for the mode and symlink checks. Keep every write and assertion. | Build 2133 hit the generic five-second deadline during a measured shared-storage I/O stall, while CPU and RAM remained available. Those tests verify durability and atomicity, not a five-second disk-latency guarantee. Each round coalesces two pushes into one durable write. Check Vitest's abort signal between operations and pass it into staging; a test-only helper gives outstanding I/O a bounded five-second drain before teardown and reports failure if it cannot drain. Kernel fsync itself cannot be cancelled. This does not change global test deadlines or establish that storage caused the separate automation failures. |
| CIP-07 | CI typechecks four packages at a time (`pnpm -r --workspace-concurrency=4 typecheck`, then the root `tsc -p tsconfig.json`), not all at once as the local `pnpm typecheck` does. | With the apps and the contracts in the repository every package's `tsc` together peaks at about 17 GB, and the 12 GB guest was killed in the types phase (PR #2 on 2026-10-29, PR #3 three times on 2026-10-31); four at a time peak at about 9 GB. On The Titan all at once takes 6 s against 18 s, so the local script stays parallel. |
| CIP-08 | Eight-worker jobs with at least eight available CPUs and 10 GiB available memory run unit and server suites together with four workers each. Smaller jobs keep serial suites and their configured worker count. Reports retain every gate, separate logs and test identities, suite worker allocations, and resource limits. The full two-minute soak remains after both suites. | Use available CPU during database/network waits without doubling the configured worker budget or competing with typecheck's memory peak. Controller-owned paired benchmarks remain necessary before promoting normal jobs. |
| CIP-09 | Managed and hosted browser projects share one Playwright invocation and a total of four workers; the runtime smoke journey stays separate. | Their servers use separate ports, and one process owns both startup and artifact cleanup. Two independent invocations would each consume four workers and could clear shared traces. |

The workflow runs `python3 scripts/ci/check.py run` after configuring its isolated PostgreSQL URL. The command requires
`CI=true` and an exact `GITHUB_SHA` match, preventing accidental host execution. Normal local project
commands keep their existing behavior. Python 3 is already a requirement of the storage-test gate.
Start the wrapper directly: pnpm 12 auto-installs before running package scripts, which would add an
unmeasured install before the wrapper. The first phase executes the `contracts:verify` script from
package.json directly in Bash; the next phase performs the single measured frozen install. Vitest
reporter flags follow `pnpm exec vitest`, so pnpm cannot consume them as its own reporter setting.
The `pnpm ci:check` alias is a convenience only when dependencies are already installed.

The platform's reviewed `vitest_workers` job setting supplies the explicit benchmark override; the
normal workflow retains `VITEST_MAX_WORKERS: 4`. CPU allocation belongs to the controller, not this
repository. Use supported `ci-platform run` jobs; never create or inspect disposable guests manually.

Compare the exported `check-timings.json` files after the paired runs:

```sh
python3 scripts/ci/check.py compare --condition warm \
  --baseline /path/to/four-worker/check-timings.json \
  --candidate /path/to/eight-worker/check-timings.json
```

`--condition` is `cold`, `warm` or `overlap`; label it from the actual controller/cache experiment,
not from inference about guest startup. The optional `CI_PLATFORM_BENCHMARK_CONDITION` records a
known condition and causes comparison to reject mismatched labels. Neither a condition label nor
the visible CPU count alone proves cache state or contention. Retain the associated manifests and
host pressure measurements. `tests.server.files[].seconds` is the Vitest JSON assertion window;
it omits `beforeAll`/`afterAll` and is not the full file lifecycle. Use console file durations to
investigate lifecycle delays and whole `phases[].seconds` for performance comparisons.
test-speed.md records the previously optimized test-only seams.

The initial passing pair (builds 2125/2126) and the ineligible warm pair (2131/2130) used exact source
`8f3bfbe85d439cfa7a98841ff8a5a473be43588f`. The warm four-worker check failed the strict dispatch
lifecycle assertion and did not reach the soak or final gates. Retain its evidence; do not compare
its shortened result with a complete check or count that pair toward a worker promotion. The
transactional progress repair requires new exact-source complete four/eight-worker validation.

The development service remains `whombat-dev` under `systemctl --user`; after landing changes use
the existing `~/Services/whombat-dev` deployment and health check in AGENTS.md. CI resource/profile
changes require the CI platform's own drain/install/restart procedure, not a runtime-service restart.
