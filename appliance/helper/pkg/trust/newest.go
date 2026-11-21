package trust

import "strings"

// NewestRelease is the release a box of the community edition moves to (Whombat HE-58, MG-136, UP-X27): no control
// assigns one, so the box takes the newest of its own verified repository. Among the approved release tuples it is
// the greatest by host, then runtime, then manager version (CompareVersions; ties by release id) of those that resolve
// (a tuple that doesn't, an incompatible one among them, is skipped), move no component back from the installed release
// curID with versions cur (CheckForward: a custody-signed allowDowngradeFrom permits it; cur nil, an installation
// without recorded versions, compares nothing) and aren't the installed tuple itself (curDigest). Nil, nil: nothing
// newer. The manager offers what it returns and the update helper requires the same answer from its own verified view,
// so a manager can't move a box anywhere else.
func (r *Repo) NewestRelease(curID string, cur *Versions, curDigest string) (*Release, error) {
	var best *Release
	for _, id := range r.ReleaseIDs() {
		rel, err := r.Release(id)
		if err != nil || (curDigest != "" && rel.Digest == curDigest) {
			continue
		}
		if cur != nil && CheckForward(curID, *cur, rel) != nil {
			continue
		}
		if best == nil || newer(rel, best) {
			best = rel
		}
	}
	return best, nil
}

// newer orders two releases by host, runtime and manager version, then by release id (CompareVersions orders
// `whombat-community-YYYYMMDD.10` after `.9`; text decides what it calls equal).
func newer(a, b *Release) bool {
	av, bv := a.VersionsOf(), b.VersionsOf()
	for _, c := range [][2]string{{av.Host, bv.Host}, {av.Runtime, bv.Runtime}, {av.Manager, bv.Manager}} {
		if n := CompareVersions(c[0], c[1]); n != 0 {
			return n > 0
		}
	}
	if n := CompareVersions(a.Tuple.ReleaseID, b.Tuple.ReleaseID); n != 0 {
		return n > 0
	}
	return strings.Compare(a.Tuple.ReleaseID, b.Tuple.ReleaseID) > 0
}
