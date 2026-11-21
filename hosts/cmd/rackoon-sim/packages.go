package main

import (
	"fmt"
	"math/rand/v2"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"

	"rackoon/internal/hub/fakefleet"
	"rackoon/internal/proto"
)

// Simulated operating-system updates (docs/MANAGE.md 2.9): every apt host
// answers packages.check and packages.install with a task "pkg:<16 hex>"
// whose apt log grows with the clock. A check reads the counts again; an
// install brings them to zero (named packages: those only). shale's
// enterprise repository refuses (no subscription) and the result says so;
// granite needs a restart after an install (a new kernel). blackbox runs
// Unraid and refuses. Like the agent, one package task at a time per host,
// an install can't be stopped, tasks are kept a day.

// pkgTaskDur is how long a simulated task takes (tests shorten it).
var pkgTaskDur = map[string]time.Duration{proto.OpPackagesCheck: 6 * time.Second, proto.OpPackagesInstall: 20 * time.Second}

// simPkgTask is a simulated package task.
type simPkgTask struct {
	id, op, host string
	started      time.Time
	dur          time.Duration
	lines        []string
	ended        *time.Time
	status       string // running | ok | error
	message      string
	result       *proto.PackageResult
	done         func(end time.Time) // the state change at the end
}

type pkgSimState struct {
	mu    sync.Mutex
	tasks map[string]*simPkgTask
}

var pkgSim = &pkgSimState{tasks: map[string]*simPkgTask{}}

const (
	simEnterpriseWarning = "The Proxmox enterprise repository refused (it needs a subscription); the other repositories were used."
	simRebootHost        = "granite"
	simEnterpriseHost    = simNode // shale
)

// simPackagePool are the waiting updates the simulator lists, security
// fixes first (inspect updates shows the first Pending of them).
var simPackagePool = []proto.PackageUpdate{
	{Name: "openssl", Current: "3.5.1-1", New: "3.5.1-1+deb13u1", Security: true, Source: "Debian-Security:13/stable-security"},
	{Name: "libssl3t64", Current: "3.5.1-1", New: "3.5.1-1+deb13u1", Security: true, Source: "Debian-Security:13/stable-security"},
	{Name: "libexpat1", Current: "2.7.1-2", New: "2.7.1-2+deb13u1", Security: true, Source: "Debian-Security:13/stable-security"},
	{Name: "linux-image-amd64", Current: "6.12.48-1", New: "6.12.57-1", Source: "Debian:13.2/stable"},
	{Name: "docker-ce", Current: "5:28.4.0-1~debian.13~trixie", New: "5:28.5.1-1~debian.13~trixie", Source: "Docker CE:trixie"},
	{Name: "tzdata", Current: "2025b-4", New: "2025c-0+deb13u1", Source: "Debian:13.2/stable-updates"},
	{Name: "curl", Current: "8.14.1-2", New: "8.14.1-2+deb13u1", Source: "Debian:13.2/stable"},
	{Name: "libcurl4t64", Current: "8.14.1-2", New: "8.14.1-2+deb13u1", Source: "Debian:13.2/stable"},
	{Name: "systemd", Current: "257.8-1~deb13u2", New: "257.9-1~deb13u1", Source: "Debian:13.2/stable"},
	{Name: "libsystemd0", Current: "257.8-1~deb13u2", New: "257.9-1~deb13u1", Source: "Debian:13.2/stable"},
	{Name: "udev", Current: "257.8-1~deb13u2", New: "257.9-1~deb13u1", Source: "Debian:13.2/stable"},
	{Name: "nginx", Current: "1.26.3-3", New: "1.26.3-3+deb13u1", Source: "Debian:13.2/stable"},
	{Name: "zfsutils-linux", Current: "2.3.2-2", New: "2.3.4-1~bpo13+1", Source: "Debian Backports:trixie-backports"},
	{Name: "intel-microcode", Current: "3.20250512.1", New: "3.20250812.1~deb13u1", Source: "Debian:13.2/stable"},
	{Name: "bind9-libs", Current: "1:9.20.11-4", New: "1:9.20.15-1~deb13u1", Source: "Debian:13.2/stable"},
	{Name: "bind9-host", Current: "1:9.20.11-4", New: "1:9.20.15-1~deb13u1", Source: "Debian:13.2/stable"},
	{Name: "libxml2", Current: "2.12.7+dfsg+really2.9.14-2.1", New: "2.12.7+dfsg+really2.9.14-2.1+deb13u1", Source: "Debian:13.2/stable"},
	{Name: "python3.13", Current: "3.13.5-2", New: "3.13.5-2+deb13u1", Source: "Debian:13.2/stable"},
	{Name: "libpython3.13", Current: "3.13.5-2", New: "3.13.5-2+deb13u1", Source: "Debian:13.2/stable"},
	{Name: "git", Current: "1:2.47.3-0+deb13u1", New: "1:2.47.3-0+deb13u2", Source: "Debian:13.2/stable"},
	{Name: "vim-tiny", Current: "2:9.1.1230-2", New: "2:9.1.1230-2+deb13u1", Source: "Debian:13.2/stable"},
	{Name: "rsync", Current: "3.4.1+ds1-5", New: "3.4.1+ds1-5+deb13u1", Source: "Debian:13.2/stable"},
	{Name: "less", Current: "668-1", New: "668-1+deb13u1", Source: "Debian:13.2/stable"},
}

