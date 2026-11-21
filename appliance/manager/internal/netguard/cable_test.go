package netguard_test

import (
	"context"
	"errors"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/manager/internal/netguard"
	"github.com/CybexBV/whombat/contracts/go/local"
	"github.com/CybexBV/whombat/contracts/go/protocol"
)

// newCableWorld is the Wi-Fi world with a cable: eth0 plugged in (192.168.1.5/24 while the helper hasn't switched it
// off) and Wi-Fi on Office (10.77.0.20/24), the helper behind its real socket.
func newCableWorld(t *testing.T) *wworld {
	w := newWorld(t)
	netdev(t, w.sys, "eth0", true, false, "1")
	write(t, filepath.Join(w.sys, "class", "net", "eth0", "address"), "A8:E2:91:16:47:58\n")
	netdev(t, w.sys, "wlan0", true, true, "1")
	write(t, filepath.Join(w.sys, "class", "net", "wlan0", "address"), "a8:e2:91:16:47:59\n")
	w.g.Addr = w.cableAddr
	w.g.Prefix = func(string) int { return 24 }
	return w
}

func (w *wworld) cableAddr(iface string) string {
	switch iface {
	case "wlan0":
		if s, _ := w.f.ConnectedTo(); s != "" {
			return "10.77.0.20"
		}
	case "eth0":
		if live, _ := w.h.CableState(); !live {
			return "192.168.1.5"
		}
	}
	return ""
}

func (w *wworld) cguard() *netguard.Guard {
	g := w.guard()
	g.Addr, g.Prefix = w.cableAddr, func(string) int { return 24 }
	return g
}

