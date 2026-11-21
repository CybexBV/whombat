package broker_test

import (
	"context"
	"errors"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/CybexBV/whombat/appliance/manager/internal/broker"
	"github.com/CybexBV/whombat/contracts/go/local"
)

// served: the broker answers HTTP on sock (a path that needs neither control nor the engine).
func served(t *testing.T, sock string) {
	t.Helper()
	resp, err := client(sock).Get("http://manager" + local.ManagerPathClients)
	if err != nil {
		t.Fatalf("not served: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound { // this appliance installs no clients
		t.Fatalf("status %d", resp.StatusCode)
	}
}

func gone(t *testing.T, sock string) {
	t.Helper()
	if _, err := os.Lstat(sock); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("socket file left behind: %v", err)
	}
}

// dir is a temporary directory with a short path (a socket path has at most 107 bytes).
func dir(t *testing.T) string {
	t.Helper()
	d, err := os.MkdirTemp("", "wbl")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Chmod(filepath.Join(d, "ro"), 0o700); os.RemoveAll(d) })
	return d
}

type serving struct {
	cancel context.CancelFunc
	done   chan error
}

func serve(t *testing.T, s *broker.Server, sock string) *serving {
	t.Helper()
	ln, err := s.Bind(sock)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	sv := &serving{cancel: cancel, done: make(chan error, 1)}
	go func() { sv.done <- s.Serve(ctx, ln) }()
	t.Cleanup(func() { cancel(); <-sv.done })
	return sv
}

func (sv *serving) wait(t *testing.T) error {
	t.Helper()
	select {
	case err := <-sv.done:
		sv.done <- err // for the cleanup
		return err
	case <-time.After(10 * time.Second):
		t.Fatal("Serve did not return")
		return nil
	}
}

