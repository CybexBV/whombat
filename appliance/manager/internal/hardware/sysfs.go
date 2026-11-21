package hardware

// What the machine has, from sysfs and procfs (MG-110, MG-111): the PCI functions and USB devices on its buses, and
// the functions that work from them (network interfaces, sound cards, disks, Bluetooth adapters, graphics cards and
// their connectors, cameras), batteries, I²C input devices and the radio switches. Nothing here reads a serial number
// or a MAC address (`serial`, `address`, `serial_number`, the EDID are never opened).

import (
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/CybexBV/whombat/contracts/go/protocol"
)

// attr reads a small sysfs attribute, trimmed ("" when it is missing or larger than 4 KiB).
func attr(dir, name string) string {
	b, err := os.ReadFile(filepath.Join(dir, name))
	if err != nil || len(b) > 4096 {
		return ""
	}
	return strings.TrimSpace(string(b))
}

func exists(p string) bool {
	_, err := os.Lstat(p)
	return err == nil
}

// real resolves a sysfs link ("" when it doesn't resolve).
func real(p string) string {
	r, err := filepath.EvalSymlinks(p)
	if err != nil {
		return ""
	}
	return r
}

// driverOf is the name of the driver bound to the device at dir ("" when none).
func driverOf(dir string) string {
	if r := real(filepath.Join(dir, "driver")); r != "" {
		return filepath.Base(r)
	}
	return ""
}

// hex4 is a sysfs id ("0x14C3", "14c3") as four lowercase hex digits, or "".
func hex4(s string) string {
	s = strings.ToLower(strings.TrimPrefix(strings.TrimSpace(s), "0x"))
	if len(s) == 0 || len(s) > 4 {
		return ""
	}
	if _, err := strconv.ParseUint(s, 16, 16); err != nil {
		return ""
	}
	return strings.Repeat("0", 4-len(s)) + s
}

// raw is a PCI function or a USB device.
type raw struct {
	path, name     string
	bus            protocol.HardwareBus
	vendor, device string
	// class: PCI, six lowercase hex digits (028000).
	class string
	// driver: PCI, the bound driver; USB, the first bound interface's.
	driver string
	// USB: the interfaces' names (5-1:1.0), classes (ff) and whether any has a driver; the device's own strings.
	ifNames, ifClasses    []string
	manufacturer, product string
	// Functions found below it (MG-111): it is then listed as them, or (graphics, cameras) known to work.
	represented, hasFunction, video bool
}

func readPCI(sys string) []*raw {
	dir := filepath.Join(sys, "bus", "pci", "devices")
	ents, _ := os.ReadDir(dir)
	var out []*raw
	for _, e := range ents {
		p := real(filepath.Join(dir, e.Name()))
		if p == "" {
			continue
		}
		class := strings.ToLower(strings.TrimPrefix(attr(p, "class"), "0x"))
		if len(class) < 6 {
			class = strings.Repeat("0", 6-len(class)) + class
		}
		out = append(out, &raw{path: p, name: e.Name(), bus: protocol.HardwareBusPci, vendor: hex4(attr(p, "vendor")),
			device: hex4(attr(p, "device")), class: class, driver: driverOf(p)})
	}
	return out
}

func readUSB(sys string) []*raw {
	dir := filepath.Join(sys, "bus", "usb", "devices")
	ents, _ := os.ReadDir(dir)
	var out []*raw
	for _, e := range ents {
		n := e.Name()
		// Interfaces (5-1:1.0) belong to their device; root hubs (usb1) are the controller's.
		if strings.Contains(n, ":") || strings.HasPrefix(n, "usb") {
			continue
		}
		p := real(filepath.Join(dir, n))
		if p == "" || strings.EqualFold(attr(p, "bDeviceClass"), "09") {
			continue
		}
		r := &raw{path: p, name: n, bus: protocol.HardwareBusUsb, vendor: hex4(attr(p, "idVendor")),
			device: hex4(attr(p, "idProduct")), manufacturer: attr(p, "manufacturer"), product: attr(p, "product")}
		kids, _ := os.ReadDir(p)
		for _, k := range kids {
			if !strings.HasPrefix(k.Name(), n+":") {
				continue
			}
			ip := filepath.Join(p, k.Name())
			r.ifNames = append(r.ifNames, k.Name())
			r.ifClasses = append(r.ifClasses, strings.ToLower(attr(ip, "bInterfaceClass")))
			if d := driverOf(ip); d != "" && r.driver == "" {
				r.driver = d
			}
		}
		out = append(out, r)
	}
	return out
}

