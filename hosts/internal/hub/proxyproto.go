package hub

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"
)

// PROXY protocol (HAProxy, v1 text and v2 binary) on the agent listener: a
// local TCP proxy (an Incus proxy device with proxy_protocol=true, HAProxy)
// prepends the agent's real address. It is only read from loopback peers
// (only local processes can connect from there) and only when the
// connection starts with the PROXY signature, so direct connections are
// unaffected.

var proxyV2Sig = []byte{0x0D, 0x0A, 0x0D, 0x0A, 0x00, 0x0D, 0x0A, 0x51, 0x55, 0x49, 0x54, 0x0A}

type proxyListener struct {
	net.Listener
	trusted func(net.IP) bool
}

// proxyConn is a loopback connection that may start with a PROXY header.
// The header is read on the first RemoteAddr or Read call, which happens in
// the connection's own goroutine (net/http asks for RemoteAddr when it
// starts serving it), so a slow peer cannot hold up the accept loop.
type proxyConn struct {
	net.Conn
	once   sync.Once
	r      *bufio.Reader
	remote net.Addr
	err    error
}

func (c *proxyConn) init() {
	c.once.Do(func() {
		c.r, c.remote, c.err = readProxyHeader(c.Conn)
		if c.err != nil {
			c.Conn.Close()
		}
	})
}

func (c *proxyConn) Read(b []byte) (int, error) {
	c.init()
	if c.err != nil {
		return 0, c.err
	}
	return c.r.Read(b)
}

func (c *proxyConn) RemoteAddr() net.Addr {
	c.init()
	return c.remote
}

// Accept wraps loopback connections; others are returned as they are.
func (l *proxyListener) Accept() (net.Conn, error) {
	c, err := l.Listener.Accept()
	if err != nil {
		return nil, err
	}
	if ta, ok := c.RemoteAddr().(*net.TCPAddr); ok && l.trusted(ta.IP) {
		return &proxyConn{Conn: c}, nil
	}
	return c, nil
}

// readProxyHeader peeks at the start of c and consumes a PROXY header when
// present (any other start is left for TLS). It returns the reader to use
// from now on and the client's address.
func readProxyHeader(c net.Conn) (*bufio.Reader, net.Addr, error) {
	_ = c.SetReadDeadline(time.Now().Add(5 * time.Second))
	defer c.SetReadDeadline(time.Time{})
	r := bufio.NewReaderSize(c, 512)
	first, err := r.Peek(1)
	if err != nil {
		return nil, nil, err
	}
	remote := c.RemoteAddr()
	switch first[0] {
	case 'P': // v1: "PROXY TCP4 src dst sport dport\r\n"
		line, err := r.ReadString('\n')
		if err != nil || len(line) > 107 || !strings.HasPrefix(line, "PROXY ") {
			return nil, nil, errors.New("bad PROXY v1 header")
		}
		f := strings.Fields(strings.TrimSpace(line))
		if len(f) >= 2 && f[1] == "UNKNOWN" {
			return r, remote, nil
		}
		if len(f) != 6 {
			return nil, nil, errors.New("bad PROXY v1 header")
		}
		ip := net.ParseIP(f[2])
		port, err := strconv.Atoi(f[4])
		if ip == nil || err != nil {
			return nil, nil, errors.New("bad PROXY v1 address")
		}
		return r, &net.TCPAddr{IP: ip, Port: port}, nil
	case 0x0D: // v2
		hdr, err := r.Peek(16)
		if err != nil || !bytes.Equal(hdr[:12], proxyV2Sig) {
			return nil, nil, errors.New("bad PROXY v2 signature")
		}
		verCmd, fam := hdr[12], hdr[13]
		n := int(binary.BigEndian.Uint16(hdr[14:16]))
		if verCmd>>4 != 2 || n > 1024 {
			return nil, nil, fmt.Errorf("bad PROXY v2 header")
		}
		buf := make([]byte, 16+n)
		if _, err := ioReadFull(r, buf); err != nil {
			return nil, nil, err
		}
		body := buf[16:]
		if verCmd&0x0F == 0 { // LOCAL: keep the peer address
			return r, remote, nil
		}
		switch fam >> 4 {
		case 1: // AF_INET
			if len(body) < 12 {
				return nil, nil, errors.New("short PROXY v2 address")
			}
			remote = &net.TCPAddr{IP: net.IP(body[0:4]), Port: int(binary.BigEndian.Uint16(body[8:10]))}
		case 2: // AF_INET6
			if len(body) < 36 {
				return nil, nil, errors.New("short PROXY v2 address")
			}
			remote = &net.TCPAddr{IP: net.IP(body[0:16]), Port: int(binary.BigEndian.Uint16(body[32:34]))}
		}
		return r, remote, nil
	}
	return r, remote, nil // not a PROXY header: TLS starts here
}

func ioReadFull(r *bufio.Reader, b []byte) (int, error) {
	n := 0
	for n < len(b) {
		m, err := r.Read(b[n:])
		n += m
		if err != nil {
			return n, err
		}
	}
	return n, nil
}
