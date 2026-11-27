package ghpublish_test

import (
	"context"
	"crypto/ed25519"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/helper/pkg/trust"
	"github.com/CybexBV/whombat/appliance/release-tools/devtuf"
	"github.com/CybexBV/whombat/appliance/release-tools/fakegithub"
	"github.com/CybexBV/whombat/appliance/release-tools/ghpublish"
)

type env struct {
	ctx    context.Context
	gh     *fakegithub.GitHub
	pub    *ghpublish.Publisher
	dir    string
	origin string
	logs   []string
}

func setup(t *testing.T, maxFile int64) *env { return setupWith(t, maxFile, nil) }

// setupWith: tune changes the publisher's configuration (a transport that steps in during uploads).
func setupWith(t *testing.T, maxFile int64, tune func(*ghpublish.Config)) *env {
	t.Helper()
	e := newEnv(t, maxFile, tune)
	if _, err := e.pub.InitClone(context.Background(), e.origin); err != nil {
		t.Fatal(err)
	}
	return e
}

// newEnv is a GitHub-layout repository with its channel roles, not yet a clone (gh-continue's output).
func newEnv(t *testing.T, maxFile int64, tune func(*ghpublish.Config)) *env {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("no git")
	}
	t.Setenv("GIT_CONFIG_GLOBAL", os.DevNull)
	t.Setenv("GIT_CONFIG_SYSTEM", os.DevNull)
	base := t.TempDir()
	now := time.Date(2026, 11, 18, 12, 0, 0, 0, time.UTC)
	dir := filepath.Join(base, "work")
	r, err := devtuf.New(dir, devtuf.Options{Env: "local", Layout: devtuf.LayoutGitHub, Now: func() time.Time { return now }})
	if err != nil {
		t.Fatal(err)
	}
	if err := r.AddChannelRoles(nil, nil); err != nil {
		t.Fatal(err)
	}
	origin := filepath.Join(base, "origin.git")
	if out, err := exec.Command("git", "init", "-q", "--bare", "-b", "main", origin).CombinedOutput(); err != nil {
		t.Fatalf("%v %s", err, out)
	}
	gh := fakegithub.New("CybexBV", "whombat-releases", "tok", filepath.Join(base, "pages"))
	t.Cleanup(gh.Close)
	e := &env{ctx: context.Background(), gh: gh, dir: dir, origin: origin}
	cfg := ghpublish.Config{Dir: dir, Owner: "CybexBV", Repo: "whombat-releases", APIURL: gh.APIURL, Token: "tok",
		MaxFile: maxFile, Backoff: time.Millisecond, Log: func(f string, a ...any) { e.logs = append(e.logs, fmt.Sprintf(f, a...)) }}
	if tune != nil {
		tune(&cfg)
	}
	if e.pub, err = ghpublish.New(cfg); err != nil {
		t.Fatal(err)
	}
	return e
}

func fakeRelease(id, host, runtime string, pad int) func(r *devtuf.Repo) error {
	return func(r *devtuf.Repo) error {
		r.InChannel(trust.ChannelDevelopment)
		f := devtuf.StandardRelease(id, host, runtime)
		f.PadBytes = pad
		if _, err := r.AddFakeRelease(f); err != nil {
			return err
		}
		return r.Publish()
	}
}

// Each blob goes up once: a second release that shares blobs uploads only its new ones; a token GitHub refuses
// stops the publish before any metadata is pushed.
func TestBlobsOnceAndOrder(t *testing.T) {
	e := setup(t, 0)
	r1, err := e.pub.Publish(e.ctx, trust.ChannelDevelopment, "whombat-dev-20261118.1", fakeRelease("whombat-dev-20261118.1", "26.05.1", "1.0.0", 0))
	if err != nil {
		t.Fatal(err)
	}
	r2, err := e.pub.Publish(e.ctx, trust.ChannelDevelopment, "whombat-dev-20261118.2", fakeRelease("whombat-dev-20261118.2", "26.05.1", "1.1.0", 0))
	if err != nil {
		t.Fatal(err)
	}
	if r2.Present == 0 || len(r2.Uploaded) >= len(r1.Uploaded) {
		t.Fatalf("the second release uploaded %d (present %d), the first %d", len(r2.Uploaded), r2.Present, len(r1.Uploaded))
	}
	for _, u := range r2.Uploaded {
		for _, v := range r1.Uploaded {
			if u == v {
				t.Fatalf("%s uploaded twice", u)
			}
		}
	}
	if e.gh.APICalls["POST uploads"] != len(r1.Uploaded)+len(r2.Uploaded) {
		t.Fatalf("uploads %v", e.gh.APICalls)
	}
	bad, _ := ghpublish.New(ghpublish.Config{Dir: e.dir, Owner: "CybexBV", Repo: "whombat-releases", APIURL: e.gh.APIURL, Token: "wrong",
		Backoff: time.Millisecond})
	head := gitHead(t, e.dir)
	if _, err := bad.Publish(e.ctx, trust.ChannelDevelopment, "whombat-dev-20261118.3", fakeRelease("whombat-dev-20261118.3", "26.05.1", "1.2.0", 0)); err == nil {
		t.Fatal("published with a bad token")
	}
	if gitHead(t, e.dir) != head {
		t.Fatal("metadata committed although the upload failed")
	}
	// The next run with the right token completes the same release (signed already) and pushes it.
	r3, err := e.pub.Publish(e.ctx, trust.ChannelDevelopment, "whombat-dev-20261118.3", nil)
	if err != nil || !r3.MetadataPushed || len(r3.Uploaded) == 0 {
		t.Fatalf("completing: %+v %v", r3, err)
	}
}

// A file over the limit is named and nothing goes up.
func TestTooLargeFileRefused(t *testing.T) {
	e := setup(t, 64<<10)
	_, err := e.pub.Publish(e.ctx, trust.ChannelDevelopment, "whombat-dev-20261118.1", fakeRelease("whombat-dev-20261118.1", "26.05.1", "1.0.0", 200<<10))
	if err == nil || !strings.Contains(err.Error(), "larger than GitHub takes") || !strings.Contains(err.Error(), ".nar.zst") {
		t.Fatalf("want the large blob named, got %v", err)
	}
	if n := e.gh.APICalls["POST uploads"]; n != 0 {
		t.Fatalf("%d uploads before the refusal", n)
	}
}

