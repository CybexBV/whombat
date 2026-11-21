// Command whombat-voice is speech on the box for the desk display and voice typing (Whombat DK-06, DK-07, DT-01…;
// NX-175…NX-184, NX-291, NX-470): speech to text with whisper.cpp (Whisper and Parakeet, over the models the model
// fetcher downloaded, on the graphics chip when the box has one) and text to speech through sherpa-onnx, in English
// with Kokoro (kokoro-speak) and in Dutch with Supertonic 3 (supertonic-speak, NX-476), for the runtime server, on a
// Unix socket, with no network.
//
//	whombat-voice --whisper BIN --parakeet BIN --models DIR --manifest FILE [--gpu-probe BIN] [--env K=V,…]
//	              --kokoro BIN --kokoro-model DIR [--kokoro-voices heart=3:us,george=26:gb:man,…]
//	              [--supertonic BIN --supertonic-model DIR --supertonic-speakers 1,8]
//	              [--socket /run/whombat-voice/voice.sock] [--allow-uid 0,951] [--threads 0] [--queue 2]
//	              [--pcm /proc/asound/pcm] [--tmp DIR] [--stt-timeout 90s] [--tts-timeout 60s]
//
// Under socket activation (whombat-voice.socket) the socket is systemd's; otherwise it is made at --socket, 0660.
// The microphone is the console's (its Chromium records while someone holds to talk); this service only turns what
// it is sent into text, and text into an answer's audio, one job at a time, and keeps nothing.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/CybexBV/whombat/appliance/helper/pkg/peercred"
	"github.com/CybexBV/whombat/appliance/voice/internal/api"
	"github.com/CybexBV/whombat/appliance/voice/internal/engine"
	"github.com/CybexBV/whombat/appliance/voice/internal/jobs"
	"github.com/CybexBV/whombat/appliance/voice/internal/models"
	"github.com/CybexBV/whombat/appliance/voice/internal/sound"
	"github.com/CybexBV/whombat/contracts/go/local"
)

