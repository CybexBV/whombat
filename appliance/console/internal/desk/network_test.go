package desk_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/console/internal/desk"
	"github.com/CybexBV/whombat/appliance/console/internal/desk/desktest"
)

// The network is the runtime's answer, checked, asked at most every 2 s (a failure too), and asked again after a join.
func TestNetworkCache(t *testing.T) {
	f := desktest.Start(t)
	c, ck := newClient(t, f)
	ctx := context.Background()
	a, err := c.Network(ctx)
	if err != nil || a.MayChange || a.Why == nil || *a.Why != "locked" || a.Network.Wifi == nil || *a.Network.Wifi.Ssid != "Home" ||
		*a.Network.Wifi.Signal != 4 || len(a.Network.Wifi.Saved) != 2 || len(a.Network.Wired) != 1 || a.Network.Wired[0].Connected {
		t.Fatalf("%+v %v", a, err)
	}
	ck.add(1900 * time.Millisecond)
	_, _ = c.Network(ctx)
	if n := f.CallsTo(desk.PathNetwork); n != 1 {
		t.Fatalf("asked %d times within 2 s", n)
	}
	ck.add(200 * time.Millisecond)
	_, _ = c.Network(ctx)
	if n := f.CallsTo(desk.PathNetwork); n != 2 {
		t.Fatalf("asked %d times after 2 s", n)
	}
	f.Set(desk.PathWifiJoin, desktest.Answer{Body: desktest.Joining})
	if _, err := c.WifiJoin(ctx, "Office", nil, false); err != nil {
		t.Fatal(err)
	}
	_, _ = c.Network(ctx)
	if n := f.CallsTo(desk.PathNetwork); n != 3 {
		t.Fatalf("not asked again after a join: %d", n)
	}
	// A refusal is kept for the 2 s as well, and passed on as the runtime's.
	f.Set(desk.PathNetwork, desktest.Answer{Status: 503, Body: `{"error":{"code":"unavailable","message":"x"}}`})
	ck.add(3 * time.Second)
	_, err = c.Network(ctx)
	var de *desk.Error
	if !errors.As(err, &de) || de.Status != 503 || de.Code != "unavailable" {
		t.Fatal(err)
	}
	_, _ = c.Network(ctx)
	if n := f.CallsTo(desk.PathNetwork); n != 4 {
		t.Fatalf("a refusal wasn't kept: %d", n)
	}
}

func networkAnswer(network string, may string) string {
	return `{"v":1,"network":` + network + `,` + may + `}`
}

const locked = `"mayChange":false,"why":"locked"`

