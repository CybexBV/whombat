package model

import (
	"sort"
	"strings"
	"time"

	"rackoon/internal/proto"
	"rackoon/internal/rules"
)

// Host health in the server detail (CONTRACT.md 1, "Host health"): the
// System card, network interfaces, volumes with their forecast, arrays,
// UPS, GPUs and fans. Every key is absent (or empty) when the agent does
// not report it.

// System is the System card.
type System struct {
	PackageManager  *string   `json:"package_manager"`
	Updates         *int      `json:"updates"` // nil: unknown
	SecurityUpdates *int      `json:"security_updates"`
	UpdatesAt       *Time     `json:"updates_checked_at"`
	UpdatesError    *string   `json:"updates_error"`
	RebootRequired  bool      `json:"reboot_required"`
	RebootReason    *string   `json:"reboot_reason"`
	InitSystem      *string   `json:"init_system"`
	FailedCount     int       `json:"failed_count"`
	FailedUnits     []string  `json:"failed_units"`
	TimeSynced      *bool     `json:"time_synced"`
	TimeOffsetMs    *float64  `json:"time_offset_ms"`
	TimeSource      *string   `json:"time_source"`
	OOMKills        uint64    `json:"oom_kills"` // since boot
	Processes       int       `json:"processes"`
	StealPct        *float64  `json:"steal_pct"`
	Pressure        *Pressure `json:"pressure"`
	// PackageTask: the package task running now (checking for or
	// installing updates); PackageLast: the last one that ended. Both null
	// when there is none (and from agents that can't install updates).
	PackageTask *PackageTask `json:"package_task"`
	PackageLast *PackageLast `json:"package_last"`
}

// PackageTask is a running package task (GET /servers/{id}/tasks/{id}
// follows it).
type PackageTask struct {
	ID        string `json:"id"`
	Op        string `json:"op"` // check | install
	StartedAt Time   `json:"started_at"`
}

// PackageLast is the last package task that ended.
type PackageLast struct {
	Op         string  `json:"op"`     // check | install
	Status     string  `json:"status"` // ok | failed
	FinishedAt Time    `json:"finished_at"`
	Installed  *int    `json:"installed"` // install: how many of the waiting updates went in; null for a check
	Message    string  `json:"message"`
	Code       *string `json:"code"` // busy | timeout | null
}

// Pressure is PSI, avg10 in percent.
type Pressure struct {
	CPU        float64 `json:"cpu"`
	Memory     float64 `json:"memory"`
	MemoryFull float64 `json:"memory_full"`
	IO         float64 `json:"io"`
	IOFull     float64 `json:"io_full"`
}

// NetIface is a network interface row.
type NetIface struct {
	Name      string   `json:"name"`
	Kind      string   `json:"kind"`
	Up        bool     `json:"up"`
	Carrier   bool     `json:"carrier"`
	SpeedMbps *int     `json:"speed_mbps"`
	MTU       *int     `json:"mtu"`
	Addresses []string `json:"addresses"`
	Master    *string  `json:"master"`
	Members   []string `json:"members"`
	RxMbps    float64  `json:"rx_mbps"`
	TxMbps    float64  `json:"tx_mbps"`
	Errors    uint64   `json:"errors"` // rx + tx since boot
	Drops     uint64   `json:"drops"`
}

// Volume is a filesystem, pool or Proxmox storage watched for space.
type Volume struct {
	Entity     string   `json:"entity"` // "fs:/srv", "pool:tank", "storage:local"
	Kind       string   `json:"kind"`   // fs | pool | storage
	Label      string   `json:"label"`
	UsedGB     float64  `json:"used_gb"`
	TotalGB    float64  `json:"total_gb"`
	UsedPct    float64  `json:"used_pct"`
	FullInDays *float64 `json:"full_in_days"` // growth forecast (null: not filling up)
	// Filesystems.
	FSType    *string  `json:"fs_type,omitempty"`
	Device    *string  `json:"device,omitempty"`
	InodesPct *float64 `json:"inodes_pct,omitempty"`
	ReadOnly  bool     `json:"read_only,omitempty"`
	Remote    bool     `json:"remote,omitempty"`
	Error     *string  `json:"error,omitempty"`
	// Pools.
	Health  *string    `json:"health,omitempty"`
	Layout  *string    `json:"layout,omitempty"`
	Scrub   *Scrub     `json:"scrub,omitempty"`
	Errors  *PoolError `json:"errors,omitempty"`
	FragPct *float64   `json:"frag_pct,omitempty"`
	Faulted []string   `json:"faulted,omitempty"`
	Status  *string    `json:"status,omitempty"`
}

