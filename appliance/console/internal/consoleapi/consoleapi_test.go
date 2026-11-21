package consoleapi

import (
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/CybexBV/whombat/appliance/console/internal/desk"
	"github.com/CybexBV/whombat/appliance/console/internal/desk/desktest"
	"github.com/CybexBV/whombat/appliance/console/internal/screen"
	"github.com/CybexBV/whombat/appliance/console/internal/source"
	"github.com/CybexBV/whombat/appliance/console/internal/web"
)

var now = time.Date(2026, 9, 27, 12, 0, 0, 0, time.UTC)

// fixture: the real file functions over a temporary directory, as on the appliance.
type fixture struct {
	dir, state string
	srv        *Server
	h          http.Handler
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	d := t.TempDir()
	f := &fixture{dir: d, state: filepath.Join(d, "console.json")}
	f.srv = New(func() screen.Screen { return source.Load(f.state) }, []string{"Whombat appliance.", "Second line."},
		func() time.Time { return now })
	f.h = web.Handler(web.Options{Port: 8411, Token: "tok-abcdefgh", UI: fstest.MapFS{"index.html": {Data: []byte("x")}},
		API: f.srv.Handler(), MaxBody: 1024, Limits: BodyLimits})
	return f
}

func (f *fixture) writeState(t *testing.T, s string) {
	t.Helper()
	if err := os.WriteFile(f.state, []byte(s), 0o640); err != nil {
		t.Fatal(err)
	}
}

func (f *fixture) do(method, path, body string) (int, map[string]any) {
	w := f.raw(method, path, body)
	var out map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &out)
	return w.Code, out
}

func (f *fixture) raw(method, path, body string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, "http://127.0.0.1:8411"+path, strings.NewReader(body))
	r.Header.Set("Authorization", "Bearer tok-abcdefgh")
	if body != "" {
		r.Header.Set("Content-Type", "application/json")
	}
	w := httptest.NewRecorder()
	f.h.ServeHTTP(w, r)
	return w
}

func (f *fixture) get(t *testing.T) map[string]any {
	t.Helper()
	code, st := f.do("GET", "/api/state", "")
	if code != 200 {
		t.Fatalf("state: %d", code)
	}
	return st
}

func TestStateShapes(t *testing.T) {
	f := newFixture(t)
	// No file: starting, never an error.
	st := f.get(t)
	if _, ok := st["key"]; ok || st["screen"] != nil || st["mode"] != "console" || st["now"] != "2026-09-27T12:00:00Z" ||
		st["footer"] != "Whombat appliance.\nSecond line." {
		t.Fatalf("%v", st)
	}
	if c := st["claim"].(map[string]any); c["state"] != "starting" || c["claimUrl"] != "" || c["code"] != nil {
		t.Fatalf("%v", c)
	}
	f.writeState(t, `{"v":1,"state":"claimable","code":"KXQM","url":"https://app.whombat.com/claim"}`)
	c := f.get(t)["claim"].(map[string]any)
	if c["state"] != "claimable" || c["code"] != "KXQM" || c["claimUrl"] != "app.whombat.com/claim" || c["appUrl"] != "app.whombat.com" ||
		c["retryAt"] != nil || c["burrows"] != nil {
		t.Fatalf("%v", c)
	}
	f.writeState(t, `{"v":1,"state":"backoff","url":"http://localhost:5190/claim","retryAt":"2026-09-27T12:04:30.5Z"}`)
	c = f.get(t)["claim"].(map[string]any)
	if c["state"] != "backoff" || c["retryAt"] != "2026-09-27T12:04:30Z" || c["appUrl"] != "localhost:5190" || c["code"] != nil {
		t.Fatalf("%v", c)
	}
	f.writeState(t, `{"v":1,"state":"claimed","url":"https://app.whombat.com/claim","burrows":{"first":"Banjo’s Burrow","more":2}}`)
	c = f.get(t)["claim"].(map[string]any)
	if b := c["burrows"].(map[string]any); b["first"] != "Banjo’s Burrow" || b["more"] != float64(2) {
		t.Fatalf("%v", c)
	}
	f.writeState(t, `{"v":1,"state":"claimed","url":"https://app.whombat.com/claim"}`)
	if c = f.get(t)["claim"].(map[string]any); c["burrows"] != nil {
		t.Fatalf("%v", c)
	}
	if _, ok := f.get(t)["alert"]; ok {
		t.Fatal("an alert without one in the file")
	}
	// Plain HTTP on the network serves no page (Whombat LNK-55): no address to open. On an address on this network the
	// code stays, with what to type in the app there; on a name there, no code either.
	f.writeState(t, `{"v":1,"state":"claimable","code":"KXQM","url":"http://192.0.2.10:4480/c/s3cr3t"}`)
	if c = f.get(t)["claim"].(map[string]any); c["state"] != "claimable" || c["code"] != "KXQM" || c["inApp"] != "192.0.2.10" || c["claimUrl"] != "" || c["appUrl"] != "" {
		t.Fatalf("%v", c)
	}
	f.writeState(t, `{"v":1,"state":"claimable","code":"KXQM","url":"http://whombat.local:4480/"}`)
	if c = f.get(t)["claim"].(map[string]any); c["state"] != "claimable" || c["code"] != nil || c["inApp"] != nil || c["claimUrl"] != "" {
		t.Fatalf("%v", c)
	}
	f.writeState(t, `{"v":1,"state":"claimed","url":"http://192.0.2.10:4480/"}`)
	if c = f.get(t)["claim"].(map[string]any); c["state"] != "claimed" || c["claimUrl"] != "" || c["appUrl"] != "" || c["inApp"] != nil {
		t.Fatalf("%v", c)
	}
	// The alert (contracts 4.3) in any state, passed on as the page reads it.
	f.writeState(t, `{"v":1,"state":"claimable","code":"KXQM","url":"https://app.whombat.com/claim","alert":{"kind":"own_address_foreign","since":"2026-09-27T11:00:00.5+00:00"}}`)
	st = f.get(t)
	if a, _ := st["alert"].(map[string]any); a["kind"] != "own_address_foreign" || a["since"] != "2026-09-27T11:00:00Z" || st["claim"].(map[string]any)["code"] != "KXQM" {
		t.Fatalf("%v", st)
	}
}

