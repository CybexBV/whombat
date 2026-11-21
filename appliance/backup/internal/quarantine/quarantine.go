// Package quarantine is the appliance-local part of the replacement flow (BK-13, docs/runbooks/
// replacement.md): restore a verified checkpoint into the new appliance's (empty) layout and database,
// then hold the appliance in quarantine — a marker the NixOS units and the runtime obey (runner units don't
// start; the runtime runs no schedules, automations or outbound effects) — until every reconciliation item
// is resolved: the old appliance addressed, endpoints and revocations reviewed, provider logins re-verified,
// uncertain external outcomes reviewed, clients re-pinned to the new content identity.
package quarantine

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"golang.org/x/sys/unix"

	"github.com/CybexBV/whombat/appliance/backup/internal/hosts"
	"github.com/CybexBV/whombat/appliance/backup/internal/listing"
	"github.com/CybexBV/whombat/appliance/backup/internal/snap"
	"github.com/CybexBV/whombat/appliance/backup/internal/state"
	"github.com/CybexBV/whombat/appliance/backup/pkg/coverage"
	"github.com/CybexBV/whombat/appliance/backup/pkg/gitinv"
	"github.com/CybexBV/whombat/appliance/backup/pkg/manifest"
	"github.com/CybexBV/whombat/appliance/backup/pkg/pgtool"
	"github.com/CybexBV/whombat/appliance/backup/pkg/restic"
	"github.com/CybexBV/whombat/appliance/backup/pkg/restore"
)

// Kind of the marker.
const Kind = "whombat.quarantine/1"

// Item is one reconciliation item.
type Item struct {
	ID          string    `json:"id"`
	Title       string    `json:"title"`
	Required    bool      `json:"required"`
	Resolutions []string  `json:"resolutions"` // allowed values
	Resolution  string    `json:"resolution,omitempty"`
	Note        string    `json:"note,omitempty"`
	At          time.Time `json:"at,omitempty"`
}

// Marker phases.
const (
	// PhaseRestoring: a restore is in progress or stopped part-way; data may be partial. Written (and
	// fsynced) before anything is restored, so the runtime never runs on restored data outside quarantine
	// (M-1). An undo (the restore's own, or Recover's at the next start) puts the box back and archives it.
	PhaseRestoring = "restoring"
	// PhaseQuarantined: the checkpoint is in place; reconciliation items are open.
	PhaseQuarantined = "quarantined"
)

// Marker is /persist/backup/quarantine.json.
type Marker struct {
	Kind           string    `json:"kind"`
	Phase          string    `json:"phase,omitempty"` // "" (older markers) = quarantined
	Error          string    `json:"error,omitempty"` // why a restore stopped part-way
	Since          time.Time `json:"since"`
	NewApplianceID string    `json:"newApplianceId"`
	// SetAside is the stamp of the restore's set-aside journal (whombat-set-aside-<stamp>): what an undo puts back,
	// and what is removed once the quarantine is released.
	SetAside string `json:"setAside,omitempty"`
	Restored struct {
		CheckpointID  string    `json:"checkpointId"`
		Seq           int64     `json:"seq"`
		CreatedAt     time.Time `json:"createdAt"`
		SnapshotID    string    `json:"snapshotId"`
		SchemaVersion int       `json:"schemaVersion"`
		// ManifestSHA256 is the restored checkpoint's signed manifest.
		ManifestSHA256 string `json:"manifestSha256,omitempty"`
	} `json:"restored"`
	OldAppliance struct {
		ApplianceID              string `json:"applianceId"`
		ContentPeerID            string `json:"contentPeerId,omitempty"`
		ManagementKeyFingerprint string `json:"managementKeyFingerprint,omitempty"`
	} `json:"oldAppliance"`
	Relogin []string `json:"relogin"` // credential homes restored (each needs its login re-verified)
	// Servers: what happened to the checkpoint's servers (BK-34): "staged" (handed to the hosts service, which
	// applies them at its next start, after the release), "no-hosts-service" (this box has none: not restored);
	// "" when the checkpoint has none.
	Servers string `json:"servers,omitempty"`
	// Hermes: whether the agent's Hermes home came back (BK-36, NX-466): "restored" (in place before the runner
	// starts), "none" (a checkpoint from before it was backed up: the agent starts with an empty memory and new
	// sessions).
	Hermes string `json:"hermes,omitempty"`
	Items  []Item `json:"items"`
	// ReleasedAt is set in the archived copy a release leaves.
	ReleasedAt *time.Time `json:"releasedAt,omitempty"`
}

