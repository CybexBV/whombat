//go:build darwin

package diskusage

import (
	"errors"
	"io"
	"io/fs"
	"sync"
	"unsafe"

	"github.com/ebitengine/purego"
	"golang.org/x/sys/unix"
)

// macOS descriptor-anchored filesystem walker using getattrlistbulk(2) and
// fgetattrlist(2) via libSystem.B.dylib (cgo-free through purego).
//
// XNU source evidence (apple-oss-distributions/xnu):
//   - getattrlistbulk(2) (bsd/vfs/vfs_attrlist.c: readdirattr passes
//     NOCROSSMOUNT to namei; attr_pack_dir checks vnode_mountedhere(vp) and
//     vp->v_resolve; native VNOP_GETATTRLISTBULK reads only the parent volume)
//     reads directory entries and regular-file metadata strictly from the
//     underlying parent filesystem without crossing mount points, triggering
//     automounts, or following APFS firmlinks.
//   - Mount points carry DIR_MNTSTATUS_MNTPOINT, automount triggers carry
//     DIR_MNTSTATUS_TRIGGER (in ATTR_DIR_MOUNTSTATUS), and APFS firmlinks carry
//     SF_FIRMLINK (in ATTR_CMN_FLAGS). All three are skipped BEFORE openat.
//   - Regular-file sizes, allocated blocks, file IDs, link counts and volume
//     IDs arrive inline in getattrlistbulk, so fstatat(2) is never called.
//   - Root identity is verified via fgetattrlist(ATTR_CMN_FSID) — which reads
//     vp->v_mount->mnt_vfsstat.f_fsid from kernel memory without VFS_STATFS —
//     against the f_fsid captured by getfsstat(MNT_NOWAIT) during standby check.
//   - XNU exposes no user-space NOCROSSMOUNT flag on openat(2) (VNODE_LOOKUP_
//     NOCROSSMOUNT is kernel-KPI-only) and restricts openbyid_np(2) to Apple's
//     com.apple.private.vfs.open-by-id entitlement. A mount created in the
//     narrow window between getattrlistbulk seeing a plain directory and openat
//     opening it can still receive openat, and is immediately caught by
//     fgetattrlist(ATTR_CMN_FSID) + fstat(st_dev) before any entries are read.

var darwinLib struct {
	once            sync.Once
	err             error
	getattrlistbulk uintptr
	fgetattrlist    uintptr
}

func loadDarwinAttrSyms() error {
	darwinLib.once.Do(func() {
		h, err := purego.Dlopen("/usr/lib/libSystem.B.dylib", purego.RTLD_LAZY|purego.RTLD_GLOBAL)
		if err != nil {
			darwinLib.err = err
			return
		}
		bulk, err := purego.Dlsym(h, "getattrlistbulk")
		if err != nil {
			darwinLib.err = err
			return
		}
		fget, err := purego.Dlsym(h, "fgetattrlist")
		if err != nil {
			darwinLib.err = err
			return
		}
		darwinLib.getattrlistbulk = bulk
		darwinLib.fgetattrlist = fget
	})
	return darwinLib.err
}

type darwinBulkFunc func(dirfd int, alist *darwinAttrList, buf []byte, options uint64) (int, error)
type darwinFgetFunc func(fd int, alist *darwinAttrList, buf []byte, options uint64) error
type darwinSyscallNFunc func(fn uintptr, args ...uintptr) (r1, r2, err uintptr)

func hostDarwinGetattrlistbulk(dirfd int, alist *darwinAttrList, buf []byte, options uint64) (int, error) {
	return callDarwinGetattrlistbulk(purego.SyscallN, darwinLib.getattrlistbulk, dirfd, alist, buf, options)
}

