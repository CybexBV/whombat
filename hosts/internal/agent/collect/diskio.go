package collect

import (
	"context"
	"strconv"
	"strings"
	"sync"
	"time"

	"rackoon/internal/proto"
)

// diskStat is one /proc/diskstats line (counters since boot).
type diskStat struct {
	rdIOs, rdSectors, rdTicks uint64 // completed reads, 512-byte sectors, ms spent
	wrIOs, wrSectors, wrTicks uint64
	ioTicks                   uint64 // ms with I/O in flight
}

// parseDiskstats parses /proc/diskstats by device name. Sectors are always
// 512 bytes there, whatever the device's block size.
func parseDiskstats(b []byte) map[string]diskStat {
	out := map[string]diskStat{}
	scanLines(b, func(line string) {
		f := strings.Fields(line)
		if len(f) < 14 {
			return
		}
		n := func(i int) uint64 {
			v, _ := strconv.ParseUint(f[i], 10, 64)
			return v
		}
		out[f[2]] = diskStat{
			rdIOs: n(3), rdSectors: n(5), rdTicks: n(6),
			wrIOs: n(7), wrSectors: n(9), wrTicks: n(10),
			ioTicks: n(12),
		}
	})
	return out
}

// diskIODelta computes throughput, IOPS, utilisation (time busy, like
// iostat's %util) and the average request latency (iostat's await over
// reads and writes) between two samples dt seconds apart. ok is false when
// a counter went backwards (device replaced, counter wrap).
func diskIODelta(prev, cur diskStat, dt float64) (proto.DiskIO, bool) {
	if dt <= 0 || cur.rdIOs < prev.rdIOs || cur.wrIOs < prev.wrIOs || cur.rdSectors < prev.rdSectors ||
		cur.wrSectors < prev.wrSectors || cur.ioTicks < prev.ioTicks || cur.rdTicks < prev.rdTicks || cur.wrTicks < prev.wrTicks {
		return proto.DiskIO{}, false
	}
	rd, wr := cur.rdIOs-prev.rdIOs, cur.wrIOs-prev.wrIOs
	io := proto.DiskIO{
		ReadBps:   round1(float64(cur.rdSectors-prev.rdSectors) * 512 / dt),
		WriteBps:  round1(float64(cur.wrSectors-prev.wrSectors) * 512 / dt),
		ReadIOPS:  round1(float64(rd) / dt),
		WriteIOPS: round1(float64(wr) / dt),
		UtilPct:   round1(clamp(float64(cur.ioTicks-prev.ioTicks)/(dt*1000)*100, 0, 100)),
	}
	if ops := rd + wr; ops > 0 {
		io.AwaitMs = round2(float64((cur.rdTicks-prev.rdTicks)+(cur.wrTicks-prev.wrTicks)) / float64(ops))
	}
	return io, true
}

// diskIOCollector samples /proc/diskstats every 10 s; the disk inventory
// itself runs every 60 s, so the rates are attached to the reported disks
// by name at assembly time (the whole-disk line, "sda", "nvme0n1").
type diskIOCollector struct {
	root fsRoot

	mu     sync.Mutex
	prev   map[string]diskStat
	prevAt time.Time
	io     map[string]proto.DiskIO
}

func newDiskIOCollector(root fsRoot) *diskIOCollector { return &diskIOCollector{root: root} }

func (d *diskIOCollector) run(ctx context.Context) error {
	b, err := d.root.read("/proc/diskstats")
	if err != nil {
		return err
	}
	now := time.Now()
	cur := parseDiskstats(b)
	d.mu.Lock()
	defer d.mu.Unlock()
	io := map[string]proto.DiskIO{}
	if d.prev != nil {
		dt := now.Sub(d.prevAt).Seconds()
		for name, c := range cur {
			if p, ok := d.prev[name]; ok {
				if v, ok := diskIODelta(p, c, dt); ok {
					io[name] = v
				}
			}
		}
	}
	d.prev, d.prevAt, d.io = cur, now, io
	return nil
}

// fill attaches the latest rates to the report's disks.
func (d *diskIOCollector) fill(disks []proto.Disk) {
	d.mu.Lock()
	defer d.mu.Unlock()
	for i := range disks {
		if v, ok := d.io[disks[i].Device]; ok {
			disks[i].IO = &v
		}
	}
}
