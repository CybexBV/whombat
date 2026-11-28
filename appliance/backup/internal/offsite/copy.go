package offsite

import (
	"context"
	"errors"
	"os"
	"sort"
	"time"

	"golang.org/x/sys/unix"

	"github.com/CybexBV/whombat/appliance/backup/internal/listing"
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
	// Copied are the checkpoints (ids) of the main place that the copy's own list showed at the last copy that worked:
	// what is in the bucket, never what was sent there once (a bucket emptied or pruned by hand shows as such).
	Copied []string `json:"copied,omitempty"`
	// Cleared are checkpoints this box's own clearing took out of the copy while the main place still had them (the two
	// places clear at different times): they aren't copied again. Kept while the main place still has them.
	Cleared []string `json:"cleared,omitempty"`
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
	mainCfg, err := source.Config(ctx)
	if err != nil {
		return nil, stepErr(StepMain, err)
	}
	copyCfg, err := target.Config(ctx)
	if err != nil {
		return nil, err
	}
	// The copy is never the main place under another address: its backups would count as copied, and clearing the
	// copy would clear the backups themselves.
	if copyCfg.ID == mainCfg.ID || copyCfg.ID == main.RepositoryID {
		return nil, stepErr(StepSame, errors.New("the second place is the main place's repository"))
	}
	all, err := source.Snapshots(ctx, manifest.TagProduct)
	if err != nil {
		return nil, stepErr(StepMain, err)
	}
	// Only this box's backups and those of the Whombats it was brought back from, as its backup list trusts them (their
	// signed manifests): another Whombat's backups in the same place are never copied, counted or cleared by this one.
	keys, err := listing.LoadKeys(c)
	if err != nil {
		return nil, err
	}
	snaps, err := listing.Trusted(ctx, c, source, all, keys)
	if err != nil {
		return nil, stepErr(StepMain, err)
	}
	sort.Slice(snaps, func(i, j int) bool { return snaps[i].Time.Before(snaps[j].Time) })
	// What is in the copy is read from the bucket itself every time: a bucket emptied, pruned or replaced by someone
	// else is copied into again, and the status never says more is there than the bucket's own list shows.
	there, err := target.Snapshots(ctx, manifest.TagProduct)
	if err != nil {
		return nil, err
	}
	inCopy := checkpointIDs(there)
	st.Head = headOf(c, inCopy)
	if len(snaps) == 0 {
		// Nothing of this box's at the main place yet: nothing to copy, so no copy is said to have worked, and the copy,
		// maybe the only one left, isn't cleared.
		st.Copied, st.Cleared, st.LastCopy = nil, nil, nil
		return &Result{}, nil
	}
	st.Cleared = stillAtMain(st.Cleared, snaps)
	pick := missing(snaps, inCopy, st.Cleared)
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
		inCopy = checkpointIDs(after)
		for _, sn := range pick {
			if !inCopy[sn.Tag(manifest.TagIDPrefix)] {
				return nil, stepErr(StepCopy, errors.New("not every backup arrived in the copy"))
			}
		}
		res.Copied, res.Newest = len(pick), pick[len(pick)-1].Tag(manifest.TagIDPrefix)
	}
	if st.Clearing == nil || now.Sub(st.Clearing.At) >= ClearEvery || now.Before(st.Clearing.At) {
		st.Clearing = clearCopy(ctx, c, target, forgetHosts(c, snaps), now)
		if !st.Clearing.OK {
			logf("offsite: clearing old copies failed: %s", st.Clearing.Error)
		} else {
			after, err := target.Snapshots(ctx, manifest.TagProduct)
			if err != nil {
				return nil, err
			}
			left := checkpointIDs(after)
			st.Cleared = stillAtMain(append(st.Cleared, gone(inCopy, left)...), snaps)
			inCopy = left
		}
	}
	// The status says what the bucket's list showed just now.
	var newest *restic.Snapshot
	st.Copied, newest = confirmed(snaps, inCopy, now)
	if res.Copied > 0 || st.LastCopy == nil {
		st.LastCopy = &Copied{At: now, Count: res.Copied}
	}
	st.LastCopy.CheckpointID, st.LastCopy.CheckpointAt = "", time.Time{}
	if newest != nil {
		st.LastCopy.CheckpointID, st.LastCopy.CheckpointAt = newest.Tag(manifest.TagIDPrefix), newest.Time.UTC()
	}
	st.Head = headOf(c, inCopy)
	return res, nil
}

