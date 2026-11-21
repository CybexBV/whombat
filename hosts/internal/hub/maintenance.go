package hub

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"sync"
	"time"

	"rackoon/internal/hub/model"
	"rackoon/internal/hub/store"
)

// maintenanceSet is the in-memory copy of the maintenance windows.
type maintenanceSet struct {
	mu   sync.RWMutex
	list []store.Maintenance
}

func (m *maintenanceSet) set(l []store.Maintenance) {
	m.mu.Lock()
	m.list = l
	m.mu.Unlock()
}

func (m *maintenanceSet) all() []store.Maintenance {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return append([]store.Maintenance(nil), m.list...)
}

// activeFor returns the window muting a host now (the one ending last when
// several apply).
func (m *maintenanceSet) activeFor(serverID, group string, now time.Time) *model.MaintInfo {
	m.mu.RLock()
	defer m.mu.RUnlock()
	var best *model.MaintInfo
	for _, w := range m.list {
		switch w.Scope {
		case store.ScopeServer:
			if w.Target != serverID {
				continue
			}
		case store.ScopeGroup:
			if !strings.EqualFold(w.Target, group) {
				continue
			}
		case store.ScopeAll:
		default:
			continue
		}
		if ok, end := w.ActiveAt(now); ok && (best == nil || end.After(best.Until)) {
			best = &model.MaintInfo{ID: w.ID, Until: end, Note: w.Note}
		}
	}
	return best
}

func (h *Hub) reloadMaintenance(ctx context.Context) error {
	l, err := h.store.ListMaintenance(ctx)
	if err != nil {
		return err
	}
	h.maint.set(l)
	return nil
}

type maintJSON struct {
	ID          string  `json:"id"`
	Scope       string  `json:"scope"`
	Target      string  `json:"target"`
	StartsAt    string  `json:"starts_at"`
	EndsAt      *string `json:"ends_at"`
	Weekdays    []int   `json:"weekdays"`
	StartTime   string  `json:"start_time"` // "23:00" (weekly)
	DurationMin int     `json:"duration_min"`
	TZ          string  `json:"tz"`
	Note        string  `json:"note"`
	CreatedBy   string  `json:"created_by"`
	CreatedAt   string  `json:"created_at"`
	Active      bool    `json:"active"`
	ActiveUntil *string `json:"active_until"`
	NextStart   *string `json:"next_start"`
}

func toMaintJSON(w store.Maintenance, now time.Time) maintJSON {
	out := maintJSON{ID: w.ID, Scope: w.Scope, Target: w.Target, StartsAt: w.StartsAt.UTC().Format(time.RFC3339),
		EndsAt: tsp(w.EndsAt), Weekdays: w.Weekdays, DurationMin: w.DurationMin, TZ: w.TZ, Note: w.Note,
		CreatedBy: w.CreatedBy, CreatedAt: w.CreatedAt.UTC().Format(time.RFC3339)}
	if out.Weekdays == nil {
		out.Weekdays = []int{}
	}
	if w.Recurring() {
		out.StartTime = time.Date(0, 1, 1, w.StartMinute/60, w.StartMinute%60, 0, 0, time.UTC).Format("15:04")
	}
	if ok, end := w.ActiveAt(now); ok {
		out.Active, out.ActiveUntil = true, tsp(end)
	}
	out.NextStart = tsp(w.Next(now))
	return out
}

func (h *Hub) apiMaintenance(w http.ResponseWriter, r *http.Request, p *principal) error {
	now := h.now()
	out := []maintJSON{}
	for _, m := range h.maint.all() {
		out = append(out, toMaintJSON(m, now))
	}
	writeJSON(w, r, http.StatusOK, out)
	return nil
}

type maintReq struct {
	Scope       string  `json:"scope"`
	Target      string  `json:"target"`
	StartsAt    *string `json:"starts_at"`    // RFC 3339; default now
	EndsAt      *string `json:"ends_at"`      // one-off end
	DurationMin int     `json:"duration_min"` // one-off: from starts_at; weekly: length
	Weekdays    []int   `json:"weekdays"`     // weekly
	StartTime   string  `json:"start_time"`   // weekly "HH:MM"
	TZ          string  `json:"tz"`
	Note        string  `json:"note"`
}

