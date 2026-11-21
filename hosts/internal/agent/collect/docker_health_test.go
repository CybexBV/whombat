package collect

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"rackoon/internal/proto"
)

func TestDockerHealthFields(t *testing.T) {
	list := `[
 {"Id":"4b5e57f6eb2f","Names":["/web"],"Image":"nginx:stable-alpine","ImageID":"sha256:aaaa","State":"running","Status":"Up 9 hours","Labels":{"com.docker.compose.project":"site"}},
 {"Id":"9c1f0e2d3b4a","Names":["/worker"],"Image":"ghcr.io/example/worker:1.4","ImageID":"sha256:bbbb","State":"exited","Status":"Exited (137) 2 hours ago","Labels":{"com.docker.compose.project":"jobs"}},
 {"Id":"77aa","Names":["/frozen"],"Image":"redis:7","ImageID":"sha256:cccc","State":"paused","Status":"Up 1 hour (Paused)","Labels":{}}
]`
	var sizeCalls atomic.Int64
	mux := http.NewServeMux()
	mux.HandleFunc("/version", func(w http.ResponseWriter, r *http.Request) { w.Write([]byte(`{"Version":"29.8.1"}`)) })
	mux.HandleFunc("/info", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"Warnings":["WARNING: No swap limit support","WARNING: bridge-nf-call-iptables is disabled"]}`))
	})
	mux.HandleFunc("/containers/json", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("size") == "true" {
			sizeCalls.Add(1)
			w.Write([]byte(`[{"Id":"4b5e57f6eb2f","SizeRw":12345},{"Id":"9c1f0e2d3b4a","SizeRw":0}]`))
			return
		}
		w.Write([]byte(list))
	})
	mux.HandleFunc("/containers/", func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasPrefix(r.URL.Path, "/containers/4b5e57f6eb2f/json"):
			w.Write(readTestdata(t, "docker_inspect_web.json"))
		case strings.HasPrefix(r.URL.Path, "/containers/9c1f0e2d3b4a/json"):
			w.Write(readTestdata(t, "docker_inspect_oom.json"))
		case strings.HasSuffix(r.URL.Path, "/json"):
			w.Write([]byte(`{"State":{"Status":"paused"},"RestartCount":0}`))
		default:
			w.Write(readTestdata(t, "docker_stats.json"))
		}
	})
	sock := serveUnix(t, mux)
	c := newTestCollector()
	d := c.docker
	d.socket = sock
	d.client = unixHTTPClient(sock, 5*time.Second)
	if err := d.run(context.Background()); err != nil {
		t.Fatal(err)
	}
	// The writable-layer sizes arrive in the background: wait until they
	// are stored, not just asked for.
	for deadline := time.Now().Add(10 * time.Second); ; time.Sleep(10 * time.Millisecond) {
		d.mu.Lock()
		stored := d.sizes != nil
		d.mu.Unlock()
		if stored {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the writable-layer sizes never arrived")
		}
	}
	if err := d.run(context.Background()); err != nil {
		t.Fatal(err)
	}
	g := map[string]proto.Guest{}
	for _, x := range d.snapshot().Guests {
		g[x.ID] = x
	}
	web := g["web"]
	if web.Project != "site" || web.RestartCount == nil || *web.RestartCount != 0 || web.ExitCode != nil || web.OOMKilled ||
		strings.Join(web.Addresses, ",") != "172.17.0.3,172.20.0.5,fd00:dead:beef::5" || web.DiskUsedBytes == nil || *web.DiskUsedBytes != 12345 {
		t.Errorf("web: %+v", web)
	}
	w := g["worker"]
	if w.State != proto.StateStopped || !w.OOMKilled || w.ExitCode == nil || *w.ExitCode != 137 || *w.RestartCount != 3 || w.Project != "jobs" || len(w.Addresses) != 0 {
		t.Errorf("worker: %+v", w)
	}
	if f := g["frozen"]; f.State != proto.StatePaused {
		t.Errorf("frozen: %+v", f)
	}
	if w := d.snapshot().Warnings; len(w) != 2 || w[0].Message != "No swap limit support" || w[0].Type != "daemon" {
		t.Errorf("warnings: %+v", w)
	}
	if sizeCalls.Load() != 1 {
		t.Errorf("size listing ran %d times (every 10 minutes)", sizeCalls.Load())
	}
	// Running containers' images are the update candidates.
	if r := d.runningImages(); len(r) != 1 || r[0].Ref != "nginx:stable-alpine" || r[0].ImageID != "sha256:aaaa" {
		t.Errorf("running images: %+v", r)
	}
	// Ids name containers for OOM kills (LM-04), also after they are gone.
	if d.containerName("9c1f0e2d3b4a") != "worker" || d.containerName("nope") != "" {
		t.Errorf("container names: %+v", d.names)
	}
	list = `[]`
	if err := d.run(context.Background()); err != nil || d.containerName("9c1f0e2d3b4a") != "worker" {
		t.Errorf("removed container: %v %q", err, d.containerName("9c1f0e2d3b4a"))
	}
}

func TestDockerOOMEvent(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/events", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"Type":"container","Action":"oom","Actor":{"ID":"9c1f","Attributes":{"name":"worker"}}}` + "\n"))
	})
	sock := serveUnix(t, mux)
	c := newTestCollector()
	c.docker.socket = sock
	_ = c.docker.streamEvents(context.Background(), unixHTTPClient(sock, 0))
	if len(c.events) != 1 {
		t.Fatalf("events: %d", len(c.events))
	}
	ev := <-c.events
	if ev.Kind != "guest.oom" || ev.Platform != proto.PlatformDocker || ev.GuestID != "worker" || ev.Message == "" {
		t.Errorf("event: %+v", ev)
	}
}

