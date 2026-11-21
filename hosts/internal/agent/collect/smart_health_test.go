package collect

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"rackoon/internal/proto"
)

func TestSmartATAHealth(t *testing.T) {
	d, err := parseSmartctl(readTestdata(t, "smart_hdd.json"), "hdd")
	if err != nil {
		t.Fatal(err)
	}
	if d.SelfTest == nil || *d.SelfTest != (proto.SelfTest{Type: "short", Result: "passed", PowerOnHours: 804}) {
		t.Errorf("self-test: %+v", d.SelfTest)
	}
	if d.ErrorLog == nil || *d.ErrorLog != 0 || d.CRC == nil || *d.CRC != 0 {
		t.Errorf("error log %v crc %v", d.ErrorLog, d.CRC)
	}
	if d.CritWarning != nil || d.Spare != nil {
		t.Error("NVMe fields on an ATA disk")
	}
	for _, c := range []struct {
		v    int
		s    string
		want string
	}{
		{0x00, "Completed without error", "passed"}, {0x10, "Aborted by host", "aborted"},
		{0x20, "Interrupted (host reset)", "interrupted"}, {0x79, "Completed: read failure", "failed"},
		{0xf9, "Self-test routine in progress", "running"}, {0x50, "Completed: electrical failure", "failed"},
	} {
		if got := ataTestResult(c.v, nil, c.s); got != c.want {
			t.Errorf("ataTestResult(%#x) = %s, want %s", c.v, got, c.want)
		}
	}
	if ataTestType("Extended offline") != "long" || ataTestType("Conveyance offline") != "conveyance" || ataTestType("Selective offline") != "offline" {
		t.Error("ataTestType")
	}
	// A running test shows in ata_smart_data.
	running := []byte(`{"smartctl":{"exit_status":0},"smart_status":{"passed":true},"power_on_time":{"hours":900},
 "ata_smart_data":{"self_test":{"status":{"value":249,"string":"in progress, 90% remaining","remaining_percent":90}}},
 "ata_smart_attributes":{"table":[{"id":199,"name":"UDMA_CRC_Error_Count","value":200,"raw":{"value":14}}]},
 "ata_smart_error_log":{"extended":{"revision":1,"sectors":1,"count":3}}}`)
	r, err := parseSmartctl(running, "hdd")
	if err != nil || r.SelfTest == nil || r.SelfTest.Result != "running" || *r.CRC != 14 || *r.ErrorLog != 3 {
		t.Errorf("running: %+v %v", r, err)
	}
}

func TestSmartNVMeHealth(t *testing.T) {
	ok, _ := parseSmartctl(readTestdata(t, "smart_nvme.json"), "nvme")
	if *ok.CritWarning != 0 || *ok.Spare != 100 || *ok.SpareThr != 10 || *ok.MediaErrors != 0 || *ok.ErrorLog != 0 || *ok.Unsafe != 0 || ok.SelfTest != nil {
		t.Errorf("healthy nvme: %+v", ok)
	}
	d, err := parseSmartctl(readTestdata(t, "smart_nvme_failing.json"), "nvme")
	if err != nil {
		t.Fatal(err)
	}
	if *d.CritWarning != 4 || *d.Spare != 8 || *d.MediaErrors != 17 || *d.ErrorLog != 1234 || *d.Unsafe != 42 || *d.Passed {
		t.Errorf("failing nvme: %+v", d)
	}
	if d.SelfTest == nil || *d.SelfTest != (proto.SelfTest{Type: "long", Result: "failed", PowerOnHours: 490}) {
		t.Errorf("self-test: %+v", d.SelfTest)
	}
	disks := []proto.Disk{{Device: "nvme0n1", Type: "nvme"}}
	s := newSMARTCollector(nil, nil)
	s.data["nvme0n1"] = d
	s.enrich(disks)
	x := disks[0]
	if x.CriticalWarning == nil || *x.CriticalWarning != 4 || x.SparePct == nil || *x.SpareThreshold != 10 || *x.UnsafeShutdowns != 42 || x.SelfTest == nil || *x.ErrorLogCount != 1234 {
		t.Errorf("enriched: %+v", x)
	}
	// Exit status bit 3 alone marks the disk failing.
	bit3 := []byte(`{"smartctl":{"exit_status":8},"nvme_smart_health_information_log":{"critical_warning":0}}`)
	if f, err := parseSmartctl(bit3, "nvme"); err != nil || f.Passed == nil || *f.Passed {
		t.Errorf("bit 3: %+v %v", f, err)
	}
}

