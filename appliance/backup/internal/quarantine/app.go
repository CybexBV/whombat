package quarantine

import (
	"bufio"
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"fmt"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"golang.org/x/sys/unix"

	"github.com/CybexBV/whombat/appliance/backup/internal/listing"
	"github.com/CybexBV/whombat/appliance/backup/internal/state"
	"github.com/CybexBV/whombat/appliance/backup/pkg/gitinv"
	"github.com/CybexBV/whombat/appliance/backup/pkg/manifest"
	"github.com/CybexBV/whombat/appliance/backup/pkg/pgtool"
	"github.com/CybexBV/whombat/appliance/backup/pkg/restic"
	"github.com/CybexBV/whombat/appliance/backup/pkg/restore"
)

// The app's restore (BK-39, Whombat backup-options.md BKO-11), run as root by whombat-backup-restore@<checkpoint>:
// everything that can refuse it is checked while the box still runs (the place, the backup and the key it is trusted
// by, a backup from a newer Whombat, the room), then the runtime stops, the fresh install is set aside, the checkpoint
// is checked and put in place, and the box stays in quarantine for the person's answers. Whatever fails after the
// runtime stopped is undone and the runtime starts again; restore-result.json says why in words for the person.

// Result is <stateDir>/restore-result.json: how the last restore from the app ended, read by the API while no marker
// says more.
type Result struct {
	At           time.Time `json:"at"`
	OK           bool      `json:"ok"`
	CheckpointID string    `json:"checkpointId"`
	// Reason is the kind of failure (one of the Reason* values), Error what the person reads, Detail what went wrong
	// in technical words (for support; the log has the whole report).
	Reason string `json:"reason,omitempty"`
	Error  string `json:"error,omitempty"`
	Detail string `json:"detail,omitempty"`
}

// Reasons a restore failed.
const (
	ReasonNoPlace     = "no_place"
	ReasonUnreachable = "unreachable"
	ReasonNotFound    = "not_found"
	ReasonNewer       = "newer"
	ReasonNoSpace     = "no_space"
	ReasonBusy        = "busy"
	ReasonInterrupted = "interrupted"
	ReasonMigration   = "migration"
	ReasonFailed      = "failed"
)

// ResultPath is restore-result.json.
func ResultPath(c *state.Config) string { return filepath.Join(c.StateDir, "restore-result.json") }

// LoadResult reads the last result (nil when there is none).
func LoadResult(c *state.Config) *Result {
	b, err := state.ReadStateFile(ResultPath(c))
	if err != nil {
		return nil
	}
	var r Result
	if json.Unmarshal(b, &r) != nil {
		return nil
	}
	return &r
}

// writeResult records how the restore ended. changed: the box was stopped and put back (a failure that isn't a
// refusal then says so).
func writeResult(c *state.Config, checkpoint string, err error, changed bool) {
	r := Result{At: time.Now().UTC(), OK: err == nil, CheckpointID: checkpoint}
	if err != nil {
		var re *Refusal
		switch {
		case errors.As(err, &re):
			r.Reason, r.Error = re.Reason, re.Msg
			if re.Detail != "" {
				r.Detail = state.OneLine(re.Detail, 500)
			}
		case changed:
			r.Reason, r.Detail = ReasonFailed, state.OneLine(err.Error(), 500)
			r.Error = "Bringing the backup back didn't work, so this Whombat was put back as it was. Try again."
		default:
			r.Reason, r.Detail = ReasonFailed, state.OneLine(err.Error(), 500)
			r.Error = "The backup couldn't be brought back, and nothing on this Whombat was changed. Try again."
		}
		r.Error = state.OneLine(r.Error, 500)
	}
	_ = state.WriteJSON(ResultPath(c), r, 0o644)
	_, _ = state.UpdateStatus(c, func(s *state.Status) {
		if s.Running != nil && s.Running.Op == "restore" {
			s.Running = nil
		}
	})
}

// Refusal is a restore that stopped for a reason the person can act on, in their words.
type Refusal struct {
	Reason string
	Msg    string
	Detail string // technical words, for support
}

func (e *Refusal) Error() string { return e.Msg }

func refuse(reason, format string, a ...any) *Refusal {
	return &Refusal{Reason: reason, Msg: fmt.Sprintf(format, a...)}
}

