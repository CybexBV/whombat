//go:build !windows

package agent

import (
	"os"
	"syscall"
)

// keepOwner gives f the owner of the file it replaces (fi). Errors are
// ignored: a FAT flash drive (Unraid) has no owners, and a non-root agent
// can't give a file away.
func keepOwner(f *os.File, fi os.FileInfo) {
	if st, ok := fi.Sys().(*syscall.Stat_t); ok {
		_ = f.Chown(int(st.Uid), int(st.Gid))
	}
}
