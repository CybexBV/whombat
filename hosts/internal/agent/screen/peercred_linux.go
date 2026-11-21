package screen

import (
	"net"

	"golang.org/x/sys/unix"
)

// peerUID is the user id of the process at the other end of a Unix socket.
func peerUID(c *net.UnixConn) (int, error) {
	raw, err := c.SyscallConn()
	if err != nil {
		return -1, err
	}
	uid := -1
	var cerr error
	err = raw.Control(func(fd uintptr) {
		var cred *unix.Ucred
		cred, cerr = unix.GetsockoptUcred(int(fd), unix.SOL_SOCKET, unix.SO_PEERCRED)
		if cerr == nil {
			uid = int(cred.Uid)
		}
	})
	if err != nil {
		return -1, err
	}
	return uid, cerr
}

// peerPID is the process at the other end of a Unix socket (SO_PEERCRED).
func peerPID(c *net.UnixConn) (int, error) {
	raw, err := c.SyscallConn()
	if err != nil {
		return -1, err
	}
	pid := -1
	var cerr error
	err = raw.Control(func(fd uintptr) {
		var cred *unix.Ucred
		cred, cerr = unix.GetsockoptUcred(int(fd), unix.SOL_SOCKET, unix.SO_PEERCRED)
		if cerr == nil {
			pid = int(cred.Pid)
		}
	})
	if err != nil {
		return -1, err
	}
	return pid, cerr
}
