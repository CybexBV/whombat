//go:build darwin

package diskusage

import "golang.org/x/sys/unix"

const (
	prioDarwinThread = 3
	prioDarwinBG     = 0x1000
)

// setThreadLowPriority puts the calling macOS thread into background priority,
// which lowers both CPU priority and throttles disk I/O for that thread alone.
func setThreadLowPriority() {
	_ = unix.Setpriority(prioDarwinThread, 0, prioDarwinBG)
}
