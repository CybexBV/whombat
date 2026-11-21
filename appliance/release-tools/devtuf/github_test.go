package devtuf_test

import (
	"crypto"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
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
	"github.com/CybexBV/whombat/contracts/go/release"
	"github.com/sigstore/sigstore/pkg/signature"
	"github.com/theupdateframework/go-tuf/v2/metadata"
)

// dirDigest hashes every file name and content under dir (to prove a source is untouched).
func dirDigest(t *testing.T, dir string) string {
	t.Helper()
	h := sha256.New()
	var names []string
	filepath.Walk(dir, func(p string, info os.FileInfo, err error) error {
		if err == nil && info.Mode().IsRegular() {
			names = append(names, p)
		}
		return nil
	})
	sort.Strings(names)
	for _, n := range names {
		b, _ := os.ReadFile(n)
		h.Write([]byte(n))
		h.Write(b)
	}
	return hex.EncodeToString(h.Sum(nil))
}

// devLike is a repository shaped like DEV's: top-level releases, a clients role, root version 2.
func devLike(t *testing.T, now func() time.Time) *devtuf.Repo {
	t.Helper()
	r, err := devtuf.New(filepath.Join(t.TempDir(), "dev"), devtuf.Options{Env: "local", Now: now})
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range []devtuf.FakeRelease{devtuf.StandardRelease("whombat-dev-20261117.1", "26.05.1", "1.0.0"),
		devtuf.StandardRelease("whombat-dev-20261117.2", "26.05.1", "1.1.0")} {
		if _, err := r.AddFakeRelease(f); err != nil {
			t.Fatal(err)
		}
		if err := r.Publish(); err != nil {
			t.Fatal(err)
		}
	}
	if err := r.AddClientsRole(nil); err != nil {
		t.Fatal(err)
	}
	if err := r.PublishClients(nil, map[string][]byte{release.ClientChannelTarget: []byte(`{"c":1}`)}); err != nil {
		t.Fatal(err)
	}
	if err := r.RotateKeys("snapshot"); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 5; i++ {
		if err := r.PublishTimestamp(); err != nil {
			t.Fatal(err)
		}
	}
	return r
}

func refresh(t *testing.T, pinned []byte, metaDir, cache, channel string, now time.Time) (*trust.Repo, error) {
	t.Helper()
	return trust.Refresh(trust.Config{PinnedRoot: pinned, MetadataDir: cache, MetadataURL: "m://x",
		Fetcher: trust.DirFetcher{BaseURL: "m://x", Dir: metaDir}, Now: now, Channel: channel, ResolveClients: true})
}

