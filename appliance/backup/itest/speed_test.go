package itest

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/backup/internal/drill"
	"github.com/CybexBV/whombat/appliance/backup/internal/listing"
	"github.com/CybexBV/whombat/appliance/backup/internal/state"
)

// countingRestic puts a wrapper in front of restic that logs every invocation's arguments, one line each.
func countingRestic(t *testing.T, w *World) (log string) {
	t.Helper()
	dir := t.TempDir()
	log = filepath.Join(dir, "calls")
	bin := filepath.Join(dir, "restic")
	script := "#!/bin/sh\necho \"$*\" >> " + log + "\nexec " + w.Tools.Restic + " \"$@\"\n"
	if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	w.Cfg.Restic = bin
	return log
}

func calls(t *testing.T, log string) []string {
	b, err := os.ReadFile(log)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		t.Fatal(err)
	}
	_ = os.Remove(log)
	return strings.Split(strings.TrimSpace(string(b)), "\n")
}

func count(cs []string, sub string) int {
	n := 0
	for _, c := range cs {
		if strings.Contains(c, sub) {
			n++
		}
	}
	return n
}

// A check reads each manifest the box already has from its cache (verified again) and downloads the index once into a
// cache of its own, not once per restic call; a list reads an unauthentic snapshot once, not on every call.
func TestChecksAndListsReuseWhatWasRead(t *testing.T) {
	ctx := context.Background()
	w := NewWorld(t)
	w.Configure()
	for i := 0; i < 3; i++ {
		w.Checkpoint()
	}
	log := countingRestic(t, w)
	rep, err := drill.Run(ctx, w.Cfg, drill.Options{ServerAdminDSN: w.Tools.AdminDSN, DBPrefix: "whombat_bk_test_p", Log: t.Logf})
	if err != nil || !rep.OK {
		t.Fatalf("drill %v %v", err, rep.Failed())
	}
	cs := calls(t, log)
	if n := count(cs, "dump"); n != 0 {
		t.Fatalf("the check downloaded %d manifests the box had: %v", n, cs)
	}
	if n := count(cs, "--no-cache"); n != 0 {
		t.Fatalf("%d restic calls without a cache: %v", n, cs)
	}
	if n := count(cs, "--with-cache"); n != 1 {
		t.Fatalf("restic check didn't fill the check's cache: %v", cs)
	}

	// A snapshot tagged as a checkpoint whose manifest doesn't verify: read once, then remembered.
	repo := repoOf(t, w)
	dir := t.TempDir()
	WriteFile(t, filepath.Join(dir, "db", "whombat.pgdump"), "forged")
	WriteFile(t, filepath.Join(dir, "manifest", "checkpoint.json"), `{"kind":"whombat.checkpoint/1"}`)
	WriteFile(t, filepath.Join(dir, "manifest", "checkpoint.sig"), `{}`)
	uploadCheckpointLike(t, repo, dir, "ck-forged", strings.Repeat("0", 64), time.Now())
	keys, err := listing.LoadKeys(w.Cfg)
	if err != nil {
		t.Fatal(err)
	}
	for i, wantDumps := range []int{2, 0} {
		res, err := listing.List(ctx, w.Cfg, w.Cfg.Repo(mustDestination(t, w)), keys)
		if err != nil || len(res.Checkpoints) != 3 || res.Unauthentic != 1 {
			t.Fatalf("list %d: %v %+v", i, err, res)
		}
		if n := count(calls(t, log), "dump"); n != wantDumps {
			t.Fatalf("list %d read %d manifests, want %d", i, n, wantDumps)
		}
	}
}

func mustDestination(t *testing.T, w *World) *state.Destination {
	d, err := stateDest(w)
	if err != nil || d == nil {
		t.Fatal(err)
	}
	return d
}
