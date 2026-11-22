//go:build unix && !linux

package diskusage

import (
	"errors"
	"io"
	"io/fs"
	"os"
	"runtime"

	"golang.org/x/sys/unix"
)

// macOS (and other non-Linux Unix systems) lack openat2(RESOLVE_NO_XDEV) and
// per-descriptor mount ID syscalls. We anchor every scan to an open directory
// descriptor of the mount root and resolve every child relative to its open
// parent descriptor:
//   - ReadDir uses Readdirnames on the open descriptor so Go's os.File.ReadDir
//     never calls lstatat on DT_UNKNOWN entries before mount-table checks run.
//   - OpenDir opens child directories with openat(O_RDONLY|O_DIRECTORY|O_NOFOLLOW)
//     and checks fstat's st_dev against the mount root BEFORE returning or
//     reading any directory entries; on macOS each mounted volume has a distinct
//     st_dev, so a volume mounted mid-walk is closed without reading its data.
//   - StatEntry uses fstatat(AT_SYMLINK_NOFOLLOW) relative to the open parent
//     descriptor and checks st_dev against the mount root.
type unixScanFS struct {
	r *Runner
}

func newDefaultScanFS(r *Runner) scanFS {
	return &unixScanFS{r: r}
}

type unixFSState struct {
	rootDev      uint64
	rootMntID    uint64
	hasRootMntID bool
	readDirHook  func(logicalPath string) ([]fs.DirEntry, error)
	statMountID  func(logicalPath string) (uint64, bool)
}

func (f *unixScanFS) OpenRoot(hostPath, logicalMount string) (scanDir, error) {
	fd, err := openNoEINTR(hostPath, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC|unix.O_NONBLOCK)
	if err != nil {
		return nil, err
	}
	var st unix.Stat_t
	if err := fstatNoEINTR(fd, &st); err != nil {
		_ = unix.Close(fd)
		return nil, err
	}
	if uint32(st.Mode)&unix.S_IFMT != unix.S_IFDIR {
		_ = unix.Close(fd)
		return nil, errNotDir
	}
	state := &unixFSState{
		rootDev:     uint64(st.Dev),
		readDirHook: f.r.readDir,
		statMountID: f.r.statMountID,
	}
	if state.statMountID != nil {
		state.rootMntID, state.hasRootMntID = state.statMountID(logicalMount)
	}
	return &unixScanDir{
		f:           os.NewFile(uintptr(fd), hostPath),
		logicalPath: logicalMount,
		state:       state,
	}, nil
}

type unixScanDir struct {
	f           *os.File
	logicalPath string
	state       *unixFSState

	hookEnts   []fs.DirEntry
	hookLoaded bool
	hookOff    int
}

func (d *unixScanDir) Stat() (entryStat, error) {
	var st unix.Stat_t
	err := fstatNoEINTR(int(d.f.Fd()), &st)
	runtime.KeepAlive(d.f)
	if err != nil {
		return entryStat{}, err
	}
	es := entryStatFromUnix(&st)
	if d.state.statMountID != nil {
		es.MntID, es.HasMntID = d.state.statMountID(d.logicalPath)
	}
	return es, nil
}

func (d *unixScanDir) Statfs() (fsStat, error) {
	st, err := fdStatfs(int(d.f.Fd()))
	runtime.KeepAlive(d.f)
	return st, err
}

func (d *unixScanDir) OpenSelf() (scanDir, error) {
	fd, err := openatNoEINTR(int(d.f.Fd()), ".", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC|unix.O_NONBLOCK)
	runtime.KeepAlive(d.f)
	if err != nil {
		return nil, err
	}
	var st unix.Stat_t
	if err := fstatNoEINTR(fd, &st); err != nil {
		_ = unix.Close(fd)
		return nil, err
	}
	if uint32(st.Mode)&unix.S_IFMT != unix.S_IFDIR {
		_ = unix.Close(fd)
		return nil, errNotDir
	}
	if uint64(st.Dev) != d.state.rootDev {
		_ = unix.Close(fd)
		return nil, errWrongMount
	}
	return &unixScanDir{
		f:           os.NewFile(uintptr(fd), d.logicalPath),
		logicalPath: d.logicalPath,
		state:       d.state,
	}, nil
}

