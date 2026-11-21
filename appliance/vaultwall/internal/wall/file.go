package wall

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/unix"
)

// ErrNoFile means the directory or the file does not exist (yet): the runtime has not written a list.
var ErrNoFile = errors.New("no file")

// Source is where the runtime writes its list (WHOMBAT_VAULT_NETWORKS_FILE, VT-59).
type Source struct {
	// Dir is the absolute directory, Name the file's name in it.
	Dir, Name string
	// Owner is the uid that may own the directory and the file besides root (the runtime's user).
	Owner uint32
	// Max bounds the file's size.
	Max int64
}

// NewSource splits an absolute file path into a Source.
func NewSource(path string, owner uint32, max int64) (Source, error) {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return Source{}, fmt.Errorf("%q is not a clean absolute path", path)
	}
	dir, name := filepath.Split(path)
	if name == "" || name == "." || name == ".." {
		return Source{}, fmt.Errorf("%q names no file", path)
	}
	return Source{Dir: filepath.Clean(dir), Name: name, Owner: owner, Max: max}, nil
}

// Path is the file's full path.
func (s Source) Path() string { return filepath.Join(s.Dir, s.Name) }

// Read returns the file's bytes. It never follows a symbolic link (not in the directory's path, not the file
// itself), reads only a regular file owned by root or Owner that only its owner can write, in a directory with
// the same properties, and never blocks on a FIFO or a device.
//
// The path is walked one component at a time with openat(O_NOFOLLOW) rather than with openat2(RESOLVE_NO_SYMLINKS):
// systemd's seccomp filter answers openat2 with ENOSYS under RestrictSUIDSGID= (implied by DynamicUser=), because
// it can't inspect openat2's flags.
func (s Source) Read() ([]byte, error) {
	dfd, err := openDir(s.Dir)
	if err != nil {
		if errors.Is(err, unix.ENOENT) {
			return nil, ErrNoFile
		}
		return nil, fmt.Errorf("directory %s: %w", s.Dir, err)
	}
	defer unix.Close(dfd)
	if err := s.checkOwner(dfd, unix.S_IFDIR); err != nil {
		return nil, fmt.Errorf("directory %s: %w", s.Dir, err)
	}

	fd, err := unix.Openat(dfd, s.Name, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK|unix.O_NOCTTY|unix.O_CLOEXEC, 0)
	if err != nil {
		if errors.Is(err, unix.ENOENT) {
			return nil, ErrNoFile
		}
		if errors.Is(err, unix.ELOOP) {
			return nil, errSymlink
		}
		return nil, err
	}
	f := os.NewFile(uintptr(fd), s.Path())
	defer f.Close()
	if err := s.checkOwner(fd, unix.S_IFREG); err != nil {
		return nil, err
	}
	data, err := io.ReadAll(io.LimitReader(f, s.Max+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > s.Max {
		return nil, fmt.Errorf("larger than %d bytes", s.Max)
	}
	return data, nil
}

var errSymlink = errors.New("a symbolic link (not followed)")

// openDir opens a clean absolute directory path from / one name at a time, refusing a symbolic link anywhere.
func openDir(path string) (int, error) {
	fd, err := unix.Open("/", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		return -1, err
	}
	for _, name := range strings.Split(strings.TrimPrefix(path, "/"), "/") {
		if name == "" {
			continue
		}
		next, err := unix.Openat(fd, name, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
		if err != nil && (errors.Is(err, unix.ELOOP) || errors.Is(err, unix.ENOTDIR)) {
			var st unix.Stat_t
			if unix.Fstatat(fd, name, &st, unix.AT_SYMLINK_NOFOLLOW) == nil && st.Mode&unix.S_IFMT == unix.S_IFLNK {
				err = errSymlink
			} else {
				err = fmt.Errorf("%s is not a directory", name)
			}
		}
		unix.Close(fd)
		if err != nil {
			return -1, err
		}
		fd = next
	}
	return fd, nil
}

func (s Source) checkOwner(fd int, kind uint32) error {
	var st unix.Stat_t
	if err := unix.Fstat(fd, &st); err != nil {
		return err
	}
	if st.Mode&unix.S_IFMT != kind {
		if kind == unix.S_IFDIR {
			return errors.New("not a directory")
		}
		return errors.New("not a regular file")
	}
	if st.Uid != 0 && st.Uid != s.Owner {
		return fmt.Errorf("owned by uid %d, not %d or root", st.Uid, s.Owner)
	}
	if st.Mode&0o022 != 0 {
		return fmt.Errorf("writable by others than its owner (mode %04o)", st.Mode&0o7777)
	}
	return nil
}
