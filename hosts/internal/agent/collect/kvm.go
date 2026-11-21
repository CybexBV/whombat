package collect

import (
	"context"
	"os"
	"strconv"
	"strings"
	"sync"

	"rackoon/internal/proto"
)

// kvmCollector reads KVM / IOMMU / hugepage / KSM capabilities every 5 min.
type kvmCollector struct {
	root fsRoot

	mu  sync.Mutex
	kvm *proto.KVM
}

func newKVMCollector(root fsRoot) *kvmCollector { return &kvmCollector{root: root} }

func (k *kvmCollector) run(ctx context.Context) error {
	v := readKVM(k.root)
	k.mu.Lock()
	k.kvm = v
	k.mu.Unlock()
	return nil
}

func (k *kvmCollector) snapshot() *proto.KVM {
	k.mu.Lock()
	defer k.mu.Unlock()
	if k.kvm == nil {
		return nil
	}
	v := *k.kvm
	return &v
}

// cpuFlags returns the union of "flags" and "vmx flags" of the first CPU in
// /proc/cpuinfo.
func cpuFlags(b []byte) map[string]bool {
	flags := map[string]bool{}
	seen := map[string]bool{}
	scanLines(b, func(line string) {
		k, v, ok := strings.Cut(line, ":")
		if !ok {
			return
		}
		k = strings.TrimSpace(k)
		if (k == "flags" || k == "vmx flags") && !seen[k] {
			seen[k] = true
			for _, f := range strings.Fields(v) {
				flags[f] = true
			}
		}
	})
	return flags
}

func paramOn(s string) bool {
	switch strings.TrimSpace(s) {
	case "1", "Y", "y":
		return true
	}
	return false
}

func readKVM(r fsRoot) *proto.KVM {
	cpuinfo, _ := r.read("/proc/cpuinfo")
	flags := cpuFlags(cpuinfo)
	k := &proto.KVM{}
	k.Enabled = r.exists("/dev/kvm")
	if k.Enabled {
		k.Device = "/dev/kvm"
	}
	switch {
	case flags["svm"]:
		k.CPUVirtType, k.CPUFlag = "AMD-V", "svm"
	case flags["vmx"]:
		k.CPUVirtType, k.CPUFlag = "Intel VT-x", "vmx"
	}
	if !k.Enabled && k.CPUFlag == "" {
		return nil
	}
	for _, m := range []string{"kvm_amd", "kvm_intel"} {
		if r.exists("/sys/module/" + m) {
			k.Module = m
			break
		}
	}
	if k.Module == "" {
		if k.CPUFlag == "svm" {
			k.Module = "kvm_amd"
		} else if k.CPUFlag == "vmx" {
			k.Module = "kvm_intel"
		}
	}
	// Nested paging: CPU flag, unless the module disabled it.
	npParam := "npt"
	npFlag := "npt"
	if k.Module == "kvm_intel" {
		npParam, npFlag = "ept", "ept"
	}
	k.NestedPaging = flags[npFlag]
	if p := r.readString("/sys/module/" + k.Module + "/parameters/" + npParam); p != "" {
		k.NestedPaging = paramOn(p)
	}
	if p := r.readString("/sys/module/" + k.Module + "/parameters/nested"); p != "" {
		k.NestedEnabled = paramOn(p)
		v := "0"
		if k.NestedEnabled {
			v = "1"
		}
		k.NestedParam = k.Module + " nested=" + v
	}
	if ents, err := os.ReadDir(r.path("/sys/kernel/iommu_groups")); err == nil {
		k.IOMMUGroups = len(ents)
	}
	k.IOMMUEnabled = k.IOMMUGroups > 0
	if ents, err := os.ReadDir(r.path("/sys/bus/pci/drivers/vfio-pci")); err == nil {
		for _, e := range ents {
			if strings.Count(e.Name(), ":") == 2 { // PCI address 0000:01:00.0
				k.VFIOPCIDevices++
			}
		}
	}
	// Hugepages: the size class with the most reserved memory.
	if ents, err := os.ReadDir(r.path("/sys/kernel/mm/hugepages")); err == nil {
		var bestBytes uint64
		for _, e := range ents {
			sz, ok := strings.CutPrefix(e.Name(), "hugepages-")
			if !ok {
				continue
			}
			kb, err := strconv.ParseUint(strings.TrimSuffix(sz, "kB"), 10, 64)
			if err != nil {
				continue
			}
			n, _ := r.readInt("/sys/kernel/mm/hugepages/" + e.Name() + "/nr_hugepages")
			bytes := uint64(n) * kb * 1024
			if bytes > bestBytes || (bestBytes == 0 && k.HugepageSize == 0) {
				bestBytes = bytes
				k.HugepagesCount = int(n)
				k.HugepageSize = kb * 1024
			}
		}
		if bestBytes == 0 {
			// Report the default size with a zero count.
			if mi, err := r.read("/proc/meminfo"); err == nil {
				if sz := parseMeminfo(mi)["Hugepagesize"]; sz > 0 {
					k.HugepageSize = sz
					k.HugepagesCount = 0
				}
			}
		}
	}
	if run, ok := r.readInt("/sys/kernel/mm/ksm/run"); ok {
		k.KSMRunning = run == 1
	}
	if ps, ok := r.readInt("/sys/kernel/mm/ksm/pages_sharing"); ok && ps > 0 {
		k.KSMSavedBytes = uint64(ps) * uint64(os.Getpagesize())
	}
	return k
}
