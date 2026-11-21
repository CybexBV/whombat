package rules

import (
	"testing"
	"time"

	"rackoon/internal/proto"
)

// Vectors from docs/handoff/docs/ACCEPTANCE.md section 7.

func TestTempLevel(t *testing.T) {
	cases := []struct {
		temp, limit float64
		want        Level
	}{
		{72.0, 85, Good}, {72.25, 85, Warning}, {84.9, 85, Warning}, {85.0, 85, Serious},
		{76.4, 90, Good}, {76.5, 90, Warning}, {90, 90, Serious},
		{100, 85, Serious}, {20, 0, Good},
	}
	for _, c := range cases {
		if got := TempLevel(c.temp, c.limit); got != c.want {
			t.Errorf("TempLevel(%v, %v) = %v, want %v", c.temp, c.limit, got, c.want)
		}
	}
}

func TestDiskUsedLevel(t *testing.T) {
	cases := map[float64]Level{79: Good, 79.9: Good, 80: Warning, 89: Warning, 89.9: Warning, 90: Serious, 100: Serious}
	for in, want := range cases {
		if got := DiskUsedLevel(in); got != want {
			t.Errorf("DiskUsedLevel(%v) = %v, want %v", in, got, want)
		}
	}
}

func TestWear(t *testing.T) {
	cases := []struct {
		pct      float64
		level    Level
		high     bool
		rule     string
		displays float64
	}{
		{74, Good, false, "", 74},
		{75, Warning, true, RuleWearHigh, 75},
		{89, Warning, true, RuleWearHigh, 89},
		{90, Serious, true, RuleWearCritical, 90},
		{100, Serious, true, RuleWearCritical, 100},
		{104, Serious, true, RuleWearCritical, 100},
	}
	for _, c := range cases {
		if got := WearLevel(c.pct); got != c.level {
			t.Errorf("WearLevel(%v) = %v, want %v", c.pct, got, c.level)
		}
		if got := WearHigh(c.pct); got != c.high {
			t.Errorf("WearHigh(%v) = %v", c.pct, got)
		}
		if got := WearDisplay(c.pct); got != c.displays {
			t.Errorf("WearDisplay(%v) = %v, want %v", c.pct, got, c.displays)
		}
		w := c.pct
		r := &proto.Report{Disks: []proto.Disk{{Device: "nvme1n1", Type: "nvme", WearPct: &w}}}
		conds := HostConditions(r)
		var rule string
		for _, cd := range conds {
			if cd.Rule == RuleWearHigh || cd.Rule == RuleWearCritical {
				rule = cd.Rule
			}
		}
		if rule != c.rule {
			t.Errorf("wear %v: rule %q, want %q", c.pct, rule, c.rule)
		}
	}
}

func TestMemAssignedLevel(t *testing.T) {
	cases := map[float64]Level{79: Good, 80: Warning, 89: Warning, 90: Serious}
	for in, want := range cases {
		if got := MemAssignedLevel(in); got != want {
			t.Errorf("MemAssignedLevel(%v) = %v, want %v", in, got, want)
		}
	}
}

func TestOvercommit(t *testing.T) {
	if OvercommitLevel(1.50) != Good {
		t.Error("1.50 should be good")
	}
	if OvercommitLevel(1.51) != Warning {
		t.Error("1.51 should be warning")
	}
	widths := map[float64]float64{0: 0, 0.46: 23, 1: 50, 1.5: 75, 2: 100, 3.2: 100}
	for r, w := range widths {
		if got := OvercommitMeterWidth(r); got < w-1e-9 || got > w+1e-9 {
			t.Errorf("OvercommitMeterWidth(%v) = %v, want %v", r, got, w)
		}
	}
	if OvercommitTickPct != 50 {
		t.Error("tick must sit at 50%")
	}
}

func TestHeatmapBin(t *testing.T) {
	cases := map[float64]int{7.9: 0, 8: 1, 19.9: 1, 20: 2, 34.9: 2, 35: 3, 49.9: 3, 50: 4, 64.9: 4, 65: 5, 79.9: 5, 80: 6, 100: 6, 0: 0}
	for in, want := range cases {
		v := in
		if got := HeatmapBin(&v); got != want {
			t.Errorf("HeatmapBin(%v) = %d, want %d", in, got, want)
		}
	}
	if HeatmapBin(nil) != -1 {
		t.Error("nil must be a blank cell (-1)")
	}
}

