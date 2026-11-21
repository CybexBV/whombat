package broker

import (
	"context"
	"errors"
	"net/url"
	"reflect"
	"strings"
	"testing"

	"rackoon/internal/proto"
)

func TestPVECreateVM(t *testing.T) {
	f := newFakePVE(t)
	f.on("POST /nodes/pve1/qemu", func(url.Values) fakeResp { return okResp(upidFor("qmcreate", "105")) })
	m := newTestManage(t, f)
	r := manageOp(t, m, nil, proto.ManageRequest{Op: proto.OpCreate, Kind: "vm", Name: "new-vm", Start: true, Set: map[string]string{
		"cores": "2", "memory": "4096", "scsihw": "virtio-scsi-single", "ostype": "l26",
		"scsi0": "local-zfs:32,iothread=1", "ide2": "local:iso/debian-13.0.0-amd64-netinst.iso,media=cdrom",
		"efidisk0": "local-zfs:1,efitype=4m", "net0": "virtio,bridge=vmbr0,firewall=1", "bios": "ovmf",
	}})
	if !r.OK || r.NewID != "105" || r.Task == nil || r.Task.ID != upidFor("qmcreate", "105") {
		t.Fatalf("create: %+v", r)
	}
	ch := f.changes()
	want := url.Values{"cores": {"2"}, "memory": {"4096"}, "scsihw": {"virtio-scsi-single"}, "ostype": {"l26"},
		"scsi0": {"local-zfs:32,iothread=1"}, "ide2": {"local:iso/debian-13.0.0-amd64-netinst.iso,media=cdrom"},
		"efidisk0": {"local-zfs:1,efitype=4m"}, "net0": {"virtio,bridge=vmbr0,firewall=1"}, "bios": {"ovmf"},
		"name": {"new-vm"}, "start": {"1"}, "vmid": {"105"}}
	if len(ch) != 1 || !reflect.DeepEqual(ch[0].Form, want) {
		t.Fatalf("POST %v\nwant %v", ch, want)
	}

	// A chosen id; refusals.
	f.reset()
	r = manageOp(t, m, nil, proto.ManageRequest{Op: proto.OpCreate, Kind: "vm", NewID: 4242, Set: map[string]string{"memory": "512"}})
	if !r.OK || r.NewID != "4242" || f.changes()[0].Form.Get("vmid") != "4242" {
		t.Fatalf("new id: %+v", r)
	}
	f.reset()
	for _, tc := range []struct {
		req  proto.ManageRequest
		code string
	}{
		{proto.ManageRequest{Kind: "vm", NewID: 99}, proto.CodeInvalidValue},
		{proto.ManageRequest{Kind: "lxc"}, proto.CodeInvalidValue},
		{proto.ManageRequest{Kind: "vm", Name: "a b"}, proto.CodeInvalidValue},
		{proto.ManageRequest{Kind: "vm", Set: map[string]string{"scsi0": "local-zfs:vm-100-disk-0"}}, proto.CodeNotAllowed},
		{proto.ManageRequest{Kind: "vm", Set: map[string]string{"scsi0": "local-zfs:0,import-from=local:import/disk.qcow2"}}, proto.CodeNotAllowed},
		{proto.ManageRequest{Kind: "vm", Set: map[string]string{"args": "-snapshot"}}, proto.CodeNotAllowed},
		{proto.ManageRequest{Kind: "vm", Set: map[string]string{"hostpci0": "0000:01:00.0"}}, proto.CodeNotAllowed},
		{proto.ManageRequest{Kind: "vm", Set: map[string]string{"unused0": "local-zfs:vm-100-disk-1"}}, proto.CodeNotAllowed},
		{proto.ManageRequest{Kind: "vm", Set: map[string]string{"ide2": "cdrom,media=cdrom"}}, proto.CodeNotAllowed},
		{proto.ManageRequest{Kind: "vm", Set: map[string]string{"net0": "virtio,bridge=eth0"}}, proto.CodeNotAllowed},
	} {
		req := tc.req
		req.Op = proto.OpCreate
		if r := manageOp(t, m, nil, req); r.Code != tc.code {
			t.Errorf("%+v: %+v, want %s", tc.req, r, tc.code)
		}
	}
	if ch := f.changes(); len(ch) != 0 {
		t.Fatalf("refused creates sent: %v", ch)
	}
}

