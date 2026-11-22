//go:build linux

package diskusage

import (
	"encoding/binary"
	"errors"
	"io"
	"io/fs"
	"unsafe"

	"golang.org/x/sys/unix"
)

const (
	// linuxResolveCached is Linux 5.12+'s RESOLVE_CACHED (include/uapi/linux/openat2.h),
	// defined here because our pinned golang.org/x/sys/unix does not export it yet.
	linuxResolveCached      = 0x20
	linuxOpenat2Resolve     = unix.RESOLVE_NO_XDEV | unix.RESOLVE_NO_SYMLINKS | unix.RESOLVE_NO_MAGICLINKS
	linuxRootOpenat2Resolve = linuxResolveCached | unix.RESOLVE_NO_SYMLINKS | unix.RESOLVE_NO_MAGICLINKS

	// rootCachedAttempts bounds retries on EAGAIN from openat2(RESOLVE_CACHED)
	// so a transient concurrent rename_lock/mount_lock seqcount bump in RCU-walk
	// can retry while NEVER dropping RESOLVE_CACHED.
	rootCachedAttempts = 3
)

type openat2Func func(dirfd int, path string, how *unix.OpenHow) (int, error)
type statxFunc func(dirfd int, path string, flags int, mask int, stat *unix.Statx_t) error
type fdinfoMountIDFunc func(fd int) (uint64, bool)

