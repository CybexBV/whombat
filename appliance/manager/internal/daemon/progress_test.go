package daemon_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/helper/pkg/atomicfile"
	"github.com/CybexBV/whombat/appliance/manager/internal/config"
	"github.com/CybexBV/whombat/appliance/manager/internal/controlapi/fakecontrol"
	"github.com/CybexBV/whombat/appliance/manager/internal/daemon"
	"github.com/CybexBV/whombat/appliance/manager/internal/outbox"
	"github.com/CybexBV/whombat/appliance/manager/internal/testworld"
	"github.com/CybexBV/whombat/appliance/manager/internal/update"
	"github.com/CybexBV/whombat/contracts/go/device"
	"github.com/CybexBV/whombat/contracts/go/release"
)

// Gate modes for update.progress.
const (
	gatePass    = "pass"     // to control
	gateHang    = "hang"     // held until released, then 503
	gateLoseAck = "lose-ack" // control takes the report, the answer is lost (the connection closes)
	gateDown    = "down"     // control unreachable (every op: the connection closes)
)

// controlGate stands between the manager and the fake control and decides what happens to update.progress.
type controlGate struct {
	srv   *httptest.Server
	proxy *httputil.ReverseProxy

	mu      sync.Mutex
	mode    string
	loseN   int           // lose-ack: answers still to lose, then pass
	release chan struct{} // closed: hanging requests end
	hung    chan struct{} // a request started hanging
	took    []device.UpdateProgressRequest
}

// gated puts a controlGate in front of the fake control (a setupFn), starting in mode (and losing loseN answers).
func gated(g **controlGate, mode string, loseN int) setupFn {
	return func(w *testworld.World, fc *fakecontrol.Control, c *config.Config) {
		u, _ := url.Parse(fc.Server.URL)
		gate := &controlGate{proxy: httputil.NewSingleHostReverseProxy(u), mode: mode, loseN: loseN,
			release: make(chan struct{}), hung: make(chan struct{}, 1)}
		gate.srv = httptest.NewServer(gate)
		w.T.Cleanup(gate.close)
		c.Control.URL = gate.srv.URL
		*g = gate
	}
}

func (g *controlGate) close() {
	g.set(gatePass)
	g.srv.CloseClientConnections()
	g.srv.Close()
}

func (g *controlGate) set(mode string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.mode == gateHang && mode != gateHang {
		close(g.release)
		g.release = make(chan struct{})
	}
	g.mode = mode
}

func (g *controlGate) loseAcks(n int) { g.mu.Lock(); g.mode, g.loseN = gateLoseAck, n; g.mu.Unlock() }

// reports returns the update.progress reports control took, in order.
func (g *controlGate) reports() []device.UpdateProgressRequest {
	g.mu.Lock()
	defer g.mu.Unlock()
	return append([]device.UpdateProgressRequest(nil), g.took...)
}

func drop(w http.ResponseWriter) {
	if c, _, err := w.(http.Hijacker).Hijack(); err == nil {
		c.Close()
	}
}

func (g *controlGate) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	progress := path.Base(r.URL.Path) == string(device.DeviceOpNameUpdateProgress)
	g.mu.Lock()
	mode, release := g.mode, g.release
	g.mu.Unlock()
	switch {
	case mode == gateDown:
		drop(w)
		return
	case !progress:
		g.proxy.ServeHTTP(w, r)
		return
	case mode == gateHang:
		select {
		case g.hung <- struct{}{}:
		default:
		}
		select {
		case <-release:
		case <-r.Context().Done():
		}
		http.Error(w, "busy", http.StatusServiceUnavailable)
		return
	}
	body, _ := io.ReadAll(r.Body)
	r.Body = io.NopCloser(bytes.NewReader(body))
	rec := httptest.NewRecorder()
	g.proxy.ServeHTTP(rec, r)
	if rec.Code == http.StatusOK {
		var env device.DeviceRequestEnvelope
		var p device.UpdateProgressRequest
		if json.Unmarshal(body, &env) == nil && json.Unmarshal(env.Body, &p) == nil {
			g.mu.Lock()
			g.took = append(g.took, p)
			g.mu.Unlock()
		}
	}
	g.mu.Lock()
	lose := g.mode == gateLoseAck && g.loseN > 0
	if lose {
		if g.loseN--; g.loseN == 0 {
			g.mode = gatePass
		}
	}
	g.mu.Unlock()
	if lose {
		drop(w)
		return
	}
	for k, v := range rec.Header() {
		w.Header()[k] = v
	}
	w.WriteHeader(rec.Code)
	w.Write(rec.Body.Bytes())
}

