// Package api is the voice socket (contracts 0.100.0 `local` CT-532; desk display §2.4; NX-177, NX-186; voice typing
// 3.1, NX-470): HTTP/1.1 JSON on /run/whombat-voice/voice.sock, used by the runtime server only.
//
//	GET  /v1/voice/health      → VoiceHealth { v:1, stt, tts, microphone, speaker, voices, languages, models, gpu? }
//	POST /v1/voice/stt         VoiceSttRequest { v:1, audioWav (base64 16 kHz mono s16le WAV, ≤ 30 s), prompt? (≤ 400),
//	                           model?, language? } → VoiceSttAnswer { v:1, text, seconds }
//	POST /v1/voice/tts         VoiceTtsRequest { v:1, text (≤ 600), voice?, language? } → VoiceTtsAnswer { v:1, audioWav }
//	POST /v1/voice/transcribe  VoiceTranscribeRequest { v:1, audioWav (≤ 300 s), model, language, prompt? }
//	                           → VoiceTranscribeAnswer { v:1, parts, seconds, model, gpu }
//
// A recording for transcribe is cut at pauses into pieces of at most 30 s (wav.Split), heard in one job and its text
// joined; the answer cuts the text into parts of at most 1000 code points (the contract's pattern limit).
//
// Requests are strict (the contract's JSON Schemas); errors are LocalError with the contract's VOICE_ERRORS: 400
// bad_request (not the request's JSON, a wrong path or method) · 400 bad_audio (not a 16 kHz mono 16-bit WAV) · 413
// too_large (body, speech over 30 s, text over 600) · 503 busy (one job runs, two wait) · 503 unavailable (the program
// or its model is missing, or it failed). A voice the service doesn't have is 400 bad_request (contracts 0.105 CT-614,
// NX-302), and so is a language it doesn't speak (3.4, NX-478: English always, Dutch with Supertonic). A peer that
// isn't the runtime or root gets 403 forbidden.
//
// Nothing heard or said is logged: a log line has the lengths and the time a job took, never words.
package api

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"slices"
	"time"
	"unicode/utf8"

	"github.com/CybexBV/whombat/appliance/helper/pkg/peercred"
	"github.com/CybexBV/whombat/appliance/voice/internal/jobs"
	"github.com/CybexBV/whombat/appliance/voice/internal/sound"
	"github.com/CybexBV/whombat/appliance/voice/internal/speech"
	"github.com/CybexBV/whombat/appliance/voice/internal/wav"
	"github.com/CybexBV/whombat/contracts/go/local"
)

// Body limits: a VoiceSttRequest is at most DeskAudioBase64Max of audio (30 s of 16 kHz speech in base64) and 400
// code points of prompt; a VoiceTtsRequest 600 code points of text (3 600 bytes escaped).
const (
	MaxSTTBody  = local.DeskTalkRequestMaxBytes
	MaxTTSBody  = 16 << 10
	SilenceDBFS = -45.0
)

// Engine does the speech work (engine.STT and engine.TTS on the box, fakes in tests).
type Engine interface {
	// Models are the speech-to-text models that are downloaded and run.
	Models() []string
	// GPU is the graphics chip speech to text runs on, nil when none.
	GPU() *local.VoiceGpu
	// Pick is the model a choice (auto, parakeet, whisper) goes to now, "" when none can.
	Pick(choice string) string
	// Transcribe hears the pieces of one recording with model; gpu says whether it ran on the graphics chip.
	Transcribe(ctx context.Context, model string, pieces []wav.Audio, language, prompt string) (text string, gpu bool, err error)
	// Speak says text in voice (the default when "") and language ("": English), engine.ErrUnknownVoice or
	// engine.ErrUnknownLanguage for one it hasn't.
	Speak(ctx context.Context, text, voice, language string) ([]byte, error)
	// TTSReady says whether Kokoro and its voices are there.
	TTSReady() bool
	// Voices are the voices Speak knows, the default first.
	Voices() []string
	// Languages are the languages Speak says, English first.
	Languages() []string
}

// Server serves the voice socket.
type Server struct {
	Engine Engine
	Jobs   *jobs.Limiter
	// Sound says which PCM devices exist (sound.Read of /proc/asound/pcm).
	Sound func() sound.Devices
	// AllowUIDs: the peers that may connect (SO_PEERCRED); empty lets in whoever the socket's mode lets in.
	AllowUIDs []uint32
	Log       func(format string, args ...any)
	Now       func() time.Time
}

