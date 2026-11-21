package service

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/bluetooth/internal/bluez"
	"github.com/CybexBV/whombat/contracts/go/local"
	"github.com/CybexBV/whombat/contracts/go/protocol"
)

type fakeClock struct {
	mu     sync.Mutex
	now    time.Time
	timers []*fakeTimer
}

type fakeTimer struct {
	c       *fakeClock
	at      time.Time
	f       func()
	stopped bool
}

func (t *fakeTimer) Stop() bool {
	t.c.mu.Lock()
	defer t.c.mu.Unlock()
	was := !t.stopped
	t.stopped = true
	return was
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *fakeClock) AfterFunc(d time.Duration, f func()) Timer {
	c.mu.Lock()
	defer c.mu.Unlock()
	t := &fakeTimer{c: c, at: c.now.Add(d), f: f}
	c.timers = append(c.timers, t)
	return t
}

// advance moves the clock on, firing the timers that come due on the way, in order.
func (c *fakeClock) advance(d time.Duration) {
	c.mu.Lock()
	end := c.now.Add(d)
	c.mu.Unlock()
	for {
		c.mu.Lock()
		sort.SliceStable(c.timers, func(i, j int) bool { return c.timers[i].at.Before(c.timers[j].at) })
		var due *fakeTimer
		for _, t := range c.timers {
			if !t.stopped && !t.at.After(end) {
				due = t
				break
			}
		}
		if due == nil {
			c.now = end
			c.mu.Unlock()
			return
		}
		due.stopped = true
		c.now = due.at
		c.mu.Unlock()
		due.f()
	}
}

var t0 = time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)

const hci0 = "/org/bluez/hci0"

func path(addr string) string { return hci0 + "/dev_" + strings.ReplaceAll(addr, ":", "_") }

func u32(v uint32) *uint32 { return &v }
func u16(v uint16) *uint16 { return &v }
func i16(v int16) *int16   { return &v }
func u8(v uint8) *uint8    { return &v }

const (
	keychron = "AA:00:00:00:00:01"
	sony     = "AA:00:00:00:00:02"
	mx       = "AA:00:00:00:00:03"
	magic    = "AA:00:00:00:00:04"
	jbl      = "AA:00:00:00:00:05"
	pixel    = "AA:00:00:00:00:06"
	nameless = "AA:00:00:00:00:07"
	old      = "AA:00:00:00:00:08"
)

func dev(addr, name, icon string, mod func(*bluez.Device)) bluez.Device {
	d := bluez.Device{Path: path(addr), Adapter: hci0, Address: addr, Name: name, Alias: name, Icon: icon}
	if name == "" {
		d.Alias = strings.ReplaceAll(addr, ":", "-")
	}
	if mod != nil {
		mod(&d)
	}
	return d
}

func seen(rssi int16) func(*bluez.Device) { return func(d *bluez.Device) { d.RSSI = i16(rssi) } }

type rig struct {
	t     *testing.T
	clock *fakeClock
	bz    *bluez.Fake
	s     *Service
	logs  []string
	mu    sync.Mutex
}

