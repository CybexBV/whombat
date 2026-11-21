package broker_test

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/manager/internal/broker"
	"github.com/CybexBV/whombat/appliance/manager/internal/hostmetrics"
	"github.com/CybexBV/whombat/contracts/go/local"
	"github.com/CybexBV/whombat/contracts/go/protocol"
)

type fakeHost struct {
	got *local.HostMetricsRequest
	err error
}

func (f *fakeHost) Metrics(req *local.HostMetricsRequest) (*local.HostMetricsResponse, error) {
	f.got = req
	if f.err != nil {
		return nil, f.err
	}
	return &local.HostMetricsResponse{V: 1, Metrics: protocol.HostMetrics{TimeZone: "UTC"}}, nil
}

func TestHostMetricsEndpoint(t *testing.T) {
	t.Parallel()
	me := uint32(os.Getuid())
	for _, tc := range []struct {
		name   string
		uid    uint32
		host   *fakeHost
		body   string
		status int
		code   string
	}{
		{"answered", me, &fakeHost{}, `{"v":1,"range":"day","since":"2026-10-11T08:00:00Z","timeZone":"Europe/Amsterdam"}`, 200, ""},
		{"strict", me, &fakeHost{}, `{"v":1,"range":"day","timeZone":"UTC","points":3}`, 400, "bad_request"},
		{"no such range", me, &fakeHost{}, `{"v":1,"range":"year","timeZone":"UTC"}`, 400, "bad_request"},
		{"not measured yet", me, &fakeHost{err: hostmetrics.ErrNotYet}, `{"v":1,"range":"hour","timeZone":"UTC"}`, 503, "unavailable"},
		{"no such time", me, &fakeHost{err: hostmetrics.ErrBadRequest}, `{"v":1,"range":"hour","timeZone":"UTC"}`, 400, "bad_request"},
		{"failed", me, &fakeHost{err: errors.New("boom")}, `{"v":1,"range":"hour","timeZone":"UTC"}`, 500, "internal"},
		{"not the runtime", me + 1, &fakeHost{}, `{"v":1,"range":"hour","timeZone":"UTC"}`, 403, "forbidden"},
		// As from a manager before MG-66: the runtime reports the measurements unavailable.
		{"nothing measured here", me, nil, `{"v":1,"range":"hour","timeZone":"UTC"}`, 404, "unavailable"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := &broker.Server{RuntimeUID: tc.uid}
			if tc.host != nil {
				s.Host = tc.host
			}
			dir, err := os.MkdirTemp("", "hm") // a short path: a socket's is at most 107 bytes
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { os.RemoveAll(dir) })
			sock := filepath.Join(dir, "api.sock")
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			go s.Listen(ctx, sock)
			for i := 0; i < 100; i++ {
				if _, err := os.Stat(sock); err == nil {
					break
				}
				time.Sleep(10 * time.Millisecond)
			}
			resp, m := post(t, client(sock), local.ManagerPathHostMetrics, tc.body)
			if resp.StatusCode != tc.status {
				t.Fatalf("%d %v", resp.StatusCode, m)
			}
			if tc.code != "" {
				if e, _ := m["error"].(map[string]any); e["code"] != tc.code {
					t.Fatalf("%v", m)
				}
				return
			}
			if m["v"] != float64(1) || m["metrics"].(map[string]any)["timeZone"] != "UTC" {
				t.Fatal(m)
			}
			if g := tc.host.got; g.Range != protocol.HostMetricsRangeDay || *g.Since != "2026-10-11T08:00:00Z" || g.TimeZone != "Europe/Amsterdam" {
				t.Fatalf("%+v", g)
			}
		})
	}
}
