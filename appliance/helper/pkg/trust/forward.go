package trust

import (
	"errors"
	"fmt"
	"slices"
	"strings"

	"github.com/CybexBV/whombat/contracts/go/release"
)

// ErrDowngrade: the tuple is older than the installed one and release custody did not allow moving
// back from it (MA-21c, W4-SEC part 2 M-2). Control alone can never downgrade a device.
var ErrDowngrade = errors.New("release is older than the installed release")

// Versions are the component versions of a tuple that must never go backwards without permission.
type Versions struct {
	Host    string `json:"host"`
	Runtime string `json:"runtime"`
	Manager string `json:"manager"`
}

// VersionsOf returns a release's component versions.
func (r *Release) VersionsOf() Versions {
	return Versions{Host: r.Tuple.Host.Version, Runtime: r.Tuple.Runtime.Version, Manager: r.Tuple.Manager.Version}
}

// CheckForward refuses next if any component version is lower than the installed one (cur, release
// curID), unless next's TUF-signed allowDowngradeFrom names curID. Unknown installed versions (empty)
// are not compared.
func CheckForward(curID string, cur Versions, next *Release) error {
	nv := next.VersionsOf()
	var older []string
	for _, c := range []struct{ name, cur, next string }{
		{"host", cur.Host, nv.Host}, {"runtime", cur.Runtime, nv.Runtime}, {"manager", cur.Manager, nv.Manager},
	} {
		if c.cur != "" && c.next != "" && CompareVersions(c.next, c.cur) < 0 {
			older = append(older, fmt.Sprintf("%s %s < %s", c.name, c.next, c.cur))
		}
	}
	if len(older) == 0 || (curID != "" && slices.Contains(next.AllowDowngradeFrom, curID)) {
		return nil
	}
	return fmt.Errorf("%w: %s from %s (%s); release custody must allow it (allowDowngradeFrom)", ErrDowngrade,
		next.Tuple.ReleaseID, curID, strings.Join(older, ", "))
}

// CompareVersions orders component versions: the contracts' release.CompareVersions (CT-135, the same code this
// package had since MA-21c, now shared with control and the clients): dotted segments, numeric ones numerically and
// before alphanumeric ones, others lexically; a pre-release (after the first "-") sorts before the release; build
// metadata (after "+") is ignored. Runtime and manager versions are `<semver>-<commit time>.<rev>` (NX-105), host
// versions release ids (`whombat-YYYYMMDD.N`, and `pve-YYYYMMDD.N` before PI-23, which sort before them), so each
// orders by build. Since contracts 4.4.0 (LNK-22) `whombat-YYYYMMDD.N` and `whombat-dev-YYYYMMDD.N` order by date and
// number alone, so a box moves from a development release to a later production one and never back.
func CompareVersions(a, b string) int { return release.CompareVersions(a, b) }
