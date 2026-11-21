//go:build !unix

package diskusage

import "io/fs"

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
