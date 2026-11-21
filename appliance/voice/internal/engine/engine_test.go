package engine

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/voice/internal/models"
	"github.com/CybexBV/whombat/appliance/voice/internal/wav"
)

// The test binary is its own fake whisper-cli and kokoro-speak: started with `--model <dir>/<mode>` it plays the program
// the other arguments name (whisper-cli has --file, kokoro-speak --output-file) in that mode.
func TestMain(m *testing.M) {
	if len(os.Args) > 2 && os.Args[1] == "--model" {
		os.Exit(fake(os.Args[1:]))
	}
	os.Exit(m.Run())
}

func fake(args []string) int {
	flags := map[string]string{}
	var files []string
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--no-timestamps", "--no-prints", "--suppress-nst", "--no-gpu":
			flags[args[i]] = "yes"
		case "--file":
			if i+1 < len(args) {
				files = append(files, args[i+1])
				i++
			}
		default:
			if i+1 < len(args) {
				flags[args[i]] = args[i+1]
				i++
			}
		}
	}
	mode := filepath.Base(flags["--model"])
	switch mode {
	case "fail":
		fmt.Fprintln(os.Stderr, "loading the model\nerror: failed to load model")
		return 1
	case "hang":
		time.Sleep(time.Hour) // the fake program hangs; the engine's timeout kills it
	case "gpufail": // fails on the graphics chip only
		if flags["--no-gpu"] == "" {
			fmt.Fprintln(os.Stderr, "ggml_vulkan: device lost")
			return 1
		}
	}
	if len(files) > 0 { // whisper-cli or parakeet-cli
		for _, in := range files {
			b, err := os.ReadFile(in)
			if err != nil {
				return 2
			}
			a, err := wav.Parse(b)
			if err != nil || a.Rate != wav.SpeechRate || a.Duration() < MinSpeech {
				fmt.Fprintln(os.Stderr, "bad input", err, a.Duration())
				return 3
			}
		}
		if mode == "echo" {
			gpu := "gpu"
			if flags["--no-gpu"] != "" {
				gpu = "cpu"
			}
			fmt.Printf(" %s|%s|%s|%d|%s\n", flags["--prompt"], flags["--threads"], flags["--language"], len(files), gpu)
			return 0
		}
		for range files {
			fmt.Print(" Is pve-02 okay?\n[BLANK_AUDIO]\n")
		}
		return 0
	}
	out := flags["--output-file"] // kokoro-speak or supertonic-speak (it has --lang)
	text, _ := io.ReadAll(os.Stdin)
	if strings.Count(string(text), "\n") != 1 {
		return 4
	}
	switch mode {
	case "garbage":
		_ = os.WriteFile(out, []byte("not a wav"), 0o600)
	case "nothing":
	default:
		rate, tag := 24000, flags["--accent"] // "us" or "gb"
		if flags["--lang"] != "" {
			rate, tag = 44100, flags["--lang"] // "nl"
		}
		a := wav.Audio{Rate: rate, Channels: 1, Samples: make([]int16, rate/10)}
		a.Samples[0] = int16(len(text)) // so the test sees the text arrived
		a.Samples[1] = int16(atoi(flags["--speaker"]))
		a.Samples[2] = int16(atoi(flags["--threads"]))
		a.Samples[3] = int16(len(tag) * int(tag[0]))
		_ = os.WriteFile(out, wav.Encode(a), 0o600)
	}
	return 0
}

func atoi(s string) int {
	n, _ := strconv.Atoi(s)
	return n
}

// setup returns the test binary as the program, a directory with a whisper model file and a Kokoro model directory
// named after each mode (whisper's files and Kokoro's directories in different places), and the job directory that
// must be empty after every job.
func setup(t *testing.T) (bin, models, tmp string) {
	t.Helper()
	bin, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	models, tmp = t.TempDir(), t.TempDir()
	for _, m := range []string{"ok", "echo", "fail", "hang", "garbage", "nothing"} {
		if err := os.WriteFile(filepath.Join(models, m), []byte("model"), 0o644); err != nil {
			t.Fatal(err)
		}
		dir := filepath.Join(models, "kokoro", m)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		for _, f := range append(slices.Clone(KokoroFiles), KokoroLexicon("us"), KokoroLexicon("gb")) {
			if err := os.WriteFile(filepath.Join(dir, f), []byte("model"), 0o644); err != nil {
				t.Fatal(err)
			}
		}
		dir = filepath.Join(models, "supertonic", m)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		for _, f := range SupertonicFiles {
			if err := os.WriteFile(filepath.Join(dir, f), []byte("model"), 0o644); err != nil {
				t.Fatal(err)
			}
		}
	}
	return bin, models, tmp
}

