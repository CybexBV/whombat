//go:build !unix

package diskusage

import (
	"errors"
	"io/fs"
	"os"
)

func openDirNoFollow(path string) (*os.File, uint64, uint64, bool, error) {
	fi, err := os.Lstat(path)
	if err != nil {
		return nil, 0, 0, false, err
	}
	if fi.Mode()&fs.ModeSymlink != 0 {
		return nil, 0, 0, false, errors.New("symlink")
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, 0, 0, false, err
	}
	return f, 0, 0, false, nil
}

func isSymlinkLoopErr(error) bool { return false }

func statDev(fi fs.FileInfo) (uint64, bool) {
	return 0, false
}

func statInode(fi fs.FileInfo) (ino uint64, nlink uint64, ok bool) {
	return 0, 0, false
}

func allocatedBytes(fi fs.FileInfo) uint64 {
	if fi.Size() > 0 {
		return uint64(fi.Size())
	}
	return 0
}
