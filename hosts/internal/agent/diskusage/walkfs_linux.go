//go:build linux

package diskusage

import (
	"encoding/binary"
	"errors"
	"io/fs"
	"sync/atomic"
	"unsafe"

	"golang.org/x/sys/unix"
)

const linuxOpenat2Resolve = unix.RESOLVE_NO_XDEV | unix.RESOLVE_NO_SYMLINKS | unix.RESOLVE_NO_MAGICLINKS

type openat2Func func(dirfd int, path string, how *unix.OpenHow) (int, error)

type linuxScanFS struct {
	r       *Runner
	openat2 openat2Func
}

func newDefaultScanFS(r *Runner) scanFS {
	return &linuxScanFS{r: r, openat2: unix.Openat2}
}

func newLinuxScanFSWithOpenat2(r *Runner, fn openat2Func) scanFS {
	if fn == nil {
		fn = unix.Openat2
	}
	return &linuxScanFS{r: r, openat2: fn}
}

type linuxFSState struct {
	openat2      openat2Func
	openat2Works atomic.Bool
	rootDev      uint64
	rootMntID    uint64
	hasRootMntID bool
	readDirHook  func(logicalPath string) ([]fs.DirEntry, error)
	statMountID  func(logicalPath string) (uint64, bool)
	isTestRoot   bool
}

func (s *linuxFSState) mountIDForFD(fd int, logicalPath string) (uint64, bool) {
	if s.statMountID != nil {
		return s.statMountID(logicalPath)
	}
	if s.isTestRoot {
		return 0, false
	}
	return fdStatMountID(fd)
}

func (s *linuxFSState) verifyChildDirFD(fd int, logicalPath string) error {
	var st unix.Stat_t
	if err := fstatNoEINTR(fd, &st); err != nil {
		return err
	}
	if st.Mode&unix.S_IFMT != unix.S_IFDIR {
		return errNotDir
	}
	if uint64(st.Dev) != s.rootDev {
		return errWrongMount
	}
	if s.hasRootMntID && s.rootMntID != 0 {
		mntID, ok := s.mountIDForFD(fd, logicalPath)
		if !ok || mntID != s.rootMntID {
			return errWrongMount
		}
	}
	return nil
}

func (f *linuxScanFS) OpenRoot(hostPath, logicalMount string) (scanDir, error) {
	fd, err := openNoEINTR(hostPath, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC|unix.O_NONBLOCK)
	if err != nil {
		return nil, err
	}
	var st unix.Stat_t
	if err := fstatNoEINTR(fd, &st); err != nil {
		_ = unix.Close(fd)
		return nil, err
	}
	if st.Mode&unix.S_IFMT != unix.S_IFDIR {
		_ = unix.Close(fd)
		return nil, errNotDir
	}

	state := &linuxFSState{
		openat2:     f.openat2,
		rootDev:     uint64(st.Dev),
		readDirHook: f.r.readDir,
		statMountID: f.r.statMountID,
		isTestRoot:  f.r.root != "",
	}
	state.rootMntID, state.hasRootMntID = state.mountIDForFD(fd, logicalMount)

	// Probe openat2 once on the open root descriptor itself so kernels before 5.6
	// (ENOSYS) or seccomp filters blocking openat2 (ENOSYS/EPERM) fall back once
	// instead of paying a failed syscall on every entry.
	probeFD, perr := openat2NoEINTR(state.openat2, fd, ".", &unix.OpenHow{
		Flags:   unix.O_PATH | unix.O_CLOEXEC,
		Resolve: linuxOpenat2Resolve,
	})
	if perr == nil {
		_ = unix.Close(probeFD)
		state.openat2Works.Store(true)
	} else {
		state.openat2Works.Store(false)
	}

	return &linuxScanDir{fd: fd, logicalPath: logicalMount, state: state}, nil
}

type linuxScanDir struct {
	fd          int
	logicalPath string
	state       *linuxFSState
}

func (d *linuxScanDir) Stat() (entryStat, error) {
	var st unix.Stat_t
	if err := fstatNoEINTR(d.fd, &st); err != nil {
		return entryStat{}, err
	}
	es := entryStatFromUnix(&st)
	es.MntID, es.HasMntID = d.state.mountIDForFD(d.fd, d.logicalPath)
	return es, nil
}

func (d *linuxScanDir) Statfs() (fsStat, error) {
	return fdStatfs(d.fd)
}

