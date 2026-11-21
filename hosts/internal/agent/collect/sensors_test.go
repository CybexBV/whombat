package collect

import (
	"os"
	"path/filepath"
	"testing"

	"rackoon/internal/proto"
)

// fakeHwmon builds a /sys tree with the sensor drivers of a typical
// workstation / server.
func fakeHwmon(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	h := "sys/class/hwmon/"
	writeTree(t, dir, map[string]string{
		// AMD CPU
		h + "hwmon0/name": "k10temp\n", h + "hwmon0/temp1_input": "64250\n", h + "hwmon0/temp1_label": "Tctl\n",
		h + "hwmon0/temp3_input": "70125\n", h + "hwmon0/temp3_label": "Tccd1\n",
		// two NVMe drives
		h + "hwmon1/name": "nvme\n", h + "hwmon1/temp1_input": "48850\n", h + "hwmon1/temp1_label": "Composite\n",
		h + "hwmon1/temp1_max": "83850\n", h + "hwmon1/temp1_crit": "87850\n",
		h + "hwmon1/temp2_input": "60850\n", h + "hwmon1/temp2_label": "Sensor 1\n", h + "hwmon1/temp2_max": "65261850\n",
		h + "hwmon2/name": "nvme\n", h + "hwmon2/temp1_input": "41850\n", h + "hwmon2/temp1_label": "Composite\n",
		"sys/devices/pci0/0000:01:00.0/nvme/nvme1/nvme1n1/size": "1\n",
		"sys/devices/pci0/0000:02:00.0/nvme/nvme0/nvme0n1/size": "1\n",
		// Super I/O: SYSTIN is a board sensor, AUXTIN is unconnected (127)
		// and CPUTIN is not a board label.
		h + "hwmon3/name": "nct6798\n", h + "hwmon3/temp1_input": "57000\n", h + "hwmon3/temp1_label": "SYSTIN\n",
		h + "hwmon3/temp2_input": "59000\n", h + "hwmon3/temp2_label": "CPUTIN\n",
		h + "hwmon3/temp3_input": "127000\n", h + "hwmon3/temp3_label": "AUXTIN0\n",
		h + "hwmon3/temp1_max": "0\n",
		// DIMM sensors
		h + "hwmon4/name": "jc42\n", h + "hwmon4/temp1_input": "42000\n", h + "hwmon4/temp1_max": "85000\n",
		h + "hwmon5/name": "jc42\n", h + "hwmon5/temp1_input": "44250\n", h + "hwmon5/temp1_max": "85000\n",
		// SATA SSD via drivetemp
		h + "hwmon6/name": "drivetemp\n", h + "hwmon6/temp1_input": "38000\n", h + "hwmon6/temp1_max": "70000\n",
		"sys/devices/pci0/ata1/host0/target0:0:0/0:0:0:0/block/sdb/size": "1\n",
		"sys/block/sdb/queue/rotational":                                 "0\n",
		// NIC and ACPI sensors are ignored.
		h + "hwmon7/name": "enp5s0\n", h + "hwmon7/temp1_input": "52000\n", h + "hwmon7/temp1_label": "PHY Temperature\n",
		h + "hwmon8/name": "acpitz\n", h + "hwmon8/temp1_input": "16800\n",
	})
	link := func(target, name string) {
		if err := os.Symlink(filepath.Join(dir, target), filepath.Join(dir, name)); err != nil {
			t.Fatal(err)
		}
	}
	link("sys/devices/pci0/0000:01:00.0/nvme/nvme1", h+"hwmon1/device")
	// Older kernels: device points at the PCI function.
	link("sys/devices/pci0/0000:02:00.0", h+"hwmon2/device")
	link("sys/devices/pci0/ata1/host0/target0:0:0/0:0:0:0", h+"hwmon6/device")
	return dir
}

