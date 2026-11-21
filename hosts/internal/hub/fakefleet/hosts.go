package fakefleet

import (
	"fmt"
	"time"

	"rackoon/internal/proto"
)

var (
	vmProtosFull  = []string{proto.ProtoVNC, proto.ProtoSPICE, proto.ProtoSerial}
	vmProtosNoSer = []string{proto.ProtoVNC, proto.ProtoSPICE}
	incusVM       = []string{proto.ProtoSPICE, proto.ProtoSerial}
	ctProtos      = []string{proto.ProtoShell, proto.ProtoTTY}
)

func dk(id, image string, cpu float64, used, limit uint64, up int64) GuestSpec {
	return GuestSpec{Platform: proto.PlatformDocker, ID: id, Kind: "container", Image: image, State: proto.StateRunning,
		CPU: cpu, MemUsedMB: used, MemLimMB: limit, UptimeS: up}
}

func dkStopped(id, image string) GuestSpec {
	return GuestSpec{Platform: proto.PlatformDocker, ID: id, Kind: "container", Image: image, State: proto.StateStopped}
}

func dkUnhealthy(id, image string, cpu float64, used uint64) GuestSpec {
	g := dk(id, image, cpu, used, 0, 86400*3)
	g.State = proto.StateUnhealthy
	return g
}

func incVM(id, image, state string, vcpu int, cpu float64, used, cfgGiB uint64, rd, wr, rx, tx float64, snaps int, up int64) GuestSpec {
	g := GuestSpec{Platform: proto.PlatformIncus, ID: id, Kind: "vm", Image: image, State: state, VCPU: vcpu, CPU: cpu,
		MemUsedMB: used, MemLimMB: cfgGiB * 1024, MemCfgGiB: cfgGiB, Read: rd, Write: wr, Rx: rx, Tx: tx, Snapshots: ip(snaps),
		UptimeS: up, Protocols: incusVM, Default: proto.ProtoSPICE, Res: "1280x800"}
	return g
}

func incCT(id, image, state string, vcpu int, cpu float64, used, limit uint64, rd, wr, rx, tx float64, snaps int, up int64) GuestSpec {
	return GuestSpec{Platform: proto.PlatformIncus, ID: id, Kind: "container", Image: image, State: state, VCPU: vcpu, CPU: cpu,
		MemUsedMB: used, MemLimMB: limit, Read: rd, Write: wr, Rx: rx, Tx: tx, Snapshots: ip(snaps), UptimeS: up,
		Protocols: ctProtos, Default: proto.ProtoShell, Res: "132x36"}
}

func lvVM(id, image, state string, vcpu int, cpu float64, used, cfgGiB uint64, rd, wr, rx, tx float64, snaps int, up int64, protos []string, res string) GuestSpec {
	return GuestSpec{Platform: proto.PlatformLibvirt, ID: id, Kind: "vm", Image: image, State: state, VCPU: vcpu, CPU: cpu,
		MemUsedMB: used, MemLimMB: cfgGiB * 1024, MemCfgGiB: cfgGiB, Read: rd, Write: wr, Rx: rx, Tx: tx, Snapshots: ip(snaps),
		UptimeS: up, Protocols: protos, Default: proto.ProtoVNC, Res: res}
}

func pveVM(vmid int, name, image, state string, vcpu int, cpu float64, used, cfgGiB uint64, rd, wr, rx, tx float64, up int64, protos []string, res string, balloon bool) GuestSpec {
	return GuestSpec{Platform: proto.PlatformPVE, ID: fmt.Sprint(vmid), Name: name, Kind: "vm", Image: image, State: state,
		VCPU: vcpu, CPU: cpu, MemUsedMB: used, MemLimMB: cfgGiB * 1024, MemCfgGiB: cfgGiB, Read: rd, Write: wr, Rx: rx, Tx: tx,
		UptimeS: up, Protocols: protos, Default: proto.ProtoVNC, Res: res, VMID: vmid, Backup: "ok", Balloon: balloon}
}

func pveCT(vmid int, name, image string, vcpu int, cpu float64, used, limit uint64, rd, wr, rx, tx float64, up int64) GuestSpec {
	return GuestSpec{Platform: proto.PlatformPVE, ID: fmt.Sprint(vmid), Name: name, Kind: "container", Image: image,
		State: proto.StateRunning, VCPU: vcpu, CPU: cpu, MemUsedMB: used, MemLimMB: limit, Read: rd, Write: wr, Rx: rx, Tx: tx,
		UptimeS: up, Protocols: ctProtos, Default: proto.ProtoShell, Res: "132x36", VMID: vmid, Backup: "ok"}
}

