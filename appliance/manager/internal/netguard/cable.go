package netguard

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"time"

	"github.com/CybexBV/whombat/appliance/helper/pkg/atomicfile"
	"github.com/CybexBV/whombat/appliance/helper/pkg/proto"
	"github.com/CybexBV/whombat/contracts/go/protocol"
)

// Cable changes (Wi-Fi only and back; Whombat docs/decisions/network-move.md): the helper's cable-set switches the wired
// interfaces off or on, with the guard of a Wi-Fi join. The change takes the maintenance lock, runs `applying` (the
// helper's cable-set, its dead-man armed when guarded), then `confirming` until the manager reaches control or the
// deadline passes (`reverting` → `reverted`, failure no_internet). It is guarded only when the box was online before.
// One change at a time across wired candidates, Wi-Fi and the cable.
//
// While the box uses Wi-Fi only, the cable is its backup: the manager checks control every minute, and when it hasn't
// reached it for five minutes in a row and a cable is plugged in, it tries the cable by itself (`by: backup`), guarded
// like a person's change. Kept when the cable reaches control (which ends Wi-Fi only); switched off again when it
// doesn't, and then the next try waits half an hour.

// CableState is a cable change, persisted in <StateDir>/cable.json.
type CableState struct {
	ID       string    `json:"id"`
	Use      string    `json:"use"`
	By       string    `json:"by"`
	Phase    string    `json:"phase"`
	Deadline time.Time `json:"deadline"`
	Failure  string    `json:"failure,omitempty"`
	// Guarded: the box was online before, so the change is kept only once the manager reaches control with it.
	Guarded    bool      `json:"guarded"`
	ConfirmSec int       `json:"confirmSec"`
	EndedAt    time.Time `json:"endedAt,omitzero"`
	UpdatedAt  time.Time `json:"updatedAt"`
}

// Who asked for a cable change.
const (
	CableByPerson = "person"
	CableByBackup = "backup"
)

// cableBudget is the helper's time to switch (networkd's reload and reconfiguration) and a margin.
const cableBudget = 30 * time.Second

// The cable as the backup: how often the manager checks control while the box uses Wi-Fi only, and how long it must
// have failed to reach it before the cable is used again.
const (
	DefaultBackupEvery = time.Minute
	DefaultBackupAfter = 5 * time.Minute
	// DefaultBackupRetryAfter: after the cable was tried and didn't reach control either, the next try waits this long.
	DefaultBackupRetryAfter = 30 * time.Minute
	// backupConfirmSec: how long the cable has to reach control before the backup is undone (a person's change's 2
	// minutes).
	backupConfirmSec = 120
)

// Refusals of CableSet (the local contract's codes; ErrNoWifi and ErrBusy too).
var (
	ErrNotConnected = errors.New("the Wi-Fi isn't connected to a network")
	ErrNoCable      = errors.New("no cable is plugged in")
	ErrUnchanged    = errors.New("the network is set that way already")
	// ErrCableUnknown: the helper doesn't answer what the cable is (a helper from before the cable).
	ErrCableUnknown = errors.New("the helper can't say how the cable is set")
)

func (g *Guard) cablePath() string { return filepath.Join(g.StateDir, "cable.json") }

func (g *Guard) log() *slog.Logger {
	if g.Log != nil {
		return g.Log
	}
	return slog.New(slog.DiscardHandler)
}

func (g *Guard) loadCable() (*CableState, error) {
	b, err := os.ReadFile(g.cablePath())
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var s CableState
	if err := json.Unmarshal(b, &s); err != nil {
		return nil, err
	}
	return &s, nil
}

// saveCable writes the cable change; callers hold wmu.
func (g *Guard) saveCable(s *CableState) error {
	s.UpdatedAt = g.now()
	if (s.Phase == PhaseCommitted || s.Phase == PhaseReverted || s.Phase == PhaseFailed) && s.EndedAt.IsZero() {
		s.EndedAt = s.UpdatedAt
	}
	b, _ := json.Marshal(s)
	if err := os.MkdirAll(g.StateDir, 0o700); err != nil {
		return err
	}
	return atomicfile.WriteFile(g.cablePath(), b, 0o600)
}

func (g *Guard) putCable(s *CableState) error {
	g.wmu.Lock()
	defer g.wmu.Unlock()
	return g.saveCable(s)
}

// change is the state as the contract's CableChange.
func (s *CableState) change() protocol.CableChange {
	c := protocol.CableChange{ID: s.ID, Use: protocol.CableUse(s.Use), By: protocol.CableChangeBy(s.By),
		Phase: protocol.NetworkChangePhase(s.Phase), Deadline: s.Deadline.UTC().Format(time.RFC3339)}
	if s.Phase == PhaseReverting || s.Phase == PhaseReverted || s.Phase == PhaseFailed {
		f := protocol.NetworkChangeFailure(s.Failure)
		if f == "" {
			f = protocol.NetworkChangeFailureFailed
		}
		c.Failure = &f
	}
	return c
}

