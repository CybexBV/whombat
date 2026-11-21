package outbox

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/CybexBV/whombat/contracts/go/device"
	"github.com/CybexBV/whombat/contracts/go/release"
)

func rep(cur, cand string, st release.UpdateJournalState) device.UpdateProgressRequest {
	r := device.UpdateProgressRequest{Current: cur, State: st, FailedChecks: []string{}, Sequence: 1}
	if cand != "" {
		r.Candidate = &cand
	}
	return r
}

func failed(cand string, attempt int64, code string) device.UpdateProgressRequest {
	r := rep("rt-1", cand, release.UpdateJournalStateFailed)
	r.Attempt, r.Failure = attempt, &code
	return r
}

func put(t *testing.T, o *Outbox, r device.UpdateProgressRequest, seq uint64, want Outcome) PutResult {
	t.Helper()
	res, err := o.Put(r, seq)
	if err != nil || res.Outcome != want {
		t.Fatalf("put %s/%s seq %d: %s %v, want %s", Key(r), r.State, seq, res.Outcome, err, want)
	}
	return res
}

// states lists the pending reports as key/state.
func states(t *testing.T, o *Outbox) string {
	t.Helper()
	pend, err := o.Pending()
	if err != nil {
		t.Fatal(err)
	}
	var s []string
	for _, e := range pend {
		s = append(s, e.Key+"/"+string(e.Report.State))
	}
	return strings.Join(s, " ")
}

func TestCoalesceAndPersist(t *testing.T) {
	p := filepath.Join(t.TempDir(), "outbox.json")
	o := Open(p)
	put(t, o, rep("rt-1", "rt-2", release.UpdateJournalStateDownloading), 1, Recorded)
	put(t, o, rep("rt-1", "rt-2", release.UpdateJournalStateVerifying), 2, Recorded)
	put(t, o, rep("rt-1", "rt-3", release.UpdateJournalStateAssigned), 3, Recorded)
	// A new process (manager restart) sees the same pending reports.
	pend, err := Open(p).Pending()
	if err != nil || len(pend) != 2 || pend[0].Report.State != release.UpdateJournalStateVerifying || pend[1].Key != "rt-3" {
		t.Fatalf("%+v %v", pend, err)
	}
	// A report superseded while it was being sent is not removed.
	first := pend[0]
	put(t, o, rep("rt-1", "rt-2", release.UpdateJournalStateHealthy), 4, Recorded)
	if err := o.Done(first); err != nil {
		t.Fatal(err)
	}
	if got := states(t, o); got != "rt-3/Assigned rt-2/Healthy" {
		t.Fatalf("superseded report lost: %s", got)
	}
	pend, _ = o.Pending()
	for _, e := range pend {
		if err := o.Done(e); err != nil {
			t.Fatal(err)
		}
	}
	if pend, _ := Open(p).Pending(); len(pend) != 0 {
		t.Fatalf("%+v", pend)
	}
}

// SR-05: a terminal report is kept until control accepted it; later reports of the release replace only its
// intermediate progress and copies of the same outcome.
func TestTerminalRetained(t *testing.T) {
	o := Open(filepath.Join(t.TempDir(), "outbox.json"))
	put(t, o, rep("rt-1", "rt-2", release.UpdateJournalStateVerifying), 1, Recorded)
	rb := rep("rt-1", "rt-2", release.UpdateJournalStateRolledBack)
	put(t, o, rb, 2, Recorded)
	if got := states(t, o); got != "rt-2/RolledBack" {
		t.Fatalf("the rollback did not supersede the intermediate report: %s", got)
	}
	// Control assigns rt-2 again (MG-56): its new progress queues behind the rollback, which stays.
	again := rep("rt-1", "rt-2", release.UpdateJournalStateStaged)
	again.Sequence = 2
	put(t, o, again, 3, Recorded)
	again.State = release.UpdateJournalStateActivating
	put(t, o, again, 4, Recorded)
	if got := states(t, o); got != "rt-2/RolledBack rt-2/Activating" {
		t.Fatalf("%s", got)
	}
	again.State = release.UpdateJournalStateHealthy
	put(t, o, again, 5, Recorded)
	if got := states(t, o); got != "rt-2/RolledBack rt-2/Healthy" {
		t.Fatalf("%s", got)
	}

	// The same failure again with other details replaces its copy; the next attempt's failure is another outcome.
	o = Open(filepath.Join(t.TempDir(), "outbox.json"))
	f1 := failed("rt-3", 1, "download_failed")
	put(t, o, f1, 1, Recorded)
	f1.FailedChecks = []string{"runtime"}
	put(t, o, f1, 2, Recorded)
	put(t, o, failed("rt-3", 2, "download_failed"), 3, Recorded)
	pend, _ := o.Pending()
	if len(pend) != 2 || pend[0].Report.Attempt != 1 || len(pend[0].Report.FailedChecks) != 1 || pend[1].Report.Attempt != 2 {
		t.Fatalf("%+v", pend)
	}
}

