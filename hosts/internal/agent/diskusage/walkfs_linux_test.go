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

func newLinuxScanFSWithOpenat2(r *Runner, fn openat2Func) scanFS {
	if fn == nil {
		fn = unix.Openat2
	}
	return &linuxScanFS{
		r:             r,
		openat2:       fn,
		statx:         unix.Statx,
		fdinfoMountID: fdinfoMountID,
	}
}

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
		name           string
		automount      bool
		mntID          uint64
		wantZeroStatx  bool
		wantZeroOpenAt bool
	}{
		{"overmounted_root", false, 99, true, true},
		{"automount_root", true, 10, false, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var openat2Calls atomic.Int32
			var readableOpenCalls atomic.Int32
			var statxCalls atomic.Int32
			r := newTestRunner(t, root, mounts, nil)
			r.scanFS = &linuxScanFS{
				r: r,
				openat2: func(dirfd int, path string, how *unix.OpenHow) (int, error) {
					openat2Calls.Add(1)
					if how.Flags&unix.O_DIRECTORY != 0 {
						readableOpenCalls.Add(1)
					}
					return unix.Openat2(dirfd, path, how)
				},
				statx: func(dirfd int, path string, flags int, mask int, stx *unix.Statx_t) error {
					statxCalls.Add(1)
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
			if tc.wantZeroStatx && statxCalls.Load() != 0 {
				t.Fatalf("statx called %d times on %s, want 0 (fdinfo mount ID must reject before statx)", statxCalls.Load(), tc.name)
			}
			if tc.wantZeroOpenAt && openat2Calls.Load() != 0 {
				t.Fatalf("openat2 called %d times on %s, want 0 (fdinfo mount ID must reject before openat2)", openat2Calls.Load(), tc.name)
			}
		})
	}
}

