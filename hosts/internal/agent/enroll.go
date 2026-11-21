package agent

import (
	"bytes"
	"context"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/pelletier/go-toml/v2"
)

// EnrollOptions configures Enroll.
type EnrollOptions struct {
	Hub          string // wss://host:port
	CASHA256     string
	Token        string
	ConfigDir    string // default DefaultConfigDir
	StateDir     string // written to agent.toml, default DefaultStateDir
	AgentVersion string
	// Force re-enrolls even when agent.crt already exists.
	Force bool
	// PollInterval between status polls (default 5 s); Timeout bounds the
	// whole enrollment (default 1 h, the token lifetime).
	PollInterval time.Duration
	Timeout      time.Duration
	// Logf receives progress messages (may be nil).
	Logf func(format string, args ...any)
	// OnPending is called once when the hub answered that the enrollment
	// waits for an admin (not pre-approved); may be nil.
	OnPending func(enrollmentID string)
}

// EnrollRequest is the body of POST /agent/v1/enroll.
type EnrollRequest struct {
	Token        string `json:"token"`
	CSR          string `json:"csr"`
	Hostname     string `json:"hostname"`
	MachineID    string `json:"machine_id"`
	OS           string `json:"os"`
	Address      string `json:"address"`
	AgentVersion string `json:"agent_version"`
}

// EnrollAccepted is the 202 answer to EnrollRequest. State is "approved"
// (with ServerID) when the token was pre-approved: the first poll returns
// the certificate. Hubs before Whombat's SI-07 send no state.
type EnrollAccepted struct {
	EnrollmentID string `json:"enrollment_id"`
	PollSecret   string `json:"poll_secret"`
	State        string `json:"state,omitempty"`
	ServerID     string `json:"server_id,omitempty"`
}

// EnrollStatus is the answer to GET /agent/v1/enroll/{id}.
type EnrollStatus struct {
	State       string `json:"state"` // pending | approved | rejected
	ServerID    string `json:"server_id,omitempty"`
	Certificate string `json:"certificate,omitempty"`
	CA          string `json:"ca,omitempty"`
	Code        string `json:"code,omitempty"`
}

// ErrAlreadyEnrolled is returned when agent.crt exists and Force is false.
var ErrAlreadyEnrolled = errors.New("agent is already enrolled")

