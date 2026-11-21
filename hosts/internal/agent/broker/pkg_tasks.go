package broker

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"rackoon/internal/agent"
	"rackoon/internal/agent/macos"
	"rackoon/internal/agent/pkgs"
	"rackoon/internal/proto"
)

// Package updates (docs/MANAGE.md 2.9): packages.check and
// packages.install run as a task "pkg:<16 hex>". The agent writes the
// task's spec into <state>/packages/pkg-<hex>/ and starts `whombat-agent
// package-task` there, in a transient systemd unit (outside the agent's
// sandbox, which keeps / read-only; the unit outlives the agent) or, without
// systemd, in its own session. The runner appends to the task's log and
// writes result.json last, so an agent that restarted meanwhile still
// finds the outcome. One package task at a time; tasks are kept a day
// after they end, the last outcome (package_last) for good.

const (
	pkgTaskKeep   = 24 * time.Hour
	pkgTaskLogMax = 500
	pkgUnitPrefix = "whombat-pkg-"
	pkgLastFile   = "last.json"
	// pkgUnitSlack: systemd stops the unit this long after the runner's own
	// limit, should the runner hang.
	pkgUnitSlack = 5 * time.Minute
)

var pkgTaskIDRe = regexp.MustCompile(`^pkg:([0-9a-f]{16})$`)

// pkgTasks is the registry.
type pkgTasks struct {
	mu        sync.Mutex
	dir       string // <state>/packages
	configDir string // the agent's configuration (a Mac's screen account)
	loaded    bool
	watching  bool
	last      *pkgLast
	current   *pkgs.TaskSpec // the running task (watch keeps it)

	// The host; tests replace them.
	exe        func() (string, error)
	systemd    func() bool
	systemdRun func(argv []string) error
	unitActive func(unit string) (bool, error)
	stopUnit   func(unit string) error
	spawn      func(argv []string) (int, error)
	alive      func(pid int, dir string) bool
	kill       func(pid int) error
	hostname   func() string
	now        func() time.Time
	poll       time.Duration
	// onChange runs when a task started (ended false: the agent reports at
	// once) or ended (ended true: it also reads the waiting updates and the
	// reboot need again).
	onChange func(ended bool)
}

// pkgLast is last.json (proto.PackageLast with JSON names).
type pkgLast struct {
	Op        string    `json:"op"`
	Status    string    `json:"status"`
	Finished  time.Time `json:"finished"`
	Installed *int      `json:"installed,omitempty"`
	Message   string    `json:"message,omitempty"`
	Code      string    `json:"code,omitempty"`
	Task      string    `json:"task"`
}

func newPkgTasks(stateDir string) *pkgTasks {
	if stateDir == "" {
		stateDir = os.TempDir()
	}
	return &pkgTasks{dir: filepath.Join(stateDir, "packages"),
		exe: agent.ExecutablePath, systemd: pkgSystemd, systemdRun: runSystemdRun, unitActive: unitActive,
		stopUnit: stopUnit, spawn: spawnRunner, alive: runnerAlive, kill: func(pid int) error { return syscall.Kill(pid, syscall.SIGTERM) },
		hostname: shortHostname, now: time.Now, poll: 2 * time.Second}
}

// pkgTaskDir is a task's directory ("" for an id that isn't one).
func (p *pkgTasks) taskDir(id string) string {
	m := pkgTaskIDRe.FindStringSubmatch(id)
	if m == nil {
		return ""
	}
	return filepath.Join(p.dir, "pkg-"+m[1])
}

// loadLocked reads the tasks on disk once: expires old ones, records an
// outcome the agent missed while it was down, and follows a task that
// still runs.
func (p *pkgTasks) loadLocked() {
	if p.loaded {
		return
	}
	p.loaded = true
	var l pkgLast
	if b, err := os.ReadFile(filepath.Join(p.dir, pkgLastFile)); err == nil && json.Unmarshal(b, &l) == nil && l.Op != "" {
		p.last = &l
	}
	for _, t := range p.scanLocked() {
		if t.res == nil {
			if p.current == nil {
				p.current = t.spec
			}
		} else {
			p.recordLocked(t)
		}
	}
	if p.current != nil {
		p.watchLocked()
	}
}

