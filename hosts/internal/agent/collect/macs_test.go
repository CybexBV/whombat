package collect

import (
	"strings"
	"testing"
)

func TestGuestMACs(t *testing.T) {
	pve := pveMACs(map[string]string{
		"net0":   "virtio=BC:24:11:AA:BB:CC,bridge=vmbr0,firewall=1",
		"net1":   "e1000=bc:24:11:00:00:01,bridge=vmbr1",
		"net2":   "name=eth0,bridge=vmbr0,hwaddr=BC:24:11:00:00:02,ip=dhcp",
		"net3":   "model=virtio,macaddr=BC:24:11:00:00:03",
		"netx":   "virtio=BC:24:11:FF:FF:FF",
		"net4":   "virtio=00:00:00:00:00:00",
		"scsi0":  "local:vm-1-disk-0,size=8G",
		"ipcfg0": "ip=dhcp",
	})
	if got := strings.Join(pve, ","); got != "bc:24:11:00:00:01,bc:24:11:00:00:02,bc:24:11:00:00:03,bc:24:11:aa:bb:cc" {
		t.Errorf("pve: %s", got)
	}
	d, err := parseDomainXML(`<domain><name>w</name><memory unit="KiB">1024</memory><devices>
		<interface type="network"><mac address="52:54:00:AB:CD:EF"/><source network="default"/></interface>
		<interface type="bridge"><mac address="52:54:00:00:00:01"/></interface>
		<interface type="user"/></devices></domain>`)
	if err != nil || strings.Join(d.MACs, ",") != "52:54:00:00:00:01,52:54:00:ab:cd:ef" {
		t.Errorf("libvirt: %v %+v", err, d)
	}
	in := &incusInstance{ExpandedConfig: map[string]string{"volatile.eth0.hwaddr": "10:66:6a:00:00:01", "volatile.eth0.host_name": "veth1",
		"volatile.eth1.hwaddr": "garbage"}, ExpandedDevices: map[string]map[string]string{
		"eth2": {"type": "nic", "hwaddr": "10:66:6A:00:00:02"}, "root": {"type": "disk", "hwaddr": "10:66:6a:00:00:09"}}}
	if got := strings.Join(incusMACs(in), ","); got != "10:66:6a:00:00:01,10:66:6a:00:00:02" {
		t.Errorf("incus: %s", got)
	}
}
