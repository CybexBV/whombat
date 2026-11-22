package update_test

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/manager/internal/testworld"
	"github.com/CybexBV/whombat/appliance/manager/internal/update"
	"github.com/CybexBV/whombat/appliance/release-tools/devtuf"
	"github.com/CybexBV/whombat/contracts/go/release"
)

// A community box (MG-136): the newest release of its own repository goes through the same engine path as an assigned
// one, without control and without an assignment file; the same repository state is offered once; nothing newer
// offers nothing.
func TestCommunityTakesTheNewestRelease(t *testing.T) {
	t.Parallel()
	w := testworld.New(t)
	w.SetEdition("community")
	w.Keep(testworld.Factory, testworld.RuntimeGood)
	ctx := context.Background()
	offerLatest := func(want update.Decision, wantRelease string) *update.Offered {
		t.Helper()
		repo := w.Refresh()
		dec, why, o, err := w.Engine.OfferLatest(ctx, repo, "dev-1", "dev")
		if err != nil || dec != want {
			t.Fatalf("offer: %s %q %v", dec, why, err)
		}
		switch {
		case wantRelease == "" && o != nil:
			t.Fatalf("offered %s", o.Release.ID())
		case wantRelease != "" && (o == nil || o.Release.ID() != wantRelease):
			t.Fatalf("offered %+v, want %s", o, wantRelease)
		case o != nil && (o.Raw != nil || o.Payload.Sequence != repo.TargetsVersion || o.Payload.Action != "install"):
			t.Fatalf("offer %+v", o.Payload)
		}
		return o
	}
	offerLatest(update.DecisionStarted, testworld.RuntimeGood)
	// The same repository again: already processed.
	offerLatest(update.DecisionNoop, testworld.RuntimeGood)
	w.Run(300, testworld.PhaseIs(update.Healthy))
	if st := w.State(); st.Current.ReleaseID != testworld.RuntimeGood || st.KnownGood.ReleaseID != testworld.RuntimeGood {
		t.Fatalf("current %s known-good %v", st.Current.ReleaseID, st.KnownGood)
	}
	if _, err := os.Stat(w.P.Assignment); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("an assignment file was written: %v", err)
	}
	if got := w.RuntimeProfile(); got != devtuf.FakeStorePath("whombat-runtime-1.1.0") {
		t.Fatalf("runtime %s", got)
	}
	// Nothing newer than what runs.
	offerLatest(update.DecisionNoop, "")
	// A new publication: a newer release, offered with the new targets version and installed.
	if _, err := w.Repo.AddFakeRelease(devtuf.StandardRelease(testworld.RuntimeNext, "26.05.1", "1.1.5")); err != nil {
		t.Fatal(err)
	}
	if err := w.Repo.Publish(); err != nil {
		t.Fatal(err)
	}
	offerLatest(update.DecisionStarted, testworld.RuntimeNext)
	w.Run(300, testworld.PhaseIs(update.Healthy))
	if st := w.State(); st.Current.ReleaseID != testworld.RuntimeNext {
		t.Fatalf("current %s", st.Current.ReleaseID)
	}
	// An older release published later (a fixture: tufrepo would refuse it) is never taken.
	if _, err := w.Repo.AddFakeRelease(devtuf.StandardRelease("rt-older", "26.05.1", "1.0.5")); err != nil {
		t.Fatal(err)
	}
	if err := w.Repo.Publish(); err != nil {
		t.Fatal(err)
	}
	offerLatest(update.DecisionNoop, "")
}

// A host release that fails its boot on a community box rolls back like an assigned one, and isn't tried again until
// the repository changes (the same targets version is the same offer).
func TestCommunityHostFailureRollsBack(t *testing.T) {
	t.Parallel()
	w := testworld.New(t)
	w.SetEdition("community")
	w.Keep(testworld.Factory, testworld.HostNoBoot)
	repo := w.Refresh()
	dec, why, _, err := w.Engine.OfferLatest(context.Background(), repo, "dev-1", "dev")
	if err != nil || dec != update.DecisionStarted {
		t.Fatalf("%s %q %v", dec, why, err)
	}
	w.Run(400, testworld.AwaitsControl)
	if st := w.State(); st.Current.ReleaseID != testworld.Factory {
		t.Fatalf("current %s", st.Current.ReleaseID)
	}
	if dec, why, _, err := w.Engine.OfferLatest(context.Background(), w.Refresh(), "dev-1", "dev"); err != nil || dec != update.DecisionNoop {
		t.Fatalf("retried without a new publication: %s %q %v", dec, why, err)
	}
}

