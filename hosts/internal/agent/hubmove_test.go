package agent

import (
	"context"
	"net"
	"sync/atomic"
	"testing"
	"time"

	"rackoon/internal/proto"
)

// The hub asks the agent to move to its other address: it connects there,
// saves it and drops the old connection; the same address again does
// nothing.
func TestAgentMovesWhenAsked(t *testing.T) {
	h := newFakeHub(t)
	cfg := enrollAgent(t, h)
	second := h.listenAlso(t, "127.0.0.2:0")
	tr := startRuntime(t, cfg, nil)
	recv(t, h.hellos, "hello")
	old := h.waitSide(t)
	if err := old.send(proto.MsgHubMove, proto.HubMove{URL: second}); err != nil {
		t.Fatal(err)
	}
	recv(t, h.hellos, "hello at the new address")
	waitUntil(t, "the old connection closed", func() bool { return old.sess.IsClosed() })
	if got := tr.rt.Config().Hub; got != second {
		t.Fatalf("hub = %s", got)
	}
	if c, err := LoadConfig(cfg.Dir); err != nil || c.Hub != second {
		t.Fatalf("agent.toml hub = %q %v", c.Hub, err)
	}
	cur := h.waitSide(t)
	drain(h.reports)
	recv(t, h.reports, "a report on the new connection")
	// Asked again for the address it uses: nothing happens.
	n := h.connects.Load()
	if err := cur.send(proto.MsgHubMove, proto.HubMove{URL: second}); err != nil {
		t.Fatal(err)
	}
	drain(h.reports)
	recv(t, h.reports, "a report after the repeat")
	if h.connects.Load() != n || cur.sess.IsClosed() {
		t.Fatal("the agent reconnected for the address it uses")
	}
}

// A move that fails keeps the old connection and the saved address.
func TestAgentStaysWhenTheMoveFails(t *testing.T) {
	h := newFakeHub(t)
	cfg := enrollAgent(t, h)
	saved := cfg.Hub
	second := h.listenAlso(t, "127.0.0.2:0")
	var dials atomic.Int32
	tr := startRuntime(t, cfg, func(rt *Runtime) {
		rt.DialContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
			dials.Add(1)
			var d net.Dialer
			return d.DialContext(ctx, network, addr)
		}
	})
	recv(t, h.hellos, "hello")
	side := h.waitSide(t)
	for _, tc := range []struct {
		name string
		url  string
		hub  func()
	}{
		{"nothing listens", "wss://127.0.0.1:1", func() {}},
		{"the hub refuses the hello", second, func() { h.mu.Lock(); h.rejected = "certificate revoked"; h.mu.Unlock() }},
		{"not a hub address", "https://127.0.0.2:8443", func() {}},
	} {
		tc.hub()
		before := dials.Load()
		if err := side.send(proto.MsgHubMove, proto.HubMove{URL: tc.url}); err != nil {
			t.Fatal(err)
		}
		if tc.name != "not a hub address" {
			waitUntil(t, tc.name+": the dial", func() bool { return dials.Load() > before })
		}
		waitUntil(t, tc.name+": the move to end", func() bool {
			tr.rt.moveMu.Lock()
			defer tr.rt.moveMu.Unlock()
			return tr.rt.move.done == nil && tr.rt.move.moved == nil
		})
		drain(h.reports)
		recv(t, h.reports, tc.name+": a report on the old connection")
		if side.sess.IsClosed() || tr.rt.Config().Hub != saved {
			t.Fatalf("%s: moved (hub %s)", tc.name, tr.rt.Config().Hub)
		}
		if c, _ := LoadConfig(cfg.Dir); c.Hub != saved {
			t.Fatalf("%s: agent.toml hub = %q", tc.name, c.Hub)
		}
	}
}

func drain[T any](ch <-chan T) {
	for {
		select {
		case <-ch:
		case <-time.After(20 * time.Millisecond):
			return
		}
	}
}
