package model

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"rackoon/internal/hub/fakefleet"
	"rackoon/internal/proto"
	"rackoon/internal/rules"
)

var asOf = fakefleet.Ref

// fixtureStates builds the fixture fleet: every host reports its fixture
// values, marble went silent at 02:14, and the three fixture alerts are open.
func fixtureStates(t *testing.T) []*ServerState {
	t.Helper()
	var out []*ServerState
	for _, h := range fakefleet.Fleet() {
		h.Exact = true
		r := h.Report(asOf, 1, "0.14.2")
		st := &ServerState{ID: h.ID, Hostname: h.ID, Group: h.Group, Location: h.Location, Report: r,
			ReportAt: asOf.Add(-8 * time.Second), LastSeen: asOf.Add(-8 * time.Second), Connected: true, AgentVersion: "0.14.2"}
		if h.ID == "marble" {
			st.LastSeen = time.Date(2026, 10, 11, 2, 14, 0, 0, time.UTC)
			st.ReportAt = st.LastSeen
			st.Connected = false
		}
		out = append(out, st)
	}
	eng := rules.NewEngine()
	for _, st := range out {
		if st.ID == "marble" {
			c, _ := rules.HeartbeatCondition(st.LastSeen, asOf)
			eng.Evaluate(st.ID, []rules.Condition{c}, func(r string) bool { return r == rules.RuleHeartbeatMissing }, asOf)
			continue
		}
		conds := rules.HostConditions(st.Report)
		notHB := func(r string) bool { return r != rules.RuleHeartbeatMissing }
		// Let duration-based rules fire: evaluate 15 minutes ago and now.
		eng.Evaluate(st.ID, conds, notHB, asOf.Add(-15*time.Minute))
		eng.Evaluate(st.ID, conds, notHB, asOf)
		st.Open = eng.Open(st.ID)
	}
	for _, st := range out {
		st.Open = eng.Open(st.ID)
	}
	return out
}

func approx(t *testing.T, name string, got, want, tol float64) {
	t.Helper()
	if math.Abs(got-want) > tol {
		t.Errorf("%s = %v, want %v (±%v)", name, got, want, tol)
	}
}

