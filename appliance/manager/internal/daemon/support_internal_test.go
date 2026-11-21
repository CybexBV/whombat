package daemon

import (
	"context"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/manager/internal/config"
)

// supportService answers GET /v1/state with whatever state holds now; "" is 503.
type supportService struct {
	mu    sync.Mutex
	state string
}

func (s *supportService) set(v string) { s.mu.Lock(); s.state = v; s.mu.Unlock() }

func (s *supportService) start(t *testing.T) string {
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
		s.mu.Lock()
		v := s.state
		s.mu.Unlock()
		if v == "" {
			w.WriteHeader(503)
			return
		}
		_, _ = w.Write([]byte(v))
	})}
	go srv.Serve(ln)
	t.Cleanup(func() { srv.Close() })
	return sock
}

const supportOff = `{"v":1,"available":true,"foreverAllowed":true,"helpCodeRequired":false,"environment":"local","hostKey":null,"grant":null,"connected":[]}`
const supportOn = `{"v":1,"available":true,"foreverAllowed":true,"helpCodeRequired":false,"environment":"local","hostKey":null,` +
	`"grant":{"level":"look","since":"2026-10-21T12:00:00Z","until":null,"grantedBy":{"accountId":"acc_1","name":"John"},"helpCode":null,"wrongCodes":0},` +
	`"connected":[{"visitId":"v1","who":"Claude","since":"2026-10-21T12:01:00Z"}]}`

// MG-120: an owner turning remote help on, someone connecting, the service going away and remote help going off each ask
// for a status.report at once; the same state again doesn't.
func TestSupportWatchAsksForAReport(t *testing.T) {
	svc := &supportService{state: supportOff}
	d := &Daemon{Cfg: &config.Config{SupportSocket: svc.start(t)}, Log: slog.New(&recorded{}), statusNow: make(chan struct{}, 1),
		lastErr: map[string]string{}, supportEvery: 5 * time.Millisecond}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go d.supportWatchLoop(ctx)
	asked := func(want bool) {
		t.Helper()
		// A report that must come gets time (the watch looks every 5 ms, but a busy machine runs it late); one that
		// must not come is looked for during 40 looks.
		wait := 200 * time.Millisecond
		if want {
			wait = 30 * time.Second
		}
		select {
		case <-d.statusNow:
			if !want {
				t.Fatal("a report was asked for")
			}
		case <-time.After(wait):
			if want {
				t.Fatal("no report was asked for")
			}
		}
	}
	asked(false)
	svc.set(strings.Replace(supportOn, `{"visitId":"v1","who":"Claude","since":"2026-10-21T12:01:00Z"}`, ``, 1))
	asked(true)
	asked(false)       // the same state again: nothing
	svc.set(supportOn) // Claude connected
	asked(true)
	svc.set("") // the service restarting: control hears it isn't answering
	asked(true)
	svc.set(supportOff)
	asked(true)

	// The report's member: only while the service answers.
	if r, _ := d.supportReport(ctx); r == nil || r.State != "off" {
		t.Fatalf("%+v", r)
	}
	svc.set(supportOn)
	if r, _ := d.supportReport(ctx); r == nil || r.State != "look" || r.UntilS != nil || r.Connected != 1 {
		t.Fatalf("%+v", r)
	}
	svc.set("")
	if r, _ := d.supportReport(ctx); r != nil {
		t.Fatalf("%+v", r)
	}
	d.Cfg.SupportSocket = ""
	if r, _ := d.supportReport(ctx); r != nil {
		t.Fatalf("%+v", r)
	}
}

// MG-156: the watch's first look after control took a report is compared with what that report said, not taken as the
// starting point: remote help turned on between the two is asked about at once. A report control takes only after the
// watch's first look (a slow start, a slow answer) is compared with the look after it.
func TestSupportWatchComparesWithWhatControlWasTold(t *testing.T) {
	for _, c := range []struct {
		name      string
		toldFirst bool // control took the report before the watch's first look
	}{{"a report before the first look", true}, {"a report after the first look", false}} {
		t.Run(c.name, func(t *testing.T) {
			svc := &supportService{state: supportOff}
			d := &Daemon{Cfg: &config.Config{SupportSocket: svc.start(t)}, Log: slog.New(&recorded{}), statusNow: make(chan struct{}, 1),
				lastErr: map[string]string{}, supportEvery: 5 * time.Millisecond}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			// What the status loop does with a report control took: the state it read was off.
			_, off := d.supportReport(ctx)
			svc.set(supportOn)
			asked := func(wait time.Duration) bool {
				select {
				case <-d.statusNow:
					return true
				case <-time.After(wait):
					return false
				}
			}
			if c.toldFirst {
				d.supportTold.Store(&off)
			}
			go d.supportWatchLoop(ctx)
			if !c.toldFirst {
				// Control was told nothing yet: the watch starts from what it sees (40 looks).
				if asked(200 * time.Millisecond) {
					t.Fatal("a report was asked for before control was told anything")
				}
				d.supportTold.Store(&off)
			}
			if !asked(30 * time.Second) {
				t.Fatal("no report was asked for")
			}
			// Compared once: the same state again asks for nothing, though control still knows the old one here.
			if asked(200 * time.Millisecond) {
				t.Fatal("a report was asked for again")
			}
		})
	}
}
