package rules

import (
	"strings"
	"testing"
	"time"

	"rackoon/internal/proto"
)

func boolp(v bool) *bool { return &v }
func intp(v int) *int    { return &v }
func byRule(cs []Condition) map[string]Condition {
	m := map[string]Condition{}
	for _, c := range cs {
		m[c.Key()] = c
	}
	return m
}

func TestHealthConditions(t *testing.T) {
	r := &proto.Report{
		Disks: []proto.Disk{
			{Device: "sda", Type: "hdd", SmartPassed: boolp(false)},
			{Device: "nvme0n1", Type: "nvme", CriticalWarning: u64(0x05)},
			{Device: "nvme1n1", Type: "nvme", SparePct: f64(5), SpareThreshold: f64(10)},
			{Device: "sdb", Type: "hdd", SmartPassed: boolp(true), Pending: u64(8), SelfTest: &proto.SelfTest{Type: "short", Result: "failed"}},
			{Device: "sdc", Type: "hdd", SmartPassed: boolp(true), Reallocated: u64(3)},
		},
		Pools: []proto.Pool{
			{Name: "tank", Health: "DEGRADED", Faulted: []string{"sdd"}},
			{Name: "fast", Health: "ONLINE", CksumErrors: 2},
			{Name: "ok", Health: "ONLINE"},
		},
		RAID: []proto.RAIDArray{
			{Name: "md0", State: "clean", Devices: 2, Active: 2},
			{Name: "md1", State: "recovering", Devices: 2, Active: 1, SyncPct: f64(42)},
		},
		Filesystems: []proto.Filesystem{
			{Mount: "/srv", ReadOnly: true},
			{Mount: "/var", InodesTotal: 1000, InodesUsed: 950},
		},
		PVE: &proto.PVE{
			Cluster:     &proto.PVECluster{Name: "lab", Quorate: false, VotesHave: 1, VotesExpected: 3},
			Backups:     &proto.PVEBackups{LastJob: &proto.PVEBackupJob{Result: "error", GuestsOK: 3, GuestsTotal: 5}},
			Replication: []proto.PVEReplication{{ID: "100-0", Target: "pve2", Error: "no route"}},
			Ceph:        &proto.CephHealth{Status: "HEALTH_ERR", Summary: []string{"1 osds down"}},
		},
		System: &proto.SystemInfo{TimeSynced: boolp(false), TimeOffsetMs: f64(2500), TimeSource: "chrony"},
		UPS:    []proto.UPS{{Name: "ups", Status: "on_battery", ChargePct: f64(80)}},
		Net: []proto.NetIface{
			{Name: "eno1", Kind: "ethernet", Addresses: []string{"10.0.0.2/24"}, Carrier: false},
			{Name: "eno2", Kind: "ethernet", Carrier: false}, // unused: no alert
			{Name: "bond0", Kind: "bond", Carrier: true, Members: []string{"enp1", "enp2"}, Addresses: []string{"10.0.1.2/24"}},
			{Name: "enp1", Kind: "ethernet", Master: "bond0", Carrier: true},
			{Name: "enp2", Kind: "ethernet", Master: "bond0", Carrier: false},
		},
		Fans: []proto.Fan{{Label: "CPU fan", Source: "nct · fan1", RPM: 0, MinRPM: 300}, {Label: "GPU", Source: "amdgpu", RPM: 0}},
	}
	m := byRule(healthConditions(r, nil))
	want := map[string]string{
		"disk.smart_failing:sda":            "SMART overall health check failed",
		"disk.smart_failing:nvme0n1":        "Spare capacity below threshold, reliability degraded by media errors",
		"disk.smart_failing:nvme1n1":        "Spare at 5%, below the 10% threshold",
		"disk.smart_errors:sdb":             "8 pending sectors, the last short self-test failed",
		"pool.degraded:pool:tank":           "sdd is offline; the data is at risk until it’s back",
		"pool.errors:pool:fast":             "2 errors reading or writing its disks",
		"raid.degraded:raid:md1":            "1 of 2 disks working · rebuilding, 42% done",
		"fs.read_only:fs:/srv":              "It switched to read-only, usually because the disk has problems",
		"fs.inodes_high:fs:/var":            "95% of its room for files is used (950 of 1,000), even with space left",
		"pve.quorum_lost:cluster:lab":       "Only 1 of 3 are connected",
		"pve.replication_failed:repl:100-0": "100-0: no route",
		"ceph.health:ceph":                  "1 osds down",
		"time.unsynced:host":                "It isn’t setting its time from a time server",
		"ups.on_battery:ups:ups":            "The power is out (ups) · 80% left",
		"net.link_down:net:eno1":            "Nothing is connected to it, though it has the address 10.0.0.2/24",
		"net.link_down:net:bond0":           "enp2 has nothing connected",
		"sensor.fan_failed:fan:nct · fan1":  "CPU fan at 0 rpm; it should be at least 300 rpm",
	}
	for k, d := range want {
		c, ok := m[k]
		if !ok {
			t.Errorf("missing %s", k)
			continue
		}
		txt := c.Render(0)
		if got := txt.Detail; got != d {
			t.Errorf("%s detail %q, want %q", k, got, d)
		}
		if txt.Code != c.Rule || len(txt.Params) == 0 {
			t.Errorf("%s translation data = %q %v", k, txt.Code, txt.Params)
		}
	}
	smart := m["disk.smart_failing:nvme0n1"].Render(0)
	if smart.Params["device"] != "nvme0n1" || smart.Params["criticalWarning"] != int64(0x05) {
		t.Errorf("SMART warning bits = %v", smart.Params)
	}
	if c := m["backup.failed:vzdump"]; c.Render == nil || !strings.HasPrefix(c.Render(0).Detail, "3 of 5 machines backed up") {
		t.Errorf("backup.failed missing or wrong")
	}
	for _, k := range []string{"disk.smart_errors:sdc", "raid.degraded:raid:md0", "pool.errors:pool:ok", "net.link_down:net:eno2", "sensor.fan_failed:fan:amdgpu"} {
		if _, ok := m[k]; ok {
			t.Errorf("unexpected %s", k)
		}
	}
	if m["ceph.health:ceph"].Severity != SevCritical || m["pool.errors:pool:fast"].Severity != SevWarning {
		t.Error("severities")
	}
	// Part of HostConditions.
	if len(byRule(HostConditions(r))) < len(want) {
		t.Error("health conditions not in HostConditions")
	}
}

