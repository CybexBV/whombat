package main

import (
	"fmt"
	"math/rand/v2"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"rackoon/internal/hub/fakefleet"
	"rackoon/internal/proto"
)

// Simulated unRAID management (docs/MANAGE.md 2.6): blackbox answers the
// unRAID operations from its in-memory state, each command a task
// "unraid:<16 hex>" whose log grows with the clock and whose end changes
// the state (the array starts, a parity check runs for about two hours,
// plugins and containers are up to date); archiving notifications and
// autostart are done at once. Like the agent, the tasks are kept a day.

// unraidTaskDur is how long a simulated command takes (tests shorten it).
var unraidTaskDur = map[string]time.Duration{
	proto.OpArrayStart: 6 * time.Second, proto.OpArrayStop: 8 * time.Second, proto.OpParityPause: 2 * time.Second,
	proto.OpParityResume: 2 * time.Second, proto.OpParityCancel: 2 * time.Second, proto.OpDiskSpinUp: 3 * time.Second,
	proto.OpDiskSpinDown: 3 * time.Second, proto.OpMoverStart: 20 * time.Second, proto.OpPluginCheck: 8 * time.Second,
	proto.OpPluginUpdate: 15 * time.Second, proto.OpContainersCheck: 10 * time.Second, proto.OpContainerUpdate: 25 * time.Second,
}

// simUnraidTask is a simulated unRAID task.
type simUnraidTask struct {
	id, op, guest string
	started       time.Time
	dur           time.Duration // 0 for a parity check: it ends when the check does
	lines         []string
	ended         *time.Time
	status        string // running | ok | error
	message       string
	done          func() // at the end: the state change
}

type unraidSimState struct {
	mu    sync.Mutex
	tasks map[string]*simUnraidTask
}

var unraidSim = &unraidSimState{tasks: map[string]*simUnraidTask{}}

var simDiskRe = regexp.MustCompile(`^(all|[a-z][a-z0-9_-]{0,31})$`)

