package daemon_test

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/manager/internal/broker"
	"github.com/CybexBV/whombat/appliance/manager/internal/daemon"
	"github.com/CybexBV/whombat/appliance/manager/internal/testworld"
	"github.com/CybexBV/whombat/appliance/manager/internal/update"
)

// notifications is a fake systemd notify socket ($NOTIFY_SOCKET) collecting what the manager sends (without the
// watchdog pings).
type notifications struct {
	t         *testing.T
	path      string
	ch        chan string
	watchdogs atomic.Int64 // WATCHDOG=1 pings
}

// shortDir is a temporary directory with a short path (a socket path has at most 107 bytes; t.TempDir's contains the
// test's name).
func shortDir(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "wbsr")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Chmod(dir, 0o700); os.RemoveAll(dir) })
	return dir
}

func listenNotify(t *testing.T) *notifications {
	t.Helper()
	p := filepath.Join(shortDir(t), "notify.sock")
	l, err := net.ListenUnixgram("unixgram", &net.UnixAddr{Name: p, Net: "unixgram"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { l.Close() })
	t.Setenv("NOTIFY_SOCKET", p)
	n := &notifications{t: t, path: p, ch: make(chan string, 4096)}
	go func() {
		buf := make([]byte, 64*1024)
		for {
			k, err := l.Read(buf)
			if err != nil {
				return
			}
			if msg := string(buf[:k]); msg == "WATCHDOG=1" {
				n.watchdogs.Add(1)
			} else {
				n.ch <- msg
			}
		}
	}()
	return n
}

var sentinels atomic.Int64

// rest returns every message not read yet that the manager sent before now: it sends a sentinel after them (a unix
// datagram socket keeps their order) and collects up to it. Call it once the manager stopped sending (Run returned).
func (n *notifications) rest() []string {
	n.t.Helper()
	token := fmt.Sprintf("SENTINEL=%d", sentinels.Add(1))
	c, err := net.DialUnix("unixgram", nil, &net.UnixAddr{Name: n.path, Net: "unixgram"})
	if err != nil {
		n.t.Fatal(err)
	}
	_, err = c.Write([]byte(token))
	c.Close()
	if err != nil {
		n.t.Fatal(err)
	}
	var out []string
	deadline := time.After(patience)
	for {
		select {
		case msg := <-n.ch:
			if msg == token {
				return out
			}
			out = append(out, msg)
		case <-deadline:
			n.t.Fatal("no sentinel")
		}
	}
}

// none fails if one of msgs contains s.
func none(t *testing.T, msgs []string, s string) {
	t.Helper()
	for _, m := range msgs {
		if strings.Contains(m, s) {
			t.Fatalf("%q sent: %q", s, msgs)
		}
	}
}

// await returns the next message containing s (skipping others).
func (n *notifications) await(s string) string {
	n.t.Helper()
	deadline := time.After(patience)
	for {
		select {
		case msg := <-n.ch:
			if strings.Contains(msg, s) {
				return msg
			}
		case <-deadline:
			n.t.Fatalf("no %q from the manager", s)
		}
	}
}

// awaitExactly waits for the message s.
func (n *notifications) awaitExactly(s string) {
	n.t.Helper()
	deadline := time.After(patience)
	for {
		select {
		case msg := <-n.ch:
			if msg == s {
				return
			}
		case <-deadline:
			n.t.Fatalf("no %q from the manager", s)
		}
	}
}

var goroutineID = regexp.MustCompile(`^goroutine (\d+) `)

// goroutines returns the stacks of the running goroutines by id.
func goroutines() map[string]string {
	buf := make([]byte, 8<<20)
	buf = buf[:runtime.Stack(buf, true)]
	out := map[string]string{}
	for _, g := range strings.Split(string(buf), "\n\n") {
		if m := goroutineID.FindStringSubmatch(g); m != nil {
			out[m[1]] = g
		}
	}
	return out
}

// noLeaks fails unless every goroutine started since before (running manager code: daemon loops, broker,
// clients) has ended.
func noLeaks(t *testing.T, before map[string]string) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		var leaked []string
		for id, g := range goroutines() {
			if _, old := before[id]; old {
				continue
			}
			for _, pkg := range []string{"/manager/internal/daemon.", "/manager/internal/broker.", "/manager/internal/clients."} {
				if strings.Contains(g, pkg) {
					leaked = append(leaked, g)
					break
				}
			}
		}
		if len(leaked) == 0 {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("%d goroutines of the manager outlived Run:\n%s", len(leaked), strings.Join(leaked, "\n\n"))
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// running is a daemon started by hand (Run's result observable).
type running struct {
	cancel context.CancelFunc
	done   chan error
}

func runDaemon(d *daemon.Daemon) *running {
	ctx, cancel := context.WithCancel(context.Background())
	r := &running{cancel: cancel, done: make(chan error, 1)}
	go func() { r.done <- d.Run(ctx) }()
	return r
}

// result waits for Run to return.
func (r *running) result(t *testing.T) error {
	t.Helper()
	select {
	case err := <-r.done:
		return err
	case <-time.After(patience):
		r.cancel()
		t.Fatal("Run did not return")
		return nil
	}
}

// statusOK: the local API answers on sock (the runtime's uid is the test's).
func statusOK(t *testing.T, sock string) {
	t.Helper()
	c := &http.Client{Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		var d net.Dialer
		return d.DialContext(ctx, "unix", sock)
	}}}
	defer c.CloseIdleConnections()
	resp, err := c.Get("http://manager/v1/update/status")
	if err != nil {
		t.Fatalf("local API: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("local API: %d", resp.StatusCode)
	}
}

// SR-01: READY=1 is sent once the local API accepts requests (checked the moment it arrives); a normal stop returns
// nil, says STOPPING=1, removes the socket and leaves no goroutine behind.
func TestReadyOnceTheLocalAPIListens(t *testing.T) {
	n := listenNotify(t)
	h := newHarness(t, nil, nil)
	before := goroutines()
	r := runDaemon(h.build())
	ready := n.await("READY=1")
	statusOK(t, h.cfg.APISocket)
	if !strings.Contains(ready, "STATUS=whombat-manager 0.1.0-test (normal)") {
		t.Fatalf("%q", ready)
	}
	r.cancel()
	if err := r.result(t); err != nil {
		t.Fatalf("a normal stop is not a failure: %v", err)
	}
	n.await("STOPPING=1")
	if _, err := os.Lstat(h.cfg.APISocket); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("socket left behind: %v", err)
	}
	noLeaks(t, before)
}

