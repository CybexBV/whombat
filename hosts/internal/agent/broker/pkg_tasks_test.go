package broker

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"rackoon/internal/agent"
	"rackoon/internal/agent/pkgs"
	"rackoon/internal/proto"
)

// fakeUnits stands in for systemd: units started by systemd-run run until
// the test ends them.
type fakeUnits struct {
	mu      sync.Mutex
	active  map[string]bool
	argv    [][]string
	stopped []string
	changes int
}

func (f *fakeUnits) install(p *pkgTasks) {
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
	p.stopUnit = func(unit string) error {
		f.mu.Lock()
		defer f.mu.Unlock()
		f.stopped = append(f.stopped, unit)
		return nil
	}
	p.hostname = func() string { return "pve-02" }
	p.poll = 5 * time.Millisecond
	p.onChange = func(bool) {
		f.mu.Lock()
		f.changes++
		f.mu.Unlock()
	}
}

// end finishes a task as its runner would: result.json, then the unit
// goes.
func (f *fakeUnits) end(t *testing.T, p *pkgTasks, id string, res *pkgs.TaskResult) {
	t.Helper()
	dir := p.taskDir(id)
	if res.Finished.IsZero() {
		res.Finished = time.Now().UTC()
	}
	if err := pkgs.WriteResult(dir, res); err != nil {
		t.Fatal(err)
	}
	spec, _ := pkgs.ReadSpec(dir)
	f.mu.Lock()
	f.active[spec.Unit] = false
	f.mu.Unlock()
}

func newTestPkgTasks(t *testing.T, state string) (*pkgTasks, *fakeUnits) {
	p := newPkgTasks(state)
	f := &fakeUnits{active: map[string]bool{}}
	f.install(p)
	return p, f
}

func pkgBroker(t *testing.T, host pkgHost) (*Broker, *fakeUnits) {
	t.Helper()
	b := NewBroker(&agent.Config{StateDir: t.TempDir()}, nil, nil)
	b.pkgHost = host
	p, f := newTestPkgTasks(t, b.cfg.StateDir)
	b.pkgMgr, b.OnPackageChange = p, p.onChange
	return b, f
}

func aptHost() pkgHost {
	no := func() bool { return false }
	return pkgHost{trueNAS: no, unraid: no, nixos: no, detect: func() string { return pkgs.APT }}
}

