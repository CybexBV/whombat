package broker

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha1"
	"crypto/x509"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"strconv"
	"sync"
	"time"

	"rackoon/internal/proto"
	"rackoon/internal/wire"
)

// SPICE protocol constants (spice-protocol: spice/protocol.h, enums.h).
const (
	spiceMagic        = 0x51444552 // "REDQ"
	spiceVersionMajor = 2
	spiceVersionMinor = 2
	spiceTicketPubKey = 162

	spiceCapAuthSelection = 0
	spiceCapAuthSpice     = 1
	spiceCapMiniHeader    = 3

	spiceAuthMechSpice = 1

	spiceChannelMain    = 1
	spiceChannelDisplay = 2

	spiceMsgSetAck       = 3
	spiceMsgPing         = 4
	spiceMsgcAckSync     = 1
	spiceMsgcAck         = 2
	spiceMsgcPong        = 3
	spiceMsgMainInit     = 103
	spiceMsgMainChanList = 104
	spiceMsgcMainAttach  = 104
	spiceMsgDisplayMode  = 101
	spiceMsgSurfaceNew   = 314
	spiceMsgcDisplayInit = 101

	spiceSurfacePrimary = 1

	spiceMaxLinkSize = 4096
	// spiceMaxChannels bounds the sub-channels of one session.
	spiceMaxChannels = 16
)

var spiceChannelNames = map[uint8]string{
	1: "main", 2: "display", 3: "inputs", 4: "cursor", 5: "playback",
	6: "record", 7: "tunnel", 8: "smartcard", 9: "usbredir", 10: "port", 11: "webdav",
}

// spiceLink is what the agent learned while relaying a channel's link phase.
type spiceLink struct {
	ChannelType uint8
	ChannelID   uint8
	MiniHeader  bool
}

func hasCap(caps []uint32, bit int) bool {
	w := bit / 32
	return w < len(caps) && caps[w]&(1<<(bit%32)) != 0
}

func readSpiceLinkMsg(r io.Reader) (hdr [16]byte, body []byte, err error) {
	if _, err = io.ReadFull(r, hdr[:]); err != nil {
		return
	}
	if binary.LittleEndian.Uint32(hdr[0:4]) != spiceMagic {
		err = errors.New("spice: bad link magic")
		return
	}
	if binary.LittleEndian.Uint32(hdr[4:8]) != spiceVersionMajor {
		err = fmt.Errorf("spice: unsupported major version %d", binary.LittleEndian.Uint32(hdr[4:8]))
		return
	}
	size := binary.LittleEndian.Uint32(hdr[12:16])
	if size > spiceMaxLinkSize {
		err = errors.New("spice: link message too large")
		return
	}
	body = make([]byte, size)
	_, err = io.ReadFull(r, body)
	return
}

// parseCaps reads the capability words at offset off of a link body.
func parseCaps(body []byte, off, nCommon, nChannel uint32) (common, channel []uint32, err error) {
	if nCommon > 64 || nChannel > 64 || uint64(off)+4*uint64(nCommon+nChannel) > uint64(len(body)) {
		return nil, nil, errors.New("spice: bad capability list")
	}
	for i := uint32(0); i < nCommon; i++ {
		common = append(common, binary.LittleEndian.Uint32(body[off+4*i:]))
	}
	for i := uint32(0); i < nChannel; i++ {
		channel = append(channel, binary.LittleEndian.Uint32(body[off+4*(nCommon+i):]))
	}
	return common, channel, nil
}

// encryptSpiceTicket encrypts the password (NUL terminated) with the
// server's link public key (RSA-OAEP, SHA-1), as SPICE clients do.
func encryptSpiceTicket(pubDER []byte, password string) ([]byte, error) {
	k, err := x509.ParsePKIXPublicKey(pubDER)
	if err != nil {
		return nil, fmt.Errorf("spice: link public key: %w", err)
	}
	pub, ok := k.(*rsa.PublicKey)
	if !ok {
		return nil, errors.New("spice: link key is not RSA")
	}
	return rsa.EncryptOAEP(sha1.New(), rand.Reader, pub, append([]byte(password), 0), nil)
}

