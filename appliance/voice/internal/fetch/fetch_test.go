package fetch

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/voice/internal/models"
	"github.com/CybexBV/whombat/contracts/go/local"
)

// source serves one model's bytes with ranges; it can stop after some bytes, hang, answer a status, or corrupt.
type source struct {
	mu      sync.Mutex
	body    []byte
	status  int   // when set, every request gets it
	stopAt  int64 // when set, a response ends after this offset (once)
	hang    chan struct{}
	corrupt bool
	ranges  []string
}

func (s *source) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	status, stopAt, hang, corrupt := s.status, s.stopAt, s.hang, s.corrupt
	s.ranges = append(s.ranges, r.Header.Get("Range"))
	s.stopAt = 0
	s.mu.Unlock()
	if status != 0 {
		w.WriteHeader(status)
		return
	}
	body := s.body
	if corrupt {
		body = bytes.Repeat([]byte{'x'}, len(body))
	}
	var from int64
	if rg := r.Header.Get("Range"); rg != "" {
		from, _ = strconv.ParseInt(strings.TrimSuffix(strings.TrimPrefix(rg, "bytes="), "-"), 10, 64)
		if from >= int64(len(body)) {
			w.WriteHeader(http.StatusRequestedRangeNotSatisfiable)
			return
		}
		w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", from, len(body)-1, len(body)))
		w.WriteHeader(http.StatusPartialContent)
	}
	end := int64(len(body))
	if stopAt > from {
		end = stopAt
	}
	_, _ = w.Write(body[from:end])
	if hang != nil {
		w.(http.Flusher).Flush()
		<-hang
	}
}

func newFetcher(t *testing.T, src *source, free int64) (*Fetcher, models.Model, func()) {
	t.Helper()
	srv := httptest.NewServer(src)
	sum := sha256.Sum256(src.body)
	m := models.Model{ID: "parakeet", File: "parakeet.bin", URL: srv.URL + "/parakeet.bin", Size: int64(len(src.body)), SHA256: hex.EncodeToString(sum[:])}
	f := &Fetcher{
		Manifest: models.Manifest{Models: []models.Model{m}},
		Dir:      t.TempDir(),
		Client:   srv.Client(),
		Free:     func(string) (int64, error) { return free, nil },
		Backoff:  func(int) time.Duration { return 10 * time.Millisecond },
		Idle:     200 * time.Millisecond,
	}
	return f, m, srv.Close
}