// Space is the room a restore can use.
type Space struct {
	Free      int64 // bytes free on /persist
	QuotaFree int64 // bytes left in Whombat's own share of /persist (-1: no share, or unknown)
}

// AppOptions for the app's restore.
type AppOptions struct {
	CheckpointID string
	// DB is the runtime's database, DBOwner its role, DSN it as a superuser; Admin the maintenance database.
	DB, DBOwner, DSN string
	Admin            *pgtool.Admin
	Bins             pgtool.Bins
	Git              gitinv.Runner
	// CheckData is the restic check before the restore: "" checks the repository's structure (restore --verify
	// proves the chosen checkpoint's data itself).
	CheckData string
	// ReleaseSchema is this release's database schema version (0: unknown): a backup with a newer one is refused.
	ReleaseSchema int
	// StopRuntime stops the runtime and waits until it is gone; StartRuntime starts it again.
	StopRuntime  func(context.Context) error
	StartRuntime func(context.Context)
	// Space measures the room (nil: /persist's filesystem and its btrfs qgroups).
	Space func(ctx context.Context) (Space, error)
	Log   func(format string, a ...any)
}

// AppRestore is the app's restore. It returns nil once the checkpoint is in place and the database is writable (the
// restore unit then brings the schema to this release's and calls End).
func AppRestore(ctx context.Context, c *state.Config, o AppOptions) (err error) {
	release, err := lockRestore(c)
	if err != nil {
		writeResult(c, o.CheckpointID, refuse(ReasonBusy, "Another restore is running on this Whombat."), false)
		return err
	}
	defer release()
	id := "restore-" + time.Now().UTC().Format("20060102T150405Z")
	stage := func(st string) {
		logf(o.Log, "restore: %s", st)
		_, _ = state.UpdateStatus(c, func(s *state.Status) {
			s.Running = &state.Running{ID: id, Op: "restore", Stage: st, Since: time.Now().UTC()}
		})
	}
	stage("prepare")
	// What a restore stopped by a crash or a power cut left behind is put back first.
	if err := Recover(ctx, c, o.Admin, o.Log); err != nil {
		writeResult(c, o.CheckpointID, err, false)
		return err
	}
	pf, err := preflight(ctx, c, o)
	if err != nil {
		writeResult(c, o.CheckpointID, err, false)
		return err
	}
	if err := o.StopRuntime(ctx); err != nil {
		err = fmt.Errorf("stop the runtime: %w", err)
		writeResult(c, o.CheckpointID, err, true)
		o.StartRuntime(ctx)
		return err
	}
	j, err := prepare(ctx, c, o.Admin, o.DB, o.DBOwner, &AppJournal{CheckpointID: o.CheckpointID, Stage: StageRestoring}, o.Log)
	if err != nil {
		writeResult(c, o.CheckpointID, err, true)
		o.StartRuntime(ctx)
		return err
	}
	failed := func(err error) error {
		if uerr := Undo(ctx, c, o.Admin, j); uerr != nil {
			logf(o.Log, "restore: putting the fresh install back: %v", uerr)
			err = &Refusal{Reason: ReasonFailed, Msg: "Bringing the backup back didn't work, and putting this Whombat back as it was didn't finish either. It tries again at its next start; ask for help if that doesn't fix it.",
				Detail: fmt.Sprintf("%v; undo: %v", err, uerr)}
		}
		writeResult(c, o.CheckpointID, err, true)
		o.StartRuntime(ctx)
		return err
	}
	stage("restore")
	_, rep, err := Apply(ctx, c, ApplyOptions{Repo: pf.repo, ManifestKey: pf.key, Snapshot: pf.entry.SnapshotID, DSN: o.DSN,
		Admin: o.Admin, DBRole: o.DBOwner, ExpectHead: pf.head, Bins: o.Bins, Git: o.Git, CheckData: o.CheckData,
		Adopted: !pf.entry.Own, Trusted: pf.known, AdoptedKnown: pf.adoptedKnown, Log: o.Log})
	if err != nil {
		if rep != nil {
			if b, jerr := json.Marshal(rep); jerr == nil {
				logf(o.Log, "restore report: %s", b)
			}
		}
		return failed(err)
	}
	stage("database")
	// The runtime runs in quarantine on a writable database: it serves the person's answers (enrolment, the
	// checklist) while the marker keeps automations and outbound work off (MR-20).
	if err := o.Admin.Writable(ctx, o.DB); err != nil {
		return failed(fmt.Errorf("make the database writable: %w", err))
	}
	j.App.Stage = StageRestored
	if err := j.save(); err != nil {
		return failed(err)
	}
	stage("start")
	writeResult(c, o.CheckpointID, nil, true)
	logf(o.Log, "restore: checkpoint %s is back; the fresh install is set aside in %s until the quarantine is released", o.CheckpointID, j.dir)
	return nil
}

