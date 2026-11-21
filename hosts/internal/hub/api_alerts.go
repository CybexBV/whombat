package hub

import (
	"context"
	"net/http"
	"strconv"
	"strings"
	"time"

	"rackoon/internal/hub/model"
	"rackoon/internal/hub/store"
	"rackoon/internal/rules"
)

// buildAlert maps an alert with its host's context (maintenance, parent).
func (h *Hub) buildAlert(a rules.Alert) model.Alert {
	var st *model.ServerState
	if a.Server != "" {
		st, _ = h.snapshotOne(a.Server)
	}
	return model.BuildAlertFor(a, st, h.now())
}

// apiAlerts is GET /alerts?state=open|resolved|all&server=&group=
// &severity=&rule=&q=&since=&until=&before=&limit= → array, newest first
// for resolved/all (open: most severe first). For paging, pass the
// opened_at of the last item as before=; the X-Next-Before header carries
// it when more may follow.
func (h *Hub) apiAlerts(w http.ResponseWriter, r *http.Request, p *principal) error {
	q := r.URL.Query()
	state := q.Get("state")
	if state == "" {
		state = "open"
	}
	limit, _ := strconv.Atoi(q.Get("limit"))
	if limit <= 0 {
		limit = 200
	}
	limit = min(limit, 1000)
	group, server, severity, rule, text := q.Get("group"), q.Get("server"), q.Get("severity"), q.Get("rule"), strings.TrimSpace(q.Get("q"))
	if severity != "" && severity != rules.SevCritical && severity != rules.SevWarning {
		return apiErr(http.StatusBadRequest, "invalid_severity", "severity must be critical or warning.")
	}
	parseT := func(k string) (time.Time, error) {
		v := q.Get(k)
		if v == "" {
			return time.Time{}, nil
		}
		t, err := time.Parse(time.RFC3339, v)
		if err != nil {
			return t, apiErr(http.StatusBadRequest, "invalid_time", k+" must be RFC 3339.")
		}
		return t, nil
	}
	since, err := parseT("since")
	if err != nil {
		return err
	}
	until, err := parseT("until")
	if err != nil {
		return err
	}
	before, err := parseT("before")
	if err != nil {
		return err
	}
	snap := h.snapshot()
	hosts := map[string]*model.ServerState{}
	var inGroup []string
	for _, s := range snap {
		hosts[s.ID] = s
		if model.InGroup(s, group) && (server == "" || s.ID == server) {
			inGroup = append(inGroup, s.ID)
		}
	}
	allFleet := (group == "" || strings.EqualFold(group, model.AllGroup)) && (server == "" || server == "hub")
	if server == "hub" {
		inGroup = nil
	}
	if allFleet {
		inGroup = append(inGroup, "") // hub-level alerts
	}
	now := h.now()
	matches := func(a rules.Alert) bool {
		if severity != "" && a.Severity != severity {
			return false
		}
		if rule != "" && a.Rule != rule && !(strings.HasSuffix(rule, ".") && strings.HasPrefix(a.Rule, rule)) {
			return false
		}
		if text != "" {
			l := strings.ToLower(text)
			if !strings.Contains(strings.ToLower(a.Title), l) && !strings.Contains(strings.ToLower(a.Detail), l) {
				return false
			}
		}
		return true
	}
	out := []model.Alert{}
	switch state {
	case "open":
		ok := map[string]bool{}
		for _, id := range inGroup {
			ok[id] = true
		}
		for _, a := range h.alerts.AllOpen() {
			if ok[a.Server] && matches(a) {
				out = append(out, model.BuildAlertFor(a, hosts[a.Server], now))
			}
		}
	case "resolved", "all":
		st := rules.AlertResolved
		if state == "all" {
			st = ""
		}
		list, err := h.store.QueryAlerts(r.Context(), store.AlertFilter{State: st, Servers: inGroup, Severity: severity,
			Rule: rule, Query: text, Since: since, Until: until, Before: before, Limit: limit})
		if err != nil {
			return err
		}
		for _, a := range list {
			out = append(out, model.BuildAlertFor(a, hosts[a.Server], now))
		}
		if len(list) == limit {
			w.Header().Set("X-Next-Before", list[len(list)-1].OpenedAt.UTC().Format(time.RFC3339Nano))
		}
	default:
		return apiErr(http.StatusBadRequest, "invalid_state", "state must be open, resolved or all.")
	}
	writeJSON(w, r, http.StatusOK, out)
	return nil
}

