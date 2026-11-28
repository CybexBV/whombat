package broker

import (
	"fmt"
	"runtime"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"rackoon/internal/agent"
	"rackoon/internal/agent/apps"
	"rackoon/internal/proto"
)

// fakeAppUnits stands in for systemd for app tasks.
type fakeAppUnits struct {
	mu      sync.Mutex
	active  map[string]bool
	argv    [][]string
	changes int
}

func appBroker(t *testing.T, guests []proto.Guest) (*Broker, *fakeAppUnits) {
	t.Helper()
	inv := &proto.Report{Docker: &proto.Platform{Guests: guests}}
	b := NewBroker(&agent.Config{StateDir: t.TempDir()}, func() *proto.Report { return inv }, nil)
	p := newAppTasks(b.cfg.StateDir)
	f := &fakeAppUnits{active: map[string]bool{}}
	p.exe = func() (string, error) { return "/usr/local/bin/whombat-agent", nil }
	p.systemd = func() bool { return true }
	p.systemdRun = func(argv []string) error {
		f.mu.Lock()
		defer f.mu.Unlock()
		f.argv = append(f.argv, argv)
		for _, a := range argv {
			if u, ok := strings.CutPrefix(a, "--unit="); ok {
				f.active[u] = true
			}
		}
		return nil
	}
	p.unitActive = func(unit string) (bool, error) {
		f.mu.Lock()
		defer f.mu.Unlock()
		return f.active[unit], nil
	}
	p.poll = 5 * time.Millisecond
	b.appMgr = p
	b.OnAppChange = func() {
		f.mu.Lock()
		f.changes++
		f.mu.Unlock()
	}
	t.Cleanup(func() {
		deadline := time.Now().Add(5 * time.Second)
		for {
			p.mu.Lock()
			watching := p.watching
			p.mu.Unlock()
			if !watching {
				return
			}
			if time.Now().After(deadline) {
				t.Error("an app task still runs at the end of the test")
				return
			}
			time.Sleep(5 * time.Millisecond)
		}
	})
	return b, f
}

func (f *fakeAppUnits) end(t *testing.T, p *appTasks, id string, res *apps.TaskResult) {
	t.Helper()
	dir := p.taskDir(id)
	if res.Finished.IsZero() {
		res.Finished = time.Now().UTC()
	}
	if err := apps.WriteResult(dir, res); err != nil {
		t.Fatal(err)
	}
	spec, _ := apps.ReadSpec(dir)
	f.mu.Lock()
	f.active[spec.Unit] = false
	f.mu.Unlock()
}

func composeGuests() []proto.Guest {
	return []proto.Guest{
		{ID: "immich_server", Kind: "container", App: &proto.GuestApp{Service: "immich-server", Version: "2.3.0", NewVersion: "2.4.0"}},
		{ID: "immich_redis", Kind: "container", App: &proto.GuestApp{Service: "redis", Version: "7"}},
		{ID: "pinned", Kind: "container", App: &proto.GuestApp{Service: "web", Blocked: proto.AppReasonPinned}},
		{ID: "lonely", Kind: "container"},
		{ID: "whombat-db", Kind: "container", WhombatService: true, App: &proto.GuestApp{Service: "db"}},
	}
}

