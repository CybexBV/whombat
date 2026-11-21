package update_test

import (
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/helper/pkg/trust"
	"github.com/CybexBV/whombat/appliance/manager/internal/runtimeapi"
	"github.com/CybexBV/whombat/appliance/manager/internal/testworld"
	"github.com/CybexBV/whombat/appliance/manager/internal/update"
	"github.com/CybexBV/whombat/appliance/release-tools/devtuf"
	"github.com/CybexBV/whombat/contracts/go/release"
)

func mustOffer(t *testing.T, w *testworld.World, id string, want update.Decision) {
	t.Helper()
	d, why, err := w.Offer(id)
	if err != nil || d != want {
		t.Fatalf("offer %s: %v %s %v", id, d, why, err)
	}
}

func factoryRunning(t *testing.T, w *testworld.World) {
	t.Helper()
	if got := w.RuntimeProfile(); got != devtuf.FakeStorePath("whombat-runtime-1.0.0") {
		t.Fatalf("runtime profile %s, want factory", got)
	}
	if w.Runtime.Draining() {
		t.Fatal("runtime left draining")
	}
}

func lastFailure(st *update.State) string {
	if st.Record.Failure != nil {
		return *st.Record.Failure
	}
	return ""
}

func TestMigrationExpandThenBadRuntimeRollsBackReadWrite(t *testing.T) {
	t.Parallel()
	w := testworld.New(t)
	mustOffer(t, w, testworld.ExpandBad, update.DecisionStarted)
	w.Run(400, testworld.PhaseIs(update.RolledBack))
	st := w.State()
	if w.Helper.DBSchema() != 11 {
		t.Fatalf("schema %d: the migration must have run", w.Helper.DBSchema())
	}
	if st.Candidate.Failure.KnownGoodAccess != "read-write" || st.Current.ReleaseID != testworld.Factory {
		t.Fatalf("failure %+v current %s", st.Candidate.Failure, st.Current.ReleaseID)
	}
	factoryRunning(t, w)
	// The known-good really runs read-write on the expanded schema (newer_compatible).
	h, _ := runtimeapi.New(w.P.AdminSock, "").Health(t.Context())
	if h.Status != "ok" || h.Checks.Migrations.Access != "read-write" {
		t.Fatalf("known-good health %+v", h)
	}
	retryUntilQuarantined(t, w, testworld.ExpandBad)
}

// retryUntilQuarantined is control assigning a release that failed verification again (“Retry this Whombat”): one
// more attempt after VerifyRetryDelay, then quarantined at the second failure (MG-56).
func retryUntilQuarantined(t *testing.T, w *testworld.World, id string) {
	t.Helper()
	w.Run(400, testworld.AwaitsControl)
	mustOffer(t, w, id, update.DecisionQueued)
	w.Run(600, testworld.PhaseIs(update.Quarantined))
}

func TestMigrationNarrowingRollsBackReadOnly(t *testing.T) {
	t.Parallel()
	w := testworld.New(t)
	mustOffer(t, w, testworld.ReadOnlyBad, update.DecisionStarted)
	w.Run(400, testworld.PhaseIs(update.RolledBack))
	st := w.State()
	if lastFailure(st) != "rolled_back_read_only" || st.Candidate.Failure.KnownGoodAccess != "read-only" {
		t.Fatalf("failure %v %+v", lastFailure(st), st.Candidate.Failure)
	}
	factoryRunning(t, w)
	if w.Helper.DBSchema() != 12 {
		t.Fatal("database must not be rewound")
	}
	// The installed runtime cannot read schema 12 back (release.CheckActivation requiresCheckpoint):
	// a verified checkpoint was taken although no single migration is a contract migration.
	if len(w.Checkpoints.Refs) == 0 {
		t.Fatal("no checkpoint before a rollback-incompatible migration")
	}
}

func TestCheckActivationRefusesCandidateThatCannotReadSchema(t *testing.T) {
	t.Parallel()
	w := testworld.New(t)
	bad := devtuf.StandardRelease("rt-20-noread", "26.05.1", "3.0.0")
	bad.SchemaWrites, bad.SchemaReads = 12, release.IntRange{Min: 11, Max: 12}
	w.Repo.AddFakeRelease(bad)
	w.Repo.Publish()
	mustOffer(t, w, "rt-20-noread", update.DecisionStarted)
	w.Run(100, testworld.PhaseIs(update.Failed))
	if f := w.State().Candidate.Failure; f.Code != "schema_incompatible" || !strings.Contains(f.Message, "candidate_cannot_read_schema") {
		t.Fatalf("%+v", f)
	}
	factoryRunning(t, w)
}