// What the runtime sends is the contract's or nothing; names that aren't displayable never reach the page, other
// display strings are cleaned.
func TestParseNetwork(t *testing.T) {
	wifi := func(inner string) string {
		return `{"online":false,"checkedAt":null,"wired":[],"wifi":{"interface":"wlan0",` + inner + `},"change":null}`
	}
	for name, tc := range map[string]struct {
		doc string
		ok  bool
	}{
		"minimal":           {networkAnswer(`{"online":false,"checkedAt":null,"wired":[],"wifi":null,"change":null}`, `"mayChange":true`), true},
		"no adapter":        {networkAnswer(`{"online":false,"checkedAt":null,"wired":[],"wifi":null,"wifiMissing":"no_driver","change":null}`, `"mayChange":true`), true},
		"missing and card":  {networkAnswer(`{"online":false,"checkedAt":null,"wired":[],"wifi":{"interface":"wlan0","state":"disconnected","saved":[]},"wifiMissing":"no_driver","change":null}`, `"mayChange":true`), false},
		"unknown missing":   {networkAnswer(`{"online":false,"checkedAt":null,"wired":[],"wifi":null,"wifiMissing":"broken","change":null}`, `"mayChange":true`), false},
		"why without lock":  {networkAnswer(`{"online":true,"checkedAt":null,"wired":[],"wifi":null,"change":null}`, `"mayChange":true,"why":"locked"`), false},
		"lock without why":  {networkAnswer(`{"online":true,"checkedAt":null,"wired":[],"wifi":null,"change":null}`, `"mayChange":false`), false},
		"other why":         {networkAnswer(`{"online":true,"checkedAt":null,"wired":[],"wifi":null,"change":null}`, `"mayChange":false,"why":"nope"`), false},
		"version 2":         {strings.Replace(networkAnswer(`{"online":true,"checkedAt":null,"wired":[],"wifi":null,"change":null}`, locked), `"v":1`, `"v":2`, 1), false},
		"bad checkedAt":     {networkAnswer(`{"online":true,"checkedAt":"yesterday","wired":[],"wifi":null,"change":null}`, locked), false},
		"connected no ssid": {networkAnswer(wifi(`"state":"connected","saved":[]`), locked), false},
		"disconnected ssid": {networkAnswer(wifi(`"state":"disconnected","ssid":"Home","saved":[]`), locked), false},
		"signal connecting": {networkAnswer(wifi(`"state":"connecting","ssid":"Home","signal":3,"saved":[]`), locked), false},
		"signal 5":          {networkAnswer(wifi(`"state":"connected","ssid":"Home","signal":5,"saved":[]`), locked), false},
		"state unknown":     {networkAnswer(wifi(`"state":"roaming","saved":[]`), locked), false},
		"security unknown":  {networkAnswer(wifi(`"state":"disconnected","saved":[{"ssid":"A","security":"wep"}]`), locked), false},
		"not json":          {`<html>`, false},
	} {
		_, err := desk.ParseNetworkAnswer([]byte(tc.doc))
		if (err == nil) != tc.ok {
			t.Errorf("%s: %v", name, err)
		}
	}

	// Anything the contract refuses (control or format characters, an address that isn't one) refuses the answer.
	hostile := networkAnswer(`{"online":true,"checkedAt":null,"wired":[{"interface":"enp\u001b[2J1s0","connected":true}],
	  "wifi":null,"change":null}`, locked)
	if _, err := desk.ParseNetworkAnswer([]byte(hostile)); err == nil {
		t.Error("an interface with an escape was taken")
	}
	for name, ch := range map[string]string{
		"failure while applying": `{"id":"c-0123abcd","kind":"join","ssid":"A","phase":"applying","deadline":"2026-10-20T09:43:00Z","failure":"failed"}`,
		"failed without failure": `{"id":"c-0123abcd","kind":"join","ssid":"A","phase":"failed","deadline":"2026-10-20T09:43:00Z"}`,
		"bad id":                 `{"id":"x","kind":"join","ssid":"A","phase":"applying","deadline":"2026-10-20T09:43:00Z"}`,
		"bad name":               `{"id":"c-0123abcd","kind":"join","ssid":"\u0007","phase":"applying","deadline":"2026-10-20T09:43:00Z"}`,
	} {
		if _, err := desk.ParseNetworkAnswer([]byte(networkAnswer(`{"online":true,"checkedAt":null,"wired":[],"wifi":null,"change":`+ch+`}`, locked))); err == nil {
			t.Errorf("%s: taken", name)
		}
	}

	// What the schema can't say is cleaned: names over 32 bytes (17 é are 17 code points but 34 bytes) leave the lists,
	// blank interface names go, the rest is trimmed.
	long := strings.Repeat("é", 17)
	doc := networkAnswer(`{"online":true,"checkedAt":"2026-10-20T09:40:30Z",
	  "wired":[{"interface":" eth0 ","connected":true,"address":"192.168.1.9"},{"interface":"   ","connected":false}],
	  "wifi":{"interface":"wlan0","state":"connected","ssid":"`+long+`","signal":2,"address":"fe80::1",
	   "saved":[{"ssid":"Home","security":"psk"},{"ssid":"`+long+`","security":"open"}]},
	  "change":{"id":"c-0123abcd","kind":"join","ssid":"Office","phase":"reverted","deadline":"2026-10-20T09:43:00Z",
	   "previous":"`+long+`","failure":"no_internet"}}`, `"mayChange":true`)
	a, err := desk.ParseNetworkAnswer([]byte(doc))
	if err != nil {
		t.Fatal(err)
	}
	n := a.Network
	if len(n.Wired) != 1 || n.Wired[0].Interface != "eth0" || *n.Wired[0].Address != "192.168.1.9" {
		t.Errorf("wired %+v", n.Wired)
	}
	if n.Wifi.Ssid != nil || *n.Wifi.Address != "fe80::1" || len(n.Wifi.Saved) != 1 || n.Wifi.Saved[0].Ssid != "Home" {
		t.Errorf("wifi %+v", n.Wifi)
	}
	if c := n.Change; c == nil || c.Phase != "reverted" || c.Previous != nil || *c.Failure != "no_internet" {
		t.Errorf("change %+v", n.Change)
	}
	doc = networkAnswer(`{"online":true,"checkedAt":null,"wired":[],"wifi":null,
	  "change":{"id":"c-0123abcd","kind":"join","ssid":"`+long+`","phase":"applying","deadline":"2026-10-20T09:43:00Z"}}`, locked)
	if a, err := desk.ParseNetworkAnswer([]byte(doc)); err != nil || a.Network.Change != nil {
		t.Errorf("a change naming a network over 32 bytes: %+v %v", a, err)
	}
}

