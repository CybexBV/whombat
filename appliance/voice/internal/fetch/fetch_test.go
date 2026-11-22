package fetch

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
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

// multiSource serves named files for a multi-file model, each backed by its own source.
type multiSource struct {
	files map[string]*source
}

func (m *multiSource) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimPrefix(r.URL.Path, "/")
	src, ok := m.files[name]
	if !ok {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	src.ServeHTTP(w, r)
}

func newMultiFetcher(t *testing.T, files map[string]*source, order []string, free int64) (*Fetcher, models.Model, func()) {
	t.Helper()
	srv := httptest.NewServer(&multiSource{files: files})
	var mf []models.File
	for _, name := range order {
		b := files[name].body
		sum := sha256.Sum256(b)
		mf = append(mf, models.File{
			Name:   name,
			URL:    srv.URL + "/" + name,
			Size:   int64(len(b)),
			SHA256: hex.EncodeToString(sum[:]),
		})
	}
	m := models.Model{ID: local.VoiceModelSupertonic, Dir: "supertonic-3-int8", Files: mf}
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

func TestFetchMultiAndRemove(t *testing.T) {
	files := map[string]*source{
		"a.onnx":  {body: body(512 << 10)},
		"b.onnx":  {body: body(256 << 10)},
		"LICENSE": {body: []byte("BigScience Open RAIL-M")},
	}
	f, m, stop := newMultiFetcher(t, files, []string{"a.onnx", "b.onnx", "LICENSE"}, 1<<40)
	defer stop()
	start(t, f)
	if s := f.State().Models[0]; s.ID != "supertonic" || s.State != "absent" || s.Size != m.TotalSize() {
		t.Fatalf("%+v", s)
	}
	h := (&Server{Fetcher: f}).Handler()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, local.VoiceModelsPathFetch, strings.NewReader(`{"v":1,"model":"supertonic"}`)))
	if rec.Code != 200 {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
	s := until(t, f, "ready")
	if s.Received != m.TotalSize() || !models.Present(f.Dir, m) {
		t.Fatalf("%+v", s)
	}
	if _, err := os.Stat(models.PartPath(f.Dir, m)); !os.IsNotExist(err) {
		t.Fatal("staging dir stays after ready")
	}
	for name, src := range files {
		got, err := os.ReadFile(filepath.Join(models.Path(f.Dir, m), name))
		if err != nil || !bytes.Equal(got, src.body) {
			t.Fatalf("%s: err=%v len=%d", name, err, len(got))
		}
	}
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, local.VoiceModelsPathRemove, strings.NewReader(`{"v":1,"model":"supertonic"}`)))
	if rec.Code != 200 || models.Present(f.Dir, m) || f.State().Models[0].State != "absent" {
		t.Fatalf("%d %+v", rec.Code, f.State().Models[0])
	}
	if _, err := os.Stat(models.Path(f.Dir, m)); !os.IsNotExist(err) {
		t.Fatal("model dir stays after remove")
	}
}

func TestFetchMultiResumesMidFileAndAcrossRestart(t *testing.T) {
	files := map[string]*source{
		"a.onnx": {body: body(256 << 10)},
		"b.onnx": {body: body(512 << 10), stopAt: 128 << 10},
		"c.bin":  {body: body(64 << 10), status: http.StatusServiceUnavailable},
	}
	f, m, stop := newMultiFetcher(t, files, []string{"a.onnx", "b.onnx", "c.bin"}, 1<<40)
	defer stop()
	// First drop (b.onnx mid-file) resumes right away; second drop (c.bin 503) pauses so we can test restart.
	f.Backoff = func(n int) time.Duration {
		if n == 1 {
			return 5 * time.Millisecond
		}
		return time.Hour
	}
	cancel := start(t, f)
	_ = f.Fetch("supertonic")
	deadline := time.Now().Add(5 * time.Second)
	for {
		s := f.State().Models[0]
		if s.State == "waiting" && s.Received == int64(len(files["a.onnx"].body)+len(files["b.onnx"].body)) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("did not pause at c.bin: %+v", s)
		}
		time.Sleep(5 * time.Millisecond)
	}
	// Final dir must not exist while incomplete.
	if models.Present(f.Dir, m) {
		t.Fatal("final dir exposed before all files verified")
	}
	cancel()
	// supertonic is never persisted to .wanted.json, and even if a pre-upgrade
	// .wanted.json names it, startup must not resume it until the server asks again.
	if b, err := os.ReadFile(filepath.Join(f.Dir, wantedFile)); err == nil && strings.Contains(string(b), local.VoiceModelSupertonic) {
		t.Fatalf("supertonic written to %s: %s", wantedFile, b)
	}
	if err := os.WriteFile(filepath.Join(f.Dir, wantedFile), []byte(`["supertonic"]`), 0o640); err != nil {
		t.Fatal(err)
	}
	// Restart fetcher over same dir with c.bin now available: must NOT auto-resume.
	files["c.bin"].mu.Lock()
	files["c.bin"].status = 0
	cBefore := len(files["c.bin"].ranges)
	files["c.bin"].mu.Unlock()
	g := &Fetcher{Manifest: f.Manifest, Dir: f.Dir, Client: f.Client, Free: f.Free, Backoff: func(int) time.Duration { return 10 * time.Millisecond }}
	start(t, g)
	time.Sleep(50 * time.Millisecond)
	s := g.State().Models[0]
	if s.State != local.VoiceModelStateAbsent {
		t.Fatalf("supertonic auto-resumed at startup: %+v", s)
	}
	if s.Received < int64(len(files["a.onnx"].body)+len(files["b.onnx"].body)) {
		t.Fatalf("lost partial progress on restart: %d", s.Received)
	}
	files["c.bin"].mu.Lock()
	cAfterStartup := len(files["c.bin"].ranges)
	files["c.bin"].mu.Unlock()
	if cAfterStartup != cBefore {
		t.Fatalf("supertonic requested c.bin at startup without Fetch: before=%d after=%d", cBefore, cAfterStartup)
	}
	// When the server asks again (setting still on), it resumes without re-downloading a.onnx or b.onnx.
	if err := g.Fetch(local.VoiceModelSupertonic); err != nil {
		t.Fatal(err)
	}
	until(t, g, "ready")
	if !models.Present(g.Dir, m) {
		t.Fatal("not present after restart resume")
	}
	if len(files["a.onnx"].ranges) != 1 {
		t.Fatalf("a.onnx re-downloaded: %q", files["a.onnx"].ranges)
	}
	if len(files["b.onnx"].ranges) != 2 || files["b.onnx"].ranges[1] != "bytes=131072-" {
		t.Fatalf("b.onnx ranges: %q", files["b.onnx"].ranges)
	}
}

