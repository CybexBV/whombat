package update_test

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/manager/internal/testworld"
	"github.com/CybexBV/whombat/appliance/manager/internal/update"
	"github.com/CybexBV/whombat/appliance/release-tools/devtuf"
)

// MG-55: a host rollback whose helper step keeps failing is retried with a backoff (5 s doubling to 10 min) kept in
// the journal, so a manager restart doesn't start a tight loop; it never gives up, the state stays Verifying with the
// rollback in progress and its detail says it is retrying; once the step works the box is back on known-good.
func TestFailingHostRollbackBacksOff(t *testing.T) {
	t.Parallel()
	w := testworld.New(t)
	bad := devtuf.StandardRelease("rt-30-host-bad", "26.05.4", "1.4.0-bad")
	bad.RuntimeHealth = "bad"
	publish(t, w, bad)
	mustOffer(t, w, bad.ID, update.DecisionStarted)
	w.Run(600, func(st *update.State) bool { return st.Candidate != nil && st.Candidate.Rollback != nil })
	if st := w.State(); st.Phase != update.Verifying || st.Candidate.Class != update.ClassHost {
		t.Fatalf("phase %s class %s", st.Phase, st.Candidate.Class)
	}
	w.Helper.SetFail("set-boot", errors.New("bootloader busy"))
	var delays []time.Duration
	w.Engine.OnTransition = func(st update.State) {
		if rb := st.Candidate.Rollback; rb != nil && rb.StepFailures > len(delays) {
			delays = append(delays, rb.NextStepAt.Sub(w.Clock.Now()))
		}
	}
	w.Run(2000, func(st *update.State) bool { return st.Candidate.Rollback.StepFailures >= 10 })
	want := []time.Duration{5, 10, 20, 40, 80, 160, 320, 600, 600, 600}
	if len(delays) != len(want) {
		t.Fatalf("delays %v", delays)
	}
	for i, d := range want {
		if delays[i] != d*time.Second {
			t.Fatalf("delay %d is %v, want %v (all %v)", i+1, delays[i], d*time.Second, delays)
		}
	}
	st := w.State()
	if st.Phase != update.Verifying || st.Candidate.Tuple.ReleaseID != bad.ID || st.KnownGood.ReleaseID != testworld.Factory {
		t.Fatalf("phase %s candidate %s", st.Phase, st.Candidate.Tuple.ReleaseID)
	}
	if d := update.FailureDetail(st); d == nil || d.Code != "unhealthy" || strings.Join(d.Reasons, ",") != "rollback_retrying" || d.Stage != update.Verifying {
		t.Fatalf("detail %+v", d)
	}
	// A manager restart keeps the backoff: the next step waits instead of trying again at once (the run above ended
	// by moving the clock to the next try; a minute after the last one here).
	w.Clock.Set(st.Candidate.Rollback.NextStepAt.Add(-9 * time.Minute))
	w.NewEngine()
	wait, err := w.Engine.Step(t.Context())
	if err != nil || wait != 9*time.Minute || w.State().Candidate.Rollback.StepFailures != 10 {
		t.Fatalf("after restart: wait %v err %v failures %d", wait, err, w.State().Candidate.Rollback.StepFailures)
	}
	// The step works again: back on known-good, healthy.
	w.Helper.SetFail("set-boot", nil)
	w.Run(600, testworld.PhaseIs(update.RolledBack))
	st = w.State()
	if st.Current.ReleaseID != testworld.Factory || st.Candidate.Failure.Code != "unhealthy" {
		t.Fatalf("current %s failure %+v", st.Current.ReleaseID, st.Candidate.Failure)
	}
	factoryRunning(t, w)
}
