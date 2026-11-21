package wifi

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/godbus/dbus/v5"
)

func TestProfileNames(t *testing.T) {
	for _, c := range []struct {
		ssid string
		sec  Security
		want string
	}{
		{"Home", SecurityPSK, "Home.psk"},
		{"My Net-2_g", SecurityOpen, "My Net-2_g.open"},
		{"Café", SecurityPSK, "=436166c3a9.psk"},
		{"a.b", SecurityPSK, "=612e62.psk"},
		{"../x", SecurityOpen, "=2e2e2f78.open"},
	} {
		got, err := ProfileName(c.ssid, c.sec)
		if err != nil || got != c.want {
			t.Errorf("%q: %q %v, want %q", c.ssid, got, err, c.want)
		}
		ssid, sec, ok := ParseProfileName(got)
		if !ok || ssid != c.ssid || sec != c.sec {
			t.Errorf("parse %q: %q %q %v", got, ssid, sec, ok)
		}
	}
	for _, bad := range []string{".Home.psk.tmp-123", "Home.wep", "=zz.psk", "a.b.psk", "", "=.psk"} {
		if _, _, ok := ParseProfileName(bad); ok {
			t.Errorf("parsed %q", bad)
		}
	}
	if _, err := ProfileName("", SecurityPSK); !errors.Is(err, ErrBadSSID) {
		t.Errorf("empty ssid: %v", err)
	}
	if _, err := ProfileName(strings.Repeat("x", 33), SecurityPSK); !errors.Is(err, ErrBadSSID) {
		t.Errorf("long ssid: %v", err)
	}
	if _, err := ProfileName("Home", SecurityWEP); err == nil {
		t.Error("a wep profile")
	}
}

func TestRenderEscapesLikeEll(t *testing.T) {
	b, err := Profile{Passphrase: `  a\b c `}.Render(SecurityPSK)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(b), "Passphrase=\\s\\sa\\\\b c \n") || !strings.Contains(string(b), "AutoConnect=true") {
		t.Fatalf("%q", b)
	}
	key := strings.Repeat("AB", 32)
	b, _ = Profile{Passphrase: key, Hidden: true}.Render(SecurityPSK)
	if !strings.Contains(string(b), "PreSharedKey="+strings.ToLower(key)) || !strings.Contains(string(b), "Hidden=true") ||
		strings.Contains(string(b), "Passphrase=") {
		t.Fatalf("%q", b)
	}
	b, _ = Profile{NoAutoConnect: true}.Render(SecurityOpen)
	if !strings.HasPrefix(string(b), "[Settings]\n") || !strings.Contains(string(b), "AutoConnect=false") {
		t.Fatalf("open: %q", b)
	}
	if _, err := (Profile{Passphrase: "short"}).Render(SecurityPSK); !errors.Is(err, ErrInvalidPassphrase) {
		t.Fatalf("short: %v", err)
	}
	if _, err := (Profile{Passphrase: "something8"}).Render(SecurityOpen); err == nil {
		t.Fatal("an open network with a passphrase")
	}
}

func TestPassphrases(t *testing.T) {
	for p, ok := range map[string]bool{
		"12345678": true, strings.Repeat("x", 63): true, strings.Repeat("x", 64): false, "1234567": false,
		"pass\x7fword": false, "pässword": false, strings.Repeat("0f", 32): true, strings.Repeat("0g", 32): false,
	} {
		if ValidPassphrase(p) != ok {
			t.Errorf("%q: %v", p, !ok)
		}
	}
}

func TestSecretsStayOut(t *testing.T) {
	j := Join{SSID: "Home", Passphrase: "s3cret-pass"}
	p := Profile{Passphrase: "s3cret-pass"}
	for _, s := range []string{fmt.Sprint(j), fmt.Sprintf("%+v", j), fmt.Sprintf("%#v", j), fmt.Sprint(p), fmt.Sprintf("%#v", p)} {
		if strings.Contains(s, "s3cret") {
			t.Fatalf("passphrase in %q", s)
		}
	}
}

func TestProfileFiles(t *testing.T) {
	src, dst := t.TempDir(), filepath.Join(t.TempDir(), "var", "lib", "iwd")
	if err := WriteProfile(src, "Café", SecurityPSK, Profile{Passphrase: "correct horse"}); err != nil {
		t.Fatal(err)
	}
	fi, err := os.Stat(filepath.Join(src, "=436166c3a9.psk"))
	if err != nil || fi.Mode().Perm() != 0o600 {
		t.Fatalf("%v %v", fi, err)
	}
	if err := CopyProfile(src, dst, "Café", SecurityPSK); err != nil {
		t.Fatal(err)
	}
	if di, err := os.Stat(dst); err != nil || di.Mode().Perm() != 0o700 {
		t.Fatalf("dir %v %v", di, err)
	}
	a, _ := ReadProfile(src, "Café", SecurityPSK)
	b, err := ReadProfile(dst, "Café", SecurityPSK)
	if err != nil || string(a) != string(b) {
		t.Fatalf("copy: %v", err)
	}
	if err := RemoveProfile(dst, "Café", SecurityPSK); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadProfile(dst, "Café", SecurityPSK); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("removed: %v", err)
	}
	if err := RemoveProfile(dst, "Café", SecurityPSK); err != nil {
		t.Fatalf("remove twice: %v", err)
	}
	// A symlink is not followed.
	if err := os.Symlink("/etc/passwd", filepath.Join(src, "Link.psk")); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadProfile(src, "Link", SecurityPSK); err == nil {
		t.Fatal("followed a symlink")
	}
}

