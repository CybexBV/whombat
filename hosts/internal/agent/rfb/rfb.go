// Package rfb speaks the remote framebuffer protocol (VNC): the client side
// towards a VNC server (a VM's, or a Mac's own Screen Sharing), the server side
// towards the browser (security None), and the console session that relays
// one to the other. It is a leaf package, so both the broker and the Mac's
// screen package use it without importing each other.
package rfb

import (
	"context"
	"crypto/aes"
	"crypto/des"
	"crypto/md5"
	"crypto/rand"
	"crypto/tls"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net"
	"os"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"rackoon/internal/proto"
	"rackoon/internal/wire"
)

// Security types.
const (
	SecInvalid  = 0
	SecNone     = 1
	SecVNCAuth  = 2
	SecVeNCrypt = 19
	SecApple    = 30 // Apple's Diffie-Hellman sign-in with a user name and password (macOS Screen Sharing)
)

// VeNCrypt sub-types the agent can complete (x509 TLS; the anonymous-DH
// "TLS*" sub-types are not supported by Go's TLS stack).
const (
	vencryptX509None = 260
	vencryptX509Vnc  = 261
)

// Info is what the client learned from the VNC server.
type Info struct {
	Version    string // "3.8"
	Security   string // "none" | "vnc" | "apple" | "vencrypt-x509none" | "vencrypt-x509vnc"
	Width      int
	Height     int
	Name       string
	ServerInit []byte // the full ServerInit message, replayed to the browser
}

// Resolution formats the framebuffer size as "WxH".
func (i *Info) Resolution() string {
	if i == nil || i.Width == 0 {
		return ""
	}
	return strconv.Itoa(i.Width) + "x" + strconv.Itoa(i.Height)
}

// ErrAuth is returned when the VNC server rejects the credentials.
var ErrAuth = errors.New("vnc: authentication failed")

// ErrNotApple: a sign-in with a user found a server that doesn't offer
// Apple's sign-in (type 30). Only macOS's own Screen Sharing does, and only
// it may get the account or, after a sign-in without one, the keys typed.
var ErrNotApple = errors.New("vnc: the server doesn't offer Apple's sign-in")

// Options are the credentials for ClientHandshake. With a User (and a
// Password) the client signs in with Apple's type 30 and nothing else: a
// server offering None, VNC authentication or VeNCrypt instead is refused
// (ErrNotApple), since what the agent sends next (the account, a password
// typed as keys) belongs to the Mac. Without a User, Password is the VNC
// password. Greeted, when set, runs once the server sent its version and
// before the client sends anything; its error ends the handshake.
type Options struct {
	User     string
	Password string
	Greeted  func() error
}