// tookState: control took a report about release id (the candidate, else the current release: Healthy) in state st.
func (g *controlGate) tookState(id string, st update.Phase) func() bool {
	return func() bool {
		for _, p := range g.reports() {
			if outbox.Key(p) == id && p.State == st {
				return true
			}
		}
		return false
	}
}

// same: a and b are the same report.
func same(a, b device.UpdateProgressRequest) bool {
	x, _ := json.Marshal(a)
	y, _ := json.Marshal(b)
	return bytes.Equal(x, y)
}

func (g *controlGate) detail() string {
	var s []string
	for _, p := range g.reports() {
		s = append(s, fmt.Sprintf("%s/%s", outbox.Key(p), p.State))
	}
	return strings.Join(s, " ")
}

// pendingState: the outbox holds a report about release id in state st.
func pendingState(t *testing.T, d *daemon.Daemon, id string, st update.Phase) bool {
	t.Helper()
	pend, err := d.Outbox.Pending()
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range pend {
		if e.Key == id && e.Report.State == st {
			return true
		}
	}
	return false
}

// inOrder: no release's reports at control go back from a final state to an earlier one of the same assignment.
func inOrder(t *testing.T, reps []device.UpdateProgressRequest) {
	t.Helper()
	final := map[string]device.UpdateProgressRequest{}
	for _, p := range reps {
		k := fmt.Sprintf("%s/%d", outbox.Key(p), p.Sequence)
		if f, ok := final[k]; ok && !outbox.Terminal(p.State) && p.Attempt <= f.Attempt {
			t.Fatalf("%s went back from %s to %s", k, f.State, p.State)
		}
		if outbox.Terminal(p.State) {
			final[k] = p
		}
	}
}

// SR-03: every persisted state is recorded in the outbox before the manager goes on, however many transitions happen
// while the progress loop waits for control (the manager used to drop transitions beyond a 64-report channel). Here
// 150 distinct reports of 50 releases (each ends in a final state) and a real update arrive while control hangs:
// the update is not held up, every final report is kept, and all of them reach control once it answers.
func TestReportsSurviveABurst(t *testing.T) {
	t.Parallel()
	var g *controlGate
	h := startDaemon(t, nil, gated(&g, gateHang, 0))
	// A report is sent and hangs (the start-up report, or the lock's): the progress loop is stuck until control
	// answers.
	h.d.Engine.AcquireLock("test", "burst", time.Minute)
	select {
	case <-g.hung:
	case <-time.After(patience):
		t.Fatal("no report reached control")
	}
	for i := 0; i < 100; i++ { // 200 transitions that change nothing reported
		if _, err := h.d.Engine.AcquireLock("test", "burst", time.Minute); err != nil {
			t.Fatal(err)
		}
		if err := h.d.Engine.ReleaseLock("test"); err != nil {
			t.Fatal(err)
		}
	}
	raw, _ := h.w.Repo.Assign("dev-1", testworld.RuntimeGood, 1, 24*time.Hour)
	h.fc.SetAssignment(raw)
	// Meanwhile the transition path gets 150 distinct states of 50 other releases, as the engine hands them over.
	finals := map[string]update.Phase{}
	seq := uint64(1 << 40)
	for i := 0; i < 50; i++ {
		id := fmt.Sprintf("rt-b%02d", i)
		final := []update.Phase{update.Healthy, update.Failed, update.RolledBack}[i%3]
		for _, ph := range []update.Phase{update.Downloading, update.Verifying, final} {
			st := update.State{Phase: ph, JournalSeq: seq}
			st.Record = release.UpdateJournalRecord{V: 1, State: ph, Current: "rt-1", Candidate: &id, AssignmentSequence: int64(100 + i),
				Attempt: 1, UpdatedAt: time.Now().Unix(), Health: []release.HealthEvidence{}}
			if ph == update.Failed || ph == update.RolledBack {
				code := "unhealthy"
				st.Record.Failure = &code
			}
			h.d.Engine.OnTransition(st)
			seq++
		}
		finals[id] = final
	}
	h.waitFor("rt-2 healthy while control hangs", func(st *update.State) bool {
		return st.Phase == update.Healthy && st.Current.ReleaseID == testworld.RuntimeGood
	})
	pend, _ := h.d.Outbox.Pending()
	if !pendingState(t, h.d, testworld.RuntimeGood, update.Healthy) || len(pend) > outbox.MaxEntries {
		var s []string
		for _, e := range pend {
			s = append(s, e.Key+"/"+string(e.Report.State))
		}
		t.Fatalf("rt-2's Healthy is not in the outbox: %s", strings.Join(s, " "))
	}
	for id, final := range finals {
		if !pendingState(t, h.d, id, final) {
			t.Fatalf("%s's %s is not in the outbox", id, final)
		}
	}
	if len(g.reports()) != 0 {
		t.Fatal("control took a report while it hung")
	}
	g.set(gatePass)
	h.eventually("rt-2 Healthy at control", g.tookState(testworld.RuntimeGood, update.Healthy), g.detail)
	h.eventually("the outbox empty", func() bool { p, _ := h.d.Outbox.Pending(); return len(p) == 0 }, g.detail)
	for id, final := range finals {
		if !g.tookState(id, final)() {
			t.Fatalf("%s's %s did not reach control: %s", id, final, g.detail())
		}
	}
	inOrder(t, g.reports())
}

