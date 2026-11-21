package broker_test

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/manager/internal/broker"
	"github.com/CybexBV/whombat/appliance/manager/internal/testworld"
	"github.com/CybexBV/whombat/appliance/manager/internal/update"
	"github.com/CybexBV/whombat/appliance/release-tools/devtuf"
	"github.com/CybexBV/whombat/contracts/go/local"
	"github.com/CybexBV/whombat/contracts/go/release"
)

// factsOf is the POST /facts body the manager sends for st, checked against the contract.
func factsOf(t *testing.T, st *update.State) (*local.UpdateFacts, string) {
	t.Helper()
	b, err := json.Marshal(local.FactsRequest{V: 1, Update: broker.UpdateFactsOf(st, time.Time{})})
	if err != nil {
		t.Fatal(err)
	}
	req, err := local.ParseFactsRequest(b)
	if err != nil {
		t.Fatalf("facts refused by the contract: %v\n%s", err, b)
	}
	return req.Update, string(b)
}

func offerUntil(t *testing.T, w *testworld.World, id string, phase update.Phase) {
	t.Helper()
	if d, why, err := w.Offer(id); err != nil || d != update.DecisionStarted {
		t.Fatalf("offer %s: %v %s %v", id, d, why, err)
	}
	if err := w.Run(400, testworld.PhaseIs(phase)); err != nil {
		t.Fatal(err)
	}
}

// TestUpdateFactsCarryTheCurrentTuplesClientFloor: the verified current tuple's floor reaches the runtime
// (CT-53), absent when the tuple has none, and it survives a manager restart through the journal.
func TestUpdateFactsCarryTheCurrentTuplesClientFloor(t *testing.T) {
	t.Parallel()
	w := testworld.New(t)
	if f, body := factsOf(t, w.State()); f.ClientFloor != nil || strings.Contains(body, "clientFloor") {
		t.Fatalf("factory tuple has no floor, facts say %s", body)
	}
	floor := release.ClientFloor{Web: 120, Android: 4021, Cli: 7}
	withFloor := devtuf.StandardRelease("rt-13-floor", "26.05.1", "1.0.5")
	withFloor.ClientFloor = &floor
	if _, err := w.Repo.AddFakeRelease(withFloor); err != nil {
		t.Fatal(err)
	}
	if err := w.Repo.Publish(); err != nil {
		t.Fatal(err)
	}

	offerUntil(t, w, "rt-13-floor", update.Healthy)
	st := w.State()
	if st.Phase != update.Healthy || st.Current.ReleaseID != "rt-13-floor" {
		t.Fatalf("%s current %s", st.Phase, st.Current.ReleaseID)
	}
	if f, body := factsOf(t, st); f.ClientFloor == nil || *f.ClientFloor != floor {
		t.Fatalf("floor not passed through: %s", body)
	}

	// A restarted manager reads the floor back from the journal's current tuple.
	restarted, err := w.NewEngine().Load()
	if err != nil {
		t.Fatal(err)
	}
	if f, body := factsOf(t, restarted); f.ClientFloor == nil || *f.ClientFloor != floor {
		t.Fatalf("floor lost across a restart: %s", body)
	}

	// A rollback to known-good keeps known-good's floor; a later release without one clears it (no ratchet).
	offerUntil(t, w, testworld.RuntimeBad, update.RolledBack)
	if st := w.State(); st.Phase != update.RolledBack || st.Current.ReleaseID != "rt-13-floor" {
		t.Fatalf("%s current %s", st.Phase, st.Current.ReleaseID)
	} else if f, body := factsOf(t, st); f.ClientFloor == nil || *f.ClientFloor != floor {
		t.Fatalf("rollback lost the known-good floor: %s", body)
	}
	offerUntil(t, w, testworld.RuntimeNext, update.Healthy)
	if st := w.State(); st.Current.ReleaseID != testworld.RuntimeNext {
		t.Fatalf("current %s", st.Current.ReleaseID)
	} else if f, body := factsOf(t, st); f.ClientFloor != nil {
		t.Fatalf("release without a floor still reports one: %s", body)
	}
}