var fillerImages = []string{
	"gitea/gitea", "minio/minio", "quay.io/keycloak/keycloak", "vaultwarden/server", "paperlessngx/paperless-ngx",
	"nginx", "authelia/authelia", "bitnami/pgbouncer", "pihole/pihole", "mvance/unbound", "syncthing/syncthing",
	"ghcr.io/gethomepage/homepage", "freshrss/freshrss", "requarks/wiki", "outlinewiki/outline", "n8nio/n8n",
	"getmeili/meilisearch", "rabbitmq", "axllent/mailpit", "adminer", "louislam/uptime-kuma", "containrrr/watchtower",
	"prom/node-exporter", "gcr.io/cadvisor/cadvisor", "prom/alertmanager", "postgres", "mariadb", "memcached",
	"eclipse-mosquitto", "nodered/node-red", "esphome/esphome", "zigbee2mqtt", "linuxserver/sonarr",
}

// fillDocker appends generic containers until the host has the given
// counts (running, stopped, unhealthy), all quieter than the named ones.
func fillDocker(gs []GuestSpec, running, stopped, unhealthy int) []GuestSpec {
	var r, s, u int
	used := map[string]bool{}
	for _, g := range gs {
		if g.Platform != proto.PlatformDocker {
			continue
		}
		used[g.ID] = true
		switch g.State {
		case proto.StateRunning:
			r++
		case proto.StateStopped:
			s++
		default:
			u++
		}
	}
	i := 0
	next := func() (string, string) {
		for {
			img := fillerImages[i%len(fillerImages)]
			i++
			name := img
			for j := len(img) - 1; j >= 0; j-- {
				if img[j] == '/' {
					name = img[j+1:]
					break
				}
			}
			if i > len(fillerImages) {
				name = fmt.Sprintf("%s-%d", name, i/len(fillerImages)+1)
			}
			if !used[name] {
				used[name] = true
				return name, img
			}
		}
	}
	for ; r < running; r++ {
		n, img := next()
		gs = append(gs, dk(n, img, 0.1+float64(i%5)*0.1, 40+uint64(i*13%300), 0, 86400*int64(3+i%40)))
	}
	for ; s < stopped; s++ {
		n, img := next()
		gs = append(gs, dkStopped(n, img))
	}
	for ; u < unhealthy; u++ {
		n, img := next()
		gs = append(gs, dkUnhealthy(n, img, 0.8, 220))
	}
	return gs
}

func amdKVM(groups, vfio, hp int, hpSize uint64, ksmGiB float64) *proto.KVM {
	return &proto.KVM{Enabled: true, Module: "kvm_amd", Device: "/dev/kvm", CPUVirtType: "AMD-V", CPUFlag: "svm",
		NestedPaging: true, IOMMUEnabled: true, IOMMUGroups: groups, VFIOPCIDevices: vfio, NestedEnabled: true,
		NestedParam: "kvm_amd nested=1", HugepagesCount: hp, HugepageSize: hpSize, KSMRunning: ksmGiB > 0,
		KSMSavedBytes: uint64(ksmGiB * gib)}
}

func intelKVM(groups int) *proto.KVM {
	return &proto.KVM{Enabled: true, Module: "kvm_intel", Device: "/dev/kvm", CPUVirtType: "Intel VT-x", CPUFlag: "vmx",
		NestedPaging: true, IOMMUEnabled: true, IOMMUGroups: groups, NestedEnabled: true, NestedParam: "kvm_intel nested=1",
		HugepageSize: 2 << 20}
}

func cpuSensor(temp float64, source string) SensorSpec {
	return SensorSpec{ID: proto.SensorCPU, Label: "CPU package", Group: "cpu", Source: source, Temp: temp, Limit: 85}
}

func nvmeSensor(temp float64, dev string) SensorSpec {
	return SensorSpec{ID: proto.SensorNVMe, Label: "NVMe, hottest", Group: "nvme", Source: dev + " · composite", Temp: temp, Limit: 75}
}

