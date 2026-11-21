// Package camera knows the box's cameras (Whombat DK-32; NX-284): what `presence-watch --probe` says about each
// capture device, the order they are tried in, and when to ask again.
//
// The probe opens each /dev/video* node only to ask what it is (VIDIOC_QUERYCAP and the formats); it never streams,
// so no camera's light comes on. It runs when the service first needs to know and again only when the devices in
// /sys/class/video4linux change (a camera plugged in or out), or a minute after a probe that failed.
package camera

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"
)

// Camera is one line of `presence-watch --probe`.
type Camera struct {
	Path    string   `json:"path"`
	Name    string   `json:"name"`
	Driver  string   `json:"driver"`
	Formats []string `json:"formats"`
	// Kind is presence-watch's guess: "colour", or "infrared" (only grey formats, or IR in its name).
	Kind   string `json:"kind"`
	Rear   bool   `json:"rear"`
	Usable bool   `json:"usable"`
	// The format and size watching would use.
	Format string `json:"format"`
	Width  int    `json:"width"`
	Height int    `json:"height"`
	// Frames: Path is a folder of pictures played as a camera (`--frames`, for checks), not a device.
	Frames bool `json:"-"`
}

// Infrared says whether presence-watch took it for an infrared camera.
func (c Camera) Infrared() bool { return c.Kind == "infrared" }

// String names it for the journal: the device, its name, and what watching reads.
func (c Camera) String() string {
	if c.Frames {
		return "the pictures in " + c.Path
	}
	return c.Path + " (" + c.Name + ")"
}

// Parse reads the probe's lines and keeps the cameras it can stream from, in the order DK-32 tries them.
func Parse(out []byte) []Camera {
	var cams []Camera
	sc := bufio.NewScanner(bytes.NewReader(out))
	sc.Buffer(make([]byte, 4096), 64<<10)
	for sc.Scan() {
		var c Camera
		if json.Unmarshal(sc.Bytes(), &c) == nil && c.Usable && strings.HasPrefix(c.Path, "/") {
			cams = append(cams, c)
		}
	}
	return Order(cams)
}

// Order sorts cameras as DK-32 tries them: a colour camera before an infrared one, a rear camera last (front colour,
// front infrared, rear colour, rear infrared), otherwise as the probe listed them (by device number).
func Order(cams []Camera) []Camera {
	rank := func(c Camera) int {
		r := 0
		if c.Rear {
			r += 2
		}
		if c.Infrared() {
			r++
		}
		return r
	}
	out := slices.Clone(cams)
	sort.SliceStable(out, func(i, j int) bool { return rank(out[i]) < rank(out[j]) })
	return out
}

// Pick is the camera to start with (the first in Order) and the infrared one to turn to when its picture stays too
// dark (DK-32): the first infrared camera after it, only when the first is a colour one.
func Pick(cams []Camera) (first Camera, infrared *Camera, ok bool) {
	if len(cams) == 0 {
		return Camera{}, nil, false
	}
	first = cams[0]
	if !first.Infrared() {
		for i := range cams[1:] {
			if c := cams[1+i]; c.Infrared() {
				infrared = &c
				break
			}
		}
	}
	return first, infrared, true
}

// Prober caches the probe's answer until the devices change.
type Prober struct {
	// Sys is /sys/class/video4linux.
	Sys string
	// Run runs `presence-watch --probe` and returns its output.
	Run func(ctx context.Context) ([]byte, error)
	// Timeout bounds one probe (5 s).
	Timeout time.Duration
	// Frames, when set, is a folder of pictures that is the only camera (checks and tests).
	Frames string
	Log    func(format string, args ...any)
	Now    func() time.Time

	mu       sync.Mutex
	known    bool
	listing  string
	failedAt time.Time
	cams     []Camera
}

// RetryFailed is how long a failed probe's empty answer stands.
const RetryFailed = time.Minute

// Cameras lists the usable cameras in DK-32's order.
func (p *Prober) Cameras() []Camera {
	if p.Frames != "" {
		return []Camera{{Path: p.Frames, Name: "pictures", Kind: "colour", Usable: true, Frames: true}}
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	listing := Listing(p.Sys)
	now := p.now()
	if p.known && listing == p.listing && (p.failedAt.IsZero() || now.Sub(p.failedAt) < RetryFailed) {
		return p.cams
	}
	p.known, p.listing, p.failedAt, p.cams = true, listing, time.Time{}, nil
	if listing == "" {
		return nil // no video device at all: nothing to open
	}
	timeout := p.Timeout
	if timeout <= 0 {
		timeout = 5 * time.Second
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	out, err := p.Run(ctx)
	if err != nil {
		p.failedAt = now
		p.logf("the camera probe failed: %v", err)
		return nil
	}
	p.cams = Parse(out)
	desc := make([]string, len(p.cams))
	for i, c := range p.cams {
		desc[i] = c.String() + ", " + c.Kind
		if c.Rear {
			desc[i] += ", rear"
		}
	}
	p.logf("cameras it can use: %d of %d video devices (%s)", len(p.cams), strings.Count(listing, "\n")+1, strings.Join(desc, "; "))
	return p.cams
}

// Listing names the video devices in sys with their names, one per line, sorted: it changes when one comes or goes.
// Reading it opens no device.
func Listing(sys string) string {
	entries, err := os.ReadDir(sys)
	if err != nil {
		return ""
	}
	var lines []string
	for _, e := range entries {
		if !strings.HasPrefix(e.Name(), "video") {
			continue
		}
		name, _ := os.ReadFile(filepath.Join(sys, e.Name(), "name"))
		lines = append(lines, e.Name()+"="+strings.TrimSpace(string(name)))
	}
	sort.Strings(lines)
	return strings.Join(lines, "\n")
}

func (p *Prober) now() time.Time {
	if p.Now != nil {
		return p.Now()
	}
	return time.Now()
}

func (p *Prober) logf(format string, args ...any) {
	if p.Log != nil {
		p.Log(format, args...)
	}
}
