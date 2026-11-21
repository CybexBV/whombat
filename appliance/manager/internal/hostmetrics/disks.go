package hostmetrics

import (
	"encoding/binary"
	"encoding/hex"
	"errors"
	"math/bits"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/CybexBV/whombat/contracts/go/protocol"
	"golang.org/x/sys/unix"
)

// The qgroups of /persist (storage.nix, NX-12, NX-150, NX-458): Whombat's own subvolumes (home, workspaces,
// credentials, Hermes, the agent's home, secrets, manager, backup) and the agent's containers' storage. PostgreSQL's
// subvolume is in neither.
const (
	qgroupWhombat    = "1_100"
	qgroupContainers = "1_101"
)

// The subvolumes measured on their own, relative to /persist.
const (
	workSubvol     = "whombat/workspaces"
	databaseSubvol = "postgres"
)

// subvolRootIno is the inode number of every btrfs subvolume's root directory (BTRFS_FIRST_FREE_OBJECTID).
const subvolRootIno = 256

// diskReader measures the disks (BS-02): statfs of /persist, / and the backup disk when one is mounted, and
// /persist's parts from its btrfs quota groups in sysfs. Nothing here needs a privilege: statfs and statx on paths
// the manager can reach, and world-readable sysfs files.
type diskReader struct {
	persist, system, backup string
	proc, sys               string
	statfs                  func(path string, st *unix.Statfs_t) error
	// subvol is the btrfs subvolume id and the inode number of path (statx STATX_SUBVOL, Linux 6.10).
	subvol func(path string) (id, ino uint64, err error)
}

func newDiskReader(c Config) diskReader {
	return diskReader{persist: c.Persist, system: c.System, backup: c.Backup, proc: c.Proc, sys: c.Sys,
		statfs: unix.Statfs, subvol: statxSubvol}
}

var errNoSubvol = errors.New("statx: no subvolume id (not btrfs, or a kernel before 6.10)")

func statxSubvol(path string) (uint64, uint64, error) {
	var sx unix.Statx_t
	if err := unix.Statx(unix.AT_FDCWD, path, unix.AT_SYMLINK_NOFOLLOW, unix.STATX_INO|unix.STATX_SUBVOL, &sx); err != nil {
		return 0, 0, err
	}
	if sx.Mask&unix.STATX_SUBVOL == 0 {
		return 0, 0, errNoSubvol
	}
	return sx.Subvol, sx.Ino, nil
}

// read measures every disk. A filesystem that can't be read is all zeros (the data and system disks are required).
func (r diskReader) read() protocol.HostDisks {
	var out protocol.HostDisks
	if st, d, ok := r.disk(r.persist); ok {
		out.Data = protocol.HostDisksData{TotalBytes: d.TotalBytes, UsedBytes: d.UsedBytes, FreeBytes: d.FreeBytes,
			Parts: r.parts(st, d.UsedBytes)}
	}
	if _, d, ok := r.disk(r.system); ok {
		out.System = d
	}
	if r.backup != "" && r.mounted(r.backup) {
		if _, d, ok := r.disk(r.backup); ok {
			out.Backup = &d
		}
	}
	return out
}

// disk is statfs's view of path: used = (blocks − bfree)·size, free = bavail·size (what a user may still write),
// total = blocks·size, size being the fragment size (`df`'s).
func (r diskReader) disk(path string) (*unix.Statfs_t, protocol.HostDisk, bool) {
	var st unix.Statfs_t
	if path == "" || r.statfs(path, &st) != nil {
		return nil, protocol.HostDisk{}, false
	}
	size := uint64(st.Frsize)
	if size == 0 {
		size = uint64(st.Bsize)
	}
	bytes := func(blocks uint64) int64 { return safe(sat(blocks, size)) }
	return &st, protocol.HostDisk{TotalBytes: bytes(st.Blocks), UsedBytes: bytes(st.Blocks - min(st.Bfree, st.Blocks)),
		FreeBytes: bytes(st.Bavail)}, true
}

// mounted: path is a mount point in the manager's mount namespace (<proc>/self/mountinfo, field 5), so the backup disk
// counts only when it is mounted, not the empty directory under /persist.
func (r diskReader) mounted(path string) bool {
	b, err := os.ReadFile(filepath.Join(r.proc, "self", "mountinfo"))
	if err != nil {
		return false
	}
	want := filepath.Clean(path)
	for _, line := range strings.Split(string(b), "\n") {
		f := strings.Fields(line)
		if len(f) > 4 && unescapeMount(f[4]) == want {
			return true
		}
	}
	return false
}

