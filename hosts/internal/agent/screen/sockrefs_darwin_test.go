package screen

import (
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"testing"
)

// The kernel's view of who holds the other end of a connection, for real:
// before the accept nobody, then the accepted descriptor alone, and shared
// whenever another reference exists (a copy in this process, a child's, a
// message in flight).
func TestConnRefsDarwin(t *testing.T) {
	dir := shortTempDir(t)
	addr := &net.UnixAddr{Name: filepath.Join(dir, "s.sock"), Net: "unix"}
	ln, err := net.ListenUnix("unix", addr)
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	c, err := net.DialUnix("unix", nil, addr)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	me := os.Getpid()
	refsOf := func(pid int) []sockRef {
		t.Helper()
		refs, err := connRefs(c, pid)
		if err != nil {
			t.Fatal(err)
		}
		return refs
	}
	if refs := refsOf(me); len(refs) != 0 {
		t.Fatalf("before the accept: %+v", refs)
	}
	srv, err := ln.AcceptUnix()
	if err != nil {
		t.Fatal(err)
	}
	defer srv.Close()
	var fd int
	raw, _ := srv.SyscallConn()
	raw.Control(func(f uintptr) { fd = int(f) })
	if refs := refsOf(me); len(refs) != 1 || refs[0].fd != fd || refs[0].shared {
		t.Fatalf("accepted (descriptor %d): %+v", fd, refs)
	}
	// A copy in this process.
	dup, err := srv.File()
	if err != nil {
		t.Fatal(err)
	}
	if refs := refsOf(me); len(refs) != 2 || !refs[0].shared || !refs[1].shared {
		t.Fatalf("a copy: %+v", refs)
	}
	// A child holding it (as a forked holder would).
	child := exec.Command("/bin/sleep", "30")
	child.ExtraFiles = []*os.File{dup}
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	dup.Close()
	if refs := refsOf(me); len(refs) != 1 || !refs[0].shared {
		t.Fatalf("a child's copy, here: %+v", refs)
	}
	if refs := refsOf(child.Process.Pid); len(refs) != 1 || refs[0].fd != 3 || !refs[0].shared {
		t.Fatalf("a child's copy, there: %+v", refs)
	}
	child.Process.Kill()
	child.Wait()
	if refs := refsOf(me); len(refs) != 1 || refs[0].shared {
		t.Fatalf("the child gone: %+v", refs)
	}
	// In a message in flight.
	pair, err := syscall.Socketpair(syscall.AF_UNIX, syscall.SOCK_STREAM, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer syscall.Close(pair[0])
	defer syscall.Close(pair[1])
	if err := syscall.Sendmsg(pair[0], []byte{1}, syscall.UnixRights(fd), nil, 0); err != nil {
		t.Fatal(err)
	}
	if refs := refsOf(me); len(refs) != 1 || !refs[0].shared {
		t.Fatalf("in flight: %+v", refs)
	}
	oob := make([]byte, syscall.CmsgSpace(4))
	_, oobn, _, _, err := syscall.Recvmsg(pair[1], make([]byte, 1), oob, 0)
	if err != nil {
		t.Fatal(err)
	}
	msgs, _ := syscall.ParseSocketControlMessage(oob[:oobn])
	got, _ := syscall.ParseUnixRights(&msgs[0])
	syscall.Close(got[0])
	if refs := refsOf(me); len(refs) != 1 || refs[0].shared {
		t.Fatalf("received and closed: %+v", refs)
	}
}
