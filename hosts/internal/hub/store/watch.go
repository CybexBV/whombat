package store

import (
	"context"
	"time"
)

// WatchOff is an alert rule switched off for a server: for all of it
// (Entity "") or for one entity (HS-194).
type WatchOff struct {
	Server string
	Rule   string
	Entity string
	By     string
	At     time.Time
}

// ListWatchOffs returns a server's switched-off rules (server "": every
// server's), by server, rule and entity.
func (s *Store) ListWatchOffs(ctx context.Context, server string) ([]WatchOff, error) {
	rows, err := s.r.QueryContext(ctx, `SELECT server_id, rule, entity, by_user, at FROM watch_offs
		WHERE ? = '' OR server_id = ? ORDER BY server_id, rule, entity`, server, server)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []WatchOff
	for rows.Next() {
		var w WatchOff
		var at int64
		if err := rows.Scan(&w.Server, &w.Rule, &w.Entity, &w.By, &at); err != nil {
			return nil, err
		}
		w.At = fromMS(at)
		out = append(out, w)
	}
	return out, rows.Err()
}

// CountWatchOffs counts a server's switched-off rules.
func (s *Store) CountWatchOffs(ctx context.Context, server string) (int, error) {
	var n int
	err := s.r.QueryRowContext(ctx, `SELECT COUNT(*) FROM watch_offs WHERE server_id = ?`, server).Scan(&n)
	return n, err
}

// PutWatchOff switches a rule off; changed is false when it already was
// (the first who and when stay). ErrNotFound: no such server.
func (s *Store) PutWatchOff(ctx context.Context, w WatchOff) (changed bool, err error) {
	res, err := s.w.ExecContext(ctx, `INSERT INTO watch_offs(server_id, rule, entity, by_user, at)
		SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM servers WHERE id = ?)
		ON CONFLICT(server_id, rule, entity) DO NOTHING`,
		w.Server, w.Rule, w.Entity, w.By, ms(w.At), w.Server)
	if err != nil {
		return false, err
	}
	if n, _ := res.RowsAffected(); n > 0 {
		return true, nil
	}
	var exists int
	if err := s.w.QueryRowContext(ctx, `SELECT COUNT(*) FROM servers WHERE id = ?`, w.Server).Scan(&exists); err != nil {
		return false, err
	}
	if exists == 0 {
		return false, ErrNotFound
	}
	return false, nil
}

// DeleteWatchOff switches a rule back on; changed is false when it was not
// off.
func (s *Store) DeleteWatchOff(ctx context.Context, server, rule, entity string) (changed bool, err error) {
	res, err := s.w.ExecContext(ctx, `DELETE FROM watch_offs WHERE server_id = ? AND rule = ? AND entity = ?`,
		server, rule, entity)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

// WatchLimit replaces a rule's default threshold for a server or one entity.
type WatchLimit struct {
	Server string
	Rule   string
	Entity string
	Value  float64
}

func (s *Store) ListWatchLimits(ctx context.Context, server string) ([]WatchLimit, error) {
	rows, err := s.r.QueryContext(ctx, `SELECT server_id, rule, entity, value FROM watch_limits
		WHERE ? = '' OR server_id = ? ORDER BY server_id, rule, entity`, server, server)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []WatchLimit
	for rows.Next() {
		var w WatchLimit
		if err := rows.Scan(&w.Server, &w.Rule, &w.Entity, &w.Value); err != nil {
			return nil, err
		}
		out = append(out, w)
	}
	return out, rows.Err()
}

func (s *Store) PutWatchLimit(ctx context.Context, w WatchLimit) error {
	_, err := s.w.ExecContext(ctx, `INSERT INTO watch_limits(server_id, rule, entity, value) VALUES (?, ?, ?, ?)
		ON CONFLICT(server_id, rule, entity) DO UPDATE SET value = excluded.value`, w.Server, w.Rule, w.Entity, w.Value)
	return err
}

func (s *Store) DeleteWatchLimit(ctx context.Context, server, rule, entity string) error {
	_, err := s.w.ExecContext(ctx, `DELETE FROM watch_limits WHERE server_id = ? AND rule = ? AND entity = ?`, server, rule, entity)
	return err
}
