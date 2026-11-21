package hardware

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/CybexBV/whombat/contracts/go/local"
	"github.com/CybexBV/whombat/contracts/go/protocol"
)

const pciRoot = "devices/pci0000:00"

// z13 is a machine modelled on the ROG Flow Z13 (GZ302EA) as its drivers show it: MediaTek MT7925 Wi-Fi on PCIe and
// its Bluetooth on USB, the Radeon 8060S with its HDMI audio, the HD-Audio codec, the audio coprocessor's microphone
// card (acp-pdm-mic, one capture device), an NVMe disk, the camera and keyboard cover on USB, an I²C touch screen, the
// battery, and a USB 2.5G Ethernet adapter (r8152), which is how it is online today.
func z13(t *testing.T) *fx {
	f := newFx(t)
	f.dmi(map[string]string{"sys_vendor": "ASUSTeK COMPUTER INC.", "product_name": "ROG Flow Z13 GZ302EA_GZ302EA",
		"product_family": "ROG Flow Z13", "bios_version": "GZ302EA.308", "board_vendor": "ASUSTeK COMPUTER INC.",
		"bios_vendor": "American Megatrends International, LLC."})
	f.cpus("AMD RYZEN AI MAX+ 395 w/ Radeon 8060S", 1, 16, 2, "fpu vme sse sse2 svm")
	f.basics("6.18.53", 32063744, "tsc hpet acpi_pm")
	f.pci(pciRoot, "0000:00:00.0", "060000", "1022", "14e8", "")
	gpp := f.pci(pciRoot, "0000:00:02.1", "060400", "1022", "14ee", "pcieport")
	wifi := f.pci(gpp, "0000:c3:00.0", "028000", "14c3", "7925", "mt7925e")
	f.netIf(wifi, "wlp195s0", true, "0", "-1")
	nvmeBridge := f.pci(pciRoot, "0000:00:02.4", "060400", "1022", "14ee", "pcieport")
	nvme := f.pci(nvmeBridge, "0000:c2:00.0", "010802", "144d", "a80c", "nvme")
	f.nvme(nvme, "SAMSUNG MZVL81T0HFLB-00BLL", 2000409264)
	b8 := f.pci(pciRoot, "0000:00:08.1", "060400", "1022", "14ee", "pcieport")
	gpu := f.pci(b8, "0000:c4:00.0", "030000", "1002", "1586", "amdgpu")
	f.drm(gpu, 1, map[string]bool{"eDP-1": true})
	hdmi := f.pci(b8, "0000:c4:00.1", "040300", "1002", "1640", "snd_hda_intel")
	f.soundCard(hdmi, 0, "Generic", "HDA-Intel", "HD-Audio Generic", "HD-Audio Generic at 0xdc4c8000 irq 113")
	xhci := f.pci(b8, "0000:c4:00.4", "0c0330", "1022", "1587", "xhci_hcd")
	hub := f.rootHub(xhci, 5)
	eth := f.usb(hub, "5-1", "0bda", "8156", "Realtek", "USB 10/100/1G/2.5G LAN", usbIf{"ff", "r8152"})
	f.netIf(eth+"/5-1:1.0", "enp196s0f4u1", false, "1", "2500")
	acp := f.pci(b8, "0000:c4:00.5", "048000", "1022", "15e2", "snd_acp_pci")
	mach := acp + "/acp_pdm_mach.0"
	f.bind(mach, "platform", "acp_pdm_mach")
	f.soundCard(mach, 2, "acppdmmach", "acp-pdm-mach", "acp-pdm-mic", "ASUSTeK COMPUTER INC.-ROG Flow Z13 GZ302EA_GZ302EA-1.0")
	codec := f.pci(b8, "0000:c4:00.6", "040300", "1022", "15e3", "snd_hda_intel")
	f.soundCard(codec, 1, "Generic_1", "HDA-Intel", "HD-Audio Generic", "HD-Audio Generic at 0xdc4c0000 irq 114")
	f.pcm("00-03: HDMI 0 : HDMI 0 : playback 1", "00-07: HDMI 1 : HDMI 1 : playback 1",
		"00-08: HDMI 2 : HDMI 2 : playback 1", "00-09: HDMI 3 : HDMI 3 : playback 1",
		"01-00: ALC294 Analog : ALC294 Analog : playback 1 : capture 1",
		"02-00: acp-pdm-mic-dai-codec dmic-hifi-0 :  : capture 1")
	b8b := f.pci(pciRoot, "0000:00:08.3", "060400", "1022", "14ee", "pcieport")
	xhci2 := f.pci(b8b, "0000:c5:00.3", "0c0330", "1022", "1587", "xhci_hcd")
	hub2 := f.rootHub(xhci2, 3)
	cam := f.usb(hub2, "3-3", "13d3", "5463", "Azurewave", "USB2.0 FHD UVC WebCam", usbIf{"0e", "uvcvideo"}, usbIf{"0e", "uvcvideo"})
	f.video(cam+"/3-3:1.0", 0)
	f.video(cam+"/3-3:1.0", 1)
	f.usb(hub2, "3-4", "0b05", "1a30", "ASUSTeK Computer Inc.", "N-KEY Device", usbIf{"03", "usbhid"}, usbIf{"03", "usbhid"})
	bt := f.usb(hub2, "3-5", "13d3", "3608", "MediaTek Inc.", "Wireless_Device", usbIf{"e0", "btusb"}, usbIf{"e0", "btusb"})
	f.hci(bt+"/3-5:1.0", 0, "0")
	f.pci(pciRoot, "0000:00:14.0", "0c0500", "1022", "790b", "piix4_smbus")
	f.pci(b8b, "0000:c5:00.1", "118000", "1022", "17f0", "amdxdna")
	f.battery("BAT0", "GZ302EA", "ASUSTeK")
	f.mains()
	f.i2cHID("devices/platform/AMDI0010:01/i2c-1/i2c-ELAN9008:00", "0018:04F3:4229.0001", "ELAN9008:00 04F3:4229", "hid-multitouch")
	f.virtualBlock("zram0")
	f.virtualBlock("loop0")
	return f
}

