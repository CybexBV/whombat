package update_test

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/helper/pkg/proto"
	"github.com/CybexBV/whombat/appliance/manager/internal/testworld"
	"github.com/CybexBV/whombat/appliance/manager/internal/update"
	"github.com/CybexBV/whombat/appliance/release-tools/devtuf"
)

// UP-X18, UP-X19: after an update became Healthy, and only then, the manager prunes the runtime generations and
// collects the store, once, right after the staging prune.

func eventIndexes(w *testworld.World, prefix string) []int {
	var out []int
	for i, e := range w.Helper.Events() {
		if strings.HasPrefix(e, prefix) {
			out = append(out, i)
		}
	}
	return out
}

func collections(w *testworld.World) int { return len(eventIndexes(w, "collect-garbage ")) }

func runtimePath(v string) string { return devtuf.FakeStorePath("whombat-runtime-" + v) }

func TestStoreCollectedAfterEachHealthyUpdate(t *testing.T) {
	t.Parallel()
	w := testworld.New(t)
	var logs bytes.Buffer
	w.Engine.Log = slog.New(slog.NewTextHandler(&logs, nil))
	install(t, w, testworld.RuntimeGood) // 1.1.0
	install(t, w, testworld.RuntimeNext) // 1.1.5
	if n := collections(w); n != 2 {
		t.Fatalf("%d collections after two updates", n)
	}
	logs.Reset()
	install(t, w, testworld.Schema10) // 1.9.0
	// 1.1.0 is no record's any more (current 1.9.0, previous 1.1.5, the factory host's 1.0.0): its generation goes,
	// then its closure. In that order, after the staging prune, once.
	if got := w.Helper.RuntimeGenerations(); !slices.Equal(got, []string{runtimePath("1.0.0"), runtimePath("1.1.5"), runtimePath("1.9.0")}) {
		t.Fatalf("runtime generations %v", got)
	}
	if w.Helper.HasStorePath(runtimePath("1.1.0")) || !w.Helper.HasStorePath(runtimePath("1.0.0")) ||
		!w.Helper.HasStorePath(runtimePath("1.1.5")) || !w.Helper.HasStorePath(runtimePath("1.9.0")) {
		t.Fatal("the collection kept or deleted the wrong runtimes")
	}
	out := logs.String()
	staging, pruned, collected := strings.Index(out, `"staging pruned after the update"`),
		strings.Index(out, `"pruned runtime generations" deleted=[2]`), strings.Index(out, `"store collected after the update" paths=1 `)
	if staging < 0 || pruned < staging || collected < pruned || strings.Count(out, "store collected") != 1 {
		t.Fatalf("log:\n%s", out)
	}
	// A candidate that fails rolls back to 1.9.0, still in the store; a rollback collects nothing.
	bad := devtuf.StandardRelease("rt-40-bad", "26.05.1", "1.9.5")
	bad.RuntimeHealth = "bad"
	publish(t, w, bad)
	mustOffer(t, w, bad.ID, update.DecisionStarted)
	w.Run(600, testworld.AwaitsControl)
	if st := w.State(); st.Current.ReleaseID != testworld.Schema10 || w.RuntimeProfile() != runtimePath("1.9.0") {
		t.Fatalf("rolled back to %s, profile %s", st.Current.ReleaseID, w.RuntimeProfile())
	}
	idle(t, w, time.Hour)
	if n := collections(w); n != 3 {
		t.Fatalf("%d collections: a rollback or a steady step collected", n)
	}
}

// Never between Downloading and Verifying: an assignment queued while an update verifies is staged only after that
// update's collection, so its closure (no GC root until it is activated) is never collected.
func TestStoreCollectedBeforeAQueuedUpdateIsStaged(t *testing.T) {
	t.Parallel()
	w := testworld.New(t)
	mustOffer(t, w, testworld.RuntimeGood, update.DecisionStarted)
	w.Run(200, testworld.PhaseIs(update.Verifying))
	mustOffer(t, w, testworld.RuntimeNext, update.DecisionQueued)
	w.Run(400, func(st *update.State) bool {
		return st.Phase == update.Healthy && st.Current.ReleaseID == testworld.RuntimeNext
	})
	c := eventIndexes(w, "collect-garbage ")
	staged := eventIndexes(w, "import-nar "+runtimePath("1.1.5"))
	activated := eventIndexes(w, "set-runtime "+runtimePath("1.1.5"))
	if len(c) != 2 || len(staged) != 1 || len(activated) != 1 || c[0] > staged[0] || staged[0] > activated[0] || activated[0] > c[1] {
		t.Fatalf("collections %v, staged %v, activated %v: %q", c, staged, activated, w.Helper.Events())
	}
}

