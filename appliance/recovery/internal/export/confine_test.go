package export

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/CybexBV/whombat/appliance/backup/pkg/gitinv"
	"github.com/CybexBV/whombat/appliance/backup/pkg/manifest"
	"github.com/CybexBV/whombat/appliance/backup/pkg/pgtool"
	"github.com/CybexBV/whombat/appliance/backup/pkg/restore"
)

// maliciousWorld lays out a restored checkpoint in out/.restore as a compromised appliance could sign it.
func maliciousWorld(t *testing.T) (base, out, work string, o Options) {
	t.Helper()
	base = t.TempDir()
	out = filepath.Join(base, "export")
	work = filepath.Join(out, ".restore")
	for _, p := range []string{manifest.ManifestPath, manifest.SigPath, manifest.DumpPath, "files/evil/authorized_keys", "files/home/x"} {
		full := filepath.Join(work, filepath.FromSlash(p))
		if err := os.MkdirAll(filepath.Dir(full), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte("attacker content\n"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	bins := filepath.Join(base, "bin")
	_ = os.MkdirAll(bins, 0o755)
	// stand-in pg_restore: writes the --file= target
	_ = os.WriteFile(filepath.Join(bins, "pg_restore"), []byte("#!/bin/sh\nfor a; do case $a in --file=*) echo sql > \"${a#--file=}\";; esac; done\n"), 0o755)
	return base, out, work, Options{Restore: restore.Options{Bins: pgtool.Bins{Dir: bins}}, Out: out}
}

// Regression for M-4 (W4-SEC part 2): manifest fields never place anything outside -out. The reviewer's
// PoC (source name "../../victim-home/.ssh") wrote authorized_keys next to the export.
func TestExportRefusesManifestPathsOutsideOut(t *testing.T) {
	cases := map[string]*manifest.Manifest{
		"source name traversal": {Sources: []manifest.Source{{Name: "../../victim-home/.ssh", SnapshotPath: "files/evil"}}},
		"unknown source":        {Sources: []manifest.Source{{Name: "evil", SnapshotPath: "files/evil"}}},
		"snapshot path":         {Sources: []manifest.Source{{Name: "home", SnapshotPath: "files/../../evil"}}},
		"absolute snapshot":     {Sources: []manifest.Source{{Name: "home", SnapshotPath: "/etc"}}},
		"repo traversal":        {Repos: []gitinv.Repo{{Path: "files/../../../victim-home/.ssh/x.git", Kind: "bare"}}},
		"repo absolute":         {Repos: []gitinv.Repo{{Path: "/home/victim/.ssh/x.git", Kind: "bare"}}},
		"repo outside files":    {Repos: []gitinv.Repo{{Path: "manifest/x.git", Kind: "bare"}}},
	}
	for name, m := range cases {
		t.Run(name, func(t *testing.T) {
			base, _, work, o := maliciousWorld(t)
			err := layout(context.Background(), o, work, m, &Result{})
			if !errors.Is(err, manifest.ErrBadPath) {
				t.Fatalf("layout accepted the manifest: %v", err)
			}
			if _, err := os.Stat(filepath.Join(base, "victim-home")); err == nil {
				t.Fatal("tree written outside -out")
			}
		})
	}
}

// A symlink planted under -out (e.g. by a restored tree) is never written through.
func TestExportRefusesSymlinkInOut(t *testing.T) {
	base, out, work, o := maliciousWorld(t)
	victim := filepath.Join(base, "victim")
	if err := os.MkdirAll(victim, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(victim, filepath.Join(out, "database")); err != nil {
		t.Fatal(err)
	}
	m := &manifest.Manifest{Sources: []manifest.Source{{Name: "home", SnapshotPath: "files/home"}}}
	if err := layout(context.Background(), o, work, m, &Result{}); !errors.Is(err, manifest.ErrBadPath) {
		t.Fatalf("layout wrote through a symlink: %v", err)
	}
	if ents, _ := os.ReadDir(victim); len(ents) > 0 {
		t.Fatalf("files written through the symlink: %v", ents)
	}
}

// The validation is part of manifest verification, so restore and quarantine refuse such a manifest too.
func TestManifestVerifyRefusesBadPaths(t *testing.T) {
	m := &manifest.Manifest{Kind: manifest.Kind, Sources: []manifest.Source{{Name: "../x", SnapshotPath: "files/../x"}}}
	if err := m.ValidatePaths(); !errors.Is(err, manifest.ErrBadPath) {
		t.Fatalf("ValidatePaths: %v", err)
	}
	good := &manifest.Manifest{Kind: manifest.Kind, Sources: []manifest.Source{{Name: "home", SnapshotPath: "files/home"},
		{Name: "workspaces", SnapshotPath: "files/workspaces"}}, Repos: []gitinv.Repo{{Path: "files/workspaces/b/r/main"}}}
	if err := good.ValidatePaths(); err != nil {
		t.Fatalf("valid layout refused: %v", err)
	}
}