func TestAppTasks(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("app updates are for Linux servers")
	}
	b, f := appBroker(t, composeGuests())
	resp := b.Manage(t.Context(), proto.ManageRequest{Op: proto.OpAppUpdate, Platform: proto.PlatformDocker,
		Apps: []string{"immich_server", "immich_redis", "immich_server"}, HoldMajor: true})
	if !resp.OK || resp.Task == nil || !appTaskIDRe.MatchString(resp.Task.ID) {
		t.Fatalf("update: %+v", resp)
	}
	id := resp.Task.ID
	argv := strings.Join(f.argv[0], " ")
	for _, want := range []string{"--unit=whombat-app-" + strings.TrimPrefix(id, "app:") + ".service", "--collect",
		"TimeoutStopSec=600s", "-- /usr/local/bin/whombat-agent app-task --dir " + b.appMgr.taskDir(id)} {
		if !strings.Contains(argv, want) {
			t.Errorf("systemd-run lacks %q: %s", want, argv)
		}
	}
	spec, _ := apps.ReadSpec(b.appMgr.taskDir(id))
	if !slices.Equal(spec.Apps, []string{"immich_server", "immich_redis"}) || !spec.HoldMajor {
		t.Errorf("spec: %+v", spec)
	}

	// While it runs: one at a time, can't be stopped, busy in the report.
	if r := b.Manage(t.Context(), proto.ManageRequest{Op: proto.OpAppUpdate, Apps: []string{"immich_server"}}); r.Code != CodeBusy {
		t.Errorf("second task: %+v", r)
	}
	if r := b.Manage(t.Context(), proto.ManageRequest{Op: proto.OpTaskStop, Task: id}); r.Code != proto.CodeNotAllowed {
		t.Errorf("stop: %+v", r)
	}
	busy, last := b.AppReport()
	if !busy["immich_server"] || !busy["immich_redis"] || len(last) != 0 {
		t.Errorf("report while running: %v %v", busy, last)
	}
	st := b.Manage(t.Context(), proto.ManageRequest{Op: proto.OpTaskStatus, Task: id, LogStart: -1})
	if !st.OK || st.TaskStatus.Status != "running" || st.TaskStatus.Type != proto.OpAppUpdate || st.TaskStatus.GuestID != "" {
		t.Errorf("status: %+v", st.TaskStatus)
	}

	// It ends: per app outcomes, last outcomes kept, the agent told.
	f.end(t, b.appMgr, id, &apps.TaskResult{Status: apps.StatusFailed, Message: "immich_server: it didn’t start",
		Apps: []apps.Outcome{
			{App: "immich_server", Service: "immich-server", Status: proto.AppRolledBack, Reason: proto.AppReasonStopped, From: "2.3.0", To: "2.4.0"},
			{App: "immich_redis", Service: "redis", Status: proto.AppCurrent, From: "7"},
		}})
	waitFor(t, func() bool { busy, _ := b.AppReport(); return len(busy) == 0 })
	st = b.Manage(t.Context(), proto.ManageRequest{Op: proto.OpTaskStatus, Task: id, LogStart: -1})
	ts := st.TaskStatus
	if ts.Status != "error" || ts.Ended == nil || len(ts.Apps) != 2 || ts.Apps[0].Status != proto.AppRolledBack || ts.Apps[0].To != "2.4.0" {
		t.Errorf("ended: %+v", ts)
	}
	_, last = b.AppReport()
	if l := last["immich_server"]; l.Status != proto.AppRolledBack || l.From != "2.3.0" || l.Finished.IsZero() {
		t.Errorf("last: %+v", last)
	}
	f.mu.Lock()
	changes := f.changes
	f.mu.Unlock()
	if changes < 2 {
		t.Errorf("change callbacks: %d (start and end)", changes)
	}
	l := b.Manage(t.Context(), proto.ManageRequest{Op: proto.OpTaskList, Platform: proto.PlatformHost})
	if !slices.ContainsFunc(l.Tasks, func(x proto.TaskStatus) bool { return x.ID == id }) {
		t.Errorf("list: %+v", l.Tasks)
	}

	// The last outcomes outlive the agent.
	p2 := newAppTasks(b.cfg.StateDir)
	p2.unitActive = func(string) (bool, error) { return false, nil }
	if _, last := p2.report(); last["immich_server"].Status != proto.AppRolledBack {
		t.Errorf("last after a restart: %+v", last)
	}
}

