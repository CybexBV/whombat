// Package collect implements agent.Collector: host, sensors, disks/SMART,
// KVM capabilities, Docker, Incus, libvirt and Proxmox VE collectors, and
// host health (packages, services, time, network, RAID, UPS, GPU).
//
// Every sub-collector runs on its own interval and caches its last result;
// Collect assembles a full Report from the caches. Sub-collectors that are
// due run concurrently; Collect waits for them up to collectWait and uses
// the previous result for any that are still running (they finish in the
// background). A failing sub-collector records its error in
// Report.Collectors (and, for guest platforms, in Platform.Error) but never
// fails the report.
package collect

import (
	"context"
	"errors"
	"fmt"
	"os"
	"runtime"
	"sync"
	"sync/atomic"
	"time"

	"rackoon/internal/agent"
	"rackoon/internal/proto"
)

// Intervals of the sub-collectors.
const (
	intervalFast    = 10 * time.Second // cpu/mem, sensors, guests, PVE resources
	intervalHost    = 60 * time.Second
	intervalDisks   = 60 * time.Second
	intervalSMART   = 10 * time.Minute
	intervalKVM     = 5 * time.Minute
	intervalPVESlow = 5 * time.Minute
	intervalSystem  = 60 * time.Second
	intervalUpdates = 6 * time.Hour
	intervalRAID    = 30 * time.Second
	intervalUPS     = 30 * time.Second
	intervalPlace   = 60 * time.Second
	// intervalImages is how often the image-update sub looks for images
	// whose last check is older than imageCheckEvery.
	intervalImages = 15 * time.Minute

	// collectWait bounds how long Collect waits for due sub-collectors.
	collectWait = 5 * time.Second
	// minEventGap is the minimum time between two runs of a platform
	// collector that was marked dirty by an event.
	minEventGap = 2 * time.Second
)

// New returns the host collector. version is the agent version reported in
// the report's AgentInfo.
func New(cfg *agent.Config, version string) agent.Collector {
	if cfg == nil {
		cfg = &agent.Config{}
	}
	c := &collector{
		cfg:     cfg,
		version: version,
		started: time.Now(),
		events:  make(chan proto.Event, 64),
		lastEv:  map[string]time.Time{},
	}
	tg := cfg.Collectors
	c.tg.Store(&tg)
	c.self = newSelfStats()
	c.host = newHostCollector("")
	c.cpu = newCPUMemCollector("")
	c.kvm = newKVMCollector("")
	c.disks = newDiskCollector("")
	c.smart = newSMARTCollector(func() *bool { return c.toggles().SMART }, c.disks)
	c.gpu = newGPUCollector("", func() *bool { return c.toggles().GPU }, c)
	c.sensors = newSensorsCollector("", c.smart, c.gpu)
	c.docker = newDockerCollector(func() *bool { return c.toggles().Docker }, c)
	c.images = newImageUpdater(func() *bool { return c.toggles().ImageUpdates }, c)
	c.incus = newIncusCollector(func() *bool { return c.toggles().Incus }, c)
	c.libvirt = newLibvirtCollector(func() *bool { return c.toggles().Libvirt }, c)
	c.pve = newPVECollector(cfg, c)
	c.system = newSystemCollector("", func() *bool { return c.toggles().Updates }, c)
	c.net = newNetCollector("")
	c.diskio = newDiskIOCollector("")
	c.raid = newRAIDCollector("", c)
	c.unraid = newUnraidCollector("", c)
	c.ups = newUPSCollector(func() *bool { return c.toggles().UPS }, c)
	c.place = newPlaceCollector()

	c.addSub("host", intervalHost, c.host.run, nil)
	c.addSub("cpu", intervalFast, c.cpu.run, nil)
	disksSub := c.addSub("disks", intervalDisks, c.disks.run, nil)
	c.addSub("diskio", intervalFast, c.diskio.run, nil)
	smartSub := c.addSub("smart", intervalSMART, c.smart.run, disksSub)
	smartSub.timeout = 4 * time.Minute
	smartSub.noWait = true
	c.gpuSub = c.addSub("gpu", intervalFast, c.gpu.run, nil)
	c.addSub("sensors", intervalFast, c.sensors.run, nil)
	c.addSub("net", intervalFast, c.net.run, nil)
	c.addSub("kvm", intervalKVM, c.kvm.run, nil)
	c.systemSub = c.addSub("system", intervalSystem, c.system.run, nil)
	c.updatesSub = c.addSub("updates", intervalUpdates, c.system.runUpdates, nil)
	c.updatesSub.timeout = 3 * time.Minute
	c.updatesSub.noWait = true
	c.raidSub = c.addSub("raid", intervalRAID, c.raid.run, nil)
	c.unraidSub = c.addSub("unraid", intervalRAID, c.unraid.run, nil)
	c.upsSub = c.addSub("ups", intervalUPS, c.ups.run, nil)
	c.placeSub = c.addSub("backup_place", intervalPlace, c.place.run, nil)
	c.dockerSub = c.addSub(proto.PlatformDocker, intervalFast, c.docker.run, nil)
	c.imagesSub = c.addSub("image_updates", intervalImages, c.images.run, c.dockerSub)
	c.imagesSub.timeout = imageRunTimeout
	c.imagesSub.noWait = true
	c.incusSub = c.addSub(proto.PlatformIncus, intervalFast, c.incus.run, nil)
	c.libvirtSub = c.addSub(proto.PlatformLibvirt, intervalFast, c.libvirt.run, nil)
	c.pveSub = c.addSub(proto.PlatformPVE, intervalFast, c.pve.run, nil)
	c.pveSlowSub = c.addSub("pve_storage", intervalPVESlow, c.pve.runSlow, c.pveSub)
	c.pveSlowSub.timeout = 2 * time.Minute
	c.pveSlowSub.noWait = true
	return c
}

