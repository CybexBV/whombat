package daemon

import (
	"context"
	"errors"
	"math/rand/v2"
	"sync"
	"time"

	"github.com/CybexBV/whombat/appliance/manager/internal/broker"
	"github.com/CybexBV/whombat/appliance/manager/internal/config"
	"github.com/CybexBV/whombat/appliance/manager/internal/controlapi"
	"github.com/CybexBV/whombat/appliance/manager/internal/licence"
	"github.com/CybexBV/whombat/appliance/manager/internal/runtimeapi"
	"github.com/CybexBV/whombat/contracts/go/local"
)

// The licence loop (LC-06, LC-08, MG-34..MG-37). Once the runtime reports a claim (GET /facts, or its own claim
// report through the broker) the manager renews the licence with the device op licence.renew: right away, then
// every renewAfterS from control (±10 %), and at once when the runtime asks (POST /v1/licence/renew on the manager
// socket, at most once a minute). Failures back off from 60 s to 1 h; device_unclaimed and
// devices_allowed_reached are retried hourly (a claim report still on its way, an org over its device limit);
// device_revoked stops the loop for good.
//
// Every token is verified against the key set pinned in the image (licence.keysFile) for this device before it is
// kept; an older iat than the held one is refused (stale). {token, highWater} lives in licence.stateFile (0600,
// atomic), highWater = max(accepted iats, control's now) and never goes down. The runtime gets
// POST /licence {v, token, highWater} whenever that changes, after every runtime (re)start (syncRuntime) and with
// the periodic facts re-send; a runtime before contracts 0.10.0 answers 404 and is simply asked again later.

// Licence renewal timings (LC-02).
const (
	licenceRetryBase   = time.Minute
	licenceRetryMax    = time.Hour
	licenceRetryRefuse = time.Hour   // device_unclaimed, devices_allowed_reached
	licenceMinRenewS   = 60          // the least renewAfterS the manager follows
	licenceForcedEvery = time.Minute // POST /v1/licence/renew
)

type licenceKeeper struct {
	v    licence.Verifier
	path string
	// renewMu serializes renewals (the loop and a forced renewal).
	renewMu sync.Mutex

	mu       sync.Mutex
	held     licence.Held
	next     time.Time // next scheduled renewal (wall clock of the process, not the licence clock)
	last     string    // outcome of the last renewal attempt ("" = renewed)
	attempts int       // renewal attempts (tests)
	bo       Backoff
	stopped  bool
	forcedAt time.Time
	pushed   licence.Held // what the runtime was last handed
	state    string       // the runtime's last reported state/reason (for the log)
	nudges   int          // licenceNudge calls; a nudge during a failing attempt still renews at once
	wake     chan struct{}
}

// LicenceSnapshot is what the manager holds (tests, diagnostics).
type LicenceSnapshot struct {
	Token     string
	Iat       int64
	HighWater int64
	Last      string
	Attempts  int
	Stopped   bool
}

// Licence returns what the licence loop holds; ok is false when the manager has no licence configuration.
func (d *Daemon) Licence() (s LicenceSnapshot, ok bool) {
	k := d.lic
	if k == nil {
		return s, false
	}
	k.mu.Lock()
	defer k.mu.Unlock()
	s = LicenceSnapshot{Token: k.held.Token, HighWater: k.held.HighWater, Last: k.last, Attempts: k.attempts, Stopped: k.stopped}
	if k.held.Claims != nil {
		s.Iat = k.held.Claims.Iat
	}
	return s, true
}

// clock is the licence clock (Clock in tests; the wall clock otherwise).
func (d *Daemon) clock() time.Time {
	if d.Clock != nil {
		return d.Clock()
	}
	return time.Now()
}

