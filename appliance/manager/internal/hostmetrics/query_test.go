package hostmetrics

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/CybexBV/whombat/contracts/go/local"
	"github.com/CybexBV/whombat/contracts/go/protocol"
)

// testSampler is a sampler on a settable clock, fed samples directly (no /proc).
type testSampler struct {
	*Sampler
	now time.Time
}

func newTestSampler(t *testing.T, dir string) *testSampler {
	ts := &testSampler{}
	ts.Sampler = New(Config{Dir: dir, Proc: t.TempDir(), Sys: t.TempDir(), Now: func() time.Time { return ts.now },
		Log: slog.New(slog.NewTextHandler(io.Discard, nil))})
	return ts
}

// cpuAt is the fed processor share: a saw tooth from 0 to 99.0 % every 100 steps, so each 5 minutes' peak is known.
func cpuAt(slot int64) uint16 { return uint16((slot / 10 % 100) * 10) }

// feed keeps a sample for every 10-second step in [from, to): 1000 bytes in, 100 out, 2 GiB of memory used; the clock is just after the step's end.
func (ts *testSampler) feed(from, to time.Time) {
	for t := from.Unix(); t < to.Unix(); t += 10 {
		ts.now = time.Unix(t+10, 50_000_000)
		ts.record(&sample{at: t + 10, slot: t, cpu: cpuAt(t), cores: 4, memTotal: 8 << 30, memUsed: 2 << 30,
			uplink: []string{"enp5s0"}, in: 1000, out: 100})
	}
}

func (ts *testSampler) metrics(t *testing.T, r protocol.HostMetricsRange, since string, zone string) protocol.HostMetrics {
	t.Helper()
	req := &local.HostMetricsRequest{V: 1, Range: r, TimeZone: zone}
	if since != "" {
		req.Since = &since
	}
	if err := req.Validate(); err != nil {
		t.Fatal(err)
	}
	res, err := ts.Metrics(req)
	if err != nil {
		t.Fatal(err)
	}
	// What the runtime gets is the contract's.
	if err := res.Validate(); err != nil {
		t.Fatalf("%s: %v", r, err)
	}
	b, _ := json.Marshal(res)
	if _, err := local.ParseHostMetricsResponse(b); err != nil {
		t.Fatalf("%s: %v", r, err)
	}
	return res.Metrics
}

func at(s string) time.Time {
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		panic(err)
	}
	return t
}

func TestNotYet(t *testing.T) {
	ts := newTestSampler(t, "")
	if _, err := ts.Metrics(&local.HostMetricsRequest{V: 1, Range: "hour", TimeZone: "UTC"}); !errors.Is(err, ErrNotYet) {
		t.Fatal(err)
	}
	ts.feed(at("2026-10-11T00:00:00Z"), at("2026-10-11T00:00:10Z"))
	bad := "2026-13-45T00:00:00Z" // the schema's pattern, not a time
	if _, err := ts.Metrics(&local.HostMetricsRequest{V: 1, Range: "hour", Since: &bad, TimeZone: "UTC"}); !errors.Is(err, ErrBadRequest) {
		t.Fatal(err)
	}
}

