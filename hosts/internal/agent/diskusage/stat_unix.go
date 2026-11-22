//go:build unix

package diskusage

import (
	"errors"
	"io/fs"
	"syscall"

	"golang.org/x/sys/unix"
)

func isSymlinkLoopErr(err error) bool {
	return errors.Is(err, syscall.ELOOP)
}

func isNotDirErr(err error) bool {
	return errors.Is(err, syscall.ENOTDIR) || errors.Is(err, errNotDir)
}

// darwinPuregoErrno extracts the 32-bit C int errno from the raw uintptr
// returned by purego.SyscallN on Darwin. purego v0.11.2 loads *__error() with
// a 64-bit load, which leaves neighbouring thread-local data in the upper 32
// bits on 64-bit Macs.
func darwinPuregoErrno(raw uintptr) unix.Errno {
	return unix.Errno(uint32(raw))
}

func entryStatFromUnix(st *unix.Stat_t) entryStat {
	var alloc uint64
	if st.Blocks > 0 {
		alloc = uint64(st.Blocks) * 512
	}
	return entryStat{
		Mode:       unixModeToFS(uint32(st.Mode)),
		Size:       st.Size,
		AllocBytes: alloc,
		Dev:        uint64(st.Dev),
		HasDev:     true,
		Ino:        uint64(st.Ino),
		Nlink:      uint64(st.Nlink),
		HasInode:   true,
	}
}

func unixModeToFS(m uint32) fs.FileMode {
	mode := fs.FileMode(m & 0o777)
	switch m & unix.S_IFMT {
	case unix.S_IFDIR:
		mode |= fs.ModeDir
	case unix.S_IFLNK:
		mode |= fs.ModeSymlink
	case unix.S_IFIFO:
		mode |= fs.ModeNamedPipe
	case unix.S_IFSOCK:
		mode |= fs.ModeSocket
	case unix.S_IFCHR:
		mode |= fs.ModeDevice | fs.ModeCharDevice
	case unix.S_IFBLK:
		mode |= fs.ModeDevice
	case unix.S_IFREG:
		// Regular file: no type bits set.
	default:
		mode |= fs.ModeIrregular
	}
	return mode
}
