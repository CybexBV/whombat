package envmove

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"syscall"

	"github.com/CybexBV/whombat/appliance/helper/pkg/atomicfile"
)

// Copying the Link and own-address state between the manager's folder and the move's (MG-179). On an installed box
// /persist/manager is a btrfs subvolume of its own and the moves folder is in /persist's top subvolume, so nothing is
// ever renamed from one to the other: a folder is copied under a temporary name beside its destination, checked against
// its source, renamed to its own name in the same folder, and only then is the source removed. Every step can run again
// after a stop: a temporary copy is made again, a finished copy is never made twice, a source already gone isn't missed.

const (
	// copyingSuffix names a copy into the move's folder that isn't checked yet.
	copyingSuffix = ".copying"
	// restoringPrefix names a copy back into the manager's folder that isn't checked yet (".link.restoring").
	restoringPrefix = "."
	restoringSuffix = ".restoring"
)

// renameHook, when set (tests), is asked before every rename the move makes; an error stops the rename. The tests make
// it refuse a rename across the manager's folder and the moves folder with EXDEV, as two subvolumes do.
var renameHook func(oldpath, newpath string) error

func rename(oldpath, newpath string) error {
	if renameHook != nil {
		if err := renameHook(oldpath, newpath); err != nil {
			return &os.LinkError{Op: "rename", Old: oldpath, New: newpath, Err: err}
		}
	}
	return os.Rename(oldpath, newpath)
}

func exists(p string) (bool, error) {
	_, err := os.Lstat(p)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	return err == nil, err
}

// treeSize is about what a copy of the folder at p takes: its files' sizes and a block for every entry. A missing
// folder is 0; anything but files, folders and links is refused (the state has nothing else, and a copy couldn't keep
// it).
func treeSize(p string) (int64, error) {
	var n int64
	err := filepath.WalkDir(p, func(path string, d fs.DirEntry, err error) error {
		if errors.Is(err, os.ErrNotExist) && path == p {
			return filepath.SkipAll
		}
		if err != nil {
			return err
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		switch {
		case info.Mode().IsRegular():
			n += info.Size()
		case info.IsDir(), info.Mode()&os.ModeSymlink != 0:
		default:
			return fmt.Errorf("%s is neither a file, a folder nor a link", path)
		}
		n += 4096
		return nil
	})
	return n, err
}

// owner is a file's owner and group.
func owner(info os.FileInfo) (int, int) {
	if st, ok := info.Sys().(*syscall.Stat_t); ok {
		return int(st.Uid), int(st.Gid)
	}
	return -1, -1
}

// copyTree copies the folder src to dst, which must not exist: files with their bytes, modes, owners and times,
// folders with their modes and owners, links as links; every file and folder synced, then dst's parent. hook(step) runs
// after each file is written (tests stop there, as a crash would).
func copyTree(src, dst, step string) error {
	var dirs []string // in walk order: set their modes and sync them deepest first
	err := filepath.WalkDir(src, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		target := filepath.Join(dst, rel)
		info, err := d.Info()
		if err != nil {
			return err
		}
		uid, gid := owner(info)
		switch {
		case info.IsDir():
			if err := os.Mkdir(target, 0o700); err != nil {
				return err
			}
			dirs = append(dirs, path)
		case info.Mode()&os.ModeSymlink != 0:
			link, err := os.Readlink(path)
			if err != nil {
				return err
			}
			if err := os.Symlink(link, target); err != nil {
				return err
			}
			if err := os.Lchown(target, uid, gid); err != nil {
				return err
			}
		case info.Mode().IsRegular():
			if err := copyFile(path, target, info, uid, gid); err != nil {
				return err
			}
			if err := hook(step); err != nil {
				return err
			}
		default:
			return fmt.Errorf("%s is neither a file, a folder nor a link", path)
		}
		return nil
	})
	if err != nil {
		return err
	}
	for i := len(dirs) - 1; i >= 0; i-- {
		rel, _ := filepath.Rel(src, dirs[i])
		target := filepath.Join(dst, rel)
		info, err := os.Lstat(dirs[i])
		if err != nil {
			return err
		}
		uid, gid := owner(info)
		if err := os.Lchown(target, uid, gid); err != nil {
			return err
		}
		if err := os.Chmod(target, info.Mode()&(os.ModePerm|os.ModeSetuid|os.ModeSetgid|os.ModeSticky)); err != nil {
			return err
		}
		if err := atomicfile.SyncDir(target); err != nil {
			return err
		}
		_ = os.Chtimes(target, info.ModTime(), info.ModTime())
	}
	return atomicfile.SyncDir(filepath.Dir(dst))
}

