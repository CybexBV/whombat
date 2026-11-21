package update_test

import (
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/manager/internal/testworld"
	"github.com/CybexBV/whombat/appliance/manager/internal/update"
	"github.com/CybexBV/whombat/appliance/release-tools/devtuf"
)

type scenario struct {
	name  string
	setup func(w *testworld.World)
	done  func(*update.State) bool
	check func(t *testing.T, w *testworld.World)
}

type occurrence struct {
	point string
	n     int
}

// crashMatrix runs the scenario once to discover every crash point, then for each point (and up to
// three occurrences of repeated points) runs a fresh world that crashes there, restarts the
// manager (new engine over the same journal) and the helper, and checks the end state.
// fast shortens waits so each run needs few steps (every step fsyncs the journal).
func fast(w *testworld.World) {
	w.Policy.HealthInterval, w.Policy.VerifyTimeout, w.Policy.HealthyStreak = time.Minute, 3*time.Minute, 2
	w.Policy.MaxAttempts, w.Policy.DrainPoll = 2, time.Minute
	w.NewEngine()
}

func crashMatrix(t *testing.T, sc scenario) {
	w := testworld.New(t)
	fast(w)
	sc.setup(w)
	if err := w.Run(400, sc.done); err != nil {
		t.Fatal(err)
	}
	sc.check(t, w)
	count := map[string]int{}
	var occ []occurrence
	for _, p := range w.Points {
		count[p]++
		if count[p] <= 3 {
			occ = append(occ, occurrence{p, count[p]})
		}
	}
	if len(occ) < 10 {
		t.Fatalf("suspiciously few crash points: %v", occ)
	}
	for _, o := range occ {
		t.Run(fmt.Sprintf("%s#%d", o.point, o.n), func(t *testing.T) {
			// Every crash point has its own world: run them in parallel. Sequentially the -race run of
			// this package took minutes and hit go test's 10-minute limit on a loaded machine (the
			// unexplained FAIL in W4-SEC part 2).
			t.Parallel()
			w := testworld.New(t)
			fast(w)
			w.RedeliverInRun = true
			w.CrashAt, w.CrashN = o.point, o.n
			sc.setup(w)
			var err error
			if w.CrashAt == "" {
				err = testworld.ErrCrash // crashed while accepting the assignment
			} else {
				err = w.Run(400, sc.done)
			}
			if !errors.Is(err, testworld.ErrCrash) {
				if w.CrashAt == "" {
					t.Fatalf("crash consumed but not surfaced: %v", err)
				}
				t.Skipf("crash point not reached in this run (%v)", err)
			}
			// Manager process dies and restarts; the socket-activated helper restarts too.
			w.NewEngine()
			w.RestartHelper()
			if err := w.Run(600, sc.done); err != nil {
				t.Fatalf("after restart: %v", err)
			}
			sc.check(t, w)
		})
	}
	t.Logf("%d crash points exercised", len(occ))
}

func offer(id string) func(w *testworld.World) {
	return func(w *testworld.World) {
		if _, _, err := w.Offer(id); err != nil && !errors.Is(err, testworld.ErrCrash) {
			w.T.Fatal(err)
		}
	}
}

func TestCrashAtEveryTransitionRuntimeUpdate(t *testing.T) {
	t.Parallel()
	crashMatrix(t, scenario{
		setup: offer(testworld.RuntimeGood),
		done: func(st *update.State) bool {
			return st.Phase == update.Healthy && st.Current.ReleaseID == testworld.RuntimeGood
		},
		check: func(t *testing.T, w *testworld.World) {
			if w.RuntimeProfile() != devtuf.FakeStorePath("whombat-runtime-1.1.0") {
				t.Fatalf("profile %s", w.RuntimeProfile())
			}
			if w.Runtime.Draining() {
				t.Fatal("runtime left draining")
			}
		},
	})
}

func TestCrashAtEveryTransitionBadRuntimeRollback(t *testing.T) {
	t.Parallel()
	crashMatrix(t, scenario{
		setup: offer(testworld.RuntimeBad),
		done:  testworld.AwaitsControl, // rolled back; only control has it retried (MG-56)
		check: func(t *testing.T, w *testworld.World) {
			st := w.State()
			if st.Current.ReleaseID != testworld.Factory || st.KnownGood.ReleaseID != testworld.Factory {
				t.Fatalf("current %s known-good %s", st.Current.ReleaseID, st.KnownGood.ReleaseID)
			}
			if n := st.VerificationFailures[st.Candidate.Tuple.Digest]; n != 1 {
				t.Fatalf("verification failures %d", n)
			}
			if w.RuntimeProfile() != devtuf.FakeStorePath("whombat-runtime-1.0.0") {
				t.Fatalf("profile %s", w.RuntimeProfile())
			}
			if w.Runtime.Draining() {
				t.Fatal("runtime left draining")
			}
		},
	})
}

func TestCrashAtEveryTransitionHostUpdate(t *testing.T) {
	t.Parallel()
	crashMatrix(t, scenario{
		setup: offer(testworld.HostGood),
		done: func(st *update.State) bool {
			return st.Phase == update.Healthy && st.Current.ReleaseID == testworld.HostGood
		},
		check: func(t *testing.T, w *testworld.World) {
			if got := w.Helper.Readlink("current-system"); got != devtuf.FakeStorePath("nixos-system-whombat-26.05.2") {
				t.Fatalf("booted %s", got)
			}
			if w.RuntimeProfile() != devtuf.FakeStorePath("whombat-runtime-1.2.0") {
				t.Fatalf("profile %s", w.RuntimeProfile())
			}
		},
	})
}

func TestCrashAtEveryTransitionHostBootFallback(t *testing.T) {
	t.Parallel()
	crashMatrix(t, scenario{
		setup: offer(testworld.HostNoBoot),
		done:  testworld.AwaitsControl,
		check: func(t *testing.T, w *testworld.World) {
			st := w.State()
			if st.Current.ReleaseID != testworld.Factory {
				t.Fatalf("current %s", st.Current.ReleaseID)
			}
			if got := w.Helper.Readlink("current-system"); got != devtuf.FakeStorePath("nixos-system-whombat-26.05.1") {
				t.Fatalf("booted %s", got)
			}
			if got := w.Helper.Readlink("profiles/system"); got != devtuf.FakeStorePath("nixos-system-whombat-26.05.1") {
				t.Fatalf("boot default %s", got)
			}
			if w.RuntimeProfile() != devtuf.FakeStorePath("whombat-runtime-1.0.0") {
				t.Fatalf("profile %s", w.RuntimeProfile())
			}
		},
	})
}