// ClientHandshake completes the client side of the RFB handshake with a VNC
// server: version negotiation, security (None, Apple's sign-in, VNC
// authentication, VeNCrypt x509 with None/VNC), ClientInit (shared) and
// ServerInit. It returns the connection to use from now on (TLS-wrapped for
// VeNCrypt) and what it learned. The credentials are never logged or
// returned.
func ClientHandshake(conn io.ReadWriteCloser, opt Options) (io.ReadWriteCloser, *Info, error) {
	info := &Info{}
	var ver [12]byte
	if _, err := io.ReadFull(conn, ver[:]); err != nil {
		return nil, nil, fmt.Errorf("vnc: reading version: %w", err)
	}
	major, minor, ok := parseVersion(ver[:])
	if !ok || major != 3 {
		return nil, nil, fmt.Errorf("vnc: unsupported protocol version %q", string(ver[:11]))
	}
	if opt.Greeted != nil {
		if err := opt.Greeted(); err != nil {
			return nil, nil, err
		}
	}
	apple := opt.User != ""
	switch {
	case minor >= 8: // Apple's Screen Sharing says 3.889
		minor = 8
	case minor == 7:
	default:
		minor = 3
	}
	info.Version = "3." + strconv.Itoa(minor)
	if _, err := fmt.Fprintf(conn, "RFB 003.00%d\n", minor); err != nil {
		return nil, nil, err
	}
	vncPassword := ""
	if opt.User == "" {
		vncPassword = opt.Password
	}

	var secType uint32
	if minor == 3 {
		if err := binary.Read(conn, binary.BigEndian, &secType); err != nil {
			return nil, nil, fmt.Errorf("vnc: reading security type: %w", err)
		}
		if secType == SecInvalid {
			return nil, nil, fmt.Errorf("vnc: server refused the connection: %s", readReason(conn))
		}
		if apple && secType != SecApple {
			return nil, nil, fmt.Errorf("%w (it chose type %d)", ErrNotApple, secType)
		}
	} else {
		var n [1]byte
		if _, err := io.ReadFull(conn, n[:]); err != nil {
			return nil, nil, fmt.Errorf("vnc: reading security types: %w", err)
		}
		if n[0] == 0 {
			return nil, nil, fmt.Errorf("vnc: server refused the connection: %s", readReason(conn))
		}
		types := make([]byte, n[0])
		if _, err := io.ReadFull(conn, types); err != nil {
			return nil, nil, err
		}
		usable := func(t byte) bool {
			if apple {
				return t == SecApple && opt.Password != ""
			}
			switch t {
			case SecNone, SecVeNCrypt:
				return true
			case SecVNCAuth:
				return vncPassword != ""
			}
			return false
		}
		var choice byte
		for _, pref := range []byte{SecNone, SecApple, SecVNCAuth, SecVeNCrypt} {
			for _, t := range types {
				if t == pref && choice == 0 && usable(t) {
					choice = t
				}
			}
		}
		if choice == 0 {
			switch {
			case apple && opt.Password == "":
				return nil, nil, errors.New("vnc: Apple's sign-in needs a password")
			case apple:
				return nil, nil, fmt.Errorf("%w (it offers %v)", ErrNotApple, types)
			case containsByte(types, SecApple):
				return nil, nil, fmt.Errorf("vnc: the server wants a user name and password (offers %v)", types)
			}
			return nil, nil, fmt.Errorf("vnc: no supported security type (server offers %v)", types)
		}
		if _, err := conn.Write([]byte{choice}); err != nil {
			return nil, nil, err
		}
		secType = uint32(choice)
	}

	needResult := minor == 8
	switch secType {
	case SecNone:
		info.Security = "none"
	case SecVNCAuth:
		info.Security = "vnc"
		if vncPassword == "" {
			return nil, nil, errors.New("vnc: server requires a password and none is configured")
		}
		if err := vncAuth(conn, vncPassword); err != nil {
			return nil, nil, err
		}
		needResult = true
	case SecApple:
		info.Security = "apple"
		if err := appleAuth(conn, opt.User, opt.Password); err != nil {
			return nil, nil, err
		}
		needResult = true
	case SecVeNCrypt:
		if minor == 3 {
			return nil, nil, errors.New("vnc: VeNCrypt requires RFB 3.7 or later")
		}
		tconn, sub, err := veNCrypt(conn, vncPassword)
		if err != nil {
			return nil, nil, err
		}
		conn = tconn
		info.Security = sub
		needResult = true
	default:
		return nil, nil, fmt.Errorf("vnc: unsupported security type %d", secType)
	}
	if needResult {
		var res uint32
		if err := binary.Read(conn, binary.BigEndian, &res); err != nil {
			return nil, nil, fmt.Errorf("vnc: reading security result: %w", err)
		}
		if res != 0 {
			reason := ""
			if minor == 8 {
				reason = readReason(conn)
			}
			if reason != "" {
				return nil, nil, fmt.Errorf("%w: %s", ErrAuth, reason)
			}
			return nil, nil, ErrAuth
		}
	}

	// ClientInit: shared, so other viewers stay connected.
	if _, err := conn.Write([]byte{1}); err != nil {
		return nil, nil, err
	}
	var hdr [24]byte
	if _, err := io.ReadFull(conn, hdr[:]); err != nil {
		return nil, nil, fmt.Errorf("vnc: reading ServerInit: %w", err)
	}
	nameLen := binary.BigEndian.Uint32(hdr[20:24])
	if nameLen > 4096 {
		return nil, nil, errors.New("vnc: ServerInit name too long")
	}
	name := make([]byte, nameLen)
	if _, err := io.ReadFull(conn, name); err != nil {
		return nil, nil, err
	}
	info.Width = int(binary.BigEndian.Uint16(hdr[0:2]))
	info.Height = int(binary.BigEndian.Uint16(hdr[2:4]))
	info.Name = string(name)
	info.ServerInit = append(append([]byte{}, hdr[:]...), name...)
	return conn, info, nil
}

func containsByte(b []byte, v byte) bool {
	for _, x := range b {
		if x == v {
			return true
		}
	}
	return false
}

func parseVersion(b []byte) (major, minor int, ok bool) {
	if len(b) != 12 || string(b[:4]) != "RFB " || b[7] != '.' || b[11] != '\n' {
		return 0, 0, false
	}
	ma, err1 := strconv.Atoi(string(b[4:7]))
	mi, err2 := strconv.Atoi(string(b[8:11]))
	if err1 != nil || err2 != nil {
		return 0, 0, false
	}
	return ma, mi, true
}