// vm is a Proxmox-like QEMU/KVM guest: q35 with std VGA (bochs), virtio network and disk, an emulated HD-Audio card,
// the balloon, AHCI without disks, SMBus, and the USB tablet.
func vm(t *testing.T, kvm bool) *fx {
	f := newFx(t)
	f.dmi(map[string]string{"sys_vendor": "QEMU", "product_name": "Standard PC (Q35 + ICH9, 2009)",
		"product_version": "pc-q35-9.2", "bios_version": "rel-1.16.3-0-ga6ed6b701f0a-prebuilt.qemu.org", "bios_vendor": "SeaBIOS",
		"product_family": "To be filled by O.E.M."})
	f.cpus("QEMU Virtual CPU version 2.5+", 4, 1, 1, "fpu sse sse2 hypervisor")
	clocks := "tsc acpi_pm"
	if kvm {
		clocks = "kvm-clock tsc acpi_pm"
	}
	f.basics("6.18.53", 4024256, clocks)
	f.pci(pciRoot, "0000:00:00.0", "060000", "8086", "29c0", "")
	vga := f.pci(pciRoot, "0000:00:01.0", "030000", "1234", "1111", "bochs-drm")
	f.drm(vga, 0, map[string]bool{"Virtual-1": true})
	netPCI := f.pci(pciRoot, "0000:00:02.0", "020000", "1af4", "1041", "virtio-pci")
	v0 := netPCI + "/virtio0"
	f.link(v0+"/subsystem", "bus/virtio")
	f.bind(v0, "virtio", "virtio_net")
	f.netIf(v0, "enp0s2", false, "1", "-1")
	blk := f.pci(pciRoot, "0000:00:03.0", "010000", "1af4", "1042", "virtio-pci")
	f.virtioBlock(blk, 1, 67108864)
	hda := f.pci(pciRoot, "0000:00:04.0", "040300", "8086", "293e", "snd_hda_intel")
	f.soundCard(hda, 0, "Intel", "HDA-Intel", "HDA Intel", "HDA Intel at 0xfea50000 irq 16")
	f.pcm("00-00: Generic Analog : Generic Analog : playback 1 : capture 1")
	f.pci(pciRoot, "0000:00:05.0", "00ff00", "1af4", "1045", "virtio-pci")
	xhci := f.pci(pciRoot, "0000:00:06.0", "0c0330", "1b36", "000d", "xhci_hcd")
	f.usb(f.rootHub(xhci, 1), "1-1", "0627", "0001", "QEMU", "QEMU USB Tablet", usbIf{"03", "usbhid"})
	f.pci(pciRoot, "0000:00:1f.0", "060100", "8086", "2918", "lpc_ich")
	f.pci(pciRoot, "0000:00:1f.2", "010601", "8086", "2922", "ahci")
	f.pci(pciRoot, "0000:00:1f.3", "0c0500", "8086", "2930", "i801_smbus")
	return f
}