func TestMemo(t *testing.T) {
	var m Memo
	t0 := time.Date(2026, 10, 13, 12, 0, 0, 0, time.UTC)
	rep := func(oom uint64, restarts int) *proto.Report {
		return &proto.Report{System: &proto.SystemInfo{OOMKills: oom},
			Docker: &proto.Platform{Guests: []proto.Guest{{ID: "abc", Name: "web", RestartCount: intp(restarts)}}}}
	}
	m.Observe(rep(697, 10), t0) // baseline: old kills and restarts do not count
	if cs := m.Conditions(t0); len(cs) != 0 {
		t.Fatalf("baseline conditions %v", cs)
	}
	m.Observe(rep(699, 11), t0.Add(time.Minute))
	m.Observe(rep(699, 12), t0.Add(2*time.Minute))
	cs := byRule(m.Conditions(t0.Add(2 * time.Minute)))
	if c, ok := cs["host.oom:host"]; !ok || c.Render(0).Detail != "It had to stop 2 programs in the last hour" {
		t.Fatalf("oom %v", cs)
	}
	if _, ok := cs["guest.restart_loop:docker/abc"]; ok {
		t.Fatal("2 restarts are no loop")
	}
	m.Observe(rep(699, 13), t0.Add(3*time.Minute))
	cs = byRule(m.Conditions(t0.Add(3 * time.Minute)))
	if c, ok := cs["guest.restart_loop:docker/abc"]; !ok || c.Render(0).Title != "web keeps restarting" {
		t.Fatalf("restart loop %v", cs)
	}
	// An hour later both are over.
	m.Observe(rep(699, 13), t0.Add(2*time.Hour))
	if cs := m.Conditions(t0.Add(2 * time.Hour)); len(cs) != 0 {
		t.Fatalf("stale conditions %v", cs)
	}
}

func u64p(v uint64) *uint64 { return &v }

