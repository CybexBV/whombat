// Package outbox keeps update.progress reports for control durably until control accepted them (device-api
// CL-22; docs/decisions/startup-reporting.md SR-03…SR-07).
//
// The daemon records a report here synchronously when the journal persists a state, before anything is sent, so a
// report is never held only in memory. What is kept:
//
//   - Intermediate progress (Assigned … Verifying, same-state refreshes) is reconstructable from the journal: a later
//     report of the same release replaces it (coalesced to the latest state per release, as before).
//   - Terminal reports (Healthy, Failed, RolledBack, Quarantined, ForwardRepairRequired) are retained: each one is
//     kept until control accepted it, keyed by its identity (release, assignment sequence, state, attempt, failure);
//     only a newer report with the same identity replaces it.
//
// Every report carries the sequence number of the journal record it was built from: a report older than the newest
// one recorded for its release is stale and ignored, one identical to it is not queued again, and pending reports
// go out in journal order. Reconcile compares the journal's newest state with what was recorded, at start-up.
//
// The outbox is bounded (MaxEntries): intermediate reports are evicted first; a terminal report only when nothing
// else is left, and then counted and returned to the caller, never silently. An evicted report is forgotten as its
// release's newest one, so the same state is queued again. The file is written atomically; when a write fails the
// change stays in memory (still delivered), the failure is returned and Err reports it until a later write succeeds.
//
// The file is journal/progress-outbox-v2.json, the only one (MG-124: the copy for managers before SR-04 went).
package outbox

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"sort"
	"sync"

	"github.com/CybexBV/whombat/appliance/helper/pkg/atomicfile"
	"github.com/CybexBV/whombat/contracts/go/device"
	"github.com/CybexBV/whombat/contracts/go/release"
)

// MaxEntries is the number of pending reports kept (SR-06).
const MaxEntries = 64

// maxMarks is the number of releases whose newest recorded report is remembered.
const maxMarks = 32

// ErrNotDurable wraps a failed write: the change is kept in memory only until a later write succeeds.
var ErrNotDurable = errors.New("update.progress outbox not written")

// Entry is one pending report.
type Entry struct {
	Key    string `json:"key"` // release the report is about (candidate, else current)
	Serial int64  `json:"serial"`
	// Seq is the journal record the report was built from (0: unknown).
	Seq    uint64                       `json:"seq,omitempty"`
	Report device.UpdateProgressRequest `json:"report"`
}

// Terminal reports whether e is retained until control accepted it (SR-05).
func (e Entry) Terminal() bool { return Terminal(e.Report.State) }

// Terminal reports whether a report in state s ends a candidate's installation (or a part of it) and must reach
// control as such: Healthy, Failed, RolledBack, Quarantined, ForwardRepairRequired.
func Terminal(s release.UpdateJournalState) bool {
	switch s {
	case release.UpdateJournalStateHealthy, release.UpdateJournalStateFailed, release.UpdateJournalStateRolledBack,
		release.UpdateJournalStateQuarantined, release.UpdateJournalStateForwardRepairRequired:
		return true
	}
	return false
}

