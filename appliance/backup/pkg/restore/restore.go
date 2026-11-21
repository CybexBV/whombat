// Package restore restores a checkpoint into a quarantine target and verifies it (BK-12): repository
// integrity (restic check), the authenticated manifest (signature by the trusted manifest key, bound to
// the snapshot's tag), restic's own read-back of every restored file, the dump's hash, row counts and
// schema version after loading into an empty database made read-only, attachment hashes and references,
// the runtime's audit-chain verifier, git fsck and every repository's unpushed commits and uncommitted and
// untracked files, and the hosts service's backup where the checkpoint has one. It measures the recovery
// time and the backup's age. Shared by the appliance's drills and the recovery/export tool.
package restore

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/CybexBV/whombat/appliance/backup/pkg/fsutil"
	"github.com/CybexBV/whombat/appliance/backup/pkg/gitinv"
	"github.com/CybexBV/whombat/appliance/backup/pkg/manifest"
	"github.com/CybexBV/whombat/appliance/backup/pkg/pgtool"
	"github.com/CybexBV/whombat/appliance/backup/pkg/restic"
)

// Options for one restore + verification.
type Options struct {
	Repo        restic.Repo
	Snapshot    string // snapshot id, or "" / "latest" for the newest checkpoint
	ManifestKey ed25519.PublicKey
	Root        string // empty directory to restore into
	// CheckData is how much restic check reads before the restore is trusted: CheckStructure, CheckWeekly,
	// CheckAll, or another --read-data-subset ("10%", "1/5").
	CheckData string
	// SkipCheck skips `restic check` (e.g. the caller ran it already).
	SkipCheck bool
	Bins      pgtool.Bins
	// DSN of an empty database to load into ("" skips the database steps). Admin makes it read-only.
	DSN   string
	Admin *pgtool.Admin
	// DBRole owns the restored objects ("" = the DSN's user; the appliance's runtime role when a
	// superuser restores onto a replacement).
	DBRole string
	Git    gitinv.Runner
	// AuditVerify is the runtime's audit-chain verifier (argv); it gets DATABASE_URL in its environment.
	// Nil = skipped (reported, never passed).
	AuditVerify []string
	AuditURL    string // DATABASE_URL for the verifier
	// ExpectHead is the newest checkpoint known to exist (from the recovery kit or the appliance's own
	// record); the chain check fails when the destination's newest authentic checkpoint is older or the
	// checkpoint at that sequence differs (withheld or forked history, I-2). Nil = not checked.
	ExpectHead *ExpectedHead
	// CacheDir is a restic cache for this run only (an empty directory the caller removes after): the index and the
	// trees are downloaded once for every step instead of once per restic call. Empty: no cache at all.
	CacheDir string
	// Manifests keeps manifests read from the repository (the box's verified-manifest cache), so a list doesn't
	// download each again; nil reads every one.
	Manifests ManifestCache
	// Trusted, when set, says which of the key's checkpoints (by manifest sha256) may be restored: an earlier
	// Whombat's key is trusted only up to the checkpoint brought back from it. The others count as unauthentic.
	Trusted func(manifestSHA256 string) bool
	Log     func(format string, a ...any)
	Now     func() time.Time
}

// Check levels for Options.CheckData.
const (
	// CheckStructure reads the index and every snapshot's trees, none of the data: enough before an app restore,
	// whose restic restore --verify reads back every file of the chosen checkpoint.
	CheckStructure = ""
	// CheckWeekly also reads a different 5% of the data each time: the weekly check.
	CheckWeekly = "5%"
	// CheckAll reads all of it (an export from the recovery tool, a test).
	CheckAll = "all"
)

// ManifestCache keeps checkpoint manifests and their signatures by the manifest's sha256 (the snapshot's mf: tag).
// What it returns is checked again before use: the bytes against the sha256, the signature against the trusted key.
type ManifestCache interface {
	Get(sha string) (manifest, sig []byte, ok bool)
	Put(sha string, manifest, sig []byte)
}

