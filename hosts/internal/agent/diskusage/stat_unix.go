//go:build unix

package diskusage

import (
	"errors"
	"io/fs"
	"os"
	"syscall"
)

func openDirNoFollow(path string) (*os.File, uint64, uint64, bool, error) {
	fd, err := syscall.Open(path, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if err != nil {
		return nil, 0, 0, false, err
	}
	f := os.NewFile(uintptr(fd), path)
	fi, err := f.Stat()
	if err != nil {
		_ = f.Close()
		return nil, 0, 0, false, err
	}
	dev, ok := statDev(fi)
	if !ok {
		_ = f.Close()
		return nil, 0, 0, false, errors.New("missing device id")
	}
	mntID, hasMntID := fdStatMountID(int(f.Fd()))
	return f, dev, mntID, hasMntID, nil
}

func isSymlinkLoopErr(err error) bool {
	return errors.Is(err, syscall.ELOOP)
}

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
