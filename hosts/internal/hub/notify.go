package hub

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/nicholas-fedor/shoutrrr"
	"github.com/nicholas-fedor/shoutrrr/pkg/types"

	"rackoon/internal/hub/model"
	"rackoon/internal/hub/store"
	"rackoon/internal/rules"
)

// Notifications. An alert is notified once it has needed attention for
// the group wait (30 s): alerts of a burst arrive in one message, and a
// blip that resolves within the wait is never sent. Acknowledged, muted
// and suppressed alerts are not notified (a mute that ends, or a snooze
// that lapses, lets them through). Each channel may remind about alerts
// still open, and tells when a notified alert resolves.

// notice kinds.
const (
	noticeOpened   = "opened"
	noticeResolved = "resolved"
	noticeReminder = "reminder"
	noticeTest     = "test"
)

// notice is one message to one channel.
type notice struct {
	kind   string
	alerts []model.Alert
	hosts  map[string]string // server id -> group (for links and routing)
}

type notifier struct {
	h         *Hub
	groupWait time.Duration
	retries   []time.Duration // waits before attempts 2..n
	client    *http.Client

	mu        sync.Mutex
	firstSeen map[string]time.Time // alert id -> when the notifier first saw it needing attention
	notified  map[string]time.Time // alert id -> first notification
	lastSent  map[string]time.Time // channel|alert -> last opened/reminder notice
	resolved  []model.Alert        // resolved alerts that were notified, sent at the next tick
	sending   sync.WaitGroup

	// send delivers one rendered message (tests replace it).
	send func(ctx context.Context, ch store.Channel, n notice) error
}

func newNotifier(h *Hub) *notifier {
	n := &notifier{h: h, groupWait: 30 * time.Second, retries: []time.Duration{10 * time.Second, time.Minute},
		client:    &http.Client{Timeout: 15 * time.Second},
		firstSeen: map[string]time.Time{}, notified: map[string]time.Time{}, lastSent: map[string]time.Time{}}
	n.send = n.deliver
	return n
}

func (n *notifier) load(ctx context.Context) error {
	m, err := n.h.store.NotifiedAlerts(ctx)
	if err != nil {
		return err
	}
	n.mu.Lock()
	n.notified = m
	n.mu.Unlock()
	return nil
}

// alertsChanged is called with every alert transition (ingest, watchdog).
func (n *notifier) alertsChanged(ch rules.Changes) {
	if len(ch.Resolved) == 0 {
		return
	}
	n.mu.Lock()
	defer n.mu.Unlock()
	for _, a := range ch.Resolved {
		delete(n.firstSeen, a.ID)
		if _, ok := n.notified[a.ID]; ok {
			delete(n.notified, a.ID)
			n.resolved = append(n.resolved, model.BuildAlertFor(a, nil, n.h.now()))
		}
		for k := range n.lastSent {
			if strings.HasSuffix(k, "|"+a.ID) {
				delete(n.lastSent, k)
			}
		}
	}
}

// run evaluates the notifications every 5 s until ctx ends.
func (n *notifier) run(ctx context.Context) {
	t := time.NewTicker(5 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			n.sending.Wait()
			return
		case <-t.C:
			n.tick(ctx, n.h.now())
		}
	}
}

// matches reports whether a channel takes an alert.
func matches(c store.Channel, a model.Alert, group string) bool {
	if !c.Enabled {
		return false
	}
	if c.MinSeverity == rules.SevCritical && a.Severity != rules.SevCritical {
		return false
	}
	if len(c.Groups) == 0 {
		return true
	}
	for _, g := range c.Groups {
		if strings.EqualFold(g, group) {
			return true
		}
	}
	return false
}

