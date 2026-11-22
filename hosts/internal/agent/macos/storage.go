package macos

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/shirou/gopsutil/v4/disk"

	"rackoon/internal/proto"
)

// Mount is one mounted file system (gopsutil's getfsstat).
type Mount struct {
	Device, Mount, FSType string
	Opts                  []string
}

// volume is one reported file system with what statfs said.
type volume struct {
	proto.Filesystem
	container string // the APFS container or whole disk ("disk3"), "" for a share
}

// Skipped file system types: kernel and automounter views, not storage.
var skipFS = map[string]bool{"devfs": true, "autofs": true, "devicefs": true, "nullfs": true, "fdesc": true, "lifs": true, "bindfs": true}

var remoteFS = map[string]bool{"smbfs": true, "nfs": true, "afpfs": true, "webdav": true, "cifs": true}

// PickVolumes chooses what the report shows of the mounts: one file
// system per APFS container (its volumes share the container's space, so
// each would show the same numbers), the startup volume as "/", other
// containers and disks by their visible mount (the ones in /Volumes);
// system and hidden ("nobrowse") volumes, disk images of Xcode's
// simulators and the like are left out. Network shares count as remote.
func PickVolumes(mounts []Mount) []volume {
	type pick struct {
		m    Mount
		root bool
	}
	best := map[string]pick{}
	var order []string
	var shares []volume
	for _, m := range mounts {
		if skipFS[m.FSType] || m.Mount == "" {
			continue
		}
		hidden := hasOpt(m.Opts, "nobrowse")
		if remoteFS[m.FSType] {
			if !hidden {
				shares = append(shares, volume{Filesystem: proto.Filesystem{Mount: m.Mount, Device: clip(m.Device, 200), FSType: m.FSType, Remote: true}})
			}
			continue
		}
		cont := ContainerOfDevice(m.Device)
		if cont == "" {
			continue
		}
		root := m.Mount == "/"
		if hidden && !root {
			continue
		}
		cur, ok := best[cont]
		switch {
		case !ok:
			order = append(order, cont)
		case cur.root:
			continue
		case !root && len(cur.m.Mount) <= len(m.Mount):
			continue
		}
		best[cont] = pick{m: m, root: root}
	}
	var out []volume
	for _, cont := range order {
		p := best[cont]
		dev := "/dev/" + cont
		out = append(out, volume{container: cont, Filesystem: proto.Filesystem{Mount: p.m.Mount, Device: dev, FSType: p.m.FSType}})
	}
	sort.SliceStable(out, func(i, j int) bool {
		if (out[i].Mount == "/") != (out[j].Mount == "/") {
			return out[i].Mount == "/"
		}
		return out[i].Mount < out[j].Mount
	})
	out = append(out, shares...)
	if len(out) > 64 {
		out = out[:64]
	}
	return out
}

func hasOpt(opts []string, o string) bool {
	for _, x := range opts {
		if x == o {
			return true
		}
	}
	return false
}

// runVolumes lists the mounts and reads each chosen one's size.
func (c *Collector) runVolumes(ctx context.Context) error {
	parts, err := disk.PartitionsWithContext(ctx, true)
	if err != nil && len(parts) == 0 {
		return err
	}
	mounts := make([]Mount, 0, len(parts))
	for _, p := range parts {
		mounts = append(mounts, Mount{Device: p.Device, Mount: p.Mountpoint, FSType: p.Fstype, Opts: p.Opts})
	}
	vols := PickVolumes(mounts)
	var errs []error
	for i := range vols {
		v := &vols[i]
		st, err := statfsTimeout(v.Mount, 5*time.Second)
		if err != nil {
			v.Error = clip(err.Error(), 200)
			if !v.Remote {
				errs = append(errs, err)
			}
			continue
		}
		bs := uint64(st.Bsize)
		used := (st.Blocks - st.Bfree) * bs
		v.SizeBytes, v.UsedBytes = used+st.Bavail*bs, used
		// APFS and network shares have no fixed number of files.
		if v.FSType != "apfs" && !v.Remote {
			v.InodesTotal, v.InodesUsed = st.Files, st.Files-min(st.Ffree, st.Files)
		}
	}
	c.mu.Lock()
	c.vols = vols
	c.mu.Unlock()
	return errors.Join(errs...)
}

