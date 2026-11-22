package diskusage

import (
	"errors"
	"io/fs"
	"path/filepath"
	"strings"
)

var (
	errWrongMount = errors.New("path is outside target mount")
	errNotDir     = errors.New("not a directory")
)

// entryKind is the coarse entry type reported by directory iteration (d_type on
// Linux) before any per-entry stat. entryUnknown means the filesystem did not
// report d_type (for example XFS without ftype=1, FUSE, or macOS Readdirnames)
// and the entry must be inspected safely relative to its open parent directory.
type entryKind uint8

const (
	entryUnknown entryKind = iota
	entryDir
	entryRegular
	entrySymlink
	entryOther
)

// dirBatchSize caps how many directory entries one ReadDirBatch call delivers
// so the entry cap and cancellation run between bounded batches instead of
// loading huge directories into memory at once.
const dirBatchSize = 512

// dirEntryInfo is one entry returned by reading an open directory descriptor.
type dirEntryInfo struct {
	Name    string
	Kind    entryKind
	Stat    entryStat
	HasStat bool
	Err     error
}

// entryStat holds the stat metadata needed by the walker and category probes.
type entryStat struct {
	Mode       fs.FileMode
	Size       int64
	AllocBytes uint64
	Dev        uint64
	HasDev     bool
	Ino        uint64
	Nlink      uint64
	HasInode   bool
	MntID      uint64
	HasMntID   bool
	FSID       [2]int32
	HasFSID    bool
}

// scanDir is an open handle to a verified directory on the target mount.
// Every child lookup resolves strictly relative to this open descriptor so path
// strings are never re-resolved and a mount appearing mid-walk cannot be crossed.
type scanDir interface {
	// Stat returns metadata for this open directory descriptor itself.
	Stat() (entryStat, error)

	// Statfs returns filesystem capacity and used bytes for this open descriptor.
	Statfs() (fsStat, error)

	// OpenSelf returns a fresh directory handle for this exact open directory
	// (at directory offset 0) without re-resolving any path string.
	OpenSelf() (scanDir, error)

	// ReadDirBatch reads up to maxEntries entries from this open directory
	// descriptor without calling lstat on DT_UNKNOWN entries before
	// mount-boundary checks run. It returns (nil, io.EOF) when all entries have
	// been read.
	ReadDirBatch(maxEntries int) ([]dirEntryInfo, error)

	// OpenDir opens direct child directory name relative to this open directory
	// descriptor without crossing mounts or following symlinks. When searchOnly
	// is true, the handle is only used for traversing deeper or verifying the
	// directory stays on the target mount (not reading entries). When prechecked
	// is true, the caller just received name from ReadDirBatch on this descriptor.
	OpenDir(name, logicalPath string, searchOnly, prechecked bool) (scanDir, error)

	// StatEntry returns stat metadata for direct child name relative to this
	// open directory descriptor without crossing mounts or following symlinks.
	StatEntry(name, logicalPath string) (entryStat, error)

	// Close releases the underlying directory descriptor.
	Close() error
}

func clampBatchSize(maxEntries int) int {
	if maxEntries <= 0 || maxEntries > dirBatchSize {
		return dirBatchSize
	}
	return maxEntries
}

// scanFS anchors a disk usage scan to an open directory descriptor of the
// target mount root.
type scanFS interface {
	OpenRoot(hostPath, logicalMount string) (scanDir, error)
}

func isSafeChildName(name string) bool {
	return name != "" && name != "." && name != ".." && !strings.ContainsRune(name, '/')
}

func dirEntryKind(e fs.DirEntry) entryKind {
	typ := e.Type()
	if typ&fs.ModeSymlink != 0 {
		return entrySymlink
	}
	if typ.IsDir() {
		return entryDir
	}
	// In Go's io/fs, both regular files and DT_UNKNOWN wrappers have Type() == 0.
	// Returning entryUnknown guarantees the caller inspects it safely via
	// StatEntry/OpenDir without missing directories on filesystems without d_type.
	if typ == 0 {
		return entryUnknown
	}
	return entryOther
}

func isSkipDirErr(err error) bool {
	return errors.Is(err, errWrongMount) || isSymlinkLoopErr(err) || isNotDirErr(err) || errors.Is(err, fs.ErrNotExist)
}

func isSkipEntryErr(err error) bool {
	return errors.Is(err, errWrongMount) || isSymlinkLoopErr(err) || errors.Is(err, fs.ErrNotExist)
}

// openRelDir resolves logicalDir one segment at a time starting from the open
// mount root descriptor rootDir, verifying each segment against mountScope
// before opening it and refusing mount crossings and symlinks at every step.
func openRelDir(rootDir scanDir, scope mountScope, logicalDir string, searchOnly bool) (scanDir, error) {
	cleanDir := filepath.Clean(logicalDir)
	if !scope.containsPath(cleanDir) {
		return nil, errWrongMount
	}
	target := scope.target.MountPoint
	if cleanDir == target {
		return rootDir.OpenSelf()
	}

	rel := strings.TrimPrefix(cleanDir, target)
	rel = strings.TrimPrefix(rel, "/")
	if rel == "" {
		return rootDir.OpenSelf()
	}
	rawSegs := strings.Split(rel, "/")
	segs := make([]string, 0, len(rawSegs))
	for _, seg := range rawSegs {
		if seg == "" {
			continue
		}
		if !isSafeChildName(seg) {
			return nil, errWrongMount
		}
		segs = append(segs, seg)
	}
	if len(segs) == 0 {
		return rootDir.OpenSelf()
	}

	cur := rootDir
	curLogical := target
	for i, seg := range segs {
		curLogical = joinLogical(curLogical, seg)
		if scope.isOtherMount(curLogical) {
			if cur != rootDir {
				_ = cur.Close()
			}
			return nil, errWrongMount
		}
		stepSearchOnly := searchOnly || i < len(segs)-1
		next, err := cur.OpenDir(seg, curLogical, stepSearchOnly, false)
		if cur != rootDir {
			_ = cur.Close()
		}
		if err != nil {
			return nil, err
		}
		cur = next
	}
	return cur, nil
}

// dirInScope checks whether logicalDir is a directory on the target mount by
// stepping from rootDir without crossing mounts or following symlinks.
func dirInScope(rootDir scanDir, scope mountScope, logicalDir string) bool {
	cleanDir := filepath.Clean(logicalDir)
	if !scope.containsPath(cleanDir) {
		return false
	}
	if cleanDir == scope.target.MountPoint {
		return true
	}
	d, err := openRelDir(rootDir, scope, cleanDir, true)
	if err != nil {
		return false
	}
	_ = d.Close()
	return true
}
