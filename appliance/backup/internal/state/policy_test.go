package state

import (
	"testing"
	"time"
)

func TestPolicyDue(t *testing.T) {
	p := DefaultPolicy()
	p.TimeZone = "Europe/Amsterdam"
	now := time.Date(2026, 11, 4, 14, 20, 0, 0, time.UTC) // 15:20 in Amsterdam
	slot := p.LastSlot(now)
	if got := slot.In(time.UTC); !got.Equal(time.Date(2026, 11, 4, 14, 0, 0, 0, time.UTC)) {
		t.Fatalf("slot %v", got)
	}
	before := time.Date(2026, 11, 4, 13, 50, 0, 0, time.UTC)
	after := time.Date(2026, 11, 4, 14, 5, 0, 0, time.UTC)
	if due, _ := p.Due(DueInput{Now: now, LastSuccess: &before}); !due {
		t.Fatal("nothing since 15:00 → due")
	}
	if due, _ := p.Due(DueInput{Now: now, LastSuccess: &after}); due {
		t.Fatal("backed up since 15:00 → not due")
	}
	if due, _ := p.Due(DueInput{Now: now, LastSuccess: &after, DestinationChanged: true}); !due {
		t.Fatal("a new destination is always due")
	}
	failed := now.Add(-5 * time.Minute)
	if due, _ := p.Due(DueInput{Now: now, LastSuccess: &before, LastFailure: &failed}); due {
		t.Fatal("a failure 5 minutes ago waits")
	}
	if due, _ := p.Due(DueInput{Now: now}); !due {
		t.Fatal("no backup yet → due")
	}
	p.Frequency = FrequencyNightly
	if due, _ := p.Due(DueInput{Now: now, LastSuccess: &before}); due {
		t.Fatal("nightly: backed up since 03:00")
	}
	if p.StaleAfter() != 38*time.Hour {
		t.Fatalf("stale %v", p.StaleAfter())
	}
}

// A nightly slot whose hour the clock skips that day (Chatham's summer time starts at 02:45, so 03:00 doesn't exist on
// 27 September 2026) is moved past the gap, not lost.
func TestSlotSkippedBySummerTime(t *testing.T) {
	p := DefaultPolicy()
	p.Frequency, p.TimeZone = FrequencyNightly, "Pacific/Chatham"
	loc, err := time.LoadLocation(p.TimeZone)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 9, 27, 6, 0, 0, 0, loc)
	slot := p.LastSlot(now).In(loc)
	if y, m, d := slot.Date(); y != 2026 || m != 9 || d != 27 {
		t.Fatalf("slot %v: the day's slot was lost", slot)
	}
	yesterday := time.Date(2026, 9, 26, 3, 30, 0, 0, loc)
	if due, why := p.Due(DueInput{Now: now, LastSuccess: &yesterday}); !due {
		t.Fatalf("not due on the day summer time began: %s", why)
	}
	// A day the hour happens twice (summer time ends) still has one slot.
	p.TimeZone = "Europe/Amsterdam"
	ams, _ := time.LoadLocation(p.TimeZone)
	p.Frequency = FrequencyHourly
	at := time.Date(2026, 10, 25, 2, 30, 0, 0, time.UTC).In(ams) // 03:30 CET, after 02:00–03:00 happened twice
	if s := p.LastSlot(at); s.After(at) || at.Sub(s) > time.Hour {
		t.Fatalf("hourly slot %v for %v", s, at)
	}
}

// A clock that ran ahead and was put right never holds a backup back.
func TestDueWithTimesFromTheFuture(t *testing.T) {
	p := DefaultPolicy()
	now := time.Date(2026, 11, 4, 14, 20, 0, 0, time.UTC)
	before := now.Add(-7 * time.Hour) // before the 09:00 slot
	future := now.Add(3 * 24 * time.Hour)
	if due, why := p.Due(DueInput{Now: now, LastSuccess: &before, LastFailure: &future}); !due {
		t.Fatalf("a failure dated in the future blocked the retry: %s", why)
	}
	if due, why := p.Due(DueInput{Now: now, LastSuccess: &future}); !due {
		t.Fatalf("a success dated in the future counted as the newest backup: %s", why)
	}
	soon := now.Add(time.Minute) // within the slack: a slightly fast clock elsewhere is no reason to back up again
	if due, _ := p.Due(DueInput{Now: now, LastSuccess: &soon}); due {
		t.Fatal("a success a minute ahead made a backup due")
	}
}