func TestMigrationDiesAfterChangingSchema(t *testing.T) {
	t.Parallel()
	// Known-good can still use the database: Failed, runtime resumed, retried later.
	w := testworld.New(t)
	w.Helper.SetFail("migrate-after", errors.New("migration process killed"))
	mustOffer(t, w, testworld.ExpandBad, update.DecisionStarted)
	w.Run(200, testworld.PhaseIs(update.Failed))
	st := w.State()
	if st.Candidate.Failure.KnownGoodAccess != "read-write" || w.Helper.DBSchema() != 11 {
		t.Fatalf("%+v schema %d", st.Candidate.Failure, w.Helper.DBSchema())
	}
	w.Run(50, func(st *update.State) bool { return !st.Candidate.Failure.ResumeRequired })
	factoryRunning(t, w)

	// Known-good cannot use the database any more: ForwardRepairRequired straight from Activating;
	// the candidate never activated, so the installed release stays current.
	w2 := testworld.New(t)
	w2.Helper.SetFail("migrate-after", errors.New("migration process killed"))
	mustOffer(t, w2, testworld.MigrateBad, update.DecisionStarted)
	w2.Run(200, testworld.PhaseIs(update.ForwardRepairRequired))
	st = w2.State()
	if st.Current.ReleaseID != testworld.Factory || w2.Helper.DBSchema() != 13 || w2.Runtime.Draining() {
		t.Fatalf("current %s schema %d", st.Current.ReleaseID, w2.Helper.DBSchema())
	}
	var from update.Phase
	for _, h := range st.History {
		if h.To == update.ForwardRepairRequired {
			from = h.From
		}
	}
	if from != update.Activating {
		t.Fatalf("entered from %s", from)
	}
}

func TestMigrationPastKnownGoodRequiresForwardRepair(t *testing.T) {
	t.Parallel()
	w := testworld.New(t)
	mustOffer(t, w, testworld.MigrateBad, update.DecisionStarted)
	w.Run(400, testworld.PhaseIs(update.ForwardRepairRequired))
	st := w.State()
	if lastFailure(st) != "forward_repair_required" || st.Record.State != update.ForwardRepairRequired {
		t.Fatalf("record %+v", st.Record)
	}
	if w.Helper.DBSchema() != 13 {
		t.Fatal("database must not be rewound")
	}
	// No rollback happened: the candidate (the only runtime that can read the database) stays.
	if w.RuntimeProfile() != devtuf.FakeStorePath("whombat-runtime-2.0.0-bad") || st.Current.ReleaseID != testworld.MigrateBad {
		t.Fatalf("profile %s current %s", w.RuntimeProfile(), st.Current.ReleaseID)
	}
	if st.KnownGood.ReleaseID != testworld.Factory {
		t.Fatal("known-good must stay the factory tuple")
	}
	if w.Runtime.Draining() {
		t.Fatal("runtime left draining")
	}
	// Nothing happens on its own; re-assigning the same release is refused.
	for i := 0; i < 5; i++ {
		w.Engine.Step(t.Context())
		w.Clock.Advance(time.Hour)
	}
	if st := w.State(); st.Phase != update.ForwardRepairRequired {
		t.Fatalf("left forward repair on its own: %s", st.Phase)
	}
	if d, _, _ := w.Offer(testworld.MigrateBad); d != update.DecisionRefused {
		t.Fatalf("re-offer: %v", d)
	}
	// Only a fix-forward assignment leaves the state: ForwardRepairRequired -> Assigned.
	mustOffer(t, w, testworld.ForwardFix, update.DecisionStarted)
	w.Run(400, func(st *update.State) bool {
		return st.Phase == update.Healthy && st.Current.ReleaseID == testworld.ForwardFix
	})
	if w.Helper.DBSchema() != 13 {
		t.Fatalf("schema %d", w.Helper.DBSchema())
	}
}