// Marker.Servers values.
const (
	ServersStaged         = "staged"
	ServersNoHostsService = "no-hosts-service"
)

// Marker.Hermes values.
const (
	HermesRestored = "restored"
	HermesNone     = "none"
)

// Items is the reconciliation checklist (BK-13).
func Items() []Item {
	return []Item{
		{ID: "old-appliance", Required: true, Title: "The old appliance can no longer act: confirmed decommission, or every credential it held rotated/revoked",
			Resolutions: []string{"decommissioned", "credentials-rotated", "lease-expired"}},
		{ID: "revocations", Required: true, Title: "Endpoint revocations made after the checkpoint re-applied (from the owner and control's revocation metadata)",
			Resolutions: []string{"reapplied", "none-after-checkpoint"}},
		{ID: "endpoints", Required: true, Title: "Enrolled endpoints reviewed; unknown or lost ones revoked",
			Resolutions: []string{"reviewed"}},
		{ID: "provider-logins", Required: true, Title: "Every provider/GitHub login re-verified or signed in again (tokens may have rotated or been revoked)",
			Resolutions: []string{"verified", "relogged", "removed"}},
		{ID: "external-outcomes", Required: true, Title: "Runs, pushes and integration effects in `uncertain` or newer than the checkpoint reconciled against the providers (nothing is replayed automatically)",
			Resolutions: []string{"reconciled", "none"}},
		{ID: "identity-repin", Required: true, Title: "Clients re-pinned to the new content identity (recovery-key ceremony or trusted endpoint)",
			Resolutions: []string{"repinned"}},
		{ID: "backup-destination", Required: false, Title: "Backups continue from this appliance (destination adopted with the kit; a new kit issued if anything changed)",
			Resolutions: []string{"adopted", "new-destination"}},
	}
}

// Path of the marker.
func Path(c *state.Config) string { return filepath.Join(c.StateDir, "quarantine.json") }

// Load reads the marker (nil when not in quarantine).
func Load(c *state.Config) (*Marker, error) {
	b, err := state.ReadStateFile(Path(c))
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var m Marker
	return &m, json.Unmarshal(b, &m)
}

// Resolve records a resolution.
func Resolve(c *state.Config, id, resolution, note string) (*Marker, error) {
	m, err := Load(c)
	if err != nil {
		return nil, err
	}
	if m == nil {
		return nil, errors.New("not in quarantine")
	}
	for i := range m.Items {
		it := &m.Items[i]
		if it.ID != id {
			continue
		}
		ok := false
		for _, r := range it.Resolutions {
			ok = ok || r == resolution
		}
		if !ok {
			return nil, fmt.Errorf("%s: resolution must be one of %s", id, strings.Join(it.Resolutions, ", "))
		}
		it.Resolution, it.Note, it.At = resolution, note, time.Now().UTC()
		return m, state.WriteJSON(Path(c), m, 0o644)
	}
	return nil, fmt.Errorf("no reconciliation item %q", id)
}

