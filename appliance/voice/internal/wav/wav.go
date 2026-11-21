// Package wav reads and writes the one audio format the voice service deals in: RIFF/WAVE with 16-bit signed
// little-endian PCM samples (NX-176). Speech arrives as 16 kHz mono (what the console page records, the contract's
// DeskWav); Kokoro's answers are mono at the model's own rate (24 kHz).
package wav

import (
	"encoding/binary"
	"errors"
	"fmt"
	"math"
	"time"

	"github.com/CybexBV/whombat/contracts/go/local"
)

// SpeechRate is the sample rate of speech sent to /v1/voice/stt (the contract's DeskAudioSampleRate, and what
// whisper.cpp works at).
const SpeechRate = local.DeskAudioSampleRate

// MaxSpeech is the longest speech /v1/voice/stt takes (DK-06: hold to talk, at most 30 s; DeskAudioMaxSeconds).
const MaxSpeech = local.DeskAudioMaxSeconds * time.Second

const (
	formatPCM        = 1
	formatExtensible = 0xFFFE
	headerSize       = 44
)

// ErrNotWAV: not a RIFF/WAVE file, or its chunks don't add up.
var ErrNotWAV = errors.New("not a WAV file")

// Audio is decoded 16-bit PCM.
type Audio struct {
	Rate     int
	Channels int
	// Samples are interleaved when Channels > 1.
	Samples []int16
}

// Duration is the audio's length.
func (a Audio) Duration() time.Duration {
	if a.Rate <= 0 || a.Channels <= 0 {
		return 0
	}
	frames := len(a.Samples) / a.Channels
	return time.Duration(frames) * time.Second / time.Duration(a.Rate)
}

// Parse decodes a RIFF/WAVE file with 16-bit PCM samples (format 1, or WAVE_FORMAT_EXTENSIBLE with the PCM
// sub-format). Chunks other than `fmt ` and `data` are skipped; the data chunk must be complete and hold whole frames.
func Parse(b []byte) (Audio, error) {
	if len(b) < 12 || string(b[0:4]) != "RIFF" || string(b[8:12]) != "WAVE" {
		return Audio{}, ErrNotWAV
	}
	var (
		a       Audio
		haveFmt bool
		le      = binary.LittleEndian
	)
	for off := 12; ; {
		if off+8 > len(b) {
			return Audio{}, fmt.Errorf("%w: no data chunk", ErrNotWAV)
		}
		id, size := string(b[off:off+4]), int64(le.Uint32(b[off+4:off+8]))
		body := off + 8
		if int64(body)+size > int64(len(b)) {
			return Audio{}, fmt.Errorf("%w: chunk %q runs past the end", ErrNotWAV, id)
		}
		chunk := b[body : body+int(size)]
		switch id {
		case "fmt ":
			if len(chunk) < 16 {
				return Audio{}, fmt.Errorf("%w: short fmt chunk", ErrNotWAV)
			}
			format := le.Uint16(chunk[0:2])
			if format == formatExtensible {
				// cbSize ≥ 22, then valid bits, channel mask and the sub-format GUID, whose first two bytes are the format.
				if len(chunk) < 40 {
					return Audio{}, fmt.Errorf("%w: short extensible fmt chunk", ErrNotWAV)
				}
				format = le.Uint16(chunk[24:26])
			}
			channels, rate, bits := int(le.Uint16(chunk[2:4])), int(le.Uint32(chunk[4:8])), int(le.Uint16(chunk[14:16]))
			blockAlign := int(le.Uint16(chunk[12:14]))
			if format != formatPCM || bits != 16 {
				return Audio{}, fmt.Errorf("%w: not 16-bit PCM (format %d, %d bits)", ErrNotWAV, format, bits)
			}
			if channels < 1 || channels > 8 || rate < 1000 || rate > 192000 || blockAlign != channels*2 {
				return Audio{}, fmt.Errorf("%w: %d channels at %d Hz, block %d", ErrNotWAV, channels, rate, blockAlign)
			}
			a.Rate, a.Channels, haveFmt = rate, channels, true
		case "data":
			if !haveFmt {
				return Audio{}, fmt.Errorf("%w: data before fmt", ErrNotWAV)
			}
			if len(chunk)%(2*a.Channels) != 0 {
				return Audio{}, fmt.Errorf("%w: data holds a partial frame", ErrNotWAV)
			}
			a.Samples = make([]int16, len(chunk)/2)
			for i := range a.Samples {
				a.Samples[i] = int16(le.Uint16(chunk[2*i:]))
			}
			return a, nil
		}
		// Chunks are padded to an even size.
		off = body + int(size) + int(size&1)
	}
}

