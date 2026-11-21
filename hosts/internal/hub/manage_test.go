package hub

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"rackoon/internal/hub/model"
	"rackoon/internal/hub/store"
	"rackoon/internal/proto"
)

// setupManageHost enrolls shale (Proxmox VE) with manage allowed in its
// agent.toml and in the hub.
func setupManageHost(t *testing.T, e *env, admin *client) *fakeAgent {
	t.Helper()
	fa := e.enroll(admin, "shale", "Production")
	fa.policy = proto.Policy{Console: true, Power: true, Manage: true}
	if _, err := fa.dial(proto.Hello{}); err != nil {
		t.Fatal(err)
	}
	fa.send(proto.MsgReport, fa.report("shale"))
	waitFor(t, "report", 3*time.Second, func() bool {
		st, ok := e.h.snapshotOne("shale")
		return ok && st.Report != nil
	})
	admin.json(http.MethodPatch, "/api/v1/servers/shale", map[string]any{"remote_control": map[string]bool{"manage": true}}, 200, nil)
	return fa
}

func (a *fakeAgent) lastManage(t *testing.T) proto.ManageRequest {
	t.Helper()
	a.mu.Lock()
	defer a.mu.Unlock()
	if len(a.manages) == 0 {
		t.Fatal("the agent got no manage request")
	}
	return a.manages[len(a.manages)-1]
}

// problem is a problem+json body.
type problem struct {
	Code        string            `json:"code"`
	Detail      string            `json:"detail"`
	FieldErrors map[string]string `json:"field_errors"`
}

func (c *client) problem(method, path string, body any, want int) problem {
	c.t.Helper()
	code, b, _ := c.req(method, path, body, nil)
	var p problem
	json.Unmarshal(b, &p)
	if code != want {
		c.t.Fatalf("%s %s: status %d, want %d: %s", method, path, code, want, b)
	}
	return p
}

