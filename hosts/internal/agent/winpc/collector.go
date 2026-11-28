// Package winpc is the agent on a Windows PC: its collector (CPU, memory,
// drives, network, uptime, and Windows' own facts: Windows Update,
// Microsoft Defender, BitLocker, the disks' health), its broker (restart and
// shut down, the process, port, service and update lists) and its
// diagnostics (PowerShell commands as SYSTEM). It builds on every system so
// its parsing is tested anywhere; what only Windows can do is in the
// _windows files.
package winpc

import (
	"context"
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
	intervalFast    = 10 * time.Second // CPU, memory, network rates
	intervalHost    = time.Minute      // Windows' names, drives, addresses
	intervalFacts   = 5 * time.Minute  // Defender, Security Center, BitLocker, the disks' health
	intervalUpdates = 30 * time.Minute // Windows Update's own last check: no call to Microsoft
	collectWait     = 5 * time.Second
)

// New returns the Windows collector (agent.Collector).
func New(cfg *agent.Config, version string) *Collector {
	if cfg == nil {
		cfg = &agent.Config{StateDir: agent.DefaultStateDir}
	}
	c := &Collector{cfg: cfg, version: version, started: time.Now(), scriptDir: cfg.StateDir}
	c.add("cpu", intervalFast, 8*time.Second, false, c.runFast)
	c.add("host", intervalHost, 30*time.Second, false, c.runHost)
	c.add("windows", intervalFacts, 90*time.Second, true, c.runFacts)
	c.updatesPart = c.add("updates", intervalUpdates, 3*time.Minute, true, c.runUpdates)
	return c
}

// Collector implements agent.Collector on a Windows PC. Every part runs on
// its own interval and keeps its last result; Collect waits up to
// collectWait for the parts that are due (the PowerShell reads don't hold
// a report up) and uses the previous result of any still running.
type Collector struct {
	cfg       *agent.Config
	version   string
	started   time.Time
	scriptDir string
	seq       atomic.Uint64
	parts     []*part

	updatesPart *part

	mu sync.Mutex
	// fast
	cpu      proto.CPU
	mem      proto.Memory
	rates    rates
	netRates map[string][2]float64
	netErrs  map[string][4]uint64
	// host
	host      proto.HostInfo
	win       agent.WindowsVersion
	vols      []volume
	ifaces    []iface
	procCount int
	// facts and updates
	facts   *readFacts
	updates *windowsUpdates
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

// RefreshUpdates reads the waiting updates again at the next Collect.
func (c *Collector) RefreshUpdates() {
	c.updatesPart.mu.Lock()
	c.updatesPart.dirty = true
	c.updatesPart.mu.Unlock()
}

// Events implements agent.Collector: a PC has no guest platforms to stream
// events from.
func (c *Collector) Events() <-chan proto.Event { return nil }

// Updates is the last list of waiting updates (nil: not read yet).
func (c *Collector) Updates() []proto.PackageUpdate {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.updates == nil || c.updates.list == nil {
		return nil
	}
	return append([]proto.PackageUpdate{}, c.updates.list...)
}

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
	r.Filesystems, r.Disks = buildStorage(c.vols, c.facts)
	r.Net = c.netIfaces()
	r.System = c.system()
	r.Windows = c.windows()
	c.mu.Unlock()
	r.Sensors = []proto.Sensor{}
	r.Pools = []proto.Pool{}
	r.Collectors = c.statuses()
	r.Policy = c.cfg.Policy()
	r.Agent = proto.AgentInfo{Version: c.version, StartedAt: c.started.UTC(), Arch: runtime.GOARCH, OS: "windows"}
	r.Agent.RSSBytes, r.Agent.CPUPct = c.selfSample()
	return r, nil
}

// system is the report's SystemInfo: Windows Update's updates and restart
// in the fields Linux fills from its package manager (c.mu held).
func (c *Collector) system() *proto.SystemInfo {
	s := &proto.SystemInfo{InitSystem: "windows", ProcessCount: c.procCount, Arch: runtime.GOARCH, PackageManager: "windows_update"}
	if u := c.updates; u != nil {
		s.UpdatesPending, s.SecurityUpdates = u.pending, u.security
		s.UpdatesCheckedAt = u.checked
		s.UpdatesError = u.err
		s.RebootRequired, s.RebootReason = u.reboot, rebootReason(u)
	}
	return s
}

// windows is the report's Windows block (nil before Windows' names were
// read; c.mu held).
func (c *Collector) windows() *proto.Windows {
	v := c.win
	if v.ProductName == "" && v.CurrentBuild == "" {
		return nil
	}
	w := &proto.Windows{Product: v.Product(), DisplayVersion: v.DisplayVersion, Build: v.Build(), Edition: v.EditionID,
		Server: v.Server(), Manufacturer: v.Manufacturer, Model: v.Model}
	if u := c.updates; u != nil {
		w.UpdatesCheckedAt, w.UpdatesInstalledAt = u.checked, u.installed
	}
	if f := c.facts; f != nil {
		w.Defender, w.SecurityCenter = f.defender, f.sc
		w.Antivirus = append([]proto.WindowsAntivirus(nil), f.antivirus...)
		if f.bitlocker != nil {
			w.BitLocker = append([]proto.WindowsVolume{}, f.bitlocker...)
		}
	}
	return w
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

// selfSample is the agent's working set and its CPU use in percent of one
// core since the last report.
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

// runFacts reads Defender, Security Center, BitLocker and the disks.
func (c *Collector) runFacts(ctx context.Context) error {
	out, err := runScript(ctx, c.scriptDir, "whombat-facts.ps1", factsScript, 80*time.Second)
	if err != nil {
		return err
	}
	f, err := parseFacts(out)
	if err != nil {
		return err
	}
	c.mu.Lock()
	c.facts = f
	c.mu.Unlock()
	return nil
}

// runUpdates reads Windows Update's waiting updates and restart.
func (c *Collector) runUpdates(ctx context.Context) error {
	out, err := runScript(ctx, c.scriptDir, "whombat-updates.ps1", updatesScript, 170*time.Second)
	if err != nil {
		return err
	}
	u, err := parseUpdates(out)
	if err != nil {
		return err
	}
	c.mu.Lock()
	c.updates = u
	c.mu.Unlock()
	if u.err != "" {
		return fmt.Errorf("Windows Update: %s", u.err)
	}
	return nil
}

func round1(f float64) float64 { return float64(int64(f*10+0.5)) / 10 }
func round2(f float64) float64 { return float64(int64(f*100+0.5)) / 100 }
