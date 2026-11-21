package collect

import (
	"strings"
	"testing"

	golibvirt "github.com/digitalocean/go-libvirt"

	"rackoon/internal/agent/broker"
	"rackoon/internal/proto"
)

func TestParseDomainXML(t *testing.T) {
	vnc, err := parseDomainXML(string(readTestdata(t, "libvirt_dom_vm-vnc.xml")))
	if err != nil {
		t.Fatal(err)
	}
	if vnc.Machine != "q35" || vnc.Firmware != "SeaBIOS" || vnc.TPM || vnc.image() != "q35 · SeaBIOS" {
		t.Errorf("vm-vnc: %+v image=%q", vnc, vnc.image())
	}
	if vnc.VCPU != 1 || vnc.MemMax != 1<<30 || !vnc.Balloon || vnc.OSType != "linux" {
		t.Errorf("vm-vnc: %+v", vnc)
	}
	// Console devices are judged by the broker from the same XML.
	caps := broker.Caps(proto.PlatformLibvirt, broker.LibvirtDisplay(string(readTestdata(t, "libvirt_dom_vm-spice.xml")), true))
	if caps.Default != proto.ProtoSPICE {
		t.Errorf("vm-spice caps: %+v", caps)
	}
	win := `<domain type='kvm'><name>win11</name><memory unit='GiB'>8</memory><vcpu placement='static' current='4'>8</vcpu>
<metadata><libosinfo:libosinfo xmlns:libosinfo="http://libosinfo.org/xmlns/libvirt/domain/1.0"><libosinfo:os id="http://microsoft.com/win/11"/></libosinfo:libosinfo></metadata>
<os firmware='efi'><type arch='x86_64' machine='pc-q35-9.2'>hvm</type><loader readonly='yes' secure='yes' type='pflash'>/usr/share/OVMF/OVMF_CODE_4M.ms.fd</loader></os>
<features><hyperv mode='custom'/></features>
<devices><graphics type='spice' autoport='yes'/><graphics type='vnc' port='-1'/><tpm model='tpm-crb'/><memballoon model='none'/></devices></domain>`
	w, err := parseDomainXML(win)
	if err != nil {
		t.Fatal(err)
	}
	if w.image() != "q35 · OVMF · TPM" || w.OSType != "windows" || w.VCPU != 4 || w.MemMax != 8<<30 || w.Balloon {
		t.Errorf("win11: %+v image=%q", w, w.image())
	}
}

func TestMachineShort(t *testing.T) {
	for in, want := range map[string]string{"pc-q35-10.0": "q35", "q35": "q35", "pc-i440fx-9.2": "i440fx", "pc": "i440fx", "virt-9.0": "virt", "": ""} {
		if got := machineShort(in); got != want {
			t.Errorf("machineShort(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestParseDomStats(t *testing.T) {
	u := func(f string, v uint64) golibvirt.TypedParam {
		return golibvirt.TypedParam{Field: f, Value: golibvirt.TypedParamValue{D: 4, I: v}}
	}
	i32 := func(f string, v int32) golibvirt.TypedParam {
		return golibvirt.TypedParam{Field: f, Value: golibvirt.TypedParamValue{D: 1, I: v}}
	}
	// Values from `virsh domstats --raw vm-vnc` on the libvirt test host.
	s := parseDomStats([]golibvirt.TypedParam{
		i32("state.state", 1), u("cpu.time", 16027741000),
		u("balloon.current", 1048576), u("balloon.maximum", 1048576),
		u("balloon.unused", 823220), u("balloon.available", 988536), u("balloon.usable", 787096), u("balloon.rss", 522520),
		u("vcpu.current", 1), u("vcpu.maximum", 1), u("balloon.last-update", 1791728260),
		{Field: "net.0.name", Value: golibvirt.TypedParamValue{D: 7, I: "vnet0"}},
		u("net.0.rx.bytes", 1000), u("net.0.tx.bytes", 2000), u("net.1.rx.bytes", 10),
		u("block.0.rd.bytes", 5000), u("block.0.wr.bytes", 7000), u("block.1.rd.bytes", 1),
	})
	if s.state != 1 || s.cpuNs != 16027741000 || s.vcpuCur != 1 || s.rx != 1010 || s.tx != 2000 || s.rd != 5001 || s.wr != 7000 {
		t.Errorf("stats: %+v", s)
	}
	if !s.haveAvail || !s.haveUsable || s.balloonAvail-s.balloonUsable != 201440 || s.balloonUpdated != 1791728260 {
		t.Errorf("balloon: %+v", s)
	}
	if libvirtState(s.state) != proto.StateRunning || libvirtState(5) != proto.StateStopped || libvirtState(3) != proto.StatePaused || libvirtState(7) != proto.StatePaused {
		t.Error("state mapping")
	}
}

func TestLibvirtEventState(t *testing.T) {
	for ev, want := range map[golibvirt.DomainEventType]string{
		golibvirt.DomainEventStarted: proto.StateRunning, golibvirt.DomainEventResumed: proto.StateRunning,
		golibvirt.DomainEventStopped: proto.StateStopped, golibvirt.DomainEventShutdown: proto.StateStopped,
		golibvirt.DomainEventUndefined: proto.StateStopped, golibvirt.DomainEventType(99): "",
		golibvirt.DomainEventSuspended: proto.StatePaused, golibvirt.DomainEventPmsuspended: proto.StatePaused,
	} {
		if got, _ := libvirtEventState(ev); got != want {
			t.Errorf("event %d: %q, want %q", ev, got, want)
		}
	}
}

func TestLibvirtLeaseAddrs(t *testing.T) {
	got := libvirtLeaseAddrs([]golibvirt.DomainInterface{
		{Name: "vnet0", Addrs: []golibvirt.DomainIPAddr{{Type: 1, Addr: "fd00::5", Prefix: 64}, {Type: 0, Addr: "192.168.122.5", Prefix: 24}}},
		{Name: "vnet1", Addrs: []golibvirt.DomainIPAddr{{Type: 0, Addr: "10.0.0.7", Prefix: 24}}},
	})
	if strings.Join(got, ",") != "192.168.122.5,10.0.0.7,fd00::5" {
		t.Errorf("%v", got)
	}
}