// pkgTask is one task as read from its directory.
type pkgTask struct {
	dir  string
	spec *pkgs.TaskSpec
	res  *pkgs.TaskResult
}

// scanLocked reads every task, newest first; it settles tasks whose runner
// is gone without a result and removes those that ended a day ago.
func (p *pkgTasks) scanLocked() []pkgTask {
	ents, err := os.ReadDir(p.dir)
	if err != nil {
		return nil
	}
	var out []pkgTask
	cut := p.now().Add(-pkgTaskKeep)
	for _, e := range ents {
		if !e.IsDir() || !strings.HasPrefix(e.Name(), "pkg-") {
			continue
		}
		t, ok := p.readLocked(filepath.Join(p.dir, e.Name()))
		if !ok {
			continue
		}
		if t.res != nil && t.res.Finished.Before(cut) {
			_ = os.RemoveAll(t.dir)
			continue
		}
		out = append(out, t)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].spec.Started.After(out[j].spec.Started) })
	return out
}

// readLocked reads a task; when its runner is gone without writing a
// result, the agent writes one (the server restarted, the runner was
// killed).
func (p *pkgTasks) readLocked(dir string) (pkgTask, bool) {
	spec, err := pkgs.ReadSpec(dir)
	if err != nil || spec.ID == "" || p.taskDir(spec.ID) != dir {
		if err != nil && errors.Is(err, os.ErrNotExist) {
			// A directory without its spec: an interrupted start.
			if st, serr := os.Stat(dir); serr == nil && p.now().Sub(st.ModTime()) > time.Hour {
				_ = os.RemoveAll(dir)
			}
		}
		return pkgTask{}, false
	}
	t := pkgTask{dir: dir, spec: spec}
	t.res, _ = pkgs.ReadResult(dir)
	if t.res != nil {
		return t, true
	}
	if p.runningLocked(t) {
		return t, true
	}
	// Read the result again: the runner may have written it and exited
	// between the two reads.
	if t.res, _ = pkgs.ReadResult(dir); t.res != nil {
		return t, true
	}
	res := &pkgs.TaskResult{Status: pkgs.StatusFailed, Finished: p.now().UTC(),
		Message: "The server may have restarted while it ran."}
	if err := pkgs.WriteResult(dir, res); err == nil {
		t.res, _ = pkgs.ReadResult(dir)
	}
	if t.res == nil {
		t.res = res
	}
	return t, true
}

// runningLocked: the task's runner still runs.
func (p *pkgTasks) runningLocked(t pkgTask) bool {
	switch {
	case t.spec.Unit != "":
		active, err := p.unitActive(t.spec.Unit)
		if err != nil {
			// systemd didn't answer: assume it runs, until systemd would
			// have stopped it anyway.
			return p.now().Sub(t.spec.Started) < pkgs.Limit(t.spec.Op)+pkgUnitSlack
		}
		return active
	case t.spec.PID > 0:
		return p.alive(t.spec.PID, t.dir)
	}
	// Spec written, runner not started yet (start holds the lock while it
	// does both), or an agent that died in between.
	return p.now().Sub(t.spec.Started) < time.Minute
}

// recordLocked keeps an ended task as the last outcome when it is newer.
func (p *pkgTasks) recordLocked(t pkgTask) bool {
	if t.res == nil || (p.last != nil && !t.res.Finished.After(p.last.Finished)) {
		return false
	}
	op := t.spec.Op
	l := &pkgLast{Op: op, Status: t.res.Status, Finished: t.res.Finished.UTC(), Message: t.res.Message, Code: t.res.Code, Task: t.spec.ID}
	if op == pkgs.OpInstall && t.res.Installed != nil {
		n := *t.res.Installed
		l.Installed = &n
	}
	p.last = l
	if b, err := json.Marshal(l); err == nil {
		tmp := filepath.Join(p.dir, pkgLastFile+".tmp")
		if os.WriteFile(tmp, b, 0o600) == nil {
			_ = os.Rename(tmp, filepath.Join(p.dir, pkgLastFile))
		}
	}
	return true
}

