package update_test

import (
	"strings"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/manager/internal/testworld"
	"github.com/CybexBV/whombat/appliance/manager/internal/update"
)

func activations(w *testworld.World) int {
	n := 0
	for _, e := range w.Helper.Events() {
		if strings.HasPrefix(e, "set-runtime ") {
			n++
		}
	}
	return n
}

// idle steps the engine for d of fake time (the daemon's loop without any new assignment).
func idle(t *testing.T, w *testworld.World, d time.Duration) {
	t.Helper()
	for end := w.Clock.Now().Add(d); w.Clock.Now().Before(end); {
		wait, err := w.Engine.Step(t.Context())
		if err != nil {
			t.Fatal(err)
		}
		w.Clock.Advance(max(min(wait, 10*time.Minute), time.Second))
	}
}

// MG-56: a candidate that was activated and failed verification is never re-activated from local state: while control
// says nothing new or holds the device, it stays rolled back on known-good. When control assigns it again (an
// operator's “Retry this Whombat”) it is retried once, not before 30 minutes after the failure, and quarantined after
// its second verification failure.
func TestVerificationFailureRetriedOnlyWhenControlAssignsItAgain(t *testing.T) {
	t.Parallel()
	w := testworld.New(t)
	mustOffer(t, w, testworld.RuntimeBad, update.DecisionStarted)
	w.Run(400, testworld.AwaitsControl)
	st := w.State()
	failedAt := st.Candidate.Failure.At
	if st.Candidate.Failure.Code != "unhealthy" || st.VerificationFailures[st.Candidate.Tuple.Digest] != 1 {
		t.Fatalf("failure %+v counts %v", st.Candidate.Failure, st.VerificationFailures)
	}
	n := activations(w)
	// Control has nothing new (its answer is unchanged), then holds the device: nothing is retried.
	idle(t, w, 6*time.Hour)
	if d, _, err := w.OfferHold(); err != nil || d != update.DecisionHold {
		t.Fatal(d, err)
	}
	idle(t, w, 6*time.Hour)
	st = w.State()
	if !testworld.AwaitsControl(st) || activations(w) != n || st.Candidate.Attempts != 1 {
		t.Fatalf("phase %s activations %d (was %d) attempts %d", st.Phase, activations(w), n, st.Candidate.Attempts)
	}
	factoryRunning(t, w)

	// “Retry this Whombat”: control assigns the same release again. Queued; activated only 30 min after the failure
	// (here that has long passed, so at once) — shown with a fresh failure below.
	if d, why, err := w.Offer(testworld.RuntimeBad); err != nil || d != update.DecisionQueued || !strings.Contains(why, "control assigned it again") {
		t.Fatalf("retry offer: %v %q %v", d, why, err)
	}
	var retriedAt time.Time
	w.Run(100, func(st *update.State) bool {
		if st.Phase == update.Assigned && retriedAt.IsZero() {
			retriedAt = w.Clock.Now()
		}
		return !retriedAt.IsZero()
	})
	if retriedAt.Before(failedAt.Add(30 * time.Minute)) {
		t.Fatalf("retried at %v, failed at %v", retriedAt, failedAt)
	}
	// The second verification failure quarantines it; control's next assignment of it is refused.
	w.Run(600, testworld.PhaseIs(update.Quarantined))
	st = w.State()
	if q, ok := st.Quarantine[testworld.RuntimeBad]; !ok || q.Code != "unhealthy" || len(st.VerificationFailures) != 0 {
		t.Fatalf("quarantine %+v counts %v", st.Quarantine, st.VerificationFailures)
	}
	if activations(w) != n+2 { // the retry's activation and its rollback
		t.Fatalf("activations %d, want %d", activations(w), n+2)
	}
	if d, _, _ := w.Offer(testworld.RuntimeBad); d != update.DecisionRefused {
		t.Fatalf("a quarantined release offered again: %v", d)
	}
	factoryRunning(t, w)
}

// Assigned again soon after the failure, the retry waits until 30 minutes after it.
func TestVerificationRetryWaitsThirtyMinutes(t *testing.T) {
	t.Parallel()
	w := testworld.New(t)
	mustOffer(t, w, testworld.HostNoBoot, update.DecisionStarted)
	w.Run(600, testworld.AwaitsControl)
	failedAt := w.State().Candidate.Failure.At
	if d, _, err := w.Offer(testworld.HostNoBoot); err != nil || d != update.DecisionQueued {
		t.Fatal(d, err)
	}
	var retriedAt time.Time
	w.Run(400, func(st *update.State) bool {
		if st.Phase == update.Assigned {
			retriedAt = w.Clock.Now()
			return true
		}
		return false
	})
	if retriedAt.Before(failedAt.Add(30*time.Minute)) || retriedAt.After(failedAt.Add(31*time.Minute)) {
		t.Fatalf("retried %v after the failure", retriedAt.Sub(failedAt))
	}
}

// Failures before activation keep their own retry policy: retried by the box itself, quarantined after MaxAttempts.
func TestFailuresBeforeActivationStillRetryByThemselves(t *testing.T) {
	t.Parallel()
	w := testworld.New(t)
	mustOffer(t, w, testworld.NoFloors, update.DecisionStarted) // refused by the schema check (Staged)
	w.Run(400, testworld.PhaseIs(update.Quarantined))
	st := w.State()
	if q := st.Quarantine[testworld.NoFloors]; q.Code != "schema_incompatible" || q.Attempts != w.Policy.MaxAttempts || len(st.VerificationFailures) != 0 {
		t.Fatalf("quarantine %+v counts %v", q, st.VerificationFailures)
	}
}
