package store

import (
	"context"
	"database/sql"
	"errors"
	"math"
	"sort"
	"strings"
	"time"
)

// Metric tiers (retention: raw 24 h, 1 min rollups 7 d, 15 min rollups 90 d;
// every rollup keeps avg, max and count).
type Tier int

const (
	TierRaw Tier = iota
	Tier1m
	Tier15m
)

// Resolution is the bucket size of a tier in seconds (raw: 1).
func (t Tier) Resolution() int64 {
	switch t {
	case Tier1m:
		return 60
	case Tier15m:
		return 900
	}
	return 1
}

func (t Tier) table() string {
	switch t {
	case Tier1m:
		return "metrics_1m"
	case Tier15m:
		return "metrics_15m"
	}
	return "metrics_raw"
}

// Retention per tier, plus a margin so that the longest range served from a
// tier (and rollup recomputation) always has its data.
const (
	RawRetention     = 24*time.Hour + 30*time.Minute
	OneMinRetention  = 7*24*time.Hour + 3*time.Hour
	FifteenRetention = 90 * 24 * time.Hour
)

// Sample is one timestamped set of series values of a server.
type Sample struct {
	TS     int64 // unix seconds
	Values map[string]float64
}

func (s *Store) seriesIDTx(ctx context.Context, tx *sql.Tx, server, name string) (int64, error) {
	k := seriesKey{server, name}
	s.seriesMu.Lock()
	id, ok := s.seriesID[k]
	s.seriesMu.Unlock()
	if ok {
		return id, nil
	}
	var n int
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM series WHERE server_id = ?`, server).Scan(&n); err != nil {
		return 0, err
	}
	if n >= MaxSeriesPerServer {
		return 0, errTooManySeries
	}
	if _, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO series(server_id, name) VALUES (?, ?)`, server, name); err != nil {
		return 0, err
	}
	if err := tx.QueryRowContext(ctx, `SELECT id FROM series WHERE server_id = ? AND name = ?`, server, name).Scan(&id); err != nil {
		return 0, err
	}
	s.seriesMu.Lock()
	s.seriesID[k] = id
	s.seriesMu.Unlock()
	return id, nil
}

// MaxSeriesPerServer bounds the series one server can create (an agent
// sending ever new names must not grow the series table without end).
const MaxSeriesPerServer = 512

var errTooManySeries = errors.New("too many series for this server")

// InsertSamples stores raw samples, ignoring (series, timestamp) pairs that
// already exist (backfill dedupe). It returns how many values were new and
// the oldest timestamp seen (for rollup recomputation).
func (s *Store) InsertSamples(ctx context.Context, server string, samples []Sample) (inserted int, minTS int64, err error) {
	if len(samples) == 0 {
		return 0, 0, nil
	}
	tx, err := s.w.BeginTx(ctx, nil)
	if err != nil {
		return 0, 0, err
	}
	defer tx.Rollback()
	stmt, err := tx.PrepareContext(ctx, `INSERT OR IGNORE INTO metrics_raw(series_id, ts, value) VALUES (?, ?, ?)`)
	if err != nil {
		return 0, 0, err
	}
	defer stmt.Close()
	minTS = math.MaxInt64
	for _, sm := range samples {
		if sm.TS < minTS {
			minTS = sm.TS
		}
		names := make([]string, 0, len(sm.Values))
		for n := range sm.Values {
			names = append(names, n)
		}
		sort.Strings(names)
		for _, n := range names {
			v := sm.Values[n]
			if math.IsNaN(v) || math.IsInf(v, 0) {
				continue
			}
			id, err := s.seriesIDTx(ctx, tx, server, n)
			if errors.Is(err, errTooManySeries) {
				continue
			}
			if err != nil {
				return 0, 0, err
			}
			res, err := stmt.ExecContext(ctx, id, sm.TS, v)
			if err != nil {
				return 0, 0, err
			}
			if k, _ := res.RowsAffected(); k > 0 {
				inserted += int(k)
			}
		}
	}
	if err := tx.Commit(); err != nil {
		// The series cache may hold ids of rolled-back inserts.
		s.seriesMu.Lock()
		s.seriesID = map[seriesKey]int64{}
		s.seriesMu.Unlock()
		return 0, 0, err
	}
	return inserted, minTS, nil
}