// simWaiting is the host's waiting updates (inspect updates).
func simWaiting(ps fakefleet.PackageState) []proto.PackageUpdate {
	n := min(ps.Pending, len(simPackagePool))
	out := make([]proto.PackageUpdate, 0, n)
	sec := ps.Security
	for _, u := range simPackagePool {
		if len(out) == n {
			break
		}
		if u.Security && sec == 0 {
			continue
		}
		if u.Security {
			sec--
		}
		out = append(out, u)
	}
	return out
}

// managePackages answers the package operations and their tasks; ok is
// false for every other request.
func (a *simAgent) managePackages(req proto.ManageRequest) (proto.ManageResponse, bool) {
	isTask := strings.HasPrefix(req.Task, proto.PackageTaskPrefix)
	switch {
	case req.Op == proto.OpPackagesCheck || req.Op == proto.OpPackagesInstall:
	case (req.Op == proto.OpTaskStatus || req.Op == proto.OpTaskStop) && isTask:
	case req.Op == proto.OpTaskList && req.Platform == proto.PlatformHost:
	default:
		return proto.ManageResponse{}, false
	}
	s := pkgSim
	s.mu.Lock()
	defer s.mu.Unlock()
	s.tick()
	h := a.host
	switch req.Op {
	case proto.OpTaskStatus:
		t := s.tasks[req.Task]
		if t == nil || t.host != h.ID {
			return fail(proto.CodeNotFound, "This update task is not known (it ended over a day ago)."), true
		}
		st := t.taskStatus(req.LogStart)
		return proto.ManageResponse{OK: true, TaskStatus: &st}, true
	case proto.OpTaskStop:
		t := s.tasks[req.Task]
		switch {
		case t == nil || t.host != h.ID:
			return fail(proto.CodeNotFound, "This update task is not known."), true
		case t.status != "running":
		case t.op == proto.OpPackagesInstall:
			return fail(proto.CodeNotAllowed, "Installing updates can’t be stopped once it started."), true
		default:
			now := time.Now().UTC()
			t.ended, t.status, t.message = &now, "error", "Checking for updates was stopped."
			t.result = &proto.PackageResult{KeptBack: []string{}}
			t.lines = append(t.lines[:min(len(t.lines), t.shown(now))], t.message)
			t.done = nil
			h.UpdatePackages(func(ps *fakefleet.PackageState) {
				ps.Task = nil
				ps.Last = &proto.PackageLast{Op: proto.PackageOpCheck, Status: "failed", Finished: now, Message: t.message}
			})
			a.reportSoon()
		}
		return proto.ManageResponse{OK: true}, true
	case proto.OpTaskList:
		out := []proto.TaskStatus{}
		for _, t := range s.tasks {
			if t.host == h.ID {
				out = append(out, t.taskStatus(-1))
			}
		}
		sort.Slice(out, func(i, j int) bool { return out[i].Started.After(out[j].Started) })
		return proto.ManageResponse{OK: true, Tasks: out}, true
	}
	if req.Platform != "" && req.Platform != proto.PlatformHost {
		return fail("invalid_request", "Package updates are the host’s: platform host."), true
	}
	if h.Unraid != nil {
		return fail("unsupported", "Unraid updates itself on its Update OS page, and its plugins and containers have their own updates."), true
	}
	if req.Op == proto.OpPackagesCheck && len(req.Packages) > 0 {
		return proto.ManageResponse{Code: proto.CodeInvalidValue, Message: "A check takes no package names.",
			FieldErrors: map[string]string{"packages": "A check takes no package names."}}, true
	}
	for _, t := range s.tasks {
		if t.host == h.ID && t.status == "running" {
			return fail("busy", "Updates are being checked or installed on this server right now. Wait until that has finished."), true
		}
	}
	ps := h.Packages()
	waiting := simWaiting(ps)
	var names []string
	for _, u := range waiting {
		if len(req.Packages) == 0 || slices.Contains(req.Packages, u.Name) {
			names = append(names, u.Name)
		}
	}
	op := proto.PackageOpCheck
	if req.Op == proto.OpPackagesInstall {
		op = proto.PackageOpInstall
	}
	lines := []string{"$ apt-get -q -o DPkg::Lock::Timeout=120 update",
		"Hit:1 http://deb.debian.org/debian trixie InRelease",
		"Get:2 http://deb.debian.org/debian trixie-updates InRelease [47.3 kB]",
		"Get:3 http://security.debian.org/debian-security trixie-security InRelease [43.4 kB]"}
	warning := ""
	if h.ID == simEnterpriseHost {
		warning = simEnterpriseWarning
		lines = append(lines, "Err:4 https://enterprise.proxmox.com/debian/pve trixie InRelease", "  401  Unauthorized [IP: 212.224.123.70 443]")
	}
	lines = append(lines, "Fetched 90.7 kB in 1s (88.2 kB/s)", "Reading package lists...")
	if warning != "" {
		lines = append(lines, "E: Failed to fetch https://enterprise.proxmox.com/debian/pve/dists/trixie/InRelease  401  Unauthorized [IP: 212.224.123.70 443]",
			"E: The repository 'https://enterprise.proxmox.com/debian/pve trixie InRelease' is not signed.")
	}
	var msg string
	var done func(end time.Time)
	result := &proto.PackageResult{KeptBack: []string{}, Warning: warning}
	if op == proto.PackageOpCheck {
		msg = simWaitingWords(ps.Pending, ps.Security)
		done = func(end time.Time) {
			h.UpdatePackages(func(ps *fakefleet.PackageState) {
				ps.CheckedAt, ps.Task = end, nil
				ps.Last = &proto.PackageLast{Op: op, Status: "ok", Finished: end, Message: msg}
			})
		}
	} else {
		verb := "dist-upgrade"
		if len(req.Packages) > 0 {
			verb = "install --only-upgrade " + strings.Join(req.Packages, " ")
		}
		lines = append(lines, "$ apt-get -q -y -o DPkg::Lock::Timeout=120 -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold "+verb,
			"Reading package lists...", "Building dependency tree...", "Reading state information...", "Calculating upgrade...")
		if len(names) > 0 {
			lines = append(lines, "The following packages will be upgraded:", "  "+strings.Join(names, " "))
		}
		lines = append(lines, fmt.Sprintf("%d upgraded, 0 newly installed, 0 to remove and 0 not upgraded.", len(names)))
		for _, n := range names {
			lines = append(lines, "Preparing to unpack …/"+n+".deb ...", "Unpacking "+n+" ...")
		}
		for _, n := range names {
			lines = append(lines, "Setting up "+n+" ...")
		}
		installed := len(names)
		result.Installed = installed
		switch installed {
		case 0:
			msg = "Nothing to install."
		case 1:
			msg = "Installed 1 update."
		default:
			msg = fmt.Sprintf("Installed %d updates.", installed)
		}
		done = func(end time.Time) {
			h.UpdatePackages(func(ps *fakefleet.PackageState) {
				sec := 0
				for _, u := range waiting {
					if u.Security && slices.Contains(names, u.Name) {
						sec++
					}
				}
				ps.Pending, ps.Security = max(0, ps.Pending-installed), max(0, ps.Security-sec)
				ps.CheckedAt, ps.Task = end, nil
				n := installed
				ps.Last = &proto.PackageLast{Op: op, Status: "ok", Finished: end, Installed: &n, Message: msg}
				if h.ID == simRebootHost && installed > 0 {
					ps.Reboot, ps.RebootReason = true, "Kernel 6.12.57+deb13-amd64 is installed, 6.12.48+deb13-amd64 runs"
				}
			})
		}
	}
	id := fmt.Sprintf("%s%016x", proto.PackageTaskPrefix, rand.Uint64())
	now := time.Now().UTC()
	dur := pkgTaskDur[req.Op]
	s.tasks[id] = &simPkgTask{id: id, op: req.Op, host: h.ID, started: now, dur: dur, lines: lines, status: "running",
		message: msg, result: result, done: done}
	h.UpdatePackages(func(ps *fakefleet.PackageState) { ps.Task = &proto.PackageTask{ID: id, Op: op, Started: now} })
	a.reportSoon()
	return proto.ManageResponse{OK: true, Task: &proto.TaskRef{ID: id}}, true
}