// manageUnraid answers blackbox's unRAID requests; ok is false for others.
func (a *simAgent) manageUnraid(req proto.ManageRequest) (proto.ManageResponse, bool) {
	h := a.host
	if h.Unraid == nil {
		return proto.ManageResponse{}, false
	}
	isTask := strings.HasPrefix(req.Task, proto.UnraidTaskPrefix)
	switch {
	case req.Platform == proto.PlatformUnraid, isTask, req.Op == proto.OpContainerUpdate, req.Op == proto.OpGuestAutostart:
	case req.Op == proto.OpTaskList && req.Platform == proto.PlatformDocker:
	default:
		return proto.ManageResponse{}, false
	}
	s := unraidSim
	s.mu.Lock()
	defer s.mu.Unlock()
	s.tick()
	u := h.UnraidState()
	a.unraidParityTick(u)
	u = h.UnraidState()
	switch req.Op {
	case proto.OpTaskStatus:
		t := s.tasks[req.Task]
		if t == nil {
			return fail(proto.CodeNotFound, "This task is not known (it ended over a day ago, or the agent restarted)."), true
		}
		st := t.taskStatus(req.LogStart)
		return proto.ManageResponse{OK: true, TaskStatus: &st}, true
	case proto.OpTaskList:
		guest := ""
		if req.Platform == proto.PlatformDocker {
			guest = req.GuestID
		}
		out := []proto.TaskStatus{}
		for _, t := range s.tasks {
			if guest == "" || t.guest == guest {
				out = append(out, t.taskStatus(-1))
			}
		}
		sort.Slice(out, func(i, j int) bool { return out[i].Started.After(out[j].Started) })
		return proto.ManageResponse{OK: true, Tasks: out}, true
	case proto.OpTaskStop:
		return fail("unsupported", "Unraid’s commands can’t be stopped halfway; cancel a parity check with parity.cancel."), true
	}
	busy := func(msg string) (proto.ManageResponse, bool) { return fail("busy", msg), true }
	started := u.Array.State == proto.UnraidArrayStarted
	start := func(guest string, lines []string, msg string, done func()) (proto.ManageResponse, bool) {
		t := s.start(req.Op, guest, lines, msg, done)
		select { // report the change soon
		case a.early <- struct{}{}:
		default:
		}
		return proto.ManageResponse{OK: true, Task: &proto.TaskRef{ID: t.id}}, true
	}
	switch req.Op {
	case proto.OpArrayStart:
		if started {
			return busy("The array is already started.")
		}
		return start("", []string{"$ /usr/local/sbin/emcmd cmdStart=Start", "Waiting for the array to start…"}, "The array is started.", func() {
			h.UpdateUnraid(func(u *proto.Unraid) { u.Array.State, u.Array.StateRaw = proto.UnraidArrayStarted, "STARTED" })
		})
	case proto.OpArrayStop:
		if !started {
			return busy("The array is not started.")
		}
		return start("", []string{"$ /usr/local/sbin/emcmd cmdStop=Stop", "Waiting for the array to stop…"}, "The array is stopped.", func() {
			h.UpdateUnraid(func(u *proto.Unraid) {
				u.Array.State, u.Array.StateRaw = proto.UnraidArrayStopped, "STOPPED"
				u.Array.Parity.State, u.Array.Parity.Action, u.Array.Parity.Pct = "idle", "", nil
			})
			h.StartParity(nil, 0)
		})
	case proto.OpParityStart:
		switch {
		case !started:
			return busy("Start the array first.")
		case u.Array.Parity.State != "idle":
			return busy("A parity operation is already running.")
		case req.Correct && u.Array.Parity.Disks == 0:
			return proto.ManageResponse{Code: proto.CodeInvalidValue, Message: "There’s no parity disk to correct.",
				FieldErrors: map[string]string{"correct": "There’s no parity disk to correct."}}, true
		}
		arg := "cmdCheck=Check"
		action := "check"
		if req.Correct {
			arg, action = arg+"&optionCorrect=correct", "correct"
		}
		now := time.Now()
		h.UpdateUnraid(func(u *proto.Unraid) { u.Array.Parity.State, u.Array.Parity.Action = "running", action })
		h.StartParity(&now, 0)
		t := s.start(req.Op, "", []string{"$ /usr/local/sbin/emcmd " + arg, "The parity check is running."}, "", nil)
		t.dur = 0 // ends with the check (unraidParityTick)
		return proto.ManageResponse{OK: true, Task: &proto.TaskRef{ID: t.id}}, true
	case proto.OpParityPause, proto.OpParityResume, proto.OpParityCancel:
		st := u.Array.Parity.State
		switch {
		case req.Op == proto.OpParityPause && st != "running":
			return busy("No parity operation is running.")
		case req.Op == proto.OpParityResume && st != "paused":
			return busy("No parity operation is paused.")
		case req.Op == proto.OpParityCancel && st == "idle":
			return busy("No parity operation is running.")
		}
		pct := h.ParityPct()
		arg, msg := "cmdCheckPause=", "The parity check is paused."
		if req.Op == proto.OpParityResume {
			arg, msg = "cmdCheckResume=", "The parity check goes on."
		} else if req.Op == proto.OpParityCancel {
			arg, msg = "cmdCheckCancel=", "The parity check is cancelled."
		}
		return start("", []string{"$ /usr/local/sbin/emcmd " + arg}, msg, func() {
			switch req.Op {
			case proto.OpParityPause:
				h.StartParity(nil, pct)
				h.UpdateUnraid(func(u *proto.Unraid) {
					u.Array.Parity.State, u.Array.Parity.Pct, u.Array.Parity.SpeedMBs = "paused", &pct, nil
				})
			case proto.OpParityResume:
				now := time.Now()
				h.StartParity(&now, pct)
				h.UpdateUnraid(func(u *proto.Unraid) { u.Array.Parity.State = "running" })
			default:
				h.StartParity(nil, 0)
				h.UpdateUnraid(func(u *proto.Unraid) { endParity(u, "cancelled") })
			}
		})
	case proto.OpDiskSpinUp, proto.OpDiskSpinDown:
		verb := "up"
		if req.Op == proto.OpDiskSpinDown {
			verb = "down"
		}
		if !simDiskRe.MatchString(req.Disk) || req.Disk != "all" && !simHasDisk(u, req.Disk) {
			return fail(proto.CodeNotFound, fmt.Sprintf("No disk %q in the array or a pool.", req.Disk)), true
		}
		arg, msg := "cmdSpin"+verb+"All=Apply", "Spinning "+verb+" every disk."
		if req.Disk != "all" {
			arg, msg = "cmdSpin"+verb+"="+req.Disk, "Spinning "+verb+" "+req.Disk+"."
		}
		return start("", []string{"$ /usr/local/sbin/emcmd " + arg}, msg, func() {
			h.UpdateUnraid(func(u *proto.Unraid) {
				spin := func(d *proto.UnraidDisk) {
					if (req.Disk == "all" || d.Name == req.Disk) && d.Rotational != nil && *d.Rotational {
						d.SpunDown = verb == "down"
					}
				}
				for i := range u.Array.Disks {
					spin(&u.Array.Disks[i])
				}
				for i := range u.Pools {
					for j := range u.Pools[i].Disks {
						spin(&u.Pools[i].Disks[j])
					}
				}
			})
		})
	case proto.OpMoverStart:
		switch {
		case !started:
			return busy("Start the array first.")
		case u.Array.MoverRunning:
			return busy("The mover is already running.")
		}
		h.UpdateUnraid(func(u *proto.Unraid) { u.Array.MoverRunning = true })
		return start("", []string{"$ /usr/local/sbin/mover start", "mover: started", "mover: finished"}, "The mover is done.", func() {
			h.UpdateUnraid(func(u *proto.Unraid) { u.Array.MoverRunning = false })
		})
	case proto.OpPluginCheck:
		return start("", []string{"$ /usr/local/sbin/plugin checkall", "plugin: checking tailscale.plg …", "plugin: checking unassigned.devices.plg …"},
			"Checked every plugin for updates.", nil)
	case proto.OpPluginUpdate:
		var files []string
		for _, p := range u.Plugins {
			if p.Update != "" && (req.Plugin == "all" || req.Plugin == p.File) {
				files = append(files, p.File)
			}
		}
		switch {
		case req.Plugin == "unRAIDServer.plg":
			return fail(proto.CodeNotAllowed, "Unraid itself is updated in its own page (it needs a reboot)."), true
		case len(files) == 0 && req.Plugin == "all":
			return fail(proto.CodeNotFound, "No plugin has an update."), true
		case len(files) == 0:
			return fail(proto.CodeNotFound, "Unraid hasn’t found a newer "+req.Plugin+": check for updates first."), true
		}
		var lines []string
		for _, f := range files {
			lines = append(lines, "$ /usr/local/sbin/plugin update "+f, "plugin: running: "+f, "plugin: "+f+" updated")
		}
		msg := fmt.Sprintf("%d plugins updated.", len(files))
		if len(files) == 1 {
			msg = strings.TrimSuffix(files[0], ".plg") + " is up to date."
		}
		return start("", lines, msg, func() {
			h.UpdateUnraid(func(u *proto.Unraid) {
				for i := range u.Plugins {
					for _, f := range files {
						if u.Plugins[i].File == f {
							u.Plugins[i].Version, u.Plugins[i].Update = u.Plugins[i].Update, ""
						}
					}
				}
			})
		})
	case proto.OpNotificationArchive:
		found := false
		h.UpdateUnraid(func(u *proto.Unraid) {
			keep := u.Notifications[:0]
			for _, n := range u.Notifications {
				if req.Notification == "" || n.ID == req.Notification {
					found = true
					continue
				}
				keep = append(keep, n)
			}
			u.Notifications, u.NotificationsUnread = keep, len(keep)
		})
		if req.Notification != "" && !found {
			return fail(proto.CodeNotFound, fmt.Sprintf("No unread notification %q.", req.Notification)), true
		}
		return proto.ManageResponse{OK: true}, true
	case proto.OpContainersCheck:
		return start("", []string{"$ /usr/local/emhttp/plugins/dynamix.docker.manager/scripts/dockerupdate check nonotify", " Done."},
			"Checked the containers for updates.", nil)
	case proto.OpContainerUpdate, proto.OpGuestAutostart:
		return a.unraidGuestOp(req, start)
	}
	return fail("unsupported", "unknown Unraid operation"), true
}

