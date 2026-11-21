package collect

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"rackoon/internal/proto"
)

// ---- lsblk ---------------------------------------------------------------------

// flexUint accepts a JSON number or a numeric string (lsblk < 2.37 prints
// sizes as strings).
type flexUint uint64

func (f *flexUint) UnmarshalJSON(b []byte) error {
	s := strings.Trim(string(b), `"`)
	if s == "null" || s == "" {
		*f = 0
		return nil
	}
	v, err := strconv.ParseUint(s, 10, 64)
	if err != nil {
		return err
	}
	*f = flexUint(v)
	return nil
}

// flexBool accepts true/false or "1"/"0".
type flexBool bool

func (f *flexBool) UnmarshalJSON(b []byte) error {
	switch strings.Trim(string(b), `"`) {
	case "true", "1":
		*f = true
	default:
		*f = false
	}
	return nil
}

type lsblkDev struct {
	Name     string     `json:"name"`
	KName    string     `json:"kname"`
	MajMin   string     `json:"maj:min"`
	Type     string     `json:"type"`
	Size     flexUint   `json:"size"`
	Model    string     `json:"model"`
	Serial   string     `json:"serial"`
	Rota     flexBool   `json:"rota"`
	Tran     string     `json:"tran"`
	Vendor   string     `json:"vendor"`
	Children []lsblkDev `json:"children"`
}

func (d *lsblkDev) kname() string {
	if d.KName != "" {
		return d.KName
	}
	return d.Name
}

const lsblkColumns = "NAME,KNAME,MAJ:MIN,TYPE,SIZE,MODEL,SERIAL,ROTA,TRAN,VENDOR"

func parseLsblk(b []byte) ([]lsblkDev, error) {
	var v struct {
		BlockDevices []lsblkDev `json:"blockdevices"`
	}
	if err := json.Unmarshal(b, &v); err != nil {
		return nil, fmt.Errorf("lsblk: %w", err)
	}
	return v.BlockDevices, nil
}

var skipDiskPrefixes = []string{"loop", "nbd", "zd", "sr", "dm-", "md", "ram", "zram", "rbd", "drbd", "fd", "nullb"}

// isPhysicalDisk filters lsblk top-level devices down to real disks.
func isPhysicalDisk(d *lsblkDev) bool {
	if d.Type != "disk" || d.Size == 0 {
		return false
	}
	n := d.kname()
	for _, p := range skipDiskPrefixes {
		if strings.HasPrefix(n, p) {
			return false
		}
	}
	model := strings.TrimSpace(d.Model)
	// BMC virtual media (AMI "Virtual HDisk0", "Virtual CDROM0", ...).
	if strings.HasPrefix(model, "Virtual ") && (d.Tran == "usb" || strings.TrimSpace(d.Vendor) == "AMI") {
		return false
	}
	return true
}

func diskType(d *lsblkDev) string {
	if strings.HasPrefix(d.kname(), "nvme") || d.Tran == "nvme" {
		return "nvme"
	}
	if d.Rota {
		return "hdd"
	}
	return "ssd"
}

// ---- mountinfo -------------------------------------------------------------------

type mountEnt struct {
	ID, Parent int
	MajMin     string
	Root       string
	MountPoint string
	FSType     string
	Source     string
	Options    string // per-mount options ("rw,relatime")
	SuperOpts  string // superblock options ("ro,errors=remount-ro")
}

// readOnly reports whether the filesystem itself is read-only: its
// superblock options say "ro" (mounted ro, or remounted by the kernel
// after errors). The per-mount options do not count: the agent's systemd
// sandbox (ProtectSystem=strict) makes every mount read-only for the
// agent alone.
func (m mountEnt) readOnly() bool { return hasOpt(m.SuperOpts, "ro") }

// visibleMounts drops mounts the agent cannot reach because another mount
// covers them: a mount on the same mountpoint on top of it (its child at
// the same path), or one covering a parent. The agent's sandbox covers
// /home, /root and /run/user (ProtectHome=yes); statfs on a mount below
// would report the covering directory or fail.
func visibleMounts(ms []mountEnt) []mountEnt {
	byID := make(map[int]mountEnt, len(ms))
	covered := map[int]bool{}
	for _, m := range ms {
		byID[m.ID] = m
	}
	for _, m := range ms {
		if p, ok := byID[m.Parent]; ok && p.ID != m.ID && p.MountPoint == m.MountPoint {
			covered[p.ID] = true
		}
	}
	// A mount is hidden when it is covered, or when it sits below a covered
	// mount (one it does not cover itself) somewhere up its parent chain.
	hidden := func(m mountEnt) bool {
		if covered[m.ID] {
			return true
		}
		for depth := 0; depth < 64; depth++ {
			p, ok := byID[m.Parent]
			if !ok || p.ID == m.ID {
				return false
			}
			if covered[p.ID] && p.MountPoint != m.MountPoint {
				return true
			}
			m = p
		}
		return false
	}
	var out []mountEnt
	for _, m := range ms {
		if !hidden(m) {
			out = append(out, m)
		}
	}
	return out
}