// Check is one verification step.
type Check struct {
	Name       string `json:"name"`
	OK         bool   `json:"ok"`
	Skipped    bool   `json:"skipped,omitempty"`
	Detail     string `json:"detail,omitempty"`
	DurationMs int64  `json:"durationMs"`
}

// Report is the outcome.
type Report struct {
	Snapshot         restic.Snapshot    `json:"snapshot"`
	Manifest         *manifest.Manifest `json:"-"`
	ManifestSHA256   string             `json:"manifestSha256"`
	CheckpointID     string             `json:"checkpointId"`
	Checks           []Check            `json:"checks"`
	Chain            ChainReport        `json:"chain"`
	StartedAt        time.Time          `json:"startedAt"`
	RTO              time.Duration      `json:"-"`
	RTOSeconds       float64            `json:"rtoSeconds"`
	BackupAgeSeconds float64            `json:"backupAgeSeconds"`
	OK               bool               `json:"ok"`
	// QuarantineDSN is set by drills that keep their quarantine (inspection, tests).
	QuarantineDSN string `json:"-"`
}

// ExpectedHead names a checkpoint that must be in the repository.
type ExpectedHead struct {
	Seq            int64
	ManifestSHA256 string
}

// ChainReport describes the checkpoint chain visible in the repository.
type ChainReport struct {
	Checkpoints   int      `json:"checkpoints"`
	Unauthentic   []string `json:"unauthentic,omitempty"` // snapshot ids tagged as checkpoints whose manifest doesn't verify
	Gaps          []string `json:"gaps,omitempty"`
	NewestSeq     int64    `json:"newestSeq"`
	FutureDated   []string `json:"futureDated,omitempty"`
	ForeignTagged []string `json:"foreignTagged,omitempty"` // snapshots without the checkpoint tag
	// Duplicates: several snapshots carry the same authentic manifest (a replay with other data is
	// caught by the data checks of the one restored).
	Duplicates []string `json:"duplicates,omitempty"`
	// ExpectedSeq is the newest checkpoint known from the kit/appliance (0 = unknown); Withheld is set
	// when the repository's newest authentic checkpoint is older or differs at that sequence.
	ExpectedSeq int64  `json:"expectedSeq,omitempty"`
	Withheld    string `json:"withheld,omitempty"`
}

// Failed lists failed check names.
func (r *Report) Failed() []string {
	var f []string
	for _, c := range r.Checks {
		if !c.OK && !c.Skipped {
			f = append(f, c.Name)
		}
	}
	return f
}

// Skipped lists skipped check names.
func (r *Report) Skipped() []string {
	var f []string
	for _, c := range r.Checks {
		if c.Skipped {
			f = append(f, c.Name)
		}
	}
	return f
}

type runner struct {
	o   Options
	rep *Report
}

func (x *runner) logf(format string, a ...any) {
	if x.o.Log != nil {
		x.o.Log(format, a...)
	}
}

func (x *runner) step(name string, fn func() (string, error)) bool {
	t := time.Now()
	detail, err := fn()
	c := Check{Name: name, OK: err == nil, Detail: detail, DurationMs: time.Since(t).Milliseconds()}
	if errors.Is(err, errSkipped) {
		c.OK, c.Skipped = false, true
	} else if err != nil {
		if detail != "" {
			c.Detail = detail + ": " + err.Error()
		} else {
			c.Detail = err.Error()
		}
	}
	x.rep.Checks = append(x.rep.Checks, c)
	status := "ok"
	if c.Skipped {
		status = "SKIPPED"
	} else if !c.OK {
		status = "FAILED"
	}
	x.logf("%-20s %-7s %s", name, status, c.Detail)
	return c.OK
}

var errSkipped = errors.New("skipped")

// Skip marks a check skipped with a reason.
func skip(reason string) (string, error) { return reason, errSkipped }

// ErrUnauthentic: the checkpoint's manifest doesn't verify against the trusted key.
var ErrUnauthentic = errors.New("checkpoint manifest is not authentic")

// ErrUnreadable: the snapshot's manifest or signature couldn't be read (the destination didn't answer): it may well
// verify on the next try. Errors with it also match ErrUnauthentic.
var ErrUnreadable = errors.New("checkpoint manifest could not be read")

