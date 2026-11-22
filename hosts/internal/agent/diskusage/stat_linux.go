//go:build linux

package diskusage

import (
	"bufio"
	"bytes"
	"os"
	"strconv"
	"strings"

	"golang.org/x/sys/unix"
)

func entryStatFromStatx(stx *unix.Statx_t) entryStat {
	var alloc uint64
	if stx.Mask&unix.STATX_BLOCKS != 0 {
		alloc = stx.Blocks * 512
	} else if stx.Mask&unix.STATX_SIZE != 0 {
		alloc = stx.Size
	} else if stx.Blocks > 0 {
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
	return es
}

// fdinfoMountID reads the mount ID of an open descriptor (including O_PATH
// descriptors) from /proc/self/fdinfo/<fd>. Used as a fallback on Linux 5.6
// and 5.7, which have openat2(2) and statx(2) but predated STATX_MNT_ID (5.8).
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
