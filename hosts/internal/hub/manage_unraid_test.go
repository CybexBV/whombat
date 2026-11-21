package hub

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"rackoon/internal/hub/fakefleet"
	"rackoon/internal/hub/store"
	"rackoon/internal/proto"
)

const unraidTestTask = "unraid:0123456789abcdef"

// unraidManage answers like an agent on unRAID: every unRAID command is a
// task that ends with "No errors."; archiving and autostart are done.
func unraidManage(req proto.ManageRequest) proto.ManageResponse {
	switch req.Op {
	case proto.OpTaskStatus:
		end := time.Now().UTC()
		return proto.ManageResponse{OK: true, TaskStatus: &proto.TaskStatus{ID: req.Task, Type: proto.OpParityStart, Status: "ok",
			Message: "No errors.", Started: end.Add(-time.Minute), Ended: &end, Log: []string{"$ /usr/local/sbin/emcmd cmdCheck=Check"}, LogNext: 1}}
	case proto.OpTaskList:
		return proto.ManageResponse{OK: true, Tasks: []proto.TaskStatus{{ID: unraidTestTask, Type: proto.OpMoverStart, Status: "ok"}}}
	case proto.OpNotificationArchive:
		return proto.ManageResponse{OK: true}
	case proto.OpGuestAutostart:
		return proto.ManageResponse{OK: true, Changes: []proto.ConfigChange{{Key: "autostart", Old: "true", New: "false"}}}
	}
	return proto.ManageResponse{OK: true, Task: &proto.TaskRef{ID: unraidTestTask}}
}

// setupBlackbox enrolls the fake fleet's unRAID server with manage on in
// its agent.toml and the hub.
func setupBlackbox(t *testing.T, e *env, admin *client) *fakeAgent {
	t.Helper()
	fa := e.enroll(admin, "blackbox", "Lab")
	fa.policy = proto.Policy{Console: true, Power: true, Manage: true}
	fa.manage = unraidManage
	if _, err := fa.dial(proto.Hello{}); err != nil {
		t.Fatal(err)
	}
	h := fakefleet.Blackbox()
	h.Policy = fa.policy
	fa.send(proto.MsgReport, h.Report(time.Now(), 1, "0.1.0"))
	waitFor(t, "report", 3*time.Second, func() bool {
		st, ok := e.h.snapshotOne("blackbox")
		return ok && st.Report != nil
	})
	admin.json(http.MethodPatch, "/api/v1/servers/blackbox", map[string]any{"remote_control": map[string]bool{"manage": true}}, 200, nil)
	return fa
}

