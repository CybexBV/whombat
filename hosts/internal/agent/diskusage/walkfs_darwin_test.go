//go:build darwin

package diskusage

import (
	"context"
	"errors"
	"path/filepath"
	"testing"

	"golang.org/x/sys/unix"

	"rackoon/internal/proto"
)

func TestDarwinScanFSRootFSIDMismatchAndMountPointSkip(t *testing.T) {
	root := t.TempDir()
	writeBytes(t, filepath.Join(root, "keep/file.bin"), 8192)

	var rootSt unix.Stat_t
	if err := unix.Stat(root, &rootSt); err != nil {
		t.Fatal(err)
	}
	checkedFSID := [2]int32{rootSt.Dev, 1}
	wrongFSID := [2]int32{rootSt.Dev + 1, 1}

	// 1. Overmounted root: f_fsid differs from standby-checked volume -> refused before Statfs/ReadDir.
	rMismatch := newTestRunner(t, root, []mountInfo{
		{ID: 1, MountPoint: "/", FSType: "apfs", Source: "/dev/disk3s1", FSID: checkedFSID, HasFSID: true},
	}, &proto.Report{
		Filesystems: []proto.Filesystem{{Mount: "/", Device: "/dev/disk3", FSType: "apfs", Disks: []string{"disk0"}}},
		Disks:       []proto.Disk{{Device: "disk0", Type: "nvme"}},
	})
	rMismatch.goos = "darwin"
	rMismatch.scanFS = &darwinScanFS{
		r: rMismatch,
		fgetFn: func(_ int, _ *darwinAttrList, buf []byte, _ uint64) error {
			copy(buf, buildDarwinIdentityBuffer(rootSt.Dev, true, wrongFSID, true))
			return nil
		},
		bulkFn: func(int, *darwinAttrList, []byte, uint64) (int, error) {
			t.Error("getattrlistbulk called after root f_fsid mismatch")
			return 0, nil
		},
	}
	resp := rMismatch.DiskUsage(context.Background(), proto.DiskUsageRequest{Mount: "/"})
	if resp.Code != CodeFailed {
		t.Fatalf("root f_fsid mismatch: resp = %+v, want CodeFailed", resp)
	}

	// 2. Mount point reported by getattrlistbulk is skipped before openat.
	rSkip := newTestRunner(t, root, []mountInfo{
		{ID: 1, MountPoint: "/", FSType: "apfs", Source: "/dev/disk3s1", FSID: checkedFSID, HasFSID: true},
	}, &proto.Report{
		Filesystems: []proto.Filesystem{{Mount: "/", Device: "/dev/disk3", FSType: "apfs", Disks: []string{"disk0"}}},
		Disks:       []proto.Disk{{Device: "disk0", Type: "nvme"}},
	})
	rSkip.goos = "darwin"
	returnedOnce := false
	sfs := &darwinScanFS{
		r: rSkip,
		fgetFn: func(_ int, _ *darwinAttrList, buf []byte, _ uint64) error {
			copy(buf, buildDarwinIdentityBuffer(rootSt.Dev, true, checkedFSID, true))
			return nil
		},
		bulkFn: func(_ int, _ *darwinAttrList, buf []byte, _ uint64) (int, error) {
			if returnedOnce {
				return 0, nil
			}
			returnedOnce = true
			recs := []testBulkRec{
				{name: "child-mount", hasDev: true, dev: rootSt.Dev, hasFSID: true, fsid: checkedFSID, hasObjType: true, objType: darwinVDir, hasMntStatus: true, mntStatus: darwinDirMntStatusMntPoint},
			}
			raw := buildDarwinBulkBuffer(recs)
			copy(buf, raw)
			return len(recs), nil
		},
	}
	rootDir, err := sfs.OpenRoot(root, "/", mountInfo{ID: 1, MountPoint: "/", FSID: checkedFSID, HasFSID: true})
	if err != nil {
		t.Fatalf("OpenRoot: %v", err)
	}
	defer rootDir.Close()

	// openRelDir / OpenDir(prechecked=false) refuses child-mount via getattrlistbulk without calling openat.
	if sub, err := rootDir.OpenDir("child-mount", "/child-mount", false, false); err == nil {
		_ = sub.Close()
		t.Fatal("OpenDir crossed mount point reported by getattrlistbulk")
	} else if !errors.Is(err, errWrongMount) {
		t.Fatalf("OpenDir(child-mount) err = %v, want errWrongMount", err)
	}
}
