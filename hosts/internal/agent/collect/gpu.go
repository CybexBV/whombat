package collect

import (
	"bufio"
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

// gpuCollector reports graphics and compute adapters: NVIDIA through
// nvidia-smi (every 30 s; it is a heavy process), AMD and Intel from
// sysfs (amdgpu: busy percent, VRAM, hwmon temperature and power; i915 /
// xe: what hwmon offers) every 10 s. Absent when there is none.
type gpuCollector struct {
	root   fsRoot
	toggle toggleFn
	c      *collector

	mu        sync.Mutex
	gpus      []proto.GPU
	nvidia    []proto.GPU
	nvidiaAt  time.Time
	nvidiaErr error
	names     map[string]string // "vendor:device" -> PCI name
}

const nvidiaEvery = 30 * time.Second

func newGPUCollector(root fsRoot, toggle toggleFn, c *collector) *gpuCollector {
	return &gpuCollector{root: root, toggle: toggle, c: c, names: map[string]string{}}
}

var drmCardRE = regexp.MustCompile(`^card\d+$`)

// GPU vendors by PCI vendor id.
var gpuVendors = map[string]string{"0x10de": "nvidia", "0x1002": "amd", "0x8086": "intel"}

func (g *gpuCollector) run(ctx context.Context) error {
	if !g.toggle.enabled(true) {
		g.setAbsent(true)
		g.mu.Lock()
		g.gpus = nil
		g.mu.Unlock()
		return nil
	}
	var err error
	g.mu.Lock()
	nv, nvAt := g.nvidia, g.nvidiaAt
	g.mu.Unlock()
	if _, lerr := lookPath("nvidia-smi"); lerr == nil && time.Since(nvAt) >= nvidiaEvery-time.Second {
		var out []byte
		out, err = runCmd(ctx, 15*time.Second, "nvidia-smi",
			"--query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw",
			"--format=csv,noheader,nounits")
		nv = nil
		if err == nil {
			nv = parseNvidiaSmi(out)
		}
		g.mu.Lock()
		g.nvidia, g.nvidiaAt, g.nvidiaErr = nv, time.Now(), err
		g.mu.Unlock()
	} else {
		g.mu.Lock()
		err = g.nvidiaErr
		g.mu.Unlock()
	}

	gpus := append([]proto.GPU(nil), nv...)
	for _, s := range g.sysfsGPUs() {
		if s.Vendor == "nvidia" && len(nv) > 0 {
			continue // nvidia-smi knows more
		}
		gpus = append(gpus, s)
	}
	sort.SliceStable(gpus, func(i, j int) bool {
		if gpus[i].Vendor != gpus[j].Vendor {
			return gpus[i].Vendor < gpus[j].Vendor
		}
		return gpus[i].Index < gpus[j].Index
	})
	g.setAbsent(len(gpus) == 0 && err == nil)
	g.mu.Lock()
	g.gpus = gpus
	g.mu.Unlock()
	return err
}

func (g *gpuCollector) setAbsent(v bool) {
	if g.c != nil {
		g.c.gpuSub.setAbsent(v)
	}
}

func (g *gpuCollector) snapshot() []proto.GPU {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.gpus == nil {
		return nil
	}
	out := make([]proto.GPU, len(g.gpus))
	for i, x := range g.gpus {
		x.UtilPct, x.TempC, x.PowerW = copyPtr(x.UtilPct), copyPtr(x.TempC), copyPtr(x.PowerW)
		x.MemUsedBytes, x.MemTotalBytes = copyPtr(x.MemUsedBytes), copyPtr(x.MemTotalBytes)
		out[i] = x
	}
	return out
}

// nvidiaTemps returns nvidia-smi temperatures for the GPU sensor group
// (sysfs GPUs are read by the sensors collector from hwmon directly).
func (g *gpuCollector) nvidiaTemps() []hwTemp {
	if g == nil {
		return nil
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	var out []hwTemp
	for _, x := range g.nvidia {
		if x.TempC != nil && plausible(*x.TempC) {
			out = append(out, hwTemp{group: proto.SensorGPU, driver: "nvidia-smi", label: fmt.Sprintf("GPU %d", x.Index), tempC: *x.TempC})
		}
	}
	return out
}

// parseNvidiaSmi parses `nvidia-smi --query-gpu=index,name,utilization.gpu,
// memory.used,memory.total,temperature.gpu,power.draw --format=csv,noheader,nounits`
// (memory in MiB, power in W; "[N/A]" / "[Not Supported]" for missing values).
func parseNvidiaSmi(b []byte) []proto.GPU {
	var out []proto.GPU
	scanLines(b, func(line string) {
		f := strings.Split(line, ",")
		if len(f) < 7 {
			return
		}
		for i := range f {
			f[i] = strings.TrimSpace(f[i])
		}
		idx, err := strconv.Atoi(f[0])
		if err != nil {
			return
		}
		num := func(s string) *float64 {
			if strings.HasPrefix(s, "[") {
				return nil
			}
			v, err := strconv.ParseFloat(s, 64)
			if err != nil {
				return nil
			}
			return &v
		}
		x := proto.GPU{Index: idx, Name: f[1], Vendor: "nvidia"}
		x.UtilPct = num(f[2])
		if v := num(f[3]); v != nil {
			x.MemUsedBytes = ptr(uint64(*v * (1 << 20)))
		}
		if v := num(f[4]); v != nil {
			x.MemTotalBytes = ptr(uint64(*v * (1 << 20)))
		}
		x.TempC = num(f[5])
		if v := num(f[6]); v != nil {
			x.PowerW = ptr(round1(*v))
		}
		out = append(out, x)
	})
	return out
}

// sysfsGPUs reads /sys/class/drm/cardN of NVIDIA, AMD and Intel adapters
// (BMC display controllers and other vendors are skipped).
func (g *gpuCollector) sysfsGPUs() []proto.GPU {
	r := g.root
	ents, err := os.ReadDir(r.path("/sys/class/drm"))
	if err != nil {
		return nil
	}
	var out []proto.GPU
	for _, e := range ents {
		if !drmCardRE.MatchString(e.Name()) {
			continue
		}
		dev := "/sys/class/drm/" + e.Name() + "/device"
		vendorID := r.readString(dev + "/vendor")
		vendor, ok := gpuVendors[vendorID]
		if !ok {
			continue
		}
		idx, _ := strconv.Atoi(strings.TrimPrefix(e.Name(), "card"))
		x := proto.GPU{Index: idx, Vendor: vendor}
		x.Name = r.readString(dev + "/product_name")
		if x.Name == "" {
			x.Name = g.pciName(vendorID, r.readString(dev+"/device"), vendor)
		}
		if vendor == "amd" {
			if v, ok := r.readInt(dev + "/gpu_busy_percent"); ok {
				x.UtilPct = ptr(float64(v))
			}
			if v, ok := r.readInt(dev + "/mem_info_vram_used"); ok {
				x.MemUsedBytes = ptr(uint64(v))
			}
			if v, ok := r.readInt(dev + "/mem_info_vram_total"); ok && v > 0 {
				x.MemTotalBytes = ptr(uint64(v))
			}
		}
		if hw, _ := filepath.Glob(r.path(dev + "/hwmon/hwmon*")); len(hw) > 0 {
			sort.Strings(hw)
			x.TempC, x.PowerW = gpuHwmon(hw[0])
		}
		out = append(out, x)
	}
	return out
}

// gpuHwmon reads a GPU's hwmon: the "edge" temperature (or temp1) and
// the average or current power in W.
func gpuHwmon(dir string) (temp, power *float64) {
	files, _ := filepath.Glob(filepath.Join(dir, "temp*_input"))
	sort.Strings(files)
	for _, f := range files {
		v, ok := readMilli(f)
		if !ok || !plausible(v) {
			continue
		}
		label := readTrim(strings.TrimSuffix(f, "_input") + "_label")
		if temp == nil || label == "edge" {
			temp = ptr(round1(v))
		}
		if label == "edge" {
			break
		}
	}
	for _, n := range []string{"power1_average", "power1_input"} {
		if s := readTrim(filepath.Join(dir, n)); s != "" {
			if uw, err := strconv.ParseFloat(s, 64); err == nil && uw > 0 {
				power = ptr(round1(uw / 1e6))
				break
			}
		}
	}
	return temp, power
}

// pciName looks a device up in the PCI ID database (pci.ids), cached.
func (g *gpuCollector) pciName(vendorID, deviceID, vendor string) string {
	v := strings.TrimPrefix(strings.ToLower(vendorID), "0x")
	d := strings.TrimPrefix(strings.ToLower(deviceID), "0x")
	key := v + ":" + d
	g.mu.Lock()
	name, ok := g.names[key]
	g.mu.Unlock()
	if ok {
		return name
	}
	name = lookupPCIName(g.root, v, d)
	if name == "" {
		name = fmt.Sprintf("%s GPU (%s)", map[string]string{"nvidia": "NVIDIA", "amd": "AMD", "intel": "Intel"}[vendor], key)
	}
	g.mu.Lock()
	g.names[key] = name
	g.mu.Unlock()
	return name
}

// lookupPCIName scans pci.ids for vendor v, device d (lowercase hex).
// Device names carry the vendor's marketing name in brackets, e.g.
// "Navi 31 [Radeon RX 7900 XT/7900 XTX]": the bracketed part is used.
func lookupPCIName(r fsRoot, v, d string) string {
	for _, p := range []string{"/usr/share/hwdata/pci.ids", "/usr/share/misc/pci.ids", "/usr/share/pci.ids"} {
		f, err := os.Open(r.path(p))
		if err != nil {
			continue
		}
		defer f.Close()
		sc := bufio.NewScanner(f)
		inVendor := false
		vendorName := ""
		for sc.Scan() {
			line := sc.Text()
			if line == "" || line[0] == '#' {
				continue
			}
			if line[0] != '\t' {
				if inVendor {
					return ""
				}
				if strings.HasPrefix(line, v+"  ") {
					inVendor = true
					vendorName = strings.TrimSpace(line[len(v):])
				}
				continue
			}
			if inVendor && len(line) > 1 && line[1] != '\t' && strings.HasPrefix(line[1:], d+"  ") {
				name := strings.TrimSpace(line[1+len(d):])
				if i, j := strings.Index(name, "["), strings.LastIndex(name, "]"); i >= 0 && j > i {
					name = name[i+1 : j]
				}
				short := strings.Fields(vendorName)
				if len(short) > 0 && !strings.Contains(name, short[0]) {
					name = gpuVendorPrefix(short[0]) + name
				}
				return name
			}
		}
		return ""
	}
	return ""
}

func gpuVendorPrefix(v string) string {
	switch strings.ToLower(v) {
	case "nvidia":
		return "NVIDIA "
	case "advanced":
		return "AMD "
	case "intel":
		return "Intel "
	}
	return v + " "
}
