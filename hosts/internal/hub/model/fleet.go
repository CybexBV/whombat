package model

import (
	"math"
	"sort"
	"strconv"
	"strings"
	"time"

	"rackoon/internal/proto"
	"rackoon/internal/rules"
)

// ServerState is the hub's view of one server, the input of every builder.
type ServerState struct {
	ID          string
	Hostname    string
	Group       string
	Location    string
	Address     string // last known address (agent-reported or remote)
	RCConsole   bool   // hub toggles
	RCPower     bool
	RCHostShell bool
	RCHostPower bool
	RCManage    bool
	RCDiagnose  bool // the assistant's read-only checks (on by default)
	// ParentSetting is the stored parent ("" = detect, "-" = none, else an
	// id); DetectedParent the host found by name or address; Parent the one
	// in effect.
	ParentSetting  string
	DetectedParent string
	Parent         string
	Report         *proto.Report // latest report, nil before the first one
	ReportAt       time.Time     // when the hub received it
	LastSeen       time.Time     // last frame on the control stream (zero: never)
	Connected      bool
	// Via is the hub's own address the agent's connection arrived at
	// ("" when not connected or not known).
	Via          string
	ClockSkewS   *float64
	AgentVersion string
	Open         []rules.Alert // open alerts of the server
	// HeartbeatTimeout overrides the 60 s offline threshold (0 = default).
	HeartbeatTimeout time.Duration
	// Maintenance is the window muting the host's alerts now (nil: none).
	Maintenance *MaintInfo
	// ParentOffline: the host this one runs on (Parent) is offline, so this
	// host's alerts are consequences, not causes.
	ParentOffline bool
	// Forecast: volume entity ("fs:/srv") -> days until full, for volumes
	// that are filling up (read-only map).
	Forecast map[string]float64
	// MacHelperOffSince: a Mac's installed helper has not answered in the
	// session at the screen since then (zero: it runs, or not a Mac).
	MacHelperOffSince time.Time
}

// MaintInfo is an active maintenance window.
type MaintInfo struct {
	ID    string
	Until time.Time
	Note  string
}

// Status applies the server status rule: offline without a heartbeat,
// warning while an open alert asks for attention (acknowledged, muted and
// suppressed alerts don't, HS-190), else online.
func (s *ServerState) Status(now time.Time) string {
	return rules.ServerStatusWith(now.Sub(s.LastSeen), s.HeartbeatTimeout, !s.LastSeen.IsZero(), len(s.Attention(now)) > 0)
}

// Online reports whether the server is not offline (the heartbeat alone
// decides; alerts don't).
func (s *ServerState) Online(now time.Time) bool {
	return rules.ServerStatusWith(now.Sub(s.LastSeen), s.HeartbeatTimeout, !s.LastSeen.IsZero(), false) != rules.StatusOffline
}

// Attention returns the server's open alerts that ask for attention: not
// acknowledged, not muted by maintenance, not suppressed by an offline
// parent. They alone make the status warning and give its note.
func (s *ServerState) Attention(now time.Time) []rules.Alert {
	var out []rules.Alert
	for _, a := range s.Open {
		if NeedsAttention(a, s, now) {
			out = append(out, a)
		}
	}
	return out
}

// StatusNote is the short reason next to the status: for a warning, the
// note of the most severe alert that asks for attention.
func (s *ServerState) StatusNote(now time.Time) *string {
	switch s.Status(now) {
	case rules.StatusOffline:
		if s.LastSeen.IsZero() {
			return ptr("never connected")
		}
		return ptr("not checking in")
	case rules.StatusWarning:
		return strp(rules.StatusNote(s.Attention(now)))
	}
	return nil
}

// AllGroup is the pseudo group of the group control.
const AllGroup = "All"

// InGroup reports whether a server belongs to the selected group.
func InGroup(s *ServerState, group string) bool {
	return group == "" || strings.EqualFold(group, AllGroup) || strings.EqualFold(s.Group, group)
}

// shortOSName strips the " GNU/Linux" suffix ("Debian GNU/Linux" -> "Debian").
func shortOSName(n string) string {
	n = strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(n), "GNU/Linux"))
	return n
}

func osName(r *proto.Report) (name, version string) {
	if r == nil {
		return "", ""
	}
	name, version = shortOSName(r.Host.OSName), r.Host.OSVersion
	if r.PVE != nil {
		name = "Proxmox VE"
		if r.PVE.Version != "" {
			version = r.PVE.Version
		}
	}
	if name == "" {
		name = r.Host.OSPretty
	}
	return name, version
}

