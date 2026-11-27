package rules

import (
	"strings"
	"testing"

	"rackoon/internal/proto"
)

func hintTitles(hs []Hint) string {
	var s []string
	for _, h := range hs {
		s = append(s, h.Severity+":"+h.Title)
	}
	return strings.Join(s, "|")
}

func TestSensorNearLimitHint(t *testing.T) {
	r := &proto.Report{Sensors: []proto.Sensor{
		{ID: proto.SensorCPU, Label: "CPU package", TempC: 80, LimitC: 85},    // 94%: warning (alert pending)
		{ID: proto.SensorNVMe, Label: "NVMe, hottest", TempC: 50, LimitC: 75}, // 67%: nothing
		{ID: proto.SensorHDD, Label: "HDD, hottest", TempC: 40, LimitC: 55},   // 73%: info
		{ID: proto.SensorDIMM, TempC: 60},                                     // default limit 85, 71%: info, label = id
	}}
	hs := HostHints(r, "", nil)
	if got := hintTitles(hs); got != "warning:CPU package at 80 °C|info:HDD, hottest at 40 °C|info:dimm at 60 °C" {
		t.Fatalf("hints = %s", got)
	}
	cpu := hs[0]
	if cpu.Kind != HintNearLimit || cpu.Entity != proto.SensorCPU || cpu.Detail != "94% of the 85 °C limit" || cpu.Link != "#temps" {
		t.Errorf("cpu hint = %+v", cpu)
	}
	if cpu.Code != HintNearLimit || cpu.Params["sensor"] != proto.SensorCPU || cpu.Params["tempC"] != 80.0 || cpu.Params["limitC"] != 85.0 {
		t.Errorf("cpu hint translation data = %q %v", cpu.Code, cpu.Params)
	}
	if hs[1].Detail != "73% of the 55 °C limit" || hs[2].Detail != "71% of the 85 °C limit" || hs[1].Entity != proto.SensorHDD {
		t.Errorf("details = %q / %q", hs[1].Detail, hs[2].Detail)
	}
	// An open temperature alert on the sensor covers the hint.
	open := []Alert{{Rule: RuleTempHigh, Entity: proto.SensorCPU, State: AlertOpen}}
	if got := hintTitles(HostHints(r, "", open)); got != "info:HDD, hottest at 40 °C|info:dimm at 60 °C" {
		t.Errorf("with open alert: %s", got)
	}
	// A resolved one or one on another entity does not.
	stale := []Alert{{Rule: RuleTempCritical, Entity: proto.SensorCPU, State: AlertResolved}, {Rule: RuleTempHigh, Entity: proto.SensorHDD}}
	if got := hintTitles(HostHints(r, "", stale)); got != "warning:CPU package at 80 °C|info:dimm at 60 °C" {
		t.Errorf("with other alerts: %s", got)
	}
	if HostHints(nil, "x", nil) != nil {
		t.Error("nil report must give no hints")
	}
}

