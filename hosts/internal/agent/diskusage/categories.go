package diskusage

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"rackoon/internal/proto"
)

// collectCategories measures known storage consumers that live on the requested
// mount (checked against the mount table before any stat, then st_dev and mount
// ID). Every category is optional and bounded by ctx.
func (r *Runner) collectCategories(ctx context.Context, scope mountScope, rootDev, rootMntID uint64) ([]proto.DiskUsageCategory, bool) {
	var cats []proto.DiskUsageCategory
	partial := false

	add := func(cat proto.DiskUsageCategory) {
		if cat.Bytes > 0 {
			cats = append(cats, cat)
		}
	}

	// 1. Container engine (Docker / Podman via unix socket HTTP API).
	dockerCats, dockerPartial := r.collectDocker(ctx, scope, rootDev, rootMntID)
	for _, c := range dockerCats {
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
			b, p := r.walkDirBytes(ctx, scope, dir, rootDev, rootMntID, 4, seen)
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
			b, p := r.walkDirBytes(ctx, scope, pd.path, rootDev, rootMntID, 5, seen)
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
		vmDisks, vmSnaps, vmPartial := r.collectVMAndSnapshots(ctx, scope, rootDev, rootMntID)
		if vmPartial {
			partial = true
		}
		add(vmDisks)
		add(vmSnaps)
	}

	sort.Slice(cats, func(i, j int) bool {
		if cats[i].Bytes != cats[j].Bytes {
			return cats[i].Bytes > cats[j].Bytes
		}
		return cats[i].Key < cats[j].Key
	})
	return cats, partial
}

// ---- Docker / container engine ---------------------------------------------------------

type dockerInfo struct {
	DockerRootDir string `json:"DockerRootDir"`
}

type dockerSystemDF struct {
	LayersSize int64 `json:"LayersSize"`
	Images     []struct {
		Size       int64 `json:"Size"`
		SharedSize int64 `json:"SharedSize"`
		Containers int64 `json:"Containers"`
	} `json:"Images"`
	BuildCache []struct {
		Size   int64 `json:"Size"`
		InUse  bool  `json:"InUse"`
		Shared bool  `json:"Shared"`
	} `json:"BuildCache"`
}

func (r *Runner) collectDocker(ctx context.Context, scope mountScope, rootDev, rootMntID uint64) ([]proto.DiskUsageCategory, bool) {
	var out []proto.DiskUsageCategory
	partial := false

	dockerRoot := "/var/lib/docker"
	sock := r.findDockerSocket()
	var df *dockerSystemDF
	var rootOnMount bool

	if sock != "" && ctx.Err() == nil {
		client := unixHTTPClient(sock, 10*time.Second)
		var info dockerInfo
		if err := dockerGet(ctx, client, "/info", &info); err == nil && info.DockerRootDir != "" {
			dockerRoot = filepath.Clean(info.DockerRootDir)
		}
		// Check mount table before any stat, then verify st_dev and mount ID.
		// Request only images and build cache so dockerd never runs an unbounded
		// high-priority volume/container walk past our deadline.
		rootOnMount = r.pathInScope(scope, dockerRoot, rootDev, rootMntID)
		if rootOnMount {
			var res dockerSystemDF
			if err := dockerGet(ctx, client, "/system/df?type=image&type=build-cache", &res); err == nil {
				df = &res
			} else if ctx.Err() != nil {
				partial = true
			}
		}
	}

	if df != nil && rootOnMount {
		imgBytes, imgReclaim, imgUnused := summarizeDockerImages(df)
		detail := ""
		if len(df.Images) > 0 {
			detail = fmt.Sprintf("%d %s", len(df.Images), plural(len(df.Images), "image", "images"))
			if imgUnused > 0 {
				detail += fmt.Sprintf(", %d unused", imgUnused)
			}
		}
		if imgBytes > 0 {
			out = append(out, proto.DiskUsageCategory{
				Key:              proto.DiskCatContainerImages,
				Label:            "Container images",
				Bytes:            imgBytes,
				ReclaimableBytes: imgReclaim,
				Detail:           detail,
			})
		}

		bcBytes, bcReclaim := summarizeDockerBuildCache(df)
		if bcBytes > 0 {
			out = append(out, proto.DiskUsageCategory{
				Key:              proto.DiskCatContainerBuildCache,
				Label:            "Container build cache",
				Bytes:            bcBytes,
				ReclaimableBytes: bcReclaim,
			})
		}
	}

	// Measure Docker volumes with our own low-priority bounded walk inside the
	// mount scope, never delegating volume walks to dockerd.
	if ctx.Err() == nil {
		volDir := filepath.Join(dockerRoot, "volumes")
		seen := map[inodeKey]struct{}{}
		volBytes, volPartial := r.walkDirBytes(ctx, scope, volDir, rootDev, rootMntID, 6, seen)
		if volPartial {
			partial = true
		}
		if volBytes > 0 {
			out = append(out, proto.DiskUsageCategory{
				Key:   proto.DiskCatContainerVolumes,
				Label: "Container volumes",
				Bytes: volBytes,
			})
		}
	}

	// Container logs: <DockerRootDir>/containers/*/*-json.log* (and /var/log/pods
	// if present on this mount). Always measure directly on disk because Docker
	// /system/df does not separate container logs from writable layers.
	if ctx.Err() == nil {
		logBytes, logPartial := r.collectContainerLogs(ctx, scope, dockerRoot, rootDev, rootMntID)
		if logPartial {
			partial = true
		}
		if logBytes > 0 {
			out = append(out, proto.DiskUsageCategory{
				Key:   proto.DiskCatContainerLogs,
				Label: "Container logs",
				Bytes: logBytes,
			})
		}
	}

	return out, partial
}