// DetailView is the server's kind (IU-03, IU-13): "macos" for a Mac,
// "proxmox" for Proxmox VE nodes, "unraid" for unRAID servers, "incus" for
// hosts with Incus, "libvirt" for hosts whose VMs libvirt runs (shown as
// QEMU/KVM), else "standard". The first that applies wins, in that order.
func DetailView(r *proto.Report) string {
	switch {
	case r == nil:
		return "standard"
	case r.MacOS != nil:
		return "macos"
	case r.PVE != nil:
		return "proxmox"
	case IsUnraid(r):
		return "unraid"
	case r.Incus != nil:
		return "incus"
	case r.Libvirt != nil:
		return "libvirt"
	}
	return "standard"
}

func memPct(r *proto.Report) *float64 {
	if r == nil || r.Memory.TotalBytes == 0 {
		return nil
	}
	return ptr(r1(float64(r.Memory.UsedBytes) / float64(r.Memory.TotalBytes) * 100))
}

func fleetWorkloads(r *proto.Report) FleetWorkloads {
	var w FleetWorkloads
	if r == nil {
		return w
	}
	for _, g := range r.AllGuests() {
		switch g.Platform {
		case proto.PlatformDocker:
			switch g.State {
			case proto.StateRunning:
				w.Docker.Running++
			case proto.StateUnhealthy:
				w.Docker.Unhealthy++
			default:
				w.Docker.Stopped++
			}
		case proto.PlatformIncus:
			switch {
			case g.State != proto.StateRunning:
				w.Incus.Stopped++
			case g.Kind == "vm":
				w.Incus.VMsRunning++
			default:
				w.Incus.ContainersRunning++
			}
		case proto.PlatformLibvirt, proto.PlatformPVE:
			if g.Kind != "vm" {
				continue
			}
			if g.State == proto.StateRunning {
				w.QEMU.Running++
			} else {
				w.QEMU.Stopped++
			}
		}
	}
	return w
}

// BuildHypervisor computes the hypervisor row (nil without a stack).
func BuildHypervisor(r *proto.Report) *Hypervisor {
	if !rules.IsHypervisor(r) {
		return nil
	}
	a := rules.Allocation(r)
	threads := rules.HostThreads(r)
	host := rules.HostMemoryBytes(r)
	return &Hypervisor{
		Stacks:                 rules.Stacks(r),
		KVMEnabled:             rules.KVMEnabled(r),
		HostThreads:            threads,
		VCPUAllocated:          a.VCPUAllocated,
		VCPUOvercommitRatio:    r2(rules.OvercommitRatio(a.VCPUAllocated, threads)),
		GuestMemoryAssignedGB:  r1(float64(a.MemAssignedBytes) / rules.GiB),
		GuestMemoryAssignedPct: r1(rules.MemAssignedPct(a.MemAssignedBytes, host)),
		HostMemoryGB:           r1(float64(host) / rules.GiB),
		VMs:                    a.RunningVMs,
		Containers:             a.RunningContainers,
	}
}

// BuildFleetServer builds one server card.
func BuildFleetServer(s *ServerState, now time.Time) FleetServer {
	r := s.Report
	status := s.Status(now)
	fs := FleetServer{
		ID: s.ID, Hostname: s.Hostname, Group: s.Group, Status: status, StatusNote: s.StatusNote(now),
		LastSeen: T(s.LastSeen), DetailView: DetailView(r), OSFamily: OSFamily(r), AgentConnected: s.Connected, Via: s.Via, OpenAlerts: len(s.Open),
		ConsoleOn: s.RCConsole && r != nil && r.Policy.Console, HostsThisWhombat: HostsThisWhombat(r),
	}
	if r != nil {
		n, v := osName(r)
		fs.OS = strp(strings.TrimSpace(n + " " + v))
		fs.CPU = &CPUInfo{Model: r.Host.CPUModel, Cores: r.Host.Cores, Threads: r.Host.Threads}
		fs.MemoryTotalGB = ptr(r1(float64(rules.HostMemoryBytes(r)) / rules.GiB))
		fs.StorageCapacityTB = ptr(r2(float64(rules.StorageCapacityBytes(r)) / rules.TB))
	}
	if s.Maintenance != nil {
		fs.Maintenance = &MaintJSON{ID: s.Maintenance.ID, Until: Time(s.Maintenance.Until), Note: s.Maintenance.Note}
	}
	fs.Parent = strp(s.Parent)
	if status == rules.StatusOffline {
		if r != nil {
			fs.LastKnown = &LastKnown{
				CPUPct: ptr(r1(r.CPU.UsagePct)), MemPct: memPct(r),
				DiskUsedPct: r1p(rules.DiskUsedPct(r)), DiskWearMaxPct: r1p(rules.MaxWear(r)),
			}
		}
		return fs
	}
	if r != nil {
		cur := &Current{CPUPct: ptr(r1(r.CPU.UsagePct)), MemPct: memPct(r),
			DiskUsedPct: r1p(rules.DiskUsedPct(r)), DiskWearMaxPct: r1p(rules.MaxWear(r))}
		if hs, limit := rules.HottestSensor(r); hs != nil {
			cur.TempMaxC = ptr(r1(hs.TempC))
			cur.TempLimitC = ptr(limit)
		}
		fs.Current = cur
		fs.Workloads = fleetWorkloads(r)
		fs.Hypervisor = BuildHypervisor(r)
	}
	return fs
}