// SR-01: Bind returns a listener that accepts at once; a normal stop removes the socket file.
func TestBindServeStop(t *testing.T) {
	t.Parallel()
	sock := filepath.Join(dir(t), "api.sock")
	s := &broker.Server{RuntimeUID: uint32(os.Getuid())}
	ln, err := s.Bind(sock)
	if err != nil {
		t.Fatal(err)
	}
	// Bound: a connection is accepted into the backlog before Serve runs.
	c, err := net.Dial("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	c.Close()
	if fi, err := os.Stat(sock); err != nil || fi.Mode().Perm() != 0o660 {
		t.Fatalf("socket mode: %v %v", fi.Mode(), err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- s.Serve(ctx, ln) }()
	served(t, sock)
	cancel()
	if err := <-done; err != nil {
		t.Fatalf("a normal stop is not a failure: %v", err)
	}
	gone(t, sock)
}

// SR-01: a socket another process serves is not taken over; a stale one (its manager died) is replaced; nothing
// but a socket is removed; a directory the manager cannot write fails the bind.
func TestBindChecksThePath(t *testing.T) {
	t.Parallel()
	s := &broker.Server{RuntimeUID: uint32(os.Getuid())}
	dir := dir(t)

	live := filepath.Join(dir, "live.sock")
	other, err := net.Listen("unix", live)
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()
	if _, err := s.Bind(live); !errors.Is(err, broker.ErrSocketInUse) {
		t.Fatalf("bound over a live socket: %v", err)
	}
	if c, err := net.Dial("unix", live); err != nil {
		t.Fatalf("the other process lost its socket: %v", err)
	} else {
		c.Close()
	}

	stale := filepath.Join(dir, "stale.sock")
	dead, err := net.ListenUnix("unix", &net.UnixAddr{Name: stale, Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	dead.SetUnlinkOnClose(false) // a manager that died leaves its file
	dead.Close()
	serve(t, s, stale)
	served(t, stale)

	file := filepath.Join(dir, "file")
	os.WriteFile(file, []byte("x"), 0o600)
	if _, err := s.Bind(file); err == nil {
		t.Fatal("bound over a regular file")
	}
	if b, _ := os.ReadFile(file); string(b) != "x" {
		t.Fatal("a regular file was replaced")
	}

	if _, err := s.Bind(filepath.Join(dir, "missing", "api.sock")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("missing directory: %v", err)
	}
	if os.Geteuid() != 0 {
		ro := filepath.Join(dir, "ro")
		os.Mkdir(ro, 0o500)
		if _, err := s.Bind(filepath.Join(ro, "api.sock")); !errors.Is(err, os.ErrPermission) {
			t.Fatalf("read-only directory: %v", err)
		}
	}
}

// SR-02: Serve fails when its socket file is removed or replaced (the runtime could not reach the manager any
// more) and never removes another process's file.
func TestServeFailsWhenTheSocketIsLost(t *testing.T) {
	t.Parallel()
	s := &broker.Server{RuntimeUID: uint32(os.Getuid()), SocketCheck: 20 * time.Millisecond}
	sock := filepath.Join(dir(t), "api.sock")
	sv := serve(t, s, sock)
	served(t, sock)
	os.Remove(sock)
	if err := sv.wait(t); !errors.Is(err, broker.ErrSocketLost) {
		t.Fatalf("removed: %v", err)
	}

	sock = filepath.Join(dir(t), "api.sock")
	sv = serve(t, s, sock)
	// Moved away (its inode stays in use, so the new file is another one), then another socket at the path.
	os.Rename(sock, sock+".old")
	other, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()
	if err := sv.wait(t); !errors.Is(err, broker.ErrSocketLost) {
		t.Fatalf("replaced: %v", err)
	}
	if c, err := net.Dial("unix", sock); err != nil {
		t.Fatalf("the replacing socket was removed: %v", err)
	} else {
		c.Close()
	}
}

// SR-02: a listener that fails ends Serve with an error (not the nil of a normal stop).
func TestServeFailsWhenTheListenerFails(t *testing.T) {
	t.Parallel()
	s := &broker.Server{RuntimeUID: uint32(os.Getuid())}
	sock := filepath.Join(dir(t), "api.sock")
	ln, err := s.Bind(sock)
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- s.Serve(context.Background(), ln) }()
	served(t, sock)
	ln.Close()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("a failed listener returned nil")
		}
	case <-time.After(10 * time.Second):
		t.Fatal("Serve did not return")
	}
}

// SR-02: a normal stop leaves a socket file another process put at the path since the last check alone (it used to
// unlink it with its own listener).
func TestStopKeepsAReplacingSocket(t *testing.T) {
	t.Parallel()
	s := &broker.Server{RuntimeUID: uint32(os.Getuid())} // the default check: every 5 s
	sock := filepath.Join(dir(t), "api.sock")
	sv := serve(t, s, sock)
	served(t, sock)
	os.Rename(sock, sock+".old") // ours moves away (its inode stays in use), the next manager's socket takes the path
	other, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()
	sv.cancel()
	if err := sv.wait(t); err != nil {
		t.Fatal(err)
	}
	if c, err := net.Dial("unix", sock); err != nil {
		t.Fatalf("the stop removed the other socket: %v", err)
	} else {
		c.Close()
	}
}

// SR-01: a socket file that goes between Bind's look and its dial is absent: Bind binds. Not parallel: the hook is
// the package's, and every Bind of another test would run it.
func TestBindWhenTheFileGoes(t *testing.T) {
	s := &broker.Server{RuntimeUID: uint32(os.Getuid())}
	sock := filepath.Join(dir(t), "api.sock")
	dead, err := net.ListenUnix("unix", &net.UnixAddr{Name: sock, Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	dead.SetUnlinkOnClose(false)
	dead.Close()
	broker.SetBeforeDial(func() { os.Remove(sock) })
	defer broker.SetBeforeDial(nil)
	ln, err := s.Bind(sock)
	if err != nil {
		t.Fatal(err)
	}
	ln.Close()
}

// SR-01: a unix socket whose listener's backlog is full refuses a connection at once (EAGAIN): someone serves it.
func TestBindRefusesAFullBacklog(t *testing.T) {
	t.Parallel()
	sock := filepath.Join(dir(t), "api.sock")
	fd, err := syscall.Socket(syscall.AF_UNIX, syscall.SOCK_STREAM, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer syscall.Close(fd)
	if err := syscall.Bind(fd, &syscall.SockaddrUnix{Name: sock}); err != nil {
		t.Fatal(err)
	}
	if err := syscall.Listen(fd, 0); err != nil { // one pending connection fills it
		t.Fatal(err)
	}
	queued, err := net.Dial("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	defer queued.Close()
	if _, err := net.Dial("unix", sock); !errors.Is(err, syscall.EAGAIN) {
		t.Fatalf("the backlog is not full: %v", err)
	}
	// (Errno.Timeout is true for EAGAIN, so it was taken as in use before, as a socket that "does not accept in time".)
	if _, err := (&broker.Server{}).Bind(sock); !errors.Is(err, broker.ErrSocketInUse) || !strings.Contains(err.Error(), "backlog is full") {
		t.Fatalf("Bind: %v", err)
	}
}