// setupLicence loads the pinned key set and the held state. A broken licence configuration never stops the
// manager: updates and security fixes don't depend on the licence (LC-10), so it logs and runs without one.
func (d *Daemon) setupLicence(cfg *config.Config) {
	if cfg.Licence.KeysFile == "" {
		return
	}
	ks, err := licence.LoadKeys(cfg.Licence.KeysFile)
	if err != nil {
		d.Log.Error("licence: no usable pinned key set; the licence is not renewed", "err", err)
		return
	}
	if ks.Env != d.Dev.Env {
		d.Log.Warn("licence: the pinned key set is for another environment", "keySet", ks.Env, "device", d.Dev.Env)
	}
	k := &licenceKeeper{v: licence.Verifier{Keys: ks, Device: d.Dev.DeviceID}, path: cfg.Licence.StateFile,
		bo: Backoff{Base: licenceRetryBase, Max: licenceRetryMax}, wake: make(chan struct{}, 1)}
	held, dropped, err := k.v.Load(k.path, d.clock().Unix())
	if err != nil {
		d.Log.Error("licence: state unreadable; starting without a token", "file", k.path, "err", err)
	}
	if dropped != nil {
		d.Log.Warn("licence: the stored token no longer verifies against the pinned key set; dropped", "err", dropped)
	}
	k.held = held
	// A restart renews when the stored renewal is due, at the latest a day from now (a clock that jumped back must
	// not postpone it longer); without a token or a stored time at once.
	if held.Token != "" && held.RenewAt > 0 {
		k.next = time.Now().Add(min(max(time.Duration(held.RenewAt-d.clock().Unix())*time.Second, 0), 24*time.Hour))
	}
	d.lic = k
}

func jitter10(d time.Duration) time.Duration {
	return d + time.Duration((rand.Float64()*0.2-0.1)*float64(d))
}

func (k *licenceKeeper) poke() {
	select {
	case k.wake <- struct{}{}:
	default:
	}
}

// licenceNudge renews at once when the last attempt found the device unclaimed or nothing is held yet (the runtime
// just reported its claim, or control confirmed it). No-op without a licence configuration.
func (d *Daemon) licenceNudge() {
	k := d.lic
	if k == nil {
		return
	}
	k.mu.Lock()
	k.nudges++
	if k.last == controlapi.LicenceUnclaimed || k.held.Token == "" {
		k.next = time.Time{}
	}
	k.mu.Unlock()
	k.poke()
}

// licenceClaimed: the manager saw the claim (claim-state.json) or the runtime's facts say claimed.
func (d *Daemon) licenceClaimed(ctx context.Context) bool {
	d.lease.mu.Lock()
	claimed := d.lease.claimed
	d.lease.mu.Unlock()
	return claimed || d.runtimeClaimed(ctx)
}

func (d *Daemon) licenceLoop(ctx context.Context) {
	k := d.lic
	if k == nil {
		return
	}
	probe := config.Seconds(d.Cfg.RuntimeProbeSec, 10*time.Second)
	for ctx.Err() == nil {
		k.mu.Lock()
		stopped := k.stopped
		k.mu.Unlock()
		if stopped {
			d.Log.Error("licence: control retired this appliance (device_revoked); licence renewal stopped")
			return
		}
		wait := probe
		if d.licenceClaimed(ctx) {
			k.mu.Lock()
			due := k.next
			k.mu.Unlock()
			if !time.Now().Before(due) {
				d.renewLicence(ctx)
			}
			k.mu.Lock()
			wait = max(time.Until(k.next), time.Second)
			k.mu.Unlock()
		}
		select {
		case <-ctx.Done():
		case <-k.wake:
		case <-time.After(wait):
		}
	}
}