// Scrub is a pool's last scrub.
type Scrub struct {
	State  string `json:"state"` // none | scanning | finished | canceled
	End    *Time  `json:"end"`
	Errors uint64 `json:"errors"`
}

// PoolError are a pool's error counters.
type PoolError struct {
	Read     uint64 `json:"read"`
	Write    uint64 `json:"write"`
	Checksum uint64 `json:"checksum"`
}

// Array is an md / Unraid array.
type Array struct {
	Name        string   `json:"name"`
	Level       string   `json:"level"`
	State       string   `json:"state"`
	Devices     int      `json:"devices"`
	Active      int      `json:"active"`
	Members     []string `json:"members"`
	Failed      []string `json:"failed"`
	SyncPct     *float64 `json:"sync_pct"`
	SizeGB      *float64 `json:"size_gb"`
	LastCheck   *Time    `json:"last_check"`
	CheckErrors *uint64  `json:"check_errors"`
}

// UPS is a UPS row.
type UPS struct {
	Name      string   `json:"name"`
	Model     *string  `json:"model"`
	Status    string   `json:"status"`
	ChargePct *float64 `json:"charge_pct"`
	RuntimeS  *int     `json:"runtime_s"`
	LoadPct   *float64 `json:"load_pct"`
}

// GPU is a GPU row.
type GPU struct {
	Index      int      `json:"index"`
	Name       string   `json:"name"`
	Vendor     string   `json:"vendor"`
	UtilPct    *float64 `json:"util_pct"`
	MemUsedGB  *float64 `json:"mem_used_gb"`
	MemTotalGB *float64 `json:"mem_total_gb"`
	TempC      *float64 `json:"temp_c"`
	PowerW     *float64 `json:"power_w"`
}

// Fan is a fan row.
type Fan struct {
	Label  string   `json:"label"`
	Source string   `json:"source"`
	RPM    float64  `json:"rpm"`
	MinRPM *float64 `json:"min_rpm"`
}

// DiskIO is a disk's throughput.
type DiskIO struct {
	ReadMBs  float64 `json:"read_mbs"`
	WriteMBs float64 `json:"write_mbs"`
	UtilPct  float64 `json:"util_pct"`
	AwaitMs  float64 `json:"await_ms"`
}

// SmartMore is the SMART detail beyond the core counters.
type SmartMore struct {
	SelfTest        *SelfTest `json:"self_test"`
	ErrorLog        *uint64   `json:"error_log"`
	CRCErrors       *uint64   `json:"crc_errors"`
	CriticalWarning *uint64   `json:"critical_warning"`
	SparePct        *float64  `json:"spare_pct"`
	SpareThreshold  *float64  `json:"spare_threshold"`
	MediaErrors     *uint64   `json:"media_errors"`
	UnsafeShutdowns *uint64   `json:"unsafe_shutdowns"`
	Standby         bool      `json:"standby"`
}

// SelfTest is a disk's last SMART self-test.
type SelfTest struct {
	Type         string `json:"type"`
	Result       string `json:"result"`
	PowerOnHours uint64 `json:"power_on_hours"`
}

// PlatformWarning is a platform warning (Incus, Docker).
type PlatformWarning struct {
	Type     string  `json:"type"`
	Message  string  `json:"message"`
	Count    int     `json:"count"`
	LastSeen *Time   `json:"last_seen"`
	Project  *string `json:"project"`
}

// PVETask is a Proxmox task (failed or running ones of the last 48 h) or
// a failed Incus operation.
type PVETask struct {
	Platform string  `json:"platform"` // pve | incus
	Type     string  `json:"type"`
	ID       *string `json:"id"`
	Node     string  `json:"node"`
	User     *string `json:"user"`
	Start    Time    `json:"start"`
	End      *Time   `json:"end"`
	Status   string  `json:"status"`
	OK       bool    `json:"ok"`
}

