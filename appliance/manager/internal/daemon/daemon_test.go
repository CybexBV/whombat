package daemon_test

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/manager/internal/config"
	"github.com/CybexBV/whombat/appliance/manager/internal/controlapi/fakecontrol"
	"github.com/CybexBV/whombat/appliance/manager/internal/daemon"
	"github.com/CybexBV/whombat/appliance/manager/internal/identity"
	"github.com/CybexBV/whombat/appliance/manager/internal/testworld"
	"github.com/CybexBV/whombat/appliance/manager/internal/update"
	"github.com/theupdateframework/go-tuf/v2/metadata/fetcher"
)

// harness is a running daemon over a test world (HTTP TUF repository, device-signed control API with a
// fake control, the real helper with the fake activator, the fake runtime).
type harness struct {
	t        *testing.T
	w        *testworld.World
	fc       *fakecontrol.Control
	d        *daemon.Daemon
	cfg      *config.Config
	log      *slog.Logger
	before   func(*daemon.Daemon)
	recovery bool // run the recovery manager (MG-16)
	stop     func()
}

// quickWaits are the daemon's fixed waits in these tests: a fraction of a second where the manager waits seconds, so
// a test waits for what the daemon does and not for the wall clock. The licence's schedule stays the manager's (a
// renewal a minute later at the soonest): the licence tests count renewals, and the one about the next renewal
// shortens it itself.
func quickWaits() daemon.Waits {
	w := daemon.DefaultWaits()
	w.StatusFirst, w.StatusSettle, w.StatusRetry, w.ProgressRetry, w.LeaseRenew = 200*time.Millisecond, 200*time.Millisecond, 200*time.Millisecond, 200*time.Millisecond, 500*time.Millisecond
	return w
}

// Tests that share nothing run in parallel (t.Parallel): every harness has its own world, sockets and servers. The
// ones that listen for systemd notifications (listenNotify sets $NOTIFY_SOCKET for the whole process) or count the
// process's goroutines (noLeaks) run one after another, before the parallel ones.

// patience: every observable effect is awaited as a condition with a generous deadline: the daemon's
// loops (progress reporting, facts push, status.report) run asynchronously to the journal, and under CPU
// load they may lag the state machine by seconds.
const patience = 90 * time.Second

// setupFn runs before the daemon is built (world, fake control, the loaded configuration).
type setupFn func(w *testworld.World, fc *fakecontrol.Control, c *config.Config)

func startDaemon(t *testing.T, extra map[string]any, setup ...setupFn) *harness {
	t.Helper()
	return startDaemonWith(t, extra, nil, setup...)
}

// startDaemonWith is startDaemon with a hook that runs on every daemon before it starts (e.g. its licence Clock).
func startDaemonWith(t *testing.T, extra map[string]any, before func(*daemon.Daemon), setup ...setupFn) *harness {
	t.Helper()
	h := newHarness(t, extra, before, setup...)
	h.run()
	t.Cleanup(func() { h.stop() })
	return h
}

