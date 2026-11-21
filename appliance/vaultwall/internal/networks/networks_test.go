package networks

import (
	"fmt"
	"net/netip"
	"strings"
	"testing"
)

func file(nets ...string) string {
	return `{"version":1,"networks":[` + strings.Join(nets, ",") + `]}`
}

func TestParseValid(t *testing.T) {
	got, err := Parse([]byte(file(
		`{"cidr":"192.168.1.0/24","ports":[8123]}`,
		`{"cidr":"10.20.0.0/16","ports":[443,80,80]}`,
		`{"cidr":"172.31.255.7/32","ports":[1,65535]}`,
		`{"cidr":"fd12:3456:789a::/48","ports":[8123]}`,
		`{"cidr":"fd12:3456:789a:1::10/128","ports":[5000]}`,
		`{"cidr":"192.168.7.9/24","ports":[22]}`,
	)))
	if err != nil {
		t.Fatal(err)
	}
	want := []string{
		"192.168.1.0/24 [8123]",
		"10.20.0.0/16 [80 443]",
		"172.31.255.7/32 [1 65535]",
		"fd12:3456:789a::/48 [8123]",
		"fd12:3456:789a:1::10/128 [5000]",
		"192.168.7.0/24 [22]", // host bits masked
	}
	if len(got) != len(want) {
		t.Fatalf("got %v", got)
	}
	for i, n := range got {
		if s := fmt.Sprintf("%s %v", n.Prefix, n.Ports); s != want[i] {
			t.Errorf("networks[%d] = %s, want %s", i, s, want[i])
		}
	}
}

func TestParseEmptyList(t *testing.T) {
	got, err := Parse([]byte(`{"version":1,"networks":[]}`))
	if err != nil || len(got) != 0 {
		t.Fatalf("got %v, %v", got, err)
	}
}

func TestParseLimits(t *testing.T) {
	var nets []string
	for i := range MaxNetworks {
		nets = append(nets, fmt.Sprintf(`{"cidr":"10.%d.0.0/16","ports":[80]}`, i))
	}
	if _, err := Parse([]byte(file(nets...))); err != nil {
		t.Fatalf("%d networks: %v", MaxNetworks, err)
	}
	nets = append(nets, `{"cidr":"10.200.0.0/16","ports":[80]}`)
	if _, err := Parse([]byte(file(nets...))); err == nil || !strings.Contains(err.Error(), "at most 32") {
		t.Fatalf("33 networks: %v", err)
	}

	ports := make([]string, MaxPorts)
	for i := range ports {
		ports[i] = fmt.Sprint(8000 + i)
	}
	ok := file(`{"cidr":"192.168.1.0/24","ports":[` + strings.Join(ports, ",") + `]}`)
	if _, err := Parse([]byte(ok)); err != nil {
		t.Fatalf("16 ports: %v", err)
	}
	ports = append(ports, "9000")
	tooMany := file(`{"cidr":"192.168.1.0/24","ports":[` + strings.Join(ports, ",") + `]}`)
	if _, err := Parse([]byte(tooMany)); err == nil || !strings.Contains(err.Error(), "at most 16") {
		t.Fatalf("17 ports: %v", err)
	}

	big := `{"version":1,"networks":[]}` + strings.Repeat(" ", MaxFileBytes)
	if _, err := Parse([]byte(big)); err == nil || !strings.Contains(err.Error(), "larger than") {
		t.Fatalf("big file: %v", err)
	}
}