func TestAppTaskRefusals(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("app updates are for Linux servers")
	}
	b, f := appBroker(t, composeGuests())
	for _, c := range []struct {
		apps []string
		code string
	}{
		{nil, proto.CodeInvalidValue},
		{[]string{"a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k"}, proto.CodeInvalidValue},
		{[]string{"../etc"}, proto.CodeInvalidValue},
		{[]string{"missing"}, proto.CodeNotFound},
		{[]string{"lonely"}, proto.CodeNotAllowed},
		{[]string{"pinned"}, proto.CodeNotAllowed},
		{[]string{"whombat-db"}, proto.CodeNotAllowed},
		{[]string{"immich_server", "lonely"}, proto.CodeNotAllowed},
	} {
		r := b.Manage(t.Context(), proto.ManageRequest{Op: proto.OpAppUpdate, Apps: c.apps})
		if r.OK || r.Code != c.code || r.Message == "" {
			t.Errorf("%v: %+v", c.apps, r)
		}
	}
	if len(f.argv) != 0 {
		t.Errorf("a refused update started a unit: %v", f.argv)
	}
	if r := b.Manage(t.Context(), proto.ManageRequest{Op: proto.OpTaskStatus, Task: "app:00000000000000ff"}); r.Code != proto.CodeNotFound {
		t.Errorf("unknown task: %+v", r)
	}
}

// A runner that died without a result: the task ends as failed and the
// next update can start.
func TestAppTaskRunnerGone(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("app updates are for Linux servers")
	}
	b, f := appBroker(t, composeGuests())
	resp := b.Manage(t.Context(), proto.ManageRequest{Op: proto.OpAppUpdate, Apps: []string{"immich_server"}})
	if !resp.OK {
		t.Fatalf("update: %+v", resp)
	}
	spec, _ := apps.ReadSpec(b.appMgr.taskDir(resp.Task.ID))
	f.mu.Lock()
	f.active[spec.Unit] = false
	f.mu.Unlock()
	st := b.Manage(t.Context(), proto.ManageRequest{Op: proto.OpTaskStatus, Task: resp.Task.ID, LogStart: -1})
	if st.TaskStatus.Status != "error" || st.TaskStatus.GuestID != "immich_server" || st.TaskStatus.Message == "" {
		t.Errorf("status: %+v", st.TaskStatus)
	}
	waitFor(t, func() bool { busy, _ := b.AppReport(); return len(busy) == 0 })
	r := b.Manage(t.Context(), proto.ManageRequest{Op: proto.OpAppUpdate, Apps: []string{"immich_server"}})
	if !r.OK {
		t.Fatalf("next update: %+v", r)
	}
	f.end(t, b.appMgr, r.Task.ID, &apps.TaskResult{Status: apps.StatusOK})
}

// What the person said yes to travels with the task; malformed facts are refused.
func TestAppTaskExpect(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("app updates are for Linux servers")
	}
	b, f := appBroker(t, composeGuests())
	id64 := "sha256:" + strings.Repeat("a", 64)
	good := proto.AppExpect{App: "immich_server", Service: "immich-server", ImageID: id64, Digest: "sha256:" + strings.Repeat("b", 64), ConfigHash: "c0ffee"}
	for name, e := range map[string]proto.AppExpect{
		"another app":    {App: "immich_redis", Service: "redis", ImageID: id64},
		"option service": {App: "immich_server", Service: "--build", ImageID: id64},
		"image id":       {App: "immich_server", Service: "immich-server", ImageID: "latest"},
		"digest":         {App: "immich_server", Service: "immich-server", ImageID: id64, Digest: "sha256:abc"},
		"compose hash":   {App: "immich_server", Service: "immich-server", ImageID: id64, ConfigHash: "-x"},
	} {
		r := b.Manage(t.Context(), proto.ManageRequest{Op: proto.OpAppUpdate, Apps: []string{"immich_server"}, AppExpect: []proto.AppExpect{e}})
		if r.OK || r.Code != proto.CodeInvalidValue {
			t.Errorf("%s: %+v", name, r)
		}
	}
	if r := b.Manage(t.Context(), proto.ManageRequest{Op: proto.OpAppUpdate, Apps: []string{"immich_server"}, AppExpect: []proto.AppExpect{good, good}}); r.Code != proto.CodeInvalidValue {
		t.Errorf("twice: %+v", r)
	}
	if len(f.argv) != 0 {
		t.Fatalf("a refused update started: %v", f.argv)
	}
	r := b.Manage(t.Context(), proto.ManageRequest{Op: proto.OpAppUpdate, Apps: []string{"immich_server"}, AppExpect: []proto.AppExpect{good}})
	if !r.OK {
		t.Fatalf("update: %+v", r)
	}
	spec, _ := apps.ReadSpec(b.appMgr.taskDir(r.Task.ID))
	if len(spec.Expect) != 1 || spec.Expect[0] != good {
		t.Errorf("spec: %+v", spec.Expect)
	}
	f.end(t, b.appMgr, r.Task.ID, &apps.TaskResult{Status: apps.StatusOK})
}