func TestFleetKPIsFromFixtureFleet(t *testing.T) {
	f := BuildFleet(fixtureStates(t), "All", asOf, 0, "0.14.2")
	k := f.KPIs
	if k.ServersOnline != 7 || k.ServersTotal != 8 {
		t.Errorf("online %d / %d, want 7 / 8", k.ServersOnline, k.ServersTotal)
	}
	// CPU average = mean of the 7 online servers' cpu_pct.
	approx(t, "cpu_avg_pct", *k.CPUAvgPct, (34+22+47+12+71+18+29)/7.0, 0.05)
	approx(t, "memory_total_gb", k.MemoryTotalGB, 784, 0.01)
	approx(t, "memory_used_gb", k.MemoryUsedGB, 506, 1)
	approx(t, "memory_pct", *k.MemoryPct, k.MemoryUsedGB/k.MemoryTotalGB*100, 0.1)
	approx(t, "storage_total_tb", k.StorageTotalTB, 100, 0.01)
	approx(t, "storage_used_tb", k.StorageUsedTB, 62.2, 0.1) // fixture rounds per-server percentages
	if k.DisksOver75Wear != 1 {
		t.Errorf("disks over 75%% wear = %d", k.DisksOver75Wear)
	}
	if k.OpenAlerts != 3 || k.OpenAlertsCritical != 1 || k.OpenAlertsWarning != 2 {
		t.Errorf("alerts %d (%d critical, %d warning)", k.OpenAlerts, k.OpenAlertsCritical, k.OpenAlertsWarning)
	}
	if f.AgentsConnected != 7 {
		t.Errorf("agents connected = %d", f.AgentsConnected)
	}
	wantGroups := []GroupCount{{"All", 8}, {"Production", 4}, {"Lab", 2}, {"Edge", 2}}
	for i, g := range wantGroups {
		if i >= len(f.Groups) || f.Groups[i] != g {
			t.Errorf("groups = %+v", f.Groups)
			break
		}
	}
	// Needs attention: marble critical first, then basalt wear, then shale temp.
	var titles []string
	for _, a := range f.Alerts {
		titles = append(titles, a.Server+": "+a.Title)
	}
	want := []string{"marble: Whombat’s helper isn’t checking in", "basalt: Disk nvme1n1 is 78% worn out", "shale: CPU package at 83 °C"}
	if strings.Join(titles, "|") != strings.Join(want, "|") {
		t.Errorf("alerts = %v", titles)
	}
	if f.Alerts[0].Detail != "Nothing heard from it for 11 h 46 m" || f.Alerts[1].Detail != "936 of the 1,200 TB it’s built to write" {
		t.Errorf("details = %q / %q", f.Alerts[0].Detail, f.Alerts[1].Detail)
	}

	ps := f.PlatformSummary
	if ps.Docker.Running != 67 || ps.Docker.Stopped != 9 || ps.Docker.Unhealthy != 2 {
		t.Errorf("docker = %+v", ps.Docker)
	}
	if ps.Incus.ContainersRunning != 15 || ps.Incus.VMsRunning != 7 || ps.Incus.Stopped != 4 {
		t.Errorf("incus = %+v", ps.Incus)
	}
	if ps.QEMU.Running != 24 || ps.QEMU.Stopped != 6 || ps.QEMU.ProxmoxVMsRunning != 18 || ps.QEMU.LibvirtVMsRunning != 6 {
		t.Errorf("qemu = %+v", ps.QEMU)
	}
	if ps.QEMU.LibvirtServers != 3 || ps.QEMU.ProxmoxServers != 1 {
		t.Errorf("qemu servers = %+v", ps.QEMU)
	}
	tops := map[string][]TopGuest{"docker": f.TopGuestsByCPU.Docker, "incus": f.TopGuestsByCPU.Incus, "qemu": f.TopGuestsByCPU.QEMU}
	wantTop := map[string][]string{
		"docker": {"postgres-main@granite", "immich-ml@obsidian", "jellyfin@onyx", "prometheus@basalt", "gitlab@granite"},
		"incus":  {"ci-runner-03@obsidian", "nixbuild@basalt", "build-cache@obsidian", "ci-runner@basalt", "win-dev@obsidian"},
		"qemu":   {"k3s-node-2@shale", "win-build@shale", "k3s-node-1@shale", "postgres-prod@shale", "opnsense@basalt"},
	}
	for k, list := range tops {
		var got []string
		for _, g := range list {
			got = append(got, g.Name+"@"+g.Server)
		}
		if strings.Join(got, ",") != strings.Join(wantTop[k], ",") {
			t.Errorf("top %s = %v", k, got)
		}
	}

	byID := map[string]FleetServer{}
	for _, s := range f.Servers {
		byID[s.ID] = s
	}
	b := byID["basalt"]
	if b.Status != "warning" || *b.StatusNote != "disk wear" || *b.OS != "NixOS 26.05" || b.DetailView != "incus" {
		t.Errorf("basalt card = %s %v %v", b.Status, *b.StatusNote, *b.OS)
	}
	if b.Current == nil || *b.Current.CPUPct != 34 || *b.Current.MemPct != 60.9 || *b.Current.TempMaxC != 64 ||
		*b.Current.TempLimitC != 85 || *b.Current.DiskUsedPct != 63.8 || *b.Current.DiskWearMaxPct != 78 {
		t.Errorf("basalt current = %+v", b.Current)
	}
	if b.Workloads.Docker != (DockerCounts{14, 2, 0}) || b.Workloads.Incus != (IncusCounts{4, 2, 1}) || b.Workloads.QEMU != (QEMUCounts{3, 1}) {
		t.Errorf("basalt workloads = %+v", b.Workloads)
	}
	h := b.Hypervisor
	if h == nil || h.VCPUAllocated != 22 || h.VCPUOvercommitRatio != 0.46 || h.HostThreads != 48 || h.VMs != 5 || h.Containers != 4 ||
		strings.Join(h.Stacks, ",") != "incus,libvirt" || !h.KVMEnabled {
		t.Errorf("basalt hypervisor = %+v", h)
	}
	s := byID["shale"]
	if s.Status != "warning" || *s.StatusNote != "CPU temperature" || s.DetailView != "proxmox" {
		t.Errorf("shale card = %s %v %s", s.Status, *s.StatusNote, s.DetailView)
	}
	if s.Hypervisor.VCPUAllocated != 52 || s.Hypervisor.VCPUOvercommitRatio != 1.63 ||
		s.Hypervisor.GuestMemoryAssignedGB != 158 || s.Hypervisor.GuestMemoryAssignedPct != 82.3 ||
		strings.Join(s.Hypervisor.Stacks, ",") != "proxmox" || s.Hypervisor.VMs != 18 || s.Hypervisor.Containers != 4 {
		t.Errorf("shale hypervisor = %+v", s.Hypervisor)
	}
	if s.Workloads.QEMU != (QEMUCounts{18, 4}) {
		t.Errorf("shale qemu = %+v", s.Workloads.QEMU)
	}
	if byID["granite"].Hypervisor != nil {
		t.Error("granite has no hypervisor")
	}
	m := byID["marble"]
	if m.Status != "offline" || *m.StatusNote != "not checking in" || m.Current != nil || m.LastKnown == nil ||
		*m.LastKnown.CPUPct != 9 || *m.LastKnown.DiskUsedPct != 46 || m.Hypervisor != nil ||
		m.Workloads != (FleetWorkloads{}) {
		t.Errorf("marble card = %+v", m)
	}
}