func TestLinuxChecksFDInfoMountIDBeforeStatxAndOpen(t *testing.T) {
	t.Run("parseFDInfoMountID", func(t *testing.T) {
		if id, ok := parseFDInfoMountID([]byte("pos:\t0\nflags:\t0100002\nmnt_id:\t42\nino:\t7\n")); !ok || id != 42 {
			t.Fatalf("parseFDInfoMountID valid = (%d, %v), want (42, true)", id, ok)
		}
		if id, ok := parseFDInfoMountID([]byte("pos:\t0\nflags:\t0100002\n")); ok || id != 0 {
			t.Fatalf("parseFDInfoMountID missing = (%d, %v), want (0, false)", id, ok)
		}
		if id, ok := parseFDInfoMountID([]byte("mnt_id:\tnotanumber\n")); ok || id != 0 {
			t.Fatalf("parseFDInfoMountID bad = (%d, %v), want (0, false)", id, ok)
		}
	})

	t.Run("root_overmount_and_unreadable_fdinfo_never_call_statx_or_openat2", func(t *testing.T) {
		root := t.TempDir()
		for _, tc := range []struct {
			name     string
			fdinfoFn fdinfoMountIDFunc
			wantErr  error
			wantCode string
		}{
			{
				name:     "overmount_mismatch",
				fdinfoFn: func(int) (uint64, bool) { return 99, true },
				wantErr:  errRootChanged,
				wantCode: CodeFailed,
			},
			{
				name:     "unreadable_fdinfo",
				fdinfoFn: func(int) (uint64, bool) { return 0, false },
				wantCode: CodeUnsupported,
			},
		} {
			t.Run(tc.name, func(t *testing.T) {
				var openat2Calls, statxCalls, statfsCalls atomic.Int32
				mounts := []mountInfo{{ID: 42, ParentID: 1, MountPoint: root, FSType: "ext4", Source: "/dev/nvme0n1p2"}}
				r := newTestRunner(t, root, mounts, nil)
				r.root = "" // exercise real-host fdinfo path (not synthetic test root)
				r.statfs = func(string) (fsStat, error) {
					statfsCalls.Add(1)
					return fsStat{}, nil
				}
				sfs := &linuxScanFS{
					r: r,
					openat2: func(dirfd int, path string, how *unix.OpenHow) (int, error) {
						openat2Calls.Add(1)
						return unix.Openat2(dirfd, path, how)
					},
					statx: func(dirfd int, path string, flags int, mask int, stx *unix.Statx_t) error {
						statxCalls.Add(1)
						return unix.Statx(dirfd, path, flags, mask, stx)
					},
					fdinfoMountID: tc.fdinfoFn,
				}
				r.scanFS = sfs

				if d, err := sfs.OpenRoot(root, root, mountInfo{ID: 42, MountPoint: root}); err == nil {
					_ = d.Close()
					t.Fatal("OpenRoot unexpectedly succeeded")
				} else if tc.wantErr != nil && !errors.Is(err, tc.wantErr) {
					t.Fatalf("OpenRoot err = %v, want %v", err, tc.wantErr)
				} else if tc.wantErr == nil && asUnsupportedErr(err) == nil {
					t.Fatalf("OpenRoot err = %v, want *scanUnsupportedError", err)
				}
				if statxCalls.Load() != 0 {
					t.Fatalf("statx called %d times, want 0", statxCalls.Load())
				}
				if openat2Calls.Load() != 0 {
					t.Fatalf("openat2 called %d times, want 0", openat2Calls.Load())
				}

				resp := r.DiskUsage(context.Background(), proto.DiskUsageRequest{Mount: root})
				if resp.Code != tc.wantCode {
					t.Fatalf("DiskUsage code = %q, want %q (%+v)", resp.Code, tc.wantCode, resp)
				}
				if statxCalls.Load() != 0 || openat2Calls.Load() != 0 || statfsCalls.Load() != 0 {
					t.Fatalf("syscalls after fdinfo reject: statx=%d openat2=%d statfs=%d, want all 0",
						statxCalls.Load(), openat2Calls.Load(), statfsCalls.Load())
				}
			})
		}
	})

	t.Run("root_readable_reopen_mismatch_rejects_before_second_statx", func(t *testing.T) {
		root := t.TempDir()
		r := newTestRunner(t, root, []mountInfo{{ID: 42, ParentID: 1, MountPoint: root, FSType: "ext4", Source: "/dev/nvme0n1p2"}}, nil)
		r.root = ""

		var readableFD atomic.Int32
		readableFD.Store(-1)
		var statxOnReadable atomic.Int32

		sfs := &linuxScanFS{
			r: r,
			openat2: func(dirfd int, path string, how *unix.OpenHow) (int, error) {
				fd, err := unix.Openat2(dirfd, path, how)
				if err == nil && how.Flags&unix.O_DIRECTORY != 0 {
					readableFD.Store(int32(fd))
				}
				return fd, err
			},
			statx: func(dirfd int, path string, flags int, mask int, stx *unix.Statx_t) error {
				if int32(dirfd) == readableFD.Load() {
					statxOnReadable.Add(1)
				}
				return unix.Statx(dirfd, path, flags, mask, stx)
			},
			fdinfoMountID: func(fd int) (uint64, bool) {
				if int32(fd) == readableFD.Load() {
					return 99, true
				}
				return 42, true
			},
		}
		if d, err := sfs.OpenRoot(root, root, mountInfo{ID: 42, MountPoint: root}); err == nil {
			_ = d.Close()
			t.Fatal("OpenRoot accepted mismatched readable root fd")
		} else if !errors.Is(err, errRootChanged) {
			t.Fatalf("OpenRoot err = %v, want errRootChanged", err)
		}
		if statxOnReadable.Load() != 0 {
			t.Fatalf("statx called %d times on mismatched readable root fd, want 0", statxOnReadable.Load())
		}
	})

	t.Run("child_steps_and_openself_check_fdinfo_before_statx_and_open", func(t *testing.T) {
		root := t.TempDir()
		writeBytes(t, filepath.Join(root, "okdir/file.bin"), 4096)
		writeBytes(t, filepath.Join(root, "foreign-dir/secret.bin"), 4096)
		writeBytes(t, filepath.Join(root, "foreign-file.bin"), 4096)
		writeBytes(t, filepath.Join(root, "disagree-file.bin"), 4096)

		var foreignDirSt, foreignFileSt, disagreeFileSt unix.Stat_t
		if err := unix.Stat(filepath.Join(root, "foreign-dir"), &foreignDirSt); err != nil {
			t.Fatal(err)
		}
		if err := unix.Stat(filepath.Join(root, "foreign-file.bin"), &foreignFileSt); err != nil {
			t.Fatal(err)
		}
		if err := unix.Stat(filepath.Join(root, "disagree-file.bin"), &disagreeFileSt); err != nil {
			t.Fatal(err)
		}

		var mu sync.Mutex
		foreignFDs := map[int]bool{}
		var statxOnForeign atomic.Int32
		var openDotOnForeign atomic.Int32
		var failOpenSelf atomic.Bool
		var openSelfFD atomic.Int32
		openSelfFD.Store(-1)
		var failStatfs atomic.Bool

		r := newTestRunner(t, root, []mountInfo{{ID: 42, ParentID: 1, MountPoint: root, FSType: "ext4", Source: "/dev/nvme0n1p2"}}, nil)
		r.root = ""
		sfs := &linuxScanFS{
			r: r,
			openat2: func(dirfd int, path string, how *unix.OpenHow) (int, error) {
				if path == "." && how.Flags&unix.O_DIRECTORY != 0 {
					mu.Lock()
					isForeign := foreignFDs[dirfd]
					mu.Unlock()
					if isForeign {
						openDotOnForeign.Add(1)
					}
				}
				fd, err := unix.Openat2(dirfd, path, how)
				if err == nil {
					mu.Lock()
					if path == "foreign-dir" || path == "foreign-file.bin" {
						foreignFDs[fd] = true
					} else {
						delete(foreignFDs, fd)
					}
					mu.Unlock()
					if failOpenSelf.Load() && path == "." && how.Flags&unix.O_DIRECTORY != 0 {
						openSelfFD.Store(int32(fd))
					}
				}
				return fd, err
			},
			statx: func(dirfd int, path string, flags int, mask int, stx *unix.Statx_t) error {
				mu.Lock()
				isForeign := foreignFDs[dirfd]
				mu.Unlock()
				if isForeign || int32(dirfd) == openSelfFD.Load() {
					statxOnForeign.Add(1)
				}
				if err := unix.Statx(dirfd, path, flags, mask, stx); err != nil {
					return err
				}
				// Make statx's STATX_MNT_ID agree with fdinfo (42), except for disagree-file.bin.
				stx.Mask |= unix.STATX_MNT_ID
				if stx.Ino == disagreeFileSt.Ino && unix.Mkdev(stx.Dev_major, stx.Dev_minor) == uint64(disagreeFileSt.Dev) {
					stx.Mnt_id = 77
				} else {
					stx.Mnt_id = 42
				}
				return nil
			},
			fdinfoMountID: func(fd int) (uint64, bool) {
				if failStatfs.Load() {
					return 99, true
				}
				if int32(fd) == openSelfFD.Load() {
					return 99, true
				}
				mu.Lock()
				isForeign := foreignFDs[fd]
				mu.Unlock()
				if isForeign {
					return 99, true
				}
				return 42, true
			},
		}

		rootDir, err := sfs.OpenRoot(root, root, mountInfo{ID: 42, MountPoint: root})
		if err != nil {
			t.Fatalf("OpenRoot: %v", err)
		}
		defer rootDir.Close()

		// OpenDir (readable and searchOnly) rejects foreign mount via fdinfo BEFORE statx or opening ".".
		for _, searchOnly := range []bool{false, true} {
			if sub, err := rootDir.OpenDir("foreign-dir", filepath.Join(root, "foreign-dir"), searchOnly, false); err == nil {
				_ = sub.Close()
				t.Fatalf("OpenDir(foreign-dir, searchOnly=%v) succeeded", searchOnly)
			} else if !errors.Is(err, errWrongMount) {
				t.Fatalf("OpenDir(foreign-dir, searchOnly=%v) err = %v, want errWrongMount", searchOnly, err)
			}
		}

		// StatEntry rejects foreign mount via fdinfo BEFORE statx.
		if _, err := rootDir.StatEntry("foreign-file.bin", filepath.Join(root, "foreign-file.bin")); err == nil {
			t.Fatal("StatEntry(foreign-file.bin) succeeded")
		} else if !errors.Is(err, errWrongMount) {
			t.Fatalf("StatEntry(foreign-file.bin) err = %v, want errWrongMount", err)
		}

		// OpenSelf rejects mismatched reopened fd via fdinfo BEFORE statx.
		failOpenSelf.Store(true)
		if self, err := rootDir.OpenSelf(); err == nil {
			_ = self.Close()
			t.Fatal("OpenSelf succeeded with mismatched fdinfo mount ID")
		} else if !errors.Is(err, errWrongMount) {
			t.Fatalf("OpenSelf err = %v, want errWrongMount", err)
		}
		failOpenSelf.Store(false)
		openSelfFD.Store(-1)

		if statxOnForeign.Load() != 0 {
			t.Fatalf("statx called %d times on foreign/mismatched fds, want 0", statxOnForeign.Load())
		}
		if openDotOnForeign.Load() != 0 {
			t.Fatalf("openat2('.', O_DIRECTORY) called %d times on foreign dir fd, want 0", openDotOnForeign.Load())
		}

		// Defense in depth: statx reporting a STATX_MNT_ID disagreeing with fdinfo is rejected.
		if _, err := rootDir.StatEntry("disagree-file.bin", filepath.Join(root, "disagree-file.bin")); err == nil {
			t.Fatal("StatEntry(disagree-file.bin) succeeded when STATX_MNT_ID disagreed with fdinfo")
		} else if !errors.Is(err, errWrongMount) {
			t.Fatalf("StatEntry(disagree-file.bin) err = %v, want errWrongMount", err)
		}

		// Statfs rejects a descriptor whose fdinfo mount ID no longer matches.
		failStatfs.Store(true)
		if _, err := rootDir.Statfs(); !errors.Is(err, errWrongMount) {
			t.Fatalf("Statfs with mismatched fdinfo = %v, want errWrongMount", err)
		}
		failStatfs.Store(false)

		// Normal same-mount child still succeeds.
		okDir, err := rootDir.OpenDir("okdir", filepath.Join(root, "okdir"), false, false)
		if err != nil {
			t.Fatalf("OpenDir(okdir): %v", err)
		}
		_ = okDir.Close()
	})
}