// Replication is a Proxmox replication job.
type Replication struct {
	ID       string  `json:"id"`
	Guest    string  `json:"guest"`
	Target   string  `json:"target"`
	LastSync *Time   `json:"last_sync"`
	Error    *string `json:"error"`
	Fails    int     `json:"fails"`
}

// Ceph is the Ceph health of a Proxmox cluster.
type Ceph struct {
	Status  string   `json:"status"`
	Summary []string `json:"summary"`
}

func timep(t time.Time) *Time {
	if t.IsZero() {
		return nil
	}
	return T(t)
}

func f64p(f float64) *float64 { return &f }

func buildSystem(r *proto.Report) *System {
	s := r.System
	if s == nil && r.Pressure == nil {
		return nil
	}
	out := &System{FailedUnits: []string{}}
	if s != nil {
		out.PackageManager, out.Updates, out.SecurityUpdates = strp(s.PackageManager), s.UpdatesPending, s.SecurityUpdates
		out.UpdatesAt, out.UpdatesError = timep(s.UpdatesCheckedAt), strp(s.UpdatesError)
		out.RebootRequired, out.RebootReason = s.RebootRequired, strp(s.RebootReason)
		out.InitSystem, out.FailedCount = strp(s.InitSystem), s.FailedCount
		if s.FailedUnits != nil {
			out.FailedUnits = s.FailedUnits
		}
		out.TimeSynced, out.TimeOffsetMs, out.TimeSource = s.TimeSynced, r1p(s.TimeOffsetMs), strp(s.TimeSource)
		out.OOMKills, out.Processes = s.OOMKills, s.ProcessCount
		if t := s.PackageTask; t != nil {
			out.PackageTask = &PackageTask{ID: t.ID, Op: t.Op, StartedAt: Time(t.Started)}
		}
		if l := s.PackageLast; l != nil {
			out.PackageLast = &PackageLast{Op: l.Op, Status: l.Status, FinishedAt: Time(l.Finished), Installed: l.Installed,
				Message: l.Message, Code: strp(l.Code)}
		}
	}
	if r.CPU.StealPct > 0 {
		out.StealPct = f64p(r1(r.CPU.StealPct))
	}
	if p := r.Pressure; p != nil {
		out.Pressure = &Pressure{CPU: r1(p.CPUSome), Memory: r1(p.MemorySome), MemoryFull: r1(p.MemoryFull), IO: r1(p.IOSome), IOFull: r1(p.IOFull)}
	}
	return out
}

func buildNetwork(r *proto.Report) []NetIface {
	out := []NetIface{}
	for _, n := range r.Net {
		x := NetIface{Name: n.Name, Kind: n.Kind, Up: n.Up, Carrier: n.Carrier, Addresses: n.Addresses, Master: strp(n.Master),
			Members: n.Members, RxMbps: r1(n.RxBps * 8 / 1e6), TxMbps: r1(n.TxBps * 8 / 1e6),
			Errors: n.RxErrors + n.TxErrors, Drops: n.RxDrops + n.TxDrops}
		if n.SpeedMbps > 0 {
			x.SpeedMbps = ptr(n.SpeedMbps)
		}
		if n.MTU > 0 {
			x.MTU = ptr(n.MTU)
		}
		if x.Addresses == nil {
			x.Addresses = []string{}
		}
		if x.Members == nil {
			x.Members = []string{}
		}
		out = append(out, x)
	}
	// Interfaces with an address first, then by name.
	sort.SliceStable(out, func(i, j int) bool {
		ai, aj := len(out[i].Addresses) > 0 || out[i].Kind == "bond", len(out[j].Addresses) > 0 || out[j].Kind == "bond"
		if ai != aj {
			return ai
		}
		return out[i].Name < out[j].Name
	})
	return out
}

