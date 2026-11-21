package hub

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"rackoon/internal/hub/fakefleet"
	"rackoon/internal/hub/model"
	"rackoon/internal/hub/store"
	"rackoon/internal/proto"
)

// setupIncusHost enrolls basalt (Incus, with the self guest "whombat")
// with power and manage on in its agent.toml and in the hub.
func setupIncusHost(t *testing.T, e *env, admin *client) *fakeAgent {
	t.Helper()
	fa := e.enroll(admin, "basalt", "Production")
	fa.policy = proto.Policy{Console: true, Power: true, Manage: true}
	if _, err := fa.dial(proto.Hello{}); err != nil {
		t.Fatal(err)
	}
	fa.send(proto.MsgReport, fa.report("basalt"))
	waitFor(t, "report", 3*time.Second, func() bool {
		st, ok := e.h.snapshotOne("basalt")
		return ok && st.Report != nil
	})
	admin.json(http.MethodPatch, "/api/v1/servers/basalt", map[string]any{"remote_control": map[string]bool{"manage": true, "power": true, "console": true}}, 200, nil)
	return fa
}

func TestSelfMACs(t *testing.T) {
	dir := t.TempDir()
	saved := sysNetDir
	sysNetDir = dir
	defer func() { sysNetDir = saved }()
	for name, addr := range map[string]string{"lo": "00:00:00:00:00:00", "enp5s0": "10:66:6A:66:F9:AD\n", "docker0": "02:42:ac:11:00:01",
		"tun0": "00:00:00:00:00:00", "bad": "x"} {
		os.MkdirAll(filepath.Join(dir, name), 0o755)
		os.WriteFile(filepath.Join(dir, name, "address"), []byte(addr), 0o644)
	}
	if got := strings.Join(readSelfMACs(), ","); got != "02:42:ac:11:00:01,10:66:6a:66:f9:ad" {
		t.Errorf("own MACs: %s", got)
	}
	if got := strings.Join(ParseSelfMACs(" 10:66:6A:00:00:01, junk,10:66:6a:00:00:01,00:00:00:00:00:00"), ","); got != "10:66:6a:00:00:01" {
		t.Errorf("--self-macs: %s", got)
	}
}

