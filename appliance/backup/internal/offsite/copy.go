package offsite

import (
	"context"
	"errors"
	"os"
	"sort"
	"time"

	"golang.org/x/sys/unix"

	"github.com/CybexBV/whombat/appliance/backup/internal/quarantine"
	"github.com/CybexBV/whombat/appliance/backup/internal/state"
	"github.com/CybexBV/whombat/appliance/backup/pkg/kit"
	"github.com/CybexBV/whombat/appliance/backup/pkg/manifest"
	"github.com/CybexBV/whombat/appliance/backup/pkg/restic"
)

// Status is <stateDir>/offsite-status.json: how copying to the second place went.
type Status struct {
	// Generation is the place's it belongs to: a new place starts afresh.
	Generation  int      `json:"generation"`
	LastAttempt *Attempt `json:"lastAttempt,omitempty"`
	LastCopy    *Copied  `json:"lastCopy,omitempty"`
	LastFailure *Failure `json:"lastFailure,omitempty"`
	// FailedAttempts since the last copy that worked.
	FailedAttempts int `json:"failedAttempts"`
	// Copied are the checkpoints (ids) of the main place that are in the copy, kept while the main place still has
	// them: a checkpoint the copy cleared earlier than the main place isn't copied again.
	Copied []string `json:"copied,omitempty"`
	// Head is the newest of this box's own checkpoints in the copy: a bring back from the copy alone checks it.
	Head     *kit.Head `json:"head,omitempty"`
	Clearing *Clearing `json:"clearing,omitempty"`
}

// Attempt is one try.
type Attempt struct {
	At time.Time `json:"at"`
	OK bool      `json:"ok"`
}

// Copied is the last copy that worked: when, and the newest backup in the copy after it.
type Copied struct {
	At           time.Time `json:"at"`
	CheckpointID string    `json:"checkpointId,omitempty"`
	CheckpointAt time.Time `json:"checkpointAt,omitzero"`
	// Count is how many backups that copy added.
	Count int `json:"count"`
}

// Failure is the last try that failed: the step and the person's sentence (Reasons).
type Failure struct {
	At     time.Time `json:"at"`
	Step   string    `json:"step"`
	Reason string    `json:"reason"`
}

// Clearing is the last time old backups were cleared in the copy.
type Clearing struct {
	At    time.Time `json:"at"`
	OK    bool      `json:"ok"`
	Error string    `json:"error,omitempty"`
}

// LoadStatus reads how copying went for the place p (empty for another place, or none yet).
func LoadStatus(c *state.Config, p *Place) *Status {
	var st Status
	if ok, err := readJSON(statusPath(c), &st); !ok || err != nil || p == nil || st.Generation != p.Generation {
		st = Status{}
	}
	if p != nil {
		st.Generation = p.Generation
	}
	return &st
}

func saveStatus(c *state.Config, st *Status) error { return state.WriteJSON(statusPath(c), st, 0o600) }

// Enqueue asks for a copy now ("Copy now", and right after a place is set): the unit's path unit starts it.
func Enqueue(c *state.Config) error {
	return state.WriteJSON(requestPath(c), map[string]time.Time{"at": time.Now().UTC()}, 0o600)
}

// AfterBackup asks for a copy right after a backup worked, unless the copy is failing (then it waits its backoff, and
// the 15-minute timer tries again).
func AfterBackup(c *state.Config) {
	p, err := Load(c)
	if err != nil || p == nil || LoadStatus(c, p).FailedAttempts > 0 {
		return
	}
	_ = Enqueue(c)
}

// Backoff is how long the copy waits after failures in a row: 15 minutes, doubled each time, at most 6 hours.
func Backoff(failed int) time.Duration {
	if failed <= 0 {
		return 0
	}
	d := 15 * time.Minute
	for i := 1; i < failed && d < 6*time.Hour; i++ {
		d *= 2
	}
	return min(d, 6*time.Hour)
}

