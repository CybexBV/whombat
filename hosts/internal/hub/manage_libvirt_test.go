package hub

import (
	"net/http"
	"strings"
	"testing"
	"time"

	"rackoon/internal/hub/fakefleet"
	"rackoon/internal/hub/store"
	"rackoon/internal/proto"
)

const libvirtTestTask = "libvirt:0123456789abcdef"

// libvirtManage answers like an agent with libvirt.
func libvirtManage(req proto.ManageRequest) proto.ManageResponse {
	switch req.Op {
	case proto.OpConfigGet:
		return proto.ManageResponse{OK: true, Config: &proto.GuestConfig{Platform: "libvirt", Kind: "vm", Digest: strings.Repeat("a", 64),
			Values: map[string]string{"vcpus": "2", "cdrom0": "source=empty,bus=sata,target=sda"}, Restricted: []string{"machine"}}}
	case proto.OpConfigSet:
		return proto.ManageResponse{OK: true, Changes: []proto.ConfigChange{{Key: "cdrom0", Old: "source=empty", New: "source=default/x.iso"}}}
	case proto.OpChoices:
		return proto.ManageResponse{OK: true, Choices: &proto.Choices{Platform: "libvirt", Networks: []string{"default"},
			OSVariants: []proto.OSVariant{{ID: "win11", Label: "Windows 11", Firmware: "uefi", TPM: true}},
			Firmware:   &proto.LibvirtFirmware{UEFI: true, SecureBoot: true, TPM: true}}}
	case proto.OpCreate, proto.OpRename:
		return proto.ManageResponse{OK: true, NewID: req.Name}
	case proto.OpClone, proto.OpBackupRestore:
		return proto.ManageResponse{OK: true, NewID: req.Name, Task: &proto.TaskRef{ID: libvirtTestTask}}
	case proto.OpBackupCreate, proto.OpContentDownload:
		return proto.ManageResponse{OK: true, Task: &proto.TaskRef{ID: libvirtTestTask}}
	case proto.OpBackupList:
		return proto.ManageResponse{OK: true, Backups: []proto.BackupVolume{{Volume: "20261016-020000", Storage: "libvirt", GuestID: "web",
			Kind: "vm", SizeBytes: 3 << 30, Created: time.Date(2026, 10, 16, 2, 0, 0, 0, time.UTC), Format: "qcow2"}}}
	case proto.OpContentList:
		return proto.ManageResponse{OK: true, Content: []proto.StorageVolume{{Volume: "default/web.qcow2", Storage: "default", Content: "images",
			Name: "web.qcow2", UsedBy: []string{"web"}}}}
	case proto.OpNetworkLeases:
		return proto.ManageResponse{OK: true, Leases: []proto.IncusLease{{Hostname: "web", Address: "192.168.122.10", HWAddr: "52:54:00:6b:1e:01",
			Type: "dynamic", GuestID: "web"}, {Address: "192.168.122.99", Type: "dynamic"}}}
	case proto.OpLogGet:
		return proto.ManageResponse{OK: true, Log: &proto.GuestLog{File: "/var/log/libvirt/qemu/web.log", Lines: []string{"a", "b"}}}
	case proto.OpTaskStatus:
		end := time.Now().UTC()
		return proto.ManageResponse{OK: true, TaskStatus: &proto.TaskStatus{ID: req.Task, Type: "vzdump", Status: "ok", Message: "OK",
			Started: end.Add(-time.Minute), Ended: &end}}
	}
	return proto.ManageResponse{OK: true}
}

// setupKVMLab enrolls the fake fleet's libvirt host with manage on.
func setupKVMLab(t *testing.T, e *env, admin *client) *fakeAgent {
	t.Helper()
	fa := e.enroll(admin, "kvm-lab", "Lab")
	fa.policy = proto.Policy{Console: true, Power: true, Manage: true}
	fa.manage = libvirtManage
	if _, err := fa.dial(proto.Hello{}); err != nil {
		t.Fatal(err)
	}
	h := fakefleet.KVMLab()
	h.Policy = fa.policy
	fa.send(proto.MsgReport, h.Report(time.Now(), 1, "0.1.0"))
	waitFor(t, "report", 3*time.Second, func() bool {
		st, ok := e.h.snapshotOne("kvm-lab")
		return ok && st.Report != nil
	})
	admin.json(http.MethodPatch, "/api/v1/servers/kvm-lab", map[string]any{"remote_control": map[string]bool{"manage": true}}, 200, nil)
	return fa
}

