package screen

import (
	"bytes"
	"image"
	"image/jpeg"
	"image/png"
	"io"
	"log/slog"
	"os"
	"strings"
	"testing"

	"rackoon/internal/proto"
)

// The steps Find My on a Mac's page uses (helper 1.1.0): an element's named
// action, quitting an app, places for addresses, a map picture, a look cut
// to a part of the screen, and how long the person at the Mac has been
// away. Every name and place here is made up or public.

// mapAnswers adds helper 1.1.0's answers to the fake helper's.
func mapAnswers(st *helperState, picture []byte) func(map[string]any) map[string]any {
	base := fakeHelperAnswers(st)
	return func(req map[string]any) map[string]any {
		switch req["op"] {
		case "status":
			a := base(req)
			a["version"], a["idle_s"] = "1.1.0", 42
			return a
		case "list":
			return map[string]any{"ok": true, "elements": []map[string]any{
				{"id": "w0.1", "role": "AXButton", "desc": "Pat Example · Nearby · Home · Now", "x": 1, "y": 1, "w": 1, "h": 1,
					"actions": []string{"AXPress", "Name:Open Details\nTarget:0x0\nSelector:(null)", "Name:Play\r\nTarget:0x0", "Name:\nTarget:0x0"}},
			}}
		case "action":
			if req["action"] == "Stop" {
				return map[string]any{"ok": false, "code": "not_found", "message": "“Pat Example” has no action called “Stop”.", "names": []string{"Play"}}
			}
			return map[string]any{"ok": true, "element": map[string]any{"id": "w0.1", "role": "AXButton", "title": "Pat Example", "x": 10, "y": 5, "w": 4, "h": 2}}
		case "quit":
			if req["app"] == "Slow" {
				return map[string]any{"ok": true, "message": "It is still closing."}
			}
			return map[string]any{"ok": true}
		case "geocode":
			qs := req["queries"].([]any)
			places := []any{}
			for _, q := range qs {
				switch q {
				case "Nowhere":
					places = append(places, nil)
				case "Short":
					// an answer that misses a place doesn't fit
				default:
					places = append(places, map[string]any{"lat": 52.3727, "lon": 4.8932, "accuracy_m": 100})
				}
			}
			return map[string]any{"ok": true, "places": places}
		case "map":
			points := []any{}
			for i := range req["pins"].([]any) {
				if i == 1 {
					points = append(points, nil)
				} else {
					points = append(points, map[string]any{"x": 300, "y": 200})
				}
			}
			cfg, _, _ := image.DecodeConfig(bytes.NewReader(picture))
			return map[string]any{"ok": true, "image": picture, "format": "jpeg", "w": cfg.Width, "h": cfg.Height,
				"points": points, "lat": 52.3727, "lon": 4.8932, "span_m": 600}
		}
		return base(req)
	}
}