// runCable steps the guard, moving the clock on by each wait, until the cable change reaches one of the phases.
func (w *wworld) runCable(g *netguard.Guard, until ...protocol.NetworkChangePhase) protocol.CableChange {
	w.t.Helper()
	for i := 0; i < 200; i++ {
		if c := g.CableChange(); c != nil {
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
	w.t.Fatalf("stuck in %+v", g.CableChange())
	return protocol.CableChange{}
}

var ended = []protocol.NetworkChangePhase{protocol.NetworkChangePhaseCommitted, protocol.NetworkChangePhaseReverted,
	protocol.NetworkChangePhaseFailed}

func validCable(t *testing.T, c protocol.CableChange) {
	t.Helper()
	if err := (&local.CableChangeResponse{V: 1, Change: c}).Validate(); err != nil || !local.CableChangeValid(c) {
		t.Fatalf("change breaks the contract: %+v %v", c, err)
	}
}

func (w *wworld) net() protocol.HostNetwork {
	w.t.Helper()
	n, err := w.g.NetworkState(context.Background())
	if err != nil {
		w.t.Fatal(err)
	}
	if err := (&local.NetworkStateResponse{V: 1, Network: n}).Validate(); err != nil || !local.HostNetworkValid(n) {
		w.t.Fatalf("the state breaks the contract: %+v %v", n, err)
	}
	return n
}

func TestCableWifiOnlyConfirmedAndBack(t *testing.T) {
	w := newCableWorld(t)
	ctx := context.Background()
	n := w.net()
	if n.WifiOnly == nil || *n.WifiOnly || n.CableChange != nil {
		t.Fatalf("%+v", n)
	}
	e := n.Wired[0]
	if !e.Connected || !*e.Plugged || *e.Mac != "a8:e2:91:16:47:58" || *e.PrefixLength != 24 {
		t.Fatalf("wired %+v", e)
	}
	if *n.Wifi.Mac != "a8:e2:91:16:47:59" || *n.Wifi.PrefixLength != 24 {
		t.Fatalf("wifi %+v", n.Wifi)
	}

	c, err := w.g.CableSet(ctx, "wifi", 120)
	if err != nil {
		t.Fatal(err)
	}
	validCable(t, c)
	if c.Phase != protocol.NetworkChangePhaseApplying || c.Use != protocol.CableUseWifi || c.By != protocol.CableChangeByPerson ||
		w.lock.held() != "network" {
		t.Fatalf("%+v lock %q", c, w.lock.held())
	}
	// One change at a time, whatever it changes.
	if _, err := w.g.CableSet(ctx, "cable", 120); !errors.Is(err, netguard.ErrBusy) {
		t.Fatalf("a second cable change: %v", err)
	}
	if _, err := w.g.Join(ctx, netguard.WifiJoin{SSID: "Cafe", ConfirmSec: 120}); !errors.Is(err, netguard.ErrBusy) {
		t.Fatalf("a join meanwhile: %v", err)
	}
	if err := w.g.Submit(candidate("n-static1")); !errors.Is(err, netguard.ErrBusy) {
		t.Fatalf("a wired candidate meanwhile: %v", err)
	}
	w.g.Step(ctx) // applying → confirming: the dead-man is armed
	if !w.h.CableDeadmanArmed() {
		t.Fatal("a guarded change arms the helper's dead-man")
	}
	c = w.runCable(w.g, ended...)
	validCable(t, c)
	if c.Phase != protocol.NetworkChangePhaseCommitted || c.Failure != nil || w.lock.held() != "" || w.h.CableDeadmanArmed() {
		t.Fatalf("%+v", c)
	}
	if live, committed := w.h.CableState(); !live || !committed {
		t.Fatal("Wi-Fi only is kept across restarts", live, committed)
	}
	n = w.net()
	e = n.Wired[0]
	if !*n.WifiOnly || n.CableChange == nil || e.Connected || !*e.Plugged || e.Address != nil || e.PrefixLength != nil {
		t.Fatalf("switched off: %+v wired %+v", n, e)
	}
	if _, err := w.g.CableSet(ctx, "wifi", 120); !errors.Is(err, netguard.ErrUnchanged) {
		t.Fatalf("Wi-Fi only again: %v", err)
	}

	// The cable again, guarded too.
	if _, err := w.g.CableSet(ctx, "cable", 60); err != nil {
		t.Fatal(err)
	}
	c = w.runCable(w.g, ended...)
	if c.Phase != protocol.NetworkChangePhaseCommitted || c.Use != protocol.CableUseCable {
		t.Fatalf("%+v", c)
	}
	if live, committed := w.h.CableState(); live || committed {
		t.Fatal(live, committed)
	}
	if n = w.net(); *n.WifiOnly || !n.Wired[0].Connected {
		t.Fatalf("%+v", n)
	}
	if _, err := w.g.CableSet(ctx, "cable", 60); !errors.Is(err, netguard.ErrUnchanged) {
		t.Fatalf("the cable again: %v", err)
	}
	w.clock.Advance(netguard.ShownAfterEnd + time.Second)
	if w.g.CableChange() != nil {
		t.Fatal("an old change is still shown")
	}
}

func TestCableWifiWithoutInternetGoesBack(t *testing.T) {
	w := newCableWorld(t)
	if _, err := w.g.CableSet(context.Background(), "wifi", 30); err != nil {
		t.Fatal(err)
	}
	// Online before (so guarded); Wi-Fi alone doesn't reach control.
	w.ctl.up.Store(false)
	c := w.runCable(w.g, ended...)
	validCable(t, c)
	if c.Phase != protocol.NetworkChangePhaseReverted || *c.Failure != protocol.NetworkChangeFailureNoInternet ||
		w.lock.held() != "" || w.h.CableDeadmanArmed() {
		t.Fatalf("%+v", c)
	}
	if live, committed := w.h.CableState(); live || committed {
		t.Fatal("the cable is back", live, committed)
	}
	if n := w.net(); *n.WifiOnly || !n.Wired[0].Connected {
		t.Fatalf("%+v", n)
	}
}

func TestCableOfflineIsKeptAtOnce(t *testing.T) {
	w := newCableWorld(t)
	w.ctl.up.Store(false) // nothing to lose
	if _, err := w.g.CableSet(context.Background(), "wifi", 120); err != nil {
		t.Fatal(err)
	}
	checks := w.ctl.checks.Load()
	c := w.runCable(w.g, ended...)
	if c.Phase != protocol.NetworkChangePhaseCommitted || w.ctl.checks.Load() != checks || w.h.CableDeadmanArmed() {
		t.Fatalf("%+v checks %d→%d", c, checks, w.ctl.checks.Load())
	}
	if live, committed := w.h.CableState(); !live || !committed {
		t.Fatal(live, committed)
	}
}

func TestCableRefusals(t *testing.T) {
	w := newCableWorld(t)
	ctx := context.Background()
	if _, err := w.g.CableSet(ctx, "cable", 120); !errors.Is(err, netguard.ErrUnchanged) {
		t.Fatalf("the cable while it is used: %v", err)
	}
	w.f.Drop()
	if _, err := w.g.CableSet(ctx, "wifi", 120); !errors.Is(err, netguard.ErrNotConnected) {
		t.Fatalf("Wi-Fi not connected: %v", err)
	}
	w.f.NoIwd = true
	if _, err := w.g.CableSet(ctx, "wifi", 120); !errors.Is(err, netguard.ErrNoWifi) {
		t.Fatalf("no Wi-Fi: %v", err)
	}
	w.f.NoIwd = false
	w.f.ConnectTo("Office")
	if _, err := w.g.CableSet(ctx, "wifi", 120); err != nil {
		t.Fatal(err)
	}
	w.runCable(w.g, ended...)
	// Wi-Fi only, and the cable taken out: nothing to go back to.
	write(t, filepath.Join(w.sys, "class", "net", "eth0", "carrier"), "0\n")
	if _, err := w.g.CableSet(ctx, "cable", 120); !errors.Is(err, netguard.ErrNoCable) {
		t.Fatalf("no cable plugged in: %v", err)
	}
	if n := w.net(); n.Wired[0].Plugged == nil || *n.Wired[0].Plugged {
		t.Fatalf("%+v", n.Wired)
	}
	// A Wi-Fi change running: busy.
	write(t, filepath.Join(w.sys, "class", "net", "eth0", "carrier"), "1\n")
	if _, err := w.g.Join(ctx, netguard.WifiJoin{SSID: "Home", Passphrase: homePass, ConfirmSec: 120}); err != nil {
		t.Fatal(err)
	}
	if _, err := w.g.CableSet(ctx, "cable", 120); !errors.Is(err, netguard.ErrBusy) {
		t.Fatalf("during a join: %v", err)
	}
}

func TestCableManagerRestart(t *testing.T) {
	w := newCableWorld(t)
	ctx := context.Background()
	if _, err := w.g.CableSet(ctx, "wifi", 120); err != nil {
		t.Fatal(err)
	}
	// The manager died before its loop took the change: the next one makes it.
	c := w.runCable(w.cguard(), ended...)
	if c.Phase != protocol.NetworkChangePhaseCommitted {
		t.Fatalf("%+v", c)
	}
	// Died while confirming, back after the deadline: the change goes back.
	if _, err := w.g.CableSet(ctx, "cable", 60); err != nil {
		t.Fatal(err)
	}
	w.runCable(w.g, protocol.NetworkChangePhaseConfirming)
	if live, _ := w.h.CableState(); live {
		t.Fatal("the cable is on while confirming")
	}
	w.clock.Advance(2 * time.Minute)
	c = w.runCable(w.cguard(), ended...)
	if c.Phase != protocol.NetworkChangePhaseReverted || *c.Failure != protocol.NetworkChangeFailureNoInternet {
		t.Fatalf("%+v", c)
	}
	if live, committed := w.h.CableState(); !live || !committed {
		t.Fatal("back to Wi-Fi only", live, committed)
	}
}

func TestCableHostRestartWhileConfirming(t *testing.T) {
	w := newCableWorld(t)
	if _, err := w.g.CableSet(context.Background(), "wifi", 120); err != nil {
		t.Fatal(err)
	}
	w.runCable(w.g, protocol.NetworkChangePhaseConfirming)
	w.h.SimulateCableRestart() // the kept setting (the cable) came back at the start
	c := w.runCable(w.cguard(), ended...)
	validCable(t, c)
	if c.Phase != protocol.NetworkChangePhaseReverted || *c.Failure != protocol.NetworkChangeFailureFailed || w.lock.held() != "" {
		t.Fatalf("%+v", c)
	}
	if live, committed := w.h.CableState(); live || committed {
		t.Fatal(live, committed)
	}
}

func TestCableDeadmanUndoesAChangeNobodyConfirmed(t *testing.T) {
	w := newCableWorld(t)
	if _, err := w.g.CableSet(context.Background(), "wifi", 120); err != nil {
		t.Fatal(err)
	}
	w.runCable(w.g, protocol.NetworkChangePhaseConfirming)
	if err := w.h.FireCableDeadman(); err != nil {
		t.Fatal(err)
	}
	if live, _ := w.h.CableState(); live {
		t.Fatal("the dead-man put the cable back")
	}
	c := w.runCable(w.g, ended...)
	if c.Phase != protocol.NetworkChangePhaseReverted {
		t.Fatalf("%+v", c)
	}
}

// backup runs the cable-as-backup check every minute for d.
func (w *wworld) backup(d time.Duration) *protocol.CableChange {
	w.t.Helper()
	for end := w.clock.Now().Add(d); !w.clock.Now().After(end); w.clock.Advance(w.g.BackupEvery()) {
		c, err := w.g.BackupStep(context.Background())
		if err != nil {
			w.t.Fatal(err)
		}
		if c != nil {
			return c
		}
	}
	return nil
}

func TestCableIsTheBackup(t *testing.T) {
	w := newCableWorld(t)
	ctx := context.Background()
	// Not Wi-Fi only: the backup checks nothing.
	checks := w.ctl.checks.Load()
	if c := w.backup(10 * time.Minute); c != nil || w.ctl.checks.Load() != checks {
		t.Fatalf("%+v checks %d→%d", c, checks, w.ctl.checks.Load())
	}
	if _, err := w.g.CableSet(ctx, "wifi", 120); err != nil {
		t.Fatal(err)
	}
	w.runCable(w.g, ended...)
	// Online on Wi-Fi: nothing happens.
	if c := w.backup(10 * time.Minute); c != nil {
		t.Fatalf("%+v", c)
	}
	// Offline, but no cable plugged in: nothing to go back to.
	w.ctl.up.Store(false)
	write(t, filepath.Join(w.sys, "class", "net", "eth0", "carrier"), "0\n")
	if c := w.backup(10 * time.Minute); c != nil {
		t.Fatalf("%+v", c)
	}
	// Control back for a moment starts the count again.
	w.ctl.up.Store(true)
	w.backup(0)
	w.ctl.up.Store(false)
	write(t, filepath.Join(w.sys, "class", "net", "eth0", "carrier"), "1\n")
	if c := w.backup(4 * time.Minute); c != nil {
		t.Fatalf("after 4 minutes: %+v", c)
	}
	c := w.backup(2 * time.Minute)
	if c == nil || c.By != protocol.CableChangeByBackup || c.Use != protocol.CableUseCable {
		t.Fatalf("after 5 minutes: %+v", c)
	}
	// Guarded like a person's change: the cable reaches control, so it is kept and Wi-Fi only is over.
	w.runCable(w.g, protocol.NetworkChangePhaseConfirming)
	if !w.h.CableDeadmanArmed() {
		t.Fatal("the backup arms the dead-man")
	}
	w.ctl.up.Store(true)
	got := w.runCable(w.g, ended...)
	validCable(t, got)
	if got.Phase != protocol.NetworkChangePhaseCommitted || got.ID != c.ID || w.h.CableDeadmanArmed() {
		t.Fatalf("%+v", got)
	}
	if live, committed := w.h.CableState(); live || committed {
		t.Fatal(live, committed)
	}
	if n := w.net(); *n.WifiOnly || n.CableChange == nil || n.CableChange.By != protocol.CableChangeByBackup {
		t.Fatalf("%+v", n)
	}
}

func TestCableBackupThatDoesntHelpIsUndone(t *testing.T) {
	w := newCableWorld(t)
	ctx := context.Background()
	if _, err := w.g.CableSet(ctx, "wifi", 120); err != nil {
		t.Fatal(err)
	}
	w.runCable(w.g, ended...)
	// The internet is out: neither Wi-Fi nor the cable reaches control.
	w.ctl.up.Store(false)
	c := w.backup(7 * time.Minute)
	if c == nil {
		t.Fatal("the cable is tried after 5 minutes")
	}
	got := w.runCable(w.g, ended...)
	validCable(t, got)
	if got.Phase != protocol.NetworkChangePhaseReverted || *got.Failure != protocol.NetworkChangeFailureNoInternet ||
		w.h.CableDeadmanArmed() || w.lock.held() != "" {
		t.Fatalf("%+v", got)
	}
	// Wi-Fi only stays: the person's choice wasn't the problem.
	if live, committed := w.h.CableState(); !live || !committed {
		t.Fatal("still Wi-Fi only", live, committed)
	}
	if n := w.net(); !*n.WifiOnly {
		t.Fatalf("%+v", n)
	}
	// The next try waits half an hour, however long control stays out of reach.
	if c := w.backup(25 * time.Minute); c != nil {
		t.Fatalf("tried again too soon: %+v", c)
	}
	if c := w.backup(10 * time.Minute); c == nil || c.ID == got.ID {
		t.Fatalf("tried again after half an hour: %+v", c)
	}
}

func TestCableAgainWaitsForTheCablesAddress(t *testing.T) {
	w := newCableWorld(t)
	ctx := context.Background()
	if _, err := w.g.CableSet(ctx, "wifi", 120); err != nil {
		t.Fatal(err)
	}
	w.runCable(w.g, ended...)
	// The cable's network is slow to give an address (or never does): Wi-Fi still reaches control meanwhile, which
	// says nothing about the cable.
	var leased atomic.Bool
	w.g.Addr = func(iface string) string {
		if iface == "eth0" && !leased.Load() {
			return ""
		}
		return w.cableAddr(iface)
	}
	if _, err := w.g.CableSet(ctx, "cable", 60); err != nil {
		t.Fatal(err)
	}
	w.runCable(w.g, protocol.NetworkChangePhaseConfirming)
	for i := 0; i < 20; i++ {
		wait, err := w.g.Step(ctx)
		if err != nil {
			t.Fatal(err)
		}
		w.clock.Advance(wait)
	}
	if c := w.g.CableChange(); c == nil || c.Phase != protocol.NetworkChangePhaseConfirming {
		t.Fatalf("kept before the cable had an address: %+v", c)
	}
	leased.Store(true)
	if c := w.runCable(w.g, ended...); c.Phase != protocol.NetworkChangePhaseCommitted {
		t.Fatalf("%+v", c)
	}

	// A cable that never gets an address goes back to Wi-Fi only.
	leased.Store(false)
	if _, err := w.g.CableSet(ctx, "wifi", 120); err != nil {
		t.Fatal(err)
	}
	w.runCable(w.g, ended...)
	if _, err := w.g.CableSet(ctx, "cable", 60); err != nil {
		t.Fatal(err)
	}
	c := w.runCable(w.g, ended...)
	if c.Phase != protocol.NetworkChangePhaseReverted || *c.Failure != protocol.NetworkChangeFailureNoInternet {
		t.Fatalf("%+v", c)
	}
	if live, committed := w.h.CableState(); !live || !committed {
		t.Fatal("back to Wi-Fi only", live, committed)
	}
}
