package kernlog

import (
	"fmt"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestKeep(t *testing.T) {
	cases := []struct {
		msg  string
		prio int
		want bool
	}{
		// Firmware that didn't load, at any priority.
		{"mt7925e 0000:c3:00.0: Direct firmware load for mediatek/mt7925/WIFI_MT7925_PATCH_MCU_1_1_hdr.bin failed with error -2", 4, true},
		{"iwlwifi 0000:00:14.3: no suitable firmware found!", 3, true},
		{"Bluetooth: hci0: Failed to load firmware file (-2)", 3, true},
		{"sof-audio-pci-intel-lnl 0000:00:1f.3: SOF firmware and/or topology file not found.", 3, true},
		{"i915 0000:00:02.0: [drm] Failed to load DMC firmware i915/adlp_dmc.bin. Disabling runtime power management.", 6, true},
		// A driver's failed probe, and no driver.
		{"mt7921e 0000:01:00.0: probe with driver mt7921e failed with error -110", 4, true},
		{"snd_hda_intel 0000:c4:00.1: no codecs found!", 3, true},
		// Error-level lines of a device; not of the kernel at large.
		{"ucsi_acpi USBC000:00: error -ETIMEDOUT: PPM init failed", 3, true},
		{"nvme nvme0: I/O 12 QID 3 timeout, aborting", 3, true},
		{"Kernel command line: BOOT_IMAGE=/boot/vmlinuz", 3, false},
		// The memory's SPD on an SMBus the kernel doesn't read (common, harmless; seen in a VM).
		{"i2c i2c-0: Memory type 0x07 not supported yet, not instantiating SPD", 6, false},
		{"r8152 5-1:1.0 enp196s0f3u1: carrier on", 6, false},
		// Noise: ACPI tables, firmware bugs, certificates.
		{"ACPI BIOS Error (bug): Could not resolve symbol [\\_SB.PCI0.GPP0.SWUS], AE_NOT_FOUND (20240827/dswload2-162)", 3, false},
		{"[Firmware Bug]: TSC ADJUST: CPU0: -2147483648 force to 0", 4, false},
		{"integrity: Problem loading X.509 certificate -65", 3, false},
		// Loaded firmware is no failure; a serial number is never kept.
		{"mt7925e 0000:c3:00.0: WM Firmware Version: ____000000, Build Time: 20250304155526", 6, false},
		{"usb 3-5: SerialNumber: 0123456789", 3, false},
		{"", 3, false},
	}
	for _, c := range cases {
		if got := Keep(c.msg, c.prio); got != c.want {
			t.Errorf("Keep(%q, %d) = %v", c.msg, c.prio, got)
		}
	}
}

func TestFirmwareFailure(t *testing.T) {
	for msg, want := range map[string]bool{
		"bluetooth hci0: Direct firmware load for mediatek/BT_RAM_CODE_MT7925_1_1_hdr.bin failed with error -2": true,
		"rtw89_8852be 0000:02:00.0: failed to early request firmware: -2":                                       true,
		"amdgpu 0000:c5:00.0: amdgpu: Loaded firmware":                                                          false,
		"[Firmware Bug]: the BIOS has corrupted hw-PMU resources (MSR 38d is 330)":                              false,
		"usb 1-3: new full-speed USB device number 2 using xhci_hcd":                                            false,
	} {
		if got := FirmwareFailure(msg); got != want {
			t.Errorf("FirmwareFailure(%q) = %v", msg, got)
		}
	}
}

func TestDevice(t *testing.T) {
	cases := []struct{ msg, driver, dev string }{
		{"mt7925e 0000:c3:00.0: Direct firmware load for x failed with error -2", "mt7925e", "0000:c3:00.0"},
		{"mt7925e 0000:c3:00.0 wlp195s0: renamed from wlan0", "mt7925e", "0000:c3:00.0"},
		{"btusb 3-5:1.0: probe with driver btusb failed with error -110", "btusb", "3-5:1.0"},
		{"usb 3-5.2: device descriptor read/64, error -71", "usb", "3-5.2"},
		{"bluetooth hci0: Direct firmware load for x failed with error -2", "bluetooth", "hci0"},
		{"Bluetooth: hci0: Failed to load firmware file (-2)", "", "hci0"},
		{"cs35l41-hda spi1-CSC3551:00-cs35l41-hda.0: Failed to request firmware", "cs35l41-hda", "spi1-CSC3551:00-cs35l41-hda.0"},
		{"acp_pdm_mach acp_pdm_mach.0: snd_soc_register_card failed: -517", "acp_pdm_mach", "acp_pdm_mach.0"},
		{"Kernel command line: quiet", "", ""},
		{"random: crng init done", "", ""},
		{"nvme nvme0: 16/0/0 default/read/poll queues", "", ""},
	}
	for _, c := range cases {
		driver, dev := Device(c.msg)
		if driver != c.driver || dev != c.dev {
			t.Errorf("Device(%q) = %q, %q; want %q, %q", c.msg, driver, dev, c.driver, c.dev)
		}
	}
}

func TestClean(t *testing.T) {
	got := Clean("r8152 5-1:1.0 eth0: \x1b[2Jaddress 00:e0:4c:68:00:01\tdown‮")
	if got != "r8152 5-1:1.0 eth0: [2Jaddress xx:xx:xx:xx:xx:xx down" {
		t.Fatalf("%q", got)
	}
	long := Clean("iwlwifi 0000:00:14.3: " + strings.Repeat("é", 400))
	if utf8.RuneCountInString(long) != LineMax || !strings.HasSuffix(long, "…") {
		t.Fatalf("%d %q", utf8.RuneCountInString(long), long)
	}
	// A PCI address and a USB port are no MAC.
	if got := Clean("pci 0000:c3:00.0: [14c3:7925] type 00"); got != "pci 0000:c3:00.0: [14c3:7925] type 00" {
		t.Fatalf("%q", got)
	}
}

func TestSelect(t *testing.T) {
	var in []Entry
	in = append(in, Entry{"ACPI BIOS Error (bug): Could not resolve symbol", 3})
	for i := 0; i < 3; i++ {
		in = append(in, Entry{"mt7925e 0000:c3:00.0: Direct firmware load for a.bin failed with error -2", 4})
	}
	for i := 0; i < 60; i++ {
		in = append(in, Entry{fmt.Sprintf("usb 1-%d: device descriptor read/64, error -71", i), 3})
	}
	out := Select(in)
	if len(out) != Max {
		t.Fatalf("%d lines", len(out))
	}
	if !strings.HasPrefix(out[0], "mt7925e") || strings.HasPrefix(out[1], "mt7925e") || out[1] != "usb 1-0: device descriptor read/64, error -71" {
		t.Fatalf("%q", out[:3])
	}
	if got := Select(nil); got == nil || len(got) != 0 {
		t.Fatalf("%#v", got)
	}
}
