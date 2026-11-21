package state

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"golang.org/x/sys/unix"
)

// Root mode (BK-26): a whombat-backup run as root (the console restore of BK-24, the disk helper) works in
// /persist/backup, a directory the backup user writes. Whatever that user planted there — a symlinked
// directory, file, lock or temp name, a hard link — must never make root write, create, chown or read
// another file. In root mode every state file under the state directory is reached component by component
// from the (root-owned) state directory with O_NOFOLLOW, checked (a regular file or directory owned by root
// or the backup user, one link), created only with O_EXCL under a random name, handed to the backup user
// with fchown, and renamed into place on the directory's descriptor. Secrets come only from a private
// directory on /run that root filled (MaterializeForRoot), never from the backup user's files by path.
// Everything else the CLI does as root runs in a child process as the backup user.
var root = struct {
	on       bool
	uid, gid int    // the backup user: owner of what root writes
	base     string // the state directory
}{}

// EnterRootMode switches the state package to root mode for c (see above).
func EnterRootMode(c *Config, uid, gid int) {
	root.on, root.uid, root.gid, root.base = true, uid, gid, filepath.Clean(c.StateDir)
}

// InRootMode says whether root mode is on.
func InRootMode() bool { return root.on }

// ErrUnsafe is a state path root refuses to use.
var ErrUnsafe = errors.New("refusing to use a state file root doesn't control")

func unsafeErr(path, why string) error { return fmt.Errorf("%w: %s %s", ErrUnsafe, path, why) }

// rel splits path into its components below the state directory.
func rel(path string) ([]string, error) {
	r, err := filepath.Rel(root.base, filepath.Clean(path))
	if err != nil || r == "." || r == ".." || strings.HasPrefix(r, "../") || filepath.IsAbs(r) {
		return nil, unsafeErr(path, "is outside the state directory")
	}
	return strings.Split(r, "/"), nil
}

// checkFD accepts only what root or the backup user owns, of the expected type, with one link (files).
func checkFD(fd int, path string, dir bool) error {
	var st unix.Stat_t
	if err := unix.Fstat(fd, &st); err != nil {
		return err
	}
	switch {
	case dir && st.Mode&unix.S_IFMT != unix.S_IFDIR:
		return unsafeErr(path, "is not a directory")
	case !dir && st.Mode&unix.S_IFMT != unix.S_IFREG:
		return unsafeErr(path, "is not a regular file")
	case !dir && st.Nlink != 1:
		return unsafeErr(path, "has other hard links")
	case int(st.Uid) != 0 && int(st.Uid) != root.uid:
		return unsafeErr(path, fmt.Sprintf("is owned by uid %d", st.Uid))
	}
	return nil
}

// openBase opens the state directory itself.
func openBase() (int, error) {
	fd, err := unix.Open(root.base, unix.O_DIRECTORY|unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return -1, fmt.Errorf("%s: %w", root.base, err)
	}
	return fd, nil
}

