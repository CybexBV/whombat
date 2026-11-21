package desk_test

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"strings"
	"testing"

	"github.com/CybexBV/whombat/appliance/console/internal/desk"
	"github.com/CybexBV/whombat/appliance/console/internal/desk/desktest"
)

// withGrid is the paired state with the screen's grid and the monitors' as the runtime sends them.
func withGrid(grid, outputs string) string {
	extra := `,"grid":` + grid
	if outputs != "" {
		extra += `,"outputs":` + outputs
	}
	return strings.Replace(desktest.Paired, `"tiles":[{"icon":"temperature","value":"21.5 °C","label":"Living room"}]}`,
		`"tiles":[{"icon":"temperature","value":"21.5 °C","label":"Living room"}]`+extra+`}`, 1)
}

const grid = `{"screen":"box","popups":"all","attention":{"items":[],"more":0},
 "layout":{"pages":[{"id":"p_first","name":"Overview","last":"8x5","layouts":{"8x5":[
  {"id":"w_clock","type":"clock","opts":{},"x":0,"y":0,"w":4,"h":2},
  {"id":"w_plex","type":"panel","ref":"connection:con_P1","opts":{"panel":"now"},"x":4,"y":0,"w":4,"h":3}]}}],
  "turn":"touch","size":"normal"},
 "views":[{"kind":"text","id":"w_plex","title":"Now playing","name":"Plex","body":"Two\nlines\u0007 and‮ more",
  "future":{"x":1.25e3,"y":[0.1,null,true]}}]}`

// The grid and the monitors' grids pass through as the runtime sends them, their strings plain text (the page reads
// them as core's DeskGrid); a monitor without a grid goes, and so does a grid that isn't one by the contract.
func TestGridPassesThrough(t *testing.T) {
	ctx := context.Background()
	f := desktest.Start(t)
	f.Set(desk.PathState, desktest.Answer{Body: withGrid(grid,
		`[{"key":"hdmi-a-1","name":"DELL U2720Q","grid":`+strings.Replace(grid, `"box"`, `"out_hdmi-a-1"`, 1)+`}]`)})
	c, _ := newClient(t, f)
	st := c.State(ctx)
	if st == nil {
		t.Fatal("no state")
	}
	var g map[string]any
	if err := json.Unmarshal(st.Glance.Grid, &g); err != nil {
		t.Fatal(err)
	}
	view := g["views"].([]any)[0].(map[string]any)
	if g["screen"] != "box" || view["body"] != "Two lines and more" || view["future"].(map[string]any)["x"] != 1250.0 {
		t.Fatalf("%v", g)
	}
	widgets := g["layout"].(map[string]any)["pages"].([]any)[0].(map[string]any)["layouts"].(map[string]any)["8x5"].([]any)
	if len(widgets) != 2 || widgets[1].(map[string]any)["opts"].(map[string]any)["panel"] != "now" {
		t.Fatalf("%v", widgets)
	}
	if len(st.Glance.Outputs) != 1 || st.Glance.Outputs[0].Key != "hdmi-a-1" || *st.Glance.Outputs[0].Name != "DELL U2720Q" ||
		!strings.Contains(string(st.Glance.Outputs[0].Grid), `"out_hdmi-a-1"`) {
		t.Fatalf("%+v", st.Glance.Outputs)
	}
	// What the page gets is the same JSON, never longer (a picture's ref, `<` and the numbers as they came).
	out, _ := json.Marshal(st)
	if !strings.Contains(string(out), `"grid":{"attention":`) || strings.Contains(string(out), `<`) {
		t.Fatalf("%s", out)
	}

	// Not a grid by the contract's wire shape, or more monitors than a page reports: no state, as any member the
	// schema refuses.
	for _, bad := range []string{
		withGrid(`[1,2]`, ""),
		withGrid(`"grid"`, ""),
		withGrid(grid, `[{"key":"HDMI-A-1","name":null,"grid":{}}]`),
		withGrid(grid, `[{"key":"a","name":null,"grid":{}},{"key":"b","name":null,"grid":{}},{"key":"c","name":null,"grid":{}},
			{"key":"d","name":null,"grid":{}},{"key":"e","name":null,"grid":{}}]`),
	} {
		f.Set(desk.PathState, desktest.Answer{Body: bad})
		c, _ = newClient(t, f)
		if st := c.State(ctx); st != nil {
			t.Errorf("%.80s…: a state", bad[strings.Index(bad, `"grid"`):])
		}
	}
	// Absent: an older runtime, the calm glance as before.
	f.Set(desk.PathState, desktest.Answer{Body: desktest.Paired})
	c, _ = newClient(t, f)
	if st := c.State(ctx); st == nil || st.Glance.Grid != nil || st.Glance.Outputs != nil {
		t.Fatal("an older runtime's state")
	}
}

