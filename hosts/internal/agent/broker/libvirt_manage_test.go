package broker_test

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
	"time"

	libvirt "github.com/digitalocean/go-libvirt"

	"rackoon/internal/agent/broker"
	"rackoon/internal/agent/broker/lvfake"
	"rackoon/internal/proto"
)

const lvImages = "/var/lib/libvirt/images"

// webXML: a running Linux VM (vCPUs and memory below their maximum, an
// empty CD/DVD drive, a NIC on the default network).
const webXML = `<domain type='kvm'><name>web</name><uuid>11111111-2222-4333-8444-555555555555</uuid>
<memory unit='KiB'>8388608</memory><currentMemory unit='KiB'>4194304</currentMemory><vcpu placement='static' current='2'>4</vcpu>
<os><type arch='x86_64' machine='pc-q35-10.0'>hvm</type><boot dev='hd'/></os><features><acpi/><apic/></features>
<cpu mode='host-passthrough' check='none' migratable='on'/><on_poweroff>destroy</on_poweroff><on_reboot>restart</on_reboot><on_crash>destroy</on_crash>
<devices><emulator>/usr/bin/qemu-system-x86_64</emulator>
<disk type='file' device='disk'><driver name='qemu' type='qcow2'/><source file='/var/lib/libvirt/images/web.qcow2'/><target dev='vda' bus='virtio'/></disk>
<disk type='file' device='cdrom'><driver name='qemu' type='raw'/><target dev='sda' bus='sata'/><readonly/></disk>
<interface type='network'><mac address='52:54:00:aa:bb:01'/><source network='default'/><model type='virtio'/></interface>
<hostdev mode='subsystem' type='pci' managed='yes'><source><address domain='0x0000' bus='0x01' slot='0x00' function='0x0'/></source></hostdev>
<graphics type='vnc' port='-1' autoport='yes' listen='127.0.0.1'/><video><model type='virtio'/></video><watchdog model='itco' action='reset'/></devices></domain>`

const dbXML = `<domain type='kvm'><name>db</name><uuid>aaaaaaaa-2222-4333-8444-555555555555</uuid>
<memory unit='KiB'>2097152</memory><vcpu>2</vcpu><os firmware='efi'><type arch='x86_64' machine='q35'>hvm</type><nvram template='/usr/share/OVMF/OVMF_VARS_4M.fd'>/var/lib/libvirt/qemu/nvram/db_VARS.fd</nvram></os>
<devices><disk type='file' device='disk'><driver name='qemu' type='raw'/><source file='/var/lib/libvirt/images/db.img'/><target dev='vda' bus='virtio'/></disk>
<disk type='block' device='disk'><driver name='qemu' type='raw'/><source dev='/dev/disk/by-id/ata-HDD'/><target dev='vdb' bus='virtio'/></disk>
<interface type='bridge'><mac address='52:54:00:aa:bb:02'/><source bridge='br0'/><model type='virtio'/></interface></devices></domain>`

func newLvTest(t *testing.T) (*lvfake.Fake, func(g string, req proto.ManageRequest) proto.ManageResponse) {
	t.Helper()
	f := lvfake.New()
	f.AddDisk(lvImages+"/web.qcow2", "qcow2", 20<<30, 3<<30)
	f.AddDisk(lvImages+"/db.img", "raw", 10<<30, 2<<30)
	f.AddFile(lvImages+"/debian-13.iso", []byte("ISO"))
	f.AddFile("/var/lib/libvirt/qemu/nvram/db_VARS.fd", []byte("VARS"))
	f.AddFile("/var/log/libvirt/qemu/web.log", []byte("2026-10-17 starting up\nline 2\nline 3\n"))
	if err := f.AddDomain(webXML, true); err != nil {
		t.Fatal(err)
	}
	if err := f.AddDomain(dbXML, false); err != nil {
		t.Fatal(err)
	}
	f.AddLease("default", "52:54:00:aa:bb:01", "192.168.122.10", "web")
	m := broker.NewLibvirtManager(func() (broker.LibvirtConn, error) { return f, nil }, f, "")
	call := func(g string, req proto.ManageRequest) proto.ManageResponse {
		req.Platform = proto.PlatformLibvirt
		var guest *proto.Guest
		if g != "" {
			guest = &proto.Guest{ID: g, Name: g, Kind: "vm"}
			req.GuestID = g
		}
		return m.Manage(context.Background(), guest, req)
	}
	t.Cleanup(func() {
		if n := f.TransientPools(); n != 0 {
			t.Errorf("%d transient pools left", n)
		}
	})
	return f, call
}

