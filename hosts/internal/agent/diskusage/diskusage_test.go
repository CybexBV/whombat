package diskusage

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"rackoon/internal/proto"
)

func writeBytes(t *testing.T, path string, size int) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, size)
	for i := range buf {
		buf[i] = byte(i%251 + 1)
	}
	if err := os.WriteFile(path, buf, 0o644); err != nil {
		t.Fatal(err)
	}
}

func newTestRunner(t *testing.T, root string, mounts []mountInfo, inv *proto.Report) *Runner {
	t.Helper()
	fixedNow := time.Date(2026, 11, 21, 18, 0, 0, 0, time.UTC)
	r := &Runner{
		root: root,
		goos: "linux",
		inventory: func() *proto.Report {
			return inv
		},
		listMounts: func() ([]mountInfo, error) { return mounts, nil },
		statfs: func(string) (fsStat, error) {
			return fsStat{TotalBytes: 200 << 30, UsedBytes: 120 << 30}, nil
		},
		checkStandby:   func(context.Context, string) standbyState { return standbyAwake },
		runCmd:         func(context.Context, string, ...string) ([]byte, error) { return nil, os.ErrNotExist },
		now:            func() time.Time { return fixedNow },
		maxEntries:     DefaultMaxEntries,
		setLowPriority: func() {},
	}
	r.isUnraid = r.detectUnraid
	return r
}

func TestValidationAndMountTypes(t *testing.T) {
	root := t.TempDir()
	mounts := []mountInfo{
		{MountPoint: "/", FSType: "ext4", Source: "/dev/nvme0n1p2"},
		{MountPoint: "/mnt/nas", FSType: "nfs4", Source: "10.100.0.10:/export", Remote: true},
		{MountPoint: "/proc", FSType: "proc", Source: "proc", Virtual: true},
		{MountPoint: "/var/log", FSType: "tmpfs", Source: "tmpfs", Virtual: true},
	}
	r := newTestRunner(t, root, mounts, nil)

	for _, bad := range []string{"", "relative/path", "/var/../etc", "/bad\x00path", "/bad\npath", "/not-mounted"} {
		resp := r.DiskUsage(context.Background(), proto.DiskUsageRequest{Mount: bad})
		if resp.Code != CodeInvalid {
			t.Errorf("mount %q: code = %q, want %q", bad, resp.Code, CodeInvalid)
		}
	}
	if resp := r.DiskUsage(context.Background(), proto.DiskUsageRequest{Mount: "/mnt/nas"}); resp.Code != CodeInvalid {
		t.Errorf("remote mount: code = %q, want %q", resp.Code, CodeInvalid)
	}
	if resp := r.DiskUsage(context.Background(), proto.DiskUsageRequest{Mount: "/proc"}); resp.Code != CodeInvalid {
		t.Errorf("virtual mount: code = %q, want %q", resp.Code, CodeInvalid)
	}
	// On non-Unraid, tmpfs /var/log is refused as virtual.
	if resp := r.DiskUsage(context.Background(), proto.DiskUsageRequest{Mount: "/var/log"}); resp.Code != CodeInvalid {
		t.Errorf("non-unraid tmpfs /var/log: code = %q, want %q", resp.Code, CodeInvalid)
	}
	// On Unraid, tmpfs /var/log is allowed.
	writeBytes(t, filepath.Join(root, "etc/unraid-version"), 16)
	writeBytes(t, filepath.Join(root, "var/log/syslog"), 8192)
	if resp := r.DiskUsage(context.Background(), proto.DiskUsageRequest{Mount: "/var/log"}); resp.Code != "" {
		t.Errorf("unraid tmpfs /var/log: code = %q (%s), want empty", resp.Code, resp.Message)
	}
}

func TestSkipsSpunDownUnraidWithoutTouchingMount(t *testing.T) {
	root := t.TempDir()
	disksINI := `["disk1"]
name="disk1"
device="sdb"
type="Data"
spundown="1"
["disk2"]
name="disk2"
device="sdc"
type="Data"
spundown="0"
["cache"]
name="cache"
device="nvme0n1"
type="Cache"
spundown="0"
["media"]
name="media"
device="sdd"
type="Cache"
spundown="0"
["media2"]
name="media2"
device="sde"
type="Cache"
spundown="1"
`
	if err := os.MkdirAll(filepath.Join(root, "var/local/emhttp"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "var/local/emhttp/disks.ini"), []byte(disksINI), 0o644); err != nil {
		t.Fatal(err)
	}
	writeBytes(t, filepath.Join(root, "mnt/cache/appdata/db.bin"), 16384)

	mounts := []mountInfo{
		{MountPoint: "/mnt/disk1", FSType: "xfs", Source: "/dev/md1p1"},
		{MountPoint: "/mnt/cache", FSType: "btrfs", Source: "/dev/nvme0n1p1"},
		{MountPoint: "/mnt/media", FSType: "btrfs", Source: "/dev/sdd1"},
		{MountPoint: "/mnt/user", FSType: "fuse.shfs", Source: "shfs"},
	}

	var statfsCalled atomic.Int32
	r := newTestRunner(t, root, mounts, nil)
	r.statfs = func(string) (fsStat, error) {
		statfsCalled.Add(1)
		return fsStat{TotalBytes: 100 << 30, UsedBytes: 50 << 30}, nil
	}

	// /mnt/disk1 is spun down: refused before statfs or Lstat (note /mnt/disk1 does not even exist on disk).
	resp := r.DiskUsage(context.Background(), proto.DiskUsageRequest{Mount: "/mnt/disk1"})
	if resp.Code != CodeSpunDown || !slices.Equal(resp.SkippedSpunDown, []string{"disk1"}) {
		t.Fatalf("/mnt/disk1: %+v", resp)
	}
	if statfsCalled.Load() != 0 {
		t.Fatalf("statfs called %d times on spun-down /mnt/disk1", statfsCalled.Load())
	}

	// /mnt/user spans array + pools: disk1 and media2 are spun down -> skipped.
	resp = r.DiskUsage(context.Background(), proto.DiskUsageRequest{Mount: "/mnt/user"})
	if resp.Code != CodeSpunDown || !slices.Equal(resp.SkippedSpunDown, []string{"disk1", "media2"}) {
		t.Fatalf("/mnt/user: %+v", resp)
	}
	if statfsCalled.Load() != 0 {
		t.Fatalf("statfs called %d times on /mnt/user with sleeping disks", statfsCalled.Load())
	}

	// Multi-disk cache pool /mnt/media has member media2 spun down -> skipped.
	resp = r.DiskUsage(context.Background(), proto.DiskUsageRequest{Mount: "/mnt/media"})
	if resp.Code != CodeSpunDown || !slices.Equal(resp.SkippedSpunDown, []string{"media2"}) {
		t.Fatalf("/mnt/media: %+v", resp)
	}

	// /mnt/cache is awake -> measured normally.
	resp = r.DiskUsage(context.Background(), proto.DiskUsageRequest{Mount: "/mnt/cache"})
	if resp.Code != "" || len(resp.Folders) == 0 || resp.Folders[0].Path != "/mnt/cache/appdata" {
		t.Fatalf("/mnt/cache: %+v", resp)
	}
}

func TestSkipsSpunDownHDDViaInventoryAndStandbyProbe(t *testing.T) {
	root := t.TempDir()
	mounts := []mountInfo{
		{MountPoint: "/srv/archive", FSType: "ext4", Source: "/dev/sda1"},
		{MountPoint: "/srv/fast", FSType: "ext4", Source: "/dev/nvme0n1p1"},
	}
	writeBytes(t, filepath.Join(root, "srv/fast/data/blob.bin"), 16384)

	inv := &proto.Report{
		Filesystems: []proto.Filesystem{
			{Mount: "/srv/archive", Device: "/dev/sda1", FSType: "ext4", Disks: []string{"sda"}},
			{Mount: "/srv/fast", Device: "/dev/nvme0n1p1", FSType: "ext4", Disks: []string{"nvme0n1"}},
		},
		Disks: []proto.Disk{
			{Device: "sda", Type: "hdd", Standby: false},
			{Device: "nvme0n1", Type: "nvme"},
		},
	}

	var probed []string
	var statfsCalled atomic.Int32
	r := newTestRunner(t, root, mounts, inv)
	r.statfs = func(string) (fsStat, error) {
		statfsCalled.Add(1)
		return fsStat{TotalBytes: 100 << 30, UsedBytes: 10 << 30}, nil
	}
	r.checkStandby = func(_ context.Context, dev string) standbyState {
		probed = append(probed, dev)
		if dev == "sda" {
			return standbyAsleep
		}
		return standbyAwake
	}

	resp := r.DiskUsage(context.Background(), proto.DiskUsageRequest{Mount: "/srv/archive"})
	if resp.Code != CodeSpunDown || !slices.Equal(resp.SkippedSpunDown, []string{"sda"}) {
		t.Fatalf("/srv/archive: %+v", resp)
	}
	if statfsCalled.Load() != 0 {
		t.Fatalf("statfs called on sleeping HDD")
	}

	// NVMe backing /srv/fast is not rotational, so standby probe is skipped and walk runs.
	probed = nil
	resp = r.DiskUsage(context.Background(), proto.DiskUsageRequest{Mount: "/srv/fast"})
	if resp.Code != "" || len(probed) != 0 {
		t.Fatalf("/srv/fast: resp=%+v probed=%v", resp, probed)
	}

	// Standby already set in inventory skips without calling live probe.
	inv.Disks[0].Standby = true
	resp = r.DiskUsage(context.Background(), proto.DiskUsageRequest{Mount: "/srv/archive"})
	if resp.Code != CodeSpunDown || len(probed) != 0 {
		t.Fatalf("cached standby: resp=%+v probed=%v", resp, probed)
	}
}

func TestWalkStaysOnFilesystemSkipsSymlinksAndDeduplicatesHardlinks(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()

	// Real file in /srv/data (~32 KiB).
	orig := filepath.Join(root, "srv/data/keep.bin")
	writeBytes(t, orig, 32*1024)
	// Hardlink to the same inode in another folder: must only be counted once.
	if err := os.MkdirAll(filepath.Join(root, "srv/hardlink"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(orig, filepath.Join(root, "srv/hardlink/same.bin")); err != nil {
		t.Fatal(err)
	}
	// Symlink to a huge file outside: must NOT be followed.
	huge := filepath.Join(outside, "huge.bin")
	writeBytes(t, huge, 512*1024)
	if err := os.Symlink(huge, filepath.Join(root, "srv/data/link-to-huge")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "srv/link-dir")); err != nil {
		t.Fatal(err)
	}
	// Child mount point under / (/mnt/disk1): must be skipped even though in tests
	// it shares the tmpdir st_dev, proving mount boundary protection runs pre-Lstat.
	writeBytes(t, filepath.Join(root, "mnt/disk1/big.bin"), 256*1024)

	mounts := []mountInfo{
		{MountPoint: "/", FSType: "ext4", Source: "/dev/nvme0n1p2"},
		{MountPoint: "/mnt/disk1", FSType: "xfs", Source: "/dev/sdb1"},
	}

	var priorityCalled atomic.Bool
	r := newTestRunner(t, root, mounts, nil)
	r.setLowPriority = func() { priorityCalled.Store(true) }

	resp := r.DiskUsage(context.Background(), proto.DiskUsageRequest{Mount: "/"})
	if resp.Code != "" {
		t.Fatalf("unexpected error: %+v", resp)
	}
	if !priorityCalled.Load() {
		t.Fatal("low priority hook was not called")
	}
	var totalFolders uint64
	for _, f := range resp.Folders {
		if strings.HasPrefix(f.Path, "/mnt") {
			t.Errorf("crossed into child mount: %+v", f)
		}
		if strings.Contains(f.Path, "link-dir") {
			t.Errorf("followed directory symlink: %+v", f)
		}
		totalFolders += f.Bytes
	}
	// Hardlink deduplicated + huge symlink skipped -> total must be ~32 KiB (< 128 KiB).
	if totalFolders < 32*1024 || totalFolders >= 128*1024 {
		t.Fatalf("total folder bytes = %d, want ~32 KiB (folders=%+v)", totalFolders, resp.Folders)
	}
}

func TestDepthLimitAndEntryCapMarkPartial(t *testing.T) {
	root := t.TempDir()
	// Depth 1: /a, Depth 2: /a/b, Depth 3: /a/b/c/deep.bin
	writeBytes(t, filepath.Join(root, "a/shallow.bin"), 8192)
	writeBytes(t, filepath.Join(root, "a/b/c/deep.bin"), 128*1024)

	mounts := []mountInfo{{MountPoint: "/", FSType: "ext4", Source: "/dev/nvme0n1p2"}}
	r := newTestRunner(t, root, mounts, nil)

	resp := r.DiskUsage(context.Background(), proto.DiskUsageRequest{Mount: "/", MaxDepth: 2})
	if resp.Code != "" {
		t.Fatalf("unexpected error: %+v", resp)
	}
	if !resp.Partial {
		t.Fatalf("expected Partial=true when depth limit hit: %+v", resp)
	}
	for _, f := range resp.Folders {
		if f.Bytes >= 128*1024 {
			t.Errorf("traversed past depth limit: %+v", f)
		}
	}

	// Entry cap also marks Partial without failing.
	r.maxEntries = 1
	resp = r.DiskUsage(context.Background(), proto.DiskUsageRequest{Mount: "/", MaxDepth: 6})
	if resp.Code != "" || !resp.Partial {
		t.Fatalf("entry cap: %+v", resp)
	}
}

func TestCategoriesDockerJournalPackagesVMAndZFS(t *testing.T) {
	root := t.TempDir()

	// Create on-disk files for container logs, journal, package caches and VM images.
	writeBytes(t, filepath.Join(root, "var/lib/docker/containers/abc123/abc123-json.log"), 24*1024)
	writeBytes(t, filepath.Join(root, "var/lib/docker/volumes/pgdata/base.dat"), 16*1024)
	writeBytes(t, filepath.Join(root, "var/log/journal/mid/system.journal"), 40*1024)
	writeBytes(t, filepath.Join(root, "var/cache/apt/archives/pkg.deb"), 20*1024)
	writeBytes(t, filepath.Join(root, "var/cache/dnf/meta.rpm"), 12*1024)
	writeBytes(t, filepath.Join(root, "var/lib/libvirt/images/vm1.qcow2"), 64*1024)
	writeBytes(t, filepath.Join(root, "var/lib/libvirt/qemu/save/vm1.save"), 16*1024)

	// Start a mock Docker HTTP server over a unix socket.
	sockPath := filepath.Join(t.TempDir(), "docker.sock")
	ln, err := net.Listen("unix", sockPath)
	if err != nil {
		t.Fatal(err)
	}
	var dfTypes []string
	var dfCalls atomic.Int32
	mux := http.NewServeMux()
	mux.HandleFunc("/info", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"DockerRootDir": "/var/lib/docker"})
	})
	mux.HandleFunc("/system/df", func(w http.ResponseWriter, r *http.Request) {
		dfCalls.Add(1)
		dfTypes = append([]string(nil), r.URL.Query()["type"]...)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"LayersSize": 500_000_000,
			"Images": []map[string]any{
				{"Size": 300_000_000, "SharedSize": 50_000_000, "Containers": 2},
				{"Size": 250_000_000, "SharedSize": 50_000_000, "Containers": 0},
			},
			"Volumes": []map[string]any{
				{"UsageData": map[string]any{"Size": 120_000_000, "RefCount": 1}},
				{"UsageData": map[string]any{"Size": 30_000_000, "RefCount": 0}},
			},
			"BuildCache": []map[string]any{
				{"Size": 80_000_000, "InUse": false, "Shared": false},
				{"Size": 20_000_000, "InUse": true, "Shared": false},
			},
		})
	})
	srv := &http.Server{Handler: mux}
	go srv.Serve(ln)
	t.Cleanup(func() {
		srv.Close()
		ln.Close()
	})

	mounts := []mountInfo{{MountPoint: "/", FSType: "zfs", Source: "rpool/ROOT/pve-1"}}
	inv := &proto.Report{
		Pools: []proto.Pool{{Name: "rpool", Disks: []string{"nvme0n1"}}},
		Disks: []proto.Disk{{Device: "nvme0n1", Type: "nvme"}},
	}
	r := newTestRunner(t, root, mounts, inv)
	// Point directly to our temp unix socket (bypassing r.root prefix via abs seam check).
	r.dockerSockets = nil
	r.root = root
	// Place socket under root so hostPath finds it cleanly.
	inRootSock := filepath.Join(root, "var/run/docker.sock")
	if err := os.MkdirAll(filepath.Dir(inRootSock), 0o755); err != nil {
		t.Fatal(err)
	}
	ln2, err := net.Listen("unix", inRootSock)
	if err != nil {
		// Socket paths in deep temp dirs can exceed sun_path; skip socket creation inside root and link instead.
		if err := os.Symlink(sockPath, inRootSock); err != nil {
			t.Fatal(err)
		}
	} else {
		srv2 := &http.Server{Handler: mux}
		go srv2.Serve(ln2)
		t.Cleanup(func() {
			srv2.Close()
			ln2.Close()
		})
	}
	r.dockerSockets = []string{"/var/run/docker.sock"}

	// Stub zfs list for VM zvols and snapshots.
	r.runCmd = func(_ context.Context, name string, args ...string) ([]byte, error) {
		if name != "zfs" {
			return nil, os.ErrNotExist
		}
		return []byte(strings.Join([]string{
			"rpool/ROOT/pve-1\tfilesystem\t1000000\t50000000",
			"rpool/ROOT/pve-1/vm-101-disk-0\tvolume\t400000000\t25000000",
		}, "\n")), nil
	}

	resp := r.DiskUsage(context.Background(), proto.DiskUsageRequest{Mount: "/"})
	if resp.Code != "" {
		t.Fatalf("unexpected error: %+v", resp)
	}

	byKey := map[string]proto.DiskUsageCategory{}
	for _, c := range resp.Categories {
		byKey[c.Key] = c
	}

	if dfCalls.Load() != 1 || !slices.Equal(dfTypes, []string{"image", "build-cache"}) {
		t.Errorf("/system/df calls=%d types=%v, want 1 call with [image build-cache]", dfCalls.Load(), dfTypes)
	}
	if c := byKey[proto.DiskCatContainerImages]; c.Bytes != 500_000_000 || c.ReclaimableBytes != 200_000_000 {
		t.Errorf("container_images = %+v", c)
	}
	if c := byKey[proto.DiskCatContainerBuildCache]; c.Bytes != 100_000_000 || c.ReclaimableBytes != 80_000_000 {
		t.Errorf("container_build_cache = %+v", c)
	}
	// Volumes are measured with the agent's own bounded walk (16 KiB on disk), not dockerd's /system/df.
	if c := byKey[proto.DiskCatContainerVolumes]; c.Bytes < 16*1024 || c.Bytes >= 100*1024 {
		t.Errorf("container_volumes = %+v, want ~16 KiB from bounded local walk", c)
	}
	if c := byKey[proto.DiskCatContainerLogs]; c.Bytes < 24*1024 {
		t.Errorf("container_logs = %+v", c)
	}
	if c := byKey[proto.DiskCatJournal]; c.Bytes < 40*1024 {
		t.Errorf("journal = %+v", c)
	}
	if c := byKey[proto.DiskCatPackageCache]; c.Bytes < 32*1024 || !strings.Contains(c.Detail, "apt") || !strings.Contains(c.Detail, "dnf") {
		t.Errorf("package_cache = %+v", c)
	}
	if c := byKey[proto.DiskCatVMDisks]; c.Bytes < 400_000_000+64*1024 {
		t.Errorf("vm_disks = %+v", c)
	}
	if c := byKey[proto.DiskCatVMSnapshots]; c.Bytes < 75_000_000+16*1024 {
		t.Errorf("vm_snapshots = %+v", c)
	}
}

func TestConcurrencyGuardReturnsBusy(t *testing.T) {
	root := t.TempDir()
	mounts := []mountInfo{{MountPoint: "/", FSType: "ext4", Source: "/dev/nvme0n1p2"}}
	r := newTestRunner(t, root, mounts, nil)

	started := make(chan struct{})
	release := make(chan struct{})
	r.listMounts = func() ([]mountInfo, error) {
		close(started)
		<-release
		return mounts, nil
	}

	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		_ = r.DiskUsage(context.Background(), proto.DiskUsageRequest{Mount: "/"})
	}()

	<-started
	second := r.DiskUsage(context.Background(), proto.DiskUsageRequest{Mount: "/"})
	close(release)
	wg.Wait()

	if second.Code != CodeBusy {
		t.Fatalf("second concurrent call: code = %q, want %q", second.Code, CodeBusy)
	}
}