// SR-04: a report older than the newest one recorded for its release (two states persisted concurrently, their
// reports recorded in the other order) is ignored; pending reports go out in journal order.
func TestStaleIgnoredAndJournalOrder(t *testing.T) {
	o := Open(filepath.Join(t.TempDir(), "outbox.json"))
	put(t, o, rep("rt-1", "rt-2", release.UpdateJournalStateHealthy), 12, Recorded)
	put(t, o, rep("rt-1", "rt-2", release.UpdateJournalStateVerifying), 11, Stale)
	// Another release's older state is not stale: it is recorded and goes out first.
	put(t, o, rep("rt-1", "rt-9", release.UpdateJournalStateRolledBack), 10, Recorded)
	if got := states(t, o); got != "rt-9/RolledBack rt-2/Healthy" {
		t.Fatalf("%s", got)
	}
}

// SR-04: a report identical to the newest one recorded for its release (a lock taken while nothing else changed) is
// not queued again, also after control accepted it; its time does not count.
func TestUnchangedNotQueuedAgain(t *testing.T) {
	o := Open(filepath.Join(t.TempDir(), "outbox.json"))
	h := rep("rt-1", "", release.UpdateJournalStateHealthy)
	h.At = 100
	put(t, o, h, 1, Recorded)
	h.At = 200
	put(t, o, h, 2, Unchanged)
	pend, _ := o.Pending()
	if len(pend) != 1 {
		t.Fatalf("%+v", pend)
	}
	o.Done(pend[0])
	put(t, o, h, 3, Unchanged)
	if got := states(t, o); got != "" {
		t.Fatalf("an unchanged report was queued again: %s", got)
	}
	h.FailedChecks = []string{"database"}
	put(t, o, h, 4, Recorded)
}

// SR-06: the bound evicts intermediate progress first; a terminal report goes only when nothing else is left, and
// then it is counted and returned, never dropped silently.
func TestBoundKeepsTerminalReports(t *testing.T) {
	p := filepath.Join(t.TempDir(), "outbox.json")
	o := Open(p)
	seq := uint64(0)
	next := func() uint64 { seq++; return seq }
	for i := 0; i < 10; i++ {
		put(t, o, rep("rt-1", fmt.Sprintf("rt-i%d", i), release.UpdateJournalStateDownloading), next(), Recorded)
	}
	for i := 0; i < MaxEntries-10; i++ {
		put(t, o, failed(fmt.Sprintf("rt-t%d", i), 1, "download_failed"), next(), Recorded)
	}
	// Full. Each further terminal report evicts the oldest intermediate one.
	for i := 0; i < 10; i++ {
		res := put(t, o, failed(fmt.Sprintf("rt-u%d", i), 1, "no_space"), next(), Recorded)
		if len(res.Dropped) != 1 || res.Dropped[0].Terminal() || res.Dropped[0].Key != fmt.Sprintf("rt-i%d", i) {
			t.Fatalf("evicted %+v", res.Dropped)
		}
	}
	if o.Dropped() != 0 {
		t.Fatal(o.Dropped())
	}
	// Only terminal reports left: the oldest one goes, counted and returned.
	res := put(t, o, failed("rt-last", 1, "no_space"), next(), Recorded)
	if len(res.Dropped) != 1 || !res.Dropped[0].Terminal() || res.Dropped[0].Key != "rt-t0" || o.Dropped() != 1 {
		t.Fatalf("evicted %+v, dropped %d", res.Dropped, o.Dropped())
	}
	pend, _ := Open(p).Pending()
	if len(pend) != MaxEntries || pend[len(pend)-1].Key != "rt-last" {
		t.Fatalf("%d entries, last %+v", len(pend), pend[len(pend)-1])
	}
	for _, e := range pend {
		if !e.Terminal() {
			t.Fatalf("an intermediate report outlived a terminal one: %+v", e)
		}
	}
	if Open(p).Dropped() != 1 {
		t.Fatal("the eviction count is not kept")
	}
}

