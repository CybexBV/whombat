package macos

import (
	"context"
	"errors"
	"fmt"
	"os"
	"runtime"
	"sync"
	"sync/atomic"
	"time"

	"github.com/shirou/gopsutil/v4/process"

	"rackoon/internal/agent"
	"rackoon/internal/proto"
)

// Intervals of the collector's parts.
const (
	intervalFast    = 10 * time.Second // CPU, memory, load, rates, temperatures
	intervalHost    = time.Minute      // host facts, network setup, volumes, the Mac's facts
	intervalDisks   = 5 * time.Minute  // diskutil (and its SMART verdict)
	intervalUpdates = 30 * time.Minute // Software Update's own preferences: a file, no network
	hardwareEvery   = 24 * time.Hour   // system_profiler's model name
	portsEvery      = 10 * time.Minute // networksetup's hardware ports
	collectWait     = 5 * time.Second
)

// New returns the macOS collector (agent.Collector).
func New(cfg *agent.Config, version string) *Collector {
	if cfg == nil {
		cfg = &agent.Config{StateDir: agent.DefaultStateDir}
	}
	c := &Collector{cfg: cfg, version: version, started: time.Now()}
	c.add("cpu", intervalFast, 8*time.Second, false, c.runFast)
	c.add("sensors", intervalFast, 8*time.Second, false, c.runSensors)
	c.add("host", intervalHost, 30*time.Second, false, c.runHost)
	c.add("net", intervalHost, 30*time.Second, false, c.runNet)
	c.add("volumes", intervalHost, 30*time.Second, false, c.runVolumes)
	c.add("macos", intervalHost, 60*time.Second, false, c.runMac)
	c.add("disks", intervalDisks, 2*time.Minute, true, c.runDisks)
	c.updatesPart = c.add("updates", intervalUpdates, time.Minute, true, c.runUpdates)
	return c
}

// Collector implements agent.Collector on a Mac. Every part runs on its
// own interval and keeps its last result; Collect waits up to collectWait
// for the parts that are due and uses the previous result of any still
// running.
type Collector struct {
	cfg     *agent.Config
	version string
	started time.Time
	seq     atomic.Uint64
	parts   []*part

	updatesPart *part

	mu sync.Mutex
	// fast
	cpu      proto.CPU
	mem      proto.Memory
	rates    rates
	diskIO   map[string]*proto.DiskIO
	netRates map[string][2]float64
	netErrs  map[string][4]uint64
	sensors  []proto.Sensor
	// host
	host      proto.HostInfo
	mac       proto.MacOS
	hw        Hardware
	hwAt      time.Time
	ports     []HardwarePort
	portsAt   time.Time
	ifaces    []Iface
	primary   string
	procCount int
	helperMod time.Time
	helperVer string
	// storage
	vols  []volume
	disks []proto.Disk
	list  *DiskList
	// system
	sys     proto.SystemInfo
	selfCPU struct {
		at  time.Time
		cpu time.Duration
	}
}

// part is one scheduled piece of the collector.
type part struct {
	name     string
	interval time.Duration
	timeout  time.Duration
	noWait   bool
	run      func(ctx context.Context) error

	mu      sync.Mutex
	running bool
	hasRun  bool
	dirty   bool
	lastRun time.Time
	lastDur time.Duration
	lastErr error
}

func (c *Collector) add(name string, interval, timeout time.Duration, noWait bool, run func(context.Context) error) *part {
	p := &part{name: name, interval: interval, timeout: timeout, noWait: noWait, run: run}
	c.parts = append(c.parts, p)
	return p
}

func (p *part) due(now time.Time) bool {
	if p.running {
		return false
	}
	if !p.hasRun || p.dirty {
		return true
	}
	slack := min(max(p.interval/10, 3*time.Second), p.interval/2)
	return now.Sub(p.lastRun) >= p.interval-slack
}

func (p *part) start() chan struct{} {
	p.running, p.dirty = true, false
	done := make(chan struct{})
	go func() {
		defer close(done)
		t0 := time.Now()
		ctx, cancel := context.WithTimeout(context.Background(), p.timeout)
		err := safeRun(ctx, p.run)
		cancel()
		p.mu.Lock()
		p.running, p.hasRun = false, true
		p.lastRun, p.lastDur, p.lastErr = t0, time.Since(t0), err
		p.mu.Unlock()
	}()
	return done
}

func safeRun(ctx context.Context, fn func(context.Context) error) (err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("panic: %v", r)
		}
	}()
	return fn(ctx)
}