// Authenticate reads and verifies a snapshot's manifest: signature by the trusted key, the snapshot's mf:
// tag equals the manifest hash, and the ck: tag equals the manifest id.
func Authenticate(ctx context.Context, repo restic.Repo, s restic.Snapshot, key ed25519.PublicKey) (*manifest.Manifest, string, error) {
	return AuthenticateCached(ctx, repo, s, key, nil)
}

// AuthenticateCached is Authenticate taking the manifest and signature from cache when it has them (checked the
// same way) and keeping what it reads there.
func AuthenticateCached(ctx context.Context, repo restic.Repo, s restic.Snapshot, key ed25519.PublicKey, cache ManifestCache) (*manifest.Manifest, string, error) {
	tag := s.Tag(manifest.TagMFPrefix)
	if cache != nil {
		if mb, sig, ok := cache.Get(tag); ok && manifest.SHA256(mb) == tag {
			return verifyRead(s, mb, sig, key)
		}
	}
	mb, err := repo.DumpBytes(ctx, s.ID, manifest.ManifestPath)
	if err != nil {
		return nil, "", fmt.Errorf("%w: no manifest in snapshot %s: %w", ErrUnauthentic, s.ShortID, unreadable(err))
	}
	sig, err := repo.DumpBytes(ctx, s.ID, manifest.SigPath)
	if err != nil {
		return nil, "", fmt.Errorf("%w: no signature in snapshot %s: %w", ErrUnauthentic, s.ShortID, unreadable(err))
	}
	if cache != nil && manifest.SHA256(mb) == tag {
		cache.Put(tag, mb, sig)
	}
	return verifyRead(s, mb, sig, key)
}

// unreadable marks a read error that may pass on a retry: anything but restic saying the file isn't in the snapshot.
func unreadable(err error) error {
	if strings.Contains(err.Error(), "not found in snapshot") {
		return err
	}
	return fmt.Errorf("%w: %v", ErrUnreadable, err)
}

func verifyRead(s restic.Snapshot, mb, sig []byte, key ed25519.PublicKey) (*manifest.Manifest, string, error) {
	m, err := manifest.Verify(mb, sig, key)
	if err != nil {
		return nil, "", fmt.Errorf("%w: snapshot %s: %v", ErrUnauthentic, s.ShortID, err)
	}
	sum := manifest.SHA256(mb)
	if s.Tag(manifest.TagMFPrefix) != sum {
		return nil, "", fmt.Errorf("%w: snapshot %s: tag mf:%s doesn't match the manifest (%s)", ErrUnauthentic, s.ShortID, s.Tag(manifest.TagMFPrefix), sum)
	}
	if s.Tag(manifest.TagIDPrefix) != m.ID {
		return nil, "", fmt.Errorf("%w: snapshot %s: tag ck:%s doesn't match manifest id %s", ErrUnauthentic, s.ShortID, s.Tag(manifest.TagIDPrefix), m.ID)
	}
	return m, sum, nil
}

// Checkpoints lists the repository's snapshots and authenticates each checkpoint manifest, newest last.
type Checkpoint struct {
	Snapshot restic.Snapshot
	Manifest *manifest.Manifest
	SHA256   string
}

// List authenticates every checkpoint-tagged snapshot and reports the chain.
func List(ctx context.Context, repo restic.Repo, key ed25519.PublicKey, now time.Time) ([]Checkpoint, ChainReport, error) {
	return ListCached(ctx, repo, key, now, nil)
}

