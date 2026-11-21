package main

import (
	"os"
	"path/filepath"
	"testing"

	"rackoon/internal/hub/store"
)

// TestBackupFile: `backup --out` writes a plain tar (the box's hub.tar),
// gzipped only for a .tar.gz or .tgz name, 0600, and never over a file
// that is there.
func TestBackupFile(t *testing.T) {
	data := t.TempDir()
	st, err := store.Open(filepath.Join(data, "hub.db"))
	if err != nil {
		t.Fatal(err)
	}
	st.Close()
	out := t.TempDir()
	for name, gz := range map[string]bool{"hub.tar": false, "hosts-backup.tar.gz": true, "hosts.tgz": true, "hub.backup": false} {
		p := filepath.Join(out, name)
		if err := backup([]string{"--data", data, "--out", p}); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		b, err := os.ReadFile(p)
		if err != nil {
			t.Fatal(err)
		}
		if isGz := len(b) > 2 && b[0] == 0x1f && b[1] == 0x8b; isGz != gz {
			t.Errorf("%s: gzipped = %v", name, isGz)
		}
		if !gz && string(b[257:262]) != "ustar" {
			t.Errorf("%s isn't a tar", name)
		}
		if fi, _ := os.Stat(p); fi.Mode().Perm() != 0o600 {
			t.Errorf("%s: mode %v", name, fi.Mode())
		}
		if err := backup([]string{"--data", data, "--out", p}); err == nil {
			t.Errorf("%s: written over", name)
		}
	}
}
