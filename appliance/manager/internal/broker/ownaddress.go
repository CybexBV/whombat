package broker

// The own address (Whombat own-address.md, MG-166): the runtime reads the manager's state, registers the label it drew,
// fetches the current certificate pair and reads the certificate watch. The manager keeps the label, the keys and the
// watch's record; control is only the label's registry.
//
//	POST /v1/own-address/state    {v: 1}         runtime → 200 OwnAddressStateResponse (enabled false: none here)
//	POST /v1/own-address/register {v: 1, label}  runtime → 200 OwnAddressStateResponse | 404 own_address.off |
//	                                                       409 own_address.label_taken / .label_invalid |
//	                                                       503 control_unreachable | 502 control_refused
//	POST /v1/own-address/cert     {v: 1}         runtime → 200 OwnAddressCertResponse | 404 own_address.off | 409 own_address.no_cert
//	POST /v1/own-address/ct       {v: 1}         runtime → 200 OwnAddressCtResponse | 404 own_address.off
//
// Linking the box to an account and the box passkeys' declared set go to control as the runtime sent them, like the
// shared links (share.go): POST /v1/runtime/account/link-lookup, /v1/runtime/account/link, /v1/backup/kit-credentials.

import (
	"errors"
	"net/http"

	"github.com/CybexBV/whombat/appliance/manager/internal/controlapi"
	"github.com/CybexBV/whombat/appliance/manager/internal/ownaddress"
	"github.com/CybexBV/whombat/contracts/go/device"
	"github.com/CybexBV/whombat/contracts/go/local"
)

// OwnAddress is the manager's own-address service as the broker needs it (manager/internal/ownaddress).
type OwnAddress interface {
	State() local.OwnAddressStateResponse
	Label() (label, host string)
	Accept(resp *device.AddressRegisterResponse) error
	Cert() (*local.OwnAddressCertResponse, bool)
	CT() (*local.OwnAddressCtResponse, error)
}

// ownAddressBodyMax: every own-address request is {v: 1} or {v: 1, label}.
const ownAddressBodyMax = 1024

func (s *Server) ownAddressOff(w http.ResponseWriter) bool {
	if s.OwnAddress == nil {
		writeErr(w, http.StatusNotFound, local.OwnAddressErrorOff, "this Whombat has no own address")
		return true
	}
	return false
}

func (s *Server) ownAddressState(w http.ResponseWriter, r *http.Request) {
	b, ok := readBody(w, r)
	if !ok {
		return
	}
	if _, err := local.ParseOwnAddressStateRequest(b); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	if s.OwnAddress == nil {
		// An image or environment without one: the runtime does nothing about it (and isn't an A3 box).
		writeJSON(w, http.StatusOK, local.OwnAddressStateResponse{V: 1, Enabled: false,
			Acme: local.OwnAddressStateResponseAcme{State: local.OwnAddressAcmeStateIdle}})
		return
	}
	st := s.OwnAddress.State()
	if s.Link != nil && !s.Link.Active() {
		// The own address is a Link feature (LNK-05): without Link the runtime does nothing about it.
		st.Enabled = false
	}
	writeJSON(w, http.StatusOK, st)
}

