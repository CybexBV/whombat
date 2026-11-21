package screen

import (
	"encoding/binary"
	"errors"
	"fmt"
	"net"
	"os"
	"sync"
	"unsafe"

	"github.com/ebitengine/purego"
)

// Which process holds the other end of a Unix socket connection, as the
// kernel says: libproc's proc_pidinfo (a process's descriptors) and
// proc_pidfdinfo (one socket descriptor), called through purego (no cgo),
// as gopsutil does for proc_pidpath. Root may ask about any process.

// From macOS's <sys/proc_info.h> (macOS 27; the layout is the same on arm64
// and x86_64: fixed-size fields only).
const (
	procPIDListFDs      = 1   // PROC_PIDLISTFDS
	procPIDFDSocketInfo = 3   // PROC_PIDFDSOCKETINFO
	proxFDTypeSocket    = 2   // PROX_FDTYPE_SOCKET
	procFPShared        = 1   // PROC_FP_SHARED: the open file has other references
	sockInfoUN          = 3   // SOCKINFO_UN
	afUnix              = 1   // AF_UNIX
	procFDInfoSize      = 8   // struct proc_fdinfo {int32 fd; uint32 type}
	socketFDInfoSize    = 792 // struct socket_fdinfo
	offFiStatus         = 4   // pfi.fi_status
	offSoiSo            = 160 // psi.soi_so: the socket's handle
	offSoiFamily        = 184 // psi.soi_family
	offSoiKind          = 256 // psi.soi_kind
	offUnsiConnSo       = 264 // psi.soi_proto.pri_un.unsi_conn_so: the socket it is connected to
)

var libproc struct {
	once      sync.Once
	err       error
	pidinfo   func(pid, flavor int32, arg uint64, buf unsafe.Pointer, size int32) int32
	pidfdinfo func(pid, fd, flavor int32, buf unsafe.Pointer, size int32) int32
}

func loadLibproc() error {
	libproc.once.Do(func() {
		h, err := purego.Dlopen("/usr/lib/libSystem.B.dylib", purego.RTLD_LAZY|purego.RTLD_GLOBAL)
		if err != nil {
			libproc.err = err
			return
		}
		purego.RegisterLibFunc(&libproc.pidinfo, h, "proc_pidinfo")
		purego.RegisterLibFunc(&libproc.pidfdinfo, h, "proc_pidfdinfo")
	})
	return libproc.err
}

// unixSocket reads pid's descriptor fd; ok is false when it isn't a Unix
// socket.
func unixSocket(pid, fd int) (sock unixSock, ok bool, err error) {
	var buf [socketFDInfoSize]byte
	n := libproc.pidfdinfo(int32(pid), int32(fd), procPIDFDSocketInfo, unsafe.Pointer(&buf[0]), socketFDInfoSize)
	if n != socketFDInfoSize {
		return sock, false, fmt.Errorf("can't read descriptor %d of process %d", fd, pid)
	}
	le := binary.LittleEndian
	if int32(le.Uint32(buf[offSoiFamily:])) != afUnix || int32(le.Uint32(buf[offSoiKind:])) != sockInfoUN {
		return sock, false, nil
	}
	return unixSock{
		so:     le.Uint64(buf[offSoiSo:]),
		conn:   le.Uint64(buf[offUnsiConnSo:]),
		shared: le.Uint32(buf[offFiStatus:])&procFPShared != 0,
	}, true, nil
}

// connRefs lists pid's descriptors of the far end of the agent's connection
// c, each with whether its open file has other references.
func connRefs(c *net.UnixConn, pid int) ([]sockRef, error) {
	if err := loadLibproc(); err != nil {
		return nil, err
	}
	raw, err := c.SyscallConn()
	if err != nil {
		return nil, err
	}
	var near unixSock
	var nerr error
	if err := raw.Control(func(fd uintptr) {
		var ok bool
		near, ok, nerr = unixSocket(os.Getpid(), int(fd))
		if nerr == nil && !ok {
			nerr = errors.New("the agent's end isn't a Unix socket")
		}
	}); err != nil {
		return nil, err
	}
	if nerr != nil {
		return nil, nerr
	}
	if near.conn == 0 {
		return nil, errors.New("the connection has no other end")
	}
	return holderRefs(pid, near, func() ([]int, error) { return socketFDs(pid) },
		func(fd int) (unixSock, bool, error) { return unixSocket(pid, fd) })
}

// socketFDs lists pid's socket descriptors. The first call says how much
// room they need, a little more covers ones opened meanwhile.
func socketFDs(pid int) ([]int, error) {
	need := libproc.pidinfo(int32(pid), procPIDListFDs, 0, nil, 0)
	if need <= 0 {
		return nil, fmt.Errorf("can't list the descriptors of process %d", pid)
	}
	buf := make([]byte, int(need)+64*procFDInfoSize)
	n := libproc.pidinfo(int32(pid), procPIDListFDs, 0, unsafe.Pointer(&buf[0]), int32(len(buf)))
	if n <= 0 {
		return nil, fmt.Errorf("can't list the descriptors of process %d", pid)
	}
	var fds []int
	le := binary.LittleEndian
	for off := 0; off+procFDInfoSize <= int(n); off += procFDInfoSize {
		if le.Uint32(buf[off+4:]) == proxFDTypeSocket {
			fds = append(fds, int(int32(le.Uint32(buf[off:]))))
		}
	}
	return fds, nil
}
