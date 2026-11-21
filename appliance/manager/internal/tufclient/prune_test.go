package tufclient_test

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/CybexBV/whombat/appliance/manager/internal/tufclient"
)

// MG-60: after an update, staged files no tuple keeps (imported blobs, old closures, partial downloads) go.
func TestPruneKeepsOnlyKept(t *testing.T) {
	dir := t.TempDir()
	write := func(name string, n int) {
		if err := os.WriteFile(filepath.Join(dir, name), make([]byte, n), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("aaaa", 10)      // kept (current tuple's index)
	write("bbbb", 20)      // an imported blob
	write("cccc.part", 30) // a partial download nobody resumes
	write("aaaa.part", 5)  // a kept artifact's partial download stays
	if err := os.Mkdir(filepath.Join(dir, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	d := &tufclient.Downloader{StagingDir: dir}
	n, b := d.Prune(map[string]bool{"aaaa": true})
	if n != 2 || b != 50 {
		t.Fatalf("pruned %d files, %d bytes; want 2, 50", n, b)
	}
	for _, keep := range []string{"aaaa", "aaaa.part", "sub"} {
		if _, err := os.Stat(filepath.Join(dir, keep)); err != nil {
			t.Fatalf("%s was removed", keep)
		}
	}
	if n, _ := d.Prune(map[string]bool{"aaaa": true}); n != 0 {
		t.Fatalf("second prune removed %d files", n)
	}
}
