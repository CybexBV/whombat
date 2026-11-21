package update_test

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/CybexBV/whombat/appliance/manager/internal/runtimeapi"
	"github.com/CybexBV/whombat/appliance/manager/internal/testworld"
	"github.com/CybexBV/whombat/appliance/manager/internal/update"
	"github.com/CybexBV/whombat/contracts/go/device"
	"github.com/CybexBV/whombat/contracts/go/release"
)

// The detail is what control accepts in a device body (strict: codes, ids, numbers).
func reportable(t *testing.T, st *update.State) *release.UpdateFailureDetail {
	t.Helper()
	d := update.FailureDetail(st)
	if d == nil {
		t.Fatalf("no detail in %s (failure %+v)", st.Phase, st.LastFailure)
	}
	r := device.UpdateFailureReport(*d)
	p := device.UpdateProgressRequest{State: st.Phase, Current: st.Record.Current, Candidate: st.Record.Candidate, Failure: st.Record.Failure,
		FailedChecks: []string{}, FailureDetail: &r, At: st.Record.UpdatedAt}
	if err := p.Validate(); err != nil {
		t.Fatalf("detail %+v doesn't validate: %v", d, err)
	}
	b, _ := json.Marshal(d)
	if strings.Contains(string(b), "/nix/store") || strings.Contains(string(b), "message") {
		t.Fatalf("detail carries text: %s", b)
	}
	return d
}

// MG-46: the failure of 2026-09-28, a runtime before MD-12 that reads only its own schema, judged at the live schema.
// The detail is the contracts' incident example: describeUpdateFailure renders “… it reads schema 11 only and the
// database is at 10. Nothing was changed.”
func TestFailureDetailOfASchemaRefusal(t *testing.T) {
	t.Parallel()
	w := testworld.New(t)
	mustOffer(t, w, testworld.NoFloors, update.DecisionStarted)
	w.Run(100, testworld.PhaseIs(update.Failed))
	d := reportable(t, w.State())
	if d.Stage != update.Staged || d.Code != "schema_incompatible" || strings.Join(d.Reasons, ",") != "candidate_cannot_read_schema" ||
		d.Release != testworld.NoFloors || d.Schema == nil || d.Schema.Database != 10 || d.Schema.Target != nil || d.Schema.CandidateWrites != 11 ||
		d.Schema.CandidateReads != (release.IntRange{Min: 11, Max: 11}) || d.RollbackAccess == nil || *d.RollbackAccess != "read-write" ||
		len(d.FailedChecks) != 0 || d.At != testworld.T0.Unix() {
		t.Fatalf("detail %+v schema %+v", d, d.Schema)
	}
	// Quarantined, the candidate gone: the last failure still names it.
	w.Run(400, testworld.PhaseIs(update.Quarantined))
	if d := reportable(t, w.State()); d.Release != testworld.NoFloors || d.Code != "schema_incompatible" {
		t.Fatalf("quarantined %+v", d)
	}
	// A candidate that migrates and reports floors is judged at its target: the detail names it.
	w = testworld.New(t)
	mustOffer(t, w, testworld.PastFloors, update.DecisionStarted)
	w.Run(400, testworld.PhaseIs(update.Healthy))
	mustOffer(t, w, testworld.Schema10, update.DecisionStarted)
	w.Run(100, testworld.PhaseIs(update.Failed))
	if d := reportable(t, w.State()); strings.Join(d.Reasons, ",") != "candidate_cannot_read_schema" || d.Schema.Database != 11 || d.Schema.Target != nil {
		t.Fatalf("refused by its own check: %+v %+v", d, d.Schema)
	}
}

// An unhealthy candidate: the failed checks during the rollback and after it, with the known-good's access; nothing
// once healthy again.
func TestFailureDetailOfARollback(t *testing.T) {
	t.Parallel()
	w := testworld.New(t)
	mustOffer(t, w, testworld.RuntimeBad, update.DecisionStarted)
	w.Run(400, func(st *update.State) bool { return st.Candidate != nil && st.Candidate.Rollback != nil })
	d := reportable(t, w.State())
	if d.Code != "unhealthy" || d.Stage != update.Verifying || strings.Join(d.FailedChecks, ",") != "runtime,session_endpoint" {
		t.Fatalf("rolling back %+v", d)
	}
	w.Run(400, testworld.PhaseIs(update.RolledBack))
	d = reportable(t, w.State())
	if d.Code != "unhealthy" || d.Release != testworld.RuntimeBad || strings.Join(d.FailedChecks, ",") != "runtime,session_endpoint" ||
		d.RollbackAccess == nil || *d.RollbackAccess != "read-write" || d.Schema != nil {
		t.Fatalf("rolled back %+v", d)
	}
	mustOffer(t, w, testworld.RuntimeGood, update.DecisionStarted) // control moves the box on (MG-56: nothing retried)
	w.Run(400, testworld.PhaseIs(update.Healthy))
	st := w.State()
	if d := update.FailureDetail(st); d != nil {
		t.Fatalf("healthy with a detail %+v", d)
	}
	if lu := st.LastUpdate; lu == nil || lu.Release != testworld.RuntimeGood || lu.From != testworld.Factory {
		t.Fatalf("last update %+v", lu)
	}
}