func TestRanges(t *testing.T) {
	ts := newTestSampler(t, "")
	t0, t1 := at("2026-10-09T00:00:00Z"), at("2026-10-11T01:00:00Z") // 49 hours
	ts.feed(t0, t1)
	for _, tc := range []struct {
		r             protocol.HostMetricsRange
		start         string
		step, n       int64
		perPoint      int64 // samples in a full point
		firstMeasured int   // index of the first point with samples
	}{
		{"hour", "2026-10-11T00:00:00Z", 10, 360, 1, 0},
		{"day", "2026-10-10T01:00:00Z", 300, 288, 30, 0},
		// 7 days back from 01:00: measuring began two days ago.
		{"week", "2026-10-04T01:00:00Z", 1800, 336, 180, 336 - 98},
		// The step 00:00–02:00 isn't finished: 30 days of 2 hours up to midnight.
		{"month", "2026-09-11T00:00:00Z", 7200, 360, 720, 360 - 24},
	} {
		m := ts.metrics(t, tc.r, "", "UTC")
		s := m.Series
		if s.Range != tc.r || s.Start != tc.start || s.StepS != tc.step || int64(len(s.Points)) != tc.n {
			t.Fatalf("%s: %s %d %d", tc.r, s.Start, s.StepS, len(s.Points))
		}
		for i, p := range s.Points {
			if i < tc.firstMeasured {
				if p != nil {
					t.Fatalf("%s %d: measured before measuring began: %+v", tc.r, i, p)
				}
				continue
			}
			if p == nil || p.InBytes != 1000*tc.perPoint || p.OutBytes != 100*tc.perPoint ||
				p.MemoryUsedBytes != 2<<30 {
				t.Fatalf("%s %d: %+v", tc.r, i, p)
			}
		}
		last := s.Points[len(s.Points)-1]
		// The average and the peak of the last step's samples.
		var sum, peak int64
		for u := t1.Unix() - tc.step; u < t1.Unix(); u += 10 {
			sum, peak = sum+int64(cpuAt(u)), max(peak, int64(cpuAt(u)))
		}
		if tc.r != "month" && (last.CpuPermille != (sum+tc.perPoint/2)/tc.perPoint || last.CpuPeakPermille != peak) {
			t.Fatalf("%s: average %d peak %d, want %d %d", tc.r, last.CpuPermille, last.CpuPeakPermille, (sum+tc.perPoint/2)/tc.perPoint, peak)
		}
	}
	m := ts.metrics(t, "hour", "", "UTC")
	if m.MeasuringSince != "2026-10-09T00:00:00Z" || m.Now.At != "2026-10-11T01:00:00Z" || m.Now.Cores != 4 ||
		m.Now.MemoryTotalBytes != 8<<30 || m.Now.ContainersMemoryBytes != nil || len(m.Now.Uplink) != 1 {
		t.Fatalf("%+v %s", m.Now, m.MeasuringSince)
	}

	// A gap of ten minutes (the manager stopped) is null in the hour and day ranges, not zero.
	ts.feed(t1.Add(10*time.Minute), t1.Add(30*time.Minute))
	m = ts.metrics(t, "day", "", "UTC")
	n := len(m.Series.Points)
	if m.Series.Start != "2026-10-10T01:30:00Z" || m.Series.Points[n-6] != nil || m.Series.Points[n-5] != nil ||
		m.Series.Points[n-7] == nil || m.Series.Points[n-4] == nil {
		t.Fatalf("gap: %s %v", m.Series.Start, m.Series.Points[n-7:])
	}
	if p := ts.metrics(t, "week", "", "UTC").Series.Points; p[len(p)-1].InBytes != 1000*120 {
		t.Fatalf("a half-measured step sums what was measured: %+v", p[len(p)-1])
	}
}

func TestOnlyFinishedSteps(t *testing.T) {
	ts := newTestSampler(t, "")
	ts.feed(at("2026-10-11T00:00:00Z"), at("2026-10-11T00:04:50Z"))
	// The last sample is 00:04:40–00:04:50: the 5-minute step 00:00–00:05 isn't done.
	if p := ts.metrics(t, "day", "", "UTC").Series.Points; p[len(p)-1] != nil {
		t.Fatal(p[len(p)-1])
	}
	if s := ts.metrics(t, "hour", "", "UTC").Series; s.Start != "2026-10-10T23:04:50Z" || s.Points[len(s.Points)-1] == nil {
		t.Fatal(s.Start)
	}
	ts.feed(at("2026-10-11T00:04:50Z"), at("2026-10-11T00:05:00Z"))
	if p := ts.metrics(t, "day", "", "UTC").Series.Points; p[len(p)-1] == nil || p[len(p)-1].InBytes != 30_000 {
		t.Fatal(p[len(p)-1])
	}
	// The wall clock a little ahead of the sampler (the next sample not kept yet) doesn't add an empty step.
	ts.now = ts.now.Add(9 * time.Second)
	if s := ts.metrics(t, "hour", "", "UTC").Series; s.Points[len(s.Points)-1] == nil {
		t.Fatal("an empty last step")
	}
}

