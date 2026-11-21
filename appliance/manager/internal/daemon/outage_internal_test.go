package daemon

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/manager/internal/update"
)

// recorded keeps every log record as "LEVEL msg key=value …".
type recorded struct {
	mu    sync.Mutex
	lines []string
}

func (r *recorded) Enabled(context.Context, slog.Level) bool { return true }
func (r *recorded) Handle(_ context.Context, rec slog.Record) error {
	s := rec.Level.String() + " " + rec.Message
	rec.Attrs(func(a slog.Attr) bool { s += fmt.Sprintf(" %s=%v", a.Key, a.Value); return true })
	r.mu.Lock()
	r.lines = append(r.lines, s)
	r.mu.Unlock()
	return nil
}
func (r *recorded) WithAttrs([]slog.Attr) slog.Handler { return r }
func (r *recorded) WithGroup(string) slog.Handler      { return r }

// take returns the records since the last take.
func (r *recorded) take() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	l := r.lines
	r.lines = nil
	return l
}

func outageDaemon() (*Daemon, *recorded, func(time.Duration)) {
	rec := &recorded{}
	now := time.Date(2026, 10, 10, 9, 0, 0, 0, time.UTC)
	d := &Daemon{Log: slog.New(rec), lastErr: map[string]string{}}
	d.now = func() time.Time { return now }
	return d, rec, func(by time.Duration) { now = now.Add(by) }
}

func expectLines(t *testing.T, what string, got []string, want ...string) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("%s: logged %q, want %d lines %q", what, got, len(want), want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("%s: line %d is %q, want %q (all: %q)", what, i, got[i], want[i], got)
		}
	}
}

// MG-62: an outage is INFO for its first 10 minutes, one WARN once it lasts longer, and an INFO with its length when
// the dependency answers again; the next outage starts over.
func TestOutageLogLevels(t *testing.T) {
	d, rec, advance := outageDaemon()
	const poll = "control poll failed; the installed release keeps running"
	e502 := errors.New("control unavailable: control HTTP 502: error code: 502")

	d.reachable(depControl) // nothing was away
	expectLines(t, "a success without an outage", rec.take())

	d.unreachable(depControl, poll, e502, false)
	expectLines(t, "the first failure", rec.take(), "INFO "+poll+" err="+e502.Error())
	for range 5 { // the same failure again and again: nothing more
		advance(90 * time.Second)
		d.unreachable(depControl, poll, e502, false)
	}
	expectLines(t, "the same failure for 7.5 minutes", rec.take())
	refused := errors.New("control unavailable: dial tcp 10.0.0.1:443: connect: connection refused")
	advance(time.Minute)
	d.unreachable(depControl, poll, refused, false)
	d.unreachable(depControl, "status.report failed", e502, false)
	expectLines(t, "another error, another call", rec.take(),
		"INFO "+poll+" err="+refused.Error()+" for=8m30s",
		"INFO status.report failed err="+e502.Error()+" for=8m30s")
	advance(90 * time.Second) // 10 minutes away
	d.unreachable(depControl, poll, refused, false)
	expectLines(t, "10 minutes away", rec.take(), "WARN "+poll+" err="+refused.Error()+" for=10m0s")
	advance(5 * time.Minute)
	d.unreachable(depControl, poll, refused, false)
	d.unreachable(depControl, "status.report failed", e502, false)
	d.unreachable(depControl, poll, e502, false)
	expectLines(t, "after the warning", rec.take(), "INFO "+poll+" err="+e502.Error()+" for=15m0s")
	advance(12 * time.Second)
	d.reachable(depControl)
	d.reachable(depControl)
	expectLines(t, "control back", rec.take(), "INFO control answers again after=15m12s")

	// The next outage starts over: INFO again, and no warning before its own 10 minutes.
	advance(time.Hour)
	d.unreachable(depControl, poll, e502, false)
	advance(9 * time.Minute)
	d.unreachable(depControl, poll, e502, false)
	advance(40 * time.Second)
	d.reachable(depControl)
	expectLines(t, "a second, short outage", rec.take(),
		"INFO "+poll+" err="+e502.Error(), "INFO control answers again after=9m40s")

	// The runtime's outage is its own.
	d.unreachable(depRuntime, "runtime facts unavailable for status.report", errors.New("dial unix /run/whombat/admin.sock: connect: no such file or directory"), false)
	d.reachable(depControl)
	if !d.outageOpen(depRuntime) || d.outageOpen(depControl) {
		t.Fatal("control's success ended the runtime's outage")
	}
	advance(700 * time.Millisecond)
	d.reachable(depRuntime)
	expectLines(t, "the runtime away for a moment", rec.take(),
		"INFO runtime facts unavailable for status.report err=dial unix /run/whombat/admin.sock: connect: no such file or directory",
		"INFO the runtime answers again after=700ms")
}

// MG-62: while the runtime is expected to be away (an activation restarts it) its outage is never a warning; once it
// is no longer expected and has lasted 10 minutes, it is.
func TestExpectedOutageIsNoWarning(t *testing.T) {
	d, rec, advance := outageDaemon()
	const facts = "runtime facts unavailable for status.report"
	gone := errors.New(`Get "http://runtime/facts": dial unix /run/whombat/admin.sock: connect: no such file or directory`)
	d.unreachable(depRuntime, facts, gone, true)
	for range 4 {
		advance(5 * time.Minute)
		d.unreachable(depRuntime, facts, gone, true)
	}
	expectLines(t, "20 minutes of an activation", rec.take(), "INFO "+facts+" err="+gone.Error())
	advance(time.Minute)
	d.unreachable(depRuntime, "runtime health probe failed", gone, false)
	d.unreachable(depRuntime, facts, gone, false)
	expectLines(t, "the activation over, the runtime still away", rec.take(),
		"WARN runtime health probe failed err="+gone.Error()+" for=21m0s")
	advance(3 * time.Second)
	d.reachable(depRuntime)
	expectLines(t, "the runtime back", rec.take(), "INFO the runtime answers again after=21m3s")
}

// The runtime is expected away while the journal is Activating or Verifying (a rollback runs inside them, MG-06).
func TestRestartingPhases(t *testing.T) {
	for _, p := range []update.Phase{update.Assigned, update.Downloading, update.Verified, update.Staged,
		update.WaitingForSafeBoundary, update.Activating, update.Verifying, update.Healthy, update.Failed,
		update.RolledBack, update.Quarantined, update.ForwardRepairRequired} {
		want := p == update.Activating || p == update.Verifying
		if got := restartingPhase(p); got != want {
			t.Errorf("restartingPhase(%s) = %v", p, got)
		}
	}
	if (&Daemon{}).runtimeRestarting() {
		t.Error("a daemon without an engine expects the runtime away")
	}
}

func TestRoundAway(t *testing.T) {
	for d, want := range map[time.Duration]string{
		0: "0s", 734567 * time.Microsecond: "735ms", 61499 * time.Millisecond: "1m1s", 10*time.Minute + 499*time.Millisecond: "10m0s",
	} {
		if got := roundAway(d).String(); !strings.EqualFold(got, want) {
			t.Errorf("roundAway(%s) = %s, want %s", d, got, want)
		}
	}
}