// BuildAlert maps an alert (without its host's context: see BuildAlertFor).
func BuildAlert(a rules.Alert) Alert { return BuildAlertFor(a, nil, time.Now()) }

// BuildAlertFor maps an alert with its host's state: muted while the host
// is in maintenance, suppressed while the host it runs on is offline.
// Attention is what the badge counts: open and none of those.
func BuildAlertFor(a rules.Alert, s *ServerState, now time.Time) Alert {
	out := Alert{ID: a.ID, Server: a.Server, Severity: a.Severity, Title: a.Title, Detail: a.Detail,
		OpenedAt: Time(a.OpenedAt), Rule: a.Rule, Entity: a.Entity, Key: a.Key, State: a.State, Link: strp(a.Link)}
	if out.Key == "" {
		out.Key = a.Rule + ":" + a.Entity
	}
	if a.ResolvedAt != nil {
		out.ResolvedAt = T(*a.ResolvedAt)
	}
	if a.Ack != nil && (a.State == rules.AlertResolved || a.Ack.Active(now)) {
		out.Acknowledged = &AckJSON{At: Time(a.Ack.At), By: a.Ack.By, Note: a.Ack.Note}
		if a.Ack.Until != nil {
			out.Acknowledged.Until = T(*a.Ack.Until)
		}
	}
	if s != nil && a.State == rules.AlertOpen {
		out.Muted = s.Maintenance != nil
		if s.ParentOffline && s.Parent != "" {
			out.SuppressedBy = strp(s.Parent)
		}
	}
	out.Attention = a.State == rules.AlertOpen && out.Acknowledged == nil && !out.Muted && out.SuppressedBy == nil
	return out
}

// NeedsAttention reports whether an open alert of the server asks for
// attention (the notification and badge rule).
func NeedsAttention(a rules.Alert, s *ServerState, now time.Time) bool {
	return BuildAlertFor(a, s, now).Attention
}

// BuildHints evaluates the hint rules of a server (CONTRACT.md 1 "hints"):
// empty while it is offline or has not reported yet.
func BuildHints(s *ServerState, now time.Time, hubVersion string) []Hint {
	out := []Hint{}
	if s.Report == nil || !s.Online(now) {
		return out
	}
	for _, h := range rules.HostHints(s.Report, hubVersion, s.Open) {
		out = append(out, Hint{Server: s.ID, Hint: h})
	}
	for _, h := range rules.ForecastHints(s.Report, s.Forecast, s.Open) {
		out = append(out, Hint{Server: s.ID, Hint: h})
	}
	for _, h := range pveHints(s.Report, s.Open, now) {
		out = append(out, Hint{Server: s.ID, Hint: h})
	}
	for _, h := range macHints(s, now) {
		out = append(out, Hint{Server: s.ID, Hint: h})
	}
	sort.SliceStable(out, func(i, j int) bool { return rules.HintRank(out[i].Severity) < rules.HintRank(out[j].Severity) })
	hintIDs(out)
	return out
}

// hintIDs gives every hint its stable id, kind + ":" + entity (HS-192).
// The rules give one hint per kind and entity; should two ever share one,
// the later gets "#2", "#3" … in the hints' order.
func hintIDs(l []Hint) {
	seen := map[string]int{}
	for i := range l {
		id := l[i].Kind + ":" + l[i].Entity
		seen[id]++
		if n := seen[id]; n > 1 {
			id += "#" + strconv.Itoa(n)
		}
		l[i].ID = id
	}
}

