package consoleapi

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"strings"
	"testing"

	"github.com/CybexBV/whombat/appliance/console/internal/desk"
	"github.com/CybexBV/whombat/appliance/console/internal/desk/desktest"
)

func networkFixture(t *testing.T) (*fixture, *desktest.Fake) {
	t.Helper()
	fake := desktest.Start(t)
	f := newFixture(t)
	f.srv.WithDesk(desk.New(fake.Socket, os.Getuid(), nil, t.Logf))
	f.writeState(t, `{"v":1,"state":"claimed","url":"https://app.whombat.com/claim"}`)
	return f, fake
}

// /api/state's `network` (§2.6): what the chip shows, from the same answer as /api/network.
func TestNetworkSummary(t *testing.T) {
	f, fake := networkFixture(t)
	n, _ := f.get(t)["network"].(map[string]any)
	if n == nil || n["online"] != true || n["via"] != "wifi" || n["ssid"] != "Home" {
		t.Fatalf("%v", n)
	}
	for name, tc := range map[string]struct {
		network string
		want    NetworkSummary
	}{
		"cable wins": {`{"online":true,"checkedAt":null,"wired":[{"interface":"eth0","connected":true,"address":"10.0.0.2"}],
		  "wifi":{"interface":"wlan0","state":"connected","ssid":"Home","signal":3,"saved":[]},"change":null}`,
			NetworkSummary{Online: true, Via: "cable"}},
		"connecting": {`{"online":false,"checkedAt":null,"wired":[{"interface":"eth0","connected":false}],
		  "wifi":{"interface":"wlan0","state":"connecting","ssid":"Home","saved":[]},"change":null}`,
			NetworkSummary{Via: "none"}},
		"no card": {`{"online":false,"checkedAt":null,"wired":[],"wifi":null,"wifiMissing":"no_adapter","change":null}`,
			NetworkSummary{Via: "none", WifiMissing: "no_adapter"}},
	} {
		a, err := desk.ParseNetworkAnswer([]byte(`{"v":1,"network":` + tc.network + `,"mayChange":true}`))
		if err != nil {
			t.Fatal(name, err)
		}
		if got := Summary(a); *got != tc.want {
			t.Errorf("%s: %+v", name, got)
		}
	}
	// The runtime without the network (an older one: 404), or away: null, the rest as before.
	fake.Set(desk.PathNetwork, desktest.Answer{Status: 404, Body: `{"error":{"code":"not_found","message":"x"}}`})
	f.srv.WithDesk(desk.New(fake.Socket, os.Getuid(), nil, t.Logf))
	if st := f.get(t); st["network"] != nil || st["desk"] == nil {
		t.Fatalf("%v", st)
	}
}

// `--once --json` prints State, the same as GET /api/state (the console check and the kiosk read either).
func TestOnceAgrees(t *testing.T) {
	f, _ := networkFixture(t)
	once, _ := json.Marshal(f.srv.State(context.Background()))
	w := f.raw("GET", "/api/state", "")
	if strings.TrimSpace(w.Body.String()) != string(once) {
		t.Fatalf("--once --json %s\n/api/state %s", once, w.Body.String())
	}
	var st map[string]any
	_ = json.Unmarshal(once, &st)
	if _, ok := st["network"]; !ok {
		t.Fatal("no network in --once --json")
	}
	// Without a desk socket, `network` is null in both.
	g := newFixture(t)
	once, _ = json.Marshal(g.srv.State(context.Background()))
	if !strings.Contains(string(once), `"network":null`) || strings.TrimSpace(g.raw("GET", "/api/state", "").Body.String()) != string(once) {
		t.Fatal(string(once))
	}
}

