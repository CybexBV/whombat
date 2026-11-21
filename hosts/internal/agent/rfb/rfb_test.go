package rfb

import (
	"bytes"
	"context"
	"crypto/des"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"math/bits"
	"net"
	"testing"
	"time"

	"rackoon/internal/wire"
)

// fakeVNC is a minimal RFB server: version, security, ClientInit,
// ServerInit, then it echoes bytes.
type fakeVNC struct {
	version  string // "003.003", "003.007", "003.008"
	security []byte // offered types (3.7+); 3.3 uses security[0]
	password string
	vencrypt []uint32 // offered VeNCrypt sub-types when 19 is offered
	width    uint16
	height   uint16
	shared   chan byte
}

// desResponse is an independent implementation of the VNC auth response.
func desResponse(challenge []byte, password string) []byte {
	key := make([]byte, 8)
	copy(key, password)
	for i := range key {
		key[i] = bits.Reverse8(key[i])
	}
	c, _ := des.NewCipher(key)
	out := make([]byte, 16)
	c.Encrypt(out[:8], challenge[:8])
	c.Encrypt(out[8:], challenge[8:])
	return out
}

func (f *fakeVNC) serve(conn net.Conn) error {
	defer conn.Close()
	var c io.ReadWriter = conn
	fmt.Fprintf(c, "RFB %s\n", f.version)
	var ver [12]byte
	if _, err := io.ReadFull(c, ver[:]); err != nil {
		return err
	}
	minor := 8
	switch f.version {
	case "003.003":
		minor = 3
	case "003.007":
		minor = 7
	}
	var sec byte
	if minor == 3 {
		binary.Write(c, binary.BigEndian, uint32(f.security[0]))
		sec = f.security[0]
	} else {
		c.Write(append([]byte{byte(len(f.security))}, f.security...))
		var ch [1]byte
		if _, err := io.ReadFull(c, ch[:]); err != nil {
			return err
		}
		sec = ch[0]
	}
	vncAuth := func(rw io.ReadWriter) error {
		challenge := make([]byte, 16)
		rand.Read(challenge)
		rw.Write(challenge)
		resp := make([]byte, 16)
		if _, err := io.ReadFull(rw, resp); err != nil {
			return err
		}
		if !bytes.Equal(resp, desResponse(challenge, f.password)) {
			binary.Write(rw, binary.BigEndian, uint32(1))
			if minor == 8 {
				msg := "Authentication failure"
				binary.Write(rw, binary.BigEndian, uint32(len(msg)))
				io.WriteString(rw, msg)
			}
			return errors.New("bad password")
		}
		return binary.Write(rw, binary.BigEndian, uint32(0))
	}
	switch sec {
	case SecNone:
		if minor == 8 {
			binary.Write(c, binary.BigEndian, uint32(0))
		}
	case SecVNCAuth:
		if err := vncAuth(c); err != nil {
			return err
		}
	case SecVeNCrypt:
		c.Write([]byte{0, 2})
		var v [2]byte
		io.ReadFull(c, v[:])
		c.Write([]byte{0})
		c.Write([]byte{byte(len(f.vencrypt))})
		binary.Write(c, binary.BigEndian, f.vencrypt)
		var sub uint32
		binary.Read(c, binary.BigEndian, &sub)
		c.Write([]byte{1})
		tc := tls.Server(conn, &tls.Config{Certificates: []tls.Certificate{selfSigned()}})
		if err := tc.Handshake(); err != nil {
			return err
		}
		c = tc
		if sub == vencryptX509Vnc {
			if err := vncAuth(c); err != nil {
				return err
			}
		} else {
			binary.Write(c, binary.BigEndian, uint32(0))
		}
	default:
		return fmt.Errorf("client chose %d", sec)
	}
	var shared [1]byte
	if _, err := io.ReadFull(c, shared[:]); err != nil {
		return err
	}
	if f.shared != nil {
		f.shared <- shared[0]
	}
	si := make([]byte, 24)
	binary.BigEndian.PutUint16(si[0:], f.width)
	binary.BigEndian.PutUint16(si[2:], f.height)
	si[4] = 32
	name := "QEMU (test)"
	binary.BigEndian.PutUint32(si[20:], uint32(len(name)))
	c.Write(append(si, name...))
	_, err := io.Copy(c, c) // echo
	return err
}

func selfSigned() tls.Certificate {
	k, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	tmpl := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "vnc"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour)}
	der, _ := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &k.PublicKey, k)
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: k}
}

func startFakeVNC(t *testing.T, f *fakeVNC) net.Conn {
	t.Helper()
	a, b := net.Pipe()
	go f.serve(b)
	t.Cleanup(func() { a.Close() })
	return a
}

