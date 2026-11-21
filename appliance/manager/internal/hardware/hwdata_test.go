package hardware

import (
	"path/filepath"
	"testing"
)

func TestLookup(t *testing.T) {
	w := newWant()
	w.add("14c3", "7925")
	w.add("1002", "1640")
	w.add("dead", "beef")
	w.addClass("028000")
	w.addClass("0c0330")
	w.addClass("118000")
	n := lookup("testdata/pci.ids", w)
	if n.vendor("14c3") != "MEDIATEK Corp." || n.device("14c3", "7925") != "MT7925 802.11be 160MHz 2x2 PCIe Wireless Network Adapter [Filogic 360]" {
		t.Fatalf("%+v", n)
	}
	// The subsystem line under it (two tabs) is not the device.
	if n.device("1002", "1640") != "Rembrandt Radeon High Definition Audio Controller" || n.vendor("dead") != "" || n.device("dead", "beef") != "" {
		t.Fatalf("%+v", n)
	}
	if n.class("028000") != "Network controller" || n.class("0c0330") != "USB controller" || n.class("118000") != "Signal processing controller" {
		t.Fatalf("%+v", n.classes)
	}
	// A class without its subclass in the file: the class's name.
	w2 := newWant()
	w2.addClass("0c8000")
	if got := lookup("testdata/pci.ids", w2).class("0c8000"); got != "Serial bus controller" {
		t.Fatalf("%q", got)
	}

	// usb.ids: devices under their vendor; the classes, languages and HID sections after the vendors are no vendors.
	u := newWant()
	u.add("0bda", "8156")
	u.add("13d3", "3608")
	u.add("0409", "")
	u.add("0021", "")
	un := lookup("testdata/usb.ids", u)
	if un.device("0bda", "8156") != "USB 10/100/1G/2.5G LAN" || un.vendor("13d3") != "IMC Networks" || un.device("13d3", "3608") != "Wireless_Device" {
		t.Fatalf("%+v", un)
	}
	if un.vendor("0409") != "" || un.vendor("0021") != "" {
		t.Fatalf("%+v", un.vendors)
	}

	// No file, no names.
	if got := lookup(filepath.Join(t.TempDir(), "pci.ids"), w); len(got.vendors)+len(got.devices)+len(got.classes) != 0 {
		t.Fatalf("%+v", got)
	}
	if got := lookup("", w); len(got.vendors) != 0 {
		t.Fatalf("%+v", got)
	}
}