func assertEmpty(t *testing.T, dir string) {
	t.Helper()
	if left, _ := os.ReadDir(dir); len(left) != 0 {
		t.Fatalf("job files left: %v", left)
	}
}

func speechOf(d time.Duration) wav.Audio {
	return wav.Audio{Rate: wav.SpeechRate, Channels: 1, Samples: make([]int16, int(d.Seconds()*wav.SpeechRate))}
}

// stt is an STT over models named after modes (each model's file is the mode, of its size), with the test binary as
// both programs.
func stt(t *testing.T, whisperMode, parakeetMode string) (*STT, string) {
	t.Helper()
	bin, _, tmp := setup(t)
	dir := t.TempDir()
	var m models.Manifest
	for id, mode := range map[string]string{"whisper": whisperMode, "parakeet": parakeetMode} {
		if mode == "" {
			continue
		}
		if err := os.WriteFile(filepath.Join(dir, mode), []byte("model"), 0o644); err != nil {
			t.Fatal(err)
		}
		m.Models = append(m.Models, models.Model{ID: id, File: mode, Size: 5})
	}
	return &STT{Whisper: bin, Parakeet: bin, Dir: dir, Manifest: m, TmpDir: tmp, Timeout: time.Minute}, tmp
}

// probeScript is a voice-gpu-probe that answers devices.
func probeScript(t *testing.T, devices string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "probe")
	if err := os.WriteFile(p, []byte("#!/bin/sh\necho '{\"devices\":["+devices+"]}'\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	return p
}

const radv = `{"backend":"Vulkan","name":"Vulkan0","description":"AMD Radeon Graphics (RADV GFX1151)","type":"igpu","memoryTotal":68719476736}`

func TestSTTModelsAndPick(t *testing.T) {
	t.Parallel()
	s, _ := stt(t, "", "ok")
	if got := s.Models(); !slices.Equal(got, []string{"parakeet"}) {
		t.Fatal(got)
	}
	if s.Pick("auto") != "parakeet" || s.Pick("parakeet") != "parakeet" || s.Pick("whisper") != "" {
		t.Fatal(s.Pick("auto"), s.Pick("whisper"))
	}
	// Both, no chip: auto is Parakeet; a chosen Whisper is Whisper.
	s, _ = stt(t, "echo", "ok")
	if s.GPU() != nil || s.Pick("auto") != "parakeet" || s.Pick("whisper") != "whisper" {
		t.Fatal(s.Pick("auto"))
	}
	// With a chip: auto is Whisper.
	s, _ = stt(t, "echo", "ok")
	s.Probe = probeScript(t, radv)
	if g := s.GPU(); g == nil || g.Name != "AMD Radeon Graphics (RADV GFX1151)" || *g.MemoryMiB != 65536 || s.Pick("auto") != "whisper" {
		t.Fatalf("%+v %s", g, s.Pick("auto"))
	}
	// Whisper alone, no chip: still Whisper.
	s, _ = stt(t, "echo", "")
	if s.Pick("auto") != "whisper" {
		t.Fatal(s.Pick("auto"))
	}
	// A file of another size is a download that isn't complete: not there.
	s, _ = stt(t, "", "ok")
	s.Manifest.Models[0].Size = 6
	if len(s.Models()) != 0 || s.Pick("auto") != "" {
		t.Fatal(s.Models())
	}
	// A program that can't run.
	s, _ = stt(t, "", "ok")
	s.Parakeet = filepath.Join(s.Dir, "ok")
	if len(s.Models()) != 0 {
		t.Fatal(s.Models())
	}
}

func TestSTTTranscribe(t *testing.T) {
	t.Parallel()
	s, tmp := stt(t, "echo", "ok")
	s.Threads = 3
	// Half a second reaches the program padded to MinSpeech; every piece is one file of one job.
	got, gpu, err := s.Transcribe(context.Background(), "whisper", []wav.Audio{speechOf(500 * time.Millisecond), speechOf(2 * time.Second)}, "nl", "Dusty, pve-02")
	if err != nil || gpu || got != "Dusty, pve-02|3|nl|2|cpu" {
		t.Fatalf("%q %v %v", got, gpu, err)
	}
	assertEmpty(t, tmp)
	// Parakeet: the marks gone, the pieces' lines joined, no language or prompt.
	got, _, err = s.Transcribe(context.Background(), "parakeet", []wav.Audio{speechOf(time.Second), speechOf(time.Second)}, "nl", "Dusty")
	if err != nil || got != "Is pve-02 okay? Is pve-02 okay?" {
		t.Fatalf("%q %v", got, err)
	}
	assertEmpty(t, tmp)
	// Whisper's language defaults to auto.
	if got, _, _ = s.Transcribe(context.Background(), "whisper", []wav.Audio{speechOf(time.Second)}, "", ""); got != "|3|auto|1|cpu" {
		t.Fatalf("%q", got)
	}
	if _, _, err := s.Transcribe(context.Background(), "canary", nil, "", ""); !errors.Is(err, ErrNoModel) {
		t.Fatal(err)
	}
}

func TestSTTGPU(t *testing.T) {
	t.Parallel()
	s, _ := stt(t, "echo", "ok")
	s.Probe = probeScript(t, radv)
	got, gpu, err := s.Transcribe(context.Background(), "whisper", []wav.Audio{speechOf(time.Second)}, "en", "")
	if err != nil || !gpu || !strings.HasSuffix(got, "|gpu") {
		t.Fatalf("%q %v %v", got, gpu, err)
	}
	// A job that fails on the chip runs again on the processor, and the chip is off until the service restarts.
	var logged []string
	s, _ = stt(t, "gpufail", "ok")
	s.Probe, s.Log = probeScript(t, radv), func(f string, a ...any) { logged = append(logged, fmt.Sprintf(f, a...)) }
	got, gpu, err = s.Transcribe(context.Background(), "whisper", []wav.Audio{speechOf(time.Second)}, "en", "")
	if err != nil || gpu || got != "Is pve-02 okay?" || s.GPU() != nil || s.Pick("auto") != "parakeet" {
		t.Fatalf("%q %v %v, gpu %v", got, gpu, err, s.GPU())
	}
	if !slices.ContainsFunc(logged, func(l string) bool { return strings.Contains(l, "not used any more") }) {
		t.Fatal(logged)
	}
	// A chip slower than the speech (after its first job) is turned off too.
	s, _ = stt(t, "echo", "ok")
	s.Probe = probeScript(t, radv)
	s.judgeGPU(10*time.Second, 30*time.Second)
	if s.GPU() == nil {
		t.Fatal("the first job turned the chip off")
	}
	s.judgeGPU(10*time.Second, 4*time.Second)
	s.judgeGPU(3*time.Second, 9*time.Second)
	if s.GPU() == nil {
		t.Fatal("a fast or a short job turned the chip off")
	}
	s.judgeGPU(10*time.Second, 12*time.Second)
	if s.GPU() != nil {
		t.Fatal("a slow chip stays on")
	}
}

func TestPickGPU(t *testing.T) {
	t.Parallel()
	cases := []struct {
		devices string
		want    string
	}{
		{`{"backend":"CPU","name":"CPU","description":"AMD Ryzen AI MAX+ 395","type":"cpu","memoryTotal":137438953472}`, ""},
		{`{"backend":"Vulkan","name":"Vulkan0","description":"AMD Radeon 610M (RADV RAPHAEL_MENDOCINO)","type":"igpu","memoryTotal":536870912}`, ""},
		{`{"backend":"CUDA","name":"CUDA0","description":"NVIDIA GeForce RTX 4090","type":"gpu","memoryTotal":25769803776}`, ""},
		{`{"backend":"Vulkan","name":"Vulkan0","description":"Intel(R) Graphics (ADL-N)\u0000\u202e","type":"igpu","memoryTotal":8589934592}`, "Intel(R) Graphics (ADL-N)"},
		{radv, "AMD Radeon Graphics (RADV GFX1151)"},
	}
	for _, c := range cases {
		var answer struct {
			Devices []probeDevice `json:"devices"`
		}
		if err := json.Unmarshal([]byte(`{"devices":[`+c.devices+`]}`), &answer); err != nil {
			t.Fatal(err)
		}
		g := pickGPU(answer.Devices)
		if (g == nil) != (c.want == "") || (g != nil && g.Name != c.want) {
			t.Errorf("%s: %+v", c.devices, g)
		}
	}
	// No probe, or one that fails: no chip.
	s, _ := stt(t, "echo", "ok")
	if s.GPU() != nil {
		t.Fatal("a chip without a probe")
	}
	s, _ = stt(t, "echo", "ok")
	s.Probe = filepath.Join(t.TempDir(), "missing")
	if s.GPU() != nil {
		t.Fatal("a chip from a missing probe")
	}
}

func TestSTTFails(t *testing.T) {
	t.Parallel()
	s, tmp := stt(t, "", "fail")
	_, _, err := s.Transcribe(context.Background(), "parakeet", []wav.Audio{speechOf(time.Second)}, "", "")
	if err == nil || !strings.Contains(err.Error(), "failed to load model") {
		t.Fatal(err)
	}
	assertEmpty(t, tmp)
	s, tmp = stt(t, "", "hang")
	s.Timeout = 50 * time.Millisecond
	if _, _, err = s.Transcribe(context.Background(), "parakeet", []wav.Audio{speechOf(20 * time.Millisecond)}, "", ""); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal(err)
	}
	assertEmpty(t, tmp)
}

