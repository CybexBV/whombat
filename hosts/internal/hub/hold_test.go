package hub

import (
	"context"
	"net"
	"net/http"
	"sync"
	"testing"
	"time"

	"rackoon/internal/proto"
	"rackoon/internal/wire"
)

func TestHoldManyDropped(t *testing.T) {
	t0 := time.Date(2026, 11, 3, 10, 0, 0, 0, time.UTC)
	var r reconnectHold
	// Two of two: too few to say anything about the hub.
	if r.noteDrop("a", t0, []string{"b"}) || r.noteDrop("b", t0.Add(time.Second), nil) {
		t.Fatal("two agents dropping opened a hold")
	}
	// Six connected, drops 31 s apart don't add up.
	r = reconnectHold{}
	six := []string{"a", "b", "c", "d", "e", "f"}
	for i, id := range six[:4] {
		if r.noteDrop(id, t0.Add(time.Duration(i)*31*time.Second), six[i+1:]) {
			t.Fatalf("drop %d of spread-out drops opened a hold", i)
		}
	}
	// Four of six within 30 s.
	r = reconnectHold{}
	for i, id := range six[:4] {
		got := r.noteDrop(id, t0.Add(time.Duration(i)*5*time.Second), six[i+1:])
		if got != (i == 3) {
			t.Fatalf("drop %d: trigger %v", i, got)
		}
	}
}

func TestHoldWindow(t *testing.T) {
	t0 := time.Date(2026, 11, 3, 10, 0, 0, 0, time.UTC)
	hold, max := 5*time.Minute, 15*time.Minute
	var r reconnectHold
	r.noteDrop("old", t0.Add(-time.Minute), []string{"a", "b"}) // before the window
	r.noteDrop("c", t0.Add(-10*time.Second), []string{"a", "b"})
	if !r.trigger(holdManyDropped, t0, hold, max, []string{"a", "b"}, nil) {
		t.Fatal("no hold opened")
	}
	for id, want := range map[string]bool{"a": true, "b": true, "c": true, "old": false, "new": false} {
		if got := r.covers(id, t0.Add(time.Minute)); got != want {
			t.Errorf("covers(%s) = %v", id, got)
		}
	}
	// A server dropping inside the hold is covered too.
	r.noteDrop("d", t0.Add(2*time.Minute), nil)
	if !r.covers("d", t0.Add(2*time.Minute)) {
		t.Error("a drop inside the hold is not covered")
	}
	// A new trigger extends it, never beyond 15 minutes; the reason stays.
	if r.trigger(holdAddressChanged, t0.Add(4*time.Minute), hold, max, nil, nil) {
		t.Fatal("a trigger inside the hold opened another")
	}
	if !r.covers("a", t0.Add(8*time.Minute)) {
		t.Error("not extended")
	}
	r.trigger(holdAddressChanged, t0.Add(8*time.Minute), hold, max, nil, nil)
	r.trigger(holdAddressChanged, t0.Add(12*time.Minute), hold, max, nil, nil)
	conns := map[string]holdConn{"a": {}, "b": {}, "c": {}, "d": {}}
	v, ok := r.view(t0.Add(13*time.Minute), conns)
	if !ok || !v.Until.Equal(t0.Add(max)) || v.Reason != holdManyDropped || !v.Since.Equal(t0) || v.Waiting != 4 {
		t.Fatalf("view = %+v %v", v, ok)
	}
	if r.covers("a", t0.Add(max)) {
		t.Error("covered after the hold")
	}
	if !r.settle(t0.Add(max), conns) {
		t.Error("not ended at its end")
	}
	if _, ok := r.view(t0.Add(max), conns); ok {
		t.Error("still shown")
	}
}

