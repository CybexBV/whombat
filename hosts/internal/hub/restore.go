package hub

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"rackoon/internal/hub/store"
)

// Restoring a backup through the API (HS-177…HS-179): POST /hub/restore
// checks the backup and stages it as <data>/restore-staged.tar (or .tar.gz
// when it is gzipped), the service stops on its own and its service
// manager starts it again; at start, before anything opens the database or
// listens, a staged backup is applied. Whatever puts a backup there under
// either name (the API, the appliance's console restore) gets it applied;
// what it holds, not its name, says whether it is gzipped.

// Files in the data directory.
const (
	stagedRestoreFile = "restore-staged.tar.gz"
	// stagedRestoreTar is the staged name of a plain tar (hub.tar).
	stagedRestoreTar = "restore-staged.tar"
	// restore-failed-<time>.tar(.gz): a staged backup that could not be applied.
	failedRestorePrefix = "restore-failed-"
)

// stagedNames are the names a staged backup may have.
var stagedNames = []string{stagedRestoreTar, stagedRestoreFile}

// stagedName is the staged name of a backup that is gzipped or not.
func stagedName(gz bool) string {
	if gz {
		return stagedRestoreFile
	}
	return stagedRestoreTar
}

// stagedRestore is the staged backup to apply: the newer one when both
// names are there, the other removed so it is never applied later ("" =
// none).
func stagedRestore(dataDir string, log *slog.Logger) string {
	pick, at := "", time.Time{}
	for _, n := range stagedNames {
		st, err := os.Lstat(filepath.Join(dataDir, n))
		if err != nil {
			continue
		}
		if pick == "" || st.ModTime().After(at) {
			if pick != "" {
				log.Warn("two backups were staged; the older one is dropped", "file", pick)
				os.Remove(filepath.Join(dataDir, pick))
			}
			pick, at = n, st.ModTime()
			continue
		}
		log.Warn("two backups were staged; the older one is dropped", "file", n)
		os.Remove(filepath.Join(dataDir, n))
	}
	if pick == "" {
		return ""
	}
	return filepath.Join(dataDir, pick)
}

// Meta keys of restores.
const (
	metaRestoredAt   = "restored_at"
	metaRestoreError = "restore_error"
)

// maxRestoreBytes bounds an uploaded backup.
const maxRestoreBytes = 1 << 30

// restoreStopDelay is how long after answering the hub stops to apply a
// staged backup (the answer reaches the client first).
const restoreStopDelay = 500 * time.Millisecond

// ErrRestart ends Run when the hub stopped to apply a staged backup: the
// service manager starts it again (Restart=always).
var ErrRestart = errors.New("stopped to apply a restored backup")

// restoreFailure is GET /hub's restore_error: a staged backup that could
// not be applied at the last start.
type restoreFailure struct {
	At      time.Time `json:"at"`
	Code    string    `json:"code"`
	Message string    `json:"message"`
}

// stagedResult is what applying a staged backup at start did.
type stagedResult struct {
	applied *extractedBackup // restored (nil: nothing staged or failed)
	failure *restoreFailure  // could not be applied
	file    string           // restore-failed-<time>.tar.gz
}