type checked struct {
	repo  restic.Repo
	entry listing.Entry
	key   ed25519.PublicKey
	head  *restore.ExpectedHead
	known []string
	// adoptedKnown are the adopted Whombat's backups in the list (its bound when an earlier Whombat's backup comes back).
	adoptedKnown []string
}

// preflight checks what can refuse the restore while nothing has changed yet.
func preflight(ctx context.Context, c *state.Config, o AppOptions) (*checked, error) {
	d, err := state.LoadDestination(c)
	if err != nil {
		return nil, err
	}
	if d == nil {
		return nil, refuse(ReasonNoPlace, "This Whombat has no place for backups set up, so there is nothing to bring back from.")
	}
	if state.InRootMode() && d.Kind == state.KindLocal {
		return nil, refuse(ReasonNoPlace, "Backups on this Whombat's own disk can't be brought back from the app.")
	}
	keys, err := listing.LoadKeys(c)
	if err != nil {
		return nil, err
	}
	repo := c.Repo(d)
	list, err := listing.List(ctx, c, repo, keys)
	if err != nil {
		return nil, &Refusal{Reason: ReasonUnreachable, Msg: "Whombat can't reach the place where the backups are. Check that it is on, then try again.",
			Detail: err.Error()}
	}
	var e *listing.Entry
	for i := range list.Checkpoints {
		if list.Checkpoints[i].ID == o.CheckpointID {
			e = &list.Checkpoints[i]
			break
		}
	}
	if e == nil || e.Manifest == nil {
		return nil, refuse(ReasonNotFound, "That backup isn't in the place any more, or it can't be trusted.")
	}
	pf := &checked{repo: repo, entry: *e, key: keys.Own}
	if !e.Own {
		// The key that signed it: the adopted Whombat's, or one before it its kit carried (then that Whombat's own
		// bound stays, and the adopted Whombat is bounded at the backups it had, BK-79). The kit's head is the adopted
		// Whombat's.
		pf.key = e.Signer
		if keys.Adopted != nil && e.Signer.Equal(keys.Adopted) {
			pf.head = AdoptedHead(c)
		}
		for _, x := range list.Checkpoints {
			if x.Own || x.ManifestSHA256 == "" {
				continue
			}
			if x.Signer.Equal(e.Signer) && x.Seq <= e.Seq {
				pf.known = append(pf.known, x.ManifestSHA256)
			}
			if keys.Adopted != nil && x.Signer.Equal(keys.Adopted) {
				pf.adoptedKnown = append(pf.adoptedKnown, x.ManifestSHA256)
			}
		}
	}
	m := e.Manifest
	if o.ReleaseSchema > 0 && m.Database.SchemaVersion > o.ReleaseSchema {
		return nil, refuse(ReasonNewer, "This backup was made by a newer Whombat. Update this Whombat first, then try again.")
	}
	if err := checkRoom(ctx, c, o, m); err != nil {
		return nil, err
	}
	if exists, err := o.Admin.Exists(ctx, o.DB); err != nil {
		return nil, fmt.Errorf("the database can't be reached: %w", err)
	} else if !exists {
		logf(o.Log, "restore: there is no database %s yet: it is created", o.DB)
	}
	return pf, nil
}

// Need is the room a checkpoint takes while it is restored: on /persist its files and the dump (staged), and the
// database (about twice the dump), with the reserve kept free; in Whombat's own share, its files.
func Need(c *state.Config, m *manifest.Manifest) (disk, share int64) {
	var files int64
	for _, s := range m.Sources {
		files += s.Bytes
	}
	dump := m.Database.Dump.Size
	return files + 3*dump + c.ReserveBytes, files
}

