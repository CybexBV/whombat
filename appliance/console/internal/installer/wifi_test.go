package installer

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// fakeWifi is the machine's Wi-Fi card: networks around it, a password per network, and what iwd stored.
type fakeWifi struct {
	mu        sync.Mutex
	missing   string
	connected string
	networks  []WifiNetwork
	passwords map[string]string // the right passphrase per network ("" open)
	joins     []string
	gate      chan struct{} // held open to keep a join running
	sys       *fakeSystem   // gets the network's address once joined
	profile   *WifiProfile  // what Profile returns (default: the joined network's)
}

func (w *fakeWifi) Status(context.Context) (WifiStatus, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	return WifiStatus{Missing: w.missing, Connected: w.connected}, nil
}

func (w *fakeWifi) Scan(context.Context) ([]WifiNetwork, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.networks, nil
}

func (w *fakeWifi) Join(ctx context.Context, ssid string, passphrase *string, hidden bool) error {
	w.mu.Lock()
	w.joins = append(w.joins, ssid)
	gate := w.gate
	want, known := w.passwords[ssid]
	w.mu.Unlock()
	if gate != nil {
		<-gate
	}
	if !known {
		return &JoinError{Failure: "not_found"}
	}
	if (passphrase == nil) != (want == "") || (passphrase != nil && *passphrase != want) {
		return &JoinError{Failure: "wrong_password"}
	}
	w.mu.Lock()
	w.connected = ssid
	w.mu.Unlock()
	w.sys.mu.Lock()
	w.sys.addr = "192.168.20.7"
	w.sys.mu.Unlock()
	return nil
}

func (w *fakeWifi) Profile(ssid string) (WifiProfile, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.profile != nil {
		return *w.profile, nil
	}
	return WifiProfile{Name: ssid + ".psk", Data: []byte("[Security]\nPassphrase=" + w.passwords[ssid] + "\n")}, nil
}

// A machine without a cable (the Z13 with its USB adapter unplugged) and a Wi-Fi card that sees three networks.
func wifiHarness(t *testing.T) (*harness, *fakeWifi) {
	t.Helper()
	sys := newFake()
	sys.addr, sys.wired = "", ""
	w := &fakeWifi{sys: sys, passwords: map[string]string{"Home": "correct horse battery", "Cafe": ""},
		networks: []WifiNetwork{
			{Ssid: "Home", Security: "psk", Signal: 4},
			{Ssid: "Cafe", Security: "open", Signal: 2},
			{Ssid: "Lumio", Security: "enterprise", Signal: 3},
			{Ssid: "Evil‮iwf", Security: "psk", Signal: 4},
			{Ssid: "Loud", Security: "psk", Signal: 9},
		}}
	hs := newHarness(t, sys)
	hs.srv.WithWifi(w)
	hs.srv.tmpDir = t.TempDir()
	return hs, w
}