func TestFleetLabGroup(t *testing.T) {
	f := BuildFleet(fixtureStates(t), "Lab", asOf, 0, "0.14.2")
	k := f.KPIs
	if len(f.Servers) != 2 || f.Servers[0].ID != "quartz" || f.Servers[1].ID != "onyx" || f.AgentsConnected != 2 {
		t.Fatalf("servers = %d", len(f.Servers))
	}
	if k.ServersOnline != 2 || k.ServersTotal != 2 || k.OpenAlerts != 0 || k.DisksOver75Wear != 0 {
		t.Errorf("kpis = %+v", k)
	}
	approx(t, "cpu", *k.CPUAvgPct, 20.5, 0.05)
	approx(t, "memory_pct", *k.MemoryPct, 47, 0.5)
	approx(t, "memory_used_gb", k.MemoryUsedGB, 60, 0.5)
	approx(t, "memory_total_gb", k.MemoryTotalGB, 128, 0.01)
	approx(t, "storage_used_tb", k.StorageUsedTB, 14.6, 0.01)
	approx(t, "storage_total_tb", k.StorageTotalTB, 20, 0.01)
	if len(f.Alerts) != 0 {
		t.Error("Lab has no alerts")
	}
	if len(f.Groups) != 4 {
		t.Error("groups are always the full list")
	}
}

// keys collects the key paths of a JSON document (arrays: union over
// elements, path segment "[]").
func keys(v any, prefix string, out map[string]bool) {
	switch x := v.(type) {
	case map[string]any:
		for k, vv := range x {
			if k == "_note" {
				continue
			}
			p := prefix + "." + k
			out[p] = true
			keys(vv, p, out)
		}
	case []any:
		for _, vv := range x {
			keys(vv, prefix+"[]", out)
		}
	}
}

func fixture(t *testing.T, name string) map[string]any {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("..", "..", "..", "docs", "handoff", "sample-data", name))
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	return m
}

func roundTrip(t *testing.T, v any) map[string]any {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	return m
}

// assertShape checks that every key of the fixture exists in our output
// (our output may add keys, documented in docs/CONTRACT.md).
func assertShape(t *testing.T, fixtureName string, got map[string]any, ignore ...string) {
	t.Helper()
	want, have := map[string]bool{}, map[string]bool{}
	keys(fixture(t, fixtureName), "", want)
	keys(got, "", have)
	var missing []string
outer:
	for k := range want {
		for _, ig := range ignore {
			if strings.HasPrefix(k, ig) {
				continue outer
			}
		}
		if !have[k] {
			missing = append(missing, k)
		}
	}
	sort.Strings(missing)
	if len(missing) > 0 {
		t.Errorf("%s: keys missing from the API output:\n  %s", fixtureName, strings.Join(missing, "\n  "))
	}
}

func TestFleetShapeMatchesFixture(t *testing.T) {
	assertShape(t, "fleet.json", roundTrip(t, BuildFleet(fixtureStates(t), "All", asOf, 0, "0.14.2")))
}

func stateByID(t *testing.T, id string) *ServerState {
	for _, s := range fixtureStates(t) {
		if s.ID == id {
			return s
		}
	}
	t.Fatal("no " + id)
	return nil
}

