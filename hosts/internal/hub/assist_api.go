package hub

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"rackoon/internal/assist"
	"rackoon/internal/hub/store"
)

// ---- REST: /api/v1/assistant (ASSIST.md 6, admins) ----------------------------------------

func (h *Hub) assistRoutes(handle func(pattern, role string, f handlerFunc)) {
	handle("GET /api/v1/assistant", admin, h.apiAssistant)
	handle("PUT /api/v1/assistant/settings", admin, h.apiAssistSettings)
	handle("POST /api/v1/assistant/providers/{provider}/install", admin, h.apiAssistInstall)
	handle("DELETE /api/v1/assistant/providers/{provider}", admin, h.apiAssistUninstall)
	handle("POST /api/v1/assistant/providers/{provider}/login", admin, h.apiAssistLogin)
	handle("DELETE /api/v1/assistant/providers/{provider}/login", admin, h.apiAssistLogout)
	handle("GET /api/v1/assistant/investigations", admin, h.apiInvestigations)
	handle("POST /api/v1/assistant/investigations", admin, h.apiStartInvestigation)
	handle("GET /api/v1/assistant/investigations/{iid}", admin, h.apiInvestigation)
	handle("POST /api/v1/assistant/investigations/{iid}/messages", admin, h.apiInvestigationMessage)
	handle("POST /api/v1/assistant/investigations/{iid}/stop", admin, h.apiInvestigationStop)
	handle("POST /api/v1/assistant/investigations/{iid}/approvals/{aid}", admin, h.apiInvestigationDecide)
	handle("DELETE /api/v1/assistant/investigations/{iid}", admin, h.apiInvestigationDelete)
}

// apiAssistant is GET /assistant: settings, runner and providers. The
// first call connects to the runner.
func (h *Hub) apiAssistant(w http.ResponseWriter, r *http.Request, p *principal) error {
	a := h.assist
	a.mu.Lock()
	known := a.statusOK
	a.mu.Unlock()
	if !known {
		ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
		_ = a.refresh(ctx, false)
		cancel()
	}
	writeJSON(w, r, http.StatusOK, a.state())
	return nil
}

func (h *Hub) apiAssistSettings(w http.ResponseWriter, r *http.Request, p *principal) error {
	if err := h.requireReauth(p); err != nil {
		return err
	}
	var patch assistSettingsPatch
	if err := decodeJSON(r, &patch); err != nil {
		return err
	}
	s, changed, err := h.assist.apply(patch)
	if err != nil {
		return err
	}
	if err := h.assist.saveSettings(r.Context(), s); err != nil {
		return err
	}
	if len(changed) > 0 {
		h.auditReq(r, p, store.AuditRecord{Event: "assistant.settings_updated", Outcome: "ok", Details: map[string]string{
			"changed": fmtList(changed), "enabled": strconv.FormatBool(s.Enabled), "access": s.Access,
			"auto_investigate": s.AutoInvestigate, "provider": s.Provider}})
	}
	writeJSON(w, r, http.StatusOK, h.assist.state())
	return nil
}

func providerParam(r *http.Request) (string, error) {
	p := r.PathValue("provider")
	if p != assist.Claude && p != assist.Codex {
		return "", apiErr(http.StatusNotFound, "not_found", "Unknown provider (claude or codex).")
	}
	return p, nil
}

// assistErr maps a runner error to an API error.
func assistErr(err error) error {
	var ae *apiError
	if errors.As(err, &ae) {
		return ae
	}
	switch code := assist.ErrorCode(err); code {
	case assist.CodeBusy:
		return apiErr(http.StatusConflict, "busy", err.Error())
	case assist.CodeNotInstalled:
		return apiErr(http.StatusConflict, "provider_not_installed", err.Error())
	case assist.CodeSignedOut:
		return apiErr(http.StatusConflict, "provider_signed_out", err.Error())
	case assist.CodeLogin, assist.CodeInvalid:
		return apiErr(http.StatusBadRequest, "invalid_request", err.Error())
	case "runner_unavailable":
		return apiErr(http.StatusServiceUnavailable, "runner_unavailable", err.Error())
	case "":
		if errors.Is(err, assist.ErrClosed) || errors.Is(err, context.DeadlineExceeded) {
			return apiErr(http.StatusServiceUnavailable, "runner_unavailable", "The assistant runner did not answer.")
		}
		return apiErr(http.StatusBadGateway, "runner_error", err.Error())
	default:
		return apiErr(http.StatusBadGateway, code, err.Error())
	}
}

