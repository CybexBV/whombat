package hostmetrics

import (
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"testing"
	"time"
)

// tree writes files (path → content) under root; a path ending in / is a directory.
func tree(t *testing.T, root string, files map[string]string) {
	t.Helper()
	for p, c := range files {
		full := filepath.Join(root, p)
		if p[len(p)-1] == '/' {
			if err := os.MkdirAll(full, 0o755); err != nil {
				t.Fatal(err)
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(c), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func TestCPU(t *testing.T) {
	proc := t.TempDir()
	// user nice system idle iowait irq softirq steal guest guest_nice: guest is in user already.
	tree(t, proc, map[string]string{"stat": "cpu  100 0 50 800 50 0 0 0 40 0\ncpu0 50 0 25 400 25 0 0 0 20 0\n" +
		"cpu1 50 0 25 400 25 0 0 0 20 0\ncpu2 0 0 0 0 0 0 0 0 0 0\ncpu3 0 0 0 0 0 0 0 0 0 0\nintr 1 2 3\nctxt 99\n"})
	a, cores, err := readCPU(proc)
	if err != nil || cores != 4 || a.total != 1000 || a.busy != 150 {
		t.Fatalf("%+v %d %v", a, cores, err)
	}
	tree(t, proc, map[string]string{"stat": "cpu  200 0 100 1500 100 0 0 0 90 0\ncpu0 1 1 1 1\n"})
	b, cores, err := readCPU(proc)
	if err != nil || cores != 1 {
		t.Fatal(cores, err)
	}
	// 900 ticks went by, 150 of them busy (user 100, system 50): 16.7 %.
	if got := cpuPermille(a, b); got != 167 {
		t.Fatalf("permille %d", got)
	}
	if got := cpuPermille(b, b); got != 0 {
		t.Fatalf("no time: %d", got)
	}
	if got := cpuPermille(b, a); got != 0 {
		t.Fatalf("back in time: %d", got)
	}
	// iowait going back (tickless kernels) makes busy jump: never more than all of it.
	if got := cpuPermille(cpuTimes{busy: 0, total: 1000}, cpuTimes{busy: 2000, total: 1100}); got != 1000 {
		t.Fatalf("capped: %d", got)
	}
	tree(t, proc, map[string]string{"stat": "intr 1\n"})
	if _, _, err := readCPU(proc); err == nil {
		t.Fatal("no cpu line accepted")
	}
}

func TestMemory(t *testing.T) {
	proc := t.TempDir()
	tree(t, proc, map[string]string{"meminfo": "MemTotal:       16384000 kB\nMemFree:          512000 kB\n" +
		"MemAvailable:    4096000 kB\nBuffers:          100 kB\nHugePages_Total:       0\n"})
	total, used, err := readMemory(proc)
	if err != nil || total != 16384000*1024 || used != (16384000-4096000)*1024 {
		t.Fatal(total, used, err)
	}
	tree(t, proc, map[string]string{"meminfo": "MemFree: 1 kB\n"})
	if _, _, err := readMemory(proc); err == nil {
		t.Fatal("no MemTotal accepted")
	}
}

func TestUplink(t *testing.T) {
	proc := t.TempDir()
	// The DEV box's table, plus a second default route (another link), the first one again and one that is down.
	tree(t, proc, map[string]string{"net/route": "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\n" +
		"enp5s0\t00000000\t01000A0A\t0003\t0\t0\t1024\t00000000\t0\t0\t0\n" +
		"enp5s0\t00000A0A\t00000000\t0001\t0\t0\t1024\t00FEFFFF\t0\t0\t0\n" +
		"wbc2d4e27ee\t00E2E30A\t00000000\t0001\t0\t0\t0\t00FFFFFF\t0\t0\t0\n" +
		"wlan0\t00000000\t0101A8C0\t0003\t0\t0\t2048\t00000000\t0\t0\t0\n" +
		"enp5s0\t00000000\t01000A0A\t0003\t0\t0\t4096\t00000000\t0\t0\t0\n" +
		"eth9\t00000000\t01000A0A\t0002\t0\t0\t0\t00000000\t0\t0\t0\n"})
	got, err := readUplink(proc)
	if err != nil || !slices.Equal(got, []string{"enp5s0", "wlan0"}) {
		t.Fatal(got, err)
	}
	tree(t, proc, map[string]string{"net/route": "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\n"})
	if got, err := readUplink(proc); err != nil || len(got) != 0 {
		t.Fatal("no default route:", got, err)
	}
}

func TestCounterDelta(t *testing.T) {
	prev := map[string]ifCounter{"enp5s0": {index: 2, rx: 1000, tx: 500}}
	for _, tc := range []struct {
		name   string
		cur    ifCounter
		rx, tx uint64
	}{
		{"enp5s0", ifCounter{index: 2, rx: 1600, tx: 700}, 600, 200},
		// A counter that went back (the driver reset it) counts from zero.
		{"enp5s0", ifCounter{index: 2, rx: 300, tx: 800}, 300, 300},
		// Recreated (another ifindex): all of its count is new.
		{"enp5s0", ifCounter{index: 9, rx: 5000, tx: 6000}, 5000, 6000},
		// Not there at the last sample: a baseline.
		{"wlan0", ifCounter{index: 3, rx: 1 << 40, tx: 1 << 30}, 0, 0},
	} {
		if rx, tx := counterDelta(prev, tc.name, tc.cur); rx != tc.rx || tx != tc.tx {
			t.Errorf("%s %+v: %d %d", tc.name, tc.cur, rx, tx)
		}
	}
}

func TestContainersMemory(t *testing.T) {
	sys := t.TempDir()
	if readContainersMemory(sys) != nil {
		t.Fatal("no engine: null")
	}
	cg := "fs/cgroup/whombat.slice/whombat-tasks.slice/whombat-containers.service/"
	tree(t, sys, map[string]string{
		cg + "memory.current": "1000000\n",
		cg + "memory.stat":    "anon 600000\nfile 400000\nactive_file 100000\ninactive_file 300000\n",
	})
	if got := readContainersMemory(sys); got == nil || *got != 700000 {
		t.Fatal(got)
	}
	tree(t, sys, map[string]string{cg + "memory.current": "max\n"})
	if got := readContainersMemory(sys); got != nil {
		t.Fatal("unreadable: null", *got)
	}
}

// TestMeasure samples fake /proc and /sys roots: the first reading is a baseline, the next one the difference.
func TestMeasure(t *testing.T) {
	proc, sys := t.TempDir(), t.TempDir()
	now := time.Date(2026, 10, 11, 12, 0, 0, 50_000_000, time.UTC)
	s := New(Config{Proc: proc, Sys: sys, Now: func() time.Time { return now }, Log: slog.New(slog.NewTextHandler(io.Discard, nil))})
	net := func(name string, idx, rx, tx int) map[string]string {
		return map[string]string{"class/net/" + name + "/ifindex": itoa(idx), "class/net/" + name + "/statistics/rx_bytes": itoa(rx),
			"class/net/" + name + "/statistics/tx_bytes": itoa(tx)}
	}
	tree(t, proc, map[string]string{"stat": "cpu  100 0 100 800 0 0 0 0 0 0\ncpu0 1\ncpu1 1\n",
		"meminfo":   "MemTotal: 8000 kB\nMemAvailable: 2000 kB\n",
		"net/route": "Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\nenp5s0\t00000000\t01000A0A\t0003\t0\t0\t0\t00000000\n"})
	tree(t, sys, net("enp5s0", 2, 5_000_000, 1_000_000))
	// A bridge (a container network's, say) is never the uplink, and its traffic isn't counted.
	tree(t, sys, net("podman0", 7, 400, 300))
	tree(t, sys, map[string]string{"class/net/podman0/bridge/": "",
		"fs/cgroup/whombat.slice/whombat-tasks.slice/whombat-containers.service/memory.current": "9000000\n"})
	s.measure(false)
	if s.latest != nil {
		t.Fatal("the baseline is no sample")
	}
	now = now.Add(10 * time.Second)
	tree(t, proc, map[string]string{"stat": "cpu  400 0 200 1200 0 0 0 0 0 0\ncpu0 1\ncpu1 1\n"})
	tree(t, sys, net("enp5s0", 2, 5_120_000, 1_030_000))
	tree(t, sys, net("podman0", 7, 10_400, 90_300))
	s.measure(true)
	l := s.latest
	if l == nil || l.cpu != 500 || l.cores != 2 || l.memTotal != 8000*1024 || l.memUsed != 6000*1024 {
		t.Fatalf("%+v", l)
	}
	if l.in != 120_000 || l.out != 30_000 || !slices.Equal(l.uplink, []string{"enp5s0"}) {
		t.Fatalf("bytes %+v", l)
	}
	// The containers' memory is never more than the memory used.
	if l.containersMem == nil || *l.containersMem != 6000*1024 {
		t.Fatalf("containers %v", l.containersMem)
	}
	// The sample measured 12:00:00–12:00:10: that step.
	if want := now.Add(-10 * time.Second).Truncate(10 * time.Second).Unix(); l.slot != want || l.at != now.Unix() {
		t.Fatalf("slot %d at %d", l.slot, l.at)
	}
	// No /proc/stat: no sample, and the next reading is a baseline again.
	os.Remove(filepath.Join(proc, "stat"))
	now = now.Add(10 * time.Second)
	s.measure(true)
	if s.hasPrev || s.latest.at != now.Add(-10*time.Second).Unix() {
		t.Fatal("a sample without the processor")
	}
}

func itoa(v int) string { return strconv.Itoa(v) + "\n" }

func TestUntilTick(t *testing.T) {
	for _, tc := range []struct {
		at   time.Time
		want time.Duration
	}{
		{time.Date(2026, 10, 11, 12, 0, 3, 0, time.UTC), 7*time.Second + tickOffset},
		{time.Date(2026, 10, 11, 12, 0, 9, 500_000_000, time.UTC), 10*time.Second + 500*time.Millisecond + tickOffset},
		{time.Date(2026, 10, 11, 12, 0, 0, 60_000_000, time.UTC), 10*time.Second - 10*time.Millisecond},
	} {
		if got := untilTick(tc.at); got != tc.want {
			t.Errorf("%v: %v, want %v", tc.at, got, tc.want)
		}
	}
}
