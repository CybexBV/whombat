package hardware

// Fixture sysfs and procfs trees, laid out as the kernel lays them out: devices under /sys/devices with their
// attributes, and the bus and class directories as relative links to them, so the collector resolves them as on a
// machine.

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Sentinels the report must never carry (MG-110): what a serial-number or MAC address attribute holds.
const (
	sentinelSerial = "SERIAL-SENTINEL-0042"
	sentinelMAC    = "aa:bb:cc:dd:ee:ff"
)

type fx struct {
	t         *testing.T
	sys, proc string
	rfkills   int
}

func newFx(t *testing.T) *fx {
	t.Helper()
	root := t.TempDir()
	f := &fx{t: t, sys: filepath.Join(root, "sys"), proc: filepath.Join(root, "proc")}
	f.dir("devices/virtual/net/lo")
	f.link("class/net/lo", "devices/virtual/net/lo")
	f.file("devices/virtual/net/lo/type", "772")
	return f
}

func (f *fx) dir(rel string) {
	f.t.Helper()
	if err := os.MkdirAll(filepath.Join(f.sys, rel), 0o755); err != nil {
		f.t.Fatal(err)
	}
}

func (f *fx) file(rel, content string) {
	f.t.Helper()
	p := filepath.Join(f.sys, rel)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		f.t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(content+"\n"), 0o644); err != nil {
		f.t.Fatal(err)
	}
}

func (f *fx) procFile(rel, content string) {
	f.t.Helper()
	p := filepath.Join(f.proc, rel)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		f.t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		f.t.Fatal(err)
	}
}

// link makes sys/rel a relative symlink to sys/target.
func (f *fx) link(rel, target string) {
	f.t.Helper()
	p := filepath.Join(f.sys, rel)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		f.t.Fatal(err)
	}
	r, err := filepath.Rel(filepath.Dir(p), filepath.Join(f.sys, target))
	if err != nil {
		f.t.Fatal(err)
	}
	if err := os.Symlink(r, p); err != nil {
		f.t.Fatal(err)
	}
}

// bind binds the device at dev to a driver of bus.
func (f *fx) bind(dev, bus, driver string) {
	if driver == "" {
		return
	}
	f.dir("bus/" + bus + "/drivers/" + driver)
	f.link(dev+"/driver", "bus/"+bus+"/drivers/"+driver)
}

// pci adds a PCI function under parent (a devices/pci… path) and returns its path.
func (f *fx) pci(parent, addr, class, vendor, device, driver string) string {
	p := parent + "/" + addr
	f.file(p+"/class", "0x"+class)
	f.file(p+"/vendor", "0x"+vendor)
	f.file(p+"/device", "0x"+device)
	f.file(p+"/subsystem_vendor", "0x1043")
	f.link(p+"/subsystem", "bus/pci")
	f.bind(p, "pci", driver)
	f.link("bus/pci/devices/"+addr, p)
	return p
}

type usbIf struct{ class, driver string }

// usb adds a USB device (and its interfaces name:1.0, :1.1, …) under parent and returns its path.
func (f *fx) usb(parent, name, vendor, product, maker, prod string, ifs ...usbIf) string {
	p := parent + "/" + name
	f.file(p+"/idVendor", vendor)
	f.file(p+"/idProduct", product)
	f.file(p+"/bDeviceClass", "00")
	f.file(p+"/serial", sentinelSerial)
	if maker != "" {
		f.file(p+"/manufacturer", maker)
	}
	if prod != "" {
		f.file(p+"/product", prod)
	}
	f.bind(p, "usb", "usb")
	f.link("bus/usb/devices/"+name, p)
	for i, it := range ifs {
		in := fmt.Sprintf("%s:1.%d", name, i)
		f.file(p+"/"+in+"/bInterfaceClass", it.class)
		f.bind(p+"/"+in, "usb", it.driver)
		f.link("bus/usb/devices/"+in, p+"/"+in)
	}
	return p
}

