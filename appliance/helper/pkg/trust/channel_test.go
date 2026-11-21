package trust_test

import (
	"crypto"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/helper/pkg/trust"
	"github.com/CybexBV/whombat/appliance/release-tools/devtuf"
	"github.com/sigstore/sigstore/pkg/signature"
	"github.com/theupdateframework/go-tuf/v2/metadata"
)

func channelCfg(r *devtuf.Repo, cache string, c *clock, channel string) trust.Config {
	x := cfg(r, cache, c.t)
	x.Channel = channel
	return x
}

// newChannelRepo is newRepo (rt-1 top-level) with both channel roles.
func newChannelRepo(t *testing.T, c *clock) *devtuf.Repo {
	t.Helper()
	r := newRepo(t, c)
	if err := r.AddChannelRoles(nil, nil); err != nil {
		t.Fatal(err)
	}
	return r
}

func addIn(t *testing.T, r *devtuf.Repo, channel string, f devtuf.FakeRelease) {
	t.Helper()
	if err := r.InChannel(channel); err != nil {
		t.Fatal(err)
	}
	defer r.InChannel("")
	if _, err := r.AddFakeRelease(f); err != nil {
		t.Fatal(err)
	}
	if err := r.Publish(); err != nil {
		t.Fatal(err)
	}
}

// A box resolves releases only through its channel's role (LNK-23): the top-level release and the other channel's
// are invisible; promotion lists the identical targets in production.
func TestChannelResolvesThroughItsRole(t *testing.T) {
	c := &clock{t0}
	r := newChannelRepo(t, c)
	addIn(t, r, trust.ChannelDevelopment, devtuf.StandardRelease("whombat-dev-20261118.1", "26.06.1", "2.0.0"))

	dev, err := trust.Refresh(channelCfg(r, t.TempDir(), c, trust.ChannelDevelopment))
	if err != nil {
		t.Fatal(err)
	}
	if ids := dev.ReleaseIDs(); len(ids) != 1 || ids[0] != "whombat-dev-20261118.1" {
		t.Fatalf("development ids %v", ids)
	}
	if dev.Channel != trust.ChannelDevelopment || dev.ChannelVersion != 2 || dev.RoleVersions[trust.ChannelDevelopment] != 2 {
		t.Fatalf("channel %q v%d %v", dev.Channel, dev.ChannelVersion, dev.RoleVersions)
	}
	rel, err := dev.Release("whombat-dev-20261118.1")
	if err != nil {
		t.Fatal(err)
	}
	// Indexes come from the release's own GitHub release; their blobs from the bucket releases (index v2).
	if want := "whombat-dev-20261118.1/" + rel.RuntimeIndex.SHA256() + ".whombat-runtime.index.json"; rel.RuntimeIndex.Remote != want {
		t.Fatalf("remote %q, want %q", rel.RuntimeIndex.Remote, want)
	}
	if _, err := dev.Release("rt-1"); !errors.Is(err, trust.ErrNotApproved) {
		t.Fatalf("a top-level release through the channel: %v", err)
	}

	prod, err := trust.Refresh(channelCfg(r, t.TempDir(), c, trust.ChannelProduction))
	if err != nil {
		t.Fatal(err)
	}
	if ids := prod.ReleaseIDs(); len(ids) != 0 {
		t.Fatalf("production lists %v before a promotion", ids)
	}
	res, err := r.Promote("whombat-dev-20261118.1", trust.ChannelDevelopment, trust.ChannelProduction, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Targets) != 4 {
		t.Fatalf("promoted %v", res.Targets)
	}
	prod, err = trust.Refresh(channelCfg(r, t.TempDir(), c, trust.ChannelProduction))
	if err != nil {
		t.Fatal(err)
	}
	prel, err := prod.Release("whombat-dev-20261118.1")
	if err != nil {
		t.Fatal(err)
	}
	if prel.Digest != rel.Digest || prel.RuntimeIndex.SHA256() != rel.RuntimeIndex.SHA256() || prel.RuntimeIndex.Remote != rel.RuntimeIndex.Remote {
		t.Fatalf("promotion changed the release: %+v vs %+v", prel.RuntimeIndex, rel.RuntimeIndex)
	}
	// The legacy view (no channel) still reads the top-level targets.
	top, err := trust.Refresh(cfg(r, t.TempDir(), c.t))
	if err != nil {
		t.Fatal(err)
	}
	if ids := top.ReleaseIDs(); len(ids) != 1 || ids[0] != "rt-1" {
		t.Fatalf("top-level ids %v", ids)
	}
	// Promoting again changes nothing.
	if res, err := r.Promote("whombat-dev-20261118.1", trust.ChannelDevelopment, trust.ChannelProduction, nil); err != nil || !res.Already {
		t.Fatalf("again: %+v %v", res, err)
	}
}

