// Package hub is the Rackoon hub: agent listener (mTLS WebSocket + yamux),
// ingest, metrics, alerts, the REST API and SSE, auth, the console gateway,
// and the static UI.
package hub

import (
	"errors"
	"fmt"
	"io/fs"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"rackoon/internal/netaddrs"
)

// Version is the hub version (set by the build).
var Version = "0.1.0-dev"

// Config is the hub configuration (flags / environment of `whombat-hosts serve`).
type Config struct {
	DataDir string // --data
	// Listen is the UI and API listen address (--listen): host:port, or
	// "unix:/path" for a Unix socket (mode SocketMode).
	Listen      string
	AgentListen string // --agent-listen (agents, always TLS)
	// SocketMode is the file mode of the Unix socket (--socket-mode,
	// default 0660).
	SocketMode os.FileMode
	// Headless serves only the data routes for the Whombat server
	// (docs/WHOMBAT.md): no web UI, no own users, sign-in, passkeys, single
	// sign-on, kiosk links or API tokens, and no assistant. Requests
	// authenticate with the service token.
	Headless bool
	// ServiceTokenFile holds the Whombat server's service token
	// (--service-token-file); the hub creates it (0640) when missing and
	// keeps only its hash. Empty: no service token.
	ServiceTokenFile string
	// PublicURL is the UI origin as browsers see it ("http://10.100.0.6:8080",
	// "https://hub.example.ts.net"). Used for the Origin check, cookies,
	// WebAuthn and the install command. Empty: derived from each request.
	PublicURL string
	// AgentURL is the agents' hub URL ("wss://10.100.0.6:8443"), baked into
	// install.sh. Empty: derived from the request host and AgentListen port.
	// "auto" (AgentURLAuto): wss://<LAN address of the default route's
	// interface>:<agent port>, looked up when it is used.
	AgentURL     string
	AgentURLAuto bool
	TLSCert      string // UI HTTPS (optional)
	TLSKey       string
	WebDir       string // serve the UI from this directory instead of the embedded build
	// WebFS is the embedded UI (nil when built without -tags embedweb).
	WebFS     fs.FS
	AgentDist string // directory with whombat-agent-{linux,darwin}-{amd64,arm64} and whombat-helper-macos.{zip,json}
	// AssistSocket is the assistant runner's Unix socket
	// (rackoon-assist.socket); empty: the hub runs it as a child process
	// with its state in DataDir/assist (docs/ASSIST.md).
	AssistSocket string
	// AllowedOrigins are extra browser origins accepted besides PublicURL.
	AllowedOrigins []string
	// TrustedProxies are the peers whose X-Forwarded-For / -Proto headers
	// are believed (CIDRs; default loopback only, e.g. `tailscale serve`).
	TrustedProxies []*net.IPNet
	// InsecureConsoles allows consoles over plain HTTP (they carry
	// keystrokes and screens; off by default except on localhost).
	InsecureConsoles bool
	// AgentProxyProtocol accepts a PROXY protocol header (v1 or v2) on agent
	// connections from loopback peers, so agents behind a local TCP proxy
	// (an Incus proxy device) are seen with their real address. Default on.
	AgentProxyProtocol *bool
	// OIDC is single sign-on with an OpenID Connect provider (off when
	// OIDC.Issuer is empty).
	OIDC OIDCConfig

	// Tunables (defaults in Defaults).
	HeartbeatTimeout    time.Duration
	SessionLifetime     time.Duration // sliding: inactivity ends the session
	SessionMaxLifetime  time.Duration // absolute: sign in again after this
	ReauthWindow        time.Duration // sensitive actions need a sign-in this recent
	ConsoleTokenTTL     time.Duration
	ConsoleIdleTimeout  time.Duration
	ConsoleMaxAge       time.Duration
	ConsolePerUser      int
	ConsolePerServer    int
	ConsolePerAgent     int
	EnrollmentTTL       time.Duration
	StartupAlertGrace   time.Duration
	ReauthorizeInterval time.Duration
	// TaskPollInterval: how often the hub asks an agent about a platform
	// task it started (five times as long while the agent is offline).
	TaskPollInterval time.Duration
	// Agent updates (HS-140…): the first automatic round this long after
	// the start (agents reconnect after a reboot), then every
	// AgentUpdateInterval, and AgentUpdateKick after an older agent
	// connected; the loop looks every AgentUpdateTick. An updated agent
	// must be back within AgentUpdateWait (the agent rolls back after 5
	// minutes), after the last install within AgentInstallWait; the hub
	// looks every AgentUpdatePoll.
	AgentUpdateGrace    time.Duration
	AgentUpdateInterval time.Duration
	AgentUpdateKick     time.Duration
	AgentUpdateTick     time.Duration
	AgentUpdateWait     time.Duration
	AgentInstallWait    time.Duration
	AgentUpdatePoll     time.Duration

	// SelfMACs (--self-macs) replace the MACs the hub reads from its own
	// machine to find the guest it runs in (selfguest.go); for tests.
	SelfMACs []string
	// Interfaces replaces the machine's network interfaces (the addresses
	// agents are told, addrs.go); for tests.
	Interfaces func() ([]netaddrs.Interface, error)
	// Now overrides the hub's clock; for tests. Defaults to time.Now.
	Now func() time.Time

	// ReconnectHold is how long the servers' heartbeat alerts wait while
	// the hub reconnects to them (hold.go), ReconnectHoldMax how long a
	// hold extended by new triggers lasts at most; tests shorten them.
	ReconnectHold    time.Duration
	ReconnectHoldMax time.Duration
}

