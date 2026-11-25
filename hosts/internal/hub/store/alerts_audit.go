package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"strings"
	"time"

	"rackoon/internal/rules"
)

// ---- Alerts -----------------------------------------------------------------

const alertCols = `id, server_id, key, rule, entity, severity, title, detail, banner_title, banner_detail, link,
	status_note, state, opened_at, COALESCE(resolved_at, 0), COALESCE(ack_at, 0), ack_by, ack_note, COALESCE(ack_until, 0)`

func scanAlert(row interface{ Scan(...any) error }) (rules.Alert, error) {
	var a rules.Alert
	var oa, ra, aa, au int64
	var by, note string
	err := row.Scan(&a.ID, &a.Server, &a.Key, &a.Rule, &a.Entity, &a.Severity, &a.Title, &a.Detail, &a.BannerTitle,
		&a.BannerDetail, &a.Link, &a.StatusNote, &a.State, &oa, &ra, &aa, &by, &note, &au)
	a.OpenedAt = fromMS(oa)
	if ra != 0 {
		t := fromMS(ra)
		a.ResolvedAt = &t
	}
	if aa != 0 {
		a.Ack = &rules.Ack{At: fromMS(aa), By: by, Note: note}
		if au != 0 {
			t := fromMS(au)
			a.Ack.Until = &t
		}
	}
	return a, err
}

// SetAlertAck stores (ack non-nil) or clears an acknowledgement.
func (s *Store) SetAlertAck(ctx context.Context, id string, ack *rules.Ack) error {
	if ack == nil {
		_, err := s.w.ExecContext(ctx, `UPDATE alerts SET ack_at = NULL, ack_by = '', ack_note = '', ack_until = NULL WHERE id = ?`, id)
		return err
	}
	var until any
	if ack.Until != nil {
		until = ack.Until.UnixMilli()
	}
	_, err := s.w.ExecContext(ctx, `UPDATE alerts SET ack_at = ?, ack_by = ?, ack_note = ?, ack_until = ? WHERE id = ?`,
		ms(ack.At), ack.By, ack.Note, until, id)
	return err
}

// AlertFilter narrows QueryAlerts.
type AlertFilter struct {
	State         string   // open | resolved | "" (all)
	Servers       []string // nil: any (an empty non-nil list matches nothing)
	Severity      string
	Rule          string    // exact, or a prefix ending in "."
	Query         string    // substring of title or detail
	Since         time.Time // opened at or after
	OverlapsSince time.Time // unresolved or resolved at or after
	Until         time.Time
	Before        time.Time // opened strictly before (paging, newest first)
	Limit         int
}

