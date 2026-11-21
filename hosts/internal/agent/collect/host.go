package collect

import (
	"bufio"
	"bytes"
	"context"
	"net"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"rackoon/internal/proto"
)

// hostCollector gathers mostly static host information. Cheap parts are
// re-read every intervalHost; dmidecode and systemd-detect-virt run once.
type hostCollector struct {
	root fsRoot

	mu   sync.Mutex
	info proto.HostInfo

	onceDone   bool
	memType    string
	virt       string
	isPVE      bool
	pveVersion string
	pveChecked time.Time
}

func newHostCollector(root fsRoot) *hostCollector { return &hostCollector{root: root} }

func (h *hostCollector) snapshot() proto.HostInfo {
	h.mu.Lock()
	defer h.mu.Unlock()
	info := h.info
	info.Addresses = append([]string(nil), h.info.Addresses...)
	return info
}

func (h *hostCollector) run(ctx context.Context) error {
	r := h.root
	var info proto.HostInfo

	info.MachineID = r.readString("/etc/machine-id")
	if info.MachineID == "" {
		info.MachineID = r.readString("/var/lib/dbus/machine-id")
	}
	info.Hostname = r.readString("/proc/sys/kernel/hostname")
	if info.Hostname == "" {
		info.Hostname, _ = os.Hostname()
	}
	info.Kernel = r.readString("/proc/sys/kernel/osrelease")

	osr, _ := r.read("/etc/os-release")
	if len(osr) == 0 {
		osr, _ = r.read("/usr/lib/os-release")
	}
	info.OSName, info.OSVersion, info.OSPretty = parseOSRelease(osr)

	// The CPU model never changes; /proc/cpuinfo is large on big hosts.
	h.mu.Lock()
	info.CPUModel = h.info.CPUModel
	h.mu.Unlock()
	if info.CPUModel == "" {
		if b, err := r.read("/proc/cpuinfo"); err == nil {
			info.CPUModel = shortCPUModel(cpuinfoModel(b))
		}
	}
	info.Threads = parseCPUList(r.readString("/sys/devices/system/cpu/online"))
	info.Cores = countCores(r)
	if info.Cores == 0 {
		info.Cores = info.Threads
	}
	if b, err := r.read("/proc/meminfo"); err == nil {
		m := parseMeminfo(b)
		info.MemoryTotalBytes = m["MemTotal"]
	}
	if b, err := r.read("/proc/stat"); err == nil {
		scanLines(b, func(line string) {
			if v, ok := strings.CutPrefix(line, "btime "); ok {
				if sec, err := strconv.ParseInt(strings.TrimSpace(v), 10, 64); err == nil {
					info.BootTime = time.Unix(sec, 0).UTC()
				}
			}
		})
	}
	info.Addresses = hostAddresses(r)

	h.mu.Lock()
	once := !h.onceDone
	h.onceDone = true
	h.mu.Unlock()
	if once {
		memType := ""
		if out, err := runCmd(ctx, 10*time.Second, "dmidecode", "-t", "16", "-t", "17"); err == nil {
			memType = parseDMIMemoryType(out)
		}
		virt := ""
		if out, err := runCmd(ctx, 5*time.Second, "systemd-detect-virt"); err == nil || len(out) > 0 {
			virt = strings.TrimSpace(string(out))
			if virt == "none" {
				virt = ""
			}
		}
		h.mu.Lock()
		h.memType, h.virt = memType, virt
		h.mu.Unlock()
	}

	// Proxmox VE: os-release says Debian; detect the PVE packages.
	isPVE := isProxmoxHost(r)
	h.mu.Lock()
	needVersion := isPVE && (h.pveVersion == "" || time.Since(h.pveChecked) > time.Hour)
	h.mu.Unlock()
	pveVersion := ""
	if needVersion {
		pveVersion = pveManagerVersion(ctx, r)
	}

	h.mu.Lock()
	defer h.mu.Unlock()
	h.isPVE = isPVE
	if needVersion {
		h.pveChecked = time.Now()
		if pveVersion != "" {
			h.pveVersion = pveVersion
		}
	}
	info.MemoryType = h.memType
	info.Virtual = h.virt
	if isPVE {
		base := info.OSPretty
		info.OSName = "Proxmox VE"
		info.OSVersion = h.pveVersion
		info.OSPretty = strings.TrimSpace("Proxmox VE " + h.pveVersion)
		if base != "" {
			info.OSPretty += " (" + base + ")"
		}
	}
	h.info = info
	return nil
}