// Enroll runs the enrollment flow of docs/AGENT-PROTOCOL.md: generate a key,
// send a CSR with the token, poll until an admin approves, then write
// agent.crt, ca.crt and agent.toml (remote control off). It returns the
// written config.
func Enroll(ctx context.Context, o EnrollOptions) (*Config, error) {
	if o.ConfigDir == "" {
		o.ConfigDir = DefaultConfigDir
	}
	if o.StateDir == "" {
		o.StateDir = DefaultStateDir
	}
	if o.PollInterval <= 0 {
		o.PollInterval = 5 * time.Second
	}
	if o.Timeout <= 0 {
		o.Timeout = time.Hour
	}
	logf := o.Logf
	if logf == nil {
		logf = func(string, ...any) {}
	}
	if o.Token == "" {
		return nil, errors.New("missing enrollment token")
	}
	if !ValidPin(o.CASHA256) {
		return nil, errors.New("ca_sha256 must be 64 hex characters")
	}
	pin := NormalizePin(o.CASHA256)
	base, err := HubHTTPBase(o.Hub)
	if err != nil {
		return nil, err
	}
	wsBase, _ := HubWSBase(o.Hub)

	cfg := &Config{Dir: o.ConfigDir, Hub: wsBase, CASHA256: pin, StateDir: o.StateDir}
	cfg.applyDefaults()
	if _, err := os.Stat(cfg.CertPath()); err == nil && !o.Force {
		return nil, fmt.Errorf("%w (%s exists; use --force to enroll again)", ErrAlreadyEnrolled, cfg.CertPath())
	}
	if err := os.MkdirAll(o.ConfigDir, 0o755); err != nil {
		return nil, err
	}

	ctx, cancel := context.WithTimeout(ctx, o.Timeout)
	defer cancel()

	key, err := GenerateKey(cfg.KeyPath())
	if err != nil {
		return nil, fmt.Errorf("generate key: %w", err)
	}
	hostname := Hostname()
	csr, err := CreateCSR(key, hostname)
	if err != nil {
		return nil, err
	}

	var foundCA *x509.Certificate
	client := &http.Client{
		Timeout: 30 * time.Second,
		Transport: &http.Transport{
			TLSClientConfig:     PinnedTLSConfig(pin, &foundCA),
			TLSHandshakeTimeout: 15 * time.Second,
			Proxy:               http.ProxyFromEnvironment,
		},
	}

	req := EnrollRequest{
		Token:        o.Token,
		CSR:          string(csr),
		Hostname:     hostname,
		MachineID:    MachineID(),
		OS:           OSPrettyName(),
		Address:      SourceAddress(base),
		AgentVersion: o.AgentVersion,
	}
	var acc EnrollAccepted
	status, body, err := doJSON(ctx, client, http.MethodPost, base+"/agent/v1/enroll", "", req, &acc)
	if err != nil {
		return nil, err
	}
	switch status {
	case http.StatusAccepted, http.StatusOK, http.StatusCreated:
	case http.StatusUnauthorized:
		return nil, fmt.Errorf("enrollment refused: %s (the token is invalid, used or expired)", errCode(body, "invalid_token"))
	default:
		return nil, fmt.Errorf("enrollment request failed: HTTP %d %s", status, errCode(body, ""))
	}
	if acc.EnrollmentID == "" || acc.PollSecret == "" {
		return nil, errors.New("enrollment request: hub answered without enrollment id")
	}
	if acc.State == "approved" {
		logf("enrollment %s approved as server %q", acc.EnrollmentID, acc.ServerID)
	} else {
		if o.OnPending != nil {
			o.OnPending(acc.EnrollmentID)
		}
		logf("enrollment %s requested; waiting for an admin to approve it in Whombat", acc.EnrollmentID)
	}

	pollURL := base + "/agent/v1/enroll/" + url.PathEscape(acc.EnrollmentID)
	st, err := pollEnrollment(ctx, client, pollURL, acc.PollSecret, o.PollInterval, logf)
	if err != nil {
		return nil, err
	}
	cas, err := ParseCertsPEM([]byte(st.CA))
	if err != nil {
		return nil, fmt.Errorf("hub sent an invalid CA: %w", err)
	}
	ca := cas[0]
	if CertPin(ca) != pin {
		return nil, errors.New("hub sent a CA that does not match the pinned ca_sha256")
	}
	if foundCA != nil && !foundCA.Equal(ca) {
		return nil, errors.New("hub sent a CA different from the one it presented on TLS")
	}
	if _, err := VerifyClientCert([]byte(st.Certificate), key, ca); err != nil {
		return nil, fmt.Errorf("hub sent an invalid certificate: %w", err)
	}
	if err := WriteFileAtomic(cfg.CAPath(), []byte(st.CA), 0o644); err != nil {
		return nil, err
	}
	if err := WriteFileAtomic(cfg.CertPath(), []byte(st.Certificate), 0o644); err != nil {
		return nil, err
	}
	if err := WriteInitialConfig(cfg); err != nil {
		return nil, err
	}
	logf("enrolled as server %q", st.ServerID)
	return cfg, nil
}

// pollEnrollment polls until the enrollment is approved, rejected or ctx
// ends.
func pollEnrollment(ctx context.Context, client *http.Client, pollURL, secret string, every time.Duration, logf func(string, ...any)) (*EnrollStatus, error) {
	for {
		var st EnrollStatus
		status, body, err := doJSON(ctx, client, http.MethodGet, pollURL, secret, nil, &st)
		if err != nil {
			if ctx.Err() != nil {
				return nil, fmt.Errorf("enrollment not approved in time: %w", ctx.Err())
			}
			logf("poll failed (will retry): %v", err)
		} else {
			switch {
			case status == http.StatusOK && st.State == "approved":
				return &st, nil
			case status == http.StatusForbidden || st.State == "rejected":
				return nil, errors.New("enrollment was rejected by an admin")
			case status == http.StatusAccepted || st.State == "pending":
			case status == http.StatusNotFound || status == http.StatusGone || status == http.StatusUnauthorized:
				return nil, fmt.Errorf("enrollment expired or unknown (HTTP %d %s)", status, errCode(body, ""))
			default:
				logf("poll: HTTP %d %s (will retry)", status, errCode(body, ""))
			}
		}
		select {
		case <-ctx.Done():
			return nil, fmt.Errorf("enrollment not approved in time: %w", ctx.Err())
		case <-time.After(every):
		}
	}
}