// A runner the server stopped while it replaced an app is started again to
// finish it (twice at most); after that the task ends with what is known.
func TestAppTaskResume(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("app updates are for Linux servers")
	}
	b, f := appBroker(t, composeGuests())
	resp := b.Manage(t.Context(), proto.ManageRequest{Op: proto.OpAppUpdate, Apps: []string{"immich_server", "immich_redis"}})
	if !resp.OK {
		t.Fatalf("update: %+v", resp)
	}
	id := resp.Task.ID
	dir := b.appMgr.taskDir(id)
	hx := strings.TrimPrefix(id, "app:")
	pend := &apps.Pending{Services: []string{"immich-server"}, OldID: "sha256:old", Backup: "x:whombat-previous-immich-server",
		Apps: []apps.Outcome{{App: "immich_server", Service: "immich-server", From: "2.3.0", To: "2.4.0"}}}
	if err := apps.WriteProgress(dir, &apps.Progress{Pending: pend}); err != nil {
		t.Fatal(err)
	}
	stop := func() {
		spec, _ := apps.ReadSpec(dir)
		f.mu.Lock()
		f.active[spec.Unit] = false
		f.mu.Unlock()
	}
	for n := 1; n <= 2; n++ {
		stop()
		st := b.Manage(t.Context(), proto.ManageRequest{Op: proto.OpTaskStatus, Task: id, LogStart: -1})
		if !st.OK || st.TaskStatus.Status != "running" {
			t.Fatalf("resume %d: %+v", n, st.TaskStatus)
		}
		spec, _ := apps.ReadSpec(dir)
		unit := fmt.Sprintf("whombat-app-%s-%d.service", hx, n)
		argv := strings.Join(f.argv[len(f.argv)-1], " ")
		if spec.Resumes != n || spec.Unit != unit || !strings.Contains(argv, "--unit="+unit) || !strings.Contains(argv, "app-task --dir "+dir) {
			t.Fatalf("resume %d: spec %+v, argv %s", n, spec, argv)
		}
		if busy, _ := b.AppReport(); !busy["immich_server"] {
			t.Fatalf("resume %d: not busy", n)
		}
	}
	stop()
	st := b.Manage(t.Context(), proto.ManageRequest{Op: proto.OpTaskStatus, Task: id, LogStart: -1})
	ts := st.TaskStatus
	if ts.Status != "error" || len(ts.Apps) != 2 || ts.Apps[0].Reason != proto.AppReasonBackFail || ts.Apps[1].Reason != proto.AppReasonInterrupted {
		t.Fatalf("settled: %+v", ts)
	}
	if len(f.argv) != 3 {
		t.Fatalf("units started: %d", len(f.argv))
	}
	waitFor(t, func() bool { busy, _ := b.AppReport(); return len(busy) == 0 })
}
