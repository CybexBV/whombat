package clearing

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/backup/internal/state"
)

// fakeRepo shrinks by a fixed amount with every forget.
type fakeRepo struct {
	size   int64
	shrink int64
	calls  [][]string
}

func (f *fakeRepo) Forget(_ context.Context, _ string, keep []string) (string, error) {
	f.calls = append(f.calls, keep)
	f.size -= f.shrink
	return "", nil
}

func (f *fakeRepo) StoredSize(context.Context) (int64, error) { return f.size, nil }

func config(t *testing.T, limit *int64) *state.Config {
	c := &state.Config{Persist: t.TempDir()}
	c.Defaults()
	p := state.DefaultPolicy()
	p.LimitBytes = limit
	if err := state.SavePolicy(c, p); err != nil {
		t.Fatal(err)
	}
	return c
}

func keepWithin(args []string) string {
	for i, a := range args {
		if a == "--keep-within" {
			return args[i+1]
		}
	}
	return ""
}

// Over the space limit the box forgets with ever shorter windows until the backups fit, never shorter than every
// backup of the last 7 days; still over at the end, it says so.
func TestSpaceLimitLadder(t *testing.T) {
	gb := int64(1_000_000_000)
	limit := 5 * gb
	d := &state.Destination{Kind: state.KindSFTP, Repository: "sftp:nas:/b", AppendOnly: "not-enforced"}
	now := time.Now()

	c := config(t, &limit)
	f := &fakeRepo{size: 8 * gb, shrink: gb}
	rec := Run(context.Background(), c, d, f, f.StoredSize, now)
	// the person's windows (8→7 GB), then m6 (6), m3 (5 GB: fits)
	if !rec.OK || rec.OverLimit || len(f.calls) != 3 || rec.Bytes == nil || *rec.Bytes != 5*gb {
		t.Fatalf("record %+v, %d forgets", rec, len(f.calls))
	}
	if got := strings.Join(f.calls[2], " "); !strings.Contains(got, "--keep-within-monthly 3m") || keepWithin(f.calls[2]) != "7d" {
		t.Fatalf("third forget %s", got)
	}

	c = config(t, &limit)
	f = &fakeRepo{size: 80 * gb, shrink: gb}
	rec = Run(context.Background(), c, d, f, f.StoredSize, now)
	if !rec.OK || !rec.OverLimit || len(f.calls) != 7 {
		t.Fatalf("never fits: %+v, %d forgets", rec, len(f.calls))
	}
	last := strings.Join(f.calls[6], " ")
	if last != "--keep-within 7d --keep-within-daily 7d" {
		t.Fatalf("the last step %q", last)
	}
	for _, call := range f.calls[1:] {
		if keepWithin(call) != "7d" {
			t.Fatalf("a step shortened the last 7 days: %v", call)
		}
	}
	if st := state.LoadClearing(c); st == nil || !st.OverLimit || len(st.Steps) != 7 {
		t.Fatalf("recorded %+v", st)
	}

	// Without a limit: the person's windows only.
	c = config(t, nil)
	f = &fakeRepo{size: 80 * gb, shrink: gb}
	if rec := Run(context.Background(), c, d, f, f.StoredSize, now); !rec.OK || len(f.calls) != 1 || rec.Bytes != nil {
		t.Fatalf("no limit: %+v %d", rec, len(f.calls))
	}
}

// The box clears wherever its key may delete, a REST server without --append-only too, at most once a day; an
// append-only destination is its own side's.
func TestWhoClears(t *testing.T) {
	c := config(t, nil)
	now := time.Now()
	rest := &state.Destination{Kind: state.KindREST, Repository: "rest:http://10.0.0.2:8000/b/", AppendOnly: "not-enforced"}
	place := &state.Destination{Kind: state.KindREST, Repository: "rest:http://10.0.0.2:8747/b/", AppendOnly: "verified"}
	if state.ClearedBy(rest) != state.ClearedByBox || state.ClearedBy(place) != state.ClearedByDestination {
		t.Fatal("cleared by")
	}
	if !Due(c, rest, now) || Due(c, place, now) || Due(c, nil, now) {
		t.Fatal("due")
	}
	f := &fakeRepo{}
	Run(context.Background(), c, rest, f, f.StoredSize, now)
	if Due(c, rest, now.Add(time.Hour)) || !Due(c, rest, now.Add(Every)) {
		t.Fatal("once a day")
	}
	other := *rest
	other.Repository = "rest:http://10.0.0.3:8000/b/"
	if !Due(c, &other, now.Add(time.Hour)) {
		t.Fatal("a new destination waits a day")
	}
	if !Due(c, rest, now.Add(-48*time.Hour)) {
		t.Fatal("a record dated in the future held clearing back")
	}
	// The status says who clears and how it went.
	s := &state.Status{}
	state.Derive(c, s, rest, now)
	if s.Clearing == nil || s.Clearing.By != state.ClearedByBox || s.Clearing.OK == nil || !*s.Clearing.OK {
		t.Fatalf("status clearing %+v", s.Clearing)
	}
	state.Derive(c, s, place, now)
	if s.Clearing == nil || s.Clearing.By != state.ClearedByDestination || s.Clearing.At != nil {
		t.Fatalf("status clearing for a place %+v", s.Clearing)
	}
	if err := s.Validate(); err != nil {
		t.Fatalf("contract: %v", err)
	}
}
