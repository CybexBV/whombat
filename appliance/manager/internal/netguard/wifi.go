package netguard

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"time"

	"github.com/CybexBV/whombat/appliance/helper/pkg/atomicfile"
	"github.com/CybexBV/whombat/appliance/helper/pkg/proto"
	"github.com/CybexBV/whombat/contracts/go/protocol"
)

// Wi-Fi changes (MG-100…MG-104; Whombat HD-06): a join or a forget runs through the helper with the guard's pattern.
// It takes the maintenance lock (no update activates meanwhile), runs `applying` (the helper's wifi-join or
// wifi-forget, with the dead-man armed when the change is guarded), then `confirming` until the manager reaches control
// or the deadline passes (`reverting` → `reverted`, failure no_internet). A change is guarded only when the box was
// online before (HD-10): one that can't reach Whombat anyway has nothing to lose. A join the helper couldn't make
// (a wrong password, a network out of range, no address) is `failed` at once, and the helper kept nothing. One change
// at a time, wired, Wi-Fi or the cable.

// WifiState is a Wi-Fi change, persisted in <StateDir>/wifi.json. It never holds the passphrase.
type WifiState struct {
	ID       string                     `json:"id"`
	Kind     protocol.NetworkChangeKind `json:"kind"`
	SSID     string                     `json:"ssid"`
	Hidden   bool                       `json:"hidden,omitempty"`
	Phase    string                     `json:"phase"`
	Deadline time.Time                  `json:"deadline"`
	Previous string                     `json:"previous,omitempty"`
	Failure  string                     `json:"failure,omitempty"`
	// Guarded: the box was online before, so the change is confirmed by reaching control (else kept once made).
	Guarded    bool `json:"guarded"`
	ConfirmSec int  `json:"confirmSec"`
	// HasPassphrase: the join needs the passphrase it came with (in memory only); after a manager restart it is gone,
	// and the change is undone.
	HasPassphrase bool      `json:"hasPassphrase,omitempty"`
	EndedAt       time.Time `json:"endedAt,omitzero"`
	UpdatedAt     time.Time `json:"updatedAt"`
}

// PhaseFailed: a change the helper couldn't make (it kept nothing).
const PhaseFailed = "failed"

// ShownAfterEnd is how long a finished change stays in the network state (the app shows how it ended).
const ShownAfterEnd = 5 * time.Minute

// joinBudget is the helper's time for a join (connecting 45 s, the address 30 s) and a margin.
const joinBudget = 90 * time.Second

// Errors of Join and Forget (the local contract's codes, MG-102).
var (
	ErrNoWifi            = errors.New("this Whombat has no Wi-Fi it can use")
	ErrInUse             = errors.New("this Whombat reaches the internet only through that network")
	ErrNotSaved          = errors.New("that network is not saved")
	ErrInvalidPassphrase = errors.New("that network needs a password")
)

// WifiJoin is a join the runtime asked for. Passphrase is a secret: never persisted or logged.
type WifiJoin struct {
	SSID       string
	Passphrase string
	Hidden     bool
	ConfirmSec int
}

func (g *Guard) wifiPath() string { return filepath.Join(g.StateDir, "wifi.json") }

func (g *Guard) loadWifi() (*WifiState, error) {
	b, err := os.ReadFile(g.wifiPath())
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var s WifiState
	if err := json.Unmarshal(b, &s); err != nil {
		return nil, err
	}
	return &s, nil
}

func (g *Guard) saveWifi(s *WifiState) error {
	s.UpdatedAt = g.now()
	if s.Phase == PhaseCommitted || s.Phase == PhaseReverted || s.Phase == PhaseFailed {
		if s.EndedAt.IsZero() {
			s.EndedAt = s.UpdatedAt
		}
	}
	b, _ := json.Marshal(s)
	if err := os.MkdirAll(g.StateDir, 0o700); err != nil {
		return err
	}
	return atomicfile.WriteFile(g.wifiPath(), b, 0o600)
}

