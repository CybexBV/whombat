package macos

import (
	"context"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/shirou/gopsutil/v4/process"

	"rackoon/internal/agent"
	"rackoon/internal/proto"
)

// runHost reads the host's facts: model, CPU, memory, boot time, macOS
// version, the kernel and the number of processes.
func (c *Collector) runHost(ctx context.Context) error {
	out, err := Run(ctx, 10*time.Second, append([]string{Sysctl, "-n"}, SysctlHostNames...)...)
	if err != nil {
		return err
	}
	sh := ParseSysctlHost(out)
	vb, verr := Run(ctx, 10*time.Second, SwVers)
	sv := ParseSwVers(vb)
	kb, _ := Run(ctx, 10*time.Second, Uname, "-r")
	pids, _ := process.PidsWithContext(ctx)

	h := proto.HostInfo{
		MachineID: agent.MachineID(),
		Hostname:  agent.Hostname(),
		OSName:    "macOS",
		OSVersion: sv.Version,
		CPUModel:  CPUModel(sh.CPU),
		Cores:     sh.Cores,
		Threads:   sh.Threads,
		BootTime:  sh.Boot,
	}
	h.MemoryTotalBytes = sh.MemBytes
	if sv.Version != "" {
		h.OSPretty = "macOS " + sv.Version
		if sv.Build != "" {
			h.OSPretty += " (" + sv.Build + ")"
		}
	}
	if k := strings.TrimSpace(string(kb)); k != "" {
		h.Kernel = "Darwin " + clip(k, 64)
	}
	c.mu.Lock()
	addrs := c.host.Addresses
	c.host = h
	c.host.Addresses = addrs
	if sh.Model != "" {
		c.mac.Model = clip(sh.Model, 64)
	}
	c.mac.Version, c.mac.Build = clip(sv.Version, 32), clip(sv.Build, 32)
	if c.mac.Chip == "" && strings.HasPrefix(sh.CPU, "Apple ") {
		c.mac.Chip = clip(sh.CPU, 64)
	}
	c.procCount = len(pids)
	c.mu.Unlock()
	return verr
}

var (
	cpuTrademarkRe = regexp.MustCompile(`\((R|TM|tm|r)\)`)
	spacesRe       = regexp.MustCompile(`\s+`)
)

// CPUModel shortens machdep.cpu.brand_string the way the Linux agent
// shortens /proc/cpuinfo: "Apple M2 Ultra" stays, "Intel(R) Core(TM)
// i9-9880H CPU @ 2.30GHz" becomes "Core i9-9880H".
func CPUModel(s string) string {
	s = strings.TrimSpace(s)
	if strings.HasPrefix(s, "Apple ") {
		return clip(s, 64)
	}
	s = cpuTrademarkRe.ReplaceAllString(s, "")
	if i := strings.Index(s, "@"); i >= 0 {
		s = s[:i]
	}
	var words []string
	for _, w := range strings.Fields(spacesRe.ReplaceAllString(s, " ")) {
		if w == "CPU" || w == "Processor" {
			continue
		}
		words = append(words, w)
	}
	for len(words) > 1 && (words[0] == "Intel" || words[0] == "Genuine") {
		words = words[1:]
	}
	return clip(strings.Join(words, " "), 64)
}

