package hub

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/nicholas-fedor/shoutrrr/pkg/router"

	"rackoon/internal/hub/model"
	"rackoon/internal/hub/store"
	"rackoon/internal/rules"
)

type channelJSON struct {
	ID           string        `json:"id"`
	Name         string        `json:"name"`
	Kind         string        `json:"kind"`
	Target       string        `json:"target"` // the URL without secrets: scheme and host (and ntfy topic)
	MinSeverity  string        `json:"min_severity"`
	Groups       []string      `json:"groups"`
	SendResolved bool          `json:"send_resolved"`
	ReminderMin  int           `json:"reminder_min"`
	Enabled      bool          `json:"enabled"`
	Format       string        `json:"format,omitempty"` // webhook
	HeaderNames  []string      `json:"header_names"`     // webhook: header names only
	HasToken     bool          `json:"has_token"`        // ntfy
	CreatedBy    string        `json:"created_by"`
	CreatedAt    string        `json:"created_at"`
	LastDelivery *deliveryJSON `json:"last_delivery"`
}

type deliveryJSON struct {
	ID       int64    `json:"id"`
	Channel  string   `json:"channel"`
	At       string   `json:"at"`
	Kind     string   `json:"kind"`
	AlertIDs []string `json:"alert_ids"`
	Summary  string   `json:"summary"`
	OK       bool     `json:"ok"`
	Error    string   `json:"error"`
	Attempt  int      `json:"attempt"`
}

func toDeliveryJSON(d store.Delivery) deliveryJSON {
	ids := d.AlertIDs
	if ids == nil {
		ids = []string{}
	}
	return deliveryJSON{ID: d.ID, Channel: d.ChannelID, At: d.At.UTC().Format(time.RFC3339), Kind: d.Kind, AlertIDs: ids,
		Summary: d.Summary, OK: d.OK, Error: d.Error, Attempt: d.Attempt}
}

// redactURL keeps what identifies a destination and drops credentials:
// "discord://…", "https://ntfy.sh/alerts", "smtp://mail.example.com".
func redactURL(kind, raw string) string {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme == "" {
		return "…"
	}
	switch kind {
	case store.ChannelNtfy:
		return u.Scheme + "://" + u.Host + u.Path
	case store.ChannelWebhook:
		return u.Scheme + "://" + u.Host + "/…"
	}
	if u.Host != "" && !strings.Contains(u.Host, "@") {
		// Many Shoutrrr URLs put a token in the host part; show the
		// scheme and only hosts that look like host names.
		if strings.Contains(u.Host, ".") && u.User == nil {
			return u.Scheme + "://" + u.Host
		}
	}
	return u.Scheme + "://…"
}

func toChannelJSON(c store.Channel, last *store.Delivery) channelJSON {
	o := parseOptions(c.Options)
	out := channelJSON{ID: c.ID, Name: c.Name, Kind: c.Kind, Target: redactURL(c.Kind, c.URL), MinSeverity: c.MinSeverity,
		Groups: c.Groups, SendResolved: c.SendResolved, ReminderMin: c.ReminderMin, Enabled: c.Enabled, Format: o.Format,
		HeaderNames: []string{}, HasToken: o.Token != "", CreatedBy: c.CreatedBy, CreatedAt: c.CreatedAt.UTC().Format(time.RFC3339)}
	if out.Groups == nil {
		out.Groups = []string{}
	}
	for k := range o.Headers {
		out.HeaderNames = append(out.HeaderNames, k)
	}
	if last != nil {
		d := toDeliveryJSON(*last)
		out.LastDelivery = &d
	}
	return out
}

func (h *Hub) apiChannels(w http.ResponseWriter, r *http.Request, p *principal) error {
	list, err := h.store.ListChannels(r.Context())
	if err != nil {
		return err
	}
	recent, err := h.store.ListDeliveries(r.Context(), "", 500)
	if err != nil {
		return err
	}
	last := map[string]*store.Delivery{}
	for i := range recent {
		if _, ok := last[recent[i].ChannelID]; !ok {
			last[recent[i].ChannelID] = &recent[i]
		}
	}
	out := []channelJSON{}
	for _, c := range list {
		out = append(out, toChannelJSON(c, last[c.ID]))
	}
	writeJSON(w, r, http.StatusOK, out)
	return nil
}

