package hostmetrics

import (
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/CybexBV/whombat/contracts/go/local"
)

// sensors writes hwmon devices (<sys>/class/hwmon/hwmonN: attribute → value) and thermal zones
// (<sys>/class/thermal/thermal_zoneN: type and temp).
func sensors(t *testing.T, hwmon []map[string]string, zones [][2]string) string {
	t.Helper()
	sys := t.TempDir()
	files := map[string]string{"class/hwmon/": "", "class/thermal/": ""}
	for i, attrs := range hwmon {
		for k, v := range attrs {
			files[filepath.Join("class/hwmon", fmt.Sprintf("hwmon%d", i), k)] = v + "\n"
		}
	}
	for i, z := range zones {
		d := filepath.Join("class/thermal", fmt.Sprintf("thermal_zone%d", i))
		files[filepath.Join(d, "type")], files[filepath.Join(d, "temp")] = z[0]+"\n", z[1]+"\n"
	}
	tree(t, sys, files)
	return sys
}

// The disks', the network card's and the graphics chip's sensors are never the processor's.
var nvme = map[string]string{"name": "nvme", "temp1_label": "Composite", "temp1_input": "38850", "temp2_input": "61850"}
var amdgpu = map[string]string{"name": "amdgpu", "temp1_label": "edge", "temp1_input": "71000"}

func TestCPUTemp(t *testing.T) {
	for _, c := range []struct {
		name  string
		hwmon []map[string]string
		zones [][2]string
		want  any // int64 °C, or nil
	}{
		// The ROG Flow Z13 (Strix Halo): k10temp's Tctl, beside the graphics chip, a disk and the ACPI zone.
		{"the Z13", []map[string]string{nvme, amdgpu, {"name": "k10temp", "temp1_label": "Tctl", "temp1_input": "46125"}},
			[][2]string{{"acpitz", "52000"}}, int64(46)},
		// Threadripper 2000: Tctl carries a 27 °C offset for the fans; Tdie is the die.
		{"Tdie over Tctl", []map[string]string{{"name": "k10temp", "temp1_label": "Tctl", "temp1_input": "71500",
			"temp2_label": "Tdie", "temp2_input": "44500", "temp3_label": "Tccd1", "temp3_input": "48000"}}, nil, int64(45)},
		{"zenpower", []map[string]string{{"name": "zenpower", "temp1_label": "Tdie", "temp1_input": "39000",
			"temp2_label": "Tctl", "temp2_input": "39000"}}, nil, int64(39)},
		// Two Intel sockets: the hotter package.
		{"two coretemp packages", []map[string]string{
			{"name": "coretemp", "temp1_label": "Package id 0", "temp1_input": "51000", "temp2_label": "Core 0", "temp2_input": "58000"},
			{"name": "coretemp", "temp1_label": "Package id 1", "temp1_input": "63000"}}, nil, int64(63)},
		{"coretemp with cores only", []map[string]string{{"name": "coretemp", "temp2_label": "Core 0", "temp2_input": "41000",
			"temp3_label": "Core 1", "temp3_input": "44000"}}, nil, int64(44)},
		{"an older k10temp without labels", []map[string]string{{"name": "k10temp", "temp1_input": "36000"}}, nil, int64(36)},
		// A broken input is passed over: the other label is read.
		{"Tdie unreadable", []map[string]string{{"name": "k10temp", "temp1_label": "Tdie", "temp1_input": "-273000",
			"temp2_label": "Tctl", "temp2_input": "50000"}}, nil, int64(50)},
		// No hwmon driver of the processor: the most specific zone, the hottest of its type.
		{"Intel's package zone over ACPI's", []map[string]string{nvme},
			[][2]string{{"acpitz", "27800"}, {"x86_pkg_temp", "55000"}, {"x86_pkg_temp", "57400"}, {"iwlwifi_1", "40000"}}, int64(57)},
		{"a Raspberry Pi", nil, [][2]string{{"cpu-thermal", "48686"}}, int64(49)},
		{"the ACPI zone", nil, [][2]string{{"acpitz", "45000"}, {"acpitz", "0"}}, int64(45)},
		// A VM (John's DEV box: an empty hwmon, no zones), a desktop with only its disks', a zone nobody knows.
		{"a VM", nil, nil, nil},
		{"only the disks", []map[string]string{nvme, amdgpu}, [][2]string{{"iwlwifi_1", "40000"}}, nil},
		{"readings that aren't", []map[string]string{{"name": "k10temp", "temp1_label": "Tctl", "temp1_input": "0"}},
			[][2]string{{"acpitz", "200000"}, {"x86_pkg_temp", "hot"}}, nil},
	} {
		t.Run(c.name, func(t *testing.T) {
			got := readCPUTemp(sensors(t, c.hwmon, c.zones))
			switch want := c.want.(type) {
			case nil:
				if got != nil {
					t.Fatalf("%d °C, want none", *got)
				}
			case int64:
				if got == nil || *got != want {
					t.Fatalf("%v, want %d °C", got, want)
				}
			}
		})
	}
	if readCPUTemp(filepath.Join(t.TempDir(), "missing")) != nil {
		t.Fatal("a sysfs without hwmon or thermal reads a temperature")
	}
}

