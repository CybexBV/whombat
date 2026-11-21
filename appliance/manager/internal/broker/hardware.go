package broker

// POST /v1/host/hardware (contracts 0.102.0, CT-560…; MG-113): the box's hardware report for the runtime (an owner's
// Settings → This Whombat → About → Hardware), collected when asked (manager/internal/hardware).

import (
	"context"
	"net/http"

	"github.com/CybexBV/whombat/contracts/go/local"
	"github.com/CybexBV/whombat/contracts/go/protocol"
)

// Hardware is the manager's hardware report (manager/internal/hardware, MG-110).
type Hardware interface {
	Collect(ctx context.Context) (*protocol.HostHardware, error)
}

// hostHardware answers {v: 1, hardware}; 404 unavailable without a collector (as a manager before it), 503 unavailable
// when the request ends first, 500 internal for a report the contract would refuse (never sent).
func (s *Server) hostHardware(w http.ResponseWriter, r *http.Request) {
	if s.Hardware == nil {
		writeErr(w, http.StatusNotFound, "unavailable", "this manager doesn't report the hardware")
		return
	}
	b, ok := readBody(w, r)
	if !ok {
		return
	}
	if _, err := local.ParseHostHardwareRequest(b); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	h, err := s.Hardware.Collect(r.Context())
	if err != nil {
		writeErr(w, http.StatusServiceUnavailable, "unavailable", err.Error())
		return
	}
	res := local.HostHardwareResponse{V: 1, Hardware: *h}
	if err := res.Validate(); err != nil {
		s.log().Error("broker: the hardware report isn't the contract's", "err", err)
		writeErr(w, http.StatusInternalServerError, "internal", "the hardware report is invalid")
		return
	}
	writeJSON(w, http.StatusOK, res)
}
