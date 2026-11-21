// Package fakeruntime is a test double of the runtime admin endpoint. It derives its behaviour
// from the fake activator's directory state: the active runtime profile names a fake artifact whose
// JSON says whether that runtime is healthy and which DB schema it writes/reads. The "database"
// schema version persists in a file, so kill/restart tests see migrations that already happened.
package fakeruntime

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/CybexBV/whombat/appliance/helper/helpertest"
	"github.com/CybexBV/whombat/appliance/release-tools/devtuf"
	"github.com/CybexBV/whombat/contracts/go/local"
	"github.com/CybexBV/whombat/contracts/go/protocol"
)

// Runtime is a fake runtime process + admin endpoint.
type Runtime struct {
	FakeRoot string // fake activator root
	DBDir    string // persistent fake DB state
	Now      func() time.Time

	mu              sync.Mutex
	blockers        []local.DrainBlocker
	blockerPolls    int // blockers clear after this many drain polls (-1 = never)
	drainID         string
	drainUntil      time.Time
	lastRestarts    int
	down            bool
	DrainCalls      int
	ResumeCalls     int
	ln              net.Listener
	srv             *http.Server
	RefusedStarts   int
	LastFacts       *local.FactsRequest
	LastClaimWindow *local.ClaimWindowRequest
	// LastClaimLookup is the lease the manager handed over (POST /claim-lookup, MG-28); ClaimLookups counts
	// the pushes. Unclaimed makes GET /facts answer claimed: false (default: a claimed runtime).
	LastClaimLookup *local.ClaimLookupLeaseRequest
	ClaimLookups    int
	Unclaimed       bool
	// Adapters is what GET /facts reports as clientAdapters (nil: not reported, a runtime before 0.9.0);
	// LastClients / ClientPushes record POST /clients (CT-73). NoClients makes POST /clients answer 404.
	Adapters     *local.RuntimeFactsClientAdapters
	LastClients  *local.ClientsPushRequest
	ClientPushes int
	NoClients    bool
	// POST /licence (LC-06, LC-07): LicenceKeys/LicenceDevice verify pushed tokens like the runtime (400 when one
	// doesn't, 409 stale for an older iat than the stored one). The stored token and high-water mark survive Crash
	// (the runtime keeps them in its database); LicencePushes counts accepted pushes. NoLicence answers 404 (a runtime
	// before 0.10.0).
	LicenceKeys    *protocol.LicenceKeySet
	LicenceDevice  string
	LicenceToken   string
	LicenceHW      string
	LicencePushes  int
	LicenceRefused int
	NoLicence      bool
}

// Licence returns the stored token, high-water mark and the number of accepted pushes.
func (r *Runtime) Licence() (token, highWater string, pushes int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.LicenceToken, r.LicenceHW, r.LicencePushes
}

// SetLicence configures the licence endpoint under the lock (keys nil: accept any well-formed push).
func (r *Runtime) SetLicence(f func(*Runtime)) {
	r.mu.Lock()
	defer r.mu.Unlock()
	f(r)
}

// adaptersOf is what GET /facts reports for a: Claude Code's level 1 when the test set none (required since contracts
// 1.0.0; Claude Code's alone since 3.0.0).
func adaptersOf(a *local.RuntimeFactsClientAdapters) local.RuntimeFactsClientAdapters {
	if a == nil {
		return local.RuntimeFactsClientAdapters{Claude: 1}
	}
	return *a
}

// SetAdapters sets the client adapter levels GET /facts reports.
func (r *Runtime) SetAdapters(a *local.RuntimeFactsClientAdapters) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.Adapters = a
}

// Clients returns the last client status pushed by the manager and how many pushes there were.
func (r *Runtime) Clients() (*local.ClientsPushRequest, int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.LastClients, r.ClientPushes
}

// ClaimLookup returns the last lease pushed by the manager and how many pushes there were.
func (r *Runtime) ClaimLookup() (*local.ClaimLookupLeaseRequest, int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.LastClaimLookup, r.ClaimLookups
}

// SetUnclaimed sets what GET /facts reports as the claim state.
func (r *Runtime) SetUnclaimed(u bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.Unclaimed = u
}

// Facts returns the last facts pushed by the manager.
func (r *Runtime) Facts() *local.FactsRequest {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.LastFacts
}

// SetBlockers sets acknowledged work; it clears after polls drain polls (-1 = never).
func (r *Runtime) SetBlockers(b []local.DrainBlocker, polls int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.blockers, r.blockerPolls = b, polls
}

// SetDown simulates the runtime process being stopped.
func (r *Runtime) SetDown(down bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.down = down
}

// Down reports whether the fake process is stopped.
func (r *Runtime) Down() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.down
}

