//go:build linux

package diskusage

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"
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
	rootDir, err := sfs.OpenRoot("/", "/", mountInfo{ID: rootMntID, MountPoint: "/"})
	if err != nil {
		var unsup *scanUnsupportedError
		if errors.As(err, &unsup) {
			t.Skipf("openat2 unavailable on this host: %v", err)
		}
		t.Fatalf("OpenRoot(/): %v", err)
	}
	defer rootDir.Close()

	ld := rootDir.(*linuxScanDir)

	// Verify statx/fdinfo mount IDs agree with /proc/self/mountinfo.
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
	if sub, err := rootDir.OpenDir(childMount, "/"+childMount, false, false); err == nil {
		_ = sub.Close()
		t.Fatalf("OpenDir(/%s, searchOnly=false) unexpectedly crossed mount boundary", childMount)
	} else if !errors.Is(err, errWrongMount) {
		t.Fatalf("OpenDir(/%s, searchOnly=false) err = %v, want errWrongMount (EXDEV)", childMount, err)
	}

	if sub, err := rootDir.OpenDir(childMount, "/"+childMount, true, false); err == nil {
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
	tmpDir, err := newLinuxScanFSWithOpenat2(rTmp, unix.Openat2).OpenRoot(tmp, "/", mountInfo{ID: 1, MountPoint: "/"})
	if err != nil {
		t.Fatalf("OpenRoot(tmp): %v", err)
	}
	defer tmpDir.Close()

	if sub, err := tmpDir.OpenDir("symdir", "/symdir", false, false); err == nil {
		_ = sub.Close()
		t.Fatal("OpenDir followed symlink directory")
	} else if !isSkipDirErr(err) {
		t.Fatalf("OpenDir(symdir) err = %v, want skip dir error", err)
	}
	if sub, err := tmpDir.OpenDir("symdir", "/symdir", true, false); err == nil {
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
	ents, err := innerDir.ReadDirBatch(64)
	_ = innerDir.Close()
	if err != nil || len(ents) != 1 || ents[0].Name != "data.bin" || ents[0].Kind != entryRegular {
		t.Fatalf("innerDir.ReadDirBatch() = (%+v, %v), want [data.bin regular]", ents, err)
	}
}

func TestLinuxRefusesScanWithoutOpenat2(t *testing.T) {
	cases := []struct {
		name       string
		err        error
		wantSubstr string
	}{
		{"pre_5_6_enosys", unix.ENOSYS, "too old for a safe scan"},
		{"seccomp_eperm", unix.EPERM, "does not allow a safe disk scan"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			writeBytes(t, filepath.Join(root, "srv/keep/data.bin"), 16*1024)
			mounts := []mountInfo{{ID: 10, ParentID: 1, MountPoint: "/", FSType: "ext4", Source: "/dev/nvme0n1p2"}}
			r := newTestRunner(t, root, mounts, nil)
			var readDirCalls atomic.Int32
			r.readDir = func(logicalPath string) ([]fs.DirEntry, error) {
				readDirCalls.Add(1)
				return os.ReadDir(r.hostPath(logicalPath))
			}
			r.scanFS = newLinuxScanFSWithOpenat2(r, func(int, string, *unix.OpenHow) (int, error) {
				return -1, tc.err
			})

			resp := r.DiskUsage(context.Background(), proto.DiskUsageRequest{Mount: "/"})
			if resp.Code != CodeUnsupported {
				t.Fatalf("resp.Code = %q, want %q (resp=%+v)", resp.Code, CodeUnsupported, resp)
			}
			if !strings.Contains(resp.Message, tc.wantSubstr) {
				t.Errorf("resp.Message = %q, want substring %q", resp.Message, tc.wantSubstr)
			}
			if readDirCalls.Load() != 0 {
				t.Errorf("ReadDir called %d times when openat2 unavailable, want 0", readDirCalls.Load())
			}
		})
	}
}

