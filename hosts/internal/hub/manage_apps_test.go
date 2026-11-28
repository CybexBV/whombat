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

const appTestTask = "app:0123456789abcdef"

// appAgent answers like an agent that updates apps.
type appAgent struct {
	mu  sync.Mutex
	end proto.TaskStatus
}

func (a *appAgent) manage(req proto.ManageRequest) proto.ManageResponse {
	a.mu.Lock()
	defer a.mu.Unlock()
	switch req.Op {
	case proto.OpAppUpdate:
		return proto.ManageResponse{OK: true, Task: &proto.TaskRef{ID: appTestTask}}
	case proto.OpTaskStatus:
		st := a.end
		st.ID = req.Task
		return proto.ManageResponse{OK: true, TaskStatus: &st}
	}
	return proto.ManageResponse{Code: "unsupported", Message: "unknown operation"}
}

func TestAppsRoutes(t *testing.T) {
	e, admin := adminEnv(t, func(c *Config) { c.TaskPollInterval = 50 * time.Millisecond })
	fa := e.enroll(admin, "basalt", "Lab")
	fa.policy = proto.Policy{Manage: true}
	ag := &appAgent{}
	fa.manage = ag.manage
	if _, err := fa.dial(proto.Hello{}); err != nil {
		t.Fatal(err)
	}
	finished := time.Date(2026, 11, 20, 3, 0, 0, 0, time.UTC)
	rep := fa.report("basalt")
	rep.Docker = &proto.Platform{Guests: []proto.Guest{
		{ID: "immich_server", Name: "immich_server", Kind: "container", State: proto.StateRunning, Project: "immich",
			App: &proto.GuestApp{Service: "immich-server", Version: "2.3.0", NewVersion: "2.4.0",
				Last: &proto.AppLast{Status: proto.AppRolledBack, Reason: proto.AppReasonStopped, From: "2.2.1", To: "2.3.0", Finished: finished}}},
		{ID: "pinned", Name: "pinned", Kind: "container", State: proto.StateRunning, Project: "web",
			App: &proto.GuestApp{Service: "web", Blocked: proto.AppReasonPinned}},
		{ID: "lonely", Name: "lonely", Kind: "container", State: proto.StateRunning},
	}}
	fa.send(proto.MsgReport, rep)
	waitFor(t, "report", 3*time.Second, func() bool {
		st, _ := e.h.snapshotOne("basalt")
		return st != nil && st.Report != nil && st.Report.Docker != nil
	})
	admin.json(http.MethodPatch, "/api/v1/servers/basalt", map[string]any{"remote_control": map[string]bool{"manage": true}}, 200, nil)
	const base = "/api/v1/servers/basalt"

	// The guest says what Whombat can do with it.
	var guests struct {
		Items []map[string]any `json:"guests"`
	}
	admin.json(http.MethodGet, base+"/guests", nil, 200, &guests)

	byID := map[string]map[string]any{}
	for _, g := range guests.Items {
		byID[g["id"].(string)] = g
	}
	app, _ := byID["docker:immich_server"]["app"].(map[string]any)
	last, _ := app["last"].(map[string]any)
	if app["service"] != "immich-server" || app["version"] != "2.3.0" || app["new_version"] != "2.4.0" || app["blocked"] != nil ||
		app["updating"] != false || last["status"] != "rolled_back" || last["at"] != "2026-11-20T03:00:00Z" || last["to"] != "2.3.0" {
		t.Errorf("app: %v", byID["docker:immich_server"]["app"])
	}
	if _, ok := byID["docker:lonely"]["app"]; ok {
		t.Errorf("a container docker run started has no app: %v", byID["docker:lonely"])
	}

	// Refusals before the agent.
	e.addUser("olive", store.RoleOperator, "operator password 1")
	op := e.client()
	op.login("olive", "operator password 1")
	for _, c := range []struct {
		who    *client
		body   map[string]any
		status int
		code   string
	}{
		{op, map[string]any{"apps": []string{"docker:immich_server"}, "confirm": true}, 403, "insufficient_role"},
		{admin, map[string]any{"apps": []string{"docker:immich_server"}}, 400, "confirm_required"},
		{admin, map[string]any{"apps": []string{}, "confirm": true}, 400, "invalid_value"},
		{admin, map[string]any{"apps": []string{"pve:101"}, "confirm": true}, 400, "invalid_value"},
		{admin, map[string]any{"apps": []string{"docker:missing"}, "confirm": true}, 404, "guest_not_found"},
		{admin, map[string]any{"apps": []string{"docker:lonely"}, "confirm": true}, 409, "not_compose"},
		{admin, map[string]any{"apps": []string{"pinned"}, "confirm": true}, 409, "app_pinned"},
	} {
		if p := c.who.problem(http.MethodPost, base+"/apps/update", c.body, c.status); p.Code != c.code {
			t.Errorf("%v: %+v", c.body, p)
		}
	}

	// An update: one task the hub follows; the event names the app.
	sub, _, _ := e.h.bus.Subscribe(0, store.RoleRank(store.RoleViewer), 0)
	defer e.h.bus.Unsubscribe(sub)
	ag.mu.Lock()
	ag.end = proto.TaskStatus{Type: proto.OpAppUpdate, Status: "ok", Message: "Updated immich_server.",
		Apps: []proto.AppResult{{App: "immich_server", Service: "immich-server", Status: proto.AppUpdated, From: "2.3.0", To: "2.4.0"}}}
	ag.mu.Unlock()
	var res struct {
		Task *proto.TaskRef `json:"task"`
	}
	admin.json(http.MethodPost, base+"/apps/update", map[string]any{"apps": []string{"docker:immich_server", "immich_server"}, "hold_major": true, "confirm": true}, 202, &res)
	if res.Task == nil || res.Task.ID != appTestTask {
		t.Fatalf("update: %+v", res)
	}
	var req proto.ManageRequest
	fa.mu.Lock()
	for _, m := range fa.manages {
		if m.Op == proto.OpAppUpdate {
			req = m
		}
	}
	fa.mu.Unlock()
	if strings.Join(req.Apps, ",") != "immich_server" || !req.HoldMajor || req.Platform != proto.PlatformHost {
		t.Errorf("agent got %+v", req)
	}
	deadline := time.After(5 * time.Second)
	var ev map[string]any
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
	if ev["op"] != proto.OpAppUpdate || ev["result"] != "ok" || ev["guest"] != "docker:immich_server" || ev["task"] != appTestTask {
		t.Errorf("finished: %v", ev)
	}
	var fin *store.AuditRecord
	waitFor(t, "manage.finished", 3*time.Second, func() bool {
		for _, r := range e.audit("manage.finished") {
			if r.Details["op"] == proto.OpAppUpdate && r.Details["result"] != "" {
				fin = &r
				return true
			}
		}
		return false
	})
	if !strings.Contains(fin.Details["apps_result"], "immich_server updated") || fin.Details["apps"] != "immich_server" {
		t.Errorf("manage.finished: %+v", fin.Details)
	}

	// The task's status, with platform host or none.
	var st map[string]any
	admin.json(http.MethodGet, base+"/tasks/"+appTestTask, nil, 200, &st)
	if apps, _ := st["apps"].([]any); len(apps) != 1 || apps[0].(map[string]any)["to"] != "2.4.0" {
		t.Errorf("task status: %v", st)
	}
	if p := admin.problem(http.MethodGet, base+"/tasks/"+appTestTask+"?platform=pve", nil, 400); p.Code != "invalid_value" {
		t.Errorf("app task on pve: %+v", p)
	}

	// An agent from before app updates: it reports Compose projects without
	// apps, and the hub says it needs a newer agent.
	rep.Docker.Guests = []proto.Guest{{ID: "immich_server", Name: "immich_server", Kind: "container", State: proto.StateRunning, Project: "immich"}}
	fa.send(proto.MsgReport, rep)
	waitFor(t, "old report", 3*time.Second, func() bool {
		st, _ := e.h.snapshotOne("basalt")
		return st != nil && st.Report != nil && st.Report.Docker != nil && st.Report.Docker.Guests[0].App == nil
	})
	if p := admin.problem(http.MethodPost, base+"/apps/update", map[string]any{"apps": []string{"docker:immich_server"}, "confirm": true}, 409); p.Code != "agent_outdated" {
		t.Errorf("old agent: %+v", p)
	}
}