// Release ends the quarantine once every required item is resolved (the marker is archived, not deleted)
// and makes the database writable again (admin may be nil when the caller does that itself).
func Release(ctx context.Context, c *state.Config, admin *pgtool.Admin, db string) error {
	m, err := Load(c)
	if err != nil {
		return err
	}
	if m == nil {
		return errors.New("not in quarantine")
	}
	var open []string
	for _, it := range m.Items {
		if it.Required && it.Resolution == "" {
			open = append(open, it.ID)
		}
	}
	if m.Phase == PhaseRestoring {
		return errors.New("the restore did not complete: the data may be partial; it is undone at the next start (or with quarantine undo), then restore again")
	}
	if len(open) > 0 {
		return fmt.Errorf("still open: %s", strings.Join(open, ", "))
	}
	if admin != nil {
		if err := admin.Writable(ctx, db); err != nil {
			return fmt.Errorf("make the database writable: %w", err)
		}
	}
	// The archived copy keeps the restore's own time (since) and says when it was released: the released restore is
	// known by that time afterwards as it was while it waited for the answers.
	now := time.Now().UTC()
	m.ReleasedAt = &now
	if err := state.WriteJSON(Path(c), m, 0o644); err != nil {
		return err
	}
	if err := os.Rename(Path(c), filepath.Join(c.StateDir, releasedPrefix+now.Format("20060102T150405Z")+".json")); err != nil {
		return err
	}
	// What the restore set aside is root's: the root unit behind CleanupRequestPath removes it (Recover).
	_ = state.WriteJSON(CleanupRequestPath(c), map[string]any{"setAside": m.SetAside, "at": time.Now().UTC()}, 0o600)
	return nil
}

// Archived markers of released quarantines.
const releasedPrefix = "quarantine-released-"

// LastReleased is the newest released quarantine's archived marker, with when it was released (nil: none).
func LastReleased(c *state.Config) *Marker {
	ents, _ := os.ReadDir(c.StateDir)
	for i := len(ents) - 1; i >= 0; i-- { // by name, the release's time: the newest last
		n := ents[i].Name()
		if !strings.HasPrefix(n, releasedPrefix) || !strings.HasSuffix(n, ".json") {
			continue
		}
		b, err := state.ReadStateFile(filepath.Join(c.StateDir, n))
		if err != nil {
			continue
		}
		var m Marker
		if json.Unmarshal(b, &m) != nil {
			continue
		}
		if m.ReleasedAt == nil { // archived before releases said when
			at, err := time.Parse("20060102T150405Z", strings.TrimSuffix(strings.TrimPrefix(n, releasedPrefix), ".json"))
			if err != nil {
				continue
			}
			m.ReleasedAt = &at
		}
		return &m
	}
	return nil
}

// CleanupRequestPath is written by a release: its path unit starts the root unit that removes what the restore set
// aside (whombat-backup restore-recover).
func CleanupRequestPath(c *state.Config) string {
	return filepath.Join(c.StateDir, "restore-cleanup.json")
}

// released lists the set-aside stamps of the released quarantines.
func released(c *state.Config) map[string]bool {
	out := map[string]bool{}
	ents, _ := os.ReadDir(c.StateDir)
	for _, e := range ents {
		if !strings.HasPrefix(e.Name(), releasedPrefix) || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		b, err := state.ReadStateFile(filepath.Join(c.StateDir, e.Name()))
		if err != nil {
			continue
		}
		var m Marker
		if json.Unmarshal(b, &m) == nil && m.SetAside != "" {
			out[m.SetAside] = true
		}
	}
	return out
}

// filesSources are the sources a restore puts in place as trees: all but `hosts`, the hosts service's own
// backup, which is handed to the service instead (Stage, BK-34).
func filesSources(l coverage.Layout) []coverage.Source {
	var out []coverage.Source
	for _, s := range l.Sources() {
		if s.Name != "hosts" {
			out = append(out, s)
		}
	}
	return out
}

func logf(log func(string, ...any), format string, a ...any) {
	if log != nil {
		log(format, a...)
	}
}