// A repository without the channel's role fails the refresh plainly.
func TestChannelMissingRole(t *testing.T) {
	c := &clock{t0}
	r := newRepo(t, c)
	_, err := trust.Refresh(channelCfg(r, t.TempDir(), c, trust.ChannelProduction))
	if !errors.Is(err, trust.ErrChannelUnavailable) {
		t.Fatalf("want ErrChannelUnavailable, got %v", err)
	}
	if _, err := trust.Refresh(channelCfg(r, t.TempDir(), c, "beta")); err == nil {
		t.Fatal("an unknown channel was accepted")
	}
}

// A channel key approves nothing outside its prefix: a development-signed target for production, or a top-level
// path, is ignored.
func TestChannelRoleCannotSignOutsideItsPrefix(t *testing.T) {
	c := &clock{t0}
	r := newChannelRepo(t, c)
	if err := r.InChannel(trust.ChannelDevelopment); err != nil {
		t.Fatal(err)
	}
	if _, err := r.AddFakeRelease(devtuf.StandardRelease("whombat-dev-20261118.2", "26.06.1", "2.0.0")); err != nil {
		t.Fatal(err)
	}
	// Move the tuple target to production/… inside the development role: outside its delegation.
	tp, err := r.TargetFilePath("releases/whombat-dev-20261118.2.json")
	if err != nil || !strings.Contains(filepath.ToSlash(tp), "development/releases/") {
		t.Fatalf("target file %q %v", tp, err)
	}
	if err := r.MoveChannelTargetUnchecked(trust.ChannelDevelopment, "development/releases/whombat-dev-20261118.2.json", "production/releases/whombat-dev-20261118.2.json"); err != nil {
		t.Fatal(err)
	}
	if err := r.Publish(); err != nil {
		t.Fatal(err)
	}
	r.InChannel("")
	for _, ch := range trust.Channels {
		repo, err := trust.Refresh(channelCfg(r, t.TempDir(), c, ch))
		if err != nil {
			t.Fatal(err)
		}
		if ids := repo.ReleaseIDs(); len(ids) != 0 {
			t.Fatalf("%s lists %v signed outside the development prefix", ch, ids)
		}
	}
}