// SR-07: a state persisted in the journal whose report never reached the outbox (the manager died in between) is
// reported after the restart; control being unreachable meanwhile holds nothing up, and the outbox keeps the report
// across a restart while control is still away.
func TestReportOfACrashedTransition(t *testing.T) {
	var g *controlGate
	n := listenNotify(t)
	crashed := make(chan struct{})
	release := make(chan struct{})
	var once atomic.Bool
	h := startDaemonWith(t, nil, func(d *daemon.Daemon) {
		d.Engine.Crash = func(point string) error {
			if point == "persist:Verifying->Healthy:after" && once.CompareAndSwap(false, true) {
				close(crashed)
				<-release
				return errors.New("crash: after the journal write, before the report")
			}
			return nil
		}
	}, gated(&g, gatePass, 0))
	n.await("READY=1")
	raw, _ := h.w.Repo.Assign("dev-1", testworld.RuntimeGood, 1, 24*time.Hour)
	h.fc.SetAssignment(raw)
	select {
	case <-crashed:
	case <-time.After(patience):
		t.Fatal(h.journal())
	}
	h.waitFor("Healthy in the journal", func(st *update.State) bool { return st.Phase == update.Healthy })
	if pendingState(t, h.d, testworld.RuntimeGood, update.Healthy) || g.tookState(testworld.RuntimeGood, update.Healthy)() {
		t.Fatal("reported although the manager died before the report")
	}
	g.set(gateDown)
	close(release)
	h.restart() // offline: the report is queued at start-up and stays queued
	n.await("READY=1")
	if !pendingState(t, h.d, testworld.RuntimeGood, update.Healthy) {
		t.Fatal("not reconciled at start-up")
	}
	h.restart() // still offline: the outbox keeps it
	n.await("READY=1")
	if !pendingState(t, h.d, testworld.RuntimeGood, update.Healthy) {
		t.Fatal("lost across a restart")
	}
	g.set(gatePass)
	h.eventually("rt-2 Healthy at control", g.tookState(testworld.RuntimeGood, update.Healthy), g.detail)
}

// SR-04: a report whose acknowledgement was lost is sent again (control takes it twice, which changes nothing there)
// and removed once acknowledged; an unchanged state is not sent again, not even after a restart; a lost outbox is
// reconciled from the journal.
func TestLostAcknowledgements(t *testing.T) {
	var g *controlGate
	n := listenNotify(t)
	h := startDaemon(t, nil, gated(&g, gateLoseAck, 1)) // the start-up report's answer is lost
	n.await("READY=1")
	h.eventually("the start-up report sent again and acknowledged", func() bool {
		p, _ := h.d.Outbox.Pending()
		return len(g.reports()) >= 2 && len(p) == 0
	}, g.detail)
	if reps := g.reports(); !same(reps[0], reps[1]) {
		t.Fatalf("not the same report again: %+v %+v", reps[0], reps[1])
	}
	g.loseAcks(2)
	raw, _ := h.w.Repo.Assign("dev-1", testworld.RuntimeGood, 1, 24*time.Hour)
	h.fc.SetAssignment(raw)
	h.eventually("rt-2 Healthy at control", g.tookState(testworld.RuntimeGood, update.Healthy), g.detail)
	h.eventually("the outbox empty", func() bool { p, _ := h.d.Outbox.Pending(); return len(p) == 0 }, g.detail)
	inOrder(t, g.reports())

	// Unchanged states (a maintenance lock) are not queued; a restart does not send the reported state again.
	for i := 0; i < 3; i++ {
		h.d.Engine.AcquireLock("test", "unchanged", time.Minute)
		h.d.Engine.ReleaseLock("test")
	}
	if p, _ := h.d.Outbox.Pending(); len(p) != 0 {
		t.Fatalf("unchanged states queued: %+v", p)
	}
	g.set(gateHang) // anything queued now would stay queued
	h.restart()
	n.await("READY=1") // Run reconciled before it announced readiness
	if p, _ := h.d.Outbox.Pending(); len(p) != 0 {
		t.Fatalf("the reported state was queued again after a restart: %+v", p)
	}
	g.set(gatePass)

	// The outbox is lost while the manager is stopped: the journal's state is reported again.
	count := len(g.reports())
	h.stop()
	os.Remove(filepath.Join(h.cfg.JournalDir, "progress-outbox-v2.json"))
	h.run()
	h.eventually("the journal's state reported again", func() bool {
		reps := g.reports()
		return len(reps) > count && reps[len(reps)-1].State == update.Healthy && outbox.Key(reps[len(reps)-1]) == testworld.RuntimeGood
	}, g.detail)
}

