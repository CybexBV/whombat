package consoleapi

import (
	"encoding/json"
	"net/http"
	"os"
	"reflect"
	"strings"
	"testing"

	"github.com/CybexBV/whombat/appliance/console/internal/desk"
	"github.com/CybexBV/whombat/appliance/console/internal/desk/desktest"
)

// /api/state's `bluetooth` (CG-201): what the chip shows, from the same answer as /api/bluetooth; nothing without an
// adapter.
func TestBluetoothSummary(t *testing.T) {
	f, fake := networkFixture(t)
	b, _ := f.get(t)["bluetooth"].(map[string]any)
	if b == nil || b["missing"] != nil || !reflect.DeepEqual(b["connected"], []any{map[string]any{"name": "Keychron K3", "kind": "keyboard"}}) {
		t.Fatalf("%v", b)
	}
	none := BluetoothSummary{Connected: []BluetoothChipDevice{}}
	for name, tc := range map[string]struct {
		state string
		want  *BluetoothSummary
	}{
		"nothing connected": {`{"adapter":{"name":"hci0","powered":true},"devices":[
		  {"address":"AC:80:0A:5E:21:4D","name":"WH-1000XM5","kind":"headphones","connected":false}],"scan":null,"pairing":null}`, &none},
		"no adapter": {`{"adapter":null,"missing":"no_adapter","devices":[],"scan":null,"pairing":null}`, nil},
		"no driver":  {`{"adapter":null,"missing":"no_driver","devices":[],"scan":null,"pairing":null}`, &BluetoothSummary{Missing: "no_driver", Connected: []BluetoothChipDevice{}}},
		"off":        {`{"adapter":{"name":"hci0","powered":false},"missing":"disabled","devices":[],"scan":null,"pairing":null}`, &BluetoothSummary{Missing: "disabled", Connected: []BluetoothChipDevice{}}},
	} {
		a, err := desk.ParseBluetoothAnswer([]byte(`{"v":1,"bluetooth":` + tc.state + `,"mayChange":true}`))
		if err != nil {
			t.Fatal(name, err)
		}
		if got := BluetoothSummaryOf(a); !reflect.DeepEqual(got, tc.want) {
			t.Errorf("%s: %+v", name, got)
		}
	}
	// A runtime without Bluetooth (an older one: 404): null, the rest as before.
	fake.Set(desk.PathBluetooth, desktest.Answer{Status: 404, Body: `{"error":{"code":"not_found","message":"x"}}`})
	f.srv.WithDesk(desk.New(fake.Socket, os.Getuid(), nil, t.Logf))
	if st := f.get(t); st["bluetooth"] != nil || st["network"] == nil || st["desk"] == nil {
		t.Fatalf("%v", st)
	}
	g := newFixture(t)
	if st := g.get(t); st["bluetooth"] != nil {
		t.Fatal(st)
	}
}

