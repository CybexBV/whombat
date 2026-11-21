package itest

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/unix"

	"github.com/CybexBV/whombat/appliance/backup/internal/checkpoint"
	"github.com/CybexBV/whombat/appliance/backup/internal/runtimeadmin"
	"github.com/CybexBV/whombat/appliance/backup/internal/snap"
	"github.com/CybexBV/whombat/appliance/backup/internal/state"
)

// Disk full while staging. The staging directory is a small tmpfs mounted in a user+mount namespace
// (unshare -rm), so the space limits are real: the database preflight refuses early, the copy's own
// estimate refuses before copying, and a real ENOSPC in the middle of the copy is cleaned up. Every time
// the runtime is resumed and staging is left empty.
func TestDiskFullDuringStaging(t *testing.T) {
	if _, err := exec.LookPath("unshare"); err != nil {
		t.Skip("unshare not available")
	}
	if out, err := exec.Command("unshare", "-rm", "true").CombinedOutput(); err != nil {
		t.Skipf("unprivileged user namespaces unavailable: %v %s", err, out)
	}
	w := NewWorld(t)
	w.Configure()
	// 24 MB of workspace data: more than the copy may use on the tmpfs.
	big := make([]byte, 24<<20)
	for i := range big {
		big[i] = byte(i * 7)
	}
	if err := os.WriteFile(filepath.Join(w.Cfg.Layout().Workspaces(), "b1", "proj", "big.bin"), big, 0o644); err != nil {
		t.Fatal(err)
	}
	cfgPath := filepath.Join(w.Dir, "diskfull-config.json")
	b, _ := json.Marshal(w.Cfg)
	if err := os.WriteFile(cfgPath, b, 0o600); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("unshare", "-rm", os.Args[0], "-test.run", "^TestDiskFullInner$", "-test.v", "-test.count=1")
	cmd.Env = append(os.Environ(), "WB_DISKFULL_CONFIG="+cfgPath)
	out, err := cmd.CombinedOutput()
	t.Logf("inner:\n%s", out)
	if err != nil || !strings.Contains(string(out), "--- PASS: TestDiskFullInner") {
		t.Fatalf("inner test failed: %v", err)
	}
	if w.Runtime.Barrier() {
		t.Fatal("runtime left paused")
	}
	drains, resumes := w.Runtime.Counts()
	t.Logf("fake runtime: %d drain requests, %d resumes", drains, resumes)
	if resumes < 2 {
		t.Fatalf("resumes %d", resumes)
	}
}

func TestDiskFullInner(t *testing.T) {
	path := os.Getenv("WB_DISKFULL_CONFIG")
	if path == "" {
		t.Skip("run by TestDiskFullDuringStaging inside a user namespace")
	}
	cfg, err := state.LoadConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	stagingParent := filepath.Dir(cfg.StagingDir())
	if err := os.MkdirAll(stagingParent, 0o700); err != nil {
		t.Fatal(err)
	}
	mount := func(size string) {
		t.Helper()
		_ = unix.Unmount(stagingParent, 0)
		if err := unix.Mount("tmpfs", stagingParent, "tmpfs", 0, "size="+size+",mode=0700"); err != nil {
			t.Fatalf("mount tmpfs: %v", err)
		}
	}
	runner := func(reserve int64) *checkpoint.Runner {
		cfg.ReserveBytes = reserve
		return &checkpoint.Runner{Cfg: cfg, Runtime: runtimeadmin.New(cfg.RuntimeSocket), Poll: 50 * time.Millisecond,
			Snap: &snap.Local{Driver: snap.Copy{Reserve: reserve}, Sources: cfg.Layout().Sources(), FilesDir: filepath.Join(cfg.StagingDir(), "files")},
			Log:  t.Logf}
	}
	expect := func(name string, err error, stage string) {
		t.Helper()
		var se *checkpoint.StageError
		if !errors.As(err, &se) || se.Stage != stage || !errors.Is(err, snap.ErrNoSpace) && !strings.Contains(se.Reason, "space") {
			t.Fatalf("%s: want %s no-space failure, got %v", name, stage, err)
		}
		t.Logf("%s: %s: %s", name, se.Stage, se.Reason)
		ents, _ := os.ReadDir(cfg.StagingDir())
		var left []string
		for _, e := range ents {
			sub, _ := os.ReadDir(filepath.Join(cfg.StagingDir(), e.Name()))
			if len(sub) > 0 {
				left = append(left, e.Name())
			}
		}
		if len(left) > 0 {
			t.Fatalf("%s: staging not cleaned: %v", name, left)
		}
		st, _ := state.CurrentStatus(cfg)
		if st.LastFailure == nil || st.LastFailure.Stage != stage || !FailedTry(st) {
			t.Fatalf("%s: status %+v", name, st.LastFailure)
		}
		if err := st.Validate(); err != nil {
			t.Fatalf("%s: status fails the contract: %v", name, err)
		}
	}

	// 1. Too small for the database dump: refused in preflight, nothing paused.
	mount("2m")
	_, err = runner(1<<20).Run(context.Background(), checkpoint.Options{Reason: "test"})
	expect("dump preflight", err, "preflight")

	// 2. Room for the dump, not for the files: the copy's estimate refuses before copying.
	mount("20m")
	_, err = runner(1<<20).Run(context.Background(), checkpoint.Options{Reason: "test"})
	expect("copy estimate", err, "snapshot")

	// 3. The estimate bypassed (negative reserve): a real ENOSPC in the middle of the copy.
	_, err = runner(-(64 << 20)).Run(context.Background(), checkpoint.Options{Reason: "test"})
	expect("ENOSPC mid-copy", err, "snapshot")
	var st unix.Statfs_t
	_ = unix.Statfs(stagingParent, &st)
	t.Logf("tmpfs after cleanup: %d of %d blocks free", st.Bfree, st.Blocks)
	if st.Bfree < st.Blocks*9/10 {
		t.Fatal("space not released after the failed copy")
	}
}
