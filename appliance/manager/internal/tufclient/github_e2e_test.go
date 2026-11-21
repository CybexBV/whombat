package tufclient_test

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/helper/pkg/trust"
	"github.com/CybexBV/whombat/appliance/manager/internal/tufclient"
	"github.com/CybexBV/whombat/appliance/release-tools/devtuf"
	"github.com/CybexBV/whombat/appliance/release-tools/fakegithub"
	"github.com/CybexBV/whombat/appliance/release-tools/ghpublish"
)

func git(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_SYSTEM=/dev/null")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
}

// workflow plays the whombat-releases workflow: a fresh clone, snapshot and timestamp signed, committed, pushed,
// metadata/ deployed to Pages.
func workflow(t *testing.T, origin, offline, pages string, now time.Time) *devtuf.ResignResult {
	t.Helper()
	wf := filepath.Join(t.TempDir(), "wf")
	git(t, "", "clone", "-q", origin, wf)
	snap, err := devtuf.ReadKeyFile(filepath.Join(offline, "snapshot.json"), "snapshot")
	if err != nil {
		t.Fatal(err)
	}
	ts, _ := devtuf.ReadKeyFile(filepath.Join(offline, "timestamp.json"), "timestamp")
	res, err := devtuf.ResignOnline(filepath.Join(wf, "metadata"), snap, ts, devtuf.ResignOptions{Now: now})
	if err != nil {
		t.Fatal(err)
	}
	git(t, wf, "add", "-A", "metadata")
	git(t, wf, "-c", "user.name=wf", "-c", "user.email=wf@example.com", "commit", "-q", "-m", "resign")
	git(t, wf, "push", "-q", "origin", "HEAD:main")
	os.RemoveAll(pages)
	if err := os.CopyFS(pages, os.DirFS(filepath.Join(wf, "metadata"))); err != nil {
		t.Fatal(err)
	}
	return res
}

