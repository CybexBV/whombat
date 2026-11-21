package update_test

import (
	"strings"
	"testing"

	"github.com/CybexBV/whombat/appliance/manager/internal/testworld"
	"github.com/CybexBV/whombat/appliance/manager/internal/update"
)

// Regression for L-1 (W4-SEC part 2): a verified pre-migration checkpoint was reused after the runtime
// had resumed (here: a hold) and accepted writes, so the migration named a checkpoint that missed them.
// Now the checkpoint is bound to its drain and a new one is taken.
func TestCheckpointNotReusedAfterResume(t *testing.T) {
	t.Parallel()
	w := testworld.New(t)
	mustOffer(t, w, testworld.Contract, update.DecisionStarted)
	w.Run(400, func(st *update.State) bool {
		return st.Candidate != nil && st.Candidate.Schema != nil && st.Candidate.Schema.CheckpointRef != ""
	})
	first := w.State().Candidate.Schema.CheckpointRef
	if d, _, err := w.OfferHold(); err != nil || d != update.DecisionHold {
		t.Fatalf("hold: %v %v", d, err)
	}
	w.Run(20, func(st *update.State) bool { return !w.Runtime.Draining() })
	mustOffer(t, w, testworld.Contract, update.DecisionNoop) // rollout resumes
	w.Run(400, testworld.PhaseIs(update.Healthy, update.Failed))
	if st := w.State(); st.Phase != update.Healthy {
		t.Fatalf("phase %s", st.Phase)
	}
	// (The fake backup service names checkpoints by release, so count them.)
	if n := len(w.Checkpoints.Refs); n != 2 {
		t.Fatalf("%d checkpoints taken (first %s), want a new one after the resume", n, first)
	}
	migrations := 0
	for _, e := range w.Helper.Events() {
		if strings.HasPrefix(e, "migrate ") {
			migrations++
		}
	}
	if migrations != 1 {
		t.Fatalf("%d migrations", migrations)
	}
}

// L-1: a manager outage longer than the drain lease between checkpoint and migration also invalidates
// the checkpoint.
func TestCheckpointStaleAfterLeaseLapse(t *testing.T) {
	t.Parallel()
	w := testworld.New(t)
	mustOffer(t, w, testworld.Contract, update.DecisionStarted)
	w.Run(400, func(st *update.State) bool {
		return st.Candidate != nil && st.Candidate.Schema != nil && st.Candidate.Schema.CheckpointRef != ""
	})
	first := w.State().Candidate.Schema.CheckpointRef
	w.Clock.Advance(w.Policy.DrainLease) // manager down past the lease
	w.Run(400, testworld.PhaseIs(update.Healthy, update.Failed))
	if st := w.State(); st.Phase != update.Healthy {
		t.Fatalf("phase %s", st.Phase)
	}
	if n := len(w.Checkpoints.Refs); n != 2 {
		t.Fatalf("%d checkpoints taken (first %s), want a new one after the lease lapsed", n, first)
	}
}
