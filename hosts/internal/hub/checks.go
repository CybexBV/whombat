package hub

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"rackoon/internal/checks"
	"rackoon/internal/hub/store"
	"rackoon/internal/proto"
	"rackoon/internal/rules"
)

// Checks: availability probes (HTTP, TCP, ping, DNS) run by the hub or by
// an agent on its own network, and heartbeat checks that a cron job or a
// backup script pings. A probe that fails twice in a row, or a heartbeat
// that is overdue, opens check.down; a certificate close to expiry opens
// check.cert_expiring. Results feed two series per check: up (1/0) and
// latency_ms, so uptime is the average of up.

const (
	RuleCheckDown = "check.down"
	RuleCheckCert = "check.cert_expiring"
)

// checkState is a check's latest result and how long its state holds.
type checkState struct {
	Result proto.CheckResult `json:"result"`
	Fails  int               `json:"fails"` // consecutive failures
	// Heartbeat checks.
	LastPing *time.Time `json:"last_ping,omitempty"` // last successful ping
	Started  *time.Time `json:"started,omitempty"`   // the job said it started
	since    time.Time
}

type checkSet struct {
	mu     sync.RWMutex
	list   []store.Check
	state  map[string]*checkState
	runner *checks.Runner
}

func (h *Hub) loadChecks(ctx context.Context) error {
	list, err := h.store.ListChecks(ctx)
	if err != nil {
		return err
	}
	res, since, err := h.store.CheckStates(ctx)
	if err != nil {
		return err
	}
	h.checks.mu.Lock()
	defer h.checks.mu.Unlock()
	h.checks.list = list
	if h.checks.state == nil {
		h.checks.state = map[string]*checkState{}
	}
	for id, b := range res {
		var st checkState
		if json.Unmarshal(b, &st) == nil {
			st.since = since[id]
			h.checks.state[id] = &st
		}
	}
	return nil
}

func specOf(c store.Check) proto.CheckSpec {
	o := c.Options
	return proto.CheckSpec{ID: c.ID, Kind: c.Kind, Target: c.Target, IntervalS: c.IntervalS, TimeoutS: c.TimeoutS,
		ExpectStatus: o.ExpectStatus, Keyword: o.Keyword, TLS: o.TLS, InsecureTLS: o.InsecureTLS, DNSType: o.DNSType,
		DNSServer: o.DNSServer, Expect: o.Expect}
}

// specsFor returns the probe specs a runner ("hub" or a server id) runs.
func (h *Hub) specsFor(runner string) []proto.CheckSpec {
	h.checks.mu.RLock()
	defer h.checks.mu.RUnlock()
	var out []proto.CheckSpec
	for _, c := range h.checks.list {
		if c.Enabled && c.Runner == runner && c.Kind != store.CheckHeartbeat {
			out = append(out, specOf(c))
		}
	}
	return out
}

// checksChanged pushes the new sets to the hub's runner and the agents.
func (h *Hub) checksChanged() {
	if h.checks.runner != nil {
		h.checks.runner.SetSpecs(h.specsFor("hub"))
	}
	h.mu.RLock()
	var conns []*AgentConn
	for _, s := range h.servers {
		if s.conn != nil {
			conns = append(conns, s.conn)
		}
	}
	h.mu.RUnlock()
	for _, c := range conns {
		h.sendChecks(c)
	}
	h.bus.Publish("checks.changed", map[string]any{})
}

// sendChecks gives an agent its checks (after HelloAck and on changes).
func (h *Hub) sendChecks(c *AgentConn) {
	if err := c.send(proto.MsgChecks, proto.CheckSpecs{Checks: h.specsFor(c.ServerID)}); err != nil {
		h.log.Debug("checks not sent", "server", c.ServerID, "err", err)
	}
}

// runChecks drives the hub's own probes and the bookkeeping of all checks.
func (h *Hub) runChecks(ctx context.Context) {
	h.checks.runner = checks.NewRunner()
	h.checks.runner.SetSpecs(h.specsFor("hub"))
	go h.checks.runner.Run(ctx)
	t := time.NewTicker(5 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			for _, r := range h.checks.runner.Results() {
				h.checkResult(ctx, "hub", r)
			}
			h.heartbeatChecks(ctx)
			h.evaluateCheckAlerts(ctx)
		}
	}
}

func (h *Hub) checkByID(id string) (store.Check, bool) {
	h.checks.mu.RLock()
	defer h.checks.mu.RUnlock()
	for _, c := range h.checks.list {
		if c.ID == id {
			return c, true
		}
	}
	return store.Check{}, false
}

