package quarantine

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/sys/unix"
)

// On the appliance every source is its own btrfs subvolume: a restored tree can't be renamed into it
// (EXDEV). moveInto fills the existing directory instead, copying what can't be renamed; here across two
// filesystems (the test's TMPDIR and /dev/shm).
func TestMoveIntoAcrossFilesystems(t *testing.T) {
	shm, err := os.MkdirTemp("/dev/shm", "whombat-bk-move-")
	if err != nil {
		t.Skip("no /dev/shm")
	}
	defer os.RemoveAll(shm)
	src := t.TempDir()
	var a, b unix.Stat_t
	if unix.Stat(src, &a) != nil || unix.Stat(shm, &b) != nil || a.Dev == b.Dev {
		t.Skip("TMPDIR and /dev/shm are one filesystem")
	}
	_ = os.MkdirAll(filepath.Join(src, "files", "sha256", "ab"), 0o750)
	_ = os.WriteFile(filepath.Join(src, "files", "sha256", "ab", "blob"), []byte("data"), 0o640)
	_ = os.WriteFile(filepath.Join(src, "master.key"), []byte("k"), 0o600)
	_ = os.Symlink("files/sha256", filepath.Join(src, "link"))
	dst := filepath.Join(shm, "home") // exists, like a subvolume, with its own mode
	_ = os.Mkdir(dst, 0o700)
	if err := moveInto(context.Background(), src, dst); err != nil {
		t.Fatal(err)
	}
	if b, err := os.ReadFile(filepath.Join(dst, "files", "sha256", "ab", "blob")); err != nil || string(b) != "data" {
		t.Fatalf("%q %v", b, err)
	}
	if fi, _ := os.Stat(filepath.Join(dst, "master.key")); fi == nil || fi.Mode().Perm() != 0o600 {
		t.Fatalf("mode not kept: %v", fi)
	}
	if fi, _ := os.Stat(dst); fi.Mode().Perm() != 0o700 {
		t.Fatalf("the target directory changed mode: %v", fi.Mode())
	}
	if target, _ := os.Readlink(filepath.Join(dst, "link")); target != "files/sha256" {
		t.Fatalf("symlink %q", target)
	}
	if ents, _ := os.ReadDir(src); len(ents) != 0 {
		t.Fatalf("source not emptied: %v", ents)
	}
}