func TestUnraidDetail(t *testing.T) {
	e, admin := adminEnv(t, nil)
	setupBlackbox(t, e, admin)
	var d struct {
		Server struct {
			DetailView string `json:"detail_view"`
		} `json:"server"`
		Unraid struct {
			Version  string          `json:"version"`
			License  *string         `json:"license"`
			OSUpdate *map[string]any `json:"os_update"`
			Array    struct {
				State  string           `json:"state"`
				Parity map[string]any   `json:"parity"`
				Disks  []map[string]any `json:"disks"`
			} `json:"array"`
			Pools         []map[string]any `json:"pools"`
			Flash         map[string]any   `json:"flash"`
			Shares        []map[string]any `json:"shares"`
			Plugins       []map[string]any `json:"plugins"`
			Notifications []map[string]any `json:"notifications"`
			Docker        map[string]any   `json:"docker"`
			VMs           map[string]any   `json:"vms"`
		} `json:"unraid"`
		Workloads map[string]struct {
			Guests []map[string]any `json:"guests"`
		} `json:"workloads"`
		Hints []struct {
			Kind, Severity, Entity, Title, Detail, Link string
		} `json:"hints"`
		Arrays []map[string]any `json:"arrays"`
	}
	admin.json(http.MethodGet, "/api/v1/servers/blackbox", nil, 200, &d)
	u := d.Unraid
	if d.Server.DetailView != "unraid" || u.Version != "7.3.1" || u.License == nil || *u.License != "Pro" || u.OSUpdate == nil ||
		(*u.OSUpdate)["version"] != "7.3.3" || u.Array.State != "started" || len(u.Array.Disks) != 1 || len(u.Pools) != 3 ||
		u.Flash["slot"] != "flash" || len(u.Shares) != 8 || len(u.Plugins) != 5 || len(u.Notifications) != 2 || u.Docker["enabled"] != true ||
		u.VMs["enabled"] != true {
		t.Fatalf("unraid: %+v", u)
	}
	if p := u.Array.Parity; p["state"] != "idle" || p["action"] != nil || p["last"].(map[string]any)["result"] != "cancelled" || p["schedule"] != nil {
		t.Errorf("parity: %v", p)
	}
	if disk := u.Array.Disks[0]; disk["name"] != "disk1" || disk["status"] != "ok" || disk["fs_type"] != "xfs" || disk["used_bytes"] == nil {
		t.Errorf("disk1: %v", disk)
	}
	if pl := u.Pools[0]; pl["name"] != "apps" || pl["profile"] != "raid10" || pl["fs_type"] != "luks:btrfs" || len(pl["disks"].([]any)) != 4 {
		t.Errorf("apps: %v", pl)
	}
	var plex, overseerr map[string]any
	for _, g := range d.Workloads["docker"].Guests {
		switch g["id"] {
		case "docker:plex":
			plex = g
		case "docker:immich_server":
			overseerr = g
		}
	}
	if plex["autostart"] != true || plex["template"] != true || plex["update_available"] != true ||
		plex["web_ui"] != "http://10.30.0.40:32400/web/index.html" {
		t.Errorf("plex: %v", plex)
	}
	if overseerr["template"] != false || overseerr["autostart"] != false {
		t.Errorf("immich_server: %v", overseerr)
	}
	for _, g := range d.Workloads["libvirt"].Guests {
		if g["id"] == "libvirt:pbs" && g["autostart"] != true {
			t.Errorf("pbs: %v", g)
		}
	}
	kinds := map[string]string{}
	for _, h := range d.Hints {
		kinds[h.Kind] = h.Entity
		switch h.Kind {
		case "docker.image_updates":
			t.Errorf("docker.image_updates on unRAID: %+v", h)
		case "docker.update_available":
			if h.Detail != "plex" || h.Link != "#guests" {
				t.Errorf("update hint: %+v", h)
			}
		case "unraid.notification":
			if h.Severity != "warning" || h.Title != "Alert [BLACKBOX] - Docker image disk utilization of 91%" {
				t.Errorf("notification hint: %+v", h)
			}
		case "unraid.pool_full":
			if h.Entity != "pool:storage" || h.Link != "#array" {
				t.Errorf("pool hint: %+v", h)
			}
		}
	}
	for _, k := range []string{"unraid.plugin_updates", "unraid.os_update", "unraid.notification", "docker.update_available", "unraid.pool_full"} {
		if _, ok := kinds[k]; !ok {
			t.Errorf("no %s hint: %v", k, kinds)
		}
	}
	if kinds["unraid.notification"] != "Docker_critical_image_disk_utilization_1760180400" {
		t.Errorf("notification entity: %q", kinds["unraid.notification"])
	}
	if _, ok := kinds["unraid.parity_old"]; ok {
		t.Error("parity_old without parity disks")
	}
	if len(d.Arrays) != 1 || d.Arrays[0]["state"] != "clean" {
		t.Errorf("arrays: %v", d.Arrays)
	}
	var servers []struct {
		ID         string `json:"id"`
		DetailView string `json:"detail_view"`
	}
	admin.json(http.MethodGet, "/api/v1/servers", nil, 200, &servers)
	if len(servers) != 1 || servers[0].DetailView != "unraid" {
		t.Errorf("servers: %+v", servers)
	}
}

