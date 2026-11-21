package collect

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"golang.org/x/sys/unix"
)

// openInRoot opens rel inside root (e.g. a container's /proc/<pid>/root)
// the way a process chrooted there would: absolute symlinks and ".." stay
// inside root. It uses openat2(RESOLVE_IN_ROOT) and, on kernels before
// 5.6, resolves the path itself. The file is opened non-blocking, without
// following a final symlink, and must be a regular file.
func openInRoot(root, rel string) (*os.File, error) {
	dirfd, err := unix.Open(root, unix.O_PATH|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, &os.PathError{Op: "open", Path: root, Err: err}
	}
	defer unix.Close(dirfd)
	fd, err := unix.Openat2(dirfd, rel, &unix.OpenHow{
		Flags:   unix.O_RDONLY | unix.O_NONBLOCK | unix.O_CLOEXEC,
		Resolve: unix.RESOLVE_IN_ROOT | unix.RESOLVE_NO_MAGICLINKS,
	})
	var f *os.File
	switch {
	case err == nil:
		f = os.NewFile(uintptr(fd), filepath.Join(root, rel))
	case errors.Is(err, unix.ENOSYS) || errors.Is(err, unix.EPERM):
		p, rerr := resolveInRoot(root, rel)
		if rerr != nil {
			return nil, rerr
		}
		f, err = os.OpenFile(p, os.O_RDONLY|unix.O_NONBLOCK|unix.O_NOFOLLOW, 0)
		if err != nil {
			return nil, err
		}
	default:
		return nil, &os.PathError{Op: "openat2", Path: filepath.Join(root, rel), Err: err}
	}
	st, err := f.Stat()
	if err != nil || !st.Mode().IsRegular() {
		f.Close()
		return nil, fmt.Errorf("%s: not a regular file", filepath.Join(root, rel))
	}
	return f, nil
}
