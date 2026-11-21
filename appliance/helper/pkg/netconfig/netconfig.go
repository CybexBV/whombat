// Package netconfig defines typed network configuration candidates. Candidates are data, never
// commands: the helper validates them itself and renders a systemd-networkd unit from parsed fields.
package netconfig

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/netip"
	"regexp"
	"strings"
)

var (
	idRe    = regexp.MustCompile(`^n-[a-z0-9][a-z0-9-]{0,62}$`)
	ifaceRe = regexp.MustCompile(`^(en|eth)[a-z0-9]{1,13}$`)
)

// MaxBytes bounds a candidate document.
const MaxBytes = 16 * 1024

// ValidID reports whether id is a valid candidate id.
func ValidID(id string) bool { return idRe.MatchString(id) }

// IPv4 configuration.
type IPv4 struct {
	Mode    string `json:"mode"` // "dhcp" | "static"
	Address string `json:"address,omitempty"`
	Gateway string `json:"gateway,omitempty"`
}

// IPv6 configuration.
type IPv6 struct {
	Mode    string `json:"mode"` // "auto" | "static" | "disabled"
	Address string `json:"address,omitempty"`
	Gateway string `json:"gateway,omitempty"`
}

// Candidate is one proposed configuration of the primary wired interface.
type Candidate struct {
	V                 int      `json:"v"`
	ID                string   `json:"id"`
	Interface         string   `json:"interface"`
	IPv4              IPv4     `json:"ipv4"`
	IPv6              IPv6     `json:"ipv6"`
	DNS               []string `json:"dns"`
	MTU               int      `json:"mtu,omitempty"`
	ConfirmTimeoutSec int      `json:"confirmTimeoutSec"`
}

// Parse strictly decodes and validates a candidate.
func Parse(data []byte) (*Candidate, error) {
	if len(data) > MaxBytes {
		return nil, errors.New("netconfig: candidate too large")
	}
	dec := json.NewDecoder(strings.NewReader(string(data)))
	dec.DisallowUnknownFields()
	var c Candidate
	if err := dec.Decode(&c); err != nil {
		return nil, fmt.Errorf("netconfig: %w", err)
	}
	if dec.More() {
		return nil, errors.New("netconfig: trailing data")
	}
	return &c, c.Validate()
}

// addrChars/prefixChars: the only characters an address or prefix may contain. netip accepts IPv6
// zones with arbitrary bytes ("fe80::1%x\nIPv4Forwarding=yes"), which would inject lines into the
// root-written networkd unit (L-3); zones are never valid here.
func strictAddr(s string) (netip.Addr, error) {
	if s == "" || strings.TrimLeft(s, "0123456789abcdefABCDEF:.") != "" {
		return netip.Addr{}, errors.New("netconfig: address contains invalid characters")
	}
	a, err := netip.ParseAddr(s)
	if err != nil || a.Zone() != "" {
		return netip.Addr{}, errors.New("netconfig: bad address")
	}
	return a, nil
}

func strictPrefix(s string) (netip.Prefix, error) {
	if s == "" || strings.TrimLeft(s, "0123456789abcdefABCDEF:./") != "" {
		return netip.Prefix{}, errors.New("netconfig: prefix contains invalid characters")
	}
	p, err := netip.ParsePrefix(s)
	if err != nil || p.Addr().Zone() != "" {
		return netip.Prefix{}, errors.New("netconfig: bad prefix")
	}
	return p, nil
}