// Fleet returns the eight fixture hosts in card order.
func Fleet() []*Host {
	day := int64(86400)
	allow := proto.Policy{Console: true, Power: true}

	basalt := &Host{
		ID: "basalt", Group: "Production", Location: "Rack A · unit 4",
		OSName: "NixOS", OSVersion: "26.05", Pretty: "NixOS 26.05 (Yarara)", Kernel: "6.18.44",
		CPUModel: "EPYC 7443P", Cores: 24, Threads: 48, MemGiB: 256, MemType: "DDR4 ECC", Address: "10.20.0.11",
		UptimeS: 3567600, CPU: 34, User: 22.4, Sys: 9.2, IOWait: 2.4, Load: [3]float64{6.2, 5.8, 5.3},
		MemUsedGiB: 156, CacheGiB: 71, Free: 29, SwapUsed: 0.3, SwapTotal: 16,
		Sensors: []SensorSpec{
			cpuSensor(64, "k10temp · Tctl"),
			{ID: proto.SensorBoard, Label: "Board / VRM", Group: "board", Source: "nct6798 · SYSTIN", Temp: 57, Limit: 90},
			nvmeSensor(49, "nvme1n1"),
			{ID: proto.SensorDIMM, Label: "Memory modules", Group: "memory", Source: "jc42 · 4 sensors", Temp: 42, Limit: 85},
			{ID: proto.SensorHDD, Label: "HDD, hottest", Group: "hdd", Source: "sda · SMART", Temp: 36, Limit: 55},
		},
		Disks: []DiskSpec{
			{Dev: "nvme0n1", Type: "nvme", Model: "Samsung 990 PRO 1 TB", Role: "System · /, /nix", CapGB: 1000, UsedGB: 440, Wear: f(6), WrittenTB: 36, RatedTBW: 600, Temp: 44, POH: 9846},
			{Dev: "nvme1n1", Type: "nvme", Model: "Samsung 990 PRO 2 TB", Role: "Incus storage pool · /var/lib/incus", CapGB: 2000, UsedGB: 1420, Wear: f(78), WrittenTB: 936, RatedTBW: 1200, Temp: 49, POH: 14210},
			{Dev: "sda", Type: "hdd", Model: "Seagate Exos X18 16 TB", Role: "tank, mirror member · /srv/tank", Pool: "tank", CapGB: 16000, UsedGB: 10240, Temp: 36, POH: 21904},
			{Dev: "sdb", Type: "hdd", Model: "Seagate Exos X18 16 TB", Role: "tank, mirror member · /srv/tank", Pool: "tank", CapGB: 16000, UsedGB: 10240, Temp: 35, POH: 21901, Realloc: 8},
		},
		KVM:    amdKVM(14, 1, 32, 1<<30, 3.1),
		Docker: true, Incus: true, Libvirt: true, Policy: allow,
	}
	basalt.Guests = fillDocker([]GuestSpec{
		dk("prometheus", "prom/prometheus", 12.4, 2150, 4096, 3542400),
		dk("nextcloud-app", "nextcloud", 6.7, 1434, 2048, 777600),
		dk("loki", "grafana/loki", 4.8, 1229, 2048, 3542400),
		dk("grafana", "grafana/grafana", 3.1, 380, 1024, 3542400),
		dk("traefik", "traefik", 2.2, 96, 0, 1036800),
		dk("mosquitto", "eclipse-mosquitto", 0.7, 18, 0, 3542400),
		dk("redis", "redis", 0.6, 54, 0, 3542400),
		dkStopped("backup-job", "restic/restic"),
	}, 14, 2, 0)
	basalt.Guests = append(basalt.Guests,
		incVM("nixbuild", "nixos/26.05", "running", 8, 21.5, 10035, 16, 42, 118, 12, 4, 3, 518400),
		incVM("ci-runner", "debian/13", "running", 4, 14.2, 5222, 8, 8, 31, 86, 22, 2, 259200),
		incCT("dev-shell", "nixos/26.05", "running", 4, 6.0, 1946, 4096, 1, 3, 3, 1, 1, 1555200),
		incCT("git-mirror", "alpine/3.22", "running", 2, 0.8, 128, 0, 0.2, 0.4, 1, 1, 1, 3542400),
		incCT("mqtt-bridge", "debian/13", "running", 1, 0.4, 110, 0, 0.1, 0.2, 0.4, 0.4, 0, 3542400),
		incCT("dns", "alpine/3.22", "running", 1, 0.3, 64, 0, 0, 0.1, 2, 2, 0, 3542400),
		incCT("scratch", "ubuntu/24.04", "stopped", 2, 0, 0, 0, 0, 0, 0, 0, 2, 0),
		lvVM("opnsense", "q35 · OVMF", "running", 4, 17.2, 3686, 8, 2, 1, 412, 380, 2, 3542400, vmProtosFull, "1024x768"),
		lvVM("win11-test", "q35 · OVMF · TPM", "running", 4, 9.8, 7578, 8, 28, 64, 6, 2, 1, 172800, vmProtosNoSer, "1920x1080"),
		lvVM("haos", "q35 · OVMF", "running", 2, 5.4, 3174, 4, 0.4, 1.2, 1, 1, 4, 3542400, vmProtosFull, "1024x768"),
		lvVM("truenas-lab", "q35 · OVMF", "stopped", 4, 0, 0, 16, 0, 0, 0, 0, 0, 0, vmProtosFull, "1024x768"),
	)

	granite := &Host{
		ID: "granite", Group: "Production", Location: "Rack A · unit 5",
		OSName: "Debian GNU/Linux", OSVersion: "13", Pretty: "Debian GNU/Linux 13 (trixie)", Kernel: "6.12.48+deb13-amd64",
		CPUModel: "Xeon E-2388G", Cores: 8, Threads: 16, MemGiB: 64, MemType: "DDR4 ECC", Address: "10.20.0.12",
		UptimeS: 21 * day, CPU: 22, User: 15, Sys: 5.5, IOWait: 1.5, Load: [3]float64{3.4, 3.1, 2.9},
		MemUsedGiB: 30.7, CacheGiB: 24, Free: 9.3, SwapTotal: 8,
		Sensors: []SensorSpec{cpuSensor(52, "coretemp · Package id 0"), nvmeSensor(44, "nvme0n1"),
			{ID: proto.SensorDIMM, Label: "Memory modules", Group: "memory", Source: "jc42 · 2 sensors", Temp: 39, Limit: 85}},
		Disks: []DiskSpec{
			{Dev: "nvme0n1", Type: "nvme", Model: "WD Red SN700 4 TB", Role: "System · /, /var/lib/docker", CapGB: 4000, UsedGB: 2320, Wear: f(11), WrittenTB: 560, RatedTBW: 5100, Temp: 44, POH: 18000},
			{Dev: "nvme1n1", Type: "nvme", Model: "WD Red SN700 4 TB", Role: "Backups · /srv/backup", CapGB: 4000, UsedGB: 2320, Wear: f(9), WrittenTB: 410, RatedTBW: 5100, Temp: 41, POH: 18000},
		},
		Docker: true, Policy: allow,
	}
	granite.Guests = fillDocker([]GuestSpec{
		dk("postgres-main", "postgres", 31, 6100, 8192, 21*day),
		dk("gitlab", "gitlab/gitlab-ce", 9.5, 5200, 8192, 21*day),
		dk("elasticsearch", "elasticsearch", 3.6, 4300, 6144, 21*day),
	}, 22, 3, 0)

	obsidian := &Host{
		ID: "obsidian", Group: "Production", Location: "Rack B · unit 2",
		OSName: "NixOS", OSVersion: "26.05", Pretty: "NixOS 26.05 (Yarara)", Kernel: "6.18.44",
		CPUModel: "Ryzen 9 7950X", Cores: 16, Threads: 32, MemGiB: 128, MemType: "DDR5", Address: "10.20.0.13",
		UptimeS: 12 * day, CPU: 47, User: 33, Sys: 11, IOWait: 3, Load: [3]float64{14.1, 13.2, 12.8},
		MemUsedGiB: 92.2, CacheGiB: 25, Free: 10.8, SwapTotal: 16,
		Sensors: []SensorSpec{cpuSensor(66, "k10temp · Tctl"), nvmeSensor(52, "nvme0n1"),
			{ID: proto.SensorHDD, Label: "HDD, hottest", Group: "hdd", Source: "sda · SMART", Temp: 38, Limit: 55}},
		Disks: []DiskSpec{
			{Dev: "nvme0n1", Type: "nvme", Model: "Samsung 990 PRO 2 TB", Role: "System · /, /var/lib/incus", CapGB: 2000, UsedGB: 1280, Wear: f(19), WrittenTB: 228, RatedTBW: 1200, Temp: 52, POH: 8800},
			{Dev: "sda", Type: "hdd", Model: "WD Red Plus 10 TB", Role: "Media · /srv/media", CapGB: 10000, UsedGB: 6400, Temp: 38, POH: 30100},
		},
		KVM:    amdKVM(18, 0, 0, 2<<20, 1.2),
		Docker: true, Incus: true, Policy: allow,
	}
	obsidian.Guests = fillDocker([]GuestSpec{
		dk("immich-ml", "ghcr.io/immich-app/immich-machine-learning", 24, 3900, 0, 12*day),
		dk("immich-server", "ghcr.io/immich-app/immich-server", 6.1, 1800, 0, 12*day),
	}, 9, 1, 1)
	obsidian.Guests = append(obsidian.Guests,
		incVM("ci-runner-03", "debian/13", "running", 6, 38, 9800, 12, 22, 60, 140, 40, 1, 4*day),
		incVM("win-dev", "windows/11", "running", 4, 8.2, 11200, 16, 6, 10, 4, 2, 2, 12*day),
		incVM("k8s-lab", "ubuntu/24.04", "running", 4, 6.5, 5100, 8, 3, 9, 20, 18, 0, 12*day),
		incCT("build-cache", "nixos/26.05", "running", 8, 21, 6200, 16384, 30, 45, 120, 300, 1, 12*day),
		incCT("matrix", "debian/13", "running", 2, 3.1, 1500, 4096, 1, 2, 6, 6, 2, 12*day),
		incCT("gitea", "alpine/3.22", "running", 2, 1.2, 420, 2048, 0.5, 0.8, 3, 4, 1, 12*day),
		incCT("mail", "debian/13", "running", 1, 0.9, 380, 1024, 0.2, 0.3, 1, 1, 0, 12*day),
		incCT("proxy", "alpine/3.22", "running", 1, 0.8, 90, 512, 0, 0.1, 30, 30, 0, 12*day),
		incCT("dns-2", "alpine/3.22", "running", 1, 0.3, 60, 256, 0, 0, 2, 2, 0, 12*day),
		incCT("monitoring", "debian/13", "running", 2, 2.4, 900, 2048, 0.4, 2, 2, 1, 1, 12*day),
		incCT("backup", "debian/13", "running", 1, 0.5, 200, 1024, 4, 1, 1, 8, 0, 12*day),
		incCT("old-wiki", "debian/12", "stopped", 1, 0, 0, 0, 0, 0, 0, 0, 3, 0),
		incCT("test-ct", "ubuntu/24.04", "stopped", 2, 0, 0, 0, 0, 0, 0, 0, 0, 0),
	)

	quartz := &Host{
		ID: "quartz", Group: "Lab", Location: "Lab shelf 1",
		OSName: "Ubuntu", OSVersion: "24.04 LTS", Pretty: "Ubuntu 24.04.3 LTS", Kernel: "6.8.0-85-generic",
		CPUModel: "Core i7-12700", Cores: 12, Threads: 20, MemGiB: 64, MemType: "DDR4", Address: "10.30.0.21",
		UptimeS: 33 * day, CPU: 12, User: 8, Sys: 3, IOWait: 1, Load: [3]float64{2.1, 2.0, 1.9},
		MemUsedGiB: 25, CacheGiB: 20, Free: 19, SwapTotal: 4,
		Sensors: []SensorSpec{cpuSensor(47, "coretemp · Package id 0"), nvmeSensor(41, "nvme0n1"),
			{ID: proto.SensorSATASS, Label: "SATA SSD, hottest", Group: "ssd", Source: "sda · SMART", Temp: 33, Limit: 70}},
		Disks: []DiskSpec{
			{Dev: "nvme0n1", Type: "nvme", Model: "Crucial P5 Plus 1 TB", Role: "System · /", CapGB: 1000, UsedGB: 330, Wear: f(6), WrittenTB: 36, RatedTBW: 600, Temp: 41, POH: 7000},
			{Dev: "sda", Type: "ssd", Model: "Samsung 870 EVO 4 TB", Role: "VM images · /var/lib/libvirt", CapGB: 3000, UsedGB: 990, Wear: f(4), WrittenTB: 96, RatedTBW: 2400, Temp: 33, POH: 7000},
		},
		KVM:    intelKVM(20),
		Docker: true, Incus: true, Libvirt: true, Policy: allow,
	}
	quartz.Guests = fillDocker([]GuestSpec{dk("homebox", "ghcr.io/hay-kot/homebox", 1.1, 120, 0, 33*day)}, 5, 0, 0)
	quartz.Guests = append(quartz.Guests,
		incVM("test-vm", "fedora/42", "running", 4, 5, 3900, 8, 1, 2, 1, 1, 0, 2*day),
		incCT("sandbox", "alpine/3.22", "running", 2, 1.4, 300, 2048, 0.1, 0.2, 1, 1, 0, 2*day),
		lvVM("vault-vm", "q35 · OVMF", "running", 4, 4, 2400, 4, 0.5, 0.6, 2, 2, 1, 33*day, vmProtosFull, "1024x768"),
		lvVM("old-win", "q35 · SeaBIOS", "stopped", 2, 0, 0, 4, 0, 0, 0, 0, 0, 0, vmProtosNoSer, "1024x768"),
	)

	// shale: Proxmox VE node in the 3-node cluster prod-pve.
	shale := &Host{
		ID: "shale", Group: "Production", Location: "Rack A · unit 7",
		OSName: "Proxmox VE", OSVersion: "9.0.3", Pretty: "Debian GNU/Linux 13 (trixie)", Kernel: "6.14.11-2-pve",
		CPUModel: "EPYC 9124", Cores: 16, Threads: 32, MemGiB: 192, MemType: "DDR5 ECC", Address: "10.20.0.15",
		UptimeS: 7614000, CPU: 71, User: 46.9, Sys: 19.2, IOWait: 5.0, Load: [3]float64{19.8, 18.4, 17.1},
		MemUsedGiB: 159, ARCGiB: 22, CacheGiB: 4, Free: 11, SwapTotal: 8,
		Sensors: []SensorSpec{
			cpuSensor(83, "k10temp · Tctl"),
			{ID: proto.SensorBoard, Label: "Board / VRM", Group: "board", Source: "ipmi · VRM temp", Temp: 66, Limit: 90},
			nvmeSensor(56, "nvme2n1"),
			{ID: proto.SensorDIMM, Label: "Memory modules", Group: "memory", Source: "jc42 · 12 sensors", Temp: 47, Limit: 85},
			{ID: proto.SensorSATASS, Label: "SATA SSD, hottest", Group: "ssd", Source: "sda · SMART", Temp: 40, Limit: 70},
		},
		Disks: []DiskSpec{
			{Dev: "nvme0n1", Type: "nvme", Model: "Micron 7450 480 GB", Pool: "rpool", Role: "rpool mirror member", CapGB: 480, UsedGB: 70, Wear: f(9), WrittenTB: 140, RatedTBW: 1000, Temp: 41, POH: 21000},
			{Dev: "nvme1n1", Type: "nvme", Model: "Micron 7450 480 GB", Pool: "rpool", Role: "rpool mirror member", CapGB: 480, UsedGB: 70, Wear: f(10), WrittenTB: 150, RatedTBW: 1000, Temp: 42, POH: 21000},
			{Dev: "nvme2n1", Type: "nvme", Model: "Samsung PM9A3 3.84 TB", Pool: "vmdata", Role: "vmdata mirror member", CapGB: 3840, UsedGB: 3190, Wear: f(22), WrittenTB: 1500, RatedTBW: 7008, Temp: 56, POH: 21000},
			{Dev: "nvme3n1", Type: "nvme", Model: "Samsung PM9A3 3.84 TB", Pool: "vmdata", Role: "vmdata mirror member", CapGB: 3840, UsedGB: 3190, Wear: f(23), WrittenTB: 1560, RatedTBW: 7008, Temp: 54, POH: 21000},
			{Dev: "sda", Type: "ssd", Model: "Samsung PM893 7.68 TB", Pool: "bulk", Role: "bulk mirror member", CapGB: 7680, UsedGB: 2980, Wear: f(12), WrittenTB: 1700, RatedTBW: 14016, Temp: 40, POH: 21000},
			{Dev: "sdb", Type: "ssd", Model: "Samsung PM893 7.68 TB", Pool: "bulk", Role: "bulk mirror member", CapGB: 7680, UsedGB: 2980, Wear: f(12), WrittenTB: 1690, RatedTBW: 14016, Temp: 38, POH: 21000},
		},
		KVM:    amdKVM(22, 2, 0, 2<<20, 11.4),
		Policy: allow,
	}
	next := time.Date(2026, 10, 12, 0, 0, 0, 0, time.UTC)
	dedup := 6.8
	avg := 41 * 60
	shale.PVE = &proto.PVE{
		Version: "9.0.3", Node: "shale",
		Cluster: &proto.PVECluster{Name: "prod-pve", Quorate: true, VotesHave: 3, VotesExpected: 3},
		Nodes: []proto.PVENode{
			{Name: "shale", ThisNode: true, Online: true, CPUPct: 71, MemPct: 83, VMs: 18, Containers: 4},
			{Name: "schist", Online: true, CPUPct: 38, MemPct: 61, VMs: 11, Containers: 2},
			{Name: "slate", Online: true, CPUPct: 24, MemPct: 47, VMs: 7, Containers: 0},
		},
		Storages: []proto.PVEStorage{
			{ID: "local", Type: "dir", Content: "iso,vztmpl", Detail: "on rpool", Active: true, UsedBytes: 41e9, TotalBytes: 94e9},
			{ID: "local-zfs", Type: "zfspool", Content: "images,rootdir", Detail: "rpool mirror", Active: true, UsedBytes: 29e9, TotalBytes: 380e9},
			{ID: "vmdata", Type: "zfspool", Content: "images", Detail: "NVMe mirror", Active: true, UsedBytes: 3190e9, TotalBytes: 3840e9},
			{ID: "bulk", Type: "zfspool", Content: "images,rootdir", Detail: "SATA SSD mirror", Active: true, UsedBytes: 3070e9, TotalBytes: 7680e9},
			{ID: "pbs-01", Type: "pbs", Content: "backup", Detail: "Proxmox Backup Server", Shared: true, Active: true, UsedBytes: 11200e9, TotalBytes: 16000e9},
		},
		Backups: &proto.PVEBackups{
			LastJob: &proto.PVEBackupJob{At: time.Date(2026, 10, 11, 0, 0, 0, 0, time.UTC), Schedule: "daily", Mode: "snapshot",
				Result: "ok", GuestsOK: 22, GuestsTotal: 22, WrittenBytes: 412e9, DedupRatio: &dedup, DurationS: 38 * 60,
				AvgDurationWeek: &avg},
			NextRun: &next, Target: "pbs-01",
		},
		HAResourcesStarted: 6, HAResourcesTotal: 6,
	}
	up := int64(7603200)
	shale.Guests = []GuestSpec{
		pveVM(100, "k3s-node-2", "ubuntu 24.04", "running", 8, 44, 14438, 16, 12, 40, 210, 180, up, vmProtosFull, "1024x768", true),
		pveVM(101, "win-build", "Windows 11 · OVMF · TPM", "running", 8, 38, 22835, 32, 65, 140, 8, 3, 1036800, vmProtosNoSer, "1920x1080", false),
		pveVM(102, "k3s-node-1", "ubuntu 24.04", "running", 8, 31.2, 13824, 16, 10, 35, 180, 150, up, vmProtosFull, "1024x768", true),
		pveVM(103, "postgres-prod", "debian 13", "running", 4, 22.5, 12083, 16, 88, 120, 95, 60, up, vmProtosFull, "1024x768", true),
		pveVM(104, "gitlab-runner", "debian 13", "running", 4, 14, 6349, 8, 5, 22, 20, 8, 2678400, vmProtosFull, "1024x768", true),
		pveVM(105, "opnsense-fw", "FreeBSD · OVMF", "running", 2, 6.3, 1946, 4, 0.3, 0.5, 860, 840, up, vmProtosFull, "1024x768", false),
		pveVM(106, "haos-prod", "Home Assistant OS", "running", 2, 4.1, 3072, 4, 0.2, 0.8, 1, 1, up, vmProtosFull, "1024x768", true),
		pveVM(107, "win11-lab", "Windows 11 · OVMF · TPM", "stopped", 4, 0, 0, 8, 0, 0, 0, 0, 0, vmProtosNoSer, "1920x1080", false),
	}
	extra := []struct {
		name  string
		vcpu  int
		mem   uint64
		cpu   float64
		state string
	}{
		{"k3s-node-3", 2, 8, 3.9, "running"}, {"nextcloud", 2, 8, 3.5, "running"}, {"jellyfin", 2, 8, 3.2, "running"},
		{"mail", 2, 8, 2.8, "running"}, {"matrix", 2, 8, 2.5, "running"}, {"wiki", 1, 8, 1.9, "running"},
		{"ldap", 1, 4, 1.4, "running"}, {"bastion", 1, 4, 1.1, "running"}, {"monitor", 1, 2, 0.9, "running"},
		{"dns-1", 1, 2, 0.6, "running"}, {"dns-2", 1, 2, 0.5, "running"},
		{"old-erp", 4, 16, 0, "stopped"}, {"test-rhel", 2, 4, 0, "stopped"}, {"template-deb", 2, 4, 0, "stopped"},
	}
	for i, e := range extra {
		balloon := e.state == "running" && i < 9
		shale.Guests = append(shale.Guests, pveVM(108+i, e.name, "debian 13", e.state, e.vcpu, e.cpu, e.mem*1024*55/100, e.mem,
			1, 3, 5, 3, up, vmProtosFull, "1024x768", balloon))
	}
	shale.Guests = append(shale.Guests,
		pveCT(200, "grafana-ct", "debian 13", 2, 2.4, 310, 1024, 0.1, 0.4, 4, 2, up),
		pveCT(201, "nginx-proxy", "alpine 3.22", 2, 1.2, 96, 512, 0, 0.2, 38, 36, up),
		pveCT(202, "vaultwarden", "debian 13", 2, 0.9, 120, 512, 0, 0.1, 1, 1, 5184000),
		pveCT(203, "pihole", "debian 13", 1, 0.6, 92, 512, 0, 0.1, 2, 2, up),
	)
	seedShaleManage(shale)
	seedBasaltIncus(basalt)

	flint := &Host{
		ID: "flint", Group: "Edge", Location: "Office closet",
		OSName: "NixOS", OSVersion: "26.05", Pretty: "NixOS 26.05 (Yarara)", Kernel: "6.18.44",
		CPUModel: "Intel N100", Cores: 4, Threads: 4, MemGiB: 16, MemType: "DDR5", Address: "10.40.0.31",
		UptimeS: 64 * day, CPU: 18, User: 12, Sys: 5, IOWait: 1, Load: [3]float64{0.9, 0.8, 0.8},
		MemUsedGiB: 7, CacheGiB: 6, Free: 3, SwapTotal: 4,
		Sensors: []SensorSpec{cpuSensor(55, "coretemp · Package id 0"), nvmeSensor(46, "nvme0n1")},
		Disks: []DiskSpec{
			{Dev: "nvme0n1", Type: "nvme", Model: "Kingston NV2 1 TB", Role: "System · /", CapGB: 1000, UsedGB: 370, Wear: f(8), WrittenTB: 32, RatedTBW: 400, Temp: 46, POH: 12000},
		},
		Docker: true, Policy: allow,
	}
	flint.Guests = fillDocker([]GuestSpec{
		dk("traefik", "traefik", 4, 110, 0, 64*day),
		dk("adguard", "adguard/adguardhome", 2.1, 160, 0, 64*day),
	}, 6, 1, 0)

	onyx := &Host{
		ID: "onyx", Group: "Lab", Location: "Lab shelf 2",
		OSName: "Debian GNU/Linux", OSVersion: "13", Pretty: "Debian GNU/Linux 13 (trixie)", Kernel: "6.12.48+deb13-amd64",
		CPUModel: "Ryzen 7 5700G", Cores: 8, Threads: 16, MemGiB: 64, MemType: "DDR4", Address: "10.30.0.22",
		UptimeS: 9 * day, CPU: 29, User: 20, Sys: 7, IOWait: 2, Load: [3]float64{4.6, 4.4, 4.1},
		MemUsedGiB: 35.2, CacheGiB: 18, Free: 10.8, SwapTotal: 8,
		Sensors: []SensorSpec{cpuSensor(58, "k10temp · Tctl"), nvmeSensor(51, "nvme0n1"),
			{ID: proto.SensorHDD, Label: "HDD, hottest", Group: "hdd", Source: "sda · SMART", Temp: 41, Limit: 55}},
		Disks: []DiskSpec{
			{Dev: "nvme0n1", Type: "nvme", Model: "Samsung 980 PRO 2 TB", Role: "System · /, /var/lib/incus", CapGB: 2000, UsedGB: 1660, Wear: f(41), WrittenTB: 492, RatedTBW: 1200, Temp: 51, POH: 26000},
			{Dev: "sda", Type: "hdd", Model: "Toshiba MG07 14 TB", Role: "Media · /srv/media", CapGB: 14000, UsedGB: 11620, Temp: 41, POH: 31000},
		},
		KVM:    amdKVM(16, 1, 0, 2<<20, 0.4),
		Docker: true, Incus: true, Libvirt: true, Policy: allow,
	}
	onyx.Guests = fillDocker([]GuestSpec{dk("jellyfin", "jellyfin/jellyfin", 17, 2400, 0, 9*day)}, 11, 2, 1)
	onyx.Guests = append(onyx.Guests,
		incVM("frigate", "debian/13", "running", 4, 3.1, 9000, 16, 2, 30, 40, 2, 1, 9*day),
		incCT("dev", "debian/13", "running", 4, 2.2, 1100, 4096, 0.4, 1, 1, 1, 1, 9*day),
		incCT("vpn", "alpine/3.22", "running", 1, 0.4, 60, 512, 0, 0, 5, 5, 0, 9*day),
		incCT("old-ci", "debian/12", "stopped", 2, 0, 0, 0, 0, 0, 0, 0, 1, 0),
		lvVM("haos", "q35 · OVMF", "running", 2, 7, 3100, 4, 0.4, 1.2, 1, 1, 2, 9*day, vmProtosFull, "1024x768"),
		lvVM("nvr", "q35 · OVMF", "running", 5, 4.4, 7100, 9, 12, 40, 60, 2, 0, 9*day, vmProtosFull, "1024x768"),
	)

	marble := &Host{
		ID: "marble", Group: "Edge", Location: "Branch office",
		OSName: "Ubuntu", OSVersion: "24.04 LTS", Pretty: "Ubuntu 24.04.3 LTS", Kernel: "6.8.0-85-generic",
		CPUModel: "Celeron J4125", Cores: 4, Threads: 4, MemGiB: 8, MemType: "DDR4", Address: "10.40.0.32",
		UptimeS: 120 * day, CPU: 9, User: 6, Sys: 2.5, IOWait: 0.5, Load: [3]float64{0.4, 0.4, 0.3},
		MemUsedGiB: 3.3, CacheGiB: 3, Free: 1.7, SwapTotal: 2,
		Sensors: []SensorSpec{cpuSensor(49, "coretemp · Package id 0"),
			{ID: proto.SensorSATASS, Label: "SATA SSD, hottest", Group: "ssd", Source: "sda · SMART", Temp: 37, Limit: 70}},
		Disks: []DiskSpec{
			{Dev: "sda", Type: "ssd", Model: "Crucial MX500 2 TB", Role: "System · /", CapGB: 2000, UsedGB: 920, Wear: f(14), WrittenTB: 98, RatedTBW: 700, Temp: 37, POH: 29000},
		},
		Docker: true, Policy: allow, OfflineAfter: 3 * time.Minute,
	}
	marble.Guests = fillDocker([]GuestSpec{dk("frigate-edge", "ghcr.io/blakeblackshear/frigate", 4.2, 700, 0, 120*day)}, 3, 0, 0)

	return []*Host{basalt, granite, obsidian, quartz, shale, flint, onyx, marble}
}

