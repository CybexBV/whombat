package main

import (
	"io"
	"log/slog"
	"net"
	"testing"
	"time"

	"github.com/hashicorp/yamux"

	"rackoon/internal/hub/fakefleet"
	"rackoon/internal/proto"
	"rackoon/internal/wire"
)

func TestSimAgentUpdate(t *testing.T) {
	simRestartDelay = time.Millisecond
	if log == nil {
		log = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	o := options{updateKey: "k1", keyless: map[string]bool{"onyx": true}, updateOff: map[string]bool{}, agentVersion: "0.0.0-20261018094703.5394c53", hostShell: true}
	fleet := fakefleet.Fleet()
	keyed := &simAgent{o: o, host: fleet[0], restart: make(chan struct{}, 1)}
	var onyx *simAgent
	for _, h := range fleet {
		if h.ID == "onyx" {
			onyx = &simAgent{o: o, host: h, restart: make(chan struct{}, 1)}
		}
	}
	r := keyed.sample(time.Now())
	if r.Agent.Version != o.agentVersion || r.Agent.UpdateKey != "k1" || !r.Policy.Update || r.Agent.Install != "systemd" {
		t.Fatalf("keyed report %+v %+v", r.Agent, r.Policy)
	}
	if r := onyx.sample(time.Now()); r.Agent.UpdateKey != "" || r.Policy.Update {
		t.Fatalf("keyless report %+v", r.Agent)
	}

	send := func(a *simAgent, version string) proto.UpdateResponse {
		c1, c2 := pipeSessions(t)
		go func() {
			st, _ := c2.AcceptStream()
			a.update(st)
		}()
		st, _ := c1.OpenStream()
		wire.WriteMsg(st, proto.UpdateRequest{Version: version, Arch: "amd64", Size: 4})
		wire.WriteMsg(st, proto.UpdateChunk{Data: []byte("abcd")})
		var resp proto.UpdateResponse
		if err := wire.ReadMsg(st, &resp); err != nil {
			t.Fatal(err)
		}
		return resp
	}
	if r := send(keyed, "0.0.0-20261017000000.0000000"); r.Code != "older_version" {
		t.Fatalf("older: %+v", r)
	}
	if r := send(onyx, "0.0.0-20261020101500.abc1234"); r.Code != "update_disabled" {
		t.Fatalf("keyless: %+v", r)
	}
	if r := send(keyed, "0.0.0-20261020101500.abc1234"); !r.OK {
		t.Fatalf("update: %+v", r)
	}
	<-keyed.restart
	if v := keyed.agentVersion(); v != "0.0.0-20261020101500.abc1234" {
		t.Fatalf("version after the update %q", v)
	}

	// The last install gives onyx the key.
	resp := onyx.exec(proto.ExecRequest{Command: `systemd-run … /bin/sh -c 'echo "whombat-agent: last install of 0.0.0-20261020101500.abc1234"; curl -fsSL https://h:8443/install.sh | sh'`})
	if resp.Output != "whombat-agent-install: started\n" {
		t.Fatalf("exec %+v", resp)
	}
	<-onyx.restart
	if r := onyx.sample(time.Now()); r.Agent.UpdateKey != "k1" || r.Agent.Version != "0.0.0-20261020101500.abc1234" {
		t.Fatalf("after the last install %+v", r.Agent)
	}
}

func pipeSessions(t *testing.T) (*yamux.Session, *yamux.Session) {
	t.Helper()
	a, b := net.Pipe()
	c1, err := yamux.Client(a, wire.YamuxConfig())
	if err != nil {
		t.Fatal(err)
	}
	c2, err := yamux.Server(b, wire.YamuxConfig())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c1.Close(); c2.Close() })
	return c1, c2
}
