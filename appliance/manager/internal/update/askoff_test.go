package update_test

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/manager/internal/journal"
	"github.com/CybexBV/whombat/appliance/manager/internal/testworld"
	"github.com/CybexBV/whombat/appliance/manager/internal/update"
)

// The recovery menu at the box turns “Ask before updating” off while no manager runs: the owner's way out when the
// apps can't take their yes. After the restart the update that waited goes ahead by itself.

func TestAskOffAtTheBoxLetsTheWaitingUpdateGo(t *testing.T) {
	t.Parallel()
	w := testworld.New(t)
	fast(w)
	askFirst(t, w, true)
	mustOffer(t, w, testworld.RuntimeGood, update.DecisionStarted)
	run(t, w, 200, waitsForOwner(testworld.RuntimeGood))

	waiting, changed, err := update.AskOffAtTheBox(w.P.Journal, w.Clock.Now())
	if err != nil || !changed || waiting != testworld.RuntimeGood {
		t.Fatalf("waiting %q changed %v err %v", waiting, changed, err)
	}
	w.NewEngine() // the box starts again
	run(t, w, 400, testworld.PhaseIs(update.Healthy))
	st := w.State()
	if st.Current.ReleaseID != testworld.RuntimeGood || st.AskFirst || st.Approved != "" {
		t.Fatalf("current %s ask %v approved %q", st.Current.ReleaseID, st.AskFirst, st.Approved)
	}
	if !hasNote(st, update.AskOffNote) {
		t.Fatalf("history %+v", st.History)
	}
}

// An approval given before goes with the switch: the next time the switch is on, every release asks again.
func TestAskOffAtTheBoxEndsAnApproval(t *testing.T) {
	t.Parallel()
	w := testworld.New(t)
	fast(w)
	askFirst(t, w, true)
	mustOffer(t, w, testworld.RuntimeGood, update.DecisionStarted)
	run(t, w, 200, waitsForOwner(testworld.RuntimeGood))
	approve(t, w, testworld.RuntimeGood)
	if _, changed, err := update.AskOffAtTheBox(w.P.Journal, w.Clock.Now()); err != nil || !changed {
		t.Fatalf("changed %v err %v", changed, err)
	}
	w.NewEngine()
	if st := w.State(); st.AskFirst || st.Approved != "" {
		t.Fatalf("ask %v approved %q", st.AskFirst, st.Approved)
	}
}

// With the switch off already nothing is written.
func TestAskOffAtTheBoxWithTheSwitchOff(t *testing.T) {
	t.Parallel()
	w := testworld.New(t)
	before := w.State().JournalSeq
	waiting, changed, err := update.AskOffAtTheBox(w.P.Journal, w.Clock.Now())
	if err != nil || changed || waiting != "" {
		t.Fatalf("waiting %q changed %v err %v", waiting, changed, err)
	}
	w.NewEngine()
	if w.State().JournalSeq != before {
		t.Fatalf("journal moved from %d to %d", before, w.State().JournalSeq)
	}
}

// The menu's environment may be older or newer than the manager that wrote the journal: what it doesn't know stays.
func TestAskOffAtTheBoxKeepsWhatItDoesNotKnow(t *testing.T) {
	t.Parallel()
	dir := filepath.Join(t.TempDir(), "journal")
	j, err := journal.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	state := map[string]any{"phase": "Healthy", "askFirst": true, "approved": "r1", "fromANewerManager": map[string]any{"kept": true}}
	if err := j.Save(state); err != nil {
		t.Fatal(err)
	}
	if _, changed, err := update.AskOffAtTheBox(dir, time.Unix(1_800_000_000, 0)); err != nil || !changed {
		t.Fatalf("changed %v err %v", changed, err)
	}
	var raw map[string]json.RawMessage
	if _, err := j.Load(&raw); err != nil {
		t.Fatal(err)
	}
	if _, ok := raw["askFirst"]; ok {
		t.Fatalf("askFirst still there: %s", raw["askFirst"])
	}
	if _, ok := raw["approved"]; ok {
		t.Fatalf("approved still there: %s", raw["approved"])
	}
	if string(raw["fromANewerManager"]) != `{"kept":true}` {
		t.Fatalf("a newer manager's field: %s", raw["fromANewerManager"])
	}
	var history []update.HistoryEntry
	if err := json.Unmarshal(raw["history"], &history); err != nil || len(history) != 1 || history[0].Note != update.AskOffNote {
		t.Fatalf("history %s (%v)", raw["history"], err)
	}
	if _, changed, err := update.AskOffAtTheBox(dir, time.Unix(1_800_000_060, 0)); err != nil || changed {
		t.Fatalf("again: changed %v err %v", changed, err)
	}
}

// No journal, or an empty one: nothing to change, and no folder made.
func TestAskOffAtTheBoxWithoutAJournal(t *testing.T) {
	t.Parallel()
	missing := filepath.Join(t.TempDir(), "manager", "journal")
	if _, _, err := update.AskOffAtTheBox(missing, time.Now()); err == nil {
		t.Fatal("a missing journal was accepted")
	}
	if _, err := os.Stat(missing); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("the folder was made: %v", err)
	}
	if _, _, err := update.AskOffAtTheBox(t.TempDir(), time.Now()); !errors.Is(err, update.ErrNotProvisioned) {
		t.Fatalf("an empty journal: %v", err)
	}
}

func hasNote(st *update.State, note string) bool {
	for _, h := range st.History {
		if h.Note == note {
			return true
		}
	}
	return false
}