func TestPackagesManage(t *testing.T) {
	b, f := pkgBroker(t, aptHost())
	resp := b.Manage(t.Context(), proto.ManageRequest{Op: proto.OpPackagesInstall, Platform: proto.PlatformHost, Packages: []string{"nginx", "nginx", "openssl"}})
	if !resp.OK || resp.Task == nil || !pkgTaskIDRe.MatchString(resp.Task.ID) {
		t.Fatalf("install: %+v", resp)
	}
	id := resp.Task.ID
	// The unit: the runner outside the agent, limited.
	argv := strings.Join(f.argv[0], " ")
	for _, want := range []string{"--unit=whombat-pkg-" + strings.TrimPrefix(id, "pkg:") + ".service", "--collect", "--service-type=exec",
		"RuntimeMaxSec=7500s", "TimeoutStopSec=600s", "-- /usr/local/bin/whombat-agent package-task --dir " + b.pkgMgr.taskDir(id)} {
		if !strings.Contains(argv, want) {
			t.Errorf("systemd-run lacks %q: %s", want, argv)
		}
	}
	if strings.Contains(argv, "--wait") || strings.Contains(argv, "--pipe") {
		t.Errorf("the unit must outlive the agent: %s", argv)
	}
	spec, _ := pkgs.ReadSpec(b.pkgMgr.taskDir(id))
	if spec.Op != pkgs.OpInstall || spec.Manager != pkgs.APT || !slices.Equal(spec.Packages, []string{"nginx", "openssl"}) || spec.Server != "pve-02" {
		t.Errorf("spec: %+v", spec)
	}

	// While it runs: one at a time, not stoppable, in the report.
	if r := b.Manage(t.Context(), proto.ManageRequest{Op: proto.OpPackagesCheck, Platform: proto.PlatformHost}); r.Code != CodeBusy {
		t.Errorf("second task: %+v", r)
	}
	if r := b.Manage(t.Context(), proto.ManageRequest{Op: proto.OpTaskStop, Platform: proto.PlatformHost, Task: id}); r.Code != proto.CodeNotAllowed {
		t.Errorf("stop an install: %+v", r)
	}
	task, last := b.PackageReport()
	if task == nil || task.ID != id || task.Op != pkgs.OpInstall || last != nil {
		t.Errorf("report while running: %+v %+v", task, last)
	}
	os.WriteFile(filepath.Join(b.pkgMgr.taskDir(id), pkgs.LogFile), []byte("$ apt-get update\nHit:1 http://deb.debian.org/debian bookworm InRelease\npassword=hunter2\n"), 0o600)
	st := b.Manage(t.Context(), proto.ManageRequest{Op: proto.OpTaskStatus, Task: id, LogStart: 1})
	if !st.OK || st.TaskStatus.Status != "running" || st.TaskStatus.Cancellable || st.TaskStatus.Type != proto.OpPackagesInstall ||
		len(st.TaskStatus.Log) != 2 || st.TaskStatus.LogNext != 3 || strings.Contains(st.TaskStatus.Log[1], "hunter2") {
		t.Errorf("status: %+v", st.TaskStatus)
	}

	// It ends: the result, package_last, the change callback.
	three := 3
	f.end(t, b.pkgMgr, id, &pkgs.TaskResult{Status: pkgs.StatusOK, Message: "Installed 3 updates.", Installed: &three,
		KeptBack: []string{"zfs-dkms"}, Warning: pkgs.EnterpriseWarning})
	waitFor(t, func() bool { task, _ := b.PackageReport(); return task == nil })
	st = b.Manage(t.Context(), proto.ManageRequest{Op: proto.OpTaskStatus, Platform: proto.PlatformHost, Task: id, LogStart: -1})
	ts := st.TaskStatus
	if ts.Status != "ok" || ts.Ended == nil || ts.Packages == nil || ts.Packages.Installed != 3 || !slices.Equal(ts.Packages.KeptBack, []string{"zfs-dkms"}) ||
		ts.Packages.Warning == "" || ts.Log != nil || ts.Code != "" {
		t.Errorf("ended: %+v %+v", ts, ts.Packages)
	}
	_, last = b.PackageReport()
	if last == nil || last.Op != pkgs.OpInstall || last.Status != pkgs.StatusOK || last.Installed == nil || *last.Installed != 3 {
		t.Errorf("last: %+v", last)
	}
	f.mu.Lock()
	changes := f.changes
	f.mu.Unlock()
	if changes < 2 {
		t.Errorf("change callbacks: %d (start and end)", changes)
	}
	if l := b.Manage(t.Context(), proto.ManageRequest{Op: proto.OpTaskList, Platform: proto.PlatformHost}); len(l.Tasks) != 1 || l.Tasks[0].ID != id {
		t.Errorf("list: %+v", l.Tasks)
	}

	// A check can be stopped.
	r := b.Manage(t.Context(), proto.ManageRequest{Op: proto.OpPackagesCheck, Platform: proto.PlatformHost})
	if !r.OK {
		t.Fatalf("check: %+v", r)
	}
	if st := b.Manage(t.Context(), proto.ManageRequest{Op: proto.OpTaskStatus, Task: r.Task.ID, LogStart: -1}); !st.TaskStatus.Cancellable {
		t.Error("a running check is cancellable")
	}
	if s := b.Manage(t.Context(), proto.ManageRequest{Op: proto.OpTaskStop, Task: r.Task.ID}); !s.OK || len(f.stopped) != 1 {
		t.Errorf("stop a check: %+v %v", s, f.stopped)
	}
	f.end(t, b.pkgMgr, r.Task.ID, &pkgs.TaskResult{Status: pkgs.StatusFailed, Message: "Checking for updates was stopped."})
	st = b.Manage(t.Context(), proto.ManageRequest{Op: proto.OpTaskStatus, Task: r.Task.ID, LogStart: -1})
	if st.TaskStatus.Status != "error" || st.TaskStatus.Cancellable {
		t.Errorf("stopped check: %+v", st.TaskStatus)
	}
	_, last = b.PackageReport()
	if last.Op != pkgs.OpCheck || last.Status != pkgs.StatusFailed || last.Installed != nil {
		t.Errorf("last after the check: %+v", last)
	}
	if s := b.Manage(t.Context(), proto.ManageRequest{Op: proto.OpTaskStatus, Task: "pkg:00000000000000ff"}); s.Code != proto.CodeNotFound {
		t.Errorf("unknown task: %+v", s)
	}
}

