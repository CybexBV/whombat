package hub

import (
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"rackoon/internal/hub/store"
	"rackoon/internal/proto"
)

const pkgTestTask = "pkg:0123456789abcdef"

// pkgAgent answers like an agent that installs updates: both operations
// start the task; task.status ends it with the result set in end.
type pkgAgent struct {
	mu  sync.Mutex
	end proto.TaskStatus
}

func (a *pkgAgent) manage(req proto.ManageRequest) proto.ManageResponse {
	a.mu.Lock()
	defer a.mu.Unlock()
	switch req.Op {
	case proto.OpPackagesCheck, proto.OpPackagesInstall:
		return proto.ManageResponse{OK: true, Task: &proto.TaskRef{ID: pkgTestTask}}
	case proto.OpTaskStatus:
		st := a.end
		st.ID = req.Task
		return proto.ManageResponse{OK: true, TaskStatus: &st}
	case proto.OpTaskStop:
		return proto.ManageResponse{Code: proto.CodeNotAllowed, Message: "Installing updates can’t be stopped once it started."}
	case proto.OpTaskList:
		return proto.ManageResponse{OK: true, Tasks: []proto.TaskStatus{{ID: pkgTestTask, Type: proto.OpPackagesInstall, Status: "running"}}}
	}
	return proto.ManageResponse{Code: "unsupported", Message: "unknown operation"}
}

func (a *pkgAgent) ends(st proto.TaskStatus) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.end = st
}