// A box with a channel (LNK-20…LNK-23): the newest release of its channel role, offered and installed; a release
// published into the channel later is a new offer although the top-level targets didn't change (OfferSequence); the
// other channel's releases are never offered.
func TestChannelTakesTheNewestOfItsChannel(t *testing.T) {
	t.Parallel()
	w := testworld.New(t)
	w.SetChannel("development")
	ctx := context.Background()
	publishIn := func(channel string, f devtuf.FakeRelease) {
		t.Helper()
		if err := w.Repo.InChannel(channel); err != nil {
			t.Fatal(err)
		}
		defer w.Repo.InChannel("")
		if _, err := w.Repo.AddFakeRelease(f); err != nil {
			t.Fatal(err)
		}
		if err := w.Repo.Publish(); err != nil {
			t.Fatal(err)
		}
	}
	offer := func(want update.Decision, wantRelease string) {
		t.Helper()
		repo := w.Refresh()
		dec, why, o, err := w.Engine.OfferLatest(ctx, repo, "dev-1", "dev")
		if err != nil || dec != want {
			t.Fatalf("offer: %s %q %v", dec, why, err)
		}
		if (wantRelease == "") != (o == nil) || (o != nil && (o.Release.ID() != wantRelease || o.Payload.Sequence != repo.SnapshotVersion)) {
			t.Fatalf("offered %+v, want %q", o, wantRelease)
		}
	}
	publishIn("production", devtuf.StandardRelease("whombat-dev-20261118.9", "26.05.1", "9.0.0"))
	publishIn("development", devtuf.StandardRelease("whombat-dev-20261118.1", "26.05.1", "1.1.0"))
	targets := w.Refresh().TargetsVersion
	offer(update.DecisionStarted, "whombat-dev-20261118.1")
	w.Run(300, testworld.PhaseIs(update.Healthy))
	if st := w.State(); st.Current.ReleaseID != "whombat-dev-20261118.1" {
		t.Fatalf("current %s", st.Current.ReleaseID)
	}
	publishIn("development", devtuf.StandardRelease("whombat-dev-20261118.2", "26.05.1", "1.2.0"))
	if w.Refresh().TargetsVersion != targets {
		t.Fatal("the top-level targets changed")
	}
	offer(update.DecisionStarted, "whombat-dev-20261118.2")
	w.Run(300, testworld.PhaseIs(update.Healthy))
	if st := w.State(); st.Current.ReleaseID != "whombat-dev-20261118.2" {
		t.Fatalf("current %s", st.Current.ReleaseID)
	}
}

func publishIn(t *testing.T, w *testworld.World, channel string, f devtuf.FakeRelease) {
	t.Helper()
	if err := w.Repo.InChannel(channel); err != nil {
		t.Fatal(err)
	}
	defer w.Repo.InChannel("")
	if _, err := w.Repo.AddFakeRelease(f); err != nil {
		t.Fatal(err)
	}
	if err := w.Repo.Publish(); err != nil {
		t.Fatal(err)
	}
}

