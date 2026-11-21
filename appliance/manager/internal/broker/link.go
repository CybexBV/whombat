package broker

// Whombat Link on the manager socket (contracts 4.4, Whombat whombat-link.md; MG-171):
//
//	POST /v1/link/state             {v: 1}                          runtime → 200 LinkStateResponse
//	POST /v1/link/on                {v: 1, contentProof, name?}     runtime → 200 LinkStateResponse | 404 link.unavailable |
//	                                                                          409 link.busy / link.device_exists |
//	                                                                          429 link.rate_limited | 503 control_unreachable |
//	                                                                          502 control_refused
//	POST /v1/link/off               {v: 1}                          runtime → 200 LinkStateResponse (off) | 404 | 409 busy
//	POST /v1/runtime/push/register  {token}                         runtime → control's push.register answer
//	POST /v1/runtime/push/unregister {handle}                       runtime → control's push.unregister answer
//
// Turning Link off answers `off` at once: the box stops using Link before control has heard of it, and the manager
// tells control (link.leave) as soon as it answers.
//
// The gate: every route that goes to control asks the Link state first (gate, noControl). Link features (tickets,
// shares, the feedback drop, kit envelope copies, remote help's ticket, the own address's label, push tokens) need Link
// starting, on or in grace; what is never gated (claim and revocation reports, push.send — control lets only security
// pushes through once Link ended — and forgetting a push token) needs control to know the box (any state but off). A
// box with Link off sends nothing to control (LNK-03).

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/CybexBV/whombat/appliance/manager/internal/controlapi"
	"github.com/CybexBV/whombat/appliance/manager/internal/link"
	"github.com/CybexBV/whombat/contracts/go/device"
	"github.com/CybexBV/whombat/contracts/go/local"
)

// Link is the manager's Link state as the broker needs it (manager/internal/link.Keeper).
type Link interface {
	Available() bool
	Active() bool
	Known() bool
	Snapshot() link.Record
	On(ctx context.Context, contentProof, name string) (link.Record, error)
	Off(ctx context.Context) (link.Record, error)
	Observe(st *device.DeviceLinkStatus)
}

// linkBodyMax: {v: 1, contentProof (128 hex), name (64)} and the push routes' token.
const linkBodyMax = 8 << 10

// linkOpTimeout bounds one Link change at control.
const linkOpTimeout = 30 * time.Second

// What a route needs of the Link state.
type linkNeed int

const (
	needActive linkNeed = iota
	needKnown
)

// gate answers 404 unavailable when the box has no control, or its Link state doesn't allow the route.
func (s *Server) gate(w http.ResponseWriter, need linkNeed) bool {
	if s.Control == nil {
		writeErr(w, http.StatusNotFound, "unavailable", "this Whombat has no control service")
		return true
	}
	if s.Link == nil {
		return false
	}
	ok := s.Link.Active()
	if need == needKnown {
		ok = s.Link.Known()
	}
	if !ok {
		writeErr(w, http.StatusNotFound, "unavailable", "Whombat Link is off on this Whombat")
		return true
	}
	return false
}

func (s *Server) linkResponse(r link.Record) local.LinkStateResponse {
	enabled := s.Link != nil && s.Link.Available()
	return local.LinkStateResponse{V: 1, Enabled: enabled, Link: r.Status()}
}

func (s *Server) linkErr(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, link.ErrUnavailable):
		writeErr(w, http.StatusNotFound, local.LinkErrorUnavailable, err.Error())
	case errors.Is(err, link.ErrBusy):
		writeErr(w, http.StatusConflict, local.LinkErrorBusy, err.Error())
	case errors.Is(err, link.ErrDeviceExists):
		writeErr(w, http.StatusConflict, local.LinkErrorDeviceExists, err.Error())
	case errors.Is(err, link.ErrRateLimited):
		w.Header().Set("Retry-After", "600")
		writeErr(w, http.StatusTooManyRequests, local.LinkErrorRateLimited, err.Error())
	case errors.Is(err, controlapi.ErrUnavailable):
		w.Header().Set("Retry-After", "30")
		writeErr(w, http.StatusServiceUnavailable, "control_unreachable", err.Error())
	default:
		writeErr(w, http.StatusBadGateway, "control_refused", err.Error())
	}
}

func (s *Server) linkState(w http.ResponseWriter, r *http.Request) {
	b, ok := readBody(w, r)
	if !ok {
		return
	}
	if _, err := local.ParseLinkStateRequest(b); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	if s.Link == nil {
		writeJSON(w, http.StatusOK, s.linkResponse(link.Record{State: "off", Since: s.now()}))
		return
	}
	writeJSON(w, http.StatusOK, s.linkResponse(s.Link.Snapshot()))
}

func (s *Server) linkOn(w http.ResponseWriter, r *http.Request) {
	b, ok := readBody(w, r)
	if !ok {
		return
	}
	req, err := local.ParseLinkOnRequest(b)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	if s.Link == nil {
		s.linkErr(w, link.ErrUnavailable)
		return
	}
	name := ""
	if req.Name != nil {
		name = *req.Name
	}
	ctx, cancel := context.WithTimeout(r.Context(), linkOpTimeout)
	defer cancel()
	rec, err := s.Link.On(ctx, req.ContentProof, name)
	if err != nil {
		s.linkErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, s.linkResponse(rec))
}

func (s *Server) linkOff(w http.ResponseWriter, r *http.Request) {
	b, ok := readBody(w, r)
	if !ok {
		return
	}
	if _, err := local.ParseLinkOffRequest(b); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	if s.Link == nil {
		s.linkErr(w, link.ErrUnavailable)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), linkOpTimeout)
	defer cancel()
	rec, err := s.Link.Off(ctx)
	if err != nil {
		s.linkErr(w, err)
		return
	}
	s.DropTickets()
	writeJSON(w, http.StatusOK, s.linkResponse(rec))
}

// DropTickets forgets the cached tickets: after Link went off none is handed out again.
func (s *Server) DropTickets() {
	s.mu.Lock()
	s.tickets, s.ticketAt = nil, nil
	s.mu.Unlock()
	s.supportMu.Lock()
	s.supportCached = nil
	s.supportMu.Unlock()
}

// pushRegister forwards a phone's push token to control (LNK-36): the device op's body and answer, unchanged.
func (s *Server) pushRegister(w http.ResponseWriter, r *http.Request) {
	if s.gate(w, needActive) {
		return
	}
	b, ok := readBody(w, r)
	if !ok {
		return
	}
	req, err := local.ParseRuntimePushRegisterRequest(b)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	var out local.RuntimePushRegisterResponse
	if err := s.Control.Do(r.Context(), device.DeviceOpNamePushRegister, req, &out); err != nil {
		s.controlErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// pushUnregister has control forget a handle (a device was removed); never gated beyond control knowing the box.
func (s *Server) pushUnregister(w http.ResponseWriter, r *http.Request) {
	if s.gate(w, needKnown) {
		return
	}
	b, ok := readBody(w, r)
	if !ok {
		return
	}
	req, err := local.ParseRuntimePushUnregisterRequest(b)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	var out local.RuntimePushUnregisterResponse
	if err := s.Control.Do(r.Context(), device.DeviceOpNamePushUnregister, req, &out); err != nil {
		s.controlErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}