func TestBasaltDetail(t *testing.T) {
	st := stateByID(t, "basalt")
	max := map[string]*float64{"temp_cpu_package_c": ptr(79.0), "temp_board_vrm_c": ptr(61.0)}
	d := BuildDetail(st, asOf, DetailInput{Range: "24h", SensorMax: max, RoleRank: 2})
	got := roundTrip(t, d)
	assertShape(t, "server-basalt.json", got)
	if d.Banner == nil || d.Banner.Title != "Disk nvme1n1 is 78% worn out" || d.Banner.Detail != "936 of the 1,200 TB it’s built to write. Plan to replace it." ||
		*d.Banner.Link != "#storage" || d.Banner.Severity != "warning" {
		t.Errorf("banner = %+v", d.Banner)
	}
	sv := d.Server
	if sv.OS.Name != "NixOS" || sv.OS.Version != "26.05" || sv.OS.Kernel != "6.18.44" || *sv.UptimeS != 3567600 ||
		*sv.Address != "10.20.0.11" || *sv.Location != "Rack A · unit 4" || *sv.Agent.Version != "0.14.2" ||
		*sv.Agent.LastSyncSAgo != 8 || sv.Memory.TotalGB != 256 || *sv.Memory.Type != "DDR4 ECC" || sv.OpenAlerts != 1 {
		t.Errorf("server = %+v", sv)
	}
	if len(sv.Roles) != 1 || sv.Roles[0] != "kvm-host" {
		t.Errorf("roles = %v", sv.Roles)
	}
	// Remote control is off by default (hub toggles false).
	if sv.RemoteControl.Console || *sv.RemoteControl.ConsoleReason != ReasonHubConsole || !sv.RemoteControl.AgentConsole {
		t.Errorf("remote control = %+v", sv.RemoteControl)
	}
	l := d.Live
	if l.CPUPct != 34 || l.CPUUserPct != 22.4 || l.MemUsedGB != 156 || *l.MemCacheGB != 71 || l.MemFreeGB != 29 ||
		l.SwapTotalGB != 16 || l.ZFSARCGB != nil || l.LoadAvg != [3]float64{6.2, 5.8, 5.3} {
		t.Errorf("live = %+v", l)
	}
	if len(d.Sensors) != 5 || d.Sensors[0].ID != "cpu_package" || *d.Sensors[0].Max24hC != 79 || *d.Sensors[0].NowC != 64 ||
		d.Sensors[0].LimitC != 85 || *d.Sensors[2].Max24hC != 49 {
		t.Errorf("sensors = %+v", d.Sensors)
	}
	disks := d.Disks.([]Disk)
	n1 := disks[1]
	if n1.Device != "nvme1n1" || n1.Health != "wear_high" || *n1.WearPct != 78 || *n1.WrittenTB != 936 || *n1.RatedTBW != 1200 ||
		n1.CapacityGB != 2000 || *n1.UsedGB != 1420 || *n1.PowerOnHours != 14210 {
		t.Errorf("nvme1n1 = %+v", n1)
	}
	if disks[2].WearPct != nil || disks[2].WrittenTB != nil || disks[2].Smart.Reallocated == nil || disks[2].Health != "healthy" {
		t.Errorf("sda = %+v", disks[2])
	}
	v := d.Virtualization
	if v.Allocation.VCPUAllocated != 22 || v.Allocation.VCPUOvercommitRatio != 0.46 || v.Allocation.HostThreads != 48 ||
		v.Allocation.GuestMemoryAssignedGB != 44 || v.Capabilities.Hugepages == nil || v.Capabilities.Hugepages.ReservedGB != 32 ||
		v.Capabilities.Hugepages.PageSize != "1G" || v.Capabilities.KSM.SavedGB != 3.1 || v.Capabilities.IOMMU.Groups != 14 {
		t.Errorf("virtualization = %+v", v)
	}
	// Disk I/O and network are summed over running guests (MB/s, Mb/s).
	approx(t, "disk io read", v.Allocation.DiskIOMBs.Read, 42+8+1+0.2+0.1+0+2+28+0.4, 0.2)
	w := d.Workloads
	if w["docker"].Running != 14 || w["docker"].Total != 16 || w["incus"].Running != 6 || w["incus"].Total != 7 ||
		*w["incus"].Containers != 4 || *w["incus"].VMs != 2 || w["libvirt"].Running != 3 || w["libvirt"].Total != 4 {
		t.Errorf("workloads = docker %+v incus %+v libvirt %+v", w["docker"], w["incus"], w["libvirt"])
	}
	if _, ok := got["storages"]; ok {
		t.Error("standard view must not have storages")
	}
	g := w["incus"].Guests[0]
	if g.ID != "incus:nixbuild" || *g.VCPU != 8 || *g.CPUPct != 21.5 || *g.MemoryUsedMB != 10035 || *g.MemoryLimitMB != 16384 ||
		*g.DiskReadMBs != 42 || *g.NetRxMbps != 12 || *g.Snapshots != 3 || *g.UptimeS != 518400 ||
		*g.Console.DefaultProtocol != "spice" || *g.Console.Resolution != "1280x800" {
		t.Errorf("nixbuild = %+v", g)
	}
	last := w["incus"].Guests[len(w["incus"].Guests)-1]
	if last.Name != "scratch" || last.CPUPct != nil || last.Console.Resolution != nil || !last.Console.Available {
		t.Errorf("stopped guest = %+v", last)
	}
}

