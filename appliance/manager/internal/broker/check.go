package broker

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"time"

	"github.com/CybexBV/whombat/contracts/go/local"
)

// PathCheck asks the manager to poll control for an assignment now (MG-67): `whombat-manager check`, for root and the
// manager's own user. Not a contract path: the runtime doesn't call it.
const PathCheck = "/v1/update/check"

// checkTimeout bounds a check: a poll, and with an assignment its TUF refresh and the engine's decision.
const checkTimeout = 60 * time.Second

// CheckResult is what control answered to a poll made for a check (MG-67).
type CheckResult struct {
	// Result is control's: assigned, unchanged or none.
	Result string `json:"result"`
	// Decision is the engine's on an assignment (started, queued, noop, hold, refused); empty without one.
	Decision string `json:"decision,omitempty"`
	// NextCheckS is when the manager asks again by itself, as control suggested.
	NextCheckS int64 `json:"nextCheckS"`
}

func (s *Server) check(w http.ResponseWriter, r *http.Request) {
	if s.CheckNow == nil {
		writeErr(w, http.StatusNotFound, "unavailable", "this manager doesn't poll on demand")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), checkTimeout)
	defer cancel()
	res, err := s.CheckNow(ctx)
	if err != nil {
		s.controlErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

// Check asks the manager serving socket to poll control now and returns control's answer (`whombat-manager check`).
func Check(ctx context.Context, socket string) (*CheckResult, error) {
	c := &http.Client{Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		var d net.Dialer
		return d.DialContext(ctx, "unix", socket)
	}}}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "http://manager"+PathCheck, nil)
	if err != nil {
		return nil, err
	}
	resp, err := c.Do(req)
	if err != nil {
		return nil, fmt.Errorf("the manager at %s: %w", socket, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		var e local.LocalError
		_ = json.NewDecoder(resp.Body).Decode(&e)
		return nil, fmt.Errorf("the manager answered %d %s: %s", resp.StatusCode, e.Error.Code, e.Error.Message)
	}
	var out CheckResult
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, fmt.Errorf("the manager's answer: %w", err)
	}
	return &out, nil
}
