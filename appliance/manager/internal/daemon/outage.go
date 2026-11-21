package daemon

import (
	"time"

	"github.com/CybexBV/whombat/appliance/manager/internal/update"
)

// Outages (MG-62): control and the runtime stop answering now and then for reasons that fix themselves (the dev
// control plane restarts and answers 502 for a minute; the runtime restarts after every activation). Their failed
// calls are logged by how long the dependency has been away, not at every failure: INFO from the first failure (and
// again when a call's error changes), one WARN once the outage has lasted outageWarnAfter (never while it is
// expected: the runtime during an activation), and an INFO when the dependency answers again, with how long it was
// away. The first failed call opens an outage; any successful call to the same dependency ends it.

// outageWarnAfter is how long a dependency may be away before its outage is a warning.
const outageWarnAfter = 10 * time.Minute

// The dependencies whose outages are tracked.
const (
	depControl = "control"
	depRuntime = "runtime"
)

// outage is one dependency's current outage.
type outage struct {
	since time.Time
	// logged is the error last logged per call (its log message), so a call that keeps failing the same way is
	// logged once per outage.
	logged map[string]string
	warned bool
}

func (d *Daemon) outageNow() time.Time {
	if d.now != nil {
		return d.now()
	}
	return time.Now()
}

// unreachable records a failed call to dep (msg: the call's log message). expected: the failure is expected now
// (the runtime restarting during an activation), so it is never a warning while so.
func (d *Daemon) unreachable(dep, msg string, err error, expected bool) {
	now := d.outageNow()
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.outages == nil {
		d.outages = map[string]*outage{}
	}
	o := d.outages[dep]
	if o == nil {
		o = &outage{since: now, logged: map[string]string{}}
		d.outages[dep] = o
	}
	away := now.Sub(o.since)
	text := err.Error()
	attrs := []any{"err", err}
	if away > 0 {
		attrs = append(attrs, "for", roundAway(away))
	}
	switch {
	case !o.warned && !expected && away >= outageWarnAfter:
		o.warned = true
		o.logged[msg] = text
		d.Log.Warn(msg, attrs...)
	case o.logged[msg] != text:
		o.logged[msg] = text
		d.Log.Info(msg, attrs...)
	}
}

// outageOpen reports whether dep is away (a failed call since its last successful one).
func (d *Daemon) outageOpen(dep string) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.outages[dep] != nil
}

// reachable records a successful call to dep: an open outage ends, with an INFO saying how long it lasted.
func (d *Daemon) reachable(dep string) {
	now := d.outageNow()
	d.mu.Lock()
	o := d.outages[dep]
	delete(d.outages, dep)
	d.mu.Unlock()
	if o == nil {
		return
	}
	msg := "control answers again"
	if dep == depRuntime {
		msg = "the runtime answers again"
	}
	d.Log.Info(msg, "after", roundAway(now.Sub(o.since)))
}

// runtimeRestarting reports whether the runtime is expected to be away now: an activation (or a rollback inside one)
// stops and restarts it, and a host activation reboots the box before Verifying.
func (d *Daemon) runtimeRestarting() bool {
	if d.Engine == nil {
		return false
	}
	st, err := d.Engine.Load()
	return err == nil && restartingPhase(st.Phase)
}

func restartingPhase(p update.Phase) bool { return p == update.Activating || p == update.Verifying }

// roundAway rounds an outage's length for the log: whole seconds, or milliseconds below one second.
func roundAway(d time.Duration) time.Duration {
	if d < time.Second {
		return d.Round(time.Millisecond)
	}
	return d.Round(time.Second)
}