// Encode writes canonical 44-byte-header WAV bytes.
func Encode(a Audio) []byte {
	le := binary.LittleEndian
	data := len(a.Samples) * 2
	b := make([]byte, headerSize+data)
	copy(b[0:4], "RIFF")
	le.PutUint32(b[4:8], uint32(36+data))
	copy(b[8:16], "WAVEfmt ")
	le.PutUint32(b[16:20], 16)
	le.PutUint16(b[20:22], formatPCM)
	le.PutUint16(b[22:24], uint16(a.Channels))
	le.PutUint32(b[24:28], uint32(a.Rate))
	le.PutUint32(b[28:32], uint32(a.Rate*a.Channels*2))
	le.PutUint16(b[32:34], uint16(a.Channels*2))
	le.PutUint16(b[34:36], 16)
	copy(b[36:40], "data")
	le.PutUint32(b[40:44], uint32(data))
	for i, s := range a.Samples {
		le.PutUint16(b[headerSize+2*i:], uint16(s))
	}
	return b
}

// CheckSpeech says whether a is what /v1/voice/stt takes: 16 kHz mono, at most MaxSpeech.
func CheckSpeech(a Audio) error {
	if a.Rate != SpeechRate || a.Channels != 1 {
		return fmt.Errorf("speech must be 16 kHz mono, not %d Hz with %d channels", a.Rate, a.Channels)
	}
	return nil
}

// PadTo appends silence so a lasts at least d. whisper.cpp ignores input shorter than a second.
func PadTo(a Audio, d time.Duration) Audio {
	want := int(int64(d) * int64(a.Rate) / int64(time.Second))
	frames := len(a.Samples) / max(a.Channels, 1)
	if frames >= want {
		return a
	}
	s := make([]int16, want*a.Channels)
	copy(s, a.Samples)
	a.Samples = s
	return a
}

// Peak is the largest absolute sample as a share of full scale (0…1).
func Peak(a Audio) float64 {
	var m int
	for _, s := range a.Samples {
		v := int(s)
		if v < 0 {
			v = -v
		}
		m = max(m, v)
	}
	return float64(m) / 32768
}

// Silent says whether a never gets louder than the threshold in dBFS (e.g. −40): nobody spoke, or the microphone is
// muted. whisper.cpp tends to “hear” a polite phrase in silence, so silence never reaches it.
func Silent(a Audio, thresholdDBFS float64) bool {
	p := Peak(a)
	return p == 0 || 20*math.Log10(p) < thresholdDBFS
}

// MaxTyping is the longest recording /v1/voice/transcribe takes (voice typing, VoiceTypingMaxSeconds).
const MaxTyping = local.VoiceTypingMaxSeconds * time.Second

// PieceMax is the longest piece a recording is cut into: the models hear 30 s at a time, and Parakeet drops words
// and needs much more memory when it is given minutes at once (NX-471).
const PieceMax = 30 * time.Second

// Split cuts mono a into pieces of at most longest, each cut at the quietest 200 ms in the last third of the piece,
// so a cut falls in a pause between words rather than in one. A recording up to longest is one piece.
func Split(a Audio, longest time.Duration) []Audio {
	if a.Channels != 1 || a.Rate <= 0 {
		return []Audio{a}
	}
	limit := int(int64(longest) * int64(a.Rate) / int64(time.Second))
	window := a.Rate / 5
	step := max(a.Rate/50, 1)
	var out []Audio
	s := a.Samples
	for len(s) > limit {
		lo, hi := limit*2/3, limit-window
		cut, best := hi, math.Inf(1)
		for at := lo; at <= hi; at += step {
			if e := energy(s[at : at+window]); e < best {
				cut, best = at+window/2, e
			}
		}
		out = append(out, Audio{Rate: a.Rate, Channels: 1, Samples: s[:cut]})
		s = s[cut:]
	}
	return append(out, Audio{Rate: a.Rate, Channels: 1, Samples: s})
}

func energy(s []int16) float64 {
	var sum float64
	for _, v := range s {
		sum += float64(v) * float64(v)
	}
	return sum
}
