// Package fakefleet generates synthetic agent reports for the fixture
// fleet of docs/handoff/sample-data (basalt, granite, obsidian, quartz,
// shale, flint, onyx, marble). It feeds cmd/rackoon-sim and the hub's tests.
// All names, addresses and values are fake.
//
// With Exact set, a host reports the fixture's values; otherwise values
// drift around them (diurnal curve plus noise), deterministic per host and
// timestamp.
package fakefleet

import (
	"fmt"
	"hash/fnv"
	"math"
	"strings"
	"sync"
	"time"

	"rackoon/internal/proto"
)

const (
	gib = 1 << 30
	mib = 1 << 20
)

// GuestSpec is a guest of a simulated host. Rates are in MB/s (disk) and
// Mb/s (network) like the API.
type GuestSpec struct {
	Platform  string
	ID        string
	Name      string
	Kind      string
	Image     string
	State     string
	VCPU      int
	CPU       float64
	MemUsedMB uint64
	MemLimMB  uint64 // 0 = no limit
	MemCfgGiB uint64 // VMs: configured memory
	Read      float64
	Write     float64
	Rx        float64
	Tx        float64
	Snapshots *int
	UptimeS   int64
	Protocols []string
	Default   string
	Res       string
	Balloon   bool
	VMID      int
	Backup    string     // ok | error | ""
	Started   *time.Time // set when started by a simulated action

	// Proxmox management (docs/MANAGE.md), reported unless Exact.
	Tags           []string
	PendingChanges int
	GuestAgent     string // running | not_running (running VMs only)
	OldestSnapshot *time.Time
	BackupJob      *bool
	BackupAgeDays  int // > 0: the last backup is this many days older
	HAState        string
	Template       bool   // a Proxmox template: reported in PVE.Templates, not as a guest
	DiskGiB        uint64 // template disk size

	// Incus and the self guest (incus.go), reported unless Exact.
	MAC         string     // "" = a stable fake one
	Extra       bool       // left out of the exact fixture (the self guest)
	NoSchedule  bool       // Incus: no snapshot schedule
	IncusBackup *time.Time // Incus: the newest backup
	// unRAID (unraid.go): autostart (Docker on unRAID, libvirt), the web
	// page link, a dockerMan template, dockerMan's update status.
	Autostart      *bool
	WebUI          string
	UnraidTemplate bool
	Update         *bool

	// libvirt (libvirt.go): the VM's network card addresses.
	MACs []string
}

// Ref is the fixture's as_of (2026-10-11T14:00:00Z).
var Ref = time.Date(2026, 10, 11, 14, 0, 0, 0, time.UTC)

// DiskSpec is a physical disk.
type DiskSpec struct {
	Dev, Type, Model, Role, Pool string
	CapGB, UsedGB                float64
	Wear                         *float64
	WrittenTB, RatedTBW          float64
	Temp                         float64
	POH                          uint64
	Realloc, Pending, Uncorr     uint64
}

// SensorSpec is a temperature group.
type SensorSpec struct {
	ID, Label, Group, Source string
	Temp, Limit              float64
}

