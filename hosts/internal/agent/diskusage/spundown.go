package diskusage

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"rackoon/internal/agent/macos"
	"rackoon/internal/proto"
)

type standbyState int

const (
	standbyUnknown standbyState = iota
	standbyAwake
	standbyAsleep
)

type rotationalState int

const (
	rotationalUnknown rotationalState = iota
	rotationalNo
	rotationalYes
)

type standbyCheckResult struct {
	spun              []string
	unknown           []string
	unknownRotational []string
	unknownBacking    bool
	partialBacking    bool
}

func (c standbyCheckResult) shouldSkip() bool {
	return len(c.spun) > 0 || len(c.unknown) > 0 || len(c.unknownRotational) > 0 || c.unknownBacking || c.partialBacking
}

func (c standbyCheckResult) code() string {
	if len(c.spun) > 0 {
		return CodeSpunDown
	}
	return CodeStandbyUnknown
}

// spunDownDisksFor returns the names of any backing disks of mount that are
// currently spun down, plus any backing disks whose rotational or spin state
// could not be confirmed, or flags unknownBacking when no backing disks could
// be established at all. It reads only RAM/sysfs metadata and non-waking
// standby queries so sleeping drives are never spun up.
func (r *Runner) spunDownDisksFor(ctx context.Context, mount string, target mountInfo) standbyCheckResult {
	// Virtual/RAM mounts (such as Unraid's tmpfs /var/log) have no physical disks.
	if target.Virtual || target.FSType == "tmpfs" {
		return standbyCheckResult{}
	}
	if r.isDarwin() {
		return r.spunDownDisksForDarwin(ctx, mount, target)
	}

	spun := map[string]bool{}
	spunDevs := map[string]bool{}
	unraidAwake := map[string]bool{}
	unknown := map[string]bool{}
	unknownRotational := map[string]bool{}
	var backing []string
	var invRawBacking []string
	var rotational map[string]bool
	var diskModels map[string]string
	var rep *proto.Report

	// 1. Unraid's emhttp state in RAM (/var/local/emhttp/disks.ini) knows every
	// array and pool disk's spin state without touching any drive.
	unraidFound := false
	if r.isUnraid() {
		var unraidDevs []string
		unraidFound, unraidDevs = r.checkUnraidSpunDown(mount, spun, spunDevs, unraidAwake, unknown)
		backing = append(backing, unraidDevs...)
	}

	// 2. Read the latest inventory report for disk types, models and ZFS/mount
	// backing disks.
	if r.inventory != nil {
		if rep = r.inventory(); rep != nil {
			rotational = make(map[string]bool, len(rep.Disks))
			diskModels = make(map[string]string, len(rep.Disks))
			for _, d := range rep.Disks {
				if d.Device != "" && d.Model != "" {
					diskModels[d.Device] = d.Model
				}
				switch d.Type {
				case "hdd":
					rotational[d.Device] = true
				case "ssd", "nvme":
					rotational[d.Device] = false
				}
			}
			for _, fs := range rep.Filesystems {
				if filepath.Clean(fs.Mount) == mount {
					invRawBacking = append(invRawBacking, fs.Disks...)
				}
			}
			if target.FSType == "zfs" {
				pool := zfsPoolName(target.Source)
				for _, p := range rep.Pools {
					if p.Name == pool {
						invRawBacking = append(invRawBacking, p.Disks...)
					}
				}
			}
		}
	}

	// 3. Derive complete backing physical disks from the mount's source and
	// kernel sysfs metadata (Btrfs /sys/fs/btrfs/<fsid>/devices, bcachefs
	// /sys/fs/bcachefs/<uuid>/dev-*, LVM/dm/md slaves, partitions). Also expand
	// any stacked, partition or virtual entries reported by inventory.
	srcDevs, srcUnresolved := r.backingDisksFromSource(target)
	backing = append(backing, srcDevs...)

	invUnresolved := false
	if len(invRawBacking) > 0 {
		if unraidFound {
			backing = append(backing, invRawBacking...)
		} else {
			expanded, unres := r.resolveBlockDevices(invRawBacking)
			backing = append(backing, expanded...)
			invUnresolved = unres
		}
	}

	// Cross-check inventory Standby flags and Unraid report state against all
	// resolved backing disks, including disks discovered via sysfs.
	if rep != nil {
		backingSet := map[string]bool{}
		for _, b := range backing {
			if b != "" {
				backingSet[b] = true
			}
		}
		for _, d := range rep.Disks {
			if backingSet[d.Device] && d.Standby {
				spun[d.Device] = true
			}
		}
		// Also cross-check Unraid report state in case disks.ini wasn't present
		// (for example in unit tests with a synthetic inventory).
		if rep.Unraid != nil {
			uDevs := r.checkUnraidReportSpunDown(mount, backingSet, rep.Unraid, spun, spunDevs, rotational)
			backing = append(backing, uDevs...)
		}
	}

	hasBacking := unraidFound
	for _, dev := range backing {
		if dev != "" {
			hasBacking = true
			break
		}
	}
	unresolvedBacking := (srcUnresolved && !unraidFound) || invUnresolved

	// 4. Live non-waking standby check for rotational backing disks not already
	// marked spun down (smartctl -n standby / hdparm -C). If a backing disk's
	// rotational state or spin state cannot be determined, skip rather than walk
	// and risk waking it.
	checked := map[string]bool{}
	for _, dev := range backing {
		if dev == "" || checked[dev] || spun[dev] || spunDevs[dev] {
			continue
		}
		checked[dev] = true
		switch r.rotationalStateOf(dev, rotational, diskModels) {
		case rotationalNo:
			continue
		case rotationalUnknown:
			if !unraidAwake[dev] {
				unknownRotational[dev] = true
			}
			continue
		case rotationalYes:
		}
		state := standbyUnknown
		if r.checkStandby != nil {
			pctx, cancel := context.WithTimeout(ctx, 4*time.Second)
			state = r.checkStandby(pctx, dev)
			cancel()
		}
		switch state {
		case standbyAsleep:
			spun[dev] = true
		case standbyAwake:
		default:
			if !unraidAwake[dev] {
				unknown[dev] = true
			}
		}
	}

	return buildStandbyCheckResult(spun, unknown, unknownRotational, hasBacking, unresolvedBacking)
}

func buildStandbyCheckResult(spun, unknown, unknownRotational map[string]bool, hasBacking, unresolvedBacking bool) standbyCheckResult {
	var res standbyCheckResult
	if len(spun) > 0 {
		res.spun = make([]string, 0, len(spun))
		for k := range spun {
			res.spun = append(res.spun, k)
		}
	}
	if len(unknown) > 0 {
		res.unknown = make([]string, 0, len(unknown))
		for k := range unknown {
			res.unknown = append(res.unknown, k)
		}
	}
	if len(unknownRotational) > 0 {
		res.unknownRotational = make([]string, 0, len(unknownRotational))
		for k := range unknownRotational {
			res.unknownRotational = append(res.unknownRotational, k)
		}
	}
	if !hasBacking {
		res.unknownBacking = true
	} else if unresolvedBacking {
		res.partialBacking = true
	}
	return res
}

