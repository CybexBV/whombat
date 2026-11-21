package devtuf_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/helper/pkg/trust"
	"github.com/CybexBV/whombat/appliance/release-tools/devtuf"
)

func TestReleaseFamilies(t *testing.T) {
	for id, want := range map[string]string{
		"whombat-20260928.6": "prod", "whombat-dev-20260927.8": "dev", "whombat-20260928.10": "prod", "rt-dev-20260928.1": "",
		"rt-2026.09.26-rc.9": "", "whombat-2026092.1": "", "whombat-20260928.0": "", "whombat-20260928.12345": "", "whombat-prod-20260928.1": "",
	} {
		if got, _, _ := devtuf.ReleaseFamily(id); got != want {
			t.Errorf("%s: family %q, want %q", id, got, want)
		}
	}
	for _, c := range []struct {
		a, b string
		want int
	}{
		{"whombat-20260928.9", "whombat-20260928.10", -1}, {"whombat-20260928.6", "whombat-20260929.1", -1}, {"whombat-20260929.1", "whombat-20260928.99", 1},
		{"whombat-dev-20260927.8", "whombat-dev-20260927.8", 0},
	} {
		if got := devtuf.CompareReleaseIDs(c.a, c.b); got != c.want {
			t.Errorf("CompareReleaseIDs(%s, %s) = %d, want %d", c.a, c.b, got, c.want)
		}
	}
}

// The published releases of production and the DEV repository as of 2026-09-28 (helper/pkg/trust/testdata).
var field = []devtuf.ReleaseSummary{
	{ID: "whombat-20260927.1", Host: "whombat-20260927.1", Runtime: "0.1.0-a2abeeb.p26a328c", Manager: "0.1.0"},
	{ID: "whombat-20260928.4", Host: "whombat-20260928.4", Runtime: "0.1.0-2be6fc1", Manager: "0.1.0"},
	{ID: "whombat-20260928.5", Host: "whombat-20260928.5", Runtime: "0.1.0-e847497", Manager: "0.1.0"},
	{ID: "whombat-20260928.6", Host: "whombat-20260928.6", Runtime: "0.1.0-195421a", Manager: "0.1.0"},
	{ID: "whombat-dev-20260927.8", Host: "whombat-dev-20260927.8", Runtime: "0.1.0-843d1ba", Manager: "0.1.0"},
	{ID: "rt-2026.09.26-rc.9", Host: "0.0.0-dev", Runtime: "0.1.0", Manager: "0.0.0-dev"},
}

var prod = devtuf.NewerOptions{Production: true}

func allow(ids ...string) devtuf.NewerOptions {
	return devtuf.NewerOptions{Production: true, AllowDowngradeFrom: ids}
}

