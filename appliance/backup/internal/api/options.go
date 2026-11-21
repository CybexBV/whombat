package api

// The backup options, the list and bringing a Whombat back (BK-37…BK-40, Whombat backup-options.md):
//
//	GET    /v1/policy             runtime, manager  the person's options (the default when none was set)
//	PUT    /v1/policy             runtime           set them {v, frequency, timeZone, keep, limitBytes, weeklyCheck}
//	GET    /v1/checkpoints        runtime           the backups in the destination, newest first, and those left on the
//	                                                box's own disk {checkpoints, unauthentic, local}
//	POST   /v1/drills             runtime           check one backup now {checkpointId, own} → 202 {queued}
//	POST   /v1/local/copy         runtime           copy the box's own backups to the destination → {copied}
//	DELETE /v1/local              runtime           remove the box's own backups → {ok}
//	POST   /v1/adopt              runtime           join an earlier Whombat's backups {material, replace?} → {oldApplianceId, checkpoints}
//	GET    /v1/quarantine         runtime, manager  where a restore is (@whombat/protocol BackupRestoreState)
//	POST   /v1/quarantine/resolve runtime           {item, resolution, note?} → the state
//	POST   /v1/quarantine/release runtime           end the quarantine (the database is writable already) {checkpointId?}
//	                                                → the state (a released restore keeps its since)

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"regexp"
	"time"

	"github.com/CybexBV/whombat/appliance/backup/internal/dest"
	"github.com/CybexBV/whombat/appliance/backup/internal/drill"
	"github.com/CybexBV/whombat/appliance/backup/internal/listing"
	"github.com/CybexBV/whombat/appliance/backup/internal/quarantine"
	"github.com/CybexBV/whombat/appliance/backup/internal/state"
	"github.com/CybexBV/whombat/appliance/backup/pkg/kit"
	"github.com/CybexBV/whombat/appliance/backup/pkg/manifest"
)

func (s *Server) routesOptions(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/policy", s.allow(s.getPolicy, "runtime", "manager"))
	mux.HandleFunc("PUT /v1/policy", s.allow(s.putPolicy, "runtime"))
	mux.HandleFunc("GET /v1/checkpoints", s.allow(s.listCheckpoints, "runtime"))
	mux.HandleFunc("POST /v1/drills", s.allow(s.requestDrill, "runtime"))
	mux.HandleFunc("POST /v1/local/copy", s.allow(s.copyLocal, "runtime"))
	mux.HandleFunc("DELETE /v1/local", s.allow(s.removeLocal, "runtime"))
	mux.HandleFunc("POST /v1/adopt", s.allow(s.adopt, "runtime"))
	mux.HandleFunc("GET /v1/quarantine", s.allow(s.quarantineState, "runtime", "manager"))
	mux.HandleFunc("POST /v1/quarantine/resolve", s.allow(s.quarantineResolve, "runtime"))
	mux.HandleFunc("POST /v1/quarantine/release", s.allow(s.quarantineRelease, "runtime"))
}

func decodeStrict(r *http.Request, v any) error {
	dec := json.NewDecoder(io.LimitReader(r.Body, 128*1024))
	dec.DisallowUnknownFields()
	return dec.Decode(v)
}

func (s *Server) getPolicy(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, state.LoadPolicy(s.Cfg))
}

func (s *Server) putPolicy(w http.ResponseWriter, r *http.Request) {
	var p state.Policy
	if err := decodeStrict(r, &p); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid policy: "+err.Error(), "")
		return
	}
	if err := state.SavePolicy(s.Cfg, p); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error(), "")
		return
	}
	_, _ = state.UpdateStatus(s.Cfg, nil) // staleness follows the new frequency
	writeJSON(w, http.StatusOK, p)
}