func TestShaleProxmoxDetail(t *testing.T) {
	st := stateByID(t, "shale")
	agents := map[string]NodeAgent{"shale": {ServerID: "shale", Connected: true}}
	d := BuildDetail(st, asOf, DetailInput{Range: "24h", RoleRank: 1, NodeAgents: agents, GuestLimit: 8})
	got := roundTrip(t, d)
	// Proxmox guests: the fixture's container block has no guests_shown; we add it.
	assertShape(t, "server-shale-proxmox.json", got)
	if _, ok := got["workloads"]; ok {
		t.Error("proxmox view must not have workloads")
	}
	if d.Banner == nil || d.Banner.Title != "CPU package is at 83 °C" || *d.Banner.Link != "#temps" {
		t.Errorf("banner = %+v", d.Banner)
	}
	if d.Live.ZFSARCGB == nil || *d.Live.ZFSARCGB != 22 || d.Live.MemUsedGB != 159 || d.Live.MemFreeGB != 11 {
		t.Errorf("live = %+v", d.Live)
	}
	if d.Server.OS.Name != "Proxmox VE" || strings.Join(d.Server.Roles, ",") != "kvm-host,proxmox-node" || d.Server.DetailView != "proxmox" {
		t.Errorf("server = %+v", d.Server)
	}
	c := d.Cluster
	if c == nil || c.Name != "prod-pve" || !c.Quorate || c.Votes.Have != 3 || c.HA.ResourcesStarted != 6 || len(c.Nodes) != 3 ||
		c.Nodes[0].Agent != "connected" || c.Nodes[1].Agent != "not_enrolled" || c.Note == nil {
		t.Errorf("cluster = %+v", c)
	}
	if len(d.Storages) != 5 || d.Storages[0].Content != "ISO images and templates · on rpool" ||
		d.Storages[1].Content != "VM and container disks · rpool mirror" || d.Storages[4].Content != "Backups · Proxmox Backup Server" ||
		d.Storages[2].UsedGB != 3190 || d.Storages[2].CapacityGB != 3840 {
		t.Errorf("storages = %+v", d.Storages)
	}
	b := d.Backups.LastJob
	if b == nil || b.GuestsOK != 22 || b.WrittenGB != 412 || *b.DedupRatio != 6.8 || b.DurationMin != 38 || *b.AvgDurationMinWeek != 41 {
		t.Errorf("backups = %+v", d.Backups)
	}
	vm := d.Guests.VM
	if vm.Running != 18 || vm.Total != 22 || vm.GuestsShown != 8 || vm.Guests[0].Name != "k3s-node-2" || *vm.Guests[0].VMID != 100 ||
		*vm.Guests[0].Node != "shale" || vm.Guests[0].LastBackup == nil {
		t.Errorf("vm block = %+v", vm)
	}
	if d.Guests.Container.Running != 4 || d.Guests.Container.Total != 4 {
		t.Errorf("container block = %+v", d.Guests.Container)
	}
	bal := d.Virtualization.Capabilities.Ballooning
	if bal.State != "active" || bal.VMsActive != 14 || bal.VMsTotal != 18 || d.Virtualization.Capabilities.Hugepages != nil {
		t.Errorf("ballooning = %+v", bal)
	}
	if d.Virtualization.Allocation.VCPUOvercommitRatio != 1.63 || d.Virtualization.Allocation.GuestMemoryAssignedGB != 158 {
		t.Errorf("allocation = %+v", d.Virtualization.Allocation)
	}
	pd := d.Disks.([]PVEDisk)
	if len(pd) != 6 || *pd[0].Pool != "rpool" || *pd[2].WearPct != 22 {
		t.Errorf("pve disks = %+v", pd)
	}
	// Operator but remote control off on the hub.
	if d.Server.RemoteControl.Console || *d.Server.RemoteControl.ConsoleReason != ReasonHubConsole {
		t.Errorf("rc = %+v", d.Server.RemoteControl)
	}
}

