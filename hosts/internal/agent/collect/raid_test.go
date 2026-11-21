package collect

import (
	"context"
	"strings"
	"testing"
	"time"

	"rackoon/internal/proto"
)

func TestParseMdstat(t *testing.T) {
	mds := parseMdstat(readTestdata(t, "mdstat"))
	if len(mds) != 6 {
		t.Fatalf("arrays: %+v", mds)
	}
	a := map[string]proto.RAIDArray{}
	r := fsRoot(t.TempDir()) // no sysfs: everything from mdstat
	for _, md := range mds {
		a[md.Name] = mdArray(r, md)
	}
	if x := a["md127"]; x.Level != "raid1" || x.State != "clean" || x.Devices != 2 || x.Active != 2 || x.SizeBytes != 33520640*1024 ||
		strings.Join(x.Members, ",") != "nvme0n1p2,nvme1n1p2" || len(x.Failed) != 0 || x.SyncPct != nil {
		t.Errorf("md127: %+v", x)
	}
	if x := a["md1"]; x.State != "degraded" || x.Devices != 4 || x.Active != 3 || strings.Join(x.Failed, ",") != "sdd1" {
		t.Errorf("md1: %+v", x)
	}
	if x := a["md2"]; x.State != "recovering" || x.SyncPct == nil || *x.SyncPct != 17.3 || x.Active != 1 {
		t.Errorf("md2: %+v", x)
	}
	if x := a["md3"]; x.State != "checking" || x.SyncPct == nil || *x.SyncPct != 8.5 {
		t.Errorf("md3: %+v", x)
	}
	if x := a["md4"]; x.State != "inactive" || len(x.Members) != 2 {
		t.Errorf("md4: %+v", x)
	}
	// A slot without any member is a missing device.
	if x := a["md5"]; x.State != "degraded" || strings.Join(x.Failed, ",") != "missing (slot 1)" {
		t.Errorf("md5: %+v", x)
	}
}

func TestMdSysfs(t *testing.T) {
	dir := t.TempDir()
	s := "sys/block/md127/md/"
	writeTree(t, dir, map[string]string{
		s + "level": "raid1\n", s + "array_state": "clean\n", s + "degraded": "0\n", s + "raid_disks": "2\n",
		s + "sync_action": "resync\n", s + "sync_completed": "3352064 / 67041280\n", "sys/block/md127/size": "67041280\n",
		"proc/mdstat": "md127 : active raid1 nvme0n1p2[0] nvme1n1p2[1]\n      33520640 blocks super 1.2 [2/2] [UU]\n",
	})
	x := newRAIDCollector(fsRoot(dir), nil)
	if err := x.run(context.Background()); err != nil {
		t.Fatal(err)
	}
	a := x.snapshot()
	if len(a) != 1 || a[0].State != "resyncing" || a[0].SyncPct == nil || *a[0].SyncPct != 5 || a[0].SizeBytes != 67041280*512 {
		t.Errorf("md127 via sysfs: %+v", a)
	}
	if mdState(true, "clean", "", "raid5", 4, 2) != "failed" || mdState(true, "broken", "", "raid0", 2, 0) != "failed" {
		t.Error("failed states")
	}
}

func TestUnraidArray(t *testing.T) {
	dir := t.TempDir()
	writeTree(t, dir, map[string]string{
		"var/local/emhttp/var.ini":   string(readTestdata(t, "unraid_var.ini")),
		"var/local/emhttp/disks.ini": string(readTestdata(t, "unraid_disks.ini")),
	})
	a, err := unraidArray(fsRoot(dir))
	if err != nil {
		t.Fatal(err)
	}
	// Parity + 3 data disks (disk4 is an empty slot, parity2 not
	// installed), disk2 invalid and being rebuilt.
	if a.Name != "unraid" || a.Level != "unraid" || a.Devices != 4 || a.Active != 3 ||
		strings.Join(a.Members, ",") != "parity,disk1,disk2,disk3" || strings.Join(a.Failed, ",") != "disk2" {
		t.Errorf("array: %+v", a)
	}
	// One bad slot, one parity disk: parity rebuilds disk2.
	if a.State != "recovering" {
		t.Errorf("state %q", a.State)
	}
	d2 := parseINI(readTestdata(t, "unraid_disks.ini"))
	d2["disk3"]["status"] = "DISK_DSBL"
	if f := buildUnraidArray(parseINI(readTestdata(t, "unraid_var.ini"))[""], d2); f.State != "failed" {
		t.Errorf("two bad slots with one parity disk: %q", f.State)
	}
	if a.SyncPct == nil || *a.SyncPct != 25 {
		t.Errorf("sync %v", a.SyncPct)
	}
	if !a.LastCheck.Equal(time.Unix(1791140000, 0).UTC()) || a.LastCheckErrors == nil || *a.LastCheckErrors != 0 {
		t.Errorf("last check %v %v", a.LastCheck, a.LastCheckErrors)
	}
	// BlackBox (unRAID 7.3.1): one data disk, no parity; md counts the two
	// empty parity slots as disabled and invalid.
	if bb, err := unraidArray(fsRoot(blackbox)); err != nil || bb.State != "clean" || bb.Devices != 1 || len(bb.Failed) != 0 {
		t.Errorf("BlackBox: %+v %v", bb, err)
	}
	// A healthy array running a parity check.
	v := parseINI(readTestdata(t, "unraid_var.ini"))[""]
	v["mdNumDisabled"], v["mdNumInvalid"], v["mdResyncAction"] = "0", "0", "check P"
	d := parseINI(readTestdata(t, "unraid_disks.ini"))
	d["disk2"]["status"] = "DISK_OK"
	d["parity2"]["status"] = "DISK_NP"
	h := buildUnraidArray(v, d)
	if h.State != "checking" || len(h.Failed) != 0 || h.Devices != 4 {
		t.Errorf("healthy: %+v", h)
	}
	v["mdResync"], v["mdResyncPos"] = "0", "0"
	if h := buildUnraidArray(v, d); h.State != "clean" || h.SyncPct != nil {
		t.Errorf("idle: %+v", h)
	}
	v["mdState"] = "STOPPED"
	if h := buildUnraidArray(v, d); h.State != "stopped" {
		t.Errorf("stopped: %+v", h)
	}
}