// The sheet's requests (§2.6): checked here, passed on, the runtime's refusals with their codes.
func TestNetworkRequests(t *testing.T) {
	f, fake := networkFixture(t)
	code, out := f.do("GET", "/api/network", "")
	if code != 200 || out["mayChange"] != false || out["why"] != "locked" {
		t.Fatal(code, out)
	}
	if wifi := out["network"].(map[string]any)["wifi"].(map[string]any); wifi["ssid"] != "Home" || wifi["signal"] != float64(4) {
		t.Fatal(wifi)
	}
	if code, _ := f.do("POST", "/api/network", "{}"); code != http.StatusMethodNotAllowed {
		t.Fatal(code)
	}
	if code, out := f.do("POST", "/api/network/wifi/scan", ""); code != 200 || len(out["scan"].(map[string]any)["networks"].([]any)) != 3 {
		t.Fatal(code, out)
	}
	if code, _ := f.do("GET", "/api/network/wifi/scan", ""); code != http.StatusMethodNotAllowed {
		t.Fatal(code)
	}

	fake.Set(desk.PathWifiJoin, desktest.Answer{Body: desktest.Joining})
	code, out = f.do("POST", "/api/network/wifi/join", `{"ssid":"Office","passphrase":"correct horse battery"}`)
	if code != 200 || out["change"].(map[string]any)["phase"] != "applying" {
		t.Fatal(code, out)
	}
	if last := fake.Calls()[len(fake.Calls())-1]; last.Body != `{"v":1,"ssid":"Office","passphrase":"correct horse battery"}` {
		t.Fatal(last.Body)
	}
	// Checked before the socket: nothing reaches the runtime, and the passphrase isn't in the answer.
	before := len(fake.Calls())
	for body, want := range map[string]string{
		`{"ssid":"Office","passphrase":"short"}`:     "invalid_passphrase",
		`{"ssid":"Off‮ice","passphrase":"12345678"}`: "bad_request",
		`{"ssid":""}`: "bad_request",
	} {
		w := f.raw("POST", "/api/network/wifi/join", body)
		var o map[string]any
		_ = json.Unmarshal(w.Body.Bytes(), &o)
		if w.Code != 400 || o["message"] != want || strings.Contains(w.Body.String(), "short") {
			t.Errorf("%s: %d %s", body, w.Code, w.Body.String())
		}
	}
	if code, _ := f.do("POST", "/api/network/wifi/join", `{"ssid":"`+strings.Repeat("x", 1100)+`"}`); code != 413 {
		t.Fatal("1 KiB is the limit:", code)
	}
	if code, _ := f.do("POST", "/api/network/wifi/join", `not json`); code != 400 {
		t.Fatal(code)
	}
	if len(fake.Calls()) != before {
		t.Fatal("a refused request reached the runtime")
	}
	for path, a := range map[string]desktest.Answer{
		desk.PathWifiJoin:   {Status: 409, Body: `{"error":{"code":"locked","message":"x"}}`},
		desk.PathWifiForget: {Status: 404, Body: `{"error":{"code":"not_saved","message":"x"}}`},
	} {
		fake.Set(path, a)
	}
	if code, out := f.do("POST", "/api/network/wifi/join", `{"ssid":"Office"}`); code != 409 || out["message"] != "locked" {
		t.Fatal(code, out)
	}
	if code, out := f.do("POST", "/api/network/wifi/forget", `{"ssid":"Office"}`); code != 404 || out["message"] != "not_saved" {
		t.Fatal(code, out)
	}
	// No socket: 503 `unavailable`; no desk at all: the routes don't exist.
	f.srv.WithDesk(desk.New("/nonexistent/desk.sock", os.Getuid(), nil, nil))
	if code, out := f.do("GET", "/api/network", ""); code != 503 || out["message"] != "unavailable" {
		t.Fatal(code, out)
	}
	g := newFixture(t)
	for _, req := range [][2]string{{"GET", "/api/network"}, {"POST", "/api/network/wifi/scan"}, {"POST", "/api/network/wifi/join"},
		{"POST", "/api/network/wifi/forget"}} {
		if code, _ := g.do(req[0], req[1], `{"ssid":"Office"}`); code != 404 {
			t.Errorf("%s %s without a desk: %d", req[0], req[1], code)
		}
	}
}
