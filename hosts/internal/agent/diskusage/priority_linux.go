//go:build linux

package diskusage

import "golang.org/x/sys/unix"

const (
	ioprioWhoProcess = 1
	ioprioClassShift = 13
	ioprioClassBE    = 2
	ioprioClassIdle  = 3
)

// setThreadLowPriority lowers the calling OS thread's CPU and I/O scheduling
// priority to the minimum so a disk walk stays out of the way of workloads.
func setThreadLowPriority() {
	// On Linux, PRIO_PROCESS with who=0 applies to the calling thread.
	_ = unix.Setpriority(unix.PRIO_PROCESS, 0, 19)
	// Prefer idle I/O class; fall back to lowest best-effort priority if unprivileged.
	_, _, errno := unix.Syscall(unix.SYS_IOPRIO_SET, ioprioWhoProcess, 0, uintptr(ioprioClassIdle<<ioprioClassShift))
	if errno != 0 {
		_, _, _ = unix.Syscall(unix.SYS_IOPRIO_SET, ioprioWhoProcess, 0, uintptr((ioprioClassBE<<ioprioClassShift)|7))
	}
}
