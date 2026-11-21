package devtuf_test

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/CybexBV/whombat/appliance/helper/pkg/trust"
	"github.com/CybexBV/whombat/appliance/release-tools/devtuf"
	"github.com/klauspost/compress/zstd"
)

func (f fixtureRelease) paths(t *testing.T) *devtuf.StreamPaths {
	t.Helper()
	s := f.streams()
	sp, err := devtuf.NewStreamPaths(s[f.host], s[f.runtime])
	if err != nil {
		t.Fatal(err)
	}
	return sp
}

func readManifest(t *testing.T, dir string) devtuf.ReleaseManifest {
	t.Helper()
	var m devtuf.ReleaseManifest
	b, err := os.ReadFile(filepath.Join(dir, "release.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	return m
}

func copyDir(t *testing.T, src string, skipNar bool) string {
	t.Helper()
	dst := filepath.Join(t.TempDir(), "copy")
	filepath.Walk(src, func(p string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(src, p)
		if info.IsDir() {
			if skipNar && rel == "nar" {
				return filepath.SkipDir
			}
			return os.MkdirAll(filepath.Join(dst, rel), 0o755)
		}
		b, _ := os.ReadFile(p)
		return os.WriteFile(filepath.Join(dst, rel), b, 0o644)
	})
	return dst
}

// UP-X14: export-release writes closure listings and blobs from the NAR cache; publish-release checks them, verifies
// new blobs by decompressing them, reuses the repository's blobs and signs the indexes; a device resolves the release
// through them and every blob verifies against the index.
func TestExportPublishClosureIndexes(t *testing.T) {
	c := &clock{t0}
	repoDir := filepath.Join(t.TempDir(), "repo")
	_, err := devtuf.New(repoDir, devtuf.Options{Now: c.now})
	if err != nil {
		t.Fatal(err)
	}
	load := func() *devtuf.Repo {
		r, err := devtuf.Load(repoDir, devtuf.Options{Now: c.now})
		if err != nil {
			t.Fatal(err)
		}
		return r
	}
	cache := filepath.Join(t.TempDir(), "nar")
	f := newFixture("26.10.1")
	export := func(id string, fx fixtureRelease, tmpl []byte, reuseHost bool) (string, *devtuf.ReleaseManifest) {
		t.Helper()
		d := filepath.Join(t.TempDir(), id)
		if tmpl == nil {
			tmpl = fx.template(id, "26.10.1", "1.0.0")
		}
		m, err := devtuf.ExportRelease(context.Background(), d, tmpl, devtuf.ExportOptions{Paths: fx.paths(t), NarCache: cache, ReuseHost: reuseHost})
		if err != nil {
			t.Fatal(err)
		}
		return d, m
	}
	dir, m := export("rt-index-1", f, nil, false)
	if m.V != 2 || len(m.Indexes) != 2 || m.Tuple.Manager.NarHash == "" || m.Tuple.Host.NarHash == "" {
		t.Fatalf("manifest %+v", m)
	}
	host := m.Indexes[0]
	if host.Target != devtuf.HostIndexTarget("26.10.1") || host.File != "host.paths.json" || host.Meta.Paths != 3 ||
		host.Meta.ManagerStorePath != f.manager || host.Meta.DownloadSize <= 0 {
		t.Fatalf("host index %+v", host)
	}
	if blobs, _ := os.ReadDir(filepath.Join(dir, "nar")); len(blobs) != 4 { // lib, manager, host, runtime
		t.Fatalf("%d blobs", len(blobs))
	}
	if raw, _ := os.ReadFile(filepath.Join(dir, "release.json")); strings.Contains(string(raw), `"artifacts"`) {
		t.Fatalf("release.json with an artifacts list:\n%s", raw)
	}
	sums, _ := os.ReadFile(filepath.Join(dir, "SHA256SUMS"))
	if strings.Contains(string(sums), "nar") || !strings.Contains(string(sums), "host.paths.json") || strings.Contains(string(sums), ".closure") {
		t.Fatalf("SHA256SUMS:\n%s", sums)
	}
	res, err := load().PublishRelease(dir, devtuf.PublishOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if res.BlobsAdded != 4 || res.BlobsReused != 0 || res.BytesAdded <= 0 || len(res.Added) != 2 {
		t.Fatalf("publish %+v", res)
	}
	// A device resolves the release through its indexes; every blob verifies.
	checkDevice := func(id string) *trust.Release {
		t.Helper()
		r := load()
		repo, err := trust.Refresh(trust.Config{PinnedRoot: r.InitialRoot(), MetadataDir: t.TempDir(), MetadataURL: "m://x",
			Fetcher: trust.DirFetcher{BaseURL: "m://x", Dir: r.MetadataDir()}, Now: c.t})
		if err != nil {
			t.Fatal(err)
		}
		rel, err := repo.Release(id)
		if err != nil {
			t.Fatal(err)
		}
		if rel.HostIndex == nil || rel.RuntimeIndex == nil {
			t.Fatalf("release %s: indexes %v %v", id, rel.HostIndex, rel.RuntimeIndex)
		}
		for _, ia := range []*trust.Artifact{rel.HostIndex, rel.RuntimeIndex} {
			p, _ := r.TargetFilePath(ia.Target)
			b, _ := os.ReadFile(p)
			ci, err := trust.ParseClosureIndex(b, *ia)
			if err != nil {
				t.Fatal(err)
			}
			for i, ip := range ci.Paths {
				bp, ok := r.BlobPath(ip.NarHash)
				if !ok {
					t.Fatalf("no blob for %s", ip.StorePath)
				}
				if err := trust.VerifyFile(bp, ci.Blob(i)); err != nil {
					t.Fatal(err)
				}
				fh, _ := os.Open(bp)
				err := trust.VerifyNar(fh, ip.NarHash, ip.NarSize)
				fh.Close()
				if err != nil {
					t.Fatal(err)
				}
			}
		}
		return rel
	}
	checkDevice("rt-index-1")
	if again, err := load().PublishRelease(dir, devtuf.PublishOptions{}); err != nil || !again.AlreadyPublished {
		t.Fatalf("republish %+v %v", again, err)
	}

	// The next release shares the library: its blob is compressed once (cache) and published once (repository); the
	// upload may leave out what the repository has.
	f2 := newFixture("26.10.2")
	dir2, _ := export("rt-index-2", f2, f2.template("rt-index-2", "26.10.2", "1.0.1"), false)
	lean := copyDir(t, dir2, true)
	if _, err := load().PublishRelease(lean, devtuf.PublishOptions{}); err == nil || !strings.Contains(err.Error(), "neither in the release directory nor in the repository") {
		t.Fatalf("missing blobs: %v", err)
	}
	res, err = load().PublishRelease(dir2, devtuf.PublishOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if res.BlobsAdded != 3 || res.BlobsReused != 1 {
		t.Fatalf("dedupe %+v", res)
	}
	blobs, _ := devtuf.ListBlobs(repoDir)
	if len(blobs) != 7 {
		t.Fatalf("%d blobs in the repository", len(blobs))
	}

	// Runtime-only with --reuse-host: the host index is the published one.
	f4 := f2
	f4.runtime = storePath("whombat-runtime-only")
	var tmpl map[string]any
	json.Unmarshal(f4.template("rt-only-4", "26.10.2", "1.0.3"), &tmpl)
	gm := readManifest(t, dir2)
	tmpl["host"].(map[string]any)["narHash"] = gm.Tuple.Host.NarHash
	tmpl["manager"].(map[string]any)["narHash"] = gm.Tuple.Manager.NarHash
	tb, _ := json.Marshal(tmpl)
	dir4, m4 := export("rt-only-4", f4, tb, true)
	if len(m4.Indexes) != 1 || m4.Indexes[0].Meta.Of != trust.KindRuntimeBundle {
		t.Fatalf("runtime-only %+v", m4.Indexes)
	}
	res, err = load().PublishRelease(dir4, devtuf.PublishOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Reused) != 1 || res.Reused[0] != devtuf.HostIndexTarget("26.10.2") || res.BlobsAdded != 1 {
		t.Fatalf("runtime-only %+v", res)
	}
	checkDevice("rt-only-4")
	// Status and the ordering read past index targets and blobs.
	if st := load().Status(); len(st.Releases) != 3 || len(st.Warnings) != 0 {
		t.Fatalf("status %+v", st)
	}
	if v, err := devtuf.VerifyPublished(devtuf.DirMetadata(repoDir), nil, false, true, c.t); err != nil || len(v.Releases) != 3 {
		t.Fatalf("verify published %v", err)
	}
}

// Publishing refuses a release directory whose listings or blobs don't check out, before anything is signed.
func TestPublishRefusesBadIndexes(t *testing.T) {
	c := &clock{t0}
	var repoDir string
	fresh := func() {
		repoDir = filepath.Join(t.TempDir(), "repo")
		if _, err := devtuf.New(repoDir, devtuf.Options{Now: c.now}); err != nil {
			t.Fatal(err)
		}
	}
	load := func() *devtuf.Repo {
		r, err := devtuf.Load(repoDir, devtuf.Options{Now: c.now})
		if err != nil {
			t.Fatal(err)
		}
		return r
	}
	f := newFixture("26.10.1")
	good := filepath.Join(t.TempDir(), "good")
	m, err := devtuf.ExportRelease(context.Background(), good, f.template("rt-1", "26.10.1", "1.0.0"),
		devtuf.ExportOptions{Paths: f.paths(t), NarCache: filepath.Join(t.TempDir(), "nar")})
	if err != nil {
		t.Fatal(err)
	}
	narOf := func(sp string) string {
		s, _ := devtuf.NewStreamPaths(f.streams()[f.host], f.streams()[f.runtime])
		infos, _ := s.Closure(context.Background(), sp)
		for _, p := range infos {
			if p.StorePath == sp {
				return strings.TrimPrefix(p.NarHash, "sha256:")
			}
		}
		t.Fatalf("no %s", sp)
		return ""
	}
	editListing := func(d, file string, change func(ci *trust.ClosureIndex)) {
		b, _ := os.ReadFile(filepath.Join(d, file))
		ci, err := trust.DecodeClosureIndex(b)
		if err != nil {
			t.Fatal(err)
		}
		change(ci)
		b, _ = json.Marshal(ci)
		os.WriteFile(filepath.Join(d, file), b, 0o644)
	}
	bad := map[string]func(d string){
		"corrupted blob": func(d string) {
			enc, _ := zstd.NewWriter(nil)
			os.WriteFile(filepath.Join(d, "nar", narOf(f.runtime)+".nar.zst"), enc.EncodeAll([]byte("not the runtime"), nil), 0o644)
		},
		"blob that is not zstd": func(d string) {
			os.WriteFile(filepath.Join(d, "nar", narOf(f.lib)+".nar.zst"), []byte("garbage"), 0o644)
		},
		"missing blob": func(d string) { os.Remove(filepath.Join(d, "nar", narOf(f.manager)+".nar.zst")) },
		"wrong order": func(d string) {
			editListing(d, "runtime.paths.json", func(ci *trust.ClosureIndex) { ci.Paths[0], ci.Paths[1] = ci.Paths[1], ci.Paths[0] })
		},
		"incomplete closure": func(d string) {
			editListing(d, "runtime.paths.json", func(ci *trust.ClosureIndex) { ci.Paths = ci.Paths[1:] })
		},
		"wrong root narHash": func(d string) {
			editListing(d, "runtime.paths.json", func(ci *trust.ClosureIndex) {
				ci.Paths[len(ci.Paths)-1].NarHash = "sha256:" + strings.Repeat("0", 64)
			})
		},
		"blob fields in a listing": func(d string) {
			editListing(d, "runtime.paths.json", func(ci *trust.ClosureIndex) { ci.Paths[0].FileSize, ci.Paths[0].FileHash = 1, ci.NarHash })
		},
		"manager not in the host listing": func(d string) {
			editListing(d, "host.paths.json", func(ci *trust.ClosureIndex) {
				var keep []trust.IndexPath
				for _, p := range ci.Paths {
					if p.StorePath != f.manager {
						p.References = without(p.References, f.manager)
						keep = append(keep, p)
					}
				}
				ci.Paths = keep
			})
		},
		"unknown listing field": func(d string) {
			b, _ := os.ReadFile(filepath.Join(d, "runtime.paths.json"))
			os.WriteFile(filepath.Join(d, "runtime.paths.json"), append(bytes.TrimSuffix(bytes.TrimSpace(b), []byte("}")), []byte(`,"x":1}`)...), 0o644)
		},
	}
	for name, change := range bad {
		fresh() // blobs written before a refusal stay (content-addressed) and would be reused
		d := copyDir(t, good, false)
		change(d)
		if _, err := load().PublishRelease(d, devtuf.PublishOptions{}); err == nil {
			t.Errorf("%s: published", name)
		} else if name == "missing blob" && !strings.Contains(err.Error(), f.manager) {
			t.Errorf("missing blob not named: %v", err)
		}
		if s := load().Status(); len(s.Releases) != 0 {
			t.Fatalf("%s: releases %v", name, s.Releases)
		}
	}
	fresh()
	if _, err := load().PublishRelease(good, devtuf.PublishOptions{}); err != nil {
		t.Fatal(err)
	}
	if len(m.Indexes) != 2 {
		t.Fatalf("indexes %+v", m.Indexes)
	}
	// A store that dumps something other than what path-info says is refused at export.
	sp := f.paths(t)
	sp.SetNAR(f.runtime, []byte("tampered"))
	if _, err := devtuf.ExportRelease(context.Background(), filepath.Join(t.TempDir(), "x"), f.template("rt-2", "26.10.1", "1.0.0"),
		devtuf.ExportOptions{Paths: sp, NarCache: filepath.Join(t.TempDir(), "nar2")}); err == nil || !strings.Contains(err.Error(), "the dump is") {
		t.Fatalf("tampered dump: %v", err)
	}
	if _, err := devtuf.ExportRelease(context.Background(), filepath.Join(t.TempDir(), "y"), f.template("rt-3", "26.10.1", "1.0.0"),
		devtuf.ExportOptions{}); err == nil {
		t.Fatal("exported without a path source")
	}
}

func without(xs []string, x string) []string {
	var out []string
	for _, y := range xs {
		if y != x {
			out = append(out, y)
		}
	}
	return out
}

func TestParsePathInfoJSON(t *testing.T) {
	const hexHash = "sha256:d78456af94967d2d66ec2dabb29e10c8245d2a2111ce47ff7345ca980cf59f51"
	for _, h := range []string{"sha256-14RWr5SWfS1m7C2rsp4QyCRdKiERzkf/c0XKmAz1n1E=", "sha256:0lczyl69ijj5fgzlgkhi44m5s96822gb5ardxik2szcnjjpmd16p", hexHash} {
		got, err := devtuf.NarHashHex(h)
		if err != nil || got != hexHash {
			t.Errorf("%s -> %s %v", h, got, err)
		}
	}
	for _, h := range []string{"sha256:zz", "sha1-AAAA", "sha256-AAAA", "md5:0123"} {
		if _, err := devtuf.NarHashHex(h); err == nil {
			t.Errorf("%s accepted", h)
		}
	}
	a, b := storePath("a"), storePath("b")
	obj := `{"` + b + `":{"narHash":"sha256-14RWr5SWfS1m7C2rsp4QyCRdKiERzkf/c0XKmAz1n1E=","narSize":5,"references":["` + a + `"],"deriver":null},` +
		`"` + a + `":{"narHash":"` + hexHash + `","narSize":3,"references":[],"deriver":"` + storePath("a.drv") + `"}}`
	arr := `[{"path":"` + a + `","narHash":"sha256:0lczyl69ijj5fgzlgkhi44m5s96822gb5ardxik2szcnjjpmd16p","narSize":3,"references":[],"deriver":"` +
		storePath("a.drv") + `"},{"path":"` + b + `","narHash":"` + hexHash + `","narSize":5,"references":["` + a + `"]}]`
	for name, in := range map[string]string{"object (Nix >= 2.19)": obj, "array": arr} {
		got, err := devtuf.ParsePathInfoJSON([]byte(in))
		if err != nil || len(got) != 2 || got[0].StorePath != a || got[0].Deriver != storePath("a.drv") || got[1].Deriver != "" ||
			got[1].References[0] != a || got[0].NarHash != hexHash || got[1].NarSize != 5 {
			t.Errorf("%s: %+v %v", name, got, err)
		}
	}
	if _, err := devtuf.ParsePathInfoJSON([]byte(`{"` + a + `":null}`)); err == nil {
		t.Error("invalid path accepted")
	}
}
