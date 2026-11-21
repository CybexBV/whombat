// Package netaddrs lists a machine's network interfaces in a form the hub
// (the addresses it tells its agents, HS-170) and the agent (the networks it
// searches for its hub, HS-174) share, so both skip the same virtual
// interfaces. Tests pass their own []Interface.
package netaddrs

import (
	"net"
	"net/netip"
	"strings"
)

// Interface is one network interface and its addresses.
type Interface struct {
	Name     string
	Up       bool
	Loopback bool
	// Prefixes are the interface's addresses with their prefix length.
	Prefixes []netip.Prefix
}

// System reads the machine's interfaces.
func System() ([]Interface, error) {
	ifs, err := net.Interfaces()
	if err != nil {
		return nil, err
	}
	out := make([]Interface, 0, len(ifs))
	for _, ifc := range ifs {
		it := Interface{Name: ifc.Name, Up: ifc.Flags&net.FlagUp != 0, Loopback: ifc.Flags&net.FlagLoopback != 0}
		addrs, err := ifc.Addrs()
		if err != nil {
			continue
		}
		for _, a := range addrs {
			ipn, ok := a.(*net.IPNet)
			if !ok {
				continue
			}
			ip, ok := netip.AddrFromSlice(ipn.IP)
			if !ok {
				continue
			}
			ones, bits := ipn.Mask.Size()
			ip = ip.Unmap()
			if ip.Is4() && bits == 128 {
				ones -= 96
			}
			if p := netip.PrefixFrom(ip, ones); p.IsValid() {
				it.Prefixes = append(it.Prefixes, p)
			}
		}
		out = append(out, it)
	}
	return out, nil
}

// virtualPrefixes are the names of interfaces that belong to containers,
// VMs, overlays and VPNs rather than the machine's own networks: Whombat's
// computers (wbc), Incus, LXC/LXD, Docker (docker0, br-<id>), veth pairs,
// libvirt, CNI plugins (flannel, calico, vxlan, kube, podman) and tunnels
// (Tailscale, WireGuard, ZeroTier, tun/tap). Proxmox's vmbr* and a plain
// br0 are a host's real network and are not listed.
var virtualPrefixes = []string{
	"wbc", "incusbr", "lxcbr", "lxdbr", "docker", "br-", "veth", "virbr", "cni", "flannel", "cali", "vxlan",
	"tailscale", "wg", "zt", "tun", "tap", "kube", "podman",
}

// Virtual reports whether an interface name is a container, VM, overlay or
// VPN interface (see virtualPrefixes).
func Virtual(name string) bool {
	for _, p := range virtualPrefixes {
		if strings.HasPrefix(name, p) {
			return true
		}
	}
	return false
}

// Physical reports whether an interface is up, not loopback and not
// Virtual: one whose addresses are the machine's own on its networks.
func (i Interface) Physical() bool {
	return i.Up && !i.Loopback && i.Name != "lo" && !Virtual(i.Name)
}
