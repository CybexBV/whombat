package hub

import (
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"rackoon/internal/hub/fakefleet"
	"rackoon/internal/proto"
)

// placeAgent answers the backup place operations like an Unraid agent;
// refuse, when set, is the answer to every place operation.
type placeAgent struct {
	mu     sync.Mutex
	refuse *proto.ManageResponse
	// hold, when set, keeps an ensure waiting until it is closed.
	hold chan struct{}
}

func (p *placeAgent) manage(req proto.ManageRequest) proto.ManageResponse {
	p.mu.Lock()
	refuse, hold := p.refuse, p.hold
	p.mu.Unlock()
	if hold != nil && req.Op == proto.OpPlaceEnsure {
		<-hold
	}
	if !proto.LongManageOp(req.Op) {
		return unraidManage(req)
	}
	if refuse != nil {
		return *refuse
	}
	switch req.Op {
	case proto.OpPlaceEnsure:
		loc, path := proto.PlaceShareName, "/mnt/user/whombat-backups/"
		if l := req.Place.Location; l != "" && l != proto.PlaceShareName {
			loc, path = l, "/mnt/user/"+l+"/whombat/"
		}
		return proto.ManageResponse{OK: true, Place: &proto.PlaceResult{Client: req.Place.Client, Port: 8747,
			Addresses: []string{"10.30.0.40"}, Path: path + req.Place.Client, Created: req.Place.Location == "",
			Location: loc, Moved: loc != proto.PlaceShareName, Kit: true}}
	case proto.OpPlaceCleanup:
		return proto.ManageResponse{OK: true, Place: &proto.PlaceResult{Set: true}}
	case proto.OpPlaceRemove:
		return proto.ManageResponse{OK: true, Place: &proto.PlaceResult{Removed: true}}
	case proto.OpPlaceNFS:
		return proto.ManageResponse{OK: true, Place: &proto.PlaceResult{Export: "/mnt/user/" + req.Place.Name, Addresses: []string{"10.30.0.40"}}}
	}
	return proto.ManageResponse{OK: true}
}

func (p *placeAgent) set(r *proto.ManageResponse) {
	p.mu.Lock()
	p.refuse = r
	p.mu.Unlock()
}