// applyStagedRestore applies <data>/restore-staged.tar(.gz), if there is
// one (the caller holds the data directory's lock; nothing is open yet). A
// backup that can't be applied is renamed restore-failed-<time> with the
// staged name's extension and the data directory is left as it was.
func applyStagedRestore(ctx context.Context, dataDir string, now time.Time, log *slog.Logger) stagedResult {
	// What a restore or an upload that was cut off left behind.
	if old, _ := filepath.Glob(filepath.Join(dataDir, ".restore-*")); len(old) > 0 {
		for _, p := range old {
			os.RemoveAll(p)
		}
	}
	path := stagedRestore(dataDir, log)
	if path == "" {
		return stagedResult{}
	}
	f, err := os.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		return stagedResult{}
	}
	fail := func(err error) stagedResult {
		code := "failed"
		var be *backupError
		if errors.As(err, &be) {
			code = be.code
		}
		failed := failedRestorePrefix + now.UTC().Format("20060102-150405") + strings.TrimPrefix(filepath.Base(path), "restore-staged")
		if rerr := os.Rename(path, filepath.Join(dataDir, failed)); rerr != nil {
			log.Error("a staged backup could not be set aside", "file", path, "err", rerr)
			os.Remove(path) // never applied again at every start
		}
		log.Error("the staged backup could not be restored; starting with the data from before", "code", code, "err", err,
			"kept_as", failed)
		return stagedResult{failure: &restoreFailure{At: now.UTC(), Code: code, Message: err.Error()}, file: failed}
	}
	if err != nil {
		return fail(err)
	}
	x, err := extractBackup(ctx, f, dataDir)
	f.Close()
	if err != nil {
		return fail(err)
	}
	undo, err := installBackup(ctx, dataDir, x, now)
	x.close() // its files moved in; what it says is kept
	if err != nil {
		return fail(err)
	}
	// The hub must be able to open (and migrate) it, or it keeps what it had.
	st, err := store.Open(filepath.Join(dataDir, "hub.db"))
	if err == nil {
		err = st.Close()
	}
	if err != nil {
		undo()
		return fail(fmt.Errorf("the restored database does not open: %w", err))
	}
	os.Remove(path)
	log.Warn("restored a backup", "made_at", x.Manifest.CreatedAt, "hub_version", x.Manifest.HubVersion,
		"ca_sha256", x.CAPin, "servers", x.Servers, "agent_url", x.AgentURL)
	return stagedResult{applied: x}
}

// recordStaged writes what applyStagedRestore did into the (open) database:
// the audit record, and the failure for GET /hub.
func (h *Hub) recordStaged(ctx context.Context, res stagedResult) error {
	switch {
	case res.applied != nil:
		x := res.applied
		h.auditSystem(ctx, store.AuditRecord{Event: "hub.restored", Outcome: "ok", User: "system",
			Details: map[string]string{"ca_sha256": x.CAPin, "servers": fmt.Sprint(x.Servers), "agent_url": x.AgentURL,
				"made_at": x.Manifest.CreatedAt.UTC().Format(time.RFC3339), "hub_version": x.Manifest.HubVersion}})
	case res.failure != nil:
		b, _ := json.Marshal(res.failure)
		if err := h.store.SetMeta(ctx, metaRestoreError, string(b)); err != nil {
			return err
		}
		h.auditSystem(ctx, store.AuditRecord{Event: "hub.restore_failed", Outcome: "error", User: "system", Code: res.failure.Code,
			Details: map[string]string{"message": cleanText(res.failure.Message, 512), "kept_as": res.file}})
	}
	return nil
}

// loadRestoreState reads restored_at and restore_error.
func (h *Hub) loadRestoreState(ctx context.Context) error {
	v, ok, err := h.store.GetMeta(ctx, metaRestoredAt)
	if err != nil {
		return err
	}
	if ok {
		if t, err := time.Parse(time.RFC3339, v); err == nil {
			h.restoredAt.Store(&t)
		}
	}
	if v, ok, _ := h.store.GetMeta(ctx, metaRestoreError); ok && v != "" {
		var f restoreFailure
		if json.Unmarshal([]byte(v), &f) == nil {
			h.restoreErr.Store(&f)
		}
	}
	return nil
}

