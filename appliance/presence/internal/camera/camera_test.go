package camera

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"
)

func cam(path, kind string, rear bool) Camera {
	return Camera{Path: path, Name: path, Kind: kind, Rear: rear, Usable: true}
}

func paths(cs []Camera) []string {
	out := make([]string, len(cs))
	for i, c := range cs {
		out[i] = c.Path
	}
	return out
}

func TestParseKeepsUsableCamerasInOrder(t *testing.T) {
	out := []byte(`{"path":"/dev/video0","name":"ASUS FHD webcam: ASUS IR camera","driver":"uvcvideo","formats":["GREY"],"kind":"infrared","rear":false,"usable":true,"format":"GREY","width":340,"height":340}
{"path":"/dev/video1","name":"metadata","driver":"uvcvideo","formats":[],"kind":"colour","rear":false,"usable":false}
not json
{"path":"/dev/video2","name":"OV13855","driver":"amd_isp","formats":["NV12"],"kind":"colour","rear":true,"usable":true,"format":"YUYV","width":640,"height":480}
{"path":"/dev/video4","name":"ASUS FHD webcam","driver":"uvcvideo","formats":["MJPG","YUYV"],"kind":"colour","rear":false,"usable":true,"format":"YUYV","width":320,"height":240}
{"path":"relative","usable":true}
`)
	got := Parse(out)
	if want := []string{"/dev/video4", "/dev/video0", "/dev/video2"}; !slices.Equal(paths(got), want) {
		t.Fatalf("order %v, want %v", paths(got), want)
	}
	if got[0].Format != "YUYV" || got[0].Width != 320 || !got[1].Infrared() {
		t.Fatalf("fields: %+v", got)
	}
}

// DK-32: a colour camera before an infrared one, a rear camera last; otherwise the probe's order.
func TestOrder(t *testing.T) {
	cs := []Camera{
		cam("/dev/video0", "infrared", true),
		cam("/dev/video1", "colour", true),
		cam("/dev/video2", "infrared", false),
		cam("/dev/video3", "colour", false),
		cam("/dev/video5", "colour", false),
	}
	want := []string{"/dev/video3", "/dev/video5", "/dev/video2", "/dev/video1", "/dev/video0"}
	if got := paths(Order(cs)); !slices.Equal(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestPick(t *testing.T) {
	first, ir, ok := Pick(Order([]Camera{cam("/dev/video2", "infrared", false), cam("/dev/video0", "colour", false)}))
	if !ok || first.Path != "/dev/video0" || ir == nil || ir.Path != "/dev/video2" {
		t.Fatalf("colour and infrared: %v %v %v", first, ir, ok)
	}
	// Only an infrared camera: it is the camera, with nothing to turn to.
	first, ir, ok = Pick([]Camera{cam("/dev/video2", "infrared", false)})
	if !ok || first.Path != "/dev/video2" || ir != nil {
		t.Fatalf("infrared only: %v %v %v", first, ir, ok)
	}
	if _, _, ok := Pick(nil); ok {
		t.Fatal("no camera picked one")
	}
}

func TestProberProbesOnlyWhenTheDevicesChange(t *testing.T) {
	sys := t.TempDir()
	runs := 0
	now := time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)
	var fail error
	p := &Prober{
		Sys: sys,
		Now: func() time.Time { return now },
		Run: func(context.Context) ([]byte, error) {
			runs++
			return []byte(`{"path":"/dev/video0","name":"Integrated Camera","kind":"colour","usable":true}` + "\n"), fail
		},
	}
	// No video device: no probe at all.
	if cs := p.Cameras(); len(cs) != 0 || runs != 0 {
		t.Fatalf("no devices: %v, %d probes", cs, runs)
	}
	add := func(name, label string) {
		if err := os.MkdirAll(filepath.Join(sys, name), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(sys, name, "name"), []byte(label+"\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	add("video0", "Integrated Camera")
	add("v4l-subdev0", "sensor")
	if cs := p.Cameras(); len(cs) != 1 || runs != 1 {
		t.Fatalf("one device: %v, %d probes", cs, runs)
	}
	if p.Cameras(); runs != 1 {
		t.Fatalf("probed again without a change: %d", runs)
	}
	add("video1", "Integrated Camera")
	if p.Cameras(); runs != 2 {
		t.Fatalf("a new device wasn't probed: %d", runs)
	}
	// A failed probe: no cameras, asked again after a minute even without a change.
	fail = errors.New("timeout")
	add("video2", "USB camera")
	if cs := p.Cameras(); len(cs) != 0 || runs != 3 {
		t.Fatalf("failed probe: %v, %d probes", cs, runs)
	}
	fail = nil
	if p.Cameras(); runs != 3 {
		t.Fatalf("retried at once: %d", runs)
	}
	now = now.Add(RetryFailed)
	if cs := p.Cameras(); len(cs) != 1 || runs != 4 {
		t.Fatalf("retry after a minute: %v, %d probes", cs, runs)
	}
}

func TestProberFrames(t *testing.T) {
	p := &Prober{Frames: "/pictures", Run: func(context.Context) ([]byte, error) { t.Fatal("probed"); return nil, nil }}
	cs := p.Cameras()
	if len(cs) != 1 || !cs[0].Frames || cs[0].Path != "/pictures" || cs[0].Infrared() {
		t.Fatalf("frames camera: %+v", cs)
	}
}