// Defaults fills unset tunables.
func (c *Config) Defaults() {
	set := func(d *time.Duration, v time.Duration) {
		if *d == 0 {
			*d = v
		}
	}
	seti := func(d *int, v int) {
		if *d == 0 {
			*d = v
		}
	}
	if c.Listen == "" {
		c.Listen = ":8080"
	}
	if c.AgentListen == "" {
		c.AgentListen = ":8443"
	}
	if c.SocketMode == 0 {
		c.SocketMode = 0o660
	}
	set(&c.HeartbeatTimeout, 60*time.Second)
	set(&c.SessionLifetime, 30*24*time.Hour)
	set(&c.SessionMaxLifetime, 90*24*time.Hour)
	set(&c.ReauthWindow, 10*time.Minute)
	if len(c.TrustedProxies) == 0 {
		for _, cidr := range []string{"127.0.0.0/8", "::1/128"} {
			_, n, _ := net.ParseCIDR(cidr)
			c.TrustedProxies = append(c.TrustedProxies, n)
		}
	}
	if c.AgentProxyProtocol == nil {
		on := true
		c.AgentProxyProtocol = &on
	}
	set(&c.ConsoleTokenTTL, 30*time.Second)
	set(&c.ConsoleIdleTimeout, 15*time.Minute)
	set(&c.ConsoleMaxAge, 8*time.Hour)
	seti(&c.ConsolePerUser, 5)
	seti(&c.ConsolePerServer, 10)
	seti(&c.ConsolePerAgent, 20)
	set(&c.EnrollmentTTL, time.Hour)
	set(&c.StartupAlertGrace, 90*time.Second)
	set(&c.ReconnectHold, 5*time.Minute)
	set(&c.ReconnectHoldMax, 15*time.Minute)
	set(&c.ReauthorizeInterval, 2*time.Second)
	set(&c.TaskPollInterval, 2*time.Second)
	set(&c.AgentUpdateGrace, 2*time.Minute)
	set(&c.AgentUpdateInterval, 15*time.Minute)
	set(&c.AgentUpdateKick, time.Minute)
	set(&c.AgentUpdateTick, 5*time.Second)
	set(&c.AgentUpdateWait, 6*time.Minute)
	set(&c.AgentInstallWait, 10*time.Minute)
	set(&c.AgentUpdatePoll, 2*time.Second)
}

// Validate checks the configuration.
func (c *Config) Validate() error {
	if c.DataDir == "" {
		return errors.New("--data is required")
	}
	if (c.TLSCert == "") != (c.TLSKey == "") {
		return errors.New("--tls-cert and --tls-key must be given together")
	}
	if c.PublicURL != "" {
		u, err := url.Parse(c.PublicURL)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
			return fmt.Errorf("--public-url must be an http(s) URL, got %q", c.PublicURL)
		}
		c.PublicURL = strings.TrimRight(u.Scheme+"://"+u.Host, "/")
	}
	if c.AgentURL == "auto" {
		c.AgentURL, c.AgentURLAuto = "", true
	}
	if path, ok := strings.CutPrefix(c.Listen, "unix:"); ok {
		if !filepath.IsAbs(path) {
			return fmt.Errorf("--listen unix: needs an absolute socket path, got %q", c.Listen)
		}
		if c.TLSCert != "" {
			return errors.New("--tls-cert does not apply to a Unix socket listener")
		}
	}
	if c.SocketMode&^0o777 != 0 {
		return fmt.Errorf("--socket-mode must be a permission mode such as 0660, got %o", c.SocketMode)
	}
	if c.Headless {
		if c.ServiceTokenFile == "" {
			return errors.New("--headless needs --service-token-file (the only way to authenticate)")
		}
		if c.OIDC.Enabled() {
			return errors.New("--headless has no sign-in: drop the --oidc-* settings")
		}
	}
	if c.AgentURL != "" {
		u, err := url.Parse(c.AgentURL)
		if err != nil || u.Scheme != "wss" || u.Host == "" {
			return fmt.Errorf("--agent-url must be a wss:// URL, got %q", c.AgentURL)
		}
		c.AgentURL = strings.TrimRight(u.Scheme+"://"+u.Host, "/")
	}
	for i, o := range c.AllowedOrigins {
		u, err := url.Parse(o)
		if err != nil || u.Host == "" {
			return fmt.Errorf("bad allowed origin %q", o)
		}
		c.AllowedOrigins[i] = u.Scheme + "://" + u.Host
	}
	return c.OIDC.validate()
}

