package hub

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"
	"unicode/utf8"

	"rackoon/internal/assist"
	"rackoon/internal/hub/model"
	"rackoon/internal/hub/store"
	"rackoon/internal/rules"
)

// ---- investigations ------------------------------------------------------------------

// liveInv is an investigation the hub has touched since it started: its
// row and what only lives in memory (the CLI session, approvals).
type liveInv struct {
	row       store.AssistSession
	run       string // the CLI run whose events count
	session   bool   // a CLI session runs in the runner
	turn      bool   // the CLI is working on a turn
	finishing bool   // finish was called in this turn
	stopping  bool
	approvals map[string]*approval
}

// approval is a change waiting for the admin (access "ask").
type approval struct {
	id     string
	toolID string
	done   chan approvalDecision
}

type approvalDecision struct {
	Approve bool
	Reply   string
	By      string
	Expired bool
}

// inv returns the live investigation, loading it from the database.
func (a *assistant) inv(ctx context.Context, id string) (*liveInv, error) {
	a.mu.Lock()
	inv := a.invs[id]
	a.mu.Unlock()
	if inv != nil {
		return inv, nil
	}
	row, err := a.h.store.GetAssistSession(ctx, id)
	if err != nil {
		return nil, err
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if inv = a.invs[id]; inv == nil {
		inv = &liveInv{row: row, approvals: map[string]*approval{}}
		a.invs[id] = inv
	}
	return inv, nil
}

// investigationJSON is the API shape of an investigation (ASSIST.md 6).
type investigationJSON struct {
	ID               string   `json:"id"`
	Title            string   `json:"title"`
	Server           *string  `json:"server"`
	ServerName       *string  `json:"server_name"`
	AlertID          *string  `json:"alert_id"`
	Provider         string   `json:"provider"`
	Model            *string  `json:"model"`
	State            string   `json:"state"`
	Access           string   `json:"access"`
	Auto             bool     `json:"auto"`
	CreatedBy        string   `json:"created_by"`
	CreatedAt        string   `json:"created_at"`
	UpdatedAt        string   `json:"updated_at"`
	Summary          *string  `json:"summary"`
	Resolved         *bool    `json:"resolved"`
	CostUSD          *float64 `json:"cost_usd"`
	PendingApprovals int      `json:"pending_approvals"`
}

func (a *assistant) investigationJSON(row store.AssistSession) investigationJSON {
	j := investigationJSON{ID: row.ID, Title: row.Title, Server: sp(row.ServerID), ServerName: sp(row.ServerName),
		AlertID: sp(row.AlertID), Provider: row.Provider, Model: sp(row.Model), State: row.State, Access: row.Access, Auto: row.Auto,
		CreatedBy: row.CreatedBy, CreatedAt: row.CreatedAt.UTC().Format(time.RFC3339), UpdatedAt: row.UpdatedAt.UTC().Format(time.RFC3339),
		Summary: sp(row.Summary), Resolved: row.Resolved, CostUSD: row.CostUSD}
	if row.ServerID != "" {
		if st, ok := a.h.snapshotOne(row.ServerID); ok {
			j.ServerName = sp(st.Hostname)
		}
	}
	a.mu.Lock()
	if inv := a.invs[row.ID]; inv != nil {
		j.PendingApprovals = len(inv.approvals)
	}
	a.mu.Unlock()
	return j
}

// save persists the row and publishes it (caller does not hold a.mu).
func (a *assistant) save(inv *liveInv) {
	a.mu.Lock()
	inv.row.UpdatedAt = a.h.now()
	row := inv.row
	a.mu.Unlock()
	if err := a.h.store.PutAssistSession(context.Background(), row); err != nil {
		a.h.log.Error("assistant: saving investigation", "id", row.ID, "err", err)
	}
	a.h.bus.PublishMinRank(store.RoleRank(store.RoleAdmin), "assistant.investigation", a.investigationJSON(row))
}

func (a *assistant) setState(inv *liveInv, state string) {
	a.mu.Lock()
	changed := inv.row.State != state
	inv.row.State = state
	a.mu.Unlock()
	if changed {
		a.save(inv)
		a.publishState()
	}
}

const (
	maxEventText   = 64 << 10
	maxEventOutput = 16 << 10
)

// clip bounds a text to n bytes on a UTF-8 boundary; tail keeps the end.
func clip(s string, n int, tail bool) (string, bool) {
	if len(s) <= n {
		return s, false
	}
	if tail {
		s = s[len(s)-n:]
		for len(s) > 0 && !utf8.RuneStart(s[0]) {
			s = s[1:]
		}
		return s, true
	}
	s = s[:n]
	for len(s) > 0 && !utf8.ValidString(s) {
		s = s[:len(s)-1]
	}
	return s, true
}

// addEvent appends to an investigation's transcript and publishes it.
func (a *assistant) addEvent(inv *liveInv, kind string, data map[string]any) {
	a.addEventID(context.Background(), inv.row.ID, kind, data)
}

func (a *assistant) addEventID(ctx context.Context, id, kind string, data map[string]any) {
	b, _ := json.Marshal(data)
	at := a.h.now()
	seq, err := a.h.store.AddAssistEvent(ctx, id, at, kind, string(b))
	if err != nil {
		a.h.log.Error("assistant: saving event", "id", id, "kind", kind, "err", err)
		return
	}
	a.h.bus.PublishMinRank(store.RoleRank(store.RoleAdmin), "assistant.event",
		map[string]any{"investigation": id, "event": eventJSON(store.AssistEvent{Seq: seq, At: at, Kind: kind, Data: string(b)})})
}

// eventJSON is the API shape of a transcript entry: seq, at, kind and the
// kind's fields.
func eventJSON(e store.AssistEvent) map[string]any {
	out := map[string]any{}
	_ = json.Unmarshal([]byte(e.Data), &out)
	out["seq"], out["at"], out["kind"] = e.Seq, e.At.UTC().Format(time.RFC3339), e.Kind
	return out
}

// startRequest starts an investigation.
type startRequest struct {
	ServerID string
	AlertID  string
	Prompt   string
	Provider string
	By       string
	Auto     bool
}

func (a *assistant) running() int {
	a.mu.Lock()
	defer a.mu.Unlock()
	n := 0
	for _, inv := range a.invs {
		switch inv.row.State {
		case invStarting, invRunning, invWaiting:
			n++
		}
	}
	return n
}

// start creates an investigation and starts its CLI session.
func (a *assistant) start(ctx context.Context, req startRequest) (*liveInv, error) {
	s := a.getSettings()
	if !s.Enabled {
		return nil, apiErr(409, "assistant_disabled", "The assistant is turned off (Settings › Assistant).")
	}
	provider := req.Provider
	if provider == "" {
		provider = s.Provider
	}
	if provider != assist.Claude && provider != assist.Codex {
		return nil, apiErr(400, "invalid_provider", "provider must be claude or codex.")
	}
	if err := a.ready(provider); err != nil {
		return nil, err
	}
	if a.running() >= assistMaxRunning {
		return nil, apiErr(429, "too_many_running", "Three investigations are already running: wait for one to finish or stop one.")
	}
	var alert *rules.Alert
	if req.AlertID != "" {
		al, err := a.findAlert(ctx, req.AlertID)
		if err != nil {
			return nil, err
		}
		alert = &al
		if req.ServerID == "" {
			req.ServerID = al.Server
		}
	}
	var host *model.ServerState
	if req.ServerID != "" {
		st, ok := a.h.snapshotOne(req.ServerID)
		if !ok {
			return nil, apiErr(404, "server_not_found", "No such server.")
		}
		host = st
	}
	req.Prompt = strings.TrimSpace(req.Prompt)
	if len(req.Prompt) > 8000 {
		return nil, apiErr(400, "invalid_prompt", "Keep the question under 8,000 characters.")
	}
	now := a.h.now()
	row := store.AssistSession{ID: newID("inv_"), Provider: provider, Model: s.model(provider), State: invStarting,
		Access: s.Access, Auto: req.Auto, CreatedBy: req.By, CreatedAt: now, UpdatedAt: now}
	if host != nil {
		row.ServerID, row.ServerName = host.ID, host.Hostname
	}
	if alert != nil {
		row.AlertID = alert.ID
	}
	row.Title = investigationTitle(alert, host, req.Prompt)
	if err := a.h.store.PutAssistSession(ctx, row); err != nil {
		return nil, err
	}
	inv := &liveInv{row: row, approvals: map[string]*approval{}}
	a.mu.Lock()
	a.invs[row.ID] = inv
	a.mu.Unlock()
	shown := req.Prompt
	if shown == "" {
		shown = defaultQuestion(alert, host)
	}
	a.addEvent(inv, "user", map[string]any{"text": shown, "by": req.By})
	a.save(inv)
	a.publishState()
	a.h.auditSystem(ctx, store.AuditRecord{Event: "assistant.started", Outcome: "ok", User: req.By, Server: row.ServerID,
		Details: map[string]string{"investigation": row.ID, "alert_id": row.AlertID, "provider": provider, "access": row.Access}})
	go a.launch(inv, a.firstPrompt(alert, host, shown))
	return inv, nil
}

func (a *assistant) findAlert(ctx context.Context, id string) (rules.Alert, error) {
	for _, al := range a.h.alerts.AllOpen() {
		if al.ID == id {
			return al, nil
		}
	}
	al, err := a.h.store.GetAlert(ctx, id)
	if errors.Is(err, store.ErrNotFound) {
		return al, apiErr(404, "alert_not_found", "No such alert.")
	}
	return al, err
}

func investigationTitle(alert *rules.Alert, host *model.ServerState, prompt string) string {
	switch {
	case alert != nil:
		return cleanText(alert.Title, 200)
	case prompt != "":
		t := strings.Join(strings.Fields(prompt), " ")
		if c, cut := clip(t, 90, false); cut {
			t = strings.TrimSpace(c) + "…"
		}
		return t
	case host != nil:
		return "Health check of " + host.Hostname
	}
	return "Fleet health check"
}

func defaultQuestion(alert *rules.Alert, host *model.ServerState) string {
	switch {
	case alert != nil:
		return "Investigate this alert: find the cause, explain it, and fix it if you can."
	case host != nil:
		return "Check this host's health and tell me about anything that needs attention."
	}
	return "Check the fleet's health and tell me about anything that needs attention."
}

// launch starts (or resumes) the CLI session with a message.
func (a *assistant) launch(inv *liveInv, text string) {
	run := newID("run_")
	a.mu.Lock()
	inv.turn, inv.finishing, inv.stopping, inv.run = true, false, false, run
	row := inv.row
	a.mu.Unlock()
	a.setState(inv, invRunning)
	s := a.getSettings()
	req := assist.SessionStart{Session: row.ID, Run: run, Provider: row.Provider, Model: s.model(row.Provider), Resume: row.ProviderSession,
		System: a.systemPrompt(row), Prompt: text, Tools: assistToolDefs()}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	if err := a.call(ctx, assist.MSessionStart, req, nil); err != nil {
		a.mu.Lock()
		inv.turn = false
		a.mu.Unlock()
		a.addEvent(inv, "error", map[string]any{"text": runnerError(err)})
		a.setState(inv, invFailed)
		return
	}
	a.mu.Lock()
	inv.session = true
	a.mu.Unlock()
}

// runnerError explains a failed runner call.
func runnerError(err error) string {
	switch assist.ErrorCode(err) {
	case assist.CodeNotInstalled:
		return "The assistant's CLI is not installed: install it under Settings › Assistant."
	case assist.CodeSignedOut:
		return "The assistant's CLI is not signed in: sign in under Settings › Assistant."
	}
	var ae *apiError
	if errors.As(err, &ae) {
		return ae.Detail
	}
	return "The assistant could not start: " + err.Error()
}

// message continues an investigation with the admin's reply.
func (a *assistant) message(inv *liveInv, text, by string) error {
	text = strings.TrimSpace(text)
	if text == "" || len(text) > 8000 {
		return apiErr(400, "invalid_text", "Write a message of up to 8,000 characters.")
	}
	if !a.getSettings().Enabled {
		return apiErr(409, "assistant_disabled", "The assistant is turned off (Settings › Assistant).")
	}
	a.mu.Lock()
	live, state := inv.session, inv.row.State
	a.mu.Unlock()
	if !live && state != invRunning && state != invWaiting && a.running() >= assistMaxRunning {
		return apiErr(429, "too_many_running", "Three investigations are already running: wait for one to finish or stop one.")
	}
	if err := a.ready(inv.row.Provider); err != nil {
		return err
	}
	a.addEvent(inv, "user", map[string]any{"text": text, "by": by})
	if live {
		ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
		err := a.call(ctx, assist.MSessionSend, assist.SessionSend{Session: inv.row.ID, Text: text}, nil)
		cancel()
		if err == nil {
			a.mu.Lock()
			inv.turn = true
			a.mu.Unlock()
			a.setState(inv, invRunning)
			return nil
		}
		a.mu.Lock()
		inv.session = false
		a.mu.Unlock()
	}
	go a.launch(inv, text)
	return nil
}

// stop interrupts an investigation and ends its CLI session.
func (a *assistant) stop(inv *liveInv, by, why string) {
	a.mu.Lock()
	inv.stopping = true
	live, run := inv.session, inv.run
	var pending []*approval
	for _, ap := range inv.approvals {
		pending = append(pending, ap)
	}
	state := inv.row.State
	a.mu.Unlock()
	for _, ap := range pending {
		select {
		case ap.done <- approvalDecision{Expired: true, By: by}:
		default:
		}
	}
	if live {
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			_ = a.call(ctx, assist.MSessionInterrupt, assist.SessionRef{Session: inv.row.ID, Run: run}, nil)
			time.Sleep(3 * time.Second)
			_ = a.call(ctx, assist.MSessionClose, assist.SessionRef{Session: inv.row.ID, Run: run}, nil)
		}()
	}
	if state == invStarting || state == invRunning || state == invWaiting {
		a.addEvent(inv, "status", map[string]any{"state": invStopped, "text": why})
		a.setState(inv, invStopped)
	}
}

