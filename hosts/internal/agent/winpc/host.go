package winpc

import (
	"context"
	"net"
	"slices"
	"strings"
	"time"

	"github.com/shirou/gopsutil/v4/cpu"
	"github.com/shirou/gopsutil/v4/disk"
	"github.com/shirou/gopsutil/v4/host"
	"github.com/shirou/gopsutil/v4/process"

	"rackoon/internal/agent"
	"rackoon/internal/proto"
)

// volume is one drive letter with a filesystem.
type volume struct {
	drive  string // "C:"
	fstype string // NTFS, ReFS, exFAT, FAT32
	size   uint64
	used   uint64
	remote bool
	err    string
}

// iface is one network adapter.
type iface struct {
	name  string
	up    bool
	mtu   int
	mac   string
	addrs []string
}

// runHost reads Windows' names, the uptime, the drives, the adapters and
// the number of processes.
func (c *Collector) runHost(ctx context.Context) error {
	v := agent.ReadWindowsVersion()
	h := proto.HostInfo{
		MachineID: agent.MachineID(),
		Hostname:  agent.Hostname(),
		OSName:    v.Product(),
		OSVersion: v.DisplayVersion,
		OSPretty:  v.Pretty(),
		Kernel:    v.Build(),
		CPUModel:  shortCPU(v.CPU),
	}
	var firstErr error
	keep := func(err error) {
		if err != nil && firstErr == nil {
			firstErr = err
		}
	}
	if n, err := cpu.CountsWithContext(ctx, false); err == nil {
		h.Cores = n
	}
	if n, err := cpu.CountsWithContext(ctx, true); err == nil {
		h.Threads = n
	}
	if bt, err := host.BootTimeWithContext(ctx); err == nil && bt > 0 {
		h.BootTime = time.Unix(int64(bt), 0).UTC()
	} else {
		keep(err)
	}
	vols, err := readVolumes(ctx)
	keep(err)
	ifs := readIfaces()
	h.Addresses = addresses(ifs, agent.SourceAddress(c.cfg.Hub))
	pids, err := process.PidsWithContext(ctx)
	keep(err)
	c.mu.Lock()
	c.win = v
	c.host = h
	c.vols, c.ifaces = vols, ifs
	if pids != nil {
		c.procCount = len(pids)
	}
	c.mu.Unlock()
	return firstErr
}

// shortCPU trims a processor's name: "Intel(R) Core(TM) i7-1185G7 @
// 3.00GHz" -> "Core i7-1185G7".
func shortCPU(s string) string {
	s = strings.NewReplacer("(R)", "", "(TM)", "", "(tm)", "", "CPU ", "").Replace(s)
	if i := strings.Index(s, " @ "); i > 0 {
		s = s[:i]
	}
	s = strings.Join(strings.Fields(s), " ")
	for _, p := range []string{"Intel ", "AMD "} {
		s = strings.TrimPrefix(s, p)
	}
	s = strings.TrimSuffix(strings.TrimSuffix(s, " Processor"), " CPU")
	return clip(s, 64)
}

