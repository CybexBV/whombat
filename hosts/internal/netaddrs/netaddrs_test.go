package netaddrs

import "testing"

func TestPhysical(t *testing.T) {
	for name, want := range map[string]bool{
		"eth0": true, "enp1s0": true, "vmbr0": true, "br0": true, "bond0": true, "wlan0": true,
		"lo": false, "wbc0": false, "incusbr0": false, "lxcbr0": false, "lxdbr0": false, "docker0": false,
		"br-3f2a9c": false, "veth12ab": false, "virbr0": false, "cni0": false, "flannel.1": false, "cali123": false,
		"vxlan.calico": false, "tailscale0": false, "wg0": false, "zt5u4": false, "tun0": false, "tap101i0": false,
		"kube-ipvs0": false, "podman0": false,
	} {
		if got := (Interface{Name: name, Up: true}).Physical(); got != want {
			t.Errorf("%s: %v", name, got)
		}
	}
	if (Interface{Name: "eth1"}).Physical() || (Interface{Name: "eth2", Up: true, Loopback: true}).Physical() {
		t.Error("a down or loopback interface counts")
	}
}
