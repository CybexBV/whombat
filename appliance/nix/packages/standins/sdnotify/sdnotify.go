// Package sdnotify sends sd_notify(3) datagrams to $NOTIFY_SOCKET.
package sdnotify

import (
	"net"
	"os"
	"strconv"
	"time"
)

// Send sends state (e.g. "READY=1") if NOTIFY_SOCKET is set.
func Send(state string) error {
	p := os.Getenv("NOTIFY_SOCKET")
	if p == "" {
		return nil
	}
	if p[0] == '@' {
		p = "\x00" + p[1:]
	}
	c, err := net.DialUnix("unixgram", nil, &net.UnixAddr{Name: p, Net: "unixgram"})
	if err != nil {
		return err
	}
	defer c.Close()
	_, err = c.Write([]byte(state))
	return err
}

// WatchdogInterval returns half of WATCHDOG_USEC, or 0 when no watchdog is armed for this process.
func WatchdogInterval() time.Duration {
	us, err := strconv.ParseInt(os.Getenv("WATCHDOG_USEC"), 10, 64)
	if err != nil || us <= 0 {
		return 0
	}
	if pid := os.Getenv("WATCHDOG_PID"); pid != "" && pid != strconv.Itoa(os.Getpid()) {
		return 0
	}
	return time.Duration(us) * time.Microsecond / 2
}