func running(phase string) bool {
	return phase == PhaseApplying || phase == PhaseConfirming || phase == PhaseReverting
}

func (g *Guard) wakeCh() chan struct{} {
	g.wakeOnce.Do(func() { g.wake = make(chan struct{}, 1) })
	return g.wake
}

// Woken signals that a change was submitted (the network loop steps at once).
func (g *Guard) Woken() <-chan struct{} { return g.wakeCh() }

func (g *Guard) nudge() {
	select {
	case g.wakeCh() <- struct{}{}:
	default: // a wake is pending already
	}
}

func newChangeID() string {
	const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789"
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	for i := range b {
		b[i] = alphabet[int(b[i])%len(alphabet)]
	}
	return "c-" + string(b)
}

// WifiChange is the Wi-Fi change to show: a running one, or one that ended less than ShownAfterEnd ago; nil else.
func (g *Guard) WifiChange() *protocol.NetworkChange {
	g.wmu.Lock()
	st, err := g.loadWifi()
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

// change is the state as the contract's NetworkChange.
func (s *WifiState) change() protocol.NetworkChange {
	c := protocol.NetworkChange{ID: s.ID, Kind: s.Kind, Ssid: s.SSID, Phase: protocol.NetworkChangePhase(s.Phase),
		Deadline: s.Deadline.UTC().Format(time.RFC3339)}
	if s.Previous != "" {
		p := s.Previous
		c.Previous = &p
	}
	if s.Phase == PhaseReverting || s.Phase == PhaseReverted || s.Phase == PhaseFailed {
		f := protocol.NetworkChangeFailure(s.Failure)
		if f == "" {
			f = protocol.NetworkChangeFailureFailed
		}
		c.Failure = &f
	}
	return c
}

// busy reports whether any network change (wired, Wi-Fi or the cable) is running.
func (g *Guard) busy() (bool, error) {
	if wst, err := g.loadWifi(); err != nil {
		return true, err
	} else if wst != nil && running(wst.Phase) {
		return true, nil
	}
	if cst, err := g.loadCable(); err != nil {
		return true, err
	} else if cst != nil && running(cst.Phase) {
		return true, nil
	}
	g.mu.Lock()
	st, err := g.Load()
	g.mu.Unlock()
	if err != nil {
		return true, err
	}
	return running(st.Phase), nil
}

// begin records a new change after the checks of Join and Forget.
func (g *Guard) begin(s *WifiState, passphrase string) (protocol.NetworkChange, error) {
	g.wmu.Lock()
	defer g.wmu.Unlock()
	if b, err := g.busy(); err != nil || b {
		if err != nil {
			return protocol.NetworkChange{}, err
		}
		return protocol.NetworkChange{}, ErrBusy
	}
	ttl := joinBudget + time.Duration(s.ConfirmSec)*time.Second + 2*time.Minute
	if err := g.Lock.AcquireLock("network", "Wi-Fi "+string(s.Kind)+" "+s.ID, ttl); err != nil {
		return protocol.NetworkChange{}, ErrBusy
	}
	s.ID, s.Phase = newChangeID(), PhaseApplying
	// The deadline the change is expected to have; it is set again once the change is made.
	s.Deadline = g.now().Add(joinBudget + time.Duration(s.ConfirmSec)*time.Second)
	if err := g.saveWifi(s); err != nil {
		_ = g.Lock.ReleaseLock("network")
		return protocol.NetworkChange{}, err
	}
	g.secretID, g.secret = s.ID, passphrase
	g.nudge()
	return s.change(), nil
}

// wifiNow asks the helper for the Wi-Fi state (no_wifi: none to change).
func (g *Guard) wifiNow(ctx context.Context) (*proto.WifiStatus, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	res, err := g.Helper.Do(ctx, proto.Request{V: proto.Version, Op: proto.OpWifiStatus})
	if err != nil {
		if proto.CodeOf(err) == proto.CodeNoWifi || proto.CodeOf(err) == proto.CodeBadRequest {
			return nil, ErrNoWifi // bad_request: a helper from before Wi-Fi
		}
		return nil, err
	}
	if res.Wifi == nil || res.Wifi.Status == nil || res.Wifi.Status.Interface == "" {
		return nil, ErrNoWifi
	}
	return res.Wifi.Status, nil
}

// refuseBusy answers busy at once, before the checks a change makes (they take seconds; begin asks again).
func (g *Guard) refuseBusy() error {
	g.wmu.Lock()
	defer g.wmu.Unlock()
	if b, err := g.busy(); err != nil {
		return err
	} else if b {
		return ErrBusy
	}
	return nil
}

// Join starts a join (202 with its change; the network loop makes it).
func (g *Guard) Join(ctx context.Context, j WifiJoin) (protocol.NetworkChange, error) {
	if err := g.refuseBusy(); err != nil {
		return protocol.NetworkChange{}, err
	}
	ws, err := g.wifiNow(ctx)
	if err != nil {
		return protocol.NetworkChange{}, err
	}
	saved := false
	for _, s := range ws.Saved {
		saved = saved || s.SSID == j.SSID
	}
	// A secured network that isn't saved needs its password (from the last scan; a hidden one shows in none).
	if j.Passphrase == "" && !saved && !j.Hidden {
		for _, n := range g.scanned() {
			if n.SSID == j.SSID && n.Security == "psk" {
				return protocol.NetworkChange{}, ErrInvalidPassphrase
			}
		}
	}
	online := g.CheckOnline(ctx, 5*time.Second)
	s := &WifiState{Kind: protocol.NetworkChangeKindJoin, SSID: j.SSID, Hidden: j.Hidden, Guarded: online,
		ConfirmSec: j.ConfirmSec, HasPassphrase: j.Passphrase != ""}
	if c := ws.Connected; c != nil && ws.State != "disconnected" {
		s.Previous = c.SSID
	}
	return g.begin(s, j.Passphrase)
}

// Forget starts forgetting a saved network. Forgetting the network the box is on is refused while no cable works
// (in_use, HD-06).
func (g *Guard) Forget(ctx context.Context, ssid string, confirmSec int, wiredConnected bool) (protocol.NetworkChange, error) {
	if err := g.refuseBusy(); err != nil {
		return protocol.NetworkChange{}, err
	}
	ws, err := g.wifiNow(ctx)
	if err != nil {
		return protocol.NetworkChange{}, err
	}
	saved := false
	for _, s := range ws.Saved {
		saved = saved || s.SSID == ssid
	}
	if !saved {
		return protocol.NetworkChange{}, ErrNotSaved
	}
	onIt := ws.Connected != nil && ws.Connected.SSID == ssid && ws.State != "disconnected"
	if onIt && !wiredConnected {
		return protocol.NetworkChange{}, ErrInUse
	}
	online := g.CheckOnline(ctx, 5*time.Second)
	s := &WifiState{Kind: protocol.NetworkChangeKindForget, SSID: ssid, Guarded: online, ConfirmSec: confirmSec}
	if ws.Connected != nil && ws.State != "disconnected" {
		s.Previous = ws.Connected.SSID
	}
	return g.begin(s, "")
}

// failureOf maps the helper's failure code to the contract's NetworkChangeFailure.
func failureOf(code string) string {
	switch code {
	case proto.CodeWrongPassword, proto.CodeInvalidPassphrase:
		return string(protocol.NetworkChangeFailureWrongPassword)
	case proto.CodeNetworkNotFound:
		return string(protocol.NetworkChangeFailureNotFound)
	case proto.CodeNoAddress:
		return string(protocol.NetworkChangeFailureNoAddress)
	}
	return string(protocol.NetworkChangeFailureFailed)
}

func (g *Guard) endWifi(s *WifiState, phase, failure string) error {
	s.Phase, s.Failure = phase, failure
	_ = g.Lock.ReleaseLock("network")
	if phase != PhaseFailed {
		// On another network now (or back on the old one): the last check was made on the one before.
		g.staleOnline()
	}
	g.wmu.Lock()
	defer g.wmu.Unlock()
	return g.saveWifi(s)
}

func (g *Guard) putWifi(s *WifiState) error {
	g.wmu.Lock()
	defer g.wmu.Unlock()
	return g.saveWifi(s)
}

// stepWifi advances a running Wi-Fi change. The helper is called without the guard's locks held: a join takes up to
// joinBudget, and the network state is read meanwhile.
func (g *Guard) stepWifi(ctx context.Context) (time.Duration, error) {
	g.wmu.Lock()
	s, err := g.loadWifi()
	g.wmu.Unlock()
	if err != nil || s == nil {
		return time.Minute, err
	}
	switch s.Phase {
	case PhaseApplying:
		return g.applyWifi(ctx, s)
	case PhaseConfirming:
		if g.now().After(s.Deadline) {
			s.Phase, s.Failure = PhaseReverting, string(protocol.NetworkChangeFailureNoInternet)
			return 0, g.putWifi(s)
		}
		cctx, cancel := context.WithTimeout(ctx, 10*time.Second)
		err := g.Check.Check(cctx)
		cancel()
		g.noteOnline(err == nil)
		if err != nil {
			return 5 * time.Second, nil
		}
		if _, err := g.Helper.Do(ctx, proto.Request{V: proto.Version, Op: proto.OpWifiConfirm, ChangeID: s.ID}); err != nil {
			return 5 * time.Second, nil
		}
		return 0, g.endWifi(s, PhaseCommitted, "")
	case PhaseReverting:
		if _, err := g.Helper.Do(ctx, proto.Request{V: proto.Version, Op: proto.OpWifiRevert, ChangeID: s.ID}); err != nil {
			return 5 * time.Second, nil
		}
		return 0, g.endWifi(s, PhaseReverted, s.Failure)
	}
	return time.Minute, nil
}

func (g *Guard) applyWifi(ctx context.Context, s *WifiState) (time.Duration, error) {
	g.wmu.Lock()
	pass, have := g.secret, g.secretID == s.ID
	g.secretID, g.secret = "", ""
	g.wmu.Unlock()
	if s.HasPassphrase && !have {
		// The manager restarted while the join waited: its passphrase is gone. Undo whatever the helper did.
		s.Phase, s.Failure = PhaseReverting, string(protocol.NetworkChangeFailureFailed)
		return 0, g.putWifi(s)
	}
	req := proto.Request{V: proto.Version, ChangeID: s.ID, SSID: s.SSID}
	if s.Guarded {
		req.DeadlineSec = s.ConfirmSec
	}
	if s.Kind == protocol.NetworkChangeKindJoin {
		req.Op, req.Passphrase, req.Hidden = proto.OpWifiJoin, pass, s.Hidden
	} else {
		req.Op = proto.OpWifiForget
	}
	_, err := g.Helper.Do(ctx, req)
	if err != nil {
		code := proto.CodeOf(err)
		if code == "" || code == proto.CodeInternal {
			// The answer was lost (the helper died, the socket closed): undo whatever it did.
			s.Phase, s.Failure = PhaseReverting, string(protocol.NetworkChangeFailureFailed)
			return 0, g.putWifi(s)
		}
		return 0, g.endWifi(s, PhaseFailed, failureOf(code))
	}
	if !s.Guarded {
		return 0, g.endWifi(s, PhaseCommitted, "")
	}
	s.Phase, s.Deadline = PhaseConfirming, g.now().Add(time.Duration(s.ConfirmSec)*time.Second)
	return time.Second, g.putWifi(s)
}