func TestServerStatus(t *testing.T) {
	if got := ServerStatus(59*time.Second, true, false); got != StatusOnline {
		t.Errorf("59 s: %s", got)
	}
	if got := ServerStatus(59*time.Second, true, true); got != StatusWarning {
		t.Errorf("59 s with alert: %s", got)
	}
	if got := ServerStatus(60*time.Second, true, false); got != StatusOffline {
		t.Errorf("60 s: %s", got)
	}
	if got := ServerStatus(60*time.Second, true, true); got != StatusOffline {
		t.Errorf("60 s with alert: %s", got)
	}
	if got := ServerStatus(0, false, false); got != StatusOffline {
		t.Errorf("never seen: %s", got)
	}
}

func TestFormats(t *testing.T) {
	cases := []struct{ got, want string }{
		{FormatStorageTB(62.2), "62.2 TB"},
		{FormatStorageTB(100), "100 TB"},
		{FormatStorageGB(440), "440 GB"},
		{FormatStorageGB(1420), "1.42 TB"},
		{FormatStorageGB(10240), "10.2 TB"},
		{FormatStorageTB(22.34), "22.3 TB"},
		{FormatStorageTB(1), "1 TB"},
		{FormatStorageTB(35), "35 TB"},
		{FormatMemoryGB(0.125), "128 MB"},
		{FormatMemoryGB(9.8), "9.8 GB"},
		{FormatMemoryGB(256), "256 GB"},
		{FormatDiskRate(42), "42 MB/s"},
		{FormatNetRate(412), "412 Mb/s"},
		{FormatNetRate(1200), "1.2 Gb/s"},
		{FormatTemp(64), "64 °C"},
		{FormatTempDense(64), "64°"},
		{FormatRelative(8 * time.Second), "8 s ago"},
		{FormatRelative(14 * time.Minute), "14 min ago"},
		{FormatRelative(2*24*time.Hour + 3*time.Hour), "2 d ago"},
		{FormatDuration(11*time.Hour + 47*time.Minute), "11 h 47 m"},
		{FormatDuration(14 * time.Minute), "14 min"},
		{Thousands(1200), "1,200"},
		{Thousands(14210), "14,210"},
		{Thousands(936), "936"},
		{Thousands(1234567), "1,234,567"},
		{FormatNumber(1200, 0), "1,200"},
	}
	for i, c := range cases {
		if c.got != c.want {
			t.Errorf("case %d: got %q, want %q", i, c.got, c.want)
		}
	}
}

func TestAxisTicks(t *testing.T) {
	// 2026-10-10 is a Saturday.
	at := time.Date(2026, 10, 10, 20, 11, 0, 0, time.UTC)
	if got := AxisTick(Range1h, time.Date(2026, 10, 11, 13, 15, 0, 0, time.UTC), time.UTC); got != "13:15" {
		t.Errorf("1h: %q", got)
	}
	if got := AxisTick(Range6h, time.Date(2026, 10, 11, 13, 15, 0, 0, time.UTC), time.UTC); got != "13:15" {
		t.Errorf("6h: %q", got)
	}
	if got := AxisTick(Range24h, at, time.UTC); got != "Sat 20:11" {
		t.Errorf("24h: %q", got)
	}
	oct6 := time.Date(2026, 10, 6, 14, 0, 0, 0, time.UTC)
	for _, r := range []string{Range7d, Range30d} {
		if got := AxisTick(r, oct6, time.UTC); got != "Oct 6" {
			t.Errorf("%s: %q", r, got)
		}
		if got := TooltipTime(r, oct6, time.UTC); got != "Oct 6, 14:00" {
			t.Errorf("%s tooltip: %q", r, got)
		}
	}
	// Viewer's zone shifts the label.
	ams, err := time.LoadLocation("Europe/Amsterdam")
	if err == nil {
		if got := AxisTick(Range1h, time.Date(2026, 10, 11, 13, 15, 0, 0, time.UTC), ams); got != "15:15" {
			t.Errorf("1h in Amsterdam: %q", got)
		}
	}
}

func u64(v uint64) *uint64         { return &v }
func f64(v float64) *float64       { return &v }
func i64(v int) *int               { return &v }
func timep(t time.Time) *time.Time { return &t }