// MG-47: why a staged candidate waits, with the running work counted by kind.
func TestWaitingOf(t *testing.T) {
	t.Parallel()
	w := testworld.New(t)
	if update.WaitingOf(w.State()) != nil {
		t.Fatal("waiting without a candidate")
	}
	w.Runtime.SetBlockers([]runtimeapi.Blocker{{Kind: "turn", ID: "t1", Description: "long turn", Since: "2026-09-25T12:00:00Z"},
		{Kind: "turn", ID: "t2", Description: "another", Since: "2026-09-25T12:00:00Z"},
		{Kind: "job", ID: "job-42", Description: "nightly import", Since: "2026-09-25T12:00:00Z"}}, -1)
	mustOffer(t, w, testworld.RuntimeGood, update.DecisionStarted)
	w.Run(100, func(st *update.State) bool {
		return st.Phase == update.WaitingForSafeBoundary && st.Candidate.Deferral != nil && len(st.Candidate.Deferral.Blockers) == 3
	})
	wt := update.WaitingOf(w.State())
	if wt == nil || wt.Reason != release.UpdateWaitReasonBoundary || !wt.Since.Equal(testworld.T0) || len(wt.Blockers) != 2 ||
		wt.Blockers[0] != (update.WaitBlocker{Kind: "job", Count: 1}) || wt.Blockers[1] != (update.WaitBlocker{Kind: "turn", Count: 2}) {
		t.Fatalf("waiting %+v", wt)
	}
	if r := update.WaitingReport(w.State()); r == nil || r.Reason != release.UpdateWaitReasonBoundary || r.Since != testworld.T0.Unix() {
		t.Fatalf("waiting report %+v", r)
	}
	w.Runtime.SetBlockers(nil, 0)
	w.Run(400, testworld.PhaseIs(update.Healthy))
	if update.WaitingOf(w.State()) != nil || update.WaitingReport(w.State()) != nil {
		t.Fatal("waiting when healthy")
	}
	// A checkpoint the box can't take.
	w = testworld.New(t)
	w.Checkpoints.Fail = errUnprotected
	mustOffer(t, w, testworld.ContractFloors, update.DecisionStarted)
	w.Run(80, func(st *update.State) bool {
		return st.Phase == update.WaitingForSafeBoundary && st.Candidate.Deferral != nil && st.Candidate.Deferral.Waiting == "checkpoint"
	})
	if wt := update.WaitingOf(w.State()); wt == nil || wt.Reason != release.UpdateWaitReasonCheckpoint || len(wt.Blockers) != 0 {
		t.Fatalf("checkpoint %+v", wt)
	}
	// A hold.
	w = testworld.New(t)
	if d, _, err := w.OfferHold(); err != nil || d != update.DecisionHold {
		t.Fatal(d, err)
	}
	mustOffer(t, w, testworld.RuntimeGood, update.DecisionStarted)
	if d, _, err := w.OfferHold(); err != nil || d != update.DecisionHold {
		t.Fatal(d, err)
	}
	w.Run(100, func(st *update.State) bool {
		return st.Candidate != nil && st.Candidate.Deferral != nil && st.Candidate.Deferral.Waiting == "hold"
	})
	if wt := update.WaitingOf(w.State()); wt == nil || wt.Reason != release.UpdateWaitReasonHold {
		t.Fatalf("hold %+v", wt)
	}
}

// A host candidate that doesn't boot: the detail's failed check is the boot.
func TestFailureDetailOfABootFallback(t *testing.T) {
	t.Parallel()
	w := testworld.New(t)
	mustOffer(t, w, testworld.HostNoBoot, update.DecisionStarted)
	w.Run(600, testworld.PhaseIs(update.RolledBack))
	if d := reportable(t, w.State()); d.Code != "boot_fallback" || strings.Join(d.FailedChecks, ",") != "boot" || d.Release != testworld.HostNoBoot {
		t.Fatalf("detail %+v", d)
	}
}
