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

// Replacement: a fresh appliance (new identity, empty layout, empty database) adopts the repository with
// the old appliance's recovery kit, restores in quarantine, and only leaves quarantine once every
// reconciliation item is resolved.
func TestReplacementQuarantine(t *testing.T) {
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

	// The replacement.
	ctx := context.Background()
	newDB := CreateDB(t, old.Tools, "_new")
	cfg := &state.Config{ApplianceID: "apl-replacement", Persist: filepath.Join(t.TempDir(), "persist"),
		PGDSN: newDB.DSN, PGBin: old.Tools.PGBin, Restic: old.Tools.Restic, RuntimeUID: -1, ManagerUID: -1, BackupUID: -1}
	cfg.Defaults()
	d, err := dest.Configure(ctx, cfg, dest.Request{Repository: m.Repository, RESTUser: m.RESTUser, RESTPassword: m.RESTPassword,
		AdoptPassword: m.RepositoryPassword})
	if err != nil {
		t.Fatal(err)
	}
	if d.RepositoryID != m.RepositoryID {
		t.Fatalf("adopted a different repository: %s vs %s", d.RepositoryID, m.RepositoryID)
	}
	trusted, err := manifest.ParseKey(m.ManifestKey)
	if err != nil {
		t.Fatal(err)
	}
	admin := &pgtool.Admin{DSN: strings.Replace(newDB.DSN, "dbname="+newDB.Name, "dbname=postgres", 1)}
	marker, rep, err := quarantine.Apply(ctx, cfg, quarantine.ApplyOptions{Repo: cfg.Repo(d.Destination), ManifestKey: trusted,
		DSN: newDB.DSN, Admin: admin, Bins: pgtool.Bins{Dir: cfg.PGBin}, Git: gitinv.Runner{}, Log: t.Logf})
	if err != nil {
		t.Fatalf("apply: %v (failed %v)", err, rep.Failed())
	}
	if marker.OldAppliance.ApplianceID != old.Cfg.ApplianceID || marker.NewApplianceID != "apl-replacement" || len(marker.Relogin) != 1 {
		t.Fatalf("marker %+v", marker)
	}
	l := cfg.Layout()
	// Files are in place; the worktree points at the new layout, never at the old appliance's paths.
	wt := filepath.Join(l.Workspaces(), "b1", "proj-wt", "feat")
	gitFile, _ := os.ReadFile(filepath.Join(wt, ".git"))
	if !strings.Contains(string(gitFile), l.Workspaces()) {
		t.Fatalf("worktree gitdir not relocated: %s", gitFile)
	}
	if got := Git(t, wt, "log", "--format=%s", "-1"); got != "worktree unpushed" {
		t.Fatalf("worktree head %q", got)
	}
	if _, err := os.Stat(filepath.Join(l.Secrets(), "master.key")); err != nil {
		t.Fatal("master key not restored")
	}
	// The Hermes home and its skills are back, byte for byte; the runner's transients aren't (BK-36, NX-466). So is the
	// agent's home, without its cache.
	for rel, want := range HermesFiles {
		if got, err := os.ReadFile(filepath.Join(l.Hermes(), rel)); err != nil || string(got) != want {
			t.Fatalf("Hermes %s: %q %v", rel, got, err)
		}
	}
	for _, rel := range HermesTransient {
		if _, err := os.Lstat(filepath.Join(l.Hermes(), rel)); err == nil {
			t.Fatalf("Hermes %s restored", rel)
		}
	}
	for rel, want := range AgentFiles {
		if got, err := os.ReadFile(filepath.Join(l.AgentHome(), rel)); err != nil || string(got) != want {
			t.Fatalf("agent's home %s: %q %v", rel, got, err)
		}
	}
	for _, rel := range AgentTransient {
		if _, err := os.Lstat(filepath.Join(l.AgentHome(), rel)); err == nil {
			t.Fatalf("agent's home %s restored", rel)
		}
	}
	if marker.Hermes != quarantine.HermesRestored {
		t.Fatalf("marker hermes %q", marker.Hermes)
	}
	hermesChecked := false
	for _, c := range rep.Checks {
		hermesChecked = hermesChecked || (c.Name == "hermes" && c.OK && strings.Contains(c.Detail, "3 SQLite stores"))
	}
	if !hermesChecked {
		t.Fatalf("no passing hermes check: %+v", rep.Checks)
	}
	// The database is read-only in quarantine.
	conn, _ := pgx.Connect(ctx, newDB.DSN)
	if _, err := conn.Exec(ctx, "insert into messages(body) values ('x')"); err == nil {
		t.Fatal("quarantine database writable")
	}
	conn.Close(ctx)
	// A second apply is refused (never merges).
	if _, _, err := quarantine.Apply(ctx, cfg, quarantine.ApplyOptions{Repo: cfg.Repo(d.Destination), ManifestKey: trusted, DSN: newDB.DSN}); err == nil {
		t.Fatal("second apply accepted")
	}
	// Release needs every required item.
	if err := quarantine.Release(ctx, cfg, admin, newDB.Name); err == nil || !strings.Contains(err.Error(), "old-appliance") {
		t.Fatalf("release with open items: %v", err)
	}
	if _, err := quarantine.Resolve(cfg, "old-appliance", "rebooted", ""); err == nil {
		t.Fatal("invalid resolution accepted")
	}
	for id, r := range map[string]string{"old-appliance": "credentials-rotated", "revocations": "none-after-checkpoint",
		"endpoints": "reviewed", "provider-logins": "relogged", "external-outcomes": "reconciled", "identity-repin": "repinned"} {
		if _, err := quarantine.Resolve(cfg, id, r, "test"); err != nil {
			t.Fatal(err)
		}
	}
	if err := quarantine.Release(ctx, cfg, admin, newDB.Name); err != nil {
		t.Fatal(err)
	}
	conn, _ = pgx.Connect(ctx, newDB.DSN)
	defer conn.Close(ctx)
	if _, err := conn.Exec(ctx, "insert into messages(body) values ('after release')"); err != nil {
		t.Fatalf("database still read-only after release: %v", err)
	}
	// The replacement continues the chain in the same repository under its own host name.
	if m2, _ := quarantine.Load(cfg); m2 != nil {
		t.Fatal("marker still present")
	}
}