func TestSince(t *testing.T) {
	ts := newTestSampler(t, "")
	ts.feed(at("2026-10-11T00:00:00Z"), at("2026-10-11T01:00:00Z"))
	for _, tc := range []struct {
		since, start string
		n            int
	}{
		{"2026-10-11T00:59:00Z", "2026-10-11T00:59:00Z", 6},
		{"2026-10-11T00:59:05Z", "2026-10-11T00:59:10Z", 5},
		{"2026-10-11T00:59:00.5Z", "2026-10-11T00:59:10Z", 5},
		{"2026-10-11T02:59:00+02:00", "2026-10-11T00:59:00Z", 6},
		{"2026-10-11T01:00:00Z", "2026-10-11T01:00:00Z", 0},
		{"2026-10-11T07:00:00Z", "2026-10-11T01:00:00Z", 0},
		{"2026-10-10T00:00:00Z", "2026-10-11T00:00:00Z", 360},
	} {
		s := ts.metrics(t, "hour", tc.since, "UTC").Series
		if s.Start != tc.start || len(s.Points) != tc.n {
			t.Errorf("since %s: %s, %d points", tc.since, s.Start, len(s.Points))
		}
	}
	if s := ts.metrics(t, "day", "2026-10-11T00:52:00Z", "UTC").Series; s.Start != "2026-10-11T00:55:00Z" || len(s.Points) != 1 {
		t.Fatal(s.Start, len(s.Points))
	}
}

func TestDays(t *testing.T) {
	const perDay = 24 * 360 * 1000 // bytes in on a fully measured day of 24 hours
	t.Run("across the end of summer time", func(t *testing.T) {
		ts := newTestSampler(t, "")
		// Amsterdam: 24 October starts 22:00 UTC the day before (CEST); 25 October has 25 hours (back to CET at 03:00);
		// 26 October starts at 23:00 UTC.
		ts.feed(at("2026-10-23T22:00:00Z"), at("2026-10-25T23:30:00Z"))
		m := ts.metrics(t, "hour", "", "Europe/Amsterdam")
		d := m.Days
		if m.TimeZone != "Europe/Amsterdam" || len(d) != 30 || d[0].Date != "2026-09-27" || d[29].Date != "2026-10-26" {
			t.Fatalf("%s %d %s…%s", m.TimeZone, len(d), d[0].Date, d[len(d)-1].Date)
		}
		if d[26].InBytes != 0 || d[27].InBytes != perDay || d[28].InBytes != perDay*25/24 || d[29].InBytes != 180*1000 {
			t.Fatalf("%+v", d[26:])
		}
		if d[28].OutBytes != 100*25*360 {
			t.Fatalf("%+v", d[28])
		}
		// The same samples in UTC: 2, 24 and 23.5 hours.
		d = ts.metrics(t, "hour", "", "UTC").Days
		if d[26].InBytes != 0 || d[27].InBytes != perDay*2/24 || d[28].InBytes != perDay || d[29].InBytes != perDay*47/48 {
			t.Fatalf("UTC %+v", d[26:])
		}
	})
	t.Run("half an hour off UTC", func(t *testing.T) {
		ts := newTestSampler(t, "")
		// Kolkata (+05:30): 11 October is 10 October 18:30 UTC to 11 October 18:30 UTC.
		ts.feed(at("2026-10-10T18:00:00Z"), at("2026-10-11T19:15:00Z"))
		d := ts.metrics(t, "hour", "", "Asia/Kolkata").Days
		if d[29].Date != "2026-10-12" || d[29].InBytes != 45*6*1000 || d[28].InBytes != perDay || d[27].InBytes != 30*6*1000 {
			t.Fatalf("%+v", d[27:])
		}
	})
	t.Run("a zone it doesn't know", func(t *testing.T) {
		ts := newTestSampler(t, "")
		ts.feed(at("2026-10-11T00:00:00Z"), at("2026-10-11T00:10:00Z"))
		for _, z := range []string{"Mars/Olympus_Mons", "Local"} {
			if m := ts.metrics(t, "hour", "", z); m.TimeZone != "UTC" || m.Days[29].Date != "2026-10-11" {
				t.Fatal(z, m.TimeZone)
			}
		}
	})
}

