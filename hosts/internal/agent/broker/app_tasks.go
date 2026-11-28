package broker

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
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
	"rackoon/internal/agent/apps"
	"rackoon/internal/agent/systemdrun"
	"rackoon/internal/proto"
)

// App updates (docs/MANAGE.md 2.11): app.update runs as a task "app:<16
// hex>" the way a package task does (pkg_tasks.go): the agent writes the
// task's spec into <state>/apps/app-<hex>/ and starts `whombat-agent
// app-task` there in a transient systemd unit (outside the agent's sandbox,
// which keeps / read-only and can't run Compose in a project's folder; the
// unit outlives the agent) or, without systemd, in its own session. The
// runner writes result.json last. One app task at a time; tasks are kept a
// day after they end, each container's last outcome (last.json) for good.

const (
	appTaskKeep   = 24 * time.Hour
	appUnitPrefix = "whombat-app-"
	appLastFile   = "last.json"
	appLastMax    = 200
)

var appTaskIDRe = regexp.MustCompile(`^app:([0-9a-f]{16})$`)

// appTasks is the registry.
type appTasks struct {
	mu       sync.Mutex
	dir      string // <state>/apps
	loaded   bool
	watching bool
	current  *apps.TaskSpec
	last     map[string]appLastEntry // by container name

	// The host; tests replace them.
	exe        func() (string, error)
	systemd    func() bool
	systemdRun func(argv []string) error
	unitActive func(unit string) (bool, error)
	spawn      func(argv []string) (int, error)
	alive      func(pid int, dir string) bool
	now        func() time.Time
	poll       time.Duration
	// onChange runs when a task started or ended (the agent reports).
	onChange func()
}

// appLastEntry is one container's last outcome in last.json.
type appLastEntry struct {
	Status   string    `json:"status"`
	Reason   string    `json:"reason,omitempty"`
	From     string    `json:"from,omitempty"`
	To       string    `json:"to,omitempty"`
	Finished time.Time `json:"finished"`
	Task     string    `json:"task"`
}

func newAppTasks(stateDir string) *appTasks {
	if stateDir == "" {
		stateDir = os.TempDir()
	}
	return &appTasks{dir: filepath.Join(stateDir, "apps"), last: map[string]appLastEntry{},
		exe: agent.ExecutablePath, systemd: pkgSystemd, systemdRun: runSystemdRun, unitActive: unitActive,
		spawn: spawnAppRunner, alive: appRunnerAlive, now: time.Now, poll: 2 * time.Second}
}

func (p *appTasks) taskDir(id string) string {
	m := appTaskIDRe.FindStringSubmatch(id)
	if m == nil {
		return ""
	}
	return filepath.Join(p.dir, "app-"+m[1])
}

type appTask struct {
	dir  string
	spec *apps.TaskSpec
	res  *apps.TaskResult
}