func TestReadHwmonAndBuildSensors(t *testing.T) {
	r := fsRoot(fakeHwmon(t))
	readings := hwmonTemps(r)
	// Add a SMART temperature of an HDD (no drivetemp for it).
	readings = append(readings, hwTemp{group: proto.SensorHDD, dev: "sda", tempC: 36, smart: true, label: "SMART"})
	got := map[string]proto.Sensor{}
	for _, s := range buildSensors(readings) {
		got[s.ID] = s
	}
	want := map[string]proto.Sensor{
		proto.SensorCPU:    {ID: proto.SensorCPU, Label: "CPU package", Group: "cpu", Source: "k10temp · Tctl", TempC: 64.3, LimitC: 85},
		proto.SensorNVMe:   {ID: proto.SensorNVMe, Label: "NVMe, hottest", Group: "nvme", Source: "nvme1n1 · composite", TempC: 48.9, LimitC: 83.9},
		proto.SensorBoard:  {ID: proto.SensorBoard, Label: "Board / VRM", Group: "board", Source: "nct6798 · SYSTIN", TempC: 57, LimitC: 90},
		proto.SensorDIMM:   {ID: proto.SensorDIMM, Label: "Memory modules", Group: "memory", Source: "jc42 · 2 sensors", TempC: 44.3, LimitC: 85},
		proto.SensorSATASS: {ID: proto.SensorSATASS, Label: "SATA SSD, hottest", Group: "ssd", Source: "sdb · drivetemp", TempC: 38, LimitC: 70},
		proto.SensorHDD:    {ID: proto.SensorHDD, Label: "HDD, hottest", Group: "hdd", Source: "sda · SMART", TempC: 36, LimitC: 55},
	}
	if len(got) != len(want) {
		t.Errorf("got %d groups: %+v", len(got), got)
	}
	for id, w := range want {
		if g := got[id]; g != w {
			t.Errorf("%s:\n got  %+v\n want %+v", id, g, w)
		}
	}
	// Order follows the group table.
	s := buildSensors(readings)
	if s[0].ID != proto.SensorCPU || s[len(s)-1].ID != proto.SensorSATASS {
		t.Errorf("order: %v ... %v", s[0].ID, s[len(s)-1].ID)
	}
}

func TestNVMeDeviceNameOlderKernel(t *testing.T) {
	r := fsRoot(fakeHwmon(t))
	var dev string
	for _, x := range hwmonTemps(r) {
		if x.group == proto.SensorNVMe && x.tempC < 45 {
			dev = x.dev
		}
	}
	if dev != "nvme0n1" {
		t.Errorf("hwmon2 device = %q, want nvme0n1", dev)
	}
}

func TestCoretempAndTdie(t *testing.T) {
	dir := t.TempDir()
	h := "sys/class/hwmon/"
	writeTree(t, dir, map[string]string{
		h + "hwmon0/name":        "coretemp\n",
		h + "hwmon0/temp1_input": "61000\n", h + "hwmon0/temp1_label": "Package id 0\n", h + "hwmon0/temp1_max": "80000\n", h + "hwmon0/temp1_crit": "100000\n",
		h + "hwmon0/temp2_input": "66000\n", h + "hwmon0/temp2_label": "Core 0\n",
		h + "hwmon1/name":        "coretemp\n",
		h + "hwmon1/temp1_input": "63000\n", h + "hwmon1/temp1_label": "Package id 1\n", h + "hwmon1/temp1_max": "80000\n",
	})
	s := buildSensors(hwmonTemps(fsRoot(dir)))
	if len(s) != 1 || s[0].Source != "coretemp · Package id 1" || s[0].TempC != 63 || s[0].LimitC != 80 {
		t.Errorf("coretemp: %+v", s)
	}
	dir2 := t.TempDir()
	writeTree(t, dir2, map[string]string{
		h + "hwmon0/name":        "k10temp\n",
		h + "hwmon0/temp1_input": "90000\n", h + "hwmon0/temp1_label": "Tctl\n",
		h + "hwmon0/temp2_input": "63000\n", h + "hwmon0/temp2_label": "Tdie\n",
	})
	s = buildSensors(hwmonTemps(fsRoot(dir2)))
	if len(s) != 1 || s[0].Source != "k10temp · Tdie" || s[0].TempC != 63 {
		t.Errorf("tdie: %+v", s)
	}
}

// hwmonTemps reads the temperatures without a drivetemp cache.
func hwmonTemps(r fsRoot) []hwTemp {
	t, _ := readHwmon(r, nil)
	return t
}