func jpegOf(t *testing.T, w, h int) []byte {
	t.Helper()
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, image.NewRGBA(image.Rect(0, 0, w, h)), nil); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestUIActionAndQuit(t *testing.T) {
	s := newTestScreen(t, "127.0.0.1:1")
	st := &helperState{ax: true}
	h := newFakeHelper(t, s.uiRoot, os.Getuid(), mapAnswers(st, nil))

	r := run(t, s, proto.ScreenRequest{Op: proto.ScreenUIAction, App: "com.apple.findmy", Name: "Pat Example", Role: "button", Action: " Open Details "})
	if !r.OK || r.Element == nil || r.Element.Title != "Pat Example" {
		t.Fatalf("ui.action: %+v", r)
	}
	last := h.requests()[len(h.requests())-1]
	if last["op"] != "action" || last["action"] != "Open Details" || last["name"] != "Pat Example" || last["role"] != "AXButton" || last["app"] != "com.apple.findmy" {
		t.Fatalf("action request %v", last)
	}
	r = run(t, s, proto.ScreenRequest{Op: proto.ScreenUIAction, Name: "Pat Example", Action: "Stop"})
	if r.Code != proto.ScreenCodeNotFound || !strings.Contains(r.Message, "Stop") {
		t.Fatalf("an action it hasn't: %+v", r)
	}
	if r := run(t, s, proto.ScreenRequest{Op: proto.ScreenUIQuit, App: "Find My"}); !r.OK || r.Message != "" {
		t.Fatalf("ui.quit: %+v", r)
	}
	if r := run(t, s, proto.ScreenRequest{Op: proto.ScreenUIQuit, App: "Slow"}); !r.OK || r.Message != "It is still closing." {
		t.Fatalf("ui.quit still closing: %+v", r)
	}
	last = h.requests()[len(h.requests())-1]
	if last["op"] != "quit" || last["app"] != "Slow" {
		t.Fatalf("quit request %v", last)
	}

	// The list names an element's own actions as a person reads them.
	r = run(t, s, proto.ScreenRequest{Op: proto.ScreenUIList, App: "Find My"})
	if got := strings.Join(r.Elements[0].Actions, "|"); got != "AXPress|Open Details|Play" {
		t.Fatalf("actions %q", got)
	}

	// Locked: an action needs the screen; quitting doesn't. Without
	// Accessibility the same.
	st.locked = true
	if r := run(t, s, proto.ScreenRequest{Op: proto.ScreenUIAction, Name: "Pat Example", Action: "Play"}); r.Code != proto.ScreenCodeLocked {
		t.Fatalf("locked action: %+v", r)
	}
	if r := run(t, s, proto.ScreenRequest{Op: proto.ScreenUIQuit, App: "Find My"}); !r.OK {
		t.Fatalf("locked quit: %+v", r)
	}
	st.locked, st.ax = false, false
	if r := run(t, s, proto.ScreenRequest{Op: proto.ScreenUIAction, Name: "Pat Example", Action: "Play"}); r.Code != proto.ScreenCodeNoAccess {
		t.Fatalf("action without access: %+v", r)
	}
	if r := run(t, s, proto.ScreenRequest{Op: proto.ScreenUIQuit, App: "Find My"}); !r.OK {
		t.Fatalf("quit without access: %+v", r)
	}
	st.ax = true

	n := len(h.requests())
	for _, bad := range []proto.ScreenRequest{
		{Op: proto.ScreenUIAction, Name: "Pat Example"},
		{Op: proto.ScreenUIAction, Action: "Play"},
		{Op: proto.ScreenUIAction, Name: "Pat Example", Action: strings.Repeat("a", 201)},
		{Op: proto.ScreenUIQuit},
		{Op: proto.ScreenUIQuit, App: "  "},
	} {
		if r := run(t, s, bad); r.Code != "invalid_request" {
			t.Fatalf("%+v: %+v", bad, r)
		}
	}
	if len(h.requests()) != n {
		t.Fatal("refused requests reached the helper")
	}
}

// A helper that doesn't know a step (before 1.1.0) says so in words a
// person reads: it takes the new version by itself.
func TestOlderHelper(t *testing.T) {
	s := newTestScreen(t, "127.0.0.1:1")
	newFakeHelper(t, s.uiRoot, os.Getuid(), fakeHelperAnswers(&helperState{ax: true}))
	for _, req := range []proto.ScreenRequest{
		{Op: proto.ScreenUIAction, Name: "Pat Example", Action: "Play"},
		{Op: proto.ScreenUIQuit, App: "Find My"},
		{Op: proto.ScreenMapGeocode, Queries: []string{"Dam, Amsterdam"}},
		{Op: proto.ScreenMapSnapshot, Pins: []proto.MapPin{{Lat: 52.37, Lon: 4.89}}},
	} {
		r := run(t, s, req)
		if r.Code != proto.ScreenCodeUnsupported || r.Message != helperOlderMsg {
			t.Fatalf("%s: %+v", req.Op, r)
		}
	}
}

