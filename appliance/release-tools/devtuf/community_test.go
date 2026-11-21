package devtuf_test

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/CybexBV/whombat/appliance/helper/pkg/trust"
	"github.com/CybexBV/whombat/appliance/release-tools/devtuf"
)

// The community edition's repository (Whombat HE-58, UP-X27): its own id family, signed by it alone, no assignment key,
// test keys only.
func TestCommunityRepository(t *testing.T) {
	if f, day, n := devtuf.ReleaseFamily("whombat-community-20261024.2"); f != "community" || day != 20261024 || n != 2 {
		t.Fatalf("%s %d %d", f, day, n)
	}
	if devtuf.CompareReleaseIDs("whombat-community-20261024.9", "whombat-community-20261024.10") != -1 {
		t.Fatal("community ids order by counter")
	}
	cand := devtuf.ReleaseSummary{ID: "whombat-community-20261024.1", Host: "whombat-community-20261024.1", Runtime: "0.2.0-20261024070000.1a2b3c4", Manager: "0.3.0-20261024070000.5d6e7f8"}
	if _, err := devtuf.CheckNewer(nil, cand, devtuf.NewerOptions{Community: true}); err != nil {
		t.Fatal(err)
	}
	// No other repository signs a community id, and the community one signs nothing else.
	for _, o := range []devtuf.NewerOptions{{}, {Production: true}} {
		if _, err := devtuf.CheckNewer(nil, cand, o); !errors.Is(err, devtuf.ErrReleaseID) {
			t.Fatalf("%+v: %v", o, err)
		}
	}
	for _, id := range []string{"whombat-dev-20261024.1", "whombat-20261024.1", "rt-fixture-1"} {
		if _, err := devtuf.CheckNewer(nil, devtuf.ReleaseSummary{ID: id, Host: "1", Runtime: "1", Manager: "1"}, devtuf.NewerOptions{Community: true}); !errors.Is(err, devtuf.ErrReleaseID) {
			t.Fatalf("%s: %v", id, err)
		}
	}
	// Ordered like the others: an older one is refused.
	pub := []devtuf.ReleaseSummary{cand}
	older := cand
	older.ID = "whombat-community-20261025.1"
	older.Runtime = "0.2.0-20261023070000.0000000"
	if _, err := devtuf.CheckNewer(pub, older, devtuf.NewerOptions{Community: true}); !errors.Is(err, devtuf.ErrNotNewer) {
		t.Fatal(err)
	}

	dir := filepath.Join(t.TempDir(), "repo")
	r, err := devtuf.New(dir, devtuf.Options{Env: "dev", Edition: devtuf.EditionCommunity})
	if err != nil {
		t.Fatal(err)
	}
	if !r.Community() || r.AssignmentKeyID() != "" {
		t.Fatal("a community repository has no assignment key")
	}
	if _, err := os.Stat(filepath.Join(dir, "metadata", "1.targets.json")); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "metadata", "1.targets.json")); strings.Contains(string(b), trust.AssignmentKeysTarget) {
		t.Fatal("assignment keys published")
	}
	if _, err := r.Assign("wb-x", "whombat-community-20261024.1", 1, 0); err == nil {
		t.Fatal("assigned in a community repository")
	}
	if devtuf.EditionOf(dir) != devtuf.EditionCommunity {
		t.Fatal("state.json names no edition")
	}
	r2, err := devtuf.Load(dir, devtuf.Options{})
	if err != nil || !r2.Community() {
		t.Fatalf("%v", err)
	}
	// Development keys only.
	for _, o := range []devtuf.Options{{Env: "prod", Edition: devtuf.EditionCommunity}, {Env: "prod", Edition: devtuf.EditionCommunity, Custody: devtuf.CustodyOnlinePilot, KeysDir: t.TempDir()}} {
		if _, err := devtuf.New(filepath.Join(t.TempDir(), "p"), o); err == nil || !strings.Contains(err.Error(), "(test) keys") {
			t.Fatalf("%+v: %v", o, err)
		}
	}
	b, _ := os.ReadFile(filepath.Join(dir, "state.json"))
	if !strings.Contains(string(b), `"edition": "community"`) {
		t.Fatal(string(b))
	}
}
