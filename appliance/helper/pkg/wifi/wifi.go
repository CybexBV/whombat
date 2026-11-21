// Package wifi is iwd as the update helper and the installer use it (appliance NX-240…NX-254): the adapters and
// stations, a scan and its networks, the known (saved) networks, joining, forgetting, and iwd's network profile files
// (/var/lib/iwd/<name>.psk|.open, profile.go).
//
// Joining answers iwd's passphrase request with an agent of its own (iwd writes the profile itself once the keys are
// set, so a wrong password leaves nothing behind); a profile is written first only for a raw 64-digit key, which an
// agent can't hand over, and for a saved network given a new passphrase (NX-243).
//
// A passphrase is a secret: no error, log line, String or GoString of this package carries one.
package wifi

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"time"
	"unicode/utf8"
)

// StateDir is where iwd keeps its known networks (root only, 0700).
const StateDir = "/var/lib/iwd"

// Security is a network's kind as iwd names it (Network.Type, KnownNetwork.Type).
type Security string

const (
	SecurityOpen    Security = "open"
	SecurityPSK     Security = "psk" // WPA2 and WPA3 Personal
	SecurityEAP     Security = "8021x"
	SecurityWEP     Security = "wep"
	SecurityHotspot Security = "hotspot"
)

// Joinable reports whether this package can join a network of this kind (open and personal ones, HD-05).
func (s Security) Joinable() bool { return s == SecurityOpen || s == SecurityPSK }

// StationState is iwd's Station.State.
type StationState string

const (
	StateConnected     StationState = "connected"
	StateDisconnected  StationState = "disconnected"
	StateConnecting    StationState = "connecting"
	StateDisconnecting StationState = "disconnecting"
	StateRoaming       StationState = "roaming"
)

// Adapter is a Wi-Fi card (iwd's Adapter, one per phy).
type Adapter struct {
	Name    string // phy0
	Model   string // may be empty
	Vendor  string // may be empty
	Powered bool
}

// Device is a Wi-Fi interface (iwd's Device) with its station when it is in station mode.
type Device struct {
	Interface string // wlan0
	Adapter   string // the adapter's Name
	Powered   bool
	Mode      string   // station, ap, ad-hoc
	Station   *Station // nil unless the device is a powered station
}

// Station is a device's connection state (iwd's Station).
type Station struct {
	State    StationState
	Scanning bool
	// Connected is the network connected or being connected to (iwd's ConnectedNetwork), nil when none.
	Connected *Network
}

// Network is a network of the last scan (iwd's Network).
type Network struct {
	SSID     string
	Security Security
	// SignalDBm is the strongest access point's signal in dBm (0…−100); 0 also when iwd didn't rank it.
	SignalDBm int
	Known     bool // saved
	Connected bool // connected or being connected to
}

// KnownNetwork is a saved network (iwd's KnownNetwork).
type KnownNetwork struct {
	SSID          string
	Security      Security
	Hidden        bool
	AutoConnect   bool
	LastConnected time.Time // zero: never connected
}

// Status is what iwd knows now.
type Status struct {
	Adapters []Adapter
	Devices  []Device
	Known    []KnownNetwork
}

// Station returns the first device in station mode, or nil (an appliance has one Wi-Fi card; the first is used).
func (s *Status) Station() *Device {
	for i := range s.Devices {
		if s.Devices[i].Station != nil {
			return &s.Devices[i]
		}
	}
	return nil
}

// KnownOf returns the saved network ssid of kind sec, or nil.
func (s *Status) KnownOf(ssid string, sec Security) *KnownNetwork {
	for i := range s.Known {
		if s.Known[i].SSID == ssid && s.Known[i].Security == sec {
			return &s.Known[i]
		}
	}
	return nil
}

// Join is what Connect joins. Security "" is taken from the scan; for a hidden network it is psk with a passphrase and
// open without one.
type Join struct {
	SSID       string
	Passphrase string // "" for an open network or a saved one (its profile's); a secret
	Hidden     bool
	Security   Security
}

