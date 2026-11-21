package broker

import (
	"bufio"
	"bytes"
	"errors"
	"fmt"
	"image"
	"image/jpeg"
	"image/png"
	"io"
	"strconv"

	"golang.org/x/image/draw"
)

// MaxThumbWidth is the largest thumbnail the agent produces for "jpeg"
// requests (REMOTE-CONSOLE.md 6.8: thumbnails are at most 320 px).
const MaxThumbWidth = 320

// DecodeImage decodes PNG, JPEG or binary PPM (P6) data, the formats
// QEMU's screendump and libvirt's screenshot produce.
func DecodeImage(data []byte) (image.Image, error) {
	switch {
	case bytes.HasPrefix(data, []byte("\x89PNG")):
		return png.Decode(bytes.NewReader(data))
	case bytes.HasPrefix(data, []byte("\xff\xd8")):
		return jpeg.Decode(bytes.NewReader(data))
	case bytes.HasPrefix(data, []byte("P6")):
		return DecodePPM(bytes.NewReader(data))
	}
	return nil, errors.New("unknown image format")
}

// DecodePPM decodes a binary PPM (P6) image with maxval ≤ 65535.
func DecodePPM(r io.Reader) (image.Image, error) {
	br := bufio.NewReader(r)
	magic, err := ppmToken(br)
	if err != nil {
		return nil, err
	}
	if magic != "P6" {
		return nil, fmt.Errorf("ppm: unsupported magic %q", magic)
	}
	var vals [3]int
	for i := range vals {
		t, err := ppmToken(br)
		if err != nil {
			return nil, err
		}
		v, err := strconv.Atoi(t)
		if err != nil || v <= 0 {
			return nil, fmt.Errorf("ppm: bad header value %q", t)
		}
		vals[i] = v
	}
	w, h, maxval := vals[0], vals[1], vals[2]
	if w > 16384 || h > 16384 || maxval > 65535 {
		return nil, errors.New("ppm: image too large")
	}
	bpp := 3
	if maxval > 255 {
		bpp = 6
	}
	row := make([]byte, w*bpp)
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		if _, err := io.ReadFull(br, row); err != nil {
			return nil, fmt.Errorf("ppm: %w", err)
		}
		o := img.PixOffset(0, y)
		for x := 0; x < w; x++ {
			var r, g, b int
			if bpp == 3 {
				r, g, b = int(row[x*3]), int(row[x*3+1]), int(row[x*3+2])
			} else {
				r = int(row[x*6])<<8 | int(row[x*6+1])
				g = int(row[x*6+2])<<8 | int(row[x*6+3])
				b = int(row[x*6+4])<<8 | int(row[x*6+5])
			}
			if maxval != 255 {
				r, g, b = r*255/maxval, g*255/maxval, b*255/maxval
			}
			img.Pix[o+x*4] = uint8(r)
			img.Pix[o+x*4+1] = uint8(g)
			img.Pix[o+x*4+2] = uint8(b)
			img.Pix[o+x*4+3] = 0xff
		}
	}
	return img, nil
}

// ppmToken reads one whitespace-separated header token, skipping comments.
// After the last header token exactly one whitespace byte is consumed.
func ppmToken(br *bufio.Reader) (string, error) {
	var tok []byte
	for {
		c, err := br.ReadByte()
		if err != nil {
			return "", fmt.Errorf("ppm header: %w", err)
		}
		switch {
		case c == '#' && len(tok) == 0:
			if _, err := br.ReadString('\n'); err != nil {
				return "", fmt.Errorf("ppm header: %w", err)
			}
		case c == ' ' || c == '\t' || c == '\n' || c == '\r':
			if len(tok) > 0 {
				return string(tok), nil
			}
		default:
			if len(tok) > 16 {
				return "", errors.New("ppm header: token too long")
			}
			tok = append(tok, c)
		}
	}
}

// Scale returns img scaled down to at most maxW pixels wide (aspect ratio
// kept). maxW <= 0 or a narrower image returns img unchanged.
func Scale(img image.Image, maxW int) image.Image {
	b := img.Bounds()
	if maxW <= 0 || b.Dx() <= maxW {
		return img
	}
	h := b.Dy() * maxW / b.Dx()
	if h < 1 {
		h = 1
	}
	dst := image.NewRGBA(image.Rect(0, 0, maxW, h))
	draw.CatmullRom.Scale(dst, dst.Bounds(), img, b, draw.Src, nil)
	return dst
}

// EncodeImage encodes img as "jpeg" (quality 75) or "png".
func EncodeImage(img image.Image, format string) ([]byte, error) {
	var buf bytes.Buffer
	switch format {
	case "png":
		enc := png.Encoder{CompressionLevel: png.BestSpeed}
		if err := enc.Encode(&buf, img); err != nil {
			return nil, err
		}
	case "jpeg", "jpg", "":
		if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: 75}); err != nil {
			return nil, err
		}
	default:
		return nil, fmt.Errorf("unsupported image format %q", format)
	}
	return buf.Bytes(), nil
}

// Thumbnail decodes a raw screen capture and produces the requested format
// ("jpeg" default, or "png") scaled to at most maxW pixels wide (0 = full
// size, as in proto.ThumbnailRequest).
func Thumbnail(raw []byte, maxW int, format string) (data []byte, w, h int, err error) {
	img, err := DecodeImage(raw)
	if err != nil {
		return nil, 0, 0, err
	}
	return ThumbnailImage(img, maxW, format)
}

// ThumbnailImage is Thumbnail for an already decoded image.
func ThumbnailImage(img image.Image, maxW int, format string) (data []byte, w, h int, err error) {
	if format == "" {
		format = "jpeg"
	}
	img = Scale(img, maxW)
	data, err = EncodeImage(img, format)
	if err != nil {
		return nil, 0, 0, err
	}
	b := img.Bounds()
	return data, b.Dx(), b.Dy(), nil
}