func sysfs(t *testing.T, hci bool) string {
	sys := t.TempDir()
	if hci {
		if err := os.MkdirAll(filepath.Join(sys, "class", "bluetooth", "hci0"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	return sys
}

func newRig(t *testing.T) *rig {
	r := &rig{t: t, clock: &fakeClock{now: t0}}
	r.bz = bluez.NewFake(
		[]bluez.Adapter{{Path: hci0, Address: "00:11:22:33:44:55", Alias: "whombat", Powered: true, PowerState: "on"}},
		[]bluez.Device{
			dev(keychron, "Keychron K3", "input-keyboard", func(d *bluez.Device) {
				d.Paired, d.Bonded, d.Trusted, d.Connected, d.Battery = true, true, true, true, u8(80)
			}),
			dev(sony, "WH-1000XM5", "audio-headphones", func(d *bluez.Device) { d.Paired, d.Bonded, d.Trusted = true, true, true }),
			dev(mx, "MX Master 3S", "input-mouse", seen(-55)),
			dev(magic, "Magic Keyboard", "input-keyboard", seen(-72)),
			dev(jbl, "JBL Flip 6", "audio-card", seen(-65)),
			dev(pixel, "Pixel 9", "phone", seen(-40)),
			dev(nameless, "", "input-mouse", seen(-50)),
			dev(old, "Old headset", "", func(d *bluez.Device) { d.Class = u32(0x240404) }),
		},
	)
	cfg := Defaults()
	cfg.Sys = sysfs(t, true)
	r.s = New(cfg, r.bz, r.clock, func(f string, a ...any) {
		r.mu.Lock()
		defer r.mu.Unlock()
		r.logs = append(r.logs, strings.TrimSpace(fmt.Sprintf(f, a...)))
	})
	n := 0
	r.s.newID = func() string { n++; return "p-test" + strings.Repeat("0", 8) + string(rune('a'+n)) }
	return r
}

func (r *rig) state() protocol.BluetoothState {
	r.t.Helper()
	st, err := r.s.State()
	if err != nil {
		r.t.Fatal(err)
	}
	// Every state is the contract's, and consistent.
	a := local.BluetoothStateAnswer{V: 1, Bluetooth: st}
	if err := a.Validate(); err != nil || !local.BluetoothStateValid(st) {
		r.t.Fatalf("not a valid state (%v): %+v", err, st)
	}
	return st
}

// wait waits for the running pairing's goroutine to be done.
func (r *rig) wait() {
	r.t.Helper()
	r.s.mu.Lock()
	p := r.s.pairing
	r.s.mu.Unlock()
	select {
	case <-p.done:
	case <-time.After(5 * time.Second):
		r.t.Fatal("the pairing didn't finish")
	}
}

// until polls the state until ok (the agent runs in BlueZ's goroutine).
func (r *rig) until(what string, ok func(protocol.BluetoothState) bool) protocol.BluetoothState {
	r.t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		st := r.state()
		if ok(st) {
			return st
		}
		if time.Now().After(deadline) {
			r.t.Fatalf("never %s: %+v", what, st.Pairing)
		}
		time.Sleep(time.Millisecond)
	}
}

func phase(ph protocol.BluetoothPairingPhase) func(protocol.BluetoothState) bool {
	return func(st protocol.BluetoothState) bool { return st.Pairing != nil && st.Pairing.Phase == ph }
}

func code(t *testing.T, err error) string {
	t.Helper()
	var e *Error
	if !errors.As(err, &e) {
		t.Fatalf("not a service error: %v", err)
	}
	return e.Code
}

func (r *rig) noAddressLogged() {
	r.t.Helper()
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, l := range r.logs {
		if addressRE.MatchString(l) || strings.Contains(l, "AA:00") || strings.Contains(l, "AA_00") || strings.Contains(l, "AA-00") {
			r.t.Errorf("an address in the log: %q", l)
		}
	}
}

var addressRE = regexp.MustCompile(`[0-9A-Fa-f]{2}([:_-][0-9A-Fa-f]{2}){5}`)

func names(ds []protocol.BluetoothDevice) []string {
	var out []string
	for _, d := range ds {
		out = append(out, d.Name)
	}
	return out
}

func TestStatePairedDevices(t *testing.T) {
	r := newRig(t)
	st := r.state()
	if st.Adapter == nil || st.Adapter.Name != "whombat" || !st.Adapter.Powered || st.Missing != nil {
		t.Fatalf("adapter %+v missing %v", st.Adapter, st.Missing)
	}
	// Connected first, then by name; only paired ones; no bars.
	if got := names(st.Devices); !slices.Equal(got, []string{"Keychron K3", "WH-1000XM5"}) {
		t.Fatalf("devices %v", got)
	}
	k := st.Devices[0]
	if k.Kind != protocol.BluetoothKindKeyboard || !k.Connected || k.Battery == nil || *k.Battery != 80 || k.Signal != nil {
		t.Fatalf("keyboard %+v", k)
	}
	if st.Devices[1].Kind != protocol.BluetoothKindHeadphones || st.Devices[1].Connected || st.Devices[1].Battery != nil {
		t.Fatalf("headphones %+v", st.Devices[1])
	}
	if st.Scan != nil || st.Pairing != nil {
		t.Fatalf("scan %v pairing %v", st.Scan, st.Pairing)
	}
}

func TestStateMissing(t *testing.T) {
	r := newRig(t)
	// No controller in sysfs: BlueZ isn't asked (it would be started for nothing).
	r.s.cfg.Sys = sysfs(t, false)
	r.bz.Down = true
	st := r.state()
	if st.Adapter != nil || st.Missing == nil || *st.Missing != protocol.BluetoothMissingNoAdapter || len(st.Devices) != 0 {
		t.Fatalf("%+v", st)
	}
	// A USB Bluetooth controller without a driver.
	iface := filepath.Join(r.s.cfg.Sys, "bus", "usb", "devices", "1-4:1.0")
	_ = os.MkdirAll(iface, 0o755)
	for k, v := range map[string]string{"bInterfaceClass": "e0", "bInterfaceSubClass": "01", "bInterfaceProtocol": "01"} {
		_ = os.WriteFile(filepath.Join(iface, k), []byte(v+"\n"), 0o644)
	}
	if st := r.state(); *st.Missing != protocol.BluetoothMissingNoDriver {
		t.Fatalf("%+v", st)
	}
	// With its driver bound the kernel registers a controller; while it doesn't, it's still the driver.
	_ = os.Symlink("../../../../bus/usb/drivers/btusb", filepath.Join(iface, "driver"))
	if st := r.state(); *st.Missing != protocol.BluetoothMissingNoAdapter {
		t.Fatalf("%+v", st)
	}
	// A controller BlueZ doesn't show (its firmware didn't load).
	r.s.cfg.Sys = sysfs(t, true)
	r.bz.Down = false
	empty := bluez.NewFake(nil, nil)
	r.s.bz = empty
	if st := r.state(); st.Adapter != nil || *st.Missing != protocol.BluetoothMissingNoDriver {
		t.Fatalf("%+v", st)
	}
	// Switched off.
	r.s.bz = r.bz
	r.bz.Update(hci0, nil, func(a *bluez.Adapter) { a.Powered, a.PowerState = false, "off-blocked" })
	st = r.state()
	if st.Adapter == nil || st.Adapter.Powered || *st.Missing != protocol.BluetoothMissingDisabled {
		t.Fatalf("%+v", st)
	}
	if _, err := r.s.Scan(); code(t, err) != local.BluetoothErrorNoBluetooth {
		t.Fatal(err)
	}
	if _, err := r.s.Pair(mx); code(t, err) != local.BluetoothErrorNoBluetooth {
		t.Fatal(err)
	}
	if _, err := r.s.Connect(sony); code(t, err) != local.BluetoothErrorNoBluetooth {
		t.Fatal(err)
	}
	// bluetoothd not answering.
	r.bz.Down = true
	if _, err := r.s.State(); code(t, err) != local.BluetoothErrorUnavailable {
		t.Fatal(err)
	}
}

func TestScan(t *testing.T) {
	r := newRig(t)
	sc, err := r.s.Scan()
	if err != nil {
		t.Fatal(err)
	}
	if sc.Until != "2026-10-20T12:01:00.000Z" {
		t.Fatalf("until %s", sc.Until)
	}
	// Not paired, named, seen, no phones; strongest first.
	if got := names(sc.Devices); !slices.Equal(got, []string{"MX Master 3S", "JBL Flip 6", "Magic Keyboard"}) {
		t.Fatalf("found %v", got)
	}
	if *sc.Devices[0].Signal != 4 || *sc.Devices[1].Signal != 3 || *sc.Devices[2].Signal != 2 {
		t.Fatalf("bars %+v", sc.Devices)
	}
	if sc.Devices[1].Kind != protocol.BluetoothKindSpeaker {
		t.Fatalf("JBL %+v", sc.Devices[1])
	}
	if st := r.state(); st.Scan == nil || len(st.Scan.Devices) != 3 {
		t.Fatalf("state's scan %+v", st.Scan)
	}
	// Asked again after 50 s: a minute from then, BlueZ not asked to start again.
	r.clock.advance(50 * time.Second)
	sc, _ = r.s.Scan()
	if sc.Until != "2026-10-20T12:01:50.000Z" {
		t.Fatalf("until %s", sc.Until)
	}
	r.clock.advance(59 * time.Second)
	if st := r.state(); st.Scan == nil {
		t.Fatal("stopped early")
	}
	r.clock.advance(time.Second)
	if st := r.state(); st.Scan != nil {
		t.Fatalf("still looking %+v", st.Scan)
	}
	calls := r.bz.Calls()
	if got := slices.DeleteFunc(slices.Clone(calls), func(c string) bool { return !strings.Contains(c, "Discovery") }); !slices.Equal(got, []string{"StartDiscovery " + hci0, "StopDiscovery " + hci0}) {
		t.Fatalf("calls %v", calls)
	}
	// BlueZ stopped looking by itself (the connection dropped): asked again, it starts again.
	r.s.Scan()
	r.bz.Update(hci0, nil, func(a *bluez.Adapter) { a.Discovering = false })
	r.s.Scan()
	if n := len(slices.DeleteFunc(r.bz.Calls(), func(c string) bool { return !strings.HasPrefix(c, "StartDiscovery") })); n != 3 {
		t.Fatalf("%d starts", n)
	}
	r.noAddressLogged()
}

func TestScanCap(t *testing.T) {
	r := newRig(t)
	for i := range 70 {
		a := "BB:00:00:00:00:" + strings.ToUpper(string("0123456789abcdef"[i/16])+string("0123456789abcdef"[i%16]))
		r.bz.Add(dev(a, "Mouse "+a, "input-mouse", seen(int16(-30-i))))
	}
	sc, err := r.s.Scan()
	if err != nil || len(sc.Devices) != local.BluetoothScanMax {
		t.Fatalf("%d %v", len(sc.Devices), err)
	}
}

func TestPairJustWorks(t *testing.T) {
	r := newRig(t)
	r.s.Scan()
	p, err := r.s.Pair(mx)
	if err != nil {
		t.Fatal(err)
	}
	if p.ID == "" || p.Phase != protocol.BluetoothPairingPhasePairing || p.Name != "MX Master 3S" || p.Kind != protocol.BluetoothKindMouse ||
		p.Deadline != "2026-10-20T12:01:30.000Z" || p.Code != nil || p.Failure != nil {
		t.Fatalf("%+v", p)
	}
	r.wait()
	st := r.state()
	if st.Pairing == nil || st.Pairing.Phase != protocol.BluetoothPairingPhaseDone || st.Scan != nil {
		t.Fatalf("pairing %+v scan %+v", st.Pairing, st.Scan)
	}
	if got := names(st.Devices); !slices.Equal(got, []string{"Keychron K3", "MX Master 3S", "WH-1000XM5"}) {
		t.Fatalf("devices %v", got)
	}
	want := []string{"StopDiscovery " + hci0, "RegisterAgent DisplayYesNo", "Pair " + path(mx), "SetTrusted " + path(mx),
		"Connect " + path(mx), "UnregisterAgent "}
	if got := r.bz.Calls()[1:]; !slices.Equal(got, want) {
		t.Fatalf("calls %v", got)
	}
	if r.bz.Agent() != nil {
		t.Fatal("the agent stays")
	}
	// Kept a minute, then gone.
	r.clock.advance(59 * time.Second)
	if r.state().Pairing == nil {
		t.Fatal("gone early")
	}
	r.clock.advance(time.Second)
	if r.state().Pairing != nil {
		t.Fatal("still there")
	}
	r.noAddressLogged()
}

func TestPairPasskeyTyped(t *testing.T) {
	r := newRig(t)
	typed := make(chan uint16)
	r.bz.Script(path(magic), func(ctx context.Context, a bluez.Agent) error {
		a.DisplayPasskey(path(magic), 42, 0)
		for n := range typed {
			a.DisplayPasskey(path(magic), 42, n)
		}
		return nil
	})
	if _, err := r.s.Pair(magic); err != nil {
		t.Fatal(err)
	}
	st := r.until("shows the code", phase(protocol.BluetoothPairingPhaseCode))
	if *st.Pairing.Code != "000042" || st.Pairing.Typed != nil {
		t.Fatalf("%+v", st.Pairing)
	}
	typed <- 1
	typed <- 2
	st = r.until("two typed", func(st protocol.BluetoothState) bool { return st.Pairing.Typed != nil && *st.Pairing.Typed == 2 })
	typed <- 7 // BlueZ counts the Enter key too
	r.until("six typed", func(st protocol.BluetoothState) bool { return *st.Pairing.Typed == 6 })
	close(typed)
	r.wait()
	if st := r.state(); st.Pairing.Phase != protocol.BluetoothPairingPhaseDone || st.Pairing.Code != nil || st.Pairing.Typed != nil {
		t.Fatalf("%+v", st.Pairing)
	}
}

func TestPairPinCode(t *testing.T) {
	r := newRig(t)
	shown := make(chan error, 1)
	r.bz.Script(path(magic), func(ctx context.Context, a bluez.Agent) error {
		if err := a.DisplayPinCode(path(magic), "1234567"); err == nil {
			return errors.New("a 7-digit PIN shown")
		}
		shown <- a.DisplayPinCode(path(magic), "583201")
		<-ctx.Done()
		return ctx.Err()
	})
	r.s.Pair(magic)
	if err := <-shown; err != nil {
		t.Fatal(err)
	}
	st := r.state()
	if st.Pairing.Phase != protocol.BluetoothPairingPhaseCode || *st.Pairing.Code != "583201" {
		t.Fatalf("%+v", st.Pairing)
	}
	// The deadline: timed out, BlueZ's pairing canceled.
	r.clock.advance(90 * time.Second)
	r.wait()
	st = r.state()
	if st.Pairing.Phase != protocol.BluetoothPairingPhaseFailed || *st.Pairing.Failure != protocol.BluetoothPairingFailureTimeout || st.Pairing.Code != nil {
		t.Fatalf("%+v", st.Pairing)
	}
	calls := r.bz.Calls()
	if !slices.Contains(calls, "CancelPairing "+path(magic)) || calls[len(calls)-1] != "UnregisterAgent " ||
		slices.Contains(calls, "SetTrusted "+path(magic)) {
		t.Fatalf("calls %v", calls)
	}
}

func confirmScript(r *rig, addr string, result chan<- error) {
	r.bz.Script(path(addr), func(ctx context.Context, a bluez.Agent) error {
		err := a.RequestConfirmation(path(addr), 123456)
		result <- err
		if err != nil {
			return &bluez.Error{Name: bluez.ErrorAuthenticationRejected}
		}
		return nil
	})
}

func TestPairConfirm(t *testing.T) {
	r := newRig(t)
	result := make(chan error, 1)
	confirmScript(r, jbl, result)
	p, _ := r.s.Pair(jbl)
	st := r.until("asks", phase(protocol.BluetoothPairingPhaseConfirm))
	if *st.Pairing.Code != "123456" {
		t.Fatalf("%+v", st.Pairing)
	}
	if _, err := r.s.Confirm("p-someoneelse00", true); code(t, err) != local.BluetoothErrorNotFound {
		t.Fatal(err)
	}
	got, err := r.s.Confirm(p.ID, true)
	if err != nil || got.Phase != protocol.BluetoothPairingPhasePairing {
		t.Fatalf("%+v %v", got, err)
	}
	if err := <-result; err != nil {
		t.Fatal(err)
	}
	r.wait()
	if st := r.state(); st.Pairing.Phase != protocol.BluetoothPairingPhaseDone {
		t.Fatalf("%+v", st.Pairing)
	}
	// A late answer: the pairing as it is.
	if got, err := r.s.Confirm(p.ID, false); err != nil || got.Phase != protocol.BluetoothPairingPhaseDone {
		t.Fatalf("%+v %v", got, err)
	}
}

func TestPairConfirmNo(t *testing.T) {
	r := newRig(t)
	result := make(chan error, 1)
	confirmScript(r, jbl, result)
	p, _ := r.s.Pair(jbl)
	r.until("asks", phase(protocol.BluetoothPairingPhaseConfirm))
	got, err := r.s.Confirm(p.ID, false)
	if err != nil || got.Phase != protocol.BluetoothPairingPhaseFailed || *got.Failure != protocol.BluetoothPairingFailureFailed {
		t.Fatalf("%+v %v", got, err)
	}
	if err := <-result; !errors.Is(err, bluez.ErrRejected) {
		t.Fatal(err)
	}
	r.wait()
	if st := r.state(); *st.Pairing.Failure != protocol.BluetoothPairingFailureFailed {
		t.Fatalf("%+v", st.Pairing)
	}
	if slices.Contains(r.bz.Calls(), "SetTrusted "+path(jbl)) {
		t.Fatal("trusted")
	}
}

func TestPairCancel(t *testing.T) {
	r := newRig(t)
	result := make(chan error, 1)
	confirmScript(r, jbl, result)
	p, _ := r.s.Pair(jbl)
	r.until("asks", phase(protocol.BluetoothPairingPhaseConfirm))
	got, err := r.s.Cancel(p.ID)
	if err != nil || got.Phase != protocol.BluetoothPairingPhaseFailed || *got.Failure != protocol.BluetoothPairingFailureCanceled {
		t.Fatalf("%+v %v", got, err)
	}
	if err := <-result; err == nil {
		t.Fatal("confirmed after a cancel")
	}
	r.wait()
	if !slices.Contains(r.bz.Calls(), "CancelPairing "+path(jbl)) {
		t.Fatalf("calls %v", r.bz.Calls())
	}
	// Again: as it is.
	if got, _ := r.s.Cancel(p.ID); *got.Failure != protocol.BluetoothPairingFailureCanceled {
		t.Fatalf("%+v", got)
	}
}

func TestPairCanceledButPaired(t *testing.T) {
	// BlueZ finished the pairing just as the owner closed the dialog: the device is removed again.
	r := newRig(t)
	release := make(chan struct{})
	r.bz.Script(path(mx), func(ctx context.Context, a bluez.Agent) error {
		<-release
		r.bz.Update(path(mx), func(d *bluez.Device) { d.Paired, d.Bonded = true, true }, nil)
		return nil
	})
	p, _ := r.s.Pair(mx)
	r.s.Cancel(p.ID)
	close(release)
	r.wait()
	if !slices.Contains(r.bz.Calls(), "RemoveDevice "+path(mx)) {
		t.Fatalf("calls %v", r.bz.Calls())
	}
}

func TestPairBusyAndNotFound(t *testing.T) {
	r := newRig(t)
	release := make(chan struct{})
	r.bz.Script(path(mx), func(ctx context.Context, a bluez.Agent) error { <-release; return nil })
	if _, err := r.s.Pair(mx); err != nil {
		t.Fatal(err)
	}
	if _, err := r.s.Pair(jbl); code(t, err) != local.BluetoothErrorBusy {
		t.Fatal(err)
	}
	if _, err := r.s.Scan(); code(t, err) != local.BluetoothErrorBusy {
		t.Fatal(err)
	}
	if err := r.s.Forget(mx); code(t, err) != local.BluetoothErrorNotPaired {
		t.Fatal(err)
	}
	close(release)
	r.wait()
	for _, a := range []string{pixel, "CC:00:00:00:00:00"} {
		if _, err := r.s.Pair(a); code(t, err) != local.BluetoothErrorNotFound {
			t.Fatalf("%s: %v", a, err)
		}
	}
}

func TestAgentRefusals(t *testing.T) {
	r := newRig(t)
	got := make(chan []error, 1)
	r.bz.Script(path(old), func(ctx context.Context, a bluez.Agent) error {
		var errs []error
		pin, err := a.RequestPinCode(path(old))
		if pin != "0000" || err != nil {
			errs = append(errs, errors.New("no 0000"))
		}
		_, err = a.RequestPinCode(path(old)) // once only
		errs = append(errs, err)
		errs = append(errs, a.RequestAuthorization(path(mx)))                                     // not the device being paired
		errs = append(errs, a.AuthorizeService(path(mx), "0000110b-0000-1000-8000-00805f9b34fb")) // nor its services
		errs = append(errs, a.RequestConfirmation(path(mx), 1))
		_, err = a.RequestPinCode(path(mx))
		errs = append(errs, err)
		if a.RequestAuthorization(path(old)) != nil || a.AuthorizeService(path(old), "x") != nil {
			errs = append(errs, nil)
		}
		_, err = a.RequestPasskey(path(old)) // a code typed into the box
		errs = append(errs, err)
		got <- errs
		return &bluez.Error{Name: bluez.ErrorAuthenticationCanceled}
	})
	r.s.Pair(old)
	for i, err := range <-got {
		if !errors.Is(err, bluez.ErrRejected) {
			t.Errorf("%d: %v", i, err)
		}
	}
	r.wait()
	// It wanted a code typed into the box: failed, whatever BlueZ said.
	if st := r.state(); *st.Pairing.Failure != protocol.BluetoothPairingFailureFailed || st.Pairing.Kind != protocol.BluetoothKindHeadset {
		t.Fatalf("%+v", st.Pairing)
	}
	// After the pairing the agent answers nothing.
	p := r.s.pairing
	if err := p.RequestAuthorization(path(old)); !errors.Is(err, bluez.ErrRejected) {
		t.Fatal(err)
	}
}

func TestPairFailures(t *testing.T) {
	for _, c := range []struct {
		err  error
		want protocol.BluetoothPairingFailure
	}{
		{&bluez.Error{Name: bluez.ErrorAuthenticationRejected}, protocol.BluetoothPairingFailureRejected},
		{&bluez.Error{Name: bluez.ErrorAuthenticationFailed}, protocol.BluetoothPairingFailureRejected},
		{&bluez.Error{Name: bluez.ErrorAuthenticationTimeout}, protocol.BluetoothPairingFailureTimeout},
		{&bluez.Error{Name: bluez.ErrorConnectionAttempt, Message: "Page Timeout"}, protocol.BluetoothPairingFailureTimeout},
		{bluez.ErrNoObject, protocol.BluetoothPairingFailureNotFound},
		{&bluez.Error{Name: bluez.ErrorFailed}, protocol.BluetoothPairingFailureFailed},
		{bluez.ErrNoBlueZ, protocol.BluetoothPairingFailureFailed},
	} {
		r := newRig(t)
		r.bz.Fail("Pair", c.err)
		r.s.Pair(mx)
		r.wait()
		st := r.state()
		if st.Pairing.Phase != protocol.BluetoothPairingPhaseFailed || *st.Pairing.Failure != c.want {
			t.Errorf("%v: %+v", c.err, st.Pairing)
		}
		if r.bz.Agent() != nil {
			t.Errorf("%v: the agent stays", c.err)
		}
		r.noAddressLogged()
	}
	// Already paired as BlueZ says: done.
	r := newRig(t)
	r.bz.Fail("Pair", &bluez.Error{Name: bluez.ErrorAlreadyExists})
	r.s.Pair(mx)
	r.wait()
	if st := r.state(); st.Pairing.Phase != protocol.BluetoothPairingPhaseDone {
		t.Fatalf("%+v", st.Pairing)
	}
}

func TestPairConnectFails(t *testing.T) {
	// Paired and trusted but not there yet: done, not connected (NX-356).
	r := newRig(t)
	r.bz.Fail("Connect", &bluez.Error{Name: "org.bluez.Error.Failed", Message: "br-connection-profile-unavailable"})
	r.s.Pair(mx)
	r.wait()
	st := r.state()
	if st.Pairing.Phase != protocol.BluetoothPairingPhaseDone {
		t.Fatalf("%+v", st.Pairing)
	}
	for _, d := range st.Devices {
		if d.Address == mx && d.Connected {
			t.Fatal("connected")
		}
	}
}

func TestPairAlreadyPaired(t *testing.T) {
	r := newRig(t)
	r.s.Pair(sony)
	r.wait()
	if st := r.state(); st.Pairing.Phase != protocol.BluetoothPairingPhaseDone || slices.Contains(r.bz.Calls(), "Pair "+path(sony)) {
		t.Fatalf("%+v %v", st.Pairing, r.bz.Calls())
	}
}

func TestConnectDisconnectForget(t *testing.T) {
	r := newRig(t)
	d, err := r.s.Connect(sony)
	if err != nil || !d.Connected || d.Name != "WH-1000XM5" {
		t.Fatalf("%+v %v", d, err)
	}
	d, err = r.s.Disconnect(sony)
	if err != nil || d.Connected {
		t.Fatalf("%+v %v", d, err)
	}
	// A device that doesn't come: answered as it is.
	r.bz.Fail("Connect", &bluez.Error{Name: "org.bluez.Error.Failed", Message: "Host is down"})
	if d, err := r.s.Connect(sony); err != nil || d.Connected {
		t.Fatalf("%+v %v", d, err)
	}
	if _, err := r.s.Connect(mx); code(t, err) != local.BluetoothErrorNotPaired {
		t.Fatal(err)
	}
	if _, err := r.s.Disconnect("CC:00:00:00:00:00"); code(t, err) != local.BluetoothErrorNotFound {
		t.Fatal(err)
	}
	r.bz.Fail("Disconnect", &bluez.Error{Name: "org.bluez.Error.Failed"})
	if _, err := r.s.Disconnect(sony); code(t, err) != local.BluetoothErrorUnavailable {
		t.Fatal(err)
	}
	if err := r.s.Forget(sony); err != nil {
		t.Fatal(err)
	}
	if got := names(r.state().Devices); !slices.Equal(got, []string{"Keychron K3"}) {
		t.Fatalf("devices %v", got)
	}
	if err := r.s.Forget(sony); code(t, err) != local.BluetoothErrorNotFound {
		t.Fatal(err)
	}
	r.noAddressLogged()
}

func TestClose(t *testing.T) {
	r := newRig(t)
	result := make(chan error, 1)
	confirmScript(r, jbl, result)
	r.s.Pair(jbl)
	r.until("asks", phase(protocol.BluetoothPairingPhaseConfirm))
	r.s.Close()
	<-result
	r.wait()
	if st := r.state(); *st.Pairing.Failure != protocol.BluetoothPairingFailureCanceled {
		t.Fatalf("%+v", st.Pairing)
	}
}
