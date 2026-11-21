package trust

import (
	"encoding/json"
	"errors"
	"os"
	"testing"

	"github.com/CybexBV/whombat/contracts/go/release"
)

func TestCompareVersions(t *testing.T) {
	for _, c := range []struct {
		a, b string
		want int
	}{
		{"1.2.0", "1.10.0", -1}, {"26.05.2", "26.05.1", 1}, {"1.0", "1.0.0", 0}, {"1.2.0-rc.1", "1.2.0", -1},
		{"1.2.0-rc.2", "1.2.0-rc.10", -1}, {"1.2.0+build5", "1.2.0", 0}, {"0.0.0-dev", "0.0.0-dev", 0},
	} {
		if got := CompareVersions(c.a, c.b); got != c.want {
			t.Errorf("CompareVersions(%q, %q) = %d, want %d", c.a, c.b, got, c.want)
		}
		if got := CompareVersions(c.b, c.a); got != -c.want {
			t.Errorf("CompareVersions(%q, %q) = %d, want %d", c.b, c.a, got, -c.want)
		}
	}
}

// The contracts' compareVersions vectors (CT-135: semver, host ids, the text trap of 0.1.0-<rev>, the transition to
// 0.2.0-<commit time>.<rev>) hold for the helper's CompareVersions, which the forward check uses.
func TestCompareVersionsContractVectors(t *testing.T) {
	b, err := os.ReadFile("../../../../contracts/go/testdata/vectors/compat.json")
	if err != nil {
		t.Fatal(err)
	}
	var v struct {
		Versions []struct {
			Name   string `json:"name"`
			A      string `json:"a"`
			B      string `json:"b"`
			Expect int    `json:"expect"`
		} `json:"versions"`
	}
	if err := json.Unmarshal(b, &v); err != nil || len(v.Versions) < 10 {
		t.Fatalf("vectors: %d, %v", len(v.Versions), err)
	}
	for _, c := range v.Versions {
		if got := CompareVersions(c.A, c.B); got != c.Expect {
			t.Errorf("%s: CompareVersions(%q, %q) = %d, want %d", c.Name, c.A, c.B, got, c.Expect)
		}
		if got := CompareVersions(c.B, c.A); got != -c.Expect {
			t.Errorf("%s: CompareVersions(%q, %q) = %d, want %d", c.Name, c.B, c.A, got, -c.Expect)
		}
	}
}

func TestCheckForward(t *testing.T) {
	rel := func(id, host, rt, mgr string, allow ...string) *Release {
		r := &Release{AllowDowngradeFrom: allow}
		r.Tuple = release.ReleaseTuple{ReleaseID: id}
		r.Tuple.Host.Version, r.Tuple.Runtime.Version, r.Tuple.Manager.Version = host, rt, mgr
		return r
	}
	cur := Versions{Host: "26.05.2", Runtime: "1.2.0", Manager: "0.5.1"}
	if err := CheckForward("rt-4", cur, rel("rt-5", "26.05.2", "1.3.0", "0.5.1")); err != nil {
		t.Fatalf("forward refused: %v", err)
	}
	if err := CheckForward("rt-4", cur, rel("rt-4b", "26.05.2", "1.2.0", "0.5.1")); err != nil {
		t.Fatalf("same versions refused: %v", err)
	}
	for _, r := range []*Release{rel("rt-2", "26.05.1", "1.2.0", "0.5.1"), rel("rt-3", "26.05.2", "1.1.0", "0.5.1"),
		rel("rt-3m", "26.05.2", "1.2.0", "0.5.0"), rel("rt-2x", "26.05.1", "1.1.0", "0.5.1", "rt-9")} {
		if err := CheckForward("rt-4", cur, r); !errors.Is(err, ErrDowngrade) {
			t.Errorf("%s: downgrade accepted: %v", r.Tuple.ReleaseID, err)
		}
	}
	if err := CheckForward("rt-4", cur, rel("rt-2", "26.05.1", "1.1.0", "0.5.1", "rt-4")); err != nil {
		t.Fatalf("custody-allowed downgrade refused: %v", err)
	}
}

// One release id family (LNK-22, contracts 4.4.0): host versions whombat-dev-YYYYMMDD.N and whombat-YYYYMMDD.N order
// by date and number, so Home moves from a development id to a later production one and never back.
func TestForwardAcrossIDFamilies(t *testing.T) {
	rel := func(host string) *Release {
		r := &Release{}
		r.Tuple.ReleaseID = host
		r.Tuple.Host.Version, r.Tuple.Runtime.Version, r.Tuple.Manager.Version = host, "1.0.0", host
		return r
	}
	dev := Versions{Host: "whombat-dev-20261118.3", Runtime: "1.0.0", Manager: "whombat-dev-20261118.3"}
	if err := CheckForward("whombat-dev-20261118.3", dev, rel("whombat-20261119.1")); err != nil {
		t.Fatalf("development to a later production id: %v", err)
	}
	if err := CheckForward("whombat-dev-20261118.3", dev, rel("whombat-20261118.2")); err == nil {
		t.Fatal("moved back to an earlier production id")
	}
	prod := Versions{Host: "whombat-20261119.1", Runtime: "1.0.0", Manager: "whombat-20261119.1"}
	if err := CheckForward("whombat-20261119.1", prod, rel("whombat-dev-20261118.9")); err == nil {
		t.Fatal("moved back to an earlier development id")
	}
	if CompareVersions("whombat-dev-20261119.2", "whombat-20261119.10") >= 0 {
		t.Fatal("same date: the number decides")
	}
}