// Due says whether the copy should run now, and why (the timer's run logs it).
func Due(c *state.Config, now time.Time) (bool, string) {
	p, err := Load(c)
	if err != nil || p == nil {
		return false, "no second place"
	}
	main, _ := state.LoadDestination(c)
	if main == nil {
		return false, "backups aren't set up"
	}
	if restoring(c) {
		return false, "a restore is going"
	}
	if _, err := os.Stat(requestPath(c)); err == nil {
		return true, "asked for"
	}
	st := LoadStatus(c, p)
	if st.LastAttempt == nil {
		return true, "the first copy"
	}
	if st.FailedAttempts > 0 {
		if wait := Backoff(st.FailedAttempts); now.Before(st.LastAttempt.At.Add(wait)) {
			return false, "waiting after a failure"
		}
		return true, "trying again"
	}
	// The newest backup at the main place (one made at a place used before isn't copied from there).
	last, _ := state.LastChain(c)
	if last != nil && last.Repository == main.Repository && !contains(st.Copied, last.ID) {
		return true, "a new backup"
	}
	return false, "up to date"
}

// restoring: a restore is going or waits for the person's answer (the box is being put back: nothing leaves it).
func restoring(c *state.Config) bool {
	if m, _ := quarantine.Load(c); m != nil {
		return true
	}
	st, _ := state.LoadStatus(c)
	return st != nil && st.Running != nil && st.Running.Op == "restore"
}

// ErrBusy: another copy is running.
var ErrBusy = errors.New("a copy to the second place is running already")

// ErrNotSet: no second place (or no backups to copy from).
var ErrNotSet = errors.New("no second place is set up")

type lock struct{ f *os.File }

func tryLock(c *state.Config) (*lock, error) {
	if err := os.MkdirAll(c.StateDir, 0o700); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(lockPath(c), os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		return nil, err
	}
	if err := unix.Flock(int(f.Fd()), unix.LOCK_EX|unix.LOCK_NB); err != nil {
		f.Close()
		return nil, ErrBusy
	}
	return &lock{f: f}, nil
}

func (l *lock) unlock() { _ = unix.Flock(int(l.f.Fd()), unix.LOCK_UN); _ = l.f.Close() }

// Running says whether a copy is running now (its lock is held).
func Running(c *state.Config) bool {
	l, err := tryLock(c)
	if err != nil {
		return errors.Is(err, ErrBusy)
	}
	l.unlock()
	return false
}

// ClearEvery is how often old backups are cleared in the copy at most.
const ClearEvery = 23 * time.Hour

// Result is what one copy did.
type Result struct {
	Copied int
	Newest string
}

// Copy copies the main place's checkpoints the copy doesn't have yet into it (`restic copy`), checks they arrived,
// and then, at most once a day, clears old ones in the copy by the person's keep windows. It holds a lock of its own,
// never the backup's run lock. A failure is recorded with its step and the person's sentence.
func Copy(ctx context.Context, c *state.Config, logf func(string, ...any)) (*Result, error) {
	if logf == nil {
		logf = func(string, ...any) {}
	}
	l, err := tryLock(c)
	if err != nil {
		return nil, err
	}
	defer l.unlock()
	_ = os.Remove(requestPath(c)) // taken: the path unit mustn't start the copy again for it
	p, err := Load(c)
	if err != nil {
		return nil, err
	}
	main, err := state.LoadDestination(c)
	if err != nil {
		return nil, err
	}
	if p == nil || main == nil {
		return nil, ErrNotSet
	}
	if restoring(c) {
		return &Result{}, nil
	}
	st := LoadStatus(c, p)
	now := time.Now().UTC()
	res, err := copyOnce(ctx, c, p, main, st, now, logf)
	st.LastAttempt = &Attempt{At: now, OK: err == nil}
	if err != nil {
		oe := classify(err, StepCopy)
		st.FailedAttempts++
		st.LastFailure = &Failure{At: now, Step: oe.Step, Reason: oe.Reason}
		logf("offsite: copy failed (%s): %v", oe.Step, err)
		_ = saveStatus(c, st)
		return nil, oe
	}
	st.FailedAttempts, st.LastFailure = 0, nil
	if err := saveStatus(c, st); err != nil {
		return nil, err
	}
	return res, nil
}

