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

// A stale verified TUF refresh (periodic vs manual check completing out of order, or metadata for another channel
// after a switch) must never clear a newer pause or overwrite the channel the box follows.
func TestSyncChannelPauseRejectsStaleAndOtherChannelMetadata(t *testing.T) {
	t.Parallel()
	w := testworld.NewAt(t, time.Now().UTC().Truncate(time.Second))
	w.SetChannel(trust.ChannelProduction)
	publishPauseTestRelease(t, w.Repo, "whombat-20261121.1", "26.05.1", "1.1.0", true)

	meta := httptest.NewServer(http.FileServer(http.Dir(w.Repo.MetadataDir())))
	defer meta.Close()

	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	ch := &updatechannel.Service{Helper: helperclient.Client{Socket: w.P.HelperSock}}
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
		Log:       log,
		Channel:   ch,
		TUF:       tuf,
		Engine:    w.Engine,
		engineNow: make(chan struct{}, 1),
		lastErr:   map[string]string{},
	}

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

	// Out-of-order completion: Refresh 1 now finishes offerLatest and calls syncChannelPause with the older unpaused repo.
	d.syncChannelPause(repoUnpausedOld)
	if !w.State().ChannelPaused {
		t.Fatal("stale unpaused refresh cleared a newer pause")
	}

	// Metadata verified for another channel (development, unpaused) while the box follows production is ignored.
	repoDevUnpaused, err := d.TUF.RefreshIn(ctx, trust.ChannelDevelopment)
	if err != nil {
		t.Fatalf("refresh development: %v", err)
	}
	if repoDevUnpaused.Channel != trust.ChannelDevelopment || repoDevUnpaused.ChannelPaused {
		t.Fatalf("expected unpaused development repo, got %+v", repoDevUnpaused)
	}
	d.syncChannelPause(repoDevUnpaused)
	if !w.State().ChannelPaused {
		t.Fatal("unpaused metadata from another channel cleared production pause")
	}

	// Switching the box to development applies development's unpaused state and ignores stale production pause metadata.
	if _, err := ch.Set(ctx, trust.ChannelDevelopment); err != nil {
		t.Fatalf("switch to development: %v", err)
	}
	d.syncChannelPause(repoDevUnpaused)
	if w.State().ChannelPaused {
		t.Fatal("switching to unpaused development did not clear pause")
	}
	d.syncChannelPause(repoPausedNew)
	if w.State().ChannelPaused {
		t.Fatal("production pause applied while box follows development")
	}

	// Switching back to production still rejects the older unpaused version, but re-applies the at-least-as-new paused version.
	if _, err := ch.Set(ctx, trust.ChannelProduction); err != nil {
		t.Fatalf("switch back to production: %v", err)
	}
	d.syncChannelPause(repoUnpausedOld)
	if w.State().ChannelPaused {
		t.Fatal("stale unpaused production repo unexpectedly changed pause state")
	}
	d.syncChannelPause(repoPausedNew)
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
	d.syncChannelPause(repoResumed)
	if w.State().ChannelPaused {
		t.Fatal("newer resumed refresh did not clear pause")
	}
}