// SR-07: at start-up the journal's newest state is reconciled into the outbox.
func TestReconcile(t *testing.T) {
	healthy := rep("rt-1", "rt-2", release.UpdateJournalStateHealthy)

	// Recorded (and delivered) before the restart: not queued again.
	p := filepath.Join(t.TempDir(), "outbox.json")
	o := Open(p)
	put(t, o, healthy, 7, Recorded)
	pend, _ := o.Pending()
	o.Done(pend[0])
	if res, err := Open(p).Reconcile(healthy, 7); err != nil || res.Outcome != Unchanged {
		t.Fatalf("%+v %v", res, err)
	}
	// Persisted again unchanged (a lock) after the last write: the same report.
	if res, err := Open(p).Reconcile(healthy, 9); err != nil || res.Outcome != Unchanged {
		t.Fatalf("%+v %v", res, err)
	}

	// The manager died between the journal write and the outbox write: the state is queued now.
	p = filepath.Join(t.TempDir(), "outbox.json")
	o = Open(p)
	put(t, o, rep("rt-1", "rt-2", release.UpdateJournalStateVerifying), 6, Recorded)
	o = Open(p)
	if res, err := o.Reconcile(healthy, 7); err != nil || res.Outcome != Recorded {
		t.Fatalf("%+v %v", res, err)
	}
	if got := states(t, Open(p)); got != "rt-2/Healthy" {
		t.Fatalf("%s", got)
	}

	// The outbox is gone (or corrupt): the journal's state is queued.
	p = filepath.Join(t.TempDir(), "outbox.json")
	os.WriteFile(p, []byte("{not json"), 0o600)
	o = Open(p)
	if o.LoadErr() == nil {
		t.Fatal("a corrupt outbox went unnoticed")
	}
	if res, err := o.Reconcile(healthy, 7); err != nil || res.Outcome != Recorded || states(t, Open(p)) != "rt-2/Healthy" {
		t.Fatalf("%+v %v", res, err)
	}

	// The journal fell back to its previous record (the newest one was lost): the outbox's newer reports go first,
	// then the journal's state, which is recorded again although the outbox saw its release later.
	p = filepath.Join(t.TempDir(), "outbox.json")
	o = Open(p)
	put(t, o, rep("rt-1", "rt-2", release.UpdateJournalStateVerifying), 6, Recorded)
	put(t, o, healthy, 7, Recorded)
	o = Open(p)
	verifying := rep("rt-1", "rt-2", release.UpdateJournalStateVerifying)
	if res, err := o.Reconcile(verifying, 6); err != nil || res.Outcome != Recorded {
		t.Fatalf("%+v %v", res, err)
	}
	if got := states(t, o); got != "rt-2/Healthy rt-2/Verifying" {
		t.Fatalf("%s", got)
	}
}