func TestMapGeocode(t *testing.T) {
	s := newTestScreen(t, "127.0.0.1:1")
	// Locked and without Accessibility: places don't need the screen.
	st := &helperState{locked: true}
	h := newFakeHelper(t, s.uiRoot, os.Getuid(), mapAnswers(st, nil))
	r := run(t, s, proto.ScreenRequest{Op: proto.ScreenMapGeocode, Queries: []string{" Dam, Amsterdam ", "Nowhere"}})
	if !r.OK || len(r.Places) != 2 || r.Places[0] == nil || r.Places[0].Lat != 52.3727 || r.Places[0].AccuracyM != 100 || r.Places[1] != nil {
		t.Fatalf("map.geocode: %+v", r)
	}
	last := h.requests()[len(h.requests())-1]
	if last["op"] != "geocode" || len(last["queries"].([]any)) != 2 || last["queries"].([]any)[0] != "Dam, Amsterdam" || last["app"] != nil {
		t.Fatalf("geocode request %v", last)
	}
	if r := run(t, s, proto.ScreenRequest{Op: proto.ScreenMapGeocode, Queries: []string{"Dam, Amsterdam", "Short"}}); r.Code != "failed" {
		t.Fatalf("an answer missing a place: %+v", r)
	}
	n := len(h.requests())
	for _, bad := range [][]string{nil, {}, {"a", "b", "c", "d", "e", "f", "g", "h", "i"}, {"Dam", " "}, {strings.Repeat("x", 301)}, {"a\x00b"}} {
		if r := run(t, s, proto.ScreenRequest{Op: proto.ScreenMapGeocode, Queries: bad}); r.Code != "invalid_request" {
			t.Fatalf("%q: %+v", bad, r)
		}
	}
	if len(h.requests()) != n {
		t.Fatal("refused requests reached the helper")
	}
}

func TestMapSnapshot(t *testing.T) {
	s := newTestScreen(t, "127.0.0.1:1")
	st := &helperState{locked: true}
	picture := jpegOf(t, 120, 80)
	h := newFakeHelper(t, s.uiRoot, os.Getuid(), mapAnswers(st, picture))
	lat, lon := 52.37, 4.89
	r := run(t, s, proto.ScreenRequest{Op: proto.ScreenMapSnapshot, W: 64, H: 1600, Scale: 1, Dark: true,
		Pins: []proto.MapPin{{Lat: 52.3727, Lon: 4.8932}, {Lat: -33.86, Lon: 151.21}}})
	if !r.OK || r.Format != "jpeg" || r.W != 120 || r.H != 80 || !bytes.Equal(r.Image, picture) {
		t.Fatalf("map.snapshot: %+v", r)
	}
	if len(r.Points) != 2 || r.Points[0] == nil || r.Points[0].X != 300 || r.Points[1] != nil || r.Lat == nil || *r.Lat != 52.3727 || r.SpanM != 600 {
		t.Fatalf("points and region: %+v", r)
	}
	if r.ScreenW != 0 || r.ScreenH != 0 {
		t.Fatalf("a map answer carries the screen's size: %+v", r)
	}
	last := h.requests()[len(h.requests())-1]
	if last["op"] != "map" || last["w"] != float64(64) || last["h"] != float64(1600) || last["scale"] != float64(1) || last["dark"] != true ||
		last["format"] != "jpeg" || len(last["pins"].([]any)) != 2 || last["lat"] != nil {
		t.Fatalf("map request %v", last)
	}
	// The region asked for; the size and scale left to the helper.
	run(t, s, proto.ScreenRequest{Op: proto.ScreenMapSnapshot, Lat: &lat, Lon: &lon, SpanM: 1500, Format: "png", Pins: []proto.MapPin{{Lat: 1, Lon: 2}}})
	last = h.requests()[len(h.requests())-1]
	if last["lat"] != 52.37 || last["lon"] != 4.89 || last["span_m"] != float64(1500) || last["w"] != nil || last["scale"] != nil || last["format"] != "png" {
		t.Fatalf("map request with a region %v", last)
	}

	n := len(h.requests())
	zero := 0.0
	far := 91.0
	pins21 := make([]proto.MapPin, 21)
	for _, bad := range []proto.ScreenRequest{
		{Op: proto.ScreenMapSnapshot},
		{Op: proto.ScreenMapSnapshot, W: 63, Pins: []proto.MapPin{{}}},
		{Op: proto.ScreenMapSnapshot, H: 1601, Pins: []proto.MapPin{{}}},
		{Op: proto.ScreenMapSnapshot, Scale: 3, Pins: []proto.MapPin{{}}},
		{Op: proto.ScreenMapSnapshot, Format: "gif", Pins: []proto.MapPin{{}}},
		{Op: proto.ScreenMapSnapshot, Pins: []proto.MapPin{{Lat: 90.5}}},
		{Op: proto.ScreenMapSnapshot, Pins: []proto.MapPin{{Lon: -180.5}}},
		{Op: proto.ScreenMapSnapshot, Pins: pins21},
		{Op: proto.ScreenMapSnapshot, Lat: &zero, Lon: &zero},
		{Op: proto.ScreenMapSnapshot, Lat: &zero, SpanM: 1000},
		{Op: proto.ScreenMapSnapshot, Lat: &far, Lon: &zero, SpanM: 1000},
		{Op: proto.ScreenMapSnapshot, Lat: &zero, Lon: &zero, SpanM: 49},
		{Op: proto.ScreenMapSnapshot, Lat: &zero, Lon: &zero, SpanM: 20_000_001},
	} {
		if r := run(t, s, bad); r.Code != "invalid_request" {
			t.Fatalf("%+v: %+v", bad, r)
		}
	}
	if len(h.requests()) != n {
		t.Fatal("refused requests reached the helper")
	}
}

