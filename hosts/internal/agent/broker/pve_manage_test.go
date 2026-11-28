package broker

import (
	"context"
	"net/url"
	"reflect"
	"slices"
	"strings"
	"testing"

	"rackoon/internal/proto"
)

func manageOp(t *testing.T, m *pveManage, g *proto.Guest, req proto.ManageRequest) proto.ManageResponse {
	t.Helper()
	req.Platform = proto.PlatformPVE
	if g != nil {
		req.GuestID = g.ID
	}
	return m.manage(context.Background(), g, req)
}

func TestPVEConfigGet(t *testing.T) {
	f := newFakePVE(t)
	m := newTestManage(t, f)
	r := manageOp(t, m, testVM, proto.ManageRequest{Op: proto.OpConfigGet})
	if !r.OK || r.Config == nil {
		t.Fatalf("config.get: %+v", r)
	}
	if got := f.auth[0]; got != "PVEAPIToken=whombat-manage@pve!agent-pve1=s3cret" {
		t.Fatalf("authorization %q", got)
	}
	c := r.Config
	if c.Platform != "pve" || c.Kind != "vm" || !c.Running || c.Digest != "0123456789abcdef0123456789abcdef01234567" {
		t.Fatalf("header %+v", c)
	}
	if c.Values["memory"] != "4096" || c.Values["onboot"] != "1" || c.Values["cipassword"] != maskedSecret {
		t.Fatalf("values %v", c.Values)
	}
	if _, ok := c.Values["digest"]; ok {
		t.Fatal("digest is not a value")
	}
	if !reflect.DeepEqual(c.Pending, map[string]string{"memory": "8192", "scsi1": "local-zfs:vm-100-disk-3,size=10G"}) {
		t.Fatalf("pending %v", c.Pending)
	}
	if !reflect.DeepEqual(c.PendingDelete, []string{"tags"}) {
		t.Fatalf("pending delete %v", c.PendingDelete)
	}
	if want := []string{"args", "hostpci0", "serial1", "smbios1"}; !reflect.DeepEqual(c.Restricted, want) {
		t.Fatalf("restricted %v, want %v", c.Restricted, want)
	}
	want := []proto.GuestDisk{
		{Key: "ide2", Storage: "local", Volume: "local:iso/debian-13.0.0-amd64-netinst.iso", SizeBytes: 737280 << 10, Media: "cdrom", Boot: true},
		{Key: "scsi0", Storage: "local-zfs", Volume: "local-zfs:vm-100-disk-0", SizeBytes: 32 << 30, Media: "disk", Boot: true},
		{Key: "scsi1", Storage: "local-zfs", Volume: "local-zfs:vm-100-disk-3", SizeBytes: 10 << 30, Media: "disk"},
		{Key: "efidisk0", Storage: "local-zfs", Volume: "local-zfs:vm-100-disk-2", SizeBytes: 1 << 20, Media: "disk"},
		{Key: "unused0", Storage: "local-zfs", Volume: "local-zfs:vm-100-disk-1", Media: "disk", Unused: true},
	}
	if !reflect.DeepEqual(c.Disks, want) {
		t.Fatalf("disks\n got %+v\nwant %+v", c.Disks, want)
	}
	if c.HA != nil || c.Replication != nil {
		t.Fatal("HA and replication on a standalone node")
	}
	if ch := f.changes(); len(ch) != 0 {
		t.Fatalf("config.get changed something: %v", ch)
	}
}

func TestPVEConfigGetContainer(t *testing.T) {
	f := newFakePVE(t)
	m := newTestManage(t, f)
	r := manageOp(t, m, testCT, proto.ManageRequest{Op: proto.OpConfigGet})
	if !r.OK {
		t.Fatalf("config.get: %+v", r)
	}
	c := r.Config
	if c.Lock != "backup" || c.Running || c.Values["lock"] != "" {
		t.Fatalf("lock / running: %+v", c)
	}
	// rootfs is changed through disk.resize / disk.move, not shown locked.
	if want := []string{"arch", "lxc.cgroup2.devices.allow", "mp1", "ostype", "unprivileged"}; !reflect.DeepEqual(c.Restricted, want) {
		t.Fatalf("restricted %v, want %v", c.Restricted, want)
	}
	want := []proto.GuestDisk{
		{Key: "rootfs", Storage: "local-zfs", Volume: "local-zfs:subvol-200-disk-0", SizeBytes: 8 << 30, Media: "disk", Path: "/"},
		{Key: "mp0", Storage: "local-zfs", Volume: "local-zfs:subvol-200-disk-1", SizeBytes: 20 << 30, Media: "disk", Path: "/data"},
		{Key: "mp1", Volume: "/mnt/backup", Media: "disk", Path: "/backup"},
	}
	if !reflect.DeepEqual(c.Disks, want) {
		t.Fatalf("disks\n got %+v\nwant %+v", c.Disks, want)
	}
}

