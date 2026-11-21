// Package backupclient talks to the appliance backup service socket (`/run/whombat-backup/api.sock`,
// contract `local`, CT-30/CT-37): `POST /v1/checkpoints` with a strict CheckpointRequest (the
// manager's `migration` checkpoints carry its drain request id as `underDrain`; the service verifies
// them from the destination) and `GET /v1/status` (BackupServiceStatus, for status.report).
package backupclient

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"time"

	"github.com/CybexBV/whombat/appliance/manager/internal/update"
	"github.com/CybexBV/whombat/contracts/go/local"
)

// Client talks to the backup service socket.
type Client struct {
	Socket  string
	Timeout time.Duration // default 30 min (checkpoints upload and verify)
}

// Error is a LocalError answer from the backup service.
type Error struct {
	Status int
	local.LocalErrorError
}

func (e *Error) Error() string {
	s := fmt.Sprintf("backup service: HTTP %d %s: %s", e.Status, e.Code, e.Message)
	if e.Stage != nil {
		s += " (stage " + *e.Stage + ")"
	}
	return s
}

func (c Client) http(timeout time.Duration) *http.Client {
	return &http.Client{Timeout: timeout, Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		var d net.Dialer
		return d.DialContext(ctx, "unix", c.Socket)
	}}}
}

func (c Client) do(ctx context.Context, method, path string, body any, timeout time.Duration) ([]byte, error) {
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	r, err := http.NewRequestWithContext(ctx, method, "http://backup"+path, rd)
	if err != nil {
		return nil, err
	}
	r.Header.Set("Content-Type", "application/json")
	resp, err := c.http(timeout).Do(r)
	if err != nil {
		return nil, fmt.Errorf("backup service: %w", err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 256*1024))
	if resp.StatusCode/100 != 2 {
		if le, err := local.ParseLocalError(data); err == nil {
			return nil, &Error{Status: resp.StatusCode, LocalErrorError: le.Error}
		}
		return nil, fmt.Errorf("backup service: HTTP %d: %s", resp.StatusCode, data)
	}
	return data, nil
}

// Checkpoint implements update.Checkpointer.
func (c Client) Checkpoint(ctx context.Context, req update.CheckpointRequest) (string, error) {
	timeout := c.Timeout
	if timeout == 0 {
		timeout = 30 * time.Minute
	}
	cr := local.CheckpointRequest{Reason: "migration", Migrations: req.Migrations}
	if req.ReleaseID != "" {
		id := req.ReleaseID
		cr.ReleaseID = &id
	}
	if req.UnderDrain != "" {
		d := req.UnderDrain
		cr.UnderDrain = &d
	}
	if err := cr.Validate(); err != nil {
		return "", fmt.Errorf("checkpoint request: %w", err)
	}
	data, err := c.do(ctx, http.MethodPost, "/v1/checkpoints", cr, timeout)
	if err != nil {
		return "", err
	}
	res, err := local.ParseCheckpointResult(data)
	if err != nil {
		return "", fmt.Errorf("checkpoint result: %w", err)
	}
	if !res.Verified || res.Ref == "" {
		return "", errors.New("backup service returned an unverified checkpoint")
	}
	return res.Ref, nil
}

// Status fetches the backup service status document.
func (c Client) Status(ctx context.Context) (*local.BackupServiceStatus, error) {
	data, err := c.do(ctx, http.MethodGet, "/v1/status", nil, 10*time.Second)
	if err != nil {
		return nil, err
	}
	var st local.BackupServiceStatus
	if err := json.Unmarshal(data, &st); err != nil {
		return nil, err
	}
	return &st, nil
}

// Restore reads where a restore is (`GET /v1/quarantine`, @whombat/protocol BackupRestoreState): its phase and since
// when.
func (c Client) Restore(ctx context.Context) (phase string, since *time.Time, err error) {
	data, err := c.do(ctx, http.MethodGet, "/v1/quarantine", nil, 10*time.Second)
	if err != nil {
		return "", nil, err
	}
	var st struct {
		Phase string     `json:"phase"`
		Since *time.Time `json:"since"`
	}
	if err := json.Unmarshal(data, &st); err != nil || st.Phase == "" {
		return "", nil, fmt.Errorf("backup service: restore state: %v", err)
	}
	return st.Phase, st.Since, nil
}