// thinkpad is a laptop whose Intel Wi-Fi 7 card has no driver (a card newer than the kernel), with its Bluetooth
// switched off by its radio switch, a cable on its I219, and SOF audio.
func thinkpad(t *testing.T, wifiDriver string) *fx {
	f := newFx(t)
	f.dmi(map[string]string{"sys_vendor": "LENOVO", "product_name": "21KCCTO1WW", "product_family": "ThinkPad X1 Carbon Gen 12",
		"bios_version": "N3YET62W (1.27 )", "board_vendor": "LENOVO", "bios_vendor": "LENOVO"})
	f.cpus("Intel(R) Core(TM) Ultra 7 155U", 1, 12, 1, "fpu vmx")
	f.basics("6.18.53", 32505856, "tsc hpet acpi_pm")
	f.pci(pciRoot, "0000:00:14.3", "028000", "8086", "272b", wifiDriver)
	eth := f.pci(pciRoot, "0000:00:1f.6", "020000", "8086", "550a", "e1000e")
	f.netIf(eth, "enp0s31f6", false, "1", "1000")
	gpu := f.pci(pciRoot, "0000:00:02.0", "030000", "8086", "7d45", "i915")
	f.drm(gpu, 1, map[string]bool{"eDP-1": true, "DP-1": false, "Writeback-1": false})
	sof := f.pci(pciRoot, "0000:00:1f.3", "040380", "8086", "7e28", "sof-audio-pci-intel-mtl")
	f.soundCard(sof, 0, "sofhdadsp", "sof-hda-dsp", "sof-hda-dsp", "LENOVO-21KCCTO1WW-ThinkPadX1CarbonGen12")
	f.pcm("00-00: HDA Analog (*) :  : playback 1 : capture 1", "00-03: HDMI1 (*) :  : playback 1",
		"00-06: DMIC (*) :  : capture 1", "00-07: DMIC16kHz (*) :  : capture 1")
	xhci := f.pci(pciRoot, "0000:00:14.0", "0c0330", "8086", "7e7d", "xhci_hcd")
	hub := f.rootHub(xhci, 3)
	bt := f.usb(hub, "3-10", "8087", "0036", "", "", usbIf{"e0", "btusb"}, usbIf{"e0", "btusb"})
	f.hci(bt+"/3-10:1.0", 0, "1")
	f.usb(hub, "3-2", "0bda", "b812", "Realtek", "802.11ac NIC", usbIf{"ff", ""})
	nvmeBridge := f.pci(pciRoot, "0000:00:06.0", "060400", "8086", "7e4d", "pcieport")
	f.nvme(f.pci(nvmeBridge, "0000:04:00.0", "010802", "144d", "a80c", "nvme"), "SAMSUNG MZAL81T0HDLB-00BL2", 2000409264)
	f.battery("BAT0", "5B10W51867", "SMP")
	return f
}

func collectFx(t *testing.T, f *fx, lines ...string) *protocol.HostHardware {
	t.Helper()
	h := collect(f.sys, f.proc, "testdata", lines)
	h.CollectedAt = "2026-10-20T12:00:00Z"
	validHardware(t, h)
	return h
}