// Hostile files: the page gets the starting screen or a cleaned, bounded name, never the raw bytes.
func TestHostileFiles(t *testing.T) {
	f := newFixture(t)
	for name, doc := range map[string]string{
		"escape in code": `{"v":1,"state":"claimable","code":"KX\u001b[2JQM","url":"https://a.b/claim"}`,
		"bidi in url":    `{"v":1,"state":"claimed","url":"https://a.b/\u202eclaim"}`,
		"html in url":    `{"v":1,"state":"claimed","url":"https://a.b/<script>"}`,
		"not json":       `<script>alert(1)</script>`,
	} {
		f.writeState(t, doc)
		if c := f.get(t)["claim"].(map[string]any); c["state"] != "starting" {
			t.Errorf("%s: %v", name, c)
		}
	}
	// A symlinked state file is not followed.
	_ = os.Remove(f.state)
	other := filepath.Join(f.dir, "other.json")
	_ = os.WriteFile(other, []byte(`{"v":1,"state":"claimable","code":"KXQM","url":"https://a.b/claim"}`), 0o644)
	_ = os.Symlink(other, f.state)
	if c := f.get(t)["claim"].(map[string]any); c["state"] != "starting" {
		t.Errorf("symlink: %v", c)
	}
	_ = os.Remove(f.state)
	for name, tc := range map[string]struct {
		doc   string
		first string // "" = no burrows
		more  float64
	}{
		// The contract's pattern (CT-116) refuses these outright: the claim stays, the burrows go.
		"bidi override":     {`{"first":"Evil\u202eworrub","more":1}`, "", 0},
		"zero-width joiner": {`{"first":"Ba\u200dnjo","more":0}`, "", 0},
		"control chars":     {`{"first":"Ban\u001b[2Jjo\u0007","more":0}`, "", 0},
		"line separator":    {`{"first":"Ban\u2028jo\u2029","more":0}`, "", 0},
		"leading space":     {`{"first":" Banjo","more":0}`, "", 0},
		"inner spaces":      {`{"first":"Banjo’s Big  Burrow","more":3}`, "Banjo’s Big  Burrow", 3},
		"html stays text":   {`{"first":"<img src=x>","more":0}`, "<img src=x>", 0},
		"64 code points":    {`{"first":"` + strings.Repeat("é", 64) + `","more":9999}`, strings.Repeat("é", 64), 9999},
		"65 code points":    {`{"first":"` + strings.Repeat("é", 65) + `","more":0}`, "", 0},
		"only controls":     {`{"first":"\u202e\u200b\u0000","more":0}`, "", 0},
		"empty":             {`{"first":"","more":0}`, "", 0},
		"negative more":     {`{"first":"B","more":-1}`, "", 0},
		"more too large":    {`{"first":"B","more":10000}`, "", 0},
		"fractional more":   {`{"first":"B","more":1.5}`, "", 0},
		"string more":       {`{"first":"B","more":"2"}`, "", 0},
		"no more":           {`{"first":"B"}`, "", 0},
		"not an object":     {`"Banjo"`, "", 0},
		"number name":       {`{"first":5,"more":0}`, "", 0},
	} {
		f.writeState(t, `{"v":1,"state":"claimed","url":"https://a.b/claim","burrows":`+tc.doc+`}`)
		c := f.get(t)["claim"].(map[string]any)
		if c["state"] != "claimed" {
			t.Errorf("%s: the whole file was refused: %v", name, c)
			continue
		}
		b, _ := c["burrows"].(map[string]any)
		if tc.first == "" {
			if b != nil {
				t.Errorf("%s: %v", name, b)
			}
			continue
		}
		if b == nil || b["first"] != tc.first || b["more"] != tc.more {
			t.Errorf("%s: %v", name, b)
		}
	}
	// Burrows outside `claimed` are dropped.
	f.writeState(t, `{"v":1,"state":"waiting","url":"https://a.b/claim","burrows":{"first":"B","more":0}}`)
	if c := f.get(t)["claim"].(map[string]any); c["state"] != "waiting" || c["burrows"] != nil {
		t.Errorf("waiting: %v", c)
	}
}

