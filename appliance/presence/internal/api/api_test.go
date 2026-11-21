package api

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/CybexBV/whombat/appliance/helper/pkg/peercred"
	"github.com/CybexBV/whombat/contracts/go/local"
)

type fakeWatcher struct {
	watches, stops int
	answer         local.PresenceWatch
}

func (f *fakeWatcher) Watch() local.PresenceWatch { f.watches++; return f.answer }
func (f *fakeWatcher) Stop()                      { f.stops++ }

func newServer(camera, detector bool) (*Server, *fakeWatcher) {
	seen := "2026-10-20T12:00:01.500Z"
	f := &fakeWatcher{answer: local.PresenceWatch{V: 1, State: local.PresenceStateWatching, Face: true, SeenAt: &seen, FrameAt: &seen}}
	return &Server{Watcher: f, Camera: func() bool { return camera }, Detector: func() bool { return detector }}, f
}

func call(s *Server, method, path, body string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, httptest.NewRequest(method, path, strings.NewReader(body)))
	return rec
}

// errorCode checks a LocalError's status and code.
func errorCode(t *testing.T, rec *httptest.ResponseRecorder, status int, code string) {
	t.Helper()
	e, err := local.ParseLocalError(rec.Body.Bytes())
	if rec.Code != status || err != nil || e.Error.Code != code {
		t.Fatalf("got %d %s (%v), want %d %s", rec.Code, rec.Body.String(), err, status, code)
	}
}

func TestHealth(t *testing.T) {
	for _, c := range []struct{ camera, detector bool }{{true, true}, {false, true}, {true, false}} {
		s, _ := newServer(c.camera, c.detector)
		rec := call(s, http.MethodGet, local.PresencePathHealth, "")
		h, err := local.ParsePresenceHealth(rec.Body.Bytes())
		if rec.Code != 200 || err != nil || h.Camera != c.camera || h.Detector != c.detector {
			t.Fatalf("%+v: %d %s %v", c, rec.Code, rec.Body.String(), err)
		}
	}
}

func TestWatchAndStop(t *testing.T) {
	s, f := newServer(true, true)
	rec := call(s, http.MethodPost, local.PresencePathWatch, `{"v":1}`)
	a, err := local.ParsePresenceWatch(rec.Body.Bytes())
	if rec.Code != 200 || err != nil || a.State != local.PresenceStateWatching || !a.Face || f.watches != 1 {
		t.Fatalf("watch: %d %s %v", rec.Code, rec.Body.String(), err)
	}
	rec = call(s, http.MethodPost, local.PresencePathStop, `{"v":1}`)
	if _, err := local.ParsePresenceAck(rec.Body.Bytes()); rec.Code != 200 || err != nil || f.stops != 1 {
		t.Fatalf("stop: %d %s %v", rec.Code, rec.Body.String(), err)
	}
}

func TestRefuses(t *testing.T) {
	s, f := newServer(true, true)
	for _, c := range []struct {
		method, path, body string
		status             int
		code               string
	}{
		{http.MethodPost, local.PresencePathWatch, `{"v":2}`, 400, local.PresenceErrorBadRequest},
		{http.MethodPost, local.PresencePathWatch, `{"v":1,"camera":"/dev/video2"}`, 400, local.PresenceErrorBadRequest},
		{http.MethodPost, local.PresencePathWatch, `not json`, 400, local.PresenceErrorBadRequest},
		{http.MethodPost, local.PresencePathWatch, ``, 400, local.PresenceErrorBadRequest},
		{http.MethodPost, local.PresencePathStop, `{}`, 400, local.PresenceErrorBadRequest},
		{http.MethodPost, local.PresencePathWatch, `{"v":1,"pad":"` + strings.Repeat("x", local.PresenceRequestMaxBytes) + `"}`, 413, local.PresenceErrorTooLarge},
		{http.MethodGet, local.PresencePathWatch, ``, 405, local.PresenceErrorBadRequest},
		{http.MethodPost, local.PresencePathHealth, ``, 405, local.PresenceErrorBadRequest},
		{http.MethodGet, "/v1/presence/picture", ``, 404, local.PresenceErrorBadRequest},
	} {
		errorCode(t, call(s, c.method, c.path, c.body), c.status, c.code)
	}
	if f.watches != 0 || f.stops != 0 {
		t.Fatalf("a refused request reached the watcher: %d watches, %d stops", f.watches, f.stops)
	}
}

func TestWatchWithoutADetectorIsUnavailable(t *testing.T) {
	s, f := newServer(true, false)
	errorCode(t, call(s, http.MethodPost, local.PresencePathWatch, `{"v":1}`), 503, local.PresenceErrorUnavailable)
	if f.watches != 0 {
		t.Fatal("the camera was turned on without a detector")
	}
	// A stop still works.
	if rec := call(s, http.MethodPost, local.PresencePathStop, `{"v":1}`); rec.Code != 200 {
		t.Fatalf("stop: %d", rec.Code)
	}
}

func TestPeerCheck(t *testing.T) {
	dir, err := os.MkdirTemp("", "presence-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(dir)
	get := func(allow uint32) int {
		sock := filepath.Join(dir, "p.sock")
		_ = os.Remove(sock)
		l, err := net.Listen("unix", sock)
		if err != nil {
			t.Fatal(err)
		}
		s, _ := newServer(true, true)
		s.AllowUIDs = []uint32{allow}
		srv := &http.Server{Handler: s.Handler(), ConnContext: peercred.ConnContext}
		go func() { _ = srv.Serve(l) }()
		defer srv.Close()
		c := &http.Client{Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "unix", sock)
		}}}
		r, err := c.Post("http://presence"+local.PresencePathWatch, "application/json", strings.NewReader(`{"v":1}`))
		if err != nil {
			t.Fatal(err)
		}
		r.Body.Close()
		return r.StatusCode
	}
	if got := get(uint32(os.Getuid())); got != 200 {
		t.Fatalf("own uid: %d", got)
	}
	if got := get(uint32(os.Getuid()) + 1); got != 403 {
		t.Fatalf("other uid: %d", got)
	}
}