// Handler routes the three paths behind the peer check.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc(local.VoicePathHealth, s.method(http.MethodGet, s.health))
	mux.HandleFunc(local.VoicePathStt, s.method(http.MethodPost, s.stt))
	mux.HandleFunc(local.VoicePathTts, s.method(http.MethodPost, s.tts))
	mux.HandleFunc(local.VoicePathTranscribe, s.method(http.MethodPost, s.transcribe))
	mux.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) {
		fail(w, http.StatusNotFound, local.VoiceErrorBadRequest, "no such path")
	})
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if len(s.AllowUIDs) > 0 {
			c, ok := peercred.FromContext(r.Context())
			if !ok || !slices.Contains(s.AllowUIDs, c.UID) {
				fail(w, http.StatusForbidden, "forbidden", "this socket is the runtime's")
				return
			}
		}
		mux.ServeHTTP(w, r)
	})
}

func (s *Server) method(m string, h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != m {
			w.Header().Set("Allow", m)
			fail(w, http.StatusMethodNotAllowed, local.VoiceErrorBadRequest, m+" only")
			return
		}
		h(w, r)
	}
}

func (s *Server) health(w http.ResponseWriter, _ *http.Request) {
	ms := s.Engine.Models()
	tts := s.Engine.TTSReady()
	d := s.Sound()
	h := local.VoiceHealth{V: 1, Stt: len(ms) > 0, Tts: tts, Microphone: d.Capture, Speaker: d.Playback, Models: ms, Gpu: s.Engine.GPU()}
	if tts {
		h.Voices = s.Engine.Voices()
		for _, l := range s.Engine.Languages() {
			h.Languages = append(h.Languages, local.VoiceSpeechLanguage(l))
		}
	}
	reply(w, h)
}

func (s *Server) stt(w http.ResponseWriter, r *http.Request) {
	body, ok := read(w, r, MaxSTTBody)
	if !ok {
		return
	}
	// Longer speech than the schema allows is “too large”, not a malformed request.
	var peek struct {
		AudioWav string `json:"audioWav"`
	}
	if json.Unmarshal(body, &peek) == nil && len(peek.AudioWav) > local.DeskAudioBase64Max {
		fail(w, http.StatusRequestEntityTooLarge, local.VoiceErrorTooLarge, "speech is longer than 30 s")
		return
	}
	req, err := local.ParseVoiceSttRequest(body)
	if err != nil {
		fail(w, http.StatusBadRequest, local.VoiceErrorBadRequest, "not a VoiceSttRequest")
		return
	}
	raw, err := base64.StdEncoding.DecodeString(req.AudioWav)
	if err != nil {
		fail(w, http.StatusBadRequest, local.VoiceErrorBadAudio, "audioWav is not base64")
		return
	}
	a, err := wav.Parse(raw)
	if err == nil {
		err = wav.CheckSpeech(a)
	}
	if err != nil {
		fail(w, http.StatusBadRequest, local.VoiceErrorBadAudio, err.Error())
		return
	}
	if a.Duration() > wav.MaxSpeech {
		fail(w, http.StatusRequestEntityTooLarge, local.VoiceErrorTooLarge, "speech is longer than 30 s")
		return
	}
	var prompt string
	if req.Prompt != nil {
		prompt = *req.Prompt
	}
	choice, language := local.VoiceChoiceAuto, local.VoiceLanguageAuto
	if req.Model != nil {
		choice = *req.Model
	}
	if req.Language != nil {
		language = *req.Language
	}
	length := a.Duration().Seconds()
	seconds := Seconds(a.Duration())
	if wav.Silent(a, SilenceDBFS) {
		// Nobody spoke (or the microphone is muted): nothing to transcribe, and whisper.cpp would make words up.
		s.logf("stt: %.1f s of silence", length)
		reply(w, local.VoiceSttAnswer{V: 1, Text: "", Seconds: seconds})
		return
	}
	text, _, _, ok := s.hear(w, r, "stt", choice, []wav.Audio{a}, language, prompt)
	if !ok {
		return
	}
	reply(w, local.VoiceSttAnswer{V: 1, Text: speech.Cut(text, speech.MaxTranscript), Seconds: seconds})
}

