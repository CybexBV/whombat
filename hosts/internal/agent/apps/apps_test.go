package apps

import (
	"context"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"rackoon/internal/proto"
)

// fakeDocker is a server with images, containers and Compose, in memory.
type fakeDocker struct {
	mu        sync.Mutex
	images    map[string]string            // ref -> image id
	labels    map[string]map[string]string // image id -> labels
	pulls     map[string]string            // ref -> the id a pull gets
	behaviour map[string]Container         // image id -> how its container runs (Status, Health, RestartCount)
	cont      Container                    // the service's container
	calls     []string
	pullErr   error
	upErr     error
}

func newFake() *fakeDocker {
	labels := map[string]string{
		LabelProject: "immich", LabelService: "immich-server", LabelWorkingDir: "/srv/immich",
		LabelFiles: "/srv/immich/compose.yaml",
	}
	return &fakeDocker{
		images: map[string]string{"ghcr.io/immich-app/immich-server:release": "sha256:old"},
		labels: map[string]map[string]string{"sha256:old": {LabelVersion: "v2.3.1"}, "sha256:new": {LabelVersion: "v2.4.0"}},
		pulls:  map[string]string{"ghcr.io/immich-app/immich-server:release": "sha256:new"},
		behaviour: map[string]Container{
			"sha256:old": {Status: "running"},
			"sha256:new": {Status: "running"},
		},
		cont: Container{ID: "c1", Name: "immich_server", ImageID: "sha256:old", Ref: "ghcr.io/immich-app/immich-server:release",
			Labels: labels, Status: "running"},
	}
}

func (f *fakeDocker) Container(_ context.Context, name string) (*Container, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if name != f.cont.Name {
		return nil, nil
	}
	c := f.cont
	c.Labels = map[string]string{}
	for k, v := range f.cont.Labels {
		c.Labels[k] = v
	}
	for k, v := range f.labels[c.ImageID] {
		c.Labels[k] = v
	}
	return &c, nil
}

func (f *fakeDocker) ServiceContainers(context.Context, string, string) ([]Container, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	c := f.cont
	b := f.behaviour[c.ImageID]
	c.Status, c.Health = b.Status, b.Health
	c.RestartCount = b.RestartCount
	// A container that keeps restarting counts up on every read.
	if b.Status == "restarting" {
		bb := f.behaviour[c.ImageID]
		bb.RestartCount++
		f.behaviour[c.ImageID] = bb
	}
	return []Container{c}, nil
}

func (f *fakeDocker) Image(_ context.Context, ref string) (string, map[string]string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	id := f.images[ref]
	return id, f.labels[id], nil
}

func (f *fakeDocker) Tag(_ context.Context, src, dst string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, "tag "+src+" "+dst)
	f.images[dst] = src
	return nil
}

func (f *fakeDocker) Untag(_ context.Context, ref string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, "untag "+ref)
	delete(f.images, ref)
	return nil
}

func (f *fakeDocker) Compose(_ context.Context, p Project, _ io.Writer, args ...string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, "compose "+strings.Join(args, " "))
	switch args[0] {
	case "pull":
		if f.pullErr != nil {
			return f.pullErr
		}
		ref := f.cont.Ref
		if id, ok := f.pulls[ref]; ok {
			f.images[ref] = id
		}
	case "up":
		if f.upErr != nil && !contains(args, "never") {
			return f.upErr
		}
		f.cont.ImageID = f.images[f.cont.Ref]
		f.cont.ID = "c-" + f.cont.ImageID
	}
	return nil
}

func contains(s []string, v string) bool {
	for _, x := range s {
		if x == v {
			return true
		}
	}
	return false
}

// fakeStat: the project's folder and files are there.
func fakeStat(p string) (os.FileInfo, error) {
	switch p {
	case "/srv/immich":
		return dirInfo{}, nil
	case "/srv/immich/compose.yaml":
		return fileInfo{}, nil
	}
	return nil, fs.ErrNotExist
}

type fileInfo struct{}

func (fileInfo) Name() string       { return "f" }
func (fileInfo) Size() int64        { return 1 }
func (fileInfo) Mode() fs.FileMode  { return 0o644 }
func (fileInfo) ModTime() time.Time { return time.Time{} }
func (fileInfo) IsDir() bool        { return false }
func (fileInfo) Sys() any           { return nil }

type dirInfo struct{ fileInfo }

func (dirInfo) IsDir() bool { return true }

// clock moves forward a second on every read, so the watch settles without sleeping long.
type clock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *clock) now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = c.t.Add(time.Second)
	return c.t
}