// CableChange is the cable change to show: a running one, or one that ended less than ShownAfterEnd ago; nil else.
func (g *Guard) CableChange() *protocol.CableChange {
	g.wmu.Lock()
	st, err := g.loadCable()
	g.wmu.Unlock()
	if err != nil || st == nil {
		return nil
	}
	if !running(st.Phase) && g.now().Sub(st.EndedAt) > ShownAfterEnd {
		return nil
	}
	c := st.change()
	return &c
}

// WifiOnly asks the helper whether the cable is switched off now (pending or kept).
func (g *Guard) WifiOnly(ctx context.Context) (bool, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	res, err := g.Helper.Do(ctx, proto.Request{V: proto.Version, Op: proto.OpCableStatus})
	if err != nil {
		if proto.CodeOf(err) == proto.CodeBadRequest {
			return false, ErrCableUnknown
		}
		return false, err
	}
	if res.Cable == nil {
		return false, ErrCableUnknown
	}
	return res.Cable.Off, nil
}

// Plugged reports whether a cable is plugged into any wired interface (its carrier, also while switched off).
func (g *Guard) Plugged() bool {
	for _, w := range g.Wired() {
		if w.Plugged != nil && *w.Plugged {
			return true
		}
	}
	return false
}

// CableSet starts using Wi-Fi only (use wifi) or the cable again (use cable); 202 with its change, the network loop
// makes it.
func (g *Guard) CableSet(ctx context.Context, use string, confirmSec int) (protocol.CableChange, error) {
	if err := g.refuseBusy(); err != nil {
		return protocol.CableChange{}, err
	}
	off, err := g.WifiOnly(ctx)
	if err != nil {
		return protocol.CableChange{}, err
	}
	switch use {
	case proto.CableUseWifi:
		if off {
			return protocol.CableChange{}, ErrUnchanged
		}
		ws, err := g.wifiNow(ctx)
		if err != nil {
			return protocol.CableChange{}, err
		}
		if ws.Connected == nil || (ws.State != "connected" && ws.State != "roaming") || g.addr(ws.Interface) == "" {
			return protocol.CableChange{}, ErrNotConnected
		}
	case proto.CableUseCable:
		if !off {
			return protocol.CableChange{}, ErrUnchanged
		}
		if !g.Plugged() {
			return protocol.CableChange{}, ErrNoCable
		}
	default:
		return protocol.CableChange{}, errors.New("use is wifi or cable")
	}
	online := g.CheckOnline(ctx, 5*time.Second)
	return g.beginCable(&CableState{Use: use, By: CableByPerson, Guarded: online, ConfirmSec: confirmSec})
}

// beginCable records a new cable change after CableSet's checks (or the backup's).
func (g *Guard) beginCable(s *CableState) (protocol.CableChange, error) {
	g.wmu.Lock()
	defer g.wmu.Unlock()
	if b, err := g.busy(); err != nil || b {
		if err != nil {
			return protocol.CableChange{}, err
		}
		return protocol.CableChange{}, ErrBusy
	}
	ttl := cableBudget + time.Duration(s.ConfirmSec)*time.Second + 2*time.Minute
	if err := g.Lock.AcquireLock("network", "cable "+s.Use+" "+s.ID, ttl); err != nil {
		return protocol.CableChange{}, ErrBusy
	}
	s.ID, s.Phase = newChangeID(), PhaseApplying
	s.Deadline = g.now().Add(cableBudget + time.Duration(s.ConfirmSec)*time.Second)
	if err := g.saveCable(s); err != nil {
		_ = g.Lock.ReleaseLock("network")
		return protocol.CableChange{}, err
	}
	g.log().Info("network.cable_set", "use", s.Use, "by", s.By, "changeId", s.ID, "guarded", s.Guarded)
	g.nudge()
	return s.change(), nil
}

func (g *Guard) endCable(s *CableState, phase, failure string) error {
	s.Phase, s.Failure = phase, failure
	_ = g.Lock.ReleaseLock("network")
	if phase != PhaseFailed {
		// The box reaches the internet another way now: the last check was made the way before.
		g.staleOnline()
	}
	g.log().Info("network.cable_set ended", "use", s.Use, "by", s.By, "changeId", s.ID, "phase", phase, "failure", failure)
	return g.putCable(s)
}