// linuxScanFS requires Linux 5.12+ openat2(RESOLVE_CACHED) for zero-I/O root
// resolution, openat2(RESOLVE_NO_XDEV|RESOLVE_NO_SYMLINKS|RESOLVE_NO_MAGICLINKS)
// for every relative step, /proc/self/fdinfo/<fd> mnt_id verification, and
// statx(AT_EMPTY_PATH|AT_NO_AUTOMOUNT).
//
// Proof that no call in this file can trigger an automount or send a request
// to an unchecked filesystem (citing Linux openat2(2), include/uapi/linux/openat2.h,
// fs/open.c, fs/namei.c, fs/autofs/root.c, and fs/proc/fd.c):
//  1. Root lookup uses openat2(AT_FDCWD, hostPath, O_PATH|O_CLOEXEC,
//     RESOLVE_CACHED|RESOLVE_NO_SYMLINKS|RESOLVE_NO_MAGICLINKS) — never plain
//     open(2), which can trigger automounts or follow symlinks on intermediate
//     path components (e.g. /srv when opening /srv/archive):
//     - fs/open.c: build_open_flags() sets LOOKUP_CACHED from RESOLVE_CACHED,
//     sets LOOKUP_NO_SYMLINKS|LOOKUP_NO_MAGICLINKS, and with O_PATH leaves
//     LOOKUP_OPEN, LOOKUP_DIRECTORY, and LOOKUP_CREATE unset.
//     - fs/namei.c: do_filp_open() runs path_openat(&nd, op, flags|LOOKUP_RCU)
//     -> do_o_path() -> path_lookupat() strictly under rcu_read_lock(), where
//     sleeping, blocking disk I/O, and invoking d_automount() are illegal.
//     Across every intermediate and final component:
//     * lookup_fast() checks only the in-memory dcache (__d_lookup_rcu); any
//     dcache miss fails RCU-walk without calling lookup_slow()/i_op->lookup().
//     * __follow_mount_rcu() crosses only already-mounted filesystems via the
//     in-memory mount hash (__lookup_mnt). An automount trigger carries
//     DCACHE_NEED_AUTOMOUNT (or DCACHE_MANAGE_TRANSIT with
//     fs/autofs/root.c: autofs_d_manage(..., rcu_walk=true)), which forces
//     handle_mounts() to call try_to_unlazy_next().
//     * try_to_unlazy() / try_to_unlazy_next() immediately fail when
//     LOOKUP_CACHED is set, aborting the RCU pass with -ECHILD. When
//     do_filp_open() retries without LOOKUP_RCU, path_init() checks
//     `if ((flags & (LOOKUP_RCU | LOOKUP_CACHED)) == LOOKUP_CACHED) return ERR_PTR(-EAGAIN);`
//     and returns -EAGAIN immediately without ever entering REF-walk,
//     calling lookup_slow(), or calling follow_automount()/d_automount().
//     * RESOLVE_NO_SYMLINKS|RESOLVE_NO_MAGICLINKS rejects any intermediate or
//     final symlink with -ELOOP without following it.
//     - For an unchanged mounted filesystem from /proc/self/mountinfo, every
//     dentry along hostPath is pinned in the dcache by its vfsmount
//     (mnt_mountpoint and d_parent chain to "/"), so cached RCU lookup
//     succeeds with zero I/O, and vfs_open() sees O_PATH and installs
//     empty_fops without calling i_fop->open() or i_op->getattr().
//     - Unknown how->resolve flags return -EINVAL (include/uapi/linux/openat2.h,
//     openat2(2)), so kernels < 5.12 lacking RESOLVE_CACHED fail with EINVAL
//     (and < 5.6 with ENOSYS) and are refused cleanly with CodeUnsupported;
//     persistent EAGAIN is refused cleanly without ever retrying uncached.
//  2. /proc/self/fdinfo/<fd> (fs/proc/fd.c: seq_show) reads
//     real_mount(file->f_path.mnt)->mnt_id purely from kernel VFS memory in
//     procfs, issuing zero operations on the target filesystem. We compare that
//     mount ID against the standby-checked mount BEFORE any follow-up openat2,
//     statx, fstatfs, or readable open on both the root and every child fd.
//  3. openat2(parentFD, child, O_PATH|O_CLOEXEC, RESOLVE_NO_XDEV|
//     RESOLVE_NO_SYMLINKS|RESOLVE_NO_MAGICLINKS) resolves a single child name
//     strictly on parentFD's already-verified mount: VFS rejects already-mounted
//     filesystems/bind mounts with EXDEV before calling into the child mount,
//     rejects symlinks with ELOOP, and without O_DIRECTORY/O_RDONLY never
//     triggers d_automount() on uncovered automount triggers.
//  4. statx(fd, "", AT_EMPTY_PATH|AT_NO_AUTOMOUNT) runs only AFTER step 2 has
//     proved fd's mount ID matches the checked awake mount; AT_NO_AUTOMOUNT
//     prevents triggering an uncovered automount dentry on the checked mount,
//     and STATX_ATTR_AUTOMOUNT / child STATX_ATTR_MOUNT_ROOT / mismatched
//     st_dev or STATX_MNT_ID are rejected before any readable open.
//  5. openat2(pathFD, ".", O_RDONLY|O_DIRECTORY|O_CLOEXEC|O_NONBLOCK,
//     RESOLVE_NO_XDEV|...) reopens the already-pinned, mount-verified dentry
//     without crossing an overmount, and step 2+4 re-verify the new fd before
//     getdents64 or fstatfs reads from it.
//
// Kernels before 5.12 (ENOSYS/EINVAL) and seccomp profiles blocking
// openat2/statx (EPERM/EACCES) are refused cleanly instead of falling back to
// uncached open/openat/fstatat.
type linuxScanFS struct {
	r             *Runner
	openat2       openat2Func
	statx         statxFunc
	fdinfoMountID fdinfoMountIDFunc
}

func newDefaultScanFS(r *Runner) scanFS {
	return &linuxScanFS{
		r:             r,
		openat2:       unix.Openat2,
		statx:         unix.Statx,
		fdinfoMountID: fdinfoMountID,
	}
}

type linuxFSState struct {
	openat2       openat2Func
	statx         statxFunc
	fdinfoMountID fdinfoMountIDFunc
	rootDev       uint64
	rootMntID     uint64
	hasRootMntID  bool
	readDirHook   func(logicalPath string) ([]fs.DirEntry, error)
	statMountID   func(logicalPath string) (uint64, bool)
	isTestRoot    bool
}