// apiHubRestore is POST /hub/restore: the body is a backup (GET
// /hub/backup's .tar.gz, or a plain tar such as hub.tar; at most 1 GiB). Refusals: 400 bad_backup or
// newer_schema (the file), 409 same_hub (this hub's own CA), 409
// hub_not_empty (servers or enrollments waiting), 409 restore_pending.
// Accepted: 202 {ca_sha256, servers, agent_url}, then the hub stops.
func (h *Hub) apiHubRestore(w http.ResponseWriter, r *http.Request, p *principal) error {
	if err := h.requireReauth(p); err != nil {
		return err
	}
	if !h.restoreMu.TryLock() {
		return errRestorePending
	}
	defer h.restoreMu.Unlock()
	if h.restoreStaged.Load() {
		return errRestorePending
	}
	ctx := r.Context()
	dir := h.cfg.DataDir
	up, err := os.CreateTemp(dir, ".restore-upload-*")
	if err != nil {
		return err
	}
	upPath := up.Name()
	staged := false
	defer func() {
		up.Close()
		if !staged {
			os.Remove(upPath)
		}
	}()
	body := http.MaxBytesReader(w, r.Body, maxRestoreBytes)
	head := &headWriter{}
	tee := io.TeeReader(body, io.MultiWriter(up, head))
	x, err := extractBackup(ctx, tee, dir)
	if err == nil {
		// Whatever followed the archive belongs to the staged file too.
		_, err = io.Copy(io.Discard, tee)
	}
	if err != nil {
		x.close()
		return h.restoreErrFor(err)
	}
	defer x.close()
	if x.CAPin == h.ca.Pin {
		return apiErr(http.StatusConflict, "same_hub", "This backup is of this hub: its servers are already here.")
	}
	if err := h.restoreRefusal(ctx); err != nil {
		return err
	}
	if err := up.Sync(); err != nil {
		return h.restoreErrFor(err)
	}
	if err := up.Close(); err != nil {
		return h.restoreErrFor(err)
	}
	dst := filepath.Join(dir, stagedName(isGzip(head.b)))
	if err := os.Rename(upPath, dst); err != nil {
		return err
	}
	staged = true
	for _, n := range stagedNames {
		// One staged backup: an older one under the other name never comes
		// back.
		if p := filepath.Join(dir, n); p != dst {
			os.Remove(p)
		}
	}
	if _, err := h.auditReq(r, p, store.AuditRecord{Event: "hub.restore_staged", Outcome: "ok",
		Details: map[string]string{"ca_sha256": x.CAPin, "servers": fmt.Sprint(x.Servers), "agent_url": x.AgentURL,
			"made_at": x.Manifest.CreatedAt.UTC().Format(time.RFC3339)}}); err != nil {
		os.Remove(dst)
		return apiErr(http.StatusServiceUnavailable, "audit_unavailable", "The audit log is unavailable; restores are disabled.")
	}
	h.restoreStaged.Store(true)
	h.log.Warn("a backup was staged; stopping to restore it", "ca_sha256", x.CAPin, "servers", x.Servers)
	var agentURL any
	if x.AgentURL != "" {
		agentURL = x.AgentURL
	}
	writeJSON(w, r, http.StatusAccepted, map[string]any{"ca_sha256": x.CAPin, "servers": x.Servers, "agent_url": agentURL})
	time.AfterFunc(restoreStopDelay, h.stopForRestore)
	return nil
}

// headWriter keeps the first bytes written to it (an upload's: gzip or not).
type headWriter struct{ b []byte }

func (h *headWriter) Write(p []byte) (int, error) {
	if n := 2 - len(h.b); n > 0 {
		h.b = append(h.b, p[:min(n, len(p))]...)
	}
	return len(p), nil
}

var errRestorePending = apiErr(http.StatusConflict, "restore_pending", "A restore is already on its way; the service restarts in a moment.")

// restoreRefusal is 409 hub_not_empty while the hub has servers or
// enrollments waiting for approval (BF-14: two fleets are never merged).
func (h *Hub) restoreRefusal(ctx context.Context) error {
	h.mu.RLock()
	n := len(h.servers)
	h.mu.RUnlock()
	pending, err := h.store.CountEnrollments(ctx, store.EnrollPending)
	if err != nil {
		return err
	}
	if n > 0 || pending > 0 {
		e := apiErr(http.StatusConflict, "hub_not_empty", fmt.Sprintf("This hub already has %d servers and %d waiting; a backup can only be restored into an empty one.", n, pending))
		return e
	}
	return nil
}

// restoreErrFor maps an error reading an uploaded backup to the API's.
func (h *Hub) restoreErrFor(err error) error {
	var be *backupError
	var mb *http.MaxBytesError
	switch {
	case errors.As(err, &be):
		return apiErr(http.StatusBadRequest, be.code, be.msg)
	case errors.As(err, &mb):
		return apiErr(http.StatusBadRequest, "bad_backup", "The backup is larger than 1 GiB.")
	case errors.Is(err, syscall.ENOSPC):
		return apiErr(http.StatusInsufficientStorage, "no_space", "There is not enough free disk space for this backup.")
	}
	return err
}

// stopForRestore ends Run (ErrRestart) so the staged backup is applied at
// the next start.
func (h *Hub) stopForRestore() {
	h.stopOnce.Do(func() { close(h.stopCh) })
}

// restoredSince is when the database was restored (nil: never).
func (h *Hub) restoredSince() *time.Time { return h.restoredAt.Load() }