func TestPVECreateContainer(t *testing.T) {
	f := newFakePVE(t)
	f.on("POST /nodes/pve1/lxc", func(url.Values) fakeResp { return okResp(upidFor("vzcreate", "105")) })
	m := newTestManage(t, f)
	set := map[string]string{
		"ostemplate": "local:vztmpl/debian-13-standard_13.1-2_amd64.tar.zst", "rootfs": "local-zfs:8",
		"password": "correct horse battery", "ssh-public-keys": "ssh-ed25519 AAAA one\nssh-ed25519 BBBB two",
		"cores": "1", "memory": "512", "features": "nesting=1", "net0": "name=eth0,bridge=vmbr0,ip=dhcp,type=veth",
	}
	r := manageOp(t, m, nil, proto.ManageRequest{Op: proto.OpCreate, Kind: "container", Name: "ct1", Set: set})
	if !r.OK || r.NewID != "105" || r.Task == nil {
		t.Fatalf("create: %+v", r)
	}
	form := f.changes()[0].Form
	if form.Get("unprivileged") != "1" || form.Get("hostname") != "ct1" || form.Get("password") != "correct horse battery" || form.Get("name") != "" {
		t.Fatalf("form %v", form)
	}

	for name, tc := range map[string]struct {
		set  map[string]string
		code string
	}{
		"privileged":         {map[string]string{"ostemplate": set["ostemplate"], "unprivileged": "0"}, proto.CodeNotAllowed},
		"no template":        {map[string]string{"rootfs": "local-zfs:8"}, proto.CodeInvalidValue},
		"missing template":   {map[string]string{"ostemplate": "local:vztmpl/nothere.tar.zst"}, proto.CodeNotAllowed},
		"template path":      {map[string]string{"ostemplate": "/var/lib/vz/template/cache/x.tar.zst"}, proto.CodeNotAllowed},
		"backup as template": {map[string]string{"ostemplate": "local:backup/vzdump-lxc-200-2026_10_16-01_10_00.tar.zst"}, proto.CodeNotAllowed},
		"existing rootfs":    {map[string]string{"ostemplate": set["ostemplate"], "rootfs": "local-zfs:subvol-200-disk-0"}, proto.CodeNotAllowed},
		"bind mount":         {map[string]string{"ostemplate": set["ostemplate"], "mp0": "/srv,mp=/srv"}, proto.CodeNotAllowed},
		"raw lxc":            {map[string]string{"ostemplate": set["ostemplate"], "lxc.mount.entry": "/dev/sda dev/sda none bind"}, proto.CodeNotAllowed},
		"hookscript":         {map[string]string{"ostemplate": set["ostemplate"], "hookscript": "local:snippets/x.sh"}, proto.CodeNotAllowed},
	} {
		f.reset()
		r := manageOp(t, m, nil, proto.ManageRequest{Op: proto.OpCreate, Kind: "container", Set: tc.set})
		if r.Code != tc.code || len(f.changes()) != 0 {
			t.Errorf("%s: %+v, want %s", name, r, tc.code)
		}
	}

	// The password never comes back, even when PVE echoes it.
	f.on("POST /nodes/pve1/lxc", func(url.Values) fakeResp {
		return errResp(500, "unable to create CT 105 - password 'correct horse battery' rejected")
	})
	r = manageOp(t, m, nil, proto.ManageRequest{Op: proto.OpCreate, Kind: "container", Set: set})
	if r.OK || strings.Contains(r.Message, "horse") || !strings.Contains(r.Message, maskedSecret) {
		t.Fatalf("password in the answer: %+v", r)
	}
	f.on("POST /nodes/pve1/lxc", func(url.Values) fakeResp {
		return errResp(500, "unable to create CT 105 - CT 105 already exists on node 'pve1'")
	})
	if r = manageOp(t, m, nil, proto.ManageRequest{Op: proto.OpCreate, Kind: "container", Set: set}); r.Code != proto.CodeExists {
		t.Fatalf("exists: %+v", r)
	}
}

