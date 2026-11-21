package ops

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/helper/internal/activator"
	"github.com/CybexBV/whombat/appliance/helper/pkg/proto"
	"github.com/CybexBV/whombat/appliance/helper/pkg/wifi"
)

type wifiWorld struct {
	t      *testing.T
	h      *Helper
	act    *activator.Fake
	f      *wifi.Fake
	dir    string // iwd's profiles
	state  string
	noAddr atomic.Bool
}

const (
	officePass = "office-pass-1"
	homePass   = "home-pass-22"
)

func newWifiWorld(t *testing.T) *wifiWorld {
	t.Helper()
	d := t.TempDir()
	w := &wifiWorld{t: t, dir: filepath.Join(d, "iwd"), state: filepath.Join(d, "state")}
	os.MkdirAll(w.dir, 0o700)
	w.f = &wifi.Fake{Dir: w.dir, InRange: []wifi.FakeNetwork{
		{SSID: "Office", Security: wifi.SecurityPSK, SignalDBm: -60, Password: officePass},
		{SSID: "Home", Security: wifi.SecurityPSK, SignalDBm: -50, Password: homePass},
		{SSID: "Cafe", Security: wifi.SecurityOpen, SignalDBm: -70},
		{SSID: "Corp", Security: wifi.SecurityEAP, SignalDBm: -45},
	}}
	w.f.Save("Office", wifi.SecurityPSK, officePass, false)
	w.f.ConnectTo("Office")
	var err error
	if w.act, err = activator.NewFake(filepath.Join(d, "fake"), "/nix/store/00000000000000000000000000000000-system"); err != nil {
		t.Fatal(err)
	}
	w.h, err = New(Config{StateDir: w.state, Wifi: w.f, WifiDir: w.dir, WifiAddrWait: 20 * time.Millisecond,
		WifiAddr: func(string) string {
			if w.noAddr.Load() {
				return ""
			}
			return "10.77.0.20"
		}}, w.act)
	if err != nil {
		t.Fatal(err)
	}
	return w
}

func (w *wifiWorld) do(req proto.Request) (*proto.Result, *proto.Error) {
	w.t.Helper()
	req.V = proto.Version
	res, perr, _ := w.h.Handle(context.Background(), req)
	return res, perr
}

func (w *wifiWorld) join(id, ssid, pass string, deadline int) (*proto.Result, *proto.Error) {
	return w.do(proto.Request{Op: proto.OpWifiJoin, ChangeID: id, SSID: ssid, Passphrase: pass, DeadlineSec: deadline})
}

func (w *wifiWorld) on() string { s, _ := w.f.ConnectedTo(); return s }

func (w *wifiWorld) hasProfile(ssid string, sec wifi.Security) bool {
	_, err := wifi.ReadProfile(w.dir, ssid, sec)
	return err == nil
}

func (w *wifiWorld) pending() *WifiChange {
	st, err := loadState(w.state)
	if err != nil {
		w.t.Fatal(err)
	}
	return st.Wifi.Pending
}

func codeOf(perr *proto.Error) string {
	if perr == nil {
		return ""
	}
	return perr.Code
}

func TestWifiStatusAndScan(t *testing.T) {
	t.Parallel()
	w := newWifiWorld(t)
	res, perr := w.do(proto.Request{Op: proto.OpWifiStatus})
	if perr != nil {
		t.Fatal(perr)
	}
	st := res.Wifi.Status
	if st.Interface != "wlan0" || st.State != "connected" || st.Connected == nil || st.Connected.SSID != "Office" ||
		len(st.Saved) != 1 || len(st.Adapters) != 1 || !st.Adapters[0].Powered {
		t.Fatalf("%+v", st)
	}
	res, perr = w.do(proto.Request{Op: proto.OpWifiScan})
	if perr != nil {
		t.Fatal(perr)
	}
	ns := res.Wifi.Networks
	if len(ns) != 4 || ns[0].SSID != "Corp" || ns[1].SSID != "Home" || w.f.Scans() != 1 {
		t.Fatalf("%+v", ns)
	}
	// No Wi-Fi: no card, no iwd, or none configured.
	w.f.NoIwd = true
	if _, perr := w.do(proto.Request{Op: proto.OpWifiStatus}); codeOf(perr) != proto.CodeNoWifi {
		t.Fatalf("no iwd: %v", perr)
	}
	h, _ := New(Config{StateDir: t.TempDir()}, w.act)
	if _, perr, _ := h.Handle(context.Background(), proto.Request{V: 1, Op: proto.OpWifiScan}); codeOf(perr) != proto.CodeNoWifi {
		t.Fatalf("unconfigured: %v", perr)
	}
}

