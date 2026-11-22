package diskusage

import (
	"context"
	"errors"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"rackoon/internal/proto"
)

// collectCategories measures known storage consumers that live on the requested
// mount (resolving every step relative to rootDir without crossing mounts or
// following symlinks). Every category is optional and bounded by ctx.
func (r *Runner) collectCategories(ctx context.Context, rootDir scanDir, scope mountScope, rootDev, rootMntID uint64) ([]proto.DiskUsageCategory, *containerCollector, bool, *scanUnsupportedError) {
	var cats []proto.DiskUsageCategory
	partial := false

	add := func(cat proto.DiskUsageCategory) {
		if cat.Bytes > 0 {
			cats = append(cats, cat)
		}
	}

	// 1. Container engines (Docker, Podman, containerd and CRI pod logs),
	// measured strictly through the checked descriptor walk of the selected
	// mount without probing or dialing daemon sockets.
	cc := newContainerCollector()
	dockerPartial, unsup := cc.collectInitial(r, ctx, rootDir, scope, rootDev, rootMntID)
	if unsup != nil {
		return nil, nil, false, unsup
	}
	for _, c := range cc.categories() {
		add(c)
	}
	if dockerPartial {
		partial = true
	}

	// 2. Systemd journal (/var/log/journal and /run/log/journal when on this mount).
	if ctx.Err() == nil {
		seen := map[inodeKey]struct{}{}
		var jBytes uint64
		for _, dir := range []string{"/var/log/journal", "/run/log/journal"} {
			b, p, unsup := r.walkDirBytes(ctx, rootDir, scope, categoryPathForScope(scope, dir), rootDev, rootMntID, 4, seen)
			if unsup != nil {
				return nil, nil, false, unsup
			}
			jBytes += b
			if p {
				partial = true
			}
		}
		add(proto.DiskUsageCategory{
			Key:   proto.DiskCatJournal,
			Label: "System journal",
			Bytes: jBytes,
		})
	}

	// 3. Package caches (apt, dnf/yum, pacman, zypp, apk, xbps, Homebrew).
	if ctx.Err() == nil {
		seen := map[inodeKey]struct{}{}
		var pkgBytes uint64
		var hits []string
		pkgDirs := []struct {
			name string
			path string
		}{
			{"apt", "/var/cache/apt/archives"},
			{"dnf", "/var/cache/dnf"},
			{"dnf5", "/var/cache/libdnf5"},
			{"yum", "/var/cache/yum"},
			{"pacman", "/var/cache/pacman/pkg"},
			{"zypp", "/var/cache/zypp/packages"},
			{"apk", "/var/cache/apk"},
			{"xbps", "/var/cache/xbps"},
			{"Homebrew", "/Library/Caches/Homebrew"},
			{"Homebrew", "/opt/homebrew/Caches"},
		}
		seenName := map[string]bool{}
		for _, pd := range pkgDirs {
			if ctx.Err() != nil {
				partial = true
				break
			}
			b, p, unsup := r.walkDirBytes(ctx, rootDir, scope, categoryPathForScope(scope, pd.path), rootDev, rootMntID, 5, seen)
			if unsup != nil {
				return nil, nil, false, unsup
			}
			if p {
				partial = true
			}
			if b > 0 {
				pkgBytes += b
				if !seenName[pd.name] {
					seenName[pd.name] = true
					hits = append(hits, pd.name)
				}
			}
		}
		add(proto.DiskUsageCategory{
			Key:    proto.DiskCatPackageCache,
			Label:  "Package caches",
			Bytes:  pkgBytes,
			Detail: strings.Join(hits, ", "),
		})
	}

	// 4. VM disks and snapshots where known (ZFS datasets/zvols/snapshots, plus
	// libvirt, Proxmox, Incus and Unraid directories on this mount).
	if ctx.Err() == nil {
		vmDisks, vmSnaps, vmPartial, unsup := r.collectVMAndSnapshots(ctx, rootDir, scope, rootDev, rootMntID)
		if unsup != nil {
			return nil, nil, false, unsup
		}
		if vmPartial {
			partial = true
		}
		add(vmDisks)
		add(vmSnaps)
	}

	sortCategories(cats)
	return cats, cc, partial, nil
}