func TestManageSwitchAndPermissions(t *testing.T) {
	e, admin := adminEnv(t, nil)
	fa := e.enroll(admin, "shale", "Production")
	fa.policy = proto.Policy{Console: true, Power: true, Manage: true}
	if _, err := fa.dial(proto.Hello{}); err != nil {
		t.Fatal(err)
	}
	fa.send(proto.MsgReport, fa.report("shale"))
	waitFor(t, "report", 3*time.Second, func() bool { st, _ := e.h.snapshotOne("shale"); return st != nil && st.Report != nil })
	const config = "/api/v1/servers/shale/guests/pve:100/config"

	// Off in the hub by default.
	if p := admin.problem(http.MethodGet, config, nil, 403); p.Code != "manage_disabled" || p.Detail != model.ReasonHubManage+"." {
		t.Fatalf("hub switch off: %+v", p)
	}
	var set settingsJSON
	admin.json(http.MethodGet, "/api/v1/servers/shale/settings", nil, 200, &set)
	if set.RemoteControl.Manage || !set.AgentPolicy.Manage {
		t.Errorf("settings = %+v", set)
	}
	// Turning it on needs a recent sign-in.
	admin.staleSignIn()
	on := map[string]any{"remote_control": map[string]bool{"manage": true}}
	if p := admin.problem(http.MethodPatch, "/api/v1/servers/shale", on, 403); p.Code != "reauth_required" {
		t.Fatalf("stale session turned manage on: %+v", p)
	}
	admin.json(http.MethodPost, "/api/v1/auth/reauth", map[string]string{"password": adminPW}, 204, nil)
	admin.json(http.MethodPatch, "/api/v1/servers/shale", on, 200, &set)
	if !set.RemoteControl.Manage {
		t.Errorf("settings after turning on = %+v", set)
	}
	if recs := e.audit("remote_control.enabled"); len(recs) != 1 || recs[0].Details["capability"] != "manage" {
		t.Errorf("remote_control.enabled = %s", fmtRecs(recs))
	}
	var agents []map[string]any
	admin.json(http.MethodGet, "/api/v1/agents", nil, 200, &agents)
	if rc := agents[0]["remote_control"].(map[string]any); rc["manage"] != true || agents[0]["agent_policy"].(map[string]any)["manage"] != true {
		t.Errorf("agents = %v", agents[0])
	}
	admin.json(http.MethodGet, config, nil, 200, nil)
	// Admin operations need a recent sign-in too.
	admin.staleSignIn()
	clone := "/api/v1/servers/shale/guests/pve:100/clone"
	if p := admin.problem(http.MethodPost, clone, map[string]any{"name": "web-2"}, 403); p.Code != "reauth_required" {
		t.Fatalf("clone without reauth: %+v", p)
	}
	admin.json(http.MethodPost, "/api/v1/auth/reauth", map[string]string{"password": adminPW}, 204, nil)
	admin.json(http.MethodPost, clone, map[string]any{"name": "web-2"}, 202, nil)

	// Viewers read nothing; operators change but do not create.
	e.addUser("vera", store.RoleViewer, "viewer password")
	v := e.client()
	v.login("vera", "viewer password")
	for i := 0; i < 3; i++ {
		if p := v.problem(http.MethodGet, config, nil, 403); p.Code != "insufficient_role" {
			t.Fatalf("viewer: %+v", p)
		}
	}
	var vr []store.AuditRecord
	for _, rec := range e.audit("manage.denied") {
		if rec.User == "vera" {
			vr = append(vr, rec)
		}
	}
	if len(vr) != 1 || vr[0].Code != "insufficient_role" || vr[0].Details["op"] != proto.OpConfigGet {
		t.Errorf("viewer refusals (polled views: one record) = %s", fmtRecs(vr))
	}
	e.addUser("olive", store.RoleOperator, "operator password 1")
	op := e.client()
	op.login("olive", "operator password 1")
	op.json(http.MethodGet, config, nil, 200, nil)
	op.json(http.MethodPut, config, map[string]any{"set": map[string]string{"memory": "8192"}}, 200, nil)
	if p := op.problem(http.MethodPost, clone, map[string]any{"name": "web-3"}, 403); p.Code != "insufficient_role" {
		t.Fatalf("operator clone: %+v", p)
	}
	var d map[string]any
	op.json(http.MethodGet, "/api/v1/servers/shale", nil, 200, &d)
	rc := d["server"].(map[string]any)["remote_control"].(map[string]any)
	if rc["manage"] != true || rc["agent_manage"] != true || rc["manage_reason"] != nil {
		t.Errorf("operator remote_control = %v", rc)
	}

	// The agent's flag wins; the change of agent.toml is audited.
	fa.policy.Manage = false
	fa.send(proto.MsgReport, fa.report("shale"))
	waitFor(t, "policy", 3*time.Second, func() bool { st, _ := e.h.snapshotOne("shale"); return !st.Report.Policy.Manage })
	if p := admin.problem(http.MethodGet, config, nil, 403); p.Code != "manage_disabled" || p.Detail != model.ReasonAgentMgmt+"." {
		t.Fatalf("agent flag off: %+v", p)
	}
	if recs := e.audit("agent.policy_changed"); len(recs) == 0 || recs[0].Details["manage"] != "off" {
		t.Errorf("policy change = %+v", recs)
	}
}

