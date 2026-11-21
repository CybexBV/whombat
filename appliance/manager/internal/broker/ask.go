package broker

import (
	"errors"
	"net/http"

	"github.com/CybexBV/whombat/appliance/manager/internal/update"
	"github.com/CybexBV/whombat/contracts/go/local"
)

// “Ask before updating” (Whombat ask-before-updating.md): the owner's switch and the owner's approval of the update
// waiting for them, for the runtime's uid only. The manager keeps both in its update journal and enforces them itself,
// so neither control nor a signed assignment gets an update past the owner. Control has no way to call these.

// askBodyMax bounds both requests: a flag, or one release id.
const askBodyMax = 1024

func (s *Server) updateAsk(w http.ResponseWriter, r *http.Request) {
	b, ok := readBody(w, r)
	if !ok {
		return
	}
	req, err := local.ParseUpdateAskRequest(b)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	if err := s.Engine.SetAskFirst(req.AskFirst); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	s.log().Info("ask before updating", "on", req.AskFirst)
	s.wakeEngine() // one that waits goes ahead now, not at the engine's next idle step
	writeJSON(w, http.StatusOK, local.UpdateAskResponse{V: 1, AskFirst: req.AskFirst})
}

func (s *Server) updateApprove(w http.ResponseWriter, r *http.Request) {
	b, ok := readBody(w, r)
	if !ok {
		return
	}
	req, err := local.ParseUpdateApproveRequest(b)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	if err := s.Engine.Approve(req.Release); err != nil {
		if errors.Is(err, update.ErrNotWaiting) {
			writeErr(w, http.StatusConflict, "not_waiting", err.Error())
			return
		}
		writeErr(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	s.log().Info("the owner approved an update", "release", req.Release)
	s.wakeEngine()
	writeJSON(w, http.StatusOK, local.UpdateApproveResponse{V: 1, Release: req.Release})
}

func (s *Server) wakeEngine() {
	if s.WakeEngine != nil {
		s.WakeEngine()
	}
}