func TestFetchMultiDamagedAndNoRoom(t *testing.T) {
	// Damaged second file: first file stays verified across retry, final dir never exposed, staging removed on second bad download.
	files := map[string]*source{
		"a.onnx": {body: body(64 << 10)},
		"b.onnx": {body: body(64 << 10), corrupt: true},
	}
	f, m, stop := newMultiFetcher(t, files, []string{"a.onnx", "b.onnx"}, 1<<40)
	defer stop()
	start(t, f)
	_ = f.Fetch("supertonic")
	s := until(t, f, "failed")
	if s.Problem == nil || *s.Problem != "bad_download" || models.Present(f.Dir, m) {
		t.Fatalf("%+v", s)
	}
	if _, err := os.Stat(models.PartPath(f.Dir, m)); !os.IsNotExist(err) {
		t.Fatal("staging dir stays after terminal bad_download")
	}
	if len(files["a.onnx"].ranges) != 1 || len(files["b.onnx"].ranges) != 2 {
		t.Fatalf("ranges a=%q b=%q", files["a.onnx"].ranges, files["b.onnx"].ranges)
	}
	// Recover once fixed.
	files["b.onnx"].mu.Lock()
	files["b.onnx"].corrupt = false
	files["b.onnx"].mu.Unlock()
	_ = f.Fetch("supertonic")
	until(t, f, "ready")

	// No room: refuses before making any request.
	files2 := map[string]*source{
		"a.onnx": {body: body(64 << 10)},
		"b.onnx": {body: body(64 << 10)},
	}
	g, _, stop2 := newMultiFetcher(t, files2, []string{"a.onnx", "b.onnx"}, 100<<20)
	defer stop2()
	start(t, g)
	_ = g.Fetch("supertonic")
	if s := until(t, g, "failed"); s.Problem == nil || *s.Problem != "no_room" || len(files2["a.onnx"].ranges) != 0 {
		t.Fatalf("%+v %q", s, files2["a.onnx"].ranges)
	}
}

func TestRemoveMultiWhileDownloading(t *testing.T) {
	files := map[string]*source{
		"a.onnx": {body: body(64 << 10)},
		"b.onnx": {body: body(256 << 10), stopAt: 64 << 10, hang: make(chan struct{})},
	}
	f, m, stop := newMultiFetcher(t, files, []string{"a.onnx", "b.onnx"}, 1<<40)
	defer stop()
	defer close(files["b.onnx"].hang)
	f.Idle = time.Hour
	start(t, f)
	_ = f.Fetch("supertonic")
	until(t, f, "downloading")
	for f.State().Models[0].Received < int64(len(files["a.onnx"].body)) {
		time.Sleep(5 * time.Millisecond)
	}
	if err := f.Remove("supertonic"); err != nil {
		t.Fatal(err)
	}
	if s := until(t, f, "absent"); s.Received != 0 {
		t.Fatalf("%+v", s)
	}
	time.Sleep(50 * time.Millisecond)
	if _, err := os.Stat(models.PartPath(f.Dir, m)); !os.IsNotExist(err) {
		t.Fatal("staging dir stays after Remove")
	}
	if _, err := os.Stat(models.Path(f.Dir, m)); !os.IsNotExist(err) {
		t.Fatal("final dir stays after Remove")
	}
}

// TestServerV1RollbackCompatibility ensures plain v1 requests omit supertonic so a previous runtime whose
// VoiceModelsState schema only accepts speech-recognition models (parakeet, whisper) still parses every response,
// while callers opting in via ?include=supertonic (or naming supertonic in fetch/remove) receive it.
func TestServerV1RollbackCompatibility(t *testing.T) {
	pBody := body(16 << 10)
	wBody := body(16 << 10)
	sBody := body(16 << 10)
	srv := httptest.NewServer(&multiSource{files: map[string]*source{
		"parakeet.bin": {body: pBody},
		"whisper.bin":  {body: wBody},
		"a.onnx":       {body: sBody},
	}})
	defer srv.Close()
	sumOf := func(b []byte) string {
		s := sha256.Sum256(b)
		return hex.EncodeToString(s[:])
	}
	f := &Fetcher{
		Manifest: models.Manifest{Models: []models.Model{
			{ID: local.VoiceModelParakeet, File: "parakeet.bin", URL: srv.URL + "/parakeet.bin", Size: int64(len(pBody)), SHA256: sumOf(pBody)},
			{ID: local.VoiceModelWhisper, File: "whisper.bin", URL: srv.URL + "/whisper.bin", Size: int64(len(wBody)), SHA256: sumOf(wBody)},
			{ID: local.VoiceModelSupertonic, Dir: "supertonic-3-int8", Files: []models.File{
				{Name: "a.onnx", URL: srv.URL + "/a.onnx", Size: int64(len(sBody)), SHA256: sumOf(sBody)},
			}},
		}},
		Dir:     t.TempDir(),
		Client:  srv.Client(),
		Free:    func(string) (int64, error) { return 1 << 40, nil },
		Backoff: func(int) time.Duration { return 10 * time.Millisecond },
		Idle:    200 * time.Millisecond,
	}
	start(t, f)
	h := (&Server{Fetcher: f}).Handler()

	// Previous runtime's strict v1 schema: only speech-recognition models (parakeet, whisper) and pre-removing states.
	parsePrevRuntime := func(raw []byte) (*local.VoiceModelsState, error) {
		st, err := local.ParseVoiceModelsState(raw)
		if err != nil {
			return st, err
		}
		for _, m := range st.Models {
			if m.ID != local.VoiceModelParakeet && m.ID != local.VoiceModelWhisper {
				return st, fmt.Errorf("previous runtime rejects unknown model id %q", m.ID)
			}
			if m.State == local.VoiceModelStateRemoving {
				return st, fmt.Errorf("previous runtime rejects state %q", m.State)
			}
		}
		return st, nil
	}
	call := func(method, path, reqBody string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(method, path, strings.NewReader(reqBody)))
		if rec.Code != http.StatusOK {
			t.Fatalf("%s %s: status %d: %s", method, path, rec.Code, rec.Body)
		}
		return rec
	}

	// Plain GET /v1/voice-models, POST fetch(parakeet), POST remove(parakeet): parsed by previous runtime, no supertonic.
	for _, tc := range []struct{ name, method, path, body string }{
		{"state", http.MethodGet, local.VoiceModelsPathState, ""},
		{"fetch parakeet", http.MethodPost, local.VoiceModelsPathFetch, `{"v":1,"model":"parakeet"}`},
		{"remove parakeet", http.MethodPost, local.VoiceModelsPathRemove, `{"v":1,"model":"parakeet"}`},
	} {
		rec := call(tc.method, tc.path, tc.body)
		st, err := parsePrevRuntime(rec.Body.Bytes())
		if err != nil {
			t.Fatalf("%s failed previous runtime schema: %v (%s)", tc.name, err, rec.Body)
		}
		if len(st.Models) != 2 || st.Models[0].ID != local.VoiceModelParakeet || st.Models[1].ID != local.VoiceModelWhisper {
			t.Fatalf("%s models = %+v", tc.name, st.Models)
		}
	}

	// New runtime asks with ?include=supertonic (or names supertonic in fetch/remove): supertonic is returned.
	for _, tc := range []struct{ name, method, path, body string }{
		{"state include", http.MethodGet, local.VoiceModelsPathState + "?" + local.VoiceModelsIncludeParam + "=" + local.VoiceModelSupertonic, ""},
		{"fetch supertonic", http.MethodPost, local.VoiceModelsPathFetch, `{"v":1,"model":"supertonic"}`},
		{"remove supertonic", http.MethodPost, local.VoiceModelsPathRemove, `{"v":1,"model":"supertonic"}`},
	} {
		rec := call(tc.method, tc.path, tc.body)
		st, err := local.ParseVoiceModelsState(rec.Body.Bytes())
		if err != nil {
			t.Fatalf("%s failed current schema: %v (%s)", tc.name, err, rec.Body)
		}
		if len(st.Models) != 3 || st.Models[2].ID != local.VoiceModelSupertonic {
			t.Fatalf("%s models = %+v", tc.name, st.Models)
		}
		if _, err := parsePrevRuntime(rec.Body.Bytes()); err == nil {
			t.Fatalf("%s unexpectedly accepted by previous runtime schema", tc.name)
		}
	}

	// Even while a default model has leftover files ("removing"), plain v1 stays parseable by a rolled-back runtime
	// while ?include=supertonic exposes "removing" and remaining bytes.
	if err := f.Fetch(local.VoiceModelParakeet); err != nil {
		t.Fatal(err)
	}
	until(t, f, local.VoiceModelStateReady)
	var failDelete atomic.Bool
	failDelete.Store(true)
	f.mu.Lock()
	f.removeAll = func(p string) error {
		if failDelete.Load() {
			return fmt.Errorf("simulated delete failure")
		}
		return os.RemoveAll(p)
	}
	f.mu.Unlock()
	if err := f.Remove(local.VoiceModelParakeet); err == nil {
		t.Fatal("expected remove failure")
	}
	plainRec := call(http.MethodGet, local.VoiceModelsPathState, "")
	plainSt, err := parsePrevRuntime(plainRec.Body.Bytes())
	if err != nil {
		t.Fatalf("plain state during removing failed previous runtime schema: %v (%s)", err, plainRec.Body)
	}
	if plainSt.Models[0].State != local.VoiceModelStateAbsent || plainSt.Models[0].Received != 0 {
		t.Fatalf("unexpected plain state during removing: %+v", plainSt.Models[0])
	}
	incRec := call(http.MethodGet, local.VoiceModelsPathState+"?"+local.VoiceModelsIncludeParam+"="+local.VoiceModelSupertonic, "")
	incSt, err := local.ParseVoiceModelsState(incRec.Body.Bytes())
	if err != nil {
		t.Fatalf("include state during removing failed current schema: %v (%s)", err, incRec.Body)
	}
	if incSt.Models[0].State != local.VoiceModelStateRemoving || incSt.Models[0].Received != int64(len(pBody)) {
		t.Fatalf("expected removing with %d bytes left, got %+v", len(pBody), incSt.Models[0])
	}
	failDelete.Store(false)
	if err := f.Remove(local.VoiceModelParakeet); err != nil {
		t.Fatal(err)
	}
}