type collector struct {
	cfg     *agent.Config
	version string
	started time.Time
	seq     atomic.Uint64
	// tg holds the [collectors] toggles; SetCollectors replaces them on
	// reload.
	tg atomic.Pointer[agent.Collectors]

	subs []*sub

	self    *selfStats
	host    *hostCollector
	cpu     *cpuMemCollector
	kvm     *kvmCollector
	disks   *diskCollector
	smart   *smartCollector
	sensors *sensorsCollector
	docker  *dockerCollector
	incus   *incusCollector
	libvirt *libvirtCollector
	pve     *pveCollector
	system  *systemCollector
	net     *netCollector
	diskio  *diskIOCollector
	raid    *raidCollector
	unraid  *unraidCollector
	ups     *upsCollector
	place   *placeCollector
	gpu     *gpuCollector
	images  *imageUpdater

	dockerSub, incusSub, libvirtSub, pveSub, pveSlowSub *sub
	updatesSub, raidSub, upsSub, gpuSub, imagesSub      *sub
	unraidSub, systemSub, placeSub                      *sub

	bgOnce   sync.Once
	bgCtx    context.Context
	bgCancel context.CancelFunc

	events  chan proto.Event
	evMu    sync.Mutex
	lastEv  map[string]time.Time
	dropped atomic.Uint64 // events lost because the channel was full
}

// toggles returns the current [collectors] settings.
func (c *collector) toggles() agent.Collectors {
	if p := c.tg.Load(); p != nil {
		return *p
	}
	return agent.Collectors{}
}

// SetCollectors applies new [collectors] toggles (agent reload). Every
// sub-collector runs again at the next Collect, so a collector switched
// on or off shows up or disappears within one report interval.
func (c *collector) SetCollectors(cc agent.Collectors) {
	c.tg.Store(&cc)
	for _, s := range c.subs {
		s.markDirty()
	}
}

// RefreshBackupJobs reads the Proxmox VE backup jobs (and with them the
// guests' coverage) again at the next Collect: a job was changed through
// the agent.
func (c *collector) RefreshBackupJobs() { c.pveSlowSub.markDirty() }

// RefreshBackupPlace reads the backup place and the Docker containers
// again at the next Collect: a place changed through the agent.
func (c *collector) RefreshBackupPlace() {
	c.placeSub.markDirty()
	c.dockerSub.markDirty()
}

// RefreshPackages reads the waiting updates and the reboot need again at
// the next Collect: a package task ended (an install, a check that
// refreshed the lists).
func (c *collector) RefreshPackages() {
	c.updatesSub.markDirty()
	c.systemSub.markDirty()
}

// RefreshApps reads the Docker containers and their image updates again at
// the next Collect: an app update started or ended.
func (c *collector) RefreshApps() {
	c.dockerSub.markDirty()
	c.imagesSub.markDirty()
}

// RefreshUnraid reads unRAID's state, the Docker containers and the
// libvirt domains' autostart again at the next Collect: an unRAID
// operation, a container update or an autostart change went through the
// agent.
func (c *collector) RefreshUnraid() {
	c.unraidSub.markDirty()
	c.dockerSub.markDirty()
	c.libvirt.dropAutostart()
	c.libvirtSub.markDirty()
}