func (n *notifier) tick(ctx context.Context, now time.Time) {
	channels, err := n.h.store.ListChannels(ctx)
	if err != nil {
		n.h.log.Error("notifications: channels", "err", err)
		return
	}
	snap := n.h.snapshot()
	hosts := map[string]*model.ServerState{}
	groups := map[string]string{}
	for _, s := range snap {
		hosts[s.ID] = s
		groups[s.ID] = s.Group
	}
	type batchKey struct{ ch, kind string }
	batches := map[batchKey][]model.Alert{}
	var newlyNotified []string

	n.mu.Lock()
	open := n.h.alerts.AllOpen()
	stillOpen := map[string]bool{}
	for _, a := range open {
		stillOpen[a.ID] = true
		b := model.BuildAlertFor(a, hosts[a.Server], now)
		if !b.Attention {
			delete(n.firstSeen, a.ID) // the wait starts again when it needs attention
			continue
		}
		first, seen := n.firstSeen[a.ID]
		if !seen {
			first = now
			n.firstSeen[a.ID] = now
		}
		notifiedAt, wasNotified := n.notified[a.ID]
		if !wasNotified {
			if now.Sub(first) < n.groupWait {
				continue
			}
			for _, c := range channels {
				if matches(c, b, groups[a.Server]) {
					batches[batchKey{c.ID, noticeOpened}] = append(batches[batchKey{c.ID, noticeOpened}], b)
					n.lastSent[c.ID+"|"+a.ID] = now
				}
			}
			n.notified[a.ID] = now
			newlyNotified = append(newlyNotified, a.ID)
			continue
		}
		for _, c := range channels {
			if c.ReminderMin <= 0 || !matches(c, b, groups[a.Server]) {
				continue
			}
			last, ok := n.lastSent[c.ID+"|"+a.ID]
			if !ok {
				last = notifiedAt
			}
			if now.Sub(last) >= time.Duration(c.ReminderMin)*time.Minute {
				batches[batchKey{c.ID, noticeReminder}] = append(batches[batchKey{c.ID, noticeReminder}], b)
				n.lastSent[c.ID+"|"+a.ID] = now
			}
		}
	}
	for id := range n.firstSeen {
		if !stillOpen[id] {
			delete(n.firstSeen, id)
		}
	}
	resolved := n.resolved
	n.resolved = nil
	n.mu.Unlock()

	for _, a := range resolved {
		for _, c := range channels {
			if c.SendResolved && matches(c, a, groups[a.Server]) {
				batches[batchKey{c.ID, noticeResolved}] = append(batches[batchKey{c.ID, noticeResolved}], a)
			}
		}
	}
	for _, id := range newlyNotified {
		if err := n.h.store.SetAlertNotified(ctx, id, now); err != nil {
			n.h.log.Error("notifications: mark notified", "alert", id, "err", err)
		}
	}
	byID := map[string]store.Channel{}
	for _, c := range channels {
		byID[c.ID] = c
	}
	keys := make([]batchKey, 0, len(batches))
	for k := range batches {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool { return keys[i].ch+keys[i].kind < keys[j].ch+keys[j].kind })
	for _, k := range keys {
		n.dispatch(ctx, byID[k.ch], notice{kind: k.kind, alerts: batches[k], hosts: groups})
	}
}

// dispatch sends a notice in the background with retries, recording each
// attempt in the delivery log.
func (n *notifier) dispatch(ctx context.Context, c store.Channel, msg notice) {
	n.sending.Add(1)
	go func() {
		defer n.sending.Done()
		ids := make([]string, len(msg.alerts))
		for i, a := range msg.alerts {
			ids[i] = a.ID
		}
		summary := subject(msg)
		for attempt := 1; ; attempt++ {
			sctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 20*time.Second)
			err := n.send(sctx, c, msg)
			cancel()
			d := store.Delivery{ChannelID: c.ID, At: n.h.now(), Kind: msg.kind, AlertIDs: ids, Summary: summary, OK: err == nil, Attempt: attempt}
			if err != nil {
				d.Error = truncateErr(err)
			}
			if derr := n.h.store.AddDelivery(context.WithoutCancel(ctx), d); derr != nil {
				n.h.log.Error("notifications: delivery log", "err", derr)
			}
			if err == nil {
				return
			}
			n.h.log.Warn("notification failed", "channel", c.Name, "kind", msg.kind, "attempt", attempt, "err", d.Error)
			if attempt > len(n.retries) {
				return
			}
			select {
			case <-ctx.Done():
				return
			case <-time.After(n.retries[attempt-1]):
			}
		}
	}()
}

func truncateErr(err error) string {
	s := err.Error()
	if len(s) > 400 {
		s = s[:400] + "…"
	}
	return s
}

// ---- rendering ----------------------------------------------------------------------