type channelReq struct {
	Name         *string           `json:"name"`
	Kind         *string           `json:"kind"`
	URL          *string           `json:"url"`
	MinSeverity  *string           `json:"min_severity"`
	Groups       *[]string         `json:"groups"`
	SendResolved *bool             `json:"send_resolved"`
	ReminderMin  *int              `json:"reminder_min"`
	Enabled      *bool             `json:"enabled"`
	Format       *string           `json:"format"`
	Headers      map[string]string `json:"headers"` // replaces all headers when given
	Token        *string           `json:"token"`   // ntfy; "" clears
}

// apply validates req onto c. secretsChanged reports a new URL or secret.
func applyChannel(c *store.Channel, req channelReq) (secretsChanged bool, err error) {
	if req.Name != nil {
		c.Name = cleanText(*req.Name, 64)
	}
	if req.Kind != nil {
		c.Kind = *req.Kind
	}
	if req.URL != nil {
		c.URL = strings.TrimSpace(*req.URL)
		secretsChanged = true
	}
	if req.MinSeverity != nil {
		c.MinSeverity = *req.MinSeverity
	}
	if req.Groups != nil {
		c.Groups = nil
		for _, g := range *req.Groups {
			if g = cleanText(g, 64); g != "" {
				c.Groups = append(c.Groups, g)
			}
		}
	}
	if req.SendResolved != nil {
		c.SendResolved = *req.SendResolved
	}
	if req.ReminderMin != nil {
		c.ReminderMin = *req.ReminderMin
	}
	if req.Enabled != nil {
		c.Enabled = *req.Enabled
	}
	o := parseOptions(c.Options)
	if req.Format != nil {
		o.Format = *req.Format
	}
	if req.Headers != nil {
		o.Headers = map[string]string{}
		for k, v := range req.Headers {
			if k = strings.TrimSpace(k); k != "" {
				o.Headers[http.CanonicalHeaderKey(k)] = v
			}
		}
		secretsChanged = true
	}
	if req.Token != nil {
		o.Token = strings.TrimSpace(*req.Token)
		secretsChanged = true
	}
	b, _ := json.Marshal(o)
	c.Options = string(b)

	if c.Name == "" {
		return secretsChanged, apiErr(http.StatusBadRequest, "invalid_name", "Give the channel a name.")
	}
	switch c.MinSeverity {
	case rules.SevWarning, rules.SevCritical:
	default:
		return secretsChanged, apiErr(http.StatusBadRequest, "invalid_severity", "min_severity must be warning or critical.")
	}
	if c.ReminderMin < 0 || c.ReminderMin > 7*24*60 {
		return secretsChanged, apiErr(http.StatusBadRequest, "invalid_reminder", "reminder_min must be 0 to 10080.")
	}
	switch c.Kind {
	case store.ChannelShoutrrr:
		if err := validShoutrrrURL(c.URL); err != nil {
			return secretsChanged, apiErr(http.StatusBadRequest, "invalid_url", "Not a notification URL Rackoon understands: "+err.Error())
		}
	case store.ChannelNtfy, store.ChannelWebhook:
		u, err := url.Parse(c.URL)
		if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" {
			return secretsChanged, apiErr(http.StatusBadRequest, "invalid_url", "The URL must be http(s)://host/….")
		}
		if c.Kind == store.ChannelNtfy && strings.Trim(u.Path, "/") == "" {
			return secretsChanged, apiErr(http.StatusBadRequest, "invalid_url", "Add the topic to the ntfy URL: https://ntfy.sh/<topic>.")
		}
		if c.Kind == store.ChannelWebhook && o.Format != "" && o.Format != "rackoon" && o.Format != "alertmanager" {
			return secretsChanged, apiErr(http.StatusBadRequest, "invalid_format", "format must be rackoon or alertmanager.")
		}
	default:
		return secretsChanged, apiErr(http.StatusBadRequest, "invalid_kind", "kind must be ntfy, webhook or shoutrrr.")
	}
	return secretsChanged, nil
}