func spiceTicketSize(pubDER []byte) int {
	if k, err := x509.ParsePKIXPublicKey(pubDER); err == nil {
		if pub, ok := k.(*rsa.PublicKey); ok {
			return pub.Size()
		}
	}
	return 128
}

// SpiceLinkProxy relays the link phase of one SPICE channel between the
// browser (client) and the server. When inject is true the agent replaces
// the browser's encrypted ticket with its own encryption of password, so
// the browser never learns the ticket. After a successful return the
// caller splices the two streams.
func SpiceLinkProxy(client, server io.ReadWriter, password string, inject bool) (*spiceLink, error) {
	chdr, cbody, err := readSpiceLinkMsg(client)
	if err != nil {
		return nil, fmt.Errorf("browser link: %w", err)
	}
	if len(cbody) < 18 {
		return nil, errors.New("spice: short link message")
	}
	link := &spiceLink{ChannelType: cbody[4], ChannelID: cbody[5]}
	cCommon, _, err := parseCaps(cbody, binary.LittleEndian.Uint32(cbody[14:18]),
		binary.LittleEndian.Uint32(cbody[6:10]), binary.LittleEndian.Uint32(cbody[10:14]))
	if err != nil {
		return nil, err
	}
	if _, err := server.Write(append(chdr[:], cbody...)); err != nil {
		return nil, err
	}
	shdr, sbody, err := readSpiceLinkMsg(server)
	if err != nil {
		return nil, fmt.Errorf("server link: %w", err)
	}
	if _, err := client.Write(append(shdr[:], sbody...)); err != nil {
		return nil, err
	}
	if len(sbody) < 4 {
		return nil, errors.New("spice: short link reply")
	}
	if e := binary.LittleEndian.Uint32(sbody[0:4]); e != 0 {
		return nil, fmt.Errorf("spice: server refused the link (error %d)", e)
	}
	if len(sbody) < 178 {
		return nil, errors.New("spice: short link reply")
	}
	pubKey := sbody[4 : 4+spiceTicketPubKey]
	sCommon, _, err := parseCaps(sbody, binary.LittleEndian.Uint32(sbody[174:178]),
		binary.LittleEndian.Uint32(sbody[166:170]), binary.LittleEndian.Uint32(sbody[170:174]))
	if err != nil {
		return nil, err
	}
	link.MiniHeader = hasCap(cCommon, spiceCapMiniHeader) && hasCap(sCommon, spiceCapMiniHeader)

	if hasCap(cCommon, spiceCapAuthSelection) {
		var mech [4]byte
		if _, err := io.ReadFull(client, mech[:]); err != nil {
			return nil, err
		}
		if binary.LittleEndian.Uint32(mech[:]) != spiceAuthMechSpice {
			if inject {
				return nil, errors.New("spice: browser chose an authentication method the agent cannot complete")
			}
			if _, err := server.Write(mech[:]); err != nil {
				return nil, err
			}
			return link, nil // SASL etc.: relay as is
		}
		if _, err := server.Write(mech[:]); err != nil {
			return nil, err
		}
	}
	ticket := make([]byte, spiceTicketSize(pubKey))
	if _, err := io.ReadFull(client, ticket); err != nil {
		return nil, err
	}
	if inject {
		if ticket, err = encryptSpiceTicket(pubKey, password); err != nil {
			return nil, err
		}
	}
	if _, err := server.Write(ticket); err != nil {
		return nil, err
	}
	var res [4]byte
	if _, err := io.ReadFull(server, res[:]); err != nil {
		return nil, fmt.Errorf("spice: reading link result: %w", err)
	}
	if _, err := client.Write(res[:]); err != nil {
		return nil, err
	}
	if r := binary.LittleEndian.Uint32(res[:]); r != 0 {
		return nil, fmt.Errorf("spice: authentication failed (link error %d)", r)
	}
	return link, nil
}