// gatedTransport lets a test pause a specific download attempt mid-body (or right before EOF) until Remove and Fetch
// have run, reproducing the race deterministically without depending on timing.
type gatedTransport struct {
	base    http.RoundTripper
	gateURL string // suffix match, empty matches every URL
	chunk   int    // bytes to deliver before blocking (<=0 delivers the whole body before blocking at EOF)
	atGate  chan struct{}
	release chan struct{}
	once    sync.Once
	armed   atomic.Bool
	reqs    atomic.Int32
}

func (g *gatedTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	g.reqs.Add(1)
	resp, err := g.base.RoundTrip(req)
	if err != nil {
		return nil, err
	}
	if (g.gateURL == "" || strings.HasSuffix(req.URL.Path, g.gateURL)) && g.armed.CompareAndSwap(false, true) {
		resp.Body = &gatedBody{
			rc:      resp.Body,
			ctx:     req.Context(),
			chunk:   g.chunk,
			atGate:  g.atGate,
			release: g.release,
			once:    &g.once,
		}
	}
	return resp, nil
}

type gatedBody struct {
	rc      io.ReadCloser
	ctx     context.Context
	chunk   int
	sent    int
	atGate  chan struct{}
	release chan struct{}
	once    *sync.Once
	gated   bool
}

func (b *gatedBody) Read(p []byte) (int, error) {
	if b.chunk > 0 {
		if b.sent < b.chunk {
			if rem := b.chunk - b.sent; len(p) > rem {
				p = p[:rem]
			}
			n, err := b.rc.Read(p)
			b.sent += n
			return n, err
		}
		if !b.gated {
			b.gated = true
			b.once.Do(func() { close(b.atGate) })
			<-b.release
		}
		if err := b.ctx.Err(); err != nil {
			return 0, err
		}
		return b.rc.Read(p)
	}
	n, err := b.rc.Read(p)
	if err == io.EOF && !b.gated {
		b.gated = true
		b.once.Do(func() { close(b.atGate) })
		<-b.release
	}
	return n, err
}

func (b *gatedBody) Close() error { return b.rc.Close() }

func TestRemoveThenFetchDuringDownloadRestartsImmediately(t *testing.T) {
	t.Run("supertonic multi-file", func(t *testing.T) {
		files := map[string]*source{
			"a.onnx": {body: body(64 << 10)},
			"b.onnx": {body: body(256 << 10)},
		}
		f, m, stop := newMultiFetcher(t, files, []string{"a.onnx", "b.onnx"}, 1<<40)
		defer stop()
		gt := &gatedTransport{
			base:    f.Client.Transport,
			gateURL: "/b.onnx",
			chunk:   32 << 10,
			atGate:  make(chan struct{}),
			release: make(chan struct{}),
		}
		if gt.base == nil {
			gt.base = http.DefaultTransport
		}
		f.Client = &http.Client{Transport: gt}
		f.Idle = time.Hour
		var backoffCalls atomic.Int32
		f.Backoff = func(int) time.Duration {
			backoffCalls.Add(1)
			return 30 * time.Second
		}
		start(t, f)

		if err := f.Fetch(local.VoiceModelSupertonic); err != nil {
			t.Fatal(err)
		}
		<-gt.atGate

		// Quickly toggle off then on while the first attempt is still unwinding.
		if err := f.Remove(local.VoiceModelSupertonic); err != nil {
			t.Fatal(err)
		}
		if err := f.Fetch(local.VoiceModelSupertonic); err != nil {
			t.Fatal(err)
		}
		close(gt.release)

		s := until(t, f, local.VoiceModelStateReady)
		if backoffCalls.Load() != 0 {
			t.Fatalf("expected 0 backoff calls after Remove+Fetch, got %d", backoffCalls.Load())
		}
		if s.Problem != nil || s.Received != m.TotalSize() || !models.Present(f.Dir, m) {
			t.Fatalf("unexpected ready state: %+v", s)
		}
		if _, err := os.Stat(models.PartPath(f.Dir, m)); !os.IsNotExist(err) {
			t.Fatal("staging dir left behind")
		}
		for name, src := range files {
			got, err := os.ReadFile(filepath.Join(models.Path(f.Dir, m), name))
			if err != nil || !bytes.Equal(got, src.body) {
				t.Fatalf("%s: err=%v len=%d", name, err, len(got))
			}
		}
	})

	t.Run("parakeet single-file", func(t *testing.T) {
		src := &source{body: body(256 << 10)}
		f, m, stop := newFetcher(t, src, 1<<40)
		defer stop()
		gt := &gatedTransport{
			base:    f.Client.Transport,
			chunk:   32 << 10,
			atGate:  make(chan struct{}),
			release: make(chan struct{}),
		}
		if gt.base == nil {
			gt.base = http.DefaultTransport
		}
		f.Client = &http.Client{Transport: gt}
		f.Idle = time.Hour
		var backoffCalls atomic.Int32
		f.Backoff = func(int) time.Duration {
			backoffCalls.Add(1)
			return 30 * time.Second
		}
		start(t, f)

		if err := f.Fetch(local.VoiceModelParakeet); err != nil {
			t.Fatal(err)
		}
		<-gt.atGate

		if err := f.Remove(local.VoiceModelParakeet); err != nil {
			t.Fatal(err)
		}
		if err := f.Fetch(local.VoiceModelParakeet); err != nil {
			t.Fatal(err)
		}
		close(gt.release)

		s := until(t, f, local.VoiceModelStateReady)
		if backoffCalls.Load() != 0 {
			t.Fatalf("expected 0 backoff calls after Remove+Fetch, got %d", backoffCalls.Load())
		}
		if s.Problem != nil || s.Received != m.Size || !models.Present(f.Dir, m) {
			t.Fatalf("unexpected ready state: %+v", s)
		}
		if got, err := os.ReadFile(models.Path(f.Dir, m)); err != nil || !bytes.Equal(got, src.body) {
			t.Fatalf("downloaded bytes mismatch: err=%v len=%d", err, len(got))
		}
	})
}

