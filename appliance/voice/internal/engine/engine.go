// Package engine runs the speech programs of the image (NX-176, NX-291, NX-470, NX-476): whisper.cpp's whisper-cli and
// parakeet-cli for speech to text over the models the fetcher downloaded (STT), and for text to speech kokoro-speak
// (Kokoro through sherpa-onnx, English) and supertonic-speak (Supertonic 3, Dutch), one process per job (TTS). Each job works in a fresh
// directory under the service's private tmpfs and removes it when it ends, whatever happened: the audio is gone once
// it is text (DK-07), and an answer's audio leaves only in the reply.
package engine

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/CybexBV/whombat/appliance/voice/internal/models"
	"github.com/CybexBV/whombat/appliance/voice/internal/speech"
	"github.com/CybexBV/whombat/appliance/voice/internal/wav"
	"github.com/CybexBV/whombat/contracts/go/local"
)

// MinSpeech is what whisper.cpp needs at least (it skips shorter input); shorter speech is padded with silence.
const MinSpeech = 1100 * time.Millisecond

// maxOutput bounds what a program may print, and maxAnswer the WAV a voice may write (the contract's largest answer;
// 600 code points of speech are about 40 seconds: under 2 MB at Kokoro's 24 kHz, under 4 MB at Supertonic's 44.1 kHz).
const (
	maxOutput = 64 << 10
	maxAnswer = local.VoiceTtsWavMaxBytes
)

// Threads is n, or the CPUs this process may use (its affinity), at most 8 (more buys little for a short clip).
func Threads(n int) int {
	if n > 0 {
		return n
	}
	return min(runtime.NumCPU(), 8)
}

// KokoroFiles are what a Kokoro model directory holds, as sherpa-onnx packs it (NX-292); each voice's accent adds its
// lexicon (KokoroLexicon).
var KokoroFiles = []string{"model.onnx", "voices.bin", "tokens.txt"}

// KokoroLexicon is the lexicon file of an accent ("us", "gb") in the model's directory (NX-301).
func KokoroLexicon(accent string) string { return "lexicon-" + accent + "-en.txt" }

// ErrUnknownVoice is a voice the service doesn't have (the request's `voice`, NX-302).
var ErrUnknownVoice = errors.New("no such voice")

// KokoroVoice is one voice the service speaks with: the desk's name for it, its number in the model, its accent, and
// whether it is a man's (Dutch is said in Supertonic's voice of the same kind, NX-478).
type KokoroVoice struct {
	Name    string
	Speaker int
	Accent  string
	Man     bool
}

// ParseKokoroVoices reads `name=speaker:accent[:man|woman],…` (the first is the default; a woman's voice when the kind
// is left out), e.g. `heart=3:us,george=26:gb:man`.
func ParseKokoroVoices(s string) ([]KokoroVoice, error) {
	var out []KokoroVoice
	seen := map[string]bool{}
	for _, f := range strings.Split(s, ",") {
		name, rest, ok := strings.Cut(strings.TrimSpace(f), "=")
		parts := strings.Split(rest, ":")
		kind := "woman"
		if len(parts) == 3 {
			kind = parts[2]
		}
		if len(parts) < 2 || len(parts) > 3 {
			return nil, fmt.Errorf("not a voice: %q", f)
		}
		n, err := strconv.Atoi(parts[0])
		accent := parts[1]
		if !ok || err != nil || n < 0 || !voiceName.MatchString(name) || (accent != "us" && accent != "gb") ||
			(kind != "man" && kind != "woman") || seen[name] {
			return nil, fmt.Errorf("not a voice: %q", f)
		}
		seen[name] = true
		out = append(out, KokoroVoice{Name: name, Speaker: n, Accent: accent, Man: kind == "man"})
	}
	if len(out) == 0 {
		return nil, errors.New("no voices")
	}
	return out, nil
}

// voiceName is the contract's VoiceName.
var voiceName = regexp.MustCompile(`^[a-z][a-z0-9-]{0,31}$`)

// Kokoro is text to speech with kokoro-speak (Kokoro through sherpa-onnx, NX-291, NX-301).
type Kokoro struct {
	// Bin is `kokoro-speak`; Model the model's directory (KokoroFiles and the voices' lexicons).
	Bin, Model string
	// Voices it speaks with, the default first.
	Voices []KokoroVoice
	// Threads for kokoro-speak; 0: the CPUs this process may use, at most 8.
	Threads int
	TmpDir  string
	Timeout time.Duration
}

// Ready says whether the program, the model's files and every voice's lexicon are there.
func (k Kokoro) Ready() bool {
	if !executable(k.Bin) || len(k.Voices) == 0 {
		return false
	}
	files := slices.Clone(KokoroFiles)
	for _, v := range k.Voices {
		files = append(files, KokoroLexicon(v.Accent))
	}
	for _, f := range files {
		if !nonEmpty(filepath.Join(k.Model, f)) {
			return false
		}
	}
	return true
}