// ListCached is List reading manifests through cache.
func ListCached(ctx context.Context, repo restic.Repo, key ed25519.PublicKey, now time.Time, cache ManifestCache) ([]Checkpoint, ChainReport, error) {
	all, err := repo.Snapshots(ctx, "")
	if err != nil {
		return nil, ChainReport{}, err
	}
	var cr ChainReport
	var cps []Checkpoint
	for _, s := range all {
		if !hasTag(s, manifest.TagProduct) {
			cr.ForeignTagged = append(cr.ForeignTagged, s.ShortID)
			continue
		}
		m, sum, err := AuthenticateCached(ctx, repo, s, key, cache)
		if err != nil {
			cr.Unauthentic = append(cr.Unauthentic, s.ShortID)
			continue
		}
		if s.Time.After(now.Add(10 * time.Minute)) {
			cr.FutureDated = append(cr.FutureDated, s.ShortID)
		}
		cps = append(cps, Checkpoint{Snapshot: s, Manifest: m, SHA256: sum})
	}
	sortCheckpoints(cps)
	cr.Checkpoints = len(cps)
	byID := map[string]Checkpoint{}
	for _, c := range cps {
		if prev, dup := byID[c.Manifest.ID]; dup {
			cr.Duplicates = append(cr.Duplicates, fmt.Sprintf("%s in %s and %s", c.Manifest.ID, prev.Snapshot.ShortID, c.Snapshot.ShortID))
		}
		byID[c.Manifest.ID] = c
	}
	for i, c := range cps {
		if i == len(cps)-1 {
			cr.NewestSeq = c.Manifest.Seq
		}
		p := c.Manifest.Previous
		if p == nil {
			continue
		}
		prev, ok := byID[p.ID]
		switch {
		case !ok:
			cr.Gaps = append(cr.Gaps, fmt.Sprintf("seq %d follows %s (seq %d), which is not in the repository", c.Manifest.Seq, p.ID, p.Seq))
		case prev.SHA256 != p.ManifestSHA256:
			cr.Gaps = append(cr.Gaps, fmt.Sprintf("seq %d names %s with a different manifest hash", c.Manifest.Seq, p.ID))
		}
	}
	return cps, cr, nil
}

// trustedOnly keeps the checkpoints trusted accepts; the others count as unauthentic, and the newest is the newest
// of those kept.
func trustedOnly(cps []Checkpoint, cr ChainReport, trusted func(string) bool) ([]Checkpoint, ChainReport) {
	var out []Checkpoint
	for _, c := range cps {
		if trusted(c.SHA256) {
			out = append(out, c)
		} else {
			cr.Unauthentic = append(cr.Unauthentic, c.Snapshot.ShortID)
		}
	}
	cr.Checkpoints, cr.NewestSeq = len(out), 0
	if len(out) > 0 {
		cr.NewestSeq = out[len(out)-1].Manifest.Seq
	}
	return out, cr
}

// checkHead is the newest-checkpoint check: the recorded head must be in the repository. Any checkpoint at its
// sequence with the recorded manifest will do; one at that sequence with another manifest, or none, is withheld.
func checkHead(cps []Checkpoint, newest int64, e *ExpectedHead) (detail, withheld string) {
	atSeq := false
	for _, c := range cps {
		if c.Manifest.Seq != e.Seq {
			continue
		}
		atSeq = true
		if e.ManifestSHA256 == "" || c.SHA256 == e.ManifestSHA256 {
			return fmt.Sprintf("newest %d, recorded %d (present, same manifest)", newest, e.Seq), ""
		}
	}
	if atSeq {
		return "", fmt.Sprintf("checkpoint seq %d differs from the recorded one", e.Seq)
	}
	return "", fmt.Sprintf("the destination's newest authentic checkpoint is seq %d, but seq %d was recorded: newer checkpoints are missing or withheld", newest, e.Seq)
}

// sortCheckpoints orders by sequence, then by when the checkpoint and its snapshot were made, then by snapshot id:
// the same order on every call, so "the newest" and the head check never depend on the order restic listed them in
// (two snapshots can carry one sequence: a copy, or a number reused before numbers were handed out ahead).
func sortCheckpoints(cps []Checkpoint) {
	sort.SliceStable(cps, func(i, j int) bool {
		a, b := cps[i], cps[j]
		switch {
		case a.Manifest.Seq != b.Manifest.Seq:
			return a.Manifest.Seq < b.Manifest.Seq
		case !a.Manifest.CreatedAt.Equal(b.Manifest.CreatedAt):
			return a.Manifest.CreatedAt.Before(b.Manifest.CreatedAt)
		case !a.Snapshot.Time.Equal(b.Snapshot.Time):
			return a.Snapshot.Time.Before(b.Snapshot.Time)
		}
		return a.Snapshot.ID < b.Snapshot.ID
	})
}