// TestMemoOOMSplit: host.oom is about the machine (LM-04).
func TestMemoOOMSplit(t *testing.T) {
	t0 := time.Date(2026, 10, 18, 10, 0, 0, 0, time.UTC)
	rep := func(total uint64, limit *uint64) *proto.Report {
		return &proto.Report{System: &proto.SystemInfo{OOMKills: total, OOMLimitKills: limit}}
	}
	type step struct {
		total uint64
		limit *uint64
		want  string // host.oom's detail, "" for none
	}
	cases := []struct {
		name  string
		steps []step
	}{
		{"A build server: a test's python3 at its own limit", []step{{696, u64p(0), ""}, {697, u64p(1), ""}}},
		{"the machine ran out", []step{{5, u64p(3), ""}, {6, u64p(3), "It had to stop 1 program in the last hour"}}},
		{"both in one report", []step{{5, u64p(3), ""}, {8, u64p(4), "It had to stop 2 programs in the last hour"}}},
		{"an old agent keeps today's warning", []step{{5, nil, ""}, {6, nil, "It had to stop 1 program in the last hour"}}},
		{"the first split report after an update", []step{{5, nil, ""}, {6, u64p(1), "It had to stop 1 program in the last hour"}}},
		{"the agent restarted and read less of the log", []step{{5, u64p(4), ""}, {5, u64p(1), ""}, {6, u64p(2), ""}, {7, u64p(1), "It had to stop 1 program in the last hour"}}},
		{"a limit count ahead of the total takes nothing more", []step{{5, u64p(0), ""}, {6, u64p(3), ""}}},
		{"a reboot is a new baseline", []step{{50, u64p(10), ""}, {2, u64p(2), ""}, {3, u64p(3), ""}}},
	}
	for _, c := range cases {
		var m Memo
		for i, st := range c.steps {
			now := t0.Add(time.Duration(i) * time.Minute)
			m.Observe(rep(st.total, st.limit), now)
			got := ""
			if cond, ok := byRule(m.Conditions(now))["host.oom:host"]; ok {
				got = cond.Render(0).Detail
				if cond.Severity != SevWarning || cond.Render(0).Title != "The server ran out of memory" {
					t.Errorf("%s: %+v", c.name, cond.Render(0))
				}
			}
			if i == len(c.steps)-1 && got != st.want {
				t.Errorf("%s: %q, want %q", c.name, got, st.want)
			}
		}
	}
}