func (s *Server) ownAddressRegister(w http.ResponseWriter, r *http.Request) {
	b, ok := readBody(w, r)
	if !ok {
		return
	}
	req, err := local.ParseOwnAddressRegisterRequest(b)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	if s.ownAddressOff(w) || s.noControl(w) {
		return
	}
	// One label per device, never changed in phase 1: once the manager has one, that is the answer, whatever was sent.
	if label, _ := s.OwnAddress.Label(); label != "" {
		writeJSON(w, http.StatusOK, s.OwnAddress.State())
		return
	}
	var resp device.AddressRegisterResponse
	if err := s.Control.Do(r.Context(), device.DeviceOpNameAddressRegister, device.AddressRegisterRequest{Label: req.Label}, &resp); err != nil {
		code, detail := controlapi.ErrorCodes(err)
		switch {
		case errors.Is(err, controlapi.ErrUnavailable):
			w.Header().Set("Retry-After", "60")
			writeErr(w, http.StatusServiceUnavailable, "control_unreachable", "control can't be reached now: "+err.Error())
		case code == "label_taken" || detail == "label_taken":
			writeErr(w, http.StatusConflict, local.OwnAddressErrorLabelTaken, "control says that label is taken")
		case code == "label_invalid" || detail == "label_invalid":
			writeErr(w, http.StatusConflict, local.OwnAddressErrorLabelInvalid, "control refused that label")
		default:
			s.controlRefused(w, device.DeviceOpNameAddressRegister, code, detail, err)
		}
		return
	}
	if err := resp.Validate(); err != nil {
		writeErr(w, http.StatusBadGateway, "control_refused", "control's answer to address.register is not the contract's: "+err.Error())
		return
	}
	if err := s.OwnAddress.Accept(&resp); err != nil {
		s.log().Error("own address: control's answer refused", "err", err)
		writeErr(w, http.StatusBadGateway, "control_refused", err.Error())
		return
	}
	// The next ticket must carry the label (lbl): a cached one from before wouldn't for up to its lifetime.
	s.mu.Lock()
	s.tickets = nil
	s.mu.Unlock()
	writeJSON(w, http.StatusOK, s.OwnAddress.State())
}

func (s *Server) controlRefused(w http.ResponseWriter, op device.DeviceOpName, code, detail string, err error) {
	codes := "refused"
	if code != "" && detail != "" && detail != code {
		codes = code + " " + detail
	} else if code != "" || detail != "" {
		codes = code + detail
	}
	writeErr(w, http.StatusBadGateway, "control_refused", codes+": control refused "+string(op)+": "+err.Error())
}

func (s *Server) ownAddressCert(w http.ResponseWriter, r *http.Request) {
	b, ok := readBody(w, r)
	if !ok {
		return
	}
	if _, err := local.ParseOwnAddressCertRequest(b); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	if s.ownAddressOff(w) {
		return
	}
	c, ok := s.OwnAddress.Cert()
	if !ok {
		writeErr(w, http.StatusConflict, local.OwnAddressErrorNoCert, "no certificate yet")
		return
	}
	writeJSON(w, http.StatusOK, c)
}

func (s *Server) ownAddressCT(w http.ResponseWriter, r *http.Request) {
	b, ok := readBody(w, r)
	if !ok {
		return
	}
	if _, err := local.ParseOwnAddressCtRequest(b); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	if s.ownAddressOff(w) {
		return
	}
	c, err := s.OwnAddress.CT()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, c)
}

// The forwarded routes of the own address: bodies and answers are the device ops' own (local.Runtime…), checked both
// ways, with control's refusal codes leading the message (shareErr).
var ownAddressForwards = map[string]shareRoute{
	local.ManagerPathAccountLinkLookup: {
		op: device.DeviceOpNameAccountLinkLookup, requestMax: 4 << 10, answerMax: 4 << 10, timeout: shareTimeout,
		parseReq: func(b []byte) (any, error) { return local.ParseRuntimeAccountLinkLookupRequest(b) },
		checkResp: func(b []byte) error {
			_, err := local.ParseRuntimeAccountLinkLookupResponse(b)
			return err
		},
	},
	local.ManagerPathAccountLink: {
		op: device.DeviceOpNameAccountLink, requestMax: 4 << 10, answerMax: 4 << 10, timeout: shareTimeout,
		parseReq: func(b []byte) (any, error) { return local.ParseRuntimeAccountLinkRequest(b) },
		checkResp: func(b []byte) error {
			_, err := local.ParseRuntimeAccountLinkResponse(b)
			return err
		},
	},
	// The full set of the box's passkeys (up to 64 ids of up to 512 characters).
	local.ManagerPathKitCredentials: {
		op: device.DeviceOpNameKitCredentialsDeclare, requestMax: device.DeviceRequestMaxBytes, answerMax: 4 << 10, timeout: shareTimeout,
		parseReq: func(b []byte) (any, error) { return local.ParseRuntimeKitCredentialsRequest(b) },
		checkResp: func(b []byte) error {
			_, err := local.ParseRuntimeKitCredentialsResponse(b)
			return err
		},
	},
}

var _ OwnAddress = (*ownaddress.Service)(nil)