func TestWifiWrongPasswordKeepsNothing(t *testing.T) {
	t.Parallel()
	w := newWifiWorld(t)
	_, perr := w.join("c-wrongpass1", "Home", "not-the-pass", 120)
	if codeOf(perr) != proto.CodeWrongPassword {
		t.Fatalf("%v", perr)
	}
	if w.hasProfile("Home", wifi.SecurityPSK) || w.pending() != nil || w.act.WifiDeadmanArmed() || w.on() != "Office" {
		t.Fatalf("left something: profile %v pending %+v armed %v on %q", w.hasProfile("Home", wifi.SecurityPSK), w.pending(),
			w.act.WifiDeadmanArmed(), w.on())
	}
	if strings.Contains(perr.Message, "not-the-pass") {
		t.Fatal("the passphrase is in the error")
	}
}

func TestWifiGuardedJoinConfirmed(t *testing.T) {
	t.Parallel()
	w := newWifiWorld(t)
	res, perr := w.join("c-joinhome01", "Home", homePass, 120)
	if perr != nil {
		t.Fatal(perr)
	}
	if res.Wifi.Pending != "c-joinhome01" || res.Wifi.Previous != "Office" || res.Wifi.Status.Connected.SSID != "Home" {
		t.Fatalf("%+v", res.Wifi)
	}
	// The join's own time (45 s + the address wait, 20 ms here: 45) + the deadline + 30 s.
	if !w.act.WifiDeadmanArmed() || !strings.Contains(strings.Join(w.act.Events(), ","), "wifi-arm 195") {
		t.Fatalf("dead-man: %v", w.act.Events())
	}
	b, _ := os.ReadFile(filepath.Join(w.state, "state.json"))
	if strings.Contains(string(b), homePass) {
		t.Fatal("the new passphrase is in the helper's state")
	}
	// The status shows the pending change; a second change waits for it; the same one is answered again.
	if res, _ := w.do(proto.Request{Op: proto.OpWifiStatus}); res.Wifi.Status.Pending != "c-joinhome01" {
		t.Fatalf("status pending: %+v", res.Wifi.Status)
	}
	if _, perr := w.join("c-another01", "Cafe", "", 120); codeOf(perr) != proto.CodeWifiPending {
		t.Fatalf("second change: %v", perr)
	}
	if res, perr := w.join("c-joinhome01", "Home", homePass, 120); perr != nil || !res.AlreadyDone {
		t.Fatalf("again: %+v %v", res, perr)
	}
	if _, perr := w.do(proto.Request{Op: proto.OpWifiConfirm, ChangeID: "c-joinhome01"}); perr != nil {
		t.Fatal(perr)
	}
	if w.pending() != nil || w.act.WifiDeadmanArmed() || w.on() != "Home" || !w.hasProfile("Home", wifi.SecurityPSK) {
		t.Fatal("not kept")
	}
	if res, perr := w.do(proto.Request{Op: proto.OpWifiConfirm, ChangeID: "c-joinhome01"}); perr != nil || !res.AlreadyDone {
		t.Fatalf("confirm twice: %+v %v", res, perr)
	}
}

func TestWifiGuardedJoinReverted(t *testing.T) {
	t.Parallel()
	for _, how := range []string{"revert", "deadman"} {
		t.Run(how, func(t *testing.T) {
			w := newWifiWorld(t)
			if _, perr := w.join("c-joincafe01", "Cafe", "", 60); perr != nil {
				t.Fatal(perr)
			}
			if w.on() != "Cafe" || !w.hasProfile("Cafe", wifi.SecurityOpen) {
				t.Fatal("not joined")
			}
			if how == "revert" {
				if _, perr := w.do(proto.Request{Op: proto.OpWifiRevert, ChangeID: "c-joincafe01"}); perr != nil {
					t.Fatal(perr)
				}
			} else if err := w.h.RevertWifiDeadman(context.Background()); err != nil {
				t.Fatal(err)
			}
			if w.on() != "Office" || w.hasProfile("Cafe", wifi.SecurityOpen) || w.pending() != nil || w.act.WifiDeadmanArmed() {
				t.Fatalf("not undone: on %q", w.on())
			}
		})
	}
}

func TestWifiJoinWithoutAddressIsUndone(t *testing.T) {
	t.Parallel()
	w := newWifiWorld(t)
	w.noAddr.Store(true)
	if _, perr := w.join("c-noaddress1", "Home", homePass, 120); codeOf(perr) != proto.CodeNoAddress {
		t.Fatalf("%v", perr)
	}
	if w.on() != "Office" || w.hasProfile("Home", wifi.SecurityPSK) || w.pending() != nil {
		t.Fatal("not undone")
	}
}

