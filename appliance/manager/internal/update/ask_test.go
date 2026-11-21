package update_test

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/manager/internal/runtimeapi"
	"github.com/CybexBV/whombat/appliance/manager/internal/testworld"
	"github.com/CybexBV/whombat/appliance/manager/internal/update"
	"github.com/CybexBV/whombat/appliance/release-tools/devtuf"
	"github.com/CybexBV/whombat/contracts/go/release"
)

// Ask before updating (Whombat ask-before-updating.md): with the owner's switch on, every release offered waits,
// downloaded and staged, until the owner approves that release; the manager enforces it, whatever control assigns.

func waitsForOwner(id string) func(*update.State) bool {
	return func(st *update.State) bool {
		c := st.Candidate
		return c != nil && c.Tuple.ReleaseID == id && c.Deferral != nil && c.Deferral.Waiting == "owner"
	}
}

func askFirst(t *testing.T, w *testworld.World, on bool) {
	t.Helper()
	if err := w.Engine.SetAskFirst(on); err != nil {
		t.Fatal(err)
	}
}

func approve(t *testing.T, w *testworld.World, id string) {
	t.Helper()
	if err := w.Engine.Approve(id); err != nil {
		t.Fatalf("approve %s: %v", id, err)
	}
}

func run(t *testing.T, w *testworld.World, steps int, done func(*update.State) bool) {
	t.Helper()
	if err := w.Run(steps, done); err != nil {
		t.Fatal(err)
	}
}

// A runtime-only and a host release wait for the owner however long it takes, the installed release running; the
// approved one then installs. Control hears a hold, the owner's facts the reason.
func TestAskFirstWaitsForTheOwner(t *testing.T) {
	t.Parallel()
	for _, id := range []string{testworld.RuntimeGood, testworld.HostGood} {
		t.Run(id, func(t *testing.T) {
			t.Parallel()
			w := testworld.New(t)
			fast(w)
			askFirst(t, w, true)
			mustOffer(t, w, id, update.DecisionStarted)
			run(t, w, 200, waitsForOwner(id))
			for i := 0; i < 20; i++ {
				w.Engine.Step(t.Context())
				w.Clock.Advance(time.Hour)
			}
			st := w.State()
			if st.Phase != update.Staged || st.Current.ReleaseID != testworld.Factory || !strings.Contains(st.Candidate.Deferral.Explanation, "owner") {
				t.Fatalf("phase %s current %s deferral %+v", st.Phase, st.Current.ReleaseID, st.Candidate.Deferral)
			}
			factoryRunning(t, w)
			if wt := update.WaitingOf(st); wt == nil || wt.Reason != release.UpdateWaitReasonOwner {
				t.Fatalf("waiting %+v", wt)
			}
			if r := update.WaitingReport(st); r == nil || r.Reason != release.UpdateWaitReasonHold {
				t.Fatalf("control hears %+v, want a hold", r)
			}
			approve(t, w, id)
			if _, err := w.Engine.Step(t.Context()); err != nil {
				t.Fatal(err)
			}
			if st := w.State(); st.Approved != id || st.Candidate.Deferral.Waiting == "owner" {
				t.Fatalf("approved %q, still waiting for %q", st.Approved, st.Candidate.Deferral.Waiting)
			}
			run(t, w, 600, testworld.PhaseIs(update.Healthy))
			if st := w.State(); st.Current.ReleaseID != id || st.Approved != "" || !st.AskFirst {
				t.Fatalf("current %s approved %q ask %v", st.Current.ReleaseID, st.Approved, st.AskFirst)
			}
		})
	}
}

// Only the release that waits for the owner can be approved: not one still downloading, not one that waits for no
// one, not another release.
func TestApproveOnlyTheReleaseThatWaits(t *testing.T) {
	t.Parallel()
	w := testworld.New(t)
	fast(w)
	if err := w.Engine.Approve(testworld.RuntimeGood); !errors.Is(err, update.ErrNotWaiting) {
		t.Fatalf("nothing offered: %v", err)
	}
	mustOffer(t, w, testworld.RuntimeGood, update.DecisionStarted)
	if err := w.Engine.Approve(testworld.RuntimeGood); !errors.Is(err, update.ErrNotWaiting) {
		t.Fatalf("the switch is off: %v", err)
	}
	askFirst(t, w, true)
	if err := w.Engine.Approve(testworld.RuntimeGood); !errors.Is(err, update.ErrNotWaiting) {
		t.Fatalf("not staged yet: %v", err)
	}
	run(t, w, 200, waitsForOwner(testworld.RuntimeGood))
	if err := w.Engine.Approve(testworld.RuntimeNext); !errors.Is(err, update.ErrNotWaiting) {
		t.Fatalf("another release: %v", err)
	}
	if st := w.State(); st.Approved != "" {
		t.Fatalf("approved %q", st.Approved)
	}
	approve(t, w, testworld.RuntimeGood)
	approve(t, w, testworld.RuntimeGood) // a second press before the engine took it
	run(t, w, 400, testworld.PhaseIs(update.Healthy))
	if err := w.Engine.Approve(testworld.RuntimeGood); !errors.Is(err, update.ErrNotWaiting) {
		t.Fatalf("installed: %v", err)
	}
}

