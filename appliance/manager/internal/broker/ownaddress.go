package broker

// The own address (Whombat own-address.md, MG-166): the runtime reads the manager's state, registers the label it drew,
// fetches the certificate pair of each host the box answers at, reads the certificate watch, and asks control about a
// new name and for it. The manager keeps the label, the keys and the watch's record; control is the names' registry.
//
//	POST /v1/own-address/state    {v: 1}         runtime → 200 OwnAddressStateResponse (enabled false: none here)
//	POST /v1/own-address/register {v: 1, label}  runtime → 200 OwnAddressStateResponse | 404 own_address.off |
//	                                                       409 own_address.label_taken / .label_invalid |
//	                                                       503 control_unreachable | 502 control_refused
//	POST /v1/own-address/cert     {v: 1, host?}  runtime → 200 OwnAddressCertResponse | 404 own_address.off |
//	                                                       409 own_address.no_cert (none yet, or a host not served)
//	POST /v1/own-address/ct       {v: 1}         runtime → 200 OwnAddressCtResponse | 404 own_address.off
//	POST /v1/own-address/check    {v: 1, label}  runtime → 200 OwnAddressCheckResponse | 404 own_address.off |
//	                                                       409 own_address.link_off | 503 control_unreachable |
//	                                                       502 control_refused
//	POST /v1/own-address/rename   {v: 1, label}  runtime → 200 OwnAddressStateResponse | 404 own_address.off |
//	                                                       409 own_address.label_taken / .label_invalid /
//	                                                       .label_reserved / .rename_limit / .link_off |
//	                                                       503 control_unreachable | 502 control_refused
//
// Linking the box to an account and the box passkeys' declared set go to control as the runtime sent them, like the
// shared links (share.go): POST /v1/runtime/account/link-lookup, /v1/runtime/account/link, /v1/backup/kit-credentials.

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"time"

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
	Adopt(a ownaddress.Address) (bool, error)
	Cert(host string) (*local.OwnAddressCertResponse, bool)
	CT() (*local.OwnAddressCtResponse, error)
}