func TestDrillDueAndForgetArgs(t *testing.T) {
	p := DefaultPolicy()
	p.TimeZone = "America/New_York"
	ny, _ := time.LoadLocation(p.TimeZone)
	morning := time.Date(2026, 11, 4, 5, 0, 0, 0, ny) // 05:00 for the person, 10:00 UTC
	noon := time.Date(2026, 11, 4, 12, 0, 0, 0, ny)
	week := morning.Add(-7 * 24 * time.Hour)
	day := morning.Add(-24 * time.Hour)
	if !p.DrillDue(morning, nil) || !p.DrillDue(morning, &week) || p.DrillDue(morning, &day) {
		t.Fatal("weekly check in the person's morning")
	}
	if p.DrillDue(noon, &week) {
		t.Fatal("the weekly check started at noon in the person's zone")
	}
	utc4 := time.Date(2026, 11, 4, 4, 30, 0, 0, time.UTC) // 04:30 UTC is 23:30 in New York
	if p.DrillDue(utc4, &week) {
		t.Fatal("the weekly check followed the box's UTC clock")
	}
	overdue := noon.Add(-9 * 24 * time.Hour)
	if !p.DrillDue(noon, &overdue) {
		t.Fatal("a check that missed its mornings waits for ever")
	}
	future := noon.Add(48 * time.Hour)
	if !p.DrillDue(morning, &future) {
		t.Fatal("a check dated in the future held the next one back")
	}
	p.WeeklyCheck = false
	if p.DrillDue(morning, &week) {
		t.Fatal("off")
	}
	got := DefaultPolicy().Keep.ForgetArgs()
	want := []string{"--keep-within", "2d", "--keep-within-daily", "14d", "--keep-within-weekly", "56d", "--keep-within-monthly", "12m"}
	if len(got) != len(want) {
		t.Fatalf("%v", got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("%v", got)
		}
	}
}

// A sequence number is handed out once: a checkpoint whose read-back failed after its snapshot was written keeps its
// number, and the next one gets the following.
func TestNextSeqNeverRepeats(t *testing.T) {
	c := &Config{Persist: t.TempDir()}
	c.Defaults()
	n1, err := NextSeq(c, nil)
	if err != nil || n1 != 1 {
		t.Fatalf("first %d %v", n1, err)
	}
	if err := AppendChain(c, ChainEntry{ID: "ck-1", Seq: n1}); err != nil {
		t.Fatal(err)
	}
	last, _ := LastChain(c)
	n2, _ := NextSeq(c, last) // its read-back fails: not appended to the chain
	n3, _ := NextSeq(c, last)
	if n2 != 2 || n3 != 3 {
		t.Fatalf("after a failed read-back: %d then %d", n2, n3)
	}
	// A chain ahead of the file (a box from before the file) wins.
	if n, _ := NextSeq(c, &ChainEntry{Seq: 40}); n != 41 {
		t.Fatalf("chain ahead: %d", n)
	}
}

// The space limit's ladder is the backup places' (m6 m3 m0 w28 w0 d7, every backup of the last 7 days kept).
func TestLimitLadder(t *testing.T) {
	got := DefaultPolicy().Keep.LimitLadder()
	want := []PolicyKeep{{7, 14, 8, 6}, {7, 14, 8, 3}, {7, 14, 8, 0}, {7, 14, 4, 0}, {7, 14, 0, 0}, {7, 7, 0, 0}}
	if len(got) != len(want) {
		t.Fatalf("%+v", got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("step %d: %+v, want %+v", i, got[i], want[i])
		}
	}
	if n := (PolicyKeep{AllDays: 30, DailyDays: 5}).LimitLadder(); len(n) != 0 {
		t.Fatalf("nothing to shorten: %+v", n)
	}
}
