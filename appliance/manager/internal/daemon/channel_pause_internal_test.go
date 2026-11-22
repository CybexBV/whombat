package daemon

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/helper/pkg/trust"
	"github.com/CybexBV/whombat/appliance/manager/internal/config"
	"github.com/CybexBV/whombat/appliance/manager/internal/controlapi"
	"github.com/CybexBV/whombat/appliance/manager/internal/helperclient"
	"github.com/CybexBV/whombat/appliance/manager/internal/testworld"
	"github.com/CybexBV/whombat/appliance/manager/internal/tufclient"
	"github.com/CybexBV/whombat/appliance/manager/internal/updatechannel"
	"github.com/CybexBV/whombat/appliance/release-tools/devtuf"
)

func publishPauseTestRelease(t *testing.T, r *devtuf.Repo, id, hostV, rtV string, promote bool) {
	t.Helper()
	if err := r.InChannel(trust.ChannelDevelopment); err != nil {
		t.Fatal(err)
	}
	if _, err := r.AddFakeRelease(devtuf.StandardRelease(id, hostV, rtV)); err != nil {
		t.Fatal(err)
	}
	if err := r.Publish(); err != nil {
		t.Fatal(err)
	}
	_ = r.InChannel("")
	if promote {
		if _, err := r.Promote(id, trust.ChannelDevelopment, trust.ChannelProduction, nil); err != nil {
			t.Fatal(err)
		}
	}
}

func newPauseTestDaemon(t *testing.T, w *testworld.World) (*Daemon, *updatechannel.Service) {
	t.Helper()
	meta := httptest.NewServer(http.FileServer(http.Dir(w.Repo.MetadataDir())))
	t.Cleanup(meta.Close)
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	ch := &updatechannel.Service{Helper: helperclient.Client{Socket: w.P.HelperSock}}
	w.Engine.Channel = ch.Current
	tuf := &tufclient.Client{
		PinnedRootPath: w.P.Pinned,
		CacheDir:       t.TempDir(),
		MirrorDir:      w.P.Mirror,
		MetadataURL:    meta.URL,
		Fetcher:        tufclient.NewHTTPFetcher("test"),
		Channel:        ch.Current,
	}
	d := &Daemon{
		Cfg:       &config.Config{},
		Dev:       &config.Device{DeviceID: "dev-1", Env: "dev"},
		Log:       log,
		Channel:   ch,
		TUF:       tuf,
		Engine:    w.Engine,
		engineNow: make(chan struct{}, 1),
		lastErr:   map[string]string{},
	}
	return d, ch
}

