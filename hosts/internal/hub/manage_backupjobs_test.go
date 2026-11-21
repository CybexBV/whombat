package hub

import (
	"encoding/json"
	"net/http"
	"reflect"
	"slices"
	"testing"
	"time"

	"rackoon/internal/hub/model"
	"rackoon/internal/hub/store"
	"rackoon/internal/proto"
)

func TestManageBackupJobs(t *testing.T) {
	e, admin := adminEnv(t, func(c *Config) { c.TaskPollInterval = 50 * time.Millisecond })
	fa := setupManageHost(t, e, admin)
	const jobs = "/api/v1/servers/shale/backup-jobs"

	// The list: hub guest ids, null for what is not set.
	var list struct {
		Items []map[string]any `json:"items"`
	}
	admin.json(http.MethodGet, jobs, nil, 200, &list)
	if req := fa.lastManage(t); req.Op != proto.OpBackupJobList || req.Platform != "pve" {
		t.Errorf("agent got %+v", req)
	}
	if len(list.Items) != 2 {
		t.Fatalf("list = %v", list)
	}
	b, _ := json.Marshal(list.Items[0])
	want := `{"comment":null,"compress":"zstd","digest":"j1","enabled":true,"exclude":["pve:100"],"guests":[],"id":"backup-dc316015-ac2c",` +
		`"keep":{"daily":14,"hourly":0,"last":7,"monthly":0,"weekly":0,"yearly":0},"mode":"snapshot","next_run":"2026-10-18T02:00:00Z",` +
		`"node":null,"notes_template":"{{guestname}}","pool":null,"schedule":"04:00","selection":"all","storage":"pbs-01"}`
	if string(b) != want {
		t.Errorf("job =\n%s\nwant\n%s", b, want)
	}
	if g := list.Items[1]; g["node"] != "shale" || !reflect.DeepEqual(g["guests"], []any{"pve:101", "pve:118"}) || g["keep"] != nil ||
		g["compress"] != nil || g["next_run"] != nil || g["enabled"] != false {
		t.Errorf("guests job = %v", g)
	}

	// Create: admins; guests by hub id; the new job's id.
	var res struct {
		OK      bool                 `json:"ok"`
		ID      string               `json:"id"`
		Changes []proto.ConfigChange `json:"changes"`
		AuditID string               `json:"audit_id"`
		Task    *proto.TaskRef       `json:"task"`
	}
	job := map[string]any{"schedule": "04:00", "storage": "pbs-01", "selection": "guests", "guests": []string{"pve:118", "pve:101", "pve:118"},
		"keep": map[string]int{"last": 7, "weekly": 4}, "notes_template": "{{guestname}}", "node": nil}
	admin.json(http.MethodPost, jobs, job, 200, &res)
	if !res.OK || res.ID != "backup-feedc0de-0042" || res.AuditID == "" || res.Changes != nil {
		t.Errorf("create = %+v", res)
	}
	req := fa.lastManage(t)
	j := req.BackupJob
	if req.Op != proto.OpBackupJobCreate || j == nil || *j.Schedule != "04:00" || *j.Storage != "pbs-01" || *j.Selection != "guests" ||
		!reflect.DeepEqual(j.Guests, []string{"118", "101"}) || *j.Keep != (proto.BackupKeep{Last: 7, Weekly: 4}) || j.Node != nil || len(j.Clear) != 0 {
		t.Errorf("agent got %+v / %+v", req, j)
	}
	rq, fin := e.audit("manage.requested")[0], e.audit("manage.finished")[0]
	if rq.Details["op"] != proto.OpBackupJobCreate || rq.Details["storage"] != "pbs-01" || rq.Details["keys"] != "guests, keep, notes_template, schedule, selection, storage" ||
		fin.Details["job"] != "backup-feedc0de-0042" || fin.Details["changes"] != "schedule:  → 04:00" || fin.Guest != "" {
		t.Errorf("audit = %s / %s", fmtRecs([]store.AuditRecord{rq}), fmtRecs([]store.AuditRecord{fin}))
	}
	e.addUser("olive", store.RoleOperator, "operator password 1")
	op := e.client()
	op.login("olive", "operator password 1")
	if p := op.problem(http.MethodPost, jobs, job, 403); p.Code != "insufficient_role" {
		t.Errorf("operator create: %+v", p)
	}
	n := len(fa.manages)
	for name, c := range map[string]struct {
		body  map[string]any
		code  string
		field string
	}{
		"bare vmid":    {map[string]any{"schedule": "04:00", "storage": "pbs-01", "selection": "guests", "guests": []string{"101"}}, "invalid_value", "guests"},
		"no guests":    {map[string]any{"schedule": "04:00", "storage": "pbs-01", "selection": "guests"}, "invalid_value", "guests"},
		"no storage":   {map[string]any{"schedule": "04:00", "selection": "all"}, "invalid_value", "storage"},
		"schedule":     {map[string]any{"schedule": "04:00\n", "storage": "pbs-01", "selection": "all"}, "invalid_value", "schedule"},
		"compress":     {map[string]any{"schedule": "04:00", "storage": "pbs-01", "selection": "all", "compress": "none"}, "invalid_value", "compress"},
		"keep":         {map[string]any{"schedule": "04:00", "storage": "pbs-01", "selection": "all", "keep": map[string]int{"forever": 1}}, "invalid_value", "keep"},
		"keep count":   {map[string]any{"schedule": "04:00", "storage": "pbs-01", "selection": "all", "keep": map[string]int{"last": 10001}}, "invalid_value", "keep"},
		"enabled":      {map[string]any{"schedule": "04:00", "storage": "pbs-01", "selection": "all", "enabled": "yes"}, "invalid_value", "enabled"},
		"other field":  {map[string]any{"schedule": "04:00", "storage": "pbs-01", "selection": "all", "all": 1}, "bad_request", ""},
		"digest":       {map[string]any{"schedule": "04:00", "storage": "pbs-01", "selection": "all", "digest": "j1"}, "bad_request", ""},
		"comment":      {map[string]any{"schedule": "04:00", "storage": "pbs-01", "selection": "all", "comment": "a\u0007b"}, "invalid_value", "comment"},
		"other guests": {map[string]any{"schedule": "04:00", "storage": "pbs-01", "selection": "all", "exclude": []string{"incus:web"}}, "invalid_value", "exclude"},
	} {
		p := admin.problem(http.MethodPost, jobs, c.body, 400)
		if p.Code != c.code || (c.field != "" && p.FieldErrors[c.field] == "") {
			t.Errorf("%s: %+v", name, p)
		}
	}
	if len(fa.manages) != n {
		t.Errorf("refused bodies reached the agent")
	}

	// Update: a partial body; null, "" and [] remove a setting.
	upd := jobs + "/backup-dc316015-ac2c"
	var ures map[string]any
	admin.json(http.MethodPut, upd, map[string]any{"enabled": false, "node": nil, "comment": "", "exclude": []string{}, "keep": nil, "digest": "j1"}, 200, &ures)
	req = fa.lastManage(t)
	j = req.BackupJob
	slices.Sort(j.Clear)
	if req.Op != proto.OpBackupJobUpdate || req.JobID != "backup-dc316015-ac2c" || req.Digest != "j1" || j == nil || j.Enabled == nil || *j.Enabled ||
		!reflect.DeepEqual(j.Clear, []string{"comment", "exclude", "keep", "node"}) || j.Exclude != nil || j.Keep != nil {
		t.Errorf("agent got %+v / %+v", req, j)
	}
	if ures["ok"] != true || !reflect.DeepEqual(ures["changes"], []any{map[string]any{"key": "enabled", "old": "true", "new": "false"}}) {
		t.Errorf("update = %v", ures)
	}
	if p := admin.problem(http.MethodPut, upd, map[string]any{"schedule": "05:00", "digest": "j0"}, 409); p.Code != "digest_mismatch" {
		t.Errorf("stale digest: %+v", p)
	}
	if p := admin.problem(http.MethodPut, upd, map[string]any{"schedule": nil}, 400); p.FieldErrors["schedule"] == "" {
		t.Errorf("schedule removed: %+v", p)
	}
	if p := admin.problem(http.MethodPut, upd, map[string]any{"guests": []string{}}, 400); p.FieldErrors["guests"] == "" {
		t.Errorf("no guests: %+v", p)
	}
	if p := admin.problem(http.MethodPut, jobs+"/..%2Fx", map[string]any{"enabled": true}, 400); p.FieldErrors["job"] == "" {
		t.Errorf("bad job id: %+v", p)
	}

	// Delete needs confirm=1.
	if p := admin.problem(http.MethodDelete, upd, nil, 400); p.Code != "confirm_required" {
		t.Errorf("delete without confirm: %+v", p)
	}
	admin.json(http.MethodDelete, upd+"?confirm=1", nil, 200, &res)
	if req := fa.lastManage(t); req.Op != proto.OpBackupJobDelete || req.JobID != "backup-dc316015-ac2c" {
		t.Errorf("delete: agent got %+v", req)
	}
	if p := op.problem(http.MethodDelete, upd+"?confirm=1", nil, 403); p.Code != "insufficient_role" {
		t.Errorf("operator delete: %+v", p)
	}

	// Run: operators; the hub follows the task.
	sub, _, _ := e.h.bus.Subscribe(0, store.RoleRank(store.RoleViewer), 0)
	defer e.h.bus.Unsubscribe(sub)
	op.json(http.MethodPost, upd+"/run", nil, 202, &res)
	if res.Task == nil || res.Task.ID == "" {
		t.Fatalf("run = %+v", res)
	}
	if req := fa.lastManage(t); req.Op != proto.OpBackupJobRun || req.JobID != "backup-dc316015-ac2c" {
		t.Errorf("run: agent got %+v", req)
	}
	var ev map[string]any
	deadline := time.After(5 * time.Second)
	for ev == nil {
		select {
		case m := <-sub.C:
			if m.Name == "task.finished" {
				json.Unmarshal(m.Data, &ev)
			}
		case <-deadline:
			t.Fatal("no task.finished event")
		}
	}
	if ev["op"] != proto.OpBackupJobRun || ev["guest"] != nil || ev["result"] != "ok" {
		t.Errorf("task.finished = %v", ev)
	}
	if p := admin.problem(http.MethodPost, upd+"/run", map[string]any{"now": true}, 400); p.Code != "bad_request" {
		t.Errorf("run with a body: %+v", p)
	}

	// Without Proxmox VE there are no backup jobs.
	fb := e.enroll(admin, "basalt", "Lab")
	fb.policy = proto.Policy{Manage: true}
	if _, err := fb.dial(proto.Hello{}); err != nil {
		t.Fatal(err)
	}
	fb.send(proto.MsgReport, fb.report("basalt"))
	waitFor(t, "report", 3*time.Second, func() bool { st, ok := e.h.snapshotOne("basalt"); return ok && st.Report != nil })
	admin.json(http.MethodPatch, "/api/v1/servers/basalt", map[string]any{"remote_control": map[string]bool{"manage": true}}, 200, nil)
	if p := admin.problem(http.MethodGet, "/api/v1/servers/basalt/backup-jobs", nil, 501); p.Code != "unsupported" {
		t.Errorf("Incus host: %+v", p)
	}
}

