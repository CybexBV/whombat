package hardware

// The machine, its processor, memory and kernel (MG-110): DMI (never the serials: product_serial, board_serial,
// chassis_serial and product_uuid are root-only and never read), /proc/cpuinfo, /proc/meminfo, the kernel's release.

import (
	"bufio"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/CybexBV/whombat/contracts/go/local"
	"github.com/CybexBV/whombat/contracts/go/protocol"
)

// placeholder: what firmwares put in DMI fields they don't fill.
func placeholder(s string) bool {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "", "to be filled by o.e.m.", "default string", "system product name", "system manufacturer",
		"system version", "not applicable", "not specified", "none", "n/a", "o.e.m.", "oem", "unknown", "invalid",
		"0123456789", "type1productconfigid", "type1family":
		return true
	}
	return false
}

func optText(s string, max int) *string {
	if placeholder(s) {
		return nil
	}
	if t := local.HostText(s, max); t != "" {
		return &t
	}
	return nil
}

// dmiHypervisors: the DMI vendors and products of virtual machines, as systemd-detect-virt names them (its
// dmi_vendor_table), matched at the start of the system's and the board's vendor, the product and the BIOS vendor.
var dmiHypervisors = []struct{ prefix, name string }{
	{"KVM", "kvm"}, {"OpenStack", "kvm"}, {"KubeVirt", "kvm"}, {"Amazon EC2", "amazon"}, {"QEMU", "qemu"},
	{"VMware", "vmware"}, {"VMW", "vmware"}, {"innotek GmbH", "oracle"}, {"VirtualBox", "oracle"},
	{"Oracle Corporation", "oracle"}, {"Xen", "xen"}, {"Bochs", "bochs"}, {"Parallels", "parallels"},
	{"BHYVE", "bhyve"}, {"Hyper-V", "microsoft"}, {"Apple Virtualization", "apple"}, {"Google Compute Engine", "google"},
}

// readMachine reads DMI and whether this is a virtual machine: the processor's hypervisor flag, Xen's sysfs, or a
// hypervisor's DMI strings. Its name, as systemd's: kvm where the kvm clock is offered (KVM, Proxmox, Incus), microsoft
// where Hyper-V's is, else Xen's, else the DMI table's (qemu for QEMU without KVM).
func readMachine(sys, proc string) protocol.HardwareMachine {
	dmi := filepath.Join(sys, "class", "dmi", "id")
	vendor, product := attr(dmi, "sys_vendor"), attr(dmi, "product_name")
	m := protocol.HardwareMachine{Vendor: optText(vendor, 80), Model: optText(product, 120),
		Family: optText(attr(dmi, "product_family"), 80), Firmware: optText(attr(dmi, "bios_version"), 80)}

	name := ""
	clocks := attr(filepath.Join(sys, "devices", "system", "clocksource", "clocksource0"), "available_clocksource")
	switch {
	case strings.Contains(clocks, "kvm-clock"):
		name = "kvm"
	case strings.Contains(clocks, "hyperv_clocksource"):
		name = "microsoft"
	case attr(filepath.Join(sys, "hypervisor"), "type") == "xen":
		name = "xen"
	case vendor == "Microsoft Corporation" && product == "Virtual Machine":
		name = "microsoft"
	default:
	table:
		for _, f := range []string{vendor, product, attr(dmi, "board_vendor"), attr(dmi, "bios_vendor")} {
			for _, h := range dmiHypervisors {
				if f != "" && strings.HasPrefix(f, h.prefix) {
					name = h.name
					break table
				}
			}
		}
	}
	m.Virtual = name != "" || cpuFlag(proc, "hypervisor")
	if name != "" {
		m.Hypervisor = &name
	}
	return m
}

// cpuFlag: the first processor's flags (x86) list flag.
func cpuFlag(proc, flag string) bool {
	f, err := os.Open(filepath.Join(proc, "cpuinfo"))
	if err != nil {
		return false
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 64*1024), 256*1024)
	for sc.Scan() {
		k, v, ok := strings.Cut(sc.Text(), ":")
		if ok && strings.TrimSpace(k) == "flags" {
			for _, x := range strings.Fields(v) {
				if x == flag {
					return true
				}
			}
			return false
		}
	}
	return false
}

// readCPU: the model name, the threads (processors) and the cores (distinct physical id and core id pairs; the threads
// where the kernel says neither, as on Arm), each 1…4096.
func readCPU(proc string) protocol.HardwareCpu {
	c := protocol.HardwareCpu{}
	f, err := os.Open(filepath.Join(proc, "cpuinfo"))
	if err == nil {
		defer f.Close()
		sc := bufio.NewScanner(f)
		sc.Buffer(make([]byte, 64*1024), 256*1024)
		cores := map[string]bool{}
		phys, core := "", ""
		flush := func() {
			if core != "" {
				cores[phys+"/"+core] = true
			}
			phys, core = "", ""
		}
		for sc.Scan() {
			k, v, ok := strings.Cut(sc.Text(), ":")
			k, v = strings.TrimSpace(k), strings.TrimSpace(v)
			switch {
			case !ok:
				flush()
			case k == "processor":
				c.Threads++
			case k == "model name" && c.Model == "":
				c.Model = local.HostText(v, 120)
			case k == "physical id":
				phys = v
			case k == "core id":
				core = v
			}
		}
		flush()
		c.Cores = int64(len(cores))
	}
	if c.Threads < 1 {
		c.Threads = 1
	}
	if c.Cores < 1 || c.Cores > c.Threads {
		c.Cores = c.Threads
	}
	c.Threads, c.Cores = min(c.Threads, 4096), min(c.Cores, 4096)
	return c
}

// readMemory is MemTotal in bytes.
func readMemory(proc string) int64 {
	b, _ := os.ReadFile(filepath.Join(proc, "meminfo"))
	for _, line := range strings.Split(string(b), "\n") {
		if v, ok := strings.CutPrefix(line, "MemTotal:"); ok {
			kb, err := strconv.ParseInt(strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(v), "kB")), 10, 64)
			if err == nil && kb > 0 && kb < 1<<43 {
				return kb * 1024
			}
		}
	}
	return 0
}

// readKernel is `uname -r`.
func readKernel(proc string) string {
	if k := local.HostText(attr(filepath.Join(proc, "sys", "kernel"), "osrelease"), 64); k != "" {
		return k
	}
	return "unknown"
}