func TestWifiJoinFailures(t *testing.T) {
	t.Parallel()
	w := newWifiWorld(t)
	if _, perr := w.join("c-nowhere001", "Nowhere", homePass, 0); codeOf(perr) != proto.CodeNetworkNotFound {
		t.Fatalf("not found: %v", perr)
	}
	if _, perr := w.join("c-corporate1", "Corp", "", 0); codeOf(perr) != proto.CodeNotSupported {
		t.Fatalf("company: %v", perr)
	}
	// A hidden network is joined by name.
	w.f.InRange = append(w.f.InRange, wifi.FakeNetwork{SSID: "Attic", Security: wifi.SecurityPSK, Password: "attic-pass", Hidden: true})
	if _, perr := w.do(proto.Request{Op: proto.OpWifiJoin, ChangeID: "c-hiddennet1", SSID: "Attic", Passphrase: "attic-pass", Hidden: true}); perr != nil {
		t.Fatal(perr)
	}
	// Unguarded (deadline 0): kept at once, no dead-man.
	if w.pending() != nil || w.act.WifiDeadmanArmed() || w.on() != "Attic" {
		t.Fatal("unguarded join left something pending")
	}
}

func TestWifiForget(t *testing.T) {
	t.Parallel()
	w := newWifiWorld(t)
	w.f.Save("Home", wifi.SecurityPSK, homePass, false)
	before, _ := wifi.ReadProfile(w.dir, "Home", wifi.SecurityPSK)
	if _, perr := w.do(proto.Request{Op: proto.OpWifiForget, ChangeID: "c-forgethome", SSID: "Home", DeadlineSec: 60}); perr != nil {
		t.Fatal(perr)
	}
	if w.hasProfile("Home", wifi.SecurityPSK) || w.pending() == nil {
		t.Fatal("not forgotten")
	}
	if _, perr := w.do(proto.Request{Op: proto.OpWifiRevert, ChangeID: "c-forgethome"}); perr != nil {
		t.Fatal(perr)
	}
	after, err := wifi.ReadProfile(w.dir, "Home", wifi.SecurityPSK)
	if err != nil || string(after) != string(before) {
		t.Fatalf("profile not put back: %v", err)
	}
	// Forgetting the connected network, kept: the station goes to another saved one.
	if _, perr := w.do(proto.Request{Op: proto.OpWifiForget, ChangeID: "c-forgetoff1", SSID: "Office"}); perr != nil {
		t.Fatal(perr)
	}
	if w.hasProfile("Office", wifi.SecurityPSK) || w.pending() != nil {
		t.Fatal("not forgotten")
	}
	if _, perr := w.do(proto.Request{Op: proto.OpWifiForget, ChangeID: "c-notsaved01", SSID: "Cafe"}); codeOf(perr) != proto.CodeNotSaved {
		t.Fatalf("not saved: %v", perr)
	}
}

func TestWifiRequestsKeepThePassphraseOut(t *testing.T) {
	t.Parallel()
	r := proto.Request{V: 1, Op: proto.OpWifiJoin, ChangeID: "c-secret0001", SSID: "Home", Passphrase: "hunter2-hunter2"}
	if err := r.Validate(); err != nil {
		t.Fatal(err)
	}
	for _, s := range []string{r.String(), r.GoString()} {
		if strings.Contains(s, "hunter2") {
			t.Fatalf("%q", s)
		}
	}
	for _, bad := range []proto.Request{
		{V: 1, Op: proto.OpWifiJoin, ChangeID: "c-x", SSID: "Home"},                                    // id too short
		{V: 1, Op: proto.OpWifiJoin, ChangeID: "c-abcdefgh", SSID: ""},                                 // no ssid
		{V: 1, Op: proto.OpWifiJoin, ChangeID: "c-abcdefgh", SSID: "Home", Passphrase: "short"},        // passphrase
		{V: 1, Op: proto.OpWifiJoin, ChangeID: "c-abcdefgh", SSID: "Home", DeadlineSec: 9999},          // deadline
		{V: 1, Op: proto.OpWifiForget, ChangeID: "c-abcdefgh", SSID: "Home", Passphrase: "something8"}, // forget + secret
		{V: 1, Op: proto.OpWifiConfirm, ChangeID: "c-abcdefgh", SSID: "Home"},                          // confirm + ssid
		{V: 1, Op: proto.OpBlessBoot, SSID: "Home"},                                                    // not a Wi-Fi op
	} {
		if err := bad.Validate(); err == nil {
			t.Errorf("accepted %v", bad)
		} else if strings.Contains(err.Error(), "short") || strings.Contains(err.Error(), "something8") {
			t.Errorf("the passphrase is in %q", err)
		}
	}
}
