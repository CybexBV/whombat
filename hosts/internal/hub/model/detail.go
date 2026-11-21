package model

import (
	"fmt"
	"math"
	"sort"
	"strings"
	"time"

	"rackoon/internal/proto"
	"rackoon/internal/rules"
)

// Reasons shown on disabled console / power buttons.
const (
	ReasonRole       = "Requires operator access"
	ReasonHubConsole = "Remote control is turned off for this server"
	ReasonHubPower   = "Power actions are turned off for this server"
	ReasonAgent      = "This host's agent does not allow consoles yet: set console = true under [remote_control] in its agent.toml and reload the agent"
	ReasonAgentPower = "This host's agent does not allow power actions yet: set power = true under [remote_control] in its agent.toml and reload the agent"
	ReasonInsecure   = "Consoles need HTTPS: open Rackoon through its https address"
	ReasonAdmin      = "Requires admin access"
	ReasonHubShell   = "The host shell is turned off for this server"
	ReasonAgentShell = "This host's agent does not allow the host shell yet: set host_shell = true under [remote_control] in its agent.toml and reload the agent"
	ReasonHubHostPow = "Host power is turned off for this server"
	ReasonAgentHPow  = "This host's agent does not allow host power yet: set host_power = true under [remote_control] in its agent.toml and reload the agent"
	ReasonHubManage  = "Managing guests is turned off for this server"
	ReasonAgentMgmt  = "This host's agent does not allow managing guests yet: set manage = true under [remote_control] in its agent.toml and reload the agent"
	ReasonHubSnaps   = "Listing snapshots needs power actions or managing guests turned on for this server"
	ReasonAgentSnaps = "This host's agent allows neither power actions nor managing guests: set power = true or manage = true under [remote_control] in its agent.toml and reload the agent"
	ReasonHubDiag    = "Diagnostics are turned off for this server"
	ReasonAgentDiag  = "This host's agent does not run the assistant's diagnostics: update the agent, or remove diagnose = false under [remote_control] in its agent.toml and reload it"
)

// HostGuestID addresses the host itself in console and action requests.
const HostGuestID = "host:host"

// Perms computes the effective remote-control permissions of a role on a
// server: hub toggle AND agent's local flag AND role >= operator.
func Perms(s *ServerState, roleRank int) RemoteControl {
	var pol proto.Policy
	if s.Report != nil {
		pol = s.Report.Policy
	}
	rc := RemoteControl{AgentConsole: pol.Console, AgentPower: pol.Power}
	reason := func(hub, agent bool, hubReason, agentReason string) *string {
		switch {
		case roleRank < 1:
			return ptr(ReasonRole)
		case !hub:
			return ptr(hubReason)
		case !agent:
			return ptr(agentReason)
		}
		return nil
	}
	rc.ConsoleReason = reason(s.RCConsole, pol.Console, ReasonHubConsole, ReasonAgent)
	rc.PowerReason = reason(s.RCPower, pol.Power, ReasonHubPower, ReasonAgentPower)
	rc.ManageReason = reason(s.RCManage, pol.Manage, ReasonHubManage, ReasonAgentMgmt)
	rc.Console = rc.ConsoleReason == nil
	rc.Power = rc.PowerReason == nil
	rc.Manage, rc.AgentManage = rc.ManageReason == nil, pol.Manage
	rc.DiagnoseReason = reason(s.RCDiagnose, pol.Diagnose, ReasonHubDiag, ReasonAgentDiag)
	rc.Diagnose, rc.AgentDiagnose = rc.DiagnoseReason == nil, pol.Diagnose
	// Host access is admin-only on top of its own two switches.
	hostReason := func(hub, agent bool, hubReason, agentReason string) *string {
		if roleRank < 2 {
			return ptr(ReasonAdmin)
		}
		return reason(hub, agent, hubReason, agentReason)
	}
	rc.HostShellReason = hostReason(s.RCHostShell, pol.HostShell, ReasonHubShell, ReasonAgentShell)
	rc.HostPowerReason = hostReason(s.RCHostPower, pol.HostPower, ReasonHubHostPow, ReasonAgentHPow)
	rc.HostShell, rc.HostPower = rc.HostShellReason == nil, rc.HostPowerReason == nil
	rc.AgentHostShell, rc.AgentHostPower = pol.HostShell, pol.HostPower
	return rc
}