// waitTask follows a task until it ends.
func waitTask(t *testing.T, call func(string, proto.ManageRequest) proto.ManageResponse, r proto.ManageResponse) proto.TaskStatus {
	t.Helper()
	if !r.OK || r.Task == nil {
		t.Fatalf("no task: %+v", r)
	}
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		s := call("", proto.ManageRequest{Op: proto.OpTaskStatus, Task: r.Task.ID})
		if !s.OK {
			t.Fatalf("task.status: %+v", s)
		}
		if s.TaskStatus.Status != "running" {
			full := call("", proto.ManageRequest{Op: proto.OpTaskStatus, Task: r.Task.ID})
			return *full.TaskStatus
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("task %s did not end", r.Task.ID)
	return proto.TaskStatus{}
}

func TestLibvirtConfig(t *testing.T) {
	f, call := newLvTest(t)
	r := call("web", proto.ManageRequest{Op: proto.OpConfigGet})
	if !r.OK || r.Config == nil {
		t.Fatalf("config.get: %+v", r)
	}
	c := r.Config
	if !c.Running || c.Platform != "libvirt" || c.Kind != "vm" || len(c.Digest) != 64 {
		t.Errorf("config = %+v", c)
	}
	want := map[string]string{"vcpus": "2", "vcpus_max": "4", "memory_mb": "4096", "memory_max_mb": "8192", "autostart": "0",
		"boot": "hd", "cpu_mode": "host-passthrough", "firmware": "bios",
		"disk0":    "source=/var/lib/libvirt/images/web.qcow2,bus=virtio,format=qcow2,target=vda,size=21474836480",
		"cdrom0":   "source=empty,bus=sata,target=sda",
		"net0":     "model=virtio,network=default,mac=52:54:00:aa:bb:01,link=up",
		"hostdev0": "type=pci,address=0000:01:00.0"}
	for k, w := range want {
		if c.Values[k] != w {
			t.Errorf("%s = %q, want %q", k, c.Values[k], w)
		}
	}
	for _, k := range []string{"hostdev0", "machine", "firmware", "tpm", "graphics0", "video"} {
		if !slices.Contains(c.Restricted, k) {
			t.Errorf("%s not restricted: %v", k, c.Restricted)
		}
	}
	if len(c.Disks) != 2 || c.Disks[0].Key != "disk0" || c.Disks[0].Storage != "default" || !c.Disks[0].Boot || c.Disks[1].Media != "cdrom" {
		t.Errorf("disks = %+v", c.Disks)
	}

	// A running VM: memory, vCPUs, the CD/DVD, link state, title and
	// autostart at once; the boot order and CPU mode wait.
	r = call("web", proto.ManageRequest{Op: proto.OpConfigSet, Digest: c.Digest, Set: map[string]string{
		"memory_mb": "6144", "vcpus": "3", "cdrom0": "source=default/debian-13.iso", "net0": "model=virtio,network=default,link=down",
		"title": "Web server", "autostart": "1", "boot": "cdrom,hd", "cpu_mode": "custom:EPYC-v4"}})
	if !r.OK {
		t.Fatalf("config.set: %+v", r)
	}
	pend := map[string]bool{}
	for _, ch := range r.Changes {
		pend[ch.Key] = ch.Pending
	}
	for k, p := range map[string]bool{"memory_mb": false, "vcpus": false, "cdrom0": false, "net0": false, "title": false, "autostart": false,
		"boot": true, "cpu_mode": true} {
		if got, ok := pend[k]; !ok || got != p {
			t.Errorf("change %s pending=%v (present %v), want pending=%v; changes %+v", k, got, ok, p, r.Changes)
		}
	}
	calls := strings.Join(f.Calls, "\n")
	for _, w := range []string{"DomainSetMemoryFlags 6291456 1", "DomainSetVcpusFlags 3 1", "DomainSetMetadata 1 \"Web server\" 1",
		"<source file='/var/lib/libvirt/images/debian-13.iso'/>", "<link state='down'/>", "DomainSetAutostart web 1"} {
		if !strings.Contains(calls, w) {
			t.Errorf("missing call %q in\n%s", w, calls)
		}
	}
	c2 := call("web", proto.ManageRequest{Op: proto.OpConfigGet}).Config
	if c2.Values["cdrom0"] != "source=/var/lib/libvirt/images/debian-13.iso,bus=sata,target=sda" || c2.Pending["boot"] != "cdrom,hd" ||
		c2.Values["autostart"] != "1" || c2.Values["title"] != "Web server" || c2.Pending["title"] != "" {
		t.Errorf("after config.set: values %v pending %v", c2.Values, c2.Pending)
	}
	if _, ok := c2.Pending["memory_mb"]; ok {
		t.Errorf("memory waits: %v", c2.Pending)
	}
	// Revert drops what waits for the restart.
	r = call("web", proto.ManageRequest{Op: proto.OpConfigSet, Revert: []string{"boot"}})
	if c3 := call("web", proto.ManageRequest{Op: proto.OpConfigGet}).Config; !r.OK || c3.Pending["boot"] != "" {
		t.Errorf("revert: %+v pending %v", r, c3.Pending)
	}
	// Stale digest, restricted keys, bad values.
	if r := call("web", proto.ManageRequest{Op: proto.OpConfigSet, Digest: c.Digest, Set: map[string]string{"title": "x"}}); r.Code != proto.CodeDigestMismatch {
		t.Errorf("stale digest: %+v", r)
	}
	if r := call("web", proto.ManageRequest{Op: proto.OpConfigSet, Set: map[string]string{"hostdev0": "type=pci", "machine": "q35"}}); r.Code != proto.CodeNotAllowed || len(r.FieldErrors) != 2 {
		t.Errorf("restricted: %+v", r)
	}
	for k, v := range map[string]string{"vcpus": "0", "memory_mb": "10", "vcpus_max": "x", "boot": "hd,hd", "cpu_mode": "custom:Icelake-Server",
		"on_crash": "explode", "disk0": "source=/etc/shadow", "cdrom0": "source=/root/x.iso", "net0": "model=virtio,network=nope",
		"name": "a b", "disk5": "new=1G"} {
		if r := call("web", proto.ManageRequest{Op: proto.OpConfigSet, Set: map[string]string{k: v}}); r.Code != proto.CodeInvalidValue || r.FieldErrors[k] == "" {
			t.Errorf("%s=%s: %+v", k, v, r)
		}
	}
}

func TestLibvirtDisks(t *testing.T) {
	f, call := newLvTest(t)
	// A stopped VM: a new disk, then detach it (the file stays).
	r := call("db", proto.ManageRequest{Op: proto.OpConfigSet, Set: map[string]string{"disk2": "new=8G,storage=default"}})
	if !r.OK {
		t.Fatalf("new disk: %+v", r)
	}
	c := call("db", proto.ManageRequest{Op: proto.OpConfigGet}).Config
	if !strings.HasPrefix(c.Values["disk2"], "source=/var/lib/libvirt/images/db-vdc.qcow2,bus=virtio,format=qcow2,target=vdc,size=8589934592") {
		t.Fatalf("disk2 = %q", c.Values["disk2"])
	}
	if !slices.Contains(c.Restricted, "disk1") {
		t.Errorf("the whole-disk passthrough is not restricted: %v", c.Restricted)
	}
	if r := call("db", proto.ManageRequest{Op: proto.OpConfigSet, Delete: []string{"disk2"}}); !r.OK {
		t.Fatalf("detach: %+v", r)
	}
	if _, _, _, ok := f.File(lvImages + "/db-vdc.qcow2"); !ok {
		t.Error("detaching deleted the file")
	}
	// Attach it again by pool/volume.
	if r := call("db", proto.ManageRequest{Op: proto.OpConfigSet, Set: map[string]string{"disk2": "source=default/db-vdc.qcow2,bus=sata"}}); !r.OK {
		t.Fatalf("attach: %+v", r)
	}
	// Another VM's disk is refused.
	if r := call("db", proto.ManageRequest{Op: proto.OpConfigSet, Set: map[string]string{"disk3": "source=default/web.qcow2"}}); r.Code != proto.CodeInvalidValue {
		t.Errorf("shared disk: %+v", r)
	}
	// Grow: stopped through the volume, running through QEMU.
	if r := call("db", proto.ManageRequest{Op: proto.OpDiskResize, Disk: "disk0", Size: "+5G"}); !r.OK {
		t.Fatalf("resize stopped: %+v", r)
	}
	if _, capacity, _, _ := f.File(lvImages + "/db.img"); capacity != 15<<30 {
		t.Errorf("db.img = %d", capacity)
	}
	if r := call("web", proto.ManageRequest{Op: proto.OpDiskResize, Disk: "vda", Size: "30G"}); !r.OK || !strings.Contains(strings.Join(f.Calls, "\n"), "DomainBlockResize vda 32212254720") {
		t.Fatalf("resize running: %+v", r)
	}
	if r := call("web", proto.ManageRequest{Op: proto.OpDiskResize, Disk: "disk0", Size: "10G"}); r.Code != proto.CodeInvalidValue {
		t.Errorf("shrink: %+v", r)
	}
	if r := call("db", proto.ManageRequest{Op: proto.OpDiskResize, Disk: "disk1", Size: "+1G"}); r.Code != proto.CodeNotAllowed {
		t.Errorf("passthrough resize: %+v", r)
	}
}

func TestLibvirtCreate(t *testing.T) {
	f, call := newLvTest(t)
	ch := call("", proto.ManageRequest{Op: proto.OpChoices})
	if !ch.OK || ch.Choices.Firmware == nil || !ch.Choices.Firmware.TPM || !slices.Contains(ch.Choices.Networks, "default") ||
		!slices.Contains(ch.Choices.Bridges, "br0") || len(ch.Choices.ISOs) != 1 || ch.Choices.ISOs[0].Volume != "default/debian-13.iso" ||
		len(ch.Choices.OSVariants) != 11 || ch.Choices.Storages[0].ID != "default" {
		t.Fatalf("choices: %+v", ch.Choices)
	}
	r := call("", proto.ManageRequest{Op: proto.OpCreate, Kind: "vm", Name: "win11", OSVariant: "win11", ISO: "default/debian-13.iso",
		DiskGB: 64, Storage: "default", Network: "default", Start: true, Set: map[string]string{"memory_mb": "8192", "vcpus": "4", "description": "Gaming"}})
	if !r.OK || r.NewID != "win11" {
		t.Fatalf("create: %+v", r)
	}
	d := f.Domains()
	var win lvfake.DomainInfo
	for _, x := range d {
		if x.Name == "win11" {
			win = x
		}
	}
	if !win.Running {
		t.Error("not started")
	}
	for _, w := range []string{"<os firmware='efi'>", "name='secure-boot'", "<smm state='on'/>", "<tpm model='tpm-crb'><backend type='emulator' version='2.0'/>",
		"<target dev='sda' bus='sata'/>", "<model type='e1000e'/>", "<source file='/var/lib/libvirt/images/debian-13.iso'/>", "<boot dev='cdrom'/><boot dev='hd'/>",
		"http://microsoft.com/win/11", "<hyperv mode='custom'>", "<memory unit='KiB'>8388608</memory>", "<vcpu placement='static'>4</vcpu>",
		"<description>Gaming</description>", "listen='127.0.0.1'"} {
		if !strings.Contains(win.XML, w) {
			t.Errorf("win11 XML lacks %q", w)
		}
	}
	if _, capacity, format, ok := f.File(lvImages + "/win11-sda.qcow2"); !ok || capacity != 64<<30 || format != "qcow2" {
		t.Errorf("disk: %d %s %v (%v)", capacity, format, ok, f.Paths(lvImages))
	}
	if r := call("", proto.ManageRequest{Op: proto.OpCreate, Name: "win11", OSVariant: "win11"}); r.Code != proto.CodeExists {
		t.Errorf("taken name: %+v", r)
	}
	// Without a TPM emulator Windows 11 is refused in plain words.
	f.DomCaps = `<domainCapabilities><vcpu max='64'/><os supported='yes'><enum name='firmware'><value>efi</value></enum></os></domainCapabilities>`
	if r := call("", proto.ManageRequest{Op: proto.OpCreate, Name: "w2", OSVariant: "win11"}); r.Code != proto.CodeInvalidValue ||
		!strings.Contains(r.FieldErrors["os_variant"], "swtpm") {
		t.Errorf("win11 without TPM: %+v", r)
	}
	// A Linux VM on a bridge with the defaults, no disk asked: the
	// variant's default disk is not made, only with storage or disk_gb.
	if r := call("", proto.ManageRequest{Op: proto.OpCreate, Name: "deb", OSVariant: "debian13", Bridge: "br0", DiskGB: 16}); !r.OK {
		t.Fatalf("debian: %+v", r)
	}
	if c := call("deb", proto.ManageRequest{Op: proto.OpConfigGet}).Config; c.Values["net0"] == "" || !strings.Contains(c.Values["net0"], "bridge=br0") ||
		!strings.Contains(c.Values["disk0"], "size=17179869184") || c.Values["memory_mb"] != "2048" {
		t.Errorf("debian config: %v", c.Values)
	}
	for field, req := range map[string]proto.ManageRequest{
		"name":       {Op: proto.OpCreate, Name: "-x"},
		"os_variant": {Op: proto.OpCreate, Name: "x", OSVariant: "beos"},
		"storage":    {Op: proto.OpCreate, Name: "x", Storage: "nope", DiskGB: 1},
		"iso":        {Op: proto.OpCreate, Name: "x", ISO: "/etc/passwd"},
		"network":    {Op: proto.OpCreate, Name: "x", Network: "nope"},
	} {
		if r := call("", req); r.Code != proto.CodeInvalidValue || r.FieldErrors[field] == "" {
			t.Errorf("%s: %+v", field, r)
		}
	}
}

func TestLibvirtCloneRenameDelete(t *testing.T) {
	f, call := newLvTest(t)
	if r := call("web", proto.ManageRequest{Op: proto.OpClone, Name: "web2"}); r.Code != proto.CodeGuestRunning {
		t.Errorf("clone running: %+v", r)
	}
	if r := call("db", proto.ManageRequest{Op: proto.OpClone, Name: "db2"}); r.Code != proto.CodeNotAllowed {
		t.Errorf("clone with a passthrough disk: %+v", r)
	}
	if r := call("db", proto.ManageRequest{Op: proto.OpConfigSet, Delete: []string{"disk1"}}); r.Code != proto.CodeNotAllowed {
		t.Errorf("detach a passthrough disk: %+v", r)
	}
	// Without the passthrough disk it clones.
	if err := f.AddDomain(strings.Replace(dbXML, "<disk type='block' device='disk'><driver name='qemu' type='raw'/><source dev='/dev/disk/by-id/ata-HDD'/><target dev='vdb' bus='virtio'/></disk>", "", 1), false); err != nil {
		t.Fatal(err)
	}
	r := call("db", proto.ManageRequest{Op: proto.OpClone, Name: "db2"})
	if r.NewID != "db2" {
		t.Fatalf("clone: %+v", r)
	}
	if st := waitTask(t, call, r); st.Status != "ok" || st.GuestID != "db2" || st.Type != "qmclone" {
		t.Fatalf("clone task: %+v", st)
	}
	var orig, clone string
	for _, d := range f.Domains() {
		switch d.Name {
		case "db":
			orig = d.XML
		case "db2":
			clone = d.XML
		}
	}
	if clone == "" || strings.Contains(clone, "aaaaaaaa-2222") || strings.Contains(clone, "52:54:00:aa:bb:02") ||
		!strings.Contains(clone, "/var/lib/libvirt/images/db2-vda.qcow2") || !strings.Contains(clone, "<driver name='qemu' type='qcow2'/>") ||
		!strings.Contains(orig, "db.img") {
		t.Errorf("clone XML:\n%s", clone)
	}
	if !strings.Contains(clone, "/var/lib/libvirt/qemu/nvram/") || strings.Contains(clone, "db_VARS.fd</nvram>") {
		t.Errorf("clone NVRAM: %s", clone)
	}
	// Rename (stopped), refused with snapshots.
	if r := call("db2", proto.ManageRequest{Op: proto.OpRename, Name: "db3"}); !r.OK || r.NewID != "db3" {
		t.Fatalf("rename: %+v", r)
	}
	f.SetSnapshots("db3", 1)
	if r := call("db3", proto.ManageRequest{Op: proto.OpRename, Name: "db4"}); r.Code != proto.CodeNotAllowed {
		t.Errorf("rename with snapshots: %+v", r)
	}
	f.SetSnapshots("db3", 0)
	if r := call("web", proto.ManageRequest{Op: proto.OpRename, Name: "web9"}); r.Code != proto.CodeGuestRunning {
		t.Errorf("rename running: %+v", r)
	}
	// Delete with its disks and NVRAM; another VM's files stay.
	if r := call("db3", proto.ManageRequest{Op: proto.OpDelete, Purge: true}); !r.OK {
		t.Fatalf("delete: %+v", r)
	}
	if _, _, _, ok := f.File(lvImages + "/db3-vda.qcow2"); ok {
		t.Error("purge kept the disk")
	}
	if _, _, _, ok := f.File(lvImages + "/db.img"); !ok {
		t.Error("purge deleted another VM's disk")
	}
	// Without purge the disk stays.
	if r := call("db", proto.ManageRequest{Op: proto.OpDelete}); !r.OK {
		t.Fatalf("delete: %+v", r)
	}
	if _, _, _, ok := f.File(lvImages + "/db.img"); !ok {
		t.Error("delete without purge removed the disk")
	}
	if _, _, _, ok := f.File("/var/lib/libvirt/qemu/nvram/db_VARS.fd"); !ok {
		t.Error("delete without purge removed the NVRAM")
	}
	if r := call("web", proto.ManageRequest{Op: proto.OpDelete, Purge: true}); r.Code != proto.CodeGuestRunning {
		t.Errorf("delete running: %+v", r)
	}
}

func TestLibvirtBackups(t *testing.T) {
	f, call := newLvTest(t)
	const dir = lvImages + "/.whombat-backups"
	// Running: libvirt's backup job.
	r := call("web", proto.ManageRequest{Op: proto.OpBackupCreate, Notes: "before the upgrade", Compress: "zstd"})
	st := waitTask(t, call, r)
	if st.Status != "ok" || st.Type != "vzdump" || !strings.Contains(strings.Join(st.Log, "\n"), "backup job") {
		t.Fatalf("backup task: %+v", st)
	}
	files := f.Paths(dir + "/web/")
	if len(files) != 3 || !strings.HasSuffix(files[0], "/backup.json") || !strings.HasSuffix(files[1], "/domain.xml") || !strings.HasSuffix(files[2], "/vda.qcow2") {
		t.Fatalf("backup files: %v", files)
	}
	// Stopped: the disk files are copied (UEFI variables too).
	if st := waitTask(t, call, call("db", proto.ManageRequest{Op: proto.OpBackupCreate})); st.Status != "ok" {
		t.Fatalf("backup db: %+v", st)
	}
	if n := len(f.Paths(dir + "/db/")); n != 4 {
		t.Errorf("db backup files: %v", f.Paths(dir+"/db/"))
	}
	l := call("web", proto.ManageRequest{Op: proto.OpBackupList})
	if !l.OK || len(l.Backups) != 1 {
		t.Fatalf("backup.list: %+v", l)
	}
	b := l.Backups[0]
	if b.Storage != "libvirt" || b.GuestID != "web" || b.Format != "qcow2" || b.Notes != "before the upgrade" || b.SizeBytes < 3<<30 {
		t.Errorf("backup = %+v", b)
	}
	if all := call("", proto.ManageRequest{Op: proto.OpBackupList}); len(all.Backups) != 2 {
		t.Errorf("every backup: %+v", all.Backups)
	}
	// Restore as a new VM.
	r = call("", proto.ManageRequest{Op: proto.OpBackupRestore, GuestID: "web", Volume: b.Volume, Name: "web-old", Start: true})
	if r.NewID != "web-old" {
		t.Fatalf("restore: %+v", r)
	}
	if st := waitTask(t, call, r); st.Status != "ok" {
		t.Fatalf("restore task: %+v", st)
	}
	var restored lvfake.DomainInfo
	for _, d := range f.Domains() {
		if d.Name == "web-old" {
			restored = d
		}
	}
	if !restored.Running || strings.Contains(restored.XML, "11111111-2222") || strings.Contains(restored.XML, "52:54:00:aa:bb:01") ||
		!strings.Contains(restored.XML, lvImages+"/web-old-vda.qcow2") {
		t.Errorf("restored:\n%s", restored.XML)
	}
	if r := call("", proto.ManageRequest{Op: proto.OpBackupRestore, GuestID: "web", Volume: b.Volume, Name: "web-old"}); r.Code != proto.CodeExists {
		t.Errorf("restore over a taken name: %+v", r)
	}
	if r := call("", proto.ManageRequest{Op: proto.OpBackupRestore, GuestID: "web", Volume: "../../etc"}); r.Code != proto.CodeInvalidValue {
		t.Errorf("bad volume: %+v", r)
	}
	// The backups of a deleted VM still restore and delete.
	if r := call("", proto.ManageRequest{Op: proto.OpBackupDelete, GuestID: "web", Volume: b.Volume}); !r.OK {
		t.Fatalf("backup.delete: %+v", r)
	}
	if left := f.Paths(dir + "/web/"); len(left) != 0 || f.Exists(dir+"/web") {
		t.Errorf("left after delete: %v", left)
	}
	if r := call("", proto.ManageRequest{Op: proto.OpBackupDelete, GuestID: "web", Volume: b.Volume}); r.Code != proto.CodeNotFound {
		t.Errorf("delete twice: %+v", r)
	}
	// Stop aborts libvirt's backup job.
	f.BackupTime = time.Hour
	r = call("web", proto.ManageRequest{Op: proto.OpBackupCreate})
	time.Sleep(50 * time.Millisecond)
	if s := call("", proto.ManageRequest{Op: proto.OpTaskStop, Task: r.Task.ID}); !s.OK {
		t.Fatalf("task.stop: %+v", s)
	}
	if st := waitTask(t, call, r); st.Status != "error" || st.Message != "Stopped." {
		t.Errorf("stopped backup: %+v", st)
	}
	if left := f.Paths(dir + "/web/"); len(left) != 0 {
		t.Errorf("a stopped backup left %v", left)
	}
	tl := call("web", proto.ManageRequest{Op: proto.OpTaskList})
	if !tl.OK || len(tl.Tasks) != 2 || tl.Tasks[0].ID != r.Task.ID {
		t.Errorf("task.list: %+v", tl.Tasks)
	}
}

func TestLibvirtHostOps(t *testing.T) {
	f, call := newLvTest(t)
	// Volumes.
	if r := call("", proto.ManageRequest{Op: proto.OpVolumeCreate, Pool: "default", Name: "data.qcow2", Size: "10G"}); !r.OK {
		t.Fatalf("volume.create: %+v", r)
	}
	if r := call("", proto.ManageRequest{Op: proto.OpVolumeResize, Pool: "default", Volume: "data.qcow2", Size: "+2G"}); !r.OK {
		t.Fatalf("volume.resize: %+v", r)
	}
	if _, capacity, _, _ := f.File(lvImages + "/data.qcow2"); capacity != 12<<30 {
		t.Errorf("data.qcow2 = %d", capacity)
	}
	if r := call("", proto.ManageRequest{Op: proto.OpVolumeDelete, Pool: "default", Volume: "web.qcow2"}); r.Code != proto.CodeInUse {
		t.Errorf("delete a used volume: %+v", r)
	}
	if r := call("", proto.ManageRequest{Op: proto.OpVolumeResize, Pool: "default", Volume: "web.qcow2", Size: "+1G"}); r.Code != proto.CodeInUse {
		t.Errorf("grow a running VM's volume: %+v", r)
	}
	if r := call("", proto.ManageRequest{Op: proto.OpVolumeDelete, Pool: "default", Volume: "data.qcow2"}); !r.OK {
		t.Fatalf("volume.delete: %+v", r)
	}
	imgs := call("", proto.ManageRequest{Op: proto.OpContentList, Storage: "default", Content: "images"})
	if !imgs.OK || len(imgs.Content) != 2 || imgs.Content[1].Name != "web.qcow2" || !slices.Equal(imgs.Content[1].UsedBy, []string{"web"}) ||
		imgs.Content[1].Format != "qcow2" || imgs.Content[1].SizeBytes != 20<<30 {
		t.Errorf("images: %+v", imgs.Content)
	}
	// ISOs: download (checksum checked), list, delete (not while used).
	iso := []byte("debian netinst")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write(iso) }))
	defer srv.Close()
	sum := sha256.Sum256(iso)
	r := call("", proto.ManageRequest{Op: proto.OpContentDownload, Storage: "default", Content: "iso", URL: srv.URL + "/x.iso",
		Filename: "netinst.iso", Checksum: hex.EncodeToString(sum[:]), ChecksumAlgorithm: "sha256"})
	if st := waitTask(t, call, r); st.Status != "ok" {
		t.Fatalf("download: %+v", st)
	}
	if data, _, _, _ := f.File(lvImages + "/netinst.iso"); string(data) != string(iso) {
		t.Errorf("downloaded %q", data)
	}
	r = call("", proto.ManageRequest{Op: proto.OpContentDownload, Storage: "default", URL: srv.URL + "/x.iso", Filename: "bad.iso",
		Checksum: strings.Repeat("0", 64), ChecksumAlgorithm: "sha256"})
	if st := waitTask(t, call, r); st.Status != "error" || f.Exists(lvImages+"/bad.iso") {
		t.Errorf("bad checksum: %+v", st)
	}
	if l := call("", proto.ManageRequest{Op: proto.OpContentList, Storage: "default", Content: "iso"}); len(l.Content) != 2 {
		t.Errorf("isos: %+v", l.Content)
	}
	call("web", proto.ManageRequest{Op: proto.OpConfigSet, Set: map[string]string{"cdrom0": "source=default/netinst.iso"}})
	if r := call("", proto.ManageRequest{Op: proto.OpContentDelete, Volume: "default/netinst.iso"}); r.Code != proto.CodeInUse {
		t.Errorf("delete a used ISO: %+v", r)
	}
	if r := call("", proto.ManageRequest{Op: proto.OpContentDelete, Volume: "default/debian-13.iso"}); !r.OK || f.Exists(lvImages+"/debian-13.iso") {
		t.Errorf("content.delete: %+v", r)
	}
	if r := call("", proto.ManageRequest{Op: proto.OpContentDelete, Volume: "default/web.qcow2"}); r.Code != proto.CodeInvalidValue {
		t.Errorf("delete a disk as content: %+v", r)
	}
	// Leases and the log.
	le := call("", proto.ManageRequest{Op: proto.OpNetworkLeases, Network: "default"})
	if !le.OK || len(le.Leases) != 1 || le.Leases[0].GuestID != "web" || le.Leases[0].Address != "192.168.122.10" {
		t.Errorf("leases: %+v", le)
	}
	lg := call("web", proto.ManageRequest{Op: proto.OpLogGet, Lines: 2})
	if !lg.OK || lg.Log.File != "/var/log/libvirt/qemu/web.log" || strings.Join(lg.Log.Lines, "|") != "line 2|line 3" {
		t.Errorf("log: %+v", lg.Log)
	}
	if lg := call("db", proto.ManageRequest{Op: proto.OpLogGet}); !lg.OK || len(lg.Log.Lines) != 0 {
		t.Errorf("no log: %+v", lg)
	}
}