func (d *unixScanDir) ReadDirBatch(maxEntries int) ([]dirEntryInfo, error) {
	limit := clampBatchSize(maxEntries)
	if d.state.readDirHook != nil {
		if !d.hookLoaded {
			raw, err := d.state.readDirHook(d.logicalPath)
			if err != nil {
				return nil, err
			}
			d.hookEnts = raw
			d.hookLoaded = true
		}
		if d.hookOff >= len(d.hookEnts) {
			return nil, io.EOF
		}
		end := min(d.hookOff+limit, len(d.hookEnts))
		out := make([]dirEntryInfo, 0, end-d.hookOff)
		for _, e := range d.hookEnts[d.hookOff:end] {
			out = append(out, dirEntryInfo{Name: e.Name(), Kind: dirEntryKind(e)})
		}
		d.hookOff = end
		return out, nil
	}
	names, err := d.f.Readdirnames(limit)
	if len(names) == 0 {
		return nil, err
	}
	out := make([]dirEntryInfo, 0, len(names))
	for _, name := range names {
		out = append(out, dirEntryInfo{Name: name, Kind: entryUnknown})
	}
	if errors.Is(err, io.EOF) {
		return out, nil
	}
	return out, err
}

func (d *unixScanDir) OpenDir(name, logicalPath string, _, _ bool) (scanDir, error) {
	if !isSafeChildName(name) {
		return nil, errWrongMount
	}
	fd, err := openatNoEINTR(int(d.f.Fd()), name, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC|unix.O_NONBLOCK)
	runtime.KeepAlive(d.f)
	if err != nil {
		return nil, err
	}
	var st unix.Stat_t
	if err := fstatNoEINTR(fd, &st); err != nil {
		_ = unix.Close(fd)
		return nil, err
	}
	if uint32(st.Mode)&unix.S_IFMT != unix.S_IFDIR {
		_ = unix.Close(fd)
		return nil, errNotDir
	}
	if uint64(st.Dev) != d.state.rootDev {
		_ = unix.Close(fd)
		return nil, errWrongMount
	}
	if d.state.hasRootMntID && d.state.rootMntID != 0 && d.state.statMountID != nil {
		if mntID, ok := d.state.statMountID(logicalPath); ok && mntID != d.state.rootMntID {
			_ = unix.Close(fd)
			return nil, errWrongMount
		}
	}
	return &unixScanDir{
		f:           os.NewFile(uintptr(fd), logicalPath),
		logicalPath: logicalPath,
		state:       d.state,
	}, nil
}

func (d *unixScanDir) StatEntry(name, logicalPath string) (entryStat, error) {
	if !isSafeChildName(name) {
		return entryStat{}, errWrongMount
	}
	var st unix.Stat_t
	err := fstatatNoEINTR(int(d.f.Fd()), name, &st, unix.AT_SYMLINK_NOFOLLOW)
	runtime.KeepAlive(d.f)
	if err != nil {
		return entryStat{}, err
	}
	es := entryStatFromUnix(&st)
	if es.Mode&fs.ModeSymlink != 0 {
		return es, nil
	}
	if !es.HasDev || es.Dev != d.state.rootDev {
		return entryStat{}, errWrongMount
	}
	if d.state.statMountID != nil {
		es.MntID, es.HasMntID = d.state.statMountID(logicalPath)
		if d.state.hasRootMntID && d.state.rootMntID != 0 && es.HasMntID && es.MntID != d.state.rootMntID {
			return entryStat{}, errWrongMount
		}
	}
	return es, nil
}

func (d *unixScanDir) Close() error {
	if d.f == nil {
		return nil
	}
	f := d.f
	d.f = nil
	return f.Close()
}

func openNoEINTR(path string, flags int) (int, error) {
	for {
		fd, err := unix.Open(path, flags, 0)
		if errors.Is(err, unix.EINTR) {
			continue
		}
		return fd, err
	}
}

func openatNoEINTR(dirfd int, path string, flags int) (int, error) {
	for {
		fd, err := unix.Openat(dirfd, path, flags, 0)
		if errors.Is(err, unix.EINTR) {
			continue
		}
		return fd, err
	}
}

func fstatNoEINTR(fd int, st *unix.Stat_t) error {
	for {
		err := unix.Fstat(fd, st)
		if errors.Is(err, unix.EINTR) {
			continue
		}
		return err
	}
}

func fstatatNoEINTR(dirfd int, path string, st *unix.Stat_t, flags int) error {
	for {
		err := unix.Fstatat(dirfd, path, st, flags)
		if errors.Is(err, unix.EINTR) {
			continue
		}
		return err
	}
}
