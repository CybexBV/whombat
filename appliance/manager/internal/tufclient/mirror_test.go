package tufclient_test

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/helper/pkg/trust"
	"github.com/CybexBV/whombat/appliance/manager/internal/tufclient"
	"github.com/CybexBV/whombat/appliance/release-tools/devtuf"
)

// Regression (integration harness, update slice): after a refused refresh (forged targets) the repository
// is repaired and a new timestamp is published. The manager's next refresh succeeds without downloading
// the snapshot again (go-tuf trusts its cached copy), and the mirror used to lack N.snapshot.json: the
// helper then failed with metadata_stale forever. Every successful refresh now writes the whole set.
func TestMirrorCompleteAfterRefusedRefresh(t *testing.T) {
	now := time.Date(2026, 9, 25, 12, 0, 0, 0, time.UTC)
	clock := func() time.Time { return now }
	d := t.TempDir()
	repo, err := devtuf.New(filepath.Join(d, "repo"), devtuf.Options{Now: clock})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := repo.AddFakeRelease(devtuf.StandardRelease("rt-1", "26.05.1", "1.0.0")); err != nil {
		t.Fatal(err)
	}
	if err := repo.Publish(); err != nil {
		t.Fatal(err)
	}
	pinned := filepath.Join(d, "root.json")
	os.WriteFile(pinned, repo.InitialRoot(), 0o644)
	c := &tufclient.Client{PinnedRootPath: pinned, CacheDir: filepath.Join(d, "cache"), MirrorDir: filepath.Join(d, "mirror"),
		MetadataURL: "file://repo/metadata", Fetcher: trust.DirFetcher{BaseURL: "file://repo/metadata", Dir: repo.MetadataDir()}, Now: clock}
	if _, err := c.Refresh(context.Background()); err != nil {
		t.Fatal(err)
	}
	helperCache := filepath.Join(d, "helper-tuf")
	helper := func() error {
		_, err := trust.Refresh(trust.Config{PinnedRoot: repo.InitialRoot(), MetadataDir: helperCache, MetadataURL: "mirror://x",
			Fetcher: trust.DirFetcher{BaseURL: "mirror://x", Dir: c.MirrorDir}, Now: now})
		return err
	}
	if err := helper(); err != nil {
		t.Fatalf("helper before: %v", err)
	}

	// A new release; its targets file is forged in transit.
	if _, err := repo.AddFakeRelease(devtuf.StandardRelease("rt-2", "26.05.1", "1.1.0")); err != nil {
		t.Fatal(err)
	}
	if err := repo.Publish(); err != nil {
		t.Fatal(err)
	}
	tv := repo.Versions()["targets"]
	tf := filepath.Join(repo.MetadataDir(), fmt.Sprintf("%d.targets.json", tv))
	genuine, _ := os.ReadFile(tf)
	os.WriteFile(tf, bytes.Replace(genuine, []byte(`"rt-2"`), []byte(`"rt-X"`), 1), 0o644)
	if _, err := c.Refresh(context.Background()); err == nil {
		t.Fatal("forged targets accepted")
	}
	// Repaired, and a new timestamp for the same snapshot.
	os.WriteFile(tf, genuine, 0o644)
	if err := repo.PublishTimestamp(); err != nil {
		t.Fatal(err)
	}
	r, err := c.Refresh(context.Background())
	if err != nil {
		t.Fatalf("refresh after repair: %v", err)
	}
	if _, err := os.Stat(filepath.Join(c.MirrorDir, fmt.Sprintf("%d.snapshot.json", r.SnapshotVersion))); err != nil {
		t.Fatalf("mirror incomplete: %v", err)
	}
	if err := helper(); err != nil {
		t.Fatalf("helper after repair: %v", err)
	}
}

// The mirror carries the verified channel roles (LNK-23): the helper resolves its channel from it, also the other
// channel right after the owner changed it.
func TestMirrorCarriesChannelRoles(t *testing.T) {
	now := time.Date(2026, 9, 25, 12, 0, 0, 0, time.UTC)
	clock := func() time.Time { return now }
	d := t.TempDir()
	repo, err := devtuf.New(filepath.Join(d, "repo"), devtuf.Options{Now: clock})
	if err != nil {
		t.Fatal(err)
	}
	if err := repo.AddChannelRoles(nil, nil); err != nil {
		t.Fatal(err)
	}
	if err := repo.InChannel(trust.ChannelDevelopment); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.AddFakeRelease(devtuf.StandardRelease("whombat-dev-20261118.1", "26.05.1", "1.0.0")); err != nil {
		t.Fatal(err)
	}
	if err := repo.Publish(); err != nil {
		t.Fatal(err)
	}
	pinned := filepath.Join(d, "root.json")
	os.WriteFile(pinned, repo.InitialRoot(), 0o644)
	channel := trust.ChannelProduction
	c := &tufclient.Client{PinnedRootPath: pinned, CacheDir: filepath.Join(d, "cache"), MirrorDir: filepath.Join(d, "mirror"),
		MetadataURL: "file://repo/metadata", Fetcher: trust.DirFetcher{BaseURL: "file://repo/metadata", Dir: repo.MetadataDir()}, Now: clock,
		Channel: func() string { return channel }}
	got, err := c.Refresh(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if got.Channel != trust.ChannelProduction || len(got.ReleaseIDs()) != 0 {
		t.Fatalf("manager view %q %v", got.Channel, got.ReleaseIDs())
	}
	for _, f := range []string{"2.development.json", "1.production.json"} {
		if _, err := os.Stat(filepath.Join(c.MirrorDir, f)); err != nil {
			t.Fatalf("mirror lacks %s: %v", f, err)
		}
	}
	helper := func(ch string) *trust.Repo {
		t.Helper()
		r, err := trust.Refresh(trust.Config{PinnedRoot: repo.InitialRoot(), MetadataDir: filepath.Join(d, "helper-"+ch), MetadataURL: "mirror://x",
			Fetcher: trust.DirFetcher{BaseURL: "mirror://x", Dir: c.MirrorDir}, Now: now, Channel: ch})
		if err != nil {
			t.Fatalf("helper %s: %v", ch, err)
		}
		return r
	}
	if ids := helper(trust.ChannelDevelopment).ReleaseIDs(); len(ids) != 1 {
		t.Fatalf("helper's development view %v", ids)
	}
	if ids := helper(trust.ChannelProduction).ReleaseIDs(); len(ids) != 0 {
		t.Fatalf("helper's production view %v", ids)
	}
	// Without a channel (an image before channels) the view is the top-level targets again.
	channel = ""
	if got, err = c.Refresh(context.Background()); err != nil || got.Channel != "" {
		t.Fatalf("top-level view: %v %q", err, got.Channel)
	}
}