func (h *Hub) apiAssistInstall(w http.ResponseWriter, r *http.Request, p *principal) error {
	provider, err := providerParam(r)
	if err != nil {
		return err
	}
	if err := h.requireReauth(p); err != nil {
		return err
	}
	if _, err := h.assist.connect(r.Context()); err != nil {
		return assistErr(err)
	}
	if err := h.assist.install(provider, p.user.Username); err != nil {
		return err
	}
	writeJSON(w, r, http.StatusAccepted, h.assist.state())
	return nil
}

func (h *Hub) apiAssistUninstall(w http.ResponseWriter, r *http.Request, p *principal) error {
	provider, err := providerParam(r)
	if err != nil {
		return err
	}
	if err := h.requireReauth(p); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(r.Context(), time.Minute)
	defer cancel()
	if err := h.assist.call(ctx, assist.MUninstall, assist.ProviderParams{Provider: provider}, nil); err != nil {
		return assistErr(err)
	}
	h.auditReq(r, p, store.AuditRecord{Event: "assistant.uninstalled", Outcome: "ok", Details: map[string]string{"provider": provider}})
	_ = h.assist.refresh(ctx, false)
	writeJSON(w, r, http.StatusOK, h.assist.state())
	return nil
}

func (h *Hub) apiAssistLogin(w http.ResponseWriter, r *http.Request, p *principal) error {
	provider, err := providerParam(r)
	if err != nil {
		return err
	}
	if err := h.requireReauth(p); err != nil {
		return err
	}
	var body struct {
		Token string `json:"token"`
	}
	if r.ContentLength != 0 {
		if err := decodeJSON(r, &body); err != nil {
			return err
		}
	}
	if provider == assist.Claude && strings.TrimSpace(body.Token) == "" {
		return apiErr(http.StatusBadRequest, "invalid_token", "Paste the token that `claude setup-token` prints.")
	}
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Minute)
	defer cancel()
	h.assist.mu.Lock()
	delete(h.assist.provErr, provider)
	h.assist.mu.Unlock()
	err = h.assist.call(ctx, assist.MLogin, assist.LoginParams{Provider: provider, Token: body.Token}, nil)
	rec := store.AuditRecord{Event: "assistant.signed_in", Outcome: "ok", Details: map[string]string{"provider": provider}}
	if provider == assist.Codex {
		rec.Event = "assistant.sign_in_started"
	}
	if err != nil {
		rec.Outcome, rec.Details["error"] = "error", cleanText(err.Error(), 300)
	}
	h.auditReq(r, p, rec)
	if err != nil {
		return assistErr(err)
	}
	_ = h.assist.refresh(ctx, provider == assist.Claude)
	writeJSON(w, r, http.StatusOK, h.assist.state())
	return nil
}

func (h *Hub) apiAssistLogout(w http.ResponseWriter, r *http.Request, p *principal) error {
	provider, err := providerParam(r)
	if err != nil {
		return err
	}
	if err := h.requireReauth(p); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(r.Context(), time.Minute)
	defer cancel()
	if err := h.assist.call(ctx, assist.MLogout, assist.ProviderParams{Provider: provider}, nil); err != nil {
		return assistErr(err)
	}
	h.auditReq(r, p, store.AuditRecord{Event: "assistant.signed_out", Outcome: "ok", Details: map[string]string{"provider": provider}})
	_ = h.assist.refresh(ctx, true)
	writeJSON(w, r, http.StatusOK, h.assist.state())
	return nil
}

func (h *Hub) apiInvestigations(w http.ResponseWriter, r *http.Request, p *principal) error {
	q := r.URL.Query()
	limit, _ := strconv.Atoi(q.Get("limit"))
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	rows, err := h.store.ListAssistSessions(r.Context(), store.AssistFilter{ServerID: q.Get("server"), AlertID: q.Get("alert"), Limit: limit})
	if err != nil {
		return err
	}
	out := make([]investigationJSON, 0, len(rows))
	for _, row := range rows {
		h.assist.mu.Lock()
		if inv := h.assist.invs[row.ID]; inv != nil {
			row = inv.row // the live state
		}
		h.assist.mu.Unlock()
		out = append(out, h.assist.investigationJSON(row))
	}
	writeJSON(w, r, http.StatusOK, out)
	return nil
}

