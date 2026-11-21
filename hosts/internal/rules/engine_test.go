package rules

import (
	"testing"
	"time"

	"rackoon/internal/proto"
)

func notHeartbeat(r string) bool  { return r != RuleHeartbeatMissing }
func onlyHeartbeat(r string) bool { return r == RuleHeartbeatMissing }

func sensorReport(temp float64) *proto.Report {
	return &proto.Report{Sensors: []proto.Sensor{{ID: "cpu_package", Label: "CPU package", TempC: temp, LimitC: 85}}}
}

func TestEngineTempHighFiresAfterTenMinutes(t *testing.T) {
	e := NewEngine()
	t0 := time.Date(2026, 10, 11, 13, 0, 0, 0, time.UTC)
	for i := 0; i < 60; i++ { // 10 s reports for 10 minutes minus one step
		now := t0.Add(time.Duration(i) * 10 * time.Second)
		ch := e.Evaluate("shale", HostConditions(sensorReport(80)), notHeartbeat, now)
		if len(ch.Opened) != 0 {
			t.Fatalf("fired early at %v", now.Sub(t0))
		}
	}
	ch := e.Evaluate("shale", HostConditions(sensorReport(80)), notHeartbeat, t0.Add(10*time.Minute))
	if len(ch.Opened) != 1 || ch.Opened[0].Rule != RuleTempHigh || ch.Opened[0].Severity != SevWarning {
		t.Fatalf("expected temp_high to fire at 10 min, got %+v", ch)
	}
	a := ch.Opened[0]
	if a.Title != "CPU package at 80 °C" || a.Detail != "Above 72 °C for 10 min" {
		t.Errorf("text = %q / %q", a.Title, a.Detail)
	}
	// Key is stable; a second evaluation updates the duration text only.
	ch = e.Evaluate("shale", HostConditions(sensorReport(80)), notHeartbeat, t0.Add(14*time.Minute))
	if len(ch.Opened) != 0 || len(ch.Updated) != 1 || ch.Updated[0].ID != a.ID || ch.Updated[0].Detail != "Above 72 °C for 14 min" {
		t.Errorf("update = %+v", ch)
	}
	// Hysteresis: one cool report does not resolve; a minute of cool does.
	ch = e.Evaluate("shale", HostConditions(sensorReport(60)), notHeartbeat, t0.Add(14*time.Minute+10*time.Second))
	if len(ch.Resolved) != 0 {
		t.Error("resolved without hysteresis")
	}
	ch = e.Evaluate("shale", HostConditions(sensorReport(60)), notHeartbeat, t0.Add(15*time.Minute))
	if len(ch.Resolved) != 1 || ch.Resolved[0].State != AlertResolved || ch.Resolved[0].ResolvedAt == nil {
		t.Errorf("expected resolve, got %+v", ch)
	}
	if len(e.Open("shale")) != 0 {
		t.Error("still open")
	}
}

func TestEnginePendingResetsWhenConditionDrops(t *testing.T) {
	e := NewEngine()
	t0 := time.Now()
	e.Evaluate("h", HostConditions(sensorReport(80)), notHeartbeat, t0)
	e.Evaluate("h", HostConditions(sensorReport(60)), notHeartbeat, t0.Add(5*time.Minute))
	ch := e.Evaluate("h", HostConditions(sensorReport(80)), notHeartbeat, t0.Add(11*time.Minute))
	if len(ch.Opened) != 0 {
		t.Error("pending timer must restart after the condition dropped")
	}
	ch = e.Evaluate("h", HostConditions(sensorReport(80)), notHeartbeat, t0.Add(21*time.Minute))
	if len(ch.Opened) != 1 {
		t.Error("should fire 10 min after the restart")
	}
}

