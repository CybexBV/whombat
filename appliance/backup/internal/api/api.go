// Package api is the backup service's local API (BK-11) on a unix socket (/run/whombat-backup/api.sock).
// Peers are identified by SO_PEERCRED:
//
//	GET  /v1/status              runtime, manager   the status document (whombat.backup-status/1)
//	POST /v1/checkpoints         runtime, manager   take a checkpoint now; synchronous
//	    {reason: manual}                            → {ok, ref, id, seq, snapshotId, manifestSha256, createdAt, schemaVersion, verified:false}
//	    {reason: migration, releaseId, migrations[], underDrain?}   manager only (MG-18, MD-06): taken inside the
//	                                                manager's drain, verified from the destination → {ref, verified:true, ...}
//	PUT  /v1/destination         runtime            configure/adopt the destination (owner-authorized by the runtime):
//	    the contract's BackupConfigureDestinationInput (CT-142)  → {repositoryId, appendOnly, generation, kind, hostKeyFingerprint?}
//	GET  /v1/recovery-material   runtime            the kit's backup section (owner-authorized by the runtime)
//	GET  /v1/ssh-public-key      runtime            the box's SFTP key {publicKey, fingerprint}, made on the first call (BK-19)
//	POST/GET/DELETE /v1/peeks    runtime            a backup opened for reading (peeks.go)
//
// The runtime is responsible for owner authorization of the last three (they come from an owner's
// session op); the API only guarantees that nothing but the runtime (and the manager for checkpoints) can
// ask.
//
// Contract (whombat-contracts 0.5 `local`, CT-30/CT-37): requests are strict (CheckpointRequest reason
// manual|scheduled|migration, no aliases, no fallback); errors are LocalError {error: {code, message,
// stage?}} with codes busy (409), unprotected (412), forbidden (403), checkpoint_failed (502, with the
// stage), plus bad_request (400), destination_failed (502) and internal (500).
package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"time"

	"golang.org/x/sys/unix"

	"github.com/CybexBV/whombat/appliance/backup/internal/checkpoint"
	"github.com/CybexBV/whombat/appliance/backup/internal/dest"
	"github.com/CybexBV/whombat/appliance/backup/internal/peek"
	"github.com/CybexBV/whombat/appliance/backup/internal/state"
	"github.com/CybexBV/whombat/appliance/backup/pkg/manifest"
	"github.com/CybexBV/whombat/contracts/go/local"
)

// Server is the API.
type Server struct {
	Cfg        *state.Config
	Checkpoint func(ctx context.Context, opts checkpoint.Options) (*checkpoint.Result, error)
	RuntimeUID int
	ManagerUID int
	// Peeks opens backups for reading (peeks.go); made on first use when nil.
	Peeks *peek.Manager
	srv   *http.Server
}

type connKey struct{}

// Serve serves on l.
func (s *Server) Serve(l net.Listener) error {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/status", s.allow(s.status, "runtime", "manager"))
	mux.HandleFunc("POST /v1/checkpoints", s.allow(s.checkpoint, "runtime", "manager"))
	mux.HandleFunc("PUT /v1/destination", s.allow(s.destination, "runtime"))
	mux.HandleFunc("GET /v1/recovery-material", s.allow(s.material, "runtime"))
	mux.HandleFunc("GET /v1/ssh-public-key", s.allow(s.sshPublicKey, "runtime"))
	s.routesOptions(mux)
	s.routesPeeks(mux)
	s.srv = &http.Server{Handler: mux, ReadHeaderTimeout: 10 * time.Second,
		ConnContext: func(ctx context.Context, c net.Conn) context.Context { return context.WithValue(ctx, connKey{}, c) }}
	return s.srv.Serve(l)
}

// Close stops serving.
func (s *Server) Close() error {
	if s.srv == nil {
		return nil
	}
	return s.srv.Close()
}