// Turning the switch off lets the update that waits go ahead by itself.
func TestSwitchOffLetsTheWaitingUpdateGo(t *testing.T) {
	t.Parallel()
	w := testworld.New(t)
	fast(w)
	askFirst(t, w, true)
	mustOffer(t, w, testworld.RuntimeGood, update.DecisionStarted)
	run(t, w, 200, waitsForOwner(testworld.RuntimeGood))
	askFirst(t, w, false)
	run(t, w, 400, testworld.PhaseIs(update.Healthy))
	if st := w.State(); st.Current.ReleaseID != testworld.RuntimeGood || st.Approved != "" {
		t.Fatalf("current %s approved %q", st.Current.ReleaseID, st.Approved)
	}
}

// An approval covers the release the owner saw: a renewed assignment of it keeps the approval, a newer release
// assigned before it installed waits for its own.
func TestANewerAssignmentAfterAnApprovalWaitsAgain(t *testing.T) {
	t.Parallel()
	w := testworld.New(t)
	fast(w)
	askFirst(t, w, true)
	mustOffer(t, w, testworld.RuntimeGood, update.DecisionStarted)
	run(t, w, 200, waitsForOwner(testworld.RuntimeGood))
	approve(t, w, testworld.RuntimeGood)
	// A backup holds maintenance: the approved update waits for it, like any update.
	if _, err := w.Engine.AcquireLock("backup", "checkpoint", time.Hour); err != nil {
		t.Fatal(err)
	}
	run(t, w, 50, func(st *update.State) bool { return st.Candidate.Deferral.Waiting == "lock" })
	mustOffer(t, w, testworld.RuntimeGood, update.DecisionNoop) // renewed
	if st := w.State(); st.Approved != testworld.RuntimeGood {
		t.Fatalf("a renewal lost the approval: %q", st.Approved)
	}
	mustOffer(t, w, testworld.RuntimeNext, update.DecisionStarted)
	if err := w.Engine.ReleaseLock("backup"); err != nil {
		t.Fatal(err)
	}
	run(t, w, 200, waitsForOwner(testworld.RuntimeNext))
	if st := w.State(); st.Approved != "" {
		t.Fatalf("the newer release took the older one's approval: %q", st.Approved)
	}
	if err := w.Engine.Approve(testworld.RuntimeGood); !errors.Is(err, update.ErrNotWaiting) {
		t.Fatalf("the replaced release: %v", err)
	}
	factoryRunning(t, w)
	approve(t, w, testworld.RuntimeNext)
	run(t, w, 400, testworld.PhaseIs(update.Healthy))
	if st := w.State(); st.Current.ReleaseID != testworld.RuntimeNext {
		t.Fatalf("current %s", st.Current.ReleaseID)
	}
}

// Going back to known-good never waits for the owner, nor does an activation already under way when the switch goes
// on; the approval ends with the rollback, so control assigning the release again asks again.
func TestRollbackToKnownGoodNeverWaits(t *testing.T) {
	t.Parallel()
	for _, id := range []string{testworld.RuntimeBad, testworld.HostNoBoot} {
		t.Run(id, func(t *testing.T) {
			t.Parallel()
			w := testworld.New(t)
			fast(w)
			askFirst(t, w, true)
			mustOffer(t, w, id, update.DecisionStarted)
			run(t, w, 200, waitsForOwner(id))
			approve(t, w, id)
			run(t, w, 400, testworld.PhaseIs(update.Verifying))
			askFirst(t, w, false)
			askFirst(t, w, true)                    // the owner's switch changes while it runs: nothing to approve again
			run(t, w, 600, testworld.AwaitsControl) // back on known-good, the switch on all the way
			st := w.State()
			if st.Current.ReleaseID != testworld.Factory || st.Approved != "" {
				t.Fatalf("current %s approved %q", st.Current.ReleaseID, st.Approved)
			}
			factoryRunning(t, w)
			mustOffer(t, w, id, update.DecisionQueued)
			run(t, w, 400, waitsForOwner(id))
		})
	}
}

