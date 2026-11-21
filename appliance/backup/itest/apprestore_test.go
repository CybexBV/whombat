package itest

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/jackc/pgx/v5"

	"github.com/CybexBV/whombat/appliance/backup/internal/api"
	"github.com/CybexBV/whombat/appliance/backup/internal/checkpoint"
	"github.com/CybexBV/whombat/appliance/backup/internal/dest"
	"github.com/CybexBV/whombat/appliance/backup/internal/drill"
	"github.com/CybexBV/whombat/appliance/backup/internal/listing"
	"github.com/CybexBV/whombat/appliance/backup/internal/quarantine"
	"github.com/CybexBV/whombat/appliance/backup/internal/state"
	"github.com/CybexBV/whombat/appliance/backup/pkg/gitinv"
	"github.com/CybexBV/whombat/appliance/backup/pkg/pgtool"
)

// twoBoxes: box A backs up, box B adopts A's backups (a bring back) and then backs up into the same place with its
// own key. B's restore runs on a copy of its configuration without the runtime's socket (the test stops nothing).
type twoBoxes struct {
	A, B   *World
	ckA    *checkpoint.Result
	ckB    *checkpoint.Result
	cfg    *state.Config // B's, for the restore
	admin  *pgtool.Admin
	owner  string
	stops  int
	starts int
}

func newTwoBoxes(t *testing.T) *twoBoxes {
	ctx := context.Background()
	x := &twoBoxes{A: NewWorld(t), B: NewWorld(t)}
	x.A.Configure()
	x.ckA = x.A.Checkpoint()
	mat, err := x.A.Material()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := dest.Configure(ctx, x.B.Cfg, dest.Request{Repository: mat.Repository, RESTUser: mat.RESTUser,
		RESTPassword: mat.RESTPassword, AdoptPassword: mat.RepositoryPassword, AdoptManifestKey: mat.ManifestKey}); err != nil {
		t.Fatal(err)
	}
	x.ckB = x.B.Checkpoint()
	cfg := *x.B.Cfg
	cfg.RuntimeSocket = ""
	x.cfg = &cfg
	x.admin = &pgtool.Admin{DSN: x.B.Tools.AdminDSN}
	pc, _ := pgx.ParseConfig(x.B.Tools.AdminDSN)
	x.owner = pc.User
	DropSetAside(t, x.B.Tools, x.B.DB.Name)
	// What this box has now, after its backups: gone after a restore, back after an undo.
	WriteFile(t, filepath.Join(x.cfg.Layout().Home(), "after.txt"), "made after the backups")
	Exec(t, x.B.DB.DSN, "create table after_backups (id int)")
	return x
}

func (x *twoBoxes) opts(ck string) quarantine.AppOptions {
	return quarantine.AppOptions{CheckpointID: ck, DB: x.B.DB.Name, DBOwner: x.owner, DSN: x.B.DB.DSN, Admin: x.admin,
		Bins: pgtool.Bins{Dir: x.cfg.PGBin}, Git: gitinv.Runner{}, Log: x.B.T.Logf,
		StopRuntime:  func(context.Context) error { x.stops++; return nil },
		StartRuntime: func(context.Context) { x.starts++ }}
}

// asBefore checks that box B is as it was before the restore.
func (x *twoBoxes) asBefore(t *testing.T) {
	t.Helper()
	if b, _ := os.ReadFile(filepath.Join(x.cfg.Layout().Home(), "after.txt")); string(b) != "made after the backups" {
		t.Fatalf("home isn't back: %q", b)
	}
	conn, err := pgx.Connect(context.Background(), x.B.DB.DSN)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(context.Background())
	var n int
	if err := conn.QueryRow(context.Background(), "select count(*) from after_backups").Scan(&n); err != nil {
		t.Fatalf("the database isn't back: %v", err)
	}
	if m, _ := quarantine.Load(x.cfg); m != nil {
		t.Fatalf("still in quarantine: %+v", m)
	}
	if js, _ := quarantine.Journals(x.cfg); len(js) != 0 {
		t.Fatalf("set aside left: %s", js[0].Dir())
	}
}

