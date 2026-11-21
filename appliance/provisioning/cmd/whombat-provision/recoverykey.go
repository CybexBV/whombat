package main

// The disk recovery key of a self-installed appliance. Images since PI-19 create none; an appliance installed
// from an earlier image (PI-04, NX-53) may hold the Argon2id hash of one on /persist:
//
//	recovery-key check         the recovery menu and erase on host-encrypted storage: is the key on stdin the
//	                           one whose hash is on /persist? (exit 0 yes, 4 no, 1 error, e.g. no hash stored)
//	recovery-key drop-pending  whombat-recovery-key-drop.service (root, at boot): a key an earlier image left for
//	                           the console, never confirmed there, is removed with its hash. Nobody confirmed
//	                           writing it down, so it must not gate the recovery menu (PI-19, NX-90).

import (
	"bufio"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"syscall"

	"github.com/CybexBV/whombat/appliance/internal/recoverykey"
)

// ErrWrongKey: the typed key is not this appliance's disk recovery key (exit status 4).
var ErrWrongKey = errors.New("that is not this appliance's disk recovery key")

func cmdRecoveryKey(args []string) error {
	if len(args) < 1 {
		return errors.New("recovery-key check|drop-pending")
	}
	fs := flag.NewFlagSet("recovery-key "+args[0], flag.ExitOnError)
	persist := fs.String("persist", "/persist", "persistent-state mount point")
	hashFile := fs.String("hash-file", "", "the stored hash (default <persist>/"+recoverykey.HashFile+")")
	_ = fs.Parse(args[1:])
	if *hashFile == "" {
		*hashFile = filepath.Join(*persist, recoverykey.HashFile)
	}
	switch args[0] {
	case "check":
		line, err := bufio.NewReader(io.LimitReader(os.Stdin, 1024)).ReadString('\n')
		if err != nil && err != io.EOF {
			return err
		}
		return checkRecoveryKey(*hashFile, line)
	case "drop-pending":
		return dropPending(*persist, *hashFile)
	}
	return errors.New("recovery-key check|drop-pending")
}

// readHash reads the stored hash: a regular root-owned file that nobody else can write (a hash an
// unprivileged user could replace would let them pick the key).
func readHash(path string) (string, error) {
	f, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		if os.IsNotExist(err) {
			return "", fmt.Errorf("no disk recovery key is stored on this appliance (%s)", path)
		}
		return "", err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return "", err
	}
	if !st.Mode().IsRegular() || st.Mode().Perm()&0o022 != 0 {
		return "", fmt.Errorf("%s: not a regular file writable by root only", path)
	}
	if s, ok := st.Sys().(*syscall.Stat_t); ok && s.Uid != 0 && os.Geteuid() == 0 {
		return "", fmt.Errorf("%s: not owned by root", path)
	}
	b, err := io.ReadAll(io.LimitReader(f, 1024))
	return string(b), err
}

func checkRecoveryKey(hashFile, typed string) error {
	h, err := readHash(hashFile)
	if err != nil {
		return err
	}
	ok, err := recoverykey.Verify(h, typed)
	if err != nil {
		return err
	}
	if !ok {
		return ErrWrongKey
	}
	return nil
}

// dropPending removes the plaintext key an earlier image left for the console (zeroed first) and, with it, the
// hash of that key; its directory goes too when it is empty. A hash without a pending key was confirmed at the
// console and stays. Nothing pending: nothing to do.
func dropPending(persist, hashFile string) error {
	pending := filepath.Join(persist, recoverykey.PendingFile)
	st, err := os.Lstat(pending)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	if err := wipe(pending, int(min(st.Size(), 4096))); err != nil {
		return err
	}
	if err := os.Remove(hashFile); err != nil && !os.IsNotExist(err) {
		return err
	}
	_ = os.Remove(filepath.Join(persist, recoverykey.PendingDir)) // only when empty
	for _, d := range []string{persist, filepath.Dir(hashFile)} {
		if err := syncDir(d); err != nil {
			return err
		}
	}
	fmt.Println("removed a disk recovery key that was never confirmed at the console (this image shows none; PI-19)")
	return nil
}

// wipe overwrites the file with zeros and removes it. On btrfs (copy-on-write) and on a virtual disk the old
// blocks are not overwritten in place: the plaintext may stay in free space until it is reused (NX-55).
func wipe(path string, n int) error {
	if f, err := os.OpenFile(path, os.O_WRONLY|syscall.O_NOFOLLOW, 0); err == nil {
		_, _ = f.Write(make([]byte, n))
		_ = f.Sync()
		_ = f.Close()
	}
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

func syncDir(dir string) error {
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}