func TestContractMigrationTakesVerifiedCheckpointWhileQuiesced(t *testing.T) {
	t.Parallel()
	w := testworld.New(t)
	mustOffer(t, w, testworld.Contract, update.DecisionStarted)
	w.Run(400, testworld.PhaseIs(update.Healthy, update.Failed))
	st := w.State()
	if st.Phase != update.Healthy || st.Current.ReleaseID != testworld.Contract {
		t.Fatalf("phase %s", st.Phase)
	}
	if len(w.Checkpoints.Refs) != 1 || !w.Checkpoints.WhileDrained[0] || !strings.HasPrefix(w.Checkpoints.UnderDrain[0], "drain-") {
		t.Fatalf("checkpoint %v while drained %v underDrain %v", w.Checkpoints.Refs, w.Checkpoints.WhileDrained, w.Checkpoints.UnderDrain)
	}
	found := false
	for _, e := range w.Helper.Events() {
		if strings.HasPrefix(e, "migrate ") && strings.Contains(e, `checkpoint="ckpt-rt-11-contract"`) {
			found = true
		}
	}
	if !found {
		t.Fatalf("migration did not use the checkpoint: %v", w.Helper.Events())
	}
}

func TestCheckpointUnavailableDefersWithoutChanges(t *testing.T) {
	t.Parallel()
	w := testworld.New(t)
	w.Checkpoints.Fail = errors.New("backup destination unreachable")
	mustOffer(t, w, testworld.Contract, update.DecisionStarted)
	w.Run(60, func(st *update.State) bool {
		return st.Phase == update.WaitingForSafeBoundary && st.Candidate.Deferral != nil && st.Candidate.Deferral.Waiting == "checkpoint" && !st.Candidate.Deferral.Draining
	})
	st := w.State()
	if !strings.Contains(st.Candidate.Deferral.Explanation, "verified checkpoint") || w.Helper.DBSchema() != 10 {
		t.Fatalf("explanation %q schema %d", st.Candidate.Deferral.Explanation, w.Helper.DBSchema())
	}
	factoryRunning(t, w)
	w.Checkpoints.Fail = nil
	w.Run(400, testworld.PhaseIs(update.Healthy))
}

func TestUnapprovedIncompatibleAndQuarantinedAssignmentsRefused(t *testing.T) {
	t.Parallel()
	w := testworld.New(t)
	if _, _, err := w.Offer("rt-not-approved"); !errors.Is(err, trust.ErrNotApproved) {
		t.Fatalf("unapproved: %v", err)
	}
	if _, _, err := w.Offer(testworld.Incompat); !errors.Is(err, trust.ErrIncompatible) {
		t.Fatalf("incompatible: %v", err)
	}
	st := w.State()
	if st.Phase != update.Healthy || st.Candidate != nil {
		t.Fatalf("state changed: %s", st.Phase)
	}
	factoryRunning(t, w)
}

func TestHoldAndMaintenanceWindowPreventActivation(t *testing.T) {
	t.Parallel()
	w := testworld.New(t)
	mustOffer(t, w, testworld.RuntimeGood, update.DecisionStarted)
	if d, _, err := w.OfferHold(); err != nil || d != update.DecisionHold {
		t.Fatalf("hold: %v %v", d, err)
	}
	w.Run(100, func(st *update.State) bool {
		return st.Phase == update.Staged && st.Candidate.Deferral != nil && st.Candidate.Deferral.Waiting == "hold"
	})
	for i := 0; i < 20; i++ {
		w.Engine.Step(t.Context())
		w.Clock.Advance(time.Hour)
	}
	if st := w.State(); st.Phase != update.Staged {
		t.Fatalf("activated during hold: %s", st.Phase)
	}
	factoryRunning(t, w)
	// A new install assignment lifts the hold.
	mustOffer(t, w, testworld.RuntimeGood, update.DecisionNoop)
	w.Run(200, testworld.PhaseIs(update.Healthy))
}

