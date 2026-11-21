package broker_test

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/CybexBV/whombat/appliance/manager/internal/broker"
	"github.com/CybexBV/whombat/appliance/manager/internal/runtimeapi"
	"github.com/CybexBV/whombat/appliance/manager/internal/testworld"
	"github.com/CybexBV/whombat/appliance/manager/internal/update"
	"github.com/CybexBV/whombat/contracts/go/local"
	"github.com/CybexBV/whombat/contracts/go/release"
)

// MG-47 (UP-E4): the owner's facts say why an update failed (the structured detail), what a staged update waits for
// and which update completed last; they validate against the contract.
func TestUpdateFactsTellTheOwner(t *testing.T) {
	t.Parallel()
	w := testworld.New(t)
	f, body := factsOf(t, w.State())
	if f.FailureDetail != nil || f.Waiting != nil || f.LastUpdate != nil || strings.Contains(body, "lastUpdate") {
		t.Fatalf("factory facts %s", body)
	}
	// Waiting for running work at the safe boundary.
	w.Runtime.SetBlockers([]runtimeapi.Blocker{{Kind: "turn", ID: "t1", Description: "a turn", Since: "2026-09-25T12:00:00Z"},
		{Kind: "turn", ID: "t2", Description: "another", Since: "2026-09-25T12:00:00Z"}}, -1)
	if d, why, err := w.Offer(testworld.RuntimeGood); err != nil || d != update.DecisionStarted {
		t.Fatal(d, why, err)
	}
	w.Run(100, func(st *update.State) bool {
		return st.Phase == update.WaitingForSafeBoundary && st.Candidate.Deferral != nil && len(st.Candidate.Deferral.Blockers) == 2
	})
	f, body = factsOf(t, w.State())
	if f.Waiting == nil || f.Waiting.Reason != release.UpdateWaitReasonBoundary || f.Waiting.Since != "2026-09-25T12:00:00Z" ||
		len(f.Waiting.Blockers) != 1 || f.Waiting.Blockers[0].Kind != "turn" || f.Waiting.Blockers[0].Count != 2 || strings.Contains(body, "a turn") {
		t.Fatalf("waiting facts %s", body)
	}
	w.Runtime.SetBlockers(nil, 0)
	w.Run(400, testworld.PhaseIs(update.Healthy))
	f, body = factsOf(t, w.State())
	if f.Waiting != nil || f.LastUpdate == nil || f.LastUpdate.Release != testworld.RuntimeGood || f.LastUpdate.From == nil ||
		*f.LastUpdate.From != testworld.Factory || f.LastUpdate.At == "" {
		t.Fatalf("healthy facts %s", body)
	}
	// A failure: its detail, and the last update still the one before.
	if d, why, err := w.Offer(testworld.NoFloors); err != nil || d != update.DecisionStarted {
		t.Fatal(d, why, err)
	}
	w.Run(100, testworld.PhaseIs(update.Failed))
	f, body = factsOf(t, w.State())
	if fd := f.FailureDetail; fd == nil || fd.Code != "schema_incompatible" || fd.Release != testworld.NoFloors ||
		strings.Join(fd.Reasons, ",") != "candidate_cannot_read_schema" || fd.Schema == nil || fd.Schema.Database != 10 ||
		f.LastUpdate == nil || f.LastUpdate.Release != testworld.RuntimeGood || strings.Contains(body, "cannot activate") {
		t.Fatalf("failed facts %s", body)
	}
	// The last update survives a manager restart (the journal).
	w.NewEngine()
	if f, _ := factsOf(t, w.State()); f.LastUpdate == nil || f.LastUpdate.Release != testworld.RuntimeGood {
		t.Fatalf("after restart %+v", f.LastUpdate)
	}
}

func TestPausedChannelFactsAndStatus(t *testing.T) {
	t.Parallel()
	w := testworld.New(t)
	if f, body := factsOf(t, w.State()); f.Paused != nil || strings.Contains(body, `"paused"`) {
		t.Fatalf("unpaused facts should omit paused: %s", body)
	}
	if err := w.Engine.SetChannelPaused(true); err != nil {
		t.Fatal(err)
	}
	f, body := factsOf(t, w.State())
	if f.Paused == nil || !*f.Paused {
		t.Fatalf("paused facts missing paused=true: %s", body)
	}
	st := broker.StatusOf(w.State())
	b, err := json.Marshal(st)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := local.ParseUpdateStatusResponse(b); err != nil {
		t.Fatalf("paused status violates contract: %v %s", err, b)
	}
	if st.Paused == nil || !*st.Paused || st.Explanation == nil || *st.Explanation != "Updates are paused for now." {
		t.Fatalf("paused status: %+v", st)
	}
	if err := w.Engine.SetChannelPaused(false); err != nil {
		t.Fatal(err)
	}
	if f, body := factsOf(t, w.State()); f.Paused != nil || strings.Contains(body, `"paused"`) {
		t.Fatalf("resumed facts should omit paused: %s", body)
	}
	resumed := broker.StatusOf(w.State())
	if resumed.Paused != nil || resumed.Explanation != nil {
		t.Fatalf("resumed status: %+v", resumed)
	}
}