func readReason(r io.Reader) string {
	var n uint32
	if binary.Read(r, binary.BigEndian, &n) != nil || n > 4096 {
		return "(no reason)"
	}
	b := make([]byte, n)
	if _, err := io.ReadFull(r, b); err != nil {
		return "(no reason)"
	}
	return string(b)
}

// vncAuthResponse encrypts the 16-byte challenge with the VNC password as
// the DES key (first 8 bytes, each byte bit-reversed, zero padded).
func vncAuthResponse(challenge []byte, password string) ([]byte, error) {
	var key [8]byte
	copy(key[:], password)
	for i, b := range key {
		var r byte
		for j := 0; j < 8; j++ {
			if b&(1<<j) != 0 {
				r |= 0x80 >> j
			}
		}
		key[i] = r
	}
	c, err := des.NewCipher(key[:])
	if err != nil {
		return nil, err
	}
	out := make([]byte, len(challenge))
	for i := 0; i+8 <= len(challenge); i += 8 {
		c.Encrypt(out[i:i+8], challenge[i:i+8])
	}
	return out, nil
}

func vncAuth(conn io.ReadWriter, password string) error {
	var ch [16]byte
	if _, err := io.ReadFull(conn, ch[:]); err != nil {
		return fmt.Errorf("vnc: reading challenge: %w", err)
	}
	resp, err := vncAuthResponse(ch[:], password)
	if err != nil {
		return err
	}
	_, err = conn.Write(resp)
	return err
}

// Apple's sign-in (type 30) limits: the key is at most 8192 bits (macOS
// sends 4096), each credential at most 63 bytes (they are NUL-terminated in
// 64-byte halves).
const (
	appleMaxKeyLen  = 1024
	appleMaxCredLen = 63
)

// appleAuth signs in with Apple's Diffie-Hellman type: the server sends a
// generator, the key length, the prime and its public key; the client
// answers with the user name and password (NUL-terminated in two 64-byte
// halves, random padding) encrypted with AES-128-ECB under MD5 of the
// shared secret, followed by its own public key. The security result
// follows.
func appleAuth(conn io.ReadWriter, user, password string) error {
	if len(user) > appleMaxCredLen || len(password) > appleMaxCredLen {
		return errors.New("vnc: the user name or password is longer than Apple's sign-in allows (63 bytes)")
	}
	if strings.IndexByte(user, 0) >= 0 || strings.IndexByte(password, 0) >= 0 {
		return errors.New("vnc: the user name or password holds a NUL byte")
	}
	var hdr [4]byte
	if _, err := io.ReadFull(conn, hdr[:]); err != nil {
		return fmt.Errorf("vnc: reading Apple's key parameters: %w", err)
	}
	gen := binary.BigEndian.Uint16(hdr[0:2])
	keyLen := int(binary.BigEndian.Uint16(hdr[2:4]))
	if keyLen < 16 || keyLen > appleMaxKeyLen || gen < 2 {
		return fmt.Errorf("vnc: unusable Apple key parameters (generator %d, key length %d)", gen, keyLen)
	}
	buf := make([]byte, 2*keyLen)
	if _, err := io.ReadFull(conn, buf); err != nil {
		return fmt.Errorf("vnc: reading Apple's key: %w", err)
	}
	p := new(big.Int).SetBytes(buf[:keyLen])
	serverPub := new(big.Int).SetBytes(buf[keyLen:])
	pm1 := new(big.Int).Sub(p, big.NewInt(1))
	if p.Cmp(big.NewInt(3)) <= 0 || serverPub.Cmp(big.NewInt(1)) <= 0 || serverPub.Cmp(pm1) >= 0 {
		return errors.New("vnc: unusable Apple public key")
	}
	// The private key: random in [2, p-2].
	priv, err := rand.Int(rand.Reader, new(big.Int).Sub(p, big.NewInt(3)))
	if err != nil {
		return err
	}
	priv.Add(priv, big.NewInt(2))
	pub := new(big.Int).Exp(big.NewInt(int64(gen)), priv, p)
	shared := new(big.Int).Exp(serverPub, priv, p)
	sharedBytes := make([]byte, keyLen)
	shared.FillBytes(sharedBytes)
	key := md5.Sum(sharedBytes)

	creds := make([]byte, 128)
	if _, err := rand.Read(creds); err != nil {
		return err
	}
	copy(creds[0:], user)
	creds[len(user)] = 0
	copy(creds[64:], password)
	creds[64+len(password)] = 0
	block, err := aes.NewCipher(key[:])
	if err != nil {
		return err
	}
	msg := make([]byte, 128+keyLen)
	for i := 0; i < 128; i += aes.BlockSize {
		block.Encrypt(msg[i:i+aes.BlockSize], creds[i:i+aes.BlockSize])
	}
	clear(creds)
	pub.FillBytes(msg[128:])
	_, err = conn.Write(msg)
	return err
}