func copyFile(src, dst string, info os.FileInfo, uid, gid int) error {
	in, err := os.OpenFile(src, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL|syscall.O_NOFOLLOW, 0o600)
	if err != nil {
		return err
	}
	_, cerr := io.Copy(out, in)
	errs := []error{cerr, out.Chown(uid, gid), out.Chmod(info.Mode() & (os.ModePerm | os.ModeSetuid | os.ModeSetgid | os.ModeSticky))}
	errs = append(errs, out.Sync(), out.Close())
	if err := errors.Join(errs...); err != nil {
		return err
	}
	return os.Chtimes(dst, info.ModTime(), info.ModTime())
}

// sameTree checks that the folders a and b hold the same: the same names, kinds, modes and owners, the same bytes in
// every file, the same target of every link.
func sameTree(a, b string) error {
	count := 0
	err := filepath.WalkDir(a, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		count++
		rel, err := filepath.Rel(a, path)
		if err != nil {
			return err
		}
		other := filepath.Join(b, rel)
		ia, err := os.Lstat(path)
		if err != nil {
			return err
		}
		ib, err := os.Lstat(other)
		if err != nil {
			return fmt.Errorf("%s: %w", rel, err)
		}
		ua, ga := owner(ia)
		ub, gb := owner(ib)
		if ia.Mode() != ib.Mode() || ua != ub || ga != gb {
			return fmt.Errorf("%s: %v %d:%d, the copy %v %d:%d", rel, ia.Mode(), ua, ga, ib.Mode(), ub, gb)
		}
		switch {
		case ia.Mode()&os.ModeSymlink != 0:
			la, err1 := os.Readlink(path)
			lb, err2 := os.Readlink(other)
			if err := errors.Join(err1, err2); err != nil {
				return err
			}
			if la != lb {
				return fmt.Errorf("%s: the link points elsewhere", rel)
			}
		case ia.Mode().IsRegular():
			if ia.Size() != ib.Size() {
				return fmt.Errorf("%s: %d bytes, the copy %d", rel, ia.Size(), ib.Size())
			}
			if err := sameBytes(path, other); err != nil {
				return fmt.Errorf("%s: %w", rel, err)
			}
		}
		return nil
	})
	if err != nil {
		return err
	}
	// Nothing more in b than in a.
	others := 0
	if err := filepath.WalkDir(b, func(_ string, _ fs.DirEntry, err error) error {
		others++
		return err
	}); err != nil {
		return err
	}
	if others != count {
		return fmt.Errorf("the copy has %d entries, the original %d", others, count)
	}
	return nil
}

func sameBytes(a, b string) error {
	fa, err := os.Open(a)
	if err != nil {
		return err
	}
	defer fa.Close()
	fb, err := os.Open(b)
	if err != nil {
		return err
	}
	defer fb.Close()
	ba, bb := make([]byte, 64<<10), make([]byte, 64<<10)
	for {
		na, ea := io.ReadFull(fa, ba)
		nb, eb := io.ReadFull(fb, bb)
		if !bytes.Equal(ba[:na], bb[:nb]) {
			return errors.New("the bytes differ")
		}
		if ea == io.EOF || ea == io.ErrUnexpectedEOF {
			if eb != io.EOF && eb != io.ErrUnexpectedEOF {
				return errors.New("the copy is longer")
			}
			return nil
		}
		if ea != nil {
			return ea
		}
		if eb != nil {
			return eb
		}
	}
}