func (p *appTasks) loadLocked() {
	if p.loaded {
		return
	}
	p.loaded = true
	if b, err := os.ReadFile(filepath.Join(p.dir, appLastFile)); err == nil {
		_ = json.Unmarshal(b, &p.last)
		if p.last == nil {
			p.last = map[string]appLastEntry{}
		}
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

// scanLocked reads every task, newest first; it settles tasks whose runner
// is gone without a result and removes those that ended a day ago.
func (p *appTasks) scanLocked() []appTask {
	ents, err := os.ReadDir(p.dir)
	if err != nil {
		return nil
	}
	var out []appTask
	cut := p.now().Add(-appTaskKeep)
	for _, e := range ents {
		if !e.IsDir() || !strings.HasPrefix(e.Name(), "app-") {
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

func (p *appTasks) readLocked(dir string) (appTask, bool) {
	spec, err := apps.ReadSpec(dir)
	if err != nil || spec.ID == "" || p.taskDir(spec.ID) != dir {
		if err != nil && errors.Is(err, os.ErrNotExist) {
			if st, serr := os.Stat(dir); serr == nil && p.now().Sub(st.ModTime()) > time.Hour {
				_ = os.RemoveAll(dir)
			}
		}
		return appTask{}, false
	}
	t := appTask{dir: dir, spec: spec}
	t.res, _ = apps.ReadResult(dir)
	if t.res != nil || p.runningLocked(t) {
		return t, true
	}
	if t.res, _ = apps.ReadResult(dir); t.res != nil {
		return t, true
	}
	res := &apps.TaskResult{Status: apps.StatusFailed, Finished: p.now().UTC(), Apps: []apps.Outcome{},
		Message: "The server may have restarted while it ran."}
	if err := apps.WriteResult(dir, res); err == nil {
		t.res, _ = apps.ReadResult(dir)
	}
	if t.res == nil {
		t.res = res
	}
	return t, true
}

func (p *appTasks) runningLocked(t appTask) bool {
	switch {
	case t.spec.Unit != "":
		active, err := p.unitActive(t.spec.Unit)
		if err != nil {
			return p.now().Sub(t.spec.Started) < apps.Limit(len(t.spec.Apps))+pkgUnitSlack
		}
		return active
	case t.spec.PID > 0:
		return p.alive(t.spec.PID, t.dir)
	}
	return p.now().Sub(t.spec.Started) < time.Minute
}

// recordLocked keeps an ended task's outcome per container (newer wins).
func (p *appTasks) recordLocked(t appTask) bool {
	if t.res == nil {
		return false
	}
	changed := false
	for _, a := range t.res.Apps {
		if a.App == "" {
			continue
		}
		if old, ok := p.last[a.App]; ok && !t.res.Finished.After(old.Finished) {
			continue
		}
		p.last[a.App] = appLastEntry{Status: a.Status, Reason: a.Reason, From: a.From, To: a.To,
			Finished: t.res.Finished.UTC(), Task: t.spec.ID}
		changed = true
	}
	if !changed {
		return false
	}
	if len(p.last) > appLastMax {
		names := make([]string, 0, len(p.last))
		for n := range p.last {
			names = append(names, n)
		}
		sort.Slice(names, func(i, j int) bool { return p.last[names[i]].Finished.Before(p.last[names[j]].Finished) })
		for _, n := range names[:len(names)-appLastMax] {
			delete(p.last, n)
		}
	}
	if b, err := json.Marshal(p.last); err == nil {
		tmp := filepath.Join(p.dir, appLastFile+".tmp")
		if os.WriteFile(tmp, b, 0o600) == nil {
			_ = os.Rename(tmp, filepath.Join(p.dir, appLastFile))
		}
	}
	return true
}

func (p *appTasks) watchLocked() {
	if p.watching {
		return
	}
	p.watching = true
	go func() {
		for {
			time.Sleep(p.poll)
			p.mu.Lock()
			changed := false
			var current *apps.TaskSpec
			for _, t := range p.scanLocked() {
				if t.res == nil {
					if current == nil {
						current = t.spec
					}
				} else if p.recordLocked(t) {
					changed = true
				}
			}
			ended := p.current != nil && current == nil
			p.current = current
			running := current != nil
			if !running {
				p.watching = false
			}
			onChange := p.onChange
			p.mu.Unlock()
			if (changed || ended) && onChange != nil {
				onChange()
			}
			if !running {
				return
			}
		}
	}()
}

// start starts a task updating the named containers.
func (p *appTasks) start(names []string, holdMajor bool) (string, error) {
	p.mu.Lock()
	p.loadLocked()
	for _, t := range p.scanLocked() {
		if t.res == nil {
			p.mu.Unlock()
			return "", codeErr(CodeBusy, "Apps are being updated on this server right now. Wait until that has finished.")
		}
	}
	exe, err := p.exe()
	if err != nil {
		p.mu.Unlock()
		return "", codeErr(CodePlatformError, "The agent can’t find its own program to run the update: "+err.Error())
	}
	var b [8]byte
	_, _ = rand.Read(b[:])
	hx := hex.EncodeToString(b[:])
	id := proto.AppTaskPrefix + hx
	dir := filepath.Join(p.dir, "app-"+hx)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		p.mu.Unlock()
		return "", codeErr(CodePlatformError, "The agent can’t keep the update’s log: "+err.Error())
	}
	spec := &apps.TaskSpec{ID: id, Apps: names, HoldMajor: holdMajor, Started: p.now().UTC()}
	argv := []string{exe, "app-task", "--dir", dir}
	fail := func(err error) (string, error) {
		_ = os.RemoveAll(dir)
		p.mu.Unlock()
		return "", codeErr(CodePlatformError, "The update didn’t start: "+err.Error())
	}
	if p.systemd() {
		spec.Unit = appUnitPrefix + hx + ".service"
		if err := apps.WriteSpec(dir, spec); err != nil {
			return fail(err)
		}
		if err := p.systemdRun(appUnitArgv(spec.Unit, len(names), argv)); err != nil {
			return fail(err)
		}
	} else {
		if err := apps.WriteSpec(dir, spec); err != nil {
			return fail(err)
		}
		pid, err := p.spawn(argv)
		if err != nil {
			return fail(err)
		}
		spec.PID = pid
		if err := apps.WriteSpec(dir, spec); err != nil {
			return fail(err)
		}
	}
	p.current = spec
	p.watchLocked()
	onChange := p.onChange
	p.mu.Unlock()
	if onChange != nil {
		go onChange()
	}
	return id, nil
}

// appUnitArgv is systemd-run for an app task: a transient service, collected
// when it ends, stopped by systemd should it run past its limit. Stopping it
// waits for the runner (it ignores SIGTERM to finish putting an app back).
func appUnitArgv(unit string, n int, argv []string) []string {
	out := []string{systemdRunPath(), "--quiet", "--collect", "--service-type=exec", "--unit=" + unit,
		"--description=Whombat: app updates",
		"--property=KillMode=mixed",
		"--property=TimeoutStopSec=600s",
		fmt.Sprintf("--property=RuntimeMaxSec=%ds", int((apps.Limit(n) + pkgUnitSlack).Seconds())),
		"--working-directory=/", "--"}
	return append(out, systemdrun.Literal(argv...)...)
}

func (p *appTasks) status(id string, logStart int) (*proto.TaskStatus, error) {
	dir := p.taskDir(id)
	if dir == "" {
		return nil, codeErr(proto.CodeNotFound, "Not an app task.")
	}
	p.mu.Lock()
	p.loadLocked()
	t, ok := p.readLocked(dir)
	if ok && t.res != nil {
		if p.current != nil && p.current.ID == t.spec.ID {
			p.current = nil
		}
		if p.recordLocked(t) && p.onChange != nil {
			go p.onChange()
		}
	}
	p.mu.Unlock()
	if !ok || (t.res != nil && t.res.Finished.Before(p.now().Add(-appTaskKeep))) {
		return nil, codeErr(proto.CodeNotFound, "This app update is not known (it ended over a day ago).")
	}
	st := appTaskStatusOf(t)
	if logStart >= 0 {
		lines := readTaskLog(filepath.Join(dir, apps.LogFile), maskSecrets)
		logStart = min(logStart, len(lines))
		end := min(len(lines), logStart+pkgTaskLogMax)
		st.Log = lines[logStart:end]
		st.LogNext = end
	}
	return &st, nil
}

func appTaskStatusOf(t appTask) proto.TaskStatus {
	st := proto.TaskStatus{ID: t.spec.ID, Type: proto.OpAppUpdate, User: "root", Started: t.spec.Started, Status: "running"}
	if len(t.spec.Apps) == 1 {
		st.GuestID = t.spec.Apps[0]
	}
	if t.res == nil {
		return st
	}
	e := t.res.Finished
	st.Ended = &e
	st.Status = "ok"
	if t.res.Status != apps.StatusOK {
		st.Status = "error"
	}
	st.Message, st.Code = truncateText(t.res.Message, 500), t.res.Code
	st.Apps = make([]proto.AppResult, 0, len(t.res.Apps))
	for _, a := range t.res.Apps {
		st.Apps = append(st.Apps, proto.AppResult{App: a.App, Service: a.Service, Status: a.Status, Reason: a.Reason,
			From: a.From, To: a.To, Message: truncateText(a.Message, 300)})
	}
	return st
}

func (p *appTasks) list() []proto.TaskStatus {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.loadLocked()
	out := []proto.TaskStatus{}
	for _, t := range p.scanLocked() {
		out = append(out, appTaskStatusOf(t))
	}
	return out
}

// report is what the report says per container: being updated now, and its
// last outcome.
func (p *appTasks) report() (busy map[string]bool, last map[string]proto.AppLast) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.loadLocked()
	busy = map[string]bool{}
	if c := p.current; c != nil {
		for _, n := range c.Apps {
			busy[n] = true
		}
	}
	last = make(map[string]proto.AppLast, len(p.last))
	for n, l := range p.last {
		last[n] = proto.AppLast{Status: l.Status, Reason: l.Reason, From: l.From, To: l.To, Finished: l.Finished}
	}
	return busy, last
}

// ---- the host ---------------------------------------------------------------------

func spawnAppRunner(argv []string) (int, error) { return spawnRunner(argv) }

// appRunnerAlive: pid is still the runner of the task in dir.
func appRunnerAlive(pid int, dir string) bool {
	if runtime.GOOS != "linux" {
		return syscall.Kill(pid, 0) == nil
	}
	b, err := os.ReadFile(filepath.Join("/proc", strconv.Itoa(pid), "cmdline"))
	if err != nil {
		return false
	}
	args := strings.Split(string(b), "\x00")
	return slices.Contains(args, "app-task") && slices.Contains(args, dir)
}

// ---- manage operations ------------------------------------------------------------

var dockerAppNameRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$`)

// appsManage answers app.update and the task operations of app tasks; ok
// is false for every other request.
func (b *Broker) appsManage(ctx context.Context, req proto.ManageRequest) (proto.ManageResponse, bool) {
	isTask := strings.HasPrefix(req.Task, proto.AppTaskPrefix)
	switch {
	case req.Op == proto.OpAppUpdate:
	case (req.Op == proto.OpTaskStatus || req.Op == proto.OpTaskStop) && isTask:
	default:
		return proto.ManageResponse{}, false
	}
	p := b.appUpdates()
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
		if _, err := p.status(req.Task, -1); err != nil {
			return fail(err)
		}
		return fail(codeErr(proto.CodeNotAllowed, "An app update can’t be stopped once it started; each app goes back by itself when it fails."))
	}
	if runtime.GOOS != "linux" {
		return fail(codeErr(CodeUnsupported, "Whombat updates Docker Compose apps on Linux servers."))
	}
	names, err := b.appNames(req.Apps)
	if err != nil {
		return fail(err)
	}
	id, err := p.start(names, req.HoldMajor)
	if err != nil {
		return fail(err)
	}
	return proto.ManageResponse{OK: true, Task: &proto.TaskRef{ID: id}}, true
}

// appNames checks the containers to update against the latest report:
// running or stopped Docker containers Compose started, whose project files
// are there; duplicates go.
func (b *Broker) appNames(names []string) ([]string, error) {
	if len(names) == 0 {
		return nil, invalidField("apps", "Name the apps to update.")
	}
	if len(names) > proto.AppsMax {
		return nil, invalidField("apps", fmt.Sprintf("At most %d apps at once.", proto.AppsMax))
	}
	r := b.inventory()
	if r == nil || r.Docker == nil {
		return nil, codeErr(CodeInventory, "The agent hasn’t read Docker’s containers yet; try again in a moment.")
	}
	byName := map[string]*proto.Guest{}
	for i := range r.Docker.Guests {
		byName[r.Docker.Guests[i].ID] = &r.Docker.Guests[i]
	}
	var out []string
	for _, n := range names {
		if !dockerAppNameRe.MatchString(n) {
			return nil, invalidField("apps", fmt.Sprintf("%q is not a container name.", truncateText(n, 64)))
		}
		g := byName[n]
		switch {
		case g == nil:
			return nil, codeErr(proto.CodeNotFound, "No container "+strconv.Quote(n)+" on this server.")
		case g.WhombatService:
			return nil, codeErr(proto.CodeNotAllowed, "That’s one of Whombat’s own services; Whombat updates it with its releases.")
		case g.App == nil:
			return nil, codeErr(proto.CodeNotAllowed, n+" wasn’t started with Docker Compose, so Whombat can’t update it.")
		case g.App.Blocked == proto.AppReasonPinned:
			return nil, codeErr(proto.CodeNotAllowed, n+"’s image is pinned to one exact version in its Compose file.")
		case g.App.Blocked != "":
			return nil, codeErr(proto.CodeNotAllowed, n+"’s Compose files aren’t where it was started from any more.")
		}
		if !slices.Contains(out, n) {
			out = append(out, n)
		}
	}
	return out, nil
}

// appUpdates returns the registry (created on first use).
func (b *Broker) appUpdates() *appTasks {
	b.appOnce.Do(func() {
		if b.appMgr == nil {
			b.appMgr = newAppTasks(b.cfg.StateDir)
		}
		b.appMgr.mu.Lock()
		b.appMgr.onChange = func() {
			if f := b.OnAppChange; f != nil {
				f()
			}
		}
		b.appMgr.mu.Unlock()
	})
	return b.appMgr
}

// AppReport is what the report adds to Docker guests: which apps are being
// updated now, and each container's last outcome.
func (b *Broker) AppReport() (busy map[string]bool, last map[string]proto.AppLast) {
	return b.appUpdates().report()
}