// SR-08: a failed write is returned (never taken as recorded) and the report stays queued in memory; the next
// successful write puts everything on disk.
func TestWriteFailureKeepsReportsInMemory(t *testing.T) {
	p := filepath.Join(t.TempDir(), "outbox.json")
	o := Open(p)
	boom := errors.New("disk on fire")
	o.WriteFile = func(string, []byte, os.FileMode) error { return boom }
	res, err := o.Put(rep("rt-1", "rt-2", release.UpdateJournalStateRolledBack), 3)
	if !errors.Is(err, ErrNotDurable) || !errors.Is(err, boom) || res.Outcome != Recorded || !errors.Is(o.Err(), boom) {
		t.Fatalf("%+v %v %v", res, err, o.Err())
	}
	if got := states(t, o); got != "rt-2/RolledBack" {
		t.Fatalf("the report is not queued in memory: %s", got)
	}
	if got := states(t, Open(p)); got != "" {
		t.Fatalf("on disk although the write failed: %s", got)
	}
	// Unchanged and stale reports still try to write, and say so, while the outbox is behind.
	if _, err := o.Put(rep("rt-1", "rt-2", release.UpdateJournalStateRolledBack), 4); !errors.Is(err, ErrNotDurable) {
		t.Fatal(err)
	}
	if res, err := o.Put(rep("rt-1", "rt-2", release.UpdateJournalStateVerifying), 1); res.Outcome != Stale || !errors.Is(err, ErrNotDurable) {
		t.Fatal(res, err)
	}
	o.WriteFile = nil
	if err := o.Sync(); err != nil || o.Err() != nil {
		t.Fatal(err, o.Err())
	}
	if got := states(t, Open(p)); got != "rt-2/RolledBack" {
		t.Fatalf("%s", got)
	}
}

// SR-08 with a real permission failure: a read-only directory.
func TestReadOnlyDirectory(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root writes into read-only directories")
	}
	dir := t.TempDir()
	o := Open(filepath.Join(dir, "outbox.json"))
	os.Chmod(dir, 0o500)
	t.Cleanup(func() { os.Chmod(dir, 0o700) })
	if _, err := o.Put(rep("rt-1", "rt-2", release.UpdateJournalStateHealthy), 1); !errors.Is(err, ErrNotDurable) || !errors.Is(err, os.ErrPermission) {
		t.Fatal(err)
	}
	if got := states(t, o); got != "rt-2/Healthy" {
		t.Fatalf("%s", got)
	}
	os.Chmod(dir, 0o700)
	if err := o.Sync(); err != nil {
		t.Fatal(err)
	}
}

// SR-06: a report the bound evicts is no longer its release's newest recorded one: the same state is queued again
// once there is room, by a transition or by the start-up reconciliation (it used to count as unchanged for good).
func TestEvictedReportQueuedAgain(t *testing.T) {
	p := filepath.Join(t.TempDir(), "outbox.json")
	o := Open(p)
	for i := 0; i < MaxEntries; i++ {
		put(t, o, failed(fmt.Sprintf("rt-t%d", i), 1, "download_failed"), uint64(i+1), Recorded)
	}
	cur := rep("rt-1", "rt-new", release.UpdateJournalStateDownloading)
	if res := put(t, o, cur, 100, Recorded); len(res.Dropped) != 1 || res.Dropped[0].Key != "rt-new" {
		t.Fatalf("%+v", res.Dropped)
	}
	pend, _ := o.Pending()
	o.Done(pend[0])               // control took a report: room again
	put(t, o, cur, 101, Recorded) // the same state persisted again (a lock)
	if got := states(t, o); !strings.HasSuffix(got, "rt-new/Downloading") {
		t.Fatalf("%s", got)
	}

	// The same at start-up.
	p = filepath.Join(t.TempDir(), "outbox.json")
	o = Open(p)
	for i := 0; i < MaxEntries; i++ {
		put(t, o, failed(fmt.Sprintf("rt-t%d", i), 1, "download_failed"), uint64(i+1), Recorded)
	}
	put(t, o, cur, 100, Recorded)
	pend, _ = o.Pending()
	o.Done(pend[0])
	if res, err := Open(p).Reconcile(cur, 100); err != nil || res.Outcome != Recorded {
		t.Fatalf("%+v %v", res, err)
	}
	if got := states(t, Open(p)); !strings.HasSuffix(got, "rt-new/Downloading") {
		t.Fatalf("%s", got)
	}
}
