package wifi

import (
	"context"
	"slices"
	"sync"
)

// FakeNetwork is an access point a Fake's scan finds.
type FakeNetwork struct {
	SSID      string
	Security  Security
	SignalDBm int
	Password  string // a psk network's passphrase (or 64 hex digits); a test value
	Hidden    bool   // left out of scans unless saved as hidden
}

// Fake is an in-memory Client for tests (the helper's ops, the installer): one station, the networks in range, the
// saved networks and what each takes. With Dir set it writes and removes profiles there as iwd does. Set its fields
// before using it; the methods are safe for concurrent use.
type Fake struct {
	Interface string // default "wlan0"
	InRange   []FakeNetwork
	// NoIwd makes every call fail with ErrNoIwd; NoStation makes the device a non-station (no Wi-Fi to use).
	NoIwd, NoStation bool
	// Unpowered is a switched-off card (no station to use).
	Unpowered bool
	// Dir, when set, receives the profiles of networks joined and loses those forgotten.
	Dir string
	// FailNext, when set, is what the next Connect returns (once).
	FailNext error

	mu        sync.Mutex
	saved     []fakeSaved
	connected *FakeNetwork
	scans     int
	joins     []string // the SSIDs Connect was asked to join, in order
}

type fakeSaved struct {
	KnownNetwork
	password string
}

var _ Client = (*Fake)(nil)

func (f *Fake) iface() string {
	if f.Interface != "" {
		return f.Interface
	}
	return "wlan0"
}

// Save makes a network saved (as if joined before, or written by the installer).
func (f *Fake) Save(ssid string, sec Security, password string, hidden bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.saveLocked(ssid, sec, password, hidden)
}

func (f *Fake) saveLocked(ssid string, sec Security, password string, hidden bool) {
	f.saved = slices.DeleteFunc(f.saved, func(s fakeSaved) bool { return s.SSID == ssid && s.Security == sec })
	f.saved = append(f.saved, fakeSaved{KnownNetwork{SSID: ssid, Security: sec, Hidden: hidden, AutoConnect: true}, password})
	if f.Dir != "" {
		_ = WriteProfile(f.Dir, ssid, sec, Profile{Passphrase: password, Hidden: hidden})
	}
}

// ConnectTo connects the station to a network in range without a join (the box came up on it).
func (f *Fake) ConnectTo(ssid string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for i := range f.InRange {
		if f.InRange[i].SSID == ssid {
			n := f.InRange[i]
			f.connected = &n
		}
	}
}

// Drop disconnects the station (out of range, the access point went away).
func (f *Fake) Drop() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.connected = nil
}

// ConnectedTo returns the network the station is on ("" when none).
func (f *Fake) ConnectedTo() (string, Security) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.connected == nil {
		return "", ""
	}
	return f.connected.SSID, f.connected.Security
}

// Saved returns the saved networks.
func (f *Fake) Saved() []KnownNetwork {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []KnownNetwork
	for _, s := range f.saved {
		out = append(out, s.KnownNetwork)
	}
	return out
}

// Scans returns how many scans ran; Joins the SSIDs Connect was asked for.
func (f *Fake) Scans() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.scans
}

// Joins returns the SSIDs Connect was asked to join, in order.
func (f *Fake) Joins() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.joins)
}

func (f *Fake) savedOf(ssid string, sec Security) *fakeSaved {
	for i := range f.saved {
		if f.saved[i].SSID == ssid && f.saved[i].Security == sec {
			return &f.saved[i]
		}
	}
	return nil
}

func (f *Fake) check(iface string) error {
	if f.NoIwd {
		return ErrNoIwd
	}
	if f.NoStation || f.Unpowered || iface != f.iface() {
		return ErrNoStation
	}
	return nil
}

