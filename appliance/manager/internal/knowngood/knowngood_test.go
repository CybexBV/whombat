package knowngood

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func mkManager(t *testing.T, store, name string) string {
	t.Helper()
	p := filepath.Join(store, name)
	if err := os.MkdirAll(filepath.Join(p, "bin"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(p, Binary), []byte("#!/bin/sh\n"), 0o555); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestSelectFromStorePaths(t *testing.T) {
	store := t.TempDir()
	cur := mkManager(t, store, "aaaa-whombat-manager-0.5.2")
	prev := mkManager(t, store, "bbbb-whombat-manager-0.5.1")
	got, err := Select([]string{cur, prev}, store)
	if err != nil || got != filepath.Join(cur, Binary) {
		t.Fatalf("%s %v", got, err)
	}
	// Current garbage-collected: the previous known-good host's manager.
	os.RemoveAll(cur)
	if got, err := Select([]string{cur, prev}, store); err != nil || got != filepath.Join(prev, Binary) {
		t.Fatalf("%s %v", got, err)
	}
	if _, err := Select(nil, store); !errors.Is(err, ErrNone) {
		t.Fatalf("none: %v", err)
	}
}

// Regression for M-3 (W4-SEC part 2): the reviewer replaced the known-good copy under
// /persist/manager/known-good together with a matching manifest and Select returned the implant. Paths
// outside the store, and store entries whose binary points out of the store, are never selected.
func TestSelectRefusesManagerWritableLocations(t *testing.T) {
	store := t.TempDir()
	persist := t.TempDir()
	implant := filepath.Join(persist, "known-good", "current")
	if err := os.MkdirAll(filepath.Join(implant, "bin"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(implant, Binary), []byte("#!/bin/sh\necho implant\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := Select([]string{implant}, store); !errors.Is(err, ErrNone) {
		t.Fatalf("implant outside the store selected: %v", err)
	}
	// A store entry whose binary is a symlink to manager-writable state.
	p := filepath.Join(store, "cccc-whombat-manager-evil")
	os.MkdirAll(filepath.Join(p, "bin"), 0o755)
	os.Symlink(filepath.Join(implant, Binary), filepath.Join(p, Binary))
	if _, err := Select([]string{p}, store); !errors.Is(err, ErrNone) {
		t.Fatalf("symlink out of the store selected: %v", err)
	}
	// Traversal in the path.
	if _, err := Select([]string{filepath.Join(store, "..", filepath.Base(persist))}, store); !errors.Is(err, ErrNone) {
		t.Fatalf("traversal selected: %v", err)
	}
	// In production only syntactically valid store paths are considered.
	if _, err := Select([]string{"/nix/store/not-a-store-path"}, StoreDir); !errors.Is(err, ErrNone) {
		t.Fatalf("invalid store path selected: %v", err)
	}
}
