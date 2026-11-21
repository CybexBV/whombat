package sound

import (
	"os"
	"path/filepath"
	"testing"
)

func TestParse(t *testing.T) {
	cases := []struct {
		name string
		pcm  string
		want Devices
	}{
		{"laptop", "00-00: ALC294 Analog : ALC294 Analog : playback 1 : capture 1\n" +
			"00-03: HDMI 0 : HDMI 0 : playback 1\n", Devices{Capture: true, Playback: true}},
		// The Z13's digital microphone is on the AMD audio coprocessor, a card of its own.
		{"separate mic card", "00-03: HDMI 0 : HDMI 0 : playback 1\n" +
			"01-00: acp-pdm-mic-dai-codec dmic-hifi-0 :  : capture 1\n", Devices{Capture: true, Playback: true}},
		{"hdmi only", "00-03: HDMI 0 : HDMI 0 : playback 1\n00-07: HDMI 1 : HDMI 1 : playback 1\n", Devices{Playback: true}},
		{"usb mic", "02-00: USB Audio : USB Audio : capture 1\n", Devices{Capture: true}},
		{"zero substreams", "00-00: X : X : playback 0 : capture 0\n", Devices{}},
		{"vm", "", Devices{}},
		{"a name that says capture", "00-00: capture 1 : capture 1 : playback 1\n", Devices{Playback: true}},
	}
	for _, c := range cases {
		if got := Parse([]byte(c.pcm)); got != c.want {
			t.Errorf("%s: %+v, want %+v", c.name, got, c.want)
		}
	}
}

func TestReadMissing(t *testing.T) {
	if (Read(filepath.Join(t.TempDir(), "pcm")) != Devices{}) {
		t.Fatal("a missing list has devices")
	}
	p := filepath.Join(t.TempDir(), "pcm")
	if err := os.WriteFile(p, []byte("00-00: A : A : capture 2\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if !Read(p).Capture {
		t.Fatal("capture not read")
	}
}
