//go:build linux

package diskusage

import (
	"bufio"
	"bytes"
	"errors"
	"os"
	"strconv"
	"strings"

	"golang.org/x/sys/unix"
)

// fdStatMountID returns the mount ID of an already-open descriptor without
// touching any path string. It uses statx(AT_EMPTY_PATH, STATX_MNT_ID) on
// Linux 5.8+ and falls back to /proc/self/fdinfo/<fd> on older kernels (3.15+).
func fdStatMountID(fd int) (uint64, bool) {
	var stx unix.Statx_t
	for {
		err := unix.Statx(fd, "", unix.AT_EMPTY_PATH, unix.STATX_MNT_ID, &stx)
		if errors.Is(err, unix.EINTR) {
			continue
		}
		if err == nil && stx.Mask&unix.STATX_MNT_ID != 0 {
			return stx.Mnt_id, true
		}
		break
	}
	return fdinfoMountID(fd)
}

// statxOrFstatat stats direct child name relative to dirfd in one syscall
// without following symlinks or triggering automounts. It prefers statx so
// STATX_BASIC_STATS and STATX_MNT_ID arrive together, falling back to fstatat
// on kernels before 4.11 (ENOSYS) or seccomp filters refusing statx.
func statxOrFstatat(dirfd int, name string) (entryStat, error) {
	var stx unix.Statx_t
	for {
		err := unix.Statx(dirfd, name, unix.AT_SYMLINK_NOFOLLOW|unix.AT_NO_AUTOMOUNT, unix.STATX_BASIC_STATS|unix.STATX_MNT_ID, &stx)
		if errors.Is(err, unix.EINTR) {
			continue
		}
		if err == nil {
			var alloc uint64
			if stx.Blocks > 0 {
				alloc = stx.Blocks * 512
			} else if stx.Size > 0 {
				alloc = stx.Size
			}
			es := entryStat{
				Mode:       unixModeToFS(uint32(stx.Mode)),
				Size:       int64(stx.Size),
				AllocBytes: alloc,
				Dev:        unix.Mkdev(stx.Dev_major, stx.Dev_minor),
				HasDev:     true,
				Ino:        stx.Ino,
				Nlink:      uint64(stx.Nlink),
				HasInode:   true,
			}
			if stx.Mask&unix.STATX_MNT_ID != 0 {
				es.MntID = stx.Mnt_id
				es.HasMntID = true
			}
			return es, nil
		}
		if errors.Is(err, unix.ENOSYS) || errors.Is(err, unix.EPERM) {
			break
		}
		return entryStat{}, err
	}

	var st unix.Stat_t
	if err := fstatatNoEINTR(dirfd, name, &st, unix.AT_SYMLINK_NOFOLLOW|unix.AT_NO_AUTOMOUNT); err != nil {
		return entryStat{}, err
	}
	return entryStatFromUnix(&st), nil
}

func fdinfoMountID(fd int) (uint64, bool) {
	b, err := os.ReadFile("/proc/self/fdinfo/" + strconv.Itoa(fd))
	if err != nil {
		return 0, false
	}
	sc := bufio.NewScanner(bytes.NewReader(b))
	for sc.Scan() {
		line := sc.Text()
		val, ok := strings.CutPrefix(line, "mnt_id:")
		if !ok {
			continue
		}
		id, err := strconv.ParseUint(strings.TrimSpace(val), 10, 64)
		if err != nil {
			return 0, false
		}
		return id, true
	}
	return 0, false
}
