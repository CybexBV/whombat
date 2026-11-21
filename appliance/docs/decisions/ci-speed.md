# CI validation speed (2026-09-30)

## CS-01 — Reuse successful repository gates at exact inputs

Repository gate successes may be reused locally for seven days when the repository,
exact commit, argv, working directory, gate environment, timeout, PostgreSQL requirement,
tool/setup fingerprint and runner implementation match. The private cache lives under
`WB_MGD_HOME/gate-cache`, retains at most 256 receipts, and includes the original log and
its SHA-256. Missing, malformed, expired or damaged evidence means execute the gate.
Failures are never saved and a fresh failure invalidates an older matching receipt. Reports explicitly identify reused successes and their original
time and duration; reuse does not refresh a receipt's age.

The harness checks, terms comparison, cross-repository scenarios, demonstration, skew
checks and VM upgrade gates still run under their existing rules. `harness/validate
--no-gate-cache` and `release/ship validate --rerun-gates` force repository gates to execute.
No existing release evidence is imported into this cache. The first run is cold.

The process runner must finish writing its log before returning a command result, so a
saved success includes the complete output and exit footer.

## CS-02 — Independent scenario appliances

A full fresh pinned local validation defaults to three scenario groups: the baseline
suite, `i-updates`, and `l-link`. Each isolated file provisions its own clean appliance,
database container/volume, service ports, keys, fixtures and deterministic persona email
suffix. Mailpit is shared without reading another group's magic link. Files within the
baseline retain their existing order. Every file is included once.

The isolated environments use `<WB_MGD_HOME>-scenarios-1/2`, containers with the same
suffix, and **ports +200/+300**. Keep these ports free; +100 remains reserved for the
existing live-agent environment. Isolation avoids sharing writable clone/build output
between groups. Groups validate the same pins and candidate manifest, retain reports
and logs, and purge only their own environment when finished. Missing/wrong reports,
process failures and cleanup failures fail the combined validation.

`--scenario-jobs 1` retains serial execution; `2` isolates updates only. Partial selections,
reused environments, live sources/agents and public instances stay serial. Shipping's
`--serial` also selects one scenario group. This escape hatch matters for timing-sensitive
performance tests and hosts without enough memory for three environments.

The offline licence scenario uses the existing trusted manager clock push to cross signed
token expiry and grace boundaries. Real verification, a real agent turn in grace, lapse
enforcement, persistence across restart/clock rollback, and renewal remain tested. The
production clock and renewal rate-limit intervals are unchanged.

## CS-03 — Test the appliance Go module once

The root `go vet ./...` and `go test -count=1 ./...` already include backup and
provisioning (and helper, console, recovery, release-tools and vaultwall). When the
selected root check succeeds at the same repository/commit with identical argv,
environment, timeout and PostgreSQL requirement, the matching subdirectory checks
are marked **covered** and retain the root check's log/provenance. A failed or
unselected root check, different commits or different inputs run the subset checks
normally. Roots start before dependent subsets, alongside other repository checks.
No pins or release build inputs change; existing release evidence remains usable.

## CS-04 — Estimates need the next scheduled measurement

The measured pre-change validation took 27m19s. Licence and update files consumed roughly
6m53s and 5m49s in a serial scenario stage; repository gates repeated unchanged checks.
The estimated warm-cache validation is 7–12 minutes (about 15–20 minutes saved), subject
to baseline scenario timings and contention. Dedicated fast workers and distinct writable
caches also remove observed queue/cache-lock waits, which are separate from execution
time. These are projections; no full release flow was launched to benchmark this change.

Focused verification: Biome/typecheck and 135 harness unit tests passed; the shared CI
controller's 41 tests, shellcheck, Compose validation and Buildbot checkconfig passed.
Updates (7 tests) and licence (10 tests) ran together in separate fresh environments,
including cold setup and cleanup, in **6m50s**. All four performance scenarios passed
in a third environment while those groups were running. All three temporary database
containers/volumes and service groups were removed. The offline licence test took
122 seconds, including real renewal rate-limit waits; its old 150 seconds of expiry/grace
sleep are eliminated. These focused runs do not replace the next full-flow measurement.
A real root `go vet ./...` passed in a focused cold run, then reused its checksum-verified
receipt/log without rerunning the command; both partial validations passed.

## CS-05 — Go tests run side by side and wait for events (2026-11-13)

`go test -race -count=1 ./...` took over six minutes of fast-test's full run (7m21s on The Titan), nearly all in
`manager/internal/daemon` (47 tests, one after another, waiting on real timers: 372 s for 70 s of CPU) and
`manager/internal/update` (190 s with the race detector, on two cores). More CPUs changed nothing.

- **Tests that share nothing call `t.Parallel()`** (daemon, update, broker, `helper/internal/ops`, voice): each has its
  own world, sockets and servers. A test stays serial when it changes the process: `$NOTIFY_SOCKET` and
  `$WATCHDOG_USEC` (`listenNotify`), a count of the process's goroutines (`noLeaks`), a package hook
  (`broker.SetBeforeDial`), or a timing it measures (the heartbeats during a 300 ms collection, the support watch's
  looks). A new test that sets an environment variable or a package variable is serial too.
- **The daemon's fixed waits are `Daemon.Waits`** (first status.report, its settle time, the first update.progress
  retry, the least time between claim.lookup calls, how long a second of the licence's `renewAfterS` lasts). `New`
  sets `DefaultWaits`, the values they had; the test harness shortens them (`quickWaits`). Intervals the configuration
  sets (`pollSec`, `runtimeProbeSec`, …) stay whole seconds: a test that needs a probe to pass waits a second and a half.
- **The harness shortens go-tuf's wait before a retry** (2 s in the manager, 10 ms in tests; still one retry): every
  refresh asks for the next root version and gets a 404, which go-tuf retries like any failure. The manager still
  spends those 2 s in every refresh (a check, an accepted assignment); not changed here.
- **`testworld` builds the standard repository once in a process** and copies its files into each world at `T0`
  (worlds share their development keys; each has its own files). The daemon tests' worlds (real clock) build their own.
- A wait for something that must happen is an `eventually` with patience; a short fixed sleep is only for what must not
  happen.

Measured on The Falcon (12 of its CPUs, `taskset`), Go 1.26.8 as on The Titan: the whole repository with `-race` in
59 s; daemon 369 s → 22 s (37 s with `-race` beside the other packages), update 190 s → 48 s with `-race`, broker
37 s → 19 s, `helper/internal/ops` 22 s → 6 s. With Go 1.27.2 (The Falcon's own) the race detector costs about twice as
much in these tests (108 s for the repository). The touched packages passed five times with `-race`, and the whole
repository twice side by side, three times. On The Titan (12 CPUs) fast-test's full run, with vet, the harness and the
console checks, went from 7m21s to 1m26s: update 54 s, daemon 41 s, broker 21 s.