// permsFor applies the request's transport to Perms: over plain HTTP the
// console is refused (power actions carry no secrets and stay).
func permsFor(s *ServerState, in DetailInput) RemoteControl {
	rc := Perms(s, in.RoleRank)
	if in.InsecureTransport && rc.Console {
		rc.Console, rc.ConsoleReason = false, ptr(ReasonInsecure)
	}
	if in.InsecureTransport && rc.HostShell {
		rc.HostShell, rc.HostShellReason = false, ptr(ReasonInsecure)
	}
	return rc
}

// NodeAgent tells whether a Proxmox node name belongs to an enrolled server.
type NodeAgent struct {
	ServerID  string
	Connected bool
}

// DetailInput are the extra inputs of the detail builder.
type DetailInput struct {
	Range      string
	SensorMax  map[string]*float64 // series name -> max over the range
	RoleRank   int
	NodeAgents map[string]NodeAgent // Proxmox node name -> enrolled server
	GuestLimit int                  // first page size (default 50)
	HubVersion string               // the hub's own version (agent.outdated hint)
	// InsecureTransport: the request came over plain HTTP and the hub
	// refuses consoles there.
	InsecureTransport bool
}

// sensorOrder is the canonical order of the sensor groups.
var sensorOrder = map[string]int{
	proto.SensorCPU: 0, proto.SensorBoard: 1, proto.SensorNVMe: 2, proto.SensorDIMM: 3, proto.SensorHDD: 4, proto.SensorSATASS: 5,
}