// Newest in the channel (LNK-20): among the channel's releases only, forward only.
func TestNewestInChannel(t *testing.T) {
	c := &clock{t0}
	r := newChannelRepo(t, c)
	addIn(t, r, trust.ChannelDevelopment, devtuf.StandardRelease("whombat-dev-20261118.1", "26.06.1", "2.0.0"))
	addIn(t, r, trust.ChannelDevelopment, devtuf.StandardRelease("whombat-dev-20261118.2", "26.06.2", "2.1.0"))
	if _, err := r.Promote("whombat-dev-20261118.1", trust.ChannelDevelopment, trust.ChannelProduction, nil); err != nil {
		t.Fatal(err)
	}
	newest := func(ch string, cur *trust.Release) string {
		t.Helper()
		repo, err := trust.Refresh(channelCfg(r, t.TempDir(), c, ch))
		if err != nil {
			t.Fatal(err)
		}
		var got *trust.Release
		if cur == nil {
			got, err = repo.NewestRelease("", nil, "")
		} else {
			v := cur.VersionsOf()
			got, err = repo.NewestRelease(cur.ID(), &v, cur.Digest)
		}
		if err != nil {
			t.Fatal(err)
		}
		if got == nil {
			return ""
		}
		return got.ID()
	}
	devRepo, err := trust.Refresh(channelCfg(r, t.TempDir(), c, trust.ChannelDevelopment))
	if err != nil {
		t.Fatal(err)
	}
	two, err := devRepo.Release("whombat-dev-20261118.2")
	if err != nil {
		t.Fatal(err)
	}
	if got := newest(trust.ChannelDevelopment, nil); got != "whombat-dev-20261118.2" {
		t.Fatalf("development newest %q", got)
	}
	if got := newest(trust.ChannelProduction, nil); got != "whombat-dev-20261118.1" {
		t.Fatalf("production newest %q", got)
	}
	// Development → Production never downgrades: a box on .2 stays until production passes it.
	if got := newest(trust.ChannelProduction, two); got != "" {
		t.Fatalf("a development box moved to production went back to %q", got)
	}
}

