// Package health evaluates local installation health (MG-13): runtime process state (systemd),
// runtime /health (DB reachable, migrations compatible, session endpoint listening), the expected
// runtime version, and an independent connect check of the session endpoint. Relay, control and
// provider availability are recorded as informational only and never make an installation
// unhealthy; no check ever performs a paid model call.
package health

import (
	"context"
	"fmt"
	"net"
	"os/exec"
	"strings"
	"time"

	"github.com/CybexBV/whombat/appliance/manager/internal/runtimeapi"
	"github.com/CybexBV/whombat/contracts/go/local"
)

// Evidence is one health observation (persisted in the journal, bounded).
type Evidence struct {
	At               time.Time         `json:"at"`
	OK               bool              `json:"ok"`
	ProcessActive    bool              `json:"processActive"`
	RuntimeReachable bool              `json:"runtimeReachable"`
	RuntimeStatus    string            `json:"runtimeStatus,omitempty"`
	RuntimeVersion   string            `json:"runtimeVersion,omitempty"`
	VersionMatches   bool              `json:"versionMatches"`
	DB               bool              `json:"db"`
	Migrations       bool              `json:"migrations"`
	SchemaVersion    int               `json:"schemaVersion,omitempty"`
	Access           string            `json:"access,omitempty"`
	Draining         bool              `json:"draining,omitempty"`
	SchemaKnown      bool              `json:"schemaKnown"`
	SessionListening bool              `json:"sessionListening"`
	Failures         []string          `json:"failures,omitempty"`
	External         map[string]string `json:"external,omitempty"`
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// UnitState reports whether the runtime units are active.
type UnitState interface {
	Active(ctx context.Context) (bool, string)
}

// RuntimeHealth is the runtime /health source.
type RuntimeHealth interface {
	Health(ctx context.Context) (*runtimeapi.Health, error)
}

// Checker evaluates health.
type Checker struct {
	Units   UnitState
	Runtime RuntimeHealth
	// SessionAddr is "unix:/path" or "tcp:127.0.0.1:port"; empty skips the independent check.
	SessionAddr string
	Now         func() time.Time
}

// Check evaluates health; expectVersion (if non-empty) must match the runtime's reported version.
func (c *Checker) Check(ctx context.Context, expectVersion string) Evidence {
	now := time.Now
	if c.Now != nil {
		now = c.Now
	}
	ev := Evidence{At: now().UTC()}
	fail := func(f string, a ...any) { ev.Failures = append(ev.Failures, fmt.Sprintf(f, a...)) }
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if c.Units != nil {
		active, detail := c.Units.Active(ctx)
		ev.ProcessActive = active
		if !active {
			fail("runtime units not active: %s", detail)
		}
	} else {
		ev.ProcessActive = true
	}
	h, err := c.Runtime.Health(ctx)
	if err != nil {
		fail("runtime health unreachable: %v", err)
	} else {
		ev.RuntimeReachable = true
		ev.RuntimeStatus = h.Status
		ev.RuntimeVersion = h.Version
		ev.DB = h.Checks.Db.Ok
		m := h.Checks.Migrations
		ev.Access = m.Access
		ev.Migrations = m.Compatible && m.Access != "none" && m.Access != ""
		ev.SchemaVersion = int(m.SchemaVersion)
		ev.SchemaKnown = m.SchemaVersion > 0
		ev.SessionListening = h.Checks.SessionEndpoint.Ok
		ev.Draining = h.Draining
		if x := h.External; x != nil {
			ev.External = map[string]string{}
			for k, v := range map[string]*local.ExternalState{"relay": x.Relay, "control": x.Control, "providers": x.Providers} {
				if v != nil {
					ev.External[k] = string(*v)
				}
			}
		}
		if h.Status != "ok" {
			fail("runtime status %q", h.Status)
		}
		if !ev.DB {
			fail("database unreachable: %s", deref(h.Checks.Db.Detail))
		}
		if !ev.Migrations {
			fail("schema %d not usable (%s): %s", ev.SchemaVersion, m.Access, deref(m.Detail))
		}
		if !ev.SessionListening {
			fail("session endpoint: %s", deref(h.Checks.SessionEndpoint.Detail))
		}
	}
	ev.VersionMatches = expectVersion == "" || ev.RuntimeVersion == expectVersion
	if !ev.VersionMatches {
		fail("runtime reports version %q, expected %q", ev.RuntimeVersion, expectVersion)
	}
	if c.SessionAddr != "" {
		if err := dialCheck(ctx, c.SessionAddr); err != nil {
			ev.SessionListening = false
			fail("session endpoint not accepting connections: %v", err)
		}
	}
	ev.OK = len(ev.Failures) == 0
	return ev
}

func dialCheck(ctx context.Context, addr string) error {
	network, a, ok := strings.Cut(addr, ":")
	if !ok || (network != "unix" && network != "tcp") {
		return fmt.Errorf("bad session address %q", addr)
	}
	var d net.Dialer
	conn, err := d.DialContext(ctx, network, a)
	if err != nil {
		return err
	}
	return conn.Close()
}

// SystemdUnits checks units with `systemctl show` (read-only, works unprivileged).
type SystemdUnits struct {
	Systemctl string
	Units     []string
}

// Active implements UnitState.
func (s SystemdUnits) Active(ctx context.Context) (bool, string) {
	for _, u := range s.Units {
		out, err := exec.CommandContext(ctx, s.Systemctl, "show", "--property=ActiveState", "--value", "--", u).Output()
		if err != nil {
			return false, fmt.Sprintf("%s: %v", u, err)
		}
		if st := strings.TrimSpace(string(out)); st != "active" {
			return false, fmt.Sprintf("%s is %s", u, st)
		}
	}
	return true, ""
}
