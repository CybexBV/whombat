package update_test

import (
	"strings"
	"testing"

	"github.com/CybexBV/whombat/appliance/manager/internal/testworld"
	"github.com/CybexBV/whombat/appliance/manager/internal/update"
	"github.com/CybexBV/whombat/appliance/release-tools/devtuf"
)

// Regression for M-2 (W4-SEC part 2): control could move a device back to an older release that is
// still TUF-approved (the reviewer's PoC went rt-4-host → rt-2 and ended Healthy). Now an assignment to
// an older tuple is refused unless release custody signed the downgrade (allowDowngradeFrom).
func TestControlCannotDowngradeWithoutCustody(t *testing.T) {
	t.Parallel()
	w := testworld.New(t)
	mustOffer(t, w, testworld.HostGood, update.DecisionStarted) // host 26.05.2, runtime 1.2.0
	w.Run(600, testworld.PhaseIs(update.Healthy))
	if st := w.State(); st.Current.ReleaseID != testworld.HostGood {
		t.Fatalf("current %s", st.Current.ReleaseID)
	}
	d, why, err := w.Offer(testworld.RuntimeGood) // host 26.05.1, runtime 1.1.0
	if err != nil || d != update.DecisionRefused || !strings.Contains(why, "older") {
		t.Fatalf("downgrade offer: %v %q %v", d, why, err)
	}
	w.Run(50, testworld.PhaseIs(update.Healthy))
	if st := w.State(); st.Current.ReleaseID != testworld.HostGood || st.Candidate != nil && st.Candidate.Tuple.ReleaseID == testworld.RuntimeGood {
		t.Fatalf("device moved: current %s", st.Current.ReleaseID)
	}
}

// A downgrade release custody signed (allowDowngradeFrom the installed release) is installed.
func TestCustodySignedDowngradeIsInstalled(t *testing.T) {
	t.Parallel()
	w := testworld.New(t)
	mustOffer(t, w, testworld.HostGood, update.DecisionStarted)
	w.Run(600, testworld.PhaseIs(update.Healthy))
	back := devtuf.StandardRelease("rt-2-custody-rollback", "26.05.1", "1.1.0")
	back.AllowDowngradeFrom = []string{testworld.HostGood}
	if _, err := w.Repo.AddFakeRelease(back); err != nil {
		t.Fatal(err)
	}
	if err := w.Repo.Publish(); err != nil {
		t.Fatal(err)
	}
	mustOffer(t, w, back.ID, update.DecisionStarted)
	w.Run(600, testworld.PhaseIs(update.Healthy, update.Failed, update.Quarantined))
	if st := w.State(); st.Phase != update.Healthy || st.Current.ReleaseID != back.ID {
		t.Fatalf("phase %s current %s", st.Phase, st.Current.ReleaseID)
	}
}