func sortCategories(cats []proto.DiskUsageCategory) {
	sort.Slice(cats, func(i, j int) bool {
		if cats[i].Bytes != cats[j].Bytes {
			return cats[i].Bytes > cats[j].Bytes
		}
		return cats[i].Key < cats[j].Key
	})
}

func mergeContainerCategories(existing []proto.DiskUsageCategory, containerCats []proto.DiskUsageCategory) []proto.DiskUsageCategory {
	out := make([]proto.DiskUsageCategory, 0, len(existing)+len(containerCats))
	for _, c := range existing {
		switch c.Key {
		case proto.DiskCatContainerImages, proto.DiskCatContainerBuildCache, proto.DiskCatContainerVolumes, proto.DiskCatContainerLogs:
			continue
		default:
			out = append(out, c)
		}
	}
	for _, c := range containerCats {
		if c.Bytes > 0 {
			out = append(out, c)
		}
	}
	sortCategories(out)
	return out
}

// ---- Docker / Podman / containerd (checked descriptor walk only) -----------------------

var dockerRootMarkers = map[string]bool{
	"overlay2":       true,
	"buildkit":       true,
	"containers":     true,
	"volumes":        true,
	"image":          true,
	"overlay":        true,
	"vfs":            true,
	"aufs":           true,
	"btrfs":          true,
	"fuse-overlayfs": true,
	"containerd":     true,
}

var podmanRootMarkers = map[string]bool{
	"overlay-images": true,
	"overlay-layers": true,
	"vfs-images":     true,
	"vfs-layers":     true,
}

func isContainerRootChild(name string) bool {
	return dockerRootMarkers[name] || podmanRootMarkers[name]
}

// isDockerDataRoot reports whether a directory's direct subdirectories identify
// it as a Docker data root (requiring at least two distinct Docker directories
// and a strong signature pair so ordinary project folders are not misclassified).
func isDockerDataRoot(dirs map[string]bool) bool {
	if len(dirs) < 2 {
		return false
	}
	count := 0
	for name := range dockerRootMarkers {
		if dirs[name] {
			count++
		}
	}
	if count < 2 {
		return false
	}
	if dirs["overlay2"] || dirs["buildkit"] || dirs["fuse-overlayfs"] || dirs["aufs"] {
		return true
	}
	if dirs["containers"] && (dirs["image"] || dirs["volumes"]) {
		return true
	}
	if dirs["image"] && (dirs["volumes"] || dirs["overlay"] || dirs["vfs"] || dirs["btrfs"] || dirs["containerd"]) {
		return true
	}
	return false
}

func isPodmanStorageRoot(dirs map[string]bool) bool {
	return (dirs["overlay-images"] && dirs["overlay-layers"]) ||
		(dirs["vfs-images"] && dirs["vfs-layers"])
}

type containerCollector struct {
	imgSeen     map[inodeKey]struct{}
	bcSeen      map[inodeKey]struct{}
	volSeen     map[inodeKey]struct{}
	logSeen     map[inodeKey]struct{}
	imgBytes    uint64
	bcBytes     uint64
	volBytes    uint64
	logBytes    uint64
	dockerRoots map[string]bool
	podmanRoots map[string]bool
}

func newContainerCollector() *containerCollector {
	return &containerCollector{
		imgSeen:     map[inodeKey]struct{}{},
		bcSeen:      map[inodeKey]struct{}{},
		volSeen:     map[inodeKey]struct{}{},
		logSeen:     map[inodeKey]struct{}{},
		dockerRoots: map[string]bool{},
		podmanRoots: map[string]bool{},
	}
}