func (s *linuxFSState) readFDInfoMountID(fd int, logicalPath string) (uint64, bool) {
	if s.statMountID != nil {
		return s.statMountID(logicalPath)
	}
	if s.isTestRoot {
		return 0, false
	}
	if s.fdinfoMountID != nil {
		return s.fdinfoMountID(fd)
	}
	return 0, false
}

// verifyFDInfoMountID reads fd's mount ID from /proc/self/fdinfo/<fd> (pure
// kernel VFS memory, no filesystem request) and confirms it matches the checked
// root mount before any statx, fstatfs, or readable open touches fd.
func (s *linuxFSState) verifyFDInfoMountID(fd int, logicalPath string) (uint64, bool, error) {
	mntID, hasMntID := s.readFDInfoMountID(fd, logicalPath)
	if s.hasRootMntID && s.rootMntID != 0 {
		if !hasMntID || mntID != s.rootMntID {
			return 0, false, errWrongMount
		}
	}
	return mntID, hasMntID, nil
}

// inspectFD first verifies fd's mount ID via /proc/self/fdinfo/<fd> (no
// filesystem request) and only then calls statx(AT_EMPTY_PATH|AT_NO_AUTOMOUNT).
// It rejects automount trigger dentries (STATX_ATTR_AUTOMOUNT), child mount
// roots (STATX_ATTR_MOUNT_ROOT), and any STATX_MNT_ID disagreeing with fdinfo.
func (s *linuxFSState) inspectFD(fd int, logicalPath string, rejectMountRoot bool) (entryStat, error) {
	mntID, hasMntID, err := s.verifyFDInfoMountID(fd, logicalPath)
	if err != nil {
		return entryStat{}, err
	}
	var stx unix.Statx_t
	if err := statxNoEINTR(s.statx, fd, "", unix.AT_EMPTY_PATH|unix.AT_NO_AUTOMOUNT, unix.STATX_BASIC_STATS|unix.STATX_MNT_ID, &stx); err != nil {
		return entryStat{}, err
	}
	if stx.Attributes&unix.STATX_ATTR_AUTOMOUNT != 0 {
		return entryStat{}, errWrongMount
	}
	if rejectMountRoot && stx.Attributes&unix.STATX_ATTR_MOUNT_ROOT != 0 {
		return entryStat{}, errWrongMount
	}
	es := entryStatFromStatx(&stx)
	if s.statMountID != nil {
		es.MntID, es.HasMntID = mntID, hasMntID
	} else if s.isTestRoot {
		es.MntID, es.HasMntID = 0, false
	} else {
		if es.HasMntID && hasMntID && es.MntID != mntID {
			return entryStat{}, errWrongMount
		}
		if hasMntID {
			es.MntID, es.HasMntID = mntID, true
		}
	}
	return es, nil
}

func (s *linuxFSState) verifyDirFD(fd int, logicalPath string, rejectMountRoot bool) (entryStat, error) {
	es, err := s.inspectFD(fd, logicalPath, rejectMountRoot)
	if err != nil {
		return entryStat{}, err
	}
	if !es.Mode.IsDir() {
		return entryStat{}, errNotDir
	}
	if !es.HasDev || es.Dev != s.rootDev {
		return entryStat{}, errWrongMount
	}
	if s.hasRootMntID && s.rootMntID != 0 {
		if !es.HasMntID || es.MntID != s.rootMntID {
			return entryStat{}, errWrongMount
		}
	}
	return es, nil
}