// A device waiting to sign in at the screen (BX-06, CG-150, CG-151): claimed only, cleaned, gone once its time is up.
func TestSignIn(t *testing.T) {
	f := newFixture(t)
	signIn := func(expires string) string {
		return `{"code":"KXQMTR","name":"John Doe","device":"Pixel 9","expiresAt":"` + expires + `"}`
	}
	f.writeState(t, `{"v":1,"state":"claimed","url":"https://app.whombat.com/claim","burrows":{"first":"Banjo’s Burrow","more":0},`+
		`"signIn":`+signIn("2026-09-27T14:04:30.9+02:00")+`}`)
	st := f.get(t)
	c := st["claim"].(map[string]any)
	si, _ := c["signIn"].(map[string]any)
	if si == nil || si["code"] != "KXQMTR" || si["name"] != "John Doe" || si["device"] != "Pixel 9" ||
		si["expiresAt"] != "2026-09-27T12:04:30Z" || st["now"] != "2026-09-27T12:00:00Z" || c["burrows"] == nil || len(si) != 4 {
		t.Fatalf("%v", c)
	}
	// Still in the file but its time is up (a runtime that stopped without rewriting it): not shown.
	f.writeState(t, `{"v":1,"state":"claimed","url":"https://app.whombat.com/claim","signIn":`+signIn("2026-09-27T12:00:00Z")+`}`)
	if c := f.get(t)["claim"].(map[string]any); c["state"] != "claimed" || c["signIn"] != nil {
		t.Fatalf("expired: %v", c)
	}
	// Outside claimed, or not one: the claim state as before, no panel.
	for _, doc := range []string{
		`{"v":1,"state":"claimable","code":"KXQM","url":"https://app.whombat.com/claim","signIn":` + signIn("2026-09-27T12:04:30Z") + `}`,
		`{"v":1,"state":"claimed","url":"https://app.whombat.com/claim","signIn":{"code":"KXQMTR","name":"<b>‮</b>","device":"x","expiresAt":"2026-09-27T12:04:30Z"}}`,
	} {
		f.writeState(t, doc)
		if c := f.get(t)["claim"].(map[string]any); c["signIn"] != nil || (c["state"] != "claimed" && c["code"] != "KXQM") {
			t.Errorf("%s: %v", doc, c)
		}
	}
}

// CG-31: no recovery key screen and nothing to post. Without a desk socket the API only reads: `desk` is null and the
// desk's requests don't exist (NX-160).
func TestReadOnly(t *testing.T) {
	f := newFixture(t)
	for _, path := range []string{"/api/confirm", "/api/state", "/api/desk/unlock", "/api/desk/lock", "/api/desk/talk", "/api/desk/found/dismiss"} {
		if code, _ := f.do("POST", path, `{"group":"cbdefghi"}`); code != http.StatusNotFound && code != http.StatusMethodNotAllowed {
			t.Errorf("POST %s: %d", path, code)
		}
	}
	if code, _ := f.do("GET", "/api/desk/talk/audio?id=talk-0001", ""); code != http.StatusNotFound {
		t.Errorf("GET audio: %d", code)
	}
	st := f.get(t)
	if d, ok := st["desk"]; !ok || d != nil {
		t.Fatalf("desk: %v %v", d, ok)
	}
}