// toggleFn reads a collector toggle when the collector runs (reload
// changes them); nil means auto-detect.
type toggleFn func() *bool

func (f toggleFn) enabled(detected bool) bool {
	if f == nil {
		return detected
	}
	return agent.Enabled(f(), detected)
}

// partialError marks a run that worked with problems worth showing (one
// disk without SMART data, a package check that failed): the collector is
// reported OK, with the message, and no collector.error event is sent.
type partialError struct{ msg string }

func (e *partialError) Error() string { return e.msg }

func partial(msg string) error { return &partialError{msg: msg} }

func isPartial(err error) bool {
	var p *partialError
	return errors.As(err, &p)
}

// keepOnError is how long a platform collector keeps reporting its last
// guests after it starts failing (a daemon restart, one slow API call). An
// empty list would make the hub treat every guest as gone and close their
// consoles; past this the error stands alone.
const keepOnError = 2 * time.Minute

// failedPlatform is the platform reported after a failed run: the error,
// plus the previous guests while the last success is recent.
func failedPlatform(prev *proto.Platform, lastGood time.Time, version string, err error) *proto.Platform {
	p := &proto.Platform{Version: version, Error: err.Error()}
	if prev != nil && !lastGood.IsZero() && time.Since(lastGood) < keepOnError {
		p.Guests = prev.Guests
	}
	return p
}

// sub is one scheduled sub-collector.
type sub struct {
	name     string
	interval time.Duration
	timeout  time.Duration
	run      func(ctx context.Context) error
	after    *sub // do not run before this sub has run once
	// noWait: Collect starts the sub but does not wait for it (slow
	// sub-collectors such as SMART); the result is used from the next report.
	noWait bool

	mu       sync.Mutex
	running  bool
	runStart time.Time // start of the current run
	hasRun   bool
	lastRun  time.Time
	lastDur  time.Duration
	lastErr  error
	dirty    bool
	// absent is set by platform collectors whose platform is not
	// installed: they are left out of Report.Collectors.
	absent bool
}

func (c *collector) addSub(name string, interval time.Duration, run func(context.Context) error, after *sub) *sub {
	s := &sub{name: name, interval: interval, run: run, after: after, timeout: 30 * time.Second}
	c.subs = append(c.subs, s)
	return s
}

// markDirty asks for the sub to run at the next Collect (event-driven
// refresh), subject to minEventGap.
func (s *sub) markDirty() {
	if s == nil {
		return
	}
	s.mu.Lock()
	s.dirty = true
	s.mu.Unlock()
}

// due reports whether s should start now. Callers hold s.mu.
func (s *sub) due(now time.Time) bool {
	if s.running {
		return false
	}
	if s.after != nil {
		s.after.mu.Lock()
		ok := s.after.hasRun
		s.after.mu.Unlock()
		if !ok {
			return false
		}
	}
	if !s.hasRun {
		return true
	}
	since := now.Sub(s.lastRun)
	if s.dirty && since >= minEventGap {
		return true
	}
	// Slack so a 10 s sub-collector runs on every 10 s Collect even when
	// the ticker jitters or an event-triggered run happened a few seconds
	// before the regular one (keeps live values under 15 s old).
	slack := max(s.interval/10, 3*time.Second)
	slack = min(slack, s.interval/2)
	return since >= s.interval-slack
}

// start runs s in a goroutine and returns its done channel.
func (s *sub) start(ctx context.Context, c *collector) chan struct{} {
	s.running = true
	s.runStart = time.Now()
	s.dirty = false
	done := make(chan struct{})
	go func() {
		defer close(done)
		t0 := time.Now()
		rctx, cancel := context.WithTimeout(ctx, s.timeout)
		err := safeRun(rctx, s.run)
		cancel()
		dur := time.Since(t0)
		s.mu.Lock()
		prevErr := s.lastErr
		hadRun := s.hasRun
		s.running = false
		s.hasRun = true
		s.lastRun = t0
		s.lastDur = dur
		s.lastErr = err
		absent := s.absent
		s.mu.Unlock()
		if err != nil && !absent && !isPartial(err) && (!hadRun || prevErr == nil || prevErr.Error() != err.Error()) {
			c.emit(proto.Event{Kind: "collector.error", Platform: platformOf(s.name), Message: fmt.Sprintf("%s: %v", s.name, err)}, false)
		}
	}()
	return done
}