// SR-01: a socket another manager serves is not taken over: Run fails before it announces readiness or starts
// anything.
func TestStartFailsWhenTheSocketIsServed(t *testing.T) {
	n := listenNotify(t)
	h := newHarness(t, nil, nil)
	other, err := net.Listen("unix", h.cfg.APISocket)
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()
	before := goroutines()
	r := runDaemon(h.build())
	if err := r.result(t); !errors.Is(err, broker.ErrSocketInUse) {
		t.Fatalf("Run: %v", err)
	}
	none(t, n.rest(), "READY=1")
	if c, err := net.Dial("unix", h.cfg.APISocket); err != nil {
		t.Fatalf("the other manager lost its socket: %v", err)
	} else {
		c.Close()
	}
	noLeaks(t, before)
}

// SR-01: a socket that cannot be created (a directory the manager cannot write, or none) fails the start, in normal
// and recovery mode.
func TestStartFailsWhenTheSocketCannotBeCreated(t *testing.T) {
	for _, recovery := range []bool{false, true} {
		for _, dir := range []string{"read-only", "missing"} {
			if dir == "read-only" && os.Geteuid() == 0 {
				continue // root writes anyway
			}
			t.Run(fmt.Sprintf("%s/recovery=%v", dir, recovery), func(t *testing.T) {
				n := listenNotify(t)
				h := newHarness(t, nil, nil)
				h.recovery = recovery
				parent := filepath.Join(shortDir(t), dir)
				want := os.ErrNotExist
				if dir == "read-only" {
					os.Mkdir(parent, 0o500)
					t.Cleanup(func() { os.Chmod(parent, 0o700) })
					want = os.ErrPermission
				}
				h.cfg.APISocket = filepath.Join(parent, "api.sock")
				before := goroutines()
				r := runDaemon(h.build())
				err := r.result(t)
				if !errors.Is(err, want) || !strings.Contains(err.Error(), "local API") {
					t.Fatalf("Run: %v", err)
				}
				none(t, n.rest(), "READY=1")
				noLeaks(t, before)
			})
		}
	}
}

