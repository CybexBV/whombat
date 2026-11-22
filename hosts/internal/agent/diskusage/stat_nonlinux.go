//go:build !linux

package diskusage

func fdStatMountID(int) (uint64, bool) { return 0, false }
