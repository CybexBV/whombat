package trust

import (
	"encoding/json"
	"errors"
	"os"
	"regexp"
	"strconv"
	"testing"

	"github.com/CybexBV/whombat/contracts/go/release"
)

// The transition to the commit-time versions (UP-A1, UP-A2, NX-105), over every release tuple in the field
// (testdata/field-versions.json): the first release of the new scheme compares newer than all of them, component by
// component, so no box refuses it as a downgrade and no allowDowngradeFrom is needed for it.

type fieldRelease struct {
	ID      string `json:"id"`
	Source  string `json:"source"`
	Host    string `json:"host"`
	Runtime string `json:"runtime"`
	Manager string `json:"manager"`
	Fixture bool   `json:"fixture"`
}

func loadField(t *testing.T) (releases []fieldRelease, managers []string) {
	t.Helper()
	b, err := os.ReadFile("testdata/field-versions.json")
	if err != nil {
		t.Fatal(err)
	}
	var f struct {
		Releases                []fieldRelease `json:"releases"`
		ReportedManagerVersions struct {
			Versions []string `json:"versions"`
		} `json:"reportedManagerVersions"`
	}
	if err := json.Unmarshal(b, &f); err != nil {
		t.Fatal(err)
	}
	if len(f.Releases) < 10 {
		t.Fatalf("only %d recorded releases", len(f.Releases))
	}
	return f.Releases, f.ReportedManagerVersions.Versions
}

// The first versions of the new scheme: the earliest possible commit time (the ordering can't depend on it), a
// realistic one, and the patched (`.p<digest>`) and labelled (`.<label>`) forms; a release build's manager; the
// static version of every other build (VM tests, dev images; UP-X09).
var (
	newRuntimes = []string{"0.2.0-19700101000000.0000000", "0.2.0-20260928190000.abcdef1", "0.2.0-20260929080000.1a2b3c4.p26a328c",
		"0.2.0-20260929080000.1a2b3c4.r2"}
	newManagers = []string{"0.2.0-19700101000000.0000000", "0.2.0-20260929090000.5d6e7f8", "0.2.0-20260929090000.5d6e7f8-dirty", "0.2.0-0.dev",
		// 0.3.0 (UP-X14, UP-X17): managers that read closure indexes.
		"0.3.0-19700101000000.0000000", "0.3.0-20261002090000.5d6e7f8", "0.3.0-0.dev"}
)

func TestTransitionNewVersionsAreNewer(t *testing.T) {
	releases, managers := loadField(t)
	for _, r := range releases {
		if r.Fixture {
			continue // another scheme (host 26.05.1, runtime 1.0.0) in VM tests only
		}
		for _, v := range newRuntimes {
			if CompareVersions(v, r.Runtime) <= 0 {
				t.Errorf("runtime %s is not newer than %s's %s (%s)", v, r.ID, r.Runtime, r.Source)
			}
		}
		for _, v := range newManagers {
			if CompareVersions(v, r.Manager) <= 0 {
				t.Errorf("manager %s is not newer than %s's %s (%s)", v, r.ID, r.Manager, r.Source)
			}
		}
	}
	for _, m := range managers {
		for _, v := range newManagers {
			if CompareVersions(v, m) <= 0 {
				t.Errorf("manager %s is not newer than the reported %s", v, m)
			}
		}
	}
	// The same core orders by commit time, then rev; a later commit wins whatever its rev.
	for _, c := range [][2]string{
		{"0.2.0-20260928190000.aaaaaaa", "0.2.0-20260928190001.0000000"},
		{"0.2.0-20260928190000.fffffff", "0.2.0-20260929000000.0000000"},
		{"0.2.0-20260928190000.1a2b3c4", "0.2.0-20260928190000.1a2b3c4.p26a328c"},
		{"0.2.0-20260928190000.1a2b3c4", "0.2.0-20260928190000.1a2b3c4.r2"},
		// UP-X09: 0.1.0 < 0.2.0-0 (control's manager floor, UP-E6) < 0.2.0-0.dev (dev and test builds) < every release
		// build's 0.2.0-<commit time>.<rev>, the earliest included, < 0.2.0.
		{"0.1.0", "0.2.0-0"},
		{"0.2.0-0", "0.2.0-0.dev"},
		{"0.2.0-0.dev", "0.2.0-19700101000000.0000000"},
		{"0.2.0-0.dev", "0.2.0-20260929090000.5d6e7f8"},
		{"0.2.0-0.dev", "0.2.0-20260929090000.5d6e7f8-dirty"},
		{"0.2.0-20260929090000.5d6e7f8", "0.2.0"},
		{"0.2.0-20260929090000.5d6e7f8", "0.3.0-19700101000000.0000000"},
		// UP-X17: every 0.2.0 manager < 0.3.0-0 (“reads closure indexes”) < 0.3.0-0.dev < 0.3.0-<commit time>.<rev> < 0.3.0.
		{"0.2.0", "0.3.0-0"},
		{"0.2.0-20261001104304.80dde8a", "0.3.0-0"},
		{"0.2.0-0.dev", "0.3.0-0"},
		{"0.3.0-0", "0.3.0-0.dev"},
		{"0.3.0-0.dev", "0.3.0-19700101000000.0000000"},
		{"0.3.0-0.dev", "0.3.0-20261002090000.5d6e7f8"},
		{"0.3.0-20261002090000.5d6e7f8", "0.3.0"},
	} {
		if CompareVersions(c[0], c[1]) >= 0 {
			t.Errorf("%s is not older than %s", c[0], c[1])
		}
	}
}