// A failing prune or collection is a warning: the update is done and Healthy, steady steps don't try again, the next
// update does.
func TestStoreCollectionFailureNeverFailsTheUpdate(t *testing.T) {
	t.Parallel()
	w := testworld.New(t)
	var logs bytes.Buffer
	w.Engine.Log = slog.New(slog.NewTextHandler(&logs, nil))
	w.Helper.SetFail("list-runtime-generations", errors.New("profile unreadable"))
	w.Helper.SetFail("collect-garbage", errors.New("store busy"))
	install(t, w, testworld.RuntimeGood)
	if st := w.State(); st.LastFailure != nil || st.KnownGood.ReleaseID != testworld.RuntimeGood {
		t.Fatalf("failure %+v known-good %s", st.LastFailure, st.KnownGood.ReleaseID)
	}
	idle(t, w, 2*time.Hour)
	out := logs.String()
	if strings.Count(out, "pruning runtime generations failed; collecting the store anyway") != 1 ||
		strings.Count(out, "collecting the store failed; the update is done") != 1 {
		t.Fatalf("log:\n%s", out)
	}
	w.Helper.SetFail("list-runtime-generations", nil)
	w.Helper.SetFail("collect-garbage", nil)
	install(t, w, testworld.RuntimeNext)
	if n := collections(w); n != 1 {
		t.Fatalf("%d collections", n)
	}
}

// At most once per update: a manager that restarts after the Healthy record (before or after the collection) doesn't
// collect again until the next update.
func TestStoreCollectedAtMostOncePerUpdate(t *testing.T) {
	t.Parallel()
	for point, want := range map[string]int{"persist:Verifying->Healthy:after": 0, "effect:prune-runtime-generations": 0,
		"effect:collect-garbage": 1} {
		t.Run(point, func(t *testing.T) {
			w := testworld.New(t)
			mustOffer(t, w, testworld.RuntimeGood, update.DecisionStarted)
			w.CrashAt, w.CrashN = point, 1
			if err := w.Run(400, testworld.PhaseIs(update.Healthy)); !errors.Is(err, testworld.ErrCrash) {
				t.Fatalf("crash not reached: %v", err)
			}
			w.NewEngine()
			w.RestartHelper()
			idle(t, w, time.Hour)
			if st := w.State(); st.Phase != update.Healthy || st.Current.ReleaseID != testworld.RuntimeGood || collections(w) != want {
				t.Fatalf("phase %s current %s, %d collections", st.Phase, st.Current.ReleaseID, collections(w))
			}
			install(t, w, testworld.RuntimeNext)
			if n := collections(w); n != want+1 {
				t.Fatalf("%d collections after the next update", n)
			}
		})
	}
}

// slowCollect makes the store collection take a while.
type slowCollect struct {
	update.Helper
	delay time.Duration
}

func (s slowCollect) Do(ctx context.Context, req proto.Request) (*proto.Result, error) {
	if req.Op == proto.OpCollectGarbage {
		time.Sleep(s.delay)
	}
	return s.Helper.Do(ctx, req)
}

// The engine loop is the watchdog's heartbeat (MG-16): while the step waits for the collection it keeps beating, and
// stops when the collection returns.
func TestStoreCollectionKeepsTheWatchdogFed(t *testing.T) {
	w := testworld.New(t)
	var beats atomic.Int64
	w.Engine.Helper = slowCollect{Helper: w.Engine.Helper, delay: 300 * time.Millisecond}
	w.Engine.Heartbeat, w.Engine.HeartbeatEvery = func() { beats.Add(1) }, 10*time.Millisecond
	install(t, w, testworld.RuntimeGood)
	n := beats.Load()
	if n < 3 {
		t.Fatalf("%d heartbeats while collecting", n)
	}
	time.Sleep(50 * time.Millisecond)
	if beats.Load() != n {
		t.Fatal("heartbeats after the collection returned")
	}
}
