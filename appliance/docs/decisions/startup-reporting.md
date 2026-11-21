# Manager readiness, failure propagation and durable update reporting (SR decisions)

Workstream: `startup-reporting` (branch `hp/startup-reporting`, from `main` 9506bda). Owns the manager's start-up and
failure path (`manager/internal/daemon`, `broker` listener, `sdnotify`) and the `update.progress` reporting path
(`outbox`, the journal sequence in `journal`/`update`). Builds on MG-11 (local API), MG-16 (recovery manager and the
systemd units), CL-22 (the durable outbox), MG-46/MG-53 (report members). Decisions are `SR-nn`.

## SR-01 READY=1 means the local API accepts connections (2026-09-30)

**Before.** `Run` started every loop, started `Broker.Listen` in a goroutine that only logged its error and sent
`READY=1` at once. Reproduced on 9506bda with the real daemon and a fake `$NOTIFY_SOCKET`: with the socket directory
missing, `READY=1` was sent and the manager kept running and feeding the watchdog without a socket (systemd never
restarted it); a socket another process served at the path was removed and taken over (`os.Remove` before
`net.Listen`; the manager answered on it); once, a socket removed right after `READY=1` was re-created afterwards (the
broker had not bound yet).

**Now.** `Run` loads the journal, then binds the socket synchronously (`broker.Server.Bind`), reconciles the outbox
(SR-07), starts the loops and the server, and only then sends `READY=1` (`STATUS=whombat-manager <version> (normal|
recovery)`). Essential for readiness are the journal and the local API only: the runtime, control, TUF and the
network are not waited for (the appliance runs offline), nor the first engine step. A failure before readiness
returns at once with nothing started.

`Bind`: a socket file whose listener refuses connections (`ECONNREFUSED`: a manager that died) is replaced, and one
that is gone by the time it dials (`ENOENT`) counts as absent. One that accepts is another manager's and is left alone
(`ErrSocketInUse`), as is one whose listener's backlog is full: a unix socket then refuses at once with `EAGAIN` (it
doesn't wait), which means someone listens; the 1 s dial timeout only bounds a dial that hangs otherwise. Anything
that is not a socket is never removed. The socket is `0660` as before (MG-11).

`READY=1` is not sent when `Run`'s context ended before it got there (the local API failed at once, or a stop
arrived during start-up).

## SR-02 A failed local API stops the manager; a normal stop is clean (2026-09-30)