func buildVolumes(r *proto.Report, forecast map[string]float64) []Volume {
	out := []Volume{}
	fs := map[string]proto.Filesystem{}
	for _, f := range r.Filesystems {
		fs["fs:"+f.Mount] = f
	}
	pools := map[string]proto.Pool{}
	for _, p := range r.Pools {
		pools["pool:"+p.Name] = p
	}
	for _, v := range r.Volumes() {
		kind, _, _ := strings.Cut(v.Entity, ":")
		x := Volume{Entity: v.Entity, Kind: kind, Label: v.Label, UsedGB: r1(float64(v.Used) / rules.GB),
			TotalGB: r1(float64(v.Total) / rules.GB), UsedPct: r1(float64(v.Used) / float64(v.Total) * 100)}
		if d, ok := forecast[v.Entity]; ok {
			x.FullInDays = f64p(r1(d))
		}
		if f, ok := fs[v.Entity]; ok {
			x.FSType, x.Device, x.ReadOnly, x.Remote, x.Error = strp(f.FSType), strp(f.Device), f.ReadOnly, f.Remote, strp(f.Error)
			if f.InodesTotal > 0 {
				x.InodesPct = f64p(r1(float64(f.InodesUsed) / float64(f.InodesTotal) * 100))
			}
		}
		if p, ok := pools[v.Entity]; ok {
			x.Health, x.Layout, x.FragPct, x.Status = strp(p.Health), strp(p.Layout), r1p(p.FragPct), strp(p.Status)
			if p.ScrubState != "" {
				x.Scrub = &Scrub{State: p.ScrubState, End: timep(p.ScrubEnd), Errors: p.ScrubErrors}
			}
			if p.ReadErrors+p.WriteErrors+p.CksumErrors > 0 {
				x.Errors = &PoolError{Read: p.ReadErrors, Write: p.WriteErrors, Checksum: p.CksumErrors}
			}
			x.Faulted = p.Faulted
		}
		out = append(out, x)
	}
	return out
}

func buildArrays(r *proto.Report) []Array {
	out := []Array{}
	for _, a := range r.RAID {
		x := Array{Name: a.Name, Level: a.Level, State: a.State, Devices: a.Devices, Active: a.Active, Members: a.Members,
			Failed: a.Failed, SyncPct: r1p(a.SyncPct), LastCheck: timep(a.LastCheck), CheckErrors: a.LastCheckErrors}
		if x.Members == nil {
			x.Members = []string{}
		}
		if x.Failed == nil {
			x.Failed = []string{}
		}
		if a.SizeBytes > 0 {
			x.SizeGB = f64p(r1(float64(a.SizeBytes) / rules.GB))
		}
		out = append(out, x)
	}
	return out
}

func buildUPS(r *proto.Report) []UPS {
	out := []UPS{}
	for _, u := range r.UPS {
		out = append(out, UPS{Name: u.Name, Model: strp(u.Model), Status: u.Status, ChargePct: r1p(u.ChargePct), RuntimeS: u.RuntimeS,
			LoadPct: r1p(u.LoadPct)})
	}
	return out
}

func buildGPUs(r *proto.Report) []GPU {
	out := []GPU{}
	gb := func(b *uint64) *float64 {
		if b == nil {
			return nil
		}
		return f64p(r1(float64(*b) / rules.GiB))
	}
	for _, g := range r.GPUs {
		out = append(out, GPU{Index: g.Index, Name: g.Name, Vendor: g.Vendor, UtilPct: r1p(g.UtilPct), MemUsedGB: gb(g.MemUsedBytes),
			MemTotalGB: gb(g.MemTotalBytes), TempC: r1p(g.TempC), PowerW: r1p(g.PowerW)})
	}
	return out
}

func buildFans(r *proto.Report) []Fan {
	out := []Fan{}
	for _, f := range r.Fans {
		x := Fan{Label: f.Label, Source: f.Source, RPM: f.RPM}
		if f.MinRPM > 0 {
			x.MinRPM = f64p(f.MinRPM)
		}
		out = append(out, x)
	}
	return out
}

func diskIO(d proto.Disk) *DiskIO {
	if d.IO == nil {
		return nil
	}
	return &DiskIO{ReadMBs: r1(d.IO.ReadBps / 1e6), WriteMBs: r1(d.IO.WriteBps / 1e6), UtilPct: r1(d.IO.UtilPct), AwaitMs: r1(d.IO.AwaitMs)}
}