func (h *Hub) apiStartInvestigation(w http.ResponseWriter, r *http.Request, p *principal) error {
	var body struct {
		Server   string `json:"server"`
		Alert    string `json:"alert"`
		Prompt   string `json:"prompt"`
		Provider string `json:"provider"`
	}
	if err := decodeJSON(r, &body); err != nil {
		return err
	}
	if h.throttled(p) {
		return rateLimited(10 * time.Minute)
	}
	inv, err := h.assist.start(r.Context(), startRequest{ServerID: body.Server, AlertID: body.Alert, Prompt: body.Prompt,
		Provider: body.Provider, By: p.user.Username})
	if err != nil {
		return assistErr(err)
	}
	h.assist.mu.Lock()
	row := inv.row
	h.assist.mu.Unlock()
	writeJSON(w, r, http.StatusCreated, h.assist.investigationJSON(row))
	return nil
}

// invParam loads the investigation of the path.
func (h *Hub) invParam(r *http.Request) (*liveInv, error) {
	inv, err := h.assist.inv(r.Context(), r.PathValue("iid"))
	if errors.Is(err, store.ErrNotFound) {
		return nil, apiErr(http.StatusNotFound, "not_found", "No such investigation.")
	}
	return inv, err
}

func (h *Hub) invJSON(inv *liveInv) investigationJSON {
	h.assist.mu.Lock()
	row := inv.row
	h.assist.mu.Unlock()
	return h.assist.investigationJSON(row)
}

func (h *Hub) apiInvestigation(w http.ResponseWriter, r *http.Request, p *principal) error {
	inv, err := h.invParam(r)
	if err != nil {
		return err
	}
	evs, err := h.store.AssistEvents(r.Context(), inv.row.ID)
	if err != nil {
		return err
	}
	events := make([]map[string]any, 0, len(evs))
	for _, e := range evs {
		events = append(events, eventJSON(e))
	}
	writeJSON(w, r, http.StatusOK, map[string]any{"investigation": h.invJSON(inv), "events": events})
	return nil
}

func (h *Hub) apiInvestigationMessage(w http.ResponseWriter, r *http.Request, p *principal) error {
	inv, err := h.invParam(r)
	if err != nil {
		return err
	}
	var body struct {
		Text string `json:"text"`
	}
	if err := decodeJSON(r, &body); err != nil {
		return err
	}
	if err := h.assist.message(inv, body.Text, p.user.Username); err != nil {
		return assistErr(err)
	}
	writeJSON(w, r, http.StatusAccepted, h.invJSON(inv))
	return nil
}

func (h *Hub) apiInvestigationStop(w http.ResponseWriter, r *http.Request, p *principal) error {
	inv, err := h.invParam(r)
	if err != nil {
		return err
	}
	h.assist.stop(inv, p.user.Username, "Stopped by "+p.user.Username+".")
	h.auditReq(r, p, store.AuditRecord{Event: "assistant.stopped", Outcome: "ok", Server: inv.row.ServerID,
		Details: map[string]string{"investigation": inv.row.ID}})
	writeJSON(w, r, http.StatusOK, h.invJSON(inv))
	return nil
}

func (h *Hub) apiInvestigationDecide(w http.ResponseWriter, r *http.Request, p *principal) error {
	inv, err := h.invParam(r)
	if err != nil {
		return err
	}
	var body struct {
		Approve bool   `json:"approve"`
		Reply   string `json:"reply"`
	}
	if err := decodeJSON(r, &body); err != nil {
		return err
	}
	d := approvalDecision{Approve: body.Approve, Reply: cleanText(body.Reply, 2000), By: p.user.Username}
	if err := h.assist.decide(inv, r.PathValue("aid"), d); err != nil {
		return err
	}
	ev := "assistant.approved"
	if !body.Approve {
		ev = "assistant.declined"
	}
	h.auditReq(r, p, store.AuditRecord{Event: ev, Outcome: "ok", Server: inv.row.ServerID,
		Details: map[string]string{"investigation": inv.row.ID, "approval": r.PathValue("aid")}})
	writeJSON(w, r, http.StatusOK, h.invJSON(inv))
	return nil
}

func (h *Hub) apiInvestigationDelete(w http.ResponseWriter, r *http.Request, p *principal) error {
	inv, err := h.invParam(r)
	if err != nil {
		return err
	}
	h.assist.stop(inv, p.user.Username, "Deleted.")
	id := inv.row.ID
	if err := h.store.DeleteAssistSession(r.Context(), id); err != nil && !errors.Is(err, store.ErrNotFound) {
		return err
	}
	h.assist.mu.Lock()
	delete(h.assist.invs, id)
	h.assist.mu.Unlock()
	h.bus.PublishMinRank(store.RoleRank(store.RoleAdmin), "assistant.deleted", map[string]string{"id": id})
	h.auditReq(r, p, store.AuditRecord{Event: "assistant.deleted", Outcome: "ok", Details: map[string]string{"investigation": id}})
	w.WriteHeader(http.StatusNoContent)
	return nil
}
