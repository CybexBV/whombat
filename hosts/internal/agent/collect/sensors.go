package collect

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"rackoon/internal/proto"
)

// sensorGroup describes one of the report groups.
type sensorGroup struct {
	id, label, group string
	defaultLimit     float64
	saneMin, saneMax float64 // accepted range for hwmon max/crit as a limit
}

var sensorGroups = []sensorGroup{
	{proto.SensorCPU, "CPU package", "cpu", 85, 60, 110},
	{proto.SensorBoard, "Board / VRM", "board", 90, 60, 125},
	{proto.SensorNVMe, "NVMe, hottest", "nvme", 75, 50, 100},
	{proto.SensorDIMM, "Memory modules", "memory", 85, 60, 100},
	{proto.SensorHDD, "HDD, hottest", "hdd", 55, 40, 70},
	{proto.SensorSATASS, "SATA SSD, hottest", "ssd", 70, 50, 90},
	{proto.SensorNIC, "Network adapter, hottest", "nic", 100, 60, 130},
	{proto.SensorGPU, "GPU, hottest", "gpu", 90, 60, 120},
}

// hwTemp is one temperature reading.
type hwTemp struct {
	group  string // sensor group id
	driver string // hwmon name
	label  string
	dev    string // block device for nvme/drivetemp/SMART
	tempC  float64
	maxC   float64 // 0 = absent
	critC  float64
	smart  bool // from smartctl rather than hwmon
	// standby: a SMART value from before the disk spun down (an upper
	// bound: the disk has been cooling since).
	standby bool
}

// hddTempEvery is how often an HDD's drivetemp sensor is read: the
// driver sends the drive an ATA command, which can keep it from spinning
// down (or wake it) when done every 10 s.
const hddTempEvery = 5 * time.Minute

// hwmonCache keeps the last drivetemp readings of HDDs.
type hwmonCache struct {
	mu    sync.Mutex
	temps map[string]cachedTemps // by hwmon directory
}

type cachedTemps struct {
	at    time.Time
	temps []hwTemp
}

func newHwmonCache() *hwmonCache { return &hwmonCache{temps: map[string]cachedTemps{}} }

