package devtuf_test

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/CybexBV/whombat/appliance/helper/pkg/trust"
	"github.com/CybexBV/whombat/appliance/release-tools/devtuf"
)

// The first runtime-only release after the bridge (Whombat LNK-26, LNK-50): it reuses the bridge's host, which
// gh-continue --carry listed in development from the old repository. The carried index is listed as version 2 with its
// blobs beside it, so the GitHub publisher finds every file the release needs; the carried tuples are the old bytes
// (the digests the boxes recorded), and a box on the GitHub repository resolves both the carried releases and the new
// one, every blob verifying.
func TestRuntimeOnlyReleaseAfterTheCarry(t *testing.T) {
	c := &clock{t0}
	legacyDir := filepath.Join(t.TempDir(), "dev")
	if _, err := devtuf.New(legacyDir, devtuf.Options{Env: "local", Now: c.now}); err != nil {
		t.Fatal(err)
	}
	cache := filepath.Join(t.TempDir(), "nar")
	export := func(id string, fx fixtureRelease, tmpl []byte, reuseHost bool) string {
		t.Helper()
		d := filepath.Join(t.TempDir(), id)
		if _, err := devtuf.ExportRelease(context.Background(), d, tmpl, devtuf.ExportOptions{Paths: fx.paths(t), NarCache: cache, ReuseHost: reuseHost}); err != nil {
			t.Fatal(err)
		}
		return d
	}
	before, bridge, next := "whombat-dev-20261117.1", "whombat-dev-20261117.2", "whombat-dev-20261118.1"
	f1, f2 := newFixture("26.10.1"), newFixture("26.10.2")
	dir1 := export(before, f1, f1.template(before, "26.10.1", "1.0.0"), false)
	dir2 := export(bridge, f2, f2.template(bridge, "26.10.2", "1.0.1"), false)
	for _, d := range []string{dir1, dir2} {
		r, err := devtuf.Load(legacyDir, devtuf.Options{Now: c.now})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := r.PublishRelease(d, devtuf.PublishOptions{}); err != nil {
			t.Fatal(err)
		}
	}
	legacy, err := devtuf.Load(legacyDir, devtuf.Options{Now: c.now})
	if err != nil {
		t.Fatal(err)
	}
	pinned := legacy.InitialRoot()
	base := t.TempDir()
	out := filepath.Join(base, "github")
	if _, err := devtuf.Continue(legacyDir, out, devtuf.ContinueOptions{KeysDir: filepath.Join(base, "keys"),
		OfflineKeysDir: filepath.Join(base, "offline"), Now: c.now, Carry: []string{before, bridge}}); err != nil {
		t.Fatal(err)
	}

	// The next DEV build reuses the bridge's host (release/build without --host): only its runtime index is new.
	f4 := f2
	f4.runtime = storePath("whombat-runtime-only")
	var tmpl map[string]any
	json.Unmarshal(f4.template(next, "26.10.2", "1.0.3"), &tmpl)
	gm := readManifest(t, dir2)
	tmpl["host"].(map[string]any)["narHash"] = gm.Tuple.Host.NarHash
	tmpl["manager"].(map[string]any)["narHash"] = gm.Tuple.Manager.NarHash
	tb, _ := json.Marshal(tmpl)
	dir4 := export(next, f4, tb, true)
	gh, err := devtuf.Load(out, devtuf.Options{Now: c.now})
	if err != nil {
		t.Fatal(err)
	}
	must(t, gh.InChannel(trust.ChannelDevelopment))
	res, err := gh.PublishRelease(dir4, devtuf.PublishOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Reused) != 1 || res.Reused[0] != devtuf.HostIndexTarget("26.10.2") {
		t.Fatalf("runtime-only %+v", res)
	}
	must(t, gh.InChannel(""))
	files, err := gh.ReleaseFiles(trust.ChannelDevelopment, next)
	if err != nil {
		t.Fatalf("the files the GitHub publisher uploads: %v", err)
	}
	kinds := map[string]int{}
	for _, f := range files {
		kinds[f.Kind]++
		st, err := os.Stat(f.Local)
		if err != nil || st.Size() != f.Length {
			t.Fatalf("%s/%s: %v", f.Tag, f.Name, err)
		}
	}
	// The tuple, both indexes (the carried host's among them) and every blob of host and runtime.
	if kinds["tuple"] != 1 || kinds["index"] != 2 || kinds["blob"] != 4 {
		t.Fatalf("files %v", kinds)
	}

	// gh-init uploads each carried release's files before the first metadata push: every one is here to upload.
	for _, id := range []string{before, bridge} {
		carried, err := gh.ReleaseFiles(trust.ChannelDevelopment, id)
		if err != nil {
			t.Fatalf("the files of carried %s: %v", id, err)
		}
		for _, f := range carried {
			if st, err := os.Stat(f.Local); err != nil || st.Size() != f.Length {
				t.Fatalf("carried %s: %s/%s: %v", id, f.Tag, f.Name, err)
			}
		}
	}

	// The carried tuples are the old bytes: the release digests the boxes recorded.
	for _, id := range []string{before, bridge} {
		p, _ := legacy.TargetFilePath(trust.ReleaseTarget(id))
		old, _ := os.ReadFile(p)
		must(t, gh.InChannel(trust.ChannelDevelopment))
		q, err := gh.TargetFilePath(trust.ReleaseTarget(id))
		must(t, err)
		now, _ := os.ReadFile(q)
		if string(old) != string(now) {
			t.Fatalf("%s's tuple changed in the carry", id)
		}
	}
	must(t, gh.InChannel(""))
	// The workflow signs snapshot and timestamp; then a box on the GitHub repository resolves all three, and the new
	// release's every index and blob is a file the publisher uploads, and verifies.
	snap, _ := devtuf.ReadKeyFile(filepath.Join(base, "offline", "snapshot.json"), "snapshot")
	ts, _ := devtuf.ReadKeyFile(filepath.Join(base, "offline", "timestamp.json"), "timestamp")
	if _, err := devtuf.ResignOnline(gh.MetadataDir(), snap, ts, devtuf.ResignOptions{Now: c.t}); err != nil {
		t.Fatal(err)
	}
	repo, err := trust.Refresh(trust.Config{PinnedRoot: pinned, MetadataDir: t.TempDir(), MetadataURL: "m://x",
		Fetcher: trust.DirFetcher{BaseURL: "m://x", Dir: gh.MetadataDir()}, Now: c.t, Channel: trust.ChannelDevelopment})
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{before, bridge} {
		if _, err := repo.Release(id); err != nil {
			t.Fatalf("carried %s: %v", id, err)
		}
	}
	rel, err := repo.Release(next)
	if err != nil {
		t.Fatal(err)
	}
	byName := map[string]devtuf.ReleaseFile{}
	for _, f := range files {
		byName[f.Name] = f
	}
	for _, ia := range []*trust.Artifact{rel.HostIndex, rel.RuntimeIndex} {
		f, ok := byName[filepath.Base(ia.Remote)]
		if !ok || f.Tag != next {
			t.Fatalf("index %s (%s) not among the release's files", ia.Target, ia.Remote)
		}
		b, _ := os.ReadFile(f.Local)
		ci, err := trust.ParseClosureIndex(b, *ia)
		if err != nil || ci.V != trust.IndexV2 {
			t.Fatalf("%s: %v", ia.Target, err)
		}
		for i := range ci.Paths {
			blob := ci.Blob(i)
			bf, ok := byName[filepath.Base(blob.Remote)]
			if !ok || bf.Tag != trust.BlobBucket(blob.SHA256()) || bf.SHA256 != blob.SHA256() {
				t.Fatalf("blob %s (%s) not uploaded", blob.Meta.StorePath, blob.Remote)
			}
			if err := trust.VerifyFile(bf.Local, blob); err != nil {
				t.Fatal(err)
			}
		}
	}
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}
