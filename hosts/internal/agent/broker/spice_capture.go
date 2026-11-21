package broker

import (
	"bufio"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"image"
	"os"
	"strings"
	"time"
)

// SPICE display messages and image types used by the screen capture.
const (
	spiceMsgDisplayMark     = 102
	spiceMsgDisplayDrawFill = 302
	spiceMsgDisplayDrawCopy = 304

	spiceClipRects  = 1
	spiceBrushSolid = 1

	spiceImageBitmap = 0
	spiceImageQUIC   = 1
	spiceImageLZRGB  = 101
	spiceImageGLZRGB = 102

	spiceBitmapFmt24   = 7
	spiceBitmapFmt32   = 8
	spiceBitmapFmtRGBA = 9
	spiceBitmapTopDown = 4

	lzMagic       = 0x20205a4c // "LZ  " read big-endian as "  ZL"
	lzTypeRGB24   = 7
	lzTypeRGB32   = 8
	lzTypeRGBA    = 9
	lzMaxCopy     = 32
	lzMaxDistance = 8191
)

// ErrSpiceBusy is returned when a SPICE client is connected: a new SPICE
// client would disconnect it.
var ErrSpiceBusy = errors.New("a SPICE console is open for this VM")

// SpiceCapture connects as a SPICE client and renders the primary surface
// as the server pushes it to a new display channel (full-screen image, then
// MARK). Supported encodings: raw bitmaps and LZ (what spice-server uses
// for text consoles and simple screens); QUIC/GLZ/JPEG images are reported
// as unsupported.
func SpiceCapture(ctx context.Context, dial spiceDialer) (image.Image, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
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
	dispConn, pw2, _, err := dial(ctx)
	if err != nil {
		return nil, fmt.Errorf("display channel: %w", err)
	}
	defer dispConn.Close()
	stop2 := context.AfterFunc(ctx, func() { dispConn.Close() })
	defer stop2()
	if pw2 == "" {
		pw2 = pw
	}
	dc, _, err := spiceLinkClient(dispConn, sessionID, spiceChannelDisplay, pw2)
	if err != nil {
		return nil, fmt.Errorf("display channel: %w", err)
	}
	if err := dc.send(spiceMsgcDisplayInit, make([]byte, 14)); err != nil {
		return nil, err
	}
	var canvas *image.RGBA
	for {
		typ, p, err := dc.recv()
		if err != nil {
			if ctx.Err() != nil {
				return nil, errors.New("spice: timed out waiting for the screen")
			}
			return nil, fmt.Errorf("display channel: %w", err)
		}
		switch typ {
		case spiceMsgSurfaceNew:
			if len(p) >= 20 && binary.LittleEndian.Uint32(p[16:20])&spiceSurfacePrimary != 0 {
				w, h := int(binary.LittleEndian.Uint32(p[4:8])), int(binary.LittleEndian.Uint32(p[8:12]))
				if w <= 0 || h <= 0 || w > 8192 || h > 8192 {
					return nil, errors.New("spice: bad surface size")
				}
				canvas = image.NewRGBA(image.Rect(0, 0, w, h))
				for i := 3; i < len(canvas.Pix); i += 4 {
					canvas.Pix[i] = 0xff
				}
			}
		case spiceMsgDisplayDrawCopy:
			if canvas != nil && len(p) >= 4 && binary.LittleEndian.Uint32(p[0:4]) == 0 {
				if err := spiceDrawCopy(canvas, p); err != nil {
					return nil, err
				}
			}
		case spiceMsgDisplayDrawFill:
			if canvas != nil && len(p) >= 4 && binary.LittleEndian.Uint32(p[0:4]) == 0 {
				spiceDrawFill(canvas, p)
			}
		case spiceMsgDisplayMark:
			if canvas != nil {
				return canvas, nil
			}
		}
	}
}

type spiceRect struct{ top, left, bottom, right int }

func readRect(p []byte) spiceRect {
	return spiceRect{
		top:    int(int32(binary.LittleEndian.Uint32(p[0:]))),
		left:   int(int32(binary.LittleEndian.Uint32(p[4:]))),
		bottom: int(int32(binary.LittleEndian.Uint32(p[8:]))),
		right:  int(int32(binary.LittleEndian.Uint32(p[12:]))),
	}
}

func (r spiceRect) image() image.Rectangle { return image.Rect(r.left, r.top, r.right, r.bottom) }