func TestPackagesRestart(t *testing.T) {
	state := t.TempDir()
	p, f := newTestPkgTasks(t, state)
	id, err := p.start(pkgs.OpInstall, pkgs.APT, nil)
	if err != nil {
		t.Fatal(err)
	}
	// The agent restarts while the task runs: the new one finds it running
	// (the unit is still there), then its result.
	p2, _ := newTestPkgTasks(t, state)
	p2.unitActive, p2.stopUnit = p.unitActive, p.stopUnit
	if task, _ := p2.report(); task == nil || task.ID != id {
		t.Fatalf("restarted agent: %+v", task)
	}
	two := 2
	f.end(t, p, id, &pkgs.TaskResult{Status: pkgs.StatusOK, Installed: &two, Message: "Installed 2 updates."})
	st, err := p2.status(id, -1)
	if err != nil || st.Status != "ok" || st.Packages.Installed != 2 {
		t.Fatalf("status after restart: %+v %v", st, err)
	}
	// Another restart: package_last from last.json.
	p3, _ := newTestPkgTasks(t, state)
	p3.unitActive = p.unitActive
	if _, last := p3.report(); last == nil || *last.Installed != 2 || last.Status != pkgs.StatusOK {
		t.Errorf("last.json: %+v", last)
	}

	// The server restarted mid-task: the unit is gone without a result.
	id, _ = p3.start(pkgs.OpInstall, pkgs.APT, nil)
	p4, _ := newTestPkgTasks(t, state) // its fake systemd knows no unit
	st, err = p4.status(id, -1)
	if err != nil || st.Status != "error" || !strings.Contains(st.Message, "restarted") {
		t.Errorf("runner gone: %+v %v", st, err)
	}
	if _, last := p4.report(); last.Status != pkgs.StatusFailed || last.Installed != nil {
		t.Errorf("last after a lost task: %+v", last)
	}

	// A day after it ended a task is gone; package_last stays.
	p4.now = func() time.Time { return time.Now().Add(25 * time.Hour) }
	if _, err := p4.status(id, -1); err == nil {
		t.Error("expired task still known")
	}
	if l := p4.list(); len(l) != 0 {
		t.Errorf("expired tasks listed: %+v", l)
	}
	if _, last := p4.report(); last == nil {
		t.Error("package_last expired")
	}
}

