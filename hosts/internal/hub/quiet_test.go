package hub

import (
	"context"
	"net/http"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"rackoon/internal/hub/store"
	"rackoon/internal/proto"
	"rackoon/internal/rules"
)

// subscribe opens an event subscription from now on, closed with the test.
func subscribe(t *testing.T, h *Hub) *Sub {
	s, _, _ := h.bus.Subscribe(0, 0, h.bus.LastID())
	t.Cleanup(func() { h.bus.Unsubscribe(s) })
	return s
}

// TestSeverityRiseEndsAcknowledgement: an acknowledged UPS warning that
// turns critical (battery low) asks for attention again, in the store
// too, and the change is sent (HS-193).
func TestSeverityRiseEndsAcknowledgement(t *testing.T) {
	e, admin := adminEnv(t, nil)
	e.enroll(admin, "granite", "Production")
	ctx := context.Background()
	ups := func(sev string) []rules.Condition {
		return []rules.Condition{{Rule: rules.RuleUPSOnBattery, Entity: "ups:apc", Severity: sev, ClearAfter: time.Minute,
			StatusNote: "on battery", Render: func(time.Duration) rules.Text { return rules.Text{Title: "UPS apc " + sev} }}}
	}
	onlyUPS := func(r string) bool { return r == rules.RuleUPSOnBattery }
	e.h.applyAlerts(ctx, e.h.alerts.Evaluate("granite", ups(rules.SevWarning), onlyUPS, e.h.now()))
	var open []map[string]any
	admin.json(http.MethodGet, "/api/v1/alerts?server=granite&rule=ups.on_battery", nil, 200, &open)
	if len(open) != 1 {
		t.Fatalf("open %v", open)
	}
	id := open[0]["id"].(string)
	admin.json(http.MethodPost, "/api/v1/alerts/"+id+"/ack", map[string]any{}, 200, nil)

	sub := subscribe(t, e.h)
	e.h.applyAlerts(ctx, e.h.alerts.Evaluate("granite", ups(rules.SevCritical), onlyUPS, e.h.now()))
	ev := nextEvent(t, sub, "alert.updated")
	if ev["id"] != id || ev["severity"] != "critical" || ev["attention"] != true || ev["acknowledged"] != nil {
		t.Fatalf("alert.updated %v", ev)
	}
	admin.json(http.MethodGet, "/api/v1/alerts?server=granite&rule=ups.on_battery", nil, 200, &open)
	if open[0]["attention"] != true || open[0]["acknowledged"] != nil {
		t.Fatalf("after the rise %v", open[0])
	}
	stored, _ := e.h.store.QueryAlerts(ctx, store.AlertFilter{State: "open", Rule: rules.RuleUPSOnBattery})
	if len(stored) != 1 || stored[0].Ack != nil || stored[0].Severity != rules.SevCritical {
		t.Fatalf("stored %+v", stored)
	}
	// Acknowledged at critical, back on warning: the acknowledgement stays,
	// the change is still sent.
	admin.json(http.MethodPost, "/api/v1/alerts/"+id+"/ack", map[string]any{}, 200, nil)
	e.h.applyAlerts(ctx, e.h.alerts.Evaluate("granite", ups(rules.SevWarning), onlyUPS, e.h.now()))
	ev = nextEvent(t, sub, "alert.updated")
	for ev["severity"] != "warning" { // the ack's own event comes first
		ev = nextEvent(t, sub, "alert.updated")
	}
	if ev["attention"] != false || ev["acknowledged"] == nil {
		t.Fatalf("drop %v", ev)
	}
}

type watchResp struct {
	Rules []map[string]any `json:"rules"`
}

