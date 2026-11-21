package installer

// Wi-Fi in the installer (Whombat hardware-support.md HD-08, brief §2.6; CG-120…): after the checks, a machine without
// a cable that has an address gets a Wi-Fi step before the disk — choose a network, type its password; the installer
// joins it to prove the password works (the checks then run again over it), and the install copies the joined
// network's iwd profile into the installed system, so the box is online on its first boot. Skip stays possible.
//
// The Wi-Fi card is iwd's on the installer ISO, through `helper/pkg/wifi` (iwd.go adapts its client to the Wifi
// interface below; the server's tests use a fake of the interface, iwd_test.go the package's own fake).

import (
	"context"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"time"

	"github.com/CybexBV/whombat/contracts/go/local"

	"github.com/CybexBV/whombat/appliance/console/internal/desk"
	"github.com/CybexBV/whombat/appliance/console/internal/web"
)

// Wifi is the machine's Wi-Fi card as the installer uses it.
type Wifi interface {
	// Status is whether there is a working Wi-Fi card and the network it is connected to.
	Status(ctx context.Context) (WifiStatus, error)
	// Scan looks for networks around the machine (a fresh scan, at most about 10 s), strongest first.
	Scan(ctx context.Context) ([]WifiNetwork, error)
	// Join connects to ssid (a profile written first; without a passphrase an open or saved network), and returns once
	// iwd says connected and the joined card has an address, or a *JoinError
	// (a wrong password keeps nothing).
	Join(ctx context.Context, ssid string, passphrase *string, hidden bool) error
	// Profile is the profile iwd keeps for ssid: its file name in iwd's encoding (`Home.psk`, `=4361666520e2989520.psk`)
	// and its contents.
	Profile(ssid string) (WifiProfile, error)
}

// WifiStatus: Missing says why there is no Wi-Fi (`no_adapter`, `no_driver`, `disabled`; "" with a working card), and
// Connected is the network's name while connected ("" otherwise).
type WifiStatus struct {
	Missing   string
	Connected string
}

// WifiNetwork is one network a scan found (the contracts' WifiNetwork: security open | psk | enterprise | other, the
// bars 0…4).
type WifiNetwork struct {
	Ssid      string `json:"ssid"`
	Security  string `json:"security"`
	Signal    int64  `json:"signal"`
	Saved     bool   `json:"saved"`
	Connected bool   `json:"connected"`
}

// WifiProfile is an iwd network profile file.
type WifiProfile struct {
	Name string
	Data []byte
}

// JoinError is why a join didn't work: `wrong_password`, `not_found`, `no_address` or `failed` (NetworkChangeFailure
// but `no_internet`, which the installer doesn't check: the reach checks run again after a join and say so).
type JoinError struct{ Failure string }

func (e *JoinError) Error() string { return "wifi: " + e.Failure }

// WifiView is GET /api/wifi (§2.6): whether there is a Wi-Fi card (and why not), the network it is connected to, and
// the networks of the last scan.
type WifiView struct {
	Adapter     bool          `json:"adapter"`
	WifiMissing string        `json:"wifiMissing,omitempty"`
	Connected   string        `json:"connected,omitempty"`
	Networks    []WifiNetwork `json:"networks"`
}

const (
	wifiStatusTimeout = 2 * time.Second
	wifiScanTimeout   = 15 * time.Second
	wifiJoinTimeout   = 60 * time.Second // up to 30 s joining, then 30 s for DHCP/SLAAC
	maxScanNetworks   = 64
	maxProfileBytes   = 4096
)

// An iwd profile's file name: the name itself when it has only letters, digits, space, `-` and `_`, else `=` and the
// name's bytes in hex; `.psk` or `.open` (iwd.network(5)).
var profileNameRe = regexp.MustCompile(`^(?:=[0-9a-f]{2,64}|[A-Za-z0-9 _-]{1,32})\.(?:psk|open)$`)

// WithWifi gives the server the machine's Wi-Fi card (nil: none).
func (s *Server) WithWifi(w Wifi) *Server {
	s.wifi = w
	return s
}

var security = map[string]bool{"open": true, "psk": true, "enterprise": true, "other": true}

// WifiView is the card's state and the last scan's networks, checked: a network whose name isn't displayable, or that
// isn't one the contracts know, is left out.
func (s *Server) WifiView(ctx context.Context) WifiView {
	v := WifiView{Networks: []WifiNetwork{}}
	if s.wifi == nil {
		v.WifiMissing = "no_adapter"
		return v
	}
	ctx, cancel := context.WithTimeout(ctx, wifiStatusTimeout)
	defer cancel()
	st, err := s.wifi.Status(ctx)
	switch {
	case err != nil:
		v.WifiMissing = "no_driver"
		return v
	case st.Missing == "no_adapter" || st.Missing == "no_driver" || st.Missing == "disabled":
		v.WifiMissing = st.Missing
		return v
	}
	v.Adapter = true
	if local.SsidValid(st.Connected) {
		v.Connected = st.Connected
	}
	s.mu.Lock()
	v.Networks = append(v.Networks, s.networks...)
	s.mu.Unlock()
	return v
}

func cleanNetworks(in []WifiNetwork) []WifiNetwork {
	out := []WifiNetwork{}
	for _, n := range in {
		if len(out) == maxScanNetworks {
			break
		}
		if local.SsidValid(n.Ssid) && security[n.Security] && n.Signal >= 0 && n.Signal <= 4 {
			out = append(out, n)
		}
	}
	return out
}