// spunDownDisksForDarwin resolves backing physical disks and rotational/standby
// state on macOS using inventory and diskutil plist output, never Linux /sys.
func (r *Runner) spunDownDisksForDarwin(ctx context.Context, mount string, target mountInfo) standbyCheckResult {
	spun := map[string]bool{}
	unknown := map[string]bool{}
	unknownRotational := map[string]bool{}
	var backing []string
	var rotational map[string]bool
	invDisks := map[string]bool{}

	srcContainer := macos.ContainerOfDevice(target.Source)
	invBacking := 0
	if r.inventory != nil {
		if rep := r.inventory(); rep != nil {
			rotational = make(map[string]bool, len(rep.Disks))
			for _, d := range rep.Disks {
				if d.Device != "" {
					invDisks[d.Device] = true
				}
				switch d.Type {
				case "hdd":
					rotational[d.Device] = true
				case "ssd", "nvme":
					rotational[d.Device] = false
				}
			}
			for _, fs := range rep.Filesystems {
				matched := filepath.Clean(fs.Mount) == mount
				if !matched && srcContainer != "" && fs.Device == "/dev/"+srcContainer {
					matched = true
				}
				if matched && len(fs.Disks) > 0 {
					backing = append(backing, fs.Disks...)
					invBacking += len(fs.Disks)
				}
			}
			backingSet := map[string]bool{}
			for _, b := range backing {
				backingSet[b] = true
			}
			for _, d := range rep.Disks {
				if backingSet[d.Device] && d.Standby {
					spun[d.Device] = true
				}
			}
		}
	}

	infos := map[string]*macos.DiskInfo{}
	unresolvedBacking := false
	if invBacking == 0 {
		var srcDevs []string
		srcDevs, unresolvedBacking = r.backingDisksFromSourceDarwin(ctx, target, infos)
		backing = append(backing, srcDevs...)
	}

	var resolvedBacking []string
	seenResolved := map[string]bool{}
	for _, dev := range backing {
		if dev == "" {
			continue
		}
		if invBacking > 0 && !invDisks[dev] {
			devs, unres := r.resolveDarwinDisk(ctx, dev, infos)
			if unres {
				unresolvedBacking = true
			}
			for _, d := range devs {
				if !seenResolved[d] {
					seenResolved[d] = true
					resolvedBacking = append(resolvedBacking, d)
				}
			}
			continue
		}
		if !seenResolved[dev] {
			seenResolved[dev] = true
			resolvedBacking = append(resolvedBacking, dev)
		}
	}

	hasBacking := len(resolvedBacking) > 0
	checked := map[string]bool{}
	for _, dev := range resolvedBacking {
		if dev == "" || checked[dev] || spun[dev] {
			continue
		}
		checked[dev] = true
		switch r.rotationalStateOfDarwin(ctx, dev, rotational, infos) {
		case rotationalNo:
			continue
		case rotationalUnknown:
			unknownRotational[dev] = true
			continue
		case rotationalYes:
		}
		state := standbyUnknown
		if r.checkStandby != nil {
			pctx, cancel := context.WithTimeout(ctx, 4*time.Second)
			state = r.checkStandby(pctx, dev)
			cancel()
		}
		switch state {
		case standbyAsleep:
			spun[dev] = true
		case standbyAwake:
		default:
			unknown[dev] = true
		}
	}

	return buildStandbyCheckResult(spun, unknown, unknownRotational, hasBacking, unresolvedBacking)
}

func (r *Runner) backingDisksFromSourceDarwin(ctx context.Context, target mountInfo, infos map[string]*macos.DiskInfo) ([]string, bool) {
	whole := macos.ContainerOfDevice(target.Source)
	if whole == "" {
		return nil, true
	}
	return r.resolveDarwinDisk(ctx, whole, infos)
}

func (r *Runner) resolveDarwinDisk(ctx context.Context, start string, infos map[string]*macos.DiskInfo) ([]string, bool) {
	visited := map[string]bool{}
	found := map[string]bool{}
	var out []string
	unresolved := false
	var list *macos.DiskList
	listTried := false

	var walk func(id string)
	walk = func(id string) {
		id = macos.WholeDiskOf(strings.TrimPrefix(id, "/dev/"))
		if id == "" || visited[id] {
			return
		}
		visited[id] = true

		di, err := r.darwinDiskInfo(ctx, id, infos)
		if err != nil || di == nil {
			unresolved = true
			return
		}
		if len(di.APFSPhysicalStores) > 0 {
			for _, store := range di.APFSPhysicalStores {
				walk(store)
			}
			return
		}
		if di.APFSContainer != "" && di.APFSContainer != id {
			walk(di.APFSContainer)
			return
		}
		if di.ParentWholeDisk != "" && di.ParentWholeDisk != id {
			walk(di.ParentWholeDisk)
			return
		}
		// Some macOS versions omit APFSPhysicalStores in `diskutil info` for a
		// synthesized container; fall back to `diskutil list -plist` once.
		if di.Virtual && !di.RAIDMaster && !di.CoreStorage && di.Bus != "Disk Image" {
			if !listTried {
				listTried = true
				list = r.darwinDiskList(ctx)
			}
			if list != nil {
				if stores := list.Containers[id]; len(stores) > 0 {
					for _, store := range stores {
						walk(store)
					}
					return
				}
			}
			unresolved = true
			return
		}
		if di.Virtual || di.RAIDMaster || di.CoreStorage {
			unresolved = true
			return
		}
		if !found[id] {
			found[id] = true
			out = append(out, id)
		}
	}

	walk(start)
	return out, unresolved
}

func (r *Runner) darwinDiskInfo(ctx context.Context, dev string, cache map[string]*macos.DiskInfo) (*macos.DiskInfo, error) {
	if cache != nil {
		if di, ok := cache[dev]; ok {
			return di, nil
		}
	}
	if r.runCmd == nil || dev == "" || strings.ContainsAny(dev, "/\\ \t\n\r") {
		return nil, os.ErrNotExist
	}
	pctx, cancel := context.WithTimeout(ctx, 4*time.Second)
	out, err := r.runCmd(pctx, "diskutil", "info", "-plist", dev)
	cancel()
	if err != nil {
		return nil, err
	}
	di, err := macos.ParseDiskutilInfo(out)
	if err != nil {
		return nil, err
	}
	if cache != nil {
		cache[dev] = di
	}
	return di, nil
}

func (r *Runner) darwinDiskList(ctx context.Context) *macos.DiskList {
	if r.runCmd == nil {
		return nil
	}
	pctx, cancel := context.WithTimeout(ctx, 4*time.Second)
	out, err := r.runCmd(pctx, "diskutil", "list", "-plist")
	cancel()
	if err != nil {
		return nil
	}
	list, err := macos.ParseDiskutilList(out)
	if err != nil {
		return nil
	}
	return list
}

func (r *Runner) rotationalStateOfDarwin(ctx context.Context, dev string, rotational map[string]bool, cache map[string]*macos.DiskInfo) rotationalState {
	if rotational != nil {
		if h, ok := rotational[dev]; ok {
			if h {
				return rotationalYes
			}
			return rotationalNo
		}
	}
	di, err := r.darwinDiskInfo(ctx, dev, cache)
	if err != nil || di == nil {
		return rotationalUnknown
	}
	if di.SolidStateKnown {
		if di.SolidState {
			return rotationalNo
		}
		return rotationalYes
	}
	if di.Internal && (di.Bus == "Apple Fabric" || strings.Contains(strings.ToLower(di.Bus), "nvme")) {
		return rotationalNo
	}
	return rotationalUnknown
}

