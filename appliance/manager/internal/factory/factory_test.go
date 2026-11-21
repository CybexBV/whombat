package factory_test

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/helper/helpertest"
	"github.com/CybexBV/whombat/appliance/helper/pkg/trust"
	"github.com/CybexBV/whombat/appliance/manager/internal/factory"
	"github.com/CybexBV/whombat/appliance/manager/internal/helperclient"
	"github.com/CybexBV/whombat/appliance/manager/internal/tufclient"
	"github.com/CybexBV/whombat/appliance/manager/internal/updatechannel"
	"github.com/CybexBV/whombat/appliance/release-tools/devtuf"
)

const (
	beta = "whombat-20261120.15" // listed in development only (a Beta installer)
	prod = "whombat-20261120.5"  // promoted: listed in both channels
)

var now = time.Date(2026, 11, 20, 12, 0, 0, 0, time.UTC)

type box struct {
	repo   *devtuf.Repo
	tuf    *tufclient.Client
	helper *helpertest.Helper
	ch     *updatechannel.Service
	dir    string
}

// newBox is a fresh box of the one image (default channel production, MG-182) before its first start, and the
// repository it reads: prod promoted to production, beta in development only.
func newBox(t *testing.T, booted string) *box {
	t.Helper()
	clock := func() time.Time { return now }
	d := t.TempDir()
	repo, err := devtuf.New(filepath.Join(d, "repo"), devtuf.Options{Now: clock})
	must(t, err)
	must(t, repo.AddChannelRoles(nil, nil))
	must(t, repo.InChannel(trust.ChannelDevelopment))
	for _, r := range []devtuf.FakeRelease{devtuf.StandardRelease(prod, "26.05.1", "1.0.0"), devtuf.StandardRelease(beta, "26.05.1", "1.1.0")} {
		_, err := repo.AddFakeRelease(r)
		must(t, err)
	}
	must(t, repo.Publish())
	_, err = repo.Promote(prod, trust.ChannelDevelopment, trust.ChannelProduction, nil)
	must(t, err)
	pinned := filepath.Join(d, "pinned-root.json")
	must(t, os.WriteFile(pinned, repo.InitialRoot(), 0o644))
	// Unix socket paths are limited to 108 bytes: a short runtime directory, as the test world's.
	sockBase := os.Getenv("XDG_RUNTIME_DIR")
	if sockBase == "" {
		sockBase = "/tmp"
	}
	sockDir, err := os.MkdirTemp(sockBase, "wbf")
	must(t, err)
	t.Cleanup(func() { os.RemoveAll(sockDir) })
	b := &box{repo: repo, dir: d}
	h, err := helpertest.Start(helpertest.Config{DeviceID: "dev-1", Env: "dev", DefaultChannel: trust.ChannelProduction, PinnedRootPath: pinned,
		MirrorDir: filepath.Join(d, "mirror"), StagingDir: filepath.Join(d, "staging"), AssignmentPath: filepath.Join(d, "assignment.json"),
		NetworkCandidatesDir: filepath.Join(d, "netcands"), StateDir: filepath.Join(d, "helper"), FakeRoot: filepath.Join(d, "fake"),
		FakeDBDir: filepath.Join(d, "db"), BootedSystem: booted, Socket: filepath.Join(sockDir, "helper.sock"), ManagerUID: uint32(os.Getuid()), Now: clock})
	must(t, err)
	t.Cleanup(h.Stop)
	b.helper = h
	b.ch = &updatechannel.Service{Helper: helperclient.Client{Socket: h.Socket}}
	b.tuf = &tufclient.Client{PinnedRootPath: pinned, CacheDir: filepath.Join(d, "cache"), MirrorDir: filepath.Join(d, "mirror"),
		MetadataURL: "file://repo/metadata", Fetcher: trust.DirFetcher{BaseURL: "file://repo/metadata", Dir: repo.MetadataDir()}, Now: clock,
		Channel: b.ch.Current}
	return b
}

func (b *box) finder(follows *[]string) factory.Finder {
	return factory.Finder{TUF: b.tuf, Follow: func(ctx context.Context, ch string) error {
		*follows = append(*follows, ch)
		_, err := b.ch.Set(ctx, ch)
		return err
	}}
}