// TestWatchSettings: Whombat switches a rule off for one disk and for the
// whole server and on again, through the service token (HS-194…HS-197).
func TestWatchSettings(t *testing.T) {
	dir := t.TempDir()
	tweak := func(c *Config) { c.DataDir, c.ServiceTokenFile = dir, filepath.Join(dir, "service-token") }
	e := headlessEnv(t, tweak)
	svc := e.service("pe_1|John Doe")
	fa := e.enroll(svc, "granite", "Lab")
	if _, err := fa.dial(proto.Hello{}); err != nil {
		t.Fatal(err)
	}
	sub := subscribe(t, e.h)
	wear := 80.0
	// report sends a report with two worn disks (at most five: the agent's
	// burst) and waits until the hub took it: once connected, only a report
	// sends server.updated.
	report := func() {
		t.Helper()
		for len(sub.C) > 0 {
			<-sub.C
		}
		rep := fa.report("granite")
		rep.Disks = []proto.Disk{{Device: "nvme0n1", Type: "nvme", WearPct: &wear}, {Device: "nvme1n1", Type: "nvme", WearPct: &wear}}
		fa.send(proto.MsgReport, rep)
		for ev := nextEvent(t, sub, "server.updated"); ev["id"] != "granite"; ev = nextEvent(t, sub, "server.updated") {
		}
	}
	openWear := func() string {
		t.Helper()
		var open []map[string]any
		svc.json(http.MethodGet, "/api/v1/alerts?server=granite&rule=disk.wear_high", nil, 200, &open)
		var ents []string
		for _, a := range open {
			ents = append(ents, a["entity"].(string))
		}
		sort.Strings(ents)
		return strings.Join(ents, ",")
	}
	put := func(body map[string]any, want int) watchResp {
		t.Helper()
		var out watchResp
		svc.json(http.MethodPut, "/api/v1/servers/granite/watch", body, want, &out)
		return out
	}
	waitFor(t, "connected", 3*time.Second, func() bool { return e.h.conn("granite") != nil })
	report()
	waitFor(t, "both disks' alerts", 3*time.Second, func() bool { return openWear() == "nvme0n1,nvme1n1" })
	var w watchResp
	svc.json(http.MethodGet, "/api/v1/servers/granite/watch", nil, 200, &w)
	if w.Rules == nil || len(w.Rules) != 0 {
		t.Fatalf("nothing off yet: %+v", w)
	}

	// One disk off: its alert resolves at once, the other stays.
	for len(sub.C) > 0 {
		<-sub.C
	}
	w = put(map[string]any{"rule": "disk.wear_high", "entity": "nvme0n1", "off": true}, 200)
	if len(w.Rules) != 1 || w.Rules[0]["rule"] != "disk.wear_high" || w.Rules[0]["entity"] != "nvme0n1" ||
		w.Rules[0]["off"] != true || w.Rules[0]["by"] != "John Doe (pe_1)" || w.Rules[0]["at"] == nil {
		t.Fatalf("put %+v", w)
	}
	if ev := nextEvent(t, sub, "alert.resolved"); ev["entity"] != "nvme0n1" {
		t.Fatalf("resolved %v", ev)
	}
	if ev := nextEvent(t, sub, "watch.changed"); ev["server"] != "granite" || ev["rule"] != "disk.wear_high" ||
		ev["entity"] != "nvme0n1" || ev["off"] != true {
		t.Fatalf("watch.changed %v", ev)
	}
	if got := openWear(); got != "nvme1n1" {
		t.Fatalf("after one off %q", got)
	}
	report() // not evaluated again
	if got := openWear(); got != "nvme1n1" {
		t.Fatalf("evaluated while off: %q", got)
	}
	// The same again changes nothing and isn't recorded twice.
	put(map[string]any{"rule": "disk.wear_high", "entity": "nvme0n1", "off": true}, 200)
	if n := len(e.audit("server.watch_changed")); n != 1 {
		t.Fatalf("audited %d times", n)
	}

	// The whole rule off: the other disk's alert resolves, the server is fine.
	w = put(map[string]any{"rule": "disk.wear_high", "off": true}, 200)
	if len(w.Rules) != 2 || w.Rules[0]["entity"] != nil || w.Rules[1]["entity"] != "nvme0n1" {
		t.Fatalf("two off %+v", w)
	}
	report()
	if got := openWear(); got != "" {
		t.Fatalf("whole rule off: %q", got)
	}
	var list []map[string]any
	svc.json(http.MethodGet, "/api/v1/servers", nil, 200, &list)
	if list[0]["status"] != "online" {
		t.Fatalf("status %v", list[0])
	}

	// Back on for the server: evaluated again, the disk exception stays.
	put(map[string]any{"rule": "disk.wear_high", "entity": "", "off": false}, 200)
	report()
	if got := openWear(); got != "nvme1n1" {
		t.Fatalf("back on %q", got)
	}

	// Roles and validation.
	if code, _, _ := svc.req(http.MethodPut, "/api/v1/servers/granite/watch", map[string]any{"rule": "net.link_down", "off": true},
		map[string]string{HeaderRole: "viewer"}); code != 403 {
		t.Errorf("viewer changed watch settings: %d", code)
	}
	if code, _, _ := svc.req(http.MethodGet, "/api/v1/servers/granite/watch", nil, map[string]string{HeaderRole: "viewer"}); code != 200 {
		t.Errorf("viewer read: %d", code)
	}
	if code, b, _ := svc.req(http.MethodPut, "/api/v1/servers/granite/watch", map[string]any{"rule": "net.link_down", "off": true},
		map[string]string{HeaderRole: "operator"}); code != 200 {
		t.Errorf("operator: %d %s", code, b)
	}
	for _, c := range []struct {
		path string
		body map[string]any
		code int
		want string
	}{
		{"granite", map[string]any{"rule": "check.down", "off": true}, 400, "invalid_rule"},
		{"granite", map[string]any{"rule": "", "off": true}, 400, "invalid_rule"},
		{"granite", map[string]any{"rule": "net.link_down"}, 400, "invalid_value"},
		{"granite", map[string]any{"rule": "net.link_down", "off": true, "until": "x"}, 400, "bad_request"},
		{"granite", map[string]any{"rule": "net.link_down", "entity": "net:eno1\n", "off": true}, 400, "invalid_entity"},
		{"granite", map[string]any{"rule": "net.link_down", "entity": strings.Repeat("x", 201), "off": true}, 400, "invalid_entity"},
		{"nope", map[string]any{"rule": "net.link_down", "off": true}, 404, "server_not_found"},
	} {
		code, b, _ := svc.req(http.MethodPut, "/api/v1/servers/"+c.path+"/watch", c.body, nil)
		if code != c.code || !strings.Contains(string(b), `"`+c.want+`"`) {
			t.Errorf("%v: %d %s", c.body, code, b)
		}
	}
	if code, _, _ := svc.req(http.MethodGet, "/api/v1/servers/nope/watch", nil, nil); code != 404 {
		t.Errorf("unknown server: %d", code)
	}
	recs := e.audit("server.watch_changed")
	if len(recs) != 4 || recs[0].Server != "granite" || recs[0].User != "John Doe (pe_1)" {
		t.Fatalf("audit %s", fmtRecs(recs))
	}

	// Kept across a restart; an alert left open for a rule that is off
	// resolves when the hub starts.
	ctx := context.Background()
	if err := e.h.store.InsertAlert(ctx, rules.Alert{ID: "al_left", Server: "granite", Key: "net.link_down:net:eno9",
		Rule: rules.RuleLinkDown, Entity: "net:eno9", Severity: rules.SevWarning, State: rules.AlertOpen, OpenedAt: time.Now()}); err != nil {
		t.Fatal(err)
	}
	e.stop()
	e2 := headlessEnv(t, tweak)
	svc2 := e2.service("pe_1|John Doe")
	svc2.json(http.MethodGet, "/api/v1/servers/granite/watch", nil, 200, &w)
	if len(w.Rules) != 2 || w.Rules[0]["rule"] != "disk.wear_high" || w.Rules[1]["rule"] != "net.link_down" {
		t.Fatalf("after restart %+v", w)
	}
	if !e2.h.watch.isOff("granite", rules.RuleWearHigh, "nvme0n1") || e2.h.watch.isOff("granite", rules.RuleWearHigh, "nvme1n1") {
		t.Fatal("watch set not loaded")
	}
	stored, _ := e2.h.store.QueryAlerts(ctx, store.AlertFilter{Rule: rules.RuleLinkDown})
	if len(stored) != 1 || stored[0].State != rules.AlertResolved {
		t.Fatalf("left open %+v", stored)
	}
	// A deleted server's settings go with it.
	svc2.json(http.MethodDelete, "/api/v1/servers/granite", nil, 204, nil)
	if e2.h.watch.isOff("granite", rules.RuleLinkDown, "") {
		t.Fatal("still off after delete")
	}
}