func TestPVEClone(t *testing.T) {
	f := newFakePVE(t)
	f.on("POST /nodes/pve1/qemu/100/clone", func(url.Values) fakeResp { return okResp(upidFor("qmclone", "100")) })
	m := newTestManage(t, f)
	// Not a template: always a full copy.
	r := manageOp(t, m, testVM, proto.ManageRequest{Op: proto.OpClone, Name: "web-copy", NewID: 110, Storage: "tank"})
	ch := f.changes()
	if !r.OK || r.NewID != "110" || r.Task == nil || len(ch) != 1 ||
		!reflect.DeepEqual(ch[0].Form, url.Values{"full": {"1"}, "storage": {"tank"}, "name": {"web-copy"}, "newid": {"110"}}) {
		t.Fatalf("clone: %+v %v", r, ch)
	}

	tmpl := &proto.Guest{ID: "9000", Name: "debian-tmpl", Kind: "vm", State: proto.StateStopped, VMID: 9000, Node: "pve1"}
	f.data("GET /nodes/pve1/qemu/9000/config", map[string]any{"template": 1, "name": "debian-tmpl", "digest": "d"})
	f.on("POST /nodes/pve1/qemu/9000/clone", func(url.Values) fakeResp { return okResp(upidFor("qmclone", "9000")) })
	f.reset()
	r = manageOp(t, m, tmpl, proto.ManageRequest{Op: proto.OpClone, Name: "linked"})
	ch = f.changes()
	if !r.OK || r.NewID != "105" || len(ch) != 1 || !reflect.DeepEqual(ch[0].Form, url.Values{"name": {"linked"}, "newid": {"105"}}) {
		t.Fatalf("linked clone: %+v %v", r, ch)
	}
	f.reset()
	if r = manageOp(t, m, tmpl, proto.ManageRequest{Op: proto.OpClone, Storage: "tank"}); r.Code != proto.CodeInvalidValue || len(f.changes()) != 0 {
		t.Fatalf("storage without full: %+v", r)
	}
	if r = manageOp(t, m, tmpl, proto.ManageRequest{Op: proto.OpClone, Full: true, Storage: "local"}); r.Code != proto.CodeNotAllowed {
		t.Fatalf("storage without images: %+v", r)
	}
	f.data("GET /nodes/pve1/lxc/200/config", map[string]any{"hostname": "dns"})
	f.on("POST /nodes/pve1/lxc/200/clone", func(url.Values) fakeResp { return okResp(upidFor("vzclone", "200")) })
	f.reset()
	r = manageOp(t, m, testCT, proto.ManageRequest{Op: proto.OpClone, Name: "dns2"})
	if ch = f.changes(); !r.OK || ch[0].Form.Get("hostname") != "dns2" || ch[0].Form.Get("full") != "1" {
		t.Fatalf("container clone: %+v %v", r, ch)
	}
}

func TestPVETemplateAndDelete(t *testing.T) {
	f := newFakePVE(t)
	f.on("POST /nodes/pve1/lxc/200/template", func(url.Values) fakeResp { return okResp(nil) })
	f.on("DELETE /nodes/pve1/lxc/200", func(url.Values) fakeResp { return okResp(upidFor("vzdestroy", "200")) })
	m := newTestManage(t, f)
	if r := manageOp(t, m, testVM, proto.ManageRequest{Op: proto.OpTemplate}); r.Code != proto.CodeGuestRunning {
		t.Fatalf("template of a running VM: %+v", r)
	}
	if r := manageOp(t, m, testVM, proto.ManageRequest{Op: proto.OpDelete}); r.Code != proto.CodeGuestRunning {
		t.Fatalf("delete of a running VM: %+v", r)
	}
	if r := manageOp(t, m, testCT, proto.ManageRequest{Op: proto.OpTemplate}); !r.OK || r.Task != nil {
		t.Fatalf("template: %+v", r)
	}
	r := manageOp(t, m, testCT, proto.ManageRequest{Op: proto.OpDelete, Purge: true})
	del := f.requested("DELETE", "/nodes/pve1/lxc/200")
	if !r.OK || r.Task == nil || len(del) != 1 || !reflect.DeepEqual(del[0].Form, url.Values{"purge": {"1"}, "destroy-unreferenced-disks": {"1"}}) {
		t.Fatalf("delete: %+v %v", r, del)
	}
	f.data("GET /nodes/pve1/lxc/200/config", map[string]any{"hostname": "dns", "protection": 1})
	f.reset()
	if r := manageOp(t, m, testCT, proto.ManageRequest{Op: proto.OpDelete}); r.Code != proto.CodeProtected || len(f.changes()) != 0 {
		t.Fatalf("delete of a protected guest: %+v", r)
	}
}

