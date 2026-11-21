package atomicfile

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestWriteAndCrashPoints(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "state.json")
	if err := WriteFile(p, []byte("old"), 0o600); err != nil {
		t.Fatal(err)
	}
	crash := errors.New("crash")
	for _, point := range []string{"after-temp-sync", "after-rename"} {
		FaultHook = func(pt, _ string) error {
			if pt == point {
				return crash
			}
			return nil
		}
		err := WriteFile(p, []byte("new-"+point), 0o600)
		FaultHook = nil
		if !errors.Is(err, crash) {
			t.Fatalf("%s: want crash, got %v", point, err)
		}
		got, _ := os.ReadFile(p)
		if point == "after-temp-sync" && string(got) != "old" {
			t.Fatalf("before rename content must be old, got %q", got)
		}
		if point == "after-rename" && string(got) != "new-after-rename" {
			t.Fatalf("after rename content must be new, got %q", got)
		}
	}
	CleanTemps(dir)
	entries, _ := os.ReadDir(dir)
	if len(entries) != 1 {
		t.Fatalf("temps left: %v", entries)
	}
	st, _ := os.Stat(p)
	if st.Mode().Perm() != 0o600 {
		t.Fatalf("perm %v", st.Mode())
	}
}
