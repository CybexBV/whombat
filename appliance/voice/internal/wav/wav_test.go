package wav

import (
	"encoding/binary"
	"errors"
	"math"
	"testing"
	"time"
)

func tone(rate, channels int, d time.Duration, amp float64) Audio {
	n := int(int64(d)*int64(rate)/int64(time.Second)) * channels
	s := make([]int16, n)
	for i := range s {
		s[i] = int16(amp * 32767 * math.Sin(2*math.Pi*440*float64(i/channels)/float64(rate)))
	}
	return Audio{Rate: rate, Channels: channels, Samples: s}
}

func TestRoundTrip(t *testing.T) {
	a := tone(SpeechRate, 1, 250*time.Millisecond, 0.5)
	b := Encode(a)
	if len(b) != 44+len(a.Samples)*2 || string(b[0:4]) != "RIFF" || string(b[8:16]) != "WAVEfmt " {
		t.Fatalf("header %q, %d bytes", b[:16], len(b))
	}
	got, err := Parse(b)
	if err != nil {
		t.Fatal(err)
	}
	if got.Rate != SpeechRate || got.Channels != 1 || len(got.Samples) != len(a.Samples) || got.Samples[7] != a.Samples[7] {
		t.Fatalf("got %d Hz %d ch %d samples", got.Rate, got.Channels, len(got.Samples))
	}
	if got.Duration() != 250*time.Millisecond {
		t.Fatal(got.Duration())
	}
	if CheckSpeech(got) != nil {
		t.Fatal("16 kHz mono is speech")
	}
}

// chunked builds a WAV from raw chunks (id, body), padding odd ones.
func chunked(chunks ...[2]string) []byte {
	var body []byte
	for _, c := range chunks {
		h := make([]byte, 8)
		copy(h, c[0])
		binary.LittleEndian.PutUint32(h[4:], uint32(len(c[1])))
		body = append(append(body, h...), c[1]...)
		if len(c[1])%2 == 1 {
			body = append(body, 0)
		}
	}
	h := make([]byte, 12)
	copy(h, "RIFF")
	binary.LittleEndian.PutUint32(h[4:], uint32(4+len(body)))
	copy(h[8:], "WAVE")
	return append(h, body...)
}

func fmtChunk(format, channels, rate, bits int) string {
	b := make([]byte, 16)
	le := binary.LittleEndian
	le.PutUint16(b[0:], uint16(format))
	le.PutUint16(b[2:], uint16(channels))
	le.PutUint32(b[4:], uint32(rate))
	le.PutUint32(b[8:], uint32(rate*channels*bits/8))
	le.PutUint16(b[12:], uint16(channels*bits/8))
	le.PutUint16(b[14:], uint16(bits))
	return string(b)
}

func TestParseSkipsOtherChunks(t *testing.T) {
	// A LIST chunk of odd length before fmt, and one between fmt and data, as browsers' and editors' encoders write.
	b := chunked(
		[2]string{"LIST", "INFOabc"},
		[2]string{"fmt ", fmtChunk(1, 1, SpeechRate, 16)},
		[2]string{"fact", "\x04\x00\x00\x00"},
		[2]string{"data", "\x01\x00\xff\xff"},
	)
	a, err := Parse(b)
	if err != nil {
		t.Fatal(err)
	}
	if len(a.Samples) != 2 || a.Samples[0] != 1 || a.Samples[1] != -1 {
		t.Fatalf("%v", a.Samples)
	}
}

func TestParseExtensible(t *testing.T) {
	f := []byte(fmtChunk(0xFFFE, 1, SpeechRate, 16))
	ext := make([]byte, 24)
	binary.LittleEndian.PutUint16(ext[0:], 22) // cbSize
	binary.LittleEndian.PutUint16(ext[2:], 16) // valid bits
	binary.LittleEndian.PutUint16(ext[8:], 1)  // sub-format: PCM
	b := chunked([2]string{"fmt ", string(append(f, ext...))}, [2]string{"data", "\x00\x00"})
	if _, err := Parse(b); err != nil {
		t.Fatal(err)
	}
	binary.LittleEndian.PutUint16(ext[8:], 3) // IEEE float
	b = chunked([2]string{"fmt ", string(append(f, ext...))}, [2]string{"data", "\x00\x00"})
	if _, err := Parse(b); !errors.Is(err, ErrNotWAV) {
		t.Fatal("float sub-format accepted")
	}
}