// Why the scheme changed: under 0.1.0-<rev> about every other runtime compared older than the one before it.
func TestTransitionOldSchemeTrap(t *testing.T) {
	if CompareVersions("0.1.0-195421a", "0.1.0-e847497") >= 0 {
		t.Fatal("pve-20260928.6's runtime must compare older than pve-20260928.5's under the old scheme (the text trap)")
	}
	if CompareVersions("0.1.0-9999999", "0.1.0-843d1ba") >= 0 {
		t.Fatal("a rev of digits only is a number, which sorts before any rev with a letter")
	}
}

var hostIDRe = regexp.MustCompile(`^(pve|pve-dev)-([0-9]{8})\.([0-9]+)$`)

// Host versions are release ids (`pve-YYYYMMDD.N`, `pve-dev-YYYYMMDD.N`): CompareVersions orders them by day, then
// counter, as the ids are made (NX-67).
func TestTransitionHostIDsOrderByDayThenCounter(t *testing.T) {
	releases, _ := loadField(t)
	type id struct {
		s          string
		fam        string
		day, count int
	}
	parse := func(s string) (id, bool) {
		m := hostIDRe.FindStringSubmatch(s)
		if m == nil {
			return id{}, false
		}
		d, _ := strconv.Atoi(m[2])
		n, _ := strconv.Atoi(m[3])
		return id{s, m[1], d, n}, true
	}
	var ids []id
	seen := map[string]bool{}
	for _, s := range []string{"pve-20260928.9", "pve-20260928.10", "pve-20260929.1", "pve-20261001.2", "pve-dev-20260928.10",
		"pve-dev-20260929.1", "pve-20270101.1"} {
		i, _ := parse(s)
		ids, seen[s] = append(ids, i), true
	}
	for _, r := range releases {
		for _, s := range []string{r.ID, r.Host} {
			if i, ok := parse(s); ok && !seen[s] {
				ids, seen[s] = append(ids, i), true
			}
		}
	}
	for _, a := range ids {
		for _, b := range ids {
			if a.fam != b.fam {
				continue
			}
			want := 0
			switch {
			case a.day != b.day:
				want = map[bool]int{true: -1, false: 1}[a.day < b.day]
			case a.count != b.count:
				want = map[bool]int{true: -1, false: 1}[a.count < b.count]
			}
			if got := CompareVersions(a.s, b.s); got != want {
				t.Errorf("CompareVersions(%s, %s) = %d, want %d", a.s, b.s, got, want)
			}
		}
	}
	if len(ids) < 15 {
		t.Fatalf("only %d host ids", len(ids))
	}
}