// spiceScanner follows SPICE message framing on a server-to-client
// display stream and reports the primary surface size.
type spiceScanner struct {
	mini    bool
	hdr     []byte
	need    int // payload bytes remaining in the current message
	typ     uint16
	capture []byte
	onSize  func(w, h int)
}

func (s *spiceScanner) hdrLen() int {
	if s.mini {
		return 6
	}
	return 18
}

func (s *spiceScanner) feed(p []byte) {
	for len(p) > 0 {
		if s.need == 0 && s.capture == nil {
			n := s.hdrLen() - len(s.hdr)
			if n > len(p) {
				n = len(p)
			}
			s.hdr = append(s.hdr, p[:n]...)
			p = p[n:]
			if len(s.hdr) < s.hdrLen() {
				return
			}
			var size uint32
			if s.mini {
				s.typ = binary.LittleEndian.Uint16(s.hdr[0:2])
				size = binary.LittleEndian.Uint32(s.hdr[2:6])
			} else {
				s.typ = binary.LittleEndian.Uint16(s.hdr[8:10])
				size = binary.LittleEndian.Uint32(s.hdr[10:14])
			}
			s.hdr = s.hdr[:0]
			s.need = int(size)
			if (s.typ == spiceMsgSurfaceNew && size >= 20) || (s.typ == spiceMsgDisplayMode && size >= 12) {
				s.capture = make([]byte, 0, 20)
			}
			if s.need == 0 {
				s.capture = nil
			}
			continue
		}
		n := s.need
		if n > len(p) {
			n = len(p)
		}
		if s.capture != nil && len(s.capture) < cap(s.capture) {
			c := cap(s.capture) - len(s.capture)
			if c > n {
				c = n
			}
			s.capture = append(s.capture, p[:c]...)
		}
		s.need -= n
		p = p[n:]
		if s.need == 0 && s.capture != nil {
			s.handle()
			s.capture = nil
		}
	}
}

func (s *spiceScanner) handle() {
	c := s.capture
	switch {
	case s.typ == spiceMsgSurfaceNew && len(c) >= 20:
		if binary.LittleEndian.Uint32(c[16:20])&spiceSurfacePrimary != 0 {
			s.onSize(int(binary.LittleEndian.Uint32(c[4:8])), int(binary.LittleEndian.Uint32(c[8:12])))
		}
	case s.typ == spiceMsgDisplayMode && len(c) >= 12:
		s.onSize(int(binary.LittleEndian.Uint32(c[0:4])), int(binary.LittleEndian.Uint32(c[4:8])))
	}
}

// spiceDialer opens one new connection to the guest's SPICE server and
// returns the ticket to inject ("" with inject=false when no password is
// set).
type spiceDialer func(ctx context.Context) (conn io.ReadWriteCloser, password string, inject bool, err error)

// spiceSession multiplexes SPICE channel connections over one console
// session: rackoon channel 0 is the first (main) connection, further
// channels are opened by the browser with {"type":"open","channel":N}.
// Implements agent.ConsoleSession.
type spiceSession struct {
	dial    spiceDialer
	first   io.ReadWriteCloser // already dialed channel 0
	firstPW string
	firstIn bool
	cleanup func()

	mu     sync.Mutex
	chans  map[uint16]*spiceChan
	res    string
	closed bool
	once   sync.Once
}

type spiceChan struct {
	id     uint16
	q      chan []byte
	conn   io.ReadWriteCloser
	cancel context.CancelFunc
	done   chan struct{}
}

func (s *spiceSession) closeAll() {
	s.once.Do(func() {
		s.mu.Lock()
		s.closed = true
		type pending struct {
			cancel context.CancelFunc
			conn   io.ReadWriteCloser
		}
		var chans []pending
		for _, c := range s.chans {
			chans = append(chans, pending{c.cancel, c.conn})
		}
		first := s.first
		s.first = nil
		s.mu.Unlock()
		for _, c := range chans {
			c.cancel()
			if c.conn != nil {
				c.conn.Close()
			}
		}
		if first != nil {
			first.Close()
		}
		if s.cleanup != nil {
			s.cleanup()
		}
	})
}