// owners finds the PCI function or USB device a sysfs path sits under (the deepest one).
type owners []*raw

func (o owners) of(path string) *raw {
	var best *raw
	for _, r := range o {
		if (path == r.path || strings.HasPrefix(path, r.path+"/")) && (best == nil || len(r.path) > len(best.path)) {
			best = r
		}
	}
	return best
}

// busOf is the bus of a function's device: its owner's, else virtual (/sys/devices/virtual) or platform.
func busOf(sys, path string, owner *raw) protocol.HardwareBus {
	if owner != nil {
		return owner.bus
	}
	if strings.HasPrefix(path, filepath.Join(sys, "devices", "virtual")+"/") {
		return protocol.HardwareBusVirtual
	}
	return protocol.HardwareBusPlatform
}

// netIf is a network interface on a device (`/sys/class/net/<if>/device`; bridges, veths, tunnels and loopback have
// none and are left out).
type netIf struct {
	name, devPath, driver string
	wifi, up              bool
	speed                 int64 // Mbps, -1 unknown
	rfkill                []string
}

func readNet(sys string) []netIf {
	dir := filepath.Join(sys, "class", "net")
	ents, _ := os.ReadDir(dir)
	var out []netIf
	for _, e := range ents {
		p := filepath.Join(dir, e.Name())
		dev := real(filepath.Join(p, "device"))
		if dev == "" || attr(p, "type") != "1" {
			continue
		}
		n := netIf{name: e.Name(), devPath: dev, driver: driverOf(dev), speed: -1,
			wifi: exists(filepath.Join(p, "wireless")) || exists(filepath.Join(p, "phy80211"))}
		n.up = attr(p, "carrier") == "1"
		if s, err := strconv.ParseInt(attr(p, "speed"), 10, 64); err == nil && n.up && s > 0 && s <= 10_000_000 {
			n.speed = s
		}
		if n.wifi {
			n.rfkill, _ = filepath.Glob(filepath.Join(p, "phy80211", "rfkill*"))
		}
		out = append(out, n)
	}
	return out
}

// soundCard is an ALSA card: /proc/asound/cards for its id, driver and name, /proc/asound/pcm for its PCM devices.
type soundCard struct {
	number                int
	id, driver, shortName string
	devPath, deviceDriver string
	devName               string
	capture, playback     int64
}

var cardLine = regexp.MustCompile(`^\s*(\d+) \[([^\]]*)\]: (.*?) - (.*)$`)

func readSound(sys, proc string) []soundCard {
	b, _ := os.ReadFile(filepath.Join(proc, "asound", "cards"))
	var out []soundCard
	for _, line := range strings.Split(string(b), "\n") {
		m := cardLine.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		n, _ := strconv.Atoi(m[1])
		c := soundCard{number: n, id: strings.TrimSpace(m[2]), driver: strings.TrimSpace(m[3]), shortName: strings.TrimSpace(m[4])}
		if dev := real(filepath.Join(sys, "class", "sound", "card"+m[1], "device")); dev != "" {
			c.devPath, c.deviceDriver, c.devName = dev, driverOf(dev), filepath.Base(dev)
		}
		out = append(out, c)
	}
	// 00-00: ALC294 Analog : ALC294 Analog : playback 1 : capture 1 (only the trailing stream fields count, NX-179).
	pcm, _ := os.ReadFile(filepath.Join(proc, "asound", "pcm"))
	for _, line := range strings.Split(string(pcm), "\n") {
		cardNo, _, ok := strings.Cut(line, "-")
		n, err := strconv.Atoi(cardNo)
		if !ok || err != nil {
			continue
		}
		var play, capt bool
		fields := strings.Split(line, " : ")
		for i := len(fields) - 1; i >= 2; i-- {
			kind, count, ok := strings.Cut(strings.TrimSpace(fields[i]), " ")
			c, err := strconv.Atoi(count)
			if !ok || err != nil || (kind != "capture" && kind != "playback") {
				break
			}
			play = play || (kind == "playback" && c > 0)
			capt = capt || (kind == "capture" && c > 0)
		}
		for i := range out {
			if out[i].number == n {
				if play {
					out[i].playback++
				}
				if capt {
					out[i].capture++
				}
			}
		}
	}
	return out
}

