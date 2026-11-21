package sdnotify

import (
	"net"
	"path/filepath"
	"testing"
	"time"
)

func TestNotify(t *testing.T) {
	p := filepath.Join(t.TempDir(), "n.sock")
	l, err := net.ListenUnixgram("unixgram", &net.UnixAddr{Name: p, Net: "unixgram"})
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	t.Setenv("NOTIFY_SOCKET", p)
	if err := Ready("up"); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 128)
	l.SetDeadline(time.Now().Add(time.Second))
	n, _ := l.Read(buf)
	if string(buf[:n]) != "READY=1\nSTATUS=up" {
		t.Fatalf("%q", buf[:n])
	}
	t.Setenv("WATCHDOG_USEC", "60000000")
	t.Setenv("WATCHDOG_PID", "")
	if WatchdogInterval() != 30*time.Second {
		t.Fatal(WatchdogInterval())
	}
}