func hasOpt(opts, o string) bool {
	for _, x := range strings.Split(opts, ",") {
		if x == o {
			return true
		}
	}
	return false
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

func parseMountinfo(b []byte) []mountEnt {
	var out []mountEnt
	scanLines(b, func(line string) {
		f := strings.Fields(line)
		if len(f) < 10 {
			return
		}
		sep := -1
		for i := 6; i < len(f); i++ {
			if f[i] == "-" {
				sep = i
				break
			}
		}
		if sep < 0 || sep+2 >= len(f) {
			return
		}
		id, _ := strconv.Atoi(f[0])
		parent, _ := strconv.Atoi(f[1])
		m := mountEnt{
			ID:         id,
			Parent:     parent,
			MajMin:     f[2],
			Root:       unescapeMount(f[3]),
			MountPoint: unescapeMount(f[4]),
			Options:    f[5],
			FSType:     f[sep+1],
			Source:     unescapeMount(f[sep+2]),
		}
		if sep+3 < len(f) {
			m.SuperOpts = f[sep+3]
		}
		out = append(out, m)
	})
	return out
}

// realFSTypes are local block filesystems worth reporting.
var realFSTypes = map[string]bool{
	"ext2": true, "ext3": true, "ext4": true, "xfs": true, "btrfs": true, "zfs": true,
	"vfat": true, "exfat": true, "f2fs": true, "ntfs": true, "ntfs3": true, "jfs": true,
	"reiserfs": true, "bcachefs": true, "nilfs2": true, "hfsplus": true,
}

// remoteFSTypes are network (and host-shared) filesystems: reported with
// Remote set. 9p and virtiofs are how a VM sees its host's directories;
// they hang like network mounts when the other side goes away.
var remoteFSTypes = map[string]bool{
	"nfs": true, "nfs4": true, "cifs": true, "smb3": true, "smbfs": true, "fuse.sshfs": true,
	"fuse.rclone": true, "glusterfs": true, "fuse.glusterfs": true, "ceph": true, "fuse.ceph": true,
	"9p": true, "virtiofs": true, "afs": true, "lustre": true, "fuse.s3fs": true, "fuse.juicefs": true,
}

// noReadOnlyCheck: filesystems that are read-only by design.
var noReadOnlyCheck = map[string]bool{"zfs": true, "squashfs": true, "iso9660": true, "udf": true, "erofs": true}

// parseFstab returns mountpoint -> options of /etc/fstab.
func parseFstab(b []byte) map[string]string {
	out := map[string]string{}
	scanLines(b, func(line string) {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			return
		}
		f := strings.Fields(line)
		if len(f) < 4 {
			return
		}
		out[unescapeMount(f[1])] = f[3]
	})
	return out
}

// internalSelf: the path and everything below it is internal.
var internalSelf = []string{"/proc", "/sys", "/dev", "/run", "/snap", "/var/lib/incus/storage-pools", "/var/lib/incus/devices", "/var/lib/incus/guestapi", "/var/lib/incus/shmounts", "/var/lib/lxcfs", "/var/snap/lxd", "/var/lib/kubelet", "/var/lib/lxc"}

// internalChildren: only mounts below the path are internal.
var internalChildren = []string{"/var/lib/docker", "/var/lib/containers", "/var/lib/lxd", "/var/lib/rancher", "/var/lib/containerd"}

func hasPathPrefix(p, prefix string) bool {
	if prefix == "/" {
		return true
	}
	return p == prefix || strings.HasPrefix(p, prefix+"/")
}

func isInternalMount(mp string) bool {
	for _, p := range internalSelf {
		if hasPathPrefix(mp, p) {
			return true
		}
	}
	for _, p := range internalChildren {
		if strings.HasPrefix(mp, p+"/") {
			return true
		}
	}
	return strings.Contains(mp, "/.zfs/snapshot")
}

// isIncusPoolMount reports mounts that belong to an Incus/LXD storage pool.
func isIncusPoolMount(mp string) bool {
	return hasPathPrefix(mp, "/var/lib/incus/storage-pools") || hasPathPrefix(mp, "/var/lib/lxd/storage-pools") ||
		hasPathPrefix(mp, "/var/snap/lxd/common/lxd/storage-pools")
}

// ---- zpool / zfs ------------------------------------------------------------------

type zpoolInfo struct {
	Name   string
	Size   uint64
	Alloc  uint64
	Health string
	Frag   *float64 // nil: "-" (no free-space map yet, or an old pool)
}

// parseZpoolList parses `zpool list -Hp -o name,size,alloc,health,frag`.
func parseZpoolList(b []byte) []zpoolInfo {
	var out []zpoolInfo
	scanLines(b, func(line string) {
		f := strings.Split(line, "\t")
		if len(f) < 4 {
			return
		}
		size, _ := strconv.ParseUint(f[1], 10, 64)
		alloc, _ := strconv.ParseUint(f[2], 10, 64)
		zi := zpoolInfo{Name: f[0], Size: size, Alloc: alloc, Health: f[3]}
		if len(f) > 4 {
			if v, err := strconv.ParseFloat(strings.TrimSuffix(f[4], "%"), 64); err == nil {
				zi.Frag = &v
			}
		}
		out = append(out, zi)
	})
	return out
}