func TestCheckNewer(t *testing.T) {
	next := devtuf.ReleaseSummary{ID: "whombat-20260929.1", Host: "whombat-20260929.1", Runtime: "0.2.0-20260929080000.1a2b3c4",
		Manager: "0.2.0-20260929090000.5d6e7f8"}
	o, err := devtuf.CheckNewer(field, next, prod)
	if err != nil || o.Family != "prod" || o.Newest == nil || o.Newest.ID != "whombat-20260928.6" {
		t.Fatalf("the first release of the new scheme: %+v %v", o, err)
	}
	// The highest version of each component across the family, not the newest release's (MG-50): whombat-20260928.5's
	// runtime e847497 sorts above .6's 195421a.
	if h := o.Highest["runtime"]; h == nil || h.Version != "0.1.0-e847497" || h.Release != "whombat-20260928.5" ||
		o.Highest["host"].Release != "whombat-20260928.6" || o.Highest["manager"].Release != "whombat-20260928.6" {
		t.Fatalf("highest %+v", o.Highest)
	}
	// A runtime-only release keeps the host (and manager) of the release before it.
	rtOnly := next
	rtOnly.ID, rtOnly.Host, rtOnly.Manager = "whombat-20260929.2", "whombat-20260928.6", "0.1.0"
	if _, err := devtuf.CheckNewer(field, rtOnly, prod); err != nil {
		t.Fatalf("runtime-only: %v", err)
	}
	oldRuntime := func(rt string) devtuf.ReleaseSummary {
		return devtuf.ReleaseSummary{ID: "whombat-20260929.1", Host: "whombat-20260929.1", Runtime: rt, Manager: "0.1.0"}
	}
	refused := map[string]struct {
		c    devtuf.ReleaseSummary
		opt  devtuf.NewerOptions
		is   error
		want []string
	}{
		// 2026-09-28's trap: 0.1.0-195421a sorts before 0.1.0-e847497 as text.
		"a 0.1.0 rev below the highest": {c: oldRuntime("0.1.0-0abc123"), opt: prod, is: devtuf.ErrNotNewer,
			want: []string{"older than what the published prod releases carry (runtime 0.1.0-0abc123 < 0.1.0-e847497 of whombat-20260928.5)",
				"--allow-downgrade-from whombat-20260928.5"}},
		"above the newest release but below an earlier one": {c: oldRuntime("0.1.0-a0a0a0a"), opt: prod, is: devtuf.ErrNotNewer,
			want: []string{"runtime 0.1.0-a0a0a0a < 0.1.0-e847497 of whombat-20260928.5"}},
		"an older manager": {c: devtuf.ReleaseSummary{ID: "whombat-20260929.1", Host: "whombat-20260929.1", Runtime: next.Runtime, Manager: "0.0.9"},
			opt: prod, is: devtuf.ErrNotNewer, want: []string{"manager 0.0.9 < 0.1.0 of whombat-20260928.6"}},
		"an older host": {c: devtuf.ReleaseSummary{ID: "whombat-20260929.1", Host: "whombat-20260928.5", Runtime: next.Runtime, Manager: next.Manager},
			opt: prod, is: devtuf.ErrNotNewer, want: []string{"host whombat-20260928.5 < whombat-20260928.6 of whombat-20260928.6"}},
		"an id that doesn't sort after": {c: devtuf.ReleaseSummary{ID: "whombat-20260928.3", Host: "whombat-20260928.3", Runtime: next.Runtime,
			Manager: next.Manager}, opt: prod, is: devtuf.ErrNotNewer, want: []string{"release id whombat-20260928.3 doesn't sort after whombat-20260928.6"}},
		"a rollback that doesn't name the holder": {c: oldRuntime("0.1.0-0abc123"), opt: allow("whombat-20260928.4"), is: devtuf.ErrNotNewer,
			want: []string{"must name whombat-20260928.5"}},
		"a rollback of two components names both holders": {c: devtuf.ReleaseSummary{ID: "whombat-20260929.1", Host: "whombat-20260928.4",
			Runtime: "0.1.0-0abc123", Manager: "0.1.0"}, opt: allow("whombat-20260928.5"), is: devtuf.ErrNotNewer, want: []string{"must name whombat-20260928.6"}},
		"a rollback with an old id": {c: devtuf.ReleaseSummary{ID: "whombat-20260928.2", Host: "whombat-20260928.4", Runtime: "0.1.0-2be6fc1",
			Manager: "0.1.0"}, opt: allow("whombat-20260928.6"), is: devtuf.ErrNotNewer, want: []string{"doesn't sort after"}},
		"a bad allow id": {c: next, opt: allow("../x"), is: devtuf.ErrPermission, want: []string{"bad --allow-downgrade-from"}},
		"a permission for a future id": {c: oldRuntime("0.1.0-0abc123"), opt: allow("whombat-20260928.5", "whombat-20260930.1"), is: devtuf.ErrPermission,
			want: []string{"whombat-20260930.1: no such published release"}},
		"a permission from an older release": {c: next, opt: allow("whombat-20260927.1"), is: devtuf.ErrPermission,
			want: []string{"whombat-20260927.1: whombat-20260929.1 is older than it in no component"}},
		"a dev id in production": {c: devtuf.ReleaseSummary{ID: "whombat-dev-20260929.1", Host: "whombat-dev-20260929.1", Runtime: next.Runtime,
			Manager: next.Manager}, opt: prod, is: devtuf.ErrReleaseID, want: []string{"a production release id is whombat-YYYYMMDD.N"}},
		"a hotfix id in production": {c: devtuf.ReleaseSummary{ID: "hotfix-1", Host: "hotfix-1", Runtime: next.Runtime, Manager: next.Manager},
			opt: prod, is: devtuf.ErrReleaseID},
		"a typo in production": {c: devtuf.ReleaseSummary{ID: "whombat-2026092.1", Host: "whombat-2026092.1", Runtime: next.Runtime, Manager: next.Manager},
			opt: prod, is: devtuf.ErrReleaseID},
		"a production id in development": {c: next, opt: devtuf.NewerOptions{}, is: devtuf.ErrReleaseID,
			want: []string{"a development repository signs whombat-dev-YYYYMMDD.N"}},
		"a malformed whombat id in development": {c: devtuf.ReleaseSummary{ID: "whombat-dev-2026092.1", Host: "x", Runtime: "1", Manager: "1"},
			opt: devtuf.NewerOptions{}, is: devtuf.ErrReleaseID, want: []string{"isn't whombat-dev-YYYYMMDD.N"}},
		"a + in the runtime": {c: devtuf.ReleaseSummary{ID: "whombat-20260929.1", Host: "whombat-20260929.1", Runtime: "0.2.0+20260929080000.1a2b3c4",
			Manager: next.Manager}, opt: prod, is: devtuf.ErrVersionForm, want: []string{"build metadata"}},
		"a 20-digit segment in the manager": {c: devtuf.ReleaseSummary{ID: "whombat-20260929.1", Host: "whombat-20260929.1", Runtime: next.Runtime,
			Manager: "0.2.0-99999999999999999999.5d6e7f8"}, opt: prod, is: devtuf.ErrVersionForm, want: []string{"20 digits"}},
	}
	for name, c := range refused {
		_, err := devtuf.CheckNewer(field, c.c, c.opt)
		if err == nil || !errors.Is(err, c.is) {
			t.Errorf("%s: %v, want %v", name, err, c.is)
			continue
		}
		for _, w := range c.want {
			if !strings.Contains(err.Error(), w) {
				t.Errorf("%s: %v, want %q", name, err, w)
			}
		}
	}
	// 19 digits still compare as a number.
	if _, err := devtuf.CheckNewer(field, devtuf.ReleaseSummary{ID: "whombat-20260929.1", Host: "whombat-20260929.1", Runtime: next.Runtime,
		Manager: "0.2.0-9999999999999999999.5d6e7f8"}, prod); err != nil {
		t.Fatalf("19 digits: %v", err)
	}
	// A custody rollback that names the releases holding what it undercuts is signed; its downgrades are reported.
	o, err = devtuf.CheckNewer(field, oldRuntime("0.1.0-0abc123"), allow("whombat-20260928.5", "whombat-20260928.4"))
	if err != nil || len(o.Downgrades) != 1 || o.Downgrades[0] != "runtime 0.1.0-0abc123 < 0.1.0-e847497 of whombat-20260928.5" {
		t.Fatalf("custody rollback: %+v %v", o, err)
	}
	two := devtuf.ReleaseSummary{ID: "whombat-20260929.1", Host: "whombat-20260928.4", Runtime: "0.1.0-0abc123", Manager: "0.1.0"}
	if o, err := devtuf.CheckNewer(field, two, allow("whombat-20260928.5", "whombat-20260928.6")); err != nil || len(o.Downgrades) != 2 {
		t.Fatalf("two components: %+v %v", o, err)
	}
	// Development: the dev family, compared within itself; ids of no family aren't compared.
	dev := devtuf.ReleaseSummary{ID: "whombat-dev-20260928.1", Host: "whombat-dev-20260928.1", Runtime: next.Runtime, Manager: next.Manager}
	if o, err := devtuf.CheckNewer(field, dev, devtuf.NewerOptions{}); err != nil || o.Newest.ID != "whombat-dev-20260927.8" {
		t.Fatalf("dev family: %+v %v", o, err)
	}
	// The other trap of the old scheme: a rev of digits only is a number, and numbers sort before letters.
	dev.Runtime, dev.Manager = "0.1.0-9999999", "0.1.0"
	if _, err := devtuf.CheckNewer(field, dev, devtuf.NewerOptions{}); err == nil || !strings.Contains(err.Error(), "runtime 0.1.0-9999999 < 0.1.0-843d1ba") {
		t.Fatalf("a numeric rev: %v", err)
	}
	for _, id := range []string{"rt-dev-20260928.1", "rt-2026.09.26-rc.8"} {
		if o, err := devtuf.CheckNewer(field, devtuf.ReleaseSummary{ID: id, Host: "0.0.0", Runtime: "0.0.1", Manager: "0.0.0"}, devtuf.NewerOptions{}); err != nil || o.Family != "" {
			t.Fatalf("%s: %+v %v", id, o, err)
		}
	}
	// The first release of a family has nothing to compare with.
	if o, err := devtuf.CheckNewer(nil, next, prod); err != nil || o.Newest != nil || o.Highest != nil {
		t.Fatalf("empty repository: %+v %v", o, err)
	}
}

