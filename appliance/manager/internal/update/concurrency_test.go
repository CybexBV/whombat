package update_test

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/manager/internal/testworld"
	"github.com/CybexBV/whombat/appliance/manager/internal/update"
)

// holdAt holds the first mutation that reaches the crash point until release is closed: it loaded the journal and
// changed its copy, and has not written it yet.
func holdAt(w *testworld.World, point string) (reached, release chan struct{}) {
	reached, release = make(chan struct{}), make(chan struct{})
	var once atomic.Bool
	w.Engine.Crash = func(p string) error {
		if p == point && once.CompareAndSwap(false, true) {
			close(reached)
			<-release
		}
		return nil
	}
	return reached, release
}

func wait(t *testing.T, c chan struct{}, what string) {
	t.Helper()
	select {
	case <-c:
	case <-time.After(time.Minute):
		t.Fatalf("%s: not reached", what)
	}
}

// SR-11: two mutations from different goroutines (the broker's lock endpoint and a hold) each load the journal,
// change it and save it; neither may write over the other's change.
func TestConcurrentMutationsKeepEachOther(t *testing.T) {
	t.Parallel()
	w := testworld.New(t)
	reached, release := holdAt(w, "persist:Healthy->Healthy:before")
	done := make(chan error, 1)
	go func() { done <- w.Engine.SetHold(true) }()
	wait(t, reached, "the hold")
	if _, err := w.Engine.AcquireLock("backup", "checkpoint", time.Hour); err != nil {
		t.Fatal(err)
	}
	close(release)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if st := w.State(); !st.Hold || st.Lock == nil || st.Lock.Holder != "backup" {
		t.Fatalf("a lost update: hold %v, lock %+v", st.Hold, st.Lock)
	}
}

// stepping runs the engine (as the engine loop does) until done, in its own goroutine.
func stepping(w *testworld.World, done func(*update.State) bool) chan error {
	c := make(chan error, 1)
	go func() { c <- w.Run(400, done) }()
	return c
}

// SR-11: an assignment control delivers while the engine loop is between loading and saving a step (a health check
// during Verifying) is queued and stays queued: the step doesn't write its older copy over it.
func TestAssignmentDuringAStepIsKept(t *testing.T) {
	t.Parallel()
	w := testworld.New(t)
	fast(w)
	mustOffer(t, w, testworld.RuntimeGood, update.DecisionStarted)
	if err := w.Run(400, testworld.PhaseIs(update.Verifying)); err != nil {
		t.Fatal(err)
	}
	reached, release := holdAt(w, "persist:Verifying->Verifying:before")
	run := stepping(w, testworld.PhaseIs(update.Healthy))
	wait(t, reached, "the health check's save")
	mustOffer(t, w, testworld.RuntimeNext, update.DecisionQueued)
	close(release)
	if err := <-run; err != nil {
		t.Fatal(err)
	}
	st := w.State()
	if st.Pending == nil || st.Pending.Release.Tuple.ReleaseID != testworld.RuntimeNext {
		t.Fatalf("the queued assignment was lost: %+v", st.Pending)
	}
	if err := w.Run(600, func(st *update.State) bool {
		return st.Phase == update.Healthy && st.Current.ReleaseID == testworld.RuntimeNext
	}); err != nil {
		t.Fatal(err)
	}
}

// SR-11: the step that promotes the candidate to known-good, and an assignment queued meanwhile: both are kept.
func TestKnownGoodPromotionKeepsAQueuedAssignment(t *testing.T) {
	t.Parallel()
	w := testworld.New(t)
	fast(w)
	mustOffer(t, w, testworld.RuntimeGood, update.DecisionStarted)
	if err := w.Run(400, testworld.PhaseIs(update.Verifying)); err != nil {
		t.Fatal(err)
	}
	reached, release := holdAt(w, "persist:Verifying->Healthy:before")
	run := stepping(w, testworld.PhaseIs(update.Healthy))
	wait(t, reached, "the promotion's save")
	mustOffer(t, w, testworld.RuntimeNext, update.DecisionQueued)
	close(release)
	if err := <-run; err != nil {
		t.Fatal(err)
	}
	st := w.State()
	if st.KnownGood == nil || st.KnownGood.ReleaseID != testworld.RuntimeGood || st.Current.ReleaseID != testworld.RuntimeGood {
		t.Fatalf("not promoted: current %v known-good %v", st.Current, st.KnownGood)
	}
	if st.Pending == nil || st.Pending.Release.Tuple.ReleaseID != testworld.RuntimeNext {
		t.Fatalf("the queued assignment was lost: %+v", st.Pending)
	}
}