// moveInto moves the entries of src into the (empty, existing or absent) directory dst. The target stays
// the directory it is: on the appliance every source is its own btrfs subvolume (snapshots, capacity
// limits), so it is filled, never replaced, and entries that can't be renamed into it (another subvolume:
// EXDEV) are copied with extent clones and removed from where they were (BK-24). A power cut can stop it anywhere
// without losing an entry: a copy gets its name only once it is complete and on disk, and the original goes only
// after that, so a named entry in dst is always whole and one under movingPrefix is half a copy, removed.
func moveInto(ctx context.Context, src, dst string) error {
	if _, err := os.Lstat(dst); errors.Is(err, os.ErrNotExist) {
		if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
			return err
		}
		if err := os.Rename(src, dst); err == nil {
			return nil
		} else if !errors.Is(err, syscall.EXDEV) {
			return err
		}
		if err := os.Mkdir(dst, 0o700); err != nil {
			return err
		}
	}
	if err := removeHalfCopies(dst); err != nil {
		return err
	}
	ents, err := os.ReadDir(src)
	if err != nil {
		return err
	}
	for _, e := range ents {
		from, to := filepath.Join(src, e.Name()), filepath.Join(dst, e.Name())
		if strings.HasPrefix(e.Name(), movingPrefix) {
			if err := os.RemoveAll(from); err != nil {
				return err
			}
			continue
		}
		err := os.Rename(from, to)
		if errors.Is(err, syscall.EXDEV) {
			tmp := filepath.Join(dst, movingPrefix+e.Name())
			err = snap.CopyTree(ctx, from, tmp)
			if err == nil {
				err = syncFS(dst)
			}
			if err == nil {
				err = os.Rename(tmp, to)
			}
			if err == nil {
				err = syncFS(dst)
			}
			if err == nil {
				err = os.RemoveAll(from)
			}
		}
		if err != nil {
			return err
		}
	}
	return nil // an existing target keeps its own mode and owner (the NixOS layout's)
}

// movingPrefix names an entry that is being copied in (moveInto).
const movingPrefix = ".whombat-moving-"

func removeHalfCopies(dir string) error {
	ents, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	for _, e := range ents {
		if strings.HasPrefix(e.Name(), movingPrefix) {
			if err := os.RemoveAll(filepath.Join(dir, e.Name())); err != nil {
				return err
			}
		}
	}
	return nil
}

// syncFS writes the filesystem holding path to disk (syncfs): what a journal records next is then true after a
// power cut too.
func syncFS(path string) error {
	fd, err := unix.Open(path, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		return err
	}
	defer unix.Close(fd)
	return unix.Syncfs(fd)
}

// Prepare empties a fresh appliance for a restore (BK-24, docs/runbooks/restore.md): with the runtime
// stopped, it moves whatever the fresh install put in the file sources to <persist>/whombat-set-aside-<time>/,
// renames the database to <db>_set_aside_<time> and creates it again, empty and owned by owner. Nothing is
// deleted: the folder's journal records each change before it is made, so a prepare that fails is put back at once,
// and a restore that doesn't finish is put back by Undo (or Recover at the next start). It returns the folder.
func Prepare(ctx context.Context, c *state.Config, admin *pgtool.Admin, db, owner string, log func(string, ...any)) (string, error) {
	j, err := prepare(ctx, c, admin, db, owner, nil, log)
	if err != nil {
		return "", err
	}
	return j.dir, nil
}