func (h *Hub) apiCreateChannel(w http.ResponseWriter, r *http.Request, p *principal) error {
	if err := h.requireReauth(p); err != nil {
		return err
	}
	var req channelReq
	if err := decodeJSON(r, &req); err != nil {
		return err
	}
	c := store.Channel{ID: newID("ch_"), MinSeverity: rules.SevWarning, SendResolved: true, Enabled: true,
		CreatedBy: p.user.Username, CreatedAt: h.now()}
	if _, err := applyChannel(&c, req); err != nil {
		return err
	}
	if err := h.store.PutChannel(r.Context(), c); err != nil {
		return err
	}
	h.auditReq(r, p, store.AuditRecord{Event: "notification.channel_created", Outcome: "ok",
		Details: map[string]string{"channel_id": c.ID, "name": c.Name, "kind": c.Kind, "target": redactURL(c.Kind, c.URL)}})
	writeJSON(w, r, http.StatusCreated, toChannelJSON(c, nil))
	return nil
}

func (h *Hub) apiPatchChannel(w http.ResponseWriter, r *http.Request, p *principal) error {
	c, err := h.store.GetChannel(r.Context(), r.PathValue("id"))
	if errors.Is(err, store.ErrNotFound) {
		return errNotFound
	}
	if err != nil {
		return err
	}
	var req channelReq
	if err := decodeJSON(r, &req); err != nil {
		return err
	}
	if req.URL != nil || req.Headers != nil || req.Token != nil {
		// A new destination can carry the alerts elsewhere.
		if err := h.requireReauth(p); err != nil {
			return err
		}
	}
	if _, err := applyChannel(&c, req); err != nil {
		return err
	}
	if err := h.store.PutChannel(r.Context(), c); err != nil {
		return err
	}
	h.auditReq(r, p, store.AuditRecord{Event: "notification.channel_updated", Outcome: "ok",
		Details: map[string]string{"channel_id": c.ID, "name": c.Name, "target": redactURL(c.Kind, c.URL), "enabled": strconv.FormatBool(c.Enabled)}})
	writeJSON(w, r, http.StatusOK, toChannelJSON(c, nil))
	return nil
}

func (h *Hub) apiDeleteChannel(w http.ResponseWriter, r *http.Request, p *principal) error {
	id := r.PathValue("id")
	c, err := h.store.GetChannel(r.Context(), id)
	if errors.Is(err, store.ErrNotFound) {
		return errNotFound
	}
	if err != nil {
		return err
	}
	if err := h.store.DeleteChannel(r.Context(), id); err != nil {
		return err
	}
	h.auditReq(r, p, store.AuditRecord{Event: "notification.channel_deleted", Outcome: "ok",
		Details: map[string]string{"channel_id": id, "name": c.Name}})
	w.WriteHeader(http.StatusNoContent)
	return nil
}

// apiTestChannel is POST /channels/{id}/test, or POST /channels/test with
// an unsaved configuration: sends a test message now and reports the
// outcome.
func (h *Hub) apiTestChannel(w http.ResponseWriter, r *http.Request, p *principal) error {
	var c store.Channel
	if id := r.PathValue("id"); id != "" {
		var err error
		c, err = h.store.GetChannel(r.Context(), id)
		if errors.Is(err, store.ErrNotFound) {
			return errNotFound
		}
		if err != nil {
			return err
		}
	} else {
		var req channelReq
		if err := decodeJSON(r, &req); err != nil {
			return err
		}
		c = store.Channel{ID: "test", MinSeverity: rules.SevWarning, Enabled: true}
		if req.Name == nil {
			n := "Test"
			req.Name = &n
		}
		if _, err := applyChannel(&c, req); err != nil {
			return err
		}
	}
	msg := notice{kind: noticeTest, alerts: []model.Alert{{ID: "test", Severity: rules.SevWarning, Title: "Test notification"}}}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	err := h.notify.send(ctx, c, msg)
	d := store.Delivery{ChannelID: c.ID, At: h.now(), Kind: noticeTest, Summary: "Test notification", OK: err == nil, Attempt: 1}
	if err != nil {
		d.Error = truncateErr(err)
	}
	if c.ID != "test" {
		_ = h.store.AddDelivery(r.Context(), d)
	}
	writeJSON(w, r, http.StatusOK, map[string]any{"ok": err == nil, "error": d.Error})
	return nil
}

