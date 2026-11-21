package collect

import (
	"context"
	"strconv"
	"strings"
	"sync"
	"time"

	"rackoon/internal/proto"
)

// cpuTimes is the aggregate "cpu" line of /proc/stat (clock ticks).
type cpuTimes struct {
	user, nice, system, idle, iowait, irq, softirq, steal uint64
}

func (t cpuTimes) total() uint64 {
	return t.user + t.nice + t.system + t.idle + t.iowait + t.irq + t.softirq + t.steal
}

// parseProcStatCPU parses the first ("cpu ") line of /proc/stat. guest and
// guest_nice are already included in user and nice.
func parseCPULine(b []byte) (cpuTimes, bool) {
	var t cpuTimes
	ok := false
	scanLines(b, func(line string) {
		if ok || !strings.HasPrefix(line, "cpu ") {
			return
		}
		f := strings.Fields(line)
		vals := make([]uint64, 8)
		for i := 1; i < len(f) && i <= 8; i++ {
			vals[i-1], _ = strconv.ParseUint(f[i], 10, 64)
		}
		t = cpuTimes{vals[0], vals[1], vals[2], vals[3], vals[4], vals[5], vals[6], vals[7]}
		ok = true
	})
	return t, ok
}

// cpuPercents computes usage percentages between two samples. Usage counts
// everything except idle, iowait and steal: iowait is idle time waiting for
// I/O, steal is time the hypervisor gave to someone else (the host is a
// VM); both are reported separately.
func cpuPercents(prev, cur cpuTimes) proto.CPU {
	dt := float64(cur.total()) - float64(prev.total())
	if dt <= 0 {
		return proto.CPU{}
	}
	pct := func(a, b uint64) float64 {
		if a < b {
			return 0
		}
		return float64(a-b) / dt * 100
	}
	user := pct(cur.user, prev.user) + pct(cur.nice, prev.nice)
	system := pct(cur.system, prev.system) + pct(cur.irq, prev.irq) + pct(cur.softirq, prev.softirq)
	iowait := pct(cur.iowait, prev.iowait)
	idle := pct(cur.idle, prev.idle)
	steal := pct(cur.steal, prev.steal)
	usage := clamp(100-idle-iowait-steal, 0, 100)
	return proto.CPU{
		UsagePct:  round1(usage),
		UserPct:   round1(user),
		SystemPct: round1(system),
		IOWaitPct: round1(iowait),
		StealPct:  round1(steal),
	}
}

func parseLoadavg(s string) [3]float64 {
	var l [3]float64
	f := strings.Fields(s)
	for i := 0; i < 3 && i < len(f); i++ {
		l[i], _ = strconv.ParseFloat(f[i], 64)
	}
	return l
}

// memoryFromMeminfo builds Memory from /proc/meminfo values. Cached matches
// free(1)'s buff/cache column.
func memoryFromMeminfo(m map[string]uint64) proto.Memory {
	var mem proto.Memory
	mem.TotalBytes = m["MemTotal"]
	avail, ok := m["MemAvailable"]
	if !ok {
		avail = m["MemFree"] + m["Buffers"] + m["Cached"]
	}
	mem.AvailableBytes = avail
	if mem.TotalBytes > avail {
		mem.UsedBytes = mem.TotalBytes - avail
	}
	mem.FreeBytes = m["MemFree"]
	mem.CachedBytes = m["Buffers"] + m["Cached"] + m["SReclaimable"]
	mem.SwapTotalBytes = m["SwapTotal"]
	if mem.SwapTotalBytes > m["SwapFree"] {
		mem.SwapUsedBytes = mem.SwapTotalBytes - m["SwapFree"]
	}
	return mem
}

// parseARCSize returns "size" from /proc/spl/kstat/zfs/arcstats.
func parseARCSize(b []byte) (uint64, bool) {
	var v uint64
	ok := false
	scanLines(b, func(line string) {
		f := strings.Fields(line)
		if len(f) == 3 && f[0] == "size" {
			if n, err := strconv.ParseUint(f[2], 10, 64); err == nil {
				v, ok = n, true
			}
		}
	})
	return v, ok
}

