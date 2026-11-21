package broker_test

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/manager/internal/broker"
	"github.com/CybexBV/whombat/appliance/manager/internal/controlapi"
	"github.com/CybexBV/whombat/appliance/manager/internal/testworld"
	"github.com/CybexBV/whombat/contracts/go/device"
	"github.com/CybexBV/whombat/contracts/go/local"
	"github.com/CybexBV/whombat/contracts/go/protocol"
)

// fakeSupport is control's support.ticket: a ticket living ttl from now, or err.
type fakeSupport struct {
	mu    sync.Mutex
	now   func() time.Time
	ttl   time.Duration
	err   error
	calls int
}

func (f *fakeSupport) SupportTicket(context.Context) (*device.SupportTicketResponse, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	if f.err != nil {
		return nil, f.err
	}
	exp := f.now().Add(f.ttl).Unix()
	return &device.SupportTicketResponse{Ticket: fmt.Sprintf("eyJhbGciOiJFZERTQSJ9.eyJqdGkiOiIlZCJ9.c2ln%d", f.calls), ExpiresAt: exp,
		Channel: protocol.TicketChannelApp, Relay: device.RelayAssignment{Worker: "w1", URL: "wss://relay.dev.whombat.com/v1/connect", ReassignAfter: exp}}, nil
}

func (f *fakeSupport) count() int { f.mu.Lock(); defer f.mu.Unlock(); return f.calls }

