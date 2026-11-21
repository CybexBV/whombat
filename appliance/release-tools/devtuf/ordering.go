package devtuf

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"

	"github.com/CybexBV/whombat/appliance/helper/pkg/trust"
	"github.com/CybexBV/whombat/contracts/go/release"
	"github.com/theupdateframework/go-tuf/v2/metadata"
)

// Release ordering (MG-44, MG-50, UP-A3): a repository never signs a release that is older than what it published of
// the same id family. Devices refuse an older tuple anyway (trust.CheckForward, MA-21c), so an older release that
// got signed would strand every box it is assigned to; the signing step is the one place every release passes, dev
// and prod, so it is checked there, and `check-newer` runs the same check read-only before a build.

// ReleaseSummary is a release's id and its three component versions (and a custody-signed rollback's
// allowDowngradeFrom): what the ordering compares and what `tufrepo status` lists.
type ReleaseSummary struct {
	ID                 string   `json:"id"`
	Host               string   `json:"host"`
	Runtime            string   `json:"runtime"`
	Manager            string   `json:"manager"`
	AllowDowngradeFrom []string `json:"allowDowngradeFrom,omitempty"`
}

// SummaryOf returns a tuple's summary.
func SummaryOf(t *release.ReleaseTuple) ReleaseSummary {
	return ReleaseSummary{ID: t.ReleaseID, Host: t.Host.Version, Runtime: t.Runtime.Version, Manager: t.Manager.Version}
}

// The ordered id families (NX-67, PI-23): "prod", `whombat-YYYYMMDD.N`, and "dev", `whombat-dev-YYYYMMDD.N`. The ids
// before PI-23, `pve-YYYYMMDD.N` and `pve-dev-YYYYMMDD.N`, are each family's generation 0: published, compared and
// ordered before every generation-1 id (as devices order host versions, which are these ids: "whombat" after "pve"),
// never signed again. Other ids (the harness's `rt-…`, test fixtures) have no order and are never compared.
var idFamilies = []struct {
	name string
	gen  int
	re   *regexp.Regexp
}{
	// The community edition's own (Whombat HE-58, UP-X27): signed by its own repository only.
	{"community", 1, regexp.MustCompile(`^whombat-community-([0-9]{8})\.([1-9][0-9]{0,3})$`)},
	{"dev", 1, regexp.MustCompile(`^whombat-dev-([0-9]{8})\.([1-9][0-9]{0,3})$`)},
	{"prod", 1, regexp.MustCompile(`^whombat-([0-9]{8})\.([1-9][0-9]{0,3})$`)},
	{"dev", 0, regexp.MustCompile(`^pve-dev-([0-9]{8})\.([1-9][0-9]{0,3})$`)},
	{"prod", 0, regexp.MustCompile(`^pve-([0-9]{8})\.([1-9][0-9]{0,3})$`)},
}

// ReleaseID is a release id of an ordered family.
type ReleaseID struct {
	Family       string // "prod", "dev" or "community"; "" for an id of no ordered family
	Gen          int    // 0: pve-… (before PI-23), 1: whombat-…
	Day, Counter int    // YYYYMMDD and N
}

// ParseReleaseID returns a release id's family, generation, day and counter; Family "" for an id of no ordered family.
func ParseReleaseID(id string) ReleaseID {
	for _, f := range idFamilies {
		if m := f.re.FindStringSubmatch(id); m != nil {
			day, _ := strconv.Atoi(m[1])
			counter, _ := strconv.Atoi(m[2])
			return ReleaseID{Family: f.name, Gen: f.gen, Day: day, Counter: counter}
		}
	}
	return ReleaseID{}
}

// ReleaseFamily returns a release id's family ("prod" or "dev"), day (YYYYMMDD) and counter; family "" for an id of
// no ordered family.
func ReleaseFamily(id string) (family string, day, counter int) {
	r := ParseReleaseID(id)
	return r.Family, r.Day, r.Counter
}

// CompareChannelIDs orders whombat-YYYYMMDD.N and whombat-dev-YYYYMMDD.N ids by day, then counter, the prefix ignored
// (LNK-22: Home moves from whombat-dev-20261118.x to whombat-20261119.1); other ids as CompareReleaseIDs.
func CompareChannelIDs(a, b string) int {
	ra, rb := ParseReleaseID(a), ParseReleaseID(b)
	whombat := func(f string) bool { return f == "prod" || f == "dev" }
	if !whombat(ra.Family) || !whombat(rb.Family) {
		return CompareReleaseIDs(a, b)
	}
	if ra.Day != rb.Day {
		return cmpInt(ra.Day, rb.Day)
	}
	if ra.Counter != rb.Counter {
		return cmpInt(ra.Counter, rb.Counter)
	}
	return strings.Compare(a, b)
}