func (c *hwmonCache) get(dir string, now time.Time) ([]hwTemp, bool) {
	if c == nil {
		return nil, false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.temps[dir]
	if !ok || now.Sub(e.at) >= hddTempEvery {
		return nil, false
	}
	return e.temps, true
}

func (c *hwmonCache) put(dir string, now time.Time, temps []hwTemp) {
	if c == nil {
		return
	}
	c.mu.Lock()
	c.temps[dir] = cachedTemps{at: now, temps: temps}
	c.mu.Unlock()
}

// readHwmon reads every temp*_input of /sys/class/hwmon and classifies it,
// and every fan*_input. Unclassified temperature sensors (ACPI thermal
// zones, Wi-Fi) are dropped. HDD drivetemp sensors are read at most every
// hddTempEvery (cache; nil = always read).
func readHwmon(r fsRoot, cache *hwmonCache) ([]hwTemp, []proto.Fan) {
	base := r.path("/sys/class/hwmon")
	entries, err := os.ReadDir(base)
	if err != nil {
		return nil, nil
	}
	now := time.Now()
	var out []hwTemp
	var fans []proto.Fan
	for _, e := range entries {
		dir := filepath.Join(base, e.Name())
		driver := readTrim(filepath.Join(dir, "name"))
		if driver == "" {
			continue
		}
		files, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		fans = append(fans, readFans(dir, driver, files)...)
		hdd := false
		if driver == "drivetemp" {
			if dev := scsiBlockName(dir); dev != "" && r.readString("/sys/block/"+dev+"/queue/rotational") == "1" {
				hdd = true
				if t, ok := cache.get(dir, now); ok {
					out = append(out, t...)
					continue
				}
			}
		}
		var temps []hwTemp
		for _, f := range files {
			n := f.Name()
			if !strings.HasPrefix(n, "temp") || !strings.HasSuffix(n, "_input") {
				continue
			}
			pfx := strings.TrimSuffix(n, "_input")
			v, ok := readMilli(filepath.Join(dir, n))
			if !ok {
				continue
			}
			t := hwTemp{
				driver: driver,
				label:  readTrim(filepath.Join(dir, pfx+"_label")),
				tempC:  v,
			}
			t.maxC, _ = readMilli(filepath.Join(dir, pfx+"_max"))
			t.critC, _ = readMilli(filepath.Join(dir, pfx+"_crit"))
			if t.label == "" {
				t.label = pfx
			}
			temps = append(temps, t)
		}
		if len(temps) == 0 {
			continue
		}
		cls := classifyHwmon(r, dir, driver, temps)
		if hdd {
			cache.put(dir, now, cls)
		}
		out = append(out, cls...)
	}
	sort.SliceStable(fans, func(i, j int) bool { return fans[i].Source < fans[j].Source })
	return out, fans
}

var fanInputRE = regexp.MustCompile(`^fan(\d+)_input$`)

// readFans reads fanN_input (RPM) with fanN_label and fanN_min. A fan is
// reported when it has a label or spins: unlabeled inputs that read 0 are
// usually unconnected headers.
func readFans(dir, driver string, files []os.DirEntry) []proto.Fan {
	var out []proto.Fan
	for _, f := range files {
		m := fanInputRE.FindStringSubmatch(f.Name())
		if m == nil {
			continue
		}
		v, err := strconv.ParseFloat(readTrim(filepath.Join(dir, f.Name())), 64)
		if err != nil || v < 0 {
			continue
		}
		pfx := "fan" + m[1]
		label := readTrim(filepath.Join(dir, pfx+"_label"))
		if label == "" && v == 0 {
			continue
		}
		fan := proto.Fan{Label: label, Source: driver + " · " + pfx, RPM: v}
		if fan.Label == "" {
			fan.Label = pfx
		}
		if mn, err := strconv.ParseFloat(readTrim(filepath.Join(dir, pfx+"_min")), 64); err == nil && mn > 0 {
			fan.MinRPM = mn
		}
		out = append(out, fan)
	}
	return out
}

// gpuHwmonDrivers are GPU drivers whose hwmon carries GPU temperatures.
var gpuHwmonDrivers = map[string]bool{"amdgpu": true, "radeon": true, "nouveau": true, "i915": true, "xe": true}

func readTrim(p string) string {
	b, err := os.ReadFile(p)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

// readMilli reads a millidegree file and returns degrees.
func readMilli(p string) (float64, bool) {
	s := readTrim(p)
	if s == "" {
		return 0, false
	}
	var v int64
	if _, err := fmt.Sscan(s, &v); err != nil {
		return 0, false
	}
	return float64(v) / 1000, true
}

var (
	boardDriverRE = regexp.MustCompile(`^(nct\d+|it\d+|it87.*|w83.*|f71.*|f81.*|asus.*|asus_wmi_sensors|asus-ec-sensors|asusec|gigabyte_wmi|dell_smm|nct6775|nct6683|nct7802|sch56\d\d|pc87\d+|ipmi.*)$`)
	boardLabelRE  = regexp.MustCompile(`(?i)^(systin|vrm.*|.*\bvrm\b.*|motherboard|mainboard|mb( temp)?|mb_temp|board( temp)?|system( temp)?|chipset|pch|pch_chip_temp|pch temp|sb temp|nb temp)$`)
	coretempPkgRE = regexp.MustCompile(`^(Package id \d+|Physical id \d+)$`)
	nvmeNSRE      = regexp.MustCompile(`^nvme\d+n\d+$`)
	nvmeCtrlRE    = regexp.MustCompile(`^nvme\d+$`)
)

// plausible rejects unconnected / bogus readings (-128, 127, 0).
func plausible(t float64) bool { return t > 1 && t < 125 }

func classifyHwmon(r fsRoot, dir, driver string, temps []hwTemp) []hwTemp {
	var out []hwTemp
	switch {
	case driver == "k10temp" || driver == "zenpower":
		// Tdie is the real die temperature where both exist (Tctl may
		// carry an offset on older Ryzen / Threadripper).
		var pick *hwTemp
		for i := range temps {
			t := &temps[i]
			if t.label == "Tdie" {
				pick = t
				break
			}
			if t.label == "Tctl" || (pick == nil && t.label == "temp1") {
				pick = t
			}
		}
		if pick != nil && plausible(pick.tempC) {
			if pick.label == "temp1" {
				pick.label = "Tctl"
			}
			pick.group = proto.SensorCPU
			out = append(out, *pick)
		}
	case driver == "coretemp":
		for _, t := range temps {
			if coretempPkgRE.MatchString(t.label) && plausible(t.tempC) {
				t.group = proto.SensorCPU
				out = append(out, t)
			}
		}
	case driver == "cpu_thermal":
		for _, t := range temps {
			if plausible(t.tempC) {
				t.group = proto.SensorCPU
				out = append(out, t)
			}
		}
	case driver == "nvme":
		dev := nvmeDeviceName(dir)
		for _, t := range temps {
			if (t.label == "Composite" || t.label == "temp1") && plausible(t.tempC) {
				t.group = proto.SensorNVMe
				t.label = "composite"
				t.dev = dev
				out = append(out, t)
				break
			}
		}
	case driver == "drivetemp":
		dev := scsiBlockName(dir)
		if dev == "" {
			break
		}
		g := proto.SensorSATASS
		if r.readString("/sys/block/"+dev+"/queue/rotational") == "1" {
			g = proto.SensorHDD
		}
		for _, t := range temps {
			if plausible(t.tempC) {
				t.group = g
				t.dev = dev
				t.label = "drivetemp"
				out = append(out, t)
				break
			}
		}
	case driver == "jc42" || driver == "spd5118" || driver == "ee1004":
		for _, t := range temps {
			if plausible(t.tempC) {
				t.group = proto.SensorDIMM
				out = append(out, t)
			}
		}
	case strings.HasPrefix(driver, "pch_"):
		for _, t := range temps {
			if plausible(t.tempC) {
				t.group = proto.SensorBoard
				if strings.HasPrefix(t.label, "temp") {
					t.label = "PCH"
				}
				out = append(out, t)
			}
		}
	case boardDriverRE.MatchString(driver):
		for _, t := range temps {
			if boardLabelRE.MatchString(strings.TrimSpace(t.label)) && plausible(t.tempC) {
				t.group = proto.SensorBoard
				out = append(out, t)
			}
		}
	case gpuHwmonDrivers[driver]:
		for _, t := range temps {
			if plausible(t.tempC) {
				t.group = proto.SensorGPU
				out = append(out, t)
			}
		}
	case isDir(filepath.Join(dir, "device", "net")):
		// A network adapter's PHY / MAC sensors; the hwmon is often named
		// after the interface ("enp174s0").
		for _, t := range temps {
			if plausible(t.tempC) {
				t.group = proto.SensorNIC
				out = append(out, t)
			}
		}
	}
	return out
}

func isDir(p string) bool {
	st, err := os.Stat(p)
	return err == nil && st.IsDir()
}

// nvmeDeviceName maps an nvme hwmon directory to its namespace block device
// ("nvme1n1"); falls back to the controller name.
func nvmeDeviceName(dir string) string {
	dev, err := filepath.EvalSymlinks(filepath.Join(dir, "device"))
	if err != nil {
		return ""
	}
	ctrl := ""
	if nvmeCtrlRE.MatchString(filepath.Base(dev)) {
		ctrl = dev
	} else if m, _ := filepath.Glob(filepath.Join(dev, "nvme", "nvme*")); len(m) > 0 {
		sort.Strings(m)
		ctrl = m[0]
	}
	if ctrl == "" {
		return ""
	}
	ents, _ := os.ReadDir(ctrl)
	var ns []string
	for _, e := range ents {
		if nvmeNSRE.MatchString(e.Name()) {
			ns = append(ns, e.Name())
		}
	}
	if len(ns) > 0 {
		sort.Strings(ns)
		return ns[0]
	}
	// Multipath namespaces appear as nvmeXcYnZ under the controller.
	return filepath.Base(ctrl) + "n1"
}

// scsiBlockName maps a drivetemp hwmon directory to its block device.
func scsiBlockName(dir string) string {
	m, _ := filepath.Glob(filepath.Join(dir, "device", "block", "*"))
	if len(m) == 0 {
		return ""
	}
	sort.Strings(m)
	return filepath.Base(m[0])
}

// buildSensors reduces readings to one Sensor per group (hottest member).
func buildSensors(readings []hwTemp) []proto.Sensor {
	byGroup := map[string][]hwTemp{}
	for _, t := range readings {
		byGroup[t.group] = append(byGroup[t.group], t)
	}
	var out []proto.Sensor
	for _, g := range sensorGroups {
		ts := byGroup[g.id]
		if len(ts) == 0 {
			continue
		}
		hot := ts[0]
		for _, t := range ts[1:] {
			if t.tempC > hot.tempC {
				hot = t
			}
		}
		s := proto.Sensor{
			ID:     g.id,
			Label:  g.label,
			Group:  g.group,
			TempC:  round1(hot.tempC),
			LimitC: g.defaultLimit,
		}
		switch {
		case hot.maxC >= g.saneMin && hot.maxC <= g.saneMax:
			s.LimitC = round1(hot.maxC)
		case hot.critC >= g.saneMin && hot.critC <= g.saneMax:
			s.LimitC = round1(hot.critC)
		}
		switch g.id {
		case proto.SensorDIMM:
			n := len(ts)
			unit := "sensors"
			if n == 1 {
				unit = "sensor"
			}
			s.Source = fmt.Sprintf("%s · %d %s", hot.driver, n, unit)
		case proto.SensorNVMe:
			s.Source = hot.dev + " · composite"
		case proto.SensorHDD, proto.SensorSATASS:
			if hot.smart {
				s.Source = hot.dev + " · SMART"
				if hot.standby {
					s.Source += ", standby"
				}
			} else {
				s.Source = hot.dev + " · drivetemp"
			}
		default:
			s.Source = hot.driver + " · " + hot.label
		}
		out = append(out, s)
	}
	return out
}

// sensorsCollector reads hwmon every 10 s and adds the latest SMART
// temperatures of SATA/SAS disks that have no drivetemp sensor (SMART runs
// every 10 minutes; a disk in standby keeps its last value, marked) and
// nvidia-smi's GPU temperatures. It also reads the fans.
type sensorsCollector struct {
	root  fsRoot
	smart *smartCollector
	gpu   *gpuCollector
	cache *hwmonCache

	mu      sync.Mutex
	sensors []proto.Sensor
	fans    []proto.Fan
}

func newSensorsCollector(root fsRoot, smart *smartCollector, gpu *gpuCollector) *sensorsCollector {
	return &sensorsCollector{root: root, smart: smart, gpu: gpu, cache: newHwmonCache()}
}

func (s *sensorsCollector) run(ctx context.Context) error {
	readings, fans := readHwmon(s.root, s.cache)
	have := map[string]bool{}
	for _, t := range readings {
		if t.dev != "" {
			have[t.dev] = true
		}
	}
	readings = append(readings, s.gpu.nvidiaTemps()...)
	for _, d := range s.smart.diskTemps() {
		if have[d.dev] || d.typ == "nvme" {
			continue
		}
		g := proto.SensorSATASS
		if d.typ == "hdd" {
			g = proto.SensorHDD
		}
		readings = append(readings, hwTemp{group: g, dev: d.dev, tempC: d.tempC, maxC: d.limitC, smart: true, label: "SMART", standby: d.standby})
	}
	out := buildSensors(readings)
	s.mu.Lock()
	s.sensors, s.fans = out, fans
	s.mu.Unlock()
	return nil
}

func (s *sensorsCollector) fanSnapshot() []proto.Fan {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.fans) == 0 {
		return nil
	}
	return append([]proto.Fan(nil), s.fans...)
}

func (s *sensorsCollector) snapshot() []proto.Sensor {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.sensors == nil {
		return nil
	}
	return append([]proto.Sensor(nil), s.sensors...)
}