func openRootPathCached(openat2Fn openat2Func, hostPath string) (int, error) {
	how := &unix.OpenHow{
		Flags:   unix.O_PATH | unix.O_CLOEXEC,
		Resolve: linuxRootOpenat2Resolve,
	}
	var (
		fd  int
		err error
	)
	for attempt := 0; attempt < rootCachedAttempts; attempt++ {
		fd, err = openat2NoEINTR(openat2Fn, unix.AT_FDCWD, hostPath, how)
		if err == nil {
			return fd, nil
		}
		if !errors.Is(err, unix.EAGAIN) {
			break
		}
	}
	if errors.Is(err, unix.ENOSYS) || errors.Is(err, unix.EINVAL) {
		return -1, &scanUnsupportedError{msg: "This server's system is too old for a safe scan."}
	}
	if errors.Is(err, unix.EPERM) {
		return -1, &scanUnsupportedError{msg: "This server does not allow a safe disk scan."}
	}
	if errors.Is(err, unix.EACCES) {
		// Distinguish seccomp returning EACCES on openat2 from genuine directory
		// permission denial on an intermediate component by probing "/" with the
		// same zero-I/O RESOLVE_CACHED call.
		if hostPath == "/" {
			return -1, &scanUnsupportedError{msg: "This server does not allow a safe disk scan."}
		}
		probeFD, perr := openat2NoEINTR(openat2Fn, unix.AT_FDCWD, "/", how)
		if perr == nil {
			_ = unix.Close(probeFD)
			return -1, err
		}
		if errors.Is(perr, unix.ENOSYS) || errors.Is(perr, unix.EINVAL) {
			return -1, &scanUnsupportedError{msg: "This server's system is too old for a safe scan."}
		}
		if errors.Is(perr, unix.EPERM) || errors.Is(perr, unix.EACCES) {
			return -1, &scanUnsupportedError{msg: "This server does not allow a safe disk scan."}
		}
		return -1, err
	}
	if errors.Is(err, unix.EAGAIN) {
		return -1, errRootNotCached
	}
	if errors.Is(err, unix.ELOOP) {
		return -1, errRootChanged
	}
	return -1, err
}