func summarizeDockerImages(df *dockerSystemDF) (total, reclaimable uint64, unused int) {
	if df.LayersSize > 0 {
		total = uint64(df.LayersSize)
	}
	var sumUnique uint64
	for _, img := range df.Images {
		unique := img.Size
		if img.SharedSize > 0 && img.SharedSize <= img.Size {
			unique = img.Size - img.SharedSize
		}
		if unique > 0 {
			sumUnique += uint64(unique)
		}
		if img.Containers <= 0 {
			unused++
			if unique > 0 {
				reclaimable += uint64(unique)
			}
		}
	}
	if total == 0 {
		total = sumUnique
	}
	if reclaimable > total {
		reclaimable = total
	}
	return total, reclaimable, unused
}

func summarizeDockerBuildCache(df *dockerSystemDF) (total, reclaimable uint64) {
	for _, bc := range df.BuildCache {
		if bc.Size <= 0 || bc.Shared {
			continue
		}
		total += uint64(bc.Size)
		if !bc.InUse {
			reclaimable += uint64(bc.Size)
		}
	}
	return total, reclaimable
}

func (r *Runner) collectContainerLogs(ctx context.Context, scope mountScope, dockerRoot string, rootDev, rootMntID uint64) (uint64, bool) {
	var total uint64
	partial := false
	seen := map[inodeKey]struct{}{}

	containersDir := filepath.Join(dockerRoot, "containers")
	if r.pathInScope(scope, containersDir, rootDev, rootMntID) {
		ents, err := r.readDirInScope(scope, containersDir, rootDev, rootMntID)
		if err == nil {
			for _, e := range ents {
				if ctx.Err() != nil {
					partial = true
					break
				}
				if e.Type()&os.ModeSymlink != 0 || !e.IsDir() {
					continue
				}
				sub := joinLogical(containersDir, e.Name())
				if scope.isOtherMount(sub) {
					continue
				}
				files, err := r.readDirInScope(scope, sub, rootDev, rootMntID)
				if err != nil {
					continue
				}
				for _, f := range files {
					name := f.Name()
					if !strings.Contains(name, "-json.log") && !strings.HasSuffix(name, ".log") {
						continue
					}
					if f.Type()&os.ModeSymlink != 0 {
						continue
					}
					child := joinLogical(sub, name)
					if scope.isOtherMount(child) {
						continue
					}
					fi, err := f.Info()
					if err != nil || !fi.Mode().IsRegular() {
						continue
					}
					dev, ok := statDev(fi)
					if !ok || dev != rootDev {
						continue
					}
					if rootMntID != 0 {
						if id, ok := r.mountIDAt(child, 0, false); ok && id != rootMntID {
							continue
						}
					}
					if ino, nlink, ok := statInode(fi); ok && nlink > 1 {
						k := inodeKey{dev: dev, ino: ino}
						if _, dup := seen[k]; dup {
							continue
						}
						if len(seen) < MaxSeenInodes {
							seen[k] = struct{}{}
						}
					}
					total += allocatedBytes(fi)
				}
			}
		}
	}

	// Kubernetes / CRI container logs if present on this mount.
	if ctx.Err() == nil {
		b, p := r.walkDirBytes(ctx, scope, "/var/log/pods", rootDev, rootMntID, 4, seen)
		total += b
		if p {
			partial = true
		}
	}
	return total, partial
}

func (r *Runner) findDockerSocket() string {
	for _, s := range r.dockerSockets {
		p := r.hostPath(s)
		fi, err := os.Stat(p)
		if err == nil && fi.Mode()&os.ModeSocket != 0 {
			return p
		}
	}
	return ""
}

func unixHTTPClient(socketPath string, timeout time.Duration) *http.Client {
	return &http.Client{
		Timeout: timeout,
		Transport: &http.Transport{
			DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
				var d net.Dialer
				return d.DialContext(ctx, "unix", socketPath)
			},
		},
	}
}

func dockerGet(ctx context.Context, client *http.Client, path string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://docker"+path, nil)
	if err != nil {
		return err
	}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("status %s", resp.Status)
	}
	// Cap response size to 16 MiB so a pathological daemon cannot exhaust memory.
	return json.NewDecoder(io.LimitReader(resp.Body, 16<<20)).Decode(out)
}

// ---- VM disks & snapshots --------------------------------------------------------------

func (r *Runner) collectVMAndSnapshots(ctx context.Context, scope mountScope, rootDev, rootMntID uint64) (disks, snaps proto.DiskUsageCategory, partial bool) {
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
		p = filepath.Clean(p)
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
		b, p := r.walkDirBytes(ctx, scope, dir, rootDev, rootMntID, 6, seen)
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
		b, p := r.walkDirBytes(ctx, scope, dir, rootDev, rootMntID, 4, snapSeen)
		if p {
			partial = true
		}
		snaps.Bytes += b
	}

	return disks, snaps, partial
}

func (r *Runner) collectZFS(ctx context.Context, dataset string) (vmDisks, snapshots uint64, ok bool) {
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

func plural(n int, one, many string) string {
	if n == 1 {
		return one
	}
	return many
}
