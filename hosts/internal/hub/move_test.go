package hub

import (
	"net/http"
	"net/netip"
	"slices"
	"sync"
	"testing"
	"time"

	"rackoon/internal/netaddrs"
)

func TestMoveAgents(t *testing.T) {
	pfx := netip.MustParsePrefix
	var mu sync.Mutex
	ifs := []netaddrs.Interface{
		{Name: "enp1s0", Up: true, Prefixes: []netip.Prefix{pfx("10.100.1.81/24")}},
		{Name: "wlan0", Up: true, Prefixes: []netip.Prefix{pfx("10.100.1.97/24")}},
	}
	e := headlessEnv(t, func(c *Config) {
		c.AgentURL, c.AgentListen = "wss://10.100.1.81:8443", ":8443"
		c.Interfaces = func() ([]netaddrs.Interface, error) {
			mu.Lock()
			defer mu.Unlock()
			return slices.Clone(ifs), nil
		}
	})
	svc := e.service("pe_1|John")
	agents := connectAll(t, e, svc, "basalt", "granite")
	for _, bad := range []map[string]any{
		{"url": "https://10.100.1.97:8443"},
		{"url": "wss://10.100.1.97"},
		{"url": "wss://10.100.1.50:8443"},
		{"url": "wss://10.100.1.97:8443/x"},
		{"url": "wss://10.100.1.97:8443", "extra": 1},
	} {
		if p := svc.problem(http.MethodPost, "/api/v1/hub/agents/move", bad, 400); p.Code != "bad_request" {
			t.Errorf("%v: %+v", bad, p)
		}
	}
	var out struct{ Asked, Already int }
	svc.json(http.MethodPost, "/api/v1/hub/agents/move", map[string]string{"url": "wss://10.100.1.97:8443"}, 200, &out)
	if out.Asked != 2 || out.Already != 0 {
		t.Fatalf("move = %+v", out)
	}
	for _, a := range agents {
		waitFor(t, "hub_move", 5*time.Second, func() bool {
			a.mu.Lock()
			defer a.mu.Unlock()
			return slices.Equal(a.hubMoves, []string{"wss://10.100.1.97:8443"})
		})
	}
	rc := hubInfo(t, svc)["reconnecting"].(map[string]any)
	if rc["reason"] != holdMove || rc["waiting"] != 2.0 {
		t.Fatalf("reconnecting = %v", rc)
	}
	if recs := e.audit("hub.agents_moved"); len(recs) != 1 || recs[0].Details["url"] != "wss://10.100.1.97:8443" ||
		recs[0].Details["asked"] != "2" {
		t.Errorf("audit = %+v", recs)
	}
	if recs := e.audit("hub.reconnecting"); len(recs) != 1 || recs[0].Details["reason"] != holdMove {
		t.Errorf("audit = %+v", recs)
	}
	// Each agent's address: where its connection came in.
	var list []map[string]any
	svc.json(http.MethodGet, "/api/v1/agents", nil, 200, &list)
	var fleet struct{ Servers []map[string]any }
	svc.json(http.MethodGet, "/api/v1/fleet", nil, 200, &fleet)
	for _, items := range [][]map[string]any{list, fleet.Servers} {
		if len(items) != 2 {
			t.Fatalf("items = %v", items)
		}
		for _, it := range items {
			if it["via"] != "127.0.0.1" {
				t.Errorf("via = %v", it["via"])
			}
		}
	}
	agents[0].sess.Close()
	waitFor(t, "disconnected", 5*time.Second, func() bool {
		var list []map[string]any // fresh: decoding into old maps keeps their keys
		svc.json(http.MethodGet, "/api/v1/agents", nil, 200, &list)
		for _, it := range list {
			if it["connected"] == false {
				_, has := it["via"]
				return !has
			}
		}
		return false
	})
}