func callDarwinGetattrlistbulk(syscallN darwinSyscallNFunc, fn uintptr, dirfd int, alist *darwinAttrList, buf []byte, options uint64) (int, error) {
	if len(buf) == 0 {
		return 0, unix.ERANGE
	}
	for {
		r1, _, errno := syscallN(
			fn,
			uintptr(dirfd),
			uintptr(unsafe.Pointer(alist)),
			uintptr(unsafe.Pointer(&buf[0])),
			uintptr(len(buf)),
			uintptr(options),
		)
		n := int(int32(r1))
		if n < 0 {
			err := darwinPuregoErrno(errno)
			if errors.Is(err, unix.EINTR) {
				continue
			}
			return 0, err
		}
		return n, nil
	}
}

func hostDarwinFgetattrlist(fd int, alist *darwinAttrList, buf []byte, options uint64) error {
	return callDarwinFgetattrlist(purego.SyscallN, darwinLib.fgetattrlist, fd, alist, buf, options)
}

func callDarwinFgetattrlist(syscallN darwinSyscallNFunc, fn uintptr, fd int, alist *darwinAttrList, buf []byte, options uint64) error {
	if len(buf) == 0 {
		return unix.ERANGE
	}
	for {
		r1, _, errno := syscallN(
			fn,
			uintptr(fd),
			uintptr(unsafe.Pointer(alist)),
			uintptr(unsafe.Pointer(&buf[0])),
			uintptr(len(buf)),
			uintptr(options),
		)
		if int32(r1) != 0 {
			err := darwinPuregoErrno(errno)
			if errors.Is(err, unix.EINTR) {
				continue
			}
			return err
		}
		return nil
	}
}

type darwinScanFS struct {
	r      *Runner
	bulkFn darwinBulkFunc
	fgetFn darwinFgetFunc
}

func newDefaultScanFS(r *Runner) scanFS {
	return &darwinScanFS{r: r}
}

type darwinFSState struct {
	bulkFn       darwinBulkFunc
	fgetFn       darwinFgetFunc
	rootDev      uint64
	rootFSID     [2]int32
	hasRootFSID  bool
	rootMntID    uint64
	hasRootMntID bool
	readDirHook  func(logicalPath string) ([]fs.DirEntry, error)
	statMountID  func(logicalPath string) (uint64, bool)
}

func (s *darwinFSState) fdIdentity(fd int) (dev uint64, hasDev bool, fsid [2]int32, hasFSID bool, err error) {
	alist := darwinIdentityAttrList()
	var buf [64]byte
	if err := s.fgetFn(fd, &alist, buf[:], 0); err != nil {
		return 0, false, [2]int32{}, false, err
	}
	return parseDarwinIdentityAttr(buf[:])
}

func (s *darwinFSState) verifyDirFD(fd int, logicalPath string) error {
	var st unix.Stat_t
	if err := fstatNoEINTR(fd, &st); err != nil {
		return err
	}
	if uint32(st.Mode)&unix.S_IFMT != unix.S_IFDIR {
		return errNotDir
	}
	if uint64(st.Dev) != s.rootDev {
		return errWrongMount
	}
	if s.hasRootFSID {
		_, _, fsid, hasFSID, err := s.fdIdentity(fd)
		if err != nil || !hasFSID || fsid != s.rootFSID {
			return errWrongMount
		}
	}
	if s.hasRootMntID && s.rootMntID != 0 && s.statMountID != nil {
		if mntID, ok := s.statMountID(logicalPath); !ok || mntID != s.rootMntID {
			return errWrongMount
		}
	}
	return nil
}