func TestClientHandshake(t *testing.T) {
	cases := []struct {
		name string
		f    fakeVNC
		pw   string
		sec  string
	}{
		{"3.8 none", fakeVNC{version: "003.008", security: []byte{1}}, "", "none"},
		{"3.8 vnc", fakeVNC{version: "003.008", security: []byte{2}, password: "s3cret!x"}, "s3cret!x", "vnc"},
		{"3.8 prefers none", fakeVNC{version: "003.008", security: []byte{2, 1}, password: "pw"}, "pw", "none"},
		{"3.7 vnc", fakeVNC{version: "003.007", security: []byte{2}, password: "pw"}, "pw", "vnc"},
		{"3.3 vnc", fakeVNC{version: "003.003", security: []byte{2}, password: "pw"}, "pw", "vnc"},
		{"3.3 none", fakeVNC{version: "003.003", security: []byte{1}}, "", "none"},
		{"8-char limit", fakeVNC{version: "003.008", security: []byte{2}, password: "12345678"}, "123456789abc", "vnc"},
		{"vencrypt x509vnc", fakeVNC{version: "003.008", security: []byte{19}, vencrypt: []uint32{257, 261}, password: "pw"}, "pw", "vencrypt-x509vnc"},
		{"vencrypt x509none", fakeVNC{version: "003.008", security: []byte{19}, vencrypt: []uint32{260}}, "", "vencrypt-x509none"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			tc.f.width, tc.f.height = 1280, 800
			tc.f.shared = make(chan byte, 1)
			conn := startFakeVNC(t, &tc.f)
			rw, info, err := ClientHandshake(conn, Options{Password: tc.pw})
			if err != nil {
				t.Fatal(err)
			}
			if info.Security != tc.sec || info.Resolution() != "1280x800" || info.Name != "QEMU (test)" {
				t.Fatalf("info %+v", info)
			}
			if s := <-tc.f.shared; s != 1 {
				t.Fatal("ClientInit must request a shared session")
			}
			rw.Write([]byte("ping"))
			buf := make([]byte, 4)
			io.ReadFull(rw, buf)
			if string(buf) != "ping" {
				t.Fatalf("echo %q", buf)
			}
		})
	}
}

func TestClientHandshakeErrors(t *testing.T) {
	conn := startFakeVNC(t, &fakeVNC{version: "003.008", security: []byte{2}, password: "right"})
	if _, _, err := ClientHandshake(conn, Options{Password: "wrong"}); !errors.Is(err, ErrAuth) {
		t.Fatalf("wrong password: %v", err)
	}
	conn = startFakeVNC(t, &fakeVNC{version: "003.008", security: []byte{2}, password: "x"})
	if _, _, err := ClientHandshake(conn, Options{Password: ""}); err == nil {
		t.Fatal("VNC auth without a password must fail")
	}
	conn = startFakeVNC(t, &fakeVNC{version: "003.008", security: []byte{19}, vencrypt: []uint32{257, 258}})
	if _, _, err := ClientHandshake(conn, Options{Password: "pw"}); err == nil {
		t.Fatal("anonymous TLS sub-types must be refused")
	}
}

// TestSession runs the browser side through console frames: the
// browser must see only security type None.
func TestSession(t *testing.T) {
	conn := startFakeVNC(t, &fakeVNC{version: "003.008", security: []byte{2}, password: "pw", width: 1024, height: 768})
	rw, info, err := ClientHandshake(conn, Options{Password: "pw"})
	if err != nil {
		t.Fatal(err)
	}
	s := NewSession(rw, info, nil)
	in := make(chan wire.Frame, 16)
	outCh := make(chan wire.Frame, 64)
	out := func(f wire.Frame) error { outCh <- f; return nil }
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- s.Run(ctx, in, out) }()

	// Browser side over frames.
	var pending []byte
	read := func(n int) []byte {
		for len(pending) < n {
			select {
			case f := <-outCh:
				if f.Kind == wire.FrameControl {
					var cc wire.ConsoleControl
					json.Unmarshal(f.Payload, &cc)
					if cc.Type != "status" || cc.Resolution != "1024x768" || cc.Protocol != "vnc" {
						t.Fatalf("control %s", f.Payload)
					}
					continue
				}
				pending = append(pending, f.Payload...)
			case <-time.After(5 * time.Second):
				t.Fatal("timeout")
			}
		}
		b := pending[:n]
		pending = pending[n:]
		return b
	}
	send := func(b []byte) { in <- wire.Frame{Kind: wire.FrameData, Payload: append([]byte(nil), b...)} }
	if v := read(12); string(v) != "RFB 003.008\n" {
		t.Fatalf("version %q", v)
	}
	send([]byte("RFB 003.008\n"))
	if types := read(2); types[0] != 1 || types[1] != 1 {
		t.Fatalf("security types offered to the browser: %v", types)
	}
	send([]byte{1})
	if res := read(4); binary.BigEndian.Uint32(res) != 0 {
		t.Fatal("security result")
	}
	send([]byte{1}) // ClientInit
	si := read(24)
	if binary.BigEndian.Uint16(si[0:2]) != 1024 {
		t.Fatal("ServerInit not replayed")
	}
	read(int(binary.BigEndian.Uint32(si[20:24])))
	send([]byte("abc"))
	if got := read(3); string(got) != "abc" {
		t.Fatalf("relay %q", got)
	}
	close(in)
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("session did not end when the browser left")
	}
}

func TestServeNoneOldClient(t *testing.T) {
	a, b := net.Pipe()
	defer a.Close()
	go func() {
		defer b.Close()
		ServeNone(b, []byte("SERVERINIT"))
	}()
	ver := make([]byte, 12)
	io.ReadFull(a, ver)
	a.Write([]byte("RFB 003.003\n"))
	var sec uint32
	binary.Read(a, binary.BigEndian, &sec)
	if sec != 1 {
		t.Fatalf("3.3 client got security %d", sec)
	}
	a.Write([]byte{0})
	si := make([]byte, 10)
	io.ReadFull(a, si)
	if string(si) != "SERVERINIT" {
		t.Fatalf("got %q", si)
	}
}