func v(x any) dbus.Variant { return dbus.MakeVariant(x) }

func TestParseObjects(t *testing.T) {
	objs := map[dbus.ObjectPath]map[string]map[string]dbus.Variant{
		"/net/connman/iwd/0": {ifAdapter: {"Name": v("phy0"), "Powered": v(true), "Model": v("MT7925")}},
		"/net/connman/iwd/0/5": {
			ifDevice:  {"Name": v("wlan0"), "Mode": v("station"), "Powered": v(true), "Adapter": v(dbus.ObjectPath("/net/connman/iwd/0"))},
			ifStation: {"State": v("connected"), "Scanning": v(false), "ConnectedNetwork": v(dbus.ObjectPath("/net/connman/iwd/0/5/486f6d65_psk"))},
		},
		"/net/connman/iwd/0/5/486f6d65_psk": {ifNetwork: {"Name": v("Home"), "Type": v("psk"), "Connected": v(true),
			"Device": v(dbus.ObjectPath("/net/connman/iwd/0/5")), "KnownNetwork": v(dbus.ObjectPath("/net/connman/iwd/486f6d65_psk"))}},
		"/net/connman/iwd/0/5/486f6d65_open": {ifNetwork: {"Name": v("Home"), "Type": v("open"), "Connected": v(false),
			"Device": v(dbus.ObjectPath("/net/connman/iwd/0/5"))}},
		"/net/connman/iwd/486f6d65_psk": {ifKnown: {"Name": v("Home"), "Type": v("psk"), "Hidden": v(false), "AutoConnect": v(true),
			"LastConnectedTime": v("2026-10-20T10:00:00Z")}},
		"/net/connman/iwd/4f6666_psk": {ifKnown: {"Name": v("Off"), "Type": v("psk"), "Hidden": v(true)}},
		"/odd":                        {ifDevice: {"Name": v(7)}}, // a wrong shape is left out
	}
	s := parseObjects(objs)
	st := s.status()
	d := st.Station()
	if d == nil || d.Interface != "wlan0" || d.Adapter != "phy0" || d.Station.State != StateConnected ||
		d.Station.Connected == nil || d.Station.Connected.SSID != "Home" || !d.Station.Connected.Known {
		t.Fatalf("%+v", st)
	}
	if len(st.Devices) != 1 || len(st.Adapters) != 1 || st.Adapters[0].Model != "MT7925" {
		t.Fatalf("%+v", st)
	}
	if len(st.Known) != 2 || st.Known[0].SSID != "Home" || st.Known[0].LastConnected.IsZero() || !st.Known[1].Hidden {
		t.Fatalf("known %+v", st.Known)
	}
	station := s.deviceByName["wlan0"]
	if n := s.find(station, Join{SSID: "Home", Passphrase: "something8"}); n == nil || n.security != SecurityPSK {
		t.Fatalf("psk: %+v", n)
	}
	if n := s.find(station, Join{SSID: "Home"}); n == nil || n.security != SecurityOpen {
		t.Fatalf("open: %+v", n)
	}
	if n := s.find(station, Join{SSID: "Away"}); n != nil {
		t.Fatal("found a network out of range")
	}
	if s.knownOf("Off", SecurityPSK) == nil || s.knownOf("Off", SecurityOpen) != nil {
		t.Fatal("knownOf")
	}
}