// ClaimWindow returns the last claim window pushed by the manager.
func (r *Runtime) ClaimWindow() *local.ClaimWindowRequest {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.LastClaimWindow
}

// ForgetFacts drops what the manager handed over, like a runtime process that restarted between two
// probes (facts and claim window live in the runtime's memory).
func (r *Runtime) ForgetFacts() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.LastFacts, r.LastClaimWindow, r.LastClaimLookup, r.LastClients = nil, nil, nil, nil
}

// Crash stops serving and drops in-memory state (facts, claim window, drain); Start brings it back.
func (r *Runtime) Crash() {
	r.Close()
	r.ForgetFacts()
	r.Restarted()
}

// Restarted simulates a process restart (e.g. after a reboot): in-memory drain state is lost.
func (r *Runtime) Restarted() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.drainID = ""
	r.blockers = nil
}

// Calls reports how many drain and resume requests the runtime answered.
func (r *Runtime) Calls() (drains, resumes int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.DrainCalls, r.ResumeCalls
}

// Draining reports whether new turns are currently refused.
func (r *Runtime) Draining() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.syncRestart()
	return r.drainID != "" && r.now().Before(r.drainUntil)
}

func (r *Runtime) now() time.Time {
	if r.Now != nil {
		return r.Now()
	}
	return time.Now()
}

func (r *Runtime) restarts() int {
	b, _ := os.ReadFile(filepath.Join(r.FakeRoot, "runtime-restarts"))
	n, _ := strconv.Atoi(strings.TrimSpace(string(b)))
	return n
}

// syncRestart clears in-memory drain state when the runtime was restarted by the helper, and
// runs the "migration" of a newly started runtime.
func (r *Runtime) syncRestart() {
	if n := r.restarts(); n != r.lastRestarts {
		r.lastRestarts = n
		r.drainID = ""
		r.blockers = nil
	}
}

func (r *Runtime) active() *devtuf.FakeArtifact {
	target, err := os.Readlink(filepath.Join(r.FakeRoot, "profiles", "whombat-runtime"))
	if err != nil {
		return nil
	}
	b, err := os.ReadFile(filepath.Join(r.FakeRoot, "store", filepath.Base(target)))
	if err != nil {
		return nil
	}
	var a devtuf.FakeArtifact
	if json.Unmarshal(b, &a) != nil {
		return nil
	}
	return &a
}

// Schema returns the fake database schema version.
func (r *Runtime) Schema() int {
	b, _ := os.ReadFile(filepath.Join(r.DBDir, "schema"))
	n, _ := strconv.Atoi(strings.TrimSpace(string(b)))
	return n
}

func (r *Runtime) setSchema(n int) {
	_ = os.MkdirAll(r.DBDir, 0o755)
	_ = os.WriteFile(filepath.Join(r.DBDir, "schema"), []byte(strconv.Itoa(n)), 0o644)
}

// SetSchema sets the fake DB schema (fixture setup).
func (r *Runtime) SetSchema(n int) { r.setSchema(n) }

