package hostmetrics

import (
	"context"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/CybexBV/whombat/contracts/go/local"
)

// TestRun: the sampler's loop on fake roots answers within about a second of its start, the disks are read beside
// it, and stopping writes the open minute.
func TestRun(t *testing.T) {
	proc, sys, dir := t.TempDir(), t.TempDir(), t.TempDir()
	tree(t, proc, map[string]string{"stat": "cpu  100 0 100 800 0 0 0 0 0 0\ncpu0 1\n", "meminfo": "MemTotal: 8000 kB\nMemAvailable: 2000 kB\n",
		"net/route": "Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\n", "self/mountinfo": ""})
	s := New(Config{Dir: filepath.Join(dir, "metrics"), Proc: proc, Sys: sys, Persist: dir, System: dir,
		Log: slog.New(slog.NewTextHandler(io.Discard, nil))})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { s.Run(ctx); close(done) }()
	req := &local.HostMetricsRequest{V: 1, Range: "hour", TimeZone: "Europe/Amsterdam"}
	var res *local.HostMetricsResponse
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); time.Sleep(20 * time.Millisecond) {
		r, err := s.Metrics(req)
		if err == nil && r.Metrics.Disks.Data.TotalBytes > 0 {
			res = r
			break
		}
	}
	cancel()
	<-done
	if res == nil {
		t.Fatal("no answer within 5 s of the start")
	}
	if err := res.Validate(); err != nil || res.Metrics.Now.MemoryUsedBytes != 6000*1024 || res.Metrics.Disks.Data.Parts != nil {
		t.Fatalf("%v %+v", err, res.Metrics)
	}
	if s.minutes.file != nil || s.quarters.file != nil {
		t.Fatal("the files are left open")
	}
	b, err := os.ReadFile(filepath.Join(dir, "metrics", "minutes.ring"))
	if err != nil {
		t.Fatal(err)
	}
	r := newRing(minuteS, minutesKept)
	if f, err := openRing(filepath.Join(dir, "metrics", "minutes.ring"), r); err != nil || r.oldest(time.Now().Unix()+60) == 0 {
		t.Fatal("the open minute isn't written:", err, len(b))
	} else {
		f.close()
	}
}