// WriteInitialConfig writes agent.toml with remote control off (except the
// assistant's read-only checks) and the optional sections commented.
func WriteInitialConfig(cfg *Config) error {
	head, err := toml.Marshal(struct {
		Hub      string `toml:"hub"`
		CASHA256 string `toml:"ca_sha256"`
		StateDir string `toml:"state_dir"`
	}{cfg.Hub, cfg.CASHA256, cfg.StateDir})
	if err != nil {
		return err
	}
	var b strings.Builder
	b.WriteString("# Whombat agent configuration (written by `whombat-agent enroll`).\n")
	b.WriteString("# hub: agent endpoint of the hub; ca_sha256: pinned hub CA.\n")
	b.Write(head)
	b.WriteString(`
# Remote control is decided on this host; the hub cannot turn it on.
#   console:    guest consoles, container shells and logs, screenshots, the
#               Screens wall, the host's journal and its process, port,
#               service and package lists
#   power:      start, shutdown, reboot, force stop, restart, stop, pause,
#               resume and snapshots of guests
#   host_shell: a root shell on this host (console does not include it)
#   host_power: reboot and shut down this host
#   manage:     change guests' configuration, create, clone, back up,
#               restore and delete guests, ISO images and templates
#               (Proxmox VE, Incus)
#   diagnose:   read-only checks for the hub's assistant (logs, SMART,
#               arrays, services); on unless set to false. Its shell
#               commands need host_shell.
# All but diagnose are also off in the hub until an admin enables them for
# this server.
# Apply changes with: systemctl reload whombat-agent (or restart), or run
# whombat-agent allow manage (deny, policy) as root, which changes this
# table and reloads the agent in one go.
[remote_control]
console = false
power = false
host_shell = false
host_power = false
manage = false
diagnose = true

# Signed agent updates pushed by the hub (verified with the key built into
# this binary). Set allow = false to update this host only by hand.
[update]
# allow = true

# Optional collectors. Unset = enabled when the platform is detected
# (updates and image_updates: on unless set to false).
[collectors]
# docker = true
# incus = true
# libvirt = true
# pve = true
# smart = true
# ups = true            # NUT or apcupsd
# gpu = true            # nvidia-smi, amdgpu / i915
# updates = true        # pending packages, from the package cache every 6 h
# image_updates = true  # newer container images: anonymous registry HEAD
#                       # requests, the only collector that contacts the internet

# [pve]
# url = "https://127.0.0.1:8006/api2/json"
# token_file = "/etc/whombat-agent/pve-token"
# manage_token_file = "/etc/whombat-agent/pve-manage-token"  # while manage = true
`)
	return WriteFileAtomic(cfg.Dir+"/"+ConfigFileName, []byte(b.String()), 0o600)
}

func doJSON(ctx context.Context, c *http.Client, method, u, bearer string, in, out any) (int, []byte, error) {
	var body io.Reader
	if in != nil {
		b, err := json.Marshal(in)
		if err != nil {
			return 0, nil, err
		}
		body = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, u, body)
	if err != nil {
		return 0, nil, err
	}
	if in != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Accept", "application/json")
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	resp, err := c.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return resp.StatusCode, nil, err
	}
	if out != nil && len(b) > 0 && strings.Contains(resp.Header.Get("Content-Type"), "json") {
		_ = json.Unmarshal(b, out)
	}
	return resp.StatusCode, b, nil
}

// errCode extracts {"code": ...} from an error body for messages.
func errCode(body []byte, def string) string {
	var e struct {
		Code   string `json:"code"`
		Detail string `json:"detail"`
	}
	if json.Unmarshal(body, &e) == nil {
		if e.Code != "" && e.Detail != "" {
			return e.Code + ": " + e.Detail
		}
		if e.Code != "" {
			return e.Code
		}
	}
	return def
}