// BuildDetail builds GET /servers/{id}.
func BuildDetail(s *ServerState, now time.Time, in DetailInput) Detail {
	r := s.Report
	status := s.Status(now)
	online := status != rules.StatusOffline
	d := Detail{AsOf: Time(now), Range: in.Range, Sensors: []Sensor{}, Hints: BuildHints(s, now, in.HubVersion),
		proxmox: DetailView(r) == "proxmox"}
	if in.GuestLimit <= 0 {
		in.GuestLimit = 50
	}

	// Server.
	sv := DetailServer{
		ID: s.ID, Hostname: s.Hostname, Group: s.Group, Status: status, StatusNote: s.StatusNote(now),
		OpenAlerts: len(s.Open), Roles: []string{}, Location: strp(s.Location), DetailView: DetailView(r), OSFamily: OSFamily(r),
		RemoteControl: permsFor(s, in), Collectors: []Collector{}, HostsThisWhombat: HostsThisWhombat(r),
		Agent: AgentInfo{Connected: s.Connected, ClockSkewS: s.ClockSkewS, Version: strp(s.AgentVersion)},
	}
	if !s.ReportAt.IsZero() {
		ago := int64(now.Sub(s.ReportAt) / time.Second)
		if ago < 0 {
			ago = 0
		}
		sv.Agent.LastSyncSAgo = &ago
	}
	sv.Address = strp(s.Address)
	if r != nil {
		if rules.KVMEnabled(r) && rules.IsHypervisor(r) {
			sv.Roles = append(sv.Roles, "kvm-host")
		}
		if r.PVE != nil {
			sv.Roles = append(sv.Roles, "proxmox-node")
			sv.PVEVersion = strp(r.PVE.Version)
		}
		n, v := osName(r)
		sv.OS = &OSInfo{Name: n, Version: v, Kernel: r.Host.Kernel}
		sv.CPU = &CPUInfo{Model: r.Host.CPUModel, Cores: r.Host.Cores, Threads: r.Host.Threads}
		sv.Memory = &MemInfo{TotalGB: r1(float64(rules.HostMemoryBytes(r)) / rules.GiB), Type: strp(r.Host.MemoryType)}
		if !r.Host.BootTime.IsZero() {
			sv.LastBoot = T(r.Host.BootTime)
			if online {
				up := int64(now.Sub(r.Host.BootTime) / time.Second)
				sv.UptimeS = &up
			}
		}
		if len(r.Host.Addresses) > 0 {
			sv.Address = strp(r.Host.Addresses[0])
		}
		if r.Agent.Version != "" {
			sv.Agent.Version = strp(r.Agent.Version)
		}
		for _, c := range r.Collectors {
			sv.Collectors = append(sv.Collectors, Collector{Name: c.Name, OK: c.OK, Error: strp(c.Error)})
		}
	}
	if s.Maintenance != nil {
		sv.Maintenance = &MaintJSON{ID: s.Maintenance.ID, Until: Time(s.Maintenance.Until), Note: s.Maintenance.Note}
	}
	sv.Parent = strp(s.Parent)
	d.Server = sv

	// Banner: most severe open alert.
	// The banner asks for attention: acknowledged, muted and suppressed
	// alerts do not get one.
	if a, ok := rules.Banner(s.Attention(now)); ok {
		t, det := a.BannerTitle, a.BannerDetail
		if t == "" {
			t, det = a.Title, a.Detail
		}
		d.Banner = &Banner{Severity: a.Severity, Title: t, Detail: det, Link: strp(a.Link), Rule: a.Rule, AlertID: a.ID}
	}

	if r == nil {
		d.Health = emptyHealth()
		d.Disks = []Disk{}
		if !d.proxmox {
			d.Workloads = map[string]*PlatformBlock{}
		}
		return d
	}

	// Live: the latest report's values (stale while offline; live.as_of
	// says when they were reported).
	d.Live = buildLive(r)
	d.Live.AsOf = T(s.ReportAt)
	d.MacOS = BuildMacOS(r)

	// Sensors.
	sensors := append([]proto.Sensor{}, r.Sensors...)
	sort.SliceStable(sensors, func(i, j int) bool { return order(sensors[i].ID) < order(sensors[j].ID) })
	for _, x := range sensors {
		if math.IsNaN(x.TempC) || math.IsInf(x.TempC, 0) {
			continue
		}
		se := Sensor{ID: x.ID, Label: x.Label, Group: x.Group, Source: x.Source, LimitC: rules.SensorLimit(x),
			NowC: ptr(r1(x.TempC))}
		if m := in.SensorMax[proto.SensorSeries(x.ID)]; m != nil {
			se.Max24hC = ptr(*m)
		}
		if se.NowC != nil && (se.Max24hC == nil || *se.NowC > *se.Max24hC) {
			se.Max24hC = ptr(*se.NowC)
		}
		d.Sensors = append(d.Sensors, se)
	}

	d.Virtualization = buildVirtualization(r, d.proxmox)
	d.Health = buildHealth(r, s.Forecast, now)
	d.Incus = BuildIncus(r)

	if d.proxmox {
		d.Disks = buildPVEDisks(r)
		d.Cluster = buildCluster(r, in.NodeAgents)
		d.Storages = buildStorages(r)
		d.Backups = buildBackups(r)
		d.Guests = buildPVEGuests(r, now, in.GuestLimit)
		if w := buildWorkloads(r, now, in.GuestLimit, true); len(w) > 0 {
			d.Workloads = w
		}
	} else {
		d.Disks = buildDisks(r)
		d.Workloads = buildWorkloads(r, now, in.GuestLimit, false)
	}
	d.Unraid = buildUnraid(r)
	d.BackupPlace = BuildBackupPlace(r)
	d.Libvirt = buildLibvirt(r)
	return d
}

func order(id string) int {
	if o, ok := sensorOrder[id]; ok {
		return o
	}
	return 100
}

