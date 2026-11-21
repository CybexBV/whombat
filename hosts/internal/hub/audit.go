package hub

import (
	"context"
	"encoding/csv"
	"fmt"
	"net/http"
	"strconv"
	"time"

	"rackoon/internal/hub/store"
)

// audit appends a record (fills id and time). Never pass tokens,
// keystrokes, clipboard or screen content.
func (h *Hub) audit(ctx context.Context, rec store.AuditRecord) (string, error) {
	if rec.ID == "" {
		rec.ID = newID("au_")
	}
	if rec.At.IsZero() {
		rec.At = h.now()
	}
	if err := h.store.AppendAudit(ctx, rec); err != nil {
		h.log.Error("audit write failed", "event", rec.Event, "err", err)
		return "", err
	}
	return rec.ID, nil
}

// auditReq audits on behalf of the request's user.
func (h *Hub) auditReq(r *http.Request, p *principal, rec store.AuditRecord) (string, error) {
	if p != nil {
		rec.User, rec.Role = p.user.Username, p.user.Role
	}
	rec.ClientIP = clientIP(r)
	rec.UserAgent = cleanText(r.UserAgent(), 256)
	return h.audit(r.Context(), rec)
}

// auditUser audits with an explicit user name (login, setup).
func (h *Hub) auditUser(r *http.Request, user, role string, rec store.AuditRecord) {
	rec.User, rec.Role = user, role
	rec.ClientIP = clientIP(r)
	rec.UserAgent = cleanText(r.UserAgent(), 256)
	_, _ = h.audit(r.Context(), rec)
}

// auditSystem audits an event without a browser user.
func (h *Hub) auditSystem(ctx context.Context, rec store.AuditRecord) {
	_, _ = h.audit(ctx, rec)
}

// auditJSON is the API shape of an audit record (REMOTE-CONSOLE.md 8).
type auditJSON struct {
	ID        string            `json:"id"`
	At        string            `json:"at"`
	User      *string           `json:"user"`
	Role      *string           `json:"role"`
	ClientIP  *string           `json:"client_ip"`
	UserAgent *string           `json:"user_agent"`
	Server    *string           `json:"server"`
	Guest     *string           `json:"guest"`
	Platform  *string           `json:"platform"`
	Event     string            `json:"event"`
	Protocol  *string           `json:"protocol"`
	Outcome   string            `json:"outcome"`
	Code      *string           `json:"code"`
	DurationS *float64          `json:"duration_s"`
	BytesIn   *int64            `json:"bytes_in"`
	BytesOut  *int64            `json:"bytes_out"`
	Details   map[string]string `json:"details"`
}

func sp(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func toAuditJSON(r store.AuditRecord) auditJSON {
	d := r.Details
	if d == nil {
		d = map[string]string{}
	}
	return auditJSON{ID: r.ID, At: r.At.UTC().Format(time.RFC3339Nano), User: sp(r.User), Role: sp(r.Role),
		ClientIP: sp(r.ClientIP), UserAgent: sp(r.UserAgent), Server: sp(r.Server), Guest: sp(r.Guest),
		Platform: sp(r.Platform), Event: r.Event, Protocol: sp(r.Protocol), Outcome: r.Outcome, Code: sp(r.Code),
		DurationS: r.DurationS, BytesIn: r.BytesIn, BytesOut: r.BytesOut, Details: d}
}

func (h *Hub) apiAudit(w http.ResponseWriter, r *http.Request, p *principal) error {
	q := r.URL.Query()
	limit, _ := strconv.Atoi(q.Get("limit"))
	cursor, _ := strconv.ParseInt(q.Get("cursor"), 10, 64)
	recs, next, err := h.store.ListAudit(r.Context(), limit, cursor, store.AuditFilter{Server: q.Get("server"), Event: q.Get("event")})
	if err != nil {
		return err
	}
	items := make([]auditJSON, 0, len(recs))
	for _, rec := range recs {
		items = append(items, toAuditJSON(rec))
	}
	var nc any
	if next > 0 {
		nc = strconv.FormatInt(next, 10)
	}
	writeJSON(w, r, http.StatusOK, map[string]any{"items": items, "next_cursor": nc})
	return nil
}

func (h *Hub) apiAuditExport(w http.ResponseWriter, r *http.Request, p *principal) error {
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="rackoon-audit-%s.csv"`, h.now().UTC().Format("20060102-150405")))
	w.Header().Set("Cache-Control", "no-store")
	cw := csv.NewWriter(w)
	_ = cw.Write([]string{"id", "at", "user", "role", "client_ip", "user_agent", "server", "guest", "platform", "event",
		"protocol", "outcome", "code", "duration_s", "bytes_in", "bytes_out", "details"})
	var cursor int64
	for {
		recs, next, err := h.store.ListAudit(r.Context(), 1000, cursor, store.AuditFilter{Server: r.URL.Query().Get("server"), Event: r.URL.Query().Get("event")})
		if err != nil {
			// Headers are sent: end with a marker row so a truncated export
			// cannot pass for a complete one.
			_ = cw.Write([]string{"#", "", "", "", "", "", "", "", "", "export.incomplete", "", "error", "database_error", "", "", "", csvSafe(err.Error())})
			cw.Flush()
			h.log.Error("audit export truncated", "err", err)
			return nil
		}
		for _, rec := range recs {
			f := func(v *float64) string {
				if v == nil {
					return ""
				}
				return strconv.FormatFloat(*v, 'f', -1, 64)
			}
			i := func(v *int64) string {
				if v == nil {
					return ""
				}
				return strconv.FormatInt(*v, 10)
			}
			det := ""
			for k, v := range rec.Details {
				if det != "" {
					det += "; "
				}
				det += k + "=" + v
			}
			_ = cw.Write([]string{rec.ID, rec.At.UTC().Format(time.RFC3339Nano), csvSafe(rec.User), rec.Role, rec.ClientIP,
				csvSafe(rec.UserAgent), csvSafe(rec.Server), csvSafe(rec.Guest), rec.Platform, rec.Event, rec.Protocol,
				rec.Outcome, rec.Code, f(rec.DurationS), i(rec.BytesIn), i(rec.BytesOut), csvSafe(det)})
		}
		cw.Flush()
		if next == 0 {
			break
		}
		cursor = next
	}
	h.auditReq(r, p, store.AuditRecord{Event: "audit.exported", Outcome: "ok"})
	return nil
}

// csvSafe defuses spreadsheet formula injection in attacker-influenced cells.
func csvSafe(s string) string {
	if s != "" && (s[0] == '=' || s[0] == '+' || s[0] == '-' || s[0] == '@' || s[0] == '\t' || s[0] == '\r') {
		return "'" + s
	}
	return s
}
