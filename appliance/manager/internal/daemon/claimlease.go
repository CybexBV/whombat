package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/CybexBV/whombat/appliance/manager/internal/config"
	"github.com/CybexBV/whombat/appliance/manager/internal/controlapi"
	"github.com/CybexBV/whombat/appliance/manager/internal/runtimeapi"
	"github.com/CybexBV/whombat/contracts/go/device"
)

// The claim-code lookup lease (CC-03, MG-28). While the device is unclaimed the manager leases the number
// its console shows from control (claim.lookup), renews it every renewAfterS and hands it to the runtime
// (POST /claim-lookup) after every renewal and after every runtime (re)start (runtimeSyncLoop). Without a
// live lease (control unreachable until the lease ran out) the runtime gets {lookup: null} and its console
// says "Connecting to Whombat…". Once the device is claimed — control answers already_claimed, the runtime
// reports the claim (/v1/runtime/claimed) or its facts say so — the manager pushes null, remembers it in
// <journal>/claim-state.json and never asks again. A retired device (device_revoked) stops too (MG-30).
//
// Control finds a waiting box for a browser on the same network by the network tag of the address family the
// browser uses, one tag per family (control CL-36). On a dual-stack network the manager's requests go over one
// family (usually IPv6) and a browser's may go over the other, so every successful renewal is followed by one more
// claim.lookup forced over the other family (MG-32). Without a route or a DNS record for that family it fails at
// once and is skipped quietly (logged once at debug); the lease itself only ever follows the normal request.
// At first boot the other family is often not up yet (an IPv6 address from router advertisements arrives seconds
// after DHCPv4): a failed attempt is repeated after claimLookupOtherFamilyRetrySec, at most otherFamilyRetries times in
// a row, so a browser on IPv6 finds the box within a minute instead of at the next renewal (MG-42).

// ClaimStateFile is the manager's record that the device is claimed (in the journal directory).
const ClaimStateFile = "claim-state.json"

type claimState struct {
	V         int    `json:"v"`
	Claimed   bool   `json:"claimed"`
	ClaimedAt string `json:"claimedAt,omitempty"`
}

type claimLease struct {
	mu        sync.Mutex
	lookup    string
	expiresAt time.Time
	claimed   bool
	retired   bool
	wake      chan struct{}
}

func (l *claimLease) current(now time.Time) (string, time.Time) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.lookup == "" || l.claimed || l.retired || !now.Before(l.expiresAt) {
		return "", time.Time{}
	}
	return l.lookup, l.expiresAt
}

func (l *claimLease) done() bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.claimed || l.retired
}

func (d *Daemon) claimStatePath() string { return filepath.Join(d.Cfg.JournalDir, ClaimStateFile) }

// loadClaimState reads the claimed record (a missing file: not known to be claimed).
func (d *Daemon) loadClaimState() {
	b, err := os.ReadFile(d.claimStatePath())
	if err != nil {
		return
	}
	var st claimState
	if json.Unmarshal(b, &st) == nil && st.Claimed {
		d.lease.mu.Lock()
		d.lease.claimed = true
		d.lease.mu.Unlock()
	}
}

// MarkClaimed records that the device is claimed (the broker calls it when the runtime reports the
// claim): the lease is dropped, the runtime told, and claim.lookup never called again.
func (d *Daemon) MarkClaimed() {
	d.lease.mu.Lock()
	already := d.lease.claimed
	d.lease.claimed, d.lease.lookup = true, ""
	d.lease.mu.Unlock()
	if already {
		return
	}
	b, _ := json.Marshal(claimState{V: 1, Claimed: true, ClaimedAt: time.Now().UTC().Format(time.RFC3339)})
	if err := writeFileAtomic(d.claimStatePath(), append(b, '\n')); err != nil {
		d.warnOnce("claim state", err)
	}
	d.Log.Info("claimed: the claim-code lease is released")
	select {
	case d.lease.wake <- struct{}{}:
	default:
	}
	d.licenceNudge()
}

func writeFileAtomic(path string, data []byte) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// pushLease hands the runtime the lease it should show (or none). A runtime without /claim-lookup (before
// contracts 0.7) is not an error.
func (d *Daemon) pushLease(ctx context.Context) error {
	lookup, exp := d.lease.current(time.Now())
	err := d.Runtime.SetClaimLookup(ctx, lookup, exp)
	if errors.Is(err, runtimeapi.ErrNotSupported) {
		return nil
	}
	return err
}