// validHardware checks h as the runtime gets it: the contract's schema (local.ParseHostHardwareResponse), and nothing
// of a serial number or a MAC address anywhere.
func validHardware(t *testing.T, h *protocol.HostHardware) {
	t.Helper()
	b, err := json.Marshal(local.HostHardwareResponse{V: 1, Hardware: *h})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := local.ParseHostHardwareResponse(b); err != nil {
		t.Fatalf("not the contract's: %v\n%s", err, b)
	}
	if s := string(b); strings.Contains(s, sentinelSerial) || strings.Contains(s, sentinelMAC) {
		t.Fatalf("a serial number or a MAC address in the report: %s", s)
	}
}

func find(t *testing.T, h *protocol.HostHardware, kind protocol.HardwareKind, name string) protocol.HardwareDevice {
	t.Helper()
	for _, d := range h.Devices {
		if d.Kind == kind && strings.Contains(d.Name, name) {
			return d
		}
	}
	t.Fatalf("no %s %q in %s", kind, name, dump(h))
	return protocol.HardwareDevice{}
}

func count(h *protocol.HostHardware, kind protocol.HardwareKind) int {
	n := 0
	for _, d := range h.Devices {
		if d.Kind == kind {
			n++
		}
	}
	return n
}

func dump(h *protocol.HostHardware) string {
	b, _ := json.MarshalIndent(h.Devices, "", " ")
	return string(b)
}

func s(p *string) string {
	if p == nil {
		return "<nil>"
	}
	return *p
}

func n(p *int64) int64 {
	if p == nil {
		return -1
	}
	return *p
}

