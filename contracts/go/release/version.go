package release

import (
	"regexp"
	"strconv"
	"strings"
)

// releaseIDPattern is one release id family (4.4; Whombat whombat-link.md): whombat-YYYYMMDD.N and
// whombat-dev-YYYYMMDD.N order by date and build number alone, the "dev-" ignored, so a box moves between the
// Production and Development channels without going back.
var releaseIDPattern = regexp.MustCompile(`^whombat-(dev-)?([0-9]{8})[.]([0-9]{1,18})$`)

// compareReleaseIDs orders a and b when both are of the one family; ok is false otherwise.
func compareReleaseIDs(a, b string) (c int, ok bool) {
	ma, mb := releaseIDPattern.FindStringSubmatch(a), releaseIDPattern.FindStringSubmatch(b)
	if ma == nil || mb == nil {
		return 0, false
	}
	if c := strings.Compare(ma[2], mb[2]); c != 0 {
		return c, true
	}
	na, _ := strconv.ParseUint(ma[3], 10, 64)
	nb, _ := strconv.ParseUint(mb[3], 10, 64)
	switch {
	case na < nb:
		return -1, true
	case na > nb:
		return 1, true
	}
	return 0, true
}

// CompareVersions orders two component versions (compareVersions in TypeScript, CT-135; the same code as the
// appliance helper's trust.CompareVersions): -1 when a is older, 0 when equal, 1 when newer. Build metadata (after
// the first "+") is ignored; the core and the pre-release split at the first "-"; each is compared by dotted
// segments, a missing segment counting as "0": two numeric segments numerically, a numeric one before an
// alphanumeric one, otherwise by bytes; a pre-release sorts before the release of the same core. Two release ids of
// the one family (whombat-YYYYMMDD.N, whombat-dev-YYYYMMDD.N) compare by date, then build number, whatever their prefix
// (4.4): equal date and number is 0.
func CompareVersions(a, b string) int {
	if c, ok := compareReleaseIDs(a, b); ok {
		return c
	}
	a, _, _ = strings.Cut(a, "+")
	b, _, _ = strings.Cut(b, "+")
	ac, apre, aHasPre := strings.Cut(a, "-")
	bc, bpre, bHasPre := strings.Cut(b, "-")
	if c := compareDotted(ac, bc); c != 0 {
		return c
	}
	switch {
	case aHasPre && !bHasPre:
		return -1
	case !aHasPre && bHasPre:
		return 1
	}
	return compareDotted(apre, bpre)
}

func compareDotted(a, b string) int {
	as, bs := strings.Split(a, "."), strings.Split(b, ".")
	for i := 0; i < max(len(as), len(bs)); i++ {
		x, y := "0", "0"
		if i < len(as) {
			x = as[i]
		}
		if i < len(bs) {
			y = bs[i]
		}
		xn, xerr := strconv.ParseUint(x, 10, 64)
		yn, yerr := strconv.ParseUint(y, 10, 64)
		switch {
		case xerr == nil && yerr == nil:
			if xn != yn {
				if xn < yn {
					return -1
				}
				return 1
			}
		case xerr == nil: // numeric sorts before alphanumeric (semver)
			return -1
		case yerr == nil:
			return 1
		default:
			if c := strings.Compare(x, y); c != 0 {
				return c
			}
		}
	}
	return 0
}
