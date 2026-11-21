package store

import (
	"context"
	"errors"
	"math"
	"sort"
	"strings"
	"time"
)

// Guest history: per-guest series (CPU, memory, network, disk I/O) stored
// under their own owner so a host's series list stays small. Sampled once
// a minute by the hub (Hub.guestSamples).

// GuestSeriesOwner is the series owner of a guest's history.
func GuestSeriesOwner(server, guestID string) string { return guestOwnerPrefix(server) + guestID }

func guestOwnerPrefix(server string) string { return "guest:" + server + "|" }

// guestSeriesIDs returns the ids of every guest series of a server.
func (s *Store) guestSeriesIDs(ctx context.Context, server string) ([]int64, error) {
	p := guestOwnerPrefix(server)
	rows, err := s.r.QueryContext(ctx, `SELECT id FROM series WHERE substr(server_id, 1, ?) = ?`, len(p), p)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// InsertMany stores raw samples of several owners in one transaction (see
// InsertSamples).
func (s *Store) InsertMany(ctx context.Context, owners map[string][]Sample) (inserted int, err error) {
	if len(owners) == 0 {
		return 0, nil
	}
	tx, err := s.w.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	stmt, err := tx.PrepareContext(ctx, `INSERT OR IGNORE INTO metrics_raw(series_id, ts, value) VALUES (?, ?, ?)`)
	if err != nil {
		return 0, err
	}
	defer stmt.Close()
	keys := make([]string, 0, len(owners))
	for k := range owners {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, owner := range keys {
		for _, sm := range owners[owner] {
			for n, v := range sm.Values {
				if math.IsNaN(v) || math.IsInf(v, 0) {
					continue
				}
				id, err := s.seriesIDTx(ctx, tx, owner, n)
				if errors.Is(err, errTooManySeries) {
					continue
				}
				if err != nil {
					return 0, err
				}
				res, err := stmt.ExecContext(ctx, id, sm.TS, v)
				if err != nil {
					return 0, err
				}
				if k, _ := res.RowsAffected(); k > 0 {
					inserted += int(k)
				}
			}
		}
	}
	if err := tx.Commit(); err != nil {
		s.seriesMu.Lock()
		s.seriesID = map[seriesKey]int64{}
		s.seriesMu.Unlock()
		return 0, err
	}
	return inserted, nil
}

// Custom ranges: any window within the 15-minute tier's retention.
const (
	MinCustomRange = 10 * time.Minute
	CustomPoints   = 120
)

var errBadRange = errors.New("invalid range")

// CustomRange returns the spec for a from/to window (to = the grid's end):
// the finest tier that still covers it, about CustomPoints buckets.
func CustomRange(from, to, now time.Time) (RangeSpec, error) {
	if to.After(now) {
		to = now
	}
	span := to.Sub(from)
	if span < MinCustomRange || from.Before(now.Add(-FifteenRetention)) {
		return RangeSpec{}, errBadRange
	}
	tier := Tier15m
	switch {
	case span <= 6*time.Hour && from.After(now.Add(-RawRetention+30*time.Minute)):
		tier = TierRaw
	case span <= 7*24*time.Hour && from.After(now.Add(-OneMinRetention+3*time.Hour)):
		tier = Tier1m
	}
	res := tier.Resolution()
	if tier == TierRaw {
		res = 10
	}
	step := int64(span/time.Second) / CustomPoints
	if step < res {
		step = res
	}
	step = (step + res - 1) / res * res
	points := int((int64(span/time.Second) + step - 1) / step)
	return RangeSpec{Name: "custom", Dur: time.Duration(step*int64(points)) * time.Second, Step: step, Points: points, Tier: tier}, nil
}

// IsGuestOwner reports whether an owner is a guest history owner.
func IsGuestOwner(owner string) bool { return strings.HasPrefix(owner, "guest:") }