func TestTheZ13(t *testing.T) {
	// amdgpu asks for a firmware it can do without (the camera's ISP): the graphics card works, so it is fine.
	h := collectFx(t, z13(t), "amdgpu 0000:c4:00.0: Direct firmware load for amdgpu/isp_4_1_1.bin failed with error -2")
	if h.Kernel != "6.18.53" || h.MemoryBytes != 32063744*1024 || h.Cpu.Threads != 32 || h.Cpu.Cores != 16 ||
		h.Cpu.Model != "AMD RYZEN AI MAX+ 395 w/ Radeon 8060S" {
		t.Fatalf("%+v %+v", h.Kernel, h.Cpu)
	}
	m := h.Machine
	if s(m.Vendor) != "ASUSTeK COMPUTER INC." || s(m.Model) != "ROG Flow Z13 GZ302EA_GZ302EA" || s(m.Family) != "ROG Flow Z13" ||
		s(m.Firmware) != "GZ302EA.308" || m.Virtual || m.Hypervisor != nil {
		t.Fatalf("%+v", m)
	}

	w := find(t, h, protocol.HardwareKindWifi, "MT7925")
	if s(w.ID) != "14c3:7925" || s(w.Driver) != "mt7925e" || s(w.Vendor) != "MEDIATEK Corp." || w.Bus != "pci" ||
		s(w.Interface) != "wlp195s0" || *w.Link != "down" || w.SpeedMbps != nil || w.Status != "ok" {
		t.Fatalf("%+v", w)
	}
	e := find(t, h, protocol.HardwareKindWired, "2.5G LAN")
	if s(e.ID) != "0bda:8156" || s(e.Driver) != "r8152" || e.Bus != "usb" || s(e.Interface) != "enp196s0f4u1" ||
		*e.Link != "up" || n(e.SpeedMbps) != 2500 || e.Status != "ok" {
		t.Fatalf("%+v", e)
	}
	b := find(t, h, protocol.HardwareKindBluetooth, "Wireless_Device")
	if s(b.ID) != "13d3:3608" || s(b.Driver) != "btusb" || b.Bus != "usb" || b.Status != "ok" {
		t.Fatalf("%+v", b)
	}

	// Three sound cards; the microphone is the coprocessor's card of its own.
	if c := count(h, protocol.HardwareKindSound); c != 3 {
		t.Fatalf("%d sound cards: %s", c, dump(h))
	}
	mic := find(t, h, protocol.HardwareKindSound, "acp-pdm-mic")
	if s(mic.Card) != "acppdmmach" || n(mic.Capture) != 1 || n(mic.Playback) != 0 || s(mic.ID) != "1022:15e2" ||
		s(mic.Driver) != "acp_pdm_mach" || mic.Bus != "pci" || s(mic.Vendor) != "Advanced Micro Devices, Inc. [AMD]" {
		t.Fatalf("%+v", mic)
	}
	for _, d := range h.Devices {
		if d.Kind == protocol.HardwareKindSound && s(d.Card) == "Generic" && (n(d.Playback) != 4 || n(d.Capture) != 0 || s(d.ID) != "1002:1640") {
			t.Fatalf("HDMI: %+v", d)
		}
		if d.Kind == protocol.HardwareKindSound && s(d.Card) == "Generic_1" && (n(d.Playback) != 1 || n(d.Capture) != 1 || s(d.Driver) != "snd_hda_intel") {
			t.Fatalf("codec: %+v", d)
		}
	}

	g := find(t, h, protocol.HardwareKindGraphics, "Strix Halo")
	if s(g.ID) != "1002:1586" || s(g.Driver) != "amdgpu" || g.Status != "ok" {
		t.Fatalf("%+v", g)
	}
	if d := find(t, h, protocol.HardwareKindDisplay, "eDP-1"); d.Connected == nil || !*d.Connected || s(d.Driver) != "amdgpu" {
		t.Fatalf("%+v", d)
	}
	disk := find(t, h, protocol.HardwareKindStorage, "SAMSUNG MZVL81T0HFLB")
	if n(disk.SizeBytes) != 2000409264*512 || s(disk.Driver) != "nvme" || s(disk.ID) != "144d:a80c" || count(h, protocol.HardwareKindStorage) != 1 {
		t.Fatalf("%+v %s", disk, dump(h))
	}
	if c := find(t, h, protocol.HardwareKindCamera, "UVC WebCam"); s(c.Driver) != "uvcvideo" || s(c.ID) != "13d3:5463" || s(c.Vendor) != "IMC Networks" {
		t.Fatalf("%+v", c)
	}
	if k := find(t, h, protocol.HardwareKindInput, "N-KEY Device"); s(k.Driver) != "usbhid" || s(k.Vendor) != "ASUSTek Computer, Inc." {
		t.Fatalf("%+v", k)
	}
	if ts := find(t, h, protocol.HardwareKindInput, "ELAN9008"); s(ts.ID) != "04f3:4229" || s(ts.Driver) != "hid-multitouch" || ts.Bus != "platform" ||
		s(ts.Vendor) != "Elan Microelectronics Corp." {
		t.Fatalf("%+v", ts)
	}
	if bat := find(t, h, protocol.HardwareKindBattery, "GZ302EA"); s(bat.Vendor) != "ASUSTeK" || s(bat.Driver) != "battery" || count(h, protocol.HardwareKindBattery) != 1 {
		t.Fatalf("%+v", bat)
	}
	// The USB controllers; no bridges, no root hubs, no virtual disks; the NPU and SMBus with the rest.
	if count(h, protocol.HardwareKindUsb) != 2 || count(h, protocol.HardwareKindOther) != 2 {
		t.Fatalf("%s", dump(h))
	}
	for _, d := range h.Devices {
		if strings.Contains(d.Name, "Bridge") || strings.Contains(d.Name, "Root Complex") || strings.Contains(d.Name, "root hub") ||
			d.Status != "ok" {
			t.Fatalf("%+v", d)
		}
	}
	// Kinds in their order: network first, the rest last.
	if h.Devices[0].Kind != protocol.HardwareKindWired || h.Devices[len(h.Devices)-1].Kind != protocol.HardwareKindOther {
		t.Fatalf("%s", dump(h))
	}
	if len(h.Log) != 1 || !strings.HasPrefix(h.Log[0], "amdgpu 0000:c4:00.0:") {
		t.Fatalf("%q", h.Log)
	}
}