// Start serves the admin API on socket.
func (r *Runtime) Start(socket string) error {
	r.lastRestarts = r.restarts()
	_ = os.Remove(socket)
	ln, err := net.Listen("unix", socket)
	if err != nil {
		return err
	}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /drain", r.handleDrain)
	mux.HandleFunc("POST /resume", r.handleResume)
	mux.HandleFunc("GET /health", r.handleHealth)
	mux.HandleFunc("POST /facts", func(w http.ResponseWriter, req *http.Request) {
		body, _ := io.ReadAll(req.Body)
		f, err := local.ParseFactsRequest(body)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, local.LocalError{Error: local.LocalErrorError{Code: "bad_request", Message: err.Error()}})
			return
		}
		r.mu.Lock()
		r.LastFacts = f
		r.mu.Unlock()
		writeJSON(w, http.StatusOK, local.AdminOk{V: 1, Ok: true})
	})
	mux.HandleFunc("GET /facts", func(w http.ResponseWriter, req *http.Request) {
		r.mu.Lock()
		f := local.RuntimeFacts{V: 1, ActiveSessions: 2, Claimed: !r.Unclaimed, ClaimReported: !r.Unclaimed,
			Recovery: local.RuntimeFactsRecovery{Enrolled: true, KitVerified: false}, Draining: r.drainID != "" && r.now().Before(r.drainUntil), Relay: "connected",
			ClientAdapters: adaptersOf(r.Adapters)}
		r.mu.Unlock()
		writeJSON(w, http.StatusOK, f)
	})
	mux.HandleFunc("POST /clients", func(w http.ResponseWriter, req *http.Request) {
		body, _ := io.ReadAll(req.Body)
		r.mu.Lock()
		defer r.mu.Unlock()
		if r.NoClients {
			writeJSON(w, http.StatusNotFound, local.LocalError{Error: local.LocalErrorError{Code: "not_found", Message: "no such endpoint"}})
			return
		}
		c, err := local.ParseClientsPushRequest(body)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, local.LocalError{Error: local.LocalErrorError{Code: "bad_request", Message: err.Error()}})
			return
		}
		r.LastClients = c
		r.ClientPushes++
		writeJSON(w, http.StatusOK, local.AdminOk{V: 1, Ok: true})
	})
	mux.HandleFunc("POST /licence", r.handleLicence)
	mux.HandleFunc("POST /claim-lookup", func(w http.ResponseWriter, req *http.Request) {
		body, _ := io.ReadAll(req.Body)
		c, err := local.ParseClaimLookupLeaseRequest(body)
		if err != nil || !local.ClaimLookupLeaseValid(*c) {
			writeJSON(w, http.StatusBadRequest, local.LocalError{Error: local.LocalErrorError{Code: "bad_request", Message: fmt.Sprint(err)}})
			return
		}
		r.mu.Lock()
		r.LastClaimLookup = c
		r.ClaimLookups++
		r.mu.Unlock()
		writeJSON(w, http.StatusOK, local.AdminOk{V: 1, Ok: true})
	})
	mux.HandleFunc("POST /claim-window", func(w http.ResponseWriter, req *http.Request) {
		body, _ := io.ReadAll(req.Body)
		c, err := local.ParseClaimWindowRequest(body)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, local.LocalError{Error: local.LocalErrorError{Code: "bad_request", Message: err.Error()}})
			return
		}
		r.mu.Lock()
		r.LastClaimWindow = c
		r.mu.Unlock()
		writeJSON(w, http.StatusOK, local.AdminOk{V: 1, Ok: true})
	})
	r.ln = ln
	r.srv = &http.Server{Handler: mux}
	go r.srv.Serve(ln)
	return nil
}

// Close stops serving.
func (r *Runtime) Close() {
	if r.srv != nil {
		r.srv.Close()
	}
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func (r *Runtime) handleDrain(w http.ResponseWriter, req *http.Request) {
	body, _ := io.ReadAll(req.Body)
	dr, err := local.ParseDrainRequest(body)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, local.LocalError{Error: local.LocalErrorError{Code: "bad_request", Message: "invalid drain request"}})
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.down {
		http.Error(w, "down", http.StatusServiceUnavailable)
		return
	}
	r.syncRestart()
	if r.drainID != "" && r.drainID != dr.RequestID && r.now().Before(r.drainUntil) {
		writeJSON(w, http.StatusConflict, local.LocalError{Error: local.LocalErrorError{Code: "busy", Message: "another drain holds the runtime"}})
		return
	}
	r.DrainCalls++
	r.drainID = dr.RequestID
	r.drainUntil = r.now().Add(time.Duration(dr.LeaseMs) * time.Millisecond)
	if r.blockerPolls > 0 {
		r.blockerPolls--
		if r.blockerPolls == 0 {
			r.blockers = nil
		}
	}
	st := local.DrainStatus{V: 1, RequestID: dr.RequestID, Draining: true, Safe: len(r.blockers) == 0, Blockers: r.blockers}
	if st.Blockers == nil {
		st.Blockers = []local.DrainBlocker{}
	}
	writeJSON(w, http.StatusOK, st)
}

// HoldDrain makes another caller (e.g. the backup service) hold a drain until the lease ends.
func (r *Runtime) HoldDrain(requestID string, lease time.Duration) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.drainID, r.drainUntil = requestID, r.now().Add(lease)
}

func (r *Runtime) handleResume(w http.ResponseWriter, req *http.Request) {
	var rr local.ResumeRequest
	_ = json.NewDecoder(req.Body).Decode(&rr)
	r.mu.Lock()
	defer r.mu.Unlock()
	r.ResumeCalls++
	if rr.RequestID == "" || rr.RequestID == r.drainID {
		r.drainID = ""
	}
	writeJSON(w, http.StatusOK, local.ResumeResponse{V: 1, RequestID: rr.RequestID, Draining: r.drainID != ""})
}

func str(s string) *string { return &s }