// The sheet's requests (§2.4): checked here, passed on, the runtime's refusals with their codes.
func TestBluetoothRequests(t *testing.T) {
	f, fake := networkFixture(t)
	code, out := f.do("GET", "/api/bluetooth", "")
	if code != 200 || out["mayChange"] != false || out["why"] != "locked" {
		t.Fatal(code, out)
	}
	if devices := out["bluetooth"].(map[string]any)["devices"].([]any); len(devices) != 2 ||
		devices[0].(map[string]any)["address"] != "F4:7A:11:0B:32:C9" {
		t.Fatal(devices)
	}
	if code, _ := f.do("POST", "/api/bluetooth", "{}"); code != http.StatusMethodNotAllowed {
		t.Fatal(code)
	}
	if code, out := f.do("POST", "/api/bluetooth/scan", "{}"); code != 200 || len(out["scan"].(map[string]any)["devices"].([]any)) != 2 {
		t.Fatal(code, out)
	}
	if code, _ := f.do("GET", "/api/bluetooth/scan", ""); code != http.StatusMethodNotAllowed {
		t.Fatal(code)
	}
	code, out = f.do("POST", "/api/bluetooth/pair", `{"address":"7C:C3:A1:5D:9B:14"}`)
	if code != 200 || out["pairing"].(map[string]any)["phase"] != "pairing" {
		t.Fatal(code, out)
	}
	last := func() desktest.Call { c := fake.Calls(); return c[len(c)-1] }
	if c := last(); c.Path != desk.PathBluetoothPair || c.Body != `{"v":1,"address":"7C:C3:A1:5D:9B:14"}` {
		t.Fatal(c)
	}
	fake.Set(desk.PathBluetoothConfirm, desktest.Answer{Body: `{"v":1,"pairing":{"id":"p-0123abcd","address":"7C:C3:A1:5D:9B:14",
	  "name":"Magic Keyboard","kind":"keyboard","phase":"connecting","deadline":"2026-10-20T09:42:30Z"}}`})
	if code, _ := f.do("POST", "/api/bluetooth/confirm", `{"pairingId":"p-0123abcd","accept":true}`); code != 200 {
		t.Fatal(code)
	}
	if c := last(); c.Body != `{"v":1,"pairingId":"p-0123abcd","accept":true}` {
		t.Fatal(c.Body)
	}
	fake.Set(desk.PathBluetoothForget, desktest.Answer{Body: `{"v":1}`})
	if code, _ := f.do("POST", "/api/bluetooth/forget", `{"address":"F4:7A:11:0B:32:C9"}`); code != 200 {
		t.Fatal(code)
	}

	// Checked before the socket: nothing reaches the runtime.
	before := len(fake.Calls())
	for path, body := range map[string]string{
		"/api/bluetooth/pair":       `{"address":"7c:c3:a1:5d:9b:14"}`,
		"/api/bluetooth/connect":    `{"address":""}`,
		"/api/bluetooth/disconnect": `{}`,
		"/api/bluetooth/forget":     `{"address":"F4:7A:11:0B:32:C9\n"}`,
		"/api/bluetooth/confirm":    `{"pairingId":"p-0123abcd"}`,
		"/api/bluetooth/cancel":     `{"pairingId":"p-../../x"}`,
	} {
		if w := f.raw("POST", path, body); w.Code != 400 {
			t.Errorf("%s %s: %d %s", path, body, w.Code, w.Body.String())
		}
	}
	if code, _ := f.do("POST", "/api/bluetooth/pair", `{"address":"`+strings.Repeat("A", 1100)+`"}`); code != 413 {
		t.Fatal("1 KiB is the limit:", code)
	}
	if len(fake.Calls()) != before {
		t.Fatal("a refused request reached the runtime")
	}
	for path, a := range map[string]desktest.Answer{
		desk.PathBluetoothPair:    {Status: 409, Body: `{"error":{"code":"locked","message":"x"}}`},
		desk.PathBluetoothConnect: {Status: 404, Body: `{"error":{"code":"not_found","message":"x"}}`},
		desk.PathBluetoothCancel:  {Status: 503, Body: `{"error":{"code":"unavailable","message":"x"}}`},
	} {
		fake.Set(path, a)
	}
	for path, want := range map[string][2]any{
		"/api/bluetooth/pair":    {409, "locked"},
		"/api/bluetooth/connect": {404, "not_found"},
	} {
		w := f.raw("POST", path, `{"address":"7C:C3:A1:5D:9B:14"}`)
		var o map[string]any
		_ = json.Unmarshal(w.Body.Bytes(), &o)
		if w.Code != want[0] || o["message"] != want[1] {
			t.Errorf("%s: %d %v", path, w.Code, o)
		}
	}
	if code, out := f.do("POST", "/api/bluetooth/cancel", `{"pairingId":"p-0123abcd"}`); code != 503 || out["message"] != "unavailable" {
		t.Fatal(code, out)
	}
	// No socket: 503 `unavailable`; no desk at all: the routes don't exist.
	f.srv.WithDesk(desk.New("/nonexistent/desk.sock", os.Getuid(), nil, nil))
	if code, out := f.do("GET", "/api/bluetooth", ""); code != 503 || out["message"] != "unavailable" {
		t.Fatal(code, out)
	}
	g := newFixture(t)
	for _, req := range [][2]string{{"GET", "/api/bluetooth"}, {"POST", "/api/bluetooth/scan"}, {"POST", "/api/bluetooth/pair"},
		{"POST", "/api/bluetooth/confirm"}, {"POST", "/api/bluetooth/cancel"}, {"POST", "/api/bluetooth/connect"},
		{"POST", "/api/bluetooth/disconnect"}, {"POST", "/api/bluetooth/forget"}} {
		if code, _ := g.do(req[0], req[1], `{"address":"7C:C3:A1:5D:9B:14"}`); code != 404 {
			t.Errorf("%s %s without a desk: %d", req[0], req[1], code)
		}
	}
}