// basaltGuests is the guest inventory of the basalt fixture (running VMs:
// incus nixbuild 8, ci-runner 4; libvirt opnsense 4, win11-test 4, haos 2).
func basaltReport() *proto.Report {
	vm := func(id string, vcpu int, state string, memGiB uint64) proto.Guest {
		return proto.Guest{ID: id, Name: id, Kind: "vm", State: state, VCPU: vcpu, MemConfigBytes: memGiB * GiB}
	}
	ct := func(id string, vcpu int, state string) proto.Guest {
		return proto.Guest{ID: id, Name: id, Kind: "container", State: state, VCPU: vcpu}
	}
	return &proto.Report{
		Host: proto.HostInfo{Threads: 48, Cores: 24, MemoryTotalBytes: 256 * GiB},
		Incus: &proto.Platform{Guests: []proto.Guest{
			vm("nixbuild", 8, "running", 16), vm("ci-runner", 4, "running", 8),
			ct("dev-shell", 4, "running"), ct("git-mirror", 2, "running"), ct("mqtt-bridge", 1, "running"),
			ct("dns", 1, "running"), ct("scratch", 2, "stopped"),
		}},
		Libvirt: &proto.Platform{Guests: []proto.Guest{
			vm("opnsense", 4, "running", 8), vm("win11-test", 4, "running", 8), vm("haos", 2, "running", 4),
			vm("truenas-lab", 4, "stopped", 16),
		}},
		Docker: &proto.Platform{Guests: []proto.Guest{{ID: "prometheus", Kind: "container", State: "running"}}},
	}
}

func TestAllocationFromGuests(t *testing.T) {
	r := basaltReport()
	a := Allocation(r)
	if a.VCPUAllocated != 22 {
		t.Errorf("vCPU allocated = %d, want 22", a.VCPUAllocated)
	}
	if got := OvercommitRatio(a.VCPUAllocated, HostThreads(r)); got < 0.458 || got > 0.459 {
		t.Errorf("ratio = %v, want 22/48", got)
	}
	if a.RunningVMs != 5 || a.RunningContainers != 4 {
		t.Errorf("vms=%d containers=%d, want 5/4", a.RunningVMs, a.RunningContainers)
	}
	if a.MemAssignedBytes != 44*GiB {
		t.Errorf("memory assigned = %d GiB, want 44 (sum of running VMs)", a.MemAssignedBytes/GiB)
	}
	if got := Stacks(r); len(got) != 2 || got[0] != "incus" || got[1] != "libvirt" {
		t.Errorf("stacks = %v", got)
	}
}

func TestAlertTexts(t *testing.T) {
	r := &proto.Report{
		Disks:   []proto.Disk{{Device: "nvme1n1", Type: "nvme", WearPct: f64(78), WrittenBytes: u64(936e12), RatedTBW: f64(1200)}},
		Sensors: []proto.Sensor{{ID: "cpu_package", Label: "CPU package", TempC: 83, LimitC: 85}},
	}
	conds := HostConditions(r)
	byRule := map[string]Condition{}
	for _, c := range conds {
		byRule[c.Rule] = c
	}
	w := byRule[RuleWearHigh].Render(0)
	if w.Title != "Disk nvme1n1 is 78% worn out" || w.Detail != "936 of the 1,200 TB it’s built to write" {
		t.Errorf("wear text = %+v", w)
	}
	if w.BannerTitle != "Disk nvme1n1 is 78% worn out" || w.BannerDetail != "936 of the 1,200 TB it’s built to write. Plan to replace it." {
		t.Errorf("wear banner = %+v", w)
	}
	if byRule[RuleWearHigh].Link != "#storage" || byRule[RuleWearHigh].StatusNote != "disk wear" {
		t.Errorf("wear link/note = %q %q", byRule[RuleWearHigh].Link, byRule[RuleWearHigh].StatusNote)
	}
	tt := byRule[RuleTempHigh].Render(14 * time.Minute)
	if tt.Title != "CPU package at 83 °C" || tt.Detail != "Above 72 °C for 14 min" {
		t.Errorf("temp text = %+v", tt)
	}
	if tt.BannerTitle != "CPU package is at 83 °C" || tt.BannerDetail != "Above 72 °C for 14 min. The warning limit is 85 °C." {
		t.Errorf("temp banner = %+v", tt)
	}
	if byRule[RuleTempHigh].StatusNote != "CPU temperature" || byRule[RuleTempHigh].Link != "#temps" {
		t.Error("temp note/link")
	}
	if _, ok := byRule[RuleTempCritical]; ok {
		t.Error("83 °C of 85 must not be critical")
	}
	// Unknown TBW: wear percent only.
	r2 := &proto.Report{Disks: []proto.Disk{{Device: "sda", Type: "ssd", WearPct: f64(80)}}}
	if d := HostConditions(r2)[0].Render(0).Detail; d != "Worn by writing" {
		t.Errorf("detail without TBW = %q", d)
	}
	// HDDs never have wear alerts.
	r3 := &proto.Report{Disks: []proto.Disk{{Device: "sda", Type: "hdd", WearPct: f64(99)}}}
	if len(HostConditions(r3)) != 0 {
		t.Error("hdd must not alert on wear")
	}
}