func hasTag(s restic.Snapshot, t string) bool {
	for _, x := range s.Tags {
		if x == t {
			return true
		}
	}
	return false
}

// Run restores and verifies.
func Run(ctx context.Context, o Options) (*Report, error) {
	now := time.Now
	if o.Now != nil {
		now = o.Now
	}
	rep := &Report{StartedAt: now().UTC()}
	// Read what the destination holds, never the box's own cache of it (a drill must see what a recovery would):
	// at most a cache made for this run, filled from the destination by the run's own first reads.
	o.Repo.NoCache, o.Repo.CacheDir, o.Repo.CheckWithCache = true, "", false
	if o.CacheDir != "" {
		o.Repo.NoCache, o.Repo.CacheDir, o.Repo.CheckWithCache = false, o.CacheDir, true
	}
	x := &runner{o: o, rep: rep}
	start := time.Now()
	defer func() {
		rep.RTO = time.Since(start)
		rep.RTOSeconds = rep.RTO.Seconds()
		rep.OK = len(rep.Failed()) == 0
	}()

	// Repository integrity first: a damaged repository is reported even if the newest snapshot restores.
	if o.SkipCheck {
		x.step("restic-check", func() (string, error) { return skip("done separately") })
	} else {
		x.step("restic-check", func() (string, error) {
			_, err := o.Repo.Check(ctx, o.CheckData)
			lvl := o.CheckData
			if lvl == "" {
				lvl = "structure"
			}
			return "read-data: " + lvl, err
		})
	}

	cps, chain, err := ListCached(ctx, o.Repo, o.ManifestKey, now(), o.Manifests)
	if err == nil && o.Trusted != nil {
		cps, chain = trustedOnly(cps, chain, o.Trusted)
	}
	rep.Chain = chain
	if err != nil {
		x.step("manifest", func() (string, error) { return "", err })
		return rep, err
	}
	var cp *Checkpoint
	for i := range cps {
		c := &cps[i]
		if o.Snapshot == "" || o.Snapshot == "latest" {
			cp = c // sorted by seq: the last is the newest
		} else if strings.HasPrefix(c.Snapshot.ID, o.Snapshot) || c.Manifest.ID == o.Snapshot {
			cp = c
		}
	}
	if e := o.ExpectHead; e != nil && e.Seq > 0 {
		rep.Chain.ExpectedSeq = e.Seq
		x.step("newest-checkpoint", func() (string, error) {
			detail, withheld := checkHead(cps, chain.NewestSeq, e)
			if withheld != "" {
				rep.Chain.Withheld = withheld
				return "", errors.New(withheld)
			}
			return detail, nil
		})
	}
	ok := x.step("manifest", func() (string, error) {
		if cp == nil {
			if o.Snapshot != "" && o.Snapshot != "latest" {
				// maybe the requested snapshot exists but is unauthentic
				return "", fmt.Errorf("%w: no authentic checkpoint %q (unauthentic snapshots: %v)", ErrUnauthentic, o.Snapshot, chain.Unauthentic)
			}
			return "", fmt.Errorf("no authentic checkpoint in the repository (unauthentic snapshots: %v)", chain.Unauthentic)
		}
		d := fmt.Sprintf("checkpoint %s seq %d, snapshot %s, signed by the trusted manifest key", cp.Manifest.ID, cp.Manifest.Seq, cp.Snapshot.ShortID)
		if len(chain.Unauthentic) > 0 {
			d += fmt.Sprintf("; %d unauthentic snapshot(s) ignored: %v", len(chain.Unauthentic), chain.Unauthentic)
		}
		if len(chain.Gaps) > 0 {
			d += fmt.Sprintf("; chain gaps: %v", chain.Gaps)
		}
		return d, nil
	})
	if !ok {
		return rep, ErrUnauthentic
	}
	rep.Snapshot, rep.Manifest, rep.ManifestSHA256, rep.CheckpointID = cp.Snapshot, cp.Manifest, cp.SHA256, cp.Manifest.ID
	rep.BackupAgeSeconds = rep.StartedAt.Sub(cp.Manifest.CreatedAt).Seconds()
	m := cp.Manifest

	ok = x.step("restore", func() (string, error) {
		if err := os.MkdirAll(o.Root, 0o700); err != nil {
			return "", err
		}
		if ents, _ := os.ReadDir(o.Root); len(ents) > 0 {
			return "", fmt.Errorf("restore target %s is not empty", o.Root)
		}
		return "restic restore --verify into " + o.Root, o.Repo.Restore(ctx, cp.Snapshot.ID, o.Root, true)
	})
	if !ok {
		return rep, errors.New("restore failed")
	}
	dump := filepath.Join(o.Root, filepath.FromSlash(manifest.DumpPath))
	x.step("dump-hash", func() (string, error) {
		sum, size, err := fsutil.SHA256File(dump)
		if err != nil {
			return "", err
		}
		if sum != m.Database.Dump.SHA256 || size != m.Database.Dump.Size {
			return "", fmt.Errorf("dump sha256 %s size %d, manifest %s size %d", sum, size, m.Database.Dump.SHA256, m.Database.Dump.Size)
		}
		n, err := pgtool.ListDump(ctx, o.Bins, dump)
		return fmt.Sprintf("%d bytes, %d archive entries", size, n), err
	})

	var restoredFacts *pgtool.Facts
	if o.DSN == "" {
		x.step("database", func() (string, error) { return skip("no quarantine database given") })
	} else {
		ok := x.step("database", func() (string, error) {
			// Quarantine first (M-1): read-only for every new session and no session left that opened
			// before; only the restore itself writes (session override).
			if o.Admin != nil {
				if err := o.Admin.ReadOnly(ctx, dsnDB(o.DSN)); err != nil {
					return "", fmt.Errorf("make read-only: %w", err)
				}
				if _, err := o.Admin.TerminateOthers(ctx, dsnDB(o.DSN)); err != nil {
					return "", fmt.Errorf("end existing sessions: %w", err)
				}
			}
			if err := pgtool.Restore(ctx, o.Bins, o.DSN, dump, o.DBRole); err != nil {
				return "", err
			}
			if o.Admin != nil {
				if _, err := o.Admin.TerminateOthers(ctx, dsnDB(o.DSN)); err != nil {
					return "", fmt.Errorf("end existing sessions: %w", err)
				}
			}
			return "database made read-only (quarantine) and other sessions ended, then pg_restore into the empty database", nil
		})
		if ok {
			x.step("row-counts", func() (string, error) {
				f, err := pgtool.ReadFacts(ctx, o.DSN, "")
				if err != nil {
					return "", err
				}
				restoredFacts = f
				want := map[string]int64{}
				var total int64
				for _, t := range m.Database.Tables {
					want[t.Schema+"."+t.Name] = t.Rows
					total += t.Rows
				}
				var diffs []string
				got := map[string]bool{}
				for _, t := range f.Tables {
					k := t.Schema + "." + t.Name
					got[k] = true
					if w, ok := want[k]; !ok {
						diffs = append(diffs, k+": not in manifest")
					} else if w != t.Rows {
						diffs = append(diffs, fmt.Sprintf("%s: %d rows, manifest %d", k, t.Rows, w))
					}
				}
				for k := range want {
					if !got[k] {
						diffs = append(diffs, k+": missing")
					}
				}
				if f.SchemaVersion != m.Database.SchemaVersion {
					diffs = append(diffs, fmt.Sprintf("schema version %d, manifest %d", f.SchemaVersion, m.Database.SchemaVersion))
				}
				if len(diffs) > 0 {
					sort.Strings(diffs)
					return "", errors.New(strings.Join(diffs, "; "))
				}
				return fmt.Sprintf("%d tables, %d rows, schema version %d", len(f.Tables), total, f.SchemaVersion), nil
			})
		}
	}

	x.step("attachments", func() (string, error) { return verifyAttachments(o.Root, m, restoredFacts) })

	if m.Hermes != nil { // the Hermes homes (BK-36); a checkpoint from before them has no such check
		x.step("hermes", func() (string, error) { return verifyHermes(o.Root, m) })
	}
	if m.Hosts != nil { // the servers (BK-34); a checkpoint without them has no such check
		x.step("hosts", func() (string, error) { return verifyHosts(o.Root, m) })
	} else if m.Incomplete != nil && m.Incomplete.Servers != "" {
		x.step("hosts", func() (string, error) {
			return skip("the servers weren't in this backup: " + m.Incomplete.Servers)
		})
	}

	if len(o.AuditVerify) == 0 || o.DSN == "" {
		x.step("audit-chain", func() (string, error) {
			return skip("the runtime's audit verifier (audit:verify) is not configured here; the chain was not checked")
		})
	} else {
		x.step("audit-chain", func() (string, error) {
			cmd := exec.CommandContext(ctx, o.AuditVerify[0], o.AuditVerify[1:]...)
			cmd.Env = append(os.Environ(), "DATABASE_URL="+o.AuditURL, "WHOMBAT_QUARANTINE=1")
			out, err := cmd.CombinedOutput()
			tail := strings.TrimSpace(string(out))
			if len(tail) > 600 {
				tail = tail[len(tail)-600:]
			}
			return tail, err
		})
	}

	x.step("git", func() (string, error) { return verifyGit(ctx, o, m) })
	return rep, nil
}

