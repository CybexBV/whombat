package broker

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"sync"
	"time"

	"github.com/CybexBV/whombat/contracts/go/local"
)

// PathCheck asks the manager to look for a newer release now (MG-67): `whombat-manager check` for root and the
// manager's own user, and the owner's “Check for updates” through the runtime (contracts 4.19, MG-194).
const PathCheck = local.ManagerPathUpdateCheck

// checkTimeout bounds a check: a poll, and with an assignment its TUF refresh and the engine's decision.
const checkTimeout = 60 * time.Second

// checkReuse: a check asked within this long of the last one answers that one. An owner pressing the button again and
// again must not turn into a request to the release list or control each time.
const checkReuse = 30 * time.Second

// checkMemo keeps the last check's answer, and lets one check run at a time.
type checkMemo struct {
	mu  sync.Mutex
	at  time.Time
	res *CheckResult
}

// CheckResult is what control or the release list answered to a check (MG-67), as `UpdateCheckResponse` has it.
type CheckResult struct {
	// V is the local API's version (the contract's `v`).
	V int64 `json:"v"`
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
	// The runtime sends `UpdateCheckRequest`; `whombat-manager check` sends nothing.
	b, ok := readBody(w, r)
	if !ok {
		return
	}
	if len(b) > 0 {
		if _, err := local.ParseUpdateCheckRequest(b); err != nil {
			writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
			return
		}
	}
	s.checks.mu.Lock() // one check at a time: a second press waits for the first and takes its answer
	defer s.checks.mu.Unlock()
	if s.checks.res != nil && time.Since(s.checks.at) < checkReuse {
		writeJSON(w, http.StatusOK, s.checks.res)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), checkTimeout)
	defer cancel()
	res, err := s.CheckNow(ctx)
	if err != nil {
		s.controlErr(w, err)
		return
	}
	out := *res
	out.V = local.LocalAPIVersion
	s.checks.at, s.checks.res = time.Now(), &out
	writeJSON(w, http.StatusOK, &out)
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
