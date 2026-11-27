package model

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"rackoon/internal/proto"
	"rackoon/internal/rules"
)

func TestManagePerms(t *testing.T) {
	st := &ServerState{RCManage: true, Report: &proto.Report{Policy: proto.Policy{Manage: true}}}
	if p := Perms(st, 1); !p.Manage || !p.AgentManage || p.ManageReason != nil || p.Power {
		t.Errorf("operator, both on = %+v", p)
	}
	if p := Perms(st, 0); p.Manage || *p.ManageReason != ReasonRole {
		t.Errorf("viewer = %+v", p)
	}
	st.RCManage = false
	if p := Perms(st, 2); p.Manage || *p.ManageReason != ReasonHubManage {
		t.Errorf("hub off = %+v", p)
	}
	st.RCManage, st.Report.Policy.Manage = true, false
	if p := Perms(st, 2); p.Manage || p.AgentManage || *p.ManageReason != ReasonAgentMgmt {
		t.Errorf("agent off = %+v", p)
	}
	// Manage does not imply power or console, nor the other way round.
	st = &ServerState{RCConsole: true, RCPower: true, Report: &proto.Report{Policy: proto.Policy{Console: true, Power: true}}}
	if p := Perms(st, 2); !p.Power || p.Manage {
		t.Errorf("power only = %+v", p)
	}
	b, _ := json.Marshal(Perms(&ServerState{}, 1))
	if !strings.Contains(string(b), `"manage":false,"agent_manage":false,"manage_reason":"Managing guests is turned off for this server"`) {
		t.Errorf("json = %s", b)
	}
}

// pveState is a Proxmox node with the given guests and storages.
func pveState(now time.Time, guests []proto.Guest, storages []proto.PVEStorage, lastJob *proto.PVEBackupJob) *ServerState {
	r := &proto.Report{At: now, PVE: &proto.PVE{Node: "pve", Guests: guests, Storages: storages}}
	if lastJob != nil {
		r.PVE.Backups = &proto.PVEBackups{LastJob: lastJob}
	}
	return &ServerState{ID: "pve", Report: r, LastSeen: now, Connected: true}
}

func TestPVEGuestHints(t *testing.T) {
	now := time.Date(2026, 10, 17, 12, 0, 0, 0, time.UTC)
	yes, no := true, false
	ago := func(d time.Duration) *time.Time { t := now.Add(-d); return &t }
	day := 24 * time.Hour
	guests := []proto.Guest{
		{ID: "100", Name: "web", Kind: "vm", State: "running", BackupJob: &yes, StartedAt: ago(40 * day),
			LastBackup: &proto.BackupMark{Result: "ok", At: now.Add(-12 * day)}, GuestAgent: "not_running", PendingChanges: 2},
		{ID: "101", Name: "db", Kind: "vm", State: "running", BackupJob: &yes, StartedAt: ago(40 * day),
			LastBackup: &proto.BackupMark{Result: "ok", At: now.Add(-day)}, GuestAgent: "running", OldestSnapshot: ago(45 * day)},
		{ID: "102", Name: "new", Kind: "vm", State: "running", BackupJob: &yes, StartedAt: ago(10 * day)},
		{ID: "103", Name: "fresh", Kind: "vm", State: "running", BackupJob: &yes, StartedAt: ago(time.Hour)},
		{ID: "104", Name: "lab", Kind: "vm", State: "stopped", BackupJob: &no, GuestAgent: "not_running", OldestSnapshot: ago(3 * day)},
		{ID: "200", Name: "ct", Kind: "container", State: "running", BackupJob: &no, PendingChanges: 1},
		{ID: "201", Name: "unknown", Kind: "container", State: "running"}, // no backup job information: no hint
	}
	storages := []proto.PVEStorage{
		{ID: "local-zfs", Thin: true, TotalBytes: 400e9, ProvisionedBytes: 520e9},
		{ID: "vmdata", Thin: true, TotalBytes: 4000e9, ProvisionedBytes: 3000e9},
		{ID: "lvm", TotalBytes: 100e9, ProvisionedBytes: 300e9}, // thick: cannot overcommit
	}
	job := &proto.PVEBackupJob{At: now.Add(-6 * time.Hour), Result: "ok"}
	st := pveState(now, guests, storages, job)
	var got []string
	for _, h := range BuildHints(st, now, "") {
		got = append(got, h.Severity+" "+h.Kind+" "+h.Entity+": "+h.Title+" | "+h.Detail)
	}
	want := []string{
		"warning guest.backup_old pve: 2 machines need a backup | web (12 days), new (none)",
		"info guest.no_backup_job pve: 2 machines aren’t in a backup plan | lab, ct",
		"info guest.agent_down pve: 1 machine doesn’t report what’s inside | web",
		"info guest.pending_changes pve: 2 machines need a restart to apply changes | web (2 changes), ct (1 change)",
		"info guest.snapshot_old pve: 1 machine has snapshots older than 30 days | db (45 days)",
		"info storage.overcommit storage:local-zfs: Storage “local-zfs” has promised more space than it has | Its machines may grow to 520 GB; it holds 400 GB (130%)",
	}
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Errorf("hints:\n%s", strings.Join(got, "\n"))
	}
	for _, h := range BuildHints(st, now, "") {
		if h.Link == "" || h.Server != "pve" {
			t.Errorf("hint without link or server: %+v", h)
		}
		if h.Code != h.Kind || len(h.Params) == 0 {
			t.Errorf("hint without translation data: %+v", h)
		}
		if h.Kind == HintBackupOld {
			if names, ok := h.Params["names"].([]string); !ok || strings.Join(names, ",") != "web,new" {
				t.Errorf("backup names: %v", h.Params)
			}
			if states, ok := h.Params["backupStates"].([]string); !ok || strings.Join(states, ",") != "old,none" {
				t.Errorf("backup states: %v", h.Params)
			}
			if ages, ok := h.Params["agesDays"].([]string); !ok || strings.Join(ages, ",") != "12," {
				t.Errorf("backup ages: %v", h.Params)
			}
		}
	}

	// A failed backup alert covers the backup hint; a space alert the
	// storage's overcommit.
	st.Open = []rules.Alert{{Rule: rules.RuleBackupFailed, Entity: "vzdump", State: rules.AlertOpen},
		{Rule: rules.RuleSpaceHigh, Entity: "storage:local-zfs", State: rules.AlertOpen}}
	for _, h := range BuildHints(st, now, "") {
		if h.Kind == HintBackupOld || h.Kind == HintStorageOvercommit {
			t.Errorf("covered hint shown: %+v", h)
		}
	}
	// A failed last backup of one guest, many guests without a job.
	var many []proto.Guest
	for i := 0; i < 7; i++ {
		many = append(many, proto.Guest{ID: string(rune('a' + i)), Name: string(rune('a' + i)), Kind: "container", State: "stopped", BackupJob: &no})
	}
	many = append(many, proto.Guest{ID: "x", Name: "x", Kind: "vm", State: "stopped", BackupJob: &yes,
		LastBackup: &proto.BackupMark{Result: "error", At: now.Add(-time.Hour)}})
	hs := BuildHints(pveState(now, many, nil, nil), now, "")
	if len(hs) != 2 || hs[0].Detail != "x (failed)" || hs[1].Title != "7 machines aren’t in a backup plan" || hs[1].Detail != "a, b, c, d, e, …" {
		t.Errorf("hints = %+v", hs)
	}
	// Offline hosts have no hints.
	st.LastSeen = now.Add(-time.Hour)
	if hs := BuildHints(st, now, ""); len(hs) != 0 {
		t.Errorf("offline hints = %+v", hs)
	}
}

