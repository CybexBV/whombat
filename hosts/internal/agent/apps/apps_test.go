package apps

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"rackoon/internal/proto"
)

const testRef = "ghcr.io/immich-app/immich-server:release"

// hashOf is Compose's hash of a service's settings, as the fake has it.
func hashOf(service string) string { return hex.EncodeToString([]byte(service)) }

// newDigest is the registry's digest of the newer image the person said yes to.
var newDigest = "sha256:" + strings.Repeat("e", 64)

// fakeDocker is a server with images, one Compose project's containers and
// Compose itself, in memory.
type fakeDocker struct {
	mu        sync.Mutex
	images    map[string]string            // ref -> image id
	labels    map[string]map[string]string // image id -> labels
	pulls     map[string]string            // what a pull of a ref gets ("repo:tag" or "repo@digest")
	behaviour map[string]Container         // image id -> how its containers run (Status, Health, RestartCount)
	conts     []*Container                 // the project's containers, the app's first
	hashes    map[string]string            // service -> Compose's hash of its settings now (default: the label)
	// written: service -> the hash Compose reads from a file a task wrote
	// down, when it differs from what the file says.
	written   map[string]string
	down      map[string]bool // containers that are stopped, by name
	calls     []string
	ups       []Project // the project each `compose up` ran with
	pullErr   error
	configErr error
	listErrs  int     // ProjectContainers fails this many times first (Docker still starting)
	upErrs    []error // one per `compose up`, in turn
	onPull    func()
	onUp      func()
}

func composeLabels(service string) map[string]string {
	return map[string]string{
		LabelProject: "immich", LabelService: service, LabelWorkingDir: "/srv/immich",
		LabelFiles: "/srv/immich/compose.yaml", LabelConfigHash: hashOf(service),
	}
}

func newFake() *fakeDocker {
	return &fakeDocker{
		images: map[string]string{testRef: "sha256:old"},
		labels: map[string]map[string]string{"sha256:old": {LabelVersion: "v2.3.1"}, "sha256:new": {LabelVersion: "v2.4.0"}},
		pulls: map[string]string{
			testRef:                         "sha256:new",
			Repo(testRef) + "@" + newDigest: "sha256:new",
		},
		behaviour: map[string]Container{
			"sha256:old": {Status: "running"},
			"sha256:new": {Status: "running"},
		},
		conts: []*Container{{ID: "c1", Name: "immich_server", ImageID: "sha256:old", Ref: testRef,
			Labels: composeLabels("immich-server"), Status: "running"}},
		hashes:  map[string]string{},
		written: map[string]string{},
		down:    map[string]bool{},
	}
}

// sibling adds another service of the project from the same image.
func (f *fakeDocker) sibling(name, service string) {
	f.conts = append(f.conts, &Container{ID: "c-" + name, Name: name, ImageID: "sha256:old", Ref: testRef,
		Labels: composeLabels(service), Status: "running"})
}

// app is the first container (the app the tests update).
func (f *fakeDocker) app() *Container { return f.conts[0] }

func (f *fakeDocker) read(c *Container) Container {
	x := *c
	x.Labels = map[string]string{}
	for k, v := range c.Labels {
		x.Labels[k] = v
	}
	for k, v := range f.labels[c.ImageID] {
		x.Labels[k] = v
	}
	b := f.behaviour[c.ImageID]
	x.Status, x.Health, x.RestartCount = b.Status, b.Health, b.RestartCount
	if f.down[c.Name] {
		x.Status, x.Health = "exited", ""
	}
	// A container that keeps restarting counts up on every read.
	if b.Status == "restarting" {
		b.RestartCount++
		f.behaviour[c.ImageID] = b
	}
	return x
}

func (f *fakeDocker) Container(_ context.Context, name string) (*Container, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, c := range f.conts {
		if c.Name == name {
			x := f.read(c)
			x.Status = c.Status
			if f.down[c.Name] {
				x.Status = "exited"
			}
			return &x, nil
		}
	}
	return nil, nil
}

func (f *fakeDocker) ProjectContainers(_ context.Context, project string) ([]Container, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.listErrs > 0 {
		f.listErrs--
		return nil, errors.New("Cannot connect to the Docker daemon")
	}
	var out []Container
	for _, c := range f.conts {
		if c.Labels[LabelProject] == project {
			out = append(out, f.read(c))
		}
	}
	return out, nil
}

func (f *fakeDocker) Image(_ context.Context, ref string) (string, map[string]string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	id := f.images[ref]
	return id, f.labels[id], nil
}

func (f *fakeDocker) Pull(_ context.Context, ref string, _ io.Writer) error {
	f.mu.Lock()
	f.calls = append(f.calls, "pull "+ref)
	if f.pullErr != nil {
		f.mu.Unlock()
		return f.pullErr
	}
	if id, ok := f.pulls[ref]; ok {
		f.images[ref] = id
	}
	hook := f.onPull
	f.mu.Unlock()
	if hook != nil {
		hook()
	}
	return nil
}