// checkResult records a result from a runner ("hub" or the server whose
// report carried it). Results for checks the runner does not own are
// ignored; repeated results (same time) are recorded once.
func (h *Hub) checkResult(ctx context.Context, runner string, r proto.CheckResult) {
	c, ok := h.checkByID(r.ID)
	if !ok || c.Runner != runner || c.Kind == store.CheckHeartbeat || !c.Enabled {
		return
	}
	r.Error = cleanText(r.Error, 300)
	if len(r.Answer) > 8 {
		r.Answer = r.Answer[:8]
	}
	for i, a := range r.Answer {
		r.Answer[i] = cleanText(a, 200)
	}
	if r.LatencyMs != nil && (*r.LatencyMs < 0 || *r.LatencyMs > 3600e3 || *r.LatencyMs != *r.LatencyMs) {
		r.LatencyMs = nil
	}
	if now := h.now(); r.At.IsZero() || r.At.After(now.Add(time.Minute)) {
		r.At = now // the runner's clock is off
	}
	h.recordCheck(ctx, c, r, nil)
}

func (h *Hub) recordCheck(ctx context.Context, c store.Check, r proto.CheckResult, mutate func(*checkState)) {
	h.checks.mu.Lock()
	st := h.checks.state[c.ID]
	if st == nil {
		st = &checkState{}
		h.checks.state[c.ID] = st
	}
	if !r.At.IsZero() && !st.Result.At.IsZero() && !r.At.After(st.Result.At) && mutate == nil {
		h.checks.mu.Unlock()
		return
	}
	wasOK, had := st.Result.OK, !st.Result.At.IsZero()
	st.Result = r
	if r.OK {
		st.Fails = 0
	} else {
		st.Fails++
	}
	if !had || wasOK != r.OK {
		st.since = r.At
	}
	if mutate != nil {
		mutate(st)
	}
	b, _ := json.Marshal(st)
	since := st.since
	h.checks.mu.Unlock()
	if err := h.store.SaveCheckState(ctx, c.ID, b, since); err != nil {
		h.log.Error("check state", "check", c.ID, "err", err)
	}
	vals := map[string]float64{"up": 0}
	if r.OK {
		vals["up"] = 1
	}
	if r.LatencyMs != nil {
		vals["latency_ms"] = *r.LatencyMs
	}
	if _, _, err := h.store.InsertSamples(ctx, store.CheckSeriesOwner(c.ID), []store.Sample{{TS: r.At.Unix(), Values: vals}}); err != nil {
		h.log.Error("check sample", "check", c.ID, "err", err)
	}
	if !had || wasOK != r.OK {
		h.bus.Publish("checks.changed", map[string]any{"id": c.ID})
	}
}

// heartbeatChecks records a failure for heartbeats that are overdue: no
// ping within the period plus the grace time (counted from the check's
// creation until the first ping). An overdue check records at most one
// result a minute.
func (h *Hub) heartbeatChecks(ctx context.Context) {
	now := h.now()
	type due struct {
		c   store.Check
		msg string
	}
	var list []due
	h.checks.mu.RLock()
	for _, c := range h.checks.list {
		if c.Kind != store.CheckHeartbeat || !c.Enabled {
			continue
		}
		st := h.checks.state[c.ID]
		last, msg := c.CreatedAt, "No ping since the check was created"
		if st != nil && st.LastPing != nil {
			last, msg = *st.LastPing, "No ping for "+rules.FormatDuration(now.Sub(*st.LastPing))
		}
		if now.Sub(last) <= time.Duration(c.IntervalS+c.GraceS)*time.Second {
			continue
		}
		if st != nil && !st.Result.At.IsZero() && !st.Result.OK && now.Sub(st.Result.At) < time.Minute {
			continue
		}
		list = append(list, due{c, msg})
	}
	h.checks.mu.RUnlock()
	for _, d := range list {
		h.recordCheck(ctx, d.c, proto.CheckResult{ID: d.c.ID, At: now, Error: d.msg}, nil)
	}
}

