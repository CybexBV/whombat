package fakefleet

import (
	"fmt"
	"time"

	"rackoon/internal/proto"
)

// addHealth fills the host health parts of a drifting report (not the
// exact fixture): system info, pressure, network, disk I/O, fans and a few
// host-specific extras (a UPS, an md array, a GPU, failed units, PVE
// tasks), deterministic per host and timestamp.
func (h *Host) addHealth(r *proto.Report, t time.Time) {
	hv := hash(h.ID)
	ps := h.packagesLocked(t) // packages.go: rackoon-sim's package tasks change it
	updates, security := ps.Pending, ps.Security
	r.System = &proto.SystemInfo{
		PackageManager: "apt", UpdatesPending: &updates, SecurityUpdates: &security, UpdatesCheckedAt: ps.CheckedAt,
		InitSystem: "systemd", OOMKills: hv % 3, ProcessCount: 180 + int(hv%300), Arch: "amd64",
		TimeSynced: ptrB(true), TimeOffsetMs: f(round1(0.4 + 2*noise(h.ID+"/ntp", t.Unix()/60))), TimeSource: "chrony",
		RebootRequired: ps.Reboot, RebootReason: ps.RebootReason, PackageTask: ps.Task, PackageLast: ps.Last,
	}
	// Out-of-memory kills (LM-04): every host tells the machine's from
	// those at a cgroup's own limit; granite's elasticsearch hit its
	// container limit, a test on onyx its own slice's.
	limitKills := uint64(0)
	r.System.OOMLimitKills = &limitKills
	switch h.ID {
	case "granite":
		r.System.OOMKills, limitKills = hv%3+1, 1
		r.System.OOMLimited = []proto.OOMKill{{At: t.Add(-17 * time.Minute), Process: "java",
			Cgroup:   "/system.slice/docker-" + fmt.Sprintf("%064x", hv) + ".scope",
			Platform: proto.PlatformDocker, GuestID: "elasticsearch"}}
	case "onyx":
		r.System.OOMKills, limitKills = hv%3+1, 1
		r.System.OOMLimited = []proto.OOMKill{{At: t.Add(-40 * time.Minute), Process: "python3",
			Cgroup: "/user.slice/user-1000.slice/user@1000.service/app.slice/nightly-tests.slice"}}
	}
	if h.ID == "quartz" {
		r.System.FailedCount = 2
		r.System.FailedUnits = []string{"certbot-renew.service", "smartd.service"}
		r.System.TimeSynced = ptrB(false)
		r.System.TimeOffsetMs = f(2480)
	}
	cpu := r.CPU.UsagePct
	r.Pressure = &proto.Pressure{CPUSome: round1(cpu / 8), MemorySome: round1(0.2 * wave(h.ID+"/psi", t)),
		IOSome: round1(r.CPU.IOWaitPct * 2), IOFull: round1(r.CPU.IOWaitPct)}

	// Network: the uplink (a bond on the bigger hosts) plus an unused port.
	rx := clamp(h.vary("rx", 40+float64(hv%200), 0.5, t), 0.1, 9000) * 1e6 / 8
	tx := clamp(h.vary("tx", 12+float64(hv%60), 0.5, t), 0.1, 9000) * 1e6 / 8
	addr := h.Address + "/24"
	if h.Cores >= 16 {
		r.Net = append(r.Net,
			proto.NetIface{Name: "bond0", Kind: "bond", Up: true, Carrier: true, SpeedMbps: 20000, MTU: 9000, Addresses: []string{addr},
				Members: []string{"enp65s0f0", "enp65s0f1"}, RxBps: rx, TxBps: tx},
			proto.NetIface{Name: "enp65s0f0", Kind: "ethernet", Up: true, Carrier: true, SpeedMbps: 10000, MTU: 9000, Master: "bond0",
				MAC: fmt.Sprintf("3c:ec:ef:%02x:%02x:10", hv&0xff, hv>>8&0xff), RxBps: rx / 2, TxBps: tx / 2},
			proto.NetIface{Name: "enp65s0f1", Kind: "ethernet", Up: true, Carrier: true, SpeedMbps: 10000, MTU: 9000, Master: "bond0",
				MAC: fmt.Sprintf("3c:ec:ef:%02x:%02x:11", hv&0xff, hv>>8&0xff), RxBps: rx / 2, TxBps: tx / 2, RxDrops: hv % 50},
		)
	} else {
		r.Net = append(r.Net, proto.NetIface{Name: "eno1", Kind: "ethernet", Up: true, Carrier: true, SpeedMbps: 1000, MTU: 1500,
			Addresses: []string{addr}, MAC: fmt.Sprintf("a8:a1:59:%02x:%02x:01", hv&0xff, hv>>8&0xff), RxBps: rx / 10, TxBps: tx / 10})
	}
	r.Net = append(r.Net, proto.NetIface{Name: "eno2", Kind: "ethernet", MTU: 1500, MAC: fmt.Sprintf("a8:a1:59:%02x:%02x:02", hv&0xff, hv>>8&0xff)})

	// Disk I/O follows the guests' I/O.
	for i := range r.Disks {
		d := &r.Disks[i]
		rd := clamp(h.vary("rd/"+d.Device, 8+float64(hash(d.Device)%40), 0.8, t), 0, 3000) * 1e6
		wr := clamp(h.vary("wr/"+d.Device, 4+float64(hash(d.Device)%30), 0.8, t), 0, 3000) * 1e6
		d.IO = &proto.DiskIO{ReadBps: rd, WriteBps: wr, ReadIOPS: rd / 65536, WriteIOPS: wr / 32768,
			UtilPct: round1(clamp((rd+wr)/2e7, 0, 100)), AwaitMs: round1(0.2 + float64(hash(d.Device)%5))}
		if d.Type == "hdd" {
			d.SelfTest = &proto.SelfTest{Type: "short", Result: "passed", PowerOnHours: 41000}
			d.CRCErrors = ptrU(0)
		} else if d.Type == "nvme" {
			d.CriticalWarning, d.SparePct, d.SpareThreshold = ptrU(0), f(100), f(10)
			d.MediaErrors, d.UnsafeShutdowns = ptrU(0), ptrU(hv%40)
		}
	}
	for i := range r.Pools {
		p := &r.Pools[i]
		p.ScrubState, p.ScrubEnd = "finished", Ref.Add(-time.Duration(48+hv%300)*time.Hour)
		p.FragPct = f(float64(hv % 40))
	}
	for i := range r.Filesystems {
		fs := &r.Filesystems[i]
		fs.InodesTotal = fs.SizeBytes / 16384
		fs.InodesUsed = fs.InodesTotal / uint64(3+hv%7)
	}

	// Fans next to the board sensor.
	if len(h.Sensors) > 1 {
		r.Fans = []proto.Fan{
			{Label: "CPU fan", Source: "nct6798 · fan2", RPM: round1(h.vary("fan1", 1150, 0.08, t)), MinRPM: 300},
			{Label: "System fan 1", Source: "nct6798 · fan1", RPM: round1(h.vary("fan2", 820, 0.05, t))},
		}
	}

	switch h.ID {
	case "basalt":
		r.UPS = []proto.UPS{{Name: "rack-a", Source: "nut", Model: "Eaton 5PX 1500", Status: "online", StatusRaw: "OL",
			ChargePct: f(100), RuntimeS: ip(2520), LoadPct: f(round1(h.vary("ups", 31, 0.1, t)))}}
		r.GPUs = []proto.GPU{{Index: 0, Name: "NVIDIA RTX A4000", Vendor: "nvidia", UtilPct: f(round1(clamp(h.vary("gpu", 22, 0.6, t), 0, 100))),
			MemUsedBytes: ptrU(5 * gib), MemTotalBytes: ptrU(16 * gib), TempC: f(round1(h.vary("gput", 54, 0.05, t))), PowerW: f(round1(h.vary("gpuw", 61, 0.2, t)))}}
	case "onyx":
		r.RAID = []proto.RAIDArray{{Name: "md0", Level: "raid1", State: "clean", Devices: 2, Active: 2, Members: []string{"sda", "sdb"},
			SizeBytes: 4e12, LastCheck: Ref.Add(-9 * 24 * time.Hour), LastCheckErrors: ptrU(0)}}
	case "shale":
		if r.PVE != nil {
			end := t.Add(-5 * time.Hour)
			r.PVE.Tasks = []proto.PVETask{
				{UPID: "UPID:shale:1", Type: "vzdump", ID: "107", Node: "shale", User: "root@pam", Start: end.Add(-12 * time.Minute), End: &end,
					Status: "unable to create temporary directory '/var/tmp/vzdumptmp'", OK: false},
			}
			r.PVE.Replication = []proto.PVEReplication{{ID: "101-0", Guest: "101", Target: "granite-pve", LastSync: t.Add(-7 * time.Minute)}}
		}
	}
	if r.Incus != nil && h.ID == "basalt" {
		r.Incus.Warnings = []proto.PlatformWarning{{Type: "AppArmor support has been disabled", Message: "Skipping AppArmor initialization: kernel has no support", Count: 3, LastSeen: t.Add(-2 * time.Hour)}}
	}
	if r.Docker != nil {
		for i := range r.Docker.Guests {
			g := &r.Docker.Guests[i]
			if g.State == proto.StateStopped {
				code := 137
				g.ExitCode, g.OOMKilled = &code, i%2 == 0
			}
			n := int(hash(g.ID) % 3)
			g.RestartCount = &n
			g.Project = "stack"
			if i == 0 {
				up := true
				g.UpdateAvailable = &up
			}
		}
	}
}

func ptrB(b bool) *bool { return &b }