// A channel's release is offered once (LNK-20): the workflow re-signs the snapshot every few hours, and a release that
// failed its checks here is not taken up again at each re-sign; a newer release is.
func TestChannelReleaseOfferedOnce(t *testing.T) {
	t.Parallel()
	w := testworld.New(t)
	w.SetChannel("development")
	ctx := context.Background()
	// The box runs development's .1 (a rollback goes only to a release its channel lists).
	publishIn(t, w, "development", devtuf.StandardRelease("whombat-dev-20261118.1", "26.05.1", "1.1.0"))
	if dec, why, _, err := w.Engine.OfferLatest(ctx, w.Refresh(), "dev-1", "dev"); err != nil || dec != update.DecisionStarted {
		t.Fatalf("first offer: %s %q %v", dec, why, err)
	}
	run(t, w, 300, testworld.PhaseIs(update.Healthy))
	bad := devtuf.StandardRelease("whombat-dev-20261118.2", "26.05.1", "1.1.1-bad")
	bad.RuntimeHealth = "bad"
	publishIn(t, w, "development", bad)
	if dec, why, _, err := w.Engine.OfferLatest(ctx, w.Refresh(), "dev-1", "dev"); err != nil || dec != update.DecisionStarted {
		t.Fatalf("the bad release: %s %q %v", dec, why, err)
	}
	run(t, w, 400, testworld.PhaseIs(update.RolledBack))
	for i := 0; i < 3; i++ {
		if err := w.Repo.PublishSnapshot(); err != nil {
			t.Fatal(err)
		}
		if dec, why, _, err := w.Engine.OfferLatest(ctx, w.Refresh(), "dev-1", "dev"); err != nil || dec != update.DecisionNoop || why != "already processed" {
			t.Fatalf("after re-sign %d: %s %q %v", i, dec, why, err)
		}
	}
	idle(t, w, time.Hour) // past the retry delay of a verification failure
	if st := w.State(); st.Phase != update.RolledBack || st.Current.ReleaseID != "whombat-dev-20261118.1" || st.Candidate.Attempts != 1 {
		t.Fatalf("phase %s current %s", st.Phase, st.Current.ReleaseID)
	}
	publishIn(t, w, "development", devtuf.StandardRelease("whombat-dev-20261118.3", "26.05.1", "1.2.0"))
	if dec, why, o, err := w.Engine.OfferLatest(ctx, w.Refresh(), "dev-1", "dev"); err != nil || dec != update.DecisionStarted || o.Release.ID() != "whombat-dev-20261118.3" {
		t.Fatalf("a newer release: %s %q %v", dec, why, err)
	}
}

// A channel change replaces an offer of the old channel that waits for the owner (Ask before updating) with the new
// channel's newest, though the snapshot is the same one.
func TestChannelChangeReplacesAWaitingOffer(t *testing.T) {
	t.Parallel()
	w := testworld.New(t)
	w.SetChannel("production")
	askFirst(t, w, true)
	ctx := context.Background()
	publishIn(t, w, "production", devtuf.StandardRelease("whombat-dev-20261118.1", "26.05.1", "1.1.0"))
	publishIn(t, w, "development", devtuf.StandardRelease("whombat-dev-20261118.2", "26.05.1", "1.2.0"))
	if dec, why, _, err := w.Engine.OfferLatest(ctx, w.Refresh(), "dev-1", "dev"); err != nil || dec != update.DecisionStarted {
		t.Fatalf("production's offer: %s %q %v", dec, why, err)
	}
	run(t, w, 300, waitsForOwner("whombat-dev-20261118.1"))
	snapshot := w.Refresh().SnapshotVersion
	w.SetChannel("development")
	repo := w.Refresh()
	if repo.SnapshotVersion != snapshot {
		t.Fatal("the snapshot changed")
	}
	dec, why, o, err := w.Engine.OfferLatest(ctx, repo, "dev-1", "dev")
	if err != nil || dec != update.DecisionStarted || o.Release.ID() != "whombat-dev-20261118.2" {
		t.Fatalf("development's offer: %s %q %v", dec, why, err)
	}
	run(t, w, 300, waitsForOwner("whombat-dev-20261118.2"))
	approve(t, w, "whombat-dev-20261118.2")
	run(t, w, 300, testworld.PhaseIs(update.Healthy))
	if st := w.State(); st.Current.ReleaseID != "whombat-dev-20261118.2" {
		t.Fatalf("current %s", st.Current.ReleaseID)
	}
}