func TestAVirtualMachine(t *testing.T) {
	h := collectFx(t, vm(t, true))
	m := h.Machine
	if !m.Virtual || s(m.Hypervisor) != "kvm" || s(m.Vendor) != "QEMU" || s(m.Model) != "Standard PC (Q35 + ICH9, 2009)" || m.Family != nil {
		t.Fatalf("%+v", m)
	}
	if h.Cpu.Cores != 4 || h.Cpu.Threads != 4 {
		t.Fatalf("%+v", h.Cpu)
	}
	w := find(t, h, protocol.HardwareKindWired, "Virtio 1.0 network device")
	if s(w.ID) != "1af4:1041" || s(w.Driver) != "virtio_net" || w.Bus != "pci" || *w.Link != "up" || w.SpeedMbps != nil {
		t.Fatalf("%+v", w)
	}
	d := find(t, h, protocol.HardwareKindStorage, "Virtio 1.0 block device")
	if s(d.Driver) != "virtio_blk" || n(d.SizeBytes) != 32<<30 || s(d.Vendor) != "Red Hat, Inc." {
		t.Fatalf("%+v", d)
	}
	if a := find(t, h, protocol.HardwareKindStorage, "SATA Controller"); s(a.Driver) != "ahci" || a.SizeBytes != nil || a.Status != "ok" {
		t.Fatalf("%+v", a)
	}
	if c := find(t, h, protocol.HardwareKindSound, "HDA Intel"); n(c.Capture) != 1 || n(c.Playback) != 1 || s(c.ID) != "8086:293e" {
		t.Fatalf("%+v", c)
	}
	if g := find(t, h, protocol.HardwareKindGraphics, "QEMU Virtual Video Controller"); s(g.Driver) != "bochs-drm" {
		t.Fatalf("%+v", g)
	}
	find(t, h, protocol.HardwareKindDisplay, "Virtual-1")
	find(t, h, protocol.HardwareKindInput, "QEMU Tablet")
	// The balloon is with the rest; the bridges and the LPC controller aren't listed.
	find(t, h, protocol.HardwareKindOther, "Virtio 1.0 balloon")
	for _, d := range h.Devices {
		if strings.Contains(d.Name, "LPC") || strings.Contains(d.Name, "DRAM") {
			t.Fatalf("%+v", d)
		}
	}
	if count(h, protocol.HardwareKindWifi) != 0 || count(h, protocol.HardwareKindBattery) != 0 || count(h, protocol.HardwareKindBluetooth) != 0 {
		t.Fatalf("%s", dump(h))
	}

	// QEMU without KVM (TCG): systemd's “qemu”.
	if h := collectFx(t, vm(t, false)); s(h.Machine.Hypervisor) != "qemu" || !h.Machine.Virtual {
		t.Fatalf("%+v", h.Machine)
	}
}

func TestAWifiCardWithoutADriver(t *testing.T) {
	h := collectFx(t, thinkpad(t, ""))
	w := find(t, h, protocol.HardwareKindWifi, "Wi-Fi 7(802.11be)")
	if w.Status != "no_driver" || w.Driver != nil || s(w.ID) != "8086:272b" || s(w.Vendor) != "Intel Corporation" || w.Interface != nil || w.Bus != "pci" {
		t.Fatalf("%+v", w)
	}
	// A USB Wi-Fi adapter without its driver says what it is only in its database name.
	u := find(t, h, protocol.HardwareKindWifi, "RTL88x2bu")
	if u.Status != "no_driver" || u.Bus != "usb" || u.Driver != nil {
		t.Fatalf("%+v", u)
	}
	if b := find(t, h, protocol.HardwareKindBluetooth, "BE200"); b.Status != "disabled" || s(b.Driver) != "btusb" {
		t.Fatalf("%+v", b)
	}
	if e := find(t, h, protocol.HardwareKindWired, "I219-LM"); e.Status != "ok" || n(e.SpeedMbps) != 1000 || s(e.Driver) != "e1000e" {
		t.Fatalf("%+v", e)
	}
	mic := find(t, h, protocol.HardwareKindSound, "sof-hda-dsp")
	if n(mic.Capture) != 3 || n(mic.Playback) != 2 || s(mic.Driver) != "sof-audio-pci-intel-mtl" {
		t.Fatalf("%+v", mic)
	}
	// Two screens' connectors (the writeback one is none); the second isn't connected.
	if count(h, protocol.HardwareKindDisplay) != 2 {
		t.Fatalf("%s", dump(h))
	}
	if d := find(t, h, protocol.HardwareKindDisplay, "DP-1"); d.Name == "eDP-1" || *d.Connected {
		t.Fatalf("%+v", d)
	}
	// Problems: the two Wi-Fi adapters without a driver and the switched-off Bluetooth, nothing else.
	var problems []string
	for _, d := range h.Devices {
		if d.Status != "ok" {
			problems = append(problems, string(d.Kind)+":"+string(d.Status))
		}
	}
	if strings.Join(problems, " ") != "wifi:no_driver wifi:no_driver bluetooth:disabled" {
		t.Fatalf("%q", problems)
	}
}

