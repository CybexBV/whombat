package collect

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"rackoon/internal/proto"
)

func TestUPS(t *testing.T) {
	u := parseUpsc("rack", readTestdata(t, "upsc.txt"))
	if u.Name != "rack" || u.Source != "nut" || u.Model != "CPS CP1500EPFCLCD" || u.Status != "online" || u.StatusRaw != "OL CHRG" ||
		*u.ChargePct != 100 || *u.RuntimeS != 2280 || *u.LoadPct != 18 {
		t.Errorf("upsc: %+v", u)
	}
	a, ok := parseApcaccess(readTestdata(t, "apcaccess.txt"))
	if !ok || a.Name != "rack-ups" || a.Source != "apcupsd" || a.Model != "Back-UPS XS 1400U" || a.Status != "on_battery" ||
		*a.ChargePct != 87 || *a.RuntimeS != 1890 || *a.LoadPct != 21 {
		t.Errorf("apcaccess: %+v", a)
	}
	if _, ok := parseApcaccess([]byte("Error contacting host localhost port 3551: Connection refused\n")); ok {
		t.Error("daemon down parsed as a UPS")
	}
	for raw, want := range map[string]string{"OL": "online", "OB DISCHRG": "on_battery", "OB LB": "low_battery", "OFF": "offline", "": "unknown", "BYPASS": "unknown", "FSD OB LB": "low_battery"} {
		if got := nutStatus(raw); got != want {
			t.Errorf("nutStatus(%q) = %q, want %q", raw, got, want)
		}
	}
	for raw, want := range map[string]string{"ONLINE": "online", "ONBATT LOWBATT": "low_battery", "COMMLOST": "offline", "CAL": "unknown"} {
		if got := apcStatus(raw); got != want {
			t.Errorf("apcStatus(%q) = %q, want %q", raw, got, want)
		}
	}
}

func TestNvidiaSmi(t *testing.T) {
	g := parseNvidiaSmi(readTestdata(t, "nvidia_smi.csv"))
	if len(g) != 2 {
		t.Fatalf("%+v", g)
	}
	if x := g[0]; x.Name != "NVIDIA GeForce RTX 4090" || x.Vendor != "nvidia" || *x.UtilPct != 3 || *x.MemUsedBytes != 1234<<20 ||
		*x.MemTotalBytes != 24564<<20 || *x.TempC != 45 || *x.PowerW != 30.1 {
		t.Errorf("4090: %+v", x)
	}
	if x := g[1]; x.Index != 1 || x.UtilPct != nil || x.PowerW != nil || *x.TempC != 38 {
		t.Errorf("A2000: %+v", x)
	}
}

// fakeGPUs builds /sys/class/drm with an AMD dGPU (amdgpu sysfs + hwmon),
// an Intel iGPU and an ASPEED BMC display (skipped), plus pci.ids.
func fakeGPUs(t *testing.T) string {
	dir := t.TempDir()
	d := "sys/class/drm/"
	writeTree(t, dir, map[string]string{
		d + "card0/device/vendor": "0x1a03\n", d + "card0/device/device": "0x2000\n",
		d + "card1/device/vendor": "0x1002\n", d + "card1/device/device": "0x744c\n",
		d + "card1/device/gpu_busy_percent": "37\n", d + "card1/device/mem_info_vram_used": "2147483648\n",
		d + "card1/device/mem_info_vram_total":      "25753026560\n",
		d + "card1/device/hwmon/hwmon5/name":        "amdgpu\n",
		d + "card1/device/hwmon/hwmon5/temp1_input": "52000\n", d + "card1/device/hwmon/hwmon5/temp1_label": "edge\n",
		d + "card1/device/hwmon/hwmon5/temp2_input": "61000\n", d + "card1/device/hwmon/hwmon5/temp2_label": "junction\n",
		d + "card1/device/hwmon/hwmon5/power1_average": "48000000\n",
		d + "card1-DP-1/status":                        "connected\n",
		d + "card2/device/vendor":                      "0x8086\n", d + "card2/device/device": "0xa780\n",
		"usr/share/misc/pci.ids": "# pci.ids\n1002  Advanced Micro Devices, Inc. [AMD/ATI]\n\t7448  Navi 31 [Radeon Pro W7900]\n\t744c  Navi 31 [Radeon RX 7900 XT/7900 XTX/7900 GRE/7900M]\n\t\t1002 0e3b  RX 7900 GRE\n1014  IBM\n8086  Intel Corporation\n\ta780  Raptor Lake-S GT1 [UHD Graphics 770]\n",
	})
	return dir
}