// SeriesNames returns the names of a server's stored series.
func (s *Store) SeriesNames(ctx context.Context, server string) (map[string]int64, error) {
	rows, err := s.r.QueryContext(ctx, `SELECT id, name FROM series WHERE server_id = ?`, server)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]int64{}
	for rows.Next() {
		var id int64
		var n string
		if err := rows.Scan(&id, &n); err != nil {
			return nil, err
		}
		out[n] = id
	}
	return out, rows.Err()
}

// SeriesByName returns the ids of a series name for many servers.
func (s *Store) SeriesByName(ctx context.Context, name string) (map[string]int64, error) {
	rows, err := s.r.QueryContext(ctx, `SELECT server_id, id FROM series WHERE name = ?`, name)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]int64{}
	for rows.Next() {
		var srv string
		var id int64
		if err := rows.Scan(&srv, &id); err != nil {
			return nil, err
		}
		out[srv] = id
	}
	return out, rows.Err()
}

func (s *Store) seriesOfServer(ctx context.Context, server string) ([]int64, error) {
	m, err := s.SeriesNames(ctx, server)
	if err != nil {
		return nil, err
	}
	ids := make([]int64, 0, len(m))
	for _, id := range m {
		ids = append(ids, id)
	}
	return ids, nil
}

// Agg aggregates samples: Sum and Count give the average, Max the peak.
type Agg struct {
	Sum   float64
	Count int64
	Max   float64
}

// Avg returns the average (NaN when empty).
func (a Agg) Avg() float64 {
	if a.Count == 0 {
		return math.NaN()
	}
	return a.Sum / float64(a.Count)
}

// Add merges b into a.
func (a *Agg) Add(b Agg) {
	if b.Count == 0 {
		return
	}
	if a.Count == 0 || b.Max > a.Max {
		a.Max = b.Max
	}
	a.Sum += b.Sum
	a.Count += b.Count
}

// Buckets aggregates the given series into n buckets of step seconds
// starting at start (bucket i covers [start+i*step, start+(i+1)*step)),
// reading from tier. start and step must be multiples of the tier
// resolution. Missing buckets have Count 0.
func (s *Store) Buckets(ctx context.Context, tier Tier, seriesIDs []int64, start, step int64, n int) (map[int64][]Agg, error) {
	out := make(map[int64][]Agg, len(seriesIDs))
	if len(seriesIDs) == 0 || n <= 0 || step <= 0 {
		return out, nil
	}
	if res := tier.Resolution(); start%res != 0 || step%res != 0 {
		return nil, errors.New("store: bucket grid not aligned to tier")
	}
	for _, id := range seriesIDs {
		out[id] = make([]Agg, n)
	}
	end := start + step*int64(n)
	sumExpr, cntExpr, maxExpr := "SUM(value)", "COUNT(*)", "MAX(value)"
	if tier != TierRaw {
		sumExpr, cntExpr, maxExpr = "SUM(avg * count)", "SUM(count)", "MAX(max)"
	}
	args := []any{start, step}
	ph := make([]string, len(seriesIDs))
	for i, id := range seriesIDs {
		ph[i] = "?"
		args = append(args, id)
	}
	args = append(args, start, end)
	q := `SELECT series_id, (ts - ?) / ? AS b, ` + sumExpr + `, ` + cntExpr + `, ` + maxExpr + ` FROM ` + tier.table() +
		` WHERE series_id IN (` + strings.Join(ph, ",") + `) AND ts >= ? AND ts < ? GROUP BY series_id, b`
	rows, err := s.r.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id, b int64
		var a Agg
		if err := rows.Scan(&id, &b, &a.Sum, &a.Count, &a.Max); err != nil {
			return nil, err
		}
		if bs := out[id]; b >= 0 && b < int64(len(bs)) {
			bs[b] = a
		}
	}
	return out, rows.Err()
}