// Groups lists "All" then each group in first-appearance (card) order.
func Groups(states []*ServerState) []GroupCount {
	out := []GroupCount{{Name: AllGroup, Count: len(states)}}
	idx := map[string]int{}
	for _, s := range states {
		k := strings.ToLower(s.Group)
		if i, ok := idx[k]; ok {
			out[i].Count++
			continue
		}
		idx[k] = len(out)
		out = append(out, GroupCount{Name: s.Group, Count: 1})
	}
	return out
}

// BuildFleet builds GET /fleet for a group. states must be in card order;
// hubVersion is the hub's own version (for the agent.outdated hint).
// hubAlerts are alerts that belong to no host (checks run by the hub,
// security); they are listed for the whole fleet only.
func BuildFleet(states []*ServerState, group string, now time.Time, pendingEnrollments int, hubVersion string, hubAlerts ...rules.Alert) Fleet {
	f := Fleet{
		AsOf: Time(now), Groups: Groups(states), PendingEnrollments: pendingEnrollments,
		Servers: []FleetServer{}, Alerts: []Alert{}, Hints: []Hint{},
		TopGuestsByCPU: TopGuests{Docker: []TopGuest{}, Incus: []TopGuest{}, QEMU: []TopGuest{}},
	}
	var cpuSum float64
	var cpuN int
	var memUsed, memTotal, stUsed, stTotal float64
	var open []rules.Alert
	hostOf := map[string]*ServerState{}
	var top struct{ docker, incus, qemu []TopGuest }
	for _, s := range states {
		if !InGroup(s, group) {
			continue
		}
		f.KPIs.ServersTotal++
		f.Servers = append(f.Servers, BuildFleetServer(s, now))
		open = append(open, s.Open...)
		hostOf[s.ID] = s
		if s.Connected {
			f.AgentsConnected++
		}
		r := s.Report
		if !s.Online(now) || r == nil {
			continue
		}
		f.KPIs.ServersOnline++
		f.Hints = append(f.Hints, BuildHints(s, now, hubVersion)...)
		cpuSum += r.CPU.UsagePct
		cpuN++
		memUsed += float64(r.Memory.UsedBytes)
		memTotal += float64(rules.HostMemoryBytes(r))
		capB := float64(rules.StorageCapacityBytes(r))
		if p := rules.DiskUsedPct(r); p != nil {
			stUsed += capB * *p / 100
		}
		stTotal += capB
		f.KPIs.DisksOver75Wear += rules.DisksOverWear(r)

		ps := &f.PlatformSummary
		if r.Docker != nil {
			ps.Docker.Servers++
		}
		if r.Incus != nil {
			ps.Incus.Servers++
		}
		if r.Libvirt != nil {
			ps.QEMU.LibvirtServers++
		}
		if r.PVE != nil {
			ps.QEMU.ProxmoxServers++
		}
		for _, g := range r.AllGuests() {
			running := g.State == proto.StateRunning
			var cpu float64
			if g.CPUPct != nil && !math.IsNaN(*g.CPUPct) {
				cpu = r1(*g.CPUPct)
			}
			tg := TopGuest{Name: g.Name, Server: s.ID, CPUPct: cpu}
			if tg.Name == "" {
				tg.Name = g.ID
			}
			switch g.Platform {
			case proto.PlatformDocker:
				switch g.State {
				case proto.StateRunning:
					ps.Docker.Running++
				case proto.StateUnhealthy:
					ps.Docker.Unhealthy++
				default:
					ps.Docker.Stopped++
				}
				if running || g.State == proto.StateUnhealthy {
					top.docker = append(top.docker, tg)
				}
			case proto.PlatformIncus:
				switch {
				case !running:
					ps.Incus.Stopped++
				case g.Kind == "vm":
					ps.Incus.VMsRunning++
				default:
					ps.Incus.ContainersRunning++
				}
				if running {
					top.incus = append(top.incus, tg)
				}
			case proto.PlatformLibvirt, proto.PlatformPVE:
				if g.Kind != "vm" {
					continue
				}
				if !running {
					ps.QEMU.Stopped++
					continue
				}
				ps.QEMU.Running++
				if g.Platform == proto.PlatformPVE {
					ps.QEMU.ProxmoxVMsRunning++
				} else {
					ps.QEMU.LibvirtVMsRunning++
				}
				top.qemu = append(top.qemu, tg)
			}
		}
	}
	if cpuN > 0 {
		f.KPIs.CPUAvgPct = ptr(r1(cpuSum / float64(cpuN)))
	}
	if memTotal > 0 {
		f.KPIs.MemoryPct = ptr(r1(memUsed / memTotal * 100))
	}
	f.KPIs.MemoryUsedGB = r1(memUsed / rules.GiB)
	f.KPIs.MemoryTotalGB = r1(memTotal / rules.GiB)
	f.KPIs.StorageUsedTB = r2(stUsed / rules.TB)
	f.KPIs.StorageTotalTB = r2(stTotal / rules.TB)
	if stTotal > 0 {
		f.KPIs.StoragePct = ptr(r1(stUsed / stTotal * 100))
	}
	if group == "" || strings.EqualFold(group, AllGroup) {
		open = append(open, hubAlerts...)
	}
	rules.SortAlerts(open)
	// Alerts asking for attention first, then the acknowledged, muted and
	// suppressed ones (in severity / age order within each part).
	built := make([]Alert, 0, len(open))
	for _, a := range open {
		built = append(built, BuildAlertFor(a, hostOf[a.Server], now))
	}
	sort.SliceStable(built, func(i, j int) bool { return built[i].Attention && !built[j].Attention })
	for _, a := range built {
		f.Alerts = append(f.Alerts, a)
		if a.Attention {
			f.KPIs.OpenAlertsAttention++
		}
		f.KPIs.OpenAlerts++
		if a.Severity == rules.SevCritical {
			f.KPIs.OpenAlertsCritical++
		} else {
			f.KPIs.OpenAlertsWarning++
		}
	}
	// Hints: warnings first, then by server and title.
	sort.SliceStable(f.Hints, func(i, j int) bool {
		a, b := f.Hints[i], f.Hints[j]
		if ra, rb := rules.HintRank(a.Severity), rules.HintRank(b.Severity); ra != rb {
			return ra < rb
		}
		if a.Server != b.Server {
			return a.Server < b.Server
		}
		return a.Title < b.Title
	})
	f.TopGuestsByCPU.Docker = top5(top.docker)
	f.TopGuestsByCPU.Incus = top5(top.incus)
	f.TopGuestsByCPU.QEMU = top5(top.qemu)
	return f
}