// Listing snapshots needs power or manage, not the console switch.
func TestSnapshotsNeedPowerOrManage(t *testing.T) {
	e, admin := adminEnv(t, nil)
	fa := setupManageHost(t, e, admin)
	const snaps = "/api/v1/servers/shale/guests/pve:100/snapshots"
	admin.json(http.MethodGet, snaps, nil, 200, nil) // manage is on
	report := func(pol proto.Policy) {
		fa.policy = pol
		fa.send(proto.MsgReport, fa.report("shale"))
		waitFor(t, "policy", 3*time.Second, func() bool { st, _ := e.h.snapshotOne("shale"); return st.Report.Policy == pol })
	}
	report(proto.Policy{Console: true})
	admin.json(http.MethodPatch, "/api/v1/servers/shale", map[string]any{"remote_control": map[string]bool{"console": true}}, 200, nil)
	if p := admin.problem(http.MethodGet, snaps, nil, 403); p.Code != "power_disabled" || p.Detail != model.ReasonAgentSnaps+"." {
		t.Errorf("console only: %+v", p)
	}
	admin.json(http.MethodPatch, "/api/v1/servers/shale", map[string]any{"remote_control": map[string]bool{"manage": false}}, 200, nil)
	if p := admin.problem(http.MethodGet, snaps, nil, 403); p.Code != "power_disabled" || p.Detail != model.ReasonHubSnaps+"." {
		t.Errorf("hub switches off: %+v", p)
	}
	report(proto.Policy{Power: true})
	admin.json(http.MethodPatch, "/api/v1/servers/shale", map[string]any{"remote_control": map[string]bool{"power": true, "console": false}}, 200, nil)
	admin.json(http.MethodGet, snaps, nil, 200, nil)
	if req := fa.inspects[len(fa.inspects)-1]; req.Kind != proto.InspectSnapshots || req.GuestID != "100" {
		t.Errorf("agent got %+v", req)
	}
	if p := admin.problem(http.MethodGet, "/api/v1/servers/shale/inspect/processes", nil, 403); p.Code != "console_disabled" {
		t.Errorf("processes without console: %+v", p)
	}
}
