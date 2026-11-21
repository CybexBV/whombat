// Package runtimeadmin is the backup service's client for the runtime admin endpoint: a local HTTP API
// on the runtime's unix socket (/run/whombat/admin.sock). The shapes follow the manager's contract
// (manager/internal/runtimeapi in this folder) plus what backups add:
//
//   - reason "backup" with scope "writes": a write barrier. The runtime holds new write transactions
//     at the commit pipeline (queued, not rejected), lets in-flight transactions finish and pauses
//     background workers that delete or move files (blob sweeps, workspace cleanup). Running turns
//     continue. Safe = barrier held.
//   - reason "backup" with scope "all": the update-style drain (no new turns or jobs, running work
//     finishes, outbound effects paused) plus the write barrier; used by the copy fallback.
//
// The lease bounds every hold: without renewal the runtime resumes on its own, so a crashed backup can
// never leave writes paused.
package runtimeadmin

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"time"
)

// Version of the admin API.
const Version = 1

// DrainRequest asks for a safe boundary (idempotent per RequestID; renews the lease).
type DrainRequest struct {
	V         int    `json:"v"`
	RequestID string `json:"requestId"`
	Reason    string `json:"reason"` // "backup"
	Scope     string `json:"scope"`  // "writes" | "all"
	LeaseMs   int64  `json:"leaseMs"`
}

// Blocker is acknowledged work preventing the boundary.
type Blocker struct {
	Kind        string    `json:"kind"`
	ID          string    `json:"id"`
	Description string    `json:"description"`
	Since       time.Time `json:"since"`
	EstimatedMs int64     `json:"estimatedMs,omitempty"`
}

// DrainStatus is the runtime's answer.
type DrainStatus struct {
	V           int       `json:"v"`
	RequestID   string    `json:"requestId"`
	Draining    bool      `json:"draining"`
	Safe        bool      `json:"safe"`
	Blockers    []Blocker `json:"blockers"`
	EstimatedMs int64     `json:"estimatedMs"`
}

// Health is the part of the runtime's local health a checkpoint records.
type Health struct {
	V         int    `json:"v"`
	Status    string `json:"status"`
	ReleaseID string `json:"releaseId"`
	Version   string `json:"version"`
	Draining  bool   `json:"draining"`
	Checks    struct {
		Migrations struct {
			SchemaVersion int `json:"schemaVersion"`
		} `json:"migrations"`
	} `json:"checks"`
}

// BusyError: the runtime is draining for another owner (an update); retry later.
type BusyError struct{ Detail string }

func (e *BusyError) Error() string { return "runtime busy: " + e.Detail }

// Client talks to the admin socket.
type Client struct {
	hc *http.Client
}

// New creates a client for socket.
func New(socket string) *Client {
	tr := &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		var d net.Dialer
		return d.DialContext(ctx, "unix", socket)
	}, DisableKeepAlives: true}
	return &Client{hc: &http.Client{Transport: tr, Timeout: 15 * time.Second}}
}

func (c *Client) do(ctx context.Context, method, path string, body, out any) (int, error) {
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, "http://runtime"+path, rd)
	if err != nil {
		return 0, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.hc.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 256*1024))
	if err != nil {
		return resp.StatusCode, err
	}
	if resp.StatusCode == http.StatusConflict {
		return resp.StatusCode, &BusyError{Detail: string(bytes.TrimSpace(data))}
	}
	if out != nil && len(data) > 0 && (resp.StatusCode < 300 || resp.StatusCode == http.StatusServiceUnavailable) {
		if err := json.Unmarshal(data, out); err != nil {
			return resp.StatusCode, fmt.Errorf("runtime admin %s: %w", path, err)
		}
	}
	return resp.StatusCode, nil
}

// Drain requests or renews a drain.
func (c *Client) Drain(ctx context.Context, r DrainRequest) (*DrainStatus, error) {
	r.V = Version
	var st DrainStatus
	code, err := c.do(ctx, http.MethodPost, "/drain", r, &st)
	if err != nil {
		return nil, err
	}
	if code != http.StatusOK {
		return nil, fmt.Errorf("drain: HTTP %d", code)
	}
	return &st, nil
}

// Resume ends a drain.
func (c *Client) Resume(ctx context.Context, requestID string) error {
	code, err := c.do(ctx, http.MethodPost, "/resume", map[string]any{"v": Version, "requestId": requestID}, nil)
	if err != nil {
		return err
	}
	if code != http.StatusOK {
		return fmt.Errorf("resume: HTTP %d", code)
	}
	return nil
}

// Health fetches local health (a 503 still carries a body).
func (c *Client) Health(ctx context.Context) (*Health, error) {
	var h Health
	code, err := c.do(ctx, http.MethodGet, "/health", nil, &h)
	if err != nil {
		return nil, err
	}
	if code != http.StatusOK && code != http.StatusServiceUnavailable {
		return nil, fmt.Errorf("health: HTTP %d", code)
	}
	return &h, nil
}
