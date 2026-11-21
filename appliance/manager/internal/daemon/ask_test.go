package daemon_test

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/manager/internal/config"
	"github.com/CybexBV/whombat/appliance/manager/internal/controlapi/fakecontrol"
	"github.com/CybexBV/whombat/appliance/manager/internal/testworld"
	"github.com/CybexBV/whombat/appliance/manager/internal/update"
	"github.com/CybexBV/whombat/contracts/go/device"
	"github.com/CybexBV/whombat/contracts/go/local"
	"github.com/CybexBV/whombat/contracts/go/release"
)

// Ask before updating through the running daemon (Whombat ask-before-updating.md): an update waiting for the owner
// reaches control as a hold, never as `owner`, while the runtime hears the reason; the owner's approval through the
// local API installs it.
func TestAnOwnerWaitReachesControlAsAHold(t *testing.T) {
	t.Parallel()
	h := startDaemon(t, nil, func(w *testworld.World, fc *fakecontrol.Control, c *config.Config) {
		fc.NextReportS = 1
		if err := w.Engine.SetAskFirst(true); err != nil {
			t.Fatal(err)
		}
	})
	w, fc := h.w, h.fc
	raw, _ := w.Repo.Assign("dev-1", testworld.RuntimeGood, 1, 24*time.Hour)
	fc.SetAssignment(raw)
	h.waitFor("waiting for the owner", func(st *update.State) bool {
		return st.Candidate != nil && st.Candidate.Deferral != nil && st.Candidate.Deferral.Waiting == "owner"
	})
	h.eventually("update.progress of the wait at control", func() bool {
		p, n := fc.LastProgress()
		return n > 0 && p.State == update.Staged && p.Waiting != nil
	}, func() string { p, n := fc.LastProgress(); return fmt.Sprintf("%d reports, last %+v", n, p) })
	var rep device.StatusReportRequest
	h.eventually("status.report of the wait at control", func() bool {
		reps := fc.StatusReports()
		if len(reps) == 0 {
			return false
		}
		rep = reps[len(reps)-1]
		return rep.Update.State == update.Staged && rep.Update.Waiting != nil
	}, func() string { return fmt.Sprintf("%s; last status %+v", h.journal(), rep.Update) })
	if p, _ := fc.LastProgress(); p.Waiting.Reason != release.UpdateWaitReasonHold || rep.Update.Waiting.Reason != release.UpdateWaitReasonHold {
		t.Fatalf("control hears progress %+v status %+v, want a hold", p.Waiting, rep.Update.Waiting)
	}
	h.eventually("the owner's facts at the runtime", func() bool {
		f := w.Runtime.Facts()
		return f != nil && f.Update != nil && f.Update.Waiting != nil && f.Update.Waiting.Reason == release.UpdateWaitReasonOwner &&
			f.Update.AskFirst != nil && *f.Update.AskFirst
	}, func() string { return fmt.Sprintf("%+v", w.Runtime.Facts()) })

	// The owner approves it through the runtime: it installs.
	c := &http.Client{Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		var d net.Dialer
		return d.DialContext(ctx, "unix", h.cfg.APISocket)
	}}}
	resp, err := c.Post("http://manager"+local.ManagerPathUpdateApprove, "application/json",
		strings.NewReader(`{"v":1,"release":"`+testworld.RuntimeGood+`"}`))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("approve: %d", resp.StatusCode)
	}
	h.waitFor("the approved update installed", func(st *update.State) bool {
		return st.Phase == update.Healthy && st.Current.ReleaseID == testworld.RuntimeGood
	})
	var sent []device.UpdateProgressRequest
	fc.Set(func(c *fakecontrol.Control) { sent = append(sent, c.Progress...) })
	for _, p := range sent {
		if p.Waiting != nil && p.Waiting.Reason == release.UpdateWaitReasonOwner {
			t.Fatalf("control heard the owner's reason: %+v", p)
		}
	}
	for _, r := range fc.StatusReports() {
		if r.Update.Waiting != nil && r.Update.Waiting.Reason == release.UpdateWaitReasonOwner {
			t.Fatalf("control heard the owner's reason: %+v", r.Update)
		}
	}
}
