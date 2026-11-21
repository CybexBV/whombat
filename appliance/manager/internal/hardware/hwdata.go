package hardware

// Device names from the hwdata database (`pci.ids`, `usb.ids`; MG-112): the files lspci and lsusb read, in the store
// path the manager was built with (HwdataDir, set by nix/packages/go.nix), so its strict configuration gains no field.

import (
	"bufio"
	"os"
	"strings"
)

// HwdataDir is the directory with pci.ids and usb.ids (`<hwdata>/share/hwdata`), set at build time with
// `-ldflags -X …/hardware.HwdataDir=…`. Empty (a test or development build): names come from the devices themselves
// and the built-in class names.
var HwdataDir = ""

// names is what a lookup found: vendor names by id ("14c3"), device names by "vendor:device" ("14c3:7925"), and (PCI)
// class names by class ("02") and class+subclass ("0280").
type names struct {
	vendors map[string]string
	devices map[string]string
	classes map[string]string
}

func (n names) vendor(v string) string    { return n.vendors[v] }
func (n names) device(v, d string) string { return n.devices[v+":"+d] }

// class names a PCI class register's value (six hex digits): its subclass's name, else its class's.
func (n names) class(code string) string {
	if len(code) < 4 {
		return ""
	}
	if s := n.classes[code[:4]]; s != "" {
		return s
	}
	return n.classes[code[:2]]
}

// want is what to look up: vendor ids, "vendor:device" ids and PCI class codes (two or four hex digits).
type want struct {
	vendors, devices, classes map[string]bool
}

func newWant() want {
	return want{vendors: map[string]bool{}, devices: map[string]bool{}, classes: map[string]bool{}}
}

func (w want) add(vendor, device string) {
	if vendor == "" {
		return
	}
	w.vendors[vendor] = true
	if device != "" {
		w.devices[vendor+":"+device] = true
	}
}

func (w want) addClass(code string) {
	if len(code) >= 4 {
		w.classes[code[:2]] = true
		w.classes[code[:4]] = true
	}
}

func (w want) count() int { return len(w.vendors) + len(w.devices) + len(w.classes) }

// lookup reads an ids file once for what w wants: lines `vvvv  Vendor`, `\tdddd  Device` (under their vendor), and in
// pci.ids `C cc  Class` with `\tss  Subclass`. Subsystem and interface lines (two tabs) and usb.ids' other sections
// (AT, HID, R, …) are skipped. A missing or unreadable file finds nothing.
func lookup(path string, w want) names {
	n := names{vendors: map[string]string{}, devices: map[string]string{}, classes: map[string]string{}}
	if path == "" || w.count() == 0 {
		return n
	}
	f, err := os.Open(path)
	if err != nil {
		return n
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 64*1024), 64*1024)
	left := w.count()
	vendor, class, section := "", "", ""
	for sc.Scan() && left > 0 {
		line := sc.Text()
		if line == "" || line[0] == '#' {
			continue
		}
		if line[0] != '\t' {
			vendor, class = "", ""
			if id, name, ok := idLine(line); ok && section == "" {
				vendor = id
				if w.vendors[id] {
					n.vendors[id] = name
					left--
				}
				continue
			}
			// Another section (`C 02  Network controller` in pci.ids; C, AT, HID, R, … in usb.ids).
			section, _, _ = strings.Cut(line, " ")
			if section == "C" {
				if id, name, ok := idLine(strings.TrimPrefix(line, "C ")); ok {
					class = id
					if w.classes[id] {
						n.classes[id] = name
						left--
					}
				}
			}
			continue
		}
		if strings.HasPrefix(line, "\t\t") {
			continue
		}
		id, name, ok := idLine(line[1:])
		if !ok {
			continue
		}
		switch {
		case vendor != "":
			if k := vendor + ":" + id; w.devices[k] {
				n.devices[k] = name
				left--
			}
		case section == "C" && class != "":
			if k := class + id; w.classes[k] {
				n.classes[k] = name
				left--
			}
		}
	}
	return n
}

// idLine splits `xxxx  Name` (a lowercase hex id, two spaces, the name).
func idLine(s string) (id, name string, ok bool) {
	id, name, ok = strings.Cut(s, "  ")
	if !ok || id == "" || len(id) > 4 {
		return "", "", false
	}
	for _, c := range id {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return "", "", false
		}
	}
	return id, strings.TrimSpace(name), name != ""
}

// pciClassNames are the PCI base classes' names (the PCI Code and ID Assignment Specification, as pci.ids names them),
// for a device without a name when pci.ids isn't there.
var pciClassNames = map[string]string{
	"00": "Unclassified device", "01": "Mass storage controller", "02": "Network controller",
	"03": "Display controller", "04": "Multimedia controller", "05": "Memory controller", "06": "Bridge",
	"07": "Communication controller", "08": "Generic system peripheral", "09": "Input device controller",
	"0a": "Docking station", "0b": "Processor", "0c": "Serial bus controller", "0d": "Wireless controller",
	"0e": "Intelligent controller", "0f": "Satellite communications controller", "10": "Encryption controller",
	"11": "Signal processing controller", "12": "Processing accelerators", "13": "Non-Essential Instrumentation",
	"40": "Coprocessor", "ff": "Unassigned class",
}