func TestSelfGuest(t *testing.T) {
	e, admin := adminEnv(t, func(c *Config) { c.SelfMACs = []string{fakefleet.SelfMAC} })
	fa := setupIncusHost(t, e, admin)

	// The server and the guest say so.
	var detail struct {
		Server struct {
			DetailView       string `json:"detail_view"`
			HostsThisWhombat bool   `json:"hosts_this_whombat"`
		} `json:"server"`
		Incus *struct {
			Version  string `json:"version"`
			Projects []struct {
				Name      string `json:"name"`
				Instances int    `json:"instances"`
			} `json:"projects"`
			Pools []struct {
				Name      string  `json:"name"`
				UsedBytes *uint64 `json:"used_bytes"`
			} `json:"pools"`
			Volumes []struct {
				Name   string   `json:"name"`
				UsedBy []string `json:"used_by"`
			} `json:"volumes"`
			Images []struct {
				Fingerprint string `json:"fingerprint"`
				UploadedAt  string `json:"uploaded_at"`
			} `json:"images"`
		} `json:"incus"`
		Hints []struct {
			Kind   string   `json:"kind"`
			Guests []string `json:"guests"`
		} `json:"hints"`
	}
	admin.json(http.MethodGet, "/api/v1/servers/basalt", nil, 200, &detail)
	if detail.Server.DetailView != "incus" || !detail.Server.HostsThisWhombat || detail.Incus == nil || detail.Incus.Version != "6.16" ||
		len(detail.Incus.Pools) != 2 || detail.Incus.Volumes[0].UsedBy[0] != "incus:git-mirror" || detail.Incus.Images[0].UploadedAt == "" {
		t.Fatalf("detail: %+v %+v", detail.Server, detail.Incus)
	}
	hinted := false
	for _, h := range detail.Hints {
		if h.Kind == "incus.no_snapshots" && strings.Join(h.Guests, ",") == "incus:ci-runner" {
			hinted = true
		}
	}
	if !hinted {
		t.Errorf("no incus.no_snapshots hint for ci-runner: %+v", detail.Hints)
	}
	var list []map[string]any
	admin.json(http.MethodGet, "/api/v1/servers", nil, 200, &list)
	if list[0]["hosts_this_whombat"] != true || list[0]["detail_view"] != "incus" {
		t.Errorf("server list: %v", list[0])
	}
	var g map[string]any
	admin.json(http.MethodGet, "/api/v1/servers/basalt/guests/incus:whombat", nil, 200, &g)
	if g["self"] != true {
		t.Errorf("self guest: %v", g)
	}
	g = nil
	admin.json(http.MethodGet, "/api/v1/servers/basalt/guests/incus:nixbuild", nil, 200, &g)
	if _, ok := g["self"]; ok {
		t.Errorf("another guest marked: %v", g)
	}

	// Power: stopping it is refused, a snapshot is taken.
	const actions = "/api/v1/servers/basalt/guests/incus:whombat/actions"
	for _, a := range []string{"shutdown", "force_stop", "reboot", "pause", "snapshot_restore", "ctrl_alt_del"} {
		body := map[string]any{"action": a, "confirm": true, "snapshot": "s1"}
		if p := admin.problem(http.MethodPost, actions, body, 409); p.Code != "self_guest" || p.Detail != "That’s this Whombat itself." {
			t.Errorf("%s: %+v", a, p)
		}
	}
	var snap struct {
		ActionID string `json:"action_id"`
	}
	admin.json(http.MethodPost, actions, map[string]any{"action": "snapshot_create"}, 202, &snap)
	admin.json(http.MethodPost, "/api/v1/servers/basalt/guests/incus:nixbuild/actions", map[string]any{"action": "reboot", "confirm": true}, 202, nil)
	// The snapshot holds the guest until it finishes: the backup below
	// waits for that instead of racing it.
	waitFor(t, "the snapshot to finish", 10*time.Second, func() bool {
		for _, r := range e.audit("action.finished") {
			if r.Details["action_id"] == snap.ActionID {
				return true
			}
		}
		return false
	})
	denied := 0
	for _, r := range e.audit("action.requested") {
		if r.Outcome == "denied" && r.Code == "self_guest" {
			denied++
		}
	}
	if denied != 6 {
		t.Errorf("audit: %s", fmtRecs(e.audit("action.requested")))
	}

	// Manage: settings, rename, delete refused; a backup and a copy allowed.
	fa.mu.Lock()
	fa.manage = func(req proto.ManageRequest) proto.ManageResponse { return proto.ManageResponse{OK: true} }
	fa.mu.Unlock()
	base := "/api/v1/servers/basalt/guests/incus:whombat"
	for _, c := range []struct{ method, path string }{
		{http.MethodPut, base + "/config"},
		{http.MethodPost, base + "/rename"},
		{http.MethodPost, base + "/publish"},
		{http.MethodDelete, base + "?confirm_name=whombat"},
		{http.MethodPost, base + "/disks/root/resize"},
	} {
		var body any
		switch {
		case strings.HasSuffix(c.path, "/config"):
			body = map[string]any{"set": map[string]string{"limits.cpu": "2"}}
		case strings.HasSuffix(c.path, "/rename"):
			body = map[string]any{"name": "box"}
		case strings.HasSuffix(c.path, "/resize"):
			body = map[string]any{"size": "+1G"}
		}
		if p := admin.problem(c.method, c.path, body, 409); p.Code != "self_guest" {
			t.Errorf("%s %s: %+v", c.method, c.path, p)
		}
	}
	admin.json(http.MethodPost, base+"/backups", map[string]any{"name": "before-upgrade"}, 200, nil)
	admin.json(http.MethodPost, base+"/clone", map[string]any{"name": "whombat-copy"}, 200, nil)
	admin.json(http.MethodGet, base+"/config", nil, 502, nil) // a read goes to the agent (whose fake answers nothing)
	if req := fa.lastManage(t); req.Op != proto.OpConfigGet {
		t.Errorf("last request: %+v", req)
	}
	if recs := e.audit("manage.requested"); len(recs) < 7 {
		t.Errorf("manage audit: %s", fmtRecs(recs))
	}

	// The unRAID guest routes refuse it too: make the libvirt VM haos the
	// self guest.
	st, _ := e.h.snapshotOne("basalt")
	haos := st.Report.FindGuest(proto.PlatformLibvirt, "haos")
	if haos == nil || len(haos.MACs) != 1 {
		t.Fatalf("haos: %+v", haos)
	}
	set := map[string]bool{haos.MACs[0]: true}
	e.h.selfMACs.Store(&set)
	fa.send(proto.MsgReport, fa.report("basalt"))
	waitFor(t, "haos marked", 3*time.Second, func() bool { return isSelfGuest(mustState(e, "basalt"), "libvirt:haos") })
	if p := admin.problem(http.MethodPut, "/api/v1/servers/basalt/guests/libvirt:haos/autostart", map[string]any{"on": false}, 409); p.Code != "self_guest" {
		t.Errorf("autostart of the self guest: %+v", p)
	}
}