// veNCrypt negotiates VeNCrypt 0.2 with an x509 sub-type and returns the
// TLS connection.
func veNCrypt(conn io.ReadWriteCloser, password string) (io.ReadWriteCloser, string, error) {
	var v [2]byte
	if _, err := io.ReadFull(conn, v[:]); err != nil {
		return nil, "", fmt.Errorf("vnc: VeNCrypt version: %w", err)
	}
	if v[0] != 0 || v[1] < 2 {
		return nil, "", fmt.Errorf("vnc: unsupported VeNCrypt version %d.%d", v[0], v[1])
	}
	if _, err := conn.Write([]byte{0, 2}); err != nil {
		return nil, "", err
	}
	var st [1]byte
	if _, err := io.ReadFull(conn, st[:]); err != nil {
		return nil, "", err
	}
	if st[0] != 0 {
		return nil, "", errors.New("vnc: server refused VeNCrypt 0.2")
	}
	var n [1]byte
	if _, err := io.ReadFull(conn, n[:]); err != nil {
		return nil, "", err
	}
	subs := make([]uint32, n[0])
	if err := binary.Read(conn, binary.BigEndian, subs); err != nil {
		return nil, "", err
	}
	var choice uint32
	for _, pref := range []uint32{vencryptX509None, vencryptX509Vnc} {
		for _, s := range subs {
			if s == pref && choice == 0 && !(pref == vencryptX509Vnc && password == "") {
				choice = s
			}
		}
	}
	if choice == 0 {
		return nil, "", fmt.Errorf("vnc: no supported VeNCrypt sub-type (server offers %v; anonymous TLS is not supported)", subs)
	}
	if err := binary.Write(conn, binary.BigEndian, choice); err != nil {
		return nil, "", err
	}
	var ack [1]byte
	if _, err := io.ReadFull(conn, ack[:]); err != nil {
		return nil, "", err
	}
	if ack[0] != 1 {
		return nil, "", errors.New("vnc: server rejected the VeNCrypt sub-type")
	}
	// The VNC server is reached over a local socket or loopback only, so its
	// certificate is not verified (it is usually issued for the host name).
	tc := tls.Client(asNetConn(conn), &tls.Config{InsecureSkipVerify: true, MinVersion: tls.VersionTLS12})
	tc.SetDeadline(time.Now().Add(15 * time.Second))
	if err := tc.Handshake(); err != nil {
		return nil, "", fmt.Errorf("vnc: TLS: %w", err)
	}
	tc.SetDeadline(time.Time{})
	if choice == vencryptX509Vnc {
		if err := vncAuth(tc, password); err != nil {
			return nil, "", err
		}
		return tc, "vencrypt-x509vnc", nil
	}
	return tc, "vencrypt-x509none", nil
}

// ServeNone performs the server side of the RFB handshake towards the
// browser: version 3.8 (3.3 / 3.7 clients accepted), security type None,
// ClientInit, then the guest's ServerInit is replayed.
func ServeNone(rw io.ReadWriter, serverInit []byte) error {
	if _, err := io.WriteString(rw, "RFB 003.008\n"); err != nil {
		return err
	}
	var ver [12]byte
	if _, err := io.ReadFull(rw, ver[:]); err != nil {
		return fmt.Errorf("browser rfb version: %w", err)
	}
	major, minor, ok := parseVersion(ver[:])
	if !ok || major != 3 {
		return fmt.Errorf("browser sent unsupported rfb version %q", string(ver[:11]))
	}
	if minor < 7 {
		if err := binary.Write(rw, binary.BigEndian, uint32(SecNone)); err != nil {
			return err
		}
	} else {
		if _, err := rw.Write([]byte{1, SecNone}); err != nil {
			return err
		}
		var c [1]byte
		if _, err := io.ReadFull(rw, c[:]); err != nil {
			return err
		}
		if c[0] != SecNone {
			return fmt.Errorf("browser chose security type %d", c[0])
		}
		if minor >= 8 {
			if err := binary.Write(rw, binary.BigEndian, uint32(0)); err != nil {
				return err
			}
		}
	}
	var ci [1]byte // ClientInit (shared flag); the agent already sent its own
	if _, err := io.ReadFull(rw, ci[:]); err != nil {
		return err
	}
	_, err := rw.Write(serverInit)
	return err
}

