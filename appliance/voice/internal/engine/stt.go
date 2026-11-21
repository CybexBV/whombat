package engine

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/CybexBV/whombat/appliance/voice/internal/models"
	"github.com/CybexBV/whombat/appliance/voice/internal/speech"
	"github.com/CybexBV/whombat/appliance/voice/internal/wav"
	"github.com/CybexBV/whombat/contracts/go/local"
)

// GPUMinMemory is the least memory a graphics chip needs for Whisper large-v3-turbo (its 574 MB of weights and its
// working buffers), NX-472.
const GPUMinMemory = 2 << 30

// STT is speech to text with whisper.cpp's two programs over the models the fetcher downloaded (NX-470, NX-471):
// whisper-cli runs Whisper, parakeet-cli runs Parakeet, each once per job with every piece of the recording. Both use
// the graphics chip the probe found, unless it failed or turned out slower than speech; then the processor.
type STT struct {
	// Whisper is whisper-cli, Parakeet parakeet-cli, Probe voice-gpu-probe (empty: no graphics chip).
	Whisper, Parakeet, Probe string
	// Dir holds the downloaded models, Manifest names them.
	Dir      string
	Manifest models.Manifest
	// Threads for both programs; 0: the CPUs this process may use, at most 8.
	Threads int
	TmpDir  string
	// Timeout is how long a job may take, and three times the speech's length more (Whisper on a processor takes
	// about as long as the speech).
	Timeout time.Duration
	// Env is added to the programs' environment (the Vulkan drivers, the shader cache).
	Env []string
	Log func(format string, args ...any)

	mu sync.Mutex
	// probed: the probe ran (once a service's life); gpu: what it found; gpuOff: why the chip isn't used any more.
	probed bool
	gpu    *local.VoiceGpu
	gpuOff string
	// gpuJobs counts the jobs on the chip: the first one of a service's life compiles the shaders and isn't judged.
	gpuJobs int
}

// bin is the program that runs speech-to-text model id, or "" for models that aren't speech-to-text.
func (s *STT) bin(id string) string {
	switch id {
	case local.VoiceModelParakeet:
		return s.Parakeet
	case local.VoiceModelWhisper:
		return s.Whisper
	default:
		return ""
	}
}

// usable says whether model id is downloaded and its program can run.
func (s *STT) usable(id string) bool {
	m, ok := s.Manifest.Find(id)
	return ok && executable(s.bin(id)) && models.Present(s.Dir, m)
}

// Models are the speech-to-text models that are downloaded and run, in the manifest's order.
func (s *STT) Models() []string {
	var out []string
	for _, m := range s.Manifest.Models {
		if s.usable(m.ID) {
			out = append(out, m.ID)
		}
	}
	return out
}

// GPU is the graphics chip the programs run on, nil when there is none (or it failed, or was slow). The probe runs
// the first time it is asked.
func (s *STT) GPU() *local.VoiceGpu {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.probed {
		s.probed = true
		g, err := s.probe()
		switch {
		case err != nil:
			s.logf("gpu: the probe failed: %v", err)
		case g == nil:
			s.logf("gpu: none, speech runs on the processor")
		default:
			s.logf("gpu: %s", g.Name)
		}
		s.gpu = g
	}
	if s.gpuOff != "" {
		return nil
	}
	return s.gpu
}

