package daemon_test

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/manager/internal/config"
	"github.com/CybexBV/whombat/appliance/manager/internal/controlapi/fakecontrol"
	"github.com/CybexBV/whombat/appliance/manager/internal/testworld"
	"github.com/CybexBV/whombat/appliance/manager/internal/update"
	"github.com/CybexBV/whombat/appliance/release-tools/devtuf"
	"github.com/CybexBV/whombat/contracts/go/local"
)

// A community box's manager (MG-136): no control at all. It takes the newest release of its own repository after every
// TUF refresh (and at once for a check), through the same engine path, hands the runtime its facts, and answers what
// needs control with 404 unavailable.
func TestCommunityDaemon(t *testing.T) {
	t.Parallel()
	h := startDaemon(t, map[string]any{"edition": "community", "control": map[string]any{"url": ""}},
		func(w *testworld.World, _ *fakecontrol.Control, c *config.Config) {
			w.SetEdition("community")
			w.Keep(testworld.Factory, testworld.RuntimeGood)
		})
	w, fc := h.w, h.fc
	h.waitFor("rt-2, the newest, healthy", func(st *update.State) bool {
		return st.Phase == update.Healthy && st.Current.ReleaseID == testworld.RuntimeGood
	})
	h.eventually("facts at the runtime", func() bool {
		f := w.Runtime.Facts()
		return f != nil && f.Update != nil && f.Update.Current == testworld.RuntimeGood && f.Update.LastCheckedAt != nil
	}, func() string { return fmt.Sprintf("%+v", w.Runtime.Facts()) })
	if _, err := os.Stat(w.P.Assignment); err == nil {
		t.Fatal("an assignment file was written")
	}
	// A check: nothing newer, then a new publication taken at once.
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	res, err := h.d.CheckNow(ctx)
	if err != nil || res.Result != "none" || res.Decision != "" {
		t.Fatalf("check without anything newer: %+v %v", res, err)
	}
	if _, err := w.Repo.AddFakeRelease(devtuf.StandardRelease(testworld.RuntimeNext, "26.05.1", "1.1.5")); err != nil {
		t.Fatal(err)
	}
	if err := w.Repo.Publish(); err != nil {
		t.Fatal(err)
	}
	res, err = h.d.CheckNow(ctx)
	if err != nil || (res.Result != "assigned" && res.Result != "unchanged") {
		t.Fatalf("check with a newer release: %+v %v", res, err)
	}
	h.waitFor("rt-8 healthy", func(st *update.State) bool {
		return st.Phase == update.Healthy && st.Current.ReleaseID == testworld.RuntimeNext
	})
	// What goes through control isn't there; nothing ever reached the fake control.
	sock := filepath.Join(filepath.Dir(w.P.HelperSock), "api.sock")
	hc := &http.Client{Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		var d net.Dialer
		return d.DialContext(ctx, "unix", sock)
	}}}
	for path, body := range map[string]string{
		local.ManagerPathTicket:  `{"class":"session"}`,
		local.ManagerPathClaimed: `{"claimId":"c1","claimedAt":"2026-10-24T08:00:00Z"}`,
		local.ManagerPathPush:    `{}`,
	} {
		resp, err := hc.Post("http://manager"+path, "application/json", strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusNotFound {
			t.Fatalf("%s: %d", path, resp.StatusCode)
		}
	}
	if p, n := fc.LastProgress(); n != 0 || len(fc.StatusReports()) != 0 {
		t.Fatalf("control heard from a community box: %d reports (%+v), %d status", n, p, len(fc.StatusReports()))
	}
	if l, _ := w.Runtime.ClaimLookup(); l != nil {
		t.Fatalf("a claim lookup lease reached the runtime: %+v", l)
	}
}

// A release published while the box installs the one before (Home, 2026-11-26, two releases a minute apart): the helper
// refuses that one at activation as no longer the newest, and the manager takes the newest at once, not after its next
// refresh an hour later.
func TestCommunityNewerWhileInstalling(t *testing.T) {
	t.Parallel()
	const newer = "rt-20-newer"
	h := startDaemon(t, map[string]any{"edition": "community", "control": map[string]any{"url": ""}, "refreshSec": 3600},
		func(w *testworld.World, _ *fakecontrol.Control, c *config.Config) {
			w.SetEdition("community")
			w.Keep(testworld.Factory, testworld.RuntimeGood)
		})
	w := h.w
	h.waitFor("rt-2, the newest, healthy", func(st *update.State) bool {
		return st.Phase == update.Healthy && st.Current.ReleaseID == testworld.RuntimeGood
	})
	// Work holds the next update at the boundary while a newer release comes out.
	w.Runtime.SetBlockers([]local.DrainBlocker{{Kind: "turn", ID: "t1", Description: "long turn", Since: "2026-11-26T11:58:00Z"}}, -1)
	publish := func(id, version string) {
		t.Helper()
		if _, err := w.Repo.AddFakeRelease(devtuf.StandardRelease(id, "26.05.1", version)); err != nil {
			t.Fatal(err)
		}
		if err := w.Repo.Publish(); err != nil {
			t.Fatal(err)
		}
	}
	publish(testworld.RuntimeNext, "1.1.5")
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if res, err := h.d.CheckNow(ctx); err != nil || res.Result != "assigned" {
		t.Fatalf("check with rt-8 out: %+v %v", res, err)
	}
	h.waitFor("rt-8 waiting for the work", func(st *update.State) bool {
		return st.Phase == update.WaitingForSafeBoundary && st.Candidate != nil && st.Candidate.Release.ID() == testworld.RuntimeNext
	})
	publish(newer, "1.1.6")
	w.Runtime.SetBlockers(nil, 0)
	h.waitFor("the newer release healthy, without a check", func(st *update.State) bool {
		return st.Phase == update.Healthy && st.Current.ReleaseID == newer
	})
}