func TestSpeak(t *testing.T) {
	t.Parallel()
	bin, models, tmp := setup(t)
	voices := []KokoroVoice{{"heart", 3, "us", false}, {"emma", 21, "gb", false}}
	k := Kokoro{Bin: bin, Model: filepath.Join(models, "kokoro", "ok"), Voices: voices, Threads: 5, TmpDir: tmp, Timeout: time.Minute}
	if !k.Ready() {
		t.Fatal("not ready")
	}
	if got := k.Names(); !slices.Equal(got, []string{"heart", "emma"}) {
		t.Fatal(got)
	}
	b, err := k.Speak(context.Background(), "-5 °C outside. pve-02 is fine.", "")
	if err != nil {
		t.Fatal(err)
	}
	a, err := wav.Parse(b)
	if err != nil || a.Rate != 24000 || a.Channels != 1 || a.Samples[0] != int16(len("-5 °C outside. pve-02 is fine.\n")) {
		t.Fatalf("%v %+v", err, a.Rate)
	}
	if a.Samples[1] != 3 || a.Samples[2] != 5 || a.Samples[3] != int16(2*'u') {
		t.Fatalf("speaker %d, threads %d, accent %d", a.Samples[1], a.Samples[2], a.Samples[3])
	}
	assertEmpty(t, tmp)

	// A chosen voice: its number and its accent.
	b, err = k.Speak(context.Background(), "Hello.", "emma")
	if err != nil {
		t.Fatal(err)
	}
	if a, _ = wav.Parse(b); a.Samples[1] != 21 || a.Samples[3] != int16(2*'g') {
		t.Fatalf("speaker %d, accent %d", a.Samples[1], a.Samples[3])
	}
	if _, err := k.Speak(context.Background(), "Hello.", "nova"); !errors.Is(err, ErrUnknownVoice) {
		t.Fatal(err)
	}
	assertEmpty(t, tmp)

	for _, mode := range []string{"garbage", "nothing", "fail"} {
		k.Model = filepath.Join(models, "kokoro", mode)
		if _, err := k.Speak(context.Background(), "Hello.", ""); err == nil {
			t.Errorf("%s: no error", mode)
		}
		assertEmpty(t, tmp)
	}

	k.Model, k.Timeout = filepath.Join(models, "kokoro", "hang"), 50*time.Millisecond
	if _, err := k.Speak(context.Background(), "Hello.", ""); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal(err)
	}
	assertEmpty(t, tmp)
}