// evaluateCheckAlerts turns the check states into alerts (hub-level).
func (h *Hub) evaluateCheckAlerts(ctx context.Context) {
	now := h.now()
	var conds []rules.Condition
	h.checks.mu.RLock()
	for _, c := range h.checks.list {
		st := h.checks.state[c.ID]
		if !c.Enabled || st == nil || st.Result.At.IsZero() {
			continue
		}
		name, ent := c.Name, "check:"+c.ID
		r := st.Result
		failing := !r.OK && (st.Fails >= 2 || c.Kind == store.CheckHeartbeat)
		if failing {
			since := st.since
			detail := r.Error
			if detail == "" {
				detail = "The check failed"
			}
			conds = append(conds, rules.Condition{Rule: RuleCheckDown, Entity: ent, Severity: rules.SevCritical, Since: since,
				StatusNote: "check down", Link: "/settings/checks",
				Render: func(time.Duration) rules.Text {
					return rules.Text{Title: name + " is down", Detail: detail, BannerTitle: name + " is down", BannerDetail: detail + "."}
				}})
		}
		warn := c.Options.CertWarnDays
		if warn == 0 {
			warn = 14
		}
		if r.CertNotAfter != nil && r.OK {
			left := r.CertNotAfter.Sub(now)
			if left < time.Duration(warn)*24*time.Hour {
				days := int(left.Hours() / 24)
				exp := r.CertNotAfter.UTC().Format("Jan 2")
				conds = append(conds, rules.Condition{Rule: RuleCheckCert, Entity: ent, Severity: rules.SevWarning, ClearAfter: time.Hour,
					StatusNote: "certificate", Link: "/settings/checks",
					Render: func(time.Duration) rules.Text {
						t := fmt.Sprintf("Certificate of %s expires in %d days", name, days)
						return rules.Text{Title: t, Detail: "Valid until " + exp, BannerTitle: t, BannerDetail: "Valid until " + exp + "."}
					}})
			}
		}
	}
	h.checks.mu.RUnlock()
	h.applyAlerts(ctx, h.alerts.Evaluate("", conds, func(r string) bool { return strings.HasPrefix(r, "check.") }, now))
}

// ---- heartbeat pings --------------------------------------------------------------

// servePing is GET|POST /ping/{token}[/start|/fail|/<exit code>]: a cron job
// reports in (Healthchecks-style). No session: the token is the credential.
func (h *Hub) servePing(w http.ResponseWriter, r *http.Request) {
	token, what := r.PathValue("token"), r.PathValue("what")
	if r.Method != http.MethodGet && r.Method != http.MethodPost && r.Method != http.MethodHead {
		http.Error(w, "use GET or POST", http.StatusMethodNotAllowed)
		return
	}
	if !h.limits.pings.take(clientIP(r)) {
		http.Error(w, "too many pings", http.StatusTooManyRequests)
		return
	}
	var c store.Check
	found := false
	h.checks.mu.RLock()
	for _, x := range h.checks.list {
		if x.Kind == store.CheckHeartbeat && len(x.Token) >= 16 && subtle.ConstantTimeCompare([]byte(x.Token), []byte(token)) == 1 {
			c, found = x, true
		}
	}
	h.checks.mu.RUnlock()
	if !found {
		http.Error(w, "unknown check", http.StatusNotFound)
		return
	}
	if !c.Enabled {
		fmt.Fprintln(w, "paused")
		return
	}
	now := h.now()
	ok, msg := true, ""
	switch what {
	case "", "success", "0":
	case "start":
		h.checks.mu.Lock()
		if st := h.checks.state[c.ID]; st != nil {
			st.Started = &now
		} else {
			h.checks.state[c.ID] = &checkState{Started: &now}
		}
		h.checks.mu.Unlock()
		fmt.Fprintln(w, "ok")
		return
	case "fail":
		ok, msg = false, "The job reported a failure"
	default:
		code, err := strconv.Atoi(what)
		if err != nil || code < 0 || code > 255 {
			http.Error(w, "unknown ping", http.StatusNotFound)
			return
		}
		ok, msg = false, fmt.Sprintf("The job exited with code %d", code)
	}
	res := proto.CheckResult{ID: c.ID, At: now, OK: ok, Error: msg}
	h.checks.mu.RLock()
	started := (*time.Time)(nil)
	if st := h.checks.state[c.ID]; st != nil && st.Started != nil {
		started = st.Started
	}
	h.checks.mu.RUnlock()
	if started != nil {
		d := float64(now.Sub(*started).Milliseconds())
		res.LatencyMs = &d // the job's run time
	}
	h.recordCheck(r.Context(), c, res, func(st *checkState) {
		if ok {
			st.LastPing = &now
		}
		st.Started = nil
	})
	fmt.Fprintln(w, "ok")
}

// ---- API --------------------------------------------------------------------------

type checkJSON struct {
	ID         string             `json:"id"`
	Name       string             `json:"name"`
	Kind       string             `json:"kind"`
	Target     string             `json:"target"`
	Runner     string             `json:"runner"`
	IntervalS  int                `json:"interval_s"`
	TimeoutS   int                `json:"timeout_s"`
	GraceS     int                `json:"grace_s"`
	Options    store.CheckOptions `json:"options"`
	Enabled    bool               `json:"enabled"`
	Status     string             `json:"status"` // up | down | pending | disabled
	Since      *string            `json:"since"`
	Last       *checkResultJSON   `json:"last"`
	LastPing   *string            `json:"last_ping"`
	Uptime24h  *float64           `json:"uptime_24h"`
	Latency24h []*float64         `json:"latency_24h"`
	PingURL    *string            `json:"ping_url"` // heartbeat checks, admins only
	CreatedBy  string             `json:"created_by"`
}