// installing: an install runs or is done (Wi-Fi changes wait; the profile was taken when it started).
func (s *Server) installing() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.install.Status == "running" || s.install.Status == "done"
}

// Errors of the Wi-Fi requests (`{"message": code}`, the desk's codes).
var (
	errNoWifi = errors.New(local.DeskErrorNoWifi)
	errBusy   = errors.New("busy")
)

// Scan looks for networks and keeps what it found for GET /api/wifi.
func (s *Server) Scan(ctx context.Context) (WifiView, error) {
	if s.WifiView(ctx).WifiMissing != "" {
		return WifiView{}, errNoWifi
	}
	s.wifiMu.Lock()
	defer s.wifiMu.Unlock()
	if s.installing() {
		return WifiView{}, errBusy
	}
	ctx, cancel := context.WithTimeout(ctx, wifiScanTimeout)
	defer cancel()
	nets, err := s.wifi.Scan(ctx)
	if err != nil {
		return WifiView{}, err
	}
	s.mu.Lock()
	s.networks = cleanNetworks(nets)
	s.mu.Unlock()
	return s.WifiView(ctx), nil
}

// JoinResult is POST /api/wifi/join's answer: `{"connected": true}` or `{"failure": …}`.
type JoinResult struct {
	Connected bool   `json:"connected,omitempty"`
	Failure   string `json:"failure,omitempty"`
}

// Join joins a network to prove its password works (HD-08), and waits for an address; then the checks run again over
// it and the install will copy its profile. The passphrase goes to the card and nowhere else.
func (s *Server) Join(ctx context.Context, ssid string, passphrase *string, hidden bool) (JoinResult, error) {
	if s.installing() {
		return JoinResult{}, errBusy
	}
	if s.WifiView(ctx).WifiMissing != "" {
		return JoinResult{}, errNoWifi
	}
	if !s.wifiMu.TryLock() {
		return JoinResult{}, errBusy
	}
	defer s.wifiMu.Unlock()
	if s.installing() {
		return JoinResult{}, errBusy
	}
	jctx, cancel := context.WithTimeout(ctx, wifiJoinTimeout)
	err := s.wifi.Join(jctx, ssid, passphrase, hidden)
	cancel()
	var je *JoinError
	switch {
	case errors.As(err, &je):
		switch je.Failure {
		case "wrong_password", "not_found", "no_address":
			return JoinResult{Failure: je.Failure}, nil
		}
		return JoinResult{Failure: "failed"}, nil
	case err != nil:
		return JoinResult{Failure: "failed"}, nil
	}
	s.mu.Lock()
	s.joined = ssid
	s.mu.Unlock()
	// The network and reach checks were run without it.
	s.StartPreflight()
	return JoinResult{Connected: true}, nil
}

// wifiProfile writes the joined network's profile into a new private directory for whombat-install (it copies it into
// the target's /var/lib/iwd); "" when nothing was joined. The caller removes the directory.
func (s *Server) wifiProfile() (string, error) {
	s.mu.Lock()
	ssid := s.joined
	s.mu.Unlock()
	if ssid == "" || s.wifi == nil {
		return "", nil
	}
	p, err := s.wifi.Profile(ssid)
	if err != nil {
		return "", err
	}
	if !profileNameRe.MatchString(p.Name) || len(p.Data) == 0 || len(p.Data) > maxProfileBytes {
		return "", errors.New("not an iwd profile")
	}
	dir, err := os.MkdirTemp(s.tmpDir, "whombat-wifi-")
	if err != nil {
		return "", err
	}
	path := filepath.Join(dir, p.Name)
	if err := os.WriteFile(path, p.Data, 0o600); err != nil {
		os.RemoveAll(dir)
		return "", err
	}
	return path, nil
}

// wifiRoutes adds GET /api/wifi and POST /api/wifi/scan|join.
func (s *Server) wifiRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/api/wifi", func(w http.ResponseWriter, r *http.Request) {
		if web.Method(w, r, http.MethodGet) {
			web.JSON(w, http.StatusOK, s.WifiView(r.Context()))
		}
	})
	mux.HandleFunc("/api/wifi/scan", func(w http.ResponseWriter, r *http.Request) {
		if !web.Method(w, r, http.MethodPost) {
			return
		}
		v, err := s.Scan(r.Context())
		if err != nil {
			wifiError(w, err)
			return
		}
		web.JSON(w, http.StatusOK, v)
	})
	mux.HandleFunc("/api/wifi/join", func(w http.ResponseWriter, r *http.Request) {
		if !web.Method(w, r, http.MethodPost) {
			return
		}
		var in struct {
			Ssid       string  `json:"ssid"`
			Passphrase *string `json:"passphrase"`
			Hidden     bool    `json:"hidden"`
		}
		if !web.DecodeJSON(w, r, &in) {
			return
		}
		if !local.SsidValid(in.Ssid) {
			web.Error(w, http.StatusBadRequest, local.DeskErrorBadRequest)
			return
		}
		if in.Passphrase != nil && !desk.PassphraseValid(*in.Passphrase) {
			web.Error(w, http.StatusBadRequest, local.DeskErrorInvalidPassphrase)
			return
		}
		res, err := s.Join(r.Context(), in.Ssid, in.Passphrase, in.Hidden)
		if err != nil {
			wifiError(w, err)
			return
		}
		web.JSON(w, http.StatusOK, res)
	})
}

func wifiError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errNoWifi), errors.Is(err, errBusy):
		web.Error(w, http.StatusConflict, err.Error())
	default:
		web.Error(w, http.StatusBadGateway, "failed")
	}
}