func TestPVEConfigGetCluster(t *testing.T) {
	f := newFakePVE(t)
	f.data("GET /cluster/status", []map[string]any{
		{"type": "cluster", "name": "lab", "quorate": 1, "nodes": 2},
		{"type": "node", "name": "pve1", "local": 1, "online": 1},
		{"type": "node", "name": "pve2", "local": 0, "online": 1},
	})
	f.data("GET /cluster/ha/resources/vm:100", map[string]any{"sid": "vm:100", "state": "started", "max_restart": 2, "max_relocate": 1, "comment": "web", "digest": "x"})
	f.data("GET /cluster/ha/status/current", []map[string]any{
		{"id": "quorum", "type": "quorum", "status": "OK"},
		{"id": "service:vm:100", "type": "service", "sid": "vm:100", "state": "started", "node": "pve1", "status": "started"},
	})
	f.data("GET /cluster/replication", []map[string]any{
		{"id": "100-0", "guest": 100, "target": "pve2", "schedule": "*/15", "rate": 50, "type": "local", "jobnum": 0},
		{"id": "1000-0", "guest": 1000, "target": "pve2", "type": "local", "jobnum": 0},
	})
	f.data("GET /nodes/pve1/replication", []map[string]any{{"id": "100-0", "guest": 100, "last_sync": 1760600000, "error": "", "fail_count": 0}})
	m := newTestManage(t, f)
	r := manageOp(t, m, testVM, proto.ManageRequest{Op: proto.OpConfigGet})
	if !r.OK {
		t.Fatalf("config.get: %+v", r)
	}
	ha := r.Config.HA
	if ha == nil || ha.State != "started" || ha.Status != "started" || *ha.MaxRestart != 2 || *ha.MaxRelocate != 1 || ha.Comment != "web" {
		t.Fatalf("HA %+v", ha)
	}
	repl := r.Config.Replication
	if len(repl) != 1 || repl[0].ID != "100-0" || repl[0].Target != "pve2" || repl[0].Rate != "50" || repl[0].LastSync == nil || repl[0].LastSync.Unix() != 1760600000 {
		t.Fatalf("replication %+v", repl)
	}
	if q := f.requested("GET", "/nodes/pve1/replication"); len(q) != 1 || q[0].Form.Get("guest") != "100" {
		t.Fatalf("replication state request %v", q)
	}
}

func TestPVEConfigSetVM(t *testing.T) {
	f := newFakePVE(t)
	posted := false
	f.on("POST /nodes/pve1/qemu/100/config", func(url.Values) fakeResp { posted = true; return okResp(testUPID) })
	before := f.routes["GET /nodes/pve1/qemu/100/pending"]
	f.on("GET /nodes/pve1/qemu/100/pending", func(q url.Values) fakeResp {
		if !posted {
			return before(q)
		}
		return okResp([]map[string]any{
			{"key": "cores", "value": 2, "pending": "4"},
			{"key": "memory", "value": 4096},
			{"key": "name", "value": "web2"},
		})
	})
	m := newTestManage(t, f)
	r := manageOp(t, m, testVM, proto.ManageRequest{Op: proto.OpConfigSet, Digest: "0123abcd",
		Set:    map[string]string{"cores": "4", "name": "web2", "sockets": "1", "cipassword": maskedSecret},
		Delete: []string{"unused0", "description"},
		Revert: []string{"memory"},
	})
	if !r.OK || r.Task == nil || r.Task.ID != testUPID {
		t.Fatalf("config.set: %+v", r)
	}
	ch := f.changes()
	if len(ch) != 1 || ch[0].Method != "POST" || ch[0].Path != "/nodes/pve1/qemu/100/config" {
		t.Fatalf("requests %v", ch)
	}
	want := url.Values{"cores": {"4"}, "name": {"web2"}, "delete": {"unused0"}, "revert": {"memory"},
		"digest": {"0123abcd"}, "background_delay": {"5"}}
	if !reflect.DeepEqual(ch[0].Form, want) {
		t.Fatalf("form %v, want %v", ch[0].Form, want)
	}
	wantCh := []proto.ConfigChange{
		{Key: "cores", Old: "2", New: "4", Pending: true},
		{Key: "name", Old: "web", New: "web2"},
		{Key: "unused0", Old: "local-zfs:vm-100-disk-1"},
		{Key: "memory", Old: "8192", New: "4096"},
	}
	if !reflect.DeepEqual(r.Changes, wantCh) {
		t.Fatalf("changes\n got %+v\nwant %+v", r.Changes, wantCh)
	}
}

