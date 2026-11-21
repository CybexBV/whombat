package screen

import (
	"bufio"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"image"
	"io"
	"net"
	"sync"
	"time"

	"rackoon/internal/agent/rfb"
)

// RFB encodings the agent asks for: raw pixels (Screen Sharing is reached
// over loopback, so compressing costs more than it saves) and the desktop
// size pseudo-encoding, so a changed resolution is followed.
const (
	encRaw         = 0
	encDesktopSize = -223
)

// maxFramebuffer bounds a framebuffer the agent keeps (8K by 8K).
const maxFramebuffer = 8192

// rfbConn is a signed-in Screen Sharing connection. A reader goroutine keeps
// a copy of the screen from the updates the agent asks for and drains the
// server's other messages (bells, clipboard text, which is discarded).
type rfbConn struct {
	nc   net.Conn
	rw   io.ReadWriteCloser
	info *rfb.Info

	wmu sync.Mutex // one message at a time

	mu      sync.Mutex
	w, h    int
	fb      []byte // 4 bytes a pixel: blue, green, red, unused
	updates uint64
	notify  chan struct{} // closed and replaced after each update or when the reader stops
	err     error         // why the reader stopped

	signedIn time.Time // when the sign-in went through
}

// dialRFB connects to Screen Sharing and signs in with the account. The
// error wraps rfb.ErrAuth when the account was refused, errNoScreen when
// nothing answers and errSharingNotApple when something else does.
func (s *Screen) dialRFB(ctx context.Context, acct Account) (*rfbConn, error) {
	nc, rw, info, err := s.handshake(ctx, acct)
	if err != nil {
		return nil, err
	}
	if info.Width <= 0 || info.Height <= 0 || info.Width > maxFramebuffer || info.Height > maxFramebuffer {
		nc.Close()
		return nil, fmt.Errorf("vnc: unusable screen size %dx%d", info.Width, info.Height)
	}
	c := &rfbConn{nc: nc, rw: rw, info: info, w: info.Width, h: info.Height, notify: make(chan struct{}), signedIn: time.Now()}
	c.fb = make([]byte, c.w*c.h*4)
	// 32 bits a pixel, depth 24, little endian, true colour, red at bit 16,
	// green at 8, blue at 0: the bytes are blue, green, red, unused.
	pf := []byte{0, 0, 0, 0, 32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0}
	enc := []byte{2, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0}
	putInt32(enc[4:], encRaw)
	putInt32(enc[8:], encDesktopSize)
	if _, err := rw.Write(append(pf, enc...)); err != nil {
		nc.Close()
		return nil, err
	}
	nc.SetDeadline(time.Time{})
	go c.read()
	return c, nil
}

func putInt32(b []byte, v int32) { binary.BigEndian.PutUint32(b, uint32(v)) }

func (c *rfbConn) close() { c.rw.Close() }

// alive reports whether the reader still runs.
func (c *rfbConn) alive() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.err == nil
}

func (c *rfbConn) size() (int, int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.w, c.h
}

func (c *rfbConn) stop(err error) {
	c.mu.Lock()
	if c.err == nil {
		if err == nil {
			err = io.EOF
		}
		c.err = err
		close(c.notify)
	}
	c.mu.Unlock()
	c.rw.Close()
}

// read handles the server's messages until the connection ends.
func (c *rfbConn) read() {
	br := bufio.NewReaderSize(c.rw, 256<<10)
	var err error
	for err == nil {
		var t byte
		if t, err = br.ReadByte(); err != nil {
			break
		}
		switch t {
		case 0: // FramebufferUpdate
			err = c.readUpdate(br)
		case 1: // SetColourMapEntries (not used with true colour)
			var hdr [5]byte
			if _, err = io.ReadFull(br, hdr[:]); err == nil {
				_, err = br.Discard(int(binary.BigEndian.Uint16(hdr[3:5])) * 6)
			}
		case 2: // Bell
		case 3: // ServerCutText: the Mac's clipboard, never kept
			var hdr [7]byte
			if _, err = io.ReadFull(br, hdr[:]); err == nil {
				n := binary.BigEndian.Uint32(hdr[3:7])
				if n > 64<<20 {
					err = errors.New("vnc: clipboard text too long")
				} else {
					_, err = io.CopyN(io.Discard, br, int64(n))
				}
			}
		default:
			err = fmt.Errorf("vnc: unexpected server message %d", t)
		}
	}
	c.stop(err)
}

