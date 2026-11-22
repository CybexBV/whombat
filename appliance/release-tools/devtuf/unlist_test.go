package devtuf_test

import (
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/helper/pkg/trust"
	"github.com/CybexBV/whombat/appliance/release-tools/devtuf"
)

// Unlisting takes old releases out of a channel and only what they alone need: a box of the channel no longer sees
// them, still sees the kept one whole, and the files the repository names on GitHub shrink to the kept ones'.
func TestUnlistKeepsWhatTheKeptReleaseNeeds(t *testing.T) {
	now := time.Date(2026, 11, 22, 12, 0, 0, 0, time.UTC)
	r, err := devtuf.New(filepath.Join(t.TempDir(), "repo"), devtuf.Options{Env: "local", Layout: devtuf.LayoutGitHub, Now: func() time.Time { return now }})
	if err != nil {
		t.Fatal(err)
	}
	if err := r.AddChannelRoles(nil, nil); err != nil {
		t.Fatal(err)
	}
	pinned := r.InitialRoot()
	r.InChannel(trust.ChannelDevelopment)
	for _, f := range []devtuf.FakeRelease{
		devtuf.StandardRelease("whombat-20261120.5", "26.05.1", "1.0.0"),
		devtuf.StandardRelease("whombat-20261121.8", "26.05.1", "1.1.0"),
		devtuf.StandardRelease("whombat-20261122.2", "26.05.2", "1.1.0"),
	} {
		if _, err := r.AddFakeRelease(f); err != nil {
			t.Fatal(err)
		}
		if err := r.Publish(); err != nil {
			t.Fatal(err)
		}
	}
	r.InChannel("")
	for _, id := range []string{"whombat-20261120.5", "whombat-20261122.2"} {
		if _, err := r.Promote(id, trust.ChannelDevelopment, trust.ChannelProduction, nil); err != nil {
			t.Fatal(err)
		}
	}
	before, err := r.ListedFiles()
	if err != nil {
		t.Fatal(err)
	}

	// The newest must stay: a keep list without it is refused and changes nothing.
	if _, err := r.Unlist(trust.ChannelDevelopment, []string{"whombat-20261121.8"}); !errors.Is(err, devtuf.ErrUnlistNewest) {
		t.Fatalf("unlisting the newest: %v", err)
	}
	keep := []string{"whombat-20261122.2"}
	dev, err := r.Unlist(trust.ChannelDevelopment, keep)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(dev.Kept, ",") != "whombat-20261122.2" || strings.Join(dev.Unlisted, ",") != "whombat-20261120.5,whombat-20261121.8" {
		t.Fatalf("development: %+v", dev)
	}
	// The runtime 1.1.0 index is the kept release's too: it stays; the two old tuples and the indexes only they use go.
	gone := strings.Join(dev.Targets, " ")
	for _, want := range []string{"development/releases/whombat-20261120.5.json", "development/releases/whombat-20261121.8.json",
		"development/runtime/1.0.0/", "development/host/26.05.1/"} {
		if !strings.Contains(gone, want) {
			t.Fatalf("%s not taken out: %v", want, dev.Targets)
		}
	}
	if strings.Contains(gone, "runtime/1.1.0/") || strings.Contains(gone, "whombat-20261122.2") {
		t.Fatalf("took out what the kept release needs: %v", dev.Targets)
	}
	prod, err := r.Unlist(trust.ChannelProduction, keep)
	if err != nil || strings.Join(prod.Unlisted, ",") != "whombat-20261120.5" {
		t.Fatalf("production: %+v %v", prod, err)
	}
	for _, ch := range []string{trust.ChannelDevelopment, trust.ChannelProduction} {
		if err := r.PublishChannelWith(ch, nil); err != nil {
			t.Fatal(err)
		}
	}
	// Again: nothing more to take out.
	if again, err := r.Unlist(trust.ChannelDevelopment, keep); err != nil || len(again.Targets) != 0 || len(again.Unlisted) != 0 {
		t.Fatalf("again: %+v %v", again, err)
	}

	// A box of either channel sees the kept release, whole, and not the old ones.
	meta := filepath.Join(r.Dir, "metadata")
	for _, ch := range []string{trust.ChannelDevelopment, trust.ChannelProduction} {
		box, err := refresh(t, pinned, meta, t.TempDir(), ch, now)
		if err != nil {
			t.Fatalf("%s: %v", ch, err)
		}
		if _, err := box.Release("whombat-20261122.2"); err != nil {
			t.Fatalf("%s: the kept release: %v", ch, err)
		}
		if _, err := box.Release("whombat-20261120.5"); !errors.Is(err, trust.ErrNotApproved) {
			t.Fatalf("%s: an unlisted release still resolves: %v", ch, err)
		}
	}

	after, err := r.ListedFiles()
	if err != nil {
		t.Fatal(err)
	}
	had := map[string]bool{}
	for _, f := range before {
		had[f.Tag+"/"+f.Name] = true
	}
	for _, f := range after {
		if !had[f.Tag+"/"+f.Name] {
			t.Fatalf("%s/%s is new", f.Tag, f.Name)
		}
		if f.Tag != "whombat-20261122.2" && !strings.HasPrefix(f.Tag, "nar-") {
			t.Fatalf("an unlisted release's file is still named: %s/%s", f.Tag, f.Name)
		}
	}
	if len(after) >= len(before) {
		t.Fatalf("listed files %d, before %d", len(after), len(before))
	}
	if !devtuf.IsReleaseTag("whombat-dev-20261119.2") || devtuf.IsReleaseTag("nar-0a") || devtuf.IsReleaseTag("clients") {
		t.Fatal("IsReleaseTag")
	}
}
