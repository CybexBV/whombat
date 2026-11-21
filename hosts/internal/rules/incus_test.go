package rules

import (
	"testing"
	"time"

	"rackoon/internal/proto"
)

func TestIncusNoSnapshotsHint(t *testing.T) {
	at := time.Date(2026, 10, 30, 8, 0, 0, 0, time.UTC)
	week, hour := at.Add(-7*24*time.Hour), at.Add(-time.Hour)
	r := &proto.Report{At: at, Incus: &proto.Platform{Guests: []proto.Guest{
		{ID: "web", Name: "web", State: proto.StateRunning, CreatedAt: &week},
		{ID: "db", Name: "db", State: proto.StateRunning, CreatedAt: &week},
		{ID: "dns", Name: "dns", State: proto.StateRunning, CreatedAt: &week, SnapshotSchedule: "@daily"},
		{ID: "new", Name: "new", State: proto.StateRunning, CreatedAt: &hour},
		// Another project's instances are a tool's (CI, agents' sandboxes), not the person's.
		{ID: "agent-tasks/agent-1", Name: "agent-1", State: proto.StateRunning, CreatedAt: &week},
		{ID: "ci/job-1", Name: "job-1", State: proto.StateRunning, CreatedAt: &week},
	}}}
	h := incusHints(r, at)
	if len(h) != 1 || h[0].Kind != HintIncusNoSnapshots {
		t.Fatalf("hints = %+v", h)
	}
	if h[0].Title != "2 machines aren’t backed up" || h[0].Detail != "web, db · no scheduled snapshots, no backup in 30 days" ||
		len(h[0].Guests) != 2 || h[0].Guests[0] != "incus:web" {
		t.Errorf("hint = %+v", h[0])
	}
	r.Incus.Guests = r.Incus.Guests[1:]
	if h := incusHints(r, at); len(h) != 1 || h[0].Title != "1 machine isn’t backed up" {
		t.Errorf("one = %+v", h)
	}
}