type zpoolMember struct {
	Path  string // "/dev/nvme0n1p3" (or a bare name without -P)
	Class string // "mirror", "raidz1", "stripe", "log", "cache", "spare", "special", "dedup"
}

type zpoolLayout struct {
	Layout  string
	Members []zpoolMember

	// Health detail.
	Scan               string // the "scan:" line
	Status             string // the "status:" paragraph
	Read, Write, Cksum uint64 // error counters summed over the config table
	Faulted            []string
	ScrubState         string
	ScrubEnd           time.Time
	ScrubErrors        uint64
}

var (
	zfsScanErrRE = regexp.MustCompile(`with (\d+) errors? on (.+)$`)
	zfsOnDateRE  = regexp.MustCompile(` on (\w{3} \w{3} +\d+ \d\d:\d\d:\d\d \d{4})$`)
)

// parseZFSScan interprets the "scan:" line: none | scanning | finished |
// canceled, the end time and the errors of a finished scrub (or resilver,
// which replaces the scrub as the pool's last scan). Times are local.
func parseZFSScan(scan string, loc *time.Location) (state string, end time.Time, errs uint64) {
	s := strings.TrimSpace(scan)
	parseDate := func() time.Time {
		m := zfsOnDateRE.FindStringSubmatch(s)
		if m == nil {
			return time.Time{}
		}
		t, err := time.ParseInLocation("Mon Jan 2 15:04:05 2006", strings.Join(strings.Fields(m[1]), " "), loc)
		if err != nil {
			return time.Time{}
		}
		return t.UTC()
	}
	switch {
	case s == "" || strings.HasPrefix(s, "none requested"):
		return "none", time.Time{}, 0
	case strings.Contains(s, "in progress") || strings.Contains(s, "paused"):
		return "scanning", time.Time{}, 0
	case strings.Contains(s, "canceled"):
		return "canceled", parseDate(), 0
	case strings.HasPrefix(s, "scrub repaired") || strings.HasPrefix(s, "resilvered"):
		if m := zfsScanErrRE.FindStringSubmatch(s); m != nil {
			errs, _ = strconv.ParseUint(m[1], 10, 64)
		}
		return "finished", parseDate(), errs
	}
	return "", time.Time{}, 0
}

// parseZpoolStatus parses `zpool status -LPp` into the layout and member
// devices of each pool, the last scan, the status text, the summed error
// counters and the devices that are not ONLINE.
func parseZpoolStatus(b []byte) map[string]*zpoolLayout {
	out := map[string]*zpoolLayout{}
	var pool string
	var inConfig bool
	var section string // "" = data vdevs
	var topType string
	var dataTypes []string
	finish := func() {
		if pool == "" {
			return
		}
		l := out[pool]
		uniq := []string{}
		seen := map[string]bool{}
		for _, t := range dataTypes {
			if !seen[t] {
				seen[t] = true
				uniq = append(uniq, t)
			}
		}
		switch len(uniq) {
		case 0:
			l.Layout = ""
		case 1:
			l.Layout = uniq[0]
		default:
			l.Layout = strings.Join(uniq, "+")
		}
		dataTypes = nil
	}
	var para string // "status" while inside the status paragraph
	scanLines(b, func(line string) {
		trim := strings.TrimSpace(line)
		if p, ok := strings.CutPrefix(trim, "pool:"); ok {
			finish()
			pool = strings.TrimSpace(p)
			out[pool] = &zpoolLayout{}
			inConfig, para = false, ""
			return
		}
		if pool == "" {
			return
		}
		if k, v, ok := strings.Cut(trim, ":"); ok && !strings.HasPrefix(line, "\t") && !strings.Contains(k, " ") {
			switch k {
			case "status":
				out[pool].Status = strings.TrimSpace(v)
				para = "status"
				return
			case "scan":
				out[pool].Scan = strings.TrimSpace(v)
				para = ""
				return
			case "config":
				inConfig, section, para = true, "", ""
				return
			case "errors":
				inConfig, para = false, ""
				return
			case "action", "see", "state", "remove", "checkpoint":
				para = ""
				return
			}
		}
		if para == "status" && trim != "" {
			out[pool].Status += " " + trim
			return
		}
		if !inConfig || trim == "" || !strings.HasPrefix(line, "\t") {
			return
		}
		body := strings.TrimPrefix(line, "\t")
		indent := len(body) - len(strings.TrimLeft(body, " "))
		f := strings.Fields(body)
		if len(f) == 0 || f[0] == "NAME" {
			return
		}
		name := f[0]
		l := out[pool]
		if len(f) >= 5 {
			for i, p := range []*uint64{&l.Read, &l.Write, &l.Cksum} {
				if v, err := strconv.ParseUint(f[2+i], 10, 64); err == nil {
					*p += v
				}
			}
		}
		if len(f) >= 2 && indent > 0 && isDevName(name) {
			switch f[1] {
			case "ONLINE", "AVAIL", "INUSE":
			default:
				l.Faulted = append(l.Faulted, strings.TrimPrefix(name, "/dev/"))
			}
		}
		switch {
		case indent == 0:
			switch name {
			case "logs":
				section = "log"
			case "cache":
				section = "cache"
			case "spares":
				section = "spare"
			case "special":
				section = "special"
			case "dedup":
				section = "dedup"
			default:
				section = "" // the pool itself
			}
		case indent == 2:
			if isDevName(name) {
				topType = "stripe"
				if section == "" {
					dataTypes = append(dataTypes, "stripe")
					l.Members = append(l.Members, zpoolMember{Path: name, Class: "stripe"})
				} else {
					l.Members = append(l.Members, zpoolMember{Path: name, Class: section})
				}
			} else {
				topType = vdevType(name)
				if section == "" {
					dataTypes = append(dataTypes, topType)
				}
			}
		default:
			if isDevName(name) {
				class := topType
				if section != "" {
					class = section
				}
				l.Members = append(l.Members, zpoolMember{Path: name, Class: class})
			}
		}
	})
	finish()
	for _, l := range out {
		l.Status = strings.Join(strings.Fields(l.Status), " ")
		l.ScrubState, l.ScrubEnd, l.ScrubErrors = parseZFSScan(l.Scan, time.Local)
	}
	return out
}