// transcribe is voice typing: a recording of up to five minutes, cut at pauses, heard in one job.
func (s *Server) transcribe(w http.ResponseWriter, r *http.Request) {
	body, ok := read(w, r, local.VoiceTranscribeRequestMaxBytes)
	if !ok {
		return
	}
	var peek struct {
		AudioWav string `json:"audioWav"`
	}
	if json.Unmarshal(body, &peek) == nil && len(peek.AudioWav) > local.VoiceTranscribeBase64Max {
		fail(w, http.StatusRequestEntityTooLarge, local.VoiceErrorTooLarge, "the recording is longer than five minutes")
		return
	}
	req, err := local.ParseVoiceTranscribeRequest(body)
	if err != nil {
		fail(w, http.StatusBadRequest, local.VoiceErrorBadRequest, "not a VoiceTranscribeRequest")
		return
	}
	raw, err := base64.StdEncoding.DecodeString(req.AudioWav)
	if err != nil {
		fail(w, http.StatusBadRequest, local.VoiceErrorBadAudio, "audioWav is not base64")
		return
	}
	a, err := wav.Parse(raw)
	if err == nil {
		err = wav.CheckSpeech(a)
	}
	if err != nil {
		fail(w, http.StatusBadRequest, local.VoiceErrorBadAudio, err.Error())
		return
	}
	if a.Duration() > wav.MaxTyping {
		fail(w, http.StatusRequestEntityTooLarge, local.VoiceErrorTooLarge, "the recording is longer than five minutes")
		return
	}
	var prompt string
	if req.Prompt != nil {
		prompt = *req.Prompt
	}
	seconds := min(int64(math.Round(a.Duration().Seconds())), local.VoiceTypingMaxSeconds)
	if wav.Silent(a, SilenceDBFS) {
		s.logf("transcribe: %.1f s of silence", a.Duration().Seconds())
		model := s.Engine.Pick(req.Model)
		if model == "" {
			model = local.VoiceModelParakeet
		}
		reply(w, local.VoiceTranscribeAnswer{V: 1, Parts: []string{}, Seconds: seconds, Model: model})
		return
	}
	// A long job outlives the server's write timeout: this answer may take as long as its job does.
	_ = http.NewResponseController(w).SetWriteDeadline(time.Time{})
	pieces := wav.Split(a, wav.PieceMax)
	text, model, gpu, ok := s.hear(w, r, "transcribe", req.Model, pieces, req.Language, prompt)
	if !ok {
		return
	}
	reply(w, local.VoiceTranscribeAnswer{
		V:       1,
		Parts:   speech.Parts(text, local.VoiceTextPartMax, local.VoiceTextPartsMax),
		Seconds: seconds,
		Model:   model,
		Gpu:     gpu,
	})
}

// hear runs one speech-to-text job in the queue with the model choice goes to, and logs its lengths and time (never
// its words): the text, the model and whether it ran on the graphics chip; false when it answered an error.
func (s *Server) hear(w http.ResponseWriter, r *http.Request, what, choice string, pieces []wav.Audio, language, prompt string) (string, string, bool, bool) {
	model := s.Engine.Pick(choice)
	if model == "" {
		fail(w, http.StatusServiceUnavailable, local.VoiceErrorUnavailable, "no speech model is downloaded")
		return "", "", false, false
	}
	release, ok := s.acquire(w, r)
	if !ok {
		return "", "", false, false
	}
	defer release()
	var length float64
	for _, p := range pieces {
		length += p.Duration().Seconds()
	}
	start := s.now()
	text, gpu, err := s.Engine.Transcribe(r.Context(), model, pieces, language, prompt)
	where := "the processor"
	if gpu {
		where = "the graphics chip"
	}
	if err != nil {
		s.logf("%s: %.1f s of speech failed with %s on %s after %s: %v", what, length, model, where, s.since(start), err)
		fail(w, http.StatusServiceUnavailable, local.VoiceErrorUnavailable, "speech to text failed")
		return "", "", false, false
	}
	s.logf("%s: %.1f s of speech in %d pieces with %s on %s in %s, %d characters", what, length, len(pieces), model, where, s.since(start), utf8.RuneCountInString(text))
	return text, model, gpu, true
}

