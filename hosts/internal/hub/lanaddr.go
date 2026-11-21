package hub

import (
	"bufio"
	"errors"
	"net"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

// --agent-url auto: agents dial the LAN address of the interface that
// carries the default route, on the agent listener's port (docs/WHOMBAT.md
// "Install flow"). The address is looked up when it is used (install
// commands, install.sh), so a new DHCP lease shows up within a minute.

// lanAddress finds the address (tests replace it).
var lanAddress = defaultRouteAddr

// routeTables are read in order: /proc/self/net/route stays visible when a
// sandbox hides /proc/net (systemd ProcSubset=pid).
var routeTables = []string{"/proc/self/net/route", "/proc/net/route"}

// defaultRouteAddr returns the IPv4 address of the default route's
// interface (the route table, lowest metric), else the source address the
// kernel would use towards a documentation address (no packet is sent).
func defaultRouteAddr() (string, error) {
	for _, table := range routeTables {
		if iface := defaultRouteIface(table); iface != "" {
			if ip := ifaceIPv4(iface); ip != "" {
				return ip, nil
			}
			break
		}
	}
	for _, probe := range []string{"192.0.2.1:9", "[2001:db8::1]:9"} {
		c, err := net.Dial("udp", probe)
		if err != nil {
			continue
		}
		la, _ := c.LocalAddr().(*net.UDPAddr)
		c.Close()
		if la != nil && !la.IP.IsLoopback() && !la.IP.IsUnspecified() {
			return la.IP.String(), nil
		}
	}
	return "", errors.New("no default route: pass --agent-url wss://<address>:<port>")
}

// defaultRouteIface parses a /proc/net/route table for the interface of
// the default route with the lowest metric ("" when there is none).
func defaultRouteIface(path string) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	best, bestMetric := "", -1
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		fl := strings.Fields(sc.Text())
		// Iface Destination Gateway Flags RefCnt Use Metric Mask MTU Window IRTT
		if len(fl) < 8 || fl[1] != "00000000" || fl[7] != "00000000" {
			continue
		}
		flags, err := strconv.ParseUint(fl[3], 16, 32)
		if err != nil || flags&0x1 == 0 { // RTF_UP
			continue
		}
		metric, err := strconv.Atoi(fl[6])
		if err != nil {
			continue
		}
		if bestMetric < 0 || metric < bestMetric {
			best, bestMetric = fl[0], metric
		}
	}
	return best
}

// ifaceIPv4 returns the interface's first global IPv4 address, private
// ranges first.
func ifaceIPv4(name string) string {
	ifc, err := net.InterfaceByName(name)
	if err != nil {
		return ""
	}
	addrs, err := ifc.Addrs()
	if err != nil {
		return ""
	}
	var other string
	for _, a := range addrs {
		ipn, ok := a.(*net.IPNet)
		if !ok {
			continue
		}
		ip := ipn.IP.To4()
		if ip == nil || ip.IsLoopback() || ip.IsLinkLocalUnicast() {
			continue
		}
		if ip.IsPrivate() {
			return ip.String()
		}
		if other == "" {
			other = ip.String()
		}
	}
	return other
}

// lanURL caches the auto agent URL.
type lanURL struct {
	mu  sync.Mutex
	url string
	at  time.Time
}

// get returns wss://<lan address>:<port>, looked up at most every 30 s.
func (l *lanURL) get(port string) (string, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.url != "" && time.Since(l.at) < 30*time.Second {
		return l.url, nil
	}
	ip, err := lanAddress()
	if err != nil {
		if l.url != "" {
			return l.url, nil // keep the last good one
		}
		return "", err
	}
	l.url, l.at = "wss://"+net.JoinHostPort(ip, port), time.Now()
	return l.url, nil
}
