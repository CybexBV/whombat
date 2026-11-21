package hostmetrics

import (
	"fmt"
	"time"

	"github.com/CybexBV/whombat/contracts/go/local"
	"github.com/CybexBV/whombat/contracts/go/protocol"
)

// rangeSpec is one chart range (BS-04): its step, its number of points and the ring its points are built from.
type rangeSpec struct {
	step   int64
	points int64
	src    func(*Sampler) *ring
}

// ranges are the contract's HOST_METRICS_STEP_S and HOST_METRICS_POINTS.
var ranges = map[protocol.HostMetricsRange]rangeSpec{
	protocol.HostMetricsRangeHour:  {10, 360, func(s *Sampler) *ring { return s.tens }},
	protocol.HostMetricsRangeDay:   {300, 288, func(s *Sampler) *ring { return s.minutes }},
	protocol.HostMetricsRangeWeek:  {1800, 336, func(s *Sampler) *ring { return s.quarters }},
	protocol.HostMetricsRangeMonth: {7200, 360, func(s *Sampler) *ring { return s.quarters }},
}

// days is the contract's HOST_METRICS_DAYS.
const days = 30

// Metrics answers the runtime's request from memory (BS-04, BS-05): the latest sample, the disks, the range's points
// (with Since only those starting at or after it) and 30 days of traffic in the asked time zone (UTC for one it
// doesn't know). ErrNotYet before the first sample.
func (s *Sampler) Metrics(req *local.HostMetricsRequest) (*local.HostMetricsResponse, error) {
	spec, ok := ranges[req.Range]
	if !ok {
		return nil, fmt.Errorf("%w: unknown range %q", ErrBadRequest, req.Range)
	}
	var since *time.Time
	if req.Since != nil {
		t, err := time.Parse(time.RFC3339Nano, *req.Since)
		if err != nil {
			return nil, fmt.Errorf("%w: since: %v", ErrBadRequest, err)
		}
		since = &t
	}
	loc, zone := s.zone(req.TimeZone)
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.latest == nil {
		return nil, ErrNotYet
	}
	now := s.now()
	m := protocol.HostMetrics{Now: s.nowOf(s.latest), Disks: s.disks, Series: s.series(req.Range, spec, since, now.Unix()),
		Days: s.days(loc, now), TimeZone: zone, MeasuringSince: rfc3339(s.measuringSince(now.Unix()))}
	return &local.HostMetricsResponse{V: 1, Metrics: m}, nil
}

// zone is the IANA zone name's location, UTC for a name it doesn't know (and for "Local", which isn't one).
func (s *Sampler) zone(name string) (*time.Location, string) {
	s.zoneMu.Lock()
	defer s.zoneMu.Unlock()
	if loc, ok := s.zones[name]; ok {
		return loc, name
	}
	loc, err := time.LoadLocation(name)
	if err != nil || name == "Local" || name == "" {
		return time.UTC, "UTC"
	}
	if len(s.zones) < 64 {
		s.zones[name] = loc
	}
	return loc, name
}

func (s *Sampler) nowOf(l *sample) protocol.HostNow {
	n := protocol.HostNow{At: rfc3339(l.at), CpuPermille: int64(min(l.cpu, 1000)), Cores: int64(min(max(l.cores, 1), 4096)),
		MemoryTotalBytes: safe(l.memTotal), MemoryUsedBytes: safe(l.memUsed), Uplink: append([]string{}, l.uplink...)}
	if l.containersMem != nil {
		v := safe(*l.containersMem)
		n.ContainersMemoryBytes = &v
	}
	if l.power != nil {
		p := *l.power // the battery (DK-10, MG-69); absent without one
		n.Power = &p
	}
	// The desk's panel (DK-24, MG-72): the processor's temperature, absent without a sensor, and the uptime.
	n.CpuTempC, n.UptimeS = copyInt(l.cpuTemp), copyInt(l.uptime)
	return n
}

// series is the range's points (BS-04): steps of spec.step ending at the last finished one, the one whose last
// 10-second step has its sample (by the latest sample, not the wall clock, so a step isn't shown empty in the moment
// before its last sample is kept). A point sums the buckets of its step; nil where none has a sample.
func (s *Sampler) series(r protocol.HostMetricsRange, spec rangeSpec, since *time.Time, now int64) protocol.HostSeries {
	latestEnd := now
	if s.latest.slot >= minTime {
		latestEnd = s.latest.slot + tenS
	}
	end := floorTo(latestEnd, spec.step)
	start := end - spec.points*spec.step
	from := start
	if since != nil {
		t := since.Unix()
		if since.Nanosecond() > 0 {
			t++ // a point starting at or after it
		}
		from = min(max(-floorTo(-t, spec.step), start), end) // the first step starting at or after since
	}
	src := spec.src(s)
	out := protocol.HostSeries{Range: r, Start: rfc3339(from), StepS: spec.step, Points: make([]*protocol.HostPoint, 0, (end-from)/spec.step)}
	for t := from; t < end; t += spec.step {
		var agg bucket
		for u := t; u < t+spec.step; u += src.width {
			if b := src.at(u); b != nil {
				agg.merge(b)
			}
		}
		out.Points = append(out.Points, agg.point())
	}
	return out
}

// days is the traffic of the last 30 calendar days in loc, oldest first, today last (BS-05): each the sum of the
// 15-minute buckets starting in it. A day is midnight to midnight as loc has it, 23 or 25 hours across a DST change;
// zones half or three quarters of an hour off UTC still start their days on a quarter hour.
func (s *Sampler) days(loc *time.Location, now time.Time) []protocol.HostDay {
	y, mo, d := now.In(loc).Date()
	out := make([]protocol.HostDay, 0, days)
	for i := days - 1; i >= 0; i-- {
		from := time.Date(y, mo, d-i, 0, 0, 0, 0, loc)
		to := time.Date(y, mo, d-i+1, 0, 0, 0, 0, loc).Unix()
		var agg bucket
		for t := -floorTo(-from.Unix(), quarterS); t < to; t += quarterS {
			if b := s.quarters.at(t); b != nil {
				agg.merge(b)
			}
		}
		out = append(out, protocol.HostDay{Date: from.Format(time.DateOnly), InBytes: safe(agg.in), OutBytes: safe(agg.out)})
	}
	return out
}

// measuringSince is the oldest kept measurement: the oldest 15-minute bucket, refined by the 1-minute ring when its
// oldest bucket lies inside that quarter hour, and by the 10-second ring when its oldest step lies inside that minute
// (the oldest quarter hour of a box measured for a day is mostly empty).
func (s *Sampler) measuringSince(now int64) int64 {
	var o, width int64
	for _, r := range []*ring{s.quarters, s.minutes, s.tens} {
		if v := r.oldest(now); v != 0 && (o == 0 || v < o+width) {
			o = v
		}
		width = r.width
	}
	if o == 0 {
		return s.latest.at // a clock not set yet: nothing kept
	}
	return o
}

func copyInt(v *int64) *int64 {
	if v == nil {
		return nil
	}
	c := *v
	return &c
}

func rfc3339(unix int64) string { return time.Unix(unix, 0).UTC().Format(time.RFC3339) }
