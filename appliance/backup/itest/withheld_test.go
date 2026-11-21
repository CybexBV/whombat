package itest

import (
	"context"
	"strings"
	"testing"

	"github.com/CybexBV/whombat/appliance/backup/pkg/gitinv"
	"github.com/CybexBV/whombat/appliance/backup/pkg/pgtool"
	"github.com/CybexBV/whombat/appliance/backup/pkg/restore"
)

// I-2 (W4-SEC part 2): the recovery kit records the newest checkpoint the appliance made; a restore from
// a destination that does not have it (withheld newer checkpoints) says so instead of silently restoring
// an older one.
func TestRestoreDetectsWithheldCheckpoints(t *testing.T) {
	w := NewWorld(t)
	w.Configure()
	w.Checkpoint()
	w.Checkpoint()
	mat, err := w.Material()
	if err != nil {
		t.Fatal(err)
	}
	if mat.Head == nil || mat.Head.Seq < 2 || mat.Head.ManifestSHA256 == "" {
		t.Fatalf("kit material has no head: %+v", mat.Head)
	}
	ctx := context.Background()
	run := func(h *restore.ExpectedHead) *restore.Report {
		rep, _ := restore.Run(ctx, restore.Options{Repo: repoOf(t, w), ManifestKey: trustedKey(t, w), Root: t.TempDir(), SkipCheck: true,
			Bins: pgtool.Bins{Dir: w.Cfg.PGBin}, Git: gitinv.Runner{}, ExpectHead: h})
		return rep
	}
	if rep := run(&restore.ExpectedHead{Seq: mat.Head.Seq, ManifestSHA256: mat.Head.ManifestSHA256}); contains(rep.Failed(), "newest-checkpoint") {
		t.Fatalf("head present but reported missing: %+v", rep.Chain)
	}
	// The destination shows only up to the head: a head one newer (what the kit of a later checkpoint
	// would name) means checkpoints are withheld.
	rep := run(&restore.ExpectedHead{Seq: mat.Head.Seq + 1})
	if !contains(rep.Failed(), "newest-checkpoint") || !strings.Contains(rep.Chain.Withheld, "withheld") {
		t.Fatalf("withheld checkpoints not reported: failed %v chain %+v", rep.Failed(), rep.Chain)
	}
	// Same sequence, different manifest: a forked history.
	rep = run(&restore.ExpectedHead{Seq: mat.Head.Seq, ManifestSHA256: strings.Repeat("0", 64)})
	if !contains(rep.Failed(), "newest-checkpoint") {
		t.Fatalf("forked head not reported: %+v", rep.Chain)
	}
}