// Dutch is Supertonic's, in its voice of the kind of the English voice asked for (NX-478); English stays Kokoro's.
func TestSpeakDutch(t *testing.T) {
	t.Parallel()
	bin, models, tmp := setup(t)
	voices := []KokoroVoice{{"heart", 3, "us", false}, {"george", 26, "gb", true}}
	tts := TTS{
		Kokoro: Kokoro{Bin: bin, Model: filepath.Join(models, "kokoro", "ok"), Voices: voices, TmpDir: tmp, Timeout: time.Minute},
		Dutch: Supertonic{
			Bin: bin, Model: filepath.Join(models, "supertonic", "ok"), Woman: 1, Man: 8, Threads: 3, TmpDir: tmp, Timeout: time.Minute,
		},
	}
	if !tts.Dutch.Ready() || !slices.Equal(tts.Languages(), []string{"en", "nl"}) {
		t.Fatal(tts.Languages())
	}
	said := func(voice, language string) wav.Audio {
		t.Helper()
		b, err := tts.Speak(context.Background(), "Ja, P V E nul twee draait prima.", voice, language)
		if err != nil {
			t.Fatal(err)
		}
		a, err := wav.Parse(b)
		if err != nil {
			t.Fatal(err)
		}
		return a
	}
	if a := said("", "nl"); a.Rate != 44100 || a.Samples[1] != 1 || a.Samples[2] != 3 || a.Samples[3] != int16(2*'n') {
		t.Fatalf("the default (a woman's) voice in Dutch: rate %d, speaker %d, threads %d, lang %d", a.Rate, a.Samples[1], a.Samples[2], a.Samples[3])
	}
	if a := said("george", "nl"); a.Samples[1] != 8 {
		t.Fatalf("a man's voice in Dutch: speaker %d", a.Samples[1])
	}
	if a := said("george", "en"); a.Rate != 24000 || a.Samples[1] != 26 || a.Samples[3] != int16(2*'g') {
		t.Fatalf("English: rate %d, speaker %d", a.Rate, a.Samples[1])
	}
	if a := said("", ""); a.Rate != 24000 || a.Samples[1] != 3 {
		t.Fatalf("no language: rate %d, speaker %d", a.Rate, a.Samples[1])
	}
	if _, err := tts.Speak(context.Background(), "Hallo.", "nova", "nl"); !errors.Is(err, ErrUnknownVoice) {
		t.Fatal(err)
	}
	if _, err := tts.Speak(context.Background(), "Hallo.", "", "de"); !errors.Is(err, ErrUnknownLanguage) {
		t.Fatal(err)
	}
	assertEmpty(t, tmp)

	tts.Dutch.Model = filepath.Join(models, "supertonic", "fail")
	if _, err := tts.Speak(context.Background(), "Hallo.", "", "nl"); err == nil {
		t.Fatal("a failing supertonic-speak answered")
	}
	assertEmpty(t, tmp)

	// Without the model (or without Supertonic at all) it speaks English only.
	for _, f := range SupertonicFiles {
		dir := filepath.Join(models, "supertonic", "ok")
		_ = os.Rename(filepath.Join(dir, f), filepath.Join(dir, f+".gone"))
		tts.Dutch.Model = dir
		if tts.Dutch.Ready() || !slices.Equal(tts.Languages(), []string{"en"}) {
			t.Errorf("Dutch without %s", f)
		}
		_ = os.Rename(filepath.Join(dir, f+".gone"), filepath.Join(dir, f))
	}
	tts.Dutch = Supertonic{}
	if _, err := tts.Speak(context.Background(), "Hallo.", "", "nl"); !errors.Is(err, ErrUnknownLanguage) || !slices.Equal(tts.Languages(), []string{"en"}) {
		t.Fatal(err, tts.Languages())
	}
}

