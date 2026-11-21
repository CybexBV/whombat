// Package checkpoint takes one consistent checkpoint (BK-04, BK-05):
//
//  1. preflight outside any quiesce: the destination opens with the password, staging is clean and has
//     room, the runtime tuple is read; on a box with the hosts service, it makes its own backup (BK-31);
//  2. quiesce: a backup drain on the runtime admin socket until the runtime reports a safe boundary
//     (bounded by QuiesceTimeoutMs; on timeout nothing is killed, the drain is released and the reason
//     recorded);
//  3. inside the quiesce: export a PostgreSQL snapshot (REPEATABLE READ, pg_export_snapshot) and snapshot
//     the file sources (btrfs/ZFS snapshot, or the quiesced copy fallback);
//  4. resume — writes were paused only for step 3;
//  5. outside: pg_dump from the exported snapshot, row counts and schema version in the same snapshot,
//     inventory of the snapshotted trees (repositories, caches), signed manifest, restic upload from the
//     snapshot, read-back of the uploaded manifest;
//  6. release the snapshots, record the chain entry and the status.
package checkpoint

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"time"

	"github.com/CybexBV/whombat/appliance/backup/internal/dest"
	"github.com/CybexBV/whombat/appliance/backup/internal/hosts"
	"github.com/CybexBV/whombat/appliance/backup/internal/listing"
	"github.com/CybexBV/whombat/appliance/backup/internal/runtimeadmin"
	"github.com/CybexBV/whombat/appliance/backup/internal/snap"
	"github.com/CybexBV/whombat/appliance/backup/internal/state"
	"github.com/CybexBV/whombat/appliance/backup/pkg/coverage"
	"github.com/CybexBV/whombat/appliance/backup/pkg/fsutil"
	"github.com/CybexBV/whombat/appliance/backup/pkg/gitinv"
	"github.com/CybexBV/whombat/appliance/backup/pkg/manifest"
	"github.com/CybexBV/whombat/appliance/backup/pkg/pgtool"
	"github.com/CybexBV/whombat/appliance/backup/pkg/restic"
	"github.com/CybexBV/whombat/appliance/backup/pkg/restore"
)

// Tool identifies this implementation in manifests.
const Tool = "whombat-backup/0.1.0"

// ErrUnprotected: no destination is configured.
var ErrUnprotected = errors.New("no backup destination is configured: this appliance is unprotected")

// StageError is a failed checkpoint stage with a client-facing reason.
type StageError struct {
	Stage  string
	Reason string
	Err    error
}

func (e *StageError) Error() string { return e.Stage + ": " + e.Reason }
func (e *StageError) Unwrap() error { return e.Err }

func fail(stage string, err error, format string, a ...any) *StageError {
	return &StageError{Stage: stage, Reason: fmt.Sprintf(format, a...), Err: err}
}

// Runner takes checkpoints.
type Runner struct {
	Cfg     *state.Config
	Snap    snap.Snapshotter
	Runtime *runtimeadmin.Client // nil only with Cfg.AllowNoRuntime
	Log     func(format string, a ...any)
	// InsideQuiesce, if set, runs after the snapshots are taken and before resuming (tests).
	InsideQuiesce func()
	// AfterUpload, if set, runs once the snapshot is written and before it is read back; an error fails the read-back
	// (tests).
	AfterUpload func() error
	// Poll is the drain poll interval (default 250ms).
	Poll time.Duration
}

// Options for one checkpoint.
type Options struct {
	Reason string // "scheduled" | "manual" | "pre-migration" | "test"
	// UnderDrain is the request id of a drain the caller (the manager, before an incompatible migration,
	// MD-06) already holds with scope "all": the runtime is quiesced by it (session commands answer
	// unavailable, outbound effects paused), so the checkpoint runs inside it without a drain of its own
	// (a second drain would be refused as busy). The runtime's health must report draining.
	UnderDrain string
	// Verify re-reads the uploaded checkpoint before reporting success: repository structure (restic
	// check), the manifest authenticated with the manifest key and bound to the snapshot, and the database
	// dump streamed back from the destination and hashed (MD-06 step 3).
	Verify bool
	// Migration is recorded in the manifest of a pre-migration checkpoint.
	Migration *manifest.Migration
}

// Result of a checkpoint.
type Result struct {
	Manifest       *manifest.Manifest
	ManifestSHA256 string
	Summary        *restic.Summary
	Duration       time.Duration
	Verified       bool
}

func (r *Runner) logf(format string, a ...any) {
	if r.Log != nil {
		r.Log(format, a...)
	}
}

