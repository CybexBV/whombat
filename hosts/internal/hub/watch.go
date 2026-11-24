package hub

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"sort"
	"strconv"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	"rackoon/internal/hub/store"
	"rackoon/internal/rules"
)

// Watch settings (HS-194…HS-197): an alert rule switched off for a server,
// or for one of its entities (a disk, a mount, a guest, a sensor). An off
// rule is not evaluated there, and its open alert resolves at once.

// maxWatchOffs bounds a server's switched-off rules and exceptions.
const maxWatchOffs = 500

// maxWatchEntity bounds an entity (the alerts' entities are shorter).
const maxWatchEntity = 200

type watchKey struct{ server, rule, entity string }

// watchSet is the in-memory copy of the watch settings, read by the alert
// engine on every evaluation.
type watchSet struct {
	change sync.Mutex
	mu     sync.RWMutex
	off    map[watchKey]bool
	limits map[string]map[watchKey]float64
}

func (w *watchSet) set(l []store.WatchOff, limits []store.WatchLimit) {
	m := make(map[watchKey]bool, len(l))
	for _, o := range l {
		m[watchKey{o.Server, o.Rule, o.Entity}] = true
	}
	byServer := map[string]map[watchKey]float64{}
	for _, l := range limits {
		if byServer[l.Server] == nil {
			byServer[l.Server] = map[watchKey]float64{}
		}
		byServer[l.Server][watchKey{l.Server, l.Rule, l.Entity}] = l.Value
	}
	w.mu.Lock()
	w.off, w.limits = m, byServer
	w.mu.Unlock()
}

// isOff reports whether rule is switched off for the server as a whole or
// for this entity.
func (w *watchSet) isOff(server, rule, entity string) bool {
	w.mu.RLock()
	defer w.mu.RUnlock()
	if len(w.off) == 0 {
		return false
	}
	return w.off[watchKey{server, rule, ""}] || (entity != "" && w.off[watchKey{server, rule, entity}])
}

// Each evaluation gets one snapshot, even if the settings change mid-report.
func (w *watchSet) limitsFor(server string) rules.LimitLookup {
	w.mu.RLock()
	limits := w.limits[server]
	w.mu.RUnlock()
	if len(limits) == 0 {
		return nil
	}
	return func(rule, entity string) (float64, bool) {
		if value, ok := limits[watchKey{server, rule, entity}]; ok {
			return value, true
		}
		value, ok := limits[watchKey{server, rule, ""}]
		return value, ok
	}
}

// forget drops a deleted server's settings (the database cascades).
func (w *watchSet) forget(server string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	delete(w.limits, server)
	for k := range w.off {
		if k.server == server {
			delete(w.off, k)
		}
	}
}

func (h *Hub) reloadWatch(ctx context.Context) error {
	l, err := h.store.ListWatchOffs(ctx, "")
	if err != nil {
		return err
	}
	limits, err := h.store.ListWatchLimits(ctx, "")
	if err != nil {
		return err
	}
	h.watch.set(l, limits)
	return nil
}

// resolveWatchOff resolves the open alerts the watch settings switch off
// (after a change, and at start for a database that has some).
func (h *Hub) resolveWatchOff(ctx context.Context, server string) {
	if res := h.alerts.ResolveOff(server, h.now()); len(res) > 0 {
		for _, a := range res {
			h.log.Info("alert resolved: rule switched off", "server", a.Server, "rule", a.Rule, "entity", a.Entity)
		}
		h.applyAlerts(ctx, rules.Changes{Resolved: res})
	}
}

// watchRule is one switched-off rule in GET/PUT /servers/{id}/watch.
type watchRule struct {
	Rule   string `json:"rule"`
	Entity string `json:"entity,omitempty"` // absent: the whole rule
	Off    bool   `json:"off"`              // always true: only what is off is listed
	By     string `json:"by"`
	At     string `json:"at"`
}

type watchLimit struct {
	Rule   string  `json:"rule"`
	Entity string  `json:"entity,omitempty"`
	Value  float64 `json:"value"`
}