func TestLinuxOpenDirPinsWithOPathBeforeOpeningDotAndRejectsAutomount(t *testing.T) {
	root := t.TempDir()
	writeBytes(t, filepath.Join(root, "srv/app/data.bin"), 16*1024)
	writeBytes(t, filepath.Join(root, "mnt/auto/secret.bin"), 256*1024)

	autoInfo, err := os.Stat(filepath.Join(root, "mnt/auto"))
	if err != nil {
		t.Fatal(err)
	}
	var autoStat unix.Stat_t
	if err := unix.Stat(filepath.Join(root, "mnt/auto"), &autoStat); err != nil {
		t.Fatal(err)
	}
	_ = autoInfo

	type openCall struct {
		path    string
		flags   uint64
		resolve uint64
	}
	var mu sync.Mutex
	var calls []openCall
	var autoDotOpened atomic.Int32

	mounts := []mountInfo{{ID: 10, ParentID: 1, MountPoint: "/", FSType: "ext4", Source: "/dev/nvme0n1p2"}}
	r := newTestRunner(t, root, mounts, nil)

	sfs := &linuxScanFS{
		r: r,
		openat2: func(dirfd int, path string, how *unix.OpenHow) (int, error) {
			mu.Lock()
			calls = append(calls, openCall{path: path, flags: how.Flags, resolve: how.Resolve})
			mu.Unlock()
			// If anything ever tries to open "." on the automount inode with O_DIRECTORY, catch it!
			if path == "." && how.Flags&unix.O_DIRECTORY != 0 {
				var st unix.Stat_t
				if unix.Fstat(dirfd, &st) == nil && st.Ino == autoStat.Ino && st.Dev == autoStat.Dev {
					autoDotOpened.Add(1)
				}
			}
			return unix.Openat2(dirfd, path, how)
		},
		statx: func(dirfd int, path string, flags int, mask int, stx *unix.Statx_t) error {
			if err := unix.Statx(dirfd, path, flags, mask, stx); err != nil {
				return err
			}
			// Simulate /mnt/auto being an uncovered automount trigger dentry.
			if stx.Ino == autoStat.Ino && unix.Mkdev(stx.Dev_major, stx.Dev_minor) == uint64(autoStat.Dev) {
				stx.Attributes |= unix.STATX_ATTR_AUTOMOUNT
				stx.Attributes_mask |= unix.STATX_ATTR_AUTOMOUNT
			}
			return nil
		},
		fdinfoMountID: fdinfoMountID,
	}
	r.scanFS = sfs

	resp := r.DiskUsage(context.Background(), proto.DiskUsageRequest{Mount: "/"})
	if resp.Code != "" {
		t.Fatalf("unexpected error: %+v", resp)
	}
	if autoDotOpened.Load() != 0 {
		t.Fatalf("opened '.' with O_DIRECTORY on automount trigger %d times, want 0", autoDotOpened.Load())
	}

	// Verify NO openat2 call on a child name ever passed O_DIRECTORY (only "." on an already-pinned fd may).
	mu.Lock()
	defer mu.Unlock()
	var sawAutoPin bool
	for _, c := range calls {
		if c.path != "." {
			if c.flags&unix.O_PATH == 0 {
				t.Errorf("openat2(%q) missing O_PATH flag (flags=%#x)", c.path, c.flags)
			}
			if c.flags&unix.O_DIRECTORY != 0 {
				t.Errorf("openat2(%q) passed O_DIRECTORY (flags=%#x), which triggers automounts before RESOLVE_NO_XDEV", c.path, c.flags)
			}
			if c.resolve != linuxOpenat2Resolve {
				t.Errorf("openat2(%q) resolve=%#x, want %#x", c.path, c.resolve, linuxOpenat2Resolve)
			}
			if c.path == "auto" {
				sawAutoPin = true
			}
		}
	}
	if !sawAutoPin {
		t.Errorf("expected openat2 to pin 'auto' with O_PATH; calls=%+v", calls)
	}
	for _, f := range resp.Folders {
		if hasPathPrefix(f.Path, "/mnt/auto") || f.Bytes >= 128*1024 {
			t.Errorf("walk crossed into automount trigger: %+v", f)
		}
	}
}

