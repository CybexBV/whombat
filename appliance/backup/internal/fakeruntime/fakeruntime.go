// Package fakeruntime is a test double of the runtime admin socket implementing the BK-05 backup
// barrier: writers (standing in for the commit pipeline) call Begin/End around each write; a backup
// drain engages the barrier, Begin blocks while it is held, and the drain reports safe once no write is
// in flight and no blocker remains. The lease expires on its own like the real runtime's.
package fakeruntime

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"os"
	"sync"
	"time"

	"github.com/CybexBV/whombat/contracts/go/local"

	"github.com/CybexBV/whombat/appliance/backup/internal/runtimeadmin"
)

// Runtime is the fake.
type Runtime struct {
	mu        sync.Mutex
	cond      *sync.Cond
	drainID   string
	scope     string
	reason    string
	until     time.Time
	inFlight  int
	blockers  []runtimeadmin.Blocker
	busy      string
	srv       *http.Server
	Socket    string
	DrainReqs int
	Resumes   int
	// HeldFor accumulates how long the barrier was held.
	heldSince time.Time
	HeldTotal time.Duration
	// WritesDuringBarrier counts writes that started while a barrier was held (must stay 0).
	WritesDuringBarrier int
	Health              local.RuntimeHealth
}

// Start serves on a new unix socket at path.
func Start(path string) (*Runtime, error) {
	_ = os.Remove(path)
	l, err := net.Listen("unix", path)
	if err != nil {
		return nil, err
	}
	r := &Runtime{Socket: path}
	r.cond = sync.NewCond(&r.mu)
	r.Health = local.RuntimeHealth{V: 1, Status: "ok", ReleaseID: "rt-test-1", Version: "0.0.0-test",
		Checks: local.RuntimeHealthChecks{Db: local.HealthCheck{Ok: true}, SessionEndpoint: local.HealthCheck{Ok: true},
			Migrations: local.MigrationsCheck{Ok: true, Compatible: true, Access: "read-write", SchemaVersion: 28}}}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /drain", r.drain)
	mux.HandleFunc("POST /resume", r.resume)
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, _ *http.Request) {
		r.mu.Lock()
		h := r.Health
		h.Draining = r.activeLocked()
		r.mu.Unlock()
		if err := h.Validate(); err != nil {
			http.Error(w, "fake health fails the contract: "+err.Error(), http.StatusInternalServerError)
			return
		}
		_ = json.NewEncoder(w).Encode(h)
	})
	r.srv = &http.Server{Handler: mux}
	go func() { _ = r.srv.Serve(l) }()
	go r.expiry()
	return r, nil
}

// Close stops the server.
func (r *Runtime) Close() { _ = r.srv.Close() }

// SetBlockers sets acknowledged work that keeps the boundary unsafe (nil clears).
func (r *Runtime) SetBlockers(b []runtimeadmin.Blocker) {
	r.mu.Lock()
	r.blockers = b
	r.mu.Unlock()
}

// SetBusy makes drain answer 409 (another drain owner) until cleared with "".
func (r *Runtime) SetBusy(detail string) {
	r.mu.Lock()
	r.busy = detail
	r.mu.Unlock()
}

// Barrier reports whether a backup drain currently holds writes.
func (r *Runtime) Barrier() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.activeLocked()
}

func (r *Runtime) activeLocked() bool { return r.drainID != "" && time.Now().Before(r.until) }

// Begin waits until no barrier is held, then marks a write in flight.
func (r *Runtime) Begin(ctx context.Context) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	for r.activeLocked() {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		r.cond.Wait()
	}
	r.inFlight++
	return nil
}

// End marks a write done.
func (r *Runtime) End() {
	r.mu.Lock()
	r.inFlight--
	r.mu.Unlock()
	r.cond.Broadcast()
}

func (r *Runtime) expiry() {
	for {
		time.Sleep(20 * time.Millisecond)
		r.mu.Lock()
		if r.drainID != "" && !time.Now().Before(r.until) {
			r.releaseLocked()
		}
		r.mu.Unlock()
		r.cond.Broadcast()
	}
}

func (r *Runtime) releaseLocked() {
	if r.drainID != "" && !r.heldSince.IsZero() {
		r.HeldTotal += time.Since(r.heldSince)
	}
	r.drainID, r.heldSince = "", time.Time{}
}

func (r *Runtime) drain(w http.ResponseWriter, req *http.Request) {
	body, _ := io.ReadAll(io.LimitReader(req.Body, 64*1024))
	dr, err := local.ParseDrainRequest(body) // strict contract validation of what the backup service sends
	if err != nil {
		http.Error(w, "bad drain request: "+err.Error(), http.StatusBadRequest)
		return
	}
	r.mu.Lock()
	if r.busy != "" {
		d := r.busy
		r.mu.Unlock()
		http.Error(w, d, http.StatusConflict)
		return
	}
	if r.activeLocked() && r.drainID != dr.RequestID {
		r.mu.Unlock()
		http.Error(w, "another drain is active", http.StatusConflict)
		return
	}
	r.DrainReqs++
	if r.drainID == "" {
		r.heldSince = time.Now()
	}
	r.drainID, r.scope = dr.RequestID, dr.Scope
	r.until = time.Now().Add(time.Duration(dr.LeaseMs) * time.Millisecond)
	r.reason = dr.Reason
	blockers := append([]runtimeadmin.Blocker{}, r.blockers...)
	if r.inFlight > 0 {
		blockers = append(blockers, runtimeadmin.Blocker{Kind: "other", ID: "tx", Description: "write transaction in flight", Since: time.Now()})
	}
	st := runtimeadmin.DrainStatus{V: 1, RequestID: dr.RequestID, Draining: true, Safe: len(blockers) == 0, Blockers: blockers}
	r.mu.Unlock()
	b, _ := json.Marshal(st)
	if _, err := local.ParseDrainStatus(b); err != nil {
		http.Error(w, "fake drain status fails the contract: "+err.Error(), http.StatusInternalServerError)
		return
	}
	_, _ = w.Write(b)
}

func (r *Runtime) resume(w http.ResponseWriter, req *http.Request) {
	var body struct {
		RequestID string `json:"requestId"`
	}
	_ = json.NewDecoder(req.Body).Decode(&body)
	r.mu.Lock()
	r.Resumes++
	if body.RequestID == r.drainID {
		r.releaseLocked()
	}
	r.mu.Unlock()
	r.cond.Broadcast()
	_, _ = w.Write([]byte(`{"v":1,"resumed":true}`))
}

// Counts returns (drain requests, resumes).
func (r *Runtime) Counts() (int, int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.DrainReqs, r.Resumes
}

// Holder returns the active drain's request id and reason ("" when none).
func (r *Runtime) Holder() (string, string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if !r.activeLocked() {
		return "", ""
	}
	return r.drainID, r.reason
}