func (r *Runner) rotationalStateOf(dev string, rotational map[string]bool, diskModels map[string]string) rotationalState {
	// Virtual guest disks (virtio-blk, Xen xvd, hypervisor SCSI/SATA/IDE)
	// cannot spin down even when the guest kernel reports rotational=1. Check
	// this per disk rather than per host so PCI-passed-through physical HDDs in
	// a VM still have their standby state verified.
	if r.isVirtualGuestDisk(dev, diskModels) {
		return rotationalNo
	}
	if rotational != nil {
		if h, ok := rotational[dev]; ok {
			if h {
				return rotationalYes
			}
			return rotationalNo
		}
	}
	if strings.HasPrefix(dev, "nvme") || strings.HasPrefix(dev, "mmcblk") || strings.HasPrefix(dev, "pmem") {
		return rotationalNo
	}
	// Reading /sys/block/<dev>/queue/rotational reads kernel state only.
	b, err := os.ReadFile(r.hostPath(filepath.Join("/sys/block", dev, "queue/rotational")))
	if err != nil {
		return rotationalUnknown
	}
	switch strings.TrimSpace(string(b)) {
	case "1":
		return rotationalYes
	case "0":
		return rotationalNo
	default:
		return rotationalUnknown
	}
}

// isVirtualGuestDisk reports whether dev is a hypervisor virtual disk that
// cannot spin down (virtio-blk/scsi, Xen, VMware, VirtualBox, Hyper-V, QEMU,
// GCE, Parallels, bhyve). It reads only sysfs metadata and inventory models.
func (r *Runner) isVirtualGuestDisk(dev string, diskModels map[string]string) bool {
	if isParavirtualBlockName(dev) {
		return true
	}
	// Check sysfs driver and device bus path (e.g. virtio-blk, virtio-scsi,
	// Hyper-V hv_storvsc/VMBUS, VMware vmw_pvscsi, Xen xen-blkfront).
	for _, p := range []string{
		filepath.Join("/sys/block", dev, "device/driver"),
		filepath.Join("/sys/class/block", dev, "device/driver"),
	} {
		if link, err := os.Readlink(r.hostPath(p)); err == nil {
			switch filepath.Base(filepath.Clean(link)) {
			case "virtio_blk", "xen-blkfront", "hv_storvsc", "vmw_pvscsi", "vbd":
				return true
			}
		}
	}
	for _, p := range []string{
		filepath.Join("/sys/block", dev),
		filepath.Join("/sys/class/block", dev),
		filepath.Join("/sys/block", dev, "device"),
	} {
		if link, err := os.Readlink(r.hostPath(p)); err == nil && isHypervisorSysfsPath(link) {
			return true
		}
	}
	vendor := r.readSysfsTrimmed(filepath.Join("/sys/block", dev, "device/vendor"))
	model := r.readSysfsTrimmed(filepath.Join("/sys/block", dev, "device/model"))
	if isHypervisorDiskIdentity(vendor, model) {
		return true
	}
	if diskModels != nil {
		if invModel := diskModels[dev]; invModel != "" && isHypervisorDiskIdentity(vendor, invModel) {
			return true
		}
	}
	return false
}

