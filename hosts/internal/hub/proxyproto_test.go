package hub

import (
	"encoding/binary"
	"io"
	"net"
	"testing"
)

func proxyPair(t *testing.T, prefix []byte, payload string) net.Conn {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	pl := &proxyListener{Listener: ln, trusted: func(ip net.IP) bool { return ip.IsLoopback() }}
	go func() {
		c, err := net.Dial("tcp", ln.Addr().String())
		if err != nil {
			return
		}
		c.Write(append(prefix, payload...))
		c.Close()
	}()
	c, err := pl.Accept()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close() })
	return c
}

func TestProxyProtocolV1(t *testing.T) {
	c := proxyPair(t, []byte("PROXY TCP4 10.100.0.40 10.100.0.7 51234 8443\r\n"), "\x16hello")
	if got := c.RemoteAddr().String(); got != "10.100.0.40:51234" {
		t.Fatalf("remote %s", got)
	}
	b, _ := io.ReadAll(c)
	if string(b) != "\x16hello" {
		t.Fatalf("payload %q", b)
	}
}

func TestProxyProtocolV2(t *testing.T) {
	h := append([]byte{}, proxyV2Sig...)
	h = append(h, 0x21, 0x11, 0, 12) // v2 PROXY, TCP over IPv4, 12 bytes
	h = append(h, 10, 100, 1, 23, 10, 100, 0, 7)
	h = binary.BigEndian.AppendUint16(h, 40000)
	h = binary.BigEndian.AppendUint16(h, 8443)
	c := proxyPair(t, h, "\x16tls")
	if got := c.RemoteAddr().String(); got != "10.100.1.23:40000" {
		t.Fatalf("remote %s", got)
	}
	b, _ := io.ReadAll(c)
	if string(b) != "\x16tls" {
		t.Fatalf("payload %q", b)
	}
}

func TestNoProxyHeaderPassesThrough(t *testing.T) {
	c := proxyPair(t, nil, "\x16\x03\x01direct")
	if ta := c.RemoteAddr().(*net.TCPAddr); !ta.IP.IsLoopback() {
		t.Fatalf("remote %v", ta)
	}
	b, _ := io.ReadAll(c)
	if string(b) != "\x16\x03\x01direct" {
		t.Fatalf("payload %q", b)
	}
}

func TestBrokenProxyHeaderCloses(t *testing.T) {
	c := proxyPair(t, []byte("PROXY garbage\r\n"), "")
	if _, err := c.Read(make([]byte, 1)); err == nil {
		t.Fatal("broken header accepted")
	}
}