func TestUnraidManageRoutes(t *testing.T) {
	e, admin := adminEnv(t, func(c *Config) { c.TaskPollInterval = 50 * time.Millisecond })
	fa := setupBlackbox(t, e, admin)
	sub, _, _ := e.h.bus.Subscribe(0, store.RoleRank(store.RoleViewer), 0)
	defer e.h.bus.Unsubscribe(sub)
	const base = "/api/v1/servers/blackbox"

	// Stopping the array asks first.
	if p := admin.problem(http.MethodPost, base+"/unraid/array/stop", map[string]any{}, 400); p.Code != "confirm_required" {
		t.Fatalf("stop without confirm: %+v", p)
	}
	var res struct {
		Task    *proto.TaskRef `json:"task"`
		AuditID string         `json:"audit_id"`
	}
	admin.json(http.MethodPost, base+"/unraid/array/stop", map[string]any{"confirm": true}, 202, &res)
	if res.Task == nil || res.Task.ID != unraidTestTask {
		t.Fatalf("stop: %+v", res)
	}
	if req := fa.lastManage(t); req.Op != proto.OpArrayStop || req.Platform != proto.PlatformUnraid || req.GuestID != "" {
		t.Errorf("agent got %+v", req)
	}
	// The hub follows the task: task.finished with the agent's message.
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
	if ev["server"] != "blackbox" || ev["guest"] != nil || ev["op"] != proto.OpArrayStop || ev["result"] != "ok" || ev["message"] != "No errors." {
		t.Errorf("task.finished = %v", ev)
	}
	if req := fa.lastManage(t); req.Op != proto.OpTaskStatus || req.Platform != proto.PlatformUnraid || req.Task != unraidTestTask {
		t.Errorf("task poll: %+v", req)
	}

	// Each route's operation and fields.
	for _, c := range []struct {
		method, path string
		body         map[string]any
		want         int
		check        func(r proto.ManageRequest) bool
	}{
		{"POST", "/unraid/array/start", nil, 202, func(r proto.ManageRequest) bool { return r.Op == proto.OpArrayStart }},
		{"POST", "/unraid/parity/start", map[string]any{"correct": true}, 202, func(r proto.ManageRequest) bool { return r.Op == proto.OpParityStart && r.Correct }},
		{"POST", "/unraid/parity/pause", nil, 202, func(r proto.ManageRequest) bool { return r.Op == proto.OpParityPause }},
		{"POST", "/unraid/parity/resume", nil, 202, func(r proto.ManageRequest) bool { return r.Op == proto.OpParityResume }},
		{"POST", "/unraid/parity/cancel", map[string]any{"confirm": true}, 202, func(r proto.ManageRequest) bool { return r.Op == proto.OpParityCancel }},
		{"POST", "/unraid/disks/all/spin-down", nil, 202, func(r proto.ManageRequest) bool { return r.Op == proto.OpDiskSpinDown && r.Disk == "all" }},
		{"POST", "/unraid/disks/disk1/spin-up", map[string]any{"platform": "unraid"}, 202, func(r proto.ManageRequest) bool {
			return r.Op == proto.OpDiskSpinUp && r.Disk == "disk1"
		}},
		{"POST", "/unraid/mover", nil, 202, func(r proto.ManageRequest) bool { return r.Op == proto.OpMoverStart }},
		{"POST", "/unraid/plugins/check", nil, 202, func(r proto.ManageRequest) bool { return r.Op == proto.OpPluginCheck }},
		{"POST", "/unraid/plugins/tailscale.plg/update", map[string]any{"confirm": true}, 202, func(r proto.ManageRequest) bool {
			return r.Op == proto.OpPluginUpdate && r.Plugin == "tailscale.plg"
		}},
		{"POST", "/unraid/plugins/all/update", map[string]any{"confirm": true}, 202, func(r proto.ManageRequest) bool { return r.Plugin == "all" }},
		{"POST", "/unraid/notifications/archive", map[string]any{"id": "System___Unraid_7.3.3_ticket"}, 200, func(r proto.ManageRequest) bool {
			return r.Op == proto.OpNotificationArchive && r.Notification == "System___Unraid_7.3.3_ticket"
		}},
		{"POST", "/unraid/notifications/archive", nil, 200, func(r proto.ManageRequest) bool { return r.Notification == "" }},
		{"POST", "/unraid/containers/check", nil, 202, func(r proto.ManageRequest) bool { return r.Op == proto.OpContainersCheck }},
		{"POST", "/guests/docker:plex/update", map[string]any{"confirm": true, "platform": "unraid"}, 202, func(r proto.ManageRequest) bool {
			return r.Op == proto.OpContainerUpdate && r.Platform == proto.PlatformDocker && r.GuestID == "plex"
		}},
		{"PUT", "/guests/libvirt:pbs/autostart", map[string]any{"on": false}, 200, func(r proto.ManageRequest) bool {
			return r.Op == proto.OpGuestAutostart && r.Platform == proto.PlatformLibvirt && r.GuestID == "pbs" && r.On != nil && !*r.On
		}},
		{"PUT", "/guests/docker:overseerr/autostart", map[string]any{"on": true}, 200, func(r proto.ManageRequest) bool {
			return r.Op == proto.OpGuestAutostart && r.Platform == proto.PlatformDocker && *r.On
		}},
	} {
		var body any
		if c.body != nil {
			body = c.body
		}
		admin.json(c.method, base+c.path, body, c.want, nil)
		if req := fa.lastManage(t); !c.check(req) {
			t.Errorf("%s %s: agent got %+v", c.method, c.path, req)
		}
		waitFor(t, "task watchers", 3*time.Second, func() bool {
			e.h.tasks.mu.Lock()
			defer e.h.tasks.mu.Unlock()
			return len(e.h.tasks.m) == 0
		})
	}

	// Refusals before the agent.
	n := len(fa.manages)
	for _, c := range []struct {
		method, path string
		body         map[string]any
		status       int
		code         string
	}{
		{"POST", "/unraid/disks/DISK..1/spin-up", nil, 400, "invalid_value"},
		{"POST", "/unraid/plugins/x.sh/update", map[string]any{"confirm": true}, 400, "invalid_value"},
		{"POST", "/unraid/plugins/tailscale.plg/update", map[string]any{}, 400, "confirm_required"},
		{"POST", "/guests/docker:plex/update", map[string]any{}, 400, "confirm_required"},
		{"POST", "/guests/libvirt:pbs/update", map[string]any{"confirm": true}, 501, "unsupported"},
		{"PUT", "/guests/libvirt:pbs/autostart", map[string]any{}, 400, "invalid_value"},
		{"PUT", "/guests/libvirt:pbs/autostart", map[string]any{"on": true, "platform": "pve"}, 400, "invalid_value"},
		{"POST", "/unraid/notifications/archive", map[string]any{"id": "../x"}, 400, "invalid_value"},
		{"POST", "/unraid/mover", map[string]any{"platform": "pve"}, 400, "invalid_value"},
		{"POST", "/unraid/mover", map[string]any{"force": true}, 400, "bad_request"},
		{"POST", "/guests/docker:nope/update", map[string]any{"confirm": true}, 404, "guest_not_found"},
	} {
		var body any
		if c.body != nil {
			body = c.body
		}
		if p := admin.problem(c.method, base+c.path, body, c.status); p.Code != c.code {
			t.Errorf("%s %s: %+v", c.method, c.path, p)
		}
	}
	if len(fa.manages) != n {
		t.Errorf("refused requests reached the agent: %+v", fa.manages[n:])
	}

	// Tasks: the agent's unRAID tasks, the default platform on unRAID.
	var list struct {
		Items []proto.TaskStatus `json:"items"`
	}
	admin.json(http.MethodGet, base+"/tasks", nil, 200, &list)
	if req := fa.lastManage(t); req.Op != proto.OpTaskList || req.Platform != proto.PlatformUnraid || len(list.Items) != 1 {
		t.Errorf("tasks: %+v, agent got %+v", list, req)
	}
	admin.json(http.MethodGet, base+"/guests/docker:plex/tasks", nil, 200, &list)
	if req := fa.lastManage(t); req.Op != proto.OpTaskList || req.Platform != proto.PlatformDocker || req.GuestID != "plex" {
		t.Errorf("a container's tasks: agent got %+v", req)
	}
	var st proto.TaskStatus
	admin.json(http.MethodGet, base+"/tasks/"+unraidTestTask+"?platform=unraid&log_start=0", nil, 200, &st)
	if st.Status != "ok" || len(st.Log) != 1 {
		t.Errorf("task status: %+v", st)
	}
	if p := admin.problem(http.MethodGet, base+"/tasks/unraid:XYZ", nil, 400); p.FieldErrors["task"] == "" {
		t.Errorf("bad unraid task id: %+v", p)
	}

	// Audit: the plugin and the choice are in the details.
	found := false
	for _, rec := range e.audit("manage.requested") {
		if rec.Details["op"] == proto.OpPluginUpdate && rec.Details["plugin"] == "tailscale.plg" {
			found = true
		}
		if rec.Details["op"] == proto.OpParityStart && rec.Details["correct"] != "true" {
			t.Errorf("parity audit: %+v", rec.Details)
		}
	}
	if !found {
		t.Error("no plugin.update audit")
	}

	// Operators run checks; starting the array, plugin and container
	// updates are for admins.
	e.addUser("otto", store.RoleOperator, "operator password")
	o := e.client()
	o.login("otto", "operator password")
	o.json(http.MethodPost, base+"/unraid/parity/start", map[string]any{}, 202, nil)
	for path, body := range map[string]map[string]any{"/unraid/array/start": {}, "/unraid/plugins/all/update": {"confirm": true},
		"/guests/docker:plex/update": {"confirm": true}} {
		if p := o.problem(http.MethodPost, base+path, body, 403); p.Code != "insufficient_role" {
			t.Errorf("operator %s: %+v", path, p)
		}
	}
	o.json(http.MethodPut, base+"/guests/docker:plex/autostart", map[string]any{"on": true}, 200, nil)
	if !strings.HasPrefix(fa.lastManage(t).Op, "guest.autostart") {
		t.Error("operator autostart")
	}
}

func TestUnraidRoutesElsewhere(t *testing.T) {
	e, admin := adminEnv(t, nil)
	fa := setupManageHost(t, e, admin) // shale, Proxmox VE
	n := len(fa.manages)
	for _, path := range []string{"/unraid/mover", "/unraid/array/start"} {
		if p := admin.problem(http.MethodPost, "/api/v1/servers/shale"+path, map[string]any{}, 501); p.Code != "unsupported" {
			t.Errorf("%s on Proxmox VE: %+v", path, p)
		}
	}
	if p := admin.problem(http.MethodPut, "/api/v1/servers/shale/guests/pve:100/autostart", map[string]any{"on": true}, 501); p.Code != "unsupported" {
		t.Errorf("autostart of a PVE guest: %+v", p)
	}
	if len(fa.manages) != n {
		t.Errorf("reached the agent: %+v", fa.manages[n:])
	}
}
