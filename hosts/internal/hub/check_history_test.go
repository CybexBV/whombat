package hub

import (
	"context"
	"net/http"
	"net/url"
	"testing"
	"time"

	"rackoon/internal/hub/store"
	"rackoon/internal/proto"
)

func TestCheckDetailPeriodIncludesRecoveredFailures(t *testing.T) {
	e, admin := adminEnv(t, nil)
	e.enroll(admin, "basalt", "Lab")
	ctx, now := context.Background(), e.h.now().Truncate(time.Second)
	e.h.mu.Lock()
	e.h.servers["basalt"].reportAt = now
	e.h.mu.Unlock()

	var added checkJSON
	admin.json(http.MethodPost, "/api/v1/checks", map[string]any{
		"name": "Site", "kind": "http", "target": "https://example.com", "runner": "basalt",
	}, http.StatusCreated, &added)
	check, ok := e.h.checkByID(added.ID)
	if !ok {
		t.Fatal("check not found")
	}
	for _, result := range []proto.CheckResult{
		{ID: check.ID, At: now.Add(-4 * time.Minute), OK: true},
		{ID: check.ID, At: now.Add(-3 * time.Minute)},
		{ID: check.ID, At: now.Add(-2 * time.Minute)},
		{ID: check.ID, At: now.Add(-time.Minute), OK: true},
	} {
		e.h.recordCheck(ctx, check, checkObservation{result: result}, nil)
	}
	for _, test := range []struct {
		start time.Duration
		end   time.Duration
		want  string
	}{
		{-5 * time.Minute, 0, "down"},
		{-2 * time.Minute, -time.Minute, "up"},
		{-time.Minute, 0, "unseen"},
		{-5 * time.Minute, -3 * time.Minute, "down"},
	} {
		q := url.Values{
			"since": {now.Add(test.start).Format(time.RFC3339)},
			"until": {now.Add(test.end).Format(time.RFC3339)},
		}
		var detail checkJSON
		admin.json(http.MethodGet, "/api/v1/checks/"+check.ID+"?"+q.Encode(), nil, http.StatusOK, &detail)
		if detail.Status != "up" || detail.PeriodStatus != test.want {
			t.Fatalf("got status %q, period %q, wanted up and %s", detail.Status, detail.PeriodStatus, test.want)
		}
	}
}

func TestServerDetailUsesEarliestRetainedReport(t *testing.T) {
	e, admin := adminEnv(t, nil)
	fa := e.enroll(admin, "basalt", "Lab")
	ctx := context.Background()
	first := e.h.now().Add(-5*time.Hour - 17*time.Second).Truncate(time.Second)
	_, _, err := e.h.store.InsertSamples(ctx, "basalt", []store.Sample{
		{TS: first.Unix(), Values: map[string]float64{proto.SeriesCPU: 25}},
	})
	if err != nil {
		t.Fatal(err)
	}
	e.h.ingestReport(ctx, "basalt", fa.report("basalt"))
	var detail struct {
		Server struct {
			FirstReportAt string `json:"first_report_at"`
		} `json:"server"`
	}
	admin.json(http.MethodGet, "/api/v1/servers/basalt", nil, http.StatusOK, &detail)
	if want := first.UTC().Format(time.RFC3339); detail.Server.FirstReportAt != want {
		t.Fatalf("first report %q, wanted %q", detail.Server.FirstReportAt, want)
	}
}