func TestBackupPlaceReport(t *testing.T) {
	e, admin := adminEnv(t, nil)
	fa := setupBlackbox(t, e, admin)
	var d struct {
		BackupPlace map[string]any `json:"backup_place"`
	}
	admin.json(http.MethodGet, "/api/v1/servers/blackbox", nil, 200, &d)
	bp := d.BackupPlace
	if bp["supported"] != true || bp["reason"] != "" || bp["platform"] != "unraid" || bp["root"] != "/mnt/user/whombat-backups" ||
		bp["free_bytes"] != float64(1.9e12) || bp["total_bytes"] != float64(2e12) || bp["nfs"] != true {
		t.Fatalf("backup_place = %v", bp)
	}
	if a := bp["addresses"].([]any); len(a) != 1 || a[0] != "10.30.0.40" {
		t.Errorf("addresses = %v", a)
	}
	clients := bp["clients"].([]any)
	if len(clients) != 1 {
		t.Fatalf("clients = %v", clients)
	}
	c := clients[0].(map[string]any)
	cl := c["cleanup"].(map[string]any)
	if c["client"] != fakefleet.PlaceClient || c["port"] != float64(8747) || c["running"] != true || c["image"] != fakefleet.PlaceRestImage ||
		c["used_bytes"] != float64(123456789000) || cl["set"] != true || cl["running"] != true || cl["keep_within_days"] != float64(90) ||
		cl["last_run_at"] != "2026-10-10T12:00:00Z" || cl["last_ok"] != true || cl["last_error"] != "" {
		t.Errorf("client = %v", c)
	}
	if c["location"] != "whombat-backups" {
		t.Errorf("client location = %v", c["location"])
	}
	// blackbox's REST server is from before the kit user (an ensure adds it);
	// an agent that doesn't know the kit user says nothing (null).
	if v, ok := c["kit"]; !ok || v != false {
		t.Errorf("client kit = %v (%v)", v, ok)
	}
	older := fakefleet.Blackbox()
	older.Policy = fa.policy
	older.UpdatePlace(func(bp *proto.BackupPlace) { bp.Clients[0].Kit = nil })
	fa.send(proto.MsgReport, older.Report(time.Now(), 2, "0.1.0"))
	waitFor(t, "older report", 3*time.Second, func() bool {
		st, ok := e.h.snapshotOne("blackbox")
		return ok && st.Report != nil && st.Report.BackupPlace.Clients[0].Kit == nil
	})
	var od struct {
		BackupPlace struct {
			Clients []map[string]any `json:"clients"`
		} `json:"backup_place"`
	}
	admin.json(http.MethodGet, "/api/v1/servers/blackbox", nil, 200, &od)
	if v, ok := od.BackupPlace.Clients[0]["kit"]; !ok || v != nil {
		t.Errorf("an older agent's client kit = %v (%v)", v, ok)
	}
	locs := bp["locations"].([]any)
	if len(locs) != 7 { // the dedicated share and six others (system left out)
		t.Fatalf("locations = %v", locs)
	}
	ded, media := locs[0].(map[string]any), map[string]any{}
	for _, l := range locs {
		if l.(map[string]any)["id"] == "Media" {
			media = l.(map[string]any)
		}
		if l.(map[string]any)["id"] == "system" {
			t.Error("system is a location")
		}
	}
	if ded["id"] != "whombat-backups" || ded["name"] != "whombat-backups" || ded["is_new"] != false || ded["smb"] != "" || ded["nfs"] != false ||
		ded["primary"] != "array" || ded["path"] != "/mnt/user/whombat-backups" || ded["free_bytes"] == nil {
		t.Errorf("dedicated = %v", ded)
	}
	if media["name"] != "Media" || media["smb"] != "private" || media["primary"] != "data" || media["path"] != "/mnt/user/Media/whombat" ||
		media["is_new"] != false {
		t.Errorf("Media = %v", media)
	}
	b, _ := json.Marshal(ded)
	t.Logf("location: %s", b)
	var list []map[string]any
	admin.json(http.MethodGet, "/api/v1/servers", nil, 200, &list)
	if len(list) != 1 || list[0]["backup_place"].(map[string]any)["platform"] != "unraid" {
		t.Errorf("list = %v", list)
	}
}

