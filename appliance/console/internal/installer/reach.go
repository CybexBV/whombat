package installer

import (
	"errors"
	"net"
	"net/url"
	"strings"

	"github.com/CybexBV/whombat/appliance/internal/reach"
)

// ReachChoice is how the owner will reach the box (Whombat LNK-12): Whombat Link, Tailscale or both, with the owner's
// own Tailscale login server (Headscale) when they named one. whombat-install writes it to /persist/whombat/reach.json.
type ReachChoice struct {
	Link        bool   `json:"link"`
	Tailscale   bool   `json:"tailscale"`
	LoginServer string `json:"loginServer,omitempty"`
}

// DefaultLoginServer is Tailscale's own, checked when the owner named none.
const DefaultLoginServer = "https://controlplane.tailscale.com"

// Refusals of a reach choice or an environment (400).
var (
	ErrReach       = errors.New("reach")
	ErrEnvironment = errors.New("environment")
)

// validChoice checks a choice the page sent. A community image has no Whombat Link (NX-445). The box's environment is
// always the image's default, production: the installer has no developer option any more (ONE-02), so a request that
// still names an environment is refused rather than quietly installed for another one.
func (s *Server) validChoice(c *ReachChoice, env string) error {
	if env != "" {
		return ErrEnvironment
	}
	if c == nil {
		return nil
	}
	if !c.Link && !c.Tailscale {
		return ErrReach
	}
	if c.Link && s.image.Edition == "community" {
		return ErrReach
	}
	if c.LoginServer != "" && (!c.Tailscale || !reach.ValidLoginServer(c.LoginServer)) {
		return ErrReach
	}
	return nil
}

// defaultChoice is what the reach checks test for a request that names no choice: Whombat Link, as a commercial box
// was always checked. The page always sends one; older scripted installs (the harness's, the VM tests') don't, and get
// no reach.json (StartInstall). A community image has no Link, so it checks none.
func (s *Server) defaultChoice() *ReachChoice {
	if s.image.Edition == "community" {
		return nil
	}
	return &ReachChoice{Link: true}
}

// reachTargets are the hosts the reach checks try for a choice: the image's control and relay with Link, the login
// server with Tailscale, the image's updates always. A check missing here isn't run.
func (s *Server) reachTargets(c *ReachChoice) map[string]string {
	t := map[string]string{"reach-updates": s.image.Hosts.Updates}
	hosts := s.image.Hosts
	if c != nil && c.Link && s.image.Edition != "community" {
		t["reach-api"], t["reach-relay"] = hosts.API, hosts.Relay
	}
	if c != nil && c.Tailscale {
		t["reach-login"] = loginHost(c.LoginServer)
	}
	return t
}

// loginHost is the host (and port, when it names one) of a login server, Tailscale's own for "".
func loginHost(server string) string {
	if server == "" {
		server = DefaultLoginServer
	}
	u, err := url.Parse(server)
	if err != nil || u.Host == "" {
		return ""
	}
	if u.Port() == "" {
		return plainHost(u.Hostname())
	}
	if plainHost(u.Hostname()) == "" {
		return ""
	}
	return net.JoinHostPort(u.Hostname(), u.Port())
}

// plainHost is h when it is a plain host name with a dot, else "" (its check then warns without a value).
func plainHost(h string) string {
	if hostRe.MatchString(h) && strings.Contains(h, ".") {
		return h
	}
	return ""
}