// Host is a simulated host.
type Host struct {
	ID, Group, Location        string
	OSName, OSVersion, Pretty  string
	Kernel                     string
	CPUModel                   string
	Cores, Threads             int
	MemGiB                     float64
	MemType                    string
	Address                    string
	UptimeS                    int64
	CPU, User, Sys, IOWait     float64
	Load                       [3]float64
	MemUsedGiB, CacheGiB, Free float64
	ARCGiB                     float64 // > 0: ZFS ARC
	SwapUsed, SwapTotal        float64
	Sensors                    []SensorSpec
	Disks                      []DiskSpec
	KVM                        *proto.KVM
	Docker, Incus, Libvirt     bool
	Guests                     []GuestSpec
	PVE                        *proto.PVE         // static PVE parts (cluster, storages, backups); guests come from Guests
	IncusDetail                *proto.IncusDetail // static Incus host view (incus.go)
	OfflineAfter               time.Duration
	Policy                     proto.Policy
	// Unraid: the unRAID state of blackbox (unraid.go); parityStarted and
	// parityBase move a running parity check with the clock.
	Unraid        *proto.Unraid
	parityStarted *time.Time
	parityBase    float64
	// libvirt (libvirt.go): the libvirt host view of kvm-lab and how old
	// each VM's newest backup is.
	LibvirtDetail  *proto.LibvirtDetail
	LibvirtBackups map[string]time.Duration
	// BackupPlace: the server as a backup place (backupplace.go).
	BackupPlace *proto.BackupPlace
	// pkgs: the package state once rackoon-sim changed it (packages.go).
	pkgs *PackageState

	mu sync.Mutex
	// Exact makes Report return the fixture values.
	Exact bool
}

func f(v float64) *float64 { return &v }
func ip(v int) *int        { return &v }

// noise returns a deterministic pseudo-random value in [-1, 1] for a key.
func noise(key string, t int64) float64 {
	h := fnv.New64a()
	fmt.Fprintf(h, "%s|%d", key, t)
	return float64(h.Sum64()%20001)/10000 - 1
}

// wave is a smooth deterministic variation in [-1, 1].
func wave(key string, t time.Time) float64 {
	h := fnv.New32a()
	h.Write([]byte(key))
	phase := float64(h.Sum32()%1000) / 1000 * 2 * math.Pi
	s := float64(t.Unix())
	day := math.Sin(2*math.Pi*s/86400 + phase)
	fast := math.Sin(2*math.Pi*s/1300+phase*3) * 0.35
	return (day*0.75 + fast) / 1.1
}

func clamp(v, lo, hi float64) float64 { return math.Max(lo, math.Min(hi, v)) }

// vary returns base varied by up to rel (relative) around it at t.
func (h *Host) vary(key string, base, rel float64, t time.Time) float64 {
	if h.Exact {
		return base
	}
	k := h.ID + "/" + key
	return base * (1 + rel*wave(k, t) + rel*0.25*noise(k, t.Unix()/10))
}

