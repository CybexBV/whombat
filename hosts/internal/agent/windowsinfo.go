package agent

import (
	"strconv"
	"strings"
)

// WindowsVersion is what the registry says about the running Windows
// (HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion and the BIOS's names).
type WindowsVersion struct {
	ProductName      string // "Windows 10 Pro", also on Windows 11 (Product fixes it)
	DisplayVersion   string // "24H2" (older Windows: ReleaseId "2009")
	CurrentBuild     string // "26100"
	UBR              uint64 // the update build revision: 2605
	EditionID        string // "Professional"
	InstallationType string // "Client" | "Server" | "Server Core"
	Manufacturer     string // SystemManufacturer
	Model            string // SystemProductName
	CPU              string // ProcessorNameString of the first processor
	MachineGUID      string // HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid
}

// Product is the name Windows itself shows: Windows 11 keeps "Windows 10"
// in ProductName, so a build from 22000 on says 11.
func (v WindowsVersion) Product() string {
	name := strings.TrimSpace(v.ProductName)
	if name == "" {
		name = "Windows"
	}
	if b, err := strconv.Atoi(v.CurrentBuild); err == nil && b >= 22000 && !v.Server() {
		if rest, ok := strings.CutPrefix(name, "Windows 10"); ok {
			name = "Windows 11" + rest
		}
	}
	return name
}

// Server: a Windows Server installation (with or without its desktop).
func (v WindowsVersion) Server() bool {
	return strings.HasPrefix(strings.TrimSpace(v.InstallationType), "Server")
}

// Build is "26100.2605", or the build alone without its revision.
func (v WindowsVersion) Build() string {
	b := strings.TrimSpace(v.CurrentBuild)
	if b == "" {
		return ""
	}
	if v.UBR > 0 {
		return b + "." + strconv.FormatUint(v.UBR, 10)
	}
	return b
}

// Pretty is "Windows 11 Pro 24H2 (26100.2605)".
func (v WindowsVersion) Pretty() string {
	s := v.Product()
	if v.DisplayVersion != "" {
		s += " " + v.DisplayVersion
	}
	if b := v.Build(); b != "" {
		s += " (" + b + ")"
	}
	return s
}
