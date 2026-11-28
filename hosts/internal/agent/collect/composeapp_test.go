package collect

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"testing"
	"time"

	"rackoon/internal/proto"
)

func TestComposeApp(t *testing.T) {
	compose := map[string]string{
		"com.docker.compose.project":             "immich",
		"com.docker.compose.service":             "immich-server",
		"com.docker.compose.project.working_dir": "/srv/immich",
		"com.docker.compose.config-hash":         strings.Repeat("c", 64),
		"org.opencontainers.image.version":       "v2.3.0",
	}
	digest := "sha256:" + strings.Repeat("d", 64)
	a := composeApp(compose, "ghcr.io/immich-app/immich-server:release", "sha256:abc", imageResult{version: "v2.4.0", digest: digest})
	if a == nil || a.Service != "immich-server" || a.Version != "v2.3.0" || a.NewVersion != "v2.4.0" || a.Blocked != "" {
		t.Errorf("compose app: %+v", a)
	}
	// What an update must find again: the newer image's digest and Compose's hash of the service.
	if a.NewDigest != digest || a.ConfigHash != strings.Repeat("c", 64) {
		t.Errorf("binding facts: %+v", a)
	}
	if a := composeApp(compose, "app:1", "", imageResult{digest: "sha256:short"}); a.NewDigest != "" {
		t.Errorf("a digest that isn't one: %+v", a)
	}
	if a := composeApp(map[string]string{"com.docker.compose.project": "x", "com.docker.compose.service": "db"}, "", "postgres:16.4", imageResult{}); a == nil || a.Version != "16.4" {
		t.Errorf("version from the tag: %+v", a)
	}
	if a := composeApp(map[string]string{"com.docker.compose.project": "x", "com.docker.compose.service": "web"}, "nginx@sha256:aa", "", imageResult{}); a == nil || a.Blocked != proto.AppReasonPinned {
		t.Errorf("pinned: %+v", a)
	}
	if a := composeApp(map[string]string{"maintainer": "x"}, "nginx:1", "", imageResult{}); a != nil {
		t.Errorf("docker run: %+v", a)
	}
	oneOff := map[string]string{"com.docker.compose.project": "x", "com.docker.compose.service": "web", "com.docker.compose.oneoff": "True"}
	if a := composeApp(oneOff, "nginx:1", "", imageResult{}); a != nil {
		t.Errorf("one-off: %+v", a)
	}
	// An image's own labels can claim to be Compose's: a name that would read as an option isn't an app.
	hostile := map[string]string{"com.docker.compose.project": "x", "com.docker.compose.service": "--build"}
	if a := composeApp(hostile, "nginx:1", "", imageResult{}); a != nil {
		t.Errorf("option as a service: %+v", a)
	}
}

