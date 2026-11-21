package quarantine

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/CybexBV/whombat/appliance/backup/internal/state"
)

func write(t *testing.T, p, s string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(s), 0o600); err != nil {
		t.Fatal(err)
	}
}

func read(p string) string { b, _ := os.ReadFile(p); return string(b) }

func testConfig(t *testing.T) *state.Config {
	c := &state.Config{Persist: filepath.Join(t.TempDir(), "persist"), ApplianceID: "apl-t"}
	c.Defaults()
	if err := os.MkdirAll(c.StateDir, 0o700); err != nil {
		t.Fatal(err)
	}
	return c
}

// A power cut while prepare was moving the fresh install aside: what is set aside is whole (a copy gets its name only
// once complete), what is still in the source may be half removed; the undo keeps the set-aside one, leaves the
// rest, and drops half copies. Nothing is emptied, since nothing was restored yet.
func TestUndoAfterPrepareWasCut(t *testing.T) {
	c := testConfig(t)
	home := c.Layout().Home()
	j, err := newJournal(c, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	write(t, filepath.Join(j.dir, "home", "files", "a"), "whole")
	write(t, filepath.Join(home, "files", "a"), "half rem")    // its removal was cut
	write(t, filepath.Join(home, "console.json"), "not moved") // never got to it
	write(t, filepath.Join(j.dir, "secrets", movingPrefix+"master.key", "x"), "half copy")
	write(t, filepath.Join(c.Layout().Secrets(), "master.key"), "key")
	if err := Undo(context.Background(), c, nil, j); err != nil {
		t.Fatal(err)
	}
	if read(filepath.Join(home, "files", "a")) != "whole" || read(filepath.Join(home, "console.json")) != "not moved" ||
		read(filepath.Join(c.Layout().Secrets(), "master.key")) != "key" {
		t.Fatal("the fresh install isn't back whole")
	}
	if _, err := os.Stat(j.dir); !os.IsNotExist(err) {
		t.Fatalf("the set-aside folder stays: %v", err)
	}
}

// A power cut while an undo was moving things back: the sources were emptied first, so an entry in a source is
// whole and its set-aside twin half removed; restored data never comes back; an undo run again finishes the job.
func TestUndoRunAgainAfterACut(t *testing.T) {
	c := testConfig(t)
	home := c.Layout().Home()
	j, err := newJournal(c, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	j.Prepared = true
	if err := j.save(); err != nil {
		t.Fatal(err)
	}
	write(t, filepath.Join(j.dir, "home", "a.txt"), "fresh a")
	write(t, filepath.Join(j.dir, "home", "b.txt"), "fresh b")
	write(t, filepath.Join(home, "restored.txt"), "from the backup")
	// The first undo emptied the sources and moved a.txt back, then the power went while b.txt's twin was removed.
	if err := emptyDir(home); err != nil {
		t.Fatal(err)
	}
	j.Emptied = true
	if err := j.save(); err != nil {
		t.Fatal(err)
	}
	write(t, filepath.Join(home, "a.txt"), "fresh a")
	write(t, filepath.Join(home, "b.txt"), "fresh b")
	write(t, filepath.Join(j.dir, "home", "b.txt"), "fresh")
	write(t, filepath.Join(home, movingPrefix+"c"), "half")
	js, _ := Journals(c)
	if len(js) != 1 || !js[0].Emptied {
		t.Fatalf("journal %+v", js)
	}
	if err := Undo(context.Background(), c, nil, js[0]); err != nil {
		t.Fatal(err)
	}
	ents, _ := os.ReadDir(home)
	if len(ents) != 2 || read(filepath.Join(home, "a.txt")) != "fresh a" || read(filepath.Join(home, "b.txt")) != "fresh b" {
		t.Fatalf("home after the second undo: %v", ents)
	}
}

// A restore from the app that a power cut stopped, whose undo can't finish either at the next start: the result still
// says it was cut, in the person's words, with the technical words kept apart; the box stays in quarantine.
func TestCutRestoreWhoseUndoFailsSaysInterrupted(t *testing.T) {
	if os.Getuid() == 0 {
		t.Skip("root removes a read-only folder's files")
	}
	c := testConfig(t)
	home := c.Layout().Home()
	j, err := newJournal(c, "", &AppJournal{CheckpointID: "ck-1", Stage: StageRestoring})
	if err != nil {
		t.Fatal(err)
	}
	j.Prepared = true
	if err := j.save(); err != nil {
		t.Fatal(err)
	}
	locked := filepath.Join(home, "locked")
	write(t, filepath.Join(locked, "restored.txt"), "from the backup")
	if err := os.Chmod(locked, 0o500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(locked, 0o700) })
	if err := Recover(context.Background(), c, nil, t.Logf); err == nil {
		t.Fatal("the undo finished")
	}
	r := LoadResult(c)
	if r == nil || r.OK || r.Reason != ReasonInterrupted || r.CheckpointID != "ck-1" || r.Error == "" || r.Detail == "" ||
		strings.Contains(r.Error, locked) {
		t.Fatalf("result %+v", r)
	}
	if m, _ := Load(c); m == nil || m.Phase != PhaseRestoring || m.Error == "" {
		t.Fatalf("not kept in quarantine: %+v", m)
	}
}