// sameTerminal: a and b report the same terminal outcome (a later one only refreshes the details).
func sameTerminal(a, b device.UpdateProgressRequest) bool {
	return a.State == b.State && a.Sequence == b.Sequence && a.Attempt == b.Attempt && deref(a.Failure) == deref(b.Failure) &&
		deref(a.Candidate) == deref(b.Candidate) && a.Current == b.Current
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// mark is the newest report recorded for a release.
type mark struct {
	Seq  uint64 `json:"seq"`
	Hash string `json:"hash"`
}

type file struct {
	V       int             `json:"v"` // 2
	Serial  int64           `json:"serial"`
	Entries []Entry         `json:"entries"`
	Last    map[string]mark `json:"last,omitempty"`
	// Dropped counts terminal reports evicted beyond MaxEntries (SR-06).
	Dropped int64 `json:"dropped,omitempty"`
}

// Outcome is what Put did with a report.
type Outcome string

// Put outcomes.
const (
	Recorded  Outcome = "recorded"  // queued for control
	Unchanged Outcome = "unchanged" // identical to the newest report recorded for its release: not queued again
	Stale     Outcome = "stale"     // older than the newest report recorded for its release: ignored
)

// PutResult is Put's result.
type PutResult struct {
	Outcome Outcome
	// Dropped are the reports evicted to stay within MaxEntries (a terminal one only when nothing else was left).
	Dropped []Entry
}

// Outbox is a file-backed outbox. Safe for concurrent use.
type Outbox struct {
	path string
	// WriteFile writes the file (tests inject failures); nil: atomicfile.WriteFile.
	WriteFile func(path string, data []byte, perm os.FileMode) error

	mu      sync.Mutex
	f       *file
	loadErr error
	err     error // the last write's failure: the in-memory state is not on disk
}

// Open opens (or starts) the outbox at path. It never fails: a file that cannot be read or parsed starts an empty
// outbox (LoadErr says why; the journal's newest state is reconciled into it at start-up).
func Open(path string) *Outbox {
	o := &Outbox{path: path}
	o.mu.Lock()
	o.load()
	o.mu.Unlock()
	return o
}

func (o *Outbox) load() {
	if o.f != nil {
		return
	}
	o.f = &file{V: 2}
	b, err := os.ReadFile(o.path)
	if errors.Is(err, os.ErrNotExist) {
		return
	}
	if err != nil {
		o.loadErr = fmt.Errorf("read %s: %w", o.path, err)
		return
	}
	var f file
	if err := json.Unmarshal(b, &f); err != nil {
		o.loadErr = fmt.Errorf("%s is corrupt (started empty): %w", o.path, err)
		return
	}
	f.V = 2
	o.f = &f
}

// LoadErr is the problem found when the file was opened (nil: read as written or absent).
func (o *Outbox) LoadErr() error { o.mu.Lock(); defer o.mu.Unlock(); return o.loadErr }

// Err is the last write's failure while it lasts (nil: everything recorded is on disk).
func (o *Outbox) Err() error { o.mu.Lock(); defer o.mu.Unlock(); return o.err }

// Dropped is the number of terminal reports evicted beyond MaxEntries so far.
func (o *Outbox) Dropped() int64 { o.mu.Lock(); defer o.mu.Unlock(); return o.f.Dropped }

func (o *Outbox) save() error {
	write := o.WriteFile
	if write == nil {
		write = atomicfile.WriteFile
	}
	b, err := json.Marshal(o.f)
	if err == nil {
		err = write(o.path, b, 0o600)
	}
	if err != nil {
		o.err = fmt.Errorf("%w: %w", ErrNotDurable, err)
		return o.err
	}
	o.err = nil
	return nil
}

// Sync writes the outbox again after a failed write (nil when nothing is pending on disk).
func (o *Outbox) Sync() error {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.err == nil {
		return nil
	}
	return o.save()
}

// Key returns the coalescing key of a report.
func Key(r device.UpdateProgressRequest) string {
	if r.Candidate != nil && *r.Candidate != "" {
		return *r.Candidate
	}
	return r.Current
}

// hash identifies a report's content; its time does not count.
func hash(r device.UpdateProgressRequest) string {
	r.At = 0
	b, _ := json.Marshal(r)
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:12])
}

// Put records r, built from journal record seq (0: unknown), unless it is stale or unchanged (see the package
// comment). A returned error wraps ErrNotDurable: the outbox (r included, if recorded) is in memory but not on disk.
func (o *Outbox) Put(r device.UpdateProgressRequest, seq uint64) (PutResult, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	res := o.put(r, seq)
	if res.Outcome != Recorded && o.err == nil {
		return res, nil // a newer mark stays in memory; Reconcile finds the same report by its content
	}
	return res, o.save()
}