// SR-02: when the local API fails after readiness (its socket file is gone: the runtime cannot reach the manager),
// Run cancels every loop and returns the failure, so systemd restarts the manager; nothing keeps running.
func TestLocalAPIFailureStopsTheManager(t *testing.T) {
	n := listenNotify(t)
	h := newHarness(t, nil, func(d *daemon.Daemon) { d.Broker.SocketCheck = 50 * time.Millisecond })
	before := goroutines()
	r := runDaemon(h.build())
	n.await("READY=1")
	statusOK(t, h.cfg.APISocket)
	os.Remove(h.cfg.APISocket)
	err := r.result(t)
	if !errors.Is(err, broker.ErrSocketLost) {
		t.Fatalf("Run: %v", err)
	}
	msgs := n.rest()
	none(t, msgs, "STOPPING=1")
	if !slices.ContainsFunc(msgs, func(m string) bool {
		return strings.HasPrefix(m, "STATUS=stopping after a failure: ") && strings.Contains(m, broker.ErrSocketLost.Error())
	}) {
		t.Fatalf("no failure status: %q", msgs)
	}
	noLeaks(t, before)
	// The next start (systemd's restart) serves again.
	r = runDaemon(h.build())
	n.await("READY=1")
	statusOK(t, h.cfg.APISocket)
	r.cancel()
	if err := r.result(t); err != nil {
		t.Fatal(err)
	}
}

// SR-01, MG-16: the recovery manager starts and stops the same way and still never activates: an assignment is
// queued.
func TestRecoveryManagerStartsAndStops(t *testing.T) {
	n := listenNotify(t)
	h := newHarness(t, nil, nil)
	h.recovery = true
	before := goroutines()
	r := runDaemon(h.build())
	ready := n.await("READY=1")
	if !strings.Contains(ready, "(recovery)") {
		t.Fatalf("%q", ready)
	}
	statusOK(t, h.cfg.APISocket)
	raw, _ := h.w.Repo.Assign("dev-1", testworld.RuntimeGood, 1, 24*time.Hour)
	h.fc.SetAssignment(raw)
	h.waitFor("the assignment queued", func(st *update.State) bool {
		return st.Pending != nil && st.Pending.Seq == 1 && st.Candidate == nil && st.Phase == update.Healthy
	})
	r.cancel()
	if err := r.result(t); err != nil {
		t.Fatal(err)
	}
	noLeaks(t, before)
}

// SR-01: a Run whose context ended before it could announce readiness does not send READY=1.
func TestNoReadyAfterAStop(t *testing.T) {
	n := listenNotify(t)
	h := newHarness(t, nil, nil)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := h.build().Run(ctx); err != nil {
		t.Fatal(err)
	}
	none(t, n.rest(), "READY=1")
}

// SR-02: the drain is bounded: with a loop that does not stop (the engine blocked in a step), a normal stop returns
// nil and a failure its error, each after DrainTimeout and not much later; Run pings the watchdog meanwhile (the
// engine loop, the heartbeat, is the one that hangs).
func TestDrainIsBounded(t *testing.T) {
	t.Setenv("WATCHDOG_USEC", "400000") // a ping every 200 ms
	t.Setenv("WATCHDOG_PID", "")
	const drain = 700 * time.Millisecond
	for _, failure := range []bool{false, true} {
		t.Run(fmt.Sprintf("failure=%v", failure), func(t *testing.T) {
			n := listenNotify(t)
			blocked, unblock := make(chan struct{}), make(chan struct{})
			var once atomic.Bool
			h := newHarness(t, nil, func(d *daemon.Daemon) {
				d.DrainTimeout = drain
				d.Broker.SocketCheck = 20 * time.Millisecond
				d.Engine.Crash = func(point string) error {
					if point == "persist:Assigned->Downloading:before" && once.CompareAndSwap(false, true) {
						close(blocked)
						<-unblock
					}
					return nil
				}
			})
			before := goroutines()
			r := runDaemon(h.build())
			n.await("READY=1")
			raw, _ := h.w.Repo.Assign("dev-1", testworld.RuntimeGood, 1, 24*time.Hour)
			h.fc.SetAssignment(raw)
			select {
			case <-blocked:
			case <-time.After(patience):
				t.Fatal(h.journal())
			}
			pings := n.watchdogs.Load()
			start := time.Now()
			if failure {
				os.Remove(h.cfg.APISocket)
			} else {
				r.cancel()
			}
			err := r.result(t)
			took := time.Since(start)
			if failure != errors.Is(err, broker.ErrSocketLost) || (!failure && err != nil) {
				t.Fatalf("Run: %v", err)
			}
			if took < drain || took > drain+5*time.Second {
				t.Fatalf("Run returned after %s (DrainTimeout %s)", took, drain)
			}
			if got := n.watchdogs.Load() - pings; got < 3 {
				t.Fatalf("%d watchdog pings while draining for %s", got, took)
			}
			close(unblock)
			noLeaks(t, before)
		})
	}
}
