package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"time"
)

// Check kinds besides proto's http / tcp / ping / dns.
const CheckHeartbeat = "heartbeat" // a cron job or script pings the hub

// Check is a configured availability check.
type Check struct {
	ID             string
	Name           string
	Kind           string // http | tcp | ping | dns | heartbeat
	Target         string
	Runner         string // "hub" or a server id (the agent runs it from its network)
	IntervalS      int    // probes: how often; heartbeat: the expected period
	TimeoutS       int
	Options        CheckOptions
	Token          string // heartbeat: the secret in the ping URL
	GraceS         int    // heartbeat: tolerated lateness
	Enabled        bool
	ProbeRev       string // changes when a probe needs new results
	ProbeChangedAt time.Time
	Owner          string // optional owner assigned when the check is created
	CreatedBy      string
	CreatedAt      time.Time
}

// CheckOptions are the kind-specific settings.
type CheckOptions struct {
	ExpectStatus string `json:"expect_status,omitempty"`
	Keyword      string `json:"keyword,omitempty"`
	TLS          bool   `json:"tls,omitempty"`
	InsecureTLS  bool   `json:"insecure,omitempty"`
	DNSType      string `json:"dns_type,omitempty"`
	DNSServer    string `json:"dns_server,omitempty"`
	Expect       string `json:"expect,omitempty"`
	CertWarnDays int    `json:"cert_warn_days,omitempty"` // default 14
}

const checkCols = `id, name, kind, target, runner, interval_s, timeout_s, options, token, grace_s, enabled, created_by, created_at, owner, probe_rev, probe_changed_at`

func scanCheck(row interface{ Scan(...any) error }) (Check, error) {
	var c Check
	var opts string
	var ca, probeChangedAt int64
	err := row.Scan(&c.ID, &c.Name, &c.Kind, &c.Target, &c.Runner, &c.IntervalS, &c.TimeoutS, &opts, &c.Token, &c.GraceS,
		&c.Enabled, &c.CreatedBy, &ca, &c.Owner, &c.ProbeRev, &probeChangedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return c, ErrNotFound
	}
	if opts != "" {
		_ = json.Unmarshal([]byte(opts), &c.Options)
	}
	c.CreatedAt = fromMS(ca)
	c.ProbeChangedAt = fromMS(probeChangedAt)
	if c.ProbeChangedAt.IsZero() {
		// An older hub can create a check after the additive migration ran.
		c.ProbeChangedAt = c.CreatedAt
	}
	return c, err
}

// ListChecks returns every check.
func (s *Store) ListChecks(ctx context.Context) ([]Check, error) {
	rows, err := s.r.QueryContext(ctx, `SELECT `+checkCols+` FROM checks ORDER BY name, id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Check
	for rows.Next() {
		c, err := scanCheck(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// PutCheck inserts or replaces a check.
func (s *Store) PutCheck(ctx context.Context, c Check) error {
	if c.ProbeChangedAt.IsZero() {
		c.ProbeChangedAt = c.CreatedAt
	}
	opts, _ := json.Marshal(c.Options)
	_, err := s.w.ExecContext(ctx, `INSERT INTO checks(`+checkCols+`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET name = excluded.name, kind = excluded.kind, target = excluded.target,
		runner = excluded.runner, interval_s = excluded.interval_s, timeout_s = excluded.timeout_s, options = excluded.options,
		token = excluded.token, grace_s = excluded.grace_s, enabled = excluded.enabled, probe_rev = excluded.probe_rev,
		probe_changed_at = excluded.probe_changed_at`,
		c.ID, c.Name, c.Kind, c.Target, c.Runner, c.IntervalS, c.TimeoutS, string(opts), c.Token, c.GraceS, b2i(c.Enabled),
		c.CreatedBy, ms(c.CreatedAt), c.Owner, c.ProbeRev, ms(c.ProbeChangedAt))
	return err
}

// DeleteCheck removes a check, its state and its history.
func (s *Store) DeleteCheck(ctx context.Context, id string) error {
	res, err := s.w.ExecContext(ctx, `DELETE FROM checks WHERE id = ?`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return s.DeleteSeriesOf(ctx, CheckSeriesOwner(id))
}

// CheckSeriesOwner is the series owner of a check's history ("check:<id>").
func CheckSeriesOwner(id string) string { return "check:" + id }

// CheckPeriod reports whether samples were taken and whether any failed.
// Check samples have second precision, and adjacent periods share a boundary.
func (s *Store) CheckPeriod(ctx context.Context, id string, since, until time.Time) (seen, failed bool, err error) {
	var lowest sql.NullFloat64
	err = s.r.QueryRowContext(ctx, `SELECT MIN(value) FROM metrics_raw
		WHERE series_id = (SELECT id FROM series WHERE server_id = ? AND name = 'up')
		AND ts > ? AND ts <= ?`, CheckSeriesOwner(id), since.Unix(), until.Unix()).Scan(&lowest)
	return lowest.Valid, lowest.Valid && lowest.Float64 == 0, err
}

// SaveCheckState stores a check's latest result (JSON) and since when its
// state (ok / failing) holds.
func (s *Store) SaveCheckState(ctx context.Context, id string, result []byte, since time.Time) error {
	_, err := s.w.ExecContext(ctx, `INSERT INTO check_state(check_id, result, since) VALUES (?, ?, ?)
		ON CONFLICT(check_id) DO UPDATE SET result = excluded.result, since = excluded.since`, id, result, ms(since))
	return err
}

// CheckStates returns the stored results by check id.
func (s *Store) CheckStates(ctx context.Context) (map[string][]byte, map[string]time.Time, error) {
	rows, err := s.r.QueryContext(ctx, `SELECT check_id, result, since FROM check_state`)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	res, since := map[string][]byte{}, map[string]time.Time{}
	for rows.Next() {
		var id string
		var b []byte
		var at int64
		if err := rows.Scan(&id, &b, &at); err != nil {
			return nil, nil, err
		}
		res[id], since[id] = b, fromMS(at)
	}
	return res, since, rows.Err()
}

// DeleteSeriesOf removes every series (and its samples) of an owner.
func (s *Store) DeleteSeriesOf(ctx context.Context, owner string) error {
	ids, err := s.seriesOfServer(ctx, owner)
	if err != nil {
		return err
	}
	tx, err := s.w.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, sid := range ids {
		for _, t := range []string{"metrics_raw", "metrics_1m", "metrics_15m"} {
			if _, err := tx.ExecContext(ctx, `DELETE FROM `+t+` WHERE series_id = ?`, sid); err != nil {
				return err
			}
		}
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM series WHERE server_id = ?`, owner); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	s.seriesMu.Lock()
	for k := range s.seriesID {
		if k.server == owner {
			delete(s.seriesID, k)
		}
	}
	s.seriesMu.Unlock()
	return nil
}
