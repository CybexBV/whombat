package model

import (
	"encoding/json"
	"testing"
	"time"

	"rackoon/internal/rules"
)

// TestStatusFollowsAttention: a server's status and note come only from the
// alerts that ask for attention (HS-190).
func TestStatusFollowsAttention(t *testing.T) {
	now := asOf
	warn := rules.Alert{ID: "al_w", Server: "s", Key: "disk.space_high:fs:/", Rule: rules.RuleSpaceHigh, Entity: "fs:/",
		Severity: rules.SevWarning, State: rules.AlertOpen, OpenedAt: now.Add(-time.Hour), StatusNote: "disk full"}
	crit := rules.Alert{ID: "al_c", Server: "s", Key: "disk.smart_failing:sda", Rule: rules.RuleSMARTFailing, Entity: "sda",
		Severity: rules.SevCritical, State: rules.AlertOpen, OpenedAt: now.Add(-2 * time.Hour), StatusNote: "disk failing"}
	acked := func(a rules.Alert, until *time.Time) rules.Alert {
		a.Ack = &rules.Ack{At: now.Add(-time.Minute), By: "John (pe_1)", Until: until}
		return a
	}
	server := func(open ...rules.Alert) *ServerState {
		return &ServerState{ID: "s", Hostname: "s", LastSeen: now.Add(-5 * time.Second), Open: open}
	}
	check := func(name string, st *ServerState, status string, note *string) {
		t.Helper()
		fs := BuildFleetServer(st, now)
		if fs.Status != status {
			t.Errorf("%s: status %q, want %q", name, fs.Status, status)
		}
		switch {
		case note == nil && fs.StatusNote != nil:
			t.Errorf("%s: note %q, want none", name, *fs.StatusNote)
		case note != nil && (fs.StatusNote == nil || *fs.StatusNote != *note):
			t.Errorf("%s: note %v, want %q", name, fs.StatusNote, *note)
		}
		if fs.OpenAlerts != len(st.Open) {
			t.Errorf("%s: open_alerts %d, want every open alert (%d)", name, fs.OpenAlerts, len(st.Open))
		}
	}
	check("open warning", server(warn), rules.StatusWarning, ptr("disk full"))
	check("acknowledged until resolved", server(acked(warn, nil)), rules.StatusOnline, nil)
	later := now.Add(time.Hour)
	check("snoozed", server(acked(warn, &later)), rules.StatusOnline, nil)
	lapsed := now.Add(-time.Second)
	check("snooze lapsed", server(acked(warn, &lapsed)), rules.StatusWarning, ptr("disk full"))
	// The note is the most severe alert that asks for attention, not the
	// acknowledged critical one.
	check("critical acknowledged, warning open", server(acked(crit, nil), warn), rules.StatusWarning, ptr("disk full"))
	check("both open", server(crit, warn), rules.StatusWarning, ptr("disk failing"))

	muted := server(warn)
	muted.Maintenance = &MaintInfo{ID: "mw_1", Until: now.Add(time.Hour)}
	check("muted", muted, rules.StatusOnline, nil)

	suppressed := server(warn)
	suppressed.Parent, suppressed.ParentOffline = "pve-01", true
	check("suppressed", suppressed, rules.StatusOnline, nil)

	gone := server(acked(warn, nil))
	gone.LastSeen = now.Add(-2 * time.Minute)
	check("offline", gone, rules.StatusOffline, ptr("not checking in"))
	if !server(acked(warn, nil)).Online(now) || gone.Online(now) {
		t.Error("online is the heartbeat's alone")
	}

	// The detail's server and banner agree.
	d := BuildDetail(server(acked(crit, nil), warn), now, DetailInput{Range: "24h"})
	if d.Server.Status != rules.StatusWarning || d.Banner == nil || d.Banner.AlertID != "al_w" {
		t.Errorf("detail %q banner %+v", d.Server.Status, d.Banner)
	}
	if l := BuildServerList([]*ServerState{server(acked(warn, nil))}, now); l[0].Status != rules.StatusOnline || l[0].StatusNote != nil {
		t.Errorf("list %+v", l[0])
	}
}

// TestAlertEntityAndKey: the alert object names what it is about (HS-191).
func TestAlertEntityAndKey(t *testing.T) {
	a := rules.Alert{ID: "al_1", Server: "s", Key: "disk.space_high:fs:/srv", Rule: rules.RuleSpaceHigh, Entity: "fs:/srv",
		Severity: rules.SevWarning, State: rules.AlertOpen, OpenedAt: asOf}
	b, _ := json.Marshal(BuildAlertFor(a, nil, asOf))
	var m map[string]any
	_ = json.Unmarshal(b, &m)
	if m["entity"] != "fs:/srv" || m["key"] != "disk.space_high:fs:/srv" || m["rule"] != rules.RuleSpaceHigh {
		t.Errorf("alert json %s", b)
	}
	// An alert stored without a key gets rule:entity.
	a.Key = ""
	if got := BuildAlertFor(a, nil, asOf).Key; got != "disk.space_high:fs:/srv" {
		t.Errorf("key %q", got)
	}
	// The fixture fleet's alerts all carry both.
	for _, al := range BuildFleet(fixtureStates(t), "All", asOf, 0, "0.14.2").Alerts {
		if al.Entity == "" || al.Key != al.Rule+":"+al.Entity {
			t.Errorf("fleet alert %+v", al)
		}
	}
}

// TestHintIDs: every hint has a stable id, kind:entity, unique within its
// server (HS-192).
func TestHintIDs(t *testing.T) {
	states := fixtureStates(t)
	f := BuildFleet(states, "All", asOf, 0, "0.14.2")
	if len(f.Hints) == 0 {
		t.Fatal("no hints in the fixture fleet")
	}
	seen := map[string]bool{}
	for _, h := range f.Hints {
		if h.ID != h.Kind+":"+h.Entity {
			t.Errorf("hint id %q for %s / %s", h.ID, h.Kind, h.Entity)
		}
		if k := h.Server + "|" + h.ID; seen[k] {
			t.Errorf("duplicate hint id %s", k)
		} else {
			seen[k] = true
		}
	}
	// The same read twice gives the same ids.
	again := BuildFleet(fixtureStates(t), "All", asOf, 0, "0.14.2")
	for i := range f.Hints {
		if f.Hints[i].ID != again.Hints[i].ID {
			t.Errorf("id %d changed: %s → %s", i, f.Hints[i].ID, again.Hints[i].ID)
		}
	}
	// Should two hints ever share a kind and entity, the later is told apart.
	l := []Hint{{Server: "s", Hint: rules.Hint{Kind: "k.x", Entity: "host"}}, {Server: "s", Hint: rules.Hint{Kind: "k.x", Entity: "host"}}}
	hintIDs(l)
	if l[0].ID != "k.x:host" || l[1].ID != "k.x:host#2" {
		t.Errorf("duplicates %q %q", l[0].ID, l[1].ID)
	}
}