// checkpointIDs are the checkpoints a list of snapshots holds.
func checkpointIDs(snaps []restic.Snapshot) map[string]bool {
	ids := map[string]bool{}
	for _, sn := range snaps {
		if id := sn.Tag(manifest.TagIDPrefix); id != "" {
			ids[id] = true
		}
	}
	return ids
}

// missing are the main place's checkpoints (oldest first) the copy doesn't hold and this box didn't clear from it.
func missing(main []restic.Snapshot, inCopy map[string]bool, cleared []string) []restic.Snapshot {
	var pick []restic.Snapshot
	for _, sn := range main {
		if id := sn.Tag(manifest.TagIDPrefix); id != "" && !inCopy[id] && !contains(cleared, id) {
			pick = append(pick, sn)
		}
	}
	return pick
}

// confirmed are the main place's checkpoints the copy holds, and the newest of them (one dated ahead of the clock, a
// forged one, doesn't stand for the newest).
func confirmed(main []restic.Snapshot, inCopy map[string]bool, now time.Time) ([]string, *restic.Snapshot) {
	var ids []string
	var newest *restic.Snapshot
	for i, sn := range main {
		id := sn.Tag(manifest.TagIDPrefix)
		if id == "" || !inCopy[id] {
			continue
		}
		ids = append(ids, id)
		if !sn.Time.After(now.Add(time.Hour)) && (newest == nil || !sn.Time.Before(newest.Time)) {
			newest = &main[i]
		}
	}
	return ids, newest
}

// gone are the checkpoints in before that aren't in after.
func gone(before, after map[string]bool) []string {
	var out []string
	for id := range before {
		if !after[id] {
			out = append(out, id)
		}
	}
	sort.Strings(out)
	return out
}

// stillAtMain keeps the ids the main place still has, once each (the list stays as short as the main place).
func stillAtMain(ids []string, main []restic.Snapshot) []string {
	at := checkpointIDs(main)
	var out []string
	for _, id := range ids {
		if at[id] && !contains(out, id) {
			out = append(out, id)
		}
	}
	return out
}

// forgetHosts are the machines whose snapshots clearing may touch in the copy: this box and the boxes it was brought
// back from, read from main, the main place's backups this box trusts. A bucket folder that another Whombat copies
// into too keeps that Whombat's backups.
func forgetHosts(c *state.Config, main []restic.Snapshot) []string {
	var hosts []string
	if c.ApplianceID != "" {
		hosts = append(hosts, c.ApplianceID)
	}
	for _, sn := range main {
		if sn.Hostname != "" && !contains(hosts, sn.Hostname) {
			hosts = append(hosts, sn.Hostname)
		}
	}
	sort.Strings(hosts)
	return hosts
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
// space limit is the main place's alone; the bucket's size is the person's bill there). Only the snapshots of hosts
// are touched; without a host to name nothing is cleared (it would be everyone's).
func clearCopy(ctx context.Context, c *state.Config, target restic.Repo, hosts []string, now time.Time) *Clearing {
	if len(hosts) == 0 {
		return &Clearing{At: now, OK: false, Error: "no machine name to clear by"}
	}
	p := state.LoadPolicy(c)
	if _, err := target.ForgetHosts(ctx, manifest.TagProduct, hosts, p.Keep.ForgetArgs()); err != nil {
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