func TestPVEBackups(t *testing.T) {
	f := newFakePVE(t)
	f.on("GET /nodes/pve1/storage/pbs/content", func(q url.Values) fakeResp {
		if q.Get("vmid") != "100" || q.Get("content") != "backup" {
			t.Errorf("pbs query %v", q)
		}
		return okResp([]map[string]any{{"volid": "pbs:backup/vm/100/2026-10-17T01:00:00Z", "content": "backup", "format": "pbs-vm", "size": 3 << 30,
			"ctime": 1760662800, "vmid": 100, "subtype": "qemu", "protected": true, "encrypted": "aa:bb", "verification": map[string]any{"state": "ok"}}})
	})
	m := newTestManage(t, f)
	r := manageOp(t, m, testVM, proto.ManageRequest{Op: proto.OpBackupList})
	if !r.OK || len(r.Backups) != 2 {
		t.Fatalf("backup.list: %+v", r)
	}
	b := r.Backups[0]
	if b.Volume != "pbs:backup/vm/100/2026-10-17T01:00:00Z" || b.Storage != "pbs" || b.Kind != "vm" || !b.Protected || !b.Encrypted || b.Verified != "ok" || b.SizeBytes != 3<<30 || b.GuestID != "100" {
		t.Fatalf("newest backup %+v", b)
	}
	if r.Backups[1].Notes != "nightly" || r.Backups[1].Format != "vma.zst" || r.Backups[1].Kind != "vm" {
		t.Fatalf("backups %+v", r.Backups)
	}

	// backup.create
	f.on("POST /nodes/pve1/vzdump", func(url.Values) fakeResp { return okResp(upidFor("vzdump", "100")) })
	yes := true
	r = manageOp(t, m, testVM, proto.ManageRequest{Op: proto.OpBackupCreate, Storage: "local", Notes: "{{guestname}} before upgrade", Protected: &yes})
	ch := f.changes()
	want := url.Values{"vmid": {"100"}, "storage": {"local"}, "mode": {"snapshot"}, "compress": {"zstd"}, "notes-template": {"{{guestname}} before upgrade"}, "protected": {"1"}}
	if !r.OK || r.Task == nil || len(ch) != 1 || !reflect.DeepEqual(ch[0].Form, want) {
		t.Fatalf("vzdump: %+v %v", r, ch)
	}
	f.reset()
	r = manageOp(t, m, testVM, proto.ManageRequest{Op: proto.OpBackupCreate, Storage: "pbs", Mode: "stop", Compress: "gzip"})
	if ch = f.changes(); !r.OK || ch[0].Form.Get("compress") != "" || ch[0].Form.Get("mode") != "stop" {
		t.Fatalf("vzdump to PBS: %+v %v", r, ch)
	}
	f.reset()
	for _, req := range []proto.ManageRequest{
		{Storage: "local-zfs"},
		{Storage: "local", Mode: "fast"},
		{Storage: "local", Compress: "xz"},
		{Storage: "local", Notes: "two\nlines"},
	} {
		req.Op = proto.OpBackupCreate
		if r := manageOp(t, m, testVM, req); r.OK {
			t.Errorf("accepted %+v", req)
		}
	}
	if ch := f.changes(); len(ch) != 0 {
		t.Fatalf("refused backups sent: %v", ch)
	}
}

func TestPVEBackupRestore(t *testing.T) {
	f := newFakePVE(t)
	f.on("POST /nodes/pve1/qemu", func(url.Values) fakeResp { return okResp(upidFor("qmrestore", "105")) })
	f.on("POST /nodes/pve1/lxc", func(url.Values) fakeResp { return okResp(upidFor("vzrestore", "200")) })
	m := newTestManage(t, f)
	vol := "local:backup/vzdump-qemu-100-2026_10_16-01_00_02.vma.zst"
	r := manageOp(t, m, nil, proto.ManageRequest{Op: proto.OpBackupRestore, Volume: vol, Storage: "tank", Unique: true, Start: true})
	ch := f.changes()
	want := url.Values{"vmid": {"105"}, "archive": {vol}, "storage": {"tank"}, "unique": {"1"}, "start": {"1"}}
	if !r.OK || r.NewID != "105" || r.Task == nil || len(ch) != 1 || ch[0].Path != "/nodes/pve1/qemu" || !reflect.DeepEqual(ch[0].Form, want) {
		t.Fatalf("restore as new: %+v %v", r, ch)
	}

	// Over the existing (stopped) container.
	f.reset()
	ctVol := "local:backup/vzdump-lxc-200-2026_10_16-01_10_00.tar.zst"
	r = manageOp(t, m, testCT, proto.ManageRequest{Op: proto.OpBackupRestore, Volume: ctVol})
	ch = f.changes()
	want = url.Values{"vmid": {"200"}, "ostemplate": {ctVol}, "restore": {"1"}, "force": {"1"}}
	if !r.OK || r.NewID != "200" || len(ch) != 1 || ch[0].Path != "/nodes/pve1/lxc" || !reflect.DeepEqual(ch[0].Form, want) {
		t.Fatalf("restore over: %+v %v", r, ch)
	}

	f.reset()
	for _, tc := range []struct {
		g    *proto.Guest
		vol  string
		code string
	}{
		{testVM, vol, proto.CodeGuestRunning},                                             // overwrite a running VM
		{testCT, vol, proto.CodeInvalidValue},                                             // VM backup over a container
		{nil, "local:backup/vzdump-qemu-100-1999_01_01-00_00_00.vma", proto.CodeNotFound}, // not listed
		{nil, "elsewhere:backup/vzdump-qemu-100.vma", proto.CodeNotAllowed},               // foreign storage
		{nil, "local-zfs:backup/x.vma", proto.CodeNotAllowed},                             // not a backup storage
		{nil, "local:iso/debian-13.0.0-amd64-netinst.iso", proto.CodeInvalidValue},        // not a backup
		{nil, "/var/lib/vz/dump/vzdump-qemu-100.vma", proto.CodeInvalidValue},             // a path
		{nil, "local:backup/../../etc/passwd", proto.CodeInvalidValue},
	} {
		if r := manageOp(t, m, tc.g, proto.ManageRequest{Op: proto.OpBackupRestore, Volume: tc.vol}); r.Code != tc.code {
			t.Errorf("restore %s over %v: %+v, want %s", tc.vol, tc.g, r, tc.code)
		}
	}
	if ch := f.changes(); len(ch) != 0 {
		t.Fatalf("refused restores sent: %v", ch)
	}
}