func (r *Runner) readSysfsTrimmed(path string) string {
	b, err := os.ReadFile(r.hostPath(path))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

func isParavirtualBlockName(name string) bool {
	if strings.HasPrefix(name, "vd") && allLowerLetters(name[2:]) {
		return true
	}
	if strings.HasPrefix(name, "xvd") && allLowerLetters(name[3:]) {
		return true
	}
	return false
}

func isHypervisorSysfsPath(link string) bool {
	for _, seg := range strings.Split(filepath.ToSlash(filepath.Clean(link)), "/") {
		low := strings.ToLower(seg)
		if strings.HasPrefix(low, "virtio") || strings.HasPrefix(low, "vbd-") ||
			low == "vmbus" || strings.HasPrefix(low, "vmbus:") || strings.HasPrefix(low, "vmbus_") {
			return true
		}
	}
	return false
}

func isHypervisorDiskIdentity(vendor, model string) bool {
	v := strings.ToUpper(strings.TrimSpace(vendor))
	m := strings.ToUpper(strings.TrimSpace(model))
	if v == "" && m == "" {
		return false
	}
	vClean := strings.TrimRight(v, ",. ")
	switch vClean {
	case "QEMU", "VMWARE", "VBOX", "XEN", "XENSRC", "PARALLELS", "BHYVE", "HYPER-V", "VIRTIO", "NUTANIX", "OPENSTACK":
		return true
	}
	if (vClean == "MSFT" || vClean == "MICROSOFT") && (strings.Contains(m, "VIRTUAL") || strings.Contains(m, "HYPER-V")) {
		return true
	}
	if vClean == "GOOGLE" && (strings.Contains(m, "PERSISTENTDISK") || strings.Contains(m, "EPHEMERAL")) {
		return true
	}
	if vClean == "RED HAT" && (strings.Contains(m, "VIRTIO") || strings.Contains(m, "QEMU")) {
		return true
	}
	for _, needle := range []string{
		"QEMU HARDDISK",
		"QEMU DVD-ROM",
		"VMWARE VIRTUAL",
		"VBOX HARDDISK",
		"MSFT VIRTUAL DISK",
		"MICROSOFT VIRTUAL",
		"HYPER-V",
		"XEN VIRTUAL",
		"XENSRC",
		"GOOGLE PERSISTENTDISK",
		"PERSISTENTDISK",
		"BHYVE",
		"PARALLELS",
		"VIRTIO",
	} {
		if strings.Contains(m, needle) {
			return true
		}
	}
	if m == "VIRTUAL HD" && (vClean == "" || vClean == "ATA" || vClean == "MSFT" || vClean == "MICROSOFT") {
		return true
	}
	return false
}

// zfsPoolName extracts the pool name from a ZFS dataset or snapshot mount
// source ("tank/media", "tank/media@snap", "tank@snap", "tank").
func zfsPoolName(source string) string {
	pool, _, _ := strings.Cut(source, "/")
	pool, _, _ = strings.Cut(pool, "@")
	return pool
}

// isUnresolvablePooledFS reports filesystems that merge multiple arbitrary
// paths or branches whose complete set of underlying block devices cannot be
// established reliably from mountinfo/sysfs without touching the mount.
func isUnresolvablePooledFS(fsType string) bool {
	switch fsType {
	case "fuse.mergerfs", "mergerfs",
		"fuse.unionfs", "fuse.unionfs-fuse", "unionfs",
		"fuse.mhddfs", "mhddfs",
		"aufs", "overlay":
		return true
	}
	return strings.HasPrefix(fsType, "fuse.") && fsType != "fuse.shfs"
}

// backingDisksFromSource derives underlying physical block devices from a
// mount's filesystem type, source path and major:minor via sysfs (Btrfs
// /sys/fs/btrfs/<fsid>/devices, bcachefs /sys/fs/bcachefs/<uuid>/dev-*,
// partition -> disk, and LVM/dm/md -> member disks recursively). Reads only
// /dev symlinks and /sys metadata. unresolved is true if the complete backing
// device list cannot be confirmed or any stacked/virtual device cannot be
// resolved to physical disks.
func (r *Runner) backingDisksFromSource(target mountInfo) ([]string, bool) {
	if isUnresolvablePooledFS(target.FSType) {
		return nil, true
	}

	var seeds []string
	seenSeed := map[string]bool{}
	unresolved := false
	addSeed := func(name string) {
		if name == "" || name == "." || name == "/" || strings.Contains(name, "/") || seenSeed[name] {
			return
		}
		seenSeed[name] = true
		seeds = append(seeds, name)
	}

	switch target.FSType {
	case "btrfs":
		// Btrfs mounts carry an anonymous major:minor (0:N) and mountinfo names
		// only one member device, so checking target.Source alone can miss
		// sleeping members of a multi-device filesystem. Always read the full
		// member list from /sys/fs/btrfs/<fsid>/devices/.
		devs, ok := r.btrfsBackingDevices(target)
		if !ok || len(devs) == 0 {
			return nil, true
		}
		for _, d := range devs {
			addSeed(d)
		}
	case "bcachefs":
		// bcachefs can span multiple devices (or add devices after mount) with
		// an anonymous major:minor; read the full member list from sysfs.
		devs, ok := r.bcachefsBackingDevices(target)
		if !ok || len(devs) == 0 {
			return nil, true
		}
		for _, d := range devs {
			addSeed(d)
		}
	default:
		var majMinDev string
		if target.MajMin != "" && !strings.HasPrefix(target.MajMin, "0:") {
			if link, err := os.Readlink(r.hostPath(filepath.Join("/sys/dev/block", target.MajMin))); err == nil {
				if base := filepath.Base(filepath.Clean(link)); base != "" && base != "." && base != "/" {
					majMinDev = base
				}
			}
		}
		if strings.HasPrefix(target.Source, "/dev/") {
			if dev, ok := r.resolveSourceBlockDev(target.Source); ok {
				addSeed(dev)
			} else if majMinDev == "" {
				unresolved = true
			}
		}
		if majMinDev != "" {
			addSeed(majMinDev)
		}
	}

	out, walkUnresolved := r.resolveBlockDevices(seeds)
	return out, unresolved || walkUnresolved
}

// resolveSourceBlockDev resolves a /dev/... mount source (including symlinks,
// /dev/mapper/<name>, and /dev/<vg>/<lv>) to its kernel block device name.
func (r *Runner) resolveSourceBlockDev(src string) (string, bool) {
	if !strings.HasPrefix(src, "/dev/") {
		return "", false
	}
	resolved := r.resolveDevPath(src)
	if strings.HasPrefix(resolved, "/dev/mapper/") {
		if dm := r.findDMByName(filepath.Base(resolved)); dm != "" {
			return dm, true
		}
		return "", false
	}
	rel := strings.TrimPrefix(resolved, "/dev/")
	if rel == "" || rel == "." || rel == "root" {
		return "", false
	}
	if strings.Count(rel, "/") == 1 {
		vg, lv, _ := strings.Cut(rel, "/")
		dmName := strings.ReplaceAll(vg, "-", "--") + "-" + strings.ReplaceAll(lv, "-", "--")
		if dm := r.findDMByName(dmName); dm != "" {
			return dm, true
		}
		return "", false
	}
	if strings.Contains(rel, "/") {
		return "", false
	}
	return rel, true
}

// btrfsBackingDevices returns every block device backing a mounted Btrfs
// filesystem by matching its mount source against /sys/fs/btrfs/<fsid>/devices/.
func (r *Runner) btrfsBackingDevices(target mountInfo) ([]string, bool) {
	sourceDev, ok := r.resolveSourceBlockDev(target.Source)
	if !ok {
		return nil, false
	}
	ents, err := os.ReadDir(r.hostPath("/sys/fs/btrfs"))
	if err != nil {
		return nil, false
	}
	var matched []string
	matches := 0
	for _, ent := range ents {
		fsid := ent.Name()
		if fsid == "" || fsid == "features" || strings.HasPrefix(fsid, ".") {
			continue
		}
		devDir := filepath.Join("/sys/fs/btrfs", fsid, "devices")
		devEnts, err := os.ReadDir(r.hostPath(devDir))
		if err != nil || len(devEnts) == 0 {
			continue
		}
		members := make([]string, 0, len(devEnts))
		foundSource := false
		for _, de := range devEnts {
			name := de.Name()
			if name == "" || strings.HasPrefix(name, ".") {
				continue
			}
			targetName := name
			if link, err := os.Readlink(r.hostPath(filepath.Join(devDir, name))); err == nil {
				if base := filepath.Base(filepath.Clean(link)); base != "" && base != "." && base != "/" {
					targetName = base
				}
			}
			if name == sourceDev || targetName == sourceDev {
				foundSource = true
			}
			members = append(members, targetName)
		}
		if foundSource {
			matches++
			matched = members
		}
	}
	if matches != 1 || len(matched) == 0 {
		return nil, false
	}
	return matched, true
}

// bcachefsBackingDevices returns every block device backing a mounted bcachefs
// filesystem via /sys/fs/bcachefs/<uuid>/dev-*/block.
func (r *Runner) bcachefsBackingDevices(target mountInfo) ([]string, bool) {
	src := strings.TrimSpace(target.Source)
	if src == "" {
		return nil, false
	}
	if uuid, ok := cutPrefixFold(src, "UUID="); ok {
		if uuid == "" || strings.ContainsAny(uuid, "/\\") || uuid == "." || uuid == ".." {
			return nil, false
		}
		members, complete := r.readBcachefsDir(filepath.Join("/sys/fs/bcachefs", uuid))
		if !complete || len(members) == 0 {
			return nil, false
		}
		return members, true
	}

	parts := strings.Split(src, ":")
	wanted := make([]string, 0, len(parts))
	for _, p := range parts {
		dev, ok := r.resolveSourceBlockDev(p)
		if !ok {
			return nil, false
		}
		wanted = append(wanted, dev)
	}
	if len(wanted) == 0 {
		return nil, false
	}

	ents, err := os.ReadDir(r.hostPath("/sys/fs/bcachefs"))
	if err != nil {
		return nil, false
	}
	var matched []string
	matchedComplete := false
	matches := 0
	for _, ent := range ents {
		id := ent.Name()
		if id == "" || strings.HasPrefix(id, ".") {
			continue
		}
		members, complete := r.readBcachefsDir(filepath.Join("/sys/fs/bcachefs", id))
		if len(members) == 0 {
			continue
		}
		memberSet := make(map[string]bool, len(members))
		for _, m := range members {
			memberSet[m] = true
		}
		allPresent := true
		for _, w := range wanted {
			if !memberSet[w] {
				allPresent = false
				break
			}
		}
		if allPresent {
			matches++
			matched = members
			matchedComplete = complete
		}
	}
	if matches != 1 || !matchedComplete || len(matched) == 0 {
		return nil, false
	}
	return matched, true
}

func (r *Runner) readBcachefsDir(dir string) ([]string, bool) {
	ents, err := os.ReadDir(r.hostPath(dir))
	if err != nil {
		return nil, false
	}
	var out []string
	complete := true
	seenDev := false
	for _, ent := range ents {
		n := ent.Name()
		rest, ok := strings.CutPrefix(n, "dev-")
		if !ok || !allDigits(rest) {
			continue
		}
		seenDev = true
		link, err := os.Readlink(r.hostPath(filepath.Join(dir, n, "block")))
		if err != nil {
			complete = false
			continue
		}
		base := filepath.Base(filepath.Clean(link))
		if base == "" || base == "." || base == "/" {
			complete = false
			continue
		}
		out = append(out, base)
	}
	if !seenDev {
		return nil, false
	}
	return out, complete
}

func cutPrefixFold(s, prefix string) (string, bool) {
	if len(s) < len(prefix) || !strings.EqualFold(s[:len(prefix)], prefix) {
		return "", false
	}
	return s[len(prefix):], true
}

// resolveBlockDevices walks one or more block device names through sysfs
// slaves and partitions down to whole physical block devices. Returns
// unresolved=true if any device is a stacked/virtual leaf whose backing
// physical disks cannot be determined.
func (r *Runner) resolveBlockDevices(seeds []string) ([]string, bool) {
	visited := map[string]bool{}
	found := map[string]bool{}
	var out []string
	unresolved := false

	var walk func(name string)
	walk = func(name string) {
		if name == "" || visited[name] {
			return
		}
		if strings.HasPrefix(name, "/dev/") {
			dev, ok := r.resolveSourceBlockDev(name)
			if !ok {
				unresolved = true
				return
			}
			name = dev
			if visited[name] {
				return
			}
		} else if strings.Contains(name, "/") {
			unresolved = true
			return
		}
		visited[name] = true

		// 1. Stacked devices (LVM/dm-*, dm-crypt, mdraid, multipath, bcache,
		// DRBD) expose their underlying members in /sys/class/block/<dev>/slaves.
		if slaves := r.sysfsSlaves(name); len(slaves) > 0 {
			for _, s := range slaves {
				walk(s)
			}
			return
		}

		// 2. Partition -> parent disk via sysfs link, /sys/block/<parent>/<part>,
		// or Linux block naming fallback.
		if parent := r.sysfsPartitionParent(name); parent != "" && parent != name {
			walk(parent)
			return
		}

		// 3. Leaf block device: unresolved virtual/stacked leaves cannot confirm
		// their physical backing disks.
		if isVirtualLeafBlock(name) {
			unresolved = true
			return
		}
		if !found[name] {
			found[name] = true
			out = append(out, name)
		}
	}

	for _, s := range seeds {
		walk(s)
	}
	return out, unresolved
}

func (r *Runner) resolveDevPath(devPath string) string {
	cur := filepath.Clean(devPath)
	for i := 0; i < 16; i++ {
		target, err := os.Readlink(r.hostPath(cur))
		if err != nil {
			return cur
		}
		if filepath.IsAbs(target) {
			cur = filepath.Clean(target)
		} else {
			cur = filepath.Clean(filepath.Join(filepath.Dir(cur), target))
		}
	}
	return cur
}

func (r *Runner) findDMByName(want string) string {
	ents, err := os.ReadDir(r.hostPath("/sys/block"))
	if err != nil {
		return ""
	}
	for _, e := range ents {
		name := e.Name()
		if !strings.HasPrefix(name, "dm-") {
			continue
		}
		b, err := os.ReadFile(r.hostPath(filepath.Join("/sys/block", name, "dm/name")))
		if err == nil && strings.TrimSpace(string(b)) == want {
			return name
		}
	}
	return ""
}

func (r *Runner) sysfsSlaves(name string) []string {
	for _, dir := range []string{
		filepath.Join("/sys/class/block", name, "slaves"),
		filepath.Join("/sys/block", name, "slaves"),
	} {
		ents, err := os.ReadDir(r.hostPath(dir))
		if err != nil || len(ents) == 0 {
			continue
		}
		out := make([]string, 0, len(ents))
		for _, e := range ents {
			if n := e.Name(); n != "" {
				out = append(out, n)
			}
		}
		return out
	}
	if strings.HasPrefix(name, "md") {
		return r.sysfsMDMembers(name)
	}
	return nil
}

func (r *Runner) sysfsMDMembers(name string) []string {
	mdDir := filepath.Join("/sys/block", name, "md")
	ents, err := os.ReadDir(r.hostPath(mdDir))
	if err != nil {
		return nil
	}
	var out []string
	for _, e := range ents {
		en := e.Name()
		rest, ok := strings.CutPrefix(en, "dev-")
		if !ok || rest == "" {
			continue
		}
		member := rest
		if link, err := os.Readlink(r.hostPath(filepath.Join(mdDir, en, "block"))); err == nil {
			if base := filepath.Base(filepath.Clean(link)); base != "" && base != "." && base != "/" {
				member = base
			}
		}
		out = append(out, member)
	}
	return out
}

func (r *Runner) sysfsPartitionParent(name string) string {
	// /sys/class/block/<part> symlinks to ../../devices/.../block/<disk>/<part>.
	if link, err := os.Readlink(r.hostPath(filepath.Join("/sys/class/block", name))); err == nil {
		parent := filepath.Base(filepath.Dir(filepath.Clean(link)))
		if parent != "" && parent != "block" && parent != "." && parent != "/" && parent != name {
			return parent
		}
	}
	// If /sys/block/<name> does not exist as a top-level disk, check /sys/block/<disk>/<name>.
	if _, err := os.Lstat(r.hostPath(filepath.Join("/sys/block", name))); err != nil {
		if ents, err := os.ReadDir(r.hostPath("/sys/block")); err == nil {
			for _, e := range ents {
				if _, err := os.Lstat(r.hostPath(filepath.Join("/sys/block", e.Name(), name))); err == nil {
					return e.Name()
				}
			}
		}
	}
	// Fallback: standard Linux partition naming when not a top-level /sys/block entry
	// (or explicitly marked as a partition in sysfs).
	if parent := partitionParentName(name); parent != "" {
		_, isTopDisk := os.Lstat(r.hostPath(filepath.Join("/sys/block", name)))
		_, hasPartFile := os.Lstat(r.hostPath(filepath.Join("/sys/class/block", name, "partition")))
		if isTopDisk != nil || hasPartFile == nil {
			return parent
		}
	}
	return ""
}

func partitionParentName(name string) string {
	for _, prefix := range []string{"nvme", "mmcblk", "md", "loop", "nbd", "zd", "rbd", "ublkb"} {
		if !strings.HasPrefix(name, prefix) {
			continue
		}
		p := strings.LastIndexByte(name, 'p')
		if p <= len(prefix) || p >= len(name)-1 {
			continue
		}
		if name[p-1] < '0' || name[p-1] > '9' {
			continue
		}
		if allDigits(name[p+1:]) {
			return name[:p]
		}
	}
	for _, prefix := range []string{"xvd", "dasd", "sd", "hd", "vd"} {
		if !strings.HasPrefix(name, prefix) {
			continue
		}
		i := len(name)
		for i > len(prefix) && name[i-1] >= '0' && name[i-1] <= '9' {
			i--
		}
		if i == len(name) || i <= len(prefix) {
			continue
		}
		rest := name[len(prefix):i]
		if allLowerLetters(rest) {
			return name[:i]
		}
	}
	return ""
}

func allDigits(s string) bool {
	if s == "" {
		return false
	}
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}

func allLowerLetters(s string) bool {
	if s == "" {
		return false
	}
	for i := 0; i < len(s); i++ {
		if s[i] < 'a' || s[i] > 'z' {
			return false
		}
	}
	return true
}

func isVirtualLeafBlock(name string) bool {
	for _, prefix := range []string{"loop", "ram", "zram", "nbd", "rbd", "drbd", "ublkb", "zd", "sr", "fd", "nullb", "dm-", "md", "bcache"} {
		if strings.HasPrefix(name, prefix) {
			return true
		}
	}
	return false
}

// checkUnraidSpunDown reads /var/local/emhttp/disks.ini (in tmpfs) and records
// any spun-down disk that backs mount, as well as devices explicitly known awake.
// It reports whether any populated Unraid slot backed mount and returns those
// slot device names.
func (r *Runner) checkUnraidSpunDown(mount string, spun, spunDevs, awake, unknown map[string]bool) (bool, []string) {
	b, err := os.ReadFile(r.hostPath("/var/local/emhttp/disks.ini"))
	if err != nil {
		return false, nil
	}
	secs := parseSimpleINI(b)
	found := false
	var devs []string
	for sec, kv := range secs {
		if sec == "" {
			continue
		}
		name := kv["name"]
		if name == "" {
			name = sec
		}
		typ := kv["type"]
		if !unraidDiskBacksMount(mount, name, typ, "") {
			continue
		}
		dev := kv["device"]
		if kv["status"] == "DISK_NP" || (dev == "" && kv["spundown"] == "") {
			continue
		}
		found = true
		switch kv["spundown"] {
		case "1":
			spun[name] = true
			if dev != "" {
				spunDevs[dev] = true
				devs = append(devs, dev)
			}
		case "0":
			if dev != "" {
				awake[dev] = true
				devs = append(devs, dev)
			}
		default:
			if dev != "" {
				devs = append(devs, dev)
			} else {
				unknown[name] = true
			}
		}
	}
	return found, devs
}

func (r *Runner) checkUnraidReportSpunDown(mount string, backingSet map[string]bool, u *proto.Unraid, spun, spunDevs, rotational map[string]bool) []string {
	if u == nil {
		return nil
	}
	var devs []string
	record := func(d proto.UnraidDisk, matches bool) {
		if !matches {
			return
		}
		if d.Status == "empty" || d.StatusRaw == "DISK_NP" {
			return
		}
		if d.Device != "" && d.Rotational != nil && rotational != nil {
			if _, ok := rotational[d.Device]; !ok {
				rotational[d.Device] = *d.Rotational
			}
		}
		if d.SpunDown {
			spun[d.Name] = true
			if d.Device != "" {
				spunDevs[d.Device] = true
				devs = append(devs, d.Device)
			}
			return
		}
		if d.Device != "" {
			devs = append(devs, d.Device)
		}
	}
	for _, d := range u.Array.Disks {
		typ := "Data"
		if d.Slot == proto.UnraidSlotParity {
			typ = "Parity"
		}
		record(d, unraidDiskBacksMount(mount, d.Name, typ, "") || (d.Device != "" && backingSet[d.Device]))
	}
	for _, p := range u.Pools {
		for _, d := range p.Disks {
			record(d, unraidDiskBacksMount(mount, d.Name, "Cache", p.Name) || (d.Device != "" && backingSet[d.Device]))
		}
	}
	if u.Flash != nil {
		record(*u.Flash, unraidDiskBacksMount(mount, u.Flash.Name, "Flash", "") || (u.Flash.Device != "" && backingSet[u.Flash.Device]))
	}
	return devs
}

// unraidDiskBacksMount reports whether an Unraid disk/pool slot backs mount.
func unraidDiskBacksMount(mount, diskName, diskType, poolName string) bool {
	switch {
	case mount == "/mnt/user" || strings.HasPrefix(mount, "/mnt/user/"):
		// Unraid's shfs user share spans all data disks and cache pools.
		return diskType == "Data" || diskType == "Cache"
	case mount == "/mnt/user0" || strings.HasPrefix(mount, "/mnt/user0/"):
		// user0 spans array data disks only.
		return diskType == "Data"
	case mount == "/boot":
		return diskType == "Flash"
	case strings.HasPrefix(mount, "/mnt/"):
		rest := strings.TrimPrefix(mount, "/mnt/")
		top, _, _ := strings.Cut(rest, "/")
		if top == "" {
			return false
		}
		if top == diskName {
			return true
		}
		if poolName != "" && top == poolName {
			return true
		}
		// Multi-disk cache pools in disks.ini name members "<pool>", "<pool>2", ...
		if diskType == "Cache" && strings.HasPrefix(diskName, top) {
			suffix := strings.TrimPrefix(diskName, top)
			if suffix != "" && strings.Trim(suffix, "0123456789") == "" {
				return true
			}
		}
	}
	return false
}

// parseSimpleINI parses emhttp's [section] key="value" ini files.
func parseSimpleINI(b []byte) map[string]map[string]string {
	out := map[string]map[string]string{"": {}}
	cur := ""
	sc := bufio.NewScanner(bytes.NewReader(b))
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") || strings.HasPrefix(line, ";") {
			continue
		}
		if strings.HasPrefix(line, "[") && strings.HasSuffix(line, "]") {
			cur = strings.Trim(strings.TrimSpace(line[1:len(line)-1]), `"`)
			if out[cur] == nil {
				out[cur] = map[string]string{}
			}
			continue
		}
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		k = strings.TrimSpace(k)
		v = strings.Trim(strings.TrimSpace(v), `"`)
		out[cur][k] = v
	}
	return out
}

