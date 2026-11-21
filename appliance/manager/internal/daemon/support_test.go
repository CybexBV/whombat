package daemon_test

import (
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/manager/internal/config"
	"github.com/CybexBV/whombat/appliance/manager/internal/controlapi/fakecontrol"
	"github.com/CybexBV/whombat/appliance/manager/internal/daemon"
	"github.com/CybexBV/whombat/appliance/manager/internal/testworld"
	"github.com/CybexBV/whombat/contracts/go/device"
)

// A support service whose state the test sets.
type fakeSupport struct {
	mu    sync.Mutex
	state string
	asked int // how often the state was read
	// then, when set, is the state from the second read on: a change right after the first read.
	then string
}

func (f *fakeSupport) set(s string) { f.mu.Lock(); f.state = s; f.mu.Unlock() }

func (f *fakeSupport) reads() int { f.mu.Lock(); defer f.mu.Unlock(); return f.asked }

func (f *fakeSupport) start(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "sup")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	sock := filepath.Join(dir, "api.sock")
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		f.asked++
		_, _ = w.Write([]byte(f.state))
		if f.then != "" {
			f.state, f.then = f.then, ""
		}
	})}
	go srv.Serve(ln)
	t.Cleanup(func() { srv.Close() })
	return sock
}

const (
	helpOff = `{"v":1,"available":true,"foreverAllowed":true,"helpCodeRequired":false,"environment":"local",` +
		`"hostKey":"ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBP1R/FPWtslgeNqtsKOMeiASK9J6pg6a60TIETgQXtA","grant":null,"connected":[]}`
	helpOn = `{"v":1,"available":true,"foreverAllowed":true,"helpCodeRequired":false,"environment":"local",` +
		`"hostKey":"ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBP1R/FPWtslgeNqtsKOMeiASK9J6pg6a60TIETgQXtA",` +
		`"grant":{"level":"fix","since":"2026-10-21T12:00:00Z","until":null,"grantedBy":{"accountId":"acc_1","name":"John"},` +
		`"helpCode":null,"wrongCodes":0},"connected":[]}`
)

// MG-119, MG-120 through the running daemon: status.report carries remote help from the support socket, and an owner
// turning it on reaches control within seconds, though control asks for a report only every hour here.
func TestRemoteHelpReachesControl(t *testing.T) {
	t.Parallel()
	svc := &fakeSupport{state: helpOff}
	sock := svc.start(t)
	h := startDaemon(t, map[string]any{"statusReportSec": 3600, "supportSocket": sock, "supportWatchSec": 1},
		func(_ *testworld.World, fc *fakecontrol.Control, _ *config.Config) {
			fc.NextReportS = 3600
		})
	fc := h.fc
	last := func() *device.StatusReportRequest {
		reps := fc.StatusReports()
		if len(reps) == 0 {
			return nil
		}
		return &reps[len(reps)-1]
	}
	show := func() string { return fmt.Sprintf("%d reports, last %+v", len(fc.StatusReports()), last()) }
	h.eventually("the start-up status.report", func() bool { return last() != nil }, show)
	if s := last().Support; s == nil || s.State != device.SupportReportStateOff || s.UntilS != nil || s.HostKey == nil {
		t.Fatalf("%+v", s)
	}
	// The watch asks for a report when the state differs from the one it saw before, and it looks for the first time a
	// watch interval after the start: the status loop read the state once for the start-up report (control asks for the
	// next in an hour), so a second read is the watch's.
	h.eventually("the watch's first look at remote help", func() bool { return svc.reads() >= 2 }, show)
	svc.set(helpOn)
	h.eventually("remote help on at control", func() bool {
		r := last()
		return r.Support != nil && r.Support.State == device.SupportReportStateFix && r.Support.UntilS == nil
	}, show)
}

// A change between the start-up status.report and the watch's first look reaches control within seconds too (MG-156):
// an owner who turns remote help on, or off, just after the box started. The state changes right after its first read,
// the status loop's for the start-up report (it comes a moment after the start, the watch's first look a second
// later), and control asks for the next report only in an hour.
func TestRemoteHelpChangedBeforeTheWatchLooked(t *testing.T) {
	t.Parallel()
	for _, c := range []struct {
		name, first, then string
		want              device.SupportReportState
	}{
		{"turned on", helpOff, helpOn, device.SupportReportStateFix},
		{"turned off", helpOn, helpOff, device.SupportReportStateOff},
	} {
		t.Run(c.name, func(t *testing.T) {
			t.Parallel()
			svc := &fakeSupport{state: c.first, then: c.then}
			sock := svc.start(t)
			h := startDaemonWith(t, map[string]any{"statusReportSec": 3600, "supportSocket": sock, "supportWatchSec": 1},
				func(d *daemon.Daemon) { d.Waits.StatusFirst = time.Millisecond },
				func(_ *testworld.World, fc *fakecontrol.Control, _ *config.Config) { fc.NextReportS = 3600 })
			h.eventually("remote help "+c.name+" at control", func() bool {
				reps := h.fc.StatusReports()
				return len(reps) > 0 && reps[len(reps)-1].Support != nil && reps[len(reps)-1].Support.State == c.want
			}, func() string {
				reps := h.fc.StatusReports()
				if len(reps) == 0 {
					return "no reports"
				}
				return fmt.Sprintf("%d reports, last %+v", len(reps), reps[len(reps)-1].Support)
			})
		})
	}
}

// A report control didn't answer is sent again within seconds, so remote help turned on while control was away for a
// moment (the network, control restarting) doesn't wait for the next periodic report: an hour away here.
func TestRemoteHelpReachesControlAfterAFailedReport(t *testing.T) {
	t.Parallel()
	svc := &fakeSupport{state: helpOff}
	sock := svc.start(t)
	h := startDaemon(t, map[string]any{"statusReportSec": 3600, "supportSocket": sock, "supportWatchSec": 1},
		func(_ *testworld.World, fc *fakecontrol.Control, _ *config.Config) { fc.NextReportS = 3600 })
	fc := h.fc
	show := func() string {
		reps := fc.StatusReports()
		refused := 0
		fc.Set(func(c *fakecontrol.Control) { refused = c.StatusRefused })
		if len(reps) == 0 {
			return fmt.Sprintf("no reports, %d refused", refused)
		}
		return fmt.Sprintf("%d reports, %d refused, last %+v", len(reps), refused, reps[len(reps)-1].Support)
	}
	h.eventually("the start-up status.report", func() bool { return len(fc.StatusReports()) > 0 }, show)
	// The watch looked once (the second read; the first was the start-up report's), so the change is one it sees.
	h.eventually("the watch's first look at remote help", func() bool { return svc.reads() >= 2 }, show)
	fc.Set(func(c *fakecontrol.Control) { c.StatusAway = 2 })
	svc.set(helpOn)
	h.eventually("remote help on at control", func() bool {
		reps := fc.StatusReports()
		r := reps[len(reps)-1]
		return r.Support != nil && r.Support.State == device.SupportReportStateFix
	}, show)
	refused := 0
	fc.Set(func(c *fakecontrol.Control) { refused = c.StatusRefused })
	if refused != 2 {
		t.Fatalf("control refused %d reports before it took one, want 2", refused)
	}
}
