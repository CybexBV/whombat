package hostmetrics

import (
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
)

// cpuTimes is /proc/stat's aggregate line in clock ticks since boot: busy is everything but idle and iowait.
type cpuTimes struct{ busy, total uint64 }

// readCPU reads the aggregate `cpu` line of <proc>/stat and counts its `cpuN` lines (the online cores). guest and
// guest_nice are left out of the total: the kernel counts them in user and nice already.
func readCPU(proc string) (cpuTimes, int, error) {
	b, err := os.ReadFile(filepath.Join(proc, "stat"))
	if err != nil {
		return cpuTimes{}, 0, err
	}
	var t cpuTimes
	found, cores := false, 0
	for _, line := range strings.Split(string(b), "\n") {
		f := strings.Fields(line)
		if len(f) == 0 || !strings.HasPrefix(f[0], "cpu") {
			continue
		}
		if f[0] != "cpu" {
			if _, err := strconv.ParseUint(f[0][3:], 10, 32); err == nil {
				cores++
			}
			continue
		}
		if len(f) < 5 {
			return cpuTimes{}, 0, errors.New("/proc/stat: short cpu line")
		}
		var v [8]uint64 // user nice system idle iowait irq softirq steal
		for i := 0; i < len(v) && i+1 < len(f); i++ {
			n, err := strconv.ParseUint(f[i+1], 10, 64)
			if err != nil {
				return cpuTimes{}, 0, errors.New("/proc/stat: bad cpu line")
			}
			v[i] = n
		}
		for _, n := range v {
			t.total += n
		}
		idle := v[3] + v[4]
		t.busy = t.total - min(idle, t.total)
		found = true
	}
	if !found {
		return cpuTimes{}, 0, errors.New("/proc/stat: no cpu line")
	}
	return t, max(cores, 1), nil
}

// cpuPermille is the busy share of all cores between two readings, in tenths of a percent (0–1000). A total that
// didn't move (or went back) is 0.
func cpuPermille(prev, cur cpuTimes) uint16 {
	if cur.total <= prev.total {
		return 0
	}
	dt := cur.total - prev.total
	db := uint64(0)
	if cur.busy > prev.busy {
		db = min(cur.busy-prev.busy, dt) // iowait can go back on tickless kernels, making busy jump
	}
	return uint16((db*1000 + dt/2) / dt)
}

// readMemory is MemTotal and MemTotal − MemAvailable of <proc>/meminfo, in bytes.
func readMemory(proc string) (total, used uint64, err error) {
	b, err := os.ReadFile(filepath.Join(proc, "meminfo"))
	if err != nil {
		return 0, 0, err
	}
	kb := map[string]uint64{}
	for _, line := range strings.Split(string(b), "\n") {
		name, rest, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		f := strings.Fields(rest)
		if len(f) == 0 {
			continue
		}
		if n, err := strconv.ParseUint(f[0], 10, 64); err == nil {
			kb[name] = n
		}
	}
	t, ok := kb["MemTotal"]
	if !ok {
		return 0, 0, errors.New("/proc/meminfo: no MemTotal")
	}
	avail, ok := kb["MemAvailable"]
	if !ok {
		avail = kb["MemFree"] + kb["Buffers"] + kb["Cached"] // kernels before 3.14
	}
	return t * 1024, (t - min(avail, t)) * 1024, nil
}

// ifName is what HostNow.uplink accepts (and what a Linux interface name can be).
var ifName = regexp.MustCompile(`^[A-Za-z0-9_.:@-]{1,15}$`)

// maxUplinks is HostNow.uplink's limit.
const maxUplinks = 8

// readUplink is the interfaces of the IPv4 default routes in <proc>/net/route (destination and mask 0, up), in the
// table's order, each once. A box with several (two links, a failover) counts them all.
func readUplink(proc string) ([]string, error) {
	b, err := os.ReadFile(filepath.Join(proc, "net", "route"))
	if err != nil {
		return nil, err
	}
	var out []string
	for i, line := range strings.Split(string(b), "\n") {
		f := strings.Fields(line)
		if i == 0 || len(f) < 8 {
			continue // the header, a blank line
		}
		flags, err := strconv.ParseUint(f[3], 16, 32)
		if err != nil || flags&0x1 == 0 || f[1] != "00000000" || f[7] != "00000000" {
			continue // not up (RTF_UP), not the default route
		}
		if ifName.MatchString(f[0]) && !slices.Contains(out, f[0]) && len(out) < maxUplinks {
			out = append(out, f[0])
		}
	}
	return out, nil
}

// ifCounter is one interface's byte counters and its index (a recreated interface gets a new one).
type ifCounter struct {
	index  int64
	rx, tx uint64
}

// readCounter reads <sys>/class/net/<name>/{ifindex,statistics/rx_bytes,statistics/tx_bytes}.
func readCounter(sys, name string) (ifCounter, error) {
	dir := filepath.Join(sys, "class", "net", name)
	idx, err := readUint(filepath.Join(dir, "ifindex"))
	if err != nil {
		return ifCounter{}, err
	}
	rx, err := readUint(filepath.Join(dir, "statistics", "rx_bytes"))
	if err != nil {
		return ifCounter{}, err
	}
	tx, err := readUint(filepath.Join(dir, "statistics", "tx_bytes"))
	if err != nil {
		return ifCounter{}, err
	}
	return ifCounter{index: int64(idx), rx: rx, tx: tx}, nil
}

// counterDelta is what an interface moved since the last sample. An interface not seen then is a baseline (its
// counters hold what it moved before it became the uplink or before the manager started: 0); a recreated one (another
// ifindex) or a counter that went back started again from zero, so its whole count is new.
func counterDelta(prev map[string]ifCounter, name string, cur ifCounter) (rx, tx uint64) {
	p, ok := prev[name]
	if !ok {
		return 0, 0
	}
	if p.index != cur.index {
		return cur.rx, cur.tx
	}
	since := func(was, now uint64) uint64 {
		if now < was {
			return now
		}
		return now - was
	}
	return since(p.rx, cur.rx), since(p.tx, cur.tx)
}

// containersCgroup is the agent's container engine's cgroup (containers.nix, NX-457): the engine, its conmons and every
// container (`cgroups = "split"` keeps them under it), relative to <sys>/fs/cgroup.
const containersCgroup = "whombat.slice/whombat-tasks.slice/whombat-containers.service"

// readContainersMemory is what the agent's containers use (NX-468): the engine's cgroup's memory.current less the page
// cache the kernel would drop first (memory.stat inactive_file, as `docker stats` counts), the counterpart of
// MemTotal − MemAvailable. Nil when the engine isn't running or its cgroup can't be read.
func readContainersMemory(sys string) *uint64 {
	d := filepath.Join(sys, "fs", "cgroup", filepath.FromSlash(containersCgroup))
	cur, err := readUint(filepath.Join(d, "memory.current"))
	if err != nil {
		return nil
	}
	inactive := uint64(0)
	if b, err := os.ReadFile(filepath.Join(d, "memory.stat")); err == nil {
		for _, line := range strings.Split(string(b), "\n") {
			if v, ok := strings.CutPrefix(line, "inactive_file "); ok {
				inactive, _ = strconv.ParseUint(strings.TrimSpace(v), 10, 64)
			}
		}
	}
	v := cur - min(inactive, cur)
	return &v
}

func readUint(path string) (uint64, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return 0, err
	}
	return strconv.ParseUint(strings.TrimSpace(string(b)), 10, 64)
}