func TestEngineCriticalSupersedesWarning(t *testing.T) {
	e := NewEngine()
	t0 := time.Now()
	e.Evaluate("h", HostConditions(sensorReport(80)), notHeartbeat, t0)
	ch := e.Evaluate("h", HostConditions(sensorReport(80)), notHeartbeat, t0.Add(10*time.Minute))
	if len(ch.Opened) != 1 {
		t.Fatal("warning should be open")
	}
	warnID := ch.Opened[0].ID
	e.Evaluate("h", HostConditions(sensorReport(87)), notHeartbeat, t0.Add(11*time.Minute))
	ch = e.Evaluate("h", HostConditions(sensorReport(87)), notHeartbeat, t0.Add(16*time.Minute))
	if len(ch.Opened) != 1 || ch.Opened[0].Rule != RuleTempCritical {
		t.Fatalf("critical should fire after 5 min: %+v", ch)
	}
	if len(ch.Resolved) != 1 || ch.Resolved[0].ID != warnID {
		t.Fatalf("warning should be superseded: %+v", ch.Resolved)
	}
	open := e.Open("h")
	if len(open) != 1 || open[0].Severity != SevCritical {
		t.Fatalf("open = %+v", open)
	}
	// Back below the limit but above 85%: the critical resolves after the
	// hysteresis and the warning returns at once (its condition held all along).
	ch = e.Evaluate("h", HostConditions(sensorReport(80)), notHeartbeat, t0.Add(16*time.Minute+10*time.Second))
	if len(ch.Opened) != 0 || len(ch.Resolved) != 0 {
		t.Fatalf("within the clear-after window nothing changes, got %+v", ch)
	}
	ch = e.Evaluate("h", HostConditions(sensorReport(80)), notHeartbeat, t0.Add(17*time.Minute))
	if len(ch.Resolved) != 1 || ch.Resolved[0].Rule != RuleTempCritical || len(ch.Opened) != 1 || ch.Opened[0].Rule != RuleTempHigh {
		t.Fatalf("expected critical->warning, got %+v", ch)
	}
}

func TestEngineWearImmediate(t *testing.T) {
	e := NewEngine()
	w := 78.0
	r := &proto.Report{Disks: []proto.Disk{{Device: "nvme1n1", Type: "nvme", WearPct: &w}}}
	ch := e.Evaluate("basalt", HostConditions(r), notHeartbeat, time.Now())
	if len(ch.Opened) != 1 || ch.Opened[0].Rule != RuleWearHigh || ch.Opened[0].Key != "disk.wear_high:nvme1n1" {
		t.Fatalf("got %+v", ch)
	}
	if b, ok := Banner(e.Open("basalt")); !ok || b.Link != "#storage" || b.BannerTitle != "Disk nvme1n1 is 78% worn out" {
		t.Errorf("banner = %+v", b)
	}
	if StatusNote(e.Open("basalt")) != "disk wear" {
		t.Error("status note")
	}
}

func TestEngineHeartbeatIndependent(t *testing.T) {
	e := NewEngine()
	now := time.Date(2026, 10, 11, 14, 0, 0, 0, time.UTC)
	w := 78.0
	r := &proto.Report{Disks: []proto.Disk{{Device: "nvme1n1", Type: "nvme", WearPct: &w}}}
	e.Evaluate("marble", HostConditions(r), notHeartbeat, now.Add(-12*time.Hour))
	last := now.Add(-(11*time.Hour + 47*time.Minute))
	c, _ := HeartbeatCondition(last, now)
	ch := e.Evaluate("marble", []Condition{c}, onlyHeartbeat, now)
	if len(ch.Opened) != 1 || !ch.Opened[0].OpenedAt.Equal(last) || ch.Opened[0].Detail != "Nothing heard from it for 11 h 47 m" {
		t.Fatalf("heartbeat = %+v", ch)
	}
	if len(ch.Resolved) != 0 {
		t.Error("heartbeat evaluation must not resolve report alerts")
	}
	if len(e.Open("marble")) != 2 {
		t.Error("both alerts should be open")
	}
	b, _ := Banner(e.Open("marble"))
	if b.Rule != RuleHeartbeatMissing {
		t.Error("critical heartbeat should win the banner")
	}
	ch = e.Evaluate("marble", nil, onlyHeartbeat, now.Add(time.Minute))
	if len(ch.Resolved) != 1 || ch.Resolved[0].Rule != RuleHeartbeatMissing {
		t.Errorf("heartbeat should resolve: %+v", ch)
	}
}

func TestEngineLoadRestoresOpen(t *testing.T) {
	e := NewEngine()
	now := time.Now()
	e.Load([]Alert{{ID: "al_x", Server: "h", Key: "sensor.temp_high:cpu_package", Rule: RuleTempHigh, Entity: "cpu_package",
		Severity: SevWarning, State: AlertOpen, OpenedAt: now.Add(-time.Hour)}})
	ch := e.Evaluate("h", HostConditions(sensorReport(80)), notHeartbeat, now)
	if len(ch.Opened) != 0 || len(ch.Updated) != 1 || ch.Updated[0].ID != "al_x" {
		t.Fatalf("restored alert should stay open and be updated, got %+v", ch)
	}
	if ch.Updated[0].Detail != "Above 72 °C for 1 h 10 m" {
		t.Errorf("detail = %q", ch.Updated[0].Detail)
	}
}