// TestLibvirtUnraid: BlackBox-like: no pools, the VM Manager's folders.
func TestLibvirtUnraid(t *testing.T) {
	f := lvfake.New()
	f.AddFile("/boot/config/domain.cfg", []byte("DOMAINDIR=\"/mnt/user/domains/\"\nMEDIADIR=\"/mnt/user/isos/\"\n"))
	f.AddFile("/mnt/user/isos/Win11_24H2.iso", []byte("ISO"))
	f.AddDisk("/mnt/user/domains/pbs/vdisk1.img", "raw", 32<<30, 5<<30)
	fake := broker.NewLibvirtManager(func() (broker.LibvirtConn, error) { return f, nil }, f, "")
	// The fake has a "default" pool; unRAID has none.
	_ = f.StoragePoolDestroy(mustPool(t, f, "default"))
	call := func(g string, req proto.ManageRequest) proto.ManageResponse {
		req.Platform = proto.PlatformLibvirt
		var guest *proto.Guest
		if g != "" {
			guest = &proto.Guest{ID: g}
			req.GuestID = g
		}
		return fake.Manage(context.Background(), guest, req)
	}
	ch := call("", proto.ManageRequest{Op: proto.OpChoices}).Choices
	var ids []string
	for _, s := range ch.Storages {
		ids = append(ids, s.ID)
	}
	if !slices.Equal(ids, []string{"folder:domains", "folder:isos"}) || len(ch.ISOs) != 1 || ch.ISOs[0].Volume != "/mnt/user/isos/Win11_24H2.iso" {
		t.Fatalf("choices: %v %+v", ids, ch.ISOs)
	}
	r := call("", proto.ManageRequest{Op: proto.OpCreate, Name: "win11", OSVariant: "win11", Storage: "folder:domains", DiskGB: 64,
		ISO: "/mnt/user/isos/Win11_24H2.iso", Bridge: "br0"})
	if !r.OK {
		t.Fatalf("create on unRAID: %+v", r)
	}
	if _, capacity, _, ok := f.File("/mnt/user/domains/win11/vdisk1.qcow2"); !ok || capacity != 64<<30 {
		t.Errorf("vdisk: %v", f.Paths("/mnt/user/domains"))
	}
	var x string
	for _, d := range f.Domains() {
		if d.Name == "win11" {
			x = d.XML
		}
	}
	if !strings.Contains(x, "<vmtemplate xmlns='http://unraid' name='Windows 11' icon='windows11.png' os='windows11'/>") {
		t.Errorf("no unRAID template: %s", x)
	}
	if r := call("win11", proto.ManageRequest{Op: proto.OpBackupCreate}); waitTask(t, call, r).Status != "ok" {
		t.Fatal("backup on unRAID")
	}
	if l := call("win11", proto.ManageRequest{Op: proto.OpBackupList}); len(l.Backups) != 1 {
		t.Errorf("unRAID backups: %+v", l)
	}
	if !f.Exists("/mnt/user/domains/.whombat-backups/win11") {
		t.Errorf("backups folder: %v", f.Paths("/mnt/user/domains/.whombat-backups"))
	}
	if r := call("win11", proto.ManageRequest{Op: proto.OpDelete, Purge: true}); !r.OK || f.Exists("/mnt/user/domains/win11") {
		t.Errorf("purge on unRAID: %+v %v", r, f.Paths("/mnt/user/domains/win11"))
	}
	det, err := broker.ReadLibvirtDetail(f, f, "")
	if err != nil || det.Folders == nil || det.Folders.Domains != "/mnt/user/domains" || det.BackupsDir != "/mnt/user/domains/.whombat-backups" ||
		!det.Firmware.UEFI || det.QEMU != "10.0.13" {
		t.Errorf("detail: %+v %v", det, err)
	}
}

func mustPool(t *testing.T, f *lvfake.Fake, name string) libvirt.StoragePool {
	t.Helper()
	r, err := f.StoragePoolLookupByName(name)
	if err != nil {
		t.Fatal(err)
	}
	return r
}
