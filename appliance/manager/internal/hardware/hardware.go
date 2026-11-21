// Package hardware is the box's hardware report (Whombat docs/decisions/hardware-support.md HD-01, HD-03; contracts
// CT-560…CT-563; MG-110…MG-117): what the machine has and whether it works, collected from sysfs and procfs when the
// runtime asks (`POST /v1/host/hardware`), with names from the hwdata database and the kernel's firmware and driver
// error lines from the update helper (`hardware-log`). Everything comes from what the machine reports, never from a
// list of known models; no serial number or MAC address is read.
package hardware

import (
	"context"
	"log/slog"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"sync"
	"time"

	"github.com/CybexBV/whombat/appliance/helper/pkg/kernlog"
	"github.com/CybexBV/whombat/contracts/go/local"
	"github.com/CybexBV/whombat/contracts/go/protocol"
)

// The contract's limits (HOST_HARDWARE_DEVICES_MAX, HOST_HARDWARE_LOG_MAX, HOST_HARDWARE_LOG_LINE_MAX).
const (
	DevicesMax = 256
	LogMax     = 40
	LogLineMax = 240
)

// CacheFor is how long a report is answered again (an owner opening About on two devices, the app's retries).
const CacheFor = 10 * time.Second

// kernelLogTimeout bounds the helper's hardware-log.
const kernelLogTimeout = 10 * time.Second

// Config says where to read. Empty fields take the machine's own paths.
type Config struct {
	// Sys and Proc are the roots of /sys and /proc (tests pass fixture trees).
	Sys, Proc string
	// Hwdata is the directory with pci.ids and usb.ids; "": HwdataDir (the build's).
	Hwdata string
	// KernelLog returns the kernel's firmware and driver error lines (the helper's hardware-log); nil: none.
	KernelLog func(ctx context.Context) ([]string, error)
	Now       func() time.Time
	Log       *slog.Logger
}

// Collector answers the hardware report.
type Collector struct {
	cfg Config

	mu      sync.Mutex
	last    *protocol.HostHardware
	lastAt  time.Time
	logWarn string
}

