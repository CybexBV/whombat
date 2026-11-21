package devtuf_test

import (
	"crypto"
	"crypto/ed25519"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/helper/pkg/trust"
	"github.com/CybexBV/whombat/appliance/release-tools/devtuf"
	"github.com/sigstore/sigstore/pkg/signature"
	"github.com/theupdateframework/go-tuf/v2/metadata"
)

func signerOf(t *testing.T, k ed25519.PrivateKey) signature.Signer {
	t.Helper()
	s, err := signature.LoadSigner(k, crypto.Hash(0))
	if err != nil {
		t.Fatal(err)
	}
	return s
}

// ghLike is the GitHub repository as it was made (LNK-26): continued from a DEV-like repository, root and targets
// keys online with the publisher, production, snapshot and timestamp in the offline folder, a release in development.
type ghLike struct {
	dir, keys, offline, meta string
	pinned                   []byte // DEV's first root, what a DEV box was installed with
	interim                  []byte // the GitHub repository's root before the ceremony (one online key)
	snap, ts                 ed25519.PrivateKey
}

func newGHLike(t *testing.T, now func() time.Time) *ghLike {
	t.Helper()
	src := devLike(t, now)
	base := t.TempDir()
	g := &ghLike{dir: filepath.Join(base, "whombat-releases"), keys: filepath.Join(base, "keys"),
		offline: filepath.Join(base, "offline"), pinned: src.InitialRoot()}
	if _, err := devtuf.Continue(src.Dir, g.dir, devtuf.ContinueOptions{KeysDir: g.keys, OfflineKeysDir: g.offline,
		VersionGap: 1000, Now: now}); err != nil {
		t.Fatal(err)
	}
	g.meta = filepath.Join(g.dir, "metadata")
	r, err := devtuf.Load(g.dir, devtuf.Options{Now: now})
	if err != nil {
		t.Fatal(err)
	}
	r.InChannel(trust.ChannelDevelopment)
	if _, err := r.AddFakeRelease(devtuf.StandardRelease("whombat-dev-20261119.9", "26.05.1", "2.0.0")); err != nil {
		t.Fatal(err)
	}
	if err := r.Publish(); err != nil {
		t.Fatal(err)
	}
	g.interim = r.RootBytes()
	g.snap, _ = devtuf.ReadKeyFile(filepath.Join(g.offline, "snapshot.json"), "snapshot")
	g.ts, _ = devtuf.ReadKeyFile(filepath.Join(g.offline, "timestamp.json"), "timestamp")
	g.resign(t, now())
	return g
}

// resign is the workflow's step (gh-resign).
func (g *ghLike) resign(t *testing.T, now time.Time) *devtuf.ResignResult {
	t.Helper()
	rr, err := devtuf.ResignOnline(g.meta, g.snap, g.ts, devtuf.ResignOptions{Now: now})
	if err != nil {
		t.Fatal(err)
	}
	return rr
}

func (g *ghLike) box(t *testing.T, pinned []byte, cache string, production bool, now time.Time) (*trust.Repo, error) {
	t.Helper()
	return trust.Refresh(trust.Config{PinnedRoot: pinned, MetadataDir: cache, MetadataURL: "m://x",
		Fetcher: trust.DirFetcher{BaseURL: "m://x", Dir: g.meta}, Now: now, Channel: trust.ChannelDevelopment,
		Production: production})
}

func names(t *testing.T, dir string) []string {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	var out []string
	for _, e := range entries {
		out = append(out, e.Name())
	}
	sort.Strings(out)
	return out
}