// Report produces the host's report at t.
func (h *Host) Report(t time.Time, seq uint64, agentVersion string) *proto.Report {
	h.mu.Lock()
	defer h.mu.Unlock()
	t = t.UTC()
	r := &proto.Report{At: t, Seq: seq}
	// Boot and start times are fixed relative to the fixture's as_of, so
	// uptimes grow naturally and equal the fixture at Ref.
	boot := Ref.Add(-time.Duration(h.UptimeS) * time.Second)
	r.Host = proto.HostInfo{
		MachineID: fmt.Sprintf("%032x", hash(h.ID)), Hostname: h.ID, OSName: h.OSName, OSVersion: h.OSVersion,
		OSPretty: h.Pretty, Kernel: h.Kernel, CPUModel: h.CPUModel, Cores: h.Cores, Threads: h.Threads,
		MemoryTotalBytes: uint64(h.MemGiB * gib), MemoryType: h.MemType, BootTime: boot,
		Addresses: []string{h.Address},
	}
	cpu := clamp(h.vary("cpu", h.CPU, 0.35, t), 0.5, 100)
	scale := cpu / h.CPU
	r.CPU = proto.CPU{UsagePct: round1(cpu), UserPct: round1(h.User * scale), SystemPct: round1(h.Sys * scale),
		IOWaitPct: round1(h.IOWait * scale), Load: [3]float64{h.Load[0] * scale, h.Load[1] * scale, h.Load[2] * scale}}
	total := uint64(h.MemGiB * gib)
	used := clamp(h.vary("mem", h.MemUsedGiB, 0.04, t), 0.1, h.MemGiB)
	r.Memory = proto.Memory{
		TotalBytes: total, UsedBytes: uint64(used * gib), AvailableBytes: total - uint64(used*gib),
		CachedBytes: uint64(h.CacheGiB * gib), FreeBytes: uint64(math.Max(0, h.MemGiB-used-h.CacheGiB-h.ARCGiB) * gib),
		SwapTotalBytes: uint64(h.SwapTotal * gib), SwapUsedBytes: uint64(h.SwapUsed * gib),
	}
	if h.Exact {
		r.Memory.FreeBytes = uint64(h.Free * gib)
	}
	if h.ARCGiB > 0 {
		arc := uint64(h.ARCGiB * gib)
		r.Memory.ZFSARCBytes = &arc
	}
	for _, s := range h.Sensors {
		temp := s.Temp
		if !h.Exact {
			// Temperatures follow the CPU load a little.
			temp = s.Temp + (cpu-h.CPU)*0.12 + 1.2*wave(h.ID+"/"+s.ID, t)
			if s.ID == proto.SensorCPU {
				temp = s.Temp + (cpu-h.CPU)*0.25 + 0.8*noise(h.ID+"/t", t.Unix()/10)
			}
		}
		r.Sensors = append(r.Sensors, proto.Sensor{ID: s.ID, Label: s.Label, Group: s.Group, Source: s.Source,
			TempC: round1(temp), LimitC: s.Limit})
	}
	for _, d := range h.Disks {
		pd := proto.Disk{Device: d.Dev, Type: d.Type, Model: d.Model, Serial: fmt.Sprintf("SIM%08X", hash(h.ID+d.Dev)),
			CapacityBytes: uint64(d.CapGB * 1e9), Role: d.Role, Pool: d.Pool, TempC: f(d.Temp),
			PowerOnHours: ptrU(d.POH + uint64(math.Max(0, t.Sub(Ref).Hours())))}
		if d.UsedGB > 0 {
			u := uint64(d.UsedGB * 1e9)
			pd.UsedBytes = &u
		}
		ok := d.Pending == 0 && d.Uncorr == 0
		pd.SmartPassed = &ok
		if d.Type == "hdd" {
			pd.Reallocated, pd.Pending, pd.Uncorrectable = ptrU(d.Realloc), ptrU(d.Pending), ptrU(d.Uncorr)
		} else {
			pd.WearPct = d.Wear
			if d.WrittenTB > 0 {
				w := uint64(d.WrittenTB * 1e12)
				pd.WrittenBytes = &w
			}
			if d.RatedTBW > 0 {
				pd.RatedTBW = f(d.RatedTBW)
			}
		}
		r.Disks = append(r.Disks, pd)
	}
	r.Filesystems, r.Pools = h.filesystems()
	if h.KVM != nil {
		k := *h.KVM
		r.KVM = &k
	}
	var docker, incus, libvirt, pve []proto.Guest
	var templates []proto.TemplateGuest
	for i := range h.Guests {
		if h.Exact && h.Guests[i].Extra {
			continue
		}
		if s := &h.Guests[i]; s.Template {
			if !h.Exact {
				templates = append(templates, proto.TemplateGuest{ID: s.ID, Name: s.Name, Kind: s.Kind, Node: h.ID, DiskBytes: s.DiskGiB * gib})
			}
			continue
		}
		g := h.guest(&h.Guests[i], t)
		switch h.Guests[i].Platform {
		case proto.PlatformDocker:
			docker = append(docker, g)
		case proto.PlatformIncus:
			incus = append(incus, g)
		case proto.PlatformLibvirt:
			libvirt = append(libvirt, g)
		case proto.PlatformPVE:
			pve = append(pve, g)
		}
	}
	if h.Docker {
		r.Docker = &proto.Platform{Version: "28.3.2", Guests: nonNil(docker)}
	}
	if h.Incus {
		r.Incus = &proto.Platform{Version: "6.16", Guests: nonNil(incus)}
	}
	if h.Libvirt {
		r.Libvirt = &proto.Platform{Version: "11.6.0", Guests: nonNil(libvirt)}
	}
	if h.PVE != nil {
		p := *h.PVE
		p.Guests, p.Templates = nonNil(pve), templates
		p.Storages = append([]proto.PVEStorage{}, h.PVE.Storages...)
		p.Nodes = append([]proto.PVENode{}, h.PVE.Nodes...)
		for i := range p.Nodes {
			if p.Nodes[i].ThisNode {
				p.Nodes[i].CPUPct = round1(cpu)
				p.Nodes[i].MemPct = round1(used / h.MemGiB * 100)
			} else if !h.Exact {
				p.Nodes[i].CPUPct = round1(h.vary("node-"+p.Nodes[i].Name, p.Nodes[i].CPUPct, 0.3, t))
			}
		}
		r.PVE = &p
	}
	if !h.Exact {
		h.addHealth(r, t)
		h.addManage(r)
		h.addIncus(r)
	}
	names := []string{"host", "sensors", "disks", "smart", "kvm"}
	if h.Docker {
		names = append(names, "docker")
	}
	if h.Incus {
		names = append(names, "incus")
	}
	if h.Libvirt {
		names = append(names, "libvirt")
	}
	if h.PVE != nil {
		names = append(names, "pve")
	}
	for _, n := range names {
		r.Collectors = append(r.Collectors, proto.CollectorStatus{Name: n, OK: true, LastRun: t, DurationMs: 3})
	}
	r.Policy = h.Policy
	r.Agent = proto.AgentInfo{Version: agentVersion, StartedAt: t.Add(-time.Hour), RSSBytes: 31 << 20, CPUPct: 0.4}
	h.addUnraid(r, t)
	h.addLibvirt(r, t)
	r.BackupPlace = h.placeCopy()
	if r.BackupPlace != nil {
		r.BackupPlace.Locations = proto.PlaceLocations(r.BackupPlace, r.Unraid, func(string) bool { return true })
	}
	return r
}

