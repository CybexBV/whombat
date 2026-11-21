package pkgs

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
)

// Package locks: whether another program (an unattended upgrade, a person
// with apt) holds the package manager's lock now. A task waits for it up
// to LockWait seconds before each step (SWU-04); the managers' own lock
// waits (DPkg::Lock::Timeout, ZYPP_LOCK_TIMEOUT, apk --wait) cover the
// moment between the check and the command.

// fcntlLocks are files the manager locks with fcntl (apt, dpkg, rpm).
var fcntlLocks = map[string][]string{
	APT:    {"/var/lib/dpkg/lock-frontend", "/var/lib/dpkg/lock", "/var/lib/apt/lists/lock", "/var/cache/apt/archives/lock"},
	DNF:    {"/var/lib/rpm/.rpm.lock"},
	YUM:    {"/var/lib/rpm/.rpm.lock"},
	Zypper: {"/var/lib/rpm/.rpm.lock"},
}

// pidLocks are files holding the pid of the program that has the lock.
var pidLocks = map[string][]string{
	DNF:    {"/run/dnf.rpmdb.lock", "/run/dnf.metadata.lock", "/var/run/dnf.rpmdb.lock", "/var/run/dnf.metadata.lock"},
	YUM:    {"/var/run/yum.pid", "/run/yum.pid"},
	Zypper: {"/run/zypp.pid", "/var/run/zypp.pid"},
}

// lockRoot prefixes the paths (tests).
var lockRoot = ""

// LockHeld reports whether another program holds manager's package lock,
// and which file.
func LockHeld(manager string) (bool, string) {
	for _, p := range fcntlLocks[manager] {
		if fcntlHeld(lockRoot + p) {
			return true, p
		}
	}
	for _, p := range pidLocks[manager] {
		if pidFileLive(lockRoot + p) {
			return true, p
		}
	}
	switch manager {
	case APK:
		if p := "/lib/apk/db/lock"; flockHeld(lockRoot + p) {
			return true, p
		}
	case Pacman:
		// pacman leaves db.lck behind after a crash; pacman itself refuses
		// then too.
		if p := "/var/lib/pacman/db.lck"; exists(lockRoot + p) {
			return true, p
		}
	}
	return false, ""
}

// fcntlHeld tests for a conflicting write lock without taking one.
func fcntlHeld(p string) bool {
	f, err := os.Open(p)
	if err != nil {
		return false
	}
	defer f.Close()
	lk := syscall.Flock_t{Type: syscall.F_WRLCK, Whence: 0, Start: 0, Len: 0}
	if err := syscall.FcntlFlock(f.Fd(), syscall.F_GETLK, &lk); err != nil {
		return false
	}
	return lk.Type != syscall.F_UNLCK && int(lk.Pid) != os.Getpid()
}

// flockHeld tries an exclusive flock without waiting and lets it go.
func flockHeld(p string) bool {
	f, err := os.Open(p)
	if err != nil {
		return false
	}
	defer f.Close()
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return err == syscall.EWOULDBLOCK
	}
	_ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
	return false
}

// pidFileLive: the file names a running process other than this one.
func pidFileLive(p string) bool {
	b, err := os.ReadFile(p)
	if err != nil {
		return false
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(b)))
	if err != nil || pid <= 1 || pid == os.Getpid() {
		return false
	}
	_, err = os.Stat(filepath.Join("/proc", strconv.Itoa(pid)))
	return err == nil
}
