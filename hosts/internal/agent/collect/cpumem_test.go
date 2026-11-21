package collect

import (
	"context"
	"testing"
)

func TestCPUPercents(t *testing.T) {
	prev, ok := parseCPULine([]byte("cpu  1000 0 500 8000 100 0 0 0 0 0\ncpu0 1 2 3\n"))
	if !ok {
		t.Fatal("no cpu line")
	}
	// +224 user, +16 nice, +92 system, +0 irq, +0 softirq, +24 iowait,
	// +644 idle = 1000 ticks.
	cur, _ := parseCPULine([]byte("cpu  1224 16 592 8644 124 0 0 0 0 0\n"))
	c := cpuPercents(prev, cur)
	if c.UserPct != 24 || c.SystemPct != 9.2 || c.IOWaitPct != 2.4 {
		t.Errorf("user/system/iowait = %v/%v/%v", c.UserPct, c.SystemPct, c.IOWaitPct)
	}
	// usage = 100 - idle - iowait
	if c.UsagePct != 33.2 {
		t.Errorf("usage = %v, want 33.2", c.UsagePct)
	}
	if z := cpuPercents(cur, cur); z.UsagePct != 0 {
		t.Errorf("no delta: %v", z)
	}
}

func TestProcStatTestdata(t *testing.T) {
	c, ok := parseCPULine(readTestdata(t, "proc_stat"))
	if !ok || c.total() == 0 || c.idle == 0 {
		t.Fatalf("proc_stat: %+v %v", c, ok)
	}
}

func TestMemoryFromMeminfo(t *testing.T) {
	m := parseMeminfo(readTestdata(t, "meminfo"))
	mem := memoryFromMeminfo(m)
	if mem.TotalBytes != m["MemTotal"] || mem.TotalBytes == 0 {
		t.Fatalf("total %d", mem.TotalBytes)
	}
	if mem.UsedBytes != m["MemTotal"]-m["MemAvailable"] {
		t.Errorf("used = %d, want total-available", mem.UsedBytes)
	}
	if mem.CachedBytes != m["Buffers"]+m["Cached"]+m["SReclaimable"] {
		t.Errorf("cached = %d", mem.CachedBytes)
	}
	if mem.SwapUsedBytes != m["SwapTotal"]-m["SwapFree"] {
		t.Errorf("swap used = %d", mem.SwapUsedBytes)
	}
	// kB values are converted to bytes.
	if m["MemTotal"]%1024 != 0 {
		t.Errorf("MemTotal not in bytes: %d", m["MemTotal"])
	}
}

func TestParseARCSize(t *testing.T) {
	v, ok := parseARCSize(readTestdata(t, "arcstats"))
	if !ok || v < 1<<30 {
		t.Errorf("arc size %d %v", v, ok)
	}
	if _, ok := parseARCSize([]byte("name type data\nhits 4 1\n")); ok {
		t.Error("no size line should report !ok")
	}
}

func TestParseLoadavg(t *testing.T) {
	l := parseLoadavg("6.33 9.06 7.64 2/7043 423223\n")
	if l != [3]float64{6.33, 9.06, 7.64} {
		t.Errorf("%v", l)
	}
}

func TestCPUMemCollectorFakeRoot(t *testing.T) {
	dir := t.TempDir()
	writeTree(t, dir, map[string]string{
		"proc/stat":                   string(readTestdata(t, "proc_stat")),
		"proc/meminfo":                string(readTestdata(t, "meminfo")),
		"proc/loadavg":                string(readTestdata(t, "loadavg")),
		"proc/spl/kstat/zfs/arcstats": string(readTestdata(t, "arcstats")),
	})
	c := newCPUMemCollector(fsRoot(dir))
	if err := c.run(context.Background()); err != nil {
		t.Fatal(err)
	}
	if c.mem.ZFSARCBytes == nil || c.mem.TotalBytes == 0 || c.cpu.Load[0] == 0 {
		t.Errorf("mem %+v cpu %+v", c.mem, c.cpu)
	}
}
