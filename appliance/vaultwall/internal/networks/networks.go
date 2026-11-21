// Package networks parses and validates the Vault's home-network list as the runtime hands it to the appliance
// (Whombat VT-12, VT-59; IN-59). It is the privileged side's own check: the runtime validated the list already,
// and nothing it writes can open more than this package allows.
//
// The file is exactly
//
//	{"version":1,"networks":[{"cidr":"192.168.1.0/24","ports":[8123]}]}
//
// Only private IPv4 networks (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16), shared address space
// (100.64.0.0/10, where Tailscale addresses live) and IPv6 unique local networks (fc00::/7) are listable, no wider than a /16 (IPv4) or /48 (IPv6); ranges that are never listable (VT-12:
// loopback, link-local, metadata, multicast, unspecified, reserved, documentation) are named in the error.
// At most 32 networks with 1–16 TCP ports each. Anything else makes the whole file invalid: the caller applies
// an empty set. The rules are exactly core's `vaultNetworkProblem` (whombat-contracts, CT-98), so a list the
// runtime accepted is never refused here (IN-62).
package networks

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/netip"
	"slices"
	"strings"
)

const (
	// Version is the only file version this package reads.
	Version = 1
	// MaxNetworks is the most networks a list may hold (VT-12).
	MaxNetworks = 32
	// MaxPorts is the most ports one network may list (VT-12).
	MaxPorts = 16
	// MaxFileBytes bounds the file (32 networks of 16 ports are about 4 KiB).
	MaxFileBytes = 64 << 10
	// MinBits4 and MinBits6 are the widest listable prefixes (VT-12).
	MinBits4 = 16
	MinBits6 = 48
)

// Network is one validated entry: a masked prefix and its ports (sorted, unique).
type Network struct {
	Prefix netip.Prefix
	Ports  []uint16
}

// Element is one (network, port) pair of the firewall sets.
type Element struct {
	Prefix netip.Prefix
	Port   uint16
}

type span struct {
	prefix netip.Prefix
	what   string
}

func mustSpans(pairs ...string) []span {
	out := make([]span, 0, len(pairs)/2)
	for i := 0; i < len(pairs); i += 2 {
		out = append(out, span{netip.MustParsePrefix(pairs[i]), pairs[i+1]})
	}
	return out
}

// listable is the universe a network must lie in.
var listable = mustSpans(
	"10.0.0.0/8", "private",
	"172.16.0.0/12", "private",
	"192.168.0.0/16", "private",
	"100.64.0.0/10", "shared address space",
	"fc00::/7", "unique local",
)

// never names ranges no network may overlap, so the error says why (VT-12). Those outside `listable` would be
// refused anyway; the metadata addresses inside listable space (100.100.100.200 in 100.64.0.0/10, fd00:ec2::254
// in fc00::/7) are refused only here, as core refuses any network that holds a metadata address.
var never = mustSpans(
	"0.0.0.0/8", "unspecified (“this network”)",
	"127.0.0.0/8", "loopback",
	"169.254.0.0/16", "link-local (incl. the 169.254.169.254 metadata address)",
	"100.100.100.200/32", "a metadata address (Alibaba Cloud)",
	"192.0.0.0/24", "reserved (IETF protocol assignments; incl. the 192.0.0.192 metadata address)",
	"192.0.2.0/24", "documentation",
	"198.51.100.0/24", "documentation",
	"203.0.113.0/24", "documentation",
	"192.88.99.0/24", "reserved (6to4 relay)",
	"198.18.0.0/15", "reserved (benchmarking)",
	"224.0.0.0/4", "multicast",
	"240.0.0.0/4", "reserved (incl. broadcast)",
	"::/128", "unspecified",
	"::1/128", "loopback",
	"::ffff:0:0/96", "IPv4-mapped (list the IPv4 network instead)",
	"64:ff9b::/96", "reserved (NAT64)",
	"64:ff9b:1::/48", "reserved (NAT64)",
	"100::/64", "reserved (discard)",
	"2001::/23", "reserved (IETF protocol assignments)",
	"2001:db8::/32", "documentation",
	"3fff::/20", "documentation",
	"2002::/16", "reserved (6to4)",
	"fd00:ec2::254/128", "a metadata address (AWS over IPv6)",
	"fe80::/10", "link-local",
	"fec0::/10", "reserved (site-local)",
	"ff00::/8", "multicast",
)

// CheckPrefix reports why a prefix may not be listed, or nil. Host bits are ignored (the prefix is masked).
func CheckPrefix(p netip.Prefix) error {
	if !p.IsValid() {
		return errors.New("not a network")
	}
	p = p.Masked()
	// Inside a named range: say which (127.0.0.0/8 is loopback before it is too wide).
	for _, s := range never {
		if s.prefix.Bits() <= p.Bits() && s.prefix.Contains(p.Addr()) {
			return fmt.Errorf("is in %s, which is %s", s.prefix, s.what)
		}
	}
	if p.Addr().Is4() && p.Bits() < MinBits4 {
		return fmt.Errorf("wider than /%d", MinBits4)
	}
	if p.Addr().Is6() && p.Bits() < MinBits6 {
		return fmt.Errorf("wider than /%d", MinBits6)
	}
	for _, s := range never {
		if s.prefix.Overlaps(p) {
			return fmt.Errorf("overlaps %s, which is %s", s.prefix, s.what)
		}
	}
	for _, s := range listable {
		if s.prefix.Bits() <= p.Bits() && s.prefix.Contains(p.Addr()) {
			return nil
		}
	}
	return errors.New("not a private network (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 100.64.0.0/10) or a unique local one (fc00::/7)")
}