func (o *Outbox) put(r device.UpdateProgressRequest, seq uint64) PutResult {
	f := o.f
	key, h := Key(r), hash(r)
	if f.Last == nil {
		f.Last = map[string]mark{}
	}
	last, known := f.Last[key]
	switch {
	case known && seq > 0 && seq < last.Seq:
		return PutResult{Outcome: Stale}
	case known && h == last.Hash:
		last.Seq = max(last.Seq, seq)
		f.Last[key] = last
		return PutResult{Outcome: Unchanged}
	}
	f.Serial++
	e := Entry{Key: key, Serial: f.Serial, Seq: seq, Report: r}
	kept := f.Entries[:0]
	for _, x := range f.Entries {
		// A later report of the release supersedes its intermediate progress and a copy of the same outcome.
		if x.Key == key && (!x.Terminal() || (e.Terminal() && sameTerminal(x.Report, r))) {
			continue
		}
		kept = append(kept, x)
	}
	f.Entries = append(kept, e)
	f.Last[key] = mark{Seq: max(seq, last.Seq), Hash: h}
	o.trimMarks()
	var res PutResult
	res.Outcome = Recorded
	for len(f.Entries) > MaxEntries {
		i := 0 // the oldest intermediate report, else the oldest terminal one
		for j, x := range f.Entries {
			if !x.Terminal() {
				i = j
				break
			}
		}
		x := f.Entries[i]
		if x.Terminal() {
			f.Dropped++
		}
		if m, ok := f.Last[x.Key]; ok && m.Hash == hash(x.Report) {
			// Not queued any more: the same state must not count as unchanged (at start-up neither).
			m.Hash = ""
			f.Last[x.Key] = m
		}
		res.Dropped = append(res.Dropped, x)
		f.Entries = append(f.Entries[:i], f.Entries[i+1:]...)
	}
	return res
}

// trimMarks forgets the oldest releases' marks beyond maxMarks (never one with a pending report).
func (o *Outbox) trimMarks() {
	f := o.f
	if len(f.Last) <= maxMarks {
		return
	}
	pending := map[string]bool{}
	for _, e := range f.Entries {
		pending[e.Key] = true
	}
	var keys []string
	for k := range f.Last {
		if !pending[k] {
			keys = append(keys, k)
		}
	}
	sort.Slice(keys, func(i, j int) bool { return f.Last[keys[i]].Seq < f.Last[keys[j]].Seq })
	for _, k := range keys {
		if len(f.Last) <= maxMarks {
			break
		}
		delete(f.Last, k)
	}
}

// Reconcile records the report of the journal's newest state (record seq) at start-up, before the journal moves
// on (SR-07): a state persisted just before a crash, whose report never reached the outbox, is queued now; one that
// was recorded is not queued again. If the outbox knows reports newer than the journal (the newest record was lost
// and the journal fell back to the one before), those reports are ordered before the journal's state.
func (o *Outbox) Reconcile(r device.UpdateProgressRequest, seq uint64) (PutResult, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	f := o.f
	for k, m := range f.Last {
		if m.Seq > seq {
			m.Seq = seq
			m.Hash = "" // the journal's own state is recorded again below
			f.Last[k] = m
		}
	}
	for i := range f.Entries {
		f.Entries[i].Seq = min(f.Entries[i].Seq, seq)
	}
	res := o.put(r, seq)
	if res.Outcome == Unchanged && o.err == nil {
		return res, nil
	}
	return res, o.save()
}

// Pending returns the pending reports in journal order (then in the order they were recorded).
func (o *Outbox) Pending() ([]Entry, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.pending(), nil
}

func (o *Outbox) pending() []Entry {
	out := append([]Entry(nil), o.f.Entries...)
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Seq != out[j].Seq {
			return out[i].Seq < out[j].Seq
		}
		return out[i].Serial < out[j].Serial
	})
	return out
}

// Done removes e (control accepted it) unless a newer report replaced it meanwhile. A returned error wraps
// ErrNotDurable: e is gone from memory but may be sent again after a restart (control takes a report twice).
func (o *Outbox) Done(e Entry) error {
	o.mu.Lock()
	defer o.mu.Unlock()
	kept := o.f.Entries[:0]
	found := false
	for _, x := range o.f.Entries {
		if x.Key == e.Key && x.Serial == e.Serial {
			found = true
			continue
		}
		kept = append(kept, x)
	}
	o.f.Entries = kept
	if !found && o.err == nil {
		return nil
	}
	return o.save()
}