// rootHub adds a controller's root hub (usbN, Linux Foundation 1d6b, a hub: never listed) and returns its path.
func (f *fx) rootHub(controller string, n int) string {
	p := fmt.Sprintf("%s/usb%d", controller, n)
	f.file(p+"/idVendor", "1d6b")
	f.file(p+"/idProduct", "0003")
	f.file(p+"/bDeviceClass", "09")
	f.link(fmt.Sprintf("bus/usb/devices/usb%d", n), p)
	return p
}

// netIf adds an Ethernet-type interface on dev (wifi: with wireless/ and its phy).
func (f *fx) netIf(dev, name string, wifi bool, carrier, speed string) {
	p := dev + "/net/" + name
	f.file(p+"/type", "1")
	f.file(p+"/address", sentinelMAC)
	f.file(p+"/carrier", carrier)
	f.file(p+"/speed", speed)
	f.link(p+"/device", dev)
	if wifi {
		f.dir(p + "/wireless")
		phy := dev + "/ieee80211/phy0"
		f.file(phy+"/macaddress", sentinelMAC)
		f.link(p+"/phy80211", phy)
		f.rfkill(phy, "wlan", "0", "0")
	}
	f.link("class/net/"+name, p)
}

// rfkill adds a radio switch under parent (a phy, an adapter, a platform device).
func (f *fx) rfkill(parent, typ, soft, hard string) {
	name := fmt.Sprintf("rfkill%d", f.rfkills)
	f.rfkills++
	p := parent + "/" + name
	f.file(p+"/type", typ)
	f.file(p+"/soft", soft)
	f.file(p+"/hard", hard)
	f.link("class/rfkill/"+name, p)
}

// soundCard adds card n on dev with its /proc/asound/cards lines (pcm lines go in pcm()).
func (f *fx) soundCard(dev string, n int, id, driver, short, long string) {
	p := fmt.Sprintf("%s/sound/card%d", dev, n)
	f.file(p+"/id", id)
	f.file(p+"/number", fmt.Sprint(n))
	f.link(p+"/device", dev)
	f.link(fmt.Sprintf("class/sound/card%d", n), p)
	cards := ""
	if b, err := os.ReadFile(filepath.Join(f.proc, "asound", "cards")); err == nil {
		cards = string(b)
	}
	f.procFile("asound/cards", cards+fmt.Sprintf("%2d [%-15s]: %s - %s\n                      %s\n", n, id, driver, short, long))
}

func (f *fx) pcm(lines ...string) { f.procFile("asound/pcm", strings.Join(lines, "\n")+"\n") }

// drm adds graphics card n on dev with connectors (name → connected).
func (f *fx) drm(dev string, n int, connectors map[string]bool) {
	p := fmt.Sprintf("%s/drm/card%d", dev, n)
	f.link(p+"/device", dev)
	f.link(fmt.Sprintf("class/drm/card%d", n), p)
	f.dir(fmt.Sprintf("%s/drm/renderD%d", dev, 128+n))
	f.link(fmt.Sprintf("class/drm/renderD%d", 128+n), fmt.Sprintf("%s/drm/renderD%d", dev, 128+n))
	for c, on := range connectors {
		cp := fmt.Sprintf("%s/card%d-%s", p, n, c)
		st := "disconnected"
		if on {
			st = "connected"
		}
		f.file(cp+"/status", st)
		f.file(cp+"/edid", sentinelSerial)
		f.link(fmt.Sprintf("class/drm/card%d-%s", n, c), cp)
	}
}

// nvme adds an NVMe controller's namespace on a PCI function.
func (f *fx) nvme(dev, model string, sectors int64) {
	ctrl := dev + "/nvme/nvme0"
	f.file(ctrl+"/model", model)
	f.file(ctrl+"/serial", sentinelSerial)
	f.link(ctrl+"/device", dev)
	ns := ctrl + "/nvme0n1"
	f.file(ns+"/size", fmt.Sprint(sectors))
	f.file(ns+"/removable", "0")
	f.file(ns+"/wwid", "eui."+sentinelSerial)
	f.link(ns+"/device", ctrl)
	f.link("block/nvme0n1", ns)
}