func TestParseRefuses(t *testing.T) {
	good := fmtChunk(1, 1, SpeechRate, 16)
	cases := map[string][]byte{
		"empty":         nil,
		"not riff":      []byte("RIFX\x00\x00\x00\x00WAVE"),
		"not wave":      []byte("RIFF\x00\x00\x00\x00AVI "),
		"no data":       chunked([2]string{"fmt ", good}),
		"data first":    chunked([2]string{"data", "\x00\x00"}, [2]string{"fmt ", good}),
		"8-bit":         chunked([2]string{"fmt ", fmtChunk(1, 1, SpeechRate, 8)}, [2]string{"data", "\x00\x00"}),
		"float":         chunked([2]string{"fmt ", fmtChunk(3, 1, SpeechRate, 16)}, [2]string{"data", "\x00\x00"}),
		"short fmt":     chunked([2]string{"fmt ", good[:12]}, [2]string{"data", "\x00\x00"}),
		"partial frame": chunked([2]string{"fmt ", fmtChunk(1, 2, SpeechRate, 16)}, [2]string{"data", "\x00\x00"}),
		"zero channels": chunked([2]string{"fmt ", fmtChunk(1, 0, SpeechRate, 16)}, [2]string{"data", ""}),
	}
	// A data chunk that claims more bytes than there are (a truncated upload).
	trunc := Encode(tone(SpeechRate, 1, 10*time.Millisecond, 0.1))
	cases["truncated"] = trunc[:len(trunc)-10]
	for name, b := range cases {
		if _, err := Parse(b); !errors.Is(err, ErrNotWAV) {
			t.Errorf("%s: %v", name, err)
		}
	}
}

func TestCheckSpeech(t *testing.T) {
	if CheckSpeech(tone(22050, 1, time.Second, 0.1)) == nil {
		t.Error("22.05 kHz accepted as speech")
	}
	if CheckSpeech(tone(SpeechRate, 2, time.Second, 0.1)) == nil {
		t.Error("stereo accepted as speech")
	}
}

func TestPadTo(t *testing.T) {
	a := tone(SpeechRate, 1, 300*time.Millisecond, 0.2)
	p := PadTo(a, time.Second)
	if p.Duration() != time.Second || p.Samples[100] != a.Samples[100] || p.Samples[len(p.Samples)-1] != 0 {
		t.Fatalf("padded to %v", p.Duration())
	}
	long := tone(SpeechRate, 1, 2*time.Second, 0.2)
	if PadTo(long, time.Second).Duration() != 2*time.Second {
		t.Fatal("long audio changed")
	}
}

func TestSilent(t *testing.T) {
	if !Silent(Audio{Rate: SpeechRate, Channels: 1, Samples: make([]int16, 1600)}, -40) {
		t.Error("zeros are not silent")
	}
	if !Silent(tone(SpeechRate, 1, time.Second, 0.005), -40) { // about −46 dBFS
		t.Error("a whisper of noise is speech")
	}
	if Silent(tone(SpeechRate, 1, time.Second, 0.1), -40) { // −20 dBFS
		t.Error("a voice is silence")
	}
	if !Silent(Audio{Rate: SpeechRate, Channels: 1}, -40) {
		t.Error("no samples are not silent")
	}
}

func TestSplit(t *testing.T) {
	// 70 s of tone with a quiet second at 25 s and at 50 s: three pieces, cut in those pauses, nothing lost.
	n := 70 * SpeechRate
	s := make([]int16, n)
	for i := range s {
		if (i >= 25*SpeechRate && i < 26*SpeechRate) || (i >= 50*SpeechRate && i < 51*SpeechRate) {
			continue
		}
		s[i] = int16(8000 * math.Sin(float64(i)/5))
	}
	pieces := Split(Audio{Rate: SpeechRate, Channels: 1, Samples: s}, PieceMax)
	var total int
	for i, p := range pieces {
		if p.Duration() > PieceMax {
			t.Fatalf("piece %d is %s", i, p.Duration())
		}
		total += len(p.Samples)
	}
	if len(pieces) != 3 || total != n {
		t.Fatalf("%d pieces, %d of %d samples", len(pieces), total, n)
	}
	if cut := pieces[0].Duration(); cut < 25*time.Second || cut > 26*time.Second {
		t.Fatalf("first cut at %s, not in the pause", cut)
	}
	// Up to the limit: one piece; stereo isn't cut.
	if p := Split(Audio{Rate: SpeechRate, Channels: 1, Samples: make([]int16, 30*SpeechRate)}, PieceMax); len(p) != 1 {
		t.Fatal(len(p))
	}
	if p := Split(Audio{Rate: SpeechRate, Channels: 2, Samples: make([]int16, 140*SpeechRate)}, PieceMax); len(p) != 1 {
		t.Fatal(len(p))
	}
}