func TestPickLargestFoldersDrillsWrapperDirs(t *testing.T) {
	root := &dirNode{
		path:       "/",
		depth:      0,
		totalBytes: 120 << 30,
		children: []*dirNode{
			{
				path:       "/var",
				depth:      1,
				totalBytes: 100 << 30,
				children: []*dirNode{
					{
						path:       "/var/lib",
						depth:      2,
						totalBytes: 80 << 30,
						children: []*dirNode{
							{path: "/var/lib/docker", depth: 3, totalBytes: 78 << 30},
							{path: "/var/lib/apt", depth: 3, totalBytes: 2 << 30},
						},
					},
					{path: "/var/log", depth: 2, totalBytes: 20 << 30},
				},
			},
			{path: "/usr", depth: 1, totalBytes: 20 << 30},
		},
	}

	got := pickLargestFolders(root, 6, 10)
	var paths []string
	for _, f := range got {
		paths = append(paths, f.Path)
	}
	want := []string{"/var/lib/docker", "/usr", "/var/log", "/var/lib/apt"}
	if !slices.Equal(paths, want) {
		t.Fatalf("folders = %v, want %v", paths, want)
	}
}

func TestStandbyFromSmartctl(t *testing.T) {
	cases := []struct {
		name string
		out  string
		err  error
		want standbyState
	}{
		{
			name: "standby exit 3",
			out:  `{"smartctl":{"exit_status":3,"messages":[{"string":"Device is in STANDBY mode, exit(3)","severity":"information"}]}}`,
			err:  os.ErrInvalid,
			want: standbyAsleep,
		},
		{
			name: "standby OS mode exit 3",
			out:  `{"smartctl":{"exit_status":3,"messages":[{"string":"Device is in STANDBY (OS) mode, exit(3)","severity":"information"}]}}`,
			err:  os.ErrInvalid,
			want: standbyAsleep,
		},
		{
			name: "sleep exit 3",
			out:  `{"smartctl":{"exit_status":3,"messages":[{"string":"Device is in SLEEP mode, exit(3)","severity":"information"}]}}`,
			err:  os.ErrInvalid,
			want: standbyAsleep,
		},
		{
			name: "legacy standby exit 2",
			out:  `{"smartctl":{"exit_status":2,"messages":[{"string":"Device is in STANDBY mode, exit(2)"}]}}`,
			err:  os.ErrInvalid,
			want: standbyAsleep,
		},
		{
			name: "active or idle exit 0",
			out:  `{"power_mode":"ACTIVE or IDLE","smartctl":{"exit_status":0,"messages":[]}}`,
			err:  nil,
			want: standbyAwake,
		},
		{
			name: "active exit 0 without power_mode field",
			out:  `{"smartctl":{"exit_status":0,"messages":[]}}`,
			err:  nil,
			want: standbyAwake,
		},
		{
			name: "not implemented STATUS2 exit 5",
			out:  `{"smartctl":{"exit_status":5,"messages":[{"string":"CHECK POWER MODE not implemented, exit(5)","severity":"information"}]}}`,
			err:  os.ErrInvalid,
			want: standbyUnknown,
		},
		{
			name: "unknown power mode value STATUS2 exit 5",
			out:  `{"smartctl":{"exit_status":5,"messages":[{"string":"CHECK POWER MODE returned unknown value 0x99, exit(5)","severity":"information"}]}}`,
			err:  os.ErrInvalid,
			want: standbyUnknown,
		},
		{
			name: "incomplete response exit 5",
			out:  `{"smartctl":{"exit_status":5,"messages":[{"string":"CHECK POWER MODE: incomplete response, ATA output registers missing","severity":"warning"}]}}`,
			err:  os.ErrInvalid,
			want: standbyUnknown,
		},
		{
			name: "not implemented ignoring -n even with exit 0",
			out:  `{"smartctl":{"exit_status":0,"messages":[{"string":"CHECK POWER MODE not implemented, ignoring -n option","severity":"warning"}]}}`,
			err:  nil,
			want: standbyUnknown,
		},
		{
			name: "older smartctl rejects STATUS2 exit 1",
			out:  `{"smartctl":{"exit_status":1,"messages":[{"string":"=======> INVALID ARGUMENT TO -n: standby,3,5","severity":"error"}]}}`,
			err:  os.ErrInvalid,
			want: standbyUnknown,
		},
		{
			name: "permission error exit 2",
			out:  `{"smartctl":{"exit_status":2,"messages":[{"string":"Open device failed: Permission denied","severity":"error"}]}}`,
			err:  os.ErrPermission,
			want: standbyUnknown,
		},
		{
			name: "unrecognized power_mode even with exit 0",
			out:  `{"power_mode":"UNKNOWN","smartctl":{"exit_status":0,"messages":[]}}`,
			err:  nil,
			want: standbyUnknown,
		},
		{
			name: "non-JSON standby text",
			out:  "Device is in STANDBY mode, exit(3)\n",
			err:  os.ErrInvalid,
			want: standbyAsleep,
		},
		{
			name: "non-JSON error mentioning standby flag must not look asleep",
			out:  "=======> INVALID ARGUMENT TO -n: standby,3,5\nUse smartctl -h to get a usage summary\n",
			err:  os.ErrInvalid,
			want: standbyUnknown,
		},
		{
			name: "empty output",
			out:  "",
			err:  os.ErrInvalid,
			want: standbyUnknown,
		},
	}
	for _, tc := range cases {
		if got := standbyFromSmartctl([]byte(tc.out), tc.err); got != tc.want {
			t.Errorf("standbyFromSmartctl(%s) = %v, want %v", tc.name, got, tc.want)
		}
	}

	hdCases := []struct {
		name string
		out  string
		err  error
		want standbyState
	}{
		{"standby", "/dev/sda:\n drive state is:  standby\n", nil, standbyAsleep},
		{"sleeping", "/dev/sda:\n drive state is:  sleeping\n", nil, standbyAsleep},
		{"active/idle", "/dev/sda:\n drive state is:  active/idle\n", nil, standbyAwake},
		{"unknown", "/dev/sda:\n drive state is:  unknown\n", nil, standbyUnknown},
		{"sg_io error then unknown", "/dev/sda:\n SG_IO: bad/missing sense data, sb[]: 70 00 05\n drive state is:  unknown\n", nil, standbyUnknown},
		{"active/idle with command error", "/dev/sda:\n drive state is:  active/idle\n", os.ErrPermission, standbyUnknown},
		{"permission denied mentioning active", "/dev/sda: Permission denied (not active)\n", os.ErrPermission, standbyUnknown},
		{"empty output", "", nil, standbyUnknown},
	}
	for _, tc := range hdCases {
		if got := standbyFromHdparm([]byte(tc.out), tc.err); got != tc.want {
			t.Errorf("standbyFromHdparm(%s) = %v, want %v", tc.name, got, tc.want)
		}
	}
}

func TestStaysInsideRequestedMountNestedAndBindMounts(t *testing.T) {
	root := t.TempDir()

	// Files on /, /mnt/user (array), /mnt/cache/nested (NFS), /mnt/cache/bind (same-dev bind),
	// and real files on /mnt/cache itself.
	writeBytes(t, filepath.Join(root, "var/log/journal/mid/system.journal"), 64*1024)
	writeBytes(t, filepath.Join(root, "var/cache/apt/archives/pkg.deb"), 64*1024)
	writeBytes(t, filepath.Join(root, "var/lib/docker/containers/c1/c1-json.log"), 64*1024)
	writeBytes(t, filepath.Join(root, "var/lib/libvirt/images/root-vm.qcow2"), 64*1024)
	writeBytes(t, filepath.Join(root, "mnt/user/domains/array-vm.qcow2"), 128*1024)
	writeBytes(t, filepath.Join(root, "mnt/cache/nested/vms/nfs-vm.qcow2"), 256*1024)
	writeBytes(t, filepath.Join(root, "mnt/cache/bind/vms/bind-vm.qcow2"), 256*1024)
	writeBytes(t, filepath.Join(root, "mnt/cache/domains/cache-vm.qcow2"), 32*1024)

	// Intermediate symlink inside /mnt/cache pointing to /mnt/user: must never be followed.
	if err := os.Symlink(filepath.Join(root, "mnt/user"), filepath.Join(root, "mnt/cache/esc")); err != nil {
		t.Fatal(err)
	}
	// Non-Unraid Btrfs exposes its complete device list under /sys/fs/btrfs/<fsid>/devices/.
	if err := os.MkdirAll(filepath.Join(root, "sys/fs/btrfs/11111111-1111-1111-1111-111111111111/devices"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("../../../../devices/pci0/nvme0/nvme0n1/nvme0n1p1", filepath.Join(root, "sys/fs/btrfs/11111111-1111-1111-1111-111111111111/devices/nvme0n1p1")); err != nil {
		t.Fatal(err)
	}

	mounts := []mountInfo{
		{ID: 20, ParentID: 1, MountPoint: "/", FSType: "ext4", Source: "/dev/nvme0n1p2"},
		{ID: 30, ParentID: 20, MountPoint: "/mnt/cache", FSType: "btrfs", Source: "/dev/nvme0n1p1"},
		{ID: 31, ParentID: 30, MountPoint: "/mnt/cache/nested", FSType: "nfs4", Source: "10.100.0.10:/export", Remote: true},
		// Same-device bind mount beneath /mnt/cache: same st_dev in tests and on Linux, different mountinfo ID.
		{ID: 32, ParentID: 30, MountPoint: "/mnt/cache/bind", FSType: "btrfs", Source: "/dev/nvme0n1p1"},
		{ID: 33, ParentID: 20, MountPoint: "/mnt/user", FSType: "fuse.shfs", Source: "shfs"},
	}

	inv := &proto.Report{
		Libvirt: &proto.Platform{
			Libvirt: &proto.LibvirtDetail{
				Pools: []proto.LibvirtPool{
					{Name: "nfs", Type: "fs", Path: "/mnt/cache/nested/vms", Active: true},
					{Name: "bind", Type: "dir", Path: "/mnt/cache/bind/vms", Active: true},
					{Name: "esc", Type: "dir", Path: "/mnt/cache/esc/domains", Active: true},
					{Name: "cache", Type: "dir", Path: "/mnt/cache/domains", Active: true},
				},
				Folders: &proto.LibvirtFolders{Domains: "/mnt/user/domains"},
			},
		},
	}

	r := newTestRunner(t, root, mounts, inv)
	var mu sync.Mutex
	var touched []string
	recordTouch := func(logical string) {
		mu.Lock()
		touched = append(touched, logical)
		mu.Unlock()
	}
	r.scanFS = &recordingScanFS{
		inner: newDefaultScanFS(r),
		onOp:  recordTouch,
	}

	resp := r.DiskUsage(context.Background(), proto.DiskUsageRequest{Mount: "/mnt/cache"})
	if resp.Code != "" {
		t.Fatalf("unexpected error: %+v", resp)
	}

	if len(touched) == 0 {
		t.Fatal("expected recordingScanFS to observe filesystem operations inside /mnt/cache")
	}
	// No open, stat, or readdir may ever touch paths outside /mnt/cache or beneath nested/bind mounts.
	for _, p := range touched {
		if !hasPathPrefix(p, "/mnt/cache") {
			t.Errorf("scan escaped /mnt/cache to %q", p)
		}
		if hasPathPrefix(p, "/mnt/cache/nested") {
			t.Errorf("scan touched nested mount %q", p)
		}
		if hasPathPrefix(p, "/mnt/cache/bind") {
			t.Errorf("scan touched bind mount %q", p)
		}
		if p == "/mnt/cache/esc/domains" {
			t.Errorf("scan followed intermediate symlink to %q", p)
		}
	}

	for _, f := range resp.Folders {
		if hasPathPrefix(f.Path, "/mnt/cache/nested") || hasPathPrefix(f.Path, "/mnt/cache/bind") {
			t.Errorf("folder walk crossed into nested/bind mount: %+v", f)
		}
	}
	byKey := map[string]proto.DiskUsageCategory{}
	for _, c := range resp.Categories {
		byKey[c.Key] = c
	}
	if _, ok := byKey[proto.DiskCatJournal]; ok {
		t.Errorf("journal on / leaked into /mnt/cache scan: %+v", byKey[proto.DiskCatJournal])
	}
	if _, ok := byKey[proto.DiskCatPackageCache]; ok {
		t.Errorf("package cache on / leaked into /mnt/cache scan: %+v", byKey[proto.DiskCatPackageCache])
	}
	if _, ok := byKey[proto.DiskCatContainerLogs]; ok {
		t.Errorf("container logs on / leaked into /mnt/cache scan: %+v", byKey[proto.DiskCatContainerLogs])
	}
	vm := byKey[proto.DiskCatVMDisks]
	if vm.Bytes < 32*1024 || vm.Bytes >= 128*1024 {
		t.Errorf("vm_disks = %+v, want only /mnt/cache/domains (~32 KiB)", vm)
	}
}

func TestRootScanSkipsBindMountedDockerAndMountIDMismatch(t *testing.T) {
	root := t.TempDir()
	writeBytes(t, filepath.Join(root, "var/lib/docker/containers/c1/c1-json.log"), 64*1024)
	writeBytes(t, filepath.Join(root, "srv/same-dev-bind/big.bin"), 256*1024)
	writeBytes(t, filepath.Join(root, "srv/raced-bind/big.bin"), 256*1024)
	writeBytes(t, filepath.Join(root, "srv/keep/data.bin"), 24*1024)

	// /var/lib/libvirt is a symlink to /mnt/user/libvirt: scanning / must not follow it.
	writeBytes(t, filepath.Join(root, "mnt/user/libvirt/images/vm.qcow2"), 128*1024)
	if err := os.MkdirAll(filepath.Join(root, "var/lib"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(root, "mnt/user/libvirt"), filepath.Join(root, "var/lib/libvirt")); err != nil {
		t.Fatal(err)
	}

	mounts := []mountInfo{
		{ID: 10, ParentID: 1, MountPoint: "/", FSType: "ext4", Source: "/dev/nvme0n1p2"},
		{ID: 11, ParentID: 10, MountPoint: "/var/lib/docker", FSType: "ext4", Source: "/dev/nvme0n1p2"},
		{ID: 12, ParentID: 10, MountPoint: "/srv/same-dev-bind", FSType: "ext4", Source: "/dev/nvme0n1p2"},
		{ID: 13, ParentID: 10, MountPoint: "/mnt/user", FSType: "fuse.shfs", Source: "shfs"},
	}

	r := newTestRunner(t, root, mounts, nil)
	// Simulate a same-device bind mount at /srv/raced-bind not listed in mountinfo:
	// statMountID catches it by mount ID even though st_dev is identical.
	r.statMountID = func(logicalPath string) (uint64, bool) {
		if hasPathPrefix(logicalPath, "/srv/raced-bind") {
			return 99, true
		}
		return 10, true
	}

	resp := r.DiskUsage(context.Background(), proto.DiskUsageRequest{Mount: "/"})
	if resp.Code != "" {
		t.Fatalf("unexpected error: %+v", resp)
	}

	for _, c := range resp.Categories {
		if c.Key == proto.DiskCatContainerLogs || c.Key == proto.DiskCatVMDisks {
			t.Errorf("category %q crossed bind mount or symlink: %+v", c.Key, c)
		}
	}
	var total uint64
	for _, f := range resp.Folders {
		if hasPathPrefix(f.Path, "/srv/same-dev-bind") || hasPathPrefix(f.Path, "/srv/raced-bind") || hasPathPrefix(f.Path, "/var/lib/docker") {
			t.Errorf("walk crossed into bind mount: %+v", f)
		}
		total += f.Bytes
	}
	if total < 24*1024 || total >= 128*1024 {
		t.Errorf("total walked bytes = %d, want ~24 KiB (folders=%+v)", total, resp.Folders)
	}
}

func TestBuildMountScopeOvermountAndMountIDs(t *testing.T) {
	mounts := []mountInfo{
		{ID: 20, ParentID: 1, MountPoint: "/", FSType: "ext4", Source: "/dev/nvme0n1p2"},
		{ID: 30, ParentID: 20, MountPoint: "/mnt/data", FSType: "ext4", Source: "/dev/sda1"},
		{ID: 31, ParentID: 30, MountPoint: "/mnt/data/hidden-child", FSType: "ext4", Source: "/dev/sdb1"},
		{ID: 32, ParentID: 30, MountPoint: "/mnt/data", FSType: "xfs", Source: "/dev/sdc1"},
		{ID: 33, ParentID: 32, MountPoint: "/mnt/data/bind", FSType: "xfs", Source: "/dev/sdc1"},
	}
	scope, ok := buildMountScope(mounts, "/mnt/data")
	if !ok {
		t.Fatal("expected /mnt/data to resolve")
	}
	if scope.target.ID != 32 || scope.target.FSType != "xfs" {
		t.Fatalf("target = %+v, want overmount ID 32 (xfs)", scope.target)
	}
	if !scope.containsPath("/mnt/data/hidden-child/file") {
		t.Error("child under covered mount should not hide path on active overmount")
	}
	if scope.containsPath("/mnt/data/bind/file") {
		t.Error("bind mount under active overmount should be excluded by mount ID")
	}
}

func TestDockerVolumesMountScope(t *testing.T) {
	root := t.TempDir()
	writeBytes(t, filepath.Join(root, "var/lib/docker/volumes/app/data.bin"), 28*1024)
	writeBytes(t, filepath.Join(root, "var/lib/docker/volumes/mounted-vol/huge.bin"), 256*1024)

	sockDir, err := os.MkdirTemp("", "du-*")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(sockDir) })
	sockPath := filepath.Join(sockDir, "d.sock")
	ln, err := net.Listen("unix", sockPath)
	if err != nil {
		t.Fatal(err)
	}
	var dfCalls atomic.Int32
	mux := http.NewServeMux()
	mux.HandleFunc("/info", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"DockerRootDir": "/var/lib/docker"})
	})
	mux.HandleFunc("/system/df", func(w http.ResponseWriter, r *http.Request) {
		dfCalls.Add(1)
		_ = json.NewEncoder(w).Encode(map[string]any{"LayersSize": 100_000})
	})
	srv := &http.Server{Handler: mux}
	go srv.Serve(ln)
	t.Cleanup(func() {
		srv.Close()
		ln.Close()
	})
	inRootSock := filepath.Join(root, "var/run/docker.sock")
	if err := os.MkdirAll(filepath.Dir(inRootSock), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(sockPath, inRootSock); err != nil {
		t.Fatal(err)
	}

	mounts := []mountInfo{
		{ID: 1, ParentID: 0, MountPoint: "/", FSType: "ext4", Source: "/dev/nvme0n1p2"},
		{ID: 2, ParentID: 1, MountPoint: "/var/lib/docker/volumes", FSType: "ext4", Source: "/dev/nvme0n1p3"},
		{ID: 3, ParentID: 2, MountPoint: "/var/lib/docker/volumes/mounted-vol", FSType: "ext4", Source: "/dev/nvme0n1p3"},
	}

	r := newTestRunner(t, root, mounts, nil)
	r.dockerSockets = []string{"/var/run/docker.sock"}

	// Scanning /var/lib/docker/volumes: dockerRoot is on /, so /system/df must NOT be called;
	// volumes on this mount are measured locally while skipping the nested bind mount.
	resp := r.DiskUsage(context.Background(), proto.DiskUsageRequest{Mount: "/var/lib/docker/volumes"})
	if resp.Code != "" {
		t.Fatalf("unexpected error: %+v", resp)
	}
	if dfCalls.Load() != 0 {
		t.Errorf("/system/df called %d times when dockerRoot is outside target mount", dfCalls.Load())
	}
	var volBytes uint64
	for _, c := range resp.Categories {
		if c.Key == proto.DiskCatContainerVolumes {
			volBytes = c.Bytes
		}
	}
	if volBytes < 28*1024 || volBytes >= 128*1024 {
		t.Errorf("container_volumes = %d, want ~28 KiB (categories=%+v)", volBytes, resp.Categories)
	}
}

