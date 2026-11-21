package fakefleet

import (
	"encoding/json"
	"time"

	"rackoon/internal/proto"
)

// The unRAID server of the fake fleet: blackbox, shaped like a real
// unRAID 7.3.1 server: a started array with one data disk and no
// parity, three encrypted btrfs pools (apps raid10, data raid6, storage
// raid1), shares, Plex and the *arr apps with dockerMan templates (Plex
// with an update), Immich from compose (no template), a PBS VM that
// starts with the server, two plugin updates, one unread alert and a
// newer unRAID. It is not in Fleet() (the fixture hosts): rackoon-sim
// --unraid adds it. Names, addresses and serials are fake.

// Blackbox returns the unRAID server.
func Blackbox() *Host {
	day := int64(86400)
	h := &Host{
		ID: "blackbox", Group: "Lab", Location: "Office rack",
		OSName: "Unraid OS", OSVersion: "7.3.1", Pretty: "Unraid OS 7.3.1", Kernel: "6.18.33-Unraid",
		CPUModel: "Core i5-13500", Cores: 14, Threads: 20, MemGiB: 64, MemType: "DDR5", Address: "10.30.0.40",
		UptimeS: 19 * day, CPU: 14, User: 9, Sys: 3, IOWait: 2, Load: [3]float64{3.1, 2.9, 2.7},
		MemUsedGiB: 38, CacheGiB: 20, Free: 6, SwapTotal: 0,
		Sensors: []SensorSpec{cpuSensor(48, "coretemp · Package id 0"),
			{ID: proto.SensorHDD, Label: "HDD, hottest", Group: "hdd", Source: "sdf · SMART", Temp: 37, Limit: 55},
			{ID: proto.SensorSATASS, Label: "SATA SSD, hottest", Group: "ssd", Source: "sde · SMART", Temp: 32, Limit: 70}},
		Disks: []DiskSpec{
			{Dev: "sdi", Type: "ssd", Model: "WD Red SA500 2 TB", Role: "Array disk1 · /mnt/disk1", CapGB: 2000, UsedGB: 14, Wear: f(3), WrittenTB: 40, RatedTBW: 1300, Temp: 31, POH: 17000},
			{Dev: "sdb", Type: "ssd", Model: "Samsung 870 EVO 1 TB", Pool: "apps", Role: "apps, raid10 member", CapGB: 1000, UsedGB: 10, Wear: f(9), WrittenTB: 55, RatedTBW: 600, Temp: 31, POH: 21000},
			{Dev: "sdc", Type: "ssd", Model: "Samsung 870 EVO 1 TB", Pool: "apps", Role: "apps, raid10 member", CapGB: 1000, UsedGB: 10, Wear: f(9), WrittenTB: 55, RatedTBW: 600, Temp: 31, POH: 21000},
			{Dev: "sdd", Type: "ssd", Model: "Samsung 870 EVO 1 TB", Pool: "apps", Role: "apps, raid10 member", CapGB: 1000, UsedGB: 10, Wear: f(9), WrittenTB: 55, RatedTBW: 600, Temp: 31, POH: 21000},
			{Dev: "sde", Type: "ssd", Model: "Samsung 870 EVO 1 TB", Pool: "apps", Role: "apps, raid10 member", CapGB: 1000, UsedGB: 10, Wear: f(9), WrittenTB: 55, RatedTBW: 600, Temp: 32, POH: 21000},
			{Dev: "sdj", Type: "hdd", Model: "Seagate IronWolf Pro 10 TB", Pool: "data", Role: "data, raid6 member", CapGB: 10000, UsedGB: 2500, Temp: 34, POH: 30000},
			{Dev: "sdk", Type: "hdd", Model: "Seagate IronWolf Pro 10 TB", Pool: "data", Role: "data, raid6 member", CapGB: 10000, UsedGB: 2500, Temp: 34, POH: 30000},
			{Dev: "sdf", Type: "hdd", Model: "Seagate IronWolf Pro 10 TB", Pool: "data", Role: "data, raid6 member", CapGB: 10000, UsedGB: 2500, Temp: 37, POH: 30000},
			{Dev: "sdh", Type: "hdd", Model: "Seagate IronWolf 12 TB", Pool: "storage", Role: "storage, raid1 member", CapGB: 12000, UsedGB: 1400, Temp: 36, POH: 26000},
			{Dev: "sdq", Type: "hdd", Model: "Seagate IronWolf 12 TB", Pool: "storage", Role: "storage, raid1 member", CapGB: 12000, UsedGB: 1400, Temp: 34, POH: 26000},
		},
		KVM:    intelKVM(18),
		Docker: true, Libvirt: true, Policy: proto.Policy{Console: true, Power: true},
	}
	on, off := true, false
	app := func(id, image string, cpu float64, mem uint64, tmpl bool, auto *bool, webui string, update bool) GuestSpec {
		g := dk(id, image, cpu, mem, 0, 19*day)
		g.UnraidTemplate, g.Autostart, g.WebUI = tmpl, auto, webui
		u := update
		g.Update = &u
		return g
	}
	h.Guests = []GuestSpec{
		app("plex", "lscr.io/linuxserver/plex", 6.2, 1900, true, &on, "http://10.30.0.40:32400/web/index.html", true),
		app("sonarr", "lscr.io/linuxserver/sonarr", 1.1, 420, true, &on, "http://10.30.0.40:8989/system/status", false),
		app("radarr", "lscr.io/linuxserver/radarr:latest", 0.9, 380, true, &on, "http://10.30.0.40:7878/", false),
		app("prowlarr", "lscr.io/linuxserver/prowlarr:latest", 0.4, 210, true, &on, "http://10.30.0.40:9696/", false),
		app("sabnzbd", "lscr.io/linuxserver/sabnzbd:latest", 2.4, 650, true, &on, "http://10.30.0.40:8080/", false),
		app("overseerr", "lscr.io/linuxserver/overseerr:latest", 0.3, 240, true, &off, "http://10.30.0.40:5055", false),
		app("immich_server", "ghcr.io/immich-app/immich-server:release", 3.5, 1500, false, &off, "", false),
		app("immich_postgres", "tensorchord/pgvecto-rs:pg14-v0.2.0", 1.2, 520, false, &off, "", false),
	}
	stopped := dkStopped("makemkv", "jlesage/makemkv")
	stopped.UnraidTemplate, stopped.Autostart = true, &off
	h.Guests = append(h.Guests, stopped)
	pbs := lvVM("pbs", "q35 · OVMF", "running", 4, 3.4, 6100, 8, 6, 22, 30, 4, 1, 19*day, vmProtosFull, "1024x768")
	pbs.Autostart = &on
	win := lvVM("win11", "q35 · OVMF · TPM", "stopped", 4, 0, 0, 8, 0, 0, 0, 0, 0, 0, vmProtosNoSer, "1920x1080")
	win.Autostart = &off
	h.Guests = append(h.Guests, pbs, win)
	h.Unraid = blackboxUnraid()
	h.Guests = append(h.Guests, placeGuests(PlaceClient)...)
	h.BackupPlace = blackboxPlace()
	return h
}

