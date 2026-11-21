package consoleapi

import (
	"net/http"
	"os"
	"strings"
	"testing"

	"github.com/CybexBV/whombat/appliance/console/internal/desk"
	"github.com/CybexBV/whombat/appliance/console/internal/desk/desktest"
)

// The screen of widgets: the grid reaches the page in the state; a widget's picture and the outputs' sizes pass
// through, only what the page names reaches the runtime, up to the socket's own body limit, refusals as their codes.
func TestDeskScreens(t *testing.T) {
	fake := desktest.Start(t)
	f := newFixture(t)
	f.writeState(t, `{"v":1,"state":"claimed","url":"https://app.whombat.com/claim"}`)
	fake.Set(desk.PathState, desktest.Answer{Body: strings.Replace(desktest.Paired, `"moreServers":0,`,
		`"moreServers":0,"grid":{"screen":"box","views":[]},"outputs":[{"key":"hdmi-a-1","name":null,"grid":{"screen":"out_hdmi-a-1"}}],`, 1)})
	f.srv.WithDesk(desk.New(fake.Socket, os.Getuid(), nil, t.Logf))
	g := f.get(t)["desk"].(map[string]any)["glance"].(map[string]any)
	if g["grid"].(map[string]any)["screen"] != "box" || g["outputs"].([]any)[0].(map[string]any)["key"] != "hdmi-a-1" {
		t.Fatalf("%v", g)
	}

	ref := strings.Repeat("a", 300) + "." + strings.Repeat("b", 299)
	image := "/api/desk/image?thing=connection%3Acon_P1&ref=" + ref
	fake.Set(desk.PathImage, desktest.Answer{ContentType: "image/png", Body: "\x89PNG\r\n\x1a\nrest"})
	w := f.raw("GET", image+"&size=big", "")
	if w.Code != 200 || w.Header().Get("Content-Type") != "image/png" || w.Header().Get("Cache-Control") != "no-store" ||
		!strings.HasPrefix(w.Body.String(), "\x89PNG") {
		t.Fatal(w.Code, w.Header())
	}
	if got := fake.Calls()[len(fake.Calls())-1]; got.Body != `{"v":1,"thing":"connection:con_P1","ref":"`+ref+`"}` {
		t.Fatalf("%+v", got)
	}
	if code, out := f.do("GET", "/api/desk/image?thing=connection%3Acon_P1&ref=x", ""); code != 400 || out["message"] != "bad_request" {
		t.Fatal(code, out)
	}
	if code, _ := f.do("POST", image, "{}"); code != http.StatusMethodNotAllowed {
		t.Fatal(code)
	}
	fake.Set(desk.PathImage, desktest.Answer{Status: 404, Body: `{"error":{"code":"not_found","message":"x"}}`})
	if code, out := f.do("GET", image, ""); code != 404 || out["message"] != "not_found" {
		t.Fatal(code, out)
	}

	fake.Set(desk.PathSize, desktest.Answer{Body: `{"v":1}`})
	monitor := func(key string) string {
		return `,{"key":"` + key + `","main":false,"name":"` + strings.Repeat("𝔘", 60) + `","size":{"width":1920,"height":1080}}`
	}
	size := `{"outputs":[{"key":"edp-1","main":true,"name":null,"size":{"width":1280,"height":800}}` +
		monitor("hdmi-a-1") + monitor("dp-1") + monitor("dp-2") + `]}`
	if code, out := f.do("POST", "/api/desk/size", size); len(size) <= 1024 || code != 200 || out["v"] != 1.0 {
		t.Fatal("the widest names past 1 KiB:", len(size), code, out)
	}
	if got := fake.Calls()[len(fake.Calls())-1]; got.Path != desk.PathSize || !strings.HasPrefix(got.Body, `{"v":1,"outputs":[{"key":"edp-1","main":true`) {
		t.Fatalf("%+v", got)
	}
	if code, out := f.do("POST", "/api/desk/size", `{"outputs":[]}`); code != 400 || out["message"] != "bad_request" {
		t.Fatal(code, out)
	}
	fake.Set(desk.PathSize, desktest.Answer{Status: 409, Body: `{"error":{"code":"not_paired","message":"x"}}`})
	if code, out := f.do("POST", "/api/desk/size", size); code != 409 || out["message"] != "not_paired" {
		t.Fatal(code, out)
	}

	// No desk socket: the routes aren't there.
	plain := newFixture(t)
	if code, _ := plain.do("POST", "/api/desk/size", size); code != 404 {
		t.Fatal(code)
	}
	if code, _ := plain.do("GET", image, ""); code != 404 {
		t.Fatal(code)
	}
}
