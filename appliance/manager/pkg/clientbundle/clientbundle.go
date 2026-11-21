// Package clientbundle unpacks and checks AI client bundle artifacts (CT-74): a tar.gz whose files are the
// vendor's package exactly as published (SUB-02, E-C1 “The Claude Code binary must not be modified”). The manager
// installs with it and the channel publisher checks with it that what it signs will install.
//
// Only directories and regular files are accepted (no links, devices or FIFOs), every name is a plain relative
// path, sizes and entry counts are bounded, and nothing is written outside the destination. File contents and
// names are kept byte for byte; only the permission bits are tightened to read-only (0555 for anything
// executable, 0444 otherwise; directories 0555).
package clientbundle

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
)

// Limits bound an unpack.
type Limits struct {
	MaxBytes   int64 // total unpacked bytes (default 2 GiB)
	MaxEntries int   // default 10000
}

func (l Limits) withDefaults() Limits {
	if l.MaxBytes <= 0 {
		l.MaxBytes = 2 << 30
	}
	if l.MaxEntries <= 0 {
		l.MaxEntries = 10000
	}
	return l
}

// ErrBadArchive: the artifact is not an acceptable client package (the message says why).
var ErrBadArchive = errors.New("unacceptable client archive")

// ErrExecutable: the executable is missing, or its size or sha256 differs from the bundle's.
var ErrExecutable = errors.New("client executable does not match the bundle")

// CleanName validates an archive member name and returns it without a leading "./" or trailing "/".
func CleanName(name string) (string, error) {
	n := strings.TrimPrefix(name, "./")
	n = strings.TrimSuffix(n, "/")
	if n == "" || n == "." {
		return "", nil // the archive root itself
	}
	if strings.ContainsAny(n, "\\\x00") || strings.HasPrefix(n, "/") || path.Clean(n) != n {
		return "", fmt.Errorf("%w: member name %q", ErrBadArchive, name)
	}
	for _, seg := range strings.Split(n, "/") {
		if seg == "." || seg == ".." || seg == "" {
			return "", fmt.Errorf("%w: member name %q", ErrBadArchive, name)
		}
	}
	return n, nil
}

// Unpack extracts the tar.gz at archive into dest (created; must not exist) and reports the unpacked byte count
// through progress (may be nil). On any error dest is removed.
func Unpack(ctx context.Context, archive, dest string, lim Limits, progress func(done int64)) (err error) {
	lim = lim.withDefaults()
	if err := os.Mkdir(dest, 0o755); err != nil {
		return err
	}
	defer func() {
		if err != nil {
			_ = ForceRemove(dest)
		}
	}()
	f, err := os.Open(archive)
	if err != nil {
		return err
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrBadArchive, err)
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	var total int64
	entries := 0
	seen := map[string]bool{}
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		h, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return fmt.Errorf("%w: %v", ErrBadArchive, err)
		}
		entries++
		if entries > lim.MaxEntries {
			return fmt.Errorf("%w: more than %d entries", ErrBadArchive, lim.MaxEntries)
		}
		name, err := CleanName(h.Name)
		if err != nil {
			return err
		}
		if name == "" {
			continue
		}
		if seen[name] {
			return fmt.Errorf("%w: duplicate member %q", ErrBadArchive, name)
		}
		seen[name] = true
		target := filepath.Join(dest, filepath.FromSlash(name))
		if err := realParents(dest, name); err != nil {
			return err
		}
		switch h.Typeflag {
		case tar.TypeDir:
			if err := os.Mkdir(target, 0o755); err != nil && !errors.Is(err, fs.ErrExist) {
				return err
			}
			if st, err := os.Lstat(target); err != nil || !st.IsDir() {
				return fmt.Errorf("%w: %q is not a directory", ErrBadArchive, name)
			}
		case tar.TypeReg:
			if h.Size < 0 || total+h.Size > lim.MaxBytes {
				return fmt.Errorf("%w: unpacked size above %d bytes", ErrBadArchive, lim.MaxBytes)
			}
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				return err
			}
			if err := realParents(dest, name); err != nil {
				return err
			}
			mode := os.FileMode(0o644)
			if h.Mode&0o111 != 0 {
				mode = 0o755
			}
			out, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL|syscall.O_NOFOLLOW, mode)
			if err != nil {
				return err
			}
			n, cerr := io.Copy(out, &ctxReader{ctx: ctx, r: io.LimitReader(tr, h.Size)})
			serr := out.Sync()
			out.Close()
			if cerr != nil {
				return cerr
			}
			if serr != nil {
				return serr
			}
			if n != h.Size {
				return fmt.Errorf("%w: %q truncated", ErrBadArchive, name)
			}
			total += n
			if progress != nil {
				progress(total)
			}
		default:
			return fmt.Errorf("%w: %q is not a regular file or directory (type %q)", ErrBadArchive, name, h.Typeflag)
		}
	}
	return nil
}

