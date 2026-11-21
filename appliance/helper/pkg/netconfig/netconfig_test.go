package netconfig

import (
	"strconv"
	"testing"
)

func TestParseRejects(t *testing.T) {
	for _, s := range []string{
		`{"v":1,"id":"n-1","interface":"enp1s0","ipv4":{"mode":"dhcp"},"ipv6":{"mode":"auto"},"dns":[],"confirmTimeoutSec":60,"exec":"rm -rf /"}`,
		`{"v":1,"id":"../x","interface":"enp1s0","ipv4":{"mode":"dhcp"},"ipv6":{"mode":"auto"},"dns":[],"confirmTimeoutSec":60}`,
		`{"v":1,"id":"n-1","interface":"enp1s0\nExecStart=x","ipv4":{"mode":"dhcp"},"ipv6":{"mode":"auto"},"dns":[],"confirmTimeoutSec":60}`,
		`{"v":1,"id":"n-1","interface":"enp1s0","ipv4":{"mode":"static","address":"10.0.0.2/24","gateway":"10.0.1.1"},"ipv6":{"mode":"auto"},"dns":[],"confirmTimeoutSec":60}`,
		`{"v":1,"id":"n-1","interface":"enp1s0","ipv4":{"mode":"dhcp"},"ipv6":{"mode":"auto"},"dns":["x\n[Network]"],"confirmTimeoutSec":60}`,
		`{"v":1,"id":"n-1","interface":"enp1s0","ipv4":{"mode":"dhcp"},"ipv6":{"mode":"auto"},"dns":[],"confirmTimeoutSec":5}`,
	} {
		if _, err := Parse([]byte(s)); err == nil {
			t.Errorf("accepted %s", s)
		}
	}
}

func TestMTUBounds(t *testing.T) {
	for mtu, ok := range map[int]bool{575: false, 576: true, 1500: true, 9216: true, 9217: false} {
		c := `{"v":1,"id":"n-m","interface":"enp1s0","ipv4":{"mode":"dhcp"},"ipv6":{"mode":"auto"},"dns":[],"mtu":` + strconv.Itoa(mtu) + `,"confirmTimeoutSec":60}`
		if _, err := Parse([]byte(c)); (err == nil) != ok {
			t.Errorf("mtu %d: %v", mtu, err)
		}
	}
}
