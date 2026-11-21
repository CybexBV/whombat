package trust_test

import (
	"testing"

	"github.com/CybexBV/whombat/appliance/helper/pkg/trust"
	"github.com/CybexBV/whombat/appliance/release-tools/devtuf"
	"github.com/CybexBV/whombat/contracts/go/release"
)

// The community edition's newest release (MG-136, UP-X27): the greatest forward release of the verified repository,
// never an incompatible one, an older one without custody's permission, or the installed tuple itself.
func TestNewestRelease(t *testing.T) {
	c := &clock{t0}
	r := newRepo(t, c) // rt-1: 26.05.1, runtime 1.0.0
	add := func(f devtuf.FakeRelease) {
		t.Helper()
		if _, err := r.AddFakeRelease(f); err != nil {
			t.Fatal(err)
		}
	}
	add(devtuf.StandardRelease("rt-2", "26.05.1", "1.1.0"))
	add(devtuf.StandardRelease("rt-3", "26.05.2", "1.2.0"))
	add(devtuf.StandardRelease("rt-old", "26.05.1", "0.9.0"))
	// The greatest versions of all, but its runtime can't run on its host: skipped.
	bad := devtuf.StandardRelease("rt-incompatible", "26.06.0", "3.0.0")
	bad.RuntimeHostABI = release.IntRange{Min: 7, Max: 9}
	add(bad)
	// A custody rollback for boxes on rt-3 (older than it, TUF-signed permission).
	back := devtuf.StandardRelease("rt-back", "26.05.1", "1.0.5")
	back.AllowDowngradeFrom = []string{"rt-3"}
	add(back)
	if err := r.Publish(); err != nil {
		t.Fatal(err)
	}
	repo, err := trust.Refresh(cfg(r, t.TempDir(), c.t))
	if err != nil {
		t.Fatal(err)
	}
	rel := func(id string) *trust.Release {
		t.Helper()
		x, err := repo.Release(id)
		if err != nil {
			t.Fatal(err)
		}
		return x
	}
	newest := func(cur *trust.Release) string {
		t.Helper()
		var got *trust.Release
		if cur == nil {
			got, err = repo.NewestRelease("", nil, "")
		} else {
			v := cur.VersionsOf()
			got, err = repo.NewestRelease(cur.ID(), &v, cur.Digest)
		}
		if err != nil {
			t.Fatal(err)
		}
		if got == nil {
			return ""
		}
		return got.ID()
	}
	for _, tc := range []struct {
		name string
		cur  *trust.Release
		want string
	}{
		{"from the factory", rel("rt-1"), "rt-3"},
		{"from one in between", rel("rt-2"), "rt-3"},
		{"no installed versions: every compatible one counts", nil, "rt-3"},
		{"the newest installed: custody's rollback is the only way on", rel("rt-3"), "rt-back"},
		{"from an old one", rel("rt-old"), "rt-3"},
	} {
		if got := newest(tc.cur); got != tc.want {
			t.Errorf("%s: %q, want %q", tc.name, got, tc.want)
		}
	}
	// Without the rollback, the newest installed has nothing newer.
	r.RemoveTarget(trust.ReleaseTarget("rt-back"))
	if err := r.Publish(); err != nil {
		t.Fatal(err)
	}
	if repo, err = trust.Refresh(cfg(r, t.TempDir(), c.t)); err != nil {
		t.Fatal(err)
	}
	if got := newest(rel("rt-3")); got != "" {
		t.Fatalf("nothing newer than rt-3: %q", got)
	}
	// The same versions under two ids: the later id (`.10` after `.9`, not as text).
	add(devtuf.StandardRelease("whombat-community-20261024.9", "26.05.3", "1.3.0"))
	add(devtuf.StandardRelease("whombat-community-20261024.10", "26.05.3", "1.3.0"))
	if err := r.Publish(); err != nil {
		t.Fatal(err)
	}
	if repo, err = trust.Refresh(cfg(r, t.TempDir(), c.t)); err != nil {
		t.Fatal(err)
	}
	if got := newest(rel("rt-3")); got != "whombat-community-20261024.10" {
		t.Fatalf("tie: %q", got)
	}
}