func TestFallbackBackingDisksPartitionLVMMdraidAndUnknownStandby(t *testing.T) {
	root := t.TempDir()

	// Build fake /dev + /sys tree with NO inventory report at all:
	// 1. /dev/sda1 -> partition of rotational sda
	// 2. /dev/mapper/vg0-archive -> ../dm-1 -> slaves md0 -> slaves sdb1, sdc1 -> disks sdb (HDD), sdc (HDD)
	// 3. /dev/sdd1 -> rotational sdd whose standby state is unknown
	// 4. /dev/sde1 -> non-rotational SSD sde (queue/rotational = 0)
	for _, dir := range []string{
		"dev/mapper",
		"sys/block/sda/queue",
		"sys/block/sdb/queue",
		"sys/block/sdc/queue",
		"sys/block/sdd/queue",
		"sys/block/sde/queue",
		"sys/class/block/dm-1/slaves",
		"sys/class/block/md0/slaves",
		"srv/part",
		"srv/lvm",
		"srv/unknown",
		"srv/ssd",
	} {
		if err := os.MkdirAll(filepath.Join(root, dir), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(root, "sys/block/sda/queue/rotational"), []byte("1\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "sys/block/sdb/queue/rotational"), []byte("1\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "sys/block/sdc/queue/rotational"), []byte("1\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "sys/block/sdd/queue/rotational"), []byte("1\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "sys/block/sde/queue/rotational"), []byte("0\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("../dm-1", filepath.Join(root, "dev/mapper/vg0-archive")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("../md0", filepath.Join(root, "sys/class/block/dm-1/slaves/md0")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("../sdb1", filepath.Join(root, "sys/class/block/md0/slaves/sdb1")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("../sdc1", filepath.Join(root, "sys/class/block/md0/slaves/sdc1")); err != nil {
		t.Fatal(err)
	}
	writeBytes(t, filepath.Join(root, "srv/ssd/data/file.bin"), 16*1024)

	mounts := []mountInfo{
		{ID: 1, MountPoint: "/srv/part", FSType: "ext4", Source: "/dev/sda1"},
		{ID: 2, MountPoint: "/srv/lvm", FSType: "xfs", Source: "/dev/mapper/vg0-archive"},
		{ID: 3, MountPoint: "/srv/unknown", FSType: "ext4", Source: "/dev/sdd1"},
		{ID: 4, MountPoint: "/srv/ssd", FSType: "ext4", Source: "/dev/sde1"},
	}

	var statfsCalled atomic.Int32
	r := newTestRunner(t, root, mounts, nil)
	r.statfs = func(string) (fsStat, error) {
		statfsCalled.Add(1)
		return fsStat{TotalBytes: 100 << 30, UsedBytes: 10 << 30}, nil
	}
	r.checkStandby = func(_ context.Context, dev string) standbyState {
		switch dev {
		case "sda", "sdc":
			return standbyAsleep
		case "sdb":
			return standbyAwake
		case "sdd":
			return standbyUnknown
		default:
			t.Errorf("unexpected standby probe for non-rotational dev %q", dev)
			return standbyUnknown
		}
	}

	// 1. Partition fallback: /dev/sda1 -> sda asleep -> skipped without touching mount.
	resp := r.DiskUsage(context.Background(), proto.DiskUsageRequest{Mount: "/srv/part"})
	if resp.Code != CodeSpunDown || !slices.Equal(resp.SkippedSpunDown, []string{"sda"}) {
		t.Fatalf("/srv/part: %+v", resp)
	}
	if statfsCalled.Load() != 0 {
		t.Fatalf("statfs called on sleeping partition backing disk")
	}

	// 2. LVM over mdraid fallback: dm-1 -> md0 -> sdb1, sdc1 -> sdc asleep -> skipped without touching mount.
	resp = r.DiskUsage(context.Background(), proto.DiskUsageRequest{Mount: "/srv/lvm"})
	if resp.Code != CodeSpunDown || !slices.Equal(resp.SkippedSpunDown, []string{"sdc"}) {
		t.Fatalf("/srv/lvm: %+v", resp)
	}
	if statfsCalled.Load() != 0 {
		t.Fatalf("statfs called on LVM/mdraid with sleeping member disk")
	}

	// 3. Unknown standby state on rotational disk -> skipped as standby_unknown (not spun_down) and never walked.
	resp = r.DiskUsage(context.Background(), proto.DiskUsageRequest{Mount: "/srv/unknown"})
	if resp.Code != CodeStandbyUnknown || len(resp.SkippedSpunDown) != 0 {
		t.Fatalf("/srv/unknown: %+v", resp)
	}
	if !strings.Contains(resp.Message, "sdd") || !strings.Contains(resp.Message, "could not be checked") || strings.Contains(resp.Message, "spun down") {
		t.Errorf("unknown standby message = %q, want truthful unknown-spin message without 'spun down'", resp.Message)
	}
	if statfsCalled.Load() != 0 {
		t.Fatalf("statfs called on rotational disk with unknown spin state")
	}

	// 4. Non-rotational SSD (queue/rotational == 0) is not probed and walks normally.
	resp = r.DiskUsage(context.Background(), proto.DiskUsageRequest{Mount: "/srv/ssd"})
	if resp.Code != "" || len(resp.Folders) == 0 {
		t.Fatalf("/srv/ssd: %+v", resp)
	}
}

func TestSkipsWhenBackingDisksOrRotationalStateUnknown(t *testing.T) {
	root := t.TempDir()
	writeBytes(t, filepath.Join(root, "tank/media/movie.mkv"), 16*1024)
	writeBytes(t, filepath.Join(root, "srv/no-sysfs/file.bin"), 16*1024)
	writeBytes(t, filepath.Join(root, "srv/bad-sysfs/file.bin"), 16*1024)
	writeBytes(t, filepath.Join(root, "srv/unresolved-dm/file.bin"), 16*1024)
	writeBytes(t, filepath.Join(root, "mnt/disk2/file.bin"), 16*1024)
	writeBytes(t, filepath.Join(root, "mnt/user/file.bin"), 16*1024)

	if err := os.MkdirAll(filepath.Join(root, "sys/block/sdb/queue"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "sys/block/sdb/queue/rotational"), []byte("?\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	mounts := []mountInfo{
		{ID: 1, MountPoint: "/tank/media", FSType: "zfs", Source: "tank/media", MajMin: "0:45"},
		{ID: 2, MountPoint: "/srv/no-sysfs", FSType: "ext4", Source: "/dev/sda1"},
		{ID: 3, MountPoint: "/srv/bad-sysfs", FSType: "ext4", Source: "/dev/sdb1"},
		{ID: 4, MountPoint: "/srv/unresolved-dm", FSType: "xfs", Source: "/dev/dm-9"},
		{ID: 5, MountPoint: "/mnt/user", FSType: "fuse.shfs", Source: "shfs"},
	}

	var statfsCalled atomic.Int32
	var probed []string
	var inv *proto.Report
	r := newTestRunner(t, root, mounts, nil)
	r.inventory = func() *proto.Report { return inv }
	r.statfs = func(string) (fsStat, error) {
		statfsCalled.Add(1)
		return fsStat{TotalBytes: 100 << 30, UsedBytes: 10 << 30}, nil
	}
	r.checkStandby = func(_ context.Context, dev string) standbyState {
		probed = append(probed, dev)
		return standbyAwake
	}

	// 1. ZFS mount with nil inventory: backing disks unknown -> skipped as standby_unknown without touching mount.
	resp := r.DiskUsage(context.Background(), proto.DiskUsageRequest{Mount: "/tank/media"})
	if resp.Code != CodeStandbyUnknown || len(resp.SkippedSpunDown) != 0 || !strings.Contains(resp.Message, "backing disks") || strings.Contains(resp.Message, "spun down") {
		t.Fatalf("zfs without inventory: %+v", resp)
	}
	if statfsCalled.Load() != 0 {
		t.Fatalf("statfs called on ZFS mount without pool inventory")
	}

	// 2. ZFS mount with inventory that has no disks for that pool -> still skipped as standby_unknown without touching mount.
	inv = &proto.Report{
		Pools: []proto.Pool{{Name: "tank", Disks: nil}},
	}
	resp = r.DiskUsage(context.Background(), proto.DiskUsageRequest{Mount: "/tank/media"})
	if resp.Code != CodeStandbyUnknown || len(resp.SkippedSpunDown) != 0 || !strings.Contains(resp.Message, "backing disks") || strings.Contains(resp.Message, "spun down") {
		t.Fatalf("zfs with empty pool disks: %+v", resp)
	}
	if statfsCalled.Load() != 0 {
		t.Fatalf("statfs called on ZFS mount with empty pool disks")
	}

	// 3. ZFS mount with pool disks whose rotational state is missing -> skipped as standby_unknown without touching mount.
	inv = &proto.Report{
		Pools: []proto.Pool{{Name: "tank", Disks: []string{"sdc"}}},
	}
	resp = r.DiskUsage(context.Background(), proto.DiskUsageRequest{Mount: "/tank/media"})
	if resp.Code != CodeStandbyUnknown || len(resp.SkippedSpunDown) != 0 || !strings.Contains(resp.Message, "sdc") || !strings.Contains(resp.Message, "disk type") || strings.Contains(resp.Message, "spun down") {
		t.Fatalf("zfs with unknown rotational disk: %+v", resp)
	}
	if statfsCalled.Load() != 0 || len(probed) != 0 {
		t.Fatalf("touched ZFS mount or probed unknown rotational disk: statfs=%d probed=%v", statfsCalled.Load(), probed)
	}

	// 4. ZFS mount with usable pool inventory and confirmed awake HDD -> probed and scanned cleanly.
	inv = &proto.Report{
		Pools: []proto.Pool{{Name: "tank", Disks: []string{"sdc"}}},
		Disks: []proto.Disk{{Device: "sdc", Type: "hdd"}},
	}
	resp = r.DiskUsage(context.Background(), proto.DiskUsageRequest{Mount: "/tank/media"})
	if resp.Code != "" || !slices.Equal(probed, []string{"sdc"}) {
		t.Fatalf("zfs with awake HDD: resp=%+v probed=%v", resp, probed)
	}
	inv = nil
	probed = nil
	statfsCalled.Store(0)

	// 5. Block device whose /sys/block/<dev>/queue/rotational cannot be read -> skipped as standby_unknown without waking.
	resp = r.DiskUsage(context.Background(), proto.DiskUsageRequest{Mount: "/srv/no-sysfs"})
	if resp.Code != CodeStandbyUnknown || len(resp.SkippedSpunDown) != 0 || !strings.Contains(resp.Message, "sda") || !strings.Contains(resp.Message, "disk type") || strings.Contains(resp.Message, "spun down") {
		t.Fatalf("/srv/no-sysfs: %+v", resp)
	}
	if statfsCalled.Load() != 0 || len(probed) != 0 {
		t.Fatalf("touched /srv/no-sysfs: statfs=%d probed=%v", statfsCalled.Load(), probed)
	}

	// 6. Malformed queue/rotational -> skipped as standby_unknown without waking.
	resp = r.DiskUsage(context.Background(), proto.DiskUsageRequest{Mount: "/srv/bad-sysfs"})
	if resp.Code != CodeStandbyUnknown || len(resp.SkippedSpunDown) != 0 || !strings.Contains(resp.Message, "sdb") || !strings.Contains(resp.Message, "disk type") || strings.Contains(resp.Message, "spun down") {
		t.Fatalf("/srv/bad-sysfs: %+v", resp)
	}
	if statfsCalled.Load() != 0 || len(probed) != 0 {
		t.Fatalf("touched /srv/bad-sysfs: statfs=%d probed=%v", statfsCalled.Load(), probed)
	}

	// 7. Stacked device (dm-9) with no resolvable slaves and no inventory -> skipped as standby_unknown without waking.
	resp = r.DiskUsage(context.Background(), proto.DiskUsageRequest{Mount: "/srv/unresolved-dm"})
	if resp.Code != CodeStandbyUnknown || len(resp.SkippedSpunDown) != 0 || !strings.Contains(resp.Message, "backing disks") || strings.Contains(resp.Message, "spun down") {
		t.Fatalf("/srv/unresolved-dm: %+v", resp)
	}
	if statfsCalled.Load() != 0 {
		t.Fatalf("statfs called on unresolved dm-9")
	}

	// 7b. Multi-PV dm-10 spanning an NVMe partition AND an unresolved md9 -> skipped as standby_unknown rather than passing blind on md9.
	if err := os.MkdirAll(filepath.Join(root, "sys/class/block/dm-10/slaves"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("../nvme0n1p1", filepath.Join(root, "sys/class/block/dm-10/slaves/nvme0n1p1")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("../md9", filepath.Join(root, "sys/class/block/dm-10/slaves/md9")); err != nil {
		t.Fatal(err)
	}
	rMixed := newTestRunner(t, root, []mountInfo{{ID: 7, MountPoint: "/srv/unresolved-dm", FSType: "xfs", Source: "/dev/dm-10"}}, nil)
	rMixed.statfs = r.statfs
	resp = rMixed.DiskUsage(context.Background(), proto.DiskUsageRequest{Mount: "/srv/unresolved-dm"})
	if resp.Code != CodeStandbyUnknown || len(resp.SkippedSpunDown) != 0 || !strings.Contains(resp.Message, "not all") || strings.Contains(resp.Message, "spun down") {
		t.Fatalf("multi-PV dm-10 with unresolved md9: %+v", resp)
	}
	if statfsCalled.Load() != 0 {
		t.Fatalf("statfs called on multi-PV dm-10 with unresolved md9")
	}

	// 8. Unraid fuse.shfs without disks.ini or inventory -> skipped as standby_unknown without waking.
	resp = r.DiskUsage(context.Background(), proto.DiskUsageRequest{Mount: "/mnt/user"})
	if resp.Code != CodeStandbyUnknown || len(resp.SkippedSpunDown) != 0 || !strings.Contains(resp.Message, "backing disks") || strings.Contains(resp.Message, "spun down") {
		t.Fatalf("shfs without metadata: %+v", resp)
	}
	if statfsCalled.Load() != 0 {
		t.Fatalf("statfs called on shfs without metadata")
	}

	// 9. Unraid awake array disk via disks.ini (/dev/md2p1) scans cleanly without sysfs for md2 or sdc.
	if err := os.MkdirAll(filepath.Join(root, "var/local/emhttp"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "var/local/emhttp/disks.ini"), []byte("[\"disk2\"]\nname=\"disk2\"\ndevice=\"sdc\"\ntype=\"Data\"\nspundown=\"0\"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	r2 := newTestRunner(t, root, []mountInfo{{ID: 6, MountPoint: "/mnt/disk2", FSType: "xfs", Source: "/dev/md2p1"}}, nil)
	resp = r2.DiskUsage(context.Background(), proto.DiskUsageRequest{Mount: "/mnt/disk2"})
	if resp.Code != "" {
		t.Fatalf("awake Unraid /mnt/disk2: %+v", resp)
	}
}

func TestHungReadRespectsDeadlineAndFreesBusyFlag(t *testing.T) {
	root := t.TempDir()
	writeBytes(t, filepath.Join(root, "data/file.bin"), 16*1024)
	mounts := []mountInfo{{ID: 1, MountPoint: "/", FSType: "ext4", Source: "/dev/nvme0n1p2"}}

	r := newTestRunner(t, root, mounts, nil)
	r.hangGrace = 15 * time.Millisecond

	unblock := make(chan struct{})
	t.Cleanup(func() { close(unblock) })
	var calls atomic.Int32
	r.readDir = func(logicalPath string) ([]fs.DirEntry, error) {
		if calls.Add(1) == 1 {
			<-unblock
		}
		return os.ReadDir(r.hostPath(logicalPath))
	}

	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Millisecond)
	defer cancel()

	start := time.Now()
	resp := r.DiskUsage(ctx, proto.DiskUsageRequest{Mount: "/"})
	elapsed := time.Since(start)
	if resp.Code != CodeFailed || !resp.Partial {
		t.Fatalf("hung scan = %+v, want CodeFailed with Partial=true", resp)
	}
	if elapsed > 2*time.Second {
		t.Fatalf("hung scan took %v, expected prompt deadline exit", elapsed)
	}

	// Busy flag must be freed immediately so the next measurement runs instead of returning CodeBusy.
	next := r.DiskUsage(context.Background(), proto.DiskUsageRequest{Mount: "/"})
	if next.Code != "" || len(next.Folders) == 0 {
		t.Fatalf("subsequent scan after hung read = %+v, want normal completion", next)
	}
}

func TestUnreadableDirectoryMarksPartial(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "secret"), 0o755); err != nil {
		t.Fatal(err)
	}
	writeBytes(t, filepath.Join(root, "var/log/journal/locked/system.journal"), 16*1024)
	mounts := []mountInfo{{ID: 1, MountPoint: "/", FSType: "ext4", Source: "/dev/nvme0n1p2"}}

	// 1. Unreadable directory during mount walk marks Partial even when nothing else is readable.
	r := newTestRunner(t, root, mounts, nil)
	r.readDir = func(logicalPath string) ([]fs.DirEntry, error) {
		if logicalPath == "/secret" {
			return nil, fs.ErrPermission
		}
		return os.ReadDir(r.hostPath(logicalPath))
	}
	resp := r.DiskUsage(context.Background(), proto.DiskUsageRequest{Mount: "/"})
	if resp.Code != "" || !resp.Partial {
		t.Fatalf("unreadable /secret: resp = %+v, want Code='' and Partial=true", resp)
	}

	// 2. Unreadable directory inside a category probe marks Partial.
	r2 := newTestRunner(t, root, mounts, nil)
	r2.readDir = func(logicalPath string) ([]fs.DirEntry, error) {
		if logicalPath == "/var/log/journal/locked" {
			return nil, fs.ErrPermission
		}
		return os.ReadDir(r2.hostPath(logicalPath))
	}
	resp2 := r2.DiskUsage(context.Background(), proto.DiskUsageRequest{Mount: "/"})
	if resp2.Code != "" || !resp2.Partial {
		t.Fatalf("unreadable journal dir: resp = %+v, want Code='' and Partial=true", resp2)
	}

	// 3. Real filesystem permission denial when not running as root.
	if os.Geteuid() != 0 {
		locked := filepath.Join(t.TempDir(), "noperm")
		if err := os.MkdirAll(locked, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(locked, 0o000); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = os.Chmod(locked, 0o755) })
		r3 := newTestRunner(t, filepath.Dir(locked), mounts, nil)
		resp3 := r3.DiskUsage(context.Background(), proto.DiskUsageRequest{Mount: "/"})
		if resp3.Code != "" || !resp3.Partial {
			t.Fatalf("chmod 0000 dir: resp = %+v, want Code='' and Partial=true", resp3)
		}
	}
}

func TestDarwinAPFSInternalAndExternalDisks(t *testing.T) {
	root := t.TempDir()
	writeBytes(t, filepath.Join(root, "Users/jdoe/data.bin"), 32*1024)
	writeBytes(t, filepath.Join(root, "System/Volumes/Data/Users/jdoe/blob.bin"), 24*1024)
	writeBytes(t, filepath.Join(root, "Volumes/FastSSD/work.bin"), 16*1024)
	writeBytes(t, filepath.Join(root, "Volumes/ExtHDD/archive.bin"), 16*1024)
	writeBytes(t, filepath.Join(root, "Volumes/UnknownUSB/file.bin"), 16*1024)
	writeBytes(t, filepath.Join(root, "Volumes/Fusion/media.bin"), 16*1024)
	writeBytes(t, filepath.Join(root, "Volumes/AppDMG/app.bin"), 16*1024)

	// Plant a Linux /sys entry that says rotational=0 to prove Darwin never falls back to /sys.
	if err := os.MkdirAll(filepath.Join(root, "sys/block/disk9/queue"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "sys/block/disk9/queue/rotational"), []byte("0\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	readMacFixture := func(name string) []byte {
		t.Helper()
		b, err := os.ReadFile(filepath.Join("..", "macos", "testdata", name))
		if err != nil {
			t.Fatal(err)
		}
		return b
	}
	disk0Plist := readMacFixture("diskutil_info_disk0.plist")
	disk3Plist := readMacFixture("diskutil_info_disk3.plist")
	disk4Plist := readMacFixture("diskutil_info_disk4.plist")

	extSSDPlist := []byte(`<?xml version="1.0"?><plist version="1.0"><dict>
		<key>DeviceIdentifier</key><string>disk8</string>
		<key>ParentWholeDisk</key><string>disk8</string>
		<key>BusProtocol</key><string>USB</string>
		<key>Internal</key><false/>
		<key>SolidState</key><true/>
		<key>VirtualOrPhysical</key><string>Physical</string>
	</dict></plist>`)
	extHDDPlist := []byte(`<?xml version="1.0"?><plist version="1.0"><dict>
		<key>DeviceIdentifier</key><string>disk9</string>
		<key>ParentWholeDisk</key><string>disk9</string>
		<key>BusProtocol</key><string>USB</string>
		<key>Internal</key><false/>
		<key>SolidState</key><false/>
		<key>VirtualOrPhysical</key><string>Physical</string>
	</dict></plist>`)
	unknownUSBPlist := []byte(`<?xml version="1.0"?><plist version="1.0"><dict>
		<key>DeviceIdentifier</key><string>disk10</string>
		<key>ParentWholeDisk</key><string>disk10</string>
		<key>BusProtocol</key><string>USB</string>
		<key>Internal</key><false/>
		<key>VirtualOrPhysical</key><string>Physical</string>
	</dict></plist>`)
	fusionContainerPlist := []byte(`<?xml version="1.0"?><plist version="1.0"><dict>
		<key>DeviceIdentifier</key><string>disk11</string>
		<key>ParentWholeDisk</key><string>disk11</string>
		<key>APFSContainerReference</key><string>disk11</string>
		<key>APFSPhysicalStores</key><array>
			<dict><key>APFSPhysicalStore</key><string>disk0s2</string></dict>
			<dict><key>APFSPhysicalStore</key><string>disk9s2</string></dict>
		</array>
		<key>VirtualOrPhysical</key><string>Virtual</string>
	</dict></plist>`)
	dmgContainerPlist := []byte(`<?xml version="1.0"?><plist version="1.0"><dict>
		<key>DeviceIdentifier</key><string>disk5</string>
		<key>ParentWholeDisk</key><string>disk5</string>
		<key>APFSContainerReference</key><string>disk5</string>
		<key>APFSPhysicalStores</key><array>
			<dict><key>APFSPhysicalStore</key><string>disk4s1</string></dict>
		</array>
		<key>VirtualOrPhysical</key><string>Virtual</string>
	</dict></plist>`)

	mounts := []mountInfo{
		{ID: 1, MountPoint: "/", FSType: "apfs", Source: "/dev/disk3s3s1"},
		{ID: 2, MountPoint: "/System/Volumes/Data", FSType: "apfs", Source: "/dev/disk3s1"},
		{ID: 3, MountPoint: "/Volumes/FastSSD", FSType: "apfs", Source: "/dev/disk8s1"},
		{ID: 4, MountPoint: "/Volumes/ExtHDD", FSType: "hfs", Source: "/dev/disk9s2"},
		{ID: 5, MountPoint: "/Volumes/UnknownUSB", FSType: "exfat", Source: "/dev/disk10s1"},
		{ID: 6, MountPoint: "/Volumes/Fusion", FSType: "apfs", Source: "/dev/disk11s1"},
		{ID: 7, MountPoint: "/Volumes/AppDMG", FSType: "apfs", Source: "/dev/disk5s1"},
	}

	var diskutilCalls []string
	var probed []string
	hddState := standbyUnknown
	var inv *proto.Report

	r := newTestRunner(t, root, mounts, nil)
	r.goos = "darwin"
	r.inventory = func() *proto.Report { return inv }
	r.checkStandby = func(_ context.Context, dev string) standbyState {
		probed = append(probed, dev)
		if dev == "disk9" {
			return hddState
		}
		return standbyUnknown
	}
	r.runCmd = func(_ context.Context, name string, args ...string) ([]byte, error) {
		if name != "diskutil" || len(args) < 3 || args[0] != "info" || args[1] != "-plist" {
			return nil, os.ErrNotExist
		}
		diskutilCalls = append(diskutilCalls, args[2])
		switch args[2] {
		case "disk0":
			return disk0Plist, nil
		case "disk3":
			return disk3Plist, nil
		case "disk4":
			return disk4Plist, nil
		case "disk5":
			return dmgContainerPlist, nil
		case "disk8":
			return extSSDPlist, nil
		case "disk9":
			return extHDDPlist, nil
		case "disk10":
			return unknownUSBPlist, nil
		case "disk11":
			return fusionContainerPlist, nil
		default:
			return nil, os.ErrNotExist
		}
	}

	// 1. Internal Mac APFS root (/dev/disk3s3s1) with macos collector inventory -> scans without diskutil or standby probe.
	inv = &proto.Report{
		Filesystems: []proto.Filesystem{
			{Mount: "/", Device: "/dev/disk3", FSType: "apfs", Disks: []string{"disk0"}},
		},
		Disks: []proto.Disk{
			{Device: "disk0", Type: "nvme", Model: "APPLE SSD AP1024Z"},
		},
	}
	resp := r.DiskUsage(context.Background(), proto.DiskUsageRequest{Mount: "/"})
	if resp.Code != "" || len(diskutilCalls) != 0 || len(probed) != 0 {
		t.Fatalf("mac / with inventory: resp=%+v diskutil=%v probed=%v", resp, diskutilCalls, probed)
	}

	// 2. Sibling APFS volume (/System/Volumes/Data, /dev/disk3s1) matches /dev/disk3 in inventory -> scans cleanly.
	resp = r.DiskUsage(context.Background(), proto.DiskUsageRequest{Mount: "/System/Volumes/Data"})
	if resp.Code != "" || len(diskutilCalls) != 0 || len(probed) != 0 {
		t.Fatalf("mac Data volume with inventory: resp=%+v diskutil=%v probed=%v", resp, diskutilCalls, probed)
	}

	// 3. No inventory at all: resolves /dev/disk3s3s1 -> disk3 -> disk0 via diskutil info -plist -> internal SSD scans cleanly.
	inv = nil
	resp = r.DiskUsage(context.Background(), proto.DiskUsageRequest{Mount: "/"})
	if resp.Code != "" || !slices.Equal(diskutilCalls, []string{"disk3", "disk0"}) || len(probed) != 0 {
		t.Fatalf("mac / via diskutil fallback: resp=%+v diskutil=%v probed=%v", resp, diskutilCalls, probed)
	}

	// 4. External SSD (SolidState=true) -> scans cleanly without probing standby.
	diskutilCalls = nil
	resp = r.DiskUsage(context.Background(), proto.DiskUsageRequest{Mount: "/Volumes/FastSSD"})
	if resp.Code != "" || len(probed) != 0 {
		t.Fatalf("mac external SSD: resp=%+v probed=%v", resp, probed)
	}

	// 5. External HDD (SolidState=false) with unknown power state -> skips as standby_unknown (never falls back to /sys).
	hddState = standbyUnknown
	resp = r.DiskUsage(context.Background(), proto.DiskUsageRequest{Mount: "/Volumes/ExtHDD"})
	if resp.Code != CodeStandbyUnknown || len(resp.SkippedSpunDown) != 0 || !slices.Equal(probed, []string{"disk9"}) {
		t.Fatalf("mac external HDD unknown: resp=%+v probed=%v", resp, probed)
	}

	// 6. External HDD asleep -> skips as spun_down naming disk9.
	probed = nil
	hddState = standbyAsleep
	resp = r.DiskUsage(context.Background(), proto.DiskUsageRequest{Mount: "/Volumes/ExtHDD"})
	if resp.Code != CodeSpunDown || !slices.Equal(resp.SkippedSpunDown, []string{"disk9"}) {
		t.Fatalf("mac external HDD asleep: resp=%+v", resp)
	}

	// 7. External HDD confirmed awake -> scans cleanly.
	probed = nil
	hddState = standbyAwake
	resp = r.DiskUsage(context.Background(), proto.DiskUsageRequest{Mount: "/Volumes/ExtHDD"})
	if resp.Code != "" || !slices.Equal(probed, []string{"disk9"}) {
		t.Fatalf("mac external HDD awake: resp=%+v probed=%v", resp, probed)
	}

	// 8. External USB enclosure omitting SolidState -> skips as standby_unknown without waking.
	probed = nil
	resp = r.DiskUsage(context.Background(), proto.DiskUsageRequest{Mount: "/Volumes/UnknownUSB"})
	if resp.Code != CodeStandbyUnknown || len(probed) != 0 || !strings.Contains(resp.Message, "disk10") {
		t.Fatalf("mac unknown SolidState USB: resp=%+v probed=%v", resp, probed)
	}

	// 9. Multi-store APFS container (Fusion Drive: disk0 SSD + disk9 HDD) skips when HDD member is asleep.
	hddState = standbyAsleep
	resp = r.DiskUsage(context.Background(), proto.DiskUsageRequest{Mount: "/Volumes/Fusion"})
	if resp.Code != CodeSpunDown || !slices.Equal(resp.SkippedSpunDown, []string{"disk9"}) {
		t.Fatalf("mac fusion asleep HDD: resp=%+v", resp)
	}

	// 10. Mounted .dmg disk image (virtual APFS -> virtual disk4) -> skips as standby_unknown.
	resp = r.DiskUsage(context.Background(), proto.DiskUsageRequest{Mount: "/Volumes/AppDMG"})
	if resp.Code != CodeStandbyUnknown || !strings.Contains(resp.Message, "backing disks") {
		t.Fatalf("mac dmg virtual disk: resp=%+v", resp)
	}

	// 11. When diskutil is unavailable and inventory has no disks, Darwin must NOT read /sys/block/disk9/queue/rotational.
	rNoDiskutil := newTestRunner(t, root, []mountInfo{{ID: 4, MountPoint: "/Volumes/ExtHDD", FSType: "hfs", Source: "/dev/disk9s2"}}, nil)
	rNoDiskutil.goos = "darwin"
	resp = rNoDiskutil.DiskUsage(context.Background(), proto.DiskUsageRequest{Mount: "/Volumes/ExtHDD"})
	if resp.Code != CodeStandbyUnknown {
		t.Fatalf("mac without diskutil must not fall back to /sys: resp=%+v", resp)
	}
}

func TestVirtualMachineGuestDisksScanWithoutWakingPassthroughHDD(t *testing.T) {
	root := t.TempDir()
	writeFile := func(rel, content string) {
		t.Helper()
		p := filepath.Join(root, rel)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	// All virtual disks report rotational=1 (typical KVM/Proxmox/Hetzner/VMware/Hyper-V/VBox guests).
	for _, dev := range []string{"vda", "xvda", "sda", "sdb", "sdc", "sdd", "sde", "sdf", "sdg", "sdh"} {
		writeFile("sys/block/"+dev+"/queue/rotational", "1\n")
	}
	// sda: QEMU/Hetzner/Proxmox virtio-scsi disk.
	writeFile("sys/block/sda/device/vendor", "QEMU    \n")
	writeFile("sys/block/sda/device/model", "QEMU HARDDISK   \n")
	// sdb: VMware virtual SCSI disk.
	writeFile("sys/block/sdb/device/vendor", "VMware, \n")
	writeFile("sys/block/sdb/device/model", "VMware Virtual S\n")
	// sdc: VirtualBox AHCI disk (vendor is ATA, model names VBOX).
	writeFile("sys/block/sdc/device/vendor", "ATA     \n")
	writeFile("sys/block/sdc/device/model", "VBOX HARDDISK   \n")
	// sdd: Hyper-V / Azure virtual disk.
	writeFile("sys/block/sdd/device/vendor", "Msft    \n")
	writeFile("sys/block/sdd/device/model", "Virtual Disk    \n")
	// sde: virtio-scsi disk with custom model identified via sysfs virtio bus symlink.
	if err := os.MkdirAll(filepath.Join(root, "sys/class/block"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("../../devices/pci0000:00/0000:00:05.0/virtio2/host0/target0:0:0/0:0:0:0/block/sde", filepath.Join(root, "sys/class/block/sde")); err != nil {
		t.Fatal(err)
	}
	// sdf: Passed-through real physical HDD inside the VM (must still be checked!).
	writeFile("sys/block/sdf/device/vendor", "ATA     \n")
	writeFile("sys/block/sdf/device/model", "WDC WD181KFGX-68CKWN0\n")
	// sdg: Hardware RAID logical disk (Dell PERC "Virtual Disk" — must NOT be treated as a VM disk!).
	writeFile("sys/block/sdg/device/vendor", "DELL    \n")
	writeFile("sys/block/sdg/device/model", "Virtual Disk    \n")
	// sdh: LVM on top of vda2.
	if err := os.MkdirAll(filepath.Join(root, "sys/class/block/dm-0/slaves"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("../vda2", filepath.Join(root, "sys/class/block/dm-0/slaves/vda2")); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, "dev/mapper"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("../dm-0", filepath.Join(root, "dev/mapper/vg-root")); err != nil {
		t.Fatal(err)
	}

	for _, mp := range []string{"vm/vda", "vm/xvd", "vm/qemu", "vm/vmware", "vm/vbox", "vm/hyperv", "vm/virtio", "vm/lvm", "vm/pass", "vm/raid", "vm/lxc"} {
		writeBytes(t, filepath.Join(root, mp, "file.bin"), 16*1024)
	}

	mounts := []mountInfo{
		{ID: 1, MountPoint: "/vm/vda", FSType: "ext4", Source: "/dev/vda1"},
		{ID: 2, MountPoint: "/vm/xvd", FSType: "ext4", Source: "/dev/xvda1"},
		{ID: 3, MountPoint: "/vm/qemu", FSType: "ext4", Source: "/dev/sda1"},
		{ID: 4, MountPoint: "/vm/vmware", FSType: "ext4", Source: "/dev/sdb1"},
		{ID: 5, MountPoint: "/vm/vbox", FSType: "ext4", Source: "/dev/sdc1"},
		{ID: 6, MountPoint: "/vm/hyperv", FSType: "ext4", Source: "/dev/sdd1"},
		{ID: 7, MountPoint: "/vm/virtio", FSType: "ext4", Source: "/dev/sde1"},
		{ID: 8, MountPoint: "/vm/lvm", FSType: "ext4", Source: "/dev/mapper/vg-root"},
		{ID: 9, MountPoint: "/vm/pass", FSType: "ext4", Source: "/dev/sdf1"},
		{ID: 10, MountPoint: "/vm/raid", FSType: "ext4", Source: "/dev/sdg1"},
		{ID: 11, MountPoint: "/vm/lxc", FSType: "ext4", Source: "/dev/loop0"},
	}

	// Inventory says vda and sda are Type:"hdd" (because lsblk saw rota=1) and Host.Virtual="kvm".
	inv := &proto.Report{
		Host: proto.HostInfo{Virtual: "kvm"},
		Disks: []proto.Disk{
			{Device: "vda", Type: "hdd"},
			{Device: "sda", Type: "hdd", Model: "QEMU HARDDISK"},
			{Device: "sdf", Type: "hdd", Model: "WDC WD181KFGX-68CKWN0"},
		},
		Filesystems: []proto.Filesystem{
			{Mount: "/vm/vda", Device: "/dev/vda1", FSType: "ext4", Disks: []string{"vda"}},
			{Mount: "/vm/qemu", Device: "/dev/sda1", FSType: "ext4", Disks: []string{"sda"}},
			{Mount: "/vm/pass", Device: "/dev/sdf1", FSType: "ext4", Disks: []string{"sdf"}},
		},
	}

	var probed []string
	var statfsCalled atomic.Int32
	r := newTestRunner(t, root, mounts, inv)
	r.statfs = func(string) (fsStat, error) {
		statfsCalled.Add(1)
		return fsStat{TotalBytes: 100 << 30, UsedBytes: 10 << 30}, nil
	}
	r.checkStandby = func(_ context.Context, dev string) standbyState {
		probed = append(probed, dev)
		if dev == "sdf" {
			return standbyAsleep
		}
		return standbyUnknown
	}

	// All virtual guest disks scan cleanly without invoking smartctl/hdparm.
	for _, mp := range []string{"/vm/vda", "/vm/xvd", "/vm/qemu", "/vm/vmware", "/vm/vbox", "/vm/hyperv", "/vm/virtio", "/vm/lvm"} {
		probed = nil
		resp := r.DiskUsage(context.Background(), proto.DiskUsageRequest{Mount: mp})
		if resp.Code != "" || len(probed) != 0 {
			t.Errorf("%s: resp=%+v probed=%v, want clean scan with no standby probe", mp, resp, probed)
		}
	}

	// Passed-through physical HDD inside the VM must STILL be checked and skip when asleep.
	probed = nil
	statfsCalled.Store(0)
	resp := r.DiskUsage(context.Background(), proto.DiskUsageRequest{Mount: "/vm/pass"})
	if resp.Code != CodeSpunDown || !slices.Equal(resp.SkippedSpunDown, []string{"sdf"}) || statfsCalled.Load() != 0 {
		t.Fatalf("/vm/pass: resp=%+v statfs=%d", resp, statfsCalled.Load())
	}

	// Hardware RAID "Virtual Disk" (DELL) must NOT be misclassified as a VM disk; unknown standby skips as standby_unknown.
	probed = nil
	statfsCalled.Store(0)
	resp = r.DiskUsage(context.Background(), proto.DiskUsageRequest{Mount: "/vm/raid"})
	if resp.Code != CodeStandbyUnknown || !slices.Equal(probed, []string{"sdg"}) || statfsCalled.Load() != 0 {
		t.Fatalf("/vm/raid: resp=%+v probed=%v statfs=%d", resp, probed, statfsCalled.Load())
	}

	// LXC loop0 root skips as standby_unknown without claiming "spun down".
	probed = nil
	statfsCalled.Store(0)
	resp = r.DiskUsage(context.Background(), proto.DiskUsageRequest{Mount: "/vm/lxc"})
	if resp.Code != CodeStandbyUnknown || len(resp.SkippedSpunDown) != 0 || strings.Contains(resp.Message, "spun down") || statfsCalled.Load() != 0 {
		t.Fatalf("/vm/lxc: resp=%+v statfs=%d", resp, statfsCalled.Load())
	}
}

func TestMultiDeviceBtrfsChecksAllMembersAndFailsClosed(t *testing.T) {
	root := t.TempDir()
	mkdir := func(rel string) {
		t.Helper()
		if err := os.MkdirAll(filepath.Join(root, rel), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	writeFile := func(rel, content string) {
		t.Helper()
		mkdir(filepath.Dir(rel))
		if err := os.WriteFile(filepath.Join(root, rel), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	symlink := func(target, rel string) {
		t.Helper()
		mkdir(filepath.Dir(rel))
		if err := os.Symlink(target, filepath.Join(root, rel)); err != nil {
			t.Fatal(err)
		}
	}

	writeFile("sys/block/sda/queue/rotational", "1\n")
	writeFile("sys/block/sdb/queue/rotational", "1\n")
	writeFile("sys/block/sdc/queue/rotational", "1\n")
	writeFile("sys/block/sdd/queue/rotational", "0\n")

	// Global Btrfs features dir must be ignored when matching FSIDs.
	mkdir("sys/fs/btrfs/features")

	// Pool 1 (/mnt/pool): mount source is awake NVMe (nvme0n1p1), second member is HDD sdb1.
	symlink("../../../../devices/pci0/nvme0n1/nvme0n1p1", "sys/fs/btrfs/aaaa-1111/devices/nvme0n1p1")
	symlink("../../../../devices/pci0/sdb/sdb1", "sys/fs/btrfs/aaaa-1111/devices/sdb1")

	// Pool 2 (/mnt/luks-btrfs): Btrfs over two LUKS dm devices (dm-0 -> sda1, dm-1 -> sdc1).
	writeFile("sys/block/dm-0/dm/name", "crypt_btrfs0\n")
	symlink("../sda1", "sys/class/block/dm-0/slaves/sda1")
	symlink("../sdc1", "sys/class/block/dm-1/slaves/sdc1")
	symlink("../../../../devices/virtual/block/dm-0", "sys/fs/btrfs/bbbb-2222/devices/dm-0")
	symlink("../../../../devices/virtual/block/dm-1", "sys/fs/btrfs/bbbb-2222/devices/dm-1")

	// Pool 3 (/mnt/loop-btrfs): one SSD member + one unresolved loop0 member.
	symlink("../../../../devices/pci0/sdd/sdd1", "sys/fs/btrfs/cccc-3333/devices/sdd1")
	symlink("../../../../devices/virtual/block/loop0", "sys/fs/btrfs/cccc-3333/devices/loop0")

	// Pool 4 (/mnt/unmatched-btrfs): /dev/sde1 is not present under /sys/fs/btrfs -> must fail closed.
	writeFile("sys/block/sde/queue/rotational", "0\n")

	for _, dir := range []string{"mnt/pool/data", "mnt/luks-btrfs/data", "mnt/loop-btrfs/data", "mnt/unmatched-btrfs/data"} {
		writeBytes(t, filepath.Join(root, dir, "file.bin"), 16*1024)
	}

	mounts := []mountInfo{
		{ID: 1, MountPoint: "/mnt/pool", FSType: "btrfs", Source: "/dev/nvme0n1p1", MajMin: "0:45"},
		{ID: 2, MountPoint: "/mnt/luks-btrfs", FSType: "btrfs", Source: "/dev/mapper/crypt_btrfs0", MajMin: "0:46"},
		{ID: 3, MountPoint: "/mnt/loop-btrfs", FSType: "btrfs", Source: "/dev/sdd1", MajMin: "0:47"},
		{ID: 4, MountPoint: "/mnt/unmatched-btrfs", FSType: "btrfs", Source: "/dev/sde1", MajMin: "0:48"},
	}

	states := map[string]standbyState{
		"sda": standbyAwake,
		"sdb": standbyAsleep,
		"sdc": standbyAsleep,
	}
	var inv *proto.Report
	var statfsCalled atomic.Int32
	var probed []string

	r := newTestRunner(t, root, mounts, nil)
	r.inventory = func() *proto.Report { return inv }
	r.statfs = func(string) (fsStat, error) {
		statfsCalled.Add(1)
		return fsStat{TotalBytes: 100 << 30, UsedBytes: 10 << 30}, nil
	}
	r.checkStandby = func(_ context.Context, dev string) standbyState {
		probed = append(probed, dev)
		if st, ok := states[dev]; ok {
			return st
		}
		return standbyUnknown
	}

	// 1. Multi-device Btrfs: mount source is awake NVMe, second member sdb is asleep -> skips as spun_down without touching mount.
	resp := r.DiskUsage(context.Background(), proto.DiskUsageRequest{Mount: "/mnt/pool"})
	if resp.Code != CodeSpunDown || !slices.Equal(resp.SkippedSpunDown, []string{"sdb"}) || statfsCalled.Load() != 0 {
		t.Fatalf("multi-device btrfs sleeping member: resp=%+v statfs=%d", resp, statfsCalled.Load())
	}

	// 2. Multi-device Btrfs: second member sdb standby is unknown -> skips as standby_unknown without claiming spun down.
	states["sdb"] = standbyUnknown
	resp = r.DiskUsage(context.Background(), proto.DiskUsageRequest{Mount: "/mnt/pool"})
	if resp.Code != CodeStandbyUnknown || len(resp.SkippedSpunDown) != 0 || strings.Contains(resp.Message, "spun down") || statfsCalled.Load() != 0 {
		t.Fatalf("multi-device btrfs unknown member: resp=%+v statfs=%d", resp, statfsCalled.Load())
	}

	// 3. Multi-device Btrfs: second member sdb already flagged Standby in inventory (even when fs.Disks is empty) -> skips as spun_down without probing.
	probed = nil
	inv = &proto.Report{
		Disks: []proto.Disk{
			{Device: "nvme0n1", Type: "nvme"},
			{Device: "sdb", Type: "hdd", Standby: true},
		},
	}
	resp = r.DiskUsage(context.Background(), proto.DiskUsageRequest{Mount: "/mnt/pool"})
	if resp.Code != CodeSpunDown || !slices.Equal(resp.SkippedSpunDown, []string{"sdb"}) || len(probed) != 0 || statfsCalled.Load() != 0 {
		t.Fatalf("multi-device btrfs inventory standby: resp=%+v probed=%v statfs=%d", resp, probed, statfsCalled.Load())
	}
	inv = nil

	// 4. Multi-device Btrfs: all members awake -> scans cleanly.
	states["sdb"] = standbyAwake
	resp = r.DiskUsage(context.Background(), proto.DiskUsageRequest{Mount: "/mnt/pool"})
	if resp.Code != "" || len(resp.Folders) == 0 {
		t.Fatalf("multi-device btrfs all awake: %+v", resp)
	}

	// 5. Multi-device Btrfs over LUKS: dm-0 (sda awake) + dm-1 (sdc asleep) -> catches sleeping sdc without touching mount.
	statfsCalled.Store(0)
	resp = r.DiskUsage(context.Background(), proto.DiskUsageRequest{Mount: "/mnt/luks-btrfs"})
	if resp.Code != CodeSpunDown || !slices.Equal(resp.SkippedSpunDown, []string{"sdc"}) || statfsCalled.Load() != 0 {
		t.Fatalf("btrfs over luks sleeping member: resp=%+v statfs=%d", resp, statfsCalled.Load())
	}
	states["sdc"] = standbyAwake
	resp = r.DiskUsage(context.Background(), proto.DiskUsageRequest{Mount: "/mnt/luks-btrfs"})
	if resp.Code != "" {
		t.Fatalf("btrfs over luks all awake: %+v", resp)
	}

	// 6. Btrfs with an unresolved loop0 member -> skips as standby_unknown without touching mount.
	statfsCalled.Store(0)
	resp = r.DiskUsage(context.Background(), proto.DiskUsageRequest{Mount: "/mnt/loop-btrfs"})
	if resp.Code != CodeStandbyUnknown || len(resp.SkippedSpunDown) != 0 || statfsCalled.Load() != 0 {
		t.Fatalf("btrfs with loop member: resp=%+v statfs=%d", resp, statfsCalled.Load())
	}

	// 7. Btrfs missing from /sys/fs/btrfs fails closed even if inventory listed one SSD disk.
	statfsCalled.Store(0)
	inv = &proto.Report{
		Disks:       []proto.Disk{{Device: "sde", Type: "ssd"}},
		Filesystems: []proto.Filesystem{{Mount: "/mnt/unmatched-btrfs", FSType: "btrfs", Device: "/dev/sde1", Disks: []string{"sde"}}},
	}
	resp = r.DiskUsage(context.Background(), proto.DiskUsageRequest{Mount: "/mnt/unmatched-btrfs"})
	if resp.Code != CodeStandbyUnknown || len(resp.SkippedSpunDown) != 0 || statfsCalled.Load() != 0 {
		t.Fatalf("btrfs missing from sysfs with partial inventory: resp=%+v statfs=%d", resp, statfsCalled.Load())
	}
}

func TestMultiDeviceClassBcachefsLVMmdraidZFSUnionAndDevPaths(t *testing.T) {
	root := t.TempDir()
	mkdir := func(rel string) {
		t.Helper()
		if err := os.MkdirAll(filepath.Join(root, rel), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	writeFile := func(rel, content string) {
		t.Helper()
		mkdir(filepath.Dir(rel))
		if err := os.WriteFile(filepath.Join(root, rel), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	symlink := func(target, rel string) {
		t.Helper()
		mkdir(filepath.Dir(rel))
		if err := os.Symlink(target, filepath.Join(root, rel)); err != nil {
			t.Fatal(err)
		}
	}

	writeFile("sys/block/sda/queue/rotational", "0\n")
	writeFile("sys/block/sdb/queue/rotational", "1\n")
	writeFile("sys/block/sdc/queue/rotational", "1\n")
	writeFile("sys/block/sdd/queue/rotational", "1\n")
	// ZFS zvol reports rotational=0 even over a sleeping HDD pool; must still fail closed!
	writeFile("sys/block/zd0/queue/rotational", "0\n")

	// 1. bcachefs multi-device: mount source lists sda1:sdb1, sysfs also shows dev-2 -> sdc1 (added later).
	symlink("../../../../devices/pci0/sda/sda1", "sys/fs/bcachefs/1111-bch/dev-0/block")
	symlink("../../../../devices/pci0/sdb/sdb1", "sys/fs/bcachefs/1111-bch/dev-1/block")
	symlink("../../../../devices/pci0/sdc/sdc1", "sys/fs/bcachefs/1111-bch/dev-2/block")
	// bcachefs UUID= with two awake members.
	symlink("../../../../devices/pci0/nvme0n1/nvme0n1p1", "sys/fs/bcachefs/2222-uuid/dev-0/block")
	symlink("../../../../devices/pci0/sda/sda2", "sys/fs/bcachefs/2222-uuid/dev-1/block")
	// bcachefs with incomplete dev-1 (missing block symlink).
	symlink("../../../../devices/pci0/nvme0n1/nvme0n1p2", "sys/fs/bcachefs/3333-bad/dev-0/block")
	mkdir("sys/fs/bcachefs/3333-bad/dev-1")

	// 2. Multi-PV LVM thin pool: dm-5 (thin LV) -> dm-4 (tpool) -> {dm-2 (tdata -> sda3), dm-3 (tmeta -> sdd1)}.
	symlink("../dm-4", "sys/class/block/dm-5/slaves/dm-4")
	symlink("../dm-2", "sys/class/block/dm-4/slaves/dm-2")
	symlink("../dm-3", "sys/class/block/dm-4/slaves/dm-3")
	symlink("../sda3", "sys/class/block/dm-2/slaves/sda3")
	symlink("../sdd1", "sys/class/block/dm-3/slaves/sdd1")
	symlink("../dm-5", "dev/mapper/vg0-thinlv")

	// 2b. Multi-PV LVM with one resolved PV and one unresolved md9, even if inventory lists sda.
	symlink("../sda4", "sys/class/block/dm-6/slaves/sda4")
	symlink("../md9", "sys/class/block/dm-6/slaves/md9")

	// 3. Partitioned mdraid (/dev/md0p1 -> md0) and md/dev-* fallback (/dev/md/named -> md1).
	symlink("../sda5", "sys/class/block/md0/slaves/sda5")
	symlink("../sdb2", "sys/class/block/md0/slaves/sdb2")
	symlink("../md1", "dev/md/named")
	symlink("../../../sda6", "sys/block/md1/md/dev-sda6/block")
	symlink("../../../sdc2", "sys/block/md1/md/dev-sdc2/block")

	// 4. /dev/root resolved via /sys/dev/block/8:1 -> sda1.
	symlink("../../devices/pci0/sda/sda1", "sys/dev/block/8:1")

	for _, dir := range []string{
		"mnt/bch", "mnt/bch-uuid", "mnt/bch-bad", "mnt/bch-missing",
		"mnt/lvm-thin", "mnt/lvm-partial", "mnt/md-part", "mnt/md-named",
		"mnt/zfs-multi", "mnt/zfs-snap", "mnt/zfs-loop", "mnt/zvol",
		"mnt/merger", "mnt/union", "mnt/overlay", "mnt/dev-root", "mnt/dev-root-bad", "mnt/bad-uuid",
	} {
		writeBytes(t, filepath.Join(root, dir, "data/item.bin"), 16*1024)
	}

	mounts := []mountInfo{
		{ID: 1, MountPoint: "/mnt/bch", FSType: "bcachefs", Source: "/dev/sda1:/dev/sdb1", MajMin: "0:50"},
		{ID: 2, MountPoint: "/mnt/bch-uuid", FSType: "bcachefs", Source: "UUID=2222-uuid", MajMin: "0:51"},
		{ID: 3, MountPoint: "/mnt/bch-bad", FSType: "bcachefs", Source: "/dev/nvme0n1p2", MajMin: "0:52"},
		{ID: 4, MountPoint: "/mnt/bch-missing", FSType: "bcachefs", Source: "/dev/nvme0n1p9", MajMin: "0:53"},
		{ID: 5, MountPoint: "/mnt/lvm-thin", FSType: "ext4", Source: "/dev/mapper/vg0-thinlv", MajMin: "253:5"},
		{ID: 6, MountPoint: "/mnt/lvm-partial", FSType: "ext4", Source: "/dev/dm-6", MajMin: "253:6"},
		{ID: 7, MountPoint: "/mnt/md-part", FSType: "xfs", Source: "/dev/md0p1", MajMin: "259:1"},
		{ID: 8, MountPoint: "/mnt/md-named", FSType: "xfs", Source: "/dev/md/named", MajMin: "9:1"},
		{ID: 9, MountPoint: "/mnt/zfs-multi", FSType: "zfs", Source: "tank/media", MajMin: "0:54"},
		{ID: 10, MountPoint: "/mnt/zfs-snap", FSType: "zfs", Source: "tank@nightly", MajMin: "0:55"},
		{ID: 11, MountPoint: "/mnt/zfs-loop", FSType: "zfs", Source: "looppool/data", MajMin: "0:56"},
		{ID: 12, MountPoint: "/mnt/zvol", FSType: "ext4", Source: "/dev/zd0p1", MajMin: "230:1"},
		{ID: 13, MountPoint: "/mnt/merger", FSType: "fuse.mergerfs", Source: "/mnt/d1:/mnt/d2", MajMin: "0:60"},
		{ID: 14, MountPoint: "/mnt/union", FSType: "fuse.unionfs-fuse", Source: "/mnt/d1=RW:/mnt/d2=RO", MajMin: "0:61"},
		{ID: 15, MountPoint: "/mnt/overlay", FSType: "overlay", Source: "overlay", MajMin: "0:62"},
		{ID: 16, MountPoint: "/mnt/dev-root", FSType: "ext4", Source: "/dev/root", MajMin: "8:1"},
		{ID: 17, MountPoint: "/mnt/dev-root-bad", FSType: "ext4", Source: "/dev/root", MajMin: "0:63"},
		{ID: 18, MountPoint: "/mnt/bad-uuid", FSType: "ext4", Source: "/dev/disk/by-uuid/does-not-exist", MajMin: "0:64"},
	}

	inv := &proto.Report{
		Disks: []proto.Disk{
			{Device: "nvme0n1", Type: "nvme"},
			{Device: "sda", Type: "ssd"},
			{Device: "sdb", Type: "hdd"},
			{Device: "sdc", Type: "hdd"},
			{Device: "sdd", Type: "hdd"},
		},
		Filesystems: []proto.Filesystem{
			// Deliberately partial inventory for dm-6: must NOT hide unresolved md9!
			{Mount: "/mnt/lvm-partial", FSType: "ext4", Device: "/dev/dm-6", Disks: []string{"sda"}},
			// Deliberately partial inventory for mergerfs: must still fail closed!
			{Mount: "/mnt/merger", FSType: "fuse.mergerfs", Device: "/mnt/d1:/mnt/d2", Disks: []string{"sda"}},
		},
		Pools: []proto.Pool{
			{Name: "tank", Disks: []string{"nvme0n1", "sdb"}},
			{Name: "looppool", Disks: []string{"sda", "loop0"}},
		},
	}

	states := map[string]standbyState{
		"sdb": standbyAwake,
		"sdc": standbyAsleep,
		"sdd": standbyAsleep,
	}
	var statfsCalled atomic.Int32
	r := newTestRunner(t, root, mounts, inv)
	r.statfs = func(string) (fsStat, error) {
		statfsCalled.Add(1)
		return fsStat{TotalBytes: 100 << 30, UsedBytes: 10 << 30}, nil
	}
	r.checkStandby = func(_ context.Context, dev string) standbyState {
		if st, ok := states[dev]; ok {
			return st
		}
		return standbyUnknown
	}

	// bcachefs: sda+sdb in Source are awake, but 3rd member sdc in sysfs is asleep -> spun_down without touching mount.
	resp := r.DiskUsage(context.Background(), proto.DiskUsageRequest{Mount: "/mnt/bch"})
	if resp.Code != CodeSpunDown || !slices.Equal(resp.SkippedSpunDown, []string{"sdc"}) || statfsCalled.Load() != 0 {
		t.Fatalf("bcachefs 3rd member asleep: resp=%+v statfs=%d", resp, statfsCalled.Load())
	}
	// bcachefs UUID= with all SSD/NVMe members -> scans cleanly.
	resp = r.DiskUsage(context.Background(), proto.DiskUsageRequest{Mount: "/mnt/bch-uuid"})
	if resp.Code != "" {
		t.Fatalf("bcachefs UUID awake: %+v", resp)
	}
	// bcachefs incomplete dev-1 or missing sysfs -> standby_unknown without touching mount.
	for _, mp := range []string{"/mnt/bch-bad", "/mnt/bch-missing"} {
		statfsCalled.Store(0)
		resp = r.DiskUsage(context.Background(), proto.DiskUsageRequest{Mount: mp})
		if resp.Code != CodeStandbyUnknown || statfsCalled.Load() != 0 {
			t.Fatalf("%s: resp=%+v statfs=%d", mp, resp, statfsCalled.Load())
		}
	}

	// Multi-PV LVM thin pool: sleeping sdd behind dm-5->dm-4->dm-3 -> spun_down, then awake -> scans cleanly.
	statfsCalled.Store(0)
	resp = r.DiskUsage(context.Background(), proto.DiskUsageRequest{Mount: "/mnt/lvm-thin"})
	if resp.Code != CodeSpunDown || !slices.Equal(resp.SkippedSpunDown, []string{"sdd"}) || statfsCalled.Load() != 0 {
		t.Fatalf("lvm thin sleeping sdd: resp=%+v statfs=%d", resp, statfsCalled.Load())
	}
	states["sdd"] = standbyAwake
	resp = r.DiskUsage(context.Background(), proto.DiskUsageRequest{Mount: "/mnt/lvm-thin"})
	if resp.Code != "" {
		t.Fatalf("lvm thin awake: %+v", resp)
	}

	// Multi-PV LVM with unresolved md9 fails closed even though inventory listed sda.
	statfsCalled.Store(0)
	resp = r.DiskUsage(context.Background(), proto.DiskUsageRequest{Mount: "/mnt/lvm-partial"})
	if resp.Code != CodeStandbyUnknown || statfsCalled.Load() != 0 {
		t.Fatalf("lvm partial with inventory: resp=%+v statfs=%d", resp, statfsCalled.Load())
	}

	// Partitioned mdraid (/dev/md0p1) scans when both sda and sdb are awake, skips if sdb sleeps.
	resp = r.DiskUsage(context.Background(), proto.DiskUsageRequest{Mount: "/mnt/md-part"})
	if resp.Code != "" {
		t.Fatalf("md0p1 awake: %+v", resp)
	}
	states["sdb"] = standbyAsleep
	statfsCalled.Store(0)
	resp = r.DiskUsage(context.Background(), proto.DiskUsageRequest{Mount: "/mnt/md-part"})
	if resp.Code != CodeSpunDown || !slices.Equal(resp.SkippedSpunDown, []string{"sdb"}) || statfsCalled.Load() != 0 {
		t.Fatalf("md0p1 sleeping sdb: resp=%+v statfs=%d", resp, statfsCalled.Load())
	}
	// Named mdraid (/dev/md/named -> md1 via md/dev-*) catches sleeping sdc.
	statfsCalled.Store(0)
	resp = r.DiskUsage(context.Background(), proto.DiskUsageRequest{Mount: "/mnt/md-named"})
	if resp.Code != CodeSpunDown || !slices.Equal(resp.SkippedSpunDown, []string{"sdc"}) || statfsCalled.Load() != 0 {
		t.Fatalf("md/named sleeping sdc: resp=%+v statfs=%d", resp, statfsCalled.Load())
	}

	// ZFS multi-disk pool and snapshot mount (tank@nightly) both catch sleeping sdb.
	for _, mp := range []string{"/mnt/zfs-multi", "/mnt/zfs-snap"} {
		statfsCalled.Store(0)
		resp = r.DiskUsage(context.Background(), proto.DiskUsageRequest{Mount: mp})
		if resp.Code != CodeSpunDown || !slices.Equal(resp.SkippedSpunDown, []string{"sdb"}) || statfsCalled.Load() != 0 {
			t.Fatalf("%s sleeping sdb: resp=%+v statfs=%d", mp, resp, statfsCalled.Load())
		}
	}
	// ZFS pool containing a loop0 vdev and ext4 on ZFS zvol (/dev/zd0p1 with rotational=0) both skip as standby_unknown.
	for _, mp := range []string{"/mnt/zfs-loop", "/mnt/zvol"} {
		statfsCalled.Store(0)
		resp = r.DiskUsage(context.Background(), proto.DiskUsageRequest{Mount: mp})
		if resp.Code != CodeStandbyUnknown || len(resp.SkippedSpunDown) != 0 || statfsCalled.Load() != 0 {
			t.Fatalf("%s: resp=%+v statfs=%d", mp, resp, statfsCalled.Load())
		}
	}

	// Pooled/union FUSE and overlay filesystems always fail closed as standby_unknown.
	for _, mp := range []string{"/mnt/merger", "/mnt/union", "/mnt/overlay"} {
		statfsCalled.Store(0)
		resp = r.DiskUsage(context.Background(), proto.DiskUsageRequest{Mount: mp})
		if resp.Code != CodeStandbyUnknown || len(resp.SkippedSpunDown) != 0 || strings.Contains(resp.Message, "spun down") || statfsCalled.Load() != 0 {
			t.Fatalf("%s: resp=%+v statfs=%d", mp, resp, statfsCalled.Load())
		}
	}

	// /dev/root resolves cleanly through /sys/dev/block/<MajMin> -> sda1 (SSD), while unresolved /dev/root and broken by-uuid fail closed.
	resp = r.DiskUsage(context.Background(), proto.DiskUsageRequest{Mount: "/mnt/dev-root"})
	if resp.Code != "" {
		t.Fatalf("/mnt/dev-root: %+v", resp)
	}
	for _, mp := range []string{"/mnt/dev-root-bad", "/mnt/bad-uuid"} {
		statfsCalled.Store(0)
		resp = r.DiskUsage(context.Background(), proto.DiskUsageRequest{Mount: mp})
		if resp.Code != CodeStandbyUnknown || statfsCalled.Load() != 0 {
			t.Fatalf("%s: resp=%+v statfs=%d", mp, resp, statfsCalled.Load())
		}
	}
}

func TestHostDiskStandbyCommandLinesAndNonWakingRules(t *testing.T) {
	type cmdCall struct {
		path string
		args []string
	}
	mkSysBlock := func(t *testing.T, root, dev, targetRel, vendor, driver, runtimeStatus, devState, rotational string) {
		t.Helper()
		devDir := filepath.Join(root, "sys", "devices", filepath.FromSlash(strings.TrimPrefix(targetRel, "../devices/")))
		if err := os.MkdirAll(filepath.Join(devDir, "queue"), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.MkdirAll(filepath.Join(devDir, "device", "power"), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.MkdirAll(filepath.Join(root, "sys/block"), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(targetRel, filepath.Join(root, "sys/block", dev)); err != nil {
			t.Fatal(err)
		}
		if rotational != "" {
			if err := os.WriteFile(filepath.Join(devDir, "queue/rotational"), []byte(rotational+"\n"), 0o644); err != nil {
				t.Fatal(err)
			}
		}
		if vendor != "" {
			if err := os.WriteFile(filepath.Join(devDir, "device/vendor"), []byte(vendor+"\n"), 0o644); err != nil {
				t.Fatal(err)
			}
		}
		if driver != "" {
			if err := os.Symlink("../../bus/scsi/drivers/"+driver, filepath.Join(devDir, "device/driver")); err != nil {
				t.Fatal(err)
			}
		}
		if runtimeStatus != "" {
			if err := os.WriteFile(filepath.Join(devDir, "device/power/runtime_status"), []byte(runtimeStatus+"\n"), 0o644); err != nil {
				t.Fatal(err)
			}
		}
		if devState != "" {
			if err := os.WriteFile(filepath.Join(devDir, "device/state"), []byte(devState+"\n"), 0o644); err != nil {
				t.Fatal(err)
			}
		}
	}

	root := t.TempDir()
	// 1. Direct libata SATA HDD (sda)
	mkSysBlock(t, root, "sda", "../devices/pci0000:00/0000:00:17.0/ata1/host0/target0:0:0/0:0:0:0/block/sda", "ATA     ", "sd", "active", "running", "1")
	// 2. SATA HDD behind a SAS HBA SATL/STP (sdb)
	mkSysBlock(t, root, "sdb", "../devices/pci0000:00/0000:00:01.0/host1/port-1:0/end_device-1:0/target1:0:0/1:0:0:0/block/sdb", "ATA     ", "sd", "unsupported", "running", "1")
	if err := os.MkdirAll(filepath.Join(root, "sys/class/sas_device/end_device-1:0"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "sys/class/sas_device/end_device-1:0/target_port_protocols"), []byte("stp\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	// 3. Legacy IDE HDD (hda)
	mkSysBlock(t, root, "hda", "../devices/pci0000:00/ide0/0.0/block/hda", "", "ide-disk", "", "", "1")
	// 4. Kernel runtime-suspended SATA HDD (sdc) -> must NOT invoke any command
	mkSysBlock(t, root, "sdc", "../devices/pci0000:00/0000:00:17.0/ata2/host1/target1:0:0/1:0:0:0/block/sdc", "ATA     ", "sd", "suspended", "running", "1")
	// 5. Offline SCSI SATA HDD (sdd) -> must NOT invoke any command
	mkSysBlock(t, root, "sdd", "../devices/pci0000:00/0000:00:17.0/ata3/host2/target2:0:0/2:0:0:0/block/sdd", "ATA     ", "sd", "active", "offline", "1")
	// 6. Native SAS HDD (sde, vendor SEAGATE, SSP) -> no verified non-waking probe -> standbyUnknown, zero commands
	mkSysBlock(t, root, "sde", "../devices/pci0000:00/0000:00:01.0/host1/port-1:1/end_device-1:1/target1:0:1/1:0:1:0/block/sde", "SEAGATE ", "sd", "active", "running", "1")
	if err := os.MkdirAll(filepath.Join(root, "sys/class/sas_device/end_device-1:1"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "sys/class/sas_device/end_device-1:1/target_port_protocols"), []byte("ssp\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	// 7. USB-attached HDD even if vendor spoofs "ATA" (sdf) -> standbyUnknown, zero commands
	mkSysBlock(t, root, "sdf", "../devices/pci0000:00/0000:00:14.0/usb2/2-1/2-1:1.0/host5/target5:0:0/5:0:0:0/block/sdf", "ATA     ", "uas", "active", "running", "1")
	// 8. Hardware RAID virtual disk (sdg, vendor DELL) -> standbyUnknown, zero commands
	mkSysBlock(t, root, "sdg", "../devices/pci0000:00/0000:00:03.0/host6/target6:2:0/6:2:0:0/block/sdg", "DELL    ", "sd", "active", "running", "1")
	// 9. Unknown disk with no sysfs device metadata (sdh) -> standbyUnknown, zero commands
	if err := os.MkdirAll(filepath.Join(root, "sys/block/sdh/queue"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "sys/block/sdh/queue/rotational"), []byte("1\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	// 10. Disk with vendor "ATA" but no sysfs bus symlink to rule out USB (sdi) -> standbyUnknown, zero commands
	if err := os.MkdirAll(filepath.Join(root, "sys/block/sdi/device"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "sys/block/sdi/device/vendor"), []byte("ATA     \n"), 0o644); err != nil {
		t.Fatal(err)
	}

	var calls []cmdCall
	newRunner := func(goos string, tools map[string]string, fn func(path string, args ...string) ([]byte, error)) *Runner {
		r := &Runner{
			root: root,
			goos: goos,
			lookProbeTool: func(name string) (string, error) {
				if p, ok := tools[name]; ok {
					return p, nil
				}
				return "", os.ErrNotExist
			},
			probeCmd: func(_ context.Context, path string, args ...string) ([]byte, error) {
				calls = append(calls, cmdCall{path: path, args: append([]string(nil), args...)})
				return fn(path, args...)
			},
		}
		return r
	}

	// Primary: hdparm -C on direct libata SATA (sda), SAS-HBA SATL SATA (sdb), legacy IDE (hda).
	r := newRunner("linux", map[string]string{"hdparm": "/sbin/hdparm", "smartctl": "/usr/sbin/smartctl"}, func(path string, args ...string) ([]byte, error) {
		switch args[len(args)-1] {
		case "/dev/sda":
			return []byte("/dev/sda:\n drive state is:  active/idle\n"), nil
		case "/dev/sdb":
			return []byte("/dev/sdb:\n drive state is:  standby\n"), nil
		case "/dev/hda":
			return []byte("/dev/hda:\n drive state is:  unknown\n"), nil
		default:
			return nil, os.ErrInvalid
		}
	})
	if got := r.hostDiskStandby(context.Background(), "sda"); got != standbyAwake {
		t.Fatalf("hdparm sda = %v, want standbyAwake", got)
	}
	if got := r.hostDiskStandby(context.Background(), "sdb"); got != standbyAsleep {
		t.Fatalf("hdparm sdb = %v, want standbyAsleep", got)
	}
	// When hdparm explicitly answers "unknown" (not supported), do not fall back to smartctl.
	if got := r.hostDiskStandby(context.Background(), "hda"); got != standbyUnknown {
		t.Fatalf("hdparm hda unknown = %v, want standbyUnknown", got)
	}
	wantHdparmCalls := []cmdCall{
		{path: "/sbin/hdparm", args: []string{"-C", "/dev/sda"}},
		{path: "/sbin/hdparm", args: []string{"-C", "/dev/sdb"}},
		{path: "/sbin/hdparm", args: []string{"-C", "/dev/hda"}},
	}
	if len(calls) != len(wantHdparmCalls) {
		t.Fatalf("hdparm calls = %+v, want %+v", calls, wantHdparmCalls)
	}
	for i, w := range wantHdparmCalls {
		if calls[i].path != w.path || !slices.Equal(calls[i].args, w.args) {
			t.Errorf("call[%d] = %+v, want %+v", i, calls[i], w)
		}
	}

	// Fallback when hdparm is absent: smartctl with explicit -d type and -n standby,3,5 (never autodetection).
	calls = nil
	r = newRunner("linux", map[string]string{"smartctl": "/usr/sbin/smartctl"}, func(path string, args ...string) ([]byte, error) {
		switch args[len(args)-1] {
		case "/dev/sda":
			return []byte(`{"power_mode":"ACTIVE or IDLE","smartctl":{"exit_status":0,"messages":[]}}`), nil
		case "/dev/sdb":
			return []byte(`{"smartctl":{"exit_status":3,"messages":[{"string":"Device is in STANDBY mode, exit(3)","severity":"information"}]}}`), os.ErrInvalid
		case "/dev/hda":
			return []byte(`{"smartctl":{"exit_status":5,"messages":[{"string":"CHECK POWER MODE not implemented, exit(5)","severity":"information"}]}}`), os.ErrInvalid
		default:
			return nil, os.ErrInvalid
		}
	})
	if got := r.hostDiskStandby(context.Background(), "sda"); got != standbyAwake {
		t.Fatalf("smartctl sda = %v, want standbyAwake", got)
	}
	if got := r.hostDiskStandby(context.Background(), "sdb"); got != standbyAsleep {
		t.Fatalf("smartctl sdb = %v, want standbyAsleep", got)
	}
	if got := r.hostDiskStandby(context.Background(), "hda"); got != standbyUnknown {
		t.Fatalf("smartctl hda unsupported = %v, want standbyUnknown", got)
	}
	wantSmartCalls := []cmdCall{
		{path: "/usr/sbin/smartctl", args: []string{"--json=c", "-d", "sat", "-n", "standby,3,5", "-i", "/dev/sda"}},
		{path: "/usr/sbin/smartctl", args: []string{"--json=c", "-d", "sat", "-n", "standby,3,5", "-i", "/dev/sdb"}},
		{path: "/usr/sbin/smartctl", args: []string{"--json=c", "-d", "ata", "-n", "standby,3,5", "-i", "/dev/hda"}},
	}
	if len(calls) != len(wantSmartCalls) {
		t.Fatalf("smartctl calls = %+v, want %+v", calls, wantSmartCalls)
	}
	for i, w := range wantSmartCalls {
		if calls[i].path != w.path || !slices.Equal(calls[i].args, w.args) {
			t.Errorf("smartctl call[%d] = %+v, want %+v", i, calls[i], w)
		}
	}

	// Kernel sysfs short-circuits and unverified device types must invoke ZERO commands.
	calls = nil
	r = newRunner("linux", map[string]string{"hdparm": "/sbin/hdparm", "smartctl": "/usr/sbin/smartctl"}, func(string, ...string) ([]byte, error) {
		t.Fatalf("unexpected command execution")
		return nil, nil
	})
	if got := r.hostDiskStandby(context.Background(), "sdc"); got != standbyAsleep {
		t.Fatalf("kernel runtime_status=suspended sdc = %v, want standbyAsleep", got)
	}
	for _, tc := range []struct {
		name string
		dev  string
	}{
		{"offline state", "sdd"},
		{"native SAS", "sde"},
		{"USB bridge", "sdf"},
		{"hardware RAID", "sdg"},
		{"missing sysfs device", "sdh"},
		{"ATA vendor without bus symlink", "sdi"},
		{"NVMe", "nvme0n1"},
		{"MMC", "mmcblk0"},
	} {
		if got := r.hostDiskStandby(context.Background(), tc.dev); got != standbyUnknown {
			t.Errorf("%s (%s) = %v, want standbyUnknown", tc.name, tc.dev, got)
		}
	}
	// macOS rotational disks must never run Linux hdparm/smartctl probes.
	rMac := newRunner("darwin", map[string]string{"hdparm": "/sbin/hdparm", "smartctl": "/usr/sbin/smartctl"}, func(string, ...string) ([]byte, error) {
		t.Fatalf("unexpected command execution on darwin")
		return nil, nil
	})
	if got := rMac.hostDiskStandby(context.Background(), "disk2"); got != standbyUnknown {
		t.Fatalf("darwin disk2 = %v, want standbyUnknown", got)
	}
	if len(calls) != 0 {
		t.Fatalf("unexpected probe commands executed: %+v", calls)
	}

	// End-to-end DiskUsage wiring with live r.hostDiskStandby:
	// - suspended sdc skips as spun_down without running any probe or touching mount
	// - native SAS sde and USB sdf skip as standby_unknown without running any probe or touching mount
	// - NVMe skips probing completely and walks
	writeBytes(t, filepath.Join(root, "mnt/nvme/data.bin"), 16*1024)
	writeBytes(t, filepath.Join(root, "mnt/susp/data.bin"), 16*1024)
	writeBytes(t, filepath.Join(root, "mnt/sas/data.bin"), 16*1024)
	writeBytes(t, filepath.Join(root, "mnt/usb/data.bin"), 16*1024)
	mounts := []mountInfo{
		{ID: 1, MountPoint: "/mnt/nvme", FSType: "ext4", Source: "/dev/nvme0n1p1"},
		{ID: 2, MountPoint: "/mnt/susp", FSType: "ext4", Source: "/dev/sdc1"},
		{ID: 3, MountPoint: "/mnt/sas", FSType: "ext4", Source: "/dev/sde1"},
		{ID: 4, MountPoint: "/mnt/usb", FSType: "ext4", Source: "/dev/sdf1"},
	}
	var statfsCalled atomic.Int32
	e2e := newTestRunner(t, root, mounts, nil)
	e2e.goos = "linux"
	e2e.checkStandby = e2e.hostDiskStandby
	e2e.lookProbeTool = func(name string) (string, error) { return "/sbin/" + name, nil }
	e2e.probeCmd = func(_ context.Context, path string, args ...string) ([]byte, error) {
		t.Fatalf("unexpected external probe command: %s %v", path, args)
		return nil, nil
	}
	e2e.statfs = func(string) (fsStat, error) {
		statfsCalled.Add(1)
		return fsStat{TotalBytes: 100 << 30, UsedBytes: 10 << 30}, nil
	}

	if resp := e2e.DiskUsage(context.Background(), proto.DiskUsageRequest{Mount: "/mnt/susp"}); resp.Code != CodeSpunDown || !slices.Equal(resp.SkippedSpunDown, []string{"sdc"}) || statfsCalled.Load() != 0 {
		t.Fatalf("/mnt/susp: resp=%+v statfs=%d", resp, statfsCalled.Load())
	}
	for _, mp := range []string{"/mnt/sas", "/mnt/usb"} {
		statfsCalled.Store(0)
		if resp := e2e.DiskUsage(context.Background(), proto.DiskUsageRequest{Mount: mp}); resp.Code != CodeStandbyUnknown || len(resp.SkippedSpunDown) != 0 || statfsCalled.Load() != 0 {
			t.Fatalf("%s: resp=%+v statfs=%d", mp, resp, statfsCalled.Load())
		}
	}
	if resp := e2e.DiskUsage(context.Background(), proto.DiskUsageRequest{Mount: "/mnt/nvme"}); resp.Code != "" {
		t.Fatalf("/mnt/nvme: %+v", resp)
	}
}

// unknownTypeDirEntry wraps a real fs.DirEntry to report Type() == 0 and
// IsDir() == false, simulating filesystems without d_type (XFS without ftype=1, FUSE).
type unknownTypeDirEntry struct {
	inner fs.DirEntry
}

func (u unknownTypeDirEntry) Name() string               { return u.inner.Name() }
func (u unknownTypeDirEntry) IsDir() bool                { return false }
func (u unknownTypeDirEntry) Type() fs.FileMode          { return 0 }
func (u unknownTypeDirEntry) Info() (fs.FileInfo, error) { return u.inner.Info() }

func TestCategoriesAndWalkWithoutDType(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()

	// Container logs on a filesystem without d_type:
	// - real container dir + json log + rotated log
	// - plain regular file inside containers/ (must be ignored cleanly, not Partial)
	// - symlink dir and symlink log pointing outside (must never be followed)
	// - mounted child dir inside containers/ (must never be crossed)
	// - /var/log/pods CRI log
	writeBytes(t, filepath.Join(root, "var/lib/docker/containers/c1/c1-json.log"), 24*1024)
	writeBytes(t, filepath.Join(root, "var/lib/docker/containers/c1/c1-json.log.1"), 8*1024)
	writeBytes(t, filepath.Join(root, "var/lib/docker/containers/c1/subdir.log/nested.log"), 128*1024)
	writeBytes(t, filepath.Join(root, "var/lib/docker/containers/readme.txt"), 4*1024)
	writeBytes(t, filepath.Join(root, "var/lib/docker/containers/mounted-c/mounted-json.log"), 256*1024)
	writeBytes(t, filepath.Join(root, "var/lib/docker/containers/raced-c/raced-json.log"), 256*1024)
	writeBytes(t, filepath.Join(root, "var/log/pods/app/0.log"), 12*1024)

	writeBytes(t, filepath.Join(outside, "ext-json.log"), 512*1024)
	if err := os.Symlink(outside, filepath.Join(root, "var/lib/docker/containers/sym-c")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(outside, "ext-json.log"), filepath.Join(root, "var/lib/docker/containers/c1/sym-json.log")); err != nil {
		t.Fatal(err)
	}

	// Other category collectors and general folders on the same DT_UNKNOWN filesystem.
	writeBytes(t, filepath.Join(root, "var/lib/docker/volumes/pg/data.bin"), 20*1024)
	writeBytes(t, filepath.Join(root, "var/log/journal/m1/system.journal"), 36*1024)
	writeBytes(t, filepath.Join(root, "var/cache/apt/archives/pkg.deb"), 16*1024)
	writeBytes(t, filepath.Join(root, "var/lib/libvirt/images/vm.qcow2"), 48*1024)
	writeBytes(t, filepath.Join(root, "var/lib/libvirt/qemu/save/vm.save"), 16*1024)
	writeBytes(t, filepath.Join(root, "srv/app/blob.bin"), 32*1024)

	mounts := []mountInfo{
		{ID: 10, ParentID: 1, MountPoint: "/", FSType: "xfs", Source: "/dev/nvme0n1p2"},
		{ID: 11, ParentID: 10, MountPoint: "/var/lib/docker/containers/mounted-c", FSType: "xfs", Source: "/dev/sdb1"},
	}

	r := newTestRunner(t, root, mounts, nil)
	r.statMountID = func(logicalPath string) (uint64, bool) {
		if hasPathPrefix(logicalPath, "/var/lib/docker/containers/raced-c") {
			return 99, true
		}
		return 10, true
	}
	r.readDir = func(logicalPath string) ([]fs.DirEntry, error) {
		if hasPathPrefix(logicalPath, "/var/lib/docker/containers/mounted-c") {
			t.Errorf("readDir crossed known child mount %q", logicalPath)
			return nil, fs.ErrPermission
		}
		if hasPathPrefix(logicalPath, "/var/lib/docker/containers/raced-c") {
			t.Errorf("readDir crossed mount-ID-mismatched dir %q", logicalPath)
			return nil, fs.ErrPermission
		}
		raw, err := os.ReadDir(r.hostPath(logicalPath))
		if err != nil {
			return nil, err
		}
		out := make([]fs.DirEntry, len(raw))
		for i, e := range raw {
			out[i] = unknownTypeDirEntry{inner: e}
		}
		return out, nil
	}

	resp := r.DiskUsage(context.Background(), proto.DiskUsageRequest{Mount: "/"})
	if resp.Code != "" {
		t.Fatalf("unexpected error: %+v", resp)
	}
	if resp.Partial {
		t.Errorf("expected Partial=false on readable DT_UNKNOWN tree, got Partial=true")
	}

	byKey := map[string]proto.DiskUsageCategory{}
	for _, c := range resp.Categories {
		byKey[c.Key] = c
	}

	// Container logs: 24 KiB + 8 KiB + 12 KiB (pods) = ~44 KiB; must NOT include subdir.log (128 KiB),
	// mounted-c (256 KiB), raced-c (256 KiB), or symlinks (512 KiB).
	if c := byKey[proto.DiskCatContainerLogs]; c.Bytes < 44*1024 || c.Bytes >= 128*1024 {
		t.Errorf("container_logs = %+v, want ~44 KiB", c)
	}
	if c := byKey[proto.DiskCatContainerVolumes]; c.Bytes < 20*1024 || c.Bytes >= 64*1024 {
		t.Errorf("container_volumes = %+v, want ~20 KiB", c)
	}
	if c := byKey[proto.DiskCatJournal]; c.Bytes < 36*1024 || c.Bytes >= 64*1024 {
		t.Errorf("journal = %+v, want ~36 KiB", c)
	}
	if c := byKey[proto.DiskCatPackageCache]; c.Bytes < 16*1024 || c.Bytes >= 64*1024 {
		t.Errorf("package_cache = %+v, want ~16 KiB", c)
	}
	if c := byKey[proto.DiskCatVMDisks]; c.Bytes < 48*1024 || c.Bytes >= 128*1024 {
		t.Errorf("vm_disks = %+v, want ~48 KiB", c)
	}
	if c := byKey[proto.DiskCatVMSnapshots]; c.Bytes < 16*1024 || c.Bytes >= 64*1024 {
		t.Errorf("vm_snapshots = %+v, want ~16 KiB", c)
	}
	var foundSrv bool
	for _, f := range resp.Folders {
		if hasPathPrefix(f.Path, "/srv") && f.Bytes >= 32*1024 {
			foundSrv = true
		}
	}
	if !foundSrv {
		t.Errorf("expected /srv folder in walk result on DT_UNKNOWN tree, got %+v", resp.Folders)
	}
}

type recordingScanFS struct {
	inner scanFS
	onOp  func(logicalPath string)
}

func (f *recordingScanFS) OpenRoot(hostPath, logicalMount string, expected mountInfo) (scanDir, error) {
	f.onOp(logicalMount)
	d, err := f.inner.OpenRoot(hostPath, logicalMount, expected)
	if err != nil {
		return nil, err
	}
	return &recordingScanDir{inner: d, logicalPath: logicalMount, onOp: f.onOp}, nil
}

type recordingScanDir struct {
	inner       scanDir
	logicalPath string
	onOp        func(logicalPath string)
}

func (d *recordingScanDir) Stat() (entryStat, error) { return d.inner.Stat() }
func (d *recordingScanDir) Statfs() (fsStat, error)  { return d.inner.Statfs() }
func (d *recordingScanDir) Close() error             { return d.inner.Close() }

func (d *recordingScanDir) OpenSelf() (scanDir, error) {
	sub, err := d.inner.OpenSelf()
	if err != nil {
		return nil, err
	}
	return &recordingScanDir{inner: sub, logicalPath: d.logicalPath, onOp: d.onOp}, nil
}

func (d *recordingScanDir) ReadDirBatch(maxEntries int) ([]dirEntryInfo, error) {
	d.onOp(d.logicalPath)
	return d.inner.ReadDirBatch(maxEntries)
}

func (d *recordingScanDir) OpenDir(name, logicalPath string, searchOnly, prechecked bool) (scanDir, error) {
	d.onOp(logicalPath)
	sub, err := d.inner.OpenDir(name, logicalPath, searchOnly, prechecked)
	if err != nil {
		return nil, err
	}
	return &recordingScanDir{inner: sub, logicalPath: logicalPath, onOp: d.onOp}, nil
}

func (d *recordingScanDir) StatEntry(name, logicalPath string) (entryStat, error) {
	d.onOp(logicalPath)
	return d.inner.StatEntry(name, logicalPath)
}

// ---- In-memory fake filesystem for testing mid-walk mounts -------------------

type fakeFSMode int

const (
	fakeModeOpenat2    fakeFSMode = iota // Linux openat2(RESOLVE_NO_XDEV): refuses mount crossings before touching the mounted fs
	fakeModeDarwinBulk                   // macOS getattrlistbulk(NOCROSSMOUNT): skips mount points/triggers/firmlinks before openat and returns file stats inline
)

type fakeMountTracker struct {
	name        string
	touched     atomic.Int32 // any stat or open that entered the mounted filesystem
	dataReads   atomic.Int32 // any ReadDir or inner-entry access on the mounted filesystem
	statfsCalls atomic.Int32
}

type fakeNode struct {
	mode       fs.FileMode
	allocBytes uint64
	dev        uint64
	mntID      uint64
	fsid       [2]int32
	hasFSID    bool
	firmlink   bool
	automount  bool
	ino        uint64
	nlink      uint64
	children   map[string]*fakeNode
	tracker    *fakeMountTracker
}

type fakeScanFS struct {
	mu         sync.Mutex
	mode       fakeFSMode
	noDType    bool
	root       *fakeNode
	onReadDir  func(logicalPath string, fs *fakeScanFS)
	onOpenRoot func(logicalMount string, fs *fakeScanFS)
	rootDev    uint64
	rootMntID  uint64
	nextIno    uint64
}

func newFakeScanFS(mode fakeFSMode, noDType bool, rootDev, rootMntID uint64) *fakeScanFS {
	return &fakeScanFS{
		mode:    mode,
		noDType: noDType,
		root: &fakeNode{
			mode:     fs.ModeDir | 0o755,
			dev:      rootDev,
			mntID:    rootMntID,
			ino:      1,
			nlink:    2,
			children: map[string]*fakeNode{},
		},
		nextIno: 2,
	}
}

func (f *fakeScanFS) addDir(logicalPath string) *fakeNode {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.ensureDirLocked(f.root, logicalPath, f.root.dev, f.root.mntID, nil)
}

func (f *fakeScanFS) addFile(logicalPath string, allocBytes uint64) *fakeNode {
	f.mu.Lock()
	defer f.mu.Unlock()
	parent := f.ensureDirLocked(f.root, filepath.Dir(logicalPath), f.root.dev, f.root.mntID, nil)
	name := filepath.Base(logicalPath)
	n := &fakeNode{
		mode:       0o644,
		allocBytes: allocBytes,
		dev:        f.root.dev,
		mntID:      f.root.mntID,
		ino:        f.nextIno,
		nlink:      1,
	}
	f.nextIno++
	parent.children[name] = n
	return n
}

func (f *fakeScanFS) addSymlink(logicalPath string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	parent := f.ensureDirLocked(f.root, filepath.Dir(logicalPath), f.root.dev, f.root.mntID, nil)
	n := &fakeNode{
		mode:  fs.ModeSymlink | 0o777,
		dev:   f.root.dev,
		mntID: f.root.mntID,
		ino:   f.nextIno,
		nlink: 1,
	}
	f.nextIno++
	parent.children[filepath.Base(logicalPath)] = n
}

func (f *fakeScanFS) mountDirAt(logicalPath string, dev, mntID uint64, tracker *fakeMountTracker, files map[string]uint64) {
	f.mu.Lock()
	defer f.mu.Unlock()
	parent := f.ensureDirLocked(f.root, filepath.Dir(logicalPath), f.root.dev, f.root.mntID, nil)
	mntRoot := &fakeNode{
		mode:     fs.ModeDir | 0o755,
		dev:      dev,
		mntID:    mntID,
		ino:      f.nextIno,
		nlink:    2,
		children: map[string]*fakeNode{},
		tracker:  tracker,
	}
	f.nextIno++
	for rel, sz := range files {
		dir := mntRoot
		if d := filepath.Dir(rel); d != "." && d != "/" {
			dir = f.ensureDirLocked(mntRoot, "/"+d, dev, mntID, tracker)
		}
		dir.children[filepath.Base(rel)] = &fakeNode{
			mode:       0o644,
			allocBytes: sz,
			dev:        dev,
			mntID:      mntID,
			ino:        f.nextIno,
			nlink:      1,
			tracker:    tracker,
		}
		f.nextIno++
	}
	parent.children[filepath.Base(logicalPath)] = mntRoot
}

func (f *fakeScanFS) mountFileAt(logicalPath string, dev, mntID uint64, allocBytes uint64, tracker *fakeMountTracker) {
	f.mu.Lock()
	defer f.mu.Unlock()
	parent := f.ensureDirLocked(f.root, filepath.Dir(logicalPath), f.root.dev, f.root.mntID, nil)
	parent.children[filepath.Base(logicalPath)] = &fakeNode{
		mode:       0o644,
		allocBytes: allocBytes,
		dev:        dev,
		mntID:      mntID,
		ino:        f.nextIno,
		nlink:      1,
		tracker:    tracker,
	}
	f.nextIno++
}

func (f *fakeScanFS) overmountRoot(dev, mntID uint64, tracker *fakeMountTracker) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.root = &fakeNode{
		mode:     fs.ModeDir | 0o755,
		dev:      dev,
		mntID:    mntID,
		ino:      f.nextIno,
		nlink:    2,
		children: map[string]*fakeNode{},
		tracker:  tracker,
	}
	f.nextIno++
}

func (f *fakeScanFS) ensureDirLocked(base *fakeNode, logicalPath string, dev, mntID uint64, tracker *fakeMountTracker) *fakeNode {
	clean := filepath.Clean(logicalPath)
	if clean == "/" || clean == "." {
		return base
	}
	cur := base
	for _, seg := range strings.Split(strings.TrimPrefix(clean, "/"), "/") {
		if seg == "" {
			continue
		}
		next, ok := cur.children[seg]
		if !ok {
			next = &fakeNode{
				mode:     fs.ModeDir | 0o755,
				dev:      dev,
				mntID:    mntID,
				ino:      f.nextIno,
				nlink:    2,
				children: map[string]*fakeNode{},
				tracker:  tracker,
			}
			f.nextIno++
			cur.children[seg] = next
		}
		cur = next
	}
	return cur
}

func (f *fakeScanFS) OpenRoot(_ string, logicalMount string, _ mountInfo) (scanDir, error) {
	if f.onOpenRoot != nil {
		f.onOpenRoot(logicalMount, f)
	}
	f.mu.Lock()
	root := f.root
	f.rootDev = root.dev
	f.rootMntID = root.mntID
	f.mu.Unlock()
	return &fakeScanDir{fs: f, node: root, logicalPath: logicalMount}, nil
}

type fakeScanDir struct {
	fs          *fakeScanFS
	node        *fakeNode
	logicalPath string
	entries     []dirEntryInfo
	loaded      bool
	off         int
}

func (d *fakeScanDir) Stat() (entryStat, error) {
	d.fs.mu.Lock()
	n := d.node
	d.fs.mu.Unlock()
	return entryStat{
		Mode:       n.mode,
		Size:       int64(n.allocBytes),
		AllocBytes: n.allocBytes,
		Dev:        n.dev,
		HasDev:     true,
		Ino:        n.ino,
		Nlink:      n.nlink,
		HasInode:   true,
		MntID:      n.mntID,
		HasMntID:   true,
		FSID:       n.fsid,
		HasFSID:    n.hasFSID,
	}, nil
}

func (d *fakeScanDir) Statfs() (fsStat, error) {
	if d.node.tracker != nil {
		d.node.tracker.statfsCalls.Add(1)
	}
	return fsStat{TotalBytes: 200 << 30, UsedBytes: 50 << 30}, nil
}

func (d *fakeScanDir) OpenSelf() (scanDir, error) {
	return &fakeScanDir{fs: d.fs, node: d.node, logicalPath: d.logicalPath}, nil
}

func (d *fakeScanDir) ReadDirBatch(maxEntries int) ([]dirEntryInfo, error) {
	limit := clampBatchSize(maxEntries)
	if !d.loaded {
		if d.node.tracker != nil {
			d.node.tracker.touched.Add(1)
			d.node.tracker.dataReads.Add(1)
		}
		if d.fs.onReadDir != nil {
			d.fs.onReadDir(d.logicalPath, d.fs)
		}
		d.fs.mu.Lock()
		names := make([]string, 0, len(d.node.children))
		for name := range d.node.children {
			names = append(names, name)
		}
		slices.Sort(names)
		out := make([]dirEntryInfo, 0, len(names))
		for _, name := range names {
			ch := d.node.children[name]
			if d.fs.mode == fakeModeDarwinBulk {
				// macOS getattrlistbulk(NOCROSSMOUNT) identifies mount points,
				// automount triggers and APFS firmlinks from the parent volume
				// without touching the mounted filesystem, and supplies regular
				// file metadata inline without fstatat.
				if ch.dev != d.node.dev || ch.mntID != d.node.mntID || ch.firmlink || ch.automount {
					continue
				}
				switch {
				case ch.mode&fs.ModeSymlink != 0:
					out = append(out, dirEntryInfo{Name: name, Kind: entrySymlink})
				case ch.mode.IsDir():
					out = append(out, dirEntryInfo{
						Name:    name,
						Kind:    entryDir,
						HasStat: true,
						Stat: entryStat{
							Mode:     ch.mode,
							Dev:      ch.dev,
							HasDev:   true,
							Ino:      ch.ino,
							Nlink:    ch.nlink,
							HasInode: true,
							MntID:    ch.mntID,
							HasMntID: true,
						},
					})
				case ch.mode.IsRegular():
					out = append(out, dirEntryInfo{
						Name:    name,
						Kind:    entryRegular,
						HasStat: true,
						Stat: entryStat{
							Mode:       ch.mode,
							Size:       int64(ch.allocBytes),
							AllocBytes: ch.allocBytes,
							Dev:        ch.dev,
							HasDev:     true,
							Ino:        ch.ino,
							Nlink:      ch.nlink,
							HasInode:   true,
							MntID:      ch.mntID,
							HasMntID:   true,
						},
					})
				default:
					out = append(out, dirEntryInfo{Name: name, Kind: entryOther})
				}
				continue
			}
			kind := entryUnknown
			if !d.fs.noDType {
				switch {
				case ch.mode&fs.ModeSymlink != 0:
					kind = entrySymlink
				case ch.mode.IsDir():
					kind = entryDir
				case ch.mode.IsRegular():
					kind = entryRegular
				default:
					kind = entryOther
				}
			}
			out = append(out, dirEntryInfo{Name: name, Kind: kind})
		}
		d.fs.mu.Unlock()
		d.entries = out
		d.loaded = true
	}
	if d.off >= len(d.entries) {
		return nil, io.EOF
	}
	end := min(d.off+limit, len(d.entries))
	batch := d.entries[d.off:end]
	d.off = end
	return batch, nil
}

func (d *fakeScanDir) OpenDir(name, logicalPath string, _, prechecked bool) (scanDir, error) {
	if !isSafeChildName(name) {
		return nil, errWrongMount
	}
	d.fs.mu.Lock()
	ch, ok := d.node.children[name]
	parentDev, parentMnt := d.node.dev, d.node.mntID
	d.fs.mu.Unlock()
	if !ok {
		return nil, fs.ErrNotExist
	}
	if ch.mode&fs.ModeSymlink != 0 {
		return nil, errNotDir
	}
	if !ch.mode.IsDir() {
		return nil, errNotDir
	}
	if d.fs.mode == fakeModeOpenat2 {
		// Linux openat2(O_PATH, RESOLVE_NO_XDEV) refuses mount crossings in VFS
		// and rejects automount triggers before touching the mounted filesystem.
		if ch.dev != parentDev || ch.mntID != parentMnt || ch.automount {
			return nil, errWrongMount
		}
		return &fakeScanDir{fs: d.fs, node: ch, logicalPath: logicalPath}, nil
	}
	// macOS getattrlistbulk(NOCROSSMOUNT): when called from openRelDir
	// (prechecked=false), lookupChildBulk inspects the parent directory first
	// and rejects mount points, triggers and firmlinks without touching them.
	if !prechecked && (ch.dev != parentDev || ch.mntID != parentMnt || ch.firmlink || ch.automount) {
		return nil, errWrongMount
	}
	if ch.dev != parentDev || ch.mntID != parentMnt || ch.firmlink || ch.automount {
		if ch.tracker != nil {
			ch.tracker.touched.Add(1)
		}
		return nil, errWrongMount
	}
	return &fakeScanDir{fs: d.fs, node: ch, logicalPath: logicalPath}, nil
}

func (d *fakeScanDir) StatEntry(name, _ string) (entryStat, error) {
	if !isSafeChildName(name) {
		return entryStat{}, errWrongMount
	}
	d.fs.mu.Lock()
	ch, ok := d.node.children[name]
	parentDev, parentMnt := d.node.dev, d.node.mntID
	d.fs.mu.Unlock()
	if !ok {
		return entryStat{}, fs.ErrNotExist
	}
	if ch.mode&fs.ModeSymlink != 0 {
		return entryStat{}, errWrongMount
	}
	// Both Linux openat2(O_PATH, RESOLVE_NO_XDEV) and macOS getattrlistbulk
	// refuse mount crossings without sending metadata requests to the mounted fs.
	if ch.dev != parentDev || ch.mntID != parentMnt || ch.firmlink || ch.automount {
		return entryStat{}, errWrongMount
	}
	return entryStat{
		Mode:       ch.mode,
		Size:       int64(ch.allocBytes),
		AllocBytes: ch.allocBytes,
		Dev:        ch.dev,
		HasDev:     true,
		Ino:        ch.ino,
		Nlink:      ch.nlink,
		HasInode:   true,
		MntID:      ch.mntID,
		HasMntID:   true,
	}, nil
}

func (d *fakeScanDir) Close() error { return nil }

func TestMidWalkMountNeverTouchedOrReadFakeFS(t *testing.T) {
	cases := []struct {
		name    string
		mode    fakeFSMode
		noDType bool
	}{
		{"openat2_with_dtype", fakeModeOpenat2, false},
		{"openat2_without_dtype", fakeModeOpenat2, true},
		{"darwin_getattrlistbulk", fakeModeDarwinBulk, false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			const (
				rootDev   = 100
				rootMntID = 10
			)
			ffs := newFakeScanFS(tc.mode, tc.noDType, rootDev, rootMntID)

			// Target-mount files and empty mountpoint directories (NOT mounted when listMounts runs!).
			ffs.addFile("/srv/app/keep.bin", 32*1024)
			ffs.addDir("/mnt/sleeping")
			ffs.addDir("/deep/lvl2") // sits at maxDepth=2
			ffs.addFile("/srv/bound.bin", 4*1024)
			ffs.addFile("/var/lib/docker/containers/c1/c1-json.log", 24*1024)
			ffs.addFile("/var/lib/docker/containers/c1/bound-json.log", 4*1024)
			ffs.addDir("/var/lib/docker/containers/c2")
			ffs.addFile("/var/log/journal/m1/system.journal", 16*1024)
			ffs.addDir("/var/log/journal/late-mount")
			ffs.addFile("/var/lib/libvirt/images/vm1.qcow2", 48*1024)
			ffs.addDir("/var/lib/libvirt/images/late-pool")
			ffs.addSymlink("/var/lib/docker/containers/sym")

			trackWalk := &fakeMountTracker{name: "/mnt/sleeping"}
			trackMaxDepth := &fakeMountTracker{name: "/deep/lvl2"}
			trackBindFile := &fakeMountTracker{name: "/srv/bound.bin"}
			trackContainerDir := &fakeMountTracker{name: "/var/lib/docker/containers/c2"}
			trackContainerLog := &fakeMountTracker{name: "/var/lib/docker/containers/c1/bound-json.log"}
			trackJournal := &fakeMountTracker{name: "/var/log/journal/late-mount"}
			trackVM := &fakeMountTracker{name: "/var/lib/libvirt/images/late-pool"}

			var mountedWalk, mountedSrv, mountedDocker, mountedC1, mountedJournal, mountedVM atomic.Bool
			ffs.onReadDir = func(logicalPath string, fs *fakeScanFS) {
				switch logicalPath {
				case "/":
					if mountedWalk.CompareAndSwap(false, true) {
						fs.mountDirAt("/mnt/sleeping", 200, 91, trackWalk, map[string]uint64{
							"secret.mkv": 512 * 1024,
						})
						fs.mountDirAt("/deep/lvl2", 201, 92, trackMaxDepth, map[string]uint64{
							"deep.bin": 512 * 1024,
						})
					}
				case "/srv":
					if mountedSrv.CompareAndSwap(false, true) {
						// Same-device bind mount on a regular file (same st_dev, different mntID).
						fs.mountFileAt("/srv/bound.bin", rootDev, 93, 512*1024, trackBindFile)
					}
				case "/var/lib/docker/containers":
					if mountedDocker.CompareAndSwap(false, true) {
						fs.mountDirAt("/var/lib/docker/containers/c2", 202, 94, trackContainerDir, map[string]uint64{
							"c2-json.log": 512 * 1024,
						})
					}
				case "/var/lib/docker/containers/c1":
					if mountedC1.CompareAndSwap(false, true) {
						fs.mountFileAt("/var/lib/docker/containers/c1/bound-json.log", rootDev, 95, 512*1024, trackContainerLog)
					}
				case "/var/log/journal":
					if mountedJournal.CompareAndSwap(false, true) {
						fs.mountDirAt("/var/log/journal/late-mount", 203, 96, trackJournal, map[string]uint64{
							"ext.journal": 512 * 1024,
						})
					}
				case "/var/lib/libvirt/images":
					if mountedVM.CompareAndSwap(false, true) {
						fs.mountDirAt("/var/lib/libvirt/images/late-pool", 204, 97, trackVM, map[string]uint64{
							"ext.qcow2": 512 * 1024,
						})
					}
				}
			}

			mounts := []mountInfo{
				{ID: rootMntID, ParentID: 1, MountPoint: "/", FSType: "ext4", Source: "/dev/nvme0n1p2"},
			}
			r := newTestRunner(t, t.TempDir(), mounts, nil)
			r.scanFS = ffs
			r.statfs = nil // exercise rootDir.Statfs() as well

			resp := r.DiskUsage(context.Background(), proto.DiskUsageRequest{Mount: "/", MaxDepth: 2})
			if resp.Code != "" {
				t.Fatalf("unexpected error: %+v", resp)
			}

			allTrackers := []*fakeMountTracker{
				trackWalk, trackMaxDepth, trackBindFile,
				trackContainerDir, trackContainerLog, trackJournal, trackVM,
			}
			for _, tr := range allTrackers {
				if tr.dataReads.Load() != 0 {
					t.Errorf("%s: newly mounted filesystem had %d data/readdir reads, want 0", tr.name, tr.dataReads.Load())
				}
				if tr.touched.Load() != 0 {
					t.Errorf("%s: mode %s touched newly mounted filesystem %d times, want 0", tr.name, tc.name, tr.touched.Load())
				}
			}

			// Verify none of the 512 KiB files on newly mounted filesystems leaked into folders or categories.
			for _, f := range resp.Folders {
				if hasPathPrefix(f.Path, "/mnt/sleeping") || hasPathPrefix(f.Path, "/deep") {
					t.Errorf("folder leaked from mid-walk mount: %+v", f)
				}
				if f.Bytes >= 256*1024 {
					t.Errorf("folder %q bytes=%d includes data from mid-walk mount", f.Path, f.Bytes)
				}
			}
			byKey := map[string]proto.DiskUsageCategory{}
			for _, c := range resp.Categories {
				byKey[c.Key] = c
			}
			if c := byKey[proto.DiskCatContainerLogs]; c.Bytes != 24*1024 {
				t.Errorf("container_logs = %d, want exactly 24 KiB", c.Bytes)
			}
			if c := byKey[proto.DiskCatJournal]; c.Bytes != 16*1024 {
				t.Errorf("journal = %d, want exactly 16 KiB", c.Bytes)
			}
			if c := byKey[proto.DiskCatVMDisks]; c.Bytes != 48*1024 {
				t.Errorf("vm_disks = %d, want exactly 48 KiB", c.Bytes)
			}
		})
	}
}

func TestOvermountedRootRefusedBeforeStatfsOrReadDir(t *testing.T) {
	ffs := newFakeScanFS(fakeModeOpenat2, false, 100, 30)
	overTracker := &fakeMountTracker{name: "/mnt/data overmount"}
	ffs.onOpenRoot = func(_ string, fs *fakeScanFS) {
		// Simulate another filesystem (mntID=45) being mounted over /mnt/data
		// after listMounts() saw mntID=30 and before OpenRoot runs.
		fs.overmountRoot(250, 45, overTracker)
	}

	mounts := []mountInfo{
		{ID: 30, ParentID: 1, MountPoint: "/mnt/data", FSType: "ext4", Source: "/dev/nvme0n1p1"},
	}
	r := newTestRunner(t, t.TempDir(), mounts, nil)
	r.scanFS = ffs
	r.statfs = nil // must NOT call rootDir.Statfs() after detecting root mount ID change

	resp := r.DiskUsage(context.Background(), proto.DiskUsageRequest{Mount: "/mnt/data"})
	if resp.Code != CodeFailed {
		t.Fatalf("overmounted root: resp = %+v, want CodeFailed", resp)
	}
	if overTracker.statfsCalls.Load() != 0 {
		t.Errorf("Statfs called %d times on overmounted root, want 0", overTracker.statfsCalls.Load())
	}
	if overTracker.dataReads.Load() != 0 {
		t.Errorf("ReadDir called %d times on overmounted root, want 0", overTracker.dataReads.Load())
	}
}

func TestMidWalkMountOnDockerRootSkipsDockerDF(t *testing.T) {
	root := t.TempDir()
	sockDir, err := os.MkdirTemp("", "du-race-*")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(sockDir) })
	sockPath := filepath.Join(sockDir, "d.sock")
	ln, err := net.Listen("unix", sockPath)
	if err != nil {
		t.Fatal(err)
	}
	var dfCalls atomic.Int32
	mux := http.NewServeMux()
	mux.HandleFunc("/info", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"DockerRootDir": "/var/lib/docker"})
	})
	mux.HandleFunc("/system/df", func(w http.ResponseWriter, r *http.Request) {
		dfCalls.Add(1)
		_ = json.NewEncoder(w).Encode(map[string]any{"LayersSize": 500_000_000})
	})
	srv := &http.Server{Handler: mux}
	go srv.Serve(ln)
	t.Cleanup(func() {
		srv.Close()
		ln.Close()
	})
	inRootSock := filepath.Join(root, "var/run/docker.sock")
	if err := os.MkdirAll(filepath.Dir(inRootSock), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(sockPath, inRootSock); err != nil {
		t.Fatal(err)
	}

	ffs := newFakeScanFS(fakeModeOpenat2, false, 100, 10)
	dockerTracker := &fakeMountTracker{name: "/var/lib/docker"}
	// /var/lib/docker is NOT in mounts (listMounts snapshot), but is mounted before collectDocker probes it.
	ffs.mountDirAt("/var/lib/docker", 205, 98, dockerTracker, map[string]uint64{
		"volumes/v1/data.bin": 512 * 1024,
	})

	mounts := []mountInfo{{ID: 10, ParentID: 1, MountPoint: "/", FSType: "ext4", Source: "/dev/nvme0n1p2"}}
	r := newTestRunner(t, root, mounts, nil)
	r.dockerSockets = []string{"/var/run/docker.sock"}
	r.scanFS = ffs

	resp := r.DiskUsage(context.Background(), proto.DiskUsageRequest{Mount: "/"})
	if resp.Code != "" {
		t.Fatalf("unexpected error: %+v", resp)
	}
	if dfCalls.Load() != 0 {
		t.Errorf("/system/df called %d times when /var/lib/docker was mounted mid-scan, want 0", dfCalls.Load())
	}
	if dockerTracker.touched.Load() != 0 || dockerTracker.dataReads.Load() != 0 {
		t.Errorf("mid-scan /var/lib/docker mount touched=%d dataReads=%d, want 0/0", dockerTracker.touched.Load(), dockerTracker.dataReads.Load())
	}
	if errors.Is(errWrongMount, fs.ErrPermission) {
		t.Fatal("errWrongMount must not match fs.ErrPermission")
	}
}

func TestDarwinDataVolumeCategoryRoots(t *testing.T) {
	root := t.TempDir()
	// Modern macOS: "/" is the sealed system volume and mutable data sits under /System/Volumes/Data.
	writeBytes(t, filepath.Join(root, "System/Volumes/Data/Library/Caches/Homebrew/downloads/foo.tar.gz"), 24*1024)
	writeBytes(t, filepath.Join(root, "System/Volumes/Data/opt/homebrew/Caches/bar.bottle.tar.gz"), 16*1024)
	writeBytes(t, filepath.Join(root, "System/Volumes/Data/private/var/lib/docker/volumes/pg/data.bin"), 20*1024)
	writeBytes(t, filepath.Join(root, "System/Volumes/Data/private/var/lib/docker/containers/c1/c1-json.log"), 12*1024)

	mounts := []mountInfo{
		{ID: 1, MountPoint: "/", FSType: "apfs", Source: "/dev/disk3s3s1"},
		{ID: 2, MountPoint: "/System/Volumes/Data", FSType: "apfs", Source: "/dev/disk3s1"},
	}
	inv := &proto.Report{
		Filesystems: []proto.Filesystem{
			{Mount: "/", Device: "/dev/disk3", FSType: "apfs", Disks: []string{"disk0"}},
		},
		Disks: []proto.Disk{
			{Device: "disk0", Type: "nvme", Model: "APPLE SSD AP1024Z"},
		},
	}

	r := newTestRunner(t, root, mounts, inv)
	r.goos = "darwin"
	resp := r.DiskUsage(context.Background(), proto.DiskUsageRequest{Mount: "/System/Volumes/Data"})
	if resp.Code != "" {
		t.Fatalf("unexpected error scanning /System/Volumes/Data: %+v", resp)
	}
	byKey := map[string]proto.DiskUsageCategory{}
	for _, c := range resp.Categories {
		byKey[c.Key] = c
	}
	pkg := byKey[proto.DiskCatPackageCache]
	if pkg.Bytes < 40*1024 || pkg.Bytes >= 128*1024 {
		t.Errorf("package_cache on /System/Volumes/Data = %+v, want ~40 KiB (both Homebrew roots)", pkg)
	}
	if pkg.Detail != "Homebrew" {
		t.Errorf("package_cache detail = %q, want %q", pkg.Detail, "Homebrew")
	}
	if vol := byKey[proto.DiskCatContainerVolumes]; vol.Bytes < 20*1024 {
		t.Errorf("container_volumes on /System/Volumes/Data = %+v, want >= 20 KiB", vol)
	}
	if logs := byKey[proto.DiskCatContainerLogs]; logs.Bytes < 12*1024 {
		t.Errorf("container_logs on /System/Volumes/Data = %+v, want >= 12 KiB", logs)
	}

	// Pre-Catalina single-volume Mac (or direct "/" mount) still finds /Library/Caches/Homebrew and /opt/homebrew/Caches.
	rootSingle := t.TempDir()
	writeBytes(t, filepath.Join(rootSingle, "Library/Caches/Homebrew/legacy.tar.gz"), 20*1024)
	writeBytes(t, filepath.Join(rootSingle, "opt/homebrew/Caches/opt.tar.gz"), 12*1024)
	rSingle := newTestRunner(t, rootSingle, []mountInfo{
		{ID: 1, MountPoint: "/", FSType: "apfs", Source: "/dev/disk3s1"},
	}, inv)
	rSingle.goos = "darwin"
	respSingle := rSingle.DiskUsage(context.Background(), proto.DiskUsageRequest{Mount: "/"})
	if respSingle.Code != "" {
		t.Fatalf("unexpected error scanning single-volume /: %+v", respSingle)
	}
	var pkgSingle proto.DiskUsageCategory
	for _, c := range respSingle.Categories {
		if c.Key == proto.DiskCatPackageCache {
			pkgSingle = c
		}
	}
	if pkgSingle.Bytes < 32*1024 || pkgSingle.Detail != "Homebrew" {
		t.Errorf("package_cache on single-volume / = %+v, want >= 32 KiB Homebrew", pkgSingle)
	}
}

// hugeBatchScanFS simulates a directory with millions of virtual entries
// generated lazily per ReadDirBatch call so tests can verify that walkMount,
// walkDirBytes and collectContainerLogs bound memory, apply entry caps and
// check cancellation between batches without reading an entire huge directory.
type hugeBatchScanFS struct {
	rootDev       uint64
	rootMntID     uint64
	hugeDirPath   string // logical path of the directory containing totalVirtual regular files
	fileSuffix    string // suffix appended to generated filenames (e.g. ".bin" or "-json.log")
	totalVirtual  int
	onBatch       func(path string, batchIndex int)
	batchesRead   atomic.Int64
	entriesRead   atomic.Int64
	maxBatchAsked atomic.Int64
}

func (f *hugeBatchScanFS) OpenRoot(_ string, logicalMount string, _ mountInfo) (scanDir, error) {
	return &hugeBatchDir{fs: f, logicalPath: logicalMount}, nil
}

type hugeBatchDir struct {
	fs          *hugeBatchScanFS
	logicalPath string
	offset      int
	batchCount  int
	sentChild   bool
}

func (d *hugeBatchDir) Stat() (entryStat, error) {
	return entryStat{
		Mode:     fs.ModeDir | 0o755,
		Dev:      d.fs.rootDev,
		HasDev:   true,
		Ino:      1,
		Nlink:    2,
		HasInode: true,
		MntID:    d.fs.rootMntID,
		HasMntID: true,
	}, nil
}

func (d *hugeBatchDir) Statfs() (fsStat, error) {
	return fsStat{TotalBytes: 200 << 30, UsedBytes: 10 << 30}, nil
}

func (d *hugeBatchDir) OpenSelf() (scanDir, error) {
	return &hugeBatchDir{fs: d.fs, logicalPath: d.logicalPath}, nil
}

func (d *hugeBatchDir) nextSegmentTowardHuge() (string, bool) {
	if d.logicalPath == d.fs.hugeDirPath {
		return "", false
	}
	if !hasPathPrefix(d.fs.hugeDirPath, d.logicalPath) {
		return "", false
	}
	rel := strings.TrimPrefix(d.fs.hugeDirPath, d.logicalPath)
	rel = strings.TrimPrefix(rel, "/")
	if rel == "" {
		return "", false
	}
	seg, _, _ := strings.Cut(rel, "/")
	return seg, seg != ""
}

func (d *hugeBatchDir) ReadDirBatch(maxEntries int) ([]dirEntryInfo, error) {
	if d.logicalPath != d.fs.hugeDirPath {
		if d.sentChild {
			return nil, io.EOF
		}
		d.sentChild = true
		if seg, ok := d.nextSegmentTowardHuge(); ok {
			return []dirEntryInfo{{Name: seg, Kind: entryDir}}, nil
		}
		return nil, io.EOF
	}
	limit := clampBatchSize(maxEntries)
	for {
		cur := d.fs.maxBatchAsked.Load()
		if int64(maxEntries) <= cur || d.fs.maxBatchAsked.CompareAndSwap(cur, int64(maxEntries)) {
			break
		}
	}
	if d.offset >= d.fs.totalVirtual {
		return nil, io.EOF
	}
	n := min(limit, d.fs.totalVirtual-d.offset)
	out := make([]dirEntryInfo, n)
	for i := 0; i < n; i++ {
		out[i] = dirEntryInfo{
			Name: fmt.Sprintf("f-%07d%s", d.offset+i, d.fs.fileSuffix),
			Kind: entryRegular,
		}
	}
	d.offset += n
	d.batchCount++
	d.fs.batchesRead.Add(1)
	d.fs.entriesRead.Add(int64(n))
	if d.fs.onBatch != nil {
		d.fs.onBatch(d.logicalPath, d.batchCount)
	}
	return out, nil
}

func (d *hugeBatchDir) OpenDir(name, logicalPath string, _, _ bool) (scanDir, error) {
	seg, ok := d.nextSegmentTowardHuge()
	if !ok || name != seg {
		return nil, fs.ErrNotExist
	}
	return &hugeBatchDir{fs: d.fs, logicalPath: logicalPath}, nil
}

func (d *hugeBatchDir) StatEntry(_ string, _ string) (entryStat, error) {
	return entryStat{
		Mode:       0o644,
		Size:       4096,
		AllocBytes: 4096,
		Dev:        d.fs.rootDev,
		HasDev:     true,
		Ino:        2,
		Nlink:      1,
		HasInode:   true,
		MntID:      d.fs.rootMntID,
		HasMntID:   true,
	}, nil
}

func (d *hugeBatchDir) Close() error { return nil }

func TestBatchedReadDirCapsAndCancelsLargeDirectories(t *testing.T) {
	const virtualCount = 5_000_000
	mounts := []mountInfo{{ID: 10, ParentID: 1, MountPoint: "/", FSType: "ext4", Source: "/dev/nvme0n1p2"}}

	t.Run("walkMount_entry_cap", func(t *testing.T) {
		hfs := &hugeBatchScanFS{
			rootDev:      100,
			rootMntID:    10,
			hugeDirPath:  "/srv/huge",
			fileSuffix:   ".bin",
			totalVirtual: virtualCount,
		}
		r := newTestRunner(t, t.TempDir(), mounts, nil)
		r.scanFS = hfs
		r.maxEntries = 1200

		resp := r.DiskUsage(context.Background(), proto.DiskUsageRequest{Mount: "/"})
		if resp.Code != "" {
			t.Fatalf("unexpected error: %+v", resp)
		}
		if !resp.Partial {
			t.Fatalf("expected Partial=true when hitting entry cap on 5M dir")
		}
		if got := hfs.maxBatchAsked.Load(); got > dirBatchSize {
			t.Errorf("ReadDirBatch asked for %d entries at once, want <= %d", got, dirBatchSize)
		}
		// Total entries emitted from /srv/huge must be bounded by maxEntries (never 5M).
		if got := hfs.entriesRead.Load(); got > int64(r.maxEntries+1) {
			t.Errorf("huge dir read %d entries, want <= %d", got, r.maxEntries+1)
		}
		if got := hfs.batchesRead.Load(); got < 2 || got > 4 {
			t.Errorf("huge dir batches read = %d, want 2..4", got)
		}
	})

	t.Run("walkMount_cancel_between_batches", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()

		hfs := &hugeBatchScanFS{
			rootDev:      100,
			rootMntID:    10,
			hugeDirPath:  "/srv/huge",
			fileSuffix:   ".bin",
			totalVirtual: virtualCount,
			onBatch: func(_ string, batchIndex int) {
				if batchIndex == 2 {
					cancel()
				}
			},
		}
		r := newTestRunner(t, t.TempDir(), mounts, nil)
		r.scanFS = hfs
		r.maxEntries = 100_000

		resp := r.DiskUsage(ctx, proto.DiskUsageRequest{Mount: "/"})
		if resp.Code != "" {
			t.Fatalf("unexpected error: %+v", resp)
		}
		if !resp.Partial {
			t.Fatalf("expected Partial=true when cancelled between batches")
		}
		if got := hfs.batchesRead.Load(); got != 2 {
			t.Errorf("expected stop immediately after batch 2 on cancel, read %d batches", got)
		}
	})

	t.Run("walkDirBytes_and_container_logs_caps", func(t *testing.T) {
		// 1. walkDirBytes (/var/log/journal with 5M files) stops at catMaxEntries.
		hfsJournal := &hugeBatchScanFS{
			rootDev:      100,
			rootMntID:    10,
			hugeDirPath:  "/var/log/journal",
			fileSuffix:   ".journal",
			totalVirtual: virtualCount,
		}
		r1 := newTestRunner(t, t.TempDir(), mounts, nil)
		r1.scanFS = hfsJournal
		r1.catMaxEntries = 900
		r1.maxEntries = 10 // keep general walk tiny so only journal reads many batches
		resp1 := r1.DiskUsage(context.Background(), proto.DiskUsageRequest{Mount: "/"})
		if resp1.Code != "" || !resp1.Partial {
			t.Fatalf("journal huge dir: resp = %+v, want Partial=true", resp1)
		}
		if got := hfsJournal.entriesRead.Load(); got > int64(r1.catMaxEntries+r1.maxEntries+2) {
			t.Errorf("journal huge dir read %d entries, want <= %d", got, r1.catMaxEntries+r1.maxEntries+2)
		}

		// 2. collectContainerLogs (/var/lib/docker/containers/c1 with 5M log files) stops at catMaxEntries.
		hfsLogs := &hugeBatchScanFS{
			rootDev:      100,
			rootMntID:    10,
			hugeDirPath:  "/var/lib/docker/containers/c1",
			fileSuffix:   "-json.log",
			totalVirtual: virtualCount,
		}
		r2 := newTestRunner(t, t.TempDir(), mounts, nil)
		r2.scanFS = hfsLogs
		r2.catMaxEntries = 900
		r2.maxEntries = 10
		resp2 := r2.DiskUsage(context.Background(), proto.DiskUsageRequest{Mount: "/"})
		if resp2.Code != "" || !resp2.Partial {
			t.Fatalf("container logs huge dir: resp = %+v, want Partial=true", resp2)
		}
		if got := hfsLogs.entriesRead.Load(); got > int64(r2.catMaxEntries+r2.maxEntries+2) {
			t.Errorf("container logs huge dir read %d entries, want <= %d", got, r2.catMaxEntries+r2.maxEntries+2)
		}
	})
}

type stubUnsupportedScanFS struct {
	msg string
}

func (s stubUnsupportedScanFS) OpenRoot(string, string, mountInfo) (scanDir, error) {
	return nil, &scanUnsupportedError{msg: s.msg}
}

func TestDarwinRootFSIDMismatchRefusedBeforeStatfsOrReadDir(t *testing.T) {
	checkedFSID := [2]int32{0x01000004, 0x1a}
	swappedFSID := [2]int32{0x01000009, 0x1a}

	inv := &proto.Report{
		Filesystems: []proto.Filesystem{
			{Mount: "/Volumes/FastSSD", Device: "/dev/disk5", FSType: "apfs", Disks: []string{"disk4"}},
		},
		Disks: []proto.Disk{
			{Device: "disk4", Type: "ssd"},
		},
	}

	for _, tc := range []struct {
		name       string
		rootFSID   [2]int32
		hasFSID    bool
		wantFailed bool
	}{
		{"matching_fsid", checkedFSID, true, false},
		{"swapped_volume_fsid", swappedFSID, true, true},
		{"missing_root_fsid", [2]int32{}, false, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ffs := newFakeScanFS(fakeModeDarwinBulk, false, 100, 1)
			ffs.addFile("/srv/keep.bin", 16*1024)
			overTracker := &fakeMountTracker{name: tc.name}
			ffs.onOpenRoot = func(_ string, fs *fakeScanFS) {
				fs.mu.Lock()
				fs.root.fsid = tc.rootFSID
				fs.root.hasFSID = tc.hasFSID
				if tc.wantFailed {
					fs.root.tracker = overTracker
				}
				fs.mu.Unlock()
			}

			mounts := []mountInfo{
				{ID: 1, MountPoint: "/Volumes/FastSSD", FSType: "apfs", Source: "/dev/disk5s1", FSID: checkedFSID, HasFSID: true},
			}
			r := newTestRunner(t, t.TempDir(), mounts, inv)
			r.goos = "darwin"
			r.scanFS = ffs
			r.statfs = nil

			resp := r.DiskUsage(context.Background(), proto.DiskUsageRequest{Mount: "/Volumes/FastSSD"})
			if tc.wantFailed {
				if resp.Code != CodeFailed || !strings.Contains(resp.Message, "changed before the scan started") {
					t.Fatalf("resp = %+v, want CodeFailed about changed filesystem", resp)
				}
				if overTracker.statfsCalls.Load() != 0 {
					t.Errorf("Statfs called %d times on mismatched macOS volume, want 0", overTracker.statfsCalls.Load())
				}
				if overTracker.dataReads.Load() != 0 {
					t.Errorf("ReadDir called %d times on mismatched macOS volume, want 0", overTracker.dataReads.Load())
				}
			} else if resp.Code != "" {
				t.Fatalf("unexpected error on matching f_fsid: %+v", resp)
			}
		})
	}
}

func TestUnsupportedPlatformRefusesScanCleanly(t *testing.T) {
	mounts := []mountInfo{{ID: 1, MountPoint: "/", FSType: "ext4", Source: "/dev/nvme0n1p2"}}
	r := newTestRunner(t, t.TempDir(), mounts, nil)
	r.scanFS = stubUnsupportedScanFS{msg: "This server's system does not support safe disk scans."}

	resp := r.DiskUsage(context.Background(), proto.DiskUsageRequest{Mount: "/"})
	if resp.Code != CodeUnsupported {
		t.Fatalf("resp.Code = %q, want %q (resp=%+v)", resp.Code, CodeUnsupported, resp)
	}
	if !strings.Contains(resp.Message, "does not support safe disk scans") {
		t.Errorf("resp.Message = %q, want plain unsupported reason", resp.Message)
	}
}