// If an old attempt has already finished reading all bytes when Remove+Fetch runs, it must neither commit the removed
// model's files nor mark it ready prematurely; the fresh Fetch downloads cleanly with no backoff.
func TestRemoveThenFetchRaceAtDownloadCompletion(t *testing.T) {
	src := &source{body: body(128 << 10)}
	f, m, stop := newFetcher(t, src, 1<<40)
	defer stop()
	gt := &gatedTransport{
		base:    f.Client.Transport,
		chunk:   0, // pause right at EOF after all bytes were read
		atGate:  make(chan struct{}),
		release: make(chan struct{}),
	}
	if gt.base == nil {
		gt.base = http.DefaultTransport
	}
	f.Client = &http.Client{Transport: gt}
	f.Idle = time.Hour
	var backoffCalls atomic.Int32
	f.Backoff = func(int) time.Duration {
		backoffCalls.Add(1)
		return 30 * time.Second
	}
	start(t, f)

	if err := f.Fetch(local.VoiceModelParakeet); err != nil {
		t.Fatal(err)
	}
	<-gt.atGate

	if err := f.Remove(local.VoiceModelParakeet); err != nil {
		t.Fatal(err)
	}
	if err := f.Fetch(local.VoiceModelParakeet); err != nil {
		t.Fatal(err)
	}
	close(gt.release)

	s := until(t, f, local.VoiceModelStateReady)
	if backoffCalls.Load() != 0 {
		t.Fatalf("expected 0 backoff calls, got %d", backoffCalls.Load())
	}
	if gt.reqs.Load() != 2 {
		t.Fatalf("expected fresh second request after Remove+Fetch at EOF, got %d", gt.reqs.Load())
	}
	if s.Problem != nil || !models.Present(f.Dir, m) {
		t.Fatalf("unexpected state: %+v", s)
	}
}

// Toggling off, on, and off again while the first attempt is still unwinding leaves the model absent with no stray
// files and no extra download started.
func TestRemoveThenFetchThenRemoveDuringDownload(t *testing.T) {
	src := &source{body: body(256 << 10)}
	f, m, stop := newFetcher(t, src, 1<<40)
	defer stop()
	gt := &gatedTransport{
		base:    f.Client.Transport,
		chunk:   32 << 10,
		atGate:  make(chan struct{}),
		release: make(chan struct{}),
	}
	if gt.base == nil {
		gt.base = http.DefaultTransport
	}
	f.Client = &http.Client{Transport: gt}
	f.Idle = time.Hour
	var backoffCalls atomic.Int32
	f.Backoff = func(int) time.Duration {
		backoffCalls.Add(1)
		return 30 * time.Second
	}
	start(t, f)

	if err := f.Fetch(local.VoiceModelParakeet); err != nil {
		t.Fatal(err)
	}
	<-gt.atGate

	if err := f.Remove(local.VoiceModelParakeet); err != nil {
		t.Fatal(err)
	}
	if err := f.Fetch(local.VoiceModelParakeet); err != nil {
		t.Fatal(err)
	}
	if err := f.Remove(local.VoiceModelParakeet); err != nil {
		t.Fatal(err)
	}
	close(gt.release)

	// Wait until the loop has settled after unwinding the cancelled attempt.
	deadline := time.Now().Add(2 * time.Second)
	for {
		if _, err := os.Stat(models.PartPath(f.Dir, m)); os.IsNotExist(err) {
			if _, err2 := os.Stat(models.Path(f.Dir, m)); os.IsNotExist(err2) {
				break
			}
		}
		if time.Now().After(deadline) {
			t.Fatal("files left behind after Remove+Fetch+Remove")
		}
		time.Sleep(5 * time.Millisecond)
	}
	s := f.State().Models[0]
	if s.State != local.VoiceModelStateAbsent || s.Received != 0 || s.Problem != nil {
		t.Fatalf("unexpected state after Remove+Fetch+Remove: %+v", s)
	}
	if backoffCalls.Load() != 0 || gt.reqs.Load() != 1 {
		t.Fatalf("unexpected backoff=%d reqs=%d", backoffCalls.Load(), gt.reqs.Load())
	}
}

