# GitHub polling and integration-test speed (PL-01…PL-08)

Stream SG of the 2026-10-07 improvement review (`docs/implementation/improvement-review/report.md` A1-8, A2-4, A2-8).
The poller read every switched-on repo every 30 s, 24/7, at 1 + 2·P requests a read (P open PRs: the open-PR list,
then check runs and reviews per PR); a head without check runs never got `checks_handled_sha`, so it was looked at on
every read forever; CI results reached the agent waiting on them 30–60 s late; and every integration-test file ran all
84 migrations into its own database. Amends G-06, G-08 and G-09 (`github-gh.md`) and the “one poll (30 s)” of HW-01
(`health-checks-wake.md`). No migration, no contract change.

| # | Decision | Reason |
| --- | --- | --- |
| PL-01 | **Superseded in part by one-person.md OP-S14**: the cadences hold, and “active” is read from the box's own record of the person's connections, not presence frames. **Each repo is read on a cadence of its own** (`github/poll-cadence.ts`, pure; `pollCadence`): **fast, 10 s** while an agent's work is live there — a run on the repo is `live` and needs no person (`attention` null), a push token for the repo was handed to an agent's runner in the last 10 minutes (`github_push_grants.issued_at`, unexpired), a deploy of it is `dispatched`/`running` and was dispatched in the last hour, or an agent's own open pull request there (`author_id` an agent, not a system principal) has a head whose checks aren't handled yet and moved in the last hour; **active, 30 s** while a person of the burrow is `active` in the presence tracker (Whombat open and used in the last 10 minutes); **idle, 3 min** otherwise. The poller decides the cadence after every read of the repo (one statement with four `exists`, plus the in-memory presence) and keeps a schedule in memory (`plans`: last read, cadence, wake); a timer runs a tick when the earliest repo is due (repos due within 1 s go together; at least 1 s between ticks; at most the idle cadence apart, the active one while anyone is active). `pollNow` (Sync repos, demo, tests) still reads every repo at once. | The 30 s was a compromise between the agent waiting on CI (too slow) and a box where nothing happens all night (too often). Everything that needs speed is either an agent's live work, which Whombat knows, or a person looking. ETags keep the fast reads free of rate limit. |
| PL-02 | **A head without check runs is handled after a later poll still finds none, a minute on** (`noChecksAfter`, `readChecksNow` in `poll-plan.ts`). The poller remembers an empty answer for a head next to its ETag in the poll cursor (`checks:<n>:<sha>:none` = `<since>/<checkedAt>`, pruned with the head like every key); a read at least `NO_CHECKS_SETTLE_MS` (60 s) after the first empty answer that still finds none sets `checks_handled_sha` to the head (an operational write like `markLocalOnly`, only while the PR is still on that head). From then on the head's check runs are asked only every idle cadence (3 min) and on the refresh, and its stored checks are no longer read for HW-01. **Runs that appear on a head handled this way lift the mark** (only then: the previous answer was empty), so their round wakes the agent when it finishes; a re-run on a head handled after its finished round still wakes nobody (HW-03). | “After the first unchanged poll” at 10 s would mark heads whose CI simply hadn't registered yet; GitHub creates check runs within seconds, a minute covers a slow start. Without the mark the head was polled and queried forever and, with PL-01, would keep an agent's repo fast forever. Late CI (a workflow waiting for approval, a re-run, a slow CI app) is still seen, at most one idle cadence later. |
| PL-03 | **Integration-test databases are copies of a template** (`test/db.ts`): `whombat_tpl_<hash>`, where the hash covers the migrations (journal, SQL files, `compat.json`) and the code that applies them (`migrate.ts`, `compat.ts`, `backfills.ts`). The first file that needs it builds it under a session advisory lock on the base database (`0x57485450`, “WHTP”; others wait with `pg_try_advisory_lock`), as `whombat_tplb_<hash>_<random>` renamed when migrated (a crashed build is never used), with `allow_connections false` (cloning needs it untouched) and a comment `built <ms>`. Every file then runs `create database … template …`; a template another run dropped meanwhile (`3D000`) is built again. When a new template is built, templates of other hashes built over an hour ago and unfinished builds are dropped. | Every file migrated 84 migrations: 250–290 ms alone, ~530 ms with eight files at once. A copy is 70–190 ms. Several worktrees share the Postgres on `:55432`, so the lock spans suites, the hash keeps branches with other migrations apart, and the hour keeps one branch from dropping a template another run is using. |
| PL-04 | **The refresh without ETags (G-08) runs on the idle cadence only** (`refreshDue`): every 10 minutes on a read at the idle cadence; a repo that stays fast or active takes it after 30 minutes at the latest. | “The forced refresh stays, but only on the slow cadence”: the fast reads stay conditional (free), and a burrow where someone is active all day is still re-read in full twice an hour. |
| PL-05 | **Configuration**: `WHOMBAT_GITHUB_POLL_MS` keeps its meaning and default (30 000) and is the active cadence; `WHOMBAT_GITHUB_POLL_FAST_MS` (10 000) and `WHOMBAT_GITHUB_POLL_IDLE_MS` (180 000) are the others. The fast one is never slower and the idle one never faster than the active one, 0 makes either the active one, and `WHOMBAT_GITHUB_POLL_MS=0` still means the poller never runs on its own (tests). | Existing settings keep working; an operator can flatten the cadences (`…_FAST_MS=0 …_IDLE_MS=0` is the old fixed 30 s). Three minutes is the middle of the 2–5 min range: what nobody is looking at and no agent waits on is seen within 3 min, and a person who comes back wakes their repos at once (PL-06). |
| PL-06 | **Superseded in part by one-person.md OP-S14**: the wakes hold; the person becoming active is read from the box's own record of their connections, not a `presence` frame. **What wakes a repo** (due at once, never sooner than 2 s after its last read, debounced 250 ms): a push token handed out (`GitHubService.recordPushGrant`), an approved deploy dispatched (`DeployExecutor.execute`), a repo added (`repos.add`), and from the bus after their commit — a `run.updated` frame of a run that goes live (once per run), a `pr.updated` frame of a merged PR (once per PR), a `presence` frame of a person becoming active (their burrow's idle repos go to the active cadence). A repo switched on in Settings is found by the next tick (at most 30 s while its person is active). | The assignment's “a person merges, a run starts, a push grant is issued”; frames are published after the commit, so the poll that follows sees the change. Push grants and deploys aren't commits, so their own code wakes the poller. |
| PL-07 | **The schedule lives in memory**, per server process like the poller (G-06): after a restart every repo is read once (all are due), then on its cadence; nothing new is stored but the PL-02 marker in the existing cursor. | It is a cache of things Whombat can work out again in one read. |
| PL-08 | **A head handled without checks is no “checks to come” for a run** (HW-06 `checksToCome` reads `checks_handled_sha`): a run on a pull request whose head has no check runs is stalled as RC-11 intends once the head is handled (the turn that pushed still counts its next round, as before). Stored checks left `queued` by a head move no longer keep such a run waiting forever. | The stall wake tells the agent to schedule when nothing will wake it; a head without CI is exactly that. |