type diskProbeKind int

const (
	diskProbeNone diskProbeKind = iota
	diskProbeSAT
	diskProbeATA
)

const (
	// smartctl -n standby,3,5 exit statuses documented in smartctl(8):
	// STATUS=3 when the device is in SLEEP or STANDBY mode, and [ATA only]
	// STATUS2=5 when CHECK POWER MODE is unsupported or returns an unknown value.
	smartctlStandbyExit     = 3
	smartctlUnsupportedExit = 5
)

func runStandbyProbeCmd(ctx context.Context, path string, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, path, args...)
	cmd.Dir = "/"
	cmd.Env = []string{
		"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
		"LC_ALL=C",
	}
	return cmd.CombinedOutput()
}

// hostDiskStandby checks whether a rotational block device (e.g. "sda") is
// awake or asleep without waking it.
//
// Why each step cannot wake a sleeping disk:
//  1. Kernel sysfs check first (RAM only, zero device I/O):
//     - /sys/block/<dev>/device/power/runtime_status (Linux Runtime PM,
//     Documentation/power/runtime_pm.rst): if "suspended" or "suspending",
//     the kernel already knows the device is runtime-suspended; returning
//     standbyAsleep immediately avoids even opening /dev/<dev>, which could
//     trigger a kernel runtime resume and spin up the drive.
//     - /sys/block/<dev>/device/state (drivers/scsi/scsi_sysfs.c): if present
//     and not "running" (e.g. "quiesce", "offline", "blocked"), return
//     standbyUnknown without running any command.
//  2. Bus/protocol classification from sysfs (RAM only, zero device I/O):
//     only disks confirmed to speak ATA (direct Linux libata SATA/PATA under
//     /ata<N>/, SATA behind a SAS HBA SATL whose T10 SAT INQUIRY vendor is
//     "ATA" and not native SAS SSP, or legacy IDE ide-disk) are probed. USB
//     bridges (whose pass-through chips vary and can spin up on SAT queries),
//     native SCSI/SAS disks (smartctl(8) documents STATUS2 as [ATA only], so an
//     unsupported SCSI power check falls through and reads the disk; hdparm -C
//     is ATA-only), hardware RAID logical volumes, non-Linux platforms (macOS
//     has no hdparm and smartctl has no SAT/SCSI non-waking standby check for
//     external drives), and devices with missing sysfs metadata return
//     standbyUnknown without running any command.
//  3. Verified non-waking ATA CHECK POWER MODE probes (ATA/SAT disks only):
//     - Primary: `hdparm -C /dev/<dev>`. Per hdparm(8), `-C` issues only the
//     ATA CHECK POWER MODE command (0xE5, via SG_IO SAT pass-through on
//     libata/SATL or HDIO_DRIVE_CMD on legacy IDE) and reports `active/idle`,
//     `standby`, `sleeping`, or `unknown` (command not supported) without
//     reading sectors, IDENTIFY DEVICE, or SMART pages.
//     - Fallback when hdparm is unavailable:
//     `smartctl --json=c -d <sat|ata> -n standby,3,5 -i /dev/<dev>`.
//     Per smartctl(8) (`-d` and `-n POWERMODE[,STATUS[,STATUS2]]`):
//     explicit `-d sat` (without `,auto`) or `-d ata` disables device-type
//     autodetection, which smartctl(8) warns can otherwise spin up a sleeping
//     disk before `-n` is checked; `-n standby,3,5` sets STATUS=3 for
//     SLEEP/STANDBY and [ATA only] STATUS2=5 so smartctl exits immediately
//     if CHECK POWER MODE is unsupported or returns an unknown value instead
//     of ignoring `-n` and continuing to `-i`. Older smartctl binaries that
//     do not parse STATUS2 exit with bit 0 (status 1) before opening the
//     device, which also returns standbyUnknown.
func (r *Runner) hostDiskStandby(ctx context.Context, dev string) standbyState {
	if dev == "" || strings.ContainsAny(dev, "/\\ \t\n\r") {
		return standbyUnknown
	}
	// Only Linux has verified non-waking kernel/ATA standby probes. On macOS
	// and other platforms, skip rotational disks conservatively as unknown.
	if !r.isLinux() {
		return standbyUnknown
	}

	// 1. Check what the kernel already knows in sysfs before running any command.
	if st, decided := r.kernelStandbyState(dev); decided {
		return st
	}

	// 2. Only probe device types with a verified non-waking ATA CHECK POWER MODE path.
	kind := r.classifyLinuxDiskProbe(dev)
	if kind == diskProbeNone {
		return standbyUnknown
	}

	look := r.lookProbeTool
	if look == nil {
		look = lookTool
	}
	run := r.probeCmd
	if run == nil {
		run = runStandbyProbeCmd
	}
	devPath := "/dev/" + dev

	// 3a. Prefer hdparm -C: sends only ATA CHECK POWER MODE (0xE5).
	if path, err := look("hdparm"); err == nil {
		out, cmdErr := run(ctx, path, "-C", devPath)
		return standbyFromHdparm(out, cmdErr)
	}

	// 3b. Fall back to smartctl with explicit -d and STATUS2 when hdparm is absent.
	if path, err := look("smartctl"); err == nil {
		devType := "sat"
		if kind == diskProbeATA {
			devType = "ata"
		}
		out, cmdErr := run(ctx, path, "--json=c", "-d", devType, "-n", "standby,3,5", "-i", devPath)
		return standbyFromSmartctl(out, cmdErr)
	}

	return standbyUnknown
}