// parsePSI returns the avg10 values of the "some" and "full" lines of a
// /proc/pressure file (full is absent for cpu on older kernels).
func parsePSI(b []byte) (some, full float64, ok bool) {
	scanLines(b, func(line string) {
		f := strings.Fields(line)
		if len(f) < 2 {
			return
		}
		for _, kv := range f[1:] {
			if v, found := strings.CutPrefix(kv, "avg10="); found {
				x, err := strconv.ParseFloat(v, 64)
				if err != nil {
					return
				}
				switch f[0] {
				case "some":
					some, ok = x, true
				case "full":
					full = x
				}
			}
		}
	})
	return
}

// readPressure reads /proc/pressure/{cpu,memory,io}; nil when the kernel
// has no PSI (CONFIG_PSI off, or psi=0 on the command line).
func readPressure(r fsRoot) *proto.Pressure {
	var p proto.Pressure
	b, err := r.read("/proc/pressure/cpu")
	if err != nil {
		return nil
	}
	var ok bool
	if p.CPUSome, _, ok = parsePSI(b); !ok {
		return nil
	}
	if b, err := r.read("/proc/pressure/memory"); err == nil {
		p.MemorySome, p.MemoryFull, _ = parsePSI(b)
	}
	if b, err := r.read("/proc/pressure/io"); err == nil {
		p.IOSome, p.IOFull, _ = parsePSI(b)
	}
	return &p
}

// cpuMemCollector samples /proc/stat, /proc/loadavg, /proc/meminfo, the
// ZFS ARC and pressure stall information every 10 s.
type cpuMemCollector struct {
	root fsRoot

	mu       sync.Mutex
	prev     cpuTimes
	havePrev bool
	cpu      proto.CPU
	mem      proto.Memory
	meminfo  map[string]uint64
	psi      *proto.Pressure
}

func newCPUMemCollector(root fsRoot) *cpuMemCollector { return &cpuMemCollector{root: root} }

func (c *cpuMemCollector) run(ctx context.Context) error {
	b, err := c.root.read("/proc/stat")
	if err != nil {
		return err
	}
	cur, ok := parseCPULine(b)
	if !ok {
		return errorf("/proc/stat: no cpu line")
	}
	c.mu.Lock()
	prev, havePrev := c.prev, c.havePrev
	c.mu.Unlock()
	if !havePrev {
		// First sample: measure over a short window instead of since boot.
		select {
		case <-time.After(250 * time.Millisecond):
		case <-ctx.Done():
			return ctx.Err()
		}
		prev = cur
		if b, err = c.root.read("/proc/stat"); err == nil {
			cur, _ = parseCPULine(b)
		}
	}
	cpu := cpuPercents(prev, cur)
	cpu.Load = parseLoadavg(c.root.readString("/proc/loadavg"))

	mb, err := c.root.read("/proc/meminfo")
	if err != nil {
		return err
	}
	mi := parseMeminfo(mb)
	mem := memoryFromMeminfo(mi)
	if ab, err := c.root.read("/proc/spl/kstat/zfs/arcstats"); err == nil {
		if v, ok := parseARCSize(ab); ok {
			mem.ZFSARCBytes = ptr(v)
		}
	}

	psi := readPressure(c.root)

	c.mu.Lock()
	c.prev, c.havePrev = cur, true
	c.cpu, c.mem, c.meminfo, c.psi = cpu, mem, mi, psi
	c.mu.Unlock()
	return nil
}

func (c *cpuMemCollector) fill(r *proto.Report) {
	c.mu.Lock()
	defer c.mu.Unlock()
	r.CPU = c.cpu
	r.Memory = c.mem
	if c.mem.ZFSARCBytes != nil {
		r.Memory.ZFSARCBytes = ptr(*c.mem.ZFSARCBytes)
	}
	r.Pressure = copyPtr(c.psi)
}
