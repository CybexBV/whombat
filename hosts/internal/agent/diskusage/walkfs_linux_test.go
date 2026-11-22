//go:build linux

package diskusage

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"golang.org/x/sys/unix"

	"rackoon/internal/proto"
)

// findDirectChildMountOnRoot locates a real mounted filesystem directly beneath
// "/" (such as /proc, /sys, or /dev) from /proc/self/mountinfo so Linux tests
// can exercise real kernel mount-crossing refusal without root or mount(2).
func findDirectChildMountOnRoot(t *testing.T) (name string, rootID int, ok bool) {
	t.Helper()
	mounts, err := hostMounts()
	if err != nil {
		return "", 0, false
	}
	scope, found := buildMountScope(mounts, "/")
	if !found {
		return "", 0, false
	}
	for _, cand := range []string{"proc", "sys", "dev", "run"} {
		if scope.otherMounts["/"+cand] {
			return cand, scope.target.ID, true
		}
	}
	for mp := range scope.otherMounts {
		trimmed := strings.TrimPrefix(mp, "/")
		if trimmed != "" && !strings.ContainsRune(trimmed, '/') {
			return trimmed, scope.target.ID, true
		}
	}
	return "", scope.target.ID, false
}

func TestLinuxOpenat2RefusesRealMountCrossingAndSymlinks(t *testing.T) {
	childMount, rootMntID, ok := findDirectChildMountOnRoot(t)
	if !ok {
		t.Skip("no direct child mount under / found in /proc/self/mountinfo")
	}

	r := New(nil, nil)
	sfs := newLinuxScanFSWithOpenat2(r, unix.Openat2)
	rootDir, err := sfs.OpenRoot("/", "/")
	if err != nil {
		t.Fatalf("OpenRoot(/): %v", err)
	}
	defer rootDir.Close()

	ld := rootDir.(*linuxScanDir)
	if !ld.state.openat2Works.Load() {
		t.Skip("kernel or seccomp filter does not permit openat2 on this host")
	}

	// Verify fdStatMountID and fdinfoMountID agree with /proc/self/mountinfo.
	meta, err := rootDir.Stat()
	if err != nil {
		t.Fatalf("rootDir.Stat(): %v", err)
	}
	if !meta.HasMntID || meta.MntID != uint64(rootMntID) {
		t.Errorf("rootDir mount ID = (%d, %v), want (%d, true)", meta.MntID, meta.HasMntID, rootMntID)
	}
	if infoID, infoOK := fdinfoMountID(ld.fd); !infoOK || infoID != uint64(rootMntID) {
		t.Errorf("fdinfoMountID(/) = (%d, %v), want (%d, true)", infoID, infoOK, rootMntID)
	}

	// openat2(RESOLVE_NO_XDEV) must refuse crossing from / into /<childMount>
	// for both OpenDir (readable and searchOnly) and StatEntry (O_PATH).
	if sub, err := rootDir.OpenDir(childMount, "/"+childMount, false); err == nil {
		_ = sub.Close()
		t.Fatalf("OpenDir(/%s, searchOnly=false) unexpectedly crossed mount boundary", childMount)
	} else if !errors.Is(err, errWrongMount) {
		t.Fatalf("OpenDir(/%s, searchOnly=false) err = %v, want errWrongMount (EXDEV)", childMount, err)
	}

	if sub, err := rootDir.OpenDir(childMount, "/"+childMount, true); err == nil {
		_ = sub.Close()
		t.Fatalf("OpenDir(/%s, searchOnly=true) unexpectedly crossed mount boundary", childMount)
	} else if !errors.Is(err, errWrongMount) {
		t.Fatalf("OpenDir(/%s, searchOnly=true) err = %v, want errWrongMount (EXDEV)", childMount, err)
	}

	if _, err := rootDir.StatEntry(childMount, "/"+childMount); err == nil {
		t.Fatalf("StatEntry(/%s) unexpectedly crossed mount boundary", childMount)
	} else if !errors.Is(err, errWrongMount) {
		t.Fatalf("StatEntry(/%s) err = %v, want errWrongMount (EXDEV)", childMount, err)
	}

	// Verify openat2 refuses symlinks and allows search-only traversal of execute-only dirs.
	tmp := t.TempDir()
	writeBytes(t, filepath.Join(tmp, "realdir/file.bin"), 4096)
	writeBytes(t, filepath.Join(tmp, "xonly/inner/data.bin"), 4096)
	if err := os.Symlink(filepath.Join(tmp, "realdir"), filepath.Join(tmp, "symdir")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(tmp, "realdir/file.bin"), filepath.Join(tmp, "symfile")); err != nil {
		t.Fatal(err)
	}
	if os.Geteuid() != 0 {
		if err := os.Chmod(filepath.Join(tmp, "xonly"), 0o111); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = os.Chmod(filepath.Join(tmp, "xonly"), 0o755) })
	}

	rTmp := newTestRunner(t, tmp, []mountInfo{{ID: 1, MountPoint: "/", FSType: "ext4", Source: "/dev/nvme0n1p2"}}, nil)
	tmpDir, err := newLinuxScanFSWithOpenat2(rTmp, unix.Openat2).OpenRoot(tmp, "/")
	if err != nil {
		t.Fatalf("OpenRoot(tmp): %v", err)
	}
	defer tmpDir.Close()

	if sub, err := tmpDir.OpenDir("symdir", "/symdir", false); err == nil {
		_ = sub.Close()
		t.Fatal("OpenDir followed symlink directory")
	} else if !isSkipDirErr(err) {
		t.Fatalf("OpenDir(symdir) err = %v, want skip dir error", err)
	}
	if sub, err := tmpDir.OpenDir("symdir", "/symdir", true); err == nil {
		_ = sub.Close()
		t.Fatal("OpenDir(searchOnly=true) followed symlink directory")
	} else if !isSkipDirErr(err) {
		t.Fatalf("OpenDir(symdir, searchOnly=true) err = %v, want skip dir error", err)
	}
	if _, err := tmpDir.StatEntry("symfile", "/symfile"); err == nil {
		t.Fatal("StatEntry followed symlink file")
	} else if !isSkipEntryErr(err) {
		t.Fatalf("StatEntry(symfile) err = %v, want skip entry error (ELOOP)", err)
	}

	// Execute-only intermediate directory (0111) still resolves via O_PATH searchOnly.
	scope, _ := buildMountScope([]mountInfo{{ID: 1, MountPoint: "/", FSType: "ext4", Source: "/dev/nvme0n1p2"}}, "/")
	innerDir, err := openRelDir(tmpDir, scope, "/xonly/inner", false)
	if err != nil {
		t.Fatalf("openRelDir(/xonly/inner) through 0111 dir failed: %v", err)
	}
	ents, err := innerDir.ReadDir()
	_ = innerDir.Close()
	if err != nil || len(ents) != 1 || ents[0].Name != "data.bin" || ents[0].Kind != entryRegular {
		t.Fatalf("innerDir.ReadDir() = (%+v, %v), want [data.bin regular]", ents, err)
	}
}

