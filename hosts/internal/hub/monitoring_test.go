package hub

import (
	"context"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"rackoon/internal/checks"
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
		e.h.checkResults(ctx, "basalt", []proto.CheckResult{{ID: check.ID, At: at, OK: ok, LatencyMs: &latency, CertNotAfter: &cert}})
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
	e.h.checkResults(ctx, "basalt", []proto.CheckResult{{ID: probeID(cNew), At: now.Add(time.Second), OK: true}})
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
	e.h.recordCheck(ctx, c, checkObservation{result: proto.CheckResult{ID: c.ID, At: now, OK: false}}, nil)
	e.h.evaluateCheckAlerts(ctx)
	for _, a := range e.h.alerts.Open("") {
		if a.Entity == "check:"+owned.ID {
			t.Fatalf("connection has a hub alert: %+v", a)
		}
	}
}

func TestCheckEditsStartFreshAndResolvePreviousAlerts(t *testing.T) {
	start := time.Now().UTC().Truncate(time.Second)
	var clock atomic.Pointer[time.Time]
	clock.Store(&start)
	e, admin := adminEnv(t, func(c *Config) { c.Now = func() time.Time { return *clock.Load() } })
	e.enroll(admin, "basalt", "Lab")
	ctx := context.Background()
	advance := func(at time.Time) { clock.Store(&at) }
	report := func(checks ...proto.CheckResult) {
		e.h.ingestReport(ctx, "basalt", &proto.Report{At: e.h.now(), Checks: checks})
	}
	create := func() checkJSON {
		t.Helper()
		var check checkJSON
		admin.json(http.MethodPost, "/api/v1/checks", map[string]any{
			"name": "Website", "kind": "http", "target": "https://example.com", "runner": "basalt",
		}, 201, &check)
		return check
	}
	original := create()
	cert := start.Add(48 * time.Hour)
	report(proto.CheckResult{ID: original.ID, At: start, OK: true, CertNotAfter: &cert})
	e.h.evaluateCheckAlerts(ctx)
	open := e.h.alerts.Open("")
	if len(open) != 1 || open[0].Rule != RuleCheckCert {
		t.Fatalf("expected certificate alert, got %+v", open)
	}

	editAt := start.Add(10 * time.Minute)
	advance(editAt)
	report()
	var edited checkJSON
	path := "/api/v1/checks/" + original.ID
	admin.json(http.MethodGet, path, nil, 200, &edited)
	if !edited.Stale || edited.Last == nil {
		t.Fatalf("previous result should be stale: %+v", edited)
	}
	fresh := create()
	if fresh.Stale || fresh.Status != "pending" || fresh.Last != nil {
		t.Fatalf("new check after a gap: %+v", fresh)
	}
	admin.json(http.MethodPatch, path, map[string]any{"target": "https://example.org"}, 200, &edited)
	if edited.Stale || edited.Status != "pending" || edited.Last != nil {
		t.Fatalf("edited check after a gap: %+v", edited)
	}
	if _, ok := e.h.alerts.Find(open[0].ID); ok {
		t.Fatal("the edited target's certificate alert is still open")
	}
	stored, err := e.h.store.ListChecks(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for _, check := range stored {
		if !check.ProbeChangedAt.Equal(editAt) {
			t.Fatalf("check %s has probe time %s, want %s", check.ID, check.ProbeChangedAt, editAt)
		}
	}
	advance(editAt.Add(e.h.cfg.HeartbeatTimeout + time.Second))
	admin.json(http.MethodGet, path, nil, 200, &edited)
	if !edited.Stale {
		t.Fatalf("a gap after the edit should count: %+v", edited)
	}
}

func TestCheckResultFreshnessCorrectsBothClockDirections(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	e, admin := adminEnv(t, func(c *Config) { c.Now = func() time.Time { return now } })
	e.enroll(admin, "basalt", "Lab")
	ctx := context.Background()
	for _, skew := range []float64{45, -45} {
		e.h.mu.Lock()
		s := e.h.servers["basalt"]
		s.skew, s.reportAt, s.reportGapAt = &skew, now, now.Add(-30*time.Second)
		e.h.mu.Unlock()
		var check checkJSON
		admin.json(http.MethodPost, "/api/v1/checks", map[string]any{
			"name": "Website", "kind": "http", "target": "https://example.com", "runner": "basalt",
		}, 201, &check)
		read := func(age time.Duration, wantStale bool) {
			t.Helper()
			at := now.Add(-age)
			e.h.checkResults(ctx, "basalt", []proto.CheckResult{{
				ID: check.ID, At: at.Add(time.Duration(skew) * time.Second), OK: true,
			}})
			admin.json(http.MethodGet, "/api/v1/checks/"+check.ID, nil, 200, &check)
			if check.Stale != wantStale || check.Last == nil || check.Last.At != at.Format(time.RFC3339) {
				t.Fatalf("skew %v, age %s: %+v, last %+v", skew, age, check, check.Last)
			}
		}
		read(40*time.Second, true)
		read(10*time.Second, false)
	}
}

func TestHeartbeatFirstDeadlineStartsAtKindChange(t *testing.T) {
	start := time.Now().UTC().Truncate(time.Second)
	var clock atomic.Pointer[time.Time]
	clock.Store(&start)
	e, admin := adminEnv(t, func(c *Config) { c.Now = func() time.Time { return *clock.Load() } })
	e.enroll(admin, "basalt", "Lab")
	var check checkJSON
	admin.json(http.MethodPost, "/api/v1/checks", map[string]any{
		"name": "Website", "kind": "http", "target": "https://example.com", "runner": "basalt",
	}, 201, &check)
	editAt := start.Add(24 * time.Hour)
	clock.Store(&editAt)
	path := "/api/v1/checks/" + check.ID
	admin.json(http.MethodPatch, path, map[string]any{"kind": "heartbeat", "interval_s": 60, "grace_s": 15}, 200, &check)
	status := func(elapsed time.Duration, want string) {
		t.Helper()
		at := editAt.Add(elapsed)
		clock.Store(&at)
		e.h.heartbeatChecks(context.Background())
		admin.json(http.MethodGet, path, nil, 200, &check)
		if check.Status != want {
			t.Fatalf("after %s: status %s, want %s", elapsed, check.Status, want)
		}
	}
	status(0, "pending")
	status(75*time.Second, "pending")
	status(76*time.Second, "down")
}

func TestResumedHeartbeatGetsFullDeadline(t *testing.T) {
	start := time.Now().UTC().Truncate(time.Second)
	var clock atomic.Pointer[time.Time]
	clock.Store(&start)
	e, admin := adminEnv(t, func(c *Config) {
		c.Now = func() time.Time { return *clock.Load() }
		c.PublicURL = "https://example.com"
	})
	var check checkJSON
	admin.json(http.MethodPost, "/api/v1/checks", map[string]any{
		"name": "Backup", "kind": "heartbeat", "interval_s": 60, "grace_s": 15,
	}, http.StatusCreated, &check)
	if check.PingURL == nil {
		t.Fatal("missing ping URL")
	}
	ping, err := url.Parse(*check.PingURL)
	if err != nil {
		t.Fatal(err)
	}
	if code, _, _ := admin.req(http.MethodGet, ping.Path, nil, nil); code != http.StatusOK {
		t.Fatalf("first ping: HTTP %d", code)
	}
	path := "/api/v1/checks/" + check.ID
	admin.json(http.MethodPatch, path, map[string]any{"enabled": false}, http.StatusOK, &check)
	resumed := start.Add(24 * time.Hour)
	clock.Store(&resumed)
	admin.json(http.MethodPatch, path, map[string]any{"enabled": true}, http.StatusOK, &check)
	for _, tc := range []struct {
		elapsed time.Duration
		want    string
	}{{0, "pending"}, {75 * time.Second, "pending"}, {76 * time.Second, "down"}} {
		at := resumed.Add(tc.elapsed)
		clock.Store(&at)
		e.h.heartbeatChecks(context.Background())
		admin.json(http.MethodGet, path, nil, http.StatusOK, &check)
		if check.Status != tc.want {
			t.Fatalf("after %s: status %s, want %s", tc.elapsed, check.Status, tc.want)
		}
	}
}

func TestAddressLookupAcceptsIPv6OnlyOnExistingRunners(t *testing.T) {
	e, admin := adminEnv(t, nil)
	e.enroll(admin, "basalt", "Lab")
	ctx, now := context.Background(), e.h.now()
	e.h.mu.Lock()
	e.h.servers["basalt"].reportAt = now
	e.h.mu.Unlock()
	var check checkJSON
	admin.json(http.MethodPost, "/api/v1/checks", map[string]any{
		"name": "Name lookup", "kind": "dns", "target": "v6.example.com.", "runner": "basalt",
		"options": map[string]any{"dns_type": "any"},
	}, http.StatusCreated, &check)
	specs := e.h.specsFor("basalt")
	if len(specs) != 2 || specs[0].DNSType != "A" || specs[1].DNSType != "AAAA" {
		t.Fatalf("address lookup specs: %+v", specs)
	}
	for _, spec := range specs {
		if err := checks.Validate(spec); err != nil || spec.Target != "v6.example.com." {
			t.Fatalf("invalid agent spec: %+v, %v", spec, err)
		}
	}
	read := func(want string) {
		t.Helper()
		admin.json(http.MethodGet, "/api/v1/checks/"+check.ID, nil, http.StatusOK, &check)
		if check.Status != want {
			t.Fatalf("status = %s, want %s; result %+v", check.Status, want, check.Last)
		}
	}
	a := proto.CheckResult{ID: specs[0].ID, At: now.Add(-10 * time.Second), Error: "no records"}
	aaaa := proto.CheckResult{ID: specs[1].ID, At: now.Add(-9 * time.Second), OK: true, Answer: []string{"2001:db8::1"}}
	e.h.checkResults(ctx, "basalt", []proto.CheckResult{a})
	read("pending")
	e.h.checkResults(ctx, "basalt", []proto.CheckResult{a, aaaa})
	read("up")
	if check.Last == nil || !slices.Equal(check.Last.Answer, aaaa.Answer) {
		t.Fatalf("IPv6 answer: %+v", check.Last)
	}
	if check.Options.DNSType != "any" {
		t.Fatalf("stored address lookup: %+v", check.Options)
	}
	aaaa.OK, aaaa.Answer, aaaa.Error = false, nil, "no records"
	for i, want := range []string{"pending", "down"} {
		a.At = now.Add(time.Duration(-8+i*2) * time.Second)
		e.h.checkResults(ctx, "basalt", []proto.CheckResult{a, aaaa})
		if i == 0 {
			read("up")
		}
		aaaa.At = a.At.Add(time.Second)
		e.h.checkResults(ctx, "basalt", []proto.CheckResult{a, aaaa})
		e.h.checkResults(ctx, "basalt", []proto.CheckResult{a, aaaa})
		read(want)
	}
	admin.json(http.MethodPatch, "/api/v1/checks/"+check.ID, map[string]any{"options": map[string]any{}}, http.StatusOK, &check)
	if specs := e.h.specsFor("basalt"); len(specs) != 1 || specs[0].DNSType != "" {
		t.Fatalf("default lookup specs: %+v", specs)
	}
}

func TestAlertHistoryCanIncludeAlertsOpenAtStart(t *testing.T) {
	e, admin := adminEnv(t, nil)
	e.enroll(admin, "basalt", "Lab")
	since := e.h.now().Truncate(time.Second).Add(-30 * 24 * time.Hour)
	before, after := since.Add(-time.Hour), since.Add(time.Hour)
	for _, alert := range []struct {
		id       string
		opened   time.Time
		resolved *time.Time
	}{
		{"al_old_resolved", since.Add(-10 * time.Hour), &before},
		{"al_old_open", since.Add(-9 * time.Hour), nil},
		{"al_resolved_on_boundary", since.Add(-8 * time.Hour), &since},
		{"al_new_open", after, nil},
	} {
		state := rules.AlertOpen
		if alert.resolved != nil {
			state = rules.AlertResolved
		}
		if err := e.h.store.InsertAlert(context.Background(), rules.Alert{
			ID: alert.id, Key: alert.id, Server: "basalt", Rule: rules.RuleSpaceHigh, Severity: rules.SevWarning,
			State: state, OpenedAt: alert.opened, ResolvedAt: alert.resolved,
		}); err != nil {
			t.Fatal(err)
		}
	}
	for field, want := range map[string][]string{
		"since":          {"al_new_open"},
		"overlaps_since": {"al_new_open", "al_resolved_on_boundary", "al_old_open"},
	} {
		q := url.Values{"state": {"all"}, "server": {"basalt"}, field: {since.Format(time.RFC3339)}}
		var got []struct{ ID string }
		admin.json(http.MethodGet, "/api/v1/alerts?"+q.Encode(), nil, http.StatusOK, &got)
		ids := make([]string, 0, len(got))
		for _, a := range got {
			ids = append(ids, a.ID)
		}
		if !slices.Equal(ids, want) {
			t.Fatalf("%s: got %v, want %v", field, ids, want)
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

func TestWatchLimitChangeResolvesOnlyAffectedAlertsImmediately(t *testing.T) {
	start := time.Now().UTC().Truncate(time.Second)
	var clock atomic.Pointer[time.Time]
	clock.Store(&start)
	e, admin := adminEnv(t, func(c *Config) { c.Now = func() time.Time { return *clock.Load() } })
	e.enroll(admin, "basalt", "Lab")
	path := "/api/v1/servers/basalt/watch"
	put := func(rule, entity string, value any) {
		t.Helper()
		admin.json(http.MethodPut, path, map[string]any{"rule": rule, "entity": entity, "limit": value}, 200, nil)
	}
	put(rules.RuleSpaceHigh, "fs:/photos", 91)

	ctx := context.Background()
	report := func(at time.Time) {
		clock.Store(&at)
		worn := 92.0
		e.h.ingestReport(ctx, "basalt", &proto.Report{At: at,
			Filesystems: []proto.Filesystem{
				{Mount: "/files", SizeBytes: 100, UsedBytes: 93, InodesTotal: 100, InodesUsed: 96},
				{Mount: "/photos", SizeBytes: 100, UsedBytes: 93},
			},
			Disks: []proto.Disk{{Device: "nvme0n1", Type: "nvme", WearPct: &worn}},
		})
	}
	report(start)
	report(start.Add(2 * time.Minute))
	open := func(rule, entity string) bool {
		t.Helper()
		for _, a := range e.h.alerts.Open("basalt") {
			if a.Rule == rule && a.Entity == entity {
				return true
			}
		}
		return false
	}
	for _, entity := range []string{"fs:/files", "fs:/photos"} {
		if !open(rules.RuleSpaceHigh, entity) {
			t.Fatalf("space alert for %s did not open", entity)
		}
	}
	if !open(rules.RuleInodesHigh, "fs:/files") || !open(rules.RuleWearCritical, "nvme0n1") {
		t.Fatal("the inode and wear alerts did not open")
	}
	put(rules.RuleSpaceHigh, "", 95)
	if open(rules.RuleSpaceHigh, "fs:/files") || !open(rules.RuleSpaceHigh, "fs:/photos") ||
		!open(rules.RuleInodesHigh, "fs:/files") || !open(rules.RuleWearCritical, "nvme0n1") {
		t.Fatal("only the space alert inheriting the changed limit should resolve")
	}
	put(rules.RuleInodesHigh, "fs:/files", 99)
	if open(rules.RuleInodesHigh, "fs:/files") {
		t.Fatal("the inode alert did not resolve")
	}
	put(rules.RuleWearCritical, "", 95)
	if open(rules.RuleWearCritical, "nvme0n1") || !open(rules.RuleWearHigh, "nvme0n1") {
		t.Fatal("the wear alert should drop to warning immediately")
	}
	put(rules.RuleSpaceHigh, "fs:/photos", nil)
	if open(rules.RuleSpaceHigh, "fs:/photos") {
		t.Fatal("clearing the item limit should restore the higher server limit")
	}
}

func TestWatchWarningLimitMustBeBelowCritical(t *testing.T) {
	e, admin := adminEnv(t, nil)
	e.enroll(admin, "basalt", "Lab")
	ctx := context.Background()
	e.h.ingestReport(ctx, "basalt", &proto.Report{At: e.h.now(), Sensors: []proto.Sensor{
		{ID: proto.SensorCPU, TempC: 40, LimitC: 90},
		{ID: proto.SensorBoard, TempC: 40, LimitC: 95},
	}})
	path := "/api/v1/servers/basalt/watch"
	put := func(rule, entity string, value any, unitBound string) {
		t.Helper()
		body := map[string]any{"rule": rule, "entity": entity, "limit": value}
		if unitBound == "" {
			admin.json(http.MethodPut, path, body, 200, nil)
			return
		}
		var problem struct{ Code, Detail string }
		admin.json(http.MethodPut, path, body, 400, &problem)
		if problem.Code != "invalid_limit" || !strings.Contains(problem.Detail, unitBound) {
			t.Fatalf("unexpected refusal: %+v", problem)
		}
	}
	put(rules.RuleTempHigh, proto.SensorCPU, 90, "below the critical limit of 90 °C")
	put(rules.RuleTempHigh, "", 92, "below the critical limit of 90 °C")
	put(rules.RuleTempCritical, proto.SensorCPU, 100, "")
	put(rules.RuleTempHigh, "", 92, "")
	put(rules.RuleTempCritical, proto.SensorCPU, nil, "above the warning limit of 92 °C")
	put(rules.RuleWearHigh, "nvme0n1", 95, "below the critical limit of 90 %")
	put(rules.RuleWearHigh, "nvme0n1", 88, "")
	put(rules.RuleWearCritical, "", 85, "above the warning limit of 88 %")
	put(rules.RuleWearCritical, "", 96, "")
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

func TestGuestCrashAfterPlannedRestartRaisesAlert(t *testing.T) {
	start := time.Now().UTC().Truncate(time.Second)
	var clock atomic.Pointer[time.Time]
	clock.Store(&start)
	e, admin := adminEnv(t, func(c *Config) { c.Now = func() time.Time { return *clock.Load() } })
	e.enroll(admin, "basalt", "Lab")
	autostart, code := true, 137
	report := func(after time.Duration, state string, wantAlert bool) {
		t.Helper()
		at := start.Add(after)
		clock.Store(&at)
		guest := proto.Guest{ID: "photos", State: state, Autostart: &autostart}
		if state == proto.StateStopped {
			guest.OOMKilled, guest.ExitCode, guest.FinishedAt = true, &code, &at
		}
		e.h.ingestReport(context.Background(), "basalt", &proto.Report{
			At: at, Docker: &proto.Platform{Guests: []proto.Guest{guest}},
		})
		found := false
		for _, a := range e.h.alerts.Open("basalt") {
			if a.Rule == rules.RuleGuestStopped && a.Entity == "docker/photos" {
				found = true
			}
		}
		if found != wantAlert {
			t.Fatalf("%s after %s: guest stopped alert = %t, want %t", state, after, found, wantAlert)
		}
	}
	report(0, proto.StateRunning, false)
	e.h.notePlannedStop("basalt", "docker:photos", proto.ActionRestart)
	report(time.Second, proto.StateStopped, false)
	report(5*time.Second, proto.StateRunning, false)
	report(95*time.Second, proto.StateStopped, true)
}

func TestLibvirtGuestStopNeedsCrashEvent(t *testing.T) {
	e, admin := adminEnv(t, nil)
	e.enroll(admin, "basalt", "Lab")
	ctx := context.Background()
	report := func(state string, autostart bool, wantAlert bool) {
		t.Helper()
		now := e.h.now()
		e.h.ingestReport(ctx, "basalt", &proto.Report{At: now, Libvirt: &proto.Platform{
			Guests: []proto.Guest{{ID: "files", State: state, Autostart: &autostart}},
		}})
		found := false
		for _, a := range e.h.alerts.Open("basalt") {
			if a.Rule == rules.RuleGuestStopped && a.Entity == "libvirt/files" {
				found = true
			}
		}
		if found != wantAlert {
			t.Fatalf("guest stopped alert: %t, wanted %t", found, wantAlert)
		}
	}
	event := func(message string) {
		e.h.ingestEvent("basalt", proto.Event{
			At: e.h.now(), Kind: "guest.state_changed", Platform: proto.PlatformLibvirt,
			GuestID: "files", State: proto.StateStopped, Message: message,
		})
	}
	report(proto.StateRunning, true, false)
	event("stopped")
	report(proto.StateStopped, true, false)
	report(proto.StateRunning, true, false)
	event("crashed")
	report(proto.StateRunning, true, false) // the collector still has its previous list
	report(proto.StateStopped, true, true)
	report(proto.StateStopped, false, false)
	report(proto.StateRunning, true, false)
	e.h.notePlannedStop("basalt", "libvirt:files", proto.ActionShutdown)
	event("crashed")
	report(proto.StateStopped, true, false)
}