func (c *containerCollector) categories() []proto.DiskUsageCategory {
	var out []proto.DiskUsageCategory
	if c.imgBytes > 0 {
		out = append(out, proto.DiskUsageCategory{
			Key:   proto.DiskCatContainerImages,
			Label: "Container images",
			Bytes: c.imgBytes,
		})
	}
	if c.bcBytes > 0 {
		out = append(out, proto.DiskUsageCategory{
			Key:   proto.DiskCatContainerBuildCache,
			Label: "Container build cache",
			Bytes: c.bcBytes,
		})
	}
	if c.volBytes > 0 {
		out = append(out, proto.DiskUsageCategory{
			Key:   proto.DiskCatContainerVolumes,
			Label: "Container volumes",
			Bytes: c.volBytes,
		})
	}
	if c.logBytes > 0 {
		out = append(out, proto.DiskUsageCategory{
			Key:   proto.DiskCatContainerLogs,
			Label: "Container logs",
			Bytes: c.logBytes,
		})
	}
	return out
}

func (c *containerCollector) alreadyCovered(path string) bool {
	clean := filepath.Clean(path)
	for existing := range c.dockerRoots {
		if hasPathPrefix(clean, existing) {
			return true
		}
	}
	for existing := range c.podmanRoots {
		if hasPathPrefix(clean, existing) {
			return true
		}
	}
	return false
}

func (c *containerCollector) collectInitial(r *Runner, ctx context.Context, rootDir scanDir, scope mountScope, rootDev, rootMntID uint64) (bool, *scanUnsupportedError) {
	partial := false

	// Standard Docker data root (also covers dedicated submounts such as
	// /var/lib/docker/volumes, /var/lib/docker/overlay2, /var/lib/docker/buildkit).
	stdDocker := categoryPathForScope(scope, "/var/lib/docker")
	p, unsup := c.measureDockerRoot(r, ctx, rootDir, scope, stdDocker, rootDev, rootMntID)
	if unsup != nil {
		return false, unsup
	}
	if p {
		partial = true
	}

	// Standard Podman storage root.
	stdPodman := categoryPathForScope(scope, "/var/lib/containers/storage")
	p, unsup = c.measurePodmanRoot(r, ctx, rootDir, scope, stdPodman, rootDev, rootMntID)
	if unsup != nil {
		return false, unsup
	}
	if p {
		partial = true
	}

	// Dedicated custom mount whose root itself is a Docker or Podman data root
	// (for example a disk mounted at /mnt/docker or /srv/containers). Inspect at
	// most one batch of rootDir so non-Docker mounts avoid repeated lookups.
	mp := scope.target.MountPoint
	if ctx.Err() == nil && mp != "/" && mp != darwinDataVolumeMount && !c.alreadyCovered(mp) {
		isDocker, isPodman, unsup := probeMountRootContainer(rootDir, scope, mp)
		if unsup != nil {
			return false, unsup
		}
		if isDocker {
			p, unsup = c.measureDockerRoot(r, ctx, rootDir, scope, mp, rootDev, rootMntID)
			if unsup != nil {
				return false, unsup
			}
			if p {
				partial = true
			}
		} else if isPodman {
			p, unsup = c.measurePodmanRoot(r, ctx, rootDir, scope, mp, rootDev, rootMntID)
			if unsup != nil {
				return false, unsup
			}
			if p {
				partial = true
			}
		}
	}

	// Standalone containerd content and snapshotter directories when on this mount.
	if ctx.Err() == nil {
		containerdRoot := categoryPathForScope(scope, "/var/lib/containerd")
		for _, sub := range []string{
			"io.containerd.content.v1.content",
			"io.containerd.metadata.v1.bolt",
			"io.containerd.snapshotter.v1.overlayfs",
			"io.containerd.snapshotter.v1.native",
			"io.containerd.snapshotter.v1.btrfs",
			"io.containerd.snapshotter.v1.fuse-overlayfs",
			"io.containerd.snapshotter.v1.zfs",
		} {
			if ctx.Err() != nil {
				partial = true
				break
			}
			b, wp, unsup := r.walkDirBytes(ctx, rootDir, scope, filepath.Join(containerdRoot, sub), rootDev, rootMntID, 12, c.imgSeen)
			if unsup != nil {
				return false, unsup
			}
			if wp {
				partial = true
			}
			c.imgBytes += b
		}
	}

	// Kubernetes / CRI container logs if present on this mount.
	if ctx.Err() == nil {
		b, wp, unsup := r.walkDirBytes(ctx, rootDir, scope, categoryPathForScope(scope, "/var/log/pods"), rootDev, rootMntID, 4, c.logSeen)
		if unsup != nil {
			return false, unsup
		}
		if wp {
			partial = true
		}
		c.logBytes += b
	}

	return partial, nil
}