func TestMissingFirmware(t *testing.T) {
	// iwlwifi binds but finds no firmware it can use: no interface. The Bluetooth adapter's firmware is missing too
	// (it is registered all the same), and that says more than its switch.
	h := collectFx(t, thinkpad(t, "iwlwifi"),
		"iwlwifi 0000:00:14.3: Direct firmware load for iwlwifi-gl-c0-fm-c0-98.ucode failed with error -2",
		"iwlwifi 0000:00:14.3: no suitable firmware found!",
		"bluetooth hci0: Direct firmware load for intel/ibt-0190-0291-iml.sfi failed with error -2",
		"e1000e 0000:00:1f.6: Direct firmware load for optional.bin failed with error -2")
	if w := find(t, h, protocol.HardwareKindWifi, "Wi-Fi 7"); w.Status != "no_firmware" || s(w.Driver) != "iwlwifi" {
		t.Fatalf("%+v", w)
	}
	if b := find(t, h, protocol.HardwareKindBluetooth, "BE200"); b.Status != "no_firmware" {
		t.Fatalf("%+v", b)
	}
	// The cable's card works (it has its interface): a firmware it asked for is no problem.
	if e := find(t, h, protocol.HardwareKindWired, "I219"); e.Status != "ok" {
		t.Fatalf("%+v", e)
	}
	if len(h.Log) != 4 {
		t.Fatalf("%q", h.Log)
	}
}

func TestStatusRules(t *testing.T) {
	// A graphics chip whose driver didn't bind because its firmware is missing (amdgpu fails its probe).
	f := newFx(t)
	f.basics("6.18.53", 1024, "")
	f.pci(pciRoot, "0000:c4:00.0", "030000", "1002", "1586", "")
	f.pci(pciRoot, "0000:c4:00.2", "108000", "1022", "1649", "") // the security processor: no driver needed
	h := collectFx(t, f, "amdgpu 0000:c4:00.0: Direct firmware load for amdgpu/psp_14_0_4_toc.bin failed with error -2",
		"amdgpu 0000:c4:00.0: probe with driver amdgpu failed with error -2")
	if g := find(t, h, protocol.HardwareKindGraphics, "Strix Halo"); g.Status != "no_firmware" || g.Driver != nil {
		t.Fatalf("%+v", g)
	}
	if o := find(t, h, protocol.HardwareKindOther, "Encryption controller"); o.Status != "ok" {
		t.Fatalf("%+v", o)
	}
	// Without the line it has no driver.
	if g := find(t, collectFx(t, f), protocol.HardwareKindGraphics, "Strix Halo"); g.Status != "no_driver" {
		t.Fatalf("%+v", g)
	}

	// The laptop's own wireless switch blocks every Wi-Fi card.
	z := z13(t)
	z.rfkill("devices/platform/asus-nb-wmi", "wlan", "1", "0")
	if w := find(t, collectFx(t, z), protocol.HardwareKindWifi, "MT7925"); w.Status != "disabled" {
		t.Fatalf("%+v", w)
	}
}