// PI-23: the ids before it (pve-…) stay in their family as generation 0. Every whombat- id sorts after them, as the
// devices compare host versions; their versions still bound the first whombat- release; no pve- id is signed again.
func TestCheckNewerAcrossGenerations(t *testing.T) {
	pveField := []devtuf.ReleaseSummary{
		{ID: "pve-20261002.5", Host: "pve-20261002.5", Runtime: "0.112.0-20261002100000.aaaaaaa", Manager: "0.3.0-20261002090000.bbbbbbb"},
		{ID: "pve-dev-20261020.7", Host: "pve-dev-20261020.7", Runtime: "0.112.2-20261020120000.ccccccc", Manager: "0.3.0-20261020110000.ddddddd"},
	}
	for _, c := range []struct {
		a, b string
		want int
	}{
		{"whombat-20261001.1", "pve-20261002.5", 1}, {"whombat-dev-20261020.1", "pve-dev-20261021.9", 1},
		{"pve-dev-20261020.7", "whombat-dev-20261020.1", -1}, {"whombat-dev-20261020.10", "whombat-dev-20261020.9", 1},
	} {
		if got := devtuf.CompareReleaseIDs(c.a, c.b); got != c.want {
			t.Errorf("CompareReleaseIDs(%s, %s) = %d, want %d", c.a, c.b, got, c.want)
		}
		// The devices' order of host versions (which are these ids) agrees.
		if got := trust.CompareVersions(c.a, c.b); got != c.want {
			t.Errorf("CompareVersions(%s, %s) = %d, want %d", c.a, c.b, got, c.want)
		}
	}
	if r := devtuf.ParseReleaseID("pve-dev-20261020.7"); r.Family != "dev" || r.Gen != 0 || r.Day != 20261020 || r.Counter != 7 {
		t.Fatalf("pve-dev id: %+v", r)
	}
	dev := devtuf.ReleaseSummary{ID: "whombat-dev-20261020.1", Host: "whombat-dev-20261020.1", Runtime: "0.113.0-20261020150000.eeeeeee",
		Manager: "0.3.0-20261020140000.fffffff"}
	o, err := devtuf.CheckNewer(pveField, dev, devtuf.NewerOptions{})
	if err != nil || o.Family != "dev" || o.Newest == nil || o.Newest.ID != "pve-dev-20261020.7" {
		t.Fatalf("first whombat-dev release: %+v %v", o, err)
	}
	// The pve- releases' versions still bound it.
	old := dev
	old.Runtime = "0.112.1-20261019120000.1111111"
	if _, err := devtuf.CheckNewer(pveField, old, devtuf.NewerOptions{}); !errors.Is(err, devtuf.ErrNotNewer) ||
		!strings.Contains(err.Error(), "of pve-dev-20261020.7") {
		t.Fatalf("an older runtime than a pve-dev release's: %v", err)
	}
	p := devtuf.ReleaseSummary{ID: "whombat-20261020.1", Host: "whombat-20261020.1", Runtime: dev.Runtime, Manager: dev.Manager}
	if o, err := devtuf.CheckNewer(pveField, p, prod); err != nil || o.Newest == nil || o.Newest.ID != "pve-20261002.5" {
		t.Fatalf("first whombat release: %+v %v", o, err)
	}
	for _, c := range []struct {
		id  string
		opt devtuf.NewerOptions
	}{{"pve-dev-20261021.1", devtuf.NewerOptions{}}, {"pve-20261021.1", prod}} {
		cand := devtuf.ReleaseSummary{ID: c.id, Host: c.id, Runtime: dev.Runtime, Manager: dev.Manager}
		if _, err := devtuf.CheckNewer(pveField, cand, c.opt); !errors.Is(err, devtuf.ErrReleaseID) || !strings.Contains(err.Error(), "PI-23") {
			t.Fatalf("%s signed again: %v", c.id, err)
		}
	}
	// Once published, a whombat- release is the newest of its family.
	both := append([]devtuf.ReleaseSummary{dev}, pveField...)
	next := dev
	next.ID, next.Host = "whombat-dev-20261020.2", "whombat-dev-20261020.2"
	if o, err := devtuf.CheckNewer(both, next, devtuf.NewerOptions{}); err != nil || o.Newest == nil || o.Newest.ID != dev.ID {
		t.Fatalf("after the first: %+v %v", o, err)
	}
}

