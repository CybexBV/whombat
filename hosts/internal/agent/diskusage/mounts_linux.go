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

var remoteFSTypes = map[string]bool{
	"nfs": true, "nfs4": true, "cifs": true, "smb3": true, "smbfs": true, "fuse.sshfs": true,
	"fuse.rclone": true, "glusterfs": true, "fuse.glusterfs": true, "ceph": true, "fuse.ceph": true,
	"9p": true, "virtiofs": true, "afs": true, "lustre": true, "fuse.s3fs": true, "fuse.juicefs": true,
}

var localFSTypes = map[string]bool{
	"ext2": true, "ext3": true, "ext4": true, "xfs": true, "btrfs": true, "zfs": true,
	"vfat": true, "exfat": true, "f2fs": true, "ntfs": true, "ntfs3": true, "jfs": true,
	"reiserfs": true, "bcachefs": true, "nilfs2": true, "hfsplus": true, "fuse.shfs": true,
}

func hostMounts() ([]mountInfo, error) {
	b, err := os.ReadFile("/proc/self/mountinfo")
	if err != nil {
		return nil, err
	}
	return parseMountinfo(b), nil
}

func parseMountinfo(b []byte) []mountInfo {
	var out []mountInfo
	sc := bufio.NewScanner(bytes.NewReader(b))
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) < 10 {
			continue
		}
		sep := -1
		for i := 6; i < len(f); i++ {
			if f[i] == "-" {
				sep = i
				break
			}
		}
		if sep < 0 || sep+2 >= len(f) {
			continue
		}
		mp := unescapeMount(f[4])
		fsType := f[sep+1]
		src := unescapeMount(f[sep+2])
		remote := remoteFSTypes[fsType]
		virtual := !remote && !localFSTypes[fsType]
		out = append(out, mountInfo{
			MountPoint: mp,
			FSType:     fsType,
			Source:     src,
			Remote:     remote,
			Virtual:    virtual,
		})
	}
	return out
}

func unescapeMount(s string) string {
	if !strings.Contains(s, `\`) {
		return s
	}
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] == '\\' && i+3 < len(s) {
			if v, err := strconv.ParseUint(s[i+1:i+4], 8, 8); err == nil {
				b.WriteByte(byte(v))
				i += 3
				continue
			}
		}
		b.WriteByte(s[i])
	}
	return b.String()
}

func hostStatfs(path string) (fsStat, error) {
	var st unix.Statfs_t
	if err := unix.Statfs(path, &st); err != nil {
		return fsStat{}, err
	}
	bsize := uint64(st.Bsize)
	var used uint64
	if st.Blocks >= st.Bfree {
		used = (st.Blocks - st.Bfree) * bsize
	}
	avail := st.Bavail * bsize
	return fsStat{TotalBytes: used + avail, UsedBytes: used}, nil
}