// unescapeMount undoes mountinfo's octal escapes (`\040` for a space).
func unescapeMount(s string) string {
	if !strings.Contains(s, `\`) {
		return s
	}
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] == '\\' && i+4 <= len(s) {
			if v, ok := octal(s[i+1 : i+4]); ok {
				b.WriteByte(v)
				i += 3
				continue
			}
		}
		b.WriteByte(s[i])
	}
	return b.String()
}

func octal(s string) (byte, bool) {
	v := 0
	for _, c := range s {
		if c < '0' || c > '7' {
			return 0, false
		}
		v = v*8 + int(c-'0')
	}
	return byte(v), v < 256
}

// parts splits /persist's used space by its quota groups (BS-02): containers (1/101), work (the workspaces subvolume),
// database (the postgres subvolume) and whombat (1/100 less work). Each counts what its subvolumes reference. Nil when
// /persist isn't btrfs, quotas are off, the filesystem's sysfs directory isn't found, or btrfs marked its counts
// inconsistent (a rescan is due or running: until it ends the numbers are wrong). A part that can't be read is left
// out rather than guessed. The parts never add up to more than used: overlapping counts (shared extents) are scaled
// down together.
func (r diskReader) parts(st *unix.Statfs_t, used int64) []protocol.HostDiskPart {
	if st == nil || uint32(st.Type) != unix.BTRFS_SUPER_MAGIC {
		return nil
	}
	root, _, err := r.subvol(r.persist)
	if err != nil {
		return nil
	}
	dir := r.btrfsDir(st.Fsid, root)
	if dir == "" {
		return nil
	}
	q := filepath.Join(dir, "qgroups")
	if b, err := os.ReadFile(filepath.Join(q, "inconsistent")); err != nil || strings.TrimSpace(string(b)) != "0" {
		return nil // quotas off (no qgroups directory), or counts btrfs itself doesn't trust
	}
	referenced := func(group string) (uint64, bool) {
		v, err := readUint(filepath.Join(q, group, "referenced"))
		return v, err == nil
	}
	// The qgroup of a subvolume under /persist: 0/<id>, when path is a subvolume of its own (its root inode, another
	// id than /persist's); "" otherwise (then it is part of whatever holds its parent).
	subvolGroup := func(rel string) string {
		id, ino, err := r.subvol(filepath.Join(r.persist, rel))
		if err != nil || ino != subvolRootIno || id == root {
			return ""
		}
		return "0_" + strconv.FormatUint(id, 10)
	}
	var parts []protocol.HostDiskPart
	add := func(k protocol.HostDiskPartKey, v uint64) {
		parts = append(parts, protocol.HostDiskPart{Key: k, Bytes: safe(v)})
	}
	if v, ok := referenced(qgroupContainers); ok {
		add(protocol.HostDiskPartKeyContainers, v)
	}
	whombat, okWhombat := referenced(qgroupWhombat)
	work, okWork := uint64(0), true
	if g := subvolGroup(workSubvol); g != "" {
		work, okWork = referenced(g)
	}
	if okWhombat && okWork {
		add(protocol.HostDiskPartKeyWhombat, whombat-min(work, whombat))
	}
	if okWork && work > 0 {
		add(protocol.HostDiskPartKeyWork, work)
	}
	if g := subvolGroup(databaseSubvol); g != "" {
		if v, ok := referenced(g); ok {
			add(protocol.HostDiskPartKeyDatabase, v)
		}
	}
	if len(parts) == 0 {
		return nil
	}
	return fitParts(parts, used)
}

// btrfsDir is /sys/fs/btrfs/<fsid> of the filesystem statfs reported fsid for, root being the subvolume statfs looked
// at. btrfs's statfs fsid is its UUID's four big-endian words folded in two (0^2, 1^3), xor the subvolume id
// (fs/btrfs/super.c), so it is matched without a privilege, a device node or an ioctl.
func (r diskReader) btrfsDir(fsid unix.Fsid, root uint64) string {
	base := filepath.Join(r.sys, "fs", "btrfs")
	ents, err := os.ReadDir(base)
	if err != nil {
		return ""
	}
	for _, e := range ents {
		u, ok := parseUUID(e.Name())
		if !ok {
			continue
		}
		w := func(i int) uint32 { return binary.BigEndian.Uint32(u[i*4:]) }
		v0 := w(0) ^ w(2) ^ uint32(root>>32)
		v1 := w(1) ^ w(3) ^ uint32(root)
		if v0 == uint32(fsid.Val[0]) && v1 == uint32(fsid.Val[1]) {
			return filepath.Join(base, e.Name())
		}
	}
	return ""
}

func parseUUID(s string) ([16]byte, bool) {
	var u [16]byte
	if len(s) != 36 || s[8] != '-' || s[13] != '-' || s[18] != '-' || s[23] != '-' {
		return u, false
	}
	b, err := hex.DecodeString(strings.ReplaceAll(s, "-", ""))
	if err != nil || len(b) != 16 {
		return u, false
	}
	copy(u[:], b)
	return u, true
}

// fitParts scales the parts down proportionally (rounding down) when they add up to more than used.
func fitParts(parts []protocol.HostDiskPart, used int64) []protocol.HostDiskPart {
	var sum uint64
	for _, p := range parts {
		sum += uint64(p.Bytes)
	}
	if used < 0 {
		used = 0
	}
	if sum <= uint64(used) {
		return parts
	}
	for i := range parts {
		hi, lo := bits.Mul64(uint64(parts[i].Bytes), uint64(used))
		q, _ := bits.Div64(hi, lo, sum) // hi < sum: Bytes ≤ sum and used < sum
		parts[i].Bytes = int64(q)
	}
	return parts
}