## Numbers

Requests per read of a repo: 1 (open PRs) + 2 per open PR (checks, reviews) + 1 per agent branch with a live push
grant and no PR + 1 while a deploy is in flight. With five open PRs: 11. Counted against the rate limit are only
answers other than 304: the refreshes and real changes.

| State, one repo, five PRs with CI | Reads/h | Requests/h | Counted/h (refreshes) | DB statements/h (≈) |
| --- | --- | --- | --- | --- |
| Before PL-01, any state | 120 | 1 320 | 66 | ~1 100, +120 per head without a handled round |
| Idle (nobody active, nothing live) | 20 | 220 (−83 %) | 55 | ~200 |
| A person active | 120 | 1 320 | 22 | ~1 200 |
| Fast (a run live, a fresh push, a deploy, an agent PR's checks) | 360 | 3 960 | 22 | ~3 600 |

Measured by `github/poll-cadence.int.test.ts` (“an hour of polling”: a test clock stepped from tick to tick for an
hour per state against FakeGitHub, counting its reads). The report's example of 3 repos × 5 PRs, 24/7, was
3 × 1 320 = 3 960 requests an hour (≈ 200 counted); idle it is now 660 (165 counted), with a person active 3 960
(66 counted), and only a repo where an agent's work is live reads every 10 s. A repo without CI on its PRs drops
further: its heads' checks are asked every 3 min once handled (PL-02), e.g. five PRs at the active cadence
120 × 6 + 20 × 5 = 820 requests/h instead of 1 320. DB statements: a read is the cursor, the open PRs, branches,
deploys, the cursor update and now one cadence statement (`signals`), plus 3–4 for the targets per tick; the
`pr_checks` read per unhandled head is gone for heads without checks.

**Checks wake latency (HW-01).** The wake goes out on the first read that finds the finished round unchanged, i.e.
the second read after the last result: 1–2 cadences. A run waiting on CI, or an agent's own PR (within an hour of its
head moving), is on the fast cadence: **10–20 s** after GitHub has the result, against 30–60 s before (the test
measures the worst case, results just after a read: 20 s now, 60 s with the old fixed 30 s). Without anything live the
round is seen at the active (30–60 s) or idle (3–6 min) cadence, but then nobody is woken (HW-04). CI that starts more
than a minute after the head on a head already handled without checks (PL-02) is seen up to 3 min later, then on the
fast cadence again.

