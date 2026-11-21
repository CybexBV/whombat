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
	"github.com/CybexBV/whombat/appliance/backup/pkg/manifest"
	"github.com/CybexBV/whombat/appliance/backup/pkg/pgtool"
)

// A restore from the app that fails part-way is undone (BK-39): the fresh install's files and database are back as
// they were, the marker is archived as failed, so the runtime starts on the box as it was and the person can try again.
func TestFailedRestoreIsUndone(t *testing.T) {
	ctx := context.Background()
	old := NewWorld(t)
	old.Configure()
	old.Checkpoint()
	mat, err := old.Material()
	if err != nil {
		t.Fatal(err)
	}
	role := "whombat_bk_undo_role_" + Rand(3)
	Exec(t, old.Tools.AdminDSN, "create role "+pgx.Identifier{role}.Sanitize()+" nologin")
	fresh := CreateDB(t, old.Tools, "_undo")
	DropSetAside(t, old.Tools, fresh.Name)
	Exec(t, old.Tools.AdminDSN, "alter database "+pgx.Identifier{fresh.Name}.Sanitize()+" owner to "+pgx.Identifier{role}.Sanitize())
	Exec(t, fresh.DSN, "create table fresh_install (id int); alter table fresh_install owner to "+pgx.Identifier{role}.Sanitize())
	t.Cleanup(func() {
		c, err := pgx.Connect(context.Background(), old.Tools.AdminDSN)
		if err != nil {
			return
		}
		defer c.Close(context.Background())
		_, _ = c.Exec(context.Background(), "drop database if exists "+pgx.Identifier{fresh.Name}.Sanitize()+" with (force)")
		_, _ = c.Exec(context.Background(), "drop role if exists "+pgx.Identifier{role}.Sanitize())
	})
	cfg := &state.Config{ApplianceID: "apl-undo", Persist: filepath.Join(t.TempDir(), "persist"), PGDSN: fresh.DSN,
		PGBin: old.Tools.PGBin, Restic: old.Tools.Restic, RuntimeUID: -1, ManagerUID: -1, BackupUID: -1}
	cfg.Defaults()
	l := cfg.Layout()
	WriteFile(t, filepath.Join(l.Secrets(), "master.key"), "fresh-master-key")
	WriteFile(t, filepath.Join(l.Home(), "console.json"), `{"claim":"ABCD"}`)
	admin := &pgtool.Admin{DSN: old.Tools.AdminDSN}
	d, err := dest.Configure(ctx, cfg, dest.Request{Repository: mat.Repository, RESTUser: mat.RESTUser, RESTPassword: mat.RESTPassword,
		AdoptPassword: mat.RepositoryPassword, AdoptManifestKey: mat.ManifestKey})
	if err != nil {
		t.Fatal(err)
	}
	key, err := manifest.ParseKey(mat.ManifestKey)
	if err != nil {
		t.Fatal(err)
	}
	aside, err := quarantine.Prepare(ctx, cfg, admin, fresh.Name, role, t.Logf)
	if err != nil {
		t.Fatal(err)
	}
	// A backup that isn't there: the restore stops part-way.
	_, _, err = quarantine.Apply(ctx, cfg, quarantine.ApplyOptions{Repo: cfg.Repo(d.Destination), ManifestKey: key,
		Snapshot: "ck-not-there", DSN: fresh.DSN, Admin: admin, DBRole: role, Bins: pgtool.Bins{Dir: cfg.PGBin},
		Git: gitinv.Runner{}, Log: t.Logf})
	if err == nil {
		t.Fatal("apply of a missing backup succeeded")
	}
	m, err := quarantine.Load(cfg)
	if err != nil || m == nil || m.SetAside == "" {
		t.Fatalf("the marker names no set-aside journal: %+v %v", m, err)
	}
	j := quarantine.Pending(cfg, m)
	if j == nil || j.Dir() != aside {
		t.Fatalf("journal %+v, set aside in %s", j, aside)
	}
	if err := quarantine.Undo(ctx, cfg, admin, j); err != nil {
		t.Fatalf("undo: %v", err)
	}
	if b, _ := os.ReadFile(filepath.Join(l.Secrets(), "master.key")); string(b) != "fresh-master-key" {
		t.Fatalf("master key: %q", b)
	}
	if b, _ := os.ReadFile(filepath.Join(l.Home(), "console.json")); !strings.Contains(string(b), "ABCD") {
		t.Fatalf("home: %q", b)
	}
	c, err := pgx.Connect(ctx, fresh.DSN)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close(ctx)
	var n int
	if err := c.QueryRow(ctx, "select count(*) from fresh_install").Scan(&n); err != nil {
		t.Fatalf("the fresh database isn't back: %v", err)
	}
	if m, _ := quarantine.Load(cfg); m != nil {
		t.Fatal("still in quarantine")
	}
	if _, err := quarantine.Prepare(ctx, cfg, admin, fresh.Name, role, t.Logf); err != nil {
		t.Fatalf("a new restore after the undo: %v", err)
	}
	failed, _ := filepath.Glob(filepath.Join(cfg.StateDir, "quarantine-failed-*.json"))
	if len(failed) != 1 {
		t.Fatalf("archived markers %v", failed)
	}
	if _, err := os.Stat(aside); !os.IsNotExist(err) {
		t.Fatalf("the set-aside folder stays: %v", err)
	}
}
