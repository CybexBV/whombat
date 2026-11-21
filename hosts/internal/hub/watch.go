package hub

import (
	"context"
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
	mu  sync.RWMutex
	off map[watchKey]bool
}

func (w *watchSet) set(l []store.WatchOff) {
	m := make(map[watchKey]bool, len(l))
	for _, o := range l {
		m[watchKey{o.Server, o.Rule, o.Entity}] = true
	}
	w.mu.Lock()
	w.off = m
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

// forget drops a deleted server's settings (the database cascades).
func (w *watchSet) forget(server string) {
	w.mu.Lock()
	defer w.mu.Unlock()
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
	h.watch.set(l)
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

type watchJSON struct {
	Rules []watchRule `json:"rules"`
}

func (h *Hub) watchOf(ctx context.Context, server string) (watchJSON, error) {
	l, err := h.store.ListWatchOffs(ctx, server)
	if err != nil {
		return watchJSON{}, err
	}
	out := watchJSON{Rules: make([]watchRule, 0, len(l))}
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
		Rule   string  `json:"rule"`
		Entity *string `json:"entity"`
		Off    *bool   `json:"off"`
	}
	if err := decodeJSON(r, &req); err != nil {
		return err
	}
	if !rules.IsServerRule(req.Rule) {
		return apiErr(http.StatusBadRequest, "invalid_rule", "No server alert rule "+strconv.Quote(req.Rule)+".")
	}
	if req.Off == nil {
		return apiErr(http.StatusBadRequest, "invalid_value", "off must be true or false.")
	}
	entity := ""
	if req.Entity != nil && *req.Entity != "" {
		if !validEntity(*req.Entity) {
			return apiErr(http.StatusBadRequest, "invalid_entity",
				"entity must be printable text of at most "+strconv.Itoa(maxWatchEntity)+" bytes.")
		}
		entity = *req.Entity
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

// isExactly reports whether exactly this rule and entity is switched off
// (switching it off again is not one more).
func (w *watchSet) isExactly(server, rule, entity string) bool {
	w.mu.RLock()
	defer w.mu.RUnlock()
	return w.off[watchKey{server, rule, entity}]
}