func (x *twoBoxes) result(t *testing.T, ok bool, reason string) {
	t.Helper()
	r := quarantine.LoadResult(x.cfg)
	if r == nil || r.OK != ok || r.Reason != reason || (!ok && r.Error == "") {
		t.Fatalf("result %+v, want ok %v reason %q", r, ok, reason)
	}
	if st, _ := state.LoadStatus(x.cfg); st.Running != nil {
		t.Fatalf("the status still says %+v", st.Running)
	}
}

func refusal(t *testing.T, err error, reason string) {
	t.Helper()
	var re *quarantine.Refusal
	if !errors.As(err, &re) || re.Reason != reason {
		t.Fatalf("want a refusal %q, got %v", reason, err)
	}
}

// Restores the app can't do are refused before anything changes, with a reason the app shows: a backup from a newer
// Whombat, not enough room, a backup that isn't there, no place. The runtime is never stopped.
func TestAppRestoreRefusedUpFront(t *testing.T) {
	ctx := context.Background()
	x := newTwoBoxes(t)
	schema := x.ckB.Manifest.Database.SchemaVersion
	o := x.opts(x.ckB.Manifest.ID)
	o.ReleaseSchema = schema - 1
	refusal(t, quarantine.AppRestore(ctx, x.cfg, o), quarantine.ReasonNewer)
	x.result(t, false, quarantine.ReasonNewer)

	o = x.opts(x.ckB.Manifest.ID)
	o.Space = func(context.Context) (quarantine.Space, error) {
		return quarantine.Space{Free: 1 << 20, QuotaFree: -1}, nil
	}
	refusal(t, quarantine.AppRestore(ctx, x.cfg, o), quarantine.ReasonNoSpace)
	o.Space = func(context.Context) (quarantine.Space, error) {
		return quarantine.Space{Free: 1 << 40, QuotaFree: 10}, nil
	}
	refusal(t, quarantine.AppRestore(ctx, x.cfg, o), quarantine.ReasonNoSpace)
	x.result(t, false, quarantine.ReasonNoSpace)

	refusal(t, quarantine.AppRestore(ctx, x.cfg, x.opts("ck-not-there")), quarantine.ReasonNotFound)

	none := *x.cfg
	none.StateDir = filepath.Join(t.TempDir(), "state")
	refusal(t, quarantine.AppRestore(ctx, &none, x.opts(x.ckB.Manifest.ID)), quarantine.ReasonNoPlace)

	if x.stops != 0 {
		t.Fatalf("the runtime was stopped %d times", x.stops)
	}
	x.asBefore(t)
}