// parseOSRelease returns NAME, a version ("13", "24.04 LTS") and PRETTY_NAME.
func parseOSRelease(b []byte) (name, version, pretty string) {
	kv := map[string]string{}
	scanLines(b, func(line string) {
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			return
		}
		v = strings.TrimSpace(v)
		if uq, err := strconv.Unquote(v); err == nil {
			v = uq
		} else {
			v = strings.Trim(v, `"'`)
		}
		kv[strings.TrimSpace(k)] = v
	})
	name = kv["NAME"]
	version = kv["VERSION_ID"]
	if strings.Contains(kv["VERSION"], "LTS") && !strings.Contains(version, "LTS") {
		version += " LTS"
	}
	if version == "" {
		version = kv["BUILD_ID"]
	}
	pretty = kv["PRETTY_NAME"]
	if pretty == "" {
		pretty = strings.TrimSpace(name + " " + version)
	}
	return
}

var pveVersionRE = regexp.MustCompile(`pve-manager/([0-9][0-9A-Za-z.~+-]*)`)

// pveManagerVersion returns the pve-manager version ("9.0.3"). It reads
// the dpkg status file (no process) and falls back to `pveversion`.
func pveManagerVersion(ctx context.Context, r fsRoot) string {
	if b, err := r.read("/var/lib/dpkg/status"); err == nil {
		if v := dpkgVersion(b, "pve-manager"); v != "" {
			return v
		}
	}
	out, err := runCmd(ctx, 20*time.Second, "pveversion")
	if err != nil {
		return ""
	}
	if m := pveVersionRE.FindSubmatch(out); m != nil {
		return string(m[1])
	}
	return ""
}

// dpkgVersion finds the installed version of pkg in /var/lib/dpkg/status.
func dpkgVersion(status []byte, pkg string) string {
	for _, para := range bytes.Split(status, []byte("\n\n")) {
		if !bytes.HasPrefix(para, []byte("Package: "+pkg+"\n")) {
			continue
		}
		var version string
		installed := false
		scanLines(para, func(line string) {
			if v, ok := strings.CutPrefix(line, "Version: "); ok {
				version = strings.TrimSpace(v)
			}
			if v, ok := strings.CutPrefix(line, "Status: "); ok && strings.HasSuffix(strings.TrimSpace(v), " installed") {
				installed = true
			}
		})
		if installed {
			return version
		}
	}
	return ""
}

// cpuinfoModel returns the first "model name" from /proc/cpuinfo.
func cpuinfoModel(b []byte) string {
	model := ""
	scanLines(b, func(line string) {
		if model != "" {
			return
		}
		k, v, ok := strings.Cut(line, ":")
		if ok && strings.TrimSpace(k) == "model name" {
			model = strings.TrimSpace(v)
		}
	})
	return model
}

var (
	cpuTrademarkRE = regexp.MustCompile(`\((R|r|TM|tm)\)`)
	cpuCoresRE     = regexp.MustCompile(`\s+\d+-Cores?(\s+Processor)?$`)
	cpuGenRE       = regexp.MustCompile(`^\d+(st|nd|rd|th) Gen\s+`)
	cpuGraphicsRE  = regexp.MustCompile(`\s+(with|w/)\s+Radeon.*$`)
	spacesRE       = regexp.MustCompile(`\s+`)
)