// New returns a Collector for cfg.
func New(cfg Config) *Collector {
	if cfg.Sys == "" {
		cfg.Sys = "/sys"
	}
	if cfg.Proc == "" {
		cfg.Proc = "/proc"
	}
	if cfg.Hwdata == "" {
		cfg.Hwdata = HwdataDir
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	if cfg.Log == nil {
		cfg.Log = slog.Default()
	}
	return &Collector{cfg: cfg}
}

// Collect returns the report, at most CacheFor old. It fails only when ctx ends; a kernel log the helper can't give
// leaves the log empty (one warning per kind of failure).
func (c *Collector) Collect(ctx context.Context) (*protocol.HostHardware, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	now := c.cfg.Now()
	if c.last != nil && now.Sub(c.lastAt) < CacheFor && !now.Before(c.lastAt) {
		return c.last, nil
	}
	var lines []string
	if c.cfg.KernelLog != nil {
		lctx, cancel := context.WithTimeout(ctx, kernelLogTimeout)
		got, err := c.cfg.KernelLog(lctx)
		cancel()
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		switch {
		case err != nil && err.Error() != c.logWarn:
			c.logWarn = err.Error()
			c.cfg.Log.Warn("hardware: the kernel's lines are left out of the report", "err", err)
		case err == nil:
			c.logWarn, lines = "", got
		}
	}
	h := collect(c.cfg.Sys, c.cfg.Proc, c.cfg.Hwdata, lines)
	h.CollectedAt = now.UTC().Format(time.RFC3339)
	c.last, c.lastAt = h, now
	return h, nil
}

// entry is a device of the report while it is assembled.
type entry struct {
	d     protocol.HardwareDevice
	path  string   // where it is in sysfs (the order within a kind)
	names []string // the sysfs device names it stands for, as kernel lines name them
	owner *raw     // a PCI function or USB device listed as itself (not as one of its functions)
	// Its own radio switches (Wi-Fi, Bluetooth) and whether the function shows it works (an interface, a card, a disk).
	rfkill  []string
	working bool
}

var idRe = regexp.MustCompile(`^[0-9a-f]{4}:[0-9a-f]{4}$`)

func strp(s string, max int) *string {
	if t := local.HostText(s, max); t != "" {
		return &t
	}
	return nil
}

func i64p(v int64) *int64 { return &v }

// collect assembles the report from the trees at sys and proc, the ids files in hwdata and the kernel lines.
func collect(sys, proc, hwdata string, kernelLines []string) *protocol.HostHardware {
	raws := append(readPCI(sys), readUSB(sys)...)
	own := owners(raws)
	nets, cards, disks, hcis := readNet(sys), readSound(sys, proc), readBlock(sys), readBluetooth(sys)
	drms, videos, bats, hids := readDRM(sys), readVideo(sys), readBatteries(sys), readHID(sys)
	sw := readRfkill(sys)

	// Names: one pass through each ids file for what this machine has.
	pciWant, usbWant := newWant(), newWant()
	for _, r := range raws {
		if r.bus == protocol.HardwareBusPci {
			pciWant.add(r.vendor, r.device)
			pciWant.addClass(r.class)
		} else {
			usbWant.add(r.vendor, r.device)
		}
	}
	for _, h := range hids {
		usbWant.add(h.vendor, "")
	}
	pciNames, usbNames := lookup(dirFile(hwdata, "pci.ids"), pciWant), lookup(dirFile(hwdata, "usb.ids"), usbWant)
	nameOf := func(r *raw) (name, vendor string) {
		if r == nil {
			return "", ""
		}
		if r.bus == protocol.HardwareBusPci {
			name, vendor = pciNames.device(r.vendor, r.device), pciNames.vendor(r.vendor)
			if name == "" {
				if name = pciNames.class(r.class); name == "" && len(r.class) >= 2 {
					name = pciClassNames[r.class[:2]]
				}
			}
			return name, vendor
		}
		name, vendor = usbNames.device(r.vendor, r.device), usbNames.vendor(r.vendor)
		if name == "" {
			name = r.product
		}
		if vendor == "" && !placeholder(r.manufacturer) {
			vendor = r.manufacturer
		}
		return name, vendor
	}
	idOf := func(r *raw) *string {
		if r == nil {
			return nil
		}
		if id := r.vendor + ":" + r.device; idRe.MatchString(id) {
			return &id
		}
		return nil
	}
	namesOf := func(r *raw, more ...string) []string {
		var out []string
		if r != nil {
			out = append(append(out, r.name), r.ifNames...)
		}
		return append(out, more...)
	}
	// fromOwner fills a function's entry from the device it works on.
	fromOwner := func(kind protocol.HardwareKind, path string, owner *raw, fallback, driver string) entry {
		name, vendor := nameOf(owner)
		if name == "" {
			name = fallback
		}
		if owner != nil {
			owner.represented = true
			owner.hasFunction = true
		}
		return entry{path: path, working: true, d: protocol.HardwareDevice{Kind: kind, Name: name, Vendor: strp(vendor, 80),
			Bus: busOf(sys, path, owner), ID: idOf(owner), Driver: strp(driver, 64)}}
	}

	var out []entry
	for _, n := range nets {
		owner := own.of(n.devPath)
		kind := protocol.HardwareKindWired
		if n.wifi {
			kind = protocol.HardwareKindWifi
		}
		e := fromOwner(kind, n.devPath, owner, n.name, n.driver)
		e.names = namesOf(owner, filepath.Base(n.devPath))
		e.rfkill = n.rfkill
		e.d.Interface = strp(n.name, 15)
		link := protocol.HardwareLinkDown
		if n.up {
			link = protocol.HardwareLinkUp
		}
		e.d.Link = &link
		if n.speed > 0 {
			e.d.SpeedMbps = i64p(n.speed)
		}
		out = append(out, e)
	}
	for _, c := range cards {
		owner := own.of(c.devPath)
		driver := c.deviceDriver
		if driver == "" {
			driver = c.driver
		}
		e := fromOwner(protocol.HardwareKindSound, c.devPath, owner, "", driver)
		// The card's own name (what ALSA and the sound server show); the owner's database name is its controller's.
		if n := local.HostText(c.shortName, 120); n != "" {
			e.d.Name = n
		} else if e.d.Name == "" {
			e.d.Name = "Sound card " + c.id
		}
		e.names = namesOf(owner, c.devName)
		e.d.Card = strp(c.id, 32)
		e.d.Capture, e.d.Playback = i64p(min(c.capture, 64)), i64p(min(c.playback, 64))
		out = append(out, e)
	}
	for _, d := range disks {
		owner := own.of(d.devPath)
		e := fromOwner(protocol.HardwareKindStorage, d.devPath, owner, d.name, diskDriver(sys, d, owner))
		if m := local.HostText(d.model, 120); m != "" {
			e.d.Name = m
		}
		if v := local.HostText(d.vendor, 80); v != "" {
			e.d.Vendor = &v
		}
		e.names = namesOf(owner, d.name)
		e.d.SizeBytes = i64p(d.size)
		out = append(out, e)
	}
	for _, h := range hcis {
		owner := own.of(h.devPath)
		e := fromOwner(protocol.HardwareKindBluetooth, h.devPath, owner, "Bluetooth", h.driver)
		e.names = namesOf(owner, h.name, filepath.Base(h.devPath))
		e.rfkill = h.rfkill
		e.working = false // an adapter is registered before its firmware loads
		out = append(out, e)
	}
	for _, v := range videos {
		if o := own.of(v); o != nil {
			o.video, o.hasFunction = true, true
		}
	}
	for _, c := range drms {
		owner := own.of(c.devPath)
		if owner != nil {
			owner.hasFunction = true
		}
		driver := driverOf(c.devPath)
		for _, k := range c.connectors {
			out = append(out, entry{path: k.path, working: true, d: protocol.HardwareDevice{Kind: protocol.HardwareKindDisplay,
				Name: k.name, Bus: busOf(sys, c.devPath, owner), Driver: strp(driver, 64), Connected: &k.connected}})
		}
	}
	for _, b := range bats {
		name := b.model
		if placeholder(name) {
			name = b.name
		}
		out = append(out, entry{path: b.path, working: true, d: protocol.HardwareDevice{Kind: protocol.HardwareKindBattery,
			Name: name, Vendor: optText(b.maker, 80), Bus: protocol.HardwareBusPlatform, Driver: strp(b.driver, 64)}})
	}
	for _, h := range hids {
		var id *string
		if s := h.vendor + ":" + h.product; idRe.MatchString(s) {
			id = &s
		}
		name := h.name
		if name == "" {
			name = "Input device"
		}
		out = append(out, entry{path: h.path, working: true, names: []string{filepath.Base(h.path)},
			d: protocol.HardwareDevice{Kind: protocol.HardwareKindInput, Name: name, Vendor: strp(usbNames.vendor(h.vendor), 80),
				Bus: protocol.HardwareBusPlatform, ID: id, Driver: strp(h.driver, 64)}})
	}
	// The PCI functions and USB devices no function stands for: by their class (bridges are left out).
	for _, r := range raws {
		if r.represented {
			continue
		}
		kind, ok := rawKind(r, nameOf)
		if !ok {
			continue
		}
		name, vendor := nameOf(r)
		if name == "" {
			name = map[protocol.HardwareBus]string{protocol.HardwareBusPci: "PCI device", protocol.HardwareBusUsb: "USB device"}[r.bus]
		}
		out = append(out, entry{path: r.path, names: namesOf(r), owner: r, working: r.hasFunction,
			d: protocol.HardwareDevice{Kind: kind, Name: name, Vendor: strp(vendor, 80), Bus: r.bus, ID: idOf(r), Driver: strp(r.driver, 64)}})
	}

	fw := firmwareFailures(kernelLines)
	for i := range out {
		out[i].d.Status = status(out[i], sw, fw)
		if n := local.HostText(out[i].d.Name, 120); n != "" {
			out[i].d.Name = n
		} else {
			out[i].d.Name = "Device"
		}
	}
	rank := func(k protocol.HardwareKind) int { return slices.Index(protocol.HardwareKindValues, k) }
	sort.SliceStable(out, func(i, j int) bool {
		if a, b := rank(out[i].d.Kind), rank(out[j].d.Kind); a != b {
			return a < b
		}
		return out[i].path < out[j].path
	})
	devices := []protocol.HardwareDevice{}
	for _, e := range out {
		if len(devices) == DevicesMax {
			break
		}
		devices = append(devices, e.d)
	}

	log := []string{}
	for _, l := range kernelLines {
		if len(log) == LogMax {
			break
		}
		if c := local.HostText(kernlog.Clean(l), LogLineMax); c != "" {
			log = append(log, c)
		}
	}
	return &protocol.HostHardware{Kernel: readKernel(proc), Machine: readMachine(sys, proc), Cpu: readCPU(proc),
		MemoryBytes: readMemory(proc), Devices: devices, Log: log}
}

func dirFile(dir, name string) string {
	if dir == "" {
		return ""
	}
	return filepath.Join(dir, name)
}

// firmwareFailures: the devices (as kernel lines name them) whose firmware didn't load.
func firmwareFailures(lines []string) map[string]bool {
	out := map[string]bool{}
	for _, l := range lines {
		if kernlog.FirmwareFailure(l) {
			if _, dev := kernlog.Device(l); dev != "" {
				out[dev] = true
			}
		}
	}
	return out
}

// status (MG-111): `no_firmware` when a kernel line says its firmware didn't load and nothing shows it works (no
// driver bound, no interface, no card, no graphics card; a Bluetooth adapter is registered before its firmware loads,
// so for it the line is enough); `no_driver` when it needs a driver and none is bound; `disabled` when a radio switch
// blocks it (Wi-Fi, Bluetooth); else `ok`.
func status(e entry, sw switches, fw map[string]bool) protocol.HardwareStatus {
	failed := false
	for _, n := range e.names {
		failed = failed || fw[n]
	}
	needs := e.owner != nil && needsDriver(e.owner)
	switch {
	case failed && !e.working && (e.owner == nil || needs || e.d.Kind == protocol.HardwareKindBluetooth):
		return protocol.HardwareStatusNoFirmware
	case needs && e.owner.driver == "":
		return protocol.HardwareStatusNoDriver
	case e.d.Kind == protocol.HardwareKindWifi && sw.off("wlan", e.rfkill),
		e.d.Kind == protocol.HardwareKindBluetooth && sw.off("bluetooth", e.rfkill):
		return protocol.HardwareStatusDisabled
	}
	return protocol.HardwareStatusOk
}

// needsDriver: a PCI function of a class that does nothing without one (storage, network, graphics, audio and
// multimedia, USB and SD controllers, wireless), and every USB device (hubs aren't listed). Bridges, the chipset's
// system peripherals, SMBus, encryption and signal processing functions and accelerators work without, or aren't the
// box's business.
func needsDriver(r *raw) bool {
	if r.bus == protocol.HardwareBusUsb {
		return true
	}
	if len(r.class) < 4 {
		return false
	}
	switch r.class[:2] {
	case "01", "02", "03", "0d":
		return true
	}
	switch r.class[:4] {
	case "0401", "0403", "0480", "0c03", "0805":
		return true
	}
	return false
}

var (
	wifiName      = regexp.MustCompile(`(?i)802\.11|wireless lan|\bwlan\b|wi-?fi`)
	bluetoothName = regexp.MustCompile(`(?i)bluetooth`)
	ethernetName  = regexp.MustCompile(`(?i)ethernet|gigabit|\blan\b`)
)

// rawKind is the kind of a PCI function or USB device no function stands for (false: not listed, a PCI bridge).
func rawKind(r *raw, nameOf func(*raw) (string, string)) (protocol.HardwareKind, bool) {
	if r.video {
		return protocol.HardwareKindCamera, true
	}
	if r.bus == protocol.HardwareBusUsb {
		has := func(c string) bool { return slices.Contains(r.ifClasses, c) }
		switch {
		case has("e0"):
			return protocol.HardwareKindBluetooth, true
		case has("0e"):
			return protocol.HardwareKindCamera, true
		case has("01"):
			return protocol.HardwareKindSound, true
		case has("02"), has("0a"):
			return protocol.HardwareKindWired, true
		case has("08"):
			return protocol.HardwareKindStorage, true
		case has("03"):
			return protocol.HardwareKindInput, true
		}
		// A vendor-specific device says what it is only in its names (a Wi-Fi adapter without its driver): the
		// database's and its own.
		name, _ := nameOf(r)
		name += " " + r.product
		switch {
		case wifiName.MatchString(name):
			return protocol.HardwareKindWifi, true
		case bluetoothName.MatchString(name):
			return protocol.HardwareKindBluetooth, true
		case ethernetName.MatchString(name):
			return protocol.HardwareKindWired, true
		}
		return protocol.HardwareKindUsb, true
	}
	if len(r.class) < 4 {
		return protocol.HardwareKindOther, true
	}
	switch r.class[:2] {
	case "06":
		return "", false
	case "01":
		return protocol.HardwareKindStorage, true
	case "03":
		return protocol.HardwareKindGraphics, true
	case "09":
		return protocol.HardwareKindInput, true
	}
	switch r.class[:4] {
	case "0200":
		return protocol.HardwareKindWired, true
	case "0280", "0d20", "0d21":
		return protocol.HardwareKindWifi, true
	case "0d11":
		return protocol.HardwareKindBluetooth, true
	case "0401", "0403":
		return protocol.HardwareKindSound, true
	case "0400":
		return protocol.HardwareKindCamera, true
	case "0805":
		return protocol.HardwareKindStorage, true
	case "0c03":
		return protocol.HardwareKindUsb, true
	}
	return protocol.HardwareKindOther, true
}