// The GitHub repository continues DEV's (LNK-26): a box that trusted DEV's metadata moves to it with its cache (root
// chain walked, versions only grow), the source is never written, and the online roles are signed on the build server while
// snapshot and timestamp come from the workflow's keys (ResignOnline).
func TestContinueResignAndExpiries(t *testing.T) {
	now := time.Date(2026, 11, 18, 12, 0, 0, 0, time.UTC)
	clock := func() time.Time { return now }
	src := devLike(t, clock)
	pinned := src.InitialRoot()
	before := dirDigest(t, src.Dir)
	box := filepath.Join(t.TempDir(), "box-cache")
	if _, err := refresh(t, pinned, src.MetadataDir(), box, "", now); err != nil {
		t.Fatalf("the box on DEV: %v", err)
	}
	from := src.RoleVersions()

	base := t.TempDir()
	out, keys, offline := filepath.Join(base, "whombat-releases"), filepath.Join(base, "keys"), filepath.Join(base, "offline")
	res, err := devtuf.Continue(src.Dir, out, devtuf.ContinueOptions{KeysDir: keys, OfflineKeysDir: offline, VersionGap: 1000, Now: clock})
	if err != nil {
		t.Fatal(err)
	}
	if after := dirDigest(t, src.Dir); after != before {
		t.Fatal("continue wrote into the source repository")
	}
	if res.Versions["root"] != from["root"]+1 || res.Versions["targets"] != from["targets"]+1000 ||
		res.Versions["snapshot"] != from["snapshot"]+1000 || res.Versions["timestamp"] != from["timestamp"]+1000 ||
		res.Versions["clients"] != from["clients"] || res.DroppedReleases != 2 || len(res.Bridge) == 0 {
		t.Fatalf("versions %v from %v, dropped %d", res.Versions, from, res.DroppedReleases)
	}
	for _, f := range []string{"snapshot.json", "timestamp.json", "production.json"} {
		if st, err := os.Stat(filepath.Join(offline, f)); err != nil || st.Mode().Perm() != 0o600 {
			t.Fatalf("offline key %s: %v", f, err)
		}
	}
	for _, f := range []string{"snapshot-0.json", "timestamp-0.json", "production-0.json"} {
		if _, err := os.Stat(filepath.Join(keys, f)); err == nil {
			t.Fatalf("%s stayed with the online keys", f)
		}
	}
	meta := filepath.Join(out, "metadata")
	// The box moves over with its cache: no rollback, the clients channel still resolves, both channels empty.
	for _, ch := range trust.Channels {
		repo, err := refresh(t, pinned, meta, box, ch, now)
		if err != nil {
			t.Fatalf("the box on the GitHub repository (%s): %v", ch, err)
		}
		if repo.RootVersion != res.Versions["root"] || len(repo.ReleaseIDs()) != 0 || repo.ClientsError() != nil {
			t.Fatalf("%s: root %d ids %v clients %v", ch, repo.RootVersion, repo.ReleaseIDs(), repo.ClientsError())
		}
	}

	// DEV's old root and targets keys sign nothing the box accepts any more.
	checkOldKeysRefused(t, filepath.Join(src.Dir, "keys"), keys, offline, meta, pinned, box, now)

	// The build server publishes a development release: the role is signed, snapshot and timestamp wait for the workflow.
	gh, err := devtuf.Load(out, devtuf.Options{})
	if err != nil {
		t.Fatal(err)
	}
	if !gh.GitHub() || gh.ChannelKey(trust.ChannelProduction) != nil {
		t.Fatal("the GitHub layout or the offline production key is wrong")
	}
	gh.InChannel(trust.ChannelDevelopment)
	if _, err := gh.AddFakeRelease(devtuf.StandardRelease("whombat-dev-20261118.1", "26.05.1", "2.0.0")); err != nil {
		t.Fatal(err)
	}
	tsBefore, _ := os.ReadFile(filepath.Join(meta, "timestamp.json"))
	if err := gh.Publish(); err != nil {
		t.Fatal(err)
	}
	if tsAfter, _ := os.ReadFile(filepath.Join(meta, "timestamp.json")); string(tsAfter) != string(tsBefore) {
		t.Fatal("the publisher signed a timestamp")
	}
	if repo, err := refresh(t, pinned, meta, box, trust.ChannelDevelopment, now); err != nil || len(repo.ReleaseIDs()) != 0 {
		t.Fatalf("before the workflow: %v %v", err, repo)
	}
	// Loading again (a second publish before the workflow ran) continues from the newest role on disk.
	again, err := devtuf.Load(out, devtuf.Options{})
	if err != nil {
		t.Fatal(err)
	}
	if v := again.RoleVersions()[trust.ChannelDevelopment]; v != 2 {
		t.Fatalf("development version after reload %d", v)
	}

	// The workflow.
	snapKey, err := devtuf.ReadKeyFile(filepath.Join(offline, "snapshot.json"), "snapshot")
	if err != nil {
		t.Fatal(err)
	}
	tsKey, _ := devtuf.ReadKeyFile(filepath.Join(offline, "timestamp.json"), "timestamp")
	if _, err := devtuf.ResignOnline(meta, tsKey, snapKey, devtuf.ResignOptions{Now: now}); err == nil {
		t.Fatal("signed with the keys swapped")
	}
	rr, err := devtuf.ResignOnline(meta, snapKey, tsKey, devtuf.ResignOptions{Now: now})
	if err != nil {
		t.Fatal(err)
	}
	if !rr.SnapshotNew || rr.Roles[trust.ChannelDevelopment] != 2 || rr.Timestamp != res.Versions["timestamp"]+1 {
		t.Fatalf("resign %+v", rr)
	}
	repo, err := refresh(t, pinned, meta, box, trust.ChannelDevelopment, now)
	if err != nil || len(repo.ReleaseIDs()) != 1 {
		t.Fatalf("after the workflow: %v", err)
	}
	// Six hours later nothing changed: a new timestamp over the same snapshot.
	later := now.Add(6 * time.Hour)
	rr2, err := devtuf.ResignOnline(meta, snapKey, tsKey, devtuf.ResignOptions{Now: later})
	if err != nil || rr2.SnapshotNew || rr2.Snapshot != rr.Snapshot || rr2.Timestamp != rr.Timestamp+1 {
		t.Fatalf("idle resign %+v %v", rr2, err)
	}
	// A broken push (a role version that doesn't verify) is never listed.
	if err := os.WriteFile(filepath.Join(meta, "3.development.json"), []byte(strings.Replace(mustRead(t, filepath.Join(meta, "2.development.json")), `"version": 2`, `"version": 3`, 1)), 0o644); err != nil {
		t.Fatal(err)
	}
	rr3, err := devtuf.ResignOnline(meta, snapKey, tsKey, devtuf.ResignOptions{Now: later})
	if err != nil || rr3.Roles[trust.ChannelDevelopment] != 2 || len(rr3.Skipped) == 0 {
		t.Fatalf("broken push %+v %v", rr3, err)
	}
	if _, err := refresh(t, pinned, meta, box, trust.ChannelDevelopment, later); err != nil {
		t.Fatalf("after a broken push: %v", err)
	}
	os.Remove(filepath.Join(meta, "3.development.json"))

	// Expiries (LNK-25): root and top targets a year, production 120 days, development 90 days, clients 21 days.
	exp, err := devtuf.Expiries(meta, now)
	if err != nil {
		t.Fatal(err)
	}
	days := map[string]int{}
	for _, e := range exp {
		days[e.Role] = e.DaysLeft
	}
	if days["production"] != 119 && days["production"] != 120 || days["targets"] < 364 || days["development"] < 89 || days["clients"] > 21 {
		t.Fatalf("expiries %v", days)
	}
	if exp[0].Role != "clients" {
		t.Fatalf("soonest first: %v", exp)
	}

	// Promotion with the offline production key.
	prodKey, _ := devtuf.ReadKeyFile(filepath.Join(offline, "production.json"), "production")
	again.InChannel("")
	if _, err := again.Promote("whombat-dev-20261118.1", trust.ChannelDevelopment, trust.ChannelProduction, nil); err == nil {
		t.Fatal("promoted without the production key")
	}
	again2, _ := devtuf.Load(out, devtuf.Options{})
	if _, err := again2.Promote("whombat-dev-20261118.1", trust.ChannelDevelopment, trust.ChannelProduction, prodKey); err != nil {
		t.Fatal(err)
	}
	if _, err := devtuf.ResignOnline(meta, snapKey, tsKey, devtuf.ResignOptions{Now: later}); err != nil {
		t.Fatal(err)
	}
	if repo, err := refresh(t, pinned, meta, box, trust.ChannelProduction, later); err != nil || len(repo.ReleaseIDs()) != 1 {
		t.Fatalf("production after the promotion: %v", err)
	}

	// A push that leaves a delegated role with no version that verifies: nothing is signed (the workflow fails), the
	// last snapshot and timestamp keep serving production's last good role.
	prodFiles, _ := filepath.Glob(filepath.Join(meta, "*.production.json"))
	for _, f := range prodFiles {
		b, _ := os.ReadFile(f)
		if err := os.WriteFile(f, []byte(strings.Replace(string(b), `"sig": "`, `"sig": "00`, 1)), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	tsBefore, _ = os.ReadFile(filepath.Join(meta, "timestamp.json"))
	snapsBefore := devtuf.NewestOnDisk(meta, "snapshot")
	if _, err := devtuf.ResignOnline(meta, snapKey, tsKey, devtuf.ResignOptions{Now: later.Add(time.Hour)}); err == nil ||
		!strings.Contains(err.Error(), "production") {
		t.Fatalf("a snapshot without production: %v", err)
	}
	if tsAfter, _ := os.ReadFile(filepath.Join(meta, "timestamp.json")); string(tsAfter) != string(tsBefore) ||
		devtuf.NewestOnDisk(meta, "snapshot") != snapsBefore {
		t.Fatal("something was signed")
	}
}

func mustRead(t *testing.T, p string) string {
	t.Helper()
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// TestContinueRehearsal continues a COPY of a real repository (LNK-26): WHOMBAT_CONTINUE_SOURCE names the copy (never
// the live directory: the test checks that the source is unchanged, and the copy's keys are read). A box that trusted
// the source moves to the result with its cache in both channels; the workflow's keys re-sign it.
func TestContinueRehearsal(t *testing.T) {
	src := os.Getenv("WHOMBAT_CONTINUE_SOURCE")
	if src == "" {
		t.Skip("WHOMBAT_CONTINUE_SOURCE (a copy of a repository) not set")
	}
	now := time.Now()
	pinned, err := os.ReadFile(filepath.Join(src, "metadata", "1.root.json"))
	if err != nil {
		t.Fatal(err)
	}
	before := dirDigest(t, src)
	box := filepath.Join(t.TempDir(), "box")
	srcView, err := refresh(t, pinned, filepath.Join(src, "metadata"), box, "", now)
	if err != nil {
		t.Fatalf("the source as a box sees it: %v", err)
	}
	base := t.TempDir()
	out, keys, offline := filepath.Join(base, "github"), filepath.Join(base, "keys"), filepath.Join(base, "offline")
	res, err := devtuf.Continue(src, out, devtuf.ContinueOptions{KeysDir: keys, OfflineKeysDir: offline})
	if err != nil {
		t.Fatal(err)
	}
	if dirDigest(t, src) != before {
		t.Fatal("continue changed the source")
	}
	t.Logf("from %v to %v; %d releases not carried; carried %d targets", res.From, res.Versions, res.DroppedReleases, len(res.CarriedTargets))
	for _, line := range res.Bridge {
		t.Logf("bridge: %s", line)
	}
	meta := filepath.Join(out, "metadata")
	for _, ch := range trust.Channels {
		repo, err := refresh(t, pinned, meta, box, ch, now)
		if err != nil {
			t.Fatalf("the box on the continued repository (%s): %v", ch, err)
		}
		if repo.RootVersion != srcView.RootVersion+1 || repo.TargetsVersion <= srcView.TargetsVersion {
			t.Fatalf("%s: root %d targets %d after %d/%d", ch, repo.RootVersion, repo.TargetsVersion, srcView.RootVersion, srcView.TargetsVersion)
		}
		if (srcView.ClientsError() == nil) != (repo.ClientsError() == nil) {
			t.Fatalf("clients: source %v, continued %v", srcView.ClientsError(), repo.ClientsError())
		}
	}
	srcKeys := os.Getenv("WHOMBAT_CONTINUE_SOURCE_KEYS")
	if srcKeys == "" {
		srcKeys = filepath.Join(src, "keys")
	}
	checkOldKeysRefused(t, srcKeys, keys, offline, meta, pinned, box, now)
	t.Log("after the new root: a root signed by the old root key and targets signed by the old targets key are refused; the new targets key is accepted")
	snap, _ := devtuf.ReadKeyFile(filepath.Join(offline, "snapshot.json"), "snapshot")
	ts, _ := devtuf.ReadKeyFile(filepath.Join(offline, "timestamp.json"), "timestamp")
	rr, err := devtuf.ResignOnline(meta, snap, ts, devtuf.ResignOptions{Now: now.Add(6 * time.Hour)})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := refresh(t, pinned, meta, box, trust.ChannelDevelopment, now.Add(6*time.Hour)); err != nil {
		t.Fatalf("after the workflow: %v", err)
	}
	t.Logf("workflow: snapshot %d timestamp %d", rr.Snapshot, rr.Timestamp)
}

// copyFlat copies a directory's files (one level, plus nothing else: metadata and box caches are flat).
func copyFlat(t *testing.T, src string) string {
	t.Helper()
	dst := t.TempDir()
	if err := os.CopyFS(dst, os.DirFS(src)); err != nil {
		t.Fatal(err)
	}
	return dst
}

// keyOf reads the first key file of a role in a keys directory (never printed).
func keyOf(t *testing.T, keysDir, role string) ed25519.PrivateKey {
	t.Helper()
	entries, err := os.ReadDir(keysDir)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if got, seed, err := devtuf.LoadKeyFile(filepath.Join(keysDir, e.Name())); err == nil && got == role {
			return ed25519.NewKeyFromSeed(seed)
		}
	}
	t.Fatalf("no %s key in the keys directory", role)
	return nil
}

func sign[T metadata.Roles](t *testing.T, md *metadata.Metadata[T], k ed25519.PrivateKey) {
	t.Helper()
	s, err := signature.LoadSigner(k, crypto.Hash(0))
	if err != nil {
		t.Fatal(err)
	}
	md.ClearSignatures()
	if _, err := md.Sign(s); err != nil {
		t.Fatal(err)
	}
}

// forgeTargets writes a next targets version signed with targetsKey and a snapshot and timestamp (signed with the
// workflow's keys) that list it, into a copy of meta, and returns the copy.
func forgeTargets(t *testing.T, meta string, targetsKey, snapKey, tsKey ed25519.PrivateKey) string {
	t.Helper()
	dir := copyFlat(t, meta)
	ts, err := metadata.Timestamp().FromFile(filepath.Join(dir, "timestamp.json"))
	if err != nil {
		t.Fatal(err)
	}
	sv := ts.Signed.Meta["snapshot.json"].Version
	snap, err := metadata.Snapshot().FromFile(filepath.Join(dir, fmt.Sprintf("%d.snapshot.json", sv)))
	if err != nil {
		t.Fatal(err)
	}
	tv := snap.Signed.Meta["targets.json"].Version
	tg, err := metadata.Targets().FromFile(filepath.Join(dir, fmt.Sprintf("%d.targets.json", tv)))
	if err != nil {
		t.Fatal(err)
	}
	tg.Signed.Version = tv + 1
	sign(t, tg, targetsKey)
	if err := tg.ToFile(filepath.Join(dir, fmt.Sprintf("%d.targets.json", tv+1)), true); err != nil {
		t.Fatal(err)
	}
	snap.Signed.Version = sv + 1
	snap.Signed.Meta["targets.json"] = metadata.MetaFile(tv + 1)
	sign(t, snap, snapKey)
	snapPath := filepath.Join(dir, fmt.Sprintf("%d.snapshot.json", sv+1))
	if err := snap.ToFile(snapPath, true); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(snapPath)
	sum := sha256.Sum256(b)
	mf := metadata.MetaFile(sv + 1)
	mf.Length, mf.Hashes = int64(len(b)), metadata.Hashes{"sha256": sum[:]}
	ts.Signed.Version++
	ts.Signed.Meta["snapshot.json"] = mf
	sign(t, ts, tsKey)
	if err := ts.ToFile(filepath.Join(dir, "timestamp.json"), true); err != nil {
		t.Fatal(err)
	}
	return dir
}

// checkOldKeysRefused: after the continued root, a root version signed by DEV's old root key and a targets version
// signed by its old targets key are refused by a box that moved across; the same targets forgery signed with the new
// targets key is accepted (the check itself works).
func checkOldKeysRefused(t *testing.T, srcKeys, keys, offline, meta string, pinned []byte, box string, now time.Time) {
	t.Helper()
	oldRoot, oldTargets := keyOf(t, srcKeys, "root"), keyOf(t, srcKeys, "targets")
	newTargets := keyOf(t, keys, "targets")
	snapKey, err := devtuf.ReadKeyFile(filepath.Join(offline, "snapshot.json"), "snapshot")
	if err != nil {
		t.Fatal(err)
	}
	tsKey, _ := devtuf.ReadKeyFile(filepath.Join(offline, "timestamp.json"), "timestamp")
	// A next root signed by the old root key alone.
	dir := copyFlat(t, meta)
	v := devtuf.NewestOnDisk(dir, "root")
	root, err := metadata.Root().FromFile(filepath.Join(dir, fmt.Sprintf("%d.root.json", v)))
	if err != nil {
		t.Fatal(err)
	}
	root.Signed.Version = v + 1
	sign(t, root, oldRoot)
	if err := root.ToFile(filepath.Join(dir, fmt.Sprintf("%d.root.json", v+1)), true); err != nil {
		t.Fatal(err)
	}
	if _, err := refresh(t, pinned, dir, copyFlat(t, box), trust.ChannelDevelopment, now); !errors.Is(err, trust.ErrSignature) {
		t.Fatalf("a root signed by the old root key: %v", err)
	}
	// A next top-level targets signed by the old targets key.
	if _, err := refresh(t, pinned, forgeTargets(t, meta, oldTargets, snapKey, tsKey), copyFlat(t, box), trust.ChannelDevelopment, now); !errors.Is(err, trust.ErrSignature) {
		t.Fatalf("targets signed by the old targets key: %v", err)
	}
	if _, err := refresh(t, pinned, forgeTargets(t, meta, newTargets, snapKey, tsKey), copyFlat(t, box), trust.ChannelDevelopment, now); err != nil {
		t.Fatalf("the same change signed by the new targets key: %v", err)
	}
}