// A stale verified TUF refresh (periodic vs manual check completing out of order, or metadata for another channel
// after a switch) must never offer a stale release, clear a newer pause, or overwrite the channel the box follows.
func TestApplyRepoRejectsStaleAndOtherChannelMetadata(t *testing.T) {
	t.Parallel()
	w := testworld.NewAt(t, time.Now().UTC().Truncate(time.Second))
	w.SetChannel(trust.ChannelProduction)
	publishPauseTestRelease(t, w.Repo, "whombat-20261121.1", "26.05.1", "1.1.0", true)
	d, ch := newPauseTestDaemon(t, w)
	ctx := context.Background()

	// Refresh 1 (e.g. periodic tufLoop): verified unpaused production metadata at version V.
	repoUnpausedOld, err := d.refreshTUF(ctx)
	if err != nil {
		t.Fatalf("refresh unpaused: %v", err)
	}
	if repoUnpausedOld.Channel != trust.ChannelProduction || repoUnpausedOld.ChannelPaused {
		t.Fatalf("expected unpaused production repo, got %+v", repoUnpausedOld)
	}

	// Pause production -> version V+1. Refresh 2 (e.g. manual CheckNow) runs and applies the pause immediately.
	if _, err := w.Repo.PauseChannel(trust.ChannelProduction, nil); err != nil {
		t.Fatal(err)
	}
	repoPausedNew, err := d.refreshTUF(ctx)
	if err != nil {
		t.Fatalf("refresh paused: %v", err)
	}
	if !repoPausedNew.ChannelPaused || repoPausedNew.ChannelVersion <= repoUnpausedOld.ChannelVersion {
		t.Fatalf("expected newer paused production repo, got old=%d new=%d paused=%v",
			repoUnpausedOld.ChannelVersion, repoPausedNew.ChannelVersion, repoPausedNew.ChannelPaused)
	}
	if !w.State().ChannelPaused {
		t.Fatal("newer paused refresh did not set ChannelPaused")
	}

	// Out-of-order completion: Refresh 1 now calls applyRepo with the older unpaused repo — changes neither candidate nor pause.
	seqBefore := w.State().JournalSeq
	if res, err := d.applyRepo(ctx, repoUnpausedOld, true, true); err != nil || res.Result != controlapi.ResultNone {
		t.Fatalf("stale unpaused applyRepo: %+v %v", res, err)
	}
	if !w.State().ChannelPaused || w.State().Candidate != nil || w.State().JournalSeq != seqBefore {
		t.Fatalf("stale unpaused refresh mutated state: paused=%v cand=%+v seq=%d (was %d)",
			w.State().ChannelPaused, w.State().Candidate, w.State().JournalSeq, seqBefore)
	}

	// Metadata verified for another channel (development, unpaused) while the box follows production is ignored.
	repoDevUnpaused, err := d.TUF.RefreshIn(ctx, trust.ChannelDevelopment)
	if err != nil {
		t.Fatalf("refresh development: %v", err)
	}
	if repoDevUnpaused.Channel != trust.ChannelDevelopment || repoDevUnpaused.ChannelPaused {
		t.Fatalf("expected unpaused development repo, got %+v", repoDevUnpaused)
	}
	if res, err := d.applyRepo(ctx, repoDevUnpaused, true, true); err != nil || res.Result != controlapi.ResultNone {
		t.Fatalf("other-channel applyRepo: %+v %v", res, err)
	}
	if !w.State().ChannelPaused || w.State().Candidate != nil || w.State().JournalSeq != seqBefore {
		t.Fatal("unpaused metadata from another channel mutated production state")
	}

	// Switching the box to development applies development's unpaused state and ignores stale production pause metadata.
	if _, err := ch.Set(ctx, trust.ChannelDevelopment); err != nil {
		t.Fatalf("switch to development: %v", err)
	}
	if _, err := d.applyRepo(ctx, repoDevUnpaused, false, false); err != nil {
		t.Fatalf("apply development: %v", err)
	}
	if w.State().ChannelPaused {
		t.Fatal("switching to unpaused development did not clear pause")
	}
	if _, err := d.applyRepo(ctx, repoPausedNew, true, true); err != nil {
		t.Fatalf("other-channel paused applyRepo: %v", err)
	}
	if w.State().ChannelPaused {
		t.Fatal("production pause applied while box follows development")
	}

	// Switching back to production still rejects the older unpaused version, but re-applies the at-least-as-new paused version.
	if _, err := ch.Set(ctx, trust.ChannelProduction); err != nil {
		t.Fatalf("switch back to production: %v", err)
	}
	if _, err := d.applyRepo(ctx, repoUnpausedOld, true, true); err != nil {
		t.Fatalf("stale production applyRepo: %v", err)
	}
	if w.State().ChannelPaused || w.State().Candidate != nil {
		t.Fatal("stale unpaused production repo unexpectedly changed pause state or offered a release")
	}
	if _, err := d.applyRepo(ctx, repoPausedNew, false, false); err != nil {
		t.Fatalf("re-apply production pause: %v", err)
	}
	if !w.State().ChannelPaused {
		t.Fatal("re-applying current production paused version after switching back did not restore pause")
	}

	// Resuming production (version V+2, unpaused) is newer and clears the pause.
	if _, err := w.Repo.ResumeChannel(trust.ChannelProduction, nil); err != nil {
		t.Fatal(err)
	}
	repoResumed, err := d.refreshTUF(ctx)
	if err != nil {
		t.Fatalf("refresh resumed: %v", err)
	}
	if repoResumed.ChannelPaused || repoResumed.ChannelVersion <= repoPausedNew.ChannelVersion {
		t.Fatalf("expected newer resumed production repo, got paused=%d resumed=%d channelPaused=%v",
			repoPausedNew.ChannelVersion, repoResumed.ChannelVersion, repoResumed.ChannelPaused)
	}
	if _, err := d.applyRepo(ctx, repoResumed, false, false); err != nil {
		t.Fatalf("apply resumed: %v", err)
	}
	if w.State().ChannelPaused {
		t.Fatal("newer resumed refresh did not clear pause")
	}
}