type fileJSON struct {
	Version  *int           `json:"version"`
	Networks *[]networkJSON `json:"networks"`
}

type networkJSON struct {
	CIDR  *string   `json:"cidr"`
	Ports *[]uint16 `json:"ports"`
}

// Parse decodes and validates a whole file. Any problem is an error; the list is then not used at all.
func Parse(data []byte) ([]Network, error) {
	if len(data) > MaxFileBytes {
		return nil, fmt.Errorf("larger than %d bytes", MaxFileBytes)
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	var f fileJSON
	if err := dec.Decode(&f); err != nil {
		return nil, fmt.Errorf("not the expected JSON: %s", clip(err.Error()))
	}
	if _, err := dec.Token(); err != io.EOF {
		return nil, errors.New("not the expected JSON: data after the object")
	}
	if f.Version == nil {
		return nil, errors.New("no version")
	}
	if *f.Version != Version {
		return nil, fmt.Errorf("version %d, want %d", *f.Version, Version)
	}
	if f.Networks == nil {
		return nil, errors.New("no networks")
	}
	if len(*f.Networks) > MaxNetworks {
		return nil, fmt.Errorf("%d networks, at most %d", len(*f.Networks), MaxNetworks)
	}
	out := make([]Network, 0, len(*f.Networks))
	for i, n := range *f.Networks {
		if n.CIDR == nil {
			return nil, fmt.Errorf("networks[%d]: no cidr", i)
		}
		if !strings.Contains(*n.CIDR, "/") {
			return nil, fmt.Errorf("networks[%d].cidr %q: not a CIDR (address/length)", i, clip(*n.CIDR))
		}
		p, err := netip.ParsePrefix(*n.CIDR)
		if err != nil {
			return nil, fmt.Errorf("networks[%d].cidr %q: not a CIDR", i, clip(*n.CIDR))
		}
		p = p.Masked()
		if err := CheckPrefix(p); err != nil {
			return nil, fmt.Errorf("networks[%d].cidr %s: %w", i, p, err)
		}
		if n.Ports == nil || len(*n.Ports) == 0 {
			return nil, fmt.Errorf("networks[%d]: no ports", i)
		}
		if len(*n.Ports) > MaxPorts {
			return nil, fmt.Errorf("networks[%d]: %d ports, at most %d", i, len(*n.Ports), MaxPorts)
		}
		ports := slices.Clone(*n.Ports)
		for _, port := range ports {
			if port == 0 {
				return nil, fmt.Errorf("networks[%d]: port 0", i)
			}
		}
		slices.Sort(ports)
		out = append(out, Network{Prefix: p, Ports: slices.Compact(ports)})
	}
	return out, nil
}

// Elements turns validated networks into the set elements per family: one per (network, port), sorted, with
// networks that another listed network of the same port already covers left out. Interval sets refuse
// overlapping elements, and prefixes either nest or are disjoint, so what remains never overlaps.
func Elements(nets []Network) (v4, v6 []Element) {
	byPort := map[uint16][]netip.Prefix{}
	for _, n := range nets {
		for _, port := range n.Ports {
			byPort[port] = append(byPort[port], n.Prefix)
		}
	}
	for port, prefixes := range byPort {
		// Widest first: a prefix is dropped when an already kept one contains it.
		slices.SortFunc(prefixes, func(a, b netip.Prefix) int {
			if a.Bits() != b.Bits() {
				return a.Bits() - b.Bits()
			}
			return a.Addr().Compare(b.Addr())
		})
		var kept []netip.Prefix
		for _, p := range prefixes {
			covered := slices.ContainsFunc(kept, func(k netip.Prefix) bool {
				return k.Bits() <= p.Bits() && k.Contains(p.Addr())
			})
			if !covered {
				kept = append(kept, p)
			}
		}
		for _, p := range kept {
			if p.Addr().Is4() {
				v4 = append(v4, Element{p, port})
			} else {
				v6 = append(v6, Element{p, port})
			}
		}
	}
	cmp := func(a, b Element) int {
		if c := a.Prefix.Addr().Compare(b.Prefix.Addr()); c != 0 {
			return c
		}
		if a.Prefix.Bits() != b.Prefix.Bits() {
			return a.Prefix.Bits() - b.Prefix.Bits()
		}
		return int(a.Port) - int(b.Port)
	}
	slices.SortFunc(v4, cmp)
	slices.SortFunc(v6, cmp)
	return v4, v6
}

// clip keeps what an error quotes from the file short and printable.
func clip(s string) string {
	const max = 80
	var b strings.Builder
	for _, r := range s {
		if b.Len() >= max {
			b.WriteString("…")
			break
		}
		if r < 0x20 || r == 0x7f || (r >= 0x80 && r < 0xa0) {
			r = '?'
		}
		b.WriteRune(r)
	}
	return b.String()
}