// CompareReleaseIDs orders two ids of one family by generation, day, then counter (-1, 0, 1); ids of different or no
// families compare as text.
func CompareReleaseIDs(a, b string) int {
	ra, rb := ParseReleaseID(a), ParseReleaseID(b)
	if ra.Family == "" || ra.Family != rb.Family {
		return strings.Compare(a, b)
	}
	switch {
	case ra.Gen != rb.Gen:
		return cmpInt(ra.Gen, rb.Gen)
	case ra.Day != rb.Day:
		return cmpInt(ra.Day, rb.Day)
	default:
		return cmpInt(ra.Counter, rb.Counter)
	}
}

func cmpInt(a, b int) int {
	switch {
	case a < b:
		return -1
	case a > b:
		return 1
	}
	return 0
}

// sortSummaries orders by family, then day and counter; ids of no family last, as text.
func sortSummaries(s []ReleaseSummary) {
	sort.SliceStable(s, func(i, j int) bool {
		fi, _, _ := ReleaseFamily(s[i].ID)
		fj, _, _ := ReleaseFamily(s[j].ID)
		if fi != fj {
			return fi != "" && (fj == "" || fi < fj)
		}
		return CompareReleaseIDs(s[i].ID, s[j].ID) < 0
	})
}

// releaseSummaries lists the approved releases (releases/<id>.json targets) of a targets role, ordered.
func releaseSummaries(targets map[string]*metadata.TargetFiles) ([]ReleaseSummary, error) {
	out := []ReleaseSummary{}
	for p, tf := range targets {
		id, ok := strings.CutPrefix(p, trust.ReleaseTargetPrefix)
		if !ok {
			continue
		}
		id = strings.TrimSuffix(id, ".json")
		if tf.Custom == nil {
			return nil, fmt.Errorf("%s has no custom metadata", p)
		}
		var c struct {
			Whombat struct {
				Kind  trust.Kind `json:"kind"`
				Tuple struct {
					ReleaseID string                   `json:"releaseId"`
					Host      struct{ Version string } `json:"host"`
					Runtime   struct{ Version string } `json:"runtime"`
					Manager   struct{ Version string } `json:"manager"`
				} `json:"tuple"`
				AllowDowngradeFrom []string `json:"allowDowngradeFrom"`
			} `json:"whombat"`
		}
		if err := json.Unmarshal(*tf.Custom, &c); err != nil {
			return nil, fmt.Errorf("%s: %w", p, err)
		}
		w := c.Whombat
		if w.Kind != trust.KindReleaseTuple || w.Tuple.ReleaseID != id {
			return nil, fmt.Errorf("%s is not the release tuple of %s", p, id)
		}
		out = append(out, ReleaseSummary{ID: id, Host: w.Tuple.Host.Version, Runtime: w.Tuple.Runtime.Version,
			Manager: w.Tuple.Manager.Version, AllowDowngradeFrom: w.AllowDowngradeFrom})
	}
	sortSummaries(out)
	return out, nil
}

// PublishedReleases lists the repository's approved releases with their versions (unpublished changes included).
func (r *Repo) PublishedReleases() ([]ReleaseSummary, error) {
	return releaseSummaries(r.destView())
}

// ErrNotNewer: the candidate is older than a published release of its family, or its id doesn't sort after the newest.
var ErrNotNewer = errors.New("not newer than the published releases")

// ErrReleaseID: the id isn't one this repository signs (a production repository signs whombat-YYYYMMDD.N only, a
// development one whombat-dev-YYYYMMDD.N and ids of no family, never a production id, a pve- id (PI-23) or a malformed
// whombat- id; MG-50).
var ErrReleaseID = errors.New("not a release id this repository signs")

// ErrVersionForm: a component version that can't be ordered reliably (MG-50): a "+" (everything after it is build
// metadata, so versions differing only there compare equal) or a numeric segment of more than 19 digits (beyond
// uint64 it compares as text and sorts above every commit time).
var ErrVersionForm = errors.New("a component version that can't be ordered")

// ErrPermission: an allowDowngradeFrom entry that names no published release the candidate is older than (a
// permission is only ever for releases devices can run now, never for a future id; MG-50).
var ErrPermission = errors.New("a downgrade permission for no published newer release")

// NewerOptions are CheckNewer's rules for one repository.
type NewerOptions struct {
	// Production: a production repository (PI-05), which signs whombat-YYYYMMDD.N ids only.
	Production bool
	// Community: the community edition's repository (UP-X27), which signs whombat-community-YYYYMMDD.N ids only; no
	// other repository signs them.
	Community bool
	// AllowDowngradeFrom makes the candidate a custody rollback (MA-21c).
	AllowDowngradeFrom []string
	// Channel: a channel role of the GitHub repository (LNK-22), which signs whombat-YYYYMMDD.N and
	// whombat-dev-YYYYMMDD.N ids as one family ordered by day and counter alone.
	Channel bool
}