`broker.Server.Serve` returns an error when its listener fails or when its socket file is removed or replaced
(`ErrSocketLost`, checked every 5 s by comparing the file with the one it bound: device and inode; `/run` is a tmpfs,
whose inode numbers are not reused soon) — in both cases the runtime can no longer reach the manager. `Run` then
cancels every loop (`context.WithCancelCause`), puts the failure in the status line (`STATUS=stopping after a
failure: …`; no `STOPPING=1`, so only the exit status speaks to systemd), waits up to `DrainTimeout` (20 s, below
systemd's stop timeout) and returns the failure: `whombat-manager` exits 1, systemd restarts it
(`Restart=on-failure`, 5 s) and after five failures in ten minutes starts the recovery manager (`OnFailure=`, MG-16).
The recovery manager (`Type=simple`, `Restart=always`) exits 1 the same way and is restarted. A stop (SIGTERM) that
arrives after the failure but before `Run` looked doesn't turn it into a clean stop: the failure is `run`'s cause
unless the parent context ended first (`failureOf`).

**Watchdog.** The engine loop pings after every step and waits at most `WatchdogSec/2`, so at a failure its last ping
is up to `WatchdogSec/2` plus one step's duration old. `Run` pings the watchdog itself while it drains, at once and
every `WatchdogSec/2`, until `Run` returns (at most `DrainTimeout` later). Without that, a failure drain could outlast
the watchdog — with the VM test's `watchdogSec = 20`: up to 10 s since the last ping, plus the step, plus up to 20 s of
drain — and systemd would kill the manager with `SIGABRT` (result `watchdog`) and restart it all the same, only
recorded as a hang. Shortening the drain below `WatchdogSec/2` was the alternative; it can't account for the step
time, and the pings hide no hang for longer than the bounded drain (a loop hung before the failure stops pinging as
before).

**Units.** `whombat-manager` is ordered `After=whombat-manager-recovery.service` (`nix/modules/manager.nix`): with
`Conflicts=` alone, starting the manager doesn't wait for the recovery manager to stop, so the manager could find its
socket still served (`ErrSocketInUse`), exit 1 and count a restart. With any ordering between the two, systemd stops
the one before it starts the other, in both directions; the recovery unit orders only on `whombat-persist.target`, so
there is no cycle.

**Boot assessment.** `whombat-boot-assess` blesses a new host generation only while `whombat-manager` has
`NRestarts=0` (`nix/modules/boot.nix`). A local API failure now restarts the manager, so during the assessment it fails
the boot and the host update is rolled back (boot counting). Intended: a generation whose manager cannot keep its API
socket is broken — before SR-02 such a manager kept running without its socket and passed the assessment. The
transient causes that aren't a broken generation don't restart it: the recovery manager still serving the socket is
ordered away (above), and a second manager started by hand is refused, not restarted.

A normal stop (the context ends: SIGTERM/SIGINT) sends `STOPPING=1` and returns nil, also when a loop does not stop
within `DrainTimeout` (logged): a slow loop on shutdown must not mark the unit failed and start the recovery manager.
The server shuts down gracefully (3 s for requests in flight, then closed) and removes its socket file — unless
another process's file is at the path by then (checked again at the stop, not only every 5 s), which it leaves alone
(`SetUnlinkOnClose(false)`).

Loops that end by themselves (licence without keys, the claim lease once claimed) are not failures. The engine loop
stays the watchdog heartbeat; recovery-mode restrictions (MG-16) are untouched.

## SR-03 Every persisted state's report is recorded before the manager goes on (2026-09-30)

**Before.** `onTransition` sent the state to a 64-slot channel without blocking and dropped it when the channel was
full ("best effort"); only what `progressLoop` took from the channel reached the outbox. The loop blocks while it sends
(up to the 30 s client timeout) or pushes facts, so a burst of transitions was lost. Reproduced on 9506bda: with
`update.progress` hanging at control and 200 lock transitions, an update ran to Healthy while the outbox held only the
factory release's report — no report of the update at all. A crash between the journal write and the loop's outbox
write lost the report too.

**Now.** `Engine.persist` calls `OnTransition` right after the journal write; the daemon builds the report and writes
it to the outbox synchronously (a local, atomic write — never the network), then signals the progress loop through a
coalescing wake (capacity 1: the outbox holds every report, the wake only says "look"). Control being slow or away
therefore never holds up an activation or a rollback, and no report exists only in memory. Facts are pushed to the
runtime after each wake (built from the journal at send time, as before).

## SR-04 Report identity and order; unchanged and stale reports (2026-09-30)

Each report carries the sequence number of the journal record it was built from (`journal.LoadSeq`/`SaveSeq`,
`update.State.JournalSeq`, not persisted in the state). The journal keeps that sequence monotonic across restarts and
manager versions; after a lost newest record it falls back by one (SR-07 handles that).

The outbox remembers, per release, the newest report it recorded (sequence and a content hash without `at`):

- **Stale**: a report older than that (two states persisted concurrently — the engine loop, `Offer` in the control
  loop and the broker's lock endpoints all persist — whose reports arrive in the other order) is ignored.
- **Unchanged**: a report identical to it (a maintenance lock, a hold, a same-phase save that changes nothing
  reported) is not queued again, also after control accepted it. Old managers re-sent such reports on every lock,
  which re-opened `device_update_failed` alerts an operator had resolved.
- Pending reports go out one at a time in journal order (entries from before SR-04, without a sequence, first) and
  are removed only when control answers 2xx (or refuses permanently with a 4xx, as before: CL-22).

Delivery is at least once: a lost answer, or a crash after control took a report but before the outbox recorded it,
sends it again, before anything newer. Control's `recordProgress` takes such a report twice without effect (SR-09).

## SR-05 Terminal reports are retained; intermediate progress is coalesced (2026-09-30)

Intermediate progress (Assigned … Verifying, and refreshes of them) is reconstructable from the journal: a later report
of the same release replaces it — the per-release coalescing CL-22 had. Terminal reports (Healthy, Failed,
RolledBack, Quarantined, ForwardRepairRequired: `outbox.Terminal`) are retained, each until control accepted it,
identified by release, assignment sequence, state, attempt and failure (and current release); only a later report
with the same identity replaces it (fresher details). So `RolledBack` followed by a reassignment's progress, or the
failures of successive attempts, all reach control in order; a terminal report still supersedes the release's pending
intermediate one. This holds while managers that know these rules run; an older manager never rewrites this file
(SR-10).

## SR-06 Bound: 64 reports; terminal reports go last and never silently (2026-09-30)

The outbox holds at most `outbox.MaxEntries` = 64 pending reports (a few KiB each at most) and remembers the newest
report of the 32 most recent releases. Over the bound it evicts the oldest intermediate report (logged as a warning);
only when nothing but terminal reports is left does it evict the oldest terminal one — returned to the daemon, logged
as an error with its identity, and counted in the file (`dropped`). An evicted report is also forgotten as its
release's newest (the mark keeps its sequence, loses its content): otherwise the same state — a report evicted the
moment it came, when 64 terminal reports were pending — would count as unchanged, at the next transition and at the
start-up reconciliation too, and never be queued again. So the same state is queued again once there is room, and the
journal's own state at every start. Filling 64 terminal reports takes dozens of assignments while control refuses
every report; the newest states are the ones control needs.

## SR-07 Start-up reconciliation (2026-09-30)

Before any loop can persist a new state, `Run` builds the report of the journal's newest state and hands it to
`Outbox.Reconcile`: recorded before (same content) → nothing; not recorded (the manager died between the journal write
and the outbox write, the outbox is missing, corrupt or from an older manager) → queued, so no persisted state stays
unreported. If the outbox knows reports newer than the journal (the journal lost its newest record and fell back),
those go first and the journal's state after them, recorded again. A corrupt or unreadable outbox starts empty (logged);
the journal is the source of truth for the current state, the outbox for reports control has not taken.

## SR-08 A failed outbox write is surfaced, never taken as reported (2026-09-30)

The outbox keeps its state in memory and writes the whole file atomically after each change. When a write fails, the
change stays in memory (the report is still sent), `Put`/`Done` return an error wrapping `outbox.ErrNotDurable`, the
daemon logs it at error level and adds `update reports not saved: <operation>: <error>` to the unit's status line
(`systemctl status whombat-manager`); the next successful write (any transition, a sent report, or the progress
loop's retry) clears both. Both change only when the failure does — its operation and error number, e.g.
`rename: file exists` — not on every attempt: an atomic write's error names a new temporary file each time, so the
full text never repeats (it is in the one log record; the status line carries no file names). A report is only
removed after control accepted it — never because a write failed. The activation and rollback go on regardless: the
journal, not the outbox, gates them.

## SR-09 Control orders late and repeated reports (control CL-113, 2026-09-30)

Checked against control `recordProgress` (main 3ed1b7d) with a throwaway integration test on a real Postgres: a
report sent again in order — the manager's resend after a lost answer or a restart, which comes before anything
newer — left the row unchanged, kept one open `device_update_failed` alert and sent no second mail. A request
processed after its successor did not: control ordered a device's reports of a release by the assignment sequence
only, so a late `Verifying` moved a `Healthy` row back, and a late copy of a failure re-opened and mailed an alert a
newer `Healthy` had resolved. The manager cannot stop a request it gave up on from arriving late.

Lead decision: no contract change (control stays on contracts 0.26.1). Control now orders reports with fields they
already carry (control CL-113, branch `hp/progress-ordering`): by (assignment `sequence`, `at`, rank), where `at`
is the journal record's `UpdatedAt` (whole seconds of the box's wall clock at the journal write; SR-07's reconciled
report and any resend carry the same value) and the rank puts final states above in-progress ones, with a retryable
`Failed` among the in-progress states (the manager retries it at once). The row's state moves only for a report that
is not older; a stale report or an exact resend raises, re-opens, mails and resolves no alert and doesn't set the
device's current release.

**Remaining limitation: the box's clock.** `UpdatedAt` is `time.Now()` at each persist, without a monotonic guarantee.
If the clock steps back during one assignment (an NTP correction, or a host activation's reboot with the clock
behind), control takes the assignment's later reports as older until the clock passes the stored time; with SR-04 not
resending unchanged states, a `Healthy` refused that way shows in control's row only with the next assignment (the
sticky `healthy` fact and `status.report` are right). A manager-side alternative is to make `UpdatedAt` monotonic
(never below the previous record's); not done, since it would also pin the owner-visible time after a clock that ran
ahead.

**The journal sequence stays off the wire (lead decision, 2026-09-30).** Exact ordering would need the journal
sequence (`Entry.Seq`) as a new `UpdateProgressRequest` member. Control validates the report with a strict object
(`UpdateProgressReport` is a `z.strictObject` in control-contracts) and control pins contracts 0.26.1: a newer
manager sending the member to an older control would get a 400, and the manager takes a permanent 4xx as "drop the
report" (CL-22) — it would lose reports, not order them better. Doing it safely needs capability negotiation (the
manager learning which members control takes before sending them, as MG-46/MG-52 do by retrying without them after a
refusal), which isn't worth it for a clock stepping back within one assignment: the sticky facts and `status.report`
stay right. CL-113 is the receiver's mitigation; the journal sequence stays in the outbox (SR-04) only.

## SR-10 Older managers keep their own outbox file (2026-09-30; amends SR-05, SR-06)
Superseded by MG-124 (HE-52): one outbox file, no copy for older managers.

An older known-good manager (MG-16: the recovery manager execs the `whombat-manager` of a previous host) reads
`journal/progress-outbox.json` and rewrites it by the rules before SR-04 — one report per release, at most 16, no
marks or sequences. Sharing that file, it silently lost terminal reports (21 pending became 16 after its first report).

Now the outbox lives in `journal/progress-outbox-v2.json` (`outbox.OpenCompat`); `progress-outbox.json` is a copy for
older managers, written after every successful write of the new file: the pending reports in the older format, with
their serials. What an older manager sees there is every report still pending, which it sends at start (its outbox
flushes first) and may coalesce or trim by its own rules once it records reports of its own — only in the copy: the
new file keeps every report, and a manager with SR-10 sends them all again when it runs again (control takes a report
twice without effect, CL-113). If the box stays on an older manager (a host rollback), the copy was its best view of
the backlog, as the shared file was before.

At start the new manager reads the copy: entries that are its own pending reports (same release, serial and content)
are skipped; anything else an older manager recorded is imported as a report of an unknown journal record (sequence 0,
sent first, not checked for staleness) under the SR-05/SR-06 rules, and the journal's newest state is then reconciled
(SR-07). The copy is rewritten only after the new file is on disk: if that write fails, the older manager's reports
stay in the copy (and in memory, to be sent) and are imported again at the next start. Upgrading from a manager
before SR-04 is the same import: its pending reports move into the new file. A failure to read or write the copy is
logged once (`LegacyErr`); it doesn't make the reports less durable.

## SR-11 Journal writes are serialized and checked against the record they were loaded from (2026-09-30)

**Before.** Every engine mutation loads the journal, changes its copy and saves it: the engine loop's `Step`, the
control loop's `Offer`, and the broker's `AcquireLock`/`ReleaseLock` (the backup agent, the network guard) and
`SetHold`, from different goroutines and without coordination. A mutation that saved after another one had saved
since its load wrote its older copy over it. Reproduced with the engine's crash hook holding one mutation between its
load and its save (`manager/internal/update/concurrency_test.go`, all four failed on the code before): a hold and a
maintenance lock taken at the same time (the lock was lost); an assignment queued while a health check of Verifying
was being saved (the queued assignment was lost, as was its sequence); the same during the step that promotes the
candidate to known-good; and the recovery manager starting a rollback (MG-16) while it queued an assignment.

**Now.** `Engine.persist` takes an engine write mutex (`wmu`), checks that the journal is still at the record the state
was loaded from (`State.JournalSeq` against `Journal.Seq`, the newest record this journal wrote or read) and only then
saves; otherwise it returns `ErrConflict` without writing. The mutex covers the check, the save and `OnTransition`
(so reports are recorded in journal order), nothing else: loading, the network calls between two saves of one step
(`waiting` drains the runtime between its two saves), health checks and helper calls all run outside it.
`OnTransition` must not call back into the engine; the daemon's callback records the report in the outbox (its own
mutex) and updates the status line (the status mutex) — neither is ever held while calling the engine, so there is no
lock cycle.