// The desk (§2.5): the runtime's state under `desk`, and the page's requests passed on with their own body limits.
func TestDesk(t *testing.T) {
	fake := desktest.Start(t)
	f := newFixture(t)
	f.srv.WithDesk(desk.New(fake.Socket, os.Getuid(), nil, t.Logf))
	f.writeState(t, `{"v":1,"state":"claimed","url":"https://app.whombat.com/claim"}`)
	st := f.get(t)
	d, _ := st["desk"].(map[string]any)
	if d == nil || st["claim"].(map[string]any)["state"] != "claimed" {
		t.Fatalf("%v", st)
	}
	if p := d["paired"].(map[string]any); p["person"].(map[string]any)["name"] != "John" || p["quiet"] != false ||
		d["power"].(map[string]any)["minutesLeft"] != float64(185) || d["lock"].(map[string]any)["state"] != "locked" {
		t.Fatalf("%v", d)
	}
	// Remote help (CG-290): absent while off; on, the desk's member, cleaned; Stop passes through (CG-291).
	if d["remoteHelp"] != nil {
		t.Fatalf("%v", d["remoteHelp"])
	}
	fake.Set(desk.PathState, desktest.Answer{Body: strings.Replace(desktest.Paired, `"talk":null}`,
		`"talk":null,"remoteHelp":{"level":"fix","until":null,"connected":"Claude"}}`, 1)})
	f.srv.WithDesk(desk.New(fake.Socket, os.Getuid(), nil, t.Logf))
	rh, _ := f.get(t)["desk"].(map[string]any)["remoteHelp"].(map[string]any)
	if rh["level"] != "fix" || rh["until"] != nil || rh["connected"] != "Claude" {
		t.Fatalf("%v", rh)
	}
	fake.Set(desk.PathRemoteHelpStop, desktest.Answer{Body: desktest.Paired})
	if code, out := f.do("POST", "/api/desk/remote-help/stop", `{}`); code != 200 || out["v"] != float64(1) {
		t.Fatal(code, out)
	}
	if code, _ := f.do("GET", "/api/desk/remote-help/stop", ""); code != http.StatusMethodNotAllowed {
		t.Fatal(code)
	}

	// The runtime away: desk null, the rest as before.
	fake.Set(desk.PathState, desktest.Answer{Status: 500})
	// (a new client: the cache is a second long)
	f.srv.WithDesk(desk.New(fake.Socket, os.Getuid(), nil, t.Logf))
	if st := f.get(t); st["desk"] != nil || st["claim"].(map[string]any)["state"] != "claimed" {
		t.Fatalf("%v", st)
	}

	fake.Set(desk.PathUnlock, desktest.Answer{Body: `{"v":1,"result":"unlocked"}`})
	if code, out := f.do("POST", "/api/desk/unlock", `{"pin":"123456"}`); code != 200 || out["result"] != "unlocked" {
		t.Fatal(code, out)
	}
	if code, out := f.do("POST", "/api/desk/unlock", `{"pin":"2580"}`); code != 200 || out["result"] != "unlocked" {
		t.Fatal("a 4-digit PIN (DK-26):", code, out)
	}
	if code, out := f.do("POST", "/api/desk/unlock", `{"pin":"123"}`); code != 400 || out["message"] != "bad_request" {
		t.Fatal(code, out)
	}
	if code, _ := f.do("GET", "/api/desk/unlock", ""); code != http.StatusMethodNotAllowed {
		t.Fatal(code)
	}
	fake.Set(desk.PathDecide, desktest.Answer{Status: 403, Body: `{"error":{"code":"on_phone","message":"x"}}`})
	if code, out := f.do("POST", "/api/desk/decide", `{"number":3,"decision":"approve"}`); code != 403 || out["message"] != "on_phone" {
		t.Fatal(code, out)
	}
	// Deny and a risky ask's Approve with the PIN (0.108, DK-61, DK-62): the page's fields, nothing else, reach the runtime.
	fake.Set(desk.PathDecide, desktest.Answer{Body: `{"v":1,"result":"wrong","triesLeft":2}`})
	if code, out := f.do("POST", "/api/desk/decide", `{"number":3,"decision":"approve","pin":"2580","always":true}`); code != 200 || out["result"] != "wrong" || out["triesLeft"] != 2.0 {
		t.Fatal(code, out)
	}
	if got := fake.Calls()[len(fake.Calls())-1]; got.Body != `{"v":1,"number":3,"decision":"approve","pin":"2580"}` {
		t.Fatalf("%+v", got)
	}
	// One of an ask's wider choices (0.116, TF-14): its scope with the PIN; a scope that isn't one is 400, a wider one
	// without the PIN 403 pin_needed, both unasked; the runtime's not_offered as its code (CG-56).
	if code, _ := f.do("POST", "/api/desk/decide", `{"number":3,"decision":"approve","pin":"2580","scope":"agent"}`); code != 200 {
		t.Fatal(code)
	}
	if got := fake.Calls()[len(fake.Calls())-1]; got.Body != `{"v":1,"number":3,"decision":"approve","pin":"2580","scope":"agent"}` {
		t.Fatalf("%+v", got)
	}
	calls := fake.CallsTo(desk.PathDecide)
	if code, out := f.do("POST", "/api/desk/decide", `{"number":3,"decision":"approve","pin":"2580","scope":"always"}`); code != 400 || out["message"] != "bad_request" {
		t.Fatal(code, out)
	}
	if code, out := f.do("POST", "/api/desk/decide", `{"number":3,"decision":"approve","scope":"task"}`); code != 403 || out["message"] != "pin_needed" {
		t.Fatal(code, out)
	}
	if n := fake.CallsTo(desk.PathDecide); n != calls {
		t.Fatalf("a decision the console refuses reached the runtime (%d)", n-calls)
	}
	fake.Set(desk.PathDecide, desktest.Answer{Status: 403, Body: `{"error":{"code":"not_offered","message":"x"}}`})
	if code, out := f.do("POST", "/api/desk/decide", `{"number":3,"decision":"approve","pin":"2580","scope":"agent"}`); code != 403 || out["message"] != "not_offered" {
		t.Fatal(code, out)
	}
	fake.Set(desk.PathDecide, desktest.Answer{Body: `{"v":1,"result":"decided"}`})
	if code, out := f.do("POST", "/api/desk/decide", `{"number":3,"decision":"deny"}`); code != 200 || out["result"] != "decided" {
		t.Fatal(code, out)
	}
	if code, out := f.do("POST", "/api/desk/decide", `{"number":3,"decision":"approve","pin":"12"}`); code != 400 || out["message"] != "bad_request" {
		t.Fatal(code, out)
	}
	// The open conversation and Close (0.108, DK-63, DK-64).
	fake.Set(desk.PathTalkSession, desktest.Answer{Body: desktest.Session})
	if code, out := f.do("POST", "/api/desk/talk/session", ""); code != 200 || out["open"] != true || len(out["messages"].([]any)) != 3 {
		t.Fatal(code, out)
	}
	if code, _ := f.do("GET", "/api/desk/talk/session", ""); code != http.StatusMethodNotAllowed {
		t.Fatal(code)
	}
	fake.Set(desk.PathTalkClose, desktest.Answer{Body: `{"v":1}`})
	if code, _ := f.do("POST", "/api/desk/talk/close", ""); code != 200 {
		t.Fatal(code)
	}
	// Found on your network's Not now (0.110, DF-04): POST only, the runtime's refusal as its code (CG-56).
	fake.Set(desk.PathFoundDismiss, desktest.Answer{Body: `{"v":1}`})
	if code, _ := f.do("POST", "/api/desk/found/dismiss", "{}"); code != 200 || fake.CallsTo(desk.PathFoundDismiss) != 1 {
		t.Fatal(code)
	}
	if code, _ := f.do("GET", "/api/desk/found/dismiss", ""); code != http.StatusMethodNotAllowed {
		t.Fatal(code)
	}
	fake.Set(desk.PathFoundDismiss, desktest.Answer{Status: 404, Body: `{"error":{"code":"not_found","message":"x"}}`})
	if code, out := f.do("POST", "/api/desk/found/dismiss", ""); code != 404 || out["message"] != "not_found" {
		t.Fatal(code, out)
	}
	// Ignore and Not now on a look (0.122, QN-20, CG-331): the look's key, its line and how, nothing else, reach the
	// runtime; up to DESK_REQUEST_MAX_BYTES (wider than the API's 1 KiB); its refusals as their codes.
	fake.Set(desk.PathLookQuiet, desktest.Answer{Body: `{"v":1}`})
	quiet := `{"key":"connection:con_U1","notice":{"check":"unifi.device_offline","subject":"device:64a1"},"how":"ignore","always":true}`
	if code, out := f.do("POST", "/api/desk/look/quiet", quiet); code != 200 || out["v"] != 1.0 {
		t.Fatal(code, out)
	}
	if got := fake.Calls()[len(fake.Calls())-1]; got.Body != `{"v":1,"key":"connection:con_U1","notice":{"check":"unifi.device_offline","subject":"device:64a1"},"how":"ignore"}` {
		t.Fatalf("%+v", got)
	}
	wide := `{"key":"` + strings.Repeat("𝔘", 120) + `","notice":{"check":"unifi.device_offline","subject":"` + strings.Repeat("𝔘", 160) + `"},"how":"snooze"}`
	if code, out := f.do("POST", "/api/desk/look/quiet", wide); len(wide) <= 1024 || code != 200 {
		t.Fatal("the widest look past 1 KiB:", len(wide), code, out)
	}
	if code, _ := f.do("POST", "/api/desk/look/quiet", `{"key":"`+strings.Repeat("k", 2100)+`"}`); code != 413 {
		t.Fatal(code)
	}
	if code, out := f.do("POST", "/api/desk/look/quiet", `{"key":"connection:con_U1","notice":{"check":"unifi.device_offline"},"how":"undo"}`); code != 400 || out["message"] != "bad_request" {
		t.Fatal(code, out)
	}
	if code, _ := f.do("GET", "/api/desk/look/quiet", ""); code != http.StatusMethodNotAllowed {
		t.Fatal(code)
	}
	fake.Set(desk.PathLookQuiet, desktest.Answer{Status: 403, Body: `{"error":{"code":"not_allowed","message":"x"}}`})
	if code, out := f.do("POST", "/api/desk/look/quiet", quiet); code != 403 || out["message"] != "not_allowed" {
		t.Fatal(code, out)
	}
	// The step the assistant offers on a look (3.5, CG-371): the look's key, nothing else, reaches the runtime; up to
	// DESK_REQUEST_MAX_BYTES; its refusals as their codes.
	fake.Set(desk.PathLookFix, desktest.Answer{Body: `{"v":1}`})
	if code, out := f.do("POST", "/api/desk/look/fix", `{"key":"connection:con_H1","how":"all"}`); code != 200 || out["v"] != 1.0 {
		t.Fatal(code, out)
	}
	if got := fake.Calls()[len(fake.Calls())-1]; got.Path != desk.PathLookFix || got.Body != `{"v":1,"key":"connection:con_H1"}` {
		t.Fatalf("%+v", got)
	}
	if code, _ := f.do("POST", "/api/desk/look/fix", `{"key":"`+strings.Repeat("k", 2100)+`"}`); code != 413 {
		t.Fatal(code)
	}
	if code, out := f.do("POST", "/api/desk/look/fix", `{"key":""}`); code != 400 || out["message"] != "bad_request" {
		t.Fatal(code, out)
	}
	if code, _ := f.do("GET", "/api/desk/look/fix", ""); code != http.StatusMethodNotAllowed {
		t.Fatal(code)
	}
	fake.Set(desk.PathLookFix, desktest.Answer{Status: 404, Body: `{"error":{"code":"not_found","message":"x"}}`})
	if code, out := f.do("POST", "/api/desk/look/fix", `{"key":"connection:con_H1"}`); code != 404 || out["message"] != "not_found" {
		t.Fatal(code, out)
	}
	// Every server and a server's own screen (0.115, DK-83, DK-86): the page's id and range, nothing else, reach the
	// runtime; its refusals as their codes (CG-56).
	fake.Set(desk.PathServers, desktest.Answer{Body: desktest.Servers})
	if code, out := f.do("POST", "/api/desk/servers", "{}"); code != 200 || len(out["servers"].([]any)) != 2 || out["more"] != 3.0 {
		t.Fatal(code, out)
	}
	fake.Set(desk.PathServer, desktest.Answer{Body: desktest.ServerPage})
	code, out := f.do("POST", "/api/desk/server", `{"id":"pve-01","range":"24h","restart":true}`)
	if code != 200 || out["os"] != "Proxmox VE 9.0.10" || out["server"].(map[string]any)["id"] != "pve-01" ||
		len(out["volumes"].([]any)) != 1 {
		t.Fatal(code, out)
	}
	if got := fake.Calls()[len(fake.Calls())-1]; got.Body != `{"v":1,"id":"pve-01","range":"24h"}` {
		t.Fatalf("%+v", got)
	}
	if code, out := f.do("POST", "/api/desk/server", `{"id":"../x","range":"24h"}`); code != 400 || out["message"] != "bad_request" {
		t.Fatal(code, out)
	}
	if code, _ := f.do("GET", "/api/desk/server", ""); code != http.StatusMethodNotAllowed {
		t.Fatal(code)
	}
	fake.Set(desk.PathServer, desktest.Answer{Status: 409, Body: `{"error":{"code":"locked","message":"x"}}`})
	if code, out := f.do("POST", "/api/desk/server", `{"id":"pve-01","range":"1h"}`); code != 409 || out["message"] != "locked" {
		t.Fatal(code, out)
	}
	// Ask about this server (DK-85): the talk names it.
	fake.Set(desk.PathTalk, desktest.Answer{Body: `{"v":1,"id":"talk-0010"}`})
	if code, out := f.do("POST", "/api/desk/talk", `{"text":"why is it busy?","continue":true,"server":"pve-01"}`); code != 200 || out["id"] != "talk-0010" {
		t.Fatal(code, out)
	}
	if got := fake.Calls()[len(fake.Calls())-1]; got.Body != `{"v":1,"text":"why is it busy?","continue":true,"server":"pve-01"}` {
		t.Fatalf("%+v", got)
	}
	fake.Set(desk.PathLock, desktest.Answer{Body: `{"v":1}`})
	if code, _ := f.do("POST", "/api/desk/lock", ""); code != 200 {
		t.Fatal(code)
	}
	if code, out := f.do("POST", "/api/desk/unlock", `{"pin":"`+strings.Repeat("1", 1100)+`"}`); code != 413 {
		t.Fatal("1 KiB is the limit but for talk:", code, out)
	}
	// A 30 s recording fits the talk's 1.5 MiB; the same size elsewhere doesn't.
	fake.Set(desk.PathTalk, desktest.Answer{Body: `{"v":1,"id":"talk-0009"}`})
	audio := base64.StdEncoding.EncodeToString(wav30s())
	if code, out := f.do("POST", "/api/desk/talk", `{"audioWav":"`+audio+`","continue":false}`); code != 200 || out["id"] != "talk-0009" {
		t.Fatal(code, out)
	}
	if code, _ := f.do("POST", "/api/desk/talk/get", `{"id":"`+audio+`"}`); code != 413 {
		t.Fatal(code)
	}
	fake.Set(desk.PathTalkAudio, desktest.Answer{ContentType: "audio/wav", Body: "RIFF\x04\x00\x00\x00WAVE"})
	if w := f.raw("GET", "/api/desk/talk/audio?id=talk-0009", ""); w.Code != 200 || w.Header().Get("Content-Type") != "audio/wav" ||
		w.Header().Get("Cache-Control") != "no-store" || !strings.HasPrefix(w.Body.String(), "RIFF") {
		t.Fatal(w.Code, w.Header())
	}
	if code, out := f.do("GET", "/api/desk/talk/audio?id=../../x", ""); code != 400 || out["message"] != "bad_request" {
		t.Fatal(code, out)
	}
	// Talk's mic (3.3, CG-363): five minutes fit the hear's body, not the talk's; the words come back, and a question
	// sent with them says it came by voice.
	fake.Set(desk.PathHear, desktest.Answer{Body: `{"v":1,"text":"Is pve-02 okay?"}`})
	five := base64.StdEncoding.EncodeToString(wavSeconds(desk.MaxHearSeconds))
	if code, out := f.do("POST", "/api/desk/hear", `{"audioWav":"`+five+`"}`); code != 200 || out["text"] != "Is pve-02 okay?" {
		t.Fatal(code, out)
	}
	if code, _ := f.do("POST", "/api/desk/talk", `{"audioWav":"`+five+`","continue":false}`); code != 413 {
		t.Fatal("five minutes as a talk:", code)
	}
	if code, out := f.do("POST", "/api/desk/hear", `{"audioWav":"RIFF"}`); code != 400 || out["message"] != "bad_audio" {
		t.Fatal(code, out)
	}
	fake.Set(desk.PathHear, desktest.Answer{Status: 409, Body: `{"error":{"code":"busy","message":"x"}}`})
	if code, out := f.do("POST", "/api/desk/hear", `{"audioWav":"`+audio+`"}`); code != 409 || out["message"] != "busy" {
		t.Fatal(code, out)
	}
	fake.Set(desk.PathTalk, desktest.Answer{Body: `{"v":1,"id":"talk-0011"}`})
	if code, _ := f.do("POST", "/api/desk/talk", `{"text":"Is pve-02 okay?","continue":true,"spoken":true}`); code != 200 {
		t.Fatal(code)
	}
	if got := fake.Calls()[len(fake.Calls())-1]; got.Body != `{"v":1,"text":"Is pve-02 okay?","continue":true,"spoken":true}` {
		t.Fatalf("%+v", got)
	}
	// A new box (DK-22, DK-18): This Whombat and the screen without a PIN reach the page; a PIN sent anyway is the
	// runtime's 409 `no_pin`, as the page reads it (CG-56).
	fake.Set(desk.PathState, desktest.Answer{Body: desktest.NewBox})
	f.srv.WithDesk(desk.New(fake.Socket, os.Getuid(), nil, t.Logf))
	nb, _ := f.get(t)["desk"].(map[string]any)
	if nb == nil || nb["paired"].(map[string]any)["hasPin"] != false ||
		nb["glance"].(map[string]any)["box"].(map[string]any)["storage"].(map[string]any)["free"].(map[string]any)["value"] != "812" {
		t.Fatalf("%v", nb)
	}
	// This Whombat beside servers and the next four of each (0.104, DK-39, DK-41): in /api/state as Whombat sent them.
	fake.Set(desk.PathState, desktest.Answer{Body: desktest.Fit})
	f.srv.WithDesk(desk.New(fake.Socket, os.Getuid(), nil, t.Logf))
	fg, _ := f.get(t)["desk"].(map[string]any)["glance"].(map[string]any)
	if fg == nil || fg["self"].(map[string]any)["up"] != "up 2 h 14 min" || len(fg["extraServers"].([]any)) != 4 ||
		len(fg["extraTiles"].([]any)) != 2 || fg["moreServers"] != 6.0 || fg["box"] != nil {
		t.Fatalf("%v", fg)
	}
	// Unlocked until Lock and the camera looking for someone (0.107, DK-72, DK-74): in /api/state as Whombat sent them.
	fake.Set(desk.PathState, desktest.Answer{Body: desktest.Idle})
	f.srv.WithDesk(desk.New(fake.Socket, os.Getuid(), nil, t.Logf))
	id, _ := f.get(t)["desk"].(map[string]any)
	if id == nil || id["lock"].(map[string]any)["stays"] != true || id["presence"].(map[string]any)["here"] != true ||
		id["presence"].(map[string]any)["watching"] != true {
		t.Fatalf("%v", id)
	}
	fake.Set(desk.PathUnlock, desktest.Answer{Status: 409, Body: `{"error":{"code":"no_pin","message":"x"}}`})
	if code, out := f.do("POST", "/api/desk/unlock", `{"pin":"123456"}`); code != 409 || out["message"] != "no_pin" {
		t.Fatal(code, out)
	}
	// No socket at all: the requests are 503 `unavailable`.
	f.srv.WithDesk(desk.New("/nonexistent/desk.sock", os.Getuid(), nil, nil))
	if code, out := f.do("POST", "/api/desk/lock", ""); code != 503 || out["message"] != "unavailable" {
		t.Fatal(code, out)
	}
}