// subject is the one-line summary of a notice.
func subject(msg notice) string {
	a := msg.alerts
	prefix := map[string]string{noticeResolved: "Resolved: ", noticeReminder: "Still open: ", noticeTest: ""}[msg.kind]
	if len(a) == 1 {
		return prefix + where(a[0]) + a[0].Title
	}
	servers := map[string]bool{}
	for _, x := range a {
		servers[x.Server] = true
	}
	if len(servers) == 1 {
		return fmt.Sprintf("%s%s%d alerts", prefix, where(a[0]), len(a))
	}
	return fmt.Sprintf("%s%d alerts on %d hosts", prefix, len(a), len(servers))
}

func where(a model.Alert) string {
	if a.Server == "" {
		return ""
	}
	return a.Server + ": "
}

// alertURL links to the alert's host page section (or the alerts page).
func (n *notifier) alertURL(a model.Alert) string {
	base := n.h.cfg.PublicURL
	if base == "" {
		return ""
	}
	if a.Server == "" {
		return base + "/alerts"
	}
	tab := map[string]string{"#storage": "storage", "#temps": "sensors", "#virtualization": "virtualization", "#guests": "guests", "#agent": "agent"}
	u := base + "/servers/" + url.PathEscape(a.Server)
	if a.Link != nil {
		if t := tab[*a.Link]; t != "" {
			u += "?tab=" + t
		} else if *a.Link == rules.LinkSystem {
			u += rules.LinkSystem // the System card of the summary
		}
	}
	return u
}

// body is the plain-text message: one line per alert, with its link.
func (n *notifier) body(msg notice) string {
	var b strings.Builder
	for i, a := range msg.alerts {
		if i > 0 {
			b.WriteString("\n")
		}
		sev := strings.ToUpper(a.Severity)
		if msg.kind == noticeResolved {
			sev = "RESOLVED"
		}
		fmt.Fprintf(&b, "[%s] %s%s", sev, where(a), a.Title)
		if a.Detail != "" {
			b.WriteString(" (" + a.Detail + ")")
		}
		if u := n.alertURL(a); u != "" && len(msg.alerts) <= 5 {
			b.WriteString("\n" + u)
		}
	}
	if msg.kind == noticeTest {
		b.Reset()
		b.WriteString("Test notification from Rackoon. If you can read this, the channel works.")
		if n.h.cfg.PublicURL != "" {
			b.WriteString("\n" + n.h.cfg.PublicURL)
		}
	}
	return b.String()
}

func worst(alerts []model.Alert) string {
	for _, a := range alerts {
		if a.Severity == rules.SevCritical {
			return rules.SevCritical
		}
	}
	return rules.SevWarning
}

// ---- delivery per kind ----------------------------------------------------------

type channelOptions struct {
	Format  string            `json:"format,omitempty"`  // webhook: rackoon | alertmanager
	Headers map[string]string `json:"headers,omitempty"` // webhook: extra request headers
	Token   string            `json:"token,omitempty"`   // ntfy: access token
}

func parseOptions(s string) channelOptions {
	var o channelOptions
	if s != "" {
		_ = json.Unmarshal([]byte(s), &o)
	}
	return o
}

func (n *notifier) deliver(ctx context.Context, c store.Channel, msg notice) error {
	switch c.Kind {
	case store.ChannelShoutrrr:
		return shoutrrr.SendContext(ctx, c.URL, n.body(msg), &types.Params{"title": "Rackoon: " + subject(msg)})
	case store.ChannelNtfy:
		return n.sendNtfy(ctx, c, msg)
	case store.ChannelWebhook:
		return n.sendWebhook(ctx, c, msg)
	}
	return fmt.Errorf("unknown channel kind %q", c.Kind)
}

func (n *notifier) post(ctx context.Context, u string, body []byte, hdr map[string]string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, u, bytes.NewReader(body))
	if err != nil {
		return err
	}
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	req.Header.Set("User-Agent", "Rackoon/"+Version)
	resp, err := n.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 300))
		return fmt.Errorf("%s: %s", resp.Status, strings.TrimSpace(string(b)))
	}
	return nil
}

