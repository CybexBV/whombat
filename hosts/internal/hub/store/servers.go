package store

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"
)

// Server is an enrolled host.
type Server struct {
	ID        string
	Hostname  string
	Group     string
	Location  string
	RCConsole bool // hub-side remote control toggles (off by default)
	RCPower   bool
	// Host access (root shell, host reboot): separate toggles, off by default.
	RCHostShell bool
	RCHostPower bool
	// RCManage: guest configuration and lifecycle (docs/MANAGE.md), off by
	// default like the others.
	RCManage bool
	// RCDiagnose: the assistant's read-only checks (docs/ASSIST.md), on by
	// default unlike the others.
	RCDiagnose bool
	// Parent is the host this host runs on (a VM or container of another
	// enrolled host): "" = detected automatically, "-" = none, else a
	// server id. Its offline alerts are suppressed while the parent is down.
	Parent     string
	CertSerial string // hex serial of the current client certificate
	// PrevCertSerial is the certificate the agent used before a renewal;
	// accepted until the agent connects with CertSerial.
	PrevCertSerial string
	CertNotAfter   time.Time
	MachineID      string
	CreatedAt      time.Time
	LastSeen       time.Time // zero: never
	AgentVersion   string
	Address        string
}

const serverCols = `id, hostname, grp, location, rc_console, rc_power, cert_serial, cert_not_after,
	machine_id, created_at, COALESCE(last_seen, 0), agent_version, address, prev_cert_serial, rc_host_shell, rc_host_power, parent, rc_manage, rc_diagnose`

func scanServer(row interface{ Scan(...any) error }) (Server, error) {
	var s Server
	var na, ca, ls int64
	err := row.Scan(&s.ID, &s.Hostname, &s.Group, &s.Location, &s.RCConsole, &s.RCPower, &s.CertSerial, &na,
		&s.MachineID, &ca, &ls, &s.AgentVersion, &s.Address, &s.PrevCertSerial, &s.RCHostShell, &s.RCHostPower, &s.Parent, &s.RCManage, &s.RCDiagnose)
	if errors.Is(err, sql.ErrNoRows) {
		return s, ErrNotFound
	}
	s.CertNotAfter, s.CreatedAt, s.LastSeen = fromMS(na), fromMS(ca), fromMS(ls)
	return s, err
}