func TestSwapAndMemoryHints(t *testing.T) {
	r := &proto.Report{Memory: proto.Memory{TotalBytes: 64 * GiB, UsedBytes: 58 * GiB, AvailableBytes: 6 * GiB,
		SwapTotalBytes: 8 * GiB, SwapUsedBytes: 7 * GiB}}
	hs := HostHints(r, "", nil)
	if got := hintTitles(hs); got != "info:Swap almost full|info:Memory almost full" {
		t.Fatalf("hints = %s", got)
	}
	if hs[0].Kind != HintSwapHigh || hs[0].Entity != "host" || hs[0].Link != "" || hs[0].Detail != "7 GB of 8 GB used · RAM 91% used" {
		t.Errorf("swap = %+v", hs[0])
	}
	if hs[1].Kind != HintMemoryLow || hs[1].Entity != "host" || hs[1].Detail != "6 GB available of 64 GB" {
		t.Errorf("memory = %+v", hs[1])
	}
	// 90% swap and under 5% available: warnings.
	r.Memory.SwapUsedBytes = 15 * GiB / 2
	r.Memory.AvailableBytes = 2 * GiB
	if got := hintTitles(HostHints(r, "", nil)); got != "warning:Swap almost full|warning:Memory almost full" {
		t.Errorf("warnings = %s", got)
	}
	// Below the thresholds, or a tiny swap device: nothing.
	r.Memory.SwapUsedBytes, r.Memory.AvailableBytes = 6*GiB, 7*GiB
	if hs := HostHints(r, "", nil); len(hs) != 0 {
		t.Errorf("under thresholds: %s", hintTitles(hs))
	}
	r.Memory.SwapTotalBytes, r.Memory.SwapUsedBytes = 512*MiB, 512*MiB
	if hs := HostHints(r, "", nil); len(hs) != 0 {
		t.Errorf("small swap: %s", hintTitles(hs))
	}
	// A full swap while memory has room is idle pages parked there: nothing.
	r.Memory = proto.Memory{TotalBytes: 188 * GiB, UsedBytes: 38 * GiB, AvailableBytes: 150 * GiB,
		SwapTotalBytes: 32 * GiB, SwapUsedBytes: 30 * GiB}
	if hs := HostHints(r, "", nil); len(hs) != 0 {
		t.Errorf("full swap, memory with room: %s", hintTitles(hs))
	}
}

func TestDiskSpaceAndWearHints(t *testing.T) {
	r := &proto.Report{
		Filesystems: []proto.Filesystem{
			{Mount: "/", Device: "/dev/sda1", FSType: "ext4", SizeBytes: 1000e9, UsedBytes: 850e9},     // 85%: info
			{Mount: "/srv", Device: "/dev/sdb1", FSType: "ext4", SizeBytes: 1000e9, UsedBytes: 910e9},  // 91%: alert, no hint
			{Mount: "/tank", Device: "tank", FSType: "zfs", SizeBytes: 1000e9, UsedBytes: 850e9},       // zfs: its pool
			{Mount: "/mnt/x", Device: "/dev/sdc1", FSType: "xfs", SizeBytes: 1000e9, UsedBytes: 790e9}, // 79%: nothing
		},
		Pools: []proto.Pool{{Name: "tank", SizeBytes: 2000e9, AllocBytes: 1700e9}},
		PVE: &proto.PVE{Storages: []proto.PVEStorage{
			{ID: "local", Active: true, UsedBytes: 82e9, TotalBytes: 100e9},
			{ID: "off", Active: false, UsedBytes: 85e9, TotalBytes: 100e9},
		}},
		Disks: []proto.Disk{
			{Device: "nvme0n1", Type: "nvme", WearPct: f64(62), WrittenBytes: u64(372e12), RatedTBW: f64(600)},
			{Device: "nvme1n1", Type: "nvme", WearPct: f64(78)}, // alert band
			{Device: "sda", Type: "hdd", WearPct: f64(70)},      // HDDs have no wear
			{Device: "sdb", Type: "ssd", WearPct: f64(59.9)},
		},
	}
	hs := HostHints(r, "", nil)
	want := "info:System disk 85% full|info:Storage “tank” 85% full|info:Storage “local” 82% full|info:Disk nvme0n1 is 62% worn"
	if got := hintTitles(hs); got != want {
		t.Fatalf("hints = %s", got)
	}
	if hs[0].Kind != HintDiskSpace || hs[0].Entity != "fs:/" || hs[0].Detail != "850 GB of 1 TB used" || hs[0].Link != "#storage" {
		t.Errorf("fs hint = %+v", hs[0])
	}
	if hs[1].Entity != "pool:tank" || hs[1].Detail != "1.7 TB of 2 TB used" || hs[2].Entity != "storage:local" || hs[2].Detail != "82 GB of 100 GB used" {
		t.Errorf("pool/storage = %+v / %+v", hs[1], hs[2])
	}
	if hs[3].Kind != HintDiskWear || hs[3].Entity != "nvme0n1" || hs[3].Detail != "372 of the 600 TB it’s built to write" || hs[3].Link != "#storage" {
		t.Errorf("wear hint = %+v", hs[3])
	}
	if h := hs[3]; h.Code != "disk.wear.tbw" || h.Params["writtenTb"] != 372.0 || h.Params["ratedTbw"] != 600.0 {
		t.Errorf("wear hint translation data = %q %v", h.Code, h.Params)
	}
	// The alert conditions of the same report do not overlap the hints.
	for _, c := range HostConditions(r) {
		for _, h := range hs {
			if c.Entity == h.Entity {
				t.Errorf("%s is both an alert and a hint", c.Entity)
			}
		}
	}
}