func gib(b uint64) float64 { return r1(float64(b) / rules.GiB) }

func buildLive(r *proto.Report) *Live {
	l := &Live{
		RefreshIntervalS: int(proto.ReportInterval / time.Second),
		CPUPct:           r1(r.CPU.UsagePct), CPUUserPct: r1(r.CPU.UserPct), CPUSystemPct: r1(r.CPU.SystemPct),
		CPUIOWaitPct: r1(r.CPU.IOWaitPct),
		LoadAvg:      [3]float64{r2(r.CPU.Load[0]), r2(r.CPU.Load[1]), r2(r.CPU.Load[2])},
		MemUsedGB:    gib(r.Memory.UsedBytes), MemFreeGB: gib(r.Memory.FreeBytes),
		SwapUsedGB: gib(r.Memory.SwapUsedBytes), SwapTotalGB: gib(r.Memory.SwapTotalBytes),
		MemCacheGB: ptr(gib(r.Memory.CachedBytes)),
	}
	if p := memPct(r); p != nil {
		l.MemPct = *p
	}
	if r.Memory.ZFSARCBytes != nil {
		l.ZFSARCGB = ptr(gib(*r.Memory.ZFSARCBytes))
	}
	return l
}

func diskHealth(d proto.Disk) string {
	if diskHealthReason(d) != nil {
		return "failing"
	}
	if rules.IsSSD(d) && d.WearPct != nil && rules.WearHigh(*d.WearPct) {
		return "wear_high"
	}
	return "healthy"
}

// diskHealthReason is why a disk counts as failing (nil: it does not).
func diskHealthReason(d proto.Disk) *string {
	if w := rules.SmartFailure(d); w != "" {
		return &w
	}
	return strp(rules.SmartErrors(d))
}

func smartOf(x proto.Disk) Smart {
	return Smart{Passed: x.SmartPassed, Reallocated: x.Reallocated, Pending: x.Pending, Uncorrectable: x.Uncorrectable,
		SmartMore: smartMore(x)}
}

func wear(d proto.Disk) *float64 {
	if !rules.IsSSD(d) || d.WearPct == nil || math.IsNaN(*d.WearPct) {
		return nil
	}
	return ptr(r1(rules.WearDisplay(*d.WearPct)))
}

func f1p(f *float64) *float64 { return r1p(f) }

func buildDisks(r *proto.Report) []Disk {
	out := []Disk{}
	for _, x := range r.Disks {
		d := Disk{
			Device: x.Device, Type: x.Type, Model: x.Model, Role: strp(x.Role), Pool: strp(x.Pool),
			CapacityGB: r1(float64(x.CapacityBytes) / rules.GB), WearPct: wear(x), TempC: f1p(x.TempC),
			PowerOnHours: x.PowerOnHours, Health: diskHealth(x), HealthReason: diskHealthReason(x), Smart: smartOf(x), IO: diskIO(x),
		}
		if x.UsedBytes != nil {
			d.UsedGB = ptr(r1(float64(*x.UsedBytes) / rules.GB))
		}
		if rules.IsSSD(x) {
			if x.WrittenBytes != nil {
				d.WrittenTB = ptr(r1(float64(*x.WrittenBytes) / rules.TB))
			}
			d.RatedTBW = f1p(x.RatedTBW)
		}
		out = append(out, d)
	}
	return out
}

func buildPVEDisks(r *proto.Report) []PVEDisk {
	out := []PVEDisk{}
	for _, x := range r.Disks {
		out = append(out, PVEDisk{Device: x.Device, Type: x.Type, Model: x.Model, Pool: strp(x.Pool),
			WearPct: wear(x), TempC: f1p(x.TempC), Health: diskHealth(x), HealthReason: diskHealthReason(x), Smart: smartOf(x), IO: diskIO(x)})
	}
	return out
}