func TestPVEConfigSetContainer(t *testing.T) {
	f := newFakePVE(t)
	f.on("PUT /nodes/pve1/lxc/200/config", func(url.Values) fakeResp { return okResp(nil) })
	m := newTestManage(t, f)
	r := manageOp(t, m, testCT, proto.ManageRequest{Op: proto.OpConfigSet,
		Set: map[string]string{"memory": "1024", "features": "nesting=1,keyctl=1", "mp2": "tank:16,mp=/srv,backup=1",
			"net1": "name=eth1,bridge=vmbr1,ip=10.0.0.2/24,gw=10.0.0.1,type=veth"}})
	if !r.OK || r.Task != nil {
		t.Fatalf("config.set: %+v", r)
	}
	ch := f.changes()
	if len(ch) != 1 || ch[0].Method != "PUT" || ch[0].Form.Get("background_delay") != "" || ch[0].Form.Get("mp2") != "tank:16,mp=/srv,backup=1" {
		t.Fatalf("requests %v", ch)
	}
	if len(r.Changes) != 4 || r.Changes[0].Key != "features" || r.Changes[0].Old != "nesting=1" {
		t.Fatalf("changes %+v", r.Changes)
	}
}

func TestPVEConfigSetNothing(t *testing.T) {
	f := newFakePVE(t)
	m := newTestManage(t, f)
	r := manageOp(t, m, testVM, proto.ManageRequest{Op: proto.OpConfigSet, Set: map[string]string{"cores": "2"}})
	if !r.OK || len(r.Changes) != 0 || len(f.changes()) != 0 {
		t.Fatalf("unchanged value sent: %+v %v", r, f.changes())
	}
	r = manageOp(t, m, testVM, proto.ManageRequest{Op: proto.OpConfigSet})
	if r.Code != CodeInvalid {
		t.Fatalf("empty config.set: %+v", r)
	}
}

func TestPVEConfigSetPasswordMasked(t *testing.T) {
	f := newFakePVE(t)
	f.on("POST /nodes/pve1/qemu/100/config", func(url.Values) fakeResp {
		return fakeResp{status: 400, reason: "Parameter verification failed.", errors: map[string]string{"cipassword": "value 'hunter2-secret' is too short"}}
	})
	m := newTestManage(t, f)
	r := manageOp(t, m, testVM, proto.ManageRequest{Op: proto.OpConfigSet, Set: map[string]string{"cipassword": "hunter2-secret"}})
	if r.Code != proto.CodeInvalidValue || r.FieldErrors["cipassword"] == "" {
		t.Fatalf("400: %+v", r)
	}
	if strings.Contains(r.Message, "hunter2") || strings.Contains(r.FieldErrors["cipassword"], "hunter2") {
		t.Fatalf("password in the answer: %+v", r)
	}
	if ch := f.changes(); len(ch) != 1 || ch[0].Form.Get("cipassword") != "hunter2-secret" {
		t.Fatalf("password not sent: %v", ch)
	}

	f.on("POST /nodes/pve1/qemu/100/config", func(url.Values) fakeResp { return okResp(nil) })
	r = manageOp(t, m, testVM, proto.ManageRequest{Op: proto.OpConfigSet, Set: map[string]string{"cipassword": "hunter2-secret"}})
	if !r.OK || len(r.Changes) != 1 || r.Changes[0].Old != maskedSecret || r.Changes[0].New != maskedSecret {
		t.Fatalf("changes %+v", r.Changes)
	}
}

