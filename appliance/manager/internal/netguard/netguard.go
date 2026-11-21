// Package netguard applies network configuration candidates with a timed connectivity check and
// automatic rollback (MG-15). The helper arms a root-owned dead-man revert before applying, so the
// network also reverts when the manager dies mid-change; the manager's own state is crash-safe and
// reverts on restart when the confirmation deadline passed.
package netguard

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/CybexBV/whombat/appliance/helper/pkg/atomicfile"
	"github.com/CybexBV/whombat/appliance/helper/pkg/netconfig"
	"github.com/CybexBV/whombat/appliance/helper/pkg/proto"
)

// Phases of a network change.
const (
	PhaseApplying   = "applying"
	PhaseConfirming = "confirming"
	PhaseCommitted  = "committed"
	PhaseReverting  = "reverting"
	PhaseReverted   = "reverted"
)

// State is persisted in <StateDir>/network.json.
type State struct {
	CandidateID string    `json:"candidateId,omitempty"`
	Phase       string    `json:"phase,omitempty"`
	Deadline    time.Time `json:"deadline,omitempty"`
	Result      string    `json:"result,omitempty"`
	UpdatedAt   time.Time `json:"updatedAt"`
}

// Helper runs helper ops.
type Helper interface {
	Do(ctx context.Context, req proto.Request) (*proto.Result, error)
}

// Checker verifies connectivity after a change.
type Checker interface {
	Check(ctx context.Context) error
}

// Locker serializes network changes with updates (the manager's maintenance lock).
type Locker interface {
	AcquireLock(holder, reason string, ttl time.Duration) error
	ReleaseLock(holder string) error
}

// Guard manages network changes (wired candidates, MG-15; Wi-Fi joins and forgets, MG-100…; the cable, cable.go) and
// answers the network state (MG-101).
type Guard struct {
	CandidatesDir string
	StateDir      string
	Helper        Helper
	Check         Checker
	Lock          Locker
	Now           func() time.Time
	// Sys is the sysfs root ("" is /sys): the wired interfaces, rfkill and Wi-Fi cards without a driver.
	Sys string
	// Addr returns an interface's address ("" none); nil is InterfaceAddress. Prefix returns the prefix length of that
	// address (0: unknown); nil is the interface's own when Addr is nil too.
	Addr   func(iface string) string
	Prefix func(iface string) int
	// Log records the cable's changes (nil: none).
	Log *slog.Logger
	// BackupInterval and BackupAfter: how often the cable as the backup checks control while Wi-Fi only, and how long
	// control must have been out of reach before the cable is tried, and how long after a try that didn't reach control
	// either the next one waits (0: DefaultBackupEvery, DefaultBackupAfter, DefaultBackupRetryAfter).
	BackupInterval   time.Duration
	BackupAfter      time.Duration
	BackupRetryAfter time.Duration
	mu               sync.Mutex

	// wmu guards wifi.json and the passphrase of the change being applied (in memory only).
	wmu      sync.Mutex
	secretID string
	secret   string
	wake     chan struct{}
	wakeOnce sync.Once
	// online is the last control check (HD-10), scan the last scan (MG-101).
	onlineMu sync.Mutex
	online   onlineState
	scanMu   sync.Mutex
	scan     []proto.WifiNetwork
	// bmu guards backup (the backup's count of failed checks).
	bmu    sync.Mutex
	backup backupState
}

// ErrBusy means another change is in progress.
var ErrBusy = errors.New("a network change is already in progress")

func (g *Guard) now() time.Time {
	if g.Now != nil {
		return g.Now()
	}
	return time.Now()
}

func (g *Guard) statePath() string { return filepath.Join(g.StateDir, "network.json") }

// Load returns the persisted state.
func (g *Guard) Load() (*State, error) {
	b, err := os.ReadFile(g.statePath())
	if os.IsNotExist(err) {
		return &State{}, nil
	}
	if err != nil {
		return nil, err
	}
	var s State
	return &s, json.Unmarshal(b, &s)
}

func (g *Guard) save(s *State) error {
	s.UpdatedAt = g.now()
	b, _ := json.Marshal(s)
	if err := os.MkdirAll(g.StateDir, 0o700); err != nil {
		return err
	}
	return atomicfile.WriteFile(g.statePath(), b, 0o600)
}