// An older refresh arriving after a paused channel resumed with a newer fix must change nothing: it must not replace
// the newly offered fix with the older held candidate, nor re-pause the channel.
func TestOlderRefreshAfterResumeFixChangesNothing(t *testing.T) {
	t.Parallel()
	w := testworld.NewAt(t, time.Now().UTC().Truncate(time.Second))
	w.SetChannel(trust.ChannelProduction)
	publishPauseTestRelease(t, w.Repo, "whombat-20261121.2", "26.05.1", "1.2.0", true)
	d, _ := newPauseTestDaemon(t, w)
	ctx := context.Background()

	// Refresh 1 verifies unpaused production with bad release .2 at version V.
	repoBadUnpaused, err := d.refreshTUF(ctx)
	if err != nil {
		t.Fatalf("refresh bad unpaused: %v", err)
	}
	if _, err := d.applyRepo(ctx, repoBadUnpaused, true, false); err != nil {
		t.Fatalf("offer .2: %v", err)
	}
	if st := w.State(); st.Candidate == nil || st.Candidate.Tuple.ReleaseID != "whombat-20261121.2" {
		t.Fatalf("expected .2 candidate, got %+v", st.Candidate)
	}

	// Production is paused at V+1 while .2 is held.
	if _, err := w.Repo.PauseChannel(trust.ChannelProduction, nil); err != nil {
		t.Fatal(err)
	}
	repoPaused, err := d.refreshTUF(ctx)
	if err != nil {
		t.Fatalf("refresh paused: %v", err)
	}
	if !w.State().ChannelPaused {
		t.Fatal("expected channel paused")
	}

	// Fix .3 is promoted and production is resumed at V+3. Refresh 2 applies the fix and unpauses in one decision.
	publishPauseTestRelease(t, w.Repo, "whombat-20261121.3", "26.05.1", "1.3.0", true)
	if _, err := w.Repo.ResumeChannel(trust.ChannelProduction, nil); err != nil {
		t.Fatal(err)
	}
	repoFixResumed, err := d.refreshTUF(ctx)
	if err != nil {
		t.Fatalf("refresh fix resumed: %v", err)
	}
	res, err := d.applyRepo(ctx, repoFixResumed, true, true)
	if err != nil || res.Result != controlapi.ResultAssigned {
		t.Fatalf("apply fix resumed: %+v %v", res, err)
	}
	before := w.State()
	if before.ChannelPaused || before.Candidate == nil || before.Candidate.Tuple.ReleaseID != "whombat-20261121.3" {
		t.Fatalf("expected unpaused .3 candidate, got paused=%v cand=%+v", before.ChannelPaused, before.Candidate)
	}

	// Now the older unpaused refresh (.2, V) and older paused refresh (V+1) arrive late: neither changes anything.
	for _, tc := range []struct {
		name string
		repo *trust.Repo
		now  bool
	}{
		{"stale unpaused .2 periodic", repoBadUnpaused, false},
		{"stale unpaused .2 manual", repoBadUnpaused, true},
		{"stale paused V+1", repoPaused, true},
	} {
		got, err := d.applyRepo(ctx, tc.repo, true, tc.now)
		if err != nil {
			t.Fatalf("%s: unexpected error: %v", tc.name, err)
		}
		if got.Result != controlapi.ResultNone {
			t.Fatalf("%s: expected ResultNone, got %+v", tc.name, got)
		}
		after := w.State()
		if after.JournalSeq != before.JournalSeq ||
			after.ChannelPaused != before.ChannelPaused ||
			after.LastAssignmentSeq != before.LastAssignmentSeq ||
			after.LastOffer != before.LastOffer ||
			after.Candidate == nil ||
			after.Candidate.Tuple.ReleaseID != "whombat-20261121.3" {
			t.Fatalf("%s mutated state: got seq=%d paused=%v lastSeq=%d lastOffer=%q cand=%+v; want seq=%d paused=%v lastSeq=%d lastOffer=%q cand=.3",
				tc.name, after.JournalSeq, after.ChannelPaused, after.LastAssignmentSeq, after.LastOffer, after.Candidate,
				before.JournalSeq, before.ChannelPaused, before.LastAssignmentSeq, before.LastOffer)
		}
	}
}