// TestPVEConfigSetAllowlist feeds values the allowlist refuses or accepts
// (docs/MANAGE.md 2.4).
func TestPVEConfigSetAllowlist(t *testing.T) {
	cases := []struct {
		name  string
		g     *proto.Guest
		req   proto.ManageRequest
		code  string // "" = accepted
		field string
	}{
		{"args", testVM, proto.ManageRequest{Set: map[string]string{"args": "-device foo"}}, proto.CodeNotAllowed, "args"},
		{"hookscript", testVM, proto.ManageRequest{Set: map[string]string{"hookscript": "local:snippets/x.pl"}}, proto.CodeNotAllowed, "hookscript"},
		{"hostpci", testVM, proto.ManageRequest{Set: map[string]string{"hostpci1": "0000:02:00.0"}}, proto.CodeNotAllowed, "hostpci1"},
		{"usb", testVM, proto.ManageRequest{Set: map[string]string{"usb0": "host=10c4:ea60"}}, proto.CodeNotAllowed, "usb0"},
		{"delete restricted", testVM, proto.ManageRequest{Delete: []string{"args"}}, proto.CodeNotAllowed, "args"},
		{"host device disk", testVM, proto.ManageRequest{Set: map[string]string{"scsi2": "/dev/disk/by-id/ata-X"}}, proto.CodeNotAllowed, "scsi2"},
		{"host path via file=", testVM, proto.ManageRequest{Set: map[string]string{"scsi2": "file=/dev/sdb,iothread=1"}}, proto.CodeNotAllowed, "scsi2"},
		{"two volumes", testVM, proto.ManageRequest{Set: map[string]string{"scsi2": "local-zfs:8,file=local-zfs:vm-100-disk-9"}}, proto.CodeInvalidValue, "scsi2"},
		{"import-from", testVM, proto.ManageRequest{Set: map[string]string{"scsi2": "local-zfs:0,import-from=/var/lib/vz/x.qcow2"}}, proto.CodeNotAllowed, "scsi2"},
		{"import-from volume", testVM, proto.ManageRequest{Set: map[string]string{"scsi2": "local-zfs:0,import-from=local:import/x.qcow2"}}, proto.CodeNotAllowed, "scsi2"},
		{"foreign storage", testVM, proto.ManageRequest{Set: map[string]string{"scsi2": "elsewhere:8"}}, proto.CodeNotAllowed, "scsi2"},
		{"storage without images", testVM, proto.ManageRequest{Set: map[string]string{"scsi2": "local:8"}}, proto.CodeNotAllowed, "scsi2"},
		{"inactive storage", testVM, proto.ManageRequest{Set: map[string]string{"scsi2": "nas-iso:8"}}, proto.CodeNotAllowed, "scsi2"},
		{"zero size", testVM, proto.ManageRequest{Set: map[string]string{"scsi2": "local-zfs:0"}}, proto.CodeInvalidValue, "scsi2"},
		{"new volume with size=", testVM, proto.ManageRequest{Set: map[string]string{"scsi2": "local-zfs:8,size=8G"}}, proto.CodeInvalidValue, "scsi2"},
		{"other guest's volume", testVM, proto.ManageRequest{Set: map[string]string{"scsi2": "local-zfs:vm-101-disk-0"}}, proto.CodeNotAllowed, "scsi2"},
		{"grow via size=", testVM, proto.ManageRequest{Set: map[string]string{"scsi0": "local-zfs:vm-100-disk-0,iothread=1,size=64G"}}, proto.CodeNotAllowed, "scsi0"},
		{"shrink via size=", testVM, proto.ManageRequest{Set: map[string]string{"scsi0": "local-zfs:vm-100-disk-0,size=8G"}}, proto.CodeNotAllowed, "scsi0"},
		{"host cdrom", testVM, proto.ManageRequest{Set: map[string]string{"ide2": "cdrom,media=cdrom"}}, proto.CodeNotAllowed, "ide2"},
		{"missing iso", testVM, proto.ManageRequest{Set: map[string]string{"ide2": "local:iso/missing.iso,media=cdrom"}}, proto.CodeNotAllowed, "ide2"},
		{"iso on non-iso storage", testVM, proto.ManageRequest{Set: map[string]string{"ide2": "local-zfs:iso/x.iso,media=cdrom"}}, proto.CodeNotAllowed, "ide2"},
		{"iso path escape", testVM, proto.ManageRequest{Set: map[string]string{"ide2": "local:iso/../../etc/shadow,media=cdrom"}}, proto.CodeNotAllowed, "ide2"},
		{"efidisk other", testVM, proto.ManageRequest{Set: map[string]string{"efidisk0": "local-zfs:vm-100-disk-1,efitype=4m"}}, proto.CodeNotAllowed, "efidisk0"},
		{"unknown bridge", testVM, proto.ManageRequest{Set: map[string]string{"net1": "virtio,bridge=vmbr9"}}, proto.CodeNotAllowed, "net1"},
		{"nic model", testVM, proto.ManageRequest{Set: map[string]string{"net1": "ne2k_pci=BC:24:11:00:00:01,bridge=vmbr0"}}, proto.CodeNotAllowed, "net1"},
		{"second nic model", testVM, proto.ManageRequest{Set: map[string]string{"net1": "virtio,bridge=vmbr0,pcnet=BC:24:11:00:00:01"}}, proto.CodeInvalidValue, "net1"},
		{"vlan tag", testVM, proto.ManageRequest{Set: map[string]string{"net1": "virtio,bridge=vmbr0,tag=4095"}}, proto.CodeInvalidValue, "net1"},
		{"serial device", testVM, proto.ManageRequest{Set: map[string]string{"serial2": "/dev/ttyS1"}}, proto.CodeNotAllowed, "serial2"},
		{"restricted serial", testVM, proto.ManageRequest{Set: map[string]string{"serial1": "socket"}}, proto.CodeNotAllowed, "serial1"},
		{"set unused", testVM, proto.ManageRequest{Set: map[string]string{"unused0": "local-zfs:vm-100-disk-1"}}, proto.CodeNotAllowed, "unused0"},
		{"control characters", testVM, proto.ManageRequest{Set: map[string]string{"name": "web\x1b[31m"}}, proto.CodeInvalidValue, "name"},
		{"newline outside description", testVM, proto.ManageRequest{Set: map[string]string{"ciuser": "a\nb"}}, proto.CodeInvalidValue, "ciuser"},
		{"invalid UTF-8", testVM, proto.ManageRequest{Set: map[string]string{"tags": "\xff"}}, proto.CodeInvalidValue, "tags"},
		{"key twice", testVM, proto.ManageRequest{Set: map[string]string{"name": "x"}, Delete: []string{"name"}}, CodeInvalid, "name"},
		{"create-only on VM", testVM, proto.ManageRequest{Set: map[string]string{"ostemplate": "local:vztmpl/x.tar.zst"}}, proto.CodeNotAllowed, "ostemplate"},
		{"ct bind mount", testCT, proto.ManageRequest{Set: map[string]string{"mp2": "/srv/data,mp=/data"}}, proto.CodeNotAllowed, "mp2"},
		{"ct device mount", testCT, proto.ManageRequest{Set: map[string]string{"mp2": "volume=/dev/sdb1,mp=/data"}}, proto.CodeNotAllowed, "mp2"},
		{"ct restricted bind mount", testCT, proto.ManageRequest{Delete: []string{"mp1"}}, proto.CodeNotAllowed, "mp1"},
		{"ct rootfs", testCT, proto.ManageRequest{Set: map[string]string{"rootfs": "local-zfs:16"}}, proto.CodeNotAllowed, "rootfs"},
		{"ct privileged", testCT, proto.ManageRequest{Set: map[string]string{"unprivileged": "0"}}, proto.CodeNotAllowed, "unprivileged"},
		{"ct features", testCT, proto.ManageRequest{Set: map[string]string{"features": "nesting=1,mount=nfs"}}, proto.CodeNotAllowed, "features"},
		{"ct raw lxc", testCT, proto.ManageRequest{Set: map[string]string{"lxc.apparmor.profile": "unconfined"}}, proto.CodeNotAllowed, "lxc.apparmor.profile"},
		{"ct nic type", testCT, proto.ManageRequest{Set: map[string]string{"net1": "name=eth1,bridge=vmbr0,type=macvlan"}}, proto.CodeNotAllowed, "net1"},
		{"ct dev passthrough", testCT, proto.ManageRequest{Set: map[string]string{"dev0": "/dev/dri/renderD128"}}, proto.CodeNotAllowed, "dev0"},
		{"cloud-init on non-image storage", testVM, proto.ManageRequest{Set: map[string]string{"ide0": "local:cloudinit"}}, proto.CodeNotAllowed, "ide0"},
		{"cloud-init on a container", testCT, proto.ManageRequest{Set: map[string]string{"mp2": "local-zfs:cloudinit,mp=/x"}}, proto.CodeNotAllowed, "mp2"},
		{"ct storage without rootdir", testCT, proto.ManageRequest{Set: map[string]string{"mp2": "local:8,mp=/x"}}, proto.CodeNotAllowed, "mp2"},

		{"description newlines", testVM, proto.ManageRequest{Set: map[string]string{"description": "line 1\nline 2"}}, "", ""},
		{"new disk", testVM, proto.ManageRequest{Set: map[string]string{"scsi2": "local-zfs:8,iothread=1,discard=on"}}, "", ""},
		{"decimal size", testVM, proto.ManageRequest{Set: map[string]string{"virtio1": "tank:0.5"}}, "", ""},
		{"disk options unchanged volume", testVM, proto.ManageRequest{Set: map[string]string{"scsi0": "local-zfs:vm-100-disk-0,iothread=1,size=32G,cache=writeback"}}, "", ""},
		{"reattach unused", testVM, proto.ManageRequest{Set: map[string]string{"scsi2": "local-zfs:vm-100-disk-1,iothread=1"}}, "", ""},
		{"iso", testVM, proto.ManageRequest{Set: map[string]string{"ide0": "local:iso/debian-13.0.0-amd64-netinst.iso,media=cdrom"}}, "", ""},
		{"eject", testVM, proto.ManageRequest{Set: map[string]string{"ide2": "none,media=cdrom"}}, "", ""},
		{"cloud-init drive", testVM, proto.ManageRequest{Set: map[string]string{"ide0": "local-zfs:cloudinit"}}, "", ""},
		{"efidisk new", testVM, proto.ManageRequest{Set: map[string]string{"tpmstate0": "local-zfs:1,version=v2.0"}}, "", ""},
		{"nic", testVM, proto.ManageRequest{Set: map[string]string{"net1": "e1000e=BC:24:11:00:00:01,bridge=vmbr1,tag=20,firewall=1,unknown-future=1"}}, "", ""},
		{"nic model key", testVM, proto.ManageRequest{Set: map[string]string{"net1": "model=virtio,macaddr=BC:24:11:00:00:01,bridge=vmbr0"}}, "", ""},
		{"detach disk", testVM, proto.ManageRequest{Delete: []string{"scsi0"}}, "", ""},
		{"serial socket", testVM, proto.ManageRequest{Set: map[string]string{"serial2": "socket"}}, "", ""},
		{"ct mount point", testCT, proto.ManageRequest{Set: map[string]string{"mp2": "tank:4,mp=/srv"}}, "", ""},
		{"ct volume mount point options", testCT, proto.ManageRequest{Set: map[string]string{"mp0": "local-zfs:subvol-200-disk-1,mp=/data,size=20G,backup=1"}}, "", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newFakePVE(t)
			f.on("POST /nodes/pve1/qemu/100/config", func(url.Values) fakeResp { return okResp(nil) })
			f.on("PUT /nodes/pve1/lxc/200/config", func(url.Values) fakeResp { return okResp(nil) })
			m := newTestManage(t, f)
			req := tc.req
			req.Op = proto.OpConfigSet
			r := manageOp(t, m, tc.g, req)
			if tc.code == "" {
				if !r.OK || len(f.changes()) != 1 {
					t.Fatalf("refused: %+v", r)
				}
				return
			}
			if r.OK || r.Code != tc.code {
				t.Fatalf("got %+v, want code %s", r, tc.code)
			}
			if _, ok := r.FieldErrors[tc.field]; !ok {
				t.Fatalf("field errors %v, want %s", r.FieldErrors, tc.field)
			}
			if ch := f.changes(); len(ch) != 0 {
				t.Fatalf("refused change was sent: %v", ch)
			}
		})
	}
}

