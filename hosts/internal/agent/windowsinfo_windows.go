package agent

import (
	"strings"
	"sync"

	"golang.org/x/sys/windows/registry"
)

// ReadWindowsVersion reads the running Windows' names from the registry.
func ReadWindowsVersion() WindowsVersion {
	var v WindowsVersion
	if k, err := registry.OpenKey(registry.LOCAL_MACHINE, `SOFTWARE\Microsoft\Windows NT\CurrentVersion`, registry.QUERY_VALUE); err == nil {
		v.ProductName = regString(k, "ProductName")
		v.DisplayVersion = regString(k, "DisplayVersion")
		if v.DisplayVersion == "" {
			v.DisplayVersion = regString(k, "ReleaseId")
		}
		v.CurrentBuild = regString(k, "CurrentBuild")
		if v.CurrentBuild == "" {
			v.CurrentBuild = regString(k, "CurrentBuildNumber")
		}
		if n, _, err := k.GetIntegerValue("UBR"); err == nil {
			v.UBR = n
		}
		v.EditionID = regString(k, "EditionID")
		v.InstallationType = regString(k, "InstallationType")
		k.Close()
	}
	if k, err := registry.OpenKey(registry.LOCAL_MACHINE, `HARDWARE\DESCRIPTION\System\BIOS`, registry.QUERY_VALUE); err == nil {
		v.Manufacturer = regString(k, "SystemManufacturer")
		v.Model = regString(k, "SystemProductName")
		k.Close()
	}
	if k, err := registry.OpenKey(registry.LOCAL_MACHINE, `HARDWARE\DESCRIPTION\System\CentralProcessor\0`, registry.QUERY_VALUE); err == nil {
		v.CPU = regString(k, "ProcessorNameString")
		k.Close()
	}
	if k, err := registry.OpenKey(registry.LOCAL_MACHINE, `SOFTWARE\Microsoft\Cryptography`, registry.QUERY_VALUE|registry.WOW64_64KEY); err == nil {
		v.MachineGUID = strings.ToLower(regString(k, "MachineGuid"))
		k.Close()
	}
	return v
}

func regString(k registry.Key, name string) string {
	s, _, err := k.GetStringValue(name)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(s)
}

var (
	winVersionOnce sync.Once
	winVersion     WindowsVersion
)

// platformMachineID is Windows' MachineGuid: made at setup, it stays for
// the installation's life.
func platformMachineID() (string, bool) {
	winVersionOnce.Do(func() { winVersion = ReadWindowsVersion() })
	return winVersion.MachineGUID, true
}

// platformOSName is "Windows 11 Pro 24H2 (26100.2605)".
func platformOSName() (string, bool) {
	return ReadWindowsVersion().Pretty(), true
}