func TestMaintenanceLock(t *testing.T) {
	t.Parallel()
	w := testworld.New(t)
	if _, err := w.Engine.AcquireLock("backup", "nightly checkpoint", time.Hour); err != nil {
		t.Fatal(err)
	}
	mustOffer(t, w, testworld.RuntimeGood, update.DecisionStarted)
	w.Run(100, func(st *update.State) bool {
		return st.Phase == update.Staged && st.Candidate.Deferral != nil && st.Candidate.Deferral.Waiting == "lock"
	})
	if !strings.Contains(w.State().Candidate.Deferral.Explanation, "backup holds maintenance") {
		t.Fatal(w.State().Candidate.Deferral.Explanation)
	}
	w.Engine.ReleaseLock("backup")
	w.Runtime.SetBlockers([]runtimeapi.Blocker{{Kind: "turn", ID: "t1", Description: "long turn", Since: "2026-09-25T12:00:00Z"}}, -1)
	// While a long turn runs the update only asks now and then (MG-137): maintenance may start meanwhile, and the
	// update waits for it.
	w.Run(100, func(st *update.State) bool {
		return st.Phase == update.WaitingForSafeBoundary && st.Candidate.Deferral != nil && st.Candidate.Deferral.Waiting == "boundary"
	})
	if _, err := w.Engine.AcquireLock("backup", "x", time.Hour); err != nil {
		t.Fatalf("lock while the update waits for a turn: %v", err)
	}
	w.Run(100, func(st *update.State) bool { return st.Candidate.Deferral.Waiting == "lock" })
	w.Engine.ReleaseLock("backup")
	// Hours without a quiet moment: the update holds drain windows, and no maintenance starts in one.
	w.Clock.Advance(7 * time.Hour)
	w.Repo.PublishTimestamp()
	w.Run(100, func(st *update.State) bool {
		return st.Phase == update.WaitingForSafeBoundary && st.Candidate.Deferral != nil && st.Candidate.Deferral.Draining
	})
	if _, err := w.Engine.AcquireLock("backup", "x", time.Hour); !errors.Is(err, update.ErrLockBusy) {
		t.Fatalf("lock during drain: %v", err)
	}
}

func TestSafeBoundaryDeferralIsBoundedAndExplained(t *testing.T) {
	t.Parallel()
	w := testworld.New(t)
	w.Runtime.SetBlockers([]runtimeapi.Blocker{{Kind: "job", ID: "job-42", Description: "nightly import", Since: "2026-09-25T12:00:00Z"}}, -1)
	mustOffer(t, w, testworld.RuntimeGood, update.DecisionStarted)
	w.Run(400, func(st *update.State) bool {
		return st.Phase == update.WaitingForSafeBoundary && st.Candidate.Deferral != nil && st.Candidate.Deferral.Waiting == "boundary"
	})
	if d := w.State().Candidate.Deferral; !strings.Contains(d.Explanation, "job job-42 (nightly import)") || !strings.Contains(d.Explanation, "never interrupted") {
		t.Fatalf("explanation %q", d.Explanation)
	}
	// Hours without a quiet moment: drain windows, each bounded.
	w.Clock.Advance(7 * time.Hour)
	w.Repo.PublishTimestamp()
	w.Run(400, func(st *update.State) bool {
		return st.Candidate.Deferral.Windows >= 2 && !st.Candidate.Deferral.Draining
	})
	if w.Runtime.Draining() {
		t.Fatal("new turns must not stay blocked beyond the drain window")
	}
	// A day later the explanation escalates; still no activation and the work is untouched.
	w.Clock.Advance(25 * time.Hour)
	w.Repo.PublishTimestamp() // the online timestamp role keeps the repository fresh
	w.Run(400, func(st *update.State) bool {
		return st.Candidate != nil && st.Candidate.Deferral != nil && st.Candidate.Deferral.Escalated
	})
	if st := w.State(); st.Phase != update.WaitingForSafeBoundary || !strings.HasPrefix(st.Candidate.Deferral.Explanation, "Update deferred since") {
		t.Fatalf("phase %s explanation %q", st.Phase, st.Candidate.Deferral.Explanation)
	}
	w.Run(400, func(st *update.State) bool { return !st.Candidate.Deferral.Draining })
	factoryRunning(t, w)
	w.Runtime.SetBlockers(nil, 0)
	w.Run(400, testworld.PhaseIs(update.Healthy))
}