// kernelStandbyState inspects Linux sysfs power and device state in kernel RAM
// without issuing any I/O to the disk. It returns decided=true only when the
// kernel already settles the outcome without running a userspace probe.
func (r *Runner) kernelStandbyState(dev string) (standbyState, bool) {
	for _, p := range []string{
		filepath.Join("/sys/block", dev, "device/power/runtime_status"),
		filepath.Join("/sys/class/block", dev, "device/power/runtime_status"),
	} {
		if status := strings.ToLower(r.readSysfsTrimmed(p)); status != "" {
			switch status {
			case "suspended", "suspending":
				return standbyAsleep, true
			}
			break
		}
	}
	for _, p := range []string{
		filepath.Join("/sys/block", dev, "device/state"),
		filepath.Join("/sys/class/block", dev, "device/state"),
	} {
		if state := strings.ToLower(r.readSysfsTrimmed(p)); state != "" {
			if state != "running" {
				return standbyUnknown, true
			}
			break
		}
	}
	return standbyUnknown, false
}

// classifyLinuxDiskProbe determines from sysfs metadata alone (RAM only, zero
// device I/O) whether dev is a confirmed ATA/SAT disk with a verified
// non-waking probe path. Any other bus or missing metadata returns diskProbeNone.
func (r *Runner) classifyLinuxDiskProbe(dev string) diskProbeKind {
	if strings.HasPrefix(dev, "nvme") || strings.HasPrefix(dev, "mmcblk") || strings.HasPrefix(dev, "pmem") {
		return diskProbeNone
	}
	if r.readSysfsTrimmed(filepath.Join("/sys/block", dev, "queue/rotational")) == "0" {
		return diskProbeNone
	}
	if r.isVirtualGuestDisk(dev, nil) {
		return diskProbeNone
	}

	var links []string
	for _, p := range []string{
		filepath.Join("/sys/block", dev),
		filepath.Join("/sys/class/block", dev),
		filepath.Join("/sys/block", dev, "device"),
		filepath.Join("/sys/class/block", dev, "device"),
	} {
		if link, err := os.Readlink(r.hostPath(p)); err == nil && link != "" {
			links = append(links, link)
		}
	}

	if len(links) == 0 {
		// Without a sysfs bus symlink we cannot rule out a USB bridge or confirm
		// an ATA/SAT host transport; fail closed without running any command.
		return diskProbeNone
	}

	driver := ""
	for _, p := range []string{
		filepath.Join("/sys/block", dev, "device/driver"),
		filepath.Join("/sys/class/block", dev, "device/driver"),
	} {
		if link, err := os.Readlink(r.hostPath(p)); err == nil && link != "" {
			driver = strings.ToLower(filepath.Base(filepath.Clean(link)))
			break
		}
	}

	// Never probe USB bridges (they vary in pass-through protocol and can wake
	// drives on SAT queries) or non-ATA subsystems.
	if driver == "usb-storage" || driver == "uas" {
		return diskProbeNone
	}
	hasATAHost := false
	hasIDEHost := false
	var sasEndDevice string
	for _, link := range links {
		for _, seg := range strings.Split(filepath.ToSlash(filepath.Clean(link)), "/") {
			low := strings.ToLower(seg)
			switch {
			case low == "usb" || (strings.HasPrefix(low, "usb") && allDigits(low[3:])):
				return diskProbeNone
			case low == "nvme" || (strings.HasPrefix(low, "nvme") && allDigits(low[4:])):
				return diskProbeNone
			case low == "mmc" || strings.HasPrefix(low, "mmc"):
				return diskProbeNone
			case strings.HasPrefix(low, "ata") && allDigits(low[3:]):
				hasATAHost = true
			case strings.HasPrefix(low, "ide") && allDigits(low[3:]):
				hasIDEHost = true
			case strings.HasPrefix(low, "end_device-"):
				sasEndDevice = seg
			}
		}
	}

	// Legacy IDE disk (/dev/hd[a-z]+ with ide-disk driver or ide<N> bus).
	if strings.HasPrefix(dev, "hd") && allLowerLetters(dev[2:]) {
		if driver == "ide-disk" || hasIDEHost {
			return diskProbeATA
		}
		return diskProbeNone
	}

	// Linux SCSI-layer disks (/dev/sd[a-z]+): only direct libata or a SATL
	// reporting T10 SAT vendor "ATA" (e.g. SATA behind an IT-mode SAS HBA).
	if !strings.HasPrefix(dev, "sd") || !allLowerLetters(dev[2:]) {
		return diskProbeNone
	}

	vendor := r.readSysfsTrimmed(filepath.Join("/sys/block", dev, "device/vendor"))
	if vendor == "" {
		vendor = r.readSysfsTrimmed(filepath.Join("/sys/class/block", dev, "device/vendor"))
	}

	if hasATAHost {
		if vendor == "" || strings.EqualFold(vendor, "ATA") {
			return diskProbeSAT
		}
		return diskProbeNone
	}

	if strings.EqualFold(vendor, "ATA") {
		if protos := r.sasTargetProtocols(dev, sasEndDevice); protos != "" {
			if hasSSPWithoutSATA(protos) {
				return diskProbeNone
			}
		}
		return diskProbeSAT
	}

	return diskProbeNone
}