// copyChecked copies src to dst through dst's temporary name tmp (a stale one is removed first), checks the copy, then
// renames it to dst in the same folder and syncs that folder.
func copyChecked(src, tmp, dst, step string) error {
	if err := os.RemoveAll(tmp); err != nil {
		return err
	}
	if err := hook(step + ":copy"); err != nil {
		return err
	}
	if err := copyTree(src, tmp, step+":copying"); err != nil {
		return err
	}
	if err := sameTree(src, tmp); err != nil {
		return fmt.Errorf("the copy of %s doesn't match it: %w", src, err)
	}
	if err := rename(tmp, dst); err != nil {
		return err
	}
	return atomicfile.SyncDir(filepath.Dir(dst))
}

// removeTree removes p (gone already is fine) and syncs its folder.
func removeTree(p, step string) error {
	if err := hook(step + ":remove"); err != nil {
		return err
	}
	if err := os.RemoveAll(p); err != nil {
		return err
	}
	return atomicfile.SyncDir(filepath.Dir(p))
}

// setAside takes the manager's folder name into the move's folder: copied and checked (unless a finished copy is there
// already), then the original removed.
func setAside(p Paths, dir, name string) error {
	src, dst := filepath.Join(p.ManagerDir, name), filepath.Join(dir, name)
	done, err := exists(dst)
	if err != nil {
		return err
	}
	if !done {
		there, err := exists(src)
		if err != nil || !there {
			return err // nothing to take (a copy that isn't finished never removed the original)
		}
		if err := copyChecked(src, dst+copyingSuffix, dst, "aside:"+name); err != nil {
			return err
		}
	}
	return removeTree(src, "aside:"+name)
}

// putBack brings the move's copy of name back where the manager reads it, unless what is there is that copy already: a
// copy checked under a temporary name, what is there removed, the copy renamed into its place. A move that never set
// name aside leaves it alone.
func putBack(p Paths, dir, name string) error {
	src, dst := filepath.Join(dir, name), filepath.Join(p.ManagerDir, name)
	tmp := filepath.Join(p.ManagerDir, restoringPrefix+name+restoringSuffix)
	if err := os.RemoveAll(src + copyingSuffix); err != nil {
		return err
	}
	there, err := exists(src)
	if err != nil || !there {
		return errors.Join(err, os.RemoveAll(tmp))
	}
	if cur, err := exists(dst); err != nil {
		return err
	} else if cur && sameTree(src, dst) == nil {
		return os.RemoveAll(tmp)
	}
	if err := os.RemoveAll(tmp); err != nil {
		return err
	}
	if err := hook("restore:" + name + ":copy"); err != nil {
		return err
	}
	if err := copyTree(src, tmp, "restore:"+name+":copying"); err != nil {
		return err
	}
	if err := sameTree(src, tmp); err != nil {
		return fmt.Errorf("the copy of %s doesn't match it: %w", src, err)
	}
	if err := removeTree(dst, "restore:"+name); err != nil {
		return err
	}
	if err := rename(tmp, dst); err != nil {
		return err
	}
	return atomicfile.SyncDir(p.ManagerDir)
}

// keepAfter takes what the manager made since the move (name in its folder) into the move's after/ before the undo puts
// the move's copy back: copied and checked, then removed. Nothing to keep when the manager's folder has none, when it is
// the move's copy already (put back by an undo that stopped), or when after/ has it and only the removal is left.
func keepAfter(p Paths, dir, name string) error {
	cur := filepath.Join(p.ManagerDir, name)
	kept := filepath.Join(dir, afterDir, name)
	there, err := exists(cur)
	if err != nil || !there {
		return err
	}
	moved := filepath.Join(dir, name)
	if ok, err := exists(moved); err != nil {
		return err
	} else if ok && sameTree(moved, cur) == nil {
		return nil
	}
	if done, err := exists(kept); err != nil {
		return err
	} else if !done {
		if err := os.MkdirAll(filepath.Join(dir, afterDir), 0o700); err != nil {
			return err
		}
		if err := copyChecked(cur, kept+copyingSuffix, kept, "after:"+name); err != nil {
			return err
		}
	}
	return removeTree(cur, "after:"+name)
}