func (s *spiceSession) Run(ctx context.Context, in <-chan wire.Frame, out func(wire.Frame) error) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	stop := context.AfterFunc(ctx, s.closeAll)
	defer stop()
	defer s.closeAll()
	s.mu.Lock()
	s.chans = map[uint16]*spiceChan{}
	first := s.first
	s.first = nil
	s.mu.Unlock()
	if ctx.Err() != nil || first == nil {
		if first != nil {
			first.Close()
		}
		return ctx.Err()
	}
	if err := sendStatus(out, proto.ProtoSPICE, ""); err != nil {
		first.Close()
		return err
	}
	mainDone := make(chan struct{})
	s.startChan(ctx, 0, first, s.firstPW, s.firstIn, out, mainDone)

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-mainDone:
			return nil // the main channel ended: the SPICE session is over
		case f, ok := <-in:
			if !ok {
				return nil
			}
			switch f.Kind {
			case wire.FrameData:
				s.mu.Lock()
				c := s.chans[f.Channel]
				s.mu.Unlock()
				if c == nil || len(f.Payload) == 0 {
					continue
				}
				select {
				case c.q <- f.Payload:
				case <-c.done:
				case <-ctx.Done():
					return ctx.Err()
				}
			case wire.FrameControl:
				cc, ok := parseControl(f)
				if !ok {
					continue
				}
				switch cc.Type {
				case "open":
					s.open(ctx, cc.Channel, out)
				case "close":
					if cc.Channel == 0 {
						return nil
					}
					s.mu.Lock()
					c := s.chans[cc.Channel]
					s.mu.Unlock()
					if c != nil {
						c.cancel()
						if c.conn != nil {
							c.conn.Close()
						}
					}
				}
			}
		}
	}
}

func (s *spiceSession) open(ctx context.Context, id uint16, out func(wire.Frame) error) {
	s.mu.Lock()
	_, exists := s.chans[id]
	n := len(s.chans)
	s.mu.Unlock()
	if id == 0 || exists {
		sendControl(out, wire.ConsoleControl{Type: "error", Code: "bad_channel", Message: "channel " + strconv.Itoa(int(id)) + " is already open"})
		return
	}
	if n >= spiceMaxChannels {
		sendControl(out, wire.ConsoleControl{Type: "error", Code: "too_many_channels", Message: "too many SPICE channels"})
		sendControl(out, wire.ConsoleControl{Type: "closed", Channel: id})
		return
	}
	// Register first so data frames that arrive while dialing are queued.
	cctx, cancel := context.WithCancel(ctx)
	c := &spiceChan{id: id, q: make(chan []byte, 64), cancel: cancel, done: make(chan struct{})}
	s.mu.Lock()
	s.chans[id] = c
	s.mu.Unlock()
	go func() {
		dctx, dcancel := context.WithTimeout(cctx, 20*time.Second)
		conn, pw, inject, err := s.dial(dctx)
		dcancel()
		if err != nil {
			s.mu.Lock()
			delete(s.chans, id)
			s.mu.Unlock()
			close(c.done)
			cancel()
			sendControl(out, wire.ConsoleControl{Type: "error", Code: "open_failed", Message: "SPICE channel could not be opened"})
			sendControl(out, wire.ConsoleControl{Type: "closed", Channel: id})
			return
		}
		s.runChan(cctx, c, conn, pw, inject, out, nil)
	}()
}

func (s *spiceSession) startChan(ctx context.Context, id uint16, conn io.ReadWriteCloser, pw string, inject bool, out func(wire.Frame) error, done chan struct{}) {
	cctx, cancel := context.WithCancel(ctx)
	c := &spiceChan{id: id, q: make(chan []byte, 64), cancel: cancel, done: make(chan struct{})}
	s.mu.Lock()
	s.chans[id] = c
	s.mu.Unlock()
	go s.runChan(cctx, c, conn, pw, inject, out, done)
}

