package rules

import (
	"math"
	"strings"

	"rackoon/internal/proto"
)

// Derived values (docs/handoff/docs/ARCHITECTURE.md section 3.3). They are
// computed from the guest lists, never taken from display values.

// Byte units: memory is shown in GiB / MiB labeled "GB" / "MB" (like the
// mockup); disk and storage sizes are decimal (1 TB = 1e12 bytes).
const (
	GiB = 1 << 30
	MiB = 1 << 20
	GB  = 1e9
	TB  = 1e12
)

// Stacks names the hypervisor stacks present on the host, in the fixture
// order: incus, libvirt, proxmox.
func Stacks(r *proto.Report) []string {
	var s []string
	if r == nil {
		return s
	}
	if r.Incus != nil {
		s = append(s, "incus")
	}
	if r.Libvirt != nil {
		s = append(s, "libvirt")
	}
	if r.PVE != nil {
		s = append(s, "proxmox")
	}
	return s
}

// IsHypervisor reports whether the host runs a hypervisor stack.
func IsHypervisor(r *proto.Report) bool { return len(Stacks(r)) > 0 }

// KVMEnabled reports whether /dev/kvm is available.
func KVMEnabled(r *proto.Report) bool { return r != nil && r.KVM != nil && r.KVM.Enabled }

// HostThreads returns the number of logical CPUs.
func HostThreads(r *proto.Report) int {
	if r == nil {
		return 0
	}
	return r.Host.Threads
}

// HostMemoryBytes returns the host RAM size: the installed size when the
// agent knows it, else MemTotal.
func HostMemoryBytes(r *proto.Report) uint64 {
	if r == nil {
		return 0
	}
	if r.Host.MemoryTotalBytes > 0 {
		return r.Host.MemoryTotalBytes
	}
	return r.Memory.TotalBytes
}

// IsSystemContainer reports whether a guest is an Incus or LXC container
// (counted as a hypervisor container; Docker containers are not).
func IsSystemContainer(g proto.PlatformGuest) bool {
	return g.Kind == "container" && (g.Platform == proto.PlatformIncus || g.Platform == proto.PlatformPVE)
}

// IsVM reports whether a guest is a VM.
func IsVM(g proto.PlatformGuest) bool { return g.Kind == "vm" }

// Running reports whether a guest counts as running (unhealthy Docker
// containers are their own state).
func Running(g *proto.Guest) bool { return g.State == proto.StateRunning }

// Alloc is the hypervisor allocation of a host.
type Alloc struct {
	VCPUAllocated     int    // sum of configured vCPUs of running VMs
	MemAssignedBytes  uint64 // sum of configured memory of running VMs
	MemInUseBytes     uint64 // sum of guest-reported used memory of running VMs
	RunningVMs        int
	TotalVMs          int
	RunningContainers int // Incus / LXC containers
	BalloonActive     int // running VMs with an active balloon
}

// Allocation computes the hypervisor allocation from the guest lists.
func Allocation(r *proto.Report) Alloc {
	var a Alloc
	if r == nil {
		return a
	}
	for _, g := range r.AllGuests() {
		switch {
		case IsVM(g):
			a.TotalVMs++
			if !Running(g.Guest) {
				continue
			}
			a.RunningVMs++
			a.VCPUAllocated += g.VCPU
			mem := g.MemConfigBytes
			if mem == 0 && g.MemLimitBytes != nil {
				mem = *g.MemLimitBytes
			}
			a.MemAssignedBytes += mem
			if g.MemUsedBytes != nil {
				a.MemInUseBytes += *g.MemUsedBytes
			}
			if g.BalloonActive {
				a.BalloonActive++
			}
		case IsSystemContainer(g):
			if Running(g.Guest) {
				a.RunningContainers++
			}
		}
	}
	return a
}

// OvercommitRatio is vCPUs allocated / host threads (0 when unknown).
func OvercommitRatio(vcpu, threads int) float64 {
	if threads <= 0 {
		return 0
	}
	return float64(vcpu) / float64(threads)
}

// MemAssignedPct is guest memory assigned / host RAM in percent.
func MemAssignedPct(assigned, host uint64) float64 {
	if host == 0 {
		return 0
	}
	return float64(assigned) / float64(host) * 100
}

