//go:build darwin

package diskusage

import (
	"errors"

	"golang.org/x/sys/unix"
)

var darwinRemoteFSTypes = map[string]bool{
	"smbfs": true, "nfs": true, "afpfs": true, "webdav": true, "fuse": true,
	"osxfuse": true, "macfuse": true, "lifs": true,
}

var darwinLocalFSTypes = map[string]bool{
	"apfs": true, "hfs": true, "msdos": true, "exfat": true, "udf": true,
}

func hostMounts() ([]mountInfo, error) {
	n, err := unix.Getfsstat(nil, unix.MNT_NOWAIT)
	if err != nil {
		return nil, err
	}
	buf := make([]unix.Statfs_t, n+4)
	n, err = unix.Getfsstat(buf, unix.MNT_NOWAIT)
	if err != nil {
		return nil, err
	}
	out := make([]mountInfo, 0, n)
	for i, st := range buf[:n] {
		mp := cstrBytes(st.Mntonname[:])
		fsType := cstrBytes(st.Fstypename[:])
		src := cstrBytes(st.Mntfromname[:])
		remote := darwinRemoteFSTypes[fsType] || (st.Flags&unix.MNT_LOCAL == 0)
		virtual := !remote && !darwinLocalFSTypes[fsType]
		out = append(out, mountInfo{
			ID:         i + 1,
			FSID:       st.Fsid.Val,
			HasFSID:    true,
			MountPoint: mp,
			FSType:     fsType,
			Source:     src,
			Remote:     remote,
			Virtual:    virtual,
		})
	}
	return out, nil
}

func cstrBytes(b []byte) string {
	for i, c := range b {
		if c == 0 {
			return string(b[:i])
		}
	}
	return string(b)
}

func fdStatfs(fd int) (fsStat, error) {
	var st unix.Statfs_t
	for {
		err := unix.Fstatfs(fd, &st)
		if errors.Is(err, unix.EINTR) {
			continue
		}
		if err != nil {
			return fsStat{}, err
		}
		return statfsFromUnix(&st), nil
	}
}

func statfsFromUnix(st *unix.Statfs_t) fsStat {
	bsize := uint64(st.Bsize)
	var used uint64
	if st.Blocks >= st.Bfree {
		used = (st.Blocks - st.Bfree) * bsize
	}
	avail := st.Bavail * bsize
	return fsStat{TotalBytes: used + avail, UsedBytes: used}
}