// Highest is the highest version of one component among the published releases of the family, and the (newest)
// release that has it.
type Highest struct {
	Version string `json:"version"`
	Release string `json:"release"`
}

// Ordering is what CheckNewer compared: the candidate's family, the newest published release of it by id, the highest
// published host, runtime and manager versions of the family (Newest and Highest nil: none published, or an id of no
// family) and the component downgrades a custody rollback's allowDowngradeFrom permitted.
type Ordering struct {
	Family     string              `json:"family,omitempty"`
	Newest     *ReleaseSummary     `json:"newest,omitempty"`
	Highest    map[string]*Highest `json:"highest,omitempty"`
	Downgrades []string            `json:"downgrades,omitempty"`
}

var digitsRe = regexp.MustCompile(`^[0-9]+$`)

// CheckVersionForm refuses a version CompareVersions can't order reliably (ErrVersionForm).
func CheckVersionForm(component, v string) error {
	if strings.Contains(v, "+") {
		return fmt.Errorf("%w: the %s version %s has a “+”: what follows it is build metadata, ignored when versions are compared",
			ErrVersionForm, component, v)
	}
	for _, seg := range strings.FieldsFunc(v, func(r rune) bool { return r == '.' || r == '-' }) {
		if digitsRe.MatchString(seg) && len(seg) > 19 {
			return fmt.Errorf("%w: the %s version %s has a numeric part of %d digits (at most 19 compare as numbers)",
				ErrVersionForm, component, v, len(seg))
		}
	}
	return nil
}

func olderIn(cand, than ReleaseSummary) []string {
	var out []string
	for _, c := range []struct{ name, than, cand string }{
		{"host", than.Host, cand.Host}, {"runtime", than.Runtime, cand.Runtime}, {"manager", than.Manager, cand.Manager},
	} {
		if c.than != "" && c.cand != "" && trust.CompareVersions(c.cand, c.than) < 0 {
			out = append(out, c.name)
		}
	}
	return out
}

func versionOf(r ReleaseSummary, name string) string {
	switch name {
	case "host":
		return r.Host
	case "runtime":
		return r.Runtime
	}
	return r.Manager
}

