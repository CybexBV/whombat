//go:build unix

package diskusage

import (
	"io/fs"
	"syscall"
)

func statDev(fi fs.FileInfo) (uint64, bool) {
	st, ok := fi.Sys().(*syscall.Stat_t)
	if !ok || st == nil {
		return 0, false
	}
	return uint64(st.Dev), true
}

func statInode(fi fs.FileInfo) (ino uint64, nlink uint64, ok bool) {
	st, ok := fi.Sys().(*syscall.Stat_t)
	if !ok || st == nil {
		return 0, 0, false
	}
	return uint64(st.Ino), uint64(st.Nlink), true
}

// allocatedBytes returns the disk space actually allocated to the file (handling
// sparse VM disks accurately), falling back to apparent size for inline files.
func allocatedBytes(fi fs.FileInfo) uint64 {
	if st, ok := fi.Sys().(*syscall.Stat_t); ok && st != nil {
		if st.Blocks > 0 {
			return uint64(st.Blocks) * 512
		}
		if fi.Size() > 0 {
			return uint64(fi.Size())
		}
		return 0
	}
	if fi.Size() > 0 {
		return uint64(fi.Size())
	}
	return 0
}