func prepare(ctx context.Context, c *state.Config, admin *pgtool.Admin, db, owner string, app *AppJournal, log func(string, ...any)) (*Journal, error) {
	release, err := lockRestore(c)
	if err != nil {
		return nil, err
	}
	defer release()
	lock, err := state.TryLock(c)
	if err != nil {
		return nil, err
	}
	defer lock.Unlock()
	if m, err := Load(c); m != nil || err != nil {
		return nil, fmt.Errorf("already in quarantine (%v): nothing to prepare", err)
	}
	if p := pending(c); p != nil {
		return nil, fmt.Errorf("a restore that didn't finish is still set aside in %s: undo it first (quarantine undo)", p.dir)
	}
	if c.RuntimeSocket != "" {
		if conn, err := net.DialTimeout("unix", c.RuntimeSocket, time.Second); err == nil {
			conn.Close()
			return nil, errors.New("the runtime is running: stop it first (systemctl stop whombat-runtime.target whombat-server whombat-runner)")
		}
	}
	// Next to the sources, in /persist (root's): never in the backup user's state directory (BK-26), and never in a
	// source, where a checkpoint taken during the quarantine would carry it.
	j, err := newJournal(c, db, app)
	if err != nil {
		return nil, err
	}
	failed := func(err error) (*Journal, error) {
		if uerr := undo(ctx, c, admin, j); uerr != nil {
			return j, fmt.Errorf("%w (and putting it back failed: %v)", err, uerr)
		}
		return nil, err
	}
	for _, s := range filesSources(c.Layout()) {
		ents, err := os.ReadDir(s.Path)
		if err != nil || len(ents) == 0 {
			continue
		}
		dst := filepath.Join(j.dir, s.Name)
		if err := os.MkdirAll(dst, 0o700); err != nil {
			return failed(err)
		}
		if err := moveInto(ctx, s.Path, dst); err != nil {
			return failed(fmt.Errorf("set aside %s: %w", s.Path, err))
		}
		logf(log, "moved the contents of %s to %s", s.Path, dst)
	}
	if admin != nil && db != "" {
		exists, err := admin.Exists(ctx, db)
		if err != nil {
			return failed(fmt.Errorf("database: %w", err))
		}
		if exists {
			j.AsideDB = strings.ToLower(db + "_set_aside_" + j.Stamp)
			if err := j.save(); err != nil {
				return failed(err)
			}
			if err := admin.SetAside(ctx, db, j.AsideDB); err != nil {
				return failed(fmt.Errorf("set the database aside: %w", err))
			}
			logf(log, "renamed database %s to %s", db, j.AsideDB)
		}
		if err := admin.CreateDBOwned(ctx, db, owner); err != nil {
			return failed(fmt.Errorf("create the empty database: %w", err))
		}
		logf(log, "created an empty database %s owned by %s", db, owner)
	}
	// Everything set aside is on disk before the journal says so: an undo after a power cut then empties the sources
	// only when nothing of the fresh install is left in them.
	if err := syncFS(c.Persist); err != nil {
		return failed(err)
	}
	j.Prepared = true
	if err := j.save(); err != nil {
		return failed(err)
	}
	return j, nil
}

// pending is a set-aside journal whose restore is neither released nor undone (nil when none).
func pending(c *state.Config) *Journal {
	js, _ := Journals(c)
	rel := released(c)
	for i := len(js) - 1; i >= 0; i-- {
		if !rel[js[i].Stamp] {
			return js[i]
		}
	}
	return nil
}

// ApplyOptions restores a checkpoint onto this (replacement) appliance.
type ApplyOptions struct {
	Repo        restic.Repo
	ManifestKey ed25519.PublicKey
	Snapshot    string
	// DSN of the appliance's (empty) database; Admin (the maintenance database) makes it read-only.
	DSN   string
	Admin *pgtool.Admin
	// DBRole owns the restored database objects (the runtime's role, "whombat", when DSN connects as a
	// superuser; "" = the DSN's user).
	DBRole string
	Bins   pgtool.Bins
	Git    gitinv.Runner
	// ExpectHead is the newest checkpoint the recovery kit knows (nil = not checked).
	ExpectHead *restore.ExpectedHead
	CheckData  string
	// Adopted: ManifestKey is an earlier Whombat's (adopted with its kit), not this box's own. Once its checkpoint is
	// back, that key is trusted only for the backups it had made by then (TrustUntil).
	Adopted bool
	// Trusted are the manifest sha256s of the adopted key's checkpoints up to the one restored (listing.Bound.Known).
	Trusted []string
	// AdoptedKnown are the adopted Whombat's checkpoints, when ManifestKey is an earlier Whombat's its kit carried: the
	// adopted Whombat is retired too, so its key is bounded at them (nil: listed here).
	AdoptedKnown []string
	Log          func(format string, a ...any)
}