// sendNtfy publishes to an ntfy topic URL (https://ntfy.sh/<topic> or a
// self-hosted server) as JSON: priority from the severity, tags, a click
// target, and for a single open alert an Acknowledge button that calls the
// hub through a signed link.
func (n *notifier) sendNtfy(ctx context.Context, c store.Channel, msg notice) error {
	u, err := url.Parse(c.URL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || strings.Trim(u.Path, "/") == "" {
		return errors.New("ntfy URL must be http(s)://server/topic")
	}
	topic := strings.Trim(u.Path, "/")
	u.Path = "/"
	prio, tags := 3, []string{"warning"}
	switch {
	case msg.kind == noticeResolved:
		prio, tags = 2, []string{"white_check_mark"}
	case msg.kind == noticeTest:
		prio, tags = 3, []string{"bell"}
	case worst(msg.alerts) == rules.SevCritical:
		prio, tags = 5, []string{"rotating_light"}
	}
	doc := map[string]any{"topic": topic, "title": "Rackoon: " + subject(msg), "message": n.body(msg), "priority": prio, "tags": tags}
	if len(msg.alerts) == 1 {
		if click := n.alertURL(msg.alerts[0]); click != "" {
			doc["click"] = click
			actions := []map[string]any{{"action": "view", "label": "Open", "url": click}}
			if msg.kind != noticeResolved && n.h.cfg.PublicURL != "" {
				if link, err := n.h.ackLink(msg.alerts[0].ID); err == nil {
					actions = append(actions, map[string]any{"action": "http", "label": "Acknowledge", "url": link, "method": "POST", "clear": true})
				}
			}
			doc["actions"] = actions
		}
	}
	b, _ := json.Marshal(doc)
	hdr := map[string]string{"Content-Type": "application/json"}
	if t := parseOptions(c.Options).Token; t != "" {
		hdr["Authorization"] = "Bearer " + t
	}
	return n.post(ctx, u.String(), b, hdr)
}

// sendWebhook POSTs JSON: Rackoon's own document, or the Alertmanager
// webhook format (version 4) so existing receivers and templates work.
func (n *notifier) sendWebhook(ctx context.Context, c store.Channel, msg notice) error {
	o := parseOptions(c.Options)
	var doc any
	status := "firing"
	if msg.kind == noticeResolved {
		status = "resolved"
	}
	if o.Format == "alertmanager" {
		var alerts []map[string]any
		for _, a := range msg.alerts {
			am := map[string]any{
				"status":       status,
				"labels":       map[string]string{"alertname": a.Rule, "server": a.Server, "severity": a.Severity, "group": msg.hosts[a.Server]},
				"annotations":  map[string]string{"summary": a.Title, "description": a.Detail},
				"startsAt":     time.Time(a.OpenedAt).UTC().Format(time.RFC3339),
				"endsAt":       "0001-01-01T00:00:00Z",
				"generatorURL": n.alertURL(a),
				"fingerprint":  a.ID,
			}
			if a.ResolvedAt != nil {
				am["endsAt"] = time.Time(*a.ResolvedAt).UTC().Format(time.RFC3339)
			}
			alerts = append(alerts, am)
		}
		doc = map[string]any{"version": "4", "status": status, "receiver": c.Name, "groupKey": "rackoon", "externalURL": n.h.cfg.PublicURL,
			"groupLabels": map[string]string{}, "commonLabels": map[string]string{}, "commonAnnotations": map[string]string{}, "alerts": alerts}
	} else {
		type item struct {
			model.Alert
			URL   string `json:"url,omitempty"`
			Group string `json:"group,omitempty"`
		}
		items := make([]item, len(msg.alerts))
		for i, a := range msg.alerts {
			items[i] = item{Alert: a, URL: n.alertURL(a), Group: msg.hosts[a.Server]}
		}
		doc = map[string]any{"version": 1, "source": "rackoon", "event": msg.kind, "status": status, "title": subject(msg),
			"hub": n.h.cfg.PublicURL, "alerts": items}
	}
	b, _ := json.Marshal(doc)
	hdr := map[string]string{"Content-Type": "application/json"}
	for k, v := range o.Headers {
		hdr[k] = v
	}
	return n.post(ctx, c.URL, b, hdr)
}

// ---- signed acknowledge links ----------------------------------------------------------

// ackLinkTTL is how long an Acknowledge button in a notification works.
const ackLinkTTL = 7 * 24 * time.Hour

func (h *Hub) ackKey(ctx context.Context) ([]byte, error) {
	if v, ok, err := h.store.GetMeta(ctx, "ack_link_key"); err != nil {
		return nil, err
	} else if ok {
		return hex.DecodeString(v)
	}
	k := make([]byte, 32)
	if _, err := rand.Read(k); err != nil {
		return nil, err
	}
	if err := h.store.SetMeta(ctx, "ack_link_key", hex.EncodeToString(k)); err != nil {
		return nil, err
	}
	return k, nil
}

func ackMAC(key []byte, id string, exp int64) string {
	m := hmac.New(sha256.New, key)
	fmt.Fprintf(m, "ack|%s|%d", id, exp)
	return base64.RawURLEncoding.EncodeToString(m.Sum(nil)[:20])
}

// ackLink is the URL an Acknowledge button POSTs to.
func (h *Hub) ackLink(id string) (string, error) {
	key, err := h.ackKey(context.Background())
	if err != nil {
		return "", err
	}
	exp := h.now().Add(ackLinkTTL).Unix()
	return fmt.Sprintf("%s/api/v1/alerts/%s/ack-link?e=%d&t=%s", h.cfg.PublicURL, url.PathEscape(id), exp, ackMAC(key, id, exp)), nil
}

// serveAckLink is POST /api/v1/alerts/{id}/ack-link?e=&t=: acknowledges an
// alert from a notification's button (no session: the link is the
// credential; it names one alert and expires).
func (h *Hub) serveAckLink(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	exp, _ := strconv.ParseInt(r.URL.Query().Get("e"), 10, 64)
	key, err := h.ackKey(r.Context())
	if err != nil || exp < h.now().Unix() || !hmac.Equal([]byte(ackMAC(key, id, exp)), []byte(r.URL.Query().Get("t"))) {
		writeProblem(w, apiErr(http.StatusForbidden, "invalid_link", "This link expired or is not valid."))
		return
	}
	cur, ok := h.alerts.Find(id)
	if !ok {
		writeProblem(w, apiErr(http.StatusNotFound, "alert_not_open", "The alert is no longer open."))
		return
	}
	ack := &rules.Ack{At: h.now(), By: "notification link", Note: ""}
	if err := h.store.SetAlertAck(r.Context(), id, ack); err != nil {
		writeProblem(w, apiErr(http.StatusInternalServerError, "internal", "Internal error."))
		return
	}
	a, _ := h.alerts.SetAck(cur.Server, id, ack)
	h.auditSystem(r.Context(), store.AuditRecord{Event: "alert.acknowledged", Outcome: "ok", User: "notification link",
		ClientIP: clientIP(r), Server: a.Server, Details: map[string]string{"alert_id": id, "via": "link"}})
	h.bus.Publish("alert.updated", h.buildAlert(a))
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	fmt.Fprintln(w, "Acknowledged:", a.Title)
}

// ---- hub heartbeat (dead-man switch) ------------------------------------------------------

// heartbeat pings the configured URL so an external monitor (Healthchecks,
// Uptime Kuma push, a cron monitor) notices when the hub itself stops.
func (h *Hub) heartbeat(ctx context.Context) {
	u, ok, _ := h.store.GetMeta(ctx, "heartbeat_url")
	if !ok || u == "" {
		return
	}
	every := 5
	if v, ok, _ := h.store.GetMeta(ctx, "heartbeat_minutes"); ok {
		if n, err := strconv.Atoi(v); err == nil && n >= 1 && n <= 60 {
			every = n
		}
	}
	h.hbMu.Lock()
	due := h.now().Sub(h.hbLast) >= time.Duration(every)*time.Minute
	if due {
		h.hbLast = h.now()
	}
	failing := h.hbFailing
	h.hbMu.Unlock()
	if !due {
		return
	}
	cctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(cctx, http.MethodGet, u, nil)
	if err == nil {
		req.Header.Set("User-Agent", "Rackoon/"+Version)
		var resp *http.Response
		resp, err = http.DefaultClient.Do(req)
		if err == nil {
			resp.Body.Close()
			if resp.StatusCode/100 != 2 {
				err = errors.New(resp.Status)
			}
		}
	}
	h.hbMu.Lock()
	h.hbFailing = err != nil
	h.hbMu.Unlock()
	// Log failures and the first success after them (not every ping).
	if err != nil || failing {
		d := store.Delivery{ChannelID: "heartbeat", At: h.now(), Kind: "heartbeat", Summary: "Hub heartbeat", OK: err == nil}
		if err != nil {
			d.Error = truncateErr(err)
			h.log.Warn("hub heartbeat failed", "err", err)
		}
		_ = h.store.AddDelivery(ctx, d)
	}
}