func TestPVEDiskResize(t *testing.T) {
	cases := []struct {
		g          *proto.Guest
		disk, size string
		code       string
	}{
		{testVM, "scsi0", "+8G", ""},
		{testVM, "scsi0", "64G", ""},
		{testVM, "scsi0", "32G", proto.CodeInvalidValue},   // not larger
		{testVM, "scsi0", "16G", proto.CodeInvalidValue},   // shrink
		{testVM, "scsi0", "-8G", proto.CodeInvalidValue},   // shrink
		{testVM, "scsi0", "+0G", proto.CodeInvalidValue},   // no-op
		{testVM, "scsi0", "8 G", proto.CodeInvalidValue},   // format
		{testVM, "ide2", "+1G", proto.CodeInvalidValue},    // CD-ROM
		{testVM, "scsi5", "+1G", proto.CodeNotFound},       // no such disk
		{testVM, "net0", "+1G", proto.CodeInvalidValue},    // not a disk
		{testVM, "unused0", "+1G", proto.CodeInvalidValue}, // unused
		{testCT, "rootfs", "+2G", ""},
		{testCT, "mp0", "21G", ""},
		{testCT, "mp1", "+1G", proto.CodeNotAllowed}, // bind mount
	}
	for _, tc := range cases {
		f := newFakePVE(t)
		f.on("PUT /nodes/pve1/qemu/100/resize", func(url.Values) fakeResp { return okResp(upidFor("resize", "100")) })
		f.on("PUT /nodes/pve1/lxc/200/resize", func(url.Values) fakeResp { return okResp(upidFor("resize", "200")) })
		m := newTestManage(t, f)
		r := manageOp(t, m, tc.g, proto.ManageRequest{Op: proto.OpDiskResize, Disk: tc.disk, Size: tc.size})
		if tc.code != "" {
			if r.Code != tc.code || len(f.changes()) != 0 {
				t.Errorf("%s %s %s: %+v, want %s", tc.g.ID, tc.disk, tc.size, r, tc.code)
			}
			continue
		}
		ch := f.changes()
		if !r.OK || r.Task == nil || len(ch) != 1 || ch[0].Form.Get("disk") != tc.disk || ch[0].Form.Get("size") != tc.size {
			t.Errorf("%s %s %s: %+v %v", tc.g.ID, tc.disk, tc.size, r, ch)
		}
	}
}