func pageSize(b uint64) string {
	switch {
	case b >= 1<<30 && b%(1<<30) == 0:
		return fmt.Sprintf("%dG", b>>30)
	case b >= 1<<20 && b%(1<<20) == 0:
		return fmt.Sprintf("%dM", b>>20)
	case b >= 1<<10:
		return fmt.Sprintf("%dK", b>>10)
	}
	return fmt.Sprintf("%dB", b)
}

func buildVirtualization(r *proto.Report, proxmox bool) *Virtualization {
	if r.KVM == nil {
		return nil
	}
	k := r.KVM
	v := &Virtualization{Stacks: rules.Stacks(r)}
	if v.Stacks == nil {
		v.Stacks = []string{}
	}
	c := &v.Capabilities
	c.KVM.Enabled, c.KVM.Module, c.KVM.Device = k.Enabled, k.Module, k.Device
	c.CPUVirtualization.Type, c.CPUVirtualization.Flag, c.CPUVirtualization.NestedPaging = k.CPUVirtType, k.CPUFlag, k.NestedPaging
	c.IOMMU.Enabled, c.IOMMU.Groups, c.IOMMU.VFIOPCIDevices = k.IOMMUEnabled, k.IOMMUGroups, k.VFIOPCIDevices
	c.Nested.Enabled, c.Nested.ModuleParam = k.NestedEnabled, k.NestedParam
	if !proxmox {
		c.Hugepages = &Hugepages{
			ReservedGB: r1(float64(uint64(k.HugepagesCount)*k.HugepageSize) / rules.GiB),
			PageSize:   pageSize(k.HugepageSize), Count: k.HugepagesCount,
		}
	}
	c.KSM.Running, c.KSM.SavedGB = k.KSMRunning, r1(float64(k.KSMSavedBytes)/rules.GiB)
	a := rules.Allocation(r)
	c.Ballooning.VMsActive, c.Ballooning.VMsTotal = a.BalloonActive, a.RunningVMs
	c.Ballooning.State = "idle"
	if a.BalloonActive > 0 {
		c.Ballooning.State = "active"
	}
	threads := rules.HostThreads(r)
	host := rules.HostMemoryBytes(r)
	al := &v.Allocation
	al.VCPUAllocated, al.HostThreads = a.VCPUAllocated, threads
	al.VCPUOvercommitRatio = r2(rules.OvercommitRatio(a.VCPUAllocated, threads))
	al.GuestMemoryAssignedGB = gib(a.MemAssignedBytes)
	al.GuestMemoryAssignedPct = r1(rules.MemAssignedPct(a.MemAssignedBytes, host))
	al.HostMemoryGB = gib(host)
	al.GuestMemoryInUseGB = gib(a.MemInUseBytes)
	var rd, wr, rx, tx float64
	for _, g := range r.AllGuests() {
		add := func(dst *float64, p *float64) {
			if p != nil && !math.IsNaN(*p) && !math.IsInf(*p, 0) {
				*dst += *p
			}
		}
		add(&rd, g.DiskReadBps)
		add(&wr, g.DiskWriteBps)
		add(&rx, g.NetRxBps)
		add(&tx, g.NetTxBps)
	}
	al.DiskIOMBs = IOSplit{Total: r1((rd + wr) / 1e6), Read: r1(rd / 1e6), Write: r1(wr / 1e6)}
	al.NetworkMbps = NetSplit{Total: r1((rx + tx) * 8 / 1e6), RX: r1(rx * 8 / 1e6), TX: r1(tx * 8 / 1e6)}
	return v
}