func (f *fakeDocker) Tag(ctx context.Context, src, dst string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
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

func (f *fakeDocker) ConfigHash(_ context.Context, p Project, service string) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.hashIn(p, service)
}

// hashNow is Compose's hash of a service as the project's own files say it now.
func (f *fakeDocker) hashNow(service string) string {
	if h, ok := f.hashes[service]; ok {
		return h
	}
	return hashOf(service)
}

// hashIn is Compose's hash of a service read from the project's files: a file
// a task wrote down says the hash it was written with.
func (f *fakeDocker) hashIn(p Project, service string) (string, error) {
	if len(p.Files) == 1 && strings.HasPrefix(filepath.Base(p.Files[0]), resolvedPrefix) {
		b, err := os.ReadFile(p.Files[0])
		if err != nil {
			return "", err
		}
		if h, ok := f.written[service]; ok {
			return h, nil
		}
		return parseConfigHash(string(b), service)
	}
	return f.hashNow(service), nil
}

// Config writes the project's settings down as the fake has them: one
// "service hash" line each.
func (f *fakeDocker) Config(_ context.Context, _ Project) ([]byte, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, "config")
	if f.configErr != nil {
		return nil, f.configErr
	}
	var b strings.Builder
	seen := map[string]bool{}
	for _, c := range f.conts {
		if s := c.Labels[LabelService]; !seen[s] {
			seen[s] = true
			fmt.Fprintf(&b, "%s %s\n", s, f.hashNow(s))
		}
	}
	return []byte(b.String()), nil
}

func (f *fakeDocker) Compose(_ context.Context, p Project, _ io.Writer, args ...string) error {
	f.mu.Lock()
	f.calls = append(f.calls, "compose "+strings.Join(args, " "))
	if args[0] != "up" {
		f.mu.Unlock()
		return nil
	}
	if len(f.upErrs) > 0 {
		err := f.upErrs[0]
		f.upErrs = f.upErrs[1:]
		if err != nil {
			f.mu.Unlock()
			return err
		}
	}
	f.ups = append(f.ups, p)
	i := slices.Index(args, "--")
	for _, c := range f.conts {
		if i >= 0 && slices.Contains(args[i+1:], c.Labels[LabelService]) {
			if id := f.images[c.Ref]; id != c.ImageID {
				// Recreated from the files it was given: Compose labels it so.
				h, err := f.hashIn(p, c.Labels[LabelService])
				if err != nil {
					f.mu.Unlock()
					return err
				}
				c.ImageID = id
				c.ID = "c-" + c.Name + "-" + id
				c.Labels[LabelConfigHash] = h
				c.Labels[LabelFiles] = strings.Join(p.Files, ",")
			}
			if slices.Contains(args, "--no-start") {
				f.down[c.Name] = true
			} else {
				delete(f.down, c.Name)
			}
		}
	}
	hook := f.onUp
	f.mu.Unlock()
	if hook != nil {
		hook()
	}
	return nil
}

func (f *fakeDocker) called(prefix string) []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []string
	for _, c := range f.calls {
		if strings.HasPrefix(c, prefix) {
			out = append(out, c)
		}
	}
	return out
}