func TestCollectorAndUnhealthyHints(t *testing.T) {
	r := &proto.Report{
		Collectors: []proto.CollectorStatus{{Name: "docker", OK: false, Error: "permission denied"}, {Name: "host", OK: true}, {Name: "pve", OK: false}},
		Docker:     &proto.Platform{Guests: []proto.Guest{{ID: "c1", Name: "web", State: proto.StateRunning}, {ID: "api", State: proto.StateUnhealthy}}},
	}
	hs := HostHints(r, "", nil)
	if got := hintTitles(hs); got != "warning:Whombat can’t read this server’s apps|warning:Whombat can’t read this server’s machines|warning:1 app isn’t working properly" {
		t.Fatalf("hints = %s", got)
	}
	if hs[0].Kind != HintCollectorError || hs[0].Entity != "docker" || hs[0].Detail != "permission denied" || hs[0].Link != "#agent" {
		t.Errorf("collector hint = %+v", hs[0])
	}
	if hs[1].Entity != "pve" || hs[1].Detail != "It didn’t say why." {
		t.Errorf("collector without error text = %+v", hs[1])
	}
	if u := hs[2]; u.Kind != HintGuestsUnhealthy || u.Entity != "docker" || u.Detail != "api" || u.Link != "#guests" {
		t.Errorf("unhealthy hint = %+v", u)
	}
	// Plural, at most five names.
	r.Docker.Guests = nil
	for _, n := range []string{"a", "b", "c", "d", "e", "f", "g"} {
		r.Docker.Guests = append(r.Docker.Guests, proto.Guest{ID: n, Name: n, State: proto.StateUnhealthy})
	}
	hs = HostHints(r, "", nil)
	if u := hs[len(hs)-1]; u.Title != "7 apps aren’t working properly" || u.Detail != "a, b, c, d, e, …" {
		t.Errorf("plural = %+v", u)
	}
}

func TestAgentOutdatedHintAndOrder(t *testing.T) {
	r := &proto.Report{Agent: proto.AgentInfo{Version: "0.14.2"}}
	hs := HostHints(r, "0.15.0", nil)
	if len(hs) != 1 || hs[0].Kind != HintAgentOutdated || hs[0].Severity != HintInfo || hs[0].Entity != "host" ||
		hs[0].Title != "Whombat’s helper on this server is out of date" || hs[0].Detail != "It runs 0.14.2, Whombat 0.15.0." || hs[0].Link != "#agent" {
		t.Errorf("outdated = %+v", hs)
	}
	for _, hub := range []string{"0.14.2", ""} {
		if hs := HostHints(r, hub, nil); len(hs) != 0 {
			t.Errorf("hub %q: %s", hub, hintTitles(hs))
		}
	}
	if hs := HostHints(&proto.Report{}, "0.15.0", nil); len(hs) != 0 {
		t.Errorf("unknown agent version: %s", hintTitles(hs))
	}
	// Warnings come before info whatever the rule order.
	r.Collectors = []proto.CollectorStatus{{Name: "smart", OK: false}}
	if got := hintTitles(HostHints(r, "0.15.0", nil)); got != "warning:Whombat can’t read this server’s disk health|info:Whombat’s helper on this server is out of date" {
		t.Errorf("order = %s", got)
	}
}
