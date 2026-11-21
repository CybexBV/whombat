package relay

import (
	"bytes"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

// TestKernel runs the relay between two real network namespaces: the test binary again under `unshare -rn` (a user
// namespace of its own, root in it, and a network namespace it owns: the “host”), where one thread makes a second
// network namespace (the “kiosk's”). Skipped where user namespaces aren't allowed.
func TestKernel(t *testing.T) {
	if os.Getenv("WHOMBAT_RELAY_NS") != "1" {
		unshare, err := exec.LookPath("unshare")
		if err != nil {
			t.Skip("no unshare")
		}
		if out, err := exec.Command(unshare, "-rn", "true").CombinedOutput(); err != nil {
			t.Skipf("no user and network namespaces here: %v %s", err, out)
		}
		cmd := exec.Command(unshare, "-rn", os.Args[0], "-test.run=^TestKernel$", "-test.v", "-test.count=1")
		cmd.Env = append(os.Environ(), "WHOMBAT_RELAY_NS=1")
		out, err := cmd.CombinedOutput()
		t.Logf("in the namespaces:\n%s", out)
		if err != nil {
			t.Fatal(err)
		}
		return
	}

	// The host: udevd's group as whombat-kiosk-udev-host.socket binds it, and a sender standing in for udevd.
	host := file(t, nlSocket(t, udevMask), "host")
	udevd := nlSocket(t, 0)
	// The kiosk's namespace: the relay's socket there (no group) and a listener as libudev makes one.
	type kioskSide struct {
		send, listen int
		err          error
	}
	ch := make(chan kioskSide)
	go func() {
		// Never unlocked: the thread ends with this goroutine, in the other namespace.
		runtime.LockOSThread()
		if err := unix.Unshare(unix.CLONE_NEWNET); err != nil {
			ch <- kioskSide{err: err}
			return
		}
		var k kioskSide
		if k.send, k.err = socketErr(0); k.err == nil {
			k.listen, k.err = socketErr(udevMask)
		}
		ch <- k
	}()
	k := <-ch
	if k.err != nil {
		t.Fatal(k.err)
	}
	kiosk := file(t, k.send, "kiosk")
	if err := unix.SetsockoptInt(k.listen, unix.SOL_SOCKET, unix.SO_PASSCRED, 1); err != nil {
		t.Fatal(err)
	}
	if err := unix.SetsockoptTimeval(k.listen, unix.SOL_SOCKET, unix.SO_RCVTIMEO, &unix.Timeval{Sec: 2}); err != nil {
		t.Fatal(err)
	}

	// Sockets it can't work with.
	same := file(t, nlSocket(t, 0), "same")
	if err := Check(host, same); err == nil || !strings.Contains(err.Error(), "one network namespace") {
		t.Fatalf("one namespace: %v", err)
	}
	if err := Check(kiosk, host); err == nil {
		t.Fatal("swapped sockets passed")
	}
	if err := Check(host, kiosk); err != nil {
		t.Fatal(err)
	}

	var mu sync.Mutex
	var logged []string
	r := &Relay{From: host, To: kiosk, Subsystems: []string{"input"}, Log: func(s string) {
		mu.Lock()
		logged = append(logged, s)
		mu.Unlock()
	}}
	done := make(chan error, 1)
	go func() { done <- r.Run() }()

	// A disk, then the keyboard: only the keyboard reaches the kiosk's namespace, byte for byte, sent by root.
	kbd := message(keyboard...)
	for _, m := range [][]byte{message("ACTION=add", "SUBSYSTEM=block", "DEVNAME=/dev/sda"), kbd} {
		if err := unix.Sendmsg(udevd, m, nil, &unix.SockaddrNetlink{Family: unix.AF_NETLINK, Groups: udevMask}, 0); err != nil {
			t.Fatal(err)
		}
	}
	buf := make([]byte, MaxMessage)
	oob := make([]byte, unix.CmsgSpace(unix.SizeofUcred))
	n, oobn, _, sa, err := unix.Recvmsg(k.listen, buf, oob, 0)
	if err != nil {
		t.Fatalf("nothing reached the kiosk's namespace: %v", err)
	}
	if !bytes.Equal(buf[:n], kbd) {
		t.Fatalf("got %q", buf[:n])
	}
	if nl, ok := sa.(*unix.SockaddrNetlink); !ok || nl.Groups != udevMask {
		t.Fatalf("not on udevd's group: %#v", sa)
	}
	if uid, err := senderUID(oob[:oobn]); err != nil || uid != 0 {
		t.Fatalf("sender %d %v", uid, err)
	}
	// The disk came first: had it been passed, it would have arrived first.
	select {
	case err := <-done:
		t.Fatalf("the relay ended: %v", err)
	default:
	}
	// The line comes once the send has returned, which may be after the listener got the message.
	for deadline := time.Now().Add(2 * time.Second); ; time.Sleep(10 * time.Millisecond) {
		mu.Lock()
		got := append([]string(nil), logged...)
		mu.Unlock()
		if len(got) == 1 && got[0] == "passed add event7" {
			break
		}
		if len(got) > 1 || time.Now().After(deadline) {
			t.Fatalf("logged %q", got)
		}
	}
}

// nlSocket is a uevent netlink socket in the calling thread's network namespace, bound to groups.
func nlSocket(t *testing.T, groups uint32) int {
	fd, err := socketErr(groups)
	if err != nil {
		t.Fatal(err)
	}
	return fd
}

func socketErr(groups uint32) (int, error) {
	fd, err := unix.Socket(unix.AF_NETLINK, unix.SOCK_RAW|unix.SOCK_CLOEXEC, unix.NETLINK_KOBJECT_UEVENT)
	if err != nil {
		return -1, err
	}
	if err := unix.Bind(fd, &unix.SockaddrNetlink{Family: unix.AF_NETLINK, Groups: groups}); err != nil {
		unix.Close(fd)
		return -1, err
	}
	return fd, nil
}

// file wraps fd as systemd's socket would arrive: non-blocking, in Go's poller.
func file(t *testing.T, fd int, name string) *os.File {
	if err := unix.SetNonblock(fd, true); err != nil {
		t.Fatal(err)
	}
	f := os.NewFile(uintptr(fd), name)
	t.Cleanup(func() { f.Close() })
	return f
}