// The Wi-Fi step is offered when no cable has an address (HD-08): `wired` is that fact, null before the first check.
func TestWired(t *testing.T) {
	hs := newHarness(t, newFake())
	if st := hs.srv.State(); st.Wired != nil {
		t.Fatalf("before the checks: %v", *st.Wired)
	}
	if st := hs.preflight(t); st.Wired == nil || !*st.Wired {
		t.Fatal("a cable with an address")
	}
	hs, _ = wifiHarness(t)
	st := hs.preflight(t)
	if st.Wired == nil || *st.Wired || checks(st)["network"].Status != "warn" {
		t.Fatalf("%+v", st)
	}
	b, _ := json.Marshal(st)
	if !strings.Contains(string(b), `"wired":false`) {
		t.Fatal(string(b))
	}

	sys := t.TempDir()
	for _, p := range []string{"enp0s20f0u2/device", "eth0/device", "wlan0/device", "wlan0/wireless", "wlp1s0/device", "wlp1s0/phy80211",
		"br0/bridge", "tailscale0"} {
		if err := os.MkdirAll(filepath.Join(sys, p), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	for name, want := range map[string]bool{"enp0s20f0u2": true, "eth0": true, "wlan0": false, "wlp1s0": false, "br0": false,
		"tailscale0": false, "missing": false} {
		if Wired(sys, name) != want {
			t.Errorf("%s: %v", name, !want)
		}
	}
}

// A machine without a Wi-Fi card: the page says so, scans and joins are refused.
func TestNoWifi(t *testing.T) {
	hs := newHarness(t, newFake())
	if code, out := hs.do("GET", "/api/wifi", ""); code != 200 || out["adapter"] != false || out["wifiMissing"] != "no_adapter" ||
		len(out["networks"].([]any)) != 0 {
		t.Fatal(code, out)
	}
	if code, out := hs.do("POST", "/api/wifi/scan", ""); code != 409 || out["message"] != "no_wifi" {
		t.Fatal(code, out)
	}
	if code, out := hs.do("POST", "/api/wifi/join", `{"ssid":"Home"}`); code != 409 || out["message"] != "no_wifi" {
		t.Fatal(code, out)
	}
	hs, w := wifiHarness(t)
	w.missing = "no_driver"
	if code, out := hs.do("GET", "/api/wifi", ""); code != 200 || out["adapter"] != false || out["wifiMissing"] != "no_driver" {
		t.Fatal(code, out)
	}
}

// Scan, a wrong password, the right one: joined, the checks again over it, and the profile into the installed system.
func TestWifiJoinAndInstall(t *testing.T) {
	hs, w := wifiHarness(t)
	hs.preflight(t)
	code, out := hs.do("GET", "/api/wifi", "")
	if code != 200 || out["adapter"] != true || len(out["networks"].([]any)) != 0 || out["connected"] != nil {
		t.Fatal(code, out)
	}
	code, out = hs.do("POST", "/api/wifi/scan", "")
	nets, _ := out["networks"].([]any)
	if code != 200 || len(nets) != 3 || nets[0].(map[string]any)["ssid"] != "Home" || nets[2].(map[string]any)["security"] != "enterprise" {
		t.Fatal(code, out)
	}
	if _, out := hs.do("GET", "/api/wifi", ""); len(out["networks"].([]any)) != 3 {
		t.Fatal("the scan wasn't kept", out)
	}

	// Checked before the card: a passphrase that can't be one, a name that isn't one.
	for body, want := range map[string]string{
		`{"ssid":"Home","passphrase":"short"}`:     "invalid_passphrase",
		`{"ssid":"Ho​me","passphrase":"12345678"}`: "bad_request",
		`{"ssid":""}`: "bad_request",
	} {
		if code, out := hs.do("POST", "/api/wifi/join", body); code != 400 || out["message"] != want {
			t.Errorf("%s: %d %v", body, code, out)
		}
	}
	if len(w.joins) != 0 {
		t.Fatal("a refused join reached the card")
	}
	if code, out := hs.do("POST", "/api/wifi/join", `{"ssid":"Home","passphrase":"wrong horse battery"}`); code != 200 ||
		out["failure"] != "wrong_password" || out["connected"] != nil {
		t.Fatal(code, out)
	}
	if code, out := hs.do("POST", "/api/wifi/join", `{"ssid":"Gone","hidden":true}`); code != 200 || out["failure"] != "not_found" {
		t.Fatal(code, out)
	}
	if hs.srv.joined != "" {
		t.Fatal("a failed join was kept")
	}
	if code, out := hs.do("POST", "/api/wifi/join", `{"ssid":"Home","passphrase":"correct horse battery"}`); code != 200 || out["connected"] != true {
		t.Fatal(code, out)
	}
	// The checks run again: the network passes over Wi-Fi; still no cable.
	waitFor(t, "the checks again", func() bool {
		st := hs.srv.State()
		return st.Preflight.Status == "done" && checks(st)["network"].Status == "ok"
	})
	st := hs.srv.State()
	if checks(st)["network"].Value != "192.168.20.7" || *st.Wired {
		t.Fatalf("%+v", st)
	}
	if _, out := hs.do("GET", "/api/wifi", ""); out["connected"] != "Home" {
		t.Fatal(out)
	}
	b, _ := json.Marshal(st)
	if strings.Contains(string(b), "horse") {
		t.Fatal("the passphrase is in the state")
	}

	if code, _ := hs.do("POST", "/api/install", `{"disk":"/dev/sda","confirm":"sda"}`); code != http.StatusAccepted {
		t.Fatal(code)
	}
	waitFor(t, "done", func() bool { return hs.srv.State().Install.Status == "done" })
	sys := hs.sys
	if len(sys.jobs) != 1 || filepath.Base(sys.jobs[0].WifiProfile) != "Home.psk" ||
		sys.profiles[0] != "[Security]\nPassphrase=correct horse battery\n" {
		t.Fatalf("%+v %q", sys.jobs, sys.profiles)
	}
	if _, err := os.Stat(filepath.Dir(sys.jobs[0].WifiProfile)); !os.IsNotExist(err) {
		t.Fatal("the profile's directory stayed", err)
	}
	if args := InstallArgs([]string{"--root-size", "40G"}, sys.jobs[0]); strings.Join(args[:5], " ") != "--root-size 40G --disk /dev/sda --yes-erase-disk" ||
		args[5] != "--wifi-profile" || args[6] != sys.jobs[0].WifiProfile {
		t.Fatal(args)
	}
	if args := InstallArgs(nil, Job{Disk: "/dev/sda"}); strings.Join(args, " ") != "--disk /dev/sda --yes-erase-disk" {
		t.Fatal(args)
	}
	// Once installed, the Wi-Fi stays as it is.
	if code, out := hs.do("POST", "/api/wifi/join", `{"ssid":"Cafe"}`); code != 409 || out["message"] != "busy" {
		t.Fatal(code, out)
	}
}

// Without a join nothing is copied; a profile that isn't one is a line in the log, and the install goes on.
func TestWifiProfileRefused(t *testing.T) {
	hs, _ := wifiHarness(t)
	hs.sys.wired = "10.0.0.5"
	hs.sys.addr = "10.0.0.5"
	hs.preflight(t)
	if code, _ := hs.do("POST", "/api/install", `{"disk":"/dev/sda","confirm":"sda"}`); code != http.StatusAccepted {
		t.Fatal(code)
	}
	waitFor(t, "done", func() bool { return hs.srv.State().Install.Status == "done" })
	if hs.sys.jobs[0].WifiProfile != "" {
		t.Fatal("copied a profile without a join")
	}

	hs, w := wifiHarness(t)
	hs.preflight(t)
	if _, out := hs.do("POST", "/api/wifi/join", `{"ssid":"Cafe"}`); out["connected"] != true {
		t.Fatal(out)
	}
	waitFor(t, "the checks again", func() bool { return hs.srv.State().Preflight.Status == "done" })
	w.profile = &WifiProfile{Name: "../../etc/shadow", Data: []byte("x")}
	if code, _ := hs.do("POST", "/api/install", `{"disk":"/dev/sda","confirm":"sda"}`); code != http.StatusAccepted {
		t.Fatal(code)
	}
	waitFor(t, "done", func() bool { return hs.srv.State().Install.Status == "done" })
	st := hs.srv.State()
	if hs.sys.jobs[0].WifiProfile != "" || !strings.Contains(strings.Join(st.Install.Log, "\n"), "Wi-Fi network couldn’t be copied") {
		t.Fatalf("%+v %q", hs.sys.jobs, st.Install.Log)
	}
	for name, ok := range map[string]bool{"Home.psk": true, "Lumio Guest.open": true, "=4361666520e2989520.psk": true,
		"Home.8021x": false, ".psk": false, "a/b.psk": false, "=XY.psk": false} {
		if profileNameRe.MatchString(name) != ok {
			t.Errorf("%q: %v", name, !ok)
		}
	}
}

// One join at a time.
func TestWifiBusy(t *testing.T) {
	hs, w := wifiHarness(t)
	w.gate = make(chan struct{})
	done := make(chan map[string]any)
	go func() {
		_, out := hs.do("POST", "/api/wifi/join", `{"ssid":"Cafe"}`)
		done <- out
	}()
	waitFor(t, "the first join", func() bool { w.mu.Lock(); defer w.mu.Unlock(); return len(w.joins) == 1 })
	if code, out := hs.do("POST", "/api/wifi/join", `{"ssid":"Home","passphrase":"correct horse battery"}`); code != 409 || out["message"] != "busy" {
		t.Fatal(code, out)
	}
	if err := hs.srv.StartInstall(InstallRequest{Disk: "/dev/sda", Confirm: "sda"}); err != ErrBusy {
		t.Fatalf("install raced Wi-Fi join: %v", err)
	}
	close(w.gate)
	if out := <-done; out["connected"] != true {
		t.Fatal(out)
	}
}
