package installer

// The installer's Wi-Fi card through iwd (helper/pkg/wifi, NX-243; CG-123): the server's Wifi interface over
// wifi.Client — wifi.IWD on the installer ISO's system bus, wifi.Fake in tests. iwd asks for the passphrase through the
// package's agent and writes the profile itself once the keys are set (a wrong password leaves nothing behind), so the
// profile the install copies is iwd's own file in /var/lib/iwd.

import (
	"context"
	"errors"
	"os"
	"sync"
	"time"

	"github.com/CybexBV/whombat/contracts/go/local"

	"github.com/CybexBV/whombat/appliance/helper/pkg/wifi"
)

// IWD is the machine's Wi-Fi card as iwd has it.
type IWD struct {
	Client  wifi.Client
	Dir     string              // iwd's state (wifi.StateDir)
	Address func(string) string // default: InterfaceAddress; tests inject the card's DHCP result
	Poll    time.Duration       // default: 200 ms

	mu   sync.Mutex
	secs map[string]wifi.Security // each network's kind, from the last scan and the joins
}

var _ Wifi = (*IWD)(nil)

// NewIWD is the installer ISO's card: iwd on the system bus, its profiles in wifi.StateDir.
func NewIWD() *IWD { return &IWD{Client: &wifi.IWD{}, Dir: wifi.StateDir} }

func (w *IWD) remember(ssid string, sec wifi.Security) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.secs == nil {
		w.secs = map[string]wifi.Security{}
	}
	w.secs[ssid] = sec
}

func (w *IWD) kind(ssid string) wifi.Security {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.secs[ssid]
}

// station is the Wi-Fi interface to use, or why there is none (no card, switched off, not a station).
func station(st *wifi.Status) (string, string) {
	if len(st.Adapters) == 0 {
		return "", "no_adapter"
	}
	if d := st.Station(); d != nil {
		return d.Interface, ""
	}
	for _, a := range st.Adapters {
		if !a.Powered {
			return "", "disabled"
		}
	}
	for _, d := range st.Devices {
		if !d.Powered {
			return "", "disabled"
		}
	}
	return "", "no_driver"
}

// Status implements Wifi.
func (w *IWD) Status(ctx context.Context) (WifiStatus, error) {
	st, err := w.Client.Status(ctx)
	if err != nil {
		return WifiStatus{}, err
	}
	if _, missing := station(st); missing != "" {
		return WifiStatus{Missing: missing}, nil
	}
	var out WifiStatus
	if s := st.Station().Station; s.State == wifi.StateConnected && s.Connected != nil {
		out.Connected = s.Connected.SSID
	}
	return out, nil
}

// securityName is iwd's kind as the contracts name it (WifiSecurity).
func securityName(s wifi.Security) string {
	switch s {
	case wifi.SecurityOpen:
		return "open"
	case wifi.SecurityPSK:
		return "psk"
	case wifi.SecurityEAP:
		return "enterprise"
	}
	return "other"
}

// bars is the contracts' signal for iwd's dBm (0: iwd didn't rank it, no bars).
func bars(dbm int) int64 {
	if dbm == 0 {
		return 0
	}
	return local.WifiSignalFromDBm(dbm)
}

// Scan implements Wifi.
func (w *IWD) Scan(ctx context.Context) ([]WifiNetwork, error) {
	st, err := w.Client.Status(ctx)
	if err != nil {
		return nil, err
	}
	iface, missing := station(st)
	if missing != "" {
		return nil, wifi.ErrNoStation
	}
	nets, err := w.Client.Scan(ctx, iface)
	if err != nil {
		return nil, err
	}
	out := make([]WifiNetwork, 0, len(nets))
	for _, n := range nets {
		w.remember(n.SSID, n.Security)
		out = append(out, WifiNetwork{Ssid: n.SSID, Security: securityName(n.Security), Signal: bars(n.SignalDBm),
			Saved: n.Known, Connected: n.Connected})
	}
	return out, nil
}

// Join implements Wifi: iwd's refusals as the contracts' failures.
func (w *IWD) Join(ctx context.Context, ssid string, passphrase *string, hidden bool) error {
	st, err := w.Client.Status(ctx)
	if err != nil {
		return &JoinError{Failure: "failed"}
	}
	iface, missing := station(st)
	if missing != "" {
		return &JoinError{Failure: "failed"}
	}
	j := wifi.Join{SSID: ssid, Hidden: hidden}
	if passphrase != nil {
		j.Passphrase = *passphrase
	}
	if !hidden {
		j.Security = w.kind(ssid) // "" when it wasn't in the scan: iwd's own
	}
	jctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	err = w.Client.Connect(jctx, iface, j)
	cancel()
	switch {
	case err == nil:
	case errors.Is(err, wifi.ErrWrongPassword), errors.Is(err, wifi.ErrInvalidPassphrase):
		return &JoinError{Failure: "wrong_password"}
	case errors.Is(err, wifi.ErrNotFound):
		return &JoinError{Failure: "not_found"}
	default:
		return &JoinError{Failure: "failed"}
	}
	sec := j.Security
	if sec == "" {
		sec = wifi.SecurityOpen
		if j.Passphrase != "" {
			sec = wifi.SecurityPSK
		}
	}
	w.remember(ssid, sec)
	address := w.Address
	if address == nil {
		address = InterfaceAddress
	}
	poll := w.Poll
	if poll <= 0 {
		poll = 200 * time.Millisecond
	}
	actx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	ticker := time.NewTicker(poll)
	defer ticker.Stop()
	for {
		if address(iface) != "" {
			return nil
		}
		select {
		case <-actx.Done():
			return &JoinError{Failure: "no_address"}
		case <-ticker.C:
		}
	}
}

// Profile implements Wifi: iwd's own file for the network (psk, else open when its kind isn't known).
func (w *IWD) Profile(ssid string) (WifiProfile, error) {
	secs := []wifi.Security{wifi.SecurityPSK, wifi.SecurityOpen}
	if k := w.kind(ssid); k != "" {
		secs = []wifi.Security{k}
	}
	err := os.ErrNotExist
	for _, sec := range secs {
		var data []byte
		if data, err = wifi.ReadProfile(w.Dir, ssid, sec); err != nil {
			continue
		}
		name, err := wifi.ProfileName(ssid, sec)
		if err != nil {
			return WifiProfile{}, err
		}
		return WifiProfile{Name: name, Data: data}, nil
	}
	return WifiProfile{}, err
}