func TestLibvirtDetailView(t *testing.T) {
	e, admin := adminEnv(t, nil)
	setupKVMLab(t, e, admin)
	var d struct {
		Server struct {
			DetailView string `json:"detail_view"`
		} `json:"server"`
		Libvirt struct {
			Version    string           `json:"version"`
			QEMU       *string          `json:"qemu"`
			Pools      []map[string]any `json:"pools"`
			Networks   []map[string]any `json:"networks"`
			Folders    *map[string]any  `json:"folders"`
			Firmware   map[string]bool  `json:"firmware"`
			BackupsDir *string          `json:"backups_dir"`
		} `json:"libvirt"`
		Workloads map[string]struct {
			Guests []map[string]any `json:"guests"`
		} `json:"workloads"`
		Hints []struct{ Kind, Entity, Title string } `json:"hints"`
	}
	admin.json(http.MethodGet, "/api/v1/servers/kvm-lab", nil, 200, &d)
	lv := d.Libvirt
	if d.Server.DetailView != "libvirt" || lv.Version != "11.6.0" || lv.QEMU == nil || *lv.QEMU != "10.0.13" || len(lv.Pools) != 1 ||
		lv.Pools[0]["used_bytes"] != float64(610e9) || lv.Networks[0]["ipv4"] != "192.168.122.1/24" || lv.Folders != nil ||
		!lv.Firmware["uefi"] || !lv.Firmware["secure_boot"] || !lv.Firmware["tpm"] || lv.BackupsDir == nil {
		t.Fatalf("libvirt: %+v", lv)
	}
	var web map[string]any
	for _, g := range d.Workloads["libvirt"].Guests {
		if g["id"] == "libvirt:web" {
			web = g
		}
	}
	if web == nil || web["last_backup"] == nil {
		t.Errorf("web: %v", web)
	}
	found := false
	for _, h := range d.Hints {
		if h.Kind == "libvirt.no_backup" && h.Entity == "libvirt:win11" {
			found = true
		}
	}
	if !found {
		t.Errorf("hints: %+v", d.Hints)
	}
}

