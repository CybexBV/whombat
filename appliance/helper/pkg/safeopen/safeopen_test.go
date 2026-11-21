package safeopen

import (
	"errors"
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

func TestOpenRegular(t *testing.T) {
	d := t.TempDir()
	ok := filepath.Join(d, "dir", "f")
	os.MkdirAll(filepath.Dir(ok), 0o755)
	os.WriteFile(ok, []byte("hello"), 0o644)
	if b, err := ReadSmall(ok, 16); err != nil || string(b) != "hello" {
		t.Fatalf("%q %v", b, err)
	}
	if _, err := ReadSmall(ok, 2); err == nil {
		t.Fatal("size limit ignored")
	}
	if _, err := OpenRegular(filepath.Join(d, "missing")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("missing: %v", err)
	}
	// A symlinked directory (the manager replacing staging/ or tuf/mirror/ with a link) is refused.
	elsewhere := filepath.Join(d, "elsewhere")
	os.MkdirAll(elsewhere, 0o755)
	os.WriteFile(filepath.Join(elsewhere, "f"), []byte("secret"), 0o600)
	os.Symlink(elsewhere, filepath.Join(d, "link"))
	if _, err := OpenRegular(filepath.Join(d, "link", "f")); !errors.Is(err, ErrSymlink) {
		t.Fatalf("symlinked directory: %v", err)
	}
	os.Symlink(filepath.Join(elsewhere, "f"), filepath.Join(d, "flink"))
	if _, err := OpenRegular(filepath.Join(d, "flink")); !errors.Is(err, ErrSymlink) {
		t.Fatalf("symlinked file: %v", err)
	}
	if _, err := OpenRegular(filepath.Join(d, "dir")); !errors.Is(err, ErrNotRegular) {
		t.Fatalf("directory: %v", err)
	}
}

// Regression for L-6 (W4-SEC part 2): a FIFO in a manager-controlled directory made the helper block
// in open(2) while holding its mutex. Now it is refused at once.
func TestFIFORefusedWithoutBlocking(t *testing.T) {
	fifo := filepath.Join(t.TempDir(), "0123abcd")
	if err := syscall.Mkfifo(fifo, 0o644); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { _, err := OpenRegular(fifo); done <- err }()
	select {
	case err := <-done:
		if !errors.Is(err, ErrNotRegular) {
			t.Fatalf("fifo: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("open of a FIFO blocked")
	}
}

func TestWalkFallback(t *testing.T) {
	d := t.TempDir()
	os.WriteFile(filepath.Join(d, "f"), []byte("x"), 0o644)
	os.Symlink(d, filepath.Join(d, "l"))
	fd, err := walk(filepath.Join(d, "f"))
	if err != nil {
		t.Fatal(err)
	}
	syscall.Close(fd)
	if _, err := walk(filepath.Join(d, "l", "f")); err == nil {
		t.Fatal("walk followed a symlink")
	}
}
