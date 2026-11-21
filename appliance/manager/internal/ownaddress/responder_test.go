package ownaddress

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"

	"golang.org/x/crypto/acme"
)

const testHost = "maple-otter-river.dev.whombat.app"

// startResponder serves a responder on a unix socket in a test directory (short: unix socket paths are bounded).
func startResponder(t *testing.T, uid uint32, max int) (*Responder, string) {
	t.Helper()
	dir, err := os.MkdirTemp(os.Getenv("TMPDIR"), "oa")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	r := &Responder{RuntimeUID: uid, Max: max, HandshakeTimeout: 5 * time.Second}
	path := filepath.Join(dir, "acme.sock")
	ln, err := r.Bind(path)
	if err != nil {
		t.Fatal(err)
	}
	fi, err := os.Stat(path)
	if err != nil || fi.Mode().Perm() != 0o660 {
		t.Fatalf("socket mode %v (%v), want 0660", fi.Mode().Perm(), err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { _ = r.Serve(ctx, ln); close(done) }()
	t.Cleanup(func() { cancel(); <-done })
	return r, path
}

// hello dials the socket and does a TLS handshake with the given ALPN, returning the leaf the responder sent.
func hello(t *testing.T, path, sni string, protos []string) (*x509.Certificate, error) {
	t.Helper()
	c, err := net.Dial("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	_ = c.SetDeadline(time.Now().Add(5 * time.Second))
	tc := tls.Client(c, &tls.Config{ServerName: sni, NextProtos: protos, InsecureSkipVerify: true})
	if err := tc.Handshake(); err != nil {
		return nil, err
	}
	if tc.ConnectionState().NegotiatedProtocol != acme.ALPNProto {
		return nil, errors.New("acme-tls/1 not negotiated")
	}
	return tc.ConnectionState().PeerCertificates[0], nil
}

func challengeCert(t *testing.T) *tls.Certificate {
	t.Helper()
	c, err := probeCert(testHost)
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func TestResponderAnswersOnlyAPendingChallenge(t *testing.T) {
	r, path := startResponder(t, uint32(os.Getuid()), 0)
	if _, err := hello(t, path, testHost, []string{acme.ALPNProto}); err == nil {
		t.Fatal("answered without a pending challenge")
	}
	c := challengeCert(t)
	r.SetChallenge(testHost, c)
	leaf, err := hello(t, path, testHost, []string{acme.ALPNProto})
	if err != nil {
		t.Fatal(err)
	}
	if string(leaf.Raw) != string(c.Certificate[0]) {
		t.Fatal("another certificate came back")
	}
	// The name is matched without case or a trailing dot; another name gets nothing.
	if _, err := hello(t, path, "MAPLE-otter-river.dev.whombat.app.", []string{acme.ALPNProto}); err != nil {
		t.Fatalf("case and dot: %v", err)
	}
	if _, err := hello(t, path, "other-name-here.dev.whombat.app", []string{acme.ALPNProto}); err == nil {
		t.Fatal("answered for another name")
	}
	// Only exactly acme-tls/1: a browser's h2, or acme-tls/1 among others, is refused.
	for _, protos := range [][]string{{"h2"}, {"h2", "http/1.1"}, {acme.ALPNProto, "h2"}, nil} {
		if _, err := hello(t, path, testHost, protos); err == nil {
			t.Fatalf("ALPN %v answered", protos)
		}
	}
	r.ClearChallenge(testHost)
	if _, err := hello(t, path, testHost, []string{acme.ALPNProto}); err == nil {
		t.Fatal("answered after the challenge cleared")
	}
	// A challenge wins over a probe for the same name.
	p := challengeCert(t)
	r.SetProbe(testHost, p)
	r.SetChallenge(testHost, c)
	if leaf, err := hello(t, path, testHost, []string{acme.ALPNProto}); err != nil || string(leaf.Raw) != string(c.Certificate[0]) {
		t.Fatalf("challenge not first: %v", err)
	}
}

func TestResponderRefusesAnotherPeer(t *testing.T) {
	r, path := startResponder(t, uint32(os.Getuid())+1, 0)
	r.SetChallenge(testHost, challengeCert(t))
	if _, err := hello(t, path, testHost, []string{acme.ALPNProto}); err == nil {
		t.Fatal("another uid got an answer")
	}
}

func TestResponderClosesTheNinthConnection(t *testing.T) {
	r, path := startResponder(t, uint32(os.Getuid()), 8)
	r.SetChallenge(testHost, challengeCert(t))
	// Eight connections that never send a hello hold every slot.
	var held []net.Conn
	for range 8 {
		c, err := net.Dial("unix", path)
		if err != nil {
			t.Fatal(err)
		}
		held = append(held, c)
	}
	defer func() {
		for _, c := range held {
			c.Close()
		}
	}()
	time.Sleep(100 * time.Millisecond) // let the eight be accepted
	c, err := net.Dial("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	_ = c.SetReadDeadline(time.Now().Add(3 * time.Second))
	if _, err := c.Read(make([]byte, 1)); !errors.Is(err, io.EOF) {
		t.Fatalf("the ninth: %v, want closed", err)
	}
	// Once one is let go, a new one is served again.
	held[0].Close()
	held = held[1:]
	time.Sleep(100 * time.Millisecond)
	if _, err := hello(t, path, testHost, []string{acme.ALPNProto}); err != nil {
		t.Fatalf("after a slot freed: %v", err)
	}
}

func TestResponderBindReplacesOnlyAStaleSocket(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "acme.sock")
	if err := os.WriteFile(path, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	r := &Responder{}
	if _, err := r.Bind(path); err == nil {
		t.Fatal("bound over a regular file")
	}
	os.Remove(path)
	ln, err := r.Bind(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := r.Bind(path); err == nil {
		t.Fatal("bound over a live socket")
	}
	ln.(*net.UnixListener).SetUnlinkOnClose(false)
	ln.Close()
	ln, err = r.Bind(path) // the stale file of a manager that died
	if err != nil {
		t.Fatal(err)
	}
	ln.Close()
}