// CheckNewer decides whether the repository may sign cand (MG-44, MG-50):
//   - the id belongs to the repository: a production repository signs whombat-YYYYMMDD.N only; a development
//     repository whombat-dev-YYYYMMDD.N, or an id of no family (fixtures, harness releases: not ordered), never a
//     production id, an id that starts with "whombat-" and isn't one, or any pve- id (generation 0, PI-23);
//   - the host, runtime and manager versions have an orderable form (CheckVersionForm);
//   - its id sorts after the newest published release of its family, and none of its versions is lower than the
//     highest version of that component among all published releases of the family, both generations
//     (trust.CompareVersions, the devices' own order);
//   - allowDowngradeFrom (a custody rollback, MA-21c) names only published releases the candidate is older than, and
//     it accepts lower versions only when it names, for every lower component, the release holding the highest one
//     (the release devices move back from). The id order is never waived: a rollback is a new, later release.
func CheckNewer(published []ReleaseSummary, cand ReleaseSummary, opt NewerOptions) (Ordering, error) {
	id := ParseReleaseID(cand.ID)
	fam := id.Family
	o := Ordering{Family: fam}
	switch {
	case strings.HasPrefix(cand.ID, "pve-"):
		return o, fmt.Errorf("%w: %s is an id from before PI-23; a new release is whombat-YYYYMMDD.N (prod) or whombat-dev-YYYYMMDD.N (dev)", ErrReleaseID, cand.ID)
	case opt.Community && fam != "community":
		return o, fmt.Errorf("%w: a community release id is whombat-community-YYYYMMDD.N (UP-X27), not %s", ErrReleaseID, cand.ID)
	case !opt.Community && fam == "community":
		return o, fmt.Errorf("%w: %s is a community release id; only the community edition's repository signs it (UP-X27)", ErrReleaseID, cand.ID)
	case opt.Channel && fam != "prod" && fam != "dev":
		return o, fmt.Errorf("%w: a channel release id is whombat-YYYYMMDD.N or whombat-dev-YYYYMMDD.N (LNK-22), not %s", ErrReleaseID, cand.ID)
	case opt.Channel:
	case opt.Production && fam != "prod":
		return o, fmt.Errorf("%w: a production release id is whombat-YYYYMMDD.N (NX-67), not %s", ErrReleaseID, cand.ID)
	case !opt.Production && fam == "prod":
		return o, fmt.Errorf("%w: %s is a production release id; a development repository signs whombat-dev-YYYYMMDD.N", ErrReleaseID, cand.ID)
	case !opt.Production && fam == "" && strings.HasPrefix(cand.ID, "whombat-"):
		return o, fmt.Errorf("%w: %s isn't whombat-dev-YYYYMMDD.N (a real date and a counter from 1, NX-67)", ErrReleaseID, cand.ID)
	}
	for _, c := range []struct{ name, v string }{{"host", cand.Host}, {"runtime", cand.Runtime}, {"manager", cand.Manager}} {
		if err := CheckVersionForm(c.name, c.v); err != nil {
			return o, err
		}
	}
	byID := map[string]ReleaseSummary{}
	for _, p := range published {
		byID[p.ID] = p
	}
	for _, id := range opt.AllowDowngradeFrom {
		p, ok := byID[id]
		switch {
		case !trust.ValidReleaseID(id) || id == cand.ID:
			return o, fmt.Errorf("%w: bad --allow-downgrade-from %q", ErrPermission, id)
		case !ok:
			return o, fmt.Errorf("%w: --allow-downgrade-from %s: no such published release (a permission names releases devices run, never a future one)",
				ErrPermission, id)
		case len(olderIn(cand, p)) == 0:
			return o, fmt.Errorf("%w: --allow-downgrade-from %s: %s is older than it in no component, so there is nothing to permit",
				ErrPermission, id, cand.ID)
		}
	}
	if fam == "" {
		return o, nil
	}
	o.Highest = map[string]*Highest{}
	sameFamily, compareIDs := func(f string) bool { return f == fam }, CompareReleaseIDs
	if opt.Channel {
		sameFamily, compareIDs = func(f string) bool { return f == "prod" || f == "dev" }, CompareChannelIDs
	}
	for i := range published {
		p := published[i]
		if f, _, _ := ReleaseFamily(p.ID); !sameFamily(f) || p.ID == cand.ID {
			continue
		}
		if o.Newest == nil || compareIDs(p.ID, o.Newest.ID) > 0 {
			o.Newest = &p
		}
		for _, name := range []string{"host", "runtime", "manager"} {
			v, h := versionOf(p, name), o.Highest[name]
			if v == "" {
				continue
			}
			// The highest version; among releases that carry it, the newest.
			if h == nil || trust.CompareVersions(v, h.Version) > 0 ||
				(trust.CompareVersions(v, h.Version) == 0 && compareIDs(p.ID, h.Release) > 0) {
				o.Highest[name] = &Highest{Version: v, Release: p.ID}
			}
		}
	}
	n := o.Newest
	if n == nil {
		o.Highest = nil
		return o, nil
	}
	if compareIDs(cand.ID, n.ID) <= 0 {
		return o, fmt.Errorf("%w: release id %s doesn't sort after %s, the newest published %s release (ids order by day, then counter, every whombat- id after every pve- id; NX-67): use a later id",
			ErrNotNewer, cand.ID, n.ID, fam)
	}
	var older, holders []string
	for _, name := range []string{"host", "runtime", "manager"} {
		h, v := o.Highest[name], versionOf(cand, name)
		if h != nil && v != "" && trust.CompareVersions(v, h.Version) < 0 {
			older = append(older, fmt.Sprintf("%s %s < %s of %s", name, v, h.Version, h.Release))
			if !slices.Contains(holders, h.Release) {
				holders = append(holders, h.Release)
			}
		}
	}
	if len(older) == 0 {
		return o, nil
	}
	if len(opt.AllowDowngradeFrom) == 0 {
		return o, fmt.Errorf("%w: refusing to sign %s: it is older than what the published %s releases carry (%s). Nothing older is signed (MG-44); a custody rollback names the releases devices move back from: --allow-downgrade-from %s",
			ErrNotNewer, cand.ID, fam, strings.Join(older, ", "), strings.Join(holders, ","))
	}
	var missing []string
	for _, h := range holders {
		if !slices.Contains(opt.AllowDowngradeFrom, h) {
			missing = append(missing, h)
		}
	}
	if len(missing) > 0 {
		return o, fmt.Errorf("%w: %s is older than what the published %s releases carry (%s); --allow-downgrade-from must name %s, the release(s) devices move back from",
			ErrNotNewer, cand.ID, fam, strings.Join(older, ", "), strings.Join(missing, ","))
	}
	o.Downgrades = older
	return o, nil
}

// ApproveRelease checks the tuple against the published releases of its family (CheckNewer, with the repository's
// mode) and approves it with allowDowngradeFrom (not yet published).
func (r *Repo) ApproveRelease(t release.ReleaseTuple, allowDowngradeFrom []string) (Ordering, error) {
	published, err := r.PublishedReleases()
	if err != nil {
		return Ordering{}, err
	}
	o, err := CheckNewer(published, SummaryOf(&t), r.newerOptions(allowDowngradeFrom))
	if err != nil {
		return o, err
	}
	return o, r.AddReleaseAllowingDowngrade(t, allowDowngradeFrom...)
}
