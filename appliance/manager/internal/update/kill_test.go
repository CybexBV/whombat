package update_test

import (
	"errors"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"testing"

	"github.com/CybexBV/whombat/appliance/manager/internal/testworld"
	"github.com/CybexBV/whombat/appliance/manager/internal/update"
	"github.com/CybexBV/whombat/appliance/release-tools/devtuf"
)

// TestKillChild is the child side of TestKillAtEveryTransition: it continues the appliance in
// WB_WORLD and SIGKILLs its own process (manager, in-process helper and runtime die together, no
// deferred cleanup, no buffered writes) when the engine reaches WB_KILL_AT.
func TestKillChild(t *testing.T) {
	dir := os.Getenv("WB_WORLD")
	if dir == "" {
		t.Skip("child process only")
	}
	w := testworld.Open(t, dir)
	fast(w)
	w.RedeliverInRun = true
	if at := os.Getenv("WB_KILL_AT"); at != "" {
		w.Engine.Crash = func(point string) error {
			if point == at {
				_ = syscall.Kill(os.Getpid(), syscall.SIGKILL)
			}
			return nil
		}
	}
	target := os.Getenv("WB_TARGET")
	if err := w.Run(600, func(st *update.State) bool {
		return (st.Phase == update.Healthy && st.Current.ReleaseID == target) || (target == "rolled-back" && testworld.AwaitsControl(st))
	}); err != nil {
		t.Fatal(err)
	}
}

func child(t *testing.T, dir, killAt, target string) error {
	cmd := exec.Command(os.Args[0], "-test.run=^TestKillChild$", "-test.count=1")
	cmd.Env = append(os.Environ(), "WB_WORLD="+dir, "WB_KILL_AT="+killAt, "WB_TARGET="+target)
	out, err := cmd.CombinedOutput()
	if err != nil && killAt == "" {
		t.Logf("child output:\n%s", out)
	}
	return err
}

// TestKillAtEveryTransition kills the manager process for real (SIGKILL) at every persisted
// transition and every effect of a runtime update and of a bad-runtime rollback, then restarts it
// in a new process and checks the appliance converges.
func TestKillAtEveryTransition(t *testing.T) {
	t.Parallel()
	if testing.Short() {
		t.Skip("spawns processes")
	}
	for _, sc := range []struct {
		name, release, target string
		check                 func(t *testing.T, w *testworld.World)
	}{
		{"update", testworld.RuntimeGood, testworld.RuntimeGood, func(t *testing.T, w *testworld.World) {
			if w.RuntimeProfile() != devtuf.FakeStorePath("whombat-runtime-1.1.0") {
				t.Fatalf("profile %s", w.RuntimeProfile())
			}
		}},
		{"rollback", testworld.RuntimeBad, "rolled-back", func(t *testing.T, w *testworld.World) {
			if w.RuntimeProfile() != devtuf.FakeStorePath("whombat-runtime-1.0.0") || w.State().Current.ReleaseID != testworld.Factory {
				t.Fatalf("profile %s", w.RuntimeProfile())
			}
		}},
	} {
		t.Run(sc.name, func(t *testing.T) {
			// Discover the crash points of this scenario in-process.
			d := testworld.New(t)
			fast(d)
			offer(sc.release)(d)
			d.Run(600, func(st *update.State) bool {
				return st.Steady() && st.Candidate == nil || st.Phase == update.Quarantined || testworld.AwaitsControl(st)
			})
			seen := map[string]bool{}
			var points []string
			for _, p := range d.Points {
				if !seen[p] && !strings.Contains(p, "Verifying->Verifying") {
					seen[p] = true
					points = append(points, p)
				}
			}
			for _, p := range points {
				t.Run(p, func(t *testing.T) {
					t.Parallel() // independent worlds and child processes (see crashMatrix)
					w := testworld.New(t)
					fast(w)
					offer(sc.release)(w)
					dir := w.P.Dir
					w.Runtime.Close()
					w.Helper.Stop()
					err := child(t, dir, p, sc.target)
					var ee *exec.ExitError
					if !errors.As(err, &ee) || ee.ProcessState.Sys().(syscall.WaitStatus).Signal() != syscall.SIGKILL {
						t.Skipf("kill point not reached in the child (%v)", err)
					}
					if err := child(t, dir, "", sc.target); err != nil {
						t.Fatalf("restart after kill at %s did not converge: %v", p, err)
					}
					sc.check(t, testworld.Open(t, dir))
				})
			}
		})
	}
}
