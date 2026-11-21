package update_test

import (
	"strings"
	"testing"

	"github.com/CybexBV/whombat/appliance/manager/internal/testworld"
	"github.com/CybexBV/whombat/appliance/manager/internal/update"
	"github.com/CybexBV/whombat/appliance/release-tools/devtuf"
	"github.com/CybexBV/whombat/contracts/go/release"
)

// MG-45 (UP-B2, CT-135): a candidate whose own schema check answers exit 0 with the live schema's floors is judged by
// those floors. The case it is for: release custody steps back to an older runtime after an expand.

// schemaRelease is a runtime that reads only its own schema and reports its floors (Whombat since MD-12).
func schemaRelease(id, version string, schema, readers, writers int64) devtuf.FakeRelease {
	f := devtuf.StandardRelease(id, "26.05.1", version)
	f.SchemaWrites, f.SchemaReads, f.ReaderFloor, f.WriterFloor = schema, release.IntRange{Min: schema, Max: schema}, readers, writers
	return f
}

func publish(t *testing.T, w *testworld.World, fs ...devtuf.FakeRelease) {
	t.Helper()
	for _, f := range fs {
		if _, err := w.Repo.AddFakeRelease(f); err != nil {
			t.Fatal(err)
		}
	}
	if err := w.Repo.Publish(); err != nil {
		t.Fatal(err)
	}
}

func install(t *testing.T, w *testworld.World, id string) {
	t.Helper()
	mustOffer(t, w, id, update.DecisionStarted)
	w.Run(600, testworld.PhaseIs(update.Healthy, update.Failed, update.Quarantined, update.RolledBack))
	if st := w.State(); st.Phase != update.Healthy || st.Current.ReleaseID != id {
		t.Fatalf("install %s: phase %s current %s failure %+v", id, st.Phase, st.Current.ReleaseID, st.LastFailure)
	}
}

// The world after an expand: factory (schema 10) → rt-20 (schema 11, floors 10/10) → rt-21 (schema 12, whose expand
// keeps schema 11 able to read and write: floors 11/11). The database is at 12.
func afterExpand(t *testing.T, writers12 int64, contract bool) (*testworld.World, devtuf.FakeRelease) {
	w := testworld.New(t)
	s11 := schemaRelease("rt-20-schema-11", "2.1.0", 11, 10, 10)
	s12 := schemaRelease("rt-21-schema-12", "2.2.0", 12, 11, writers12)
	s12.ContractMigration = contract
	publish(t, w, s11, s12)
	install(t, w, s11.ID)
	install(t, w, s12.ID)
	if w.Helper.DBSchema() != 12 {
		t.Fatalf("schema %d", w.Helper.DBSchema())
	}
	return w, s11
}

// Custody takes the box back to the schema-11 runtime (a new release id, TUF-signed allowDowngradeFrom the installed
// release): its own check says newer_compatible, read-write; it activates without a migration or a checkpoint and is
// healthy on schema 12. The tuple-only check refused it (candidate_cannot_read_schema, schema_downgrade).
func TestCustodyRollbackAfterExpandActivates(t *testing.T) {
	t.Parallel()
	w, s11 := afterExpand(t, 11, false)
	refs, events := len(w.Checkpoints.Refs), len(w.Helper.Events())
	back := s11
	back.ID, back.AllowDowngradeFrom = "rt-22-custody-rollback", []string{"rt-21-schema-12"}
	publish(t, w, back)
	var plan *update.SchemaPlan
	w.Engine.OnTransition = func(st update.State) {
		if c := st.Candidate; c != nil && c.Schema != nil && plan == nil {
			plan = c.Schema
		}
	}
	install(t, w, back.ID)
	st := w.State()
	if plan == nil || plan.Verdict != "newer_compatible" || plan.NeedsMigration || plan.DatabaseVersion != 12 || plan.RollbackAccess != "read-write" ||
		plan.Target == nil || plan.Target.Version != 12 || plan.Target.Writers != 11 {
		t.Fatalf("plan %+v", plan)
	}
	if lu := st.LastUpdate; lu == nil || lu.Release != back.ID || lu.From != "rt-21-schema-12" {
		t.Fatalf("last update %+v", lu)
	}
	if w.Helper.DBSchema() != 12 || len(w.Checkpoints.Refs) != refs || w.RuntimeProfile() != devtuf.FakeStorePath("whombat-runtime-2.1.0") {
		t.Fatalf("schema %d checkpoints %v runtime %s", w.Helper.DBSchema(), w.Checkpoints.Refs, w.RuntimeProfile())
	}
	for _, e := range w.Helper.Events()[events:] {
		if strings.HasPrefix(e, "migrate ") {
			t.Fatalf("migrated: %s", e)
		}
	}
}

// Without release custody's permission the same release is refused as a downgrade before anything happens.
func TestCustodyRollbackWithoutPermissionRefused(t *testing.T) {
	t.Parallel()
	w, s11 := afterExpand(t, 11, false)
	back := s11
	back.ID = "rt-22-rollback-unsigned"
	publish(t, w, back)
	d, why, err := w.Offer(back.ID)
	if err != nil || d != update.DecisionRefused || !strings.Contains(why, "older") {
		t.Fatalf("offer: %v %q %v", d, why, err)
	}
	w.Run(50, testworld.PhaseIs(update.Healthy))
	if st := w.State(); st.Current.ReleaseID != "rt-21-schema-12" || st.Candidate != nil || w.Helper.DBSchema() != 12 {
		t.Fatalf("current %s candidate %+v schema %d", st.Current.ReleaseID, st.Candidate, w.Helper.DBSchema())
	}
}

// After a contract (schema 12's writers floor is 12: schema 11 may only read it) the older runtime's own check
// answers read-only: refused before anything changes, with the detail that says so; quarantined after the attempts.
func TestContractFlooredDatabaseRefusesOlderCandidate(t *testing.T) {
	t.Parallel()
	w, s11 := afterExpand(t, 12, true)
	back := s11
	back.ID, back.AllowDowngradeFrom = "rt-22-after-contract", []string{"rt-21-schema-12"}
	publish(t, w, back)
	mustOffer(t, w, back.ID, update.DecisionStarted)
	w.Run(100, testworld.PhaseIs(update.Failed))
	st := w.State()
	f := st.Candidate.Failure
	if f.Code != "schema_incompatible" || strings.Join(f.Reasons, ",") != "candidate_read_only" {
		t.Fatalf("failure %+v", f)
	}
	d := update.FailureDetail(st)
	if d == nil || d.Release != back.ID || d.Stage != update.Staged || d.Schema == nil || d.Schema.Database != 12 || d.Schema.Target != nil ||
		d.Schema.CandidateWrites != 11 || d.Schema.CandidateReads != (release.IntRange{Min: 11, Max: 11}) {
		t.Fatalf("detail %+v schema %+v", d, d.Schema)
	}
	w.Run(400, testworld.PhaseIs(update.Quarantined))
	st = w.State()
	if st.Current.ReleaseID != "rt-21-schema-12" || w.Helper.DBSchema() != 12 || w.RuntimeProfile() != devtuf.FakeStorePath("whombat-runtime-2.2.0") {
		t.Fatalf("current %s schema %d runtime %s", st.Current.ReleaseID, w.Helper.DBSchema(), w.RuntimeProfile())
	}
	if d := update.FailureDetail(st); d == nil || d.Release != back.ID || d.Code != "schema_incompatible" {
		t.Fatalf("quarantined detail %+v", d)
	}
}