// Names are the voices' names, the default first (the health's `voices`).
func (k Kokoro) Names() []string {
	names := make([]string, len(k.Voices))
	for i, v := range k.Voices {
		names[i] = v.Name
	}
	return names
}

// voice is the voice named (the default when empty), ErrUnknownVoice when it has none of that name.
func (k Kokoro) voice(name string) (KokoroVoice, error) {
	if len(k.Voices) == 0 {
		return KokoroVoice{}, errors.New("no voices")
	}
	if name == "" {
		return k.Voices[0], nil
	}
	i := slices.IndexFunc(k.Voices, func(v KokoroVoice) bool { return v.Name == name })
	if i < 0 {
		return KokoroVoice{}, ErrUnknownVoice
	}
	return k.Voices[i], nil
}

// Speak says text (one line, already cleaned) in voice (the default when empty; ErrUnknownVoice when it has none of
// that name) and returns a 16-bit mono WAV at the model's rate (24 kHz). The text goes in on stdin, never as an
// argument, so nothing in it can read as an option.
func (k Kokoro) Speak(ctx context.Context, text, voice string) ([]byte, error) {
	v, err := k.voice(voice)
	if err != nil {
		return nil, err
	}
	return speakWith(ctx, k.Timeout, k.TmpDir, k.Bin, "kokoro", text, func(out string) []string {
		return []string{
			"--model", k.Model, "--speaker", strconv.Itoa(v.Speaker), "--accent", v.Accent,
			"--threads", strconv.Itoa(Threads(k.Threads)), "--output-file", out,
		}
	})
}

// SupertonicFiles are what the Supertonic model's directory holds, as sherpa-onnx packs it (NX-477).
var SupertonicFiles = []string{
	"duration_predictor.int8.onnx", "text_encoder.int8.onnx", "vector_estimator.int8.onnx", "vocoder.int8.onnx",
	"tts.json", "unicode_indexer.bin", "voice.bin",
}

// Supertonic is Dutch text to speech with supertonic-speak (Supertonic 3 through sherpa-onnx).
type Supertonic struct {
	// Bin is `supertonic-speak`; Model is an explicit model directory when set, otherwise the downloaded supertonic
	// model in Dir from Manifest is used whenever present. Empty Bin: the service speaks no Dutch.
	Bin, Model string
	// Dir holds the downloaded models, Manifest names them.
	Dir      string
	Manifest models.Manifest
	// Woman and Man are the model's speakers (0–4 its women F1…F5, 5–9 its men M1…M5) Dutch is said in, for a woman's
	// and a man's English voice.
	Woman, Man int
	// Threads for supertonic-speak; 0: the CPUs this process may use, at most 8.
	Threads int
	TmpDir  string
	Timeout time.Duration
}

// modelDir returns the active Supertonic model directory, or "" when no complete model is available.
func (s Supertonic) modelDir() string {
	dir := s.Model
	if dir == "" {
		if s.Dir == "" {
			return ""
		}
		m, ok := s.Manifest.Find(local.VoiceModelSupertonic)
		if !ok || !models.Present(s.Dir, m) {
			return ""
		}
		dir = models.Path(s.Dir, m)
	}
	for _, f := range SupertonicFiles {
		if !nonEmpty(filepath.Join(dir, f)) {
			return ""
		}
	}
	return dir
}

// Ready says whether the program and the model's files are there.
func (s Supertonic) Ready() bool {
	return s.Bin != "" && executable(s.Bin) && s.modelDir() != ""
}

// Speak says text (one line, written out as it is said) in lang with the man's or the woman's speaker and returns a
// 16-bit mono WAV at the model's rate (44.1 kHz). The text goes in on stdin.
func (s Supertonic) Speak(ctx context.Context, text, lang string, man bool) ([]byte, error) {
	dir := s.modelDir()
	if dir == "" {
		return nil, ErrUnknownLanguage
	}
	speaker := s.Woman
	if man {
		speaker = s.Man
	}
	return speakWith(ctx, s.Timeout, s.TmpDir, s.Bin, "supertonic", text, func(out string) []string {
		return []string{
			"--model", dir, "--speaker", strconv.Itoa(speaker), "--lang", lang,
			"--threads", strconv.Itoa(Threads(s.Threads)), "--output-file", out,
		}
	})
}

// ErrUnknownLanguage is a language the service doesn't speak (the request's `language`, NX-478).
var ErrUnknownLanguage = errors.New("no such language")

// TTS says text in English with Kokoro and in Dutch with Supertonic, in Supertonic's voice of the kind of the English
// voice asked for (NX-478).
type TTS struct {
	Kokoro Kokoro
	Dutch  Supertonic
}