// IsSSD reports whether a disk has an SSD wear indicator.
func IsSSD(d proto.Disk) bool { return d.Type == "nvme" || d.Type == "ssd" }

// MaxWear is the maximum wear over the host's SSDs (capped at 100), or nil.
func MaxWear(r *proto.Report) *float64 {
	if r == nil {
		return nil
	}
	var max *float64
	for _, d := range r.Disks {
		if !IsSSD(d) || d.WearPct == nil || !finite(*d.WearPct) {
			continue
		}
		w := WearDisplay(*d.WearPct)
		if max == nil || w > *max {
			max = &w
		}
	}
	return max
}

// DisksOverWear counts SSDs at or above the wear warning threshold.
func DisksOverWear(r *proto.Report) int {
	n := 0
	if r == nil {
		return 0
	}
	for _, d := range r.Disks {
		if IsSSD(d) && d.WearPct != nil && WearHigh(*d.WearPct) {
			n++
		}
	}
	return n
}

// StorageCapacityBytes is the sum of the physical disks' capacities.
func StorageCapacityBytes(r *proto.Report) uint64 {
	var n uint64
	if r == nil {
		return 0
	}
	for _, d := range r.Disks {
		n += d.CapacityBytes
	}
	return n
}

// DiskUsage returns used and total bytes for the "Disk used" figure: over the
// physical disks whose usage is known when there are any, else over the
// monitored filesystems (ZFS datasets replaced by their pools). ok is false
// when nothing is known.
func DiskUsage(r *proto.Report) (used, total uint64, ok bool) {
	if r == nil {
		return 0, 0, false
	}
	for _, d := range r.Disks {
		if d.UsedBytes != nil && d.CapacityBytes > 0 {
			used += *d.UsedBytes
			total += d.CapacityBytes
		}
	}
	if total > 0 {
		return used, total, true
	}
	for _, p := range r.Pools {
		used += p.AllocBytes
		total += p.SizeBytes
	}
	seen := map[string]bool{}
	for _, f := range r.Filesystems {
		if f.FSType == "zfs" || f.SizeBytes == 0 || seen[f.Device] {
			continue
		}
		seen[f.Device] = true
		used += f.UsedBytes
		total += f.SizeBytes
	}
	return used, total, total > 0
}

// DiskUsedPct is DiskUsage as a percentage (nil when unknown).
func DiskUsedPct(r *proto.Report) *float64 {
	used, total, ok := DiskUsage(r)
	if !ok {
		return nil
	}
	p := float64(used) / float64(total) * 100
	return &p
}

// HottestSensor returns the sensor closest to its own limit (highest
// temperature / limit ratio; ties go to the higher temperature) and that
// limit. The fleet card shows it, so a 54 °C HDD with a 55 °C limit is not
// hidden behind a 64 °C CPU with an 85 °C limit (per-sensor limits
// everywhere, hand-off README known issue 3).
func HottestSensor(r *proto.Report) (s *proto.Sensor, limit float64) {
	if r == nil {
		return nil, 0
	}
	var best float64
	for i := range r.Sensors {
		x := &r.Sensors[i]
		l := SensorLimit(*x)
		if !finite(x.TempC) || l <= 0 {
			continue
		}
		ratio := x.TempC / l
		if s == nil || ratio > best || (ratio == best && x.TempC > s.TempC) {
			s, best, limit = x, ratio, l
		}
	}
	return s, limit
}

// SensorLimit returns the sensor's limit or the default for its group.
func SensorLimit(s proto.Sensor) float64 {
	if s.LimitC > 0 && finite(s.LimitC) {
		return s.LimitC
	}
	if l, ok := DefaultSensorLimits[s.ID]; ok {
		return l
	}
	return 85
}

// SensorShortName is the short name used in status notes ("CPU temperature").
func SensorShortName(id string) string {
	switch id {
	case proto.SensorCPU:
		return "CPU"
	case proto.SensorBoard:
		return "VRM"
	case proto.SensorNVMe:
		return "NVMe"
	case proto.SensorDIMM:
		return "memory"
	case proto.SensorHDD:
		return "HDD"
	case proto.SensorSATASS:
		return "SSD"
	}
	return strings.TrimSuffix(id, "_hottest")
}

func finite(f float64) bool { return !math.IsNaN(f) && !math.IsInf(f, 0) }