func TestLinuxRejectsUnreadableChildMountIDPre58Statx(t *testing.T) {
	root := t.TempDir()
	writeBytes(t, filepath.Join(root, "keep/ok.bin"), 16*1024)
	writeBytes(t, filepath.Join(root, "mystery/file.bin"), 64*1024)
	writeBytes(t, filepath.Join(root, "keep/unreadable-mntid.bin"), 64*1024)

	var keepFileStat, mysteryDirStat unix.Stat_t
	if err := unix.Stat(filepath.Join(root, "keep/unreadable-mntid.bin"), &keepFileStat); err != nil {
		t.Fatal(err)
	}
	if err := unix.Stat(filepath.Join(root, "mystery"), &mysteryDirStat); err != nil {
		t.Fatal(err)
	}

	// Simulate Linux 5.6-5.7 where statx never sets STATX_MNT_ID, so mount IDs
	// come from /proc/self/fdinfo/<fd>. Root and normal files resolve mount ID 42,
	// while "keep/unreadable-mntid.bin" and "mystery" fail fdinfo lookup.
	r := newTestRunner(t, root, []mountInfo{{ID: 42, ParentID: 1, MountPoint: "/", FSType: "ext4", Source: "/dev/nvme0n1p2"}}, nil)
	r.root = "" // exercise real-host mount ID resolution path
	sfs := &linuxScanFS{
		r:       r,
		openat2: unix.Openat2,
		statx: func(dirfd int, path string, flags int, mask int, stx *unix.Statx_t) error {
			if err := unix.Statx(dirfd, path, flags, mask, stx); err != nil {
				return err
			}
			// Clear STATX_MNT_ID to simulate pre-5.8 kernel.
			stx.Mask &^= unix.STATX_MNT_ID
			stx.Mnt_id = 0
			return nil
		},
		fdinfoMountID: func(fd int) (uint64, bool) {
			var st unix.Stat_t
			if unix.Fstat(fd, &st) != nil {
				return 0, false
			}
			if st.Ino == keepFileStat.Ino || st.Ino == mysteryDirStat.Ino {
				return 0, false
			}
			return 42, true
		},
	}

	rootDir, err := sfs.OpenRoot(root, "/", mountInfo{ID: 42, MountPoint: "/"})
	if err != nil {
		t.Fatalf("OpenRoot: %v", err)
	}
	defer rootDir.Close()

	// Directory whose mount ID cannot be read when root's can -> rejected as errWrongMount.
	if sub, err := rootDir.OpenDir("mystery", "/mystery", false, false); err == nil {
		_ = sub.Close()
		t.Fatal("OpenDir accepted directory with unreadable mount ID")
	} else if !errors.Is(err, errWrongMount) {
		t.Fatalf("OpenDir(mystery) err = %v, want errWrongMount", err)
	}

	// Normal directory succeeds via fdinfo fallback on pre-5.8 statx.
	keepDir, err := rootDir.OpenDir("keep", "/keep", false, false)
	if err != nil {
		t.Fatalf("OpenDir(keep) failed on pre-5.8 statx with working fdinfo: %v", err)
	}
	defer keepDir.Close()

	// File whose mount ID cannot be read when root's can -> rejected as errWrongMount.
	if _, err := keepDir.StatEntry("unreadable-mntid.bin", "/keep/unreadable-mntid.bin"); err == nil {
		t.Fatal("StatEntry accepted file with unreadable mount ID")
	} else if !errors.Is(err, errWrongMount) {
		t.Fatalf("StatEntry(unreadable-mntid.bin) err = %v, want errWrongMount", err)
	}

	// Normal file succeeds via fdinfo fallback.
	es, err := keepDir.StatEntry("ok.bin", "/keep/ok.bin")
	if err != nil {
		t.Fatalf("StatEntry(ok.bin): %v", err)
	}
	if !es.HasMntID || es.MntID != 42 {
		t.Errorf("StatEntry(ok.bin) mount ID = (%d, %v), want (42, true)", es.MntID, es.HasMntID)
	}
}

