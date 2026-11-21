//go:build linux

package diskusage

import "golang.org/x/sys/unix"

func hostStatMountID(path string) (uint64, bool) {
	var stx unix.Statx_t
	err := unix.Statx(unix.AT_FDCWD, path, unix.AT_SYMLINK_NOFOLLOW|unix.AT_NO_AUTOMOUNT, unix.STATX_MNT_ID, &stx)
	if err != nil || stx.Mask&unix.STATX_MNT_ID == 0 {
		return 0, false
	}
	return stx.Mnt_id, true
}

func fdStatMountID(fd int) (uint64, bool) {
	var stx unix.Statx_t
	err := unix.Statx(fd, "", unix.AT_EMPTY_PATH, unix.STATX_MNT_ID, &stx)
	if err != nil || stx.Mask&unix.STATX_MNT_ID == 0 {
		return 0, false
	}
	return stx.Mnt_id, true
}