// runChan relays one SPICE connection: link phase with ticket injection,
// then raw bytes both ways.
func (s *spiceSession) runChan(ctx context.Context, c *spiceChan, conn io.ReadWriteCloser, pw string, inject bool, out func(wire.Frame) error, done chan struct{}) {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		conn.Close()
		return
	}
	c.conn = conn
	s.mu.Unlock()
	stop := context.AfterFunc(ctx, func() { conn.Close() })
	defer stop()
	defer func() {
		conn.Close()
		c.cancel()
		close(c.done)
		s.mu.Lock()
		if s.chans[c.id] == c {
			delete(s.chans, c.id)
		}
		closed := s.closed
		s.mu.Unlock()
		if !closed && c.id != 0 {
			sendControl(out, wire.ConsoleControl{Type: "closed", Channel: c.id})
		}
		if done != nil {
			close(done)
		}
	}()
	if c.id != 0 {
		if err := sendControl(out, wire.ConsoleControl{Type: "opened", Channel: c.id}); err != nil {
			return
		}
	}
	browser := &chanConn{ctx: ctx, q: c.q, id: c.id, out: out}
	link, err := SpiceLinkProxy(browser, conn, pw, inject)
	if err != nil {
		return
	}
	var scan *spiceScanner
	if link.ChannelType == spiceChannelDisplay {
		scan = &spiceScanner{mini: link.MiniHeader, onSize: func(w, h int) {
			res := strconv.Itoa(w) + "x" + strconv.Itoa(h)
			s.mu.Lock()
			changed := res != s.res
			s.res = res
			s.mu.Unlock()
			if changed {
				sendStatus(out, proto.ProtoSPICE, res)
			}
		}}
	}
	errc := make(chan error, 2)
	go func() { _, err := io.Copy(conn, browser); errc <- err }()
	go func() {
		buf := make([]byte, 64<<10)
		for {
			n, err := conn.Read(buf)
			if n > 0 {
				if scan != nil {
					scan.feed(buf[:n])
				}
				p := make([]byte, n)
				copy(p, buf[:n])
				if werr := out(wire.Frame{Kind: wire.FrameData, Channel: c.id, Payload: p}); werr != nil {
					errc <- werr
					return
				}
			}
			if err != nil {
				errc <- err
				return
			}
		}
	}()
	<-errc
}

// chanConn is the browser side of one SPICE channel.
type chanConn struct {
	ctx     context.Context
	q       chan []byte
	id      uint16
	out     func(wire.Frame) error
	pending []byte
}

func (c *chanConn) Read(p []byte) (int, error) {
	for len(c.pending) == 0 {
		select {
		case <-c.ctx.Done():
			return 0, io.EOF
		case b, ok := <-c.q:
			if !ok {
				return 0, io.EOF
			}
			c.pending = b
		}
	}
	n := copy(p, c.pending)
	c.pending = c.pending[n:]
	return n, nil
}

func (c *chanConn) Write(p []byte) (int, error) {
	b := make([]byte, len(p))
	copy(b, p)
	if err := c.out(wire.Frame{Kind: wire.FrameData, Channel: c.id, Payload: b}); err != nil {
		return 0, err
	}
	return len(p), nil
}

// ---- probe client --------------------------------------------------------------

// SpiceProbeResult is what a short SPICE client connection found.
type SpiceProbeResult struct {
	Width, Height int
	Channels      []string // channel list announced by the server
}

// Resolution formats the primary surface size.
func (r *SpiceProbeResult) Resolution() string {
	if r == nil || r.Width == 0 {
		return ""
	}
	return strconv.Itoa(r.Width) + "x" + strconv.Itoa(r.Height)
}

type spiceClientConn struct {
	rw   io.ReadWriteCloser
	mini bool
	// ack window handling
	ackGen    uint32
	ackWindow uint32
	received  uint32
}