// probeDevice is one line of voice-gpu-probe's answer: a ggml device.
type probeDevice struct {
	Backend     string `json:"backend"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Type        string `json:"type"`
	MemoryTotal int64  `json:"memoryTotal"`
}

// probe runs voice-gpu-probe and picks the first Vulkan GPU (discrete or integrated) with GPUMinMemory.
func (s *STT) probe() (*local.VoiceGpu, error) {
	if s.Probe == "" || !executable(s.Probe) {
		return nil, nil
	}
	dir, err := os.MkdirTemp(s.TmpDir, "probe-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(dir)
	out, err := run(context.Background(), 30*time.Second, dir, s.Probe, nil, nil, s.Env)
	if err != nil {
		return nil, err
	}
	var answer struct {
		Devices []probeDevice `json:"devices"`
	}
	if err := json.Unmarshal([]byte(strings.TrimSpace(out)), &answer); err != nil {
		return nil, fmt.Errorf("the probe's answer: %w", err)
	}
	return pickGPU(answer.Devices), nil
}

// pickGPU is the first device that can run Whisper well, as the contract names it.
func pickGPU(devices []probeDevice) *local.VoiceGpu {
	for _, d := range devices {
		if d.Backend != "Vulkan" || (d.Type != "gpu" && d.Type != "igpu") || d.MemoryTotal < GPUMinMemory {
			continue
		}
		name := gpuName(d.Description)
		if name == "" {
			name = gpuName(d.Name)
		}
		if name == "" {
			continue
		}
		mib := d.MemoryTotal >> 20
		return &local.VoiceGpu{Name: name, Backend: "vulkan", MemoryMiB: &mib}
	}
	return nil
}

// gpuName is a device's description as the contract takes it: printable ASCII, at most 200 characters.
func gpuName(s string) string {
	var b strings.Builder
	for _, r := range speech.Line(s) {
		if r >= 0x20 && r <= 0x7e {
			b.WriteRune(r)
		}
	}
	return speech.Cut(strings.TrimSpace(b.String()), 200)
}

// Pick is the model a choice goes to now, "" when none can: `auto` is Whisper on a usable graphics chip, else
// Parakeet, else Whisper on the processor (Whombat DT-03); a model by name is that model when it is downloaded.
func (s *STT) Pick(choice string) string {
	switch choice {
	case local.VoiceChoiceParakeet, local.VoiceChoiceWhisper:
		if s.usable(choice) {
			return choice
		}
		return ""
	}
	whisper, parakeet := s.usable(local.VoiceModelWhisper), s.usable(local.VoiceModelParakeet)
	switch {
	case whisper && s.GPU() != nil:
		return local.VoiceModelWhisper
	case parakeet:
		return local.VoiceModelParakeet
	case whisper:
		return local.VoiceModelWhisper
	}
	return ""
}

// ErrNoModel is a model that isn't downloaded (or its program is missing).
var ErrNoModel = errors.New("the model isn't downloaded")

// Transcribe turns the pieces of one recording into one line of text with model id (Pick's answer): Whisper in
// language ("auto" lets it hear which) with prompt as its initial prompt, Parakeet hearing the language itself. gpu
// says whether it ran on the graphics chip. A job that fails on the chip runs again on the processor, and the chip is
// not used again until the service restarts; so is a chip slower than the speech itself.
func (s *STT) Transcribe(ctx context.Context, id string, pieces []wav.Audio, language, prompt string) (string, bool, error) {
	if !s.usable(id) {
		return "", false, ErrNoModel
	}
	m, _ := s.Manifest.Find(id)
	var length time.Duration
	for _, p := range pieces {
		length += p.Duration()
	}
	timeout := s.Timeout + 3*length
	gpu := s.GPU() != nil
	start := time.Now()
	text, err := s.job(ctx, id, models.Path(s.Dir, m), pieces, language, prompt, gpu, timeout)
	if err != nil && gpu && ctx.Err() == nil {
		s.turnOffGPU(fmt.Sprintf("a job failed on it: %v", err))
		gpu = false
		text, err = s.job(ctx, id, models.Path(s.Dir, m), pieces, language, prompt, false, timeout)
	} else if err == nil && gpu {
		s.judgeGPU(length, time.Since(start))
	}
	return text, gpu, err
}

// job runs one program over every piece.
func (s *STT) job(ctx context.Context, id, model string, pieces []wav.Audio, language, prompt string, gpu bool, timeout time.Duration) (string, error) {
	dir, err := os.MkdirTemp(s.TmpDir, "stt-")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(dir)
	args := []string{"--model", model, "--threads", strconv.Itoa(Threads(s.Threads)), "--no-prints"}
	if !gpu {
		args = append(args, "--no-gpu")
	}
	if id == local.VoiceModelWhisper {
		if language == "" {
			language = local.VoiceLanguageAuto
		}
		args = append(args, "--language", language, "--no-timestamps", "--suppress-nst")
		if prompt != "" {
			args = append(args, "--prompt", prompt)
		}
	}
	for i, p := range pieces {
		in := filepath.Join(dir, fmt.Sprintf("piece-%02d.wav", i))
		if err := os.WriteFile(in, wav.Encode(wav.PadTo(p, MinSpeech)), 0o600); err != nil {
			return "", err
		}
		args = append(args, "--file", in)
	}
	out, err := run(ctx, timeout, dir, s.bin(id), args, nil, s.Env)
	if err != nil {
		return "", err
	}
	return speech.Clean(out), nil
}

func (s *STT) turnOffGPU(why string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.gpuOff == "" {
		s.gpuOff = why
		s.logf("gpu: not used any more: %s", why)
	}
}

// judgeGPU turns the chip off when a job of at least 5 s of speech took longer than the speech (after the first job,
// which compiles the shaders): the processor's Parakeet does better then.
func (s *STT) judgeGPU(length, took time.Duration) {
	s.mu.Lock()
	s.gpuJobs++
	first := s.gpuJobs == 1
	s.mu.Unlock()
	if !first && length >= 5*time.Second && took > length {
		s.turnOffGPU(fmt.Sprintf("%s of speech took %s", length.Round(time.Second), took.Round(100*time.Millisecond)))
	}
}

func (s *STT) logf(format string, args ...any) {
	if s.Log != nil {
		s.Log(format, args...)
	}
}
