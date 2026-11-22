package diskusage

import (
	"context"
	"encoding/json"
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
	if got := standbyFromSmartctl([]byte(`{"smartctl":{"exit_status":2,"messages":[{"string":"Device is in STANDBY mode, exit(2)"}]}}`), os.ErrInvalid); got != standbyAsleep {
		t.Errorf("expected STANDBY JSON -> standbyAsleep, got %v", got)
	}
	if got := standbyFromSmartctl([]byte(`{"smartctl":{"exit_status":0,"messages":[]}}`), nil); got != standbyAwake {
		t.Errorf("active disk -> %v, want standbyAwake", got)
	}
	if got := standbyFromSmartctl([]byte(`{"smartctl":{"exit_status":2,"messages":[{"string":"Open device failed: Permission denied"}]}}`), os.ErrPermission); got != standbyUnknown {
		t.Errorf("permission error -> %v, want standbyUnknown", got)
	}
	if got := standbyFromHdparm([]byte(" drive state is:  standby\n")); got != standbyAsleep {
		t.Errorf("hdparm standby -> %v", got)
	}
	if got := standbyFromHdparm([]byte(" drive state is:  active/idle\n")); got != standbyAwake {
		t.Errorf("hdparm active/idle -> %v", got)
	}
	if got := standbyFromHdparm([]byte(" drive state is:  unknown\n")); got != standbyUnknown {
		t.Errorf("hdparm unknown -> %v", got)
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
	var statted []string
	r.lstat = func(path string) (fs.FileInfo, error) {
		rel, err := filepath.Rel(root, path)
		if err == nil {
			logical := "/" + filepath.ToSlash(rel)
			if rel == "." {
				logical = "/"
			}
			mu.Lock()
			statted = append(statted, logical)
			mu.Unlock()
		}
		return os.Lstat(path)
	}

	resp := r.DiskUsage(context.Background(), proto.DiskUsageRequest{Mount: "/mnt/cache"})
	if resp.Code != "" {
		t.Fatalf("unexpected error: %+v", resp)
	}

	// No stat may ever touch paths outside /mnt/cache or beneath nested/bind mounts.
	for _, p := range statted {
		if !hasPathPrefix(p, "/mnt/cache") {
			t.Errorf("lstat escaped /mnt/cache to %q", p)
		}
		if hasPathPrefix(p, "/mnt/cache/nested") {
			t.Errorf("lstat touched nested mount %q", p)
		}
		if hasPathPrefix(p, "/mnt/cache/bind") {
			t.Errorf("lstat touched bind mount %q", p)
		}
		if p == "/mnt/cache/esc/domains" {
			t.Errorf("lstat followed intermediate symlink to %q", p)
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