func simWaitingWords(n, sec int) string {
	switch {
	case n == 0:
		return "No updates waiting."
	case sec > 0:
		return fmt.Sprintf("%d updates waiting, %d for security.", n, sec)
	case n == 1:
		return "1 update waiting."
	}
	return fmt.Sprintf("%d updates waiting.", n)
}

// tick ends the tasks whose time is up and drops those that ended a day
// ago (caller holds s.mu).
func (s *pkgSimState) tick() {
	now := time.Now().UTC()
	for id, t := range s.tasks {
		if t.status == "running" && !now.Before(t.started.Add(t.dur)) {
			end := t.started.Add(t.dur)
			t.ended, t.status = &end, "ok"
			if t.done != nil {
				t.done(end)
			}
		}
		if t.ended != nil && now.Sub(*t.ended) > 24*time.Hour {
			delete(s.tasks, id)
		}
	}
}

// shown is how many log lines the task has printed by t.
func (t *simPkgTask) shown(at time.Time) int {
	if t.status != "running" || t.dur <= 0 {
		return len(t.lines)
	}
	return min(len(t.lines), max(1, int(float64(len(t.lines))*float64(at.Sub(t.started))/float64(t.dur))))
}

// taskStatus is the task at the clock, with the log from start (-1: none).
func (t *simPkgTask) taskStatus(start int) proto.TaskStatus {
	st := proto.TaskStatus{ID: t.id, Type: t.op, User: "root", Started: t.started, Status: t.status}
	lines := t.lines[:t.shown(time.Now())]
	if t.ended != nil {
		e := *t.ended
		st.Ended, st.Message = &e, t.message
		r := *t.result
		st.Packages = &r
	} else {
		st.Cancellable = t.op == proto.OpPackagesCheck
	}
	if start >= 0 {
		if start < len(lines) {
			st.Log = append([]string(nil), lines[start:]...)
		}
		st.LogNext = len(lines)
	}
	return st
}

// packagesTick ends package tasks with the clock even when nobody asks
// (the report shows the change).
func (a *simAgent) packagesTick() {
	pkgSim.mu.Lock()
	defer pkgSim.mu.Unlock()
	pkgSim.tick()
}