func TestBackupPlaceRoutes(t *testing.T) {
	e, admin := adminEnv(t, nil)
	fa := setupBlackbox(t, e, admin)
	pa := &placeAgent{}
	fa.mu.Lock()
	fa.manage = pa.manage
	fa.mu.Unlock()
	base := "/api/v1/servers/blackbox"
	pw := "correct-horse-battery-staple-42"

	var ens map[string]any
	admin.json(http.MethodPost, base+"/backup-place/ensure", map[string]any{"client": "whombat-home-4hxx", "rest_password": pw, "port": 0}, 200, &ens)
	if ens["client"] != "whombat-home-4hxx" || ens["port"] != float64(8747) || ens["path"] != "/mnt/user/whombat-backups/whombat-home-4hxx" ||
		ens["created"] != true || len(ens["addresses"].([]any)) != 1 {
		t.Errorf("ensure = %v", ens)
	}
	if m := fa.lastManage(t); m.Op != proto.OpPlaceEnsure || m.Platform != proto.PlatformHost || m.Place == nil || m.Place.RestPassword != pw ||
		m.Place.Location != "" {
		t.Errorf("agent got %+v", m)
	}
	if ens["location"] != "whombat-backups" || ens["moved"] != false || ens["kit"] != true {
		t.Errorf("ensure location = %v", ens)
	}
	// Another share moves the backups there.
	var mv map[string]any
	admin.json(http.MethodPost, base+"/backup-place/ensure", map[string]any{"client": "whombat-home-4hxx", "rest_password": pw, "location": "Media"}, 200, &mv)
	if mv["location"] != "Media" || mv["moved"] != true || mv["path"] != "/mnt/user/Media/whombat/whombat-home-4hxx" || mv["port"] != float64(8747) ||
		fa.lastManage(t).Place.Location != "Media" {
		t.Errorf("move = %v", mv)
	}
	b, _ := json.Marshal(mv)
	t.Logf("ensure: %s", b)
	var set map[string]any
	admin.json(http.MethodPut, base+"/backup-place/whombat-home-4hxx/cleanup", map[string]any{"repository_password": "repo-secret", "keep_within_days": 90}, 200, &set)
	if set["set"] != true || fa.lastManage(t).Place.RepositoryPassword != "repo-secret" || fa.lastManage(t).Place.Client != "whombat-home-4hxx" {
		t.Errorf("cleanup = %v %+v", set, fa.lastManage(t))
	}
	var nfs map[string]any
	admin.json(http.MethodPost, base+"/backup-place/nfs", map[string]any{"name": "whombat-pve-01", "clients": []string{"10.100.1.5"}}, 200, &nfs)
	if nfs["export"] != "/mnt/user/whombat-pve-01" || len(nfs["addresses"].([]any)) != 1 {
		t.Errorf("nfs = %v", nfs)
	}
	var rm map[string]any
	admin.json(http.MethodDelete, base+"/backup-place/whombat-home-4hxx", map[string]any{"delete_data": false}, 200, &rm)
	if rm["removed"] != true || fa.lastManage(t).Place.DeleteData {
		t.Errorf("remove = %v", rm)
	}
	// Deleting the backups needs a confirmation.
	if p := admin.problem(http.MethodDelete, base+"/backup-place/whombat-home-4hxx", map[string]any{"delete_data": true}, 400); p.Code != "confirm_required" {
		t.Errorf("unconfirmed delete: %+v", p)
	}
	admin.json(http.MethodDelete, base+"/backup-place/whombat-home-4hxx", map[string]any{"delete_data": true, "confirm": true}, 200, nil)
	if !fa.lastManage(t).Place.DeleteData {
		t.Error("delete_data didn't reach the agent")
	}

	// The audit log has the calls, never a password.
	n := 0
	for _, ev := range []string{"manage.requested", "manage.finished"} {
		for _, rec := range e.audit(ev) {
			b, _ := json.Marshal(rec)
			if strings.Contains(string(b), pw) || strings.Contains(string(b), "repo-secret") {
				t.Errorf("a password in the audit log: %s", b)
			}
			if strings.HasPrefix(rec.Details["op"], "backup_place.") {
				n++
			}
		}
	}
	if n != 13 { // six calls requested and finished, the unconfirmed delete refused

		t.Errorf("%d audit records", n)
	}

	// Checked before the agent is asked.
	before := len(fa.manages)
	for _, c := range []struct {
		method, path string
		body         map[string]any
		status       int
		code, field  string
	}{
		{"POST", "/backup-place/ensure", map[string]any{"client": "Home", "rest_password": pw}, 422, "invalid", "client"},
		{"POST", "/backup-place/ensure", map[string]any{"client": proto.PlaceKitUser, "rest_password": pw}, 422, "invalid", "client"},
		{"POST", "/backup-place/ensure", map[string]any{"client": "whombat-home", "rest_password": "short"}, 422, "invalid", "rest_password"},
		{"POST", "/backup-place/ensure", map[string]any{"client": "whombat-home", "rest_password": pw, "port": 22}, 422, "invalid", "port"},
		{"POST", "/backup-place/ensure", map[string]any{"client": "whombat-home", "rest_password": pw, "bogus": 1}, 400, "bad_request", ""},
		{"POST", "/backup-place/ensure", map[string]any{"client": "whombat-home", "rest_password": pw, "location": "../etc"}, 422, "invalid", "location"},
		{"POST", "/backup-place/ensure", map[string]any{"client": "whombat-home", "rest_password": pw, "location": "system"}, 422, "invalid", "location"},
		{"POST", "/backup-place/ensure", map[string]any{"client": "whombat-home", "rest_password": pw, "location": "Nope"}, 422, "invalid", "location"},
		{"PUT", "/backup-place/whombat-home/cleanup", map[string]any{"repository_password": ""}, 422, "invalid", "repository_password"},
		{"PUT", "/backup-place/whombat-home/cleanup", map[string]any{"repository_password": "x", "keep_within_days": 1}, 422, "invalid", "keep_within_days"},
		{"POST", "/backup-place/nfs", map[string]any{"name": "media", "clients": []string{"10.100.1.5"}}, 422, "invalid", "name"},
		{"POST", "/backup-place/nfs", map[string]any{"name": "whombat-pve-01", "clients": []string{"pve"}}, 422, "invalid", "clients"},
		{"POST", "/proxmox/storages", map[string]any{"storage": "blackbox-backup", "type": "nfs", "server": "10.30.0.40",
			"export": "/mnt/user/whombat-pve-01", "content": []string{"backup"}}, 409, "unsupported", ""},
	} {
		p := admin.problem(c.method, base+c.path, c.body, c.status)
		if p.Code != c.code || (c.field != "" && p.FieldErrors[c.field] == "") {
			t.Errorf("%s %s: %+v", c.method, c.path, p)
		}
	}
	if len(fa.manages) != before {
		t.Errorf("reached the agent: %+v", fa.manages[before:])
	}

	// The agent's refusals.
	for _, c := range []struct {
		resp         proto.ManageResponse
		status       int
		code, reason string
	}{
		{proto.ManageResponse{Code: "unsupported", Message: "Unraid’s array is stopped: start it first.", Place: &proto.PlaceResult{Reason: proto.PlaceArrayStopped}}, 409, "unsupported", "array_stopped"},
		{proto.ManageResponse{Code: "unsupported", Message: "unknown operation"}, 409, "unsupported", "agent_too_old"},
		{proto.ManageResponse{Code: proto.CodeInvalidValue, Message: "Port 8747 is in use.", FieldErrors: map[string]string{"port": "Port 8747 is in use."}}, 422, "invalid", ""},
		{proto.ManageResponse{Code: "platform_error", Message: "Docker couldn’t download restic/rest-server: timeout"}, 502, "agent_error", ""},
		{proto.ManageResponse{Code: "remote_control_disabled", Message: "off"}, 403, "remote_control_disabled", ""},
	} {
		pa.set(&c.resp)
		code, b, _ := admin.req(http.MethodPost, base+"/backup-place/ensure", map[string]any{"client": "whombat-home", "rest_password": pw}, nil)
		var p map[string]any
		json.Unmarshal(b, &p)
		if code != c.status || p["code"] != c.code || (c.reason != "" && p["reason"] != c.reason) {
			t.Errorf("%+v: %d %s", c.resp, code, b)
		}
	}
	pa.set(nil)

	// Manage off in the hub.
	admin.json(http.MethodPatch, base, map[string]any{"remote_control": map[string]bool{"manage": false}}, 200, nil)
	if p := admin.problem(http.MethodPost, base+"/backup-place/ensure", map[string]any{"client": "whombat-home", "rest_password": pw}, 403); p.Code != "manage_disabled" {
		t.Errorf("manage off: %+v", p)
	}
}