// stopAll stops every running investigation.
func (a *assistant) stopAll(why string) {
	a.mu.Lock()
	var live []*liveInv
	for _, inv := range a.invs {
		switch inv.row.State {
		case invStarting, invRunning, invWaiting:
			live = append(live, inv)
		}
	}
	a.mu.Unlock()
	for _, inv := range live {
		a.stop(inv, "system", why)
	}
}

// sessionGone handles a CLI session that ended without the runner telling
// (the runner itself stopped).
func (a *assistant) sessionGone(inv *liveInv, why string) {
	a.mu.Lock()
	wasLive, turn, stopping := inv.session, inv.turn, inv.stopping
	inv.session, inv.turn = false, false
	a.mu.Unlock()
	if wasLive && turn && !stopping {
		a.addEvent(inv, "status", map[string]any{"state": invIdle, "text": why})
		a.setState(inv, invIdle)
	}
}

// sessionEvent records the runner's output for an investigation.
func (a *assistant) sessionEvent(ev assist.SessionEvent) {
	inv, err := a.inv(context.Background(), ev.Session)
	if err != nil {
		return
	}
	a.mu.Lock()
	stale := ev.Run != "" && ev.Run != inv.run
	a.mu.Unlock()
	if stale {
		return // a run that was replaced
	}
	switch ev.Kind {
	case assist.EvStarted:
		a.mu.Lock()
		changed := inv.row.ProviderSession != ev.ProviderSession
		inv.row.ProviderSession = ev.ProviderSession
		a.mu.Unlock()
		if changed {
			a.save(inv)
		}
	case assist.EvText:
		text, _ := clip(ev.Text, maxEventText, false)
		a.addEvent(inv, "assistant", map[string]any{"text": text})
	case assist.EvTool:
		var input map[string]any
		_ = json.Unmarshal(ev.Input, &input)
		title := ev.Tool
		if q, ok := input["query"].(string); ok {
			title = "Web search: " + q
		} else if u, ok := input["url"].(string); ok {
			title = "Web page: " + u
		}
		a.addEvent(inv, "tool", map[string]any{"tool_id": ev.ToolID, "tool": ev.Tool, "title": cleanText(title, 200), "server": nil, "input": input})
	case assist.EvToolResult:
		out, cut := clip(ev.Output, maxEventOutput, false)
		a.addEvent(inv, "tool_result", map[string]any{"tool_id": ev.ToolID, "ok": ev.OK, "output": out, "truncated": cut, "duration_ms": 0})
	case assist.EvTurnEnd:
		if ev.CostUSD != nil || ev.InputTokens != nil {
			a.addEvent(inv, "usage", map[string]any{"cost_usd": ev.CostUSD, "input_tokens": ev.InputTokens, "output_tokens": ev.OutputTokens})
		}
		a.mu.Lock()
		if ev.CostUSD != nil {
			c := *ev.CostUSD
			inv.row.CostUSD = &c
		}
		inv.turn, inv.session = false, false // closed below; a reply resumes it
		finishing, stopping, run := inv.finishing, inv.stopping, inv.run
		a.mu.Unlock()
		next := invIdle
		switch {
		case stopping:
			next = invStopped
		case ev.Error != "":
			a.addEvent(inv, "error", map[string]any{"text": cleanText(ev.Error, 2000)})
			next = invFailed
		case finishing:
			next = invDone
		}
		a.mu.Lock()
		inv.row.State = next
		a.mu.Unlock()
		a.save(inv)
		a.publishState()
		// The CLI is not kept between turns: the next message resumes it.
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			_ = a.call(ctx, assist.MSessionClose, assist.SessionRef{Session: inv.row.ID, Run: run}, nil)
		}()
	case assist.EvExit:
		a.mu.Lock()
		turn, stopping := inv.turn, inv.stopping
		inv.session, inv.turn = false, false
		a.mu.Unlock()
		if turn && !stopping {
			msg := ev.Error
			if msg == "" {
				msg = "The assistant stopped before it answered."
			}
			a.addEvent(inv, "error", map[string]any{"text": cleanText(msg, 2000)})
			a.setState(inv, invFailed)
		}
	}
}

