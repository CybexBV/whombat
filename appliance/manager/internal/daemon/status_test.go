package daemon_test

import (
	"fmt"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/manager/internal/config"
	"github.com/CybexBV/whombat/appliance/manager/internal/controlapi/fakecontrol"
	"github.com/CybexBV/whombat/appliance/manager/internal/testworld"
	"github.com/CybexBV/whombat/appliance/manager/internal/update"
)

// MG-61: control's device record shows an update's outcome within seconds of the transition, not at the next periodic
// status.report (control asks for one every 15 minutes; here an hour).
func TestStatusReportFollowsTransitions(t *testing.T) {
	t.Parallel()
	h := startDaemon(t, map[string]any{"statusReportSec": 3600}, func(_ *testworld.World, fc *fakecontrol.Control, _ *config.Config) {
		fc.NextReportS = 3600
	})
	w, fc := h.w, h.fc
	h.eventually("the start-up status.report", func() bool { return len(fc.StatusReports()) > 0 }, func() string { return "none" })
	raw, _ := w.Repo.Assign("dev-1", testworld.RuntimeGood, 1, 24*time.Hour)
	fc.SetAssignment(raw)
	h.waitFor("rt-2 healthy", func(st *update.State) bool {
		return st.Phase == update.Healthy && st.Current != nil && st.Current.ReleaseID == testworld.RuntimeGood
	})
	healthyAt := time.Now()
	last := func() string {
		reps := fc.StatusReports()
		if len(reps) == 0 {
			return "none"
		}
		r := reps[len(reps)-1]
		return fmt.Sprintf("%d reports, last %s %s", len(reps), r.Release, r.Update.State)
	}
	h.eventually("status.report of rt-2 Healthy", func() bool {
		reps := fc.StatusReports()
		if len(reps) == 0 {
			return false
		}
		r := reps[len(reps)-1]
		return r.Release == testworld.RuntimeGood && r.Update.State == update.Healthy
	}, last)
	if d := time.Since(healthyAt); d > 30*time.Second {
		t.Fatalf("Healthy reached control's device record %s after the transition", d)
	}
}