func (a *simAgent) unraidGuestOp(req proto.ManageRequest, start func(string, []string, string, func()) (proto.ManageResponse, bool)) (proto.ManageResponse, bool) {
	h := a.host
	if req.Platform != proto.PlatformDocker && req.Platform != proto.PlatformLibvirt {
		return fail("unsupported", "This works for Docker containers on Unraid and libvirt VMs only."), true
	}
	g, ok := h.FindGuest(req.Platform, req.GuestID)
	if !ok {
		return fail("unknown_guest", "guest not found on this host"), true
	}
	if req.Op == proto.OpGuestAutostart {
		if req.On == nil {
			return proto.ManageResponse{Code: proto.CodeInvalidValue, Message: "Say on (true) or off (false).",
				FieldErrors: map[string]string{"on": "Say on (true) or off (false)."}}, true
		}
		on := *req.On
		old := "false"
		if g.Autostart != nil && *g.Autostart {
			old = "true"
		}
		h.UpdateGuest(req.Platform, req.GuestID, func(s *fakefleet.GuestSpec) { s.Autostart = &on })
		select {
		case a.early <- struct{}{}:
		default:
		}
		return proto.ManageResponse{OK: true, Changes: []proto.ConfigChange{{Key: "autostart", Old: old, New: fmt.Sprint(on)}}}, true
	}
	if req.Platform != proto.PlatformDocker {
		return fail("unsupported", "Only containers are updated from a template."), true
	}
	if !g.UnraidTemplate {
		return fail(proto.CodeNotAllowed, "This container wasn’t set up from an Unraid template: update it where it was created."), true
	}
	name := g.ID
	return start(name, []string{"Updating " + name + " from its template: pulling the image and creating the container again.",
		"$ /usr/local/emhttp/plugins/dynamix.docker.manager/scripts/update_container " + name, "Pulling image: " + g.Image,
		"Stopping container: " + name, "Removing container: " + name, "Command execution", "The command finished successfully!"},
		name+" is up to date.", func() {
			no := false
			h.UpdateGuest(proto.PlatformDocker, name, func(s *fakefleet.GuestSpec) { s.Update = &no })
		})
}

