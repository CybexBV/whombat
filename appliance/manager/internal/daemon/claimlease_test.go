package daemon_test

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/manager/internal/config"
	"github.com/CybexBV/whombat/appliance/manager/internal/controlapi/fakecontrol"
	"github.com/CybexBV/whombat/appliance/manager/internal/daemon"
	"github.com/CybexBV/whombat/appliance/manager/internal/testworld"
)

// shortLease is a claim-code lease that runs out soon: it is renewed after half its remaining lifetime (the harness
// lets the manager renew that often, quickWaits), so within two seconds, and a control that stays away costs the
// lease in four.
const shortLease = 4 * time.Second

func unclaimed(w *testworld.World, _ *fakecontrol.Control, _ *config.Config) {
	w.Runtime.SetUnclaimed(true)
}

func leaseIs(w *testworld.World, lookup string) func() bool {
	return func() bool {
		l, _ := w.Runtime.ClaimLookup()
		if lookup == "" {
			return l != nil && l.Lookup == nil
		}
		return l != nil && l.Lookup != nil && *l.Lookup == lookup && l.ExpiresAt != nil
	}
}

func leaseDetail(w *testworld.World, fc *fakecontrol.Control) func() string {
	return func() string {
		l, n := w.Runtime.ClaimLookup()
		b, _ := json.Marshal(l)
		return fmt.Sprintf("runtime lease %s after %d pushes, %d claim.lookup calls", b, n, fc.LookupCount())
	}
}

// TestClaimLookupLease (MG-28, CC-03): an unclaimed device leases its lookup number, hands it to the runtime,
// renews it, hands it over again after a runtime restart, withdraws it when control stays away until the lease
// ran out, and releases it for good once control says the device is claimed.
func TestClaimLookupLease(t *testing.T) {
	t.Parallel()
	h := startDaemon(t, map[string]any{"claimLookupRetrySec": 1, "factsResendSec": 3600}, unclaimed,
		func(_ *testworld.World, fc *fakecontrol.Control, _ *config.Config) { fc.LookupTTL = shortLease })
	w, fc := h.w, h.fc
	detail := leaseDetail(w, fc)
	h.eventually("lease 4821 at the runtime", leaseIs(w, "4821"), detail)
	// Renewed well before it runs out (renewAfterS 300, but at most half the remaining lifetime).
	calls := fc.LookupCount()
	h.eventually("a renewal", func() bool { return fc.LookupCount() > calls }, detail)

	// A restarted runtime starts without a lease; the manager hands it over again.
	w.Runtime.Crash()
	time.Sleep(1500 * time.Millisecond) // away for a probe (every second)
	if err := w.Runtime.Start(w.P.AdminSock); err != nil {
		t.Fatal(err)
	}
	h.eventually("lease after the runtime restart", leaseIs(w, "4821"), detail)

	// Control away for longer than the lease: the runtime gets {lookup: null}; back: a lease again.
	fc.SetDown(true)
	h.eventually("lease withdrawn after it expired", leaseIs(w, ""), detail)
	fc.Set(func(c *fakecontrol.Control) { c.Lookup = "0042" })
	fc.SetDown(false)
	h.eventually("new lease once control is back", leaseIs(w, "0042"), detail)

	// Claimed (someone claimed it and control knows): null, remembered, never asked again.
	fc.Set(func(c *fakecontrol.Control) { c.LookupClaimed = true })
	h.eventually("lease released on already_claimed", leaseIs(w, ""), detail)
	if _, err := os.Stat(filepath.Join(w.P.Journal, daemon.ClaimStateFile)); err != nil {
		t.Fatalf("claimed state not recorded: %v", err)
	}
	calls = fc.LookupCount()
	time.Sleep(3 * time.Second) // the lease was renewed every second or two until now
	if fc.LookupCount() != calls {
		t.Fatal("claim.lookup called after the device was claimed")
	}
}

// TestClaimLookupBothFamilies (MG-32): against a dual-stack control the lease is renewed over IPv4 and IPv6, so
// control has the box's network tag of both families (CL-36); every renewal repeats it.
func TestClaimLookupBothFamilies(t *testing.T) {
	t.Parallel()
	var skip error
	h := startDaemon(t, map[string]any{"claimLookupRetrySec": 1, "factsResendSec": 3600}, unclaimed,
		func(_ *testworld.World, fc *fakecontrol.Control, cfg *config.Config) {
			fc.LookupTTL = shortLease
			url, err := fc.ServeDualStack()
			if err != nil {
				skip = err
				return
			}
			cfg.Control.URL = url
		})
	if skip != nil {
		t.Skipf("no IPv6 loopback: %v", skip)
	}
	w, fc := h.w, h.fc
	detail := func() string {
		v4, v6 := fc.LookupFamilies()
		return fmt.Sprintf("%s; %d over IPv4, %d over IPv6", leaseDetail(w, fc)(), v4, v6)
	}
	h.eventually("lease 4821 at the runtime", leaseIs(w, "4821"), detail)
	h.eventually("claim.lookup over both families", func() bool { v4, v6 := fc.LookupFamilies(); return v4 > 0 && v6 > 0 }, detail)
	v4, v6 := fc.LookupFamilies()
	h.eventually("a renewal over both families again", func() bool { a, b := fc.LookupFamilies(); return a > v4 && b > v6 }, detail)
}

