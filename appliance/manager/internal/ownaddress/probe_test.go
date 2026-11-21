package ownaddress

import (
	"context"
	"crypto/tls"
	"errors"
	"io"
	"net"
	"os"
	"testing"
	"time"

	"golang.org/x/crypto/acme"
)

// pathTo stands in for DNS → door → relay → runtime: a TCP listener whose connections are piped to the ACME socket.
func pathTo(t *testing.T, sock string) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				defer c.Close()
				u, err := net.Dial("unix", sock)
				if err != nil {
					return
				}
				defer u.Close()
				go func() { _, _ = io.Copy(u, c) }()
				_, _ = io.Copy(c, u)
			}()
		}
	}()
	return ln.Addr().String()
}

func TestProbePasses(t *testing.T) {
	r, sock := startResponder(t, uint32(os.Getuid()), 0)
	p := &Prober{Responder: r, Addr: pathTo(t, sock), Timeout: 5 * time.Second}
	if err := p.Probe(context.Background(), testHost); err != nil {
		t.Fatal(err)
	}
	// The probe certificate is gone afterwards: nothing answers for the name.
	if _, err := hello(t, sock, testHost, []string{acme.ALPNProto}); err == nil {
		t.Fatal("the probe certificate outlived its probe")
	}
}

func TestProbeFailsOnAnotherCertificate(t *testing.T) {
	// Another server answers acme-tls/1 for the name: a door routing to someone else, or a stale route.
	other := challengeCert(t)
	ln, err := tls.Listen("tcp", "127.0.0.1:0", &tls.Config{Certificates: []tls.Certificate{*other}, NextProtos: []string{acme.ALPNProto}})
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			_ = c.(*tls.Conn).Handshake()
			c.Close()
		}
	}()
	r, _ := startResponder(t, uint32(os.Getuid()), 0)
	p := &Prober{Responder: r, Addr: ln.Addr().String(), Timeout: 5 * time.Second}
	if err := p.Probe(context.Background(), testHost); !errors.Is(err, ErrProbe) {
		t.Fatalf("err = %v, want ErrProbe", err)
	}
}

func TestProbeFailsWithNothingThere(t *testing.T) {
	// A route that ends nowhere: the connection is refused.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := ln.Addr().String()
	ln.Close()
	r, _ := startResponder(t, uint32(os.Getuid()), 0)
	p := &Prober{Responder: r, Addr: addr, Timeout: 5 * time.Second}
	if err := p.Probe(context.Background(), testHost); !errors.Is(err, ErrProbe) {
		t.Fatalf("err = %v, want ErrProbe", err)
	}
	// A route that reaches a socket where the runtime hangs up at once (no certificate at all).
	ln2, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln2.Close()
	go func() {
		for {
			c, err := ln2.Accept()
			if err != nil {
				return
			}
			c.Close()
		}
	}()
	p.Addr = ln2.Addr().String()
	if err := p.Probe(context.Background(), testHost); !errors.Is(err, ErrProbe) {
		t.Fatalf("err = %v, want ErrProbe", err)
	}
}