// A cut-off upload GitHub kept (wrong size) is removed and sent again.
func TestBrokenAssetReplaced(t *testing.T) {
	e := setup(t, 0)
	id := "whombat-dev-20261118.1"
	var tupleName string
	_, err := e.pub.Publish(e.ctx, trust.ChannelDevelopment, id, func(r *devtuf.Repo) error {
		if err := fakeRelease(id, "26.05.1", "1.0.0", 0)(r); err != nil {
			return err
		}
		files, err := r.ReleaseFiles(trust.ChannelDevelopment, id)
		if err != nil {
			return err
		}
		tupleName = files[0].Name
		e.gh.PutAsset(id, tupleName, []byte("half"))
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if e.gh.APICalls["DELETE releases/assets"] != 1 {
		t.Fatalf("calls %v", e.gh.APICalls)
	}
	rel := e.gh.Release(id)
	if rel == nil || len(e.gh.AssetNames(id)) != 4 {
		t.Fatalf("assets %v", e.gh.AssetNames(id))
	}
}

func gitHead(t *testing.T, dir string) string {
	t.Helper()
	out, err := exec.Command("git", "-C", dir, "rev-parse", "HEAD").Output()
	if err != nil {
		t.Fatal(err)
	}
	return strings.TrimSpace(string(out))
}

// pushedFiles lists the metadata files of the remote's branch.
func pushedFiles(t *testing.T, dir string) string {
	t.Helper()
	if out, err := exec.Command("git", "-C", dir, "fetch", "-q", "origin", "main").CombinedOutput(); err != nil {
		t.Fatalf("%v %s", err, out)
	}
	out, err := exec.Command("git", "-C", dir, "ls-tree", "-r", "--name-only", "FETCH_HEAD", "--", "metadata").Output()
	if err != nil {
		t.Fatal(err)
	}
	return string(out)
}

// A publish whose files didn't all go up signed its role locally: no other publish may push that role along before
// its files are there. The next publish is refused until the stopped one is run again.
func TestStoppedPublishHoldsTheOthersBack(t *testing.T) {
	e := setup(t, 0)
	bad, _ := ghpublish.New(ghpublish.Config{Dir: e.dir, Owner: "CybexBV", Repo: "whombat-releases", APIURL: e.gh.APIURL, Token: "wrong",
		Backoff: time.Millisecond})
	a, b := "whombat-dev-20261118.1", "whombat-dev-20261118.2"
	if _, err := bad.Publish(e.ctx, trust.ChannelDevelopment, a, fakeRelease(a, "26.05.1", "1.0.0", 0)); err == nil {
		t.Fatal("published with a bad token")
	}
	before := pushedFiles(t, e.dir)
	_, err := e.pub.Publish(e.ctx, trust.ChannelDevelopment, b, fakeRelease(b, "26.05.1", "1.1.0", 0))
	if err == nil || !strings.Contains(err.Error(), a) {
		t.Fatalf("another publish while %s's files are missing: %v", a, err)
	}
	if pushedFiles(t, e.dir) != before || len(e.gh.AssetNames(b)) != 0 {
		t.Fatal("the refused publish pushed or uploaded something")
	}
	// Running the stopped one again finishes it; then the next one goes.
	if r, err := e.pub.Publish(e.ctx, trust.ChannelDevelopment, a, nil); err != nil || !r.MetadataPushed {
		t.Fatalf("finishing %s: %+v %v", a, r, err)
	}
	if r, err := e.pub.Publish(e.ctx, trust.ChannelDevelopment, b, fakeRelease(b, "26.05.1", "1.1.0", 0)); err != nil || !r.MetadataPushed {
		t.Fatalf("%s after: %+v %v", b, r, err)
	}
	// A refusal before anything was signed leaves nothing to finish.
	if _, err := e.pub.Publish(e.ctx, trust.ChannelDevelopment, "whombat-dev-20261118.3", func(*devtuf.Repo) error { return os.ErrInvalid }); err == nil {
		t.Fatal("a refused signing published")
	}
	if r, err := e.pub.Publish(e.ctx, trust.ChannelDevelopment, "", nil); err != nil || r.MetadataPushed {
		t.Fatalf("a publish after a refusal: %+v %v", r, err)
	}
}

// gh-clients uploads the clients role's files, then pushes the role the channel publisher signed; with a failed upload
// the role stays unpushed and other publishes wait for it.
func TestClientsUploadThenPush(t *testing.T) {
	e := setup(t, 0)
	r, err := devtuf.Load(e.dir, devtuf.Options{})
	if err != nil {
		t.Fatal(err)
	}
	if err := r.AddClientsRole(nil); err != nil {
		t.Fatal(err)
	}
	// AddClientsRole changes the top-level targets (offline, by hand): a publish doesn't carry such changes along.
	if res, err := e.pub.Publish(e.ctx, "", "", nil); err == nil || res != nil {
		t.Fatalf("unpushed top-level changes went along with a publish: %v", err)
	}
	for _, args := range [][]string{{"add", "metadata"}, {"-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "clients role"},
		{"push", "-q", "origin", "HEAD:main"}} {
		if out, err := exec.Command("git", append([]string{"-C", e.dir}, args...)...).CombinedOutput(); err != nil {
			t.Fatalf("%v %s", err, out)
		}
	}
	r, _ = devtuf.Load(e.dir, devtuf.Options{})
	if err := r.PublishClients(nil, map[string][]byte{"clients/channel.json": []byte(`{"v":1}`)}); err != nil {
		t.Fatal(err)
	}
	bad, _ := ghpublish.New(ghpublish.Config{Dir: e.dir, Owner: "CybexBV", Repo: "whombat-releases", APIURL: e.gh.APIURL, Token: "wrong",
		Backoff: time.Millisecond})
	before := pushedFiles(t, e.dir)
	if _, err := bad.UploadClients(e.ctx); err == nil {
		t.Fatal("uploaded with a bad token")
	}
	if pushedFiles(t, e.dir) != before {
		t.Fatal("the clients role went up before its files")
	}
	if _, err := e.pub.Publish(e.ctx, trust.ChannelDevelopment, "whombat-dev-20261118.1", fakeRelease("whombat-dev-20261118.1", "26.05.1", "1.0.0", 0)); err == nil {
		t.Fatal("a release publish carried the unpushed clients role along")
	}
	res, err := e.pub.UploadClients(e.ctx)
	if err != nil || !res.MetadataPushed || len(res.Uploaded) != 1 {
		t.Fatalf("gh-clients: %+v %v", res, err)
	}
	if after := pushedFiles(t, e.dir); after == before || !strings.Contains(after, ".clients.json") {
		t.Fatalf("pushed %s", after)
	}
}

// git runs git in the clone.
func gitIn(t *testing.T, dir string, args ...string) {
	t.Helper()
	if out, err := exec.Command("git", append([]string{"-C", dir}, args...)...).CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v %s", args, err, out)
	}
}

// A publish whose files went up and whose commit was made, but whose push failed, really pushes when it runs again,
// and only then forgets that it is pending: the clean metadata folder doesn't mean the remote has it.
func TestRetriedPushReallyPushes(t *testing.T) {
	e := setup(t, 0)
	hook := filepath.Join(e.origin, "hooks", "pre-receive")
	if err := os.WriteFile(hook, []byte("#!/bin/sh\nexit 1\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	id := "whombat-dev-20261118.1"
	before := pushedFiles(t, e.dir)
	if _, err := e.pub.Publish(e.ctx, trust.ChannelDevelopment, id, fakeRelease(id, "26.05.1", "1.0.0", 0)); err == nil {
		t.Fatal("published although the remote refused the push")
	}
	if _, err := os.Stat(filepath.Join(e.dir, ".publish-pending.json")); err != nil {
		t.Fatalf("the failed push isn't pending: %v", err)
	}
	if pushedFiles(t, e.dir) != before {
		t.Fatal("the role reached the remote")
	}
	os.Remove(hook)
	r, err := e.pub.Publish(e.ctx, trust.ChannelDevelopment, id, nil)
	if err != nil || !r.MetadataPushed {
		t.Fatalf("the retry: %+v %v", r, err)
	}
	if after := pushedFiles(t, e.dir); after == before {
		t.Fatal("the retry pushed nothing")
	}
	if _, err := os.Stat(filepath.Join(e.dir, ".publish-pending.json")); !os.IsNotExist(err) {
		t.Fatalf("still pending after the push: %v", err)
	}
	if out, _ := exec.Command("git", "-C", e.dir, "rev-list", "--count", "FETCH_HEAD..HEAD").Output(); strings.TrimSpace(string(out)) != "0" {
		t.Fatalf("the clone is still ahead of the remote: %s", out)
	}
}

// countedPushes makes origin fail its first n pushes with words, as a remote's own message, and returns how many
// pushes it got so far.
func countedPushes(t *testing.T, origin string, n int, words string) func() int {
	t.Helper()
	count := filepath.Join(t.TempDir(), "pushes")
	script := fmt.Sprintf("#!/bin/sh\nn=$(cat %q 2>/dev/null || echo 0)\necho $((n+1)) > %q\nif [ \"$n\" -lt %d ]; then echo %q >&2; exit 1; fi\n",
		count, count, n, words)
	if err := os.WriteFile(filepath.Join(origin, "hooks", "pre-receive"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return func() int {
		b, _ := os.ReadFile(count)
		got, _ := strconv.Atoi(strings.TrimSpace(string(b)))
		return got
	}
}

// What GitHub says when a push fails on its own side, while its check of the branch's rules broke.
const githubsOwnWords = "fatal error in commit_refs_rules"

// A push GitHub fails on its own side is made again by the same run, and the publish finishes.
func TestPushGitHubFailedIsMadeAgain(t *testing.T) {
	e := setupWith(t, 0, func(c *ghpublish.Config) { c.PushWait = time.Millisecond })
	pushes := countedPushes(t, e.origin, 2, githubsOwnWords)
	id := "whombat-dev-20261118.1"
	before := pushedFiles(t, e.dir)
	r, err := e.pub.Publish(e.ctx, trust.ChannelDevelopment, id, fakeRelease(id, "26.05.1", "1.0.0", 0))
	if err != nil || !r.MetadataPushed {
		t.Fatalf("the publish: %+v %v", r, err)
	}
	if pushes() != 3 {
		t.Fatalf("pushes: %d, want 3 (two failed, then one)", pushes())
	}
	if pushedFiles(t, e.dir) == before {
		t.Fatal("nothing reached the remote")
	}
	if _, err := os.Stat(filepath.Join(e.dir, ".publish-pending.json")); !os.IsNotExist(err) {
		t.Fatalf("still pending after the push: %v", err)
	}
}

// The tries end: a publish GitHub keeps failing stops as one whose push failed, and running it again finishes it.
func TestPushGitHubKeepsFailingStops(t *testing.T) {
	e := setupWith(t, 0, func(c *ghpublish.Config) { c.PushTries, c.PushWait = 3, time.Millisecond })
	pushes := countedPushes(t, e.origin, 1000, githubsOwnWords)
	id := "whombat-dev-20261118.1"
	if _, err := e.pub.Publish(e.ctx, trust.ChannelDevelopment, id, fakeRelease(id, "26.05.1", "1.0.0", 0)); err == nil {
		t.Fatal("published although every push failed")
	}
	if pushes() != 3 {
		t.Fatalf("pushes: %d, want the 3 tries", pushes())
	}
	if _, err := os.Stat(filepath.Join(e.dir, ".publish-pending.json")); err != nil {
		t.Fatalf("the failed push isn't pending: %v", err)
	}
	os.Remove(filepath.Join(e.origin, "hooks", "pre-receive"))
	if r, err := e.pub.Publish(e.ctx, trust.ChannelDevelopment, id, nil); err != nil || !r.MetadataPushed {
		t.Fatalf("running it again: %+v %v", r, err)
	}
}

// Any other refusal is the remote's answer: one push, no second try.
func TestPushRefusedIsNotMadeAgain(t *testing.T) {
	e := setupWith(t, 0, func(c *ghpublish.Config) { c.PushWait = time.Millisecond })
	pushes := countedPushes(t, e.origin, 1000, "a rule of this branch refuses the push")
	id := "whombat-dev-20261118.1"
	if _, err := e.pub.Publish(e.ctx, trust.ChannelDevelopment, id, fakeRelease(id, "26.05.1", "1.0.0", 0)); err == nil {
		t.Fatal("published although the remote refused the push")
	}
	if pushes() != 1 {
		t.Fatalf("pushes: %d, want 1", pushes())
	}
}

// An emergency pause gets through a push GitHub fails on its own side, and stops at once on another refusal.
func TestPauseGitHubFailedIsMadeAgain(t *testing.T) {
	e := setupWith(t, 0, func(c *ghpublish.Config) { c.PushWait = time.Millisecond })
	pushes := countedPushes(t, e.origin, 2, githubsOwnWords)
	res, pr, err := e.pub.PauseChannel(e.ctx, trust.ChannelProduction, nil)
	if err != nil || !res.MetadataPushed || pr == nil || !pr.Paused {
		t.Fatalf("pause: %+v %+v %v", res, pr, err)
	}
	if pushes() != 3 {
		t.Fatalf("pushes: %d, want 3 (two failed, then one)", pushes())
	}
	if files := pushedFiles(t, e.dir); !strings.Contains(files, fmt.Sprintf("metadata/%d.production.json", pr.Version)) {
		t.Fatalf("the paused role isn't on the remote:\n%s", files)
	}
	refused := countedPushes(t, e.origin, 1000, "a rule of this branch refuses the push")
	if _, _, err := e.pub.ResumeChannel(e.ctx, trust.ChannelProduction, nil); err == nil {
		t.Fatal("resumed although the remote refused the push")
	}
	if refused() != 1 {
		t.Fatalf("pushes of the refused resume: %d, want 1", refused())
	}
}

// duringUpload runs f once, at the first upload of a file to GitHub, as if another process ran then.
type duringUpload struct {
	mu sync.Mutex
	f  func()
}

func (d *duringUpload) RoundTrip(req *http.Request) (*http.Response, error) {
	if strings.HasPrefix(req.URL.Path, "/uploads/") {
		d.mu.Lock()
		f := d.f
		d.f = nil
		d.mu.Unlock()
		if f != nil {
			f()
		}
	}
	return http.DefaultTransport.RoundTrip(req)
}

// signClients is the client channel publisher (clientchannel publish): the devtuf lock, a new clients role.
func signClients(t *testing.T, dir string, doc string) {
	t.Helper()
	unlock, err := devtuf.Lock(dir, 2*time.Second)
	if err != nil {
		t.Errorf("the client channel publisher waited for the release publisher: %v", err)
		return
	}
	defer unlock()
	r, err := devtuf.Load(dir, devtuf.Options{})
	if err != nil {
		t.Error(err)
		return
	}
	if err := r.PublishClients(nil, map[string][]byte{"clients/channel.json": []byte(doc)}); err != nil {
		t.Error(err)
	}
}

// The client channel publisher signs while a publish uploads (Sol 6): a release publish, then gh-clients, commits only
// the metadata it signed or read before its upload, so no clients role goes up before its files. The clone holds no
// snapshot or timestamp key, as on the build server (the workflow signs those).
func TestClientsSignedDuringAnUpload(t *testing.T) {
	hook := &duringUpload{}
	e := setupWith(t, 0, func(c *ghpublish.Config) { c.HTTP = &http.Client{Transport: hook} })
	withClientsRole(t, e)
	clientsRoles := func() []string { return pushedClientsRoles(t, e.dir) }
	start := clientsRoles()

	// A release publish; the channel publisher signs clients role 2 while its files go up.
	hook.f = func() { signClients(t, e.dir, `{"v":2}`) }
	id := "whombat-dev-20261118.1"
	if res, err := e.pub.Publish(e.ctx, trust.ChannelDevelopment, id, fakeRelease(id, "26.05.1", "1.0.0", 0)); err != nil || !res.MetadataPushed {
		t.Fatalf("the release: %+v %v", res, err)
	}
	if got := clientsRoles(); len(got) != len(start) || len(e.gh.AssetNames("clients")) != 0 {
		t.Fatalf("a clients role went up with the release: %v (assets %v)", got, e.gh.AssetNames("clients"))
	}
	if !strings.Contains(pushedFiles(t, e.dir), ".development.json") {
		t.Fatal("the release's role wasn't pushed")
	}

	// gh-clients sends role 2's files and pushes role 2; role 3, signed during that upload, waits for the next one.
	hook.f = func() { signClients(t, e.dir, `{"v":3}`) }
	if res, err := e.pub.UploadClients(e.ctx); err != nil || !res.MetadataPushed {
		t.Fatalf("gh-clients: %+v %v", res, err)
	}
	got := clientsRoles()
	if !slicesContain(got, "2.clients.json") || slicesContain(got, "3.clients.json") {
		t.Fatalf("pushed clients roles %v", got)
	}
	if res, err := e.pub.UploadClients(e.ctx); err != nil || !res.MetadataPushed || len(res.Uploaded) != 1 {
		t.Fatalf("the next gh-clients: %+v %v", res, err)
	}
	if got := clientsRoles(); !slicesContain(got, "3.clients.json") || len(e.gh.AssetNames("clients")) != 2 {
		t.Fatalf("pushed %v, assets %v", got, e.gh.AssetNames("clients"))
	}
}

// withClientsRole gives the clone a clients role, pushed, and takes the snapshot and timestamp keys out of it, as on The
// Beast (the workflow signs those).
func withClientsRole(t *testing.T, e *env) {
	t.Helper()
	r, err := devtuf.Load(e.dir, devtuf.Options{})
	if err != nil {
		t.Fatal(err)
	}
	if err := r.AddClientsRole(nil); err != nil {
		t.Fatal(err)
	}
	gitIn(t, e.dir, "add", "metadata")
	gitIn(t, e.dir, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "clients role")
	gitIn(t, e.dir, "push", "-q", "origin", "HEAD:main")
	keys, _ := filepath.Glob(filepath.Join(e.dir, "keys", "*.json"))
	for _, k := range keys {
		if b := filepath.Base(k); strings.HasPrefix(b, "snapshot-") || strings.HasPrefix(b, "timestamp-") {
			os.Remove(k)
		}
	}
}

// pushedClientsRoles lists the clients role files on the remote's branch.
func pushedClientsRoles(t *testing.T, dir string) []string {
	var out []string
	for _, f := range strings.Fields(pushedFiles(t, dir)) {
		if strings.HasSuffix(f, ".clients.json") {
			out = append(out, filepath.Base(f))
		}
	}
	return out
}

// A publish stopped after it signed its role but before it recorded which files (Sol 6), and the client channel
// publisher signed a clients role since: running the publish again pushes its own role only; the clients role waits
// for gh-clients, which sends its files first.
func TestResumedSignaturePushesOnlyItsRole(t *testing.T) {
	e := setup(t, 0)
	withClientsRole(t, e)
	start := pushedClientsRoles(t, e.dir)
	id := "whombat-dev-20261118.1"
	pending := filepath.Join(e.dir, ".publish-pending.json")
	if err := os.WriteFile(pending, []byte(`{"channel":"development","releaseId":"`+id+`"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	r, err := devtuf.Load(e.dir, devtuf.Options{})
	if err != nil {
		t.Fatal(err)
	}
	if err := fakeRelease(id, "26.05.1", "1.0.0", 0)(r); err != nil {
		t.Fatal(err)
	}
	signClients(t, e.dir, `{"v":2}`)
	res, err := e.pub.Publish(e.ctx, trust.ChannelDevelopment, id, nil)
	if err != nil || !res.MetadataPushed || len(res.Uploaded) == 0 {
		t.Fatalf("resuming: %+v %v", res, err)
	}
	if got := pushedClientsRoles(t, e.dir); len(got) != len(start) || len(e.gh.AssetNames("clients")) != 0 {
		t.Fatalf("a clients role went up with the resumed release: %v (assets %v)", got, e.gh.AssetNames("clients"))
	}
	if !strings.Contains(pushedFiles(t, e.dir), ".development.json") {
		t.Fatal("the release's role wasn't pushed")
	}
	if _, err := os.Stat(pending); !os.IsNotExist(err) {
		t.Fatalf("still pending: %v", err)
	}
	if res, err := e.pub.UploadClients(e.ctx); err != nil || !res.MetadataPushed || len(res.Uploaded) != 1 {
		t.Fatalf("gh-clients: %+v %v", res, err)
	}
	if got := pushedClientsRoles(t, e.dir); !slicesContain(got, "2.clients.json") {
		t.Fatalf("pushed clients roles %v", got)
	}
	if left, _ := filepath.Glob(pending + ".*"); len(left) != 0 {
		t.Fatalf("temporary records left: %v", left)
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

// A stopped publish that left nothing behind is given up by itself (Fable N4): one killed before it signed, and one
// whose signed metadata was put back by hand (the runbook's way to abandon it).
func TestStoppedPublishGivenUp(t *testing.T) {
	e := setup(t, 0)
	pending := filepath.Join(e.dir, ".publish-pending.json")
	if err := os.WriteFile(pending, []byte(`{"channel":"development","releaseId":"whombat-dev-20261118.9"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	a := "whombat-dev-20261118.1"
	if r, err := e.pub.Publish(e.ctx, trust.ChannelDevelopment, a, fakeRelease(a, "26.05.1", "1.0.0", 0)); err != nil || !r.MetadataPushed {
		t.Fatalf("after a publish stopped before signing: %+v %v", r, err)
	}
	if !strings.Contains(strings.Join(e.logs, "\n"), "whombat-dev-20261118.9") {
		t.Fatalf("no note about the dropped record: %v", e.logs)
	}

	// Signed, its upload failed: it holds the others back until its metadata is restored.
	bad, _ := ghpublish.New(ghpublish.Config{Dir: e.dir, Owner: "CybexBV", Repo: "whombat-releases", APIURL: e.gh.APIURL, Token: "wrong",
		Backoff: time.Millisecond})
	b, c := "whombat-dev-20261118.2", "whombat-dev-20261118.3"
	if _, err := bad.Publish(e.ctx, trust.ChannelDevelopment, b, fakeRelease(b, "26.05.1", "1.1.0", 0)); err == nil {
		t.Fatal("published with a bad token")
	}
	if _, err := e.pub.Publish(e.ctx, trust.ChannelDevelopment, c, fakeRelease(c, "26.05.1", "1.2.0", 0)); err == nil || !strings.Contains(err.Error(), b) {
		t.Fatalf("another publish while %s is signed: %v", b, err)
	}
	// Stopped after it staged its metadata (Sol 11): the runbook's commands put back the index and the work tree.
	gitIn(t, e.dir, "add", "metadata")
	giveUp(t, e.dir)
	if r, err := e.pub.Publish(e.ctx, trust.ChannelDevelopment, c, fakeRelease(c, "26.05.1", "1.2.0", 0)); err != nil || !r.MetadataPushed {
		t.Fatalf("after giving %s up: %+v %v", b, r, err)
	}
	if _, err := os.Stat(pending); !os.IsNotExist(err) {
		t.Fatalf("pending: %v", err)
	}

	// Stopped after its commit, before its push: the same commands drop the commit too.
	d, f := "whombat-dev-20261118.4", "whombat-dev-20261118.5"
	if _, err := bad.Publish(e.ctx, trust.ChannelDevelopment, d, fakeRelease(d, "26.05.1", "1.3.0", 0)); err == nil {
		t.Fatal("published with a bad token")
	}
	gitIn(t, e.dir, "add", "metadata")
	gitIn(t, e.dir, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "publish "+d)
	before := pushedFiles(t, e.dir)
	giveUp(t, e.dir)
	if r, err := e.pub.Publish(e.ctx, trust.ChannelDevelopment, f, fakeRelease(f, "26.05.1", "1.4.0", 0)); err != nil || !r.MetadataPushed {
		t.Fatalf("after giving %s up: %+v %v", d, r, err)
	}
	if after := pushedFiles(t, e.dir); after == before || len(e.gh.AssetNames(d)) != 0 {
		t.Fatalf("%s's metadata or files went up", d)
	}
}

// giveUp runs the runbook's commands that give up a stopped publish (docs/runbooks/updates.md, “A publish that
// stopped”), word for word.
func giveUp(t *testing.T, dir string) {
	t.Helper()
	cmd := exec.Command("sh", "-ec", `git reset -q --hard '@{u}' && git clean -fdq metadata && rm -f .publish-pending.json`)
	cmd.Dir = dir
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("giving up: %v %s", err, out)
	}
}

// gh-init publishes what the metadata lists (Sol 4): the releases development lists (gh-continue --carry's) and the
// clients role's targets go up and are verified before the first metadata push; a failed upload pushes nothing and
// leaves no git repository, so running it again finishes it; an asset of other bytes under a file's name is replaced.
func TestInitUploadsWhatTheMetadataLists(t *testing.T) {
	e := newEnv(t, 0, nil)
	r, err := devtuf.Load(e.dir, devtuf.Options{})
	if err != nil {
		t.Fatal(err)
	}
	ids := []string{"whombat-dev-20261117.1", "whombat-dev-20261117.2"}
	if err := fakeRelease(ids[0], "26.05.1", "1.0.0", 0)(r); err != nil {
		t.Fatal(err)
	}
	if err := fakeRelease(ids[1], "26.05.2", "1.0.1", 0)(r); err != nil {
		t.Fatal(err)
	}
	r.InChannel("")
	if err := r.AddClientsRole(nil); err != nil {
		t.Fatal(err)
	}
	if err := r.PublishClients(nil, map[string][]byte{"clients/channel.json": []byte(`{"v":1}`)}); err != nil {
		t.Fatal(err)
	}
	files, err := e.pub.BootstrapFiles()
	if err != nil {
		t.Fatal(err)
	}
	kinds := map[string]int{}
	for _, f := range files {
		kinds[f.Kind]++
	}
	if kinds["tuple"] != 2 || kinds["index"] < 4 || kinds["blob"] == 0 || kinds["client"] != 1 {
		t.Fatalf("the files the metadata names: %v", kinds)
	}
	// Other bytes of the same length already under one blob's name.
	var blob devtuf.ReleaseFile
	for _, f := range files {
		if f.Kind == "blob" {
			blob = f
			break
		}
	}
	e.gh.PutAsset(blob.Tag, blob.Name, make([]byte, blob.Length))

	bad, _ := ghpublish.New(ghpublish.Config{Dir: e.dir, Owner: "CybexBV", Repo: "whombat-releases", APIURL: e.gh.APIURL, Token: "wrong",
		Backoff: time.Millisecond})
	if _, err := bad.InitClone(e.ctx, e.origin); err == nil {
		t.Fatal("initialized with a bad token")
	}
	if _, err := os.Stat(filepath.Join(e.dir, ".git")); !os.IsNotExist(err) {
		t.Fatalf("a failed upload left a git repository: %v", err)
	}
	if out, _ := exec.Command("git", "-C", e.origin, "rev-parse", "--verify", "-q", "main").Output(); len(out) != 0 {
		t.Fatal("metadata pushed although its files aren't on GitHub")
	}
	if _, err := e.pub.InitClone(e.ctx, e.origin); err != nil {
		t.Fatal(err)
	}
	if err := e.pub.Verify(e.ctx, files); err != nil {
		t.Fatalf("after gh-init: %v", err)
	}
	for _, id := range ids {
		if len(e.gh.AssetNames(id)) == 0 {
			t.Fatalf("no assets for %s", id)
		}
	}
	if len(e.gh.AssetNames("clients")) != 1 || !strings.Contains(pushedFiles(t, e.dir), ".clients.json") {
		t.Fatalf("clients assets %v", e.gh.AssetNames("clients"))
	}
	if !strings.Contains(strings.Join(e.logs, "\n"), "removing the broken asset "+blob.Tag+"/"+blob.Name) {
		t.Fatalf("the asset of other bytes wasn't replaced: %v", e.logs)
	}
	// Verify names a file GitHub doesn't have.
	missing := blob
	missing.Name = "0000." + blob.Name
	if err := e.pub.Verify(e.ctx, []devtuf.ReleaseFile{missing}); err == nil || !strings.Contains(err.Error(), missing.Name) {
		t.Fatalf("a missing file verified: %v", err)
	}
}

// The key ceremony (ONE-05) goes up like a publish: the new root and the top-level targets the new key signed are
// pushed and nothing else; no key file is in the clone's history; a second ceremony has no root key to sign with.
func TestKeyCeremonyPushed(t *testing.T) {
	e := setup(t, 1<<20)
	out := filepath.Join(t.TempDir(), "offline")
	gh, res, err := e.pub.Rotate(e.ctx, devtuf.RotateOptions{OfflineDir: out})
	if err != nil {
		t.Fatal(err)
	}
	if keys := keyNames(t, e.dir); slicesContain(keys, "root-0.json") || slicesContain(keys, "targets-0.json") {
		t.Fatalf("the old root and targets keys are still online after the push: %v", keys)
	}
	if !gh.MetadataPushed || len(gh.Uploaded) != 0 {
		t.Fatalf("result %+v", gh)
	}
	files := pushedFiles(t, e.dir)
	for _, m := range res.Metadata {
		if !strings.Contains(files, "metadata/"+m+"\n") {
			t.Fatalf("%s isn't pushed:\n%s", m, files)
		}
	}
	tracked, err := exec.Command("git", "-C", e.dir, "log", "--all", "--name-only", "--format=").Output()
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range strings.Fields(string(tracked)) {
		if !strings.HasPrefix(f, "metadata/") && f != ".gitignore" {
			t.Fatalf("the clone's history holds %s", f)
		}
	}
	if _, _, err := e.pub.Rotate(e.ctx, devtuf.RotateOptions{OfflineDir: filepath.Join(t.TempDir(), "again")}); !errors.Is(err, devtuf.ErrCeremony) {
		t.Fatalf("a second ceremony without the root key: %v", err)
	}
}

// keyNames lists the repository's online keys folder.
func keyNames(t *testing.T, dir string) []string {
	t.Helper()
	entries, err := os.ReadDir(filepath.Join(dir, "keys"))
	if err != nil {
		t.Fatal(err)
	}
	var out []string
	for _, x := range entries {
		out = append(out, x.Name())
	}
	return out
}

// A ceremony whose push GitHub refused (R1 #4): the old keys stay online, and the same command run again pushes what
// is signed without signing again; only then are the old keys retired.
func TestKeyCeremonyPushRefused(t *testing.T) {
	e := setup(t, 1<<20)
	hook := filepath.Join(e.origin, "hooks", "pre-receive")
	if err := os.WriteFile(hook, []byte("#!/bin/sh\nexit 1\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	out := filepath.Join(t.TempDir(), "offline")
	signed := 0
	ceremony := func(r *devtuf.Repo) error {
		signed++
		_, err := r.RotateTopLevel(devtuf.RotateOptions{OfflineDir: out})
		return err
	}
	before := pushedFiles(t, e.dir)
	if _, err := e.pub.Publish(e.ctx, "root", "", ceremony); err == nil {
		t.Fatal("pushed although the remote refused it")
	}
	if pushedFiles(t, e.dir) != before {
		t.Fatal("the new root reached the remote")
	}
	if keys := keyNames(t, e.dir); !slicesContain(keys, "root-0.json") || !slicesContain(keys, "targets-0.json") {
		t.Fatalf("the old keys went before the push: %v", keys)
	}
	// Run again, still refused: nothing is signed a second time.
	if _, err := e.pub.Publish(e.ctx, "root", "", ceremony); err == nil {
		t.Fatal("pushed although the remote still refuses it")
	}
	os.Remove(hook)
	gh, _, err := e.pub.Rotate(e.ctx, devtuf.RotateOptions{OfflineDir: out})
	if err != nil || !gh.MetadataPushed {
		t.Fatalf("the push after the refusal: %+v %v", gh, err)
	}
	n := 0
	for _, l := range e.logs {
		if l == "signing: root" {
			n++
		}
	}
	if signed != 1 || n != 1 {
		t.Fatalf("the ceremony signed %d times (%d signings logged)", signed, n)
	}
	files := pushedFiles(t, e.dir)
	for _, m := range []string{"metadata/2.root.json\n", "metadata/root.json\n"} {
		if !strings.Contains(files, m) {
			t.Fatalf("%s isn't pushed:\n%s", m, files)
		}
	}
	if keys := keyNames(t, e.dir); slicesContain(keys, "root-0.json") || slicesContain(keys, "targets-0.json") {
		t.Fatalf("the old keys are still online after the push: %v", keys)
	}
	if out, _ := exec.Command("git", "-C", e.dir, "status", "--porcelain", "--", "metadata").Output(); len(out) != 0 {
		t.Fatalf("signed files left unpushed:\n%s", out)
	}
}

// A promotion whose push GitHub refused is pushed by the next gh-promote, which promote always runs again (R2 A10);
// one run more changes nothing.
func TestPromotionPushedOnRetry(t *testing.T) {
	e := setup(t, 0)
	id := "whombat-dev-20261118.1"
	if _, err := e.pub.Publish(e.ctx, trust.ChannelDevelopment, id, fakeRelease(id, "26.05.1", "1.0.0", 0)); err != nil {
		t.Fatal(err)
	}
	hook := filepath.Join(e.origin, "hooks", "pre-receive")
	if err := os.WriteFile(hook, []byte("#!/bin/sh\nexit 1\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	before := pushedFiles(t, e.dir)
	if _, err := e.pub.Promote(e.ctx, id, nil); err == nil {
		t.Fatal("promoted although the remote refused the push")
	}
	os.Remove(hook)
	r, err := e.pub.Promote(e.ctx, id, nil)
	if err != nil || !r.MetadataPushed {
		t.Fatalf("the retry: %+v %v", r, err)
	}
	after := pushedFiles(t, e.dir)
	if after == before || !strings.Contains(after, ".production.json") {
		t.Fatalf("the production role wasn't pushed:\n%s", after)
	}
	again, err := e.pub.Promote(e.ctx, id, nil)
	if err != nil || again.MetadataPushed {
		t.Fatalf("once more: %+v %v", again, err)
	}
	if out, _ := exec.Command("git", "-C", e.dir, "status", "--porcelain", "--", "metadata").Output(); len(out) != 0 {
		t.Fatalf("signed files left unpushed:\n%s", out)
	}
}

func TestChannelPauseAndResumePushOnlyMetadata(t *testing.T) {
	e := setup(t, 0)
	uploadsBefore := e.gh.APICalls["POST uploads"]
	res, pr, err := e.pub.PauseChannel(e.ctx, trust.ChannelProduction, nil)
	if err != nil || !res.MetadataPushed || pr == nil || !pr.Paused || pr.Already {
		t.Fatalf("pause: %+v %+v %v", res, pr, err)
	}
	if e.gh.APICalls["POST uploads"] != uploadsBefore {
		t.Fatalf("pause uploaded assets: %v", e.gh.APICalls)
	}
	if files := pushedFiles(t, e.dir); !strings.Contains(files, fmt.Sprintf("metadata/%d.production.json", pr.Version)) {
		t.Fatalf("paused role not pushed:\n%s", files)
	}
	// Repeating pause pushes nothing.
	res2, pr2, err := e.pub.PauseChannel(e.ctx, trust.ChannelProduction, nil)
	if err != nil || res2.MetadataPushed || pr2 == nil || !pr2.Already {
		t.Fatalf("repeat pause: %+v %+v %v", res2, pr2, err)
	}
	// Resume pushes the new version, then repeating pushes nothing.
	res3, pr3, err := e.pub.ResumeChannel(e.ctx, trust.ChannelProduction, nil)
	if err != nil || !res3.MetadataPushed || pr3 == nil || pr3.Paused || pr3.Already {
		t.Fatalf("resume: %+v %+v %v", res3, pr3, err)
	}
	if e.gh.APICalls["POST uploads"] != uploadsBefore {
		t.Fatalf("resume uploaded assets: %v", e.gh.APICalls)
	}
	if out, _ := exec.Command("git", "-C", e.dir, "status", "--porcelain", "--", "metadata").Output(); len(out) != 0 {
		t.Fatalf("signed files left unpushed:\n%s", out)
	}
}

// loadRemoteClone checks out origin/main into a temporary directory wired with e.dir's state.json
// so tests can inspect the exact published metadata on the remote branch independently of e.dir.
func loadRemoteClone(t *testing.T, e *env) *devtuf.Repo {
	t.Helper()
	tmp := t.TempDir()
	if out, err := exec.Command("git", "clone", "-q", "-b", "main", e.origin, tmp).CombinedOutput(); err != nil {
		t.Fatalf("clone remote: %v %s", err, out)
	}
	b, err := os.ReadFile(filepath.Join(e.dir, "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(tmp, "state.json"), b, 0o600); err != nil {
		t.Fatal(err)
	}
	r, err := devtuf.Load(tmp, devtuf.Options{KeysDir: filepath.Join(e.dir, "keys")})
	if err != nil {
		t.Fatal(err)
	}
	return r
}

func releaseIDs(t *testing.T, r *devtuf.Repo, channel string) []string {
	t.Helper()
	rs, err := r.ChannelReleases(channel)
	if err != nil {
		t.Fatal(err)
	}
	out := make([]string, 0, len(rs))
	for _, x := range rs {
		out = append(out, x.ID)
	}
	return out
}

// An active upload holding .publish.lock must not block an emergency pause on the same channel,
// the pause must sign only from already-published metadata (never carrying the uploading release),
// and when the upload finishes it must re-check published metadata and refuse to push its stale
// signature so it cannot overwrite the pause or reuse a lower/equal version.
func TestPauseDuringActiveUploadSameChannel(t *testing.T) {
	for _, tc := range []struct {
		name         string
		noOnlineKeys bool
	}{
		{name: "local-online-keys", noOnlineKeys: false},
		{name: "workflow-online-keys", noOnlineKeys: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			hook := &duringUpload{}
			e := setupWith(t, 0, func(c *ghpublish.Config) { c.HTTP = &http.Client{Transport: hook} })
			if tc.noOnlineKeys {
				withClientsRole(t, e)
			}
			r1 := "whombat-dev-20261118.1"
			if _, err := e.pub.Publish(e.ctx, trust.ChannelDevelopment, r1, fakeRelease(r1, "26.05.1", "1.0.0", 0)); err != nil {
				t.Fatal(err)
			}
			beforeVer := loadRemoteClone(t, e).RoleVersions()[trust.ChannelDevelopment]

			var (
				pauseRes  *ghpublish.Result
				pauseInfo *devtuf.ChannelPauseResult
				pauseErr  error
				repeatRes *ghpublish.Result
				repeatInf *devtuf.ChannelPauseResult
				repeatErr error
			)
			hook.f = func() {
				// Runs while Publish(r2) holds .publish.lock and is uploading assets.
				pauseRes, pauseInfo, pauseErr = e.pub.PauseChannel(e.ctx, trust.ChannelDevelopment, nil)
				repeatRes, repeatInf, repeatErr = e.pub.PauseChannel(e.ctx, trust.ChannelDevelopment, nil)
			}

			r2 := "whombat-dev-20261118.2"
			_, pubErr := e.pub.Publish(e.ctx, trust.ChannelDevelopment, r2, fakeRelease(r2, "26.05.1", "1.1.0", 0))
			if pauseErr != nil || pauseRes == nil || !pauseRes.MetadataPushed || pauseInfo == nil || !pauseInfo.Paused || pauseInfo.Already {
				t.Fatalf("pause during upload: res=%+v info=%+v err=%v", pauseRes, pauseInfo, pauseErr)
			}
			if pauseInfo.Version != beforeVer+1 {
				t.Fatalf("pause version = %d, want %d", pauseInfo.Version, beforeVer+1)
			}
			if repeatErr != nil || repeatRes == nil || repeatRes.MetadataPushed || repeatInf == nil || !repeatInf.Already {
				t.Fatalf("repeat pause during upload: res=%+v info=%+v err=%v", repeatRes, repeatInf, repeatErr)
			}
			if pubErr == nil {
				t.Fatal("in-flight publish succeeded after same-channel pause; expected refusal")
			}

			// Remote must stay paused at beforeVer+1 with ONLY r1 (never r2).
			rem := loadRemoteClone(t, e)
			if !rem.ChannelPaused(trust.ChannelDevelopment) {
				t.Fatal("pause was overwritten on remote")
			}
			if got := rem.RoleVersions()[trust.ChannelDevelopment]; got != beforeVer+1 {
				t.Fatalf("remote development version = %d, want %d", got, beforeVer+1)
			}
			if ids := releaseIDs(t, rem, trust.ChannelDevelopment); len(ids) != 1 || ids[0] != r1 {
				t.Fatalf("remote development releases = %v, want [%s]", ids, r1)
			}
			if _, err := os.Stat(filepath.Join(e.dir, ".publish-pending.json")); !os.IsNotExist(err) {
				t.Fatalf("stale pending record still present: %v", err)
			}

			// Publishing r2 again now signs strictly above the pause version, preserves paused=true (UP-X50),
			// and skips the assets already uploaded.
			res2, err := e.pub.Publish(e.ctx, trust.ChannelDevelopment, r2, fakeRelease(r2, "26.05.1", "1.1.0", 0))
			if err != nil || !res2.MetadataPushed || len(res2.Uploaded) != 0 || res2.Present == 0 {
				t.Fatalf("re-publish after pause: %+v %v", res2, err)
			}
			rem = loadRemoteClone(t, e)
			if !rem.ChannelPaused(trust.ChannelDevelopment) {
				t.Fatal("re-publish into paused channel cleared paused marker")
			}
			if got := rem.RoleVersions()[trust.ChannelDevelopment]; got != beforeVer+2 {
				t.Fatalf("remote development version after re-publish = %d, want %d", got, beforeVer+2)
			}
			if ids := releaseIDs(t, rem, trust.ChannelDevelopment); len(ids) != 2 || ids[1] != r2 {
				t.Fatalf("remote development releases = %v, want [%s %s]", ids, r1, r2)
			}

			// Resume advances monotonically above the re-published version.
			res3, pr3, err := e.pub.ResumeChannel(e.ctx, trust.ChannelDevelopment, nil)
			if err != nil || !res3.MetadataPushed || pr3.Paused || pr3.Version != beforeVer+3 {
				t.Fatalf("resume: res=%+v info=%+v err=%v", res3, pr3, err)
			}
			rem = loadRemoteClone(t, e)
			if rem.ChannelPaused(trust.ChannelDevelopment) || rem.RoleVersions()[trust.ChannelDevelopment] != beforeVer+3 {
				t.Fatalf("remote after resume: paused=%v ver=%d", rem.ChannelPaused(trust.ChannelDevelopment), rem.RoleVersions()[trust.ChannelDevelopment])
			}
		})
	}
}

// A failed upload leaves .publish-pending.json and signed unpushed metadata on disk. Both gh-pause
// and gh-resume must still succeed from published metadata, and retrying the unfinished publish
// without re-signing must refuse rather than reuse a lower version or overwrite the pause.
func TestPauseAndResumeWhileFailedPublishPendingSameChannel(t *testing.T) {
	e := setup(t, 0)
	r1, r2 := "whombat-dev-20261118.1", "whombat-dev-20261118.2"
	if _, err := e.pub.Publish(e.ctx, trust.ChannelDevelopment, r1, fakeRelease(r1, "26.05.1", "1.0.0", 0)); err != nil {
		t.Fatal(err)
	}
	v1 := loadRemoteClone(t, e).RoleVersions()[trust.ChannelDevelopment]

	bad, _ := ghpublish.New(ghpublish.Config{Dir: e.dir, Owner: "CybexBV", Repo: "whombat-releases", APIURL: e.gh.APIURL, Token: "wrong",
		Backoff: time.Millisecond})
	if _, err := bad.Publish(e.ctx, trust.ChannelDevelopment, r2, fakeRelease(r2, "26.05.1", "1.1.0", 0)); err == nil {
		t.Fatal("published with bad token")
	}

	// Emergency pause succeeds even though r2 left .publish-pending.json and signed v1+1 on disk.
	pres, pinfo, err := e.pub.PauseChannel(e.ctx, trust.ChannelDevelopment, nil)
	if err != nil || !pres.MetadataPushed || !pinfo.Paused || pinfo.Version != v1+1 {
		t.Fatalf("pause with pending publish: res=%+v info=%+v err=%v", pres, pinfo, err)
	}
	rem := loadRemoteClone(t, e)
	if !rem.ChannelPaused(trust.ChannelDevelopment) || len(releaseIDs(t, rem, trust.ChannelDevelopment)) != 1 {
		t.Fatalf("remote after pause: paused=%v releases=%v", rem.ChannelPaused(trust.ChannelDevelopment), releaseIDs(t, rem, trust.ChannelDevelopment))
	}

	// Resume also succeeds while r2 is still pending, advancing remote to v1+2 (strictly above r2's signed v1+1).
	rres, rinfo, err := e.pub.ResumeChannel(e.ctx, trust.ChannelDevelopment, nil)
	if err != nil || !rres.MetadataPushed || rinfo.Paused || rinfo.Version != v1+2 {
		t.Fatalf("resume with pending publish: res=%+v info=%+v err=%v", rres, rinfo, err)
	}

	// Retrying r2 with nil signer (attempting to push stale v1+1) must refuse and discard stale metadata.
	if _, err := e.pub.Publish(e.ctx, trust.ChannelDevelopment, r2, nil); err == nil {
		t.Fatal("resuming stale pre-pause signature succeeded; would reuse lower version")
	}
	rem = loadRemoteClone(t, e)
	if got := rem.RoleVersions()[trust.ChannelDevelopment]; got != v1+2 {
		t.Fatalf("remote development version = %d, want %d", got, v1+2)
	}
	if ids := releaseIDs(t, rem, trust.ChannelDevelopment); len(ids) != 1 || ids[0] != r1 {
		t.Fatalf("remote releases = %v, want [%s]", ids, r1)
	}

	// Running r2 again with a signer signs strictly above v1+2 (at v1+3) and succeeds.
	res, err := e.pub.Publish(e.ctx, trust.ChannelDevelopment, r2, fakeRelease(r2, "26.05.1", "1.1.0", 0))
	if err != nil || !res.MetadataPushed {
		t.Fatalf("re-publishing r2 with signer: %+v %v", res, err)
	}
	rem = loadRemoteClone(t, e)
	if got := rem.RoleVersions()[trust.ChannelDevelopment]; got != v1+3 {
		t.Fatalf("remote development version after re-publish = %d, want %d", got, v1+3)
	}
	if ids := releaseIDs(t, rem, trust.ChannelDevelopment); len(ids) != 2 || ids[1] != r2 {
		t.Fatalf("remote releases = %v, want [%s %s]", ids, r1, r2)
	}
}

// Pausing one channel (e.g. production) while another channel (development) has an active or failed
// upload must succeed immediately, and the other channel's publish must finish cleanly without
// overwriting the pause or rolling back snapshot/timestamp versions — and without leaking an
// unpushed clients role.
func TestPauseOtherChannelWhilePublishPendingPreservesBoth(t *testing.T) {
	for _, tc := range []struct {
		name         string
		noOnlineKeys bool
	}{
		{name: "local-online-keys", noOnlineKeys: false},
		{name: "workflow-online-keys-with-dirty-clients", noOnlineKeys: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			hook := &duringUpload{}
			e := setupWith(t, 0, func(c *ghpublish.Config) { c.HTTP = &http.Client{Transport: hook} })
			if tc.noOnlineKeys {
				withClientsRole(t, e)
			}
			r1, r2 := "whombat-dev-20261118.1", "whombat-dev-20261118.2"
			if _, err := e.pub.Publish(e.ctx, trust.ChannelDevelopment, r1, fakeRelease(r1, "26.05.1", "1.0.0", 0)); err != nil {
				t.Fatal(err)
			}
			var pauseErr error
			hook.f = func() {
				if tc.noOnlineKeys {
					signClients(t, e.dir, `{"v":2}`)
				}
				_, _, pauseErr = e.pub.PauseChannel(e.ctx, trust.ChannelProduction, nil)
			}
			res, err := e.pub.Publish(e.ctx, trust.ChannelDevelopment, r2, fakeRelease(r2, "26.05.1", "1.1.0", 0))
			if pauseErr != nil {
				t.Fatalf("pause production during development upload: %v", pauseErr)
			}
			if err != nil || !res.MetadataPushed {
				t.Fatalf("development publish after production pause: %+v %v", res, err)
			}
			rem := loadRemoteClone(t, e)
			if !rem.ChannelPaused(trust.ChannelProduction) {
				t.Fatal("production pause was lost after development publish finished")
			}
			if rem.ChannelPaused(trust.ChannelDevelopment) {
				t.Fatal("development should remain unpaused")
			}
			if ids := releaseIDs(t, rem, trust.ChannelDevelopment); len(ids) != 2 || ids[1] != r2 {
				t.Fatalf("development releases = %v, want [%s %s]", ids, r1, r2)
			}
			if tc.noOnlineKeys {
				if got := pushedClientsRoles(t, e.dir); slicesContain(got, "2.clients.json") {
					t.Fatalf("unpushed clients role leaked during interleaved pause+publish: %v", got)
				}
				if cres, err := e.pub.UploadClients(e.ctx); err != nil || !cres.MetadataPushed {
					t.Fatalf("gh-clients afterwards: %+v %v", cres, err)
				}
				if got := pushedClientsRoles(t, e.dir); !slicesContain(got, "2.clients.json") {
					t.Fatalf("clients role not pushed by gh-clients: %v", got)
				}
			}
		})
	}
}

// A publish that already committed locally before its push failed (HEAD ahead of origin/main) must
// not leak into an emergency pause, and retrying that stale local commit without re-signing must
// refuse and drop the stale commit rather than overwrite the pause.
func TestPauseWhileLocalCommitPushFailedSameChannel(t *testing.T) {
	e := setup(t, 0)
	r1, r2 := "whombat-dev-20261118.1", "whombat-dev-20261118.2"
	if _, err := e.pub.Publish(e.ctx, trust.ChannelDevelopment, r1, fakeRelease(r1, "26.05.1", "1.0.0", 0)); err != nil {
		t.Fatal(err)
	}
	v1 := loadRemoteClone(t, e).RoleVersions()[trust.ChannelDevelopment]

	hook := filepath.Join(e.origin, "hooks", "pre-receive")
	if err := os.WriteFile(hook, []byte("#!/bin/sh\nexit 1\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := e.pub.Publish(e.ctx, trust.ChannelDevelopment, r2, fakeRelease(r2, "26.05.1", "1.1.0", 0)); err == nil {
		t.Fatal("published although pre-receive refused push")
	}
	os.Remove(hook)

	// Emergency pause signs from origin/main (r1 only, NOT the unpushed local commit of r2).
	pres, pinfo, err := e.pub.PauseChannel(e.ctx, trust.ChannelDevelopment, nil)
	if err != nil || !pres.MetadataPushed || !pinfo.Paused || pinfo.Version != v1+1 {
		t.Fatalf("pause with unpushed local commit: res=%+v info=%+v err=%v", pres, pinfo, err)
	}
	rem := loadRemoteClone(t, e)
	if !rem.ChannelPaused(trust.ChannelDevelopment) || len(releaseIDs(t, rem, trust.ChannelDevelopment)) != 1 {
		t.Fatalf("remote after pause: paused=%v releases=%v", rem.ChannelPaused(trust.ChannelDevelopment), releaseIDs(t, rem, trust.ChannelDevelopment))
	}

	// Retrying the stale local commit without re-signing must refuse and reset cleanly to remote.
	if _, err := e.pub.Publish(e.ctx, trust.ChannelDevelopment, r2, nil); err == nil {
		t.Fatal("retry pushed stale local commit over pause")
	}
	rem = loadRemoteClone(t, e)
	if !rem.ChannelPaused(trust.ChannelDevelopment) || rem.RoleVersions()[trust.ChannelDevelopment] != v1+1 {
		t.Fatalf("remote after refused retry: paused=%v ver=%d", rem.ChannelPaused(trust.ChannelDevelopment), rem.RoleVersions()[trust.ChannelDevelopment])
	}

	// Re-publishing with a signer advances monotonically to v1+2 while keeping development paused.
	res, err := e.pub.Publish(e.ctx, trust.ChannelDevelopment, r2, fakeRelease(r2, "26.05.1", "1.1.0", 0))
	if err != nil || !res.MetadataPushed {
		t.Fatalf("re-publish after dropped stale commit: %+v %v", res, err)
	}
	rem = loadRemoteClone(t, e)
	if !rem.ChannelPaused(trust.ChannelDevelopment) || rem.RoleVersions()[trust.ChannelDevelopment] != v1+2 {
		t.Fatalf("remote after re-publish: paused=%v ver=%d", rem.ChannelPaused(trust.ChannelDevelopment), rem.RoleVersions()[trust.ChannelDevelopment])
	}
}

// Emergency pause must also work while gh-clients is actively uploading (holding .publish.lock) or
// when an unpushed clients role sits dirty in metadata/, without pushing or losing that clients role.
func TestPauseDuringClientsUpload(t *testing.T) {
	hook := &duringUpload{}
	e := setupWith(t, 0, func(c *ghpublish.Config) { c.HTTP = &http.Client{Transport: hook} })
	withClientsRole(t, e)
	signClients(t, e.dir, `{"v":2}`)

	// Pause while dirty 2.clients.json sits unpushed on disk.
	pres, pinfo, err := e.pub.PauseChannel(e.ctx, trust.ChannelProduction, nil)
	if err != nil || !pres.MetadataPushed || !pinfo.Paused {
		t.Fatalf("pause with dirty clients role: res=%+v info=%+v err=%v", pres, pinfo, err)
	}
	if got := pushedClientsRoles(t, e.dir); slicesContain(got, "2.clients.json") {
		t.Fatalf("pause pushed unpushed clients role: %v", got)
	}

	// Resume during an active gh-clients upload.
	var resumeErr error
	hook.f = func() {
		_, _, resumeErr = e.pub.ResumeChannel(e.ctx, trust.ChannelProduction, nil)
	}
	cres, err := e.pub.UploadClients(e.ctx)
	if resumeErr != nil {
		t.Fatalf("resume during gh-clients upload: %v", resumeErr)
	}
	if err != nil || !cres.MetadataPushed {
		t.Fatalf("gh-clients: %+v %v", cres, err)
	}
	rem := loadRemoteClone(t, e)
	if rem.ChannelPaused(trust.ChannelProduction) {
		t.Fatal("production resume was lost after gh-clients finished")
	}
	if got := pushedClientsRoles(t, e.dir); !slicesContain(got, "2.clients.json") {
		t.Fatalf("clients role not pushed: %v", got)
	}
}

// Even when a publish failed before recording BaseVersions or Files (or when an older release tool
// wrote a minimal .publish-pending.json), a pre-pause signature must still be refused after a pause.
func TestPauseInvalidatesMinimalPendingRecord(t *testing.T) {
	e := setup(t, 0)
	withClientsRole(t, e)
	id := "whombat-dev-20261118.1"
	pending := filepath.Join(e.dir, ".publish-pending.json")
	if err := os.WriteFile(pending, []byte(`{"channel":"development","releaseId":"`+id+`"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	r, err := devtuf.Load(e.dir, devtuf.Options{})
	if err != nil {
		t.Fatal(err)
	}
	if err := fakeRelease(id, "26.05.1", "1.0.0", 0)(r); err != nil {
		t.Fatal(err)
	}
	signClients(t, e.dir, `{"v":2}`)

	// Emergency pause pushes v2 (paused, no releases) from origin/main.
	pres, pinfo, err := e.pub.PauseChannel(e.ctx, trust.ChannelDevelopment, nil)
	if err != nil || !pres.MetadataPushed || !pinfo.Paused {
		t.Fatalf("pause: res=%+v info=%+v err=%v", pres, pinfo, err)
	}
	// Resuming the minimal pending record without re-signing must refuse and leave 2.clients.json intact.
	if _, err := e.pub.Publish(e.ctx, trust.ChannelDevelopment, id, nil); err == nil {
		t.Fatal("minimal pending record pushed over pause")
	}
	rem := loadRemoteClone(t, e)
	if !rem.ChannelPaused(trust.ChannelDevelopment) || len(releaseIDs(t, rem, trust.ChannelDevelopment)) != 0 {
		t.Fatalf("remote after refused minimal retry: paused=%v releases=%v", rem.ChannelPaused(trust.ChannelDevelopment), releaseIDs(t, rem, trust.ChannelDevelopment))
	}
	if got := pushedClientsRoles(t, e.dir); slicesContain(got, "2.clients.json") {
		t.Fatalf("clients role leaked: %v", got)
	}
	if cres, err := e.pub.UploadClients(e.ctx); err != nil || !cres.MetadataPushed {
		t.Fatalf("gh-clients after refused retry: %+v %v", cres, err)
	}
}

// When a stalled publish (r2) is superseded by an emergency pause on the same channel, the operator
// can immediately publish a different fix release (r3) into the paused channel without manual git
// surgery, and r3 advances monotonically above the pause while keeping the channel paused (and
// never carrying stalled r2).
func TestFixReleaseCanPublishAfterPauseOverStalledUpload(t *testing.T) {
	e := setup(t, 0)
	r1, r2, r3 := "whombat-dev-20261118.1", "whombat-dev-20261118.2", "whombat-dev-20261118.3"
	if _, err := e.pub.Publish(e.ctx, trust.ChannelDevelopment, r1, fakeRelease(r1, "26.05.1", "1.0.0", 0)); err != nil {
		t.Fatal(err)
	}
	v1 := loadRemoteClone(t, e).RoleVersions()[trust.ChannelDevelopment]

	bad, _ := ghpublish.New(ghpublish.Config{Dir: e.dir, Owner: "CybexBV", Repo: "whombat-releases", APIURL: e.gh.APIURL, Token: "wrong",
		Backoff: time.Millisecond})
	if _, err := bad.Publish(e.ctx, trust.ChannelDevelopment, r2, fakeRelease(r2, "26.05.1", "1.1.0", 0)); err == nil {
		t.Fatal("published with bad token")
	}

	pres, pinfo, err := e.pub.PauseChannel(e.ctx, trust.ChannelDevelopment, nil)
	if err != nil || !pres.MetadataPushed || !pinfo.Paused || pinfo.Version != v1+1 {
		t.Fatalf("pause: res=%+v info=%+v err=%v", pres, pinfo, err)
	}

	res, err := e.pub.Publish(e.ctx, trust.ChannelDevelopment, r3, fakeRelease(r3, "26.05.1", "1.2.0", 0))
	if err != nil || !res.MetadataPushed {
		t.Fatalf("publish fix r3 after pause: %+v %v", res, err)
	}
	rem := loadRemoteClone(t, e)
	if !rem.ChannelPaused(trust.ChannelDevelopment) {
		t.Fatal("fix release cleared paused marker")
	}
	if got := rem.RoleVersions()[trust.ChannelDevelopment]; got != v1+2 {
		t.Fatalf("development version = %d, want %d", got, v1+2)
	}
	if ids := releaseIDs(t, rem, trust.ChannelDevelopment); len(ids) != 2 || ids[0] != r1 || ids[1] != r3 {
		t.Fatalf("development releases = %v, want [%s %s] (must not include stalled %s)", ids, r1, r3, r2)
	}
}

// Offline production key passed explicitly to PauseChannel works even when a promotion commit is
// stuck unpushed locally, and retrying Promote afterwards signs strictly above the pause version
// while preserving paused=true.
func TestOfflineKeyPauseDuringPendingPromote(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("no git")
	}
	t.Setenv("GIT_CONFIG_GLOBAL", os.DevNull)
	t.Setenv("GIT_CONFIG_SYSTEM", os.DevNull)
	base := t.TempDir()
	now := time.Date(2026, 11, 18, 12, 0, 0, 0, time.UTC)
	dir := filepath.Join(base, "work")
	r, err := devtuf.New(dir, devtuf.Options{Env: "local", Layout: devtuf.LayoutGitHub, Now: func() time.Time { return now }})
	if err != nil {
		t.Fatal(err)
	}
	prodKey := devtuf.NewDevKey()
	if err := r.AddChannelRoles(map[string]ed25519.PrivateKey{trust.ChannelProduction: prodKey},
		map[string]bool{trust.ChannelDevelopment: true, trust.ChannelProduction: false}); err != nil {
		t.Fatal(err)
	}
	origin := filepath.Join(base, "origin.git")
	if out, err := exec.Command("git", "init", "-q", "--bare", "-b", "main", origin).CombinedOutput(); err != nil {
		t.Fatalf("%v %s", err, out)
	}
	gh := fakegithub.New("CybexBV", "whombat-releases", "tok", filepath.Join(base, "pages"))
	defer gh.Close()
	pub, err := ghpublish.New(ghpublish.Config{Dir: dir, Owner: "CybexBV", Repo: "whombat-releases", APIURL: gh.APIURL, Token: "tok", Backoff: time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pub.InitClone(context.Background(), origin); err != nil {
		t.Fatal(err)
	}
	e := &env{ctx: context.Background(), gh: gh, pub: pub, dir: dir, origin: origin}

	r1 := "whombat-dev-20261118.1"
	if _, err := pub.Publish(e.ctx, trust.ChannelDevelopment, r1, fakeRelease(r1, "26.05.1", "1.0.0", 0)); err != nil {
		t.Fatal(err)
	}
	vProd := loadRemoteClone(t, e).RoleVersions()[trust.ChannelProduction]

	hook := filepath.Join(origin, "hooks", "pre-receive")
	if err := os.WriteFile(hook, []byte("#!/bin/sh\nexit 1\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := pub.Promote(e.ctx, r1, prodKey); err == nil {
		t.Fatal("promote succeeded despite failing pre-receive hook")
	}
	os.Remove(hook)

	// Emergency pause with the offline production key succeeds and publishes vProd+1 (paused, no r1).
	pres, pinfo, err := pub.PauseChannel(e.ctx, trust.ChannelProduction, prodKey)
	if err != nil || !pres.MetadataPushed || !pinfo.Paused || pinfo.Version != vProd+1 {
		t.Fatalf("pause production with offline key: res=%+v info=%+v err=%v", pres, pinfo, err)
	}
	rem := loadRemoteClone(t, e)
	if !rem.ChannelPaused(trust.ChannelProduction) || len(releaseIDs(t, rem, trust.ChannelProduction)) != 0 {
		t.Fatalf("remote production after pause: paused=%v releases=%v", rem.ChannelPaused(trust.ChannelProduction), releaseIDs(t, rem, trust.ChannelProduction))
	}

	// Retrying Promote now discards the stale pre-pause commit, signs vProd+2 with paused=true, and pushes.
	res, err := pub.Promote(e.ctx, r1, prodKey)
	if err != nil || !res.MetadataPushed {
		t.Fatalf("retry promote after pause: %+v %v", res, err)
	}
	rem = loadRemoteClone(t, e)
	if !rem.ChannelPaused(trust.ChannelProduction) || rem.RoleVersions()[trust.ChannelProduction] != vProd+2 {
		t.Fatalf("remote production after retry promote: paused=%v ver=%d", rem.ChannelPaused(trust.ChannelProduction), rem.RoleVersions()[trust.ChannelProduction])
	}
	if ids := releaseIDs(t, rem, trust.ChannelProduction); len(ids) != 1 || ids[0] != r1 {
		t.Fatalf("remote production releases = %v, want [%s]", ids, r1)
	}
}