func TestSsidAndPassphrase(t *testing.T) {
	for s, want := range map[string]bool{"Home": true, "Lumio Guest": true, "Café ☕": true, strings.Repeat("a", 32): true,
		strings.Repeat("é", 16): true, strings.Repeat("é", 17): false, "": false, "a​b": false, "a b": false,
		"a\tb": false, "\xff": false} {
		if desk.SsidValid(s) != want {
			t.Errorf("ssid %q: %v", s, !want)
		}
	}
	for p, want := range map[string]bool{"12345678": true, "correct horse battery": true, strings.Repeat("x", 63): true,
		strings.Repeat("x", 64): false, strings.Repeat("aF0", 21) + "a": true, "1234567": false, "pässword": false, "pass\nword": false} {
		if desk.PassphraseValid(p) != want {
			t.Errorf("passphrase %q: %v", p, !want)
		}
	}
}

// The scan: what the runtime found, names that aren't displayable left out, anything else wrong refused.
func TestWifiScan(t *testing.T) {
	f := desktest.Start(t)
	c, _ := newClient(t, f)
	ctx := context.Background()
	a, err := c.WifiScan(ctx)
	if err != nil || len(a.Scan.Networks) != 3 || a.Scan.Networks[0].Ssid != "Home" || a.Scan.Networks[2].Security != "enterprise" {
		t.Fatalf("%+v %v", a, err)
	}
	if calls := f.Calls(); calls[len(calls)-1].Method != http.MethodPost || calls[len(calls)-1].Body != `{"v":1}` {
		t.Fatalf("%+v", calls)
	}
	f.Set(desk.PathWifiScan, desktest.Answer{Body: `{"v":1,"scan":{"scannedAt":"2026-10-20T09:41:00Z","networks":[
	  {"ssid":"` + strings.Repeat("é", 17) + `","security":"psk","signal":4,"saved":false,"connected":false},
	  {"ssid":"Fine","security":"open","signal":1,"saved":false,"connected":false}]}}`})
	if a, err = c.WifiScan(ctx); err != nil || len(a.Scan.Networks) != 1 || a.Scan.Networks[0].Ssid != "Fine" {
		t.Fatalf("%+v %v", a, err)
	}
	for _, bad := range []string{
		`{"v":1,"scan":{"scannedAt":"2026-10-20T09:41:00Z","networks":[{"ssid":"A","security":"psk","signal":7,"saved":false,"connected":false}]}}`,
		`{"v":1,"scan":{"scannedAt":"2026-10-20T09:41:00Z","networks":[{"ssid":"A","security":"wpa","signal":2,"saved":false,"connected":false}]}}`,
		`{"v":1,"scan":{"scannedAt":"now","networks":[]}}`,
		`{"v":1,"scan":{"scannedAt":"2026-10-20T09:41:00Z","networks":[{"ssid":"\u202eEvil","security":"psk","signal":2,"saved":false,"connected":false}]}}`,
	} {
		f.Set(desk.PathWifiScan, desktest.Answer{Body: bad})
		var de *desk.Error
		if _, err := c.WifiScan(ctx); !errors.As(err, &de) || de.Code != "failed" {
			t.Errorf("%s: %v", bad, err)
		}
	}
	f.Set(desk.PathWifiScan, desktest.Answer{Status: 409, Body: `{"error":{"code":"no_wifi","message":"x"}}`})
	var de *desk.Error
	if _, err := c.WifiScan(ctx); !errors.As(err, &de) || de.Status != 409 || de.Code != desk.ErrorNoWifi {
		t.Fatal(err)
	}
}

type logs struct {
	mu    sync.Mutex
	lines []string
}

func (l *logs) logf(format string, args ...any) {
	l.mu.Lock()
	l.lines = append(l.lines, fmt.Sprintf(format, args...))
	l.mu.Unlock()
}