// shortCPUModel shortens /proc/cpuinfo model names: "AMD EPYC 7443P 24-Core
// Processor" -> "EPYC 7443P", "12th Gen Intel(R) Core(TM) i7-12700" ->
// "Core i7-12700".
func shortCPUModel(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return ""
	}
	if strings.Contains(s, "QEMU") || strings.Contains(s, "Virtual CPU") || strings.Contains(s, "KVM") {
		return spacesRE.ReplaceAllString(s, " ")
	}
	s = cpuTrademarkRE.ReplaceAllString(s, "")
	if i := strings.Index(s, "@"); i >= 0 {
		s = s[:i]
	}
	s = spacesRE.ReplaceAllString(strings.TrimSpace(s), " ")
	s = cpuGraphicsRE.ReplaceAllString(s, "")
	s = cpuCoresRE.ReplaceAllString(s, "")
	s = cpuGenRE.ReplaceAllString(s, "")
	var words []string
	for _, w := range strings.Fields(s) {
		if w == "CPU" || w == "Processor" {
			continue
		}
		words = append(words, w)
	}
	for len(words) > 1 && (words[0] == "AMD" || words[0] == "Intel" || words[0] == "Genuine") {
		words = words[1:]
	}
	return strings.Join(words, " ")
}

// countCores counts physical cores as distinct thread-sibling sets of the
// online CPUs.
func countCores(r fsRoot) int {
	dirs, err := os.ReadDir(r.path("/sys/devices/system/cpu"))
	if err != nil {
		return 0
	}
	seen := map[string]bool{}
	for _, d := range dirs {
		name := d.Name()
		if !strings.HasPrefix(name, "cpu") {
			continue
		}
		if _, err := strconv.Atoi(name[3:]); err != nil {
			continue
		}
		base := "/sys/devices/system/cpu/" + name
		if v, ok := r.readInt(base + "/online"); ok && v == 0 {
			continue
		}
		sib := r.readString(base + "/topology/core_cpus_list")
		if sib == "" {
			sib = r.readString(base + "/topology/thread_siblings_list")
		}
		if sib == "" {
			pkg := r.readString(base + "/topology/physical_package_id")
			core := r.readString(base + "/topology/core_id")
			if core == "" {
				continue
			}
			sib = pkg + ":" + core
		}
		seen[sib] = true
	}
	return len(seen)
}

// parseDMIMemoryType turns `dmidecode -t 16 -t 17` output into "DDR5 ECC".
func parseDMIMemoryType(b []byte) string {
	var memType string
	ecc := false
	eccKnown := false
	var section string
	var curType string
	var curInstalled bool
	var totalW, dataW int
	flush := func() {
		if section == "Memory Device" && curInstalled {
			if memType == "" && curType != "" && curType != "Unknown" && curType != "Other" && curType != "RAM" && curType != "DRAM" {
				memType = curType
			}
			if !eccKnown && totalW > 0 && dataW > 0 && totalW > dataW {
				ecc = true
			}
		}
		curType, curInstalled, totalW, dataW = "", false, 0, 0
	}
	scanLines(b, func(line string) {
		if line == "" {
			return
		}
		if !strings.HasPrefix(line, "\t") {
			if strings.HasPrefix(line, "Handle ") {
				return
			}
			flush()
			section = strings.TrimSpace(line)
			return
		}
		k, v, ok := strings.Cut(strings.TrimSpace(line), ":")
		if !ok {
			return
		}
		v = strings.TrimSpace(v)
		switch section {
		case "Physical Memory Array":
			if k == "Error Correction Type" {
				switch v {
				case "None":
					eccKnown = true
				case "Unknown", "Other", "":
				default: // Single-bit ECC, Multi-bit ECC, CRC, Parity
					ecc, eccKnown = true, true
				}
			}
		case "Memory Device":
			switch k {
			case "Type":
				curType = v
			case "Size":
				curInstalled = v != "" && !strings.HasPrefix(v, "No Module") && v != "Not Installed" && v != "0" && v != "Unknown"
			case "Total Width":
				totalW, _ = strconv.Atoi(strings.TrimSuffix(v, " bits"))
			case "Data Width":
				dataW, _ = strconv.Atoi(strings.TrimSuffix(v, " bits"))
			}
		}
	})
	flush()
	if memType == "" {
		return ""
	}
	if ecc {
		return memType + " ECC"
	}
	return memType
}

// ---- addresses ----------------------------------------------------------------

