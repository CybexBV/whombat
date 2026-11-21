package export

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/CybexBV/whombat/appliance/backup/itest"
	"github.com/CybexBV/whombat/appliance/backup/pkg/gitinv"
	"github.com/CybexBV/whombat/appliance/backup/pkg/kit"
	"github.com/CybexBV/whombat/appliance/backup/pkg/manifest"
	"github.com/CybexBV/whombat/appliance/backup/pkg/pgtool"
	"github.com/CybexBV/whombat/appliance/backup/pkg/restic"
	"github.com/CybexBV/whombat/appliance/backup/pkg/restore"
)

// Export with nothing but the kit: a local copy of the repository (the appliance and the REST server are
// gone), verified, written out in open formats.
func TestExportFromKitAndLocalRepositoryCopy(t *testing.T) {
	w := itest.NewWorld(t)
	w.Configure()
	hosts := w.WithHosts() // the servers too (BK-31): exported only with the secrets (BK-35)
	w.Checkpoint()
	mat, err := w.Material()
	if err != nil {
		t.Fatal(err)
	}
	k := &kit.Kit{Kind: kit.KitKind, ApplianceID: w.Cfg.ApplianceID, CreatedAt: mat.CreatedAt, Backup: mat}
	k.Seal()
	m, _ := kit.Parse(mustJSON(k))
	// "Disaster": copy the repository files off the storage (what a storage provider export gives).
	repoCopy := filepath.Join(t.TempDir(), "repo")
	if out, err := exec.Command("cp", "-a", filepath.Join(w.Rest.DataDir, w.RepoPath), repoCopy).CombinedOutput(); err != nil {
		t.Fatalf("%v %s", err, out)
	}
	pw := filepath.Join(t.TempDir(), "pw")
	_ = os.WriteFile(pw, []byte(m.RepositoryPassword), 0o600)
	key, _ := manifest.ParseKey(m.ManifestKey)
	out := filepath.Join(t.TempDir(), "export")
	res, err := FromRepository(context.Background(), Options{Out: out, Log: t.Logf, Restore: restore.Options{
		Repo:     restic.Repo{Binary: w.Tools.Restic, Repository: repoCopy, PasswordFile: pw, NoCache: true},
		Snapshot: "latest", ManifestKey: key, CheckData: "all", Bins: pgtool.Bins{Dir: w.Tools.PGBin}, Git: gitinv.Runner{}}})
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{"README.txt", "manifest.json", "manifest.sig", "verification.json", "database/whombat.pgdump",
		"database/whombat.sql", "files/home/" + filepath.ToSlash(itest.SkillVersionFile), "workspaces/b1/proj/notes-untracked.txt", "workspaces/b1/proj/.env",
		"files/hermes/memories/MEMORY.md", "files/hermes/state.db-wal", "files/hermes/skills/ops/deploy/SKILL.md",
		"files/agent/site/index.html"} {
		if _, err := os.Stat(filepath.Join(out, p)); err != nil {
			t.Fatalf("missing %s", p)
		}
	}
	if _, err := os.Stat(filepath.Join(out, "secrets")); err == nil {
		t.Fatal("secrets exported without -include-secrets")
	}
	sql, _ := os.ReadFile(filepath.Join(out, "database/whombat.sql"))
	if !strings.Contains(string(sql), "CREATE TABLE public.messages") || !strings.Contains(string(sql), "message 250") {
		t.Fatal("plain SQL incomplete")
	}
	// The bundle of the working repository carries the unpushed commit.
	var bundle string
	for _, b := range res.Bundles {
		if strings.HasSuffix(b, "b1/proj.bundle") {
			bundle = filepath.Join(out, b)
		}
	}
	if bundle == "" {
		t.Fatalf("no bundle for proj: %v", res.Bundles)
	}
	clone := filepath.Join(t.TempDir(), "clone")
	itest.Git(t, filepath.Dir(clone), "clone", "-q", bundle, clone)
	if got := itest.Git(t, clone, "log", "--format=%s", "-1", "main"); got != "unpushed feature" {
		t.Fatalf("bundle head %q", got)
	}
	// The exported worktree works in place (its metadata points into the export).
	if got := itest.Git(t, filepath.Join(out, "workspaces/b1/proj-wt/feat"), "log", "--format=%s", "-1"); got != "worktree unpushed" {
		t.Fatalf("exported worktree head %q", got)
	}
	readme, _ := os.ReadFile(filepath.Join(out, "README.txt"))
	if !strings.Contains(string(readme), "b1/proj [repository]") || !strings.Contains(string(readme), "1 unpushed") {
		t.Fatalf("README:\n%s", readme)
	}
	t.Logf("README.txt:\n%s", readme)

	// With -include-secrets: the provider homes, the master key and the hosts service's backup as it was made.
	withSecrets := filepath.Join(t.TempDir(), "export")
	if _, err := FromRepository(context.Background(), Options{Out: withSecrets, IncludeSecrets: true, Log: t.Logf, Restore: restore.Options{
		Repo:     restic.Repo{Binary: w.Tools.Restic, Repository: repoCopy, PasswordFile: pw, NoCache: true},
		Snapshot: "latest", ManifestKey: key, SkipCheck: true, Bins: pgtool.Bins{Dir: w.Tools.PGBin}, Git: gitinv.Runner{}}}); err != nil {
		t.Fatal(err)
	}
	hub, _ := hosts.Last()
	if b, err := os.ReadFile(filepath.Join(withSecrets, "secrets/hosts/hub.tar.gz")); err != nil || string(b) != string(hub) {
		t.Fatalf("the servers' backup with the secrets: %v", err)
	}
	if _, err := os.Stat(filepath.Join(withSecrets, "secrets/secrets/master.key")); err != nil {
		t.Fatal("the master key isn't with the secrets")
	}

	// A wrong password in the kit opens nothing.
	_ = os.WriteFile(pw, []byte("wrong"), 0o600)
	_, err = FromRepository(context.Background(), Options{Out: filepath.Join(t.TempDir(), "x"), Restore: restore.Options{
		Repo:        restic.Repo{Binary: w.Tools.Restic, Repository: repoCopy, PasswordFile: pw, NoCache: true},
		ManifestKey: key, SkipCheck: true, Bins: pgtool.Bins{Dir: w.Tools.PGBin}}})
	if err == nil {
		t.Fatal("export with a wrong password succeeded")
	}
}

