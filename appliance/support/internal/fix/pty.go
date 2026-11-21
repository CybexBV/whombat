package fix

import (
	"os"
	"strconv"

	"golang.org/x/sys/unix"
)

// openPTY opens a pseudo terminal with x/sys/unix (no PTY library): the master is non-blocking and in Go's poller, so
// closing it or a read deadline ends a blocked Read; the slave is what the child gets as its terminal.
func openPTY() (master, slave *os.File, err error) {
	fd, err := unix.Open("/dev/ptmx", unix.O_RDWR|unix.O_NOCTTY|unix.O_CLOEXEC|unix.O_NONBLOCK, 0)
	if err != nil {
		return nil, nil, err
	}
	if err := unix.IoctlSetPointerInt(fd, unix.TIOCSPTLCK, 0); err != nil {
		unix.Close(fd)
		return nil, nil, err
	}
	n, err := unix.IoctlGetUint32(fd, unix.TIOCGPTN)
	if err != nil {
		unix.Close(fd)
		return nil, nil, err
	}
	master = os.NewFile(uintptr(fd), "/dev/ptmx")
	slave, err = os.OpenFile("/dev/pts/"+strconv.FormatUint(uint64(n), 10), os.O_RDWR|unix.O_NOCTTY|unix.O_CLOEXEC, 0)
	if err != nil {
		master.Close()
		return nil, nil, err
	}
	return master, slave, nil
}

// setWindow sets the terminal's size (0 leaves the kernel's default).
func setWindow(master *os.File, w Window) {
	rc, err := master.SyscallConn()
	if err != nil {
		return
	}
	_ = rc.Control(func(fd uintptr) {
		_ = unix.IoctlSetWinsize(int(fd), unix.TIOCSWINSZ, &unix.Winsize{Row: w.Rows, Col: w.Cols})
	})
}
