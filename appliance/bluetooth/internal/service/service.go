// Package service is whombat-bluetooth's logic (Whombat BT-01…BT-10; NX-350…): BlueZ's adapter and devices as the
// runtime sees them, looking for devices for a minute, one pairing at a time with an agent that exists only while it
// runs, and connecting, disconnecting and removing paired devices.
//
// The pairing agent (BT-03, BT-04) has the capability DisplayYesNo and answers bluetoothd for the device being paired
// only: a passkey to type on a keyboard is shown (`code`, with the digits typed so far when the keyboard says), a
// legacy keyboard's PIN too, a number on the device's own screen is confirmed by the owner (`confirm`), a fixed PIN
// is tried once as 0000, and a passkey to type into the box is refused. Everything else is refused, and while no
// pairing runs there is no agent at all, so BlueZ refuses every pairing nobody started here.
package service

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/CybexBV/whombat/appliance/bluetooth/internal/bluez"
	"github.com/CybexBV/whombat/contracts/go/local"
	"github.com/CybexBV/whombat/contracts/go/protocol"
)

// Config is the service's times (the contract's constants) and where the kernel's sysfs is.
type Config struct {
	Scan    time.Duration // looking for devices, from the last scan request (BLUETOOTH_SCAN_S)
	Pairing time.Duration // a pairing's deadline (BLUETOOTH_PAIRING_S)
	Keep    time.Duration // an ended pairing stays in the state (BLUETOOTH_RESULT_KEEP_S)
	Connect time.Duration // a connect waits at most (§2.3)
	Call    time.Duration // any other BlueZ call
	Sys     string
}

// Defaults is the contract's times.
func Defaults() Config {
	return Config{
		Scan:    local.BluetoothScanS * time.Second,
		Pairing: local.BluetoothPairingS * time.Second,
		Keep:    local.BluetoothResultKeepS * time.Second,
		Connect: local.BluetoothConnectS * time.Second,
		Call:    5 * time.Second,
		Sys:     "/sys",
	}
}

// Clock is the service's time (a fake one in tests).
type Clock interface {
	Now() time.Time
	AfterFunc(d time.Duration, f func()) Timer
}

// Timer is a Clock's timer.
type Timer interface{ Stop() bool }

type realClock struct{}

func (realClock) Now() time.Time                            { return time.Now() }
func (realClock) AfterFunc(d time.Duration, f func()) Timer { return time.AfterFunc(d, f) }

// RealClock is the wall clock.
var RealClock Clock = realClock{}

// Error is an answer the socket gives as a LocalError (the contract's BLUETOOTH_ERRORS).
type Error struct {
	Code    string
	Message string
}

func (e *Error) Error() string { return e.Code + ": " + e.Message }

func fail(code, msg string) error { return &Error{Code: code, Message: msg} }

var (
	errNoBluetooth = fail(local.BluetoothErrorNoBluetooth, "there is no Bluetooth adapter, or it is switched off")
	errBusy        = fail(local.BluetoothErrorBusy, "a pairing is running")
	errNotFound    = fail(local.BluetoothErrorNotFound, "no such device")
	errNotPaired   = fail(local.BluetoothErrorNotPaired, "that device isn't paired")
)

func unavailable(err error) error {
	return &Error{Code: local.BluetoothErrorUnavailable, Message: "BlueZ didn't answer: " + errText(err)}
}

// errText is an error for the log and answers: a BlueZ error's name only (its text could someday carry an address).
func errText(err error) string {
	if n := bluez.ErrorName(err); n != "" {
		return n
	}
	switch {
	case errors.Is(err, bluez.ErrNoBlueZ):
		return "bluetoothd isn't running"
	case errors.Is(err, bluez.ErrNoObject):
		return "gone"
	case errors.Is(err, context.DeadlineExceeded):
		return "no answer in time"
	case errors.Is(err, context.Canceled):
		return "canceled"
	}
	return "failed"
}

// Service is the Bluetooth service. Its methods are safe for concurrent use.
type Service struct {
	cfg   Config
	bz    bluez.BlueZ
	clock Clock
	log   func(string, ...any)
	// newID makes a pairing id (p- and 16 letters and digits).
	newID func() string

	mu        sync.Mutex
	scanUntil time.Time // zero: not looking
	scanOn    string    // the adapter it looks with
	scanTimer Timer
	pairing   *pairing // the running one, or the last one
}