func TestBackupPlaceSelf(t *testing.T) {
	e, admin := adminEnv(t, nil)
	fa := setupBlackbox(t, e, admin)
	pa := &placeAgent{}
	fa.mu.Lock()
	fa.manage = pa.manage
	fa.mu.Unlock()
	// blackbox's own network card is this Whombat's.
	set := map[string]bool{"02:42:0a:1e:00:28": true}
	e.h.selfMACs.Store(&set)
	h := fakefleet.Blackbox()
	h.Policy = fa.policy
	r := h.Report(time.Now(), 2, "0.1.0")
	r.Net = append(r.Net, proto.NetIface{Name: "br0", Kind: "ethernet", Up: true, MAC: "02:42:0A:1E:00:28"})
	fa.send(proto.MsgReport, r)
	waitFor(t, "report", 3*time.Second, func() bool {
		st, _ := e.h.snapshotOne("blackbox")
		return st.Report != nil && st.Report.Seq == 2
	})
	var d struct {
		BackupPlace map[string]any `json:"backup_place"`
	}
	admin.json(http.MethodGet, "/api/v1/servers/blackbox", nil, 200, &d)
	if d.BackupPlace["supported"] != false || d.BackupPlace["reason"] != "self" {
		t.Errorf("backup_place = %v", d.BackupPlace)
	}
	base := "/api/v1/servers/blackbox"
	n := len(fa.manages)
	if p := admin.problem(http.MethodPost, base+"/backup-place/ensure", map[string]any{"client": "whombat-home", "rest_password": strings.Repeat("p", 30)}, 409); p.Code != "self" {
		t.Errorf("ensure on self: %+v", p)
	}
	if p := admin.problem(http.MethodPost, base+"/backup-place/nfs", map[string]any{"name": "whombat-pve-01", "clients": []string{"10.100.1.5"}}, 409); p.Code != "self" {
		t.Errorf("nfs on self: %+v", p)
	}
	if len(fa.manages) != n {
		t.Error("reached the agent")
	}
	// Taking a place away is allowed.
	admin.json(http.MethodDelete, base+"/backup-place/whombat-home", nil, 200, nil)
}