// publish-release in a production repository: an older release is refused before anything changes; a custody
// rollback is signed with allowDowngradeFrom, which devices read; its permission can't change under the same id.
func TestPublishReleaseOrdering(t *testing.T) {
	c := &clock{t0}
	repo, keys := dirs(t)
	if _, err := devtuf.New(repo, prodOpts(keys, c)); err != nil {
		t.Fatal(err)
	}
	load := func() *devtuf.Repo {
		r, err := devtuf.Load(repo, prodOpts(keys, c))
		if err != nil {
			t.Fatal(err)
		}
		return r
	}
	export := func(id, host, rt, mgr string) string {
		t.Helper()
		f := newFixture(id)
		var tmpl map[string]any
		json.Unmarshal(f.template(id, host, rt), &tmpl)
		tmpl["manager"].(map[string]any)["version"] = mgr
		b, _ := json.Marshal(tmpl)
		d := filepath.Join(t.TempDir(), id)
		if _, err := devtuf.ExportRelease(context.Background(), d, b, f.opts(t, devtuf.ExportOptions{})); err != nil {
			t.Fatal(err)
		}
		return d
	}
	publish := func(d string, allow ...string) (*devtuf.PublishResult, error) {
		return load().PublishRelease(d, devtuf.PublishOptions{AllowDowngradeFrom: allow})
	}
	if _, err := publish(export("whombat-20260928.5", "whombat-20260928.5", "0.1.0-e847497", "0.1.0")); err != nil {
		t.Fatal(err)
	}
	res, err := publish(export("whombat-20260929.1", "whombat-20260929.1", "0.2.0-20260929080000.1a2b3c4", "0.2.0-20260929090000.5d6e7f8"))
	if err != nil || res.Ordering.Newest == nil || res.Ordering.Newest.ID != "whombat-20260928.5" {
		t.Fatalf("newer release: %+v %v", res, err)
	}
	before := load().Status()
	// 2026-09-28's whombat-20260928.6 after .5: its runtime rev sorts before e847497, and the id is older now too.
	old := export("whombat-20260929.2", "whombat-20260929.2", "0.1.0-195421a", "0.1.0")
	if _, err := publish(old); !errors.Is(err, devtuf.ErrNotNewer) || !strings.Contains(err.Error(), "older than what the published prod releases carry (runtime 0.1.0-195421a < 0.2.0-20260929080000.1a2b3c4 of whombat-20260929.1, manager 0.1.0 < 0.2.0-20260929090000.5d6e7f8 of whombat-20260929.1)") {
		t.Fatalf("older: %v", err)
	}
	after := load().Status()
	if after.Roles["targets"].Version != before.Roles["targets"].Version || len(after.Releases) != 2 {
		t.Fatalf("a refused release changed the repository: %+v", after)
	}
	filepath.Walk(filepath.Join(repo, "targets"), func(p string, info os.FileInfo, err error) error {
		if err == nil && (strings.HasPrefix(info.Name(), ".incoming-") || strings.Contains(p, "whombat-20260929.2")) {
			t.Errorf("left behind: %s", p)
		}
		return nil
	})
	// The same release as a custody rollback from whombat-20260929.1.
	res, err = publish(old, "whombat-20260929.1")
	if err != nil || len(res.Ordering.Downgrades) != 2 || strings.Join(res.AllowDowngradeFrom, ",") != "whombat-20260929.1" {
		t.Fatalf("custody rollback: %+v %v", res, err)
	}
	if res, err := publish(old, "whombat-20260929.1"); err != nil || !res.AlreadyPublished {
		t.Fatalf("republished rollback: %+v %v", res, err)
	}
	if _, err := publish(old); err == nil || !strings.Contains(err.Error(), "published with allowDowngradeFrom [whombat-20260929.1]") {
		t.Fatalf("permission changed under the same id: %v", err)
	}
	// The status lists every release with its versions, in order; a device reads the permission.
	st := load().Status()
	var ids []string
	for _, r := range st.Releases {
		ids = append(ids, r.ID+" "+r.Runtime)
	}
	if strings.Join(ids, "; ") != "whombat-20260928.5 0.1.0-e847497; whombat-20260929.1 0.2.0-20260929080000.1a2b3c4; whombat-20260929.2 0.1.0-195421a" ||
		strings.Join(st.Releases[2].AllowDowngradeFrom, ",") != "whombat-20260929.1" || st.Releases[1].Manager != "0.2.0-20260929090000.5d6e7f8" {
		t.Fatalf("status releases %+v", st.Releases)
	}
	pinned, err := devtuf.VerifiedRoot(repo, true)
	if err != nil {
		t.Fatal(err)
	}
	v, err := trust.Refresh(trust.Config{PinnedRoot: pinned, MetadataDir: t.TempDir(), MetadataURL: "fx://m", Production: true,
		Fetcher: trust.DirFetcher{BaseURL: "fx://m", Dir: filepath.Join(repo, "metadata")}, Now: c.t})
	if err != nil {
		t.Fatal(err)
	}
	rel, err := v.Release("whombat-20260929.2")
	if err != nil {
		t.Fatal(err)
	}
	cur := trust.Versions{Host: "whombat-20260929.1", Runtime: "0.2.0-20260929080000.1a2b3c4", Manager: "0.2.0-20260929090000.5d6e7f8"}
	if err := trust.CheckForward("whombat-20260929.1", cur, rel); err != nil {
		t.Fatalf("a device on whombat-20260929.1 refuses the custody rollback: %v", err)
	}
	if err := trust.CheckForward("whombat-20260929.9", cur, rel); !errors.Is(err, trust.ErrDowngrade) {
		t.Fatalf("a device on another release takes it: %v", err)
	}
}