// New is a service over bz.
func New(cfg Config, bz bluez.BlueZ, clock Clock, log func(string, ...any)) *Service {
	return &Service{cfg: cfg, bz: bz, clock: clock, log: log, newID: randomID}
}

func randomID() string {
	const letters = "abcdefghijklmnopqrstuvwxyz0123456789"
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	for i := range b {
		b[i] = letters[int(b[i])%len(letters)]
	}
	return "p-" + string(b)
}

func (s *Service) ctx(d time.Duration) (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), d)
}

// view is BlueZ's tree as the service uses it: the adapter (the first one) and its devices.
type view struct {
	adapter *bluez.Adapter
	missing protocol.BluetoothMissing
	devices []bluez.Device
}

func (v view) powered() bool { return v.adapter != nil && v.adapter.Powered }

func (v view) find(address string) *bluez.Device {
	for i := range v.devices {
		if v.devices[i].Address == address {
			return &v.devices[i]
		}
	}
	return nil
}

func (s *Service) look(ctx context.Context) (view, error) {
	if !hasController(s.cfg.Sys) {
		if driverless(s.cfg.Sys) {
			return view{missing: protocol.BluetoothMissingNoDriver}, nil
		}
		return view{missing: protocol.BluetoothMissingNoAdapter}, nil
	}
	objs, err := s.bz.Objects(ctx)
	if err != nil {
		return view{}, unavailable(err)
	}
	if len(objs.Adapters) == 0 {
		// The kernel has a controller BlueZ doesn't use: it hasn't come up (its firmware didn't load).
		return view{missing: protocol.BluetoothMissingNoDriver}, nil
	}
	a := objs.Adapters[0]
	v := view{adapter: &a}
	if !a.Powered {
		v.missing = protocol.BluetoothMissingDisabled
	}
	for _, d := range objs.Devices {
		if d.Adapter == a.Path && d.Address != "" {
			v.devices = append(v.devices, d)
		}
	}
	return v, nil
}

func paired(d bluez.Device) bool { return d.Paired || d.Bonded }

// device is d on the wire; false for phones, computers and devices without a name.
func device(d bluez.Device) (protocol.BluetoothDevice, bool) {
	kind, ok := kindOf(d)
	name := nameOf(d)
	if !ok || name == "" {
		return protocol.BluetoothDevice{}, false
	}
	out := protocol.BluetoothDevice{Address: d.Address, Name: name, Kind: kind, Connected: d.Connected}
	if d.Battery != nil && *d.Battery <= 100 {
		b := int64(*d.Battery)
		out.Battery = &b
	}
	if d.RSSI != nil {
		b := bars(*d.RSSI)
		out.Signal = &b
	}
	return out, true
}

// pairedDevices: connected first, then by name, at most 32.
func pairedDevices(v view) []protocol.BluetoothDevice {
	out := []protocol.BluetoothDevice{}
	for _, d := range v.devices {
		if !paired(d) {
			continue
		}
		if w, ok := device(d); ok {
			w.Signal = nil // bars belong to the devices it is looking for
			out = append(out, w)
		}
	}
	slices.SortStableFunc(out, func(a, b protocol.BluetoothDevice) int {
		if a.Connected != b.Connected {
			if a.Connected {
				return -1
			}
			return 1
		}
		if c := strings.Compare(strings.ToLower(a.Name), strings.ToLower(b.Name)); c != 0 {
			return c
		}
		return strings.Compare(a.Address, b.Address)
	})
	if len(out) > local.BluetoothDevicesMax {
		out = out[:local.BluetoothDevicesMax]
	}
	return out
}

// found is what this round of looking found: not paired, named (by the device itself), seen in this round (BlueZ
// gives an RSSI only then), strongest first, at most 64.
func found(v view) []protocol.BluetoothDevice {
	out := []protocol.BluetoothDevice{}
	for _, d := range v.devices {
		if paired(d) || d.RSSI == nil || cleanName(d.Name) == "" {
			continue
		}
		if w, ok := device(d); ok {
			out = append(out, w)
		}
	}
	slices.SortStableFunc(out, func(a, b protocol.BluetoothDevice) int {
		if *a.Signal != *b.Signal {
			return int(*b.Signal - *a.Signal)
		}
		return strings.Compare(strings.ToLower(a.Name), strings.ToLower(b.Name))
	})
	if len(out) > local.BluetoothScanMax {
		out = out[:local.BluetoothScanMax]
	}
	return out
}