func TestPVEDiskMove(t *testing.T) {
	f := newFakePVE(t)
	f.on("POST /nodes/pve1/qemu/100/move_disk", func(url.Values) fakeResp { return okResp(upidFor("qmmove", "100")) })
	f.on("POST /nodes/pve1/lxc/200/move_volume", func(url.Values) fakeResp { return okResp(upidFor("move_volume", "200")) })
	m := newTestManage(t, f)
	r := manageOp(t, m, testVM, proto.ManageRequest{Op: proto.OpDiskMove, Disk: "scsi0", Storage: "tank", DeleteSource: true})
	ch := f.changes()
	if !r.OK || r.Task == nil || len(ch) != 1 || !reflect.DeepEqual(ch[0].Form, url.Values{"disk": {"scsi0"}, "storage": {"tank"}, "delete": {"1"}}) {
		t.Fatalf("move_disk: %+v %v", r, ch)
	}
	f.reset()
	r = manageOp(t, m, testCT, proto.ManageRequest{Op: proto.OpDiskMove, Disk: "rootfs", Storage: "tank"})
	ch = f.changes()
	if !r.OK || len(ch) != 1 || !reflect.DeepEqual(ch[0].Form, url.Values{"volume": {"rootfs"}, "storage": {"tank"}}) {
		t.Fatalf("move_volume: %+v %v", r, ch)
	}
	f.reset()
	for _, tc := range []struct {
		g             *proto.Guest
		disk, storage string
		code          string
	}{
		{testVM, "scsi0", "local", proto.CodeNotAllowed},       // no images content
		{testVM, "scsi0", "pbs", proto.CodeNotAllowed},         // backup storage
		{testVM, "scsi0", "elsewhere", proto.CodeNotAllowed},   // unknown
		{testVM, "scsi0", "local-zfs", proto.CodeInvalidValue}, // already there
		{testVM, "ide2", "tank", proto.CodeInvalidValue},       // CD-ROM
		{testCT, "mp1", "tank", proto.CodeNotAllowed},          // bind mount
		{testCT, "unused0", "tank", proto.CodeInvalidValue},    // containers move mount points only
	} {
		r := manageOp(t, m, tc.g, proto.ManageRequest{Op: proto.OpDiskMove, Disk: tc.disk, Storage: tc.storage})
		if r.Code != tc.code {
			t.Errorf("%s %s -> %s: %+v, want %s", tc.g.ID, tc.disk, tc.storage, r, tc.code)
		}
	}
	if ch := f.changes(); len(ch) != 0 {
		t.Fatalf("refused moves sent: %v", ch)
	}
	// Unused VM volumes can move.
	r = manageOp(t, m, testVM, proto.ManageRequest{Op: proto.OpDiskMove, Disk: "unused0", Storage: "tank"})
	if !r.OK {
		t.Fatalf("move unused: %+v", r)
	}
}

