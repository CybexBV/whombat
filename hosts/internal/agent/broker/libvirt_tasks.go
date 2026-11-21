package broker

import (
	"fmt"
	"regexp"
	"sort"
	"sync"
	"time"

	"rackoon/internal/proto"
)

// Agent tasks of the libvirt manager (docs/MANAGE.md 2.7): clones,
// backups, restores, downloads and disk copies run in the agent as
// "libvirt:<16 hex>" with a log, a progress line and a stop. Kept 24 hours
// in memory (a restart of the agent forgets them; a running one then ends
// with the agent).

const (
	lvTaskKeep    = 24 * time.Hour
	lvTaskLogMax  = 2000 // lines kept per task
	lvTaskPageMax = 500  // lines per task.status
)

var lvTaskRE = regexp.MustCompile(`^libvirt:[0-9a-f]{16}$`)

type lvTask struct {
	id, typ, guest string
	started        time.Time
	ended          *time.Time
	status         string // running | ok | warning | error
	message        string // progress line, then the outcome
	log            []string
	stopReq        bool
	stop           func() // aborts the running step (a backup job); nil: stop between steps
}

type lvTasks struct {
	mu sync.Mutex
	m  map[string]*lvTask
}

func newLvTasks() *lvTasks { return &lvTasks{m: map[string]*lvTask{}} }

// start registers a task and runs work in the background. work reports
// through the handle; its error ends the task with status error.
func (ts *lvTasks) start(typ, guest string, work func(t *lvTaskHandle) error) string {
	id := "libvirt:" + lvRandHex(8)
	t := &lvTask{id: id, typ: typ, guest: guest, started: time.Now().UTC(), status: "running"}
	ts.mu.Lock()
	ts.prune()
	ts.m[id] = t
	ts.mu.Unlock()
	h := &lvTaskHandle{ts: ts, t: t}
	go func() {
		defer func() {
			if r := recover(); r != nil {
				h.finish(fmt.Errorf("internal error: %v", r))
			}
		}()
		h.finish(work(h))
	}()
	return id
}

func (ts *lvTasks) prune() {
	cut := time.Now().Add(-lvTaskKeep)
	for id, t := range ts.m {
		if t.ended != nil && t.ended.Before(cut) {
			delete(ts.m, id)
		}
	}
}

// lvTaskHandle is a running task's view of itself.
type lvTaskHandle struct {
	ts *lvTasks
	t  *lvTask
}

// logf appends a log line (and makes it the progress line).
func (h *lvTaskHandle) logf(format string, a ...any) {
	line := fmt.Sprintf(format, a...)
	h.ts.mu.Lock()
	defer h.ts.mu.Unlock()
	if len(h.t.log) < lvTaskLogMax {
		h.t.log = append(h.t.log, line)
	}
	h.t.message = line
}

// progress sets the progress line without logging it.
func (h *lvTaskHandle) progress(format string, a ...any) {
	h.ts.mu.Lock()
	defer h.ts.mu.Unlock()
	h.t.message = fmt.Sprintf(format, a...)
}

// stopped reports whether a stop was asked for.
func (h *lvTaskHandle) stopped() bool {
	h.ts.mu.Lock()
	defer h.ts.mu.Unlock()
	return h.t.stopReq
}

// onStop sets what aborts the current step (nil: nothing).
func (h *lvTaskHandle) onStop(f func()) {
	h.ts.mu.Lock()
	h.t.stop = f
	stop := h.t.stopReq
	h.ts.mu.Unlock()
	if stop && f != nil {
		f()
	}
}

func (h *lvTaskHandle) setGuest(id string) {
	h.ts.mu.Lock()
	h.t.guest = id
	h.ts.mu.Unlock()
}

// errLvStopped ends a task that was stopped.
var errLvStopped = fmt.Errorf("stopped")

func (h *lvTaskHandle) finish(err error) {
	h.ts.mu.Lock()
	defer h.ts.mu.Unlock()
	if h.t.ended != nil {
		return
	}
	now := time.Now().UTC()
	h.t.ended = &now
	h.t.stop = nil
	switch {
	case err == nil:
		h.t.status, h.t.message = "ok", "OK"
		h.t.log = append(h.t.log, "Done.")
	case h.t.stopReq:
		h.t.status, h.t.message = "error", "Stopped."
		h.t.log = append(h.t.log, "Stopped.")
	default:
		h.t.status, h.t.message = "error", err.Error()
		h.t.log = append(h.t.log, "Failed: "+err.Error())
	}
}

func (t *lvTask) statusFrom(start int) proto.TaskStatus {
	st := proto.TaskStatus{ID: t.id, Type: t.typ, GuestID: t.guest, User: "whombat", Started: t.started, Ended: t.ended,
		Status: t.status, Message: t.message, Cancellable: t.ended == nil}
	if start >= 0 {
		if start < len(t.log) {
			end := min(len(t.log), start+lvTaskPageMax)
			st.Log = append([]string(nil), t.log[start:end]...)
			st.LogNext = end
		} else {
			st.LogNext = len(t.log)
		}
	}
	return st
}

func (ts *lvTasks) status(req proto.ManageRequest) proto.ManageResponse {
	if !lvTaskRE.MatchString(req.Task) {
		return proto.ManageResponse{Code: proto.CodeInvalidValue, Message: "not a libvirt task id (libvirt:<16 hex>)",
			FieldErrors: map[string]string{"task": "not a libvirt task id"}}
	}
	ts.mu.Lock()
	defer ts.mu.Unlock()
	t, ok := ts.m[req.Task]
	if !ok {
		return proto.ManageResponse{Code: proto.CodeNotFound, Message: "this agent has no task " + req.Task}
	}
	st := t.statusFrom(req.LogStart)
	return proto.ManageResponse{OK: true, TaskStatus: &st}
}

// list: the tasks of the last 24 hours (of one VM), newest first.
func (ts *lvTasks) list(g *proto.Guest) proto.ManageResponse {
	ts.mu.Lock()
	defer ts.mu.Unlock()
	out := []proto.TaskStatus{}
	for _, t := range ts.m {
		if g != nil && t.guest != g.ID {
			continue
		}
		out = append(out, t.statusFrom(-1))
	}
	sort.Slice(out, func(i, j int) bool {
		if !out[i].Started.Equal(out[j].Started) {
			return out[i].Started.After(out[j].Started)
		}
		return out[i].ID < out[j].ID
	})
	return proto.ManageResponse{OK: true, Tasks: out}
}

// stop asks a running task to stop: a backup job is aborted at once, a
// disk copy libvirt is doing finishes first and is then removed.
func (ts *lvTasks) stop(req proto.ManageRequest) proto.ManageResponse {
	if !lvTaskRE.MatchString(req.Task) {
		return proto.ManageResponse{Code: proto.CodeInvalidValue, Message: "not a libvirt task id (libvirt:<16 hex>)",
			FieldErrors: map[string]string{"task": "not a libvirt task id"}}
	}
	ts.mu.Lock()
	t, ok := ts.m[req.Task]
	if !ok {
		ts.mu.Unlock()
		return proto.ManageResponse{Code: proto.CodeNotFound, Message: "this agent has no task " + req.Task}
	}
	if t.ended != nil {
		ts.mu.Unlock()
		return proto.ManageResponse{OK: true}
	}
	t.stopReq = true
	stop := t.stop
	if len(t.log) < lvTaskLogMax {
		t.log = append(t.log, "Stopping…")
	}
	ts.mu.Unlock()
	if stop != nil {
		stop()
	}
	return proto.ManageResponse{OK: true}
}