func blackboxUnraid() *proto.Unraid {
	tib := func(n float64) uint64 { return uint64(n * (1 << 40)) }
	gib := func(n float64) uint64 { return uint64(n * (1 << 30)) }
	t := func(n float64) *float64 { return &n }
	disk := func(name, slot, pool, dev, model, serial, fs string, size uint64, temp float64, rot bool) proto.UnraidDisk {
		r := rot
		d := proto.UnraidDisk{Name: name, Slot: slot, Pool: pool, Device: dev, Model: model, Serial: serial, Status: "ok", StatusRaw: "DISK_OK",
			SizeBytes: size, FSType: fs, TempC: t(temp), Rotational: &r}
		return d
	}
	used := func(d proto.UnraidDisk, u, f uint64) proto.UnraidDisk {
		d.UsedBytes, d.FreeBytes = &u, &f
		return d
	}
	ago := func(days int) time.Time { return Ref.Add(-time.Duration(days) * 24 * time.Hour) }
	dur := func(s int64) *int64 { return &s }
	pools := []proto.UnraidPool{
		{Name: "apps", FSType: "luks:btrfs", Profile: "raid10", Status: "ONLINE", SizeBytes: tib(1.82), UsedBytes: gib(36), FreeBytes: tib(1.78),
			Disks: []proto.UnraidDisk{
				used(disk("apps", "pool", "apps", "sdb", "Samsung SSD 870 EVO 1TB", "SIM870A01", "luks:btrfs", gib(931), 31, false), gib(36), tib(1.78)),
				disk("apps2", "pool", "apps", "sdc", "Samsung SSD 870 EVO 1TB", "SIM870A02", "", gib(931), 31, false),
				disk("apps3", "pool", "apps", "sdd", "Samsung SSD 870 EVO 1TB", "SIM870A03", "", gib(931), 31, false),
				disk("apps4", "pool", "apps", "sde", "Samsung SSD 870 EVO 1TB", "SIM870A04", "", gib(931), 32, false),
			}},
		{Name: "data", FSType: "luks:btrfs", Profile: "raid6", Status: "ONLINE", SizeBytes: tib(81.9), UsedBytes: tib(20.3), FreeBytes: tib(43.4),
			Disks: []proto.UnraidDisk{
				used(disk("data", "pool", "data", "sdj", "ST10000NE0008-2PL103", "SIMIW1001", "luks:btrfs", tib(9.1), 34, true), tib(20.3), tib(43.4)),
				disk("data2", "pool", "data", "sdk", "ST10000NE0008-2PL103", "SIMIW1002", "", tib(9.1), 34, true),
				disk("data3", "pool", "data", "sdf", "ST10000NE0008-2PL103", "SIMIW1003", "", tib(9.1), 37, true),
			}},
		{Name: "storage", FSType: "luks:btrfs", Profile: "raid1", Status: "ONLINE", SizeBytes: tib(10.9), UsedBytes: tib(9.95), FreeBytes: gib(980),
			Disks: []proto.UnraidDisk{
				used(disk("storage", "pool", "storage", "sdh", "ST12000VN0008-2YS101", "SIMIW1201", "luks:btrfs", tib(10.9), 36, true), tib(9.95), gib(980)),
				disk("storage2", "pool", "storage", "sdq", "ST12000VN0008-2YS101", "SIMIW1202", "", tib(10.9), 34, true),
			}},
	}
	flash := used(disk("flash", "flash", "", "sda", "USB SanDisk 3.2Gen1", "SIMFLASH01", "vfat", gib(57.3), 0, true), gib(2.1), gib(55.2))
	flash.TempC = nil
	flash.Rotational = nil
	share := func(name, primary string, usedB, freeB uint64, smb string) proto.UnraidShare {
		return proto.UnraidShare{Name: name, Primary: primary, UsedBytes: usedB, FreeBytes: freeB, SMB: smb, Encrypted: true}
	}
	return &proto.Unraid{
		Version: "7.3.1", Name: "BlackBox", License: "Pro", OSUpdate: "7.3.3",
		Array: proto.UnraidArray{State: proto.UnraidArrayStarted, StateRaw: "STARTED", ConfigValid: true,
			SizeBytes: tib(1.82), UsedBytes: gib(13), FreeBytes: tib(1.8),
			Parity: proto.UnraidParity{State: "idle", Disks: 0,
				Last: &proto.UnraidParityRun{At: ago(460), DurationS: dur(52), Errors: 0, Result: "cancelled", Action: "check"},
				History: []proto.UnraidParityRun{
					{At: ago(460), DurationS: dur(52), Errors: 0, Result: "cancelled", Action: "check"},
					{At: ago(480), DurationS: dur(6947), SpeedMBs: t(288), Errors: 0, Result: "ok", Action: "check"},
					{At: ago(690), DurationS: dur(5994), SpeedMBs: t(333.7), Errors: 0, Result: "ok", Action: "rebuild"},
				}},
			Disks: []proto.UnraidDisk{used(disk("disk1", "data", "", "sdi", "WDC WDS200T1R0A-68A4W0", "SIMWD2001", "xfs", tib(1.82), 31, false), gib(13), tib(1.8))}},
		Pools: pools,
		Flash: &flash,
		Shares: []proto.UnraidShare{
			share("appdata", "apps", gib(36), tib(1.78), ""),
			share("domains", "apps", gib(120), tib(1.78), ""),
			share("isos", "data", gib(40), tib(43.4), "public"),
			share("Media", "data", tib(18.2), tib(43.4), "private"),
			share("Photos", "storage", tib(1.2), gib(980), "secure"),
			share("system", "apps", gib(25), tib(1.78), ""),
			{Name: "whombat-backups", Primary: "array", UsedBytes: gib(115), FreeBytes: tib(1.8)},
			{Name: "Downloads", Primary: "apps", Secondary: "array", MoverAction: "to_array", UsedBytes: gib(310), FreeBytes: tib(1.78), SMB: "public", NFS: true},
		},
		Plugins: []proto.UnraidPlugin{
			{Name: "community.applications", File: "community.applications.plg", Version: "2026.07.21", Author: "Lime Technology", SupportURL: "https://forums.unraid.net/topic/38582-plug-in-community-applications"},
			{Name: "fix.common.problems", File: "fix.common.problems.plg", Version: "2026.10.12", Author: "Lime Technology"},
			{Name: "tailscale", File: "tailscale.plg", Version: "2026.10.08.2310", Update: "2026.10.15.0900", Author: "Derek Kaser"},
			{Name: "unassigned.devices", File: "unassigned.devices.plg", Version: "2026.10.12", Update: "2026.10.16", Author: "dlandon"},
			{Name: "unassigned.devices-plus", File: "unassigned.devices-plus.plg", Version: "2025.08.05a", Author: "dlandon"},
		},
		Notifications: []proto.UnraidNotification{
			{ID: "Docker_critical_image_disk_utilization_1760180400", At: Ref.Add(-3 * time.Hour), Importance: "alert",
				Event: "Docker critical image disk utilization", Subject: "Alert [BLACKBOX] - Docker image disk utilization of 91%",
				Description: "Docker utilization of image file /mnt/user/system/docker/docker.img"},
			{ID: "System___Unraid_7.3.3_ticket", At: Ref.Add(-26 * time.Hour), Importance: "normal",
				Event: "System - Unraid [7.3.3]", Subject: "Notice [BLACKBOX] - Version update 7.3.3", Description: "A new version of Unraid is available"},
		},
		NotificationsUnread: 2,
		Docker:              proto.UnraidService{Enabled: true, ImageUsedPct: t(91)},
		VMs:                 proto.UnraidService{Enabled: true},
		Encrypted:           true,
		LANAddress:          "10.30.0.40",
	}
}