func top5(g []TopGuest) []TopGuest {
	sort.SliceStable(g, func(i, j int) bool {
		if g[i].CPUPct != g[j].CPUPct {
			return g[i].CPUPct > g[j].CPUPct
		}
		return g[i].Name < g[j].Name
	})
	if len(g) > 5 {
		g = g[:5]
	}
	if g == nil {
		g = []TopGuest{}
	}
	return g
}

// ServerListItem is an entry of GET /servers (switcher, sidebar count).
type ServerListItem struct {
	ID             string  `json:"id"`
	Hostname       string  `json:"hostname"`
	Group          string  `json:"group"`
	Status         string  `json:"status"`
	StatusNote     *string `json:"status_note"`
	OS             *string `json:"os"`
	DetailView     string  `json:"detail_view"`
	OSFamily       string  `json:"os_family,omitempty"` // linux | macos
	LastSeen       *Time   `json:"last_seen"`
	AgentConnected bool    `json:"agent_connected"`
	OpenAlerts     int     `json:"open_alerts"`
	// HostsThisWhombat: one of the host's guests is this Whombat (IU-02).
	HostsThisWhombat bool `json:"hosts_this_whombat,omitempty"`
	// BackupPlace (backupplace.go): null from agents that don't report it.
	BackupPlace *BackupPlace `json:"backup_place"`
}

// BuildServerList builds GET /servers.
func BuildServerList(states []*ServerState, now time.Time) []ServerListItem {
	out := []ServerListItem{}
	for _, s := range states {
		fs := BuildFleetServer(s, now)
		out = append(out, ServerListItem{ID: fs.ID, Hostname: fs.Hostname, Group: fs.Group, Status: fs.Status,
			StatusNote: fs.StatusNote, OS: fs.OS, DetailView: fs.DetailView, OSFamily: fs.OSFamily, LastSeen: fs.LastSeen,
			AgentConnected: fs.AgentConnected, OpenAlerts: fs.OpenAlerts, HostsThisWhombat: fs.HostsThisWhombat,
			BackupPlace: BuildBackupPlace(s.Report)})
	}
	return out
}
