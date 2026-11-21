// Package snap makes the checkpoint's sources readable at a fixed staging location as of one instant
// (BK-04): btrfs read-only subvolume snapshots, ZFS snapshots (bind-mounted), or — when the layout has no
// snapshot-capable filesystem — a quiesced copy (writes stay paused for the whole copy and the checkpoint
// says so). On the appliance the drivers run in whombat-backup-snapd (root, typed operations only); the
// backup service itself never needs privileges beyond reading the staged snapshot.
package snap

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"

	"golang.org/x/sys/unix"
)

// Driver snapshots one source into dst.
type Driver interface {
	Name() string
	// Method is recorded in the manifest: "snapshot" (atomic per source, writes paused for moments) or
	// "quiesced-copy" (writes paused for the whole copy).
	Method() string
	Create(ctx context.Context, src, dst string) error
	Release(ctx context.Context, dst string) error
}

// ErrNoSpace means the staging filesystem can't hold the copy.
var ErrNoSpace = errors.New("not enough space for the staging copy")

func runCmd(ctx context.Context, name string, args ...string) error {
	out, err := exec.CommandContext(ctx, name, args...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s %s: %w: %s", name, strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return nil
}

// Btrfs takes read-only subvolume snapshots. Every source must be a subvolume on the same filesystem
// as the staging directory (MA-12 layout requirement, BK-04).
type Btrfs struct{ Bin string }

func (b Btrfs) bin() string {
	if b.Bin != "" {
		return b.Bin
	}
	return "btrfs"
}
func (Btrfs) Name() string   { return "btrfs" }
func (Btrfs) Method() string { return "snapshot" }
func (b Btrfs) Create(ctx context.Context, src, dst string) error {
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	return runCmd(ctx, b.bin(), "subvolume", "snapshot", "-r", src, dst)
}
func (b Btrfs) Release(ctx context.Context, dst string) error {
	if _, err := os.Lstat(dst); errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return runCmd(ctx, b.bin(), "subvolume", "delete", dst)
}

// ZFS snapshots the dataset mounted at each source and bind-mounts the snapshot read-only at dst.
type ZFS struct {
	Bin      string
	Datasets map[string]string // source path → dataset
	Tag      string            // snapshot name, e.g. "whombat-backup"
}

func (z ZFS) bin() string {
	if z.Bin != "" {
		return z.Bin
	}
	return "zfs"
}
func (ZFS) Name() string   { return "zfs" }
func (ZFS) Method() string { return "snapshot" }
func (z ZFS) Create(ctx context.Context, src, dst string) error {
	ds, ok := z.Datasets[src]
	if !ok {
		return fmt.Errorf("zfs: no dataset configured for %s", src)
	}
	_ = runCmd(ctx, z.bin(), "destroy", ds+"@"+z.Tag) // a leftover from a crashed run
	if err := runCmd(ctx, z.bin(), "snapshot", ds+"@"+z.Tag); err != nil {
		return err
	}
	if err := os.MkdirAll(dst, 0o755); err != nil {
		return err
	}
	return runCmd(ctx, "mount", "--bind", "-o", "ro", filepath.Join(src, ".zfs", "snapshot", z.Tag), dst)
}
func (z ZFS) Release(ctx context.Context, dst string) error {
	_ = runCmd(ctx, "umount", dst)
	_ = os.Remove(dst)
	for src, ds := range z.Datasets {
		_ = src
		_ = runCmd(ctx, z.bin(), "destroy", ds+"@"+z.Tag)
	}
	return nil
}

// Copy is the fallback: a full copy of the source, taken while writes stay quiesced. It clones file
// extents (FICLONE) where the filesystem supports it (btrfs, XFS: near-instant), else copies bytes.
// Ownership is preserved when running as root (on the appliance: whombat-backup-snapd).
type Copy struct {
	// Reserve is kept free on the staging filesystem (bytes).
	Reserve int64
	// NoClone forces byte copies (measurements of the ext4 case on a reflink-capable filesystem).
	NoClone bool
}

func (Copy) Name() string   { return "copy" }
func (Copy) Method() string { return "quiesced-copy" }

// Need walks src and returns its apparent size.
func Need(src string) (int64, error) {
	var total int64
	err := filepath.WalkDir(src, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.Type().IsRegular() {
			fi, err := d.Info()
			if err == nil {
				total += fi.Size()
			}
		}
		return nil
	})
	return total, err
}

// Free returns bytes available to this process on dir's filesystem.
func Free(dir string) (int64, error) {
	var st unix.Statfs_t
	if err := unix.Statfs(dir, &st); err != nil {
		return 0, err
	}
	return int64(st.Bavail) * int64(st.Bsize), nil
}