// The cache keeps a channel's role between refreshes (its `_type` is "targets", like every delegated role's): a
// refresh whose snapshot names the same version reads it from the cache, not the mirror.
func TestChannelRoleCached(t *testing.T) {
	c := &clock{t0}
	r := newChannelRepo(t, c)
	addIn(t, r, trust.ChannelDevelopment, devtuf.StandardRelease("whombat-dev-20261118.1", "26.06.1", "2.0.0"))
	cache := t.TempDir()
	if _, err := trust.Refresh(channelCfg(r, cache, c, trust.ChannelDevelopment)); err != nil {
		t.Fatal(err)
	}
	files, _ := filepath.Glob(filepath.Join(r.MetadataDir(), "*.development.json"))
	for _, f := range files {
		if err := os.Rename(f, f+".away"); err != nil {
			t.Fatal(err)
		}
	}
	dev, err := trust.Refresh(channelCfg(r, cache, c, trust.ChannelDevelopment))
	if err != nil || len(dev.ReleaseIDs()) != 1 {
		t.Fatalf("a second refresh without the role on the mirror: %v", err)
	}
	// A torn cached role is dropped and fetched again.
	for _, f := range files {
		_ = os.Rename(f+".away", f)
	}
	if err := os.WriteFile(filepath.Join(cache, "development.json"), []byte(`{"signed":`), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := trust.Refresh(channelCfg(r, cache, c, trust.ChannelDevelopment)); err != nil {
		t.Fatalf("after a torn cached role: %v", err)
	}
}

func resignRole[T metadata.Roles](t *testing.T, md *metadata.Metadata[T], key ed25519.PrivateKey) {
	t.Helper()
	s, err := signature.LoadSigner(key, crypto.Hash(0))
	if err != nil {
		t.Fatal(err)
	}
	md.ClearSignatures()
	if _, err := md.Sign(s); err != nil {
		t.Fatal(err)
	}
}

// copyDir copies one flat metadata or cache directory so a test can mutate a copy without touching the repository.
func copyFlatDir(t *testing.T, src string) string {
	t.Helper()
	dst := t.TempDir()
	if err := os.CopyFS(dst, os.DirFS(src)); err != nil {
		t.Fatal(err)
	}
	return dst
}

// writeSnapshotAndTimestamp re-signs snapshot and timestamp over the updated channel version in dir.
func writeSnapshotAndTimestamp(t *testing.T, dir string, snapKey, tsKey ed25519.PrivateKey, channel string, chVersion int64) {
	t.Helper()
	ts, err := metadata.Timestamp().FromFile(filepath.Join(dir, "timestamp.json"))
	if err != nil {
		t.Fatal(err)
	}
	sv := ts.Signed.Meta["snapshot.json"].Version
	snap, err := metadata.Snapshot().FromFile(filepath.Join(dir, fmt.Sprintf("%d.snapshot.json", sv)))
	if err != nil {
		t.Fatal(err)
	}
	snap.Signed.Version = sv + 1
	snap.Signed.Meta[channel+".json"] = metadata.MetaFile(chVersion)
	resignRole(t, snap, snapKey)
	snapPath := filepath.Join(dir, fmt.Sprintf("%d.snapshot.json", sv+1))
	if err := snap.ToFile(snapPath, true); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(snapPath)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(b)
	mf := metadata.MetaFile(sv + 1)
	mf.Length, mf.Hashes = int64(len(b)), metadata.Hashes{"sha256": sum[:]}
	ts.Signed.Version++
	ts.Signed.Meta["snapshot.json"] = mf
	resignRole(t, ts, tsKey)
	if err := ts.ToFile(filepath.Join(dir, "timestamp.json"), true); err != nil {
		t.Fatal(err)
	}
}

func TestChannelPauseResumeExpiryAndWrongKey(t *testing.T) {
	c := &clock{t0}
	r := newChannelRepo(t, c)
	addIn(t, r, trust.ChannelDevelopment, devtuf.StandardRelease("whombat-20261121.1", "26.06.1", "2.0.0"))
	addIn(t, r, trust.ChannelDevelopment, devtuf.StandardRelease("whombat-20261121.2", "26.06.2", "2.1.0"))
	if _, err := r.Promote("whombat-20261121.1", trust.ChannelDevelopment, trust.ChannelProduction, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := r.Promote("whombat-20261121.2", trust.ChannelDevelopment, trust.ChannelProduction, nil); err != nil {
		t.Fatal(err)
	}

	prodCache := t.TempDir()
	prod, err := trust.Refresh(channelCfg(r, prodCache, c, trust.ChannelProduction))
	if err != nil {
		t.Fatal(err)
	}
	if prod.ChannelPaused {
		t.Fatal("fresh channel reported paused")
	}
	if got, err := prod.NewestRelease("", nil, ""); err != nil || got == nil || got.ID() != "whombat-20261121.2" {
		t.Fatalf("newest before pause: %+v %v", got, err)
	}

	// Pause production: NewestRelease returns nil, releases stay listed for rollback, development stays unpaused.
	res, err := r.PauseChannel(trust.ChannelProduction, nil)
	if err != nil || !res.Paused || res.Already {
		t.Fatalf("pause: %+v %v", res, err)
	}
	prod, err = trust.Refresh(channelCfg(r, prodCache, c, trust.ChannelProduction))
	if err != nil {
		t.Fatal(err)
	}
	if !prod.ChannelPaused {
		t.Fatal("paused channel did not set ChannelPaused")
	}
	if got, err := prod.NewestRelease("", nil, ""); err != nil || got != nil {
		t.Fatalf("paused channel offered %+v %v", got, err)
	}
	if got, err := prod.NewestListedRelease("", nil, ""); err != nil || got == nil || got.ID() != "whombat-20261121.2" {
		t.Fatalf("paused channel newest listed: %+v %v", got, err)
	}
	if _, err := prod.Release("whombat-20261121.1"); err != nil {
		t.Fatalf("paused channel hid previous release for rollback: %v", err)
	}
	dev, err := trust.Refresh(channelCfg(r, t.TempDir(), c, trust.ChannelDevelopment))
	if err != nil || dev.ChannelPaused {
		t.Fatalf("pausing production affected development: paused=%v err=%v", dev != nil && dev.ChannelPaused, err)
	}

	// Resume production: NewestRelease works again and unpaused metadata omits the whombat marker.
	rres, err := r.ResumeChannel(trust.ChannelProduction, nil)
	if err != nil || rres.Paused || rres.Already {
		t.Fatalf("resume: %+v %v", rres, err)
	}
	raw, err := os.ReadFile(filepath.Join(r.MetadataDir(), fmt.Sprintf("%d.production.json", rres.Version)))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), `"paused"`) {
		t.Fatalf("resumed production role still carries paused marker: %s", raw)
	}
	prod, err = trust.Refresh(channelCfg(r, prodCache, c, trust.ChannelProduction))
	if err != nil || prod.ChannelPaused {
		t.Fatalf("after resume: paused=%v err=%v", prod != nil && prod.ChannelPaused, err)
	}
	if got, err := prod.NewestRelease("", nil, ""); err != nil || got == nil || got.ID() != "whombat-20261121.2" {
		t.Fatalf("newest after resume: %+v %v", got, err)
	}

	// Wrong key: a pause on production signed with the development key or an unknown key is rejected.
	snapKey, err := devtuf.ReadKeyFile(filepath.Join(r.Dir, "keys", "snapshot-0.json"), "snapshot")
	if err != nil {
		t.Fatal(err)
	}
	tsKey, err := devtuf.ReadKeyFile(filepath.Join(r.Dir, "keys", "timestamp-0.json"), "timestamp")
	if err != nil {
		t.Fatal(err)
	}
	_, foreignKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	for name, badKey := range map[string]ed25519.PrivateKey{
		"development key": r.ChannelKey(trust.ChannelDevelopment),
		"unknown key":     foreignKey,
	} {
		dir := copyFlatDir(t, r.MetadataDir())
		v := r.RoleVersions()[trust.ChannelProduction]
		md, err := metadata.Targets().FromFile(filepath.Join(dir, fmt.Sprintf("%d.production.json", v)))
		if err != nil {
			t.Fatal(err)
		}
		md.Signed.Version = v + 1
		trust.SetChannelPaused(md, true)
		resignRole(t, md, badKey)
		if err := md.ToFile(filepath.Join(dir, fmt.Sprintf("%d.production.json", v+1)), true); err != nil {
			t.Fatal(err)
		}
		writeSnapshotAndTimestamp(t, dir, snapKey, tsKey, trust.ChannelProduction, v+1)
		badCfg := trust.Config{
			PinnedRoot: r.InitialRoot(), MetadataDir: copyFlatDir(t, prodCache), MetadataURL: "m://x",
			Fetcher: trust.DirFetcher{BaseURL: "m://x", Dir: dir}, Now: c.t, Channel: trust.ChannelProduction,
		}
		if _, err := trust.Refresh(badCfg); !errors.Is(err, trust.ErrSignature) {
			t.Fatalf("%s: want ErrSignature, got %v", name, err)
		}
	}

	// Expired pause metadata: rejected with ErrExpired.
	expDir := copyFlatDir(t, r.MetadataDir())
	v := r.RoleVersions()[trust.ChannelProduction]
	md, err := metadata.Targets().FromFile(filepath.Join(expDir, fmt.Sprintf("%d.production.json", v)))
	if err != nil {
		t.Fatal(err)
	}
	md.Signed.Version = v + 1
	md.Signed.Expires = c.t.Add(-time.Hour)
	trust.SetChannelPaused(md, true)
	resignRole(t, md, r.ChannelKey(trust.ChannelProduction))
	if err := md.ToFile(filepath.Join(expDir, fmt.Sprintf("%d.production.json", v+1)), true); err != nil {
		t.Fatal(err)
	}
	writeSnapshotAndTimestamp(t, expDir, snapKey, tsKey, trust.ChannelProduction, v+1)
	expCfg := trust.Config{
		PinnedRoot: r.InitialRoot(), MetadataDir: copyFlatDir(t, prodCache), MetadataURL: "m://x",
		Fetcher: trust.DirFetcher{BaseURL: "m://x", Dir: expDir}, Now: c.t, Channel: trust.ChannelProduction,
	}
	if _, err := trust.Refresh(expCfg); !errors.Is(err, trust.ErrExpired) {
		t.Fatalf("expired pause metadata: want ErrExpired, got %v", err)
	}
}
