package broker

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha1"
	"crypto/x509"
	"encoding/binary"
	"encoding/json"
	"errors"
	"image"
	"io"
	"net"
	"sync"
	"testing"
	"time"

	"rackoon/internal/wire"
)

// fakeSpice is a SPICE server that checks the ticket and then serves a
// tiny main / display protocol.
type fakeSpice struct {
	key      *rsa.PrivateKey
	password string // expected ticket
	tickets  chan string
	width    uint32
	height   uint32
}

func newFakeSpice(t *testing.T, password string) *fakeSpice {
	k, err := rsa.GenerateKey(rand.Reader, 1024)
	if err != nil {
		t.Fatal(err)
	}
	return &fakeSpice{key: k, password: password, tickets: make(chan string, 16), width: 1280, height: 800}
}

func spiceMsg(typ uint16, payload []byte) []byte {
	h := make([]byte, 6)
	binary.LittleEndian.PutUint16(h, typ)
	binary.LittleEndian.PutUint32(h[2:], uint32(len(payload)))
	return append(h, payload...)
}

func (f *fakeSpice) serve(c net.Conn) error {
	defer c.Close()
	_, body, err := readSpiceLinkMsg(c)
	if err != nil {
		return err
	}
	chType := body[4]
	common, _, _ := parseCaps(body, binary.LittleEndian.Uint32(body[14:18]), binary.LittleEndian.Uint32(body[6:10]), binary.LittleEndian.Uint32(body[10:14]))
	pub, _ := x509.MarshalPKIXPublicKey(&f.key.PublicKey)
	reply := make([]byte, 178+4)
	copy(reply[4:], pub)
	binary.LittleEndian.PutUint32(reply[166:], 1)
	binary.LittleEndian.PutUint32(reply[170:], 0)
	binary.LittleEndian.PutUint32(reply[174:], 178)
	binary.LittleEndian.PutUint32(reply[178:], 1<<spiceCapAuthSelection|1<<spiceCapAuthSpice|1<<spiceCapMiniHeader)
	hdr := make([]byte, 16)
	binary.LittleEndian.PutUint32(hdr, spiceMagic)
	binary.LittleEndian.PutUint32(hdr[4:], 2)
	binary.LittleEndian.PutUint32(hdr[8:], 2)
	binary.LittleEndian.PutUint32(hdr[12:], uint32(len(reply)))
	c.Write(append(hdr, reply...))
	if hasCap(common, spiceCapAuthSelection) {
		var mech [4]byte
		if _, err := io.ReadFull(c, mech[:]); err != nil {
			return err
		}
	}
	enc := make([]byte, 128)
	if _, err := io.ReadFull(c, enc); err != nil {
		return err
	}
	pt, err := rsa.DecryptOAEP(sha1.New(), nil, f.key, enc, nil)
	if err != nil {
		return err
	}
	ticket := string(bytes.TrimRight(pt, "\x00"))
	f.tickets <- ticket
	res := make([]byte, 4)
	if ticket != f.password {
		binary.LittleEndian.PutUint32(res, 7) // SPICE_LINK_ERR_PERMISSION_DENIED
		c.Write(res)
		return errors.New("bad ticket")
	}
	c.Write(res)
	switch chType {
	case spiceChannelMain:
		init := make([]byte, 32)
		binary.LittleEndian.PutUint32(init, 0xabcd)
		c.Write(spiceMsg(spiceMsgSetAck, []byte{1, 0, 0, 0, 20, 0, 0, 0}))
		c.Write(spiceMsg(spiceMsgMainInit, init))
		buf := make([]byte, 64)
		for {
			// Wait for ATTACH_CHANNELS (ignore other messages).
			var h [6]byte
			if _, err := io.ReadFull(c, h[:]); err != nil {
				return err
			}
			p := make([]byte, binary.LittleEndian.Uint32(h[2:]))
			io.ReadFull(c, p)
			if binary.LittleEndian.Uint16(h[:]) == spiceMsgcMainAttach {
				break
			}
		}
		list := []byte{2, 0, 0, 0, spiceChannelDisplay, 0, 3, 0}
		c.Write(spiceMsg(spiceMsgMainChanList, list))
		for {
			if _, err := c.Read(buf); err != nil {
				return nil
			}
		}
	case spiceChannelDisplay:
		sc := make([]byte, 20)
		binary.LittleEndian.PutUint32(sc[4:], f.width)
		binary.LittleEndian.PutUint32(sc[8:], f.height)
		binary.LittleEndian.PutUint32(sc[16:], spiceSurfacePrimary)
		c.Write(spiceMsg(spiceMsgDisplayMode+1, []byte{1, 2, 3})) // MARK-like noise
		c.Write(spiceMsg(spiceMsgSurfaceNew, sc))
		_, err := io.Copy(c, c) // echo
		return err
	}
	return nil
}