// SR-08: when the outbox cannot be written the update goes on, the reports are sent from memory, the failure is
// logged and shown in the unit's status line, and the next successful write clears it.
func TestOutboxWriteFailure(t *testing.T) {
	var g *controlGate
	var broken atomic.Bool
	n := listenNotify(t)
	h := startDaemonWith(t, nil, func(d *daemon.Daemon) {
		d.Outbox.WriteFile = func(p string, b []byte, m os.FileMode) error {
			if broken.Load() {
				return errors.New("injected: no space left on device")
			}
			return atomicfile.WriteFile(p, b, m)
		}
	}, gated(&g, gatePass, 0))
	n.await("READY=1")
	broken.Store(true)
	raw, _ := h.w.Repo.Assign("dev-1", testworld.RuntimeGood, 1, 24*time.Hour)
	h.fc.SetAssignment(raw)
	status := n.await("update reports not saved")
	if !strings.Contains(status, "injected: no space left on device") {
		t.Fatalf("%q", status)
	}
	h.waitFor("rt-2 healthy", func(st *update.State) bool {
		return st.Phase == update.Healthy && st.Current.ReleaseID == testworld.RuntimeGood
	})
	h.eventually("rt-2 Healthy at control", g.tookState(testworld.RuntimeGood, update.Healthy), g.detail)
	if b, _ := os.ReadFile(filepath.Join(h.cfg.JournalDir, "progress-outbox-v2.json")); bytes.Contains(b, []byte(`"Verifying"`)) {
		t.Fatal("written although every write failed")
	}
	broken.Store(false)
	h.d.Engine.AcquireLock("test", "wake", time.Minute) // any transition retries the write
	n.awaitExactly("STATUS=whombat-manager 0.1.0-test (normal)")
	if h.d.Outbox.Err() != nil {
		t.Fatal(h.d.Outbox.Err())
	}
}

// countErrors counts the error-level log records whose message contains its text.
type countErrors struct {
	text string
	n    *atomic.Int64
}

func (c countErrors) Enabled(context.Context, slog.Level) bool { return true }
func (c countErrors) Handle(_ context.Context, r slog.Record) error {
	if r.Level == slog.LevelError && strings.Contains(r.Message, c.text) {
		c.n.Add(1)
	}
	return nil
}
func (c countErrors) WithAttrs([]slog.Attr) slog.Handler { return c }
func (c countErrors) WithGroup(string) slog.Handler      { return c }

// SR-08: a real failed write (the outbox's path is a non-empty directory, so the atomic rename fails, and every error
// names another temporary file) is logged once and shown once, without the file name, however often it is tried.
func TestOutboxWriteFailureLoggedOnce(t *testing.T) {
	n := listenNotify(t)
	var logged atomic.Int64
	h := newHarness(t, nil, nil)
	h.log = slog.New(countErrors{"not written to disk", &logged})
	os.MkdirAll(filepath.Join(h.cfg.JournalDir, "progress-outbox-v2.json", "x"), 0o700)
	r := runDaemon(h.build())
	ready := n.await("READY=1") // the start-up reconciliation failed to write already
	if !strings.Contains(ready, "update reports not saved: rename: ") || strings.Contains(ready, ".tmp-") {
		t.Fatalf("%q", ready)
	}
	for i := 0; i < 10; i++ { // every one tries to write again
		h.d.Engine.AcquireLock("test", "write", time.Minute)
		h.d.Engine.ReleaseLock("test")
	}
	r.cancel()
	if err := r.result(t); err != nil {
		t.Fatal(err)
	}
	for _, m := range n.rest() {
		if strings.Contains(m, "update reports not saved") {
			t.Fatalf("the unchanged failure was shown again: %q", m)
		}
	}
	if logged.Load() != 1 {
		t.Fatalf("the failure was logged %d times", logged.Load())
	}
}
