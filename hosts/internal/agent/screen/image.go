package screen

import (
	"bytes"
	"fmt"
	"image"
	"image/jpeg"
	"image/png"

	"golang.org/x/image/draw"
)

// scaleTo returns img scaled down to at most maxW pixels wide (aspect kept);
// maxW <= 0 or a narrower image returns img.
func scaleTo(img image.Image, maxW int) image.Image {
	b := img.Bounds()
	if maxW <= 0 || b.Dx() <= maxW {
		return img
	}
	h := max(b.Dy()*maxW/b.Dx(), 1)
	dst := image.NewRGBA(image.Rect(0, 0, maxW, h))
	draw.CatmullRom.Scale(dst, dst.Bounds(), img, b, draw.Src, nil)
	return dst
}

// encodeImage encodes img as "png" or "jpeg" (quality 80: text stays
// readable for the assistant).
func encodeImage(img image.Image, format string) ([]byte, error) {
	var buf bytes.Buffer
	switch format {
	case "png":
		enc := png.Encoder{CompressionLevel: png.BestSpeed}
		if err := enc.Encode(&buf, img); err != nil {
			return nil, err
		}
	case "jpeg":
		if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: 80}); err != nil {
			return nil, err
		}
	default:
		return nil, fmt.Errorf("unsupported image format %q", format)
	}
	return buf.Bytes(), nil
}

// imageFormat checks a requested format ("" is def).
func imageFormat(f, def string) (string, bool) {
	switch f {
	case "":
		return def, true
	case "png":
		return "png", true
	case "jpeg", "jpg":
		return "jpeg", true
	}
	return "", false
}