func nonNil(g []proto.Guest) []proto.Guest {
	if g == nil {
		return []proto.Guest{}
	}
	return g
}

func ptrU(v uint64) *uint64 { return &v }

func hash(s string) uint64 {
	h := fnv.New64a()
	h.Write([]byte(s))
	return h.Sum64()
}

func round1(v float64) float64 { return math.Round(v*10) / 10 }

func (h *Host) filesystems() ([]proto.Filesystem, []proto.Pool) {
	var fs []proto.Filesystem
	var pools []proto.Pool
	poolDisks := map[string][]string{}
	poolSize := map[string]float64{}
	poolUsed := map[string]float64{}
	for _, d := range h.Disks {
		if d.Pool != "" {
			poolDisks[d.Pool] = append(poolDisks[d.Pool], d.Dev)
			poolSize[d.Pool] = d.CapGB // mirror
			poolUsed[d.Pool] = d.UsedGB
			continue
		}
		mount := "/"
		if i := strings.Index(d.Role, "· "); i >= 0 {
			mount = strings.TrimSpace(strings.Split(d.Role[i+len("· "):], ",")[0])
		}
		fs = append(fs, proto.Filesystem{Mount: mount, Device: "/dev/" + d.Dev + "p1", FSType: "ext4",
			SizeBytes: uint64(d.CapGB * 1e9), UsedBytes: uint64(d.UsedGB * 1e9), Disks: []string{d.Dev}})
	}
	for name, disks := range poolDisks {
		pools = append(pools, proto.Pool{Name: name, Health: "ONLINE", Layout: "mirror",
			SizeBytes: uint64(poolSize[name] * 1e9), AllocBytes: uint64(poolUsed[name] * 1e9), Disks: disks})
	}
	return fs, pools
}

