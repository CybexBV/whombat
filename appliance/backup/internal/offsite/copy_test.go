package offsite

import (
	"slices"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/backup/pkg/manifest"
	"github.com/CybexBV/whombat/appliance/backup/pkg/restic"
)

func snap(id, host string, at time.Time) restic.Snapshot {
	return restic.Snapshot{ID: "sn-" + id, Hostname: host, Time: at,
		Tags: []string{manifest.TagProduct, manifest.TagIDPrefix + id}}
}

func ids(snaps []restic.Snapshot) []string {
	var out []string
	for _, sn := range snaps {
		out = append(out, sn.Tag(manifest.TagIDPrefix))
	}
	return out
}

// What is copied comes from the bucket's own list: a checkpoint sent there once but gone from the bucket now (emptied
// or pruned by hand) is copied again; one this box's own clearing took out isn't.
func TestMissingReadsTheBucket(t *testing.T) {
	t0 := time.Date(2026, 11, 28, 3, 0, 0, 0, time.UTC)
	main := []restic.Snapshot{snap("a", "box", t0), snap("b", "box", t0.Add(time.Hour)), snap("c", "box", t0.Add(2*time.Hour))}
	inCopy := checkpointIDs([]restic.Snapshot{snap("b", "box", t0.Add(time.Hour))})
	if got := ids(missing(main, inCopy, nil)); !slices.Equal(got, []string{"a", "c"}) {
		t.Fatalf("missing: %v", got)
	}
	if got := ids(missing(main, inCopy, []string{"a"})); !slices.Equal(got, []string{"c"}) {
		t.Fatalf("missing after a clearing: %v", got)
	}
	if got := ids(missing(main, map[string]bool{}, nil)); len(got) != 3 {
		t.Fatalf("an emptied bucket copies everything again: %v", got)
	}
}

// The status names only what the bucket's list showed, the newest of it as the checkpoint; a bucket that holds none of
// the main place's backups has no checkpoint (never one remembered from before).
func TestConfirmedIsWhatTheListShowed(t *testing.T) {
	now := time.Date(2026, 11, 28, 12, 0, 0, 0, time.UTC)
	main := []restic.Snapshot{snap("a", "box", now.Add(-3*time.Hour)), snap("b", "box", now.Add(-2*time.Hour)),
		snap("future", "box", now.Add(48*time.Hour))}
	got, newest := confirmed(main, checkpointIDs(main[:2]), now)
	if !slices.Equal(got, []string{"a", "b"}) || newest == nil || newest.Tag(manifest.TagIDPrefix) != "b" {
		t.Fatalf("confirmed %v, newest %v", got, newest)
	}
	got, newest = confirmed(main, checkpointIDs(main), now)
	if len(got) != 3 || newest.Tag(manifest.TagIDPrefix) != "b" {
		t.Fatalf("a backup dated ahead stood for the newest: %v %v", got, newest)
	}
	if got, newest := confirmed(main, map[string]bool{}, now); got != nil || newest != nil {
		t.Fatalf("an empty bucket confirmed %v %v", got, newest)
	}
}

// Checkpoints this box cleared from the copy are remembered only while the main place still has them.
func TestClearedFollowsTheMainPlace(t *testing.T) {
	t0 := time.Date(2026, 11, 28, 3, 0, 0, 0, time.UTC)
	main := []restic.Snapshot{snap("a", "box", t0), snap("b", "box", t0.Add(time.Hour))}
	before := map[string]bool{"a": true, "b": true, "old": true}
	after := map[string]bool{"b": true}
	if got := gone(before, after); !slices.Equal(got, []string{"a", "old"}) {
		t.Fatalf("gone: %v", got)
	}
	if got := stillAtMain([]string{"a", "old", "a"}, main); !slices.Equal(got, []string{"a"}) {
		t.Fatalf("still at the main place: %v", got)
	}
}
