package collect

import (
	"os"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// clockTicks is USER_HZ; 100 on every Linux architecture the agent targets.
const clockTicks = 100

// selfStats measures the agent's own CPU use (including waited-for child
// processes such as smartctl and zpool) and RSS.
type selfStats struct {
	mu       sync.Mutex
	lastAt   time.Time
	lastCPU  float64 // seconds
	firstAt  time.Time
	firstCPU float64
}

func newSelfStats() *selfStats {
	s := &selfStats{}
	if t, ok := ProcessCPUSeconds(); ok {
		s.lastAt, s.lastCPU = time.Now(), t
		s.firstAt, s.firstCPU = s.lastAt, t
	}
	return s
}

// sample returns RSS bytes and CPU percent of one core since the previous
// sample.
func (s *selfStats) sample() (uint64, float64) {
	rss := ProcessRSS()
	t, ok := ProcessCPUSeconds()
	if !ok {
		return rss, 0
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	var pct float64
	if !s.lastAt.IsZero() {
		if dt := now.Sub(s.lastAt).Seconds(); dt > 0 {
			pct = round2((t - s.lastCPU) / dt * 100)
		}
	}
	s.lastAt, s.lastCPU = now, t
	return rss, pct
}

// ProcessCPUSeconds returns user+system CPU seconds of this process plus its
// reaped children (smartctl, zpool, apt-get: the helpers the collectors
// start and wait for), from getrusage (microseconds, where /proc/self/stat
// counts 10 ms ticks).
func ProcessCPUSeconds() (float64, bool) {
	var self, children syscall.Rusage
	if syscall.Getrusage(syscall.RUSAGE_SELF, &self) != nil || syscall.Getrusage(syscall.RUSAGE_CHILDREN, &children) != nil {
		b, err := os.ReadFile("/proc/self/stat")
		if err != nil {
			return 0, false
		}
		return parseProcStatCPU(string(b))
	}
	tv := func(t syscall.Timeval) float64 { return float64(t.Sec) + float64(t.Usec)/1e6 }
	return tv(self.Utime) + tv(self.Stime) + tv(children.Utime) + tv(children.Stime), true
}

// parseProcStatCPU extracts utime+stime+cutime+cstime (seconds) from the
// contents of /proc/<pid>/stat.
func parseProcStatCPU(s string) (float64, bool) {
	// The comm field may contain spaces; fields start after the last ')'.
	i := strings.LastIndexByte(s, ')')
	if i < 0 {
		return 0, false
	}
	f := strings.Fields(s[i+1:])
	// f[0] is field 3 (state); utime is field 14 -> f[11].
	if len(f) < 15 {
		return 0, false
	}
	var sum float64
	for _, k := range []int{11, 12, 13, 14} {
		v, err := strconv.ParseFloat(f[k], 64)
		if err != nil {
			return 0, false
		}
		sum += v
	}
	return sum / clockTicks, true
}

// procStartTicks returns field 22 (starttime, clock ticks after boot) of
// /proc/<pid>/stat.
func procStartTicks(stat string) (uint64, bool) {
	i := strings.LastIndexByte(stat, ')')
	if i < 0 {
		return 0, false
	}
	f := strings.Fields(stat[i+1:])
	if len(f) < 20 {
		return 0, false
	}
	v, err := strconv.ParseUint(f[19], 10, 64)
	return v, err == nil
}

// ProcessRSS returns the resident set size of this process in bytes.
func ProcessRSS() uint64 {
	b, err := os.ReadFile("/proc/self/statm")
	if err != nil {
		return 0
	}
	f := strings.Fields(string(b))
	if len(f) < 2 {
		return 0
	}
	pages, err := strconv.ParseUint(f[1], 10, 64)
	if err != nil {
		return 0
	}
	return pages * uint64(os.Getpagesize())
}
