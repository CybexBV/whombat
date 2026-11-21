package broker_test

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/helper/helpertest"
	"github.com/CybexBV/whombat/appliance/helper/pkg/wifi"
	"github.com/CybexBV/whombat/appliance/manager/internal/broker"
	"github.com/CybexBV/whombat/appliance/manager/internal/helperclient"
	"github.com/CybexBV/whombat/appliance/manager/internal/netguard"
	"github.com/CybexBV/whombat/contracts/go/local"
)

type reach struct{}

func (reach) Check(context.Context) error { return nil }

type nolock struct{}

func (nolock) AcquireLock(string, string, time.Duration) error { return nil }
func (nolock) ReleaseLock(string) error                        { return nil }

// startNet serves the broker with a network guard over an in-process helper whose Wi-Fi is a fake: on "Office", "Home"
// and "Cafe" in range.
func startNet(t *testing.T, runtimeUID uint32, withNet bool) (string, *wifi.Fake) {
	t.Helper()
	d, err := os.MkdirTemp("", "bn") // a short path: sockets
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(d) })
	f := &wifi.Fake{Dir: filepath.Join(d, "iwd"), InRange: []wifi.FakeNetwork{
		{SSID: "Office", Security: wifi.SecurityPSK, SignalDBm: -60, Password: "office-pass-1"},
		{SSID: "Home", Security: wifi.SecurityPSK, SignalDBm: -50, Password: "home-pass-22"},
		{SSID: "Cafe", Security: wifi.SecurityOpen, SignalDBm: -70},
	}}
	os.MkdirAll(f.Dir, 0o700)
	f.Save("Office", wifi.SecurityPSK, "office-pass-1", false)
	f.ConnectTo("Office")
	s := &broker.Server{RuntimeUID: runtimeUID}
	if withNet {
		h, err := helpertest.Start(helpertest.Config{DeviceID: "dev-1", Env: "dev", StateDir: filepath.Join(d, "helper"),
			FakeRoot: filepath.Join(d, "fake"), Socket: filepath.Join(d, "h.sock"), ManagerUID: uint32(os.Getuid()),
			Wifi: f, WifiDir: f.Dir, WifiAddr: func(string) string { return "10.77.0.20" }, WifiAddrWait: 20 * time.Millisecond})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(h.Stop)
		s.Net = &netguard.Guard{StateDir: filepath.Join(d, "net"), Helper: helperclient.Client{Socket: h.Socket}, Check: reach{},
			Lock: nolock{}, Sys: filepath.Join(d, "sys"), Addr: func(i string) string {
				if i == "wlan0" {
					return "10.77.0.20"
				}
				return ""
			}}
	}
	sock := filepath.Join(d, "api.sock")
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go s.Listen(ctx, sock)
	for i := 0; i < 100; i++ {
		if _, err := os.Stat(sock); err == nil {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	return sock, f
}

func TestNetworkRoutes(t *testing.T) {
	t.Parallel()
	me := uint32(os.Getuid())
	sock, _ := startNet(t, me, true)
	c := client(sock)

	resp, m := post(t, c, local.ManagerPathNetworkState, `{"v":1}`)
	if resp.StatusCode != 200 {
		t.Fatalf("%d %v", resp.StatusCode, m)
	}
	n := m["network"].(map[string]any)
	if wf := n["wifi"].(map[string]any); wf["ssid"] != "Office" || n["online"] != true {
		t.Fatalf("%v", n)
	}
	if resp, m := post(t, c, local.ManagerPathWifiScan, `{"v":1}`); resp.StatusCode != 200 ||
		len(m["scan"].(map[string]any)["networks"].([]any)) != 3 {
		t.Fatalf("scan %d %v", resp.StatusCode, m)
	}

	secret := "s3cret-passw0rd"
	for _, tc := range []struct {
		name, path, body string
		status           int
		code             string
	}{
		{"short passphrase", local.ManagerPathWifiJoin, `{"v":1,"ssid":"Home","passphrase":"s3cret","confirmTimeoutSec":120}`, 400, local.WifiErrorInvalidPassphrase},
		{"unknown field", local.ManagerPathWifiJoin, fmt.Sprintf(`{"v":1,"ssid":"Home","passphrase":%q,"confirmTimeoutSec":120,"x":1}`, secret), 400, "bad_request"},
		{"deadline out of range", local.ManagerPathWifiJoin, fmt.Sprintf(`{"v":1,"ssid":"Home","passphrase":%q,"confirmTimeoutSec":5}`, secret), 400, "bad_request"},
		{"name too long in bytes", local.ManagerPathWifiJoin, `{"v":1,"ssid":"` + strings.Repeat("é", 17) + `","confirmTimeoutSec":120}`, 400, "bad_request"},
		{"no password for a secured network", local.ManagerPathWifiJoin, `{"v":1,"ssid":"Home","confirmTimeoutSec":120}`, 400, local.WifiErrorInvalidPassphrase},
		{"forget a network that isn't saved", local.ManagerPathWifiForget, `{"v":1,"ssid":"Home"}`, 404, local.WifiErrorNotSaved},
		{"forget the only connection", local.ManagerPathWifiForget, `{"v":1,"ssid":"Office"}`, 409, local.WifiErrorInUse},
	} {
		t.Run(tc.name, func(t *testing.T) {
			resp, m := post(t, c, tc.path, tc.body)
			if resp.StatusCode != tc.status || errCode(m) != tc.code {
				t.Fatalf("%d %v", resp.StatusCode, m)
			}
			if strings.Contains(fmt.Sprint(m), "s3cret") {
				t.Fatalf("the passphrase is in the answer: %v", m)
			}
		})
	}

	resp, m = post(t, c, local.ManagerPathWifiJoin, `{"v":1,"ssid":"Home","passphrase":"home-pass-22","confirmTimeoutSec":120}`)
	if resp.StatusCode != 202 {
		t.Fatalf("%d %v", resp.StatusCode, m)
	}
	ch := m["change"].(map[string]any)
	if ch["kind"] != "join" || ch["phase"] != "applying" || ch["previous"] != "Office" || !strings.HasPrefix(ch["id"].(string), "c-") {
		t.Fatalf("%v", ch)
	}
	if resp, m := post(t, c, local.ManagerPathWifiJoin, `{"v":1,"ssid":"Cafe","confirmTimeoutSec":120}`); resp.StatusCode != 409 ||
		errCode(m) != local.WifiErrorBusy {
		t.Fatalf("busy: %d %v", resp.StatusCode, m)
	}
}

func TestNetworkRoutesRefused(t *testing.T) {
	t.Parallel()
	me := uint32(os.Getuid())
	sock, _ := startNet(t, me+1, true)
	if resp, m := post(t, client(sock), local.ManagerPathNetworkState, `{"v":1}`); resp.StatusCode != 403 {
		t.Fatalf("another uid: %d %v", resp.StatusCode, m)
	}
	sock, _ = startNet(t, me, false)
	if resp, m := post(t, client(sock), local.ManagerPathNetworkState, `{"v":1}`); resp.StatusCode != 404 || errCode(m) != "unavailable" {
		t.Fatalf("no guard: %d %v", resp.StatusCode, m)
	}
	// No Wi-Fi to use: 409 no_wifi.
	sock, f := startNet(t, me, true)
	f.NoIwd = true
	if resp, m := post(t, client(sock), local.ManagerPathWifiScan, `{"v":1}`); resp.StatusCode != 409 || errCode(m) != local.WifiErrorNoWifi {
		t.Fatalf("no wifi: %d %v", resp.StatusCode, m)
	}
}

func TestCableRoute(t *testing.T) {
	t.Parallel()
	me := uint32(os.Getuid())
	sock, _ := startNet(t, me, true)
	c := client(sock)
	if resp, m := post(t, c, local.ManagerPathNetworkState, `{"v":1}`); resp.StatusCode != 200 ||
		m["network"].(map[string]any)["wifiOnly"] != false {
		t.Fatalf("%d %v", resp.StatusCode, m)
	}
	for _, tc := range []struct {
		name, body string
		status     int
		code       string
	}{
		{"deadline out of range", `{"v":1,"use":"wifi","confirmTimeoutSec":5}`, 400, "bad_request"},
		{"unknown use", `{"v":1,"use":"off","confirmTimeoutSec":120}`, 400, "bad_request"},
		{"the cable while it is used", `{"v":1,"use":"cable","confirmTimeoutSec":120}`, 409, local.CableErrorUnchanged},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if resp, m := post(t, c, local.ManagerPathNetworkCable, tc.body); resp.StatusCode != tc.status || errCode(m) != tc.code {
				t.Fatalf("%d %v", resp.StatusCode, m)
			}
		})
	}
	resp, m := post(t, c, local.ManagerPathNetworkCable, `{"v":1,"use":"wifi","confirmTimeoutSec":120}`)
	if resp.StatusCode != 202 {
		t.Fatalf("%d %v", resp.StatusCode, m)
	}
	ch := m["change"].(map[string]any)
	if ch["use"] != "wifi" || ch["by"] != "person" || ch["phase"] != "applying" || !strings.HasPrefix(ch["id"].(string), "c-") {
		t.Fatalf("%v", ch)
	}
	if resp, m := post(t, c, local.ManagerPathNetworkCable, `{"v":1,"use":"wifi","confirmTimeoutSec":120}`); resp.StatusCode != 409 ||
		errCode(m) != local.CableErrorBusy {
		t.Fatalf("busy: %d %v", resp.StatusCode, m)
	}
	if resp, m := post(t, c, local.ManagerPathNetworkState, `{"v":1}`); resp.StatusCode != 200 ||
		m["network"].(map[string]any)["cableChange"].(map[string]any)["id"] != ch["id"] {
		t.Fatalf("%d %v", resp.StatusCode, m)
	}
	// The runtime's uid only.
	sock, _ = startNet(t, me+1, true)
	if resp, m := post(t, client(sock), local.ManagerPathNetworkCable, `{"v":1,"use":"wifi","confirmTimeoutSec":120}`); resp.StatusCode != 403 {
		t.Fatalf("another uid: %d %v", resp.StatusCode, m)
	}
}