func mustJSON(v any) []byte {
	b, _ := json.Marshal(v)
	return b
}

// Export straight from an appliance's persistent volume (no usable backup): the data directory is copied,
// never started in place.
func TestExportFromDisk(t *testing.T) {
	tl := itest.NeedTools(t)
	ctx := context.Background()
	tmp := t.TempDir()
	cl := &pgtool.Cluster{Bins: pgtool.Bins{Dir: tl.PGBin}, Dir: filepath.Join(tmp, "pg"), Port: itest.FreePort(t), User: "postgres"}
	if err := cl.Init(ctx); err != nil {
		t.Fatal(err)
	}
	admin := pgtool.Admin{DSN: cl.DSN("postgres")}
	if err := admin.CreateDB(ctx, "whombat"); err != nil {
		t.Fatal(err)
	}
	itest.Exec(t, cl.DSN("whombat"), "create table messages(id int, body text); insert into messages values (1, 'from the disk')")
	if err := cl.Stop(); err != nil {
		t.Fatal(err)
	}
	persist := filepath.Join(tmp, "persist")
	_ = os.MkdirAll(filepath.Join(persist, "postgres"), 0o700)
	if err := os.Rename(filepath.Join(tmp, "pg", "data"), filepath.Join(persist, "postgres", "17")); err != nil {
		t.Fatal(err)
	}
	itest.WriteFile(t, filepath.Join(persist, "whombat", "home", "files", "a"), "attachment")
	itest.WriteFile(t, filepath.Join(persist, "whombat", "workspaces", "r", "untracked.txt"), "work")
	itest.WriteFile(t, filepath.Join(persist, "secrets", "master.key"), "k")
	out := filepath.Join(tmp, "out")
	err := FromDisk(ctx, DiskOptions{Persist: persist, Out: out, Work: filepath.Join(tmp, "work"), Bins: pgtool.Bins{Dir: tl.PGBin},
		Port: itest.FreePort(t), Log: t.Logf})
	if err != nil {
		t.Fatal(err)
	}
	sql, _ := os.ReadFile(filepath.Join(out, "database", "whombat.sql"))
	if !strings.Contains(string(sql), "from the disk") {
		t.Fatal("dump incomplete")
	}
	for _, p := range []string{"files/home/files/a", "workspaces/r/untracked.txt"} {
		if _, err := os.Stat(filepath.Join(out, p)); err != nil {
			t.Fatalf("missing %s", p)
		}
	}
	if _, err := os.Stat(filepath.Join(out, "secrets")); err == nil {
		t.Fatal("secrets exported without -include-secrets")
	}
	if _, err := os.Stat(filepath.Join(persist, "postgres", "17", "postmaster.pid")); err == nil {
		t.Fatal("the original data directory was started")
	}
}
