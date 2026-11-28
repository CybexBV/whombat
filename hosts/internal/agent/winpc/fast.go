package winpc

import (
	"context"
	"time"

	"github.com/shirou/gopsutil/v4/cpu"
	"github.com/shirou/gopsutil/v4/mem"
	"github.com/shirou/gopsutil/v4/net"

	"rackoon/internal/proto"
)

// rates keeps the previous counters the per-second values come from.
type rates struct {
	at     time.Time
	cpu    cpu.TimesStat
	hasCPU bool
	net    map[string]net.IOCountersStat
}

// runFast reads CPU, memory and the page file, and the network
// interfaces' rates. The first run reads the counters twice, a second
// apart, so the first report has rates too. Windows has no load average:
// Load stays zero.
func (c *Collector) runFast(ctx context.Context) error {
	c.mu.Lock()
	first := !c.rates.hasCPU
	c.mu.Unlock()
	if first {
		times, _ := cpu.TimesWithContext(ctx, false)
		nio, _ := net.IOCountersWithContext(ctx, true)
		c.mu.Lock()
		if len(times) > 0 {
			c.rates.cpu, c.rates.hasCPU = times[0], true
		}
		c.rates.net = netByName(nio)
		c.rates.at = time.Now()
		c.mu.Unlock()
		select {
		case <-ctx.Done():
		case <-time.After(time.Second):
		}
	}
	var firstErr error
	keep := func(err error) {
		if err != nil && firstErr == nil {
			firstErr = err
		}
	}
	times, err := cpu.TimesWithContext(ctx, false)
	keep(err)
	nio, err := net.IOCountersWithContext(ctx, true)
	keep(err)
	now := time.Now()
	vm, err := mem.VirtualMemoryWithContext(ctx)
	keep(err)
	sw, err := mem.SwapMemoryWithContext(ctx)
	keep(err)

	c.mu.Lock()
	defer c.mu.Unlock()
	prev := c.rates
	dt := now.Sub(prev.at).Seconds()
	if len(times) > 0 {
		if prev.hasCPU {
			c.cpu = cpuPercent(prev.cpu, times[0])
		}
		c.rates.cpu, c.rates.hasCPU = times[0], true
	}
	if vm != nil {
		c.mem = proto.Memory{TotalBytes: vm.Total, AvailableBytes: vm.Available, FreeBytes: vm.Free}
		if vm.Total >= vm.Available {
			c.mem.UsedBytes = vm.Total - vm.Available
		}
	}
	if sw != nil {
		c.mem.SwapTotalBytes, c.mem.SwapUsedBytes = sw.Total, sw.Used
	}
	if nio != nil {
		cur := netByName(nio)
		nr := map[string][2]float64{}
		ne := map[string][4]uint64{}
		for name, n := range cur {
			ne[name] = [4]uint64{n.Errin, n.Errout, n.Dropin, n.Dropout}
			if old, ok := prev.net[name]; ok && dt > 0 && n.BytesRecv >= old.BytesRecv && n.BytesSent >= old.BytesSent {
				nr[name] = [2]float64{round1(float64(n.BytesRecv-old.BytesRecv) / dt), round1(float64(n.BytesSent-old.BytesSent) / dt)}
			}
		}
		c.netRates, c.netErrs = nr, ne
		c.rates.net = cur
	}
	c.rates.at = now
	return firstErr
}

func netByName(nio []net.IOCountersStat) map[string]net.IOCountersStat {
	m := map[string]net.IOCountersStat{}
	for _, n := range nio {
		m[n.Name] = n
	}
	return m
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
	user := pct(a.User, b.User)
	sys := pct(a.System+a.Irq, b.System+b.Irq)
	idle := pct(a.Idle, b.Idle)
	return proto.CPU{UsagePct: round1(max(100-idle, 0)), UserPct: user, SystemPct: sys}
}