// NewID makes a checkpoint id.
func NewID(t time.Time) string {
	b := make([]byte, 3)
	_, _ = rand.Read(b)
	return "ck-" + t.UTC().Format("20060102T150405Z") + "-" + hex.EncodeToString(b)
}

// Run takes one checkpoint and records the outcome in the status.
func (r *Runner) Run(ctx context.Context, opts Options) (*Result, error) {
	c := r.Cfg
	lock, err := state.TryLock(c)
	if err != nil {
		return nil, err
	}
	defer lock.Unlock()
	d, err := state.LoadDestination(c)
	if err != nil {
		return nil, err
	}
	if d == nil {
		_, _ = state.UpdateStatus(c, nil)
		return nil, ErrUnprotected
	}
	start := time.Now()
	id := NewID(start)
	_, _ = state.UpdateStatus(c, func(s *state.Status) {
		s.Running = &state.Running{ID: id, Op: "checkpoint", Stage: "preflight", Since: start.UTC()}
	})
	res, err := r.run(ctx, id, d, opts)
	ok := err == nil
	_, _ = state.UpdateStatus(c, func(s *state.Status) {
		s.Running = nil
		s.LastAttemptOK = &ok
		if err != nil {
			s.FailedAttempts++
			f := &state.Failure{ID: id, At: time.Now().UTC(), Stage: "preflight", Reason: err.Error()}
			var se *StageError
			if errors.As(err, &se) {
				f.Stage, f.Reason = se.Stage, se.Reason
			}
			s.LastFailure = f
			return
		}
		m := res.Manifest
		s.FailedAttempts = 0
		s.LastSuccess = &state.Success{ID: m.ID, At: m.CreatedAt, SnapshotID: res.Summary.SnapshotID,
			Method: m.Quiesce.Method, QuiesceHeldMs: m.Quiesce.HeldMs, DurationMs: time.Since(start).Milliseconds(),
			BytesAdded: res.Summary.DataAddedPacked, TotalBytes: res.Summary.TotalBytesProcessed,
			Files: res.Summary.TotalFilesProcessed, SchemaVersion: m.Database.SchemaVersion, Incomplete: IncompleteStatus(m)}
	})
	if res != nil {
		res.Duration = time.Since(start)
	}
	return res, err
}

func (r *Runner) stage(id, st string) {
	_, _ = state.UpdateStatus(r.Cfg, func(s *state.Status) {
		if s.Running != nil && s.Running.ID == id {
			s.Running.Stage = st
		}
	})
}

func noSpace(err error) bool {
	return errors.Is(err, syscall.ENOSPC) || errors.Is(err, syscall.EDQUOT) || errors.Is(err, snap.ErrNoSpace) ||
		(err != nil && strings.Contains(err.Error(), "No space left on device"))
}