func TestPVEBackupUpdateDelete(t *testing.T) {
	f := newFakePVE(t)
	vol := "local:backup/vzdump-qemu-100-2026_10_16-01_00_02.vma.zst"
	path := "/nodes/pve1/storage/local/content/" + vol
	f.on("PUT "+path, func(url.Values) fakeResp { return okResp(nil) })
	f.data("GET "+path, map[string]any{"format": "vma.zst", "size": 2 << 30, "protected": 0, "notes": "nightly"})
	f.on("DELETE "+path, func(url.Values) fakeResp { return okResp(upidFor("imgdel", "")) })
	m := newTestManage(t, f)
	no := false
	r := manageOp(t, m, nil, proto.ManageRequest{Op: proto.OpBackupUpdate, Volume: vol, Protected: &no})
	ch := f.changes()
	if !r.OK || len(ch) != 1 || !reflect.DeepEqual(ch[0].Form, url.Values{"protected": {"0"}}) {
		t.Fatalf("protect toggle: %+v %v", r, ch)
	}
	f.reset()
	r = manageOp(t, m, nil, proto.ManageRequest{Op: proto.OpBackupUpdate, Volume: vol, Notes: "kept\nfor audit"})
	if ch = f.changes(); !r.OK || !reflect.DeepEqual(ch[0].Form, url.Values{"notes": {"kept\nfor audit"}}) {
		t.Fatalf("notes: %+v %v", r, ch)
	}
	f.reset()
	r = manageOp(t, m, nil, proto.ManageRequest{Op: proto.OpBackupDelete, Volume: vol})
	if del := f.requested("DELETE", path); !r.OK || r.Task == nil || len(del) != 1 {
		t.Fatalf("delete: %+v %v", r, del)
	}
	f.data("GET "+path, map[string]any{"protected": 1})
	f.reset()
	if r = manageOp(t, m, nil, proto.ManageRequest{Op: proto.OpBackupDelete, Volume: vol}); r.Code != proto.CodeProtected || len(f.changes()) != 0 {
		t.Fatalf("delete protected: %+v", r)
	}
	if r = manageOp(t, m, nil, proto.ManageRequest{Op: proto.OpBackupDelete, Volume: "local:iso/debian-13.0.0-amd64-netinst.iso"}); r.Code != proto.CodeInvalidValue {
		t.Fatalf("delete an ISO as a backup: %+v", r)
	}
}

