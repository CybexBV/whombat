package netguard_test

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/helper/helpertest"
	"github.com/CybexBV/whombat/appliance/helper/pkg/wifi"
	"github.com/CybexBV/whombat/appliance/manager/internal/helperclient"
	"github.com/CybexBV/whombat/appliance/manager/internal/netguard"
	"github.com/CybexBV/whombat/contracts/go/local"
	"github.com/CybexBV/whombat/contracts/go/protocol"
)

type clock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *clock) Now() time.Time          { c.mu.Lock(); defer c.mu.Unlock(); return c.t }
func (c *clock) Advance(d time.Duration) { c.mu.Lock(); c.t = c.t.Add(d); c.mu.Unlock() }

// control is the control endpoint as the guard's checker sees it.
type control struct {
	up     atomic.Bool
	checks atomic.Int32
}

func (c *control) Check(context.Context) error {
	c.checks.Add(1)
	if c.up.Load() {
		return nil
	}
	return errors.New("no route to control")
}

type lock struct {
	mu     sync.Mutex
	holder string
}

func (l *lock) AcquireLock(h, _ string, _ time.Duration) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.holder != "" && l.holder != h {
		return errors.New("held by " + l.holder)
	}
	l.holder = h
	return nil
}

func (l *lock) ReleaseLock(h string) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.holder == h {
		l.holder = ""
	}
	return nil
}

func (l *lock) held() string { l.mu.Lock(); defer l.mu.Unlock(); return l.holder }

type wworld struct {
	t     *testing.T
	g     *netguard.Guard
	f     *wifi.Fake
	h     *helpertest.Helper
	clock *clock
	ctl   *control
	lock  *lock
	iwd   string
	sys   string
	state string
}

const (
	officePass = "office-pass-1"
	homePass   = "home-pass-22"
)