// MaxAt returns the timestamp of the (latest) sample equal to max in
// [start, end). For rollup tiers it is the start of the rollup bucket.
func (s *Store) MaxAt(ctx context.Context, tier Tier, seriesID, start, end int64, max float64) (int64, error) {
	col := "value"
	if tier != TierRaw {
		col = "max"
	}
	var ts int64
	err := s.r.QueryRowContext(ctx, `SELECT ts FROM `+tier.table()+` WHERE series_id = ? AND ts >= ? AND ts < ? AND `+col+
		` >= ? ORDER BY ts DESC LIMIT 1`, seriesID, start, end, max).Scan(&ts)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, ErrNotFound
	}
	return ts, err
}

// Rollup recomputes the 1 min tier from raw samples and the 15 min tier
// from the 1 min tier for [from, to). from is aligned down to 15 minutes so
// that every touched 15 min bucket is recomputed completely. Upserts make it
// idempotent; partial (current) buckets are corrected by the next run.
func (s *Store) Rollup(ctx context.Context, from, to int64) error {
	from -= from % 900
	if to <= from {
		return nil
	}
	_, err := s.w.ExecContext(ctx, `INSERT INTO metrics_1m(series_id, ts, avg, max, count)
		SELECT series_id, ts - (ts % 60), AVG(value), MAX(value), COUNT(*) FROM metrics_raw
		WHERE series_id IN (SELECT id FROM series) AND ts >= ? AND ts < ?
		GROUP BY series_id, ts - (ts % 60)
		ON CONFLICT(series_id, ts) DO UPDATE SET avg = excluded.avg, max = excluded.max, count = excluded.count`, from, to)
	if err != nil {
		return err
	}
	_, err = s.w.ExecContext(ctx, `INSERT INTO metrics_15m(series_id, ts, avg, max, count)
		SELECT series_id, ts - (ts % 900), SUM(avg * count) / SUM(count), MAX(max), SUM(count) FROM metrics_1m
		WHERE series_id IN (SELECT id FROM series) AND ts >= ? AND ts < ?
		GROUP BY series_id, ts - (ts % 900)
		ON CONFLICT(series_id, ts) DO UPDATE SET avg = excluded.avg, max = excluded.max, count = excluded.count`, from, to)
	return err
}

// Retention deletes samples past each tier's retention.
func (s *Store) Retention(ctx context.Context, now time.Time) error {
	rows, err := s.r.QueryContext(ctx, `SELECT id FROM series`)
	if err != nil {
		return err
	}
	var ids []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		ids = append(ids, id)
	}
	rows.Close()
	cut := map[string]int64{
		"metrics_raw": now.Add(-RawRetention).Unix(),
		"metrics_1m":  now.Add(-OneMinRetention).Unix(),
		"metrics_15m": now.Add(-FifteenRetention).Unix(),
	}
	const batch = 50
	for i := 0; i < len(ids); i += batch {
		j := min(i+batch, len(ids))
		tx, err := s.w.BeginTx(ctx, nil)
		if err != nil {
			return err
		}
		for _, id := range ids[i:j] {
			for t, c := range cut {
				if _, err := tx.ExecContext(ctx, `DELETE FROM `+t+` WHERE series_id = ? AND ts < ?`, id, c); err != nil {
					tx.Rollback()
					return err
				}
			}
		}
		if err := tx.Commit(); err != nil {
			return err
		}
	}
	return s.dropEmptySeries(ctx)
}

// dropEmptySeries deletes series without samples in any tier (a guest gone
// for 90 days, an unmounted filesystem's volume series, a deleted check);
// they come back on their next sample. The series-id cache is cleared while
// the writer is held, so no insert can use a deleted id (the writer is a
// single connection: inserts run before or after this transaction).
func (s *Store) dropEmptySeries(ctx context.Context) error {
	tx, err := s.w.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	res, err := tx.ExecContext(ctx, `DELETE FROM series WHERE
		NOT EXISTS (SELECT 1 FROM metrics_raw WHERE series_id = series.id) AND
		NOT EXISTS (SELECT 1 FROM metrics_1m WHERE series_id = series.id) AND
		NOT EXISTS (SELECT 1 FROM metrics_15m WHERE series_id = series.id)`)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return tx.Commit()
	}
	s.seriesMu.Lock()
	defer s.seriesMu.Unlock()
	if err := tx.Commit(); err != nil {
		return err
	}
	s.seriesID = map[seriesKey]int64{}
	return nil
}