// Switching to a channel with nothing newer (Sol 7): a development update waiting for the owner is never drained for
// once the box follows production, even when the owner approves it; it is retired (the box keeps its release, nothing
// retries it by itself), and offered again when the owner switches back.
func TestOffChannelOfferNeverDrains(t *testing.T) {
	t.Parallel()
	w := testworld.New(t)
	w.SetChannel("development")
	askFirst(t, w, true)
	ctx := context.Background()
	id := "whombat-dev-20261118.2"
	publishIn(t, w, "development", devtuf.StandardRelease(id, "26.05.1", "1.2.0"))
	if dec, why, _, err := w.Engine.OfferLatest(ctx, w.Refresh(), "dev-1", "dev"); err != nil || dec != update.DecisionStarted {
		t.Fatalf("development's offer: %s %q %v", dec, why, err)
	}
	run(t, w, 300, waitsForOwner(id))
	installed := w.State().Current.ReleaseID
	w.SetChannel("production")
	if dec, why, _, err := w.Engine.OfferLatest(ctx, w.Refresh(), "dev-1", "dev"); err != nil || dec != update.DecisionNoop {
		t.Fatalf("production has nothing newer: %s %q %v", dec, why, err)
	}
	drains, _ := w.Runtime.Calls()
	approve(t, w, id)
	run(t, w, 300, testworld.PhaseIs(update.Failed))
	idle(t, w, time.Hour)
	st := w.State()
	if after, _ := w.Runtime.Calls(); after != drains {
		t.Fatalf("drained %d time(s) for an update of the channel the box left", after-drains)
	}
	if st.Phase != update.Failed || st.Current.ReleaseID != installed || st.Candidate.Failure == nil ||
		st.Candidate.Failure.Code != "not_assigned" || st.Approved != "" {
		t.Fatalf("phase %s current %s failure %+v approved %q", st.Phase, st.Current.ReleaseID, st.Candidate.Failure, st.Approved)
	}
	// Back to development: the same release is offered again and installs once approved.
	w.SetChannel("development")
	if dec, why, _, err := w.Engine.OfferLatest(ctx, w.Refresh(), "dev-1", "dev"); err != nil || dec != update.DecisionStarted {
		t.Fatalf("development again: %s %q %v", dec, why, err)
	}
	run(t, w, 300, waitsForOwner(id))
	approve(t, w, id)
	run(t, w, 300, testworld.PhaseIs(update.Healthy))
	if st := w.State(); st.Current.ReleaseID != id {
		t.Fatalf("current %s", st.Current.ReleaseID)
	}
}

// Switching to a channel that offers the identical release (a promotion; Sol 9): the update waiting for the owner
// becomes that channel's and stays, so one approval installs it; it is never retired as off-channel and offered again.
func TestSwitchToAChannelWithTheSameRelease(t *testing.T) {
	t.Parallel()
	w := testworld.New(t)
	w.SetChannel("development")
	askFirst(t, w, true)
	ctx := context.Background()
	id := "whombat-dev-20261118.2"
	publishIn(t, w, "development", devtuf.StandardRelease(id, "26.05.1", "1.2.0"))
	if dec, why, _, err := w.Engine.OfferLatest(ctx, w.Refresh(), "dev-1", "dev"); err != nil || dec != update.DecisionStarted {
		t.Fatalf("development's offer: %s %q %v", dec, why, err)
	}
	run(t, w, 300, waitsForOwner(id))
	if _, err := w.Repo.Promote(id, "development", "production", nil); err != nil {
		t.Fatal(err)
	}
	w.SetChannel("production")
	dec, why, o, err := w.Engine.OfferLatest(ctx, w.Refresh(), "dev-1", "dev")
	if err != nil || dec != update.DecisionNoop || o == nil || o.Channel != "production" {
		t.Fatalf("production's offer of the same release: %s %q %+v %v", dec, why, o, err)
	}
	if c := w.State().Candidate; c == nil || c.Channel != "production" || c.Release.RuntimeIndex == nil ||
		c.Release.RuntimeIndex.Target != o.Release.RuntimeIndex.Target {
		t.Fatalf("the candidate after the switch: %+v", c)
	}
	approve(t, w, id)
	run(t, w, 400, func(st *update.State) bool { return st.Phase == update.Healthy || st.Phase == update.Failed })
	if st := w.State(); st.Phase != update.Healthy || st.Current.ReleaseID != id {
		t.Fatalf("phase %s current %s failure %+v", st.Phase, st.Current.ReleaseID, st.Candidate.Failure)
	}
}