// Every offered release waits, the custody-signed way back to an older release too.
func TestCustodyRollbackWaitsForTheOwner(t *testing.T) {
	t.Parallel()
	w := testworld.New(t)
	fast(w)
	mustOffer(t, w, testworld.HostGood, update.DecisionStarted)
	run(t, w, 600, testworld.PhaseIs(update.Healthy))
	back := devtuf.StandardRelease("rt-2-custody-rollback", "26.05.1", "1.1.0")
	back.AllowDowngradeFrom = []string{testworld.HostGood}
	publish(t, w, back)
	askFirst(t, w, true)
	mustOffer(t, w, back.ID, update.DecisionStarted)
	run(t, w, 200, waitsForOwner(back.ID))
	approve(t, w, back.ID)
	run(t, w, 600, testworld.PhaseIs(update.Healthy))
	if st := w.State(); st.Current.ReleaseID != back.ID {
		t.Fatalf("current %s", st.Current.ReleaseID)
	}
}

// A community box's own newest release waits too.
func TestCommunityReleaseWaitsForTheOwner(t *testing.T) {
	t.Parallel()
	w := testworld.New(t)
	fast(w)
	w.SetEdition("community")
	w.Keep(testworld.Factory, testworld.RuntimeGood)
	askFirst(t, w, true)
	if dec, why, _, err := w.Engine.OfferLatest(context.Background(), w.Refresh(), "dev-1", "dev"); err != nil || dec != update.DecisionStarted {
		t.Fatalf("offer: %s %q %v", dec, why, err)
	}
	run(t, w, 200, waitsForOwner(testworld.RuntimeGood))
	approve(t, w, testworld.RuntimeGood)
	run(t, w, 400, testworld.PhaseIs(update.Healthy))
}

// The switch goes on while an update waits for running work: it waits for the owner instead, and once approved the
// journal stops saying so at once (the owner's facts follow the journal).
func TestOwnerWaitWhileWaitingForRunningWork(t *testing.T) {
	t.Parallel()
	w := testworld.New(t)
	fast(w)
	w.Runtime.SetBlockers([]runtimeapi.Blocker{{Kind: "turn", ID: "t1", Description: "long turn", Since: "2026-09-25T12:00:00Z"}}, -1)
	mustOffer(t, w, testworld.RuntimeGood, update.DecisionStarted)
	run(t, w, 200, func(st *update.State) bool {
		return st.Phase == update.WaitingForSafeBoundary && st.Candidate.Deferral.Waiting == "boundary"
	})
	askFirst(t, w, true)
	run(t, w, 50, waitsForOwner(testworld.RuntimeGood))
	if st := w.State(); st.Phase != update.WaitingForSafeBoundary || st.Candidate.Deferral.Draining || w.Runtime.Draining() {
		t.Fatalf("phase %s deferral %+v", st.Phase, st.Candidate.Deferral)
	}
	approve(t, w, testworld.RuntimeGood)
	if _, err := w.Engine.Step(t.Context()); err != nil {
		t.Fatal(err)
	}
	if st := w.State(); st.Candidate.Deferral.Waiting == "owner" {
		t.Fatal("the journal still says it waits for the owner")
	}
	w.Runtime.SetBlockers(nil, 0)
	run(t, w, 400, testworld.PhaseIs(update.Healthy))
}

// SR-13: the switch turned on while the activation step has switched the runtime is kept with that step's save, and
// the activation doesn't run again.
func TestAskFirstDuringTheActivationStepIsKept(t *testing.T) {
	t.Parallel()
	w := testworld.New(t)
	fast(w)
	mustOffer(t, w, testworld.RuntimeGood, update.DecisionStarted)
	run(t, w, 400, testworld.PhaseIs(update.Activating))
	reached, release := holdAt(w, "persist:Activating->Verifying:before")
	stepped := stepping(w, testworld.PhaseIs(update.Verifying))
	wait(t, reached, "the activation's save")
	events := len(w.Helper.Events())
	askFirst(t, w, true)
	close(release)
	if err := <-stepped; err != nil {
		t.Fatal(err)
	}
	if st := w.State(); !st.AskFirst || st.Phase != update.Verifying {
		t.Fatalf("phase %s ask %v", st.Phase, st.AskFirst)
	}
	if ev := w.Helper.Events(); len(ev) != events {
		t.Fatalf("the activation ran again: %q", ev[events:])
	}
}

// SR-11: the owner's approval and a hold written at the same time keep each other.
func TestApprovalAndAHoldKeepEachOther(t *testing.T) {
	t.Parallel()
	w := testworld.New(t)
	fast(w)
	askFirst(t, w, true)
	mustOffer(t, w, testworld.RuntimeGood, update.DecisionStarted)
	run(t, w, 200, waitsForOwner(testworld.RuntimeGood))
	reached, release := holdAt(w, "persist:Staged->Staged:before")
	done := make(chan error, 1)
	go func() { done <- w.Engine.Approve(testworld.RuntimeGood) }()
	wait(t, reached, "the approval's save")
	if err := w.Engine.SetHold(true); err != nil {
		t.Fatal(err)
	}
	close(release)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if st := w.State(); !st.Hold || st.Approved != testworld.RuntimeGood {
		t.Fatalf("a lost update: hold %v approved %q", st.Hold, st.Approved)
	}
}