func TestUptime(t *testing.T) {
	for in, want := range map[string]any{"5585.91 22046.66\n": int64(5585), "0.42 0.10\n": int64(0), "": nil, "soon 1\n": nil,
		"-3 1\n": nil, "1e11 1\n": nil} {
		proc := t.TempDir()
		tree(t, proc, map[string]string{"uptime": in})
		got := readUptime(proc)
		if w, ok := want.(int64); ok != (got != nil) || (ok && *got != w) {
			t.Errorf("%q: %v, want %v", in, got, want)
		}
	}
	if readUptime(t.TempDir()) != nil {
		t.Error("no /proc/uptime reads an uptime")
	}
}

// TestSamplerTempAndUptime: the sample carries them, the runtime's answer has them as the contract's HostNow, and a
// machine without a sensor has no cpuTempC member at all.
func TestSamplerTempAndUptime(t *testing.T) {
	proc, sys := t.TempDir(), sensors(t, []map[string]string{nvme, {"name": "k10temp", "temp1_label": "Tctl", "temp1_input": "46125"}}, nil)
	tree(t, proc, map[string]string{"stat": "cpu  100 0 100 800 0 0 0 0 0 0\ncpu0 1\n", "meminfo": "MemTotal: 8000 kB\nMemAvailable: 2000 kB\n",
		"net/route": "Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\n", "uptime": "8040.52 120000.10\n"})
	at := time.Date(2026, 10, 20, 12, 34, 0, 0, time.UTC)
	s := New(Config{Proc: proc, Sys: sys, Now: func() time.Time { return at }, Log: slog.New(slog.NewTextHandler(io.Discard, nil))})
	s.measure(false)
	at = at.Add(time.Second)
	s.measure(true)
	res, err := s.Metrics(&local.HostMetricsRequest{V: 1, Range: "hour", TimeZone: "UTC"})
	if err != nil {
		t.Fatal(err)
	}
	now := res.Metrics.Now
	if now.CpuTempC == nil || *now.CpuTempC != 46 || now.UptimeS == nil || *now.UptimeS != 8040 {
		t.Fatalf("%v %v", now.CpuTempC, now.UptimeS)
	}
	if err := res.Validate(); err != nil {
		t.Fatal(err)
	}
	b, _ := json.Marshal(res)
	if _, err := local.ParseHostMetricsResponse(b); err != nil {
		t.Fatal(err)
	}
	// A VM: no sensor, so no member; the uptime stays.
	if err := os.RemoveAll(filepath.Join(sys, "class", "hwmon")); err != nil {
		t.Fatal(err)
	}
	at = at.Add(10 * time.Second)
	s.measure(true)
	res, _ = s.Metrics(&local.HostMetricsRequest{V: 1, Range: "hour", TimeZone: "UTC"})
	if b, _ := json.Marshal(res.Metrics.Now); res.Metrics.Now.CpuTempC != nil || strings.Contains(string(b), "cpuTempC") ||
		!strings.Contains(string(b), `"uptimeS":8040`) {
		t.Fatalf("%s", b)
	}
}