// platformBlock summarizes a set of guests of one platform.
func platformBlock(r *proto.Report, guests []proto.PlatformGuest, now time.Time, limit int) *PlatformBlock {
	b := &PlatformBlock{Guests: []Guest{}}
	threads := float64(rules.HostThreads(r))
	var cores, mem float64
	var all []Guest
	for _, pg := range guests {
		b.Total++
		switch pg.State {
		case proto.StateRunning:
			b.Running++
		case proto.StateUnhealthy:
			b.Unhealthy++
		case proto.StatePaused:
			b.Paused++
		default:
			b.Stopped++
		}
		if pg.State != proto.StateStopped {
			if pg.CPUPct != nil && !math.IsNaN(*pg.CPUPct) {
				switch {
				case pg.Platform == proto.PlatformDocker:
					cores += *pg.CPUPct / 100
				case pg.VCPU > 0:
					cores += *pg.CPUPct / 100 * float64(pg.VCPU)
				default:
					cores += *pg.CPUPct / 100 * threads
				}
			}
			if pg.MemUsedBytes != nil {
				mem += float64(*pg.MemUsedBytes)
			}
		}
		all = append(all, BuildGuest(pg, now))
	}
	if threads > 0 {
		b.CPUPct = r1(cores / threads * 100)
	}
	b.MemoryGB = r1(mem / rules.GiB)
	GuestSort(all, "cpu", true)
	if len(all) > limit {
		all = all[:limit]
	}
	if all != nil {
		b.Guests = all
	}
	b.GuestsShown = len(b.Guests)
	return b
}

func guestsOf(r *proto.Report, platform, kind string) []proto.PlatformGuest {
	var out []proto.PlatformGuest
	for _, g := range r.AllGuests() {
		if g.Platform == platform && (kind == "" || g.Kind == kind) {
			out = append(out, g)
		}
	}
	return out
}

func buildWorkloads(r *proto.Report, now time.Time, limit int, skipPVE bool) map[string]*PlatformBlock {
	w := map[string]*PlatformBlock{}
	add := func(key string, p *proto.Platform) {
		if p == nil {
			return
		}
		b := platformBlock(r, guestsOf(r, key, ""), now, limit)
		b.Version, b.Error, b.Warnings = strp(p.Version), strp(p.Error), buildWarnings(p)
		if key == proto.PlatformIncus {
			var ct, vm int
			for _, g := range p.Guests {
				if g.State == proto.StateRunning {
					if g.Kind == "vm" {
						vm++
					} else {
						ct++
					}
				}
			}
			b.Containers, b.VMs = &ct, &vm
		}
		w[key] = b
	}
	add(proto.PlatformDocker, r.Docker)
	add(proto.PlatformIncus, r.Incus)
	add(proto.PlatformLibvirt, r.Libvirt)
	return w
}

func buildPVEGuests(r *proto.Report, now time.Time, limit int) *ProxmoxGuest {
	vm := platformBlock(r, guestsOf(r, proto.PlatformPVE, "vm"), now, limit)
	ct := platformBlock(r, guestsOf(r, proto.PlatformPVE, "container"), now, limit)
	if r.PVE != nil {
		vm.Version, ct.Version = strp(r.PVE.Version), strp(r.PVE.Version)
		vm.Error, ct.Error = strp(r.PVE.Error), strp(r.PVE.Error)
	}
	return &ProxmoxGuest{VM: vm, Container: ct}
}

// ClusterNote is shown under the node table when some nodes have no agent.
const ClusterNote = "Other nodes report CPU, memory and guest counts through the cluster API. Enroll an agent to add temperatures, disk wear and history."

func buildCluster(r *proto.Report, agents map[string]NodeAgent) *Cluster {
	p := r.PVE
	if p == nil || p.Cluster == nil {
		return nil
	}
	c := &Cluster{Name: p.Cluster.Name, Quorate: p.Cluster.Quorate, Nodes: []ClusterNode{}}
	c.Votes.Have, c.Votes.Expected = p.Cluster.VotesHave, p.Cluster.VotesExpected
	c.HA.ResourcesStarted, c.HA.ResourcesTotal = p.HAResourcesStarted, p.HAResourcesTotal
	missing := false
	for _, n := range p.Nodes {
		cn := ClusterNode{Name: n.Name, ThisNode: n.ThisNode, Status: "offline", CPUPct: r1(n.CPUPct),
			MemPct: r1(n.MemPct), VMs: n.VMs, Containers: n.Containers, Agent: "not_enrolled"}
		if n.Online {
			cn.Status = "online"
		}
		if a, ok := agents[n.Name]; ok {
			cn.ServerID = strp(a.ServerID)
			cn.Agent = "offline"
			if a.Connected {
				cn.Agent = "connected"
			}
		} else {
			missing = true
		}
		c.Nodes = append(c.Nodes, cn)
	}
	if missing {
		c.Note = ptr(ClusterNote)
	}
	return c
}

