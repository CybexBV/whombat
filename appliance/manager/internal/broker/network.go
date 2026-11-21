package broker

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/CybexBV/whombat/appliance/helper/pkg/proto"
	"github.com/CybexBV/whombat/appliance/manager/internal/netguard"
	"github.com/CybexBV/whombat/contracts/go/local"
)

// The network routes (contracts 0.102.0 local networkState, wifiScan, wifiJoin, wifiForget; 3.13.0 cableSet; MG-102):
// the runtime's uid only, bodies at most networkBodyMax. A join carries a passphrase: no answer, error or log line of
// these routes repeats a request.

const (
	networkBodyMax = 2 * 1024
	// forgetConfirmSec is a forget's confirmation deadline (the contract's forget has none; HD-06's 2 minutes).
	forgetConfirmSec = 120
)

func (s *Server) noNet(w http.ResponseWriter) bool {
	if s.Net == nil {
		writeErr(w, http.StatusNotFound, "unavailable", "this manager does not manage the network")
		return true
	}
	return false
}

// wifiErr maps the guard's errors (the contract: 409 no_wifi, busy, in_use; 404 not_saved; 400 invalid_passphrase).
func (s *Server) wifiErr(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, netguard.ErrNoWifi):
		writeErr(w, http.StatusConflict, local.WifiErrorNoWifi, "this Whombat has no Wi-Fi it can use")
	case errors.Is(err, netguard.ErrBusy):
		writeErr(w, http.StatusConflict, local.WifiErrorBusy, "a network change is already running")
	case errors.Is(err, netguard.ErrInUse):
		writeErr(w, http.StatusConflict, local.WifiErrorInUse, "this Whombat reaches the internet only through that network")
	case errors.Is(err, netguard.ErrNotSaved):
		writeErr(w, http.StatusNotFound, local.WifiErrorNotSaved, "that network is not saved")
	case errors.Is(err, netguard.ErrInvalidPassphrase):
		writeErr(w, http.StatusBadRequest, local.WifiErrorInvalidPassphrase, "that network needs a valid password")
	default:
		s.log().Warn("broker: Wi-Fi", "err", err)
		writeErr(w, http.StatusServiceUnavailable, "unavailable", "the Wi-Fi didn't answer")
	}
}

