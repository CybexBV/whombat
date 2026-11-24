package hub

import (
	"context"
	"net/http"
	"testing"
	"time"

	"rackoon/internal/proto"
	"rackoon/internal/rules"
)

func TestStaleCheckKeepsLastResultAndHoldsAlerts(t *testing.T) {
	e, admin := adminEnv(t, nil)
	e.enroll(admin, "basalt", "Lab")
	var check checkJSON
	admin.json(http.MethodPost, "/api/v1/checks", map[string]any{
		"name": "Example", "kind": "http", "target": "https://example.com", "runner": "basalt",
		"interval_s": 300, "options": map[string]any{"keyword": "Welcome", "cert_warn_days": 14},
	}, 201, &check)
	ctx, now := context.Background(), e.h.now()

	setReported := func(at, gap time.Time) {
		e.h.mu.Lock()
		defer e.h.mu.Unlock()
		s := e.h.servers["basalt"]
		s.reportAt, s.reportGapAt = at, gap
	}
	result := func(at time.Time, ok bool) {
		latency := 23.5
		cert := now.Add(30 * 24 * time.Hour)
		e.h.checkResult(ctx, "basalt", proto.CheckResult{ID: check.ID, At: at, OK: ok, LatencyMs: &latency, CertNotAfter: &cert})
	}
	status := func(want string, stale bool) {
		t.Helper()
		admin.json(http.MethodGet, "/api/v1/checks/"+check.ID, nil, 200, &check)
		if check.Status != want || check.Stale != stale || check.Last == nil || check.Last.LatencyMs == nil ||
			*check.Last.LatencyMs != 23.5 || check.Last.CertNotAfter == nil {
			t.Fatalf("check: %+v", check)
		}
	}
	alerts := func(want int) {
		t.Helper()
		e.h.evaluateCheckAlerts(ctx)
		n := 0
		for _, a := range e.h.alerts.Open("") {
			if a.Rule == RuleCheckDown && a.Entity == "check:"+check.ID {
				n++
			}
		}
		if n != want {
			t.Fatalf("down alerts: %d, wanted %d", n, want)
		}
	}

	offline := now.Add(-2 * time.Minute)
	setReported(offline, time.Time{})
	result(now.Add(-4*time.Second), false)
	result(now.Add(-3*time.Second), false)
	status("pending", true)
	alerts(0)
	// A reporting runner provides two failures and opens an alert.
	setReported(now, time.Time{})
	result(now.Add(-2*time.Second), false)
	result(now.Add(-time.Second), false)
	status("down", false)
	alerts(1)
	// As its reports stop, the alert stays put and the time remains available.
	setReported(offline, time.Time{})
	status("pending", true)
	if check.Last.At != now.Add(-time.Second).UTC().Format(time.RFC3339) {
		t.Fatalf("lost last timestamp: %+v", check.Last)
	}
	alerts(1)
	// Reports alone don't make the previous result fresh.
	setReported(now, now)
	status("pending", true)
	alerts(1)
	result(now, true)
	status("up", false)
	alerts(0)
	checkPath := "/api/v1/checks/" + check.ID
	admin.json(http.MethodPatch, checkPath, map[string]any{"target": "https://example.org"}, 200, &check)
	if check.Last != nil || check.Status != "pending" {
		t.Fatalf("the previous target's result survived an edit: %+v", check)
	}
	result(now.Add(time.Second), true)
	admin.json(http.MethodGet, checkPath, nil, 200, &check)
	if check.Last != nil {
		t.Fatalf("the previous target's result came back: %+v", check)
	}
	cNew, _ := e.h.checkByID(check.ID)
	e.h.checkResult(ctx, "basalt", proto.CheckResult{ID: probeID(cNew), At: now.Add(time.Second), OK: true})
	admin.json(http.MethodGet, checkPath, nil, 200, &check)
	if check.Status != "up" || check.Last == nil {
		t.Fatalf("the new target's result was not accepted: %+v", check)
	}

	var owned checkJSON
	admin.json(http.MethodPost, "/api/v1/checks", map[string]any{
		"name": "Example backup", "kind": "heartbeat", "interval_s": 900, "grace_s": 60, "owner": "whombat:connection:example",
	}, 201, &owned)
	if owned.Owner != "whombat:connection:example" || owned.PingURL == nil {
		t.Fatalf("owned check: %+v", owned)
	}
	admin.json(http.MethodPatch, "/api/v1/checks/"+owned.ID, map[string]any{"interval_s": 60}, 200, &owned)
	if owned.Owner != "whombat:connection:example" || owned.IntervalS != 60 {
		t.Fatalf("owned check after patch: %+v", owned)
	}
	c, _ := e.h.checkByID(owned.ID)
	e.h.recordCheck(ctx, c, proto.CheckResult{ID: c.ID, At: now, OK: false}, nil)
	e.h.evaluateCheckAlerts(ctx)
	for _, a := range e.h.alerts.Open("") {
		if a.Entity == "check:"+owned.ID {
			t.Fatalf("connection has a hub alert: %+v", a)
		}
	}
}

