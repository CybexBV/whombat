// Package safeopen opens files in directories another (less trusted) user controls, for the root update
// helper (W4-SEC part 2 L-6): no path component may be a symlink (openat2 RESOLVE_NO_SYMLINKS, or a
// component-wise O_NOFOLLOW walk where openat2 is unavailable), the open never blocks (O_NONBLOCK: a FIFO
// planted by the manager can't hang the helper), and the result must be a regular file.
package safeopen

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/unix"
)

// ErrNotRegular: the path names something other than a regular file (FIFO, device, directory, socket).
var ErrNotRegular = errors.New("not a regular file")

// ErrSymlink: a path component is a symbolic link.
var ErrSymlink = errors.New("path contains a symbolic link")

const fileFlags = unix.O_RDONLY | unix.O_NONBLOCK | unix.O_CLOEXEC | unix.O_NOCTTY | unix.O_NOFOLLOW

// OpenRegular opens an absolute path read-only. A missing file reports an error matching os.ErrNotExist.
func OpenRegular(path string) (*os.File, error) {
	if !filepath.IsAbs(path) {
		abs, err := filepath.Abs(path)
		if err != nil {
			return nil, err
		}
		path = abs
	}
	fd, err := unix.Openat2(unix.AT_FDCWD, path, &unix.OpenHow{Flags: fileFlags,
		Resolve: unix.RESOLVE_NO_SYMLINKS | unix.RESOLVE_NO_MAGICLINKS})
	if errors.Is(err, unix.ENOSYS) {
		fd, err = walk(path)
	}
	if err != nil {
		switch {
		case errors.Is(err, unix.ENOENT):
			return nil, &os.PathError{Op: "open", Path: path, Err: os.ErrNotExist}
		case errors.Is(err, unix.ELOOP), errors.Is(err, unix.EXDEV):
			return nil, fmt.Errorf("%s: %w", path, ErrSymlink)
		}
		return nil, &os.PathError{Op: "open", Path: path, Err: err}
	}
	f := os.NewFile(uintptr(fd), path)
	st, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, err
	}
	if !st.Mode().IsRegular() {
		f.Close()
		return nil, fmt.Errorf("%s: %w (%v)", path, ErrNotRegular, st.Mode().Type())
	}
	// A regular file: blocking reads are fine again.
	if err := unix.SetNonblock(fd, false); err != nil {
		f.Close()
		return nil, err
	}
	return f, nil
}

// walk opens path component by component with O_NOFOLLOW (kernels without openat2).
func walk(path string) (int, error) {
	dir, err := unix.Open("/", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		return -1, err
	}
	parts := strings.Split(strings.Trim(filepath.Clean(path), "/"), "/")
	for i, p := range parts {
		fl := unix.O_RDONLY | unix.O_DIRECTORY | unix.O_NOFOLLOW | unix.O_CLOEXEC
		if i == len(parts)-1 {
			fl = fileFlags
		}
		next, err := unix.Openat(dir, p, fl, 0)
		unix.Close(dir)
		if err != nil {
			if errors.Is(err, unix.ENOTDIR) && i < len(parts)-1 {
				return -1, unix.ELOOP // a symlink (or a file) where a directory was expected
			}
			return -1, err
		}
		dir = next
	}
	return dir, nil
}

// ReadSmall reads a regular file of at most max bytes.
func ReadSmall(path string, max int64) ([]byte, error) {
	f, err := OpenRegular(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, max+1))
	if err != nil {
		return nil, err
	}
	if int64(len(b)) > max {
		return nil, errors.New("file too large")
	}
	return b, nil
}
