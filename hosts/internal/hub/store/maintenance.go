package store

import (
	"context"
	"database/sql"
	"errors"
	"strconv"
	"strings"
	"time"
)

// Maintenance scopes.
const (
	ScopeServer = "server"
	ScopeGroup  = "group"
	ScopeAll    = "all"
)

// Maintenance is a window in which a host's (or a group's) alerts stay
// visible but send no notifications and do not count as needing attention.
// One-off: StartsAt..EndsAt. Weekly: on Weekdays (0 = Sunday) from
// StartMinute (minutes after midnight in TZ) for DurationMin, from StartsAt
// on.
type Maintenance struct {
	ID          string
	Scope       string // server | group | all
	Target      string // server id or group name
	StartsAt    time.Time
	EndsAt      time.Time // one-off windows; zero for weekly ones
	Weekdays    []int
	StartMinute int
	DurationMin int
	TZ          string
	Note        string
	CreatedBy   string
	CreatedAt   time.Time
}

// Recurring reports whether the window repeats weekly.
func (m Maintenance) Recurring() bool { return len(m.Weekdays) > 0 && m.DurationMin > 0 }

func (m Maintenance) loc() *time.Location {
	if l, err := time.LoadLocation(m.TZ); err == nil && m.TZ != "" {
		return l
	}
	return time.UTC
}

// ActiveAt returns whether the window covers t and when that occurrence ends.
func (m Maintenance) ActiveAt(t time.Time) (bool, time.Time) {
	if t.Before(m.StartsAt) {
		return false, time.Time{}
	}
	if !m.Recurring() {
		return !m.EndsAt.IsZero() && t.Before(m.EndsAt), m.EndsAt
	}
	lt := t.In(m.loc())
	// An occurrence may have started on one of the previous days (windows
	// longer than a day, or ones that cross midnight).
	for back := 0; back <= 7; back++ {
		day := time.Date(lt.Year(), lt.Month(), lt.Day()-back, 0, 0, 0, 0, lt.Location())
		if !m.onWeekday(int(day.Weekday())) {
			continue
		}
		start := day.Add(time.Duration(m.StartMinute) * time.Minute)
		end := start.Add(time.Duration(m.DurationMin) * time.Minute)
		if !lt.Before(start) && lt.Before(end) {
			return true, end
		}
	}
	return false, time.Time{}
}

// Next returns the start of the next occurrence after t (zero: none).
func (m Maintenance) Next(t time.Time) time.Time {
	if !m.Recurring() {
		if t.Before(m.StartsAt) {
			return m.StartsAt
		}
		return time.Time{}
	}
	if t.Before(m.StartsAt) {
		t = m.StartsAt
	}
	lt := t.In(m.loc())
	for d := 0; d <= 7; d++ {
		day := time.Date(lt.Year(), lt.Month(), lt.Day()+d, 0, 0, 0, 0, lt.Location())
		if !m.onWeekday(int(day.Weekday())) {
			continue
		}
		start := day.Add(time.Duration(m.StartMinute) * time.Minute)
		if start.After(lt) {
			return start
		}
	}
	return time.Time{}
}

func (m Maintenance) onWeekday(d int) bool {
	for _, w := range m.Weekdays {
		if w == d {
			return true
		}
	}
	return false
}

func weekdaysString(w []int) string {
	parts := make([]string, len(w))
	for i, d := range w {
		parts[i] = strconv.Itoa(d)
	}
	return strings.Join(parts, ",")
}

func parseWeekdays(s string) []int {
	var out []int
	for _, p := range strings.Split(s, ",") {
		if d, err := strconv.Atoi(strings.TrimSpace(p)); err == nil && d >= 0 && d <= 6 {
			out = append(out, d)
		}
	}
	return out
}

const maintCols = `id, scope, target, starts_at, COALESCE(ends_at, 0), weekdays, start_minute, duration_min, tz, note, created_by, created_at`

func scanMaint(row interface{ Scan(...any) error }) (Maintenance, error) {
	var m Maintenance
	var sa, ea, ca int64
	var wd string
	err := row.Scan(&m.ID, &m.Scope, &m.Target, &sa, &ea, &wd, &m.StartMinute, &m.DurationMin, &m.TZ, &m.Note, &m.CreatedBy, &ca)
	if errors.Is(err, sql.ErrNoRows) {
		return m, ErrNotFound
	}
	m.StartsAt, m.EndsAt, m.CreatedAt, m.Weekdays = fromMS(sa), fromMS(ea), fromMS(ca), parseWeekdays(wd)
	return m, err
}

// ListMaintenance returns every window.
func (s *Store) ListMaintenance(ctx context.Context) ([]Maintenance, error) {
	rows, err := s.r.QueryContext(ctx, `SELECT `+maintCols+` FROM maintenance ORDER BY starts_at`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Maintenance
	for rows.Next() {
		m, err := scanMaint(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// PutMaintenance inserts or replaces a window.
func (s *Store) PutMaintenance(ctx context.Context, m Maintenance) error {
	_, err := s.w.ExecContext(ctx, `INSERT INTO maintenance(id, scope, target, starts_at, ends_at, weekdays, start_minute,
		duration_min, tz, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET scope = excluded.scope, target = excluded.target, starts_at = excluded.starts_at,
		ends_at = excluded.ends_at, weekdays = excluded.weekdays, start_minute = excluded.start_minute,
		duration_min = excluded.duration_min, tz = excluded.tz, note = excluded.note`,
		m.ID, m.Scope, m.Target, ms(m.StartsAt), nullMS(m.EndsAt), weekdaysString(m.Weekdays), m.StartMinute, m.DurationMin,
		m.TZ, m.Note, m.CreatedBy, ms(m.CreatedAt))
	return err
}

// DeleteMaintenance removes a window.
func (s *Store) DeleteMaintenance(ctx context.Context, id string) error {
	res, err := s.w.ExecContext(ctx, `DELETE FROM maintenance WHERE id = ?`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// DeleteEndedMaintenance removes one-off windows that ended before t.
func (s *Store) DeleteEndedMaintenance(ctx context.Context, t time.Time) error {
	_, err := s.w.ExecContext(ctx, `DELETE FROM maintenance WHERE weekdays = '' AND ends_at IS NOT NULL AND ends_at < ?`, ms(t))
	return err
}