// OIDCConfig configures sign-in with an OpenID Connect provider
// (authorization code flow with PKCE). The client secret is read from a
// file (never a flag value: argv is visible to every local user).
type OIDCConfig struct {
	Issuer           string // --oidc-issuer, e.g. https://auth.example.com/application/o/rackoon/
	ClientID         string // --oidc-client-id
	ClientSecretFile string // --oidc-client-secret-file ("" = public client, PKCE only)
	Name             string // --oidc-name: the button says "Sign in with <Name>"
	Scopes           []string
	UsernameClaim    string // --oidc-username-claim (default preferred_username)
	// RoleClaim is the claim whose values map to roles (e.g. "groups"); ""
	// leaves roles to Rackoon's admins.
	RoleClaim string
	// RoleMap maps claim values to roles; "*" matches every user. The
	// highest matching role wins; no match refuses the sign-in.
	RoleMap []OIDCRole
	// AutoCreate creates unknown users at their first sign-in; otherwise an
	// admin adds them first (Settings › Users, sign-in "single sign-on").
	AutoCreate bool
}

// OIDCRole maps a claim value to a role.
type OIDCRole struct{ Value, Role string }

// Enabled reports whether single sign-on is configured.
func (o *OIDCConfig) Enabled() bool { return o.Issuer != "" }

func (o *OIDCConfig) validate() error {
	if !o.Enabled() {
		return nil
	}
	u, err := url.Parse(o.Issuer)
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" {
		return fmt.Errorf("--oidc-issuer must be an http(s) URL, got %q", o.Issuer)
	}
	if o.ClientID == "" {
		return errors.New("--oidc-issuer needs --oidc-client-id")
	}
	if o.Name == "" {
		o.Name = "single sign-on"
	}
	if o.UsernameClaim == "" {
		o.UsernameClaim = "preferred_username"
	}
	if o.RoleClaim != "" && len(o.RoleMap) == 0 {
		return errors.New("--oidc-role-claim needs --oidc-role-map")
	}
	return nil
}

// ParseOIDCRoleMap parses "value=role,value=role" ("*" = everyone).
func ParseOIDCRoleMap(s string) ([]OIDCRole, error) {
	var out []OIDCRole
	for _, part := range strings.Split(s, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		i := strings.LastIndex(part, "=")
		if i <= 0 {
			return nil, fmt.Errorf("bad role mapping %q (want value=role)", part)
		}
		v, role := strings.TrimSpace(part[:i]), strings.TrimSpace(part[i+1:])
		switch role {
		case "viewer", "operator", "admin":
		default:
			return nil, fmt.Errorf("bad role %q in %q (viewer, operator or admin)", role, part)
		}
		out = append(out, OIDCRole{Value: v, Role: role})
	}
	return out, nil
}

// unixSocket returns the socket path of a "unix:/path" listen address.
func unixSocket(listen string) (string, bool) { return strings.CutPrefix(listen, "unix:") }

// agentHosts returns the hosts the agent listener certificate should cover
// (lan: the address --agent-url auto found at start, if any).
func (c *Config) agentHosts(lan string) []string {
	hosts := []string{lan}
	if c.AgentURL != "" {
		if u, err := url.Parse(c.AgentURL); err == nil {
			hosts = append(hosts, u.Hostname())
		}
	}
	if h, _, err := net.SplitHostPort(c.AgentListen); err == nil && h != "" && h != "0.0.0.0" && h != "::" {
		hosts = append(hosts, h)
	}
	hosts = append(hosts, "localhost", "127.0.0.1")
	return dedupe(hosts)
}

func dedupe(s []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, x := range s {
		if x != "" && !seen[x] {
			seen[x] = true
			out = append(out, x)
		}
	}
	return out
}

// secureCookies reports whether cookies get the Secure attribute.
func (c *Config) secureCookies() bool {
	return strings.HasPrefix(c.PublicURL, "https://") || c.TLSCert != ""
}

// ParseCIDRs parses a comma-separated list of CIDRs or addresses.
func ParseCIDRs(list string) ([]*net.IPNet, error) {
	var out []*net.IPNet
	for _, p := range strings.Split(list, ",") {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		if !strings.Contains(p, "/") {
			if ip := net.ParseIP(p); ip != nil {
				bits := 128
				if ip.To4() != nil {
					bits = 32
				}
				p = fmt.Sprintf("%s/%d", p, bits)
			}
		}
		_, n, err := net.ParseCIDR(p)
		if err != nil {
			return nil, fmt.Errorf("bad CIDR %q", p)
		}
		out = append(out, n)
	}
	return out, nil
}

// trusted reports whether ip is a trusted proxy.
func (c *Config) trusted(ip net.IP) bool {
	for _, n := range c.TrustedProxies {
		if n.Contains(ip) {
			return true
		}
	}
	return false
}