func TestRemoveDoesNotHoldLockWhileDeleting(t *testing.T) {
	files := map[string]*source{
		"a.onnx": {body: body(64 << 10)},
		"b.onnx": {body: body(64 << 10)},
	}
	f, m, stop := newMultiFetcher(t, files, []string{"a.onnx", "b.onnx"}, 1<<40)
	defer stop()
	entered := make(chan string, 2)
	release := make(chan struct{})
	var gateOnce sync.Once
	f.removeAll = func(p string) error {
		gateOnce.Do(func() {
			entered <- p
			<-release
		})
		return os.RemoveAll(p)
	}
	start(t, f)
	if err := f.Fetch(local.VoiceModelSupertonic); err != nil {
		t.Fatal(err)
	}
	until(t, f, local.VoiceModelStateReady)

	errCh := make(chan error, 1)
	go func() {
		errCh <- f.Remove(local.VoiceModelSupertonic)
	}()

	trashPath := <-entered
	if !strings.HasPrefix(filepath.Base(trashPath), trashPrefix) {
		t.Fatalf("expected renamed-aside trash path, got %q", trashPath)
	}
	// While os.RemoveAll is blocked, State and progress updates must not stall waiting on f.mu, and the model path is
	// already gone.
	stateDone := make(chan local.VoiceModelsState, 1)
	go func() {
		f.progress(f.entries[local.VoiceModelSupertonic], 0, 123)
		stateDone <- f.State()
	}()
	select {
	case st := <-stateDone:
		if st.Models[0].State != local.VoiceModelStateRemoving || st.Models[0].Received != m.TotalSize() {
			t.Fatalf("unexpected state during delete: %+v", st.Models[0])
		}
	case <-time.After(time.Second):
		t.Fatal("State or progress stalled while Remove was deleting files")
	}
	if models.Present(f.Dir, m) {
		t.Fatal("model still present at final path during Remove deletion")
	}

	close(release)
	if err := <-errCh; err != nil {
		t.Fatal(err)
	}
	if s := f.State().Models[0]; s.State != local.VoiceModelStateAbsent || s.Received != 0 {
		t.Fatalf("unexpected state after delete finished: %+v", s)
	}
	if _, err := os.Stat(trashPath); !os.IsNotExist(err) {
		t.Fatalf("trash path left behind: %v", err)
	}
}

func TestCommitRenameDoesNotHoldLockWhileDeletingStaleDest(t *testing.T) {
	files := map[string]*source{
		"a.onnx": {body: body(64 << 10)},
		"b.onnx": {body: body(64 << 10)},
	}
	f, m, stop := newMultiFetcher(t, files, []string{"a.onnx", "b.onnx"}, 1<<40)
	defer stop()
	// Pre-create an incomplete directory at the final path so commitRename must displace and delete it.
	stale := models.Path(f.Dir, m)
	if err := os.MkdirAll(stale, 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(stale, "stale.tmp"), []byte("leftover"), 0o640); err != nil {
		t.Fatal(err)
	}

	entered := make(chan string, 1)
	release := make(chan struct{})
	var gateOnce sync.Once
	f.removeAll = func(p string) error {
		if strings.HasPrefix(filepath.Base(p), trashPrefix) {
			gateOnce.Do(func() {
				entered <- p
				<-release
			})
		}
		return os.RemoveAll(p)
	}
	start(t, f)
	if err := f.Fetch(local.VoiceModelSupertonic); err != nil {
		t.Fatal(err)
	}

	trashPath := <-entered
	// While the stale destination folder is being deleted, f.mu is unlocked and the verified model is already in place.
	stateDone := make(chan local.VoiceModelsState, 1)
	go func() { stateDone <- f.State() }()
	select {
	case <-stateDone:
	case <-time.After(time.Second):
		t.Fatal("State stalled while commitRename was deleting stale destination")
	}
	if !models.Present(f.Dir, m) {
		t.Fatal("verified model not yet in place during stale destination cleanup")
	}

	close(release)
	until(t, f, local.VoiceModelStateReady)
	if _, err := os.Stat(trashPath); !os.IsNotExist(err) {
		t.Fatalf("stale trash path left behind: %v", err)
	}
}

func TestStartCleansLeftoverTrash(t *testing.T) {
	src := &source{body: body(64 << 10)}
	f, m, stop := newFetcher(t, src, 1<<40)
	defer stop()

	// Seed a ready model, a partial file, .wanted.json, and two leftover .removing-* entries (a file and a folder).
	if err := os.WriteFile(models.Path(f.Dir, m), src.body, 0o640); err != nil {
		t.Fatal(err)
	}
	trashDir := filepath.Join(f.Dir, trashPrefix+"1-1")
	if err := os.MkdirAll(filepath.Join(trashDir, "nested"), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(trashDir, "nested", "old.onnx"), []byte("stale"), 0o640); err != nil {
		t.Fatal(err)
	}
	trashFile := filepath.Join(f.Dir, trashPrefix+"1-2")
	if err := os.WriteFile(trashFile, []byte("stale"), 0o640); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(f.Dir, wantedFile), []byte("[]"), 0o640); err != nil {
		t.Fatal(err)
	}

	start(t, f)

	for _, p := range []string{trashDir, trashFile} {
		if _, err := os.Stat(p); !os.IsNotExist(err) {
			t.Fatalf("leftover trash %s was not cleaned at Start: %v", p, err)
		}
	}
	if !models.Present(f.Dir, m) {
		t.Fatal("ready model removed by startup cleanup")
	}
	if _, err := os.Stat(filepath.Join(f.Dir, wantedFile)); err != nil {
		t.Fatalf("wanted file removed by startup cleanup: %v", err)
	}
}

func TestRemoveRetriesRenamedAsideTrashUntilGone(t *testing.T) {
	files := map[string]*source{
		"a.onnx":  {body: body(64 << 10)},
		"b.onnx":  {body: body(64 << 10)},
		"LICENSE": {body: []byte("BigScience Open RAIL-M")},
	}
	f, m, stop := newMultiFetcher(t, files, []string{"a.onnx", "b.onnx", "LICENSE"}, 1<<40)
	defer stop()

	var failDelete atomic.Bool
	failDelete.Store(true)
	var attempts atomic.Int32
	f.removeAll = func(p string) error {
		attempts.Add(1)
		if failDelete.Load() {
			return fmt.Errorf("simulated delete failure on %s", filepath.Base(p))
		}
		return os.RemoveAll(p)
	}

	start(t, f)
	if err := f.Fetch(local.VoiceModelSupertonic); err != nil {
		t.Fatal(err)
	}
	until(t, f, local.VoiceModelStateReady)

	h := (&Server{Fetcher: f}).Handler()
	callRemove := func() *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, local.VoiceModelsPathRemove, strings.NewReader(`{"v":1,"model":"supertonic"}`)))
		return rec
	}

	// First removal stages the folder aside, fails deletion, and reports not removed yet.
	rec := callRemove()
	if rec.Code != http.StatusInternalServerError || !strings.Contains(rec.Body.String(), "not removed yet") {
		t.Fatalf("first remove: status=%d body=%s", rec.Code, rec.Body.String())
	}
	if models.Present(f.Dir, m) {
		t.Fatal("model still present at original path after staging")
	}
	trash, err := f.modelTrash(local.VoiceModelSupertonic)
	if err != nil || len(trash) != 1 {
		t.Fatalf("expected 1 renamed-aside folder on disk, got %v (err=%v)", trash, err)
	}

	// Second removal while deletion still fails must retry the renamed-aside folder and keep failing.
	rec = callRemove()
	if rec.Code != http.StatusInternalServerError || !strings.Contains(rec.Body.String(), "not removed yet") {
		t.Fatalf("second remove: status=%d body=%s", rec.Code, rec.Body.String())
	}
	if attempts.Load() < 2 {
		t.Fatalf("expected second remove to retry renamed-aside folder, attempts=%d", attempts.Load())
	}
	trash, err = f.modelTrash(local.VoiceModelSupertonic)
	if err != nil || len(trash) != 1 {
		t.Fatalf("renamed-aside folder disappeared unexpectedly: %v (err=%v)", trash, err)
	}

	// Once deletion can succeed, the next removal deletes the renamed-aside folder and succeeds.
	failDelete.Store(false)
	rec = callRemove()
	if rec.Code != http.StatusOK {
		t.Fatalf("third remove: status=%d body=%s", rec.Code, rec.Body.String())
	}
	trash, err = f.modelTrash(local.VoiceModelSupertonic)
	if err != nil || len(trash) != 0 {
		t.Fatalf("renamed-aside folder still remains after successful remove: %v (err=%v)", trash, err)
	}
}

