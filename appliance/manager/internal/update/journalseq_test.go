package update_test

import (
	"testing"

	"github.com/CybexBV/whombat/appliance/manager/internal/journal"
	"github.com/CybexBV/whombat/appliance/manager/internal/testworld"
	"github.com/CybexBV/whombat/appliance/manager/internal/update"
)

// SR-04: the state OnTransition hands over carries the sequence of the journal record just written (the report's
// identity), and Load the one it read.
func TestOnTransitionCarriesTheJournalSequence(t *testing.T) {
	t.Parallel()
	w := testworld.New(t)
	j, err := journal.Open(w.P.Journal)
	if err != nil {
		t.Fatal(err)
	}
	var seqs []uint64
	w.Engine.OnTransition = func(st update.State) {
		var disk update.State
		seq, found, err := j.LoadSeq(&disk)
		if err != nil || !found || st.JournalSeq != seq || disk.Phase != st.Phase {
			t.Errorf("OnTransition got journal sequence %d (%s), the journal's newest record is %d (%s): %v",
				st.JournalSeq, st.Phase, seq, disk.Phase, err)
		}
		if n := len(seqs); n > 0 && st.JournalSeq <= seqs[n-1] {
			t.Errorf("sequence %d after %d", st.JournalSeq, seqs[n-1])
		}
		seqs = append(seqs, st.JournalSeq)
	}
	mustOffer(t, w, testworld.RuntimeGood, update.DecisionStarted)
	if err := w.Run(400, testworld.PhaseIs(update.Healthy)); err != nil {
		t.Fatal(err)
	}
	if len(seqs) < 5 {
		t.Fatalf("%d transitions", len(seqs))
	}
	st, err := w.Engine.Load()
	if err != nil || st.JournalSeq != seqs[len(seqs)-1] {
		t.Fatalf("Load: sequence %d, last transition %d: %v", st.JournalSeq, seqs[len(seqs)-1], err)
	}
}
