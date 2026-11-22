//go:build linux

package diskusage

import (
	"bytes"
	"errors"
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
// descriptors) from /proc/self/fdinfo/<fd>. In Linux (fs/proc/fd.c: seq_show),
// procfs prints real_mount(file->f_path.mnt)->mnt_id purely from kernel VFS
// memory without invoking any method on the descriptor's filesystem. Checking
// it before statx(2), fstatfs(2), or a readable open guarantees an overmounted
// or foreign filesystem never receives a metadata request.
func fdinfoMountID(fd int) (uint64, bool) {
	infofd, err := openNoEINTR("/proc/self/fdinfo/"+strconv.Itoa(fd), unix.O_RDONLY|unix.O_CLOEXEC)
	if err != nil {
		return 0, false
	}
	defer unix.Close(infofd)

	var buf [512]byte
	total := 0
	for total < len(buf) {
		n, rerr := unix.Read(infofd, buf[total:])
		if errors.Is(rerr, unix.EINTR) {
			continue
		}
		if n > 0 {
			total += n
		}
		if rerr != nil || n == 0 {
			break
		}
	}
	return parseFDInfoMountID(buf[:total])
}

func parseFDInfoMountID(b []byte) (uint64, bool) {
	for len(b) > 0 {
		var line []byte
		if idx := bytes.IndexByte(b, '\n'); idx >= 0 {
			line = b[:idx]
			b = b[idx+1:]
		} else {
			line = b
			b = nil
		}
		val, ok := bytes.CutPrefix(line, []byte("mnt_id:"))
		if !ok {
			continue
		}
		id, err := strconv.ParseUint(strings.TrimSpace(string(val)), 10, 64)
		if err != nil {
			return 0, false
		}
		return id, true
	}
	return 0, false
}