// collectExtraRoots measures custom Docker and Podman data roots discovered on
// the selected mount during walkMount, skipping roots already covered in the
// initial pass and sharing inode deduplication maps so nothing is double-counted.
func (c *containerCollector) collectExtraRoots(r *Runner, ctx context.Context, rootDir scanDir, scope mountScope, rootDev, rootMntID uint64, dockerRoots, podmanRoots []string) (bool, bool, *scanUnsupportedError) {
	changed := false
	partial := false

	for _, dr := range dockerRoots {
		if ctx.Err() != nil {
			partial = true
			break
		}
		if c.alreadyCovered(dr) {
			continue
		}
		changed = true
		p, unsup := c.measureDockerRoot(r, ctx, rootDir, scope, dr, rootDev, rootMntID)
		if unsup != nil {
			return false, false, unsup
		}
		if p {
			partial = true
		}
	}

	for _, pr := range podmanRoots {
		if ctx.Err() != nil {
			partial = true
			break
		}
		if c.alreadyCovered(pr) {
			continue
		}
		changed = true
		p, unsup := c.measurePodmanRoot(r, ctx, rootDir, scope, pr, rootDev, rootMntID)
		if unsup != nil {
			return false, false, unsup
		}
		if p {
			partial = true
		}
	}

	return changed, partial, nil
}

func (c *containerCollector) measureDockerRoot(r *Runner, ctx context.Context, rootDir scanDir, scope mountScope, dockerRoot string, rootDev, rootMntID uint64) (bool, *scanUnsupportedError) {
	clean := filepath.Clean(dockerRoot)
	c.dockerRoots[clean] = true
	partial := false

	// Image layers and metadata (running container merged overlayfs mounts are
	// skipped automatically by openat2 RESOLVE_NO_XDEV / getattrlistbulk MNTPOINT).
	for _, sub := range []string{"overlay2", "image", "overlay", "vfs", "aufs", "btrfs", "fuse-overlayfs", "containerd"} {
		if ctx.Err() != nil {
			partial = true
			return partial, nil
		}
		b, p, unsup := r.walkDirBytes(ctx, rootDir, scope, filepath.Join(clean, sub), rootDev, rootMntID, 12, c.imgSeen)
		if unsup != nil {
			return false, unsup
		}
		if p {
			partial = true
		}
		c.imgBytes += b
	}

	// BuildKit / legacy builder cache.
	for _, sub := range []string{"buildkit", "builder"} {
		if ctx.Err() != nil {
			partial = true
			return partial, nil
		}
		b, p, unsup := r.walkDirBytes(ctx, rootDir, scope, filepath.Join(clean, sub), rootDev, rootMntID, 10, c.bcSeen)
		if unsup != nil {
			return false, unsup
		}
		if p {
			partial = true
		}
		c.bcBytes += b
	}

	// Docker volumes.
	if ctx.Err() == nil {
		b, p, unsup := r.walkDirBytes(ctx, rootDir, scope, filepath.Join(clean, "volumes"), rootDev, rootMntID, 6, c.volSeen)
		if unsup != nil {
			return false, unsup
		}
		if p {
			partial = true
		}
		c.volBytes += b
	} else {
		partial = true
	}

	// Container logs: <dockerRoot>/containers/*/*-json.log* and *.log.
	if ctx.Err() == nil {
		b, p, unsup := r.collectContainerLogsDir(ctx, rootDir, scope, filepath.Join(clean, "containers"), rootDev, rootMntID, c.logSeen)
		if unsup != nil {
			return false, unsup
		}
		if p {
			partial = true
		}
		c.logBytes += b
	} else {
		partial = true
	}

	return partial, nil
}

