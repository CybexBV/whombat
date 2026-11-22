package ghpublish_test

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/helper/pkg/trust"
	"github.com/CybexBV/whombat/appliance/release-tools/ghpublish"
)

// deployPages puts the clone's metadata on the fake Pages site, as the workflow deploys it.
func deployPages(t *testing.T, e *env) {
	t.Helper()
	os.RemoveAll(e.gh.PagesDir)
	if err := os.MkdirAll(e.gh.PagesDir, 0o755); err != nil {
		t.Fatal(err)
	}
	src := filepath.Join(e.dir, "metadata")
	entries, err := os.ReadDir(src)
	if err != nil {
		t.Fatal(err)
	}
	for _, de := range entries {
		b, err := os.ReadFile(filepath.Join(src, de.Name()))
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(e.gh.PagesDir, de.Name()), b, 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

// Old releases leave GitHub only after their unlisting is on the site, never while another publish is unfinished, and
// only what no listed release needs: the kept releases' files stay whole, other GitHub releases are left alone.
func TestUnlistThenPrune(t *testing.T) {
	e := setup(t, 0)
	ids := []string{"whombat-20261120.5", "whombat-20261121.8", "whombat-20261122.1"}
	for i, id := range ids {
		if _, err := e.pub.Publish(e.ctx, trust.ChannelDevelopment, id, fakeRelease(id, "26.05.1", []string{"1.0.0", "1.1.0", "1.2.0"}[i], 0)); err != nil {
			t.Fatal(err)
		}
	}
	for _, id := range []string{ids[0], ids[2]} {
		if _, err := e.pub.Promote(e.ctx, id, nil); err != nil {
			t.Fatal(err)
		}
	}
	e.gh.PutAsset("clients", "c.json", []byte(`{"c":1}`))
	e.gh.PutAsset("notes", "n.txt", []byte("n"))

	// A publish stopped halfway (its blobs up, its role not pushed) holds a prune back: its blobs aren't listed yet.
	bad, _ := ghpublish.New(ghpublish.Config{Dir: e.dir, Owner: "CybexBV", Repo: "whombat-releases", APIURL: e.gh.APIURL, Token: "wrong",
		Backoff: time.Millisecond})
	next := "whombat-20261122.2"
	if _, err := bad.Publish(e.ctx, trust.ChannelDevelopment, next, fakeRelease(next, "26.05.2", "1.3.0", 0)); err == nil {
		t.Fatal("published with a bad token")
	}
	deployPages(t, e)
	if _, err := e.pub.Prune(e.ctx, ghpublish.PruneOptions{MetadataURL: e.gh.PagesURL, DryRun: true}); err == nil || !strings.Contains(err.Error(), "didn't finish") {
		t.Fatalf("pruned beside an unfinished publish: %v", err)
	}
	if _, err := e.pub.Publish(e.ctx, trust.ChannelDevelopment, next, nil); err != nil {
		t.Fatal(err)
	}

	keep := []string{ids[2], next}
	if _, _, err := e.pub.Unlist(e.ctx, trust.ChannelDevelopment, []string{ids[2]}, nil); err == nil {
		t.Fatal("unlisted development's newest")
	}
	deployPages(t, e)
	for _, ch := range []string{trust.ChannelDevelopment, trust.ChannelProduction} {
		res, u, err := e.pub.Unlist(e.ctx, ch, keep, nil)
		if err != nil || !res.MetadataPushed || u == nil || len(u.Unlisted) == 0 || u.Version == 0 {
			t.Fatalf("%s: %+v %+v %v", ch, res, u, err)
		}
	}
	remote := loadRemoteClone(t, e)
	if got := releaseIDs(t, remote, trust.ChannelDevelopment); !slices.Equal(got, keep) {
		t.Fatalf("development lists %v", got)
	}
	if got := releaseIDs(t, remote, trust.ChannelProduction); !slices.Equal(got, []string{ids[2]}) {
		t.Fatalf("production lists %v", got)
	}
	// Once more: nothing to sign or push.
	if res, _, err := e.pub.Unlist(e.ctx, trust.ChannelDevelopment, keep, nil); err != nil || res.MetadataPushed {
		t.Fatalf("again: %+v %v", res, err)
	}

	// The site still serves the old roles: nothing is deleted.
	if _, err := e.pub.Prune(e.ctx, ghpublish.PruneOptions{MetadataURL: e.gh.PagesURL}); err == nil || !strings.Contains(err.Error(), "wait until the site serves it") {
		t.Fatalf("pruned before the site served the unlisting: %v", err)
	}
	deployPages(t, e)
	tags := e.gh.Tags()
	plan, err := e.pub.Prune(e.ctx, ghpublish.PruneOptions{MetadataURL: e.gh.PagesURL, DryRun: true})
	if err != nil {
		t.Fatal(err)
	}
	var gone []string
	for _, r := range plan.Releases {
		gone = append(gone, r.Tag)
	}
	if !slices.Equal(gone, ids[:2]) || len(plan.Blobs) == 0 || plan.Deleted || !slices.Equal(plan.LeftAlone, []string{"clients", "notes"}) {
		t.Fatalf("plan: releases %v, %d blobs, left alone %v, deleted %v", gone, len(plan.Blobs), plan.LeftAlone, plan.Deleted)
	}
	if !slices.Equal(e.gh.Tags(), tags) {
		t.Fatal("a dry run deleted something")
	}

	done, err := e.pub.Prune(e.ctx, ghpublish.PruneOptions{MetadataURL: e.gh.PagesURL})
	if err != nil || !done.Deleted {
		t.Fatalf("prune: %+v %v", done, err)
	}
	for _, id := range ids[:2] {
		if e.gh.Release(id) != nil || slices.Contains(e.gh.GitTags(), id) {
			t.Fatalf("%s is still on GitHub", id)
		}
	}
	for _, tag := range []string{ids[2], next, "clients", "notes"} {
		if e.gh.Release(tag) == nil {
			t.Fatalf("%s was deleted", tag)
		}
	}
	// Everything the listed releases need is still there whole (Prune verifies it before deleting): a second run
	// finds nothing more to delete.
	again, err := e.pub.Prune(e.ctx, ghpublish.PruneOptions{MetadataURL: e.gh.PagesURL})
	if err != nil || len(again.Releases) != 0 || len(again.Blobs) != 0 {
		t.Fatalf("again: %+v %v", again, err)
	}
	files, err := e.pub.BootstrapFiles()
	if err != nil {
		t.Fatal(err)
	}
	if err := e.pub.Verify(e.ctx, files); err != nil {
		t.Fatal(err)
	}
}