// The whole path (LNK-23…LNK-26) against a local GitHub: DEV's repository continued, a development release published
// (blobs once into nar-xx, the release's files into its own release, metadata pushed), the workflow's signatures, then
// a box: metadata from Pages, channel roles mirrored for its helper, indexes and blobs from release assets through
// GitHub's redirect. A promotion reaches production boxes without uploading anything.
func TestGitHubChannelEndToEnd(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("no git")
	}
	// The publisher's own git runs too: no hooks or identity from the machine's configuration.
	t.Setenv("GIT_CONFIG_GLOBAL", os.DevNull)
	t.Setenv("GIT_CONFIG_SYSTEM", os.DevNull)
	ctx := context.Background()
	now := time.Date(2026, 11, 18, 12, 0, 0, 0, time.UTC)
	clock := func() time.Time { return now }
	base := t.TempDir()

	// Today's DEV repository, and a box that trusts it.
	src, err := devtuf.New(filepath.Join(base, "dev"), devtuf.Options{Env: "local", Now: clock})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := src.AddFakeRelease(devtuf.StandardRelease("whombat-dev-20261117.1", "26.05.1", "1.0.0")); err != nil {
		t.Fatal(err)
	}
	if err := src.Publish(); err != nil {
		t.Fatal(err)
	}
	pinned := filepath.Join(base, "root.json")
	os.WriteFile(pinned, src.InitialRoot(), 0o644)
	boxCache, mirror := filepath.Join(base, "box", "cache"), filepath.Join(base, "box", "mirror")
	old := &tufclient.Client{PinnedRootPath: pinned, CacheDir: boxCache, MirrorDir: mirror, MetadataURL: "file://dev",
		Fetcher: trust.DirFetcher{BaseURL: "file://dev", Dir: src.MetadataDir()}, Now: clock}
	if _, err := old.Refresh(ctx); err != nil {
		t.Fatal(err)
	}

	// The GitHub repository: continued, cloned, pushed.
	origin := filepath.Join(base, "origin.git")
	git(t, "", "init", "-q", "--bare", "-b", "main", origin)
	work, keys, offline := filepath.Join(base, "work"), filepath.Join(base, "keys"), filepath.Join(base, "offline")
	if _, err := devtuf.Continue(src.Dir, work, devtuf.ContinueOptions{KeysDir: keys, OfflineKeysDir: offline, Now: clock}); err != nil {
		t.Fatal(err)
	}
	gh := fakegithub.New("CybexBV", "whombat-releases", "secret-token", filepath.Join(base, "pages"))
	defer gh.Close()
	var log []string
	pub, err := ghpublish.New(ghpublish.Config{Dir: work, Owner: "CybexBV", Repo: "whombat-releases", APIURL: gh.APIURL,
		Token: "secret-token", Backoff: time.Millisecond, Log: func(f string, a ...any) { log = append(log, f) }})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pub.InitClone(ctx, origin); err != nil {
		t.Fatal(err)
	}
	workflow(t, origin, offline, gh.PagesDir, now)

	// A development release.
	id := "whombat-dev-20261118.1"
	res, err := pub.Publish(ctx, trust.ChannelDevelopment, id, func(r *devtuf.Repo) error {
		r.InChannel(trust.ChannelDevelopment)
		if _, err := r.AddFakeRelease(devtuf.StandardRelease(id, "26.05.2", "2.0.0")); err != nil {
			return err
		}
		return r.Publish()
	})
	if err != nil {
		t.Fatal(err)
	}
	if !res.MetadataPushed || len(res.Uploaded) == 0 || res.Present != 0 {
		t.Fatalf("publish %+v", res)
	}
	var buckets int
	for _, tag := range gh.Tags() {
		if strings.HasPrefix(tag, "nar-") {
			buckets++
		}
	}
	if buckets == 0 || len(gh.AssetNames(id)) != 4 { // tuple, host, runtime and provider index
		t.Fatalf("tags %v, %s has %v", gh.Tags(), id, gh.AssetNames(id))
	}
	// Again: everything is there, nothing goes up twice.
	again, err := pub.Publish(ctx, trust.ChannelDevelopment, id, nil)
	if err != nil || len(again.Uploaded) != 0 || again.Present != len(res.Uploaded) || again.MetadataPushed {
		t.Fatalf("again %+v %v", again, err)
	}
	workflow(t, origin, offline, gh.PagesDir, now)

	// The box moves to the GitHub repository: same cache, channel development.
	channel := trust.ChannelDevelopment
	box := &tufclient.Client{PinnedRootPath: pinned, CacheDir: boxCache, MirrorDir: mirror, MetadataURL: gh.PagesURL,
		Fetcher: tufclient.NewHTTPFetcher("test"), Now: clock, Channel: func() string { return channel }}
	repo, err := box.Refresh(ctx)
	if err != nil {
		t.Fatalf("the box on GitHub: %v", err)
	}
	rel, err := repo.Release(id)
	if err != nil {
		t.Fatal(err)
	}
	staging := filepath.Join(base, "box", "staging")
	d := &tufclient.Downloader{StagingDir: staging, Space: tufclient.StatfsSpace{},
		Source: tufclient.HTTPSource{BaseURL: gh.DownloadBase(), Layout: tufclient.LayoutGitHub}}
	blobs := 0
	for _, ia := range rel.Artifacts() {
		if err := d.Download(ctx, ia); err != nil {
			t.Fatalf("%s: %v", ia.Remote, err)
		}
		b, err := d.ReadStaged(ia)
		if err != nil {
			t.Fatal(err)
		}
		ci, err := trust.ParseClosureIndex(b, ia)
		if err != nil {
			t.Fatal(err)
		}
		for i := range ci.Paths {
			if err := d.Download(ctx, ci.Blob(i)); err != nil {
				t.Fatalf("blob %s: %v", ci.Blob(i).Remote, err)
			}
			blobs++
		}
	}
	if blobs == 0 {
		t.Fatal("no blobs")
	}
	// The helper verifies the same release from the mirror.
	hv, err := trust.Refresh(trust.Config{PinnedRoot: src.InitialRoot(), MetadataDir: filepath.Join(base, "helper"), MetadataURL: "mirror://m",
		Fetcher: trust.DirFetcher{BaseURL: "mirror://m", Dir: mirror}, Now: now, Channel: trust.ChannelDevelopment})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := hv.Release(id); err != nil {
		t.Fatal(err)
	}

	// Promotion: production lists it, nothing is uploaded, a production box finds the same files.
	prodKey, err := devtuf.ReadKeyFile(filepath.Join(offline, "production.json"), "production")
	if err != nil {
		t.Fatal(err)
	}
	before := len(gh.AssetNames(id))
	pr, err := pub.Promote(ctx, id, prodKey)
	if err != nil {
		t.Fatal(err)
	}
	if len(pr.Uploaded) != 0 || !pr.MetadataPushed || len(gh.AssetNames(id)) != before {
		t.Fatalf("promotion %+v", pr)
	}
	workflow(t, origin, offline, gh.PagesDir, now.Add(time.Hour))
	channel = trust.ChannelProduction
	box.Now = func() time.Time { return now.Add(time.Hour) }
	repo, err = box.Refresh(ctx)
	if err != nil {
		t.Fatal(err)
	}
	prel, err := repo.Release(id)
	if err != nil || prel.Digest != rel.Digest {
		t.Fatalf("production: %v", err)
	}
	if err := d.Download(ctx, *prel.RuntimeIndex); err != nil {
		t.Fatal(err)
	}
}