// MG-137: while an agent's long turn keeps the safe boundary away, the runtime is drained only while the manager asks,
// about every ProbeInterval; the update activates at the first quiet moment.
func TestWaitingForALongTurnKeepsTheBoxUsable(t *testing.T) {
	t.Parallel()
	w := testworld.New(t)
	w.Runtime.SetBlockers([]runtimeapi.Blocker{{Kind: "turn", ID: "dsp_1", Description: "an agent turn is finishing", Since: "2026-09-25T12:00:00Z"}}, 40)
	mustOffer(t, w, testworld.RuntimeGood, update.DecisionStarted)
	w.Run(400, func(st *update.State) bool { return st.Phase == update.WaitingForSafeBoundary })
	start := w.Clock.Now()
	for i := 0; i < 400 && w.State().Phase == update.WaitingForSafeBoundary; i++ {
		wait, err := w.Engine.Step(t.Context())
		if err != nil {
			t.Fatal(err)
		}
		if st := w.State(); st.Phase == update.WaitingForSafeBoundary && w.Runtime.Draining() {
			t.Fatalf("step %d: the runtime stays drained while the turn runs", i)
		}
		w.Clock.Advance(wait)
	}
	drains, resumes := w.Runtime.Calls()
	if drains < 40 || resumes < 39 {
		t.Fatalf("%d drains, %d resumes", drains, resumes)
	}
	if took := w.Clock.Now().Sub(start); took < 15*time.Minute || took > 30*time.Minute {
		t.Fatalf("40 probes took %s", took)
	}
	w.Run(400, testworld.PhaseIs(update.Healthy))
	if st := w.State(); st.Current.ReleaseID != testworld.RuntimeGood {
		t.Fatalf("current %s", st.Current.ReleaseID)
	}
}

func TestRepositoryUnavailableDuringRolloutKeepsInstallation(t *testing.T) {
	t.Parallel()
	w := testworld.New(t)
	mustOffer(t, w, testworld.RuntimeGood, update.DecisionStarted)
	// The artifact store disappears (CDN/control outage) mid-rollout.
	targets := w.Repo.TargetsDir()
	os.Rename(targets, targets+".offline")
	for i := 0; i < 30; i++ {
		w.Engine.Step(t.Context())
		w.Clock.Advance(time.Minute)
	}
	st := w.State()
	// The space check reads the closure indexes first, so the candidate waits in Assigned (UP-X14).
	if st.Phase != update.Assigned || st.Current.ReleaseID != testworld.Factory {
		t.Fatalf("phase %s", st.Phase)
	}
	factoryRunning(t, w)
	os.Rename(targets+".offline", targets)
	w.Run(400, testworld.PhaseIs(update.Healthy))
}

func TestFullDiskDuringStagingNeverTouchesKnownGood(t *testing.T) {
	t.Parallel()
	w := testworld.New(t)
	w.Space.Free = 10
	mustOffer(t, w, testworld.RuntimeGood, update.DecisionStarted)
	w.Run(50, testworld.PhaseIs(update.Failed))
	st := w.State()
	if lastFailure(st) != "no_space" || st.Candidate.Attempts != 0 {
		t.Fatalf("failure %v attempts %d", lastFailure(st), st.Candidate.Attempts)
	}
	factoryRunning(t, w)
	w.Space.Free = -1
	w.Run(400, testworld.PhaseIs(update.Healthy))
}

func TestCorruptDownloadQuarantinesAfterAttempts(t *testing.T) {
	t.Parallel()
	w := testworld.New(t)
	rel := w.Release(testworld.RuntimeGood)
	ip, _ := w.Repo.TargetFilePath(rel.RuntimeIndex.Target)
	ib, _ := os.ReadFile(ip)
	ci, err := trust.ParseClosureIndex(ib, *rel.RuntimeIndex)
	if err != nil {
		t.Fatal(err)
	}
	p, _ := w.Repo.BlobPath(ci.Paths[len(ci.Paths)-1].NarHash) // the runtime's blob
	b, _ := os.ReadFile(p)
	b[len(b)/2] ^= 0xff
	os.WriteFile(p, b, 0o644)
	mustOffer(t, w, testworld.RuntimeGood, update.DecisionStarted)
	w.Run(400, testworld.PhaseIs(update.Quarantined))
	st := w.State()
	if q := st.Quarantine[testworld.RuntimeGood]; q.Code != "download_corrupt" || q.Attempts != 3 {
		t.Fatalf("quarantine %+v", q)
	}
	factoryRunning(t, w)
	for _, e := range w.Helper.Events() {
		if strings.Contains(e, "whombat-runtime-1.1.0") {
			t.Fatalf("corrupt artifact reached the helper: %s", e)
		}
	}
}