// virtioBlock adds a virtio disk (vda) on a virtio-pci function.
func (f *fx) virtioBlock(dev string, n int, sectors int64) {
	v := fmt.Sprintf("%s/virtio%d", dev, n)
	f.file(v+"/vendor", "0x1af4")
	f.file(v+"/device", "0x0002")
	f.link(v+"/subsystem", "bus/virtio")
	f.bind(v, "virtio", "virtio_blk")
	b := v + "/block/vda"
	f.file(b+"/size", fmt.Sprint(sectors))
	f.file(b+"/removable", "0")
	f.link(b+"/device", v)
	f.link("block/vda", b)
}

// virtual block devices (loop, zram) have no device.
func (f *fx) virtualBlock(name string) {
	p := "devices/virtual/block/" + name
	f.file(p+"/size", "8388608")
	f.file(p+"/removable", "0")
	f.link("block/"+name, p)
}

// hci adds Bluetooth adapter hciN on dev (a USB interface) with its switch.
func (f *fx) hci(dev string, n int, soft string) {
	p := fmt.Sprintf("%s/bluetooth/hci%d", dev, n)
	f.link(p+"/device", dev)
	f.link(fmt.Sprintf("class/bluetooth/hci%d", n), p)
	f.rfkill(p, "bluetooth", soft, "0")
}

func (f *fx) video(dev string, n int) {
	p := fmt.Sprintf("%s/video4linux/video%d", dev, n)
	f.file(p+"/name", "camera")
	f.link(p+"/device", dev)
	f.link(fmt.Sprintf("class/video4linux/video%d", n), p)
}

func (f *fx) battery(name, model, maker string) {
	acpi := "devices/LNXSYSTM:00/LNXSYBUS:00/PNP0C0A:00"
	f.bind(acpi, "acpi", "battery")
	p := acpi + "/power_supply/" + name
	f.file(p+"/type", "Battery")
	f.file(p+"/present", "1")
	f.file(p+"/model_name", model)
	f.file(p+"/manufacturer", maker)
	f.file(p+"/serial_number", sentinelSerial)
	f.link(p+"/device", acpi)
	f.link("class/power_supply/"+name, p)
}

func (f *fx) mains() {
	p := "devices/LNXSYSTM:00/LNXSYBUS:00/ACPI0003:00/power_supply/ACAD"
	f.file(p+"/type", "Mains")
	f.file(p+"/online", "1")
	f.link("class/power_supply/ACAD", p)
}

// i2cHID adds an I²C HID device (a touch screen).
func (f *fx) i2cHID(parent, id, name, driver string) {
	p := parent + "/" + id
	f.file(p+"/uevent", "DRIVER="+driver+"\nHID_ID=0018:0000"+id[5:9]+":0000"+id[10:14]+"\nHID_NAME="+name+"\nHID_UNIQ=")
	f.bind(p, "hid", driver)
	f.link("bus/hid/devices/"+id, p)
}

func (f *fx) dmi(attrs map[string]string) {
	for k, v := range attrs {
		f.file("class/dmi/id/"+k, v)
	}
	f.file("class/dmi/id/product_serial", sentinelSerial)
	f.file("class/dmi/id/board_serial", sentinelSerial)
	f.file("class/dmi/id/product_uuid", sentinelSerial)
}

// cpus writes /proc/cpuinfo: packages × cores × threads processors.
func (f *fx) cpus(model string, packages, cores, threads int, flags string) {
	var b strings.Builder
	n := 0
	for t := 0; t < threads; t++ {
		for p := 0; p < packages; p++ {
			for c := 0; c < cores; c++ {
				fmt.Fprintf(&b, "processor\t: %d\nvendor_id\t: x\nmodel name\t: %s\nphysical id\t: %d\ncore id\t\t: %d\nflags\t\t: %s\n\n",
					n, model, p, c, flags)
				n++
			}
		}
	}
	f.procFile("cpuinfo", b.String())
}

func (f *fx) basics(kernel string, memKB int64, clocksources string) {
	f.procFile("sys/kernel/osrelease", kernel+"\n")
	f.procFile("meminfo", fmt.Sprintf("MemTotal:       %d kB\nMemFree:         1000000 kB\nMemAvailable:    2000000 kB\n", memKB))
	f.file("devices/system/clocksource/clocksource0/available_clocksource", clocksources)
}