func TestProxmoxStorageRoute(t *testing.T) {
	e, admin := adminEnv(t, nil)
	fa := setupManageHost(t, e, admin) // shale, Proxmox VE
	body := map[string]any{"storage": "blackbox-backup", "type": "nfs", "server": "10.30.0.40", "export": "/mnt/user/whombat-pve-01", "content": []string{"backup"}}
	var res map[string]any
	admin.json(http.MethodPost, "/api/v1/servers/shale/proxmox/storages", body, 200, &res)
	m := fa.lastManage(t)
	if res["storage"] != "blackbox-backup" || m.Op != proto.OpStorageAdd || m.Platform != proto.PlatformPVE || m.PVEStorage == nil ||
		m.PVEStorage.Export != "/mnt/user/whombat-pve-01" || m.PVEStorage.Content[0] != "backup" {
		t.Errorf("storage = %v %+v", res, m)
	}
	if p := admin.problem(http.MethodPost, "/api/v1/servers/shale/backup-place/nfs", map[string]any{"name": "whombat-x", "clients": []string{"10.0.0.1"}}, 409); p.Code != "unsupported" {
		t.Errorf("nfs on Proxmox VE: %+v", p)
	}
	for field, v := range map[string]any{"type": "cifs", "server": "nas.lan", "export": "relative", "content": []string{"images"}, "storage": "Bad"} {
		b := map[string]any{}
		for k, x := range body {
			b[k] = x
		}
		b[field] = v
		if p := admin.problem(http.MethodPost, "/api/v1/servers/shale/proxmox/storages", b, 422); p.FieldErrors[field] == "" {
			t.Errorf("%s: %+v", field, p)
		}
	}
}

func TestPlaceLocationCheck(t *testing.T) {
	rep := fakefleet.Blackbox().Report(time.Now(), 1, "0.1.0")
	for _, c := range []struct {
		client, loc string
		moving      bool
	}{
		{fakefleet.PlaceClient, "Media", true},
		{fakefleet.PlaceClient, proto.PlaceShareName, false},
		{"whombat-new-a1b2", "Media", false},
	} {
		if moving, e := placeLocationCheck(rep, c.client, c.loc); e != nil || moving != c.moving {
			t.Errorf("%+v: %v %v", c, moving, e)
		}
	}
	if _, e := placeLocationCheck(rep, fakefleet.PlaceClient, "Nope"); e == nil || e.Fields["location"] == "" {
		t.Errorf("unknown location: %+v", e)
	}
	rep.BackupPlace.Locations = nil // an agent from before locations
	if _, e := placeLocationCheck(rep, fakefleet.PlaceClient, "Media"); e == nil || e.Extra["reason"] != "agent_too_old" {
		t.Errorf("old agent: %+v", e)
	}
}

// TestBackupPlaceMoveBusy: while a move runs, another change on that
// server's backup place is refused.
func TestBackupPlaceMoveBusy(t *testing.T) {
	e, admin := adminEnv(t, nil)
	fa := setupBlackbox(t, e, admin)
	pa := &placeAgent{hold: make(chan struct{})}
	fa.mu.Lock()
	fa.manage = pa.manage
	fa.mu.Unlock()
	base := "/api/v1/servers/blackbox"
	pw := "correct-horse-battery-staple-42"
	done := make(chan map[string]any, 1)
	go func() {
		var mv map[string]any
		admin.json(http.MethodPost, base+"/backup-place/ensure", map[string]any{"client": fakefleet.PlaceClient, "rest_password": pw, "location": "Media"}, 200, &mv)
		done <- mv
	}()
	waitFor(t, "the move to start", 3*time.Second, func() bool {
		fa.mu.Lock()
		defer fa.mu.Unlock()
		return len(fa.manages) > 0
	})
	if p := admin.problem(http.MethodPut, base+"/backup-place/"+fakefleet.PlaceClient+"/cleanup", map[string]any{"repository_password": "x"}, 409); p.Code != "action_in_progress" {
		t.Errorf("during the move: %+v", p)
	}
	close(pa.hold)
	if mv := <-done; mv["moved"] != true {
		t.Errorf("move = %v", mv)
	}
}