func TestOOMLimitHints(t *testing.T) {
	now := time.Now()
	limit := u64p(5)
	r := &proto.Report{
		Docker: &proto.Platform{Guests: []proto.Guest{{ID: "nextcloud", Name: "nextcloud"}}},
		Incus:  &proto.Platform{Guests: []proto.Guest{{ID: "dev/web", Name: "web"}}},
		System: &proto.SystemInfo{OOMKills: 9, OOMLimitKills: limit, OOMLimited: []proto.OOMKill{
			{At: now.Add(-2 * time.Hour), Process: "old", Cgroup: "/system.slice/x.service"}, // past the hour
			{At: now.Add(-12 * time.Minute), Process: "python3", Cgroup: "/user.slice/user-1000.slice/user@1000.service/wbtest159958.slice"},
			{At: now.Add(-20 * time.Minute), Process: "php-fpm", Platform: "docker", GuestID: "nextcloud"},
			{At: now.Add(-5 * time.Minute), Process: "php-fpm", Platform: "docker", GuestID: "nextcloud"},
			{At: now.Add(-3 * time.Minute), Process: "node", Platform: "incus", GuestID: "dev/web"},
			{At: now.Add(-2 * time.Minute), Process: "java", Platform: "incus", GuestID: "dev/web"},
			{At: now.Add(-1 * time.Minute), Process: "x", Platform: "vmware", GuestID: "y", Cgroup: `/machine.slice/machine-y\x2d1.scope`},
		}},
	}
	got := map[string]Hint{}
	for _, h := range HostHints(r, "", nil) {
		if h.Kind == HintMemoryLimit {
			got[h.Entity] = h
			if h.Severity != HintInfo {
				t.Errorf("%s is not quiet: %s", h.Entity, h.Severity)
			}
		}
	}
	want := map[string][3]string{ // title, detail, link
		"docker:nextcloud": {"nextcloud ran out of its memory 2 times",
			"php-fpm was stopped 2 times, the last 5 min ago. The server itself has memory to spare.", LinkGuests},
		"incus:dev/web": {"web ran out of its memory 2 times",
			"node and java were stopped, the last 2 min ago. The server itself has memory to spare.", LinkGuests},
	}
	if len(got) != len(want) {
		t.Fatalf("hints %+v", got)
	}
	for e, w := range want {
		h := got[e]
		if h.Title != w[0] || h.Detail != w[1] || h.Link != w[2] {
			t.Errorf("%s: %q / %q / %q", e, h.Title, h.Detail, h.Link)
		}
	}
	if g := got["incus:dev/web"].Guests; len(g) != 1 || g[0] != "incus:dev/web" {
		t.Errorf("guests %v", g)
	}
	// One kill each.
	r.System.OOMLimited = []proto.OOMKill{
		{At: now.Add(-12 * time.Minute), Process: "python3", Cgroup: "/user.slice/user-1000.slice/user@1000.service/wbtest159958.slice"},
		{At: now.Add(-3 * time.Minute), Process: "php-fpm", Platform: "docker", GuestID: "gone"},
		{At: now.Add(-3 * time.Minute), Process: "worker"},
	}
	got = map[string]Hint{}
	for _, h := range oomLimitHints(r, now) {
		got[h.Entity] = h
	}
	if h := got["docker:gone"]; h.Title != "gone ran out of its memory" ||
		h.Detail != "php-fpm was stopped 3 min ago. The server itself has memory to spare." {
		t.Errorf("one kill in a guest: %+v", h)
	}
	// Kills outside machines (a test run's or a session's own limit) say nothing.
	if h, ok := got["host"]; ok {
		t.Errorf("other: %+v", h)
	}
	r.System.OOMLimited = r.System.OOMLimited[:1]
	if hs := oomLimitHints(r, now); len(hs) != 0 {
		t.Errorf("build server: %+v", hs)
	}
	// Old agents send none.
	r.System = &proto.SystemInfo{OOMKills: 9}
	if hs := oomLimitHints(r, now); len(hs) != 0 {
		t.Errorf("old agent: %+v", hs)
	}
	if joinAnd([]string{"a", "b", "c", "d", "e"}, 3) != "a, b, c and 2 more" || joinAnd([]string{"a"}, 3) != "a" {
		t.Error("joinAnd")
	}
}

func TestForecast(t *testing.T) {
	t0 := time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)
	var pts []Point
	for i := 0; i <= 48; i++ { // 2 % a day for 4 days from 80 %
		pts = append(pts, Point{T: t0.Add(time.Duration(i) * 2 * time.Hour), V: 80 + float64(i)*2*2/24})
	}
	days, ok := Forecast(pts)
	if !ok || days < 5.5 || days > 6.5 { // at 88 % after 4 days: 6 days left
		t.Fatalf("forecast %v %v", days, ok)
	}
	if c, ok := FullSoonCondition("fs:/srv", "/srv", days); !ok || c.Render(0).Title != "Disk “srv” full in about 6 days" {
		t.Fatalf("condition %v", c.Render(0))
	}
	flat := []Point{}
	for i := 0; i < 48; i++ {
		flat = append(flat, Point{T: t0.Add(time.Duration(i) * time.Hour), V: 50})
	}
	if _, ok := Forecast(flat); ok {
		t.Fatal("flat usage has no forecast")
	}
	if _, ok := Forecast(pts[:10]); ok {
		t.Fatal("short history has no forecast")
	}
}