func TestManageChanges(t *testing.T) {
	e, admin := adminEnv(t, func(c *Config) { c.TaskPollInterval = 50 * time.Millisecond })
	fa := setupManageHost(t, e, admin)
	const config = "/api/v1/servers/shale/guests/pve:100/config"

	var cfg proto.GuestConfig
	admin.json(http.MethodGet, config, nil, 200, &cfg)
	admin.json(http.MethodGet, config, nil, 200, &cfg)
	if cfg.Digest != "d1" || cfg.Values["memory"] != "4096" || cfg.Platform != "pve" {
		t.Errorf("config = %+v", cfg)
	}
	if req := fa.lastManage(t); req.Op != proto.OpConfigGet || req.Platform != "pve" || req.GuestID != "100" {
		t.Errorf("agent got %+v", req)
	}
	if recs := e.audit("manage.viewed"); len(recs) != 1 || recs[0].Guest != "pve:100" || recs[0].Details["view"] != proto.OpConfigGet {
		t.Errorf("manage.viewed = %s", fmtRecs(recs))
	}

	// A change: answered with what changed, audited without the secret.
	var res struct {
		OK      bool                 `json:"ok"`
		Changes []proto.ConfigChange `json:"changes"`
		AuditID string               `json:"audit_id"`
		Task    *proto.TaskRef       `json:"task"`
		NewID   string               `json:"new_id"`
	}
	admin.json(http.MethodPut, config, map[string]any{"digest": "d1", "set": map[string]string{"memory": "8192", "cipassword": "hunter2-secret"}}, 200, &res)
	if !res.OK || len(res.Changes) != 2 || !strings.HasPrefix(res.AuditID, "au_") || res.Task != nil {
		t.Errorf("config.set = %+v", res)
	}
	if req := fa.lastManage(t); req.Op != proto.OpConfigSet || req.Digest != "d1" || req.Set["memory"] != "8192" {
		t.Errorf("agent got %+v", req)
	}
	reqd, fin := e.audit("manage.requested"), e.audit("manage.finished")
	if len(reqd) != 1 || reqd[0].Details["keys"] != "cipassword, memory" || reqd[0].Guest != "pve:100" || reqd[0].Platform != "pve" {
		t.Errorf("manage.requested = %+v", reqd)
	}
	if len(fin) != 1 || fin[0].Outcome != "ok" || fin[0].Details["requested_audit_id"] != res.AuditID ||
		fin[0].Details["changes"] != "cipassword: ********** → **********; memory: 4096 → 8192 (pending)" {
		t.Errorf("manage.finished = %+v", fin)
	}
	all, _, _ := e.h.store.ListAudit(t.Context(), 1000, 0, store.AuditFilter{})
	for _, rec := range all {
		if b, _ := json.Marshal(rec); strings.Contains(string(b), "hunter2") {
			t.Errorf("secret in the audit log: %s", b)
		}
	}
	if strings.Contains(e.logs.String(), "hunter2") {
		t.Error("secret in the hub log")
	}

	// Refusals: the agent's codes and field errors, the hub's own checks.
	if p := admin.problem(http.MethodPut, config, map[string]any{"digest": "old", "set": map[string]string{"memory": "1"}}, 409); p.Code != "digest_mismatch" || p.Detail == "" {
		t.Errorf("digest mismatch: %+v", p)
	}
	if fin := e.audit("manage.finished"); fin[0].Outcome != "error" || fin[0].Code != "digest_mismatch" {
		t.Errorf("refused change audited as %s", fmtRecs(fin))
	}
	if p := admin.problem(http.MethodPut, config, map[string]any{"delete": []string{"unused0"}}, 400); p.Code != "confirm_required" {
		t.Errorf("unused disk without confirm: %+v", p)
	}
	admin.json(http.MethodPut, config, map[string]any{"delete": []string{"unused0"}, "confirm": true}, 200, nil)
	if p := admin.problem(http.MethodPut, config, map[string]any{"kind": "vm"}, 400); p.Code != "bad_request" || !strings.Contains(p.Detail, `"kind"`) {
		t.Errorf("field of another route: %+v", p)
	}
	if p := admin.problem(http.MethodPut, config, map[string]any{"set": map[string]string{"memory": "1"}, "delete": []string{"memory"}}, 400); p.Code != "invalid_value" || p.FieldErrors["memory"] == "" {
		t.Errorf("set and delete: %+v", p)
	}
	resize := "/api/v1/servers/shale/guests/pve:100/disks/scsi0/resize"
	if p := admin.problem(http.MethodPost, resize, map[string]any{"size": "-8G"}, 400); p.Code != "invalid_value" || p.FieldErrors["size"] == "" {
		t.Errorf("bad size: %+v", p)
	}
	rules := "/api/v1/servers/shale/guests/pve:100/firewall/rules"
	rule := map[string]any{"rule": map[string]any{"type": "in", "action": "ACCEPT", "enable": true, "dport": "99999"}}
	if p := admin.problem(http.MethodPost, rules, rule, 400); p.Code != "invalid_value" || p.FieldErrors["dport"] != "invalid port" {
		t.Errorf("agent field errors: %+v", p)
	}
	if p := admin.problem(http.MethodGet, "/api/v1/servers/shale/guests/pve:999/config", nil, 404); p.Code != "guest_not_found" {
		t.Errorf("unknown guest: %+v", p)
	}
	if p := admin.problem(http.MethodGet, "/api/v1/servers/shale/manage/choices?platform=docker", nil, 400); p.FieldErrors["platform"] == "" {
		t.Errorf("bad platform: %+v", p)
	}
	// Host operations default to the host's platform.
	var ch proto.Choices
	admin.json(http.MethodGet, "/api/v1/servers/shale/manage/choices", nil, 200, &ch)
	if req := fa.lastManage(t); req.Op != proto.OpChoices || req.Platform != "pve" || ch.NextID != 108 || ch.Storages == nil || ch.Bridges == nil {
		t.Errorf("choices: agent got %+v, answer %+v", req, ch)
	}
	var list struct {
		Items []proto.BackupVolume `json:"items"`
	}
	admin.json(http.MethodGet, "/api/v1/servers/shale/guests/pve:100/backups", nil, 200, &list)
	if len(list.Items) != 1 || list.Items[0].Verified != "ok" {
		t.Errorf("backups = %+v", list)
	}
	var tasks map[string]any
	admin.json(http.MethodGet, "/api/v1/servers/shale/tasks", nil, 200, &tasks)
	if items, ok := tasks["items"].([]any); !ok || len(items) != 0 {
		t.Errorf("empty task list = %v", tasks)
	}

	// Deleting needs the guest's name; templates are guests here too.
	del := "/api/v1/servers/shale/guests/pve:9000"
	if p := admin.problem(http.MethodDelete, del+"?confirm_name=debian", nil, 400); p.Code != "confirm_required" {
		t.Errorf("wrong name: %+v", p)
	}
	admin.json(http.MethodDelete, del+"?confirm_name=debian-13-cloud&purge=1", nil, 202, &res)
	if req := fa.lastManage(t); req.Op != proto.OpDelete || req.GuestID != "9000" || !req.Purge {
		t.Errorf("delete: agent got %+v", req)
	}
	// Restoring over a guest needs a confirmation and names it by the
	// platform's id.
	restore := map[string]any{"volume": "pbs-01:backup/vm/100/2026-10-17T01:00:00Z", "guest": "pve:100"}
	if p := admin.problem(http.MethodPost, "/api/v1/servers/shale/backups/restore", restore, 400); p.Code != "confirm_required" {
		t.Errorf("restore over a guest: %+v", p)
	}
	restore["confirm"] = true
	admin.json(http.MethodPost, "/api/v1/servers/shale/backups/restore", restore, 202, nil)
	if req := fa.lastManage(t); req.Op != proto.OpBackupRestore || req.GuestID != "100" || req.Platform != "pve" {
		t.Errorf("restore: agent got %+v", req)
	}
	// Downloads: http(s) only, no credentials, a file name of the content.
	dl := "/api/v1/servers/shale/storage/local/download"
	p := admin.problem(http.MethodPost, dl, map[string]any{"platform": "pve", "content": "iso", "url": "https://user:pw@example.com/a.iso", "filename": "a.tar.gz"}, 400)
	if p.FieldErrors["url"] == "" || p.FieldErrors["filename"] == "" {
		t.Errorf("download checks: %+v", p)
	}
	admin.json(http.MethodPost, dl, map[string]any{"platform": "pve", "content": "iso", "url": "https://example.com/d.iso?token=secret-token", "filename": "d.iso"}, 200, nil)
	if recs := e.audit("manage.requested"); recs[0].Details["url"] != "https://example.com/d.iso" || recs[0].Details["storage"] != "local" {
		t.Errorf("download audit = %+v", recs[0].Details)
	}
	// HA: the settings are the body.
	admin.json(http.MethodPut, "/api/v1/servers/shale/guests/pve:100/ha", map[string]any{"state": "started", "max_restart": 2, "comment": "db"}, 200, nil)
	if req := fa.lastManage(t); req.HA == nil || req.HA.State != "started" || *req.HA.MaxRestart != 2 || req.HA.Comment != "db" || req.Comment != "" {
		t.Errorf("ha: agent got %+v", req)
	}
}

