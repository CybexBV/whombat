package update_test

import (
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/manager/internal/testworld"
	"github.com/CybexBV/whombat/appliance/manager/internal/update"
	"github.com/CybexBV/whombat/appliance/release-tools/devtuf"
)

// MG-57, the production box's starting point (gate 4 of the upgrade gates): the known-good is a runtime-only release
// (rt-2: runtime 1.1.0 on the factory's host). A host candidate that boots and fails its checks is rolled back to the
// factory's host generation with rt-2's runtime, healthy; so is one that doesn't boot (boot counting falls back).
func TestHostRollbackToARuntimeOnlyKnownGood(t *testing.T) {
	t.Parallel()
	for name, f := range map[string]func() devtuf.FakeRelease{
		"unhealthy": func() devtuf.FakeRelease {
			r := devtuf.StandardRelease("rt-40-host-bad", "26.05.4", "1.4.0-bad")
			r.RuntimeHealth = "bad"
			return r
		},
		"no boot": func() devtuf.FakeRelease {
			r := devtuf.StandardRelease("rt-41-host-noboot", "26.05.5", "1.5.0")
			r.HostBoots = false
			return r
		},
	} {
		t.Run(name, func(t *testing.T) {
			w := testworld.New(t)
			install(t, w, testworld.RuntimeGood) // runtime-only on the factory host
			w.Clock.Advance(12 * time.Hour)      // long past the helper's runtime rollback window
			bad := f()
			publish(t, w, bad)
			mustOffer(t, w, bad.ID, update.DecisionStarted)
			w.Run(800, testworld.AwaitsControl)
			st := w.State()
			if st.Current.ReleaseID != testworld.RuntimeGood || st.KnownGood.ReleaseID != testworld.RuntimeGood {
				t.Fatalf("current %s known-good %s failure %+v", st.Current.ReleaseID, st.KnownGood.ReleaseID, st.Candidate.Failure)
			}
			if got := w.Helper.Readlink("current-system"); got != devtuf.FakeStorePath("nixos-system-whombat-26.05.1") {
				t.Fatalf("booted %s", got)
			}
			if got := w.Helper.Readlink("profiles/system"); got != devtuf.FakeStorePath("nixos-system-whombat-26.05.1") {
				t.Fatalf("boot default %s", got)
			}
			if got := w.RuntimeProfile(); got != devtuf.FakeStorePath("whombat-runtime-1.1.0") {
				t.Fatalf("runtime %s", got)
			}
			if st.Candidate.Rollback != nil || w.Runtime.Draining() {
				t.Fatalf("rollback left %+v", st.Candidate.Rollback)
			}
			// Still healthy afterwards, and a good host release installs from here.
			mustOffer(t, w, testworld.HostGood, update.DecisionStarted)
			w.Run(800, testworld.PhaseIs(update.Healthy))
			if st := w.State(); st.Current.ReleaseID != testworld.HostGood {
				t.Fatalf("current %s", st.Current.ReleaseID)
			}
		})
	}
}