// The newer image's version: the index, this machine's image in it, its
// config's version label.
func TestRemoteVersion(t *testing.T) {
	gets := map[string]int{}
	var srv *httptest.Server
	srv = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gets[r.URL.Path]++
		if r.URL.Path == "/token" {
			json.NewEncoder(w).Encode(map[string]string{"token": "anon"})
			return
		}
		if r.Header.Get("Authorization") != "Bearer anon" {
			w.Header().Set("WWW-Authenticate", `Bearer realm="`+srv.URL+`/token",service="registry.test"`)
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		switch r.URL.Path {
		case "/v2/immich-app/immich-server/manifests/sha256:index":
			json.NewEncoder(w).Encode(map[string]any{"manifests": []map[string]any{
				{"digest": "sha256:other", "platform": map[string]string{"os": "linux", "architecture": "s390x"}},
				{"digest": "sha256:mine", "platform": map[string]string{"os": "linux", "architecture": runtime.GOARCH}},
			}})
		case "/v2/immich-app/immich-server/manifests/sha256:mine":
			json.NewEncoder(w).Encode(map[string]any{"config": map[string]string{"digest": "sha256:cfg"}})
		case "/v2/immich-app/immich-server/blobs/sha256:cfg":
			json.NewEncoder(w).Encode(map[string]any{"config": map[string]any{"Labels": map[string]string{"org.opencontainers.image.version": "v2.4.0"}}})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer srv.Close()
	old := registryBase
	registryBase = func(string) string { return srv.URL }
	defer func() { registryBase = old }()
	u := newTestCollector().images
	u.client = srv.Client()
	ref, _ := parseImageRef("ghcr.io/immich-app/immich-server:release")
	v, err := u.remoteVersion(context.Background(), ref, "sha256:index")
	if err != nil || v != "v2.4.0" {
		t.Fatalf("version %q, %v", v, err)
	}
	if gets["/token"] != 1 {
		t.Errorf("tokens fetched: %d (one, reused)", gets["/token"])
	}
	if _, err := u.remoteVersion(context.Background(), ref, "sha256:gone"); err == nil {
		t.Error("a missing manifest is an error")
	}
}

// A stopped service that shares a running one's image isn't checked itself:
// it carries that image's newer facts, so an update binds both to one image.
func TestStoppedSiblingNewerFacts(t *testing.T) {
	const ref = "ghcr.io/example/app:release"
	imageID := "sha256:" + strings.Repeat("a", 64)
	digest := "sha256:" + strings.Repeat("d", 64)
	labels := func(service string) map[string]string {
		return map[string]string{"com.docker.compose.project": "app", "com.docker.compose.service": service,
			"com.docker.compose.project.working_dir": "/srv/app", "com.docker.compose.config-hash": strings.Repeat("c", 64)}
	}
	list := []map[string]any{
		{"Id": strings.Repeat("1", 64), "Names": []string{"/app_web"}, "Image": ref, "ImageID": imageID, "State": "running",
			"Labels": labels("web"), "HostConfig": map[string]string{"NetworkMode": "bridge"}},
		{"Id": strings.Repeat("2", 64), "Names": []string{"/app_worker"}, "Image": ref, "ImageID": imageID, "State": "exited",
			"Labels": labels("worker"), "HostConfig": map[string]string{"NetworkMode": "bridge"}},
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/version", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"Version":"29.8.1","ApiVersion":"1.56"}`))
	})
	mux.HandleFunc("/containers/json", func(w http.ResponseWriter, r *http.Request) { json.NewEncoder(w).Encode(list) })
	mux.HandleFunc("/containers/", func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/json") {
			json.NewEncoder(w).Encode(map[string]any{"State": map[string]any{"Status": "running"}, "Config": map[string]any{"Image": ref}})
			return
		}
		w.Write([]byte(`{}`))
	})
	sock := serveUnix(t, mux)
	c := newTestCollector()
	d := c.docker
	d.socket = sock
	d.client = unixHTTPClient(sock, 5*time.Second)
	yes := true
	c.images.checked[imageCand{Ref: ref, ImageID: imageID}.key()] = imageCheck{at: time.Now(), update: &yes, remote: digest,
		version: "v2.4.0", versionRead: true}
	if err := d.run(context.Background()); err != nil {
		t.Fatal(err)
	}
	p := d.snapshot()
	if p == nil {
		t.Fatal("no snapshot")
	}
	g := map[string]proto.Guest{}
	for _, x := range p.Guests {
		g[x.ID] = x
	}
	web, worker := g["app_web"], g["app_worker"]
	if web.App == nil || web.App.NewDigest != digest || web.UpdateAvailable == nil || !*web.UpdateAvailable {
		t.Fatalf("web: %+v %+v", web, web.App)
	}
	if worker.App == nil || worker.App.NewDigest != digest || worker.App.NewVersion != "v2.4.0" {
		t.Fatalf("worker: %+v", worker.App)
	}
	// The stopped one isn't offered as an update of its own, nor checked itself.
	if worker.UpdateAvailable != nil || len(d.runningImages()) != 1 {
		t.Fatalf("worker update %v, checked %v", worker.UpdateAvailable, d.runningImages())
	}
}