func TestSysfsGPUs(t *testing.T) {
	g := newGPUCollector(fsRoot(fakeGPUs(t)), nil, nil)
	gpus := g.sysfsGPUs()
	if len(gpus) != 2 {
		t.Fatalf("gpus: %+v", gpus)
	}
	amd := gpus[0]
	if amd.Vendor != "amd" || amd.Index != 1 || amd.Name != "AMD Radeon RX 7900 XT/7900 XTX/7900 GRE/7900M" || *amd.UtilPct != 37 ||
		*amd.MemUsedBytes != 2<<30 || *amd.MemTotalBytes != 25753026560 || *amd.TempC != 52 || *amd.PowerW != 48 {
		t.Errorf("amd: %+v", amd)
	}
	if in := gpus[1]; in.Vendor != "intel" || in.Name != "Intel UHD Graphics 770" || in.UtilPct != nil || in.TempC != nil {
		t.Errorf("intel: %+v", in)
	}
}

func TestSensorsNICGPUFans(t *testing.T) {
	dir := t.TempDir()
	h := "sys/class/hwmon/"
	writeTree(t, dir, map[string]string{
		// A 10 GbE adapter: hwmon named after the interface.
		h + "hwmon3/name": "enp174s0\n", h + "hwmon3/temp1_input": "46000\n", h + "hwmon3/temp1_label": "PHY Temperature\n",
		h + "hwmon3/temp2_input": "48500\n", h + "hwmon3/temp2_label": "MAC Temperature\n",
		"sys/devices/pci0000:ae/0000:ae:00.0/net/enp174s0/mtu": "1500\n",
		// amdgpu with a crit limit.
		h + "hwmon5/name": "amdgpu\n", h + "hwmon5/temp1_input": "52000\n", h + "hwmon5/temp1_label": "edge\n", h + "hwmon5/temp1_crit": "100000\n",
		h + "hwmon5/temp2_input": "61000\n", h + "hwmon5/temp2_label": "junction\n", h + "hwmon5/temp2_crit": "110000\n",
		h + "hwmon5/fan1_input": "1200\n",
		// Super I/O fans: one labeled, one unconnected header (0 rpm), one with a minimum.
		h + "hwmon6/name": "nct6798\n", h + "hwmon6/fan1_input": "820\n", h + "hwmon6/fan1_label": "CPU fan\n",
		h + "hwmon6/fan2_input": "0\n", h + "hwmon6/fan3_input": "640\n", h + "hwmon6/fan3_min": "300\n",
	})
	if err := os.Symlink(filepath.Join(dir, "sys/devices/pci0000:ae/0000:ae:00.0"), filepath.Join(dir, h, "hwmon3/device")); err != nil {
		t.Fatal(err)
	}
	temps, fans := readHwmon(fsRoot(dir), nil)
	s := map[string]proto.Sensor{}
	for _, x := range buildSensors(temps) {
		s[x.ID] = x
	}
	if n := s[proto.SensorNIC]; n.TempC != 48.5 || n.LimitC != 100 || n.Source != "enp174s0 · MAC Temperature" || n.Label != "Network adapter, hottest" {
		t.Errorf("nic: %+v", n)
	}
	if g := s[proto.SensorGPU]; g.TempC != 61 || g.LimitC != 110 || g.Source != "amdgpu · junction" {
		t.Errorf("gpu: %+v", g)
	}
	var got []string
	for _, f := range fans {
		got = append(got, f.Label+"="+f.Source+":"+itoa(int(f.RPM))+"/"+itoa(int(f.MinRPM)))
	}
	if strings.Join(got, ",") != "fan1=amdgpu · fan1:1200/0,CPU fan=nct6798 · fan1:820/0,fan3=nct6798 · fan3:640/300" {
		t.Errorf("fans: %v", got)
	}
	// nvidia-smi temperatures join the GPU group.
	g := &gpuCollector{nvidia: parseNvidiaSmi(readTestdata(t, "nvidia_smi.csv"))}
	if nt := g.nvidiaTemps(); len(nt) != 2 || nt[0].group != proto.SensorGPU || nt[0].tempC != 45 {
		t.Errorf("nvidia temps: %+v", nt)
	}
}

