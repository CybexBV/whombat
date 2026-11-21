// Package hostmetrics measures how the box is doing (MG-63…MG-66; Whombat docs/decisions/box-status.md BS-02…BS-05,
// contracts CT-334): the processor, memory, network and disks every 10 seconds, kept an hour in memory and 48 hours /
// 35 days on /persist, and answered to the runtime's `POST /v1/host/metrics` as `protocol.HostMetrics`.
//
// What it reads needs no privilege and nothing the manager's sandbox hides: /proc/stat, /proc/meminfo, /proc/net/route,
// /proc/uptime and the interfaces' counters in /sys/class/net (the uplink, the interfaces of the IPv4 default route), the
// agent's container engine's cgroup, statfs and statx, the btrfs quota groups in /sys/fs/btrfs, the
// batteries in /sys/class/power_supply and the processor's sensor in /sys/class/hwmon or /sys/class/thermal.
//
// History (BS-03): every sample goes into three rings of buckets, 10 seconds (in memory, a little over an hour),
// 1 minute (48 hours) and 15 minutes (35 days); the last two are also ring files under the metrics directory, written
// in place once a minute (ring.go). The ranges and the days are built from them on request (query.go).
package hostmetrics

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
	"time"
	_ "time/tzdata" // the burrow's time zone in the sandbox, whatever /etc holds (BS-05)

	"github.com/CybexBV/whombat/contracts/go/protocol"
)

// Interval is how often the box is measured (the contract's HOST_SAMPLE_INTERVAL_S).
const Interval = 10 * time.Second

// Bucket widths (seconds) and how many of each are kept.
const (
	tenS         = 10
	minuteS      = 60
	quarterS     = 900
	tensKept     = 400     // a little over the hour range's 360 points
	minutesKept  = 48 * 60 // 48 hours
	quartersKept = 35 * 96 // 35 days
)

// diskEvery is how often the disks are measured: they change slowly, and the quota numbers cost a few file reads.
const diskEvery = time.Minute

// tickOffset puts the samples just after each multiple of 10 s, so each 10-second step gets one.
const tickOffset = 50 * time.Millisecond

// minTime: a sample before it comes from a clock that isn't set yet (a box without a battery-backed clock, before
// timesyncd); it counts for “now” but isn't kept.
var minTime = time.Date(2025, 1, 1, 0, 0, 0, 0, time.UTC).Unix()

// ErrNotYet: nothing has been measured since the manager started (the first sample comes a second after the start).
var ErrNotYet = errors.New("the box hasn't been measured yet")

// ErrBadRequest: a request the contract's schema let through but that means nothing (a `since` like 2026-13-45).
var ErrBadRequest = errors.New("bad request")

// Config says where to read and keep the measurements. Empty fields take the appliance's paths.
type Config struct {
	// Dir keeps the 1-minute and 15-minute ring files (/persist/manager/metrics); "": memory only.
	Dir string
	// Proc and Sys are the roots of /proc and /sys (tests pass fakes).
	Proc, Sys string
	// Persist (/persist), System (/) and Backup (<Persist>/backup/disk, counted only while it is a mount point).
	Persist, System, Backup string
	Log                     *slog.Logger
	// Now is the clock (tests); nil: the wall clock.
	Now func() time.Time
}

// Sampler measures the box and keeps the history. Run samples; Metrics answers from memory.
type Sampler struct {
	cfg   Config
	diskR diskReader

	mu       sync.RWMutex
	tens     *ring
	minutes  *ring
	quarters *ring
	latest   *sample // nil before the first sample
	disks    protocol.HostDisks
	// openMinute is the minute the last kept sample went into; its 1-minute and 15-minute buckets are written to
	// their files when a sample of another minute comes (or the sampler stops).
	openMinute int64

	// zones are the time zones asked for, loaded once (a few; guarded by zoneMu, not to hold up the sampler).
	zoneMu sync.Mutex
	zones  map[string]*time.Location

	// The sampling goroutine's own: the previous readings the next sample is the difference to.
	prevAt  time.Time
	prevCPU cpuTimes
	prevNet map[string]ifCounter
	hasPrev bool
	power   powerState

	warnMu sync.Mutex
	warned map[string]string
}

// New returns a sampler; nothing is read before Run.
func New(c Config) *Sampler {
	if c.Proc == "" {
		c.Proc = "/proc"
	}
	if c.Sys == "" {
		c.Sys = "/sys"
	}
	if c.Persist == "" {
		c.Persist = "/persist"
	}
	if c.System == "" {
		c.System = "/"
	}
	if c.Backup == "" {
		c.Backup = filepath.Join(c.Persist, "backup", "disk")
	}
	if c.Log == nil {
		c.Log = slog.Default()
	}
	return &Sampler{cfg: c, diskR: newDiskReader(c), tens: newRing(tenS, tensKept), minutes: newRing(minuteS, minutesKept),
		quarters: newRing(quarterS, quartersKept), zones: map[string]*time.Location{}, warned: map[string]string{}}
}

func (s *Sampler) now() time.Time {
	if s.cfg.Now != nil {
		return s.cfg.Now()
	}
	return time.Now()
}

// Run loads the ring files, then measures every Interval until ctx ends, when it writes the open buckets and closes
// the files. The first reading is only the baseline the next one is the difference to; the first sample follows a
// second later, then one just after every multiple of 10 s. The disks are measured by a goroutine of their own (a
// hung backup disk mustn't stop the rest).
func (s *Sampler) Run(ctx context.Context) {
	s.open()
	defer s.close()
	go s.diskLoop(ctx)
	s.measure(false)
	wait := time.Second
	for {
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
		}
		s.measure(true)
		wait = untilTick(s.now())
	}
}

