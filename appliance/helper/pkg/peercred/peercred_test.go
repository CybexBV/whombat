package peercred

import (
	"net"
	"os"
	"path/filepath"
	"testing"
)

func TestOf(t *testing.T) {
	sock := filepath.Join(t.TempDir(), "s.sock")
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		c, err := net.Dial("unix", sock)
		if err == nil {
			defer c.Close()
			buf := make([]byte, 1)
			_, _ = c.Read(buf)
		}
	}()
	c, err := ln.Accept()
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	cred, err := Of(c)
	if err != nil {
		t.Fatal(err)
	}
	if cred.UID != uint32(os.Getuid()) || cred.PID != int32(os.Getpid()) {
		t.Fatalf("cred %+v", cred)
	}
}
