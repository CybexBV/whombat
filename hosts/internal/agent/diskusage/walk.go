package diskusage

import (
	"context"
	"io/fs"
	"path/filepath"
	"sort"

	"rackoon/internal/proto"
)

type inodeKey struct {
	dev uint64
	ino uint64
}

type dirNode struct {
	path        string
	depth       int
	directBytes uint64
	totalBytes  uint64
	partial     bool
	children    []*dirNode
}

type walkResult struct {
	folders []proto.DiskUsageFolder
	partial bool
}

// virtualRoots are kernel/runtime filesystems never worth traversing even if
// mountinfo was incomplete or in a chroot/test root.
var virtualRoots = map[string]bool{
	"/proc": true,
	"/sys":  true,
	"/dev":  true,
	"/run":  true,
}

func (r *Runner) walkMount(ctx context.Context, rootDir scanDir, scope mountScope, rootDev, rootMntID uint64, maxDepth int) walkResult {
	mount := scope.target.MountPoint
	maxEntries := r.maxEntries
	if maxEntries <= 0 {
		maxEntries = DefaultMaxEntries
	}
	seen := make(map[inodeKey]struct{}, 1024)
	entries := 0
	partial := false

	startDir, err := rootDir.OpenSelf()
	if err != nil {
		return walkResult{partial: !isSkipDirErr(err)}
	}
	defer startDir.Close()

	var visit func(dir scanDir, logicalPath string, depth int) *dirNode
	visit = func(dir scanDir, logicalPath string, depth int) *dirNode {
		node := &dirNode{path: logicalPath, depth: depth}
		if ctx.Err() != nil {
			partial = true
			node.partial = true
			return node
		}
		ents, err := dir.ReadDir()
		if err != nil {
			if !isSkipDirErr(err) {
				partial = true
				node.partial = true
			}
			return node
		}
		for _, e := range ents {
			entries++
			if entries > maxEntries {
				partial = true
				node.partial = true
				return node
			}
			if entries&255 == 0 && ctx.Err() != nil {
				partial = true
				node.partial = true
				return node
			}

			name := e.Name
			if !isSafeChildName(name) {
				continue
			}

			// Skip known symlinks, sockets, pipes and devices without any syscall.
			if e.Kind == entrySymlink || e.Kind == entryOther {
				continue
			}

			childLogical := joinLogical(logicalPath, name)

			// Skip mount points known from mountinfo (including bind mounts) and virtual
			// roots BEFORE any open or stat so a sleeping disk or stalled network mount
			// below this mount is never touched.
			if scope.isOtherMount(childLogical) {
				continue
			}

			// Known directory from d_type: resolve directly from dir without a prior
			// stat so a mount appearing mid-walk is refused before touching it.
			if e.Kind == entryDir {
				if depth >= maxDepth {
					// Confirm it is still a same-mount directory (not a newly mounted fs
					// or symlink) without reading its contents.
					subDir, err := dir.OpenDir(name, childLogical, true)
					if err != nil {
						if !isSkipDirErr(err) {
							partial = true
							node.partial = true
						}
						continue
					}
					_ = subDir.Close()
					partial = true
					node.partial = true
					continue
				}
				subDir, err := dir.OpenDir(name, childLogical, false)
				if err != nil {
					if !isSkipDirErr(err) {
						partial = true
						node.partial = true
					}
					continue
				}
				sub := visit(subDir, childLogical, depth+1)
				_ = subDir.Close()
				node.children = append(node.children, sub)
				node.totalBytes += sub.totalBytes
				if sub.partial {
					node.partial = true
				}
				continue
			}

			// Regular file or DT_UNKNOWN: stat relative to dir without crossing mounts.
			st, err := dir.StatEntry(name, childLogical)
			if err != nil {
				if !isSkipEntryErr(err) {
					partial = true
					node.partial = true
				}
				continue
			}
			if st.Mode&fs.ModeSymlink != 0 {
				continue
			}
			if !st.HasDev || st.Dev != rootDev {
				continue
			}
			if rootMntID != 0 && st.HasMntID && st.MntID != rootMntID {
				continue
			}

			if st.Mode.IsDir() {
				if depth >= maxDepth {
					partial = true
					node.partial = true
					continue
				}
				subDir, err := dir.OpenDir(name, childLogical, false)
				if err != nil {
					if !isSkipDirErr(err) {
						partial = true
						node.partial = true
					}
					continue
				}
				sub := visit(subDir, childLogical, depth+1)
				_ = subDir.Close()
				node.children = append(node.children, sub)
				node.totalBytes += sub.totalBytes
				if sub.partial {
					node.partial = true
				}
				continue
			}

			if !st.Mode.IsRegular() {
				continue
			}

			// Deduplicate hardlinks so shared backups or layers are counted once.
			if st.HasInode && st.Nlink > 1 {
				k := inodeKey{dev: st.Dev, ino: st.Ino}
				if _, dup := seen[k]; dup {
					continue
				}
				if len(seen) < MaxSeenInodes {
					seen[k] = struct{}{}
				}
			}

			node.directBytes += st.AllocBytes
			node.totalBytes += st.AllocBytes
		}
		return node
	}

	root := visit(startDir, mount, 0)
	folders := pickLargestFolders(root, maxDepth, MaxFolders)
	return walkResult{folders: folders, partial: partial}
}