**Integration tests (PL-03).** Creating a test database (the shared Postgres 17.11 on `:55432`, timed by a script
that calls each tree's `createTestDb`):

| | Migrate from empty (before) | Copy of the template (after) |
| --- | --- | --- |
| One alone | 250–290 ms | 72–187 ms |
| Eight at once, median (24 databases) | 499–527 ms | 156–176 ms |
| WAL written per database | ~8 MB | ~6 MB (`WAL_LOG`, the default; `FILE_COPY` is 1.5 s: two checkpoints) |
| The suite's 254 databases, 8 at a time, create + drop | 20.2–28.4 s wall, 124–182 s of create time | 8.5–8.7 s wall, 38 s of create time |

So the databases cost the suite 12–20 s less wall time at 8 workers. `pnpm test:server` itself (254 → 255 files with
`poll-cadence.int.test.ts`, 8 workers) was measured on a machine busy with the other streams' builds, an Android
emulator and Gradle, and its wall time is dominated by that load: **before 185.7 s** (`improve` 0acfe320, load
average 6.8; one failure, `automations/engine-lock`, a timing flake under load), **after 204.4 s** (load average
13–14; one failure, `audit/audit.int.test.ts` “concurrent appends”, which fails 2 times in 4 on `improve` as well).
Run side by side for the same load (4 workers each, started together): before 393.3 s, after 397.0 s — the 12–20 s
are within that noise. The saving is the setup's: ~0.34 s per file, 7–10 % of a 185 s run.

## Tests

- `github/poll-cadence.test.ts` (unit): the cadence by signal, the configuration's clamps, when a repo is due (wake,
  gap), the next tick, the refresh rule; PL-02's settle, mark, unmark, idle re-check and the cursor format.
- `github/poll-cadence.int.test.ts` (FakeGitHub, a stepped clock): run / push token / deploy / agent PR checks /
  person / quiet give fast / fast / fast / fast / active / idle; only due repos are read; a wake, a run going live on the
  bus and a person coming back; an hour per state (the table above); the checks wake's latency against the old 30 s;
  a head without checks handled a minute on, not asked for 2 min, then CI starts late, the mark lifts and the run is
  woken; an agent's PR without CI keeps its repo fast only until handled; the real timer polls soon after start and
  after a wake.
- `test/db.test.ts`: the migrations hash is stable and changes with any migration.
- The existing poller, checks wake and run recovery suites run unchanged (`pollNow` reads every repo).

## Known limits

- The schedule is per process (G-06): a second server process polls on its own, as before.
- A repo switched on in Settings (`repos.update`) isn't a wake: it is read on the next tick, within 30 s while the
  person is active.
- Deploys in flight for more than an hour, and agent PRs whose round never finishes (a check that disappeared on a
  new head, `health-checks-wake.md` known limits), fall back to the active or idle cadence instead of 10 s forever.
- A run that is live for days without needing a person keeps its repo at 10 s: conditional reads, free of rate
  limit, but requests nonetheless.
- Template databases (`whombat_tpl_*`) stay on the shared Postgres between runs (a few MB each, one per migrations
  hash in use); they are dropped by the next build of another hash once over an hour old.