func TestPackagesRoutes(t *testing.T) {
	e, admin := adminEnv(t, func(c *Config) { c.TaskPollInterval = 50 * time.Millisecond })
	fa := e.enroll(admin, "basalt", "Lab")
	fa.policy = proto.Policy{Manage: true, Diagnose: true}
	ag := &pkgAgent{}
	fa.manage = ag.manage
	if _, err := fa.dial(proto.Hello{}); err != nil {
		t.Fatal(err)
	}
	rep := fa.report("basalt")
	two := 2
	started := time.Date(2026, 10, 19, 21, 0, 0, 0, time.UTC)
	rep.System.PackageTask = &proto.PackageTask{ID: pkgTestTask, Op: "install", Started: started}
	rep.System.PackageLast = &proto.PackageLast{Op: "install", Status: "failed", Finished: started.Add(-time.Hour), Installed: &two,
		Message: "Another program is installing packages on basalt right now. Try again in a few minutes.", Code: "busy"}
	fa.send(proto.MsgReport, rep)
	waitFor(t, "report", 3*time.Second, func() bool { st, _ := e.h.snapshotOne("basalt"); return st != nil && st.Report != nil })
	sub, _, _ := e.h.bus.Subscribe(0, store.RoleRank(store.RoleViewer), 0)
	defer e.h.bus.Unsubscribe(sub)
	finished := func() map[string]any {
		t.Helper()
		deadline := time.After(5 * time.Second)
		for {
			select {
			case m := <-sub.C:
				if m.Name == "task.finished" {
					var ev map[string]any
					json.Unmarshal(m.Data, &ev)
					return ev
				}
			case <-deadline:
				t.Fatal("no task.finished event")
			}
		}
	}
	const base = "/api/v1/servers/basalt"

	// The report: the running task and the last one.
	var d struct {
		System struct {
			PackageTask map[string]any `json:"package_task"`
			PackageLast map[string]any `json:"package_last"`
		} `json:"system"`
	}
	admin.json(http.MethodGet, base, nil, 200, &d)
	if pt := d.System.PackageTask; pt["id"] != pkgTestTask || pt["op"] != "install" || pt["started_at"] != "2026-10-19T21:00:00Z" {
		t.Errorf("package_task: %v", pt)
	}
	if pl := d.System.PackageLast; pl["op"] != "install" || pl["status"] != "failed" || pl["installed"] != float64(2) ||
		pl["finished_at"] != "2026-10-19T20:00:00Z" || pl["code"] != "busy" || !strings.Contains(pl["message"].(string), "basalt") {
		t.Errorf("package_last: %v", pl)
	}

	// Both switches: the hub's manage is off.
	if p := admin.problem(http.MethodPost, base+"/packages/check", map[string]any{}, 403); p.Code != "manage_disabled" {
		t.Fatalf("manage off: %+v", p)
	}
	admin.json(http.MethodPatch, base, map[string]any{"remote_control": map[string]bool{"manage": true}}, 200, nil)

	// Check: an operator's, a task the hub follows.
	e.addUser("olive", store.RoleOperator, "operator password 1")
	op := e.client()
	op.login("olive", "operator password 1")
	var res struct {
		Task    *proto.TaskRef `json:"task"`
		AuditID string         `json:"audit_id"`
	}
	ag.ends(proto.TaskStatus{Type: proto.OpPackagesCheck, Status: "ok", Message: "3 updates waiting.", Packages: &proto.PackageResult{KeptBack: []string{}}})
	op.json(http.MethodPost, base+"/packages/check", map[string]any{}, 202, &res)
	if res.Task == nil || res.Task.ID != pkgTestTask || res.AuditID == "" {
		t.Fatalf("check: %+v", res)
	}
	if req := fa.lastManage(t); req.Op != proto.OpPackagesCheck && req.Op != proto.OpTaskStatus || req.Platform != proto.PlatformHost {
		t.Errorf("agent got %+v", req)
	}
	if ev := finished(); ev["op"] != proto.OpPackagesCheck || ev["result"] != "ok" || ev["guest"] != nil || ev["code"] != nil {
		t.Errorf("check finished: %v", ev)
	}
	if p := op.problem(http.MethodPost, base+"/packages/check", map[string]any{"packages": []string{"nginx"}}, 400); p.Code != "bad_request" {
		t.Errorf("check with names: %+v", p)
	}

	// Install: an admin's, confirmed; the names go to the agent.
	if p := op.problem(http.MethodPost, base+"/packages/install", map[string]any{"confirm": true}, 403); p.Code != "insufficient_role" {
		t.Errorf("operator install: %+v", p)
	}
	if p := admin.problem(http.MethodPost, base+"/packages/install", map[string]any{}, 400); p.Code != "confirm_required" {
		t.Errorf("install without confirm: %+v", p)
	}
	if p := admin.problem(http.MethodPost, base+"/packages/install", map[string]any{"confirm": true, "packages": []string{"nginx; reboot"}}, 400); p.Code != "invalid_value" || p.FieldErrors["packages"] == "" {
		t.Errorf("bad name: %+v", p)
	}
	many := make([]string, proto.PackagesMax+1)
	for i := range many {
		many[i] = "pkg"
	}
	if p := admin.problem(http.MethodPost, base+"/packages/install", map[string]any{"confirm": true, "packages": many}, 400); p.FieldErrors["packages"] == "" {
		t.Errorf("too many: %+v", p)
	}
	ag.ends(proto.TaskStatus{Type: proto.OpPackagesInstall, Status: "ok", Message: "Installed 2 updates.",
		Packages: &proto.PackageResult{Installed: 2, KeptBack: []string{"zfs-dkms"}, Warning: "The Proxmox enterprise repository refused (it needs a subscription); the other repositories were used."}})
	admin.json(http.MethodPost, base+"/packages/install", map[string]any{"confirm": true, "packages": []string{"nginx", "libssl3:amd64"}}, 202, &res)
	fa.mu.Lock()
	var installReq proto.ManageRequest
	for _, m := range fa.manages {
		if m.Op == proto.OpPackagesInstall {
			installReq = m
		}
	}
	fa.mu.Unlock()
	if installReq.Platform != proto.PlatformHost || strings.Join(installReq.Packages, ",") != "nginx,libssl3:amd64" {
		t.Errorf("install request: %+v", installReq)
	}
	if ev := finished(); ev["op"] != proto.OpPackagesInstall || ev["result"] != "ok" {
		t.Errorf("install finished: %v", ev)
	}
	var fin *store.AuditRecord
	waitFor(t, "manage.finished", 3*time.Second, func() bool {
		for _, r := range e.audit("manage.finished") {
			if r.Details["op"] == proto.OpPackagesInstall {
				fin = &r
				return true
			}
		}
		return false
	})
	if fin.Details["installed"] != "2" || fin.Details["kept_back"] != "zfs-dkms" || fin.Details["packages"] != "nginx, libssl3:amd64" || fin.Platform != proto.PlatformHost {
		t.Errorf("manage.finished: %+v", fin)
	}

	// The package lock stayed held: the event carries busy.
	ag.ends(proto.TaskStatus{Type: proto.OpPackagesInstall, Status: "error", Code: "busy",
		Message: "Another program is installing packages on basalt right now. Try again in a few minutes.", Packages: &proto.PackageResult{KeptBack: []string{}}})
	admin.json(http.MethodPost, base+"/packages/install", map[string]any{"confirm": true}, 202, &res)
	if ev := finished(); ev["result"] != "error" || ev["code"] != "busy" {
		t.Errorf("busy finished: %v", ev)
	}

	// The task's own routes, with platform host or none.
	var st map[string]any
	admin.json(http.MethodGet, base+"/tasks/"+pkgTestTask+"?platform=host&log_start=0", nil, 200, &st)
	if pk, _ := st["packages"].(map[string]any); st["code"] != "busy" || pk == nil || pk["installed"] != float64(0) || pk["kept_back"] == nil {
		t.Errorf("task status: %v", st)
	}
	admin.json(http.MethodGet, base+"/tasks/"+pkgTestTask, nil, 200, &st)
	if req := fa.lastManage(t); req.Platform != proto.PlatformHost || req.Task != pkgTestTask {
		t.Errorf("task without platform: %+v", req)
	}
	if p := admin.problem(http.MethodGet, base+"/tasks/"+pkgTestTask+"?platform=pve", nil, 400); p.Code != "invalid_value" {
		t.Errorf("pkg task on pve: %+v", p)
	}
	if p := admin.problem(http.MethodGet, base+"/tasks/pkg:xyz?platform=host", nil, 400); p.Code != "invalid_value" {
		t.Errorf("bad task id: %+v", p)
	}
	if p := admin.problem(http.MethodGet, base+"/tasks/unraid:0123456789abcdef?platform=host", nil, 400); p.Code != "invalid_value" {
		t.Errorf("an unRAID task on host: %+v", p)
	}
	if p := admin.problem(http.MethodDelete, base+"/tasks/"+pkgTestTask+"?platform=host", nil, 403); p.Code != proto.CodeNotAllowed {
		t.Errorf("stop an install: %+v", p)
	}
	var list map[string][]map[string]any
	admin.json(http.MethodGet, base+"/tasks?platform=host", nil, 200, &list)
	if len(list["items"]) != 1 || list["items"][0]["id"] != pkgTestTask {
		t.Errorf("task list: %v", list)
	}

	// An agent that doesn't know the operations: its answer as it is.
	fa.mu.Lock()
	fa.manage = func(req proto.ManageRequest) proto.ManageResponse {
		return proto.ManageResponse{Code: "unsupported", Message: "unknown operation"}
	}
	fa.mu.Unlock()
	if p := admin.problem(http.MethodPost, base+"/packages/check", map[string]any{}, 501); p.Code != "unsupported" || p.Detail != "unknown operation" {
		t.Errorf("old agent: %+v", p)
	}
	if len(e.audit("manage.requested")) < 4 {
		t.Error("manage.requested not audited")
	}
}

