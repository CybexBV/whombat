//go:build !linux

package collect

import "syscall"

// statfsFrsize: statfs has no fragment size here; blocks are Bsize.
func statfsFrsize(*syscall.Statfs_t) uint64 { return 0 }