func TestPVEContent(t *testing.T) {
	f := newFakePVE(t)
	m := newTestManage(t, f)
	r := manageOp(t, m, nil, proto.ManageRequest{Op: proto.OpContentList, Storage: "local", Content: "iso"})
	if !r.OK || len(r.Content) != 1 || r.Content[0].Name != "debian-13.0.0-amd64-netinst.iso" || r.Content[0].Volume != "local:iso/debian-13.0.0-amd64-netinst.iso" ||
		r.Content[0].SizeBytes != 754974720 || r.Content[0].Created.Unix() != 1760000000 {
		t.Fatalf("content.list: %+v", r)
	}
	for _, req := range []proto.ManageRequest{
		{Storage: "local", Content: "backup"},
		{Storage: "local-zfs", Content: "iso"},
		{Storage: "elsewhere", Content: "iso"},
	} {
		req.Op = proto.OpContentList
		if r := manageOp(t, m, nil, req); r.OK {
			t.Errorf("content.list accepted %+v", req)
		}
	}

	f.on("POST /nodes/pve1/storage/local/download-url", func(url.Values) fakeResp { return okResp(upidFor("download", "")) })
	r = manageOp(t, m, nil, proto.ManageRequest{Op: proto.OpContentDownload, Storage: "local", Content: "iso",
		URL: "https://cdimage.debian.org/debian-cd/current/amd64/iso-cd/debian-13.1.0-amd64-netinst.iso", Filename: "debian-13.1.0-amd64-netinst.iso",
		Checksum: strings.Repeat("ab", 32), ChecksumAlgorithm: "sha256"})
	ch := f.changes()
	if !r.OK || r.Task == nil || len(ch) != 1 || ch[0].Form.Get("verify-certificates") != "1" || ch[0].Form.Get("checksum-algorithm") != "sha256" ||
		ch[0].Form.Get("filename") != "debian-13.1.0-amd64-netinst.iso" || ch[0].Form.Get("content") != "iso" {
		t.Fatalf("download: %+v %v", r, ch)
	}
	f.reset()
	for name, req := range map[string]proto.ManageRequest{
		"ftp":            {Storage: "local", Content: "iso", URL: "ftp://example.org/x.iso", Filename: "x.iso"},
		"file":           {Storage: "local", Content: "iso", URL: "file:///etc/shadow", Filename: "x.iso"},
		"credentials":    {Storage: "local", Content: "iso", URL: "https://user:pw@example.org/x.iso", Filename: "x.iso"},
		"no host":        {Storage: "local", Content: "iso", URL: "https:///x.iso", Filename: "x.iso"},
		"wrong ext":      {Storage: "local", Content: "iso", URL: "https://example.org/x.iso", Filename: "x.exe"},
		"slash":          {Storage: "local", Content: "iso", URL: "https://example.org/x.iso", Filename: "../x.iso"},
		"hidden":         {Storage: "local", Content: "iso", URL: "https://example.org/x.iso", Filename: ".iso"},
		"template ext":   {Storage: "local", Content: "vztmpl", URL: "https://example.org/x.iso", Filename: "x.iso"},
		"bad checksum":   {Storage: "local", Content: "iso", URL: "https://example.org/x.iso", Filename: "x.iso", Checksum: "xyz", ChecksumAlgorithm: "sha256"},
		"bad algorithm":  {Storage: "local", Content: "iso", URL: "https://example.org/x.iso", Filename: "x.iso", Checksum: strings.Repeat("a", 64), ChecksumAlgorithm: "crc32"},
		"no algorithm":   {Storage: "local", Content: "iso", URL: "https://example.org/x.iso", Filename: "x.iso", Checksum: strings.Repeat("a", 64)},
		"wrong storage":  {Storage: "local-zfs", Content: "iso", URL: "https://example.org/x.iso", Filename: "x.iso"},
		"bad content":    {Storage: "local", Content: "images", URL: "https://example.org/x.iso", Filename: "x.iso"},
		"control in url": {Storage: "local", Content: "iso", URL: "https://example.org/x.iso\r\nHost: evil", Filename: "x.iso"},
	} {
		req.Op = proto.OpContentDownload
		if r := manageOp(t, m, nil, req); r.OK {
			t.Errorf("%s: download accepted", name)
		}
	}
	for _, ok := range []struct{ content, name string }{{"vztmpl", "alpine-3.22-default_20250617_amd64.tar.xz"}, {"import", "haos_ova-16.2.qcow2"}, {"iso", "virtio-win.img"}} {
		if err := checkDownloadName(ok.content, ok.name); err != nil {
			t.Errorf("%s %s: %v", ok.content, ok.name, err)
		}
	}
	if ch := f.changes(); len(ch) != 0 {
		t.Fatalf("refused downloads sent: %v", ch)
	}
}

// cmdRecorder records the commands a manager runs as root.
type cmdRecorder struct {
	calls []string
	err   error
}

func (c *cmdRecorder) run(ctx context.Context, argv ...string) ([]byte, error) {
	c.calls = append(c.calls, strings.Join(argv, " "))
	return nil, c.err
}