func runTask(t *testing.T, f *fakeDocker, holdMajor bool, apps ...string) *TaskResult {
	t.Helper()
	dir := t.TempDir()
	if len(apps) == 0 {
		apps = []string{"immich_server"}
	}
	if err := WriteSpec(dir, &TaskSpec{ID: "app:0123456789abcdef", Apps: apps, HoldMajor: holdMajor}); err != nil {
		t.Fatal(err)
	}
	c := &clock{t: time.Date(2026, 11, 29, 3, 0, 0, 0, time.UTC)}
	r := &Runner{Dir: dir, Docker: f, Now: c.now, Poll: time.Millisecond, Settle: 5 * time.Second,
		HealthWait: 20 * time.Second, Stat: fakeStat}
	if err := r.Run(context.Background()); err != nil {
		t.Fatal(err)
	}
	res, err := ReadResult(dir)
	if err != nil || res == nil {
		t.Fatalf("result: %v %v", res, err)
	}
	if b, _ := os.ReadFile(filepath.Join(dir, LogFile)); len(b) == 0 {
		t.Fatal("no log")
	}
	return res
}

func TestUpdateWorks(t *testing.T) {
	f := newFake()
	res := runTask(t, f, false)
	if res.Status != StatusOK || len(res.Apps) != 1 {
		t.Fatalf("result %+v", res)
	}
	a := res.Apps[0]
	if a.Status != proto.AppUpdated || a.From != "v2.3.1" || a.To != "v2.4.0" || a.Service != "immich-server" {
		t.Fatalf("outcome %+v", a)
	}
	if f.cont.ImageID != "sha256:new" {
		t.Fatalf("runs %s", f.cont.ImageID)
	}
	// The previous image's own tag goes once the new one works.
	if _, ok := f.images[BackupTag(f.cont.Ref, "immich-server")]; ok {
		t.Fatal("backup tag kept")
	}
}

func TestNothingNewer(t *testing.T) {
	f := newFake()
	f.pulls = map[string]string{}
	res := runTask(t, f, false)
	if a := res.Apps[0]; res.Status != StatusOK || a.Status != proto.AppCurrent {
		t.Fatalf("result %+v", res)
	}
	for _, c := range f.calls {
		if strings.HasPrefix(c, "compose up") {
			t.Fatal("recreated an app that was up to date")
		}
	}
}

func TestStoppedGoesBack(t *testing.T) {
	f := newFake()
	f.behaviour["sha256:new"] = Container{Status: "exited"}
	res := runTask(t, f, false)
	a := res.Apps[0]
	if res.Status != StatusFailed || a.Status != proto.AppRolledBack || a.Reason != proto.AppReasonStopped {
		t.Fatalf("result %+v", res)
	}
	if f.cont.ImageID != "sha256:old" || f.images[f.cont.Ref] != "sha256:old" {
		t.Fatalf("not back: runs %s, tag %s", f.cont.ImageID, f.images[f.cont.Ref])
	}
	if !contains(f.calls, "compose up --detach --no-deps --pull never immich-server") {
		t.Fatalf("calls %v", f.calls)
	}
}

func TestRestartingAndUnhealthyGoBack(t *testing.T) {
	for _, b := range []Container{{Status: "restarting"}, {Status: "running", Health: "unhealthy"}, {Status: "running", Health: "starting"}} {
		f := newFake()
		f.behaviour["sha256:new"] = b
		res := runTask(t, f, false)
		if a := res.Apps[0]; a.Status != proto.AppRolledBack {
			t.Fatalf("%+v: %+v", b, a)
		}
	}
}

func TestHealthyWorks(t *testing.T) {
	f := newFake()
	f.behaviour["sha256:new"] = Container{Status: "running", Health: "healthy"}
	if a := runTask(t, f, false).Apps[0]; a.Status != proto.AppUpdated {
		t.Fatalf("%+v", a)
	}
}

func TestMajorJumpHeld(t *testing.T) {
	f := newFake()
	f.labels["sha256:new"] = map[string]string{LabelVersion: "v3.0.0"}
	res := runTask(t, f, true)
	a := res.Apps[0]
	if res.Status != StatusOK || a.Status != proto.AppHeld || a.To != "v3.0.0" {
		t.Fatalf("result %+v", res)
	}
	if f.cont.ImageID != "sha256:old" || f.images[f.cont.Ref] != "sha256:old" {
		t.Fatal("a held app changed")
	}
	// Asked for by a person, the same jump goes ahead.
	f = newFake()
	f.labels["sha256:new"] = map[string]string{LabelVersion: "v3.0.0"}
	if a := runTask(t, f, false).Apps[0]; a.Status != proto.AppUpdated {
		t.Fatalf("%+v", a)
	}
}