func mustState(e *env, id string) *model.ServerState {
	st, _ := e.h.snapshotOne(id)
	return st
}

// incusAgent answers the Incus operations like the agent would.
func incusAgent(req proto.ManageRequest) proto.ManageResponse {
	task := &proto.TaskRef{ID: "incus:0000000a-0000-4000-8000-00000000000a"}
	switch req.Op {
	case proto.OpProfileGet:
		return proto.ManageResponse{OK: true, Profile: &proto.IncusProfile{Name: req.Profile, Project: "default", Digest: "d1",
			Config: map[string]string{"limits.cpu": "2"}, UsedBy: []string{"web", "ci/job-1"}}}
	case proto.OpNetworkLeases:
		return proto.ManageResponse{OK: true, Leases: []proto.IncusLease{{Hostname: "web", Address: "10.62.52.73", HWAddr: "10:66:6a:00:00:01",
			Type: "dynamic", GuestID: "web"}, {Hostname: "phone", Address: "10.62.52.99", Type: "dynamic"}}}
	case proto.OpChoices:
		return proto.ManageResponse{OK: true, Choices: &proto.Choices{Platform: "incus", Project: req.Project}}
	case proto.OpLogGet:
		return proto.ManageResponse{OK: true, Log: &proto.GuestLog{File: "lxc.log", Lines: []string{"a", "b"}}}
	case proto.OpProfileUpdate, proto.OpVolumeResize:
		return proto.ManageResponse{OK: true, Changes: []proto.ConfigChange{{Key: "limits.cpu", Old: "2", New: "4"}}}
	case proto.OpImageDownload, proto.OpPublish, proto.OpMove, proto.OpRename, proto.OpBackupCreate:
		resp := proto.ManageResponse{OK: true, Task: task}
		switch req.Op {
		case proto.OpMove:
			resp.NewID = "lab/" + req.GuestID
		case proto.OpRename:
			resp.NewID = req.Name
		}
		return resp
	case proto.OpBackupRestore:
		return proto.ManageResponse{OK: true, Task: task, NewID: req.Name}
	case proto.OpTaskStatus:
		return proto.ManageResponse{OK: true, TaskStatus: &proto.TaskStatus{ID: req.Task, Status: "ok", Message: "OK",
			NewID: strings.Repeat("ab", 32)}}
	}
	return proto.ManageResponse{OK: true}
}

