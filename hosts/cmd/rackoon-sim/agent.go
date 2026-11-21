package main

import (
	"context"
	"errors"
	"math/rand/v2"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/hashicorp/yamux"

	"rackoon/internal/hub/fakefleet"
	"rackoon/internal/proto"
	"rackoon/internal/wire"
)

// simAgent is one simulated agent.
type simAgent struct {
	o     options
	host  *fakefleet.Host
	id    *identity
	start time.Time

	mu       sync.Mutex
	buffer   []proto.Sample // samples taken while disconnected
	lastSent []proto.Sample // recent samples (re-sent with a backfill to test dedupe)
	seq      uint64
	early    chan struct{}
	restart  chan struct{} // a simulated update: reconnect (update.go)
	version  string        // after a simulated update ("" = --agent-version)
	keyed    bool          // the last install gave it the key
}

// sample takes the current report (and remembers its series).
func (a *simAgent) sample(t time.Time) *proto.Report {
	a.mu.Lock()
	a.seq++
	seq := a.seq
	a.mu.Unlock()
	a.unraidTick()   // blackbox's tasks end with the clock (unraid.go)
	a.packagesTick() // so do the package tasks (packages.go)
	r := a.host.Report(t, seq, a.agentVersion())
	a.patchReport(r)
	a.patchLibvirt(r) // kvm-lab (libvirt.go)
	return r
}

func (a *simAgent) run(ctx context.Context) {
	a.early = make(chan struct{}, 1)
	a.mu.Lock()
	a.restart = make(chan struct{}, 1)
	a.mu.Unlock()
	backoff := time.Second
	historyMarker := filepath.Join(hostDir(a.o, a.host), "history-sent")
	if _, err := os.Stat(historyMarker); err != nil && a.o.history > 0 {
		a.mu.Lock()
		for t := time.Now().Add(-a.o.history).Truncate(10 * time.Second); t.Before(time.Now()); t = t.Add(10 * time.Second) {
			r := a.host.Report(t, 0, simVersion)
			a.buffer = append(a.buffer, proto.Sample{At: t, Values: r.Series()})
		}
		a.mu.Unlock()
	}
	// Collector loop: samples go to the buffer while disconnected.
	nextDrop := time.Now().Add(a.o.bfEvery)
	for {
		if ctx.Err() != nil {
			return
		}
		if a.offlineForGood() {
			log.Info("going offline for good (simulated outage)", "host", a.host.ID)
			<-ctx.Done()
			return
		}
		err := a.session(ctx, &nextDrop, historyMarker)
		if ctx.Err() != nil {
			return
		}
		var gap time.Duration
		var dropErr dropError
		if errors.As(err, &dropErr) {
			gap = a.o.bfGap
			log.Info("backfill test: hub unreachable", "host", a.host.ID, "for", gap)
			backoff = time.Second
		} else {
			log.Warn("disconnected", "host", a.host.ID, "err", err)
			gap = backoff + time.Duration(rand.Int64N(int64(backoff/2+1)))
			backoff = min(backoff*2, time.Minute)
		}
		// Keep sampling while offline.
		deadline := time.Now().Add(gap)
		for time.Now().Before(deadline) {
			select {
			case <-ctx.Done():
				return
			case <-time.After(min(a.o.interval, time.Until(deadline))):
			}
			r := a.sample(time.Now())
			a.mu.Lock()
			a.buffer = append(a.buffer, proto.Sample{At: r.At, Values: r.Series()})
			if len(a.buffer) > 9000 {
				a.buffer = a.buffer[len(a.buffer)-9000:]
			}
			a.mu.Unlock()
		}
	}
}

func (a *simAgent) offlineForGood() bool {
	return a.host.OfflineAfter > 0 && a.o.offlineAfter > 0 && time.Since(a.start) >= a.o.offlineAfter
}

type dropError struct{}

func (dropError) Error() string { return "simulated outage" }