func TestRefusals(t *testing.T) {
	f := newFake()
	if a := runTask(t, f, false, "nothere").Apps[0]; a.Status != proto.AppFailed || a.Reason != proto.AppReasonGone {
		t.Fatalf("%+v", a)
	}
	f = newFake()
	delete(f.cont.Labels, LabelProject)
	if a := runTask(t, f, false).Apps[0]; a.Reason != proto.AppReasonNoCompose {
		t.Fatalf("%+v", a)
	}
	f = newFake()
	f.cont.Labels[LabelWorkingDir] = "/srv/gone"
	if a := runTask(t, f, false).Apps[0]; a.Reason != proto.AppReasonNoFiles {
		t.Fatalf("%+v", a)
	}
	f = newFake()
	f.cont.Ref = "ghcr.io/immich-app/immich-server@sha256:abc"
	if a := runTask(t, f, false).Apps[0]; a.Reason != proto.AppReasonPinned {
		t.Fatalf("%+v", a)
	}
	f = newFake()
	f.pullErr = errors.New("pull access denied for x\nmanifest unknown")
	a := runTask(t, f, false).Apps[0]
	if a.Status != proto.AppFailed || a.Reason != proto.AppReasonPull || a.Message != "manifest unknown" {
		t.Fatalf("%+v", a)
	}
	if f.cont.ImageID != "sha256:old" {
		t.Fatal("a failed pull changed the app")
	}
}

func TestUpFailsGoesBack(t *testing.T) {
	f := newFake()
	f.upErr = errors.New("Error response from daemon: port is already allocated")
	a := runTask(t, f, false).Apps[0]
	if a.Status != proto.AppRolledBack || a.Reason != proto.AppReasonStart || !strings.Contains(a.Message, "port") {
		t.Fatalf("%+v", a)
	}
}

func TestVersions(t *testing.T) {
	cases := []struct {
		labels map[string]string
		ref    string
		want   string
	}{
		{nil, "postgres:16.4", "16.4"},
		{nil, "nginx:1.27-alpine", "1.27-alpine"},
		{nil, "ghcr.io/org/app:v2.3.1", "v2.3.1"},
		{nil, "nginx", ""},
		{nil, "nginx:latest", ""},
		{nil, "app:release", ""},
		{map[string]string{LabelVersion: "2.4.0"}, "app:release", "2.4.0"},
		{map[string]string{LabelVersion: "main"}, "app:16", "16"},
		{nil, "localhost:5000/app", ""},
		{nil, "localhost:5000/app:3", "3"},
	}
	for _, c := range cases {
		if got := VersionOf(c.labels, c.ref); got != c.want {
			t.Errorf("VersionOf(%v, %q) = %q, want %q", c.labels, c.ref, got, c.want)
		}
	}
	if !MajorJump("v2.3.1", "v3.0.0") || MajorJump("2.3", "2.4") || MajorJump("", "3") || MajorJump("2024.12.1", "2025.1.0") {
		t.Fatal("MajorJump")
	}
	if Major("16.4") != 16 || Major("release") != -1 {
		t.Fatal("Major")
	}
	if got := BackupTag("localhost:5000/app:3", "web app"); got != "localhost:5000/app:whombat-previous-web-app" {
		t.Fatal(got)
	}
	if Repo("nginx@sha256:abc") != "nginx" || Tag("nginx") != "latest" {
		t.Fatal("Repo/Tag")
	}
}

func TestProjectOf(t *testing.T) {
	p, ok := ProjectOf(map[string]string{LabelProject: "x", LabelService: "web", LabelWorkingDir: "/srv/x",
		LabelFiles: "/srv/x/compose.yaml,override.yaml", LabelEnvFiles: "/srv/x/.env"})
	if !ok || len(p.Files) != 2 || p.Files[1] != "/srv/x/override.yaml" {
		t.Fatalf("%+v", p)
	}
	args := strings.Join(p.Args(), " ")
	if args != "--project-name x --project-directory /srv/x --file /srv/x/compose.yaml --file /srv/x/override.yaml --env-file /srv/x/.env" {
		t.Fatal(args)
	}
	if _, ok := ProjectOf(map[string]string{LabelProject: "x", LabelService: "web", LabelOneOff: "True"}); ok {
		t.Fatal("one-off container")
	}
	if (Project{Dir: "relative"}).Usable(fakeStat) {
		t.Fatal("relative folder")
	}
}