func (c *containerCollector) measurePodmanRoot(r *Runner, ctx context.Context, rootDir scanDir, scope mountScope, podmanRoot string, rootDev, rootMntID uint64) (bool, *scanUnsupportedError) {
	clean := filepath.Clean(podmanRoot)
	c.podmanRoots[clean] = true
	partial := false

	for _, sub := range []string{"overlay", "overlay-images", "overlay-layers", "vfs", "vfs-images", "vfs-layers", "btrfs"} {
		if ctx.Err() != nil {
			partial = true
			return partial, nil
		}
		b, p, unsup := r.walkDirBytes(ctx, rootDir, scope, filepath.Join(clean, sub), rootDev, rootMntID, 12, c.imgSeen)
		if unsup != nil {
			return false, unsup
		}
		if p {
			partial = true
		}
		c.imgBytes += b
	}

	if ctx.Err() == nil {
		b, p, unsup := r.walkDirBytes(ctx, rootDir, scope, filepath.Join(clean, "volumes"), rootDev, rootMntID, 6, c.volSeen)
		if unsup != nil {
			return false, unsup
		}
		if p {
			partial = true
		}
		c.volBytes += b
	} else {
		partial = true
	}

	return partial, nil
}

func probeMountRootContainer(rootDir scanDir, scope mountScope, mount string) (isDocker, isPodman bool, unsup *scanUnsupportedError) {
	self, err := rootDir.OpenSelf()
	if err != nil {
		return false, false, asUnsupportedErr(err)
	}
	defer self.Close()

	ents, rerr := self.ReadDirBatch(dirBatchSize)
	if rerr != nil && !errors.Is(rerr, io.EOF) {
		if u := asUnsupportedErr(rerr); u != nil {
			return false, false, u
		}
	}
	found := make(map[string]bool, 4)
	for _, e := range ents {
		if e.Err != nil {
			if u := asUnsupportedErr(e.Err); u != nil {
				return false, false, u
			}
			continue
		}
		if !isSafeChildName(e.Name) || !isContainerRootChild(e.Name) {
			continue
		}
		child := joinLogical(mount, e.Name)
		if scope.isOtherMount(child) {
			continue
		}
		switch e.Kind {
		case entryDir:
			found[e.Name] = true
		case entryUnknown:
			ok, u := dirInScope(rootDir, scope, child)
			if u != nil {
				return false, false, u
			}
			if ok {
				found[e.Name] = true
			}
		}
	}
	return isDockerDataRoot(found), isPodmanStorageRoot(found), nil
}