// newHarness prepares a test world and a configuration without running a daemon (build or run does).
func newHarness(t *testing.T, extra map[string]any, before func(*daemon.Daemon), setup ...setupFn) *harness {
	t.Helper()
	w := testworld.NewAt(t, time.Now().UTC().Truncate(time.Second))
	w.Clock = nil // the daemon runs on the real clock from here
	meta := httptest.NewServer(http.FileServer(http.Dir(w.Repo.MetadataDir())))
	t.Cleanup(meta.Close)
	targets := httptest.NewServer(http.FileServer(http.Dir(w.Repo.TargetsDir())))
	t.Cleanup(targets.Close)
	fc := fakecontrol.New("dev")
	fc.NextCheckS = 1
	t.Cleanup(fc.Close)

	dir := w.P.Dir
	key, err := identity.Generate(filepath.Join(dir, "identity", "management.key"))
	if err != nil {
		t.Fatal(err)
	}
	fc.Devices["dev-1"] = key.Public
	os.WriteFile(filepath.Join(dir, "identity", "device.json"), []byte(`{"deviceId":"dev-1","env":"dev","applianceRoute":"rt_dev-1"}`), 0o644)
	cfg := map[string]any{
		"deviceFile": filepath.Join(dir, "identity", "device.json"), "managementKey": filepath.Join(dir, "identity", "management.key"),
		"managerVersion": "0.1.0-test", "control": map[string]any{"url": fc.Server.URL},
		"tuf":        map[string]any{"pinnedRoot": w.P.Pinned, "metadataUrl": meta.URL, "targetsUrl": targets.URL, "cacheDir": filepath.Join(dir, "d-tuf"), "mirrorDir": w.P.Mirror},
		"stagingDir": w.P.Staging, "journalDir": w.P.Journal, "assignmentPath": w.P.Assignment, "knownGoodDir": filepath.Join(dir, "known-good"),
		"helperSocket": w.P.HelperSock, "apiSocket": filepath.Join(filepath.Dir(w.P.HelperSock), "api.sock"),
		"runtime": map[string]any{"adminSocket": w.P.AdminSock},
		"host":    map[string]any{"bootIdPath": filepath.Join(w.P.Fake, "boot_id"), "currentSystem": filepath.Join(w.P.Fake, "current-system")},
		"pollSec": 1, "refreshSec": 2, "statusReportSec": 1, "runtimeProbeSec": 1,
		"policy": map[string]any{"healthIntervalMs": 50, "verifyTimeoutMs": 120000, "drainPollMs": 50, "retryBaseMs": 200, "idleIntervalMs": 100, "healthyStreak": 2},
	}
	for k, v := range extra {
		cfg[k] = v
	}
	b, _ := json.Marshal(cfg)
	cfgPath := filepath.Join(dir, "manager.json")
	os.WriteFile(cfgPath, b, 0o644)
	c, err := config.Load(cfgPath)
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range setup {
		f(w, fc, c)
	}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	if testing.Verbose() {
		log = slog.Default()
	}
	return &harness{t: t, w: w, fc: fc, cfg: c, log: log, before: before}
}

// build builds a daemon from the harness's configuration (not running).
func (h *harness) build() *daemon.Daemon {
	h.t.Helper()
	d, err := daemon.New(h.cfg, h.recovery, h.log)
	if err != nil {
		h.t.Fatal(err)
	}
	// go-tuf waits before it tries a failed download again, and every refresh has one that fails on purpose (the next
	// root version: 404). The manager's 2 s would be most of a test; the retry itself stays.
	d.TUF.Fetcher.(*fetcher.DefaultFetcher).SetRetry(10*time.Millisecond, 2)
	d.Waits = quickWaits()
	if h.before != nil {
		h.before(d)
	}
	h.d = d
	return d
}

// run builds a daemon from the harness's configuration and runs it until stop.
func (h *harness) run() {
	h.t.Helper()
	d := h.build()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- d.Run(ctx) }()
	h.d = d
	h.stop = func() {
		cancel()
		if err := <-done; err != nil {
			h.t.Errorf("Run after a normal stop: %v", err) // SR-02: a cancelled Run returns nil
		}
	}
}

// restart stops the daemon and starts a new one on the same state (a manager restart).
func (h *harness) restart() {
	h.t.Helper()
	h.stop()
	h.run()
}

