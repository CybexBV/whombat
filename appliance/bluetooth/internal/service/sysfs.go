package service

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

var hciName = regexp.MustCompile(`^hci\d+$`)

// hasController: the kernel has registered a Bluetooth controller (/sys/class/bluetooth/hciN). Without one the
// service doesn't ask BlueZ (nothing to ask, and asking would start bluetoothd by D-Bus activation).
func hasController(sys string) bool {
	ents, _ := os.ReadDir(filepath.Join(sys, "class", "bluetooth"))
	for _, e := range ents {
		if hciName.MatchString(e.Name()) {
			return true
		}
	}
	return false
}

// driverless: a USB Bluetooth controller (interface class e0/01/01, the Bluetooth Programming Interface) with no
// driver bound, so the kernel registered no controller for it (as the hardware report's `no_driver`, MG-110).
func driverless(sys string) bool {
	ifaces, _ := filepath.Glob(filepath.Join(sys, "bus", "usb", "devices", "*:*"))
	for _, p := range ifaces {
		if attr(p, "bInterfaceClass") != "e0" || attr(p, "bInterfaceSubClass") != "01" || attr(p, "bInterfaceProtocol") != "01" {
			continue
		}
		if _, err := os.Lstat(filepath.Join(p, "driver")); err != nil {
			return true
		}
	}
	return false
}

func attr(dir, name string) string {
	b, _ := os.ReadFile(filepath.Join(dir, name))
	return strings.ToLower(strings.TrimSpace(string(b)))
}