// openDir opens dirs (components below the state directory) without following a symlink; create makes
// missing ones (0700, the backup user's).
func openDir(dirs []string, create bool) (int, error) {
	fd, err := openBase()
	if err != nil {
		return -1, err
	}
	path := root.base
	for _, d := range dirs {
		path = filepath.Join(path, d)
		next, err := unix.Openat(fd, d, unix.O_DIRECTORY|unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
		if errors.Is(err, unix.ENOENT) && create {
			if err = unix.Mkdirat(fd, d, 0o700); err == nil || errors.Is(err, unix.EEXIST) {
				next, err = unix.Openat(fd, d, unix.O_DIRECTORY|unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
				if err == nil {
					_ = unix.Fchown(next, root.uid, root.gid)
				}
			}
		}
		unix.Close(fd)
		if errors.Is(err, unix.ELOOP) || errors.Is(err, unix.ENOTDIR) {
			return -1, unsafeErr(path, "is a symlink or not a directory")
		}
		if err != nil {
			return -1, fmt.Errorf("%s: %w", path, err)
		}
		if err := checkFD(next, path, true); err != nil {
			unix.Close(next)
			return -1, err
		}
		fd = next
	}
	return fd, nil
}

func randName() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return ".tmp-" + hex.EncodeToString(b)
}

// rootWrite is WriteFileAtomic in root mode.
func rootWrite(path string, b []byte, mode os.FileMode) error {
	parts, err := rel(path)
	if err != nil {
		return err
	}
	dfd, err := openDir(parts[:len(parts)-1], true)
	if err != nil {
		return err
	}
	defer unix.Close(dfd)
	name, tmp := parts[len(parts)-1], randName()
	fd, err := unix.Openat(dfd, tmp, unix.O_WRONLY|unix.O_CREAT|unix.O_EXCL|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0o600)
	if err != nil {
		return fmt.Errorf("%s: %w", path, err)
	}
	f := os.NewFile(uintptr(fd), path)
	ok := false
	defer func() {
		if !ok {
			f.Close()
			_ = unix.Unlinkat(dfd, tmp, 0)
		}
	}()
	if err := f.Chown(root.uid, root.gid); err != nil {
		return err
	}
	if _, err := f.Write(b); err != nil {
		return err
	}
	if err := f.Chmod(mode); err != nil {
		return err
	}
	if err := f.Sync(); err != nil {
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	if err := unix.Renameat(dfd, tmp, dfd, name); err != nil {
		return fmt.Errorf("%s: %w", path, err)
	}
	ok = true
	_ = unix.Fsync(dfd)
	return nil
}

// rootOpen opens a state file for a lock or an append (created when missing, the backup user's).
func rootOpen(path string, flags int) (*os.File, error) {
	parts, err := rel(path)
	if err != nil {
		return nil, err
	}
	dfd, err := openDir(parts[:len(parts)-1], true)
	if err != nil {
		return nil, err
	}
	defer unix.Close(dfd)
	fd, err := unix.Openat(dfd, parts[len(parts)-1], flags|unix.O_CREAT|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0o600)
	if errors.Is(err, unix.ELOOP) {
		return nil, unsafeErr(path, "is a symlink")
	}
	if err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	if err := checkFD(fd, path, false); err != nil {
		unix.Close(fd)
		return nil, err
	}
	_ = unix.Fchown(fd, root.uid, root.gid)
	return os.NewFile(uintptr(fd), path), nil
}

// RemoveStateFile removes a state file (in root mode on the directory's descriptor, never through a
// symlinked directory).
func RemoveStateFile(path string) error {
	if !root.on {
		return os.Remove(path)
	}
	parts, err := rel(path)
	if err != nil {
		return err
	}
	dfd, err := openDir(parts[:len(parts)-1], false)
	if err != nil {
		return err
	}
	defer unix.Close(dfd)
	return unix.Unlinkat(dfd, parts[len(parts)-1], 0)
}

// maxStateFile bounds what root reads from a state file.
const maxStateFile = 4 << 20

// ReadStateFile reads a state file: in root mode without following a symlink, only a regular file of
// root or the backup user (os.ErrNotExist when absent); otherwise a plain read.
func ReadStateFile(path string) ([]byte, error) {
	if !root.on {
		return os.ReadFile(path)
	}
	parts, err := rel(path)
	if err != nil {
		return nil, err
	}
	dfd, err := openDir(parts[:len(parts)-1], false)
	if err != nil {
		if errors.Is(err, unix.ENOENT) {
			return nil, os.ErrNotExist
		}
		return nil, err
	}
	defer unix.Close(dfd)
	fd, err := unix.Openat(dfd, parts[len(parts)-1], unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
	switch {
	case errors.Is(err, unix.ENOENT):
		return nil, os.ErrNotExist
	case errors.Is(err, unix.ELOOP):
		return nil, unsafeErr(path, "is a symlink")
	case err != nil:
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	f := os.NewFile(uintptr(fd), path)
	defer f.Close()
	if err := checkFD(fd, path, false); err != nil {
		return nil, err
	}
	b, err := io.ReadAll(io.LimitReader(f, maxStateFile+1))
	if err != nil {
		return nil, err
	}
	if len(b) > maxStateFile {
		return nil, unsafeErr(path, "is too large")
	}
	return b, nil
}

// MaterializeForRoot fills a private directory on /run (created by root, 0700) with every secret a root run
// may need — the value the backup service wrote since the last seal (read without following a symlink), or
// the sealed credential decrypted with systemd-creds from the root-only sealed directory — plus the
// destination's CA certificate, and makes it the run's only source of secrets (c.RuntimeDir). The returned
// function removes it. Root mode must be on.
func MaterializeForRoot(c *Config, systemdCreds string) (func(), error) {
	if !root.on {
		return func() {}, errors.New("MaterializeForRoot needs root mode")
	}
	if systemdCreds == "" {
		systemdCreds = "systemd-creds"
	}
	run := c.RunDir
	if run == "" {
		run = "/run"
	}
	dir, err := os.MkdirTemp(run, "whombat-backup-cli-")
	if err != nil {
		return func() {}, err
	}
	done := func() { _ = os.RemoveAll(dir) }
	put := func(name string, b []byte) error {
		return os.WriteFile(filepath.Join(dir, name), b, 0o400)
	}
	for _, name := range SecretNames() {
		cred := secretCreds[name]
		b, err := ReadStateFile(c.SecretWritePath(name))
		switch {
		case err == nil: // written since the last seal: it wins (empty = cleared)
			if len(strings.TrimSpace(string(b))) > 0 {
				if err := put(cred, b); err != nil {
					done()
					return func() {}, err
				}
			}
			continue
		case !errors.Is(err, os.ErrNotExist):
			done()
			return func() {}, err
		}
		sealed := c.SealedPath(name)
		if fi, err := os.Lstat(sealed); err != nil || !fi.Mode().IsRegular() || fi.Size() == 0 {
			continue
		}
		out := filepath.Join(dir, cred)
		cmd := exec.Command(systemdCreds, "decrypt", "--name="+cred, sealed, out)
		if b, err := cmd.CombinedOutput(); err != nil {
			done()
			return func() {}, fmt.Errorf("unseal %s: %v: %s", name, err, strings.TrimSpace(string(b)))
		}
		_ = os.Chmod(out, 0o400)
	}
	if b, err := ReadStateFile(c.CACertPath()); err == nil {
		if err := put("ca.pem", b); err != nil {
			done()
			return func() {}, err
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		done()
		return func() {}, err
	}
	c.RuntimeDir = dir
	runtimeDirs = append(runtimeDirs, filepath.Clean(dir))
	return done, nil
}

// HandOver gives the materialized directory to the backup user (a child run as that user reads it).
func HandOver(c *Config) error {
	if c.RuntimeDir == "" {
		return nil
	}
	ents, err := os.ReadDir(c.RuntimeDir)
	if err != nil {
		return err
	}
	for _, e := range ents {
		if err := os.Lchown(filepath.Join(c.RuntimeDir, e.Name()), root.uid, root.gid); err != nil {
			return err
		}
	}
	return os.Lchown(c.RuntimeDir, root.uid, root.gid)
}