// untilTick is how long until just after the next multiple of Interval (at least a second away).
func untilTick(now time.Time) time.Duration {
	next := time.Unix(now.Unix()-now.Unix()%tenS+tenS, 0).Add(tickOffset)
	d := next.Sub(now)
	if d < time.Second {
		d += Interval
	}
	return d
}

// open loads the 1-minute and 15-minute rings from their files (a file it can't use starts afresh); without a usable
// directory the history is kept in memory only.
func (s *Sampler) open() {
	if s.cfg.Dir == "" {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := os.MkdirAll(s.cfg.Dir, 0o700); err != nil {
		s.warnOnce("host metrics: the measurements are kept in memory only (their directory can't be made)", err)
		return
	}
	for name, r := range map[string]*ring{"minutes.ring": s.minutes, "quarters.ring": s.quarters} {
		path := filepath.Join(s.cfg.Dir, name)
		switch _, err := openRing(path, r); {
		case errors.Is(err, errFresh):
			s.cfg.Log.Info("host metrics: a new history file", "file", path, "why", err)
		case err != nil:
			s.warnOnce("host metrics: a history file can't be opened; kept in memory only", err)
		}
	}
}

// close writes the open buckets and closes the files.
func (s *Sampler) close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.openMinute != 0 {
		s.persist(s.openMinute)
	}
	for _, r := range []*ring{s.minutes, s.quarters} {
		if r.file != nil {
			_ = r.file.close()
			r.file = nil
		}
	}
}

func (s *Sampler) diskLoop(ctx context.Context) {
	for {
		d := s.diskR.read()
		s.mu.Lock()
		s.disks = d
		s.mu.Unlock()
		select {
		case <-ctx.Done():
			return
		case <-time.After(diskEvery):
		}
	}
}

// measure reads the processor, memory and network counters, and (record) keeps the difference to the previous
// reading as a sample. Without a previous reading (the start, or after the processor couldn't be read) this one is
// only the baseline.
func (s *Sampler) measure(record bool) {
	now := s.now()
	cpu, cores, err := readCPU(s.cfg.Proc)
	if err != nil {
		s.warnOnce("host metrics: the processor can't be read", err)
		s.hasPrev = false
		return
	}
	s.clearWarn("host metrics: the processor can't be read")
	uplink, err := readUplink(s.cfg.Proc)
	if err != nil {
		s.warnOnce("host metrics: the routing table can't be read", err)
	}
	net := map[string]ifCounter{}
	var in, out uint64
	for _, n := range uplink {
		if c, err := readCounter(s.cfg.Sys, n); err == nil {
			net[n] = c
			rx, tx := counterDelta(s.prevNet, n, c)
			in, out = in+rx, out+tx
		}
	}
	// The battery (DK-10, MG-69): with every reading, so `since` is as early as the manager can tell.
	power := s.power.next(readPowerSupplies(s.cfg.Sys), now)
	prevAt, prevCPU, had := s.prevAt, s.prevCPU, s.hasPrev
	s.prevAt, s.prevCPU, s.prevNet, s.hasPrev = now, cpu, net, true
	if !record || !had {
		return
	}
	total, used, err := readMemory(s.cfg.Proc)
	if err != nil {
		s.warnOnce("host metrics: the memory can't be read", err)
		return
	}
	s.clearWarn("host metrics: the memory can't be read")
	mid := prevAt.Add(now.Sub(prevAt) / 2) // the middle of the interval measured: its 10-second step
	smp := sample{at: now.Unix(), slot: floorTo(mid.Unix(), tenS), cpu: cpuPermille(prevCPU, cpu), cores: cores,
		memTotal: total, memUsed: used, uplink: uplink, in: in, out: out, power: power,
		cpuTemp: readCPUTemp(s.cfg.Sys), uptime: readUptime(s.cfg.Proc)} // the desk's panel (DK-24, MG-72)
	if cm := readContainersMemory(s.cfg.Sys); cm != nil {
		v := min(*cm, used)
		smp.containersMem = &v
	}
	s.record(&smp)
}

// record makes smp the latest sample and adds it to the buckets of its step, minute and quarter hour. When it is the
// first of a new minute, the previous minute's bucket and its quarter's are written to their files first.
func (s *Sampler) record(smp *sample) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.latest = smp
	if smp.slot < minTime {
		return
	}
	minute := floorTo(smp.slot, minuteS)
	if s.openMinute != 0 && minute != s.openMinute {
		s.persist(s.openMinute)
	}
	s.openMinute = minute
	s.tens.slot(smp.slot).add(smp)
	s.minutes.slot(minute).add(smp)
	s.quarters.slot(floorTo(smp.slot, quarterS)).add(smp)
}

// persist writes the minute's bucket and its quarter's (with s.mu held). A failed write keeps the buckets in memory.
func (s *Sampler) persist(minute int64) {
	err := errors.Join(s.minutes.write(minute), s.quarters.write(floorTo(minute, quarterS)))
	if err != nil {
		s.warnOnce("host metrics: the history isn't written to disk (kept in memory)", err)
		return
	}
	s.clearWarn("host metrics: the history isn't written to disk (kept in memory)")
}

func (s *Sampler) warnOnce(key string, err error) {
	s.warnMu.Lock()
	defer s.warnMu.Unlock()
	if s.warned[key] != err.Error() {
		s.warned[key] = err.Error()
		s.cfg.Log.Warn(key, "err", err)
	}
}

func (s *Sampler) clearWarn(key string) {
	s.warnMu.Lock()
	delete(s.warned, key)
	s.warnMu.Unlock()
}

// floorTo rounds t down to a multiple of step.
func floorTo(t, step int64) int64 {
	r := t % step
	if r < 0 {
		r += step
	}
	return t - r
}
