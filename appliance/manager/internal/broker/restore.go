package broker

// Bringing the box back from a backup (BK-39, Whombat backup-options.md BKO-11): the runtime asks, the update
// helper starts the root unit.
//
//	POST /v1/backup/restore  {checkpointId}  runtime   starts whombat-backup-restore@<checkpointId> → 202 {started}
//	POST /v1/backup/restored {}              runtime   once the person's answers ended the quarantine: restart the
//	                                                    runtime and the hosts service → 202 {restarting}
//
// The restore stops the runtime that asked, so neither waits for what it starts. A maintenance lock keeps updates
// from activating meanwhile. The backup service says how the restore ended (GET /v1/quarantine): a restore that failed
// (and was undone) gives the lock back at once, so updates aren't blocked for its 6 hours.

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/CybexBV/whombat/appliance/helper/pkg/proto"
)

// Paths of the backup routes (not in the contracts' generated constants: the runtime is their only caller).
const (
	PathBackupRestore  = "/v1/backup/restore"
	PathBackupRestored = "/v1/backup/restored"
)

// Helper is what the backup routes need of the update helper.
type Helper interface {
	Do(ctx context.Context, req proto.Request) (*proto.Result, error)
}

// restoreLockTTL bounds how long updates wait for a restore (the unit's own limit is 6 hours).
const restoreLockTTL = 6 * time.Hour

// restoreHolder holds the maintenance lock while a restore runs.
const restoreHolder = "backup-restore"

// RestoreState is where the backup service says a restore is (its GET /v1/quarantine): phase none | restoring |
// checking | failed | released, and since when.
type RestoreState struct {
	Phase string
	Since *time.Time
}

// How long after the lock was taken a restore must have shown up at the backup service (the unit never ran, or
// stopped before it wrote anything), and how often a held lock is checked.
const (
	restoreStartGrace  = 15 * time.Minute
	defaultRestorePoll = 30 * time.Second
)

// watchRestores gives the restore's maintenance lock back once the restore ended without the person's answers to
// wait for: it failed (and was undone), it was released, or it never started. A lock left by a manager that
// restarted meanwhile is checked the same way.
func (s *Server) watchRestores(ctx context.Context) {
	poll := s.RestorePoll
	if poll <= 0 {
		poll = defaultRestorePoll
	}
	t := time.NewTicker(poll)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			s.CheckRestoreLock(ctx)
		}
	}
}

// CheckRestoreLock releases the restore's maintenance lock when the restore it guards is over (watchRestores).
func (s *Server) CheckRestoreLock(ctx context.Context) {
	if s.Engine == nil || s.RestoreState == nil {
		return
	}
	st, err := s.Engine.Load()
	if err != nil || st.Lock == nil || st.Lock.Holder != restoreHolder {
		return
	}
	lock := st.Lock
	cctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	rs, err := s.RestoreState(cctx)
	if err != nil {
		return // the backup service doesn't answer: the lock's own limit still ends it
	}
	why := ""
	switch rs.Phase {
	case "failed", "released":
		if rs.Since != nil && rs.Since.Before(lock.Since) {
			return // an earlier restore's outcome: this one hasn't ended yet
		}
		why = "the restore " + rs.Phase
	case "none":
		if s.now().Sub(lock.Since) < restoreStartGrace {
			return
		}
		why = "the restore never started"
	default:
		return
	}
	if err := s.Engine.ReleaseLock(restoreHolder); err != nil {
		s.log().Warn("broker: release the restore's lock", "err", err)
		return
	}
	s.log().Info("broker: updates may go ahead again", "why", why)
}

func (s *Server) backupRestore(w http.ResponseWriter, r *http.Request) {
	if s.Helper == nil {
		writeErr(w, http.StatusNotFound, "unavailable", "this manager can't start a restore")
		return
	}
	b, ok := readBody(w, r)
	if !ok {
		return
	}
	var req struct {
		CheckpointID string `json:"checkpointId"`
	}
	if err := json.Unmarshal(b, &req); err != nil || !proto.ValidCheckpointID(req.CheckpointID) {
		writeErr(w, http.StatusBadRequest, "bad_request", "checkpointId required")
		return
	}
	if s.Engine != nil {
		if _, err := s.Engine.AcquireLock(restoreHolder, "bringing this Whombat back from a backup", restoreLockTTL); err != nil {
			writeErr(w, http.StatusConflict, "busy", "an update is going: try again in a few minutes")
			return
		}
	}
	if _, err := s.Helper.Do(r.Context(), proto.Request{V: proto.Version, Op: proto.OpBackupRestore, CheckpointID: req.CheckpointID}); err != nil {
		if s.Engine != nil {
			_ = s.Engine.ReleaseLock(restoreHolder)
		}
		writeErr(w, http.StatusBadGateway, "restore_failed", err.Error())
		return
	}
	s.log().Info("broker: restore started", "checkpoint", req.CheckpointID)
	writeJSON(w, http.StatusAccepted, map[string]bool{"started": true})
}

func (s *Server) backupRestored(w http.ResponseWriter, r *http.Request) {
	if s.Helper == nil {
		writeErr(w, http.StatusNotFound, "unavailable", "this manager can't restart after a restore")
		return
	}
	if _, ok := readBody(w, r); !ok {
		return
	}
	if s.Engine != nil {
		_ = s.Engine.ReleaseLock(restoreHolder)
	}
	// Answer first: restarting the runtime ends the request's own caller.
	writeJSON(w, http.StatusAccepted, map[string]bool{"restarting": true})
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
		defer cancel()
		time.Sleep(500 * time.Millisecond)
		if _, err := s.Helper.Do(ctx, proto.Request{V: proto.Version, Op: proto.OpBackupRestored}); err != nil {
			s.log().Warn("broker: restart after the restore", "err", err)
		}
	}()
}