func smartMore(d proto.Disk) SmartMore {
	var st *SelfTest
	if t := d.SelfTest; t != nil {
		st = &SelfTest{Type: t.Type, Result: t.Result, PowerOnHours: t.PowerOnHours}
	}
	return SmartMore{SelfTest: st, ErrorLog: d.ErrorLogCount, CRCErrors: d.CRCErrors, CriticalWarning: d.CriticalWarning,
		SparePct: r1p(d.SparePct), SpareThreshold: r1p(d.SpareThreshold), MediaErrors: d.MediaErrors,
		UnsafeShutdowns: d.UnsafeShutdowns, Standby: d.Standby}
}

func buildWarnings(p *proto.Platform) []PlatformWarning {
	if p == nil || len(p.Warnings) == 0 {
		return nil
	}
	out := []PlatformWarning{}
	for _, w := range p.Warnings {
		out = append(out, PlatformWarning{Type: w.Type, Message: w.Message, Count: w.Count, LastSeen: timep(w.LastSeen), Project: strp(w.Project)})
	}
	return out
}

// PVETaskWindow is how far back the failed tasks of a node are shown.
const PVETaskWindow = 48 * time.Hour

func buildTasks(r *proto.Report, now time.Time) []PVETask {
	out := []PVETask{}
	type src struct {
		platform string
		tasks    []proto.PVETask
	}
	var srcs []src
	if r.PVE != nil {
		srcs = append(srcs, src{proto.PlatformPVE, r.PVE.Tasks})
	}
	if r.Incus != nil {
		srcs = append(srcs, src{proto.PlatformIncus, r.Incus.Tasks})
	}
	for _, sr := range srcs {
		out = append(out, platformTasks(sr.platform, sr.tasks, now)...)
	}
	sort.SliceStable(out, func(i, j int) bool { return time.Time(out[i].Start).After(time.Time(out[j].Start)) })
	return out
}

func platformTasks(platform string, tasks []proto.PVETask, now time.Time) []PVETask {
	out := []PVETask{}
	for _, t := range tasks {
		running := t.End == nil
		if t.OK && !running {
			continue // finished fine: not interesting here
		}
		if !running && now.Sub(*t.End) > PVETaskWindow {
			continue
		}
		x := PVETask{Platform: platform, Type: t.Type, ID: strp(t.ID), Node: t.Node, User: strp(t.User), Start: Time(t.Start), Status: t.Status, OK: t.OK}
		if t.End != nil {
			x.End = T(*t.End)
		}
		out = append(out, x)
	}
	return out
}

func buildReplication(r *proto.Report) []Replication {
	out := []Replication{}
	if r.PVE == nil {
		return out
	}
	for _, x := range r.PVE.Replication {
		out = append(out, Replication{ID: x.ID, Guest: x.Guest, Target: x.Target, LastSync: timep(x.LastSync), Error: strp(x.Error), Fails: x.FailCount})
	}
	return out
}

// Health is the host-health part of the detail.
type Health struct {
	System      *System       `json:"system"`
	Network     []NetIface    `json:"network"`
	Volumes     []Volume      `json:"volumes"`
	Arrays      []Array       `json:"arrays"`
	UPS         []UPS         `json:"ups"`
	GPUs        []GPU         `json:"gpus"`
	Fans        []Fan         `json:"fans"`
	Tasks       []PVETask     `json:"tasks"`
	Replication []Replication `json:"pve_replication,omitempty"`
	Ceph        *Ceph         `json:"ceph,omitempty"`
}

func buildHealth(r *proto.Report, forecast map[string]float64, now time.Time) Health {
	h := Health{System: buildSystem(r), Network: buildNetwork(r), Volumes: buildVolumes(r, forecast), Arrays: buildArrays(r),
		UPS: buildUPS(r), GPUs: buildGPUs(r), Fans: buildFans(r), Tasks: buildTasks(r, now)}
	if r.PVE != nil {
		h.Replication = buildReplication(r)
		if c := r.PVE.Ceph; c != nil {
			h.Ceph = &Ceph{Status: c.Status, Summary: c.Summary}
			if h.Ceph.Summary == nil {
				h.Ceph.Summary = []string{}
			}
		}
	}
	return h
}

func emptyHealth() Health {
	return Health{Network: []NetIface{}, Volumes: []Volume{}, Arrays: []Array{}, UPS: []UPS{}, GPUs: []GPU{}, Fans: []Fan{}, Tasks: []PVETask{}}
}