func (d *linuxScanDir) OpenSelf() (scanDir, error) {
	if d.state.openat2Works.Load() {
		fd, err := openat2NoEINTR(d.state.openat2, d.fd, ".", &unix.OpenHow{
			Flags:   unix.O_RDONLY | unix.O_DIRECTORY | unix.O_CLOEXEC | unix.O_NONBLOCK,
			Resolve: linuxOpenat2Resolve,
		})
		switch {
		case err == nil:
			if verr := d.state.verifyChildDirFD(fd, d.logicalPath); verr != nil {
				_ = unix.Close(fd)
				return nil, verr
			}
			return &linuxScanDir{fd: fd, logicalPath: d.logicalPath, state: d.state}, nil
		case errors.Is(err, unix.ENOSYS):
			d.state.openat2Works.Store(false)
		case errors.Is(err, unix.EXDEV):
			return nil, errWrongMount
		default:
			return nil, err
		}
	}

	fd, err := openatNoEINTR(d.fd, ".", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC|unix.O_NONBLOCK)
	if err != nil {
		return nil, err
	}
	if err := d.state.verifyChildDirFD(fd, d.logicalPath); err != nil {
		_ = unix.Close(fd)
		return nil, err
	}
	return &linuxScanDir{fd: fd, logicalPath: d.logicalPath, state: d.state}, nil
}

func (d *linuxScanDir) ReadDir() ([]dirEntryInfo, error) {
	if d.state.readDirHook != nil {
		raw, err := d.state.readDirHook(d.logicalPath)
		if err != nil {
			return nil, err
		}
		out := make([]dirEntryInfo, 0, len(raw))
		for _, e := range raw {
			out = append(out, dirEntryInfo{Name: e.Name(), Kind: dirEntryKind(e)})
		}
		return out, nil
	}
	return readLinuxDirents(d.fd)
}

func (d *linuxScanDir) OpenDir(name, logicalPath string, searchOnly bool) (scanDir, error) {
	if !isSafeChildName(name) {
		return nil, errWrongMount
	}

	if d.state.openat2Works.Load() {
		flags := uint64(unix.O_RDONLY | unix.O_DIRECTORY | unix.O_NOFOLLOW | unix.O_CLOEXEC | unix.O_NONBLOCK)
		if searchOnly {
			// O_PATH without O_NOFOLLOW lets RESOLVE_NO_SYMLINKS reject symlinks
			// with ELOOP while allowing search-only traversal of execute-only dirs.
			flags = uint64(unix.O_PATH | unix.O_DIRECTORY | unix.O_CLOEXEC)
		}
		fd, err := openat2NoEINTR(d.state.openat2, d.fd, name, &unix.OpenHow{
			Flags:   flags,
			Resolve: linuxOpenat2Resolve,
		})
		switch {
		case err == nil:
			if verr := d.state.verifyChildDirFD(fd, logicalPath); verr != nil {
				_ = unix.Close(fd)
				return nil, verr
			}
			return &linuxScanDir{fd: fd, logicalPath: logicalPath, state: d.state}, nil
		case errors.Is(err, unix.ENOSYS):
			d.state.openat2Works.Store(false)
		case errors.Is(err, unix.EXDEV):
			return nil, errWrongMount
		default:
			return nil, err
		}
	}

	// Fallback when openat2 is unavailable (kernels before 5.6 returning ENOSYS,
	// or seccomp filters refusing openat2): open the child directory relative to
	// its open parent descriptor with O_NOFOLLOW|O_DIRECTORY, then verify both
	// fstat's st_dev and the open descriptor's mount ID (statx STATX_MNT_ID or
	// /proc/self/fdinfo/<fd>) against the mount root BEFORE returning it or
	// calling getdents. Opening a newly mounted directory only binds the mount's
	// already-cached root inode in VFS and does not read directory blocks or
	// file data; any mismatch closes the descriptor immediately so the newly
	// mounted filesystem's data is never read.
	flags := unix.O_RDONLY | unix.O_DIRECTORY | unix.O_NOFOLLOW | unix.O_CLOEXEC | unix.O_NONBLOCK
	if searchOnly {
		flags = unix.O_PATH | unix.O_DIRECTORY | unix.O_NOFOLLOW | unix.O_CLOEXEC
	}
	fd, err := openatNoEINTR(d.fd, name, flags)
	if err != nil {
		return nil, err
	}
	if err := d.state.verifyChildDirFD(fd, logicalPath); err != nil {
		_ = unix.Close(fd)
		return nil, err
	}
	return &linuxScanDir{fd: fd, logicalPath: logicalPath, state: d.state}, nil
}

