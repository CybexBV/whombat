package agent

import (
	"time"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
)

// CPUTimeWithChildren returns the user and kernel CPU time of this process.
// Windows keeps no total for finished child processes, so the PowerShell
// reads the collector starts count only while they run (in their own
// process).
func CPUTimeWithChildren() (time.Duration, bool) {
	var creation, exit, kernel, user windows.Filetime
	if err := windows.GetProcessTimes(windows.CurrentProcess(), &creation, &exit, &kernel, &user); err != nil {
		return 0, false
	}
	ft := func(t windows.Filetime) time.Duration {
		return time.Duration(uint64(t.HighDateTime)<<32|uint64(t.LowDateTime)) * 100 // 100 ns steps
	}
	return ft(kernel) + ft(user), true
}

// readRSS: the Windows collector measures the agent's working set itself
// (gopsutil), so the runtime's own measure isn't needed.
func readRSS() uint64 { return 0 }

// platformInstall: an agent the service manager started is the installed
// service; anything else (a console) was started by hand.
func platformInstall() (string, bool) {
	if ok, err := svc.IsWindowsService(); err == nil && ok {
		return InstallWindows, true
	}
	return InstallManual, true
}
