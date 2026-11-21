package api

// Opening a backup for reading (internal/peek; Whombat restore-one), the runtime only:
//
//	POST   /v1/peeks       {checkpointId, own?}  → 202 {id}; 409 busy (one at a time, or a backup is running),
//	                                               404 not_found, 507 no_space {needBytes, freeBytes}, 503 unavailable
//	GET    /v1/peeks/{id}                       → {id, checkpointId, state, database, root, expiresAt, error}
//	DELETE /v1/peeks/{id}                       → the peek, closed; 409 busy while the database is still being read

import (
	"errors"
	"net/http"
	"sync"

	"github.com/CybexBV/whombat/appliance/backup/internal/peek"
	"github.com/CybexBV/whombat/contracts/go/local"
)

func (s *Server) routesPeeks(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/peeks", s.allow(s.openPeek, "runtime"))
	mux.HandleFunc("GET /v1/peeks/{id}", s.allow(s.getPeek, "runtime"))
	mux.HandleFunc("DELETE /v1/peeks/{id}", s.allow(s.closePeek, "runtime"))
}

var peeksOnce sync.Mutex

// peeks is the server's peek manager (made on first use).
func (s *Server) peeks() *peek.Manager {
	peeksOnce.Lock()
	defer peeksOnce.Unlock()
	if s.Peeks == nil {
		s.Peeks = &peek.Manager{Cfg: s.Cfg}
	}
	return s.Peeks
}

// PeekRequest opens one backup for reading.
type PeekRequest struct {
	CheckpointID string `json:"checkpointId"`
	Own          *bool  `json:"own,omitempty"`
}

func (s *Server) openPeek(w http.ResponseWriter, r *http.Request) {
	var req PeekRequest
	if err := decodeStrict(r, &req); err != nil || !checkpointID.MatchString(req.CheckpointID) {
		writeErr(w, http.StatusBadRequest, "bad_request", "checkpointId required", "")
		return
	}
	p, err := s.peeks().Open(r.Context(), req.CheckpointID, req.Own)
	if err != nil {
		peekErr(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]string{"id": p.ID})
}

func (s *Server) getPeek(w http.ResponseWriter, r *http.Request) {
	p, err := s.peeks().Get(r.PathValue("id"))
	if err != nil {
		peekErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, p)
}

func (s *Server) closePeek(w http.ResponseWriter, r *http.Request) {
	p, err := s.peeks().Close(r.Context(), r.PathValue("id"))
	if err != nil {
		peekErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, p)
}

// noSpace is the no_space answer: the LocalError with the bytes needed and free.
type noSpace struct {
	Error struct {
		local.LocalErrorError
		NeedBytes int64 `json:"needBytes"`
		FreeBytes int64 `json:"freeBytes"`
	} `json:"error"`
}

func peekErr(w http.ResponseWriter, err error) {
	var ns *peek.NoSpaceError
	switch {
	case errors.As(err, &ns):
		var out noSpace
		out.Error.Code, out.Error.Message = "no_space", ascii(ns.Error(), 500)
		out.Error.NeedBytes, out.Error.FreeBytes = ns.Need, ns.Free
		writeJSON(w, http.StatusInsufficientStorage, out)
	case errors.Is(err, peek.ErrUnavailable):
		writeErr(w, http.StatusServiceUnavailable, "unavailable", err.Error(), "")
	case errors.Is(err, peek.ErrBusy), errors.Is(err, peek.ErrRunning), errors.Is(err, peek.ErrInUse):
		writeErr(w, http.StatusConflict, "busy", err.Error(), "")
	case errors.Is(err, peek.ErrNotFound):
		writeErr(w, http.StatusNotFound, "not_found", "There's no such backup here.", "")
	default:
		writeErr(w, http.StatusBadGateway, "destination_failed", err.Error(), "")
	}
}
