package broker_test

import (
	"context"
	"os"
	"slices"
	"strings"
	"testing"
	"time"

	libvirt "github.com/digitalocean/go-libvirt"
	"github.com/digitalocean/go-libvirt/socket/dialers"

	"rackoon/internal/agent/broker"
	"rackoon/internal/proto"
)

// TestLibvirtLive runs the libvirt manager against a real libvirtd (with
// QEMU/KVM, OVMF and swtpm): create, configuration with live changes, the
// CD/DVD, a new disk and growing one, a snapshot, a backup of the running
// VM, restore as new, clone, rename, delete — and a Windows 11 VM with
// UEFI, Secure Boot and a TPM. Throwaway VMs are called wbt-*; run it only
// in a test VM (the maintainers' test environment): WHOMBAT_TEST_LIBVIRT=1.
func TestLibvirtLive(t *testing.T) {
	if os.Getenv("WHOMBAT_TEST_LIBVIRT") != "1" {
		t.Skip("set WHOMBAT_TEST_LIBVIRT=1 in a throwaway VM with libvirt")
	}
	dial := func() (broker.LibvirtConn, error) {
		l := libvirt.NewWithDialer(dialers.NewLocal(dialers.WithSocket("/run/libvirt/libvirt-sock"), dialers.WithLocalTimeout(10*time.Second)))
		if err := l.ConnectToURI(libvirt.QEMUSystem); err != nil {
			return nil, err
		}
		return l, nil
	}
	conn, err := dial()
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Disconnect()
	lv := conn.(*libvirt.Libvirt)
	m := broker.NewLibvirtManager(dial, broker.OSLibvirtFS(), "")
	call := func(g string, req proto.ManageRequest) proto.ManageResponse {
		t.Helper()
		req.Platform = proto.PlatformLibvirt
		var guest *proto.Guest
		if g != "" {
			guest = &proto.Guest{ID: g, Name: g, Kind: "vm"}
			req.GuestID = g
		}
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer cancel()
		r := m.Manage(ctx, guest, req)
		t.Logf("%s %s → ok=%v code=%s %s", req.Op, g, r.OK, r.Code, r.Message)
		return r
	}
	wait := func(r proto.ManageResponse) proto.TaskStatus {
		t.Helper()
		if !r.OK || r.Task == nil {
			t.Fatalf("no task: %+v", r)
		}
		for i := 0; i < 600; i++ {
			s := call("", proto.ManageRequest{Op: proto.OpTaskStatus, Task: r.Task.ID, LogStart: 0})
			if s.TaskStatus != nil && s.TaskStatus.Status != "running" {
				for _, l := range s.TaskStatus.Log {
					t.Logf("  | %s", l)
				}
				return *s.TaskStatus
			}
			time.Sleep(time.Second)
		}
		t.Fatalf("task %s did not end", r.Task.ID)
		return proto.TaskStatus{}
	}
	cleanup := func() {
		for _, n := range []string{"wbt-vm1", "wbt-vm1-restored", "wbt-vm2", "wbt-vm3", "wbt-win11"} {
			if d, err := lv.DomainLookupByName(n); err == nil {
				_ = lv.DomainDestroy(d)
				call(n, proto.ManageRequest{Op: proto.OpDelete, Purge: true})
			}
		}
		if p, err := lv.StoragePoolLookupByName("default"); err == nil {
			if v, err := lv.StorageVolLookupByName(p, "wbt.iso"); err == nil {
				_ = lv.StorageVolDelete(v, 0)
			}
		}
		for _, b := range call("", proto.ManageRequest{Op: proto.OpBackupList}).Backups {
			if strings.HasPrefix(b.GuestID, "wbt-") {
				call("", proto.ManageRequest{Op: proto.OpBackupDelete, GuestID: b.GuestID, Volume: b.Volume})
			}
		}
	}
	cleanup()
	defer cleanup()

	det, err := broker.ReadLibvirtDetail(conn, broker.OSLibvirtFS(), "")
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("detail: QEMU %s, pools %d, networks %d, firmware %+v, backups %s", det.QEMU, len(det.Pools), len(det.Networks), det.Firmware, det.BackupsDir)
	if !det.Firmware.UEFI || !det.Firmware.TPM || det.BackupsDir == "" {
		t.Fatalf("detail: %+v", det)
	}
	ch := call("", proto.ManageRequest{Op: proto.OpChoices}).Choices
	if ch == nil || !slices.Contains(ch.Networks, "default") || len(ch.OSVariants) == 0 {
		t.Fatalf("choices: %+v", ch)
	}

	// An "ISO" to insert (an empty raw file is enough for QEMU).
	if r := call("", proto.ManageRequest{Op: proto.OpVolumeCreate, Pool: "default", Name: "wbt.iso", Size: "1M", Format: "raw"}); !r.OK {
		t.Fatal(r)
	}
	if r := call("", proto.ManageRequest{Op: proto.OpCreate, Kind: "vm", Name: "wbt-vm1", OSVariant: "debian13", DiskGB: 1, Storage: "default",
		Network: "default", ISO: "default/wbt.iso", Start: true, Set: map[string]string{"memory_mb": "512", "memory_max_mb": "1024", "vcpus": "1", "vcpus_max": "2"}}); !r.OK {
		t.Fatalf("create: %+v", r)
	}
	c := call("wbt-vm1", proto.ManageRequest{Op: proto.OpConfigGet}).Config
	if c == nil || !c.Running || c.Values["memory_mb"] != "512" || !strings.Contains(c.Values["disk0"], "size=1073741824") {
		t.Fatalf("config: %+v", c)
	}
	t.Logf("values: %v", c.Values)
	// Live: memory, vCPUs, title, the CD/DVD, the link; the boot order waits.
	r := call("wbt-vm1", proto.ManageRequest{Op: proto.OpConfigSet, Digest: c.Digest, Set: map[string]string{
		"memory_mb": "768", "vcpus": "2", "title": "Whombat live test", "cdrom0": "source=empty",
		"net0": "model=virtio,network=default,link=down", "boot": "hd,cdrom"}})
	if !r.OK {
		t.Fatalf("config.set: %+v", r)
	}
	for _, ch := range r.Changes {
		t.Logf("  change %s: %q → %q pending=%v", ch.Key, ch.Old, ch.New, ch.Pending)
	}
	live, _ := lv.DomainLookupByName("wbt-vm1")
	lx, _ := lv.DomainGetXMLDesc(live, 0)
	for _, w := range []string{"<link state='down'/>", "<title>Whombat live test</title>"} {
		if !strings.Contains(lx, w) {
			t.Errorf("live XML lacks %q", w)
		}
	}
	if c := call("wbt-vm1", proto.ManageRequest{Op: proto.OpConfigGet}).Config; c.Pending["boot"] != "hd,cdrom" || c.Values["memory_mb"] != "768" ||
		c.Values["vcpus"] != "2" || c.Pending["memory_mb"] != "" || c.Pending["vcpus"] != "" {
		t.Errorf("after the live change: values %v pending %v", c.Values, c.Pending)
	}
	if strings.Contains(lx, "wbt.iso") {
		t.Error("the CD/DVD was not ejected at once")
	}
	// Insert it again; a new disk (waits for the restart); grow the first
	// one live.
	if r := call("wbt-vm1", proto.ManageRequest{Op: proto.OpConfigSet, Set: map[string]string{"cdrom0": "source=default/wbt.iso", "disk1": "new=1G,storage=default"}}); !r.OK {
		t.Fatalf("eject / new disk: %+v", r)
	}
	if r := call("wbt-vm1", proto.ManageRequest{Op: proto.OpDiskResize, Disk: "disk0", Size: "+1G"}); !r.OK {
		t.Fatalf("grow live: %+v", r)
	}
	lx, _ = lv.DomainGetXMLDesc(live, 0)
	if !strings.Contains(lx, "wbt.iso") {
		t.Error("the CD/DVD was not inserted at once")
	}
	if c := call("wbt-vm1", proto.ManageRequest{Op: proto.OpConfigGet}).Config; !strings.Contains(c.Values["disk0"], "size=2147483648") || c.Pending["disk1"] == "" {
		t.Errorf("after grow / new disk: values %v pending %v", c.Values, c.Pending)
	}
	// A snapshot (internal, with the RAM).
	if _, err := lv.DomainSnapshotCreateXML(live, "<domainsnapshot><name>wbt-snap</name></domainsnapshot>", 0); err != nil {
		t.Errorf("snapshot: %v", err)
	} else if s, err := lv.DomainSnapshotLookupByName(live, "wbt-snap", 0); err == nil {
		_ = lv.DomainSnapshotDelete(s, 0)
	}
	// A backup while it runs, then restore it as a new VM.
	st := wait(call("wbt-vm1", proto.ManageRequest{Op: proto.OpBackupCreate, Notes: "live test"}))
	if st.Status != "ok" {
		t.Fatalf("backup: %+v", st)
	}
	bl := call("wbt-vm1", proto.ManageRequest{Op: proto.OpBackupList}).Backups
	if len(bl) != 1 || bl[0].SizeBytes == 0 {
		t.Fatalf("backups: %+v", bl)
	}
	if st := wait(call("", proto.ManageRequest{Op: proto.OpBackupRestore, GuestID: "wbt-vm1", Volume: bl[0].Volume, Name: "wbt-vm1-restored"})); st.Status != "ok" {
		t.Fatalf("restore: %+v", st)
	}
	// Clone (stopped), rename, delete.
	if err := lv.DomainDestroy(live); err != nil {
		t.Fatal(err)
	}
	if st := wait(call("wbt-vm1", proto.ManageRequest{Op: proto.OpClone, Name: "wbt-vm2"})); st.Status != "ok" {
		t.Fatalf("clone: %+v", st)
	}
	if r := call("wbt-vm2", proto.ManageRequest{Op: proto.OpRename, Name: "wbt-vm3"}); !r.OK {
		t.Fatalf("rename: %+v", r)
	}
	c1 := call("wbt-vm1", proto.ManageRequest{Op: proto.OpConfigGet}).Config
	c3 := call("wbt-vm3", proto.ManageRequest{Op: proto.OpConfigGet}).Config
	if c1 == nil || c3 == nil || c1.Values["net0"] == c3.Values["net0"] || len(c3.Disks) < 2 {
		t.Errorf("clone config: %v / %v", c1, c3)
	}
	t.Logf("disk1 after the restart-only change: %s", c1.Values["disk1"])
	// Windows 11: UEFI, Secure Boot and a TPM; it must start.
	if r := call("", proto.ManageRequest{Op: proto.OpCreate, Name: "wbt-win11", OSVariant: "win11", DiskGB: 1, Storage: "default",
		Network: "default", Start: true, Set: map[string]string{"memory_mb": "1024", "memory_max_mb": "1024"}}); !r.OK {
		t.Fatalf("win11: %+v", r)
	}
	wd, _ := lv.DomainLookupByName("wbt-win11")
	wx, _ := lv.DomainGetXMLDesc(wd, 0)
	for _, w := range []string{"<tpm model='tpm-crb'>", "secure-boot", "OVMF", "<smm state='on'/>"} {
		if !strings.Contains(wx, w) {
			t.Errorf("win11 XML lacks %q", w)
		}
	}
	_ = lv.DomainDestroy(wd)
	for _, n := range []string{"wbt-vm1", "wbt-vm1-restored", "wbt-vm3", "wbt-win11"} {
		if r := call(n, proto.ManageRequest{Op: proto.OpDelete, Purge: true}); !r.OK {
			t.Errorf("delete %s: %+v", n, r)
		}
	}
	if r := call("", proto.ManageRequest{Op: proto.OpBackupDelete, GuestID: "wbt-vm1", Volume: bl[0].Volume}); !r.OK {
		t.Errorf("backup.delete: %+v", r)
	}
	pools, _, _ := lv.ConnectListAllStoragePools(1, 0)
	for _, p := range pools {
		if strings.HasPrefix(p.Name, "whombat-tmp-") {
			t.Errorf("transient pool left: %s", p.Name)
		}
	}
	if p, err := lv.StoragePoolLookupByName("default"); err == nil {
		_ = lv.StoragePoolRefresh(p, 0)
		vols, _, _ := lv.StoragePoolListAllVolumes(p, 1, 0)
		for _, v := range vols {
			if strings.HasPrefix(v.Name, "wbt-") {
				t.Errorf("volume left: %s", v.Name)
			}
		}
	}
}
