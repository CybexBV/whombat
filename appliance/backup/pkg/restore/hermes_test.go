package restore

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/CybexBV/whombat/appliance/backup/pkg/manifest"
)

func write(t *testing.T, p, s string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(s), 0o600); err != nil {
		t.Fatal(err)
	}
}

// The checkpoint's record of the agent's Hermes home (BK-36, NX-466): the person's SQLite stores at the home's root
// and the outsiders' profile's, each with its write-ahead log, and the skills outside their hidden folders; the
// restore check holds a restored tree to it.
func TestHermesRecordAndCheck(t *testing.T) {
	root := t.TempDir()
	h := filepath.Join(root, manifest.FilesDir, "hermes")
	write(t, filepath.Join(h, "state.db"), "db")
	write(t, filepath.Join(h, "state.db-wal"), "wal")
	write(t, filepath.Join(h, "memories", "MEMORY.md"), "likes tabs")
	write(t, filepath.Join(h, "sessions", "s1.json"), "{}")
	write(t, filepath.Join(h, "profiles", "_feedback", "state.db"), "db2")
	write(t, filepath.Join(h, "profiles", "_feedback", "deeper", "x.db"), "not a store")
	write(t, filepath.Join(h, "skills", "ops", "deploy", "SKILL.md"), "---\nname: deploy\n---\n")
	write(t, filepath.Join(h, "skills", "mine", "learned", "SKILL.md"), "---\nname: learned\n---\n")
	write(t, filepath.Join(h, "skills", ".archive", "ops", "old", "SKILL.md"), "off")
	if err := os.Symlink("/etc/passwd", filepath.Join(h, "evil.db")); err != nil {
		t.Fatal(err)
	}
	got, err := ReadHermes(h)
	if err != nil {
		t.Fatal(err)
	}
	paths := []string{}
	for _, f := range got.Stores {
		paths = append(paths, f.Path)
	}
	want := []string{"files/hermes/profiles/_feedback/state.db", "files/hermes/state.db", "files/hermes/state.db-wal"}
	if strings.Join(paths, ",") != strings.Join(want, ",") || got.Skills != 2 {
		t.Fatalf("record %v %d", paths, got.Skills)
	}
	m := &manifest.Manifest{Hermes: got}
	if detail, err := verifyHermes(root, m); err != nil || !strings.Contains(detail, "3 SQLite stores") {
		t.Fatalf("intact: %q %v", detail, err)
	}
	write(t, filepath.Join(h, "state.db-wal"), "other")
	if err := os.RemoveAll(filepath.Join(h, "profiles", "_feedback")); err != nil {
		t.Fatal(err)
	}
	_, err = verifyHermes(root, m)
	if err == nil || !strings.Contains(err.Error(), "_feedback/state.db: missing") || !strings.Contains(err.Error(), "state.db-wal: differs") {
		t.Fatalf("damaged: %v", err)
	}
	// No home at all: an empty record, not a failure.
	empty, err := ReadHermes(filepath.Join(root, "nothing"))
	if err != nil || len(empty.Stores) != 0 || empty.Skills != 0 {
		t.Fatalf("empty %+v %v", empty, err)
	}
}