func (s *Server) listCheckpoints(w http.ResponseWriter, r *http.Request) {
	d, err := state.LoadDestination(s.Cfg)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal", err.Error(), "")
		return
	}
	res := &listing.Result{Checkpoints: []listing.Entry{}}
	if d != nil {
		keys, err := listing.LoadKeys(s.Cfg)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal", err.Error(), "")
			return
		}
		res, err = listing.List(r.Context(), s.Cfg, s.Cfg.Repo(d), keys)
		if err != nil {
			writeErr(w, http.StatusBadGateway, "destination_failed", state.ASCII(err.Error(), 500), "")
			return
		}
	}
	if local, err := listing.LocalLeftover(r.Context(), s.Cfg, d); err == nil {
		res.Local = local
	}
	writeJSON(w, http.StatusOK, res)
}

// DrillRequest is “Check this backup now” (BKO-07), queued for the drill unit (drill.Request).
type DrillRequest struct {
	CheckpointID string     `json:"checkpointId"`
	Own          bool       `json:"own"`
	At           *time.Time `json:"at,omitempty"` // accepted, unused: the queue records when it arrived
}

func (s *Server) requestDrill(w http.ResponseWriter, r *http.Request) {
	var req DrillRequest
	if err := decodeStrict(r, &req); err != nil || !checkpointID.MatchString(req.CheckpointID) {
		writeErr(w, http.StatusBadRequest, "bad_request", "checkpointId required", "")
		return
	}
	if d, _ := state.LoadDestination(s.Cfg); d == nil {
		writeErr(w, http.StatusPreconditionFailed, "unprotected", "no destination configured", "")
		return
	}
	if err := drill.Enqueue(s.Cfg, drill.Request{CheckpointID: req.CheckpointID, Own: req.Own, At: time.Now().UTC()}); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal", err.Error(), "")
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]bool{"queued": true})
}

func (s *Server) copyLocal(w http.ResponseWriter, r *http.Request) {
	d, err := state.LoadDestination(s.Cfg)
	if err != nil || d == nil || d.Kind == state.KindLocal {
		writeErr(w, http.StatusPreconditionFailed, "unprotected", "the backups go to this Whombat's own disk: there is nowhere to move them", "")
		return
	}
	local, err := listing.LocalLeftover(r.Context(), s.Cfg, d)
	if err != nil || local == nil {
		writeErr(w, http.StatusNotFound, "not_found", "no backups are left on this Whombat's own disk", "")
		return
	}
	lock, err := state.TryLock(s.Cfg)
	if err != nil {
		writeErr(w, http.StatusConflict, "busy", err.Error(), "")
		return
	}
	defer lock.Unlock()
	id := "copy-" + time.Now().UTC().Format("20060102T150405Z")
	_, _ = state.UpdateStatus(s.Cfg, func(st *state.Status) {
		st.Running = &state.Running{ID: id, Op: "copy", Stage: "upload", Since: time.Now().UTC()}
	})
	defer func() { _, _ = state.UpdateStatus(s.Cfg, func(st *state.Status) { st.Running = nil }) }()
	// Their manifests read from this disk first (fast), so the list needn't fetch them from the destination after.
	if keys, err := listing.LoadKeys(s.Cfg); err == nil {
		_, _ = listing.List(r.Context(), s.Cfg, listing.LocalRepo(s.Cfg), keys)
	}
	target := s.Cfg.Repo(d)
	if err := target.Copy(r.Context(), listing.LocalRepositoryPath(s.Cfg), s.Cfg.RepositoryPasswordPath()); err != nil {
		writeErr(w, http.StatusBadGateway, "destination_failed", state.ASCII(err.Error(), 500), "")
		return
	}
	// Removed only when every checkpoint of the box's own disk is in the destination now.
	src, err := listing.LocalRepo(s.Cfg).Snapshots(r.Context(), manifest.TagProduct)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal", err.Error(), "")
		return
	}
	dst, err := target.Snapshots(r.Context(), manifest.TagProduct)
	if err != nil {
		writeErr(w, http.StatusBadGateway, "destination_failed", state.ASCII(err.Error(), 500), "")
		return
	}
	there := map[string]bool{}
	for _, sn := range dst {
		there[sn.Tag(manifest.TagIDPrefix)] = true
	}
	for _, sn := range src {
		if !there[sn.Tag(manifest.TagIDPrefix)] {
			writeErr(w, http.StatusBadGateway, "destination_failed", "not every backup arrived; they stay on this Whombat", "")
			return
		}
	}
	if err := removeLocalRepository(s.Cfg); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal", err.Error(), "")
		return
	}
	writeJSON(w, http.StatusOK, map[string]int{"copied": len(src)})
}