func TestLinuxReadDirBatchStreamsLargeDirectory(t *testing.T) {
	dir := t.TempDir()
	const totalFiles = 1200
	sub := filepath.Join(dir, "many")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < totalFiles; i++ {
		f, err := os.Create(filepath.Join(sub, fmt.Sprintf("entry-%04d.txt", i)))
		if err != nil {
			t.Fatal(err)
		}
		_ = f.Close()
	}

	r := newTestRunner(t, dir, []mountInfo{{ID: 1, MountPoint: "/", FSType: "ext4", Source: "/dev/nvme0n1p2"}}, nil)
	sfs := newLinuxScanFSWithOpenat2(r, unix.Openat2)
	rootDir, err := sfs.OpenRoot(dir, "/", mountInfo{ID: 1, MountPoint: "/"})
	if err != nil {
		t.Fatalf("OpenRoot: %v", err)
	}
	defer rootDir.Close()

	manyDir, err := rootDir.OpenDir("many", "/many", false, false)
	if err != nil {
		t.Fatalf("OpenDir(many): %v", err)
	}
	defer manyDir.Close()

	seen := map[string]bool{}
	batches := 0
	for {
		ents, err := manyDir.ReadDirBatch(100)
		if len(ents) > 100 {
			t.Fatalf("batch size %d exceeded requested cap 100", len(ents))
		}
		for _, e := range ents {
			if seen[e.Name] {
				t.Fatalf("duplicate entry %q across batches", e.Name)
			}
			seen[e.Name] = true
		}
		if len(ents) > 0 {
			batches++
		}
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			t.Fatalf("ReadDirBatch: %v", err)
		}
	}
	if len(seen) != totalFiles {
		t.Fatalf("streamed %d unique files, want %d", len(seen), totalFiles)
	}
	if batches < 12 {
		t.Fatalf("expected at least 12 batches of <=100 entries, got %d", batches)
	}
}

func TestLinuxOpenRootRejectsOvermountAndAutomountBeforeReadableOpen(t *testing.T) {
	root := t.TempDir()
	mounts := []mountInfo{{ID: 10, ParentID: 1, MountPoint: "/", FSType: "ext4", Source: "/dev/nvme0n1p2"}}

	for _, tc := range []struct {
		name      string
		automount bool
		mntID     uint64
	}{
		{"overmounted_root", false, 99},
		{"automount_root", true, 10},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var readableOpenCalls atomic.Int32
			r := newTestRunner(t, root, mounts, nil)
			r.scanFS = &linuxScanFS{
				r: r,
				openat2: func(dirfd int, path string, how *unix.OpenHow) (int, error) {
					if how.Flags&unix.O_DIRECTORY != 0 {
						readableOpenCalls.Add(1)
					}
					return unix.Openat2(dirfd, path, how)
				},
				statx: func(dirfd int, path string, flags int, mask int, stx *unix.Statx_t) error {
					if err := unix.Statx(dirfd, path, flags, mask, stx); err != nil {
						return err
					}
					if tc.automount {
						stx.Attributes |= unix.STATX_ATTR_AUTOMOUNT
						stx.Attributes_mask |= unix.STATX_ATTR_AUTOMOUNT
					}
					return nil
				},
				fdinfoMountID: func(int) (uint64, bool) { return tc.mntID, true },
			}
			r.statMountID = func(string) (uint64, bool) { return tc.mntID, true }

			resp := r.DiskUsage(context.Background(), proto.DiskUsageRequest{Mount: "/"})
			if resp.Code != CodeFailed {
				t.Fatalf("resp = %+v, want CodeFailed", resp)
			}
			if readableOpenCalls.Load() != 0 {
				t.Fatalf("openat2(O_DIRECTORY) called %d times on %s, want 0", readableOpenCalls.Load(), tc.name)
			}
		})
	}
}