func TestLibvirtManageRoutes(t *testing.T) {
	e, admin := adminEnv(t, nil)
	fa := setupKVMLab(t, e, admin)
	base := "/api/v1/servers/kvm-lab"
	admin.json(http.MethodPost, "/api/v1/auth/reauth", map[string]string{"password": adminPW}, 204, nil)

	// A guest's configuration: platform and VM from the route.
	var cfg map[string]any
	admin.json(http.MethodGet, base+"/guests/libvirt:web/config", nil, 200, &cfg)
	if r := fa.lastManage(t); r.Op != proto.OpConfigGet || r.Platform != "libvirt" || r.GuestID != "web" || cfg["platform"] != "libvirt" {
		t.Fatalf("config.get: %+v %v", r, cfg)
	}
	var out map[string]any
	admin.json(http.MethodPut, base+"/guests/libvirt:web/config", map[string]any{"digest": strings.Repeat("a", 64),
		"set": map[string]string{"cdrom0": "source=default/x.iso"}}, 200, &out)
	if out["changes"] == nil {
		t.Errorf("config.set: %v", out)
	}
	admin.json(http.MethodPost, base+"/guests/libvirt:web/disks/disk0/resize", map[string]any{"size": "+8G"}, 200, nil)
	if p := admin.problem(http.MethodPost, base+"/guests/libvirt:web/disks/disk0/resize", map[string]any{"size": "lots"}, 400); p.Code != "invalid_value" {
		t.Errorf("bad size: %+v", p)
	}

	// Choices and create with the OS presets.
	var ch map[string]any
	admin.json(http.MethodGet, base+"/manage/choices?platform=libvirt", nil, 200, &ch)
	if ch["networks"] == nil || ch["os_variants"] == nil || ch["firmware"].(map[string]any)["secure_boot"] != true {
		t.Errorf("choices: %v", ch)
	}
	create := map[string]any{"platform": "libvirt", "kind": "vm", "name": "win11_b", "os_variant": "win11", "iso": "default/Win11.iso",
		"disk_gb": 64, "storage": "default", "network": "default", "start": true, "set": map[string]string{"memory_mb": "8192"}}
	admin.json(http.MethodPost, base+"/guests", create, 200, &out)
	r := fa.lastManage(t)
	if out["new_id"] != "libvirt:win11_b" || r.OSVariant != "win11" || r.ISO != "default/Win11.iso" || r.DiskGB != 64 || r.Network != "default" ||
		r.Storage != "default" || !r.Start || r.Set["memory_mb"] != "8192" {
		t.Fatalf("create: %v %+v", out, r)
	}
	// unRAID's folders are storages too; names follow libvirt's rule.
	admin.json(http.MethodPost, base+"/guests", map[string]any{"platform": "libvirt", "name": "vm2", "storage": "folder:domains", "bridge": "br0"}, 200, nil)
	for field, body := range map[string]map[string]any{
		"name":    {"platform": "libvirt", "name": "a b"},
		"network": {"platform": "libvirt", "name": "x", "network": "default", "bridge": "br0"},
		"new_id":  {"platform": "libvirt", "name": "x", "new_id": 100},
		"storage": {"platform": "libvirt", "name": "x", "storage": "folder:isos"},
	} {
		if p := admin.problem(http.MethodPost, base+"/guests", body, 400); p.Code != "invalid_value" || p.FieldErrors[field] == "" {
			t.Errorf("%s: %+v", field, p)
		}
	}

	// Clone and restore are tasks; rename answers the new id.
	admin.json(http.MethodPost, base+"/guests/libvirt:lab/clone", map[string]any{"name": "lab2"}, 202, &out)
	if out["new_id"] != "libvirt:lab2" || out["task"].(map[string]any)["id"] != libvirtTestTask {
		t.Errorf("clone: %v", out)
	}
	admin.json(http.MethodPost, base+"/guests/libvirt:lab/rename", map[string]any{"name": "lab-old"}, 200, &out)
	if out["new_id"] != "libvirt:lab-old" {
		t.Errorf("rename: %v", out)
	}

	// Delete: the disks and NVRAM go too unless purge=0.
	admin.json(http.MethodDelete, base+"/guests/libvirt:lab?confirm_name=lab", nil, 200, nil)
	if r := fa.lastManage(t); r.Op != proto.OpDelete || !r.Purge {
		t.Errorf("delete: %+v", r)
	}
	admin.json(http.MethodDelete, base+"/guests/libvirt:lab?confirm_name=lab&purge=0", nil, 200, nil)
	if r := fa.lastManage(t); r.Purge {
		t.Errorf("delete purge=0: %+v", r)
	}
	if p := admin.problem(http.MethodDelete, base+"/guests/libvirt:lab", nil, 400); p.Code != "confirm_required" {
		t.Errorf("delete without the name: %+v", p)
	}

	// Backups: every VM's, restore as new, delete; the VM as a hub id.
	var bl struct {
		Items []map[string]any `json:"items"`
	}
	admin.json(http.MethodGet, base+"/libvirt/backups", nil, 200, &bl)
	if len(bl.Items) != 1 || bl.Items[0]["guest"] != "libvirt:web" || bl.Items[0]["volume"] != "20261016-020000" || bl.Items[0]["storage"] != "libvirt" {
		t.Fatalf("backups: %+v", bl.Items)
	}
	admin.json(http.MethodGet, base+"/guests/libvirt:web/backups", nil, 200, &bl)
	admin.json(http.MethodPost, base+"/guests/libvirt:web/backups", map[string]any{"compress": "zstd", "notes": "before"}, 202, nil)
	admin.json(http.MethodPost, base+"/backups/restore", map[string]any{"platform": "libvirt", "guest": "libvirt:web", "volume": "20261016-020000",
		"name": "web-old", "start": true}, 202, &out)
	if r := fa.lastManage(t); r.GuestID != "web" || r.Name != "web-old" || out["new_id"] != "libvirt:web-old" {
		t.Errorf("restore: %+v %v", r, out)
	}
	admin.json(http.MethodDelete, base+"/backups?platform=libvirt&guest=libvirt:web&volume=20261016-020000", nil, 200, nil)
	if r := fa.lastManage(t); r.Op != proto.OpBackupDelete || r.GuestID != "web" || r.Volume != "20261016-020000" {
		t.Errorf("backup.delete: %+v", r)
	}
	if p := admin.problem(http.MethodDelete, base+"/backups?platform=libvirt&guest=web&volume=../x", nil, 400); p.FieldErrors["volume"] == "" {
		t.Errorf("bad backup: %+v", p)
	}

	// Volumes, content, leases, the log.
	admin.json(http.MethodPost, base+"/libvirt/pools/default/volumes", map[string]any{"name": "data.qcow2", "size": "10G"}, 200, nil)
	if r := fa.lastManage(t); r.Op != proto.OpVolumeCreate || r.Pool != "default" || r.Name != "data.qcow2" || r.Platform != "libvirt" {
		t.Errorf("volume.create: %+v", r)
	}
	admin.json(http.MethodPost, base+"/libvirt/pools/default/volumes/data.qcow2/resize", map[string]any{"size": "+2G"}, 200, nil)
	if p := admin.problem(http.MethodDelete, base+"/libvirt/pools/default/volumes/data.qcow2", nil, 400); p.Code != "confirm_required" {
		t.Errorf("volume.delete without confirm: %+v", p)
	}
	admin.json(http.MethodDelete, base+"/libvirt/pools/default/volumes/data.qcow2?confirm=1", nil, 200, nil)
	var items struct {
		Items []map[string]any `json:"items"`
	}
	admin.json(http.MethodGet, base+"/storage/default/content?platform=libvirt&content=images", nil, 200, &items)
	if len(items.Items) != 1 || items.Items[0]["used_by"].([]any)[0] != "libvirt:web" {
		t.Errorf("content: %+v", items.Items)
	}
	admin.json(http.MethodPost, base+"/storage/folder:isos/download", map[string]any{"platform": "libvirt", "content": "iso",
		"url": "https://cdimage.debian.org/x.iso", "filename": "debian.iso"}, 202, nil)
	admin.json(http.MethodDelete, base+"/storage/content?platform=libvirt&volume=default/debian.iso", nil, 200, nil)
	var leases struct {
		Op    string           `json:"op"`
		Items []map[string]any `json:"items"`
	}
	admin.json(http.MethodGet, base+"/libvirt/networks/default/leases", nil, 200, &leases)
	if leases.Op != "network.leases" || len(leases.Items) != 2 || leases.Items[0]["guest_id"] != "libvirt:web" || leases.Items[1]["guest_id"] != nil {
		t.Errorf("leases: %+v", leases)
	}
	var lg struct {
		Op    string   `json:"op"`
		File  string   `json:"file"`
		Lines []string `json:"lines"`
	}
	admin.json(http.MethodGet, base+"/guests/libvirt:web/log?lines=10", nil, 200, &lg)
	if r := fa.lastManage(t); r.Lines != 10 || lg.Op != "log.get" || len(lg.Lines) != 2 {
		t.Errorf("log: %+v %+v", r, lg)
	}
	// A libvirt task without ?platform=.
	admin.json(http.MethodGet, base+"/tasks/"+libvirtTestTask+"?log_start=0", nil, 200, nil)
	if r := fa.lastManage(t); r.Platform != "libvirt" || r.Task != libvirtTestTask {
		t.Errorf("task.status: %+v", r)
	}
	// Host routes without a platform on a libvirt server are libvirt's.
	admin.json(http.MethodGet, base+"/manage/choices", nil, 200, nil)
	if r := fa.lastManage(t); r.Platform != "libvirt" {
		t.Errorf("default platform: %+v", r)
	}

	// Operators change, but do not create or delete.
	e.addUser("olive", store.RoleOperator, "operator password 1")
	op := e.client()
	op.login("olive", "operator password 1")
	op.json(http.MethodPut, base+"/guests/libvirt:web/config", map[string]any{"set": map[string]string{"vcpus": "2"}}, 200, nil)
	if p := op.problem(http.MethodPost, base+"/guests", create, 403); p.Code != "insufficient_role" {
		t.Errorf("operator create: %+v", p)
	}
	if recs := e.audit("manage.finished"); len(recs) == 0 || recs[len(recs)-1].Platform != "libvirt" {
		t.Errorf("audit: %s", fmtRecs(recs))
	}
}