// The waiting updates need diagnose or console (SWU-11), on the hub and
// the agent.
func TestInspectUpdatesGate(t *testing.T) {
	e, admin := adminEnv(t, nil)
	fa := e.enroll(admin, "basalt", "Lab")
	fa.policy = proto.Policy{Diagnose: true}
	if _, err := fa.dial(proto.Hello{}); err != nil {
		t.Fatal(err)
	}
	fa.send(proto.MsgReport, fa.report("basalt"))
	waitFor(t, "report", 3*time.Second, func() bool { st, _ := e.h.snapshotOne("basalt"); return st != nil && st.Report != nil })
	const path = "/api/v1/servers/basalt/inspect/updates"
	// Diagnose is on by default in the hub and here on the agent.
	var out map[string]any
	admin.json(http.MethodGet, path, nil, 200, &out)
	if items, _ := out["items"].([]any); len(items) != 1 {
		t.Fatalf("updates: %v", out)
	}
	if p := admin.problem(http.MethodGet, "/api/v1/servers/basalt/inspect/processes", nil, 403); p.Code != "console_disabled" {
		t.Errorf("processes still need the console: %+v", p)
	}
	admin.json(http.MethodPatch, "/api/v1/servers/basalt", map[string]any{"remote_control": map[string]bool{"diagnose": false}}, 200, nil)
	if p := admin.problem(http.MethodGet, path, nil, 403); p.Code != "diagnose_disabled" {
		t.Errorf("neither switch: %+v", p)
	}
	admin.json(http.MethodPatch, "/api/v1/servers/basalt", map[string]any{"remote_control": map[string]bool{"console": true}}, 200, nil)
	if p := admin.problem(http.MethodGet, path, nil, 403); p.Code != "diagnose_disabled" || !strings.Contains(p.Detail, "agent") {
		t.Errorf("console in the hub, not on the agent: %+v", p)
	}
}
