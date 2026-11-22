package hub

import (
	"bytes"
	"encoding/base64"
	"image"
	"image/jpeg"
	"net/http"
	"strings"
	"testing"
	"time"

	"rackoon/internal/proto"
)

// The screen steps of Find My on a Mac's page: an element's named action,
// quitting an app, places for addresses, a map picture, a cropped look and
// the helper's idle seconds. Every name and place is made up or public.
func TestScreenFindMySteps(t *testing.T) {
	e := headlessEnv(t, nil)
	svc := e.service("ag_1|Whombat")
	fa := e.enroll(svc, "basalt", "Lab")
	fa.policy = proto.Policy{Console: true, Diagnose: true, HostShell: true}
	if _, err := fa.dial(proto.Hello{}); err != nil {
		t.Fatal(err)
	}
	svc.json(http.MethodPatch, "/api/v1/servers/basalt", map[string]any{"remote_control": map[string]bool{"host_shell": true}}, 200, nil)
	fa.send(proto.MsgReport, macReport(fa, "basalt", true, "alice"))
	waitFor(t, "a Mac with host shell", 3*time.Second, func() bool {
		st, _ := e.h.snapshotOne("basalt")
		return isMac(st) && st.Report.Policy.HostShell
	})
	path := "/api/v1/servers/basalt/screen"

	var picture bytes.Buffer
	jpeg.Encode(&picture, image.NewRGBA(image.Rect(0, 0, 120, 80)), nil)
	idle := 42
	lat, lon := 52.3727, 4.8932
	fa.mu.Lock()
	fa.screenAnswer = func(req proto.ScreenRequest) proto.ScreenResponse {
		switch req.Op {
		case proto.ScreenStatus:
			r := fakeScreen(req)
			r.Helper.IdleS = &idle
			return r
		case proto.ScreenUIAction:
			return proto.ScreenResponse{OK: true, Element: &proto.UIElement{ID: "w0.1", Role: "AXButton", Title: "Pat Example", Actions: []string{"Open Details", "Play"}}}
		case proto.ScreenUIQuit:
			return proto.ScreenResponse{OK: true, Message: "It is still closing."}
		case proto.ScreenMapGeocode:
			return proto.ScreenResponse{OK: true, Places: []*proto.MapPlace{{Lat: lat, Lon: lon, AccuracyM: 99.6}, nil}}
		case proto.ScreenMapSnapshot:
			return proto.ScreenResponse{OK: true, Image: picture.Bytes(), Format: "jpeg", W: 120, H: 80,
				Points: []*proto.MapPoint{{X: 300, Y: 200.5}, nil}, Lat: &lat, Lon: &lon, SpanM: 1838.4, ScreenW: 1920, ScreenH: 1080}
		}
		return fakeScreen(req)
	}
	fa.mu.Unlock()
	lastReq := func() proto.ScreenRequest {
		fa.mu.Lock()
		defer fa.mu.Unlock()
		return fa.screens[len(fa.screens)-1]
	}

	// An owner's steps, as a look is.
	operator := map[string]string{HeaderRole: "operator"}
	for _, body := range []map[string]any{
		{"op": "ui.action", "name": "Pat Example", "action": "Open Details"},
		{"op": "ui.quit", "app": "Find My"},
		{"op": "map.geocode", "queries": []string{"Dam, Amsterdam"}},
		{"op": "map.snapshot", "pins": []map[string]float64{{"lat": lat, "lon": lon}}},
	} {
		if code, b, _ := svc.req(http.MethodPost, path, body, operator); code != 403 || !strings.Contains(string(b), "insufficient_role") {
			t.Fatalf("operator %v: %d %s", body["op"], code, b)
		}
	}

	var out map[string]any
	svc.json(http.MethodPost, path, map[string]any{"op": "ui.action", "app": "com.apple.findmy", "name": "Pat Example", "role": "button", "action": "Open Details"}, 200, &out)
	if out["ok"] != true || out["element"].(map[string]any)["title"] != "Pat Example" || out["audit_id"] == nil {
		t.Fatalf("ui.action %v", out)
	}
	if got := lastReq(); got.Op != "ui.action" || got.Action != "Open Details" || got.Name != "Pat Example" || got.Role != "button" {
		t.Fatalf("agent got %+v", got)
	}
	if recs := e.audit("screen.ui.action"); len(recs) != 1 || recs[0].Details["action"] != "Open Details" || recs[0].Details["name"] != "Pat Example" ||
		recs[0].Details["app"] != "com.apple.findmy" {
		t.Fatalf("ui.action audit %+v", recs)
	}
	svc.json(http.MethodPost, path, map[string]any{"op": "ui.quit", "app": "com.apple.findmy"}, 200, &out)
	if out["ok"] != true || out["message"] != "It is still closing." {
		t.Fatalf("ui.quit %v", out)
	}
	if recs := e.audit("screen.ui.quit"); len(recs) != 1 || recs[0].Details["app"] != "com.apple.findmy" {
		t.Fatalf("ui.quit audit %+v", recs)
	}

	svc.json(http.MethodPost, path, map[string]any{"op": "map.geocode", "queries": []string{"Dam, Amsterdam", "Nowhere"}}, 200, &out)
	places := out["places"].([]any)
	first := places[0].(map[string]any)
	if out["ok"] != true || len(places) != 2 || first["lat"] != lat || first["accuracy_m"] != float64(100) || places[1] != nil {
		t.Fatalf("map.geocode %v", out)
	}
	if got := lastReq(); len(got.Queries) != 2 || got.Queries[0] != "Dam, Amsterdam" {
		t.Fatalf("agent got %+v", got)
	}

	svc.json(http.MethodPost, path, map[string]any{"op": "map.snapshot", "w": 600, "h": 400, "scale": 2, "dark": true, "format": "jpeg",
		"pins": []map[string]float64{{"lat": lat, "lon": lon}, {"lat": -33.86, "lon": 151.21}}}, 200, &out)
	img, err := base64.StdEncoding.DecodeString(out["image_b64"].(string))
	if err != nil || !bytes.Equal(img, picture.Bytes()) || out["format"] != "jpeg" || out["w"] != float64(120) || out["h"] != float64(80) {
		t.Fatalf("map.snapshot picture %v", out["format"])
	}
	points := out["points"].([]any)
	if len(points) != 2 || points[0].(map[string]any)["y"] != 200.5 || points[1] != nil || out["lat"] != lat || out["lon"] != lon || out["span_m"] != float64(1838) {
		t.Fatalf("map.snapshot %v %v %v %v", points, out["lat"], out["lon"], out["span_m"])
	}
	if got := lastReq(); got.W != 600 || got.H != 400 || got.Scale != 2 || !got.Dark || len(got.Pins) != 2 || got.Pins[1].Lon != 151.21 || got.Lat != nil {
		t.Fatalf("agent got %+v", got)
	}
	svc.json(http.MethodPost, path, map[string]any{"op": "map.snapshot", "lat": 48.8584, "lon": 2.2945, "span_m": 1500}, 200, &out)
	if got := lastReq(); got.Lat == nil || *got.Lat != 48.8584 || *got.Lon != 2.2945 || got.SpanM != 1500 {
		t.Fatalf("agent got %+v", got)
	}

	// Never a place in the audit log: the op alone.
	for _, op := range []string{"screen.map.geocode", "screen.map.snapshot"} {
		recs := e.audit(op)
		if len(recs) == 0 {
			t.Fatalf("%s isn't audited", op)
		}
		for _, r := range recs {
			if len(r.Details) != 1 || r.Details["op"] == "" {
				t.Fatalf("%s keeps more than its op: %+v", op, r.Details)
			}
		}
	}
	for _, r := range e.audit("screen.") {
		for _, v := range r.Details {
			if strings.Contains(v, "Amsterdam") || strings.Contains(v, "52.37") || strings.Contains(v, "151.21") {
				t.Fatalf("the audit log keeps a place: %+v", r)
			}
		}
	}

	// A look of a part of the screen.
	svc.json(http.MethodPost, path, map[string]any{"op": "look", "format": "jpeg", "max_w": 1280, "crop": map[string]int{"x": 10, "y": 20, "w": 300, "h": 200}}, 200, &out)
	if got := lastReq(); got.Crop == nil || *got.Crop != (proto.ScreenCrop{X: 10, Y: 20, W: 300, H: 200}) {
		t.Fatalf("agent got %+v", got)
	}

	// The helper's idle seconds come with the status.
	svc.json(http.MethodPost, path, map[string]any{"op": "status"}, 200, &out)
	if out["helper"].(map[string]any)["idle_s"] != float64(42) {
		t.Fatalf("status %v", out["helper"])
	}

	// A helper older than the step: the agent's words.
	fa.mu.Lock()
	fa.screenAnswer = func(proto.ScreenRequest) proto.ScreenResponse {
		return proto.ScreenResponse{Code: proto.ScreenCodeUnsupported, Message: "Whombat Helper on this Mac is older than this step; it updates itself."}
	}
	fa.mu.Unlock()
	if code, b, _ := svc.req(http.MethodPost, path, map[string]any{"op": "ui.quit", "app": "Find My"}, nil); code != 501 || !strings.Contains(string(b), "older than this step") {
		t.Fatalf("an older helper: %d %s", code, b)
	}
	fa.mu.Lock()
	fa.screenAnswer = nil
	fa.mu.Unlock()

	nine := make([]string, 9)
	for i := range nine {
		nine[i] = "Dam"
	}
	pins := make([]map[string]float64, 21)
	for i := range pins {
		pins[i] = map[string]float64{"lat": 1, "lon": 1}
	}
	for _, bad := range []map[string]any{
		{"op": "ui.action", "name": "Pat Example", "action": strings.Repeat("a", 201)},
		{"op": "map.geocode", "queries": nine},
		{"op": "map.geocode", "queries": []string{strings.Repeat("x", 301)}},
		{"op": "map.snapshot", "pins": pins},
		{"op": "map.snapshot", "pins": []map[string]float64{{"lat": 91, "lon": 1}}},
		{"op": "map.snapshot", "pins": []map[string]float64{{"lat": 1, "lon": 181}}},
		{"op": "map.snapshot", "lat": -91, "lon": 1, "span_m": 1000},
		{"op": "map.snapshot", "lat": 1, "lon": 1, "span_m": 49},
		{"op": "map.snapshot", "lat": 1, "lon": 1, "span_m": 20000001},
		{"op": "map.snapshot", "w": 63, "pins": []map[string]float64{{"lat": 1, "lon": 1}}},
		{"op": "map.snapshot", "h": 1601, "pins": []map[string]float64{{"lat": 1, "lon": 1}}},
		{"op": "map.snapshot", "scale": 3, "pins": []map[string]float64{{"lat": 1, "lon": 1}}},
		{"op": "look", "crop": map[string]int{"x": 0, "y": 0, "w": 0, "h": 10}},
		{"op": "look", "crop": map[string]int{"x": -1, "y": 0, "w": 10, "h": 10}},
	} {
		if code, _, _ := svc.req(http.MethodPost, path, bad, nil); code != 400 {
			t.Errorf("%v: %d", bad, code)
		}
	}
}