func spiceLinkClient(rw io.ReadWriteCloser, connID uint32, chType uint8, password string) (*spiceClientConn, uint32, error) {
	common := uint32(1<<spiceCapAuthSelection | 1<<spiceCapAuthSpice | 1<<spiceCapMiniHeader)
	body := make([]byte, 18+4)
	binary.LittleEndian.PutUint32(body[0:], connID)
	body[4] = chType
	body[5] = 0
	binary.LittleEndian.PutUint32(body[6:], 1)  // common caps
	binary.LittleEndian.PutUint32(body[10:], 0) // channel caps
	binary.LittleEndian.PutUint32(body[14:], 18)
	binary.LittleEndian.PutUint32(body[18:], common)
	hdr := make([]byte, 16)
	binary.LittleEndian.PutUint32(hdr[0:], spiceMagic)
	binary.LittleEndian.PutUint32(hdr[4:], spiceVersionMajor)
	binary.LittleEndian.PutUint32(hdr[8:], spiceVersionMinor)
	binary.LittleEndian.PutUint32(hdr[12:], uint32(len(body)))
	if _, err := rw.Write(append(hdr, body...)); err != nil {
		return nil, 0, err
	}
	_, sbody, err := readSpiceLinkMsg(rw)
	if err != nil {
		return nil, 0, err
	}
	if len(sbody) < 178 {
		return nil, 0, errors.New("spice: short link reply")
	}
	if e := binary.LittleEndian.Uint32(sbody[0:4]); e != 0 {
		return nil, 0, fmt.Errorf("spice: link refused (error %d)", e)
	}
	sCommon, _, err := parseCaps(sbody, binary.LittleEndian.Uint32(sbody[174:178]),
		binary.LittleEndian.Uint32(sbody[166:170]), binary.LittleEndian.Uint32(sbody[170:174]))
	if err != nil {
		return nil, 0, err
	}
	var mech [4]byte
	binary.LittleEndian.PutUint32(mech[:], spiceAuthMechSpice)
	if _, err := rw.Write(mech[:]); err != nil {
		return nil, 0, err
	}
	ticket, err := encryptSpiceTicket(sbody[4:4+spiceTicketPubKey], password)
	if err != nil {
		return nil, 0, err
	}
	if _, err := rw.Write(ticket); err != nil {
		return nil, 0, err
	}
	var res [4]byte
	if _, err := io.ReadFull(rw, res[:]); err != nil {
		return nil, 0, err
	}
	if r := binary.LittleEndian.Uint32(res[:]); r != 0 {
		return nil, 0, fmt.Errorf("spice: authentication failed (link error %d)", r)
	}
	return &spiceClientConn{rw: rw, mini: hasCap(sCommon, spiceCapMiniHeader)}, connID, nil
}

func (c *spiceClientConn) send(typ uint16, payload []byte) error {
	var hdr []byte
	if c.mini {
		hdr = make([]byte, 6)
		binary.LittleEndian.PutUint16(hdr[0:], typ)
		binary.LittleEndian.PutUint32(hdr[2:], uint32(len(payload)))
	} else {
		hdr = make([]byte, 18)
		binary.LittleEndian.PutUint16(hdr[8:], typ)
		binary.LittleEndian.PutUint32(hdr[10:], uint32(len(payload)))
	}
	_, err := c.rw.Write(append(hdr, payload...))
	return err
}

// recv reads one message, answering set_ack, ping and the ack window.
func (c *spiceClientConn) recv() (uint16, []byte, error) {
	for {
		var typ uint16
		var size uint32
		if c.mini {
			var h [6]byte
			if _, err := io.ReadFull(c.rw, h[:]); err != nil {
				return 0, nil, err
			}
			typ, size = binary.LittleEndian.Uint16(h[0:2]), binary.LittleEndian.Uint32(h[2:6])
		} else {
			var h [18]byte
			if _, err := io.ReadFull(c.rw, h[:]); err != nil {
				return 0, nil, err
			}
			typ, size = binary.LittleEndian.Uint16(h[8:10]), binary.LittleEndian.Uint32(h[10:14])
		}
		if size > 64<<20 {
			return 0, nil, errors.New("spice: message too large")
		}
		payload := make([]byte, size)
		if _, err := io.ReadFull(c.rw, payload); err != nil {
			return 0, nil, err
		}
		c.received++
		if c.ackWindow > 0 && c.received >= c.ackWindow {
			c.received = 0
			if err := c.send(spiceMsgcAck, nil); err != nil {
				return 0, nil, err
			}
		}
		switch typ {
		case spiceMsgSetAck:
			if len(payload) >= 8 {
				c.ackGen = binary.LittleEndian.Uint32(payload[0:4])
				c.ackWindow = binary.LittleEndian.Uint32(payload[4:8])
				c.received = 0
				var g [4]byte
				binary.LittleEndian.PutUint32(g[:], c.ackGen)
				if err := c.send(spiceMsgcAckSync, g[:]); err != nil {
					return 0, nil, err
				}
			}
			continue
		case spiceMsgPing:
			if err := c.send(spiceMsgcPong, payload[:min(len(payload), 12)]); err != nil {
				return 0, nil, err
			}
			continue
		}
		return typ, payload, nil
	}
}