func (r *Runtime) handleHealth(w http.ResponseWriter, req *http.Request) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.down {
		http.Error(w, "down", http.StatusServiceUnavailable)
		return
	}
	r.syncRestart()
	schema := r.Schema()
	down := local.ExternalStateDown
	h := local.RuntimeHealth{V: 1, ReleaseID: "unknown", Draining: r.drainID != "" && r.now().Before(r.drainUntil),
		External: &local.RuntimeHealthExternal{Relay: &down, Control: &down}}
	h.Checks.Db = local.HealthCheck{Ok: true}
	h.Checks.SessionEndpoint = local.HealthCheck{Ok: true}
	h.Checks.Migrations = local.MigrationsCheck{SchemaVersion: int64(schema), Access: "none"}
	target, err := os.Readlink(filepath.Join(r.FakeRoot, "profiles", "whombat-runtime"))
	content, cerr := os.ReadFile(filepath.Join(r.FakeRoot, "store", filepath.Base(target)))
	a := r.active()
	if err != nil || cerr != nil || a == nil {
		h.Status = "starting"
	} else {
		// Managed mode: the server boot only validates the schema (MD-07); it never migrates.
		v := helpertest.FakeSchemaVerdictIn(content, int64(schema), r.DBDir)
		h.Version = a.Version
		h.Checks.Migrations.Access, h.Checks.Migrations.Verdict = v.Access, str(v.Verdict)
		h.Checks.Migrations.Compatible = v.Access != "none"
		h.Checks.Migrations.Ok = v.Access == "read-write"
		h.Status = "ok"
		if v.Access == "none" {
			h.Status = "degraded"
			h.Checks.Migrations.Detail = str(v.Verdict + ": " + v.Reason)
		}
		if a.RuntimeHealth == "bad" {
			h.Status = "degraded"
			h.Checks.SessionEndpoint = local.HealthCheck{Ok: false, Detail: str("session endpoint failed to start")}
		}
	}
	if err := h.Validate(); err != nil {
		writeJSON(w, http.StatusInternalServerError, local.LocalError{Error: local.LocalErrorError{Code: "internal", Message: err.Error()}})
		return
	}
	code := http.StatusOK
	if h.Status != "ok" {
		code = http.StatusServiceUnavailable
	}
	writeJSON(w, code, h)
}

// ActiveVersion returns the version of the active fake runtime ("" if none).
func (r *Runtime) ActiveVersion() string {
	if a := r.active(); a != nil {
		return a.Version
	}
	return ""
}

func (r *Runtime) handleLicence(w http.ResponseWriter, req *http.Request) {
	body, _ := io.ReadAll(req.Body)
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.NoLicence {
		writeJSON(w, http.StatusNotFound, local.LocalError{Error: local.LocalErrorError{Code: "not_found", Message: "no such endpoint"}})
		return
	}
	p, err := local.ParseLicencePushRequest(body)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, local.LocalError{Error: local.LocalErrorError{Code: "bad_request", Message: err.Error()}})
		return
	}
	hw, err := time.Parse(time.RFC3339, p.HighWater)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, local.LocalError{Error: local.LocalErrorError{Code: "bad_request", Message: err.Error()}})
		return
	}
	verify := func(tok string) (*protocol.LicenceClaims, error) {
		if r.LicenceKeys == nil {
			return &protocol.LicenceClaims{}, nil
		}
		_, c, err := protocol.VerifyLicenceToken(tok, protocol.VerifyLicenceOptions{KeySet: *r.LicenceKeys, Device: r.LicenceDevice,
			Now: max(r.now().Unix(), hw.Unix())})
		return c, err
	}
	if p.Token != nil {
		c, err := verify(*p.Token)
		if err != nil {
			r.LicenceRefused++
			writeJSON(w, http.StatusBadRequest, local.LocalError{Error: local.LocalErrorError{Code: "bad_request", Message: err.Error()}})
			return
		}
		if r.LicenceToken != "" {
			if old, err := verify(r.LicenceToken); err == nil && c.Iat < old.Iat {
				r.LicenceRefused++
				writeJSON(w, http.StatusConflict, local.LocalError{Error: local.LocalErrorError{Code: "stale", Message: "older than the stored token"}})
				return
			}
		}
		r.LicenceToken = *p.Token
	}
	r.LicenceHW = p.HighWater
	r.LicencePushes++
	var st *local.LocalLicenceStatus
	if r.LicenceKeys != nil && r.LicenceToken != "" {
		c, _ := verify(r.LicenceToken)
		res := protocol.LicenceStatus(protocol.LicenceStatusParams{Claims: c, Now: r.now().Unix(), HighWater: hw.Unix()})
		ts := func(v *int64) *string {
			if v == nil {
				return nil
			}
			s := time.Unix(*v, 0).UTC().Format(time.RFC3339)
			return &s
		}
		st = &local.LocalLicenceStatus{State: res.State, Reason: res.Reason, Plan: res.Plan, ExpiresAt: ts(res.ExpiresAt),
			GraceEndsAt: ts(res.GraceEndsAt), EffectiveAt: time.Unix(res.EffectiveAt, 0).UTC().Format(time.RFC3339)}
	}
	writeJSON(w, http.StatusOK, local.LicencePushResponse{V: 1, Licence: st})
}
