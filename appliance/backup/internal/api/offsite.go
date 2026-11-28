package api

// The second place (a copy of the backups somewhere else, internal/offsite):
//
//	GET    /v1/offsite        runtime, manager   its state (whombat.backup-offsite/1)
//	PUT    /v1/offsite        runtime            set it {provider, repository, s3AccessKeyId, s3SecretAccessKey, s3Region?}:
//	                                             checked first (written, read, deleted), then kept → its state; a step
//	                                             that failed answers 422 {error: {code: offsite_failed, message, step}}
//	DELETE /v1/offsite        runtime            forget it (the copies in the bucket stay) → its state
//	POST   /v1/offsite/copy   runtime            copy now → {queued: true}
//
// The runtime authorizes the person; no answer carries the secret, and a failure says only its step and sentence.

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"github.com/CybexBV/whombat/appliance/backup/internal/offsite"
	"github.com/CybexBV/whombat/appliance/backup/internal/state"
)

func (s *Server) routesOffsite(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/offsite", s.allow(s.getOffsite, "runtime", "manager"))
	mux.HandleFunc("PUT /v1/offsite", s.allow(s.setOffsite, "runtime"))
	mux.HandleFunc("DELETE /v1/offsite", s.allow(s.removeOffsite, "runtime"))
	mux.HandleFunc("POST /v1/offsite/copy", s.allow(s.copyOffsite, "runtime"))
}

// OffsiteError is a step of setting up or copying that failed.
type OffsiteError struct {
	Error struct {
		Code    string `json:"code"`
		Message string `json:"message"`
		Step    string `json:"step"`
	} `json:"error"`
}

func (s *Server) getOffsite(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, offsite.Doc(s.Cfg))
}

func (s *Server) setOffsite(w http.ResponseWriter, r *http.Request) {
	var req offsite.Request
	dec := json.NewDecoder(io.LimitReader(r.Body, 16*1024))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "provider, repository, s3AccessKeyId and s3SecretAccessKey", "")
		return
	}
	req.AllowLocal = false // the person's session names a bucket, never a path on this box
	_, err := offsite.Set(r.Context(), s.Cfg, req)
	var ie *offsite.InputError
	var oe *offsite.Error
	switch {
	case errors.As(err, &ie):
		writeErr(w, http.StatusBadRequest, "bad_request", ie.Msg, "")
	case errors.As(err, &oe):
		var out OffsiteError
		out.Error.Code, out.Error.Message, out.Error.Step = "offsite_failed", ascii(oe.Reason, 500), oe.Step
		writeJSON(w, http.StatusUnprocessableEntity, out)
	case err != nil:
		writeErr(w, http.StatusInternalServerError, "internal", state.ASCII(err.Error(), 300), "")
	default:
		writeJSON(w, http.StatusOK, offsite.Doc(s.Cfg))
	}
}

func (s *Server) removeOffsite(w http.ResponseWriter, _ *http.Request) {
	if err := offsite.Remove(s.Cfg); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal", err.Error(), "")
		return
	}
	writeJSON(w, http.StatusOK, offsite.Doc(s.Cfg))
}

func (s *Server) copyOffsite(w http.ResponseWriter, _ *http.Request) {
	if p, _ := offsite.Load(s.Cfg); p == nil {
		writeErr(w, http.StatusPreconditionFailed, "unprotected", "no second place is set up", "")
		return
	}
	if err := offsite.Enqueue(s.Cfg); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal", err.Error(), "")
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]bool{"queued": true})
}