func TestParseImageRef(t *testing.T) {
	for in, want := range map[string]imageRef{
		"nginx":                          {"registry-1.docker.io", "library/nginx", "latest"},
		"nginx:stable-alpine":            {"registry-1.docker.io", "library/nginx", "stable-alpine"},
		"prom/prometheus:v3.5.0":         {"registry-1.docker.io", "prom/prometheus", "v3.5.0"},
		"docker.io/library/redis:7":      {"registry-1.docker.io", "library/redis", "7"},
		"ghcr.io/org/app:v1":             {"ghcr.io", "org/app", "v1"},
		"lscr.io/linuxserver/plex":       {"lscr.io", "linuxserver/plex", "latest"},
		"registry.lan:5000/team/svc:2.1": {"registry.lan:5000", "team/svc", "2.1"},
		"localhost/app:dev":              {"localhost", "app", "dev"},
	} {
		got, ok := parseImageRef(in)
		if !ok || got != want {
			t.Errorf("parseImageRef(%q) = %+v %v, want %+v", in, got, ok, want)
		}
	}
	for _, bad := range []string{"", "nginx@sha256:0123", "sha256:abcd", strings.Repeat("a", 64)} {
		if _, ok := parseImageRef(bad); ok {
			t.Errorf("parseImageRef(%q) accepted", bad)
		}
	}
	s, p := parseChallenge(`Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:library/nginx:pull"`)
	if s != "Bearer" || p["realm"] != "https://auth.docker.io/token" || p["service"] != "registry.docker.io" || p["scope"] != "repository:library/nginx:pull" {
		t.Errorf("challenge: %s %v", s, p)
	}
}

