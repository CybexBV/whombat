package daemon_test

import (
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/manager/internal/config"
	"github.com/CybexBV/whombat/appliance/manager/internal/controlapi/fakecontrol"
	"github.com/CybexBV/whombat/appliance/manager/internal/testworld"
	"github.com/CybexBV/whombat/appliance/manager/internal/update"
	"github.com/CybexBV/whombat/contracts/go/device"
	"github.com/CybexBV/whombat/contracts/go/release"
)

// MG-46 through the running daemon: a candidate that fails its schema check reaches control as update.progress with
// the structured detail, status.report carries it and the running runtime's version, and the runtime gets the owner's
// facts.
func TestFailureDetailReachesControl(t *testing.T) {
	t.Parallel()
	h := startDaemon(t, nil, func(w *testworld.World, fc *fakecontrol.Control, c *config.Config) {
		fc.NextReportS = 1
	})
	w, fc := h.w, h.fc
	raw, _ := w.Repo.Assign("dev-1", testworld.NoFloors, 1, 24*time.Hour)
	fc.SetAssignment(raw)
	var failed device.UpdateProgressRequest
	h.eventually("update.progress Failed at control", func() bool {
		p, n := fc.LastProgress()
		failed = p
		return n > 0 && p.State == update.Failed
	}, func() string { p, n := fc.LastProgress(); return fmt.Sprintf("%d reports, last %+v", n, p) })
	var rep device.StatusReportRequest
	h.eventually("status.report of the quarantined release at control", func() bool {
		reps := fc.StatusReports()
		if len(reps) == 0 {
			return false
		}
		rep = reps[len(reps)-1]
		return rep.Update.State == update.Quarantined // the retries are quick here
	}, h.journal)
	if failed.Failure == nil || *failed.Failure != "schema_incompatible" || rep.Update.Failure == nil {
		t.Fatalf("progress %+v status %+v", failed, rep)
	}
	d := failed.FailureDetail
	if d == nil || d.Code != "schema_incompatible" || strings.Join(d.Reasons, ",") != "candidate_cannot_read_schema" ||
		d.Release != testworld.NoFloors || d.Schema == nil || d.Schema.Database != 10 || d.Schema.CandidateWrites != 11 {
		t.Fatalf("progress detail %+v", d)
	}
	if rep.Update.FailureDetail == nil || rep.Update.FailureDetail.Code != "schema_incompatible" || rep.RuntimeVersion == nil ||
		*rep.RuntimeVersion != "1.0.0" {
		t.Fatalf("status %+v", rep)
	}
	h.eventually("the owner's facts at the runtime", func() bool {
		f := w.Runtime.Facts()
		return f != nil && f.Update != nil && f.Update.FailureDetail != nil && f.Update.FailureDetail.Release == testworld.NoFloors
	}, func() string { return fmt.Sprintf("%+v", w.Runtime.Facts()) })
}

// MG-53: a candidate that waits (here for a checkpoint: this box has no backup service) shows it at control, in
// update.progress and status.report, with the reason and since when.
func TestWaitingReachesControl(t *testing.T) {
	t.Parallel()
	h := startDaemon(t, nil, func(w *testworld.World, fc *fakecontrol.Control, c *config.Config) {
		fc.NextReportS = 1
	})
	w, fc := h.w, h.fc
	raw, _ := w.Repo.Assign("dev-1", testworld.ContractFloors, 1, 24*time.Hour)
	fc.SetAssignment(raw)
	h.waitFor("waiting for a checkpoint", func(st *update.State) bool {
		return st.Candidate != nil && st.Candidate.Deferral != nil && st.Candidate.Deferral.Waiting == "checkpoint"
	})
	h.eventually("update.progress of the wait at control", func() bool {
		p, n := fc.LastProgress()
		return n > 0 && p.State == update.WaitingForSafeBoundary && p.Waiting != nil
	}, func() string { p, n := fc.LastProgress(); return fmt.Sprintf("%d reports, last %+v", n, p) })
	var rep device.StatusReportRequest
	h.eventually("status.report of the wait at control", func() bool {
		reps := fc.StatusReports()
		if len(reps) == 0 {
			return false
		}
		rep = reps[len(reps)-1]
		return rep.Update.State == update.WaitingForSafeBoundary && rep.Update.Waiting != nil
	}, func() string { return fmt.Sprintf("%s; last status %+v", h.journal(), rep.Update) })
	p, _ := fc.LastProgress()
	if p.Waiting.Reason != release.UpdateWaitReasonCheckpoint || rep.Update.Waiting.Reason != release.UpdateWaitReasonCheckpoint ||
		p.Waiting.Since <= 0 || rep.Update.Waiting.Since != p.Waiting.Since {
		t.Fatalf("waiting: progress %+v status %+v", p.Waiting, rep.Update.Waiting)
	}
}