func (f *linuxScanFS) OpenRoot(hostPath, logicalMount string, expected mountInfo) (scanDir, error) {
	openat2Fn := f.openat2
	if openat2Fn == nil {
		openat2Fn = unix.Openat2
	}
	statxFn := f.statx
	if statxFn == nil {
		statxFn = unix.Statx
	}
	fdinfoFn := f.fdinfoMountID
	if fdinfoFn == nil {
		fdinfoFn = fdinfoMountID
	}

	// Step 1: resolve hostPath strictly from kernel RCU dcache/mount memory
	// with openat2(O_PATH|O_CLOEXEC, RESOLVE_CACHED|RESOLVE_NO_SYMLINKS|
	// RESOLVE_NO_MAGICLINKS). No intermediate or final component can trigger
	// an automount, follow a symlink, or issue disk I/O (EAGAIN refuses).
	pathFD, err := openRootPathCached(openat2Fn, hostPath)
	if err != nil {
		return nil, err
	}

	state := &linuxFSState{
		openat2:       openat2Fn,
		statx:         statxFn,
		fdinfoMountID: fdinfoFn,
		readDirHook:   f.r.readDir,
		statMountID:   f.r.statMountID,
		isTestRoot:    f.r.root != "",
	}

	// Step 2: check pathFD's mount ID via /proc/self/fdinfo/<pathFD> BEFORE any
	// openat2, statx, fstatfs, or readable open. If another filesystem was
	// mounted over hostPath after the standby check, we detect the mismatch in
	// kernel VFS memory and close pathFD without touching the overmount.
	mntID, hasMntID := state.readFDInfoMountID(pathFD, logicalMount)
	if expected.ID > 0 {
		if !state.isTestRoot && !hasMntID {
			_ = unix.Close(pathFD)
			return nil, &scanUnsupportedError{msg: "This server's system is too old for a safe scan."}
		}
		if hasMntID && mntID != uint64(expected.ID) {
			_ = unix.Close(pathFD)
			return nil, errRootChanged
		}
	}
	if hasMntID {
		state.rootMntID = mntID
		state.hasRootMntID = true
	}

	// Step 3: probe openat2(RESOLVE_NO_XDEV) once on the already mount-verified
	// O_PATH descriptor. Refuse cleanly if the kernel or seccomp rejects it.
	probeFD, perr := openat2NoEINTR(openat2Fn, pathFD, ".", &unix.OpenHow{
		Flags:   unix.O_PATH | unix.O_CLOEXEC,
		Resolve: linuxOpenat2Resolve,
	})
	if perr != nil {
		_ = unix.Close(pathFD)
		if errors.Is(perr, unix.ENOSYS) || errors.Is(perr, unix.EINVAL) {
			return nil, &scanUnsupportedError{msg: "This server's system is too old for a safe scan."}
		}
		if errors.Is(perr, unix.EPERM) || errors.Is(perr, unix.EACCES) {
			return nil, &scanUnsupportedError{msg: "This server does not allow a safe disk scan."}
		}
		return nil, perr
	}
	_ = unix.Close(probeFD)

	// Step 4: now that Step 2 proved pathFD belongs to the checked awake mount,
	// inspect its mode, device, and automount flag via statx(AT_EMPTY_PATH|AT_NO_AUTOMOUNT).
	rootMeta, serr := state.inspectFD(pathFD, logicalMount, false)
	if serr != nil {
		_ = unix.Close(pathFD)
		if errors.Is(serr, unix.ENOSYS) {
			return nil, &scanUnsupportedError{msg: "This server's system is too old for a safe scan."}
		}
		if errors.Is(serr, unix.EPERM) {
			return nil, &scanUnsupportedError{msg: "This server does not allow a safe disk scan."}
		}
		if errors.Is(serr, errWrongMount) {
			return nil, errRootChanged
		}
		return nil, serr
	}
	if !rootMeta.Mode.IsDir() {
		_ = unix.Close(pathFD)
		return nil, errNotDir
	}
	state.rootDev = rootMeta.Dev
	if !state.hasRootMntID && rootMeta.HasMntID {
		state.rootMntID = rootMeta.MntID
		state.hasRootMntID = true
	}

	// Step 5: open "." from the verified O_PATH descriptor for directory reading,
	// then re-verify fdinfo mount ID before statx on the readable descriptor.
	fd, err := openat2NoEINTR(openat2Fn, pathFD, ".", &unix.OpenHow{
		Flags:   unix.O_RDONLY | unix.O_DIRECTORY | unix.O_CLOEXEC | unix.O_NONBLOCK,
		Resolve: linuxOpenat2Resolve,
	})
	_ = unix.Close(pathFD)
	if err != nil {
		if errors.Is(err, unix.EXDEV) {
			return nil, errRootChanged
		}
		return nil, err
	}
	if _, verr := state.verifyDirFD(fd, logicalMount, false); verr != nil {
		_ = unix.Close(fd)
		if errors.Is(verr, errWrongMount) {
			return nil, errRootChanged
		}
		return nil, verr
	}

	return &linuxScanDir{fd: fd, logicalPath: logicalMount, state: state}, nil
}

type linuxScanDir struct {
	fd          int
	logicalPath string
	state       *linuxFSState

	direntBuf []byte
	direntOff int
	direntLen int
	direntEOF bool

	hookEnts   []fs.DirEntry
	hookLoaded bool
	hookOff    int
}

func (d *linuxScanDir) Stat() (entryStat, error) {
	return d.state.inspectFD(d.fd, d.logicalPath, false)
}

func (d *linuxScanDir) Statfs() (fsStat, error) {
	if _, _, err := d.state.verifyFDInfoMountID(d.fd, d.logicalPath); err != nil {
		return fsStat{}, err
	}
	return fdStatfs(d.fd)
}