// isDevName tells devices from grouping vdevs (mirror-0, raidz2-1, ...).
func isDevName(name string) bool {
	if strings.HasPrefix(name, "/") {
		return true
	}
	for _, p := range []string{"mirror-", "raidz", "draid", "replacing-", "spare-"} {
		if strings.HasPrefix(name, p) {
			return false
		}
	}
	return true
}

func vdevType(name string) string {
	switch {
	case strings.HasPrefix(name, "mirror"):
		return "mirror"
	case strings.HasPrefix(name, "raidz3"):
		return "raidz3"
	case strings.HasPrefix(name, "raidz2"):
		return "raidz2"
	case strings.HasPrefix(name, "raidz"):
		return "raidz1"
	case strings.HasPrefix(name, "draid"):
		return "draid"
	}
	return "stripe"
}

type zfsRoot struct {
	Name       string
	Used       uint64
	Avail      uint64
	MountPoint string
}

// parseZFSRoots parses `zfs list -Hp -d 0 -o name,used,avail,mountpoint`.
func parseZFSRoots(b []byte) map[string]zfsRoot {
	out := map[string]zfsRoot{}
	scanLines(b, func(line string) {
		f := strings.Split(line, "\t")
		if len(f) < 4 {
			return
		}
		used, _ := strconv.ParseUint(f[1], 10, 64)
		avail, _ := strconv.ParseUint(f[2], 10, 64)
		out[f[0]] = zfsRoot{Name: f[0], Used: used, Avail: avail, MountPoint: f[3]}
	})
	return out
}

// parseSwaps returns the device paths of swap partitions in /proc/swaps.
func parseSwaps(b []byte) []string {
	var out []string
	first := true
	scanLines(b, func(line string) {
		if first {
			first = false
			return
		}
		f := strings.Fields(line)
		if len(f) >= 2 && f[1] == "partition" {
			out = append(out, unescapeMount(f[0]))
		}
	})
	return out
}

// ---- assembling ---------------------------------------------------------------------

type statfsResult struct {
	Size, Used         uint64
	Inodes, InodesFree uint64
}

// storageInput is everything buildStorage needs; tests fill it from
// testdata.
type storageInput struct {
	Lsblk    []lsblkDev
	Mounts   []mountEnt
	Swaps    []string
	Zpools   []zpoolInfo
	ZpoolLay map[string]*zpoolLayout
	ZFSRoots map[string]zfsRoot
	Statfs   func(mount string) (statfsResult, error)
	Resolve  func(devPath string) string // /dev path -> kernel name
	// Fstab maps mountpoints to their fstab options; SeenRW holds mounts
	// this agent saw read-write before (for read-only detection of mounts
	// without an fstab entry).
	Fstab  map[string]string
	SeenRW map[string]bool
	// Unraid: also report the tmpfs /var/log (it fills up in practice).
	Unraid bool
}

type storageOut struct {
	Disks       []proto.Disk
	Filesystems []proto.Filesystem
	Pools       []proto.Pool
}