func TestGuestManageFieldsAndTagFilter(t *testing.T) {
	now := time.Date(2026, 10, 17, 12, 0, 0, 0, time.UTC)
	yes := true
	snap := now.Add(-48 * time.Hour)
	guests := []proto.Guest{
		{ID: "100", Name: "web", Kind: "vm", State: "running", Tags: []string{"Prod", "web"}, PendingChanges: 1,
			GuestAgent: "running", OldestSnapshot: &snap, BackupJob: &yes, HAState: "started"},
		{ID: "101", Name: "db", Kind: "vm", State: "stopped", Tags: []string{"prod", "db", "PROD"}},
		{ID: "102", Name: "lab", Kind: "vm", State: "stopped"},
	}
	st := pveState(now, guests, nil, nil)
	m := roundTrip(t, BuildGuest(proto.PlatformGuest{Platform: proto.PlatformPVE, Guest: &guests[0]}, now))
	if tags, _ := m["tags"].([]any); len(tags) != 2 || m["pending_changes"] != 1.0 || m["guest_agent"] != "running" ||
		m["oldest_snapshot"] != "2026-10-15T12:00:00Z" || m["backup_job"] != true || m["ha_state"] != "started" {
		t.Errorf("guest json = %v", m)
	}
	m = roundTrip(t, BuildGuest(proto.PlatformGuest{Platform: proto.PlatformPVE, Guest: &guests[2]}, now))
	for _, k := range []string{"tags", "pending_changes", "guest_agent", "oldest_snapshot", "backup_job", "ha_state"} {
		if _, ok := m[k]; ok {
			t.Errorf("unknown %s written: %v", k, m[k])
		}
	}
	l := SearchGuests([]*ServerState{st}, FleetGuestQuery{Tag: "PROD"}, now)
	if l.Total != 2 || l.Counts.All != 3 || l.Tags["prod"] != 2 || l.Tags["web"] != 1 || l.Tags["db"] != 1 || len(l.Tags) != 3 {
		t.Errorf("tag prod = total %d, counts %+v, tags %v", l.Total, l.Counts, l.Tags)
	}
	if l := SearchGuests([]*ServerState{st}, FleetGuestQuery{Tag: "web", State: "stopped"}, now); l.Total != 0 || l.Tags["prod"] != 2 {
		t.Errorf("tag web, stopped = %+v", l)
	}
	if l := SearchGuests([]*ServerState{st}, FleetGuestQuery{Tag: "pro"}, now); l.Total != 0 {
		t.Errorf("tag filter is not exact: %+v", l)
	}
}
