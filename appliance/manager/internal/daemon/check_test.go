package daemon_test

import (
	"context"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/manager/internal/broker"
	"github.com/CybexBV/whombat/appliance/manager/internal/config"
	"github.com/CybexBV/whombat/appliance/manager/internal/controlapi/fakecontrol"
	"github.com/CybexBV/whombat/appliance/manager/internal/testworld"
	"github.com/CybexBV/whombat/appliance/manager/internal/update"
)

// TestCheckTakesAnUpdateAtOnce (MG-67, MG-68): with control's next poll and the engine's idle step an hour away,
// `whombat-manager check` polls control at once, and the engine takes the assignment that poll accepted at once: the
// box is Healthy on the update within seconds. A second check finds nothing new.
func TestCheckTakesAnUpdateAtOnce(t *testing.T) {
	t.Parallel()
	h := startDaemon(t, map[string]any{
		"pollSec": 3600,
		"policy": map[string]any{"healthIntervalMs": 50, "verifyTimeoutMs": 120000, "drainPollMs": 50, "retryBaseMs": 200,
			"idleIntervalMs": 3_600_000, "healthyStreak": 2},
	}, func(_ *testworld.World, fc *fakecontrol.Control, _ *config.Config) { fc.NextCheckS = 3600 })
	h.eventually("the manager's first poll", func() bool { return h.fc.AssignmentCount() >= 1 }, h.journal)
	raw, _ := h.w.Repo.Assign("dev-1", testworld.RuntimeGood, 1, 24*time.Hour)
	h.fc.SetAssignment(raw)

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	res, err := broker.Check(ctx, h.cfg.APISocket)
	if err != nil || res.Result != "assigned" || res.Decision != string(update.DecisionStarted) || res.NextCheckS != 3600 {
		t.Fatalf("check: %+v %v", res, err)
	}
	// Far inside the engine's idle hour: only the wake gets it there.
	deadline := time.Now().Add(45 * time.Second)
	for {
		st, err := h.d.Engine.Load()
		if err == nil && st.Phase == update.Healthy && st.Current.ReleaseID == testworld.RuntimeGood {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("not Healthy on %s 45 s after the check: %s", testworld.RuntimeGood, h.journal())
		}
		time.Sleep(50 * time.Millisecond)
	}
	if res, err := broker.Check(ctx, h.cfg.APISocket); err != nil || res.Result != "unchanged" || res.Decision != "" {
		t.Fatalf("second check: %+v %v", res, err)
	}
}