// fakeStat: the project's folder and files are there.
func fakeStat(p string) (os.FileInfo, error) {
	switch p {
	case "/srv/immich":
		return dirInfo{}, nil
	case "/srv/immich/compose.yaml", "/srv/immich/.env":
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

// expectOf is what Whombat read of a container when the person said yes.
func expectOf(c *Container, digest string) proto.AppExpect {
	return proto.AppExpect{App: c.Name, Service: c.Labels[LabelService], ImageID: c.ImageID, Digest: digest,
		ConfigHash: c.Labels[LabelConfigHash]}
}

// task is one run of the runner.
type task struct {
	spec TaskSpec
	ctx  context.Context
	dir  string
}

func newTask(t *testing.T, holdMajor bool, apps ...string) *task {
	if len(apps) == 0 {
		apps = []string{"immich_server"}
	}
	// Named like the agent names them, side by side in one folder (the agent's "apps").
	dir := filepath.Join(filepath.Dir(t.TempDir()), fmt.Sprintf("app-%016x", time.Now().UnixNano()))
	if err := os.Mkdir(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	return &task{spec: TaskSpec{ID: "app:0123456789abcdef", Apps: apps, HoldMajor: holdMajor}, ctx: context.Background(), dir: dir}
}

// bind says yes to the containers as they are now, with the newer image's digest.
func (k *task) bind(f *fakeDocker, digest string) *task {
	for _, c := range f.conts {
		k.spec.Expect = append(k.spec.Expect, expectOf(c, digest))
	}
	return k
}

func (k *task) run(t *testing.T, f *fakeDocker) *TaskResult {
	t.Helper()
	if err := WriteSpec(k.dir, &k.spec); err != nil {
		t.Fatal(err)
	}
	c := &clock{t: time.Date(2026, 11, 29, 3, 0, 0, 0, time.UTC)}
	r := &Runner{Dir: k.dir, Docker: f, Now: c.now, Poll: time.Millisecond, Settle: 5 * time.Second,
		HealthWait: 20 * time.Second, Stat: fakeStat}
	if err := r.Run(k.ctx); err != nil {
		t.Fatal(err)
	}
	res, err := ReadResult(k.dir)
	if err != nil || res == nil {
		t.Fatalf("result: %v %v", res, err)
	}
	if b, _ := os.ReadFile(filepath.Join(k.dir, LogFile)); len(b) == 0 {
		t.Fatal("no log")
	}
	if p, _ := ReadProgress(k.dir); p != nil {
		t.Fatalf("progress kept after the result: %+v", p)
	}
	return res
}

func runTask(t *testing.T, f *fakeDocker, holdMajor bool, apps ...string) *TaskResult {
	t.Helper()
	return newTask(t, holdMajor, apps...).bind(f, newDigest).run(t, f)
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
	if f.app().ImageID != "sha256:new" || f.images[testRef] != "sha256:new" {
		t.Fatalf("runs %s, tag %s", f.app().ImageID, f.images[testRef])
	}
	// Exactly the image said yes to, and Compose neither pulls nor builds.
	if got := f.called("pull "); !slices.Equal(got, []string{"pull " + Repo(testRef) + "@" + newDigest}) {
		t.Fatalf("pulls %v", got)
	}
	if !slices.Contains(f.calls, "compose up --detach --no-deps --pull never --no-build --remove-orphans=false --scale immich-server=1 -- immich-server") {
		t.Fatalf("calls %v", f.calls)
	}
	// The previous image's own tag goes once the new one works.
	if _, ok := f.images[BackupTag(testRef, "immich-server")]; ok {
		t.Fatal("backup tag kept")
	}
}

// A newer image pushed under the tag after the check isn't what the yes was for.
func TestNewerTagIgnored(t *testing.T) {
	f := newFake()
	f.pulls[testRef] = "sha256:newer"
	f.labels["sha256:newer"] = map[string]string{LabelVersion: "v3.0.0"}
	if a := runTask(t, f, false).Apps[0]; a.Status != proto.AppUpdated || a.To != "v2.4.0" {
		t.Fatalf("%+v", a)
	}
	if f.app().ImageID != "sha256:new" {
		t.Fatalf("runs %s", f.app().ImageID)
	}
}

// What was said yes to must still be what runs: else nothing is pulled or changed.
func TestChangedSinceYes(t *testing.T) {
	for name, change := range map[string]func(f *fakeDocker, k *task){
		"another image runs": func(f *fakeDocker, _ *task) { f.app().ImageID = "sha256:other"; f.images[testRef] = "sha256:other" },
		"another service":    func(_ *fakeDocker, k *task) { k.spec.Expect[0].Service = "immich-ml" },
		"recreated":          func(_ *fakeDocker, k *task) { k.spec.Expect[0].ConfigHash = "bbb222" },
		"compose files":      func(f *fakeDocker, _ *task) { f.hashes["immich-server"] = "ccc333" },
		"no hash label": func(f *fakeDocker, k *task) {
			delete(f.app().Labels, LabelConfigHash)
			k.spec.Expect[0].ConfigHash = ""
		},
	} {
		t.Run(name, func(t *testing.T) {
			f := newFake()
			k := newTask(t, false).bind(f, newDigest)
			change(f, k)
			a := k.run(t, f).Apps[0]
			if a.Status != proto.AppFailed || a.Reason != proto.AppReasonChanged {
				t.Fatalf("%+v", a)
			}
			if len(f.called("pull ")) != 0 || len(f.called("compose up")) != 0 || len(f.called("tag ")) != 0 {
				t.Fatalf("something changed: %v", f.calls)
			}
		})
	}
}

// Without a digest (the registry didn't say), the tag is pulled; Compose still neither pulls nor builds.
func TestUnboundPullsTag(t *testing.T) {
	f := newFake()
	k := newTask(t, false).bind(f, "")
	if a := k.run(t, f).Apps[0]; a.Status != proto.AppUpdated {
		t.Fatalf("%+v", a)
	}
	if got := f.called("pull "); !slices.Equal(got, []string{"pull " + testRef}) {
		t.Fatalf("pulls %v", got)
	}
	// And a task without expectations (the hosts service's own API) works the same way.
	f = newFake()
	if a := newTask(t, false).run(t, f).Apps[0]; a.Status != proto.AppUpdated {
		t.Fatalf("%+v", a)
	}
}

func TestNothingNewer(t *testing.T) {
	f := newFake()
	f.pulls[Repo(testRef)+"@"+newDigest] = "sha256:old"
	res := runTask(t, f, false)
	if a := res.Apps[0]; res.Status != StatusOK || a.Status != proto.AppCurrent {
		t.Fatalf("result %+v", res)
	}
	if len(f.called("compose up")) != 0 {
		t.Fatal("recreated an app that was up to date")
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
	if f.app().ImageID != "sha256:old" || f.images[testRef] != "sha256:old" {
		t.Fatalf("not back: runs %s, tag %s", f.app().ImageID, f.images[testRef])
	}
	if ups := f.called("compose up"); len(ups) != 2 {
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

// A new container that crashed and came back twice before the watch first
// looked still counts as restarting.
func TestEarlyRestartsCount(t *testing.T) {
	f := newFake()
	f.behaviour["sha256:new"] = Container{Status: "running", RestartCount: 2}
	if a := runTask(t, f, false).Apps[0]; a.Status != proto.AppRolledBack || a.Reason != proto.AppReasonRestarts {
		t.Fatalf("%+v", a)
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
	if f.app().ImageID != "sha256:old" || f.images[testRef] != "sha256:old" || len(f.called("compose up")) != 0 {
		t.Fatal("a held app changed")
	}
	// Asked for by a person, the same jump goes ahead.
	f = newFake()
	f.labels["sha256:new"] = map[string]string{LabelVersion: "v3.0.0"}
	if a := runTask(t, f, false).Apps[0]; a.Status != proto.AppUpdated {
		t.Fatalf("%+v", a)
	}
}

// Held when either version isn't known: it may be a new major version.
func TestUnknownVersionHeld(t *testing.T) {
	f := newFake()
	delete(f.labels, "sha256:new")
	if a := runTask(t, f, true).Apps[0]; a.Status != proto.AppHeld {
		t.Fatalf("new version unknown: %+v", a)
	}
	f = newFake()
	delete(f.labels, "sha256:old")
	if a := runTask(t, f, true).Apps[0]; a.Status != proto.AppHeld {
		t.Fatalf("running version unknown: %+v", a)
	}
	if f.images[testRef] != "sha256:old" {
		t.Fatal("tag moved")
	}
}

// The task's time runs out right after a pull that moved the tag: holding
// still names the running image by its tag again.
func TestHeldTagRestoredAfterDeadline(t *testing.T) {
	f := newFake()
	f.labels["sha256:new"] = map[string]string{LabelVersion: "v3.0.0"}
	ctx, cancel := context.WithCancel(context.Background())
	f.onPull = cancel
	k := newTask(t, true).bind(f, "")
	k.ctx = ctx
	if a := k.run(t, f).Apps[0]; a.Status != proto.AppHeld {
		t.Fatalf("%+v", a)
	}
	if f.images[testRef] != "sha256:old" {
		t.Fatalf("the tag names %s", f.images[testRef])
	}
}

// Services of one project that run the same image are updated, and put back, together.
func TestSharedImageTogether(t *testing.T) {
	f := newFake()
	f.sibling("immich_microservices", "immich-microservices")
	res := runTask(t, f, false, "immich_server", "immich_microservices")
	if len(res.Apps) != 2 || res.Apps[0].App != "immich_server" || res.Apps[1].App != "immich_microservices" {
		t.Fatalf("outcomes %+v", res.Apps)
	}
	for _, a := range res.Apps {
		if a.Status != proto.AppUpdated {
			t.Fatalf("%+v", a)
		}
	}
	if ups := f.called("compose up"); len(ups) != 1 || !strings.HasSuffix(ups[0], "-- immich-server immich-microservices") {
		t.Fatalf("ups %v", ups)
	}
	if len(f.called("pull ")) != 1 {
		t.Fatalf("pulls %v", f.calls)
	}

	f = newFake()
	f.sibling("immich_microservices", "immich-microservices")
	f.behaviour["sha256:new"] = Container{Status: "exited"}
	res = runTask(t, f, false, "immich_server", "immich_microservices")
	for i, a := range res.Apps {
		if a.Status != proto.AppRolledBack || f.conts[i].ImageID != "sha256:old" {
			t.Fatalf("%+v runs %s", a, f.conts[i].ImageID)
		}
	}

	// A service from the same image the person wasn't asked about: nothing changes.
	f = newFake()
	f.sibling("immich_microservices", "immich-microservices")
	k := newTask(t, false)
	k.spec.Expect = []proto.AppExpect{expectOf(f.app(), newDigest)}
	if a := k.run(t, f).Apps[0]; a.Status != proto.AppFailed || a.Reason != proto.AppReasonChanged {
		t.Fatalf("%+v", a)
	}
	if len(f.called("pull ")) != 0 {
		t.Fatal("pulled")
	}
}

// The way back is written down before the service is replaced.
func TestWayBackWrittenFirst(t *testing.T) {
	f := newFake()
	k := newTask(t, false).bind(f, newDigest)
	var seen *Progress
	f.onUp = func() { seen, _ = ReadProgress(k.dir) }
	if a := k.run(t, f).Apps[0]; a.Status != proto.AppUpdated {
		t.Fatalf("%+v", a)
	}
	if seen == nil || seen.Pending == nil {
		t.Fatalf("no way back while replacing: %+v", seen)
	}
	p := seen.Pending
	if p.OldID != "sha256:old" || p.NewID != "sha256:new" || p.Ref != testRef || !slices.Equal(p.Services, []string{"immich-server"}) ||
		p.Backup != BackupTag(testRef, "immich-server") || p.Project.Dir != "/srv/immich" || len(p.Apps) != 1 {
		t.Fatalf("way back %+v", p)
	}
	// A stop after this point is finished naming the version it went to.
	if p.Apps[0].To != "v2.4.0" || p.Scale["immich-server"] != 1 {
		t.Fatalf("way back %+v", p)
	}
}

// An update the server stopped part-way is finished when the runner starts again.
func TestResume(t *testing.T) {
	pending := func(f *fakeDocker) *Pending {
		p, _ := ProjectOf(f.app().Labels)
		return &Pending{Project: p, Services: []string{"immich-server"}, Ref: testRef, OldID: "sha256:old", NewID: "sha256:new",
			Backup: BackupTag(testRef, "immich-server"), Moved: true,
			Apps: []Outcome{{App: "immich_server", Service: "immich-server", From: "v2.3.1", To: "v2.4.0"}}}
	}
	resume := func(t *testing.T, f *fakeDocker, prog *Progress, apps ...string) *TaskResult {
		t.Helper()
		k := newTask(t, false, apps...)
		if err := WriteProgress(k.dir, prog); err != nil {
			t.Fatal(err)
		}
		return k.run(t, f)
	}
	replaced := func(f *fakeDocker) {
		f.images[testRef] = "sha256:new"
		f.images[BackupTag(testRef, "immich-server")] = "sha256:old"
		f.app().ImageID = "sha256:new"
	}

	t.Run("runs well", func(t *testing.T) {
		f := newFake()
		replaced(f)
		res := resume(t, f, &Progress{Pending: pending(f)})
		if a := res.Apps[0]; res.Status != StatusOK || a.Status != proto.AppUpdated || a.To != "v2.4.0" {
			t.Fatalf("%+v", res)
		}
		if _, ok := f.images[BackupTag(testRef, "immich-server")]; ok || len(f.called("pull ")) != 0 {
			t.Fatalf("calls %v", f.calls)
		}
	})
	t.Run("doesn't run", func(t *testing.T) {
		f := newFake()
		replaced(f)
		f.behaviour["sha256:new"] = Container{Status: "exited"}
		res := resume(t, f, &Progress{Pending: pending(f)})
		if a := res.Apps[0]; a.Status != proto.AppRolledBack {
			t.Fatalf("%+v", res)
		}
		if f.app().ImageID != "sha256:old" || f.images[testRef] != "sha256:old" {
			t.Fatalf("not back: runs %s, tag %s", f.app().ImageID, f.images[testRef])
		}
	})
	t.Run("not replaced yet", func(t *testing.T) {
		f := newFake()
		f.images[testRef] = "sha256:new" // tagged, then the server stopped
		res := resume(t, f, &Progress{Pending: pending(f)})
		if a := res.Apps[0]; a.Status != proto.AppFailed || a.Reason != proto.AppReasonInterrupted {
			t.Fatalf("%+v", res)
		}
		if f.images[testRef] != "sha256:old" || len(f.called("compose up")) != 0 {
			t.Fatalf("tag %s, calls %v", f.images[testRef], f.calls)
		}
	})
	t.Run("apps done and not reached", func(t *testing.T) {
		f := newFake()
		replaced(f)
		done := Outcome{App: "paperless", Service: "web", Status: proto.AppUpdated}
		res := resume(t, f, &Progress{Done: []Outcome{done}, Pending: pending(f)}, "paperless", "immich_server", "jellyfin")
		got := []string{}
		for _, a := range res.Apps {
			got = append(got, a.App+" "+a.Status+" "+a.Reason)
		}
		want := []string{"paperless updated ", "immich_server updated ", "jellyfin failed interrupted"}
		if !slices.Equal(got, want) || res.Status != StatusFailed {
			t.Fatalf("%v", got)
		}
	})
}

func TestRefusals(t *testing.T) {
	f := newFake()
	if a := runTask(t, f, false, "nothere").Apps[0]; a.Status != proto.AppFailed || a.Reason != proto.AppReasonGone {
		t.Fatalf("%+v", a)
	}
	f = newFake()
	delete(f.app().Labels, LabelProject)
	if a := newTask(t, false).run(t, f).Apps[0]; a.Reason != proto.AppReasonNoCompose {
		t.Fatalf("%+v", a)
	}
	// An image's labels claiming a service that reads as an option.
	f = newFake()
	f.app().Labels[LabelService] = "--build"
	if a := newTask(t, false).run(t, f).Apps[0]; a.Reason != proto.AppReasonNoCompose || len(f.called("compose")) != 0 {
		t.Fatalf("%+v %v", a, f.calls)
	}
	f = newFake()
	f.app().Labels[LabelWorkingDir] = "/srv/gone"
	if a := runTask(t, f, false).Apps[0]; a.Reason != proto.AppReasonNoFiles {
		t.Fatalf("%+v", a)
	}
	f = newFake()
	f.app().Labels[LabelEnvFiles] = "/srv/immich/missing.env"
	if a := runTask(t, f, false).Apps[0]; a.Reason != proto.AppReasonNoFiles {
		t.Fatalf("env file: %+v", a)
	}
	f = newFake()
	f.app().Ref = "ghcr.io/immich-app/immich-server@sha256:abc"
	if a := newTask(t, false).run(t, f).Apps[0]; a.Reason != proto.AppReasonPinned {
		t.Fatalf("%+v", a)
	}
	f = newFake()
	f.pullErr = errors.New("pull access denied for x\nmanifest unknown")
	a := runTask(t, f, false).Apps[0]
	if a.Status != proto.AppFailed || a.Reason != proto.AppReasonPull || a.Message != "manifest unknown" {
		t.Fatalf("%+v", a)
	}
	if f.app().ImageID != "sha256:old" || f.images[testRef] != "sha256:old" {
		t.Fatal("a failed pull changed the app")
	}
}

func TestUpFailsGoesBack(t *testing.T) {
	f := newFake()
	f.upErrs = []error{errors.New("Error response from daemon: port is already allocated")}
	a := runTask(t, f, false).Apps[0]
	if a.Status != proto.AppRolledBack || a.Reason != proto.AppReasonStart || !strings.Contains(a.Message, "port") {
		t.Fatalf("%+v", a)
	}
	// Compose from before --pull: asked again without it.
	f = newFake()
	f.upErrs = []error{errors.New("unknown flag: --pull")}
	if a := runTask(t, f, false).Apps[0]; a.Status != proto.AppUpdated {
		t.Fatalf("%+v", a)
	}
	if ups := f.called("compose up"); len(ups) != 2 || strings.Contains(ups[1], "--pull") || !strings.Contains(ups[1], "--no-build") {
		t.Fatalf("ups %v", ups)
	}
	// docker-compose 1 takes no value for --remove-orphans: asked again without it.
	f = newFake()
	f.upErrs = []error{errors.New("--remove-orphans must not have an argument")}
	if a := runTask(t, f, false).Apps[0]; a.Status != proto.AppUpdated {
		t.Fatalf("%+v", a)
	}
	if ups := f.called("compose up"); len(ups) != 2 || strings.Contains(ups[1], "--remove-orphans") || !strings.Contains(ups[1], "--scale immich-server=1") {
		t.Fatalf("ups %v", ups)
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
	for _, bad := range []map[string]string{
		{LabelProject: "x", LabelService: "--build"},
		{LabelProject: "-p", LabelService: "web"},
		{LabelProject: "x", LabelService: "web app"},
		{LabelProject: "x", LabelService: "web;reboot"},
	} {
		if _, ok := ProjectOf(bad); ok {
			t.Errorf("taken: %v", bad)
		}
	}
	if (Project{Dir: "relative"}).Usable(fakeStat) {
		t.Fatal("relative folder")
	}
	if !(Project{Dir: "/srv/immich", Files: []string{"/srv/immich/compose.yaml"}, EnvFiles: []string{"/srv/immich/.env"}}).Usable(fakeStat) {
		t.Fatal("usable project")
	}
}

func TestParseConfigHash(t *testing.T) {
	out := "db 1f2e\nimmich-server 3f2a9c\n"
	if h, err := parseConfigHash(out, "immich-server"); err != nil || h != "3f2a9c" {
		t.Fatalf("%q %v", h, err)
	}
	if _, err := parseConfigHash("immich-server not-a-hash\n", "immich-server"); err == nil {
		t.Fatal("took a hash that isn't one")
	}
	if _, err := parseConfigHash(out, "redis"); err == nil {
		t.Fatal("another service's hash")
	}
}

// The settings are written down once, before the image downloads: an edit
// to the project's files meanwhile is neither deployed nor put back.
func TestEditDuringPullNotDeployed(t *testing.T) {
	for _, fails := range []bool{false, true} {
		f := newFake()
		if fails {
			f.behaviour["sha256:new"] = Container{Status: "exited"}
		}
		f.onPull = func() { f.hashes["immich-server"] = "edited" }
		k := newTask(t, false).bind(f, newDigest)
		a := k.run(t, f).Apps[0]
		if (!fails && a.Status != proto.AppUpdated) || (fails && a.Status != proto.AppRolledBack) {
			t.Fatalf("%+v", a)
		}
		if got := f.app().Labels[LabelConfigHash]; got != hashOf("immich-server") {
			t.Fatalf("deployed settings %q", got)
		}
		written := filepath.Join(k.dir, resolvedPrefix+"immich-immich-server.yaml")
		for _, p := range f.ups {
			if p.Name != "immich" || p.Dir != "/srv/immich" || !slices.Equal(p.Files, []string{written}) {
				t.Fatalf("up from %+v", p)
			}
		}
		if len(f.ups) == 0 || (fails && len(f.ups) != 2) {
			t.Fatalf("ups %+v", f.ups)
		}
	}
}

// Settings Compose doesn't give back as they run aren't used: nothing changes.
func TestWrittenSettingsMustMatch(t *testing.T) {
	f := newFake()
	f.written["immich-server"] = "other"
	a := runTask(t, f, false).Apps[0]
	if a.Status != proto.AppFailed || a.Reason != AppReasonDocker || len(f.called("pull ")) != 0 || len(f.called("tag ")) != 0 {
		t.Fatalf("%+v %v", a, f.calls)
	}
	f = newFake()
	f.configErr = errors.New("compose: invalid file")
	if a := runTask(t, f, false).Apps[0]; a.Status != proto.AppFailed || len(f.called("pull ")) != 0 {
		t.Fatalf("%+v", a)
	}
}

// A later update reads the project's own files again, not the copy the last one recreated it from.
func TestLaterUpdateReadsOwnFiles(t *testing.T) {
	f := newFake()
	k := newTask(t, false).bind(f, newDigest)
	if a := k.run(t, f).Apps[0]; a.Status != proto.AppUpdated {
		t.Fatalf("%+v", a)
	}
	if !strings.HasPrefix(f.app().Labels[LabelFiles], k.dir) {
		t.Fatalf("files %q", f.app().Labels[LabelFiles])
	}
	// The next version comes out; the task folder of the last update is gone by then.
	next := "sha256:" + strings.Repeat("f", 64)
	f.pulls[Repo(testRef)+"@"+next] = "sha256:next"
	f.labels["sha256:next"] = map[string]string{LabelVersion: "v2.5.0"}
	f.behaviour["sha256:next"] = Container{Status: "running"}
	if err := os.RemoveAll(k.dir); err != nil {
		t.Fatal(err)
	}
	k2 := newTask(t, false).bind(f, next)
	if a := k2.run(t, f).Apps[0]; a.Status != proto.AppUpdated || a.From != "v2.4.0" || a.To != "v2.5.0" {
		t.Fatalf("%+v", a)
	}
	// An edit to the project's own files since is seen.
	f.hashes["immich-server"] = "edited"
	if a := newTask(t, false).bind(f, newDigest).run(t, f).Apps[0]; a.Reason != proto.AppReasonChanged {
		t.Fatalf("%+v", a)
	}
	// Without the note of its own files, the copy's folder isn't the project's.
	delete(f.hashes, "immich-server")
	if err := os.RemoveAll(filepath.Join(filepath.Dir(k.dir), "projects")); err != nil {
		t.Fatal(err)
	}
	if a := newTask(t, false).bind(f, newDigest).run(t, f).Apps[0]; a.Reason != proto.AppReasonNoFiles {
		t.Fatalf("%+v", a)
	}
}

// Each service keeps the number of containers it has, whatever its Compose file says.
func TestReplicasKept(t *testing.T) {
	f := newFake()
	f.sibling("immich_server_2", "immich-server")
	res := runTask(t, f, false, "immich_server", "immich_server_2")
	for _, a := range res.Apps {
		if a.Status != proto.AppUpdated {
			t.Fatalf("%+v", a)
		}
	}
	if ups := f.called("compose up"); len(ups) != 1 || !strings.Contains(ups[0], "--scale immich-server=2 ") {
		t.Fatalf("ups %v", ups)
	}
	// A container of the service that runs another image would be replaced too: nothing changes.
	f = newFake()
	f.sibling("immich_server_2", "immich-server")
	f.conts[1].ImageID = "sha256:older"
	f.behaviour["sha256:older"] = Container{Status: "running"}
	if a := runTask(t, f, false).Apps[0]; a.Reason != proto.AppReasonChanged || len(f.called("pull ")) != 0 {
		t.Fatalf("%+v", a)
	}
}

// A stopped service that shares the image goes to the new one too, and stays stopped.
func TestStoppedSiblingStaysStopped(t *testing.T) {
	f := newFake()
	f.sibling("immich_microservices", "immich-microservices")
	f.down["immich_microservices"] = true
	res := runTask(t, f, false, "immich_server", "immich_microservices")
	if len(res.Apps) != 2 {
		t.Fatalf("%+v", res.Apps)
	}
	for _, a := range res.Apps {
		if a.Status != proto.AppUpdated {
			t.Fatalf("%+v", a)
		}
	}
	if f.conts[1].ImageID != "sha256:new" || !f.down["immich_microservices"] {
		t.Fatalf("sibling runs %s, stopped %v", f.conts[1].ImageID, f.down["immich_microservices"])
	}
	ups := f.called("compose up")
	if len(ups) != 2 || !strings.HasSuffix(ups[0], "--detach --no-deps --pull never --no-build --remove-orphans=false --scale immich-server=1 -- immich-server") ||
		!strings.HasSuffix(ups[1], "--no-start --no-deps --pull never --no-build --remove-orphans=false --scale immich-microservices=1 -- immich-microservices") {
		t.Fatalf("ups %v", ups)
	}
	// When the update doesn't come up, the stopped one is left on the previous image.
	f = newFake()
	f.sibling("immich_microservices", "immich-microservices")
	f.down["immich_microservices"] = true
	f.behaviour["sha256:new"] = Container{Status: "exited"}
	for _, a := range runTask(t, f, false, "immich_server", "immich_microservices").Apps {
		if a.Status != proto.AppRolledBack {
			t.Fatalf("%+v", a)
		}
	}
	if f.conts[1].ImageID != "sha256:old" || !f.down["immich_microservices"] {
		t.Fatal("the stopped service changed")
	}
	// One the person wasn't asked about: nothing changes.
	f = newFake()
	f.sibling("immich_microservices", "immich-microservices")
	f.down["immich_microservices"] = true
	k := newTask(t, false)
	k.spec.Expect = []proto.AppExpect{expectOf(f.app(), newDigest)}
	if a := k.run(t, f).Apps[0]; a.Reason != proto.AppReasonChanged || len(f.called("pull ")) != 0 {
		t.Fatalf("%+v", a)
	}
}

// What was checked must name Compose's settings, and a task that says what
// was checked says it for every app it updates.
func TestBindingNamesEverything(t *testing.T) {
	f := newFake()
	k := newTask(t, false).bind(f, newDigest)
	k.spec.Expect[0].ConfigHash = ""
	if a := k.run(t, f).Apps[0]; a.Reason != proto.AppReasonChanged || len(f.called("pull ")) != 0 {
		t.Fatalf("no hash: %+v", a)
	}
	f = newFake()
	k = newTask(t, false)
	k.spec.Expect = []proto.AppExpect{{App: "paperless", Service: "web", ImageID: "sha256:old", ConfigHash: hashOf("web")}}
	if a := k.run(t, f).Apps[0]; a.Reason != proto.AppReasonChanged || len(f.called("pull ")) != 0 {
		t.Fatalf("not named: %+v", a)
	}
}

// After a restart Docker may answer only after a while: the update is finished once it does.
func TestResumeWaitsForDocker(t *testing.T) {
	setup := func(f *fakeDocker) (*task, *Pending) {
		f.images[testRef] = "sha256:new"
		f.images[BackupTag(testRef, "immich-server")] = "sha256:old"
		f.app().ImageID = "sha256:new"
		p, _ := ProjectOf(f.app().Labels)
		pend := &Pending{Project: p, Services: []string{"immich-server"}, Ref: testRef, OldID: "sha256:old", NewID: "sha256:new",
			Backup: BackupTag(testRef, "immich-server"), Moved: true,
			Apps: []Outcome{{App: "immich_server", Service: "immich-server", From: "v2.3.1", To: "v2.4.0"}}}
		k := newTask(t, false)
		if err := WriteProgress(k.dir, &Progress{Pending: pend}); err != nil {
			t.Fatal(err)
		}
		return k, pend
	}
	f := newFake()
	f.listErrs = 3
	k, _ := setup(f)
	if a := k.run(t, f).Apps[0]; a.Status != proto.AppUpdated || a.To != "v2.4.0" {
		t.Fatalf("%+v", a)
	}

	// Docker doesn't answer in time: no result, and the way back stays for the next try.
	f = newFake()
	f.listErrs = 1 << 20
	k, _ = setup(f)
	if err := WriteSpec(k.dir, &k.spec); err != nil {
		t.Fatal(err)
	}
	c := &clock{t: time.Date(2026, 11, 29, 3, 0, 0, 0, time.UTC)}
	r := &Runner{Dir: k.dir, Docker: f, Now: c.now, Poll: time.Millisecond, DockerWait: 10 * time.Second, Stat: fakeStat}
	if err := r.Run(context.Background()); !errors.Is(err, ErrDockerDown) {
		t.Fatalf("err %v", err)
	}
	if res, _ := ReadResult(k.dir); res != nil {
		t.Fatalf("result %+v", res)
	}
	if p, _ := ReadProgress(k.dir); p == nil || p.Pending == nil {
		t.Fatal("the way back was dropped")
	}
	if len(f.called("tag ")) != 0 || len(f.called("compose")) != 0 {
		t.Fatalf("calls %v", f.calls)
	}
}
