package itest

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/CybexBV/whombat/appliance/backup/internal/checkpoint"
	"github.com/CybexBV/whombat/appliance/backup/internal/dest"
	"github.com/CybexBV/whombat/appliance/backup/internal/quarantine"
	"github.com/CybexBV/whombat/appliance/backup/internal/runtimeadmin"
	"github.com/CybexBV/whombat/appliance/backup/internal/state"
	"github.com/CybexBV/whombat/appliance/backup/pkg/gitinv"
	"github.com/CybexBV/whombat/appliance/backup/pkg/kit"
	"github.com/CybexBV/whombat/appliance/backup/pkg/manifest"
	"github.com/CybexBV/whombat/appliance/backup/pkg/pgtool"
	"github.com/CybexBV/whombat/appliance/backup/pkg/restore"
)

// The restore drill of UP-F2 at the service level (BK-24; the VM gate runs the same commands on real
// boxes): the verified checkpoint taken before a contract migration that then broke the database is
// restored onto a *fresh* appliance — one whose install already created its own files, master key and
// migrated database — with the documented steps: adopt with the kit, prepare (the fresh install set
// aside, nothing deleted), apply as the runtime's role, release.
func TestRestoreOntoFreshBox(t *testing.T) {
	ctx := context.Background()
	old := NewWorld(t)
	old.Configure()
	// The manager's pre-migration checkpoint: inside its drain, verified from the destination.
	rt := runtimeadmin.New(old.Runtime.Socket)
	if _, err := rt.Drain(ctx, runtimeadmin.DrainRequest{RequestID: "upd-7", Reason: "backup", Scope: "all", LeaseMs: 60_000}); err != nil {
		t.Fatal(err)
	}
	ck, err := old.Runner().Run(ctx, checkpoint.Options{Reason: "pre-migration", UnderDrain: "upd-7", Verify: true,
		Migration: &manifest.Migration{ReleaseID: "pve-20260929.1", Migrations: []string{"0049_contract"}}})
	if err != nil || !ck.Verified {
		t.Fatalf("pre-migration checkpoint: %v", err)
	}
	_ = rt.Resume(ctx, "upd-7")
	// The contract migration fails half-way and leaves the old box's database broken.
	Exec(t, old.DB.DSN, "alter table messages drop column body")
	mat, err := dest.Material(old.Cfg)
	if err != nil {
		t.Fatal(err)
	}
	k := &kit.Kit{Kind: kit.KitKind, ApplianceID: old.Cfg.ApplianceID, CreatedAt: time.Now().UTC(), Backup: mat}
	k.Seal()
	kitPath := filepath.Join(t.TempDir(), "kit.json")
	WriteFile(t, kitPath, string(mustJSON(t, k)))

	// A fresh appliance: the runtime's role owns its migrated database; the install wrote a master key,
	// a runner token and some home files.
	role := "whombat_bk_test_role_" + Rand(3)
	Exec(t, old.Tools.AdminDSN, "create role "+pgx.Identifier{role}.Sanitize()+" nologin")
	t.Cleanup(func() {
		c, err := pgx.Connect(context.Background(), old.Tools.AdminDSN)
		if err == nil {
			_, _ = c.Exec(context.Background(), "drop role if exists "+pgx.Identifier{role}.Sanitize())
			c.Close(context.Background())
		}
	})
	fresh := CreateDB(t, old.Tools, "_fresh")
	Exec(t, old.Tools.AdminDSN, "alter database "+pgx.Identifier{fresh.Name}.Sanitize()+" owner to "+pgx.Identifier{role}.Sanitize())
	Exec(t, fresh.DSN, "create table fresh_install (id int); alter table fresh_install owner to "+pgx.Identifier{role}.Sanitize())
	cfg := &state.Config{ApplianceID: "apl-fresh", Persist: filepath.Join(t.TempDir(), "persist"), PGDSN: fresh.DSN,
		PGBin: old.Tools.PGBin, Restic: old.Tools.Restic, RuntimeUID: -1, ManagerUID: -1, BackupUID: -1}
	cfg.Defaults()
	l := cfg.Layout()
	WriteFile(t, filepath.Join(l.Secrets(), "master.key"), "fresh-master-key")
	WriteFile(t, filepath.Join(l.Secrets(), "runner-token"), "fresh-runner-token")
	WriteFile(t, filepath.Join(l.Home(), "console.json"), `{"claim":"ABCD"}`)
	admin := &pgtool.Admin{DSN: old.Tools.AdminDSN}

	// 1. adopt: the kit's repository, password and manifest key.
	m, err := kit.Load(kitPath)
	if err != nil {
		t.Fatal(err)
	}
	d, err := dest.Configure(ctx, cfg, dest.Request{Repository: m.Repository, RESTUser: m.RESTUser, RESTPassword: m.RESTPassword,
		AdoptPassword: m.RepositoryPassword, AdoptManifestKey: m.ManifestKey})
	if err != nil {
		t.Fatal(err)
	}
	// apply refuses a layout that isn't empty (a replacement never merges)…
	adopted, _ := os.ReadFile(cfg.AdoptedManifestKeyPath())
	key, err := manifest.ParseKey(strings.TrimSpace(string(adopted)))
	if err != nil {
		t.Fatal(err)
	}
	opts := quarantine.ApplyOptions{Repo: cfg.Repo(d.Destination), ManifestKey: key, Snapshot: ck.Manifest.ID, DSN: fresh.DSN,
		Admin: admin, DBRole: role, Bins: pgtool.Bins{Dir: cfg.PGBin}, Git: gitinv.Runner{}, CheckData: "all",
		ExpectHead: &restore.ExpectedHead{Seq: m.Head.Seq, ManifestSHA256: m.Head.ManifestSHA256}, Log: t.Logf}
	if _, _, err := quarantine.Apply(ctx, cfg, opts); err == nil || !strings.Contains(err.Error(), "not empty") {
		t.Fatalf("apply onto a used layout: %v", err)
	}
	// 2. prepare: the fresh install is set aside (files moved, database renamed), nothing deleted.
	aside, err := quarantine.Prepare(ctx, cfg, admin, fresh.Name, role, t.Logf)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		c, err := pgx.Connect(context.Background(), old.Tools.AdminDSN)
		if err != nil {
			return
		}
		defer c.Close(context.Background())
		rows, _ := c.Query(context.Background(), "select datname from pg_database where datname like $1", fresh.Name+"_set_aside_%")
		var names []string
		for rows.Next() {
			var n string
			_ = rows.Scan(&n)
			names = append(names, n)
		}
		rows.Close()
		for _, n := range names {
			_, _ = c.Exec(context.Background(), "drop database if exists "+pgx.Identifier{n}.Sanitize()+" with (force)")
		}
	})
	if b, _ := os.ReadFile(filepath.Join(aside, "secrets", "master.key")); string(b) != "fresh-master-key" {
		t.Fatalf("fresh master key not set aside: %q", b)
	}
	// 3. apply: every check, then the checkpoint in place as the runtime's role, read-only, in quarantine.
	marker, rep, err := quarantine.Apply(ctx, cfg, opts)
	if err != nil {
		t.Fatalf("apply: %v (failed %v)", err, rep.Failed())
	}
	if marker.Restored.CheckpointID != ck.Manifest.ID || marker.OldAppliance.ApplianceID != old.Cfg.ApplianceID {
		t.Fatalf("marker %+v", marker)
	}
	oldKey, _ := os.ReadFile(filepath.Join(old.Cfg.Layout().Secrets(), "master.key"))
	if b, _ := os.ReadFile(filepath.Join(l.Secrets(), "master.key")); string(b) != string(oldKey) {
		t.Fatal("the old master key is not in place")
	}
	conn, err := pgx.Connect(ctx, fresh.DSN)
	if err != nil {
		t.Fatal(err)
	}
	var n int
	var owner string
	if err := conn.QueryRow(ctx, "select count(*) from messages where body like 'message %'").Scan(&n); err != nil || n != 250 {
		t.Fatalf("restored messages: %d %v", n, err)
	}
	if err := conn.QueryRow(ctx, "select tableowner from pg_tables where tablename = 'messages'").Scan(&owner); err != nil || owner != role {
		t.Fatalf("restored tables owned by %q, want the runtime's role %q (%v)", owner, role, err)
	}
	if _, err := conn.Exec(ctx, "insert into memory(agent, fact) values ('x', 'y')"); err == nil {
		t.Fatal("database writable in quarantine")
	}
	conn.Close(ctx)
	// 4. release after reconciliation: writable again.
	for id, r := range map[string]string{"old-appliance": "decommissioned", "revocations": "none-after-checkpoint",
		"endpoints": "reviewed", "provider-logins": "verified", "external-outcomes": "none", "identity-repin": "repinned"} {
		if _, err := quarantine.Resolve(cfg, id, r, "drill"); err != nil {
			t.Fatal(err)
		}
	}
	if err := quarantine.Release(ctx, cfg, admin, fresh.Name); err != nil {
		t.Fatal(err)
	}
	Exec(t, fresh.DSN, "set role "+pgx.Identifier{role}.Sanitize()+"; insert into memory(agent, fact) values ('after', 'release')")
}