// runNet reads the interfaces (ifconfig), the default route and, now and
// then, which interface is which hardware port.
func (c *Collector) runNet(ctx context.Context) error {
	out, err := Run(ctx, 10*time.Second, Ifconfig, "-a")
	if err != nil {
		return err
	}
	ifs := ParseIfconfig(out)
	rb, _ := Run(ctx, 10*time.Second, Route, "-n", "get", "default")
	primary := ParseDefaultRoute(rb)
	c.mu.Lock()
	needPorts := c.ports == nil || time.Since(c.portsAt) > portsEvery
	c.mu.Unlock()
	var ports []HardwarePort
	if needPorts {
		if pb, err := Run(ctx, 20*time.Second, Networksetup, "-listallhardwareports"); err == nil {
			ports = ParseHardwarePorts(pb)
		}
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.ifaces, c.primary = ifs, primary
	if needPorts {
		c.ports, c.portsAt = ports, time.Now()
		if c.ports == nil {
			c.ports = []HardwarePort{}
		}
	}
	c.host.Addresses = Addresses(ifs, c.ports, primary)
	return nil
}

// Addresses are the host's addresses: the default-route interface's IPv4
// first, then other hardware ports', then IPv6 in the same order.
func Addresses(ifs []Iface, ports []HardwarePort, primary string) []string {
	hw := map[string]bool{}
	for _, p := range ports {
		hw[p.Device] = true
	}
	var v4First, v4Rest, v6First, v6Rest []string
	for _, i := range ifs {
		if !i.Up || (i.Name != primary && !hw[i.Name]) {
			continue
		}
		for _, a := range i.Addrs {
			ip, _, err := net.ParseCIDR(a)
			if err != nil {
				continue
			}
			switch {
			case ip.To4() != nil && i.Name == primary:
				v4First = append(v4First, ip.String())
			case ip.To4() != nil:
				v4Rest = append(v4Rest, ip.String())
			case i.Name == primary:
				v6First = append(v6First, ip.String())
			default:
				v6Rest = append(v6Rest, ip.String())
			}
		}
	}
	out := append(append(append(v4First, v4Rest...), v6First...), v6Rest...)
	if len(out) > 16 {
		out = out[:16]
	}
	return out
}

// NetIfaces are the report's interfaces: the Mac's hardware ports that
// are connected or have an address (Ethernet, Wi-Fi, Thunderbolt
// Ethernet). Bridges (Thunderbolt Bridge) and their members are left out,
// like the Linux agent leaves out bridges.
func NetIfaces(ifs []Iface, ports []HardwarePort, rates map[string][2]float64, errs map[string][4]uint64) []proto.NetIface {
	byName := map[string]Iface{}
	member := map[string]bool{}
	for _, i := range ifs {
		byName[i.Name] = i
		for _, m := range i.Members {
			member[m] = true
		}
	}
	var out []proto.NetIface
	for _, p := range ports {
		i, ok := byName[p.Device]
		if !ok || len(i.Members) > 0 || member[i.Name] || strings.HasPrefix(i.Name, "bridge") {
			continue
		}
		if !i.Active && len(i.Addrs) == 0 {
			continue
		}
		n := proto.NetIface{Name: i.Name, Kind: "ethernet", Up: i.Up, Carrier: i.Active, MTU: i.MTU, MAC: i.MAC,
			Addresses: append([]string(nil), i.Addrs...), SpeedMbps: SpeedMbps(i.Media)}
		if p.IsWireless() {
			n.Kind = "wireless"
		}
		if r, ok := rates[i.Name]; ok {
			n.RxBps, n.TxBps = r[0], r[1]
		}
		if e, ok := errs[i.Name]; ok {
			n.RxErrors, n.TxErrors, n.RxDrops, n.TxDrops = e[0], e[1], e[2], e[3]
		}
		out = append(out, n)
		if len(out) >= 32 {
			break
		}
	}
	return out
}

// netIfaces is NetIfaces of the collector's last readings (c.mu held).
func (c *Collector) netIfaces() []proto.NetIface {
	return NetIfaces(c.ifaces, c.ports, c.netRates, c.netErrs)
}

// ---- the Mac's facts -----------------------------------------------------------------

// HelperApp is Whombat Helper's bundle (install.sh puts it there).
const HelperApp = "/Library/Application Support/Whombat/Whombat Helper.app"

// runMac reads SIP, FileVault, auto-login, who is at the screen, the
// helper and, once a day, the model name.
func (c *Collector) runMac(ctx context.Context) error {
	var m proto.MacOS
	cb, cerr := Run(ctx, 10*time.Second, Csrutil, "status")
	if cerr == nil {
		m.SIP = ParseCsrutil(cb)
	}
	fb, ferr := Run(ctx, 10*time.Second, Fdesetup, "status")
	if ferr == nil {
		m.FileVault = ParseFileVault(fb)
	}
	ab, aerr := Run(ctx, 10*time.Second, Defaults, "read", "/Library/Preferences/com.apple.loginwindow", "autoLoginUser")
	m.AutoLogin = AutoLoginUser(ab, aerr)
	ub, uerr := Run(ctx, 10*time.Second, Stat, "-f", "%Su", "/dev/console")
	if uerr == nil {
		m.ConsoleUser = ConsoleUser(ub)
	}
	m.Helper.Installed, m.Helper.Version = c.helper(ctx)
	m.AgentFolder = agentFolder()
	if screenHook() == nil {
		m.Screen.Sharing = ProbeScreenSharing(ctx)
	}

	c.mu.Lock()
	needHW := c.hwAt.IsZero() || time.Since(c.hwAt) > hardwareEvery
	c.mu.Unlock()
	var hw Hardware
	var hwOK bool
	if needHW {
		if b, err := Run(ctx, 45*time.Second, SystemProfiler, "SPHardwareDataType", "-json"); err == nil {
			hw, hwOK = ParseHardware(b)
		}
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if needHW {
		c.hwAt = time.Now()
		if !hwOK {
			c.hwAt = time.Now().Add(-hardwareEvery + time.Hour) // try again in an hour
		} else {
			c.hw = hw
		}
	}
	m.Version, m.Build, m.Model = c.mac.Version, c.mac.Build, c.mac.Model
	m.ModelName, m.Chip = clip(c.hw.ModelName, 64), clip(c.hw.Chip, 64)
	if m.Chip == "" {
		m.Chip = c.mac.Chip
	}
	if m.Model == "" {
		m.Model = clip(c.hw.Model, 64)
	}
	c.mac = m
	if cerr != nil && ferr != nil && uerr != nil {
		return cerr
	}
	return nil
}

// The agent's own executable and the check that only root can change it
// (tests replace them).
var (
	agentEUID     = os.Geteuid
	agentExe      = agent.ExecutablePath
	agentRootOnly = func(path string) error { return agent.RootOnly(path, 0, "/") }
)

// agentFolder is the folder of the agent's executable when someone other
// than root can change it or a folder above it ("" when only root can, or
// the agent doesn't run as root). install.sh moves such an install when it
// runs again; until then the hub shows a hint.
func agentFolder() string {
	if agentEUID() != 0 {
		return ""
	}
	exe, err := agentExe()
	if err != nil {
		return ""
	}
	if err := agentRootOnly(exe); err != nil {
		return filepath.Dir(exe)
	}
	return ""
}

// helper reports whether Whombat Helper is installed and its version (read
// again when its Info.plist changes).
func (c *Collector) helper(ctx context.Context) (bool, string) {
	if st, err := os.Stat(HelperApp); err != nil || !st.IsDir() {
		return false, ""
	}
	info := filepath.Join(HelperApp, "Contents", "Info.plist")
	st, err := os.Stat(info)
	if err != nil {
		return true, ""
	}
	c.mu.Lock()
	if st.ModTime().Equal(c.helperMod) {
		v := c.helperVer
		c.mu.Unlock()
		return true, v
	}
	c.mu.Unlock()
	b, err := os.ReadFile(info)
	if err != nil {
		return true, ""
	}
	if strings.HasPrefix(string(b), "bplist") {
		if b, err = Run(ctx, 10*time.Second, Plutil, "-convert", "xml1", "-o", "-", info); err != nil {
			return true, ""
		}
	}
	v := BundleVersion(b)
	c.mu.Lock()
	c.helperMod, c.helperVer = st.ModTime(), v
	c.mu.Unlock()
	return true, v
}

// ProbeScreenSharing reports whether Screen Sharing answers on
// 127.0.0.1:5900: it connects and reads the 12-byte RFB version, nothing
// more.
func ProbeScreenSharing(ctx context.Context) bool {
	d := net.Dialer{Timeout: 2 * time.Second}
	conn, err := d.DialContext(ctx, "tcp", "127.0.0.1:5900")
	if err != nil {
		return false
	}
	defer conn.Close()
	_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	buf := make([]byte, 12)
	n := 0
	for n < len(buf) {
		k, err := conn.Read(buf[n:])
		n += k
		if err != nil {
			break
		}
	}
	return ParseRFBVersion(buf[:n])
}

func itoa(n int) string { return strconv.Itoa(n) }