func TestConnectErrors(t *testing.T) {
	ag := &agent{}
	for name, want := range map[string]error{
		"net.connman.iwd.Failed":                    ErrWrongPassword,
		"net.connman.iwd.InvalidFormat":             ErrInvalidPassphrase,
		"net.connman.iwd.NotFound":                  ErrNotFound,
		"net.connman.iwd.Busy":                      ErrBusy,
		"net.connman.iwd.NotSupported":              ErrNotSupported,
		"org.freedesktop.DBus.Error.ServiceUnknown": ErrNoIwd,
	} {
		if got := connectErr(context.Background(), dbus.Error{Name: name}, SecurityPSK, ag); !errors.Is(got, want) {
			t.Errorf("%s: %v", name, got)
		}
	}
	if got := connectErr(context.Background(), dbus.Error{Name: "net.connman.iwd.Failed"}, SecurityOpen, ag); errors.Is(got, ErrWrongPassword) {
		t.Error("an open network's failure is not a wrong password")
	}
	if got := connectErr(context.Background(), dbus.Error{Name: "net.connman.iwd.Aborted"}, SecurityPSK, ag); errors.Is(got, ErrWrongPassword) {
		t.Error("aborted without a declined request")
	}
	ag.iwd = ":1.5"
	if _, e := ag.RequestPassphrase(":1.9", "/x"); e == nil {
		t.Fatal("answered another peer")
	}
	if got := connectErr(context.Background(), dbus.Error{Name: "net.connman.iwd.Aborted"}, SecurityPSK, ag); !errors.Is(got, ErrWrongPassword) {
		t.Errorf("declined: %v", got)
	}
	ag2 := &agent{iwd: ":1.5", passphrase: "the-pass-1"}
	if p, e := ag2.RequestPassphrase(":1.5", "/x"); e != nil || p != "the-pass-1" {
		t.Fatalf("%q %v", p, e)
	}
}

func TestFake(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	f := &Fake{Dir: dir, InRange: []FakeNetwork{
		{SSID: "Office", Security: SecurityPSK, SignalDBm: -60, Password: "office-pass"},
		{SSID: "Home", Security: SecurityPSK, SignalDBm: -50, Password: "home-pass-1"},
		{SSID: "Cafe", Security: SecurityOpen, SignalDBm: -80},
		{SSID: "Attic", Security: SecurityPSK, SignalDBm: -70, Password: "attic-pass", Hidden: true},
		{SSID: "Corp", Security: SecurityEAP, SignalDBm: -40},
	}}
	f.Save("Office", SecurityPSK, "office-pass", false)
	f.ConnectTo("Office")
	ns, err := f.Scan(ctx, "wlan0")
	if err != nil || len(ns) != 4 || ns[0].SSID != "Corp" || ns[1].SSID != "Home" {
		t.Fatalf("%+v %v", ns, err)
	}
	if err := f.Connect(ctx, "wlan0", Join{SSID: "Home", Passphrase: "wrong-pass"}); !errors.Is(err, ErrWrongPassword) {
		t.Fatalf("wrong: %v", err)
	}
	if _, err := ReadProfile(dir, "Home", SecurityPSK); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("a wrong password left a profile")
	}
	if s, _ := f.ConnectedTo(); s != "Office" {
		t.Fatalf("on %q", s)
	}
	if err := f.Connect(ctx, "wlan0", Join{SSID: "Home", Passphrase: "home-pass-1"}); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadProfile(dir, "Home", SecurityPSK); err != nil {
		t.Fatal("no profile after the join")
	}
	if err := f.Connect(ctx, "wlan0", Join{SSID: "Attic", Passphrase: "attic-pass"}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("hidden without Hidden: %v", err)
	}
	if err := f.Connect(ctx, "wlan0", Join{SSID: "Attic", Passphrase: "attic-pass", Hidden: true}); err != nil {
		t.Fatal(err)
	}
	if err := f.Connect(ctx, "wlan0", Join{SSID: "Corp"}); !errors.Is(err, ErrNotSupported) {
		t.Fatalf("eap: %v", err)
	}
	if err := f.Connect(ctx, "wlan0", Join{SSID: "Cafe"}); err != nil {
		t.Fatal(err)
	}
	// Forgetting the connected network goes to the strongest other saved one.
	if err := f.Forget(ctx, "Cafe", SecurityOpen); err != nil {
		t.Fatal(err)
	}
	if s, _ := f.ConnectedTo(); s != "Home" {
		t.Fatalf("after forget on %q", s)
	}
	if err := f.Forget(ctx, "Cafe", SecurityOpen); !errors.Is(err, ErrNotFound) {
		t.Fatalf("forget twice: %v", err)
	}
	st, _ := f.Status(ctx)
	if d := st.Station(); d == nil || d.Station.Connected.SSID != "Home" || len(st.Known) != 3 {
		t.Fatalf("%+v", st)
	}
	f.FailNext = ErrBusy
	if err := f.Connect(ctx, "wlan0", Join{SSID: "Cafe"}); !errors.Is(err, ErrBusy) {
		t.Fatalf("FailNext: %v", err)
	}
	if j := f.Joins(); len(j) != 7 || j[0] != "Home" {
		t.Fatalf("joins %v", j)
	}
	if _, err := (&Fake{NoIwd: true}).Status(ctx); !errors.Is(err, ErrNoIwd) {
		t.Fatalf("no iwd: %v", err)
	}
	if _, err := (&Fake{}).Scan(ctx, "wlan9"); !errors.Is(err, ErrNoStation) {
		t.Fatalf("other iface: %v", err)
	}
}