func TestParseMalformed(t *testing.T) {
	for _, tc := range []struct{ name, data, want string }{
		{"empty", ``, "not the expected JSON"},
		{"not json", `version=1`, "not the expected JSON"},
		{"truncated", `{"version":1,"networks":[`, "not the expected JSON"},
		{"array", `[]`, "not the expected JSON"},
		{"trailing", `{"version":1,"networks":[]} {}`, "data after the object"},
		{"no version", `{"networks":[]}`, "no version"},
		{"version 2", `{"version":2,"networks":[]}`, "version 2"},
		{"version string", `{"version":"1","networks":[]}`, "not the expected JSON"},
		{"version float", `{"version":1.5,"networks":[]}`, "not the expected JSON"},
		{"no networks", `{"version":1}`, "no networks"},
		{"null networks", `{"version":1,"networks":null}`, "no networks"},
		{"unknown field", `{"version":1,"networks":[],"extra":true}`, "unknown field"},
		{"note", file(`{"cidr":"192.168.1.0/24","ports":[80],"note":"HA"}`), "unknown field"},
		{"no cidr", file(`{"ports":[80]}`), "no cidr"},
		{"cidr number", file(`{"cidr":1,"ports":[80]}`), "not the expected JSON"},
		{"bare address", file(`{"cidr":"192.168.1.10","ports":[80]}`), "not a CIDR"},
		{"hostname", file(`{"cidr":"homeassistant.local/32","ports":[80]}`), "not a CIDR"},
		{"leading zeros", file(`{"cidr":"192.168.001.0/24","ports":[80]}`), "not a CIDR"},
		{"zone", file(`{"cidr":"fd00::1%eth0/128","ports":[80]}`), "not a CIDR"},
		{"length 33", file(`{"cidr":"192.168.1.0/33","ports":[80]}`), "not a CIDR"},
		{"control characters", file(`{"cidr":"\u001b[2J/24","ports":[80]}`), `"?[2J/24"`},
		{"no ports", file(`{"cidr":"192.168.1.0/24"}`), "no ports"},
		{"empty ports", file(`{"cidr":"192.168.1.0/24","ports":[]}`), "no ports"},
		{"port 0", file(`{"cidr":"192.168.1.0/24","ports":[0]}`), "port 0"},
		{"port too big", file(`{"cidr":"192.168.1.0/24","ports":[65536]}`), "not the expected JSON"},
		{"negative port", file(`{"cidr":"192.168.1.0/24","ports":[-1]}`), "not the expected JSON"},
		{"port float", file(`{"cidr":"192.168.1.0/24","ports":[80.5]}`), "not the expected JSON"},
		{"port string", file(`{"cidr":"192.168.1.0/24","ports":["80"]}`), "not the expected JSON"},
		{"one bad of two", file(`{"cidr":"192.168.1.0/24","ports":[80]}`, `{"cidr":"127.0.0.1/32","ports":[80]}`), "networks[1]"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := Parse([]byte(tc.data))
			if err == nil {
				t.Fatalf("accepted: %v", got)
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error %q does not contain %q", err, tc.want)
			}
		})
	}
}

// Every range VT-12 says is never listable, and everything outside the private and unique local ranges.
func TestCheckPrefixRefuses(t *testing.T) {
	for _, tc := range []struct{ cidr, want string }{
		{"127.0.0.0/8", "loopback"},
		{"127.0.0.1/32", "loopback"},
		{"0.0.0.0/32", "unspecified"},
		{"0.0.0.0/0", "wider than /16"},
		{"169.254.169.254/32", "link-local"},
		{"169.254.0.0/16", "link-local"},
		{"100.100.100.200/32", "metadata"},
		{"100.100.0.0/16", "metadata"},
		{"100.64.0.0/10", "wider than /16"},
		{"192.0.0.192/32", "metadata"},
		{"224.0.0.251/32", "multicast"},
		{"239.255.255.250/32", "multicast"},
		{"255.255.255.255/32", "broadcast"},
		{"240.0.0.0/16", "reserved"},
		{"192.0.2.0/24", "documentation"},
		{"198.51.100.7/32", "documentation"},
		{"203.0.113.0/24", "documentation"},
		{"198.18.0.0/16", "benchmarking"},
		{"192.88.99.1/32", "6to4"},
		{"10.0.0.0/8", "wider than /16"},
		{"10.0.0.0/15", "wider than /16"},
		{"172.16.0.0/12", "wider than /16"},
		{"192.168.0.0/15", "wider than /16"},
		{"192.169.0.0/16", "not a private network"},
		{"172.32.0.0/16", "not a private network"},
		{"8.8.8.8/32", "not a private network"},
		{"1.1.1.0/24", "not a private network"},
		{"::/128", "unspecified"},
		{"::1/128", "loopback"},
		{"::/0", "wider than /48"},
		{"::ffff:192.168.1.0/120", "IPv4-mapped"},
		{"64:ff9b::c0a8:101/128", "NAT64"},
		{"64:ff9b:1::/48", "NAT64"},
		{"100::/64", "discard"},
		{"2001::/32", "IETF"},
		{"2001:db8::/48", "documentation"},
		{"3fff::/48", "documentation"},
		{"2002:c0a8:101::/48", "6to4"},
		{"fe80::/64", "link-local"},
		{"fe80::1/128", "link-local"},
		{"fec0::/48", "site-local"},
		{"ff02::1/128", "multicast"},
		{"fd00:ec2::254/128", "metadata"},
		{"fd00:ec2::/48", "metadata"},
		{"fd00:ec2::254/127", "metadata"},
		{"fc00::/7", "wider than /48"},
		{"fd00::/8", "wider than /48"},
		{"fd12:3456::/32", "wider than /48"},
		{"fd12:3456:789a::/47", "wider than /48"},
		{"2a01:4f8::/48", "not a private network"},
		{"2606:4700:4700::1111/128", "not a private network"},
	} {
		t.Run(tc.cidr, func(t *testing.T) {
			err := CheckPrefix(netip.MustParsePrefix(tc.cidr))
			if err == nil {
				t.Fatal("accepted")
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error %q does not contain %q", err, tc.want)
			}
			// And the whole file is refused.
			if _, err := Parse([]byte(file(`{"cidr":"` + tc.cidr + `","ports":[80]}`))); err == nil {
				t.Fatal("file accepted")
			}
		})
	}
}

