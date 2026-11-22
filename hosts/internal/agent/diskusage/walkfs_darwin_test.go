//go:build darwin

package diskusage

import (
	"context"
	"errors"
	"io/fs"
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

func TestDarwinPuregoSyscallWrappersMaskCorruptedErrno(t *testing.T) {
	corrupt := func(e unix.Errno) uintptr {
		return uintptr(uint64(0x6dddc000)<<32 | uint64(uint32(e)))
	}
	negOne := ^uintptr(0)
	alist := darwinBulkAttrList()
	buf := make([]byte, 64)

	// 1. EINTR with corrupted upper 32 bits retries and succeeds on both wrappers.
	bulkCalls := 0
	n, err := callDarwinGetattrlistbulk(func(uintptr, ...uintptr) (uintptr, uintptr, uintptr) {
		bulkCalls++
		if bulkCalls == 1 {
			return negOne, 0, corrupt(unix.EINTR)
		}
		return 3, 0, 0
	}, 1, 0, &alist, buf, 0)
	if err != nil || n != 3 || bulkCalls != 2 {
		t.Fatalf("getattrlistbulk EINTR retry = (%d, %v, calls=%d), want (3, nil, 2)", n, err, bulkCalls)
	}

	fgetCalls := 0
	err = callDarwinFgetattrlist(func(uintptr, ...uintptr) (uintptr, uintptr, uintptr) {
		fgetCalls++
		if fgetCalls == 1 {
			return negOne, 0, corrupt(unix.EINTR)
		}
		return 0, 0, 0
	}, 1, 0, &alist, buf, 0)
	if err != nil || fgetCalls != 2 {
		t.Fatalf("fgetattrlist EINTR retry = (%v, calls=%d), want (nil, 2)", err, fgetCalls)
	}

	// 2. ERANGE, ENOENT, EACCES with corrupted upper 32 bits match standard errors.
	for _, tc := range []struct {
		want      unix.Errno
		stdTarget error
	}{
		{unix.ERANGE, nil},
		{unix.ENOENT, fs.ErrNotExist},
		{unix.EACCES, fs.ErrPermission},
	} {
		_, err := callDarwinGetattrlistbulk(func(uintptr, ...uintptr) (uintptr, uintptr, uintptr) {
			return negOne, 0, corrupt(tc.want)
		}, 1, 0, &alist, buf, 0)
		if !errors.Is(err, tc.want) {
			t.Errorf("getattrlistbulk(%v): got %v, want %v", tc.want, err, tc.want)
		}
		if tc.stdTarget != nil && !errors.Is(err, tc.stdTarget) {
			t.Errorf("getattrlistbulk(%v): errors.Is(%v, %v) = false", tc.want, err, tc.stdTarget)
		}

		err = callDarwinFgetattrlist(func(uintptr, ...uintptr) (uintptr, uintptr, uintptr) {
			return negOne, 0, corrupt(tc.want)
		}, 1, 0, &alist, buf, 0)
		if !errors.Is(err, tc.want) {
			t.Errorf("fgetattrlist(%v): got %v, want %v", tc.want, err, tc.want)
		}
	}

	// 3. readBulkRaw grows bulkBuf when getattrlistbulk returns a corrupted-upper-bits ERANGE.
	var seenLens []int
	dir := &darwinScanDir{
		fd: 0,
		state: &darwinFSState{
			bulkFn: func(dirfd int, al *darwinAttrList, b []byte, opts uint64) (int, error) {
				seenLens = append(seenLens, len(b))
				return callDarwinGetattrlistbulk(func(uintptr, ...uintptr) (uintptr, uintptr, uintptr) {
					if len(seenLens) == 1 {
						return negOne, 0, corrupt(unix.ERANGE)
					}
					return 0, 0, 0
				}, 1, dirfd, al, b, opts)
			},
		},
	}
	_, eof, err := dir.readBulkRaw()
	if err != nil || !eof {
		t.Fatalf("readBulkRaw ERANGE growth = (eof=%v, err=%v), want (true, nil)", eof, err)
	}
	if len(seenLens) != 2 || seenLens[1] != seenLens[0]*2 {
		t.Fatalf("readBulkRaw buffer sizes = %v, want doubling on ERANGE", seenLens)
	}
}
