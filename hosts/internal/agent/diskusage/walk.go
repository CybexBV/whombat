package diskusage

import (
	"context"
	"errors"
	"io/fs"
	"path/filepath"
	"sort"
	"strings"

	"rackoon/internal/proto"
)

var errWrongMount = errors.New("path is outside target mount")

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

func (r *Runner) mountIDAt(logicalPath string, fdMntID uint64, fdHasMntID bool) (uint64, bool) {
	if r.statMountID != nil {
		return r.statMountID(logicalPath)
	}
	if r.root != "" {
		return 0, false
	}
	if fdHasMntID {
		return fdMntID, true
	}
	return hostStatMountID(r.hostPath(logicalPath))
}

func isSkipDirErr(err error) bool {
	return errors.Is(err, errWrongMount) || isSymlinkLoopErr(err) || errors.Is(err, fs.ErrNotExist)
}

// checkPathInScope checks that logicalPath lies inside scope (using mountinfo
// mount IDs before any stat) and walks every component from the mount root down
// to logicalPath without following symlinks, verifying st_dev and mount ID match.
// Returns partial=true when an in-scope component is unreadable (permission error).
func (r *Runner) checkPathInScope(scope mountScope, logicalPath string, rootDev, rootMntID uint64) (ok bool, partial bool) {
	p := filepath.Clean(logicalPath)
	if !scope.containsPath(p) {
		return false, false
	}
	target := scope.target.MountPoint
	steps := []string{target}
	if p != target {
		rel := strings.TrimPrefix(p, target)
		rel = strings.TrimPrefix(rel, "/")
		cur := target
		for _, seg := range strings.Split(rel, "/") {
			if seg == "" {
				continue
			}
			cur = joinLogical(cur, seg)
			steps = append(steps, cur)
		}
	}
	for i, cur := range steps {
		if i > 0 && scope.isOtherMount(cur) {
			return false, false
		}
		fi, err := r.doLstat(r.hostPath(cur))
		if err != nil {
			if errors.Is(err, fs.ErrPermission) {
				return false, true
			}
			return false, false
		}
		if fi.Mode()&fs.ModeSymlink != 0 {
			return false, false
		}
		dev, hasDev := statDev(fi)
		if !hasDev || dev != rootDev {
			return false, false
		}
		if rootMntID != 0 {
			if id, ok := r.mountIDAt(cur, 0, false); ok && id != rootMntID {
				return false, false
			}
		}
		if i < len(steps)-1 && !fi.IsDir() {
			return false, false
		}
	}
	return true, false
}

func (r *Runner) pathInScope(scope mountScope, logicalPath string, rootDev, rootMntID uint64) bool {
	ok, _ := r.checkPathInScope(scope, logicalPath, rootDev, rootMntID)
	return ok
}

func (r *Runner) readDirInScope(scope mountScope, logicalPath string, rootDev, rootMntID uint64) ([]fs.DirEntry, error) {
	p := filepath.Clean(logicalPath)
	if !scope.containsPath(p) {
		return nil, errWrongMount
	}
	if r.readDir != nil {
		return r.readDir(p)
	}
	f, dev, fdMntID, fdHasMntID, err := openDirNoFollow(r.hostPath(p))
	if err != nil {
		return nil, err
	}
	defer f.Close()
	if dev != rootDev {
		return nil, errWrongMount
	}
	if rootMntID != 0 {
		if id, ok := r.mountIDAt(p, fdMntID, fdHasMntID); ok && id != rootMntID {
			return nil, errWrongMount
		}
	}
	return f.ReadDir(-1)
}