// Join and forget: built here from checked fields; the runtime's refusals pass on; the passphrase reaches the runtime
// and nothing else.
func TestWifiJoinForget(t *testing.T) {
	f := desktest.Start(t)
	var l logs
	c := desk.New(f.Socket, os.Getuid(), nil, l.logf)
	ctx := context.Background()
	f.Set(desk.PathWifiJoin, desktest.Answer{Body: desktest.Joining})
	pass := "correct horse battery"
	a, err := c.WifiJoin(ctx, "Office", &pass, false)
	if err != nil || a.Change.ID != "c-0123abcd" || a.Change.Phase != "applying" || *a.Change.Previous != "Home" {
		t.Fatalf("%+v %v", a, err)
	}
	last := f.Calls()[len(f.Calls())-1]
	var sent map[string]any
	_ = json.Unmarshal([]byte(last.Body), &sent)
	if last.Path != desk.PathWifiJoin || sent["v"] != float64(1) || sent["ssid"] != "Office" || sent["passphrase"] != pass || len(sent) != 3 {
		t.Fatalf("%s", last.Body)
	}
	if _, err := c.WifiJoin(ctx, "Hidden one", nil, true); err != nil {
		t.Fatal(err)
	}
	if last := f.Calls()[len(f.Calls())-1]; last.Body != `{"v":1,"ssid":"Hidden one","hidden":true}` {
		t.Fatalf("%s", last.Body)
	}
	before := len(f.Calls())
	short := "short"
	for name, call := range map[string]func() error{
		"bad name":      func() error { _, err := c.WifiJoin(ctx, "a‮b", nil, false); return err },
		"long name":     func() error { _, err := c.WifiJoin(ctx, strings.Repeat("x", 33), nil, false); return err },
		"short pass":    func() error { _, err := c.WifiJoin(ctx, "Office", &short, false); return err },
		"forget a name": func() error { _, err := c.WifiForget(ctx, ""); return err },
	} {
		var de *desk.Error
		if err := call(); !errors.As(err, &de) || de.Status != 400 {
			t.Errorf("%s: %v", name, err)
		}
	}
	if len(f.Calls()) != before {
		t.Fatal("a refused request reached the runtime")
	}
	f.Set(desk.PathWifiJoin, desktest.Answer{Status: 409, Body: `{"error":{"code":"locked","message":"x"}}`})
	var de *desk.Error
	if _, err := c.WifiJoin(ctx, "Office", &pass, false); !errors.As(err, &de) || de.Status != 409 || de.Code != "locked" {
		t.Fatal(err)
	}
	f.Set(desk.PathWifiForget, desktest.Answer{Status: 409, Body: `{"error":{"code":"in_use","message":"x"}}`})
	if _, err := c.WifiForget(ctx, "Home"); !errors.As(err, &de) || de.Code != "in_use" {
		t.Fatal(err)
	}
	f.Set(desk.PathWifiForget, desktest.Answer{Body: `{"v":1,"change":{"id":"c-0123abce","kind":"forget","ssid":"Office","phase":"applying","deadline":"2026-10-20T09:43:00Z"}}`})
	if a, err := c.WifiForget(ctx, "Office"); err != nil || a.Change.Kind != "forget" {
		t.Fatal(a, err)
	}
	if last := f.Calls()[len(f.Calls())-1]; last.Body != `{"v":1,"ssid":"Office"}` {
		t.Fatal(last.Body)
	}
	// An answer that isn't a change is the console's 502.
	f.Set(desk.PathWifiJoin, desktest.Answer{Body: `{"v":1,"change":{"id":"c-0123abcd","kind":"join","ssid":"Office","phase":"failed","deadline":"2026-10-20T09:43:00Z"}}`})
	if _, err := c.WifiJoin(ctx, "Office", nil, false); !errors.As(err, &de) || de.Status != 502 {
		t.Fatal(err)
	}
	// The runtime away: nothing in the log but that.
	f.Set(desk.PathNetwork, desktest.Answer{Status: 500})
	_, _ = c.Network(ctx)
	l.mu.Lock()
	defer l.mu.Unlock()
	for _, line := range l.lines {
		if strings.Contains(line, pass) {
			t.Fatalf("the passphrase is in the log: %q", line)
		}
	}
	if s := fmt.Sprint(desk.WifiJoinRequest{V: 1, Ssid: "Office", Passphrase: &pass}); strings.Contains(s, pass) {
		t.Fatalf("formatted: %s", s)
	}
}
