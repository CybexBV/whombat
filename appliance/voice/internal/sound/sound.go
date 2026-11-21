// Package sound tells whether the machine has a microphone and speakers, from the kernel's list of ALSA PCM devices
// (/proc/asound/pcm; no ALSA userland in the image, NX-179). The console's Chromium does the recording and playing;
// this only answers the voice health's `microphone` and `speaker`.
package sound

import (
	"bufio"
	"bytes"
	"os"
	"strconv"
	"strings"
)

// PCMFile is the kernel's PCM list.
const PCMFile = "/proc/asound/pcm"

// Devices is what the PCM list says.
type Devices struct {
	Capture  bool
	Playback bool
}

// Parse reads lines like
//
//	00-00: ALC1220 Analog : ALC1220 Analog : playback 1 : capture 1
//	01-03: HDMI 0 : HDMI 0 : playback 1
//
// (the kernel's snd_pcm_proc_read: id and name, then ` : playback N` and ` : capture N` for the streams it has). A
// device counts when it has at least one capture (or playback) substream. Only the trailing stream fields are read,
// so a device named “capture 1” is not a microphone.
func Parse(b []byte) Devices {
	var d Devices
	sc := bufio.NewScanner(bytes.NewReader(b))
	for sc.Scan() {
		fields := strings.Split(sc.Text(), " : ")
		for i := len(fields) - 1; i >= 2; i-- {
			kind, n, ok := strings.Cut(strings.TrimSpace(fields[i]), " ")
			count, err := strconv.Atoi(n)
			if !ok || err != nil || (kind != "capture" && kind != "playback") {
				break
			}
			if count > 0 && kind == "capture" {
				d.Capture = true
			}
			if count > 0 && kind == "playback" {
				d.Playback = true
			}
		}
	}
	return d
}

// Read reads path (PCMFile); a machine without sound has no such file (no devices).
func Read(path string) Devices {
	b, err := os.ReadFile(path)
	if err != nil {
		return Devices{}
	}
	return Parse(b)
}
