package fakefleet

import (
	"time"

	"rackoon/internal/proto"
)

// The libvirt host of the fake fleet: kvm-lab, a Debian 13 server whose
// VMs libvirt runs (QEMU/KVM, IU-13): the pool "default", the NAT network
// "default" with DHCP, UEFI with Secure Boot and a TPM emulator, three
// VMs (web, a Windows 11 desktop with UEFI and a TPM, and a stopped lab
// VM) and a backup of web. Not in Fleet() (the fixture hosts):
// rackoon-sim --libvirt adds it and answers its libvirt operations.

// KVMLab returns the libvirt host.
func KVMLab() *Host {
	day := int64(86400)
	h := &Host{
		ID: "kvm-lab", Group: "Lab", Location: "Lab shelf 3",
		OSName: "Debian GNU/Linux", OSVersion: "13", Pretty: "Debian GNU/Linux 13 (trixie)", Kernel: "6.12.48+deb13-amd64",
		CPUModel: "Ryzen 7 7700", Cores: 8, Threads: 16, MemGiB: 64, MemType: "DDR5", Address: "10.30.0.52",
		UptimeS: 12 * day, CPU: 18, User: 12, Sys: 4, IOWait: 1, Load: [3]float64{2.4, 2.2, 2.0},
		MemUsedGiB: 22, CacheGiB: 18, Free: 20, SwapTotal: 4,
		Sensors: []SensorSpec{cpuSensor(54, "k10temp · Tctl"), nvmeSensor(41, "nvme0n1")},
		Disks: []DiskSpec{
			{Dev: "nvme0n1", Type: "nvme", Model: "Samsung 990 PRO 2 TB", Role: "System · /, /var/lib/libvirt/images", CapGB: 2000, UsedGB: 610, Wear: f(4), WrittenTB: 48, RatedTBW: 1200, Temp: 41, POH: 6100},
		},
		KVM:     amdKVM(16, 0, 0, 0, 0.6),
		Libvirt: true, Policy: proto.Policy{Console: true, Power: true},
		LibvirtDetail: &proto.LibvirtDetail{
			QEMU: "10.0.13",
			Pools: []proto.LibvirtPool{{Name: "default", Type: "dir", Active: true, Autostart: true, Path: "/var/lib/libvirt/images",
				UsedBytes: 610e9, TotalBytes: 1900e9, AvailBytes: 1290e9, Volumes: 5}},
			Networks: []proto.LibvirtNetwork{{Name: "default", Active: true, Autostart: true, Bridge: "virbr0", Forward: "nat",
				IPv4: "192.168.122.1/24", DHCP: true, UsedBy: 3}},
			Firmware:   proto.LibvirtFirmware{UEFI: true, SecureBoot: true, TPM: true},
			BackupsDir: "/var/lib/libvirt/images/.whombat-backups",
		},
		LibvirtBackups: map[string]time.Duration{"web": 30 * time.Hour},
	}
	web := lvVM("web", "q35 · SeaBIOS", "running", 2, 6.4, 1650, 4, 0.8, 2.1, 1.2, 0.6, 0, 11*day, vmProtosFull, "1024x768")
	web.MACs = []string{"52:54:00:6b:1e:01"}
	win := lvVM("win11", "q35 · OVMF · TPM", "running", 4, 11.2, 7400, 8, 6, 14, 2, 1, 2, 3*day, []string{proto.ProtoVNC}, "1920x1080")
	win.MACs = []string{"52:54:00:6b:1e:02"}
	lab := lvVM("lab", "q35 · SeaBIOS", "stopped", 2, 0, 0, 2, 0, 0, 0, 0, 0, 0, vmProtosFull, "1024x768")
	lab.MACs = []string{"52:54:00:6b:1e:03"}
	h.Guests = []GuestSpec{web, win, lab}
	return h
}

// addLibvirt puts the libvirt host view and each VM's newest backup into
// a report.
func (h *Host) addLibvirt(r *proto.Report, t time.Time) {
	if r.Libvirt == nil || h.LibvirtDetail == nil {
		return
	}
	d := *h.LibvirtDetail
	d.Pools = append([]proto.LibvirtPool(nil), d.Pools...)
	d.Networks = append([]proto.LibvirtNetwork(nil), d.Networks...)
	r.Libvirt.Libvirt = &d
	for i := range r.Libvirt.Guests {
		g := &r.Libvirt.Guests[i]
		if age, ok := h.LibvirtBackups[g.ID]; ok {
			g.LastBackup = &proto.BackupMark{Result: "ok", At: t.Add(-age).UTC().Truncate(time.Second)}
		}
		for _, s := range h.Guests {
			if s.Platform == proto.PlatformLibvirt && s.ID == g.ID && len(s.MACs) > 0 {
				g.MACs = append([]string(nil), s.MACs...)
			}
		}
	}
}
