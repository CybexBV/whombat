package trust_test

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/CybexBV/whombat/appliance/helper/pkg/trust"
	"github.com/CybexBV/whombat/appliance/release-tools/devtuf"
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