func (h *Host) guest(s *GuestSpec, t time.Time) proto.Guest {
	g := proto.Guest{ID: s.ID, Name: s.Name, Kind: s.Kind, Image: s.Image, State: s.State, VCPU: s.VCPU,
		MemConfigBytes: s.MemCfgGiB * gib, BalloonActive: s.Balloon, SnapshotsCount: s.Snapshots, VMID: s.VMID,
		Autostart: s.Autostart, WebUI: s.WebUI, UnraidTemplate: s.UnraidTemplate}
	if g.Name == "" {
		g.Name = g.ID
	}
	if s.Platform == proto.PlatformPVE {
		g.Node = h.ID
		if s.Backup != "" {
			at := time.Date(t.Year(), t.Month(), t.Day(), 0, 6, 0, 0, time.UTC)
			if at.After(t) {
				at = at.Add(-24 * time.Hour)
			}
			g.LastBackup = &proto.BackupMark{Result: s.Backup, At: at.AddDate(0, 0, -s.BackupAgeDays)}
		}
		if !h.Exact {
			g.Tags, g.PendingChanges, g.OldestSnapshot, g.HAState = append([]string(nil), s.Tags...), s.PendingChanges, s.OldestSnapshot, s.HAState
			if s.BackupJob != nil {
				b := *s.BackupJob
				g.BackupJob = &b
			}
			if s.State != proto.StateStopped {
				g.GuestAgent = s.GuestAgent
			}
		}
	}
	if s.Kind == "vm" {
		g.Firmware = "OVMF"
		g.MachineType = "q35"
	}
	if s.Platform != proto.PlatformDocker {
		g.MACs = []string{fakeMAC(h.ID, s)}
	}
	g.Console = proto.ConsoleCaps{Protocols: s.Protocols, Default: s.Default, Resolution: s.Res}
	if s.State == proto.StateStopped {
		fin := t.Add(-6 * time.Hour)
		g.FinishedAt = &fin
		return g
	}
	k := s.Platform + "/" + s.ID
	cpu := clamp(h.vary(k+"/cpu", s.CPU, 0.4, t), 0, 400)
	g.CPUPct = f(round1(cpu))
	mu := uint64(h.vary(k+"/mem", float64(s.MemUsedMB), 0.05, t)) * mib
	g.MemUsedBytes = &mu
	if s.MemLimMB > 0 {
		ml := s.MemLimMB * mib
		g.MemLimitBytes = &ml
	}
	if s.Platform != proto.PlatformDocker {
		g.DiskReadBps = f(h.vary(k+"/rd", s.Read, 0.6, t) * 1e6)
		g.DiskWriteBps = f(h.vary(k+"/wr", s.Write, 0.6, t) * 1e6)
		g.NetRxBps = f(h.vary(k+"/rx", s.Rx, 0.5, t) * 1e6 / 8)
		g.NetTxBps = f(h.vary(k+"/tx", s.Tx, 0.5, t) * 1e6 / 8)
	}
	st := Ref.Add(-time.Duration(s.UptimeS) * time.Second)
	if s.Started != nil {
		st = *s.Started
	}
	g.StartedAt = &st
	return g
}

// SetGuestState changes a guest's state (simulated power actions). It
// returns the previous state, or "" when the guest does not exist.
func (h *Host) SetGuestState(platform, id, state string) string {
	h.mu.Lock()
	defer h.mu.Unlock()
	for i := range h.Guests {
		g := &h.Guests[i]
		if g.Platform == platform && g.ID == id {
			prev := g.State
			g.State = state
			if state == proto.StateRunning && prev != proto.StateRunning {
				now := time.Now().UTC()
				g.Started = &now
				if g.CPU == 0 {
					g.CPU = 3
				}
				if g.MemUsedMB == 0 {
					g.MemUsedMB = 512
				}
			}
			return prev
		}
	}
	return ""
}

// FindGuest returns a copy of a guest spec.
func (h *Host) FindGuest(platform, id string) (GuestSpec, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, g := range h.Guests {
		if g.Platform == platform && g.ID == id {
			return g, true
		}
	}
	return GuestSpec{}, false
}