func TestLinuxOpenat2ENOSYSFallback(t *testing.T) {
	// 1. Real kernel mount crossing under ENOSYS fallback: opening /<childMount>
	//    via openat(O_NOFOLLOW|O_DIRECTORY) must reject by st_dev/mnt_id before returning.
	if childMount, _, ok := findDirectChildMountOnRoot(t); ok {
		rHost := New(nil, nil)
		fallbackFS := newLinuxScanFSWithOpenat2(rHost, func(int, string, *unix.OpenHow) (int, error) {
			return -1, unix.ENOSYS
		})
		rootDir, err := fallbackFS.OpenRoot("/", "/")
		if err != nil {
			t.Fatalf("OpenRoot(/) fallback: %v", err)
		}
		defer rootDir.Close()

		if rootDir.(*linuxScanDir).state.openat2Works.Load() {
			t.Fatal("expected openat2Works=false when openat2 returns ENOSYS")
		}
		if sub, err := rootDir.OpenDir(childMount, "/"+childMount, false); err == nil {
			_ = sub.Close()
			t.Fatalf("ENOSYS fallback OpenDir(/%s) unexpectedly crossed mount", childMount)
		} else if !errors.Is(err, errWrongMount) {
			t.Fatalf("ENOSYS fallback OpenDir(/%s) err = %v, want errWrongMount", childMount, err)
		}
		if _, err := rootDir.StatEntry(childMount, "/"+childMount); err == nil {
			t.Fatalf("ENOSYS fallback StatEntry(/%s) unexpectedly crossed mount", childMount)
		} else if !errors.Is(err, errWrongMount) {
			t.Fatalf("ENOSYS fallback StatEntry(/%s) err = %v, want errWrongMount", childMount, err)
		}
	}

	// 2. Full DiskUsage scan with ENOSYS fallback (both from start and triggered mid-walk):
	//    verifies files, container logs, symlinks, and a mid-walk mount-ID mismatch
	//    rejected before ReadDir is ever called on it.
	for _, midWalkENOSYS := range []bool{false, true} {
		name := "enosys_from_start"
		if midWalkENOSYS {
			name = "enosys_mid_walk"
		}
		t.Run(name, func(t *testing.T) {
			root := t.TempDir()
			outside := t.TempDir()
			writeBytes(t, filepath.Join(root, "srv/keep/data.bin"), 24*1024)
			writeBytes(t, filepath.Join(root, "mnt/newly-mounted/big.bin"), 256*1024)
			writeBytes(t, filepath.Join(root, "var/lib/docker/containers/c1/c1-json.log"), 16*1024)
			writeBytes(t, filepath.Join(outside, "huge.bin"), 512*1024)
			if err := os.Symlink(outside, filepath.Join(root, "srv/sym-outside")); err != nil {
				t.Fatal(err)
			}

			mounts := []mountInfo{{ID: 10, ParentID: 1, MountPoint: "/", FSType: "ext4", Source: "/dev/nvme0n1p2"}}
			r := newTestRunner(t, root, mounts, nil)
			r.statMountID = func(logicalPath string) (uint64, bool) {
				if hasPathPrefix(logicalPath, "/mnt/newly-mounted") {
					return 99, true
				}
				return 10, true
			}
			var newlyMountedRead atomic.Int32
			r.readDir = func(logicalPath string) ([]fs.DirEntry, error) {
				if hasPathPrefix(logicalPath, "/mnt/newly-mounted") {
					newlyMountedRead.Add(1)
					return nil, fs.ErrPermission
				}
				return os.ReadDir(r.hostPath(logicalPath))
			}

			var calls atomic.Int32
			r.scanFS = newLinuxScanFSWithOpenat2(r, func(dirfd int, path string, how *unix.OpenHow) (int, error) {
				if midWalkENOSYS && calls.Add(1) == 1 {
					return unix.Openat2(dirfd, path, how)
				}
				return -1, unix.ENOSYS
			})

			resp := r.DiskUsage(context.Background(), proto.DiskUsageRequest{Mount: "/"})
			if resp.Code != "" {
				t.Fatalf("unexpected error: %+v", resp)
			}
			if newlyMountedRead.Load() != 0 {
				t.Fatalf("ENOSYS fallback called ReadDir %d times on newly mounted dir, want 0", newlyMountedRead.Load())
			}
			for _, f := range resp.Folders {
				if hasPathPrefix(f.Path, "/mnt/newly-mounted") || strings.Contains(f.Path, "sym-outside") {
					t.Errorf("walk crossed into newly mounted dir or symlink: %+v", f)
				}
			}
			var logBytes uint64
			for _, c := range resp.Categories {
				if c.Key == proto.DiskCatContainerLogs {
					logBytes = c.Bytes
				}
			}
			if logBytes < 16*1024 || logBytes >= 128*1024 {
				t.Errorf("container_logs = %d, want ~16 KiB", logBytes)
			}
		})
	}
}