func (f *darwinScanFS) OpenRoot(hostPath, logicalMount string, expected mountInfo) (scanDir, error) {
	bulkFn := f.bulkFn
	fgetFn := f.fgetFn
	if bulkFn == nil || fgetFn == nil {
		if err := loadDarwinAttrSyms(); err != nil {
			return nil, &scanUnsupportedError{msg: "This Mac could not load its filesystem attribute APIs for a safe scan."}
		}
		if bulkFn == nil {
			bulkFn = hostDarwinGetattrlistbulk
		}
		if fgetFn == nil {
			fgetFn = hostDarwinFgetattrlist
		}
	}

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

	state := &darwinFSState{
		bulkFn:      bulkFn,
		fgetFn:      fgetFn,
		rootDev:     uint64(st.Dev),
		readDirHook: f.r.readDir,
		statMountID: f.r.statMountID,
	}

	_, _, fsid, hasFSID, ferr := state.fdIdentity(fd)
	if ferr == nil && hasFSID {
		state.rootFSID = fsid
		state.hasRootFSID = true
	}
	if expected.HasFSID {
		if !state.hasRootFSID || state.rootFSID != expected.FSID {
			_ = unix.Close(fd)
			return nil, errRootChanged
		}
	}
	if state.statMountID != nil {
		state.rootMntID, state.hasRootMntID = state.statMountID(logicalMount)
	}
	return &darwinScanDir{fd: fd, logicalPath: logicalMount, state: state}, nil
}

type darwinScanDir struct {
	fd          int
	logicalPath string
	state       *darwinFSState

	bulkBuf []byte
	pending []dirEntryInfo
	bulkEOF bool

	hookEnts   []fs.DirEntry
	hookLoaded bool
	hookOff    int
}

func (d *darwinScanDir) Stat() (entryStat, error) {
	var st unix.Stat_t
	if err := fstatNoEINTR(d.fd, &st); err != nil {
		return entryStat{}, err
	}
	es := entryStatFromUnix(&st)
	if _, _, fsid, hasFSID, err := d.state.fdIdentity(d.fd); err == nil && hasFSID {
		es.FSID = fsid
		es.HasFSID = true
	}
	if d.state.statMountID != nil {
		es.MntID, es.HasMntID = d.state.statMountID(d.logicalPath)
	}
	return es, nil
}

func (d *darwinScanDir) Statfs() (fsStat, error) {
	return fdStatfs(d.fd)
}

func (d *darwinScanDir) OpenSelf() (scanDir, error) {
	fd, err := openatNoEINTR(d.fd, ".", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC|unix.O_NONBLOCK)
	if err != nil {
		return nil, err
	}
	if err := d.state.verifyDirFD(fd, d.logicalPath); err != nil {
		_ = unix.Close(fd)
		return nil, err
	}
	return &darwinScanDir{fd: fd, logicalPath: d.logicalPath, state: d.state}, nil
}

func (d *darwinScanDir) ReadDirBatch(maxEntries int) ([]dirEntryInfo, error) {
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

	for {
		if len(d.pending) > 0 {
			n := min(limit, len(d.pending))
			out := make([]dirEntryInfo, n)
			copy(out, d.pending[:n])
			d.pending = d.pending[n:]
			if len(d.pending) == 0 {
				d.pending = nil
			}
			return out, nil
		}
		if d.bulkEOF {
			return nil, io.EOF
		}

		entries, eof, err := d.readBulkRaw()
		if err != nil {
			return nil, err
		}
		if eof {
			d.bulkEOF = true
			d.bulkBuf = nil
			return nil, io.EOF
		}
		for _, ent := range entries {
			if ent.skippedMnt {
				continue
			}
			if d.state.statMountID != nil && ent.info.HasStat {
				ent.info.Stat.MntID, ent.info.Stat.HasMntID = d.state.statMountID(joinLogical(d.logicalPath, ent.info.Name))
			}
			d.pending = append(d.pending, ent.info)
		}
	}
}

func (d *darwinScanDir) readBulkRaw() ([]darwinBulkEntry, bool, error) {
	if d.bulkBuf == nil {
		d.bulkBuf = make([]byte, 64*1024)
	}
	alist := darwinBulkAttrList()
	for {
		n, err := d.state.bulkFn(d.fd, &alist, d.bulkBuf, 0)
		if errors.Is(err, unix.ERANGE) && len(d.bulkBuf) < 256*1024 {
			d.bulkBuf = make([]byte, len(d.bulkBuf)*2)
			continue
		}
		if err != nil {
			return nil, false, err
		}
		if n == 0 {
			return nil, true, nil
		}
		parsed, perr := parseDarwinAttrlistBulk(d.bulkBuf, n, d.state.rootDev, d.state.hasRootFSID, d.state.rootFSID)
		if perr != nil {
			return nil, false, perr
		}
		return parsed, false, nil
	}
}

