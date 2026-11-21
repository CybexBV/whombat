package screen

import (
	"bufio"
	"bytes"
	"context"
	"crypto/aes"
	"crypto/md5"
	"crypto/rand"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"testing"
	"time"
)

// fakeSharing is macOS Screen Sharing for tests: Apple's sign-in (type 30)
// with a small prime, a framebuffer whose pixel at (x, y) is red x%256,
// green y%256, blue 7, and a record of the input it received.
type fakeSharing struct {
	ln       net.Listener
	prime    *big.Int
	w, h     int
	mu       sync.Mutex
	user     string
	password string
	events   []string // "key <sym> <down>", "ptr <mask> <x> <y>"
	signIns  int
	refused  int
	ended    int  // signed-in sessions that ended
	chatty   bool // send a bell and clipboard text before each update
	conns    []net.Conn
}

func newFakeSharing(t *testing.T, user, password string) *fakeSharing {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	p, err := rand.Prime(rand.Reader, 128)
	if err != nil {
		t.Fatal(err)
	}
	f := &fakeSharing{ln: ln, prime: p, w: 64, h: 48, user: user, password: password}
	t.Cleanup(func() {
		ln.Close()
		f.mu.Lock()
		for _, c := range f.conns {
			c.Close()
		}
		f.mu.Unlock()
	})
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			f.mu.Lock()
			f.conns = append(f.conns, c)
			f.mu.Unlock()
			go f.serve(c)
		}
	}()
	return f
}

func (f *fakeSharing) addr() string { return f.ln.Addr().String() }

func (f *fakeSharing) setPassword(pw string) {
	f.mu.Lock()
	f.password = pw
	f.mu.Unlock()
}

func (f *fakeSharing) takeEvents() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	e := f.events
	f.events = nil
	return e
}

// seen counts ev among the events received since the last takeEvents.
func (f *fakeSharing) seen(ev string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for _, e := range f.events {
		if e == ev {
			n++
		}
	}
	return n
}

func (f *fakeSharing) endedSessions() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.ended
}

func (f *fakeSharing) counts() (signIns, refused int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.signIns, f.refused
}

// dropAll closes every connection (Screen Sharing restarting).
func (f *fakeSharing) dropAll() {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, c := range f.conns {
		c.Close()
	}
	f.conns = nil
}

func (f *fakeSharing) serve(c net.Conn) {
	defer c.Close()
	signedIn := false
	defer func() {
		if signedIn {
			f.mu.Lock()
			f.ended++
			f.mu.Unlock()
		}
	}()
	io.WriteString(c, "RFB 003.889\n")
	br := bufio.NewReader(c)
	if _, err := io.ReadFull(br, make([]byte, 12)); err != nil {
		return
	}
	c.Write([]byte{4, 30, 33, 36, 35})
	ch, err := br.ReadByte()
	if err != nil || ch != 30 {
		return
	}
	keyLen := 16
	priv, _ := rand.Int(rand.Reader, f.prime)
	pub := new(big.Int).Exp(big.NewInt(2), priv, f.prime)
	msg := make([]byte, 4+2*keyLen)
	binary.BigEndian.PutUint16(msg[0:], 2)
	binary.BigEndian.PutUint16(msg[2:], uint16(keyLen))
	f.prime.FillBytes(msg[4 : 4+keyLen])
	pub.FillBytes(msg[4+keyLen:])
	c.Write(msg)
	ans := make([]byte, 128+keyLen)
	if _, err := io.ReadFull(br, ans); err != nil {
		return
	}
	shared := new(big.Int).Exp(new(big.Int).SetBytes(ans[128:]), priv, f.prime)
	sb := make([]byte, keyLen)
	shared.FillBytes(sb)
	key := md5.Sum(sb)
	blk, _ := aes.NewCipher(key[:])
	creds := make([]byte, 128)
	for i := 0; i < 128; i += 16 {
		blk.Decrypt(creds[i:i+16], ans[i:i+16])
	}
	cstr := func(b []byte) string { return string(b[:bytes.IndexByte(b, 0)]) }
	f.mu.Lock()
	ok := cstr(creds[:64]) == f.user && cstr(creds[64:]) == f.password
	if ok {
		f.signIns++
		signedIn = true
	} else {
		f.refused++
	}
	w, h := f.w, f.h
	f.mu.Unlock()
	if !ok {
		binary.Write(c, binary.BigEndian, uint32(1))
		r := "Authentication failed"
		binary.Write(c, binary.BigEndian, uint32(len(r)))
		io.WriteString(c, r)
		return
	}
	binary.Write(c, binary.BigEndian, uint32(0))
	if _, err := br.ReadByte(); err != nil { // ClientInit
		return
	}
	si := make([]byte, 24)
	binary.BigEndian.PutUint16(si[0:], uint16(w))
	binary.BigEndian.PutUint16(si[2:], uint16(h))
	si[4], si[5], si[7] = 32, 24, 1
	name := "Test Mac"
	binary.BigEndian.PutUint32(si[20:], uint32(len(name)))
	c.Write(append(si, name...))
	var wmu sync.Mutex
	for {
		t, err := br.ReadByte()
		if err != nil {
			return
		}
		switch t {
		case 0: // SetPixelFormat
			io.ReadFull(br, make([]byte, 19))
		case 2: // SetEncodings
			hdr := make([]byte, 3)
			io.ReadFull(br, hdr)
			io.ReadFull(br, make([]byte, 4*int(binary.BigEndian.Uint16(hdr[1:]))))
		case 3: // FramebufferUpdateRequest
			io.ReadFull(br, make([]byte, 9))
			f.mu.Lock()
			chatty := f.chatty
			f.mu.Unlock()
			wmu.Lock()
			if chatty {
				c.Write([]byte{2})
				clip := "copied text"
				m := []byte{3, 0, 0, 0, 0, 0, 0, 0}
				binary.BigEndian.PutUint32(m[4:], uint32(len(clip)))
				c.Write(append(m, clip...))
			}
			up := []byte{0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0}
			binary.BigEndian.PutUint16(up[8:], uint16(w))
			binary.BigEndian.PutUint16(up[10:], uint16(h))
			px := make([]byte, w*h*4)
			for y := 0; y < h; y++ {
				for x := 0; x < w; x++ {
					o := (y*w + x) * 4
					px[o], px[o+1], px[o+2] = 7, byte(y), byte(x) // blue, green, red
				}
			}
			c.Write(append(up, px...))
			wmu.Unlock()
		case 4: // KeyEvent
			b := make([]byte, 7)
			io.ReadFull(br, b)
			f.mu.Lock()
			f.events = append(f.events, "key "+strconv.FormatUint(uint64(binary.BigEndian.Uint32(b[3:])), 16)+" "+strconv.Itoa(int(b[0])))
			f.mu.Unlock()
		case 5: // PointerEvent
			b := make([]byte, 5)
			io.ReadFull(br, b)
			f.mu.Lock()
			f.events = append(f.events, "ptr "+strconv.Itoa(int(b[0]))+" "+strconv.Itoa(int(binary.BigEndian.Uint16(b[1:])))+" "+strconv.Itoa(int(binary.BigEndian.Uint16(b[3:]))))
			f.mu.Unlock()
		default:
			return
		}
	}
}

