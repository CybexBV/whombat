package update_test

import (
	"errors"
	"strings"
	"testing"

	"github.com/CybexBV/whombat/appliance/manager/internal/runtimeapi"
	"github.com/CybexBV/whombat/appliance/manager/internal/testworld"
	"github.com/CybexBV/whombat/appliance/manager/internal/update"
)

// A box without a backup destination (backup/internal/checkpoint ErrUnprotected): any checkpoint request fails.
var errUnprotected = errors.New("no backup destination is configured: this appliance is unprotected")

func noCheckpointTaken(t *testing.T, w *testworld.World) {
	t.Helper()
	if len(w.Checkpoints.Refs) != 0 {
		t.Fatalf("checkpoints %v", w.Checkpoints.Refs)
	}
	for _, e := range w.Helper.Events() {
		if strings.HasPrefix(e, "migrate ") && !strings.Contains(e, `checkpoint=""`) {
			t.Fatalf("migration with a checkpoint: %s", e)
		}
	}
}

// MG-43, the production case (pve-20260928.4 → .5): a runtime that reads only its own schema migrates with an expand
// the installed runtime still reads and writes. It is judged by the schema it migrates to: migrated, activated and
// healthy on a box that can't take a checkpoint, and none was asked for.
func TestExpandWithFloorsMigratesWithoutCheckpoint(t *testing.T) {
	t.Parallel()
	w := testworld.New(t)
	w.Checkpoints.Fail = errUnprotected
	mustOffer(t, w, testworld.ExpandFloors, update.DecisionStarted)
	w.Run(400, func(st *update.State) bool {
		return st.Candidate != nil && st.Candidate.Schema != nil && st.Candidate.Schema.Checked
	})
	plan := w.State().Candidate.Schema
	if !plan.NeedsMigration || !plan.RollbackCompatible || plan.RollbackAccess != "read-write" || len(plan.NeedsCheckpoint) != 0 ||
		plan.Target == nil || plan.Target.Version != 11 || plan.Target.Writers != 10 {
		t.Fatalf("plan %+v target %+v", plan, plan.Target)
	}
	w.Run(400, testworld.PhaseIs(update.Healthy, update.Failed, update.Quarantined))
	st := w.State()
	if st.Phase != update.Healthy || st.Current.ReleaseID != testworld.ExpandFloors || w.Helper.DBSchema() != 11 {
		t.Fatalf("phase %s current %s schema %d", st.Phase, st.Current.ReleaseID, w.Helper.DBSchema())
	}
	noCheckpointTaken(t, w)
}

// The expand's candidate fails after migrating: the installed runtime runs read-write on the new schema (the floors
// recorded with it), the rollback is an ordinary one (not read-only), and no checkpoint was needed.
func TestExpandWithFloorsBadRollsBackReadWrite(t *testing.T) {
	t.Parallel()
	w := testworld.New(t)
	w.Checkpoints.Fail = errUnprotected
	mustOffer(t, w, testworld.ExpandFloorsBad, update.DecisionStarted)
	w.Run(400, testworld.PhaseIs(update.RolledBack))
	st := w.State()
	if lastFailure(st) != "unhealthy" || st.Candidate.Failure.KnownGoodAccess != "read-write" || st.Current.ReleaseID != testworld.Factory {
		t.Fatalf("failure %s %+v current %s", lastFailure(st), st.Candidate.Failure, st.Current.ReleaseID)
	}
	if w.Helper.DBSchema() != 11 {
		t.Fatalf("schema %d: the migration must have run and stay", w.Helper.DBSchema())
	}
	factoryRunning(t, w)
	h, _ := runtimeapi.New(w.P.AdminSock, "").Health(t.Context())
	if h.Status != "ok" || h.Checks.Migrations.Access != "read-write" || h.Checks.Migrations.SchemaVersion != 11 {
		t.Fatalf("known-good health %+v", h)
	}
	noCheckpointTaken(t, w)
}

// A contract migration the runtime names still needs a verified checkpoint; on a box without a backup destination the
// update waits with the explanation and nothing changes. Its floors say a rollback would run read-only.
func TestContractWithFloorsWaitsForCheckpoint(t *testing.T) {
	t.Parallel()
	w := testworld.New(t)
	w.Checkpoints.Fail = errUnprotected
	mustOffer(t, w, testworld.ContractFloors, update.DecisionStarted)
	w.Run(80, func(st *update.State) bool {
		return st.Phase == update.WaitingForSafeBoundary && st.Candidate.Deferral != nil && st.Candidate.Deferral.Waiting == "checkpoint" && !st.Candidate.Deferral.Draining
	})
	st := w.State()
	plan := st.Candidate.Schema
	if plan.RollbackAccess != "read-only" || plan.RollbackCompatible || strings.Join(plan.NeedsCheckpoint, ",") != "m0011" {
		t.Fatalf("plan %+v", plan)
	}
	ex := st.Candidate.Deferral.Explanation
	if !strings.Contains(ex, "verified checkpoint") || !strings.Contains(ex, "unprotected") || !strings.Contains(ex, "Nothing was changed") {
		t.Fatalf("explanation %q", ex)
	}
	if w.Helper.DBSchema() != 10 {
		t.Fatalf("schema %d", w.Helper.DBSchema())
	}
	factoryRunning(t, w)
	// A backup destination appears: the checkpoint is taken while quiesced and the migration uses it.
	w.Checkpoints.Fail = nil
	w.Run(400, testworld.PhaseIs(update.Healthy))
	if len(w.Checkpoints.Refs) != 1 || w.Helper.DBSchema() != 11 {
		t.Fatalf("checkpoints %v schema %d", w.Checkpoints.Refs, w.Helper.DBSchema())
	}
}