// content.delete runs pvesm free as root for listed ISO images, container
// templates and import files only.
func TestPVEContentDelete(t *testing.T) {
	cases := []struct {
		vol  string
		code string // "" = deleted
	}{
		{"local:iso/debian-13.0.0-amd64-netinst.iso", ""},
		{"local:vztmpl/debian-13-standard_13.1-2_amd64.tar.zst", ""},
		{"local:import/haos_ova-16.2.qcow2", ""},
		{"local-zfs:vm-100-disk-0", proto.CodeNotAllowed},                                  // a guest disk
		{"local:backup/vzdump-qemu-100-2026_10_16-01_00_02.vma.zst", proto.CodeNotAllowed}, // backups: backup.delete
		{"local:snippets/hook.sh", proto.CodeNotAllowed},
		{"local-zfs:iso/x.iso", proto.CodeNotAllowed}, // storage without iso content
		{"nas-iso:iso/x.iso", proto.CodeNotAllowed},   // inactive storage
		{"elsewhere:iso/x.iso", proto.CodeNotAllowed}, // not a storage of this node
		{"local:iso", proto.CodeNotAllowed},
		{"local:iso/", proto.CodeNotAllowed},
		{"/var/lib/vz/template/iso/debian-13.0.0-amd64-netinst.iso", proto.CodeNotAllowed},
		{"local:iso/../../../etc/shadow", proto.CodeNotAllowed},
		{"-local:iso/x.iso", proto.CodeNotAllowed},
		{"local:iso/debian-13.0.0-amd64-netinst.iso --storage x", proto.CodeNotAllowed},
		{"local:iso/missing.iso", proto.CodeNotFound},
		{"local:iso/DEBIAN-13.0.0-amd64-netinst.iso", proto.CodeNotFound},            // exact match only
		{"local:iso/debian-13.0.0-amd64-netinst.iso.part", proto.CodeNotFound},       // exact match only
		{"local:vztmpl/debian-13.0.0-amd64-netinst.iso", proto.CodeNotFound},         // listed as iso, not vztmpl
		{"local:import/debian-13-standard_13.1-2_amd64.tar.zst", proto.CodeNotFound}, // listed as vztmpl
	}
	for _, tc := range cases {
		f := newFakePVE(t)
		m := newTestManage(t, f)
		rec := &cmdRecorder{}
		m.run = rec.run
		r := manageOp(t, m, nil, proto.ManageRequest{Op: proto.OpContentDelete, Volume: tc.vol})
		if tc.code != "" {
			if r.OK || r.Code != tc.code || len(rec.calls) != 0 {
				t.Errorf("%s: %+v %q, want %s", tc.vol, r, rec.calls, tc.code)
			}
			continue
		}
		if !r.OK || r.Task != nil || len(rec.calls) != 1 || rec.calls[0] != "pvesm free "+tc.vol {
			t.Errorf("%s: %+v %q", tc.vol, r, rec.calls)
		}
		if ch := f.changes(); len(ch) != 0 {
			t.Errorf("%s: API changes %v", tc.vol, ch)
		}
	}

	// PVE's error comes through.
	f := newFakePVE(t)
	m := newTestManage(t, f)
	rec := &cmdRecorder{err: errors.New("pvesm: unable to remove volume 'local:iso/debian-13.0.0-amd64-netinst.iso' - in use by VM 100")}
	m.run = rec.run
	r := manageOp(t, m, nil, proto.ManageRequest{Op: proto.OpContentDelete, Volume: "local:iso/debian-13.0.0-amd64-netinst.iso"})
	if r.OK || r.Code != CodePlatformError || r.Message != rec.err.Error() {
		t.Fatalf("pvesm failure: %+v", r)
	}
}

func TestPVEAppliances(t *testing.T) {
	f := newFakePVE(t)
	f.data("GET /nodes/pve1/aplinfo", []map[string]any{
		{"template": "debian-13-standard_13.1-2_amd64.tar.zst", "package": "debian-13-standard", "headline": "Debian 13 (standard)", "os": "debian-13", "version": "13.1-2", "section": "system", "type": "lxc"},
		{"template": "alpine-3.22-default_20250617_amd64.tar.xz", "package": "alpine-3.22-default", "section": "system"},
	})
	f.on("POST /nodes/pve1/aplinfo", func(url.Values) fakeResp { return okResp(upidFor("download", "")) })
	m := newTestManage(t, f)
	r := manageOp(t, m, nil, proto.ManageRequest{Op: proto.OpApplianceList})
	if !r.OK || len(r.Appliances) != 2 || r.Appliances[1].Headline != "Debian 13 (standard)" || r.Appliances[1].Section != "system" {
		t.Fatalf("appliance.list: %+v", r)
	}
	r = manageOp(t, m, nil, proto.ManageRequest{Op: proto.OpApplianceDownload, Storage: "local", Template: "debian-13-standard_13.1-2_amd64.tar.zst"})
	if ch := f.changes(); !r.OK || r.Task == nil || !reflect.DeepEqual(ch[0].Form, url.Values{"storage": {"local"}, "template": {"debian-13-standard_13.1-2_amd64.tar.zst"}}) {
		t.Fatalf("appliance.download: %+v %v", r, ch)
	}
	f.reset()
	if r = manageOp(t, m, nil, proto.ManageRequest{Op: proto.OpApplianceDownload, Storage: "local-zfs", Template: "x.tar.zst"}); r.Code != proto.CodeNotAllowed {
		t.Fatalf("storage without vztmpl: %+v", r)
	}
	if r = manageOp(t, m, nil, proto.ManageRequest{Op: proto.OpApplianceDownload, Storage: "local", Template: "../x"}); r.Code != proto.CodeInvalidValue {
		t.Fatalf("bad template: %+v", r)
	}
	if ch := f.changes(); len(ch) != 0 {
		t.Fatalf("refused downloads sent: %v", ch)
	}
}