func (r *Runner) collectContainerLogsDir(ctx context.Context, rootDir scanDir, scope mountScope, containersDir string, rootDev, rootMntID uint64, seen map[inodeKey]struct{}) (uint64, bool, *scanUnsupportedError) {
	var total uint64
	partial := false

	capEntries := r.catMaxEntries
	if capEntries <= 0 {
		capEntries = 100_000
	}
	entries := 0
	cDir, err := openRelDir(rootDir, scope, containersDir, false)
	if err != nil {
		if unsup := asUnsupportedErr(err); unsup != nil {
			return 0, false, unsup
		}
		if !isSkipDirErr(err) {
			partial = true
		}
		return 0, partial, nil
	}
	defer cDir.Close()

outerLoop:
	for {
		if ctx.Err() != nil {
			partial = true
			break
		}
		rem := capEntries - entries
		if rem < 0 {
			partial = true
			break
		}
		ents, rerr := cDir.ReadDirBatch(min(dirBatchSize, rem+1))
		for _, e := range ents {
			entries++
			if entries > capEntries || ctx.Err() != nil {
				partial = true
				break outerLoop
			}
			if e.Err != nil {
				if unsup := asUnsupportedErr(e.Err); unsup != nil {
					return 0, false, unsup
				}
				if !isSkipEntryErr(e.Err) {
					partial = true
				}
				continue
			}
			if !isSafeChildName(e.Name) {
				continue
			}
			// On filesystems without d_type (XFS without ftype=1, FUSE), entries
			// arrive as entryUnknown; only skip entries known not to be directories.
			if e.Kind != entryDir && e.Kind != entryUnknown {
				continue
			}
			sub := joinLogical(containersDir, e.Name)
			if scope.isOtherMount(sub) {
				continue
			}
			subDir, oerr := cDir.OpenDir(e.Name, sub, false, true)
			if oerr != nil {
				if unsup := asUnsupportedErr(oerr); unsup != nil {
					return 0, false, unsup
				}
				// Plain files and symlinks inside containers/ return ENOTDIR/ELOOP,
				// and newly mounted filesystems return errWrongMount; all skip cleanly.
				if !isSkipDirErr(oerr) {
					partial = true
				}
				continue
			}
			for {
				if ctx.Err() != nil {
					partial = true
					_ = subDir.Close()
					break outerLoop
				}
				subRem := capEntries - entries
				if subRem < 0 {
					partial = true
					_ = subDir.Close()
					break outerLoop
				}
				files, ferr := subDir.ReadDirBatch(min(dirBatchSize, subRem+1))
				for _, f := range files {
					entries++
					if entries > capEntries || (entries&255 == 0 && ctx.Err() != nil) {
						partial = true
						_ = subDir.Close()
						break outerLoop
					}
					if f.Err != nil {
						if unsup := asUnsupportedErr(f.Err); unsup != nil {
							_ = subDir.Close()
							return 0, false, unsup
						}
						if !isSkipEntryErr(f.Err) {
							partial = true
						}
						continue
					}
					name := f.Name
					if !isSafeChildName(name) {
						continue
					}
					if !strings.Contains(name, "-json.log") && !strings.HasSuffix(name, ".log") {
						continue
					}
					if f.Kind != entryRegular && f.Kind != entryUnknown {
						continue
					}
					child := joinLogical(sub, name)
					if scope.isOtherMount(child) {
						continue
					}
					var st entryStat
					if f.HasStat {
						st = f.Stat
					} else {
						var serr error
						st, serr = subDir.StatEntry(name, child)
						if serr != nil {
							if unsup := asUnsupportedErr(serr); unsup != nil {
								_ = subDir.Close()
								return 0, false, unsup
							}
							if !isSkipEntryErr(serr) {
								partial = true
							}
							continue
						}
					}
					if st.Mode&fs.ModeSymlink != 0 || !st.Mode.IsRegular() {
						continue
					}
					if !st.HasDev || st.Dev != rootDev {
						continue
					}
					if rootMntID != 0 && (!st.HasMntID || st.MntID != rootMntID) {
						continue
					}
					if st.HasInode && st.Nlink > 1 {
						k := inodeKey{dev: st.Dev, ino: st.Ino}
						if _, dup := seen[k]; dup {
							continue
						}
						if len(seen) < MaxSeenInodes {
							seen[k] = struct{}{}
						}
					}
					total += st.AllocBytes
				}
				if ferr != nil {
					if unsup := asUnsupportedErr(ferr); unsup != nil {
						_ = subDir.Close()
						return 0, false, unsup
					}
					if !errors.Is(ferr, io.EOF) && !isSkipDirErr(ferr) {
						partial = true
					}
					break
				}
				if len(files) == 0 {
					break
				}
			}
			_ = subDir.Close()
		}
		if rerr != nil {
			if unsup := asUnsupportedErr(rerr); unsup != nil {
				return 0, false, unsup
			}
			if !errors.Is(rerr, io.EOF) && !isSkipDirErr(rerr) {
				partial = true
			}
			break
		}
		if len(ents) == 0 {
			break
		}
	}

	return total, partial, nil
}