func TestStaleClockAheadRefusesButKeepsRunning(t *testing.T) {
	t.Parallel()
	w := testworld.New(t)
	w.Clock.Advance(3 * 24 * time.Hour) // device clock jumps ahead: timestamp (1 day) looks expired
	if _, _, err := w.Offer(testworld.RuntimeGood); !errors.Is(err, trust.ErrExpired) {
		t.Fatalf("clock ahead: %v", err)
	}
	for i := 0; i < 5; i++ {
		w.Engine.Step(t.Context())
	}
	if st := w.State(); st.Phase != update.Healthy {
		t.Fatalf("phase %s", st.Phase)
	}
	factoryRunning(t, w)
}

func TestStaleClockBehindUsesTrustedTimeFloor(t *testing.T) {
	t.Parallel()
	w := testworld.New(t)
	// Keep a validly signed copy of today's metadata (timestamp expires in a day).
	frozen := t.TempDir()
	copyDir(t, w.Repo.MetadataDir(), frozen)
	// Five days later the repository has moved on; the device accepts an assignment, which records
	// its signed issue time as the trusted time floor.
	w.Clock.Advance(5 * 24 * time.Hour)
	w.Repo.PublishTimestamp()
	mustOffer(t, w, testworld.RuntimeGood, update.DecisionStarted)
	w.Run(400, testworld.PhaseIs(update.Healthy))
	// Now the device loses its metadata cache and its clock is reset far into the past, and an
	// attacker serves the old (expired in reality) metadata.
	os.RemoveAll(w.P.Cache)
	w.Clock.Set(testworld.T0.Add(-400 * 24 * time.Hour))
	w.TUF.Fetcher = trust.DirFetcher{BaseURL: "file://repo/metadata", Dir: frozen}
	if _, err := w.TUF.Refresh(t.Context()); !errors.Is(err, trust.ErrExpired) {
		t.Fatalf("with the time floor the frozen metadata must be expired: %v", err)
	}
	// Control: without the floor the same metadata would have been accepted.
	floor := w.TUF.Floor
	w.TUF.Floor = nil
	if _, err := w.TUF.Refresh(t.Context()); err != nil {
		t.Fatalf("without floor (documents the attack the floor prevents): %v", err)
	}
	w.TUF.Floor = floor
	if st := w.State(); st.Phase != update.Healthy {
		t.Fatalf("phase %s", st.Phase)
	}
}

func copyDir(t *testing.T, from, to string) {
	t.Helper()
	entries, err := os.ReadDir(from)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		b, _ := os.ReadFile(from + "/" + e.Name())
		os.WriteFile(to+"/"+e.Name(), b, 0o644)
	}
}

func TestLongOfflineDeviceCatchesUp(t *testing.T) {
	t.Parallel()
	w := testworld.New(t)
	// 200 days offline while the repository rotates every key three times.
	for i := 0; i < 3; i++ {
		w.Clock.Advance(60 * 24 * time.Hour)
		if err := w.Repo.RotateKeys("root", "targets", "snapshot", "timestamp"); err != nil {
			t.Fatal(err)
		}
	}
	w.Clock.Advance(20 * 24 * time.Hour)
	w.Repo.RotateAssignmentKey(0)
	w.Repo.Publish()
	mustOffer(t, w, testworld.RuntimeNext, update.DecisionStarted)
	w.Run(400, testworld.PhaseIs(update.Healthy))
	if st := w.State(); st.Current.ReleaseID != testworld.RuntimeNext {
		t.Fatal(st.Current.ReleaseID)
	}
}

func TestNewAssignmentDuringVerifyingIsQueued(t *testing.T) {
	t.Parallel()
	w := testworld.New(t)
	mustOffer(t, w, testworld.RuntimeGood, update.DecisionStarted)
	w.Run(200, testworld.PhaseIs(update.Verifying))
	mustOffer(t, w, testworld.RuntimeNext, update.DecisionQueued)
	w.Run(400, func(st *update.State) bool {
		return st.Phase == update.Healthy && st.Current.ReleaseID == testworld.RuntimeNext
	})
	st := w.State()
	if st.PreviousKnownGood.ReleaseID != testworld.RuntimeGood {
		t.Fatalf("previous known-good %s", st.PreviousKnownGood.ReleaseID)
	}
}