func dsnDB(dsn string) string {
	for _, f := range strings.Fields(dsn) {
		if strings.HasPrefix(f, "dbname=") {
			return strings.Trim(strings.TrimPrefix(f, "dbname="), "'")
		}
	}
	if i := strings.LastIndex(dsn, "/"); i >= 0 {
		db := dsn[i+1:]
		if j := strings.Index(db, "?"); j >= 0 {
			db = db[:j]
		}
		return db
	}
	return ""
}

var shaName = regexp.MustCompile(`^[0-9a-f]{64}$`)

func verifyAttachments(root string, m *manifest.Manifest, facts *pgtool.Facts) (string, error) {
	filesDir := filepath.Join(root, manifest.FilesDir, "home", "files")
	blobs := 0
	var bad []string
	err := filepath.WalkDir(filepath.Join(filesDir, "sha256"), func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				return nil
			}
			return err
		}
		if !d.Type().IsRegular() || !shaName.MatchString(d.Name()) {
			return nil
		}
		blobs++
		sum, _, err := fsutil.SHA256File(p)
		if err != nil {
			return err
		}
		if sum != d.Name() {
			bad = append(bad, d.Name())
		}
		return nil
	})
	if err != nil {
		return "", err
	}
	if len(bad) > 0 {
		return "", fmt.Errorf("%d blob(s) don't match their sha256 (first %s)", len(bad), bad[0])
	}
	detail := fmt.Sprintf("%d blobs hash-checked", blobs)
	if facts == nil {
		return detail + "; references not checked (no database)", nil
	}
	if facts.ReferencedDigest() != m.Database.ReferencedDigest {
		return "", fmt.Errorf("the restored database references a different set of blobs than the manifest recorded")
	}
	var missing []string
	for _, k := range facts.Referenced {
		if _, err := os.Lstat(filepath.Join(filesDir, filepath.FromSlash(k))); err != nil {
			missing = append(missing, k)
		}
	}
	// Attachments the box itself no longer had when the checkpoint was made are recorded in its manifest: they are
	// a known gap of this backup, not a fault of it. Beyond the names it lists (at most MaxMissingKeys), as many
	// more as it counts may be missing.
	known, unnamed := 0, 0
	if g := m.Incomplete; g != nil && g.MissingAttachments > 0 {
		named := map[string]bool{}
		for _, k := range g.MissingAttachmentKeys {
			named[k] = true
		}
		var rest []string
		for _, k := range missing {
			if named[k] {
				known++
			} else {
				rest = append(rest, k)
			}
		}
		if extra := g.MissingAttachments - len(g.MissingAttachmentKeys); extra > 0 {
			unnamed = min(extra, len(rest))
			rest = rest[unnamed:]
		}
		missing = rest
	}
	if len(missing) > 0 {
		return "", fmt.Errorf("%d referenced blob(s) missing (first %s)", len(missing), missing[0])
	}
	if known+unnamed > 0 {
		return fmt.Sprintf("%s; %d referenced blobs present, %d already missing on the box when the backup was made (recorded)",
			detail, len(facts.Referenced)-known-unnamed, known+unnamed), nil
	}
	return fmt.Sprintf("%s; all %d referenced blobs present", detail, len(facts.Referenced)), nil
}

