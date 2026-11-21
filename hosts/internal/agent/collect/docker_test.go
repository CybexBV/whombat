package collect

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"rackoon/internal/agent"
	"rackoon/internal/proto"
)

// serveUnix serves h on a Unix socket in a temp dir and returns its path.
func serveUnix(t *testing.T, h http.Handler) string {
	t.Helper()
	sock := filepath.Join(t.TempDir(), "api.sock")
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{Handler: h}
	go srv.Serve(ln)
	t.Cleanup(func() { srv.Close() })
	return sock
}

func newTestCollector() *collector {
	return New(&agent.Config{}, "test").(*collector)
}

func TestDockerCollector(t *testing.T) {
	var list []map[string]any
	if err := json.Unmarshal(readTestdata(t, "docker_list.json"), &list); err != nil {
		t.Fatal(err)
	}
	statsTmpl := string(readTestdata(t, "docker_stats.json"))
	inspect := readTestdata(t, "docker_inspect.json")
	var round atomic.Int64
	base := time.Date(2026, 10, 11, 14, 0, 0, 0, time.UTC)

	mux := http.NewServeMux()
	mux.HandleFunc("/version", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"Version":"29.8.1","ApiVersion":"1.56"}`))
	})
	mux.HandleFunc("/containers/json", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("all") != "1" {
			t.Error("containers/json without all=1")
		}
		json.NewEncoder(w).Encode(list)
	})
	mux.HandleFunc("/containers/", func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/json") {
			w.Write(inspect)
			return
		}
		if !strings.HasSuffix(r.URL.Path, "/stats") || r.URL.Query().Get("stream") != "false" || r.URL.Query().Get("one-shot") != "true" {
			t.Errorf("unexpected request %s", r.URL)
			http.NotFound(w, r)
			return
		}
		var st map[string]any
		json.Unmarshal([]byte(statsTmpl), &st)
		n := round.Load()
		st["read"] = base.Add(time.Duration(n) * 10 * time.Second).Format(time.RFC3339Nano)
		cpu := st["cpu_stats"].(map[string]any)
		cpu["system_cpu_usage"] = 1e15 + float64(n)*640e9 // 64 CPUs x 10 s
		cpu["online_cpus"] = 64
		cpu["cpu_usage"].(map[string]any)["total_usage"] = 5e9 + float64(n)*1e9
		nets := st["networks"].(map[string]any)
		nets["eth0"].(map[string]any)["rx_bytes"] = 1e6 + float64(n)*10000
		json.NewEncoder(w).Encode(st)
	})
	sock := serveUnix(t, mux)

	c := newTestCollector()
	d := c.docker
	d.socket = sock
	d.client = unixHTTPClient(sock, 5*time.Second)
	ctx := context.Background()
	if err := d.run(ctx); err != nil {
		t.Fatal(err)
	}
	round.Store(1)
	if err := d.run(ctx); err != nil {
		t.Fatal(err)
	}
	p := d.snapshot()
	if p == nil || p.Version != "29.8.1" || p.Error != "" || len(p.Guests) != 5 {
		t.Fatalf("platform: %+v", p)
	}
	g := map[string]proto.Guest{}
	for _, x := range p.Guests {
		g[x.ID] = x
	}
	web := g["web"]
	if web.State != proto.StateRunning || web.Image != "nginx:stable-alpine" || web.Kind != "container" {
		t.Errorf("web: %+v", web)
	}
	if web.CPUPct == nil || *web.CPUPct != 10 {
		t.Errorf("web cpu = %v, want 10 (1 s of CPU in 10 s, docker-stats convention)", web.CPUPct)
	}
	if web.NetRxBps == nil || *web.NetRxBps != 1000 {
		t.Errorf("web rx = %v, want 1000 B/s", web.NetRxBps)
	}
	var st dockerStats
	json.Unmarshal([]byte(statsTmpl), &st)
	if web.MemUsedBytes == nil || *web.MemUsedBytes != st.memUsed() || web.MemLimitBytes == nil || *web.MemLimitBytes != st.MemoryStats.Limit {
		t.Errorf("web mem: %v / %v", web.MemUsedBytes, web.MemLimitBytes)
	}
	if web.StartedAt == nil || web.FinishedAt != nil || strings.Join(web.Console.Protocols, ",") != "shell,logs" || web.Console.Default != "shell" {
		t.Errorf("web times/console: %+v", web)
	}
	if g["db"].State != proto.StateUnhealthy || g["db"].Image != "postgres:16" {
		t.Errorf("db: %+v", g["db"])
	}
	if g["worker"].Image != "6903191f67c6" || g["cache"].Image != "redis" {
		t.Errorf("images: %q %q", g["worker"].Image, g["cache"].Image)
	}
	old := g["old-job"]
	if old.State != proto.StateStopped || old.CPUPct != nil || old.MemUsedBytes != nil || old.Image != "busybox" {
		t.Errorf("old-job: %+v", old)
	}
}

func TestDockerStatsHelpers(t *testing.T) {
	var st dockerStats
	if err := json.Unmarshal(readTestdata(t, "docker_stats.json"), &st); err != nil {
		t.Fatal(err)
	}
	if st.memUsed() != st.MemoryStats.Usage-st.MemoryStats.Stats["inactive_file"] {
		t.Errorf("memUsed %d", st.memUsed())
	}
	rd, wr := st.blkio()
	if rd == 0 && wr == 0 && len(st.BlkioStats.IOServiceBytesRecursive) > 0 {
		t.Errorf("blkio %d %d", rd, wr)
	}
	v1 := dockerStats{}
	v1.MemoryStats.Usage = 1000
	v1.MemoryStats.Stats = map[string]uint64{"total_inactive_file": 300}
	if v1.memUsed() != 700 {
		t.Errorf("cgroup v1 memUsed %d", v1.memUsed())
	}
}

func TestDockerStateAndEvents(t *testing.T) {
	for _, c := range []struct{ state, health, want string }{
		{"running", "", proto.StateRunning}, {"running", "healthy", proto.StateRunning},
		{"running", "unhealthy", proto.StateUnhealthy}, {"restarting", "", proto.StateUnhealthy},
		{"exited", "", proto.StateStopped}, {"paused", "", proto.StatePaused}, {"created", "", proto.StateStopped},
	} {
		if got := dockerState(c.state, c.health); got != c.want {
			t.Errorf("dockerState(%s,%s) = %s", c.state, c.health, got)
		}
	}
	e := dockerListEntry{Status: "Up 3 hours (unhealthy)"}
	if e.health() != "unhealthy" {
		t.Errorf("health from status text: %q", e.health())
	}
	for action, want := range map[string]string{
		"start": proto.StateRunning, "die": proto.StateStopped, "destroy": proto.StateStopped,
		"health_status: unhealthy": proto.StateUnhealthy, "health_status: healthy": proto.StateRunning,
		"exec_start: sh": "", "attach": "", "kill": "", "pause": proto.StatePaused, "unpause": proto.StateRunning,
	} {
		if got, _ := dockerEventState(action); got != want {
			t.Errorf("dockerEventState(%q) = %q, want %q", action, got, want)
		}
	}
}

func TestDockerEventStream(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/events", func(w http.ResponseWriter, r *http.Request) {
		if !strings.Contains(r.URL.Query().Get("filters"), "container") {
			t.Errorf("filters %q", r.URL.RawQuery)
		}
		for _, ev := range []string{
			`{"Type":"container","Action":"exec_create: sh","Actor":{"ID":"a","Attributes":{"name":"web"}}}`,
			`{"Type":"container","Action":"die","Actor":{"ID":"a","Attributes":{"name":"web"}}}`,
			`{"Type":"container","Action":"stop","Actor":{"ID":"a","Attributes":{"name":"web"}}}`,
			`{"Type":"container","Action":"start","Actor":{"ID":"b","Attributes":{"name":"db"}}}`,
		} {
			w.Write([]byte(ev + "\n"))
		}
	})
	sock := serveUnix(t, mux)
	c := newTestCollector()
	c.docker.socket = sock
	_ = c.docker.streamEvents(context.Background(), unixHTTPClient(sock, 0))
	var got []string
	for len(c.events) > 0 {
		ev := <-c.events
		got = append(got, ev.GuestID+"="+ev.State)
	}
	// die + stop of the same container within 2 s collapse into one event.
	if strings.Join(got, ",") != "web=stopped,db=running" {
		t.Errorf("events: %v", got)
	}
	c.dockerSub.mu.Lock()
	dirty := c.dockerSub.dirty
	c.dockerSub.mu.Unlock()
	if !dirty {
		t.Error("an event must mark the docker collector dirty")
	}
}

func TestDockerImage(t *testing.T) {
	for in, want := range map[string]string{
		"prom/prometheus:latest": "prom/prometheus", "nginx": "nginx", "postgres:16": "postgres:16",
		"docker.io/library/redis:7": "redis:7", "ghcr.io/org/app@sha256:abc": "ghcr.io/org/app",
		"sha256:0123456789abcdef0123": "0123456789ab",
	} {
		if got := dockerImage(in, ""); got != want {
			t.Errorf("dockerImage(%q) = %q, want %q", in, got, want)
		}
	}
}