func TestIncusManageRoutes(t *testing.T) {
	e, admin := adminEnv(t, func(c *Config) { c.TaskPollInterval = 50 * time.Millisecond })
	fa := setupIncusHost(t, e, admin)
	fa.mu.Lock()
	fa.manage = incusAgent
	fa.mu.Unlock()
	sub, _, _ := e.h.bus.Subscribe(0, store.RoleRank(store.RoleViewer), 0)
	defer e.h.bus.Unsubscribe(sub)
	const srv = "/api/v1/servers/basalt"

	// Reads.
	var prof struct {
		Op      string `json:"op"`
		Profile struct {
			Name   string   `json:"name"`
			UsedBy []string `json:"used_by"`
			Digest string   `json:"digest"`
		} `json:"profile"`
	}
	admin.json(http.MethodGet, srv+"/incus/profiles/default?project=lab", nil, 200, &prof)
	if prof.Op != "profile.get" || strings.Join(prof.Profile.UsedBy, ",") != "incus:web,incus:ci/job-1" || prof.Profile.Digest != "d1" {
		t.Errorf("profile: %+v", prof)
	}
	if req := fa.lastManage(t); req.Op != proto.OpProfileGet || req.Platform != "incus" || req.Profile != "default" || req.Project != "lab" {
		t.Errorf("agent got %+v", req)
	}
	var leases struct {
		Items []map[string]any `json:"items"`
	}
	admin.json(http.MethodGet, srv+"/incus/networks/incusbr0/leases", nil, 200, &leases)
	if len(leases.Items) != 2 || leases.Items[0]["guest_id"] != "incus:web" || leases.Items[1]["guest_id"] != nil {
		t.Errorf("leases: %+v", leases)
	}
	var lg struct {
		File  string   `json:"file"`
		Lines []string `json:"lines"`
	}
	admin.json(http.MethodGet, srv+"/guests/incus:dev-shell/log?lines=20", nil, 200, &lg)
	if lg.File != "lxc.log" || len(lg.Lines) != 2 || fa.lastManage(t).Lines != 20 {
		t.Errorf("log: %+v", lg)
	}
	admin.problem(http.MethodGet, srv+"/guests/incus:dev-shell/log?lines=5000", nil, 400)

	// Changes.
	var res struct {
		Task    *proto.TaskRef       `json:"task"`
		NewID   string               `json:"new_id"`
		Changes []proto.ConfigChange `json:"changes"`
	}
	admin.json(http.MethodPost, srv+"/guests/incus:scratch/rename", map[string]any{"name": "scratch2"}, 202, &res)
	if res.NewID != "incus:scratch2" {
		t.Errorf("rename: %+v", res)
	}
	admin.problem(http.MethodPost, srv+"/guests/incus:scratch/rename", map[string]any{"name": "2bad"}, 400)
	if p := admin.problem(http.MethodPost, srv+"/guests/incus:scratch/move", map[string]any{"pool": "scratch"}, 400); p.Code != "confirm_required" {
		t.Errorf("move without confirm: %+v", p)
	}
	admin.json(http.MethodPost, srv+"/guests/incus:scratch/move", map[string]any{"project": "lab", "confirm": true}, 202, &res)
	if res.NewID != "incus:lab/scratch" {
		t.Errorf("move: %+v", res)
	}
	admin.json(http.MethodPost, srv+"/guests/incus:scratch/publish", map[string]any{"alias": "scratch/1", "description": "Scratch"}, 202, &res)
	admin.json(http.MethodPut, srv+"/incus/profiles/big", map[string]any{"digest": "d1", "set": map[string]string{"limits.cpu": "4"},
		"devices": map[string]any{"eth1": map[string]string{"type": "nic", "network": "incusbr0"}, "old": nil}}, 200, &res)
	if req := fa.lastManage(t); req.Profile != "big" || req.Devices["eth1"]["network"] != "incusbr0" || req.Devices["old"] != nil || len(req.Devices) != 2 {
		t.Errorf("profile.update got %+v", req)
	}
	if len(res.Changes) != 1 {
		t.Errorf("profile.update: %+v", res)
	}
	admin.json(http.MethodPost, srv+"/incus/profiles", map[string]any{"name": "small_ones", "copy_from": "default"}, 200, nil)
	if p := admin.problem(http.MethodDelete, srv+"/incus/profiles/small_ones", nil, 400); p.Code != "confirm_required" {
		t.Errorf("profile delete without confirm: %+v", p)
	}
	admin.json(http.MethodDelete, srv+"/incus/profiles/small_ones?confirm=1", nil, 200, nil)
	admin.json(http.MethodPost, srv+"/incus/pools/default/volumes", map[string]any{"name": "data.2", "size": "10GiB", "content_type": "block"}, 200, nil)
	admin.problem(http.MethodPost, srv+"/incus/pools/default/volumes", map[string]any{"name": "x", "size": "lots"}, 400)
	admin.json(http.MethodPost, srv+"/incus/pools/default/volumes/data.2/resize", map[string]any{"size": "20GiB"}, 200, nil)
	admin.json(http.MethodDelete, srv+"/incus/pools/default/volumes/data.2?confirm=1", nil, 200, nil)
	if req := fa.lastManage(t); req.Op != proto.OpVolumeDelete || req.Pool != "default" || req.Volume != "data.2" {
		t.Errorf("volume.delete got %+v", req)
	}
	admin.problem(http.MethodPost, srv+"/incus/images", map[string]any{"alias": "debian/13", "type": "kvm"}, 400)
	admin.json(http.MethodPost, srv+"/incus/images", map[string]any{"alias": "debian/13", "type": "virtual-machine", "auto_update": false}, 202, &res)
	if req := fa.lastManage(t); req.Alias != "debian/13" || req.ImageType != "virtual-machine" || req.AutoUpdate == nil || *req.AutoUpdate {
		t.Errorf("image.download got %+v", req)
	}
	admin.json(http.MethodPost, srv+"/incus/images/6f9e1c3b2a4d/refresh", map[string]any{}, 200, nil)
	admin.json(http.MethodDelete, srv+"/incus/images/6f9e1c3b2a4d", nil, 200, nil)
	admin.problem(http.MethodDelete, srv+"/incus/images/not-hex", nil, 400)

	// The image task ends with its fingerprint.
	deadline := time.After(5 * time.Second)
	found := false
	for !found {
		select {
		case m := <-sub.C:
			var ev map[string]any
			if m.Name == "task.finished" && json.Unmarshal(m.Data, &ev) == nil && ev["op"] == proto.OpImageDownload {
				found = true
				if ev["new_id"] != strings.Repeat("ab", 32) || ev["guest"] != nil {
					t.Errorf("task.finished = %v", ev)
				}
			}
		case <-deadline:
			t.Fatal("no task.finished for the download")
		}
	}

	// Create, clone and backups take the Incus fields; restore names the
	// source and needs no confirmation (it makes a new instance).
	admin.json(http.MethodPost, srv+"/guests", map[string]any{"platform": "incus", "kind": "vm", "name": "cloudy", "image": "images:debian/13/cloud",
		"project": "lab", "pool": "default", "network": "incusbr0", "cloud_init": "#cloud-config\n"}, 200, nil)
	if req := fa.lastManage(t); req.Project != "lab" || req.Pool != "default" || req.Network != "incusbr0" || req.CloudInit != "#cloud-config\n" {
		t.Errorf("create got %+v", req)
	}
	admin.json(http.MethodPost, srv+"/guests/incus:dev-shell/clone", map[string]any{"name": "dev-2", "project": "lab", "instance_only": true}, 200, nil)
	exp := time.Now().Add(72 * time.Hour).UTC().Format(time.RFC3339)
	admin.json(http.MethodPost, srv+"/guests/incus:dev-shell/backups", map[string]any{"name": "nightly", "expires_at": exp, "compression": "gzip"}, 202, nil)
	if req := fa.lastManage(t); req.Name != "nightly" || req.ExpiresAt == nil || req.Compression != "gzip" || req.Storage != "" {
		t.Errorf("backup.create got %+v", req)
	}
	admin.json(http.MethodPost, srv+"/backups/restore", map[string]any{"platform": "incus", "guest": "incus:dev-shell", "volume": "nightly",
		"name": "dev-restored", "storage": "scratch", "start": true}, 202, &res)
	if req := fa.lastManage(t); req.GuestID != "dev-shell" || req.Volume != "nightly" || req.Name != "dev-restored" || !req.Start {
		t.Errorf("restore got %+v", req)
	}
	if res.NewID != "incus:dev-restored" {
		t.Errorf("restore: %+v", res)
	}
	admin.json(http.MethodDelete, srv+"/backups?platform=incus&guest=incus:dev-shell&volume=nightly", nil, 200, nil)
	if req := fa.lastManage(t); req.Op != proto.OpBackupDelete || req.GuestID != "dev-shell" || req.Volume != "nightly" {
		t.Errorf("backup.delete got %+v", req)
	}
	admin.json(http.MethodPut, srv+"/guests/incus:dev-shell/config", map[string]any{"profiles": []string{"default", "big"},
		"devices": map[string]any{"data": map[string]string{"type": "disk", "pool": "default", "source": "git-data", "path": "/data"}}}, 200, nil)
	if req := fa.lastManage(t); strings.Join(req.Profiles, ",") != "default,big" || req.Devices["data"]["source"] != "git-data" {
		t.Errorf("config.set got %+v", req)
	}
	admin.json(http.MethodGet, srv+"/manage/choices?project=lab", nil, 200, nil)
	if req := fa.lastManage(t); req.Op != proto.OpChoices || req.Project != "lab" {
		t.Errorf("choices got %+v", req)
	}
	recs := e.audit("manage.requested")
	var create store.AuditRecord
	for _, r := range recs {
		if r.Details["op"] == proto.OpCreate {
			create = r
		}
	}
	if create.Details["cloud_init"] != "set" || create.Details["project"] != "lab" || strings.Contains(fmtRecs(recs), "cloud-config") {
		t.Errorf("create audit: %+v", create.Details)
	}
}