type watchJSON struct {
	Rules  []watchRule  `json:"rules"`
	Limits []watchLimit `json:"limits"`
}

func (h *Hub) watchOf(ctx context.Context, server string) (watchJSON, error) {
	l, err := h.store.ListWatchOffs(ctx, server)
	if err != nil {
		return watchJSON{}, err
	}
	limits, err := h.store.ListWatchLimits(ctx, server)
	if err != nil {
		return watchJSON{}, err
	}
	out := watchJSON{Rules: make([]watchRule, 0, len(l)), Limits: make([]watchLimit, 0, len(limits))}
	for _, l := range limits {
		out.Limits = append(out.Limits, watchLimit{Rule: l.Rule, Entity: l.Entity, Value: l.Value})
	}
	for _, o := range l {
		out.Rules = append(out.Rules, watchRule{Rule: o.Rule, Entity: o.Entity, Off: true, By: o.By,
			At: o.At.UTC().Format(time.RFC3339)})
	}
	sort.SliceStable(out.Rules, func(i, j int) bool {
		a, b := out.Rules[i], out.Rules[j]
		if a.Rule != b.Rule {
			return a.Rule < b.Rule
		}
		return a.Entity < b.Entity
	})
	return out, nil
}

// apiWatch is GET /servers/{id}/watch: the server's switched-off rules.
func (h *Hub) apiWatch(w http.ResponseWriter, r *http.Request, p *principal) error {
	id := r.PathValue("id")
	if _, err := h.server(id); err != nil {
		return err
	}
	out, err := h.watchOf(r.Context(), id)
	if err != nil {
		return err
	}
	writeJSON(w, r, http.StatusOK, out)
	return nil
}

// validEntity: printable UTF-8 without control characters, at most
// maxWatchEntity bytes.
func validEntity(s string) bool {
	if s == "" || len(s) > maxWatchEntity || !utf8.ValidString(s) {
		return false
	}
	for _, c := range s {
		if unicode.IsControl(c) {
			return false
		}
	}
	return true
}

// apiPutWatch is PUT /servers/{id}/watch {rule, entity?, off}: switch a
// rule off or on again for the server or one entity (operators; audited
// when it changes). The answer is the server's watch settings.
func (h *Hub) apiPutWatch(w http.ResponseWriter, r *http.Request, p *principal) error {
	id := r.PathValue("id")
	if _, err := h.server(id); err != nil {
		return err
	}
	var req struct {
		Rule     string          `json:"rule"`
		Entity   *string         `json:"entity"`
		Off      *bool           `json:"off"`
		Limit    json.RawMessage `json:"limit"`
		Expected json.RawMessage `json:"expected_limit"`
	}
	if err := decodeJSON(r, &req); err != nil {
		return err
	}
	if !rules.IsServerRule(req.Rule) {
		return apiErr(http.StatusBadRequest, "invalid_rule", "No server alert rule "+strconv.Quote(req.Rule)+".")
	}
	if (req.Off == nil) == (req.Limit == nil) || (req.Expected != nil && req.Limit == nil) {
		return apiErr(http.StatusBadRequest, "invalid_value", "Choose whether to watch the rule or change its limit.")
	}
	entity := ""
	if req.Entity != nil && *req.Entity != "" {
		if !validEntity(*req.Entity) {
			return apiErr(http.StatusBadRequest, "invalid_entity",
				"entity must be printable text of at most "+strconv.Itoa(maxWatchEntity)+" bytes.")
		}
		entity = *req.Entity
	}
	h.watch.change.Lock()
	defer h.watch.change.Unlock()
	if req.Limit != nil {
		return h.putWatchLimit(w, r, p, id, req.Rule, entity, req.Limit, req.Expected)
	}

	ctx := r.Context()
	now := h.now()
	var changed bool
	var err error
	if *req.Off {
		n, cerr := h.store.CountWatchOffs(ctx, id)
		if cerr != nil {
			return cerr
		}
		if n >= maxWatchOffs && !h.watch.isExactly(id, req.Rule, entity) {
			return apiErr(http.StatusConflict, "too_many", "A server has at most "+strconv.Itoa(maxWatchOffs)+" rules and exceptions switched off.")
		}
		changed, err = h.store.PutWatchOff(ctx, store.WatchOff{Server: id, Rule: req.Rule, Entity: entity, By: p.user.Username, At: now})
	} else {
		changed, err = h.store.DeleteWatchOff(ctx, id, req.Rule, entity)
	}
	if errors.Is(err, store.ErrNotFound) {
		return apiErr(http.StatusNotFound, "server_not_found", "No server "+strconv.Quote(id)+".")
	}
	if err != nil {
		return err
	}
	if changed {
		if err := h.reloadWatch(ctx); err != nil {
			return err
		}
		details := map[string]string{"rule": req.Rule, "off": strconv.FormatBool(*req.Off)}
		if entity != "" {
			details["entity"] = entity
		}
		h.auditReq(r, p, store.AuditRecord{Event: "server.watch_changed", Outcome: "ok", Server: id, Details: details})
		if *req.Off {
			h.resolveWatchOff(ctx, id)
		}
		ev := map[string]any{"server": id, "rule": req.Rule, "off": *req.Off}
		if entity != "" {
			ev["entity"] = entity
		}
		h.bus.Publish("watch.changed", ev)
		h.publishServerUpdated(id)
	}
	out, err := h.watchOf(ctx, id)
	if err != nil {
		return err
	}
	writeJSON(w, r, http.StatusOK, out)
	return nil
}