// RefreshPackages reads the waiting updates again at the next Collect (a
// package task ended).
func (c *Collector) RefreshPackages() {
	c.updatesPart.mu.Lock()
	c.updatesPart.dirty = true
	c.updatesPart.mu.Unlock()
}

// Events implements agent.Collector: a Mac has no guest platforms to
// stream events from.
func (c *Collector) Events() <-chan proto.Event { return nil }

// Collect implements agent.Collector.
func (c *Collector) Collect(ctx context.Context) (*proto.Report, error) {
	now := time.Now()
	var waits []chan struct{}
	for _, p := range c.parts {
		p.mu.Lock()
		if p.due(now) {
			done := p.start()
			if !p.noWait {
				waits = append(waits, done)
			}
		}
		p.mu.Unlock()
	}
	deadline := time.NewTimer(collectWait)
	defer deadline.Stop()
wait:
	for _, w := range waits {
		select {
		case <-w:
		case <-deadline.C:
			break wait
		case <-ctx.Done():
			break wait
		}
	}
	r := &proto.Report{At: time.Now().UTC(), Seq: c.seq.Add(1)}
	c.mu.Lock()
	r.Host = c.host
	r.Host.Addresses = append([]string(nil), c.host.Addresses...)
	if r.Host.MemoryTotalBytes == 0 {
		r.Host.MemoryTotalBytes = c.mem.TotalBytes
	}
	r.CPU, r.Memory = c.cpu, c.mem
	r.Sensors = append([]proto.Sensor(nil), c.sensors...)
	r.Filesystems = FilesystemsWithDisks(c.vols, c.list, c.disks)
	r.Disks = c.disksWithUse()
	r.Net = c.netIfaces()
	sys := c.sys
	sys.InitSystem = "launchd"
	sys.ProcessCount = c.procCount
	sys.Arch = runtime.GOARCH
	r.System = &sys
	mac := c.mac
	c.mu.Unlock()
	if r.Sensors == nil {
		r.Sensors = []proto.Sensor{}
	}
	if r.Disks == nil {
		r.Disks = []proto.Disk{}
	}
	if r.Filesystems == nil {
		r.Filesystems = []proto.Filesystem{}
	}
	r.Pools = []proto.Pool{}
	if mac.Version != "" {
		fillScreen(ctx, &mac)
		r.MacOS = &mac
	}
	r.Collectors = c.statuses()
	r.Policy = c.cfg.Policy()
	r.Agent = proto.AgentInfo{Version: c.version, StartedAt: c.started.UTC(), Arch: runtime.GOARCH, OS: runtime.GOOS}
	r.Agent.RSSBytes, r.Agent.CPUPct = c.selfSample()
	return r, nil
}

func (c *Collector) statuses() []proto.CollectorStatus {
	var out []proto.CollectorStatus
	for _, p := range c.parts {
		p.mu.Lock()
		if p.hasRun {
			st := proto.CollectorStatus{Name: p.name, OK: p.lastErr == nil, LastRun: p.lastRun.UTC(), DurationMs: int(p.lastDur / time.Millisecond)}
			if p.lastErr != nil {
				st.Error = clip(p.lastErr.Error(), 300)
			}
			out = append(out, st)
		}
		p.mu.Unlock()
	}
	return out
}

// selfSample is the agent's RSS and its CPU use (with its finished child
// processes) in percent of one core since the last report.
func (c *Collector) selfSample() (uint64, float64) {
	var rss uint64
	if p, err := process.NewProcess(int32(os.Getpid())); err == nil {
		if mi, err := p.MemoryInfo(); err == nil && mi != nil {
			rss = mi.RSS
		}
	}
	cpu, ok := agent.CPUTimeWithChildren()
	if !ok {
		return rss, 0
	}
	now := time.Now()
	c.mu.Lock()
	defer c.mu.Unlock()
	pct := 0.0
	if !c.selfCPU.at.IsZero() && cpu >= c.selfCPU.cpu {
		if dt := now.Sub(c.selfCPU.at).Seconds(); dt > 0 {
			pct = round2((cpu - c.selfCPU.cpu).Seconds() / dt * 100)
		}
	}
	c.selfCPU.at, c.selfCPU.cpu = now, cpu
	return rss, pct
}

// errNotMac: the collector's tools are macOS's.
var errNotMac = errors.New("not a Mac")

func round1(f float64) float64 { return float64(int64(f*10+0.5)) / 10 }
func round2(f float64) float64 { return float64(int64(f*100+0.5)) / 100 }