func (r *Runner) sasTargetProtocols(dev, endDevice string) string {
	candidates := []string{
		filepath.Join("/sys/block", dev, "device/sas_device/target_port_protocols"),
	}
	if endDevice != "" {
		candidates = append(candidates, filepath.Join("/sys/class/sas_device", endDevice, "target_port_protocols"))
	}
	for _, p := range candidates {
		if v := strings.ToLower(r.readSysfsTrimmed(p)); v != "" {
			return v
		}
	}
	if ents, err := os.ReadDir(r.hostPath(filepath.Join("/sys/block", dev, "device/sas_device"))); err == nil {
		for _, e := range ents {
			p := filepath.Join("/sys/block", dev, "device/sas_device", e.Name(), "target_port_protocols")
			if v := strings.ToLower(r.readSysfsTrimmed(p)); v != "" {
				return v
			}
		}
	}
	return ""
}

func hasSSPWithoutSATA(protos string) bool {
	hasSSP := false
	hasSATA := false
	for _, tok := range strings.FieldsFunc(strings.ToLower(protos), func(r rune) bool {
		return r == ',' || r == ' ' || r == '\t' || r == '\n' || r == '\r'
	}) {
		switch tok {
		case "ssp":
			hasSSP = true
		case "stp", "sata":
			hasSATA = true
		}
	}
	return hasSSP && !hasSATA
}