func TestPackagesNoSystemd(t *testing.T) {
	p, _ := newTestPkgTasks(t, t.TempDir())
	p.systemd = func() bool { return false }
	var spawned []string
	live := true
	p.spawn = func(argv []string) (int, error) { spawned = argv; return 4242, nil }
	p.alive = func(pid int, dir string) bool {
		return live && pid == 4242 && strings.HasSuffix(dir, "pkg-"+strings.TrimPrefix(spawned[3], p.dir+"/pkg-"))
	}
	var killed int
	p.kill = func(pid int) error { killed = pid; return nil }
	id, err := p.start(pkgs.OpCheck, pkgs.APK, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(spawned[:3], []string{"/usr/local/bin/whombat-agent", "package-task", "--dir"}) {
		t.Errorf("spawn: %q", spawned)
	}
	spec, _ := pkgs.ReadSpec(p.taskDir(id))
	if spec.PID != 4242 || spec.Unit != "" {
		t.Errorf("spec: %+v", spec)
	}
	if st, _ := p.status(id, -1); st.Status != "running" {
		t.Errorf("running: %+v", st)
	}
	if err := p.stop(id); err != nil || killed != 4242 {
		t.Errorf("stop: %v %d", err, killed)
	}
	live = false
	if st, _ := p.status(id, -1); st.Status != "error" {
		t.Errorf("runner gone: %+v", st)
	}
}

func TestPackagesRefusals(t *testing.T) {
	yes, no := func() bool { return true }, func() bool { return false }
	apt := func() string { return pkgs.APT }
	cases := []struct {
		name string
		host pkgHost
		req  proto.ManageRequest
		code string
		word string
	}{
		{"truenas", pkgHost{trueNAS: yes, unraid: no, nixos: no, detect: apt}, proto.ManageRequest{Op: proto.OpPackagesInstall}, proto.CodeNotAllowed, "TrueNAS installs its updates itself"},
		{"unraid", pkgHost{trueNAS: no, unraid: yes, nixos: no, detect: apt}, proto.ManageRequest{Op: proto.OpPackagesCheck}, CodeUnsupported, "Unraid"},
		{"nixos", pkgHost{trueNAS: no, unraid: no, nixos: yes, detect: apt}, proto.ManageRequest{Op: proto.OpPackagesCheck}, CodeUnsupported, "NixOS"},
		{"none", pkgHost{trueNAS: no, unraid: no, nixos: no, detect: func() string { return "" }}, proto.ManageRequest{Op: proto.OpPackagesCheck}, CodeUnsupported, "no package manager"},
		{"pacman named", pkgHost{trueNAS: no, unraid: no, nixos: no, detect: func() string { return pkgs.Pacman }},
			proto.ManageRequest{Op: proto.OpPackagesInstall, Packages: []string{"linux"}}, proto.CodeNotAllowed, "Arch"},
		{"bad name", aptHost(), proto.ManageRequest{Op: proto.OpPackagesInstall, Packages: []string{"--allow-downgrades"}}, proto.CodeInvalidValue, "not a package name"},
		{"names on a check", aptHost(), proto.ManageRequest{Op: proto.OpPackagesCheck, Packages: []string{"nginx"}}, proto.CodeInvalidValue, "no package names"},
		{"platform", aptHost(), proto.ManageRequest{Op: proto.OpPackagesCheck, Platform: proto.PlatformPVE}, CodeInvalid, "host"},
	}
	for _, c := range cases {
		b, f := pkgBroker(t, c.host)
		r := b.Manage(t.Context(), c.req)
		if r.OK || r.Code != c.code || !strings.Contains(r.Message, c.word) || strings.Contains(r.Message, "unknown operation") {
			t.Errorf("%s: %+v", c.name, r)
		}
		if len(f.argv) != 0 {
			t.Errorf("%s: started a unit", c.name)
		}
	}
	many := make([]string, proto.PackagesMax+1)
	for i := range many {
		many[i] = "p" + string(rune('a'+i%26))
	}
	b, _ := pkgBroker(t, aptHost())
	if r := b.Manage(t.Context(), proto.ManageRequest{Op: proto.OpPackagesInstall, Packages: many}); r.Code != proto.CodeInvalidValue || r.FieldErrors["packages"] == "" {
		t.Errorf("too many: %+v", r)
	}
	// Other task ids are not ours.
	if _, ok := b.packagesManage(proto.ManageRequest{Op: proto.OpTaskStatus, Task: "unraid:0123456789abcdef"}); ok {
		t.Error("an unRAID task")
	}
}