func TestManageTasks(t *testing.T) {
	e, admin := adminEnv(t, func(c *Config) { c.TaskPollInterval = 50 * time.Millisecond })
	fa := setupManageHost(t, e, admin)
	sub, _, _ := e.h.bus.Subscribe(0, store.RoleRank(store.RoleViewer), 0)
	defer e.h.bus.Unsubscribe(sub)

	var res struct {
		Task    *proto.TaskRef `json:"task"`
		NewID   string         `json:"new_id"`
		AuditID string         `json:"audit_id"`
	}
	admin.json(http.MethodPost, "/api/v1/servers/shale/guests/pve:100/clone", map[string]any{"new_id": 108, "name": "k3s-node-4", "full": true}, 202, &res)
	if res.Task == nil || !strings.HasPrefix(res.Task.ID, "UPID:shale:") || res.NewID != "pve:108" {
		t.Fatalf("clone = %+v", res)
	}
	if req := fa.lastManage(t); req.Op != proto.OpClone || req.NewID != 108 || req.Name != "k3s-node-4" || !req.Full {
		t.Errorf("agent got %+v", req)
	}
	// The hub follows the task and announces its end.
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
	if ev["server"] != "shale" || ev["guest"] != "pve:100" || ev["task"] != res.Task.ID || ev["op"] != proto.OpClone || ev["result"] != "ok" {
		t.Errorf("task.finished = %v", ev)
	}
	waitFor(t, "manage.finished", 3*time.Second, func() bool { return len(e.audit("manage.finished")) == 1 })
	fin := e.audit("manage.finished")[0]
	if fin.Outcome != "ok" || fin.User != "john" || fin.Details["task"] != res.Task.ID || fin.Details["new_id"] != "pve:108" ||
		fin.Details["result"] != "ok" || fin.Details["requested_audit_id"] != res.AuditID {
		t.Errorf("manage.finished = %+v", fin)
	}
	var status proto.TaskStatus
	admin.json(http.MethodGet, "/api/v1/servers/shale/tasks/"+res.Task.ID+"?log_start=0", nil, 200, &status)
	if status.Status != "ok" || len(status.Log) != 2 || status.LogNext != 2 {
		t.Errorf("task status = %+v", status)
	}
	if p := admin.problem(http.MethodGet, "/api/v1/servers/shale/tasks/rm%20-rf", nil, 400); p.FieldErrors["task"] == "" {
		t.Errorf("bad task id: %+v", p)
	}

	// A failed task; a running one is followed until it ends.
	fa.mu.Lock()
	fa.manage = func(req proto.ManageRequest) proto.ManageResponse {
		switch req.Op {
		case proto.OpDiskResize:
			return proto.ManageResponse{OK: true, Task: &proto.TaskRef{ID: "UPID:shale:1:2:3:qmresize:100:x:"}}
		case proto.OpTaskStatus:
			return proto.ManageResponse{OK: true, TaskStatus: &proto.TaskStatus{ID: req.Task, Status: "error", Message: "disk is locked"}}
		}
		return fakeManage(req)
	}
	fa.mu.Unlock()
	admin.json(http.MethodPost, "/api/v1/servers/shale/guests/pve:100/disks/scsi0/resize", map[string]any{"size": "+8G"}, 202, nil)
	waitFor(t, "failed task", 3*time.Second, func() bool { return len(e.audit("manage.finished")) == 2 })
	if fin := e.audit("manage.finished")[0]; fin.Outcome != "error" || fin.Code != "task_failed" || fin.Details["message"] != "disk is locked" ||
		fin.Details["disk"] != "scsi0" || fin.Details["size"] != "+8G" {
		t.Errorf("failed task = %+v", fin)
	}
}