func (h *harness) eventually(what string, ok func() bool, detail func() string) {
	h.t.Helper()
	deadline := time.Now().Add(patience)
	for !ok() {
		if time.Now().After(deadline) {
			h.t.Fatalf("timeout after %s waiting for %s: %s", patience, what, detail())
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func (h *harness) journal() string {
	st, err := h.d.Engine.Load()
	if err != nil {
		return err.Error()
	}
	return fmt.Sprintf("phase %s, failure %v", st.Phase, st.Record.Failure)
}

func (h *harness) waitFor(what string, ok func(*update.State) bool) {
	h.t.Helper()
	h.eventually(what, func() bool {
		st, err := h.d.Engine.Load()
		return err == nil && ok(st)
	}, h.journal)
}

// TestDaemonEndToEnd runs the real daemon through an update, a control outage during which the installation
// keeps running, and a second update afterwards.
func TestDaemonEndToEnd(t *testing.T) {
	t.Parallel()
	h := startDaemon(t, nil)
	w, fc, d, eventually, journal, waitFor := h.w, h.fc, h.d, h.eventually, h.journal, h.waitFor
	raw, _ := w.Repo.Assign("dev-1", testworld.RuntimeGood, 1, 24*time.Hour)
	fc.SetAssignment(raw)
	// Control goes down right after the assignment was taken: every update.progress of this update,
	// the final Healthy included, fails at first and must be redelivered from the outbox (CL-22).
	waitFor("rt-2 assigned", func(st *update.State) bool {
		return st.Candidate != nil && st.Candidate.Tuple.ReleaseID == testworld.RuntimeGood
	})
	fc.SetDown(true)
	waitFor("rt-2 healthy", func(st *update.State) bool {
		return st.Phase == update.Healthy && st.Current.ReleaseID == testworld.RuntimeGood
	})
	// (The factory release's Healthy, reported at start-up (SR-07), may be the last report control took.)
	if p, n := fc.LastProgress(); n > 0 && p.State == update.Healthy && p.Current == testworld.RuntimeGood {
		t.Fatal("rt-2's Healthy reached control while it was down")
	}
	fc.SetDown(false)
	eventually("update.progress Healthy at control", func() bool {
		p, n := fc.LastProgress()
		return n > 0 && p.State == update.Healthy
	}, func() string { p, n := fc.LastProgress(); return fmt.Sprintf("%d reports, last %+v", n, p) })
	eventually("update facts pushed to the runtime", func() bool {
		f := w.Runtime.Facts()
		return f != nil && f.Update != nil && f.Update.Current == testworld.RuntimeGood && f.Update.State == update.Healthy
	}, func() string { return fmt.Sprintf("%+v", w.Runtime.Facts()) })
	// status.report built from the runtime's GET /facts reaches control and validates.
	eventually("status.report at control", func() bool { return len(fc.StatusReports()) > 0 }, journal)
	reps := fc.StatusReports()
	if r := reps[len(reps)-1]; r.SessionsActive != 2 || r.RecoveryKit != "unconfirmed" || r.Health.Relay != "ok" || r.Release == "" {
		t.Fatalf("status.report %+v", r)
	}
	// Control outage: the installation keeps running, the manager backs off and keeps its loops alive.
	fc.SetDown(true)
	refused := fc.RefusedCount()
	eventually("the manager hitting the outage repeatedly", func() bool { return fc.RefusedCount() >= refused+3 }, journal)
	if st, _ := d.Engine.Load(); st.Phase != update.Healthy || w.RuntimeProfile() == "" {
		t.Fatalf("installation disturbed during outage: %s", st.Phase)
	}
	raw2, _ := w.Repo.Assign("dev-1", testworld.RuntimeNext, 2, 24*time.Hour)
	fc.SetAssignment(raw2)
	fc.SetDown(false)
	waitFor("rt-8 healthy after the outage", func(st *update.State) bool {
		return st.Phase == update.Healthy && st.Current.ReleaseID == testworld.RuntimeNext
	})
}

// factsCurrent: the runtime holds update facts for release id and the claim window.
func factsCurrent(w *testworld.World, id string) func() bool {
	return func() bool {
		f := w.Runtime.Facts()
		return f != nil && f.Update != nil && f.Update.Current == id && w.Runtime.ClaimWindow() != nil
	}
}

// TestRuntimeRestartGetsFactsAgain (MG-27): the runtime keeps the manager's facts and claim window in memory
// only. When it restarts after the manager started, the manager notices it coming back and hands both over
// again, without a journal transition.
func TestRuntimeRestartGetsFactsAgain(t *testing.T) {
	t.Parallel()
	// No periodic re-send here: only the down -> up transition can restore the facts.
	h := startDaemon(t, map[string]any{"factsResendSec": 3600})
	w := h.w
	detail := func() string { return fmt.Sprintf("%+v %+v", w.Runtime.Facts(), w.Runtime.ClaimWindow()) }
	h.eventually("initial facts", factsCurrent(w, testworld.Factory), detail)
	raw, _ := w.Repo.Assign("dev-1", testworld.RuntimeGood, 1, 24*time.Hour)
	h.fc.SetAssignment(raw)
	h.waitFor("rt-2 healthy", func(st *update.State) bool {
		return st.Phase == update.Healthy && st.Current.ReleaseID == testworld.RuntimeGood
	})
	h.eventually("facts after the update", factsCurrent(w, testworld.RuntimeGood), detail)

	// The runtime process dies (in-memory state gone) and stays away for a probe (every second), then comes back.
	w.Runtime.Crash()
	time.Sleep(1500 * time.Millisecond)
	if f := w.Runtime.Facts(); f != nil {
		t.Fatalf("facts reached a stopped runtime: %+v", f)
	}
	if err := w.Runtime.Start(w.P.AdminSock); err != nil {
		t.Fatal(err)
	}
	h.eventually("facts after the runtime restart", factsCurrent(w, testworld.RuntimeGood), detail)

	// Unhealthy -> healthy (the process answers but reports down) also re-sends.
	w.Runtime.SetDown(true)
	time.Sleep(3 * time.Second)
	w.Runtime.ForgetFacts()
	w.Runtime.SetDown(false)
	h.eventually("facts after the runtime recovered", factsCurrent(w, testworld.RuntimeGood), detail)
}

// TestFactsResentPeriodically (MG-27): a runtime restart between two probes is caught by the periodic re-send.
func TestFactsResentPeriodically(t *testing.T) {
	t.Parallel()
	h := startDaemon(t, map[string]any{"factsResendSec": 1, "runtimeProbeSec": 1})
	w := h.w
	detail := func() string { return fmt.Sprintf("%+v %+v", w.Runtime.Facts(), w.Runtime.ClaimWindow()) }
	h.eventually("initial facts", factsCurrent(w, testworld.Factory), detail)
	for i := 0; i < 2; i++ {
		w.Runtime.ForgetFacts() // restarted unseen: always answered the probes
		h.eventually("facts re-sent", factsCurrent(w, testworld.Factory), detail)
	}
}

// TestRuntimeRestartBetweenProbes (MG-31): a runtime that restarts faster than the probe interval is noticed by its
// new admin socket, and gets facts, claim window and lease again at the next probe (no periodic re-send here).
func TestRuntimeRestartBetweenProbes(t *testing.T) {
	t.Parallel()
	h := startDaemon(t, map[string]any{"factsResendSec": 3600, "runtimeProbeSec": 2})
	w := h.w
	detail := func() string { return fmt.Sprintf("%+v %+v", w.Runtime.Facts(), w.Runtime.ClaimWindow()) }
	h.eventually("initial facts", factsCurrent(w, testworld.Factory), detail)
	for i := 0; i < 2; i++ {
		w.Runtime.Crash()
		if err := w.Runtime.Start(w.P.AdminSock); err != nil {
			t.Fatal(err)
		}
		h.eventually("facts after a quick restart", factsCurrent(w, testworld.Factory), detail)
		if l, _ := w.Runtime.ClaimLookup(); l == nil {
			t.Fatal("no lease push after the restart")
		}
	}
}