func TestPVEErrorMapping(t *testing.T) {
	cases := []struct {
		resp fakeResp
		code string
		msg  string
	}{
		{fakeResp{status: 400, reason: "Parameter verification failed.", errors: map[string]string{"memory": "type check ('integer') failed - got 'lots'\n"}},
			proto.CodeInvalidValue, "Parameter verification failed. (memory: type check ('integer') failed - got 'lots')"},
		{errResp(500, "can't lock file '/var/lock/qemu-server/lock-100.conf' - got timeout"), proto.CodeLocked, "can't lock file '/var/lock/qemu-server/lock-100.conf' - got timeout"},
		{errResp(500, "VM is locked (backup)"), proto.CodeLocked, "VM is locked (backup)"},
		{errResp(500, "detected modified configuration - file changed by other user? Try again."), proto.CodeDigestMismatch, ""},
		{errResp(403, "Permission check failed (/vms/100, VM.Config.HWType)"), proto.CodeNotAllowed, "Permission check failed (/vms/100, VM.Config.HWType)"},
		{errResp(500, "unable to create VM 105 - VM 105 already exists on node 'pve1'"), proto.CodeExists, ""},
		{errResp(500, "Configuration file 'nodes/pve1/qemu-server/100.conf' does not exist"), proto.CodeNotFound, ""},
		{errResp(500, "hotplug problem - "+strings.Repeat("x", 600)), CodePlatformError, "hotplug problem - " + strings.Repeat("x", 482)},
		{errResp(401, "No ticket"), CodePlatformError, "Proxmox VE refused the agent's manage token"},
	}
	for _, tc := range cases {
		f := newFakePVE(t)
		resp := tc.resp
		f.on("POST /nodes/pve1/qemu/100/config", func(url.Values) fakeResp { return resp })
		m := newTestManage(t, f)
		r := manageOp(t, m, testVM, proto.ManageRequest{Op: proto.OpConfigSet, Set: map[string]string{"memory": "16384"}})
		if r.OK || r.Code != tc.code || (tc.msg != "" && r.Message != tc.msg) {
			t.Errorf("%d %s: got %s %q, want %s %q", tc.resp.status, tc.resp.reason, r.Code, r.Message, tc.code, tc.msg)
		}
		if tc.code == proto.CodeInvalidValue && r.FieldErrors["memory"] != "type check ('integer') failed - got 'lots'" {
			t.Errorf("field errors %v", r.FieldErrors)
		}
	}
}

func TestPVEErrorMultilineTrimmed(t *testing.T) {
	r := pveErrorResponse(&pveAPIError{Status: 500, Msg: firstLine("first line\nsecond line\n", 500)})
	if r.Message != "first line" {
		t.Fatalf("message %q", r.Message)
	}
	if got := firstLine(strings.Repeat("é", 300), 501); len(got) != 500 {
		t.Fatalf("UTF-8 cut: %d bytes", len(got))
	}
}

func TestPVETokenRejected(t *testing.T) {
	f := newFakePVE(t)
	f.on("GET /nodes/pve1/qemu/100/pending", func(url.Values) fakeResp { return errResp(401, "permission denied - invalid PVE ticket") })
	m := newTestManage(t, f)
	r := manageOp(t, m, testVM, proto.ManageRequest{Op: proto.OpConfigGet})
	if r.Code != CodePlatformError || m.api != nil || m.rejectedAt.IsZero() {
		t.Fatalf("401: %+v api=%v", r, m.api)
	}
	// Still refused a minute later: the token file goes, a new token comes.
	m.rejectedAt = m.rejectedAt.Add(-2 * pveTokenRejectedFor)
	manageOp(t, m, testVM, proto.ManageRequest{Op: proto.OpConfigGet})
	if _, err := readManageToken(m.tokenFile); err == nil {
		t.Fatal("rejected token file kept")
	}
}