func TestRecoveryManagerRollsBackInterruptedActivation(t *testing.T) {
	t.Parallel()
	w := testworld.New(t)
	mustOffer(t, w, testworld.RuntimeGood, update.DecisionStarted)
	w.Run(200, testworld.PhaseIs(update.Verifying))
	// The (new) manager binary dies here; systemd starts the known-good recovery manager.
	w.NewEngine().RecoveryMode = true
	mustOffer(t, w, testworld.RuntimeNext, update.DecisionQueued)
	w.Run(200, testworld.PhaseIs(update.RolledBack))
	st := w.State()
	if lastFailure(st) != "manager_recovery" || st.Current.ReleaseID != testworld.Factory {
		t.Fatalf("failure %v current %s", lastFailure(st), st.Current.ReleaseID)
	}
	factoryRunning(t, w)
	for i := 0; i < 10; i++ {
		w.Engine.Step(t.Context())
		w.Clock.Advance(time.Hour)
	}
	if st := w.State(); st.Phase != update.RolledBack {
		t.Fatalf("recovery manager must not start activations: %s", st.Phase)
	}
	// The repaired manager resumes normal operation and takes the queued assignment.
	w.NewEngine()
	w.Run(400, func(st *update.State) bool {
		return st.Phase == update.Healthy && st.Current.ReleaseID == testworld.RuntimeNext
	})
}

func TestJournalRecordsSatisfyContract(t *testing.T) {
	t.Parallel()
	w := testworld.New(t)
	mustOffer(t, w, testworld.RuntimeBad, update.DecisionStarted)
	retryUntilQuarantined(t, w, testworld.RuntimeBad)
	st := w.State()
	if err := st.Record.Validate(); err != nil {
		t.Fatal(err)
	}
	for _, h := range st.History {
		if h.From != "" && h.From != h.To {
			t.Logf("%s -> %s %s", h.From, h.To, h.Note)
		}
	}
}

func TestDrainBusyWhileBackupHoldsRuntime(t *testing.T) {
	t.Parallel()
	w := testworld.New(t)
	w.Runtime.HoldDrain("backup-ckpt-1", 30*time.Minute) // the backup service's write barrier
	mustOffer(t, w, testworld.RuntimeGood, update.DecisionStarted)
	w.Run(100, func(st *update.State) bool {
		return st.Phase == update.WaitingForSafeBoundary && st.Candidate.Deferral != nil && len(st.Candidate.Deferral.Blockers) > 0
	})
	if d := w.State().Candidate.Deferral; d.Blockers[0].Kind != "backup" || !strings.Contains(d.Explanation, "backup checkpoint") {
		t.Fatalf("%+v", d)
	}
	w.Clock.Advance(31 * time.Minute) // the backup's lease ends
	w.Run(400, testworld.PhaseIs(update.Healthy))
}

// After a host fallback the runtime profile still names the candidate's runtime (it was switched
// before the reboot); the manager restores the known-good runtime and journals it.
func TestHostFallbackRestoresKnownGoodRuntime(t *testing.T) {
	t.Parallel()
	w := testworld.New(t)
	mustOffer(t, w, testworld.HostNoBoot, update.DecisionStarted)
	for i := 0; i < 200 && !w.Helper.RebootRequested(); i++ {
		w.Engine.Step(t.Context())
		w.Clock.Advance(time.Second)
	}
	if !w.Helper.RebootRequested() {
		t.Fatal("no reboot scheduled")
	}
	booted := w.Helper.SimulateReboot() // boot counting falls back to the factory generation
	w.Runtime.Restarted()
	w.NewEngine()
	if booted != devtuf.FakeStorePath("nixos-system-whombat-26.05.1") || w.RuntimeProfile() != devtuf.FakeStorePath("whombat-runtime-1.3.0") {
		t.Fatalf("fixture: booted %s runtime %s", booted, w.RuntimeProfile())
	}
	w.Run(200, testworld.PhaseIs(update.RolledBack))
	st := w.State()
	factoryRunning(t, w)
	if st.Current.ReleaseID != testworld.Factory || lastFailure(st) != "boot_fallback" {
		t.Fatalf("current %s failure %s", st.Current.ReleaseID, lastFailure(st))
	}
	if got := w.Helper.Readlink("profiles/system"); got != booted {
		t.Fatalf("boot default %s", got)
	}
}

