package hub

import (
	"context"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"rackoon/internal/agent"
	"rackoon/internal/netaddrs"
	"rackoon/internal/proto"
)

// moveCollector reports a fixed host.
type moveCollector struct{ host string }

func (c moveCollector) Collect(context.Context) (*proto.Report, error) {
	return &proto.Report{At: time.Now().UTC(), Host: proto.HostInfo{Hostname: c.host}}, nil
}

func (moveCollector) Events() <-chan proto.Event { return nil }

// The box moves from its cable (10.100.1.81, served on 127.0.0.1) to Wi-Fi
// (10.100.1.97, served on 127.0.0.2): a real agent connected through the
// cable's address is asked to move, connects to the other one, saves it in
// agent.toml and drops the old connection.
func TestRealAgentMovesToTheOtherAddress(t *testing.T) {
	ln1, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := ln1.Addr().(*net.TCPAddr).Port
	ln2, err := net.Listen("tcp", fmt.Sprintf("127.0.0.2:%d", port))
	if err != nil {
		ln1.Close()
		t.Skipf("cannot listen on 127.0.0.2:%d: %v", port, err)
	}
	cable, wifi := fmt.Sprintf("wss://10.100.1.81:%d", port), fmt.Sprintf("wss://10.100.1.97:%d", port)
	pfx := netip.MustParsePrefix
	e := headlessEnv(t, func(c *Config) {
		c.AgentURL, c.AgentListen = cable, fmt.Sprintf(":%d", port)
		c.Interfaces = func() ([]netaddrs.Interface, error) {
			return []netaddrs.Interface{
				{Name: "enp1s0", Up: true, Prefixes: []netip.Prefix{pfx("10.100.1.81/24")}},
				{Name: "wlan0", Up: true, Prefixes: []netip.Prefix{pfx("10.100.1.97/24")}},
			}, nil
		}
	})
	for _, ln := range []net.Listener{ln1, ln2} {
		s := httptest.NewUnstartedServer(e.h.AgentHandler())
		s.Listener.Close()
		s.Listener = ln
		s.TLS = e.h.AgentTLSConfig()
		s.StartTLS()
		t.Cleanup(func() { s.CloseClientConnections(); s.Close() })
	}
	svc := e.service("pe_1|John")
	fa := e.enroll(svc, "basalt", "")

	// The agent's files, as enrollment leaves them, pointing at the cable.
	dir := t.TempDir()
	kb, err := x509.MarshalPKCS8PrivateKey(fa.key)
	if err != nil {
		t.Fatal(err)
	}
	toml := fmt.Sprintf("# the owner's comment stays\nhub = %q\nca_sha256 = %q\nstate_dir = %q\n\n[remote_control]\nconsole = true\n",
		cable, e.h.CAPin(), filepath.Join(dir, "state"))
	for name, b := range map[string][]byte{
		"agent.key": pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: kb}), "agent.crt": fa.certPEM,
		"ca.crt": e.h.ca.CertPEM, agent.ConfigFileName: []byte(toml),
	} {
		if err := os.WriteFile(filepath.Join(dir, name), b, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	cfg, err := agent.LoadConfig(dir)
	if err != nil {
		t.Fatal(err)
	}
	rt := agent.NewRuntime(cfg, "0.0.0-test", slog.New(slog.NewTextHandler(io.Discard, nil)))
	rt.Collector = moveCollector{host: "basalt"}
	rt.ReportInterval = 100 * time.Millisecond
	rt.BackoffMin, rt.BackoffMax = 20*time.Millisecond, 100*time.Millisecond
	rt.Interfaces = func() ([]netaddrs.Interface, error) { return nil, nil }
	// The box's two addresses in this test: the cable's is 127.0.0.1, the
	// Wi-Fi's 127.0.0.2; nothing else is reachable.
	route := map[string]string{
		fmt.Sprintf("10.100.1.81:%d", port): ln1.Addr().String(),
		fmt.Sprintf("10.100.1.97:%d", port): ln2.Addr().String(),
	}
	rt.DialContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
		to, ok := route[addr]
		if !ok {
			return nil, errors.New("not in this test: " + addr)
		}
		var d net.Dialer
		return d.DialContext(ctx, network, to)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { _ = rt.Run(ctx); close(done) }()
	t.Cleanup(func() {
		cancel()
		select {
		case <-done:
		case <-time.After(10 * time.Second):
			t.Error("the agent did not stop")
		}
	})

	via := func() string {
		var list []map[string]any
		svc.json(http.MethodGet, "/api/v1/agents", nil, 200, &list)
		for _, it := range list {
			if it["server_id"] == fa.id {
				v, _ := it["via"].(string)
				return v
			}
		}
		return ""
	}
	waitFor(t, "the agent on the cable's address", 10*time.Second, func() bool { return via() == "127.0.0.1" })

	var out struct{ Asked, Already int }
	svc.json(http.MethodPost, "/api/v1/hub/agents/move", map[string]string{"url": wifi}, 200, &out)
	if out.Asked != 1 || out.Already != 0 {
		t.Fatalf("move = %+v", out)
	}
	waitFor(t, "the agent on the Wi-Fi's address", 10*time.Second, func() bool { return via() == "127.0.0.2" })
	if got := rt.Config().Hub; got != wifi {
		t.Fatalf("hub = %s", got)
	}
	// The agent saves the new address beside its reconnect, not before it.
	var b []byte
	waitFor(t, "agent.toml with the Wi-Fi's address", 10*time.Second, func() bool {
		b, err = os.ReadFile(filepath.Join(dir, agent.ConfigFileName))
		return err == nil && strings.Contains(string(b), fmt.Sprintf("hub = %q", wifi))
	})
	if !strings.Contains(string(b), "# the owner's comment stays") {
		t.Fatalf("agent.toml = %s %v", b, err)
	}
	// One connection: the old one is gone, and the hold ends once the agent
	// is back.
	waitFor(t, "the hold to end", 5*time.Second, func() bool { return hubInfo(t, svc)["reconnecting"] == nil })
	if hub := hubInfo(t, svc); hub["agents_connected"] != 1.0 {
		t.Fatalf("agents_connected = %v", hub["agents_connected"])
	}
	// Asked again: it is there already.
	svc.json(http.MethodPost, "/api/v1/hub/agents/move", map[string]string{"url": wifi}, 200, &out)
	if out.Asked != 0 || out.Already != 1 {
		t.Fatalf("second move = %+v", out)
	}
}