// fakeRegistry answers manifest HEADs like Docker Hub (bearer token flow),
// an open registry, and a private one (Basic auth).
func fakeRegistry(t *testing.T) (*httptest.Server, *atomic.Int64) {
	var gets atomic.Int64
	var srv *httptest.Server
	srv = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && r.URL.Path == "/token" {
			if r.URL.Query().Get("scope") != "repository:library/nginx:pull" || r.URL.Query().Get("service") != "registry.test" {
				t.Errorf("token query %q", r.URL.RawQuery)
			}
			json.NewEncoder(w).Encode(map[string]string{"token": "anon-token"})
			return
		}
		if r.Method != http.MethodHead {
			gets.Add(1) // a GET of a manifest would count as a pull
			http.Error(w, "HEAD only", http.StatusMethodNotAllowed)
			return
		}
		if !strings.Contains(r.Header.Get("Accept"), "application/vnd.oci.image.index.v1+json") {
			t.Errorf("accept %q", r.Header.Get("Accept"))
		}
		switch r.URL.Path {
		case "/v2/library/nginx/manifests/stable-alpine":
			if r.Header.Get("Authorization") != "Bearer anon-token" {
				w.Header().Set("WWW-Authenticate", `Bearer realm="`+srv.URL+`/token",service="registry.test",scope="repository:library/nginx:pull"`)
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			w.Header().Set("Docker-Content-Digest", "sha256:new")
		case "/v2/org/app/manifests/v1":
			w.Header().Set("Docker-Content-Digest", "sha256:same")
		case "/v2/team/private/manifests/1":
			w.Header().Set("WWW-Authenticate", `Basic realm="Registry"`)
			w.WriteHeader(http.StatusUnauthorized)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(srv.Close)
	return srv, &gets
}

func TestImageUpdates(t *testing.T) {
	srv, gets := fakeRegistry(t)
	old := registryBase
	registryBase = func(string) string { return srv.URL }
	defer func() { registryBase = old }()

	c := newTestCollector()
	u := c.images
	u.client = srv.Client()
	u.localDigests = func(_ context.Context, id string) ([]string, error) {
		return map[string][]string{
			"sha256:n": {"nginx@sha256:old", "example.org/mirror/nginx@sha256:new"},
			"sha256:a": {"ghcr.io/org/app@sha256:same"},
			"sha256:p": {"registry.lan/team/private@sha256:x"},
			"sha256:l": nil, // built locally
			"sha256:m": {"registry.lan/team/missing@sha256:y"},
		}[id], nil
	}
	ctx := context.Background()
	for _, c := range []struct {
		cand   imageCand
		update *bool
		remote bool
		err    bool
	}{
		{imageCand{"nginx:stable-alpine", "sha256:n"}, ptr(true), true, false},
		{imageCand{"ghcr.io/org/app:v1", "sha256:a"}, ptr(false), true, false},
		{imageCand{"registry.lan/team/private:1", "sha256:p"}, nil, true, false},
		{imageCand{"myapp:dev", "sha256:l"}, nil, false, false},
		{imageCand{"nginx@sha256:abc", "sha256:n"}, nil, false, false},
		{imageCand{"registry.lan/team/missing:2", "sha256:m"}, nil, true, true},
	} {
		update, remote, err := u.check(ctx, c.cand)
		if (update == nil) != (c.update == nil) || (update != nil && *update != *c.update) || remote != c.remote || (err != nil) != c.err {
			t.Errorf("%s: update=%v remote=%v err=%v", c.cand.Ref, update, remote, err)
		}
	}
	if gets.Load() != 0 {
		t.Errorf("%d GET requests: image checks must only HEAD", gets.Load())
	}
}

func TestImageUpdaterRun(t *testing.T) {
	srv, _ := fakeRegistry(t)
	old := registryBase
	registryBase = func(string) string { return srv.URL }
	defer func() { registryBase = old }()
	c := newTestCollector()
	c.docker.socket = serveUnix(t, http.NewServeMux())
	c.docker.running = []imageCand{{"nginx:stable-alpine", "sha256:n"}, {"nginx:stable-alpine", "sha256:n"}, {"ghcr.io/org/app:v1", "sha256:a"}}
	u := c.images
	u.client = srv.Client()
	var asked atomic.Int64
	u.localDigests = func(_ context.Context, id string) ([]string, error) {
		asked.Add(1)
		return map[string][]string{"sha256:n": {"nginx@sha256:old"}, "sha256:a": {"ghcr.io/org/app@sha256:same"}}[id], nil
	}
	if err := u.run(context.Background()); err != nil {
		t.Fatal(err)
	}
	res := u.results()
	if r := res["nginx:stable-alpine@sha256:n"]; r == nil || !*r {
		t.Errorf("nginx: %v", r)
	}
	if r := res["ghcr.io/org/app:v1@sha256:a"]; r == nil || *r {
		t.Errorf("app: %v", r)
	}
	// Checked images wait 12 hours; duplicates are checked once.
	u.run(context.Background())
	if asked.Load() != 2 {
		t.Errorf("checks: %d", asked.Load())
	}
	// Switched off: results go away.
	off := false
	c.SetCollectors(agentCollectors(&off))
	u.run(context.Background())
	if len(u.results()) != 0 {
		t.Error("results kept with image_updates = false")
	}
}