func TestHealthHints(t *testing.T) {
	r := &proto.Report{
		System: &proto.SystemInfo{UpdatesPending: intp(17), SecurityUpdates: intp(6), PackageManager: "apt", RebootRequired: true,
			RebootReason: "Kernel 6.12.111 is installed, 6.12.107 runs", FailedCount: 2, FailedUnits: []string{"a.service", "b.mount"}},
		Disks:  []proto.Disk{{Device: "sda", Reallocated: u64(8), CRCErrors: u64(1)}},
		Pools:  []proto.Pool{{Name: "tank", Health: "ONLINE", ScrubState: "none"}},
		Docker: &proto.Platform{Guests: []proto.Guest{{ID: "1", Name: "mailpit", UpdateAvailable: boolp(true)}}},
		Incus:  &proto.Platform{Warnings: []proto.PlatformWarning{{Message: "Skipping AppArmor"}}},
	}
	got := map[string]Hint{}
	for _, h := range HostHints(r, "", nil) {
		got[h.Kind] = h
	}
	checks := map[string]string{
		HintUpdates:      "17 updates waiting|6 security updates",
		HintReboot:       "Restart needed|To finish installing updates",
		HintFailedUnits:  "2 services failed|a, b.mount",
		HintDiskCounters: "Disk sda has had a few errors|8 worn spots replaced · 1 cable error",
		HintScrubStale:   "Storage “tank” has never been checked for damage|A monthly data check finds hidden damage early",
		HintImageUpdates: "1 app has an update|mailpit",
		HintIncusWarning: "Incus has 1 warning|Skipping AppArmor",
	}
	for k, w := range checks {
		h, ok := got[k]
		if !ok {
			t.Errorf("missing hint %s", k)
			continue
		}
		if h.Title+"|"+h.Detail != w {
			t.Errorf("%s = %q, want %q", k, h.Title+"|"+h.Detail, w)
		}
	}
	if got[HintUpdates].Severity != HintInfo || got[HintFailedUnits].Severity != HintWarning {
		t.Error("hint severities")
	}
	// Updates without security ones say nothing more; many containers: two names and how many more.
	r.System.SecurityUpdates = intp(0)
	r.Docker.Guests = nil
	for _, n := range []string{"web", "db", "cache", "mail"} {
		r.Docker.Guests = append(r.Docker.Guests, proto.Guest{ID: n, Name: n, UpdateAvailable: boolp(true)})
	}
	for _, h := range HostHints(r, "", nil) {
		got[h.Kind] = h
	}
	if h := got[HintUpdates]; h.Detail != "" {
		t.Errorf("updates without security ones: %q", h.Detail)
	}
	if h := got[HintImageUpdates]; h.Title+"|"+h.Detail != "4 apps have updates|web, db and 2 more" {
		t.Errorf("image updates: %q", h.Title+"|"+h.Detail)
	}
	fh := ForecastHints(&proto.Report{Filesystems: []proto.Filesystem{{Mount: "/srv", SizeBytes: 100, UsedBytes: 60}}},
		map[string]float64{"fs:/srv": 20}, nil)
	if len(fh) != 1 || fh[0].Title != "Disk “srv” full in about 20 days" {
		t.Fatalf("forecast hints %v", fh)
	}
}

// TestUPSPowerCutIsCritical: a power cut is a red problem after UPSOnBatteryFor (automations shut servers down on it);
// an almost empty battery adds its own alert, so it is told again even when the power cut was ignored.
func TestUPSPowerCutIsCritical(t *testing.T) {
	on := byRule(healthConditions(&proto.Report{UPS: []proto.UPS{{Name: "apc", Status: "on_battery"}}}, nil))
	c, ok := on["ups.on_battery:ups:apc"]
	if !ok || c.Severity != SevCritical || c.For != UPSOnBatteryFor {
		t.Fatalf("on battery = %+v", c)
	}
	if _, low := on["ups.on_battery:ups:apc:low"]; low || len(on) != 1 {
		t.Fatalf("on battery alone has %d conditions", len(on))
	}

	low := byRule(healthConditions(&proto.Report{UPS: []proto.UPS{{Name: "apc", Status: "low_battery"}}}, nil))
	cut, nearly := low["ups.on_battery:ups:apc"], low["ups.on_battery:ups:apc:low"]
	if cut.Severity != SevCritical || nearly.Severity != SevCritical || nearly.For != 0 {
		t.Fatalf("low battery = %+v / %+v", cut, nearly)
	}
	if p := nearly.Render(0).Params; p["low"] != true || p["name"] != "apc" {
		t.Fatalf("low battery params = %v", p)
	}
	if _, says := cut.Render(0).Params["low"]; says {
		t.Fatalf("the power cut itself isn't the low battery alert")
	}

	if none := healthConditions(&proto.Report{UPS: []proto.UPS{{Name: "apc", Status: "online"}}}, nil); len(none) != 0 {
		t.Fatalf("online = %d conditions", len(none))
	}
}