// A map answer that doesn't fit the request is refused, never passed on.
func TestMapSnapshotChecksTheAnswer(t *testing.T) {
	pins := []proto.MapPin{{Lat: 1, Lon: 2}}
	picture := jpegOf(t, 120, 80)
	lat, lon := 1.0, 2.0
	good := func() *helperAnswer {
		return &helperAnswer{OK: true, Image: picture, Format: "jpeg", W: 120, H: 80, Points: []*helperPoint{{X: 3, Y: 4}},
			Lat: &lat, Lon: &lon, SpanM: 600}
	}
	var resp proto.ScreenResponse
	if err := mapPicture(good(), 1, &resp); err != nil || resp.W != 120 || len(resp.Points) != 1 {
		t.Fatalf("a good answer: %v %+v", err, resp)
	}
	for name, spoil := range map[string]func(a *helperAnswer){
		"another size":    func(a *helperAnswer) { a.W = 121 },
		"another format":  func(a *helperAnswer) { a.Format = "png" },
		"not a picture":   func(a *helperAnswer) { a.Image = []byte("not a picture") },
		"a point missing": func(a *helperAnswer) { a.Points = nil },
		"no region":       func(a *helperAnswer) { a.Lat = nil },
		"no span":         func(a *helperAnswer) { a.SpanM = 0 },
	} {
		a := good()
		spoil(a)
		if err := mapPicture(a, len(pins), &proto.ScreenResponse{}); err == nil {
			t.Errorf("%s was passed on", name)
		}
	}
	old := maxImageBytes
	maxImageBytes = 10
	defer func() { maxImageBytes = old }()
	if err := mapPicture(good(), 1, &proto.ScreenResponse{}); err == nil || !strings.Contains(err.Error(), "too big") {
		t.Fatalf("a picture too big for the hub: %v", err)
	}
}