// A booted host that is not the journal's current one, outside any activation (e.g. picked at the
// boot menu): the manager re-activates the matching known tuple consistently and journals it.
func TestReconcileBootedKnownGoodHost(t *testing.T) {
	t.Parallel()
	w := testworld.New(t)
	mustOffer(t, w, testworld.HostGood, update.DecisionStarted)
	w.Run(400, func(st *update.State) bool {
		return st.Phase == update.Healthy && st.Current.ReleaseID == testworld.HostGood
	})
	w.Helper.SetBooted(devtuf.FakeStorePath("nixos-system-whombat-26.05.1"))
	w.Runtime.Restarted()
	w.NewEngine()
	w.Run(20, func(st *update.State) bool { return st.Current.ReleaseID == testworld.Factory })
	st := w.State()
	if st.Phase != update.Healthy || st.KnownGood.ReleaseID != testworld.Factory || st.PreviousKnownGood.ReleaseID != testworld.HostGood {
		t.Fatalf("phase %s known-good %s previous %s", st.Phase, st.KnownGood.ReleaseID, st.PreviousKnownGood.ReleaseID)
	}
	factoryRunning(t, w)
	if !strings.Contains(st.History[len(st.History)-1].Note, "host fallback") {
		t.Fatalf("not journaled: %+v", st.History[len(st.History)-1])
	}
	// A runtime update for the booted host now activates normally.
	mustOffer(t, w, testworld.RuntimeGood, update.DecisionStarted)
	w.Run(400, func(st *update.State) bool {
		return st.Phase == update.Healthy && st.Current.ReleaseID == testworld.RuntimeGood
	})
	// An unknown booted system is reported, not "fixed".
	w.Helper.SetBooted(devtuf.FakeStorePath("nixos-system-unknown"))
	w.NewEngine()
	w.Engine.Step(t.Context())
	if st := w.State(); st.Current.ReleaseID != testworld.RuntimeGood || !strings.Contains(st.LastRefusal, "belongs to no known tuple") {
		t.Fatalf("unknown host: current %s refusal %q", st.Current.ReleaseID, st.LastRefusal)
	}
}

// Before staging a new host candidate the failed candidate generation is deleted; booted,
// current and known-good generations stay.
func TestFailedHostGenerationsPrunedBeforeStaging(t *testing.T) {
	t.Parallel()
	w := testworld.New(t)
	mustOffer(t, w, testworld.HostNoBoot, update.DecisionStarted)
	w.Run(600, testworld.AwaitsControl)
	has := func(v string) bool {
		for _, g := range w.Helper.HostGenerations() {
			if g == devtuf.FakeStorePath("nixos-system-whombat-"+v) {
				return true
			}
		}
		return false
	}
	if !has("26.05.3") {
		t.Fatalf("fixture: failed generation missing: %v", w.Helper.HostGenerations())
	}
	mustOffer(t, w, testworld.HostGood, update.DecisionStarted)
	w.Run(100, testworld.PhaseIs(update.Staged))
	if has("26.05.3") || !has("26.05.1") {
		t.Fatalf("generations after staging: %v", w.Helper.HostGenerations())
	}
	w.Run(400, func(st *update.State) bool {
		return st.Phase == update.Healthy && st.Current.ReleaseID == testworld.HostGood
	})
	if !has("26.05.1") || !has("26.05.2") {
		t.Fatalf("known-good or current generation deleted: %v", w.Helper.HostGenerations())
	}
}

func TestReconcileSurvivesCrash(t *testing.T) {
	t.Parallel()
	for _, point := range []string{"effect:reconcile-host", "persist:Healthy->Healthy:before"} {
		t.Run(point, func(t *testing.T) {
			w := testworld.New(t)
			mustOffer(t, w, testworld.HostGood, update.DecisionStarted)
			w.Run(400, func(st *update.State) bool {
				return st.Phase == update.Healthy && st.Current.ReleaseID == testworld.HostGood
			})
			w.Helper.SetBooted(devtuf.FakeStorePath("nixos-system-whombat-26.05.1"))
			w.NewEngine()
			w.CrashAt, w.CrashN = point, 1
			if err := w.Run(20, func(st *update.State) bool { return st.Current.ReleaseID == testworld.Factory }); !errors.Is(err, testworld.ErrCrash) {
				t.Fatalf("crash not reached: %v", err)
			}
			w.NewEngine()
			w.RestartHelper()
			w.Run(20, func(st *update.State) bool { return st.Current.ReleaseID == testworld.Factory })
			factoryRunning(t, w)
		})
	}
}