// The widest state the runtime may send (DESK_STATE_MAX_BYTES) is read whole.
func TestGridUpToTheStateLimit(t *testing.T) {
	f := desktest.Start(t)
	pad := strings.Repeat("x", 500*1024)
	f.Set(desk.PathState, desktest.Answer{Body: withGrid(`{"screen":"box","pad":"`+pad+`"}`, "")})
	c, _ := newClient(t, f)
	if st := c.State(context.Background()); st == nil || len(st.Glance.Grid) < len(pad) {
		t.Fatal("a state under 512 KiB wasn't read")
	}
	f.Set(desk.PathState, desktest.Answer{Body: withGrid(`{"screen":"box","pad":"`+pad+strings.Repeat("x", 13*1024)+`"}`, "")})
	c, _ = newClient(t, f)
	if st := c.State(context.Background()); st != nil {
		t.Fatal("a state over 512 KiB was read")
	}
}

var jpeg = "\xff\xd8\xff\xe0\x00\x10JFIF\x00rest"

// A widget's picture: one request with the thing and its ref; what the socket wouldn't take is 400 without asking; the
// bytes must be the picture the runtime says, at most 3 MiB; its refusals pass on.
func TestImage(t *testing.T) {
	ctx := context.Background()
	f := desktest.Start(t)
	c, _ := newClient(t, f)
	ref := "eyJ0IjoicGxleCJ9.c2lnbmF0dXJlLWhlcmU"
	f.Set(desk.PathImage, desktest.Answer{ContentType: "image/jpeg", Body: jpeg})
	b, kind, err := c.Image(ctx, "connection:con_P1", ref)
	if err != nil || kind != "image/jpeg" || string(b) != jpeg {
		t.Fatal(kind, err)
	}
	if last := f.Calls()[len(f.Calls())-1]; last.Path != "/v1/desk/image" ||
		last.Body != `{"v":1,"thing":"connection:con_P1","ref":"`+ref+`"}` {
		t.Fatalf("%+v", last)
	}
	asked := f.CallsTo(desk.PathImage)
	var de *desk.Error
	for _, bad := range [][2]string{
		{"plex", ref}, {"connection:", ref}, {"file:/etc/passwd", ref}, {"connection:con_P1", "short.ref"},
		{"connection:con_P1", "no-dot-in-this-ref-at-all"}, {"connection:con_P1", "../../etc.passwd/x"},
		{"connection:con_P1", strings.Repeat("a", 300) + "." + strings.Repeat("b", 300)},
	} {
		if _, _, err := c.Image(ctx, bad[0], bad[1]); !errors.As(err, &de) || de.Status != 400 || de.Code != "bad_request" {
			t.Errorf("%q: %v", bad, err)
		}
	}
	if n := f.CallsTo(desk.PathImage); n != asked {
		t.Fatalf("a request the console refuses reached the runtime (%d)", n-asked)
	}
	for _, a := range []desktest.Answer{
		{ContentType: "image/png", Body: jpeg},
		{ContentType: "image/svg+xml", Body: `<svg xmlns="http://www.w3.org/2000/svg"/>`},
		{ContentType: "text/html", Body: "<html>"},
		{ContentType: "image/jpeg", Body: "\xff\xd8"},
	} {
		f.Set(desk.PathImage, a)
		if _, _, err := c.Image(ctx, "connection:con_P1", ref); !errors.As(err, &de) || de.Status != http.StatusBadGateway {
			t.Errorf("%s: %v", a.ContentType, err)
		}
	}
	f.Set(desk.PathImage, desktest.Answer{ContentType: "image/webp; q=1", Body: "RIFF\x10\x00\x00\x00WEBPVP8 "})
	if _, kind, err := c.Image(ctx, "device:dev_C1", ref); err != nil || kind != "image/webp" {
		t.Fatal(kind, err)
	}
	f.Set(desk.PathImage, desktest.Answer{ContentType: "image/jpeg", Body: jpeg + strings.Repeat("x", desk.MaxImageBytes)})
	if _, _, err := c.Image(ctx, "connection:con_P1", ref); !errors.Is(err, desk.ErrUnavailable) {
		t.Fatal("a picture over 3 MiB:", err)
	}
	f.Set(desk.PathImage, desktest.Answer{Status: 404, Body: `{"error":{"code":"not_found","message":"x"}}`})
	if _, _, err := c.Image(ctx, "connection:con_P1", ref); !errors.As(err, &de) || de.Status != 404 || de.Code != "not_found" {
		t.Fatal(err)
	}
}