// Session relays an authenticated VNC connection to the browser, which sees
// security type None. It implements agent.ConsoleSession.
type Session struct {
	guest   io.ReadWriteCloser
	info    *Info
	cleanup func()
	once    sync.Once
}

// NewSession returns the console session for an authenticated connection;
// cleanup (may be nil) runs once when the session ends.
func NewSession(conn io.ReadWriteCloser, info *Info, cleanup func()) *Session {
	return &Session{guest: conn, info: info, cleanup: cleanup}
}

func (s *Session) close() {
	s.once.Do(func() {
		s.guest.Close()
		if s.cleanup != nil {
			s.cleanup()
		}
	})
}

// Run pumps frames until ctx ends, the browser leaves or the VNC server
// closes.
func (s *Session) Run(ctx context.Context, in <-chan wire.Frame, out func(wire.Frame) error) error {
	stop := context.AfterFunc(ctx, s.close)
	defer stop()
	defer s.close()
	if ctx.Err() != nil {
		return ctx.Err()
	}
	b, _ := json.Marshal(wire.ConsoleControl{Type: "status", State: "connected", Protocol: proto.ProtoVNC, Resolution: s.info.Resolution()})
	if err := out(wire.Frame{Kind: wire.FrameControl, Payload: b}); err != nil {
		return err
	}
	fc := &frameConn{ctx: ctx, in: in, out: out}
	if err := ServeNone(fc, s.info.ServerInit); err != nil {
		return err
	}
	errc := make(chan error, 2)
	go func() { _, err := io.Copy(s.guest, fc); errc <- err }()
	go func() { _, err := io.Copy(fc, s.guest); errc <- err }()
	err := <-errc
	if isEOF(err) {
		return nil
	}
	return err
}

func isEOF(err error) bool {
	return err == nil || errors.Is(err, io.EOF) || errors.Is(err, syscall.EIO) ||
		errors.Is(err, os.ErrClosed) || errors.Is(err, net.ErrClosed) || errors.Is(err, io.ErrClosedPipe)
}

// frameConn adapts channel-0 console frames to an io.ReadWriter.
type frameConn struct {
	ctx     context.Context
	in      <-chan wire.Frame
	out     func(wire.Frame) error
	pending []byte
}

func (c *frameConn) Read(p []byte) (int, error) {
	for len(c.pending) == 0 {
		select {
		case <-c.ctx.Done():
			return 0, c.ctx.Err()
		case f, ok := <-c.in:
			if !ok {
				return 0, io.EOF
			}
			switch f.Kind {
			case wire.FrameData:
				if f.Channel == 0 {
					c.pending = f.Payload
				}
			case wire.FrameControl:
				var cc wire.ConsoleControl
				if json.Unmarshal(f.Payload, &cc) == nil && cc.Type == "close" && cc.Channel == 0 {
					return 0, io.EOF
				}
			}
		}
	}
	n := copy(p, c.pending)
	c.pending = c.pending[n:]
	return n, nil
}

func (c *frameConn) Write(p []byte) (int, error) {
	total := 0
	for len(p) > 0 {
		n := len(p)
		if n > 256<<10 {
			n = 256 << 10
		}
		chunk := make([]byte, n)
		copy(chunk, p[:n])
		if err := c.out(wire.Frame{Kind: wire.FrameData, Payload: chunk}); err != nil {
			return total, err
		}
		total += n
		p = p[n:]
	}
	return total, nil
}

// asNetConn turns a ReadWriteCloser into a net.Conn for crypto/tls.
func asNetConn(rwc io.ReadWriteCloser) net.Conn {
	if c, ok := rwc.(net.Conn); ok {
		return c
	}
	return &rwcConn{ReadWriteCloser: rwc}
}

type rwcConn struct{ io.ReadWriteCloser }

type dummyAddr struct{}

func (dummyAddr) Network() string { return "pipe" }
func (dummyAddr) String() string  { return "pipe" }

func (c *rwcConn) LocalAddr() net.Addr              { return dummyAddr{} }
func (c *rwcConn) RemoteAddr() net.Addr             { return dummyAddr{} }
func (c *rwcConn) SetDeadline(time.Time) error      { return nil }
func (c *rwcConn) SetReadDeadline(time.Time) error  { return nil }
func (c *rwcConn) SetWriteDeadline(time.Time) error { return nil }