func TestRemoveReportsNotRemovedWhenTrashRemainsAndIsolatesModels(t *testing.T) {
	pBody := body(16 << 10)
	sBody := body(16 << 10)
	srv := httptest.NewServer(&multiSource{files: map[string]*source{
		"parakeet.bin": {body: pBody},
		"a.onnx":       {body: sBody},
	}})
	defer srv.Close()
	sumOf := func(b []byte) string {
		s := sha256.Sum256(b)
		return hex.EncodeToString(s[:])
	}
	f := &Fetcher{
		Manifest: models.Manifest{Models: []models.Model{
			{ID: local.VoiceModelParakeet, File: "parakeet.bin", URL: srv.URL + "/parakeet.bin", Size: int64(len(pBody)), SHA256: sumOf(pBody)},
			{ID: local.VoiceModelSupertonic, Dir: "supertonic-3-int8", Files: []models.File{
				{Name: "a.onnx", URL: srv.URL + "/a.onnx", Size: int64(len(sBody)), SHA256: sumOf(sBody)},
			}},
		}},
		Dir:     t.TempDir(),
		Client:  srv.Client(),
		Free:    func(string) (int64, error) { return 1 << 40, nil },
		Backoff: func(int) time.Duration { return 10 * time.Millisecond },
		Idle:    200 * time.Millisecond,
	}

	var noopParakeet atomic.Bool
	noopParakeet.Store(true)
	f.removeAll = func(p string) error {
		if noopParakeet.Load() && strings.HasPrefix(filepath.Base(p), modelTrashPrefix(local.VoiceModelParakeet)) {
			// Return nil without deleting to verify Remove checks disk for remaining entries.
			return nil
		}
		return os.RemoveAll(p)
	}
	start(t, f)

	if err := f.Fetch(local.VoiceModelParakeet); err != nil {
		t.Fatal(err)
	}
	until(t, f, local.VoiceModelStateReady)

	// Parakeet's trash remains even though removeAll returned nil: Remove must report not removed yet.
	if err := f.Remove(local.VoiceModelParakeet); err == nil || !strings.Contains(err.Error(), "not removed yet") {
		t.Fatalf("expected not removed yet for parakeet, got %v", err)
	}

	// Supertonic removal is unaffected by parakeet's leftover trash.
	if err := f.Remove(local.VoiceModelSupertonic); err != nil {
		t.Fatalf("supertonic remove failed due to another model's trash: %v", err)
	}

	// Letting parakeet deletion actually run clears its renamed-aside entry on retry.
	noopParakeet.Store(false)
	if err := f.Remove(local.VoiceModelParakeet); err != nil {
		t.Fatalf("parakeet retry remove failed: %v", err)
	}
	trash, err := f.modelTrash(local.VoiceModelParakeet)
	if err != nil || len(trash) != 0 {
		t.Fatalf("parakeet trash remains: %v (err=%v)", trash, err)
	}
}

func TestConcurrentRemoveWaitsForInFlightDelete(t *testing.T) {
	files := map[string]*source{
		"a.onnx": {body: body(64 << 10)},
	}
	f, _, stop := newMultiFetcher(t, files, []string{"a.onnx"}, 1<<40)
	defer stop()

	entered := make(chan struct{})
	release := make(chan struct{})
	var calls atomic.Int32
	f.removeAll = func(p string) error {
		if calls.Add(1) == 1 {
			close(entered)
			<-release
		}
		return os.RemoveAll(p)
	}
	start(t, f)
	if err := f.Fetch(local.VoiceModelSupertonic); err != nil {
		t.Fatal(err)
	}
	until(t, f, local.VoiceModelStateReady)

	firstErr := make(chan error, 1)
	go func() { firstErr <- f.Remove(local.VoiceModelSupertonic) }()
	<-entered

	// A second concurrent Remove must not report success before the in-flight deletion finishes.
	secondErr := make(chan error, 1)
	go func() { secondErr <- f.Remove(local.VoiceModelSupertonic) }()

	select {
	case err := <-secondErr:
		t.Fatalf("second Remove returned before in-flight delete finished: %v", err)
	case <-time.After(40 * time.Millisecond):
	}

	close(release)
	if err := <-firstErr; err != nil {
		t.Fatalf("first Remove: %v", err)
	}
	if err := <-secondErr; err != nil {
		t.Fatalf("second Remove: %v", err)
	}
	if calls.Load() != 1 {
		t.Fatalf("expected 1 os.RemoveAll call, got %d", calls.Load())
	}
}