func buildStorage(in storageInput) storageOut {
	resolve := in.Resolve
	if resolve == nil {
		resolve = func(p string) string { return strings.TrimPrefix(p, "/dev/") }
	}
	// Index: physical disks, and kernel name / maj:min -> backing disks.
	type diskInfo struct {
		dev   *lsblkDev
		order int
	}
	disks := map[string]*diskInfo{}
	var diskOrder []string
	byKName := map[string]map[string]bool{}
	byMajMin := map[string]map[string]bool{}
	nodeByMajMin := map[string]*lsblkDev{}
	nodeByKName := map[string]*lsblkDev{}
	var walk func(d *lsblkDev, disk string)
	walk = func(d *lsblkDev, disk string) {
		k := d.kname()
		if byKName[k] == nil {
			byKName[k] = map[string]bool{}
		}
		byKName[k][disk] = true
		if d.MajMin != "" {
			if byMajMin[d.MajMin] == nil {
				byMajMin[d.MajMin] = map[string]bool{}
			}
			byMajMin[d.MajMin][disk] = true
			nodeByMajMin[d.MajMin] = d
		}
		nodeByKName[k] = d
		for i := range d.Children {
			walk(&d.Children[i], disk)
		}
	}
	for i := range in.Lsblk {
		d := &in.Lsblk[i]
		if !isPhysicalDisk(d) {
			continue
		}
		name := d.kname()
		if _, dup := disks[name]; dup {
			continue
		}
		disks[name] = &diskInfo{dev: d, order: len(diskOrder)}
		diskOrder = append(diskOrder, name)
		walk(d, name)
	}
	sortedDisks := func(set map[string]bool) []string {
		var out []string
		for d := range set {
			out = append(out, d)
		}
		sort.Slice(out, func(i, j int) bool { return disks[out[i]].order < disks[out[j]].order })
		return out
	}

	// Per-disk accumulators.
	type diskAcc struct {
		pools   []string // "tank, mirror member"
		poolSet map[string]bool
		mounts  []string
		system  bool
		incus   bool
		used    uint64
		hasUsed bool
		group   string // Disk.Pool
	}
	acc := map[string]*diskAcc{}
	for _, n := range diskOrder {
		acc[n] = &diskAcc{poolSet: map[string]bool{}}
	}

	// Mount sources for nesting checks: mountpoint -> source key.
	type realMount struct {
		mp  string
		key string // "zfs:<pool>" or maj:min
	}
	var reals []realMount
	for _, m := range in.Mounts {
		if !realFSTypes[m.FSType] {
			continue
		}
		key := m.MajMin
		if m.FSType == "zfs" {
			pool, _, _ := strings.Cut(m.Source, "/")
			key = "zfs:" + pool
		}
		reals = append(reals, realMount{m.MountPoint, key})
	}
	// nested reports whether mp's nearest enclosing real mount has the same
	// source (so mp adds nothing to a role text).
	nested := func(mp, key string) bool {
		best := ""
		bestKey := ""
		for _, r := range reals {
			if r.mp == mp || !hasPathPrefix(mp, r.mp) {
				continue
			}
			if len(r.mp) > len(best) {
				best, bestKey = r.mp, r.key
			}
		}
		return best != "" && bestKey == key
	}

	var out storageOut

	// ---- ZFS pools
	poolMounts := map[string][]string{} // non-internal mountpoints per pool
	poolIncus := map[string]bool{}
	for _, m := range in.Mounts {
		if m.FSType != "zfs" {
			continue
		}
		pool, _, _ := strings.Cut(m.Source, "/")
		if isIncusPoolMount(m.MountPoint) {
			poolIncus[pool] = true
		}
		if isInternalMount(m.MountPoint) {
			continue
		}
		poolMounts[pool] = append(poolMounts[pool], m.MountPoint)
	}
	for _, zp := range in.Zpools {
		lay := in.ZpoolLay[zp.Name]
		p := proto.Pool{Name: zp.Name, Health: zp.Health, SizeBytes: zp.Size, AllocBytes: zp.Alloc, FragPct: copyPtr(zp.Frag)}
		set := map[string]bool{}
		if lay != nil {
			p.Layout = lay.Layout
			p.ScrubState, p.ScrubEnd, p.ScrubErrors = lay.ScrubState, lay.ScrubEnd, lay.ScrubErrors
			p.ReadErrors, p.WriteErrors, p.CksumErrors = lay.Read, lay.Write, lay.Cksum
			p.Status = lay.Status
			p.Faulted = append([]string(nil), lay.Faulted...)
			for _, mem := range lay.Members {
				k := resolve(mem.Path)
				node := nodeByKName[k]
				for d := range byKName[k] {
					set[d] = true
					a := acc[d]
					desc := zp.Name
					switch mem.Class {
					case "mirror", "raidz1", "raidz2", "raidz3", "draid":
						desc = zp.Name + ", " + mem.Class + " member"
					case "log", "cache", "spare", "special", "dedup":
						desc = zp.Name + " " + mem.Class
					}
					if !a.poolSet[desc] {
						a.poolSet[desc] = true
						a.pools = append(a.pools, desc)
					}
					if a.group == "" {
						a.group = zp.Name
					}
					if poolIncus[zp.Name] {
						a.incus = true
					}
					// Share of the pool allocation on this device.
					switch mem.Class {
					case "mirror", "raidz1", "raidz2", "raidz3", "draid", "stripe":
						if node != nil && zp.Size > 0 {
							share := float64(node.Size) / float64(zp.Size)
							if share > 1 {
								share = 1
							}
							a.used += uint64(float64(zp.Alloc) * share)
							a.hasUsed = true
						}
					}
				}
			}
		}
		p.Disks = sortedDisks(set)
		if p.Disks == nil {
			p.Disks = []string{}
		}
		out.Pools = append(out.Pools, p)

		// Pool-level filesystem (one entry per pool: datasets share space).
		mounts := poolMounts[zp.Name]
		sort.Slice(mounts, func(i, j int) bool {
			if len(mounts[i]) != len(mounts[j]) {
				return len(mounts[i]) < len(mounts[j])
			}
			return mounts[i] < mounts[j]
		})
		fs := proto.Filesystem{Device: zp.Name, FSType: "zfs", Disks: p.Disks}
		if root, ok := in.ZFSRoots[zp.Name]; ok {
			fs.SizeBytes = root.Used + root.Avail
			fs.UsedBytes = root.Used
			if strings.HasPrefix(root.MountPoint, "/") && containsStr(mounts, root.MountPoint) {
				fs.Mount = root.MountPoint
			}
		} else if len(mounts) > 0 && in.Statfs != nil {
			if st, err := in.Statfs(mounts[0]); err == nil {
				fs.SizeBytes, fs.UsedBytes = st.Size, st.Used
			}
		}
		if fs.Mount == "" && len(mounts) > 0 {
			fs.Mount = mounts[0]
		}
		if fs.SizeBytes > 0 {
			out.Filesystems = append(out.Filesystems, fs)
		}
		// Role mounts of the pool.
		var top []string
		for _, mp := range mounts {
			if !nested(mp, "zfs:"+zp.Name) {
				top = append(top, mp)
			}
		}
		for _, d := range p.Disks {
			a := acc[d]
			a.mounts = append(a.mounts, top...)
			if containsStr(mounts, "/") {
				a.system = true
			}
		}
	}

	// ---- other filesystems: one per device (maj:min), shortest mountpoint
	cands := map[string]mountEnt{}
	var candOrder []string
	for _, m := range in.Mounts {
		wanted := realFSTypes[m.FSType] || remoteFSTypes[m.FSType] || (in.Unraid && m.FSType == "tmpfs" && m.MountPoint == "/var/log")
		if !wanted || m.FSType == "zfs" || isInternalMount(m.MountPoint) {
			continue
		}
		c, ok := cands[m.MajMin]
		if !ok {
			candOrder = append(candOrder, m.MajMin)
		}
		if !ok || len(m.MountPoint) < len(c.MountPoint) {
			cands[m.MajMin] = m
		}
	}
	for _, mm := range candOrder {
		m := cands[mm]
		fs := proto.Filesystem{Mount: m.MountPoint, Device: m.Source, FSType: m.FSType, Remote: remoteFSTypes[m.FSType]}
		backing := byMajMin[mm]
		fs.Disks = sortedDisks(backing)
		if in.Statfs != nil {
			st, err := in.Statfs(m.MountPoint)
			if err != nil {
				// A hung or failing mount stays listed with its error.
				fs.Error = truncate(err.Error(), 200)
				out.Filesystems = append(out.Filesystems, fs)
				continue
			}
			fs.SizeBytes, fs.UsedBytes = st.Size, st.Used
			if m.FSType != "btrfs" && st.Inodes > 0 && st.Inodes >= st.InodesFree {
				fs.InodesTotal, fs.InodesUsed = st.Inodes, st.Inodes-st.InodesFree
			}
		}
		if fs.SizeBytes == 0 {
			continue
		}
		if m.readOnly() && !noReadOnlyCheck[m.FSType] {
			if opts, ok := in.Fstab[m.MountPoint]; ok {
				fs.ReadOnly = !hasOpt(opts, "ro")
			} else {
				fs.ReadOnly = in.SeenRW[m.MountPoint]
			}
		}
		out.Filesystems = append(out.Filesystems, fs)

		// Used share and role mounts on the backing disks.
		node := nodeByMajMin[mm]
		share := fs.UsedBytes
		if n := len(fs.Disks); n > 1 && !(node != nil && node.Type == "raid1") {
			share = fs.UsedBytes / uint64(n)
		}
		for _, d := range fs.Disks {
			a := acc[d]
			a.used += share
			a.hasUsed = true
			// All mountpoints of this device that are not nested in a
			// mount of the same device.
			// Bind mounts of a subdirectory are skipped; btrfs subvolumes
			// (root "/@home") count as their own mounts.
			for _, m2 := range in.Mounts {
				if m2.MajMin != mm || isInternalMount(m2.MountPoint) || nested(m2.MountPoint, mm) || containsStr(a.mounts, m2.MountPoint) {
					continue
				}
				if m2.MountPoint != m.MountPoint && m2.Root != "/" && m2.FSType != "btrfs" {
					continue
				}
				a.mounts = append(a.mounts, m2.MountPoint)
			}
			if m.MountPoint == "/" {
				a.system = true
			}
			if a.group == "" && node != nil && strings.HasPrefix(node.Type, "raid") {
				a.group = node.kname()
			}
			if a.group == "" && node != nil && node.Type == "lvm" {
				a.group = lvmVG(node.Name)
			}
		}
	}

	// ---- swap
	for _, sw := range in.Swaps {
		k := resolve(sw)
		for d := range byKName[k] {
			if !containsStr(acc[d].mounts, "swap") {
				acc[d].mounts = append(acc[d].mounts, "swap")
			}
		}
	}

	// ---- disks
	for _, name := range diskOrder {
		d := disks[name].dev
		a := acc[name]
		disk := proto.Disk{
			Device:        name,
			Type:          diskType(d),
			Model:         strings.TrimSpace(d.Model),
			Serial:        strings.TrimSpace(d.Serial),
			CapacityBytes: uint64(d.Size),
			Pool:          a.group,
		}
		if a.hasUsed {
			u := a.used
			if u > disk.CapacityBytes {
				u = disk.CapacityBytes
			}
			disk.UsedBytes = ptr(u)
		}
		disk.Role = roleText(a.system, a.incus, a.pools, a.mounts)
		out.Disks = append(out.Disks, disk)
	}
	return out
}

