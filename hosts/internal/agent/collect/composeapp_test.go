package collect

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"runtime"
	"testing"

	"rackoon/internal/proto"
)

func TestComposeApp(t *testing.T) {
	compose := map[string]string{
		"com.docker.compose.project":             "immich",
		"com.docker.compose.service":             "immich-server",
		"com.docker.compose.project.working_dir": "/srv/immich",
		"org.opencontainers.image.version":       "v2.3.0",
	}
	a := composeApp(compose, "ghcr.io/immich-app/immich-server:release", "sha256:abc", "v2.4.0")
	if a == nil || a.Service != "immich-server" || a.Version != "v2.3.0" || a.NewVersion != "v2.4.0" || a.Blocked != "" {
		t.Errorf("compose app: %+v", a)
	}
	if a := composeApp(map[string]string{"com.docker.compose.project": "x", "com.docker.compose.service": "db"}, "", "postgres:16.4", ""); a == nil || a.Version != "16.4" {
		t.Errorf("version from the tag: %+v", a)
	}
	if a := composeApp(map[string]string{"com.docker.compose.project": "x", "com.docker.compose.service": "web"}, "nginx@sha256:aa", "", ""); a == nil || a.Blocked != proto.AppReasonPinned {
		t.Errorf("pinned: %+v", a)
	}
	if a := composeApp(map[string]string{"maintainer": "x"}, "nginx:1", "", ""); a != nil {
		t.Errorf("docker run: %+v", a)
	}
	oneOff := map[string]string{"com.docker.compose.project": "x", "com.docker.compose.service": "web", "com.docker.compose.oneoff": "True"}
	if a := composeApp(oneOff, "nginx:1", "", ""); a != nil {
		t.Errorf("one-off: %+v", a)
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