// session runs one connection until it fails, returns nil when it ended
// cleanly after having sent the history.
func (a *simAgent) session(ctx context.Context, nextDrop *time.Time, historyMarker string) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	tlsCfg := pinnedTLS(a.o.pin, a.id.caPool, &a.id.cert)
	hc := &http.Client{Transport: &http.Transport{TLSClientConfig: tlsCfg}}
	c, resp, err := websocket.Dial(ctx, a.o.agentURL+"/agent/v1/connect", &websocket.DialOptions{
		HTTPClient: hc, Subprotocols: []string{"rackoon.agent.v1"},
	})
	if err != nil {
		if resp != nil && resp.StatusCode == http.StatusForbidden {
			return errors.New("hub refused the certificate (server deleted?)")
		}
		return err
	}
	nc := websocket.NetConn(ctx, c, websocket.MessageBinary)
	sess, err := yamux.Client(nc, wire.YamuxConfig())
	if err != nil {
		nc.Close()
		return err
	}
	defer sess.Close()
	ctrl, err := sess.OpenStream()
	if err != nil {
		return err
	}
	var wmu sync.Mutex
	send := func(typ string, body any) error {
		wmu.Lock()
		defer wmu.Unlock()
		_ = ctrl.SetWriteDeadline(time.Now().Add(30 * time.Second))
		return wire.SendEnvelope(ctrl, typ, body)
	}
	if err := wire.WriteMsg(ctrl, proto.StreamHeader{Kind: proto.StreamControl}); err != nil {
		return err
	}
	a.mu.Lock()
	buffered := len(a.buffer)
	a.mu.Unlock()
	r0 := a.host.Report(time.Now(), 0, a.agentVersion())
	if err := send(proto.MsgHello, proto.Hello{ProtocolVersion: proto.Version, AgentVersion: a.agentVersion(),
		MachineID: r0.Host.MachineID, Hostname: a.host.ID, Clock: time.Now().UTC(), BufferedSamples: buffered}); err != nil {
		return err
	}
	var env proto.Envelope
	_ = ctrl.SetReadDeadline(time.Now().Add(30 * time.Second))
	if err := wire.ReadMsg(ctrl, &env); err != nil {
		return err
	}
	var ack proto.HelloAck
	if env.Type != proto.MsgHelloAck || wire.Unmarshal(env.Body, &ack) != nil {
		return errors.New("bad hello_ack")
	}
	if ack.Rejected != "" {
		return errors.New("rejected: " + ack.Rejected)
	}
	_ = ctrl.SetReadDeadline(time.Time{})
	log.Info("connected", "host", a.host.ID, "server_id", ack.ServerID, "backfill", buffered)

	// Backfill, oldest first, at most 500 samples per message. With
	// --backfill-test the last samples sent before the outage are repeated
	// (the hub must ignore them).
	a.mu.Lock()
	samples := append(append([]proto.Sample{}, a.lastSent...), a.buffer...)
	a.buffer = nil
	a.mu.Unlock()
	if !a.o.backfillTest {
		samples = samples[len(a.lastSent):]
	}
	for len(samples) > 0 {
		n := min(500, len(samples))
		if err := send(proto.MsgBackfill, proto.Backfill{Samples: samples[:n]}); err != nil {
			a.mu.Lock()
			a.buffer = append(samples, a.buffer...)
			a.mu.Unlock()
			return err
		}
		samples = samples[n:]
	}
	if a.o.history > 0 {
		_ = os.WriteFile(historyMarker, []byte(time.Now().UTC().Format(time.RFC3339)), 0o600)
	}

	errc := make(chan error, 2)
	// Hub-opened streams.
	go func() {
		for {
			st, err := sess.AcceptStream()
			if err != nil {
				errc <- err
				return
			}
			go a.handleStream(ctx, st, send)
		}
	}()
	// Control reader: answer pings.
	go func() {
		for {
			var env proto.Envelope
			if err := wire.ReadMsg(ctrl, &env); err != nil {
				errc <- err
				return
			}
			if env.Type == proto.MsgPing {
				wmu.Lock()
				_ = wire.WriteMsg(ctrl, proto.Envelope{Type: proto.MsgPong, Body: env.Body})
				wmu.Unlock()
			}
		}
	}()
	report := func() error {
		r := a.sample(time.Now())
		if err := send(proto.MsgReport, r); err != nil {
			a.mu.Lock()
			a.buffer = append(a.buffer, proto.Sample{At: r.At, Values: r.Series()})
			a.mu.Unlock()
			return err
		}
		a.mu.Lock()
		a.lastSent = append(a.lastSent, proto.Sample{At: r.At, Values: r.Series()})
		if len(a.lastSent) > 3 {
			a.lastSent = a.lastSent[len(a.lastSent)-3:]
		}
		a.mu.Unlock()
		return nil
	}
	if err := report(); err != nil {
		return err
	}
	tick := time.NewTicker(a.o.interval)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case err := <-errc:
			if errors.Is(err, yamux.ErrSessionShutdown) || errors.Is(err, net.ErrClosed) {
				return errors.New("connection closed by the hub")
			}
			return err
		case <-a.restart:
			return errors.New("restarting on the new version")
		case <-a.early:
			if err := report(); err != nil {
				return err
			}
		case <-tick.C:
			if a.offlineForGood() {
				return nil
			}
			if a.o.backfillTest && time.Now().After(*nextDrop) {
				*nextDrop = time.Now().Add(a.o.bfEvery)
				return dropError{}
			}
			if err := report(); err != nil {
				return err
			}
		}
	}
}

