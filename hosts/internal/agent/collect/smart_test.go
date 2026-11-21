package collect

import (
	"encoding/binary"
	"os"
	"testing"

	"rackoon/internal/proto"
)

func TestParseSmartctlNVMe(t *testing.T) {
	d, err := parseSmartctl(readTestdata(t, "smart_nvme.json"), "nvme")
	if err != nil {
		t.Fatal(err)
	}
	// exit_status 4 (a self-test log read failed) must not fail the parse.
	if d.Model != "Samsung SSD 9100 PRO 4TB" || d.Serial != "NVMESER0001" {
		t.Errorf("model/serial %q %q", d.Model, d.Serial)
	}
	if *d.Wear != 2 || *d.Written != 98900147*512000 || *d.TempC != 30 || *d.POH != 496 || !*d.Passed || *d.Uncorr != 0 {
		t.Errorf("nvme: wear=%v written=%v temp=%v poh=%v", *d.Wear, *d.Written, *d.TempC, *d.POH)
	}
	if d.Realloc != nil || d.Pending != nil {
		t.Error("nvme has no reallocated/pending counters")
	}
}

func TestParseSmartctlHDD(t *testing.T) {
	d, err := parseSmartctl(readTestdata(t, "smart_hdd.json"), "hdd")
	if err != nil {
		t.Fatal(err)
	}
	if d.Model != "WDC WD181KFGX-68CKWN0" || *d.TempC != 25 || *d.POH != 816 || !*d.Passed || d.TempLimit != 60 {
		t.Errorf("hdd: %+v", d)
	}
	if *d.Realloc != 0 || *d.Pending != 0 || *d.Uncorr != 0 {
		t.Errorf("sectors: %d %d %d", *d.Realloc, *d.Pending, *d.Uncorr)
	}
	if d.Wear != nil || d.Written != nil {
		t.Error("HDDs have no wear / written")
	}
}

func TestParseSmartctlSATASSD(t *testing.T) {
	samsung := []byte(`{"smartctl":{"exit_status":0},"device":{"type":"sat","protocol":"ATA"},
 "model_name":"Samsung SSD 870 EVO 1TB","serial_number":"X1","rotation_rate":0,"logical_block_size":512,
 "smart_status":{"passed":true},"temperature":{"current":33},"power_on_time":{"hours":12000},
 "ata_smart_attributes":{"table":[
  {"id":5,"name":"Reallocated_Sector_Ct","value":100,"raw":{"value":2}},
  {"id":177,"name":"Wear_Leveling_Count","value":91,"raw":{"value":84}},
  {"id":241,"name":"Total_LBAs_Written","value":99,"raw":{"value":100000000000}}]}}`)
	d, err := parseSmartctl(samsung, "ssd")
	if err != nil {
		t.Fatal(err)
	}
	if *d.Wear != 9 || *d.Written != 100000000000*512 || *d.Realloc != 2 {
		t.Errorf("samsung: wear=%v written=%v realloc=%v", *d.Wear, *d.Written, *d.Realloc)
	}
	if v := ratedTBW(d.Model); v == nil || *v != 600 {
		t.Errorf("tbw %v", v)
	}
	// Device statistics win over vendor attributes; Intel 32 MiB units.
	intel := []byte(`{"smartctl":{"exit_status":0},"model_name":"INTEL SSDSC2KB960G8","logical_block_size":512,
 "ata_smart_attributes":{"table":[
  {"id":233,"name":"Media_Wearout_Indicator","value":97,"raw":{"value":0}},
  {"id":241,"name":"Host_Writes_32MiB","value":100,"raw":{"value":1000}}]},
 "ata_device_statistics":{"pages":[
  {"number":1,"table":[{"name":"Logical Sectors Written","value":2000000,"flags":{"valid":true}}]},
  {"number":7,"table":[{"name":"Percentage Used Endurance Indicator","value":4,"flags":{"valid":true}}]}]}}`)
	d, err = parseSmartctl(intel, "ssd")
	if err != nil {
		t.Fatal(err)
	}
	if *d.Wear != 4 || *d.Written != 2000000*512 {
		t.Errorf("intel devstat: wear=%v written=%v", *d.Wear, *d.Written)
	}
	noDevstat := []byte(`{"smartctl":{"exit_status":0},"model_name":"INTEL SSDSC2KB960G8",
 "ata_smart_attributes":{"table":[
  {"id":233,"name":"Media_Wearout_Indicator","value":97,"raw":{"value":0}},
  {"id":241,"name":"Host_Writes_32MiB","value":100,"raw":{"value":1000}}]}}`)
	d, _ = parseSmartctl(noDevstat, "ssd")
	if *d.Wear != 3 || *d.Written != 1000*32<<20 {
		t.Errorf("intel attrs: wear=%v written=%v", *d.Wear, *d.Written)
	}
	crucial := []byte(`{"smartctl":{"exit_status":0},"model_name":"CT1000MX500SSD1",
 "ata_smart_attributes":{"table":[
  {"id":173,"name":"Ave_Block-Erase_Count","value":95,"raw":{"value":80}},
  {"id":202,"name":"Percent_Lifetime_Remain","value":95,"raw":{"value":5}},
  {"id":246,"name":"Total_LBAs_Written","value":100,"raw":{"value":5000}}]}}`)
	d, _ = parseSmartctl(crucial, "ssd")
	if *d.Wear != 5 || *d.Written != 5000*512 {
		t.Errorf("crucial: wear=%v written=%v", *d.Wear, *d.Written)
	}
}