func TestOfflineDetailAndPerms(t *testing.T) {
	st := stateByID(t, "marble")
	d := BuildDetail(st, asOf, DetailInput{Range: "24h", RoleRank: 0})
	if d.Server.Status != "offline" || d.Live == nil || d.Live.AsOf == nil || d.Server.UptimeS != nil || d.Banner == nil || d.Banner.Title != "Whombat’s helper isn’t checking in" {
		t.Errorf("offline detail: status=%s live=%v banner=%+v", d.Server.Status, d.Live, d.Banner)
	}
	if *d.Server.RemoteControl.ConsoleReason != ReasonRole {
		t.Errorf("viewer reason = %v", *d.Server.RemoteControl.ConsoleReason)
	}
	ok := &ServerState{RCConsole: true, RCPower: false, Report: &proto.Report{Policy: proto.Policy{Console: true, Power: true}}}
	p := Perms(ok, 1)
	if !p.Console || p.Power || *p.PowerReason != ReasonHubPower || p.ConsoleReason != nil {
		t.Errorf("perms = %+v", p)
	}
	ok.Report.Policy.Console = false
	if p := Perms(ok, 2); p.Console || *p.ConsoleReason != ReasonAgent {
		t.Errorf("agent-off perms = %+v", p)
	}
}

func TestSearchGuestsAcrossServers(t *testing.T) {
	states := fixtureStates(t)
	// Without a query: every guest of every server, offline ones (marble)
	// from their last report, 100 per page.
	all := SearchGuests(states, FleetGuestQuery{}, asOf)
	if all.Total != 141 || len(all.Items) != 100 || all.NextCursor == nil {
		t.Fatalf("all: total %d, %d items, cursor %v", all.Total, len(all.Items), all.NextCursor)
	}
	if all.Counts != (GuestCounts{All: 141, Running: 120, Stopped: 19, Unhealthy: 2}) {
		t.Errorf("counts = %+v", all.Counts)
	}
	if p := all.Platforms; len(p) != 4 || p["docker"] != 81 || p["incus"] != 26 || p["libvirt"] != 8 || p["pve"] != 26 {
		t.Errorf("platforms = %v", p)
	}
	// Default order: running first by CPU.
	if g := all.Items[0]; g.Server != "shale" || g.Name != "k3s-node-2" || !g.ServerOnline {
		t.Errorf("first = %+v", g)
	}
	page2 := SearchGuests(states, FleetGuestQuery{Cursor: *all.NextCursor}, asOf)
	if page2.Total != 141 || len(page2.Items) != 41 || page2.NextCursor != nil {
		t.Fatalf("page 2: total %d, %d items, cursor %v", page2.Total, len(page2.Items), page2.NextCursor)
	}
	var marble int
	for _, g := range append(all.Items, page2.Items...) {
		if g.Server == "marble" {
			marble++
			if g.ServerOnline {
				t.Errorf("marble is offline: %+v", g)
			}
		}
	}
	if marble != 3 {
		t.Errorf("marble guests = %d", marble)
	}
	// State, platform and kind filters narrow the list but not the counts.
	st := SearchGuests(states, FleetGuestQuery{State: "stopped"}, asOf)
	if st.Total != 19 || len(st.Items) != 19 || st.Counts.All != 141 || st.Platforms["pve"] != 26 {
		t.Errorf("stopped: total %d, %d items, counts %+v", st.Total, len(st.Items), st.Counts)
	}
	for _, g := range st.Items {
		if g.State != "stopped" {
			t.Errorf("stopped filter let %s/%s (%s) through", g.Server, g.ID, g.State)
		}
	}
	ct := SearchGuests(states, FleetGuestQuery{Platform: "pve", Kind: "container"}, asOf)
	if ct.Total != 4 || ct.Counts.All != 141 || ct.Items[0].Name != "grafana-ct" || ct.Items[3].Name != "pihole" {
		t.Errorf("pve containers = %+v", ct)
	}
	// The server filter also scopes the counts.
	srv := SearchGuests(states, FleetGuestQuery{Server: "onyx"}, asOf)
	if srv.Total != 20 || srv.Counts != (GuestCounts{All: 20, Running: 16, Stopped: 3, Unhealthy: 1}) ||
		len(srv.Platforms) != 3 || srv.Platforms["docker"] != 14 || srv.Platforms["incus"] != 4 || srv.Platforms["libvirt"] != 2 {
		t.Errorf("onyx: total %d, counts %+v, platforms %v", srv.Total, srv.Counts, srv.Platforms)
	}
	if none := SearchGuests(states, FleetGuestQuery{Server: "nope"}, asOf); none.Total != 0 || none.Counts.All != 0 || none.Items == nil || none.Platforms == nil {
		t.Errorf("unknown server = %+v", none)
	}
	// Query ranking: exact name, then name prefix (another server), then
	// image-only matches.
	r := SearchGuests(states, FleetGuestQuery{Q: " GRAFANA "}, asOf)
	if r.Total < 3 || len(r.Items) != r.Total || r.Counts.All != r.Total {
		t.Fatalf("grafana: total %d, %d items, counts %+v", r.Total, len(r.Items), r.Counts)
	}
	if a, b := r.Items[0], r.Items[1]; a.Server != "basalt" || a.ID != "docker:grafana" || a.Platform != "docker" || a.State != "running" ||
		b.Server != "shale" || b.Name != "grafana-ct" || b.ID != "pve:200" || b.Kind != "container" {
		t.Errorf("grafana order = %+v", r.Items[:2])
	}
	var loki bool
	for _, h := range r.Items[2:] {
		loki = loki || h.Name == "loki" // image grafana/loki
	}
	if !loki {
		t.Errorf("image match missing: %+v", r.Items)
	}
	// Same name on two servers: the sort key (CPU: onyx 7%, basalt 5.4%)
	// orders within a rank and the server id breaks ties; the prefix match
	// comes after both.
	h := SearchGuests(states, FleetGuestQuery{Q: "haos"}, asOf)
	if h.Total != 3 || h.Items[0].Server != "onyx" || h.Items[1].Server != "basalt" || h.Items[2].Name != "haos-prod" {
		t.Errorf("haos = %+v", h.Items)
	}
	if hn := SearchGuests(states, FleetGuestQuery{Q: "haos", Sort: "name"}, asOf); hn.Items[0].Server != "basalt" || hn.Items[1].Server != "onyx" || hn.Items[2].Name != "haos-prod" {
		t.Errorf("haos by name = %+v", hn.Items)
	}
	if l := SearchGuests(states, FleetGuestQuery{Q: "haos", Limit: 1}, asOf); l.Total != 3 || len(l.Items) != 1 || l.Items[0].Server != "onyx" || l.NextCursor == nil {
		t.Errorf("haos limit 1 = %+v", l)
	}
	// sort=server groups by server (descending here), running first within.
	bs := SearchGuests(states, FleetGuestQuery{Sort: "-server", Limit: 30}, asOf)
	if bs.Items[0].Server != "shale" || bs.Items[0].Name != "k3s-node-2" || bs.Items[26].Server != "quartz" {
		t.Errorf("by server = %s/%s, [26] %s", bs.Items[0].Server, bs.Items[0].Name, bs.Items[26].Server)
	}
	// JSON: server and server_online first, then the guest object as is.
	b, _ := json.Marshal(SearchGuests(states, FleetGuestQuery{Q: "nixbuild"}, asOf))
	want := `{"guests":[{"server":"basalt","server_online":true,"id":"incus:nixbuild","name":"nixbuild","platform":"incus","kind":"vm","image":"nixos/26.05","state":"running","vcpu":8,"cpu_pct":21.5,"memory_used_mb":10035,"memory_limit_mb":16384,"disk_read_mbs":42,"disk_write_mbs":118,"net_rx_mbps":12,"net_tx_mbps":4,"snapshots":3,"uptime_s":518400,"console":{"available":true,"protocols":["spice","serial"],"default_protocol":"spice","resolution":"1280x800"}}],"total":1,"next_cursor":null,"counts":{"all":1,"running":1,"stopped":0,"unhealthy":0},"platforms":{"incus":1},"tags":{}}`
	if string(b) != want {
		t.Errorf("json = %s", b)
	}
}