func TestReady(t *testing.T) {
	t.Parallel()
	bin, models, _ := setup(t)
	if (Kokoro{Bin: bin, Model: filepath.Join(models, "kokoro", "ok")}).Ready() {
		t.Error("kokoro ready without a voice")
	}
	voices := []KokoroVoice{{"heart", 3, "us", false}, {"emma", 21, "gb", false}}
	for _, f := range append(slices.Clone(KokoroFiles), KokoroLexicon("us"), KokoroLexicon("gb")) {
		dir := filepath.Join(models, "kokoro", "ok")
		_ = os.Rename(filepath.Join(dir, f), filepath.Join(dir, f+".gone"))
		if (Kokoro{Bin: bin, Model: dir, Voices: voices}).Ready() {
			t.Errorf("kokoro ready without %s", f)
		}
		_ = os.Rename(filepath.Join(dir, f+".gone"), filepath.Join(dir, f))
	}
	// Only the lexicons of its voices' accents are needed.
	dir := filepath.Join(models, "kokoro", "ok")
	_ = os.Remove(filepath.Join(dir, KokoroLexicon("gb")))
	if !(Kokoro{Bin: bin, Model: dir, Voices: voices[:1]}).Ready() {
		t.Error("kokoro not ready with only American voices and their lexicon")
	}
}

func TestParseKokoroVoices(t *testing.T) {
	t.Parallel()
	v, err := ParseKokoroVoices("heart=3:us, emma=21:gb:woman, george=26:gb:man")
	if err != nil || len(v) != 3 || v[0] != (KokoroVoice{"heart", 3, "us", false}) || v[1] != (KokoroVoice{"emma", 21, "gb", false}) ||
		v[2] != (KokoroVoice{"george", 26, "gb", true}) {
		t.Fatal(v, err)
	}
	for _, bad := range []string{
		"", "heart", "heart=3", "heart=x:us", "heart=-1:us", "heart=3:fr", "Heart=3:us", "heart=3:us,heart=2:us",
		"george=26:gb:boy", "george=26:gb:man:x",
	} {
		if _, err := ParseKokoroVoices(bad); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
}

func TestThreads(t *testing.T) {
	t.Parallel()
	if Threads(3) != 3 {
		t.Fatal("explicit threads ignored")
	}
	if n := Threads(0); n < 1 || n > 8 {
		t.Fatal(n)
	}
}
