package macos

import (
	"net"
	"regexp"
	"strconv"
	"strings"
)

// Iface is one interface of `ifconfig -a`.
type Iface struct {
	Name    string
	Up      bool
	MTU     int
	MAC     string
	Addrs   []string // IPv4 and global / unique-local IPv6, CIDR
	Active  bool     // status: active (a cable or a Wi-Fi network)
	Media   string   // "autoselect (10Gbase-T <full-duplex>)"
	Members []string // a bridge's members
}

var (
	ifHeadRe = regexp.MustCompile(`^([A-Za-z0-9._-]+): flags=[0-9a-fA-F]+<([^>]*)>(?:\s+mtu\s+(\d+))?`)
	speedRe  = regexp.MustCompile(`\((\d+)(G|M)?[bB]ase`)
)

// ParseIfconfig reads `ifconfig -a`.
func ParseIfconfig(b []byte) []Iface {
	var out []Iface
	var cur *Iface
	for _, line := range strings.Split(string(b), "\n") {
		if m := ifHeadRe.FindStringSubmatch(line); m != nil && line[0] != '\t' && line[0] != ' ' {
			out = append(out, Iface{Name: m[1]})
			cur = &out[len(out)-1]
			for _, f := range strings.Split(m[2], ",") {
				if f == "UP" {
					cur.Up = true
				}
			}
			cur.MTU, _ = strconv.Atoi(m[3])
			continue
		}
		if cur == nil {
			continue
		}
		f := strings.Fields(line)
		if len(f) < 2 {
			continue
		}
		switch f[0] {
		case "ether":
			cur.MAC = strings.ToLower(f[1])
		case "inet":
			ip := net.ParseIP(f[1]).To4()
			if ip == nil || ip.IsLoopback() || ip.IsLinkLocalUnicast() {
				continue
			}
			bits := 32
			for i := 2; i+1 < len(f); i++ {
				if f[i] == "netmask" {
					if n, err := strconv.ParseUint(strings.TrimPrefix(f[i+1], "0x"), 16, 32); err == nil {
						bits, _ = net.IPv4Mask(byte(n>>24), byte(n>>16), byte(n>>8), byte(n)).Size()
					}
				}
			}
			cur.Addrs = append(cur.Addrs, ip.String()+"/"+strconv.Itoa(bits))
		case "inet6":
			a := f[1]
			if i := strings.IndexByte(a, '%'); i >= 0 {
				a = a[:i]
			}
			ip := net.ParseIP(a)
			if ip == nil || !ip.IsGlobalUnicast() || ip.IsLinkLocalUnicast() || strings.Contains(line, " temporary") {
				continue
			}
			bits := "128"
			for i := 2; i+1 < len(f); i++ {
				if f[i] == "prefixlen" {
					bits = f[i+1]
				}
			}
			cur.Addrs = append(cur.Addrs, ip.String()+"/"+bits)
		case "status:":
			cur.Active = f[1] == "active"
		case "media:":
			cur.Media = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(line), "media:"))
		case "member:":
			cur.Members = append(cur.Members, f[1])
		}
	}
	return out
}

// SpeedMbps reads the link speed from ifconfig's media ("autoselect
// (10Gbase-T <full-duplex>)" -> 10000; 0 unknown).
func SpeedMbps(media string) int {
	m := speedRe.FindStringSubmatch(media)
	if m == nil {
		return 0
	}
	n, _ := strconv.Atoi(m[1])
	if m[2] == "G" {
		n *= 1000
	}
	return n
}

// HardwarePort is one entry of `networksetup -listallhardwareports`.
type HardwarePort struct {
	Port   string // "Ethernet", "Wi-Fi", "Thunderbolt Bridge"
	Device string // "en0"
}

// ParseHardwarePorts reads `networksetup -listallhardwareports`.
func ParseHardwarePorts(b []byte) []HardwarePort {
	var out []HardwarePort
	port := ""
	for _, line := range strings.Split(string(b), "\n") {
		k, v, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		v = strings.TrimSpace(v)
		switch k {
		case "Hardware Port":
			port = v
		case "Device":
			if port != "" && v != "" {
				out = append(out, HardwarePort{Port: port, Device: v})
			}
			port = ""
		}
	}
	return out
}

// IsWireless: Wi-Fi (AirPort on older systems).
func (h HardwarePort) IsWireless() bool {
	return h.Port == "Wi-Fi" || h.Port == "AirPort"
}