func stamp(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z") }

// State is BlueZ's adapter and paired devices, what looking found while it runs, and the pairing (the running one,
// or the last one for a minute after it ended).
func (s *Service) State() (protocol.BluetoothState, error) {
	ctx, cancel := s.ctx(s.cfg.Call)
	defer cancel()
	v, err := s.look(ctx)
	if err != nil {
		return protocol.BluetoothState{}, err
	}
	st := protocol.BluetoothState{Devices: []protocol.BluetoothDevice{}}
	if v.missing != "" {
		m := v.missing
		st.Missing = &m
	}
	if v.adapter == nil {
		return st, nil
	}
	name := cleanName(v.adapter.Alias)
	if name == "" {
		name = "Bluetooth"
	}
	st.Adapter = &protocol.BluetoothAdapter{Name: name, Powered: v.adapter.Powered}
	st.Devices = pairedDevices(v)
	s.mu.Lock()
	defer s.mu.Unlock()
	if sc := s.scanLocked(v); sc != nil {
		st.Scan = sc
	}
	if p := s.pairingLocked(); p != nil {
		snap := p.snapshot()
		st.Pairing = &snap
	}
	return st, nil
}

func (s *Service) scanLocked(v view) *protocol.BluetoothScan {
	if s.scanUntil.IsZero() || !s.clock.Now().Before(s.scanUntil) || !v.powered() {
		return nil
	}
	return &protocol.BluetoothScan{Until: stamp(s.scanUntil), Devices: found(v)}
}

// pairingLocked is the running pairing, or the last one until Keep after it ended.
func (s *Service) pairingLocked() *pairing {
	p := s.pairing
	if p == nil || (!p.ended.IsZero() && s.clock.Now().Sub(p.ended) >= s.cfg.Keep) {
		return nil
	}
	return p
}

func (s *Service) runningLocked() *pairing {
	if p := s.pairing; p != nil && p.ended.IsZero() {
		return p
	}
	return nil
}

// Scan starts looking for devices, or keeps looking Scan longer (BT-07); refused while a pairing runs (looking slows
// a pairing down).
func (s *Service) Scan() (protocol.BluetoothScan, error) {
	ctx, cancel := s.ctx(s.cfg.Call)
	defer cancel()
	v, err := s.look(ctx)
	if err != nil {
		return protocol.BluetoothScan{}, err
	}
	if !v.powered() {
		return protocol.BluetoothScan{}, errNoBluetooth
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.runningLocked() != nil {
		return protocol.BluetoothScan{}, errBusy
	}
	if !v.adapter.Discovering || s.scanUntil.IsZero() {
		if err := s.bz.StartDiscovery(ctx, v.adapter.Path); err != nil {
			s.log("whombat-bluetooth: can't look for devices: %s", errText(err))
			return protocol.BluetoothScan{}, unavailable(err)
		}
		if s.scanUntil.IsZero() {
			s.log("whombat-bluetooth: looking for devices")
		}
	}
	s.scanOn = v.adapter.Path
	s.scanUntil = s.clock.Now().Add(s.cfg.Scan)
	if s.scanTimer != nil {
		s.scanTimer.Stop()
	}
	until := s.scanUntil
	s.scanTimer = s.clock.AfterFunc(s.cfg.Scan, func() { s.scanEnded(until) })
	return protocol.BluetoothScan{Until: stamp(s.scanUntil), Devices: found(v)}, nil
}

func (s *Service) scanEnded(until time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.scanUntil.Equal(until) {
		return // asked again meanwhile, or stopped
	}
	s.stopScanLocked("the minute is over")
}

func (s *Service) stopScanLocked(why string) {
	if s.scanUntil.IsZero() {
		return
	}
	if s.scanTimer != nil {
		s.scanTimer.Stop()
		s.scanTimer = nil
	}
	ctx, cancel := s.ctx(s.cfg.Call)
	defer cancel()
	if err := s.bz.StopDiscovery(ctx, s.scanOn); err != nil {
		s.log("whombat-bluetooth: can't stop looking: %s", errText(err))
	}
	s.scanUntil = time.Time{}
	s.log("whombat-bluetooth: stopped looking (%s)", why)
}

// Close stops looking and ends a running pairing (canceled).
func (s *Service) Close() {
	s.mu.Lock()
	p := s.runningLocked()
	s.stopScanLocked("stopping")
	s.mu.Unlock()
	if p != nil {
		s.end(p, protocol.BluetoothPairingFailureCanceled)
	}
}

// paired device's checks for connect, disconnect and forget.
func (s *Service) pairedDevice(address string) (view, *bluez.Device, error) {
	ctx, cancel := s.ctx(s.cfg.Call)
	defer cancel()
	v, err := s.look(ctx)
	if err != nil {
		return v, nil, err
	}
	if !v.powered() {
		return v, nil, errNoBluetooth
	}
	d := v.find(address)
	if d == nil {
		return v, nil, errNotFound
	}
	if _, ok := device(*d); !ok {
		return v, nil, errNotFound
	}
	if !paired(*d) {
		return v, nil, errNotPaired
	}
	return v, d, nil
}

func (s *Service) reread(address string) (protocol.BluetoothDevice, error) {
	ctx, cancel := s.ctx(s.cfg.Call)
	defer cancel()
	v, err := s.look(ctx)
	if err != nil {
		return protocol.BluetoothDevice{}, err
	}
	d := v.find(address)
	if d == nil {
		return protocol.BluetoothDevice{}, errNotFound
	}
	w, ok := device(*d)
	if !ok {
		return protocol.BluetoothDevice{}, errNotFound
	}
	w.Signal = nil
	return w, nil
}

// Connect connects a paired device (waits at most Connect). A device that doesn't come (switched off, out of range)
// is answered as it is: not connected (NX-356).
func (s *Service) Connect(address string) (protocol.BluetoothDevice, error) {
	_, d, err := s.pairedDevice(address)
	if err != nil {
		return protocol.BluetoothDevice{}, err
	}
	ctx, cancel := s.ctx(s.cfg.Connect)
	defer cancel()
	name := nameOf(*d)
	if err := s.bz.Connect(ctx, d.Path); err != nil {
		s.log("whombat-bluetooth: %s didn't connect: %s", name, errText(err))
	} else {
		s.log("whombat-bluetooth: %s connected", name)
	}
	return s.reread(address)
}

// Disconnect disconnects a paired device; it stays paired and trusted, so it comes back when it is switched on again.
func (s *Service) Disconnect(address string) (protocol.BluetoothDevice, error) {
	_, d, err := s.pairedDevice(address)
	if err != nil {
		return protocol.BluetoothDevice{}, err
	}
	ctx, cancel := s.ctx(s.cfg.Call)
	defer cancel()
	name := nameOf(*d)
	if err := s.bz.Disconnect(ctx, d.Path); err != nil && !errors.Is(err, bluez.ErrNoObject) {
		s.log("whombat-bluetooth: %s didn't disconnect: %s", name, errText(err))
		return protocol.BluetoothDevice{}, unavailable(err)
	}
	s.log("whombat-bluetooth: %s disconnected", name)
	return s.reread(address)
}

// Forget removes a paired device from BlueZ (its keys too: it has to be paired again). Refused for the device a
// running pairing is for.
func (s *Service) Forget(address string) error {
	v, d, err := s.pairedDevice(address)
	if err != nil {
		return err
	}
	s.mu.Lock()
	if p := s.runningLocked(); p != nil && p.Address == address {
		s.mu.Unlock()
		return errBusy
	}
	s.mu.Unlock()
	ctx, cancel := s.ctx(s.cfg.Call)
	defer cancel()
	name := nameOf(*d)
	if err := s.bz.RemoveDevice(ctx, v.adapter.Path, d.Path); err != nil && !errors.Is(err, bluez.ErrNoObject) {
		s.log("whombat-bluetooth: can't remove %s: %s", name, errText(err))
		return unavailable(err)
	}
	s.log("whombat-bluetooth: removed %s", name)
	return nil
}

// Pair starts pairing with a device it found (or one already paired: then it is trusted and connected again). It
// stops looking, registers the agent and pairs in the background; the answer is the pairing as it starts.
func (s *Service) Pair(address string) (protocol.BluetoothPairing, error) {
	ctx, cancel := s.ctx(s.cfg.Call)
	defer cancel()
	v, err := s.look(ctx)
	if err != nil {
		return protocol.BluetoothPairing{}, err
	}
	if !v.powered() {
		return protocol.BluetoothPairing{}, errNoBluetooth
	}
	d := v.find(address)
	if d == nil {
		return protocol.BluetoothPairing{}, errNotFound
	}
	w, ok := device(*d)
	if !ok {
		return protocol.BluetoothPairing{}, errNotFound
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.runningLocked() != nil {
		return protocol.BluetoothPairing{}, errBusy
	}
	s.stopScanLocked("pairing")
	now := s.clock.Now()
	p := &pairing{
		s:       s,
		path:    d.Path,
		adapter: v.adapter.Path,
		already: paired(*d),
		done:    make(chan struct{}),
		BluetoothPairing: protocol.BluetoothPairing{
			ID:       s.newID(),
			Address:  d.Address,
			Name:     w.Name,
			Kind:     w.Kind,
			Phase:    protocol.BluetoothPairingPhasePairing,
			Deadline: stamp(now.Add(s.cfg.Pairing)),
		},
	}
	p.ctx, p.cancel = context.WithCancel(context.Background())
	if err := s.bz.RegisterAgent(ctx, p); err != nil {
		p.cancel()
		s.log("whombat-bluetooth: can't register the pairing agent: %s", errText(err))
		return protocol.BluetoothPairing{}, unavailable(err)
	}
	s.pairing = p
	p.timer = s.clock.AfterFunc(s.cfg.Pairing, func() { s.end(p, protocol.BluetoothPairingFailureTimeout) })
	s.log("whombat-bluetooth: pairing with %s (%s)", p.Name, p.Kind)
	go s.run(p)
	return p.snapshot(), nil
}

// Confirm answers the question “Does {name} show {code}?”: yes goes on pairing, no ends it (failed: the numbers didn't
// match, NX-355). Outside the question the pairing is answered as it is.
func (s *Service) Confirm(id string, accept bool) (protocol.BluetoothPairing, error) {
	s.mu.Lock()
	p := s.pairingLocked()
	if p == nil || p.ID != id {
		s.mu.Unlock()
		return protocol.BluetoothPairing{}, errNotFound
	}
	if !p.ended.IsZero() || p.Phase != protocol.BluetoothPairingPhaseConfirm || p.answer == nil {
		snap := p.snapshot()
		s.mu.Unlock()
		return snap, nil
	}
	ch := p.answer
	p.answer = nil
	if accept {
		p.Phase = protocol.BluetoothPairingPhasePairing
	}
	s.mu.Unlock()
	if !accept {
		s.end(p, protocol.BluetoothPairingFailureFailed)
	}
	ch <- accept
	return s.snapshotOf(p), nil
}

// Cancel ends the running pairing (the dialog was closed): canceled. An ended one is answered as it is.
func (s *Service) Cancel(id string) (protocol.BluetoothPairing, error) {
	s.mu.Lock()
	p := s.pairingLocked()
	if p == nil || p.ID != id {
		s.mu.Unlock()
		return protocol.BluetoothPairing{}, errNotFound
	}
	s.mu.Unlock()
	s.end(p, protocol.BluetoothPairingFailureCanceled)
	return s.snapshotOf(p), nil
}

func (s *Service) snapshotOf(p *pairing) protocol.BluetoothPairing {
	s.mu.Lock()
	defer s.mu.Unlock()
	return p.snapshot()
}

// end fails a running pairing (canceled, timed out, or the owner said no) and stops BlueZ's side of it; a no-op for
// one that ended already.
func (s *Service) end(p *pairing, why protocol.BluetoothPairingFailure) {
	s.mu.Lock()
	if !p.ended.IsZero() || p.Phase == protocol.BluetoothPairingPhaseConnecting {
		// Ended, or paired already: a connect that runs late doesn't undo the pairing.
		s.mu.Unlock()
		return
	}
	p.failLocked(why)
	if p.answer != nil {
		close(p.answer)
		p.answer = nil
	}
	s.mu.Unlock()
	p.cancel()
}

// run pairs, trusts and connects, then drops the agent.
func (s *Service) run(p *pairing) {
	defer close(p.done)
	var err error
	if !p.already {
		err = s.bz.Pair(p.ctx, p.path)
		if n := bluez.ErrorName(err); n == bluez.ErrorAlreadyExists {
			err = nil
		}
	}
	bg := func(d time.Duration) (context.Context, context.CancelFunc) { return s.ctx(d) }
	s.mu.Lock()
	p.timer.Stop()
	ended := !p.ended.IsZero()
	s.mu.Unlock()
	if ended {
		// Canceled, timed out or refused by the owner: BlueZ's pairing is stopped; one that got through anyway is
		// removed, so a device nobody wanted isn't left paired.
		// godbus gives up the call when its context ends, so whether BlueZ got there is read afterwards.
		ctx, cancel := bg(s.cfg.Call)
		if err != nil && p.ctx.Err() != nil {
			_ = s.bz.CancelPairing(ctx, p.path)
		}
		if !p.already && (err == nil || s.isPaired(ctx, p.path)) {
			_ = s.bz.RemoveDevice(ctx, p.adapter, p.path)
			s.log("whombat-bluetooth: %s paired as the pairing ended: removed again", p.Name)
		}
		cancel()
		s.unregister(p)
		return
	}
	if err != nil {
		s.mu.Lock()
		p.failLocked(failureOf(err, p.refused))
		s.mu.Unlock()
		s.log("whombat-bluetooth: pairing with %s failed: %s (%s)", p.Name, *p.Failure, errText(err))
		s.unregister(p)
		return
	}
	s.mu.Lock()
	p.Phase, p.Code, p.Typed = protocol.BluetoothPairingPhaseConnecting, nil, nil
	s.mu.Unlock()
	ctx, cancel := bg(s.cfg.Call)
	if err := s.bz.SetTrusted(ctx, p.path, true); err != nil {
		s.log("whombat-bluetooth: can't trust %s: %s", p.Name, errText(err))
	}
	cancel()
	ctx, cancel = bg(s.cfg.Connect)
	cerr := s.bz.Connect(ctx, p.path)
	cancel()
	s.unregister(p)
	s.mu.Lock()
	p.Phase = protocol.BluetoothPairingPhaseDone
	p.ended = s.clock.Now()
	s.mu.Unlock()
	if cerr != nil {
		// Paired and trusted: it connects when it is used, or from its row (NX-356).
		s.log("whombat-bluetooth: %s is paired, not connected yet: %s", p.Name, errText(cerr))
	} else {
		s.log("whombat-bluetooth: %s is paired and connected", p.Name)
	}
}

func (s *Service) isPaired(ctx context.Context, path string) bool {
	objs, err := s.bz.Objects(ctx)
	if err != nil {
		return false
	}
	for _, d := range objs.Devices {
		if d.Path == path {
			return paired(d)
		}
	}
	return false
}

func (s *Service) unregister(p *pairing) {
	ctx, cancel := s.ctx(s.cfg.Call)
	defer cancel()
	if err := s.bz.UnregisterAgent(ctx); err != nil && !errors.Is(err, bluez.ErrNoBlueZ) {
		s.log("whombat-bluetooth: can't drop the pairing agent: %s", errText(err))
	}
}

// failureOf maps BlueZ's answer to Pair (NX-355).
func failureOf(err error, refused bool) protocol.BluetoothPairingFailure {
	if refused {
		return protocol.BluetoothPairingFailureFailed // it wanted a code typed into the box (BT-04)
	}
	if errors.Is(err, bluez.ErrNoObject) {
		return protocol.BluetoothPairingFailureNotFound
	}
	switch bluez.ErrorName(err) {
	case bluez.ErrorAuthenticationRejected, bluez.ErrorAuthenticationFailed, bluez.ErrorAuthenticationCanceled:
		return protocol.BluetoothPairingFailureRejected
	case bluez.ErrorAuthenticationTimeout, bluez.ErrorConnectionAttempt:
		return protocol.BluetoothPairingFailureTimeout
	case bluez.ErrorDoesNotExist:
		return protocol.BluetoothPairingFailureNotFound
	}
	return protocol.BluetoothPairingFailureFailed
}

// pairing is one pairing: its wire shape and what the agent needs. Its fields are the service's mutex's.
type pairing struct {
	protocol.BluetoothPairing
	s       *Service
	path    string
	adapter string
	already bool // paired before: only trusted and connected
	ctx     context.Context
	cancel  context.CancelFunc
	timer   Timer
	ended   time.Time
	// answer is the owner's yes or no while BlueZ waits for a confirmation (phase confirm).
	answer  chan bool
	pinUsed bool
	refused bool
	done    chan struct{}
}

func (p *pairing) snapshot() protocol.BluetoothPairing {
	out := p.BluetoothPairing
	if p.Code != nil {
		c := *p.Code
		out.Code = &c
	}
	if p.Typed != nil {
		t := *p.Typed
		out.Typed = &t
	}
	if p.Failure != nil {
		f := *p.Failure
		out.Failure = &f
	}
	return out
}

func (p *pairing) failLocked(why protocol.BluetoothPairingFailure) {
	if !p.ended.IsZero() {
		return
	}
	p.Phase, p.Code, p.Typed = protocol.BluetoothPairingPhaseFailed, nil, nil
	p.Failure = &why
	p.ended = p.s.clock.Now()
}

// mine: the request is for this pairing's device, and the pairing still runs.
func (p *pairing) mine(device string) bool {
	return device == p.path && p.ended.IsZero()
}

var _ bluez.Agent = (*pairing)(nil)

// RequestPinCode: a device with a fixed PIN gets 0000, once (BT-04's older headsets and speakers).
func (p *pairing) RequestPinCode(device string) (string, error) {
	p.s.mu.Lock()
	defer p.s.mu.Unlock()
	if !p.mine(device) || p.pinUsed {
		return "", bluez.ErrRejected
	}
	p.pinUsed = true
	return "0000", nil
}

var pinRE = regexp.MustCompile(`^[0-9]{4,6}$`)

// DisplayPinCode: a legacy keyboard's PIN to type on it (phase code).
func (p *pairing) DisplayPinCode(device, pin string) error {
	p.s.mu.Lock()
	defer p.s.mu.Unlock()
	if !p.mine(device) || !pinRE.MatchString(pin) {
		return bluez.ErrRejected
	}
	p.Phase, p.Code, p.Typed = protocol.BluetoothPairingPhaseCode, &pin, nil
	return nil
}

// RequestPasskey: a code to type into the box. Refused: none of BT-01's devices asks for one (BT-04).
func (p *pairing) RequestPasskey(device string) (uint32, error) {
	p.s.mu.Lock()
	defer p.s.mu.Unlock()
	if p.mine(device) {
		p.refused = true
	}
	return 0, bluez.ErrRejected
}

// DisplayPasskey: a keyboard's passkey (phase code); BlueZ calls again as keys are pressed when the keyboard says so.
func (p *pairing) DisplayPasskey(device string, passkey uint32, entered uint16) {
	p.s.mu.Lock()
	defer p.s.mu.Unlock()
	if !p.mine(device) || passkey > 999999 {
		return
	}
	code := fmt.Sprintf("%06d", passkey)
	p.Phase, p.Code = protocol.BluetoothPairingPhaseCode, &code
	if entered > 0 {
		t := int64(min(entered, 6))
		p.Typed = &t
	}
}

// RequestConfirmation: a device that shows the number (phase confirm) waits for the owner's answer, the deadline
// or BlueZ's Cancel.
func (p *pairing) RequestConfirmation(device string, passkey uint32) error {
	p.s.mu.Lock()
	if !p.mine(device) || passkey > 999999 {
		p.s.mu.Unlock()
		return bluez.ErrRejected
	}
	code := fmt.Sprintf("%06d", passkey)
	ch := make(chan bool, 1)
	p.Phase, p.Code, p.Typed, p.answer = protocol.BluetoothPairingPhaseConfirm, &code, nil, ch
	p.s.mu.Unlock()
	if yes, ok := <-ch; ok && yes {
		return nil
	}
	return bluez.ErrRejected
}

// RequestAuthorization: a pairing without a code that BlueZ asks about (Just Works): yes for this device only.
func (p *pairing) RequestAuthorization(device string) error {
	p.s.mu.Lock()
	defer p.s.mu.Unlock()
	if !p.mine(device) {
		return bluez.ErrRejected
	}
	return nil
}

// AuthorizeService: the device being paired may use its services; nobody else gets one through this agent.
func (p *pairing) AuthorizeService(device, _ string) error { return p.RequestAuthorization(device) }

// Cancel: BlueZ gave up waiting for the owner's answer.
func (p *pairing) Cancel() {
	p.s.mu.Lock()
	defer p.s.mu.Unlock()
	if p.answer != nil {
		close(p.answer)
		p.answer = nil
	}
}

// Release: BlueZ dropped the agent (it is stopping).
func (p *pairing) Release() {}