// wav30s is 30 s of 16 kHz mono 16-bit silence.
func wav30s() []byte { return wavSeconds(30) }

// wavSeconds is a 16 kHz mono 16-bit recording of silence that long.
func wavSeconds(seconds int) []byte {
	var b bytes.Buffer
	data := seconds * 16000 * 2
	b.WriteString("RIFF")
	_ = binary.Write(&b, binary.LittleEndian, uint32(36+data))
	b.WriteString("WAVEfmt ")
	for _, v := range []any{uint32(16), uint16(1), uint16(1), uint32(16000), uint32(32000), uint16(2), uint16(16)} {
		_ = binary.Write(&b, binary.LittleEndian, v)
	}
	b.WriteString("data")
	_ = binary.Write(&b, binary.LittleEndian, uint32(data))
	b.Write(make([]byte, data))
	return b.Bytes()
}

func TestAppURL(t *testing.T) {
	for in, want := range map[string]string{"app.whombat.com/claim": "app.whombat.com", "localhost:5190/claim": "localhost:5190",
		"a.b": "a.b", "": ""} {
		if got := AppURL(in); got != want {
			t.Errorf("%q: %q", in, got)
		}
	}
}

// Why the first start can't finish (CG-409): in the claim while it is starting, from the provisioning unit's file; gone
// once the runtime writes its own state.
func TestStartProblem(t *testing.T) {
	f := newFixture(t)
	start := filepath.Join(f.dir, "problem.json")
	f.srv = New(func() screen.Screen {
		s := source.Load(f.state)
		if s.State == screen.Starting {
			s.Start = source.LoadStart(start)
		}
		return s
	}, nil, func() time.Time { return now })
	if c := f.srv.State(t.Context()).Claim; c.State != screen.Starting || c.Start != nil {
		t.Fatalf("without a problem: %+v", c)
	}
	if err := os.WriteFile(start, []byte(`{"v":1,"problem":"release-missing","release":"whombat-20261120.15"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	c := f.srv.State(t.Context()).Claim
	if c.State != screen.Starting || c.Start == nil || *c.Start != (Start{Problem: "release-missing", Release: "whombat-20261120.15"}) {
		t.Fatalf("with a problem: %+v %+v", c, c.Start)
	}
	b, _ := json.Marshal(c)
	if !strings.Contains(string(b), `"start":{"problem":"release-missing","release":"whombat-20261120.15"}`) {
		t.Fatalf("json: %s", b)
	}
	f.writeState(t, `{"v":1,"state":"waiting","url":"https://app.whombat.com/claim"}`)
	if c := f.srv.State(t.Context()).Claim; c.State != screen.Waiting || c.Start != nil {
		t.Fatalf("a runtime that writes its state has started: %+v", c)
	}
}