func (d *linuxScanDir) StatEntry(name, logicalPath string) (entryStat, error) {
	if !isSafeChildName(name) {
		return entryStat{}, errWrongMount
	}

	if d.state.openat2Works.Load() {
		// Pin the child entry with O_PATH and RESOLVE_NO_XDEV|NO_SYMLINKS|NO_MAGICLINKS
		// first, then stat that exact descriptor via fstatat(fd, "", AT_EMPTY_PATH).
		// If a filesystem (directory mount or file bind mount) was mounted at name
		// mid-walk, openat2 refuses with EXDEV in VFS before any getattr on the
		// mounted filesystem.
		entryFD, err := openat2NoEINTR(d.state.openat2, d.fd, name, &unix.OpenHow{
			Flags:   unix.O_PATH | unix.O_CLOEXEC,
			Resolve: linuxOpenat2Resolve,
		})
		switch {
		case err == nil:
			var st unix.Stat_t
			serr := fstatatNoEINTR(entryFD, "", &st, unix.AT_EMPTY_PATH)
			_ = unix.Close(entryFD)
			if serr != nil {
				return entryStat{}, serr
			}
			es := entryStatFromUnix(&st)
			if d.state.statMountID != nil {
				es.MntID, es.HasMntID = d.state.statMountID(logicalPath)
			} else if d.state.hasRootMntID {
				es.MntID, es.HasMntID = d.state.rootMntID, true
			}
			return es, nil
		case errors.Is(err, unix.ENOSYS):
			d.state.openat2Works.Store(false)
		case errors.Is(err, unix.EXDEV):
			return entryStat{}, errWrongMount
		default:
			return entryStat{}, err
		}
	}

	// Fallback when openat2 is unavailable: stat relative to the open parent
	// descriptor in one syscall without following symlinks or triggering
	// automounts (statx gets both basic stats and STATX_MNT_ID in one call;
	// kernels before 4.11 fall back to fstatat), then check st_dev and mount ID.
	es, err := statxOrFstatat(d.fd, name)
	if err != nil {
		return entryStat{}, err
	}
	if es.Mode&fs.ModeSymlink != 0 {
		return es, nil
	}
	if !es.HasDev || es.Dev != d.state.rootDev {
		return entryStat{}, errWrongMount
	}
	if d.state.hasRootMntID && d.state.rootMntID != 0 {
		if d.state.statMountID != nil {
			es.MntID, es.HasMntID = d.state.statMountID(logicalPath)
		}
		if es.HasMntID && es.MntID != d.state.rootMntID {
			return entryStat{}, errWrongMount
		}
	}
	return es, nil
}

func (d *linuxScanDir) Close() error {
	if d.fd < 0 {
		return nil
	}
	fd := d.fd
	d.fd = -1
	return unix.Close(fd)
}

// readLinuxDirents reads directory entries directly via getdents64 so
// DT_UNKNOWN entries (XFS without ftype=1, FUSE) are returned as entryUnknown
// without Go's os.File.ReadDir calling lstatat on them before mount checks run.
func readLinuxDirents(fd int) ([]dirEntryInfo, error) {
	const (
		reclenOff = int(unsafe.Offsetof(unix.Dirent{}.Reclen))
		typeOff   = int(unsafe.Offsetof(unix.Dirent{}.Type))
		nameOff   = int(unsafe.Offsetof(unix.Dirent{}.Name))
	)
	buf := make([]byte, 32*1024)
	var out []dirEntryInfo
	for {
		n, err := unix.Getdents(fd, buf)
		if errors.Is(err, unix.EINTR) {
			continue
		}
		if err != nil {
			return nil, err
		}
		if n == 0 {
			return out, nil
		}
		b := buf[:n]
		for len(b) >= nameOff {
			reclen := int(binary.NativeEndian.Uint16(b[reclenOff : reclenOff+2]))
			if reclen < nameOff || reclen > len(b) {
				break
			}
			rec := b[:reclen]
			b = b[reclen:]

			rawName := rec[nameOff:]
			for i, c := range rawName {
				if c == 0 {
					rawName = rawName[:i]
					break
				}
			}
			if len(rawName) == 0 {
				continue
			}
			name := string(rawName)
			if name == "." || name == ".." {
				continue
			}
			var kind entryKind
			switch rec[typeOff] {
			case unix.DT_DIR:
				kind = entryDir
			case unix.DT_REG:
				kind = entryRegular
			case unix.DT_LNK:
				kind = entrySymlink
			case unix.DT_UNKNOWN:
				kind = entryUnknown
			default:
				kind = entryOther
			}
			out = append(out, dirEntryInfo{Name: name, Kind: kind})
		}
	}
}

func openat2NoEINTR(fn openat2Func, dirfd int, path string, how *unix.OpenHow) (int, error) {
	for {
		fd, err := fn(dirfd, path, how)
		if errors.Is(err, unix.EINTR) {
			continue
		}
		return fd, err
	}
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
