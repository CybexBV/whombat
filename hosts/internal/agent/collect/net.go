package collect

import (
	"context"
	"net"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"rackoon/internal/proto"
)

// netCollector reports the host's own network interfaces every 10 s:
// physical adapters, bonds, VLANs on them and Wi-Fi, with link state,
// throughput and error counters. Bridges, veth, tap, tun, macvlan and
// other virtual devices are left out (guest traffic is reported per
// guest, and a bridge's traffic is its members').
type netCollector struct {
	root fsRoot
	// addrs returns an interface's addresses (tests replace it).
	addrs func(name string) []string

	mu     sync.Mutex
	prev   map[string]netCounters
	prevAt time.Time
	ifaces []proto.NetIface
	// Addresses change rarely; each lookup is a netlink dump.
	addrCache map[string][]string
	addrAt    time.Time
}

// netAddrEvery is how often interface addresses are looked up.
const netAddrEvery = time.Minute

type netCounters struct {
	rx, tx                       uint64
	rxErr, txErr, rxDrop, txDrop uint64
}

func newNetCollector(root fsRoot) *netCollector {
	return &netCollector{root: root, addrs: ifaceAddrs, prev: map[string]netCounters{}}
}

// netKind classifies /sys/class/net/<name>: "ethernet", "bond", "vlan",
// "wireless", or "" for interfaces that are not reported.
func netKind(r fsRoot, name string) string {
	if name == "lo" {
		return ""
	}
	base := "/sys/class/net/" + name
	devtype := ""
	scanLines([]byte(r.readString(base+"/uevent")), func(line string) {
		if v, ok := strings.CutPrefix(line, "DEVTYPE="); ok {
			devtype = v
		}
	})
	switch {
	case devtype == "bridge" || r.exists(base+"/bridge"):
		return ""
	case r.exists(base + "/bonding"):
		return "bond"
	case devtype == "vlan":
		// Only VLANs on a physical adapter or a bond.
		for _, l := range lowerLinks(r, name) {
			if k := netKind(r, l); k == "ethernet" || k == "bond" || k == "wireless" {
				return "vlan"
			}
		}
		return ""
	case !r.exists(base + "/device"):
		return "" // veth, tap, tun, macvlan, dummy, wireguard, docker/incus/libvirt devices
	case devtype == "wlan" || r.exists(base+"/wireless") || r.exists(base+"/phy80211"):
		return "wireless"
	}
	return "ethernet"
}

// lowerLinks returns the interfaces a stacked device sits on (lower_*).
func lowerLinks(r fsRoot, name string) []string {
	ents, err := os.ReadDir(r.path("/sys/class/net/" + name))
	if err != nil {
		return nil
	}
	var out []string
	for _, e := range ents {
		if l, ok := strings.CutPrefix(e.Name(), "lower_"); ok {
			out = append(out, l)
		}
	}
	return out
}

func (n *netCollector) run(ctx context.Context) error {
	r := n.root
	ents, err := os.ReadDir(r.path("/sys/class/net"))
	if err != nil {
		return err
	}
	now := time.Now()
	n.mu.Lock()
	refreshAddrs := n.addrCache == nil || now.Sub(n.addrAt) >= netAddrEvery
	addrs := n.addrCache
	n.mu.Unlock()
	if refreshAddrs {
		addrs = map[string][]string{}
	}
	cur := map[string]netCounters{}
	var out []proto.NetIface
	for _, e := range ents {
		name := e.Name()
		kind := netKind(r, name)
		if kind == "" {
			continue
		}
		base := "/sys/class/net/" + name
		ni := proto.NetIface{
			Name:    name,
			Kind:    kind,
			Up:      r.readString(base+"/operstate") == "up",
			Carrier: r.readString(base+"/carrier") == "1",
			MAC:     r.readString(base + "/address"),
		}
		if v, ok := r.readInt(base + "/speed"); ok && v > 0 {
			ni.SpeedMbps = int(v)
		}
		if v, ok := r.readInt(base + "/mtu"); ok {
			ni.MTU = int(v)
		}
		if t, err := os.Readlink(r.path(base + "/master")); err == nil {
			ni.Master = filepath.Base(t)
		}
		if kind == "bond" {
			ni.Members = strings.Fields(r.readString(base + "/bonding/slaves"))
		}
		if refreshAddrs && n.addrs != nil {
			addrs[name] = n.addrs(name)
		}
		ni.Addresses = addrs[name]
		st := base + "/statistics/"
		c := netCounters{
			rx: readU64(r, st+"rx_bytes"), tx: readU64(r, st+"tx_bytes"),
			rxErr: readU64(r, st+"rx_errors"), txErr: readU64(r, st+"tx_errors"),
			rxDrop: readU64(r, st+"rx_dropped"), txDrop: readU64(r, st+"tx_dropped"),
		}
		cur[name] = c
		ni.RxErrors, ni.TxErrors, ni.RxDrops, ni.TxDrops = c.rxErr, c.txErr, c.rxDrop, c.txDrop
		out = append(out, ni)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })

	n.mu.Lock()
	defer n.mu.Unlock()
	dt := now.Sub(n.prevAt).Seconds()
	for i := range out {
		p, ok := n.prev[out[i].Name]
		c := cur[out[i].Name]
		if ok && !n.prevAt.IsZero() && dt > 0 {
			out[i].RxBps = counterRate(c.rx, p.rx, dt)
			out[i].TxBps = counterRate(c.tx, p.tx, dt)
		}
	}
	n.prev, n.prevAt, n.ifaces = cur, now, out
	if refreshAddrs {
		n.addrCache, n.addrAt = addrs, now
	}
	return nil
}

// counterRate is rate() for values that must be a number: a reset or the
// first sample gives 0.
func counterRate(cur, prev uint64, dt float64) float64 {
	if v := rate(cur, prev, dt); v != nil {
		return *v
	}
	return 0
}

func readU64(r fsRoot, p string) uint64 {
	v, err := strconv.ParseUint(r.readString(p), 10, 64)
	if err != nil {
		return 0
	}
	return v
}

func (n *netCollector) snapshot() []proto.NetIface {
	n.mu.Lock()
	defer n.mu.Unlock()
	if n.ifaces == nil {
		return nil
	}
	out := make([]proto.NetIface, len(n.ifaces))
	copy(out, n.ifaces)
	for i := range out {
		out[i].Addresses = append([]string(nil), out[i].Addresses...)
		out[i].Members = append([]string(nil), out[i].Members...)
	}
	return out
}

// ifaceAddrs returns an interface's IPv4 and global IPv6 addresses in CIDR
// notation (link-local addresses are left out).
func ifaceAddrs(name string) []string {
	ifc, err := net.InterfaceByName(name)
	if err != nil {
		return nil
	}
	addrs, err := ifc.Addrs()
	if err != nil {
		return nil
	}
	var v4, v6 []string
	for _, a := range addrs {
		ipn, ok := a.(*net.IPNet)
		if !ok || ipn.IP.IsLinkLocalUnicast() || ipn.IP.IsLoopback() {
			continue
		}
		if ipn.IP.To4() != nil {
			v4 = append(v4, ipn.String())
		} else if ipn.IP.IsGlobalUnicast() {
			v6 = append(v6, ipn.String())
		}
	}
	return append(v4, v6...)
}
