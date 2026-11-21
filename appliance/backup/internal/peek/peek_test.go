package peek

import (
	"os"
	"path/filepath"
	"syscall"
	"testing"

	"github.com/CybexBV/whombat/appliance/backup/pkg/manifest"
)

// The restored tree becomes readable and never writable by the group; a FIFO (a reader would block on it) goes; a
// symlink stays a symlink.
func TestReadableBy(t *testing.T) {
	root := t.TempDir()
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	must(os.MkdirAll(filepath.Join(root, "home", "files"), 0o700))
	must(os.WriteFile(filepath.Join(root, "home", "files", "a"), []byte("a"), 0o600))
	must(os.WriteFile(filepath.Join(root, "home", "tool"), []byte("#!/bin/sh"), 0o700))
	must(os.Symlink("/etc/passwd", filepath.Join(root, "home", "link")))
	must(syscall.Mkfifo(filepath.Join(root, "home", "fifo"), 0o600))
	must(readableBy(root, os.Getgid()))
	for rel, want := range map[string]os.FileMode{"home": 0o750, "home/files": 0o750, "home/files/a": 0o640, "home/tool": 0o750} {
		fi, err := os.Lstat(filepath.Join(root, rel))
		if err != nil || fi.Mode().Perm() != want {
			t.Fatalf("%s: %v %v, want %v", rel, fi.Mode(), err, want)
		}
	}
	if fi, err := os.Lstat(filepath.Join(root, "home", "link")); err != nil || fi.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("the symlink: %v %v", fi, err)
	}
	if _, err := os.Lstat(filepath.Join(root, "home", "fifo")); !os.IsNotExist(err) {
		t.Fatalf("the FIFO stayed: %v", err)
	}
}

// The room is the dump twice, the runtime sources the checkpoint has, and the reserve; credentials, secrets and the
// servers are never restored.
func TestNeeds(t *testing.T) {
	m := &manifest.Manifest{Database: manifest.Database{Dump: manifest.File{Size: 100}}, Sources: []manifest.Source{
		{Name: "home", SnapshotPath: "files/home", Bytes: 10}, {Name: "workspaces", SnapshotPath: "files/workspaces", Bytes: 20},
		{Name: "credentials", SnapshotPath: "files/credentials", Bytes: 1000}, {Name: "secrets", SnapshotPath: "files/secrets", Bytes: 1000},
		{Name: "hermes", SnapshotPath: "files/hermes", Missing: true}, {Name: "hosts", SnapshotPath: "files/hosts", Bytes: 1000}}}
	need, include := needs(m, 5)
	if need != 2*100+10+20+5 {
		t.Fatalf("need %d", need)
	}
	want := []string{"/db/whombat.pgdump", "/files/home", "/files/workspaces"}
	if len(include) != len(want) {
		t.Fatalf("include %v", include)
	}
	for i := range want {
		if include[i] != want[i] {
			t.Fatalf("include %v", include)
		}
	}
}