// VerifyPublished reads a repository without its keys: the chain from its own first root or a given one, expired
// roles as warnings, a forged role refused.
func TestVerifyPublished(t *testing.T) {
	c := &clock{t0}
	dir := filepath.Join(t.TempDir(), "repo")
	r, err := devtuf.New(dir, devtuf.Options{Now: c.now})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := r.AddFakeRelease(devtuf.StandardRelease("whombat-dev-20260928.1", "whombat-dev-20260928.1", "0.1.0-195421a")); err != nil {
		t.Fatal(err)
	}
	if err := r.Publish(); err != nil {
		t.Fatal(err)
	}
	first := r.InitialRoot()
	if err := r.RotateKeys("root", "targets", "snapshot", "timestamp"); err != nil {
		t.Fatal(err)
	}
	v, err := devtuf.VerifyPublished(devtuf.DirMetadata(dir), nil, false, false, c.t)
	if err != nil {
		t.Fatal(err)
	}
	if v.Versions["root"] != 2 || len(v.Releases) != 1 || v.Releases[0].Runtime != "0.1.0-195421a" || len(v.NotVerified) != 1 ||
		!strings.Contains(v.Verified[0], "the repository's own 1.root.json (v1) through 1 rotation(s)") {
		t.Fatalf("view %+v", v)
	}
	v, err = devtuf.VerifyPublished(devtuf.DirMetadata(dir), first, false, false, c.t.Add(400*24*time.Hour))
	if err != nil || len(v.NotVerified) != 0 || len(v.Warnings) != 4 {
		t.Fatalf("pinned, expired: %+v %v", v, err)
	}
	// A published repository must be fresh (MG-50): an expired timestamp alone fails.
	if _, err := devtuf.VerifyPublished(devtuf.DirMetadata(dir), first, false, true, c.t.Add(2*24*time.Hour)); !errors.Is(err, trust.ErrExpired) ||
		!strings.Contains(err.Error(), "timestamp expired") {
		t.Fatalf("expired timestamp, fresh required: %v", err)
	}
	if _, err := devtuf.VerifyPublished(devtuf.DirMetadata(dir), first, false, true, c.t); err != nil {
		t.Fatalf("fresh: %v", err)
	}
	// The committed fixtures (their keys are in this repository): verified, and refused as production.
	fx := filepath.Join("..", "fixtures", "dev", "valid")
	if v, err := devtuf.VerifyPublished(devtuf.DirMetadata(fx), nil, false, false, c.t); err != nil || len(v.Releases) != 1 || v.Releases[0].ID != "rt-fixture-1" {
		t.Fatalf("fixtures: %+v %v", v, err)
	}
	if _, err := devtuf.VerifyPublished(devtuf.DirMetadata(fx), nil, true, false, c.t); !errors.Is(err, trust.ErrDevelopmentRoot) {
		t.Fatalf("a development root as production: %v", err)
	}
	// A root that isn't the repository's: nothing verifies.
	other, _ := devtuf.New(filepath.Join(t.TempDir(), "other"), devtuf.Options{Now: c.now})
	if _, err := devtuf.VerifyPublished(devtuf.DirMetadata(dir), other.InitialRoot(), false, false, c.t); err == nil {
		t.Fatal("verified against a foreign root")
	}
	// A release edited into the signed targets after signing.
	p := filepath.Join(dir, "metadata", fmt.Sprintf("%d.targets.json", r.Versions()["targets"]))
	b, _ := os.ReadFile(p)
	os.WriteFile(p, []byte(strings.Replace(string(b), "0.1.0-195421a", "0.9.0-195421a", -1)), 0o644)
	if _, err := devtuf.VerifyPublished(devtuf.DirMetadata(dir), nil, false, false, c.t); err == nil {
		t.Fatal("verified an edited targets file")
	}
}
