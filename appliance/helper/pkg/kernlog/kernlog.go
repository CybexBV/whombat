// Package kernlog picks the kernel's firmware and driver error lines for the hardware report (Whombat HD-03; MG-114,
// MG-115): the helper's read-only `hardware-log` operation filters the boot's kernel messages with Keep and Select, and
// the manager reads the device a line names (Device) and whether it is a firmware failure (FirmwareFailure) to mark
// that device `no_firmware`. Pure functions, no I/O.
package kernlog

import (
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"
)

// Max is how many lines the report carries (the contract's HOST_HARDWARE_LOG_MAX), LineMax how long each may be
// (HOST_HARDWARE_LOG_LINE_MAX, code points).
const (
	Max     = 40
	LineMax = 240
)

// PriorityErr is syslog's “err” (journald's PRIORITY for the kernel's KERN_ERR).
const PriorityErr = 3

// Noise: lines about the machine's ACPI tables and firmware bugs, which most laptops print by the dozen and which say
// nothing about a driver or a missing file.
var noisePrefixes = []string{
	"ACPI BIOS Error", "ACPI Error", "ACPI Warning", "ACPI Exception", "[Firmware Bug]", "[Firmware Warn]",
	"[Firmware Info]", "integrity:", "Lockdown:",
}

var failureWords = []string{
	"fail", "error", "not found", "missing", "unable", "no suitable", "cannot", "can't", "couldn't", "could not",
	"not available", "timed out", "timeout",
}

var noDriverHints = []string{"no driver", "unsupported device", "device not supported", "unknown chip",
	"unsupported chip", "no codecs found"}

func containsAny(s string, words []string) bool {
	for _, w := range words {
		if strings.Contains(s, w) {
			return true
		}
	}
	return false
}

// FirmwareFailure: the line says a firmware file (or the firmware) didn't load: “Direct firmware load for … failed
// with error -2”, “no suitable firmware found!”, “Failed to load firmware …”, “SOF firmware and/or topology file not
// found”. Lines about firmware bugs ([Firmware Bug], ACPI) are not.
func FirmwareFailure(msg string) bool {
	if noise(msg) {
		return false
	}
	l := strings.ToLower(msg)
	return strings.Contains(l, "firmware") && containsAny(l, failureWords)
}

func noise(msg string) bool {
	for _, p := range noisePrefixes {
		if strings.HasPrefix(msg, p) {
			return true
		}
	}
	return false
}

// Keep says whether a kernel message belongs in the report: a firmware failure, a driver's failed probe (“probe with
// driver … failed”, “probe of … failed with error -12”), a hint that a device has no driver (“no codecs found”,
// “unsupported device”), or an error-level message (priority ≤ err; -1: unknown) of a device (`<driver> <device>: …`,
// `Bluetooth: hci0: …`). Never the noise above, and never a line naming a serial number.
func Keep(msg string, priority int) bool {
	if msg == "" || noise(msg) {
		return false
	}
	l := strings.ToLower(msg)
	if strings.Contains(l, "serial number") || strings.Contains(l, "serialnumber") {
		return false
	}
	switch {
	case FirmwareFailure(msg):
		return true
	case strings.Contains(l, "probe") && (strings.Contains(l, "fail") || strings.Contains(l, "error -")):
		return true
	case containsAny(l, noDriverHints):
		return true
	case priority >= 0 && priority <= PriorityErr:
		return devLine.MatchString(msg) && !strings.ContainsFunc(strings.SplitN(msg, " ", 2)[0], unicode.IsUpper)
	}
	return false
}

var mac = regexp.MustCompile(`(?i)\b[0-9a-f]{2}([:-])[0-9a-f]{2}(?:[:-][0-9a-f]{2}){4}\b`)

// Clean makes a message one line of display text of at most LineMax code points: MAC addresses become
// xx:xx:xx:xx:xx:xx, control and format characters go, white space runs are one space, a longer line ends in “…”.
func Clean(msg string) string {
	msg = mac.ReplaceAllString(msg, "xx:xx:xx:xx:xx:xx")
	var b strings.Builder
	space := false
	for _, r := range msg {
		switch {
		case r == utf8.RuneError:
			continue
		case unicode.IsSpace(r) || unicode.Is(unicode.Z, r):
			if !space {
				b.WriteByte(' ')
			}
			space = true
			continue
		case unicode.In(r, unicode.Cc, unicode.Cf, unicode.Cs):
			continue
		}
		space = false
		b.WriteRune(r)
	}
	s := strings.TrimSpace(b.String())
	if utf8.RuneCountInString(s) <= LineMax {
		return s
	}
	r := []rune(s)[:LineMax-1]
	return strings.TrimRight(string(r), " ") + "…"
}

// Entry is one kernel message with its syslog priority (-1 when unknown).
type Entry struct {
	Message  string
	Priority int
}

// Select keeps what Keep keeps, cleaned, each message once, the first Max of them (oldest first: the boot's problems
// come first, and a device that keeps failing repeats one line).
func Select(entries []Entry) []string {
	out := []string{}
	seen := map[string]bool{}
	for _, e := range entries {
		if !Keep(e.Message, e.Priority) {
			continue
		}
		c := Clean(e.Message)
		if c == "" || seen[c] {
			continue
		}
		seen[c] = true
		out = append(out, c)
		if len(out) == Max {
			break
		}
	}
	return out
}

var (
	// `<driver> <device>: …` (dev_printk: the driver, else the bus or class; the device's name, which may hold colons
	// but no space) and `<driver> <device> <interface>: …` (netdev_printk).
	devLine = regexp.MustCompile(`^([A-Za-z0-9_.-]+) (\S+?)(?: \S+?)?: `)
	btLine  = regexp.MustCompile(`^Bluetooth: (hci[0-9]+): `)
	pciAddr = regexp.MustCompile(`^[0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-7]$`)
)

// Device returns the driver and the device a message names (`mt7925e 0000:c3:00.0: …` → mt7925e, 0000:c3:00.0;
// `Bluetooth: hci0: …` → "", hci0; `btusb 3-5:1.0: …` → btusb, 3-5:1.0), or "" when it names none.
func Device(msg string) (driver, dev string) {
	if m := btLine.FindStringSubmatch(msg); m != nil {
		return "", m[1]
	}
	m := devLine.FindStringSubmatch(msg)
	if m == nil {
		return "", ""
	}
	driver, dev = m[1], m[2]
	if pciAddr.MatchString(dev) || usbName(dev) || strings.HasPrefix(dev, "hci") || strings.ContainsAny(dev, ".:-") {
		return driver, dev
	}
	return "", ""
}

// usbName: a USB device (`3-5`, `1-2.4`) or interface (`3-5:1.0`).
func usbName(s string) bool {
	dev, intf, hasIntf := strings.Cut(s, ":")
	bus, port, ok := strings.Cut(dev, "-")
	if !ok || bus == "" || port == "" || !digits(bus) || !digits(strings.ReplaceAll(port, ".", "")) {
		return false
	}
	if !hasIntf {
		return true
	}
	c, i, ok := strings.Cut(intf, ".")
	return ok && digits(c) && digits(i)
}

func digits(s string) bool {
	if s == "" {
		return false
	}
	for _, c := range s {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}
