package macos

import (
	"context"
	"sort"
	"strings"
	"time"

	"github.com/shirou/gopsutil/v4/cpu"
	"github.com/shirou/gopsutil/v4/disk"
	"github.com/shirou/gopsutil/v4/load"
	"github.com/shirou/gopsutil/v4/mem"
	"github.com/shirou/gopsutil/v4/net"
	"github.com/shirou/gopsutil/v4/sensors"

	"rackoon/internal/proto"
)

// rates keeps the previous counters the per-second values come from.
type rates struct {
	at     time.Time
	cpu    cpu.TimesStat
	hasCPU bool
	disk   map[string]disk.IOCountersStat
	net    map[string]net.IOCountersStat
}

// fastSample is one reading of the counters the fast part turns into
// per-second values.
type fastSample struct {
	at    time.Time
	times []cpu.TimesStat
	dio   map[string]disk.IOCountersStat
	nio   []net.IOCountersStat
	err   error
}

func readCounters(ctx context.Context) fastSample {
	var s fastSample
	keep := func(err error) {
		if err != nil && s.err == nil {
			s.err = err
		}
	}
	var err error
	s.times, err = cpu.TimesWithContext(ctx, false)
	keep(err)
	s.dio, err = disk.IOCountersWithContext(ctx)
	keep(err)
	s.nio, err = net.IOCountersWithContext(ctx, true)
	keep(err)
	s.at = time.Now()
	return s
}

// runFast reads CPU, memory, swap and load, and the disks' and network
// interfaces' rates. The first run reads the counters twice, a second
// apart, so the first report has rates too.
func (c *Collector) runFast(ctx context.Context) error {
	c.mu.Lock()
	first := !c.rates.hasCPU
	c.mu.Unlock()
	if first {
		base := readCounters(ctx)
		c.mu.Lock()
		c.storeCounters(base)
		c.mu.Unlock()
		select {
		case <-ctx.Done():
		case <-time.After(time.Second):
		}
	}
	s := readCounters(ctx)
	firstErr := s.err
	keep := func(err error) {
		if err != nil && firstErr == nil {
			firstErr = err
		}
	}
	vm, err := mem.VirtualMemoryWithContext(ctx)
	keep(err)
	sw, err := mem.SwapMemoryWithContext(ctx)
	keep(err)
	avg, err := load.AvgWithContext(ctx)
	keep(err)
	times, dio, nio, now := s.times, s.dio, s.nio, s.at

	c.mu.Lock()
	defer c.mu.Unlock()
	prev := c.rates
	dt := now.Sub(prev.at).Seconds()
	if len(times) > 0 {
		t := times[0]
		if prev.hasCPU {
			c.cpu = cpuPercent(prev.cpu, t)
		}
		c.rates.cpu, c.rates.hasCPU = t, true
	}
	if avg != nil {
		c.cpu.Load = [3]float64{round2(avg.Load1), round2(avg.Load5), round2(avg.Load15)}
	}
	if vm != nil {
		c.mem = proto.Memory{TotalBytes: vm.Total, AvailableBytes: vm.Available, FreeBytes: vm.Free, CachedBytes: vm.Inactive}
		if vm.Total >= vm.Available {
			c.mem.UsedBytes = vm.Total - vm.Available
		}
	}
	if sw != nil {
		c.mem.SwapTotalBytes, c.mem.SwapUsedBytes = sw.Total, sw.Used
	}
	if dio != nil {
		io := map[string]*proto.DiskIO{}
		for name, cur := range dio {
			old, ok := prev.disk[name]
			if !ok || dt <= 0 || cur.ReadBytes < old.ReadBytes || cur.WriteBytes < old.WriteBytes {
				continue
			}
			x := &proto.DiskIO{
				ReadBps:   round1(float64(cur.ReadBytes-old.ReadBytes) / dt),
				WriteBps:  round1(float64(cur.WriteBytes-old.WriteBytes) / dt),
				ReadIOPS:  round1(float64(sub(cur.ReadCount, old.ReadCount)) / dt),
				WriteIOPS: round1(float64(sub(cur.WriteCount, old.WriteCount)) / dt),
			}
			if busy := float64(sub(cur.IoTime, old.IoTime)); busy > 0 {
				x.UtilPct = round1(min(busy/(dt*1000)*100, 100))
			}
			if n := sub(cur.ReadCount, old.ReadCount) + sub(cur.WriteCount, old.WriteCount); n > 0 {
				x.AwaitMs = round2(float64(sub(cur.ReadTime, old.ReadTime)+sub(cur.WriteTime, old.WriteTime)) / float64(n))
			}
			io[name] = x
		}
		c.diskIO = io
		c.rates.disk = dio
	}
	if nio != nil {
		cur := map[string]net.IOCountersStat{}
		nr := map[string][2]float64{}
		ne := map[string][4]uint64{}
		for _, n := range nio {
			cur[n.Name] = n
			ne[n.Name] = [4]uint64{n.Errin, n.Errout, n.Dropin, n.Dropout}
			if old, ok := prev.net[n.Name]; ok && dt > 0 && n.BytesRecv >= old.BytesRecv && n.BytesSent >= old.BytesSent {
				nr[n.Name] = [2]float64{round1(float64(n.BytesRecv-old.BytesRecv) / dt), round1(float64(n.BytesSent-old.BytesSent) / dt)}
			}
		}
		c.netRates, c.netErrs = nr, ne
		c.rates.net = cur
	}
	c.rates.at = now
	return firstErr
}