// readVolumes lists the drive letters with a filesystem (not the optical
// drives) and how full they are.
func readVolumes(ctx context.Context) ([]volume, error) {
	parts, err := disk.PartitionsWithContext(ctx, false)
	if err != nil {
		return nil, err
	}
	var out []volume
	for _, p := range parts {
		d := driveName(p.Mountpoint)
		fs := strings.TrimSpace(p.Fstype)
		if d == "" || fs == "" || strings.EqualFold(fs, "CDFS") || strings.EqualFold(fs, "UDF") {
			continue
		}
		v := volume{drive: d, fstype: fs, remote: slices.Contains(p.Opts, "remote")}
		u, err := disk.UsageWithContext(ctx, d+`\`)
		if err != nil {
			v.err = clip(err.Error(), 200)
		} else {
			v.size, v.used = u.Total, u.Used
		}
		out = append(out, v)
	}
	slices.SortFunc(out, func(a, b volume) int { return strings.Compare(a.drive, b.drive) })
	return out, nil
}

// buildStorage is the report's filesystems (one per drive letter, with
// the physical disk under it) and disks (with how much of them the drives
// use).
func buildStorage(vols []volume, f *readFacts) ([]proto.Filesystem, []proto.Disk) {
	fss := []proto.Filesystem{}
	used := map[string]uint64{}
	roles := map[string][]string{}
	for _, v := range vols {
		fs := proto.Filesystem{Mount: v.drive, Device: v.drive, FSType: v.fstype, SizeBytes: v.size, UsedBytes: v.used,
			Remote: v.remote, Error: v.err}
		if f != nil {
			if d, ok := f.driveDisk[v.drive]; ok && !v.remote {
				fs.Disks = []string{d}
				used[d] += v.used
				roles[d] = append(roles[d], v.drive)
			}
		}
		fss = append(fss, fs)
	}
	disks := []proto.Disk{}
	if f != nil {
		for _, d := range f.disks {
			if u, ok := used[d.Device]; ok {
				d.UsedBytes = &u
			}
			if r := roles[d.Device]; len(r) > 0 {
				role := strings.Join(r, ", ")
				if f.systemDrive != "" && slices.Contains(r, f.systemDrive) {
					role = "System · " + role
				}
				d.Role = role
			}
			disks = append(disks, d)
		}
	}
	return fss, disks
}

// readIfaces lists the network adapters that are up, without loopback and
// the tunnels Windows adds by itself.
func readIfaces() []iface {
	ifs, err := net.Interfaces()
	if err != nil {
		return nil
	}
	var out []iface
	for _, i := range ifs {
		if i.Flags&net.FlagLoopback != 0 || i.Flags&net.FlagUp == 0 || windowsTunnel(i.Name) {
			continue
		}
		x := iface{name: i.Name, up: true, mtu: i.MTU, mac: strings.ToLower(i.HardwareAddr.String())}
		addrs, _ := i.Addrs()
		for _, a := range addrs {
			n, ok := a.(*net.IPNet)
			if !ok || n.IP.IsLoopback() || n.IP.IsLinkLocalUnicast() {
				continue
			}
			ones, _ := n.Mask.Size()
			if ip4 := n.IP.To4(); ip4 != nil {
				x.addrs = append(x.addrs, ip4.String()+"/"+itoa(ones))
			} else if n.IP.IsGlobalUnicast() {
				x.addrs = append(x.addrs, n.IP.String()+"/"+itoa(ones))
			}
		}
		out = append(out, x)
	}
	return out
}

// windowsTunnel: adapters Windows makes for its own tunnels.
func windowsTunnel(name string) bool {
	n := strings.ToLower(name)
	return strings.HasPrefix(n, "isatap") || strings.HasPrefix(n, "teredo") || strings.Contains(n, "pseudo-interface")
}

// addresses are the PC's IPv4 addresses, the one it reaches Whombat from
// first.
func addresses(ifs []iface, primary string) []string {
	var out []string
	for _, i := range ifs {
		for _, a := range i.addrs {
			ip, _, _ := strings.Cut(a, "/")
			if strings.Contains(ip, ":") {
				continue
			}
			if ip == primary {
				out = append([]string{ip}, out...)
			} else {
				out = append(out, ip)
			}
		}
	}
	if len(out) > 16 {
		out = out[:16]
	}
	return out
}

// netIfaces is the report's network adapters with their rates (c.mu held).
func (c *Collector) netIfaces() []proto.NetIface {
	var out []proto.NetIface
	for _, i := range c.ifaces {
		n := proto.NetIface{Name: i.name, Kind: ifaceKind(i.name), Up: i.up, Carrier: i.up, MTU: i.mtu, MAC: i.mac,
			Addresses: append([]string(nil), i.addrs...)}
		if r, ok := c.netRates[i.name]; ok {
			n.RxBps, n.TxBps = r[0], r[1]
		}
		if e, ok := c.netErrs[i.name]; ok {
			n.RxErrors, n.TxErrors, n.RxDrops, n.TxDrops = e[0], e[1], e[2], e[3]
		}
		out = append(out, n)
	}
	return out
}

// ifaceKind tells Wi-Fi from wired by the name Windows gives the adapter
// (in English and Dutch Windows alike: "Wi-Fi", "WLAN").
func ifaceKind(name string) string {
	n := strings.ToLower(name)
	if strings.Contains(n, "wi-fi") || strings.Contains(n, "wifi") || strings.Contains(n, "wlan") || strings.Contains(n, "wireless") {
		return "wireless"
	}
	return "ethernet"
}