func TestLinuxSparseFileCountsZeroAllocatedBytes(t *testing.T) {
	// Unit checks for entryStatFromStatx and entryStatFromUnix.
	sparseStx := &unix.Statx_t{
		Mask:   unix.STATX_MODE | unix.STATX_SIZE | unix.STATX_BLOCKS,
		Mode:   unix.S_IFREG | 0o644,
		Size:   100 << 30,
		Blocks: 0,
	}
	if got := entryStatFromStatx(sparseStx); got.AllocBytes != 0 || got.Size != 100<<30 {
		t.Fatalf("sparse statx = %+v, want AllocBytes=0 Size=100GiB", got)
	}

	// Filesystem omitting STATX_BLOCKS still falls back to STATX_SIZE.
	noBlocksStx := &unix.Statx_t{
		Mask: unix.STATX_MODE | unix.STATX_SIZE,
		Mode: unix.S_IFREG | 0o644,
		Size: 4096,
	}
	if got := entryStatFromStatx(noBlocksStx); got.AllocBytes != 4096 {
		t.Fatalf("statx without STATX_BLOCKS = %+v, want AllocBytes=4096", got)
	}

	sparseUnix := &unix.Stat_t{
		Mode:   unix.S_IFREG | 0o644,
		Size:   100 << 30,
		Blocks: 0,
	}
	if got := entryStatFromUnix(sparseUnix); got.AllocBytes != 0 || got.Size != 100<<30 {
		t.Fatalf("sparse Stat_t = %+v, want AllocBytes=0 Size=100GiB", got)
	}

	// End-to-end check on a real sparse file created with Truncate.
	root := t.TempDir()
	writeBytes(t, filepath.Join(root, "vms/real.bin"), 16*1024)
	sparsePath := filepath.Join(root, "vms/sparse-100m.raw")
	f, err := os.Create(sparsePath)
	if err != nil {
		t.Fatal(err)
	}
	if err := f.Truncate(100 << 20); err != nil {
		_ = f.Close()
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}

	var st unix.Stat_t
	if err := unix.Stat(sparsePath, &st); err != nil {
		t.Fatal(err)
	}
	if st.Blocks != 0 {
		t.Skipf("filesystem allocated %d blocks for truncated sparse file", st.Blocks)
	}

	mounts := []mountInfo{{ID: 10, ParentID: 1, MountPoint: "/", FSType: "ext4", Source: "/dev/nvme0n1p2"}}
	r := newTestRunner(t, root, mounts, nil)
	resp := r.DiskUsage(context.Background(), proto.DiskUsageRequest{Mount: "/"})
	if resp.Code != "" {
		t.Fatalf("unexpected error: %+v", resp)
	}
	var total uint64
	for _, fld := range resp.Folders {
		total += fld.Bytes
	}
	if total < 16*1024 || total >= 1<<20 {
		t.Fatalf("total walked bytes with 100 MiB sparse file = %d, want ~16 KiB (folders=%+v)", total, resp.Folders)
	}
}
