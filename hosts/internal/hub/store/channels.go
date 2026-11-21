package store

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"

	"rackoon/internal/rules"
)

// Channel kinds.
const (
	ChannelShoutrrr = "shoutrrr" // any Shoutrrr service URL (discord://, telegram://, smtp://, …)
	ChannelWebhook  = "webhook"  // HTTP POST of a JSON document
	ChannelNtfy     = "ntfy"     // ntfy topic URL, with priorities, tags and action buttons
)

// Channel is a notification destination. URL holds secrets (tokens,
// passwords) and is never returned by the API in full.
type Channel struct {
	ID           string
	Name         string
	Kind         string
	URL          string
	MinSeverity  string   // warning (everything) | critical
	Groups       []string // empty: every group
	SendResolved bool
	ReminderMin  int // 0: no reminders
	Enabled      bool
	Options      string // JSON, kind-specific
	CreatedBy    string
	CreatedAt    time.Time
}

const channelCols = `id, name, kind, url, min_severity, groups, send_resolved, reminder_min, enabled, options, created_by, created_at`

func scanChannel(row interface{ Scan(...any) error }) (Channel, error) {
	var c Channel
	var groups string
	var ca int64
	err := row.Scan(&c.ID, &c.Name, &c.Kind, &c.URL, &c.MinSeverity, &groups, &c.SendResolved, &c.ReminderMin, &c.Enabled,
		&c.Options, &c.CreatedBy, &ca)
	if errors.Is(err, sql.ErrNoRows) {
		return c, ErrNotFound
	}
	c.CreatedAt = fromMS(ca)
	for _, g := range strings.Split(groups, "\n") {
		if g = strings.TrimSpace(g); g != "" {
			c.Groups = append(c.Groups, g)
		}
	}
	return c, err
}

// ListChannels returns every channel.
func (s *Store) ListChannels(ctx context.Context) ([]Channel, error) {
	rows, err := s.r.QueryContext(ctx, `SELECT `+channelCols+` FROM channels ORDER BY created_at`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Channel
	for rows.Next() {
		c, err := scanChannel(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// GetChannel returns one channel.
func (s *Store) GetChannel(ctx context.Context, id string) (Channel, error) {
	return scanChannel(s.r.QueryRowContext(ctx, `SELECT `+channelCols+` FROM channels WHERE id = ?`, id))
}

// PutChannel inserts or replaces a channel.
func (s *Store) PutChannel(ctx context.Context, c Channel) error {
	_, err := s.w.ExecContext(ctx, `INSERT INTO channels(`+channelCols+`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET name = excluded.name, kind = excluded.kind, url = excluded.url,
		min_severity = excluded.min_severity, groups = excluded.groups, send_resolved = excluded.send_resolved,
		reminder_min = excluded.reminder_min, enabled = excluded.enabled, options = excluded.options`,
		c.ID, c.Name, c.Kind, c.URL, c.MinSeverity, strings.Join(c.Groups, "\n"), b2i(c.SendResolved), c.ReminderMin, b2i(c.Enabled),
		c.Options, c.CreatedBy, ms(c.CreatedAt))
	return err
}

// DeleteChannel removes a channel (its deliveries stay in the log).
func (s *Store) DeleteChannel(ctx context.Context, id string) error {
	res, err := s.w.ExecContext(ctx, `DELETE FROM channels WHERE id = ?`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// Delivery is one notification attempt.
type Delivery struct {
	ID        int64
	ChannelID string
	At        time.Time
	Kind      string // opened | resolved | reminder | test | heartbeat
	AlertIDs  []string
	Summary   string
	OK        bool
	Error     string
	Attempt   int
}

// AddDelivery records an attempt.
func (s *Store) AddDelivery(ctx context.Context, d Delivery) error {
	_, err := s.w.ExecContext(ctx, `INSERT INTO deliveries(channel_id, at, kind, alert_ids, summary, ok, error, attempt)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, d.ChannelID, ms(d.At), d.Kind, strings.Join(d.AlertIDs, ","), d.Summary, b2i(d.OK),
		d.Error, d.Attempt)
	return err
}

// ListDeliveries returns the newest attempts (channelID "" = all).
func (s *Store) ListDeliveries(ctx context.Context, channelID string, limit int) ([]Delivery, error) {
	if limit <= 0 {
		limit = 100
	}
	limit = min(limit, 500)
	q := `SELECT id, channel_id, at, kind, alert_ids, summary, ok, error, attempt FROM deliveries`
	var args []any
	if channelID != "" {
		q += ` WHERE channel_id = ?`
		args = append(args, channelID)
	}
	q += ` ORDER BY id DESC LIMIT ?`
	args = append(args, limit)
	rows, err := s.r.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Delivery
	for rows.Next() {
		var d Delivery
		var at int64
		var ids string
		if err := rows.Scan(&d.ID, &d.ChannelID, &at, &d.Kind, &ids, &d.Summary, &d.OK, &d.Error, &d.Attempt); err != nil {
			return nil, err
		}
		d.At = fromMS(at)
		if ids != "" {
			d.AlertIDs = strings.Split(ids, ",")
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

// PruneDeliveries keeps 30 days of the log.
func (s *Store) PruneDeliveries(ctx context.Context, now time.Time) error {
	_, err := s.w.ExecContext(ctx, `DELETE FROM deliveries WHERE at < ?`, ms(now.Add(-30*24*time.Hour)))
	return err
}

// SetAlertNotified records the first notification of an alert.
func (s *Store) SetAlertNotified(ctx context.Context, id string, at time.Time) error {
	_, err := s.w.ExecContext(ctx, `UPDATE alerts SET notified_at = ? WHERE id = ?`, ms(at), id)
	return err
}

// NotifiedAlerts returns the notification time of open alerts that were
// notified (to restore the dispatcher after a restart).
func (s *Store) NotifiedAlerts(ctx context.Context) (map[string]time.Time, error) {
	rows, err := s.r.QueryContext(ctx, `SELECT id, notified_at FROM alerts WHERE state = ? AND notified_at IS NOT NULL`, rules.AlertOpen)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]time.Time{}
	for rows.Next() {
		var id string
		var at int64
		if err := rows.Scan(&id, &at); err != nil {
			return nil, err
		}
		out[id] = fromMS(at)
	}
	return out, rows.Err()
}

// WasNotified reports whether an alert (open or resolved) was notified.
func (s *Store) WasNotified(ctx context.Context, id string) (bool, error) {
	var at sql.NullInt64
	err := s.r.QueryRowContext(ctx, `SELECT notified_at FROM alerts WHERE id = ?`, id).Scan(&at)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return at.Valid, err
}