// parseDisplayBase parses SpiceMsgDisplayBase (surface, box, clip) and
// returns the box, the clip rectangles (nil = none) and the offset after it.
func parseDisplayBase(p []byte) (spiceRect, []image.Rectangle, int, error) {
	if len(p) < 21 {
		return spiceRect{}, nil, 0, errors.New("spice: short draw message")
	}
	box := readRect(p[4:20])
	off := 21
	var clips []image.Rectangle
	if p[20] == spiceClipRects {
		if len(p) < off+4 {
			return box, nil, 0, errors.New("spice: short clip")
		}
		n := int(binary.LittleEndian.Uint32(p[off:]))
		off += 4
		if n > 10000 || len(p) < off+16*n {
			return box, nil, 0, errors.New("spice: bad clip")
		}
		for i := 0; i < n; i++ {
			clips = append(clips, readRect(p[off+16*i:]).image())
		}
		off += 16 * n
	}
	return box, clips, off, nil
}

func clipped(dst image.Rectangle, clips []image.Rectangle) []image.Rectangle {
	if clips == nil {
		return []image.Rectangle{dst}
	}
	var out []image.Rectangle
	for _, c := range clips {
		if r := dst.Intersect(c); !r.Empty() {
			out = append(out, r)
		}
	}
	return out
}

func spiceDrawFill(canvas *image.RGBA, p []byte) {
	box, clips, off, err := parseDisplayBase(p)
	if err != nil || len(p) < off+5 || p[off] != spiceBrushSolid {
		return
	}
	c := binary.LittleEndian.Uint32(p[off+1:])
	r, g, b := byte(c>>16), byte(c>>8), byte(c)
	for _, rect := range clipped(box.image().Intersect(canvas.Bounds()), clips) {
		for y := rect.Min.Y; y < rect.Max.Y; y++ {
			o := canvas.PixOffset(rect.Min.X, y)
			for x := rect.Min.X; x < rect.Max.X; x++ {
				canvas.Pix[o], canvas.Pix[o+1], canvas.Pix[o+2], canvas.Pix[o+3] = r, g, b, 0xff
				o += 4
			}
		}
	}
}

func spiceDrawCopy(canvas *image.RGBA, p []byte) error {
	box, clips, off, err := parseDisplayBase(p)
	if err != nil {
		return err
	}
	if len(p) < off+4+16 {
		return errors.New("spice: short draw_copy")
	}
	imgOff := int(binary.LittleEndian.Uint32(p[off:]))
	src := readRect(p[off+4:])
	if imgOff <= 0 || imgOff+18 > len(p) {
		return errors.New("spice: bad image offset")
	}
	img, err := decodeSpiceImage(p, imgOff)
	if err != nil {
		return err
	}
	dst := box.image()
	for _, rect := range clipped(dst.Intersect(canvas.Bounds()), clips) {
		for y := rect.Min.Y; y < rect.Max.Y; y++ {
			sy := src.top + (y - dst.Min.Y)
			if sy < 0 || sy >= img.Rect.Dy() {
				continue
			}
			for x := rect.Min.X; x < rect.Max.X; x++ {
				sx := src.left + (x - dst.Min.X)
				if sx < 0 || sx >= img.Rect.Dx() {
					continue
				}
				so := img.PixOffset(sx, sy)
				do := canvas.PixOffset(x, y)
				copy(canvas.Pix[do:do+4], img.Pix[so:so+4])
			}
		}
	}
	return nil
}

// decodeSpiceImage decodes the SpiceImage at offset off of a message.
func decodeSpiceImage(p []byte, off int) (*image.RGBA, error) {
	typ := p[off+8]
	w := int(binary.LittleEndian.Uint32(p[off+10:]))
	h := int(binary.LittleEndian.Uint32(p[off+14:]))
	if w <= 0 || h <= 0 || w > 8192 || h > 8192 {
		return nil, errors.New("spice: bad image size")
	}
	data := p[off+18:]
	switch typ {
	case spiceImageBitmap:
		if len(data) < 18 {
			return nil, errors.New("spice: short bitmap")
		}
		format, flags := data[0], data[1]
		bw := int(binary.LittleEndian.Uint32(data[2:]))
		bh := int(binary.LittleEndian.Uint32(data[6:]))
		stride := int(binary.LittleEndian.Uint32(data[10:]))
		px := data[18:] // after the palette pointer
		return decodeSpiceBitmap(format, flags&spiceBitmapTopDown != 0, bw, bh, stride, px)
	case spiceImageLZRGB:
		if len(data) < 4 {
			return nil, errors.New("spice: short lz image")
		}
		n := int(binary.LittleEndian.Uint32(data))
		if n > len(data)-4 {
			return nil, errors.New("spice: truncated lz image")
		}
		return decodeSpiceLZ(data[4 : 4+n])
	case spiceImageQUIC:
		return nil, errors.New("the VM's screen is sent QUIC-compressed (photo-like content), which the agent cannot decode")
	case spiceImageGLZRGB:
		return nil, errors.New("the VM's screen is sent GLZ-compressed, which the agent cannot decode")
	}
	return nil, fmt.Errorf("unsupported SPICE image type %d", typ)
}

