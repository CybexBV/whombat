package screen

import (
	"strings"

	"rsc.io/qr"
)

// MaxQRModules bounds a QR code's width in modules (version 7): the graphical console draws it about 130 layout px
// wide, and a denser code is hard for a phone to read off a screen. A longer address (a long Tailscale sign-in link)
// gets no QR code; its text stays.
const MaxQRModules = 45

// QRModules is text as a QR code for the graphical console, one string per row of modules, '#' dark and '.' light,
// without a quiet zone (the page draws it as SVG and adds one). Level L: a screen doesn't get scratched, and the
// lower level keeps the modules large. nil when the text can't be encoded or would be too dense.
func QRModules(text string) []string {
	if text == "" {
		return nil
	}
	c, err := qr.Encode(text, qr.L)
	if err != nil || c.Size > MaxQRModules {
		return nil
	}
	out := make([]string, c.Size)
	for y := range c.Size {
		var b strings.Builder
		for x := range c.Size {
			if c.Black(x, y) {
				b.WriteByte('#')
			} else {
				b.WriteByte('.')
			}
		}
		out[y] = b.String()
	}
	return out
}