// One unreachable backup storage does not hide the others; all of them
// failing is an error.
func TestPVEBackupListPartial(t *testing.T) {
	f := newFakePVE(t)
	f.on("GET /nodes/pve1/storage/pbs/content", func(url.Values) fakeResp {
		return errResp(500, "error fetching datastores - 500 Can't connect to 10.0.0.9:8007 (Connection refused)")
	})
	m := newTestManage(t, f)
	r := manageOp(t, m, testVM, proto.ManageRequest{Op: proto.OpBackupList})
	if !r.OK || len(r.Backups) != 1 || r.Backups[0].Storage != "local" {
		t.Fatalf("partial: %+v", r)
	}
	f.on("GET /nodes/pve1/storage/local/content", func(url.Values) fakeResp { return errResp(500, "storage 'local' is not online") })
	if r = manageOp(t, m, testVM, proto.ManageRequest{Op: proto.OpBackupList}); r.OK || r.Code != CodePlatformError {
		t.Fatalf("all failing: %+v", r)
	}
}

func TestPVEMigrate(t *testing.T) {
	f := newFakePVE(t)
	m := newTestManage(t, f)
	// A standalone node has nowhere to go.
	if r := manageOp(t, m, testVM, proto.ManageRequest{Op: proto.OpMigrate, Target: "pve2"}); r.Code != CodeUnsupported || len(f.changes()) != 0 {
		t.Fatalf("standalone: %+v", r)
	}
	clusterOf(f)
	f.on("POST /nodes/pve1/qemu/100/migrate", func(url.Values) fakeResp { return okResp(upidFor("qmigrate", "100")) })
	f.on("POST /nodes/pve1/lxc/200/migrate", func(url.Values) fakeResp { return okResp(upidFor("vzmigrate", "200")) })
	// A running VM moves live with its local disks.
	f.reset()
	r := manageOp(t, m, testVM, proto.ManageRequest{Op: proto.OpMigrate, Target: "pve2", Storage: "tank",
		Digest: "0123456789abcdef0123456789abcdef01234567"})
	ch := f.changes()
	if !r.OK || r.Task == nil || r.Task.ID != upidFor("qmigrate", "100") || len(ch) != 1 ||
		!reflect.DeepEqual(ch[0].Form, url.Values{"target": {"pve2"}, "online": {"1"}, "with-local-disks": {"1"}, "targetstorage": {"tank"}}) {
		t.Fatalf("vm: %+v %v", r, ch)
	}
	// A stopped container moves offline; a running one with a restart.
	f.reset()
	r = manageOp(t, m, testCT, proto.ManageRequest{Op: proto.OpMigrate, Target: "pve3"})
	if ch = f.changes(); !r.OK || !reflect.DeepEqual(ch[0].Form, url.Values{"target": {"pve3"}}) {
		t.Fatalf("stopped ct: %+v %v", r, ch)
	}
	f.data("GET /nodes/pve1/lxc/200/status/current", map[string]any{"status": "running", "vmid": 200})
	f.reset()
	r = manageOp(t, m, testCT, proto.ManageRequest{Op: proto.OpMigrate, Target: "pve2", Storage: "local-zfs"})
	if ch = f.changes(); !r.OK || !reflect.DeepEqual(ch[0].Form, url.Values{"target": {"pve2"}, "restart": {"1"}, "timeout": {"180"},
		"target-storage": {"local-zfs"}}) {
		t.Fatalf("running ct: %+v %v", r, ch)
	}
	// Refusals: not a node of the cluster, this node, a changed
	// configuration, a bad storage name.
	f.reset()
	for _, tc := range []struct {
		req  proto.ManageRequest
		code string
	}{
		{proto.ManageRequest{Target: "pve9"}, proto.CodeInvalidValue},
		{proto.ManageRequest{Target: "pve1"}, proto.CodeInvalidValue},
		{proto.ManageRequest{Target: "pve2", Digest: "stale"}, proto.CodeDigestMismatch},
		{proto.ManageRequest{Target: "pve2", Storage: "/dev/sda"}, proto.CodeInvalidValue},
	} {
		req := tc.req
		req.Op = proto.OpMigrate
		if r := manageOp(t, m, testVM, req); r.Code != tc.code {
			t.Errorf("%+v: %+v, want %s", tc.req, r, tc.code)
		}
	}
	if ch := f.changes(); len(ch) != 0 {
		t.Fatalf("refused migrations sent: %v", ch)
	}
}