// stepCable advances a running cable change (the helper is called without the guard's locks held).
func (g *Guard) stepCable(ctx context.Context) (time.Duration, error) {
	g.wmu.Lock()
	s, err := g.loadCable()
	g.wmu.Unlock()
	if err != nil || s == nil {
		return time.Minute, err
	}
	switch s.Phase {
	case PhaseApplying:
		req := proto.Request{V: proto.Version, Op: proto.OpCableSet, ChangeID: s.ID, Use: s.Use}
		if s.Guarded {
			req.DeadlineSec = s.ConfirmSec
		}
		if _, err := g.Helper.Do(ctx, req); err != nil {
			code := proto.CodeOf(err)
			if code == "" || code == proto.CodeInternal {
				// The answer was lost (the helper died, the socket closed): undo whatever it did.
				s.Phase, s.Failure = PhaseReverting, string(protocol.NetworkChangeFailureFailed)
				return 0, g.putCable(s)
			}
			return 0, g.endCable(s, PhaseFailed, string(protocol.NetworkChangeFailureFailed))
		}
		if !s.Guarded {
			return 0, g.endCable(s, PhaseCommitted, "")
		}
		s.Phase, s.Deadline = PhaseConfirming, g.now().Add(time.Duration(s.ConfirmSec)*time.Second)
		return time.Second, g.putCable(s)
	case PhaseConfirming:
		if g.now().After(s.Deadline) {
			s.Phase, s.Failure = PhaseReverting, string(protocol.NetworkChangeFailureNoInternet)
			return 0, g.putCable(s)
		}
		// The cable again proves itself only once the cable has its address (and with it the default route): until
		// then a check still goes out over Wi-Fi and would keep a cable that may not reach the internet at all.
		if s.Use == proto.CableUseCable && !g.WiredConnected() {
			return time.Second, nil
		}
		cctx, cancel := context.WithTimeout(ctx, 10*time.Second)
		err := g.Check.Check(cctx)
		cancel()
		g.noteOnline(err == nil)
		if err != nil {
			return 5 * time.Second, nil
		}
		if _, err := g.Helper.Do(ctx, proto.Request{V: proto.Version, Op: proto.OpCableConfirm, ChangeID: s.ID}); err != nil {
			if proto.CodeOf(err) == proto.CodeCableNotApplied {
				// A restart put the kept setting back meanwhile, or the dead-man undid it: nothing of it is left.
				return 0, g.endCable(s, PhaseReverted, string(protocol.NetworkChangeFailureFailed))
			}
			return 5 * time.Second, nil
		}
		return 0, g.endCable(s, PhaseCommitted, "")
	case PhaseReverting:
		if _, err := g.Helper.Do(ctx, proto.Request{V: proto.Version, Op: proto.OpCableRevert, ChangeID: s.ID}); err != nil {
			return 5 * time.Second, nil
		}
		return 0, g.endCable(s, PhaseReverted, s.Failure)
	}
	return time.Minute, nil
}

// backupState is what the backup's checks found: since when control hasn't been reached while Wi-Fi only.
type backupState struct {
	offlineSince time.Time
}

func (g *Guard) backupAfter() time.Duration {
	if g.BackupAfter > 0 {
		return g.BackupAfter
	}
	return DefaultBackupAfter
}

func (g *Guard) backupRetry() time.Duration {
	if g.BackupRetryAfter > 0 {
		return g.BackupRetryAfter
	}
	return DefaultBackupRetryAfter
}

// BackupEvery is how often BackupStep wants to run.
func (g *Guard) BackupEvery() time.Duration {
	if g.BackupInterval > 0 {
		return g.BackupInterval
	}
	return DefaultBackupEvery
}

// BackupStep is one check of the cable as the backup: it does nothing unless the box uses Wi-Fi only and no change
// runs. It returns the change it started, if any.
func (g *Guard) BackupStep(ctx context.Context) (*protocol.CableChange, error) {
	g.bmu.Lock()
	defer g.bmu.Unlock()
	g.wmu.Lock()
	busy, err := g.busy()
	g.wmu.Unlock()
	if err != nil || busy {
		// A change decides on its own; the count starts again after it.
		g.backup.offlineSince = time.Time{}
		return nil, err
	}
	off, err := g.WifiOnly(ctx)
	if err != nil || !off {
		g.backup.offlineSince = time.Time{}
		if errors.Is(err, ErrCableUnknown) {
			err = nil
		}
		return nil, err
	}
	cctx, cancel := context.WithTimeout(ctx, onlineCheckTimeout)
	cerr := g.Check.Check(cctx)
	cancel()
	g.noteOnline(cerr == nil)
	now := g.now()
	if cerr == nil {
		g.backup.offlineSince = time.Time{}
		return nil, nil
	}
	if g.backup.offlineSince.IsZero() {
		g.backup.offlineSince = now
		return nil, nil
	}
	if now.Sub(g.backup.offlineSince) < g.backupAfter() || !g.Plugged() {
		return nil, nil
	}
	// The cable didn't reach control either the last time it was tried: the internet itself is probably out, so it
	// is tried again only after a while.
	g.wmu.Lock()
	last, _ := g.loadCable()
	g.wmu.Unlock()
	if last != nil && last.By == CableByBackup && last.Phase == PhaseReverted && now.Sub(last.EndedAt) < g.backupRetry() {
		return nil, nil
	}
	g.log().Warn("network: Wi-Fi hasn't reached control for a while and a cable is plugged in: trying the cable",
		"offlineSince", g.backup.offlineSince.UTC().Format(time.RFC3339))
	// Guarded like a person's change: kept only when the cable reaches control, else switched off again and Wi-Fi only
	// stays (an internet outage isn't the Wi-Fi's fault, and a cable on a network without internet would cut the box off).
	c, err := g.beginCable(&CableState{Use: proto.CableUseCable, By: CableByBackup, Guarded: true,
		ConfirmSec: backupConfirmSec})
	if err != nil {
		return nil, err
	}
	g.backup.offlineSince = time.Time{}
	return &c, nil
}