// The host store path a fake release's tuple names (the booted system the helper checks at seed-factory).
func hostOf(t *testing.T, id string) string {
	t.Helper()
	b := newBox(t, "")
	r, err := b.tuf.RefreshIn(context.Background(), trust.ChannelDevelopment)
	must(t, err)
	rel, err := r.Release(id)
	must(t, err)
	return rel.Tuple.Host.StorePath
}

// A Beta installer's box: its release only in development. It follows development, and the helper then verifies the
// release there (seed-factory) as on a real first start.
func TestBetaOnlyReleaseFollowsDevelopment(t *testing.T) {
	b := newBox(t, hostOf(t, beta))
	var follows []string
	got, err := b.finder(&follows).Find(context.Background(), beta)
	if err != nil {
		t.Fatal(err)
	}
	if got.Release.Tuple.ReleaseID != beta || got.Channel != trust.ChannelDevelopment || !got.Moved {
		t.Fatalf("found %+v", got)
	}
	if len(follows) != 1 || follows[0] != trust.ChannelDevelopment {
		t.Fatalf("follows %v", follows)
	}
	if ch, err := b.ch.Load(context.Background()); err != nil || ch != trust.ChannelDevelopment {
		t.Fatalf("the helper's channel %q %v", ch, err)
	}
	if l := b.tuf.Latest(); l == nil || l.Channel != trust.ChannelDevelopment {
		t.Fatalf("the manager's last view isn't development's: %+v", l)
	}
	if err := b.helper.SeedFactory(beta); err != nil {
		t.Fatalf("seed-factory after the move: %v", err)
	}
}

// Before the fix the helper refused it: the default channel doesn't list the release.
func TestBetaOnlyReleaseRefusedInProduction(t *testing.T) {
	b := newBox(t, hostOf(t, beta))
	if err := b.helper.SeedFactory(beta); err == nil {
		t.Fatal("the production channel verified a release only development lists")
	}
}

// A Production installer's box stays on production, whatever development lists too.
func TestPromotedReleaseStaysOnProduction(t *testing.T) {
	b := newBox(t, hostOf(t, prod))
	var follows []string
	got, err := b.finder(&follows).Find(context.Background(), prod)
	if err != nil {
		t.Fatal(err)
	}
	if got.Channel != trust.ChannelProduction || got.Moved || len(follows) != 0 {
		t.Fatalf("found %+v, follows %v", got, follows)
	}
	if ch, err := b.ch.Load(context.Background()); err != nil || ch != trust.ChannelProduction {
		t.Fatalf("the helper's channel %q %v", ch, err)
	}
	if err := b.helper.SeedFactory(prod); err != nil {
		t.Fatal(err)
	}
}

// A release no channel lists: ErrNotListed, and the box's channel stays.
func TestUnlistedRelease(t *testing.T) {
	b := newBox(t, "")
	var follows []string
	_, err := b.finder(&follows).Find(context.Background(), "whombat-20261120.99")
	if !errors.Is(err, factory.ErrNotListed) {
		t.Fatalf("got %v", err)
	}
	if len(follows) != 0 {
		t.Fatalf("follows %v", follows)
	}
	if ch, _ := b.ch.Load(context.Background()); ch != trust.ChannelProduction {
		t.Fatalf("the helper's channel %q", ch)
	}
}

// The repository out of reach: ErrUnreachable, not "not listed" (the screen says different things).
func TestUnreachableRepository(t *testing.T) {
	b := newBox(t, "")
	b.tuf.Fetcher = trust.DirFetcher{BaseURL: "file://repo/metadata", Dir: filepath.Join(b.dir, "nowhere")}
	var follows []string
	_, err := b.finder(&follows).Find(context.Background(), beta)
	if !errors.Is(err, factory.ErrUnreachable) || errors.Is(err, factory.ErrNotListed) {
		t.Fatalf("got %v", err)
	}
}

// A box without channels reads the top level only: a release it doesn't list isn't looked for in a channel.
func TestNoChannels(t *testing.T) {
	b := newBox(t, "")
	b.tuf.Channel = nil
	var follows []string
	_, err := b.finder(&follows).Find(context.Background(), beta)
	if !errors.Is(err, factory.ErrNotListed) || len(follows) != 0 {
		t.Fatalf("got %v, follows %v", err, follows)
	}
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}