var (
	statfsMu   sync.Mutex
	statfsHung = map[string]bool{}
)

// statfsTimeout runs statfs with a time limit (a share whose server is
// gone blocks it); a mount still blocked is skipped until its call
// returns.
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
		statfsMu.Lock()
		delete(statfsHung, mount)
		statfsMu.Unlock()
		ch <- res{st, err}
	}()
	select {
	case r := <-ch:
		return r.st, r.err
	case <-time.After(d):
		statfsMu.Lock()
		statfsHung[mount] = true
		statfsMu.Unlock()
		return syscall.Statfs_t{}, fmt.Errorf("statfs %s: no answer within %s", mount, d)
	}
}

// FilesystemsWithDisks copies the collected volumes and fills Filesystem.Disks
// with the whole physical disks backing each local volume (resolving
// synthesized APFS containers through DiskList.Containers).
func FilesystemsWithDisks(vols []volume, list *DiskList, disks []proto.Disk) []proto.Filesystem {
	phys := make(map[string]bool, len(disks))
	for _, d := range disks {
		if d.Device != "" {
			phys[d.Device] = true
		}
	}
	out := make([]proto.Filesystem, 0, len(vols))
	for _, v := range vols {
		fs := v.Filesystem
		if !fs.Remote && v.container != "" {
			if list != nil && list.IsContainer(v.container) {
				seen := map[string]bool{}
				for _, w := range list.Containers[v.container] {
					if w != "" && !seen[w] {
						seen[w] = true
						fs.Disks = append(fs.Disks, w)
					}
				}
			} else if phys[v.container] {
				fs.Disks = []string{v.container}
			}
		}
		out = append(out, fs)
	}
	return out
}

// ---- disks -------------------------------------------------------------------------------

// runDisks reads the whole disks (diskutil list) and each physical one's
// details and SMART verdict (diskutil info).
func (c *Collector) runDisks(ctx context.Context) error {
	lb, err := Run(ctx, 30*time.Second, Diskutil, "list", "-plist")
	if err != nil {
		return err
	}
	list, err := ParseDiskutilList(lb)
	if err != nil {
		return err
	}
	var disks []proto.Disk
	var errs []error
	for _, w := range list.WholeDisks {
		if list.IsContainer(w) {
			continue
		}
		ib, err := Run(ctx, 30*time.Second, Diskutil, "info", "-plist", w)
		if err != nil {
			errs = append(errs, err)
			continue
		}
		di, err := ParseDiskutilInfo(ib)
		if err != nil {
			errs = append(errs, fmt.Errorf("%s: %w", w, err))
			continue
		}
		if di.Virtual || di.Device != w {
			continue
		}
		disks = append(disks, di.Disk())
	}
	c.mu.Lock()
	c.disks, c.list = disks, list
	c.mu.Unlock()
	return errors.Join(errs...)
}

// disksWithUse adds the space used and the role from the volumes on each
// disk, and the disk's rates (c.mu held).
func (c *Collector) disksWithUse() []proto.Disk {
	return DisksWithUse(c.disks, c.list, c.vols, c.diskIO)
}

// DisksWithUse maps volumes to the physical disks below them.
func DisksWithUse(disks []proto.Disk, list *DiskList, vols []volume, io map[string]*proto.DiskIO) []proto.Disk {
	out := make([]proto.Disk, 0, len(disks))
	for _, d := range disks {
		var used uint64
		var mounts []string
		for _, v := range vols {
			if v.container == "" || v.Error != "" {
				continue
			}
			on := v.container == d.Device
			if list != nil {
				for _, w := range list.Containers[v.container] {
					if w == d.Device {
						on = true
					}
				}
			}
			if on {
				used += v.UsedBytes
				mounts = append(mounts, v.Mount)
			}
		}
		if len(mounts) > 0 {
			u := used
			d.UsedBytes = &u
			role := strings.Join(mounts, ", ")
			if mounts[0] == "/" {
				role = "System · " + role
			}
			d.Role = clip(role, 200)
		}
		if x, ok := io[d.Device]; ok {
			cp := *x
			d.IO = &cp
		}
		out = append(out, d)
	}
	return out
}