// handleStream answers a hub-opened stream.
func (a *simAgent) handleStream(ctx context.Context, st *yamux.Stream, send func(string, any) error) {
	defer st.Close()
	_ = st.SetReadDeadline(time.Now().Add(30 * time.Second))
	var hdr proto.StreamHeader
	if err := wire.ReadMsg(st, &hdr); err != nil {
		return
	}
	switch hdr.Kind {
	case proto.StreamAction:
		var req proto.ActionRequest
		if wire.ReadMsg(st, &req) != nil {
			return
		}
		resp := a.action(req)
		_ = wire.WriteMsg(st, resp)
		if resp.OK && !resp.Noop {
			_ = send(proto.MsgEvent, proto.Event{At: time.Now().UTC(), Kind: "guest.state_changed", Platform: req.Platform,
				GuestID: req.GuestID, State: resp.State})
			select {
			case a.early <- struct{}{}:
			default:
			}
		}
	case proto.StreamInspect:
		var req proto.InspectRequest
		if wire.ReadMsg(st, &req) != nil {
			return
		}
		_ = wire.WriteMsg(st, a.inspect(req))
	case proto.StreamManage:
		var req proto.ManageRequest
		if wire.ReadMsg(st, &req) != nil {
			return
		}
		_ = wire.WriteMsg(st, a.manage(req))
	case proto.StreamThumbnail:
		var req proto.ThumbnailRequest
		if wire.ReadMsg(st, &req) != nil {
			return
		}
		_ = wire.WriteMsg(st, a.thumbnail(req))
	case proto.StreamDiagnose:
		var req proto.DiagnoseRequest
		if wire.ReadMsg(st, &req) != nil {
			return
		}
		_ = wire.WriteMsg(st, a.diagnose(req))
	case proto.StreamExec:
		var req proto.ExecRequest
		if wire.ReadMsg(st, &req) != nil {
			return
		}
		_ = wire.WriteMsg(st, a.exec(req))
	case proto.StreamUpdate:
		a.update(st)
	case proto.StreamConsole:
		var req proto.ConsoleRequest
		if wire.ReadMsg(st, &req) != nil {
			return
		}
		_ = st.SetReadDeadline(time.Time{})
		a.console(ctx, st, req)
	}
}

func (a *simAgent) action(req proto.ActionRequest) proto.ActionResponse {
	if resp, ok := a.remoteAction(req); ok {
		return resp
	}
	g, ok := a.host.FindGuest(req.Platform, req.GuestID)
	if !ok {
		return proto.ActionResponse{Code: "guest_not_found", Message: "No such guest on this host."}
	}
	if req.Action == proto.ActionCtrlAltDel {
		if !a.host.Policy.Console {
			return proto.ActionResponse{Code: "remote_control_disabled", Message: "Console is disabled in agent.toml."}
		}
		return proto.ActionResponse{OK: true, State: g.State}
	}
	if !a.host.Policy.Power {
		return proto.ActionResponse{Code: "remote_control_disabled", Message: "Power actions are disabled in agent.toml."}
	}
	time.Sleep(time.Duration(500+rand.IntN(1500)) * time.Millisecond)
	switch req.Action {
	case proto.ActionStart:
		if g.State != proto.StateStopped {
			return proto.ActionResponse{OK: true, Noop: true, State: g.State}
		}
		a.host.SetGuestState(req.Platform, req.GuestID, proto.StateRunning)
		return proto.ActionResponse{OK: true, State: proto.StateRunning, Message: "Started."}
	case proto.ActionShutdown, proto.ActionStop, proto.ActionForceStop:
		if g.State == proto.StateStopped {
			return proto.ActionResponse{OK: true, Noop: true, State: g.State}
		}
		a.host.SetGuestState(req.Platform, req.GuestID, proto.StateStopped)
		return proto.ActionResponse{OK: true, State: proto.StateStopped, Message: "Stopped."}
	case proto.ActionReboot, proto.ActionRestart:
		if g.State == proto.StateStopped {
			return proto.ActionResponse{Code: "guest_not_running", Message: "The guest is not running.", State: g.State}
		}
		return proto.ActionResponse{OK: true, State: proto.StateRunning, Message: "Restarted."}
	}
	return proto.ActionResponse{Code: "unsupported", Message: "Unknown action."}
}