func TestCheckPrefixAccepts(t *testing.T) {
	for _, cidr := range []string{
		"10.0.0.0/16", "10.255.255.255/32", "172.16.0.0/16", "172.31.0.0/16", "192.168.0.0/16",
		"192.168.1.0/24", "192.168.1.10/32", "fc00::/48", "fd00::/48", "fd00:ec3::/48",
		"fdff:ffff:ffff::/48", "fd12:3456:789a:1::/64", "fd12:3456:789a:1::1/128",
		"100.64.0.0/16", "100.101.102.0/24", "100.127.255.1/32", "fd00:ec2:1::/48",
	} {
		if err := CheckPrefix(netip.MustParsePrefix(cidr)); err != nil {
			t.Errorf("%s: %v", cidr, err)
		}
	}
	if err := CheckPrefix(netip.Prefix{}); err == nil {
		t.Error("the zero prefix was accepted")
	}
}

func TestElements(t *testing.T) {
	nets, err := Parse([]byte(file(
		`{"cidr":"192.168.1.0/24","ports":[8123,80]}`,
		`{"cidr":"192.168.0.0/16","ports":[80]}`,         // covers 192.168.1.0/24 on 80
		`{"cidr":"192.168.1.10/32","ports":[8123,9000]}`, // covered on 8123, not on 9000
		`{"cidr":"192.168.1.0/24","ports":[8123]}`,       // duplicate
		`{"cidr":"10.1.0.0/16","ports":[8123]}`,
		`{"cidr":"fd12:3456:789a::/48","ports":[8123]}`,
		`{"cidr":"fd12:3456:789a:1::/64","ports":[8123,443]}`,
	)))
	if err != nil {
		t.Fatal(err)
	}
	v4, v6 := Elements(nets)
	str := func(es []Element) string {
		var b []string
		for _, e := range es {
			b = append(b, fmt.Sprintf("%s.%d", e.Prefix, e.Port))
		}
		return strings.Join(b, " ")
	}
	if got, want := str(v4), "10.1.0.0/16.8123 192.168.0.0/16.80 192.168.1.0/24.8123 192.168.1.10/32.9000"; got != want {
		t.Errorf("v4 = %s\nwant %s", got, want)
	}
	if got, want := str(v6), "fd12:3456:789a::/48.8123 fd12:3456:789a:1::/64.443"; got != want {
		t.Errorf("v6 = %s\nwant %s", got, want)
	}
	if v4, v6 := Elements(nil); v4 != nil || v6 != nil {
		t.Errorf("no networks gave %v %v", v4, v6)
	}
}

func TestElementsBounded(t *testing.T) {
	var nets []string
	for i := range MaxNetworks {
		var ports []string
		for j := range MaxPorts {
			ports = append(ports, fmt.Sprint(1000+j))
		}
		nets = append(nets, fmt.Sprintf(`{"cidr":"10.%d.0.0/16","ports":[%s]}`, i, strings.Join(ports, ",")))
	}
	parsed, err := Parse([]byte(file(nets...)))
	if err != nil {
		t.Fatal(err)
	}
	v4, v6 := Elements(parsed)
	if len(v4) != MaxNetworks*MaxPorts || len(v6) != 0 {
		t.Fatalf("got %d + %d elements", len(v4), len(v6))
	}
}
