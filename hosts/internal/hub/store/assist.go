package store

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"rackoon/internal/rules"
)

// AssistSession is one investigation of the assistant (docs/ASSIST.md).
type AssistSession struct {
	ID              string
	Title           string
	ServerID        string // "" = fleet-wide
	ServerName      string
	AlertID         string
	Provider        string
	Model           string
	State           string
	Access          string
	Auto            bool
	CreatedBy       string
	CreatedAt       time.Time
	UpdatedAt       time.Time
	ProviderSession string // the CLI's session / thread, to resume
	Summary         string
	Resolved        *bool
	CostUSD         *float64
}

// AssistEvent is one entry of an investigation's transcript; Data is the
// event's JSON.
type AssistEvent struct {
	Seq  int64
	At   time.Time
	Kind string
	Data string
}

const assistCols = `id, title, server_id, server_name, alert_id, provider, model, state, access, auto, created_by, created_at,
	updated_at, provider_session, summary, resolved, cost_usd`

func scanAssist(row interface{ Scan(...any) error }) (AssistSession, error) {
	var a AssistSession
	var ca, ua int64
	var resolved sql.NullBool
	var cost sql.NullFloat64
	err := row.Scan(&a.ID, &a.Title, &a.ServerID, &a.ServerName, &a.AlertID, &a.Provider, &a.Model, &a.State, &a.Access,
		&a.Auto, &a.CreatedBy, &ca, &ua, &a.ProviderSession, &a.Summary, &resolved, &cost)
	if errors.Is(err, sql.ErrNoRows) {
		return a, ErrNotFound
	}
	a.CreatedAt, a.UpdatedAt = fromMS(ca), fromMS(ua)
	if resolved.Valid {
		v := resolved.Bool
		a.Resolved = &v
	}
	if cost.Valid {
		v := cost.Float64
		a.CostUSD = &v
	}
	return a, err
}

// PutAssistSession inserts or replaces an investigation.
func (s *Store) PutAssistSession(ctx context.Context, a AssistSession) error {
	var resolved, cost any
	if a.Resolved != nil {
		resolved = b2i(*a.Resolved)
	}
	if a.CostUSD != nil {
		cost = *a.CostUSD
	}
	_, err := s.w.ExecContext(ctx, `INSERT INTO assist_sessions (`+assistCols+`)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET title = excluded.title, state = excluded.state, model = excluded.model,
			updated_at = excluded.updated_at, provider_session = excluded.provider_session, summary = excluded.summary,
			resolved = excluded.resolved, cost_usd = excluded.cost_usd`,
		a.ID, a.Title, a.ServerID, a.ServerName, a.AlertID, a.Provider, a.Model, a.State, a.Access, b2i(a.Auto), a.CreatedBy,
		ms(a.CreatedAt), ms(a.UpdatedAt), a.ProviderSession, a.Summary, resolved, cost)
	return err
}

// GetAssistSession returns one investigation.
func (s *Store) GetAssistSession(ctx context.Context, id string) (AssistSession, error) {
	return scanAssist(s.r.QueryRowContext(ctx, `SELECT `+assistCols+` FROM assist_sessions WHERE id = ?`, id))
}

// AssistFilter selects investigations (empty fields: any).
type AssistFilter struct {
	ServerID string
	AlertID  string
	States   []string
	Limit    int
}

// ListAssistSessions returns investigations, newest first.
func (s *Store) ListAssistSessions(ctx context.Context, f AssistFilter) ([]AssistSession, error) {
	q := `SELECT ` + assistCols + ` FROM assist_sessions WHERE 1 = 1`
	var args []any
	if f.ServerID != "" {
		q += ` AND server_id = ?`
		args = append(args, f.ServerID)
	}
	if f.AlertID != "" {
		q += ` AND alert_id = ?`
		args = append(args, f.AlertID)
	}
	if len(f.States) > 0 {
		q += ` AND state IN (?` + repeat(", ?", len(f.States)-1) + `)`
		for _, st := range f.States {
			args = append(args, st)
		}
	}
	if f.Limit <= 0 {
		f.Limit = 100
	}
	q += ` ORDER BY created_at DESC, id DESC LIMIT ?`
	args = append(args, f.Limit)
	rows, err := s.r.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []AssistSession
	for rows.Next() {
		a, err := scanAssist(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

func repeat(s string, n int) string {
	out := ""
	for i := 0; i < n; i++ {
		out += s
	}
	return out
}

// DeleteAssistSession removes an investigation and its transcript.
func (s *Store) DeleteAssistSession(ctx context.Context, id string) error {
	res, err := s.w.ExecContext(ctx, `DELETE FROM assist_sessions WHERE id = ?`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// PruneAssistSessions deletes investigations created before t.
func (s *Store) PruneAssistSessions(ctx context.Context, before time.Time) (int64, error) {
	res, err := s.w.ExecContext(ctx, `DELETE FROM assist_sessions WHERE created_at < ?`, ms(before))
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// AddAssistEvent appends an event and returns its sequence number.
func (s *Store) AddAssistEvent(ctx context.Context, session string, at time.Time, kind, data string) (int64, error) {
	var seq int64
	err := s.w.QueryRowContext(ctx, `INSERT INTO assist_events (session_id, seq, at, kind, data)
		VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM assist_events WHERE session_id = ?), ?, ?, ?)
		RETURNING seq`, session, session, ms(at), kind, data).Scan(&seq)
	return seq, err
}

// AssistEvents returns an investigation's transcript in order.
func (s *Store) AssistEvents(ctx context.Context, session string) ([]AssistEvent, error) {
	rows, err := s.r.QueryContext(ctx, `SELECT seq, at, kind, data FROM assist_events WHERE session_id = ? ORDER BY seq`, session)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []AssistEvent
	for rows.Next() {
		var e AssistEvent
		var at int64
		if err := rows.Scan(&e.Seq, &at, &e.Kind, &e.Data); err != nil {
			return nil, err
		}
		e.At = fromMS(at)
		out = append(out, e)
	}
	return out, rows.Err()
}

// MarkAssistInterrupted leaves investigations that were running when the
// hub stopped waiting for the user, and returns how many there were.
func (s *Store) MarkAssistInterrupted(ctx context.Context, at time.Time) ([]string, error) {
	rows, err := s.w.QueryContext(ctx, `UPDATE assist_sessions SET state = 'idle', updated_at = ?
		WHERE state IN ('starting', 'running', 'waiting') RETURNING id`, ms(at))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// GetAlert returns one alert, open or resolved.
func (s *Store) GetAlert(ctx context.Context, id string) (rules.Alert, error) {
	a, err := scanAlert(s.r.QueryRowContext(ctx, `SELECT `+alertCols+` FROM alerts WHERE id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return a, ErrNotFound
	}
	return a, err
}