// HDD drivetemp sensors are read at most every 5 minutes (reading them
// can keep the drive from spinning down); SSDs every time.
func TestDrivetempHDDCache(t *testing.T) {
	dir := t.TempDir()
	h := "sys/class/hwmon/"
	writeTree(t, dir, map[string]string{
		h + "hwmon1/name": "drivetemp\n", h + "hwmon1/temp1_input": "35000\n",
		"sys/devices/ata1/host0/target0:0:0/0:0:0:0/block/sda/size": "1\n", "sys/block/sda/queue/rotational": "1\n",
		h + "hwmon2/name": "drivetemp\n", h + "hwmon2/temp1_input": "30000\n",
		"sys/devices/ata2/host1/target1:0:0/1:0:0:0/block/sdb/size": "1\n", "sys/block/sdb/queue/rotational": "0\n",
	})
	os.Symlink(filepath.Join(dir, "sys/devices/ata1/host0/target0:0:0/0:0:0:0"), filepath.Join(dir, h, "hwmon1/device"))
	os.Symlink(filepath.Join(dir, "sys/devices/ata2/host1/target1:0:0/1:0:0:0"), filepath.Join(dir, h, "hwmon2/device"))
	cache := newHwmonCache()
	read := func() map[string]float64 {
		temps, _ := readHwmon(fsRoot(dir), cache)
		m := map[string]float64{}
		for _, x := range temps {
			m[x.dev] = x.tempC
		}
		return m
	}
	if m := read(); m["sda"] != 35 || m["sdb"] != 30 {
		t.Fatalf("first read: %v", m)
	}
	writeTree(t, dir, map[string]string{h + "hwmon1/temp1_input": "40000\n", h + "hwmon2/temp1_input": "33000\n"})
	if m := read(); m["sda"] != 35 || m["sdb"] != 33 {
		t.Errorf("cached HDD, fresh SSD: %v", m)
	}
	cache.mu.Lock()
	for k, v := range cache.temps {
		v.at = v.at.Add(-hddTempEvery)
		cache.temps[k] = v
	}
	cache.mu.Unlock()
	if m := read(); m["sda"] != 40 {
		t.Errorf("after 5 minutes: %v", m)
	}
}

// A disk in standby keeps its last SMART temperature in the HDD group
// (an upper bound: it has been cooling since), marked as such.
func TestSensorsStandbySMART(t *testing.T) {
	s := newSMARTCollector(nil, nil)
	s.data["sda"], s.typ["sda"] = &smartData{TempC: ptr(31.0), Standby: true}, "hdd"
	s.data["sdb"], s.typ["sdb"] = &smartData{TempC: ptr(29.0)}, "hdd"
	sc := newSensorsCollector(fsRoot(t.TempDir()), s, nil)
	if err := sc.run(context.Background()); err != nil {
		t.Fatal(err)
	}
	got := sc.snapshot()
	if len(got) != 1 || got[0].ID != proto.SensorHDD || got[0].Source != "sda · SMART, standby" || got[0].TempC != 31 {
		t.Errorf("sensors: %+v", got)
	}
	s.data["sda"].TempC = ptr(20.0)
	sc.run(context.Background())
	if got := sc.snapshot(); got[0].Source != "sdb · SMART" {
		t.Errorf("active disk hotter: %+v", got)
	}
}