// String leaves the passphrase out.
func (j Join) String() string {
	return fmt.Sprintf("join %q (security %q, hidden %v, passphrase given %v)", j.SSID, j.Security, j.Hidden, j.Passphrase != "")
}

// GoString leaves the passphrase out (%#v).
func (j Join) GoString() string { return j.String() }

// Client is iwd as the helper and the installer use it. Every call is bounded by its context.
type Client interface {
	// Status reads the adapters, devices, stations and saved networks. ErrNoIwd when iwd isn't running.
	Status(ctx context.Context) (*Status, error)
	// Networks returns the networks of iface's last scan, strongest first (iwd's order breaks ties).
	Networks(ctx context.Context, iface string) ([]Network, error)
	// Scan asks iface for a fresh scan (or waits for the one running) and returns Networks once it ended.
	Scan(ctx context.Context, iface string) ([]Network, error)
	// Connect joins a network on iface and returns once iwd connected (its keys are set; the address is networkd's)
	// or failed: ErrWrongPassword, ErrNotFound, ErrNotSupported, ErrInvalidPassphrase, ErrBusy or another error. A
	// failed join leaves the profiles as they were.
	Connect(ctx context.Context, iface string, j Join) error
	// Forget removes a saved network (its profile goes; iwd disconnects when it was connected). ErrNotFound when it
	// isn't saved.
	Forget(ctx context.Context, ssid string, sec Security) error
}

// Errors of Client. Wrapped errors keep these with errors.Is.
var (
	ErrNoIwd             = errors.New("wifi: iwd is not running")
	ErrNoStation         = errors.New("wifi: no Wi-Fi station")
	ErrWrongPassword     = errors.New("wifi: the network refused the password")
	ErrNotFound          = errors.New("wifi: the network was not found")
	ErrNotSupported      = errors.New("wifi: this kind of network can't be joined")
	ErrInvalidPassphrase = errors.New("wifi: the passphrase is not valid")
	ErrBusy              = errors.New("wifi: the Wi-Fi card is busy")
	ErrBadSSID           = errors.New("wifi: the network name is not valid")
)

// ValidSSID reports whether s can name a network here: 1…32 bytes of UTF-8 without NUL (iwd's own limits; what may be
// shown is the contracts' SsidValid, which the manager applies).
func ValidSSID(s string) bool {
	return s != "" && len(s) <= 32 && utf8.ValidString(s) && !slices.Contains([]byte(s), 0)
}

// ValidPassphrase reports whether p is a WPA passphrase (8…63 printable ASCII) or a raw key (64 hex digits), the
// contracts' WifiPassphrase.
func ValidPassphrase(p string) bool {
	if IsHexKey(p) {
		return true
	}
	if len(p) < 8 || len(p) > 63 {
		return false
	}
	for i := 0; i < len(p); i++ {
		if p[i] < 0x20 || p[i] > 0x7e {
			return false
		}
	}
	return true
}

// IsHexKey reports whether p is a raw 256-bit key (64 hex digits) rather than a passphrase.
func IsHexKey(p string) bool {
	if len(p) != 64 {
		return false
	}
	for i := 0; i < len(p); i++ {
		c := p[i]
		if !('0' <= c && c <= '9' || 'a' <= c && c <= 'f' || 'A' <= c && c <= 'F') {
			return false
		}
	}
	return true
}

// SortNetworks orders networks strongest first, keeping the given order between equal signals.
func SortNetworks(ns []Network) {
	slices.SortStableFunc(ns, func(a, b Network) int { return b.SignalDBm - a.SignalDBm })
}

// securityOf picks a hidden network's kind (Join.Security "").
func (j Join) securityOf() Security {
	if j.Security != "" {
		return j.Security
	}
	if j.Passphrase != "" {
		return SecurityPSK
	}
	return SecurityOpen
}

// check validates a join's fields (never naming the passphrase).
func (j Join) check() error {
	if !ValidSSID(j.SSID) {
		return ErrBadSSID
	}
	if j.Passphrase != "" && !ValidPassphrase(j.Passphrase) {
		return ErrInvalidPassphrase
	}
	if j.Security != "" && !j.Security.Joinable() {
		return ErrNotSupported
	}
	return nil
}
