package itest

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"

	"github.com/CybexBV/whombat/appliance/backup/internal/dest"
	"github.com/CybexBV/whombat/appliance/backup/internal/drill"
	"github.com/CybexBV/whombat/appliance/backup/internal/quarantine"
	"github.com/CybexBV/whombat/appliance/backup/internal/state"
	"github.com/CybexBV/whombat/appliance/backup/pkg/coverage"
	"github.com/CybexBV/whombat/appliance/backup/pkg/gitinv"
	"github.com/CybexBV/whombat/appliance/backup/pkg/manifest"
	"github.com/CybexBV/whombat/appliance/backup/pkg/pgtool"
)

// applyOnFreshBox adopts old's destination on a fresh, empty box (with or without the hosts service) and
// restores one checkpoint there in quarantine (BK-24, BK-34).
func applyOnFreshBox(t *testing.T, old *World, checkpointID string, withHosts bool) (*state.Config, *quarantine.Marker) {
	t.Helper()
	ctx := context.Background()
	mat, err := dest.Material(old.Cfg)
	if err != nil {
		t.Fatal(err)
	}
	db := CreateDB(t, old.Tools, "_fresh")
	cfg := &state.Config{ApplianceID: "apl-fresh-" + Rand(2), Persist: filepath.Join(t.TempDir(), "persist"), PGDSN: db.DSN,
		PGBin: old.Tools.PGBin, Restic: old.Tools.Restic, RuntimeUID: -1, ManagerUID: -1, BackupUID: -1}
	cfg.Defaults()
	if withHosts {
		EnableHosts(cfg, filepath.Join(t.TempDir(), "unused.sock"))
	}
	d, err := dest.Configure(ctx, cfg, dest.Request{Repository: mat.Repository, RESTUser: mat.RESTUser, RESTPassword: mat.RESTPassword,
		AdoptPassword: mat.RepositoryPassword, AdoptManifestKey: mat.ManifestKey})
	if err != nil {
		t.Fatal(err)
	}
	key, err := manifest.ParseKey(mat.ManifestKey)
	if err != nil {
		t.Fatal(err)
	}
	marker, rep, err := quarantine.Apply(ctx, cfg, quarantine.ApplyOptions{Repo: cfg.Repo(d.Destination), ManifestKey: key,
		Snapshot: checkpointID, DSN: db.DSN, Admin: &pgtool.Admin{DSN: old.Tools.AdminDSN}, Bins: pgtool.Bins{Dir: cfg.PGBin},
		Git: gitinv.Runner{}, Log: t.Logf})
	if err != nil {
		t.Fatalf("apply %s: %v (failed %v)", checkpointID, err, rep.Failed())
	}
	return cfg, marker
}

// BF-18: on a box with the hosts service every checkpoint carries the service's own backup, made just before
// the quiesce; a drill checks it; the console restore hands it to the service (restore-staged.tar.gz, its
// user's, 0600); checkpoints from before restore as they did; a box without the service restores the rest.
func TestServersInCheckpoints(t *testing.T) {
	ctx := context.Background()
	w := NewWorld(t)
	w.Configure()
	before := w.Checkpoint() // a checkpoint from before the servers were in them
	if before.Manifest.Hosts != nil {
		t.Fatal("servers in a checkpoint of a box without the hosts service")
	}

	h := w.WithHosts()
	res := w.Checkpoint()
	m := res.Manifest
	exported, made := h.Last()
	if made != 1 {
		t.Fatalf("the hosts service made %d backups for one checkpoint", made)
	}
	sum := sha256.Sum256(exported)
	if m.Hosts == nil || m.Hosts.Backup.Path != manifest.HostsBackupPath || m.Hosts.Backup.SHA256 != hex.EncodeToString(sum[:]) ||
		m.Hosts.Backup.Size != int64(len(exported)) {
		t.Fatalf("manifest hosts %+v", m.Hosts)
	}
	var src *manifest.Source
	for i := range m.Sources {
		if m.Sources[i].Name == "hosts" {
			src = &m.Sources[i]
		}
	}
	if src == nil || src.SnapshotPath != "files/hosts" || src.Files != 1 || src.Missing {
		t.Fatalf("hosts source %+v", src)
	}
	covered := false
	for _, c := range m.Coverage {
		covered = covered || (c.ID == "servers" && c.Covered)
	}
	if !covered {
		t.Fatalf("coverage %+v", m.Coverage)
	}
	st, _ := state.CurrentStatus(w.Cfg)
	if !strings.Contains(mustString(t, st.Coverage), `"servers"`) {
		t.Fatalf("status coverage %+v", st.Coverage)
	}

	// The drill checks the servers' backup against the manifest.
	rep, err := drill.Run(ctx, w.Cfg, drill.Options{ServerAdminDSN: w.Tools.AdminDSN, DBPrefix: "whombat_bk_test_q", Log: t.Logf})
	if err != nil || !rep.OK {
		t.Fatalf("drill: %v %v", err, rep.Failed())
	}
	checked := false
	for _, c := range rep.Checks {
		checked = checked || (c.Name == "hosts" && c.OK)
	}
	if !checked {
		t.Fatalf("no hosts check: %+v", rep.Checks)
	}

	// The console restore onto a fresh box with the hosts service: staged for the service.
	cfg, marker := applyOnFreshBox(t, w, m.ID, true)
	staged := filepath.Join(cfg.Layout().HostsData(), coverage.HostsStagedFile)
	b, err := os.ReadFile(staged)
	if err != nil || !bytes.Equal(b, exported) {
		t.Fatalf("staged backup: %v (%d bytes, want %d)", err, len(b), len(exported))
	}
	fi, _ := os.Lstat(staged)
	if fi.Mode().Perm() != 0o600 || int(fi.Sys().(*syscall.Stat_t).Uid) != cfg.Hosts.UID {
		t.Fatalf("staged %v", fi.Mode())
	}
	if marker.Servers != quarantine.ServersStaged {
		t.Fatalf("marker servers %q", marker.Servers)
	}
	if _, err := os.Stat(filepath.Join(cfg.Layout().HostsBackup(), coverage.HostsBackupFile)); err == nil {
		t.Fatal("the servers' backup was put back as a tree")
	}

	// The checkpoint from before has no servers: nothing staged, the rest restored as always.
	cfg, marker = applyOnFreshBox(t, w, before.Manifest.ID, true)
	if _, err := os.Lstat(filepath.Join(cfg.Layout().HostsData(), coverage.HostsStagedFile)); err == nil || marker.Servers != "" {
		t.Fatalf("staged from a checkpoint without servers (%q)", marker.Servers)
	}
	if _, err := os.Stat(filepath.Join(cfg.Layout().Home(), SkillVersionFile)); err != nil {
		t.Fatal("the old checkpoint's files aren't back")
	}

	// A box without the hosts service restores everything else and says the servers didn't come back.
	cfg, marker = applyOnFreshBox(t, w, m.ID, false)
	if marker.Servers != quarantine.ServersNoHostsService {
		t.Fatalf("marker servers %q", marker.Servers)
	}
	if _, err := os.Lstat(cfg.Layout().HostsData()); err == nil {
		t.Fatal("wrote the servers on a box without the hosts service")
	}
	if _, err := os.Stat(filepath.Join(cfg.Layout().Home(), SkillVersionFile)); err != nil {
		t.Fatal("the files aren't back")
	}
}

func mustString(t *testing.T, v any) string { return string(mustJSON(t, v)) }