// QueryAlerts returns alerts newest first, filtered in SQL.
func (s *Store) QueryAlerts(ctx context.Context, f AlertFilter) ([]rules.Alert, error) {
	var where []string
	var args []any
	if f.State != "" {
		where, args = append(where, "state = ?"), append(args, f.State)
	}
	if f.Servers != nil {
		if len(f.Servers) == 0 {
			return nil, nil
		}
		ph := make([]string, len(f.Servers))
		for i, id := range f.Servers {
			ph[i] = "?"
			args = append(args, id)
		}
		where = append(where, "server_id IN ("+strings.Join(ph, ",")+")")
	}
	if f.Severity != "" {
		where, args = append(where, "severity = ?"), append(args, f.Severity)
	}
	if f.Rule != "" {
		if strings.HasSuffix(f.Rule, ".") {
			where, args = append(where, "rule LIKE ? ESCAPE '\\'"), append(args, escapeLike(f.Rule)+"%")
		} else {
			where, args = append(where, "rule = ?"), append(args, f.Rule)
		}
	}
	if f.Query != "" {
		q := "%" + escapeLike(strings.ToLower(f.Query)) + "%"
		where, args = append(where, "(lower(title) LIKE ? ESCAPE '\\' OR lower(detail) LIKE ? ESCAPE '\\')"), append(args, q, q)
	}
	if !f.Since.IsZero() {
		where, args = append(where, "opened_at >= ?"), append(args, ms(f.Since))
	}
	if !f.OverlapsSince.IsZero() {
		where, args = append(where, "(resolved_at IS NULL OR resolved_at >= ?)"), append(args, ms(f.OverlapsSince))
	}
	if !f.Until.IsZero() {
		where, args = append(where, "opened_at < ?"), append(args, ms(f.Until))
	}
	if !f.Before.IsZero() {
		where, args = append(where, "opened_at < ?"), append(args, ms(f.Before))
	}
	q := `SELECT ` + alertCols + ` FROM alerts`
	if len(where) > 0 {
		q += " WHERE " + strings.Join(where, " AND ")
	}
	limit := f.Limit
	if limit <= 0 {
		limit = 200
	}
	limit = min(limit, 1000)
	q += " ORDER BY opened_at DESC, id LIMIT ?"
	args = append(args, limit)
	rows, err := s.r.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []rules.Alert
	for rows.Next() {
		a, err := scanAlert(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// InsertAlert stores a newly opened alert.
func (s *Store) InsertAlert(ctx context.Context, a rules.Alert) error {
	_, err := s.w.ExecContext(ctx, `INSERT INTO alerts(id, server_id, key, rule, entity, severity, title, detail,
		banner_title, banner_detail, link, status_note, state, opened_at, resolved_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		a.ID, a.Server, a.Key, a.Rule, a.Entity, a.Severity, a.Title, a.Detail, a.BannerTitle, a.BannerDetail, a.Link,
		a.StatusNote, a.State, ms(a.OpenedAt), resolvedMS(a.ResolvedAt))
	return err
}

func resolvedMS(t *time.Time) any {
	if t == nil {
		return nil
	}
	return t.UnixMilli()
}

// UpdateAlert stores the current text / severity / state of an alert.
func (s *Store) UpdateAlert(ctx context.Context, a rules.Alert) error {
	_, err := s.w.ExecContext(ctx, `UPDATE alerts SET severity = ?, title = ?, detail = ?, banner_title = ?,
		banner_detail = ?, link = ?, status_note = ?, state = ?, resolved_at = ? WHERE id = ?`,
		a.Severity, a.Title, a.Detail, a.BannerTitle, a.BannerDetail, a.Link, a.StatusNote, a.State,
		resolvedMS(a.ResolvedAt), a.ID)
	return err
}

// ListAlerts returns alerts in a state ("" = all), newest first, at most
// limit (0 = no limit).
func (s *Store) ListAlerts(ctx context.Context, state string, limit int) ([]rules.Alert, error) {
	q := `SELECT ` + alertCols + ` FROM alerts`
	var args []any
	if state != "" {
		q += ` WHERE state = ?`
		args = append(args, state)
	}
	q += ` ORDER BY opened_at DESC, id`
	if limit > 0 {
		q += ` LIMIT ?`
		args = append(args, limit)
	}
	rows, err := s.r.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []rules.Alert
	for rows.Next() {
		a, err := scanAlert(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// DeleteResolvedAlertsBefore prunes old resolved alerts.
func (s *Store) DeleteResolvedAlertsBefore(ctx context.Context, before time.Time) error {
	_, err := s.w.ExecContext(ctx, `DELETE FROM alerts WHERE state = ? AND resolved_at < ?`, rules.AlertResolved, ms(before))
	return err
}

// ---- Audit ------------------------------------------------------------------

// AuditRecord is one append-only audit entry (REMOTE-CONSOLE.md section 8).
type AuditRecord struct {
	Seq       int64
	ID        string
	At        time.Time
	User      string
	Role      string
	ClientIP  string
	UserAgent string
	Server    string
	Guest     string
	Platform  string
	Event     string
	Protocol  string
	Outcome   string // ok | denied | error
	Code      string
	DurationS *float64
	BytesIn   *int64
	BytesOut  *int64
	Details   map[string]string
}

// AppendAudit appends a record.
func (s *Store) AppendAudit(ctx context.Context, r AuditRecord) error {
	var details string
	if len(r.Details) > 0 {
		b, err := json.Marshal(r.Details)
		if err != nil {
			return err
		}
		details = string(b)
	}
	_, err := s.w.ExecContext(ctx, `INSERT INTO audit(id, at, user, role, client_ip, user_agent, server, guest, platform,
		event, protocol, outcome, code, duration_s, bytes_in, bytes_out, details)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		r.ID, ms(r.At), r.User, r.Role, r.ClientIP, r.UserAgent, r.Server, r.Guest, r.Platform, r.Event, r.Protocol,
		r.Outcome, r.Code, r.DurationS, r.BytesIn, r.BytesOut, details)
	return err
}

// AuditFilter narrows ListAudit.
type AuditFilter struct {
	Server string
	Event  string // exact event or prefix ending in "."
	Since  time.Time
}

// ListAudit returns records newest first, starting before cursor (seq; 0 =
// newest). next is the cursor for the following page (0 = none).
func (s *Store) ListAudit(ctx context.Context, limit int, cursor int64, f AuditFilter) (recs []AuditRecord, next int64, err error) {
	if limit <= 0 {
		limit = 100
	}
	limit = min(limit, 1000)
	var where []string
	var args []any
	if cursor > 0 {
		where, args = append(where, "seq < ?"), append(args, cursor)
	}
	if f.Server != "" {
		where, args = append(where, "server = ?"), append(args, f.Server)
	}
	if f.Event != "" {
		if strings.HasSuffix(f.Event, ".") {
			where, args = append(where, "event LIKE ? ESCAPE '\\'"), append(args, escapeLike(f.Event)+"%")
		} else {
			where, args = append(where, "event = ?"), append(args, f.Event)
		}
	}
	if !f.Since.IsZero() {
		where, args = append(where, "at >= ?"), append(args, ms(f.Since))
	}
	q := `SELECT seq, id, at, user, role, client_ip, user_agent, server, guest, platform, event, protocol, outcome, code,
		duration_s, bytes_in, bytes_out, details FROM audit`
	if len(where) > 0 {
		q += " WHERE " + strings.Join(where, " AND ")
	}
	q += " ORDER BY seq DESC LIMIT ?"
	args = append(args, limit+1)
	rows, err := s.r.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	for rows.Next() {
		var r AuditRecord
		var at int64
		var dur sql.NullFloat64
		var bi, bo sql.NullInt64
		var details string
		if err := rows.Scan(&r.Seq, &r.ID, &at, &r.User, &r.Role, &r.ClientIP, &r.UserAgent, &r.Server, &r.Guest,
			&r.Platform, &r.Event, &r.Protocol, &r.Outcome, &r.Code, &dur, &bi, &bo, &details); err != nil {
			return nil, 0, err
		}
		r.At = fromMS(at)
		if dur.Valid {
			r.DurationS = &dur.Float64
		}
		if bi.Valid {
			r.BytesIn = &bi.Int64
		}
		if bo.Valid {
			r.BytesOut = &bo.Int64
		}
		if details != "" {
			_ = json.Unmarshal([]byte(details), &r.Details)
		}
		recs = append(recs, r)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, err
	}
	if len(recs) > limit {
		recs = recs[:limit]
		next = recs[len(recs)-1].Seq
	}
	return recs, next, nil
}

func escapeLike(s string) string {
	r := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)
	return r.Replace(s)
}

// AuditMinAge is the youngest audit record the database lets go (the
// audit_no_delete trigger refuses records younger than 366 days).
const AuditMinAge = 366 * 24 * time.Hour

// DeleteAuditBefore prunes audit records older than before. The cut-off
// is clamped to at least AuditMinAge plus a day before now, so the
// statement never touches a record the trigger protects (one such record
// would abort the whole delete).
func (s *Store) DeleteAuditBefore(ctx context.Context, before, now time.Time) error {
	if limit := now.Add(-AuditMinAge - 24*time.Hour); before.After(limit) {
		before = limit
	}
	_, err := s.w.ExecContext(ctx, `DELETE FROM audit WHERE at < ?`, ms(before))
	return err
}