func (h *Hub) putWatchLimit(w http.ResponseWriter, r *http.Request, p *principal, id, rule, entity string, raw, expectedRaw json.RawMessage) error {
	var value, expected *float64
	if !rules.ValidLimitRule(rule) || json.Unmarshal(raw, &value) != nil ||
		(value != nil && !rules.ValidLimit(rule, *value)) ||
		(expectedRaw != nil && json.Unmarshal(expectedRaw, &expected) != nil) {
		return apiErr(http.StatusBadRequest, "invalid_limit", "Give a limit within this check’s range, or clear it.")
	}

	ctx := r.Context()
	h.watch.mu.RLock()
	limits := h.watch.limits[id]
	before, exists := limits[watchKey{id, rule, entity}]
	h.watch.mu.RUnlock()
	matches := func(v *float64) bool {
		if v == nil {
			return !exists
		}
		return exists && *v == before
	}
	if expectedRaw != nil && !matches(expected) {
		return apiErr(http.StatusConflict, "limit_changed", "The limit changed meanwhile.")
	}
	if !matches(value) {
		var err error
		if value == nil {
			err = h.store.DeleteWatchLimit(ctx, id, rule, entity)
		} else {
			if !exists && len(limits) >= maxWatchOffs {
				return apiErr(http.StatusConflict, "too_many", "A server has at most 500 custom limits.")
			}
			err = h.store.PutWatchLimit(ctx, store.WatchLimit{Server: id, Rule: rule, Entity: entity, Value: *value})
		}
		if err != nil {
			return err
		}
		if err := h.reloadWatch(ctx); err != nil {
			return err
		}
		details := map[string]string{"rule": rule, "limit": string(raw)}
		ev := map[string]any{"server": id, "rule": rule, "limit": value}
		if entity != "" {
			details["entity"], ev["entity"] = entity, entity
		}
		h.auditReq(r, p, store.AuditRecord{Event: "server.watch_changed", Outcome: "ok", Server: id, Details: details})
		h.bus.Publish("watch.changed", ev)
		h.publishServerUpdated(id)
	}
	out, err := h.watchOf(ctx, id)
	if err != nil {
		return err
	}
	writeJSON(w, r, http.StatusOK, out)
	return nil
}

// isExactly reports whether exactly this rule and entity is switched off
// (switching it off again is not one more).
func (w *watchSet) isExactly(server, rule, entity string) bool {
	w.mu.RLock()
	defer w.mu.RUnlock()
	return w.off[watchKey{server, rule, entity}]
}