func TestHoldEndsWhenEveryoneIsBack(t *testing.T) {
	t0 := time.Date(2026, 11, 3, 10, 0, 0, 0, time.UTC)
	var r reconnectHold
	// a and b were asked to move, c only connected.
	r.trigger(holdMove, t0, 5*time.Minute, 15*time.Minute, []string{"a", "b", "c"}, []string{"a", "b"})
	old := holdConn{connected: true, connectedAt: t0.Add(-time.Hour)}
	moved := holdConn{connected: true, connectedAt: t0.Add(5 * time.Second)}
	conns := map[string]holdConn{"a": moved, "b": old, "c": old}
	if r.settle(t0.Add(10*time.Second), conns) {
		t.Fatal("ended while b hadn't moved")
	}
	if v, _ := r.view(t0.Add(10*time.Second), conns); v.Waiting != 1 {
		t.Fatalf("waiting = %d", v.Waiting)
	}
	conns["b"] = moved
	if !r.settle(t0.Add(11*time.Second), conns) || r.covers("a", t0.Add(12*time.Second)) {
		t.Fatal("not ended once everyone was back")
	}
	// A dropped server is back with any connection.
	r.noteDrop("x", t0.Add(time.Minute), []string{"y", "z"})
	r.trigger(holdManyDropped, t0.Add(time.Minute), 5*time.Minute, 15*time.Minute, []string{"y", "z"}, nil)
	conns = map[string]holdConn{"x": {}, "y": old, "z": old}
	if r.settle(t0.Add(2*time.Minute), conns) {
		t.Fatal("ended while x was away")
	}
	conns["x"] = old
	if !r.settle(t0.Add(2*time.Minute), conns) {
		t.Fatal("not ended once x was back")
	}
}

func TestURLAddr(t *testing.T) {
	for in, want := range map[string]string{
		"wss://10.100.1.97:8443": "10.100.1.97:8443",
		"wss://[fd00::5]:8443":   "[fd00::5]:8443",
		"wss://10.100.1.97":      "10.100.1.97:443",
		"wss://hosts.example:84": "",
		"https://10.100.1.97:84": "",
	} {
		ap, ok := urlAddr(in)
		if got := ""; ok {
			got = ap.String()
			if got != want {
				t.Errorf("%s: %s, want %s", in, got, want)
			}
		} else if want != "" {
			t.Errorf("%s: not parsed", in)
		}
	}
}

// connectAll enrolls and connects fake agents with a first report.
func connectAll(t *testing.T, e *env, admin *client, names ...string) []*fakeAgent {
	t.Helper()
	var out []*fakeAgent
	for _, n := range names {
		a := e.enroll(admin, n, "")
		if code, err := a.dial(proto.Hello{MachineID: "m-" + n}); code != 101 {
			t.Fatal(code, err)
		}
		a.registered(t)
		a.send(proto.MsgReport, a.report(n))
		out = append(out, a)
	}
	return out
}

// registered waits until the hub counts the agent as connected. The hub
// answers the hello first and registers the connection after, so right after
// dial a look at the connected agents may miss this one (TestMoveAgents asked
// one agent of two to move on a busy machine). Its checks are the first thing
// the hub sends a registered connection.
func (a *fakeAgent) registered(t *testing.T) {
	t.Helper()
	waitFor(t, "the hub to register "+a.id, 10*time.Second, func() bool {
		a.mu.Lock()
		defer a.mu.Unlock()
		return len(a.checks) > 0
	})
}

func openAlerts(t *testing.T, admin *client) []string {
	t.Helper()
	var f struct {
		Alerts []struct{ Server, Rule string }
	}
	admin.json(http.MethodGet, "/api/v1/fleet", nil, 200, &f)
	var out []string
	for _, a := range f.Alerts {
		if a.Rule == "agent.heartbeat_missing" {
			out = append(out, a.Server)
		}
	}
	return out
}

func TestMassDropHoldsHeartbeatAlerts(t *testing.T) {
	e, admin := adminEnv(t, func(c *Config) {
		c.HeartbeatTimeout = 300 * time.Millisecond
		c.ReconnectHold = 5 * time.Second
	})
	agents := connectAll(t, e, admin, "basalt", "granite", "obsidian")
	for _, a := range agents {
		a.sess.Close()
	}
	var hub map[string]any
	var rc map[string]any
	waitFor(t, "the hold for all three", 5*time.Second, func() bool {
		admin.json(http.MethodGet, "/api/v1/hub", nil, 200, &hub)
		rc, _ = hub["reconnecting"].(map[string]any)
		return rc != nil && rc["waiting"] == 3.0
	})
	if rc["reason"] != holdManyDropped {
		t.Fatalf("reconnecting = %v", rc)
	}
	until, err := time.Parse(time.RFC3339, rc["until"].(string))
	if err != nil {
		t.Fatal(err)
	}
	// Offline (the page shows the truth), but no alert yet.
	waitFor(t, "offline", 5*time.Second, func() bool {
		var f struct{ Servers []struct{ Status string } }
		admin.json(http.MethodGet, "/api/v1/fleet", nil, 200, &f)
		for _, s := range f.Servers {
			if s.Status != "offline" {
				return false
			}
		}
		return true
	})
	if got := openAlerts(t, admin); len(got) != 0 {
		t.Fatalf("alerts inside the hold: %v", got)
	}
	// After it, every server still away gets its alert.
	waitFor(t, "alerts after the hold", 12*time.Second, func() bool { return len(openAlerts(t, admin)) == 3 })
	if time.Now().Before(until.Add(-time.Second)) {
		t.Errorf("alerts opened before the hold's end %s", until)
	}
	admin.json(http.MethodGet, "/api/v1/hub", nil, 200, &hub)
	if hub["reconnecting"] != nil {
		t.Errorf("still reconnecting: %v", hub["reconnecting"])
	}
	if recs := e.audit("hub.reconnecting"); len(recs) != 1 || recs[0].Details["reason"] != holdManyDropped {
		t.Errorf("audit = %+v", recs)
	}
}