// A volume hovering at the 90% threshold keeps one alert open instead of
// opening and resolving one with every report.
func TestEngineSpaceHysteresis(t *testing.T) {
	e := NewEngine()
	fs := func(pct float64) *proto.Report {
		return &proto.Report{Filesystems: []proto.Filesystem{{Mount: "/srv", FSType: "ext4", SizeBytes: 1000, UsedBytes: uint64(pct * 10)}}}
	}
	t0 := time.Date(2026, 10, 11, 13, 0, 0, 0, time.UTC)
	if ch := e.Evaluate("onyx", HostConditions(fs(91)), notHeartbeat, t0); len(ch.Opened) != 0 {
		t.Fatal("space alert must hold for SpaceFor before firing")
	}
	ch := e.Evaluate("onyx", HostConditions(fs(91)), notHeartbeat, t0.Add(SpaceFor))
	if len(ch.Opened) != 1 || ch.Opened[0].Rule != RuleSpaceHigh {
		t.Fatalf("expected disk.space_high, got %+v", ch)
	}
	id := ch.Opened[0].ID
	// Flapping between 89 and 91 for nine minutes: no resolve, no new alert.
	for i := 1; i <= 54; i++ {
		pct := 89.0
		if i%2 == 0 {
			pct = 91
		}
		ch := e.Evaluate("onyx", HostConditions(fs(pct)), notHeartbeat, t0.Add(SpaceFor+time.Duration(i)*10*time.Second))
		if len(ch.Opened)+len(ch.Resolved) != 0 {
			t.Fatalf("flapped at step %d: %+v", i, ch)
		}
	}
	// Ten minutes below the threshold resolve it.
	last := t0.Add(SpaceFor + 54*10*time.Second)
	ch = e.Evaluate("onyx", HostConditions(fs(80)), notHeartbeat, last.Add(ClearAfter+time.Second))
	if len(ch.Resolved) != 1 || ch.Resolved[0].ID != id {
		t.Fatalf("expected the alert to resolve, got %+v", ch)
	}
}

// TestEngineSeverityRiseEndsAck: a severity rising within one rule ends the
// acknowledgement and is reported; a drop keeps it (HS-193).
func TestEngineSeverityRiseEndsAck(t *testing.T) {
	e := NewEngine()
	t0 := time.Date(2026, 10, 22, 9, 0, 0, 0, time.UTC)
	ups := func(sev string) []Condition {
		return []Condition{{Rule: RuleUPSOnBattery, Entity: "ups:apc", Severity: sev, ClearAfter: time.Minute,
			Render: func(time.Duration) Text { return Text{Title: "UPS apc " + sev} }}}
	}
	ch := e.Evaluate("h", ups(SevWarning), notHeartbeat, t0)
	if len(ch.Opened) != 1 {
		t.Fatalf("opened %+v", ch)
	}
	id := ch.Opened[0].ID
	if _, ok := e.SetAck("h", id, &Ack{At: t0, By: "John (pe_1)"}); !ok {
		t.Fatal("ack")
	}
	// The same severity keeps the acknowledgement and reports nothing new.
	ch = e.Evaluate("h", ups(SevWarning), notHeartbeat, t0.Add(10*time.Second))
	if len(ch.Severity)+len(ch.AckEnded) != 0 || e.Open("h")[0].Ack == nil {
		t.Fatalf("unchanged %+v", ch)
	}
	// Low battery: critical, the acknowledgement ends.
	ch = e.Evaluate("h", ups(SevCritical), notHeartbeat, t0.Add(20*time.Second))
	if len(ch.Severity) != 1 || ch.Severity[0].ID != id || ch.Severity[0].Severity != SevCritical || ch.Severity[0].Ack != nil {
		t.Fatalf("rise %+v", ch)
	}
	if len(ch.AckEnded) != 1 || ch.AckEnded[0] != id || len(ch.Updated) != 1 {
		t.Fatalf("ack ended %+v", ch)
	}
	if a := e.Open("h")[0]; a.Ack != nil || a.ID != id {
		t.Fatalf("engine still acknowledged: %+v", a)
	}
	// Acknowledged again at critical; back to warning keeps it.
	e.SetAck("h", id, &Ack{At: t0, By: "John (pe_1)"})
	ch = e.Evaluate("h", ups(SevWarning), notHeartbeat, t0.Add(30*time.Second))
	if len(ch.Severity) != 1 || len(ch.AckEnded) != 0 || e.Open("h")[0].Ack == nil {
		t.Fatalf("drop %+v", ch)
	}
	// A rise without an acknowledgement is reported, nothing ends.
	e.SetAck("h", id, nil)
	ch = e.Evaluate("h", ups(SevCritical), notHeartbeat, t0.Add(40*time.Second))
	if len(ch.Severity) != 1 || len(ch.AckEnded) != 0 {
		t.Fatalf("rise without ack %+v", ch)
	}
}