func verifyGit(ctx context.Context, o Options, m *manifest.Manifest) (string, error) {
	if len(m.Repos) == 0 {
		return "no repositories in the checkpoint", nil
	}
	// Relocate worktree and alternates paths from the appliance's layout to the restore root.
	var maps []gitinv.Mapping
	for _, s := range m.Sources {
		maps = append(maps, gitinv.Mapping{Old: s.OriginalPath, New: filepath.Join(o.Root, filepath.FromSlash(s.SnapshotPath))})
	}
	relocated, external, err := gitinv.Relocate(filepath.Join(o.Root, manifest.FilesDir), maps, o.Root)
	if err != nil {
		return "", fmt.Errorf("relocate: %w", err)
	}
	var problems []string
	for _, e := range external {
		problems = append(problems, "external reference (not followed): "+e)
	}
	ceiling := filepath.Join(o.Root, manifest.FilesDir)
	unpushed, dirty := 0, 0
	for _, want := range m.Repos {
		dir := filepath.Join(o.Root, filepath.FromSlash(want.Path))
		f := gitinv.Found{Dir: dir, Kind: want.Kind}
		if _, err := os.Stat(dir); err != nil {
			problems = append(problems, want.Path+": missing")
			continue
		}
		if want.Error != "" {
			// The checkpoint couldn't inventory it (recorded); still require an intact object store.
			if want.Kind != "worktree" {
				if err := o.Git.Fsck(ctx, f, ceiling); err != nil {
					problems = append(problems, want.Path+": fsck: "+err.Error())
				}
			}
			continue
		}
		if want.Kind != "worktree" {
			if err := o.Git.Fsck(ctx, f, ceiling); err != nil {
				problems = append(problems, want.Path+": fsck: "+err.Error())
				continue
			}
		}
		got := o.Git.Inventory(ctx, f, want.Path, ceiling)
		if got.Error != "" {
			problems = append(problems, want.Path+": "+got.Error)
			continue
		}
		if !sameRepo(want, got) {
			problems = append(problems, fmt.Sprintf("%s: differs from the checkpoint (head %s/%s, unpushed %d/%d, staged %d/%d, modified %d/%d, untracked %d/%d, refs equal %v)",
				want.Path, short(got.Head), short(want.Head), got.UnpushedCount, want.UnpushedCount, got.StagedCount, want.StagedCount,
				got.ModifiedCount, want.ModifiedCount, got.UntrackedCount, want.UntrackedCount, got.RefsDigest == want.RefsDigest))
			continue
		}
		unpushed += want.UnpushedCount
		dirty += want.ModifiedCount + want.UntrackedCount + want.StagedCount
	}
	detail := fmt.Sprintf("%d repositories: fsck clean, %d unpushed commits and %d uncommitted/untracked paths present as recorded (%d metadata paths relocated)",
		len(m.Repos), unpushed, dirty, relocated)
	if len(problems) > 0 {
		if len(problems) > 5 {
			problems = append(problems[:5], fmt.Sprintf("and %d more", len(problems)-5))
		}
		return "", errors.New(strings.Join(problems, "; "))
	}
	return detail, nil
}

func sameRepo(a, b gitinv.Repo) bool {
	a.Path, b.Path = "", ""
	return reflect.DeepEqual(a, b)
}

func short(s string) string {
	if len(s) > 8 {
		return s[:8]
	}
	return s
}

// SameBytes compares two files.
func SameBytes(a, b string) bool {
	x, err1 := os.ReadFile(a)
	y, err2 := os.ReadFile(b)
	return err1 == nil && err2 == nil && bytes.Equal(x, y)
}