// disk is a non-removable block device with a size (loop, zram, device mapper and other virtual ones have no device).
type disk struct {
	name, devPath, model, vendor string
	size                         int64
}

var mmcPart = regexp.MustCompile(`^mmcblk\d+(boot\d+|rpmb)$`)

func readBlock(sys string) []disk {
	dir := filepath.Join(sys, "block")
	ents, _ := os.ReadDir(dir)
	var out []disk
	for _, e := range ents {
		p := filepath.Join(dir, e.Name())
		dev := real(filepath.Join(p, "device"))
		if dev == "" || attr(p, "removable") == "1" || mmcPart.MatchString(e.Name()) {
			continue
		}
		sectors, err := strconv.ParseInt(attr(p, "size"), 10, 64)
		if err != nil || sectors <= 0 {
			continue
		}
		d := disk{name: e.Name(), devPath: dev, size: sectors * 512, model: attr(dev, "model"), vendor: attr(dev, "vendor")}
		if d.model == "" {
			d.model = attr(dev, "name") // MMC
		}
		// A SCSI disk's vendor string; ATA's placeholder and a virtio device's id (0x1af4) are none.
		if strings.EqualFold(d.vendor, "ATA") || strings.HasPrefix(d.vendor, "0x") {
			d.vendor = ""
		}
		out = append(out, d)
	}
	return out
}

// diskDriver: the driver of a virtio device between the disk and its owner (virtio_blk, virtio_scsi), else the owner's
// (nvme, ahci, uas).
func diskDriver(sys string, d disk, owner *raw) string {
	for p := d.devPath; owner != nil && p != owner.path && strings.HasPrefix(p, owner.path); p = filepath.Dir(p) {
		if s := real(filepath.Join(p, "subsystem")); s != "" && filepath.Base(s) == "virtio" {
			return driverOf(p)
		}
	}
	if owner != nil {
		return owner.driver
	}
	return driverOf(d.devPath)
}

// hci is a Bluetooth adapter.
type hci struct {
	name, devPath, driver string
	rfkill                []string
}

var hciName = regexp.MustCompile(`^hci\d+$`)

func readBluetooth(sys string) []hci {
	dir := filepath.Join(sys, "class", "bluetooth")
	ents, _ := os.ReadDir(dir)
	var out []hci
	for _, e := range ents {
		if !hciName.MatchString(e.Name()) {
			continue
		}
		p := filepath.Join(dir, e.Name())
		dev := real(filepath.Join(p, "device"))
		if dev == "" {
			continue
		}
		h := hci{name: e.Name(), devPath: dev, driver: driverOf(dev)}
		h.rfkill, _ = filepath.Glob(filepath.Join(p, "rfkill*"))
		out = append(out, h)
	}
	return out
}

// drmCard is a graphics card with its connectors (cardN-eDP-1 → eDP-1; writeback connectors are no screens).
type drmCard struct {
	devPath    string
	connectors []connector
}

type connector struct {
	name, path string
	connected  bool
}

var drmCardName = regexp.MustCompile(`^card\d+$`)

func readDRM(sys string) []drmCard {
	dir := filepath.Join(sys, "class", "drm")
	ents, _ := os.ReadDir(dir)
	var out []drmCard
	for _, e := range ents {
		if !drmCardName.MatchString(e.Name()) {
			continue
		}
		dev := real(filepath.Join(dir, e.Name(), "device"))
		if dev == "" {
			continue
		}
		c := drmCard{devPath: dev}
		for _, k := range ents {
			conn, ok := strings.CutPrefix(k.Name(), e.Name()+"-")
			if !ok || strings.HasPrefix(conn, "Writeback") {
				continue
			}
			p := filepath.Join(dir, k.Name())
			c.connectors = append(c.connectors, connector{name: conn, path: real(p), connected: attr(p, "status") == "connected"})
		}
		out = append(out, c)
	}
	return out
}