func (d *linuxScanDir) OpenSelf() (scanDir, error) {
	fd, err := openat2NoEINTR(d.state.openat2, d.fd, ".", &unix.OpenHow{
		Flags:   unix.O_RDONLY | unix.O_DIRECTORY | unix.O_CLOEXEC | unix.O_NONBLOCK,
		Resolve: linuxOpenat2Resolve,
	})
	if err != nil {
		if errors.Is(err, unix.EXDEV) {
			return nil, errWrongMount
		}
		return nil, err
	}
	if _, verr := d.state.verifyDirFD(fd, d.logicalPath, false); verr != nil {
		_ = unix.Close(fd)
		return nil, verr
	}
	return &linuxScanDir{fd: fd, logicalPath: d.logicalPath, state: d.state}, nil
}

func (d *linuxScanDir) ReadDirBatch(maxEntries int) ([]dirEntryInfo, error) {
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
	return d.readLinuxDirentBatch(limit)
}

func (d *linuxScanDir) OpenDir(name, logicalPath string, searchOnly, _ bool) (scanDir, error) {
	if !isSafeChildName(name) {
		return nil, errWrongMount
	}

	// Step 1: pin the child with O_PATH and NO O_DIRECTORY.
	// On Linux 5.6 through 6.11+, passing O_DIRECTORY or O_RDONLY sets
	// LOOKUP_DIRECTORY/LOOKUP_OPEN in VFS, which makes follow_automount()
	// trigger an automount before RESOLVE_NO_XDEV refuses the crossing.
	// O_PATH without O_DIRECTORY sets none of those flags, so already-mounted
	// filesystems fail with EXDEV in VFS and uncovered automount triggers stop
	// without invoking d_automount().
	pathFD, err := openat2NoEINTR(d.state.openat2, d.fd, name, &unix.OpenHow{
		Flags:   unix.O_PATH | unix.O_CLOEXEC,
		Resolve: linuxOpenat2Resolve,
	})
	if err != nil {
		if errors.Is(err, unix.EXDEV) {
			return nil, errWrongMount
		}
		return nil, err
	}

	// Step 2: verify the pinned descriptor's mount ID from /proc/self/fdinfo/<fd>
	// first (no filesystem request), and only then inspect it via
	// statx(AT_EMPTY_PATH|AT_NO_AUTOMOUNT) (rejecting STATX_ATTR_AUTOMOUNT,
	// STATX_ATTR_MOUNT_ROOT, non-directories, different st_dev, and mismatched
	// mount IDs) BEFORE opening it.
	if _, verr := d.state.verifyDirFD(pathFD, logicalPath, true); verr != nil {
		_ = unix.Close(pathFD)
		return nil, verr
	}

	// Search-only callers only traverse deeper or confirm mount identity; the
	// verified O_PATH descriptor supports openat2 on children (even on 0111 dirs)
	// without needing a readable open.
	if searchOnly {
		return &linuxScanDir{fd: pathFD, logicalPath: logicalPath, state: d.state}, nil
	}

	// Step 3: open "." from the already-pinned and verified descriptor for reading.
	fd, err := openat2NoEINTR(d.state.openat2, pathFD, ".", &unix.OpenHow{
		Flags:   unix.O_RDONLY | unix.O_DIRECTORY | unix.O_CLOEXEC | unix.O_NONBLOCK,
		Resolve: linuxOpenat2Resolve,
	})
	_ = unix.Close(pathFD)
	if err != nil {
		if errors.Is(err, unix.EXDEV) {
			return nil, errWrongMount
		}
		return nil, err
	}
	if _, verr := d.state.verifyDirFD(fd, logicalPath, true); verr != nil {
		_ = unix.Close(fd)
		return nil, verr
	}
	return &linuxScanDir{fd: fd, logicalPath: logicalPath, state: d.state}, nil
}

