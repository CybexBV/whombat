package ops

import (
	"context"
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/helper/pkg/proto"
	"github.com/CybexBV/whombat/appliance/release-tools/devtuf"
)

// Regression for L-2 (W4-SEC part 2): the manager uid could switch the runtime back to the previous
// release with no assignment although release custody had withdrawn it (the reviewer's PoC).
func TestRollbackToWithdrawnReleaseRefused(t *testing.T) {
	t.Parallel()
	w := newWorld(t) // rt-1 is the factory release
	w.stageFiles("rt-2")
	if _, perr := w.do(proto.OpStageRuntime, "rt-2"); perr != nil {
		t.Fatal(perr)
	}
	w.assign("rt-2")
	if _, perr := w.do(proto.OpActivateRuntime, "rt-2"); perr != nil {
		t.Fatal(perr)
	}
	w.repo.RemoveTarget("releases/rt-1.json")
	must(t, w.repo.Publish())
	if _, perr := w.do(proto.OpRollbackRuntime, ""); code(perr) != proto.CodeRollbackRefused {
		t.Fatalf("rollback to a withdrawn release: %v", perr)
	}
	if _, perr := w.do(proto.OpRollbackRuntime, "rt-2"); code(perr) != proto.CodeRollbackRefused {
		t.Fatalf("rollback (from rt-2) to a withdrawn release: %v", perr)
	}
	if got := w.fake.Readlink("profiles/whombat-runtime"); got != devtuf.FakeStorePath("whombat-runtime-1.1.0") {
		t.Fatalf("profile %s", got)
	}
}

// L-2: once the activation is finished (outside the rollback window) the helper no longer moves back
// without an assignment, even to an approved release.
func TestRollbackOnlyUndoesUnfinishedActivation(t *testing.T) {
	t.Parallel()
	w := newWorld(t)
	w.stageFiles("rt-2")
	w.do(proto.OpStageRuntime, "rt-2")
	w.assign("rt-2")
	if _, perr := w.do(proto.OpActivateRuntime, "rt-2"); perr != nil {
		t.Fatal(perr)
	}
	w.clock = w.clock.Add(7 * time.Hour)
	if _, perr := w.do(proto.OpRollbackRuntime, ""); code(perr) != proto.CodeRollbackRefused {
		t.Fatalf("late rollback: %v", perr)
	}
}

// L-2, host: a recorded older host is re-activated without an assignment only while an activation is
// unfinished, or when it is the booted system (boot counting fell back).
func TestHostUndoOnlyWhileUnfinished(t *testing.T) {
	t.Parallel()
	w := newWorld(t)
	w.stageFiles("rt-3")
	w.do(proto.OpStageHost, "rt-3")
	w.assign("rt-3")
	if _, perr := w.do(proto.OpActivateHostOnReboot, "rt-3"); perr != nil {
		t.Fatal(perr)
	}
	w.fake.SimulateReboot()
	if _, perr := w.do(proto.OpBlessBoot, ""); perr != nil {
		t.Fatal(perr)
	}
	w.clock = w.clock.Add(7 * time.Hour)
	if _, perr := w.do(proto.OpActivateHostOnReboot, "rt-1"); code(perr) != proto.CodeRollbackRefused {
		t.Fatalf("finished activation undone without an assignment: %v", perr)
	}
	if _, perr := w.do(proto.OpActivateHostOnReboot, "rt-3"); perr != nil {
		t.Fatalf("aligning with the booted host refused: %v", perr)
	}
}

// Regression for M-2 (helper side): an assigned but older tuple is refused unless custody signed the
// downgrade.
func TestHelperRefusesDowngradeWithoutCustody(t *testing.T) {
	t.Parallel()
	w := newWorld(t)
	w.stageFiles("rt-3")
	w.do(proto.OpStageHost, "rt-3")
	w.assign("rt-3")
	if _, perr := w.do(proto.OpActivateHostOnReboot, "rt-3"); perr != nil {
		t.Fatal(perr)
	}
	w.fake.SimulateReboot()
	if _, perr := w.do(proto.OpBlessBoot, ""); perr != nil {
		t.Fatal(perr)
	}
	// rt-2 is older (host 26.05.1 < 26.05.2, runtime 1.1.0 < 1.2.0).
	w.stageFiles("rt-2")
	w.do(proto.OpStageHost, "rt-2")
	w.assign("rt-2")
	if _, perr := w.do(proto.OpActivateHostOnReboot, "rt-2"); code(perr) != proto.CodeDowngrade {
		t.Fatalf("downgrade: %v", perr)
	}
	back := devtuf.StandardRelease("rt-2b", "26.05.1", "1.1.0")
	back.AllowDowngradeFrom = []string{"rt-3"}
	must(t, w.add(back))
	must(t, w.repo.Publish())
	w.stageFiles("rt-2b")
	w.do(proto.OpStageHost, "rt-2b")
	w.assign("rt-2b")
	if _, perr := w.do(proto.OpActivateHostOnReboot, "rt-2b"); perr != nil {
		t.Fatalf("custody-signed downgrade refused: %v", perr)
	}
}

// M-3: the known-good manager comes from the helper's TUF-verified records (a store path), never from
// manager-writable state.
func TestKnownGoodManagerFromRecords(t *testing.T) {
	t.Parallel()
	w := newWorld(t)
	res, perr := w.do(proto.OpKnownGoodManager, "")
	if perr != nil || len(res.StorePaths) != 1 || res.StorePaths[0] != w.release("rt-1").Tuple.Manager.StorePath {
		t.Fatalf("known-good manager: %+v %v", res, perr)
	}
}