// After an adopt, the box's own backups still come back (its own key first), and the earlier Whombat's too; once one
// of the earlier Whombat's is back, a backup that Whombat makes later isn't trusted (a stolen or unwiped old box). A
// finished restore leaves nothing set aside.
func TestAppRestoreOwnAndAdopted(t *testing.T) {
	ctx := context.Background()
	x := newTwoBoxes(t)

	// The box's own backup, after the adopt.
	if err := quarantine.AppRestore(ctx, x.cfg, x.opts(x.ckB.Manifest.ID)); err != nil {
		t.Fatal(err)
	}
	m, _ := quarantine.Load(x.cfg)
	if m == nil || m.Phase != quarantine.PhaseQuarantined || m.Restored.CheckpointID != x.ckB.Manifest.ID {
		t.Fatalf("marker %+v", m)
	}
	if _, err := os.Stat(filepath.Join(x.cfg.Layout().Home(), "after.txt")); !os.IsNotExist(err) {
		t.Fatalf("the files made after the backup stay: %v", err)
	}
	if listing.LoadBound(x.cfg) != nil {
		t.Fatal("restoring the box's own backup bounded the earlier Whombat's key")
	}
	x.result(t, true, "")
	// The unit's schema step ended; the start after it keeps the quarantine.
	if err := quarantine.End(ctx, x.cfg, x.admin, x.ckB.Manifest.ID, "", ""); err != nil {
		t.Fatal(err)
	}
	if err := quarantine.Recover(ctx, x.cfg, x.admin, t.Logf); err != nil {
		t.Fatal(err)
	}
	if m, _ := quarantine.Load(x.cfg); m == nil || m.Phase != quarantine.PhaseQuarantined {
		t.Fatalf("a finished restore was undone: %+v", m)
	}
	js, _ := quarantine.Journals(x.cfg)
	if len(js) != 1 {
		t.Fatalf("journals %d", len(js))
	}
	aside, asideDB := js[0].Dir(), js[0].AsideDB
	release(t, x.cfg)
	if _, err := os.Stat(quarantine.CleanupRequestPath(x.cfg)); err != nil {
		t.Fatalf("the release asked for no cleanup: %v", err)
	}
	if err := quarantine.Recover(ctx, x.cfg, x.admin, t.Logf); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(aside); !os.IsNotExist(err) {
		t.Fatalf("the set-aside folder stays after the release: %v", err)
	}
	if asideDB == "" || DatabaseExists(t, x.B.Tools, asideDB) {
		t.Fatalf("the set-aside database %q stays after the release", asideDB)
	}
	if _, err := os.Stat(quarantine.CleanupRequestPath(x.cfg)); !os.IsNotExist(err) {
		t.Fatalf("the cleanup request stays: %v", err)
	}

	// The earlier Whombat's backup: its key is bounded from then on.
	if err := quarantine.AppRestore(ctx, x.cfg, x.opts(x.ckA.Manifest.ID)); err != nil {
		t.Fatal(err)
	}
	b := listing.LoadBound(x.cfg)
	if b == nil || b.CheckpointID != x.ckA.Manifest.ID || len(b.Known) != 1 {
		t.Fatalf("bound %+v", b)
	}
	if err := quarantine.End(ctx, x.cfg, x.admin, x.ckA.Manifest.ID, "", ""); err != nil {
		t.Fatal(err)
	}
	release(t, x.cfg)
	later := x.A.Checkpoint() // the old box, still running somewhere
	keys, err := listing.LoadKeys(x.cfg)
	if err != nil {
		t.Fatal(err)
	}
	res, err := listing.List(ctx, x.cfg, x.cfg.Repo(mustDest(t, x.cfg)), keys)
	if err != nil {
		t.Fatal(err)
	}
	ids := map[string]bool{}
	for _, e := range res.Checkpoints {
		ids[e.ID] = true
	}
	if !ids[x.ckA.Manifest.ID] || !ids[x.ckB.Manifest.ID] || ids[later.Manifest.ID] || res.Unauthentic == 0 {
		t.Fatalf("listed %v (unauthentic %d): want the restored and own ones, not the old box's later one", ids, res.Unauthentic)
	}
	refusal(t, quarantine.AppRestore(ctx, x.cfg, x.opts(later.Manifest.ID)), quarantine.ReasonNotFound)

	// A check of the earlier Whombat's backups takes the bound too: its newest is the one brought back, and the old
	// box's later one isn't checked.
	o := drill.Options{ManifestKey: keys.Adopted, ServerAdminDSN: x.B.Tools.AdminDSN, DBPrefix: "whombat_bk_test_bound", Log: t.Logf}
	rep, err := drill.Run(ctx, x.cfg, o)
	if err != nil || !rep.OK || rep.CheckpointID != x.ckA.Manifest.ID {
		t.Fatalf("the earlier Whombat's newest trusted backup: %v %v (%s)", err, rep.Failed(), rep.CheckpointID)
	}
	o.Snapshot = later.Manifest.ID
	if rep, err := drill.Run(ctx, x.cfg, o); err == nil || rep.CheckpointID == later.Manifest.ID {
		t.Fatalf("checked the old box's later backup: %v", err)
	}
}

// A restore that fails after the runtime stopped is undone: the box's files and database are back, the runtime starts
// again, the status says why. The same when the restore unit's schema step fails (a backup from a newer Whombat).
func TestAppRestoreFailureIsUndone(t *testing.T) {
	ctx := context.Background()
	x := newTwoBoxes(t)
	o := x.opts(x.ckA.Manifest.ID)
	o.Git = gitinv.Runner{Git: "/nonexistent/git"} // the git check fails after the files are restored
	if err := quarantine.AppRestore(ctx, x.cfg, o); err == nil {
		t.Fatal("the restore succeeded")
	}
	if x.stops != 1 || x.starts != 1 {
		t.Fatalf("runtime stopped %d, started %d", x.stops, x.starts)
	}
	x.asBefore(t)
	x.result(t, false, quarantine.ReasonFailed)
	if listing.LoadBound(x.cfg) != nil {
		t.Fatal("an undone restore bounded the earlier Whombat's key")
	}

	if err := quarantine.AppRestore(ctx, x.cfg, x.opts(x.ckA.Manifest.ID)); err != nil {
		t.Fatalf("trying again: %v", err)
	}
	if err := quarantine.End(ctx, x.cfg, x.admin, x.ckA.Manifest.ID, quarantine.ReasonNewer, "schema-check 12"); err != nil {
		t.Fatal(err)
	}
	x.asBefore(t)
	x.result(t, false, quarantine.ReasonNewer)
	if listing.LoadBound(x.cfg) != nil {
		t.Fatal("an undone restore bounded the earlier Whombat's key")
	}
}