// The key ceremony (ONE-05): a new root of three offline keys, two needed, signed by the old root key, and a new
// top-level targets key. Boxes on the old root walk to it, from DEV's first root or the GitHub repository's, with their
// caches; their channel still resolves once the workflow signed snapshot and timestamp; the keys are where ONE-05 says;
// a production box that pins the new root refuses a later root one key could replace.
func TestKeyCeremony(t *testing.T) {
	now := time.Date(2026, 11, 20, 10, 0, 0, 0, time.UTC)
	clock := func() time.Time { return now }
	g := newGHLike(t, clock)
	homeCache, newCache := filepath.Join(t.TempDir(), "home"), filepath.Join(t.TempDir(), "new")
	if repo, err := g.box(t, g.pinned, homeCache, false, now); err != nil || len(repo.ReleaseIDs()) != 1 {
		t.Fatalf("Home before the ceremony: %v", err)
	}
	if _, err := g.box(t, g.interim, newCache, true, now); err != nil {
		t.Fatalf("a production box on the interim root before the ceremony: %v", err)
	}
	plan, err := devtuf.PlanRotation(g.meta)
	if err != nil || plan.Done || plan.RootThreshold != 1 || len(plan.Production) != 1 {
		t.Fatalf("plan %+v %v", plan, err)
	}

	r, err := devtuf.Load(g.dir, devtuf.Options{Now: clock})
	if err != nil {
		t.Fatal(err)
	}
	prod, err := devtuf.ReadKeyFile(filepath.Join(g.offline, "production.json"), trust.ChannelProduction)
	if err != nil {
		t.Fatal(err)
	}
	out := filepath.Join(t.TempDir(), "ceremony")
	res, err := r.RotateTopLevel(devtuf.RotateOptions{OfflineDir: out, ProductionKey: prod})
	if err != nil {
		t.Fatal(err)
	}
	if res.RootTo != res.RootFrom+1 || res.RootThreshold != 2 || len(res.RootKeys) != 3 || res.TargetsTo != res.TargetsFrom+1 ||
		len(res.Metadata) != 3 {
		t.Fatalf("result %+v", res)
	}
	// Offline: the three root keys, the targets key, the production copy and the note; online: no root or targets.
	if got := names(t, out); len(got) != 6 || got[0] != "README.txt" || got[1] != "production-0.json" {
		t.Fatalf("offline folder %v", got)
	}
	if st, _ := os.Stat(out); st.Mode().Perm() != 0o700 {
		t.Fatalf("offline folder mode %v", st.Mode().Perm())
	}
	for _, n := range names(t, out) {
		if st, _ := os.Stat(filepath.Join(out, n)); st.Mode().Perm() != 0o600 {
			t.Fatalf("%s mode %v", n, st.Mode().Perm())
		}
	}
	// The old root and targets keys stay online until the push (R1 #4); FinishRotation retires them.
	if got := names(t, g.keys); len(got) != 5 || got[3] != "root-0.json" || got[4] != "targets-0.json" || !r.RotationPending() {
		t.Fatalf("online keys before the push %v", got)
	}
	if done, err := r.FinishRotation(); err != nil || !done || r.RotationPending() {
		t.Fatalf("finish: %v %v", done, err)
	}
	if got := names(t, g.keys); len(got) != 3 || got[0] != "clients-0.json" || got[1] != "development-0.json" ||
		got[2] != "production-0.json" {
		t.Fatalf("online keys %v", got)
	}
	if res.OnlineRoles[0] != "clients" || len(res.OnlineRoles) != 3 {
		t.Fatalf("online roles %v", res.OnlineRoles)
	}

	// The workflow signs snapshot and timestamp over the new targets; then every box walks to the new root.
	rr := g.resign(t, now)
	if rr.RootVersion != res.RootTo || rr.Roles[metadata.TARGETS] != res.TargetsTo || len(rr.Skipped) != 0 {
		t.Fatalf("resign %+v", rr)
	}
	for _, b := range []struct {
		name       string
		pinned     []byte
		cache      string
		production bool
	}{{"Home (DEV's first root, its cache)", g.pinned, homeCache, false},
		{"a production box on the interim root, its cache", g.interim, newCache, true},
		{"a new box on the interim root", g.interim, filepath.Join(t.TempDir(), "fresh"), true}} {
		repo, err := g.box(t, b.pinned, b.cache, b.production, now)
		if err != nil || repo.RootVersion != res.RootTo || len(repo.ReleaseIDs()) != 1 {
			t.Fatalf("%s: %v %+v", b.name, err, repo)
		}
	}
	newRoot, err := os.ReadFile(filepath.Join(g.meta, "root.json"))
	if err != nil {
		t.Fatal(err)
	}
	pinnedNew := filepath.Join(t.TempDir(), "pinned-new")
	if repo, err := g.box(t, newRoot, pinnedNew, true, now); err != nil || repo.RootVersion != res.RootTo {
		t.Fatalf("a box that pins the ceremony's root: %v", err)
	}
	if p, _ := devtuf.PlanRotation(g.meta); !p.Done || p.RootThreshold != 2 {
		t.Fatalf("plan after %+v", p)
	}

	// The publisher still publishes into development and promotes with its own production key.
	again, err := devtuf.Load(g.dir, devtuf.Options{Now: clock})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := again.Promote("whombat-dev-20261119.9", trust.ChannelDevelopment, trust.ChannelProduction, nil); err != nil {
		t.Fatalf("promote with the online production key: %v", err)
	}
	g.resign(t, now)
	if _, err := g.box(t, newRoot, pinnedNew, true, now); err != nil {
		t.Fatalf("after the promotion: %v", err)
	}

	// Two of the offline keys can sign a root that needs only one: a box that pins the ceremony's root refuses it (and
	// keeps refusing), one that pins the interim root still takes it (the rule comes with the image).
	next, err := metadata.Root().FromBytes(newRoot)
	if err != nil {
		t.Fatal(err)
	}
	next.Signed.Version++
	next.Signed.Roles[metadata.ROOT].Threshold = 1
	next.ClearSignatures()
	for _, f := range []string{"root-0.json", "root-1.json"} {
		k, err := devtuf.ReadKeyFile(filepath.Join(out, f), metadata.ROOT)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := next.Sign(signerOf(t, k)); err != nil {
			t.Fatal(err)
		}
	}
	if err := next.ToFile(filepath.Join(g.meta, "5.root.json"), true); err != nil {
		t.Fatal(err)
	}
	if next.Signed.Version != 5 {
		t.Fatalf("the test's root is version %d, not 5", next.Signed.Version)
	}
	g.resign(t, now)
	for i := 0; i < 2; i++ {
		if _, err := g.box(t, newRoot, pinnedNew, true, now); !errors.Is(err, trust.ErrSingleKeyRoot) {
			t.Fatalf("a root of one key after the ceremony (refresh %d): %v", i, err)
		}
		// The refused root is never written (R1 #3): the cache keeps root 4 at most.
		if v := cachedRootVersion(t, pinnedNew); v > 4 {
			t.Fatalf("the refused root %d is in the cache", v)
		}
	}
	if _, err := g.box(t, g.interim, filepath.Join(t.TempDir(), "old-image"), true, now); err != nil {
		t.Fatalf("an image that pins the interim root: %v", err)
	}
	// A cache a helper before the fix wrote, with the refused root in it, is not trusted again.
	bad, err := os.ReadFile(filepath.Join(g.meta, "5.root.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(pinnedNew, "root.json"), bad, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := g.box(t, newRoot, pinnedNew, true, now); !errors.Is(err, trust.ErrSingleKeyRoot) {
		t.Fatalf("with the refused root cached: %v", err)
	}
	if v := cachedRootVersion(t, pinnedNew); v > 4 {
		t.Fatalf("the refused root %d stayed in the cache", v)
	}
	// The publisher corrects root 5 (two of root 4's keys sign it, and it needs two): the box that refused takes it.
	next.Signed.Roles[metadata.ROOT].Threshold = 2
	next.ClearSignatures()
	for _, f := range []string{"root-0.json", "root-1.json"} {
		k, err := devtuf.ReadKeyFile(filepath.Join(out, f), metadata.ROOT)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := next.Sign(signerOf(t, k)); err != nil {
			t.Fatal(err)
		}
	}
	if err := next.ToFile(filepath.Join(g.meta, "5.root.json"), true); err != nil {
		t.Fatal(err)
	}
	g.resign(t, now)
	if repo, err := g.box(t, newRoot, pinnedNew, true, now); err != nil || repo.RootVersion != 5 {
		t.Fatalf("the corrected root 5: %v %+v", err, repo)
	}
	if v := cachedRootVersion(t, pinnedNew); v != 5 {
		t.Fatalf("the cache holds root %d, not the corrected 5", v)
	}
}

// cachedRootVersion is the version of the root a box's cache keeps (0 without one).
func cachedRootVersion(t *testing.T, cache string) int64 {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(cache, "root.json"))
	if os.IsNotExist(err) {
		return 0
	}
	if err != nil {
		t.Fatal(err)
	}
	r, err := metadata.Root().FromBytes(b)
	if err != nil {
		t.Fatal(err)
	}
	return r.Signed.Version
}

