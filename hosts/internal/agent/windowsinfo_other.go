//go:build !windows

package agent

// ReadWindowsVersion is empty off Windows.
func ReadWindowsVersion() WindowsVersion { return WindowsVersion{} }

// platformMachineID and platformOSName: Linux and macOS read their own
// files and tools (hostinfo.go).
func platformMachineID() (string, bool) { return "", false }
func platformOSName() (string, bool)    { return "", false }
