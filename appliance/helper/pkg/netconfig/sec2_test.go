package netconfig

import (
	"strings"
	"testing"
)

// Regression for L-3 (W4-SEC part 2): an IPv6 zone with a newline injected directives and sections
// into the root-written networkd unit (the reviewer's PoC rendered IPv4Forwarding=yes and [Match] Name=*).
func TestZoneAndControlCharactersRefused(t *testing.T) {
	base := func(dns, v6 string) string {
		return `{"v":1,"id":"n-x","interface":"eth0","ipv4":{"mode":"dhcp"},"ipv6":` + v6 + `,"dns":[` + dns + `],"confirmTimeoutSec":60}`
	}
	auto := `{"mode":"auto"}`
	for name, doc := range map[string]string{
		"dns zone newline":   base(`"fe80::1%x\nIPv4Forwarding=yes\n[Match]\nName=*"`, auto),
		"dns zone":           base(`"fe80::1%eth0"`, auto),
		"dns trailing space": base(`"192.0.2.1 "`, auto),
		"gateway zone":       base(`"192.0.2.1"`, `{"mode":"static","address":"2001:db8::2/64","gateway":"fe80::1%x\nDNS=6.6.6.6"}`),
		"address newline":    base(`"192.0.2.1"`, `{"mode":"static","address":"2001:db8::2/64\nX=1","gateway":"2001:db8::1"}`),
	} {
		if c, err := Parse([]byte(doc)); err == nil {
			t.Errorf("%s accepted; renders:\n%s", name, c.RenderNetworkd())
		}
	}
	c, err := Parse([]byte(base(`"2001:DB8::53","192.0.2.53"`, `{"mode":"static","address":"2001:db8::2/64","gateway":"2001:db8::1"}`)))
	if err != nil {
		t.Fatalf("valid candidate refused: %v", err)
	}
	out := c.RenderNetworkd()
	if !strings.Contains(out, "DNS=2001:db8::53\n") || strings.Count(out, "[") != 2 {
		t.Fatalf("rendered:\n%s", out)
	}
}