func newWorld(t *testing.T) *wworld {
	t.Helper()
	d, err := os.MkdirTemp("", "wg") // a short path: the helper's socket
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(d) })
	w := &wworld{t: t, clock: &clock{t: time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)}, ctl: &control{}, lock: &lock{},
		iwd: filepath.Join(d, "iwd"), sys: filepath.Join(d, "sys"), state: filepath.Join(d, "state")}
	os.MkdirAll(w.iwd, 0o700)
	w.f = &wifi.Fake{Dir: w.iwd, InRange: []wifi.FakeNetwork{
		{SSID: "Office", Security: wifi.SecurityPSK, SignalDBm: -60, Password: officePass},
		{SSID: "Home", Security: wifi.SecurityPSK, SignalDBm: -50, Password: homePass},
		{SSID: "Cafe", Security: wifi.SecurityOpen, SignalDBm: -70},
		{SSID: "Bad\x01Name", Security: wifi.SecurityOpen, SignalDBm: -40},
		{SSID: "Corp", Security: wifi.SecurityEAP, SignalDBm: -80},
	}}
	w.f.Save("Office", wifi.SecurityPSK, officePass, false)
	w.f.ConnectTo("Office")
	w.ctl.up.Store(true)
	addr := func(iface string) string {
		switch iface {
		case "wlan0":
			if s, _ := w.f.ConnectedTo(); s != "" {
				return "10.77.0.20"
			}
		case "eth0":
			return "192.168.1.5"
		}
		return ""
	}
	w.h, err = helpertest.Start(helpertest.Config{DeviceID: "dev-1", Env: "dev", StateDir: filepath.Join(d, "helper"),
		FakeRoot: filepath.Join(d, "fake"), Socket: filepath.Join(d, "h.sock"), ManagerUID: uint32(os.Getuid()),
		Now: w.clock.Now, Wifi: w.f, WifiDir: w.iwd, WifiAddr: addr, WifiAddrWait: 20 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(w.h.Stop)
	w.g = w.guard()
	w.g.Addr = addr
	return w
}

func (w *wworld) guard() *netguard.Guard {
	return &netguard.Guard{CandidatesDir: filepath.Join(w.sys, "..", "cands"), StateDir: w.state,
		Helper: helperclient.Client{Socket: w.h.Socket}, Check: w.ctl, Lock: w.lock, Now: w.clock.Now, Sys: w.sys}
}

// run steps the guard, moving the clock on by each wait, until the change reaches one of the phases.
func (w *wworld) run(g *netguard.Guard, until ...protocol.NetworkChangePhase) protocol.NetworkChange {
	w.t.Helper()
	for i := 0; i < 200; i++ {
		if c := g.WifiChange(); c != nil {
			for _, p := range until {
				if c.Phase == p {
					return *c
				}
			}
		}
		wait, err := g.Step(context.Background())
		if err != nil {
			w.t.Fatal(err)
		}
		w.clock.Advance(wait)
	}
	w.t.Fatalf("stuck in %+v", w.g.WifiChange())
	return protocol.NetworkChange{}
}

func (w *wworld) on() string { s, _ := w.f.ConnectedTo(); return s }

func (w *wworld) profile(ssid string, sec wifi.Security) bool {
	_, err := wifi.ReadProfile(w.iwd, ssid, sec)
	return err == nil
}

func valid(t *testing.T, c protocol.NetworkChange) {
	t.Helper()
	if err := (&local.WifiChangeResponse{V: 1, Change: c}).Validate(); err != nil || !local.NetworkChangeValid(c) {
		t.Fatalf("change breaks the contract: %+v %v", c, err)
	}
}

func TestWifiJoinConfirmed(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	c, err := w.g.Join(ctx, netguard.WifiJoin{SSID: "Home", Passphrase: homePass, ConfirmSec: 120})
	if err != nil {
		t.Fatal(err)
	}
	valid(t, c)
	if c.Phase != protocol.NetworkChangePhaseApplying || c.Previous == nil || *c.Previous != "Office" || w.lock.held() != "network" {
		t.Fatalf("%+v lock %q", c, w.lock.held())
	}
	// One change at a time, answered before any check (the second asks the helper and control nothing).
	checks := w.ctl.checks.Load()
	if _, err := w.g.Join(ctx, netguard.WifiJoin{SSID: "Cafe", ConfirmSec: 120}); !errors.Is(err, netguard.ErrBusy) || w.ctl.checks.Load() != checks {
		t.Fatalf("second join: %v", err)
	}
	if _, err := w.g.Forget(ctx, "Office", 120, true); !errors.Is(err, netguard.ErrBusy) {
		t.Fatalf("forget meanwhile: %v", err)
	}
	select {
	case <-w.g.Woken():
	default:
		t.Fatal("the network loop wasn't woken")
	}
	c = w.run(w.g, protocol.NetworkChangePhaseCommitted, protocol.NetworkChangePhaseFailed, protocol.NetworkChangePhaseReverted)
	valid(t, c)
	if c.Phase != protocol.NetworkChangePhaseCommitted || c.Failure != nil || w.on() != "Home" || !w.profile("Home", wifi.SecurityPSK) ||
		w.lock.held() != "" || w.h.WifiDeadmanArmed() {
		t.Fatalf("%+v on %q lock %q", c, w.on(), w.lock.held())
	}
	b, _ := os.ReadFile(filepath.Join(w.state, "wifi.json"))
	if len(b) == 0 || strings.Contains(string(b), homePass) {
		t.Fatal("the passphrase is in the manager's state")
	}
	// Shown for a while after it ended, then gone.
	w.clock.Advance(netguard.ShownAfterEnd + time.Second)
	if w.g.WifiChange() != nil {
		t.Fatal("an old change is still shown")
	}
}

func TestWifiWrongPasswordFails(t *testing.T) {
	w := newWorld(t)
	if _, err := w.g.Join(context.Background(), netguard.WifiJoin{SSID: "Home", Passphrase: "not-the-pass", ConfirmSec: 120}); err != nil {
		t.Fatal(err)
	}
	c := w.run(w.g, protocol.NetworkChangePhaseFailed, protocol.NetworkChangePhaseCommitted)
	valid(t, c)
	if c.Phase != protocol.NetworkChangePhaseFailed || *c.Failure != protocol.NetworkChangeFailureWrongPassword ||
		w.profile("Home", wifi.SecurityPSK) || w.on() != "Office" || w.lock.held() != "" {
		t.Fatalf("%+v on %q", c, w.on())
	}
}

func TestWifiJoinWithoutInternetGoesBack(t *testing.T) {
	w := newWorld(t)
	if _, err := w.g.Join(context.Background(), netguard.WifiJoin{SSID: "Cafe", ConfirmSec: 30}); err != nil {
		t.Fatal(err)
	}
	// Online before (so it is guarded); the café has no way to control.
	w.ctl.up.Store(false)
	c := w.run(w.g, protocol.NetworkChangePhaseConfirming)
	if !w.h.WifiDeadmanArmed() || w.on() != "Cafe" {
		t.Fatal("not guarded")
	}
	c = w.run(w.g, protocol.NetworkChangePhaseReverted)
	valid(t, c)
	if *c.Failure != protocol.NetworkChangeFailureNoInternet || w.on() != "Office" || w.profile("Cafe", wifi.SecurityOpen) ||
		w.h.WifiDeadmanArmed() || w.lock.held() != "" {
		t.Fatalf("%+v on %q", c, w.on())
	}
	// Back on Office: the next question checks again rather than repeat what the café said.
	w.ctl.up.Store(true)
	if online, _ := w.g.Online(context.Background(), time.Second); !online {
		t.Fatal("still offline after going back")
	}
}

func TestWifiJoinOfflineIsKeptAtOnce(t *testing.T) {
	w := newWorld(t)
	w.ctl.up.Store(false) // nothing to lose: not online before
	if _, err := w.g.Join(context.Background(), netguard.WifiJoin{SSID: "Home", Passphrase: homePass, ConfirmSec: 120}); err != nil {
		t.Fatal(err)
	}
	checks := w.ctl.checks.Load()
	c := w.run(w.g, protocol.NetworkChangePhaseCommitted, protocol.NetworkChangePhaseFailed)
	if c.Phase != protocol.NetworkChangePhaseCommitted || w.on() != "Home" || w.ctl.checks.Load() != checks || w.h.WifiDeadmanArmed() {
		t.Fatalf("%+v checks %d→%d", c, checks, w.ctl.checks.Load())
	}
}

func TestWifiManagerRestartDuringJoin(t *testing.T) {
	w := newWorld(t)
	if _, err := w.g.Join(context.Background(), netguard.WifiJoin{SSID: "Home", Passphrase: homePass, ConfirmSec: 120}); err != nil {
		t.Fatal(err)
	}
	// The manager died before the loop took the change: its passphrase went with it.
	g2 := w.guard()
	c := w.run(g2, protocol.NetworkChangePhaseReverted, protocol.NetworkChangePhaseCommitted)
	valid(t, c)
	if c.Phase != protocol.NetworkChangePhaseReverted || *c.Failure != protocol.NetworkChangeFailureFailed || w.on() != "Office" {
		t.Fatalf("%+v", c)
	}
}

func TestWifiForget(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	if _, err := w.g.Forget(ctx, "Home", 120, false); !errors.Is(err, netguard.ErrNotSaved) {
		t.Fatalf("not saved: %v", err)
	}
	if _, err := w.g.Forget(ctx, "Office", 120, false); !errors.Is(err, netguard.ErrInUse) {
		t.Fatalf("in use: %v", err)
	}
	// With a cable it may go: guarded, and confirmed through the cable.
	c, err := w.g.Forget(ctx, "Office", 120, true)
	if err != nil || c.Kind != protocol.NetworkChangeKindForget {
		t.Fatalf("%+v %v", c, err)
	}
	c = w.run(w.g, protocol.NetworkChangePhaseCommitted, protocol.NetworkChangePhaseReverted)
	if c.Phase != protocol.NetworkChangePhaseCommitted || w.profile("Office", wifi.SecurityPSK) {
		t.Fatalf("%+v", c)
	}
	// The lock held by an update: busy.
	w.f.Save("Home", wifi.SecurityPSK, homePass, false)
	w.lock.AcquireLock("backup", "", time.Minute)
	if _, err := w.g.Forget(ctx, "Home", 120, true); !errors.Is(err, netguard.ErrBusy) {
		t.Fatalf("locked: %v", err)
	}
}

func TestWifiJoinNeedsAPasswordAndAWifiCard(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	if _, err := w.g.Scan(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := w.g.Join(ctx, netguard.WifiJoin{SSID: "Home", ConfirmSec: 120}); !errors.Is(err, netguard.ErrInvalidPassphrase) {
		t.Fatalf("no password: %v", err)
	}
	w.f.NoIwd = true
	if _, err := w.g.Join(ctx, netguard.WifiJoin{SSID: "Home", Passphrase: homePass, ConfirmSec: 120}); !errors.Is(err, netguard.ErrNoWifi) {
		t.Fatalf("no iwd: %v", err)
	}
	if _, err := w.g.Scan(ctx); !errors.Is(err, netguard.ErrNoWifi) {
		t.Fatalf("scan without iwd: %v", err)
	}
}

func TestWifiScan(t *testing.T) {
	w := newWorld(t)
	s, err := w.g.Scan(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if err := (&local.WifiScanResponse{V: 1, Scan: s}).Validate(); err != nil {
		t.Fatal(err)
	}
	got := map[string]protocol.WifiNetwork{}
	for _, n := range s.Networks {
		got[n.Ssid] = n
	}
	if len(s.Networks) != 4 || s.Networks[0].Ssid != "Home" || s.Networks[0].Signal != 4 {
		t.Fatalf("%+v", s.Networks) // the undisplayable name is left out
	}
	if o := got["Office"]; !o.Saved || !o.Connected || o.Signal != 3 || o.Security != protocol.WifiSecurityPsk {
		t.Fatalf("%+v", o)
	}
	if got["Corp"].Security != protocol.WifiSecurityEnterprise || got["Cafe"].Security != protocol.WifiSecurityOpen {
		t.Fatalf("%+v", got)
	}
}

func write(t *testing.T, p, s string) {
	t.Helper()
	os.MkdirAll(filepath.Dir(p), 0o755)
	if err := os.WriteFile(p, []byte(s), 0o644); err != nil {
		t.Fatal(err)
	}
}

func netdev(t *testing.T, sys, name string, physical, wireless bool, carrier string) {
	d := filepath.Join(sys, "class", "net", name)
	write(t, filepath.Join(d, "type"), "1\n")
	if carrier != "" {
		write(t, filepath.Join(d, "carrier"), carrier+"\n")
	}
	if physical {
		os.Symlink("../../../devices/pci0000:00/x", filepath.Join(d, "device"))
	}
	if wireless {
		os.MkdirAll(filepath.Join(d, "wireless"), 0o755)
	}
}

func TestNetworkState(t *testing.T) {
	w := newWorld(t)
	netdev(t, w.sys, "eth0", true, false, "1")
	netdev(t, w.sys, "enx00e04c680001", true, false, "0") // a USB adapter without a cable
	netdev(t, w.sys, "wlan0", true, true, "1")
	netdev(t, w.sys, "wbc2d4e27ee", false, false, "1") // the computers' bridge
	ctx := context.Background()
	n, err := w.g.NetworkState(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := (&local.NetworkStateResponse{V: 1, Network: n}).Validate(); err != nil || !local.HostNetworkValid(n) {
		t.Fatalf("%+v %v", n, err)
	}
	if !n.Online || n.CheckedAt == nil || n.Change != nil || n.WifiMissing != nil {
		t.Fatalf("%+v", n)
	}
	if len(n.Wired) != 2 || n.Wired[0].Interface != "enx00e04c680001" || n.Wired[0].Connected ||
		n.Wired[1].Interface != "eth0" || !n.Wired[1].Connected || *n.Wired[1].Address != "192.168.1.5" {
		t.Fatalf("wired %+v", n.Wired)
	}
	wf := n.Wifi
	if wf == nil || wf.Interface != "wlan0" || wf.State != protocol.WifiStateConnected || *wf.Ssid != "Office" || *wf.Signal != 3 ||
		*wf.Address != "10.77.0.20" || len(wf.Saved) != 1 || wf.Saved[0].Security != protocol.WifiSecurityPsk {
		t.Fatalf("wifi %+v", wf)
	}
	// Online answers from its last check for a minute, then checks again.
	checks := w.ctl.checks.Load()
	w.clock.Advance(30 * time.Second)
	w.g.NetworkState(ctx)
	if w.ctl.checks.Load() != checks {
		t.Fatal("checked again within a minute")
	}
	w.clock.Advance(31 * time.Second)
	w.ctl.up.Store(false)
	if n, _ := w.g.NetworkState(ctx); n.Online || w.ctl.checks.Load() != checks+1 {
		t.Fatalf("not checked again: %v %d", n.Online, w.ctl.checks.Load())
	}
	// Offline counts for 10 s only.
	w.ctl.up.Store(true)
	w.clock.Advance(5 * time.Second)
	if n, _ := w.g.NetworkState(ctx); n.Online || w.ctl.checks.Load() != checks+1 {
		t.Fatal("an offline answer was checked again within 10 s")
	}
	w.clock.Advance(6 * time.Second)
	if n, _ := w.g.NetworkState(ctx); !n.Online || w.ctl.checks.Load() != checks+2 {
		t.Fatalf("offline kept too long: %v %d", n.Online, w.ctl.checks.Load())
	}
	// A running change is in the state.
	w.ctl.up.Store(true)
	w.clock.Advance(time.Minute)
	if _, err := w.g.Join(ctx, netguard.WifiJoin{SSID: "Home", Passphrase: homePass, ConfirmSec: 120}); err != nil {
		t.Fatal(err)
	}
	if n, _ := w.g.NetworkState(ctx); n.Change == nil || n.Change.Phase != protocol.NetworkChangePhaseApplying || !local.HostNetworkValid(n) {
		t.Fatalf("%+v", n.Change)
	}
}

func TestWifiMissing(t *testing.T) {
	ctx := context.Background()
	for _, tc := range []struct {
		name string
		sys  func(t *testing.T, sys string)
		want protocol.WifiMissing
	}{
		{"no card", func(*testing.T, string) {}, protocol.WifiMissingNoAdapter},
		{"a card without a driver", func(t *testing.T, sys string) {
			write(t, filepath.Join(sys, "bus", "pci", "devices", "0000:01:00.0", "class"), "0x028000\n")
			write(t, filepath.Join(sys, "bus", "pci", "devices", "0000:02:00.0", "class"), "0x020000\n") // Ethernet
		}, protocol.WifiMissingNoDriver},
		{"switched off", func(t *testing.T, sys string) {
			write(t, filepath.Join(sys, "class", "rfkill", "rfkill0", "type"), "wlan\n")
			write(t, filepath.Join(sys, "class", "rfkill", "rfkill0", "soft"), "1\n")
			write(t, filepath.Join(sys, "class", "rfkill", "rfkill0", "hard"), "0\n")
		}, protocol.WifiMissingDisabled},
	} {
		t.Run(tc.name, func(t *testing.T) {
			w := newWorld(t)
			w.f.NoIwd = true
			tc.sys(t, w.sys)
			n, err := w.g.NetworkState(ctx)
			if err != nil {
				t.Fatal(err)
			}
			if n.Wifi != nil || n.WifiMissing == nil || *n.WifiMissing != tc.want || !local.HostNetworkValid(n) {
				t.Fatalf("%+v", n)
			}
		})
	}
	// A card iwd sees switched off.
	w := newWorld(t)
	w.f.Unpowered = true
	if n, _ := w.g.NetworkState(ctx); n.Wifi != nil || n.WifiMissing == nil || *n.WifiMissing != protocol.WifiMissingDisabled {
		t.Fatalf("%+v", n)
	}
}