func (c *rfbConn) readUpdate(br *bufio.Reader) error {
	var hdr [3]byte
	if _, err := io.ReadFull(br, hdr[:]); err != nil {
		return err
	}
	n := int(binary.BigEndian.Uint16(hdr[1:3]))
	var row []byte
	for i := 0; i < n; i++ {
		var rh [12]byte
		if _, err := io.ReadFull(br, rh[:]); err != nil {
			return err
		}
		x := int(binary.BigEndian.Uint16(rh[0:2]))
		y := int(binary.BigEndian.Uint16(rh[2:4]))
		w := int(binary.BigEndian.Uint16(rh[4:6]))
		h := int(binary.BigEndian.Uint16(rh[6:8]))
		enc := int32(binary.BigEndian.Uint32(rh[8:12]))
		switch enc {
		case encRaw:
			c.mu.Lock()
			fw, fh := c.w, c.h
			c.mu.Unlock()
			if x+w > fw || y+h > fh {
				return fmt.Errorf("vnc: rectangle %dx%d+%d+%d outside the %dx%d screen", w, h, x, y, fw, fh)
			}
			if cap(row) < w*4 {
				row = make([]byte, w*4)
			}
			row = row[:w*4]
			for yy := 0; yy < h; yy++ {
				if _, err := io.ReadFull(br, row); err != nil {
					return err
				}
				c.mu.Lock()
				if c.w == fw { // not resized meanwhile
					copy(c.fb[((y+yy)*fw+x)*4:], row)
				}
				c.mu.Unlock()
			}
		case encDesktopSize:
			if w <= 0 || h <= 0 || w > maxFramebuffer || h > maxFramebuffer {
				return fmt.Errorf("vnc: unusable screen size %dx%d", w, h)
			}
			c.mu.Lock()
			c.w, c.h = w, h
			c.fb = make([]byte, w*h*4)
			c.mu.Unlock()
		default:
			return fmt.Errorf("vnc: unexpected encoding %d", enc)
		}
	}
	c.mu.Lock()
	c.updates++
	close(c.notify)
	c.notify = make(chan struct{})
	c.mu.Unlock()
	return nil
}

func (c *rfbConn) write(b []byte) error {
	c.wmu.Lock()
	defer c.wmu.Unlock()
	c.nc.SetWriteDeadline(time.Now().Add(5 * time.Second))
	_, err := c.rw.Write(b)
	return err
}

// look asks for the whole screen and returns it once it arrived.
func (c *rfbConn) look(ctx context.Context) (*image.RGBA, error) {
	for attempt := 0; ; attempt++ {
		c.mu.Lock()
		w, h, before, err := c.w, c.h, c.updates, c.err
		c.mu.Unlock()
		if err != nil {
			return nil, err
		}
		req := []byte{3, 0, 0, 0, 0, 0, 0, 0, 0, 0}
		binary.BigEndian.PutUint16(req[6:], uint16(w))
		binary.BigEndian.PutUint16(req[8:], uint16(h))
		if err := c.write(req); err != nil {
			return nil, err
		}
		if err := c.waitUpdate(ctx, before); err != nil {
			return nil, err
		}
		c.mu.Lock()
		if (c.w != w || c.h != h) && attempt == 0 {
			// The screen changed size while it was sent: ask again.
			c.mu.Unlock()
			continue
		}
		img := image.NewRGBA(image.Rect(0, 0, c.w, c.h))
		fb, pix := c.fb, img.Pix
		for i := 0; i+3 < len(fb) && i+3 < len(pix); i += 4 {
			pix[i], pix[i+1], pix[i+2], pix[i+3] = fb[i+2], fb[i+1], fb[i], 0xff
		}
		c.mu.Unlock()
		return img, nil
	}
}

func (c *rfbConn) waitUpdate(ctx context.Context, after uint64) error {
	for {
		c.mu.Lock()
		if c.updates > after {
			c.mu.Unlock()
			return nil
		}
		if c.err != nil {
			err := c.err
			c.mu.Unlock()
			return err
		}
		ch := c.notify
		c.mu.Unlock()
		select {
		case <-ch:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}

// Pointer buttons (RFB button mask bits).
const (
	btnLeft       = 1
	btnMiddle     = 2
	btnRight      = 4
	btnWheelUp    = 8
	btnWheelDown  = 16
	btnWheelLeft  = 32
	btnWheelRight = 64
)

func (c *rfbConn) pointer(x, y int, mask byte) error {
	b := []byte{5, mask, 0, 0, 0, 0}
	binary.BigEndian.PutUint16(b[2:], uint16(x))
	binary.BigEndian.PutUint16(b[4:], uint16(y))
	return c.write(b)
}

func (c *rfbConn) key(sym uint32, down bool) error {
	b := []byte{4, 0, 0, 0, 0, 0, 0, 0}
	if down {
		b[1] = 1
	}
	binary.BigEndian.PutUint32(b[4:], sym)
	return c.write(b)
}
