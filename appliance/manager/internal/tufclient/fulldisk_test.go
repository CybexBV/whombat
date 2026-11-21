package tufclient_test

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/helper/pkg/trust"
	"github.com/CybexBV/whombat/appliance/manager/internal/tufclient"
	"github.com/CybexBV/whombat/appliance/release-tools/devtuf"
)

// TestFullDiskRealTmpfs stages into a real, tiny tmpfs (mounted in an unprivileged user+mount
// namespace): the capacity check refuses, garbage collection frees only unreferenced files and never
// the known-good artifacts, and a download that hits ENOSPC reports ErrNoSpace.
func TestFullDiskRealTmpfs(t *testing.T) {
	if os.Getenv("WB_IN_NS") == "" {
		if _, err := exec.LookPath("unshare"); err != nil {
			t.Skip("unshare not available")
		}
		cmd := exec.Command("unshare", "--user", "--map-root-user", "--mount", os.Args[0], "-test.run=^TestFullDiskRealTmpfs$", "-test.v", "-test.count=1")
		cmd.Env = append(os.Environ(), "WB_IN_NS=1")
		out, err := cmd.CombinedOutput()
		if strings.Contains(string(out), "--- SKIP") || (err != nil && strings.Contains(string(out), "unshare:")) {
			t.Skipf("user namespaces unavailable: %s", out)
		}
		if err != nil {
			t.Fatalf("namespace run failed: %v\n%s", err, out)
		}
		if !strings.Contains(string(out), "--- PASS: TestFullDiskRealTmpfs") {
			t.Fatalf("inner run did not pass:\n%s", out)
		}
		t.Logf("ran inside a user+mount namespace with a 256 KiB tmpfs")
		return
	}
	mnt := filepath.Join(t.TempDir(), "persist")
	os.MkdirAll(mnt, 0o755)
	if err := syscall.Mount("tmpfs", mnt, "tmpfs", 0, "size=256k"); err != nil {
		t.Skipf("cannot mount tmpfs: %v", err)
	}
	defer syscall.Unmount(mnt, 0)

	r, err := devtuf.New(filepath.Join(t.TempDir(), "repo"), devtuf.Options{})
	if err != nil {
		t.Fatal(err)
	}
	big := devtuf.StandardRelease("rt-big", "26.05.1", "9.0.0")
	big.PadBytes = 300 * 1024
	r.AddFakeRelease(big)
	r.Publish()
	repo, err := trust.Refresh(trust.Config{PinnedRoot: r.InitialRoot(), MetadataDir: t.TempDir(), MetadataURL: "m://x",
		Fetcher: trust.DirFetcher{BaseURL: "m://x", Dir: r.MetadataDir()}, Now: time.Now()})
	if err != nil {
		t.Fatal(err)
	}
	rel, _ := repo.Release("rt-big")
	staging := filepath.Join(mnt, "staging")
	os.MkdirAll(staging, 0o755)
	keepName := strings.Repeat("a", 64)
	os.WriteFile(filepath.Join(staging, keepName), make([]byte, 60*1024), 0o644) // known-good artifact
	os.WriteFile(filepath.Join(staging, strings.Repeat("b", 64)), make([]byte, 60*1024), 0o644)
	d := &tufclient.Downloader{StagingDir: staging, Source: tufclient.DirSource{Dir: r.TargetsDir()}, Space: tufclient.StatfsSpace{}}
	// The runtime's index and the blobs it names (the runtime's is the big one).
	ip, _ := r.TargetFilePath(rel.RuntimeIndex.Target)
	ib, _ := os.ReadFile(ip)
	ci, err := trust.ParseClosureIndex(ib, *rel.RuntimeIndex)
	if err != nil {
		t.Fatal(err)
	}
	arts := []trust.Artifact{*rel.RuntimeIndex}
	for i := range ci.Paths {
		arts = append(arts, ci.Blob(i))
	}
	blob := arts[len(arts)-1]
	if blob.Length < 200*1024 {
		t.Fatalf("the runtime's blob is %d bytes", blob.Length)
	}
	err = d.EnsureSpace(arts, map[string]bool{keepName: true})
	if !errors.Is(err, tufclient.ErrNoSpace) {
		t.Fatalf("capacity check: %v", err)
	}
	if _, err := os.Stat(filepath.Join(staging, keepName)); err != nil {
		t.Fatal("known-good artifact was deleted to make room")
	}
	if _, err := os.Stat(filepath.Join(staging, strings.Repeat("b", 64))); !os.IsNotExist(err) {
		t.Fatal("unreferenced file was not garbage-collected")
	}
	// Bypass the capacity check: the write itself hits ENOSPC and is reported as no space.
	fill := filepath.Join(mnt, "fill")
	os.WriteFile(fill, make([]byte, 120*1024), 0o644)
	if err := d.Download(context.Background(), blob); !errors.Is(err, tufclient.ErrNoSpace) {
		t.Fatalf("download on a full disk: %v", err)
	}
	if b, err := os.ReadFile(filepath.Join(staging, keepName)); err != nil || len(b) != 60*1024 {
		t.Fatal("known-good artifact damaged")
	}
}