func TestLookCrop(t *testing.T) {
	f := newFakeSharing(t, "alex", "pw")
	s := newTestScreen(t, f.addr())
	setAccount(t, s, "alex", "pw") // 64×48; the pixel at (x, y) is red x, green y
	r := run(t, s, proto.ScreenRequest{Op: proto.ScreenLook, Crop: &proto.ScreenCrop{X: 10, Y: 5, W: 20, H: 8}})
	if !r.OK || r.W != 20 || r.H != 8 || r.ScreenW != 64 || r.ScreenH != 48 {
		t.Fatalf("cropped look: %+v", r)
	}
	img, err := png.Decode(bytes.NewReader(r.Image))
	if err != nil {
		t.Fatal(err)
	}
	if r8, g8, _, _ := img.At(0, 0).RGBA(); r8>>8 != 10 || g8>>8 != 5 {
		t.Fatalf("the crop's corner is (%d, %d)", r8>>8, g8>>8)
	}
	// Cut first, then scaled; clamped to the screen.
	r = run(t, s, proto.ScreenRequest{Op: proto.ScreenLook, MaxW: 10, Crop: &proto.ScreenCrop{X: 44, Y: 40, W: 100, H: 100}})
	if !r.OK || r.W != 10 || r.H != 4 {
		t.Fatalf("cropped, clamped and scaled: %+v", r)
	}
	for _, c := range []proto.ScreenCrop{{X: 64, Y: 0, W: 5, H: 5}, {X: -1, Y: 0, W: 5, H: 5}, {X: 0, Y: 0, W: 0, H: 5}} {
		if r := run(t, s, proto.ScreenRequest{Op: proto.ScreenLook, Crop: &c}); r.Code != "invalid_request" {
			t.Fatalf("crop %+v: %+v", c, r)
		}
	}
}

// The status step says how long the Mac's own keyboard and mouse have been
// idle; the report never carries it (it would change every second).
func TestIdleSeconds(t *testing.T) {
	s := newTestScreen(t, "127.0.0.1:1")
	newFakeHelper(t, s.uiRoot, os.Getuid(), mapAnswers(&helperState{ax: true}, nil))
	r := run(t, s, proto.ScreenRequest{Op: proto.ScreenStatus})
	if r.Helper == nil || r.Helper.IdleS == nil || *r.Helper.IdleS != 42 {
		t.Fatalf("status: %+v", r.Helper)
	}
	if _, h := s.Status(t.Context()); h.IdleS != nil {
		t.Fatalf("the report carries idle_s: %+v", h)
	}
	// An older helper says nothing: unknown.
	s2 := newTestScreen(t, "127.0.0.1:1")
	newFakeHelper(t, s2.uiRoot, os.Getuid(), fakeHelperAnswers(&helperState{ax: true}))
	if r := run(t, s2, proto.ScreenRequest{Op: proto.ScreenStatus}); r.Helper == nil || r.Helper.IdleS != nil {
		t.Fatalf("an older helper's status: %+v", r.Helper)
	}
}

func TestActionNames(t *testing.T) {
	got := actionNames([]string{"AXPress", "Name:Directions · 0 min\nTarget:0x0\nSelector:(null)", "Name:Contact", "Name:\n", ""})
	if strings.Join(got, "|") != "AXPress|Directions · 0 min|Contact" {
		t.Fatalf("%q", got)
	}
}

func TestCLIMapHelp(t *testing.T) {
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	for _, args := range [][]string{{"map"}, {"map", "--help"}, {"map", "snapshot", "--help"}} {
		var out bytes.Buffer
		if err := CLI(args, t.TempDir(), &out, log); err != nil {
			t.Fatalf("%q: %v", args, err)
		}
		if !strings.Contains(out.String(), "map geocode") || !strings.Contains(out.String(), "--crop") {
			t.Fatalf("%q printed %q", args, out.String())
		}
	}
	for _, bad := range [][]string{{"map", "snapshot", "--pin", "52.3"}, {"look", "--crop", "1,2,3"}} {
		var out bytes.Buffer
		if err := CLI(bad, t.TempDir(), &out, log); err == nil {
			t.Fatalf("%q accepted", bad)
		}
	}
}