// ---- VM disks & snapshots --------------------------------------------------------------

func (r *Runner) collectVMAndSnapshots(ctx context.Context, rootDir scanDir, scope mountScope, rootDev, rootMntID uint64) (disks, snaps proto.DiskUsageCategory, partial bool, unsupported *scanUnsupportedError) {
	disks = proto.DiskUsageCategory{Key: proto.DiskCatVMDisks, Label: "VM disks"}
	snaps = proto.DiskUsageCategory{Key: proto.DiskCatVMSnapshots, Label: "Snapshots"}

	target := scope.target
	// ZFS pools report zvols (VM disks) and snapshots accurately without walking files.
	if target.FSType == "zfs" && target.Source != "" && r.runCmd != nil {
		if zDisks, zSnaps, ok := r.collectZFS(ctx, target.Source); ok {
			disks.Bytes += zDisks
			snaps.Bytes += zSnaps
		}
	}

	// File-backed VM disk directories on this mount.
	vmDirSet := map[string]bool{}
	addVMDir := func(p string) {
		p = categoryPathForScope(scope, p)
		if p != "" && strings.HasPrefix(p, "/") {
			vmDirSet[p] = true
		}
	}
	addVMDir("/var/lib/libvirt/images")
	addVMDir("/var/lib/vz/images")
	addVMDir("/var/lib/vz/private")
	addVMDir("/var/lib/incus/storage-pools")

	if r.inventory != nil {
		if rep := r.inventory(); rep != nil && rep.Libvirt != nil && rep.Libvirt.Libvirt != nil {
			lv := rep.Libvirt.Libvirt
			for _, pool := range lv.Pools {
				if pool.Active && pool.Path != "" && (pool.Type == "dir" || pool.Type == "fs") {
					addVMDir(pool.Path)
				}
			}
			if lv.Folders != nil && lv.Folders.Domains != "" {
				addVMDir(lv.Folders.Domains)
			}
		}
	}

	// Remove nested subdirectories so we never double-count.
	vmDirs := pruneNestedPaths(vmDirSet)
	seen := map[inodeKey]struct{}{}
	for _, dir := range vmDirs {
		if ctx.Err() != nil {
			partial = true
			break
		}
		b, p, unsup := r.walkDirBytes(ctx, rootDir, scope, dir, rootDev, rootMntID, 6, seen)
		if unsup != nil {
			return proto.DiskUsageCategory{}, proto.DiskUsageCategory{}, false, unsup
		}
		if p {
			partial = true
		}
		disks.Bytes += b
	}

	// File-backed VM snapshot/save directories on this mount.
	snapSeen := map[inodeKey]struct{}{}
	for _, dir := range []string{"/var/lib/libvirt/qemu/snapshot", "/var/lib/libvirt/qemu/save"} {
		if ctx.Err() != nil {
			partial = true
			break
		}
		b, p, unsup := r.walkDirBytes(ctx, rootDir, scope, categoryPathForScope(scope, dir), rootDev, rootMntID, 4, snapSeen)
		if unsup != nil {
			return proto.DiskUsageCategory{}, proto.DiskUsageCategory{}, false, unsup
		}
		if p {
			partial = true
		}
		snaps.Bytes += b
	}

	return disks, snaps, partial, nil
}

func isSafeZFSDataset(dataset string) bool {
	if dataset == "" || strings.HasPrefix(dataset, "-") || strings.HasPrefix(dataset, "/") {
		return false
	}
	for _, c := range dataset {
		if c <= 0x20 || c == '@' || c == '\\' {
			return false
		}
	}
	return true
}