func decodeSpiceBitmap(format byte, topDown bool, w, h, stride int, px []byte) (*image.RGBA, error) {
	bpp := 0
	switch format {
	case spiceBitmapFmt32, spiceBitmapFmtRGBA:
		bpp = 4
	case spiceBitmapFmt24:
		bpp = 3
	default:
		return nil, fmt.Errorf("unsupported SPICE bitmap format %d", format)
	}
	if w <= 0 || h <= 0 || stride < w*bpp || len(px) < stride*h {
		return nil, errors.New("spice: bad bitmap")
	}
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		sy := y
		if !topDown {
			sy = h - 1 - y
		}
		row := px[sy*stride:]
		o := img.PixOffset(0, y)
		for x := 0; x < w; x++ {
			b, g, r := row[x*bpp], row[x*bpp+1], row[x*bpp+2]
			img.Pix[o], img.Pix[o+1], img.Pix[o+2], img.Pix[o+3] = r, g, b, 0xff
			o += 4
		}
	}
	return img, nil
}

// decodeSpiceLZ decodes a SPICE LZ image (spice-common lz.c) of type
// RGB24/RGB32 (RGBA: colour only).
func decodeSpiceLZ(data []byte) (*image.RGBA, error) {
	if len(data) < 28 {
		return nil, errors.New("lz: short header")
	}
	be := binary.BigEndian
	if be.Uint32(data[0:]) != lzMagic {
		return nil, errors.New("lz: bad magic")
	}
	typ := be.Uint32(data[8:])
	w, h := int(be.Uint32(data[12:])), int(be.Uint32(data[16:]))
	topDown := be.Uint32(data[24:]) != 0
	if typ != lzTypeRGB32 && typ != lzTypeRGB24 && typ != lzTypeRGBA {
		return nil, fmt.Errorf("lz: unsupported image type %d", typ)
	}
	if w <= 0 || h <= 0 || w*h > 8192*8192 {
		return nil, errors.New("lz: bad size")
	}
	n := w * h
	pix := make([]uint32, n) // 0x00RRGGBB
	in := data[28:]
	pos := 0
	next := func() (uint32, error) {
		if pos >= len(in) {
			return 0, errors.New("lz: truncated data")
		}
		b := in[pos]
		pos++
		return uint32(b), nil
	}
	op := 0
	ctrl, err := next()
	if err != nil {
		return nil, err
	}
	for {
		if ctrl >= lzMaxCopy {
			length := ctrl>>5 - 1
			ofs := (ctrl & 31) << 8
			if length == 7-1 {
				for {
					code, err := next()
					if err != nil {
						return nil, err
					}
					length += code
					if code != 255 {
						break
					}
				}
			}
			code, err := next()
			if err != nil {
				return nil, err
			}
			ofs += code
			if ofs == lzMaxDistance {
				hi, err1 := next()
				lo, err2 := next()
				if err1 != nil || err2 != nil {
					return nil, errors.New("lz: truncated data")
				}
				ofs = hi<<8 + lo + lzMaxDistance
			}
			length++
			ofs++
			ref := op - int(ofs)
			if ref < 0 || op+int(length) > n {
				return nil, errors.New("lz: corrupt reference")
			}
			for i := 0; i < int(length); i++ {
				pix[op] = pix[ref]
				op++
				ref++
			}
		} else {
			count := int(ctrl) + 1
			if op+count > n {
				return nil, errors.New("lz: corrupt literal")
			}
			for i := 0; i < count; i++ {
				if pos+3 > len(in) {
					return nil, errors.New("lz: truncated data")
				}
				b, g, r := in[pos], in[pos+1], in[pos+2]
				pos += 3
				pix[op] = uint32(r)<<16 | uint32(g)<<8 | uint32(b)
				op++
			}
		}
		if op >= n {
			break
		}
		if ctrl, err = next(); err != nil {
			return nil, err
		}
	}
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		sy := y
		if !topDown {
			sy = h - 1 - y
		}
		o := img.PixOffset(0, y)
		for x := 0; x < w; x++ {
			v := pix[sy*w+x]
			img.Pix[o], img.Pix[o+1], img.Pix[o+2], img.Pix[o+3] = byte(v>>16), byte(v>>8), byte(v), 0xff
			o += 4
		}
	}
	return img, nil
}

// unixPeers counts established connections to the Unix socket at path
// (/proc/net/unix lists the accepted sockets with the listener's path).
func unixPeers(path string) (int, error) {
	f, err := os.Open("/proc/net/unix")
	if err != nil {
		return 0, err
	}
	defer f.Close()
	n := 0
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		fields := strings.Fields(sc.Text())
		// Num RefCount Protocol Flags Type St Inode Path
		if len(fields) >= 8 && fields[7] == path && fields[5] == "03" {
			n++
		}
	}
	return n, sc.Err()
}