func TestManageOneChangePerGuest(t *testing.T) {
	e, admin := adminEnv(t, nil)
	fa := setupManageHost(t, e, admin)
	admin.json(http.MethodPatch, "/api/v1/servers/shale", map[string]any{"remote_control": map[string]bool{"power": true}}, 200, nil)
	release := make(chan struct{})
	started := make(chan struct{})
	fa.mu.Lock()
	fa.manage = func(req proto.ManageRequest) proto.ManageResponse {
		if req.Op == proto.OpDiskMove {
			close(started)
			<-release
		}
		return fakeManage(req)
	}
	fa.mu.Unlock()
	done := make(chan int)
	go func() {
		code, _, _ := admin.req(http.MethodPost, "/api/v1/servers/shale/guests/pve:100/disks/scsi0/move", map[string]any{"storage": "vmdata"}, nil)
		done <- code
	}()
	<-started
	if p := admin.problem(http.MethodPut, "/api/v1/servers/shale/guests/pve:100/config", map[string]any{"set": map[string]string{"cores": "4"}}, 409); p.Code != "action_in_progress" {
		t.Errorf("second change: %+v", p)
	}
	// Power actions share the tracker.
	if p := admin.problem(http.MethodPost, "/api/v1/servers/shale/guests/pve:100/actions", map[string]any{"action": "shutdown", "confirm": true}, 409); p.Code != "action_in_progress" {
		t.Errorf("power action during a change: %+v", p)
	}
	// Reads and other guests are not blocked.
	admin.json(http.MethodGet, "/api/v1/servers/shale/guests/pve:100/config", nil, 200, nil)
	admin.json(http.MethodPut, "/api/v1/servers/shale/guests/pve:101/config", map[string]any{"set": map[string]string{"cores": "4"}}, 200, nil)
	close(release)
	if code := <-done; code != 200 {
		t.Errorf("move = %d", code)
	}
	admin.json(http.MethodPut, "/api/v1/servers/shale/guests/pve:100/config", map[string]any{"set": map[string]string{"cores": "4"}}, 200, nil)
}