func simHasDisk(u *proto.Unraid, name string) bool {
	for _, d := range u.Array.Disks {
		if d.Name == name {
			return true
		}
	}
	for _, p := range u.Pools {
		for _, d := range p.Disks {
			if d.Name == name {
				return true
			}
		}
	}
	return false
}

// endParity ends the simulated parity operation with a result.
func endParity(u *proto.Unraid, result string) {
	p := &u.Array.Parity
	run := proto.UnraidParityRun{At: time.Now().UTC(), Errors: p.Errors, Result: result, Action: "check"}
	if u.Array.Parity.Disks == 0 {
		run.Action = "read_check"
	}
	p.State, p.Action, p.Pct, p.SpeedMBs, p.ETAS, p.Errors = "idle", "", nil, nil, nil, 0
	p.Last = &run
	p.History = append([]proto.UnraidParityRun{run}, p.History...)
	if len(p.History) > 10 {
		p.History = p.History[:10]
	}
}

// unraidParityTick ends a running check whose time is up and finishes
// its task (caller holds unraidSim.mu).
func (a *simAgent) unraidParityTick(u *proto.Unraid) {
	if u == nil || u.Array.Parity.State != "running" || a.host.ParityPct() < 100 {
		return
	}
	h := a.host
	h.StartParity(nil, 0)
	h.UpdateUnraid(func(u *proto.Unraid) { endParity(u, "ok") })
	now := time.Now().UTC()
	for _, t := range unraidSim.tasks {
		if t.op == proto.OpParityStart && t.status == "running" {
			t.ended, t.status, t.message = &now, "ok", "No errors."
			t.lines = append(t.lines, "100.0 % done, 0 errors so far.")
		}
	}
}

func (s *unraidSimState) start(op, guest string, lines []string, msg string, done func()) *simUnraidTask {
	id := fmt.Sprintf("%s%016x", proto.UnraidTaskPrefix, rand.Uint64())
	dur := unraidTaskDur[op]
	if dur == 0 {
		dur = 5 * time.Second
	}
	t := &simUnraidTask{id: id, op: op, guest: guest, started: time.Now().UTC(), dur: dur, lines: lines, status: "running", message: msg, done: done}
	s.tasks[id] = t
	return t
}

// tick ends the tasks whose time is up and drops those that ended a day
// ago (caller holds s.mu).
func (s *unraidSimState) tick() {
	now := time.Now().UTC()
	for id, t := range s.tasks {
		if t.status == "running" && t.dur > 0 && !now.Before(t.started.Add(t.dur)) {
			end := t.started.Add(t.dur)
			t.ended, t.status = &end, "ok"
			if t.done != nil {
				t.done()
			}
		}
		if t.ended != nil && now.Sub(*t.ended) > 24*time.Hour {
			delete(s.tasks, id)
		}
	}
}

// status is the task at the clock, with the log from start (-1: none).
func (t *simUnraidTask) taskStatus(start int) proto.TaskStatus {
	st := proto.TaskStatus{ID: t.id, Type: t.op, GuestID: t.guest, User: "root", Started: t.started, Status: t.status}
	lines := t.lines
	if t.status == "running" && t.dur > 0 {
		shown := max(1, int(float64(len(lines))*float64(time.Since(t.started))/float64(t.dur)))
		lines = lines[:min(shown, len(lines))]
	}
	if t.ended != nil {
		e := *t.ended
		st.Ended, st.Message = &e, t.message
	}
	if start >= 0 {
		if start < len(lines) {
			st.Log = append([]string(nil), lines[start:]...)
		}
		st.LogNext = len(lines)
	}
	return st
}

// unraidTicker finishes blackbox's tasks with the clock even when nobody
// asks (the report shows the change).
func (a *simAgent) unraidTick() {
	if a.host.Unraid == nil {
		return
	}
	unraidSim.mu.Lock()
	defer unraidSim.mu.Unlock()
	unraidSim.tick()
	a.unraidParityTick(a.host.UnraidState())
}