// A runtime from before MD-12 (no floors): today's tuple-only check against the pre-migration schema, which refuses
// a runtime that reads only its own schema — what production saw on 2026-09-28. Nothing changes; after the attempts
// the release is quarantined.
func TestNoFloorsKeepsTupleOnlyCheck(t *testing.T) {
	t.Parallel()
	w := testworld.New(t)
	mustOffer(t, w, testworld.NoFloors, update.DecisionStarted)
	w.Run(100, testworld.PhaseIs(update.Failed))
	if f := w.State().Candidate.Failure; f.Code != "schema_incompatible" || !strings.Contains(f.Message, "candidate_cannot_read_schema") {
		t.Fatalf("%+v", f)
	}
	w.Run(400, testworld.PhaseIs(update.Quarantined))
	if w.Helper.DBSchema() != 10 {
		t.Fatalf("schema %d", w.Helper.DBSchema())
	}
	factoryRunning(t, w)
}

// Floors past the installed runtime (nothing older reads the new schema) need a checkpoint although the runtime names
// no contract migration: the plan checkpoints the pending migrations.
func TestFloorsPastInstalledNeedCheckpoint(t *testing.T) {
	t.Parallel()
	w := testworld.New(t)
	w.Checkpoints.Fail = errUnprotected
	mustOffer(t, w, testworld.PastFloors, update.DecisionStarted)
	w.Run(80, func(st *update.State) bool {
		return st.Phase == update.WaitingForSafeBoundary && st.Candidate.Deferral != nil && st.Candidate.Deferral.Waiting == "checkpoint"
	})
	plan := w.State().Candidate.Schema
	if plan.RollbackAccess != "none" || strings.Join(plan.NeedsCheckpoint, ",") != "m0011" || w.Helper.DBSchema() != 10 {
		t.Fatalf("plan %+v schema %d", plan, w.Helper.DBSchema())
	}
	w.Checkpoints.Fail = nil
	w.Run(400, testworld.PhaseIs(update.Healthy))
	if len(w.Checkpoints.Refs) != 1 {
		t.Fatalf("checkpoints %v", w.Checkpoints.Refs)
	}
}

// A candidate whose own schema check refuses the database (a newer schema whose recorded floors are past it) is
// schema_incompatible; nothing is migrated.
func TestCandidateRefusedByItsSchemaCheck(t *testing.T) {
	t.Parallel()
	w := testworld.New(t)
	mustOffer(t, w, testworld.PastFloors, update.DecisionStarted)
	w.Run(400, testworld.PhaseIs(update.Healthy))
	mustOffer(t, w, testworld.Schema10, update.DecisionStarted)
	w.Run(100, testworld.PhaseIs(update.Failed))
	f := w.State().Candidate.Failure
	if f.Code != "schema_incompatible" || !strings.Contains(f.Message, "cannot run on this database (newer_incompatible)") {
		t.Fatalf("%+v", f)
	}
	if w.Helper.DBSchema() != 11 || w.RuntimeProfile() == "" {
		t.Fatalf("schema %d", w.Helper.DBSchema())
	}
}

// The known-good binary can't answer its schema check during a rollback: after the deadline the manager falls back to
// the floors the candidate reported (read-write for an expand), not to the tuples (which would say forward repair).
func TestKnownGoodCheckUnavailableFallsBackToFloors(t *testing.T) {
	t.Parallel()
	w := testworld.New(t)
	mustOffer(t, w, testworld.ExpandFloorsBad, update.DecisionStarted)
	w.Run(400, testworld.PhaseIs(update.Verifying))
	w.Helper.SetFail("schema-check", errors.New("schema-check: node exited"))
	w.Run(400, func(st *update.State) bool {
		return st.Candidate != nil && st.Candidate.Rollback != nil && st.Candidate.Rollback.SchemaDecided
	})
	st := w.State()
	if st.Phase == update.ForwardRepairRequired || st.Candidate.Rollback.KGAccess != "read-write" {
		t.Fatalf("phase %s rollback %+v", st.Phase, st.Candidate.Rollback)
	}
	w.Helper.SetFail("schema-check", nil)
	w.Run(400, testworld.PhaseIs(update.RolledBack))
	factoryRunning(t, w)
}