// Validate checks every field.
func (c *Candidate) Validate() error {
	if c.V != 1 {
		return errors.New("netconfig: unsupported version")
	}
	if !ValidID(c.ID) {
		return errors.New("netconfig: bad id")
	}
	if !ifaceRe.MatchString(c.Interface) {
		return errors.New("netconfig: bad interface name")
	}
	switch c.IPv4.Mode {
	case "dhcp":
		if c.IPv4.Address != "" || c.IPv4.Gateway != "" {
			return errors.New("netconfig: dhcp ipv4 takes no address")
		}
	case "static":
		p, err := strictPrefix(c.IPv4.Address)
		if err != nil || !p.Addr().Is4() || p.Bits() < 8 || p.Bits() > 32 {
			return errors.New("netconfig: bad ipv4 address")
		}
		g, err := strictAddr(c.IPv4.Gateway)
		if err != nil || !g.Is4() || !p.Contains(g) {
			return errors.New("netconfig: ipv4 gateway must be inside the prefix")
		}
	default:
		return errors.New("netconfig: bad ipv4 mode")
	}
	switch c.IPv6.Mode {
	case "auto", "disabled":
		if c.IPv6.Address != "" || c.IPv6.Gateway != "" {
			return errors.New("netconfig: ipv6 mode takes no address")
		}
	case "static":
		p, err := strictPrefix(c.IPv6.Address)
		if err != nil || !p.Addr().Is6() || p.Addr().Is4In6() || p.Bits() < 16 || p.Bits() > 128 {
			return errors.New("netconfig: bad ipv6 address")
		}
		g, err := strictAddr(c.IPv6.Gateway)
		if err != nil || !g.Is6() || g.Is4In6() {
			return errors.New("netconfig: bad ipv6 gateway")
		}
	default:
		return errors.New("netconfig: bad ipv6 mode")
	}
	if len(c.DNS) > 4 {
		return errors.New("netconfig: at most 4 DNS servers")
	}
	for _, d := range c.DNS {
		if _, err := strictAddr(d); err != nil {
			return errors.New("netconfig: bad DNS server")
		}
	}
	if c.MTU != 0 && (c.MTU < 576 || c.MTU > 9216) { // local.NetworkCandidate bounds (0.5)
		return errors.New("netconfig: bad MTU")
	}
	if c.ConfirmTimeoutSec < 30 || c.ConfirmTimeoutSec > 600 {
		return errors.New("netconfig: confirm timeout must be 30..600 s")
	}
	return nil
}

// RenderNetworkd renders a systemd-networkd .network unit from a validated candidate.
func (c *Candidate) RenderNetworkd() string {
	var b strings.Builder
	fmt.Fprintf(&b, "# Generated by whombat-update-helper from candidate %s\n[Match]\nName=%s\n\n[Network]\n", c.ID, c.Interface)
	switch {
	case c.IPv4.Mode == "dhcp" && c.IPv6.Mode == "auto":
		b.WriteString("DHCP=yes\n")
	case c.IPv4.Mode == "dhcp":
		b.WriteString("DHCP=ipv4\n")
	case c.IPv6.Mode == "auto":
		b.WriteString("DHCP=ipv6\n")
	default:
		b.WriteString("DHCP=no\n")
	}
	switch c.IPv6.Mode {
	case "disabled":
		b.WriteString("IPv6AcceptRA=no\nLinkLocalAddressing=ipv4\n")
	case "auto":
		b.WriteString("IPv6AcceptRA=yes\n")
	case "static":
		b.WriteString("IPv6AcceptRA=no\n")
	}
	// Rendered from the parsed values (canonical form), never the raw strings.
	canonP := func(s string) string { p, _ := strictPrefix(s); return p.String() }
	canonA := func(s string) string { a, _ := strictAddr(s); return a.String() }
	if c.IPv4.Mode == "static" {
		fmt.Fprintf(&b, "Address=%s\nGateway=%s\n", canonP(c.IPv4.Address), canonA(c.IPv4.Gateway))
	}
	if c.IPv6.Mode == "static" {
		fmt.Fprintf(&b, "Address=%s\nGateway=%s\n", canonP(c.IPv6.Address), canonA(c.IPv6.Gateway))
	}
	for _, d := range c.DNS {
		fmt.Fprintf(&b, "DNS=%s\n", canonA(d))
	}
	if c.MTU != 0 {
		fmt.Fprintf(&b, "\n[Link]\nMTUBytes=%d\n", c.MTU)
	}
	return b.String()
}
