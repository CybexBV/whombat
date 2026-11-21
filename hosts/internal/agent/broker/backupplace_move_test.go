package broker

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"rackoon/internal/proto"
)

// recordFS is directFS that logs what it does; copyHook, when set, runs
// after a copy (to spoil it).
type recordFS struct {
	directFS
	mu       sync.Mutex
	log      []string
	copyHook func(src, dst string) error
}

func (r *recordFS) add(s string) {
	r.mu.Lock()
	r.log = append(r.log, s)
	r.mu.Unlock()
}

func (r *recordFS) copyTree(ctx context.Context, src, dst string) error {
	r.add("copy " + src + " " + dst)
	if err := r.directFS.copyTree(ctx, src, dst); err != nil {
		return err
	}
	if r.copyHook != nil {
		return r.copyHook(src, dst)
	}
	return nil
}

func (r *recordFS) rename(ctx context.Context, from, to string) error {
	r.add("rename " + from + " " + to)
	return r.directFS.rename(ctx, from, to)
}

func (r *recordFS) removeAll(ctx context.Context, p string) error {
	r.add("rmtree " + p)
	return r.directFS.removeAll(ctx, p)
}

func (r *recordFS) entries() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return slices.Clone(r.log)
}

// index is the first log line with that prefix, -1 when none.
func (r *recordFS) index(prefix string) int {
	for i, l := range r.entries() {
		if strings.HasPrefix(l, prefix) {
			return i
		}
	}
	return -1
}