// dialer connects over real loopback sockets (net.Pipe is unbuffered,
// unlike the Unix/TCP sockets SPICE runs on).
func (f *fakeSpice) dialer(t *testing.T, password string, inject bool) spiceDialer {
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
			go f.serve(c)
		}
	}()
	return func(ctx context.Context) (io.ReadWriteCloser, string, bool, error) {
		var d net.Dialer
		c, err := d.DialContext(ctx, "tcp", ln.Addr().String())
		return c, password, inject, err
	}
}

// TestSpiceLinkProxyInjectsTicket: the browser sends an encryption of an
// empty password; the server must receive the agent's ticket.
func TestSpiceLinkProxyInjectsTicket(t *testing.T) {
	f := newFakeSpice(t, "tick3t")
	for _, authSel := range []bool{false, true} {
		server, sside := net.Pipe()
		go f.serve(sside)
		browser, bside := net.Pipe()
		errc := make(chan error, 1)
		go func() {
			_, err := SpiceLinkProxy(bside, server, "tick3t", true)
			errc <- err
		}()
		// Browser: spice-html5 style (no auth selection) or spice-gtk style.
		common := uint32(1 << spiceCapMiniHeader)
		if authSel {
			common |= 1<<spiceCapAuthSelection | 1<<spiceCapAuthSpice
		}
		body := make([]byte, 22)
		body[4] = spiceChannelMain
		binary.LittleEndian.PutUint32(body[6:], 1)
		binary.LittleEndian.PutUint32(body[14:], 18)
		binary.LittleEndian.PutUint32(body[18:], common)
		hdr := make([]byte, 16)
		binary.LittleEndian.PutUint32(hdr, spiceMagic)
		binary.LittleEndian.PutUint32(hdr[4:], 2)
		binary.LittleEndian.PutUint32(hdr[8:], 2)
		binary.LittleEndian.PutUint32(hdr[12:], uint32(len(body)))
		browser.Write(append(hdr, body...))
		_, reply, err := readSpiceLinkMsg(browser)
		if err != nil {
			t.Fatal(err)
		}
		if authSel {
			browser.Write([]byte{1, 0, 0, 0})
		}
		enc, err := encryptSpiceTicket(reply[4:4+spiceTicketPubKey], "") // the browser knows no ticket
		if err != nil {
			t.Fatal(err)
		}
		browser.Write(enc)
		var res [4]byte
		io.ReadFull(browser, res[:])
		if binary.LittleEndian.Uint32(res[:]) != 0 {
			t.Fatalf("link result %d", binary.LittleEndian.Uint32(res[:]))
		}
		if got := <-f.tickets; got != "tick3t" {
			t.Fatalf("server received ticket %q", got)
		}
		if err := <-errc; err != nil {
			t.Fatal(err)
		}
		browser.Close()
		server.Close()
	}
}

func TestSpiceProbe(t *testing.T) {
	f := newFakeSpice(t, "pw")
	res, err := SpiceProbe(context.Background(), f.dialer(t, "pw", true))
	if err != nil {
		t.Fatal(err)
	}
	if res.Resolution() != "1280x800" || len(res.Channels) != 2 || res.Channels[0] != "display" {
		t.Fatalf("probe %+v", res)
	}
	f2 := newFakeSpice(t, "pw")
	if _, err := SpiceProbe(context.Background(), f2.dialer(t, "wrong", true)); err == nil {
		t.Fatal("wrong ticket accepted")
	}
}