// claimLeaseLoop keeps the lease while the device is unclaimed.
func (d *Daemon) claimLeaseLoop(ctx context.Context) {
	if d.lease.done() {
		d.pushLeaseLogged(ctx)
		return
	}
	bo := &Backoff{Base: config.Seconds(d.Cfg.ClaimLookupRetrySec, 15*time.Second), Max: 5 * time.Minute}
	otherRetry := config.Seconds(d.Cfg.ClaimLookupOtherFamilyRetrySec, 30*time.Second)
	otherFailed := 0 // failed attempts over the other family in a row
	for ctx.Err() == nil && !d.lease.done() {
		var wait time.Duration
		if d.runtimeClaimed(ctx) {
			d.MarkClaimed()
			break
		}
		resp, family, err := d.Control.ClaimLookupOver(ctx, controlapi.FamilyAny)
		switch {
		case err == nil:
			d.clearErr("claim.lookup failed")
			bo.Reset()
			exp := time.Unix(resp.ExpiresAt, 0)
			d.lease.mu.Lock()
			changed := d.lease.lookup != resp.Lookup
			d.lease.lookup, d.lease.expiresAt = resp.Lookup, exp
			d.lease.mu.Unlock()
			if changed {
				d.Log.Info("claim-code lookup leased", "expiresAt", exp.UTC().Format(time.RFC3339))
			}
			wait = leaseWait(resp, time.Now(), d.Waits.LeaseRenew)
			switch {
			case d.lookupOverOtherFamily(ctx, family):
				otherFailed = 0
			case otherFailed < otherFamilyRetries:
				otherFailed++
				wait = min(wait, otherRetry)
			}
		case controlapi.IsAlreadyClaimed(err):
			d.MarkClaimed()
		case controlapi.IsRevoked(err):
			d.lease.mu.Lock()
			d.lease.retired, d.lease.lookup = true, ""
			d.lease.mu.Unlock()
			d.Log.Error("control retired this appliance (device_revoked); the claim code is withdrawn")
			d.pushLeaseLogged(ctx)
			d.onRetired(ctx)
			return
		default:
			d.warnOnce("claim.lookup failed", err)
			wait = bo.Next()
			// Retry before the lease runs out; once it has, the runtime shows no code.
			if _, exp := d.lease.current(time.Now()); !exp.IsZero() {
				wait = min(wait, max(time.Until(exp), time.Second))
			}
		}
		d.pushLeaseLogged(ctx)
		if d.lease.done() {
			break
		}
		select {
		case <-ctx.Done():
		case <-d.lease.wake:
		case <-time.After(wait):
		}
	}
	d.pushLeaseLogged(ctx)
}

// otherFamilyKey is the lastErr key of the renewal over the other address family.
const otherFamilyKey = "claim.lookup over the other address family"

// otherFamilyRetries: failed attempts over the other family repeated soon, in a row (MG-42); a network without that
// family costs this many extra renewals, then the attempt only rides along with the regular ones.
const otherFamilyRetries = 10

// lookupOverOtherFamily sends one claim.lookup forced over the address family the normal one didn't use, so control
// has the box's network tag of both families (MG-32). Its answer changes nothing here (a renewal of a live lease
// keeps the number); a failure — no route, no A/AAAA record, anything else — is logged once at debug and skipped.
// It reports whether the other family answered (true too when there is no other family to try).
func (d *Daemon) lookupOverOtherFamily(ctx context.Context, used string) bool {
	other := controlapi.OtherFamily(used)
	if other == controlapi.FamilyAny {
		return true
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	name := map[string]string{controlapi.FamilyIPv4: "IPv4", controlapi.FamilyIPv6: "IPv6"}[other]
	if _, _, err := d.Control.ClaimLookupOver(ctx, other); err != nil {
		if ctx.Err() == nil || errors.Is(ctx.Err(), context.DeadlineExceeded) {
			d.debugOnce(otherFamilyKey, "claim.lookup over "+name+" skipped", err)
		}
		return false
	}
	d.clearErr(otherFamilyKey)
	return true
}

func (d *Daemon) pushLeaseLogged(ctx context.Context) {
	if err := d.pushLease(ctx); err != nil {
		// The runtime isn't up yet or restarted: runtimeSyncLoop pushes it again when it answers.
		d.warnOnce("claim-lookup push to the runtime failed", err)
	} else {
		d.clearErr("claim-lookup push to the runtime failed")
	}
}

// runtimeClaimed: the runtime's facts say it is claimed (it reports the claim itself too; this covers a
// manager restart before that report arrived). Unreachable: not known.
func (d *Daemon) runtimeClaimed(ctx context.Context) bool {
	f, err := d.Runtime.RuntimeFacts(ctx)
	return err == nil && f.Claimed
}

// leaseWait: renew after renewAfterS (jittered), but always well before the lease expires, and never sooner than
// least.
func leaseWait(r *device.ClaimLookupResponse, now time.Time, least time.Duration) time.Duration {
	w := jitter(time.Duration(max(r.RenewAfterS, 30)) * time.Second)
	if left := time.Unix(r.ExpiresAt, 0).Sub(now); left > 0 {
		w = min(w, left/2)
	}
	return max(w, least)
}