// Ready says whether English can be said (Kokoro and its voices); Dutch is a language more when it can be said too.
func (t TTS) Ready() bool { return t.Kokoro.Ready() }

// Voices are Kokoro's voices, the default first (the health's `voices`).
func (t TTS) Voices() []string { return t.Kokoro.Names() }

// Languages are the languages it speaks, English first (the health's `languages`).
func (t TTS) Languages() []string {
	if t.Dutch.Ready() {
		return []string{"en", "nl"}
	}
	return []string{"en"}
}

// Speak says text in voice (the default when "") and language ("" or "en": English; "nl": Dutch, in Supertonic's
// voice of the same kind); ErrUnknownVoice or ErrUnknownLanguage for one it doesn't have.
func (t TTS) Speak(ctx context.Context, text, voice, language string) ([]byte, error) {
	switch language {
	case "", "en":
		return t.Kokoro.Speak(ctx, text, voice)
	case "nl":
		if !t.Dutch.Ready() {
			return nil, ErrUnknownLanguage
		}
		v, err := t.Kokoro.voice(voice)
		if err != nil {
			return nil, err
		}
		return t.Dutch.Speak(ctx, text, language, v.Man)
	default:
		return nil, ErrUnknownLanguage
	}
}

// speakWith runs one text-to-speech job in a fresh directory under tmp (gone when it ends) and returns the WAV the
// program wrote there, checked: one channel, some samples, at most the contract's largest answer.
func speakWith(ctx context.Context, timeout time.Duration, tmp, bin, what, text string, args func(out string) []string) ([]byte, error) {
	dir, err := os.MkdirTemp(tmp, "tts-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(dir)
	out := filepath.Join(dir, "answer.wav")
	if _, err := run(ctx, timeout, dir, bin, args(out), strings.NewReader(text+"\n"), nil); err != nil {
		return nil, err
	}
	fi, err := os.Stat(out)
	if err != nil {
		return nil, fmt.Errorf("%s wrote no audio: %w", what, err)
	}
	if fi.Size() > maxAnswer {
		return nil, fmt.Errorf("%s's audio is too large: %d bytes", what, fi.Size())
	}
	b, err := os.ReadFile(out)
	if err != nil {
		return nil, err
	}
	a, err := wav.Parse(b)
	if err != nil {
		return nil, fmt.Errorf("%s's audio: %w", what, err)
	}
	if a.Channels != 1 || len(a.Samples) == 0 {
		return nil, fmt.Errorf("%s's audio: %d channels, %d samples", what, a.Channels, len(a.Samples))
	}
	return wav.Encode(a), nil
}

// run runs bin in dir with a short environment (TMPDIR and HOME the job's directory, and env) and returns its stdout.
// A failure carries the last line of stderr.
func run(ctx context.Context, timeout time.Duration, dir, bin string, args []string, stdin *strings.Reader, env []string) (string, error) {
	if timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, timeout)
		defer cancel()
	}
	cmd := exec.CommandContext(ctx, bin, args...)
	cmd.Dir = dir
	cmd.Env = append([]string{"PATH=" + os.Getenv("PATH"), "HOME=" + dir, "TMPDIR=" + dir, "LANG=C.UTF-8"}, env...)
	if stdin != nil {
		cmd.Stdin = stdin
	}
	stdout, stderr := &capped{max: maxOutput}, &capped{max: maxOutput}
	cmd.Stdout, cmd.Stderr = stdout, stderr
	cmd.WaitDelay = 2 * time.Second
	err := cmd.Run()
	if ctx.Err() != nil {
		return "", fmt.Errorf("%s: %w", filepath.Base(bin), ctx.Err())
	}
	if err != nil {
		return "", fmt.Errorf("%s: %w: %s", filepath.Base(bin), err, lastLine(stderr.String()))
	}
	return stdout.String(), nil
}

func lastLine(s string) string {
	lines := strings.Split(strings.TrimSpace(s), "\n")
	return speech.Cut(speech.Line(lines[len(lines)-1]), 200)
}

func executable(p string) bool {
	fi, err := os.Stat(p)
	return err == nil && fi.Mode().IsRegular() && fi.Mode().Perm()&0o111 != 0
}

func nonEmpty(p string) bool {
	fi, err := os.Stat(p)
	return err == nil && fi.Mode().IsRegular() && fi.Size() > 0
}

// capped keeps the first max bytes written and drops the rest (a program can't fill the service's memory).
type capped struct {
	bytes.Buffer
	max int
}

func (c *capped) Write(p []byte) (int, error) {
	if room := c.max - c.Len(); room > 0 {
		c.Buffer.Write(p[:min(len(p), room)])
	}
	return len(p), nil
}