func checkRoom(ctx context.Context, c *state.Config, o AppOptions, m *manifest.Manifest) error {
	measure := o.Space
	if measure == nil {
		measure = func(ctx context.Context) (Space, error) { return MeasureSpace(ctx, c.Persist) }
	}
	sp, err := measure(ctx)
	if err != nil {
		logf(o.Log, "restore: the free space couldn't be measured (%v): not checked", err)
		return nil
	}
	disk, share := Need(c, m)
	switch {
	case sp.Free < disk:
		return refuse(ReasonNoSpace, "There isn't enough room on this Whombat for this backup: it needs about %s and %s is free.",
			Bytes(disk), Bytes(sp.Free))
	case sp.QuotaFree >= 0 && sp.QuotaFree < share:
		return refuse(ReasonNoSpace, "There isn't enough room on this Whombat for this backup: it needs about %s and Whombat's share of the disk has %s left.",
			Bytes(share), Bytes(sp.QuotaFree))
	}
	return nil
}

// Bytes says a size in words.
func Bytes(n int64) string {
	switch {
	case n >= 1<<30:
		return strconv.FormatFloat(float64(n)/(1<<30), 'f', 1, 64) + " GB"
	case n >= 1<<20:
		return strconv.FormatInt(n>>20, 10) + " MB"
	default:
		return strconv.FormatInt(max(n>>10, 1), 10) + " KB"
	}
}

// MeasureSpace is the free space of the filesystem at persist and, on btrfs, what Whombat's limited qgroups (1/100,
// 2/100) have left; QuotaFree is -1 when neither has a limit or btrfs can't say.
func MeasureSpace(ctx context.Context, persist string) (Space, error) {
	var st unix.Statfs_t
	if err := unix.Statfs(persist, &st); err != nil {
		return Space{}, err
	}
	sp := Space{Free: int64(st.Bavail) * int64(st.Bsize), QuotaFree: -1}
	if st.Type != unix.BTRFS_SUPER_MAGIC {
		return sp, nil
	}
	cctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	out, err := exec.CommandContext(cctx, "btrfs", "qgroup", "show", "--raw", "-r", "-e", persist).Output()
	if err != nil {
		return sp, nil
	}
	sp.QuotaFree = QuotaLeft(out)
	return sp, nil
}

// QuotaLeft reads `btrfs qgroup show --raw -r -e`: the least room left in Whombat's qgroups that have a limit (-1:
// none has one).
func QuotaLeft(out []byte) int64 {
	left := int64(-1)
	sc := bufio.NewScanner(bytes.NewReader(out))
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) < 4 || (f[0] != "1/100" && f[0] != "2/100") {
			continue
		}
		rfer, err1 := strconv.ParseInt(f[1], 10, 64)
		limit, err2 := strconv.ParseInt(f[3], 10, 64)
		if err1 != nil || err2 != nil {
			continue
		}
		if n := max(limit-rfer, 0); left < 0 || n < left {
			left = n
		}
	}
	return left
}

// AdoptedHead is the newest checkpoint the adopted kit knew (written by the adopt, listing.Adopt): a restore of the
// adopted Whombat's backups checks that the destination doesn't withhold newer ones.
func AdoptedHead(c *state.Config) *restore.ExpectedHead {
	b, err := state.ReadStateFile(listing.HeadPath(c))
	if err != nil {
		return nil
	}
	var h restore.ExpectedHead
	if json.Unmarshal(b, &h) != nil || h.ManifestSHA256 == "" {
		return nil
	}
	return &h
}

