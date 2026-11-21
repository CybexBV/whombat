//go:build !linux

package diskusage

func hostStatMountID(string) (uint64, bool) { return 0, false }

func fdStatMountID(int) (uint64, bool) { return 0, false }