func (h *Hub) parseMaint(req maintReq, now time.Time) (store.Maintenance, error) {
	var m store.Maintenance
	switch req.Scope {
	case store.ScopeServer:
		if _, ok := h.snapshotOne(req.Target); !ok {
			return m, apiErr(http.StatusBadRequest, "invalid_target", "No server "+req.Target+".")
		}
	case store.ScopeGroup:
		if cleanText(req.Target, 64) == "" {
			return m, apiErr(http.StatusBadRequest, "invalid_target", "Name the group.")
		}
	case store.ScopeAll:
		req.Target = ""
	default:
		return m, apiErr(http.StatusBadRequest, "invalid_scope", "scope must be server, group or all.")
	}
	m.Scope, m.Target, m.Note, m.TZ = req.Scope, cleanText(req.Target, 64), cleanText(req.Note, 256), req.TZ
	if m.TZ == "" {
		m.TZ = "UTC"
	}
	if _, err := time.LoadLocation(m.TZ); err != nil {
		return m, apiErr(http.StatusBadRequest, "invalid_tz", "Unknown time zone "+m.TZ+".")
	}
	m.StartsAt = now
	if req.StartsAt != nil && *req.StartsAt != "" {
		t, err := time.Parse(time.RFC3339, *req.StartsAt)
		if err != nil {
			return m, apiErr(http.StatusBadRequest, "invalid_time", "starts_at must be RFC 3339.")
		}
		m.StartsAt = t
	}
	if len(req.Weekdays) > 0 {
		hh, mm, ok := parseHHMM(req.StartTime)
		if !ok {
			return m, apiErr(http.StatusBadRequest, "invalid_time", "start_time must be HH:MM.")
		}
		seen := map[int]bool{}
		for _, d := range req.Weekdays {
			if d < 0 || d > 6 {
				return m, apiErr(http.StatusBadRequest, "invalid_weekday", "weekdays are 0 (Sunday) to 6.")
			}
			if !seen[d] {
				seen[d] = true
				m.Weekdays = append(m.Weekdays, d)
			}
		}
		if req.DurationMin < 1 || req.DurationMin > 7*24*60 {
			return m, apiErr(http.StatusBadRequest, "invalid_duration", "duration_min must be 1 to 10080.")
		}
		m.StartMinute, m.DurationMin = hh*60+mm, req.DurationMin
		return m, nil
	}
	switch {
	case req.EndsAt != nil && *req.EndsAt != "":
		t, err := time.Parse(time.RFC3339, *req.EndsAt)
		if err != nil {
			return m, apiErr(http.StatusBadRequest, "invalid_time", "ends_at must be RFC 3339.")
		}
		m.EndsAt = t
	case req.DurationMin > 0:
		m.EndsAt = m.StartsAt.Add(time.Duration(req.DurationMin) * time.Minute)
	default:
		return m, apiErr(http.StatusBadRequest, "invalid_duration", "Give ends_at, duration_min, or weekdays with start_time.")
	}
	if !m.EndsAt.After(m.StartsAt) || m.EndsAt.Sub(m.StartsAt) > 366*24*time.Hour {
		return m, apiErr(http.StatusBadRequest, "invalid_duration", "The window must end after it starts, within a year.")
	}
	return m, nil
}

func parseHHMM(s string) (int, int, bool) {
	t, err := time.Parse("15:04", s)
	if err != nil {
		return 0, 0, false
	}
	return t.Hour(), t.Minute(), true
}

// apiCreateMaintenance is POST /maintenance (operators: muting is part of
// running the fleet; audited).
func (h *Hub) apiCreateMaintenance(w http.ResponseWriter, r *http.Request, p *principal) error {
	var req maintReq
	if err := decodeJSON(r, &req); err != nil {
		return err
	}
	now := h.now()
	m, err := h.parseMaint(req, now)
	if err != nil {
		return err
	}
	m.ID, m.CreatedBy, m.CreatedAt = newID("mw_"), p.user.Username, now
	if err := h.store.PutMaintenance(r.Context(), m); err != nil {
		return err
	}
	if err := h.reloadMaintenance(r.Context()); err != nil {
		return err
	}
	h.auditReq(r, p, store.AuditRecord{Event: "maintenance.created", Outcome: "ok", Server: serverOf(m),
		Details: map[string]string{"id": m.ID, "scope": m.Scope, "target": m.Target, "note": m.Note}})
	h.maintenanceChanged()
	writeJSON(w, r, http.StatusCreated, toMaintJSON(m, now))
	return nil
}

// apiDeleteMaintenance is DELETE /maintenance/{id} (also "unmute").
func (h *Hub) apiDeleteMaintenance(w http.ResponseWriter, r *http.Request, p *principal) error {
	id := r.PathValue("id")
	var target store.Maintenance
	for _, m := range h.maint.all() {
		if m.ID == id {
			target = m
		}
	}
	if err := h.store.DeleteMaintenance(r.Context(), id); errors.Is(err, store.ErrNotFound) {
		return errNotFound
	} else if err != nil {
		return err
	}
	if err := h.reloadMaintenance(r.Context()); err != nil {
		return err
	}
	h.auditReq(r, p, store.AuditRecord{Event: "maintenance.deleted", Outcome: "ok", Server: serverOf(target),
		Details: map[string]string{"id": id, "scope": target.Scope, "target": target.Target}})
	h.maintenanceChanged()
	w.WriteHeader(http.StatusNoContent)
	return nil
}

func serverOf(m store.Maintenance) string {
	if m.Scope == store.ScopeServer {
		return m.Target
	}
	return ""
}

// maintenanceChanged tells browsers to refetch (statuses and badges
// change), and sends every server's status: a muted alert no longer makes
// its server warning (HS-190).
func (h *Hub) maintenanceChanged() {
	h.bus.Publish("maintenance.changed", map[string]any{})
	for _, st := range h.snapshot() {
		h.publishServerUpdated(st.ID)
	}
}