var contentWords = map[string]string{
	"images":   "VM",
	"rootdir":  "container",
	"iso":      "ISO images",
	"vztmpl":   "templates",
	"backup":   "Backups",
	"snippets": "snippets",
	"import":   "imports",
}

// StorageContent turns a raw Proxmox content list into the display line
// ("images,rootdir" + "rpool mirror" -> "VM and container disks · rpool mirror").
func StorageContent(raw, detail string) (string, []string) {
	types := []string{}
	for _, t := range strings.Split(raw, ",") {
		if t = strings.TrimSpace(t); t != "" {
			types = append(types, t)
		}
	}
	has := map[string]bool{}
	for _, t := range types {
		has[t] = true
	}
	var parts []string
	switch {
	case has["images"] && has["rootdir"]:
		parts = append(parts, "VM and container disks")
	case has["images"]:
		parts = append(parts, "VM disks")
	case has["rootdir"]:
		parts = append(parts, "Container disks")
	}
	var rest []string
	for _, t := range types {
		if t == "images" || t == "rootdir" {
			continue
		}
		w, ok := contentWords[t]
		if !ok {
			w = t
		}
		rest = append(rest, w)
	}
	if len(rest) > 0 {
		s := strings.Join(rest, ", ")
		if len(rest) > 1 {
			s = strings.Join(rest[:len(rest)-1], ", ") + " and " + rest[len(rest)-1]
		}
		parts = append(parts, s)
	}
	text := strings.Join(parts, ", ")
	if text != "" {
		text = strings.ToUpper(text[:1]) + text[1:]
	}
	if detail != "" {
		if text != "" {
			text += " · "
		}
		text += detail
	}
	return text, types
}

func buildStorages(r *proto.Report) []Storage {
	out := []Storage{}
	if r.PVE == nil {
		return out
	}
	for _, s := range r.PVE.Storages {
		content, types := StorageContent(s.Content, s.Detail)
		st := Storage{ID: s.ID, Type: s.Type, Content: content, ContentTypes: types,
			UsedGB: r1(float64(s.UsedBytes) / rules.GB), CapacityGB: r1(float64(s.TotalBytes) / rules.GB),
			Shared: s.Shared, Active: s.Active}
		if s.TotalBytes > 0 {
			st.UsedPct = r1(float64(s.UsedBytes) / float64(s.TotalBytes) * 100)
		}
		out = append(out, st)
	}
	return out
}

func buildBackups(r *proto.Report) *Backups {
	if r.PVE == nil || r.PVE.Backups == nil {
		return nil
	}
	b := r.PVE.Backups
	out := &Backups{Target: strp(b.Target)}
	if b.NextRun != nil {
		out.NextRun = T(*b.NextRun)
	}
	if j := b.LastJob; j != nil {
		bj := &BackupJob{At: Time(j.At), Schedule: j.Schedule, Mode: j.Mode, Result: j.Result, GuestsOK: j.GuestsOK,
			GuestsTotal: j.GuestsTotal, Warnings: j.Warnings, WrittenGB: r1(float64(j.WrittenBytes) / rules.GB),
			DedupRatio: f1p(j.DedupRatio), DurationMin: int(math.Round(float64(j.DurationS) / 60))}
		if j.AvgDurationWeek != nil {
			bj.AvgDurationMinWeek = ptr(int(math.Round(float64(*j.AvgDurationWeek) / 60)))
		}
		out.LastJob = bj
	}
	return out
}