// SpiceProbe connects as a minimal SPICE client (main + display channel)
// and reports the primary surface size. Note that SPICE servers allow one
// client: a probe disconnects any other client of the guest, so it is only
// used before a session starts and by console-test.
func SpiceProbe(ctx context.Context, dial spiceDialer) (*SpiceProbeResult, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	mainConn, pw, _, err := dial(ctx)
	if err != nil {
		return nil, err
	}
	defer mainConn.Close()
	stop := context.AfterFunc(ctx, func() { mainConn.Close() })
	defer stop()
	mc, _, err := spiceLinkClient(mainConn, 0, spiceChannelMain, pw)
	if err != nil {
		return nil, fmt.Errorf("main channel: %w", err)
	}
	res := &SpiceProbeResult{}
	var sessionID uint32
	for {
		typ, p, err := mc.recv()
		if err != nil {
			return nil, fmt.Errorf("main channel: %w", err)
		}
		if typ == spiceMsgMainInit && len(p) >= 4 {
			sessionID = binary.LittleEndian.Uint32(p[0:4])
			break
		}
	}
	if err := mc.send(spiceMsgcMainAttach, nil); err != nil {
		return nil, err
	}
	for {
		typ, p, err := mc.recv()
		if err != nil {
			return nil, fmt.Errorf("main channel: %w", err)
		}
		if typ == spiceMsgMainChanList && len(p) >= 4 {
			n := int(binary.LittleEndian.Uint32(p[0:4]))
			for i := 0; i < n && 4+2*i+1 < len(p); i++ {
				name := spiceChannelNames[p[4+2*i]]
				if name == "" {
					name = strconv.Itoa(int(p[4+2*i]))
				}
				res.Channels = append(res.Channels, name)
			}
			break
		}
	}
	dispConn, pw2, _, err := dial(ctx)
	if err != nil {
		return res, fmt.Errorf("display channel: %w", err)
	}
	defer dispConn.Close()
	stop2 := context.AfterFunc(ctx, func() { dispConn.Close() })
	defer stop2()
	if pw2 == "" {
		pw2 = pw
	}
	dc, _, err := spiceLinkClient(dispConn, sessionID, spiceChannelDisplay, pw2)
	if err != nil {
		return res, fmt.Errorf("display channel: %w", err)
	}
	init := make([]byte, 14) // pixmap cache id/size, glz dictionary id/window
	binary.LittleEndian.PutUint64(init[1:], 0)
	binary.LittleEndian.PutUint32(init[10:], 0)
	if err := dc.send(spiceMsgcDisplayInit, init); err != nil {
		return res, err
	}
	for {
		typ, p, err := dc.recv()
		if err != nil {
			return res, fmt.Errorf("display channel: %w", err)
		}
		switch {
		case typ == spiceMsgSurfaceNew && len(p) >= 20 && binary.LittleEndian.Uint32(p[16:20])&spiceSurfacePrimary != 0:
			res.Width, res.Height = int(binary.LittleEndian.Uint32(p[4:8])), int(binary.LittleEndian.Uint32(p[8:12]))
			return res, nil
		case typ == spiceMsgDisplayMode && len(p) >= 12:
			res.Width, res.Height = int(binary.LittleEndian.Uint32(p[0:4])), int(binary.LittleEndian.Uint32(p[4:8]))
			return res, nil
		}
	}
}