// defaultRouteIface returns the interface of the IPv4 default route with the
// lowest metric, from /proc/net/route.
func defaultRouteIface(b []byte) string {
	best := ""
	bestMetric := int64(1<<62 - 1)
	first := true
	scanLines(b, func(line string) {
		if first {
			first = false
			return
		}
		f := strings.Fields(line)
		if len(f) < 8 {
			return
		}
		if f[1] != "00000000" || f[7] != "00000000" {
			return
		}
		flags, _ := strconv.ParseUint(f[3], 16, 32)
		if flags&1 == 0 { // RTF_UP
			return
		}
		m, _ := strconv.ParseInt(f[6], 10, 64)
		if m < bestMetric {
			best, bestMetric = f[0], m
		}
	})
	return best
}

// hardwareBacked reports whether a network interface is a physical NIC or
// a bridge / bond / VLAN on top of one (vmbr0 on Proxmox). Container and VM
// bridges (docker0, incusbr0, virbr0) and tunnels (tailscale0, wg0) are not.
func hardwareBacked(r fsRoot, name string, depth int) bool {
	if depth > 4 || name == "" || name == "lo" {
		return false
	}
	base := "/sys/class/net/" + name
	if r.exists(base + "/device") {
		return true
	}
	var members []string
	if ents, err := os.ReadDir(r.path(base + "/brif")); err == nil {
		for _, e := range ents {
			members = append(members, e.Name())
		}
	}
	if s := r.readString(base + "/bonding/slaves"); s != "" {
		members = append(members, strings.Fields(s)...)
	}
	if ents, err := os.ReadDir(r.path(base)); err == nil {
		for _, e := range ents {
			if m, ok := strings.CutPrefix(e.Name(), "lower_"); ok {
				members = append(members, m)
			}
		}
	}
	for _, m := range members {
		if hardwareBacked(r, m, depth+1) {
			return true
		}
	}
	return false
}

// hostAddresses returns the host's addresses: global IPv4 addresses of the
// default-route interface first, then those of other hardware-backed
// interfaces, then global IPv6 addresses in the same order (link-local
// and loopback addresses are left out; unique local IPv6 is kept).
func hostAddresses(r fsRoot) []string {
	routes, _ := r.read("/proc/net/route")
	primary := defaultRouteIface(routes)
	ifs, err := net.Interfaces()
	if err != nil {
		return nil
	}
	sort.SliceStable(ifs, func(i, j int) bool { return ifs[i].Index < ifs[j].Index })
	var v4First, v4Rest, v6First, v6Rest []string
	for _, ifc := range ifs {
		if ifc.Flags&net.FlagUp == 0 || ifc.Flags&net.FlagLoopback != 0 {
			continue
		}
		isPrimary := ifc.Name == primary
		if !isPrimary && !hardwareBacked(r, ifc.Name, 0) {
			continue
		}
		addrs, err := ifc.Addrs()
		if err != nil {
			continue
		}
		for _, a := range addrs {
			ipn, ok := a.(*net.IPNet)
			if !ok {
				continue
			}
			ip := ipn.IP
			if ip.IsLoopback() || ip.IsLinkLocalUnicast() || !ip.IsGlobalUnicast() {
				continue
			}
			switch {
			case ip.To4() != nil && isPrimary:
				v4First = append(v4First, ip.To4().String())
			case ip.To4() != nil:
				v4Rest = append(v4Rest, ip.To4().String())
			case isPrimary:
				v6First = append(v6First, ip.String())
			default:
				v6Rest = append(v6Rest, ip.String())
			}
		}
	}
	out := append(v4First, v4Rest...)
	out = append(out, v6First...)
	return append(out, v6Rest...)
}

// ---- /proc/meminfo --------------------------------------------------------------

// parseMeminfo returns /proc/meminfo values in bytes (HugePages_* counts as
// plain numbers).
func parseMeminfo(b []byte) map[string]uint64 {
	m := make(map[string]uint64, 64)
	sc := bufio.NewScanner(bytes.NewReader(b))
	for sc.Scan() {
		line := sc.Text()
		k, v, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		f := strings.Fields(v)
		if len(f) == 0 {
			continue
		}
		n, err := strconv.ParseUint(f[0], 10, 64)
		if err != nil {
			continue
		}
		if len(f) > 1 && f[1] == "kB" {
			n *= 1024
		}
		m[k] = n
	}
	return m
}