func TestParseSmartctlStandbyAndErrors(t *testing.T) {
	standby := []byte(`{"smartctl":{"exit_status":2,"messages":[{"string":"Device is in STANDBY mode, exit(2)","severity":"information"}]},"device":{"name":"/dev/sdb"}}`)
	d, err := parseSmartctl(standby, "hdd")
	if err != nil || !d.Standby {
		t.Errorf("standby: %+v %v", d, err)
	}
	openFail := []byte(`{"smartctl":{"exit_status":2,"messages":[{"string":"Smartctl open device: /dev/sdz failed: No such device","severity":"error"}]}}`)
	if _, err := parseSmartctl(openFail, "hdd"); err == nil {
		t.Error("open failure should be an error")
	}
	if _, err := parseSmartctl([]byte("not json"), "hdd"); err == nil {
		t.Error("garbage should be an error")
	}
}

func TestParseNVMeHealthLog(t *testing.T) {
	b := make([]byte, 512)
	b[0] = 0
	binary.LittleEndian.PutUint16(b[1:], 273+41)
	b[5] = 7
	binary.LittleEndian.PutUint64(b[48:], 1000)   // data units written
	binary.LittleEndian.PutUint64(b[128:], 12345) // power-on hours
	binary.LittleEndian.PutUint64(b[160:], 1)     // media errors
	d := parseNVMeHealthLog(b)
	if *d.TempC != 41 || *d.Wear != 7 || *d.Written != 512000000 || *d.POH != 12345 || *d.Uncorr != 1 || !*d.Passed {
		t.Errorf("%+v", d)
	}
	b[0] = 0x04
	if d := parseNVMeHealthLog(b); *d.Passed {
		t.Error("critical warning must fail SMART")
	}
}

func TestRatedTBW(t *testing.T) {
	cases := map[string]float64{
		"Samsung SSD 990 PRO 2TB":       1200,
		"samsung ssd 990 pro 2tb  ":     1200,
		"Samsung SSD 9100 PRO 4TB":      2400,
		"WDC WDS100T1R0A-68A4W0":        600, // whitespace-collapsed
		"SAMSUNG MZQL23T8HCLS-00A07":    7008,
		"SAMSUNG MZQL23T8HCLS-00B7C":    7008, // OEM suffix
		"INTEL SSDSC2KB019T8R":          7100, // Dell variant
		"Micron_5300_MTFDDAK960TDS_SED": 2628,
	}
	for m, want := range cases {
		if v := ratedTBW(m); v == nil || *v != want {
			t.Errorf("ratedTBW(%q) = %v, want %v", m, v, want)
		}
	}
	for _, m := range []string{"", "WDC WD181KFGX-68CKWN0", "QEMU HARDDISK"} {
		if v := ratedTBW(m); v != nil {
			t.Errorf("ratedTBW(%q) = %v, want nil", m, *v)
		}
	}
}

func TestSmartEnrich(t *testing.T) {
	s := newSMARTCollector(nil, nil)
	nv, _ := parseSmartctl(readTestdata(t, "smart_nvme.json"), "nvme")
	hd, _ := parseSmartctl(readTestdata(t, "smart_hdd.json"), "hdd")
	s.data["nvme0n1"], s.typ["nvme0n1"] = nv, "nvme"
	s.data["sda"], s.typ["sda"] = hd, "hdd"
	disks := []proto.Disk{{Device: "nvme0n1", Type: "nvme", Model: "Samsung SSD 9100 PRO 4TB"}, {Device: "sda", Type: "hdd"}, {Device: "sdq", Type: "ssd", Model: "Samsung SSD 870 EVO 1TB"}}
	s.enrich(disks)
	if disks[0].WearPct == nil || *disks[0].RatedTBW != 2400 || *disks[0].PowerOnHours != 496 {
		t.Errorf("nvme: %+v", disks[0])
	}
	if disks[1].Model != "WDC WD181KFGX-68CKWN0" || disks[1].WearPct != nil || disks[1].RatedTBW != nil || *disks[1].TempC != 25 {
		t.Errorf("hdd: %+v", disks[1])
	}
	// No SMART data yet: rated TBW is still known from the model.
	if disks[2].RatedTBW == nil || disks[2].SmartPassed != nil {
		t.Errorf("ssd without smart: %+v", disks[2])
	}
	temps := s.diskTemps()
	if len(temps) != 2 {
		t.Errorf("temps: %+v", temps)
	}
}

// TestNVMeHealthLogLive reads a real NVMe health log through the ioctl
// fallback. It runs only when RACKOON_TEST_NVME names a device (as root):
//
//	sudo RACKOON_TEST_NVME=nvme0n1 ./collect.test -test.run NVMeHealthLogLive -test.v
func TestNVMeHealthLogLive(t *testing.T) {
	dev := os.Getenv("RACKOON_TEST_NVME")
	if dev == "" {
		t.Skip("RACKOON_TEST_NVME not set")
	}
	d, err := nvmeHealthLog(dev)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("%s: temp=%v wear=%v%% written=%v B poh=%v passed=%v media_errors=%v", dev, *d.TempC, *d.Wear, *d.Written, *d.POH, *d.Passed, *d.Uncorr)
}