func (d *linuxScanDir) StatEntry(name, logicalPath string) (entryStat, error) {
	if !isSafeChildName(name) {
		return entryStat{}, errWrongMount
	}

	// Pin the child entry with O_PATH (no O_DIRECTORY) and RESOLVE_NO_XDEV |
	// RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS. inspectFD then checks
	// /proc/self/fdinfo/<entryFD> mount ID BEFORE calling
	// statx(AT_EMPTY_PATH|AT_NO_AUTOMOUNT). A filesystem or bind mount at name
	// fails with EXDEV in VFS before any getattr touches it, any descriptor on
	// another mount is rejected via fdinfo before statx, and an automount
	// trigger is pinned without triggering and rejected via STATX_ATTR_AUTOMOUNT.
	entryFD, err := openat2NoEINTR(d.state.openat2, d.fd, name, &unix.OpenHow{
		Flags:   unix.O_PATH | unix.O_CLOEXEC,
		Resolve: linuxOpenat2Resolve,
	})
	if err != nil {
		if errors.Is(err, unix.EXDEV) {
			return entryStat{}, errWrongMount
		}
		return entryStat{}, err
	}
	es, serr := d.state.inspectFD(entryFD, logicalPath, true)
	_ = unix.Close(entryFD)
	if serr != nil {
		return entryStat{}, serr
	}
	if es.Mode&fs.ModeSymlink != 0 {
		return es, nil
	}
	if !es.HasDev || es.Dev != d.state.rootDev {
		return entryStat{}, errWrongMount
	}
	if d.state.hasRootMntID && d.state.rootMntID != 0 {
		if !es.HasMntID || es.MntID != d.state.rootMntID {
			return entryStat{}, errWrongMount
		}
	}
	return es, nil
}

func (d *linuxScanDir) Close() error {
	d.direntBuf = nil
	d.hookEnts = nil
	if d.fd < 0 {
		return nil
	}
	fd := d.fd
	d.fd = -1
	return unix.Close(fd)
}

// readLinuxDirentBatch reads up to limit directory entries incrementally via
// getdents64 so DT_UNKNOWN entries (XFS without ftype=1, FUSE) are returned as
// entryUnknown without Go's os.File.ReadDir calling lstatat, and huge
// directories are never buffered in full before entry caps or cancellation run.
func (d *linuxScanDir) readLinuxDirentBatch(limit int) ([]dirEntryInfo, error) {
	const (
		reclenOff = int(unsafe.Offsetof(unix.Dirent{}.Reclen))
		typeOff   = int(unsafe.Offsetof(unix.Dirent{}.Type))
		nameOff   = int(unsafe.Offsetof(unix.Dirent{}.Name))
	)
	out := make([]dirEntryInfo, 0, min(limit, 64))
	for len(out) < limit {
		if d.direntOff < d.direntLen {
			b := d.direntBuf[d.direntOff:d.direntLen]
			for len(b) >= nameOff && len(out) < limit {
				reclen := int(binary.NativeEndian.Uint16(b[reclenOff : reclenOff+2]))
				if reclen < nameOff || reclen > len(b) {
					d.direntOff = d.direntLen
					b = nil
					break
				}
				rec := b[:reclen]
				b = b[reclen:]
				d.direntOff += reclen

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
			if len(b) < nameOff {
				d.direntOff = d.direntLen
			}
			if len(out) > 0 {
				return out, nil
			}
		}

		if d.direntEOF {
			return nil, io.EOF
		}
		if d.direntBuf == nil {
			d.direntBuf = make([]byte, 32*1024)
		}
		var n int
		var err error
		for {
			n, err = unix.Getdents(d.fd, d.direntBuf)
			if errors.Is(err, unix.EINTR) {
				continue
			}
			break
		}
		if err != nil {
			return nil, err
		}
		if n == 0 {
			d.direntEOF = true
			d.direntBuf = nil
			return nil, io.EOF
		}
		d.direntOff = 0
		d.direntLen = n
	}
	return out, nil
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

func statxNoEINTR(fn statxFunc, dirfd int, path string, flags int, mask int, stx *unix.Statx_t) error {
	for {
		err := fn(dirfd, path, flags, mask, stx)
		if errors.Is(err, unix.EINTR) {
			continue
		}
		return err
	}
}