// A ceremony that stopped while signing (R1 #4) carries on with the same keys, root and targets together: after its
// root, after its targets, and run again once more; the old keys stay online until FinishRotation, and a second
// ceremony is refused after it.
func TestKeyCeremonyResumes(t *testing.T) {
	now := time.Date(2026, 11, 20, 10, 0, 0, 0, time.UTC)
	clock := func() time.Time { return now }
	for _, stop := range []string{"root", "targets"} {
		t.Run(stop, func(t *testing.T) {
			g := newGHLike(t, clock)
			prod, err := devtuf.ReadKeyFile(filepath.Join(g.offline, "production.json"), trust.ChannelProduction)
			if err != nil {
				t.Fatal(err)
			}
			out := filepath.Join(t.TempDir(), "ceremony")
			interrupted := errors.New("interrupted")
			undo := devtuf.SetRotateHook(func(stage string) error {
				if stage == stop {
					return interrupted
				}
				return nil
			})
			r, err := devtuf.Load(g.dir, devtuf.Options{Now: clock})
			if err != nil {
				t.Fatal(err)
			}
			if _, err := r.RotateTopLevel(devtuf.RotateOptions{OfflineDir: out, ProductionKey: prod}); !errors.Is(err, interrupted) {
				t.Fatalf("the interruption: %v", err)
			}
			undo()
			keysBefore := names(t, out)
			if got := names(t, g.keys); !slicesContain(got, "root-0.json") || !slicesContain(got, "targets-0.json") {
				t.Fatalf("the old keys went before the push: %v", got)
			}
			// Another folder is refused: the ceremony under way has its keys in out.
			again, err := devtuf.Load(g.dir, devtuf.Options{Now: clock})
			if err != nil {
				t.Fatal(err)
			}
			if _, err := again.RotateTopLevel(devtuf.RotateOptions{OfflineDir: filepath.Join(t.TempDir(), "other")}); !errors.Is(err, devtuf.ErrCeremony) {
				t.Fatalf("another folder: %v", err)
			}
			for i := 0; i < 2; i++ {
				again, err := devtuf.Load(g.dir, devtuf.Options{Now: clock})
				if err != nil {
					t.Fatal(err)
				}
				res, err := again.RotateTopLevel(devtuf.RotateOptions{OfflineDir: out})
				if err != nil {
					t.Fatalf("carrying on (%d): %v", i, err)
				}
				if res.RootTo != 4 || res.RootThreshold != 2 || len(res.RootKeys) != 3 {
					t.Fatalf("carried on to %+v", res)
				}
			}
			// The same keys: none made again, and the note for the offline media once it is signed.
			if got := names(t, out); len(got) != len(keysBefore)+1 || got[0] != "README.txt" {
				t.Fatalf("the offline folder changed: %v, was %v", got, keysBefore)
			}
			for _, n := range keysBefore {
				if b, err := os.ReadFile(filepath.Join(out, n)); err != nil || len(b) == 0 {
					t.Fatalf("%s: %v", n, err)
				}
			}
			// The chain is whole: a box on the interim root walks to the ceremony's root and its targets verify.
			g.resign(t, now)
			repo, err := g.box(t, g.interim, filepath.Join(t.TempDir(), "box"), true, now)
			if err != nil || repo.RootVersion != 4 || len(repo.ReleaseIDs()) != 1 {
				t.Fatalf("a box after the resumed ceremony: %v %+v", err, repo)
			}
			fin, err := devtuf.Load(g.dir, devtuf.Options{Now: clock})
			if err != nil {
				t.Fatal(err)
			}
			if done, err := fin.FinishRotation(); err != nil || !done {
				t.Fatalf("finish: %v %v", done, err)
			}
			if got := names(t, g.keys); slicesContain(got, "root-0.json") || slicesContain(got, "targets-0.json") {
				t.Fatalf("the old keys are still online after the finish: %v", got)
			}
			second, err := devtuf.Load(g.dir, devtuf.Options{Now: clock})
			if err != nil {
				t.Fatal(err)
			}
			if _, err := second.RotateTopLevel(devtuf.RotateOptions{OfflineDir: filepath.Join(t.TempDir(), "second")}); !errors.Is(err, devtuf.ErrCeremony) {
				t.Fatalf("a second ceremony without the root keys: %v", err)
			}
		})
	}
}