func TestWatchLimitsPersistAndClearAtTheirScope(t *testing.T) {
	e, admin := adminEnv(t, nil)
	e.enroll(admin, "basalt", "Lab")
	path := "/api/v1/servers/basalt/watch"
	var settings watchJSON
	put := func(entity string, value, expected any, status int) {
		t.Helper()
		var out any
		if status == 200 {
			out = &settings
		}
		admin.json(http.MethodPut, path, map[string]any{
			"rule": rules.RuleSpaceHigh, "entity": entity, "limit": value, "expected_limit": expected,
		}, status, out)
	}
	put("", 95, nil, 200)
	put("fs:/srv", 99, nil, 200)
	put("fs:/srv", 101, 99, 400)
	put("fs:/srv", nil, 90, 409)
	if err := e.h.reloadWatch(context.Background()); err != nil {
		t.Fatal(err)
	}
	check := func(entity string, want float64) {
		t.Helper()
		got, ok := e.h.watch.limitsFor("basalt")(rules.RuleSpaceHigh, entity)
		if !ok || got != want {
			t.Fatalf("%s: got %v, wanted %v", entity, got, want)
		}
	}
	check("fs:/srv", 99)
	check("fs:/other", 95)
	put("fs:/srv", nil, 99, 200)
	check("fs:/srv", 95)
	admin.json(http.MethodGet, path, nil, 200, &settings)
	if len(settings.Limits) != 1 || len(settings.Rules) != 0 || len(e.audit("server.watch_changed")) != 3 {
		t.Fatalf("watch settings: %+v", settings)
	}
}

func TestGuestStopAfterHubActionIsQuiet(t *testing.T) {
	e, admin := adminEnv(t, nil)
	e.enroll(admin, "basalt", "Lab")
	ctx := context.Background()
	autostart, code, finished := true, 137, e.h.now()
	report := &proto.Report{At: finished, Docker: &proto.Platform{
		Guests: []proto.Guest{{ID: "photos", State: proto.StateStopped, Autostart: &autostart,
			OOMKilled: true, ExitCode: &code, FinishedAt: &finished}},
	}}
	check := func(want int) {
		t.Helper()
		e.h.ingestReport(ctx, "basalt", report)
		n := 0
		for _, a := range e.h.alerts.Open("basalt") {
			if a.Rule == rules.RuleGuestStopped {
				n++
			}
		}
		if n != want {
			t.Fatalf("stop alerts: %d, wanted %d", n, want)
		}
	}
	e.h.notePlannedStop("basalt", "docker:photos", proto.ActionStop)
	check(0)
	finished = finished.Add(3 * time.Minute)
	check(1)
	check(1)
	report.Docker.Error = "Docker didn't answer"
	report.Docker.Guests = nil
	check(1)
	report.Docker.Error = ""
	check(0)
}
