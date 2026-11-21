package itest

import (
	"context"
	"os"
	"testing"

	"github.com/CybexBV/whombat/appliance/backup/internal/checkpoint"
	"github.com/CybexBV/whombat/appliance/backup/internal/state"
)

// The seal unit seals a new destination's plain secrets and removes them while a checkpoint may be running (it runs
// when a backup unit starts): the checkpoint keeps its own copy of the repository password, so its read-back still
// works, and nothing of the copy stays behind.
func TestCheckpointSurvivesTheSeal(t *testing.T) {
	w := NewWorld(t)
	w.Configure()
	plain := w.Cfg.SecretWritePath(state.SecretRepositoryPassword)
	if _, err := os.Stat(plain); err != nil {
		t.Fatalf("the destination's password isn't a plain file: %v", err)
	}
	r := w.Runner()
	r.AfterUpload = func() error { return os.Remove(plain) } // what the seal does after sealing it
	res, err := r.Run(context.Background(), checkpoint.Options{Reason: "test"})
	if err != nil {
		t.Fatalf("checkpoint: %v", err)
	}
	if res.Manifest.Seq != 1 {
		t.Fatalf("seq %d", res.Manifest.Seq)
	}
	entries, _ := os.ReadDir(w.Cfg.StateDir)
	for _, e := range entries {
		if len(e.Name()) > 8 && e.Name()[:8] == ".pinned-" {
			t.Fatalf("the run's copy stayed: %s", e.Name())
		}
	}
}