type checkResultJSON struct {
	At           string   `json:"at"`
	OK           bool     `json:"ok"`
	LatencyMs    *float64 `json:"latency_ms"`
	Error        string   `json:"error,omitempty"`
	StatusCode   int      `json:"status_code,omitempty"`
	CertNotAfter *string  `json:"cert_not_after,omitempty"`
	Answer       []string `json:"answer,omitempty"`
}

func (h *Hub) checkJSONOf(ctx context.Context, c store.Check, admin bool, withSeries bool) checkJSON {
	out := checkJSON{ID: c.ID, Name: c.Name, Kind: c.Kind, Target: c.Target, Runner: c.Runner, IntervalS: c.IntervalS,
		TimeoutS: c.TimeoutS, GraceS: c.GraceS, Options: c.Options, Enabled: c.Enabled, Status: "pending", CreatedBy: c.CreatedBy,
		Latency24h: []*float64{}}
	h.checks.mu.RLock()
	if st := h.checks.state[c.ID]; st != nil && !st.Result.At.IsZero() {
		r := st.Result
		out.Last = &checkResultJSON{At: r.At.UTC().Format(time.RFC3339), OK: r.OK, LatencyMs: r.LatencyMs, Error: r.Error,
			StatusCode: r.StatusCode, Answer: r.Answer}
		if r.CertNotAfter != nil {
			out.Last.CertNotAfter = tsp(*r.CertNotAfter)
		}
		out.Since = tsp(st.since)
		switch {
		case r.OK:
			out.Status = "up"
		case st.Fails >= 2 || c.Kind == store.CheckHeartbeat:
			out.Status = "down"
		}
		if st.LastPing != nil {
			out.LastPing = tsp(*st.LastPing)
		}
	}
	h.checks.mu.RUnlock()
	if !c.Enabled {
		out.Status = "disabled"
	}
	if admin && c.Kind == store.CheckHeartbeat && c.Token != "" {
		u := h.cfg.PublicURL
		if h.cfg.Headless {
			// Hosts ping the agent listener (its certificate is from the
			// hub's CA: curl -k, or --pinnedpubkey with GET /hub's tls_pin).
			u, _ = h.agentInstallBase()
		}
		if u == "" {
			u = "<hub>"
		}
		out.PingURL = sp(u + "/ping/" + c.Token)
	}
	if withSeries {
		if res, err := h.store.QueryMetrics(ctx, store.CheckSeriesOwner(c.ID), []string{"up", "latency_ms"}, store.Ranges["24h"], h.now()); err == nil {
			if s := res.Summary["up"]; s != nil {
				v := float64(int(s.Avg*1000+0.5)) / 10
				out.Uptime24h = &v
			}
			if l := res.Series["latency_ms"]; l != nil {
				out.Latency24h = l
			}
		}
	}
	return out
}

func (h *Hub) apiChecks(w http.ResponseWriter, r *http.Request, p *principal) error {
	h.checks.mu.RLock()
	list := append([]store.Check(nil), h.checks.list...)
	h.checks.mu.RUnlock()
	out := []checkJSON{}
	isAdmin := p.rank() >= store.RoleRank(admin)
	for _, c := range list {
		out = append(out, h.checkJSONOf(r.Context(), c, isAdmin, true))
	}
	writeJSON(w, r, http.StatusOK, out)
	return nil
}

type checkReq struct {
	Name      *string             `json:"name"`
	Kind      *string             `json:"kind"`
	Target    *string             `json:"target"`
	Runner    *string             `json:"runner"`
	IntervalS *int                `json:"interval_s"`
	TimeoutS  *int                `json:"timeout_s"`
	GraceS    *int                `json:"grace_s"`
	Options   *store.CheckOptions `json:"options"`
	Enabled   *bool               `json:"enabled"`
}