// Every box in the field takes the first release of the new scheme through CheckForward, the check the manager and
// the helper run: a host release (new host, runtime and manager) and a runtime-only release on its host.
func TestTransitionCheckForwardAcceptsOldToNew(t *testing.T) {
	releases, _ := loadField(t)
	next := func(id, host, rt, mgr string) *Release {
		r := &Release{}
		r.Tuple = release.ReleaseTuple{ReleaseID: id}
		r.Tuple.Host.Version, r.Tuple.Runtime.Version, r.Tuple.Manager.Version = host, rt, mgr
		return r
	}
	n := 0
	for _, r := range releases {
		if r.Fixture {
			continue
		}
		cur := Versions{Host: r.Host, Runtime: r.Runtime, Manager: r.Manager}
		fam := "pve-"
		if m := hostIDRe.FindStringSubmatch(r.Host); m != nil && m[1] == "pve-dev" {
			fam = "pve-dev-"
		}
		for _, rel := range []*Release{
			next(fam+"20260929.1", fam+"20260929.1", newRuntimes[1], newManagers[1]),
			next(fam+"20260929.2", r.Host, newRuntimes[1], r.Manager), // runtime-only on the box's host
		} {
			if err := CheckForward(r.ID, cur, rel); err != nil {
				t.Errorf("%s (%s) refuses %s: %v", r.ID, r.Source, rel.Tuple.ReleaseID, err)
			}
			n++
		}
		// And back is refused without custody.
		back := next("pve-20260929.3", r.Host, r.Runtime, r.Manager)
		if err := CheckForward("pve-20260929.1", Versions{Host: r.Host, Runtime: newRuntimes[1], Manager: newManagers[1]}, back); !errors.Is(err, ErrDowngrade) {
			t.Errorf("new → %s's versions accepted: %v", r.ID, err)
		}
	}
	if n < 30 {
		t.Fatalf("only %d transitions checked", n)
	}
}

// PI-23: every box in the field, on a pve- release, takes the first whombat- release of its environment (host versions
// are release ids, and "whombat" sorts after "pve"), also as a runtime-only release on its own host; going back to a
// pve- host is a downgrade.
func TestTransitionCheckForwardAcceptsWhombatIDs(t *testing.T) {
	releases, _ := loadField(t)
	next := func(id, host, rt, mgr string) *Release {
		r := &Release{}
		r.Tuple = release.ReleaseTuple{ReleaseID: id}
		r.Tuple.Host.Version, r.Tuple.Runtime.Version, r.Tuple.Manager.Version = host, rt, mgr
		return r
	}
	n := 0
	for _, r := range releases {
		m := hostIDRe.FindStringSubmatch(r.Host)
		if r.Fixture || m == nil {
			continue
		}
		fam := "whombat-"
		if m[1] == "pve-dev" {
			fam = "whombat-dev-"
		}
		cur := Versions{Host: r.Host, Runtime: r.Runtime, Manager: r.Manager}
		// A day before the box's own: the generation decides, not the day.
		for _, rel := range []*Release{
			next(fam+"20260901.1", fam+"20260901.1", newRuntimes[1], newManagers[1]),
			next(fam+"20260901.2", r.Host, newRuntimes[1], r.Manager),
		} {
			if err := CheckForward(r.ID, cur, rel); err != nil {
				t.Errorf("%s (%s) refuses %s: %v", r.ID, r.Source, rel.Tuple.ReleaseID, err)
			}
			n++
		}
		onNew := Versions{Host: fam + "20260901.1", Runtime: newRuntimes[1], Manager: newManagers[1]}
		if err := CheckForward(fam+"20260901.1", onNew, next(fam+"20260901.3", r.Host, newRuntimes[1], newManagers[1])); !errors.Is(err, ErrDowngrade) {
			t.Errorf("%s's pve- host accepted after a whombat- one: %v", r.ID, err)
		}
	}
	if n < 20 {
		t.Fatalf("only %d transitions checked", n)
	}
}