// ListServers returns all servers in card order (approval order).
func (s *Store) ListServers(ctx context.Context) ([]Server, error) {
	rows, err := s.r.QueryContext(ctx, `SELECT `+serverCols+` FROM servers ORDER BY created_at, id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Server
	for rows.Next() {
		sv, err := scanServer(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, sv)
	}
	return out, rows.Err()
}

// GetServer returns one server.
func (s *Store) GetServer(ctx context.Context, id string) (Server, error) {
	return scanServer(s.r.QueryRowContext(ctx, `SELECT `+serverCols+` FROM servers WHERE id = ?`, id))
}

// ServerExists reports whether a server id is taken.
func (s *Store) ServerExists(ctx context.Context, id string) (bool, error) {
	var n int
	err := s.r.QueryRowContext(ctx, `SELECT COUNT(*) FROM servers WHERE id = ?`, id).Scan(&n)
	return n > 0, err
}

// ServerSettings are the editable settings of a server (nil = unchanged).
type ServerSettings struct {
	Group, Location, Parent                                *string
	Console, Power, HostShell, HostPower, Manage, Diagnose *bool
}

// UpdateServerSettings changes group, location and the remote control
// toggles (nil = unchanged) and returns the new row.
func (s *Store) UpdateServerSettings(ctx context.Context, id string, group, location *string, console, power *bool) (Server, error) {
	return s.UpdateServer(ctx, id, ServerSettings{Group: group, Location: location, Console: console, Power: power})
}

// UpdateServer changes a server's settings and returns the new row.
func (s *Store) UpdateServer(ctx context.Context, id string, st ServerSettings) (Server, error) {
	group, location, console, power := st.Group, st.Location, st.Console, st.Power
	var sets []string
	var args []any
	if st.Parent != nil {
		sets, args = append(sets, "parent = ?"), append(args, *st.Parent)
	}
	if st.HostShell != nil {
		sets, args = append(sets, "rc_host_shell = ?"), append(args, b2i(*st.HostShell))
	}
	if st.HostPower != nil {
		sets, args = append(sets, "rc_host_power = ?"), append(args, b2i(*st.HostPower))
	}
	if st.Manage != nil {
		sets, args = append(sets, "rc_manage = ?"), append(args, b2i(*st.Manage))
	}
	if st.Diagnose != nil {
		sets, args = append(sets, "rc_diagnose = ?"), append(args, b2i(*st.Diagnose))
	}
	if group != nil {
		sets, args = append(sets, "grp = ?"), append(args, *group)
	}
	if location != nil {
		sets, args = append(sets, "location = ?"), append(args, *location)
	}
	if console != nil {
		sets, args = append(sets, "rc_console = ?"), append(args, b2i(*console))
	}
	if power != nil {
		sets, args = append(sets, "rc_power = ?"), append(args, b2i(*power))
	}
	if len(sets) > 0 {
		args = append(args, id)
		res, err := s.w.ExecContext(ctx, `UPDATE servers SET `+strings.Join(sets, ", ")+` WHERE id = ?`, args...)
		if err != nil {
			return Server{}, err
		}
		if n, _ := res.RowsAffected(); n == 0 {
			return Server{}, ErrNotFound
		}
	}
	return scanServer(s.w.QueryRowContext(ctx, `SELECT `+serverCols+` FROM servers WHERE id = ?`, id))
}

// UpdateServerCert records a renewed client certificate; prev is the
// serial the agent connected with (still accepted until the new one is used).
func (s *Store) UpdateServerCert(ctx context.Context, id, serial string, notAfter time.Time, prev string) error {
	res, err := s.w.ExecContext(ctx, `UPDATE servers SET cert_serial = ?, cert_not_after = ?, prev_cert_serial = ? WHERE id = ?`,
		serial, ms(notAfter), prev, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// ClearPrevSerial forgets the pre-renewal certificate.
func (s *Store) ClearPrevSerial(ctx context.Context, id string) error {
	_, err := s.w.ExecContext(ctx, `UPDATE servers SET prev_cert_serial = '' WHERE id = ?`, id)
	return err
}

// UpdateServerSeen records the last heartbeat and agent metadata.
func (s *Store) UpdateServerSeen(ctx context.Context, id string, lastSeen time.Time, agentVersion, address, hostname string) error {
	_, err := s.w.ExecContext(ctx, `UPDATE servers SET last_seen = ?,
		agent_version = CASE WHEN ? = '' THEN agent_version ELSE ? END,
		address = CASE WHEN ? = '' THEN address ELSE ? END,
		hostname = CASE WHEN ? = '' THEN hostname ELSE ? END
		WHERE id = ?`, ms(lastSeen), agentVersion, agentVersion, address, address, hostname, hostname, id)
	return err
}

// DeleteServer removes a server, its latest report and alerts, and its
// metrics. The audit log is kept.
func (s *Store) DeleteServer(ctx context.Context, id string) error {
	ids, err := s.seriesOfServer(ctx, id)
	if err != nil {
		return err
	}
	gids, err := s.guestSeriesIDs(ctx, id)
	if err != nil {
		return err
	}
	ids = append(ids, gids...)
	tx, err := s.w.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	res, err := tx.ExecContext(ctx, `DELETE FROM servers WHERE id = ?`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	for _, q := range []string{
		`DELETE FROM server_reports WHERE server_id = ?`,
		`DELETE FROM alerts WHERE server_id = ?`,
		`DELETE FROM series WHERE server_id = ?`,
	} {
		if _, err := tx.ExecContext(ctx, q, id); err != nil {
			return err
		}
	}
	gp := guestOwnerPrefix(id)
	if _, err := tx.ExecContext(ctx, `DELETE FROM series WHERE substr(server_id, 1, ?) = ?`, len(gp), gp); err != nil {
		return err
	}
	for _, sid := range ids {
		for _, t := range []string{"metrics_raw", "metrics_1m", "metrics_15m"} {
			if _, err := tx.ExecContext(ctx, `DELETE FROM `+t+` WHERE series_id = ?`, sid); err != nil {
				return err
			}
		}
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	s.seriesMu.Lock()
	for k := range s.seriesID {
		if k.server == id || strings.HasPrefix(k.server, gp) {
			delete(s.seriesID, k)
		}
	}
	s.seriesMu.Unlock()
	return nil
}

// SaveReport stores the latest report (CBOR) of a server.
func (s *Store) SaveReport(ctx context.Context, id string, at time.Time, blob []byte) error {
	_, err := s.w.ExecContext(ctx, `INSERT INTO server_reports(server_id, at, report) VALUES (?, ?, ?)
		ON CONFLICT(server_id) DO UPDATE SET at = excluded.at, report = excluded.report`, id, ms(at), blob)
	return err
}

// StoredReport is a persisted latest report.
type StoredReport struct {
	At     time.Time
	Report []byte
}

// LoadReports returns the persisted latest report of every server.
func (s *Store) LoadReports(ctx context.Context) (map[string]StoredReport, error) {
	rows, err := s.r.QueryContext(ctx, `SELECT server_id, at, report FROM server_reports`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]StoredReport{}
	for rows.Next() {
		var id string
		var at int64
		var b []byte
		if err := rows.Scan(&id, &at, &b); err != nil {
			return nil, err
		}
		out[id] = StoredReport{At: fromMS(at), Report: b}
	}
	return out, rows.Err()
}

// GetMeta reads a meta value.
func (s *Store) GetMeta(ctx context.Context, key string) (string, bool, error) {
	var v string
	err := s.r.QueryRowContext(ctx, `SELECT value FROM meta WHERE key = ?`, key).Scan(&v)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	return v, err == nil, err
}

// SetMeta writes a meta value.
func (s *Store) SetMeta(ctx context.Context, key, value string) error {
	_, err := s.w.ExecContext(ctx, `INSERT INTO meta(key, value) VALUES (?, ?)
		ON CONFLICT(key) DO UPDATE SET value = excluded.value`, key, value)
	return err
}
