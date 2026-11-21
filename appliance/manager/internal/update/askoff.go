package update

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
	"time"

	"github.com/CybexBV/whombat/appliance/manager/internal/journal"
)

// AskOffNote is the journal's history note for the switch turned off at the box.
const AskOffNote = "ask before updating turned off at the box (recovery menu)"

// AskOffAtTheBox turns the owner's “Ask before updating” off in the update journal at dir while no manager runs on it,
// and ends an approval with it. It is the recovery menu's choice at the box itself (hold Space at power-on): the
// owner's way out when the apps can't take their yes, for example after a release that broke them while its fix waits
// for that yes (Whombat ask-before-updating.md). Whoever is at the box's console can already read or erase its data,
// so it asks no more than the menu's other actions do.
//
// It edits the newest state as it is on disk, so whatever a newer manager wrote there stays, and gives the journal's
// files back to the folder's owner (the manager's user; the menu runs as root). It returns the release that waited
// for the owner, if one did, and whether anything changed.
func AskOffAtTheBox(dir string, now time.Time) (waiting string, changed bool, err error) {
	fi, err := os.Stat(dir)
	if err != nil {
		return "", false, fmt.Errorf("the update journal: %w", err)
	}
	if !fi.IsDir() {
		return "", false, fmt.Errorf("the update journal %s is not a folder", dir)
	}
	j, err := journal.Open(dir)
	if err != nil {
		return "", false, err
	}
	var raw map[string]json.RawMessage
	_, found, err := j.LoadSeq(&raw)
	if err != nil {
		return "", false, err
	}
	if !found {
		return "", false, ErrNotProvisioned
	}
	b, err := json.Marshal(raw)
	if err != nil {
		return "", false, err
	}
	var st State
	if err := json.Unmarshal(b, &st); err != nil {
		return "", false, fmt.Errorf("journal state: %w", err)
	}
	if c := st.Candidate; c != nil && c.Tuple != nil && c.Deferral != nil && c.Deferral.Waiting == "owner" {
		waiting = c.Tuple.ReleaseID
	}
	if !st.AskFirst && st.Approved == "" {
		return waiting, false, nil
	}
	delete(raw, "askFirst")
	delete(raw, "approved")
	if raw["history"], err = withHistory(raw["history"], HistoryEntry{At: now.UTC(), From: st.Phase, To: st.Phase,
		ReleaseID: waiting, Note: AskOffNote}); err != nil {
		return "", false, err
	}
	if _, err := j.SaveSeq(raw); err != nil {
		return "", false, err
	}
	if err := giveBack(dir, fi); err != nil {
		return "", false, err
	}
	return waiting, true, nil
}

// withHistory appends e to the journal's history as it is on disk, keeping the newest maxHistory entries.
func withHistory(history json.RawMessage, e HistoryEntry) (json.RawMessage, error) {
	var entries []json.RawMessage
	if len(history) > 0 {
		if err := json.Unmarshal(history, &entries); err != nil {
			return nil, fmt.Errorf("journal history: %w", err)
		}
	}
	b, err := json.Marshal(e)
	if err != nil {
		return nil, err
	}
	entries = append(entries, b)
	if len(entries) > maxHistory {
		entries = entries[len(entries)-maxHistory:]
	}
	return json.Marshal(entries)
}

// giveBack gives the journal's files the owner of their folder: written by root, the manager couldn't read them.
func giveBack(dir string, fi os.FileInfo) error {
	owner, ok := fi.Sys().(*syscall.Stat_t)
	if !ok {
		return nil
	}
	for _, name := range []string{"journal.a.json", "journal.b.json"} {
		err := os.Lchown(filepath.Join(dir, name), int(owner.Uid), int(owner.Gid))
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	return nil
}
