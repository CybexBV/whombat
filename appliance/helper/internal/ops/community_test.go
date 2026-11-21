package ops

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/helper/pkg/proto"
	"github.com/CybexBV/whombat/appliance/helper/pkg/trust"
	"github.com/CybexBV/whombat/appliance/release-tools/devtuf"
	"github.com/CybexBV/whombat/contracts/go/release"
)

// community makes w's helper a community box's (UP-X27).
func (w *world) community() {
	w.h.cfg.Edition = EditionCommunity
}

func (w *world) withdraw(ids ...string) {
	w.t.Helper()
	for _, id := range ids {
		w.repo.RemoveTarget(trust.ReleaseTarget(id))
	}
	must(w.t, w.repo.Publish())
}

// A community box (Whombat HE-58, UP-X27): an activation needs no assignment, only the newest release of the helper's
// own verified view; an older release that is still forward is refused, and so is anything the pinned root doesn't sign.
func TestCommunityActivatesTheNewestWithoutAssignment(t *testing.T) {
	t.Parallel()
	w := newWorld(t)
	w.community()
	// rt-5-otherhost (26.06.0) is the newest: rt-2 is forward of rt-1 but not it, assignment or not.
	w.stageFiles("rt-2")
	if _, perr := w.do(proto.OpStageRuntime, "rt-2"); perr != nil {
		t.Fatal(perr)
	}
	if _, perr := w.do(proto.OpActivateRuntime, "rt-2"); code(perr) != proto.CodeNotAssigned {
		t.Fatalf("not the newest: %v", perr)
	}
	w.assign("rt-2") // a signed assignment means nothing here
	if _, perr := w.do(proto.OpActivateRuntime, "rt-2"); code(perr) != proto.CodeNotAssigned {
		t.Fatalf("not the newest, with an assignment: %v", perr)
	}
	os.Remove(w.cfg.AssignmentPath)
	// The newer ones withdrawn: rt-2 is the newest, activated with no assignment file at all.
	w.withdraw("rt-3", "rt-4-noboot", "rt-5-otherhost")
	if _, perr := w.do(proto.OpActivateRuntime, "rt-2"); perr != nil {
		t.Fatal(perr)
	}
	if got := w.fake.Readlink("profiles/whombat-runtime"); got != devtuf.FakeStorePath("whombat-runtime-1.1.0") {
		t.Fatalf("runtime profile %s", got)
	}
	// Again after a crash: the installed release itself.
	if res, perr := w.do(proto.OpActivateRuntime, "rt-2"); perr != nil || !res.AlreadyDone {
		t.Fatalf("idempotent: %+v %v", res, perr)
	}
	// The factory is older: refused (and by the forward check anyway).
	if _, perr := w.do(proto.OpActivateRuntime, "rt-1"); perr == nil {
		t.Fatal("moved back to rt-1")
	}
	st, err := loadState(w.cfg.StateDir)
	must(t, err)
	if st.MaxAssignmentSeq != 0 {
		t.Fatalf("assignment sequence touched: %d", st.MaxAssignmentSeq)
	}
	// A repository the pinned root doesn't sign, with a newer release: refused as on any box.
	evil, _ := devtuf.New(filepath.Join(t.TempDir(), "evil"), devtuf.Options{Now: func() time.Time { return w.clock }})
	evil.AddFakeRelease(devtuf.StandardRelease("rt-9", "26.05.1", "6.6.6"))
	evil.Publish()
	w.h.cfg.MirrorDir = evil.MetadataDir()
	if _, perr := w.do(proto.OpActivateRuntime, "rt-9"); code(perr) != proto.CodeVerificationFailed {
		t.Fatalf("forged mirror: %v", perr)
	}
}

// Migrations and host activations follow the same rule on a community box; a commercial box still needs its assignment.
func TestCommunityMigrateAndHost(t *testing.T) {
	t.Parallel()
	w := newWorld(t)
	w.withdraw("rt-3", "rt-4-noboot", "rt-5-otherhost")
	mig := devtuf.StandardRelease("rt-mig", "26.05.1", "2.0.0")
	mig.SchemaWrites, mig.SchemaReads = 12, release.IntRange{Min: 10, Max: 12}
	mig.ContractMigration = true
	must(t, w.add(mig))
	must(t, w.repo.Publish())
	w.stageFiles("rt-mig")
	if _, perr := w.do(proto.OpStageRuntime, "rt-mig"); perr != nil {
		t.Fatal(perr)
	}
	req := proto.Request{V: 1, Op: proto.OpMigrateRuntime, ReleaseID: "rt-mig"}
	// Commercial: the newest needs an assignment like any release.
	if _, perr, _ := w.h.Handle(context.Background(), req); code(perr) != proto.CodeNotAssigned {
		t.Fatalf("commercial migrate without an assignment: %v", perr)
	}
	w.community()
	res, perr, _ := w.h.Handle(context.Background(), req)
	if perr != nil || res.Schema.Exit != proto.SchemaExitCheckpointRequired {
		t.Fatalf("community migrate: %+v %v", res, perr)
	}
	// rt-2 is older than rt-mig: no migration to it.
	w.stageFiles("rt-2")
	w.do(proto.OpStageRuntime, "rt-2")
	if _, perr, _ := w.h.Handle(context.Background(), proto.Request{V: 1, Op: proto.OpMigrateRuntime, ReleaseID: "rt-2"}); code(perr) != proto.CodeNotAssigned {
		t.Fatalf("migrate to an older release: %v", perr)
	}
	// A host release becomes the newest: activated on reboot without an assignment.
	w.withdraw("rt-mig")
	must(t, w.add(devtuf.StandardRelease("rt-host", "26.05.2", "2.1.0")))
	must(t, w.repo.Publish())
	w.stageFiles("rt-host")
	if _, perr := w.do(proto.OpStageHost, "rt-host"); perr != nil {
		t.Fatal(perr)
	}
	res, perr = w.do(proto.OpActivateHostOnReboot, "rt-host")
	if perr != nil || !res.RebootPending {
		t.Fatalf("community host activation: %+v %v", res, perr)
	}
	w.fake.SimulateReboot()
	if _, perr := w.do(proto.OpBlessBoot, ""); perr != nil {
		t.Fatal(perr)
	}
}