func TestIncusRoutesElsewhere(t *testing.T) {
	e, admin := adminEnv(t, nil)
	setupManageHost(t, e, admin)
	const srv = "/api/v1/servers/shale"
	for _, c := range []struct{ method, path string }{
		{http.MethodGet, srv + "/incus/profiles/default"},
		{http.MethodPost, srv + "/guests/pve:100/rename"},
		{http.MethodGet, srv + "/guests/pve:100/log"},
		{http.MethodPost, srv + "/incus/images"},
	} {
		var body any
		switch {
		case strings.HasSuffix(c.path, "/rename"):
			body = map[string]any{"name": "web"}
		case strings.HasSuffix(c.path, "/images"):
			body = map[string]any{"alias": "debian/13", "type": "container"}
		}
		if p := admin.problem(c.method, c.path, body, 501); p.Code != "unsupported" {
			t.Errorf("%s %s: %+v", c.method, c.path, p)
		}
	}
	// A Proxmox restore over a guest still needs the confirmation.
	if p := admin.problem(http.MethodPost, srv+"/backups/restore", map[string]any{"platform": "pve", "guest": "pve:100",
		"volume": "pbs-01:backup/vm/100/2026-10-17T01:00:00Z"}, 400); p.Code != "confirm_required" {
		t.Errorf("pve restore over: %+v", p)
	}
}