// serveSupport starts s on a socket in a short temporary directory (a socket's path is at most 107 bytes).
func serveSupport(t *testing.T, s *broker.Server) *http.Client {
	t.Helper()
	dir, err := os.MkdirTemp("", "sup")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	sock := filepath.Join(dir, "api.sock")
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go s.Listen(ctx, sock)
	for i := 0; i < 100; i++ {
		if _, err := os.Stat(sock); err == nil {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	return client(sock)
}

// MG-118: the support service's ticket — its uid only, `{}` or nothing, reused until a minute before it expires and kept
// apart from the runtime's; control's refusals as for the runtime's tickets.
func TestSupportTicket(t *testing.T) {
	t.Parallel()
	me := uint32(os.Getuid())
	clock := &testworld.Clock{}
	clock.Set(time.Date(2026, 10, 21, 12, 0, 0, 0, time.UTC))
	fs := &fakeSupport{now: clock.Now, ttl: 5 * time.Minute}
	s := &broker.Server{RuntimeUID: me + 1, SupportUIDs: []uint32{me}, Support: fs, Now: clock.Now}
	c := serveSupport(t, s)

	resp, m := post(t, c, local.ManagerPathSupportTicket, ``)
	if resp.StatusCode != 200 || m["ticket"] == nil || m["relay"] == nil || fs.count() != 1 {
		t.Fatalf("%d %v", resp.StatusCode, m)
	}
	first := m["ticket"]
	if _, m = post(t, c, local.ManagerPathSupportTicket, `{}`); m["ticket"] != first || fs.count() != 1 {
		t.Fatalf("not reused: %v (%d calls)", m, fs.count())
	}
	clock.Advance(4*time.Minute + 1*time.Second) // inside the last minute: a new one
	if _, m = post(t, c, local.ManagerPathSupportTicket, `{}`); m["ticket"] == first || fs.count() != 2 {
		t.Fatalf("not renewed: %v (%d calls)", m, fs.count())
	}
	for body, code := range map[string]string{`{"class":"interactive"}`: "bad_request", `[]`: "bad_request", `{}{}`: "bad_request"} {
		if resp, m := post(t, c, local.ManagerPathSupportTicket, body); resp.StatusCode != 400 || m["error"].(map[string]any)["code"] != code {
			t.Errorf("%s: %d %v", body, resp.StatusCode, m)
		}
	}

	// The runtime's uid (and anyone else) may not: the ticket opens the support route.
	other := &broker.Server{RuntimeUID: me, SupportUIDs: []uint32{me + 1}, Support: fs, Now: clock.Now}
	if resp, _ := post(t, serveSupport(t, other), local.ManagerPathSupportTicket, `{}`); resp.StatusCode != 403 {
		t.Fatalf("the runtime got a support ticket: %d", resp.StatusCode)
	}

	// Control's answers (CT-940): unreachable is 503 unavailable; its refusals pass on with their code; anything else (a
	// control before the op) 502 control_refused; a ticket that is about to expire isn't handed on.
	for _, tc := range []struct {
		name   string
		err    error
		ttl    time.Duration
		status int
		code   string
	}{
		{"unreachable", fmt.Errorf("%w: down", controlapi.ErrUnavailable), time.Minute, 503, "unavailable"},
		{"refused", &controlapi.HTTPError{Status: 404, Body: `{"error":{"code":"not_found"}}`}, time.Minute, 502, "control_refused"},
		{"unclaimed", &controlapi.HTTPError{Status: 409, Body: `{"error":{"code":"conflict","details":{"code":"device_unclaimed"}}}`}, time.Minute, 409, "device_unclaimed"},
		{"retired", &controlapi.HTTPError{Status: 403, Body: `{"error":{"code":"device_revoked","details":{"code":"device_retired"}}}`}, time.Minute, 403, "device_revoked"},
		{"too often", fmt.Errorf("%w: %w", controlapi.ErrUnavailable, &controlapi.HTTPError{Status: 429, Body: `{"error":{"code":"rate_limited"}}`}), time.Minute, 429, "rate_limited"},
		{"expiring", nil, 30 * time.Second, 502, "control_refused"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := &fakeSupport{now: clock.Now, ttl: tc.ttl, err: tc.err}
			c := serveSupport(t, &broker.Server{RuntimeUID: me + 1, SupportUIDs: []uint32{me}, Support: f, Now: clock.Now})
			resp, m := post(t, c, local.ManagerPathSupportTicket, `{}`)
			if resp.StatusCode != tc.status || m["error"].(map[string]any)["code"] != tc.code {
				t.Fatalf("%d %v", resp.StatusCode, m)
			}
		})
	}

	// A manager without it answers as one before MG-118.
	if resp, m := post(t, serveSupport(t, &broker.Server{RuntimeUID: me + 1, SupportUIDs: []uint32{me}}), local.ManagerPathSupportTicket, `{}`); resp.StatusCode != 404 ||
		m["error"].(map[string]any)["code"] != "unavailable" {
		t.Fatalf("%d %v", resp.StatusCode, m)
	}
}

// MG-118: what Look reads through the manager — the update status, the network state, the box's measurements and its
// hardware — the support service may read beside the runtime; nothing else of the runtime's.
func TestSupportReads(t *testing.T) {
	t.Parallel()
	me := uint32(os.Getuid())
	w := testworld.New(t)
	drv := "virtio_net"
	hw := &fakeHardware{h: &protocol.HostHardware{CollectedAt: "2026-10-20T12:00:00Z", Kernel: "6.18.53",
		Cpu: protocol.HardwareCpu{Cores: 2, Threads: 2}, MemoryBytes: 1 << 30, Log: []string{},
		Devices: []protocol.HardwareDevice{{Kind: protocol.HardwareKindWired, Name: "Virtio", Bus: protocol.HardwareBusPci,
			Driver: &drv, Status: protocol.HardwareStatusOk}}}}
	for _, support := range []bool{true, false} {
		t.Run(fmt.Sprintf("support uid %v", support), func(t *testing.T) {
			s := &broker.Server{RuntimeUID: me + 1, Engine: w.Engine, Hardware: hw}
			if support {
				s.SupportUIDs = []uint32{me}
			}
			c := serveSupport(t, s)
			want := map[bool]int{true: 200, false: 403}[support]
			resp, err := c.Get("http://manager/v1/update/status")
			if err != nil {
				t.Fatal(err)
			}
			resp.Body.Close()
			if resp.StatusCode != want {
				t.Errorf("update status: %d", resp.StatusCode)
			}
			if resp, m := post(t, c, local.ManagerPathHostHardware, `{"v":1}`); resp.StatusCode != want {
				t.Errorf("hardware: %d %v", resp.StatusCode, m)
			}
			// No sampler or network guard here: past the uid check they answer 404 unavailable, not 403.
			for _, p := range []string{local.ManagerPathHostMetrics, local.ManagerPathNetworkState} {
				if resp, m := post(t, c, p, `{"v":1}`); (resp.StatusCode == 403) == support {
					t.Errorf("%s: %d %v", p, resp.StatusCode, m)
				}
			}
			// Never the runtime's own routes: its tickets, claims, pushes, Wi-Fi.
			for _, p := range []string{local.ManagerPathTicket, local.ManagerPathPush, local.ManagerPathWifiScan, local.ManagerPathClaimed} {
				if resp, _ := post(t, c, p, `{}`); resp.StatusCode != 403 {
					t.Errorf("%s: %d", p, resp.StatusCode)
				}
			}
		})
	}
}
