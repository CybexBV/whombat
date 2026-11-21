package collect

import (
	"os"
	"path/filepath"
	"testing"
)

func TestReadKVM(t *testing.T) {
	dir := t.TempDir()
	writeTree(t, dir, map[string]string{
		"proc/cpuinfo":                                             string(readTestdata(t, "cpuinfo")),
		"proc/meminfo":                                             string(readTestdata(t, "meminfo")),
		"dev/kvm":                                                  "",
		"sys/module/kvm_amd/parameters/nested":                     "1\n",
		"sys/module/kvm_amd/parameters/npt":                        "Y\n",
		"sys/kernel/iommu_groups/0/type":                           "DMA\n",
		"sys/kernel/iommu_groups/1/type":                           "DMA\n",
		"sys/kernel/iommu_groups/2/type":                           "DMA\n",
		"sys/bus/pci/drivers/vfio-pci/new_id":                      "",
		"sys/kernel/mm/hugepages/hugepages-2048kB/nr_hugepages":    "0\n",
		"sys/kernel/mm/hugepages/hugepages-1048576kB/nr_hugepages": "32\n",
		"sys/kernel/mm/ksm/run":                                    "1\n",
		"sys/kernel/mm/ksm/pages_sharing":                          "1000\n",
	})
	// A device bound to vfio-pci is a symlink named after its PCI address.
	if err := os.Symlink("/nonexistent", filepath.Join(dir, "sys/bus/pci/drivers/vfio-pci/0000:41:00.0")); err != nil {
		t.Fatal(err)
	}
	k := readKVM(fsRoot(dir))
	if k == nil {
		t.Fatal("nil")
	}
	if !k.Enabled || k.Device != "/dev/kvm" || k.Module != "kvm_amd" || k.CPUVirtType != "AMD-V" || k.CPUFlag != "svm" {
		t.Errorf("basics: %+v", k)
	}
	if !k.NestedPaging || !k.NestedEnabled || k.NestedParam != "kvm_amd nested=1" {
		t.Errorf("nested: %+v", k)
	}
	if !k.IOMMUEnabled || k.IOMMUGroups != 3 || k.VFIOPCIDevices != 1 {
		t.Errorf("iommu: %+v", k)
	}
	if k.HugepagesCount != 32 || k.HugepageSize != 1<<30 {
		t.Errorf("hugepages: %d x %d", k.HugepagesCount, k.HugepageSize)
	}
	if !k.KSMRunning || k.KSMSavedBytes != 1000*uint64(os.Getpagesize()) {
		t.Errorf("ksm: %+v", k)
	}
}

func TestReadKVMIntelAndNone(t *testing.T) {
	dir := t.TempDir()
	writeTree(t, dir, map[string]string{
		"proc/cpuinfo":                           "processor\t: 0\nflags\t\t: fpu vmx sse\nvmx flags\t: vnmi ept vpid\n\nprocessor\t: 1\nflags\t\t: fpu\n",
		"dev/kvm":                                "",
		"sys/module/kvm_intel/parameters/nested": "N\n",
		"proc/meminfo":                           "Hugepagesize:       2048 kB\n",
		"sys/kernel/mm/hugepages/hugepages-2048kB/nr_hugepages": "0\n",
	})
	k := readKVM(fsRoot(dir))
	if k == nil || k.Module != "kvm_intel" || k.CPUVirtType != "Intel VT-x" || !k.NestedPaging || k.NestedEnabled || k.NestedParam != "kvm_intel nested=0" {
		t.Errorf("intel: %+v", k)
	}
	if k.HugepageSize != 2<<20 || k.HugepagesCount != 0 || k.IOMMUEnabled {
		t.Errorf("intel hugepages/iommu: %+v", k)
	}
	none := t.TempDir()
	writeTree(t, none, map[string]string{"proc/cpuinfo": "processor\t: 0\nflags\t\t: fpu sse\n"})
	if k := readKVM(fsRoot(none)); k != nil {
		t.Errorf("no virtualization: %+v", k)
	}
}