func TestGuestTagsThroughTheAPI(t *testing.T) {
	e, admin := adminEnv(t, nil)
	setupManageHost(t, e, admin)
	var page struct {
		Guests []struct {
			ID         string   `json:"id"`
			Tags       []string `json:"tags"`
			HAState    string   `json:"ha_state"`
			BackupJob  *bool    `json:"backup_job"`
			GuestAgent string   `json:"guest_agent"`
		} `json:"guests"`
		Total int            `json:"total"`
		Tags  map[string]int `json:"tags"`
	}
	admin.json(http.MethodGet, "/api/v1/guests?tag=K3S", nil, 200, &page)
	if page.Total != 2 || page.Tags["prod"] != 3 || page.Tags["k3s"] != 2 {
		t.Fatalf("tag k3s = %+v", page)
	}
	g := page.Guests[0]
	if g.HAState != "started" || g.BackupJob == nil || !*g.BackupJob || g.GuestAgent != "running" || len(g.Tags) != 2 {
		t.Errorf("guest = %+v", g)
	}
	var d map[string]any
	admin.json(http.MethodGet, "/api/v1/servers/shale", nil, 200, &d)
	kinds := map[string]bool{}
	for _, h := range d["hints"].([]any) {
		kinds[h.(map[string]any)["kind"].(string)] = true
	}
	for _, k := range []string{model.HintNoBackupJob, model.HintBackupOld, model.HintPendingChanges, model.HintAgentDown,
		model.HintSnapshotOld, model.HintStorageOvercommit} {
		if !kinds[k] {
			t.Errorf("shale has no %s hint: %v", k, kinds)
		}
	}
}
