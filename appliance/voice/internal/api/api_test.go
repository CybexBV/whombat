package api

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"math"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/helper/pkg/peercred"
	"github.com/CybexBV/whombat/appliance/voice/internal/jobs"
	"github.com/CybexBV/whombat/appliance/voice/internal/sound"
	"github.com/CybexBV/whombat/appliance/voice/internal/wav"
	"github.com/CybexBV/whombat/contracts/go/local"
)

type fakeEngine struct {
	stt, tts bool
	// models when set, else parakeet when stt.
	models    []string
	gpu       *local.VoiceGpu
	heard     string
	err       error
	gate      chan struct{} // when set, a job waits for it
	started   chan struct{}
	prompts   []string
	used      []string // the model of each job
	languages []string
	pieces    [][]time.Duration
	spoken    []string
	voices    []string
	// dutch: it speaks Dutch too (3.4); said the language of each answer ("": English).
	dutch bool
	said  []string
	jobs  int
}

func (f *fakeEngine) wait(ctx context.Context) error {
	f.jobs++
	if f.started != nil {
		f.started <- struct{}{}
	}
	if f.gate != nil {
		select {
		case <-f.gate:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return f.err
}

func (f *fakeEngine) Models() []string {
	if f.models != nil {
		return f.models
	}
	if f.stt {
		return []string{local.VoiceModelParakeet}
	}
	return nil
}

func (f *fakeEngine) GPU() *local.VoiceGpu { return f.gpu }

func (f *fakeEngine) Pick(choice string) string {
	ms := f.Models()
	switch {
	case len(ms) == 0:
		return ""
	case choice == local.VoiceChoiceAuto:
		return ms[len(ms)-1]
	case slices.Contains(ms, choice):
		return choice
	}
	return ""
}

func (f *fakeEngine) Transcribe(ctx context.Context, model string, pieces []wav.Audio, language, prompt string) (string, bool, error) {
	f.prompts = append(f.prompts, prompt)
	f.used = append(f.used, model)
	f.languages = append(f.languages, language)
	var ds []time.Duration
	for _, p := range pieces {
		ds = append(ds, p.Duration())
	}
	f.pieces = append(f.pieces, ds)
	if err := f.wait(ctx); err != nil {
		return "", false, err
	}
	return f.heard, f.gpu != nil, nil
}

func (f *fakeEngine) Speak(ctx context.Context, text, voice, language string) ([]byte, error) {
	f.spoken = append(f.spoken, text)
	f.voices = append(f.voices, voice)
	f.said = append(f.said, language)
	if err := f.wait(ctx); err != nil {
		return nil, err
	}
	return wav.Encode(wav.Audio{Rate: 24000, Channels: 1, Samples: []int16{1, 2, 3}}), nil
}

func (f *fakeEngine) TTSReady() bool { return f.tts }

func (f *fakeEngine) Voices() []string { return []string{"heart", "emma"} }

func (f *fakeEngine) Languages() []string {
	if f.dutch {
		return []string{"en", "nl"}
	}
	return []string{"en"}
}

func newServer(e *fakeEngine, queue int) *Server {
	return &Server{
		Engine: e,
		Jobs:   jobs.New(queue),
		Sound:  func() sound.Devices { return sound.Devices{Capture: true} },
	}
}

// spoken is d of a tone at −20 dBFS, as base64 WAV.
func spoken(rate int, d time.Duration) string {
	n := int(d.Seconds() * float64(rate))
	s := make([]int16, n)
	for i := range s {
		s[i] = int16(3277 * math.Sin(2*math.Pi*220*float64(i)/float64(rate)))
	}
	return base64.StdEncoding.EncodeToString(wav.Encode(wav.Audio{Rate: rate, Channels: 1, Samples: s}))
}

func do(t *testing.T, h http.Handler, method, path string, body any) (*httptest.ResponseRecorder, map[string]any) {
	t.Helper()
	var b []byte
	switch v := body.(type) {
	case nil:
	case string:
		b = []byte(v)
	default:
		b, _ = json.Marshal(v)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(method, path, bytes.NewReader(b)))
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec, out
}

func code(out map[string]any) string {
	e, _ := out["error"].(map[string]any)
	c, _ := e["code"].(string)
	return c
}

// conforms checks an answer against the contract's JSON Schema.
func conforms(t *testing.T, rec *httptest.ResponseRecorder, parse func([]byte) error) {
	t.Helper()
	if err := parse(rec.Body.Bytes()); err != nil {
		t.Fatalf("%s is not the contract's: %v", rec.Body.String(), err)
	}
}

func TestHealth(t *testing.T) {
	t.Parallel()
	h := newServer(&fakeEngine{stt: true}, 2).Handler()
	rec, out := do(t, h, http.MethodGet, local.VoicePathHealth, nil)
	if rec.Code != 200 || out["v"] != 1.0 || out["stt"] != true || out["tts"] != false ||
		out["microphone"] != true || out["speaker"] != false {
		t.Fatalf("%d %v", rec.Code, out)
	}
	conforms(t, rec, func(b []byte) error { _, err := local.ParseVoiceHealth(b); return err })
	if _, ok := out["voices"]; ok {
		t.Fatalf("voices without text to speech: %v", out)
	}
	if _, ok := out["languages"]; ok {
		t.Fatalf("languages without text to speech: %v", out)
	}
	// With text to speech, its voices, the default first (CT-614, NX-302), and English.
	rec, out = do(t, newServer(&fakeEngine{tts: true}, 2).Handler(), http.MethodGet, local.VoicePathHealth, nil)
	if v, _ := out["voices"].([]any); rec.Code != 200 || len(v) != 2 || v[0] != "heart" || v[1] != "emma" {
		t.Fatalf("%d %v", rec.Code, out)
	}
	if l, _ := out["languages"].([]any); len(l) != 1 || l[0] != "en" {
		t.Fatalf("languages: %v", out["languages"])
	}
	conforms(t, rec, func(b []byte) error { _, err := local.ParseVoiceHealth(b); return err })
	// With Supertonic, Dutch too (NX-478).
	rec, out = do(t, newServer(&fakeEngine{tts: true, dutch: true}, 2).Handler(), http.MethodGet, local.VoicePathHealth, nil)
	if l, _ := out["languages"].([]any); rec.Code != 200 || len(l) != 2 || l[0] != "en" || l[1] != "nl" {
		t.Fatalf("%d %v", rec.Code, out)
	}
	conforms(t, rec, func(b []byte) error { _, err := local.ParseVoiceHealth(b); return err })
	if rec, out := do(t, h, http.MethodPost, local.VoicePathHealth, "{}"); rec.Code != 405 || code(out) != "bad_request" {
		t.Fatalf("%d %v", rec.Code, out)
	}
	rec, out = do(t, h, http.MethodGet, "/v1/voice/record", nil)
	if rec.Code != 404 || code(out) != "bad_request" {
		t.Fatalf("%d %v", rec.Code, out)
	}
	conforms(t, rec, func(b []byte) error { _, err := local.ParseLocalError(b); return err })
}

func TestSTT(t *testing.T) {
	t.Parallel()
	e := &fakeEngine{stt: true, heard: "Is pve-02 okay?"}
	h := newServer(e, 2).Handler()
	rec, out := do(t, h, http.MethodPost, local.VoicePathStt, map[string]any{
		"v": 1, "audioWav": spoken(wav.SpeechRate, 4200*time.Millisecond), "prompt": "Neo, pve-02, Plex",
	})
	if rec.Code != 200 || out["text"] != "Is pve-02 okay?" || out["seconds"] != 4.0 {
		t.Fatalf("%d %v", rec.Code, out)
	}
	conforms(t, rec, func(b []byte) error { _, err := local.ParseVoiceSttAnswer(b); return err })
	if len(e.prompts) != 1 || e.prompts[0] != "Neo, pve-02, Plex" {
		t.Fatalf("prompt %q", e.prompts)
	}
}

func TestSeconds(t *testing.T) {
	t.Parallel()
	for d, want := range map[time.Duration]int64{
		0: 0, 400 * time.Millisecond: 0, 1500 * time.Millisecond: 2, 1720 * time.Millisecond: 2, 30 * time.Second: 30,
		31 * time.Second: 30,
	} {
		if got := Seconds(d); got != want {
			t.Errorf("Seconds(%v) = %d, want %d", d, got, want)
		}
	}
}

func TestSTTSilenceNeverReachesWhisper(t *testing.T) {
	t.Parallel()
	e := &fakeEngine{stt: true, heard: "Thank you."}
	h := newServer(e, 2).Handler()
	quiet := base64.StdEncoding.EncodeToString(wav.Encode(wav.Audio{Rate: wav.SpeechRate, Channels: 1, Samples: make([]int16, 24000)}))
	rec, out := do(t, h, http.MethodPost, local.VoicePathStt, map[string]any{"v": 1, "audioWav": quiet})
	if rec.Code != 200 || out["text"] != "" || out["seconds"] != 2.0 || e.jobs != 0 {
		t.Fatalf("%d %v, %d jobs", rec.Code, out, e.jobs)
	}
	conforms(t, rec, func(b []byte) error { _, err := local.ParseVoiceSttAnswer(b); return err })
}

func TestSTTRefuses(t *testing.T) {
	t.Parallel()
	h := newServer(&fakeEngine{stt: true, tts: true}, 2).Handler()
	ok := spoken(wav.SpeechRate, time.Second)
	notWav := base64.StdEncoding.EncodeToString([]byte(strings.Repeat("OggS", 30)))
	cases := []struct {
		name   string
		body   any
		status int
		code   string
	}{
		{"not json", "{", 400, "bad_request"},
		{"v2", map[string]any{"v": 2, "audioWav": ok}, 400, "bad_request"},
		{"unknown member", map[string]any{"v": 1, "audioWav": ok, "lang": "nl"}, 400, "bad_request"},
		{"not base64", map[string]any{"v": 1, "audioWav": strings.Repeat("%", 80)}, 400, "bad_request"},
		{"not wav", map[string]any{"v": 1, "audioWav": notWav}, 400, "bad_audio"},
		{"22 kHz", map[string]any{"v": 1, "audioWav": spoken(22050, time.Second)}, 400, "bad_audio"},
		{"31 s", map[string]any{"v": 1, "audioWav": spoken(wav.SpeechRate, 31*time.Second)}, 413, "too_large"},
		{"body", map[string]any{"v": 1, "audioWav": strings.Repeat("A", MaxSTTBody)}, 413, "too_large"},
		{"long prompt", map[string]any{"v": 1, "audioWav": ok, "prompt": strings.Repeat("x", 401)}, 400, "bad_request"},
		{"prompt on two lines", map[string]any{"v": 1, "audioWav": ok, "prompt": "Neo,\npve-02"}, 400, "bad_request"},
		{"prompt with a bidi override", map[string]any{"v": 1, "audioWav": ok, "prompt": "pve\u202e02"}, 400, "bad_request"},
	}
	for _, c := range cases {
		rec, out := do(t, h, http.MethodPost, local.VoicePathStt, c.body)
		if rec.Code != c.status || code(out) != c.code {
			t.Errorf("%s: %d %v", c.name, rec.Code, out)
		}
	}
	// 30 s exactly is fine.
	if rec, out := do(t, h, http.MethodPost, local.VoicePathStt, map[string]any{"v": 1, "audioWav": spoken(wav.SpeechRate, 30*time.Second)}); rec.Code != 200 {
		t.Errorf("30 s: %d %v", rec.Code, out)
	}
}

func TestSTTUnavailable(t *testing.T) {
	t.Parallel()
	body := map[string]any{"v": 1, "audioWav": spoken(wav.SpeechRate, time.Second)}
	rec, out := do(t, newServer(&fakeEngine{tts: true}, 2).Handler(), http.MethodPost, local.VoicePathStt, body)
	if rec.Code != 503 || code(out) != "unavailable" {
		t.Fatalf("%d %v", rec.Code, out)
	}
	var logged []string
	s := newServer(&fakeEngine{stt: true, err: errors.New("whisper-cli: exit status 1")}, 2)
	s.Log = func(f string, a ...any) { logged = append(logged, f) }
	rec, out = do(t, s.Handler(), http.MethodPost, local.VoicePathStt, body)
	if rec.Code != 503 || code(out) != "unavailable" || len(logged) != 1 {
		t.Fatalf("%d %v %v", rec.Code, out, logged)
	}
}

func TestTTS(t *testing.T) {
	t.Parallel()
	e := &fakeEngine{tts: true}
	h := newServer(e, 2).Handler()
	rec, out := do(t, h, http.MethodPost, local.VoicePathTts, map[string]any{"v": 1, "text": "pve-02 is fine. Its disks are healthy."})
	if rec.Code != 200 {
		t.Fatalf("%d %v", rec.Code, out)
	}
	conforms(t, rec, func(b []byte) error { _, err := local.ParseVoiceTtsAnswer(b); return err })
	b, err := base64.StdEncoding.DecodeString(out["audioWav"].(string))
	if err != nil {
		t.Fatal(err)
	}
	if a, err := wav.Parse(b); err != nil || len(a.Samples) != 3 {
		t.Fatalf("%v %v", a, err)
	}
	if e.spoken[0] != "pve-02 is fine. Its disks are healthy." || e.voices[0] != "" {
		t.Fatalf("%q %q", e.spoken, e.voices)
	}
	// A voice of its own (CT-614); another is bad_request and never reaches the engine.
	if rec, out := do(t, h, http.MethodPost, local.VoicePathTts, map[string]any{"v": 1, "text": "Hi.", "voice": "emma"}); rec.Code != 200 || e.voices[1] != "emma" {
		t.Fatalf("%d %v %q", rec.Code, out, e.voices)
	}
	if rec, out := do(t, h, http.MethodPost, local.VoicePathTts, map[string]any{"v": 1, "text": "Hi.", "voice": "nova"}); rec.Code != 400 || code(out) != "bad_request" || len(e.voices) != 2 {
		t.Fatalf("%d %v %q", rec.Code, out, e.voices)
	}
	// Dutch only from a service that speaks it (NX-478): without Supertonic it is bad_request and never runs.
	nl := map[string]any{"v": 1, "text": "Ja, P V E nul twee draait prima.", "voice": "emma", "language": "nl"}
	if rec, out := do(t, h, http.MethodPost, local.VoicePathTts, nl); rec.Code != 400 || code(out) != "bad_request" || len(e.said) != 2 {
		t.Fatalf("%d %v %q", rec.Code, out, e.said)
	}
	if e.said[0] != "" || e.said[1] != "" {
		t.Fatalf("English answers went as %q", e.said)
	}
	if rec, out := do(t, h, http.MethodPost, local.VoicePathTts, map[string]any{"v": 1, "text": "Hi.", "language": "en"}); rec.Code != 200 || e.said[2] != "en" {
		t.Fatalf("%d %v %q", rec.Code, out, e.said)
	}
	dutch := &fakeEngine{tts: true, dutch: true}
	if rec, out := do(t, newServer(dutch, 2).Handler(), http.MethodPost, local.VoicePathTts, nl); rec.Code != 200 ||
		dutch.said[0] != "nl" || dutch.voices[0] != "emma" || dutch.spoken[0] != nl["text"] {
		t.Fatalf("%d %v %q %q", rec.Code, out, dutch.said, dutch.voices)
	}
	// A language the contract doesn't name is no VoiceTtsRequest.
	if rec, out := do(t, newServer(dutch, 2).Handler(), http.MethodPost, local.VoicePathTts, map[string]any{"v": 1, "text": "Hallo.", "language": "de"}); rec.Code != 400 || code(out) != "bad_request" || len(dutch.said) != 1 {
		t.Fatalf("%d %v %q", rec.Code, out, dutch.said)
	}
	e.said = e.said[:0]
	for _, c := range []struct {
		text   string
		status int
		code   string
	}{
		{" \n\t", 400, "bad_request"},
		{"Two\nlines.", 400, "bad_request"},
		{strings.Repeat("ä", 601), 413, "too_large"},
	} {
		if rec, out := do(t, h, http.MethodPost, local.VoicePathTts, map[string]any{"v": 1, "text": c.text}); rec.Code != c.status || code(out) != c.code {
			t.Errorf("%q: %d %v", c.text[:3], rec.Code, out)
		}
	}
	if rec, out := do(t, h, http.MethodPost, local.VoicePathTts, map[string]any{"v": 1, "text": strings.Repeat("ä", 600)}); rec.Code != 200 {
		t.Errorf("600 code points: %d %v", rec.Code, out)
	}
	if rec, out := do(t, newServer(&fakeEngine{stt: true}, 2).Handler(), http.MethodPost, local.VoicePathTts, map[string]any{"v": 1, "text": "Hi."}); rec.Code != 503 || code(out) != "unavailable" {
		t.Errorf("no kokoro: %d %v", rec.Code, out)
	}
}

// One job at a time: with no queue, a second request while the first runs is refused at once.
func TestBusy(t *testing.T) {
	t.Parallel()
	e := &fakeEngine{stt: true, tts: true, heard: "hi", gate: make(chan struct{}), started: make(chan struct{}, 1)}
	h := newServer(e, 0).Handler()
	done := make(chan int)
	go func() {
		rec, _ := do(t, h, http.MethodPost, local.VoicePathTts, map[string]any{"v": 1, "text": "Restarting Plex."})
		done <- rec.Code
	}()
	<-e.started
	rec, out := do(t, h, http.MethodPost, local.VoicePathStt, map[string]any{"v": 1, "audioWav": spoken(wav.SpeechRate, time.Second)})
	if rec.Code != 503 || code(out) != "busy" {
		t.Fatalf("%d %v", rec.Code, out)
	}
	close(e.gate)
	if c := <-done; c != 200 {
		t.Fatal(c)
	}
}

// The peer check on a real socket: the runtime's uid gets in, anyone else gets 403.
func TestPeerCheck(t *testing.T) {
	t.Parallel()
	dir, err := os.MkdirTemp("", "voice-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(dir)
	get := func(allow uint32) int {
		sock := filepath.Join(dir, "v.sock")
		_ = os.Remove(sock)
		l, err := net.Listen("unix", sock)
		if err != nil {
			t.Fatal(err)
		}
		s := newServer(&fakeEngine{stt: true, tts: true}, 2)
		s.AllowUIDs = []uint32{allow}
		srv := &http.Server{Handler: s.Handler(), ConnContext: peercred.ConnContext}
		go func() { _ = srv.Serve(l) }()
		defer srv.Close()
		c := &http.Client{Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "unix", sock)
		}}}
		r, err := c.Get("http://voice" + local.VoicePathHealth)
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

func TestHealthModels(t *testing.T) {
	t.Parallel()
	mib := int64(65536)
	e := &fakeEngine{models: []string{"parakeet", "whisper"}, gpu: &local.VoiceGpu{Name: "AMD Radeon Graphics (RADV GFX1151)", Backend: "vulkan", MemoryMiB: &mib}}
	rec, out := do(t, newServer(e, 2).Handler(), http.MethodGet, local.VoicePathHealth, nil)
	if m, _ := out["models"].([]any); rec.Code != 200 || out["stt"] != true || len(m) != 2 || out["gpu"] == nil {
		t.Fatalf("%d %v", rec.Code, out)
	}
	conforms(t, rec, func(b []byte) error { _, err := local.ParseVoiceHealth(b); return err })
	// None downloaded yet: no models, no speech to text, no chip.
	rec, out = do(t, newServer(&fakeEngine{models: []string{}}, 2).Handler(), http.MethodGet, local.VoicePathHealth, nil)
	if _, ok := out["models"]; rec.Code != 200 || ok || out["stt"] != false || out["gpu"] != nil {
		t.Fatalf("%d %v", rec.Code, out)
	}
	conforms(t, rec, func(b []byte) error { _, err := local.ParseVoiceHealth(b); return err })
}

func TestSTTModelAndLanguage(t *testing.T) {
	t.Parallel()
	e := &fakeEngine{models: []string{"parakeet", "whisper"}, heard: "Is pve-02 okay?"}
	h := newServer(e, 2).Handler()
	rec, out := do(t, h, http.MethodPost, local.VoicePathStt, map[string]any{
		"v": 1, "audioWav": spoken(wav.SpeechRate, 2*time.Second), "model": "parakeet", "language": "nl",
	})
	if rec.Code != 200 || out["text"] != "Is pve-02 okay?" || e.used[0] != "parakeet" || e.languages[0] != "nl" {
		t.Fatalf("%d %v %v %v", rec.Code, out, e.used, e.languages)
	}
	// Without them: auto and auto.
	if rec, _ := do(t, h, http.MethodPost, local.VoicePathStt, map[string]any{"v": 1, "audioWav": spoken(wav.SpeechRate, time.Second)}); rec.Code != 200 || e.used[1] != "whisper" || e.languages[1] != "auto" {
		t.Fatalf("%d %v %v", rec.Code, e.used, e.languages)
	}
	// A model that isn't downloaded.
	e.models = []string{"parakeet"}
	rec, out = do(t, h, http.MethodPost, local.VoicePathStt, map[string]any{"v": 1, "audioWav": spoken(wav.SpeechRate, time.Second), "model": "whisper"})
	if rec.Code != 503 || code(out) != "unavailable" {
		t.Fatalf("%d %v", rec.Code, out)
	}
}

func TestTranscribe(t *testing.T) {
	t.Parallel()
	long := strings.TrimSpace(strings.Repeat("Varkens dragen de ziekte bij zich. ", 60))
	e := &fakeEngine{models: []string{"parakeet", "whisper"}, heard: long}
	h := newServer(e, 2).Handler()
	rec, out := do(t, h, http.MethodPost, local.VoicePathTranscribe, map[string]any{
		"v": 1, "audioWav": spoken(wav.SpeechRate, 70*time.Second), "model": "auto", "language": "nl", "prompt": "Dusty, pve-02",
	})
	if rec.Code != 200 || out["seconds"] != 70.0 || out["model"] != "whisper" || out["gpu"] != false {
		t.Fatalf("%d %v", rec.Code, out)
	}
	conforms(t, rec, func(b []byte) error { _, err := local.ParseVoiceTranscribeAnswer(b); return err })
	parts, _ := out["parts"].([]any)
	var joined []string
	for _, p := range parts {
		if n := len([]rune(p.(string))); n > local.VoiceTextPartMax {
			t.Fatalf("a part of %d code points", n)
		}
		joined = append(joined, p.(string))
	}
	if len(parts) != 3 || strings.Join(joined, " ") != long {
		t.Fatalf("%d parts, joined %q", len(parts), strings.Join(joined, " "))
	}
	// 70 s in pieces of at most 30 s, all of it, one job.
	var total time.Duration
	for _, d := range e.pieces[0] {
		if d > wav.PieceMax {
			t.Fatalf("a piece of %s", d)
		}
		total += d
	}
	if e.jobs != 1 || len(e.pieces[0]) != 3 || total != 70*time.Second || e.languages[0] != "nl" || e.prompts[0] != "Dusty, pve-02" {
		t.Fatalf("%d jobs, pieces %v, %v %v", e.jobs, e.pieces, e.languages, e.prompts)
	}
	// Silence never reaches a model.
	quiet := base64.StdEncoding.EncodeToString(wav.Encode(wav.Audio{Rate: wav.SpeechRate, Channels: 1, Samples: make([]int16, 40*wav.SpeechRate)}))
	rec, out = do(t, h, http.MethodPost, local.VoicePathTranscribe, map[string]any{"v": 1, "audioWav": quiet, "model": "auto", "language": "auto"})
	if p, ok := out["parts"].([]any); rec.Code != 200 || !ok || len(p) != 0 || out["seconds"] != 40.0 || e.jobs != 1 {
		t.Fatalf("%d %v, %d jobs", rec.Code, out, e.jobs)
	}
	conforms(t, rec, func(b []byte) error { _, err := local.ParseVoiceTranscribeAnswer(b); return err })
}

func TestTranscribeRefuses(t *testing.T) {
	t.Parallel()
	h := newServer(&fakeEngine{stt: true}, 2).Handler()
	ok := spoken(wav.SpeechRate, time.Second)
	cases := []struct {
		name   string
		body   any
		status int
		code   string
	}{
		{"no model member", map[string]any{"v": 1, "audioWav": ok, "language": "en"}, 400, "bad_request"},
		{"a model the contract doesn't know", map[string]any{"v": 1, "audioWav": ok, "model": "canary", "language": "en"}, 400, "bad_request"},
		{"a language it doesn't know", map[string]any{"v": 1, "audioWav": ok, "model": "auto", "language": "de"}, 400, "bad_request"},
		{"stereo", map[string]any{"v": 1, "audioWav": base64.StdEncoding.EncodeToString(wav.Encode(wav.Audio{Rate: wav.SpeechRate, Channels: 2, Samples: make([]int16, 32000)})), "model": "auto", "language": "en"}, 400, "bad_audio"},
		{"301 s", map[string]any{"v": 1, "audioWav": spoken(wav.SpeechRate, 301*time.Second), "model": "auto", "language": "en"}, 413, "too_large"},
		{"whisper isn't downloaded", map[string]any{"v": 1, "audioWav": ok, "model": "whisper", "language": "en"}, 503, "unavailable"},
	}
	for _, c := range cases {
		rec, out := do(t, h, http.MethodPost, local.VoicePathTranscribe, c.body)
		if rec.Code != c.status || code(out) != c.code {
			t.Errorf("%s: %d %v", c.name, rec.Code, out)
		}
	}
	// Five minutes exactly is fine.
	if rec, out := do(t, h, http.MethodPost, local.VoicePathTranscribe, map[string]any{"v": 1, "audioWav": spoken(wav.SpeechRate, 300*time.Second), "model": "auto", "language": "en"}); rec.Code != 200 {
		t.Errorf("300 s: %d %v", rec.Code, out)
	}
	// Nothing downloaded at all.
	h = newServer(&fakeEngine{tts: true}, 2).Handler()
	if rec, out := do(t, h, http.MethodPost, local.VoicePathTranscribe, map[string]any{"v": 1, "audioWav": ok, "model": "auto", "language": "en"}); rec.Code != 503 || code(out) != "unavailable" {
		t.Errorf("no models: %d %v", rec.Code, out)
	}
}
