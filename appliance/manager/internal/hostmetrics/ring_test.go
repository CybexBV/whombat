package hostmetrics

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestRingFileRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "r.ring")
	r := newRing(minuteS, 10)
	f, err := openRing(path, r)
	if !errors.Is(err, errFresh) {
		t.Fatal("a new file is started afresh:", err)
	}
	b := r.slot(1_790_000_040)
	b.add(&sample{cpu: 400, memUsed: 1 << 33, in: 1 << 40, out: 7})
	b.add(&sample{cpu: 900, memUsed: 1 << 33})
	if err := r.write(1_790_000_040); err != nil {
		t.Fatal(err)
	}
	r.slot(1_790_000_100).add(&sample{cpu: 1}) // not written
	f.close()
	if fi, _ := os.Stat(path); fi.Size() != headerSize+10*recordSize {
		t.Fatal(fi.Size())
	}
	r2 := newRing(minuteS, 10)
	f2, err := openRing(path, r2)
	if err != nil {
		t.Fatal(err)
	}
	defer f2.close()
	got := r2.at(1_790_000_040)
	if got == nil || !reflect.DeepEqual(*got, bucket{start: 1_790_000_040, n: 2, cpuSum: 1300, cpuPeak: 900, memSum: 1 << 34,
		in: 1 << 40, out: 7}) {
		t.Fatalf("%+v", got)
	}
	if r2.at(1_790_000_100) != nil {
		t.Fatal("an unwritten bucket")
	}
	// Another width or capacity is another file: started afresh.
	if _, err := openRing(path, newRing(quarterS, 10)); !errors.Is(err, errFresh) {
		t.Fatal(err)
	}
}

func TestRingFileDamage(t *testing.T) {
	write := func(t *testing.T) (string, []int64) {
		path := filepath.Join(t.TempDir(), "r.ring")
		r := newRing(minuteS, 10)
		f, _ := openRing(path, r)
		var starts []int64
		for i := int64(0); i < 4; i++ {
			s := 1_790_000_040 + i*60
			r.slot(s).add(&sample{cpu: 10, in: 100})
			if err := r.write(s); err != nil {
				t.Fatal(err)
			}
			starts = append(starts, s)
		}
		f.close()
		return path, starts
	}
	reopen := func(t *testing.T, path string) (*ring, error) {
		r := newRing(minuteS, 10)
		f, err := openRing(path, r)
		if f != nil {
			f.close()
		}
		return r, err
	}
	count := func(r *ring, starts []int64) (n int) {
		for _, s := range starts {
			if r.at(s) != nil {
				n++
			}
		}
		return n
	}
	t.Run("truncated", func(t *testing.T) {
		path, starts := write(t)
		if err := os.Truncate(path, headerSize+5*recordSize+17); err != nil {
			t.Fatal(err)
		}
		r, err := reopen(t, path)
		if !errors.Is(err, errFresh) || count(r, starts) != 0 {
			t.Fatal(err, count(r, starts))
		}
		if fi, _ := os.Stat(path); fi.Size() != headerSize+10*recordSize {
			t.Fatal("not made whole again:", fi.Size())
		}
		// And it is usable afresh.
		if r, err := reopen(t, path); err != nil || count(r, starts) != 0 {
			t.Fatal(err)
		}
	})
	t.Run("another header", func(t *testing.T) {
		path, starts := write(t)
		f, _ := os.OpenFile(path, os.O_RDWR, 0)
		f.WriteAt([]byte("XXXX"), 0)
		f.Close()
		if r, err := reopen(t, path); !errors.Is(err, errFresh) || count(r, starts) != 0 {
			t.Fatal(err)
		}
	})
	t.Run("a damaged record", func(t *testing.T) {
		path, starts := write(t)
		r := newRing(minuteS, 10)
		i := r.index(starts[1])
		f, _ := os.OpenFile(path, os.O_RDWR, 0)
		f.WriteAt([]byte{0xff}, headerSize+int64(i)*recordSize+30) // a byte of its counters
		f.Close()
		r, err := reopen(t, path)
		if err != nil || count(r, starts) != 3 || r.at(starts[1]) != nil {
			t.Fatal(err, count(r, starts))
		}
	})
	t.Run("a record in the wrong place", func(t *testing.T) {
		path, starts := write(t)
		r := newRing(minuteS, 10)
		f, _ := os.OpenFile(path, os.O_RDWR, 0)
		rec := make([]byte, recordSize)
		f.ReadAt(rec, headerSize+int64(r.index(starts[0]))*recordSize)
		f.WriteAt(rec, headerSize+int64(r.index(starts[3])+1)*recordSize)
		f.Close()
		r, err := reopen(t, path)
		if err != nil || count(r, starts) != 4 || r.recs[r.index(starts[3])+1].n != 0 {
			t.Fatal(err)
		}
	})
}

