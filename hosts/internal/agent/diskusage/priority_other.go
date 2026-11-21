//go:build !linux && !darwin

package diskusage

func setThreadLowPriority() {}