func writeFile(t *testing.T, p, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

func readFile(t *testing.T, p string) string {
	t.Helper()
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// moveFixture is a fake Unraid with the shares Media and system and a
// client in the dedicated share with a repository and a cleanup.
type moveFixture struct {
	u    *unraidFixture
	f    *placeFixture
	fs   *recordFS
	repo map[string]string // the repository's files (relative) → content
}

const moveClient = "whombat-home-4hxx"

func newMoveFixture(t *testing.T) *moveFixture {
	t.Helper()
	u, f := unraidPlace(t)
	for _, s := range []string{"Media", "system", "appdata"} {
		if err := os.MkdirAll(filepath.Join(f.m.userShares, s), 0o777); err != nil {
			t.Fatal(err)
		}
	}
	rfs := &recordFS{}
	f.m.fs = rfs
	mf := &moveFixture{u: u, f: f, fs: rfs, repo: map[string]string{
		"config": "repository config", "keys/k1": "a key", "data/ab/abcdef": strings.Repeat("x", 70_000),
		"snapshots/s1": "snapshot", "index/i1": "index", "locks/.keep": "",
	}}
	if _, err := f.ensure(moveClient, testRestPW, 0); err != nil {
		t.Fatal(err)
	}
	if _, err := f.m.setCleanup(context.Background(), &proto.PlaceRequest{Client: moveClient, RepositoryPassword: "repo-secret", KeepWithinDays: 30}); err != nil {
		t.Fatal(err)
	}
	for rel, c := range mf.repo {
		writeFile(t, filepath.Join(f.root, moveClient, rel), c)
	}
	writeFile(t, stateFileIn(f.root, moveClient, "cleanup.json"), `{"keep_within_days":30,"running":false,"last_run_at":null,"last_ok":null,"last_error":"","next_run_epoch":1}`)
	writeFile(t, filepath.Join(kitDirIn(f.root, moveClient), "keys", moveKitFile), `{"kind":"whombat.kit-envelope/1"}`)
	return mf
}

// moveKitFile is a kit file the kit user stored.
const moveKitFile = "8d4ee3c0f0cd0f0e2a0d1b42c3e7a2d55d0f0d1b9b2b8a5f7c2c3b2a1f0e9d8c"

func (mf *moveFixture) mediaRoot() string {
	return filepath.Join(mf.f.m.userShares, "Media", "whombat")
}

func (mf *moveFixture) ensure(loc string) (proto.PlaceResult, error) {
	return mf.f.m.ensure(context.Background(), &proto.PlaceRequest{Client: moveClient, RestPassword: testRestPW, Location: loc})
}

// checkOn checks that the client's repository and files are in a root,
// its two containers run with their binds there and the Unraid
// templates name it.
func (mf *moveFixture) checkOn(t *testing.T, root string) {
	t.Helper()
	for rel, c := range mf.repo {
		if got := readFile(t, filepath.Join(root, moveClient, rel)); got != c {
			t.Errorf("%s: %d bytes, want %d", rel, len(got), len(c))
		}
	}
	if pw := readFile(t, stateFileIn(root, moveClient, "pass")); pw != "repo-secret" {
		t.Errorf("pass = %q", pw)
	}
	if !strings.HasPrefix(readFile(t, stateFileIn(root, moveClient, "htpasswd")), moveClient+":$2") {
		t.Error("no htpasswd")
	}
	if readFile(t, filepath.Join(root, ".whombat", "cleanup.sh")) != placeCleanupScript {
		t.Error("no cleanup script")
	}
	if !strings.Contains(readFile(t, filepath.Join(kitDirIn(root, moveClient), "keys", moveKitFile)), "kit-envelope") {
		t.Error("the kit files aren't there")
	}
	srv, cl := mf.f.d.ctr("whombat-backup-"+moveClient), mf.f.d.ctr("whombat-backup-"+moveClient+"-cleanup")
	if srv == nil || cl == nil || !srv.running || !cl.running {
		t.Fatalf("containers: %+v %+v", srv, cl)
	}
	if !slices.Equal(srv.spec.HostConfig.Binds, []string{filepath.Join(root, moveClient) + ":/data/" + moveClient,
		stateFileIn(root, moveClient, "htpasswd") + ":/auth/.htpasswd:ro", kitDirIn(root, moveClient) + ":/data/kit"}) ||
		srv.spec.HostConfig.PortBindings[placeRestPort][0].HostPort != "8747" {
		t.Errorf("server = %+v", srv.spec.HostConfig)
	}
	if !slices.Equal(cl.spec.HostConfig.Binds, []string{filepath.Join(root, moveClient) + ":/data/" + moveClient, stateDirIn(root) + ":/state"}) ||
		cl.spec.Cmd[1] != "30" {
		t.Errorf("cleanup = %+v %v", cl.spec.HostConfig, cl.spec.Cmd)
	}
	for _, n := range []string{"whombat-backup-" + moveClient, "whombat-backup-" + moveClient + "-cleanup"} {
		tmpl := mf.u.read("boot/config/plugins/dockerMan/templates-user/my-" + n + ".xml")
		if !strings.Contains(tmpl, ">"+filepath.Join(root, moveClient)+"</Config>") {
			t.Errorf("template %s doesn't name %s:\n%s", n, root, tmpl)
		}
	}
}

// checkGone checks that nothing of the client is left in a root.
func (mf *moveFixture) checkGone(t *testing.T, root string) {
	t.Helper()
	if exists(filepath.Join(root, moveClient)) || exists(filepath.Join(root, "."+moveClient+".moving")) {
		t.Errorf("the backups are still in %s", root)
	}
	if left := clientStateFiles(root, moveClient); len(left) > 0 {
		t.Errorf("files left in %s: %v", root, left)
	}
	if exists(kitDirIn(root, moveClient)) {
		t.Errorf("the kit folder is still in %s", root)
	}
}

func TestPlaceLocationRoots(t *testing.T) {
	mf := newMoveFixture(t)
	m := mf.f.m
	for id, want := range map[string]string{
		proto.PlaceShareName: mf.f.root,
		"Media":              mf.mediaRoot(),
		"appdata":            filepath.Join(m.userShares, "appdata", "whombat"),
	} {
		if got, err := m.locationRoot(id); err != nil || got != want {
			t.Errorf("%s = %q %v, want %q", id, got, err, want)
		}
		if got := m.locationOf(want); got != id {
			t.Errorf("locationOf(%s) = %q, want %s", want, got, id)
		}
	}
	for _, bad := range []string{"system", "Nope", "../etc", "Media/..", ".hidden", "srv", ""} {
		if _, err := m.locationRoot(bad); placeFailure(err).FieldErrors["location"] == "" {
			t.Errorf("%q: %v", bad, err)
		}
	}
	if got := m.locationOf(filepath.Join(m.userShares, proto.PlaceShareName, "whombat")); got != "" {
		t.Errorf("the dedicated share's folder = %q", got)
	}
	// A Linux server has one location.
	l := newPlaceFixture(t)
	if r, err := l.m.locationRoot("srv"); err != nil || r != l.root {
		t.Errorf("srv = %q %v", r, err)
	}
	if _, err := l.m.locationRoot(proto.PlaceShareName); err == nil {
		t.Error("whombat-backups on Linux")
	}
	if l.m.locationOf(l.root) != "srv" {
		t.Error("the Linux root isn't srv")
	}
}

func TestPlaceEnsureInShare(t *testing.T) {
	u, f := unraidPlace(t)
	ctx := context.Background()
	media := filepath.Join(f.m.userShares, "Media")
	if err := os.MkdirAll(media, 0o777); err != nil {
		t.Fatal(err)
	}
	res, err := f.m.ensure(ctx, &proto.PlaceRequest{Client: moveClient, RestPassword: testRestPW, Location: "Media"})
	root := filepath.Join(media, "whombat")
	if err != nil || !res.Created || res.Moved || res.Location != "Media" || res.Path != filepath.Join(root, moveClient) {
		t.Fatalf("ensure = %+v %v", res, err)
	}
	if calls := emcmdCalls(u); len(calls) != 0 {
		t.Errorf("the share was changed: %q", calls)
	}
	if st, err := os.Stat(root); err != nil || st.Mode().Perm() != 0o700 {
		t.Errorf("whombat folder: %v %v", st, err)
	}
	if exists(f.root) {
		t.Error("the dedicated share was made")
	}
	if _, err := f.m.setCleanup(ctx, &proto.PlaceRequest{Client: moveClient, RepositoryPassword: "repo-secret"}); err != nil {
		t.Fatal(err)
	}
	if readFile(t, stateFileIn(root, moveClient, "pass")) != "repo-secret" {
		t.Error("pass not in the share")
	}
	bp := f.m.status(ctx)
	if len(bp.Clients) != 1 || bp.Clients[0].Location != "Media" || !bp.Clients[0].Cleanup.Set {
		t.Errorf("status = %+v", bp.Clients)
	}
	// Ensure again without a location keeps it there.
	if res, err = f.ensure(moveClient, testRestPW, 0); err != nil || res.Location != "Media" || res.Moved || res.Created {
		t.Errorf("again = %+v %v", res, err)
	}
	// Remove with the data finds it in the share.
	if _, err := f.m.remove(ctx, &proto.PlaceRequest{Client: moveClient, DeleteData: true}); err != nil {
		t.Fatal(err)
	}
	if exists(filepath.Join(root, moveClient)) || exists(stateFileIn(root, moveClient, "pass")) {
		t.Error("remove left the share's copy")
	}
	if !exists(media) {
		t.Error("the share's folder went")
	}
	// A share that isn't there.
	if _, err := f.m.ensure(ctx, &proto.PlaceRequest{Client: moveClient, RestPassword: testRestPW, Location: "Nope"}); placeFailure(err).FieldErrors["location"] == "" {
		t.Errorf("missing share: %v", err)
	}
}

func TestPlaceMove(t *testing.T) {
	mf := newMoveFixture(t)
	f := mf.f
	ctx := context.Background()
	oldRoot, newRoot := f.root, mf.mediaRoot()
	f.m.probe = func(context.Context, int) error { mf.fs.add("ready"); return nil }
	oldSrv := f.d.ctr("whombat-backup-" + moveClient)
	oldHT := readFile(t, stateFileIn(oldRoot, moveClient, "htpasswd"))

	res, err := mf.ensure("Media")
	if err != nil {
		t.Fatal(err)
	}
	if !res.Moved || res.Created || res.Port != 8747 || res.Location != "Media" || res.Path != filepath.Join(newRoot, moveClient) || !res.Kit {
		t.Fatalf("move = %+v", res)
	}
	mf.checkOn(t, newRoot)
	mf.checkGone(t, oldRoot)
	if readFile(t, stateFileIn(newRoot, moveClient, "htpasswd")) != oldHT {
		t.Error("the user's line changed")
	}
	if !exists(stateFileIn(newRoot, moveClient, "cleanup.json")) {
		t.Error("the cleanup's status didn't move")
	}
	if c := f.d.ctr("whombat-backup-" + moveClient); c.id == oldSrv.id {
		t.Error("the backup app wasn't made again")
	}
	// The old folder went only after the copy was checked, renamed and
	// the backup app answered on the new root.
	copyAt, renameAt := mf.fs.index("copy "+filepath.Join(oldRoot, moveClient)+" "), mf.fs.index("rename ")
	dropAt := mf.fs.index("rmtree " + filepath.Join(oldRoot, moveClient))
	readyAt := -1
	for i, l := range mf.fs.entries() {
		if l == "ready" && i > renameAt {
			readyAt = i
			break
		}
	}
	if copyAt < 0 || renameAt < copyAt || readyAt < renameAt || dropAt < readyAt {
		t.Errorf("order: copy %d rename %d ready %d drop %d\n%s", copyAt, renameAt, readyAt, dropAt, strings.Join(mf.fs.entries(), "\n"))
	}
	bp := f.m.status(ctx)
	if len(bp.Clients) != 1 || bp.Clients[0].Location != "Media" || bp.Clients[0].Port != 8747 || !bp.Clients[0].Cleanup.Set ||
		bp.Clients[0].Cleanup.KeepWithinDays != 30 {
		t.Errorf("status = %+v", bp.Clients)
	}

	// Without a location it stays; the same location doesn't move.
	for _, loc := range []string{"", "Media"} {
		if res, err := mf.ensure(loc); err != nil || res.Moved || res.Location != "Media" {
			t.Errorf("ensure %q = %+v %v", loc, res, err)
		}
	}
	// And back to the dedicated share.
	if res, err := mf.ensure(proto.PlaceShareName); err != nil || !res.Moved || res.Location != proto.PlaceShareName {
		t.Fatalf("back = %+v %v", res, err)
	}
	mf.checkOn(t, oldRoot)
	mf.checkGone(t, newRoot)
}

func TestPlaceMoveFailures(t *testing.T) {
	t.Run("copy differs", func(t *testing.T) {
		mf := newMoveFixture(t)
		oldSrv := mf.f.d.ctr("whombat-backup-" + moveClient)
		mf.fs.copyHook = func(src, dst string) error {
			if filepath.Base(src) == moveClient {
				return os.WriteFile(filepath.Join(dst, "data", "ab", "extra"), []byte("?"), 0o600)
			}
			return nil
		}
		_, err := mf.ensure("Media")
		if err == nil || !strings.Contains(err.Error(), "doesn’t match") {
			t.Fatalf("err = %v", err)
		}
		mf.checkOn(t, mf.f.root)
		mf.checkGone(t, mf.mediaRoot())
		if c := mf.f.d.ctr("whombat-backup-" + moveClient); c.id != oldSrv.id {
			t.Error("the backup app was made again for a move that didn't happen")
		}
	})
	t.Run("new app doesn't answer", func(t *testing.T) {
		mf := newMoveFixture(t)
		mf.f.m.readyWait = 20 * time.Millisecond
		failing := true
		mf.f.m.probe = func(context.Context, int) error {
			if failing {
				return errors.New("refused")
			}
			return nil
		}
		_, err := mf.ensure("Media")
		if err == nil || !strings.Contains(err.Error(), "didn’t answer") {
			t.Fatalf("err = %v", err)
		}
		mf.checkOn(t, mf.f.root)
		mf.checkGone(t, mf.mediaRoot())
		// Doing it again carries on.
		failing = false
		if res, err := mf.ensure("Media"); err != nil || !res.Moved {
			t.Fatalf("again = %+v %v", res, err)
		}
		mf.checkOn(t, mf.mediaRoot())
		mf.checkGone(t, mf.f.root)
	})
	t.Run("other backups there", func(t *testing.T) {
		mf := newMoveFixture(t)
		writeFile(t, filepath.Join(mf.mediaRoot(), moveClient, "config"), "another repository")
		_, err := mf.ensure("Media")
		if r := placeFailure(err); r.Code != proto.CodeExists {
			t.Fatalf("err = %+v", r)
		}
		mf.checkOn(t, mf.f.root)
		if readFile(t, filepath.Join(mf.mediaRoot(), moveClient, "config")) != "another repository" {
			t.Error("the other backups were touched")
		}
	})
	t.Run("an interrupted copy is reused", func(t *testing.T) {
		mf := newMoveFixture(t)
		// A move that died after the rename: a full copy in the new place,
		// the containers still on the old root.
		if err := os.MkdirAll(mf.mediaRoot(), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := copyTreeDirect(context.Background(), filepath.Join(mf.f.root, moveClient), filepath.Join(mf.mediaRoot(), moveClient)); err != nil {
			t.Fatal(err)
		}
		writeFile(t, filepath.Join(mf.mediaRoot(), "."+moveClient+".moving", "config"), "half")
		if res, err := mf.ensure("Media"); err != nil || !res.Moved {
			t.Fatalf("move = %+v %v", res, err)
		}
		mf.checkOn(t, mf.mediaRoot())
		mf.checkGone(t, mf.f.root)
	})
}

func TestCopyTreeAndSameTree(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "src")
	writeFile(t, filepath.Join(src, "a"), "aaa")
	writeFile(t, filepath.Join(src, "d", "b"), "bb")
	if err := os.Symlink("a", filepath.Join(src, "l")); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(filepath.Join(src, "d"), 0o500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Chmod(filepath.Join(src, "d"), 0o700); os.Chmod(filepath.Join(dir, "dst", "d"), 0o700) })
	ctx := context.Background()
	if err := copyTreeDirect(ctx, src, filepath.Join(dir, "dst")); err != nil {
		t.Fatal(err)
	}
	if err := sameTree(ctx, src, filepath.Join(dir, "dst")); err != nil {
		t.Fatal(err)
	}
	if st, _ := os.Stat(filepath.Join(dir, "dst", "d")); st.Mode().Perm() != 0o500 {
		t.Errorf("mode = %v", st.Mode())
	}
	if l, _ := os.Readlink(filepath.Join(dir, "dst", "l")); l != "a" {
		t.Errorf("link = %q", l)
	}
	if err := copyTreeDirect(ctx, src, filepath.Join(dir, "dst")); err == nil {
		t.Error("copied over a folder that is there")
	}
	os.WriteFile(filepath.Join(dir, "dst", "a"), []byte("aaaa"), 0o600)
	if err := sameTree(ctx, src, filepath.Join(dir, "dst")); err == nil {
		t.Error("a bigger file wasn't noticed")
	}
	if humanBytes(999) != "999 bytes" || humanBytes(12_345_678_901) != "12.3 GB" {
		t.Errorf("humanBytes: %s %s", humanBytes(999), humanBytes(12_345_678_901))
	}
}