// pickLargestFolders selects up to limit non-overlapping large folders. It
// drills past container directories like /var -> /var/lib -> /var/lib/docker
// when a single child dominates, so the report names the actual culprit without
// double-counting parents and children.
func pickLargestFolders(root *dirNode, maxDepth, limit int) []proto.DiskUsageFolder {
	if root == nil || limit <= 0 {
		return nil
	}
	expandLimit := min(maxDepth, 3)

	// Start with direct subdirectories of the mount.
	cands := make([]*dirNode, 0, len(root.children)+1)
	for _, c := range root.children {
		if c.totalBytes > 0 {
			cands = append(cands, c)
		}
	}

	// Iteratively drill down into dominant wrapper folders (such as /var or
	// /var/lib) while keeping candidates non-overlapping.
	for i := 0; i < len(cands) && len(cands) < limit*4; i++ {
		d := cands[i]
		if d.depth >= expandLimit || len(d.children) == 0 || d.totalBytes == 0 {
			continue
		}
		subBytes := d.totalBytes - d.directBytes
		// Only expand when at least 80% of the folder's space sits in its
		// subdirectories and the largest child holds at least 45% of the folder.
		if subBytes*100 < d.totalBytes*80 {
			continue
		}
		var maxChild uint64
		for _, ch := range d.children {
			if ch.totalBytes > maxChild {
				maxChild = ch.totalBytes
			}
		}
		if maxChild*100 < d.totalBytes*45 {
			continue
		}
		// Replace d with its non-empty children.
		cands[i] = nil
		for _, ch := range d.children {
			if ch.totalBytes > 0 {
				cands = append(cands, ch)
			}
		}
	}

	out := make([]proto.DiskUsageFolder, 0, len(cands)+1)
	for _, d := range cands {
		if d == nil || d.totalBytes == 0 {
			continue
		}
		out = append(out, proto.DiskUsageFolder{
			Path:    d.path,
			Bytes:   d.totalBytes,
			Partial: d.partial,
		})
	}
	// If significant files sit directly in the mount root (or there are no
	// subdirectories), include the mount root's direct files so the space is visible.
	if root.directBytes > 0 && (len(out) == 0 || root.directBytes*10 >= root.totalBytes) {
		out = append(out, proto.DiskUsageFolder{
			Path:    root.path,
			Bytes:   root.directBytes,
			Partial: root.partial && len(out) == 0,
		})
	}

	sort.Slice(out, func(i, j int) bool {
		if out[i].Bytes != out[j].Bytes {
			return out[i].Bytes > out[j].Bytes
		}
		return out[i].Path < out[j].Path
	})
	if len(out) > limit {
		out = out[:limit]
	}
	return out
}

// walkDirBytes measures allocated bytes inside one targeted directory on the
// target mount, resolving every step relative to rootDir without crossing
// mounts or following symlinks, bounded by ctx, depth and entry cap.
func (r *Runner) walkDirBytes(ctx context.Context, rootDir scanDir, scope mountScope, logicalDir string, rootDev, rootMntID uint64, maxDepth int, seen map[inodeKey]struct{}) (bytes uint64, partial bool) {
	cleanDir := filepath.Clean(logicalDir)
	startDir, err := openRelDir(rootDir, scope, cleanDir, false)
	if err != nil {
		if !isSkipDirErr(err) {
			return 0, true
		}
		return 0, false
	}
	defer startDir.Close()

	entries := 0
	const capEntries = 100_000
	var walk func(dir scanDir, p string, depth int)
	walk = func(dir scanDir, p string, depth int) {
		if ctx.Err() != nil {
			partial = true
			return
		}
		ents, err := dir.ReadDir()
		if err != nil {
			if !isSkipDirErr(err) {
				partial = true
			}
			return
		}
		for _, e := range ents {
			entries++
			if entries > capEntries || (entries&255 == 0 && ctx.Err() != nil) {
				partial = true
				return
			}
			name := e.Name
			if !isSafeChildName(name) {
				continue
			}
			if e.Kind == entrySymlink || e.Kind == entryOther {
				continue
			}
			child := joinLogical(p, name)
			if scope.isOtherMount(child) {
				continue
			}
			if e.Kind == entryDir {
				if depth >= maxDepth {
					subDir, err := dir.OpenDir(name, child, true)
					if err != nil {
						if !isSkipDirErr(err) {
							partial = true
						}
						continue
					}
					_ = subDir.Close()
					partial = true
					continue
				}
				subDir, err := dir.OpenDir(name, child, false)
				if err != nil {
					if !isSkipDirErr(err) {
						partial = true
					}
					continue
				}
				walk(subDir, child, depth+1)
				_ = subDir.Close()
				continue
			}

			st, err := dir.StatEntry(name, child)
			if err != nil {
				if !isSkipEntryErr(err) {
					partial = true
				}
				continue
			}
			if st.Mode&fs.ModeSymlink != 0 {
				continue
			}
			if !st.HasDev || st.Dev != rootDev {
				continue
			}
			if rootMntID != 0 && st.HasMntID && st.MntID != rootMntID {
				continue
			}
			if st.Mode.IsDir() {
				if depth >= maxDepth {
					partial = true
					continue
				}
				subDir, err := dir.OpenDir(name, child, false)
				if err != nil {
					if !isSkipDirErr(err) {
						partial = true
					}
					continue
				}
				walk(subDir, child, depth+1)
				_ = subDir.Close()
				continue
			}
			if !st.Mode.IsRegular() {
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
			bytes += st.AllocBytes
		}
	}
	walk(startDir, cleanDir, 0)
	return bytes, partial
}

func joinLogical(base, name string) string {
	if base == "/" {
		return "/" + name
	}
	return base + "/" + name
}