// Extra returns n additional generic hosts (sim-09, sim-10, ...).
func Extra(n int) []*Host {
	var out []*Host
	groups := []string{"Production", "Lab", "Edge"}
	for i := 0; i < n; i++ {
		id := fmt.Sprintf("sim-%02d", i+9)
		h := &Host{
			ID: id, Group: groups[i%3], Location: fmt.Sprintf("Rack C · unit %d", i+1),
			OSName: "Debian GNU/Linux", OSVersion: "13", Pretty: "Debian GNU/Linux 13 (trixie)", Kernel: "6.12.48+deb13-amd64",
			CPUModel: "Xeon E-2336", Cores: 6, Threads: 12, MemGiB: 32, MemType: "DDR4 ECC", Address: fmt.Sprintf("10.50.0.%d", 10+i),
			UptimeS: int64(5+i) * 86400, CPU: float64(10 + (i*7)%60), User: 8, Sys: 3, IOWait: 1, Load: [3]float64{1, 1, 1},
			MemUsedGiB: float64(8 + (i*3)%20), CacheGiB: 6, Free: 4, SwapTotal: 4,
			Sensors: []SensorSpec{cpuSensor(float64(45+(i*5)%30), "coretemp · Package id 0"), nvmeSensor(40, "nvme0n1")},
			Disks: []DiskSpec{{Dev: "nvme0n1", Type: "nvme", Model: "Samsung PM9A1 1 TB", Role: "System · /", CapGB: 1000,
				UsedGB: float64(200 + (i*90)%700), Wear: f(float64(3 + (i*11)%60)), WrittenTB: 50, RatedTBW: 600, Temp: 40, POH: 9000}},
			Docker: true, Policy: proto.Policy{Console: true, Power: true},
		}
		h.Guests = fillDocker(nil, 4+i%6, i%2, 0)
		out = append(out, h)
	}
	return out
}