func exitCodeOf(err error) (int, bool) {
	if err == nil {
		return 0, true
	}
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		return ee.ExitCode(), true
	}
	return 0, false
}

func smartctlMessageUnsupportedOrError(upper string) bool {
	for _, needle := range []string{
		"NOT IMPLEMENTED",
		"NOT SUPPORTED",
		"UNKNOWN VALUE",
		"INCOMPLETE RESPONSE",
		"IGNORING -N",
		"FAILED",
		"PERMISSION DENIED",
		"INVALID ARGUMENT",
		"UNABLE TO DETECT",
		"NO SUCH FILE",
		"UNRECOGNIZED OPTION",
	} {
		if strings.Contains(upper, needle) {
			return true
		}
	}
	return false
}

func smartctlMessageStandby(upper string) bool {
	return strings.Contains(upper, "DEVICE IS IN STANDBY") || strings.Contains(upper, "DEVICE IS IN SLEEP")
}

func standbyFromSmartctl(b []byte, cmdErr error) standbyState {
	if code, ok := exitCodeOf(cmdErr); ok && code == smartctlUnsupportedExit {
		return standbyUnknown
	}
	if len(b) == 0 {
		return standbyUnknown
	}
	var j struct {
		PowerMode string `json:"power_mode"`
		Smartctl  struct {
			ExitStatus int `json:"exit_status"`
			Messages   []struct {
				String   string `json:"string"`
				Severity string `json:"severity"`
			} `json:"messages"`
		} `json:"smartctl"`
	}
	if err := json.Unmarshal(b, &j); err != nil {
		s := strings.ToUpper(string(b))
		if smartctlMessageUnsupportedOrError(s) {
			return standbyUnknown
		}
		if smartctlMessageStandby(s) {
			return standbyAsleep
		}
		return standbyUnknown
	}
	if j.Smartctl.ExitStatus == smartctlUnsupportedExit {
		return standbyUnknown
	}
	standbyMsg := false
	for _, m := range j.Smartctl.Messages {
		s := strings.ToUpper(m.String)
		if strings.EqualFold(m.Severity, "error") || smartctlMessageUnsupportedOrError(s) {
			return standbyUnknown
		}
		if smartctlMessageStandby(s) {
			standbyMsg = true
		}
	}
	if standbyMsg {
		return standbyAsleep
	}
	if pm := strings.ToUpper(strings.TrimSpace(j.PowerMode)); pm != "" {
		if strings.HasPrefix(pm, "STANDBY") || strings.HasPrefix(pm, "SLEEP") {
			return standbyAsleep
		}
		switch pm {
		case "ACTIVE", "ACTIVE OR IDLE", "ACTIVE_NV_UP", "ACTIVE_NV_DOWN", "IDLE", "IDLE_A", "IDLE_B", "IDLE_C":
			if cmdErr == nil && j.Smartctl.ExitStatus == 0 {
				return standbyAwake
			}
			return standbyUnknown
		default:
			return standbyUnknown
		}
	}
	if j.Smartctl.ExitStatus == smartctlStandbyExit {
		return standbyAsleep
	}
	if cmdErr == nil && j.Smartctl.ExitStatus == 0 {
		return standbyAwake
	}
	return standbyUnknown
}

func standbyFromHdparm(b []byte, cmdErr error) standbyState {
	sc := bufio.NewScanner(bytes.NewReader(b))
	for sc.Scan() {
		line := strings.ToLower(sc.Text())
		_, rest, ok := strings.Cut(line, "drive state is:")
		if !ok {
			continue
		}
		state := strings.TrimSpace(rest)
		switch state {
		case "standby", "sleeping":
			return standbyAsleep
		case "active/idle":
			if cmdErr == nil {
				return standbyAwake
			}
			return standbyUnknown
		default:
			return standbyUnknown
		}
	}
	return standbyUnknown
}