func copyOnce(ctx context.Context, c *state.Config, p *Place, main *state.Destination, st *Status, now time.Time,
	logf func(string, ...any)) (*Result, error) {
	source := c.Repo(main)
	unpin, err := c.PinSecrets(&source)
	if err != nil {
		return nil, err
	}
	defer unpin()
	target := Repo(c, p)
	target.PasswordFile = source.PasswordFile
	paired, done, err := target.Paired(source, c.StateDir)
	if err != nil {
		return nil, err
	}
	defer done()
	// The main place first: a failure to read it is said as the main place's.
	snaps, err := source.Snapshots(ctx, manifest.TagProduct)
	if err != nil {
		return nil, stepErr(StepMain, err)
	}
	there, err := target.Snapshots(ctx, manifest.TagProduct)
	if err != nil {
		return nil, err
	}
	have := map[string]bool{}
	for _, id := range st.Copied {
		have[id] = true
	}
	for _, sn := range there {
		if id := sn.Tag(manifest.TagIDPrefix); id != "" {
			have[id] = true
		}
	}
	sort.Slice(snaps, func(i, j int) bool { return snaps[i].Time.Before(snaps[j].Time) })
	var pick []restic.Snapshot
	for _, sn := range snaps {
		if id := sn.Tag(manifest.TagIDPrefix); id != "" && !have[id] {
			pick = append(pick, sn)
		}
	}
	res := &Result{}
	if len(pick) > 0 {
		ids := make([]string, len(pick))
		for i, sn := range pick {
			ids[i] = sn.ID
		}
		logf("offsite: copying %d backups to %s", len(pick), p.Display())
		if err := paired.CopyFrom(ctx, ids...); err != nil {
			return nil, err
		}
		after, err := target.Snapshots(ctx, manifest.TagProduct)
		if err != nil {
			return nil, err
		}
		arrived := map[string]bool{}
		for _, sn := range after {
			arrived[sn.Tag(manifest.TagIDPrefix)] = true
		}
		for _, sn := range pick {
			if !arrived[sn.Tag(manifest.TagIDPrefix)] {
				return nil, stepErr(StepCopy, errors.New("not every backup arrived in the copy"))
			}
			have[sn.Tag(manifest.TagIDPrefix)] = true
		}
		res.Copied, res.Newest = len(pick), pick[len(pick)-1].Tag(manifest.TagIDPrefix)
	}
	// What the copy has of the main place's backups now (only those the main place still has: the list stays short).
	st.Copied = st.Copied[:0]
	var newest *restic.Snapshot
	for i, sn := range snaps {
		id := sn.Tag(manifest.TagIDPrefix)
		if !have[id] {
			continue
		}
		st.Copied = append(st.Copied, id)
		// A backup dated ahead of the clock (a forged one) doesn't stand for the newest in the copy.
		if !sn.Time.After(now.Add(time.Hour)) {
			newest = &snaps[i]
		}
	}
	if res.Copied > 0 || st.LastCopy == nil {
		st.LastCopy = &Copied{At: now, Count: res.Copied}
	}
	if newest != nil {
		st.LastCopy.CheckpointID, st.LastCopy.CheckpointAt = newest.Tag(manifest.TagIDPrefix), newest.Time.UTC()
	}
	st.Head = headOf(c, have)
	if st.Clearing == nil || now.Sub(st.Clearing.At) >= ClearEvery || now.Before(st.Clearing.At) {
		st.Clearing = clearCopy(ctx, c, target, now)
		if !st.Clearing.OK {
			logf("offsite: clearing old copies failed: %s", st.Clearing.Error)
		}
	}
	return res, nil
}

// headOf is the newest of this box's own checkpoints that is in the copy (nil when none is).
func headOf(c *state.Config, have map[string]bool) *kit.Head {
	chain, _ := state.Chain(c)
	var h *kit.Head
	for _, e := range chain {
		if have[e.ID] && (h == nil || e.Seq > h.Seq) {
			h = &kit.Head{Seq: e.Seq, ManifestSHA256: e.ManifestSHA256, At: e.At}
		}
	}
	return h
}

// clearCopy applies the person's keep windows to the copy: it keeps what the main place keeps, by the same rule (the
// space limit is the main place's alone; the bucket's size is the person's bill there).
func clearCopy(ctx context.Context, c *state.Config, target restic.Repo, now time.Time) *Clearing {
	p := state.LoadPolicy(c)
	if _, err := target.Forget(ctx, manifest.TagProduct, p.Keep.ForgetArgs()); err != nil {
		return &Clearing{At: now, OK: false, Error: state.OneLine(err.Error(), 300)}
	}
	return &Clearing{At: now, OK: true}
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}
