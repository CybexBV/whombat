package restore

import (
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/backup/pkg/manifest"
	"github.com/CybexBV/whombat/appliance/backup/pkg/restic"
)

func cp(seq int64, sha, snap string, at time.Time) Checkpoint {
	return Checkpoint{Snapshot: restic.Snapshot{ID: snap, ShortID: snap, Time: at},
		Manifest: &manifest.Manifest{ID: "ck-" + snap, Seq: seq, CreatedAt: at}, SHA256: sha}
}

// Two snapshots at one sequence (a number reused before numbers were handed out ahead): the order is the same on every
// call, and the head check finds the recorded one whichever restic listed first.
func TestCheckpointOrderAndHeadAreStable(t *testing.T) {
	t0 := time.Date(2026, 11, 4, 3, 0, 0, 0, time.UTC)
	a, b, c := cp(2, "aaa", "s-a", t0), cp(2, "bbb", "s-b", t0.Add(time.Minute)), cp(1, "one", "s-1", t0.Add(-time.Hour))
	for _, in := range [][]Checkpoint{{a, b, c}, {b, a, c}, {c, b, a}} {
		cps := append([]Checkpoint(nil), in...)
		sortCheckpoints(cps)
		if cps[0].Snapshot.ID != "s-1" || cps[1].Snapshot.ID != "s-a" || cps[2].Snapshot.ID != "s-b" {
			t.Fatalf("order %v %v %v", cps[0].Snapshot.ID, cps[1].Snapshot.ID, cps[2].Snapshot.ID)
		}
		for _, want := range []string{"aaa", "bbb"} {
			if _, withheld := checkHead(cps, 2, &ExpectedHead{Seq: 2, ManifestSHA256: want}); withheld != "" {
				t.Fatalf("head %s reported withheld: %s", want, withheld)
			}
		}
		if _, withheld := checkHead(cps, 2, &ExpectedHead{Seq: 2, ManifestSHA256: "other"}); withheld == "" {
			t.Fatal("another manifest at the recorded sequence passed")
		}
		if _, withheld := checkHead(cps, 2, &ExpectedHead{Seq: 3}); withheld == "" {
			t.Fatal("a missing newer checkpoint passed")
		}
	}
}

// Only the checkpoints the caller trusts may be restored: the others count as unauthentic and the newest is the newest
// trusted one (an earlier Whombat's later backups, after one of its backups was brought back).
func TestTrustedOnly(t *testing.T) {
	t0 := time.Date(2026, 11, 4, 3, 0, 0, 0, time.UTC)
	cps := []Checkpoint{cp(1, "one", "s-1", t0), cp(2, "two", "s-2", t0.Add(time.Hour)), cp(3, "later", "s-3", t0.Add(2*time.Hour))}
	out, cr := trustedOnly(cps, ChainReport{Checkpoints: 3, NewestSeq: 3}, func(sha string) bool { return sha != "later" })
	if len(out) != 2 || out[1].SHA256 != "two" || cr.Checkpoints != 2 || cr.NewestSeq != 2 || len(cr.Unauthentic) != 1 || cr.Unauthentic[0] != "s-3" {
		t.Fatalf("kept %d, chain %+v", len(out), cr)
	}
	if out, cr := trustedOnly(cps, ChainReport{}, func(string) bool { return false }); len(out) != 0 || cr.NewestSeq != 0 {
		t.Fatalf("none trusted: %d %+v", len(out), cr)
	}
}