func name(s string) *string { return &s }

// The outputs and their sizes: one to four, the main one first and alone, each once, in the contract's bounds; names
// cleaned; the state asked again after it.
func TestSize(t *testing.T) {
	ctx := context.Background()
	f := desktest.Start(t)
	c, _ := newClient(t, f)
	f.Set(desk.PathSize, desktest.Answer{Body: `{"v":1}`})
	c.State(ctx)
	box := desk.SizeOutput{Key: "edp-1", Main: true, Size: desk.ScreenSize{Width: 1280, Height: 800}}
	mon := desk.SizeOutput{Key: "hdmi-a-1", Name: name(" DELL U2720Q​ "), Size: desk.ScreenSize{Width: 1920, Height: 1080}}
	if a, err := c.Size(ctx, []desk.SizeOutput{box, mon}); err != nil || a.V != 1 {
		t.Fatal(a, err)
	}
	if last := f.Calls()[len(f.Calls())-1]; last.Path != "/v1/desk/size" || last.Body != `{"v":1,"outputs":[`+
		`{"key":"edp-1","main":true,"name":null,"size":{"width":1280,"height":800}},`+
		`{"key":"hdmi-a-1","main":false,"name":"DELL U2720Q","size":{"width":1920,"height":1080}}]}` {
		t.Fatalf("%+v", last)
	}
	before := f.CallsTo(desk.PathState)
	if c.State(ctx); f.CallsTo(desk.PathState) != before+1 {
		t.Fatal("the cache wasn't dropped")
	}

	asked := f.CallsTo(desk.PathSize)
	other := func(key string) desk.SizeOutput {
		return desk.SizeOutput{Key: key, Size: desk.ScreenSize{Width: 800, Height: 600}}
	}
	sized := func(w, h int64) desk.SizeOutput {
		return desk.SizeOutput{Key: "edp-1", Main: true, Size: desk.ScreenSize{Width: w, Height: h}}
	}
	var de *desk.Error
	for i, bad := range [][]desk.SizeOutput{
		nil,
		{mon},
		{box, {Key: "dp-2", Main: true, Size: mon.Size}},
		{box, other("edp-1")},
		{box, other("HDMI-A-1")},
		{box, other("hdmi a 1")},
		{box, other(strings.Repeat("a", 41))},
		{box, other("dp-1"), other("dp-2"), other("dp-3"), other("dp-4")},
		{sized(199, 800)}, {sized(1280, 16_385)},
	} {
		if _, err := c.Size(ctx, bad); !errors.As(err, &de) || de.Status != 400 || de.Code != "bad_request" {
			t.Errorf("%d: %v", i, err)
		}
	}
	if n := f.CallsTo(desk.PathSize); n != asked {
		t.Fatalf("a request the console refuses reached the runtime (%d)", n-asked)
	}
	// The widest: four outputs with names of 60 four-byte characters fit DESK_REQUEST_MAX_BYTES.
	wide := []desk.SizeOutput{box, other("dp-1"), other("dp-2"), other("dp-3")}
	for i := range wide {
		wide[i].Key, wide[i].Name = strings.Repeat("k", 40-i), name(strings.Repeat("𝔘", 61))
	}
	if _, err := c.Size(ctx, wide); err != nil {
		t.Fatal(err)
	}
	if last := f.Calls()[len(f.Calls())-1]; strings.Count(last.Body, "𝔘") != 4*60 {
		t.Fatal("names aren't cut to 60")
	}
}

// The one limit copied from the contract is the vendored contract's (console/ui/vendor/whombat-contracts).
func TestImageLimitIsTheContracts(t *testing.T) {
	b, err := os.ReadFile("../../ui/vendor/whombat-contracts/desk-socket.ts")
	if err != nil {
		t.Fatal(err)
	}
	if desk.MaxImageBytes != 3*1024*1024 || !strings.Contains(string(b), "export const DESK_IMAGE_MAX_BYTES = 3 * 1024 * 1024;") {
		t.Fatal("the contract's DESK_IMAGE_MAX_BYTES changed")
	}
}