// decide answers a pending approval.
func (a *assistant) decide(inv *liveInv, approvalID string, d approvalDecision) error {
	a.mu.Lock()
	ap := inv.approvals[approvalID]
	a.mu.Unlock()
	if ap == nil {
		return apiErr(404, "not_found", "No such approval: it was decided or it expired.")
	}
	select {
	case ap.done <- d:
		return nil
	default:
		return apiErr(409, "already_decided", "This approval was already decided.")
	}
}

// requestApproval waits for the admin to approve a change (access "ask").
func (a *assistant) requestApproval(ctx context.Context, inv *liveInv, toolID, server, action, command, reason string) approvalDecision {
	ap := &approval{id: newID("ap_"), toolID: toolID, done: make(chan approvalDecision, 1)}
	a.mu.Lock()
	inv.approvals[ap.id] = ap
	a.mu.Unlock()
	a.addEvent(inv, "approval", map[string]any{"approval_id": ap.id, "tool_id": toolID, "server": server, "action": action,
		"command": command, "reason": reason})
	a.setState(inv, invWaiting)
	a.save(inv) // pending_approvals
	var d approvalDecision
	t := time.NewTimer(assistApprovalTTL)
	defer t.Stop()
	select {
	case d = <-ap.done:
	case <-t.C:
		d = approvalDecision{Expired: true, By: "system"}
	case <-ctx.Done():
		d = approvalDecision{Expired: true, By: "system"}
	}
	a.mu.Lock()
	delete(inv.approvals, ap.id)
	left, stopping := len(inv.approvals), inv.stopping
	a.mu.Unlock()
	decision := "declined"
	switch {
	case d.Expired:
		decision = "expired"
	case d.Approve:
		decision = "approved"
	}
	var reply any
	if d.Reply != "" {
		reply = d.Reply
	}
	a.addEvent(inv, "approval_decided", map[string]any{"approval_id": ap.id, "decision": decision, "by": d.By, "reply": reply})
	if left == 0 && !stopping {
		a.setState(inv, invRunning)
	}
	a.save(inv)
	return d
}