func TestNoHwdata(t *testing.T) {
	// A build without the database: PCI devices by their class, USB devices by their own strings.
	f := thinkpad(t, "")
	h := collect(f.sys, f.proc, "", nil)
	h.CollectedAt = "2026-10-20T12:00:00Z"
	validHardware(t, h)
	if w := find(t, h, protocol.HardwareKindWifi, "Network controller"); w.Vendor != nil || w.Status != "no_driver" {
		t.Fatalf("%+v", w)
	}
	if u := find(t, h, protocol.HardwareKindWifi, "802.11ac NIC"); s(u.Vendor) != "Realtek" {
		t.Fatalf("%+v", u)
	}
	// An adapter that says nothing about itself: what it is.
	if b := find(t, h, protocol.HardwareKindBluetooth, "Bluetooth"); s(b.ID) != "8087:0036" {
		t.Fatalf("%+v", b)
	}
}

func TestPlaceholdersAndArm(t *testing.T) {
	f := newFx(t)
	f.dmi(map[string]string{"sys_vendor": "To Be Filled By O.E.M.", "product_name": "Default string", "bios_version": "1.0\x1b[2J"})
	f.procFile("cpuinfo", "processor\t: 0\nBogoMIPS\t: 48.00\nFeatures\t: fp asimd\nCPU part\t: 0xd08\n\nprocessor\t: 1\nBogoMIPS\t: 48.00\n\n")
	f.procFile("meminfo", "MemTotal: 999 kB\n")
	h := collectFx(t, f)
	if h.Machine.Vendor != nil || h.Machine.Model != nil || s(h.Machine.Firmware) != "1.0[2J" || h.Machine.Virtual {
		t.Fatalf("%+v", h.Machine)
	}
	if h.Cpu.Model != "" || h.Cpu.Threads != 2 || h.Cpu.Cores != 2 || h.Kernel != "unknown" || h.MemoryBytes != 999*1024 {
		t.Fatalf("%+v %s", h.Cpu, h.Kernel)
	}
	// An empty tree is still a report.
	empty := newFx(t)
	if h := collectFx(t, empty); len(h.Devices) != 0 || h.Cpu.Threads != 1 {
		t.Fatalf("%+v", h)
	}
}

func TestDevicesCapped(t *testing.T) {
	f := newFx(t)
	f.basics("6.18.53", 1024, "")
	for i := 0; i < 300; i++ {
		f.pci(pciRoot, fmt.Sprintf("0000:%02x:%02x.0", 1+i/32, i%32), "118000", "1022", "17f0", "x")
	}
	if h := collectFx(t, f); len(h.Devices) != DevicesMax {
		t.Fatalf("%d", len(h.Devices))
	}
}

func TestCollector(t *testing.T) {
	f := z13(t)
	now := time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)
	calls := 0
	var logErr error
	c := New(Config{Sys: f.sys, Proc: f.proc, Hwdata: "testdata", Now: func() time.Time { return now },
		Log: slog.New(slog.NewTextHandler(io.Discard, nil)),
		KernelLog: func(ctx context.Context) ([]string, error) {
			calls++
			if _, ok := ctx.Deadline(); !ok {
				t.Error("no deadline for the helper")
			}
			return []string{"x 0000:c3:00.0: something failed\x00"}, logErr
		}})
	h, err := c.Collect(context.Background())
	if err != nil || h.CollectedAt != "2026-10-20T12:00:00Z" || len(h.Log) != 1 || h.Log[0] != "x 0000:c3:00.0: something failed" {
		t.Fatalf("%v %+v", err, h)
	}
	validHardware(t, h)
	// Asked again within the cache's time: the same report, no second helper call.
	now = now.Add(5 * time.Second)
	if h2, _ := c.Collect(context.Background()); h2 != h || calls != 1 {
		t.Fatalf("calls %d", calls)
	}
	// Later, with the helper failing: a report without the kernel's lines.
	now, logErr = now.Add(CacheFor), errors.New("helper unavailable")
	h3, err := c.Collect(context.Background())
	if err != nil || calls != 2 || len(h3.Log) != 0 || h3.CollectedAt != "2026-10-20T12:00:15Z" {
		t.Fatalf("%v %d %+v", err, calls, h3.Log)
	}
	// A caller that went away gets no report.
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	now = now.Add(CacheFor)
	if _, err := c.Collect(ctx); err == nil {
		t.Fatal("no error for a cancelled request")
	}
}