func TestMeasuringSince(t *testing.T) {
	ts := newTestSampler(t, "")
	// Measuring began at 00:07:20: the minute ring places it in its minute, the 10-second ring at its step.
	ts.feed(at("2026-10-11T00:07:20Z"), at("2026-10-11T00:12:00Z"))
	if m := ts.metrics(t, "day", "", "UTC"); m.MeasuringSince != "2026-10-11T00:07:20Z" {
		t.Fatal(m.MeasuringSince)
	}
	ts.feed(at("2026-10-11T00:12:00Z"), at("2026-10-11T02:00:00Z"))
	if m := ts.metrics(t, "day", "", "UTC"); m.MeasuringSince != "2026-10-11T00:07:00Z" {
		t.Fatal(m.MeasuringSince)
	}
}

// TestClockJumps: a clock that jumped forward leaves buckets in the future, which are never shown and don't move
// “measuring since”; one that jumped back adds to the buckets it lands in. A clock not set yet keeps nothing.
func TestClockJumps(t *testing.T) {
	ts := newTestSampler(t, "")
	ts.feed(at("2026-10-11T00:00:00Z"), at("2026-10-11T01:00:00Z"))
	ts.feed(at("2027-10-11T00:00:00Z"), at("2027-10-11T00:01:00Z"))
	ts.feed(at("2026-10-11T00:50:00Z"), at("2026-10-11T01:00:00Z"))
	m := ts.metrics(t, "day", "", "UTC")
	if m.MeasuringSince != "2026-10-11T00:00:00Z" {
		t.Fatal(m.MeasuringSince)
	}
	p := m.Series.Points
	if p[len(p)-1].InBytes != 2*30*1000 || p[len(p)-3].InBytes != 30*1000 {
		t.Fatalf("%+v %+v", p[len(p)-1], p[len(p)-3])
	}
	ts.feed(at("1970-01-01T00:00:00Z"), at("1970-01-01T00:01:00Z"))
	m = ts.metrics(t, "hour", "", "UTC")
	if m.Now.At != "1970-01-01T00:01:00Z" || m.MeasuringSince != "1970-01-01T00:01:00Z" {
		t.Fatal(m.Now.At, m.MeasuringSince)
	}
	if ts.tens.at(0) != nil || ts.minutes.at(0) != nil {
		t.Fatal("kept a sample of a clock not set")
	}
}

func TestResponseWithEverything(t *testing.T) {
	ts := newTestSampler(t, "")
	cm := uint64(1 << 30)
	ts.now = at("2026-10-11T00:00:10Z")
	ts.record(&sample{at: ts.now.Unix(), slot: ts.now.Unix() - 10, cpu: 1000, cores: 9000, memTotal: 1 << 60, memUsed: 1 << 59,
		containersMem: &cm, uplink: []string{"enp5s0", "wlan0"}, in: 1 << 62})
	ts.disks = protocol.HostDisks{Data: protocol.HostDisksData{TotalBytes: 100, UsedBytes: 50, FreeBytes: 40,
		Parts: []protocol.HostDiskPart{{Key: "containers", Bytes: 30}}}, Backup: &protocol.HostDisk{TotalBytes: 9}}
	m := ts.metrics(t, "hour", "", "UTC")
	if m.Now.Cores != 4096 || m.Now.MemoryTotalBytes != maxSafe || *m.Now.ContainersMemoryBytes != 1<<30 ||
		m.Series.Points[359].InBytes != maxSafe || m.Disks.Backup.TotalBytes != 9 {
		t.Fatalf("%+v", m.Now)
	}
	b, _ := json.Marshal(m)
	var raw map[string]any
	json.Unmarshal(b, &raw)
	if parts := raw["disks"].(map[string]any)["data"].(map[string]any)["parts"]; parts == nil {
		t.Fatal("parts")
	}
	ts.disks.Data.Parts = nil
	b, _ = json.Marshal(ts.metrics(t, "hour", "", "UTC"))
	json.Unmarshal(b, &raw)
	if parts, ok := raw["disks"].(map[string]any)["data"].(map[string]any)["parts"]; !ok || parts != nil {
		t.Fatal("unmeasurable parts are null", parts, ok)
	}
}