func main() {
	socket := flag.String("socket", local.VoiceSocketDefault, "the socket (ignored under socket activation)")
	whisper := flag.String("whisper", "whisper-cli", "whisper.cpp's whisper-cli")
	parakeet := flag.String("parakeet", "parakeet-cli", "whisper.cpp's parakeet-cli")
	probe := flag.String("gpu-probe", "", "voice-gpu-probe (empty: speech runs on the processor)")
	modelsDir := flag.String("models", "", "the downloaded speech models (read only)")
	manifest := flag.String("manifest", "", "the release's speech models (models.Manifest)")
	env := flag.String("env", "", "comma-separated KEY=VALUE for the speech programs (the Vulkan drivers, the shader cache)")
	kokoro := flag.String("kokoro", "kokoro-speak", "kokoro-speak (Kokoro through sherpa-onnx)")
	kokoroModel := flag.String("kokoro-model", "", "the Kokoro model's directory (model.onnx, voices.bin, tokens.txt, lexicon-us-en.txt)")
	kokoroVoices := flag.String("kokoro-voices", "heart=3:us", "the voices, name=speaker:accent (us or gb)[:man|woman], the default first")
	supertonic := flag.String("supertonic", "", "supertonic-speak (Supertonic 3 through sherpa-onnx; empty: no Dutch)")
	supertonicModel := flag.String("supertonic-model", "", "the Supertonic model's directory (the int8 ONNX files, tts.json, unicode_indexer.bin, voice.bin)")
	supertonicSpeakers := flag.String("supertonic-speakers", "1,8", "Supertonic's speakers for a woman's and a man's voice (0–4 its women, 5–9 its men)")
	allow := flag.String("allow-uid", "", "comma-separated uids that may connect (SO_PEERCRED); empty: the socket's mode decides")
	threads := flag.Int("threads", 0, "whisper's and Kokoro's threads (0: the CPUs this process may use, at most 8)")
	queue := flag.Int("queue", local.VoiceQueueMax, "jobs that may wait behind the running one")
	pcm := flag.String("pcm", sound.PCMFile, "the kernel's ALSA PCM list")
	tmp := flag.String("tmp", os.TempDir(), "where each job's files live while it runs (a private tmpfs)")
	sttTimeout := flag.Duration("stt-timeout", 90*time.Second, "longest speech-to-text job")
	ttsTimeout := flag.Duration("tts-timeout", 60*time.Second, "longest text-to-speech job")
	flag.Parse()

	uids, err := parseUIDs(*allow)
	voices, verr := engine.ParseKokoroVoices(*kokoroVoices)
	if err == nil {
		err = verr
	}
	woman, man, serr := parseSpeakers(*supertonicSpeakers)
	if err == nil {
		err = serr
	}
	m, merr := models.Load(*manifest)
	if err == nil {
		err = merr
	}
	if err != nil || *modelsDir == "" || *kokoroModel == "" || *queue < 0 {
		fmt.Fprintln(os.Stderr, "whombat-voice: --models, --manifest and --kokoro-model are required; --allow-uid is a list of uids:", err)
		os.Exit(2)
	}
	logf := func(f string, a ...any) { fmt.Fprintf(os.Stderr, f+"\n", a...) }
	// The programs run in each job's own directory: the models' path must not depend on where the service started.
	dir, err := filepath.Abs(*modelsDir)
	if err != nil {
		fmt.Fprintln(os.Stderr, "whombat-voice:", err)
		os.Exit(2)
	}
	stt := &engine.STT{
		Whisper: *whisper, Parakeet: *parakeet, Probe: *probe, Dir: dir, Manifest: m,
		Threads: *threads, TmpDir: *tmp, Timeout: *sttTimeout, Env: splitList(*env), Log: logf,
	}
	tts := engine.TTS{
		Kokoro: engine.Kokoro{Bin: *kokoro, Model: *kokoroModel, Voices: voices, Threads: *threads, TmpDir: *tmp, Timeout: *ttsTimeout},
		Dutch: engine.Supertonic{
			Bin: *supertonic, Model: *supertonicModel, Woman: woman, Man: man, Threads: *threads, TmpDir: *tmp, Timeout: *ttsTimeout,
		},
	}
	s := &api.Server{
		Engine:    both{stt, tts},
		Jobs:      jobs.New(*queue),
		Sound:     func() sound.Devices { return sound.Read(*pcm) },
		AllowUIDs: uids,
		Log:       logf,
	}

	l, err := listener(*socket)
	if err != nil {
		fmt.Fprintln(os.Stderr, "whombat-voice:", err)
		os.Exit(1)
	}
	srv := &http.Server{
		Handler:           s.Handler(),
		ConnContext:       peercred.ConnContext,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       30 * time.Second,
		// A job may wait for two before it and then run its own course; a long recording's answer lifts it (api).
		WriteTimeout: 3*max(*sttTimeout, *ttsTimeout) + 10*time.Second,
		IdleTimeout:  time.Minute,
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()
	go func() {
		<-ctx.Done()
		notify("STOPPING=1")
		c, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(c)
	}()
	ms := stt.Models()
	status := fmt.Sprintf("speech models %s, text to speech %s in %s, threads %d", modelWord(ms), word(tts.Ready()),
		strings.Join(tts.Languages(), " and "), engine.Threads(*threads))
	fmt.Fprintln(os.Stderr, "whombat-voice:", status)
	notify("READY=1\nSTATUS=" + status)
	if err := srv.Serve(l); err != nil && !errors.Is(err, http.ErrServerClosed) {
		fmt.Fprintln(os.Stderr, "whombat-voice:", err)
		os.Exit(1)
	}
}

type both struct {
	*engine.STT
	engine.TTS
}

func (b both) TTSReady() bool { return b.TTS.Ready() }

// parseSpeakers reads Supertonic's `woman,man` speakers (0–9).
func parseSpeakers(s string) (int, int, error) {
	a, b, ok := strings.Cut(s, ",")
	woman, err1 := strconv.Atoi(strings.TrimSpace(a))
	man, err2 := strconv.Atoi(strings.TrimSpace(b))
	if !ok || err1 != nil || err2 != nil || woman < 0 || woman > 9 || man < 0 || man > 9 {
		return 0, 0, fmt.Errorf("--supertonic-speakers: not woman,man: %q", s)
	}
	return woman, man, nil
}

func modelWord(ms []string) string {
	if len(ms) == 0 {
		return "not downloaded yet"
	}
	return strings.Join(ms, " and ")
}

func splitList(s string) []string {
	var out []string
	for _, f := range strings.Split(s, ",") {
		if f = strings.TrimSpace(f); f != "" {
			out = append(out, f)
		}
	}
	return out
}

func word(ok bool) string {
	if ok {
		return "ready"
	}
	return "missing"
}

func parseUIDs(s string) ([]uint32, error) {
	var out []uint32
	for _, f := range strings.Split(s, ",") {
		if f = strings.TrimSpace(f); f == "" {
			continue
		}
		n, err := strconv.ParseUint(f, 10, 32)
		if err != nil {
			return nil, err
		}
		out = append(out, uint32(n))
	}
	return out, nil
}

// listener is systemd's socket (LISTEN_FDS) or a new one at path, 0660.
func listener(path string) (net.Listener, error) {
	if os.Getenv("LISTEN_FDS") == "1" && os.Getenv("LISTEN_PID") == strconv.Itoa(os.Getpid()) {
		return net.FileListener(os.NewFile(3, "voice.sock"))
	}
	_ = os.Remove(path)
	l, err := net.Listen("unix", path)
	if err == nil {
		err = os.Chmod(path, 0o660)
	}
	return l, err
}

// notify sends a state to systemd ($NOTIFY_SOCKET); a no-op outside systemd.
func notify(state string) {
	path := os.Getenv("NOTIFY_SOCKET")
	if path == "" {
		return
	}
	if path[0] == '@' {
		path = "\x00" + path[1:]
	}
	conn, err := net.DialUnix("unixgram", nil, &net.UnixAddr{Name: path, Net: "unixgram"})
	if err != nil {
		return
	}
	defer conn.Close()
	_, _ = conn.Write([]byte(state))
}