func TestPVEGuestOnOtherNode(t *testing.T) {
	f := newFakePVE(t)
	m := newTestManage(t, f)
	g := guestCopy(testVM)
	g.Node = "pve2"
	if r := manageOp(t, m, g, proto.ManageRequest{Op: proto.OpConfigGet}); r.Code != CodeUnsupported {
		t.Fatalf("other node: %+v", r)
	}
	g = guestCopy(testVM)
	g.ID = "../100"
	if r := manageOp(t, m, g, proto.ManageRequest{Op: proto.OpConfigGet}); r.Code != CodeInvalid {
		t.Fatalf("bad id: %+v", r)
	}
	if len(f.reqs) != 0 {
		t.Fatalf("requests sent: %v", f.reqs)
	}
}

// TestBrokerManagePVE goes through Broker.Manage: the guest comes from the
// inventory (templates too), host operations need none.
func TestBrokerManagePVE(t *testing.T) {
	f := newFakePVE(t)
	f.data("GET /nodes/pve1/qemu/9000/config", map[string]any{"template": 1, "digest": "d"})
	f.on("POST /nodes/pve1/qemu/9000/clone", func(url.Values) fakeResp { return okResp(upidFor("qmclone", "9000")) })
	inv := &proto.Report{PVE: &proto.PVE{Guests: []proto.Guest{*testVM},
		Templates: []proto.TemplateGuest{{ID: "9000", Name: "debian-tmpl", Kind: "vm", Node: "pve1"}}}}
	b := NewBroker(nil, func() *proto.Report { return inv }, nil)
	b.drivers[proto.PlatformPVE].(*pveDriver).mg = newTestManage(t, f)
	ctx := context.Background()
	if r := b.Manage(ctx, proto.ManageRequest{Op: proto.OpConfigGet, Platform: proto.PlatformPVE, GuestID: "100"}); !r.OK || r.Config.Values["name"] != "web" {
		t.Fatalf("config.get: %+v", r)
	}
	if r := b.Manage(ctx, proto.ManageRequest{Op: proto.OpClone, Platform: proto.PlatformPVE, GuestID: "9000", Name: "from-tmpl"}); !r.OK || r.NewID != "105" {
		t.Fatalf("clone of a template: %+v", r)
	}
	if r := b.Manage(ctx, proto.ManageRequest{Op: proto.OpConfigGet, Platform: proto.PlatformPVE, GuestID: "101"}); r.Code != CodeUnknownGuest {
		t.Fatalf("unknown guest: %+v", r)
	}
	if r := b.Manage(ctx, proto.ManageRequest{Op: proto.OpChoices, Platform: proto.PlatformPVE}); !r.OK || r.Choices == nil {
		t.Fatalf("choices: %+v", r)
	}
}

// A restored copy's cable is pulled whatever its card: a model Whombat
// doesn't offer and a bridge this node doesn't have stay as they are.
func TestPVEConfigSetLinkDownOnly(t *testing.T) {
	odd := "ne2k_pci=BC:24:11:00:00:01,bridge=vmbr9,firewall=1"
	for _, tc := range []struct {
		name string
		v    string
		ok   bool
	}{
		{"cable pulled", odd + ",link_down=1", true},
		{"cable pulled and bridge changed", "ne2k_pci=BC:24:11:00:00:01,bridge=vmbr0,firewall=1,link_down=1", false},
		{"cable put back", odd + ",link_down=0", false},
		{"cable pulled, model changed", "virtio=BC:24:11:00:00:01,bridge=vmbr9,firewall=1,link_down=1", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newFakePVE(t)
			pending := f.routes["GET /nodes/pve1/qemu/100/pending"]
			f.on("GET /nodes/pve1/qemu/100/pending", func(q url.Values) fakeResp {
				r := pending(q)
				r.data = append(slices.Clone(r.data.([]map[string]any)), map[string]any{"key": "net1", "value": odd})
				return r
			})
			f.on("POST /nodes/pve1/qemu/100/config", func(url.Values) fakeResp { return okResp(nil) })
			m := newTestManage(t, f)
			r := manageOp(t, m, testVM, proto.ManageRequest{Op: proto.OpConfigSet, Set: map[string]string{"net1": tc.v}})
			if r.OK != tc.ok {
				t.Fatalf("got %+v, want ok %v", r, tc.ok)
			}
			if ch := f.changes(); tc.ok && (len(ch) != 1 || ch[0].Form.Get("net1") != tc.v) || !tc.ok && len(ch) != 0 {
				t.Fatalf("requests %v", ch)
			}
		})
	}
}