// apiAckAlert is POST /alerts/{id}/ack {note, minutes}: acknowledge an open
// alert (minutes > 0: a snooze that lapses).
func (h *Hub) apiAckAlert(w http.ResponseWriter, r *http.Request, p *principal) error {
	if p.rank() < store.RoleRank(operator) {
		return errForbidden
	}
	var req struct {
		Note    string `json:"note"`
		Minutes int    `json:"minutes"`
	}
	if r.ContentLength != 0 {
		if err := decodeJSON(r, &req); err != nil {
			return err
		}
	}
	if req.Minutes < 0 || req.Minutes > 30*24*60 {
		return apiErr(http.StatusBadRequest, "invalid_duration", "minutes must be 0 (until resolved) to 43200.")
	}
	now := h.now()
	ack := &rules.Ack{At: now, By: p.user.Username, Note: cleanText(req.Note, 256)}
	if req.Minutes > 0 {
		t := now.Add(time.Duration(req.Minutes) * time.Minute)
		ack.Until = &t
	}
	return h.setAck(w, r, p, r.PathValue("id"), ack)
}

// apiUnackAlert is DELETE /alerts/{id}/ack.
func (h *Hub) apiUnackAlert(w http.ResponseWriter, r *http.Request, p *principal) error {
	if p.rank() < store.RoleRank(operator) {
		return errForbidden
	}
	return h.setAck(w, r, p, r.PathValue("id"), nil)
}

func (h *Hub) setAck(w http.ResponseWriter, r *http.Request, p *principal, id string, ack *rules.Ack) error {
	cur, ok := h.alerts.Find(id)
	if !ok {
		return apiErr(http.StatusNotFound, "alert_not_open", "No open alert with this id.")
	}
	if err := h.store.SetAlertAck(r.Context(), id, ack); err != nil {
		return err
	}
	a, ok := h.alerts.SetAck(cur.Server, id, ack)
	if !ok {
		return apiErr(http.StatusNotFound, "alert_not_open", "The alert was resolved meanwhile.")
	}
	ev, details := "alert.acknowledged", map[string]string{"alert_id": id, "rule": a.Rule, "title": a.Title}
	if ack == nil {
		ev = "alert.unacknowledged"
	} else {
		if ack.Note != "" {
			details["note"] = ack.Note
		}
		if ack.Until != nil {
			details["until"] = ack.Until.UTC().Format(time.RFC3339)
		}
	}
	h.auditReq(r, p, store.AuditRecord{Event: ev, Outcome: "ok", Server: a.Server, Details: details})
	built := h.buildAlert(a)
	h.bus.Publish("alert.updated", built)
	if a.Server != "" { // the status follows the alerts that ask for attention (HS-190)
		h.publishServerUpdated(a.Server)
	}
	writeJSON(w, r, http.StatusOK, built)
	return nil
}

// expireAcks ends lapsed snoozes (the alert asks for attention again).
func (h *Hub) expireAcks(ctx context.Context) {
	for _, a := range h.alerts.ExpireAcks(h.now()) {
		if err := h.store.SetAlertAck(ctx, a.ID, nil); err != nil {
			h.log.Error("snooze expiry", "alert", a.ID, "err", err)
		}
		h.bus.Publish("alert.updated", h.buildAlert(a))
		if a.Server != "" {
			h.publishServerUpdated(a.Server)
		}
	}
}

// RuleDeniedRequests is the hub-level alert for a user whose console or
// power requests keep being refused (REMOTE-CONSOLE.md 6.13).
const RuleDeniedRequests = "security.denied_requests"

// deniedAlertThreshold is how many authorization denials in the throttle
// window open the alert.
const deniedAlertThreshold = 20

// evaluateHubAlerts evaluates the alerts that belong to no host.
func (h *Hub) evaluateHubAlerts(ctx context.Context) {
	now := h.now()
	var conds []rules.Condition
	for _, kc := range h.limits.denied.over(deniedAlertThreshold) {
		user, n := kc.key, kc.n
		conds = append(conds, rules.Condition{
			Rule: RuleDeniedRequests, Entity: "user:" + user, Severity: rules.SevWarning, ClearAfter: 30 * time.Minute,
			StatusNote: "denied requests",
			Render: func(time.Duration) rules.Text {
				d := user + " tried " + strconv.Itoa(n) + " times in 10 minutes to use a console or power button they aren’t allowed to"
				return rules.Text{Title: "Someone keeps being refused", Detail: d, BannerTitle: "Someone keeps being refused", BannerDetail: d + "."}
			},
		})
	}
	h.applyAlerts(ctx, h.alerts.Evaluate("", conds, func(r string) bool { return r == RuleDeniedRequests }, now))
}
