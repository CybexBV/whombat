package store

import (
	"context"
	"math"
	"sort"
	"time"
)

// RangeSpec is the resolution of a UI range (API.md 2.4): detail charts
// have Points buckets of Step seconds, read from Tier.
type RangeSpec struct {
	Name   string
	Dur    time.Duration
	Step   int64 // seconds
	Points int
	Tier   Tier
}

// Ranges: 1h/6h from raw samples, 24h/7d from the 1 min tier, 30d/90d from
// the 15 min tier.
var Ranges = map[string]RangeSpec{
	"1h":  {"1h", time.Hour, 60, 60, TierRaw},
	"6h":  {"6h", 6 * time.Hour, 300, 72, TierRaw},
	"24h": {"24h", 24 * time.Hour, 900, 96, Tier1m},
	"7d":  {"7d", 7 * 24 * time.Hour, 7200, 84, Tier1m},
	"30d": {"30d", 30 * 24 * time.Hour, 21600, 120, Tier15m},
	"90d": {"90d", 90 * 24 * time.Hour, 64800, 120, Tier15m},
}

// RangeNames in UI order.
var RangeNames = []string{"1h", "6h", "24h", "7d", "30d", "90d"}

// Grid is a bucket grid: N buckets of Step seconds from Start. Bucket i
// covers [Start+i*Step, Start+(i+1)*Step). The last bucket may be partial:
// it ends at Last (the request time), so the newest samples are included
// while the earlier buckets stay aligned to the step (stable history).
type Grid struct {
	Start int64
	Step  int64
	N     int
	Last  int64 // end timestamp reported for the last bucket (<= as_of)
}

// End is the exclusive end of the queried interval.
func (g Grid) End() int64 { return g.Start + g.Step*int64(g.N) }

// Ends returns the end timestamp of every bucket (the last one is Last).
func (g Grid) Ends() []time.Time {
	out := make([]time.Time, g.N)
	for i := range out {
		out[i] = time.Unix(g.Start+g.Step*int64(i+1), 0).UTC()
	}
	if g.N > 0 && g.Last > 0 {
		out[g.N-1] = time.Unix(g.Last, 0).UTC()
	}
	return out
}

// GridFor returns the grid of n buckets covering dur up to now. Bucket
// boundaries are aligned to the step; when now is not on a boundary the
// last bucket is the current, partial one (ending at now).
func GridFor(now time.Time, dur time.Duration, n int) Grid {
	step := int64(dur/time.Second) / int64(n)
	t := now.Unix()
	end := t - t%step
	if end == t {
		return Grid{Start: t - step*int64(n), Step: step, N: n, Last: t}
	}
	return Grid{Start: end - step*int64(n-1), Step: step, N: n, Last: t}
}

// Summary is the average and peak of a series over a range.
type Summary struct {
	Avg   float64
	Max   float64
	MaxAt time.Time
}

// MetricsResult is the answer to a metrics query.
type MetricsResult struct {
	Grid     Grid
	Series   map[string][]*float64 // bucket averages, nil = no data
	Summary  map[string]*Summary   // nil = no data in the range
	Requests []string
}

func round1(f float64) float64 { return math.Round(f*10) / 10 }

// QueryMetrics returns the named series of a server over a range. Unknown
// series come back as all-null arrays with a null summary. With names
// empty, every stored series of the server is returned.
func (s *Store) QueryMetrics(ctx context.Context, server string, names []string, spec RangeSpec, now time.Time) (*MetricsResult, error) {
	ids, err := s.SeriesNames(ctx, server)
	if err != nil {
		return nil, err
	}
	if len(names) == 0 {
		for n := range ids {
			names = append(names, n)
		}
		sort.Strings(names)
	}
	g := GridFor(now, spec.Dur, spec.Points)
	var q []int64
	for _, n := range names {
		if id, ok := ids[n]; ok {
			q = append(q, id)
		}
	}
	b, err := s.Buckets(ctx, spec.Tier, q, g.Start, g.Step, g.N)
	if err != nil {
		return nil, err
	}
	res := &MetricsResult{Grid: g, Series: map[string][]*float64{}, Summary: map[string]*Summary{}, Requests: names}
	for _, n := range names {
		vals := make([]*float64, g.N)
		res.Series[n] = vals
		res.Summary[n] = nil
		id, ok := ids[n]
		if !ok {
			continue
		}
		var total Agg
		for i, a := range b[id] {
			if a.Count == 0 {
				continue
			}
			v := round1(a.Avg())
			vals[i] = &v
			total.Add(a)
		}
		if total.Count == 0 {
			continue
		}
		sm := &Summary{Avg: round1(total.Avg()), Max: round1(total.Max)}
		if ts, err := s.MaxAt(ctx, spec.Tier, id, g.Start, g.End(), total.Max); err == nil {
			sm.MaxAt = time.Unix(ts, 0).UTC()
		}
		res.Summary[n] = sm
	}
	return res, nil
}

// MaxOverRange returns the maximum of each named series of a server over
// the range (nil when no data), for the sensor table's "Max" column.
func (s *Store) MaxOverRange(ctx context.Context, server string, names []string, spec RangeSpec, now time.Time) (map[string]*float64, error) {
	ids, err := s.SeriesNames(ctx, server)
	if err != nil {
		return nil, err
	}
	var q []int64
	for _, n := range names {
		if id, ok := ids[n]; ok {
			q = append(q, id)
		}
	}
	// One bucket over the whole range, ending now (rounded to the tier).
	res := spec.Tier.Resolution()
	end := now.Unix() - now.Unix()%res + res
	dur := int64(spec.Dur / time.Second)
	b, err := s.Buckets(ctx, spec.Tier, q, end-dur, dur, 1)
	if err != nil {
		return nil, err
	}
	out := map[string]*float64{}
	for _, n := range names {
		id, ok := ids[n]
		if !ok || len(b[id]) == 0 || b[id][0].Count == 0 {
			out[n] = nil
			continue
		}
		v := round1(b[id][0].Max)
		out[n] = &v
	}
	return out, nil
}

// GridQuery aggregates one series name for many servers on a grid read from
// tier (fleet sparklines and heatmap). The result maps server -> buckets.
func (s *Store) GridQuery(ctx context.Context, tier Tier, name string, servers []string, g Grid) (map[string][]Agg, error) {
	byServer, err := s.SeriesByName(ctx, name)
	if err != nil {
		return nil, err
	}
	var ids []int64
	idServer := map[int64]string{}
	for _, srv := range servers {
		if id, ok := byServer[srv]; ok {
			ids = append(ids, id)
			idServer[id] = srv
		}
	}
	b, err := s.Buckets(ctx, tier, ids, g.Start, g.Step, g.N)
	if err != nil {
		return nil, err
	}
	out := map[string][]Agg{}
	for id, aggs := range b {
		out[idServer[id]] = aggs
	}
	return out, nil
}