// Apply verifies and restores the checkpoint into the configured layout. Every target directory must be
// absent or empty and the database empty: a replacement never merges into existing data.
func Apply(ctx context.Context, c *state.Config, o ApplyOptions) (*Marker, *restore.Report, error) {
	release, err := lockRestore(c)
	if err != nil {
		return nil, nil, err
	}
	defer release()
	lock, err := state.TryLock(c)
	if err != nil {
		return nil, nil, err
	}
	defer lock.Unlock()
	if m, err := Load(c); m != nil || err != nil {
		return nil, nil, fmt.Errorf("already in quarantine (%v): finish or release the previous restore first", err)
	}
	layout := c.Layout()
	for _, s := range filesSources(layout) {
		if ents, err := os.ReadDir(s.Path); err == nil && len(ents) > 0 {
			return nil, nil, fmt.Errorf("%s is not empty: a replacement restores only into an empty layout", s.Path)
		}
	}
	// Quarantine before any data arrives (M-1): the marker is written and fsynced first; the runtime
	// (WHOMBAT_QUARANTINE_FILE) and the runner units obey it from this moment on, whatever happens next.
	m := &Marker{Kind: Kind, Phase: PhaseRestoring, Since: time.Now().UTC(), NewApplianceID: c.ApplianceID, Items: Items()}
	if j := pending(c); j != nil {
		m.SetAside = j.Stamp
	}
	if err := state.WriteJSON(Path(c), m, 0o644); err != nil {
		return nil, nil, fmt.Errorf("write the quarantine marker: %w", err)
	}
	failed := func(rep *restore.Report, err error) (*Marker, *restore.Report, error) {
		m.Error = err.Error()
		_ = state.WriteJSON(Path(c), m, 0o644)
		return nil, rep, fmt.Errorf("%w; the appliance stays in quarantine (read-only; runner stopped) until it is undone (quarantine undo, or the next start)", err)
	}
	// The restore is staged in a directory only root can reach (/persist is root's), never in the backup
	// user's state directory: restic restores owners as root there, and nothing may be swapped under it
	// (BK-26).
	work, err := os.MkdirTemp(c.Persist, ".whombat-restore-")
	if err != nil {
		return failed(nil, err)
	}
	defer os.RemoveAll(work)
	// restic's cache for this restore only lives in the staging directory and goes with it (a root run never writes
	// into the backup user's cache); manifests the box read before are taken from its cache, verified again with the
	// trusted key, and a root run adds none to it.
	rep, err := restore.Run(ctx, restore.Options{Repo: o.Repo, Snapshot: o.Snapshot, ManifestKey: o.ManifestKey,
		Root: filepath.Join(work, "root"), CheckData: o.CheckData, Bins: o.Bins, DSN: o.DSN, Admin: o.Admin,
		DBRole: o.DBRole, Git: o.Git, ExpectHead: o.ExpectHead, Log: o.Log,
		CacheDir: filepath.Join(work, "cache"), Manifests: listing.ManifestCache(c)})
	if err != nil {
		return failed(rep, err)
	}
	if f := rep.Failed(); len(f) > 0 {
		return failed(rep, fmt.Errorf("verification failed (%s)", strings.Join(f, ", ")))
	}
	// Put the files in place (same filesystem: renames). Relocated git metadata now points at the staging
	// root: rewrite it to the live layout.
	root := filepath.Join(work, "root")
	var maps []gitinv.Mapping
	for _, s := range filesSources(layout) {
		maps = append(maps, gitinv.Mapping{Old: filepath.Join(root, manifest.FilesDir, s.Name), New: s.Path})
	}
	if _, _, err := gitinv.Relocate(filepath.Join(root, manifest.FilesDir), maps, c.Persist); err != nil {
		return failed(rep, err)
	}
	for _, s := range filesSources(layout) {
		src := filepath.Join(root, manifest.FilesDir, s.Name)
		if _, err := os.Lstat(src); err != nil {
			continue
		}
		if err := moveInto(ctx, src, s.Path); err != nil {
			return failed(rep, fmt.Errorf("put %s in place: %w", s.Name, err))
		}
	}
	mf := rep.Manifest
	// The servers: not a tree put in place, but the hosts service's own backup handed to it (verified by the
	// `hosts` check above), which it applies at its next start (BK-34). Checkpoints from before have none.
	if mf.Hosts != nil {
		switch {
		case c.Hosts == nil:
			m.Servers = ServersNoHostsService
			logf(o.Log, "the checkpoint has servers, but this box has no hosts service: they were not restored")
		default:
			src, err := hubArchive(root, mf)
			if err != nil {
				return failed(rep, err)
			}
			if err := hosts.Stage(src, layout, c.Hosts.UID, c.Hosts.GID); err != nil {
				return failed(rep, fmt.Errorf("hand the servers to the hosts service: %w", err))
			}
			m.Servers = ServersStaged
			logf(o.Log, "the servers are staged at %s: the hosts service applies them at its next start",
				hosts.StagedPath(layout))
		}
	}
	// The Hermes home was put in place with the other sources. A checkpoint from before it leaves the directory
	// empty: the runner makes the home at the first turn and Hermes puts its built-in skills in (Whombat OP-08).
	if mf.Hermes != nil {
		m.Hermes = HermesRestored
		logf(o.Log, "the Hermes home is back in %s: %d SQLite stores and %d skills", layout.Hermes(), len(mf.Hermes.Stores), mf.Hermes.Skills)
	} else {
		m.Hermes = HermesNone
		logf(o.Log, "the checkpoint has no Hermes home (made before it was backed up): the agent starts with an empty memory and new sessions")
	}
	m.Phase = PhaseQuarantined
	m.Restored.CheckpointID, m.Restored.Seq, m.Restored.CreatedAt = mf.ID, mf.Seq, mf.CreatedAt
	m.Restored.SnapshotID, m.Restored.SchemaVersion = rep.Snapshot.ID, mf.Database.SchemaVersion
	m.Restored.ManifestSHA256 = rep.ManifestSHA256
	m.OldAppliance.ApplianceID = mf.ApplianceID
	m.OldAppliance.ContentPeerID = mf.References.ContentPeerID
	m.OldAppliance.ManagementKeyFingerprint = mf.References.ManagementKeyFingerprint
	if ents, err := os.ReadDir(layout.Credentials()); err == nil {
		for _, acct := range ents {
			provs, _ := os.ReadDir(filepath.Join(layout.Credentials(), acct.Name()))
			for _, p := range provs {
				m.Relogin = append(m.Relogin, acct.Name()+"/"+p.Name())
			}
		}
	}
	// The checkpoint is on disk before the marker says it is in place.
	if err := syncFS(c.Persist); err != nil {
		return failed(rep, err)
	}
	if o.Adopted {
		if err := trustAfterRestore(ctx, c, o, m, mf); err != nil {
			return failed(rep, fmt.Errorf("record which of the earlier Whombat's backups stay trusted: %w", err))
		}
	}
	if err := state.WriteJSON(Path(c), m, 0o644); err != nil {
		return failed(rep, err)
	}
	return m, rep, nil
}

// hubArchive is the servers' archive in the restored checkpoint: exactly the file its manifest names (the one the
// `hosts` check verified), an uncompressed hub.tar or the gzipped hub.tar.gz of older checkpoints. Another file
// that happens to be there is never handed over.
func hubArchive(root string, mf *manifest.Manifest) (string, error) {
	p := mf.Hosts.Backup.Path
	if p != manifest.HostsBackupTarPath && p != manifest.HostsBackupPath {
		return "", fmt.Errorf("the checkpoint names no servers archive it may have (%q)", p)
	}
	full := filepath.Join(root, filepath.FromSlash(p))
	if fi, err := os.Lstat(full); err != nil || !fi.Mode().IsRegular() {
		return "", fmt.Errorf("the checkpoint's servers archive %s is missing", p)
	}
	return full, nil
}