// SR-11, MG-16: the recovery manager starting a rollback and an assignment it queues meanwhile: both are kept.
func TestRecoveryRollbackKeepsAQueuedAssignment(t *testing.T) {
	t.Parallel()
	w := testworld.New(t)
	fast(w)
	mustOffer(t, w, testworld.RuntimeGood, update.DecisionStarted)
	if err := w.Run(400, testworld.PhaseIs(update.Verifying)); err != nil {
		t.Fatal(err)
	}
	w.Engine.RecoveryMode = true
	reached, release := holdAt(w, "persist:Verifying->Verifying:before")
	run := stepping(w, func(st *update.State) bool { return st.Candidate != nil && st.Candidate.Rollback != nil })
	wait(t, reached, "the rollback's first save")
	mustOffer(t, w, testworld.RuntimeNext, update.DecisionQueued)
	close(release)
	if err := <-run; err != nil {
		t.Fatal(err)
	}
	if st := w.State(); st.Pending == nil || st.Candidate.Rollback == nil || st.Candidate.Rollback.Code != "manager_recovery" {
		t.Fatalf("pending %+v, rollback %+v", st.Pending, st.Candidate.Rollback)
	}
}

// SR-12: an assignment whose save lost (here to the step that reaches the safe boundary) never leaves its file behind:
// the helper checks that file at activation and would refuse the release in flight (not_assigned) again and again.
func TestLostOfferLeavesTheAssignmentFile(t *testing.T) {
	t.Parallel()
	w := testworld.New(t)
	fast(w)
	mustOffer(t, w, testworld.RuntimeGood, update.DecisionStarted)
	if err := w.Run(400, testworld.PhaseIs(update.Staged)); err != nil {
		t.Fatal(err)
	}
	good, _ := os.ReadFile(w.P.Assignment)
	reached, release := holdAt(w, "persist:Staged->Assigned:before")
	done := make(chan update.Decision, 1)
	go func() { d, _, _ := w.Offer(testworld.RuntimeNext); done <- d }()
	wait(t, reached, "the offer's save")
	for i := 0; i < 20 && w.State().Phase != update.Activating; i++ {
		wt, err := w.Engine.Step(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		w.Clock.Advance(wt)
	}
	close(release)
	if d := <-done; d != update.DecisionQueued {
		t.Fatalf("the offer: %s", d)
	}
	if file, _ := os.ReadFile(w.P.Assignment); !bytes.Equal(file, good) {
		t.Fatal("the assignment file is the queued assignment's, not the candidate's")
	}
	if err := w.Run(600, func(st *update.State) bool {
		return st.Phase == update.Healthy && st.Current.ReleaseID == testworld.RuntimeNext
	}); err != nil {
		t.Fatal(err)
	}
	for _, h := range w.State().History {
		if strings.Contains(h.Note, "not_assigned") {
			t.Fatalf("refused by the helper: %+v", h)
		}
	}
}

// SR-12: the assignment file follows the journal's candidate: one left behind (a crash between the file and the
// journal write) is written again before the next step acts.
func TestAssignmentFileFollowsTheJournal(t *testing.T) {
	t.Parallel()
	w := testworld.New(t)
	fast(w)
	mustOffer(t, w, testworld.RuntimeGood, update.DecisionStarted)
	if err := w.Run(400, testworld.PhaseIs(update.Staged)); err != nil {
		t.Fatal(err)
	}
	good, _ := os.ReadFile(w.P.Assignment)
	os.WriteFile(w.P.Assignment, []byte(`{"stale":true}`), 0o644)
	if _, err := w.Engine.Step(context.Background()); err != nil {
		t.Fatal(err)
	}
	if file, _ := os.ReadFile(w.P.Assignment); !bytes.Equal(file, good) {
		t.Fatalf("not written again: %s", file)
	}
}

// SR-11: the journal's newest record becomes unreadable while the manager runs: the journal goes on from the
// newest readable one, and every mutation keeps working (they conflicted for good before).
func TestUnreadableNewestRecord(t *testing.T) {
	t.Parallel()
	w := testworld.New(t)
	fast(w)
	mustOffer(t, w, testworld.RuntimeGood, update.DecisionStarted)
	for i := 0; i < 3; i++ {
		if _, err := w.Engine.Step(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	seq := w.Engine.J.Seq()
	slot := "journal.a.json"
	if seq%2 == 1 {
		slot = "journal.b.json"
	}
	os.WriteFile(filepath.Join(w.Engine.J.Dir(), slot), []byte("{}"), 0o600)
	for i := 0; i < 3; i++ {
		if wt, err := w.Engine.Step(context.Background()); err != nil || wt < 0 {
			t.Fatal(wt, err)
		}
	}
	if err := w.Engine.SetHold(true); err != nil {
		t.Fatal(err)
	}
	if st := w.State(); !st.Hold || st.JournalSeq < seq {
		t.Fatalf("hold %v, record %d (the lost one was %d)", st.Hold, st.JournalSeq, seq)
	}
}

// SR-11: steps that keep losing to concurrent writes back off (with a warning) instead of spinning.
func TestStepsThatKeepLosingBackOff(t *testing.T) {
	t.Parallel()
	w := testworld.New(t)
	fast(w)
	mustOffer(t, w, testworld.RuntimeGood, update.DecisionStarted)
	w.Engine.Crash = func(p string) error {
		if p == "persist:Assigned->Downloading:before" { // someone writes the journal each time first
			var st update.State
			w.Engine.J.Load(&st)
			w.Engine.J.Save(&st)
		}
		return nil
	}
	var waits []time.Duration
	for i := 0; i < 7; i++ {
		wt, err := w.Engine.Step(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		waits = append(waits, wt)
	}
	for i, wt := range waits {
		if (i < 4 && wt != 0) || (i >= 4 && (wt <= 0 || (i > 4 && wt <= waits[i-1]))) {
			t.Fatalf("waits %v", waits)
		}
	}
}

// SR-13: a hold and an assignment arriving while the activation step has switched the runtime are kept with that
// step's save: the step is not dropped, so the runtime is not activated a second time.
func TestActivationStepKeptOverAHold(t *testing.T) {
	t.Parallel()
	w := testworld.New(t)
	fast(w)
	mustOffer(t, w, testworld.RuntimeGood, update.DecisionStarted)
	if err := w.Run(400, testworld.PhaseIs(update.Activating)); err != nil {
		t.Fatal(err)
	}
	reached, release := holdAt(w, "persist:Activating->Verifying:before")
	run := stepping(w, testworld.PhaseIs(update.Verifying))
	wait(t, reached, "the activation's save")
	events := len(w.Helper.Events())
	mustOffer(t, w, testworld.RuntimeNext, update.DecisionQueued) // (a new assignment lifts a hold: this first)
	if err := w.Engine.SetHold(true); err != nil {
		t.Fatal(err)
	}
	close(release)
	if err := <-run; err != nil {
		t.Fatal(err)
	}
	st := w.State()
	if !st.Hold || st.Pending == nil || st.Phase != update.Verifying {
		t.Fatalf("phase %s hold %v pending %v", st.Phase, st.Hold, st.Pending != nil)
	}
	if ev := w.Helper.Events(); len(ev) != events {
		t.Fatalf("the activation ran again: %q", ev[events:])
	}
}
