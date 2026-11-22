package diskusage

import (
	"context"
	"errors"
	"io"
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
	folders     []proto.DiskUsageFolder
	partial     bool
	unsupported *scanUnsupportedError
	dockerRoots []string
	podmanRoots []string
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
	var unsupported *scanUnsupportedError
	var dockerRoots []string
	var podmanRoots []string

	startDir, err := rootDir.OpenSelf()
	if err != nil {
		if unsup := asUnsupportedErr(err); unsup != nil {
			return walkResult{unsupported: unsup}
		}
		return walkResult{partial: !isSkipDirErr(err)}
	}
	defer startDir.Close()

	var visit func(dir scanDir, logicalPath string, depth int) *dirNode
	visit = func(dir scanDir, logicalPath string, depth int) *dirNode {
		node := &dirNode{path: logicalPath, depth: depth}
		var childMarkers map[string]bool
		recordedDocker := false
		recordedPodman := false
		noteMarker := func(name string) {
			if logicalPath == "/" || !isContainerRootChild(name) {
				return
			}
			if childMarkers == nil {
				childMarkers = make(map[string]bool, 4)
			}
			childMarkers[name] = true
			if !recordedDocker && isDockerDataRoot(childMarkers) {
				recordedDocker = true
				dockerRoots = append(dockerRoots, logicalPath)
			}
			if !recordedPodman && isPodmanStorageRoot(childMarkers) {
				recordedPodman = true
				podmanRoots = append(podmanRoots, logicalPath)
			}
		}
		for {
			if unsupported != nil {
				return node
			}
			if ctx.Err() != nil {
				partial = true
				node.partial = true
				return node
			}
			rem := maxEntries - entries
			if rem < 0 {
				partial = true
				node.partial = true
				return node
			}
			batchCap := min(dirBatchSize, rem+1)
			ents, err := dir.ReadDirBatch(batchCap)
			// Pre-scan known subdirectory names in this batch before recursing so
			// a Docker or Podman data root is recognized even if recursing into a
			// large child (such as overlay2) later hits the entry cap.
			if logicalPath != "/" {
				for _, e := range ents {
					if e.Err == nil && e.Kind == entryDir && isSafeChildName(e.Name) && isContainerRootChild(e.Name) {
						if !scope.isOtherMount(joinLogical(logicalPath, e.Name)) {
							noteMarker(e.Name)
						}
					}
				}
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
				if e.Err != nil {
					if unsup := asUnsupportedErr(e.Err); unsup != nil {
						unsupported = unsup
						return node
					}
					if !isSkipEntryErr(e.Err) {
						partial = true
						node.partial = true
					}
					continue
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

				// Known directory from d_type or bulk listing: resolve directly from dir
				// without a prior stat so a mount appearing mid-walk is refused before touching it.
				if e.Kind == entryDir {
					if depth >= maxDepth {
						if !e.HasStat {
							// Confirm it is still a same-mount directory (not a newly mounted fs
							// or symlink) without reading its contents.
							subDir, oerr := dir.OpenDir(name, childLogical, true, true)
							if oerr != nil {
								if unsup := asUnsupportedErr(oerr); unsup != nil {
									unsupported = unsup
									return node
								}
								if !isSkipDirErr(oerr) {
									partial = true
									node.partial = true
								}
								continue
							}
							_ = subDir.Close()
						}
						partial = true
						node.partial = true
						continue
					}
					subDir, oerr := dir.OpenDir(name, childLogical, false, true)
					if oerr != nil {
						if unsup := asUnsupportedErr(oerr); unsup != nil {
							unsupported = unsup
							return node
						}
						if !isSkipDirErr(oerr) {
							partial = true
							node.partial = true
						}
						continue
					}
					sub := visit(subDir, childLogical, depth+1)
					_ = subDir.Close()
					if unsupported != nil {
						return node
					}
					node.children = append(node.children, sub)
					node.totalBytes += sub.totalBytes
					if sub.partial {
						node.partial = true
					}
					if entries > maxEntries || ctx.Err() != nil {
						partial = true
						node.partial = true
						return node
					}
					continue
				}

				// Regular file or DT_UNKNOWN: use inline stat when already provided by a
				// bulk directory API, otherwise stat relative to dir without crossing mounts.
				var st entryStat
				if e.HasStat {
					st = e.Stat
				} else {
					var serr error
					st, serr = dir.StatEntry(name, childLogical)
					if serr != nil {
						if unsup := asUnsupportedErr(serr); unsup != nil {
							unsupported = unsup
							return node
						}
						if !isSkipEntryErr(serr) {
							partial = true
							node.partial = true
						}
						continue
					}
				}
				if st.Mode&fs.ModeSymlink != 0 {
					continue
				}
				if !st.HasDev || st.Dev != rootDev {
					continue
				}
				if rootMntID != 0 && (!st.HasMntID || st.MntID != rootMntID) {
					continue
				}

				if st.Mode.IsDir() {
					noteMarker(name)
					if depth >= maxDepth {
						partial = true
						node.partial = true
						continue
					}
					subDir, oerr := dir.OpenDir(name, childLogical, false, true)
					if oerr != nil {
						if unsup := asUnsupportedErr(oerr); unsup != nil {
							unsupported = unsup
							return node
						}
						if !isSkipDirErr(oerr) {
							partial = true
							node.partial = true
						}
						continue
					}
					sub := visit(subDir, childLogical, depth+1)
					_ = subDir.Close()
					if unsupported != nil {
						return node
					}
					node.children = append(node.children, sub)
					node.totalBytes += sub.totalBytes
					if sub.partial {
						node.partial = true
					}
					if entries > maxEntries || ctx.Err() != nil {
						partial = true
						node.partial = true
						return node
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
			if err != nil {
				if errors.Is(err, io.EOF) {
					return node
				}
				if unsup := asUnsupportedErr(err); unsup != nil {
					unsupported = unsup
					return node
				}
				if !isSkipDirErr(err) {
					partial = true
					node.partial = true
				}
				return node
			}
			if len(ents) == 0 {
				return node
			}
		}
	}

	root := visit(startDir, mount, 0)
	if unsupported != nil {
		return walkResult{unsupported: unsupported}
	}
	folders := pickLargestFolders(root, maxDepth, MaxFolders)
	return walkResult{folders: folders, partial: partial, dockerRoots: dockerRoots, podmanRoots: podmanRoots}
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
func (r *Runner) walkDirBytes(ctx context.Context, rootDir scanDir, scope mountScope, logicalDir string, rootDev, rootMntID uint64, maxDepth int, seen map[inodeKey]struct{}) (bytes uint64, partial bool, unsupported *scanUnsupportedError) {
	cleanDir := filepath.Clean(logicalDir)
	startDir, err := openRelDir(rootDir, scope, cleanDir, false)
	if err != nil {
		if unsup := asUnsupportedErr(err); unsup != nil {
			return 0, false, unsup
		}
		if !isSkipDirErr(err) {
			return 0, true, nil
		}
		return 0, false, nil
	}
	defer startDir.Close()

	entries := 0
	capEntries := r.catMaxEntries
	if capEntries <= 0 {
		capEntries = 100_000
	}
	var walk func(dir scanDir, p string, depth int)
	walk = func(dir scanDir, p string, depth int) {
		for {
			if unsupported != nil {
				return
			}
			if ctx.Err() != nil {
				partial = true
				return
			}
			rem := capEntries - entries
			if rem < 0 {
				partial = true
				return
			}
			batchCap := min(dirBatchSize, rem+1)
			ents, err := dir.ReadDirBatch(batchCap)
			for _, e := range ents {
				entries++
				if entries > capEntries || (entries&255 == 0 && ctx.Err() != nil) {
					partial = true
					return
				}
				if e.Err != nil {
					if unsup := asUnsupportedErr(e.Err); unsup != nil {
						unsupported = unsup
						return
					}
					if !isSkipEntryErr(e.Err) {
						partial = true
					}
					continue
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
						if !e.HasStat {
							subDir, oerr := dir.OpenDir(name, child, true, true)
							if oerr != nil {
								if unsup := asUnsupportedErr(oerr); unsup != nil {
									unsupported = unsup
									return
								}
								if !isSkipDirErr(oerr) {
									partial = true
								}
								continue
							}
							_ = subDir.Close()
						}
						partial = true
						continue
					}
					subDir, oerr := dir.OpenDir(name, child, false, true)
					if oerr != nil {
						if unsup := asUnsupportedErr(oerr); unsup != nil {
							unsupported = unsup
							return
						}
						if !isSkipDirErr(oerr) {
							partial = true
						}
						continue
					}
					walk(subDir, child, depth+1)
					_ = subDir.Close()
					if unsupported != nil {
						return
					}
					if entries > capEntries || ctx.Err() != nil {
						partial = true
						return
					}
					continue
				}

				var st entryStat
				if e.HasStat {
					st = e.Stat
				} else {
					var serr error
					st, serr = dir.StatEntry(name, child)
					if serr != nil {
						if unsup := asUnsupportedErr(serr); unsup != nil {
							unsupported = unsup
							return
						}
						if !isSkipEntryErr(serr) {
							partial = true
						}
						continue
					}
				}
				if st.Mode&fs.ModeSymlink != 0 {
					continue
				}
				if !st.HasDev || st.Dev != rootDev {
					continue
				}
				if rootMntID != 0 && (!st.HasMntID || st.MntID != rootMntID) {
					continue
				}
				if st.Mode.IsDir() {
					if depth >= maxDepth {
						partial = true
						continue
					}
					subDir, oerr := dir.OpenDir(name, child, false, true)
					if oerr != nil {
						if unsup := asUnsupportedErr(oerr); unsup != nil {
							unsupported = unsup
							return
						}
						if !isSkipDirErr(oerr) {
							partial = true
						}
						continue
					}
					walk(subDir, child, depth+1)
					_ = subDir.Close()
					if unsupported != nil {
						return
					}
					if entries > capEntries || ctx.Err() != nil {
						partial = true
						return
					}
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
			if err != nil {
				if errors.Is(err, io.EOF) {
					return
				}
				if unsup := asUnsupportedErr(err); unsup != nil {
					unsupported = unsup
					return
				}
				if !isSkipDirErr(err) {
					partial = true
				}
				return
			}
			if len(ents) == 0 {
				return
			}
		}
	}
	walk(startDir, cleanDir, 0)
	if unsupported != nil {
		return 0, false, unsupported
	}
	return bytes, partial, nil
}

func joinLogical(base, name string) string {
	if base == "/" {
		return "/" + name
	}
	return base + "/" + name
}