// Regression for L-5: after a factory reset the device is provisioned with a new identity; seed-factory
// must start from fresh records instead of refusing ("already seeded") or keeping the old sequence floor.
func TestSeedFactoryForNewIdentity(t *testing.T) {
	t.Parallel()
	w := newWorld(t) // seeded for dev-1
	st, _ := loadState(w.cfg.StateDir)
	st.MaxAssignmentSeq = 99
	must(t, saveState(w.cfg.StateDir, st))
	if err := w.h.SeedFactory(context.Background(), "rt-1"); err == nil {
		t.Fatal("re-seeding the same identity accepted")
	}
	cfg := w.cfg
	cfg.DeviceID = "dev-2"
	h2, err := New(cfg, w.fake)
	must(t, err)
	if err := h2.SeedFactory(context.Background(), "rt-1"); err != nil {
		t.Fatalf("seed for a new identity: %v", err)
	}
	st, _ = loadState(w.cfg.StateDir)
	if st.DeviceID != "dev-2" || st.MaxAssignmentSeq != 0 || st.Host.Current == nil {
		t.Fatalf("state after re-seed: %+v", st)
	}
}

// Regression for L-6: a FIFO in staging no longer blocks the helper (while it holds its mutex), and a
// symlinked manager-controlled directory is refused.
func TestStagingFIFOAndSymlinkedDirs(t *testing.T) {
	t.Parallel()
	w := newWorld(t)
	rel := w.release("rt-2")
	for _, a := range rel.Artifacts() {
		p := filepath.Join(w.cfg.StagingDir, a.SHA256())
		os.Remove(p)
		must(t, syscall.Mkfifo(p, 0o644))
	}
	done := make(chan *proto.Error, 1)
	go func() { _, perr := w.do(proto.OpStageRuntime, "rt-2"); done <- perr }()
	select {
	case perr := <-done:
		if perr == nil {
			t.Fatal("FIFO staged")
		}
	case <-time.After(10 * time.Second):
		t.Fatal("helper blocked on a FIFO in staging")
	}
	// The assignment through a symlinked directory is not read.
	real := filepath.Join(t.TempDir(), "real")
	must(t, os.MkdirAll(real, 0o755))
	w.assign("rt-2")
	b, _ := os.ReadFile(w.cfg.AssignmentPath)
	must(t, os.WriteFile(filepath.Join(real, "assignment.json"), b, 0o644))
	link := filepath.Join(t.TempDir(), "link")
	must(t, os.Symlink(real, link))
	w.h.cfg.AssignmentPath = filepath.Join(link, "assignment.json")
	if _, err := readSmall(w.h.cfg.AssignmentPath, 1024); err == nil {
		t.Fatal("assignment read through a symlinked directory")
	}
}

// I-1: the helper's time floor rises from verified timestamp metadata, so a clock set back far enough to
// make expired metadata look fresh is ignored.
func TestTimeFloorFromTimestamp(t *testing.T) {
	t.Parallel()
	w := newWorld(t)
	st, _ := loadState(w.cfg.StateDir)
	floor := time.Unix(st.TimeFloor, 0)
	if want := w.clock.Add(24*time.Hour - MaxTimestampLifetime); floor.Before(want.Add(-time.Minute)) {
		t.Fatalf("floor %v, want at least %v", floor, want)
	}
	// Clock moved far back: the reference time stays at the floor.
	w.clock = w.clock.Add(-400 * 24 * time.Hour)
	if got := w.h.refNow(st); got.Before(floor) {
		t.Fatalf("reference time %v before the floor %v", got, floor)
	}
}

// Regression for N-5 (re-review): a record without versions never skips the check: the helper refuses
// (UP-X25: no backfill from the installed release's tuple any more), a newer release too.
func TestForwardWithRecordsWithoutVersions(t *testing.T) {
	t.Parallel()
	w := newWorld(t)
	w.stageFiles("rt-3")
	w.do(proto.OpStageHost, "rt-3")
	w.assign("rt-3")
	if _, perr := w.do(proto.OpActivateHostOnReboot, "rt-3"); perr != nil {
		t.Fatal(perr)
	}
	w.fake.SimulateReboot()
	if _, perr := w.do(proto.OpBlessBoot, ""); perr != nil {
		t.Fatal(perr)
	}
	strip := func() {
		st, _ := loadState(w.cfg.StateDir)
		for _, a := range []*Activated{st.Host.Current, st.Host.Previous, st.Runtime.Current, st.Runtime.Previous} {
			if a != nil {
				a.Versions = nil
			}
		}
		must(t, saveState(w.cfg.StateDir, st))
	}
	strip()
	w.stageFiles("rt-2")
	w.do(proto.OpStageHost, "rt-2")
	w.assign("rt-2")
	if _, perr := w.do(proto.OpActivateHostOnReboot, "rt-2"); code(perr) != proto.CodeDowngrade {
		t.Fatalf("downgrade with an old record: %v", perr)
	}
	// A newer release, the installed one withdrawn: versions unknown → refused.
	strip()
	w.repo.RemoveTarget("releases/rt-3.json")
	must(t, w.repo.Publish())
	w.stageFiles("rt-5-otherhost")
	w.do(proto.OpStageHost, "rt-5-otherhost")
	w.assign("rt-5-otherhost")
	if _, perr := w.do(proto.OpActivateHostOnReboot, "rt-5-otherhost"); code(perr) != proto.CodeDowngrade {
		t.Fatalf("unknown installed versions: %v", perr)
	}
}