// watchLocked follows the running task until it ends.
func (p *pkgTasks) watchLocked() {
	if p.watching {
		return
	}
	p.watching = true
	go func() {
		for {
			time.Sleep(p.poll)
			p.mu.Lock()
			changed := false
			var current *pkgs.TaskSpec
			for _, t := range p.scanLocked() {
				if t.res == nil {
					if current == nil {
						current = t.spec
					}
				} else if p.recordLocked(t) {
					changed = true
				}
			}
			p.current = current
			running := current != nil
			if !running {
				p.watching = false
			}
			onChange := p.onChange
			p.mu.Unlock()
			if changed && onChange != nil {
				onChange(true)
			}
			if !running {
				return
			}
		}
	}()
}

// start starts a task (op pkgs.OpCheck or pkgs.OpInstall).
func (p *pkgTasks) start(op, manager string, packages []string) (string, error) {
	p.mu.Lock()
	p.loadLocked()
	for _, t := range p.scanLocked() {
		if t.res == nil {
			p.mu.Unlock()
			what := "checked"
			if t.spec.Op == pkgs.OpInstall {
				what = "installed"
			}
			return "", codeErr(CodeBusy, "Updates are being "+what+" on this server right now. Wait until that has finished.")
		}
	}
	exe, err := p.exe()
	if err != nil {
		p.mu.Unlock()
		return "", codeErr(CodePlatformError, "The agent can’t find its own program to run the update task: "+err.Error())
	}
	var b [8]byte
	_, _ = rand.Read(b[:])
	hx := hex.EncodeToString(b[:])
	id := proto.PackageTaskPrefix + hx
	dir := filepath.Join(p.dir, "pkg-"+hx)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		p.mu.Unlock()
		return "", codeErr(CodePlatformError, "The agent can’t keep the update task’s log: "+err.Error())
	}
	spec := &pkgs.TaskSpec{ID: id, Op: op, Manager: manager, Packages: packages, Started: p.now().UTC(), Server: p.hostname()}
	if manager == pkgs.SoftwareUpdate {
		spec.ConfigDir = p.configDir
	}
	argv := []string{exe, "package-task", "--dir", dir}
	fail := func(err error) (string, error) {
		_ = os.RemoveAll(dir)
		p.mu.Unlock()
		return "", codeErr(CodePlatformError, "The update task didn’t start: "+err.Error())
	}
	if p.systemd() {
		spec.Unit = pkgUnitPrefix + hx + ".service"
		if err := pkgs.WriteSpec(dir, spec); err != nil {
			return fail(err)
		}
		if err := p.systemdRun(pkgUnitArgv(spec.Unit, op, argv)); err != nil {
			return fail(err)
		}
	} else {
		if err := pkgs.WriteSpec(dir, spec); err != nil {
			return fail(err)
		}
		pid, err := p.spawn(argv)
		if err != nil {
			return fail(err)
		}
		spec.PID = pid
		if err := pkgs.WriteSpec(dir, spec); err != nil {
			_ = p.kill(pid)
			return fail(err)
		}
	}
	p.current = spec
	p.watchLocked()
	onChange := p.onChange
	p.mu.Unlock()
	if onChange != nil {
		go onChange(false)
	}
	return id, nil
}

// pkgUnitArgv is systemd-run for a task: a transient service, collected
// when it ends, stopped by systemd should it run past the task's limit.
// Not --wait or --pipe: the unit outlives the agent.
func pkgUnitArgv(unit, op string, argv []string) []string {
	stop := 15 * time.Second // a check: SIGTERM, then everything killed
	if op == pkgs.OpInstall {
		stop = 10 * time.Minute // an install finishes dpkg's work first
	}
	out := []string{systemdRunPath(), "--quiet", "--collect", "--service-type=exec", "--unit=" + unit,
		"--description=Whombat: operating system updates",
		"--property=KillMode=mixed",
		fmt.Sprintf("--property=TimeoutStopSec=%ds", int(stop.Seconds())),
		fmt.Sprintf("--property=RuntimeMaxSec=%ds", int((pkgs.Limit(op) + pkgUnitSlack).Seconds())),
		"--working-directory=/", "--"}
	return append(out, argv...)
}