func containsStr(xs []string, s string) bool {
	for _, x := range xs {
		if x == s {
			return true
		}
	}
	return false
}

// lvmVG extracts the volume group from a device-mapper name ("pve-root" ->
// "pve"; "--" escapes a dash).
func lvmVG(dm string) string {
	for i := 0; i < len(dm); i++ {
		if dm[i] == '-' {
			if i+1 < len(dm) && dm[i+1] == '-' {
				i++
				continue
			}
			return strings.ReplaceAll(dm[:i], "--", "-")
		}
	}
	return ""
}

// roleText builds "System · tank, mirror member · /, /boot/efi".
func roleText(system, incus bool, pools, mounts []string) string {
	ms := append([]string(nil), mounts...)
	sort.SliceStable(ms, func(i, j int) bool {
		ri, rj := mountRank(ms[i]), mountRank(ms[j])
		if ri != rj {
			return ri < rj
		}
		if len(ms[i]) != len(ms[j]) {
			return len(ms[i]) < len(ms[j])
		}
		return ms[i] < ms[j]
	})
	var parts []string
	switch {
	case system:
		parts = append(parts, "System")
	case incus:
		parts = append(parts, "Incus storage pool")
		if len(ms) == 0 {
			ms = []string{"/var/lib/incus"}
		}
	}
	parts = append(parts, pools...)
	if len(ms) > 4 {
		ms = append(ms[:4], "…")
	}
	if len(ms) > 0 {
		parts = append(parts, strings.Join(ms, ", "))
	}
	return strings.Join(parts, " · ")
}