func TestRemoveLeftoversReportRemovingAndSurviveRestart(t *testing.T) {
	t.Run("supertonic multi-file", func(t *testing.T) {
		files := map[string]*source{
			"a.onnx":  {body: body(64 << 10)},
			"b.onnx":  {body: body(32 << 10)},
			"LICENSE": {body: []byte("BigScience Open RAIL-M")},
		}
		f, m, stop := newMultiFetcher(t, files, []string{"a.onnx", "b.onnx", "LICENSE"}, 1<<40)
		defer stop()

		var failDelete atomic.Bool
		failDelete.Store(true)
		deleteFn := func(p string) error {
			if failDelete.Load() {
				return fmt.Errorf("simulated delete failure on %s", filepath.Base(p))
			}
			return os.RemoveAll(p)
		}
		f.removeAll = deleteFn
		cancel1 := start(t, f)
		if err := f.Fetch(local.VoiceModelSupertonic); err != nil {
			t.Fatal(err)
		}
		until(t, f, local.VoiceModelStateReady)

		// First removal fails deletion: state reports "removing" with the remaining bytes instead of "absent"/0.
		if err := f.Remove(local.VoiceModelSupertonic); err == nil {
			t.Fatal("expected remove failure")
		}
		s := f.State().Models[0]
		if s.State != local.VoiceModelStateRemoving || s.Received != m.TotalSize() {
			t.Fatalf("after failed remove: want removing with %d bytes, got %+v", m.TotalSize(), s)
		}

		// Simulate a partial deletion leaving only b.onnx + LICENSE on disk, then restart the fetcher with startup
		// cleanup still failing: the restarted fetcher must report "removing" and the exact remaining bytes.
		trash, err := f.modelTrash(local.VoiceModelSupertonic)
		if err != nil || len(trash) != 1 {
			t.Fatalf("expected 1 trash folder, got %v (err=%v)", trash, err)
		}
		if err := os.Remove(filepath.Join(trash[0], "a.onnx")); err != nil {
			t.Fatal(err)
		}
		wantLeft := int64(len(files["b.onnx"].body) + len(files["LICENSE"].body))
		cancel1()

		g := &Fetcher{
			Manifest:  f.Manifest,
			Dir:       f.Dir,
			Client:    f.Client,
			Free:      f.Free,
			Backoff:   f.Backoff,
			Idle:      f.Idle,
			removeAll: deleteFn,
		}
		start(t, g)
		s = g.State().Models[0]
		if s.State != local.VoiceModelStateRemoving || s.Received != wantLeft {
			t.Fatalf("after restart with failed startup cleanup: want removing with %d bytes, got %+v", wantLeft, s)
		}

		// HTTP API with ?include=supertonic exposes the same removing state and remaining bytes.
		h := (&Server{Fetcher: g}).Handler()
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, local.VoiceModelsPathState+"?"+local.VoiceModelsIncludeParam+"="+local.VoiceModelSupertonic, nil))
		if rec.Code != http.StatusOK {
			t.Fatalf("GET state: %d %s", rec.Code, rec.Body)
		}
		apiState, err := local.ParseVoiceModelsState(rec.Body.Bytes())
		if err != nil {
			t.Fatalf("parse state: %v (%s)", err, rec.Body)
		}
		if len(apiState.Models) != 1 || apiState.Models[0].State != local.VoiceModelStateRemoving || apiState.Models[0].Received != wantLeft {
			t.Fatalf("HTTP state after restart = %+v, want removing/%d", apiState.Models, wantLeft)
		}

		// Once deletion can succeed, Remove clears the leftovers and transitions to absent with 0 bytes.
		failDelete.Store(false)
		if err := g.Remove(local.VoiceModelSupertonic); err != nil {
			t.Fatalf("retry remove after restart failed: %v", err)
		}
		s = g.State().Models[0]
		if s.State != local.VoiceModelStateAbsent || s.Received != 0 {
			t.Fatalf("after successful retry remove: want absent/0, got %+v", s)
		}
		if left, err := g.modelTrash(local.VoiceModelSupertonic); err != nil || len(left) != 0 {
			t.Fatalf("trash remains after successful remove: %v (err=%v)", left, err)
		}
	})

	t.Run("parakeet single-file", func(t *testing.T) {
		src := &source{body: body(48 << 10)}
		f, m, stop := newFetcher(t, src, 1<<40)
		defer stop()

		var failDelete atomic.Bool
		failDelete.Store(true)
		deleteFn := func(p string) error {
			if failDelete.Load() {
				return fmt.Errorf("simulated delete failure on %s", filepath.Base(p))
			}
			return os.RemoveAll(p)
		}
		f.removeAll = deleteFn
		cancel1 := start(t, f)
		if err := f.Fetch(local.VoiceModelParakeet); err != nil {
			t.Fatal(err)
		}
		until(t, f, local.VoiceModelStateReady)

		if err := f.Remove(local.VoiceModelParakeet); err == nil {
			t.Fatal("expected remove failure")
		}
		if s := f.State().Models[0]; s.State != local.VoiceModelStateRemoving || s.Received != m.Size {
			t.Fatalf("after failed remove: want removing/%d, got %+v", m.Size, s)
		}
		cancel1()

		g := &Fetcher{
			Manifest:  f.Manifest,
			Dir:       f.Dir,
			Client:    f.Client,
			Free:      f.Free,
			Backoff:   f.Backoff,
			Idle:      f.Idle,
			removeAll: deleteFn,
		}
		start(t, g)
		if s := g.State().Models[0]; s.State != local.VoiceModelStateRemoving || s.Received != m.Size {
			t.Fatalf("after restart: want removing/%d, got %+v", m.Size, s)
		}

		failDelete.Store(false)
		if err := g.Remove(local.VoiceModelParakeet); err != nil {
			t.Fatalf("retry remove failed: %v", err)
		}
		if s := g.State().Models[0]; s.State != local.VoiceModelStateAbsent || s.Received != 0 {
			t.Fatalf("after successful remove: want absent/0, got %+v", s)
		}
	})
}

func TestRemoveBeforeStageCreateCannotLeaveOrphanedFiles(t *testing.T) {
	t.Run("supertonic multi-file staging dir", func(t *testing.T) {
		files := map[string]*source{
			"a.onnx": {body: body(32 << 10)},
			"b.onnx": {body: body(32 << 10)},
		}
		f, m, stop := newMultiFetcher(t, files, []string{"a.onnx", "b.onnx"}, 1<<40)
		defer stop()

		atStage := make(chan struct{})
		releaseStage := make(chan struct{})
		var once sync.Once
		f.beforeCreate = func(id, p string) {
			if id == local.VoiceModelSupertonic && p == models.PartPath(f.Dir, m) {
				once.Do(func() {
					close(atStage)
					<-releaseStage
				})
			}
		}
		// Simulate worker cleanup failure if it were ever to recreate stage after Remove returned absent.
		var failDelete atomic.Bool
		f.removeAll = func(p string) error {
			if failDelete.Load() {
				return fmt.Errorf("simulated cleanup failure on %s", filepath.Base(p))
			}
			return os.RemoveAll(p)
		}
		runDone := make(chan struct{}, 1)
		f.onRunDone = func(id string) {
			if id == local.VoiceModelSupertonic {
				select {
				case runDone <- struct{}{}:
				default:
				}
			}
		}
		start(t, f)

		if err := f.Fetch(local.VoiceModelSupertonic); err != nil {
			t.Fatal(err)
		}
		<-atStage

		// Remove runs right before ensureStageDir acquires f.mu: nothing is on disk yet, so Remove succeeds cleanly.
		if err := f.Remove(local.VoiceModelSupertonic); err != nil {
			t.Fatalf("Remove: %v", err)
		}
		if s := f.State().Models[0]; s.State != local.VoiceModelStateAbsent || s.Received != 0 {
			t.Fatalf("state right after Remove = %+v, want absent/0", s)
		}
		// Even if any subsequent cleanup would fail, releasing the cancelled worker must never create stage.
		failDelete.Store(true)
		close(releaseStage)

		select {
		case <-runDone:
		case <-time.After(2 * time.Second):
			t.Fatal("worker did not finish unwinding")
		}
		if _, err := os.Stat(models.PartPath(f.Dir, m)); !os.IsNotExist(err) {
			t.Fatalf("cancelled download recreated staging folder: %v", err)
		}
		if _, err := os.Stat(models.Path(f.Dir, m)); !os.IsNotExist(err) {
			t.Fatalf("cancelled download created final folder: %v", err)
		}
		if trash, err := f.modelTrash(local.VoiceModelSupertonic); err != nil || len(trash) != 0 {
			t.Fatalf("unexpected trash left behind: %v (err=%v)", trash, err)
		}
		if s := f.State().Models[0]; s.State != local.VoiceModelStateAbsent || s.Received != 0 {
			t.Fatalf("final state = %+v, want absent/0", s)
		}
	})

	t.Run("parakeet single-file part", func(t *testing.T) {
		src := &source{body: body(32 << 10)}
		f, m, stop := newFetcher(t, src, 1<<40)
		defer stop()

		atPart := make(chan struct{})
		releasePart := make(chan struct{})
		var once sync.Once
		f.beforeCreate = func(id, p string) {
			if id == local.VoiceModelParakeet && p == models.PartPath(f.Dir, m) {
				once.Do(func() {
					close(atPart)
					<-releasePart
				})
			}
		}
		var failDelete atomic.Bool
		f.removeAll = func(p string) error {
			if failDelete.Load() {
				return fmt.Errorf("simulated cleanup failure on %s", filepath.Base(p))
			}
			return os.RemoveAll(p)
		}
		runDone := make(chan struct{}, 1)
		f.onRunDone = func(id string) {
			if id == local.VoiceModelParakeet {
				select {
				case runDone <- struct{}{}:
				default:
				}
			}
		}
		start(t, f)

		if err := f.Fetch(local.VoiceModelParakeet); err != nil {
			t.Fatal(err)
		}
		<-atPart

		if err := f.Remove(local.VoiceModelParakeet); err != nil {
			t.Fatalf("Remove: %v", err)
		}
		failDelete.Store(true)
		close(releasePart)

		select {
		case <-runDone:
		case <-time.After(2 * time.Second):
			t.Fatal("worker did not finish unwinding")
		}
		if _, err := os.Stat(models.PartPath(f.Dir, m)); !os.IsNotExist(err) {
			t.Fatalf("cancelled download recreated part file: %v", err)
		}
		if trash, err := f.modelTrash(local.VoiceModelParakeet); err != nil || len(trash) != 0 {
			t.Fatalf("unexpected trash left behind: %v (err=%v)", trash, err)
		}
		if s := f.State().Models[0]; s.State != local.VoiceModelStateAbsent || s.Received != 0 {
			t.Fatalf("final state = %+v, want absent/0", s)
		}
	})
}