// End is the restore unit's last step, after it brought the restored schema to this release's. failed "" ends the
// restore: the box stays in quarantine for the person's answers. Otherwise (ReasonNewer, ReasonMigration, …) the
// restore is undone and the reason recorded; the unit then starts the runtime.
func End(ctx context.Context, c *state.Config, admin *pgtool.Admin, checkpoint, failed, detail string) error {
	m, err := Load(c)
	if err != nil {
		return err
	}
	j := journalFor(c, m)
	if j == nil || j.App == nil {
		return errors.New("no restore from the app to end")
	}
	if failed == "" {
		j.App.Stage = StageDone
		return j.save()
	}
	var why *Refusal
	switch failed {
	case ReasonNewer:
		why = refuse(failed, "This backup was made by a newer Whombat. Update this Whombat first, then try again.")
	case ReasonMigration:
		why = refuse(failed, "The backup came back, but bringing it up to this Whombat's version didn't work, so this Whombat was put back as it was. Try again, or ask for help if it happens again.")
	default:
		why = refuse(ReasonFailed, "The backup came back, but this Whombat couldn't check it, so it was put back as it was. Try again.")
	}
	why.Detail = detail
	if err := Undo(ctx, c, admin, j); err != nil {
		writeResult(c, checkpoint, &Refusal{Reason: why.Reason, Msg: why.Msg + " Putting it back didn't finish either: it tries again at its next start.",
			Detail: fmt.Sprintf("%s; undo: %v", detail, err)}, true)
		return err
	}
	writeResult(c, checkpoint, why, true)
	return nil
}

// Recover, at every start of the runtime and after a release (whombat-backup restore-recover, root): a restore that
// a crash or a power cut stopped is undone, so the box starts as it was and the person can try again, and what a
// released restore set aside is removed. A running restore is left alone.
func Recover(ctx context.Context, c *state.Config, admin *pgtool.Admin, log func(string, ...any)) error {
	release, err := lockRestore(c)
	if errors.Is(err, ErrRestoring) {
		logf(log, "a restore is running: nothing to recover")
		return nil
	}
	if err != nil {
		return err
	}
	defer release()
	lock, err := waitRunLock(ctx, c, 2*time.Minute)
	if err != nil {
		return err
	}
	defer lock.Unlock()
	_ = state.RemoveStateFile(CleanupRequestPath(c))
	js, err := Journals(c)
	if err != nil {
		return err
	}
	m, err := Load(c)
	if err != nil {
		return err
	}
	rel := released(c)
	var errs []error
	for i, j := range js {
		newest := i == len(js)-1
		mine := m != nil && (m.SetAside == j.Stamp || (m.SetAside == "" && newest))
		switch {
		case rel[j.Stamp] && !mine:
			if err := Cleanup(ctx, admin, j); err != nil {
				errs = append(errs, err)
				continue
			}
			logf(log, "removed what the finished restore had set aside (%s)", j.dir)
		case !newest:
			logf(log, "%s belongs to an older restore that wasn't released: left as it is", j.dir)
		case m != nil && !mine:
			logf(log, "%s doesn't belong to the restore in quarantine: left as it is", j.dir)
		case interrupted(j, m):
			checkpoint := ""
			if j.App != nil {
				checkpoint = j.App.CheckpointID
			}
			if err := undo(ctx, c, admin, j); err != nil {
				errs = append(errs, err)
				// The person reads that it was cut, not the marker's technical words; the next start tries again.
				if j.App != nil {
					writeResult(c, checkpoint, &Refusal{Reason: ReasonInterrupted,
						Msg:    "This Whombat restarted before the restore finished, and putting it back as it was didn't finish either. It tries again at its next start; ask for help if that doesn't fix it.",
						Detail: err.Error()}, true)
				}
				continue
			}
			logf(log, "a restore that didn't finish was undone: this Whombat is back as it was (%s)", j.Stamp)
			if j.App != nil {
				writeResult(c, checkpoint, refuse(ReasonInterrupted,
					"This Whombat restarted before the restore finished, so it was put back as it was. Try again."), true)
			}
		}
	}
	// A status that still says a restore runs (it stopped with the box) says so no more.
	_, _ = state.UpdateStatus(c, func(s *state.Status) {
		if s.Running != nil && s.Running.Op == "restore" {
			s.Running = nil
		}
	})
	return errors.Join(errs...)
}

// interrupted says whether a journal's restore stopped before it finished: prepared but never applied, applied
// part-way, or (the app's) put in place but the restore unit's schema step never ended.
func interrupted(j *Journal, m *Marker) bool {
	switch {
	case m == nil, m.Phase == PhaseRestoring:
		return true
	case j.App != nil && j.App.Stage != StageDone:
		return true
	}
	return false
}
