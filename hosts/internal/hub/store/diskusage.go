package store

import (
	"context"
	"time"
)

// StoredDiskUsage is one persisted disk usage measurement for a server mount.
type StoredDiskUsage struct {
	ServerID   string
	Mount      string
	MeasuredAt time.Time
	Data       []byte
}

// SaveDiskUsage stores or replaces the latest disk usage measurement for one
// server and mount point.
func (s *Store) SaveDiskUsage(ctx context.Context, serverID, mount string, measuredAt time.Time, data []byte) error {
	_, err := s.w.ExecContext(ctx, `INSERT INTO server_disk_usage(server_id, mount, measured_at, data) VALUES (?, ?, ?, ?)
		ON CONFLICT(server_id, mount) DO UPDATE SET measured_at = excluded.measured_at, data = excluded.data`,
		serverID, mount, ms(measuredAt), data)
	return err
}

// LoadAllDiskUsage returns every persisted disk usage measurement across servers.
func (s *Store) LoadAllDiskUsage(ctx context.Context) ([]StoredDiskUsage, error) {
	rows, err := s.r.QueryContext(ctx, `SELECT server_id, mount, measured_at, data FROM server_disk_usage`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []StoredDiskUsage
	for rows.Next() {
		var u StoredDiskUsage
		var at int64
		if err := rows.Scan(&u.ServerID, &u.Mount, &at, &u.Data); err != nil {
			return nil, err
		}
		u.MeasuredAt = fromMS(at)
		out = append(out, u)
	}
	return out, rows.Err()
}