// status answers task.status (logStart -1: no log).
func (p *pkgTasks) status(id string, logStart int) (*proto.TaskStatus, error) {
	dir := p.taskDir(id)
	if dir == "" {
		return nil, codeErr(proto.CodeNotFound, "Not a package task.")
	}
	p.mu.Lock()
	p.loadLocked()
	t, ok := p.readLocked(dir)
	if ok && t.res != nil {
		if p.current != nil && p.current.ID == t.spec.ID {
			p.current = nil
		}
		if p.recordLocked(t) && p.onChange != nil {
			go p.onChange(true)
		}
	}
	p.mu.Unlock()
	if !ok || (t.res != nil && t.res.Finished.Before(p.now().Add(-pkgTaskKeep))) {
		return nil, codeErr(proto.CodeNotFound, "This update task is not known (it ended over a day ago).")
	}
	st := taskStatusOf(t)
	if logStart >= 0 {
		lines := readTaskLog(filepath.Join(dir, pkgs.LogFile), maskSecrets)
		logStart = min(logStart, len(lines))
		end := min(len(lines), logStart+pkgTaskLogMax)
		st.Log = lines[logStart:end]
		st.LogNext = end
	}
	return &st, nil
}

func taskStatusOf(t pkgTask) proto.TaskStatus {
	st := proto.TaskStatus{ID: t.spec.ID, Type: "packages." + t.spec.Op, User: "root", Started: t.spec.Started, Status: "running"}
	if t.res == nil {
		st.Cancellable = t.spec.Op == pkgs.OpCheck
		return st
	}
	e := t.res.Finished
	st.Ended = &e
	st.Status = "ok"
	if t.res.Status != pkgs.StatusOK {
		st.Status = "error"
	}
	st.Message, st.Code = truncateText(t.res.Message, 500), t.res.Code
	pr := &proto.PackageResult{KeptBack: slices.Clone(t.res.KeptBack), Warning: t.res.Warning}
	if t.res.Installed != nil {
		pr.Installed = *t.res.Installed
	}
	if pr.KeptBack == nil {
		pr.KeptBack = []string{}
	}
	st.Packages = pr
	return st
}

// stop answers task.stop: a check stops, an install doesn't.
func (p *pkgTasks) stop(id string) error {
	dir := p.taskDir(id)
	if dir == "" {
		return codeErr(proto.CodeNotFound, "Not a package task.")
	}
	p.mu.Lock()
	p.loadLocked()
	t, ok := p.readLocked(dir)
	p.mu.Unlock()
	switch {
	case !ok:
		return codeErr(proto.CodeNotFound, "This update task is not known.")
	case t.res != nil:
		return nil // it ended
	case t.spec.Op == pkgs.OpInstall:
		return codeErr(proto.CodeNotAllowed, "Installing updates can’t be stopped once it started.")
	case t.spec.Unit != "":
		if err := p.stopUnit(t.spec.Unit); err != nil {
			return codeErr(CodePlatformError, "Couldn’t stop it: "+err.Error())
		}
	case t.spec.PID > 0:
		if err := p.kill(t.spec.PID); err != nil && !errors.Is(err, syscall.ESRCH) {
			return codeErr(CodePlatformError, "Couldn’t stop it: "+err.Error())
		}
	}
	return nil
}

// list answers task.list: the package tasks of the last day, newest first.
func (p *pkgTasks) list() []proto.TaskStatus {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.loadLocked()
	out := []proto.TaskStatus{}
	for _, t := range p.scanLocked() {
		out = append(out, taskStatusOf(t))
	}
	return out
}

// report is the report's package_task and package_last.
func (p *pkgTasks) report() (*proto.PackageTask, *proto.PackageLast) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.loadLocked()
	var task *proto.PackageTask
	if c := p.current; c != nil {
		task = &proto.PackageTask{ID: c.ID, Op: c.Op, Started: c.Started}
	}
	var last *proto.PackageLast
	if l := p.last; l != nil {
		last = &proto.PackageLast{Op: l.Op, Status: l.Status, Finished: l.Finished, Message: l.Message, Code: l.Code}
		if l.Installed != nil {
			n := *l.Installed
			last.Installed = &n
		}
	}
	return task, last
}

// ---- the host -------------------------------------------------------------------------

func systemdRunPath() string {
	for _, p := range []string{"/usr/bin/systemd-run", "/bin/systemd-run"} {
		if fileExists(p) {
			return p
		}
	}
	return "/usr/bin/systemd-run"
}