// fakeHelper is Whombat Helper for tests: one JSON line in, one out, on
// <root>/<uid>/helper.sock.
type fakeHelper struct {
	ln     net.Listener
	mu     sync.Mutex
	reqs   []map[string]any
	answer func(req map[string]any) map[string]any
}

func newFakeHelper(t *testing.T, root string, uid int, answer func(map[string]any) map[string]any) *fakeHelper {
	t.Helper()
	if err := ensureUIDirs(root, uid); err != nil {
		t.Fatal(err)
	}
	ln, err := net.Listen("unix", filepath.Join(root, strconv.Itoa(uid), helperSocketName))
	if err != nil {
		t.Fatal(err)
	}
	h := &fakeHelper{ln: ln, answer: answer}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				defer c.Close()
				line, err := bufio.NewReader(c).ReadBytes('\n')
				if err != nil {
					return
				}
				var req map[string]any
				if json.Unmarshal(line, &req) != nil {
					return
				}
				h.mu.Lock()
				h.reqs = append(h.reqs, req)
				h.mu.Unlock()
				b, _ := json.Marshal(h.answer(req))
				c.Write(append(b, '\n'))
			}()
		}
	}()
	return h
}

func (h *fakeHelper) requests() []map[string]any {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]map[string]any(nil), h.reqs...)
}

func (h *fakeHelper) count(op string) int {
	n := 0
	for _, r := range h.requests() {
		if r["op"] == op {
			n++
		}
	}
	return n
}

// shortTempDir is a short folder: Unix socket paths are limited to about
// 100 bytes.
func shortTempDir(t *testing.T) string {
	t.Helper()
	d, err := os.MkdirTemp("", "scr")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(d) })
	return d
}

// uidOnly is the helper check of tests: the fake helper runs in the test
// process, so only its user can be checked.
func uidOnly(_ context.Context, c *net.UnixConn, uid int) error {
	if peer, err := peerUID(c); err != nil || peer != uid {
		return errors.New("the socket isn't the user's")
	}
	return nil
}

// newTestScreen is a Screen against fakes, with short waits.
func newTestScreen(t *testing.T, addr string) *Screen {
	t.Helper()
	dir := shortTempDir(t)
	s := New(Options{ConfigDir: filepath.Join(dir, "etc"), Addr: addr, UIRoot: filepath.Join(dir, "ui"),
		HelperApp: filepath.Join(dir, "Whombat Helper.app"), Log: slog.New(slog.NewTextHandler(io.Discard, nil))})
	s.consoleUID = func() (int, bool) { return os.Getuid(), true }
	s.sessions = func(context.Context) ([]consoleSession, error) { return nil, errors.New("no ioreg in tests") }
	// The trust checks need a Mac: the fakes stand in for macOS's own.
	s.helper.check = uidOnly
	s.sharingListener = func(ctx context.Context) error {
		c, err := (&net.Dialer{}).DialContext(ctx, "tcp", addr)
		if err != nil {
			return errNoScreen
		}
		return c.Close()
	}
	s.sharingPeer = func(context.Context, net.Conn) error { return nil }
	s.appleCode = func(context.Context, int) bool { return true }
	s.procStart = func(context.Context, int) (int64, error) { return 1, nil }
	s.codeVerify = func(context.Context, string, string) error { return nil }
	s.rootOnly = func(string) error { return nil }
	s.wakeWait, s.wakeSettle, s.escGap, s.settle, s.pollGap = 10*time.Millisecond, time.Millisecond, time.Millisecond, 10*time.Millisecond, time.Millisecond
	s.unlockHold = 5 * time.Minute
	s.busyWait = 200 * time.Millisecond
	s.keyGap, s.charGap, s.clickGap = 0, time.Millisecond, time.Millisecond
	s.sharingSettle, s.inputSettle, s.sharingSettleMax, s.leadSettle = 0, 0, 0, 0
	return s
}
