package itest

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"

	"github.com/CybexBV/whombat/appliance/backup/internal/dest"
	"github.com/CybexBV/whombat/appliance/backup/internal/quarantine"
	"github.com/CybexBV/whombat/appliance/backup/internal/state"
	"github.com/CybexBV/whombat/appliance/backup/pkg/gitinv"
	"github.com/CybexBV/whombat/appliance/backup/pkg/kit"
	"github.com/CybexBV/whombat/appliance/backup/pkg/manifest"
	"github.com/CybexBV/whombat/appliance/backup/pkg/pgtool"
)

// Regression for M-1 (W4-SEC part 2): quarantine.Apply restored into the live database before writing the
// quarantine marker, so a failure part-way (here: putting /persist/secrets in place) left the old
// appliance's data running with no quarantine, and a connection opened before the restore could still
// write. Now the marker (phase "restoring") exists before any data arrives and stays after a failure, the
// database is read-only, and pre-existing sessions were ended.
func TestQuarantineMarkerWrittenFirst(t *testing.T) {
	old := NewWorld(t)
	old.Configure()
	old.Checkpoint()
	mat, err := dest.Material(old.Cfg)
	if err != nil {
		t.Fatal(err)
	}
	k := &kit.Kit{Kind: kit.KitKind, ApplianceID: old.Cfg.ApplianceID, CreatedAt: mat.CreatedAt, Backup: mat}
	k.Seal()
	kitPath := filepath.Join(t.TempDir(), "kit.json")
	WriteFile(t, kitPath, string(mustJSON(t, k)))
	m, err := kit.Load(kitPath)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	newDB := CreateDB(t, old.Tools, "_sec2")
	persist := filepath.Join(t.TempDir(), "persist")
	cfg := &state.Config{ApplianceID: "apl-replacement", Persist: persist,
		PGDSN: newDB.DSN, PGBin: old.Tools.PGBin, Restic: old.Tools.Restic, RuntimeUID: -1, ManagerUID: -1, BackupUID: -1}
	cfg.Defaults()
	d, err := dest.Configure(ctx, cfg, dest.Request{Repository: m.Repository, RESTUser: m.RESTUser, RESTPassword: m.RESTPassword,
		AdoptPassword: m.RepositoryPassword})
	if err != nil {
		t.Fatal(err)
	}
	trusted, _ := manifest.ParseKey(m.ManifestKey)
	admin := &pgtool.Admin{DSN: strings.Replace(newDB.DSN, "dbname="+newDB.Name, "dbname=postgres", 1)}

	// The runtime is already running on the (empty) replacement database.
	live, err := pgx.Connect(ctx, newDB.DSN)
	if err != nil {
		t.Fatal(err)
	}
	defer live.Close(ctx)
	// Make the last move (into /persist/secrets) fail after the database was restored: the target exists,
	// empty, and takes no entries.
	l := cfg.Layout()
	for _, p := range []string{l.Home(), l.Workspaces(), l.Credentials(), l.Secrets()} {
		_ = os.MkdirAll(p, 0o700)
	}
	if err := os.Chmod(l.Secrets(), 0o500); err != nil {
		t.Fatal(err)
	}
	defer os.Chmod(l.Secrets(), 0o700)

	_, rep, err := quarantine.Apply(ctx, cfg, quarantine.ApplyOptions{Repo: cfg.Repo(d.Destination), ManifestKey: trusted,
		DSN: newDB.DSN, Admin: admin, Bins: pgtool.Bins{Dir: cfg.PGBin}, Git: gitinv.Runner{}, Log: t.Logf})
	if err == nil {
		t.Fatal("expected apply to fail at the secrets rename")
	}
	t.Logf("apply failed: %v (report failed: %v)", err, rep.Failed())
	mk, lerr := quarantine.Load(cfg)
	if lerr != nil || mk == nil || mk.Phase != quarantine.PhaseRestoring || mk.Error == "" {
		t.Fatalf("no restoring marker after the failure: %+v %v", mk, lerr)
	}
	if err := quarantine.Release(ctx, cfg, nil, newDB.Name); err == nil {
		t.Fatal("a failed restore can be released")
	}
	// The session that existed before the restore was ended; a new one is read-only.
	if _, err := live.Exec(ctx, "select 1"); err == nil {
		t.Fatal("pre-existing session survived the restore")
	}
	again, err := pgx.Connect(ctx, newDB.DSN)
	if err != nil {
		t.Fatal(err)
	}
	defer again.Close(ctx)
	if _, err := again.Exec(ctx, "insert into messages(body) values ('runtime write outside quarantine')"); err == nil {
		t.Fatal("a session could write during quarantine")
	}
}