// lookupChildBulk scans a fresh handle of d via getattrlistbulk(2) to inspect
// direct child name purely from the parent filesystem (NOCROSSMOUNT in XNU)
// before openat or StatEntry can ever touch a mounted child filesystem.
func (d *darwinScanDir) lookupChildBulk(name string) (darwinBulkEntry, bool, error) {
	self, err := d.OpenSelf()
	if err != nil {
		return darwinBulkEntry{}, false, err
	}
	defer self.Close()
	sd := self.(*darwinScanDir)

	const maxProbeEntries = 50_000
	seen := 0
	for seen < maxProbeEntries {
		entries, eof, err := sd.readBulkRaw()
		if err != nil {
			return darwinBulkEntry{}, false, err
		}
		if eof {
			return darwinBulkEntry{}, false, nil
		}
		for _, ent := range entries {
			seen++
			if ent.info.Name == name {
				return ent, true, nil
			}
		}
	}
	return darwinBulkEntry{}, false, errors.New("parent directory too large to verify child before open")
}

func (d *darwinScanDir) OpenDir(name, logicalPath string, _, prechecked bool) (scanDir, error) {
	if !isSafeChildName(name) {
		return nil, errWrongMount
	}

	// When called directly (for example openRelDir jumping to a category path
	// without first listing the parent directory), check name via
	// getattrlistbulk(2) before calling openat so a mount point, automount
	// trigger, or APFS firmlink is skipped without touching it.
	if !prechecked {
		ent, found, err := d.lookupChildBulk(name)
		if err != nil {
			return nil, err
		}
		if !found {
			return nil, fs.ErrNotExist
		}
		if ent.skippedMnt {
			return nil, errWrongMount
		}
		if ent.info.Err != nil {
			return nil, ent.info.Err
		}
		if ent.info.Kind != entryDir {
			return nil, errNotDir
		}
	}

	fd, err := openatNoEINTR(d.fd, name, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC|unix.O_NONBLOCK)
	if err != nil {
		return nil, err
	}
	if err := d.state.verifyDirFD(fd, logicalPath); err != nil {
		_ = unix.Close(fd)
		return nil, err
	}
	return &darwinScanDir{fd: fd, logicalPath: logicalPath, state: d.state}, nil
}

func (d *darwinScanDir) StatEntry(name, logicalPath string) (entryStat, error) {
	if !isSafeChildName(name) {
		return entryStat{}, errWrongMount
	}
	ent, found, err := d.lookupChildBulk(name)
	if err != nil {
		return entryStat{}, err
	}
	if !found {
		return entryStat{}, fs.ErrNotExist
	}
	if ent.skippedMnt {
		return entryStat{}, errWrongMount
	}
	if ent.info.Err != nil {
		return entryStat{}, ent.info.Err
	}
	if ent.info.Kind == entrySymlink {
		return entryStat{Mode: fs.ModeSymlink | 0o777, Dev: d.state.rootDev, HasDev: true}, nil
	}
	if !ent.info.HasStat {
		return entryStat{}, errWrongMount
	}
	es := ent.info.Stat
	if d.state.statMountID != nil {
		es.MntID, es.HasMntID = d.state.statMountID(logicalPath)
		if d.state.hasRootMntID && d.state.rootMntID != 0 && (!es.HasMntID || es.MntID != d.state.rootMntID) {
			return entryStat{}, errWrongMount
		}
	}
	return es, nil
}

func (d *darwinScanDir) Close() error {
	d.bulkBuf = nil
	d.pending = nil
	d.hookEnts = nil
	if d.fd < 0 {
		return nil
	}
	fd := d.fd
	d.fd = -1
	return unix.Close(fd)
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