func (s *Server) networkState(w http.ResponseWriter, r *http.Request) {
	if s.noNet(w) {
		return
	}
	b, ok := readBody(w, r)
	if !ok {
		return
	}
	if _, err := local.ParseNetworkStateRequest(b); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	n, err := s.Net.NetworkState(r.Context())
	if err != nil {
		writeErr(w, http.StatusServiceUnavailable, "unavailable", err.Error())
		return
	}
	resp := local.NetworkStateResponse{V: 1, Network: n}
	if err := resp.Validate(); err != nil || !local.HostNetworkValid(n) {
		s.log().Error("broker: the network state breaks its contract", "err", err)
		writeErr(w, http.StatusInternalServerError, "internal", "the network state is not valid")
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

func (s *Server) wifiScan(w http.ResponseWriter, r *http.Request) {
	if s.noNet(w) {
		return
	}
	b, ok := readBody(w, r)
	if !ok {
		return
	}
	if _, err := local.ParseWifiScanRequest(b); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	scan, err := s.Net.Scan(r.Context())
	if err != nil {
		s.wifiErr(w, err)
		return
	}
	resp := local.WifiScanResponse{V: 1, Scan: scan}
	if err := resp.Validate(); err != nil {
		s.log().Error("broker: the scan breaks its contract", "err", err)
		writeErr(w, http.StatusInternalServerError, "internal", "the scan is not valid")
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

func (s *Server) wifiChange(w http.ResponseWriter, resp local.WifiChangeResponse) {
	if err := resp.Validate(); err != nil || !local.NetworkChangeValid(resp.Change) {
		s.log().Error("broker: the change breaks its contract", "err", err)
		writeErr(w, http.StatusInternalServerError, "internal", "the change is not valid")
		return
	}
	writeJSON(w, http.StatusAccepted, resp)
}

func (s *Server) wifiJoin(w http.ResponseWriter, r *http.Request) {
	if s.noNet(w) {
		return
	}
	b, ok := readBody(w, r)
	if !ok {
		return
	}
	// The passphrase on its own first (400 invalid_passphrase), then the strict schema, whose errors are never repeated:
	// they may quote the passphrase.
	var loose struct {
		Passphrase *string `json:"passphrase"`
	}
	if json.Unmarshal(b, &loose) == nil && loose.Passphrase != nil && !proto.ValidWifiPassphrase(*loose.Passphrase) {
		writeErr(w, http.StatusBadRequest, local.WifiErrorInvalidPassphrase, "the passphrase is not valid")
		return
	}
	req, err := local.ParseWifiJoinRequest(b)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "the join request is not valid")
		return
	}
	if !local.SsidValid(req.Ssid) {
		writeErr(w, http.StatusBadRequest, "bad_request", "the network name is not valid")
		return
	}
	j := netguard.WifiJoin{SSID: req.Ssid, ConfirmSec: int(req.ConfirmTimeoutSec)}
	if req.Passphrase != nil {
		j.Passphrase = *req.Passphrase
	}
	if req.Hidden != nil {
		j.Hidden = *req.Hidden
	}
	c, err := s.Net.Join(r.Context(), j)
	if err != nil {
		s.wifiErr(w, err)
		return
	}
	s.wifiChange(w, local.WifiChangeResponse{V: 1, Change: c})
}

func (s *Server) wifiForget(w http.ResponseWriter, r *http.Request) {
	if s.noNet(w) {
		return
	}
	b, ok := readBody(w, r)
	if !ok {
		return
	}
	req, err := local.ParseWifiForgetRequest(b)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	if !local.SsidValid(req.Ssid) {
		writeErr(w, http.StatusBadRequest, "bad_request", "the network name is not valid")
		return
	}
	c, err := s.Net.Forget(r.Context(), req.Ssid, forgetConfirmSec, s.Net.WiredConnected())
	if err != nil {
		s.wifiErr(w, err)
		return
	}
	s.wifiChange(w, local.WifiChangeResponse{V: 1, Change: c})
}

// cableErr maps the guard's refusals of a cable change (the contract: 409 busy, no_wifi, not_connected, no_cable,
// unchanged).
func (s *Server) cableErr(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, netguard.ErrBusy):
		writeErr(w, http.StatusConflict, local.CableErrorBusy, "a network change is already running")
	case errors.Is(err, netguard.ErrNoWifi):
		writeErr(w, http.StatusConflict, local.CableErrorNoWifi, "this Whombat has no Wi-Fi it can use")
	case errors.Is(err, netguard.ErrNotConnected):
		writeErr(w, http.StatusConflict, local.CableErrorNotConnected, "the Wi-Fi isn't connected to a network")
	case errors.Is(err, netguard.ErrNoCable):
		writeErr(w, http.StatusConflict, local.CableErrorNoCable, "no cable is plugged in")
	case errors.Is(err, netguard.ErrUnchanged):
		writeErr(w, http.StatusConflict, local.CableErrorUnchanged, "the network is set that way already")
	default:
		s.log().Warn("broker: cable", "err", err)
		writeErr(w, http.StatusServiceUnavailable, "unavailable", "the network didn't answer")
	}
}

// cableSet is POST /v1/network/cable: Wi-Fi only, or the cable again (202 with the change; the network loop makes it).
func (s *Server) cableSet(w http.ResponseWriter, r *http.Request) {
	if s.noNet(w) {
		return
	}
	b, ok := readBody(w, r)
	if !ok {
		return
	}
	req, err := local.ParseCableSetRequest(b)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	c, err := s.Net.CableSet(r.Context(), string(req.Use), int(req.ConfirmTimeoutSec))
	if err != nil {
		s.cableErr(w, err)
		return
	}
	resp := local.CableChangeResponse{V: 1, Change: c}
	if err := resp.Validate(); err != nil || !local.CableChangeValid(resp.Change) {
		s.log().Error("broker: the cable change breaks its contract", "err", err)
		writeErr(w, http.StatusInternalServerError, "internal", "the change is not valid")
		return
	}
	writeJSON(w, http.StatusAccepted, resp)
}