// A release that failed here once is tried again on a channel box (Fable N3): the owner's “Check for updates” offers a
// rolled-back release again (the periodic refresh doesn't), and a forward repair whose cause was passing (the helper
// went away after the migration ran) is finished by the next refresh, as control's “Retry this Whombat” would.
func TestOnceFailedReleaseTriedAgain(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	t.Run("the owner's check", func(t *testing.T) {
		w := testworld.New(t)
		w.SetChannel("development")
		publishIn(t, w, "development", devtuf.StandardRelease("whombat-dev-20261118.1", "26.05.1", "1.1.0"))
		if dec, why, _, err := w.Engine.OfferLatest(ctx, w.Refresh(), "dev-1", "dev"); err != nil || dec != update.DecisionStarted {
			t.Fatalf("first offer: %s %q %v", dec, why, err)
		}
		run(t, w, 300, testworld.PhaseIs(update.Healthy))
		bad := devtuf.StandardRelease("whombat-dev-20261118.2", "26.05.1", "1.1.1-bad")
		bad.RuntimeHealth = "bad"
		publishIn(t, w, "development", bad)
		if dec, why, _, err := w.Engine.OfferLatest(ctx, w.Refresh(), "dev-1", "dev"); err != nil || dec != update.DecisionStarted {
			t.Fatalf("offer: %s %q %v", dec, why, err)
		}
		run(t, w, 400, testworld.PhaseIs(update.RolledBack))
		if dec, why, _, err := w.Engine.OfferLatest(ctx, w.Refresh(), "dev-1", "dev"); err != nil || dec != update.DecisionNoop {
			t.Fatalf("the refresh: %s %q %v", dec, why, err)
		}
		dec, why, _, err := w.Engine.OfferLatestNow(ctx, w.Refresh(), "dev-1", "dev")
		if err != nil || dec != update.DecisionQueued || !strings.Contains(why, "retried") {
			t.Fatalf("the owner's check: %s %q %v", dec, why, err)
		}
	})
	t.Run("a forward repair for a passing cause", func(t *testing.T) {
		w := testworld.New(t)
		w.SetChannel("development")
		id := "whombat-dev-20261118.4"
		f := devtuf.StandardRelease(id, "26.05.1", "1.8.4")
		f.SchemaWrites, f.SchemaReads, f.ReaderFloor, f.WriterFloor = 11, release.IntRange{Min: 11, Max: 11}, 11, 11
		publishIn(t, w, "development", f)
		if dec, why, _, err := w.Engine.OfferLatest(ctx, w.Refresh(), "dev-1", "dev"); err != nil || dec != update.DecisionStarted {
			t.Fatalf("offer: %s %q %v", dec, why, err)
		}
		w.Run(400, func(st *update.State) bool {
			return st.Candidate != nil && st.Candidate.Schema != nil && st.Candidate.Schema.Migrated
		})
		w.Helper.Stop()
		w.Run(2000, testworld.PhaseIs(update.ForwardRepairRequired))
		if f := w.State().Candidate.Failure; strings.Join(f.Reasons, ",") != "activation_deferred" {
			t.Fatalf("forward repair %+v", f)
		}
		w.RestartHelper()
		if err := w.Repo.PublishSnapshot(); err != nil {
			t.Fatal(err)
		}
		if dec, why, _, err := w.Engine.OfferLatest(ctx, w.Refresh(), "dev-1", "dev"); err != nil || dec != update.DecisionStarted {
			t.Fatalf("the next refresh: %s %q %v", dec, why, err)
		}
		w.Run(400, testworld.PhaseIs(update.Healthy, update.Quarantined))
		if st := w.State(); st.Phase != update.Healthy || st.Current.ReleaseID != id {
			t.Fatalf("phase %s current %s", st.Phase, st.Current.ReleaseID)
		}
	})
}