func TestGuestListFilterSortPage(t *testing.T) {
	st := stateByID(t, "basalt")
	l := ListGuests(st.Report, GuestListQuery{Platform: "docker", Limit: 5}, asOf)
	if l.Total != 16 || len(l.Items) != 5 || l.NextCursor == nil || l.Items[0].Name != "prometheus" {
		t.Fatalf("page 1 = total %d items %d", l.Total, len(l.Items))
	}
	l2 := ListGuests(st.Report, GuestListQuery{Platform: "docker", Limit: 50, Cursor: *l.NextCursor}, asOf)
	if len(l2.Items) != 11 || l2.NextCursor != nil {
		t.Fatalf("page 2 = %d", len(l2.Items))
	}
	if last := l2.Items[len(l2.Items)-1]; last.State != "stopped" {
		t.Errorf("stopped guests sort last, got %s", last.State)
	}
	q := ListGuests(st.Report, GuestListQuery{Q: "NIX"}, asOf)
	if q.Total != 2 {
		t.Errorf("q=nix total = %d", q.Total)
	}
	n := ListGuests(st.Report, GuestListQuery{Platform: "libvirt", Sort: "name"}, asOf)
	if n.Items[0].Name != "haos" {
		t.Errorf("sort by name: %s", n.Items[0].Name)
	}
	b, _ := json.Marshal(l.Items[0])
	var m map[string]any
	json.Unmarshal(b, &m)
	if _, ok := m["vcpu"]; ok {
		t.Error("docker guests have no vcpu key")
	}
	if c, _ := m["console"].(map[string]any); len(c) != 1 || c["available"] != false {
		t.Errorf("docker console = %v", m["console"])
	}
}