func (s *Server) removeLocal(w http.ResponseWriter, _ *http.Request) {
	d, _ := state.LoadDestination(s.Cfg)
	if d != nil && d.Kind == state.KindLocal {
		writeErr(w, http.StatusConflict, "conflict", "the backups still go to this Whombat's own disk", "")
		return
	}
	lock, err := state.TryLock(s.Cfg)
	if err != nil {
		writeErr(w, http.StatusConflict, "busy", err.Error(), "")
		return
	}
	defer lock.Unlock()
	if err := removeLocalRepository(s.Cfg); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal", err.Error(), "")
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// removeLocalRepository deletes the box's own repository (its restic cache goes with restic's next cleanup).
func removeLocalRepository(c *state.Config) error {
	return os.RemoveAll(listing.LocalRepositoryPath(c))
}

var checkpointID = regexp.MustCompile(`^[A-Za-z0-9_.:-]{1,64}$`)

// AdoptRequest joins an earlier Whombat's repository with its recovery kit's backup section. Replace says the person
// chose to bring an earlier Whombat back onto this one although it has backups of its own: they stay where they are
// (the place this box used until now keeps them, nothing is deleted), the place becomes the earlier Whombat's, and
// the restore that follows replaces what is on this box (set aside until the restore is finished, then removed).
type AdoptRequest struct {
	Material json.RawMessage `json:"material"`
	Replace  bool            `json:"replace,omitempty"`
}

// AdoptResult names the Whombat the backups are from and lists them.
type AdoptResult struct {
	OldApplianceID string          `json:"oldApplianceId"`
	Checkpoints    []listing.Entry `json:"checkpoints"`
}

func (s *Server) adopt(w http.ResponseWriter, r *http.Request) {
	var req AdoptRequest
	if err := decodeStrict(r, &req); err != nil || len(req.Material) == 0 {
		writeErr(w, http.StatusBadRequest, "bad_request", "material required", "")
		return
	}
	m, err := kit.Parse(req.Material)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "that isn't a recovery kit's backup section", "")
		return
	}
	if last, _ := state.LastChain(s.Cfg); last != nil && !req.Replace {
		writeErr(w, http.StatusConflict, "conflict", "this Whombat has backups of its own: bringing another one back replaces what is on it (replace: true)", "")
		return
	}
	if q, _ := quarantine.Load(s.Cfg); q != nil {
		writeErr(w, http.StatusConflict, "conflict", "a restore is going already", "")
		return
	}
	_, err = dest.Configure(r.Context(), s.Cfg, dest.Request{Repository: m.Repository, AdoptPassword: m.RepositoryPassword,
		AdoptManifestKey: m.ManifestKey, AdoptHead: m.Head, AdoptEarlier: m.Adopted, RESTUser: m.RESTUser,
		RESTPassword: m.RESTPassword, S3AccessKeyID: m.S3AccessKeyID, S3SecretAccessKey: m.S3SecretAccessKey,
		S3Region: m.S3Region, SFTPUser: m.SFTPUser, SFTPHostKey: m.SFTPHostKey, SFTPPrivateKey: m.SFTPPrivateKey})
	var ie *dest.InputError
	switch {
	case errors.As(err, &ie):
		writeErr(w, http.StatusBadRequest, "bad_request", state.ASCII(ie.Msg, 500), "")
		return
	case err != nil:
		writeErr(w, http.StatusBadGateway, "destination_failed", state.ASCII(err.Error(), 500), "")
		return
	}
	d, err := state.LoadDestination(s.Cfg)
	if err != nil || d == nil {
		writeErr(w, http.StatusInternalServerError, "internal", "the destination wasn't saved", "")
		return
	}
	keys, err := listing.LoadKeys(s.Cfg)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal", err.Error(), "")
		return
	}
	res, err := listing.List(r.Context(), s.Cfg, s.Cfg.Repo(d), keys)
	if err != nil {
		writeErr(w, http.StatusBadGateway, "destination_failed", state.ASCII(err.Error(), 500), "")
		return
	}
	// The earlier Whombat's backups, and those of the Whombats it was brought back from, each up to its cut-off; each
	// entry names the Whombat whose key signed it (applianceId).
	out := AdoptResult{OldApplianceID: m.ApplianceID, Checkpoints: []listing.Entry{}}
	for _, e := range res.Checkpoints {
		if !e.Own {
			out.Checkpoints = append(out.Checkpoints, e)
		}
	}
	writeJSON(w, http.StatusOK, out)
}