// Status implements Client.
func (f *Fake) Status(ctx context.Context) (*Status, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.NoIwd {
		return nil, ErrNoIwd
	}
	st := &Status{Adapters: []Adapter{{Name: "phy0", Powered: !f.Unpowered}}}
	dev := Device{Interface: f.iface(), Adapter: "phy0", Powered: !f.Unpowered, Mode: "station"}
	if !f.NoStation && !f.Unpowered {
		dev.Station = &Station{State: StateDisconnected}
		if c := f.connected; c != nil {
			dev.Station.State = StateConnected
			dev.Station.Connected = &Network{SSID: c.SSID, Security: c.Security, SignalDBm: c.SignalDBm,
				Known: f.savedOf(c.SSID, c.Security) != nil, Connected: true}
		}
	}
	st.Devices = []Device{dev}
	for _, s := range f.saved {
		st.Known = append(st.Known, s.KnownNetwork)
	}
	return st, nil
}

func (f *Fake) visible() []Network {
	var out []Network
	for _, n := range f.InRange {
		s := f.savedOf(n.SSID, n.Security)
		if n.Hidden && (s == nil || !s.Hidden) {
			continue
		}
		connected := f.connected != nil && f.connected.SSID == n.SSID && f.connected.Security == n.Security
		out = append(out, Network{SSID: n.SSID, Security: n.Security, SignalDBm: n.SignalDBm, Known: s != nil, Connected: connected})
	}
	SortNetworks(out)
	return out
}

// Networks implements Client.
func (f *Fake) Networks(ctx context.Context, iface string) ([]Network, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if err := f.check(iface); err != nil {
		return nil, err
	}
	return f.visible(), nil
}

// Scan implements Client.
func (f *Fake) Scan(ctx context.Context, iface string) ([]Network, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if err := f.check(iface); err != nil {
		return nil, err
	}
	f.scans++
	return f.visible(), nil
}

// Connect implements Client: a psk network takes its Password (given, or the saved one); a hidden one is found only
// with Join.Hidden or when saved as hidden.
func (f *Fake) Connect(ctx context.Context, iface string, j Join) error {
	if err := j.check(); err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if err := f.check(iface); err != nil {
		return err
	}
	f.joins = append(f.joins, j.SSID)
	if err := f.FailNext; err != nil {
		f.FailNext = nil
		return err
	}
	var ap *FakeNetwork
	for i := range f.InRange {
		n := &f.InRange[i]
		if n.SSID != j.SSID || (j.Security != "" && n.Security != j.Security) {
			continue
		}
		s := f.savedOf(n.SSID, n.Security)
		if n.Hidden && !j.Hidden && (s == nil || !s.Hidden) {
			continue
		}
		ap = n
		break
	}
	if ap == nil {
		return ErrNotFound
	}
	if !ap.Security.Joinable() {
		return ErrNotSupported
	}
	saved := f.savedOf(ap.SSID, ap.Security)
	pass := j.Passphrase
	if ap.Security == SecurityOpen {
		pass = ""
	}
	if ap.Security == SecurityPSK {
		switch {
		case pass == "" && saved == nil:
			return ErrInvalidPassphrase
		case pass == "":
			if saved.password != ap.Password {
				return ErrWrongPassword
			}
			pass = saved.password
		case pass != ap.Password:
			return ErrWrongPassword
		}
	}
	n := *ap
	f.connected = &n
	f.saveLocked(ap.SSID, ap.Security, pass, ap.Hidden)
	return nil
}

// Forget implements Client: a forgotten connected network disconnects, and the station goes to the strongest other
// saved network in range, as iwd's autoconnect does.
func (f *Fake) Forget(ctx context.Context, ssid string, sec Security) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.NoIwd {
		return ErrNoIwd
	}
	if f.savedOf(ssid, sec) == nil {
		return ErrNotFound
	}
	f.saved = slices.DeleteFunc(f.saved, func(s fakeSaved) bool { return s.SSID == ssid && s.Security == sec })
	if f.Dir != "" {
		_ = RemoveProfile(f.Dir, ssid, sec)
	}
	if f.connected != nil && f.connected.SSID == ssid && f.connected.Security == sec {
		f.connected = nil
		for _, n := range f.visible() {
			if s := f.savedOf(n.SSID, n.Security); s != nil {
				for i := range f.InRange {
					if f.InRange[i].SSID == n.SSID && f.InRange[i].Security == n.Security && s.password == f.InRange[i].Password {
						c := f.InRange[i]
						f.connected = &c
						return nil
					}
				}
			}
		}
	}
	return nil
}