func mountRank(m string) int {
	switch {
	case m == "/":
		return 0
	case m == "swap":
		return 3
	case hasPathPrefix(m, "/boot"):
		return 1
	}
	return 2
}

// ---- collector -----------------------------------------------------------------------

type diskRef struct {
	Dev  string
	Type string
	Tran string // lsblk transport: sata, nvme, usb, sas, ...
}

// diskCollector runs lsblk, statvfs and zpool every 60 s.
type diskCollector struct {
	root fsRoot

	mu     sync.Mutex
	last   storageOut
	ok     bool
	trans  map[string]string // disk -> lsblk transport
	seenRW map[string]bool   // mounts seen read-write since the agent started
	// statusP: `zpool status -p` works (OpenZFS 0.8+).
	statusNoP bool
}

func newDiskCollector(root fsRoot) *diskCollector { return &diskCollector{root: root} }

func (c *diskCollector) run(ctx context.Context) error {
	var errs []error
	c.mu.Lock()
	seen := make(map[string]bool, len(c.seenRW))
	for k, v := range c.seenRW {
		seen[k] = v
	}
	noP := c.statusNoP
	c.mu.Unlock()
	in := storageInput{
		Statfs:  statfs,
		Resolve: resolveDev,
		SeenRW:  seen,
		Unraid:  isUnraid(c.root),
	}
	if b, err := c.root.read("/etc/fstab"); err == nil {
		in.Fstab = parseFstab(b)
	}
	out, err := runCmd(ctx, 15*time.Second, "lsblk", "-J", "-b", "-o", lsblkColumns)
	if err != nil {
		errs = append(errs, err)
	} else if in.Lsblk, err = parseLsblk(out); err != nil {
		errs = append(errs, err)
	}
	if b, err := c.root.read("/proc/self/mountinfo"); err == nil {
		in.Mounts = visibleMounts(parseMountinfo(b))
	} else {
		errs = append(errs, err)
	}
	if b, err := c.root.read("/proc/swaps"); err == nil {
		in.Swaps = parseSwaps(b)
	}
	if c.root.exists("/proc/spl/kstat/zfs") || c.root.exists("/sys/module/zfs") {
		if _, err := lookPath("zpool"); err == nil {
			if out, err := runCmd(ctx, 20*time.Second, "zpool", "list", "-Hp", "-o", "name,size,alloc,health,frag"); err == nil {
				in.Zpools = parseZpoolList(out)
			} else {
				errs = append(errs, err)
			}
			if len(in.Zpools) > 0 {
				args := []string{"status", "-LPp"}
				if noP {
					args = []string{"status", "-LP"}
				}
				out, err := runCmd(ctx, 20*time.Second, "zpool", args...)
				if err != nil && !noP && strings.Contains(err.Error(), "invalid option") {
					// OpenZFS before 0.8 has no -p (exact numbers).
					noP = true
					out, err = runCmd(ctx, 20*time.Second, "zpool", "status", "-LP")
				}
				if err == nil {
					in.ZpoolLay = parseZpoolStatus(out)
				} else {
					errs = append(errs, err)
				}
				if out, err := runCmd(ctx, 20*time.Second, "zfs", "list", "-Hp", "-d", "0", "-o", "name,used,avail,mountpoint"); err == nil {
					in.ZFSRoots = parseZFSRoots(out)
				} else {
					errs = append(errs, err)
				}
			}
		}
	}
	res := buildStorage(in)
	c.mu.Lock()
	// Keep the previous disk list if lsblk failed this time.
	if len(in.Lsblk) == 0 && c.ok {
		res.Disks = c.last.Disks
	} else if len(in.Lsblk) > 0 {
		c.trans = map[string]string{}
		for _, d := range in.Lsblk {
			c.trans[d.kname()] = d.Tran
		}
	}
	if c.seenRW == nil {
		c.seenRW = map[string]bool{}
	}
	for _, m := range in.Mounts {
		if !m.readOnly() {
			c.seenRW[m.MountPoint] = true
		}
	}
	c.statusNoP = noP
	c.last = res
	c.ok = c.ok || len(in.Lsblk) > 0
	c.mu.Unlock()
	return errors.Join(errs...)
}