/* Where a restore is ------------------------------------------------------------------------------------------ */

// RestoreItem is one item of the checklist.
type RestoreItem struct {
	ID         string  `json:"id"`
	Required   bool    `json:"required"`
	Resolution *string `json:"resolution"`
}

// RestoreRestored is the checkpoint that came back.
type RestoreRestored struct {
	CheckpointID  string    `json:"checkpointId"`
	CreatedAt     time.Time `json:"createdAt"`
	SchemaVersion int       `json:"schemaVersion"`
}

// RestoreState is @whombat/protocol BackupRestoreState.
type RestoreState struct {
	Phase string     `json:"phase"` // none | restoring | checking | failed | released
	Stage *string    `json:"stage"`
	Since *time.Time `json:"since"`
	// Error is the sentence the person reads when it failed, Reason the kind of failure (quarantine.Reason*:
	// interrupted after a power cut, newer, no_space, …). What went wrong in technical words stays in
	// restore-result.json and the log: people read only Error.
	Error          *string          `json:"error"`
	Reason         *string          `json:"reason"`
	Restored       *RestoreRestored `json:"restored"`
	OldApplianceID *string          `json:"oldApplianceId"`
	Relogin        []string         `json:"relogin"`
	Servers        *string          `json:"servers"`
	Items          []RestoreItem    `json:"items"`
}

func strp(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// stoppedPartWay is what the person reads about a restore that stopped part-way and couldn't be put back yet, when no
// result of that attempt says more.
const stoppedPartWay = "Bringing the backup back stopped part-way, and putting this Whombat back as it was didn't finish. It tries again at its next start; ask for help if that doesn't fix it."

// CurrentRestore says where a restore is: a failed one with its reason and the person's sentence, never the
// technical detail.
func CurrentRestore(c *state.Config) (*RestoreState, error) {
	out := &RestoreState{Phase: "none", Relogin: []string{}, Items: []RestoreItem{}}
	st, _ := state.LoadStatus(c)
	if st != nil && st.Running != nil && st.Running.Op == "restore" {
		out.Phase, out.Stage = "restoring", strp(st.Running.Stage)
		since := st.Running.Since
		out.Since = &since
	}
	m, err := quarantine.Load(c)
	if err != nil {
		return nil, err
	}
	rr := quarantine.LoadResult(c)
	if m != nil {
		switch {
		case m.Phase == quarantine.PhaseRestoring && m.Error != "":
			// The marker's error is technical: the person reads the result of this attempt, or that it stopped part-way.
			out.Phase, out.Error, out.Reason = "failed", strp(stoppedPartWay), strp(quarantine.ReasonFailed)
			if rr != nil && !rr.OK && rr.Error != "" && !rr.At.Before(m.Since) {
				out.Error, out.Reason = strp(state.OneLine(rr.Error, 500)), strp(rr.Reason)
			}
		case m.Phase == quarantine.PhaseRestoring:
			out.Phase = "restoring"
		default:
			if out.Phase != "restoring" {
				out.Phase = "checking"
			}
		}
		since := m.Since
		out.Since = &since
		if m.Restored.CheckpointID != "" {
			out.Restored = &RestoreRestored{CheckpointID: m.Restored.CheckpointID, CreatedAt: m.Restored.CreatedAt,
				SchemaVersion: m.Restored.SchemaVersion}
		}
		out.OldApplianceID = strp(m.OldAppliance.ApplianceID)
		if m.Relogin != nil {
			out.Relogin = m.Relogin
		}
		out.Servers = strp(m.Servers)
		for _, it := range m.Items {
			out.Items = append(out.Items, RestoreItem{ID: it.ID, Required: it.Required, Resolution: strp(it.Resolution)})
		}
		return out, nil
	}
	if out.Phase == "restoring" {
		return out, nil
	}
	// A released restore keeps the time it had while it waited for the answers (the marker's), unless a later attempt
	// ended since: the runtime knows a restore by that time across the release.
	if rel := quarantine.LastReleased(c); rel != nil && time.Since(*rel.ReleasedAt) <= 7*24*time.Hour &&
		(rr == nil || !rr.At.After(*rel.ReleasedAt)) {
		since := rel.Since
		out.Phase, out.Since = "released", &since
		if rel.Restored.CheckpointID != "" {
			out.Restored = &RestoreRestored{CheckpointID: rel.Restored.CheckpointID, CreatedAt: rel.Restored.CreatedAt,
				SchemaVersion: rel.Restored.SchemaVersion}
		}
		out.OldApplianceID = strp(rel.OldAppliance.ApplianceID)
		return out, nil
	}
	if rr == nil || time.Since(rr.At) > 7*24*time.Hour {
		return out, nil
	}
	at := rr.At
	out.Since = &at
	if !rr.OK {
		out.Phase, out.Error, out.Reason = "failed", strp(state.OneLine(rr.Error, 500)), strp(rr.Reason)
		return out, nil
	}
	out.Phase = "released"
	return out, nil
}

func (s *Server) quarantineState(w http.ResponseWriter, _ *http.Request) {
	st, err := CurrentRestore(s.Cfg)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal", err.Error(), "")
		return
	}
	writeJSON(w, http.StatusOK, st)
}