func TestSmartUnsupported(t *testing.T) {
	if _, err := parseSmartctl(readTestdata(t, "smart_virtual.json"), "ssd"); !errors.Is(err, errSmartUnsupported) {
		t.Errorf("virtual disk: %v", err)
	}
	vda := []byte(`{"smartctl":{"exit_status":1,"messages":[{"string":"/dev/vda: Unable to detect device type","severity":"error"}]}}`)
	if _, err := parseSmartctl(vda, "ssd"); !errors.Is(err, errSmartUnsupported) {
		t.Errorf("vda: %v", err)
	}
	if _, err := parseSmartctl(readTestdata(t, "smart_megaraid.json"), "hdd"); err == nil || errors.Is(err, errSmartUnsupported) || !strings.Contains(err.Error(), "megaraid") {
		t.Errorf("megaraid: %v", err)
	}
}

// fakeSmartctl puts a smartctl on PATH that prints testdata files by
// device: sda an HDD, sdb in standby, sdc behind a controller that
// refuses, sdd a virtual disk without SMART.
func fakeSmartctl(t *testing.T, files map[string]string) {
	t.Helper()
	bin := t.TempDir()
	td, _ := filepath.Abs("testdata")
	script := "#!/bin/sh\nfor a; do dev=$a; done\ncase $dev in\n"
	for dev, f := range files {
		script += dev + ") cat " + filepath.Join(td, f) + "; exit 0;;\n"
	}
	script += "esac\nexit 2\n"
	if err := os.WriteFile(filepath.Join(bin, "smartctl"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+":"+os.Getenv("PATH"))
}

func TestSmartCollectorPerDisk(t *testing.T) {
	fakeSmartctl(t, map[string]string{"/dev/sda": "smart_hdd.json", "/dev/sdb": "smart_hdd.json", "/dev/sdc": "smart_megaraid.json", "/dev/sdd": "smart_virtual.json"})
	dc := newDiskCollector("")
	dc.last.Disks = []proto.Disk{{Device: "sda", Type: "hdd"}, {Device: "sdb", Type: "hdd"}, {Device: "sdc", Type: "hdd"}, {Device: "sdd", Type: "ssd"}}
	s := newSMARTCollector(nil, dc)
	err := s.run(context.Background())
	// One controller refuses: reported, but the collector still works.
	if err == nil || !isPartial(err) || !strings.Contains(err.Error(), "sdc:") || strings.Contains(err.Error(), "sdd") {
		t.Fatalf("err = %v", err)
	}
	if s.data["sda"] == nil || s.data["sdb"] == nil || s.data["sdc"] != nil || s.data["sdd"] != nil {
		t.Fatalf("data: %+v", s.data)
	}
	// sdb spins down: its values stay, marked standby; its temperature
	// no longer feeds the sensors.
	fakeSmartctl(t, map[string]string{"/dev/sda": "smart_hdd.json", "/dev/sdb": "smart_standby.json", "/dev/sdc": "smart_megaraid.json", "/dev/sdd": "smart_virtual.json"})
	s.run(context.Background())
	disks := []proto.Disk{{Device: "sdb", Type: "hdd"}}
	s.enrich(disks)
	if !disks[0].Standby || disks[0].PowerOnHours == nil || *disks[0].PowerOnHours != 816 || disks[0].SelfTest == nil {
		t.Errorf("standby disk: %+v", disks[0])
	}
	for _, d := range s.diskTemps() {
		if d.dev == "sdb" && !d.standby {
			t.Error("standby temperature not flagged")
		}
	}
	// Every disk failing fails the collector.
	dc.last.Disks = []proto.Disk{{Device: "sdc", Type: "hdd"}}
	if err := s.run(context.Background()); err == nil || isPartial(err) {
		t.Errorf("all failed: %v", err)
	}
	// Only unsupported disks: nothing to report, no error.
	dc.last.Disks = []proto.Disk{{Device: "sdd", Type: "ssd"}}
	if err := s.run(context.Background()); err != nil {
		t.Errorf("only unsupported: %v", err)
	}
}
