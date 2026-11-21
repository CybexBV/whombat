package state

import (
	"strings"
	"testing"
	"time"
)

func TestDeriveStatesAndContract(t *testing.T) {
	c := &Config{Persist: t.TempDir()}
	c.Defaults()
	now := time.Date(2026, 9, 25, 12, 0, 0, 0, time.UTC)
	s := &Status{}
	Derive(c, s, nil, now)
	if s.State != StateUnprotected || s.Protected || s.Destination.Configured {
		t.Fatalf("no destination: %+v", s)
	}
	if err := s.Validate(); err != nil {
		t.Fatal(err)
	}
	d := &Destination{Kind: "restic-rest", Repository: "rest:https://backup.example/a/", RepositoryID: "abc", AppendOnly: "verified", Generation: 2}
	Derive(c, s, d, now)
	if s.State != StatePending {
		t.Fatalf("pending: %s", s.State)
	}
	ok := true
	s.LastAttemptOK = &ok
	s.LastSuccess = &Success{ID: "ck-1", At: now.Add(-time.Hour), SnapshotID: "s", Method: "snapshot"}
	Derive(c, s, d, now)
	if s.State != StateProtected || !s.Protected || s.LastSuccess.AgeSeconds != 3600 || s.KitGeneration != 2 {
		t.Fatalf("protected: %+v", s)
	}
	Derive(c, s, d, now.Add(48*time.Hour))
	if s.State != StateStale {
		t.Fatalf("stale: %s", s.State)
	}
	bad := false
	s.LastAttemptOK = &bad
	s.LastFailure = &Failure{ID: "ck-2", At: now, Stage: "inventory", Reason: "couldn’t reach “safe”\nmoment → retry"}
	s.Recoverability.LastDrill = &Drill{At: now, OK: true, CheckpointID: "ck-1", RTOSeconds: 3, BackupAgeSeconds: -5, Failed: nil, Skipped: []string{"audit-chain"}}
	Derive(c, s, d, now)
	if s.State != StateProtected || s.FailedAttempts != 1 {
		t.Fatalf("one failed try while the backups aren't late is a blip, not failing: %+v", s)
	}
	Derive(c, s, d, now.Add(48*time.Hour))
	if s.State != StateFailing {
		t.Fatalf("a failed try while the backups are late: %s", s.State)
	}
	s.FailedAttempts = FailingAfter
	Derive(c, s, d, now)
	if s.State != StateFailing || s.LastSuccess == nil {
		t.Fatalf("failing: %+v", s)
	}
	if s.LastFailure.Stage != "preflight" || s.LastFailure.Reason != "couldn’t reach “safe” moment → retry" {
		t.Fatalf("sanitized failure %+v", s.LastFailure)
	}
	if s.Recoverability.LastDrill.BackupAgeSeconds != 0 {
		t.Fatal("negative age not clamped")
	}
	if err := s.Validate(); err != nil {
		t.Fatalf("contract: %v", err)
	}
	s.LastAttemptOK = &ok
	Derive(c, s, d, now)
	if s.FailedAttempts != 0 || s.State != StateProtected {
		t.Fatalf("a success resets the count: %+v", s)
	}
	none := &Status{LastAttemptOK: &bad, FailedAttempts: 1}
	Derive(c, none, d, now)
	if none.State != StatePending {
		t.Fatalf("the first backup failing once: %s", none.State)
	}
	s.LastFailure.Reason = strings.Repeat("é", 900)
	sanitize(s)
	if r := []rune(s.LastFailure.Reason); len(r) != 500 || r[499] != '…' {
		t.Fatal("reason not cut to 500 characters")
	}
	if err := s.Validate(); err != nil {
		t.Fatalf("contract with a reason in another script: %v", err)
	}
}

// A sentence for people stays in its own script on one line: curly quotes, accents and other scripts are kept;
// newlines, tabs, control, zero-width and direction marks and other separators become one space; invalid bytes
// U+FFFD; the cap counts characters.
func TestOneLine(t *testing.T) {
	for in, want := range map[string]string{
		"Whombat couldn’t reach “the NAS”.":         "Whombat couldn’t reach “the NAS”.",
		"  first line\r\n\tsecond\u00a0line  ":      "first line second line",
		"zero\u200bwidth \u202eturned\u2028sep\x7f": "zero width turned sep",
		"日本語のバックアップ · ок":                           "日本語のバックアップ · ок",
		"bad \xff byte":                             "bad \ufffd byte",
	} {
		if got := OneLine(in, 500); got != want {
			t.Errorf("OneLine(%q) = %q, want %q", in, got, want)
		}
	}
	if got := OneLine("ab cdef", 4); got != "ab…" {
		t.Errorf("cut: %q", got)
	}
	if got := OneLine("abcd", 4); got != "abcd" {
		t.Errorf("not cut at the cap: %q", got)
	}
}