func (h *Hub) apiDeliveries(w http.ResponseWriter, r *http.Request, p *principal) error {
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	list, err := h.store.ListDeliveries(r.Context(), r.URL.Query().Get("channel"), limit)
	if err != nil {
		return err
	}
	out := []deliveryJSON{}
	for _, d := range list {
		out = append(out, toDeliveryJSON(d))
	}
	writeJSON(w, r, http.StatusOK, out)
	return nil
}

// apiNotifySettings is GET/PUT /notification-settings: the hub heartbeat.
// Like channel URLs, the heartbeat URL is write-only (it usually carries a
// check's secret): GET shows heartbeat_target without it; a PUT without
// heartbeat_url keeps the URL, "" removes it.
func (h *Hub) apiNotifySettings(w http.ResponseWriter, r *http.Request, p *principal) error {
	ctx := r.Context()
	if r.Method == http.MethodPut {
		var body struct {
			HeartbeatURL     *string `json:"heartbeat_url"`
			HeartbeatMinutes int     `json:"heartbeat_minutes"`
		}
		if err := decodeJSON(r, &body); err != nil {
			return err
		}
		var req struct {
			HeartbeatURL     string
			HeartbeatMinutes int
		}
		req.HeartbeatMinutes = body.HeartbeatMinutes
		if body.HeartbeatURL == nil {
			req.HeartbeatURL, _, _ = h.store.GetMeta(ctx, "heartbeat_url")
		} else {
			req.HeartbeatURL = strings.TrimSpace(*body.HeartbeatURL)
		}
		if req.HeartbeatURL != "" {
			u, err := url.Parse(req.HeartbeatURL)
			if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" {
				return apiErr(http.StatusBadRequest, "invalid_url", "The heartbeat URL must be http(s)://….")
			}
		}
		if req.HeartbeatMinutes == 0 {
			req.HeartbeatMinutes = 5
		}
		if req.HeartbeatMinutes < 1 || req.HeartbeatMinutes > 60 {
			return apiErr(http.StatusBadRequest, "invalid_interval", "heartbeat_minutes must be 1 to 60.")
		}
		if err := h.store.SetMeta(ctx, "heartbeat_url", req.HeartbeatURL); err != nil {
			return err
		}
		if err := h.store.SetMeta(ctx, "heartbeat_minutes", strconv.Itoa(req.HeartbeatMinutes)); err != nil {
			return err
		}
		h.hbMu.Lock()
		h.hbLast = time.Time{} // ping at the next minute
		h.hbMu.Unlock()
		h.auditReq(r, p, store.AuditRecord{Event: "notification.heartbeat_updated", Outcome: "ok",
			Details: map[string]string{"target": redactURL(store.ChannelWebhook, req.HeartbeatURL)}})
	}
	u, _, _ := h.store.GetMeta(ctx, "heartbeat_url")
	m, _, _ := h.store.GetMeta(ctx, "heartbeat_minutes")
	minutes, _ := strconv.Atoi(m)
	if minutes == 0 {
		minutes = 5
	}
	h.hbMu.Lock()
	last, failing := h.hbLast, h.hbFailing
	h.hbMu.Unlock()
	target := ""
	if u != "" {
		target = redactURL(store.ChannelWebhook, u)
	}
	writeJSON(w, r, http.StatusOK, map[string]any{"heartbeat_set": u != "", "heartbeat_target": target, "heartbeat_minutes": minutes,
		"heartbeat_last": tsp(last), "heartbeat_failing": failing})
	return nil
}

// validShoutrrrURL checks that Shoutrrr knows the service and can parse
// the URL (without sending anything).
func validShoutrrrURL(raw string) error {
	r, err := router.New(nil)
	if err != nil {
		return err
	}
	defer r.Close()
	_, err = r.Locate(raw)
	return err
}