// cloneUnraid deep-copies an unRAID detail.
func cloneUnraid(u *proto.Unraid) *proto.Unraid {
	b, _ := json.Marshal(u)
	var out proto.Unraid
	_ = json.Unmarshal(b, &out)
	return &out
}

// addUnraid fills the unRAID parts of blackbox's report: the detail (a
// running parity check moves with the clock), the Unraid array, the
// install and the collectors.
func (h *Host) addUnraid(r *proto.Report, t time.Time) {
	if h.Unraid == nil {
		return
	}
	u := cloneUnraid(h.Unraid)
	if p := &u.Array.Parity; p.State == "running" && h.parityStarted != nil {
		pct := h.parityPct(t)
		p.Pct, p.SpeedMBs = f(round1(pct)), f(270)
		eta := int64((100 - pct) / 100 * ParityCheckTime.Seconds())
		p.ETAS = &eta
	}
	r.Unraid = u
	r.Agent.Install = "unraid"
	errs := uint64(0)
	if u.Array.Parity.Last != nil {
		errs = u.Array.Parity.Last.Errors
	}
	state := "clean"
	switch {
	case u.Array.State != proto.UnraidArrayStarted:
		state = "stopped"
	case u.Array.Parity.State != "idle":
		state = "checking"
	}
	r.RAID = []proto.RAIDArray{{Name: "unraid", Level: "unraid", State: state, Devices: len(u.Array.Disks), Active: len(u.Array.Disks),
		Members: []string{"disk1"}, LastCheckErrors: &errs}}
	if r.System != nil {
		r.System.PackageManager, r.System.InitSystem, r.System.UpdatesPending, r.System.SecurityUpdates = "", "unraid", nil, nil
	}
	r.Collectors = append(r.Collectors, proto.CollectorStatus{Name: "unraid", OK: true, LastRun: t, DurationMs: 4},
		proto.CollectorStatus{Name: "raid", OK: true, LastRun: t, DurationMs: 1})
	// Docker on unRAID: dockerMan's update status wins over the drifting
	// report's.
	if r.Docker != nil {
		for i := range r.Docker.Guests {
			g := &r.Docker.Guests[i]
			for _, s := range h.Guests {
				if s.Platform == proto.PlatformDocker && s.ID == g.ID && s.Update != nil {
					v := *s.Update
					g.UpdateAvailable = &v
				}
			}
		}
	}
}