// renewLicence runs one licence.renew and keeps, stores and pushes what it accepts. It returns whether a token was
// accepted and the outcome ("" when renewed; otherwise a LicenceRenewNowResult error code).
func (d *Daemon) renewLicence(ctx context.Context) (bool, string) {
	k := d.lic
	k.renewMu.Lock()
	defer k.renewMu.Unlock()
	k.mu.Lock()
	nudges := k.nudges
	k.mu.Unlock()
	resp, err := d.Control.LicenceRenew(ctx)
	now := d.clock()
	k.mu.Lock()
	k.attempts++
	if err != nil {
		out := controlapi.LicenceRefusal(err)
		switch out {
		case controlapi.LicenceRevoked:
			k.stopped = true
		case controlapi.LicenceUnclaimed, controlapi.LicenceDevicesReached:
			k.next = time.Now().Add(jitter10(licenceRetryRefuse))
			if out == controlapi.LicenceUnclaimed && k.nudges != nudges {
				k.next = time.Now() // the claim report reached control meanwhile
			}
		default:
			k.next = time.Now().Add(k.bo.Next())
		}
		k.last = out
		k.mu.Unlock()
		d.warnOnce("licence.renew failed ("+out+")", err)
		return false, out
	}
	prev := k.last
	held, _, err := k.v.Accept(k.held, resp.Token, resp.Now, now.Unix())
	if err != nil {
		out := "bad_token"
		if errors.Is(err, licence.ErrStale) {
			out = "stale"
		}
		k.last = out
		k.next = time.Now().Add(k.bo.Next())
		k.mu.Unlock()
		d.warnOnce("licence token refused ("+out+"); the held one is kept", err)
		return false, out
	}
	// Saved after every renewal: the token, the mark and when the next renewal is due (MG-38).
	after := jitter10(time.Duration(max(resp.RenewAfterS, licenceMinRenewS)) * d.Waits.LicenceSecond)
	held.RenewAt = now.Add(after).Unix()
	if err := licence.Save(k.path, held); err != nil {
		d.warnOnce("licence state not saved (kept in memory)", err)
	} else {
		d.clearErr("licence state not saved (kept in memory)")
	}
	k.held, k.last = held, ""
	k.bo.Reset()
	if prev != "" {
		defer d.clearErr("licence.renew failed (" + prev + ")")
	}
	k.next = time.Now().Add(after)
	c := held.Claims
	k.mu.Unlock()
	d.Log.Info("licence renewed", "plan", c.Plan, "state", c.State, "expiresAt", time.Unix(c.Exp, 0).UTC().Format(time.RFC3339),
		"highWater", held.HighWaterTime().Format(time.RFC3339), "renewAfterS", resp.RenewAfterS)
	if err := d.pushLicence(ctx); err != nil {
		d.warnOnce("licence push to the runtime failed", err)
	}
	return true, ""
}

// pushLicence hands the runtime the held token and high-water mark. Only a transport failure is an error (the
// caller retries: runtimeSyncLoop re-sends); a runtime without POST /licence, or one that refuses the token or holds
// a newer one, is logged and asked again with the next re-send.
func (d *Daemon) pushLicence(ctx context.Context) error {
	k := d.lic
	if k == nil {
		return nil
	}
	k.mu.Lock()
	held := k.held
	k.mu.Unlock()
	if held.Token == "" && held.HighWater <= 0 {
		return nil // nothing to say yet (never renewed)
	}
	st, err := d.Runtime.PushLicence(ctx, held.Token, held.HighWaterTime())
	switch {
	case errors.Is(err, runtimeapi.ErrNotSupported):
		d.debugOnce("licence push", "the runtime has no POST /licence (before contracts 0.10.0); asked again later", err)
		return nil
	case errors.Is(err, runtimeapi.ErrLicenceStale), errors.Is(err, runtimeapi.ErrLicenceRefused):
		d.warnOnce("licence push refused by the runtime", err)
		return nil
	case err != nil:
		return err
	}
	d.clearErr("licence push refused by the runtime")
	k.mu.Lock()
	k.pushed = held
	now := "unclaimed"
	if st != nil {
		now = string(st.State) + "/" + string(st.Reason)
	}
	logIt := now != k.state
	k.state = now
	k.mu.Unlock()
	if logIt {
		d.Log.Info("licence state at the runtime", "state", now)
	}
	return nil
}

// RenewNow is POST /v1/licence/renew (LC-08): one renewal now, answered after the attempt; broker.ErrLicenceBusy
// within a minute of the last one.
func (d *Daemon) RenewNow(ctx context.Context) (local.LicenceRenewNowResult, error) {
	k := d.lic
	res := local.LicenceRenewNowResult{V: 1}
	k.mu.Lock()
	if !k.forcedAt.IsZero() && time.Since(k.forcedAt) < licenceForcedEvery {
		k.mu.Unlock()
		return res, broker.ErrLicenceBusy
	}
	k.forcedAt = time.Now()
	stopped := k.stopped
	k.mu.Unlock()
	if stopped {
		e := controlapi.LicenceRevoked
		res.Error = &e
		return res, nil
	}
	renewed, out := d.renewLicence(ctx)
	k.poke() // the loop reschedules from this attempt
	res.Renewed = renewed
	if out != "" {
		res.Error = &out
	}
	return res, nil
}