// storeCounters keeps a reading as the base of the next rates (c.mu
// held).
func (c *Collector) storeCounters(s fastSample) {
	if len(s.times) > 0 {
		c.rates.cpu, c.rates.hasCPU = s.times[0], true
	}
	if s.dio != nil {
		c.rates.disk = s.dio
	}
	if s.nio != nil {
		c.rates.net = map[string]net.IOCountersStat{}
		for _, n := range s.nio {
			c.rates.net[n.Name] = n
		}
	}
	c.rates.at = s.at
}

func sub(a, b uint64) uint64 {
	if a < b {
		return 0
	}
	return a - b
}

// cpuPercent is the CPU use between two readings, in percent of all
// logical CPUs.
func cpuPercent(a, b cpu.TimesStat) proto.CPU {
	total := func(t cpu.TimesStat) float64 {
		return t.User + t.System + t.Idle + t.Nice + t.Iowait + t.Irq + t.Softirq + t.Steal
	}
	d := total(b) - total(a)
	if d <= 0 {
		return proto.CPU{}
	}
	pct := func(x, y float64) float64 { return round1(max(y-x, 0) / d * 100) }
	user := pct(a.User+a.Nice, b.User+b.Nice)
	sys := pct(a.System+a.Irq+a.Softirq, b.System+b.Irq+b.Softirq)
	idle := pct(a.Idle, b.Idle)
	return proto.CPU{UsagePct: round1(max(100-idle, 0)), UserPct: user, SystemPct: sys}
}

// ---- temperatures ----------------------------------------------------------------------

// Temperature groups of a Mac: Apple silicon reports its dies ("PMU
// tdie3"), GPU clusters ("PMU TP2g") and NAND channels ("NAND CH0 temp")
// through HID sensors; Intel Macs report SMC keys (TC… CPU, TG… GPU).
// Apple silicon runs hotter by design (it slows itself near 105 °C).
type sensorKind struct {
	id, label, group string
	limit            float64
}

var (
	macCPU      = sensorKind{proto.SensorCPU, "CPU package", "cpu", 105}
	intelCPU    = sensorKind{proto.SensorCPU, "CPU package", "cpu", 100}
	macGPU      = sensorKind{proto.SensorGPU, "GPU, hottest", "gpu", 105}
	intelGPU    = sensorKind{proto.SensorGPU, "GPU, hottest", "gpu", 100}
	macNVMe     = sensorKind{proto.SensorNVMe, "NVMe, hottest", "nvme", 75}
	sensorOrder = []string{proto.SensorCPU, proto.SensorGPU, proto.SensorNVMe}
)

func classify(key string) (sensorKind, bool) {
	switch {
	case strings.HasPrefix(key, "PMU tdie"), strings.HasPrefix(key, "pACC"), strings.HasPrefix(key, "eACC"):
		return macCPU, true
	case strings.HasPrefix(key, "PMU TP") && strings.HasSuffix(key, "g"), strings.HasPrefix(key, "GPU MTR"):
		return macGPU, true
	case strings.HasPrefix(key, "NAND"):
		return macNVMe, true
	case len(key) == 4 && strings.HasPrefix(key, "TC"):
		return intelCPU, true
	case len(key) == 4 && strings.HasPrefix(key, "TG"):
		return intelGPU, true
	}
	return sensorKind{}, false
}

// Temps is one temperature reading.
type Temp struct {
	Key   string
	TempC float64
}

// GroupTemps reports each group's hottest sensor.
func GroupTemps(in []Temp) []proto.Sensor {
	best := map[string]proto.Sensor{}
	count := map[string]int{}
	for _, t := range in {
		k, ok := classify(t.Key)
		if !ok || t.TempC <= 0 || t.TempC > 150 {
			continue
		}
		count[k.id]++
		if b, ok := best[k.id]; ok && b.TempC >= t.TempC {
			continue
		}
		best[k.id] = proto.Sensor{ID: k.id, Label: k.label, Group: k.group, Source: t.Key, TempC: round1(t.TempC), LimitC: k.limit}
	}
	out := []proto.Sensor{}
	for _, id := range sensorOrder {
		if s, ok := best[id]; ok {
			if n := count[id]; n > 1 {
				s.Source += " · " + itoa(n) + " sensors"
			}
			out = append(out, s)
		}
	}
	return out
}

func (c *Collector) runSensors(ctx context.Context) error {
	ts, err := sensors.TemperaturesWithContext(ctx)
	if len(ts) == 0 && err != nil {
		return err
	}
	in := make([]Temp, 0, len(ts))
	for _, t := range ts {
		in = append(in, Temp{Key: t.SensorKey, TempC: t.Temperature})
	}
	sort.SliceStable(in, func(i, j int) bool { return in[i].Key < in[j].Key })
	out := GroupTemps(in)
	c.mu.Lock()
	c.sensors = out
	c.mu.Unlock()
	return nil
}
