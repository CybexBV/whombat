package broker

// POST /v1/support/ticket (contracts 0.120.0 `MANAGER_PATHS.supportTicket`, CT-940; remote help RH-06; MG-118): the
// support service (root) gets an appliance ticket for the device's support route, which control keeps apart from the
// runtime's route, so its relay worker can answer support connections while an owner's grant is active. The management
// key stays here, as for the runtime's tickets (MG-11).

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"time"

	"github.com/CybexBV/whombat/appliance/manager/internal/controlapi"
	"github.com/CybexBV/whombat/contracts/go/device"
)

// SupportControl fetches support route tickets (controlapi.Client.SupportTicket).
type SupportControl interface {
	SupportTicket(ctx context.Context) (*device.SupportTicketResponse, error)
}

// supportTicketTimeout bounds one call to control for a ticket.
const supportTicketTimeout = 30 * time.Second

// supportTicket answers control's TicketResponse for the support route, reused until TicketMargin (60 s) before it
// expires; the body is empty or `{}` (SupportTicketRequest). Control's refusals pass on with their code
// (supportRefusal); unreachable is 503 unavailable, as for the runtime's tickets.
func (s *Server) supportTicket(w http.ResponseWriter, r *http.Request) {
	if s.Support == nil {
		writeErr(w, http.StatusNotFound, "unavailable", "this manager doesn't fetch support tickets")
		return
	}
	if s.Link != nil && !s.Link.Active() {
		// Remote help is a Link feature (LNK-07): its tickets come only while Link is starting, on or in grace.
		writeErr(w, http.StatusNotFound, "unavailable", "Whombat Link is off on this Whombat")
		return
	}
	b, err := io.ReadAll(r.Body)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "the request is too large")
		return
	}
	if len(b) > 0 {
		var req struct{}
		if err := decodeBytes(b, &req); err != nil {
			writeErr(w, http.StatusBadRequest, "bad_request", "the body must be {}")
			return
		}
	}
	margin := s.TicketMargin
	if margin == 0 {
		margin = 60 * time.Second
	}
	s.supportMu.Lock()
	defer s.supportMu.Unlock()
	if t := s.supportCached; t != nil && s.now().Add(margin).Before(time.Unix(t.ExpiresAt, 0)) {
		writeJSON(w, http.StatusOK, t)
		return
	}
	s.supportCached = nil
	ctx, cancel := context.WithTimeout(r.Context(), supportTicketTimeout)
	defer cancel()
	t, err := s.Support.SupportTicket(ctx)
	if err != nil {
		status, code := supportRefusal(err)
		if status == http.StatusServiceUnavailable {
			w.Header().Set("Retry-After", "30")
		}
		writeErr(w, status, code, err.Error())
		return
	}
	if !s.now().Add(margin).Before(time.Unix(t.ExpiresAt, 0)) {
		writeErr(w, http.StatusBadGateway, "control_refused", "control returned a ticket that expires too soon")
		return
	}
	s.supportCached = t
	writeJSON(w, http.StatusOK, t)
}

// supportRefusal is how control's refusal of support.ticket reaches the support service (CT-940): a retired device 403
// device_revoked, an unclaimed one 409 device_unclaimed, 429 rate_limited; unreachable (and 5xx) 503 unavailable; any
// other refusal (a control before the op: 404) 502 control_refused.
func supportRefusal(err error) (int, string) {
	var he *controlapi.HTTPError
	_, detail := controlapi.ErrorCodes(err)
	switch {
	case controlapi.IsRevoked(err):
		return http.StatusForbidden, controlapi.LicenceRevoked
	case errors.As(err, &he) && he.Status == http.StatusTooManyRequests:
		return http.StatusTooManyRequests, controlapi.LicenceRateLimited
	case errors.Is(err, controlapi.ErrUnavailable):
		return http.StatusServiceUnavailable, "unavailable"
	case detail == controlapi.LicenceUnclaimed:
		return http.StatusConflict, controlapi.LicenceUnclaimed
	}
	return http.StatusBadGateway, "control_refused"
}

// decodeBytes is decode for a body already read: strict, one JSON value.
func decodeBytes(b []byte, v any) error {
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		return err
	}
	if dec.More() {
		return errors.New("more than one JSON value")
	}
	return nil
}