func (r *Runner) run(ctx context.Context, id string, d *state.Destination, opts Options) (res *Result, err error) {
	c := r.Cfg
	repo := c.Repo(d)
	// The seal unit may seal (and remove) a new destination's plain secrets while this runs: the run keeps its own.
	unpin, err := c.PinSecrets(&repo)
	if err != nil {
		return nil, fail("preflight", err, "the destination's secrets can't be read: %v", err)
	}
	defer unpin()
	staging := c.StagingDir()
	bins := pgtool.Bins{Dir: c.PGBin}

	// --- 1. preflight (nothing paused yet)
	if d.Kind == state.KindDisk && !c.DiskPresent() {
		return nil, fail("preflight", nil, "%s", dest.ReasonDiskAbsent)
	}
	rcfg, err := repo.Config(ctx)
	if err != nil {
		return nil, fail("preflight", err, "%s", dest.Explain(d, err).Error())
	}
	if d.RepositoryID != "" && rcfg.ID != d.RepositoryID {
		return nil, fail("preflight", nil, "the repository at the destination is not the one configured (id %s, expected %s)", rcfg.ID, d.RepositoryID)
	}
	if c.RuntimeSocket == "" && !c.AllowNoRuntime {
		return nil, fail("preflight", nil, "no runtime admin socket configured; a checkpoint needs a quiesce")
	}
	_ = r.Snap.Release(ctx, id) // leftovers of a crashed run
	for _, sub := range []string{"db", "manifest"} {
		_ = os.RemoveAll(filepath.Join(staging, sub))
		if err := os.MkdirAll(filepath.Join(staging, sub), 0o700); err != nil {
			return nil, fail("preflight", err, "staging: %v", err)
		}
	}
	defer func() {
		if rerr := r.Snap.Release(context.Background(), id); rerr != nil {
			r.logf("release snapshots: %v", rerr)
		}
		for _, sub := range []string{"db", "manifest"} {
			_ = os.RemoveAll(filepath.Join(staging, sub))
		}
		_ = os.Remove(filepath.Join(staging, "exclude.txt"))
	}()
	if need, err := dbSize(ctx, c.PGDSN); err == nil {
		if free, ferr := snap.Free(staging); ferr == nil && need+c.ReserveBytes > free {
			return nil, fail("preflight", snap.ErrNoSpace, "not enough space to stage the database dump: needs about %d MB plus %d MB reserve, %d MB free",
				need>>20, c.ReserveBytes>>20, free>>20)
		}
	} else {
		return nil, fail("preflight", err, "the database can't be reached: %v", err)
	}
	key, err := manifest.LoadOrCreateKey(c.ManifestKeyPath())
	if err != nil {
		return nil, fail("preflight", err, "manifest key: %v", err)
	}
	var rt manifest.Runtime
	if r.Runtime != nil {
		if h, err := r.Runtime.Health(ctx); err == nil {
			rt = manifest.Runtime{ReleaseID: h.ReleaseID, Version: h.Version, SchemaVersion: h.Checks.Migrations.SchemaVersion, Status: h.Status}
		}
	}

	// The hosts service's own backup, made as its user just before the quiesce (it isn't drained, and its
	// backup must not lengthen the write pause): its file is the `hosts` source the snapshot takes with the
	// others (BK-31, BK-32). When it can't be made, everything else is still backed up and the checkpoint says
	// the servers aren't in it: one failing export mustn't stop every backup.
	var gaps manifest.Incomplete
	if c.Hosts != nil {
		hctx, cancel := context.WithTimeout(ctx, time.Duration(c.Hosts.TimeoutMs)*time.Millisecond)
		err := hosts.Export(hctx, c.Hosts.BackupSocket)
		cancel()
		if err != nil {
			if ctx.Err() != nil {
				return nil, fail("snapshot", err, "cancelled while the servers were being backed up")
			}
			gaps.Servers = state.OneLine(err.Error(), 300)
			r.logf("checkpoint %s: the servers couldn't be backed up (%v): backing up everything else", id, err)
		}
	}

	// --- 2..4. quiesce, snapshot, resume
	r.stage(id, "quiesce")
	method := r.Snap.Method()
	scope := "writes"
	if method != "snapshot" {
		scope = "all"
	}
	q := manifest.Quiesce{Method: method, Scope: scope, RequestID: id}
	if method == "quiesced-copy" {
		q.Note = "no snapshot-capable filesystem: writes and new turns stayed paused for the whole file copy"
	}
	var pgSnap *pgtool.Snapshot
	var taken []snap.Taken
	var ckTime time.Time
	if opts.UnderDrain != "" {
		scope = "all"
		q.Scope, q.RequestID = scope, opts.UnderDrain
		q.Note = strings.TrimSpace(q.Note + " inside the caller's drain " + opts.UnderDrain)
	}
	err = r.quiesced(ctx, id, scope, opts.UnderDrain, &q, func() error {
		var err error
		pgSnap, err = pgtool.Export(ctx, c.PGDSN)
		if err != nil {
			return fail("snapshot", err, "database snapshot: %v", err)
		}
		ckTime = time.Now().UTC()
		r.stage(id, "snapshot")
		taken, err = r.Snap.Take(ctx, id)
		if err != nil {
			pgSnap.Close()
			pgSnap = nil
			if noSpace(err) {
				return fail("snapshot", err, "not enough space to stage the files: %v", err)
			}
			return fail("snapshot", err, "file snapshot: %v", err)
		}
		if r.InsideQuiesce != nil {
			r.InsideQuiesce()
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	defer func() {
		if pgSnap != nil {
			pgSnap.Close()
		}
	}()

	// --- 5. dump and inventory from the snapshot (writes already resumed)
	r.stage(id, "dump")
	dumpPath := filepath.Join(staging, filepath.FromSlash(manifest.DumpPath))
	sum, size, err := pgtool.Dump(ctx, bins, c.PGDSN, pgSnap.ID, dumpPath)
	if err != nil {
		if noSpace(err) {
			return nil, fail("dump", err, "not enough space to stage the database dump: %v", err)
		}
		return nil, fail("dump", err, "database dump: %v", err)
	}
	facts, err := pgtool.ReadFacts(ctx, c.PGDSN, pgSnap.ID)
	if err != nil {
		return nil, fail("dump", err, "database facts: %v", err)
	}
	dbInfo := manifest.Database{Name: pgSnap.Database, ServerVersion: pgSnap.Version, SnapshotID: pgSnap.ID,
		SnapshotTime: pgSnap.Time, SchemaVersion: facts.SchemaVersion, SchemaTag: facts.SchemaTag,
		DrizzleMigrations: facts.DrizzleMigrations, ReferencedBlobs: len(facts.Referenced), ReferencedDigest: facts.ReferencedDigest()}
	pgSnap.Close()
	pgSnap = nil
	dbInfo.Dump = manifest.File{Path: manifest.DumpPath, SHA256: sum, Size: size}
	for _, t := range facts.Tables {
		dbInfo.Tables = append(dbInfo.Tables, manifest.Table{Schema: t.Schema, Name: t.Name, Rows: t.Rows})
	}

	r.stage(id, "inventory")
	var hostsInfo *manifest.Hosts
	var staleHosts string
	if c.Hosts != nil && gaps.Servers == "" {
		if hostsInfo, staleHosts, err = hostsBackup(taken); err != nil {
			gaps.Servers = state.OneLine(err.Error(), 300)
			r.logf("checkpoint %s: the servers' backup is unusable (%v): backing up everything else", id, err)
		}
	}
	if gaps.Servers != "" {
		taken = withoutSource(taken, "hosts") // a stale or broken archive is no backup of the servers
	}
	inv, err := r.inventory(ctx, staging, taken, staleHosts)
	if err != nil {
		return nil, fail("snapshot", err, "inventory of the snapshot: %v", err)
	}
	var missing []string
	if home := findTaken(taken, "home"); home != nil {
		for _, k := range facts.Referenced {
			if _, err := os.Lstat(filepath.Join(home.Path, "files", filepath.FromSlash(k))); err != nil {
				missing = append(missing, k)
			}
		}
	}
	if len(missing) > 0 {
		// The appliance itself lacks files the database references: not a backup inconsistency (the snapshot was
		// taken after the database snapshot, inside the quiesce) but data already lost on the box. Everything else is
		// still backed up; the manifest names the gap, so a check of this backup doesn't count it against it.
		sort.Strings(missing)
		gaps.MissingAttachments = len(missing)
		gaps.MissingAttachmentKeys = missing[:min(len(missing), manifest.MaxMissingKeys)]
		r.logf("checkpoint %s: %d attachment(s) the database references aren't on this box (first: %s): backing up the rest", id, len(missing), missing[0])
	}

	// The Hermes home as the snapshot has it: its SQLite stores' hashes go into the signed manifest (BK-36, NX-466).
	var hermesInfo *manifest.Hermes
	if t := findTaken(taken, "hermes"); t != nil && !t.Missing {
		if hermesInfo, err = restore.ReadHermes(t.Path); err != nil {
			return nil, fail("snapshot", err, "inventory of the Hermes home: %v", err)
		}
	}

	last, err := state.LastChain(c)
	if err != nil {
		return nil, fail("preflight", err, "checkpoint chain: %v", err)
	}
	seq, err := state.NextSeq(c, last)
	if err != nil {
		return nil, fail("preflight", err, "checkpoint sequence: %v", err)
	}
	m := &manifest.Manifest{Kind: manifest.Kind, ID: id, Seq: seq, ApplianceID: c.ApplianceID, CreatedAt: ckTime,
		Reason: opts.Reason, Quiesce: q, Runtime: rt, Database: dbInfo, Sources: inv.sources, Repos: inv.repos,
		References: r.references(key.Public().(ed25519.PublicKey), rcfg.ID), Migration: opts.Migration, Hosts: hostsInfo,
		Hermes: hermesInfo, Tool: Tool}
	if gaps.MissingAttachments > 0 || gaps.Servers != "" {
		m.Incomplete = &gaps
	}
	if last != nil { // the newest checkpoint that was read back; one that wasn't kept its number but isn't linked
		m.Previous = &manifest.Ref{ID: last.ID, Seq: last.Seq, ManifestSHA256: last.ManifestSHA256}
	}
	for _, cl := range coverage.Classes(c.Layout()) {
		m.Coverage = append(m.Coverage, manifest.CoverageItem{ID: cl.ID, Covered: cl.Covered, Relogin: cl.Relogin})
	}
	mb, err := manifest.Encode(m)
	if err != nil {
		return nil, fail("upload", err, "manifest: %v", err)
	}
	sig, err := manifest.Sign(mb, key)
	if err != nil {
		return nil, fail("upload", err, "sign manifest: %v", err)
	}
	mfSum := manifest.SHA256(mb)
	if err := os.WriteFile(filepath.Join(staging, filepath.FromSlash(manifest.ManifestPath)), mb, 0o600); err != nil {
		return nil, fail("upload", err, "write manifest: %v", err)
	}
	if err := os.WriteFile(filepath.Join(staging, filepath.FromSlash(manifest.SigPath)), sig, 0o600); err != nil {
		return nil, fail("upload", err, "write signature: %v", err)
	}
	excludeFile := filepath.Join(staging, "exclude.txt")
	if err := os.WriteFile(excludeFile, []byte(inv.excludeFile()), 0o600); err != nil {
		return nil, fail("upload", err, "write excludes: %v", err)
	}

	// --- upload from the snapshot
	r.stage(id, "upload")
	paths := []string{"db", "manifest"}
	for _, t := range taken {
		paths = append(paths, filepath.ToSlash(filepath.Join(manifest.FilesDir, t.Name)))
	}
	summary, err := repo.Backup(ctx, restic.BackupOptions{Dir: staging, Paths: paths,
		Tags: []string{manifest.TagProduct, manifest.TagIDPrefix + id, manifest.TagMFPrefix + mfSum},
		Host: c.ApplianceID, Time: ckTime, ExcludeFile: excludeFile, ExcludeCaches: true,
		ReadConcurrency: c.ReadConcurrency, IgnoreInode: method == "quiesced-copy", IgnoreCtime: method == "quiesced-copy"})
	if err != nil {
		return nil, fail("upload", err, "upload to the destination failed: %s", dest.Explain(d, err).Error())
	}

	// --- read back what the destination now holds
	r.stage(id, "verify")
	if r.AfterUpload != nil {
		if err := r.AfterUpload(); err != nil {
			return nil, fail("verify", err, "the uploaded snapshot can't be read back: %v", err)
		}
	}
	snaps, err := repo.Snapshots(ctx, manifest.TagIDPrefix+id)
	if err != nil || len(snaps) != 1 || snaps[0].Tag(manifest.TagMFPrefix) != mfSum {
		return nil, fail("verify", err, "the uploaded snapshot can't be read back with its manifest tag")
	}
	back, err := repo.DumpBytes(ctx, summary.SnapshotID, manifest.ManifestPath)
	if err != nil || manifest.SHA256(back) != mfSum {
		return nil, fail("verify", err, "the uploaded manifest doesn't read back identically")
	}
	verified := false
	if opts.Verify {
		if err := verifyUploaded(ctx, repo, summary.SnapshotID, key.Public().(ed25519.PublicKey), m.Database.Dump); err != nil {
			return nil, fail("verify", err, "the uploaded checkpoint doesn't verify: %v", err)
		}
		verified = true
	}
	if err := state.AppendChain(c, state.ChainEntry{ID: id, Seq: m.Seq, ManifestSHA256: mfSum, SnapshotID: summary.SnapshotID,
		Repository: d.Repository, At: ckTime, Reason: opts.Reason}); err != nil {
		return nil, fail("verify", err, "record checkpoint: %v", err)
	}
	r.logf("checkpoint %s: snapshot %s, %d files, %d bytes added, writes paused %d ms (%s)",
		id, summary.SnapshotID[:8], summary.TotalFilesProcessed, summary.DataAddedPacked, q.HeldMs, method)
	listing.WarmCache(c, mfSum, mb, sig, key.Public().(ed25519.PublicKey)) // the list of backups reads it from here (BK-38)
	return &Result{Manifest: m, ManifestSHA256: mfSum, Summary: summary, Verified: verified}, nil
}

// verifyUploaded re-reads a checkpoint from the destination before a migration may go ahead (MD-06 step 3): the
// repository's structure, the manifest authenticated, and the whole database dump streamed back and hashed. The
// check keeps the box's cache (the index and trees this upload just wrote are in it): it still lists every pack at
// the destination against the index, and the dump's data is read from the destination, which is what proves the
// checkpoint restorable; a check without the cache would download the index and every tree of all history again,
// inside the manager's drain.
func verifyUploaded(ctx context.Context, repo restic.Repo, snapshotID string, pub ed25519.PublicKey, dump manifest.File) error {
	repo.CheckWithCache = true
	if _, err := repo.Check(ctx, ""); err != nil {
		return fmt.Errorf("repository check: %w", err)
	}
	snaps, err := repo.Snapshots(ctx, "")
	if err != nil {
		return err
	}
	var snapshot *restic.Snapshot
	for i := range snaps {
		if snaps[i].ID == snapshotID {
			snapshot = &snaps[i]
		}
	}
	if snapshot == nil {
		return fmt.Errorf("snapshot %s not in the repository", snapshotID)
	}
	if _, _, err := restore.Authenticate(ctx, repo, *snapshot, pub); err != nil {
		return err
	}
	h := sha256.New()
	cw := &countWriter{w: h}
	if err := repo.Dump(ctx, snapshotID, manifest.DumpPath, cw); err != nil {
		return fmt.Errorf("read back the dump: %w", err)
	}
	if got := hex.EncodeToString(h.Sum(nil)); got != dump.SHA256 || cw.n != dump.Size {
		return fmt.Errorf("the dump read back from the destination doesn't match (sha256 %s, %d bytes)", got, cw.n)
	}
	return nil
}

type countWriter struct {
	w interface{ Write([]byte) (int, error) }
	n int64
}

func (c *countWriter) Write(b []byte) (int, error) {
	n, err := c.w.Write(b)
	c.n += int64(n)
	return n, err
}

// quiesced runs inside under a backup drain, bounded by QuiesceTimeoutMs, always resuming.
func (r *Runner) quiesced(ctx context.Context, id, scope, underDrain string, q *manifest.Quiesce, inside func() error) error {
	c := r.Cfg
	if underDrain != "" {
		if r.Runtime == nil {
			return fail("quiesce", nil, "no runtime admin client")
		}
		h, err := r.Runtime.Health(ctx)
		if err != nil {
			return fail("quiesce", err, "can't confirm the caller's drain: %v", err)
		}
		if !h.Draining {
			return fail("quiesce", nil, "the runtime is not draining: the caller's drain %s is not active, so no checkpoint was taken", underDrain)
		}
		t := time.Now()
		err = inside()
		q.HeldMs = time.Since(t).Milliseconds()
		if h2, herr := r.Runtime.Health(context.Background()); herr == nil && !h2.Draining && err == nil {
			return fail("quiesce", nil, "the caller's drain %s ended while the checkpoint was being taken", underDrain)
		}
		return err
	}
	if r.Runtime == nil {
		if !c.AllowNoRuntime {
			return fail("quiesce", nil, "no runtime admin client")
		}
		q.Note = strings.TrimSpace(q.Note + " runtime not running (offline checkpoint): nothing to quiesce")
		t := time.Now()
		err := inside()
		q.HeldMs = time.Since(t).Milliseconds()
		return err
	}
	poll := r.Poll
	if poll == 0 {
		poll = 250 * time.Millisecond
	}
	timeout := time.Duration(c.QuiesceTimeoutMs) * time.Millisecond
	req := runtimeadmin.DrainRequest{RequestID: id, Reason: "backup", Scope: scope, LeaseMs: c.LeaseMs}
	t0 := time.Now()
	deadline := t0.Add(timeout)
	drained := false
	resume := func() {
		rctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := r.Runtime.Resume(rctx, id); err != nil {
			r.logf("resume %s: %v (the runtime resumes on its own when the %d ms lease expires)", id, err, c.LeaseMs)
		}
	}
	var last *runtimeadmin.DrainStatus
	var lastErr error
	for {
		st, err := r.Runtime.Drain(ctx, req)
		if err == nil {
			drained = true
			last = st
			if st.Safe {
				break
			}
		} else {
			lastErr = err
		}
		if ctx.Err() != nil {
			if drained {
				resume()
			}
			return fail("quiesce", ctx.Err(), "cancelled while waiting for a safe moment")
		}
		if time.Now().After(deadline) {
			if drained {
				resume()
			}
			return fail("quiesce", lastErr, "%s", timeoutReason(timeout, last, lastErr))
		}
		time.Sleep(poll)
	}
	q.WaitMs = time.Since(t0).Milliseconds()
	safeAt := time.Now()
	// Renew the lease while inside (a slow copy must not lose the barrier; a crash must).
	stop := make(chan struct{})
	renewed := make(chan struct{})
	go func() {
		defer close(renewed)
		every := time.Duration(c.LeaseMs/3) * time.Millisecond
		if every < 50*time.Millisecond {
			every = 50 * time.Millisecond
		}
		tk := time.NewTicker(every)
		defer tk.Stop()
		for {
			select {
			case <-stop:
				return
			case <-tk.C:
				rctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				if _, err := r.Runtime.Drain(rctx, req); err != nil {
					r.logf("renew drain %s: %v", id, err)
				}
				cancel()
			}
		}
	}()
	err := inside()
	close(stop)
	<-renewed
	resume()
	q.HeldMs = time.Since(safeAt).Milliseconds()
	return err
}

func timeoutReason(timeout time.Duration, st *runtimeadmin.DrainStatus, err error) string {
	if st == nil {
		var be *runtimeadmin.BusyError
		if errors.As(err, &be) {
			return fmt.Sprintf("the runtime was busy with another maintenance step for %s (%s); nothing was stopped, the backup will retry", timeout, be.Detail)
		}
		return fmt.Sprintf("the runtime didn't answer the backup drain within %s (%v); nothing was stopped, the backup will retry", timeout, err)
	}
	var parts []string
	for i, b := range st.Blockers {
		if i == 3 {
			parts = append(parts, fmt.Sprintf("and %d more", len(st.Blockers)-3))
			break
		}
		parts = append(parts, fmt.Sprintf("%s %s (%s, since %s)", b.Kind, b.ID, b.Description, b.Since.UTC().Format(time.RFC3339)))
	}
	return fmt.Sprintf("couldn't reach a safe moment within %s: %s; nothing was stopped or cancelled, the backup will retry",
		timeout, strings.Join(parts, "; "))
}

// hostsBackup checks the hosts service's backup as the snapshot took it (the file that is uploaded) and records
// its hash and size, which bind it to the signed manifest (BK-34). The service writes hub.tar, one from before
// hub.tar.gz: the archive is the one written last (just now, for this checkpoint), and stale is the other name when
// it is left beside it (left out of the upload).
func hostsBackup(taken []snap.Taken) (h *manifest.Hosts, stale string, err error) {
	t := findTaken(taken, "hosts")
	if t == nil || t.Missing {
		return nil, "", errors.New(hosts.WhyMissing)
	}
	var name string
	var newest time.Time
	for _, n := range coverage.HostsBackupFiles {
		fi, err := os.Lstat(filepath.Join(t.Path, n))
		if err != nil || !fi.Mode().IsRegular() {
			continue
		}
		if name == "" || fi.ModTime().After(newest) {
			if name != "" {
				stale = filepath.Join(t.Path, name)
			}
			name, newest = n, fi.ModTime()
		} else {
			stale = filepath.Join(t.Path, n)
		}
	}
	if name == "" {
		return nil, "", errors.New(hosts.WhyMissing)
	}
	hb, err := restore.CheckHostsBackup(filepath.Join(t.Path, name))
	if err != nil {
		return nil, "", fmt.Errorf("%s (%v)", hosts.WhyUnusable, err)
	}
	path := manifest.HostsBackupTarPath
	if name == coverage.HostsBackupFile {
		path = manifest.HostsBackupPath
	}
	return &manifest.Hosts{Backup: manifest.File{Path: path, SHA256: hb.SHA256, Size: hb.Size}}, stale, nil
}

func withoutSource(t []snap.Taken, name string) []snap.Taken {
	out := t[:0:0]
	for _, x := range t {
		if x.Name != name {
			out = append(out, x)
		}
	}
	return out
}

// IncompleteStatus says in plain words what a checkpoint made with a gap lacks (nil when it is whole). Why the servers
// are missing is told in people's words (hosts.Plain); the technical text stays in the signed manifest and the log.
func IncompleteStatus(m *manifest.Manifest) *state.Incomplete {
	g := m.Incomplete
	if g == nil {
		return nil
	}
	out := &state.Incomplete{Attachments: g.MissingAttachments, Servers: g.Servers != ""}
	var parts []string
	switch {
	case g.MissingAttachments == 1:
		parts = append(parts, "1 attachment wasn’t on this Whombat any more, so the backup doesn’t have it.")
	case g.MissingAttachments > 1:
		parts = append(parts, fmt.Sprintf("%d attachments weren’t on this Whombat any more, so the backup doesn’t have them.", g.MissingAttachments))
	}
	if g.Servers != "" {
		parts = append(parts, hosts.Plain(g.Servers))
	}
	out.Reason = strings.Join(parts, " ")
	return out
}

func findTaken(t []snap.Taken, name string) *snap.Taken {
	for i := range t {
		if t[i].Name == name {
			return &t[i]
		}
	}
	return nil
}

func dbSize(ctx context.Context, dsn string) (int64, error) {
	s, err := pgtool.Export(ctx, dsn) // cheap: one read-only transaction
	if err != nil {
		return 0, err
	}
	defer s.Close()
	return s.DatabaseSize(ctx)
}

type inventory struct {
	staging  string
	sources  []manifest.Source
	repos    []gitinv.Repo
	excluded []string // absolute
}

func (in *inventory) excludeFile() string {
	var b strings.Builder
	for _, p := range in.excluded {
		if strings.ContainsAny(p, "\n\r") {
			continue // can't be expressed in an exclude file: kept (conservative)
		}
		b.WriteString(fsutil.EscapePattern(p) + "\n")
	}
	return b.String()
}

// inventory reads the snapshotted trees; also names more absolute paths in them to leave out of the upload.
func (r *Runner) inventory(ctx context.Context, staging string, taken []snap.Taken, also ...string) (*inventory, error) {
	in := &inventory{staging: staging}
	git := gitinv.Runner{Git: r.Cfg.Git, Map: func(abs string) string {
		for _, t := range taken {
			if abs == t.Source || strings.HasPrefix(abs, t.Source+"/") {
				return t.Path + strings.TrimPrefix(abs, t.Source)
			}
		}
		return abs
	}}
	ceiling := filepath.Join(staging, manifest.FilesDir)
	excluded := map[string]bool{}
	for _, p := range also {
		if p != "" {
			excluded[p] = true
		}
	}
	for _, t := range taken {
		for _, rel := range coverage.AlwaysExcluded[t.Name] {
			excluded[filepath.Join(t.Path, rel)] = true
		}
		if t.Name == "home" {
			for _, n := range coverage.HomeTransient {
				excluded[filepath.Join(t.Path, n)] = true
			}
		}
		if t.Name == "hermes" {
			for _, n := range coverage.HermesTransient {
				excluded[filepath.Join(t.Path, n)] = true
			}
			homes, _ := os.ReadDir(filepath.Join(t.Path, "profiles"))
			for _, h := range homes {
				for _, n := range coverage.HermesProfileTransient {
					excluded[filepath.Join(t.Path, "profiles", h.Name(), n)] = true
				}
			}
		}
	}
	for _, t := range taken {
		if t.Name != "workspaces" && t.Name != "home" && t.Name != "agent" {
			continue
		}
		found, err := gitinv.Discover(t.Path, func(abs string) bool { return excluded[abs] })
		if err != nil {
			return nil, err
		}
		for _, f := range found {
			rel, _ := filepath.Rel(staging, f.Dir)
			in.repos = append(in.repos, git.Inventory(ctx, f, filepath.ToSlash(rel), ceiling))
			if f.Kind == "bare" {
				continue
			}
			caches, err := git.CacheExcludes(ctx, f, ceiling, isCache)
			if err != nil {
				r.logf("cache scan %s: %v (nothing excluded there)", rel, err)
				continue
			}
			for _, p := range caches {
				excluded[p] = true
			}
		}
	}
	for p := range excluded {
		in.excluded = append(in.excluded, p)
	}
	sort.Strings(in.excluded)
	for _, t := range taken {
		files, dirs, bytes, _ := fsutil.Stats(t.Path, excluded)
		src := manifest.Source{Name: t.Name, OriginalPath: t.Source, SnapshotPath: manifest.FilesDir + "/" + t.Name,
			Files: files, Dirs: dirs, Bytes: bytes, Missing: t.Missing}
		for _, p := range in.excluded {
			if strings.HasPrefix(p, t.Path+"/") {
				if _, err := os.Lstat(p); err == nil {
					rel, _ := filepath.Rel(staging, p)
					src.Excluded = append(src.Excluded, filepath.ToSlash(rel))
				}
			}
		}
		in.sources = append(in.sources, src)
	}
	return in, nil
}

func isCache(abs string) bool {
	name := filepath.Base(abs)
	if coverage.IsCacheName(name) {
		return true
	}
	marker, ok := coverage.ConditionalCacheDirs[name]
	if !ok {
		return false
	}
	_, err := os.Lstat(filepath.Join(abs, filepath.FromSlash(marker)))
	return err == nil
}

func (r *Runner) references(pub ed25519.PublicKey, repoID string) manifest.References {
	refs := manifest.References{ResticRepositoryID: repoID, ManifestKey: manifest.EncodeKey(pub)}
	// Public identity facts written by provisioning (NX-06): management.pub, content.peerid (0644).
	dir := r.Cfg.IdentityPublic
	if dir == "" {
		dir = r.Cfg.Layout().Identity()
	}
	if b, err := os.ReadFile(filepath.Join(dir, "management.pub")); err == nil {
		sum := sha256.Sum256(bytes.TrimSpace(b))
		refs.ManagementKeyFingerprint = "sha256:" + hex.EncodeToString(sum[:])
	}
	if b, err := os.ReadFile(filepath.Join(dir, "content.peerid")); err == nil {
		refs.ContentPeerID = strings.TrimSpace(string(b))
	}
	if b, err := os.ReadFile(filepath.Join(dir, "recovery-authority.pub")); err == nil {
		sum := sha256.Sum256(bytes.TrimSpace(b))
		refs.RecoveryAuthorityFingerprint = "sha256:" + hex.EncodeToString(sum[:])
	}
	return refs
}