// A power cut mid-restore never leaves a box that has to be reset: at the next start what the restore changed is put
// back and the status says to try again, and trying again works. Cut after the checkpoint was in place (the schema step
// never ended), and in a console restore after prepare and during apply.
func TestPowerCutMidRestore(t *testing.T) {
	ctx := context.Background()
	x := newTwoBoxes(t)
	if err := quarantine.AppRestore(ctx, x.cfg, x.opts(x.ckA.Manifest.ID)); err != nil {
		t.Fatal(err)
	}
	// The power goes during the schema step: restore-end never runs; the status says a restore runs.
	_, _ = state.UpdateStatus(x.cfg, func(s *state.Status) { s.Running = &state.Running{ID: "r", Op: "restore", Stage: "start"} })
	if err := quarantine.Recover(ctx, x.cfg, x.admin, t.Logf); err != nil {
		t.Fatal(err)
	}
	x.asBefore(t)
	x.result(t, false, quarantine.ReasonInterrupted)
	// Where the runtime reads it: failed, interrupted, the person's sentence and nothing technical.
	st, err := api.CurrentRestore(x.cfg)
	if err != nil {
		t.Fatal(err)
	}
	if st.Phase != "failed" || st.Reason == nil || *st.Reason != quarantine.ReasonInterrupted || st.Error == nil ||
		*st.Error != quarantine.LoadResult(x.cfg).Error {
		t.Fatalf("restore state %+v", st)
	}

	// The console's prepare, then the power goes before apply.
	if _, err := quarantine.Prepare(ctx, x.cfg, x.admin, x.B.DB.Name, x.owner, t.Logf); err != nil {
		t.Fatal(err)
	}
	if err := quarantine.Recover(ctx, x.cfg, x.admin, t.Logf); err != nil {
		t.Fatal(err)
	}
	x.asBefore(t)

	// The console's prepare, then the power goes during apply: the marker says restoring, part of the data is there.
	aside, err := quarantine.Prepare(ctx, x.cfg, x.admin, x.B.DB.Name, x.owner, t.Logf)
	if err != nil {
		t.Fatal(err)
	}
	m := &quarantine.Marker{Kind: quarantine.Kind, Phase: quarantine.PhaseRestoring, SetAside: filepath.Base(aside)[len("whombat-set-aside-"):]}
	if err := state.WriteJSON(quarantine.Path(x.cfg), m, 0o644); err != nil {
		t.Fatal(err)
	}
	WriteFile(t, filepath.Join(x.cfg.Layout().Home(), "partial.txt"), "half restored")
	if _, err := quarantine.Prepare(ctx, x.cfg, x.admin, x.B.DB.Name, x.owner, t.Logf); err == nil {
		t.Fatal("prepare ran while a restore is unfinished")
	}
	if err := quarantine.Recover(ctx, x.cfg, x.admin, t.Logf); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(x.cfg.Layout().Home(), "partial.txt")); !os.IsNotExist(err) {
		t.Fatalf("the half-restored data stays: %v", err)
	}
	x.asBefore(t)

	// Trying again works.
	if err := quarantine.AppRestore(ctx, x.cfg, x.opts(x.ckA.Manifest.ID)); err != nil {
		t.Fatalf("trying again: %v", err)
	}
}

func release(t *testing.T, cfg *state.Config) {
	t.Helper()
	for _, it := range quarantine.Items() {
		if it.Required {
			if _, err := quarantine.Resolve(cfg, it.ID, it.Resolutions[0], "test"); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := quarantine.Release(context.Background(), cfg, nil, ""); err != nil {
		t.Fatal(err)
	}
}

func mustDest(t *testing.T, cfg *state.Config) *state.Destination {
	t.Helper()
	d, err := state.LoadDestination(cfg)
	if err != nil || d == nil {
		t.Fatalf("destination: %v", err)
	}
	return d
}