func (r *Runner) walkMount(ctx context.Context, scope mountScope, rootDev, rootMntID uint64, maxDepth int) walkResult {
	mount := scope.target.MountPoint
	maxEntries := r.maxEntries
	if maxEntries <= 0 {
		maxEntries = DefaultMaxEntries
	}
	seen := make(map[inodeKey]struct{}, 1024)
	entries := 0
	partial := false

	var visit func(logicalPath string, depth int) *dirNode
	visit = func(logicalPath string, depth int) *dirNode {
		node := &dirNode{path: logicalPath, depth: depth}
		if ctx.Err() != nil {
			partial = true
			node.partial = true
			return node
		}
		ents, err := r.readDirInScope(scope, logicalPath, rootDev, rootMntID)
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

			name := e.Name()
			childLogical := joinLogical(logicalPath, name)

			// Skip symlinks, sockets, pipes and devices without calling Lstat.
			typ := e.Type()
			if typ&fs.ModeSymlink != 0 {
				continue
			}
			if typ != 0 && !typ.IsDir() && !typ.IsRegular() {
				continue
			}

			// Skip other mount points (including bind mounts) and virtual roots BEFORE Lstat so a
			// sleeping disk or stalled network mount below this mount is never touched.
			if scope.isOtherMount(childLogical) {
				continue
			}

			info, err := e.Info()
			if err != nil {
				if !errors.Is(err, fs.ErrNotExist) {
					partial = true
					node.partial = true
				}
				continue
			}
			mode := info.Mode()
			if mode&fs.ModeSymlink != 0 {
				continue
			}

			dev, hasDev := statDev(info)
			if !hasDev || dev != rootDev {
				// Never cross onto another filesystem.
				continue
			}
			if rootMntID != 0 {
				if id, ok := r.mountIDAt(childLogical, 0, false); ok && id != rootMntID {
					continue
				}
			}

			if mode.IsDir() {
				if depth >= maxDepth {
					// Record the folder exists at the limit, mark partial because
					// its contents were not traversed.
					partial = true
					node.partial = true
					continue
				}
				sub := visit(childLogical, depth+1)
				node.children = append(node.children, sub)
				node.totalBytes += sub.totalBytes
				if sub.partial {
					node.partial = true
				}
				continue
			}

			if !mode.IsRegular() {
				continue
			}

			// Deduplicate hardlinks so shared backups or layers are counted once.
			if ino, nlink, ok := statInode(info); ok && nlink > 1 {
				k := inodeKey{dev: dev, ino: ino}
				if _, dup := seen[k]; dup {
					continue
				}
				if len(seen) < MaxSeenInodes {
					seen[k] = struct{}{}
				}
			}

			sz := allocatedBytes(info)
			node.directBytes += sz
			node.totalBytes += sz
		}
		return node
	}

	root := visit(mount, 0)
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
// target mount, bounded by ctx, depth and entry cap. It checks the mount table
// before any stat or read so paths on other mounts (including bind mounts) are
// never touched.
func (r *Runner) walkDirBytes(ctx context.Context, scope mountScope, logicalDir string, rootDev, rootMntID uint64, maxDepth int, seen map[inodeKey]struct{}) (bytes uint64, partial bool) {
	cleanDir := filepath.Clean(logicalDir)
	ok, scopePartial := r.checkPathInScope(scope, cleanDir, rootDev, rootMntID)
	if !ok {
		return 0, scopePartial
	}
	info, err := r.doLstat(r.hostPath(cleanDir))
	if err != nil {
		if errors.Is(err, fs.ErrPermission) {
			return 0, true
		}
		return 0, false
	}
	if !info.IsDir() || info.Mode()&fs.ModeSymlink != 0 {
		return 0, false
	}

	entries := 0
	const capEntries = 100_000
	var walk func(p string, depth int)
	walk = func(p string, depth int) {
		if ctx.Err() != nil {
			partial = true
			return
		}
		ents, err := r.readDirInScope(scope, p, rootDev, rootMntID)
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
			typ := e.Type()
			if typ&fs.ModeSymlink != 0 {
				continue
			}
			if typ != 0 && !typ.IsDir() && !typ.IsRegular() {
				continue
			}
			child := joinLogical(p, e.Name())
			if scope.isOtherMount(child) {
				continue
			}
			ci, err := e.Info()
			if err != nil {
				if !errors.Is(err, fs.ErrNotExist) {
					partial = true
				}
				continue
			}
			if ci.Mode()&fs.ModeSymlink != 0 {
				continue
			}
			cdev, ok := statDev(ci)
			if !ok || cdev != rootDev {
				continue
			}
			if rootMntID != 0 {
				if id, ok := r.mountIDAt(child, 0, false); ok && id != rootMntID {
					continue
				}
			}
			if ci.IsDir() {
				if depth >= maxDepth {
					partial = true
					continue
				}
				walk(child, depth+1)
				continue
			}
			if !ci.Mode().IsRegular() {
				continue
			}
			if ino, nlink, ok := statInode(ci); ok && nlink > 1 {
				k := inodeKey{dev: cdev, ino: ino}
				if _, dup := seen[k]; dup {
					continue
				}
				if len(seen) < MaxSeenInodes {
					seen[k] = struct{}{}
				}
			}
			bytes += allocatedBytes(ci)
		}
	}
	walk(cleanDir, 0)
	return bytes, partial
}

func joinLogical(base, name string) string {
	if base == "/" {
		return "/" + name
	}
	return base + "/" + name
}
