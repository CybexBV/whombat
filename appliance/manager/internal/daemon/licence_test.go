package daemon_test

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/manager/internal/config"
	"github.com/CybexBV/whombat/appliance/manager/internal/controlapi/fakecontrol"
	"github.com/CybexBV/whombat/appliance/manager/internal/daemon"
	"github.com/CybexBV/whombat/appliance/manager/internal/licence/licencetest"
	"github.com/CybexBV/whombat/appliance/manager/internal/runtimeapi/fakeruntime"
	"github.com/CybexBV/whombat/appliance/manager/internal/testworld"
	"github.com/CybexBV/whombat/contracts/go/local"
)

type fakeruntimeT = fakeruntime.Runtime

// withLicence pins the fake control's TEST key set in the manager's configuration (licence.keysFile) and lets the
// fake runtime verify pushed tokens with the same set, as the image gives both the same file (LC-03).
func withLicence(w *testworld.World, fc *fakecontrol.Control, c *config.Config) {
	ks := fc.LicenceKeySet()
	p, err := licencetest.WriteKeySet(w.P.Dir, ks)
	if err != nil {
		panic(err)
	}
	c.Licence.KeysFile = p
	c.Licence.StateFile = filepath.Join(w.P.Dir, "manager-state", "licence.json")
	w.Runtime.SetLicence(func(r *fakeruntimeT) { r.LicenceKeys, r.LicenceDevice = &ks, "dev-1" })
}

func (h *harness) licence() daemon.LicenceSnapshot {
	s, _ := h.d.Licence()
	return s
}

// TestLicenceInert (LNK-04): the licence is inert. A claimed box with a pinned key set and a control that would issue
// tokens renews nothing, at its start or after its claim, and the runtime's forced renewal answers 404 unavailable.
// The licence loop's own tests went with it (LNK-53: what was made inert is retired with it); phase 2 deletes the code.
func TestLicenceInert(t *testing.T) {
	t.Parallel()
	h := startDaemon(t, map[string]any{"factsResendSec": 3600}, withLicence,
		func(_ *testworld.World, fc *fakecontrol.Control, _ *config.Config) { fc.LicenceRenewAfterS = 60 })
	reportClaim(t, h)
	// Control heard from the box (its loops ran) and the runtime has its facts: a renewal would have happened by now.
	h.eventually("a status report", func() bool { return len(h.fc.StatusReports()) > 0 }, func() string { return "none" })
	if code, body := postRenew(t, h); code != http.StatusNotFound || !strings.Contains(string(body), `"unavailable"`) {
		t.Fatalf("renew now: %d %s", code, body)
	}
	time.Sleep(time.Second)
	if n := h.fc.LicenceCount(); n != 0 {
		t.Fatalf("%d licence.renew calls", n)
	}
	if s := h.licence(); s.Attempts != 0 || s.Token != "" {
		t.Fatalf("%+v", s)
	}
}

func managerClient(h *harness) *http.Client {
	sock := filepath.Join(filepath.Dir(h.w.P.HelperSock), "api.sock")
	return &http.Client{Timeout: time.Minute, Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		var d net.Dialer
		return d.DialContext(ctx, "unix", sock)
	}}}
}

func postRenew(t *testing.T, h *harness) (int, []byte) {
	t.Helper()
	var code int
	var body []byte
	h.eventually("manager socket answers", func() bool {
		resp, err := managerClient(h).Post("http://manager"+local.ManagerPathLicenceRenew, "application/json", strings.NewReader(`{"v":1}`))
		if err != nil {
			return false
		}
		defer resp.Body.Close()
		code = resp.StatusCode
		body, _ = io.ReadAll(resp.Body)
		return true
	}, func() string { return "no answer" })
	return code, body
}

// reportClaim is the runtime reporting its claim through the broker (POST /v1/runtime/claimed).
func reportClaim(t *testing.T, h *harness) {
	t.Helper()
	body := fmt.Sprintf(`{"claimId":"clm_%s","claimedAt":%q}`, strings.Repeat("a", 22), time.Now().UTC().Format(time.RFC3339))
	h.eventually("claim reported", func() bool {
		resp, err := managerClient(h).Post("http://manager"+local.ManagerPathClaimed, "application/json", strings.NewReader(body))
		if err != nil {
			return false
		}
		resp.Body.Close()
		return resp.StatusCode == http.StatusOK
	}, func() string { return "claim report refused" })
}
