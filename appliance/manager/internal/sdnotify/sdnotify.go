// Package sdnotify implements the systemd notify protocol (READY, WATCHDOG, STATUS) without cgo.
package sdnotify

import (
	"net"
	"os"
	"strconv"
	"time"
)

// Notify sends state to $NOTIFY_SOCKET; it is a no-op outside systemd.
func Notify(state string) error {
	path := os.Getenv("NOTIFY_SOCKET")
	if path == "" {
		return nil
	}
	if path[0] == '@' {
		path = "\x00" + path[1:]
	}
	conn, err := net.DialUnix("unixgram", nil, &net.UnixAddr{Name: path, Net: "unixgram"})
	if err != nil {
		return err
	}
	defer conn.Close()
	_, err = conn.Write([]byte(state))
	return err
}

// Ready reports READY=1 with a status line.
func Ready(status string) error { return Notify("READY=1\nSTATUS=" + status) }

// Status updates the status line.
func Status(status string) error { return Notify("STATUS=" + status) }

// Watchdog pings the watchdog.
func Watchdog() error { return Notify("WATCHDOG=1") }

// WatchdogInterval returns half of $WATCHDOG_USEC for this process (0 if disabled).
func WatchdogInterval() time.Duration {
	if pid := os.Getenv("WATCHDOG_PID"); pid != "" && pid != strconv.Itoa(os.Getpid()) {
		return 0
	}
	us, err := strconv.ParseInt(os.Getenv("WATCHDOG_USEC"), 10, 64)
	if err != nil || us <= 0 {
		return 0
	}
	return time.Duration(us) * time.Microsecond / 2
}