// ownAddressBodyMax: every own-address request is {v: 1}, {v: 1, label} or {v: 1, host}.
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
	// A box registers one label; once the manager has one, that is the answer, whatever was sent (a new name is a
	// rename).
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
	req, err := local.ParseOwnAddressCertRequest(b)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	if s.ownAddressOff(w) {
		return
	}
	host := ""
	if req.Host != nil {
		host = *req.Host
	}
	c, ok := s.OwnAddress.Cert(host)
	if !ok {
		writeErr(w, http.StatusConflict, local.OwnAddressErrorNoCert, "no certificate for that host now")
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

// ownAddressLinkOff answers 409 own_address.link_off when control can't be asked about names now: no control, or Link
// not starting, on or in grace.
func (s *Server) ownAddressLinkOff(w http.ResponseWriter) bool {
	if s.Control == nil || (s.Link != nil && !s.Link.Active()) {
		writeErr(w, http.StatusConflict, local.OwnAddressErrorLinkOff, "only while Whombat Link is on")
		return true
	}
	return false
}

// ownAddressControlErr answers control's refusal of address.check or address.rename with the route's own codes.
func (s *Server) ownAddressControlErr(w http.ResponseWriter, op device.DeviceOpName, err error) {
	code, detail := controlapi.ErrorCodes(err)
	is := func(c string) bool { return code == c || detail == c }
	switch {
	case errors.Is(err, controlapi.ErrUnavailable):
		w.Header().Set("Retry-After", "60")
		writeErr(w, http.StatusServiceUnavailable, "control_unreachable", "control can't be reached now: "+err.Error())
	case is("label_taken"):
		writeErr(w, http.StatusConflict, local.OwnAddressErrorLabelTaken, "that name is taken")
	case is("label_invalid"):
		writeErr(w, http.StatusConflict, local.OwnAddressErrorLabelInvalid, "control refused that name")
	case is("label_reserved"):
		writeErr(w, http.StatusConflict, local.OwnAddressErrorLabelReserved, "that name isn't available")
	case is("rename_limit"):
		writeErr(w, http.StatusConflict, local.OwnAddressErrorRenameLimit, "too many changes of the address this year")
	case is("link_off"):
		writeErr(w, http.StatusConflict, local.OwnAddressErrorLinkOff, "control says Whombat Link is off for this Whombat")
	case is("own_address_off"):
		writeErr(w, http.StatusNotFound, local.OwnAddressErrorOff, "control gives no own addresses now")
	default:
		s.controlRefused(w, op, code, detail, err)
	}
}

// ownAddressOpTimeout bounds one name check or rename at control.
const ownAddressOpTimeout = 30 * time.Second

func (s *Server) ownAddressCheck(w http.ResponseWriter, r *http.Request) {
	b, ok := readBody(w, r)
	if !ok {
		return
	}
	req, err := local.ParseOwnAddressCheckRequest(b)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	if s.ownAddressOff(w) || s.ownAddressLinkOff(w) {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), ownAddressOpTimeout)
	defer cancel()
	var resp device.AddressCheckResponse
	if err := s.Control.Do(ctx, device.DeviceOpNameAddressCheck, device.AddressCheckRequest{Label: req.Label}, &resp); err != nil {
		s.ownAddressControlErr(w, device.DeviceOpNameAddressCheck, err)
		return
	}
	if err := resp.Validate(); err != nil {
		writeErr(w, http.StatusBadGateway, "control_refused", "control's answer to address.check is not the contract's: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, local.OwnAddressCheckResponse{V: 1, Label: resp.Label, Verdict: resp.Verdict})
}

func (s *Server) ownAddressRename(w http.ResponseWriter, r *http.Request) {
	b, ok := readBody(w, r)
	if !ok {
		return
	}
	req, err := local.ParseOwnAddressRenameRequest(b)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	if s.ownAddressOff(w) || s.ownAddressLinkOff(w) {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), ownAddressOpTimeout)
	defer cancel()
	if err := s.RenameAddress(ctx, req.Label); err != nil {
		var bad *badAnswer
		if errors.As(err, &bad) {
			s.log().Error("own address: control's answer to address.rename refused", "err", err)
			writeErr(w, http.StatusBadGateway, "control_refused", err.Error())
			return
		}
		s.ownAddressControlErr(w, device.DeviceOpNameAddressRename, err)
		return
	}
	writeJSON(w, http.StatusOK, s.OwnAddress.State())
}

// badAnswer: control answered, but not with an address the box can take.
type badAnswer struct{ err error }

func (e *badAnswer) Error() string { return e.err.Error() }
func (e *badAnswer) Unwrap() error { return e.err }

// RenameAddress asks control for label as the box's name (address.rename, signed by the box) and takes the answer: a
// new name, or the same label under control's zone (a move). Either way the earlier host keeps answering while control
// says so, cached tickets go (the next one carries the new label, and the earlier one as plbl), and the Link state
// names the new label. The owner's rename and the manager's own move both come here.
func (s *Server) RenameAddress(ctx context.Context, label string) error {
	if s.OwnAddress == nil || s.Control == nil {
		return errors.New("this Whombat has no own address")
	}
	var resp device.AddressRenameResponse
	if err := s.Control.Do(ctx, device.DeviceOpNameAddressRename, device.AddressRenameRequest{Label: label}, &resp); err != nil {
		return err
	}
	if err := resp.Validate(); err != nil {
		return &badAnswer{fmt.Errorf("control's answer to address.rename is not the contract's: %w", err)}
	}
	changed, err := s.OwnAddress.Adopt(ownaddress.Address{Label: resp.Label, Host: resp.Host, RegisteredAt: resp.RegisteredAt, Leaving: resp.Leaving})
	if err != nil {
		return &badAnswer{err}
	}
	if changed {
		s.DropTickets()
	}
	if s.Link != nil {
		s.Link.FollowAddress(resp.Label, resp.Host)
	}
	return nil
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