func systemctlPath() string {
	for _, p := range []string{"/usr/bin/systemctl", "/bin/systemctl"} {
		if fileExists(p) {
			return p
		}
	}
	return "/usr/bin/systemctl"
}

// pkgSystemd: systemd is the init system and systemd-run is there (also
// for an agent started by hand).
func pkgSystemd() bool {
	return isSystemdHost() && (fileExists("/usr/bin/systemd-run") || fileExists("/bin/systemd-run"))
}

func runSystemdRun(argv []string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	cmd.Env = baseEnv()
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("%v: %s", err, lastLine(string(out)))
	}
	return nil
}

// unitActive asks systemd whether the unit still runs (a collected unit
// is "inactive").
func unitActive(unit string) (bool, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, systemctlPath(), "show", "--property=ActiveState", "--value", unit)
	cmd.Env = baseEnv()
	out, err := cmd.Output()
	if err != nil {
		return false, err
	}
	switch strings.TrimSpace(string(out)) {
	case "active", "activating", "deactivating", "reloading", "refreshing":
		return true, nil
	}
	return false, nil
}

func stopUnit(unit string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, systemctlPath(), "stop", unit)
	cmd.Env = baseEnv()
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("%v: %s", err, lastLine(string(out)))
	}
	return nil
}

// spawnRunner starts the runner in its own session (no systemd): it keeps
// running when the agent stops.
func spawnRunner(argv []string) (int, error) {
	devnull, err := os.OpenFile(os.DevNull, os.O_RDWR, 0)
	if err != nil {
		return 0, err
	}
	defer devnull.Close()
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Env = pkgs.Env
	cmd.Dir = "/"
	cmd.Stdin, cmd.Stdout, cmd.Stderr = devnull, devnull, devnull
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		return 0, err
	}
	go cmd.Wait() //nolint:errcheck // reaped; the result is in its files
	return cmd.Process.Pid, nil
}

// runnerAlive: pid is still the runner of the task in dir.
func runnerAlive(pid int, dir string) bool {
	if runtime.GOOS == "darwin" {
		return darwinRunnerAlive(pid, dir)
	}
	b, err := os.ReadFile(filepath.Join("/proc", strconv.Itoa(pid), "cmdline"))
	if err != nil {
		return false
	}
	args := strings.Split(string(b), "\x00")
	return slices.Contains(args, "package-task") && slices.Contains(args, dir)
}

// darwinRunnerAlive asks ps for the process's command line (a Mac has no
// /proc). The task directory has no spaces, so the words are the
// arguments.
func darwinRunnerAlive(pid int, dir string) bool {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	out, err := macos.Run(ctx, 10*time.Second, macos.Ps, "-ww", "-o", "args=", "-p", strconv.Itoa(pid))
	if err != nil {
		return false
	}
	args := strings.Fields(string(out))
	return slices.Contains(args, "package-task") && slices.Contains(args, dir)
}

func shortHostname() string {
	h, err := os.Hostname()
	if err != nil || h == "" {
		return ""
	}
	if i := strings.IndexByte(h, '.'); i > 0 {
		h = h[:i]
	}
	return h
}

// ---- manage operations ----------------------------------------------------------------

// pkgHost tells what kind of system this is (tests replace it).
type pkgHost struct {
	trueNAS, unraid, nixos func() bool
	detect                 func() string
}

var realPkgHost = pkgHost{trueNAS: pkgs.IsTrueNAS, unraid: pkgs.IsUnraid, nixos: pkgs.IsNixOS, detect: pkgs.Detect}

