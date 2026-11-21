package broker_test

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/manager/internal/broker"
	"github.com/CybexBV/whombat/appliance/manager/internal/clients"
	"github.com/CybexBV/whombat/contracts/go/local"
	"github.com/CybexBV/whombat/contracts/go/release"
)

type fakeClients struct{ removing bool }

func (f *fakeClients) Status() local.LocalClientsStatus {
	return local.LocalClientsStatus{V: 1, Clients: []local.LocalClient{{Provider: "claude", State: local.LocalClientStateNotInstalled}}}
}

func (f *fakeClients) Install(_ context.Context, p release.ClientProvider) (local.LocalClient, error) {
	switch {
	case f.removing:
		return local.LocalClient{}, clients.ErrBusy
	case p == release.ClientProviderCodex:
		return local.LocalClient{}, fmt.Errorf("%w: adapter", clients.ErrUnavailable)
	}
	pr := int64(0)
	return local.LocalClient{Provider: p, State: local.LocalClientStateInstalling, Progress: &pr}, nil
}

func (f *fakeClients) Remove(_ context.Context, p release.ClientProvider) (local.LocalClient, error) {
	return local.LocalClient{Provider: p, State: local.LocalClientStateNotInstalled}, nil
}

func TestClientsEndpoints(t *testing.T) {
	t.Parallel()
	me := uint32(os.Getuid())
	for _, tc := range []struct {
		name    string
		uid     uint32
		clients broker.Clients
		path    string
		body    string
		status  int
		code    string
	}{
		{"install", me, &fakeClients{}, "/v1/clients/install", `{"v":1,"provider":"claude"}`, 202, ""},
		{"no bundle", me, &fakeClients{}, "/v1/clients/install", `{"v":1,"provider":"codex"}`, 404, "unavailable"},
		{"removing", me, &fakeClients{removing: true}, "/v1/clients/install", `{"v":1,"provider":"claude"}`, 409, "busy"},
		{"strict", me, &fakeClients{}, "/v1/clients/install", `{"v":1,"provider":"claude","version":"1.0"}`, 400, "bad_request"},
		{"unknown provider", me, &fakeClients{}, "/v1/clients/install", `{"v":1,"provider":"gemini"}`, 400, "bad_request"},
		{"remove", me, &fakeClients{}, "/v1/clients/remove", `{"v":1,"provider":"claude"}`, 200, ""},
		{"not the runtime", me + 1, &fakeClients{}, "/v1/clients/install", `{"v":1,"provider":"claude"}`, 403, "forbidden"},
		{"no clients here", me, nil, "/v1/clients/install", `{"v":1,"provider":"claude"}`, 404, "unavailable"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, sock, w := start(t, tc.uid, nil)
			// start() serves its own broker; serve one with clients on another socket.
			s := &broker.Server{RuntimeUID: tc.uid, Engine: w.Engine}
			if tc.clients != nil {
				s.Clients = tc.clients
			}
			sock = filepath.Join(filepath.Dir(sock), "clients.sock")
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			go s.Listen(ctx, sock)
			for i := 0; i < 100; i++ {
				if _, err := os.Stat(sock); err == nil {
					break
				}
				time.Sleep(10 * time.Millisecond)
			}
			resp, m := post(t, client(sock), tc.path, tc.body)
			if resp.StatusCode != tc.status {
				t.Fatalf("%d %v", resp.StatusCode, m)
			}
			if tc.code != "" {
				if e, _ := m["error"].(map[string]any); e["code"] != tc.code {
					t.Fatalf("%v", m)
				}
			}
		})
	}
	_, sock, w := start(t, me, nil)
	s := &broker.Server{RuntimeUID: me, Engine: w.Engine, Clients: &fakeClients{}}
	sock = filepath.Join(filepath.Dir(sock), "clients.sock")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go s.Listen(ctx, sock)
	time.Sleep(50 * time.Millisecond)
	resp, err := client(sock).Get("http://manager/v1/clients")
	if err != nil || resp.StatusCode != 200 {
		t.Fatalf("%v %v", resp, err)
	}
	b := make([]byte, 4096)
	n, _ := resp.Body.Read(b)
	if _, err := local.ParseLocalClientsStatus(b[:n]); err != nil {
		t.Fatalf("GET /v1/clients: %v (%s)", err, b[:n])
	}
}