func (s *Server) tts(w http.ResponseWriter, r *http.Request) {
	body, ok := read(w, r, MaxTTSBody)
	if !ok {
		return
	}
	var peek struct {
		Text string `json:"text"`
	}
	if json.Unmarshal(body, &peek) == nil && utf8.RuneCountInString(peek.Text) > local.VoiceTtsTextMax {
		fail(w, http.StatusRequestEntityTooLarge, local.VoiceErrorTooLarge, "text is longer than 600 characters")
		return
	}
	req, err := local.ParseVoiceTtsRequest(body)
	if err != nil {
		fail(w, http.StatusBadRequest, local.VoiceErrorBadRequest, "not a VoiceTtsRequest")
		return
	}
	n := utf8.RuneCountInString(req.Text)
	if !s.Engine.TTSReady() {
		fail(w, http.StatusServiceUnavailable, local.VoiceErrorUnavailable, "text to speech is not installed")
		return
	}
	voice := ""
	if req.Voice != nil {
		voice = *req.Voice
		if !slices.Contains(s.Engine.Voices(), voice) {
			fail(w, http.StatusBadRequest, local.VoiceErrorBadRequest, "no such voice")
			return
		}
	}
	language := ""
	if req.Language != nil {
		language = string(*req.Language)
		if !slices.Contains(s.Engine.Languages(), language) {
			fail(w, http.StatusBadRequest, local.VoiceErrorBadRequest, "no such language")
			return
		}
	}
	release, ok := s.acquire(w, r)
	if !ok {
		return
	}
	defer release()
	start := s.now()
	audio, err := s.Engine.Speak(r.Context(), req.Text, voice, language)
	if err == nil && len(audio) > local.VoiceTtsWavMaxBytes {
		err = fmt.Errorf("%d bytes of audio", len(audio))
	}
	if err != nil {
		s.logf("tts: %d characters%s failed after %s: %v", n, in(language), s.since(start), err)
		fail(w, http.StatusServiceUnavailable, local.VoiceErrorUnavailable, "text to speech failed")
		return
	}
	s.logf("tts: %d characters%s in %s", n, in(language), s.since(start))
	reply(w, local.VoiceTtsAnswer{V: 1, AudioWav: base64.StdEncoding.EncodeToString(audio)})
}

// in names a language other than English in a log line (“ in nl”).
func in(language string) string {
	if language == "" || language == "en" {
		return ""
	}
	return " in " + language
}

// Seconds is the speech's length as VoiceSttAnswer.seconds: whole seconds, rounded, at most 30.
func Seconds(d time.Duration) int64 {
	return min(int64(math.Round(d.Seconds())), local.DeskAudioMaxSeconds)
}

// acquire takes the job's place in the queue; false when the queue is full (503 busy, answered) or the caller left.
func (s *Server) acquire(w http.ResponseWriter, r *http.Request) (func(), bool) {
	release, err := s.Jobs.Acquire(r.Context())
	switch {
	case errors.Is(err, jobs.ErrBusy):
		fail(w, http.StatusServiceUnavailable, local.VoiceErrorBusy, "another job is running and two are waiting")
		return nil, false
	case err != nil:
		fail(w, http.StatusServiceUnavailable, local.VoiceErrorBusy, "gave up waiting")
		return nil, false
	}
	return release, true
}

// read reads a body of at most limit bytes; false when it answered 413.
func read(w http.ResponseWriter, r *http.Request, limit int64) ([]byte, bool) {
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, limit))
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			fail(w, http.StatusRequestEntityTooLarge, local.VoiceErrorTooLarge, fmt.Sprintf("the body is larger than %d bytes", limit))
		} else {
			fail(w, http.StatusBadRequest, local.VoiceErrorBadRequest, "can't read the body")
		}
		return nil, false
	}
	return body, true
}

func reply(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

func fail(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(local.LocalError{Error: local.LocalErrorError{Code: code, Message: message}})
}

func (s *Server) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
}

func (s *Server) since(t time.Time) string {
	return s.now().Sub(t).Round(10 * time.Millisecond).String()
}

func (s *Server) logf(format string, args ...any) {
	if s.Log != nil {
		s.Log(format, args...)
	}
}