func (h *Hub) applyCheck(c *store.Check, req checkReq) error {
	if req.Name != nil {
		c.Name = cleanText(*req.Name, 80)
	}
	if req.Kind != nil {
		c.Kind = *req.Kind
	}
	if req.Target != nil {
		c.Target = strings.TrimSpace(*req.Target)
	}
	if req.Runner != nil {
		c.Runner = *req.Runner
	}
	if req.IntervalS != nil {
		c.IntervalS = *req.IntervalS
	}
	if req.TimeoutS != nil {
		c.TimeoutS = *req.TimeoutS
	}
	if req.GraceS != nil {
		c.GraceS = *req.GraceS
	}
	if req.Options != nil {
		c.Options = *req.Options
	}
	if req.Enabled != nil {
		c.Enabled = *req.Enabled
	}
	if c.Name == "" {
		return apiErr(http.StatusBadRequest, "invalid_name", "Give the check a name.")
	}
	if c.Options.CertWarnDays < 0 || c.Options.CertWarnDays > 365 {
		return apiErr(http.StatusBadRequest, "invalid_option", "cert_warn_days must be 0 to 365.")
	}
	if c.Kind == store.CheckHeartbeat {
		c.Runner, c.Target = "hub", ""
		if c.IntervalS < 60 || c.IntervalS > 31*24*3600 {
			return apiErr(http.StatusBadRequest, "invalid_interval", "A heartbeat period is 1 minute to 31 days.")
		}
		if c.GraceS < 0 || c.GraceS > 7*24*3600 {
			return apiErr(http.StatusBadRequest, "invalid_grace", "The grace time is up to 7 days.")
		}
		if c.Token == "" {
			c.Token = randToken(18)
		}
		return nil
	}
	if c.Runner == "" {
		c.Runner = "hub"
	}
	if c.Runner != "hub" {
		if _, ok := h.snapshotOne(c.Runner); !ok {
			return apiErr(http.StatusBadRequest, "invalid_runner", "No server "+c.Runner+" to run the check from.")
		}
	}
	if c.TimeoutS == 0 {
		c.TimeoutS = 10
	}
	if c.IntervalS == 0 {
		c.IntervalS = 60
	}
	if err := checks.Validate(specOf(*c)); err != nil {
		return apiErr(http.StatusBadRequest, "invalid_check", err.Error())
	}
	return nil
}

func (h *Hub) apiCreateCheck(w http.ResponseWriter, r *http.Request, p *principal) error {
	var req checkReq
	if err := decodeJSON(r, &req); err != nil {
		return err
	}
	c := store.Check{ID: newID("ck_"), Enabled: true, CreatedBy: p.user.Username, CreatedAt: h.now()}
	if err := h.applyCheck(&c, req); err != nil {
		return err
	}
	if err := h.store.PutCheck(r.Context(), c); err != nil {
		return err
	}
	if err := h.loadChecks(r.Context()); err != nil {
		return err
	}
	h.checksChanged()
	h.auditReq(r, p, store.AuditRecord{Event: "check.created", Outcome: "ok", Details: map[string]string{"check_id": c.ID, "name": c.Name, "kind": c.Kind}})
	writeJSON(w, r, http.StatusCreated, h.checkJSONOf(r.Context(), c, true, false))
	return nil
}

func (h *Hub) apiPatchCheck(w http.ResponseWriter, r *http.Request, p *principal) error {
	c, ok := h.checkByID(r.PathValue("id"))
	if !ok {
		return errNotFound
	}
	var req checkReq
	if err := decodeJSON(r, &req); err != nil {
		return err
	}
	if err := h.applyCheck(&c, req); err != nil {
		return err
	}
	if err := h.store.PutCheck(r.Context(), c); err != nil {
		return err
	}
	if err := h.loadChecks(r.Context()); err != nil {
		return err
	}
	h.checksChanged()
	h.auditReq(r, p, store.AuditRecord{Event: "check.updated", Outcome: "ok", Details: map[string]string{"check_id": c.ID, "name": c.Name}})
	writeJSON(w, r, http.StatusOK, h.checkJSONOf(r.Context(), c, true, false))
	return nil
}

func (h *Hub) apiDeleteCheck(w http.ResponseWriter, r *http.Request, p *principal) error {
	id := r.PathValue("id")
	c, ok := h.checkByID(id)
	if !ok {
		return errNotFound
	}
	if err := h.store.DeleteCheck(r.Context(), id); err != nil && !errors.Is(err, store.ErrNotFound) {
		return err
	}
	h.checks.mu.Lock()
	delete(h.checks.state, id)
	h.checks.mu.Unlock()
	if err := h.loadChecks(r.Context()); err != nil {
		return err
	}
	h.checksChanged()
	h.evaluateCheckAlerts(r.Context()) // resolves its alerts
	h.auditReq(r, p, store.AuditRecord{Event: "check.deleted", Outcome: "ok", Details: map[string]string{"check_id": id, "name": c.Name}})
	w.WriteHeader(http.StatusNoContent)
	return nil
}