// TestSpiceSession drives the multiplexed session like spice-html5 does
// through the hub: main on channel 0, display opened as channel 1.
func TestSpiceSession(t *testing.T) {
	f := newFakeSpice(t, "secret")
	dial := f.dialer(t, "secret", true)
	first, _, _, _ := dial(context.Background())
	s := &spiceSession{dial: dial, first: first, firstPW: "secret", firstIn: true}

	lc := &frameRouter{in: make(chan wire.Frame, 64), chans: map[uint16]*io.PipeWriter{}, opened: map[uint16]chan bool{}, status: make(chan string, 8)}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- s.Run(ctx, lc.in, lc.out) }()

	var mu sync.Mutex
	next := uint16(0)
	browserDial := func(ctx context.Context) (io.ReadWriteCloser, string, bool, error) {
		mu.Lock()
		id := next
		next++
		mu.Unlock()
		c := lc.channel(id)
		if id > 0 {
			wait := make(chan bool, 1)
			lc.mu.Lock()
			lc.opened[id] = wait
			lc.mu.Unlock()
			b, _ := json.Marshal(wire.ConsoleControl{Type: "open", Channel: id})
			lc.in <- wire.Frame{Kind: wire.FrameControl, Payload: b}
			if !<-wait {
				return nil, "", false, errors.New("closed")
			}
		}
		return c, "", false, nil // the browser has no ticket
	}
	res, err := SpiceProbe(ctx, browserDial)
	if err != nil {
		t.Fatal(err)
	}
	if res.Resolution() != "1280x800" {
		t.Fatalf("resolution %q", res.Resolution())
	}
	// The passive scanner reports the resolution in a status message.
	deadline := time.After(5 * time.Second)
	for {
		select {
		case st := <-lc.status:
			if st == "1280x800" {
				goto ok
			}
		case <-deadline:
			t.Fatal("no status with resolution")
		}
	}
ok:
	// Too many channels are refused.
	for i := 0; i < spiceMaxChannels+2; i++ {
		b, _ := json.Marshal(wire.ConsoleControl{Type: "open", Channel: uint16(100 + i)})
		lc.in <- wire.Frame{Kind: wire.FrameControl, Payload: b}
	}
	close(lc.in)
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("session did not end")
	}
}

// frameRouter plays the browser side of a multi-channel session.
type frameRouter struct {
	in     chan wire.Frame
	mu     sync.Mutex
	chans  map[uint16]*io.PipeWriter
	opened map[uint16]chan bool
	status chan string
}

func (r *frameRouter) out(f wire.Frame) error {
	if f.Kind == wire.FrameData {
		r.mu.Lock()
		pw := r.chans[f.Channel]
		r.mu.Unlock()
		if pw != nil {
			pw.Write(f.Payload)
		}
		return nil
	}
	var cc wire.ConsoleControl
	json.Unmarshal(f.Payload, &cc)
	r.mu.Lock()
	defer r.mu.Unlock()
	switch cc.Type {
	case "opened", "closed":
		if w := r.opened[cc.Channel]; w != nil {
			w <- cc.Type == "opened"
			delete(r.opened, cc.Channel)
		}
	case "status":
		select {
		case r.status <- cc.Resolution:
		default:
		}
	}
	return nil
}

func (r *frameRouter) channel(id uint16) io.ReadWriteCloser {
	pr, pw := io.Pipe()
	r.mu.Lock()
	r.chans[id] = pw
	r.mu.Unlock()
	return &routerConn{r: r, id: id, pr: pr}
}

type routerConn struct {
	r  *frameRouter
	id uint16
	pr *io.PipeReader
}

func (c *routerConn) Read(p []byte) (int, error) { return c.pr.Read(p) }
func (c *routerConn) Write(p []byte) (int, error) {
	defer func() { recover() }() // in may be closed at the end of the test
	c.r.in <- wire.Frame{Kind: wire.FrameData, Channel: c.id, Payload: append([]byte(nil), p...)}
	return len(p), nil
}
func (c *routerConn) Close() error { return c.pr.Close() }

func TestSpiceScannerSplitInput(t *testing.T) {
	var got []string
	s := &spiceScanner{mini: true, onSize: func(w, h int) { got = append(got, string(rune('0'+w/1000))+"/"+string(rune('0'+h/100))) }}
	sc := make([]byte, 20)
	binary.LittleEndian.PutUint32(sc[4:], 1024)
	binary.LittleEndian.PutUint32(sc[8:], 768)
	binary.LittleEndian.PutUint32(sc[16:], spiceSurfacePrimary)
	stream := append(spiceMsg(304, make([]byte, 5000)), spiceMsg(spiceMsgSurfaceNew, sc)...)
	stream = append(stream, spiceMsg(spiceMsgSurfaceNew, make([]byte, 20))...) // non-primary
	for i := 0; i < len(stream); i += 7 {
		s.feed(stream[i:min(i+7, len(stream))])
	}
	if len(got) != 1 || got[0] != "1/7" {
		t.Fatalf("scanner reported %v", got)
	}
}

