package macos

import (
	"encoding/json"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// SystemVersion is `sw_vers`.
type SystemVersion struct {
	Name    string // "macOS"
	Version string // "27.2.1"
	Build   string // "26B131"
}

// ParseSwVers reads `sw_vers` ("ProductName:\tmacOS" lines).
func ParseSwVers(b []byte) SystemVersion {
	var v SystemVersion
	for _, line := range strings.Split(string(b), "\n") {
		k, val, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		val = strings.TrimSpace(val)
		switch strings.TrimSpace(k) {
		case "ProductName":
			v.Name = val
		case "ProductVersion":
			v.Version = val
		case "BuildVersion":
			v.Build = val
		}
	}
	return v
}

// MajorVersion is the first number of a macOS version ("27.2.1" -> 27;
// 0 when it isn't one).
func MajorVersion(v string) int {
	n, _ := strconv.Atoi(strings.SplitN(strings.TrimSpace(v), ".", 2)[0])
	return n
}

// ParseCsrutil reads `csrutil status`: SIP on or off (nil: a custom
// configuration or an answer the agent doesn't know).
func ParseCsrutil(b []byte) *bool {
	s := strings.ToLower(string(b))
	switch {
	case strings.Contains(s, "status: enabled"):
		return ptr(true)
	case strings.Contains(s, "status: disabled"):
		return ptr(false)
	}
	return nil
}

// ParseFileVault reads `fdesetup status`. Encryption or decryption in
// progress counts as on: the Mac still asks for its password at start-up.
func ParseFileVault(b []byte) *bool {
	s := strings.ToLower(string(b))
	switch {
	case strings.Contains(s, "filevault is on"), strings.Contains(s, "encryption in progress"), strings.Contains(s, "decryption in progress"):
		return ptr(true)
	case strings.Contains(s, "filevault is off"):
		return ptr(false)
	}
	return nil
}

// ConsoleUser maps `stat -f %Su /dev/console` to the person at the screen:
// root (the login window) and loginwindow are nobody.
func ConsoleUser(b []byte) string {
	u := strings.TrimSpace(string(b))
	if u == "root" || u == "loginwindow" || strings.ContainsAny(u, " \t\n/") || len(u) > 64 {
		return ""
	}
	return u
}

// AutoLoginUser maps `defaults read … autoLoginUser` to the user, "" when
// the key isn't set (defaults then exits 1).
func AutoLoginUser(b []byte, err error) string {
	if err != nil {
		return ""
	}
	return ConsoleUser(b)
}

var ioregUUIDRe = regexp.MustCompile(`"IOPlatformUUID"\s*=\s*"([0-9A-Fa-f-]{36})"`)

// ParseIORegUUID reads the Mac's hardware UUID from `ioreg -rd1 -c
// IOPlatformExpertDevice`, lower case ("" when absent).
func ParseIORegUUID(b []byte) string {
	m := ioregUUIDRe.FindSubmatch(b)
	if m == nil {
		return ""
	}
	return strings.ToLower(string(m[1]))
}

// Hardware is what `system_profiler SPHardwareDataType -json` says.
type Hardware struct {
	ModelName string // "Mac Studio"
	Model     string // "Mac14,14"
	Chip      string // "Apple M2 Ultra"; Intel: "8-Core Intel Core i9"
	Memory    string // "64 GB"
}

// ParseHardware reads system_profiler's JSON.
func ParseHardware(b []byte) (Hardware, bool) {
	var doc struct {
		Items []struct {
			MachineName  string `json:"machine_name"`
			MachineModel string `json:"machine_model"`
			ChipType     string `json:"chip_type"`
			CPUType      string `json:"cpu_type"`
			Cores        string `json:"number_processors"`
			Memory       string `json:"physical_memory"`
		} `json:"SPHardwareDataType"`
	}
	if json.Unmarshal(b, &doc) != nil || len(doc.Items) == 0 {
		return Hardware{}, false
	}
	it := doc.Items[0]
	h := Hardware{ModelName: it.MachineName, Model: it.MachineModel, Chip: it.ChipType, Memory: it.Memory}
	if h.Chip == "" {
		h.Chip = it.CPUType
	}
	return h, h.ModelName != "" || h.Model != ""
}

var boottimeRe = regexp.MustCompile(`sec\s*=\s*(\d+)(?:,\s*usec\s*=\s*(\d+))?`)

// ParseBoottime reads `sysctl -n kern.boottime` ("{ sec = 1794902443, usec
// = 323944 } Tue Nov 17 09:00:43 2026").
func ParseBoottime(s string) (time.Time, bool) {
	m := boottimeRe.FindStringSubmatch(s)
	if m == nil {
		return time.Time{}, false
	}
	sec, err := strconv.ParseInt(m[1], 10, 64)
	if err != nil || sec <= 0 {
		return time.Time{}, false
	}
	usec, _ := strconv.ParseInt(m[2], 10, 64)
	return time.Unix(sec, usec*1000).UTC(), true
}

// SysctlHost is the sysctl values the host part reads in one call:
// `sysctl -n hw.model machdep.cpu.brand_string hw.physicalcpu hw.logicalcpu
// hw.memsize kern.boottime`, one value per line in that order.
type SysctlHost struct {
	Model    string
	CPU      string
	Cores    int
	Threads  int
	MemBytes uint64
	Boot     time.Time
}

// SysctlHostNames is the argv tail of that call.
var SysctlHostNames = []string{"hw.model", "machdep.cpu.brand_string", "hw.physicalcpu", "hw.logicalcpu", "hw.memsize", "kern.boottime"}

// ParseSysctlHost reads that call's output.
func ParseSysctlHost(b []byte) SysctlHost {
	lines := strings.Split(strings.TrimRight(string(b), "\n"), "\n")
	get := func(i int) string {
		if i < len(lines) {
			return strings.TrimSpace(lines[i])
		}
		return ""
	}
	var h SysctlHost
	h.Model, h.CPU = get(0), get(1)
	h.Cores, _ = strconv.Atoi(get(2))
	h.Threads, _ = strconv.Atoi(get(3))
	h.MemBytes, _ = strconv.ParseUint(get(4), 10, 64)
	h.Boot, _ = ParseBoottime(get(5))
	return h
}

// ParseRFBVersion checks the 12-byte greeting of a VNC server ("RFB
// 003.889\n").
func ParseRFBVersion(b []byte) bool {
	return len(b) >= 12 && string(b[:4]) == "RFB " && b[7] == '.' && b[11] == '\n'
}

// ParseDefaultRoute reads `route -n get default`: the interface of the
// default route ("" = none).
func ParseDefaultRoute(b []byte) string {
	for _, line := range strings.Split(string(b), "\n") {
		k, v, ok := strings.Cut(strings.TrimSpace(line), ":")
		if ok && k == "interface" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}

// BundleVersion reads CFBundleShortVersionString (else CFBundleVersion)
// from an app's Info.plist in XML form.
func BundleVersion(infoPlist []byte) string {
	v, err := ParsePlist(infoPlist)
	if err != nil {
		return ""
	}
	d := asDict(v)
	if s := strings.TrimSpace(d.str("CFBundleShortVersionString")); s != "" {
		return clip(s, 64)
	}
	return clip(strings.TrimSpace(d.str("CFBundleVersion")), 64)
}

func clip(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}

func ptr[T any](v T) *T { return &v }