func TestAddressChangeHoldsAgentsOnTheGoneAddress(t *testing.T) {
	ctx := context.Background()
	e, admin := adminEnv(t, nil)
	agents := connectAll(t, e, admin, "basalt", "granite")
	// An address that only appears changes nothing.
	e.h.addrsChanged(ctx, []string{"wss://10.100.1.81:8443"}, []string{"wss://10.100.1.81:8443", "wss://10.100.1.97:8443"})
	if e.h.reconnectingJSON() != nil {
		t.Fatal("an added address opened a hold")
	}
	// The address both agents came in on (127.0.0.1) is gone.
	_, p, _ := net.SplitHostPort(e.agent.Listener.Addr().String())
	e.h.addrsChanged(ctx, []string{"wss://127.0.0.1:" + p, "wss://10.100.1.97:8443"}, []string{"wss://10.100.1.97:8443"})
	rc, _ := e.h.reconnectingJSON().(map[string]any)
	if rc == nil || rc["reason"] != holdAddressChanged || rc["waiting"] != 2 {
		t.Fatalf("reconnecting = %v", rc)
	}
	// They reconnect: the hold ends.
	for i, a := range agents {
		a.sess.Close()
		if code, err := a.dial(proto.Hello{MachineID: "m-" + []string{"basalt", "granite"}[i]}); code != 101 {
			t.Fatal(code, err)
		}
	}
	waitFor(t, "the hold to end", 5*time.Second, func() bool { return e.h.reconnectingJSON() == nil })
}

func TestAlertOfAServerBackInsideAHoldCloses(t *testing.T) {
	e, admin := adminEnv(t, func(c *Config) {
		c.HeartbeatTimeout = time.Second
		c.ReconnectHold = 30 * time.Second
	})
	agents := connectAll(t, e, admin, "basalt", "granite", "obsidian", "quartz", "shale", "marble")
	// The agents that are up check in every 200 ms.
	var mu sync.Mutex
	up := map[*fakeAgent]bool{}
	for _, a := range agents {
		up[a] = true
	}
	stop := make(chan struct{})
	defer close(stop)
	go func() {
		tk := time.NewTicker(200 * time.Millisecond)
		defer tk.Stop()
		for {
			select {
			case <-stop:
				return
			case <-tk.C:
			}
			mu.Lock()
			for a, ok := range up {
				if ok {
					a.wmu.Lock()
					_ = wire.SendEnvelope(a.ctrl, proto.MsgPing, map[string]any{})
					a.wmu.Unlock()
				}
			}
			mu.Unlock()
		}
	}()
	quiet := func(as ...*fakeAgent) {
		mu.Lock()
		defer mu.Unlock()
		for _, a := range as {
			up[a] = false
			a.sess.Close()
		}
	}
	// One server goes quiet on its own: its alert opens.
	quiet(agents[0])
	waitFor(t, "basalt's alert", 8*time.Second, func() bool {
		got := openAlerts(t, admin)
		return len(got) == 1
	})
	// Then most of the others drop at once: the hub holds their alerts.
	quiet(agents[1:5]...)
	waitFor(t, "the hold", 5*time.Second, func() bool { return hubInfo(t, admin)["reconnecting"] != nil })
	// basalt is back inside the hold: its alert closes now, not when the hold ends.
	mu.Lock()
	if code, err := agents[0].dial(proto.Hello{MachineID: "m-basalt"}); code != 101 {
		mu.Unlock()
		t.Fatal(code, err)
	}
	up[agents[0]] = true
	mu.Unlock()
	agents[0].send(proto.MsgReport, agents[0].report("basalt"))
	waitFor(t, "basalt's alert closed", 8*time.Second, func() bool { return len(openAlerts(t, admin)) == 0 })
	if hubInfo(t, admin)["reconnecting"] == nil {
		t.Fatal("the hold ended before the alert closed")
	}
}