// ResolveRequest records one answer of the checklist.
type ResolveRequest struct {
	Item       string `json:"item"`
	Resolution string `json:"resolution"`
	Note       string `json:"note"`
}

func (s *Server) quarantineResolve(w http.ResponseWriter, r *http.Request) {
	var req ResolveRequest
	if err := decodeStrict(r, &req); err != nil || req.Item == "" || req.Resolution == "" {
		writeErr(w, http.StatusBadRequest, "bad_request", "item and resolution required", "")
		return
	}
	if _, err := quarantine.Resolve(s.Cfg, req.Item, req.Resolution, state.ASCII(req.Note, 300)); err != nil {
		writeErr(w, http.StatusConflict, "conflict", state.ASCII(err.Error(), 500), "")
		return
	}
	s.quarantineState(w, r)
}

// ReleaseRequest is the release's optional body: the runtime names the restore the person answered for. Other fields
// (the person's answer about the earlier Whombat, which the checklist already holds) are ignored.
type ReleaseRequest struct {
	CheckpointID string `json:"checkpointId"`
}

func (s *Server) quarantineRelease(w http.ResponseWriter, r *http.Request) {
	var req ReleaseRequest
	if b, err := io.ReadAll(io.LimitReader(r.Body, 128*1024)); err != nil || (len(bytes.TrimSpace(b)) > 0 && json.Unmarshal(b, &req) != nil) {
		writeErr(w, http.StatusBadRequest, "bad_request", "the body isn't JSON", "")
		return
	}
	if req.CheckpointID != "" {
		if m, err := quarantine.Load(s.Cfg); err == nil && m != nil && m.Restored.CheckpointID != req.CheckpointID {
			writeErr(w, http.StatusConflict, "conflict", "The restore waiting for your answers isn't that backup's any more.", "")
			return
		}
	}
	// The database was made writable by the restore (the runtime serves the person in quarantine): no admin here.
	if err := quarantine.Release(r.Context(), s.Cfg, nil, ""); err != nil {
		writeErr(w, http.StatusConflict, "conflict", state.ASCII(err.Error(), 500), "")
		return
	}
	s.quarantineState(w, r)
}