func start(t *testing.T, f *Fetcher) context.CancelFunc {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	if err := f.Start(ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(cancel)
	return cancel
}

// until waits for the model's state (the fetcher works in its own goroutine).
func until(t *testing.T, f *Fetcher, state string) local.VoiceModelState {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		s := f.State().Models[0]
		if s.State == state {
			return s
		}
		if time.Now().After(deadline) {
			t.Fatalf("state %s, want %s (%+v)", s.State, state, s)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func body(n int) []byte {
	b := make([]byte, n)
	for i := range b {
		b[i] = byte(i * 7)
	}
	return b
}

func TestFetch(t *testing.T) {
	src := &source{body: body(3 << 20)}
	f, m, stop := newFetcher(t, src, 1<<40)
	defer stop()
	start(t, f)
	if s := f.State().Models[0]; s.State != "absent" || s.Size != m.Size {
		t.Fatalf("%+v", s)
	}
	if err := f.Fetch("parakeet"); err != nil {
		t.Fatal(err)
	}
	s := until(t, f, "ready")
	if s.Received != m.Size || !models.Present(f.Dir, m) {
		t.Fatalf("%+v", s)
	}
	if _, err := os.Stat(models.PartPath(f.Dir, m)); !os.IsNotExist(err) {
		t.Fatal("the part file stays")
	}
	// Asking again for a model that is there does nothing.
	if err := f.Fetch("parakeet"); err != nil || len(src.ranges) != 1 {
		t.Fatal(err, src.ranges)
	}
	if err := f.Fetch("canary"); err != ErrUnknown {
		t.Fatal(err)
	}
	// Remove deletes it.
	if err := f.Remove("parakeet"); err != nil || models.Present(f.Dir, m) || f.State().Models[0].State != "absent" {
		t.Fatal(err)
	}
}

func TestFetchResumes(t *testing.T) {
	src := &source{body: body(3 << 20), stopAt: 1 << 20}
	f, m, stop := newFetcher(t, src, 1<<40)
	defer stop()
	start(t, f)
	_ = f.Fetch("parakeet")
	until(t, f, "ready")
	if len(src.ranges) != 2 || src.ranges[0] != "" || src.ranges[1] != "bytes=1048576-" {
		t.Fatalf("requests %q", src.ranges)
	}
	if got, _ := os.ReadFile(models.Path(f.Dir, m)); !bytes.Equal(got, src.body) {
		t.Fatal("the bytes differ")
	}
}

func TestFetchSilentSourceWaitsAndResumes(t *testing.T) {
	src := &source{body: body(2 << 20), stopAt: 512 << 10, hang: make(chan struct{})}
	f, _, stop := newFetcher(t, src, 1<<40)
	defer stop()
	defer close(src.hang)
	start(t, f)
	_ = f.Fetch("parakeet")
	// The first response goes quiet after 512 KiB: the download stops (Idle), waits and resumes from there.
	src.mu.Lock()
	src.hang = nil
	src.mu.Unlock()
	until(t, f, "ready")
	if len(src.ranges) < 2 || src.ranges[len(src.ranges)-1] == "" {
		t.Fatalf("requests %q", src.ranges)
	}
}

func TestFetchDamaged(t *testing.T) {
	src := &source{body: body(1 << 20), corrupt: true}
	f, m, stop := newFetcher(t, src, 1<<40)
	defer stop()
	start(t, f)
	_ = f.Fetch("parakeet")
	// Wrong bytes twice: failed, nothing left, until asked again.
	s := until(t, f, "failed")
	if s.Problem == nil || *s.Problem != "bad_download" || len(src.ranges) != 2 || models.Present(f.Dir, m) {
		t.Fatalf("%+v %q", s, src.ranges)
	}
	if _, err := os.Stat(models.PartPath(f.Dir, m)); !os.IsNotExist(err) {
		t.Fatal("a damaged part stays")
	}
	src.mu.Lock()
	src.corrupt = false
	src.mu.Unlock()
	_ = f.Fetch("parakeet") // Try again
	until(t, f, "ready")
}

func TestFetchNoRoom(t *testing.T) {
	src := &source{body: body(1 << 20)}
	f, _, stop := newFetcher(t, src, 100<<20) // the model and the margin don't fit
	defer stop()
	start(t, f)
	_ = f.Fetch("parakeet")
	if s := until(t, f, "failed"); s.Problem == nil || *s.Problem != "no_room" || len(src.ranges) != 0 {
		t.Fatalf("%+v %q", s, src.ranges)
	}
}

func TestFetchRefusedAndServerErrors(t *testing.T) {
	src := &source{body: body(1 << 20), status: http.StatusNotFound}
	f, _, stop := newFetcher(t, src, 1<<40)
	defer stop()
	start(t, f)
	_ = f.Fetch("parakeet")
	if s := until(t, f, "failed"); s.Problem == nil || *s.Problem != "failed" {
		t.Fatalf("%+v", s)
	}
	// A server error waits and tries again by itself.
	src5 := &source{body: body(1 << 20), status: http.StatusServiceUnavailable}
	g, _, stop5 := newFetcher(t, src5, 1<<40)
	defer stop5()
	g.Backoff = func(int) time.Duration { return time.Hour }
	start(t, g)
	_ = g.Fetch("parakeet")
	deadline := time.Now().Add(5 * time.Second)
	for s := g.State().Models[0]; s.Problem == nil; s = g.State().Models[0] {
		if time.Now().After(deadline) {
			t.Fatalf("%+v", s)
		}
		time.Sleep(5 * time.Millisecond)
	}
	if s := g.State().Models[0]; s.State != "waiting" || *s.Problem != "failed" {
		t.Fatalf("%+v", s)
	}
}

func TestRemoveWhileDownloading(t *testing.T) {
	src := &source{body: body(2 << 20), stopAt: 256 << 10, hang: make(chan struct{})}
	f, m, stop := newFetcher(t, src, 1<<40)
	defer stop()
	defer close(src.hang)
	f.Idle = time.Hour
	start(t, f)
	_ = f.Fetch("parakeet")
	until(t, f, "downloading")
	for f.State().Models[0].Received == 0 {
		time.Sleep(5 * time.Millisecond)
	}
	if err := f.Remove("parakeet"); err != nil {
		t.Fatal(err)
	}
	if s := until(t, f, "absent"); s.Received != 0 {
		t.Fatalf("%+v", s)
	}
	time.Sleep(50 * time.Millisecond)
	if _, err := os.Stat(models.PartPath(f.Dir, m)); !os.IsNotExist(err) {
		t.Fatal("the part stays after Remove")
	}
}

func TestWantedSurvivesARestart(t *testing.T) {
	src := &source{body: body(1 << 20), status: http.StatusServiceUnavailable}
	f, m, stop := newFetcher(t, src, 1<<40)
	defer stop()
	f.Backoff = func(int) time.Duration { return time.Hour }
	cancel := start(t, f)
	_ = f.Fetch("parakeet")
	until(t, f, "waiting")
	cancel()
	b, _ := os.ReadFile(filepath.Join(f.Dir, wantedFile))
	var ids []string
	if err := json.Unmarshal(b, &ids); err != nil || len(ids) != 1 || ids[0] != "parakeet" {
		t.Fatalf("%s %v", b, err)
	}
	// A new fetcher over the same directory carries on by itself.
	src.mu.Lock()
	src.status = 0
	src.mu.Unlock()
	g := &Fetcher{Manifest: f.Manifest, Dir: f.Dir, Client: f.Client, Free: f.Free, Backoff: func(int) time.Duration { return 10 * time.Millisecond }}
	start(t, g)
	until(t, g, "ready")
	if !models.Present(g.Dir, m) {
		t.Fatal("not there")
	}
	if b, _ := os.ReadFile(filepath.Join(f.Dir, wantedFile)); string(b) != "[]" {
		t.Fatalf("%s", b)
	}
}

func TestBackoff(t *testing.T) {
	want := []time.Duration{30 * time.Second, time.Minute, 2 * time.Minute, 5 * time.Minute, 10 * time.Minute, 15 * time.Minute, 15 * time.Minute}
	for i, w := range want {
		if got := Backoff(i + 1); got != w {
			t.Errorf("Backoff(%d) = %s", i+1, got)
		}
	}
}

func TestServer(t *testing.T) {
	src := &source{body: body(1 << 20)}
	f, _, stop := newFetcher(t, src, 1<<40)
	defer stop()
	start(t, f)
	h := (&Server{Fetcher: f}).Handler()
	do := func(method, path, body string) (*httptest.ResponseRecorder, map[string]any) {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(method, path, strings.NewReader(body)))
		var out map[string]any
		_ = json.Unmarshal(rec.Body.Bytes(), &out)
		return rec, out
	}
	rec, _ := do(http.MethodGet, local.VoiceModelsPathState, "")
	if _, err := local.ParseVoiceModelsState(rec.Body.Bytes()); rec.Code != 200 || err != nil {
		t.Fatalf("%d %s %v", rec.Code, rec.Body, err)
	}
	if rec, _ := do(http.MethodPost, local.VoiceModelsPathFetch, `{"v":1,"model":"parakeet"}`); rec.Code != 200 {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
	until(t, f, "ready")
	for _, c := range []struct{ method, path, body string }{
		{http.MethodPost, local.VoiceModelsPathFetch, `{"v":1,"model":"canary"}`},
		{http.MethodPost, local.VoiceModelsPathFetch, `{"v":1,"model":"parakeet","url":"https://example.com"}`},
		{http.MethodPost, local.VoiceModelsPathRemove, `{`},
		{http.MethodPost, local.VoiceModelsPathState, ``},
		{http.MethodGet, "/v1/voice-models/elsewhere", ``},
	} {
		if rec, out := do(c.method, c.path, c.body); rec.Code < 400 || out["error"] == nil {
			t.Errorf("%s %s %s: %d %v", c.method, c.path, c.body, rec.Code, out)
		}
	}
	// whisper isn't in this manifest: unknown here too.
	if rec, _ := do(http.MethodPost, local.VoiceModelsPathRemove, `{"v":1,"model":"whisper"}`); rec.Code != 400 {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
	if rec, _ := do(http.MethodPost, local.VoiceModelsPathRemove, `{"v":1,"model":"parakeet"}`); rec.Code != 200 {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
}