// UpdateUnraid changes blackbox's unRAID state (rackoon-sim's simulated
// operations); false when the host has none.
func (h *Host) UpdateUnraid(f func(u *proto.Unraid)) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.Unraid == nil {
		return false
	}
	f(h.Unraid)
	return true
}

// UnraidState returns a copy of the host's unRAID state (nil: none).
func (h *Host) UnraidState() *proto.Unraid {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.Unraid == nil {
		return nil
	}
	return cloneUnraid(h.Unraid)
}

// ParityCheckTime is how long the simulated parity check of blackbox's
// 2 TB data disk takes (tests shorten it).
var ParityCheckTime = 2 * time.Hour

// parityPct is the running check's progress at t (caller holds h.mu).
func (h *Host) parityPct(t time.Time) float64 {
	if h.parityStarted == nil {
		return h.parityBase
	}
	return clamp(t.Sub(*h.parityStarted).Seconds()/ParityCheckTime.Seconds()*100+h.parityBase, 0, 100)
}

// ParityPct is the simulated parity check's progress now (the paused
// value while paused).
func (h *Host) ParityPct() float64 {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.parityPct(time.Now())
}

// StartParity starts (pct 0) or continues (from the paused pct) the
// simulated parity check's clock; nil stops it.
func (h *Host) StartParity(at *time.Time, base float64) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.parityStarted, h.parityBase = at, base
}