// packagesManage answers packages.check and packages.install, and the
// task operations of package tasks; ok is false for every other request.
func (b *Broker) packagesManage(req proto.ManageRequest) (proto.ManageResponse, bool) {
	isTask := strings.HasPrefix(req.Task, proto.PackageTaskPrefix)
	switch {
	case req.Op == proto.OpPackagesCheck || req.Op == proto.OpPackagesInstall:
	case (req.Op == proto.OpTaskStatus || req.Op == proto.OpTaskStop) && isTask:
	case req.Op == proto.OpTaskList && req.Platform == proto.PlatformHost:
	default:
		return proto.ManageResponse{}, false
	}
	if req.Platform != "" && req.Platform != proto.PlatformHost {
		return proto.ManageResponse{Code: CodeInvalid, Message: "Package updates are the host’s: platform host."}, true
	}
	p := b.packages()
	fail := func(err error) (proto.ManageResponse, bool) {
		var fe *fieldError
		if errors.As(err, &fe) {
			return proto.ManageResponse{Code: proto.CodeInvalidValue, Message: fe.msg, FieldErrors: map[string]string{fe.field: fe.msg}}, true
		}
		code, msg := errCode(err, CodePlatformError)
		return proto.ManageResponse{Code: code, Message: msg}, true
	}
	switch req.Op {
	case proto.OpTaskStatus:
		st, err := p.status(req.Task, req.LogStart)
		if err != nil {
			return fail(err)
		}
		return proto.ManageResponse{OK: true, TaskStatus: st}, true
	case proto.OpTaskStop:
		if err := p.stop(req.Task); err != nil {
			return fail(err)
		}
		return proto.ManageResponse{OK: true}, true
	case proto.OpTaskList:
		return proto.ManageResponse{OK: true, Tasks: p.list()}, true
	}
	op := pkgs.OpCheck
	if req.Op == proto.OpPackagesInstall {
		op = pkgs.OpInstall
	}
	names, err := packageNames(op, req.Packages)
	if err != nil {
		return fail(err)
	}
	h := b.pkgHost
	if h.detect == nil {
		h = realPkgHost
	}
	// TrueNAS has apt but switches it off: ask before looking for apt.
	switch {
	case h.trueNAS():
		return fail(codeErr(proto.CodeNotAllowed, "TrueNAS installs its updates itself, on its Update page."))
	case h.unraid():
		return fail(codeErr(CodeUnsupported, "Unraid updates itself on its Update OS page, and its plugins and containers have their own updates."))
	case h.nixos():
		return fail(codeErr(CodeUnsupported, "NixOS is updated by changing its configuration, not by installing packages."))
	}
	manager := h.detect()
	switch {
	case manager == "":
		return fail(codeErr(CodeUnsupported, "This server has no package manager Whombat can use."))
	case manager == pkgs.Pacman && len(names) > 0:
		return fail(codeErr(proto.CodeNotAllowed, "Arch installs every update together, so single packages can’t be installed on their own."))
	}
	id, err := p.start(op, manager, names)
	if err != nil {
		return fail(err)
	}
	return proto.ManageResponse{OK: true, Task: &proto.TaskRef{ID: id}}, true
}

// packageNames checks packages.install's names (a check takes none);
// duplicates go.
func packageNames(op string, names []string) ([]string, error) {
	if len(names) == 0 {
		return nil, nil
	}
	if op == pkgs.OpCheck {
		return nil, &fieldError{field: "packages", msg: "A check takes no package names."}
	}
	if len(names) > proto.PackagesMax {
		return nil, &fieldError{field: "packages", msg: fmt.Sprintf("At most %d packages at once.", proto.PackagesMax)}
	}
	nameRe := pkgs.PackageNameRe
	if runtime.GOOS == "darwin" {
		nameRe = macos.LabelRe // softwareupdate's labels
	}
	var out []string
	for _, n := range names {
		if !nameRe.MatchString(n) {
			return nil, &fieldError{field: "packages", msg: fmt.Sprintf("%q is not a package name.", truncateText(n, 64))}
		}
		if !slices.Contains(out, n) {
			out = append(out, n)
		}
	}
	return out, nil
}

// packages returns the registry (created on first use).
func (b *Broker) packages() *pkgTasks {
	b.pkgOnce.Do(func() {
		if b.pkgMgr == nil {
			b.pkgMgr = newPkgTasks(b.cfg.StateDir)
			b.pkgMgr.configDir = b.cfg.Dir
		}
		b.pkgMgr.mu.Lock()
		b.pkgMgr.onChange = func(ended bool) {
			if f := b.OnPackageChange; f != nil {
				f(ended)
			}
		}
		b.pkgMgr.mu.Unlock()
	})
	return b.pkgMgr
}

// PackageReport is the report's running package task and the last one
// that ended (SystemInfo.PackageTask, PackageLast).
func (b *Broker) PackageReport() (*proto.PackageTask, *proto.PackageLast) {
	return b.packages().report()
}