// TestHistorySurvivesARestart: the 1-minute and 15-minute rings come back from their files; the open minute is written
// when the sampler stops, and a crash loses at most the minute in progress.
func TestHistorySurvivesARestart(t *testing.T) {
	dir := t.TempDir()
	ts := newTestSampler(t, dir)
	ts.open()
	ts.feed(at("2026-10-11T00:00:00Z"), at("2026-10-11T03:00:00Z"))
	day, week := ts.metrics(t, "day", "", "UTC"), ts.metrics(t, "week", "", "UTC")
	ts.close()
	for _, name := range []string{"minutes.ring", "quarters.ring"} {
		fi, err := os.Stat(filepath.Join(dir, name))
		want := map[string]int64{"minutes.ring": headerSize + minutesKept*recordSize, "quarters.ring": headerSize + quartersKept*recordSize}[name]
		if err != nil || fi.Size() != want || fi.Mode().Perm() != 0o600 {
			t.Fatal(name, err, fi.Size(), fi.Mode())
		}
	}

	again := newTestSampler(t, dir)
	again.open()
	again.now = ts.now
	again.feed(at("2026-10-11T03:00:00Z"), at("2026-10-11T03:00:10Z"))
	day2, week2 := again.metrics(t, "day", "", "UTC"), again.metrics(t, "week", "", "UTC")
	if !reflect.DeepEqual(day.Series, day2.Series) || !reflect.DeepEqual(week.Series, week2.Series) || day2.MeasuringSince != "2026-10-11T00:00:00Z" {
		t.Fatalf("not the same history after a restart: %s", day2.MeasuringSince)
	}
	if h := again.metrics(t, "hour", "", "UTC").Series.Points; h[358] != nil || h[359] == nil {
		t.Fatal("the 10-second points are memory only")
	}
	// A crash (no close) at 03:20:30: what was written at each new minute is there, 03:20 isn't.
	again.feed(at("2026-10-11T03:00:10Z"), at("2026-10-11T03:20:30Z"))
	crashed := newTestSampler(t, dir)
	crashed.open()
	defer crashed.close()
	crashed.now = again.now
	if crashed.minutes.at(at("2026-10-11T03:19:00Z").Unix()) == nil || crashed.minutes.at(at("2026-10-11T03:20:00Z").Unix()) != nil {
		t.Fatal("the minutes written before the crash")
	}
	q := crashed.quarters.at(at("2026-10-11T03:15:00Z").Unix())
	if q == nil || q.n != 5*6 {
		t.Fatalf("the quarter hour up to the last minute written: %+v", q)
	}
	// Measuring goes on in the same quarter hour.
	crashed.feed(at("2026-10-11T03:21:00Z"), at("2026-10-11T03:30:00Z"))
	if q := crashed.quarters.at(at("2026-10-11T03:15:00Z").Unix()); q.n != 5*6+9*6 {
		t.Fatal(q.n)
	}
}

// TestNoHistoryDirectory: without a directory it can write, the history is kept in memory.
func TestNoHistoryDirectory(t *testing.T) {
	file := filepath.Join(t.TempDir(), "file")
	os.WriteFile(file, nil, 0o600)
	ts := newTestSampler(t, filepath.Join(file, "metrics"))
	ts.open()
	ts.feed(at("2026-10-11T00:00:00Z"), at("2026-10-11T00:10:00Z"))
	ts.close()
	if p := ts.metrics(t, "day", "", "UTC").Series.Points; p[len(p)-1] == nil {
		t.Fatal("not measured")
	}
}