func (c Copy) Create(ctx context.Context, src, dst string) error {
	if _, err := os.Lstat(src); errors.Is(err, os.ErrNotExist) {
		return os.MkdirAll(dst, 0o700) // an absent source is an empty tree (recorded as missing)
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	need, err := Need(src)
	if err != nil {
		return fmt.Errorf("copy %s: %w", src, err)
	}
	free, err := Free(filepath.Dir(dst))
	if err == nil && need+c.Reserve > free {
		return fmt.Errorf("%w: %s needs %d bytes, %d free (reserve %d)", ErrNoSpace, src, need, free, c.Reserve)
	}
	err = copyTree(ctx, src, dst, !c.NoClone)
	if err != nil {
		_ = removeTree(dst)
		if errors.Is(err, syscall.ENOSPC) || errors.Is(err, syscall.EDQUOT) {
			return fmt.Errorf("%w: %v", ErrNoSpace, err)
		}
	}
	return err
}

func (Copy) Release(_ context.Context, dst string) error { return removeTree(dst) }

// removeTree removes a staged copy. The copy keeps the source's modes, so a read-only directory (a skill pack's, the
// Nix store's) refuses its entries' removal to a backup that doesn't run as root; those directories are made
// writable for their owner first, and only when the plain removal was refused.
func removeTree(dst string) error {
	err := os.RemoveAll(dst)
	if err == nil || !errors.Is(err, os.ErrPermission) {
		return err
	}
	_ = filepath.WalkDir(dst, func(path string, d fs.DirEntry, werr error) error {
		if werr == nil && d.IsDir() {
			if info, ierr := d.Info(); ierr == nil && info.Mode().Perm()&0o200 == 0 {
				_ = os.Chmod(path, info.Mode().Perm()|0o700)
			}
		}
		return nil
	})
	return os.RemoveAll(dst)
}

// CopyTree copies src (a file or a directory tree) to dst, preserving modes, times and (as root) owners,
// cloning extents where the filesystem can (btrfs, also across subvolumes). dst must not exist.
func CopyTree(ctx context.Context, src, dst string) error { return copyTree(ctx, src, dst, true) }

func copyTree(ctx context.Context, src, dst string, clone bool) error {
	root := os.Geteuid() == 0
	type dirMeta struct {
		path string
		fi   os.FileInfo
	}
	var dirs []dirMeta
	err := filepath.WalkDir(src, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		rel, _ := filepath.Rel(src, p)
		out := filepath.Join(dst, rel)
		fi, err := d.Info()
		if err != nil {
			return err
		}
		switch {
		case d.IsDir():
			if err := os.Mkdir(out, 0o700); err != nil && !os.IsExist(err) {
				return err
			}
			dirs = append(dirs, dirMeta{out, fi})
			return nil
		case d.Type()&fs.ModeSymlink != 0:
			target, err := os.Readlink(p)
			if err != nil {
				return err
			}
			if err := os.Symlink(target, out); err != nil {
				return err
			}
		case d.Type().IsRegular():
			if err := copyFile(p, out, fi, clone); err != nil {
				return err
			}
		default:
			return nil // sockets, fifos, devices: not data
		}
		if root {
			if st, ok := fi.Sys().(*syscall.Stat_t); ok {
				if err := os.Lchown(out, int(st.Uid), int(st.Gid)); err != nil {
					return err
				}
			}
		}
		if d.Type()&fs.ModeSymlink == 0 {
			ts := []unix.Timespec{unix.NsecToTimespec(fi.ModTime().UnixNano()), unix.NsecToTimespec(fi.ModTime().UnixNano())}
			_ = unix.UtimesNanoAt(unix.AT_FDCWD, out, ts, unix.AT_SYMLINK_NOFOLLOW)
		}
		return nil
	})
	if err != nil {
		return err
	}
	for i := len(dirs) - 1; i >= 0; i-- {
		d := dirs[i]
		if root {
			if st, ok := d.fi.Sys().(*syscall.Stat_t); ok {
				_ = os.Lchown(d.path, int(st.Uid), int(st.Gid))
			}
		}
		_ = os.Chmod(d.path, d.fi.Mode().Perm()|(d.fi.Mode()&(fs.ModeSetgid|fs.ModeSticky)))
		ts := []unix.Timespec{unix.NsecToTimespec(d.fi.ModTime().UnixNano()), unix.NsecToTimespec(d.fi.ModTime().UnixNano())}
		_ = unix.UtimesNanoAt(unix.AT_FDCWD, d.path, ts, 0)
	}
	return nil
}

func copyFile(src, dst string, fi os.FileInfo, clone bool) error {
	// Never through a symlink swapped in after the walk saw a file (as root this would copy another file).
	in, err := os.OpenFile(src, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		return err
	}
	defer in.Close()
	if st, err := in.Stat(); err != nil || !st.Mode().IsRegular() || !os.SameFile(st, fi) {
		return fmt.Errorf("%s changed while it was copied", src)
	}
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL, fi.Mode().Perm()|0o200)
	if err != nil {
		return err
	}
	if !clone || unix.IoctlFileClone(int(out.Fd()), int(in.Fd())) != nil {
		if _, err := io.Copy(out, in); err != nil {
			out.Close()
			return err
		}
	}
	if err := out.Close(); err != nil {
		return err
	}
	return os.Chmod(dst, fi.Mode().Perm())
}
