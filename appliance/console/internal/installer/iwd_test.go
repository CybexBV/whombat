package installer

import (
	"context"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/helper/pkg/wifi"
)

// An office around a Z13: the networks iwd's fake finds, each with what it takes.
func iwdFake(t *testing.T) (*IWD, *wifi.Fake) {
	t.Helper()
	f := &wifi.Fake{Dir: t.TempDir(), InRange: []wifi.FakeNetwork{
		{SSID: "Home", Security: wifi.SecurityPSK, SignalDBm: -48, Password: "correct horse battery"},
		{SSID: "Lumio Guest", Security: wifi.SecurityOpen, SignalDBm: -70},
		{SSID: "Lumio", Security: wifi.SecurityEAP, SignalDBm: -60},
		{SSID: "Printer", Security: wifi.SecurityWEP, SignalDBm: -88},
		{SSID: "Burrow 5G", Security: wifi.SecurityPSK, SignalDBm: -66, Password: "hidden burrow", Hidden: true},
	}}
	return &IWD{Client: f, Dir: f.Dir, Address: func(string) string { return "192.168.20.7" }}, f
}

func TestIWDStatus(t *testing.T) {
	ctx := context.Background()
	w, f := iwdFake(t)
	if st, err := w.Status(ctx); err != nil || st.Missing != "" || st.Connected != "" {
		t.Fatal(st, err)
	}
	f.ConnectTo("Home")
	if st, _ := w.Status(ctx); st.Connected != "Home" {
		t.Fatal(st)
	}
	f.Unpowered = true
	if st, _ := w.Status(ctx); st.Missing != "disabled" {
		t.Fatal(st)
	}
	f.Unpowered, f.NoStation = false, true
	if st, _ := w.Status(ctx); st.Missing != "no_driver" {
		t.Fatal(st)
	}
	f.NoIwd = true
	if _, err := w.Status(ctx); !errors.Is(err, wifi.ErrNoIwd) {
		t.Fatal(err)
	}
	if missing := func() string { _, m := station(&wifi.Status{}); return m }(); missing != "no_adapter" {
		t.Fatal(missing)
	}
}

// A scan in the contracts' words; joins as iwd answers them, and the profile iwd wrote is the one the install copies.
func TestIWDScanJoinProfile(t *testing.T) {
	ctx := context.Background()
	w, f := iwdFake(t)
	nets, err := w.Scan(ctx)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]WifiNetwork{}
	for _, n := range nets {
		got[n.Ssid] = n
	}
	if len(nets) != 4 || nets[0].Ssid != "Home" || got["Home"].Signal != 4 || got["Home"].Security != "psk" ||
		got["Lumio Guest"].Security != "open" || got["Lumio"].Security != "enterprise" || got["Printer"].Security != "other" ||
		got["Printer"].Signal != 0 {
		t.Fatalf("%+v", nets)
	}
	wrong := "wrong horse battery"
	var je *JoinError
	if err := w.Join(ctx, "Home", &wrong, false); !errors.As(err, &je) || je.Failure != "wrong_password" {
		t.Fatal(err)
	}
	if entries, _ := os.ReadDir(f.Dir); len(entries) != 0 {
		t.Fatalf("a wrong password left %v", entries)
	}
	if _, err := w.Profile("Home"); err == nil {
		t.Fatal("a profile without a join")
	}
	if err := w.Join(ctx, "Gone", nil, false); !errors.As(err, &je) || je.Failure != "not_found" {
		t.Fatal(err)
	}
	if err := w.Join(ctx, "Lumio", nil, false); !errors.As(err, &je) || je.Failure != "failed" {
		t.Fatal(err)
	}
	right := "correct horse battery"
	if err := w.Join(ctx, "Home", &right, false); err != nil {
		t.Fatal(err)
	}
	p, err := w.Profile("Home")
	want, _ := os.ReadFile(filepath.Join(f.Dir, "Home.psk"))
	if err != nil || p.Name != "Home.psk" || len(want) == 0 || string(p.Data) != string(want) || !profileNameRe.MatchString(p.Name) {
		t.Fatalf("%q %q %v", p.Name, p.Data, err)
	}
	// A hidden network by name, and an open one.
	hidden := "hidden burrow"
	if err := w.Join(ctx, "Burrow 5G", &hidden, true); err != nil {
		t.Fatal(err)
	}
	if p, err := w.Profile("Burrow 5G"); err != nil || p.Name != "Burrow 5G.psk" {
		t.Fatal(p.Name, err)
	}
	if err := w.Join(ctx, "Lumio Guest", nil, false); err != nil {
		t.Fatal(err)
	}
	if p, err := w.Profile("Lumio Guest"); err != nil || p.Name != "Lumio Guest.open" {
		t.Fatal(p.Name, err)
	}
}

// The server over iwd's fake: the Wi-Fi step's whole path to the install's profile.
func TestIWDInstall(t *testing.T) {
	sys := newFake()
	sys.wired = "" // no cable; the Wi-Fi's address (the fake system has one already)
	w, f := iwdFake(t)
	hs := newHarness(t, sys)
	hs.srv.WithWifi(w)
	hs.srv.tmpDir = t.TempDir()
	if st := hs.preflight(t); *st.Wired {
		t.Fatal("wired")
	}
	if code, out := hs.do("POST", "/api/wifi/scan", ""); code != 200 || len(out["networks"].([]any)) != 4 {
		t.Fatal(code, out)
	}
	if _, out := hs.do("POST", "/api/wifi/join", `{"ssid":"Home","passphrase":"wrong horse battery"}`); out["failure"] != "wrong_password" {
		t.Fatal(out)
	}
	if _, out := hs.do("POST", "/api/wifi/join", `{"ssid":"Home","passphrase":"correct horse battery"}`); out["connected"] != true {
		t.Fatal(out)
	}
	if ssid, _ := f.ConnectedTo(); ssid != "Home" {
		t.Fatal(ssid)
	}
	if _, out := hs.do("GET", "/api/wifi", ""); out["connected"] != "Home" {
		t.Fatal(out)
	}
	waitFor(t, "the checks again", func() bool { return hs.srv.State().Preflight.Status == "done" })
	if code, _ := hs.do("POST", "/api/install", `{"disk":"/dev/sda","confirm":"sda"}`); code != http.StatusAccepted {
		t.Fatal(code)
	}
	waitFor(t, "done", func() bool { return hs.srv.State().Install.Status == "done" })
	want, _ := os.ReadFile(filepath.Join(f.Dir, "Home.psk"))
	if len(sys.profiles) != 1 || sys.profiles[0] != string(want) || !strings.HasSuffix(sys.jobs[0].WifiProfile, "/Home.psk") {
		t.Fatalf("%+v %q", sys.jobs, sys.profiles)
	}
}

func TestIWDWaitsForTheJoinedCardsAddress(t *testing.T) {
	w, _ := iwdFake(t)
	w.Poll = time.Millisecond
	calls := 0
	w.Address = func(iface string) string {
		if iface != "wlan0" {
			t.Fatalf("waited on %s", iface)
		}
		calls++
		if calls < 3 {
			return ""
		}
		return "192.168.20.7"
	}
	password := "correct horse battery"
	if err := w.Join(context.Background(), "Home", &password, false); err != nil || calls < 3 {
		t.Fatal(err, calls)
	}
	ctx, cancel := context.WithCancel(context.Background())
	w.Address = func(string) string { cancel(); return "" }
	var je *JoinError
	if err := w.Join(ctx, "Home", &password, false); !errors.As(err, &je) || je.Failure != "no_address" {
		t.Fatal(err)
	}
}