// statfs returns the usable size and the used space of a mount the way df
// computes its percentage: the blocks reserved for root (5% on ext4 by
// default) are not part of the size, so a filesystem that refuses writes
// shows as 100% full rather than 95%.
func statfs(mount string) (statfsResult, error) {
	st, err := statfsTimeout(mount, statfsWait)
	if err != nil {
		return statfsResult{}, err
	}
	bs := statfsFrsize(&st)
	if bs == 0 {
		bs = uint64(st.Bsize)
	}
	used := (st.Blocks - st.Bfree) * bs
	return statfsResult{Size: used + st.Bavail*bs, Used: used, Inodes: st.Files, InodesFree: st.Ffree}, nil
}

// statfsWait bounds one statfs call (a hung network or dying disk blocks
// the syscall forever).
const statfsWait = 5 * time.Second

var (
	statfsMu   sync.Mutex
	statfsHung = map[string]bool{} // mounts with a statfs still blocked
)

// statfsTimeout runs statfs in a goroutine and gives up after d. A mount
// whose call is still blocked is skipped until that call returns, so a hung
// mount costs one goroutine, not one per collection.
func statfsTimeout(mount string, d time.Duration) (syscall.Statfs_t, error) {
	statfsMu.Lock()
	if statfsHung[mount] {
		statfsMu.Unlock()
		return syscall.Statfs_t{}, fmt.Errorf("statfs %s: still blocked", mount)
	}
	statfsMu.Unlock()
	type res struct {
		st  syscall.Statfs_t
		err error
	}
	ch := make(chan res, 1)
	go func() {
		var st syscall.Statfs_t
		err := syscall.Statfs(mount, &st)
		ch <- res{st, err}
		statfsMu.Lock()
		delete(statfsHung, mount)
		statfsMu.Unlock()
	}()
	select {
	case r := <-ch:
		return r.st, r.err
	case <-time.After(d):
		statfsMu.Lock()
		defer statfsMu.Unlock()
		select {
		case r := <-ch: // finished just now; its cleanup may already have run
			delete(statfsHung, mount)
			return r.st, r.err
		default:
			statfsHung[mount] = true // the goroutine clears it when the call returns
		}
		return syscall.Statfs_t{}, fmt.Errorf("statfs %s: timed out after %s", mount, d)
	}
}

// resolveDev maps "/dev/mapper/x" or "/dev/disk/by-id/..." to the kernel
// name ("dm-0", "sda1").
func resolveDev(p string) string {
	if !strings.HasPrefix(p, "/") {
		return p
	}
	if r, err := filepath.EvalSymlinks(p); err == nil {
		p = r
	}
	return strings.TrimPrefix(p, "/dev/")
}

// fill copies the cached storage view into the report.
func (c *diskCollector) fill(r *proto.Report) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.ok {
		return
	}
	r.Disks = make([]proto.Disk, len(c.last.Disks))
	copy(r.Disks, c.last.Disks)
	for i := range r.Disks {
		if u := r.Disks[i].UsedBytes; u != nil {
			r.Disks[i].UsedBytes = ptr(*u)
		}
	}
	r.Filesystems = append([]proto.Filesystem{}, c.last.Filesystems...)
	r.Pools = append([]proto.Pool{}, c.last.Pools...)
}

// devices returns the physical disks for the SMART collector.
func (c *diskCollector) devices() []diskRef {
	c.mu.Lock()
	defer c.mu.Unlock()
	var out []diskRef
	for _, d := range c.last.Disks {
		out = append(out, diskRef{Dev: d.Device, Type: d.Type, Tran: c.trans[d.Device]})
	}
	return out
}
