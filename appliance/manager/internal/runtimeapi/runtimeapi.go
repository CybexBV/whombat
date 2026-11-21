// Package runtimeapi is the manager's client for the runtime admin socket (MG-12), using the
// @whombat/control-contracts `local` IPC contract (Go package local, contracts 0.4.0, CT-23):
// `GET /health`, `POST /drain` (scope `all`, requestId + lease; 409 while another caller's drain
// holds the runtime), `POST /resume`, `POST /claim-window`, `POST /facts`, `POST /claim-lookup` (contracts 0.7). The runtime checks that
// the peer uid is the manager's (or the backup service's).
package runtimeapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/CybexBV/whombat/contracts/go/local"
)

// Contract types used by the manager.
type (
	DrainRequest = local.DrainRequest
	DrainStatus  = local.DrainStatus
	Blocker      = local.DrainBlocker
	Health       = local.RuntimeHealth
	UpdateFacts  = local.UpdateFacts
	Facts        = local.FactsRequest
	ClaimWindow  = local.ClaimWindowRequest
)

// Version of the admin API.
const Version = local.LocalAPIVersion

// BusyError is returned when another caller's drain holds the runtime (HTTP 409).
type BusyError struct{ Message string }

func (e *BusyError) Error() string { return "runtime busy: " + e.Message }

// Client talks to the admin socket (and optionally a loopback health URL).
type Client struct {
	Socket    string
	HealthURL string // optional http://127.0.0.1:<port>/health; default uses the admin socket
	hc        *http.Client
}

// New creates a client.
func New(socket, healthURL string) *Client {
	tr := &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		var d net.Dialer
		return d.DialContext(ctx, "unix", socket)
	}, DisableKeepAlives: true}
	return &Client{Socket: socket, HealthURL: healthURL, hc: &http.Client{Transport: tr, Timeout: 15 * time.Second}}
}

func (c *Client) do(ctx context.Context, method, url string, body any, out any) (int, []byte, error) {
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, url, rd)
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	hc := c.hc
	if !strings.HasPrefix(url, "http://runtime/") {
		hc = &http.Client{Timeout: 10 * time.Second}
	}
	resp, err := hc.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 256*1024))
	if err != nil {
		return resp.StatusCode, nil, err
	}
	if out != nil && len(data) > 0 && (resp.StatusCode/100 == 2 || resp.StatusCode == http.StatusServiceUnavailable) {
		if err := json.Unmarshal(data, out); err != nil {
			return resp.StatusCode, data, fmt.Errorf("runtime admin %s: %w", url, err)
		}
	}
	return resp.StatusCode, data, nil
}

func localError(data []byte) string {
	var e local.LocalError
	if json.Unmarshal(data, &e) == nil && e.Error.Code != "" {
		return e.Error.Code + ": " + e.Error.Message
	}
	return strings.TrimSpace(string(data))
}

// Drain requests (or renews) an update-style drain (scope all).
func (c *Client) Drain(ctx context.Context, r DrainRequest) (*DrainStatus, error) {
	r.V, r.Scope = Version, "all"
	var st DrainStatus
	code, data, err := c.do(ctx, http.MethodPost, "http://runtime"+local.AdminPathDrain, r, &st)
	if err != nil {
		return nil, err
	}
	switch code {
	case http.StatusOK:
		return &st, nil
	case http.StatusConflict:
		return nil, &BusyError{Message: localError(data)}
	}
	return nil, fmt.Errorf("drain: HTTP %d: %s", code, localError(data))
}

// Resume ends a drain.
func (c *Client) Resume(ctx context.Context, requestID string) error {
	code, data, err := c.do(ctx, http.MethodPost, "http://runtime"+local.AdminPathResume, local.ResumeRequest{V: Version, RequestID: requestID}, nil)
	if err != nil {
		return err
	}
	if code != http.StatusOK {
		return fmt.Errorf("resume: HTTP %d: %s", code, localError(data))
	}
	return nil
}

// Health fetches runtime health (HTTP 503 still carries a body).
func (c *Client) Health(ctx context.Context) (*Health, error) {
	url := "http://runtime" + local.AdminPathHealth
	if c.HealthURL != "" {
		url = c.HealthURL
	}
	var h Health
	code, data, err := c.do(ctx, http.MethodGet, url, nil, &h)
	if err != nil {
		return nil, err
	}
	if code != http.StatusOK && code != http.StatusServiceUnavailable {
		return nil, fmt.Errorf("health: HTTP %d: %s", code, localError(data))
	}
	return &h, nil
}

// SetClaimWindow sets the physical claim window.
func (c *Client) SetClaimWindow(ctx context.Context, required bool, openUntil *time.Time) error {
	w := ClaimWindow{V: Version, Required: required}
	if openUntil != nil {
		s := openUntil.UTC().Format(time.RFC3339)
		w.OpenUntil = &s
	}
	code, data, err := c.do(ctx, http.MethodPost, "http://runtime"+local.AdminPathClaimWindow, w, nil)
	if err == nil && code != http.StatusOK {
		err = fmt.Errorf("claim-window: HTTP %d: %s", code, localError(data))
	}
	return err
}

// ErrNotSupported: the runtime has no such admin endpoint (404: a runtime before contracts 0.7).
var ErrNotSupported = errors.New("runtime admin endpoint not supported")

