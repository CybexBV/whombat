// Package agentver orders agent versions (HS-140): the appliance's
// "0.0.0-<UTC YYYYMMDDHHMMSS>.<shortrev>" by their build time, Rackoon's
// tagged builds by semver. The agent refuses an update to an older
// version and the hub only updates agents that are older than its build.
package agentver

import (
	"regexp"
	"strconv"
	"strings"
)

// stampRe is the appliance's version: the commit's UTC time, then its
// short revision.
var stampRe = regexp.MustCompile(`^v?\d+\.\d+\.\d+-(\d{14})\.([0-9a-z]+)$`)

// semverRe is MAJOR[.MINOR[.PATCH]][-PRERELEASE][+BUILD], with an optional
// leading v (git describe's tags).
var semverRe = regexp.MustCompile(`^v?(\d{1,9})(?:\.(\d{1,9}))?(?:\.(\d{1,9}))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$`)

// Compare orders a and b: -1 when a is older, 0 when they are the same
// version, 1 when a is newer. ok is false when the order is unknown (one
// of them is neither form, or two builds of the same second differ).
func Compare(a, b string) (c int, ok bool) {
	a, b = strings.TrimSpace(a), strings.TrimSpace(b)
	if a == "" || b == "" {
		return 0, false
	}
	if a == b {
		return 0, true
	}
	sa, sb := stampRe.FindStringSubmatch(a), stampRe.FindStringSubmatch(b)
	if sa != nil && sb != nil {
		if sa[1] == sb[1] {
			return 0, false // the same second, another revision
		}
		return strings.Compare(sa[1], sb[1]), true
	}
	if sa != nil || sb != nil {
		// One build of the appliance and one tagged build: semver would put
		// every 0.0.0-… build before any tag, which says nothing.
		return 0, false
	}
	return compareSemver(a, b)
}

// Older reports a known order with a before b.
func Older(a, b string) bool {
	c, ok := Compare(a, b)
	return ok && c < 0
}

func compareSemver(a, b string) (int, bool) {
	ma, mb := semverRe.FindStringSubmatch(a), semverRe.FindStringSubmatch(b)
	if ma == nil || mb == nil {
		return 0, false
	}
	for i := 1; i <= 3; i++ {
		x, _ := strconv.Atoi(cmpOr(ma[i], "0"))
		y, _ := strconv.Atoi(cmpOr(mb[i], "0"))
		if x != y {
			return sign(x - y), true
		}
	}
	pa, pb := ma[4], mb[4]
	switch {
	case pa == pb:
		return 0, true // equal but for build metadata or a leading v
	case pa == "":
		return 1, true // a release is newer than its pre-releases
	case pb == "":
		return -1, true
	}
	fa, fb := strings.Split(pa, "."), strings.Split(pb, ".")
	for i := 0; i < len(fa) && i < len(fb); i++ {
		if c := compareIdent(fa[i], fb[i]); c != 0 {
			return c, true
		}
	}
	return sign(len(fa) - len(fb)), true
}

// compareIdent is semver's pre-release identifier order: numbers
// numerically and before words, words by their bytes.
func compareIdent(x, y string) int {
	nx, ex := strconv.Atoi(x)
	ny, ey := strconv.Atoi(y)
	switch {
	case ex == nil && ey == nil:
		return sign(nx - ny)
	case ex == nil:
		return -1
	case ey == nil:
		return 1
	}
	return strings.Compare(x, y)
}

func cmpOr(s, d string) string {
	if s == "" {
		return d
	}
	return s
}

func sign(n int) int {
	switch {
	case n < 0:
		return -1
	case n > 0:
		return 1
	}
	return 0
}