// realParents checks that every parent of name inside dest is a real directory (no symlink in the path).
func realParents(dest, name string) error {
	segs := strings.Split(name, "/")
	p := dest
	for _, s := range segs[:len(segs)-1] {
		p = filepath.Join(p, s)
		st, err := os.Lstat(p)
		if errors.Is(err, fs.ErrNotExist) {
			return nil
		}
		if err != nil {
			return err
		}
		if !st.IsDir() {
			return fmt.Errorf("%w: parent of %q is not a directory", ErrBadArchive, name)
		}
	}
	return nil
}

type ctxReader struct {
	ctx context.Context
	r   io.Reader
}

func (c *ctxReader) Read(p []byte) (int, error) {
	if err := c.ctx.Err(); err != nil {
		return 0, err
	}
	return c.r.Read(p)
}

// CheckExecutable verifies that rel inside dir is a regular file (no symlink on the way) of the given size and
// sha256 (lowercase hex).
func CheckExecutable(dir, rel string, size int64, sha string) error {
	name, err := CleanName(rel)
	if err != nil || name == "" {
		return fmt.Errorf("%w: bad path %q", ErrExecutable, rel)
	}
	if err := realParents(dir, name); err != nil {
		return fmt.Errorf("%w: %v", ErrExecutable, err)
	}
	p := filepath.Join(dir, filepath.FromSlash(name))
	f, err := os.OpenFile(p, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrExecutable, err)
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil || !st.Mode().IsRegular() {
		return fmt.Errorf("%w: %s is not a regular file", ErrExecutable, rel)
	}
	if st.Size() != size {
		return fmt.Errorf("%w: %s is %d bytes, the bundle says %d", ErrExecutable, rel, st.Size(), size)
	}
	if st.Mode().Perm()&0o111 == 0 {
		return fmt.Errorf("%w: %s is not executable", ErrExecutable, rel)
	}
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return err
	}
	if got := hex.EncodeToString(h.Sum(nil)); got != sha {
		return fmt.Errorf("%w: %s sha256 %s, the bundle says %s", ErrExecutable, rel, got, sha)
	}
	return nil
}

// ReadOnly makes a tree read-only: files 0555 (executable) or 0444, directories 0555, deepest first.
func ReadOnly(dir string) error {
	var dirs []string
	err := filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		switch {
		case d.IsDir():
			dirs = append(dirs, p)
		case d.Type().IsRegular():
			info, err := d.Info()
			if err != nil {
				return err
			}
			mode := os.FileMode(0o444)
			if info.Mode().Perm()&0o111 != 0 {
				mode = 0o555
			}
			return os.Chmod(p, mode)
		default:
			return fmt.Errorf("%w: %s is not a regular file or directory", ErrBadArchive, p)
		}
		return nil
	})
	if err != nil {
		return err
	}
	sort.Sort(sort.Reverse(sort.StringSlice(dirs)))
	for _, d := range dirs {
		if err := os.Chmod(d, 0o555); err != nil {
			return err
		}
	}
	return nil
}

// ForceRemove removes a (read-only) tree: directories are made writable first. Symlinks are removed, never
// followed. A missing path is not an error.
func ForceRemove(p string) error {
	st, err := os.Lstat(p)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if st.IsDir() {
		_ = filepath.WalkDir(p, func(q string, d fs.DirEntry, err error) error {
			if err == nil && d.IsDir() {
				_ = os.Chmod(q, 0o755)
			}
			return nil
		})
	}
	return os.RemoveAll(p)
}