func (r *Runner) collectZFS(ctx context.Context, dataset string) (vmDisks, snapshots uint64, ok bool) {
	if !isSafeZFSDataset(dataset) {
		return 0, 0, false
	}
	out, err := r.runCmd(ctx, "zfs", "list", "-Hp", "-t", "filesystem,volume", "-o", "name,type,usedbydataset,usedbysnapshots", "-r", dataset)
	if err != nil {
		return 0, 0, false
	}
	return parseZFSUsage(out)
}

func parseZFSUsage(b []byte) (vmDisks, snapshots uint64, ok bool) {
	lines := strings.Split(strings.TrimSpace(string(b)), "\n")
	for _, line := range lines {
		f := strings.Split(line, "\t")
		if len(f) < 4 {
			continue
		}
		ok = true
		name, typ := f[0], f[1]
		usedDS, _ := strconv.ParseUint(strings.TrimSpace(f[2]), 10, 64)
		usedSnap, _ := strconv.ParseUint(strings.TrimSpace(f[3]), 10, 64)
		snapshots += usedSnap
		if typ == "volume" || isZFSGuestDataset(name) {
			vmDisks += usedDS
		}
	}
	return vmDisks, snapshots, ok
}

func isZFSGuestDataset(name string) bool {
	base := name
	if i := strings.LastIndexByte(name, '/'); i >= 0 {
		base = name[i+1:]
	}
	return strings.HasPrefix(base, "vm-") ||
		strings.HasPrefix(base, "subvol-") ||
		strings.Contains(name, "/virtual-machines/") ||
		strings.Contains(name, "/containers/")
}

func pruneNestedPaths(set map[string]bool) []string {
	list := make([]string, 0, len(set))
	for p := range set {
		list = append(list, p)
	}
	sort.Slice(list, func(i, j int) bool {
		if len(list[i]) != len(list[j]) {
			return len(list[i]) < len(list[j])
		}
		return list[i] < list[j]
	})
	var out []string
	for _, p := range list {
		nested := false
		for _, prev := range out {
			if hasPathPrefix(p, prev) {
				nested = true
				break
			}
		}
		if !nested {
			out = append(out, p)
		}
	}
	return out
}

func lookTool(name string) (string, error) {
	for _, dir := range []string{"/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin"} {
		p := filepath.Join(dir, name)
		if fi, err := os.Stat(p); err == nil && !fi.IsDir() && fi.Mode()&0o111 != 0 {
			return p, nil
		}
	}
	return exec.LookPath(name)
}

func runLowPriorityCmd(ctx context.Context, name string, args ...string) ([]byte, error) {
	path, err := lookTool(name)
	if err != nil {
		return nil, err
	}
	cmd := exec.CommandContext(ctx, path, args...)
	cmd.Dir = "/"
	cmd.Env = []string{
		"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
		"LC_ALL=C",
	}
	return cmd.Output()
}

const darwinDataVolumeMount = "/System/Volumes/Data"

// darwinDataPrefixes are root paths on macOS whose storage lives on the
// mutable Data volume (/System/Volumes/Data) via APFS firmlinks rather than on
// the sealed read-only system volume (/).
var darwinDataPrefixes = []string{
	"/Applications",
	"/Library",
	"/Users",
	"/opt",
	"/private",
	"/usr/local",
}

// categoryPathForScope resolves a logical category root onto the target mount
// when scanning macOS's /System/Volumes/Data volume.
func categoryPathForScope(scope mountScope, p string) string {
	clean := filepath.Clean(p)
	if scope.target.MountPoint != darwinDataVolumeMount {
		return clean
	}
	if hasPathPrefix(clean, darwinDataVolumeMount) {
		return clean
	}
	for _, pref := range darwinDataPrefixes {
		if hasPathPrefix(clean, pref) {
			return darwinDataVolumeMount + clean
		}
	}
	// On macOS, /var is a symlink to private/var on the Data volume.
	if hasPathPrefix(clean, "/var") {
		return darwinDataVolumeMount + "/private" + clean
	}
	return clean
}
