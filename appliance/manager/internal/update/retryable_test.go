package update_test

import (
	"strings"
	"testing"

	"github.com/CybexBV/whombat/appliance/manager/internal/testworld"
	"github.com/CybexBV/whombat/appliance/manager/internal/update"
	"github.com/CybexBV/whombat/contracts/go/release"
)

// MG-54: a retryable failure (release.IsRetryableUpdateFailure: this box can't right now) never quarantines the
// release locally, however many attempts the candidate has, from Failed or RolledBack; other failures do.
func TestRetryableFailuresNeverQuarantine(t *testing.T) {
	t.Parallel()
	cases := append([]string{}, release.RetryableUpdateFailures...)
	for _, phase := range []update.Phase{update.Failed, update.RolledBack} {
		for _, code := range append(cases, "download_corrupt") {
			t.Run(string(phase)+"/"+code, func(t *testing.T) {
				w := testworld.New(t)
				mustOffer(t, w, testworld.RuntimeGood, update.DecisionStarted)
				w.Run(50, testworld.PhaseIs(update.Staged))
				st := w.State()
				c := st.Candidate
				c.Attempts = w.Policy.MaxAttempts
				c.Failure = &update.Failure{Stage: update.Staged, Code: code, Message: "injected", At: w.Clock.Now(), CountsAttempt: true,
					NextRetry: w.Clock.Now(), Release: testworld.RuntimeGood}
				st.Phase, st.LastFailure = phase, c.Failure
				if err := w.Engine.J.Save(st); err != nil {
					t.Fatal(err)
				}
				w.Run(20, func(st *update.State) bool { return st.Phase != phase })
				st = w.State()
				_, quarantined := st.Quarantine[testworld.RuntimeGood]
				if release.IsRetryableUpdateFailure(code) {
					if quarantined || st.Phase != update.Assigned {
						t.Fatalf("a retryable %s: phase %s quarantine %+v", code, st.Phase, st.Quarantine)
					}
					w.Run(400, testworld.PhaseIs(update.Healthy))
				} else if !quarantined || st.Phase != update.Quarantined {
					t.Fatalf("%s: phase %s, not quarantined", code, st.Phase)
				}
			})
		}
	}
}

// The helper goes away after the migration ran: the activation is deferred, the known-good release can't use the
// migrated database, so the box needs forward repair — but the cause is retryable, so the candidate isn't quarantined
// and assigning it again (control's “Retry this Whombat”) finishes the update.
func TestForwardRepairForARetryableCauseKeepsTheRelease(t *testing.T) {
	t.Parallel()
	w := testworld.New(t)
	mustOffer(t, w, testworld.PastFloors, update.DecisionStarted)
	w.Run(400, func(st *update.State) bool {
		return st.Candidate != nil && st.Candidate.Schema != nil && st.Candidate.Schema.Migrated
	})
	w.Helper.Stop()
	w.Run(2000, testworld.PhaseIs(update.ForwardRepairRequired))
	st := w.State()
	f := st.Candidate.Failure
	if _, q := st.Quarantine[testworld.PastFloors]; q || f.Code != "forward_repair_required" || strings.Join(f.Reasons, ",") != "activation_deferred" ||
		!strings.Contains(f.Message, "is not quarantined") {
		t.Fatalf("forward repair %+v quarantine %+v", f, st.Quarantine)
	}
	w.RestartHelper()
	mustOffer(t, w, testworld.PastFloors, update.DecisionStarted)
	w.Run(400, testworld.PhaseIs(update.Healthy, update.Quarantined))
	if st := w.State(); st.Phase != update.Healthy || st.Current.ReleaseID != testworld.PastFloors || w.Helper.DBSchema() != 11 {
		t.Fatalf("phase %s current %s schema %d", st.Phase, st.Current.ReleaseID, w.Helper.DBSchema())
	}
}