func platformOf(name string) string {
	switch name {
	case proto.PlatformDocker, proto.PlatformIncus, proto.PlatformLibvirt, proto.PlatformPVE:
		return name
	case "pve_storage":
		return proto.PlatformPVE
	case "image_updates":
		return proto.PlatformDocker
	}
	return ""
}

// safeRun converts a panic in a sub-collector into an error so one broken
// parser cannot take the agent down.
func safeRun(ctx context.Context, fn func(context.Context) error) (err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("panic: %v", r)
		}
	}()
	return fn(ctx)
}

func (c *collector) startBackground() {
	c.bgOnce.Do(func() {
		c.bgCtx, c.bgCancel = context.WithCancel(context.Background())
		c.docker.startEvents(c.bgCtx)
		c.incus.startEvents(c.bgCtx)
		c.libvirt.startEvents(c.bgCtx)
	})
}

// Collect implements agent.Collector.
func (c *collector) Collect(ctx context.Context) (*proto.Report, error) {
	c.startBackground()
	now := time.Now()
	var waits []chan struct{}
	for _, s := range c.subs {
		s.mu.Lock()
		if s.due(now) {
			done := s.start(c.bgCtx, c)
			if !s.noWait {
				waits = append(waits, done)
			}
		}
		s.mu.Unlock()
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
	// Second pass: subs whose dependency just finished its first run (smart
	// after disks, PVE after host) start now; they report next time.
	now = time.Now()
	for _, s := range c.subs {
		s.mu.Lock()
		if s.due(now) {
			s.start(c.bgCtx, c)
		}
		s.mu.Unlock()
	}

	r := &proto.Report{
		At:  time.Now().UTC(),
		Seq: c.seq.Add(1),
	}
	r.Host = c.host.snapshot()
	c.cpu.fill(r)
	if r.Host.MemoryTotalBytes == 0 {
		r.Host.MemoryTotalBytes = r.Memory.TotalBytes
	}
	r.Sensors = c.sensors.snapshot()
	r.Fans = c.sensors.fanSnapshot()
	c.disks.fill(r)
	c.smart.enrich(r.Disks)
	c.diskio.fill(r.Disks)
	r.KVM = c.kvm.snapshot()
	r.Docker = c.docker.snapshot()
	r.Incus = c.incus.snapshot()
	r.Libvirt = c.libvirt.snapshot()
	r.PVE = c.pve.snapshot()
	c.system.oom.resolve(oomGuests(r, c.docker.containerName))
	r.System = c.system.snapshot()
	r.Net = c.net.snapshot()
	r.RAID = c.raid.snapshot()
	r.Unraid = c.unraid.snapshot(r)
	c.unraid.enrichDocker(r.Docker, c.docker.extrasSnapshot(), r.Host.Addresses)
	r.UPS = c.ups.snapshot()
	r.BackupPlace = c.place.snapshot(r.Host.Addresses, r.Unraid)
	r.GPUs = c.gpu.snapshot()
	r.Collectors = c.statuses()
	c.markStuckPlatforms(r)
	r.Policy = c.cfg.Policy()
	r.Agent = proto.AgentInfo{
		Version:       c.version,
		StartedAt:     c.started.UTC(),
		DroppedEvents: c.dropped.Load(),
		Arch:          runtime.GOARCH,
	}
	r.Agent.RSSBytes, r.Agent.CPUPct = c.self.sample()
	return r, nil
}

// stuckAfter is how far past its timeout a run may go before the sub is
// reported as stuck. A run that ignores its context (a blocked syscall, a
// process in uninterruptible sleep) never finishes, so the sub never runs
// again: without this its last good result would be reported forever.
const stuckAfter = 15 * time.Second

// stuck reports whether the current run overran its timeout (caller holds
// s.mu) and for how long it has been running.
func (s *sub) stuck(now time.Time) (bool, time.Duration) {
	if !s.running {
		return false, 0
	}
	d := now.Sub(s.runStart)
	return d > s.timeout+stuckAfter, d
}

func (c *collector) statuses() []proto.CollectorStatus {
	var out []proto.CollectorStatus
	now := time.Now()
	for _, s := range c.subs {
		s.mu.Lock()
		stuck, running := s.stuck(now)
		if (s.hasRun || stuck) && !s.absent {
			st := proto.CollectorStatus{
				Name:       s.name,
				OK:         s.lastErr == nil || isPartial(s.lastErr),
				LastRun:    s.lastRun.UTC(),
				DurationMs: int(s.lastDur / time.Millisecond),
			}
			if s.lastErr != nil {
				st.Error = truncate(s.lastErr.Error(), 300)
			}
			if stuck {
				st.OK = false
				st.LastRun = s.runStart.UTC()
				st.Error = fmt.Sprintf("stuck: no result for %s (the run did not stop at its %s timeout)",
					running.Round(time.Second), s.timeout)
			}
			out = append(out, st)
		}
		s.mu.Unlock()
	}
	return out
}

// markStuckPlatforms sets the error of a guest platform whose collector is
// stuck, so its stale guest list is shown as "Not reporting".
func (c *collector) markStuckPlatforms(r *proto.Report) {
	now := time.Now()
	for _, x := range []struct {
		s *sub
		p *proto.Platform
	}{{c.dockerSub, r.Docker}, {c.incusSub, r.Incus}, {c.libvirtSub, r.Libvirt}} {
		if x.p == nil || x.s == nil {
			continue
		}
		x.s.mu.Lock()
		stuck, d := x.s.stuck(now)
		x.s.mu.Unlock()
		if stuck && x.p.Error == "" {
			x.p.Error = fmt.Sprintf("no answer for %s", d.Round(time.Second))
			if d > keepOnError {
				x.p.Guests = nil
			}
		}
	}
	if r.PVE != nil && c.pveSub != nil {
		c.pveSub.mu.Lock()
		stuck, d := c.pveSub.stuck(now)
		c.pveSub.mu.Unlock()
		if stuck && r.PVE.Error == "" {
			r.PVE.Error = fmt.Sprintf("no answer for %s", d.Round(time.Second))
			if d > keepOnError {
				r.PVE.Guests = nil
			}
		}
	}
}

// setAbsent marks a sub-collector whose platform is not installed; it is
// then left out of Report.Collectors.
func (s *sub) setAbsent(v bool) {
	if s == nil {
		return
	}
	s.mu.Lock()
	s.absent = v
	s.mu.Unlock()
}

// Events implements agent.Collector.
func (c *collector) Events() <-chan proto.Event { return c.events }

// emit sends an event without blocking. Identical guest state events within
// 2 s are dropped (Docker sends die+stop+kill for one stop).
func (c *collector) emit(ev proto.Event, debounce bool) {
	if ev.At.IsZero() {
		ev.At = time.Now().UTC()
	}
	if debounce {
		key := ev.Platform + "\x00" + ev.GuestID + "\x00" + ev.State
		c.evMu.Lock()
		last, ok := c.lastEv[key]
		if ok && time.Since(last) < 2*time.Second {
			c.evMu.Unlock()
			return
		}
		c.lastEv[key] = time.Now()
		if len(c.lastEv) > 1024 {
			for k, t := range c.lastEv {
				if time.Since(t) > time.Minute {
					delete(c.lastEv, k)
				}
			}
		}
		c.evMu.Unlock()
	}
	select {
	case c.events <- ev:
	default:
		c.dropped.Add(1)
	}
}

// guestEvent is called by the platform event streams.
func (c *collector) guestEvent(platform, guestID, state, msg string) {
	switch platform {
	case proto.PlatformDocker:
		c.dockerSub.markDirty()
	case proto.PlatformIncus:
		c.incusSub.markDirty()
	case proto.PlatformLibvirt:
		c.libvirtSub.markDirty()
	case proto.PlatformPVE:
		c.pveSub.markDirty()
	}
	c.emit(proto.Event{Kind: "guest.state_changed", Platform: platform, GuestID: guestID, State: state, Message: msg}, true)
}

// isRoot reports whether the agent runs as root.
func isRoot() bool { return os.Geteuid() == 0 }

// hostMemTotal returns MemTotal in bytes.
func (c *collector) hostMemTotal() uint64 {
	c.cpu.mu.Lock()
	v := c.cpu.mem.TotalBytes
	c.cpu.mu.Unlock()
	if v == 0 {
		if b, err := c.cpu.root.read("/proc/meminfo"); err == nil {
			v = parseMeminfo(b)["MemTotal"]
		}
	}
	return v
}

// hostThreads returns the number of online logical CPUs.
func (c *collector) hostThreads() int {
	if n := c.host.snapshot().Threads; n > 0 {
		return n
	}
	if n := parseCPUList(c.host.root.readString("/sys/devices/system/cpu/online")); n > 0 {
		return n
	}
	return runtime.NumCPU()
}