func lzHeader(typ, w, h uint32, topDown bool) []byte {
	b := make([]byte, 28)
	be := binary.BigEndian
	be.PutUint32(b[0:], lzMagic)
	be.PutUint32(b[4:], 0x00010001)
	be.PutUint32(b[8:], typ)
	be.PutUint32(b[12:], w)
	be.PutUint32(b[16:], h)
	be.PutUint32(b[20:], w*4)
	if topDown {
		be.PutUint32(b[24:], 1)
	}
	return b
}

func TestDecodeSpiceLZ(t *testing.T) {
	// 4x2: literal red, green; then a run of 6 copies of the previous pixel;
	// bottom-up rows.
	data := append(lzHeader(lzTypeRGB32, 4, 2, false),
		0x01, 0x00, 0x00, 0xff, 0x00, 0xff, 0x00, // 2 literal pixels (b,g,r)
		0xc0, 0x00, // reference: length 6, distance 1
	)
	img, err := decodeSpiceLZ(data)
	if err != nil {
		t.Fatal(err)
	}
	px := func(x, y int) [3]byte {
		o := img.PixOffset(x, y)
		return [3]byte{img.Pix[o], img.Pix[o+1], img.Pix[o+2]}
	}
	// Stream row 0 (red, green, green, green) is the bottom row.
	if px(0, 1) != [3]byte{0xff, 0, 0} || px(1, 1) != [3]byte{0, 0xff, 0} || px(3, 0) != [3]byte{0, 0xff, 0} {
		t.Fatalf("pixels %v %v %v", px(0, 1), px(1, 1), px(3, 0))
	}
	// Long run with extra length bytes and a far distance.
	n := 9000
	long := append(lzHeader(lzTypeRGB32, uint32(n), 1, true), 0x00, 0x10, 0x20, 0x30)
	// length = 7-1 + 255 + 255 + ... ; encode n-1 copies of pixel 0.
	rem := n - 1 - 1 // decoded length = 6 + extra + 1
	long = append(long, 0xe0)
	extra := rem - 6
	for extra >= 255 {
		long = append(long, 0xff)
		extra -= 255
	}
	long = append(long, byte(extra), 0x00)
	img, err = decodeSpiceLZ(long)
	if err != nil {
		t.Fatal(err)
	}
	if o := img.PixOffset(n-1, 0); img.Pix[o] != 0x30 || img.Pix[o+2] != 0x10 {
		t.Fatalf("last pixel %v", img.Pix[o:o+4])
	}
	if _, err := decodeSpiceLZ(append(lzHeader(lzTypeRGB32, 4, 2, true), 0xc0, 0x05)); err == nil {
		t.Fatal("reference before the start accepted")
	}
	if _, err := decodeSpiceLZ(lzHeader(lzTypeRGB32, 4, 2, true)); err == nil {
		t.Fatal("empty data accepted")
	}
}

func TestSpiceDrawCopy(t *testing.T) {
	canvas := image.NewRGBA(image.Rect(0, 0, 8, 4))
	// DRAW_COPY of a 2x2 raw bitmap at (4,1), no clip.
	msg := make([]byte, 0, 128)
	le := binary.LittleEndian
	u32 := func(v uint32) { msg = le.AppendUint32(msg, v) }
	u32(0) // surface
	u32(1)
	u32(4)
	u32(3)
	u32(6)               // box top, left, bottom, right
	msg = append(msg, 0) // clip none
	imgOff := len(msg) + 4 + 16 + 2 + 1 + 1 + 8 + 4
	u32(uint32(imgOff))
	u32(0)
	u32(0)
	u32(2)
	u32(2)                        // src area
	msg = append(msg, 8, 0, 0, 0) // rop, scale, mask flags
	msg = append(msg, make([]byte, 12)...)
	msg = append(msg, make([]byte, 8)...) // image id
	msg = append(msg, spiceImageBitmap, 0)
	u32(2)
	u32(2)
	msg = append(msg, spiceBitmapFmt32, spiceBitmapTopDown)
	u32(2)
	u32(2)
	u32(8)
	u32(0)
	msg = append(msg, 1, 2, 3, 0, 4, 5, 6, 0, 7, 8, 9, 0, 10, 11, 12, 0)
	if err := spiceDrawCopy(canvas, msg); err != nil {
		t.Fatal(err)
	}
	o := canvas.PixOffset(5, 2)
	if canvas.Pix[o] != 12 || canvas.Pix[o+1] != 11 || canvas.Pix[o+2] != 10 {
		t.Fatalf("pixel %v", canvas.Pix[o:o+4])
	}
	if canvas.Pix[canvas.PixOffset(0, 0)+2] != 0 {
		t.Fatal("drew outside the box")
	}
}
