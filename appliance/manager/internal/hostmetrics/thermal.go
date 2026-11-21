package hostmetrics

// The processor's temperature and how long the box has been up (Whombat DK-22, DK-24, MG-72): HostNow.cpuTempC and
// HostNow.uptimeS, read with every sample. Both are world-readable in sysfs and procfs: no privilege, no unit change.

import (
	"math"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// cpuSensors are the hwmon drivers that measure the processor, each with the labels of its reading for the whole chip
// in the order they are preferred. AMD's Tdie is the die itself; Tctl is what the fans are driven by and on some chips
// (Threadripper 1000/2000) reads 10–27 °C above it. Intel's coretemp has one device per socket, each “Package id N”.
var cpuSensors = []struct {
	driver string
	labels []string // a label equal to one of these, or (ending in a space) starting with it
}{
	{"k10temp", []string{"Tdie", "Tctl"}},
	{"zenpower", []string{"Tdie", "Tctl"}},
	{"coretemp", []string{"Package id "}},
}

// cpuZones are the thermal zones that stand for the processor when no hwmon driver above is there, most specific
// first: Intel's package zone, the SoC's on ARM boards (a Raspberry Pi's `cpu-thermal`), and the ACPI zone, which the
// firmware usually puts on or near the processor.
var cpuZones = []string{"x86_pkg_temp", "cpu-thermal", "acpitz"}

// The bounds HostNow.cpuTempC allows (°C); a reading outside them is a broken sensor, not a temperature.
const (
	minTempC = -50
	maxTempC = 150
)

// readCPUTemp is the processor's temperature in whole °C from <sys>/class/hwmon (k10temp, zenpower, coretemp; the
// hottest when there are several, one per socket), else the hottest thermal zone of the first type in cpuZones that
// has a reading; nil when the machine has no such sensor (a VM) or none reads.
func readCPUTemp(sys string) *int64 {
	if t := hwmonTemp(filepath.Join(sys, "class", "hwmon")); t != nil {
		return t
	}
	return zoneTemp(filepath.Join(sys, "class", "thermal"))
}

func hwmonTemp(dir string) *int64 {
	ents, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var best *int64
	for _, e := range ents {
		if !strings.HasPrefix(e.Name(), "hwmon") {
			continue
		}
		dev := filepath.Join(dir, e.Name())
		name := attr(dev, "name")
		for _, s := range cpuSensors {
			if s.driver == name {
				best = hotter(best, chipTemp(dev, s.labels))
			}
		}
	}
	return best
}

// chipTemp is the reading of dev whose label comes first in labels, else its hottest (every input of these drivers is
// the processor's: a coretemp without a package reading has its cores, an older k10temp an unlabelled temp1).
func chipTemp(dev string, labels []string) *int64 {
	inputs, _ := filepath.Glob(filepath.Join(dev, "temp*_input"))
	byLabel := map[string]*int64{}
	var hottest *int64
	for _, in := range inputs {
		n := strings.TrimSuffix(filepath.Base(in), "_input")
		t := milliC(dev, n+"_input")
		if t == nil {
			continue
		}
		hottest = hotter(hottest, t)
		if l := attr(dev, n+"_label"); l != "" {
			byLabel[l] = hotter(byLabel[l], t)
		}
	}
	for _, want := range labels {
		var found *int64
		for l, t := range byLabel {
			if l == want || (strings.HasSuffix(want, " ") && strings.HasPrefix(l, want)) {
				found = hotter(found, t)
			}
		}
		if found != nil {
			return found
		}
	}
	return hottest
}

func zoneTemp(dir string) *int64 {
	ents, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	byType := map[string]*int64{}
	for _, e := range ents {
		if !strings.HasPrefix(e.Name(), "thermal_zone") {
			continue
		}
		z := filepath.Join(dir, e.Name())
		typ := attr(z, "type")
		byType[typ] = hotter(byType[typ], milliC(z, "temp"))
	}
	for _, typ := range cpuZones {
		if t := byType[typ]; t != nil {
			return t
		}
	}
	return nil
}

// milliC reads a sysfs temperature (millidegrees Celsius) as whole °C; nil when it can't be read, reads 0 (a sensor
// that isn't wired up) or lies outside the contract's bounds.
func milliC(dir, name string) *int64 {
	v, err := strconv.ParseInt(attr(dir, name), 10, 64)
	if err != nil || v == 0 {
		return nil
	}
	c := int64(math.Round(float64(v) / 1000))
	if c < minTempC || c > maxTempC {
		return nil
	}
	return &c
}

func hotter(a, b *int64) *int64 {
	if a == nil || (b != nil && *b > *a) {
		return b
	}
	return a
}

// readUptime is how long the box has been up, whole seconds (the first field of <proc>/uptime); nil when it can't be
// read.
func readUptime(proc string) *int64 {
	b, err := os.ReadFile(filepath.Join(proc, "uptime"))
	if err != nil {
		return nil
	}
	f := strings.Fields(string(b))
	if len(f) == 0 {
		return nil
	}
	v, err := strconv.ParseFloat(f[0], 64)
	if err != nil || v < 0 || v > 1e10 || math.IsNaN(v) {
		return nil
	}
	s := int64(v)
	return &s
}