func TestFleetAndDetailHints(t *testing.T) {
	states := fixtureStates(t)
	f := BuildFleet(states, "All", asOf, 0, "0.14.2")
	var got []string
	for _, h := range f.Hints {
		got = append(got, h.Severity+" "+h.Server+": "+h.Title)
	}
	want := []string{
		"warning obsidian: 1 app isn’t working properly",
		"warning onyx: 1 app isn’t working properly",
		"info basalt: CPU package at 64 °C",
		"info basalt: Disk sdb has had a few errors",
		"info obsidian: CPU package at 66 °C",
		"info onyx: Disk “media” 83% full",
		"info onyx: HDD, hottest at 41 °C",
		"info onyx: System disk 83% full",
		"info shale: Board / VRM at 66 °C",
		"info shale: NVMe, hottest at 56 °C",
		"info shale: Storage “vmdata” 83% full",
	}
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Errorf("fleet hints:\n%s", strings.Join(got, "\n"))
	}
	// shale's CPU at 83 °C is an open alert, not a hint.
	for _, h := range f.Hints {
		if h.Server == "shale" && h.Entity == proto.SensorCPU {
			t.Errorf("alerted sensor hinted: %+v", h)
		}
	}
	if b, _ := json.Marshal(f.Hints[0]); string(b) != `{"server":"obsidian","id":"guests.unhealthy:docker","kind":"guests.unhealthy","severity":"warning","entity":"docker","title":"1 app isn’t working properly","detail":"pihole","link":"#guests"}` {
		t.Errorf("hint json = %s", b)
	}
	// Group selection; a group of quiet or offline servers has an empty list.
	lab := BuildFleet(states, "Lab", asOf, 0, "0.14.2")
	if len(lab.Hints) != 4 || lab.Hints[0].Server != "onyx" || lab.Hints[0].Severity != "warning" {
		t.Errorf("lab hints = %+v", lab.Hints)
	}
	if edge := roundTrip(t, BuildFleet(states, "Edge", asOf, 0, "0.14.2")); len(edge["hints"].([]any)) != 0 {
		t.Errorf("edge hints = %v", edge["hints"])
	}
	// The detail carries the same hints for its host, plus agent.outdated
	// against the hub's version; an offline host has none.
	d := BuildDetail(stateByID(t, "shale"), asOf, DetailInput{Range: "24h", HubVersion: "0.15.0"})
	if n := len(d.Hints); n != 4 || d.Hints[0].Title != "Board / VRM at 66 °C" || d.Hints[0].Server != "shale" ||
		d.Hints[3].Kind != rules.HintAgentOutdated || d.Hints[3].Title != "Whombat’s helper on this server is out of date" || d.Hints[3].Detail != "It runs 0.14.2, Whombat 0.15.0." {
		t.Errorf("shale detail hints = %+v", d.Hints)
	}
	if m := roundTrip(t, BuildDetail(stateByID(t, "marble"), asOf, DetailInput{Range: "24h", HubVersion: "0.15.0"})); len(m["hints"].([]any)) != 0 {
		t.Errorf("marble hints = %v", m["hints"])
	}
}
