package itest

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/backup/internal/checkpoint"
	"github.com/CybexBV/whombat/appliance/backup/pkg/restore"
)

// A checkpoint whose snapshot reached the destination but whose read-back failed keeps its sequence number: the next
// checkpoint gets the following one and links to the last one read back, the list has no two at one number and no
// gap, and a head recorded at either number is found.
func TestSequenceSurvivesAFailedReadBack(t *testing.T) {
	w := NewWorld(t)
	w.Configure()
	ctx := context.Background()
	first := w.Checkpoint()
	r := w.Runner()
	r.AfterUpload = func() error { return errors.New("the destination stopped answering") }
	if _, err := r.Run(ctx, checkpoint.Options{Reason: "test"}); err == nil {
		t.Fatal("the read-back failure passed")
	}
	third := w.Checkpoint()
	if first.Manifest.Seq != 1 || third.Manifest.Seq != 3 {
		t.Fatalf("seq %d then %d", first.Manifest.Seq, third.Manifest.Seq)
	}
	if p := third.Manifest.Previous; p == nil || p.ID != first.Manifest.ID {
		t.Fatalf("previous %+v", third.Manifest.Previous)
	}
	repo, key := repoOf(t, w), trustedKey(t, w)
	cps, chain, err := restore.List(ctx, repo, key, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	seen := map[int64]bool{}
	for _, c := range cps {
		if seen[c.Manifest.Seq] {
			t.Fatalf("two checkpoints at seq %d", c.Manifest.Seq)
		}
		seen[c.Manifest.Seq] = true
	}
	if len(cps) != 3 || len(chain.Gaps) > 0 || chain.NewestSeq != 3 {
		t.Fatalf("%d checkpoints, chain %+v", len(cps), chain)
	}
}