func TestHeartbeatCondition(t *testing.T) {
	now := time.Date(2026, 10, 11, 14, 0, 0, 0, time.UTC)
	if _, ok := HeartbeatCondition(now.Add(-59*time.Second), now); ok {
		t.Error("59 s must not be missing")
	}
	c, ok := HeartbeatCondition(now.Add(-(11*time.Hour + 47*time.Minute)), now)
	if !ok {
		t.Fatal("11 h must be missing")
	}
	txt := c.Render(0)
	if txt.Title != "Whombat’s helper isn’t checking in" || txt.Detail != "Nothing heard from it for 11 h 47 m" || c.Severity != SevCritical {
		t.Errorf("heartbeat = %+v %s", txt, c.Severity)
	}
}

func TestDiskSpaceAndAllocationRules(t *testing.T) {
	r := &proto.Report{
		Host:        proto.HostInfo{Threads: 32, MemoryTotalBytes: 192 * GiB},
		Filesystems: []proto.Filesystem{{Mount: "/srv", Device: "/dev/sda1", FSType: "ext4", SizeBytes: 1000e9, UsedBytes: 910e9}},
		PVE:         &proto.PVE{Guests: []proto.Guest{}},
	}
	for i := 0; i < 7; i++ {
		r.PVE.Guests = append(r.PVE.Guests, proto.Guest{ID: string(rune('a' + i)), Kind: "vm", State: "running", VCPU: 8, MemConfigBytes: 25 * GiB})
	}
	rules := map[string]Condition{}
	for _, c := range HostConditions(r) {
		rules[c.Rule] = c
	}
	if c, ok := rules[RuleSpaceHigh]; !ok || c.Render(0).Title != "Disk “srv” 91% full" {
		t.Errorf("space rule missing or wrong (present=%v)", ok)
	}
	// Over-booked processors on an idle server are normal at home: nothing.
	if _, ok := rules[RuleOvercommit]; ok {
		t.Error("overcommit while idle")
	}
	if c, ok := rules[RuleMemAssigned]; !ok || c.Render(0).Title != "Machines have 91% of the memory" {
		t.Error("memory assigned rule missing or wrong")
	}
	r.CPU.UsagePct = 92
	rules = map[string]Condition{}
	for _, c := range HostConditions(r) {
		rules[c.Rule] = c
	}
	if c, ok := rules[RuleOvercommit]; !ok || c.For != 30*time.Minute || c.Render(0).Title != "Machines want more processors than the server has" {
		t.Error("overcommit rule missing or wrong")
	}
}

func TestHottestSensorUsesOwnLimit(t *testing.T) {
	r := &proto.Report{Sensors: []proto.Sensor{
		{ID: proto.SensorCPU, TempC: 64, LimitC: 85},
		{ID: proto.SensorHDD, TempC: 54, LimitC: 55},
	}}
	s, limit := HottestSensor(r)
	if s == nil || s.ID != proto.SensorHDD || limit != 55 {
		t.Fatalf("got %+v limit %v, want the HDD at 54 of 55 °C", s, limit)
	}
	r.Sensors[1].TempC = 30
	if s, limit = HottestSensor(r); s.ID != proto.SensorCPU || limit != 85 {
		t.Fatalf("got %+v limit %v, want the CPU", s, limit)
	}
	if s, _ = HottestSensor(&proto.Report{}); s != nil {
		t.Fatalf("no sensors: got %+v", s)
	}
}
