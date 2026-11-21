package itest

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/CybexBV/whombat/appliance/backup/internal/dest"
	"github.com/CybexBV/whombat/appliance/backup/internal/quarantine"
	"github.com/CybexBV/whombat/appliance/backup/internal/state"
	"github.com/CybexBV/whombat/appliance/backup/pkg/gitinv"
	"github.com/CybexBV/whombat/appliance/backup/pkg/kit"
	"github.com/CybexBV/whombat/appliance/backup/pkg/manifest"
	"github.com/CybexBV/whombat/appliance/backup/pkg/pgtool"
)

// A checkpoint without a Hermes home (a box that had none, as every checkpoint before BK-36) restores onto a box whose
// install already made its own: prepare sets it aside, apply leaves the directory empty and says so, and the restore
// has no `hermes` check (the runner makes the home at the first turn).
func TestCheckpointWithoutHermesHomes(t *testing.T) {
	old := NewWorld(t)
	if err := os.RemoveAll(old.Cfg.Layout().Hermes()); err != nil {
		t.Fatal(err)
	}
	old.Configure()
	ck := old.Checkpoint()
	if ck.Manifest.Hermes != nil {
		t.Fatalf("a Hermes home recorded for a box without one: %+v", ck.Manifest.Hermes)
	}
	mat, err := dest.Material(old.Cfg)
	if err != nil {
		t.Fatal(err)
	}
	k := &kit.Kit{Kind: kit.KitKind, ApplianceID: old.Cfg.ApplianceID, CreatedAt: mat.CreatedAt, Backup: mat}
	k.Seal()

	ctx := context.Background()
	newDB := CreateDB(t, old.Tools, "_new")
	cfg := &state.Config{ApplianceID: "apl-replacement", Persist: filepath.Join(t.TempDir(), "persist"),
		PGDSN: newDB.DSN, PGBin: old.Tools.PGBin, Restic: old.Tools.Restic, RuntimeUID: -1, ManagerUID: -1, BackupUID: -1}
	cfg.Defaults()
	l := cfg.Layout()
	WriteFile(t, filepath.Join(l.Hermes(), "skills", "ops", "deploy", "SKILL.md"), "the release's, synced at the runner's start")
	WriteFile(t, filepath.Join(l.Hermes(), "config.yaml"), "{}")
	d, err := dest.Configure(ctx, cfg, dest.Request{Repository: k.Backup.Repository, RESTUser: k.Backup.RESTUser,
		RESTPassword: k.Backup.RESTPassword, AdoptPassword: k.Backup.RepositoryPassword})
	if err != nil {
		t.Fatal(err)
	}
	trusted, err := manifest.ParseKey(k.Backup.ManifestKey)
	if err != nil {
		t.Fatal(err)
	}
	admin := &pgtool.Admin{DSN: strings.Replace(newDB.DSN, "dbname="+newDB.Name, "dbname=postgres", 1)}
	aside, err := quarantine.Prepare(ctx, cfg, nil, "", "", t.Logf)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(aside, "hermes", "skills", "ops", "deploy", "SKILL.md")); err != nil {
		t.Fatalf("the fresh box's Hermes home not set aside: %v", err)
	}
	marker, rep, err := quarantine.Apply(ctx, cfg, quarantine.ApplyOptions{Repo: cfg.Repo(d.Destination), ManifestKey: trusted,
		DSN: newDB.DSN, Admin: admin, Bins: pgtool.Bins{Dir: cfg.PGBin}, Git: gitinv.Runner{}, Log: t.Logf})
	if err != nil {
		t.Fatalf("apply: %v (failed %v)", err, rep.Failed())
	}
	if marker.Hermes != quarantine.HermesNone {
		t.Fatalf("marker hermes %q", marker.Hermes)
	}
	if ents, err := os.ReadDir(l.Hermes()); err != nil || len(ents) != 0 {
		t.Fatalf("Hermes root after the restore: %v %v", ents, err)
	}
	for _, c := range rep.Checks {
		if c.Name == "hermes" {
			t.Fatalf("a hermes check for a checkpoint without a home: %+v", c)
		}
	}
}