func uidOf(c net.Conn) int {
	uc, ok := c.(*net.UnixConn)
	if !ok {
		return -1
	}
	raw, err := uc.SyscallConn()
	if err != nil {
		return -1
	}
	uid := -1
	_ = raw.Control(func(fd uintptr) {
		if cr, err := unix.GetsockoptUcred(int(fd), unix.SOL_SOCKET, unix.SO_PEERCRED); err == nil {
			uid = int(cr.Uid)
		}
	})
	return uid
}

func (s *Server) allow(h http.HandlerFunc, roles ...string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		c, _ := r.Context().Value(connKey{}).(net.Conn)
		uid := uidOf(c)
		ok := false
		for _, role := range roles {
			switch role {
			case "runtime":
				ok = ok || (s.RuntimeUID >= 0 && uid == s.RuntimeUID)
			case "manager":
				ok = ok || (s.ManagerUID >= 0 && uid == s.ManagerUID)
			}
		}
		if !ok {
			writeErr(w, http.StatusForbidden, "forbidden", "this caller may not use this endpoint", "")
			return
		}
		h(w, r)
	}
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

// ascii folds a message to the contract's printable ASCII, at most max bytes.
func ascii(s string, max int) string {
	b := make([]byte, 0, len(s))
	for _, r := range s {
		if r >= 0x20 && r <= 0x7e {
			b = append(b, byte(r))
		} else {
			b = append(b, '?')
		}
		if len(b) >= max {
			break
		}
	}
	return string(b)
}

var stages = map[string]bool{"preflight": true, "quiesce": true, "snapshot": true, "dump": true, "upload": true, "verify": true}

// writeErr answers a contract LocalError.
func writeErr(w http.ResponseWriter, code int, errCode, msg, stage string) {
	le := local.LocalError{Error: local.LocalErrorError{Code: errCode, Message: ascii(msg, 500)}}
	if stages[stage] {
		st := stage
		le.Error.Stage = &st
	}
	writeJSON(w, code, le)
}

func (s *Server) status(w http.ResponseWriter, _ *http.Request) {
	dest.RefreshPresence(s.Cfg)
	st, err := state.CurrentStatus(s.Cfg)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal", err.Error(), "")
		return
	}
	writeJSON(w, http.StatusOK, st)
}

func (s *Server) checkpoint(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(io.LimitReader(r.Body, 64*1024))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error(), "")
		return
	}
	req, err := local.ParseCheckpointRequest(body)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid CheckpointRequest: "+err.Error(), "")
		return
	}
	c, _ := r.Context().Value(connKey{}).(net.Conn)
	fromManager := s.ManagerUID >= 0 && uidOf(c) == s.ManagerUID
	opts := checkpoint.Options{Reason: req.Reason}
	switch req.Reason {
	case "migration":
		// The manager's checkpointed migration (MG-18, MD-06): it holds its own drain (scope all),
		// names it in underDrain, and needs a verified checkpoint. Only the manager can ask for one.
		if !fromManager {
			writeErr(w, http.StatusForbidden, "forbidden", "migration checkpoints are for the manager", "")
			return
		}
		if req.UnderDrain == nil {
			writeErr(w, http.StatusBadRequest, "bad_request", "a migration checkpoint needs the manager's drain request id (underDrain)", "")
			return
		}
		// "pre-migration" stays the manifest's reason (backup-internal format, BK manifests).
		opts.Reason, opts.Verify, opts.UnderDrain = "pre-migration", true, *req.UnderDrain
		m := &manifest.Migration{Migrations: req.Migrations}
		if req.ReleaseID != nil {
			m.ReleaseID = *req.ReleaseID
		}
		opts.Migration = m
	default: // manual | scheduled (the schema admits nothing else)
		if req.UnderDrain != nil || req.ReleaseID != nil || len(req.Migrations) > 0 {
			writeErr(w, http.StatusBadRequest, "bad_request", "underDrain, releaseId and migrations are only for migration checkpoints", "")
			return
		}
	}
	res, err := s.Checkpoint(r.Context(), opts)
	switch {
	case errors.Is(err, state.ErrBusy):
		writeErr(w, http.StatusConflict, "busy", err.Error(), "")
	case errors.Is(err, checkpoint.ErrUnprotected):
		writeErr(w, http.StatusPreconditionFailed, "unprotected", err.Error(), "")
	case err != nil:
		var se *checkpoint.StageError
		if errors.As(err, &se) {
			writeErr(w, http.StatusBadGateway, "checkpoint_failed", se.Reason, se.Stage)
			return
		}
		writeErr(w, http.StatusBadGateway, "checkpoint_failed", err.Error(), "")
	default:
		writeJSON(w, http.StatusOK, local.CheckpointResult{Ok: true, Ref: res.Manifest.ID, Verified: res.Verified,
			ID: res.Manifest.ID, Seq: res.Manifest.Seq, SnapshotID: res.Summary.SnapshotID,
			ManifestSHA256: res.ManifestSHA256, CreatedAt: res.Manifest.CreatedAt.UTC().Format(time.RFC3339),
			SchemaVersion: int64(res.Manifest.Database.SchemaVersion)})
	}
}