On `ErrConflict` the mutation is redone from a fresh load: `Offer`, `SetHold`, `AcquireLock` and `ReleaseLock` retry
(up to 20 times; their only effect before the save — resuming a drained runtime — is idempotent; the assignment file
is written by the save itself, SR-12), and `Step` returns at once with no wait, so the engine loop steps again from
the journal. Five lost steps in a row back off (100 ms more each, at most 5 s) and log a warning, so a step that can't
win never spins silently while feeding the watchdog. `Journal.LoadSeq` follows the newest *readable* record: when the
newest one became unreadable while the manager ran, the next save goes on from the one before (as before SR-11)
instead of every save conflicting with a record nobody can read. A step dropped
that way is a crash at that point, which the engine is built for (every effect idempotent, the crash and kill tests);
its effect is simply redone. Recovery mode and the known-good promotion go through the same path. An optimistic check
was chosen over holding a lock for a whole step: a step waits on downloads, drains and health checks, and the
broker's lock endpoint and the control loop must not wait for those.

## SR-12 The assignment file is written with the save that records its candidate (2026-09-30; amends SR-11)

The helper checks the signed assignment file at activation and refuses a release it doesn't name (`not_assigned`,
retryable). `Offer`, starting a queued assignment and a reassignment after a verification failure used to write the
file before the journal save; with SR-11 that save can lose, and `Offer`'s redo may then only queue the assignment,
leaving the file naming it while the journal's candidate is another release: the engine would fail with
`not_assigned`, retry, drain the runtime again, and so on until control delivered the assignment again at a quiet
moment (the review's probe: an offer that loses to the step starting the drain window).

The candidate now carries its signed assignment (`Candidate.AssignmentRaw`, a new optional journal member; older
managers ignore and drop it). `persist` writes the file from the candidate being saved, under the write mutex, after
the sequence check and before the journal save, and only when it differs — so the file never names an assignment
whose save lost. Every step first compares the file with the journal's candidate and writes it again if they differ
(logged): after a crash between the file write and the journal save, or a failed save, the file follows the journal
before the helper is asked to act. A journal without the member (written by an older manager) is left as it is.

## SR-13 An activation step keeps its save over a hold, a lock or an assignment (2026-09-30; amends SR-11)

Dropping a lost step is a crash at that point only for effects that may run twice. The activation's are not quite
that: `activating` switches and restarts the runtime (`OpActivateRuntime`) and, dropped, would do it again at once and
may then probe a runtime that isn't answering yet; `reconcileHost` re-activates the known-good tuple. So a step keeps
its save when the concurrent change touched only the fields `Offer`, the hold and the maintenance lock own — the
hold, the lock, the queued assignment, the last assignment sequence, the time floor and the candidate's assignment
(sequence, not-before, signed assignment): it takes those from a fresh load and saves. Only when:

- the step is one of the activation (loaded in Activating or Verifying, the recovery manager's rollback included) or
  `reconcileHost` after its helper call — these read none of those fields (a lock can't even be taken then);
- the step itself changed none of them;
- nothing else changed: the state as loaded and as now are equal without those fields (a digest of each, taken at
  load).

Otherwise it is dropped as before. Steps before the activation are always dropped on a conflict: they decide by the
hold and the lock (`blocked`: no drain window or activation while a backup holds the lock), so merging a lock taken
meanwhile could activate under it; they have no effect that must not run twice.