// SetClaimLookup hands the runtime the claim-code lookup lease (CC-03, `POST /claim-lookup`); lookup ""
// clears it ({lookup: null}).
func (c *Client) SetClaimLookup(ctx context.Context, lookup string, expiresAt time.Time) error {
	r := local.ClaimLookupLeaseRequest{V: Version}
	if lookup != "" {
		exp := expiresAt.UTC().Format(time.RFC3339)
		r.Lookup, r.ExpiresAt = &lookup, &exp
	}
	code, data, err := c.do(ctx, http.MethodPost, "http://runtime"+local.AdminPathClaimLookup, r, nil)
	switch {
	case err != nil:
		return err
	case code == http.StatusNotFound:
		return ErrNotSupported
	case code != http.StatusOK:
		return fmt.Errorf("claim-lookup: HTTP %d: %s", code, localError(data))
	}
	return nil
}

// RuntimeFacts reads the runtime's facts (`GET /facts`, CT-37) for status.report.
func (c *Client) RuntimeFacts(ctx context.Context) (*local.RuntimeFacts, error) {
	code, data, err := c.do(ctx, http.MethodGet, "http://runtime"+local.AdminPathFacts, nil, nil)
	if err != nil {
		return nil, err
	}
	if code != http.StatusOK {
		return nil, fmt.Errorf("facts: HTTP %d: %s", code, localError(data))
	}
	return local.ParseRuntimeFacts(data)
}

// SendFacts replaces the runtime's facts (backup is nil when the backup service doesn't answer: the runtime reads it as unknown).
func (c *Client) SendFacts(ctx context.Context, update *UpdateFacts, backup *local.BackupServiceStatus) error {
	code, data, err := c.do(ctx, http.MethodPost, "http://runtime"+local.AdminPathFacts, Facts{V: Version, Update: update, Backup: backup}, nil)
	if err == nil && code != http.StatusOK {
		err = fmt.Errorf("facts: HTTP %d: %s", code, localError(data))
	}
	return err
}

// ASCII folds free text to printable ASCII (the local contract's text fields), truncated to max.
func ASCII(s string, max int) string {
	repl := strings.NewReplacer("’", "'", "‘", "'", "“", "\"", "”", "\"", "—", "-", "–", "-", "·", "-", "…", "...", "−", "-")
	s = repl.Replace(s)
	b := make([]byte, 0, len(s))
	for _, r := range s {
		if r >= 0x20 && r <= 0x7e {
			b = append(b, byte(r))
		} else {
			b = append(b, '?')
		}
		if len(b) >= max {
			break
		}
	}
	return string(b)
}

// PushClients hands the runtime the AI clients' status (`POST /clients`, contracts 0.9.0, CT-73). A runtime
// without the endpoint (404) answers ErrNotSupported.
func (c *Client) PushClients(ctx context.Context, req *local.ClientsPushRequest) error {
	if err := req.Validate(); err != nil {
		return fmt.Errorf("clients push: %w", err)
	}
	code, data, err := c.do(ctx, http.MethodPost, "http://runtime"+local.AdminPathClients, req, nil)
	switch {
	case err != nil:
		return err
	case code == http.StatusNotFound:
		return ErrNotSupported
	case code != http.StatusOK:
		return fmt.Errorf("clients: HTTP %d: %s", code, localError(data))
	}
	return nil
}

// ClientAdapters reads the runtime's client adapter levels from `GET /facts` (required since contracts 1.0.0).
func (c *Client) ClientAdapters(ctx context.Context) (*local.RuntimeFactsClientAdapters, error) {
	f, err := c.RuntimeFacts(ctx)
	if err != nil {
		return nil, err
	}
	return &f.ClientAdapters, nil
}

// ErrLicenceStale: the runtime holds a token with a newer iat than the pushed one (409 stale, LC-07).
var ErrLicenceStale = errors.New("runtime holds a newer licence token (stale)")

// ErrLicenceRefused: the runtime could not verify the pushed token (400 bad_request).
var ErrLicenceRefused = errors.New("runtime refused the licence token")

// PushLicence hands the runtime the licence token and the high-water mark (`POST /licence`, contracts 0.10.0,
// LC-06, CT-77); token "" sends {token: null} (the manager holds none yet: the runtime keeps its own and takes only
// highWater). It returns the runtime's view of the state (nil when unclaimed). A runtime before 0.10.0 answers 404
// (ErrNotSupported).
func (c *Client) PushLicence(ctx context.Context, token string, highWater time.Time) (*local.LocalLicenceStatus, error) {
	r := local.LicencePushRequest{V: Version, HighWater: highWater.UTC().Format(time.RFC3339)}
	if token != "" {
		r.Token = &token
	}
	if err := r.Validate(); err != nil {
		return nil, fmt.Errorf("licence push: %w", err)
	}
	code, data, err := c.do(ctx, http.MethodPost, "http://runtime"+local.AdminPathLicence, r, nil)
	switch {
	case err != nil:
		return nil, err
	case code == http.StatusNotFound:
		return nil, ErrNotSupported
	case code == http.StatusConflict:
		return nil, fmt.Errorf("%w: %s", ErrLicenceStale, localError(data))
	case code == http.StatusBadRequest:
		return nil, fmt.Errorf("%w: %s", ErrLicenceRefused, localError(data))
	case code != http.StatusOK:
		return nil, fmt.Errorf("licence: HTTP %d: %s", code, localError(data))
	}
	resp, err := local.ParseLicencePushResponse(data)
	if err != nil {
		return nil, fmt.Errorf("licence push response: %w", err)
	}
	return resp.Licence, nil
}