func TestFetchKeepsReportingRemovingBytesWhileTrashRemains(t *testing.T) {
	t.Run("supertonic multi-file", func(t *testing.T) {
		files := map[string]*source{
			"a.onnx":  {body: body(64 << 10)},
			"b.onnx":  {body: body(32 << 10)},
			"LICENSE": {body: []byte("BigScience Open RAIL-M")},
		}
		f, m, stop := newMultiFetcher(t, files, []string{"a.onnx", "b.onnx", "LICENSE"}, 1<<40)
		defer stop()

		var failDelete atomic.Bool
		failDelete.Store(true)
		f.removeAll = func(p string) error {
			if failDelete.Load() {
				return fmt.Errorf("simulated delete failure on %s", filepath.Base(p))
			}
			return os.RemoveAll(p)
		}
		start(t, f)

		if err := f.Fetch(local.VoiceModelSupertonic); err != nil {
			t.Fatal(err)
		}
		until(t, f, local.VoiceModelStateReady)

		if err := f.Remove(local.VoiceModelSupertonic); err == nil {
			t.Fatal("expected remove failure while delete fails")
		}
		if s := f.State().Models[0]; s.State != local.VoiceModelStateRemoving || s.Received != m.TotalSize() {
			t.Fatalf("after failed remove = %+v, want removing/%d", s, m.TotalSize())
		}

		// Re-fetching while .removing-* trash still cannot be deleted must keep reporting removing + bytes left.
		if err := f.Fetch(local.VoiceModelSupertonic); err == nil || !strings.Contains(err.Error(), "not removed yet") {
			t.Fatalf("Fetch while trash remains: err = %v, want not removed yet", err)
		}
		if s := f.State().Models[0]; s.State != local.VoiceModelStateRemoving || s.Received != m.TotalSize() {
			t.Fatalf("after blocked Fetch = %+v, want removing/%d (bytes left must not vanish)", s, m.TotalSize())
		}

		// Once deletion can succeed, the next Fetch clears the trash and downloads the model cleanly.
		failDelete.Store(false)
		if err := f.Fetch(local.VoiceModelSupertonic); err != nil {
			t.Fatalf("Fetch after delete unblocked: %v", err)
		}
		s := until(t, f, local.VoiceModelStateReady)
		if s.Received != m.TotalSize() || !models.Present(f.Dir, m) {
			t.Fatalf("after recovery Fetch = %+v", s)
		}
		if trash, err := f.modelTrash(local.VoiceModelSupertonic); err != nil || len(trash) != 0 {
			t.Fatalf("trash left behind after recovery Fetch: %v (err=%v)", trash, err)
		}
	})

	t.Run("parakeet wanted at startup with leftover trash keeps reporting removing", func(t *testing.T) {
		src := &source{body: body(48 << 10)}
		f, m, stop := newFetcher(t, src, 1<<40)
		defer stop()

		var failDelete atomic.Bool
		failDelete.Store(true)
		deleteFn := func(p string) error {
			if failDelete.Load() {
				return fmt.Errorf("simulated delete failure on %s", filepath.Base(p))
			}
			return os.RemoveAll(p)
		}
		f.removeAll = deleteFn
		cancel1 := start(t, f)
		if err := f.Fetch(local.VoiceModelParakeet); err != nil {
			t.Fatal(err)
		}
		until(t, f, local.VoiceModelStateReady)
		if err := f.Remove(local.VoiceModelParakeet); err == nil {
			t.Fatal("expected remove failure")
		}
		// Simulate .wanted.json also naming parakeet at restart while its .removing-* trash is undeletable.
		if err := os.WriteFile(filepath.Join(f.Dir, wantedFile), []byte(`["parakeet"]`), 0o640); err != nil {
			t.Fatal(err)
		}
		cancel1()

		g := &Fetcher{
			Manifest:  f.Manifest,
			Dir:       f.Dir,
			Client:    f.Client,
			Free:      f.Free,
			Backoff:   f.Backoff,
			Idle:      f.Idle,
			removeAll: deleteFn,
		}
		start(t, g)
		if s := g.State().Models[0]; s.State != local.VoiceModelStateRemoving || s.Received != m.Size {
			t.Fatalf("startup with wanted + leftover trash = %+v, want removing/%d", s, m.Size)
		}
		if err := g.Fetch(local.VoiceModelParakeet); err == nil {
			t.Fatal("expected Fetch to stay blocked while trash remains")
		}
		if s := g.State().Models[0]; s.State != local.VoiceModelStateRemoving || s.Received != m.Size {
			t.Fatalf("after blocked Fetch = %+v, want removing/%d", s, m.Size)
		}

		failDelete.Store(false)
		if err := g.Fetch(local.VoiceModelParakeet); err != nil {
			t.Fatalf("Fetch after delete unblocked: %v", err)
		}
		s := until(t, g, local.VoiceModelStateReady)
		if s.Received != m.Size || !models.Present(g.Dir, m) {
			t.Fatalf("after recovery Fetch = %+v", s)
		}
		if trash, err := g.modelTrash(local.VoiceModelParakeet); err != nil || len(trash) != 0 {
			t.Fatalf("trash remains after recovery Fetch: %v (err=%v)", trash, err)
		}
	})
}