func slicesContain(s []string, v string) bool {
	for _, x := range s {
		if x == v {
			return true
		}
	}
	return false
}

// The ceremony refuses what would leave a box or a key behind, and nothing is written then.
func TestKeyCeremonyRefusals(t *testing.T) {
	now := time.Date(2026, 11, 20, 10, 0, 0, 0, time.UTC)
	clock := func() time.Time { return now }
	g := newGHLike(t, clock)
	prod, _ := devtuf.ReadKeyFile(filepath.Join(g.offline, "production.json"), trust.ChannelProduction)
	before := dirDigest(t, g.dir)
	full := filepath.Join(t.TempDir(), "full")
	if err := os.MkdirAll(full, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(full, "x"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	for name, o := range map[string]devtuf.RotateOptions{
		"no production key":        {OfflineDir: filepath.Join(t.TempDir(), "a")},
		"another production key":   {OfflineDir: filepath.Join(t.TempDir(), "b"), ProductionKey: devtuf.NewDevKey()},
		"a relative folder":        {OfflineDir: "ceremony", ProductionKey: prod},
		"inside the repository":    {OfflineDir: filepath.Join(g.dir, "offline"), ProductionKey: prod},
		"inside the keys folder":   {OfflineDir: filepath.Join(g.keys, "offline"), ProductionKey: prod},
		"a folder with something":  {OfflineDir: full, ProductionKey: prod},
		"a root of one key":        {OfflineDir: filepath.Join(t.TempDir(), "c"), ProductionKey: prod, RootKeys: 1, RootThreshold: 1},
		"more needed than present": {OfflineDir: filepath.Join(t.TempDir(), "d"), ProductionKey: prod, RootKeys: 2, RootThreshold: 3},
	} {
		r, err := devtuf.Load(g.dir, devtuf.Options{Now: clock})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := r.RotateTopLevel(o); !errors.Is(err, devtuf.ErrCeremony) {
			t.Errorf("%s: %v", name, err)
		}
	}
	if dirDigest(t, g.dir) != before {
		t.Fatal("a refused ceremony wrote into the repository")
	}
	// Without the current root key there is nothing to sign the new root with.
	if err := os.Remove(filepath.Join(g.keys, "root-0.json")); err != nil {
		t.Fatal(err)
	}
	r, err := devtuf.Load(g.dir, devtuf.Options{Now: clock})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := r.RotateTopLevel(devtuf.RotateOptions{OfflineDir: filepath.Join(t.TempDir(), "e"), ProductionKey: prod}); !errors.Is(err, devtuf.ErrCeremony) {
		t.Fatalf("without the root key: %v", err)
	}
}

// ONE-04 at the GitHub repository: a new release is whombat-YYYYMMDD.N, checked against the Beta (development) role's
// releases with Home's whombat-dev-YYYYMMDD.N ids in one family (LNK-22): the same day and number is not newer, a
// higher number or a later day is. The top level lists no release.
func TestChannelCheckNewer(t *testing.T) {
	now := time.Date(2026, 11, 20, 10, 0, 0, 0, time.UTC)
	g := newGHLike(t, func() time.Time { return now })
	top, err := devtuf.VerifyPublishedIn(devtuf.DirMetadata(g.dir), g.pinned, false, true, now, "")
	if err != nil || len(top.Releases) != 0 {
		t.Fatalf("top level %+v %v", top, err)
	}
	v, err := devtuf.VerifyPublishedIn(devtuf.DirMetadata(g.dir), g.pinned, false, true, now, trust.ChannelDevelopment)
	if err != nil || len(v.Releases) != 1 || v.Releases[0].ID != "whombat-dev-20261119.9" || v.Versions[trust.ChannelDevelopment] == 0 {
		t.Fatalf("development %+v %v", v, err)
	}
	// The candidate carries the published release's versions; only its id differs.
	cand := func(id string) devtuf.ReleaseSummary {
		c := v.Releases[0]
		c.ID = id
		return c
	}
	opt := devtuf.NewerOptions{Channel: true}
	for id, ok := range map[string]bool{"whombat-20261119.9": false, "whombat-20261119.8": false,
		"whombat-20261119.10": true, "whombat-20261120.1": true} {
		if _, err := devtuf.CheckNewer(v.Releases, cand(id), opt); (err == nil) != ok {
			t.Errorf("%s: %v", id, err)
		}
	}
	if _, err := devtuf.VerifyPublishedIn(devtuf.DirMetadata(g.dir), g.pinned, false, true, now, "beta"); err == nil {
		t.Fatal("a channel that doesn't exist")
	}
	if p, err := devtuf.VerifyPublishedIn(devtuf.DirMetadata(g.dir), g.pinned, false, true, now, trust.ChannelProduction); err != nil || len(p.Releases) != 0 {
		t.Fatalf("production %+v %v", p, err)
	}
}

// ONE-05: the GitHub repository signs its AI client channel for production once set, with the same clients key: the
// key document a production image pins says prod, and the setting survives a reload.
func TestClientsEnvProduction(t *testing.T) {
	now := time.Date(2026, 11, 20, 10, 0, 0, 0, time.UTC)
	clock := func() time.Time { return now }
	g := newGHLike(t, clock)
	r, err := devtuf.Load(g.dir, devtuf.Options{Now: clock})
	if err != nil {
		t.Fatal(err)
	}
	before, err := r.ClientChannelKeys()
	if err != nil || before.Env != "local" {
		t.Fatalf("before: %+v %v", before, err)
	}
	if err := r.SetClientsEnv("staging"); err == nil {
		t.Fatal("an env that doesn't exist")
	}
	if err := r.SetClientsEnv("prod"); err != nil {
		t.Fatal(err)
	}
	again, err := devtuf.Load(g.dir, devtuf.Options{Now: clock})
	if err != nil {
		t.Fatal(err)
	}
	doc, err := again.ClientChannelKeys()
	if err != nil || again.ClientsEnv() != "prod" || again.Env != "local" || doc.Env != "prod" || len(doc.Keys) != 1 ||
		doc.Keys[0].PublicKey != before.Keys[0].PublicKey || doc.Keys[0].Kid == before.Keys[0].Kid {
		t.Fatalf("after: env %s/%s doc %+v %v", again.ClientsEnv(), again.Env, doc, err)
	}
	// A repository that isn't the GitHub one keeps its env.
	dev, err := devtuf.New(filepath.Join(t.TempDir(), "dev"), devtuf.Options{Env: "local", Now: clock})
	if err != nil {
		t.Fatal(err)
	}
	if err := dev.SetClientsEnv("prod"); err == nil {
		t.Fatal("a development repository's channel changed env")
	}
}

// hideFirst answers 404 for one metadata file the first time it is asked for, then serves it: a root published during a
// refresh.
type hideFirst struct {
	inner trust.DirFetcher
	name  string
	asked int
}

func (h *hideFirst) DownloadFile(u string, max int64, timeout time.Duration) ([]byte, error) {
	if strings.HasSuffix(u, "/"+h.name) {
		h.asked++
		if h.asked == 1 {
			return nil, &metadata.ErrDownloadHTTP{StatusCode: 404, URL: u}
		}
	}
	return h.inner.DownloadFile(u, max, timeout)
}

// signRoot writes root version v (threshold th, the keys of the files named) signed by the key files given.
func signRoot(t *testing.T, base []byte, meta string, v int64, th int, keyDir string, keys, signers []string) []byte {
	t.Helper()
	r, err := metadata.Root().FromBytes(base)
	if err != nil {
		t.Fatal(err)
	}
	r.Signed.Version = v
	for _, id := range append([]string{}, r.Signed.Roles[metadata.ROOT].KeyIDs...) {
		if err := r.Signed.RevokeKey(id, metadata.ROOT); err != nil {
			t.Fatal(err)
		}
	}
	for _, f := range keys {
		k, err := devtuf.ReadKeyFile(filepath.Join(keyDir, f), metadata.ROOT)
		if err != nil {
			t.Fatal(err)
		}
		pk, err := metadata.KeyFromPublicKey(k.Public())
		if err != nil {
			t.Fatal(err)
		}
		if err := r.Signed.AddKey(pk, metadata.ROOT); err != nil {
			t.Fatal(err)
		}
	}
	r.Signed.Roles[metadata.ROOT].Threshold = th
	r.ClearSignatures()
	for _, f := range signers {
		k, err := devtuf.ReadKeyFile(filepath.Join(keyDir, f), metadata.ROOT)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := r.Sign(signerOf(t, k)); err != nil {
			t.Fatal(err)
		}
	}
	p := filepath.Join(meta, fmt.Sprintf("%d.root.json", v))
	if err := r.ToFile(p, true); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// One root walk per refresh, the policy-checked one, is the only place roots are fetched and written (R2 A1): a root
// that appears during the refresh is never written by go-tuf, and a root that passes the rules but is reached through a
// refused one is never trusted.
func TestRootWalkIsTheOnlyOne(t *testing.T) {
	now := time.Date(2026, 11, 20, 10, 0, 0, 0, time.UTC)
	clock := func() time.Time { return now }
	g := newGHLike(t, clock)
	r, err := devtuf.Load(g.dir, devtuf.Options{Now: clock})
	if err != nil {
		t.Fatal(err)
	}
	prod, err := devtuf.ReadKeyFile(filepath.Join(g.offline, "production.json"), trust.ChannelProduction)
	if err != nil {
		t.Fatal(err)
	}
	out := filepath.Join(t.TempDir(), "ceremony")
	if _, err := r.RotateTopLevel(devtuf.RotateOptions{OfflineDir: out, ProductionKey: prod}); err != nil {
		t.Fatal(err)
	}
	if _, err := r.FinishRotation(); err != nil {
		t.Fatal(err)
	}
	g.resign(t, now)
	root4, err := os.ReadFile(filepath.Join(g.meta, "root.json"))
	if err != nil {
		t.Fatal(err)
	}
	box := func(f interface {
		DownloadFile(string, int64, time.Duration) ([]byte, error)
	}, cache string) (*trust.Repo, error) {
		return trust.Refresh(trust.Config{PinnedRoot: root4, MetadataDir: cache, MetadataURL: "m://x", Fetcher: f,
			Now: now, Channel: trust.ChannelDevelopment, Production: true})
	}
	dir := trust.DirFetcher{BaseURL: "m://x", Dir: g.meta}
	cache := filepath.Join(t.TempDir(), "box")
	if repo, err := box(dir, cache); err != nil || repo.RootVersion != 4 {
		t.Fatalf("before: %v", err)
	}

	// Root 5 needs one key; it appears while a refresh runs (404 the first time it is asked for).
	signRoot(t, root4, g.meta, 5, 1, out, []string{"root-0.json", "root-1.json", "root-2.json"}, []string{"root-0.json", "root-1.json"})
	g.resign(t, now)
	late := &hideFirst{inner: dir, name: "5.root.json"}
	if repo, err := box(late, cache); err != nil || repo.RootVersion != 4 {
		t.Fatalf("the refresh while root 5 appeared: %v %+v", err, repo)
	}
	if late.asked != 1 {
		t.Fatalf("root 5 was asked for %d times in one refresh: go-tuf walked roots too", late.asked)
	}
	if v := cachedRootVersion(t, cache); v != 4 {
		t.Fatalf("the cache holds root %d", v)
	}
	if _, err := box(late, cache); !errors.Is(err, trust.ErrSingleKeyRoot) {
		t.Fatalf("the next refresh: %v", err)
	}
	if v := cachedRootVersion(t, cache); v != 4 {
		t.Fatalf("the refused root %d was cached", v)
	}

	// Root 6 passes the rules, but only through root 5 (it is signed by 5's one key): never trusted, never cached.
	signRoot(t, root4, g.meta, 6, 2, out, []string{"root-0.json", "root-1.json", "root-2.json"}, []string{"root-0.json", "root-1.json"})
	g.resign(t, now)
	for _, c := range []string{cache, filepath.Join(t.TempDir(), "fresh")} {
		repo, err := box(dir, c)
		if !errors.Is(err, trust.ErrSingleKeyRoot) || repo != nil {
			t.Fatalf("root 6 through root 5: %v %+v", err, repo)
		}
		if v := cachedRootVersion(t, c); v > 4 {
			t.Fatalf("root %d cached through a refused root", v)
		}
	}
}

// The keys folder changes one file at a time (R2 A2): a kill before any change of the ceremony (the production key
// added, the old root and targets keys removed) leaves the development (Beta) and clients keys as they were and
// readable, a temporary file a kill left is never read as a key, and running the ceremony again finishes it.
func TestCeremonyKeysSurviveAKill(t *testing.T) {
	now := time.Date(2026, 11, 20, 10, 0, 0, 0, time.UTC)
	clock := func() time.Time { return now }
	read := func(t *testing.T, dir string) map[string]string {
		t.Helper()
		out := map[string]string{}
		for _, n := range names(t, dir) {
			b, err := os.ReadFile(filepath.Join(dir, n))
			if err != nil {
				t.Fatal(err)
			}
			out[n] = string(b)
		}
		return out
	}
	for kill := 0; ; kill++ {
		g := newGHLike(t, clock)
		before := read(t, g.keys)
		prod, err := devtuf.ReadKeyFile(filepath.Join(g.offline, "production.json"), trust.ChannelProduction)
		if err != nil {
			t.Fatal(err)
		}
		out := filepath.Join(t.TempDir(), "ceremony")
		killed := errors.New("killed")
		ops := 0
		undo := devtuf.SetKeyFileHook(func(op, name string) error {
			ops++
			if ops == kill+1 {
				return killed
			}
			return nil
		})
		r, err := devtuf.Load(g.dir, devtuf.Options{Now: clock})
		if err != nil {
			t.Fatal(err)
		}
		_, err = r.RotateTopLevel(devtuf.RotateOptions{OfflineDir: out, ProductionKey: prod})
		if err == nil {
			var fin *devtuf.Repo
			if fin, err = devtuf.Load(g.dir, devtuf.Options{Now: clock}); err == nil {
				_, err = fin.FinishRotation()
			}
		}
		undo()
		if err == nil {
			if kill < 3 {
				t.Fatalf("the ceremony changed %d key files, fewer than three", ops)
			}
			return // every kill point was tried
		}
		if !errors.Is(err, killed) {
			t.Fatalf("kill %d: %v", kill, err)
		}
		// Beta's and the clients' keys are where they were, byte for byte, and the folder loads.
		now := read(t, g.keys)
		for _, n := range []string{"development-0.json", "clients-0.json"} {
			if now[n] != before[n] || before[n] == "" {
				t.Fatalf("kill %d: %s changed or went", kill, n)
			}
		}
		if err := os.WriteFile(filepath.Join(g.keys, "development-0.json.tmp-123"), []byte("half a key"), 0o600); err != nil {
			t.Fatal(err)
		}
		again, err := devtuf.Load(g.dir, devtuf.Options{Now: clock})
		if err != nil {
			t.Fatalf("kill %d: the keys folder doesn't load: %v", kill, err)
		}
		if again.RotationPending() {
			if _, err := again.RotateTopLevel(devtuf.RotateOptions{OfflineDir: out}); err != nil {
				t.Fatalf("kill %d: carrying on: %v", kill, err)
			}
			fin, err := devtuf.Load(g.dir, devtuf.Options{Now: clock})
			if err != nil {
				t.Fatal(err)
			}
			if _, err := fin.FinishRotation(); err != nil {
				t.Fatalf("kill %d: finishing: %v", kill, err)
			}
		}
		if got := names(t, g.keys); len(got) != 3 || got[0] != "clients-0.json" || got[1] != "development-0.json" ||
			got[2] != "production-0.json" {
			t.Fatalf("kill %d: the keys after carrying on: %v", kill, got)
		}
		if final := read(t, g.keys); final["development-0.json"] != before["development-0.json"] ||
			final["clients-0.json"] != before["clients-0.json"] {
			t.Fatalf("kill %d: the development or clients key changed", kill)
		}
	}
}