// DestinationRequest is the contract's BackupConfigureDestinationInput (CT-142), as the runtime forwards it.
type DestinationRequest struct {
	Repository        string `json:"repository"`
	RESTUser          string `json:"restUser"`
	RESTPassword      string `json:"restPassword"`
	CACert            string `json:"caCert"` // PEM
	AdoptPassword     string `json:"adoptPassword"`
	AllowInit         bool   `json:"allowInit"`
	S3AccessKeyID     string `json:"s3AccessKeyId"`
	S3SecretAccessKey string `json:"s3SecretAccessKey"`
	S3Region          string `json:"s3Region"`
	SFTPUser          string `json:"sftpUser"`
	SFTPHostKey       string `json:"sftpHostKey"`
}

// DestinationResult is the contract's BackupConfigureDestinationOutput.
type DestinationResult struct {
	RepositoryID       string `json:"repositoryId"`
	AppendOnly         string `json:"appendOnly"`
	Generation         int    `json:"generation"`
	Kind               string `json:"kind"`
	HostKeyFingerprint string `json:"hostKeyFingerprint,omitempty"`
}

func (s *Server) destination(w http.ResponseWriter, r *http.Request) {
	var req DestinationRequest
	dec := json.NewDecoder(io.LimitReader(r.Body, 64*1024))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil || req.Repository == "" {
		msg := "repository required"
		if err != nil {
			msg = "invalid destination request: " + err.Error()
		}
		writeErr(w, http.StatusBadRequest, "bad_request", msg, "")
		return
	}
	d, err := dest.Configure(r.Context(), s.Cfg, dest.Request{Repository: req.Repository, RESTUser: req.RESTUser,
		RESTPassword: req.RESTPassword, CACert: req.CACert, AdoptPassword: req.AdoptPassword, AllowInit: req.AllowInit,
		S3AccessKeyID: req.S3AccessKeyID, S3SecretAccessKey: req.S3SecretAccessKey, S3Region: req.S3Region,
		SFTPUser: req.SFTPUser, SFTPHostKey: req.SFTPHostKey})
	var ie *dest.InputError
	switch {
	case errors.As(err, &ie):
		writeErr(w, http.StatusBadRequest, "bad_request", state.ASCII(ie.Msg, 500), "")
		return
	case err != nil:
		writeErr(w, http.StatusBadGateway, "destination_failed", state.ASCII(err.Error(), 500), "")
		return
	}
	writeJSON(w, http.StatusOK, DestinationResult{RepositoryID: d.RepositoryID, AppendOnly: d.AppendOnly,
		Generation: d.Generation, Kind: d.Kind, HostKeyFingerprint: d.HostKeyFingerprint})
}

func (s *Server) sshPublicKey(w http.ResponseWriter, _ *http.Request) {
	k, err := dest.PublicKey(s.Cfg)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal", err.Error(), "")
		return
	}
	writeJSON(w, http.StatusOK, k)
}

func (s *Server) material(w http.ResponseWriter, _ *http.Request) {
	m, err := dest.Material(s.Cfg)
	if err != nil {
		writeErr(w, http.StatusPreconditionFailed, "unprotected", err.Error(), "")
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, m)
}