func TestChannelPauseStopsUpdatesKeepsRollbackAndResumes(t *testing.T) {
	t.Parallel()
	ctx := context.Background()

	t.Run("paused offers nothing, never downgrades, resumes cleanly", func(t *testing.T) {
		w := testworld.New(t)
		w.SetChannel("production")
		publishIn(t, w, "development", devtuf.StandardRelease("whombat-20261121.1", "26.05.1", "1.1.0"))
		publishIn(t, w, "development", devtuf.StandardRelease("whombat-20261121.2", "26.05.1", "1.2.0"))
		if _, err := w.Repo.Promote("whombat-20261121.1", "development", "production", nil); err != nil {
			t.Fatal(err)
		}
		if dec, why, _, err := w.Engine.OfferLatest(ctx, w.Refresh(), "dev-1", "dev"); err != nil || dec != update.DecisionStarted {
			t.Fatalf("initial offer: %s %q %v", dec, why, err)
		}
		run(t, w, 300, testworld.PhaseIs(update.Healthy))
		if _, err := w.Repo.Promote("whombat-20261121.2", "development", "production", nil); err != nil {
			t.Fatal(err)
		}
		if _, err := w.Repo.PauseChannel("production", nil); err != nil {
			t.Fatal(err)
		}
		repo := w.Refresh()
		if !repo.ChannelPaused {
			t.Fatal("expected paused repo view")
		}
		if err := w.Engine.SetChannelPaused(true); err != nil {
			t.Fatal(err)
		}
		if dec, why, o, err := w.Engine.OfferLatest(ctx, repo, "dev-1", "dev"); err != nil || dec != update.DecisionNoop || o != nil {
			t.Fatalf("paused OfferLatest: %s %q %+v %v", dec, why, o, err)
		}
		if dec, why, o, err := w.Engine.OfferLatestNow(ctx, repo, "dev-1", "dev"); err != nil || dec != update.DecisionNoop || o != nil {
			t.Fatalf("paused OfferLatestNow: %s %q %+v %v", dec, why, o, err)
		}
		if st := w.State(); st.Phase != update.Healthy || st.Current.ReleaseID != "whombat-20261121.1" {
			t.Fatalf("box changed while paused: phase=%s current=%s", st.Phase, st.Current.ReleaseID)
		}
		// Resume: now .2 is offered and installed.
		if _, err := w.Repo.ResumeChannel("production", nil); err != nil {
			t.Fatal(err)
		}
		repo = w.Refresh()
		if repo.ChannelPaused {
			t.Fatal("expected resumed repo view")
		}
		if err := w.Engine.SetChannelPaused(false); err != nil {
			t.Fatal(err)
		}
		if dec, why, o, err := w.Engine.OfferLatest(ctx, repo, "dev-1", "dev"); err != nil || dec != update.DecisionStarted || o == nil || o.Release.ID() != "whombat-20261121.2" {
			t.Fatalf("resumed OfferLatest: %s %q %+v %v", dec, why, o, err)
		}
		run(t, w, 300, testworld.PhaseIs(update.Healthy))
		if st := w.State(); st.Current.ReleaseID != "whombat-20261121.2" {
			t.Fatalf("current %s", st.Current.ReleaseID)
		}
		// Pausing after installing .2 never downgrades back to .1.
		if _, err := w.Repo.PauseChannel("production", nil); err != nil {
			t.Fatal(err)
		}
		if dec, _, o, err := w.Engine.OfferLatest(ctx, w.Refresh(), "dev-1", "dev"); err != nil || dec != update.DecisionNoop || o != nil {
			t.Fatalf("pause after .2 offered %s %+v %v", dec, o, err)
		}
		if st := w.State(); st.Phase != update.Healthy || st.Current.ReleaseID != "whombat-20261121.2" {
			t.Fatalf("box downgraded on pause: phase=%s current=%s", st.Phase, st.Current.ReleaseID)
		}
	})

	t.Run("staged candidate is held while paused and proceeds after resume", func(t *testing.T) {
		w := testworld.New(t)
		w.SetChannel("production")
		askFirst(t, w, true)
		publishIn(t, w, "development", devtuf.StandardRelease("whombat-20261121.1", "26.05.1", "1.1.0"))
		if _, err := w.Repo.Promote("whombat-20261121.1", "development", "production", nil); err != nil {
			t.Fatal(err)
		}
		if dec, why, _, err := w.Engine.OfferLatest(ctx, w.Refresh(), "dev-1", "dev"); err != nil || dec != update.DecisionStarted {
			t.Fatalf("offer: %s %q %v", dec, why, err)
		}
		run(t, w, 300, waitsForOwner("whombat-20261121.1"))
		if _, err := w.Repo.PauseChannel("production", nil); err != nil {
			t.Fatal(err)
		}
		w.Refresh()
		if err := w.Engine.SetChannelPaused(true); err != nil {
			t.Fatal(err)
		}
		if _, err := w.Engine.Step(ctx); err != nil {
			t.Fatal(err)
		}
		if st := w.State(); st.Candidate == nil || st.Candidate.Deferral == nil || st.Candidate.Deferral.Waiting != "hold" {
			t.Fatalf("expected candidate held on pause: %+v", st.Candidate)
		}
		if err := w.Engine.Approve("whombat-20261121.1"); !errors.Is(err, update.ErrNotWaiting) {
			t.Fatalf("approved paused candidate: %v", err)
		}
		// Resume: candidate returns to waiting for the owner, then installs on approval.
		if _, err := w.Repo.ResumeChannel("production", nil); err != nil {
			t.Fatal(err)
		}
		w.Refresh()
		if err := w.Engine.SetChannelPaused(false); err != nil {
			t.Fatal(err)
		}
		run(t, w, 50, waitsForOwner("whombat-20261121.1"))
		approve(t, w, "whombat-20261121.1")
		run(t, w, 300, testworld.PhaseIs(update.Healthy))
		if st := w.State(); st.Current.ReleaseID != "whombat-20261121.1" {
			t.Fatalf("current %s", st.Current.ReleaseID)
		}
	})

	t.Run("rollback to the release before still works while paused", func(t *testing.T) {
		w := testworld.New(t)
		w.SetChannel("production")
		publishIn(t, w, "development", devtuf.StandardRelease("whombat-20261121.1", "26.05.1", "1.1.0"))
		if _, err := w.Repo.Promote("whombat-20261121.1", "development", "production", nil); err != nil {
			t.Fatal(err)
		}
		if dec, why, _, err := w.Engine.OfferLatest(ctx, w.Refresh(), "dev-1", "dev"); err != nil || dec != update.DecisionStarted {
			t.Fatalf("first offer: %s %q %v", dec, why, err)
		}
		run(t, w, 300, testworld.PhaseIs(update.Healthy))
		bad := devtuf.StandardRelease("whombat-20261121.2", "26.05.1", "1.2.0-bad")
		bad.RuntimeHealth = "bad"
		publishIn(t, w, "development", bad)
		if _, err := w.Repo.Promote("whombat-20261121.2", "development", "production", nil); err != nil {
			t.Fatal(err)
		}
		if dec, why, _, err := w.Engine.OfferLatest(ctx, w.Refresh(), "dev-1", "dev"); err != nil || dec != update.DecisionStarted {
			t.Fatalf("bad offer: %s %q %v", dec, why, err)
		}
		// Let activation start, then pause the channel before verification finishes: rollback to .1 must still succeed.
		run(t, w, 300, testworld.PhaseIs(update.Verifying))
		if _, err := w.Repo.PauseChannel("production", nil); err != nil {
			t.Fatal(err)
		}
		w.Refresh()
		if err := w.Engine.SetChannelPaused(true); err != nil {
			t.Fatal(err)
		}
		run(t, w, 500, testworld.PhaseIs(update.RolledBack))
		if st := w.State(); st.Current.ReleaseID != "whombat-20261121.1" || !st.ChannelPaused {
			t.Fatalf("after rollback while paused: current=%s paused=%v", st.Current.ReleaseID, st.ChannelPaused)
		}
	})

	t.Run("older channel role version or wrong channel never replaces a newer offer, even after restart", func(t *testing.T) {
		w := testworld.New(t)
		w.SetChannel("production")
		publishIn(t, w, "development", devtuf.StandardRelease("whombat-20261121.1", "26.05.1", "1.1.0"))
		if _, err := w.Repo.Promote("whombat-20261121.1", "development", "production", nil); err != nil {
			t.Fatal(err)
		}
		repoOld := w.Refresh()
		if dec, why, _, err := w.Engine.OfferLatest(ctx, repoOld, "dev-1", "dev"); err != nil || dec != update.DecisionStarted {
			t.Fatalf("offer .1: %s %q %v", dec, why, err)
		}

		// Publish and offer newer fix .2 at a higher channel role version.
		publishIn(t, w, "development", devtuf.StandardRelease("whombat-20261121.2", "26.05.1", "1.2.0"))
		if _, err := w.Repo.Promote("whombat-20261121.2", "development", "production", nil); err != nil {
			t.Fatal(err)
		}
		repoNew := w.Refresh()
		if dec, why, o, err := w.Engine.OfferLatest(ctx, repoNew, "dev-1", "dev"); err != nil || dec != update.DecisionStarted || o == nil || o.Release.ID() != "whombat-20261121.2" {
			t.Fatalf("offer .2: %s %q %+v %v", dec, why, o, err)
		}
		before := w.State()

		// Re-offering the older verified repo (both OfferLatest and OfferLatestNow) changes nothing.
		for _, nowOffer := range []bool{false, true} {
			var (
				dec update.Decision
				why string
				o   *update.Offered
				err error
			)
			if nowOffer {
				dec, why, o, err = w.Engine.OfferLatestNow(ctx, repoOld, "dev-1", "dev")
			} else {
				dec, why, o, err = w.Engine.OfferLatest(ctx, repoOld, "dev-1", "dev")
			}
			if err != nil || dec != update.DecisionNoop || o != nil {
				t.Fatalf("stale offer (now=%v): dec=%s why=%q o=%+v err=%v", nowOffer, dec, why, o, err)
			}
			after := w.State()
			if after.JournalSeq != before.JournalSeq || after.Candidate == nil || after.Candidate.Tuple.ReleaseID != "whombat-20261121.2" {
				t.Fatalf("stale offer mutated state (now=%v): seq=%d (was %d) cand=%+v", nowOffer, after.JournalSeq, before.JournalSeq, after.Candidate)
			}
		}

		// Metadata from another channel (development) is refused while following production.
		repoDev, err := w.TUF.RefreshIn(ctx, "development")
		if err != nil {
			t.Fatalf("refresh development: %v", err)
		}
		if dec, why, o, err := w.Engine.OfferLatestNow(ctx, repoDev, "dev-1", "dev"); err != nil || dec != update.DecisionNoop || o != nil {
			t.Fatalf("wrong-channel offer: dec=%s why=%q o=%+v err=%v", dec, why, o, err)
		}
		if after := w.State(); after.JournalSeq != before.JournalSeq {
			t.Fatalf("wrong-channel offer mutated journal seq %d -> %d", before.JournalSeq, after.JournalSeq)
		}

		// After reloading the Engine from the journal (simulated manager restart), the stale role version is still rejected.
		w.NewEngine()
		if dec, why, o, err := w.Engine.OfferLatestNow(ctx, repoOld, "dev-1", "dev"); err != nil || dec != update.DecisionNoop || o != nil {
			t.Fatalf("stale offer after restart: dec=%s why=%q o=%+v err=%v", dec, why, o, err)
		}
		if after := w.State(); after.JournalSeq != before.JournalSeq || after.Candidate.Tuple.ReleaseID != "whombat-20261121.2" {
			t.Fatalf("stale offer after restart mutated state: seq=%d cand=%+v", after.JournalSeq, after.Candidate)
		}
	})
}
