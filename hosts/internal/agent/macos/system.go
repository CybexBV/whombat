package macos

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"sync/atomic"
	"time"

	"rackoon/internal/proto"
)

// PackageManager is SystemInfo.PackageManager on a Mac.
const PackageManager = "softwareupdate"

// runUpdates reads what macOS's own check found and whether an installed
// update waits for a restart.
func (c *Collector) runUpdates(ctx context.Context) error {
	p, err := ReadPending(ctx)
	sys := proto.SystemInfo{PackageManager: PackageManager}
	if err != nil {
		sys.UpdatesError = clip(err.Error(), 300)
	} else {
		n, sec := len(p.Updates), p.Security
		sys.UpdatesPending, sys.SecurityUpdates = &n, &sec
		sys.UpdatesCheckedAt = p.CheckedAt
	}
	c.mu.Lock()
	boot := c.host.BootTime
	c.mu.Unlock()
	if rn, ok := ReadRestartNeeded(c.cfg.StateDir); ok && (boot.IsZero() || rn.At.After(boot)) {
		sys.RebootRequired = true
		sys.RebootReason = "macOS updates were installed and wait for a restart"
	}
	c.mu.Lock()
	c.sys = sys
	c.mu.Unlock()
	return err
}

// RestartNeeded is <state dir>/packages/restart-needed.json: the agent's
// package task installed an update that finishes at the next restart.
type RestartNeeded struct {
	At time.Time `json:"at"`
}

// RestartNeededFile is the file's name in the packages directory.
const RestartNeededFile = "restart-needed.json"

// WriteRestartNeeded records a restart need (packagesDir: <state
// dir>/packages).
func WriteRestartNeeded(packagesDir string, at time.Time) error {
	b, _ := json.Marshal(RestartNeeded{At: at.UTC()})
	tmp := filepath.Join(packagesDir, RestartNeededFile+".tmp")
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, filepath.Join(packagesDir, RestartNeededFile))
}

// ReadRestartNeeded reads it (ok false: none).
func ReadRestartNeeded(stateDir string) (RestartNeeded, bool) {
	var rn RestartNeeded
	b, err := os.ReadFile(filepath.Join(stateDir, "packages", RestartNeededFile))
	if err != nil || json.Unmarshal(b, &rn) != nil || rn.At.IsZero() {
		return RestartNeeded{}, false
	}
	return rn, true
}

// ---- the screen ------------------------------------------------------------------------

// ScreenStatusFunc fills the parts of Report.MacOS that the screen package
// knows: Screen (Screen Sharing, the account and its last sign-in, the
// lock and the framebuffer size) and Helper (running, Accessibility, whose
// session). It is cached on its side and returns quickly.
type ScreenStatusFunc func(ctx context.Context) (proto.MacScreen, proto.MacHelper)

var screenStatus atomic.Pointer[ScreenStatusFunc]

// SetScreenStatus installs the screen package's status (cmd/whombat-agent
// wires it on a Mac). Without it the collector reports Screen Sharing from
// its own check and the helper as installed or not.
func SetScreenStatus(f ScreenStatusFunc) {
	if f == nil {
		screenStatus.Store(nil)
		return
	}
	screenStatus.Store(&f)
}

func screenHook() ScreenStatusFunc {
	if p := screenStatus.Load(); p != nil {
		return *p
	}
	return nil
}

// fillScreen merges the screen package's view into the report's Mac facts:
// its Screen as it is; of the helper, what only it knows (running,
// Accessibility, user), while installed and version stay the collector's.
func fillScreen(ctx context.Context, m *proto.MacOS) {
	f := screenHook()
	if f == nil {
		return
	}
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	s, h := f(ctx)
	s.Account = clip(s.Account, 64)
	if s.SignIn != "ok" && s.SignIn != "failed" {
		s.SignIn = ""
	}
	m.Screen = s
	m.Helper.Running, m.Helper.Accessibility, m.Helper.User = h.Running, h.Accessibility, clip(h.User, 64)
	if !m.Helper.Installed && h.Installed {
		m.Helper.Installed, m.Helper.Version = true, clip(h.Version, 64)
	}
}