// TestClaimLookupOtherFamilyLate (MG-42): at first boot the other family is not up yet (on a real network usually
// IPv6 from router advertisements after DHCPv4); the failed attempt is repeated soon, not only at the next renewal
// (300 s here), so control gets that family's tag within seconds once it works. On the loopback the normal request
// prefers IPv6, so here IPv4 is the late family; the logic doesn't depend on which one it is.
func TestClaimLookupOtherFamilyLate(t *testing.T) {
	t.Parallel()
	var skip error
	h := startDaemon(t, map[string]any{"claimLookupRetrySec": 1, "claimLookupOtherFamilyRetrySec": 1, "factsResendSec": 3600}, unclaimed,
		func(_ *testworld.World, fc *fakecontrol.Control, cfg *config.Config) {
			fc.LookupRefuseFamily = "ipv4"
			url, err := fc.ServeDualStack()
			if err != nil {
				skip = err
				return
			}
			cfg.Control.URL = url
		})
	if skip != nil {
		t.Skipf("no IPv6 loopback: %v", skip)
	}
	w, fc := h.w, h.fc
	detail := func() string {
		v4, v6 := fc.LookupFamilies()
		return fmt.Sprintf("%s; %d over IPv4, %d over IPv6", leaseDetail(w, fc)(), v4, v6)
	}
	h.eventually("lease 4821 at the runtime", leaseIs(w, "4821"), detail)
	time.Sleep(2 * time.Second) // a retry or two while IPv4 is still down
	fc.Set(func(c *fakecontrol.Control) { c.LookupRefuseFamily = "" })
	h.eventually("claim.lookup over IPv4 soon after it came up", func() bool { v4, _ := fc.LookupFamilies(); return v4 > 0 }, detail)
}

// TestClaimLookupOneFamily (MG-32): a control reachable over IPv4 only (its name has an AAAA record nobody answers
// on) still leases; the IPv6 attempt is skipped quietly and never counted as a failure.
func TestClaimLookupOneFamily(t *testing.T) {
	t.Parallel()
	h := startDaemon(t, map[string]any{"claimLookupRetrySec": 1, "factsResendSec": 3600}, unclaimed,
		func(_ *testworld.World, fc *fakecontrol.Control, cfg *config.Config) {
			fc.LookupTTL = shortLease
			cfg.Control.URL = strings.Replace(fc.Server.URL, "127.0.0.1", "localhost", 1)
		})
	w, fc := h.w, h.fc
	detail := leaseDetail(w, fc)
	h.eventually("lease 4821 at the runtime", leaseIs(w, "4821"), detail)
	calls := fc.LookupCount()
	h.eventually("a renewal", func() bool { return fc.LookupCount() > calls }, detail)
	if v4, v6 := fc.LookupFamilies(); v4 == 0 || v6 != 0 {
		t.Fatalf("families %d/%d", v4, v6)
	}
	if l, _ := w.Runtime.ClaimLookup(); l == nil || l.Lookup == nil {
		t.Fatal("lease withdrawn")
	}
}

// TestClaimReportedStopsLease (MG-28): the runtime's own claim report (/v1/runtime/claimed through the broker)
// releases the lease at once; a restarted manager remembers it and doesn't ask control again.
func TestClaimReportedStopsLease(t *testing.T) {
	t.Parallel()
	h := startDaemon(t, map[string]any{"claimLookupRetrySec": 1}, unclaimed)
	w, fc := h.w, h.fc
	detail := leaseDetail(w, fc)
	h.eventually("lease at the runtime", leaseIs(w, "4821"), detail)
	h.d.MarkClaimed()
	h.eventually("lease released", leaseIs(w, ""), detail)
	b, err := os.ReadFile(filepath.Join(w.P.Journal, daemon.ClaimStateFile))
	if err != nil || !json.Valid(b) {
		t.Fatalf("claim state: %v %s", err, b)
	}
}

// A claimed runtime (its facts say so) never gets a lease, even before control knows.
func TestClaimedRuntimeGetsNoLease(t *testing.T) {
	t.Parallel()
	h := startDaemon(t, nil)
	w, fc := h.w, h.fc
	h.eventually("null lease pushed", leaseIs(w, ""), leaseDetail(w, fc))
	if fc.LookupCount() != 0 {
		t.Fatalf("claim.lookup for a claimed runtime: %d", fc.LookupCount())
	}
}

// TestRetiredSelfInstalledAsksForNewKeys (MG-30): a retired, never-claimed self-installed appliance asks root
// for a re-registration; a factory appliance or a claimed one doesn't.
func TestRetiredSelfInstalledAsksForNewKeys(t *testing.T) {
	t.Parallel()
	for _, c := range []struct {
		name      string
		model     string
		unclaimed bool
		want      bool
	}{
		{"self-installed, never claimed", "self-installed", true, true},
		{"self-installed, claimed", "self-installed", false, false},
		{"factory", "whombat-one", true, false},
	} {
		t.Run(c.name, func(t *testing.T) {
			t.Parallel()
			var req string
			h := startDaemon(t, map[string]any{"claimLookupRetrySec": 1}, func(w *testworld.World, fc *fakecontrol.Control, cfg *config.Config) {
				w.Runtime.SetUnclaimed(c.unclaimed)
				fc.Retired = true
				req = filepath.Join(w.P.Dir, "reregister.json")
				cfg.ReregisterRequest = req
				os.WriteFile(filepath.Join(w.P.Dir, "identity", "device.json"),
					[]byte(`{"deviceId":"dev-1","env":"dev","applianceRoute":"rt_dev-1","model":"`+c.model+`"}`), 0o644)
			})
			if c.want {
				h.eventually("re-registration request", func() bool { _, err := os.Stat(req); return err == nil }, func() string { return "none" })
				var r daemon.ReregisterRequest
				b, _ := os.ReadFile(req)
				if json.Unmarshal(b, &r) != nil || r.DeviceID != "dev-1" || r.Reason != "device_retired" {
					t.Fatalf("request %s", b)
				}
				return
			}
			time.Sleep(3 * time.Second)
			if _, err := os.Stat(req); err == nil {
				t.Fatal("re-registration requested")
			}
		})
	}
}