// readVideo lists the devices of the video4linux nodes (cameras, capture cards).
func readVideo(sys string) []string {
	ms, _ := filepath.Glob(filepath.Join(sys, "class", "video4linux", "video*"))
	var out []string
	for _, m := range ms {
		if dev := real(filepath.Join(m, "device")); dev != "" {
			out = append(out, dev)
		}
	}
	return out
}

// battery is a system battery (not a mouse's or a headset's: scope Device).
type battery struct {
	name, path, model, maker, driver string
}

func readBatteries(sys string) []battery {
	dir := filepath.Join(sys, "class", "power_supply")
	ents, _ := os.ReadDir(dir)
	var out []battery
	for _, e := range ents {
		p := filepath.Join(dir, e.Name())
		if attr(p, "type") != "Battery" || attr(p, "scope") == "Device" || attr(p, "present") == "0" {
			continue
		}
		b := battery{name: e.Name(), path: real(p), model: attr(p, "model_name"), maker: attr(p, "manufacturer")}
		if dev := real(filepath.Join(p, "device")); dev != "" {
			b.driver = driverOf(dev)
		}
		out = append(out, b)
	}
	return out
}

// hidDevice is an I²C HID device (touch screens, touch pads, a keyboard cover on I²C); USB ones are their USB device.
type hidDevice struct {
	path, name, driver, vendor, product string
}

func readHID(sys string) []hidDevice {
	dir := filepath.Join(sys, "bus", "hid", "devices")
	ents, _ := os.ReadDir(dir)
	var out []hidDevice
	for _, e := range ents {
		// 0018:04F3:4229.0003: bus 0x18 is I²C.
		if !strings.HasPrefix(e.Name(), "0018:") {
			continue
		}
		p := real(filepath.Join(dir, e.Name()))
		if p == "" {
			continue
		}
		h := hidDevice{path: p, driver: driverOf(p)}
		for _, line := range strings.Split(attr(p, "uevent"), "\n") {
			k, v, _ := strings.Cut(line, "=")
			switch k {
			case "HID_NAME":
				h.name = v
			case "HID_ID": // 0018:000004F3:00004229
				if f := strings.Split(v, ":"); len(f) == 3 && len(f[1]) >= 4 && len(f[2]) >= 4 {
					h.vendor, h.product = hex4(f[1][len(f[1])-4:]), hex4(f[2][len(f[2])-4:])
				}
			}
		}
		out = append(out, h)
	}
	return out
}

// switches are the radio switches (/sys/class/rfkill): blocked ones by type (wlan, bluetooth) and by the device they
// belong to (a Wi-Fi card's phy, a Bluetooth adapter), and the machine's own (a laptop's wireless key: its device is
// neither).
type switches struct {
	blocked map[string]bool // resolved rfkill directory → blocked
	machine map[string]bool // type → a machine-wide switch of that type is blocked
}

func readRfkill(sys string) switches {
	s := switches{blocked: map[string]bool{}, machine: map[string]bool{}}
	ms, _ := filepath.Glob(filepath.Join(sys, "class", "rfkill", "rfkill*"))
	sort.Strings(ms)
	for _, m := range ms {
		p := real(m)
		if p == "" {
			continue
		}
		blocked := attr(p, "soft") == "1" || attr(p, "hard") == "1"
		s.blocked[p] = blocked
		// A phy's switch sits in .../ieee80211/phyN/rfkillM, an adapter's in .../bluetooth/hciN/rfkillM.
		parent := filepath.Base(filepath.Dir(filepath.Dir(p)))
		if blocked && parent != "ieee80211" && parent != "bluetooth" {
			s.machine[attr(p, "type")] = true
		}
	}
	return s
}

// off: any of a function's own switches (their sysfs paths) is blocked, or a machine-wide one of its type.
func (s switches) off(typ string, own []string) bool {
	for _, o := range own {
		if s.blocked[real(o)] {
			return true
		}
	}
	return s.machine[typ]
}