// Submit validates and records a candidate; Step applies it.
func (g *Guard) Submit(c *netconfig.Candidate) error {
	if err := c.Validate(); err != nil {
		return err
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	st, err := g.Load()
	if err != nil {
		return err
	}
	if running(st.Phase) {
		return ErrBusy
	}
	if wst, err := g.loadWifi(); err != nil || (wst != nil && running(wst.Phase)) {
		return ErrBusy
	}
	if cst, err := g.loadCable(); err != nil || (cst != nil && running(cst.Phase)) {
		return ErrBusy
	}
	if err := g.Lock.AcquireLock("network", "network change "+c.ID, time.Duration(c.ConfirmTimeoutSec+120)*time.Second); err != nil {
		return err
	}
	b, _ := json.Marshal(c)
	if err := os.MkdirAll(g.CandidatesDir, 0o755); err != nil {
		return err
	}
	if err := atomicfile.WriteFile(filepath.Join(g.CandidatesDir, c.ID+".json"), b, 0o644); err != nil {
		return err
	}
	return g.save(&State{CandidateID: c.ID, Phase: PhaseApplying})
}

func (g *Guard) candidate(id string) (*netconfig.Candidate, error) {
	b, err := os.ReadFile(filepath.Join(g.CandidatesDir, id+".json"))
	if err != nil {
		return nil, err
	}
	return netconfig.Parse(b)
}

// Step advances a pending wired, Wi-Fi or cable change; it returns when the next step is useful.
func (g *Guard) Step(ctx context.Context) (time.Duration, error) {
	wired, werr := g.stepWired(ctx)
	wifi, ferr := g.stepWifi(ctx)
	cable, cerr := g.stepCable(ctx)
	return min(wired, wifi, cable), errors.Join(werr, ferr, cerr)
}

func (g *Guard) stepWired(ctx context.Context) (time.Duration, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	st, err := g.Load()
	if err != nil {
		return time.Minute, err
	}
	switch st.Phase {
	case PhaseApplying:
		c, err := g.candidate(st.CandidateID)
		if err != nil {
			st.Phase, st.Result = PhaseReverted, "candidate unreadable: "+err.Error()
			_ = g.Lock.ReleaseLock("network")
			return 0, g.save(st)
		}
		// Record the deadline before applying: a crash after apply still reverts in time.
		st.Deadline = g.now().Add(time.Duration(c.ConfirmTimeoutSec) * time.Second)
		if _, err := g.Helper.Do(ctx, proto.Request{V: proto.Version, Op: proto.OpApplyNetwork, CandidateID: c.ID}); err != nil {
			if proto.CodeOf(err) == "" {
				return 5 * time.Second, nil
			}
			st.Phase, st.Result = PhaseReverted, "apply refused: "+err.Error()
			_ = g.Lock.ReleaseLock("network")
			return 0, g.save(st)
		}
		st.Phase = PhaseConfirming
		return time.Second, g.save(st)
	case PhaseConfirming:
		if g.now().After(st.Deadline) {
			st.Phase, st.Result = PhaseReverting, "no connectivity before the confirmation deadline"
			return 0, g.save(st)
		}
		cctx, cancel := context.WithTimeout(ctx, 10*time.Second)
		err := g.Check.Check(cctx)
		cancel()
		g.noteOnline(err == nil)
		if err != nil {
			return 5 * time.Second, nil
		}
		if _, err := g.Helper.Do(ctx, proto.Request{V: proto.Version, Op: proto.OpConfirmNetwork, CandidateID: st.CandidateID}); err != nil {
			return 5 * time.Second, nil
		}
		st.Phase, st.Result = PhaseCommitted, "connectivity confirmed"
		_ = g.Lock.ReleaseLock("network")
		return 0, g.save(st)
	case PhaseReverting:
		if _, err := g.Helper.Do(ctx, proto.Request{V: proto.Version, Op: proto.OpRevertNetwork}); err != nil {
			return 5 * time.Second, nil
		}
		st.Phase = PhaseReverted
		_ = g.Lock.ReleaseLock("network")
		return 0, g.save(st)
	}
	return time.Minute, nil
}

// DialChecker confirms connectivity by resolving and connecting to the control endpoint (TCP) —
// what the appliance needs to stay manageable. No payload is sent.
// ControlURL is control's base URL, or on a community box (no control, MG-136) its TUF metadata URL.
type DialChecker struct{ ControlURL string }

// Check implements Checker.
func (d DialChecker) Check(ctx context.Context) error {
	u, err := url.Parse(d.ControlURL)
	if err != nil || u.Host == "" {
		return fmt.Errorf("bad control URL %q", d.ControlURL)
	}
	host := u.Host
	if u.Port() == "" {
		port := "443"
		if u.Scheme == "http" {
			port = "80" // a community box's own update repository may be plain HTTP (MG-136)
		}
		host = net.JoinHostPort(u.Hostname(), port)
	}
	var dl net.Dialer
	c, err := dl.DialContext(ctx, "tcp", host)
	if err != nil {
		return err
	}
	return c.Close()
}