// TestLibvirtSelfGuest: the VM the Whombat runs in refuses changes but
// backups and clones (IU-02).
func TestLibvirtSelfGuest(t *testing.T) {
	e, admin := adminEnv(t, func(c *Config) { c.SelfMACs = []string{"52:54:00:6b:1e:01"} })
	setupKVMLab(t, e, admin)
	base := "/api/v1/servers/kvm-lab"
	admin.json(http.MethodPost, "/api/v1/auth/reauth", map[string]string{"password": adminPW}, 204, nil)
	if p := admin.problem(http.MethodPut, base+"/guests/libvirt:web/config", map[string]any{"set": map[string]string{"vcpus": "4"}}, 409); p.Code != "self_guest" {
		t.Errorf("config.set on the self guest: %+v", p)
	}
	if p := admin.problem(http.MethodDelete, base+"/guests/libvirt:web?confirm_name=web", nil, 409); p.Code != "self_guest" {
		t.Errorf("delete the self guest: %+v", p)
	}
	admin.json(http.MethodGet, base+"/guests/libvirt:web/config", nil, 200, nil)
	admin.json(http.MethodPost, base+"/guests/libvirt:web/backups", map[string]any{}, 202, nil)
	admin.json(http.MethodPut, base+"/guests/libvirt:win11/config", map[string]any{"set": map[string]string{"vcpus": "4"}}, 200, nil)
}
