package agent

import (
	"context"
	"crypto/tls"
	"fmt"
	"net/http"
	"time"

	"rackoon/internal/hub/ca"
)

// `whombat-agent whoami` (Whombat SI-08): which server this agent is and
// which Whombat it reports to, for install.sh's "kept" answer, and whether
// that Whombat still knows it.

// Whoami is the enrolled agent's server id (from agent.crt) and the
// SHA-256 of its hub's CA (ca.crt), lowercase hex.
func Whoami(dir string) (serverID, caPin string, err error) {
	cfg := &Config{Dir: dir}
	cert, err := LoadCertFile(cfg.CertPath())
	if err != nil {
		return "", "", err
	}
	caCert, err := LoadCertFile(cfg.CAPath())
	if err != nil {
		return "", "", err
	}
	return ca.ClientIdentity(cert), CertPin(caCert), nil
}

// Identity states CheckIdentity reports.
const (
	IdentityKnown       = "known"       // the hub accepts this agent's certificate
	IdentityRemoved     = "removed"     // the server was removed in Whombat, or the certificate expired
	IdentityUnreachable = "unreachable" // no answer: nothing can be said
)

// CheckIdentity asks the hub at hub (wss://host:port; "" = agent.toml's)
// whether it still accepts this agent's certificate: the connect endpoint
// refuses an unknown server or a revoked certificate with 403 before the
// WebSocket upgrade. Only a definite refusal (or an expired certificate)
// is "removed"; a network failure is "unreachable".
func CheckIdentity(ctx context.Context, dir, hub string) (string, error) {
	cfg, err := LoadConfig(dir)
	if err != nil {
		return "", err
	}
	if hub == "" {
		hub = cfg.Hub
	}
	id, err := LoadIdentity(cfg)
	if err != nil {
		return "", err
	}
	if time.Now().After(id.Cert.NotAfter) {
		return IdentityRemoved, nil
	}
	base, err := HubHTTPBase(hub)
	if err != nil {
		return "", err
	}
	client := &http.Client{
		Timeout: 15 * time.Second,
		Transport: &http.Transport{
			TLSClientConfig:     CATLSConfig(id.CA, func() *tls.Certificate { return &id.TLS }),
			TLSHandshakeTimeout: 10 * time.Second,
			Proxy:               http.ProxyFromEnvironment,
		},
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+"/agent/v1/connect", nil)
	if err != nil {
		return "", err
	}
	resp, err := client.Do(req)
	if err != nil {
		return IdentityUnreachable, err
	}
	resp.Body.Close()
	switch resp.StatusCode {
	case http.StatusForbidden:
		return IdentityRemoved, nil
	case http.StatusBadRequest, http.StatusUpgradeRequired, http.StatusOK, http.StatusSwitchingProtocols:
		// The certificate passed; a plain GET is no WebSocket handshake.
		return IdentityKnown, nil
	}
	return IdentityUnreachable, fmt.Errorf("hub answered HTTP %d", resp.StatusCode)
}
